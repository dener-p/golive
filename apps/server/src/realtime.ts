import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import { randomUUID } from "node:crypto";

import { transmission } from "@golive/db/schema/transmission";
import { auth, getDb } from "./services";

export type AppEnv = {
  Variables: {
    session: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
  };
};

type Role = "host" | "viewer";

type SdpMessage = { type: string; sdp?: string };
type IceCandidateMessage = {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

type ClientMessage =
  | { type: "join"; role: Role }
  | { type: "offer"; to: string; sdp: SdpMessage }
  | { type: "answer"; to: string; sdp: SdpMessage }
  | { type: "ice-candidate"; to: string; candidate: IceCandidateMessage };

type Room = {
  code: string;
  host: { peerId: string; ws: WSContext } | null;
  viewers: Map<string, WSContext>;
};

const rooms = new Map<string, Room>();
const connections = new Map<unknown, { peerId: string; role: Role; code: string }>();

function getRoom(code: string): Room {
  const existing = rooms.get(code);
  if (existing) {
    return existing;
  }
  const room: Room = { code, host: null, viewers: new Map() };
  rooms.set(code, room);
  return room;
}

function key(ws: WSContext): unknown {
  return ws.raw;
}

function send(ws: WSContext, message: unknown) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function findTargetWs(room: Room, peerId: string): WSContext | null {
  if (room.host?.peerId === peerId) {
    return room.host.ws;
  }
  return room.viewers.get(peerId) ?? null;
}

function cleanupHost(room: Room) {
  room.host = null;
  getDb()
    .update(transmission)
    .set({ status: "offline" })
    .where(eq(transmission.code, room.code))
    .catch(() => {});

  for (const viewerWs of room.viewers.values()) {
    send(viewerWs, { type: "host-left" });
  }
  room.viewers.clear();
}

function pruneEmptyRoom(room: Room) {
  if (!room.host && room.viewers.size === 0) {
    rooms.delete(room.code);
  }
}

export const realtimeApp = new Hono<AppEnv>();

realtimeApp.use(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.text("Unauthorized", 401);
  }
  c.set("session", session);
  await next();
});

realtimeApp.get(
  "/ws",
  upgradeWebSocket((c) => {
    const code = c.req.query("code")?.toLowerCase();
    const session = c.get("session");

    return {
      onOpen(_, ws) {
        if (!code) {
          ws.close(1008, "missing room code");
        }
      },

      async onMessage(event, ws) {
        if (!code) {
          ws.close(1008, "missing room code");
          return;
        }

        let msg: ClientMessage;
        try {
          msg = JSON.parse(event.data as string) as ClientMessage;
        } catch {
          send(ws, { type: "error", message: "invalid message" });
          return;
        }

        const room = getRoom(code);
        const db = getDb();

        if (msg.type === "join") {
          const roomRecord = await db.query.transmission.findFirst({
            where: eq(transmission.code, code),
          });
          if (!roomRecord) {
            send(ws, { type: "error", message: "room not found" });
            ws.close(1008, "room not found");
            return;
          }

          if (msg.role === "host") {
            if (roomRecord.hostUserId !== session.user.id) {
              send(ws, { type: "error", message: "you are not the host of this room" });
              ws.close(1008, "not the host");
              return;
            }
            if (room.host) {
              send(ws, { type: "error", message: "host already connected" });
              ws.close(4001, "host already connected");
              return;
            }
            const peerId = randomUUID();
            room.host = { peerId, ws };
            connections.set(key(ws), { peerId, role: "host", code });
            await db
              .update(transmission)
              .set({ status: "live" })
              .where(eq(transmission.code, code));

            for (const viewerPeerId of room.viewers.keys()) {
              send(room.host.ws, { type: "viewer-joined", peerId: viewerPeerId });
            }
          } else {
            const peerId = randomUUID();
            room.viewers.set(peerId, ws);
            connections.set(key(ws), { peerId, role: "viewer", code });
            send(ws, {
              type: "joined",
              peerId,
              role: "viewer",
              hostId: room.host?.peerId ?? undefined,
            });
            if (room.host) {
              send(room.host.ws, { type: "viewer-joined", peerId });
            }
          }
          return;
        }

        const senderPeerId = connections.get(key(ws))?.peerId;
        if (!senderPeerId) {
          send(ws, { type: "error", message: "join before signaling" });
          return;
        }

        if (msg.type === "offer" || msg.type === "answer") {
          const target = findTargetWs(room, msg.to);
          if (!target) {
            return;
          }
          send(target, { type: msg.type, from: senderPeerId, sdp: msg.sdp });
        } else if (msg.type === "ice-candidate") {
          const target = findTargetWs(room, msg.to);
          if (!target) {
            return;
          }
          send(target, { type: "ice-candidate", from: senderPeerId, candidate: msg.candidate });
        }
      },

      onClose(_, ws) {
        const conn = connections.get(key(ws));
        if (!conn) {
          return;
        }
        connections.delete(key(ws));
        const room = rooms.get(conn.code);
        if (!room) {
          return;
        }
        if (conn.role === "host") {
          cleanupHost(room);
        } else {
          room.viewers.delete(conn.peerId);
          if (room.host) {
            send(room.host.ws, { type: "viewer-left", peerId: conn.peerId });
          }
        }
        pruneEmptyRoom(room);
      },

      onError(_, ws) {
        const conn = connections.get(key(ws));
        if (conn) {
          connections.delete(key(ws));
          const room = rooms.get(conn.code);
          if (room) {
            if (conn.role === "host") {
              cleanupHost(room);
            } else {
              room.viewers.delete(conn.peerId);
            }
            pruneEmptyRoom(room);
          }
        }
      },
    };
  }),
);
