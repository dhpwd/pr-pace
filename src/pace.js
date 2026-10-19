import { medianLines, presetRange, weightOf } from "./report/client.js";
import { addDays, dayOf, startOfDay, zoneFormatter } from "./time.js";

/**
 * @typedef {{ today: string, pace: number, count: number, median: number | null }} Pace
 */

/**
 * PR pace over the 30 days to the scan's run day – see "PR pace" in
 * docs/specs/v1.md. Taking the run day from `generated_at` gives a saved scan
 * the same figure whenever it's read.
 * @param {import('./scan.js').ScanResult} scan
 * @returns {Pace}
 */
export function paceOf(scan) {
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
  const prs = scan.prs.filter((pr) => {
    const merged = Date.parse(pr.merged_at);
    return (
      pr.is_revert === false &&
      pr.reverted_by === null &&
      merged >= from &&
      merged < to
    );
  });
  const weighted = prs.reduce((sum, pr) => sum + weightOf(pr.lines), 0);
  return {
    today,
    pace: (weighted * 7) / 30,
    count: prs.length,
    median: medianLines(prs),
  };
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
    `pr-pace v${version.split(".")[0]}`,
  ].join(" · ");
}
