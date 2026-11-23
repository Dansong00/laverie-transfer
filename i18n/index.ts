import { en } from "./en";
import { es } from "./es";

export const locales = ["en", "es"] as const;
export type Locale = typeof locales[number];
export const localeCookie = "laverie_locale";

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "es";
}

export function t(locale: Locale, key: keyof typeof en) {
  return (locale === "es" ? es : en)[key];
}
