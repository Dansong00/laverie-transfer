import { createHmac, timingSafeEqual } from "node:crypto";

export function sign(value: string) {
  const key = process.env.SESSION_SECRET;
  if (!key || Buffer.byteLength(key) < 32) throw new Error("Configure a session secret of at least 32 bytes");
  return createHmac("sha256", key).update(value).digest("hex");
}

export function matches(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
