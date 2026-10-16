import type { Chapter } from "../../db/schema/core.ts";

// A credits title reads as one whole word among these; "Edward" is not "ED".
const creditsTitle =
  /(?:^|[^\p{L}\p{N}])(?:credits|outro|ending|ed)(?=$|[^\p{L}\p{N}])/iu;

/** The second half's first chapter titled as credits, or null when none or the duration is unknown. */
export function creditsStartSeconds(
  chapters: readonly Chapter[],
  durationSeconds: number,
): number | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  const halfway = durationSeconds / 2;
  const start = [...chapters]
    .sort((a, b) => a.startSeconds - b.startSeconds)
    .find(
      (chapter) =>
        chapter.startSeconds >= halfway &&
        chapter.title !== null &&
        creditsTitle.test(chapter.title),
    );
  return start?.startSeconds ?? null;
}
