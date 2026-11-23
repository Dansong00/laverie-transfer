import { cookies } from "next/headers";
import { cache } from "react";
import { isLocale, localeCookie, type Locale } from "../i18n";
import { getStaffLocale } from "./preferences";
import { getProfile, sessionCookie } from "./session";

export const requestProfile = cache(async () =>
  getProfile((await cookies()).get(sessionCookie)?.value),
);

export const requestLocale = cache(async (): Promise<Locale> => {
  const actor = await requestProfile();
  if (!actor) return "en";
  const saved = (await cookies()).get(localeCookie)?.value;
  return isLocale(saved) ? saved : getStaffLocale(actor.staffId);
});
