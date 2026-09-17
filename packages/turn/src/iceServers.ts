import type { IceServer } from "./types";

export function isIceServer(value: unknown): value is IceServer {
  if (!value || typeof value !== "object") {
    return false;
  }
  const server = value as Record<string, unknown>;
  if (typeof server.urls === "string") {
    return true;
  }
  return (
    Array.isArray(server.urls) &&
    server.urls.length > 0 &&
    server.urls.every((url) => typeof url === "string")
  );
}

/**
 * Normalizes a credentials response into a list of iceServers. Accepts either
 * the standard `{ iceServers: [...] }` shape or the coturn REST API shape
 * `{ username, credential, urls: [...] }`.
 */
export function toIceServers(data: unknown): IceServer[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.iceServers)) {
    return record.iceServers.filter(isIceServer);
  }
  const username = typeof record.username === "string" ? record.username : undefined;
  const credential = typeof record.credential === "string" ? record.credential : undefined;
  if (username && credential) {
    const urls = Array.isArray(record.urls)
      ? record.urls.filter((url): url is string => typeof url === "string")
      : typeof record.urls === "string"
        ? [record.urls]
        : [];
    if (urls.length > 0) {
      return [{ urls, username, credential }];
    }
  }
  return [];
}