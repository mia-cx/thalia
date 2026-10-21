import type { ThaliaClient } from "./api.ts";
import { formatDuration } from "./browse.ts";

/** One recorded play as `history.list` returns it. */
export type Play = Awaited<
  ReturnType<ThaliaClient["history"]["list"]>
>["items"][number];

/** The Overview's history insights. */
export type HistoryInsights = Awaited<
  ReturnType<ThaliaClient["history"]["insights"]>
>;

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
});
const dayInYearFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const dayKey = (date: Date) =>
  `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/** A local calendar day as a heading: Today, Yesterday, or the date, with the year only when it isn't this year's. */
export function dayHeading(date: Date, now: Date = new Date()): string {
  if (dayKey(date) === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return "Yesterday";
  return (
    date.getFullYear() === now.getFullYear() ? dayFormat : dayInYearFormat
  ).format(date);
}

/** Groups newest-first plays by the local day they started, keeping the order. */
export function groupByDay<T extends { startedAt: string }>(
  plays: readonly T[],
  now: Date = new Date(),
): { heading: string; plays: T[] }[] {
  const days: { key: string; heading: string; plays: T[] }[] = [];
  for (const play of plays) {
    const date = new Date(play.startedAt);
    const key = dayKey(date);
    const last = days.at(-1);
    if (last?.key === key) last.plays.push(play);
    else days.push({ key, heading: dayHeading(date, now), plays: [play] });
  }
  return days.map(({ heading, plays }) => ({ heading, plays }));
}

/** Each play method in the insights, labelled as Activity labels it. */
export const playMethods = [
  { key: "directPlay", label: "Direct play" },
  { key: "remux", label: "Remux" },
  { key: "transcode", label: "Transcode" },
] as const;

/** Watch time such as `3h 20m`, and `0m` when nothing played. */
export function formatWatchTime(seconds: number): string {
  return seconds === 0 ? "0m" : formatDuration(seconds);
}
