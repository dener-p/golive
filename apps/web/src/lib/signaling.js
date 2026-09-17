import { ENV } from "../env";
/**
 * Maintains a single WebSocket to the signaling server. If the socket drops
 * unexpectedly it reconnects with exponential backoff and calls `onOpen` again
 * so the caller can re-send its `join`.
 */
export function connectSignaling(code, handlers) {
    const retryDelay = (attempt) => Math.min(1000 * 2 ** attempt, 8000);
    let ws = null;
    let stopped = false;
    let attempt = 0;
    let reconnectTimer = null;
    const open = () => {
        if (stopped) {
            return;
        }
        const url = new URL("/ws", ENV.VITE_SERVER_URL);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("code", code);
        ws = new WebSocket(url.toString());
        ws.onopen = () => {
            attempt = 0;
            handlers.onOpen();
        };
        ws.onmessage = (event) => {
            try {
                const parsed = JSON.parse(event.data);
                handlers.onMessage(parsed);
            }
            catch {
                // ignore malformed signaling messages
            }
        };
        ws.onclose = () => {
            ws = null;
            if (stopped) {
                return;
            }
            handlers.onClose();
            reconnectTimer = setTimeout(() => {
                attempt += 1;
                open();
            }, retryDelay(attempt));
        };
    };
    const close = () => {
        stopped = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        ws?.close();
        ws = null;
    };
    open();
    return {
        send(message) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(message));
            }
        },
        restart() {
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            const current = ws;
            ws = null;
            if (current) {
                current.onclose = null;
                current.close();
            }
            attempt = 0;
            open();
        },
        close,
    };
}
