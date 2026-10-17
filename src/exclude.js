const DOC_EXTENSIONS = [".md", ".mdx", ".markdown", ".rst", ".adoc", ".txt"];

const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
]);

const BUILD_SUFFIXES = [".min.js", ".min.css", ".map"];

const BUILD_DIRS = new Set(["dist", "build", "vendor", "node_modules"]);

/** The .gitattributes attributes that exclude a file from lines changed. */
export const LINGUIST_ATTRIBUTES = [
  "linguist-generated",
  "linguist-vendored",
  "linguist-documentation",
];

/**
 * Compiles a glob to a RegExp over a whole path or segment. Supports `*`
 * (within a segment), `**` (across segments) and `?`. Everything else is
 * literal. Written by hand for the Node 20 floor – see "Implementation
 * constraints" in docs/specs/v1.md.
 * @param {string} glob
 */
function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * As in .gitignore: a glob without a slash matches any file or folder name at
 * any depth, so `fixtures` drops everything under any `fixtures/`. A leading
 * or inner slash anchors it at the repo root, where it matches a path or any
 * folder above it. A trailing slash alone doesn't anchor.
 * @param {string} glob
 * @returns {(path: string) => boolean}
 */
export function globMatcher(glob) {
  const withoutTrailing = glob.replace(/\/+$/, "");
  const anchored = withoutTrailing.includes("/");
  const regexp = globToRegExp(withoutTrailing.replace(/^\/+/, ""));
  if (!anchored) {
    return (path) => path.split("/").some((segment) => regexp.test(segment));
  }
  return (path) => {
    const segments = path.split("/");
    for (let i = 1; i <= segments.length; i++) {
      if (regexp.test(segments.slice(0, i).join("/"))) return true;
    }
    return false;
  };
}

/**
 * Builds the path test for the default exclusions plus any `--exclude` globs.
 * Linguist attributes are checked separately, from git.
 * @param {{ includeDocs: boolean, globs: string[] }} options
 * @returns {(path: string) => boolean}
 */
export function pathExcluder({ includeDocs, globs }) {
  const matchers = globs.map(globMatcher);
  return (path) => {
    const segments = path.split("/");
    const name = segments[segments.length - 1];
    const lower = name.toLowerCase();
    if (!includeDocs && DOC_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      return true;
    }
    if (LOCKFILES.has(name)) return true;
    if (BUILD_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
    if (segments.slice(0, -1).some((segment) => BUILD_DIRS.has(segment))) {
      return true;
    }
    return matchers.some((matches) => matches(path));
  };
}
