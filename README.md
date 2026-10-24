# pr-pace

pr-pace uses your local git history to measure how much code you land and prints it as one line you can post.

What's your PRP?

## Try it

Inside a repo you merge PRs into, run:

```sh
npx pr-pace pace
npx pr-pace report --open
```

(The first time you run them, npx asks to install pr-pace. Answer y.)

The first prints your PR pace:

```
PR pace 69.1/wk · 30 days to 2026-10-19 · 100 PRs · median 500 lines · pr-pace v1
```

The second writes a report of your PRs over time to `pr-pace.html` in the current folder and opens it. To cover several repos at once, point either command at the folder that holds them, as in `npx pr-pace pace ~/code`. You need Node 22 or later and git.

![A pr-pace report: summary tiles for PRs, weighted PRs, median PR size, lines changed and revert rate, above a bar chart of weighted PRs per week](https://raw.githubusercontent.com/dhpwd/pr-pace/main/docs/report.png)

pr-pace never sees your code. It asks git for each commit's author, date and message and for how many lines each file gained and lost. It only runs git commands that read, such as `git log`, so it never commits or changes branches or config, and it writes nothing but the report or JSON file you ask for. The one exception is `--fetch`, which runs `git fetch` first. It makes no network requests, needs no token and sends nothing anywhere. It has no dependencies, so `npx` downloads only its own source, which you can read in this repo.

## Why PR pace

The sample line above says that in the 30 days to the date shown, you merged 100 PRs with a median size of 500 lines, and together they add up to 69.1 size-weighted PRs a week.

PR count is the obvious measure, but PRs vary hugely in size, so ten 10-line PRs count ten times as much as one 1,000-line PR. Lines changed says the reverse, and a few large PRs dominate it. PR pace sits between the two. Each PR counts √(lines ÷ 100), so a 100-line PR counts 1, a 400-line PR counts 2 and ten 10-line PRs count the same as one 1,000-line PR.

Any weighting by size can be gamed in two ways: by splitting a change into more PRs or by padding PRs with lines. PR count rewards splitting in full and lines changed rewards padding in full, but under √ each raises the figure only by the square root of the factor: the same 1,000 lines landed as 4 PRs count 2× what they do as 1 PR, and a PR padded to twice its lines counts about 1.4×. The square root also fits the only public data on how work grows with PR size ([Graphite's time-to-merge figures](https://graphite.com/blog/the-ideal-pr-is-50-lines-long)), which put review time at lines to a power of roughly 0.26–0.66, and √ is a power of 0.5. A log weighting would track human effort instead, which shrinks as agents write more of the code.

PR pace measures delivered change (code that landed and stayed) rather than the effort behind it. A PR that was later reverted delivered nothing that stayed, so it counts zero. Its strongest use is comparing yourself with your own history, to see whether a change in how you work shows up in what you land. When you post it, post the whole line, so the window, PR count, median PR size and version go with the figure.

## How it works

pr-pace walks the first-parent history of each repo's default branch, which gives one commit per merged PR whether the repo squash-merges or uses merge commits. It recognises PRs by GitHub's and GitLab's merge conventions. Commits pushed straight to the branch don't count, and nor do PRs landed with "Rebase and merge", which leaves no PR number in history.

By default it counts the PRs authored by each repo's `git config user.email`. A PR that a coding agent opened counts for the person it names as co-author (see [PRs opened by coding agents](#prs-opened-by-coding-agents)).

A PR's size is its lines changed: added + removed, leaving out docs, lockfiles, build output and files `.gitattributes` marks as generated. Tests and config count, and a docs-only PR counts as a PR with zero lines.

PR pace sums √(lines ÷ 100) over the PRs merged in the 30 days to today (today included, in this machine's timezone) and turns the total into a weekly rate (× 7 ÷ 30). Revert PRs and PRs since reverted count zero, so a later run can lower a figure as reverts land. The line's PR count and median cover the same PRs as the figure.

The report and the JSON output give five figures per day, week or month:

- **PRs** – merged PRs, leaving out revert PRs
- **Size-weighted PRs** – each PR counted as √(lines ÷ 100), summed
- **Median PR size** – lines changed by the middle PR. It's context for reading PRs and size-weighted PRs (did PRs get bigger or smaller?), not a target
- **Lines changed** – added + removed, with the same files left out as above
- **Revert rate** – the share of PRs later reverted

The size weighting rests on a convention, not a measured law: the 100-line reference is fixed rather than taken from your data, so figures compare between people and over time. Read the figures with their limits in mind:

- A few large PRs carry much of the figure, and below about five PRs a week it's noisy
- A stack that needs more lines for the same change scores higher, and the default exclusions affect each stack differently, so comparing people or teams across stacks is weak
- Only the repos you scan count, and the line doesn't say how many there were
- Recent periods understate the revert rate, because their PRs have had less time to be reverted

[`docs/specs/v1.md`](https://github.com/dhpwd/pr-pace/blob/main/docs/specs/v1.md) sets out every rule: what counts as a PR, which lines count, how reverts are detected and linked, the JSON schema and the report's behaviour.

## Install

pr-pace needs Node 22 or later and git. With git older than 2.40 the `.gitattributes` exclusions are skipped, with a warning.

```sh
npm install --global pr-pace
```

That puts `pr-pace` on your PATH. To run it without installing, use `npx pr-pace` in place of `pr-pace` below.

To run a working copy, install it from a checkout of this repo with `npm install --global .`, or use `npx .` from the checkout in place of `pr-pace`.

## Commands

Every command takes one or more paths to scan and defaults to the current folder. A path is a repo, or a folder whose subfolders are repos. `pr-pace <command> --help` lists a command's options.

### `pr-pace pace [path...]`

It prints one PR pace line to stdout, covering every repo it scanned.

```sh
pr-pace pace ~/code
pr-pace pace ~/code --author you@example.com --author you@work.example.com
pr-pace pace ~/code --all-authors
pr-pace pace --from scan.json
```

Pass `--author` once for each address you commit under, since any `--author` replaces the default. `pace` also takes `--depth`, `--branch` and `--fetch`, as `scan` does. It refuses `--since`, `--until` and `--include-docs`, so every line covers one person's last 30 days and counts lines the same way. It still accepts `--exclude` for generated code the default rules miss, and excluding files can only lower the figure. `--from <scan.json>` prints the line from a saved scan, counting back from the day the scan ran. It refuses a scan made by another major version of pr-pace, since that version counted the PRs and lines by its own rules.

With `--all-authors`, `pace` prints one line per author who merged a PR in the last 30 days, ordered by name rather than by pace. Each line starts with the author's name and email and a tab, followed by the line `--author <their email>` would print. A person who commits under two addresses gets a line for each until the repo's `.mailmap` joins them (see [PRs opened by coding agents](#prs-opened-by-coding-agents) for an example). To print them from a saved scan, run `pace --from <scan.json> --all-authors` on a scan made with `scan --all-authors`.

### `pr-pace scan [path...]`

It writes the scan result as JSON to stdout.

```sh
pr-pace scan ~/code --since 2026-01-01 --out scan.json
```

Pass `--author <email|name>` for someone else, or `--all-authors` for a team view. Other options limit the date range, set the folder search depth, override the default branch, fetch first and adjust which files count towards lines changed.

### `pr-pace report [path...]`

It scans with the same options as `scan` and writes `pr-pace.html`: a single file with charts by day, week or month, splits by repo or author, and the list of PRs behind each bar. It makes no network requests, so it works offline and as an attachment.

```sh
pr-pace report ~/code --open
pr-pace report ~/code --all-authors --open
pr-pace report --from scan.json --out report.html
```

The split by author needs `--all-authors`, which counts every author's PRs for a team view.

Each author shows under the name on their latest PR. When PRs credit their GitHub no-reply address under both their name and their GitHub login, their name is shown. To choose the name shown, or to settle on one name for an email that carries two, map it in the `.mailmap` of each scanned repo that uses another name, as in the example under [PRs opened by coding agents](#prs-opened-by-coding-agents).

The report contains your repo names, PR titles and authors' names and emails, so check it before you share it. The PR pace line contains none of these, but `pace --all-authors` puts each author's name and email before their line, so post only the part after the tab.

## PRs opened by coding agents

When a coding agent opens a PR under its own identity (Copilot's coding agent, Codex's coding agent, Devin or Cursor's cloud agents), the PR counts for the person the agent names in a `Co-authored-by:` trailer, not for the agent. Copilot, Codex and Cursor name you by your GitHub no-reply address (`<id>+<login>@users.noreply.github.com`), which may not be your git email, so by default those PRs don't count as yours.

In a repo under your own GitHub account, pr-pace warns when PRs credit your no-reply address but your filter misses it, and the warning names the address. This catches agent PRs and your own squash PRs merged with GitHub's email privacy on. Elsewhere nothing warns you unless none of a repo's PRs match you, in which case the warning lists the PR authors it found. Pass the no-reply address as an extra `--author` alongside your own email, or map it to your usual identity in the repo's `.mailmap`:

```
Your Name <you@example.com> <12345678+your-login@users.noreply.github.com>
```

An agent PR that names no one stays with the agent. When that agent is among the authors the no-match warning lists, the warning says how to claim its PRs.

## Licence

MIT – see `LICENSE`.
