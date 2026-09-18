import {
  hmacSignature,
  mintCloudflareIceServers,
  type IceServer,
} from "@golive/turn";

import { env } from "./env.server";

type Config = {
  cloudflareKeyId: string;
  cloudflareKeySecret: string;
  webhookUrl: string;
  webhookKey: string;
  webhookKeySecret: string;
  ttl: number;
};

function config(): Config {
  const ttl = Number(env.CLOUDFLARE_TURN_TOKEN_TTL);
  const cloudflareKeyId = env.CLOUDFLARE_TURN_KEY_ID;
  const cloudflareKeySecret = env.CLOUDFLARE_TURN_KEY_SECRET;
  const webhookUrl = env.TURN_WEBHOOK_URL;
  const webhookKey = env.TURN_WEBHOOK_KEY.split(",");
  const webhookKeySecret = env.TURN_WEBHOOK_KEY_SECRET.split(",");
  if (
    !cloudflareKeyId ||
    !cloudflareKeySecret ||
    !webhookUrl ||
    !webhookKey ||
    !webhookKeySecret
  ) {
    throw new Error(
      "CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_KEY_SECRET, TURN_WEBHOOK_URL, TURN_WEBHOOK_KEY and TURN_WEBHOOK_KEY_SECRET must be set",
    );
  }
  return {
    cloudflareKeyId,
    cloudflareKeySecret,
    webhookUrl,
    webhookKey,
    webhookKeySecret,
    ttl: Number.isInteger(ttl) && ttl > 0 ? ttl : 1800,
  };
}

async function pushCredentials(): Promise<IceServer[]> {
  const {
    cloudflareKeyId,
    cloudflareKeySecret,
    webhookUrl,
    webhookKey,
    webhookKeySecret,
    ttl,
  } = config();
  const iceServers = await mintCloudflareIceServers(
    cloudflareKeyId,
    cloudflareKeySecret,
    ttl,
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  webhookKey.forEach( async (e,i) => {
    
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Turn-Key": e,
      "X-Turn-Timestamp": timestamp,
      "X-Turn-Signature": hmacSignature(webhookKeySecret[i], timestamp),
    },
    body: JSON.stringify({ iceServers, ttl }),
  });
    if (!res.ok) {
      throw new Error(`webhook rejected push: ${res.status}`);
    }
  })

  return iceServers;
}

if (import.meta.main) {
  const { ttl } = config();
  try {
    const iceServers = await pushCredentials();
    console.log(`[turn] pushed ${iceServers.length} iceServers for ${ttl}s`);
  } catch (error) {
    console.error("[turn] initial push failed:", error);
  }

  const intervalMs = (Number(env.TURN_REFRESH_INTERVAL_SECONDS) || 300) * 1000;
  setInterval(async () => {
    try {
      const iceServers = await pushCredentials();
      console.log(`[turn] pushed ${iceServers.length} iceServers for ${ttl}s`);
    } catch (error) {
      console.error("[turn] push failed:", error);
    }
  }, intervalMs);
}
