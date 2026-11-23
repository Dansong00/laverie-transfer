import { expect, test } from "vitest";
import { batchErrors } from "../i18n/batch-errors";
import { translateApiError } from "../i18n/api-errors";
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

test("API codes use the requested language and keep order identifiers literal", () => {
  const orders = "SO-{orders}-$&";
  expect(translateApiError("es", { error: "BATCH_ORDERS_INELIGIBLE", values: { orders } }))
    .toBe("Estos pedidos ya no son elegibles: " + orders);
  for (const { en, es } of Object.values(batchErrors)) {
    expect(es.match(/\{\w+\}/g)?.sort()).toEqual(en.match(/\{\w+\}/g)?.sort());
  }
});

test("unknown API codes and historical failures keep the server's English explanation", () => {
  expect(translateApiError("es", { error: "NEW_CODE", message: "Try again tomorrow." }))
    .toBe("Try again tomorrow.");
  expect(translateApiError("es", { error: "That number is already registered." }))
    .toBe("That number is already registered.");
});
