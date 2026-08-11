import { MongoClient, type Db } from "mongodb";
import { config } from "./config.js";

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

let client: MongoClient | undefined;
let db: Db | undefined;
let connectPromise: Promise<void> | undefined;

/**
 * Idempotent: safe to call from multiple entry points (the Express server's startup, and
 * standalone LangGraph graph modules hosted by `langgraphjs dev`/platform, which have no
 * shared startup path with `index.ts`). Concurrent callers await the same in-flight connect.
 */
export async function connectDb(): Promise<void> {
  if (db) return;
  if (!connectPromise) {
    connectPromise = (async () => {
      client = new MongoClient(config.mongoUri);
      await client.connect();
      db = client.db(config.mongoDbName);

      await db.collection<UserRow>("users").createIndex({ username: 1 }, { unique: true });
    })();
  }
  await connectPromise;
}

export function getDb(): Db {
  if (!db) throw new Error("Database not connected - call connectDb() before using it.");
  return db;
}

export async function createUser(id: string, username: string, passwordHash: string): Promise<void> {
  await getDb()
    .collection<UserRow>("users")
    .insertOne({ id, username, passwordHash, createdAt: new Date().toISOString() });
}

export async function findUserByUsername(username: string): Promise<UserRow | null> {
  return getDb().collection<UserRow>("users").findOne({ username }, { projection: { _id: 0 } });
}

export async function findUserById(id: string): Promise<UserRow | null> {
  return getDb().collection<UserRow>("users").findOne({ id }, { projection: { _id: 0 } });
}
