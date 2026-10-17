import { spawnSync } from "node:child_process";

/**
 * @typedef {{ ok: boolean, stdout: string, error: string }} GitResult `error` is stderr's first line, for warnings
 */

// The variables that tie git to one repo, as listed by `git rev-parse
// --local-env-vars`. Hooks in a linked worktree get absolute GIT_DIR and
// GIT_INDEX_FILE, and tools such as vcsh set GIT_DIR. Left in place, they
// make every scanned path read that one repo.
const REPO_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

/** The environment for a git process that finds its repo from its cwd. */
export function repoFreeEnv() {
  const env = { ...process.env };
  for (const name of REPO_ENV) delete env[name];
  return env;
}

/**
 * Runs git in `cwd`. Never throws for a non-zero exit – callers decide what a
 * failure means for their repo.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ input?: string }} [options]
 * @returns {GitResult}
 */
export function git(cwd, args, options = {}) {
  /** @type {import('node:child_process').SpawnSyncReturns<string>} */
  let result;
  try {
    result = spawnSync(
      "git",
      ["-c", "log.showSignature=false", "-c", "color.ui=never", ...args],
      {
        cwd,
        input: options.input,
        encoding: "utf8",
        maxBuffer: Infinity,
        env: { ...repoFreeEnv(), GIT_TERMINAL_PROMPT: "0" },
      },
    );
  } catch (error) {
    // Output past V8's longest string (about 512M characters) throws here.
    return {
      ok: false,
      stdout: "",
      error: `output too large to read (${/** @type {Error} */ (error).message})`,
    };
  }
  if (result.error) {
    if (/** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
      throw new Error("git not found on PATH – install git and try again");
    }
    throw result.error;
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    error: result.stderr.trim().split("\n")[0],
  };
}
