import { desc, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { randomBytes, randomUUID } from "node:crypto";

import { apiKey } from "@golive/db/schema/apiKey";
import { transmission } from "@golive/db/schema/transmission";
import {
  decryptClientSecret,
  encryptClientSecret,
  toIceServers,
  verifyHmacSignature,
  type IceServer,
} from "@golive/turn";

import { env } from "./env.server";
import { auth, getDb } from "./services";

const REQUEST_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_TTL_SECONDS = 3600;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const MAX_KEYS_PER_USER = 10;
const MAX_NAME_LENGTH = 64;

type RelayConfig = {
  iceServers: IceServer[];
  expiresAt: number;
  pushedAt: number;
  keyId: string;
  keyName: string;
};

// In-memory only. Keyed by the user who owns the API key used to push.
const relays = new Map<string, RelayConfig>();

function clampTtl(raw: unknown): number {
  const ttl = Number(raw);
  if (!Number.isInteger(ttl) || ttl < 60) {
    return DEFAULT_TTL_SECONDS;
  }
  return Math.min(ttl, MAX_TTL_SECONDS);
}

function validSignature(c: Context, secret: string): boolean {
  const rawTimestamp = c.req.header("X-Turn-Timestamp");
  const signature = c.req.header("X-Turn-Signature") ?? "";
  const timestamp = Number(rawTimestamp);
  if (!Number.isInteger(timestamp)) {
    return false;
  }
  if (Math.abs(Date.now() - timestamp * 1000) > REQUEST_WINDOW_MS) {
    return false;
  }
  return verifyHmacSignature(secret, String(timestamp), signature);
}

function configToIceServers(body: Record<string, unknown> | null): IceServer[] {
  if (!body) {
    return [];
  }
  const standard = toIceServers(body);
  if (standard.length > 0) {
    return standard;
  }
  const urls = Array.isArray(body.turn)
    ? body.turn.filter((url): url is string => typeof url === "string")
    : typeof body.turn === "string"
      ? [body.turn]
      : [];
  const username = typeof body.user === "string" ? body.user : undefined;
  const credential = typeof body.password === "string" ? body.password : undefined;
  if (urls.length > 0 && username && credential) {
    return [{ urls, username, credential }];
  }
  return [];
}

function sanitizeUrls(iceServers: IceServer[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const server of iceServers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      const cleaned = url.split("?")[0] ?? url;
      if (!seen.has(cleaned)) {
        seen.add(cleaned);
        out.push(cleaned);
      }
    }
  }
  return out;
}

async function findSession(c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session;
}

export const turnApp = new Hono();

// ---- key management ------------------------------------------------------------------

turnApp.get("/clients", async (c) => {
  const session = await findSession(c);
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const db = getDb();
  const keys = await db.query.apiKey.findMany({
    where: eq(apiKey.userId, session.user.id),
    orderBy: [desc(apiKey.createdAt)],
  });
  return c.json({
    keys: keys.map((key) => ({
      id: key.id,
      name: key.name,
      createdAt: key.createdAt.getTime(),
      revokedAt: key.revokedAt ? key.revokedAt.getTime() : null,
      lastUsedAt: key.lastUsedAt ? key.lastUsedAt.getTime() : null,
    })),
  });
});

turnApp.post("/clients", async (c) => {
  const session = await findSession(c);
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!env.TURN_API_KEY_ENC_KEY) {
    return c.json({ error: "TURN_API_KEY_ENC_KEY not configured" }, 503);
  }
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) {
    return c.json({ error: "name is required (max 64 chars)" }, 400);
  }

  const db = getDb();
  const existing = await db.query.apiKey.findMany({
    where: eq(apiKey.userId, session.user.id),
  });
  if (existing.length >= MAX_KEYS_PER_USER) {
    return c.json({ error: `limit of ${MAX_KEYS_PER_USER} keys reached` }, 400);
  }

  const id = randomUUID();
  const secret = randomBytes(32).toString("hex");
  await db.insert(apiKey).values({
    id,
    name,
    secret: encryptClientSecret(secret, env.TURN_API_KEY_ENC_KEY),
    userId: session.user.id,
  });
  return c.json({ key: { id, name, createdAt: Date.now() }, secret }, 201);
});

turnApp.post("/clients/:id/revoke", async (c) => {
  const session = await findSession(c);
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const db = getDb();
  const key = await db.query.apiKey.findFirst({
    where: eq(apiKey.id, c.req.param("id")),
  });
  if (!key || key.userId !== session.user.id) {
    return c.json({ error: "Not found" }, 404);
  }
  await db
    .update(apiKey)
    .set({ revokedAt: new Date() })
    .where(eq(apiKey.id, key.id));
  return c.json({ ok: true });
});

turnApp.delete("/clients/:id", async (c) => {
  const session = await findSession(c);
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const db = getDb();
  const key = await db.query.apiKey.findFirst({
    where: eq(apiKey.id, c.req.param("id")),
  });
  if (!key || key.userId !== session.user.id) {
    return c.json({ error: "Not found" }, 404);
  }
  await db.delete(apiKey).where(eq(apiKey.id, key.id));
  return c.json({ ok: true });
});

// ---- webhook, pushes TURN credentials keyed to the owning user ----------------

turnApp.post("/webhook", async (c) => {
  const keyId = c.req.header("X-Turn-Key");
  if (!keyId || !env.TURN_API_KEY_ENC_KEY) {
    return c.json({ error: "missing X-Turn-Key or TURN_API_KEY_ENC_KEY not configured" }, 401);
  }
  const db = getDb();
  const key = await db.query.apiKey.findFirst({
    where: eq(apiKey.id, keyId),
  });
  if (!key || key.userId === null || key.revokedAt) {
    return c.json({ error: "unknown or revoked key" }, 401);
  }

  let secret: string;
  try {
    secret = decryptClientSecret(key.secret, env.TURN_API_KEY_ENC_KEY);
  } catch {
    return c.json({ error: "invalid key" }, 401);
  }
  if (!validSignature(c, secret)) {
    return c.json({ error: "invalid signature" }, 401);
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const iceServers = configToIceServers(body);
  if (iceServers.length === 0) {
    return c.json({ error: "no valid TURN config in payload" }, 400);
  }
  const ttlSeconds = clampTtl(body?.ttl);
  const expiresAt = Date.now() + ttlSeconds * 1000;

  relays.set(key.userId, {
    iceServers,
    expiresAt,
    pushedAt: Date.now(),
    keyId: key.id,
    keyName: key.name,
  });
  console.log({set: {
    iceServers,
    expiresAt,
    pushedAt: Date.now(),
    keyId: key.id,
    keyName: key.name,
}})
  db.update(apiKey)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKey.id, key.id))
    .catch(() => {});

  return c.json({ ok: true, expiresAt, ttlSeconds });
});

// ---- consumption --------------------------------------------------------------------

// Served to web clients. With ?code= returns the room host's relay, otherwise the
// caller's own. Falls back to direct connections only when nothing is stored.
turnApp.get("/credentials", async (c) => {
  const session = await findSession(c);
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let relayOwnerId: string = session.user.id;
  const code = c.req.query("code")?.toLowerCase();
  if (code) {
    const room = await getDb().query.transmission.findFirst({
      where: eq(transmission.code, code),
    });
    if (room) {
      relayOwnerId = room.hostUserId;
    }
  }

  const relay = relays.get(relayOwnerId);
  console.log({relay})
  if (relay && relay.expiresAt > Date.now()) {
    return c.json({ iceServers: relay.iceServers });
  }
  return c.json({ iceServers: [] });
});

turnApp.get("/status", async (c) => {
  const session = await findSession(c);
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const db = getDb();
  const keys = await db.query.apiKey.findMany({
    where: eq(apiKey.userId, session.user.id),
    orderBy: [desc(apiKey.createdAt)],
  });
  const relay = relays.get(session.user.id);
  const fresh = relay != null && relay.expiresAt > Date.now();
  return c.json({
    keys: keys.map((key) => ({
      id: key.id,
      name: key.name,
      createdAt: key.createdAt.getTime(),
      revokedAt: key.revokedAt ? key.revokedAt.getTime() : null,
      lastUsedAt: key.lastUsedAt ? key.lastUsedAt.getTime() : null,
    })),
    relay: fresh
      ? {
          urls: sanitizeUrls(relay!.iceServers),
          username: relay!.iceServers[0]?.username ?? null,
          expiresAt: relay!.expiresAt,
          pushedAt: relay!.pushedAt,
          keyName: relay!.keyName,
        }
      : null,
  });
});
