import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderReport } from "../src/report.js";
import {
  assignSeries,
  chartModel,
  loadView,
  presetRange,
  previousRange,
  totalsOf,
} from "../src/report/client.js";

let shaCounter = 0;

/**
 * @param {Partial<import('../src/report/client.js').Row>} fields
 * @returns {import('../src/report/client.js').Row}
 */
function row(fields) {
  return {
    repo: "app",
    sha: String(++shaCounter).padStart(40, "0"),
    number: 1,
    title: "A PR",
    method: "squash",
    author_name: "Dev One",
    author_email: "dev@example.com",
    merged_at: "2026-10-05T10:00:00+00:00",
    added: 0,
    removed: 0,
    lines: 10,
    excluded_lines: 0,
    score: 3.16,
    is_revert: false,
    reverted_by: null,
    day: "2026-10-05",
    authorKey: "dev@example.com",
    ...fields,
  };
}

describe("report figures", () => {
  test("totals leave out revert PRs and count reverted originals", () => {
    const totals = totalsOf([
      row({ lines: 10, score: 3.16 }),
      row({ lines: 4, score: 2, reverted_by: "abc" }),
      row({ lines: 100, score: 10, is_revert: true }),
    ]);
    assert.deepEqual(totals, { count: 2, lines: 14, score: 5.16, reverted: 1 });
  });

  test("each column's parts add up to its total, and revert rate is reverted ÷ PRs", () => {
    const rows = [
      row({ day: "2026-10-05", repo: "a", lines: 10 }),
      row({ day: "2026-10-06", repo: "b", lines: 5, reverted_by: "x" }),
      row({ day: "2026-10-06", repo: "b", lines: 1, is_revert: true }),
      row({ day: "2026-10-13", repo: "a", lines: 7 }),
    ];
    const series = assignSeries(
      rows,
      (r) => r.repo,
      (r) => r.repo,
    );
    const seriesOf = (/** @type {import('../src/report/client.js').Row} */ r) =>
      series.get(r.repo) ?? {
        key: "__other",
        label: "Other",
        colour: "",
        rank: Infinity,
      };
    const keys = ["2026-10-05", "2026-10-12"];
    const lines = chartModel(rows, keys, "week", "lines", seriesOf);
    assert.deepEqual(
      lines.columns.map((c) => c.value),
      [15, 7],
    );
    for (const column of lines.columns) {
      assert.equal(
        column.parts.reduce((sum, part) => sum + (part.value ?? 0), 0),
        column.value,
      );
    }
    const reverts = chartModel(rows, keys, "week", "reverts", null);
    assert.deepEqual(
      reverts.columns.map((c) => c.value),
      [0.5, 0],
    );
    assert.equal(reverts.columns[0].rows.filter((r) => !r.is_revert).length, 2);
  });

  test("the moving average covers four periods, pooling them for revert rate", () => {
    const rows = [
      row({ day: "2026-10-01" }),
      row({ day: "2026-10-02", reverted_by: "x" }),
      row({ day: "2026-10-02" }),
      row({ day: "2026-10-04" }),
      row({ day: "2026-10-05" }),
    ];
    const keys = [
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
    ];
    const prs = chartModel(rows, keys, "day", "prs", null);
    assert.deepEqual(
      prs.columns.map((c) => c.average),
      [null, null, null, 1, 1],
    );
    const reverts = chartModel(rows, keys, "day", "reverts", null);
    assert.deepEqual(
      reverts.columns.map((c) => c.average),
      [null, null, null, 0.25, 0.25],
    );
  });

  test("a remembered custom range that misses this report's data falls back to the default", () => {
    /** @type {import('../src/report/client.js').View} */
    const defaults = {
      preset: "12m",
      from: "2025-10-18",
      to: "2026-10-17",
      period: "week",
      metric: "prs",
      split: "none",
      hiddenRepos: [],
    };
    const bounds = { firstDay: "2026-01-01", endDay: "2026-10-17" };
    /** @param {object} saved */
    const load = (saved) => {
      Object.assign(globalThis, {
        localStorage: { getItem: () => JSON.stringify(saved) },
      });
      try {
        return loadView(defaults, false, bounds);
      } finally {
        Reflect.deleteProperty(globalThis, "localStorage");
      }
    };
    const custom = { preset: "custom", from: "2026-02-01", to: "2026-02-28" };
    assert.equal(load(custom).preset, "custom");
    assert.equal(
      load({ ...custom, from: "2024-01-01", to: "2024-02-01" }).preset,
      "12m",
    );
    assert.equal(
      load({ ...custom, from: "2027-01-01", to: "2027-02-01" }).preset,
      "12m",
    );
    assert.equal(load({ split: "author" }).split, "none");
  });

  test("presets count back from the scan's run time, and the previous range has equal length", () => {
    const bounds = {
      generatedDay: "2026-10-17",
      firstDay: "2025-01-01",
      endDay: "2026-10-17",
    };
    assert.deepEqual(presetRange("30d", bounds), {
      from: "2026-09-18",
      to: "2026-10-17",
    });
    assert.deepEqual(presetRange("90d", bounds), {
      from: "2026-07-20",
      to: "2026-10-17",
    });
    assert.deepEqual(presetRange("12m", bounds), {
      from: "2025-10-18",
      to: "2026-10-17",
    });
    assert.deepEqual(presetRange("all", bounds), {
      from: "2025-01-01",
      to: "2026-10-17",
    });
    assert.deepEqual(previousRange({ from: "2026-09-18", to: "2026-10-17" }), {
      from: "2026-08-19",
      to: "2026-09-17",
    });
  });

  test("series colours follow the entity, folding past eight into Other", () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      Array.from({ length: 9 - i }, () => row({ repo: `repo-${i}` })),
    ).flat();
    const series = assignSeries(
      rows,
      (r) => r.repo,
      (r) => r.repo,
    );
    assert.equal(series.size, 7);
    assert.equal(series.get("repo-0")?.colour, "var(--series-1)");
    assert.equal(series.get("repo-7"), undefined);
  });
});

describe("HTML report", () => {
  /** @type {import('../src/scan.js').ScanResult} */
  const scan = {
    generated_at: "2026-10-17T21:00:00+01:00",
    options: {
      authors: ["dev@example.com"],
      all_authors: false,
      include_docs: false,
      since: null,
      until: null,
      timezone: "Europe/London",
    },
    repos: [],
    prs: [
      {
        ...row({
          title: 'Fix </script><script>alert(1)</script> "$&" /*SCRIPT*/',
        }),
      },
    ],
  };
  const html = renderReport(scan);

  test("embeds the scan so that titles can't break out of the data block", () => {
    const match =
      /<script type="application\/json" id="scan-data">([\s\S]*?)<\/script>/.exec(
        html,
      );
    assert.ok(match);
    assert.deepEqual(JSON.parse(match[1]), JSON.parse(JSON.stringify(scan)));
    assert.equal(html.match(/<\/script>/g)?.length, 2);
  });

  test("makes no external requests and carries a script that parses", () => {
    assert.doesNotMatch(
      html,
      /<script[^>]+src=|<link\b(?![^>]*href="data:)|@import|url\(|fetch\(|XMLHttpRequest|import\(/,
    );
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    assert.match(script, /function main\(scan\)/);
    assert.doesNotThrow(() => new Function(script));
  });
});
