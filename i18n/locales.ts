export const locales = ["en", "es"] as const;
export type Locale = typeof locales[number];
export const localeCookie = "laverie_locale";

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "es";
}
