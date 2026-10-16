import { describe, expect, test } from "bun:test";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { createApiKey, login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { userSettings, users } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import type { thaliaRouter } from "./router.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

function rpcClient(base: string, token?: string) {
  const link = new RPCLink({
    url: `${base}/rpc`,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return createORPCClient<RouterClient<typeof thaliaRouter>>(link);
}

async function capture(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError) return error;
    throw error;
  }
  throw new Error("Expected the client call to reject.");
}

async function seed(db: Database) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "secret",
  });
  const viewer = await createLocalUser(db, admin.id, {
    username: "viewer",
    password: "viewer-pass",
  });
  const { token } = await login(
    db,
    { username: "viewer", password: "viewer-pass", ...device },
    "127.0.0.1",
  );
  const { token: keyToken } = await createApiKey(db, viewer.id, "viewer");
  return { admin, viewer, token, keyToken };
}

describe.skipIf(!databaseUrl)("self-service account", () => {
  test("reads and renames the caller's own account, keeping the username", () =>
    withDatabase(async (db, url) => {
      const { keyToken } = await seed(db);
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, keyToken);

        expect(await client.account.get()).toEqual({
          username: "viewer",
          displayName: "viewer",
          email: null,
          password: "set",
          preferDirectStream: false,
          autoplayNextEpisode: true,
        });

        const renamed = await client.account.update({
          displayName: "  Mia Example  ",
        });
        expect(renamed).toEqual({
          username: "viewer",
          displayName: "Mia Example",
          email: null,
          password: "set",
          preferDirectStream: false,
          autoplayNextEpisode: true,
        });
        expect(await client.account.get()).toEqual(renamed);
      } finally {
        await server.stop();
      }
    }));

  test("rejects blank and overlong display names", () =>
    withDatabase(async (db, url) => {
      const { keyToken } = await seed(db);
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const client = rpcClient(
          `http://127.0.0.1:${server.apiServer?.port}`,
          keyToken,
        );
        const blank = await capture(
          client.account.update({ displayName: "   " }),
        );
        expect(blank.code).toBe("BAD_REQUEST");
        const long = await capture(
          client.account.update({ displayName: "x".repeat(101) }),
        );
        expect(long.code).toBe("BAD_REQUEST");
      } finally {
        await server.stop();
      }
    }));

  test("a viewer reads and writes their own playback preferences", () =>
    withDatabase(async (db, url) => {
      const { admin, viewer, token } = await seed(db);
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const client = rpcClient(
          `http://127.0.0.1:${server.apiServer?.port}`,
          token,
        );

        expect(await client.account.get()).toMatchObject({
          preferDirectStream: false,
          autoplayNextEpisode: true,
        });

        const prefer = await client.account.update({
          preferDirectStream: true,
        });
        expect(prefer).toMatchObject({
          displayName: "viewer",
          preferDirectStream: true,
          autoplayNextEpisode: true,
        });

        const autoplay = await client.account.update({
          autoplayNextEpisode: false,
        });
        expect(autoplay).toMatchObject({
          preferDirectStream: true,
          autoplayNextEpisode: false,
        });
        expect(await client.account.get()).toEqual(autoplay);

        // Fields outside the schema are dropped: the caller's own row is the
        // only one a PATCH can ever touch.
        await client.account.update({
          preferDirectStream: false,
          ...({ userId: admin.id } as object),
        });
        expect(
          await db
            .select({ userId: userSettings.userId })
            .from(userSettings)
            .where(eq(userSettings.userId, admin.id)),
        ).toHaveLength(0);
        const [row] = await db
          .select({ preferDirectStream: userSettings.preferDirectStream })
          .from(userSettings)
          .where(eq(userSettings.userId, viewer.id));
        expect(row?.preferDirectStream).toBe(false);
      } finally {
        await server.stop();
      }
    }));

  test("an API key reads and writes the caller's playback preferences", () =>
    withDatabase(async (db, url) => {
      const { keyToken } = await seed(db);
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const client = rpcClient(
          `http://127.0.0.1:${server.apiServer?.port}`,
          keyToken,
        );
        const updated = await client.account.update({
          preferDirectStream: true,
          autoplayNextEpisode: false,
        });
        expect(updated).toMatchObject({
          preferDirectStream: true,
          autoplayNextEpisode: false,
        });
        expect(await client.account.get()).toEqual(updated);
      } finally {
        await server.stop();
      }
    }));

  test("changes the caller's password, keeps its session, revokes others", () =>
    withDatabase(async (db, url) => {
      const { viewer, token, keyToken } = await seed(db);
      const { token: otherToken } = await login(
        db,
        { username: "viewer", password: "viewer-pass", ...device },
        "127.0.0.1",
      );
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, token);

        const wrong = await capture(
          client.account.password({
            currentPassword: "nope",
            newPassword: "new-pass",
          }),
        );
        expect(wrong.code).toBe("UNAUTHORIZED");

        await client.account.password({
          currentPassword: "viewer-pass",
          newPassword: "new-pass",
        });
        // The calling session survives; the other session and old password do not.
        expect(await client.account.get()).toMatchObject({
          username: "viewer",
        });
        const stale = await capture(rpcClient(base, otherToken).account.get());
        expect(stale.code).toBe("UNAUTHORIZED");
        await expect(
          login(
            db,
            { username: "viewer", password: "viewer-pass", ...device },
            "127.0.0.1",
          ),
        ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
        const fresh = await login(
          db,
          { username: "viewer", password: "new-pass", ...device },
          "127.0.0.1",
        );
        expect(fresh.user.id).toBe(viewer.id);

        // API keys keep working: a key has no session to revoke.
        await rpcClient(base, keyToken).account.password({
          currentPassword: "new-pass",
          newPassword: "newer-pass",
        });
        expect((await rpcClient(base, keyToken).account.get()).password).toBe(
          "set",
        );
      } finally {
        await server.stop();
      }
    }));

  test("reports empty and external password states", () =>
    withDatabase(async (db, url) => {
      const { admin } = await seed(db);
      const empty = await createLocalUser(
        db,
        admin.id,
        { username: "empty", password: "" },
        { allowEmptyPassword: true },
      );
      const { token: emptyToken } = await createApiKey(db, empty.id, "e");
      const [external] = await db
        .insert(users)
        .values({
          username: "external",
          displayName: "External",
          oidcIssuer: "https://issuer.example",
          oidcSubject: "subject-1",
        })
        .returning();
      if (!external) throw new Error("User insert returned no row.");
      const { token: externalToken } = await createApiKey(db, external.id, "x");

      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        expect((await rpcClient(base, emptyToken).account.get()).password).toBe(
          "empty",
        );
        expect(
          (await rpcClient(base, externalToken).account.get()).password,
        ).toBe("external");

        // A passwordless local account sets its first password with "".
        await rpcClient(base, emptyToken).account.password({
          currentPassword: "",
          newPassword: "new-pass",
        });
        expect((await rpcClient(base, emptyToken).account.get()).password).toBe(
          "set",
        );
        const fresh = await login(
          db,
          { username: "empty", password: "new-pass", ...device },
          "127.0.0.1",
        );
        expect(fresh.user.id).toBe(empty.id);
      } finally {
        await server.stop();
      }
    }));
});
