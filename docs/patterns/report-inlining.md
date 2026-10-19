# Report browser code

## Inlining modules into the report

**Problem.** The HTML report is one file that makes no external requests, yet its browser code shares date logic with the CLI and needs typechecking and unit tests like the rest of the source.

**Solution.** Browser code lives in ES modules, `src/time.js` and `src/report/client.js`. `reportScript` in `src/report.js` takes every export with `Object.values(module)`, inlines each with `Function.prototype.toString` and appends a call to `main`. Node code and tests import the same modules, and `tsc` checks them as ordinary modules. The rules an inlined module follows are stated in the spec's Implementation constraints. In practice:

- Every export is a function declaration. `reportScript` throws only on an export that isn't a function, so an `export const f = () => …` gets through it, and its arrow function loses its name when stringified. `tests/inlining.test.js` catches the rest: it fails on any top-level line other than an exported function declaration, a comment or a named import from another inlined module. It checks each module `src/report.js` imports with `import * as`, so a new inlined module is covered without changing the test
- A function uses only browser globals, its own locals and other inlined exports. Module-level constants and private helpers aren't carried into the page: keep the constant inside the function, or export the helper (`monthName` in `client.js`). A table several functions share is an exported function that builds and returns it (`metrics`, under Report metrics below). Nothing catches a Node-only global such as `process` inside a function: the test reads only the top level, and `npm run typecheck` loads Node's types for every file
- Inlined functions are imported under their own names, never aliased, because the page calls them by those names. The test flags a renamed, default or namespace import
- No two inlined modules export the same name. The page declares every export in one script, so a second declaration replaces the first and the browser runs different code from Node. `tests/inlining.test.js` checks this too
- The code never contains `</script`, which would end the script element. The scan data goes in its own `scan-data` JSON block with `<` escaped as `\u003c`

**Anti-pattern.**

```js
const MONTHS = ["Jan", "Feb" /* … */]; // not inlined – a ReferenceError in the page
export function dayLabel(day) {
  return MONTHS[Number(day.slice(5, 7)) - 1];
}
```

`npm run typecheck` passes on this and `npm test` fails it, because `tests/inlining.test.js` checks each inlined module's top level.

**When to use.** Any code the report runs in the browser.

## Report metrics

**Problem.** Each metric's label, notes, value, stacking, moving average, tick step, display precision, tone and PR list summary are needed in about ten places across `client.js`. Spelled out at each site as a comparison on the metric's name, a new metric needs an edit in every one, and a missed site such as a hard-coded allow-list goes wrong with no test failing.

**Solution.** `metrics()` in `client.js` defines every metric once: an exported function that builds and returns a `Record<Metric, MetricDef>` in display order. Every consumer reads a field. The return type makes `npm run typecheck` fail on a missing field or on a key `Metric` doesn't list. The extra-key check is TypeScript's excess-property check, which applies only to a fresh object literal, so the function returns the literal directly rather than an untyped `const` built earlier. Key order sets the order of the metric control and the tiles, which `tests/report.test.js` pins, and the keys are `loadView`'s allowed values.

- A new metric is one `Metric` union member and one table entry
- A behaviour no field covers gets a new `MetricDef` field, never a name comparison outside `metrics()`
- `stacks: false` gives both side-by-side bars under a split and a moving average pooled over the four periods' rows: `value` of their combined totals
- `rate` is revert rate's presentation: a percent, a change in points and the reverted-of-PRs fraction. A second rate metric needs its own fraction field

**Anti-pattern.**

```js
const upIsGood = metric !== "reverts"; // misses the next metric where lower is better
```

**When to use.** Any change to what a report metric shows or how it's drawn.
