import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderReport } from "../src/report.js";
import {
  assignSeries,
  chartModel,
  formatMetric,
  loadView,
  metaLine,
  niceTicks,
  presetRange,
  previousRange,
  saveView,
  totalsOf,
  viewKey,
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
    weighted_prs: 0.316,
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
      row({ lines: 100 }),
      row({ lines: 400, reverted_by: "abc" }),
      row({ lines: 900, is_revert: true }),
    ]);
    assert.deepEqual(totals, {
      count: 2,
      weighted: 3,
      median: 250,
      lines: 500,
      reverted: 1,
    });
  });

  test("weighted PRs sum √(lines ÷ 100) from lines, not the scan's rounded field", () => {
    const rows = Array.from({ length: 300 }, () =>
      row({ lines: 154, weighted_prs: 1.241 }),
    );
    const weighted = totalsOf(rows).weighted;
    assert.ok(Math.abs(weighted - 300 * Math.sqrt(1.54)) < 1e-9);
    assert.equal(formatMetric(weighted, "weighted"), "372.29");
    assert.equal(formatMetric(1, "weighted"), "1.00");
  });

  test("median PR size: even counts, gaps, pooled averages, docs-only PRs and series side by side", () => {
    const rows = [
      row({ day: "2026-10-01", repo: "a", lines: 10 }),
      row({ day: "2026-10-01", repo: "b", lines: 30 }),
      row({ day: "2026-10-02", repo: "a", lines: 0 }),
      row({ day: "2026-10-02", repo: "a", lines: 5 }),
      row({ day: "2026-10-02", repo: "b", lines: 100, reverted_by: "x" }),
      row({ day: "2026-10-02", repo: "b", lines: 1000, is_revert: true }),
      row({ day: "2026-10-04", repo: "a", lines: 7 }),
      row({ day: "2026-10-05", repo: "a", lines: 1 }),
    ];
    const keys = [
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
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
    const median = chartModel(rows, keys, "day", "median", seriesOf);
    // The docs-only PR counts at 0 lines, and the revert PR is left out.
    assert.deepEqual(
      median.columns.map((c) => c.value),
      [20, 5, null, 7, 1],
    );
    assert.deepEqual(
      median.columns[0].parts.map((p) => p.value),
      [10, 30],
    );
    // The median of every PR across the four periods, not of their medians.
    assert.deepEqual(
      median.columns.map((c) => c.average),
      [null, null, null, 8.5, 5],
    );
    // The range's median is over all its PRs, not an average of periods.
    assert.equal(totalsOf(rows).median, 7);
    assert.equal(totalsOf([]).median, null);
    assert.equal(formatMetric(8.5, "median"), "9");
    assert.equal(formatMetric(208.5, "median"), "209");
    assert.equal(formatMetric(null, "median"), "–");
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
        return loadView("key", defaults, false, bounds);
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
    assert.equal(load({ metric: "score" }).metric, "prs");
  });

  test("controls are remembered per set of scanned repos", () => {
    /** @type {Map<string, string>} */
    const stored = new Map();
    Object.assign(globalThis, {
      localStorage: {
        getItem: (/** @type {string} */ key) => stored.get(key) ?? null,
        setItem: (/** @type {string} */ key, /** @type {string} */ value) =>
          stored.set(key, value),
      },
    });
    /** @param {string[]} names */
    const keyFor = (names) =>
      viewKey(
        /** @type {import('../src/scan.js').ScanResult} */ ({
          repos: names.map((name) => ({ name })),
        }),
      );
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
    try {
      saveView(keyFor(["app", "api"]), { ...defaults, hiddenRepos: ["app"] });
      const load = (/** @type {string[]} */ names) =>
        loadView(keyFor(names), defaults, false, bounds).hiddenRepos;
      assert.deepEqual(load(["api", "app"]), ["app"]);
      assert.deepEqual(load(["app", "web"]), []);
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("axis ticks never repeat a label", () => {
    for (const metric of /** @type {const} */ ([
      "prs",
      "weighted",
      "median",
      "lines",
      "reverts",
    ])) {
      for (const max of [
        0.004, 0.012, 0.02, 0.03, 0.07, 0.15, 0.3, 0.5, 1, 1.5, 3, 7, 208.5,
      ]) {
        if (metric === "reverts" && max > 1) continue;
        // Every bar is a whole number of lines, so a chart's largest is 0 or 1+.
        if (metric === "lines" && max < 1) continue;
        const { step, max: top } = niceTicks(max, metric);
        // PRs and median PR size never tick on a fraction.
        if (metric === "prs" || metric === "median") {
          assert.ok(Number.isInteger(step), `${metric} ${max}`);
        }
        const labels = [];
        for (let value = 0; value <= top + 1e-9; value += step) {
          labels.push(formatMetric(value, metric, true));
        }
        assert.equal(new Set(labels).size, labels.length, `${metric} ${max}`);
      }
    }
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
      exclude: [],
      since: null,
      until: null,
      timezone: "Europe/London",
    },
    repos: [
      {
        name: "app",
        path: "/home/someone/code/app",
        branch: "origin/main",
        prs: 1,
        direct_commits_ignored: 0,
        warnings: ["git fetch failed (/home/someone/code/app) – scanned"],
      },
    ],
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
    const { path, warnings, ...repo } = scan.repos[0];
    assert.deepEqual(
      JSON.parse(match[1]),
      JSON.parse(JSON.stringify({ ...scan, repos: [repo] })),
    );
    assert.equal(html.match(/<\/script>/g)?.length, 2);
  });

  test("leaves repos' paths and warnings out of the embedded scan", () => {
    assert.doesNotMatch(html, /someone/);
  });

  test("the header names the authors and every exclusion", () => {
    const line = (/** @type {Partial<typeof scan.options>} */ options) =>
      metaLine(
        { ...scan, options: { ...scan.options, ...options } },
        "2026-10-17",
      );
    assert.match(
      line({}),
      /dev@example\.com · .* lines leave out docs, lockfiles and generated files$/,
    );
    assert.match(
      line({ include_docs: true, exclude: ["*.snap", "src/gen"] }),
      /lines leave out lockfiles, generated files, "\*\.snap" and "src\/gen"$/,
    );
    assert.match(
      line({ authors: [] }),
      /no PRs counted, as no repo that could be scanned has git user\.email set/,
    );
    const skipped = scan.repos.map((repo) => ({ ...repo, branch: null }));
    assert.match(
      metaLine(
        { ...scan, repos: skipped, options: { ...scan.options, authors: [] } },
        "2026-10-17",
      ),
      /no PRs counted, as no repo could be scanned – the scan's warnings say why/,
    );
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
