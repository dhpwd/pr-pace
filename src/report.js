import { readFileSync } from "node:fs";
import * as client from "./report/client.js";
import * as time from "./time.js";

const TEMPLATE = new URL("./report/template.html", import.meta.url);

/**
 * The report's script: the browser code's functions inlined from source, then
 * a call to main with the embedded scan.
 */
function reportScript() {
  const functions = [...Object.values(time), ...Object.values(client)];
  for (const fn of functions) {
    if (typeof fn !== "function") {
      throw new Error("report modules may only export functions");
    }
  }
  return [
    '"use strict";',
    ...functions.map(String),
    'main(JSON.parse(document.getElementById("scan-data").textContent));',
  ].join("\n\n");
}

/**
 * Renders the self-contained HTML report for a scan.
 * @param {import('./scan.js').ScanResult} scan
 */
export function renderReport(scan) {
  // The report shows neither repos' paths nor their warnings, and both can
  // carry local folder names into a file that gets sent around.
  const embedded = {
    ...scan,
    repos: scan.repos.map(({ name, branch, prs, direct_commits_ignored }) => ({
      name,
      branch,
      prs,
      direct_commits_ignored,
    })),
  };
  // Escaping "<" keeps titles like "</script>" from closing the data block.
  const data = JSON.stringify(embedded).replace(/</g, "\\u003c");
  return readFileSync(TEMPLATE, "utf8")
    .replace("/*SCRIPT*/", () => reportScript())
    .replace("/*DATA*/", () => data);
}
