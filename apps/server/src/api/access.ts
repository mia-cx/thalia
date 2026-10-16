import { Schema } from "effect";
import { removeRule, setRule } from "../auth/rules.ts";
import { actions, serverOnlyActions } from "../db/schema/index.ts";
import { authenticatedMutation } from "./context.ts";
import { fromHost, runApi } from "./errors.ts";

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
const validObject = ({ object, action }: typeof RuleKey.Type) =>
  object.type === "server" ||
  !(serverOnlyActions as readonly string[]).includes(action);
const RuleKey = Schema.Struct(ruleFields);
const validation = {
  message: () => "Server-only Actions require the server object.",
};
const result = Schema.standardSchemaV1(Schema.Struct({}));

/** Admin-only Access rule writes, shared by RPC and REST. */
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
};
