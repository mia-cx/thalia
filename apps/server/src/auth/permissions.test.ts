import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, type Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  type Action,
  accessRules,
  actions,
  groups,
  userGroups,
  users,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertLibraries } from "../libraries/testing.ts";
import { server } from "./access.ts";
import {
  checkPermission,
  createGroup,
  setPermissionOverride,
  setUserGroups,
} from "./permissions.ts";

async function createUser(
  db: Database,
  username: string,
  groupNames: string[] = [],
) {
  const [user] = await db
    .insert(users)
    .values({ username, displayName: username, passwordHash: "fixture" })
    .returning();
  if (!user) throw new Error("Fixture user missing.");
  if (groupNames.length) {
    const all = await db.select().from(groups);
    const ids = groupNames.map((name) => {
      const group = all.find((g) => g.name === name);
      if (!group) throw new Error(`Fixture group ${name} missing.`);
      return group.id;
    });
    await db
      .insert(userGroups)
      .values(ids.map((groupId) => ({ userId: user.id, groupId })));
  }
  return user;
}

async function createLibrary(db: Database, name: string) {
  const [library] = await insertLibraries(db, {
    name,
    medium: "shows",
    rootPath: `/${name}`,
  });
  if (!library) throw new Error("Fixture library missing.");
  return library;
}

const management = actions.filter(
  (p) => p !== "view" && p !== "play" && p !== "download",
);

describe.skipIf(!databaseUrl)("auth permissions", () => {
  test("seeded users member grants view and play, denies management", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const user = await createUser(db, "viewer", ["users"]);
      expect(await checkPermission(db, user.id, "view", server)).toBe(true);
      expect(await checkPermission(db, user.id, "play", server)).toBe(true);
      expect(await checkPermission(db, user.id, "download", server)).toBe(true);
      for (const permission of management)
        expect(await checkPermission(db, user.id, permission, server)).toBe(
          false,
        );
    }));

  test("seeded admins member bypasses overrides and library denies", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await createUser(db, "admin", ["admins"]);
      for (const permission of actions)
        expect(await checkPermission(db, admin.id, permission, server)).toBe(
          true,
        );
      await setPermissionOverride(db, admin.id, admin.id, "view", false);
      const library = await createLibrary(db, "denied");
      const [admins] = await db
        .select()
        .from(groups)
        .where(eq(groups.name, "admins"));
      if (!admins) throw new Error("Seed group missing.");
      await db.insert(accessRules).values({
        action: "view",
        libraryId: library.id,
        groupId: admins.id,
        allowed: false,
      });
      expect(
        await checkPermission(db, admin.id, "view", {
          type: "library",
          id: library.id,
        }),
      ).toBe(true);
      expect(await checkPermission(db, admin.id, "view", server)).toBe(true);
    }));

  test("custom groups union permissions and never bypass like admins", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await createUser(db, "admin", ["admins"]);
      const metadata = await createGroup(db, admin.id, {
        name: "metadata",
        permissions: ["metadata:edit", "view"],
      });
      const subtitles = await createGroup(db, admin.id, {
        name: "subtitles",
        permissions: ["subtitles:edit", "view"],
      });
      const user = await createUser(db, "editor");
      await setUserGroups(db, admin.id, user.id, [metadata.id, subtitles.id]);
      expect(await checkPermission(db, user.id, "metadata:edit", server)).toBe(
        true,
      );
      expect(await checkPermission(db, user.id, "subtitles:edit", server)).toBe(
        true,
      );
      expect(await checkPermission(db, user.id, "users:manage", server)).toBe(
        false,
      );
      await setPermissionOverride(
        db,
        admin.id,
        user.id,
        "metadata:edit",
        false,
      );
      expect(await checkPermission(db, user.id, "metadata:edit", server)).toBe(
        false,
      );
      await setPermissionOverride(
        db,
        admin.id,
        user.id,
        "libraries:manage",
        true,
      );
      expect(
        await checkPermission(db, user.id, "libraries:manage", server),
      ).toBe(true);
      await setPermissionOverride(db, admin.id, user.id, "metadata:edit", null);
      expect(await checkPermission(db, user.id, "metadata:edit", server)).toBe(
        true,
      );
    }));

  test("Library rules override the server and user rules beat Groups", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await createUser(db, "admin", ["admins"]);
      const allowed = await createGroup(db, admin.id, {
        name: "allowed",
        permissions: ["view"],
      });
      const denied = await createGroup(db, admin.id, {
        name: "denied",
        permissions: ["view"],
      });
      const library = await createLibrary(db, "library");
      const other = await createLibrary(db, "other");
      const user = await createUser(db, "member");
      await setUserGroups(db, admin.id, user.id, [allowed.id, denied.id]);

      await db.insert(accessRules).values([
        {
          action: "view",
          libraryId: library.id,
          userId: user.id,
          allowed: true,
        },
        {
          action: "view",
          libraryId: library.id,
          groupId: denied.id,
          allowed: false,
        },
      ]);
      expect(
        await checkPermission(db, user.id, "view", {
          type: "library",
          id: library.id,
        }),
      ).toBe(true);
      expect(
        await checkPermission(db, user.id, "view", {
          type: "library",
          id: other.id,
        }),
      ).toBe(true);

      const outsider = await createUser(db, "outsider");
      expect(await checkPermission(db, outsider.id, "view", server)).toBe(
        false,
      );
      await db.insert(accessRules).values({
        action: "view",
        libraryId: library.id,
        userId: outsider.id,
        allowed: true,
      });
      expect(
        await checkPermission(db, outsider.id, "view", {
          type: "library",
          id: library.id,
        }),
      ).toBe(true);
      expect(
        await checkPermission(db, outsider.id, "play", {
          type: "library",
          id: library.id,
        }),
      ).toBe(false);
      await db.insert(accessRules).values({
        action: "view",
        libraryId: other.id,
        groupId: allowed.id,
        allowed: false,
      });
      expect(
        await checkPermission(db, user.id, "view", {
          type: "library",
          id: other.id,
        }),
      ).toBe(false);
    }));

  test("missing or disabled users hold no permission, even as admins", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await createUser(db, "admin", ["admins"]);
      expect(
        await checkPermission(db, Bun.randomUUIDv7(), "users:manage", server),
      ).toBe(false);
      await db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, admin.id));
      expect(await checkPermission(db, admin.id, "server:manage", server)).toBe(
        false,
      );
      await expect(
        setUserGroups(db, admin.id, admin.id, []),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }));

  test("users:manage cannot grant groups or override permissions", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await createUser(db, "admin", ["admins"]);
      const managerGroup = await createGroup(db, admin.id, {
        name: "managers",
        permissions: ["users:manage", "view"],
      });
      const manager = await createUser(db, "manager");
      await setUserGroups(db, admin.id, manager.id, [managerGroup.id]);
      const allPermissions = await createGroup(db, admin.id, {
        name: "all-permissions",
        permissions: [...actions],
      });
      const [admins] = await db
        .select()
        .from(groups)
        .where(eq(groups.name, "admins"));
      if (!admins) throw new Error("Seed group missing.");
      expect(
        await checkPermission(db, manager.id, "users:manage", server),
      ).toBe(true);
      await expect(
        createGroup(db, manager.id, {
          name: "escalated",
          permissions: ["server:manage"],
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      for (const groupId of [allPermissions.id, admins.id])
        await expect(
          setUserGroups(db, manager.id, manager.id, [groupId]),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        setPermissionOverride(
          db,
          manager.id,
          manager.id,
          "server:manage",
          true,
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        setPermissionOverride(
          db,
          manager.id,
          manager.id,
          "server:manage",
          null,
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(
        await checkPermission(db, manager.id, "server:manage", server),
      ).toBe(false);
    }));

  test("membership replacement preserves the final enabled admin", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await createUser(db, "admin", ["admins"]);
      const disabled = await createUser(db, "disabled", ["admins"]);
      await db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, disabled.id));
      const [members] = await db
        .select()
        .from(groups)
        .where(eq(groups.name, "users"));
      if (!members) throw new Error("Seed group missing.");
      for (const groupIds of [[], [members.id]]) {
        await expect(
          setUserGroups(db, admin.id, admin.id, groupIds),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(
          await checkPermission(db, admin.id, "users:manage", server),
        ).toBe(true);
      }
      const replacement = await createUser(db, "replacement", ["admins"]);
      await setUserGroups(db, admin.id, admin.id, [members.id]);
      expect(await checkPermission(db, admin.id, "users:manage", server)).toBe(
        false,
      );
      expect(
        await checkPermission(db, replacement.id, "users:manage", server),
      ).toBe(true);
    }));

  test("concurrent admin demotions preserve one enabled admin", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const first = await createUser(db, "first", ["admins"]);
      const other = await createUser(db, "other", ["admins"]);
      const second = createDatabase(url);
      try {
        const results = await Promise.allSettled([
          setUserGroups(db, first.id, first.id, []),
          setUserGroups(second.db, other.id, other.id, []),
        ]);
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        const rejected = results.find((result) => result.status === "rejected");
        expect(rejected).toMatchObject({
          status: "rejected",
          reason: { code: "CONFLICT" },
        });
        const enabled = await Promise.all([
          checkPermission(db, first.id, "users:manage", server),
          checkPermission(db, other.id, "users:manage", server),
        ]);
        expect(enabled.filter(Boolean)).toHaveLength(1);
      } finally {
        await second.close();
      }
    }));

  test("mutations require built-in admins and validate groups", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await createUser(db, "admin", ["admins"]);
      const ordinary = await createUser(db, "ordinary", ["users"]);
      const custom = await createGroup(db, admin.id, {
        name: "editors",
        permissions: ["view"],
      });
      await expect(
        createGroup(db, ordinary.id, { name: "nope", permissions: [] }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        setUserGroups(db, ordinary.id, ordinary.id, [custom.id]),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        setPermissionOverride(db, ordinary.id, ordinary.id, "view", true),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const member = await createUser(db, "member");
      await setUserGroups(db, admin.id, member.id, [custom.id]);
      expect(await checkPermission(db, member.id, "view", server)).toBe(true);
      await setUserGroups(db, admin.id, member.id, []);
      expect(await checkPermission(db, member.id, "view", server)).toBe(false);
      await expect(
        setUserGroups(db, admin.id, member.id, [Bun.randomUUIDv7()]),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        setUserGroups(db, admin.id, Bun.randomUUIDv7(), []),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        setPermissionOverride(db, admin.id, Bun.randomUUIDv7(), "view", true),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      for (const name of ["admins", "USERS", "  ", "x".repeat(81), "\u0000"])
        await expect(
          createGroup(db, admin.id, { name, permissions: [] }),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        createGroup(db, admin.id, {
          name: "bad",
          permissions: ["nope" as Action],
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        createGroup(db, admin.id, { name: "editors", permissions: [] }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }));

  test("concurrent membership replacements leave exactly one result", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const admin = await createUser(db, "admin", ["admins"]);
      const metadata = await createGroup(db, admin.id, {
        name: "metadata",
        permissions: ["metadata:edit", "view"],
      });
      const subtitles = await createGroup(db, admin.id, {
        name: "subtitles",
        permissions: ["subtitles:edit", "view"],
      });
      const target = await createUser(db, "target");
      const second = createDatabase(url);
      try {
        await Promise.all([
          setUserGroups(db, admin.id, target.id, [metadata.id]),
          setUserGroups(second.db, admin.id, target.id, [subtitles.id]),
        ]);
        const result = await Promise.all([
          checkPermission(db, target.id, "metadata:edit", server),
          checkPermission(db, target.id, "subtitles:edit", server),
        ]);
        expect(result).toSatisfy(
          (r) =>
            (r[0] === true && r[1] === false) ||
            (r[0] === false && r[1] === true),
        );
      } finally {
        await second.close();
      }
    }));
});
