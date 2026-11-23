import { afterEach, expect, test, vi } from "vitest";
import { signInClientIp } from "../staff/client-ip";

afterEach(() => vi.unstubAllEnvs());

test("Vercel uses the normalized edge address", () => {
  vi.stubEnv("VERCEL", "1");
  const headers = new Headers({ "x-vercel-forwarded-for": "2001:0db8:0:0::1", "x-forwarded-for": "192.0.2.1" });
  expect(signInClientIp(headers)).toBe("2001:db8::1");
  headers.set("x-vercel-forwarded-for", "198.51.100.1");
  expect(signInClientIp(headers)).toBe("198.51.100.1");
  headers.delete("x-vercel-forwarded-for");
  expect(() => signInClientIp(headers)).toThrow("Missing Vercel client address");
});

test("local development ignores forwarding headers", () => {
  vi.stubEnv("VERCEL", "");
  expect(signInClientIp(new Headers({ "x-vercel-forwarded-for": "192.0.2.1" }))).toBe("127.0.0.1");
});
