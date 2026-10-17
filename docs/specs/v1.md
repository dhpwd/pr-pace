# pr-velocity – v1 spec

A command-line tool that measures PR velocity from git history: how many pull requests a person lands, how big they are and how often they get reverted, over time. It runs against one repo or a folder of repos and produces JSON and an interactive HTML report.

## Scope

**In v1**

- Merged pull requests on each repo's default branch, read from local git history
- Squash-merged and merge-commit PRs (GitHub and GitLab conventions)
- Three volume metrics (PR count, lines changed, combined score) and one quality check (revert rate)
- Filtering and breakdown by author, with `.mailmap` support
- `scan` (JSON) and `report` (self-contained HTML)

**Out of scope for v1**

- **Commits pushed straight to the default branch.** Commit frequency is personal habit, so commit counts aren't comparable between people. A possible later option: treat each day's direct commits as one PR-equivalent, comparable only with your own history
- **Rebase-merged PRs.** "Rebase and merge" lands each branch commit separately with no PR number, so local history can't group them. A later `--source github` option would read PRs from the GitHub API instead. That option would also handle organisation-wide runs without cloning, but it needs a token, works only with GitHub and can't apply the file exclusions in [Lines changed](#lines-changed)
- Bitbucket and other hosts' merge conventions

## Design decisions

These define what the numbers mean, so they're recorded here with the reason.

- **PRs, not commits, are the unit of build work.** A PR is the reviewed, landed unit in most teams' build workflow. Repos with no PRs (a notes vault, a dotfiles repo) drop out, so the tool needs no rule for which repos hold code
- **First-parent history only.** `git log --first-parent <default branch>` gives one commit per landed PR under both squash and merge-commit flows, so the two are counted the same way. Commits on PR branches are never counted individually
- **Lines changed = added + removed.** This matches the "changes" figure GitHub shows on a PR, so anyone can check it. Net growth (added − removed) would penalise refactoring and deleting dead code. Renames are detected, so moving a file doesn't count as deleting and re-adding it
- **Docs, lockfiles and generated files are excluded from lines by default.** Agents produce markdown quickly and at length, and nobody writes lockfiles or build output by hand. Tests and config count. A docs-only PR still counts as a PR but scores zero
- **Combined score = √lines per PR, summed.** Summing raw lines per PR is just total lines, so the PR count would add nothing. The square root gives each PR weight by size while stopping one huge PR from dominating. Known trade-off: splitting a change into several PRs scores somewhat higher than landing it as one. Any weighting that grows more slowly than size does this, and linear weighting rewards padding instead. Small PRs are good practice, so this is the acceptable direction
- **Revert rate as the quality check.** Volume can rise while quality falls. The share of PRs later reverted is cheap to detect and needs no setup

## Commands

The binary is `pr-velocity`, runnable with `npx pr-velocity`. Every command has full `--help` text. Errors say what went wrong and what to do instead (e.g. "no default branch found in ./foo – pass --branch").

### `pr-velocity scan [path...]`

Writes the scan result as JSON to stdout, or to `--out <file>`.

| Option                              | Default                            | Effect                                                                            |
| ----------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| `path...`                           | `.`                                | Each path is a repo, or a folder whose subfolders are repos                       |
| `--depth <n>`                       | `1`                                | How many folder levels below a path to look for repos                             |
| `--fetch`                           | off                                | Run `git fetch` in each repo first                                                |
| `--branch <name>`                   | detected                           | Override the default branch for every repo                                        |
| `--author <email\|name>`            | the repo's `git config user.email` | Count only this author (exact match, ignoring case, after `.mailmap`). Repeatable |
| `--all-authors`                     | off                                | Count every author (for team breakdowns)                                          |
| `--since <date>` / `--until <date>` | all history                        | Limit by merge date                                                               |
| `--include-docs`                    | off                                | Count docs files in lines changed                                                 |
| `--exclude <glob>`                  | none                               | Extra paths to leave out of lines changed. Repeatable                             |
| `--out <file>`                      | stdout                             | Write JSON to a file                                                              |

### `pr-velocity report [path...]`

Runs a scan with the same options and writes the HTML report.

| Option               | Default            | Effect                                                 |
| -------------------- | ------------------ | ------------------------------------------------------ |
| `--from <scan.json>` | –                  | Build the report from a saved scan instead of scanning |
| `--out <file>`       | `pr-velocity.html` | Where to write the report                              |
| `--open`             | off                | Open the report in the default browser                 |

## Behaviour

### Finding repos

- A path containing `.git` (directory or file) is a repo. Otherwise, search its subfolders down to `--depth`
- Skip `node_modules` and dot-folders when searching
- If the same commit SHA appears in two scanned repos (e.g. two clones), count it once

### Default branch

In order: the target of `refs/remotes/origin/HEAD`, then `origin/main`, then `origin/master`, then local `main`, then local `master`. Remote-tracking branches come first so the result reflects what has landed rather than local work. A repo with none of these is reported as a warning and skipped.

### Detecting PRs

Walk the default branch with `--first-parent`. For each commit:

| Pattern                                                                                                                  | Method   | PR number | Author                                       | Diff                                                      |
| ------------------------------------------------------------------------------------------------------------------------ | -------- | --------- | -------------------------------------------- | --------------------------------------------------------- |
| Two or more parents, subject `Merge pull request #N from …` (GitHub) or body containing `See merge request …!N` (GitLab) | `merge`  | N         | Author of the second parent (the branch tip) | First parent → merge commit                               |
| One parent, subject ending `(#N)`                                                                                        | `squash` | N         | Commit author                                | Parent → commit                                           |
| Anything else                                                                                                            | –        | –         | –                                            | Not counted. Tallied per repo as `direct_commits_ignored` |

- Merge time is the commit's committer date
- Author identities go through `.mailmap` (use `%aN` / `%aE`)
- The default author filter matches the email from `git config user.email` as seen from each repo, so per-repo config is respected
- If a repo has PRs but none match the author filter, add a warning to that repo naming the five most frequent PR authors found, with a hint to pass `--author`. This catches a local git email that differs from the one GitHub records on squash merges

### Lines changed

Per PR, from `git diff --numstat -M` over the diff in the table above:

- Binary files (numstat `-`) are ignored
- Excluded by default:
  - docs: `*.md`, `*.mdx`, `*.markdown`, `*.rst`, `*.adoc`, `*.txt`
  - lockfiles: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `Cargo.lock`, `poetry.lock`, `uv.lock`, `Gemfile.lock`, `composer.lock`, `go.sum`
  - build output: `*.min.js`, `*.min.css`, `*.map`, and anything under `dist/`, `build/`, `vendor/`, `node_modules/`
  - anything the repo's `.gitattributes` marks `linguist-generated`, `linguist-vendored` or `linguist-documentation` (check with `git check-attr --stdin` in one batch per repo)
- `--include-docs` drops the docs exclusion only. `--exclude` adds globs
- `lines = added + removed` over the files kept. Lines in excluded files are reported separately as `excluded_lines`
- `score = √lines`

### Reverts

- A PR is a revert if its subject starts `Revert "` or its message contains `This reverts commit <sha>`
- Link it to the original PR by that SHA where present, otherwise by matching the quoted subject (ignoring any `(#N)` suffix)
- Revert PRs are left out of PR count, lines and score. Reverting isn't progress
- The original PR is marked `reverted_by` and counts towards the revert rate of the period it was merged in
- Recent periods will understate the revert rate because their PRs have had less time to be reverted. The report says so beside the metric

### Periods

- Bucket by merge time in the local timezone
- Weeks start on Monday (ISO weeks)

## JSON output

```json
{
  "generated_at": "2026-10-17T21:00:00+01:00",
  "options": {
    "authors": ["…"],
    "include_docs": false,
    "since": null,
    "until": null
  },
  "repos": [
    {
      "name": "my-app",
      "path": "/home/me/code/my-app",
      "branch": "origin/main",
      "prs": 42,
      "direct_commits_ignored": 17,
      "warnings": []
    }
  ],
  "prs": [
    {
      "repo": "my-app",
      "sha": "…",
      "number": 35,
      "title": "Add retry with backoff to the export job",
      "method": "squash",
      "author_name": "…",
      "author_email": "…",
      "merged_at": "2026-10-14T10:12:00+01:00",
      "added": 120,
      "removed": 34,
      "lines": 154,
      "excluded_lines": 12,
      "score": 12.41,
      "is_revert": false,
      "reverted_by": null
    }
  ]
}
```

`title` has any `(#N)` suffix stripped. Rows are sorted by `merged_at`.

## HTML report

The report is one self-contained file. It embeds the scan JSON, makes no external requests and draws its charts as inline SVG with vanilla JS, so it works offline and when attached to a message.

**Controls**

- Date range: presets (last 30 days, 90 days, 12 months, all) plus custom from/to
- Period: day, week, month
- Metric: PRs, lines changed, score, revert rate
- Split: none, by repo, by author (author only when the scan used `--all-authors`)
- Repo filter: checkbox per repo, with all/none

**Display**

- Summary row for the selected range: PRs, lines, score, revert rate, each with the change against the previous range of equal length
- Bar chart of the selected metric per period, stacked when split, with a 4-period moving average line over the total
- Tooltip on hover with the period's values
- Clicking a bar lists that period's PRs (repo, number, title, lines, score) so any number can be traced to its PRs
- Light and dark themes following the system setting
- Usable at phone width

Selected controls are remembered in `localStorage`, with the page working normally if storage is unavailable.

## Implementation constraints

- Node 20 or later, ES modules, no runtime dependencies (`node:child_process`, `node:fs` and `parseArgs` from `node:util`)
- One `git log` call per repo for commits and numstat (`--first-parent --diff-merges=first-parent --numstat -M`), plus one batched call for second-parent authors and one `git check-attr --stdin`. No per-commit process spawning
- Read-only against scanned repos, apart from `--fetch`
- The repo will be made public. Keep personal details, private repo names and real data out of code, tests, fixtures and docs. Fixtures are generated, never copied from real repos

## Verification

- **Unit tests** (`node --test`) build throwaway fixture repos in a temp folder covering:
  - a squash-merged PR
  - a merge-commit PR whose branch commits must not be counted
  - a direct commit to the default branch (not counted)
  - a rename with a small edit (counts only the edit)
  - a PR touching a lockfile and a markdown file (both excluded, and the markdown counted under `--include-docs`)
  - a `.gitattributes` `linguist-generated` file (excluded)
  - a revert PR linked by SHA and one linked by subject
  - a repo with no `origin/HEAD` (falls back correctly)
  - a folder of repos at depth 1 and depth 2
  - two authors, with a `.mailmap` merging one author's two emails
  - `--author` matching regardless of case
  - an author filter that matches no PRs (warning lists the authors found)
- **Report check:** open the generated HTML, switch through each period, metric and split, click a bar and confirm the listed PRs add up to the bar's value
