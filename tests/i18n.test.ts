import { expect, test } from "vitest";
import { en } from "../i18n/en";
import { es } from "../i18n/es";
import { t } from "../i18n";

test("English and Spanish messages preserve the same substitution fields", () => {
  const fields = (message: string) => (message.match(/\{\w+\}/g) ?? []).sort();
  const english: Readonly<Record<string, string>> = en;
  for (const [key, message] of Object.entries(es)) {
    expect(fields(message), key).toEqual(fields(english[key]));
  }
});

test("substitutions preserve staff-entered text verbatim", () => {
  const name = "Sam {name} $&";
  expect(t("es", "staffConfirmDisable", { name })).toBe(
    "¿Deshabilitar la cuenta de Sam {name} $& y cerrar su sesión en todos los dispositivos?",
  );
});
