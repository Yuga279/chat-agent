import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )
`);

export function createUser(id: string, username: string, passwordHash: string): void {
  db.prepare("INSERT INTO users (id, username, passwordHash, createdAt) VALUES (@id, @username, @passwordHash, @now)").run(
    { id, username, passwordHash, now: new Date().toISOString() },
  );
}

export function findUserByUsername(username: string): UserRow | undefined {
  return db.prepare<{ username: string }, UserRow>("SELECT * FROM users WHERE username = @username").get({ username });
}

export function findUserById(id: string): UserRow | undefined {
  return db.prepare<{ id: string }, UserRow>("SELECT * FROM users WHERE id = @id").get({ id });
}
