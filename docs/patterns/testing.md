# Tests

## Fixture repos

**Problem.** Tests need real git repos with controlled history, and the machine's git config (template hooks, a real identity, a default branch name) mustn't reach them or the scanner under test.

**Solution.** `tests/fixtures.js` builds throwaway repos in a temp folder through `Repo` (`commit`, `squash`, `mergePR`, `setOrigin`). Importing it sets `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` on `process.env`, so the scanner's own git calls are isolated as well as the fixture's. Every fixture git command passes explicit author and committer identities and dates. Each repo starts with `init -b main` and a local `user.email`, which the default-author tests rely on. Tests scan with `scanOptions` from the same file: UTC, no filters and a fixed run time (`NOW`).

```js
const repo = new Repo(join(root, "app"));
repo.commit("Initial commit");
repo.squash(12, "Add retry", { files: { "src/app.js": "a\nb\n" } });
const result = scan(scanOptions([repo.dir]));
```

**When to use.** Any test that needs git history. The report check in `.claude/CLAUDE.md` builds its fixture repos with the same `Repo` class.

## Test file layout

Test files are `tests/*.test.js`, with helpers beside them. `node --test` treats every file under a folder named `test/` as a test file, so the folder is `tests/` to keep helpers such as `fixtures.js` from running as tests.
