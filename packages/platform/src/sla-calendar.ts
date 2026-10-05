import { Temporal } from "@js-temporal/polyfill";
import { BusinessCalendar, type Calendar } from "./sla-contracts.js";
// Minutes measure real elapsed time inside business intervals. A DST gap advances
// to the next valid local time; a repeated opening uses its earlier occurrence,
// while a repeated closing uses its later occurrence. No server timezone is used.
function boundary(
  date: Temporal.PlainDate,
  time: string,
  zone: string,
  end: boolean,
) {
  if (time === "24:00") {
    date = date.add({ days: 1 });
    time = "00:00";
  }
  const [hour, minute] = time.split(":").map(Number);
  return Temporal.ZonedDateTime.from(
    {
      timeZone: zone,
      year: date.year,
      month: date.month,
      day: date.day,
      hour,
      minute,
    },
    { disambiguation: end ? "later" : "compatible" },
  ).epochMilliseconds;
}
function intervals(date: Temporal.PlainDate, c: Calendar) {
  if (c.holidays.includes(date.toString())) return [];
  return c.shifts
    .filter((s) => s.day === date.dayOfWeek)
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((s) => [
      boundary(date, s.start, c.timezone, false),
      boundary(date, s.end, c.timezone, true),
    ]);
}
export function businessDeadline(
  start: string | Date,
  minutes: number,
  input: Calendar,
): string {
  const c = BusinessCalendar.parse(input);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 43200)
    throw new Error("Business minutes outside allowed bounds");
  let cursor = Temporal.Instant.from(
      new Date(start).toISOString(),
    ).epochMilliseconds,
    left = minutes * 60000;
  if (!left) return new Date(cursor).toISOString();
  let date = Temporal.Instant.fromEpochMilliseconds(cursor)
    .toZonedDateTimeISO(c.timezone)
    .toPlainDate();
  for (let days = 0; days < 3660; days++, date = date.add({ days: 1 })) {
    for (const [open, close] of intervals(date, c)) {
      const from = Math.max(open, cursor),
        available = close - from;
      if (available <= 0) continue;
      if (left <= available) return new Date(from + left).toISOString();
      left -= available;
      cursor = close;
    }
  }
  throw new Error(
    "Business calendar cannot satisfy this deadline within ten years",
  );
}
export function businessMinutesBetween(
  start: Date | string,
  end: Date | string,
  input: Calendar,
): number {
  const c = BusinessCalendar.parse(input),
    a = new Date(start).getTime(),
    b = new Date(end).getTime();
  if (b <= a) return 0;
  let date = Temporal.Instant.fromEpochMilliseconds(a)
      .toZonedDateTimeISO(c.timezone)
      .toPlainDate(),
    total = 0;
  for (let days = 0; days < 3660; days++, date = date.add({ days: 1 })) {
    const next = boundary(date, "24:00", c.timezone, true);
    for (const [open, close] of intervals(date, c))
      total += Math.max(0, Math.min(close, b) - Math.max(open, a));
    if (next >= b) return total / 60000;
  }
  throw new Error("Calendar interval exceeds ten years");
}
