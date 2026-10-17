# Git access

## A git wrapper that never throws

**Problem.** A scan covers many repos, and one repo's failure (no remote to fetch, a missing ref, git too old for an option) mustn't end the run for the rest.

**Solution.** Every git call goes through `git()` in `src/git.js`, which returns `{ ok, stdout, error }` and throws only when git can't be started at all. Each call site decides what a failure means for its repo and pushes a warning onto that repo's `warnings` (printed to stderr and kept in the JSON). The warning says what happened and what the tool did instead: "skipped: git log failed (…)", "git fetch failed (…) – scanned the local copy as it is".

**Anti-pattern.** `execFileSync`, which throws on a non-zero exit, or throwing from a call site. Either way one broken repo ends the whole scan.

## Batching inside the process budget

**Problem.** The per-repo git budget in `.claude/CLAUDE.md` allows no process per commit, but merge PRs need their branch tips' authors and every changed path needs its linguist attributes.

**Solution.** Collect the inputs from the one `git log` pass, then make a single call that takes them all: `git log --no-walk=unsorted --stdin` for second parents, `git check-attr -z --stdin` for paths and `git check-mailmap` with every email as an argument. Read machine output in NUL-separated form. The main log uses `-z` with `%x1e` before each record and `%x1f` between fields (`LOG_FORMAT` in `src/scan.js`), so messages and paths containing spaces or newlines can't break parsing. Under `-z --numstat` a rename shows an empty path, followed by the old and new paths as their own tokens.

**When to use.** Any new per-commit or per-path information: add a field to `LOG_FORMAT` or batch one stdin call, never loop over commits.
