import { test } from "node:test";
import assert from "node:assert/strict";
import {
  businessDeadline,
  businessMinutesBetween,
} from "../packages/platform/src/sla-calendar.js";
import {
  defaultSlaPolicy,
  BusinessCalendar,
} from "../packages/platform/src/sla-contracts.js";
const calendar = defaultSlaPolicy().calendar;
test("business time crosses split shifts, weekends, holidays, and exact closing", () => {
  const c = {
    ...calendar,
    shifts: [1, 2, 3, 4, 5].flatMap((day) => [
      { day, start: "09:00", end: "12:00" },
      { day, start: "13:00", end: "17:00" },
    ]),
    holidays: ["2026-10-05"],
  };
  assert.equal(
    businessDeadline("2026-10-02T16:00:00Z", 60, c),
    "2026-10-02T17:00:00.000Z",
  );
  assert.equal(
    businessDeadline("2026-10-02T17:00:00Z", 60, c),
    "2026-10-06T10:00:00.000Z",
  );
  assert.equal(
    businessDeadline("2026-10-06T11:30:00Z", 60, c),
    "2026-10-06T13:30:00.000Z",
  );
  assert.equal(
    businessMinutesBetween("2026-10-02T16:00:00Z", "2026-10-06T10:00:00Z", c),
    120,
  );
});
test("DST gaps and repeats use real elapsed time and frozen IANA timezone", () => {
  const c = {
    timezone: "America/Toronto",
    shifts: [{ day: 7, start: "01:00", end: "04:00" }],
    holidays: [],
  };
  assert.equal(
    businessDeadline("2026-03-08T06:00:00Z", 120, c),
    "2026-03-08T08:00:00.000Z",
  );
  assert.equal(
    businessMinutesBetween("2026-03-08T06:00:00Z", "2026-03-08T08:00:00Z", c),
    120,
  );
  assert.equal(
    businessDeadline("2026-11-01T05:00:00Z", 240, c),
    "2026-11-01T09:00:00.000Z",
  );
  assert.equal(
    businessMinutesBetween("2026-11-01T05:00:00Z", "2026-11-01T09:00:00Z", c),
    240,
  );
  const gap = { ...c, shifts: [{ day: 7, start: "02:30", end: "04:00" }] };
  assert.equal(
    businessDeadline("2026-03-08T06:00:00Z", 30, gap),
    "2026-03-08T08:00:00.000Z",
  );
});
test("calendar rejects offsets, invalid dates, backwards or overlapping shifts", () => {
  for (const c of [
    { ...calendar, timezone: "-04:00" },
    { ...calendar, timezone: "Not/AZone" },
    { ...calendar, holidays: ["2026-02-30"] },
    { ...calendar, shifts: [{ day: 1, start: "12:00", end: "09:00" }] },
    {
      ...calendar,
      shifts: [
        { day: 1, start: "09:00", end: "12:00" },
        { day: 1, start: "11:00", end: "13:00" },
      ],
    },
  ])
    assert.equal(BusinessCalendar.safeParse(c).success, false);
});
