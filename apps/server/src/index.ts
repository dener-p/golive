import { createBunWebSocket } from "hono/bun";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { env } from "./env.server";
import { realtimeApp } from "./realtime";
import { auth } from "./services";
import { transmissionsApp } from "./transmissions";

const { websocket } = createBunWebSocket();

const app = new Hono();

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.on(["POST", "GET"], "/api/auth/*", async (c) => auth.handler(c.req.raw));

app.route("/api/transmissions", transmissionsApp);
app.route("/", realtimeApp);

app.get("/", (c) => {
  return c.text("OK");
});

if (import.meta.main) {
  const server = Bun.serve({
    port: Number(process.env.PORT) || 3000,
    fetch: app.fetch,
    websocket,
  });
  console.log(`golive server on http://localhost:${server.port}`);
}
