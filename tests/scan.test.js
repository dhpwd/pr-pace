import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { repoNames } from "../src/repos.js";
import { scan } from "../src/scan.js";
import {
  DEV,
  MERGER,
  OTHER,
  Repo,
  removeDir,
  scanOptions,
  tempDir,
} from "./fixtures.js";

const root = tempDir();
after(() => removeDir(root));

let counter = 0;
/** @param {{ email?: string }} [options] */
function newRepo(options) {
  return new Repo(join(root, `repo-${++counter}`), options);
}

/**
 * @param {Repo} repo
 * @param {Partial<import('../src/scan.js').ScanOptions>} [overrides]
 */
function scanRepo(repo, overrides) {
  return scan(scanOptions([repo.dir], overrides));
}

/**
 * @param {import('../src/scan.js').ScanResult} result
 * @param {number} number
 */
function pr(result, number) {
  const found = result.prs.find((row) => row.number === number);
  assert.ok(found, `PR #${number} not in the scan`);
  return found;
}

describe("PR detection", () => {
  test("a squash-merged PR is one PR, titled without its (#N) suffix", () => {
    const repo = newRepo();
    repo.commit("Initial commit", { files: { "src/app.js": "one\n" } });
    repo.squash(12, "Add retry to the export job", {
      files: { "src/app.js": "one\ntwo\nthree\n" },
    });
    const result = scanRepo(repo);
    assert.equal(result.prs.length, 1);
    assert.deepEqual(
      {
        number: pr(result, 12).number,
        title: pr(result, 12).title,
        method: pr(result, 12).method,
        author: pr(result, 12).author_email,
        added: pr(result, 12).added,
        removed: pr(result, 12).removed,
      },
      {
        number: 12,
        title: "Add retry to the export job",
        method: "squash",
        author: DEV.email,
        added: 2,
        removed: 0,
      },
    );
  });

  test("a merge-commit PR counts once, never its branch commits, and takes the branch author", () => {
    const repo = newRepo();
    repo.commit("Initial commit", { files: { "a.js": "a\n" } });
    repo.mergePR(7, "Add the widget", {
      commits: [
        { message: "Start widget (#99)", files: { "widget.js": "w\n" } },
        { message: "Finish widget", files: { "widget.js": "w\nx\ny\n" } },
      ],
    });
    const result = scanRepo(repo);
    assert.equal(result.prs.length, 1);
    const merged = pr(result, 7);
    assert.equal(merged.method, "merge");
    assert.equal(merged.author_email, DEV.email);
    assert.notEqual(merged.author_email, MERGER.email);
    assert.equal(merged.lines, 3);
    assert.equal(result.repos[0].direct_commits_ignored, 1);
  });

  test("a merge-method PR's title is the first non-empty line of its body", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.mergePR(3, "", {
      commits: [{ message: "work", files: { "x.js": "x\n" } }],
      message:
        "Merge pull request #3 from someone/feature-3\n\n\n  Make the exports resumable  \n\nLonger description",
    });
    repo.mergePR(4, "", {
      commits: [{ message: "work", files: { "y.js": "y\n" } }],
      message: "Merge pull request #4 from someone/feature-4",
    });
    const result = scanRepo(repo);
    assert.equal(pr(result, 3).title, "Make the exports resumable");
    assert.equal(
      pr(result, 4).title,
      "Merge pull request #4 from someone/feature-4",
    );
  });

  test("a two-parent merge commit with subject 'Title (#N)' is a merge PR", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.mergePR(21, "", {
      commits: [{ message: "work", files: { "x.js": "1\n2\n" } }],
      message: "Speed up the importer (#21)",
    });
    const result = scanRepo(repo);
    assert.equal(result.prs.length, 1);
    assert.equal(pr(result, 21).method, "merge");
    assert.equal(pr(result, 21).title, "Speed up the importer");
    assert.equal(pr(result, 21).lines, 2);
  });

  test("a GitLab merge request is a merge PR numbered from 'See merge request'", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.mergePR(5, "", {
      commits: [{ message: "work", files: { "x.js": "1\n" } }],
      message:
        "Merge branch 'feature' into 'main'\n\nAdd x\n\nSee merge request group/project!5",
    });
    const result = scanRepo(repo);
    assert.equal(pr(result, 5).method, "merge");
  });

  test("a direct commit to the default branch isn't counted", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.commit("Fix typo", { files: { "a.js": "a\n" } });
    repo.squash(1, "Add b", { files: { "b.js": "b\n" } });
    const result = scanRepo(repo);
    assert.deepEqual(
      result.prs.map((row) => row.number),
      [1],
    );
    assert.equal(result.repos[0].direct_commits_ignored, 2);
  });
});

describe("lines changed", () => {
  test("a rename with a small edit counts only the edit", () => {
    const repo = newRepo();
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    repo.commit("Initial commit", {
      files: { "src/old-name.js": `${body}\n` },
    });
    repo.git("mv", "src/old-name.js", "src/new-name.js");
    repo.squash(2, "Rename the module", {
      files: { "src/new-name.js": `${body}\nline 40\n` },
    });
    const result = scanRepo(repo);
    assert.equal(pr(result, 2).added, 1);
    assert.equal(pr(result, 2).removed, 0);
    assert.equal(pr(result, 2).lines, 1);
  });

  test("lockfiles and markdown are excluded, and markdown counts under --include-docs", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(3, "Add dependency", {
      files: {
        "src/use.js": "use\n",
        "package-lock.json": "{\n}\n",
        "docs/guide.md": "one\ntwo\nthree\n",
      },
    });
    const excluded = pr(scanRepo(repo), 3);
    assert.equal(excluded.lines, 1);
    assert.equal(excluded.excluded_lines, 5);
    const withDocs = pr(scanRepo(repo, { includeDocs: true }), 3);
    assert.equal(withDocs.lines, 4);
    assert.equal(withDocs.excluded_lines, 2);
  });

  test("a .gitattributes linguist-generated file is excluded", () => {
    const repo = newRepo();
    repo.commit("Initial commit", {
      files: { ".gitattributes": "src/generated/** linguist-generated\n" },
    });
    repo.squash(4, "Regenerate client", {
      files: { "src/generated/client.js": "a\nb\nc\n", "src/main.js": "m\n" },
    });
    const result = scanRepo(repo);
    assert.equal(pr(result, 4).lines, 1);
    assert.equal(pr(result, 4).excluded_lines, 3);
  });

  test("build output, binary files and --exclude globs stay out of lines", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(5, "Build", {
      files: {
        "packages/web/dist/bundle.js": "x\ny\n",
        "app.min.js": "z\n",
        "logo.png": Buffer.from([0, 1, 2, 0, 255]),
        "src/__snapshots__/a.snap": "s\n",
        "src/real.js": "r\n",
      },
    });
    const result = scanRepo(repo, { exclude: ["*.snap"] });
    assert.equal(pr(result, 5).lines, 1);
    assert.equal(pr(result, 5).excluded_lines, 4);
  });

  test("score is the square root of lines, to two decimals", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(6, "Add file", {
      files: {
        "a.js": Array.from({ length: 154 }, (_, i) => `${i}`).join("\n") + "\n",
      },
    });
    assert.equal(pr(scanRepo(repo), 6).score, 12.41);
  });
});

describe("reverts", () => {
  test("a revert PR is linked by SHA, and one by subject", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    const bySha = repo.squash(1, "Add caching", {
      files: { "cache.js": "c\n" },
    });
    repo.squash(2, "Add metrics", { files: { "metrics.js": "m\n" } });
    const revertSha = repo.squash(3, 'Revert "Add caching (#1)"', {
      files: { "cache.js": null },
      body: `This reverts commit ${bySha}.`,
    });
    const revertSubject = repo.squash(4, 'Revert "Add metrics"', {
      files: { "metrics.js": null },
    });
    const result = scanRepo(repo);
    assert.equal(pr(result, 1).reverted_by, revertSha);
    assert.equal(pr(result, 2).reverted_by, revertSubject);
    assert.equal(pr(result, 3).is_revert, true);
    assert.equal(pr(result, 4).is_revert, true);
    assert.equal(pr(result, 3).reverted_by, null);
  });

  test("an abbreviated SHA links to the PR it prefixes", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    const original = repo.squash(1, "Add caching", {
      files: { "cache.js": "c\n" },
    });
    const revert = repo.squash(2, "Back out caching", {
      body: `This reverts commit ${original.slice(0, 10)}.`,
    });
    const result = scanRepo(repo);
    assert.equal(pr(result, 2).is_revert, true);
    assert.equal(pr(result, 1).reverted_by, revert);
  });

  test("a squash PR quoting 'This reverts commit' for a SHA off the default branch is an ordinary PR", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.git("checkout", "-q", "-b", "feature");
    const branchCommit = repo.commit("Try a thing", {
      files: { "x.js": "x\n" },
    });
    repo.git("checkout", "-q", "main");
    repo.squash(8, "Ship the feature", {
      files: { "y.js": "y\n" },
      body: `* Try a thing\n\n* Revert "Try a thing"\n\nThis reverts commit ${branchCommit}.`,
    });
    const result = scanRepo(repo);
    assert.equal(pr(result, 8).is_revert, false);
    assert.equal(pr(result, 8).lines, 1);
  });

  test("a merge-method revert PR is detected by its title and linked to the original merge PR", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    const original = repo.mergePR(10, "Add the widget", {
      commits: [{ message: "widget", files: { "w.js": "w\n" } }],
    });
    const revert = repo.mergePR(11, 'Revert "Add the widget"', {
      commits: [
        {
          message: `Revert "Add the widget"\n\nThis reverts commit ${repo.rev(`${original}^2`)}.`,
          files: { "w.js": null },
        },
      ],
    });
    const result = scanRepo(repo);
    assert.equal(pr(result, 11).is_revert, true);
    assert.equal(pr(result, 10).reverted_by, revert);
  });

  test("a revert by another author still marks the filtered author's PR", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    const mine = repo.squash(1, "Add search", { files: { "s.js": "s\n" } });
    const theirs = repo.squash(2, 'Revert "Add search (#1)"', {
      author: OTHER,
      files: { "s.js": null },
      body: `This reverts commit ${mine}.`,
    });
    const result = scanRepo(repo);
    assert.deepEqual(
      result.prs.map((row) => row.number),
      [1],
    );
    assert.equal(pr(result, 1).reverted_by, theirs);
  });

  test("reverts link across the date range: before --since and after --until", () => {
    const repo = newRepo();
    repo.commit("Initial commit", { date: "2026-01-01T10:00:00Z" });
    const early = repo.squash(1, "Early work", {
      files: { "a.js": "a\n" },
      date: "2026-01-10T10:00:00Z",
    });
    const inRange = repo.squash(2, "Mid work", {
      files: { "b.js": "b\n" },
      date: "2026-02-10T10:00:00Z",
    });
    repo.squash(3, 'Revert "Early work (#1)"', {
      files: { "a.js": null },
      body: `This reverts commit ${early}.`,
      date: "2026-02-15T10:00:00Z",
    });
    const late = repo.squash(4, 'Revert "Mid work (#2)"', {
      files: { "b.js": null },
      body: `This reverts commit ${inRange}.`,
      date: "2026-04-01T10:00:00Z",
    });
    const result = scanRepo(repo, {
      since: "2026-02-01",
      until: "2026-02-28",
      sinceMs: Date.UTC(2026, 1, 1),
      untilMs: Date.UTC(2026, 2, 1),
    });
    assert.deepEqual(
      result.prs.map((row) => row.number),
      [2, 3],
    );
    assert.equal(pr(result, 2).reverted_by, late);
    assert.equal(pr(result, 3).is_revert, true);
  });

  test("a git revert pushed straight to the branch marks the PR it names, and stays uncounted", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    const original = repo.squash(12, "Add caching", {
      files: { "cache.js": "c\n" },
    });
    const revert = repo.commit(
      `Revert "Add caching (#12)"\n\nThis reverts commit ${original}.`,
      { files: { "cache.js": null } },
    );
    const result = scanRepo(repo);
    assert.deepEqual(
      result.prs.map((row) => row.number),
      [12],
    );
    assert.equal(pr(result, 12).reverted_by, revert);
    assert.equal(result.repos[0].direct_commits_ignored, 2);
  });
});

describe("default branch", () => {
  test("origin/HEAD's target wins over local main", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(1, "Landed", { files: { "a.js": "a\n" } });
    repo.git("branch", "trunk");
    repo.setOrigin({ branch: "trunk" });
    repo.squash(2, "Only local", { files: { "b.js": "b\n" } });
    const result = scanRepo(repo);
    assert.equal(result.repos[0].branch, "origin/trunk");
    assert.deepEqual(
      result.prs.map((row) => row.number),
      [1],
    );
  });

  test("a repo with no origin/HEAD falls back to origin/main, then local main", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(1, "Landed", { files: { "a.js": "a\n" } });
    repo.setOrigin({ head: false });
    repo.squash(2, "Only local", { files: { "b.js": "b\n" } });
    assert.equal(scanRepo(repo).repos[0].branch, "origin/main");
    assert.equal(scanRepo(repo).prs.length, 1);

    const local = newRepo();
    local.commit("Initial commit");
    local.squash(1, "Landed", { files: { "a.js": "a\n" } });
    assert.equal(scanRepo(local).repos[0].branch, "main");
    assert.equal(scanRepo(local).prs.length, 1);
  });

  test("a repo with no default branch is skipped with a warning, and --branch overrides", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.git("branch", "-m", "develop");
    repo.squash(1, "Landed", { files: { "a.js": "a\n" } });
    const skipped = scanRepo(repo);
    assert.equal(skipped.repos[0].branch, null);
    assert.equal(skipped.prs.length, 0);
    assert.match(skipped.repos[0].warnings[0], /no default branch.*--branch/);

    const overridden = scanRepo(repo, { branch: "develop" });
    assert.equal(overridden.repos[0].branch, "develop");
    assert.equal(overridden.prs.length, 1);
  });

  test("a repo git can't read is skipped with git's error, not a --branch hint", () => {
    const dir = join(root, "broken-worktree");
    mkdirSync(dir);
    writeFileSync(
      join(dir, ".git"),
      `gitdir: ${join(root, "deleted-gitdir")}\n`,
    );
    for (const branch of [null, "main"]) {
      for (const fetch of [false, true]) {
        const { warnings } = scanRepo(/** @type {Repo} */ ({ dir }), {
          branch,
          fetch,
        }).repos[0];
        assert.equal(warnings.length, 1);
        assert.match(
          warnings[0],
          /^skipped: git can't read this repo \(fatal: /,
        );
        assert.doesNotMatch(warnings[0], /--branch/);
      }
    }
  });

  test("--fetch fetches every remote, and a repo with none fetches without a warning", () => {
    const origin = newRepo();
    origin.commit("Initial commit");
    origin.squash(1, "First", { files: { "a.js": "a\n" } });
    const upstream = newRepo();
    upstream.commit("Unrelated start");
    const work = join(root, "fork-work");
    origin.git("clone", "-q", origin.dir, work);
    const clone = /** @type {Repo} */ ({ dir: work });
    origin.git("-C", work, "remote", "add", "upstream", upstream.dir);
    origin.git("-C", work, "fetch", "-q", "upstream");
    origin.git("-C", work, "branch", "-q", "-u", "upstream/main");
    origin.squash(2, "Second", { files: { "b.js": "b\n" } });
    assert.equal(scanRepo(clone, { allAuthors: true }).prs.length, 1);
    const fetched = scanRepo(clone, { allAuthors: true, fetch: true });
    assert.deepEqual(fetched.repos[0].warnings, []);
    assert.deepEqual(
      fetched.prs.map((row) => row.number),
      [1, 2],
    );
    assert.deepEqual(scanRepo(origin, { fetch: true }).repos[0].warnings, []);
  });

  test("a broken .git folder inside another repo is skipped, not read as the outer repo", () => {
    const outer = newRepo();
    outer.commit("Initial commit");
    outer.squash(9, "Outer work", { files: { "a.js": "a\n" } });
    const inner = join(outer.dir, "vendor", "inner");
    mkdirSync(join(inner, ".git"), { recursive: true });
    const result = scanRepo(/** @type {Repo} */ ({ dir: inner }), {
      allAuthors: true,
    });
    assert.deepEqual(result.prs, []);
    assert.match(result.repos[0].warnings[0], /^skipped: git can't read/);
  });
});

describe("finding repos", () => {
  test("a folder of repos at depth 1 and depth 2, skipping node_modules and dot-folders", () => {
    const folder = join(root, "workspace");
    for (const path of [
      "alpha",
      "group/beta",
      "node_modules/gamma",
      ".hidden/delta",
    ]) {
      const repo = new Repo(join(folder, path));
      repo.commit("Initial commit");
      repo.squash(1, `Work in ${path}`, { files: { "a.js": "a\n" } });
    }
    mkdirSync(join(folder, "not-a-repo"));
    const names = (/** @type {number} */ depth) =>
      scan(scanOptions([folder], { depth })).repos.map((repo) => repo.name);
    assert.deepEqual(names(1), ["alpha"]);
    assert.deepEqual(names(2), ["alpha", "beta"]);
  });

  test("the same commits in two clones count once", () => {
    const folder = join(root, "clones");
    const first = new Repo(join(folder, "one"));
    first.commit("Initial commit");
    first.squash(1, "Shared", { files: { "a.js": "a\n" } });
    first.git("clone", "-q", first.dir, join(folder, "two"));
    const result = scan(scanOptions([folder], { allAuthors: true }));
    assert.equal(result.prs.length, 1);
    assert.deepEqual(
      result.repos.map((repo) => repo.prs),
      [1, 0],
    );
    assert.match(result.repos[1].warnings[0], /already counted under one/);
  });

  test("a revert only a later clone holds still marks the PR kept from an earlier clone", () => {
    const upstream = new Repo(join(root, "clone-upstream"));
    upstream.commit("Initial commit");
    const original = upstream.squash(1, "Add caching", {
      files: { "cache.js": "c\n" },
    });
    const folder = join(root, "stale-clones");
    upstream.git("clone", "-q", upstream.dir, join(folder, "a-stale"));
    const revert = upstream.squash(2, 'Revert "Add caching (#1)"', {
      files: { "cache.js": null },
      body: `This reverts commit ${original}.`,
    });
    upstream.git("clone", "-q", upstream.dir, join(folder, "b-fresh"));
    const result = scan(scanOptions([folder], { allAuthors: true }));
    assert.equal(pr(result, 1).repo, "a-stale");
    assert.equal(pr(result, 1).reverted_by, revert);
    assert.equal(pr(result, 2).repo, "b-fresh");
  });

  test("repos sharing a folder name take as many parent folders as tell them apart", () => {
    assert.deepEqual(repoNames(["/w/work/x/app", "/w/oss/x/app", "/w/solo"]), [
      "work/x/app",
      "oss/x/app",
      "solo",
    ]);
  });

  test("a path that isn't a folder is an error naming it", () => {
    assert.throws(
      () => scan(scanOptions([join(root, "missing")])),
      /missing is not a folder/,
    );
  });

  test("each path must hold a repo", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    const empty = join(root, "empty-folder");
    mkdirSync(empty);
    assert.throws(
      () => scan(scanOptions([repo.dir, empty])),
      /no git repos found in .*empty-folder .* raise --depth/,
    );
  });
});

describe("authors", () => {
  /** Two authors, one of whom has committed under two emails merged by .mailmap. */
  function twoAuthorRepo() {
    const repo = newRepo();
    repo.commit("Initial commit", {
      files: {
        ".mailmap": `${DEV.name} <${DEV.email}> <dev.old@example.com>\n`,
      },
    });
    repo.squash(1, "Old email", {
      author: { name: "Dev Old", email: "dev.old@example.com" },
      files: { "a.js": "a\n" },
    });
    repo.squash(2, "New email", { files: { "b.js": "b\n" } });
    repo.squash(3, "Someone else", { author: OTHER, files: { "c.js": "c\n" } });
    return repo;
  }

  test(".mailmap merges one author's two emails, and the default is the repo's user.email", () => {
    const result = scanRepo(twoAuthorRepo());
    assert.deepEqual(
      result.prs.map((row) => row.number),
      [1, 2],
    );
    assert.deepEqual(
      new Set(result.prs.map((row) => row.author_email)),
      new Set([DEV.email]),
    );
    assert.deepEqual(result.options.authors, [DEV.email]);
    assert.equal(result.repos[0].prs, 2);
  });

  test("the default email goes through .mailmap", () => {
    const repo = newRepo({ email: "dev.old@example.com" });
    repo.commit("Initial commit", {
      files: {
        ".mailmap": `${DEV.name} <${DEV.email}> <dev.old@example.com>\n`,
      },
    });
    repo.squash(1, "Work", { files: { "a.js": "a\n" } });
    const result = scanRepo(repo);
    assert.equal(result.prs.length, 1);
    assert.deepEqual(result.options.authors, [DEV.email]);
  });

  test("--author matches regardless of case, by email or name, after .mailmap", () => {
    const repo = twoAuthorRepo();
    const byEmail = scanRepo(repo, { authors: ["DEV@Example.COM"] });
    assert.deepEqual(
      byEmail.prs.map((row) => row.number),
      [1, 2],
    );
    const byOldEmail = scanRepo(repo, { authors: ["Dev.Old@example.com"] });
    assert.deepEqual(
      byOldEmail.prs.map((row) => row.number),
      [1, 2],
    );
    const byName = scanRepo(repo, { authors: ["other person"] });
    assert.deepEqual(
      byName.prs.map((row) => row.number),
      [3],
    );
    assert.deepEqual(byName.options.authors, ["other person"]);
    for (const listed of [
      "Dev One <DEV@example.com>",
      "Dev One <dev@example.com> (2)",
    ]) {
      assert.deepEqual(
        scanRepo(repo, { authors: [listed] }).prs.map((row) => row.number),
        [1, 2],
      );
    }
  });

  test("--all-authors counts everyone and lists no authors", () => {
    const result = scanRepo(twoAuthorRepo(), { allAuthors: true });
    assert.equal(result.prs.length, 3);
    assert.deepEqual(result.options.authors, []);
    assert.equal(result.options.all_authors, true);
  });

  test("an author filter that matches no PRs warns with the authors found", () => {
    const repo = newRepo({ email: "nobody@example.com" });
    repo.commit("Initial commit");
    repo.squash(1, "One", { files: { "a.js": "a\n" } });
    repo.squash(2, "Two", { files: { "b.js": "b\n" } });
    repo.squash(3, "Three", { author: OTHER, files: { "c.js": "c\n" } });
    const result = scanRepo(repo);
    assert.equal(result.prs.length, 0);
    assert.equal(result.repos[0].warnings.length, 1);
    const [warning] = result.repos[0].warnings;
    assert.match(warning, /no PRs match the author filter/);
    assert.match(
      warning,
      /Dev One <dev@example\.com> \(2\), Other Person <other@example\.com> \(1\)/,
    );
    assert.match(warning, /--author/);
  });
});

describe("JSON output", () => {
  test("matches the schema, with rows sorted by merged_at and repos[].prs counting the filtered set", () => {
    const repo = newRepo();
    repo.commit("Initial commit", { date: "2026-03-01T09:00:00Z" });
    repo.squash(2, "Second", {
      files: { "b.js": "b\n" },
      date: "2026-03-02T09:00:00Z",
    });
    repo.squash(1, "First", {
      files: { "a.js": "a\n" },
      date: "2026-03-03T09:00:00Z",
    });
    repo.squash(3, "Outside range", {
      files: { "c.js": "c\n" },
      date: "2026-05-01T09:00:00Z",
    });
    const result = scanRepo(repo, {
      since: "2026-03-01",
      until: "2026-03-31",
      sinceMs: Date.UTC(2026, 2, 1),
      untilMs: Date.UTC(2026, 3, 1),
      timeZone: "Europe/London",
    });
    assert.deepEqual(Object.keys(result), [
      "generated_at",
      "options",
      "repos",
      "prs",
    ]);
    assert.equal(result.generated_at, "2026-10-17T21:00:00+01:00");
    assert.deepEqual(Object.keys(result.options), [
      "authors",
      "all_authors",
      "include_docs",
      "exclude",
      "since",
      "until",
      "timezone",
    ]);
    assert.deepEqual(result.options, {
      authors: [DEV.email],
      all_authors: false,
      include_docs: false,
      exclude: [],
      since: "2026-03-01",
      until: "2026-03-31",
      timezone: "Europe/London",
    });
    assert.deepEqual(Object.keys(result.repos[0]), [
      "name",
      "path",
      "branch",
      "prs",
      "direct_commits_ignored",
      "warnings",
    ]);
    assert.equal(result.repos[0].prs, 2);
    assert.deepEqual(Object.keys(result.prs[0]), [
      "repo",
      "sha",
      "number",
      "title",
      "method",
      "author_name",
      "author_email",
      "merged_at",
      "added",
      "removed",
      "lines",
      "excluded_lines",
      "score",
      "is_revert",
      "reverted_by",
    ]);
    assert.deepEqual(
      result.prs.map((row) => [row.number, row.merged_at]),
      [
        [2, "2026-03-02T09:00:00+00:00"],
        [1, "2026-03-03T09:00:00+00:00"],
      ],
    );
    assert.deepEqual(
      scanRepo(repo, { exclude: ["*.snap", "src/gen"] }).options.exclude,
      ["*.snap", "src/gen"],
    );
  });
});

describe("git environment", () => {
  /**
   * Runs `run` with GIT_DIR at `repo`, as a linked worktree's hooks get it.
   * @template T
   * @param {Repo} repo
   * @param {() => T} run
   */
  function withGitDir(repo, run) {
    process.env.GIT_DIR = join(repo.dir, ".git");
    try {
      return run();
    } finally {
      delete process.env.GIT_DIR;
    }
  }

  test("an inherited GIT_DIR doesn't redirect the scan", () => {
    const elsewhere = newRepo();
    elsewhere.commit("Initial commit");
    elsewhere.squash(1, "Elsewhere", { files: { "e.js": "e\n" } });
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(2, "Here", { files: { "h.js": "h\n" } });
    const result = withGitDir(elsewhere, () => scanRepo(repo));
    assert.deepEqual(
      result.prs.map((row) => row.number),
      [2],
    );
  });

  test("an inherited GIT_DIR doesn't redirect the fixtures' git commands", () => {
    const victim = newRepo();
    const head = victim.commit("Initial commit");
    const repo = withGitDir(victim, () => {
      const made = newRepo({ email: "made@example.com" });
      made.commit("Made here");
      return made;
    });
    assert.equal(victim.rev("HEAD"), head);
    assert.equal(victim.git("config", "user.email"), DEV.email);
    assert.equal(repo.git("log", "-1", "--format=%s"), "Made here");
  });

  test("config passed in the environment still reaches git", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(1, "Mine", { files: { "a.js": "a\n" } });
    repo.squash(2, "Theirs", { author: OTHER, files: { "b.js": "b\n" } });
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.email",
      GIT_CONFIG_VALUE_0: OTHER.email,
    });
    try {
      assert.deepEqual(
        scanRepo(repo).prs.map((row) => row.number),
        [2],
      );
    } finally {
      for (const name of [
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_VALUE_0",
      ]) {
        delete process.env[name];
      }
    }
  });
});
