export function setting(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid sign-in settings");
  return value;
}

export function normalizePhone(input: unknown) {
  if (typeof input !== "string" || input.length > 40) return null;
  const digits = input.trim().replace(/[ ().-]/g, "");
  if (/^\+[1-9]\d{1,14}$/.test(digits)) return digits;
  if (/^1?\d{10}$/.test(digits)) return "+1" + digits.slice(-10);
  return null;
}
