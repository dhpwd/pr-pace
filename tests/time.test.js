import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, test } from "node:test";
import { parseBound } from "../src/cli.js";
import {
  dayOf,
  formatInstant,
  periodOf,
  periodsBetween,
  startOfDay,
  zoneFormatter,
} from "../src/time.js";

const london = zoneFormatter("Europe/London");

/** Instants either side of midnight and of the 2026 UK clock changes. */
const INSTANTS = [
  "2026-03-28T23:30:00Z",
  "2026-03-29T00:30:00Z",
  "2026-03-29T23:30:00Z",
  "2026-10-04T23:30:00Z",
  "2026-10-25T00:30:00Z",
  "2026-10-25T23:30:00Z",
  "2026-12-31T23:59:59Z",
];

describe("period bucketing", () => {
  test("buckets by the scan's timezone, with ISO weeks keyed by Monday", () => {
    const sunday = Date.parse("2026-10-04T23:30:00Z");
    assert.equal(dayOf(sunday, london), "2026-10-05");
    assert.equal(periodOf(dayOf(sunday, london), "week"), "2026-10-05");
    assert.equal(dayOf(sunday, zoneFormatter("UTC")), "2026-10-04");
    assert.equal(periodOf("2026-10-04", "week"), "2026-09-28");
    assert.equal(periodOf("2026-10-04", "month"), "2026-10");
    assert.equal(periodOf("2026-01-01", "week"), "2025-12-29");
  });

  test("gives the same periods whatever TZ the process runs under", () => {
    const script = `
      import { dayOf, periodOf, zoneFormatter } from ${JSON.stringify(new URL("../src/time.js", import.meta.url).href)};
      const formatter = zoneFormatter("Europe/London");
      const instants = ${JSON.stringify(INSTANTS)};
      console.log(JSON.stringify(instants.map((iso) => {
        const day = dayOf(Date.parse(iso), formatter);
        return [day, periodOf(day, "week"), periodOf(day, "month")];
      })));
    `;
    const outputs = [
      "UTC",
      "America/Los_Angeles",
      "Asia/Kolkata",
      "Pacific/Kiritimati",
    ].map((tz) =>
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, TZ: tz },
        encoding: "utf8",
      }),
    );
    for (const output of outputs) assert.equal(output, outputs[0]);
    assert.deepEqual(JSON.parse(outputs[0]), [
      ["2026-03-28", "2026-03-23", "2026-03"],
      ["2026-03-29", "2026-03-23", "2026-03"],
      ["2026-03-30", "2026-03-30", "2026-03"],
      ["2026-10-05", "2026-10-05", "2026-10"],
      ["2026-10-25", "2026-10-19", "2026-10"],
      ["2026-10-25", "2026-10-19", "2026-10"],
      ["2026-12-31", "2026-12-28", "2026-12"],
    ]);
  });

  test("lists every period in a range, including empty ones", () => {
    assert.deepEqual(periodsBetween("2026-12-30", "2027-01-12", "week"), [
      "2026-12-28",
      "2027-01-04",
      "2027-01-11",
    ]);
    assert.deepEqual(periodsBetween("2026-11-15", "2027-02-01", "month"), [
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
    assert.equal(periodsBetween("2026-01-01", "2026-12-31", "day").length, 365);
  });

  test("formats instants with the zone's offset and finds the start of a day across clock changes", () => {
    assert.equal(
      formatInstant(Date.parse("2026-07-01T12:00:00Z"), london),
      "2026-07-01T13:00:00+01:00",
    );
    assert.equal(
      formatInstant(Date.parse("2026-12-01T12:00:00Z"), london),
      "2026-12-01T12:00:00+00:00",
    );
    assert.equal(
      formatInstant(
        Date.parse("2026-12-01T12:00:00Z"),
        zoneFormatter("America/St_Johns"),
      ),
      "2026-12-01T08:30:00-03:30",
    );
    assert.equal(
      startOfDay("2026-03-29", london),
      Date.parse("2026-03-29T00:00:00Z"),
    );
    assert.equal(
      startOfDay("2026-03-30", london),
      Date.parse("2026-03-29T23:00:00Z"),
    );
    assert.equal(
      startOfDay("2026-10-25", london),
      Date.parse("2026-10-24T23:00:00Z"),
    );
  });

  test("starts a day at the first instant on it where the clocks skip midnight", () => {
    assert.equal(
      startOfDay("2026-09-06", zoneFormatter("America/Santiago")),
      Date.parse("2026-09-06T04:00:00Z"),
    );
    assert.equal(
      startOfDay("2026-03-08", zoneFormatter("America/Havana")),
      Date.parse("2026-03-08T05:00:00Z"),
    );
  });
});

describe("--since and --until", () => {
  test("a bare date is a whole day in the scan's timezone", () => {
    assert.equal(
      parseBound("--since", "2026-07-01", "Europe/London"),
      Date.parse("2026-06-30T23:00:00Z"),
    );
    assert.equal(
      parseBound("--until", "2026-07-01", "Europe/London"),
      Date.parse("2026-07-01T23:00:00Z"),
    );
    assert.equal(
      parseBound("--since", "2026-07-01", "UTC"),
      Date.parse("2026-07-01T00:00:00Z"),
    );
  });

  test("a full ISO 8601 timestamp is taken as given, with --until inclusive", () => {
    assert.equal(
      parseBound("--since", "2026-07-01T09:30:00+01:00", "UTC"),
      Date.parse("2026-07-01T08:30:00Z"),
    );
    assert.equal(
      parseBound("--until", "2026-07-01T09:30:00Z", "UTC"),
      Date.parse("2026-07-01T09:30:00Z") + 1,
    );
  });

  test("anything else is an error naming the accepted formats", () => {
    for (const value of [
      "2026-7-1",
      "2026-02-30",
      "yesterday",
      "2026-07-01T09:30",
      "2026-02-30T00:00:00Z",
      "01/07/2026",
    ]) {
      assert.throws(
        () => parseBound("--since", value, "UTC"),
        /use YYYY-MM-DD .* or a full ISO 8601 timestamp/,
      );
    }
  });
});
