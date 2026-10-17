import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

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
    const before = found.length;
    walk(dir, depth);
    if (found.length === before) {
      throw new Error(
        `no git repos found in ${path} (searched ${depth} folder level${depth === 1 ? "" : "s"} down) – pass a repo, or raise --depth`,
      );
    }
  }
  return [...new Set(found)];
}

/**
 * Display names: each repo's folder name, with parent folders added until
 * repos that share a name can be told apart.
 * @param {string[]} repoPaths
 */
export function repoNames(repoPaths) {
  const segments = repoPaths.map((path) => path.split(sep).filter(Boolean));
  const depths = repoPaths.map(() => 1);
  const nameOf = (/** @type {number} */ i) =>
    segments[i].slice(-depths[i]).join("/");
  for (;;) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    segments.forEach((_, i) => {
      counts.set(nameOf(i), (counts.get(nameOf(i)) ?? 0) + 1);
    });
    const clashing = segments
      .map((_, i) => i)
      .filter(
        (i) =>
          (counts.get(nameOf(i)) ?? 0) > 1 && depths[i] < segments[i].length,
      );
    if (clashing.length === 0) return segments.map((_, i) => nameOf(i));
    for (const i of clashing) depths[i]++;
  }
}
