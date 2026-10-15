import { eq } from "drizzle-orm";
import { Schema } from "effect";
import { AuthError } from "../auth/errors.ts";
import {
  changePassword,
  readAccount,
  setDisplayName,
} from "../auth/profile.ts";
import type { Database } from "../db/client.ts";
import { users } from "../db/schema/index.ts";
import { authenticated, authenticatedMutation } from "./context.ts";
import { fromHost, runApi } from "./errors.ts";

const Account = Schema.Struct({
  username: Schema.String,
  displayName: Schema.String,
  email: Schema.NullOr(Schema.String),
  /** set: local password; empty: passwordless local account; external: SSO-only. */
  password: Schema.Literal("set", "empty", "external"),
});
const accountOutput = Schema.standardSchemaV1(Account);
const emptyOutput = Schema.standardSchemaV1(Schema.Struct({}));

async function accountOf(context: {
  db: Database;
  caller: { user: { id: string } };
}) {
  const me = context.caller.user.id;
  const account = await runApi(
    fromHost(async () => {
      const account = await readAccount(context.db, me, me);
      const [identity] = await context.db
        .select({ email: users.email, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, me));
      const passwordState: "set" | "empty" | "external" =
        identity === undefined || identity.passwordHash === null
          ? "external"
          : identity.passwordHash === ""
            ? "empty"
            : "set";
      return {
        ...account,
        email: identity?.email ?? null,
        passwordState,
      };
    }),
  );
  return {
    username: account.username,
    displayName: account.displayName,
    email: account.email,
    password: account.passwordState,
  };
}

/** Self-service account procedures: every one acts on the caller only. */
export const accountProcedures = {
  get: authenticated
    .route({ method: "GET", path: "/account" })
    .output(accountOutput)
    .handler(({ context }) => accountOf(context)),

  update: authenticatedMutation
    .route({ method: "PATCH", path: "/account" })
    .input(
      Schema.standardSchemaV1(Schema.Struct({ displayName: Schema.String })),
    )
    .output(accountOutput)
    .handler(async ({ context, input }) => {
      const me = context.caller.user.id;
      await runApi(
        fromHost(() => setDisplayName(context.db, me, me, input.displayName)),
      );
      return accountOf(context);
    }),

  password: authenticatedMutation
    .route({ method: "POST", path: "/account/password" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          currentPassword: Schema.String,
          newPassword: Schema.String,
        }),
      ),
    )
    .output(emptyOutput)
    .handler(async ({ context, input }) => {
      const me = context.caller.user.id;
      // A session caller keeps itself; API-key callers keep nothing to lose.
      const keepSessionId =
        context.caller.credential.kind === "session"
          ? context.caller.credential.id
          : undefined;
      await runApi(
        fromHost(async () => {
          if (input.newPassword.length < 1)
            throw new AuthError("INVALID_INPUT");
          await changePassword(
            context.db,
            me,
            me,
            input.newPassword,
            input.currentPassword,
            keepSessionId,
          );
        }),
      );
      return {};
    }),
};
