import { createHash, timingSafeEqual } from "node:crypto";

// Reserved fictional numbers and immutable fixture IDs. Never select a real staff
// identity from a caller-supplied number or from a mutable display name.
export const demoAccounts = [
  { id: "3e941638-cc17-4d12-9363-092a20d6ea01", name: "SoHo Demo", phone: "+12125550101" },
  { id: "3e941638-cc17-4d12-9363-092a20d6ea02", name: "East Village Demo", phone: "+12125550102" },
] as const;

function isDemoDatabase(name: string) {
  return /^laverie_preview_demo(?:_[a-z0-9]+)?$/.test(name);
}

export function configuredDemoDatabase() {
  try {
    const name = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
    return isDemoDatabase(name) ? name : null;
  } catch {
    return null;
  }
}

function previewSecret() {
  const env = process.env.VERCEL_ENV;
  const local = !process.env.VERCEL && process.env.NODE_ENV !== "production" && env === undefined;
  if (env !== "preview" && env !== "development" && !local) return null;
  const secret = process.env.PREVIEW_OTP_ACCESS_CODE?.trim();
  return secret && secret.length <= 1024 && Buffer.byteLength(secret) >= 16 && configuredDemoDatabase() ? secret : null;
}

export function demoEnabled() {
  return previewSecret() !== null;
}

export function acceptsDemoCredential(value: unknown) {
  const secret = previewSecret();
  if (!secret || typeof value !== "string" || value.length > 1024) return false;
  const digest = (input: string) => createHash("sha256").update(input).digest();
  return timingSafeEqual(digest(secret), digest(value));
}
