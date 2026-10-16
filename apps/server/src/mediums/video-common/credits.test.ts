import { describe, expect, test } from "bun:test";
import type { Chapter } from "../../db/schema/core.ts";
import { creditsStartSeconds } from "./credits.ts";

const chapter = (
  title: string | null,
  startSeconds: number,
  endSeconds = startSeconds + 10,
): Chapter => ({ title, startSeconds, endSeconds });

describe("creditsStartSeconds", () => {
  test.each([
    "Credits",
    "END CREDITS",
    "Outro",
    "Ending",
    "ED",
    "ED - Song",
    "Closing Credits",
    "ED_1",
    "ED 1",
  ])("matches %j in the second half", (title) => {
    expect(creditsStartSeconds([chapter(title, 100)], 120)).toBe(100);
  });

  test.each([
    "Edward",
    "Ended",
    "Opening",
    "Credit",
  ])("does not match %j", (title) => {
    expect(creditsStartSeconds([chapter(title, 100)], 120)).toBeNull();
  });

  test("a null title never matches", () => {
    expect(creditsStartSeconds([chapter(null, 100)], 120)).toBeNull();
  });

  test("a credits chapter in the first half is ignored", () => {
    expect(creditsStartSeconds([chapter("Credits", 10)], 120)).toBeNull();
  });

  test("the first matching chapter after halfway wins", () => {
    const chapters = [chapter("Ending", 100), chapter("Credits", 80)];
    expect(creditsStartSeconds(chapters, 120)).toBe(80);
  });

  test("unsorted input still finds the first matching start", () => {
    const chapters = [
      chapter("Ending", 110),
      chapter("Opening", 0),
      chapter("Credits", 80),
    ];
    expect(creditsStartSeconds(chapters, 120)).toBe(80);
  });

  test.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "duration %s returns null",
    (duration) => {
      expect(
        creditsStartSeconds([chapter("Credits", 100)], duration),
      ).toBeNull();
    },
  );
});
