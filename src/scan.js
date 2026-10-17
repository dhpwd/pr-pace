import { LINGUIST_ATTRIBUTES, pathExcluder } from "./exclude.js";
import { git } from "./git.js";
import { findRepos, repoNames } from "./repos.js";
import { formatInstant, zoneFormatter } from "./time.js";

/**
 * @typedef {object} ScanOptions
 * @property {string[]} paths
 * @property {number} depth
 * @property {boolean} fetch
 * @property {string | null} branch
 * @property {string[]} authors `--author` values
 * @property {boolean} allAuthors
 * @property {string | null} since as given, for the JSON
 * @property {string | null} until as given, for the JSON
 * @property {number | null} sinceMs inclusive
 * @property {number | null} untilMs exclusive
 * @property {boolean} includeDocs
 * @property {string[]} exclude
 * @property {string} timeZone
 * @property {number} [now]
 *
 * @typedef {object} RepoResult
 * @property {string} name
 * @property {string} path
 * @property {string | null} branch
 * @property {number} prs
 * @property {number} direct_commits_ignored
 * @property {string[]} warnings
 *
 * @typedef {object} PrResult
 * @property {string} repo
 * @property {string} sha
 * @property {number} number
 * @property {string} title
 * @property {'squash' | 'merge'} method
 * @property {string} author_name
 * @property {string} author_email
 * @property {string} merged_at
 * @property {number} added
 * @property {number} removed
 * @property {number} lines
 * @property {number} excluded_lines
 * @property {number} score
 * @property {boolean} is_revert
 * @property {string | null} reverted_by
 *
 * @typedef {object} ScanResult
 * @property {string} generated_at
 * @property {{ authors: string[], all_authors: boolean, include_docs: boolean, since: string | null, until: string | null, timezone: string }} options
 * @property {RepoResult[]} repos
 * @property {PrResult[]} prs
 *
 * @typedef {{ path: string, added: number, removed: number }} FileChange
 *
 * @typedef {object} Commit
 * @property {string} sha
 * @property {string[]} parents
 * @property {string} authorName
 * @property {string} authorEmail
 * @property {number} time epoch ms
 * @property {string} subject
 * @property {string} body
 * @property {string} message
 * @property {FileChange[]} files
 *
 * @typedef {Commit & { method: 'squash' | 'merge', number: number, title: string, isRevert: boolean, revertedBy: string | null }} Pr
 */

const FIELD = "\x1f";
const RECORD = "\x1e";
const LOG_FORMAT = "%x1e%H%x1f%P%x1f%aN%x1f%aE%x1f%ct%x1f%B%x1f";
const LOG_FIELDS = 6;

const BRANCH_CANDIDATES = [
  "refs/remotes/origin/HEAD",
  "refs/remotes/origin/main",
  "refs/remotes/origin/master",
  "refs/heads/main",
  "refs/heads/master",
];

const GITHUB_MERGE = /^Merge pull request #(\d+) from /;
const GITLAB_MERGE = /See merge request \S*!(\d+)/;
const PR_SUFFIX = /\(#(\d+)\)\s*$/;
const REVERTS_COMMIT = /This reverts commit ([0-9a-fA-F]{7,64})/g;
const REVERT_PREFIX = 'Revert "';
const REVERT_QUOTE = /^Revert "(.*)"/s;

/** @param {string} text */
function stripPrSuffix(text) {
  return text.replace(/(?:\s*\(#\d+\))+\s*$/, "");
}

/**
 * Git's subject is the first paragraph of the message, unwrapped.
 * @param {string} message
 */
function splitMessage(message) {
  const text = message.replace(/\r\n/g, "\n").trim();
  const blank = text.search(/\n[ \t]*\n/);
  const first = blank === -1 ? text : text.slice(0, blank);
  return {
    subject: first.replace(/\s*\n\s*/g, " ").trim(),
    body: blank === -1 ? "" : text.slice(blank).trim(),
  };
}

/**
 * Parses `git log -z --numstat` output in LOG_FORMAT. Binary files are dropped.
 * @param {string} stdout
 * @returns {Commit[]}
 */
function parseLog(stdout) {
  /** @type {Commit[]} */
  const commits = [];
  for (const record of stdout.split(RECORD).slice(1)) {
    /** @type {string[]} */
    const fields = [];
    let start = 0;
    for (let i = 0; i < LOG_FIELDS; i++) {
      const end = record.indexOf(FIELD, start);
      fields.push(record.slice(start, end));
      start = end + 1;
    }
    const [sha, parents, authorName, authorEmail, time, message] = fields;
    const tokens = record.slice(start).split("\0");
    /** @type {FileChange[]} */
    const files = [];
    for (let i = 0; i < tokens.length; i++) {
      const match = /^\n?(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i]);
      if (!match) continue;
      let path = match[3];
      if (path === "") {
        // A rename: the old and new paths follow as their own tokens.
        path = tokens[i + 2];
        i += 2;
      }
      if (match[1] === "-" || match[2] === "-") continue;
      files.push({ path, added: Number(match[1]), removed: Number(match[2]) });
    }
    commits.push({
      sha,
      parents: parents.split(" ").filter(Boolean),
      authorName,
      authorEmail,
      time: Number(time) * 1000,
      ...splitMessage(message),
      message,
      files,
    });
  }
  return commits;
}

/**
 * Applies the PR detection table to one first-parent commit.
 * @param {Commit} commit
 * @returns {{ method: 'squash' | 'merge', number: number, title: string } | null}
 */
function classify(commit) {
  const suffix = PR_SUFFIX.exec(commit.subject)?.[1];
  if (commit.parents.length >= 2) {
    const github = GITHUB_MERGE.exec(commit.subject)?.[1];
    if (github) {
      const titleLine = commit.body
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line !== "");
      return {
        method: "merge",
        number: Number(github),
        title: stripPrSuffix(titleLine ?? commit.subject),
      };
    }
    const number = GITLAB_MERGE.exec(commit.message)?.[1] ?? suffix;
    return number
      ? {
          method: "merge",
          number: Number(number),
          title: stripPrSuffix(commit.subject),
        }
      : null;
  }
  return commit.parents.length === 1 && suffix
    ? {
        method: "squash",
        number: Number(suffix),
        title: stripPrSuffix(commit.subject),
      }
    : null;
}

/**
 * Marks revert PRs and links each to the PR it reverts. Runs over a repo's
 * whole first-parent history, oldest first, before any author or date filter.
 * @param {Pr[]} prs oldest first
 */
function linkReverts(prs) {
  /** @type {Map<string, Pr>} */
  const bySha = new Map();
  /** @type {Map<string, Pr>} */
  const byTitle = new Map();
  for (const pr of prs) {
    /** @type {Pr | undefined} */
    let original;
    for (const [, sha] of pr.message.matchAll(REVERTS_COMMIT)) {
      const wanted = sha.toLowerCase();
      original = bySha.get(wanted);
      if (!original) {
        for (const earlier of bySha.values()) {
          if (earlier.sha.startsWith(wanted)) {
            original = earlier;
            break;
          }
        }
      }
      if (original) break;
    }
    const quoted = REVERT_QUOTE.exec(pr.title)?.[1];
    if (!original && quoted !== undefined) {
      original = byTitle.get(stripPrSuffix(quoted));
    }
    pr.isRevert = original !== undefined || pr.title.startsWith(REVERT_PREFIX);
    if (original && original.revertedBy === null) original.revertedBy = pr.sha;
    bySha.set(pr.sha, pr);
    byTitle.set(stripPrSuffix(pr.subject), pr);
    byTitle.set(pr.title, pr);
  }
}

/** @param {string} ref */
function shortRef(ref) {
  return ref.replace(/^refs\/(remotes|heads)\//, "");
}

/**
 * @param {string} repoPath
 * @param {string | null} override
 * @returns {{ ref: string, name: string } | { error: string }}
 */
function resolveBranch(repoPath, override) {
  if (override) {
    const found = git(repoPath, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${override}^{commit}`,
    ]);
    return found.ok
      ? { ref: override, name: override }
      : { error: `branch ${override} not found – check --branch` };
  }
  const listed = git(repoPath, [
    "for-each-ref",
    "--format=%(refname)%00%(symref)",
    ...BRANCH_CANDIDATES,
  ]);
  /** @type {Map<string, string>} */
  const refs = new Map();
  for (const line of listed.stdout.split("\n")) {
    const [refname, symref] = line.split("\0");
    if (refname) refs.set(refname, symref ?? "");
  }
  for (const candidate of BRANCH_CANDIDATES) {
    if (!refs.has(candidate)) continue;
    const ref = refs.get(candidate) || candidate;
    return { ref, name: shortRef(ref) };
  }
  return {
    error:
      "no default branch found (origin/HEAD, main or master) – pass --branch",
  };
}

/**
 * Maps emails through the repo's .mailmap in one call.
 * @param {string} repoPath
 * @param {string[]} emails
 * @returns {string[]}
 */
function mapEmails(repoPath, emails) {
  if (emails.length === 0) return [];
  const mapped = git(repoPath, [
    "check-mailmap",
    ...emails.map((email) => `<${email}>`),
  ]);
  if (!mapped.ok) return emails;
  const lines = mapped.stdout.split("\n");
  return emails.map(
    (email, i) => /<([^>]*)>\s*$/.exec(lines[i] ?? "")?.[1] ?? email,
  );
}

/**
 * @param {string} repoPath
 * @param {ScanOptions} options
 * @param {string[]} warnings
 * @returns {{ matches: (name: string, email: string) => boolean, defaultEmail: string | null }}
 */
function authorFilter(repoPath, options, warnings) {
  if (options.allAuthors) return { matches: () => true, defaultEmail: null };
  if (options.authors.length > 0) {
    const emailValues = options.authors.filter((value) => value.includes("@"));
    const emails = new Set(
      [...emailValues, ...mapEmails(repoPath, emailValues)].map((email) =>
        email.toLowerCase(),
      ),
    );
    const names = new Set(
      options.authors
        .filter((value) => !value.includes("@"))
        .map((name) => name.toLowerCase()),
    );
    return {
      matches: (name, email) =>
        emails.has(email.toLowerCase()) || names.has(name.toLowerCase()),
      defaultEmail: null,
    };
  }
  const configured = git(repoPath, [
    "config",
    "--get",
    "user.email",
  ]).stdout.trim();
  if (!configured) {
    warnings.push(
      "no git config user.email set for this repo, so no PRs count as yours – pass --author or --all-authors",
    );
    return { matches: () => false, defaultEmail: null };
  }
  const [mapped] = mapEmails(repoPath, [configured]);
  const wanted = mapped.toLowerCase();
  return {
    matches: (_name, email) => email.toLowerCase() === wanted,
    defaultEmail: mapped,
  };
}

/**
 * Paths that the branch tip's .gitattributes marks as generated, vendored or
 * documentation, checked in one batch.
 * @param {string} repoPath
 * @param {string} ref
 * @param {string[]} paths
 * @param {string[]} warnings
 */
function linguistExcluded(repoPath, ref, paths, warnings) {
  /** @type {Set<string>} */
  const excluded = new Set();
  if (paths.length === 0) return excluded;
  const checked = git(
    repoPath,
    ["check-attr", "-z", "--stdin", `--source=${ref}`, ...LINGUIST_ATTRIBUTES],
    { input: `${paths.join("\0")}\0` },
  );
  if (!checked.ok) {
    warnings.push(
      `couldn't read .gitattributes (${checked.error}) – linguist exclusions not applied, as they need git 2.40 or later`,
    );
    return excluded;
  }
  const tokens = checked.stdout.split("\0");
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    if (tokens[i + 2] === "set" || tokens[i + 2] === "true") {
      excluded.add(tokens[i]);
    }
  }
  return excluded;
}

/**
 * Authors of each merge PR's branch tip, in one batched call.
 * @param {string} repoPath
 * @param {Pr[]} merges
 * @param {string[]} warnings
 */
function applyBranchAuthors(repoPath, merges, warnings) {
  if (merges.length === 0) return;
  const listed = git(
    repoPath,
    ["log", "--no-walk=unsorted", "--stdin", "--format=%H%x1f%aN%x1f%aE"],
    { input: `${merges.map((pr) => pr.parents[1]).join("\n")}\n` },
  );
  if (!listed.ok) {
    warnings.push(
      `couldn't read merge PRs' branch commits (${listed.error}) – their authors are the merge commits' authors`,
    );
    return;
  }
  /** @type {Map<string, { name: string, email: string }>} */
  const authors = new Map();
  for (const line of listed.stdout.split("\n")) {
    const [sha, name, email] = line.split(FIELD);
    if (sha) authors.set(sha, { name, email });
  }
  for (const pr of merges) {
    const author = authors.get(pr.parents[1]);
    if (author) {
      pr.authorName = author.name;
      pr.authorEmail = author.email;
    }
  }
}

/**
 * @param {Pr[]} prs
 */
function topAuthors(prs) {
  /** @type {Map<string, { label: string, count: number }>} */
  const counts = new Map();
  for (const pr of prs) {
    const key = pr.authorEmail.toLowerCase();
    const entry = counts.get(key) ?? {
      label: `${pr.authorName} <${pr.authorEmail}>`,
      count: 0,
    };
    entry.count++;
    counts.set(key, entry);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 5)
    .map(({ label, count }) => `${label} (${count})`);
}

/**
 * @param {string} repoPath
 * @param {string} name
 * @param {ScanOptions} options
 * @param {(path: string) => boolean} excludePath
 * @param {Intl.DateTimeFormat} formatter
 */
function scanRepo(repoPath, name, options, excludePath, formatter) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {RepoResult} */
  const repo = {
    name,
    path: repoPath,
    branch: null,
    prs: 0,
    direct_commits_ignored: 0,
    warnings,
  };
  /** @type {{ repo: RepoResult, prs: { time: number, result: PrResult }[], directShas: string[], defaultEmail: string | null }} */
  const empty = { repo, prs: [], directShas: [], defaultEmail: null };

  if (options.fetch) {
    const fetched = git(repoPath, ["fetch", "--quiet"]);
    if (!fetched.ok) {
      warnings.push(
        `git fetch failed (${fetched.error}) – scanned the local copy as it is`,
      );
    }
  }

  const branch = resolveBranch(repoPath, options.branch);
  if ("error" in branch) {
    warnings.push(`skipped: ${branch.error}`);
    return empty;
  }
  repo.branch = branch.name;

  const log = git(repoPath, [
    "log",
    "-z",
    "--first-parent",
    "--diff-merges=first-parent",
    "--numstat",
    "-M",
    `--format=${LOG_FORMAT}`,
    branch.ref,
    "--",
  ]);
  if (!log.ok) {
    warnings.push(`skipped: git log failed (${log.error})`);
    return empty;
  }
  const commits = parseLog(log.stdout).reverse();

  /** @type {Pr[]} */
  const allPrs = [];
  /** @type {Commit[]} */
  const direct = [];
  for (const commit of commits) {
    const detected = classify(commit);
    if (detected) {
      allPrs.push({
        ...commit,
        ...detected,
        isRevert: false,
        revertedBy: null,
      });
    } else {
      direct.push(commit);
    }
  }

  applyBranchAuthors(
    repoPath,
    allPrs.filter((pr) => pr.method === "merge"),
    warnings,
  );
  linkReverts(allPrs);

  const filter = authorFilter(repoPath, options, warnings);
  /** @param {number} time */
  const inRange = (time) =>
    (options.sinceMs === null || time >= options.sinceMs) &&
    (options.untilMs === null || time < options.untilMs);

  const prsInRange = allPrs.filter((pr) => inRange(pr.time));
  const prs = prsInRange.filter((pr) =>
    filter.matches(pr.authorName, pr.authorEmail),
  );
  if (prsInRange.length > 0 && prs.length === 0 && !options.allAuthors) {
    warnings.push(
      `no PRs match the author filter. Most frequent PR authors: ${topAuthors(prsInRange).join(", ")} – pass --author to choose`,
    );
  }

  const paths = [
    ...new Set(prs.flatMap((pr) => pr.files.map((file) => file.path))),
  ];
  const linguist = linguistExcluded(repoPath, branch.ref, paths, warnings);
  /** @param {string} path */
  const isExcluded = (path) => excludePath(path) || linguist.has(path);

  const directShas = direct
    .filter(
      (commit) =>
        inRange(commit.time) &&
        filter.matches(commit.authorName, commit.authorEmail),
    )
    .map((commit) => commit.sha);

  return {
    repo,
    prs: prs.map((pr) => ({
      time: pr.time,
      result: toResult(pr, name, isExcluded, formatter),
    })),
    directShas,
    defaultEmail: filter.defaultEmail,
  };
}

/**
 * @param {Pr} pr
 * @param {string} repoName
 * @param {(path: string) => boolean} isExcluded
 * @param {Intl.DateTimeFormat} formatter
 * @returns {PrResult}
 */
function toResult(pr, repoName, isExcluded, formatter) {
  let added = 0;
  let removed = 0;
  let excluded = 0;
  for (const file of pr.files) {
    if (isExcluded(file.path)) {
      excluded += file.added + file.removed;
    } else {
      added += file.added;
      removed += file.removed;
    }
  }
  const lines = added + removed;
  return {
    repo: repoName,
    sha: pr.sha,
    number: pr.number,
    title: pr.title,
    method: pr.method,
    author_name: pr.authorName,
    author_email: pr.authorEmail,
    merged_at: formatInstant(pr.time, formatter),
    added,
    removed,
    lines,
    excluded_lines: excluded,
    score: Math.round(Math.sqrt(lines) * 100) / 100,
    is_revert: pr.isRevert,
    reverted_by: pr.revertedBy,
  };
}

/**
 * @param {ScanOptions} options
 * @returns {ScanResult}
 */
export function scan(options) {
  const repoPaths = findRepos(options.paths, options.depth);
  const names = repoNames(repoPaths);
  const excludePath = pathExcluder({
    includeDocs: options.includeDocs,
    globs: options.exclude,
  });
  const formatter = zoneFormatter(options.timeZone);

  /** @type {Map<string, string>} */
  const seen = new Map();
  /** @type {RepoResult[]} */
  const repos = [];
  /** @type {{ time: number, result: PrResult }[]} */
  const kept = [];
  /** @type {Map<string, PrResult>} */
  const keptBySha = new Map();
  /** @type {Map<string, string>} */
  const defaultEmails = new Map();

  repoPaths.forEach((repoPath, i) => {
    const { repo, prs, directShas, defaultEmail } = scanRepo(
      repoPath,
      names[i],
      options,
      excludePath,
      formatter,
    );
    if (defaultEmail && !defaultEmails.has(defaultEmail.toLowerCase())) {
      defaultEmails.set(defaultEmail.toLowerCase(), defaultEmail);
    }
    /** @type {Map<string, number>} */
    const duplicates = new Map();
    for (const pr of prs) {
      const owner = seen.get(pr.result.sha);
      const first = keptBySha.get(pr.result.sha);
      if (owner) {
        // A later clone can hold a revert that an earlier, staler one lacks.
        if (first && first.reverted_by === null) {
          first.reverted_by = pr.result.reverted_by;
        }
        duplicates.set(owner, (duplicates.get(owner) ?? 0) + 1);
        continue;
      }
      seen.set(pr.result.sha, repo.name);
      keptBySha.set(pr.result.sha, pr.result);
      kept.push(pr);
      repo.prs++;
    }
    for (const sha of directShas) {
      if (seen.has(sha)) continue;
      seen.set(sha, repo.name);
      repo.direct_commits_ignored++;
    }
    for (const [owner, count] of duplicates) {
      repo.warnings.push(
        `${count} PR${count === 1 ? "" : "s"} already counted under ${owner} (same commits) – skipped here`,
      );
    }
    repos.push(repo);
  });

  kept.sort(
    (a, b) =>
      a.time - b.time ||
      a.result.repo.localeCompare(b.result.repo) ||
      a.result.sha.localeCompare(b.result.sha),
  );

  return {
    generated_at: formatInstant(options.now ?? Date.now(), formatter),
    options: {
      authors: options.allAuthors
        ? []
        : options.authors.length > 0
          ? [...options.authors]
          : [...defaultEmails.values()],
      all_authors: options.allAuthors,
      include_docs: options.includeDocs,
      since: options.since,
      until: options.until,
      timezone: options.timeZone,
    },
    repos,
    prs: kept.map((pr) => pr.result),
  };
}
