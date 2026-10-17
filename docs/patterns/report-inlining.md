# Report browser code

## Inlining modules into the report

**Problem.** The HTML report is one file that makes no external requests, yet its browser code shares date logic with the CLI and needs typechecking and unit tests like the rest of the source.

**Solution.** Browser code lives in ES modules, `src/time.js` and `src/report/client.js`. `reportScript` in `src/report.js` takes every export with `Object.values(module)`, inlines each with `Function.prototype.toString` and appends a call to `main`. Node code and tests import the same modules, and `tsc` checks them as ordinary modules. The rules an inlined module follows are stated in the spec's Implementation constraints. In practice:

- Every export is a function declaration. `reportScript` throws on anything else, and an arrow function assigned to a `const` would lose its name when stringified
- A function uses only browser globals, its own locals and other inlined exports. Module-level constants and private helpers aren't carried into the page: keep the constant inside the function, or export the helper (`monthName` in `client.js`)
- Inlined functions are imported under their own names, never aliased, because the page calls them by those names
- The code never contains `</script`, which would end the script element. The scan data goes in its own `scan-data` JSON block with `<` escaped as `<`

**Anti-pattern.**

```js
const MONTHS = ["Jan", "Feb" /* … */]; // not inlined – a ReferenceError in the page
export function dayLabel(day) {
  return MONTHS[Number(day.slice(5, 7)) - 1];
}
```

`npm test` and `npm run typecheck` both pass on this. Only the browser report check fails, until DHP-37 adds a mechanical check.

**When to use.** Any code the report runs in the browser.
