# Dates and timezones

## Day strings in the scan's timezone

**Problem.** Bucketing, presets and `--since`/`--until` must give the same days wherever the scan runs and wherever the report is opened.

**Solution.** Calendar logic works on `'YYYY-MM-DD'` day strings in the scan's timezone (`options.timezone`), using the helpers in `src/time.js`:

- Turn an instant into a day with `dayOf(ms, formatter)`, where the formatter is `zoneFormatter(timeZone)` – `Intl.DateTimeFormat` with an explicit `timeZone`. Build the formatter once and pass it in, as building one per call is slow on large scans
- Do day arithmetic (`addDays`, `addMonths`, `periodOf`, `periodsBetween`) on the strings with `Date.UTC` and the `getUTC*` getters, where no zone applies
- Turn a day back into an instant only with `startOfDay`, which finds the first instant on the day in zones whose clocks skip midnight
- Check input days with `isDay`, which rejects impossible dates such as 30th February

**Anti-pattern.** Local-time getters (`getDate`, `getDay`, `getHours`) or `Date.parse` on a datetime without an offset. Both read the process's zone, so results change with `TZ`.

**When to use.** Any new date logic in the CLI or the report. `tests/time.test.js` runs the bucketing in child processes under several `TZ` values – extend it alongside new bucketing logic.
