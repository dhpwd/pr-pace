# pr-velocity

Measure PR velocity from local git history: how many pull requests a person lands, how big they are and how often they get reverted, over time. Point it at one repo or a folder of repos and it writes JSON or a self-contained HTML report.

It counts merged PRs on each repo's default branch – squash merges and merge commits, using GitHub and GitLab conventions – and reports five figures per day, week or month:

- **PRs** – merged PRs, leaving out revert PRs
- **Size-weighted PRs** – PRs adjusted for size. Each PR counts √(lines ÷ 100), so a 100-line PR counts 1, a 400-line PR 2 and a 25-line PR 0.5
- **Median PR size** – lines changed by the middle PR. It's context for reading PRs and size-weighted PRs (did PRs get bigger or smaller?), not a target
- **Lines changed** – added + removed, leaving out docs, lockfiles, build output and files `.gitattributes` marks as generated
- **Revert rate** – the share of PRs later reverted

Size-weighted PRs rest on a convention, not a measured law: the 100-line reference is fixed rather than taken from your data, so figures compare between people and over time. They work best for tracking one team over time. Comparing teams across languages or stacks misleads, because a line carries a different amount of work in each and the default exclusions shape the number.

Everything is read from local history, so no token or API access is needed.

## Install

Needs Node 20 or later and git. With git older than 2.40 the `.gitattributes` exclusions are skipped, with a warning. From a checkout of this repo:

```sh
npm install --global .
```

That puts `pr-velocity` on your PATH. To run it without installing, use `npx .` from the checkout in place of `pr-velocity` below.

## Commands

### `pr-velocity scan [path...]`

Scans each path – a repo, or a folder whose subfolders are repos – and writes the result as JSON to stdout.

```sh
pr-velocity scan ~/code --since 2026-01-01 --out scan.json
```

By default it counts the PRs authored by each repo's `git config user.email`. Pass `--author <email|name>` (repeatable) for someone else, or `--all-authors` for a team view. Other options limit the date range, set the folder search depth, override the default branch, fetch first and adjust which files count towards lines changed – `pr-velocity scan --help` lists them all.

### `pr-velocity report [path...]`

Scans with the same options and writes `pr-velocity.html`: a single file with charts by day, week or month, splits by repo or author, and the list of PRs behind each bar. It makes no network requests, so it works offline and as an attachment.

```sh
pr-velocity report ~/code --open
pr-velocity report --from scan.json --out velocity.html
```

`pr-velocity report --help` lists the options.

## How the numbers are defined

[`docs/specs/v1.md`](docs/specs/v1.md) sets out what counts as a PR, which lines count, how reverts are detected and linked, the JSON schema and the report's behaviour.
