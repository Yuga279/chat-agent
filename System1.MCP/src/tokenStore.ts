import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

interface LinkedAccountRow {
  externalUserId: string;
  encryptedRefreshToken: string;
  system1UserId: string | null;
  linkedAt: string;
  updatedAt: string;
}

const encryptionKey = Buffer.from(config.tokenStoreEncryptionKey, "base64");
if (encryptionKey.length !== 32) {
  throw new Error("SYSTEM1_TOKEN_STORE_KEY must decode to exactly 32 bytes (base64-encoded).");
}

fs.mkdirSync(path.dirname(config.tokenStorePath), { recursive: true });
const db = new Database(config.tokenStorePath);

db.exec(`
  CREATE TABLE IF NOT EXISTS linked_accounts (
    externalUserId TEXT PRIMARY KEY,
    encryptedRefreshToken TEXT NOT NULL,
    system1UserId TEXT,
    linkedAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`);

function encrypt(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

function decrypt(payload: string): string {
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function saveRefreshToken(externalUserId: string, refreshToken: string, system1UserId?: string): void {
  const now = new Date().toISOString();
  const encryptedRefreshToken = encrypt(refreshToken);

  db.prepare(
    `INSERT INTO linked_accounts (externalUserId, encryptedRefreshToken, system1UserId, linkedAt, updatedAt)
     VALUES (@externalUserId, @encryptedRefreshToken, @system1UserId, @now, @now)
     ON CONFLICT(externalUserId) DO UPDATE SET
       encryptedRefreshToken = @encryptedRefreshToken,
       system1UserId = COALESCE(@system1UserId, linked_accounts.system1UserId),
       updatedAt = @now`,
  ).run({ externalUserId, encryptedRefreshToken, system1UserId: system1UserId ?? null, now });
}

export function getRefreshToken(externalUserId: string): string | undefined {
  const row = db
    .prepare<{ externalUserId: string }, LinkedAccountRow>(
      "SELECT * FROM linked_accounts WHERE externalUserId = @externalUserId",
    )
    .get({ externalUserId });

  return row ? decrypt(row.encryptedRefreshToken) : undefined;
}

export function isLinked(externalUserId: string): boolean {
  return getRefreshToken(externalUserId) !== undefined;
}

export function unlink(externalUserId: string): void {
  db.prepare("DELETE FROM linked_accounts WHERE externalUserId = @externalUserId").run({ externalUserId });
}
