import { relations, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { user } from "./auth";

export const transmission = sqliteTable("transmission", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  title: text("title").default("Untitled").notNull(),
  hostUserId: text("host_user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["offline", "live"] })
    .default("offline")
    .notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
});

export const transmissionRelations = relations(transmission, ({ one }) => ({
  hostUser: one(user, {
    fields: [transmission.hostUserId],
    references: [user.id],
  }),
}));
