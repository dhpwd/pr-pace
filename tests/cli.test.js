import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { paceLine } from "../src/pace.js";
import { dayOf, zoneFormatter } from "../src/time.js";
import { Repo, removeDir, tempDir } from "./fixtures.js";

const BIN = fileURLToPath(new URL("../bin/pr-pace.js", import.meta.url));
const PKG = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const root = tempDir();
after(() => removeDir(root));

const repo = new Repo(join(root, "app"));
repo.commit("Initial commit");
repo.squash(1, "Add the first thing", { files: { "a.js": "a\n" } });
repo.squash(2, "Add the second thing", { files: { "b.js": "b\nc\n" } });

/** @param {...string} args */
function run(...args) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, TZ: "Europe/London" },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("help", () => {
  test("every command has help listing all its options", () => {
    const main = run("--help");
    assert.equal(main.code, 0);
    assert.match(main.stdout, /pr-pace pace/);
    assert.match(main.stdout, /pr-pace scan/);
    assert.match(main.stdout, /pr-pace report/);

    const scanOptions = [
      "--depth",
      "--fetch",
      "--branch",
      "--author",
      "--all-authors",
      "--since",
      "--until",
      "--include-docs",
      "--exclude",
      "--out",
    ];
    const scan = run("scan", "--help");
    assert.equal(scan.code, 0);
    for (const option of scanOptions)
      assert.match(scan.stdout, new RegExp(`${option}\\b`));
    const report = run("report", "-h");
    assert.equal(report.code, 0);
    for (const option of [...scanOptions, "--from", "--open"]) {
      assert.match(report.stdout, new RegExp(`${option}\\b`));
    }
  });

  test("the package installs the command as pr-pace, on Node 20 or later, with no runtime dependencies", () => {
    assert.equal(PKG.name, "pr-pace");
    assert.deepEqual(PKG.bin, { "pr-pace": "bin/pr-pace.js" });
    assert.equal(PKG.engines.node, ">=20");
    assert.equal(PKG.dependencies, undefined);
    assert.match(readFileSync(BIN, "utf8"), /^#!\/usr\/bin\/env node\n/);
    assert.match(run("--version").stdout, /^\d+\.\d+\.\d+\n$/);
  });
});

describe("scan", () => {
  test("writes JSON to stdout, recording the machine's timezone", () => {
    const result = run("scan", repo.dir);
    assert.equal(result.code, 0, result.stderr);
    const scan = JSON.parse(result.stdout);
    assert.equal(scan.prs.length, 2);
    assert.equal(scan.options.timezone, "Europe/London");
    assert.match(
      scan.generated_at,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
    );
  });

  test("--out writes the JSON to a file, and warnings go to stderr", () => {
    const out = join(root, "scan.json");
    const result = run(
      "scan",
      repo.dir,
      "--author",
      "someone@example.com",
      "--out",
      out,
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /warning: app: no PRs match the author filter/);
    assert.equal(JSON.parse(readFileSync(out, "utf8")).prs.length, 0);
  });

  test("bad options fail with a message saying what to do instead", () => {
    const cases = [
      [["scan", "--nope"], /unknown option --nope – pr-pace scan --help/],
      [
        ["scan", "--author", "a@example.com", "--all-authors"],
        /can't be combined/,
      ],
      [
        ["scan", "--since", "last week"],
        /use YYYY-MM-DD .* or a full ISO 8601 timestamp/,
      ],
      [
        ["scan", "--since", "2026-05-01", "--until", "2026-04-01"],
        /--since is after --until/,
      ],
      [["scan", "--depth=-1"], /--depth "-1" isn't a whole number/],
      [["scan", "--depth", "two"], /--depth "two" isn't a whole number/],
      [["scan", join(root, "nowhere")], /is not a folder/],
      [["frobnicate"], /unknown command "frobnicate"/],
      [[], /Usage/],
      [
        ["scan", repo.dir, "--out", join(root, "no-such-folder", "x.json")],
        /couldn't write .* check the folder exists/,
      ],
    ];
    for (const [args, message] of cases) {
      const result = run(.../** @type {string[]} */ (args));
      assert.equal(result.code, 1, String(args));
      assert.match(result.stderr, /** @type {RegExp} */ (message));
    }
  });

  test("a folder with no repos is an error suggesting --depth", () => {
    const empty = tempDir("pr-pace-empty-");
    try {
      const none = run("scan", empty);
      assert.equal(none.code, 1);
      assert.match(none.stderr, /no git repos found .* raise --depth/);
    } finally {
      removeDir(empty);
    }
  });
});

describe("report", () => {
  test("scans and writes a self-contained HTML report", () => {
    const out = join(root, "report.html");
    const result = run("report", repo.dir, "--out", out);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /wrote .*report\.html – 2 PRs from 1 repo\n/);
    const html = readFileSync(out, "utf8");
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /Add the second thing/);
  });

  test("--from builds from a saved scan, and refuses scan options alongside it", () => {
    const saved = join(root, "saved.json");
    writeFileSync(saved, run("scan", repo.dir).stdout);
    const out = join(root, "from.html");
    const result = run("report", "--from", saved, "--out", out);
    assert.equal(result.code, 0, result.stderr);
    assert.match(readFileSync(out, "utf8"), /Add the first thing/);

    const mixed = run(
      "report",
      "--from",
      saved,
      repo.dir,
      "--since",
      "2026-01-01",
    );
    assert.equal(mixed.code, 1);
    assert.match(mixed.stderr, /paths, --since can't be used with it/);

    writeFileSync(join(root, "not-a-scan.json"), "{}");
    const wrong = run("report", "--from", join(root, "not-a-scan.json"));
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /isn't a pr-pace scan/);
  });
});

describe("pace", () => {
  // The fixture clock starts in January 2026, but the live command counts back
  // from today, so these PRs are dated from now: two well inside the window
  // and one well before it, whatever the time of day.
  const DAY = 86400000;
  const ago = (/** @type {number} */ days) =>
    new Date(Date.now() - days * DAY).toISOString();
  const recent = new Repo(join(root, "recent"));
  recent.commit("Initial commit", { date: ago(60) });
  recent.squash(3, "Add an older thing", {
    date: ago(40),
    files: { "old.js": "x\n".repeat(100) },
  });
  recent.squash(4, "Add a recent thing", {
    date: ago(10),
    files: { "a.js": "x\n".repeat(100) },
  });
  recent.squash(5, "Add a bigger thing", {
    date: ago(2),
    files: { "b.js": "x\n".repeat(400) },
  });
  const version = `pr-pace v${PKG.version.split(".")[0]}`;
  const londonDay = () => dayOf(Date.now(), zoneFormatter("Europe/London"));
  const saved = join(root, "recent.json");
  before(() => writeFileSync(saved, run("scan", recent.dir).stdout));

  test("prints the share line for the 30 days to today, with the package's major version", () => {
    const first = londonDay();
    const result = run("pace", recent.dir);
    const last = londonDay();
    assert.equal(result.code, 0, result.stderr);
    const match =
      /^PR pace 0\.7\/wk · 30 days to (\S+) · 2 PRs · median 250 lines · (.+)\n$/.exec(
        result.stdout,
      );
    assert.ok(match, result.stdout);
    assert.ok(match[1] === first || match[1] === last, match[1]);
    assert.equal(match[2], version);

    const twice = run(
      "pace",
      recent.dir,
      "--author",
      "dev@example.com",
      "--author",
      "someone@example.com",
    );
    assert.equal(twice.code, 0, twice.stderr);
    assert.match(twice.stdout, / · 2 PRs · median 250 lines · /);
  });

  test("--from prints the line from a saved scan, counting back from the day it ran", () => {
    const scan = JSON.parse(readFileSync(saved, "utf8"));
    const result = run("pace", "--from", saved);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `${paceLine(scan, PKG.version)}\n`);
    assert.match(result.stdout, /^PR pace 0\.7\/wk · .* · 2 PRs · median 250/);

    // Run 35 days ago, the scan's window holds only the older PR.
    const earlier = join(root, "earlier.json");
    writeFileSync(earlier, JSON.stringify({ ...scan, generated_at: ago(35) }));
    const moved = run("pace", "--from", earlier);
    assert.equal(moved.code, 0, moved.stderr);
    assert.match(
      moved.stdout,
      /^PR pace 0\.2\/wk · 30 days to \S+ · 1 PR · median 100 lines · /,
    );
  });

  test("--help lists only the options pace accepts", () => {
    const help = run("pace", "--help");
    assert.equal(help.code, 0);
    for (const option of [
      "--depth",
      "--fetch",
      "--branch",
      "--author",
      "--exclude",
      "--from",
    ]) {
      assert.match(help.stdout, new RegExp(`${option}\\b`));
    }
    for (const option of [
      "--all-authors",
      "--since",
      "--until",
      "--include-docs",
      "--out",
      "--open",
    ]) {
      assert.doesNotMatch(help.stdout, new RegExp(`${option}\\b`));
    }
  });

  test("refuses options that would change what the line measures", () => {
    const window =
      /--since and --until can't be used with pace – it always covers the 30 days to today/;
    const cases = [
      [["pace", "--since", "2026-01-01"], window],
      [["pace", "--until", "2026-01-01"], window],
      [
        ["pace", "--all-authors"],
        /PR pace is one person's figure – pass --author for someone else, not --all-authors/,
      ],
      [
        ["pace", "--include-docs"],
        /--include-docs can't be used with pace – every PR pace line counts lines the same way/,
      ],
      [
        ["pace", "--from", saved, recent.dir],
        /--from prints the PR pace from a saved scan, so paths can't be used with it/,
      ],
      [["pace", "--from", saved, "--branch", "main"], /so --branch can't/],
      [["pace", "--from", saved, "--since", "2026-01-01"], /so --since can't/],
    ];
    for (const [args, message] of cases) {
      const result = run(.../** @type {string[]} */ (args));
      assert.equal(result.code, 1, String(args));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /** @type {RegExp} */ (message));
    }
  });

  test("refuses a saved scan that covers a date range, every author or docs", () => {
    const scan = JSON.parse(readFileSync(saved, "utf8"));
    /** @type {[Record<string, unknown>, RegExp][]} */
    const cases = [
      [{ since: "2026-01-01" }, /scanned with --since or --until, and PR pace/],
      [{ until: "2026-12-31" }, /scanned with --since or --until, and PR pace/],
      [
        { all_authors: true, authors: [] },
        /scanned with --all-authors, and PR pace is one person's figure/,
      ],
      [
        { include_docs: true },
        /scanned with --include-docs, and every PR pace line counts lines the same way/,
      ],
    ];
    const file = join(root, "refused.json");
    for (const [options, message] of cases) {
      writeFileSync(
        file,
        JSON.stringify({ ...scan, options: { ...scan.options, ...options } }),
      );
      const result = run("pace", "--from", file);
      assert.equal(result.code, 1, JSON.stringify(options));
      assert.match(result.stderr, message);
    }
  });
});
