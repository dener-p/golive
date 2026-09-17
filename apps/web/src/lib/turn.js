import { ENV } from "../env";
/**
 * Fetches TURN credentials for a room from the signaling server. With `code`
 * set, returns the room host's pushed relay config (viewers connect through it);
 * without it, the caller's own config. Resolves to `[]` when the host has no
 * relay or it expired, so WebRTC still works over direct connections.
 */
export function getIceServers(code) {
    const params = code ? `?code=${encodeURIComponent(code)}` : "";
    return fetch(`${ENV.VITE_SERVER_URL}/api/turn/credentials${params}`, {
        credentials: "include",
    })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => data?.iceServers ?? [])
        .catch(() => []);
}
