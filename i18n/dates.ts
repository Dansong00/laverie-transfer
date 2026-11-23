import type { Locale } from "./locales";

function dateFormats(language: string) {
  const options = { timeZone: "America/New_York", dateStyle: "medium" } as const;
  return {
    short: new Intl.DateTimeFormat(language, { ...options, timeStyle: "short" }),
    medium: new Intl.DateTimeFormat(language, { ...options, timeStyle: "medium" }),
  };
}

const formats = { en: dateFormats("en-US"), es: dateFormats("es-US") };

export function formatLocalDate(locale: Locale, date: Date, timeStyle: "short" | "medium" = "short") {
  return formats[locale][timeStyle].format(date);
}
