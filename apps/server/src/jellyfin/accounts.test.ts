import { describe, expect, test } from "bun:test";
import { seedBrowse } from "../api/view-fixtures.ts";
import { server } from "../auth/access.ts";
import { createIntegrationKey } from "../auth/integration-keys.ts";
import { checkPermission } from "../auth/permissions.ts";
import { issueSession } from "../auth/sessions.ts";
import { accessRules, users } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertLibraries } from "../libraries/testing.ts";
import { createJellyfinHandler } from "./http.ts";
import { jellyfinRoutes } from "./routes.ts";
import { jellyfinLogin } from "./testing.ts";

describe.skipIf(!databaseUrl)("Jellyfin account and preference writes", () => {
  test("handles passwordless accounts, revokes other sessions, and atomically re-enables full policies", () =>
    withDatabase(async (db) => {
      const seed = await seedBrowse(db);
      const handle = createJellyfinHandler(
        db,
        jellyfinRoutes(
          async () => new Response(),
          async () => new Response(),
        ),
      );
      const issue = (userId: string, deviceId: string) =>
        issueSession(
          db,
          userId,
          { clientName: "Web", deviceName: "Browser", deviceId },
          null,
        );
      const admin = await issue(seed.admin.id, "admin");
      const first = await issue(seed.viewer.id, "first");
      const other = await issue(seed.viewer.id, "other");
      const key = await createIntegrationKey(db, seed.admin.id, "Web");
      const call = async (path: string, token: string, body?: object) => {
        const response = await handle(
          new Request(`http://thalia.test${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              "X-Emby-Token": token,
              "Content-Type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
          "127.0.0.1",
        );
        if (response === undefined) throw new Error("Missing route");
        return response;
      };
      expect(
        (await call("/Users/Password", key.token, { NewPw: "stolen" })).status,
      ).toBe(403);
      expect(
        (
          await call(`/Users/Password?userId=${seed.viewer.id}`, key.token, {
            NewPw: "stolen",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call("/Users/Password", first.token, {
            CurrentPw: "viewer-pass",
            NewPw: "changed",
          })
        ).status,
      ).toBe(204);
      expect((await call("/Users/Me", first.token)).status).toBe(200);
      expect((await call("/Users/Me", other.token)).status).toBe(401);
      expect(
        (
          await call(`/Users/Password?userId=${seed.viewer.id}`, admin.token, {
            ResetPassword: true,
          })
        ).status,
      ).toBe(204);
      expect((await call("/Users/Me", first.token)).status).toBe(401);
      const header =
        'MediaBrowser Client="Web", Device="Browser", DeviceId="passwordless"';
      const resetToken = await jellyfinLogin(
        (request) => handle(request, "127.0.0.1"),
        header,
        "viewer",
        "",
      );
      expect(await (await call("/Users/Me", resetToken)).json()).toMatchObject({
        HasPassword: false,
        HasConfiguredPassword: false,
      });
      const created = await call("/Users/New", admin.token, {
        Name: "passwordless",
      });
      expect(created.status).toBe(200);
      expect(await created.json()).toMatchObject({ HasPassword: false });
      expect(
        await jellyfinLogin(
          (request) => handle(request, "127.0.0.1"),
          header,
          "passwordless",
          "",
        ),
      ).toBeString();
      await db.insert(users).values({
        username: "external-only",
        displayName: "External",
        passwordHash: null,
        oidcIssuer: "https://identity.test",
        oidcSubject: "external-subject",
      });
      const external = await handle(
        new Request("http://thalia.test/Users/AuthenticateByName", {
          method: "POST",
          headers: {
            Authorization: header,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ Username: "external-only", Pw: "" }),
        }),
        "127.0.0.1",
      );
      expect(external?.status).toBe(401);
      const me = (await (await call("/Users/Me", resetToken)).json()) as {
        Policy: object;
      };
      expect(
        (
          await call(`/Users/${seed.viewer.id}/Policy`, admin.token, {
            ...me.Policy,
            IsDisabled: true,
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await call(`/Users/${seed.viewer.id}/Policy`, admin.token, {
            ...me.Policy,
            IsDisabled: false,
          })
        ).status,
      ).toBe(204);
      expect((await call("/Users/Me", resetToken)).status).toBe(200);
      const adminDto = (await (
        await call("/Users/Me", admin.token)
      ).json()) as { Policy: object };
      expect(
        (
          await call(`/Users/${seed.admin.id}/Policy`, admin.token, {
            ...adminDto.Policy,
            IsAdministrator: false,
            IsDisabled: true,
          })
        ).status,
      ).toBe(409);
      expect(await (await call("/Users/Me", admin.token)).json()).toMatchObject(
        { Policy: { IsAdministrator: true, IsDisabled: false } },
      );
    }));
  test("round-trips scoped preferences and integration keys, and preserves the last administrator", () =>
    withDatabase(async (db) => {
      const seed = await seedBrowse(db);
      const handle = createJellyfinHandler(
        db,
        jellyfinRoutes(
          async () => new Response(),
          async () => new Response(),
        ),
      );
      const send = (request: Request) => handle(request, "127.0.0.1");
      const header =
        'MediaBrowser Client="Web", Device="Browser", DeviceId="account-test"';
      const admin = await jellyfinLogin(send, header, "admin", "admin-pass");
      const viewer = await jellyfinLogin(send, header);
      const call = async (
        path: string,
        token = viewer,
        body?: object,
        method = body === undefined ? "GET" : "POST",
      ) => {
        const response = await send(
          new Request(`http://thalia.test${path}`, {
            method,
            headers: {
              "X-Emby-Token": token,
              "Content-Type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        );
        if (response === undefined) throw new Error(`Missing route ${path}`);
        return response;
      };
      const preferences = "/DisplayPreferences/home?client=web";
      expect(
        (
          await call(preferences, viewer, {
            ViewType: "List",
            CustomPrefs: { theme: "dark" },
          })
        ).status,
      ).toBe(204);
      expect(await (await call(preferences)).json()).toMatchObject({
        ViewType: "List",
        CustomPrefs: { theme: "dark" },
      });
      expect(
        await (await call("/DisplayPreferences/home?client=tv")).json(),
      ).toMatchObject({ ViewType: "Poster" });
      expect(
        (await call(`${preferences}&userId=${seed.admin.id}`)).status,
      ).toBe(403);
      expect(
        (await call(preferences, viewer, { ShowBackdrop: "wrong" })).status,
      ).toBe(400);
      expect(
        (
          await call("/Users/Configuration", viewer, {
            HidePlayedInLatest: false,
          })
        ).status,
      ).toBe(204);
      expect(await (await call("/Users/Me")).json()).toMatchObject({
        Configuration: { HidePlayedInLatest: false },
      });

      expect((await call("/Auth/Keys?app=Web", viewer, {})).status).toBe(403);
      expect((await call("/Auth/Keys?app=Web", admin, {})).status).toBe(204);
      const keys = (await (await call("/Auth/Keys", admin)).json()) as {
        Items: { AccessToken: string; AppName: string }[];
      };
      const key = keys.Items.find((key) => key.AppName === "Web");
      expect(key?.AccessToken.length).toBeGreaterThan(20);
      if (key === undefined) throw new Error("Missing integration key");
      expect((await call("/Users/Me", key.AccessToken)).status).toBe(200);
      expect((await call("/Auth/Keys", key.AccessToken)).status).toBe(403);
      expect(
        (
          await call(
            `/Auth/Keys/${key.AccessToken}`,
            admin,
            undefined,
            "DELETE",
          )
        ).status,
      ).toBe(204);
      expect((await call("/Users/Me", key.AccessToken)).status).toBe(401);

      const policy = {
        AuthenticationProviderId:
          "Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider",
        PasswordResetProviderId:
          "Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider",
      };
      expect(
        (
          await call(`/Users/${seed.admin.id}/Policy`, admin, {
            ...policy,
            IsDisabled: true,
          })
        ).status,
      ).toBe(409);
      expect(
        (await call(`/Users/${seed.admin.id}`, admin, undefined, "DELETE"))
          .status,
      ).toBe(409);
      expect(
        (
          await call(`/Users/${seed.viewer.id}/Policy`, admin, {
            ...policy,
            EnableMediaPlayback: false,
            EnableSubtitleManagement: true,
            RemoteClientBitrateLimit: 4_000_000,
          })
        ).status,
      ).toBe(204);
      expect(await (await call("/Users/Me")).json()).toMatchObject({
        Policy: {
          EnableMediaPlayback: false,
          EnableSubtitleManagement: true,
          RemoteClientBitrateLimit: 4_000_000,
        },
      });
      expect(
        await checkPermission(db, seed.viewer.id, "download", server),
      ).toBe(true);
      const folders = await insertLibraries(db, [
        { name: "Allowed", medium: "movies", rootPath: "/allowed" },
        { name: "Denied", medium: "movies", rootPath: "/denied" },
      ]);
      const allowedFolder = folders[0];
      const deniedFolder = folders[1];
      if (!allowedFolder || !deniedFolder)
        throw new Error("Fixture Libraries missing.");
      expect(
        (
          await call(`/Users/${seed.viewer.id}/Policy`, admin, {
            ...policy,
            EnableAllFolders: false,
            EnabledFolders: [allowedFolder.id.replaceAll("-", "")],
          })
        ).status,
      ).toBe(204);
      expect(await (await call("/Users/Me")).json()).toMatchObject({
        Policy: {
          EnableAllFolders: false,
          EnabledFolders: [allowedFolder.id.replaceAll("-", "")],
        },
      });
      expect(
        await checkPermission(db, seed.viewer.id, "view", {
          type: "library",
          id: allowedFolder.id,
        }),
      ).toBe(true);
      expect(
        await checkPermission(db, seed.viewer.id, "view", {
          type: "library",
          id: deniedFolder.id,
        }),
      ).toBe(false);
      const folderRules = (await db.select().from(accessRules)).filter(
        (rule) => rule.userId === seed.viewer.id && rule.libraryId !== null,
      );
      expect(
        folderRules.map((rule) => ({
          libraryId: rule.libraryId,
          action: rule.action,
          allowed: rule.allowed,
        })),
      ).toEqual(
        expect.arrayContaining([
          { libraryId: allowedFolder.id, action: "view", allowed: true },
          { libraryId: deniedFolder.id, action: "view", allowed: false },
        ]),
      );
      expect(
        (
          await call(`/Users/${seed.viewer.id}/Policy`, admin, {
            ...policy,
            EnableAllFolders: true,
          })
        ).status,
      ).toBe(204);
      expect(
        (await db.select().from(accessRules)).filter(
          (rule) => rule.userId === seed.viewer.id && rule.libraryId !== null,
        ),
      ).toEqual([]);
      for (const allowed of [false, true]) {
        expect(
          (
            await call(`/Users/${seed.viewer.id}/Policy`, admin, {
              ...policy,
              EnableContentDownloading: allowed,
            })
          ).status,
        ).toBe(204);
        expect(
          await checkPermission(db, seed.viewer.id, "download", server),
        ).toBe(allowed);
      }
      expect(
        (
          await call("/Users/Password", viewer, {
            CurrentPw: "wrong",
            NewPw: "new-pass",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await call("/Users/Password", viewer, {
            CurrentPw: "viewer-pass",
            NewPw: "new-pass",
          })
        ).status,
      ).toBe(204);
      expect(
        await jellyfinLogin(send, header, "viewer", "new-pass"),
      ).toBeString();
      expect(
        (
          await call(`/Users/${seed.viewer.id}/Policy`, admin, {
            ...policy,
            IsDisabled: true,
          })
        ).status,
      ).toBe(204);
      expect((await call("/Users/Me")).status).toBe(401);
    }));
});
