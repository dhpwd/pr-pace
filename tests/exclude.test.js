import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { globMatcher, pathExcluder } from "../src/exclude.js";

describe("default exclusions", () => {
  const excluded = pathExcluder({ includeDocs: false, globs: [] });

  test("leave out docs, lockfiles and build output, and keep code, tests and config", () => {
    for (const path of [
      "README.md",
      "docs/Guide.MDX",
      "notes.txt",
      "a/b/yarn.lock",
      "Cargo.lock",
      "go.sum",
      "web/app.min.js",
      "web/app.js.map",
      "dist/index.js",
      "packages/ui/build/out.css",
      "vendor/lib.php",
      "node_modules/x/index.js",
    ]) {
      assert.equal(excluded(path), true, path);
    }
    for (const path of [
      "src/index.js",
      "test/index.test.js",
      "package.json",
      "tsconfig.json",
      "src/distance.js",
    ]) {
      assert.equal(excluded(path), false, path);
    }
  });

  test("--include-docs drops only the docs exclusion", () => {
    const withDocs = pathExcluder({ includeDocs: true, globs: [] });
    assert.equal(withDocs("README.md"), false);
    assert.equal(withDocs("package-lock.json"), true);
  });
});

describe("--exclude globs", () => {
  test("a glob without a slash matches a name at any depth", () => {
    const snap = globMatcher("*.snap");
    assert.equal(snap("a.snap"), true);
    assert.equal(snap("src/__snapshots__/a.snap"), true);
    assert.equal(snap("a.snapshot"), false);
    const fixtures = globMatcher("fixtures");
    assert.equal(fixtures("test/fixtures/data.json"), true);
    assert.equal(fixtures("test/fixtures.js"), false);
  });

  test("a glob with a slash is anchored at the repo root", () => {
    const generated = globMatcher("src/gen");
    assert.equal(generated("src/gen/a.ts"), true);
    assert.equal(generated("lib/src/gen/a.ts"), false);
    const nested = globMatcher("src/**/*.gen.ts");
    assert.equal(nested("src/a.gen.ts"), true);
    assert.equal(nested("src/x/y/a.gen.ts"), true);
    assert.equal(nested("src/x/a.ts"), false);
    assert.equal(globMatcher("/api/*.json")("api/schema.json"), true);
    assert.equal(globMatcher("api/*.json")("api/v1/schema.json"), false);
    assert.equal(globMatcher("api/")("api/v1/schema.json"), true);
  });

  test("? matches one character and other characters are literal", () => {
    assert.equal(globMatcher("v?.json")("v1.json"), true);
    assert.equal(globMatcher("v?.json")("v10.json"), false);
    assert.equal(globMatcher("a+b(1).js")("a+b(1).js"), true);
    assert.equal(globMatcher("a.js")("abjs"), false);
  });
});
