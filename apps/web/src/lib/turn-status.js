import { ENV } from "../env";
export async function getTurnStatus() {
    const res = await fetch(`${ENV.VITE_SERVER_URL}/api/turn/status`, {
        credentials: "include",
    });
    if (!res.ok) {
        throw new Error("Failed to load TURN status");
    }
    return res.json();
}
