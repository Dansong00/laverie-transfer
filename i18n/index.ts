import { en } from "./en";
import { es } from "./es";
import type { Locale } from "./locales";

export { isLocale, locales, localeCookie, type Locale } from "./locales";
export type MessageKey = keyof typeof en;

export function t(locale: Locale, key: MessageKey, values?: Readonly<Record<string, string | number>>) {
  const message = (locale === "es" ? es : en)[key];
  if (!values) return message;
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder,
  );
}
