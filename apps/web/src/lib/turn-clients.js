import { ENV } from "../env";
async function request(path, init) {
    const res = await fetch(`${ENV.VITE_SERVER_URL}${path}`, {
        ...init,
        credentials: "include",
        headers: { "Content-Type": "application/json", ...init?.headers },
    });
    if (!res.ok) {
        const body = (await res.json().catch(() => null));
        throw new Error(body?.error ?? `Request failed (${res.status})`);
    }
    return res.json();
}
export function listApiKeys() {
    return request("/api/turn/clients");
}
export function createApiKey(name) {
    return request("/api/turn/clients", { method: "POST", body: JSON.stringify({ name }) });
}
export function revokeApiKey(id) {
    return request(`/api/turn/clients/${id}/revoke`, { method: "POST" });
}
export function deleteApiKey(id) {
    return request(`/api/turn/clients/${id}`, { method: "DELETE" });
}
