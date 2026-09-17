import { Hono } from "hono";

import { env } from "./env.server";
import { auth } from "./services";

type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

type TurnResponse = { iceServers: IceServer[] };

const TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";
const CREDENTIAL_TTL_SECONDS = 3600;
const CACHE_TTL_MS = 30 * 60 * 1000;

const cache = { expiresAt: 0, iceServers: [] as IceServer[] };

export const turnApp = new Hono();

turnApp.get("/credentials", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_KEY_SECRET } = env;
  if (!CLOUDFLARE_TURN_KEY_ID || !CLOUDFLARE_TURN_KEY_SECRET) {
    // TURN not configured yet; clients fall back to direct connections only.
    return c.json({ iceServers: [] });
  }

  if (cache.iceServers.length > 0 && cache.expiresAt > Date.now()) {
    return c.json({ iceServers: cache.iceServers });
  }

  try {
    const res = await fetch(`${TURN_API}/${CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_TURN_KEY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
    });

    if (!res.ok) {
      return c.json({ error: "Cloudflare TURN credential request failed" }, 502);
    }

    const data = (await res.json()) as TurnResponse;
    if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {
      return c.json({ error: "Unexpected Cloudflare TURN response" }, 502);
    }

    cache.iceServers = data.iceServers;
    cache.expiresAt = Date.now() + CACHE_TTL_MS;
    return c.json({ iceServers: data.iceServers });
  } catch {
    return c.json({ error: "Unable to reach Cloudflare TURN API" }, 502);
  }
});