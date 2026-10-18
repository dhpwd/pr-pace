// The report's browser code, inlined into the page with ../time.js – see
// "Implementation constraints" in docs/specs/v1.md.
import {
  addDays,
  addMonths,
  dayOf,
  daysBetween,
  isDay,
  parseDay,
  periodOf,
  periodsBetween,
  zoneFormatter,
} from "../time.js";

/**
 * @typedef {import('../scan.js').ScanResult} ScanResult
 * @typedef {import('../scan.js').PrResult} PrResult
 * @typedef {import('../time.js').Period} Period
 * @typedef {'prs' | 'weighted' | 'median' | 'lines' | 'reverts'} Metric
 * @typedef {'none' | 'repo' | 'author'} Split
 * @typedef {'30d' | '90d' | '12m' | 'all' | 'custom'} Preset
 * @typedef {PrResult & { day: string, authorKey: string }} Row
 * @typedef {{ from: string, to: string }} Range
 * @typedef {{ preset: Preset, from: string, to: string, period: Period, metric: Metric, split: Split, hiddenRepos: string[] }} View
 * @typedef {{ key: string, label: string, colour: string, rank: number }} Series rank orders series, "Other" last
 * @typedef {{ count: number, weighted: number, median: number | null, lines: number, reverted: number }} Totals
 * @typedef {{ series: Series, totals: Totals, value: number | null }} Part
 * @typedef {{ key: string, rows: Row[], totals: Totals, value: number | null, parts: Part[], average: number | null }} Column
 */

/**
 * A PR's size-weighted count, from its lines rather than the scan's rounded
 * `weighted_prs` – see "Lines changed" in docs/specs/v1.md.
 * @param {number} lines
 */
export function weightOf(lines) {
  return Math.sqrt(lines / 100);
}

/**
 * The median of the counted PRs' lines, or null when there are none.
 * @param {Row[]} rows
 * @returns {number | null}
 */
export function medianLines(rows) {
  const sizes = rows
    .filter((row) => !row.is_revert)
    .map((row) => row.lines)
    .sort((a, b) => a - b);
  if (sizes.length === 0) return null;
  const mid = Math.floor(sizes.length / 2);
  return sizes.length % 2 === 1
    ? sizes[mid]
    : (sizes[mid - 1] + sizes[mid]) / 2;
}

/**
 * Totals over the counted PRs: revert PRs are left out of every figure.
 * @param {Row[]} rows
 * @returns {Totals}
 */
export function totalsOf(rows) {
  const totals = {
    count: 0,
    weighted: 0,
    median: medianLines(rows),
    lines: 0,
    reverted: 0,
  };
  for (const row of rows) {
    if (row.is_revert) continue;
    totals.count++;
    totals.weighted += weightOf(row.lines);
    totals.lines += row.lines;
    if (row.reverted_by) totals.reverted++;
  }
  return totals;
}

/**
 * @param {Totals} totals
 * @param {Metric} metric
 * @returns {number | null}
 */
export function metricOf(totals, metric) {
  if (metric === "prs") return totals.count;
  if (metric === "weighted") return totals.weighted;
  if (metric === "median") return totals.median;
  if (metric === "lines") return totals.lines;
  return totals.count === 0 ? null : totals.reverted / totals.count;
}

/**
 * Presets count back from when the scan ran, so a saved report always shows
 * the same numbers.
 * @param {Preset} preset
 * @param {{ generatedDay: string, firstDay: string, endDay: string }} bounds
 * @returns {Range}
 */
export function presetRange(preset, bounds) {
  const to = bounds.generatedDay;
  if (preset === "30d") return { from: addDays(to, -29), to };
  if (preset === "90d") return { from: addDays(to, -89), to };
  if (preset === "12m") return { from: addDays(addMonths(to, -12), 1), to };
  return { from: bounds.firstDay, to: bounds.endDay };
}

/**
 * The range of equal length just before `range`.
 * @param {Range} range
 * @returns {Range}
 */
export function previousRange(range) {
  const length = daysBetween(range.from, range.to) + 1;
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) };
}

/**
 * Colours follow the entity, not the current filter. Up to eight entities get
 * a hue each by PR count over the whole scan. Past eight, the top seven do and
 * the rest share "Other".
 * @param {Row[]} rows
 * @param {(row: Row) => string} keyOf
 * @param {(row: Row) => string} labelOf
 * @returns {Map<string, Series>}
 */
export function assignSeries(rows, keyOf, labelOf) {
  /** @type {Map<string, { key: string, label: string, count: number }>} */
  const counts = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const entry = counts.get(key) ?? { key, label: labelOf(row), count: 0 };
    if (!row.is_revert) entry.count++;
    counts.set(key, entry);
  }
  const ranked = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );
  const named = ranked.length <= 8 ? ranked : ranked.slice(0, 7);
  /** @type {Map<string, Series>} */
  const series = new Map();
  named.forEach((entry, i) => {
    series.set(entry.key, {
      key: entry.key,
      label: entry.label,
      colour: `var(--series-${i + 1})`,
      rank: i,
    });
  });
  return series;
}

/**
 * One column per period with its rows, per-series parts and the 4-period
 * moving average of the total. For revert rate and median PR size the average
 * pools the four periods: reverted ÷ PRs, or the median PR, across them.
 * @param {Row[]} rows
 * @param {string[]} periodKeys
 * @param {Period} period
 * @param {Metric} metric
 * @param {((row: Row) => Series) | null} seriesOf
 * @returns {{ columns: Column[], series: Series[] }}
 */
export function chartModel(rows, periodKeys, period, metric, seriesOf) {
  /** @type {Map<string, Row[]>} */
  const byPeriod = new Map(periodKeys.map((key) => [key, []]));
  for (const row of rows) byPeriod.get(periodOf(row.day, period))?.push(row);

  /** @type {Map<string, Series>} */
  const present = new Map();
  if (seriesOf) {
    for (const row of rows) {
      if (!row.is_revert) present.set(seriesOf(row).key, seriesOf(row));
    }
  }
  const series = [...present.values()].sort((a, b) => a.rank - b.rank);

  /** @type {Column[]} */
  const columns = periodKeys.map((key) => {
    const periodRows = byPeriod.get(key) ?? [];
    const totals = totalsOf(periodRows);
    const parts = series.map((s) => {
      const partTotals = totalsOf(
        periodRows.filter((row) => seriesOf && seriesOf(row).key === s.key),
      );
      return {
        series: s,
        totals: partTotals,
        value: metricOf(partTotals, metric),
      };
    });
    return {
      key,
      rows: periodRows,
      totals,
      value: metricOf(totals, metric),
      parts,
      average: null,
    };
  });

  columns.forEach((column, i) => {
    if (i < 3) return;
    const window = columns.slice(i - 3, i + 1);
    if (metric === "reverts") {
      const count = window.reduce((sum, c) => sum + c.totals.count, 0);
      const reverted = window.reduce((sum, c) => sum + c.totals.reverted, 0);
      column.average = count === 0 ? null : reverted / count;
    } else if (metric === "median") {
      column.average = medianLines(window.flatMap((c) => c.rows));
    } else {
      column.average = window.reduce((sum, c) => sum + (c.value ?? 0), 0) / 4;
    }
  });
  return { columns, series };
}

/**
 * @param {number} max
 * @param {Metric} metric
 * @returns {{ step: number, max: number }}
 */
export function niceTicks(max, metric) {
  if (!(max > 0))
    return metric === "reverts" ? { step: 0.25, max: 1 } : { step: 1, max: 4 };
  const rough = max / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const scaled = rough / power;
  let step = (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power;
  // Axis labels are whole numbers for PRs and median PR size, tenths for
  // weighted PRs and whole percent for revert rate.
  if ((metric === "prs" || metric === "median") && step < 1) step = 1;
  if (metric === "weighted" && step < 0.1) step = 0.1;
  if (metric === "reverts" && step < 0.01) step = 0.01;
  return { step, max: Math.ceil(max / step - 1e-9) * step };
}

/**
 * @param {number} n
 * @param {number} [decimals]
 */
export function formatNumber(n, decimals = 0) {
  return n.toLocaleString("en-GB", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * @param {number | null} value
 * @param {Metric} metric
 * @param {boolean} [compact] shorter form for axis ticks
 */
export function formatMetric(value, metric, compact = false) {
  if (value === null) return "–";
  if (metric === "reverts") {
    const pct = Math.round(value * 1000) / 10;
    return `${formatNumber(pct, compact || Number.isInteger(pct) ? 0 : 1)}%`;
  }
  if (compact && Math.abs(value) >= 1000) {
    const [divisor, suffix] = Math.abs(value) >= 1e6 ? [1e6, "M"] : [1e3, "K"];
    const short = value / divisor;
    return `${formatNumber(short, Number.isInteger(short) ? 0 : 1)}${suffix}`;
  }
  if (metric === "weighted" && !compact) return formatNumber(value, 2);
  // Whole lines, half up – see "HTML report" in docs/specs/v1.md.
  if (metric === "median" && !compact) return formatNumber(Math.round(value));
  return formatNumber(value, Number.isInteger(value) ? 0 : 1);
}

/** @param {number} month 1–12 */
export function monthName(month) {
  return "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[
    month - 1
  ];
}

/**
 * @param {string} day
 * @param {boolean} withYear
 */
export function dayLabel(day, withYear) {
  const [year, month, date] = parseDay(day);
  return `${date} ${monthName(month)}${withYear ? ` ${year}` : ""}`;
}

/**
 * @param {string} key
 * @param {Period} period
 * @param {boolean} short
 */
export function periodLabel(key, period, short) {
  if (period === "month") {
    const [year, month] = parseDay(`${key}-01`);
    return `${monthName(month)} ${year}`;
  }
  if (period === "week") {
    return short ? dayLabel(key, false) : `Week of ${dayLabel(key, true)}`;
  }
  return dayLabel(key, !short);
}

/**
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {(Node | string)[]} [children]
 */
export function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs))
    node.setAttribute(name, value);
  node.append(...children);
  return node;
}

/**
 * @param {string} tag
 * @param {Record<string, string | number>} [attrs]
 */
export function svg(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attrs)) {
    node.setAttribute(name, String(value));
  }
  return node;
}

/**
 * A bar with a rounded data end and a square baseline.
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {boolean} rounded
 */
export function barPath(x, y, width, height, rounded) {
  const r = rounded ? Math.min(4, width / 2, height) : 0;
  return (
    `M${x},${y + height}V${y + r}` +
    (r > 0 ? `A${r},${r} 0 0 1 ${x + r},${y}` : "") +
    `H${x + width - r}` +
    (r > 0 ? `A${r},${r} 0 0 1 ${x + width},${y + r}` : "") +
    `V${y + height}Z`
  );
}

/** @param {string} id */
export function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`report element #${id} is missing`);
  return node;
}

/**
 * The storage key for remembered controls, one per set of scanned repo names
 * – see "HTML report" in docs/specs/v1.md.
 * @param {ScanResult} scan
 */
export function viewKey(scan) {
  const names = scan.repos.map((repo) => repo.name).sort();
  return `pr-velocity:view:${JSON.stringify(names)}`;
}

/**
 * Remembered controls. Storage can be missing or throw (private windows,
 * file:// in some browsers), so every access is guarded.
 * A saved custom range that misses this report's data (one saved from an
 * earlier scan of the same repos, say) falls back to the default.
 * @param {string} key
 * @param {View} defaults
 * @param {boolean} allowAuthorSplit
 * @param {{ firstDay: string, endDay: string }} bounds
 * @returns {View}
 */
export function loadView(key, defaults, allowAuthorSplit, bounds) {
  /** @type {Partial<View>} */
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(key) ?? "{}") ?? {};
  } catch {
    return defaults;
  }
  const pick = (
    /** @type {unknown} */ value,
    /** @type {string[]} */ allowed,
  ) => (typeof value === "string" && allowed.includes(value) ? value : null);
  const view = {
    preset: /** @type {Preset} */ (
      pick(saved.preset, ["30d", "90d", "12m", "all", "custom"]) ??
        defaults.preset
    ),
    from: isDay(saved.from) ? saved.from : defaults.from,
    to: isDay(saved.to) ? saved.to : defaults.to,
    period: /** @type {Period} */ (
      pick(saved.period, ["day", "week", "month"]) ?? defaults.period
    ),
    metric: /** @type {Metric} */ (
      pick(saved.metric, ["prs", "weighted", "median", "lines", "reverts"]) ??
        defaults.metric
    ),
    split: /** @type {Split} */ (
      pick(
        saved.split,
        allowAuthorSplit ? ["none", "repo", "author"] : ["none", "repo"],
      ) ?? defaults.split
    ),
    hiddenRepos: Array.isArray(saved.hiddenRepos)
      ? saved.hiddenRepos.filter((name) => typeof name === "string")
      : [],
  };
  if (
    view.preset === "custom" &&
    (view.from > view.to ||
      view.to < bounds.firstDay ||
      view.from > bounds.endDay)
  ) {
    view.preset = defaults.preset;
  }
  return view;
}

/**
 * @param {string} key
 * @param {View} view
 */
export function saveView(key, view) {
  try {
    localStorage.setItem(key, JSON.stringify(view));
  } catch {
    // Storage unavailable: the report works, it just won't remember.
  }
}

/**
 * Draws the bar chart into `container` and wires hover, focus and click.
 * @param {HTMLElement} container
 * @param {HTMLElement} tooltip
 * @param {{ columns: Column[], series: Series[] }} model
 * @param {Period} period
 * @param {Metric} metric
 * @param {string | null} selected
 * @param {(key: string) => void} onSelect
 */
export function drawChart(
  container,
  tooltip,
  model,
  period,
  metric,
  selected,
  onSelect,
) {
  for (const node of [...container.children]) {
    if (node !== tooltip) node.remove();
  }
  tooltip.hidden = true;
  const { columns, series } = model;
  if (columns.every((column) => column.totals.count === 0)) {
    container.prepend(h("p", { class: "empty" }, ["No PRs in this range."]));
    return;
  }

  const width = Math.max(container.clientWidth, 280);
  const height = width < 600 ? 240 : 300;
  const margin = { top: 10, right: 8, bottom: 28, left: 44 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const slot = plotWidth / columns.length;
  // Rates don't stack, and series medians don't add up to the period's median.
  const sideBySide =
    (metric === "reverts" || metric === "median") && series.length > 0;

  let max = 0;
  for (const column of columns) {
    max = Math.max(max, column.value ?? 0, column.average ?? 0);
    if (sideBySide) {
      for (const part of column.parts) max = Math.max(max, part.value ?? 0);
    }
  }
  const ticks = niceTicks(max, metric);
  const y = (/** @type {number} */ value) =>
    margin.top + plotHeight - (value / ticks.max) * plotHeight;

  const root = svg("svg", {
    viewBox: `0 0 ${width} ${height}`,
    height,
    "aria-label": "Bar chart. The PR list below gives the same figures",
  });

  for (let value = 0; value <= ticks.max + 1e-9; value += ticks.step) {
    const ty = y(value);
    root.append(
      svg("line", {
        x1: margin.left,
        x2: width - margin.right,
        y1: ty,
        y2: ty,
        stroke: value === 0 ? "var(--axis)" : "var(--grid)",
        "stroke-width": 1,
        "shape-rendering": "crispEdges",
      }),
    );
    const label = svg("text", {
      x: margin.left - 6,
      y: ty + 4,
      "text-anchor": "end",
    });
    label.textContent = formatMetric(value, metric, true);
    root.append(label);
  }

  const labelWidth = (period === "month" ? 8 : 6) * 6.5 + 8;
  const labelEvery = Math.max(1, Math.ceil(labelWidth / slot));

  columns.forEach((column, i) => {
    const left = margin.left + i * slot;
    const centre = left + slot / 2;
    if (sideBySide) {
      const k = series.length;
      const groupWidth = Math.min(slot - 2, k * 24 + (k - 1) * 2);
      const barWidth = Math.max(1, (groupWidth - (k - 1) * 2) / k);
      column.parts.forEach((part, j) => {
        if (part.value === null || part.value === 0) return;
        const x = centre - groupWidth / 2 + j * (barWidth + 2);
        const top = y(part.value);
        root.append(
          svg("path", {
            d: barPath(x, top, barWidth, y(0) - top, barWidth >= 6),
            fill: part.series.colour,
          }),
        );
      });
    } else {
      const barWidth = Math.max(1, Math.min(24, slot - 2));
      const x = centre - barWidth / 2;
      const parts =
        series.length > 0
          ? column.parts
          : [
              {
                series: {
                  key: "total",
                  label: "",
                  colour: "var(--series-1)",
                  rank: 0,
                },
                value: column.value,
              },
            ];
      const drawn = parts.filter((part) => (part.value ?? 0) > 0);
      let base = 0;
      drawn.forEach((part, j) => {
        const value = part.value ?? 0;
        const bottom = y(base);
        const top = y(base + value);
        const gap = j > 0 ? Math.min(2, (bottom - top) / 2) : 0;
        const segmentHeight = bottom - top - gap;
        base += value;
        if (segmentHeight <= 0) return;
        root.append(
          svg("path", {
            d: barPath(
              x,
              top,
              barWidth,
              segmentHeight,
              j === drawn.length - 1 && barWidth >= 6,
            ),
            fill: part.series.colour,
          }),
        );
      });
    }
    if (i % labelEvery === 0) {
      const label = svg("text", {
        x: centre,
        y: height - 8,
        "text-anchor": "middle",
      });
      label.textContent = periodLabel(column.key, period, true);
      root.append(label);
    }
  });

  /** @type {string[]} */
  let segment = [];
  /** @type {string[][]} */
  const lines = [];
  columns.forEach((column, i) => {
    if (column.average === null) {
      if (segment.length > 0) lines.push(segment);
      segment = [];
      return;
    }
    segment.push(`${margin.left + i * slot + slot / 2},${y(column.average)}`);
  });
  if (segment.length > 0) lines.push(segment);
  for (const points of lines) {
    if (points.length === 1) {
      const [cx, cy] = points[0].split(",");
      root.append(svg("circle", { cx, cy, r: 3, fill: "var(--average)" }));
    } else {
      root.append(
        svg("polyline", {
          points: points.join(" "),
          fill: "none",
          stroke: "var(--average)",
          "stroke-width": 2,
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
        }),
      );
    }
  }

  const show = (/** @type {Column} */ column, /** @type {number} */ centre) => {
    tooltip.replaceChildren();
    tooltip.append(
      h("div", { class: "tt-head" }, [periodLabel(column.key, period, false)]),
    );
    const total =
      metric === "reverts"
        ? `${formatMetric(column.value, metric)} (${column.totals.reverted} of ${column.totals.count} PRs reverted)`
        : formatMetric(column.value, metric);
    tooltip.append(h("div", { class: "tt-total" }, [total]));
    for (const part of column.parts) {
      if (part.totals.count === 0) continue;
      const value =
        metric === "reverts"
          ? `${formatMetric(part.value, metric)} (${part.totals.reverted}/${part.totals.count})`
          : formatMetric(part.value, metric);
      tooltip.append(
        h("div", { class: "tt-row" }, [
          h("span", {
            class: "line-key",
            style: `background:${part.series.colour}`,
          }),
          part.series.label,
          h("strong", {}, [value]),
        ]),
      );
    }
    if (column.average !== null) {
      tooltip.append(
        h("div", { class: "tt-row" }, [
          h("span", { class: "line-key", style: "background:var(--average)" }),
          "4-period average",
          h("strong", {}, [formatMetric(column.average, metric)]),
        ]),
      );
    }
    tooltip.hidden = false;
    const tipWidth = tooltip.offsetWidth;
    const left =
      centre + 14 + tipWidth > width ? centre - 14 - tipWidth : centre + 14;
    tooltip.style.left = `${Math.max(0, left)}px`;
    tooltip.style.top = `${margin.top}px`;
  };

  columns.forEach((column, i) => {
    const left = margin.left + i * slot;
    const hit = svg("rect", {
      class: column.key === selected ? "hit selected" : "hit",
      x: left,
      y: margin.top,
      width: slot,
      height: plotHeight,
      tabindex: 0,
      role: "button",
      "data-period": column.key,
      "aria-label": `${periodLabel(column.key, period, false)}: ${formatMetric(column.value, metric)}. Select to list its PRs`,
    });
    hit.addEventListener("pointerenter", () => show(column, left + slot / 2));
    hit.addEventListener("pointerleave", () => {
      tooltip.hidden = true;
    });
    hit.addEventListener("focus", () => show(column, left + slot / 2));
    hit.addEventListener("blur", () => {
      tooltip.hidden = true;
    });
    hit.addEventListener("click", () => onSelect(column.key));
    hit.addEventListener("keydown", (event) => {
      const key = /** @type {KeyboardEvent} */ (event).key;
      if (key === "Enter" || key === " ") {
        event.preventDefault();
        onSelect(column.key);
      }
    });
    root.append(hit);
  });

  container.prepend(root);
}

/**
 * Lists a period's counted PRs, with totals that match its bar.
 * @param {Column | null} column
 * @param {Period} period
 * @param {Metric} metric
 * @param {boolean} showAuthor
 */
export function drawDetails(column, period, metric, showAuthor) {
  const title = byId("details-title");
  const summary = byId("details-summary");
  const table = byId("details-table");
  table.replaceChildren();
  if (!column) {
    title.textContent = "PRs";
    summary.textContent = "Click a bar to list the PRs behind it.";
    return;
  }
  const counted = column.rows.filter((row) => !row.is_revert);
  const reverts = column.rows.length - counted.length;
  const t = column.totals;
  title.textContent = `PRs merged ${period === "day" ? "on" : "in"} ${periodLabel(column.key, period, false).replace(/^Week/, "the week")}`;
  const present = column.parts.filter((part) => part.totals.count > 0);
  const bySeries = present.map(
    (part) =>
      `${part.series.label} ${part.totals.reverted} of ${part.totals.count}`,
  );
  const medianBySeries = present.map(
    (part) =>
      `${part.series.label} ${formatMetric(part.totals.median, "median")}`,
  );
  const prs = `${t.count} PR${t.count === 1 ? "" : "s"}`;
  const figures = {
    prs,
    weighted: `${prs} · ${formatNumber(t.weighted, 2)} weighted PRs`,
    median:
      t.median === null
        ? prs
        : `${prs} · median ${formatMetric(t.median, "median")} lines` +
          (medianBySeries.length > 0 ? ` (${medianBySeries.join(", ")})` : ""),
    lines: `${prs} · ${formatNumber(t.lines)} lines changed`,
    reverts:
      `${t.reverted} of ${prs} reverted = ${formatMetric(column.value, "reverts")}` +
      (bySeries.length > 0 ? ` (${bySeries.join(", ")})` : ""),
  };
  summary.textContent =
    figures[metric] +
    (reverts > 0
      ? ` · ${reverts} revert PR${reverts === 1 ? "" : "s"} merged here, not counted`
      : "");
  if (counted.length === 0) return;

  const head = [
    "Merged",
    "Repo",
    "PR",
    "Title",
    ...(showAuthor ? ["Author"] : []),
    "Lines",
    "Weighted PRs",
  ];
  const numeric = new Set(["PR", "Lines", "Weighted PRs"]);
  const thead = h("thead", {}, [
    h(
      "tr",
      {},
      head.map((label) =>
        h(
          "th",
          numeric.has(label)
            ? { class: "num", scope: "col" }
            : { scope: "col" },
          [label],
        ),
      ),
    ),
  ]);
  const tbody = h(
    "tbody",
    {},
    counted.map((row) =>
      h("tr", row.reverted_by ? { class: "is-reverted" } : {}, [
        h("td", { class: "nowrap" }, [dayLabel(row.day, true)]),
        h("td", {}, [row.repo]),
        h("td", { class: "num" }, [`#${row.number}`]),
        h("td", {}, [
          row.title,
          ...(row.reverted_by
            ? [h("span", { class: "tag" }, ["reverted"])]
            : []),
        ]),
        ...(showAuthor ? [h("td", {}, [row.author_name])] : []),
        h("td", { class: "num" }, [formatNumber(row.lines)]),
        h("td", { class: "num" }, [formatNumber(weightOf(row.lines), 2)]),
      ]),
    ),
  );
  table.append(h("table", {}, [thead, tbody]));
}

/**
 * Summary tiles for the range, with the change against the previous range
 * where there is one.
 * @param {Totals} current
 * @param {Totals | null} previous
 * @param {string} previousLabel
 */
export function drawTiles(current, previous, previousLabel) {
  const tiles = byId("tiles");
  tiles.replaceChildren();
  /** @type {{ label: string, metric: Metric, note?: string }[]} */
  const specs = [
    { label: "PRs", metric: "prs" },
    { label: "Weighted PRs", metric: "weighted" },
    { label: "Median PR size", metric: "median" },
    { label: "Lines changed", metric: "lines" },
    {
      label: "Revert rate",
      metric: "reverts",
      note: "recent PRs have had less time to be reverted",
    },
  ];
  for (const spec of specs) {
    const value = metricOf(current, spec.metric);
    const delta = h("div", { class: "tile-delta" });
    const before = previous ? metricOf(previous, spec.metric) : null;
    if (previous && value !== null && before !== null) {
      const diff = value - before;
      const upIsGood = spec.metric !== "reverts";
      // Median PR size is context, not a target, so its change has no tone.
      const tone =
        diff === 0 || spec.metric === "median"
          ? ""
          : diff > 0 === upIsGood
            ? "good"
            : "bad";
      let text;
      if (spec.metric === "reverts") {
        text = `${formatNumber(Math.abs(diff) * 100, 1)} pts`;
      } else if (before === 0) {
        text = `${formatMetric(Math.abs(diff), spec.metric)}`;
      } else {
        text = `${formatNumber(Math.abs(diff / before) * 100)}%`;
      }
      const arrow = diff > 0 ? "▲ " : diff < 0 ? "▼ " : "";
      delta.append(
        h("span", tone ? { class: tone } : {}, [
          diff === 0 ? "No change" : `${arrow}${text}`,
        ]),
        ` vs ${previousLabel}`,
      );
    }
    tiles.append(
      h("div", { class: "tile" }, [
        h("div", { class: "tile-label" }, [spec.label]),
        h("div", { class: "tile-value" }, [
          spec.metric === "reverts" && value !== null
            ? `${formatMetric(value, "reverts")} (${current.reverted}/${current.count})`
            : formatMetric(value, spec.metric),
        ]),
        ...(delta.childNodes.length > 0 || !spec.note ? [delta] : []),
        ...(spec.note ? [h("div", { class: "tile-delta" }, [spec.note])] : []),
      ]),
    );
  }
}

/**
 * The report's header line: when and what was scanned, and what lines leave
 * out.
 * @param {ScanResult} scan
 * @param {string} generatedDay
 */
export function metaLine(scan, generatedDay) {
  const { options } = scan;
  const authors = options.all_authors
    ? "all authors"
    : options.authors.length > 0
      ? options.authors.join(", ")
      : scan.repos.every((repo) => repo.branch === null)
        ? "no PRs counted, as no repo could be scanned – the scan's warnings say why"
        : "no PRs counted, as no repo that could be scanned has git user.email set";
  const left = [
    ...(options.include_docs ? [] : ["docs"]),
    "lockfiles",
    "generated files",
    // Scans saved before `exclude` was recorded have none.
    ...(options.exclude ?? []).map((glob) => `"${glob}"`),
  ];
  const leftOut = `${left.slice(0, -1).join(", ")} and ${left[left.length - 1]}`;
  const repos = scan.repos.length;
  return (
    `Generated ${dayLabel(generatedDay, true)} · ${repos} repo${repos === 1 ? "" : "s"} scanned · ${authors} · dates in ${options.timezone}` +
    ` · lines leave out ${leftOut}`
  );
}

/**
 * @param {ScanResult} scan
 */
export function main(scan) {
  const formatter = zoneFormatter(scan.options.timezone || "UTC");
  /** @type {Row[]} */
  const rows = scan.prs.map((pr) => ({
    ...pr,
    day: dayOf(Date.parse(pr.merged_at), formatter),
    authorKey: pr.author_email.toLowerCase(),
  }));
  const boundDay = (/** @type {string | null} */ value) =>
    value === null
      ? null
      : isDay(value)
        ? value
        : dayOf(Date.parse(value), formatter);
  const generatedDay = dayOf(Date.parse(scan.generated_at), formatter);
  const earliest = rows.reduce(
    (min, row) => (row.day < min ? row.day : min),
    generatedDay,
  );
  const sinceDay = boundDay(scan.options.since);
  const bounds = {
    generatedDay,
    firstDay: sinceDay ?? earliest,
    endDay: boundDay(scan.options.until) ?? generatedDay,
  };
  const allowAuthorSplit = Boolean(scan.options.all_authors);
  const repoNames = [...new Set(rows.map((row) => row.repo))].sort();
  const repoSeries = assignSeries(
    rows,
    (row) => row.repo,
    (row) => row.repo,
  );
  const authorSeries = assignSeries(
    rows,
    (row) => row.authorKey,
    (row) => row.author_name,
  );
  const other = {
    key: "__other",
    label: "Other",
    colour: "var(--series-other)",
    rank: Infinity,
  };

  const initialRange = presetRange("12m", bounds);
  const storageKey = viewKey(scan);
  /** @type {View} */
  let view = loadView(
    storageKey,
    {
      preset: "12m",
      from: initialRange.from,
      to: initialRange.to,
      period: "week",
      metric: "prs",
      split: "none",
      hiddenRepos: [],
    },
    allowAuthorSplit,
    bounds,
  );
  /** @type {string | null} */
  let selected = null;
  /** @type {{ columns: Column[], series: Series[] }} */
  let model = { columns: [], series: [] };

  byId("meta").textContent = metaLine(scan, generatedDay);

  /**
   * @param {string} id
   * @param {[string, string][]} options
   * @param {() => string} current
   * @param {(value: string) => void} choose
   * @param {(value: string) => boolean} [disabled]
   */
  const segmented = (id, options, current, choose, disabled) => {
    const group = byId(id);
    const buttons = options.map(([value, label]) => {
      const button = /** @type {HTMLButtonElement} */ (
        h("button", { type: "button", "data-value": value }, [label])
      );
      if (disabled?.(value)) {
        button.disabled = true;
        button.title = "Needs a scan run with --all-authors";
      }
      button.addEventListener("click", () => {
        choose(value);
        render();
      });
      return button;
    });
    group.replaceChildren(...buttons);
    return () => {
      for (const button of buttons) {
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.value === current()),
        );
      }
    };
  };

  const fromInput = /** @type {HTMLInputElement} */ (byId("from"));
  const toInput = /** @type {HTMLInputElement} */ (byId("to"));
  const syncers = [
    segmented(
      "presets",
      [
        ["30d", "30 days"],
        ["90d", "90 days"],
        ["12m", "12 months"],
        ["all", "All"],
      ],
      () => view.preset,
      (value) => {
        view.preset = /** @type {Preset} */ (value);
      },
    ),
    segmented(
      "periods",
      [
        ["day", "Day"],
        ["week", "Week"],
        ["month", "Month"],
      ],
      () => view.period,
      (value) => {
        view.period = /** @type {Period} */ (value);
        selected = null;
      },
    ),
    segmented(
      "metrics",
      [
        ["prs", "PRs"],
        ["weighted", "Weighted PRs"],
        ["median", "Median PR size"],
        ["lines", "Lines changed"],
        ["reverts", "Revert rate"],
      ],
      () => view.metric,
      (value) => {
        view.metric = /** @type {Metric} */ (value);
      },
    ),
    segmented(
      "splits",
      [
        ["none", "None"],
        ["repo", "By repo"],
        ["author", "By author"],
      ],
      () => view.split,
      (value) => {
        view.split = /** @type {Split} */ (value);
      },
      (value) => value === "author" && !allowAuthorSplit,
    ),
  ];

  const onDates = () => {
    const from = fromInput.value;
    const to = toInput.value;
    if (!from || !to || from > to) return;
    view.preset = "custom";
    view.from = from;
    view.to = to;
    selected = null;
    render();
  };
  fromInput.addEventListener("change", onDates);
  toInput.addEventListener("change", onDates);

  const repoList = byId("repo-list");
  const checkboxes = repoNames.map((name) => {
    const box = /** @type {HTMLInputElement} */ (
      h("input", { type: "checkbox", value: name })
    );
    box.addEventListener("change", () => {
      view.hiddenRepos = repoNames.filter((repo) =>
        checkboxes.some((b) => b.value === repo && !b.checked),
      );
      render();
    });
    repoList.append(h("label", {}, [box, name]));
    return box;
  });
  byId("repos-all").addEventListener("click", () => {
    view.hiddenRepos = [];
    render();
  });
  byId("repos-none").addEventListener("click", () => {
    view.hiddenRepos = [...repoNames];
    render();
  });

  const metricNames = {
    prs: "PRs",
    weighted: "Weighted PRs",
    median: "Median PR size",
    lines: "Lines changed",
    reverts: "Revert rate",
  };
  const notes = {
    prs: "Revert PRs aren't counted.",
    weighted:
      "Each PR counts √(lines ÷ 100): a 100-line PR counts 1, a 400-line PR counts 2. Revert PRs aren't counted.",
    median:
      "Lines changed by the middle PR. Context for reading PRs and size-weighted PRs – did PRs get bigger or smaller? Not a target.",
    lines: "Added + removed, leaving out the excluded files.",
    reverts:
      "Recent periods understate the revert rate: their PRs have had less time to be reverted.",
  };

  const drawChartAndDetails = () => {
    const chart = byId("chart");
    drawChart(
      chart,
      byId("tooltip"),
      model,
      view.period,
      view.metric,
      selected,
      (key) => {
        selected = key;
        drawChartAndDetails();
        // Redrawing replaced the focused bar, so keyboard users get it back.
        /** @type {SVGElement | null} */ (
          chart.querySelector(`rect.hit[data-period="${key}"]`)
        )?.focus({ preventScroll: true });
        byId("details").scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      },
    );
    const column = model.columns.find((c) => c.key === selected) ?? null;
    drawDetails(column, view.period, view.metric, allowAuthorSplit);
  };

  const render = () => {
    const range =
      view.preset === "custom"
        ? { from: view.from, to: view.to }
        : presetRange(view.preset, bounds);
    view.from = range.from;
    view.to = range.to;
    fromInput.value = range.from;
    toInput.value = range.to;
    for (const sync of syncers) sync();

    const hidden = new Set(view.hiddenRepos);
    for (const box of checkboxes) box.checked = !hidden.has(box.value);
    byId("repo-summary").textContent =
      `Repos (${repoNames.length - repoNames.filter((name) => hidden.has(name)).length} of ${repoNames.length})`;

    const visible = rows.filter((row) => !hidden.has(row.repo));
    const inRange = (/** @type {Range} */ r) =>
      visible.filter((row) => row.day >= r.from && row.day <= r.to);
    const current = inRange(range);

    const prev = view.preset === "all" ? null : previousRange(range);
    const comparable =
      prev !== null && (sinceDay === null || prev.from >= sinceDay);
    const lengthLabel =
      view.preset === "30d"
        ? "previous 30 days"
        : view.preset === "90d"
          ? "previous 90 days"
          : view.preset === "12m"
            ? "previous 12 months"
            : `previous ${daysBetween(range.from, range.to) + 1} days`;
    drawTiles(
      totalsOf(current),
      comparable && prev ? totalsOf(inRange(prev)) : null,
      lengthLabel,
    );

    /** @type {((row: Row) => Series) | null} */
    const seriesOf =
      view.split === "repo"
        ? (row) => repoSeries.get(row.repo) ?? other
        : view.split === "author"
          ? (row) => authorSeries.get(row.authorKey) ?? other
          : null;
    model = chartModel(
      current,
      periodsBetween(range.from, range.to, view.period),
      view.period,
      view.metric,
      seriesOf,
    );
    if (selected && !model.columns.some((c) => c.key === selected))
      selected = null;

    byId("chart-title").textContent =
      `${metricNames[view.metric]} per ${view.period}`;
    byId("chart-note").textContent = notes[view.metric];
    const legend = byId("legend");
    legend.replaceChildren();
    const barSeries =
      model.series.length > 0
        ? model.series
        : [
            {
              key: "total",
              label: metricNames[view.metric],
              colour: "var(--series-1)",
            },
          ];
    for (const s of barSeries) {
      legend.append(
        h("span", {}, [
          h("span", { class: "swatch", style: `background:${s.colour}` }),
          s.label,
        ]),
      );
    }
    if (model.columns.length >= 4) {
      legend.append(
        h("span", {}, [
          h("span", { class: "line-key", style: "background:var(--average)" }),
          "4-period average",
        ]),
      );
    }

    drawChartAndDetails();
    saveView(storageKey, view);
  };

  let pending = false;
  window.addEventListener("resize", () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      drawChartAndDetails();
    });
  });

  render();
}
