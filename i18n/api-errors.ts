import { batchErrors } from "./batch-errors";
import { directoryErrors } from "./directory-errors";
import { formatMessage } from "./format-message";
import type { Locale } from "./locales";

const errors = { ...batchErrors, ...directoryErrors };

type ApiError = {
  error: string;
  message?: string;
  values?: Readonly<Record<string, string | number>>;
};

export function translateApiError(locale: Locale, failure: ApiError) {
  if (Object.hasOwn(errors, failure.error)) {
    const template = errors[failure.error as keyof typeof errors][locale];
    return formatMessage(template, failure.values);
  }
  // Older deployments sent only the English text in error.
  return failure.message ?? failure.error;
}
