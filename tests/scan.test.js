import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { paceOf } from "../src/pace.js";
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

  test("weighted PRs are √(lines ÷ 100), to three decimals", () => {
    const repo = newRepo();
    const lines = (/** @type {number} */ n) =>
      Array.from({ length: n }, (_, i) => `${i}`).join("\n") + "\n";
    repo.commit("Initial commit");
    repo.squash(6, "Add file", { files: { "a.js": lines(154) } });
    repo.squash(7, "Add another", { files: { "b.js": lines(100) } });
    repo.squash(8, "Add a third", { files: { "c.js": lines(400) } });
    const result = scanRepo(repo);
    assert.equal(pr(result, 6).weighted_prs, 1.241);
    assert.equal(pr(result, 7).weighted_prs, 1);
    assert.equal(pr(result, 8).weighted_prs, 2);
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

describe("agent PRs", () => {
  // Public vendor identities: coding agents and a dependency bot.
  const DEVIN = {
    name: "devin-ai-integration[bot]",
    email: "158243242+devin-ai-integration[bot]@users.noreply.github.com",
  };
  const COPILOT = {
    name: "Copilot",
    email: "198982749+Copilot@users.noreply.github.com",
  };
  const COPILOT_COMMITS = {
    name: "copilot-swe-agent[bot]",
    email: "198982749+Copilot@users.noreply.github.com",
  };
  const CODEX_AGENT = {
    name: "openai-code-agent[bot]",
    email: "242516109+Codex@users.noreply.github.com",
  };
  const CODEX_ACCOUNT = {
    name: "Codex",
    email: "267193182+codex@users.noreply.github.com",
  };
  const CURSOR = { name: "Cursor Agent", email: "cursoragent@cursor.com" };
  const CURSOR_ALT = { name: "Cursor Agent", email: "cursor-agent@cursor.com" };
  const DEPENDABOT = {
    name: "dependabot[bot]",
    email: "49699333+dependabot[bot]@users.noreply.github.com",
  };
  // Public AI tool identities, as their own Co-authored-by: trailers name them.
  const CLAUDE = { name: "Claude", email: "noreply@anthropic.com" };
  const COPILOT_AUTOFIX = {
    name: "Copilot Autofix powered by AI",
    email: "175728472+Copilot@users.noreply.github.com",
  };
  const COPILOT_APP = {
    name: "Copilot App",
    email: "223556219+Copilot@users.noreply.github.com",
  };
  const CODEX = { name: "Codex", email: "noreply@openai.com" };
  const CODEX_ALT = { name: "Codex", email: "codex@openai.com" };
  const CODEX_HANDWRITTEN = {
    name: "Codex",
    email: "codex@users.noreply.github.com",
  };
  const OPENHANDS = { name: "openhands", email: "openhands@all-hands.dev" };
  const AMP = { name: "Amp", email: "amp@ampcode.com" };
  const GITHUB_COPILOT = {
    name: "GitHub Copilot",
    email: "copilot@github.com",
  };
  const JULES = { name: "Google Jules", email: "jules@google.com" };
  // An invented tool, for the no-reply@ form.
  const NO_REPLY_TOOL = { name: "Some AI tool", email: "no-reply@example.com" };
  const files = () => ({ [`f${++counter}.js`]: "x\n" });

  /** @param {...import('./fixtures.js').Identity} people */
  function trailers(...people) {
    return people
      .map(({ name, email }) => `Co-authored-by: ${name} <${email}>`)
      .join("\n");
  }

  /** @param {import('../src/scan.js').PrResult} row */
  function credit(row) {
    return {
      name: row.author_name,
      email: row.author_email,
      agent: row.agent_email,
    };
  }

  /** @param {import('./fixtures.js').Identity} identity */
  function label({ name, email }) {
    return `${name} <${email}>`;
  }

  test("a squash PR a GitHub App bot opened counts for the person its Co-authored-by: names", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(1, "Add export", {
      author: DEVIN,
      files: files(),
      body: trailers(DEV),
    });
    assert.deepEqual(credit(pr(scanRepo(repo), 1)), {
      name: DEV.name,
      email: DEV.email,
      agent: DEVIN.email,
    });
  });

  test("Copilot's squash address, Codex's agent address and Cursor's agent addresses are agents too", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    const agents = [COPILOT, CODEX_AGENT, CURSOR, CURSOR_ALT];
    agents.forEach((agent, i) =>
      repo.squash(i + 1, `Work ${i + 1}`, {
        author: agent,
        files: files(),
        body: trailers(OTHER),
      }),
    );
    assert.deepEqual(
      scanRepo(repo, { allAuthors: true }).prs.map(credit),
      agents.map((agent) => ({
        name: OTHER.name,
        email: OTHER.email,
        agent: agent.email,
      })),
    );
  });

  test("a merge-commit PR whose branch tip an agent wrote counts for the person the tip names", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.mergePR(4, "Add the widget", {
      author: COPILOT_COMMITS,
      commits: [
        { message: "Initial plan" },
        {
          message: `Add the widget\n\n${trailers(COPILOT_COMMITS, DEV)}`,
          files: files(),
        },
      ],
    });
    assert.deepEqual(credit(pr(scanRepo(repo), 4)), {
      name: DEV.name,
      email: DEV.email,
      agent: COPILOT_COMMITS.email,
    });
  });

  test("a merge-commit PR whose branch tip Codex's codex account wrote counts for the person the tip names", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.mergePR(4, "Add the widget", {
      author: CODEX_ACCOUNT,
      commits: [
        { message: "Draft the widget", files: files() },
        {
          message: `Add the widget\n\n${trailers(DEV)}`,
          files: files(),
        },
      ],
    });
    assert.deepEqual(credit(pr(scanRepo(repo), 4)), {
      name: DEV.name,
      email: DEV.email,
      agent: CODEX_ACCOUNT.email,
    });
  });

  test("the first person named wins, after any agent trailers, and the PR counts once", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(1, "Add search", {
      author: COPILOT,
      files: files(),
      body: `* Initial plan\n\n* Add search\n\n${trailers(COPILOT, DEV, OTHER)}`,
    });
    const result = scanRepo(repo, { allAuthors: true });
    assert.equal(result.prs.length, 1);
    assert.deepEqual(credit(pr(result, 1)), {
      name: DEV.name,
      email: DEV.email,
      agent: COPILOT.email,
    });
  });

  test("a trailer from Codex's coding agent or its codex account before the person is skipped as an agent", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    const agents = [CODEX_AGENT, CODEX_ACCOUNT];
    agents.forEach((agent, i) =>
      repo.squash(i + 1, `Work ${i + 1}`, {
        author: COPILOT,
        files: files(),
        body: trailers(agent, OTHER),
      }),
    );
    assert.deepEqual(
      scanRepo(repo, { allAuthors: true }).prs.map(credit),
      agents.map(() => ({
        name: OTHER.name,
        email: OTHER.email,
        agent: COPILOT.email,
      })),
    );
  });

  test("a mixed-case Co-Authored-By: with extra spacing or CRLF line endings is read", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(1, "Fix the parser", {
      author: CURSOR,
      files: files(),
      body: `Details.\n\n   Co-Authored-By:   ${OTHER.name}   <${OTHER.email}>`,
    });
    repo.squash(2, "Fix the lexer", {
      author: CURSOR,
      files: files(),
      body: `Details.\r\n\r\n${trailers(OTHER)}\r\n`,
      verbatim: true,
    });
    assert.equal(
      repo.git("log", "-1", "--format=%B").includes("\r\n"),
      true,
      "the fixture kept the CRLF line endings",
    );
    const result = scanRepo(repo, { allAuthors: true });
    assert.deepEqual(
      result.prs.map((row) => row.author_email),
      [OTHER.email, OTHER.email],
    );
  });

  test("an agent PR naming no person keeps the agent, with agent_email set", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(1, "Tidy", { author: DEVIN, files: files() });
    repo.squash(2, "Only agents named", {
      author: COPILOT,
      files: files(),
      body: trailers(COPILOT_COMMITS),
    });
    repo.squash(3, "No email or no name given", {
      author: CURSOR,
      files: files(),
      body: `Co-authored-by: ${OTHER.name} <>\nCo-authored-by: <${OTHER.email}>`,
    });
    assert.deepEqual(scanRepo(repo, { allAuthors: true }).prs.map(credit), [
      { name: DEVIN.name, email: DEVIN.email, agent: DEVIN.email },
      { name: COPILOT.name, email: COPILOT.email, agent: COPILOT.email },
      { name: CURSOR.name, email: CURSOR.email, agent: CURSOR.email },
    ]);
  });

  test("a person's PR keeps its author whoever it names as co-author", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(1, "Pair on it", { files: files(), body: trailers(OTHER) });
    assert.deepEqual(credit(pr(scanRepo(repo, { allAuthors: true }), 1)), {
      name: DEV.name,
      email: DEV.email,
      agent: null,
    });
  });

  test("a co-author goes through .mailmap, name and email", () => {
    const noreply = {
      name: "dev-one",
      email: "12345678+dev-one@users.noreply.github.com",
    };
    const repo = newRepo();
    // Keyed on the name too, so it matches only if the name is passed.
    repo.commit("Initial commit", {
      files: {
        ".mailmap": `${DEV.name} <${DEV.email}> ${noreply.name} <${noreply.email}>\n`,
      },
    });
    repo.squash(1, "Agent work", {
      author: CURSOR,
      files: files(),
      body: trailers(noreply),
    });
    assert.deepEqual(credit(pr(scanRepo(repo), 1)), {
      name: DEV.name,
      email: DEV.email,
      agent: CURSOR.email,
    });
  });

  test("an AI tool's trailer from a branch commit doesn't take the credit from the person after it", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(1, "Add export", {
      author: DEVIN,
      files: files(),
      body: `* Add export\n\n${trailers(CLAUDE)}\n\n${trailers(DEV)}`,
    });
    repo.squash(2, "Add import", {
      author: COPILOT,
      files: files(),
      body: `* Initial plan\n\n* Potential fix for pull request finding\n\n${trailers(COPILOT_AUTOFIX)}\n\n${trailers(COPILOT_COMMITS, DEV)}`,
    });
    assert.deepEqual(scanRepo(repo).prs.map(credit), [
      { name: DEV.name, email: DEV.email, agent: DEVIN.email },
      { name: DEV.name, email: DEV.email, agent: COPILOT.email },
    ]);
  });

  test("each AI tool pattern and listed address is skipped", () => {
    const tools = [
      COPILOT_APP,
      CODEX,
      NO_REPLY_TOOL,
      CODEX_ALT,
      CODEX_HANDWRITTEN,
      OPENHANDS,
      AMP,
      GITHUB_COPILOT,
      JULES,
    ];
    const repo = newRepo();
    repo.commit("Initial commit");
    tools.forEach((tool, i) =>
      repo.squash(i + 1, `Work ${i + 1}`, {
        author: CURSOR,
        files: files(),
        body: trailers(tool, OTHER),
      }),
    );
    assert.deepEqual(
      scanRepo(repo, { allAuthors: true }).prs.map(credit),
      tools.map(() => ({
        name: OTHER.name,
        email: OTHER.email,
        agent: CURSOR.email,
      })),
    );
  });

  test("a person whose address has noreply later in its local part isn't an AI tool", () => {
    const person = { name: "Dev One", email: "dev.noreply@example.com" };
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(1, "Agent work", {
      author: CURSOR,
      files: files(),
      body: trailers(person),
    });
    assert.deepEqual(credit(pr(scanRepo(repo, { allAuthors: true }), 1)), {
      name: person.name,
      email: person.email,
      agent: CURSOR.email,
    });
  });

  test("an agent PR naming only agents and AI tools keeps the agent, with agent_email set", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(1, "Tidy", {
      author: DEVIN,
      files: files(),
      body: trailers(CLAUDE, COPILOT_COMMITS, COPILOT_AUTOFIX),
    });
    assert.deepEqual(credit(pr(scanRepo(repo, { allAuthors: true }), 1)), {
      name: DEVIN.name,
      email: DEVIN.email,
      agent: DEVIN.email,
    });
  });

  test("an AI tool identity mapped to a person in .mailmap counts as that person", () => {
    const repo = newRepo();
    repo.commit("Initial commit", {
      files: { ".mailmap": `${DEV.name} <${DEV.email}> <${CLAUDE.email}>\n` },
    });
    repo.squash(1, "Agent work", {
      author: DEVIN,
      files: files(),
      body: trailers(CLAUDE, OTHER),
    });
    assert.deepEqual(credit(pr(scanRepo(repo, { allAuthors: true }), 1)), {
      name: DEV.name,
      email: DEV.email,
      agent: DEVIN.email,
    });
  });

  test("a person's PR naming an AI tool keeps its author, and an AI tool that authors a PR counts as a person", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(1, "Pair with Claude", {
      files: files(),
      body: trailers(CLAUDE),
    });
    repo.squash(2, "Claude's own PR", {
      author: CLAUDE,
      files: files(),
      body: trailers(OTHER),
    });
    assert.deepEqual(scanRepo(repo, { allAuthors: true }).prs.map(credit), [
      { name: DEV.name, email: DEV.email, agent: null },
      { name: CLAUDE.name, email: CLAUDE.email, agent: null },
    ]);
  });

  test("the default author filter and PR pace count an agent PR naming the repo's user.email", () => {
    const repo = newRepo();
    repo.commit("Initial commit", { date: "2026-10-01T10:00:00Z" });
    repo.squash(1, "Agent work", {
      author: DEVIN,
      files: { "a.js": "x\n".repeat(100) },
      body: trailers(DEV),
      date: "2026-10-10T10:00:00Z",
    });
    repo.squash(2, "Someone else's agent work", {
      author: DEVIN,
      files: { "b.js": "y\n".repeat(100) },
      body: trailers(OTHER),
      date: "2026-10-11T10:00:00Z",
    });
    const result = scanRepo(repo);
    assert.deepEqual(
      result.prs.map((row) => row.number),
      [1],
    );
    const pace = paceOf(result);
    assert.equal(pace.count, 1);
    assert.equal(pace.pace, 7 / 30);
  });

  test("a dependency bot's squash PR that names a person counts for them", () => {
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(1, "Bump the parser", {
      author: DEPENDABOT,
      files: files(),
      body: `Bumps the parser.\n\n${trailers(OTHER)}`,
    });
    assert.deepEqual(credit(pr(scanRepo(repo, { allAuthors: true }), 1)), {
      name: OTHER.name,
      email: OTHER.email,
      agent: DEPENDABOT.email,
    });
  });

  test("the no-match warning adds a hint for a coding agent it lists, and none for a dependency bot", () => {
    const repo = newRepo({ email: "nobody@example.com" });
    repo.commit("Initial commit");
    repo.squash(1, "One", { author: COPILOT, files: files() });
    repo.squash(2, "Two", { author: COPILOT, files: files() });
    repo.squash(3, "Bump", { author: DEPENDABOT, files: files() });
    assert.deepEqual(scanRepo(repo).repos[0].warnings, [
      `no PRs match the author filter. Most frequent PR authors: ${label(COPILOT)} (2), ${label(DEPENDABOT)} (1) – pass --author to choose, once for each of your identities. ${label(COPILOT)} is a coding agent with no co-author naming a person on these PRs – if only you use it, pass its email as an extra --author alongside your own or map it to yourself in .mailmap, otherwise turn on the agent's setting that adds you as co-author`,
    ]);

    const bots = newRepo({ email: "nobody@example.com" });
    bots.commit("Initial commit");
    bots.squash(1, "Bump", { author: DEPENDABOT, files: files() });
    assert.deepEqual(scanRepo(bots).repos[0].warnings, [
      `no PRs match the author filter. Most frequent PR authors: ${label(DEPENDABOT)} (1) – pass --author to choose, once for each of your identities`,
    ]);
  });

  test("the no-match warning's hint names Codex's coding agent", () => {
    const repo = newRepo({ email: "nobody@example.com" });
    repo.commit("Initial commit");
    repo.squash(1, "One", { author: CODEX_AGENT, files: files() });
    assert.deepEqual(scanRepo(repo).repos[0].warnings, [
      `no PRs match the author filter. Most frequent PR authors: ${label(CODEX_AGENT)} (1) – pass --author to choose, once for each of your identities. ${label(CODEX_AGENT)} is a coding agent with no co-author naming a person on these PRs – if only you use it, pass its email as an extra --author alongside your own or map it to yourself in .mailmap, otherwise turn on the agent's setting that adds you as co-author`,
    ]);
  });

  test("the no-match warning's hint names Codex's codex account on a merge-commit PR", () => {
    const repo = newRepo({ email: "nobody@example.com" });
    repo.commit("Initial commit");
    repo.mergePR(1, "One", {
      author: CODEX_ACCOUNT,
      commits: [{ message: "One", files: files() }],
    });
    assert.deepEqual(scanRepo(repo).repos[0].warnings, [
      "no PRs match the author filter. Most frequent PR authors: Codex <267193182+codex@users.noreply.github.com> (1) – pass --author to choose, once for each of your identities. Codex <267193182+codex@users.noreply.github.com> is a coding agent with no co-author naming a person on these PRs – if only you use it, pass its email as an extra --author alongside your own or map it to yourself in .mailmap, otherwise turn on the agent's setting that adds you as co-author",
    ]);
  });

  test("the hint names two or more coding agents in one sentence", () => {
    const plural =
      " are coding agents with no co-author naming a person on these PRs – if only you use them, pass their emails as extra --author values alongside your own or map them to yourself in .mailmap, otherwise turn on each agent's setting that adds you as co-author";
    const repo = newRepo({ email: "nobody@example.com" });
    repo.commit("Initial commit");
    repo.squash(1, "One", { author: COPILOT, files: files() });
    repo.squash(2, "Two", { author: DEVIN, files: files() });
    const [two] = scanRepo(repo).repos[0].warnings;
    assert.ok(
      two.endsWith(
        `choose, once for each of your identities. ${label(COPILOT)} and ${label(DEVIN)}${plural}`,
      ),
      two,
    );
    repo.squash(3, "Three", { author: CURSOR, files: files() });
    const [three] = scanRepo(repo).repos[0].warnings;
    assert.ok(
      three.endsWith(
        `choose, once for each of your identities. ${label(COPILOT)}, ${label(CURSOR)} and ${label(DEVIN)}${plural}`,
      ),
      three,
    );
  });

  test("Devin's and Copilot's id-less no-reply addresses aren't agents, coding agents or AI tools", () => {
    const devinIdLess = {
      name: DEVIN.name,
      email: "devin-ai-integration[bot]@users.noreply.github.com",
    };
    const copilotIdLess = {
      name: COPILOT.name,
      email: "copilot@users.noreply.github.com",
    };
    const repo = newRepo();
    repo.commit("Initial commit");
    repo.squash(1, "Bot work", {
      author: devinIdLess,
      files: files(),
      body: trailers(OTHER),
    });
    repo.squash(2, "Agent work", {
      author: CURSOR,
      files: files(),
      body: trailers(copilotIdLess, OTHER),
    });
    assert.deepEqual(scanRepo(repo, { allAuthors: true }).prs.map(credit), [
      { name: devinIdLess.name, email: devinIdLess.email, agent: null },
      {
        name: copilotIdLess.name,
        email: copilotIdLess.email,
        agent: CURSOR.email,
      },
    ]);

    const unmatched = newRepo({ email: "nobody@example.com" });
    unmatched.commit("Initial commit");
    unmatched.squash(1, "Bot work", { author: devinIdLess, files: files() });
    assert.deepEqual(scanRepo(unmatched).repos[0].warnings, [
      `no PRs match the author filter. Most frequent PR authors: ${label(devinIdLess)} (1) – pass --author to choose, once for each of your identities`,
    ]);
  });

  describe("the repo owner's no-reply address", () => {
    // Invented GitHub identities, in the forms Copilot's trailer and GitHub's
    // squash commit name a person by.
    const OWNER = {
      name: "dev-one",
      email: "1001+dev-one@users.noreply.github.com",
    };
    const OWNER_OLD = {
      name: "dev-one",
      email: "dev-one@users.noreply.github.com",
    };
    const TEAMMATE = {
      name: "dev-two",
      email: "1002+dev-two@users.noreply.github.com",
    };
    const ORIGIN = "https://github.com/dev-one/app.git";
    const reason =
      ", the GitHub no-reply address of this repo's owner, which the author filter doesn't match – if it's you, pass it as an extra --author alongside your own email, or map it to your usual identity in .mailmap";

    /**
     * A repo with `origin` at `url` (none when null), one of DEV's own PRs
     * and a Copilot PR naming `person`.
     * @param {string | null} url
     * @param {{ person?: import('./fixtures.js').Identity, email?: string, initial?: Record<string, string> }} [options]
     */
    function ownedRepo(url, { person = OWNER, email, initial } = {}) {
      const repo = newRepo({ email });
      repo.commit("Initial commit", { files: initial });
      if (url) repo.git("remote", "add", "origin", url);
      repo.squash(1, "Own work", { files: files() });
      repo.squash(2, "Agent work", {
        author: COPILOT,
        files: files(),
        body: trailers(person),
      });
      return repo;
    }

    test("PRs crediting it that the filter misses get a warning, one PR or more, under --author too", () => {
      const repo = ownedRepo(ORIGIN);
      const one = scanRepo(repo);
      assert.deepEqual(
        one.prs.map((row) => row.number),
        [1],
      );
      assert.deepEqual(one.repos[0].warnings, [
        `1 PR credits ${label(OWNER)}${reason}`,
      ]);
      assert.deepEqual(
        scanRepo(repo, { authors: [DEV.email] }).repos[0].warnings,
        [`1 PR credits ${label(OWNER)}${reason}`],
      );
      repo.squash(3, "More agent work", {
        author: COPILOT,
        files: files(),
        body: trailers(OWNER),
      });
      assert.deepEqual(scanRepo(repo).repos[0].warnings, [
        `2 PRs credit ${label(OWNER)}${reason}`,
      ]);
    });

    test("a squash PR GitHub recorded under it warns too, counted with its agent PRs", () => {
      const repo = newRepo();
      repo.commit("Initial commit");
      repo.git("remote", "add", "origin", ORIGIN);
      repo.squash(1, "Own work", { files: files() });
      repo.squash(2, "Merged with email privacy on", {
        author: OWNER,
        files: files(),
      });
      assert.deepEqual(scanRepo(repo).repos[0].warnings, [
        `1 PR credits ${label(OWNER)}${reason}`,
      ]);
      repo.squash(3, "Agent work", {
        author: COPILOT,
        files: files(),
        body: trailers(OWNER),
      });
      assert.deepEqual(scanRepo(repo).repos[0].warnings, [
        `2 PRs credit ${label(OWNER)}${reason}`,
      ]);
    });

    test("each origin URL form, the owner in any case and the id-less address all warn", () => {
      const repo = ownedRepo(ORIGIN);
      for (const url of [
        "git@github.com:Dev-One/app.git",
        "ssh://git@github.com/dev-one/app.git",
        "ssh://git@github.com:22/dev-one/app",
        "https://x-access-token:secret@GitHub.com/dev-one/app",
        "https://github.com/dev-one/app/",
      ]) {
        repo.git("remote", "set-url", "origin", url);
        assert.deepEqual(
          scanRepo(repo).repos[0].warnings,
          [`1 PR credits ${label(OWNER)}${reason}`],
          url,
        );
      }
      assert.deepEqual(
        scanRepo(ownedRepo(ORIGIN, { person: OWNER_OLD })).repos[0].warnings,
        [`1 PR credits ${label(OWNER_OLD)}${reason}`],
      );
    });

    test("no warning for another login, no origin, another host, --all-authors or an address the filter matches", () => {
      const owned = ownedRepo(ORIGIN);
      const cases = [
        scanRepo(ownedRepo(ORIGIN, { person: TEAMMATE })),
        scanRepo(ownedRepo(null)),
        scanRepo(ownedRepo("https://gitlab.com/dev-one/app.git")),
        scanRepo(owned, { allAuthors: true }),
        scanRepo(owned, { authors: [DEV.email, OWNER.email] }),
        scanRepo(
          ownedRepo(ORIGIN, {
            initial: {
              ".mailmap": `${DEV.name} <${DEV.email}> <${OWNER.email}>\n`,
            },
          }),
        ),
      ];
      for (const result of cases)
        assert.deepEqual(result.repos[0].warnings, []);
    });

    test("it warns beside the no-match warning, and beside the no user.email warning", () => {
      const unmatched = ownedRepo(ORIGIN, { email: "nobody@example.com" });
      assert.deepEqual(scanRepo(unmatched).repos[0].warnings, [
        `no PRs match the author filter. Most frequent PR authors: ${label(DEV)} (1), ${label(OWNER)} (1) – pass --author to choose, once for each of your identities`,
        `1 PR credits ${label(OWNER)}${reason}`,
      ]);

      const unset = ownedRepo(ORIGIN);
      unset.git("config", "--unset", "user.email");
      assert.deepEqual(scanRepo(unset).repos[0].warnings, [
        "no git config user.email set for this repo, so no PRs count as yours – pass --author, once for each of your identities, or --all-authors",
        `no PRs match the author filter. Most frequent PR authors: ${label(DEV)} (1), ${label(OWNER)} (1) – pass --author to choose, once for each of your identities`,
        `1 PR credits ${label(OWNER)}${reason}`,
      ]);
    });
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
      "agent_email",
      "merged_at",
      "added",
      "removed",
      "lines",
      "excluded_lines",
      "weighted_prs",
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
