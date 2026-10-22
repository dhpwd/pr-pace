import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { majorOf, paceLine } from "./pace.js";
import { renderReport } from "./report.js";
import { scan, VERSION } from "./scan.js";
import { addDays, isDay, startOfDay, zoneFormatter } from "./time.js";

/** @typedef {Record<string, string | boolean | (string | boolean)[] | undefined>} ArgValues */

const MAIN_HELP = `pr-pace – measure PR pace from local git history

Usage
  pr-pace pace [path...] [options]     Print your PR pace as one line to post
  pr-pace scan [path...] [options]     Write the scan result as JSON
  pr-pace report [path...] [options]   Write a self-contained HTML report

Counts merged pull requests on each repo's default branch – PR count,
size-weighted PRs (each PR counts √(lines ÷ 100)), median PR size, lines
changed and revert rate – for one repo or a folder of repos. PR pace is
size-weighted PRs per week over the last 30 days.

Run pr-pace <command> --help for each command's options.

Options
  -h, --help      Show this help
  -v, --version   Show the version
`;

/** @type {Record<string, string>} */
const SCAN_OPTION_HELP = {
  depth: `  --depth <n>             How many folder levels below a path to look for
                          repos (default: 1)`,
  fetch: `  --fetch                 Run git fetch --all in each repo first. The only
                          option that writes to the scanned repos`,
  branch: `  --branch <name>         Use this branch in every repo instead of detecting
                          each repo's default branch`,
  author: `  --author <email|name>   Count only this author: exact match, ignoring case,
                          after .mailmap. "Name <email>" matches by email.
                          Repeatable. Default: each repo's git config
                          user.email. Any --author replaces that default,
                          so pass it once for each of your identities`,
  "all-authors": `  --all-authors           Count every author (for team breakdowns)`,
  since: `  --since <date>          Only PRs merged on or after this date`,
  until: `  --until <date>          Only PRs merged on or before this date. A bare date
                          includes the whole day`,
  "include-docs": `  --include-docs          Count docs files (*.md, *.txt and similar) in lines
                          changed`,
  exclude: `  --exclude <glob>        Leave matching paths out of lines changed.
                          Repeatable. * matches within a folder, ** across
                          folders, ? one character. A glob without / matches
                          a file or folder name at any depth. A leading or
                          inner / anchors it at the repo root`,
};

const SCAN_OPTIONS_HELP = Object.values(SCAN_OPTION_HELP).join("\n");

// pace refuses the rest – see runPace.
const PACE_OPTIONS_HELP = ["depth", "fetch", "branch", "author", "exclude"]
  .map((name) => SCAN_OPTION_HELP[name])
  .join("\n");

const PATHS_HELP = `Each path is a repo, or a folder whose subfolders are repos (default: .).`;

const LINES_HELP = `Lines changed leave out binary files, docs, lockfiles, build output and
anything .gitattributes marks linguist-generated, linguist-vendored or
linguist-documentation.`;

const NOTES_HELP = `${PATHS_HELP}
Dates are YYYY-MM-DD in this machine's timezone, or a full ISO 8601 timestamp
such as 2026-10-01T09:00:00+01:00.

${LINES_HELP} Revert PRs are left out of every count, and the PR
they revert counts towards the revert rate.`;

const PACE_HELP = `Usage: pr-pace pace [path...] [options]

Scan, then print your PR pace as one line to post: size-weighted PRs per week
over the 30 days to today, today included. Each PR counts √(lines ÷ 100).
Revert PRs and PRs since reverted count zero. The line carries the window, the
PR count, the median PR size and the tool's major version, so post it whole.

Options
  --from <scan.json>      Print the line from a saved scan instead of
                          scanning, counting back from the day it ran. Paths
                          and scan options can't be combined with it. A scan
                          from another major version of pr-pace is refused
${PACE_OPTIONS_HELP}
  -h, --help              Show this help

${PATHS_HELP}
Days are in this machine's timezone.

${LINES_HELP}

Examples
  pr-pace pace ~/code
  pr-pace pace --from scan.json
`;

const SCAN_HELP = `Usage: pr-pace scan [path...] [options]

Scan merged PRs on each repo's default branch and write the result as JSON.

Options
${SCAN_OPTIONS_HELP}
  --out <file>            Write the JSON to this file instead of stdout
  -h, --help              Show this help

${NOTES_HELP}

Examples
  pr-pace scan ~/code --since 2026-01-01
  pr-pace scan . --all-authors --out scan.json
`;

const REPORT_HELP = `Usage: pr-pace report [path...] [options]

Scan, then write a self-contained HTML report: charts of PRs, size-weighted
PRs, median PR size, lines changed and revert rate by day, week or month, with
a list of the PRs behind each bar. The file makes no network requests, so it
works offline and as an attachment.

Options
  --from <scan.json>      Build the report from a saved scan instead of
                          scanning. Paths and scan options can't be combined
                          with it
  --out <file>            Where to write the report (default: pr-pace.html)
  --open                  Open the report in the default browser
${SCAN_OPTIONS_HELP}
  -h, --help              Show this help

${NOTES_HELP}

Examples
  pr-pace report ~/code --open
  pr-pace report --from scan.json --out report.html
`;

/** @type {NonNullable<import('node:util').ParseArgsConfig['options']>} */
const SCAN_OPTIONS = {
  depth: { type: "string" },
  fetch: { type: "boolean" },
  branch: { type: "string" },
  author: { type: "string", multiple: true },
  "all-authors": { type: "boolean" },
  since: { type: "string" },
  until: { type: "string" },
  "include-docs": { type: "boolean" },
  exclude: { type: "string", multiple: true },
};

/** @type {Record<'pace' | 'scan' | 'report', { help: string, options: NonNullable<import('node:util').ParseArgsConfig['options']> }>} */
const COMMANDS = {
  // The scan options pace refuses stay declared, so they get runPace's
  // message rather than "unknown option".
  pace: {
    help: PACE_HELP,
    options: {
      ...SCAN_OPTIONS,
      from: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  },
  scan: {
    help: SCAN_HELP,
    options: {
      ...SCAN_OPTIONS,
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  },
  report: {
    help: REPORT_HELP,
    options: {
      ...SCAN_OPTIONS,
      from: { type: "string" },
      out: { type: "string" },
      open: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  },
};

const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

// A semver package version, so the npx command that pace --from suggests for
// another major's scan can hold nothing from the file but a version.
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

/**
 * Turns a --since or --until value into an epoch-ms bound: inclusive for
 * --since, exclusive for --until.
 * @param {'--since' | '--until'} flag
 * @param {string} value
 * @param {string} timeZone
 */
export function parseBound(flag, value, timeZone) {
  const formatter = zoneFormatter(timeZone);
  const datePart = value.slice(0, 10);
  if (isDay(value)) {
    return startOfDay(
      flag === "--until" ? addDays(value, 1) : value,
      formatter,
    );
  }
  if (TIMESTAMP.test(value) && isDay(datePart)) {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return flag === "--until" ? ms + 1 : ms;
  }
  throw new Error(
    `${flag} "${value}" isn't a date I can read – use YYYY-MM-DD (taken in ${timeZone}) or a full ISO 8601 timestamp such as 2026-10-01T09:00:00+01:00`,
  );
}

/**
 * @param {ArgValues} values
 * @param {string[]} positionals
 * @returns {import('./scan.js').ScanOptions}
 */
function scanOptions(values, positionals) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const depth = /** @type {string | undefined} */ (values.depth) ?? "1";
  if (!/^\d+$/.test(depth)) {
    throw new Error(
      `--depth "${depth}" isn't a whole number – pass 0 or more folder levels`,
    );
  }
  const authors = /** @type {string[] | undefined} */ (values.author) ?? [];
  if (authors.length > 0 && values["all-authors"]) {
    throw new Error(
      "--author and --all-authors can't be combined – pass one or the other",
    );
  }
  const since = /** @type {string | undefined} */ (values.since) ?? null;
  const until = /** @type {string | undefined} */ (values.until) ?? null;
  const sinceMs =
    since === null ? null : parseBound("--since", since, timeZone);
  const untilMs =
    until === null ? null : parseBound("--until", until, timeZone);
  if (sinceMs !== null && untilMs !== null && sinceMs >= untilMs) {
    throw new Error("--since is after --until – swap them round");
  }
  return {
    paths: positionals.length > 0 ? positionals : ["."],
    depth: Number(depth),
    fetch: Boolean(values.fetch),
    branch: /** @type {string | undefined} */ (values.branch) ?? null,
    authors,
    allAuthors: Boolean(values["all-authors"]),
    since,
    until,
    sinceMs,
    untilMs,
    includeDocs: Boolean(values["include-docs"]),
    exclude: /** @type {string[] | undefined} */ (values.exclude) ?? [],
    timeZone,
  };
}

/** @param {import('./scan.js').ScanResult} result */
function printWarnings(result) {
  for (const repo of result.repos) {
    for (const warning of repo.warnings) {
      process.stderr.write(`pr-pace: warning: ${repo.name}: ${warning}\n`);
    }
  }
}

/** @param {string} file */
function notAScan(file) {
  return new Error(
    `${file} isn't a pr-pace scan – pass a file written by pr-pace scan`,
  );
}

/** @param {string} file */
function readScan(file) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `couldn't read ${file} (${/** @type {Error} */ (error).message}) – pass a file written by pr-pace scan`,
    );
  }
  const candidate = /** @type {Partial<import('./scan.js').ScanResult>} */ (
    parsed
  );
  if (
    !candidate ||
    !Array.isArray(candidate.prs) ||
    !Array.isArray(candidate.repos) ||
    !candidate.options
  ) {
    throw notAScan(file);
  }
  return /** @type {import('./scan.js').ScanResult} */ (candidate);
}

/**
 * @param {string} file
 * @param {string} content
 */
function writeOutput(file, content) {
  try {
    writeFileSync(file, content);
  } catch (error) {
    throw new Error(
      `couldn't write ${file} (${/** @type {Error} */ (error).message}) – check the folder exists and is writable`,
    );
  }
}

/**
 * @param {string} file
 * @param {import('./scan.js').ScanResult} result
 */
function printWritten(file, result) {
  const prs = result.prs.length;
  const repos = result.repos.length;
  process.stderr.write(
    `pr-pace: wrote ${file} – ${prs} PR${prs === 1 ? "" : "s"} from ${repos} repo${repos === 1 ? "" : "s"}\n`,
  );
}

/** @param {string} file */
function openInBrowser(file) {
  /** @type {[string, string[]]} */
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [file]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", file]]
        : ["xdg-open", [file]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {
    process.stderr.write(
      `pr-pace: warning: couldn't open a browser – open ${file} yourself\n`,
    );
  });
  child.unref();
}

/**
 * @param {ArgValues} values
 * @param {string[]} positionals
 */
function runScan(values, positionals) {
  const result = scan(scanOptions(values, positionals));
  printWarnings(result);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (typeof values.out === "string") {
    writeOutput(values.out, json);
    printWritten(values.out, result);
  } else {
    process.stdout.write(json);
  }
}

/**
 * Reads --from's saved scan, refusing paths and scan options given with it.
 * @param {string} file
 * @param {ArgValues} values
 * @param {string[]} positionals
 * @param {string} does what --from does with the scan, for the error
 */
function readFromScan(file, values, positionals, does) {
  const scanFlags = Object.keys(SCAN_OPTIONS).filter(
    (name) => values[name] !== undefined,
  );
  if (positionals.length > 0 || scanFlags.length > 0) {
    const given = [
      ...(positionals.length > 0 ? ["paths"] : []),
      ...scanFlags.map((name) => `--${name}`),
    ];
    throw new Error(
      `--from ${does} from a saved scan, so ${given.join(", ")} can't be used with it – drop them, or drop --from to scan afresh`,
    );
  }
  return readScan(file);
}

/**
 * @param {ArgValues} values
 * @param {string[]} positionals
 */
function runPace(values, positionals) {
  /** @type {import('./scan.js').ScanResult} */
  let result;
  // Every posted line must cover the same window, one person and lines
  // counted the same way – see "PR pace" in docs/specs/v1.md.
  if (typeof values.from === "string") {
    const file = values.from;
    result = readFromScan(file, values, positionals, "prints the PR pace");
    // Checked first, as another major's options may not mean what the checks
    // below expect. A scan without a version predates the field – see "JSON
    // output" in docs/specs/v1.md.
    const { version = VERSION, options } = result;
    if (typeof version !== "string" || !PACKAGE_VERSION.test(version)) {
      throw notAScan(file);
    }
    const major = majorOf(version);
    if (major !== majorOf(VERSION)) {
      throw new Error(
        `${file} was scanned with pr-pace ${version}, and this is pr-pace ${VERSION} – a PR pace line must come from one major version's rules, so run pr-pace pace afresh, or print it with that version: npx pr-pace@${major} pace --from ${file}`,
      );
    }
    if (options.since !== null || options.until !== null) {
      throw new Error(
        `${file} was scanned with --since or --until, and PR pace always covers the 30 days to the day the scan ran – pass a scan run without them, or drop --from to scan afresh`,
      );
    }
    if (options.all_authors) {
      throw new Error(
        `${file} was scanned with --all-authors, and PR pace is one person's figure – pass a scan of one person's PRs, or drop --from to scan afresh`,
      );
    }
    if (options.include_docs) {
      throw new Error(
        `${file} was scanned with --include-docs, and every PR pace line counts lines the same way – pass a scan run without it, or drop --from to scan afresh`,
      );
    }
  } else {
    if (values.since !== undefined || values.until !== undefined) {
      throw new Error(
        "--since and --until can't be used with pace – it always covers the 30 days to today",
      );
    }
    if (values["all-authors"]) {
      throw new Error(
        "PR pace is one person's figure – pass --author for someone else, not --all-authors",
      );
    }
    if (values["include-docs"]) {
      throw new Error(
        "--include-docs can't be used with pace – every PR pace line counts lines the same way",
      );
    }
    result = scan(scanOptions(values, positionals));
    printWarnings(result);
  }
  process.stdout.write(`${paceLine(result, VERSION)}\n`);
}

/**
 * @param {ArgValues} values
 * @param {string[]} positionals
 */
function runReport(values, positionals) {
  /** @type {import('./scan.js').ScanResult} */
  let result;
  if (typeof values.from === "string") {
    result = readFromScan(
      values.from,
      values,
      positionals,
      "builds the report",
    );
  } else {
    result = scan(scanOptions(values, positionals));
    printWarnings(result);
  }
  const out = typeof values.out === "string" ? values.out : "pr-pace.html";
  writeOutput(out, renderReport(result));
  printWritten(out, result);
  if (values.open) openInBrowser(resolve(out));
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
  const [command, ...rest] = argv;
  try {
    if (command === undefined) {
      process.stderr.write(MAIN_HELP);
      return 1;
    }
    if (command === "-h" || command === "--help") {
      process.stdout.write(MAIN_HELP);
      return 0;
    }
    if (command === "-v" || command === "--version") {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (command !== "pace" && command !== "scan" && command !== "report") {
      throw new Error(
        `unknown command "${command}" – use pace, scan or report (pr-pace --help lists all three)`,
      );
    }
    const spec = COMMANDS[command];
    /** @type {{ values: ArgValues, positionals: string[] }} */
    let parsed;
    try {
      parsed = parseArgs({
        args: rest,
        options: spec.options,
        allowPositionals: true,
        strict: true,
      });
    } catch (error) {
      const err = /** @type {NodeJS.ErrnoException} */ (error);
      const unknown = /^Unknown option '([^']+)'/.exec(err.message);
      throw new Error(
        unknown
          ? `unknown option ${unknown[1]} – pr-pace ${command} --help lists the options`
          : `${err.message} – pr-pace ${command} --help lists the options`,
      );
    }
    if (parsed.values.help) {
      process.stdout.write(spec.help);
      return 0;
    }
    if (command === "pace") runPace(parsed.values, parsed.positionals);
    else if (command === "scan") runScan(parsed.values, parsed.positionals);
    else runReport(parsed.values, parsed.positionals);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pr-pace: ${message}\n`);
    return 1;
  }
}
