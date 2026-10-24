import { readFileSync } from "node:fs";
import { LINGUIST_ATTRIBUTES, pathExcluder } from "./exclude.js";
import { git } from "./git.js";
import { latestNames } from "./report/client.js";
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
 * @property {string | null} agent_email
 * @property {string} merged_at
 * @property {number} added
 * @property {number} removed
 * @property {number} lines
 * @property {number} excluded_lines
 * @property {number} weighted_prs
 * @property {boolean} is_revert
 * @property {string | null} reverted_by
 *
 * @typedef {object} ScanResult
 * @property {string} [version] the pr-pace version that wrote the scan. A scan
 * written before the field has none
 * @property {string} generated_at
 * @property {{ authors: string[], all_authors: boolean, include_docs: boolean, exclude: string[], since: string | null, until: string | null, timezone: string }} options
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
 * @typedef {Commit & { method: 'squash' | 'merge', number: number, title: string, isRevert: boolean, revertedBy: string | null, agentEmail: string | null }} Pr
 *
 * @typedef {{ name: string, email: string }} Identity
 */

/** @type {string} */
export const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const FIELD = "\x1f";
const RECORD = "\x1e";
const LOG_FORMAT = "%x1e%H%x1f%P%x1f%aN%x1f%aE%x1f%ct%x1f%B%x1f";
const LOG_FIELDS = 6;
const TIP_FORMAT = "%x1e%H%x1f%aN%x1f%aE%x1f%B";

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

// Agent identities, matched on the lowercased email after .mailmap. A PR whose
// git author is one counts for the first person its Co-authored-by: trailers
// name – see "Detecting PRs" in docs/specs/v1.md. Every address here is also a
// coding agent the no-match warning's hint names.
const AGENT_EMAILS = new Set([
  // GitHub Copilot coding agent: squash author and branch commit author
  "198982749+copilot@users.noreply.github.com",
  // Codex's coding agent on GitHub (openai-code-agent[bot]): squash author and
  // branch commit author
  "242516109+codex@users.noreply.github.com",
  // Codex's GitHub account `codex`: branch commit author on PRs it's asked to
  // edit
  "267193182+codex@users.noreply.github.com",
  // Gemini's GitHub account `gemini-code-assist`: branch commit author and
  // trailer on commits Gemini tools make, by its no-reply address and by the
  // id-less form
  "200291788+gemini-code-assist@users.noreply.github.com",
  "gemini-code-assist@users.noreply.github.com",
  // Cursor's cloud agents: branch commit author
  "cursoragent@cursor.com",
  // Cursor's cloud agents: branch commit author, a rarer variant
  "cursor-agent@cursor.com",
]);
// AI tool identities, matched the same way. An AI tool's own Co-authored-by:
// trailer names no person, so crediting an agent PR skips it, and nothing else
// reads these – see "Detecting PRs" in docs/specs/v1.md.
const AI_TOOL_NOREPLY_LOCAL_PART = /^no-?reply@/;
const AI_TOOL_EMAILS = new Set([
  // Codex
  "codex@openai.com",
  // Codex, by a hand-written form of its GitHub account's no-reply address,
  // with no id
  "codex@users.noreply.github.com",
  // OpenHands
  "openhands@all-hands.dev",
  // Amp
  "amp@ampcode.com",
  // GitHub Copilot
  "copilot@github.com",
  // Google Jules
  "jules@google.com",
]);
// The coding agents the no-match warning's hint names, by lowercased email or
// GitHub no-reply login (the part before "@", after any "<id>+"). Never
// dependency or automation bots, whose PRs would count for whoever maps them
// to themselves.
const CODING_AGENTS = new Set([
  ...AGENT_EMAILS,
  "copilot-swe-agent[bot]",
  "devin-ai-integration[bot]",
  "cursor[bot]",
  "google-labs-jules[bot]",
]);
// The forms of origin's URL the owner is read from – see "Detecting PRs" in
// docs/specs/v1.md.
const GITHUB_REMOTE =
  /^(?:https:\/\/(?:[^/@]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/]+)\/[^/]+\/?$/i;
const CO_AUTHOR = /^co-authored-by:\s*(\S.*?)\s*<([^<>]*)>$/i;
const MAPPED_CONTACT = /^(.*?)\s*<([^<>]*)>\s*$/;

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
 * The earlier PR that a commit's first matching `This reverts commit <sha>`
 * line names, by full SHA or prefix.
 * @param {Commit} commit
 * @param {Map<string, Pr>} bySha
 */
function revertedBySha(commit, bySha) {
  for (const [, sha] of commit.message.matchAll(REVERTS_COMMIT)) {
    const wanted = sha.toLowerCase();
    const exact = bySha.get(wanted);
    if (exact) return exact;
    if (wanted.length >= commit.sha.length) continue;
    for (const earlier of bySha.values()) {
      if (earlier.sha.startsWith(wanted)) return earlier;
    }
  }
  return undefined;
}

/**
 * Marks revert PRs and links each revert to the PR it reverts. Runs over a
 * repo's whole first-parent history, oldest first, before any author or date
 * filter. A direct commit links only by SHA, which covers `git revert` pushed
 * straight to the branch, and isn't itself counted.
 * @param {Commit[]} commits oldest first
 * @param {Map<string, Pr>} prsBySha the PR each PR commit was detected as
 */
function linkReverts(commits, prsBySha) {
  /** @type {Map<string, Pr>} */
  const bySha = new Map();
  /** @type {Map<string, Pr>} */
  const byTitle = new Map();
  for (const commit of commits) {
    let original = revertedBySha(commit, bySha);
    const pr = prsBySha.get(commit.sha);
    if (!pr) {
      if (original && original.revertedBy === null) {
        original.revertedBy = commit.sha;
      }
      continue;
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

/** @param {string} error */
function unreadable(error) {
  return `git can't read this repo (${error}) – run git status in it to see why`;
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
    if (found.ok) return { ref: override, name: override };
    return found.error
      ? { error: unreadable(found.error) }
      : { error: `branch ${override} not found – check --branch` };
  }
  const listed = git(repoPath, [
    "for-each-ref",
    "--format=%(refname)%00%(symref)",
    ...BRANCH_CANDIDATES,
  ]);
  if (!listed.ok) return { error: unreadable(listed.error) };
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

/** @param {Identity} identity an empty name gives `<email>` */
function contact({ name, email }) {
  return name ? `${name} <${email}>` : `<${email}>`;
}

/**
 * Maps identities, name and email together, through the repo's .mailmap in
 * one call, keyed by their `Name <email>` form. Unmapped if the call fails.
 * @param {string} repoPath
 * @param {Identity[]} identities
 * @returns {Map<string, Identity>}
 */
function mapIdentities(repoPath, identities) {
  const byContact = new Map(
    identities.map((identity) => [contact(identity), identity]),
  );
  if (byContact.size === 0) return byContact;
  const contacts = [...byContact.keys()];
  const mapped = git(repoPath, ["check-mailmap", "--stdin"], {
    input: `${contacts.join("\n")}\n`,
  });
  if (!mapped.ok) return byContact;
  const lines = mapped.stdout.split("\n");
  contacts.forEach((key, i) => {
    const match = MAPPED_CONTACT.exec(lines[i] ?? "");
    if (match) byContact.set(key, { name: match[1], email: match[2] });
  });
  return byContact;
}

/**
 * Maps emails through the repo's .mailmap in one call.
 * @param {string} repoPath
 * @param {string[]} emails
 * @returns {string[]}
 */
function mapEmails(repoPath, emails) {
  const identities = emails.map((email) => ({ name: "", email }));
  const mapped = mapIdentities(repoPath, identities);
  return identities.map(
    (identity) => mapped.get(contact(identity))?.email ?? identity.email,
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
    // "Name <email> (count)", as the no-match warning lists authors, matches
    // by email.
    const values = options.authors.map(
      (value) =>
        /<([^<>]*@[^<>]*)>(?:\s*\(\d+\))?\s*$/.exec(value)?.[1] ?? value,
    );
    const emailValues = values.filter((value) => value.includes("@"));
    const emails = new Set(
      [...emailValues, ...mapEmails(repoPath, emailValues)].map((email) =>
        email.toLowerCase(),
      ),
    );
    const names = new Set(
      values
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
      "no git config user.email set for this repo, so no PRs count as yours – pass --author, once for each of your identities, or --all-authors",
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
 * Authors of each merge PR's branch tip, in one batched call that also reads
 * the tips' messages.
 * @param {string} repoPath
 * @param {Pr[]} merges
 * @param {string[]} warnings
 * @returns {Map<string, string>} each branch tip's message, by merge PR SHA
 */
function applyBranchAuthors(repoPath, merges, warnings) {
  /** @type {Map<string, string>} */
  const messages = new Map();
  if (merges.length === 0) return messages;
  const listed = git(
    repoPath,
    ["log", "--no-walk=unsorted", "--stdin", `--format=${TIP_FORMAT}`],
    { input: `${merges.map((pr) => pr.parents[1]).join("\n")}\n` },
  );
  if (!listed.ok) {
    warnings.push(
      `couldn't read merge PRs' branch commits (${listed.error}) – their authors are the merge commits' authors, and none is credited to a co-author`,
    );
    return messages;
  }
  /** @type {Map<string, Identity & { message: string }>} */
  const tips = new Map();
  for (const record of listed.stdout.split(RECORD).slice(1)) {
    const [sha, name, email, message] = record.split(FIELD);
    tips.set(sha, { name, email, message });
  }
  for (const pr of merges) {
    const tip = tips.get(pr.parents[1]);
    if (tip) {
      pr.authorName = tip.name;
      pr.authorEmail = tip.email;
      messages.set(pr.sha, tip.message);
    }
  }
  return messages;
}

/**
 * The id and login of a GitHub no-reply address, `<id>+<login>@` or the older
 * id-less `<login>@` form – see "Detecting PRs" in docs/specs/v1.md. Rules over
 * GitHub no-reply addresses test these parts rather than matching the address
 * again, each requiring the id or not. `latestNames` in src/report/client.js
 * repeats the pattern, as the report's inlined code can't import this module.
 * @param {string} lower a lowercased email
 * @returns {{ id: string | undefined, login: string } | undefined}
 */
function noReplyParts(lower) {
  const match = /^(?:(\d+)\+)?([^@]+)@users\.noreply\.github\.com$/.exec(lower);
  return match ? { id: match[1], login: match[2] } : undefined;
}

/** @param {string} email after .mailmap */
function isAgent(email) {
  const lower = email.toLowerCase();
  const parts = noReplyParts(lower);
  return (
    (parts !== undefined && parts.login.endsWith("[bot]")) ||
    AGENT_EMAILS.has(lower)
  );
}

/** @param {string} email after .mailmap */
function isAiTool(email) {
  const lower = email.toLowerCase();
  const parts = noReplyParts(lower);
  return (
    AI_TOOL_NOREPLY_LOCAL_PART.test(lower) ||
    (parts?.id !== undefined && parts.login === "copilot") ||
    AI_TOOL_EMAILS.has(lower)
  );
}

/** @param {string} email after .mailmap */
function isCodingAgent(email) {
  const lower = email.toLowerCase();
  const parts = noReplyParts(lower);
  return (
    CODING_AGENTS.has(lower) ||
    (parts !== undefined && CODING_AGENTS.has(parts.login))
  );
}

/**
 * Every `Co-authored-by:` trailer in a message, in order. They're read from
 * any line, as a squash message can hold them outside its final trailer
 * block.
 * @param {string} message
 * @returns {Identity[]}
 */
function coAuthors(message) {
  /** @type {Identity[]} */
  const found = [];
  for (const line of message.split("\n")) {
    const match = CO_AUTHOR.exec(line.trim());
    const email = match?.[2].trim();
    if (match && email) found.push({ name: match[1], email });
  }
  return found;
}

/**
 * Credits each PR whose git author is an agent to the first person its
 * `Co-authored-by:` trailers name, skipping agents and AI tools: the squash
 * commit's, or the merge PR's branch tip's. A PR with no such person keeps
 * the agent as its author.
 * @param {string} repoPath
 * @param {Pr[]} prs
 * @param {Map<string, string>} tipMessages from applyBranchAuthors
 */
function creditCoAuthors(repoPath, prs, tipMessages) {
  /** @type {{ pr: Pr, trailers: Identity[] }[]} */
  const candidates = [];
  for (const pr of prs) {
    if (!isAgent(pr.authorEmail)) continue;
    pr.agentEmail = pr.authorEmail;
    const message =
      pr.method === "squash" ? pr.message : tipMessages.get(pr.sha);
    const trailers = message === undefined ? [] : coAuthors(message);
    if (trailers.length > 0) candidates.push({ pr, trailers });
  }
  const mapped = mapIdentities(
    repoPath,
    candidates.flatMap(({ trailers }) => trailers),
  );
  for (const { pr, trailers } of candidates) {
    const person = trailers
      .map((trailer) => mapped.get(contact(trailer)) ?? trailer)
      .find(
        (identity) => !isAgent(identity.email) && !isAiTool(identity.email),
      );
    if (person) {
      pr.authorName = person.name;
      pr.authorEmail = person.email;
    }
  }
}

/**
 * PR counts by author email, most frequent first, each labelled `Name <email>`
 * with the email of the first PR seen and the name the report's legend gives
 * them (`latestNames`) over all the repo's PRs in range, not only those
 * counted. `authorPaceLines` in src/pace.js labels authors in the same form,
 * over the whole scan.
 * @param {Pr[]} prs
 * @param {Pr[]} inRange the repo's PRs in range, oldest first
 */
function authorCounts(prs, inRange) {
  const names = latestNames(
    inRange.map((pr) => ({
      authorKey: pr.authorEmail.toLowerCase(),
      author_name: pr.authorName,
    })),
  );
  /** @type {Map<string, { label: string, email: string, count: number }>} */
  const counts = new Map();
  for (const pr of prs) {
    const key = pr.authorEmail.toLowerCase();
    const entry = counts.get(key) ?? {
      label: `${names.get(key)} <${pr.authorEmail}>`,
      email: pr.authorEmail,
      count: 0,
    };
    entry.count++;
    counts.set(key, entry);
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );
}

/**
 * The warning for a repo whose PRs in range match no author filter, naming the
 * five most frequent PR authors, with a hint for each coding agent among them.
 * @param {Pr[]} prs
 */
function noMatchWarning(prs) {
  const top = authorCounts(prs, prs).slice(0, 5);
  const warning = `no PRs match the author filter. Most frequent PR authors: ${top.map(({ label, count }) => `${label} (${count})`).join(", ")} – pass --author to choose, once for each of your identities`;
  const agents = top
    .filter(({ email }) => isCodingAgent(email))
    .map(({ label }) => label);
  if (agents.length === 0) return warning;
  if (agents.length === 1) {
    return `${warning}. ${agents[0]} is a coding agent with no co-author naming a person on these PRs – if only you use it, pass its email as an extra --author alongside your own or map it to yourself in .mailmap, otherwise turn on the agent's setting that adds you as co-author`;
  }
  const named = `${agents.slice(0, -1).join(", ")} and ${agents[agents.length - 1]}`;
  return `${warning}. ${named} are coding agents with no co-author naming a person on these PRs – if only you use them, pass their emails as extra --author values alongside your own or map them to yourself in .mailmap, otherwise turn on each agent's setting that adds you as co-author`;
}

/**
 * A warning for each GitHub no-reply address of origin's owner that PRs in
 * range count for and the author filter misses – see "Detecting PRs" in
 * docs/specs/v1.md. Reads origin's URL only when some PR counts for a
 * person's no-reply address the filter misses, so other repos spawn no extra
 * git call.
 * @param {string} repoPath
 * @param {Pr[]} prs in range, after crediting
 * @param {(name: string, email: string) => boolean} matches the author filter
 */
function ownerNoReplyWarnings(repoPath, prs, matches) {
  /** @param {Pr} pr */
  const login = (pr) => noReplyParts(pr.authorEmail.toLowerCase())?.login;
  const missed = prs.filter(
    (pr) =>
      login(pr) !== undefined &&
      !isAgent(pr.authorEmail) &&
      !matches(pr.authorName, pr.authorEmail),
  );
  if (missed.length === 0) return [];
  const url = git(repoPath, ["remote", "get-url", "origin"]).stdout.trim();
  const owner = GITHUB_REMOTE.exec(url)?.[1].toLowerCase();
  if (!owner) return [];
  const owned = missed.filter((pr) => login(pr) === owner);
  return authorCounts(owned, prs).map(
    ({ label, count }) =>
      `${count} PR${count === 1 ? " credits" : "s credit"} ${label}, the GitHub no-reply address of this repo's owner, which the author filter doesn't match – if it's you, pass it as an extra --author alongside your own email, or map it to your usual identity in .mailmap`,
  );
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

  // Every remote: the branch read is origin/* or a --branch on any remote.
  const fetched = options.fetch
    ? git(repoPath, ["fetch", "--quiet", "--all"])
    : null;

  const branch = resolveBranch(repoPath, options.branch);
  if ("error" in branch) {
    warnings.push(`skipped: ${branch.error}`);
    return empty;
  }
  repo.branch = branch.name;
  if (fetched && !fetched.ok) {
    warnings.push(
      `git fetch failed (${fetched.error}) – scanned the local copy as it is`,
    );
  }

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
  /** @type {Map<string, Pr>} */
  const prsBySha = new Map();
  /** @type {Commit[]} */
  const direct = [];
  for (const commit of commits) {
    const detected = classify(commit);
    if (detected) {
      /** @type {Pr} */
      const pr = {
        ...commit,
        ...detected,
        isRevert: false,
        revertedBy: null,
        agentEmail: null,
      };
      allPrs.push(pr);
      prsBySha.set(pr.sha, pr);
    } else {
      direct.push(commit);
    }
  }
  linkReverts(commits, prsBySha);

  /** @param {number} time */
  const inRange = (time) =>
    (options.sinceMs === null || time >= options.sinceMs) &&
    (options.untilMs === null || time < options.untilMs);
  const prsInRange = allPrs.filter((pr) => inRange(pr.time));
  const tipMessages = applyBranchAuthors(
    repoPath,
    prsInRange.filter((pr) => pr.method === "merge"),
    warnings,
  );
  creditCoAuthors(repoPath, prsInRange, tipMessages);

  const filter = authorFilter(repoPath, options, warnings);
  const prs = prsInRange.filter((pr) =>
    filter.matches(pr.authorName, pr.authorEmail),
  );
  if (prsInRange.length > 0 && prs.length === 0 && !options.allAuthors) {
    warnings.push(noMatchWarning(prsInRange));
  }
  if (!options.allAuthors) {
    warnings.push(
      ...ownerNoReplyWarnings(repoPath, prsInRange, filter.matches),
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
    agent_email: pr.agentEmail,
    merged_at: formatInstant(pr.time, formatter),
    added,
    removed,
    lines,
    excluded_lines: excluded,
    weighted_prs: Math.round(Math.sqrt(lines / 100) * 1000) / 1000,
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
    version: VERSION,
    generated_at: formatInstant(options.now ?? Date.now(), formatter),
    options: {
      authors: options.allAuthors
        ? []
        : options.authors.length > 0
          ? [...options.authors]
          : [...defaultEmails.values()],
      all_authors: options.allAuthors,
      include_docs: options.includeDocs,
      exclude: [...options.exclude],
      since: options.since,
      until: options.until,
      timezone: options.timeZone,
    },
    repos,
    prs: kept.map((pr) => pr.result),
  };
}
