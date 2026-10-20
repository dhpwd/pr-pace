const DOC_EXTENSIONS = [
  ".md",
  ".mdx",
  ".markdown",
  ".rst",
  ".adoc",
  ".asciidoc",
  ".rdoc",
  ".textile",
  ".pod",
  ".txt",
];

/**
 * Lower-cased docs file names. The names left off, such as `install` and
 * `citation`, are under "Lines changed" in docs/specs/v1.md.
 */
const DOC_NAMES = new Set([
  "license",
  "licence",
  "unlicense",
  "unlicence",
  "copying",
  "copyright",
  "patents",
  "notice",
  "authors",
  "copying.lesser",
  "copying.lib",
  "mit-license",
  "readme",
  "changelog",
  "changes",
  "contributing",
  "news",
  "thanks",
  "todo",
]);

const LICENCE_WITH_SUFFIX = /^(?:licen[cs]e|copying|copyright)[-_][^.]*$/;

const CONFIG_TXT_NAMES = new Set(["cmakelists.txt", "robots.txt"]);

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
  "npm-shrinkwrap.json",
  "deno.lock",
  "Pipfile.lock",
  "pdm.lock",
  "pixi.lock",
  "Package.resolved",
  "flake.lock",
  "MODULE.bazel.lock",
  ".terraform.lock.hcl",
  "mise.lock",
  "Manifest.toml",
  "JuliaManifest.toml",
  "Gopkg.lock",
  "glide.lock",
  "pubspec.lock",
  "mix.lock",
  "Podfile.lock",
  "gradle.lockfile",
  "buildscript-gradle.lockfile",
  "packages.lock.json",
  "go.work.sum",
  "pylock.toml",
  "Cartfile.resolved",
  "shard.lock",
  "rebar.lock",
  "stack.yaml.lock",
  "renv.lock",
  "conan.lock",
  "paket.lock",
  "settings-gradle.lockfile",
  "Chart.lock",
  "packages-lock.json",
  "cpanfile.snapshot",
  "cabal.project.freeze",
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
 * literal. Written by hand because `path.matchesGlob` is missing or
 * experimental on early Node 22 releases, and because it applies minimatch
 * syntax rather than the `--exclude` syntax the spec defines – see
 * "Implementation constraints" in docs/specs/v1.md.
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
 * folder above it. A trailing slash matches folders only, so `build/` skips a
 * file named `build`. On its own, a trailing slash doesn't anchor.
 * @param {string} glob
 * @returns {(path: string) => boolean}
 */
export function globMatcher(glob) {
  const foldersOnly = glob.endsWith("/");
  const withoutTrailing = glob.replace(/\/+$/, "");
  const anchored = withoutTrailing.includes("/");
  const regexp = globToRegExp(withoutTrailing.replace(/^\/+/, ""));
  /** @param {string} path */
  const testedSegments = (path) => {
    const segments = path.split("/");
    return foldersOnly ? segments.slice(0, -1) : segments;
  };
  if (!anchored) {
    return (path) =>
      testedSegments(path).some((segment) => regexp.test(segment));
  }
  return (path) => {
    const segments = testedSegments(path);
    for (let i = 1; i <= segments.length; i++) {
      if (regexp.test(segments.slice(0, i).join("/"))) return true;
    }
    return false;
  };
}

/**
 * Whether a `.txt` file is config rather than docs, so the docs exclusion
 * skips it – the rule is under "Lines changed" in docs/specs/v1.md.
 * @param {string[]} segments
 */
function isConfigTxt(segments) {
  const name = segments[segments.length - 1].toLowerCase();
  if (!name.endsWith(".txt")) return false;
  return (
    CONFIG_TXT_NAMES.has(name) ||
    name.includes("requirements") ||
    name.includes("constraints") ||
    segments
      .slice(0, -1)
      .some((segment) => segment.toLowerCase() === "requirements")
  );
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
    if (!includeDocs) {
      if (DOC_NAMES.has(lower) || LICENCE_WITH_SUFFIX.test(lower)) return true;
      if (
        DOC_EXTENSIONS.some((ext) => lower.endsWith(ext)) &&
        !isConfigTxt(segments)
      ) {
        return true;
      }
    }
    if (LOCKFILES.has(name)) return true;
    if (BUILD_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
    if (segments.slice(0, -1).some((segment) => BUILD_DIRS.has(segment))) {
      return true;
    }
    return matchers.some((matches) => matches(path));
  };
}
