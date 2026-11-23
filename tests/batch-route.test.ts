import { NextRequest } from "next/server";
import { expect, test, vi } from "vitest";
import { POST } from "../app/api/batches/route";
import * as planned from "../transfer/planned";

function request(body = "{}", contentType = "application/json", site = "same-origin") {
  return new NextRequest("http://localhost/api/batches", {
    method: "POST",
    headers: { "content-type": contentType, "sec-fetch-site": site },
    body,
  });
}

test.each([
  [403, "BATCH_SAME_ORIGIN_REQUIRED", "Same-origin request required.", "{}", "application/json", "cross-site"],
  [415, "BATCH_JSON_REQUIRED", "Send a JSON batch change.", "{}", "text/plain", "same-origin"],
  [400, "BATCH_INVALID_JSON", "Invalid JSON.", "{", "application/json", "same-origin"],
  [401, "BATCH_SIGN_IN_REQUIRED", "Sign in required.", "{}", "application/json", "same-origin"],
] as const)("batch API returns %i with %s", async (status, error, message, body, contentType, site) => {
  const response = await POST(request(body, contentType, site));
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ error, message });
});

test("unexpected batch failures return the availability error", async () => {
  const save = vi.spyOn(planned, "saveBatch").mockRejectedValueOnce(new Error("internal detail"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "BATCH_UNAVAILABLE", message: "Batch planning is unavailable." });
  } finally {
    save.mockRestore();
    log.mockRestore();
  }
});
