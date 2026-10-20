# pr-pace

PR pace is the size-weighted PRs you merged per week over the last 30 days, where each PR counts √(lines ÷ 100): a 100-line PR counts 1 and a 400-line PR 2. One command prints it as a line to post:

```sh
npx pr-pace pace <path>
```

```
PR pace 69.1/wk · 30 days to 2026-10-19 · 100 PRs · median 500 lines · pr-pace v1
```

Post the whole line, so the window, PR count, median PR size and version go with the figure. Read it with its limits in mind:

- It measures delivered change – code that landed and stayed – not effort. Revert PRs and PRs since reverted count zero, so a later run can lower a figure as reverts land
- A few large PRs carry much of it, and below about five PRs a week it's noisy
- A stack that needs more lines for the same change scores higher, so comparing people across stacks is weak. It's strongest as you against your own history
- Only merged PRs on the default branch of the repos you scan count. Commits pushed straight to the branch and repos left out of the scan don't show

For the history behind it, write the report and open it:

```sh
npx pr-pace report <path> --open
```

pr-pace reads local git history: how many pull requests a person lands, how big they are and how often they get reverted, over time. Point it at one repo or a folder of repos and it prints a one-line PR pace or writes JSON or a self-contained HTML report.

It counts merged PRs on each repo's default branch – squash merges and merge commits, using GitHub and GitLab conventions – and reports five figures per day, week or month:

- **PRs** – merged PRs, leaving out revert PRs
- **Size-weighted PRs** – PRs adjusted for size. Each PR counts √(lines ÷ 100), so a 100-line PR counts 1, a 400-line PR 2 and a 25-line PR 0.5
- **Median PR size** – lines changed by the middle PR. It's context for reading PRs and size-weighted PRs (did PRs get bigger or smaller?), not a target
- **Lines changed** – added + removed, leaving out docs, lockfiles, build output and files `.gitattributes` marks as generated
- **Revert rate** – the share of PRs later reverted

Size-weighted PRs rest on a convention, not a measured law: the 100-line reference is fixed rather than taken from your data, so figures compare between people and over time. They work best for tracking one team over time. Comparing teams across languages or stacks misleads, because a line carries a different amount of work in each and the default exclusions shape the number.

Everything is read from local history, so no token or API access is needed.

## Install

Needs Node 22 or later and git. With git older than 2.40 the `.gitattributes` exclusions are skipped, with a warning. From a checkout of this repo:

```sh
npm install --global .
```

That puts `pr-pace` on your PATH. To run it without installing, use `npx .` from the checkout in place of `pr-pace` below.

## Commands

### `pr-pace pace [path...]`

Scans each path – a repo, or a folder whose subfolders are repos – and prints your PR pace line to stdout. The line covers the 30 days to today, today included, in this machine's timezone, and sums across every repo scanned.

```sh
pr-pace pace ~/code
pr-pace pace --from scan.json
```

It takes `--author` (repeatable, for one person's several identities), `--exclude`, `--depth`, `--branch` and `--fetch` as `scan` does. It refuses `--since`, `--until`, `--all-authors` and `--include-docs`, so every line covers one person's last 30 days and counts lines the same way. `--exclude` stays for generated code the default rules miss, and can only lower the figure. `--from <scan.json>` prints the line from a saved scan, counting back from the day the scan ran. `pr-pace pace --help` lists the options.

### `pr-pace scan [path...]`

Scans each path and writes the result as JSON to stdout.

```sh
pr-pace scan ~/code --since 2026-01-01 --out scan.json
```

By default it counts the PRs authored by each repo's `git config user.email`. Pass `--author <email|name>` for someone else, or `--all-authors` for a team view. Any `--author` replaces that default in every repo, so to count your own PRs under several identities, pass `--author` once for each of them. Other options limit the date range, set the folder search depth, override the default branch, fetch first and adjust which files count towards lines changed – `pr-pace scan --help` lists them all.

### `pr-pace report [path...]`

Scans with the same options and writes `pr-pace.html`: a single file with charts by day, week or month, splits by repo or author, and the list of PRs behind each bar. It makes no network requests, so it works offline and as an attachment.

```sh
pr-pace report ~/code --open
pr-pace report --from scan.json --out report.html
```

`pr-pace report --help` lists the options.

## PRs opened by coding agents

A PR that a coding agent such as Copilot's coding agent, Codex's coding agent, Devin or Cursor's cloud agents opened under its own identity counts for the person the agent names in a `Co-authored-by:` trailer, not for the agent. Copilot, Codex and Cursor name you by your GitHub no-reply address (`<id>+<login>@users.noreply.github.com`), which may not be your git email, so by default those PRs don't count as yours. In a repo under your own GitHub account, the repo's warning names your no-reply address when PRs credit it and your filter misses it – agent PRs, or your own squash PRs merged with email privacy on. Elsewhere nothing warns you unless none of a repo's PRs match you, in which case the warning lists the PR authors it found. Pass the no-reply address as an extra `--author` alongside your own email, or map it to your usual identity in the repo's `.mailmap`:

```
Your Name <you@example.com> <12345678+your-login@users.noreply.github.com>
```

An agent PR that names no one stays with the agent. When that agent is among the authors the no-match warning lists, the warning says how to claim its PRs.

## How the numbers are defined

[`docs/specs/v1.md`](docs/specs/v1.md) sets out what PR pace counts and its limits, what counts as a PR, which lines count, how reverts are detected and linked, the JSON schema and the report's behaviour.
