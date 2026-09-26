/**
 * Cookie sessions with hashed tokens.
 *
 * The hashed-token idea is adapted from OpenMuse `apps/server/src/auth.ts`
 * (MIT, 205cc386b75aae1a862f3fdd43104b570c8d0911): the browser holds a random token; the store
 * holds only sha256(token) so a database read never yields a usable credential. Airlock changes:
 * two role passwords (operator, judge) instead of one access key, a viewer role without login,
 * an HttpOnly cookie instead of a bearer header, a login rate limiter, and no HMAC-signed links.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Role, Session } from "@airlock/contracts";
import { z } from "zod";
import type { Store } from "./store/index.ts";

export const SESSION_COOKIE = "airlock_session";
const SESSION_KIND = "sessions";
const SESSION_OWNER = "system";

export type SessionRecord = z.infer<typeof Session>;

export interface SessionServiceOptions {
  operatorPassword: string | null;
  judgePassword: string | null;
  ttlMs: number;
  secureCookies: boolean;
  now?: () => number;
  /** Login attempts allowed per client key per window. */
  loginAttemptsPerWindow?: number;
  loginWindowMs?: number;
}

export class LoginRateLimited extends Error {
  constructor() {
    super("Too many login attempts; wait a minute and try again");
    this.name = "LoginRateLimited";
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export class SessionService {
  private readonly attempts = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly db: Store,
    private readonly options: SessionServiceOptions,
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** Role granted for a password, or null. Constant-time per configured password. */
  roleFor(password: string): Exclude<Role, "viewer"> | null {
    let matched: Exclude<Role, "viewer"> | null = null;
    const check = (candidate: string | null, role: Exclude<Role, "viewer">) => {
      if (candidate === null) return;
      const a = digest(password);
      const b = digest(candidate);
      if (timingSafeEqual(a, b) && matched === null) matched = role;
    };
    check(this.options.operatorPassword, "operator");
    check(this.options.judgePassword, "judge");
    return matched;
  }

  /** Creates a session; throws LoginRateLimited or returns null for a wrong password. */
  async login(password: string, clientKey: string): Promise<{ token: string; session: SessionRecord } | null> {
    this.consumeAttempt(clientKey);
    if (password.length === 0 || password.length > 1024) return null;
    const role = this.roleFor(password);
    if (!role) return null;
    const token = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    const session: SessionRecord = {
      id: digest(token).toString("hex"),
      owner: role,
      role,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + this.options.ttlMs).toISOString(),
    };
    await this.db.put(SESSION_OWNER, SESSION_KIND, session);
    this.attempts.delete(clientKey);
    return { token, session };
  }

  async resolve(token: string | null): Promise<SessionRecord | null> {
    if (!token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const session = await this.db.get<SessionRecord>(SESSION_OWNER, SESSION_KIND, digest(token).toString("hex"));
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= this.now()) {
      await this.db.remove(SESSION_OWNER, SESSION_KIND, session.id);
      return null;
    }
    return session;
  }

  async logout(token: string | null): Promise<void> {
    if (!token || token.length > 128) return;
    await this.db.remove(SESSION_OWNER, SESSION_KIND, digest(token).toString("hex"));
  }

  cookieFor(token: string): string {
    const maxAge = Math.floor(this.options.ttlMs / 1000);
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.options.secureCookies ? "; Secure" : ""}`;
  }
  clearCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.options.secureCookies ? "; Secure" : ""}`;
  }

  private consumeAttempt(clientKey: string) {
    const limit = this.options.loginAttemptsPerWindow ?? 10;
    const windowMs = this.options.loginWindowMs ?? 60_000;
    const now = this.now();
    const entry = this.attempts.get(clientKey);
    if (!entry || now - entry.windowStart >= windowMs) {
      this.attempts.set(clientKey, { count: 1, windowStart: now });
      if (this.attempts.size > 10_000) this.attempts.clear();
      return;
    }
    entry.count++;
    if (entry.count > limit) throw new LoginRateLimited();
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header || header.length > 8192) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || null;
  }
  return null;
}
