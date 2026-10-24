# Tests

## Fixture repos

**Problem.** Tests need real git repos with controlled history, and the machine's git config (template hooks, a real identity, a default branch name) mustn't reach them or the scanner under test.

**Solution.** `tests/fixtures.js` builds throwaway repos in a temp folder through `Repo` (`commit`, `squash`, `mergePR`, `setOrigin`). Importing it sets `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` on `process.env`, so the scanner's own git calls are isolated as well as the fixture's. Every fixture git command runs under `repoFreeEnv()` from `src/git.js`, so a `GIT_DIR` inherited from a git hook can't point the fixtures at the real repo, and passes explicit author and committer identities and dates. Each repo starts with `init -b main` and a local `user.email`, which the default-author tests rely on. `setOrigin` writes `refs/remotes/origin/*` only and adds no remote, so a test that reads `origin`'s URL adds one with `repo.git("remote", "add", "origin", url)`. Tests scan with `scanOptions` from the same file: UTC, no filters and a fixed run time (`NOW`). Git's default message cleanup strips trailing whitespace, CRs included, so a test of CRLF messages passes `verbatim: true` to `commit` or `squash` and checks the CRs survived.

```js
const repo = new Repo(join(root, "app"));
repo.commit("Initial commit");
repo.squash(12, "Add retry", { files: { "src/app.js": "a\nb\n" } });
const result = scan(scanOptions([repo.dir]));
```

**When to use.** Any test that needs git history. The report check in `.claude/CLAUDE.md` builds its fixture repos with the same `Repo` class.

## Commands that count back from today

**Problem.** The live `pace` command takes its window from the real clock, but the `Repo` clock starts in January 2026 and `scanOptions` fixes `NOW`, so default fixture commits fall outside any window counted back from today.

**Solution.** Pass each commit a `date` relative to `Date.now()`, at least a day inside the window's edges, and set `TZ` on the spawned CLI. Read today with `dayOf` in the same zone just before and just after the spawn, and accept the line's date matching either, so a run across midnight still passes. To compare the lines of two runs (`pace --all-authors` against `--author`, or against `--from`), read the days before the first run and after the last, then check each line's day against them and replace it with a placeholder before comparing (`undated` in `tests/cli.test.js`). Window edges and arithmetic belong in unit tests against a scan with a fixed `generated_at` (`tests/pace.test.js`), leaving the live CLI test only the end-to-end line.

**Anti-pattern.** Asserting today's date computed once before the spawn, or comparing two runs' output as it stands. Both fail for runs that cross midnight.

## The package version

**Problem.** The version changes at every publish, and `VERSION` in `src/scan.js` is the value under test. A test that writes out `1.0.3` fails at the next bump, and one that compares with `VERSION` checks the code against itself.

**Solution.** Compare with `PKG.version` from `tests/fixtures.js`, which reads `package.json` directly, and build other versions from its major (`` `${major + 1}.2.3` ``) rather than writing them out.

```js
assert.equal(result.version, PKG.version);
```

**When to use.** Any test of the pr-pace version: the scan JSON's `version`, the pace line's `pr-pace vN`, `--version` and `pace --from`'s refusal of another major's scan.

## Test file layout

Test files are `tests/*.test.js`, with helpers beside them. `node --test` treats every file under a folder named `test/` as a test file, so the folder is `tests/` to keep helpers such as `fixtures.js` from running as tests.

## Running the suite on the Node floor

**Problem.** `npm run typecheck` checks against `@types/node` 22.x, which follows the newest 22 release. A call to an API added after 22.0 (`URL.parse`, `process.getBuiltinModule`, `parseArgs`'s `allowNegative`) passes the typecheck and the tests on a newer Node, then fails for a user on 22.0.

**Solution.** Run the suite on the floor release itself:

```sh
npx -y -p node@22.0.0 -- node --test
```

npm's `node` package supplies the binary. The CLI tests spawn `process.execPath`, so the commands they run are on 22.0.0 too.

**When to use.** A change that calls a Node built-in, or passes a `parseArgs` option, the code doesn't use yet.
