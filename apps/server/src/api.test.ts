import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "./api.ts";
import { type Database, probeDatabase } from "./db/client.ts";
import { createJellyfinHandler, json } from "./jellyfin/http.ts";

const alwaysReady = async () => true;

test("the api server answers its liveness check", async () => {
  const server = startApiServer(alwaysReady, 0);

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);

    expect(response.status).toBe(200);
  } finally {
    await server.stop(true);
  }
});

test("readiness follows the probe: 200 when it passes, 503 when it fails", async () => {
  const ready = startApiServer(alwaysReady, 0);
  const notReady = startApiServer(async () => false, 0);

  try {
    expect((await fetch(`http://127.0.0.1:${ready.port}/readyz`)).status).toBe(
      200,
    );
    expect(
      (await fetch(`http://127.0.0.1:${notReady.port}/readyz`)).status,
    ).toBe(503);
  } finally {
    await ready.stop(true);
    await notReady.stop(true);
  }
});

test("the database probe reports an unreachable server as not ready", async () => {
  expect(
    await probeDatabase("postgresql://unused:unused@127.0.0.1:1/unused"),
  ).toBe(false);
});

let fixtureRoot: string;
let previousWebRoot: string | undefined;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "thalia-web-"));
  writeFileSync(join(fixtureRoot, "index.html"), "<h1>Thalia index</h1>");
  writeFileSync(join(fixtureRoot, "200.html"), "<h1>Thalia shell</h1>");
  previousWebRoot = Bun.env.THALIA_WEB_ROOT;
  Bun.env.THALIA_WEB_ROOT = fixtureRoot;
});

afterEach(() => {
  if (previousWebRoot === undefined) {
    delete Bun.env.THALIA_WEB_ROOT;
  } else {
    Bun.env.THALIA_WEB_ROOT = previousWebRoot;
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
});

test("the web app lives under /web, and / redirects there", async () => {
  const server = startApiServer(alwaysReady, 0);
  const base = `http://127.0.0.1:${server.port}`;

  try {
    for (const path of ["/", "/web"]) {
      const response = await fetch(`${base}${path}`, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/web/");
    }
    expect(await (await fetch(`${base}/web/`)).text()).toContain(
      "Thalia index",
    );
    expect(await (await fetch(`${base}/web/movies`)).text()).toContain(
      "Thalia shell",
    );
  } finally {
    await server.stop(true);
  }
});

test("Thalia answers under /api and Jellyfin owns every other path", async () => {
  const jellyfin = createJellyfinHandler({} as Database, [
    {
      method: "GET",
      path: "/Movies/Recommendations",
      anonymous: true,
      handle: () => json("jellyfin"),
    },
  ]);
  const server = startApiServer(alwaysReady, 0, {
    api: async (request) =>
      new URL(request.url).pathname === "/api/rpc/setup/status"
        ? Response.json("thalia")
        : undefined,
    jellyfin,
  });
  const base = `http://127.0.0.1:${server.port}`;

  try {
    expect(await (await fetch(`${base}/api/rpc/setup/status`)).json()).toBe(
      "thalia",
    );
    expect(await (await fetch(`${base}/Movies/Recommendations`)).json()).toBe(
      "jellyfin",
    );
    // Unmatched paths, old web app paths among them, are Jellyfin's 404s.
    for (const path of ["/movies", "/rpc/setup/status", "/some/client/route"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
    }
    expect((await fetch(`${base}/api/nothing`)).status).toBe(404);
  } finally {
    await server.stop(true);
  }
});
