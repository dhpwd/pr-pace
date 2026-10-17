// Calendar helpers shared by the CLI and the HTML report, which inlines every
// export – see "Implementation constraints" in docs/specs/v1.md. Days are
// 'YYYY-MM-DD' strings in the scan's timezone, never the process's.

/**
 * @typedef {{ year: number, month: number, day: number, hour: number, minute: number, second: number }} ZonedParts
 * @typedef {'day' | 'week' | 'month'} Period
 */

/** @param {string} timeZone */
export function zoneFormatter(timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * @param {number} ms
 * @param {Intl.DateTimeFormat} formatter
 * @returns {ZonedParts}
 */
export function zonedParts(ms, formatter) {
  /** @type {Record<string, number>} */
  const parts = {};
  for (const { type, value } of formatter.formatToParts(ms)) {
    if (type !== "literal") parts[type] = Number(value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/**
 * @param {string} day
 * @returns {[number, number, number]} year, month (1–12), day of month
 */
export function parseDay(day) {
  const [year, month, date] = day.split("-").map(Number);
  return [year, month, date];
}

/**
 * Whether `value` is a real calendar day written YYYY-MM-DD.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isDay(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    addDays(value, 0) === value
  );
}

/**
 * @param {number} year
 * @param {number} month
 * @param {number} day
 */
export function formatDay(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * @param {number} ms
 * @param {Intl.DateTimeFormat} formatter
 */
export function dayOf(ms, formatter) {
  const p = zonedParts(ms, formatter);
  return formatDay(p.year, p.month, p.day);
}

/**
 * Minutes the zone is ahead of UTC at the instant `ms`.
 * @param {number} ms
 * @param {Intl.DateTimeFormat} formatter
 */
export function offsetMinutes(ms, formatter) {
  const p = zonedParts(ms, formatter);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/**
 * ISO 8601 with the zone's offset, to the second: 2026-10-17T21:00:00+01:00.
 * @param {number} ms
 * @param {Intl.DateTimeFormat} formatter
 */
export function formatInstant(ms, formatter) {
  const p = zonedParts(ms, formatter);
  const offset = offsetMinutes(ms, formatter);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const hhmm = `${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const time = [p.hour, p.minute, p.second]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  return `${formatDay(p.year, p.month, p.day)}T${time}${sign}${hhmm}`;
}

/**
 * The instant at which a day starts in the zone.
 * @param {string} day
 * @param {Intl.DateTimeFormat} formatter
 */
export function startOfDay(day, formatter) {
  const [year, month, date] = parseDay(day);
  const guess = Date.UTC(year, month - 1, date);
  const first = guess - offsetMinutes(guess, formatter) * 60000;
  const second = guess - offsetMinutes(first, formatter) * 60000;
  // Where the clocks skip midnight, one candidate falls on the day before.
  const onDay = [first, second].filter((ms) => dayOf(ms, formatter) === day);
  return onDay.length > 0 ? Math.min(...onDay) : second;
}

/**
 * @param {string} day
 * @param {number} n
 */
export function addDays(day, n) {
  const [year, month, date] = parseDay(day);
  const d = new Date(Date.UTC(year, month - 1, date + n));
  return formatDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * @param {string} day
 * @param {number} n
 */
export function addMonths(day, n) {
  const [year, month, date] = parseDay(day);
  const last = new Date(Date.UTC(year, month - 1 + n + 1, 0)).getUTCDate();
  const d = new Date(Date.UTC(year, month - 1 + n, Math.min(date, last)));
  return formatDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Days from `a` to `b`, positive when `b` is later.
 * @param {string} a
 * @param {string} b
 */
export function daysBetween(a, b) {
  const [ay, am, ad] = parseDay(a);
  const [by, bm, bd] = parseDay(b);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000,
  );
}

/**
 * The period a day falls in. Weeks are ISO weeks, keyed by their Monday.
 * @param {string} day
 * @param {Period} period
 */
export function periodOf(day, period) {
  if (period === "month") return day.slice(0, 7);
  if (period === "week") {
    const [year, month, date] = parseDay(day);
    const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
    return addDays(day, -((weekday + 6) % 7));
  }
  return day;
}

/**
 * Every period from the one holding `from` to the one holding `to`, in order.
 * @param {string} from
 * @param {string} to
 * @param {Period} period
 */
export function periodsBetween(from, to, period) {
  const last = periodOf(to, period);
  /** @type {string[]} */
  const keys = [];
  let key = periodOf(from, period);
  while (key <= last) {
    keys.push(key);
    if (period === "month") key = addMonths(`${key}-01`, 1).slice(0, 7);
    else key = addDays(key, period === "week" ? 7 : 1);
  }
  return keys;
}
