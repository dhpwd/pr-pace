import {
  latestNames,
  medianLines,
  presetRange,
  weightOf,
} from "./report/client.js";
import { addDays, dayOf, startOfDay, zoneFormatter } from "./time.js";

/**
 * @typedef {{ today: string, pace: number, count: number, median: number | null }} Pace
 */

/**
 * The scan's run day, and whether a PR merged in the 30 days to it. Taking the
 * run day from `generated_at` gives a saved scan the same window whenever it's
 * read.
 * @param {import('./scan.js').ScanResult} scan
 */
function windowOf(scan) {
  const formatter = zoneFormatter(scan.options.timezone);
  const today = dayOf(Date.parse(scan.generated_at), formatter);
  // The report's "30 days" preset, so the line and the preset cover the same
  // days.
  const days = presetRange("30d", {
    generatedDay: today,
    firstDay: today,
    endDay: today,
  });
  const from = startOfDay(days.from, formatter);
  const to = startOfDay(addDays(days.to, 1), formatter);
  return {
    today,
    /** @param {import('./scan.js').PrResult} pr */
    holds: (pr) => {
      const merged = Date.parse(pr.merged_at);
      return merged >= from && merged < to;
    },
  };
}

/**
 * PR pace over the 30 days to the scan's run day – see "PR pace" in
 * docs/specs/v1.md.
 * @param {import('./scan.js').ScanResult} scan
 * @returns {Pace}
 */
export function paceOf(scan) {
  const { today, holds } = windowOf(scan);
  const prs = scan.prs.filter(
    (pr) => pr.is_revert === false && pr.reverted_by === null && holds(pr),
  );
  const weighted = prs.reduce((sum, pr) => sum + weightOf(pr.lines), 0);
  return {
    today,
    pace: (weighted * 7) / 30,
    count: prs.length,
    median: medianLines(prs),
  };
}

/**
 * "1" for "1.4.2" – the major version a PR pace line carries, and the one
 * `pace --from` requires a saved scan to share.
 * @param {string} version
 */
export function majorOf(version) {
  return version.split(".")[0];
}

/**
 * Why `pace --from` refuses a saved scan written by another major, or null
 * when the scan's major is the running one. A scan without a version came
 * from 1.0.x, the only releases that wrote none, so it reads as major 1
 * whichever version runs it.
 * @param {string} file
 * @param {string | undefined} scanVersion
 * @param {string} version the running package version
 * @returns {string | null}
 */
export function versionRefusal(file, scanVersion, version) {
  const major = scanVersion === undefined ? "1" : majorOf(scanVersion);
  if (major === majorOf(version)) return null;
  const scanned = scanVersion ?? "1.0.x, before scans recorded their version";
  return `${file} was scanned with pr-pace ${scanned}, and this is pr-pace ${version} – a PR pace line must come from one major version's rules, so run pr-pace pace afresh, or print it with that version: npx pr-pace@${major} pace --from ${file}`;
}

/**
 * The one line to post: PR pace 69.1/wk · 30 days to 2026-10-19 · 100 PRs ·
 * median 500 lines · pr-pace v1.
 * @param {import('./scan.js').ScanResult} scan
 * @param {string} version the package version, of which the line carries the
 * major
 */
export function paceLine(scan, version) {
  const { today, pace, count, median } = paceOf(scan);
  const lines = median === null ? null : Math.round(median);
  return [
    `PR pace ${pace.toFixed(1)}/wk`,
    `30 days to ${today}`,
    `${count} PR${count === 1 ? "" : "s"}`,
    lines === null
      ? "median –"
      : `median ${lines} line${lines === 1 ? "" : "s"}`,
    `pr-pace v${majorOf(version)}`,
  ].join(" · ");
}

/**
 * `pace --all-authors`: for each author with a PR merged in the window,
 * reverted and revert PRs included, `Name <email>`, a tab, then the line
 * `paceLine` gives for their PRs alone – see "PR pace" in docs/specs/v1.md.
 * Authors are keyed and labelled as the report's legend has them. Ordered by
 * label rather than pace, so the lines don't read as a ranking.
 * @param {import('./scan.js').ScanResult} scan
 * @param {string} version
 * @returns {string[]}
 */
export function authorPaceLines(scan, version) {
  const names = latestNames(
    scan.prs.map((pr) => ({
      authorKey: pr.author_email.toLowerCase(),
      author_name: pr.author_name,
    })),
  );
  /** @type {Map<string, { label: string, prs: import('./scan.js').PrResult[] }>} */
  const authors = new Map();
  for (const pr of scan.prs) {
    const key = pr.author_email.toLowerCase();
    const author = authors.get(key) ?? {
      label: `${names.get(key)} <${pr.author_email}>`,
      prs: [],
    };
    author.prs.push(pr);
    authors.set(key, author);
  }
  const { holds } = windowOf(scan);
  // By code unit, as localeCompare varies with the machine's locale.
  const compare = (/** @type {string} */ a, /** @type {string} */ b) =>
    a < b ? -1 : a > b ? 1 : 0;
  return [...authors]
    .filter(([, author]) => author.prs.some(holds))
    .sort(
      ([keyA, a], [keyB, b]) =>
        compare(a.label.toLowerCase(), b.label.toLowerCase()) ||
        compare(keyA, keyB),
    )
    .map(
      ([, author]) =>
        `${author.label}\t${paceLine({ ...scan, prs: author.prs }, version)}`,
    );
}
