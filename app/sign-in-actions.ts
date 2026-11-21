"use server";

import { cookies } from "next/headers";
import { after } from "next/server";
import { requestSignInCode, verifySignInCode } from "../staff/codes";
import { revokeSession, sessionCookie } from "../staff/session";
import { setting } from "../staff/settings";

export async function requestCode(phone: string) {
  try {
    const result = await requestSignInCode(phone);
    if (result.kind === "accepted" && result.deliver) after(result.deliver);
    if (result.kind === "invalid") return { error: "Enter a valid mobile number." } as const;
    const retrySeconds = result.kind === "limited" ? result.retrySeconds : Math.max(30, setting("OTP_RESEND_SECONDS", 30));
    return { retrySeconds, limited: result.kind === "limited" } as const;
  } catch {
    return { error: "Sign-in is unavailable. Try again shortly." } as const;
  }
}

export async function verifyCode(phone: string, code: string) {
  try {
    const result = await verifySignInCode(phone, code);
    if (!result) return "That code is invalid or expired. Check the code or request another.";
    (await cookies()).set(sessionCookie, result.token, {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", expires: result.expiresAt,
    });
    return null;
  } catch {
    return "Sign-in is unavailable. Try again shortly.";
  }
}

export async function signOut() {
  const jar = await cookies();
  await revokeSession(jar.get(sessionCookie)?.value);
  jar.delete(sessionCookie);
}
