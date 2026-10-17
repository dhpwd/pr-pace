import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** @param {string} dir */
function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Finds the repos under each path: the path itself if it holds `.git` (a
 * folder, or a file for worktrees and submodules), otherwise its subfolders
 * down to `depth`, skipping `node_modules` and dot-folders.
 * @param {string[]} paths
 * @param {number} depth
 * @returns {string[]} absolute repo paths, in a stable order
 */
export function findRepos(paths, depth) {
  /** @type {string[]} */
  const found = [];
  /**
   * @param {string} dir
   * @param {number} levelsLeft
   */
  const walk = (dir, levelsLeft) => {
    if (existsSync(join(dir, ".git"))) {
      found.push(dir);
      return;
    }
    if (levelsLeft === 0) return;
    /** @type {string[]} */
    let entries;
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const child = join(dir, entry);
      if (isDirectory(child)) walk(child, levelsLeft - 1);
    }
  };
  for (const path of paths) {
    const dir = resolve(path);
    if (!isDirectory(dir)) {
      throw new Error(
        `${path} is not a folder – pass a repo or a folder of repos`,
      );
    }
    walk(dir, depth);
  }
  return [...new Set(found)];
}

/**
 * Display names: each repo's folder name, with the parent folder added where
 * two repos share a name.
 * @param {string[]} repoPaths
 */
export function repoNames(repoPaths) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const path of repoPaths) {
    counts.set(basename(path), (counts.get(basename(path)) ?? 0) + 1);
  }
  return repoPaths.map((path) =>
    (counts.get(basename(path)) ?? 0) > 1
      ? `${basename(dirname(path))}/${basename(path)}`
      : basename(path),
  );
}
