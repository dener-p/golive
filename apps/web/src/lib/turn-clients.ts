import { ENV } from "../env";

export type ApiKeyInfo = {
  id: string;
  name: string;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
};

export type CreatedApiKey = {
  key: ApiKeyInfo & { createdAt: number };
  secret: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ENV.VITE_SERVER_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export function listApiKeys(): Promise<{ keys: ApiKeyInfo[] }> {
  return request("/api/turn/clients");
}

export function createApiKey(name: string): Promise<CreatedApiKey> {
  return request("/api/turn/clients", { method: "POST", body: JSON.stringify({ name }) });
}

export function revokeApiKey(id: string): Promise<{ ok: true }> {
  return request(`/api/turn/clients/${id}/revoke`, { method: "POST" });
}

export function deleteApiKey(id: string): Promise<{ ok: true }> {
  return request(`/api/turn/clients/${id}`, { method: "DELETE" });
}