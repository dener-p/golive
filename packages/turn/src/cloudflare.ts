import type { IceServer } from "./types";
import { toIceServers } from "./iceServers";

const CLOUDFLARE_TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";

/**
 * Mints short-lived STUN/TURN iceServers from a Cloudflare Calls TURN key.
 * The key lives server-side only; the returned iceServers are safe to hand to
 * browsers/WebRTC clients.
 */
export async function mintCloudflareIceServers(
  keyId: string,
  keySecret: string,
  ttlSeconds = 3600,
): Promise<IceServer[]> {
  const res = await fetch(
    `${CLOUDFLARE_TURN_API}/${keyId}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keySecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: ttlSeconds }),
    },
  );
  if (!res.ok) {
    throw new Error(`Cloudflare TURN request failed: ${res.status}`);
  }
  const iceServers = toIceServers(await res.json());
  if (iceServers.length === 0) {
    throw new Error("Unexpected Cloudflare TURN response");
  }
  return iceServers;
}