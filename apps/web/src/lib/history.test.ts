import { describe, expect, test } from "bun:test";
import { groupByDay } from "./history.ts";

describe("watch history days", () => {
  test("groups plays under Today, Yesterday and dated headings, year only when it differs", () => {
    const now = new Date(2026, 9, 21, 9, 0);
    const at = (...parts: [number, number, number, number]) => ({
      startedAt: new Date(...parts).toISOString(),
    });
    const days = groupByDay(
      [
        at(2026, 9, 21, 8),
        at(2026, 9, 21, 0),
        at(2026, 9, 20, 23),
        at(2026, 9, 6, 12),
        at(2025, 11, 31, 20),
      ],
      now,
    );
    const expected = [
      ["Today", 2],
      ["Yesterday", 1],
      [
        new Intl.DateTimeFormat(undefined, {
          weekday: "long",
          day: "numeric",
          month: "long",
        }).format(new Date(2026, 9, 6)),
        1,
      ],
      [
        new Intl.DateTimeFormat(undefined, {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        }).format(new Date(2025, 11, 31)),
        1,
      ],
    ];
    expect(days.map((day) => [day.heading, day.plays.length])).toEqual(
      expected,
    );
  });
});
