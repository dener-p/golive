import { ENV } from "../env";

export type TransmissionInfo = {
  code: string;
  title: string;
  status: "offline" | "live";
  hostUserId: string;
  host: {
    name: string;
    image: string | null;
  };
};

export type CreateTransmissionResult = {
  id: string;
  code: string;
  title: string;
  watchUrl: string;
};

export async function createTransmission(title: string): Promise<CreateTransmissionResult> {
  const res = await fetch(`${ENV.VITE_SERVER_URL}/api/transmissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    throw new Error("Failed to create transmission");
  }
  return res.json() as Promise<CreateTransmissionResult>;
}

export async function getTransmission(code: string): Promise<TransmissionInfo> {
  const res = await fetch(`${ENV.VITE_SERVER_URL}/api/transmissions/${code}`, {
    credentials: "include",
  });
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error("NotFound");
    }
    throw new Error("Failed to load transmission");
  }
  return res.json() as Promise<TransmissionInfo>;
}
