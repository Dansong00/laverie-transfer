"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { localeCookie } from "../i18n";
import { updateStaffLocale } from "../staff/preferences";
import { BatchError } from "../transfer/commands";
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
    const jar = await cookies();
    const options = { httpOnly: true, secure: true, sameSite: "lax", path: "/", expires: result.expiresAt } as const;
    jar.set(sessionCookie, result.token, options);
    jar.set(localeCookie, result.locale, options);
    return null;
  } catch {
    return "Sign-in is unavailable. Try again shortly.";
  }
}

export async function signOut() {
  const jar = await cookies();
  await revokeSession(jar.get(sessionCookie)?.value);
  jar.delete(sessionCookie);
  jar.delete(localeCookie);
}

export async function saveLanguage(form: FormData) {
  const jar = await cookies();
  try {
    const locale = await updateStaffLocale(jar.get(sessionCookie)?.value, form.get("locale"));
    jar.set(localeCookie, locale, { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
  } catch (error) {
    if (error instanceof BatchError && error.status === 401) redirect("/");
    throw error;
  }
}
