import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** A line comment, or a block comment that opens and closes on the line. */
const COMMENT_LINE = /^\/\/|^\/\*(?:(?!\*\/).)*\*\/$/;

/** Column-0 lines a module of exported function declarations may hold. */
const ALLOWED_LINES = [
  /^export (async )?function [A-Za-z_$][\w$]*\(/,
  /^\}$/,
  /^\) \{$/,
  /^\}\) \{$/,
];

/**
 * The lines at an inlined module's top level that the report's page won't
 * carry – see docs/patterns/report-inlining.md. A lint over prettier-formatted
 * source, not a parser: a line with no leading whitespace is top level.
 *
 * A multi-line template literal in a function body puts column-0 lines inside
 * the body, which this flags as top level. The fix is to track backtick state,
 * never to widen the allowed lines.
 * @param {string} source
 * @param {string[]} allowedSources the other inlined modules, as this module's imports write them
 * @returns {{ line: number, text: string }[]}
 */
function topLevelFindings(source, allowedSources) {
  /** @type {{ line: number, text: string }[]} */
  const findings = [];
  let inComment = false;
  let inImport = false;
  for (const [i, text] of source.split("\n").entries()) {
    const flag = () => findings.push({ line: i + 1, text });
    if (inComment) {
      inComment = !text.includes("*/");
    } else if (inImport) {
      const end = text.match(/^\} from "(.+)";$/);
      if (end) {
        inImport = false;
        if (!allowedSources.includes(end[1])) flag();
      } else if (!/^\s+[A-Za-z_$][\w$]*,?$/.test(text)) {
        flag();
      }
    } else if (text === "" || /^\s/.test(text) || COMMENT_LINE.test(text)) {
      continue;
    } else if (text.startsWith("/*")) {
      inComment = !text.includes("*/");
      if (!inComment) flag();
    } else if (text === "import {") {
      inImport = true;
    } else {
      const named = text.match(/^import \{ (.+) \} from "(.+)";$/);
      const allowed = named
        ? named[1].split(", ").every((name) => IDENTIFIER.test(name)) &&
          allowedSources.includes(named[2])
        : ALLOWED_LINES.some((line) => line.test(text));
      if (!allowed) flag();
    }
  }
  return findings;
}

/** The modules reportScript inlines: src/report.js's namespace imports. */
function inlinedModules() {
  const report = resolve(ROOT, "src/report.js");
  const source = readFileSync(report, "utf8");
  return [...source.matchAll(/^import \* as \w+ from "(.+)";$/gm)].map(
    (match) => resolve(dirname(report), match[1]),
  );
}

/**
 * @param {string} from
 * @param {string} to
 */
function importPath(from, to) {
  const path = relative(dirname(from), to);
  return path.startsWith(".") ? path : `./${path}`;
}

describe("inlined report modules", () => {
  test("hold only exported function declarations and imports from other inlined modules", () => {
    const modules = inlinedModules();
    const files = modules.map((file) => relative(ROOT, file));
    assert.ok(files.includes("src/time.js"), files.join(", "));
    assert.ok(files.includes("src/report/client.js"), files.join(", "));
    const findings = modules.flatMap((file) => {
      const allowed = modules
        .filter((other) => other !== file)
        .map((other) => importPath(file, other));
      return topLevelFindings(readFileSync(file, "utf8"), allowed).map(
        ({ line, text }) => `${relative(ROOT, file)}:${line}: ${text}`,
      );
    });
    assert.deepEqual(findings, []);
  });
});

describe("the top-level check", () => {
  const ALLOWED_SOURCES = ["../time.js"];

  test("passes exported functions, inlined imports, comments and wrapped signatures", () => {
    const source = [
      "// A line comment.",
      "import {",
      "  addDays,",
      "  dayOf,",
      '} from "../time.js";',
      'import { parseDay, periodOf } from "../time.js";',
      "",
      "/**",
      " * @typedef {{ from: string, to: string }} Range",
      " * @typedef {'day' | 'week'} Period",
      " */",
      "",
      "/*",
      "A plain block comment,",
      "with lines at column 0.",
      "*/",
      "",
      "/* One line. */",
      "",
      "/** @param {string} day */",
      "export function nextDay(day) {",
      "  return addDays(day, 1);",
      "}",
      "",
      "export async function later(day) {",
      "  return parseDay(await day);",
      "}",
      "",
      "export function drawChart(",
      "  container,",
      "  tooltip,",
      "  period,",
      ") {",
      "  return [container, tooltip, periodOf(period)];",
      "}",
      "",
      "export function drawLegend({",
      "  container,",
      "  series,",
      "}) {",
      "  return [container, series];",
      "}",
      "",
    ].join("\n");
    assert.deepEqual(topLevelFindings(source, ALLOWED_SOURCES), []);
  });

  /** @type {{ mistake: string, source: string[], line: number }[]} */
  const MISTAKES = [
    {
      mistake: "a module-level constant",
      source: [
        'const MONTHS = ["Jan", "Feb" /* … */]; // not inlined – a ReferenceError in the page',
        "export function dayLabel(day) {",
        "  return MONTHS[Number(day.slice(5, 7)) - 1];",
        "}",
      ],
      line: 1,
    },
    { mistake: "a module-level let", source: ["let count = 0;"], line: 1 },
    { mistake: "a module-level var", source: ["var count = 0;"], line: 1 },
    {
      mistake: "a private helper",
      source: [
        "export function twice(n) {",
        "  return double(n);",
        "}",
        "",
        "function double(n) {",
        "  return n * 2;",
        "}",
      ],
      line: 5,
    },
    {
      mistake: "a class",
      source: ["class Chart {", "  draw() {}", "}"],
      line: 1,
    },
    {
      mistake: "an exported arrow function",
      source: ["export const double = (n) => n * 2;"],
      line: 1,
    },
    {
      mistake: "an exported let",
      source: ["export let count = 0;"],
      line: 1,
    },
    {
      mistake: "a default export",
      source: ["export default function main() {", "  return 1;", "}"],
      line: 1,
    },
    {
      mistake: "an export list",
      source: ['import { addDays } from "../time.js";', "export { addDays };"],
      line: 2,
    },
    {
      mistake: "an import from Node",
      source: ['import { readFileSync } from "node:fs";'],
      line: 1,
    },
    {
      mistake: "an import from a module that isn't inlined",
      source: ['import { scan } from "../scan.js";'],
      line: 1,
    },
    {
      mistake: "a wrapped import from a module that isn't inlined",
      source: ["import {", "  scan,", "  summarise,", '} from "../scan.js";'],
      line: 4,
    },
    {
      mistake: "a default import",
      source: ['import time from "../time.js";'],
      line: 1,
    },
    {
      mistake: "a namespace import",
      source: ['import * as time from "../time.js";'],
      line: 1,
    },
    {
      mistake: "a renamed import",
      source: ['import { addDays as add, dayOf } from "../time.js";'],
      line: 1,
    },
    {
      mistake: "a renamed import wrapped over lines",
      source: [
        "import {",
        "  addDays,",
        "  dayOf as day,",
        "  periodOf,",
        '} from "../time.js";',
      ],
      line: 3,
    },
  ];

  for (const { mistake, source, line } of MISTAKES) {
    test(`flags ${mistake}`, () => {
      assert.deepEqual(topLevelFindings(source.join("\n"), ALLOWED_SOURCES), [
        { line, text: source[line - 1] },
      ]);
    });
  }
});
