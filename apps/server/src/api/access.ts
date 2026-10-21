import { Schema } from "effect";
import {
  explainAccess,
  removeRule,
  rulesForSubject,
  rulesOnObject,
  setRule,
} from "../auth/rules.ts";
import { actions, serverOnlyActions } from "../db/schema/index.ts";
import { authenticated, authenticatedMutation } from "./context.ts";
import { fromHost, runApi } from "./errors.ts";
import { ItemKind } from "./schema.ts";

const ruleFields = {
  subject: Schema.Struct({
    type: Schema.Literal("user", "group"),
    id: Schema.UUID,
  }),
  object: Schema.Union(
    Schema.Struct({ type: Schema.Literal("server") }),
    Schema.Struct({ type: Schema.Literal("library", "item"), id: Schema.UUID }),
  ),
  action: Schema.Literal(...actions),
};
const validObject = ({
  object,
  action,
}: Pick<typeof RuleKey.Type, "object" | "action">) =>
  object.type === "server" ||
  !(serverOnlyActions as readonly string[]).includes(action);
const RuleKey = Schema.Struct(ruleFields);
const validation = {
  message: () => "Server-only Actions require the server object.",
};
const result = Schema.standardSchemaV1(Schema.Struct({}));

/** An Access rule with subject and object names resolved, as the API returns it. */
const Rule = Schema.Struct({
  subject: Schema.Struct({
    type: Schema.Literal("user", "group"),
    id: Schema.UUID,
    name: Schema.String,
  }),
  object: Schema.Union(
    Schema.Struct({
      type: Schema.Literal("server"),
      name: Schema.Literal("Server"),
    }),
    Schema.Struct({
      type: Schema.Literal("library"),
      id: Schema.UUID,
      name: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("item"),
      id: Schema.UUID,
      name: Schema.String,
      kind: ItemKind,
      parentId: Schema.NullOr(Schema.UUID),
      showId: Schema.NullOr(Schema.UUID),
    }),
  ),
  action: Schema.Literal(...actions),
  allowed: Schema.Boolean,
});

/** Admin-only Access rule reads, writes and check explanations, shared by RPC and REST. */
export const accessProcedures = {
  setRule: authenticatedMutation
    .route({ method: "PUT", path: "/access/rules" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({ ...ruleFields, allowed: Schema.Boolean }).pipe(
          Schema.filter(validObject, validation),
        ),
      ),
    )
    .output(result)
    .handler(async ({ context, input }) => {
      await runApi(
        fromHost(() => setRule(context.db, context.caller.user.id, input)),
      );
      return {};
    }),
  removeRule: authenticatedMutation
    .route({ method: "DELETE", path: "/access/rules" })
    .input(
      Schema.standardSchemaV1(
        RuleKey.pipe(Schema.filter(validObject, validation)),
      ),
    )
    .output(result)
    .handler(async ({ context, input }) => {
      await runApi(
        fromHost(() => removeRule(context.db, context.caller.user.id, input)),
      );
      return {};
    }),
  rulesOnObject: authenticated
    .route({ method: "GET", path: "/access/rules/object" })
    .input(
      Schema.standardSchemaV1(Schema.Struct({ object: ruleFields.object })),
    )
    .output(
      Schema.standardSchemaV1(
        Schema.Struct({
          direct: Schema.Array(Rule),
          inherited: Schema.Array(Rule),
        }),
      ),
    )
    .handler(
      async ({ context, input }) =>
        await runApi(
          fromHost(() =>
            rulesOnObject(context.db, context.caller.user.id, input.object),
          ),
        ),
    ),
  explain: authenticated
    .route({ method: "GET", path: "/access/explain" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          userId: Schema.UUID,
          object: ruleFields.object,
          action: ruleFields.action,
        }).pipe(Schema.filter(validObject, validation)),
      ),
    )
    .output(
      Schema.standardSchemaV1(
        Schema.Struct({
          allowed: Schema.Boolean,
          reason: Schema.Literal("admin", "disabled", "view", "rule", "unset"),
          rule: Schema.NullOr(Rule),
        }),
      ),
    )
    .handler(
      async ({ context, input }) =>
        await runApi(
          fromHost(() =>
            explainAccess(context.db, context.caller.user.id, input),
          ),
        ),
    ),
  rulesForSubject: authenticated
    .route({ method: "GET", path: "/access/rules/subject" })
    .input(
      Schema.standardSchemaV1(Schema.Struct({ subject: ruleFields.subject })),
    )
    .output(Schema.standardSchemaV1(Schema.Array(Rule)))
    .handler(
      async ({ context, input }) =>
        await runApi(
          fromHost(() =>
            rulesForSubject(context.db, context.caller.user.id, input.subject),
          ),
        ),
    ),
};
