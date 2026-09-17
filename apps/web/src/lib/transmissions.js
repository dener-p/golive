import { ENV } from "../env";
export async function createTransmission(title) {
    const res = await fetch(`${ENV.VITE_SERVER_URL}/api/transmissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ title }),
    });
    if (!res.ok) {
        throw new Error("Failed to create transmission");
    }
    return res.json();
}
export async function getTransmission(code) {
    const res = await fetch(`${ENV.VITE_SERVER_URL}/api/transmissions/${code}`, {
        credentials: "include",
    });
    if (!res.ok) {
        if (res.status === 404) {
            throw new Error("NotFound");
        }
        throw new Error("Failed to load transmission");
    }
    return res.json();
}
