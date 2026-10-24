import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, test } from "node:test";
import {
  authorPaceLines,
  paceLine,
  paceOf,
  versionRefusal,
} from "../src/pace.js";

/** The form every share line takes. */
const LINE =
  /^PR pace \d+\.\d\/wk · 30 days to \d{4}-\d{2}-\d{2} · \d+ PRs? · median (\d+ lines?|–) · pr-pace v\d+$/;

let shaCounter = 0;

/**
 * A PR merged on the run day unless it says otherwise.
 * @param {Partial<import('../src/scan.js').PrResult>} fields
 * @returns {import('../src/scan.js').PrResult}
 */
function pr(fields) {
  return {
    repo: "app",
    sha: String(++shaCounter).padStart(40, "0"),
    number: shaCounter,
    title: "A PR",
    method: "squash",
    author_name: "Dev One",
    author_email: "dev@example.com",
    agent_email: null,
    merged_at: "2026-10-19T08:00:00-04:00",
    added: 100,
    removed: 0,
    lines: 100,
    excluded_lines: 0,
    weighted_prs: 1,
    is_revert: false,
    reverted_by: null,
    ...fields,
  };
}

/**
 * A scan run at 09:00 on Monday 19th October 2026 in New York.
 * @param {import('../src/scan.js').PrResult[]} prs
 * @returns {import('../src/scan.js').ScanResult}
 */
function scanOf(prs) {
  return {
    generated_at: "2026-10-19T09:00:00-04:00",
    options: {
      authors: ["dev@example.com"],
      all_authors: false,
      include_docs: false,
      exclude: [],
      since: null,
      until: null,
      timezone: "America/New_York",
    },
    repos: [],
    prs,
  };
}

describe("PR pace", () => {
  test("covers the 30 days to the run day in the scan's timezone, both ends included", () => {
    const scan = scanOf([
      // 03:59 UTC on 20th September: inside the window in UTC, not here.
      pr({ merged_at: "2026-09-19T23:59:00-04:00" }),
      pr({ merged_at: "2026-09-20T00:00:00-04:00" }),
      pr({ merged_at: "2026-09-20T23:30:00-04:00" }),
      pr({ merged_at: "2026-10-19T08:00:00-04:00" }),
      pr({ merged_at: "2026-10-20T00:00:00-04:00" }),
    ]);
    const pace = paceOf(scan);
    assert.equal(pace.today, "2026-10-19");
    assert.equal(pace.count, 3);
    assert.equal(
      paceLine(scan, "1.0.0"),
      "PR pace 0.7/wk · 30 days to 2026-10-19 · 3 PRs · median 100 lines · pr-pace v1",
    );
  });

  test("gives the same lines whatever TZ the process runs under, per author too", () => {
    const scan = scanOf([
      pr({
        author_name: "Old Timer",
        author_email: "old@example.com",
        merged_at: "2026-09-19T23:59:00-04:00",
      }),
      pr({ merged_at: "2026-09-20T00:00:00-04:00", lines: 400 }),
      pr({ merged_at: "2026-10-19T08:00:00-04:00", lines: 0 }),
    ]);
    const script = `
      import { authorPaceLines, paceLine } from ${JSON.stringify(new URL("../src/pace.js", import.meta.url).href)};
      const scan = ${JSON.stringify(scan)};
      console.log(paceLine(scan, "1.0.0"));
      console.log(authorPaceLines(scan, "1.0.0").join("\\n"));
    `;
    const outputs = [
      "UTC",
      "America/Los_Angeles",
      "Asia/Kolkata",
      "Pacific/Kiritimati",
    ].map((tz) =>
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, TZ: tz },
        encoding: "utf8",
      }),
    );
    for (const output of outputs) assert.equal(output, outputs[0]);
    assert.equal(
      outputs[0],
      "PR pace 0.5/wk · 30 days to 2026-10-19 · 2 PRs · median 200 lines · pr-pace v1\n" +
        "Dev One <dev@example.com>\tPR pace 0.5/wk · 30 days to 2026-10-19 · 2 PRs · median 200 lines · pr-pace v1\n",
    );
  });

  test("reverted PRs and revert PRs count zero, and docs-only PRs count with no weight", () => {
    const scan = scanOf([
      pr({ lines: 400 }),
      pr({ lines: 900, reverted_by: "a".repeat(40) }),
      pr({ lines: 900, is_revert: true }),
      pr({ lines: 0 }),
    ]);
    assert.deepEqual(paceOf(scan), {
      today: "2026-10-19",
      pace: (2 * 7) / 30,
      count: 2,
      median: 200,
    });
    assert.equal(
      paceLine(scan, "1.0.0"),
      "PR pace 0.5/wk · 30 days to 2026-10-19 · 2 PRs · median 200 lines · pr-pace v1",
    );
  });

  test("is size-weighted PRs × 7 ÷ 30 from lines, not the scan's rounded field, to one decimal", () => {
    const rounded = Array.from({ length: 300 }, () =>
      pr({ lines: 154, weighted_prs: 1.241 }),
    );
    assert.ok(
      Math.abs(
        paceOf(scanOf(rounded)).pace - (300 * Math.sqrt(1.54) * 7) / 30,
      ) < 1e-9,
    );

    // Weights 4 × 5 = 20 give 4.667, and 1 × 10 = 10 give 2.333.
    const up = Array.from({ length: 5 }, () => pr({ lines: 1600 }));
    assert.match(paceLine(scanOf(up), "1.0.0"), /^PR pace 4\.7\/wk · /);
    const down = Array.from({ length: 10 }, () => pr({ lines: 100 }));
    assert.match(paceLine(scanOf(down), "1.0.0"), /^PR pace 2\.3\/wk · /);
  });

  test("rounds the median to whole lines, half up", () => {
    const line = paceLine(
      scanOf([pr({ lines: 0 }), pr({ lines: 417 })]),
      "1.0.0",
    );
    assert.match(line, / · 2 PRs · median 209 lines · /);
  });

  test("an empty window still gives a line, with no median", () => {
    assert.equal(
      paceLine(
        scanOf([pr({ merged_at: "2026-09-19T12:00:00-04:00" })]),
        "1.0.0",
      ),
      "PR pace 0.0/wk · 30 days to 2026-10-19 · 0 PRs · median – · pr-pace v1",
    );
  });

  test("says 1 PR and 1 line, and carries only the major version", () => {
    const line = paceLine(scanOf([pr({ lines: 1 })]), "0.1.0");
    assert.equal(
      line,
      "PR pace 0.0/wk · 30 days to 2026-10-19 · 1 PR · median 1 line · pr-pace v0",
    );
    assert.match(paceLine(scanOf([]), "12.3.4"), / · pr-pace v12$/);
  });

  test("every line takes the share-line form", () => {
    const scans = [
      scanOf([]),
      scanOf([pr({ lines: 1 })]),
      scanOf(Array.from({ length: 300 }, () => pr({ lines: 2000 }))),
    ];
    for (const scan of scans) assert.match(paceLine(scan, "1.0.0"), LINE);
  });
});

describe("PR pace per author", () => {
  test("gives each author with a PR in the window a labelled line, ordered by lowercased label by code unit", () => {
    const amy = { author_name: "amy lower", author_email: "Amy@Example.com" };
    const bob = { author_name: "Bob Upper", author_email: "bob@example.com" };
    const zed = { author_name: "Zed Last", author_email: "zed@example.com" };
    // After z by code unit, where localeCompare would put it among the e's.
    const emile = {
      author_name: "Émile Accent",
      author_email: "emile@example.com",
    };
    const lines = authorPaceLines(
      scanOf([
        pr({ ...zed, lines: 400 }),
        pr({ ...amy, lines: 100 }),
        pr({ ...emile, lines: 900 }),
        pr({ ...bob, lines: 0 }),
        pr({ ...amy, author_email: "amy@example.com", lines: 1600 }),
      ]),
      "1.0.0",
    );
    assert.deepEqual(lines, [
      "amy lower <Amy@Example.com>\tPR pace 1.2/wk · 30 days to 2026-10-19 · 2 PRs · median 850 lines · pr-pace v1",
      "Bob Upper <bob@example.com>\tPR pace 0.0/wk · 30 days to 2026-10-19 · 1 PR · median 0 lines · pr-pace v1",
      "Zed Last <zed@example.com>\tPR pace 0.5/wk · 30 days to 2026-10-19 · 1 PR · median 400 lines · pr-pace v1",
      "Émile Accent <emile@example.com>\tPR pace 0.7/wk · 30 days to 2026-10-19 · 1 PR · median 900 lines · pr-pace v1",
    ]);
    for (const line of lines) assert.match(line.split("\t")[1], LINE);
  });

  test("labels an author with their latest name over the whole scan and the email on their first PR", () => {
    const lines = authorPaceLines(
      scanOf([
        pr({
          author_name: "Dev Before",
          author_email: "Dev@Example.com",
          merged_at: "2026-08-03T12:00:00-04:00",
        }),
        pr({ author_name: "Dev During", author_email: "dev@example.com" }),
        pr({
          author_name: "Dev After",
          author_email: "DEV@example.com",
          merged_at: "2026-10-20T00:00:00-04:00",
        }),
      ]),
      "1.0.0",
    );
    assert.deepEqual(lines, [
      "Dev After <Dev@Example.com>\tPR pace 0.2/wk · 30 days to 2026-10-19 · 1 PR · median 100 lines · pr-pace v1",
    ]);
  });

  test("a tab in an author's name shows as a space, so the first tab always ends the label", () => {
    const lines = authorPaceLines(
      scanOf([
        pr({ author_name: "Dev\tTab", author_email: "tab@example.com" }),
      ]),
      "1.0.0",
    );
    assert.deepEqual(lines, [
      "Dev Tab <tab@example.com>\tPR pace 0.2/wk · 30 days to 2026-10-19 · 1 PR · median 100 lines · pr-pace v1",
    ]);
  });

  test("an author under two addresses that .mailmap doesn't join gets a line for each", () => {
    const lines = authorPaceLines(
      scanOf([
        pr({ author_email: "dev@example.com", lines: 400 }),
        pr({ author_email: "dev@work.example.com", lines: 100 }),
      ]),
      "1.0.0",
    );
    assert.deepEqual(lines, [
      "Dev One <dev@example.com>\tPR pace 0.5/wk · 30 days to 2026-10-19 · 1 PR · median 400 lines · pr-pace v1",
      "Dev One <dev@work.example.com>\tPR pace 0.2/wk · 30 days to 2026-10-19 · 1 PR · median 100 lines · pr-pace v1",
    ]);
  });

  test("an author whose only PR in the window was reverted, or is a revert, gets a zero line, and one with none in the window gets no line", () => {
    const lines = authorPaceLines(
      scanOf([
        // 03:59 UTC on 20th September: inside the window in UTC, not here.
        pr({
          author_name: "Old Timer",
          author_email: "old@example.com",
          merged_at: "2026-09-19T23:59:00-04:00",
        }),
        pr({
          author_name: "Reverted Author",
          author_email: "reverted@example.com",
          lines: 400,
          reverted_by: "a".repeat(40),
        }),
        pr({
          author_name: "Revert Author",
          author_email: "revert@example.com",
          lines: 400,
          is_revert: true,
        }),
      ]),
      "1.0.0",
    );
    assert.deepEqual(lines, [
      "Revert Author <revert@example.com>\tPR pace 0.0/wk · 30 days to 2026-10-19 · 0 PRs · median – · pr-pace v1",
      "Reverted Author <reverted@example.com>\tPR pace 0.0/wk · 30 days to 2026-10-19 · 0 PRs · median – · pr-pace v1",
    ]);
  });

  test("an empty window gives no lines", () => {
    assert.deepEqual(authorPaceLines(scanOf([]), "1.0.0"), []);
    assert.deepEqual(
      authorPaceLines(
        scanOf([pr({ merged_at: "2026-09-19T12:00:00-04:00" })]),
        "1.0.0",
      ),
      [],
    );
  });
});

describe("pace --from's version refusal", () => {
  test("refuses another major's scan, reading one without a version as 1.0.x whatever the running major", () => {
    assert.equal(
      versionRefusal("s.json", undefined, "2.0.0"),
      "s.json was scanned with pr-pace 1.0.x, before scans recorded their version, and this is pr-pace 2.0.0 – a PR pace line must come from one major version's rules, so run pr-pace pace afresh, or print it with that version: npx pr-pace@1 pace --from s.json",
    );
    assert.equal(
      versionRefusal("s.json", "1.4.2", "2.0.0"),
      "s.json was scanned with pr-pace 1.4.2, and this is pr-pace 2.0.0 – a PR pace line must come from one major version's rules, so run pr-pace pace afresh, or print it with that version: npx pr-pace@1 pace --from s.json",
    );
    assert.equal(versionRefusal("s.json", "2.3.4", "2.0.0"), null);
    assert.equal(versionRefusal("s.json", undefined, "1.4.2"), null);
  });
});
