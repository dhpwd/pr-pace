import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Repo, removeDir, tempDir } from "./fixtures.js";

const BIN = fileURLToPath(new URL("../bin/pr-velocity.js", import.meta.url));
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
    assert.match(main.stdout, /pr-velocity scan/);
    assert.match(main.stdout, /pr-velocity report/);

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

  test("the package installs the command as pr-velocity, on Node 20 or later, with no runtime dependencies", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    assert.deepEqual(pkg.bin, { "pr-velocity": "bin/pr-velocity.js" });
    assert.equal(pkg.engines.node, ">=20");
    assert.equal(pkg.dependencies, undefined);
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
      [["scan", "--nope"], /unknown option --nope – pr-velocity scan --help/],
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
      [["scan", "--depth", "-1"], /--depth/],
      [["scan", join(root, "nowhere")], /is not a folder/],
      [["frobnicate"], /unknown command "frobnicate"/],
    ];
    for (const [args, message] of cases) {
      const result = run(.../** @type {string[]} */ (args));
      assert.equal(result.code, 1, String(args));
      assert.match(result.stderr, /** @type {RegExp} */ (message));
    }
  });

  test("a folder with no repos is an error suggesting --depth", () => {
    const empty = tempDir("pr-velocity-empty-");
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
    assert.match(result.stderr, /wrote .*report\.html – 2 PRs from 1 repos/);
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
    assert.match(wrong.stderr, /isn't a pr-velocity scan/);
  });
});
