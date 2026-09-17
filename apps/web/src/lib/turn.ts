import { ENV } from "../env";

type TurnResponse = { iceServers: RTCIceServer[] };

const CACHE_TTL_MS = 30 * 60 * 1000;
let cached: Promise<RTCIceServer[]> | null = null;

/**
 * Fetches short-lived Cloudflare TURN credentials from the signaling server and
 * caches them for the session. Resolves to `[]` if TURN is not configured or
 * the request fails, so WebRTC still works over direct connections.
 */
export function getIceServers(): Promise<RTCIceServer[]> {
  if (!cached) {
    cached = fetch(`${ENV.VITE_SERVER_URL}/api/turn/credentials`, {
      credentials: "include",
    })
      .then((res) => (res.ok ? (res.json() as Promise<TurnResponse>) : null))
      .then((data) => data?.iceServers ?? [])
      .catch(() => [])
      .finally(() => {
        setTimeout(() => {
          cached = null;
        }, CACHE_TTL_MS);
      });
  }
  return cached;
}