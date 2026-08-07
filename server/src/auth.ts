import type { Express, NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import { config } from "./config.js";
import { createUser, findUserByUsername, findUserById } from "./db.js";

const SESSION_COOKIE = "session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface AuthedRequest extends Request {
  userId?: string;
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub: string };
    if (!(await findUserById(payload.sub))) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "Not authenticated" });
  }
}

function issueSession(res: Response, userId: string): void {
  const token = jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: SESSION_TTL_SECONDS });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

export function registerAuthRoutes(app: Express): void {
  app.post("/auth/signup", async (req: Request, res: Response) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      res.status(400).json({ error: "username and password are required" });
      return;
    }

    if (await findUserByUsername(username)) {
      res.status(409).json({ error: "Username already taken" });
      return;
    }

    const id = uuid();
    const passwordHash = await bcrypt.hash(password, 10);
    await createUser(id, username, passwordHash);
    issueSession(res, id);
    res.status(201).json({ id, username });
  });

  app.post("/auth/login", async (req: Request, res: Response) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "username and password are required" });
      return;
    }

    const user = await findUserByUsername(username);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    issueSession(res, user.id);
    res.status(200).json({ id: user.id, username: user.username });
  });

  app.post("/auth/logout", (_req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE);
    res.status(204).send();
  });

  app.get("/auth/me", async (req: AuthedRequest, res: Response) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) {
      res.status(200).json({ authenticated: false });
      return;
    }

    try {
      const payload = jwt.verify(token, config.jwtSecret) as { sub: string };
      const user = await findUserById(payload.sub);
      if (!user) {
        res.status(200).json({ authenticated: false });
        return;
      }

      res.status(200).json({ authenticated: true, id: user.id, username: user.username });
    } catch {
      res.status(200).json({ authenticated: false });
    }
  });
}
