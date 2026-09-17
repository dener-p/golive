import { ENV } from "../env";

import type { ApiKeyInfo } from "./turn-clients";

export type RelayStatus = {
  urls: string[];
  username: string | null;
  expiresAt: number;
  pushedAt: number;
  keyName: string;
};

export type TurnStatus = {
  keys: ApiKeyInfo[];
  relay: RelayStatus | null;
};

export async function getTurnStatus(): Promise<TurnStatus> {
  const res = await fetch(`${ENV.VITE_SERVER_URL}/api/turn/status`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("Failed to load TURN status");
  }
  return res.json() as Promise<TurnStatus>;
}