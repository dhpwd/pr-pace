import { spawnSync } from "node:child_process";

/**
 * @typedef {{ ok: boolean, stdout: string, stderr: string }} GitResult
 */

/**
 * Runs git in `cwd`. Never throws for a non-zero exit – callers decide what a
 * failure means for their repo.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ input?: string }} [options]
 * @returns {GitResult}
 */
export function git(cwd, args, options = {}) {
  const result = spawnSync(
    "git",
    ["-c", "log.showSignature=false", "-c", "color.ui=never", ...args],
    {
      cwd,
      input: options.input,
      encoding: "utf8",
      maxBuffer: Infinity,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  if (result.error) {
    if (/** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
      throw new Error("git not found on PATH – install git and try again");
    }
    throw result.error;
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr.trim(),
  };
}
