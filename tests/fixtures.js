import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Fixture repos must not inherit this machine's git config (template hooks,
// a real identity), and nor must the scanner's own git calls under test.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

/** @typedef {{ name: string, email: string }} Identity */

/** @type {Identity} */
export const DEV = { name: "Dev One", email: "dev@example.com" };
/** @type {Identity} */
export const OTHER = { name: "Other Person", email: "other@example.com" };
/** @type {Identity} */
export const MERGER = { name: "Merge Clicker", email: "merger@example.com" };
/** @type {Identity} */
const COMMITTER = { name: "Fixture Committer", email: "committer@example.com" };

/** The scan's notional run time: Sat 17 Oct 2026, 20:00 UTC. */
export const NOW = Date.UTC(2026, 9, 17, 20);

/** @param {string} prefix */
export function tempDir(prefix = "pr-velocity-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** @param {string} dir */
export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Scan options with test defaults: UTC, no filters, a fixed run time.
 * @param {string[]} paths
 * @param {Partial<import('../src/scan.js').ScanOptions>} [overrides]
 * @returns {import('../src/scan.js').ScanOptions}
 */
export function scanOptions(paths, overrides = {}) {
  return {
    paths,
    depth: 1,
    fetch: false,
    branch: null,
    authors: [],
    allAuthors: false,
    since: null,
    until: null,
    sinceMs: null,
    untilMs: null,
    includeDocs: false,
    exclude: [],
    timeZone: "UTC",
    now: NOW,
    ...overrides,
  };
}

/**
 * A throwaway repo on `main`, whose local git config email is `email`.
 * Commit times start at Mon 5 Jan 2026 and step forward a day per commit
 * unless a commit names its own date.
 */
export class Repo {
  /**
   * @param {string} dir
   * @param {{ email?: string }} [options]
   */
  constructor(dir, { email = DEV.email } = {}) {
    /** @type {string} */
    this.dir = dir;
    /** @type {number} */
    this.clock = Date.UTC(2026, 0, 5, 10);
    mkdirSync(dir, { recursive: true });
    this.git("init", "-q", "-b", "main");
    this.git("config", "user.email", email);
    this.git("config", "user.name", "Local User");
  }

  /**
   * Runs git with explicit identities and dates.
   * @param {...string} args
   */
  git(...args) {
    return this.gitAs(DEV, new Date(this.clock).toISOString(), ...args);
  }

  /**
   * @param {Identity} author
   * @param {string} date
   * @param {...string} args
   * @returns {string}
   */
  gitAs(author, date, ...args) {
    return execFileSync("git", args, {
      cwd: this.dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: COMMITTER.name,
        GIT_COMMITTER_EMAIL: COMMITTER.email,
        GIT_COMMITTER_DATE: date,
      },
    }).trim();
  }

  /** @param {Record<string, string | Buffer | null>} files null deletes */
  write(files) {
    for (const [path, content] of Object.entries(files)) {
      const full = join(this.dir, path);
      if (content === null) {
        rmSync(full, { force: true });
      } else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
  }

  /** @param {string | undefined} date */
  tick(date) {
    if (date) {
      this.clock = Date.parse(date);
    } else {
      this.clock += 86400000;
    }
    return new Date(this.clock).toISOString();
  }

  /**
   * Commits on the current branch.
   * @param {string} message
   * @param {{ files?: Record<string, string | Buffer | null>, author?: Identity, date?: string }} [options]
   */
  commit(message, { files = {}, author = DEV, date } = {}) {
    this.write(files);
    const when = this.tick(date);
    this.gitAs(author, when, "add", "-A");
    this.gitAs(author, when, "commit", "-q", "--allow-empty", "-m", message);
    return this.rev("HEAD");
  }

  /**
   * Lands a squash-merged PR on main.
   * @param {number} number
   * @param {string} title
   * @param {{ files?: Record<string, string | Buffer | null>, author?: Identity, date?: string, body?: string }} [options]
   */
  squash(number, title, options = {}) {
    const message = `${title} (#${number})${options.body ? `\n\n${options.body}` : ""}`;
    return this.commit(message, options);
  }

  /**
   * Lands a PR with a merge commit: branch commits by `author`, merged by
   * MERGER with `message` (GitHub's "Merge pull request" by default).
   * @param {number} number
   * @param {string} title
   * @param {{ commits: { message: string, files?: Record<string, string | Buffer | null> }[], author?: Identity, message?: string, date?: string }} options
   */
  mergePR(number, title, { commits, author = DEV, message, date }) {
    const branch = `feature-${number}`;
    this.git("checkout", "-q", "-b", branch);
    for (const commit of commits) {
      this.commit(commit.message, { files: commit.files, author });
    }
    this.git("checkout", "-q", "main");
    const when = this.tick(date);
    this.gitAs(
      MERGER,
      when,
      "merge",
      "-q",
      "--no-ff",
      "-m",
      message ??
        `Merge pull request #${number} from someone/${branch}\n\n${title}`,
      branch,
    );
    return this.rev("HEAD");
  }

  /** @param {string} ref */
  rev(ref) {
    return this.git("rev-parse", ref);
  }

  /**
   * Points origin/<branch> at `ref` and, optionally, origin/HEAD at it, as a
   * clone would have them.
   * @param {{ branch?: string, ref?: string, head?: boolean }} [options]
   */
  setOrigin({ branch = "main", ref = "HEAD", head = true } = {}) {
    this.git("update-ref", `refs/remotes/origin/${branch}`, this.rev(ref));
    if (head) {
      this.git(
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        `refs/remotes/origin/${branch}`,
      );
    }
  }
}
