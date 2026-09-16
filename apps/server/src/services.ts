import { createAuth } from "@golive/auth";
import { type Database, createDb } from "@golive/db";

import { env } from "./env.server";

const db = createDb(env);

export function getDb(): Database {
  return db;
}
export const auth = createAuth(env, db);
