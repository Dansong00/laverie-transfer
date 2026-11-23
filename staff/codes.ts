import { randomInt, randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, gte, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { otpCodes, otpFailures, otpRequests, otpTraffic, sessions, staff } from "../db/schema";
import { getStaffLocale } from "./preferences";
import { sessionToken } from "./session";
import { normalizePhone, setting } from "./settings";
import { matches, sign } from "./signature";
import { sendCode } from "./sms";

type CodeRequest =
  | { kind: "invalid" }
  | { kind: "limited"; retrySeconds: number }
  | { kind: "accepted"; deliver?: () => Promise<void> };

const lockPhone = (phone: string) => sql`select pg_advisory_xact_lock(hashtextextended(${"otp:" + phone}, 0))`;
const activePhone = (phone: string) => and(eq(staff.phone, phone), eq(staff.active, true), isNull(staff.disabledAt));

const phoneFailureLimit = 10;
const failureWindowMs = 24 * 60 * 60 * 1000;
const trafficLimits = { request: 300, verify: 600 } as const;
type AuthTransaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

// One row per action across all app instances. Commit this reservation before
// taking a phone lock so unrelated phones can finish their work concurrently.
async function reserveTraffic(action: keyof typeof trafficLimits) {
  const now = sql`statement_timestamp()`;
  const expired = sql`${otpTraffic.windowStart} <= ${now} - interval '1 minute'`;
  const rows = await getDb().insert(otpTraffic).values({ action, windowStart: now, attempts: 1 })
    .onConflictDoUpdate({
      target: otpTraffic.action,
      set: {
        windowStart: sql`case when ${expired} then ${now} else ${otpTraffic.windowStart} end`,
        attempts: sql`case when ${expired} then 1 else ${otpTraffic.attempts} + 1 end`,
      },
      setWhere: sql`${expired} or ${otpTraffic.attempts} < ${trafficLimits[action]}`,
    }).returning({ action: otpTraffic.action });
  return rows.length > 0;
}

async function recentFailures(tx: AuthTransaction, phone: string, now: Date) {
  const [row] = await tx.select({ total: count() }).from(otpFailures)
    .where(and(eq(otpFailures.phone, phone), gt(otpFailures.failedAt, new Date(+now - failureWindowMs))));
  return row.total;
}

export async function requestSignInCode(input: unknown): Promise<CodeRequest> {
  const phone = normalizePhone(input);
  if (!phone) return { kind: "invalid" };
  if (!await reserveTraffic("request")) return { kind: "limited", retrySeconds: 60 };
  return getDb().transaction(async tx => {
    await tx.execute(lockPhone(phone));
    const now = new Date();
    const hour = 3600000;
    const requests = await tx.select({ at: otpRequests.requestedAt }).from(otpRequests)
      .where(and(eq(otpRequests.phone, phone), gte(otpRequests.requestedAt, new Date(+now - hour))))
      .orderBy(desc(otpRequests.requestedAt));
    const limit = Math.min(5, setting("OTP_MAX_REQUESTS_PER_HOUR", 5));
    const cooldown = Math.max(30, setting("OTP_RESEND_SECONDS", 30)) * 1000;
    const nextSend = Math.max(
      requests.length ? +requests[0].at + cooldown : 0,
      requests.length >= limit ? +requests[limit - 1].at + hour : 0,
    );
    if (nextSend > +now) return { kind: "limited", retrySeconds: Math.ceil((nextSend - +now) / 1000) };
    await tx.insert(otpRequests).values({ phone, requestedAt: now });
    const [person] = await tx.select({ id: staff.id }).from(staff).where(activePhone(phone)).for("share");
    if (!person || await recentFailures(tx, phone, now) >= phoneFailureLimit) return { kind: "accepted" };

    const id = randomUUID();
    const code = randomInt(1000000).toString().padStart(6, "0");
    const ttl = Math.min(10, setting("OTP_TTL_MINUTES", 10)) * 60000;
    await tx.update(otpCodes).set({ consumedAt: now }).where(and(eq(otpCodes.phone, phone), isNull(otpCodes.consumedAt)));
    await tx.insert(otpCodes).values({
      id, phone, codeHash: sign(`otp:${id}:${code}`), createdAt: now, expiresAt: new Date(+now + ttl),
    });
    return { kind: "accepted", deliver: async () => {
      try {
        await sendCode(phone, code);
      } catch {
        console.error("Sign-in SMS delivery failed");
        await getDb().update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, id));
      }
    } };
  });
}

export async function verifySignInCode(input: unknown, code: unknown) {
  const phone = normalizePhone(input);
  if (!phone || typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  if (!await reserveTraffic("verify")) return null;
  const result = await getDb().transaction(async tx => {
    await tx.execute(lockPhone(phone));
    const now = new Date();
    const [person] = await tx.select({ id: staff.id }).from(staff).where(activePhone(phone)).for("share");
    if (!person) return null;
    const failures = await recentFailures(tx, phone, now);
    if (failures >= phoneFailureLimit) return null;
    const [otp] = await tx.select().from(otpCodes)
      .where(and(eq(otpCodes.phone, phone), isNull(otpCodes.consumedAt)))
      .orderBy(desc(otpCodes.createdAt)).limit(1);
    if (!otp || otp.expiresAt <= now || otp.failedAttempts >= Math.min(5, setting("OTP_MAX_ATTEMPTS", 5))) return null;
    if (!matches(otp.codeHash, sign(`otp:${otp.id}:${code}`))) {
      await tx.update(otpCodes).set({ failedAttempts: otp.failedAttempts + 1 }).where(eq(otpCodes.id, otp.id));
      await tx.delete(otpFailures).where(and(
        eq(otpFailures.phone, phone), lte(otpFailures.failedAt, new Date(+now - failureWindowMs)),
      ));
      await tx.insert(otpFailures).values({ phone, failedAt: now });
      return failures + 1 === phoneFailureLimit ? "locked" as const : null;
    }
    const expiresAt = new Date(+now + Math.min(30, setting("SESSION_MAX_DAYS", 30)) * 86400000);
    await tx.update(otpCodes).set({ consumedAt: now }).where(eq(otpCodes.id, otp.id));
    const [session] = await tx.insert(sessions)
      .values({ staffId: person.id, createdAt: now, lastUsedAt: now, expiresAt }).returning({ id: sessions.id });
    return { token: sessionToken(session.id), expiresAt, locale: await getStaffLocale(person.id, tx) };
  });
  if (result === "locked") {
    console.warn("staff_otp_phone_locked");
    return null;
  }
  return result;
}
