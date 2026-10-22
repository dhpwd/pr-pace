import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { globMatcher, pathExcluder } from "../src/exclude.js";

const LOCKFILES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "npm-shrinkwrap.json",
  "deno.lock",
  "Pipfile.lock",
  "pdm.lock",
  "pixi.lock",
  "Package.resolved",
  "flake.lock",
  "MODULE.bazel.lock",
  ".terraform.lock.hcl",
  "mise.lock",
  "Manifest.toml",
  "JuliaManifest.toml",
  "Gopkg.lock",
  "glide.lock",
  "pubspec.lock",
  "mix.lock",
  "Podfile.lock",
  "gradle.lockfile",
  "buildscript-gradle.lockfile",
  "packages.lock.json",
  "go.work.sum",
  "pylock.toml",
  "Cartfile.resolved",
  "shard.lock",
  "rebar.lock",
  "stack.yaml.lock",
  "renv.lock",
  "conan.lock",
  "paket.lock",
  "settings-gradle.lockfile",
  "Chart.lock",
  "packages-lock.json",
  "cpanfile.snapshot",
  "cabal.project.freeze",
];

const DOC_NAMES = [
  "LICENSE",
  "LICENCE",
  "UNLICENSE",
  "UNLICENCE",
  "COPYING",
  "COPYRIGHT",
  "PATENTS",
  "NOTICE",
  "AUTHORS",
  "COPYING.LESSER",
  "COPYING.LIB",
  "MIT-LICENSE",
  "README",
  "CHANGELOG",
  "CHANGES",
  "CONTRIBUTING",
  "NEWS",
  "THANKS",
  "TODO",
];

describe("default exclusions", () => {
  const excluded = pathExcluder({ includeDocs: false, globs: [] });

  test("leave out every listed lockfile at any depth, matching its case exactly", () => {
    for (const name of LOCKFILES) {
      assert.equal(excluded(name), true, name);
      assert.equal(excluded(`a/b/${name}`), true, `a/b/${name}`);
    }
    assert.equal(excluded("pubspec.LOCK"), false);
  });

  test("leave out licence, notice and docs files by name, ignoring case", () => {
    for (const name of DOC_NAMES) {
      for (const path of [
        name,
        name.toLowerCase(),
        `a/b/${name}`,
        `a/b/${name.toLowerCase()}`,
      ]) {
        assert.equal(excluded(path), true, path);
      }
    }
    for (const path of [
      "LICENSE-MIT",
      "LICENSE-APACHE",
      "licence_mit",
      "COPYRIGHT-2026",
      "COPYING_GPL",
      "a/b/LICENSE-MIT",
    ]) {
      assert.equal(excluded(path), true, path);
    }
  });

  test("leave out RDoc, Textile, Pod and AsciiDoc files, and count site configs named after a domain", () => {
    for (const path of [
      "README.rdoc",
      "docs/guide.TEXTILE",
      "lib/Foo/Bar.pod",
      "docs/manual.asciidoc",
    ]) {
      assert.equal(excluded(path), true, path);
    }
    assert.equal(excluded("lib/Foo/Bar.pm"), false);
    assert.equal(excluded("nginx/sites-available/example.org"), false);
  });

  test("count files whose names only resemble a docs name", () => {
    for (const path of [
      "install",
      "INSTALL",
      "inst/CITATION",
      "bin/check-license",
      "license.js",
      "authors.py",
      "src/readme.ts",
      "LICENSE.APACHE",
      "notices",
      "README-alpha.sh",
      "scripts/copyright_header.py",
    ]) {
      assert.equal(excluded(path), false, path);
    }
  });

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

  test("count a file named after a build folder, at the root and nested", () => {
    for (const path of ["build", "dist", "scripts/build", "lib/dist"]) {
      assert.equal(excluded(path), false, path);
    }
  });

  test("count config .txt files and leave out prose .txt files", () => {
    for (const path of [
      "requirements.txt",
      "requirements-dev.txt",
      "dev-requirements.txt",
      "requirements_test.txt",
      "constraints.txt",
      "requirements/base.txt",
      "app/requirements/dev.txt",
      "requirements/ci/py311.txt",
      "CMakeLists.txt",
      "src/lib/CMakeLists.txt",
      "robots.txt",
      "public/robots.txt",
      "REQUIREMENTS.TXT",
    ]) {
      assert.equal(excluded(path), false, path);
    }
    for (const path of [
      "notes.txt",
      "LICENSE.txt",
      "CHANGELOG.txt",
      "llms.txt",
      "public/llms-full.txt",
      "docs/guide.TXT",
      "requirements.md",
      "requirements/README.md",
    ]) {
      assert.equal(excluded(path), true, path);
    }
  });

  test("config .txt files under build output or an --exclude glob stay excluded", () => {
    assert.equal(excluded("node_modules/x/requirements.txt"), true);
    assert.equal(excluded("vendor/CMakeLists.txt"), true);
    const globbed = pathExcluder({ includeDocs: false, globs: ["robots.txt"] });
    assert.equal(globbed("robots.txt"), true);
    assert.equal(globbed("public/robots.txt"), true);
  });

  test("--include-docs drops only the docs exclusion", () => {
    const withDocs = pathExcluder({ includeDocs: true, globs: [] });
    assert.equal(withDocs("README.md"), false);
    assert.equal(withDocs("package-lock.json"), true);
  });

  test("--include-docs counts docs names and keeps every lockfile excluded", () => {
    const withDocs = pathExcluder({ includeDocs: true, globs: [] });
    assert.equal(withDocs("LICENSE"), false);
    assert.equal(withDocs("README"), false);
    assert.equal(withDocs("LICENSE-MIT"), false);
    for (const name of LOCKFILES) assert.equal(withDocs(name), true, name);
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
    assert.equal(globMatcher("/api")("api/v1/schema.json"), true);
    assert.equal(globMatcher("/api")("lib/api/x.js"), false);
    assert.equal(globMatcher("api/")("lib/api/x.js"), true);
  });

  test("a glob with a trailing slash matches folders only", () => {
    const build = globMatcher("build/");
    assert.equal(build("build/x.js"), true);
    assert.equal(build("lib/build/x.js"), true);
    assert.equal(build("scripts/build"), false);
    assert.equal(build("build"), false);
    const api = globMatcher("/api/");
    assert.equal(api("api/x.js"), true);
    assert.equal(api("api"), false);
    assert.equal(globMatcher("/api")("api"), true);
    const wildcard = globMatcher("gen*/");
    assert.equal(wildcard("src/generated/a.ts"), true);
    assert.equal(wildcard("src/generated.ts"), false);
    const generated = globMatcher("src/**/");
    assert.equal(generated("src/gen/a.ts"), true);
    assert.equal(generated("src/a.ts"), false);
  });

  test("? matches one character and other characters are literal", () => {
    assert.equal(globMatcher("v?.json")("v1.json"), true);
    assert.equal(globMatcher("v?.json")("v10.json"), false);
    assert.equal(globMatcher("a+b(1).js")("a+b(1).js"), true);
    assert.equal(globMatcher("a.js")("abjs"), false);
  });

  test("* matches dotfiles, and brackets, braces and case match literally", () => {
    assert.equal(globMatcher("*.json")(".eslintrc.json"), true);
    assert.equal(globMatcher("[ab].js")("[ab].js"), true);
    assert.equal(globMatcher("[ab].js")("a.js"), false);
    assert.equal(globMatcher("{a,b}.js")("{a,b}.js"), true);
    assert.equal(globMatcher("{a,b}.js")("a.js"), false);
    assert.equal(globMatcher("*.SNAP")("a.snap"), false);
  });
});
