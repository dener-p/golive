import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";

import { transmission } from "@golive/db/schema/transmission";

import { auth, getDb } from "./services";

const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

function generateCode(): string {
  const random = crypto.getRandomValues(new Uint8Array(5));
  let code = "";
  for (const n of random) {
    code += CODE_ALPHABET[n % CODE_ALPHABET.length];
  }
  return code;
}

export const transmissionsApp = new Hono();

transmissionsApp.post("/", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = (await c.req.json().catch(() => ({}))) as { title?: string };
  const title = body.title?.trim() || "Untitled";

  const db = getDb();
  let code = generateCode();
  while (await db.query.transmission.findFirst({ where: eq(transmission.code, code) })) {
    code = generateCode();
  }

  const id = randomUUID();
  await db.insert(transmission).values({
    id,
    code,
    title,
    hostUserId: session.user.id,
    status: "offline",
  });

  return c.json({ id, code, title, watchUrl: `/watch/${code}` }, 201);
});

transmissionsApp.get("/:code", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { code } = c.req.param();
  const room = await getDb().query.transmission.findFirst({
    where: eq(transmission.code, code.toLowerCase()),
    with: { hostUser: true },
  });

  if (!room) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.json({
    code: room.code,
    title: room.title,
    status: room.status,
    hostUserId: room.hostUserId,
    host: {
      name: room.hostUser.name,
      image: room.hostUser.image,
    },
  });
});
