const quietPeriodMs = 4000;
const pollIntervalMs = 1000;

async function git(args: string[], allowedExitCodes = [0]) {
  const process = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  if (!allowedExitCodes.includes(exitCode)) {
    throw new Error(stderr.trim() || `git ${args.join(" ")} failed`);
  }

  return { stdout: stdout.trimEnd(), exitCode };
}

async function getStatus() {
  return (await git(["status", "--porcelain", "--untracked-files=all"])).stdout;
}

function humanize(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .toLowerCase();
}

function getScope(paths: string[]) {
  const joined = paths.join(" ").toLowerCase();
  const knownScopes = [
    ["api", "api"],
    ["application", "application"],
    ["domain", "domain"],
    ["infrastructure", "infrastructure"],
    ["test", "tests"],
  ];
  for (const [needle, scope] of knownScopes) {
    if (joined.includes(needle)) return scope;
  }

  const parts = paths[0]?.split(/[\\/]/).filter(Boolean) ?? [];
  return parts.length > 1 ? humanize(parts[0]) : "project";
}

async function createCommitMessage() {
  const entries = (await git(["diff", "--cached", "--name-status"])).stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...pathParts] = line.split("\t");
      return { status: status[0], path: pathParts.at(-1) ?? "" };
    });
  const paths = entries.map(({ path }) => path);
  const allDocs = paths.length > 0 && paths.every((path) => /(^|\/)(docs?|readme)(\/|\.|$)/i.test(path));
  const allTests = paths.length > 0 && paths.every((path) => /(^|\/)(tests?|specs?)(\/|\.|$)|\.(test|spec)\./i.test(path));
  const diff = (await git(["diff", "--cached", "--unified=0"])).stdout;
  const changedCode = diff
    .split("\n")
    .filter((line) => /^[+-](?![+-])/.test(line))
    .join(" ");
  const allAddedSource = entries.length > 0 && entries.every(({ status, path }) =>
    status === "A" && /\.(cs|ts|tsx|js|jsx|py|go|rs|java)$/i.test(path),
  );
  const isWorkflow = paths.every((path) => path.startsWith(".github/workflows/"));
  const isBuildConfig = paths.every((path) => /(^|\/)([^/]+\.(csproj|sln|json|ya?ml|toml)|package-lock\.json|bun\.lockb?)$/i.test(path));
  const looksLikeFix = /\b(fix|bug|handle|guard|validate|validation|exception|null|error)\b/i.test(changedCode);
  const type = allDocs
    ? "docs"
    : allTests
      ? "test"
      : isWorkflow
        ? "ci"
        : isBuildConfig
          ? "build"
          : looksLikeFix
            ? "fix"
            : allAddedSource
              ? "feat"
              : "chore";

  const summaries = new Map<string, string[]>();
  for (const { status, path } of entries) {
    const file = path.split(/[\\/]/).at(-1) ?? path;
    const name = humanize(file.replace(/\.[^.]+$/, ""));
    const action = status === "A" ? "add" : status === "D" ? "remove" : "update";
    const group = summaries.get(action) ?? [];
    if (!group.includes(name)) group.push(name);
    summaries.set(action, group);
  }

  const describe = ([action, names]: [string, string[]]) => {
    const selected = names.slice(0, 3).join(", ");
    const remainder = names.length > 3 ? ` and ${names.length - 3} more` : "";
    return `${action} ${selected}${remainder}`;
  };
  const summary = [...summaries.entries()].map(describe).join("; ") || "update project files";
  const scope = getScope(paths);
  return `${type}(${scope}): ${summary}`;
}

console.log("Watching for changes. Commits are created automatically; push remains manual.");

let lastStatus = await getStatus();
let lastChangeAt = lastStatus ? Date.now() : 0;
if (lastStatus) console.log("Existing changes detected; waiting for the quiet period before committing.");

while (true) {
  await Bun.sleep(pollIntervalMs);

  try {
    const status = await getStatus();
    if (status !== lastStatus) {
      lastStatus = status;
      lastChangeAt = status ? Date.now() : 0;
      if (status) console.log("Changes detected; waiting for edits to settle...");
    }

    if (!status || !lastChangeAt || Date.now() - lastChangeAt < quietPeriodMs) continue;

    await git(["add", "-A"]);
    const staged = await git(["diff", "--cached", "--quiet"], [0, 1]);
    if (staged.exitCode === 0) {
      lastChangeAt = 0;
      continue;
    }

    const message = await createCommitMessage();
    await git(["commit", "-m", message]);
    console.log(`Committed: ${message}. Push manually when you're ready.`);
    lastStatus = await getStatus();
    lastChangeAt = lastStatus ? Date.now() : 0;
  } catch (error) {
    console.error(`Commit watcher: ${error instanceof Error ? error.message : error}`);
    lastChangeAt = Date.now();
  }
}
