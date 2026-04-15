import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempRepoRoot } from "./helpers/temp-repo.js";

const baseGitEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const baseRunEnv: NodeJS.ProcessEnv = { ...process.env, ...baseGitEnv };
const realGitPath = execFileSync("bash", ["-lc", "command -v git"], {
  encoding: "utf8",
}).trim();
const tempDirs: string[] = [];

const run = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) => {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...baseRunEnv, ...env } : baseRunEnv,
  }).trim();
};

const runResult = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) => {
  return spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...baseRunEnv, ...env } : baseRunEnv,
  });
};

function writeExecutable(dir: string, name: string, contents: string): void {
  writeFileSync(path.join(dir, name), contents, {
    encoding: "utf8",
    mode: 0o755,
  });
}

function installPreCommitFixture(
  dir: string,
  options: {
    useRealRunNodeTool?: boolean;
    useRealFilter?: boolean;
    stubNode?: boolean;
  } = {},
): string {
  mkdirSync(path.join(dir, "git-hooks"), { recursive: true });
  mkdirSync(path.join(dir, "scripts", "pre-commit"), { recursive: true });
  symlinkSync(
    path.join(process.cwd(), "git-hooks", "pre-commit"),
    path.join(dir, "git-hooks", "pre-commit"),
  );
  if (options.useRealRunNodeTool) {
    symlinkSync(
      path.join(process.cwd(), "scripts", "pre-commit", "run-node-tool.sh"),
      path.join(dir, "scripts", "pre-commit", "run-node-tool.sh"),
    );
  } else {
    writeFileSync(
      path.join(dir, "scripts", "pre-commit", "run-node-tool.sh"),
      "#!/usr/bin/env bash\nexit 0\n",
      {
        encoding: "utf8",
        mode: 0o755,
      },
    );
  }
  if (options.useRealFilter) {
    symlinkSync(
      path.join(process.cwd(), "scripts", "pre-commit", "filter-staged-files.mjs"),
      path.join(dir, "scripts", "pre-commit", "filter-staged-files.mjs"),
    );
  } else {
    writeFileSync(
      path.join(dir, "scripts", "pre-commit", "filter-staged-files.mjs"),
      "process.exit(0);\n",
      "utf8",
    );
  }

  const fakeBinDir = path.join(dir, "bin");
  mkdirSync(fakeBinDir, { recursive: true });
  if (options.stubNode !== false) {
    writeExecutable(fakeBinDir, "node", "#!/usr/bin/env bash\nexit 0\n");
  }
  return fakeBinDir;
}

function installGitCommonDirWrapper(
  fakeBinDir: string,
  worktreeRoot: string,
  canonicalRoot: string,
): void {
  writeExecutable(
    fakeBinDir,
    "git",
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -eq 5 ]] && [[ "$1" == "-C" ]] && [[ "$2" == "${worktreeRoot}" ]] && [[ "$3" == "rev-parse" ]] && [[ "$4" == "--path-format=absolute" ]] && [[ "$5" == "--git-common-dir" ]]; then
  printf '%s\\n' "${canonicalRoot}/.git"
  exit 0
fi
exec "${realGitPath}" "$@"
`,
  );
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("git-hooks/pre-commit (integration)", () => {
  it("does not treat staged filenames as git-add flags (e.g. --all)", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    // Use the real hook script and lightweight helper stubs.
    const fakeBinDir = installPreCommitFixture(dir);
    // The hook ends with `pnpm check`, but this fixture is only exercising staged-file handling.
    // Stub pnpm too so Windows CI does not invoke a real package-manager command in the temp repo.
    writeExecutable(fakeBinDir, "pnpm", "#!/usr/bin/env bash\nexit 0\n");

    // Create an untracked file that should NOT be staged by the hook.
    writeFileSync(path.join(dir, "secret.txt"), "do-not-stage\n", "utf8");

    // Stage a maliciously-named file. Older hooks using `xargs git add` could run `git add --all`.
    writeFileSync(path.join(dir, "--all"), "flag\n", "utf8");
    run(dir, "git", ["add", "--", "--all"]);

    // Run the hook directly (same logic as when installed via core.hooksPath).
    run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });

    const staged = run(dir, "git", ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
    expect(staged).toEqual(["--all"]);
  });

  it("skips pnpm check when FAST_COMMIT is enabled", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-yolo-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    const fakeBinDir = installPreCommitFixture(dir);
    writeFileSync(path.join(dir, "package.json"), '{"name":"tmp"}\n', "utf8");
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    writeExecutable(
      fakeBinDir,
      "pnpm",
      "#!/usr/bin/env bash\necho 'pnpm should not run when FAST_COMMIT is enabled' >&2\nexit 99\n",
    );

    writeFileSync(path.join(dir, "tracked.txt"), "hello\n", "utf8");
    run(dir, "git", ["add", "--", "tracked.txt"]);

    const output = run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      FAST_COMMIT: "1",
    });

    expect(output).toContain("FAST_COMMIT enabled: skipping pnpm check in pre-commit hook.");
  });

  it("uses the canonical checkout toolchain when a linked worktree has no node_modules", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-linked-");
    const canonicalRoot = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-canonical-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    const fakeBinDir = installPreCommitFixture(dir, {
      useRealRunNodeTool: true,
      useRealFilter: true,
      stubNode: false,
    });
    installGitCommonDirWrapper(fakeBinDir, dir, canonicalRoot);

    mkdirSync(path.join(canonicalRoot, ".git"), { recursive: true });
    mkdirSync(path.join(canonicalRoot, "node_modules", ".bin"), { recursive: true });
    writeExecutable(
      path.join(canonicalRoot, "node_modules", ".bin"),
      "oxfmt",
      `#!/usr/bin/env bash
set -euo pipefail
printf 'resolved-tool=%s\\n' "$0"
printf 'cwd=%s\\n' "$PWD"
`,
    );

    writeFileSync(path.join(dir, "package.json"), '{"name":"tmp"}\n', "utf8");
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeFileSync(path.join(dir, "README.md"), "hello\n", "utf8");
    run(dir, "git", ["add", "--", "README.md"]);

    const output = run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });

    expect(output).toContain(
      `resolved-tool=${path.join(canonicalRoot, "node_modules", ".bin", "oxfmt")}`,
    );
    expect(output).toContain(`cwd=${dir}`);
    expect(output).toContain(
      "Docs-only staged changes detected: skipping pnpm check in pre-commit hook.",
    );
  });

  it("fails with a clear error when no linked-worktree toolchain is installed", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-linked-missing-");
    const canonicalRoot = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-canonical-missing-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    const fakeBinDir = installPreCommitFixture(dir, {
      useRealRunNodeTool: true,
      useRealFilter: true,
      stubNode: false,
    });
    installGitCommonDirWrapper(fakeBinDir, dir, canonicalRoot);

    mkdirSync(path.join(canonicalRoot, ".git"), { recursive: true });
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeFileSync(path.join(dir, "README.md"), "hello\n", "utf8");
    run(dir, "git", ["add", "--", "README.md"]);

    const result = runResult(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not find installed tool 'oxfmt'.");
    expect(result.stderr).toContain(`Searched: ${path.join(dir, "node_modules", ".bin", "oxfmt")}`);
    expect(result.stderr).toContain(
      `Searched: ${path.join(canonicalRoot, "node_modules", ".bin", "oxfmt")}`,
    );
  });
});
