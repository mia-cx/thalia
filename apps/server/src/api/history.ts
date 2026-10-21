import { Schema } from "effect";
import { historyInsights, listHistory } from "../playback/history.ts";
import { authenticated } from "./context.ts";
import { fromHost, runApi } from "./errors.ts";
import { BrowseCard, connection, PageSize } from "./schema.ts";

const PlayMethod = Schema.Literal("direct-play", "remux", "transcode");
const HistoryUser = Schema.Struct({
  id: Schema.UUID,
  displayName: Schema.String,
});

/** One recorded play: who watched what, when it started and for how long. */
const Play = Schema.Struct({
  id: Schema.UUID,
  item: BrowseCard,
  user: HistoryUser,
  playMethod: PlayMethod,
  playedSeconds: Schema.Number,
  startedAt: Schema.String,
});

const Insights = Schema.Struct({
  /** Oldest first; `start` is the week's Monday as YYYY-MM-DD. */
  weeks: Schema.Array(
    Schema.Struct({ start: Schema.String, seconds: Schema.Number }),
  ),
  topTitles: Schema.Array(
    Schema.Struct({
      item: BrowseCard,
      plays: Schema.Int,
      seconds: Schema.Number,
    }),
  ),
  topUsers: Schema.Array(
    Schema.Struct({
      user: HistoryUser,
      plays: Schema.Int,
      seconds: Schema.Number,
    }),
  ),
  /** Seconds played by each method. */
  methods: Schema.Struct({
    directPlay: Schema.Number,
    remux: Schema.Number,
    transcode: Schema.Number,
  }),
});

/** Watch history procedures mounted under `history`. */
export const historyProcedures = {
  list: authenticated
    .route({ method: "GET", path: "/history" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          everyone: Schema.optional(
            Schema.Union(Schema.Boolean, Schema.BooleanFromString),
          ),
          limit: Schema.optional(PageSize),
          cursor: Schema.optional(Schema.String),
        }),
      ),
    )
    .output(Schema.standardSchemaV1(connection(Play)))
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(() => listHistory(context.db, context.caller.user.id, input)),
      ),
    ),
  insights: authenticated
    .route({ method: "GET", path: "/history/insights" })
    .output(Schema.standardSchemaV1(Insights))
    .handler(async ({ context }) =>
      runApi(
        fromHost(() => historyInsights(context.db, context.caller.user.id)),
      ),
    ),
};
