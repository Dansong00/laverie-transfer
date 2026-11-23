import { NextRequest } from "next/server";
import { expect, test, vi } from "vitest";
import { GET, POST } from "../app/api/staff/route";
import * as directory from "../staff/directory";

const url = "http://localhost/api/staff";

test.each([
  ["cross-site", "application/json", "{}", 403, "DIRECTORY_SAME_ORIGIN_REQUIRED", "Same-origin request required."],
  ["same-origin", "text/plain", "{}", 415, "DIRECTORY_JSON_REQUIRED", "Send a JSON staff change."],
  ["same-origin", "application/json", "{", 400, "DIRECTORY_INVALID_JSON", "Invalid JSON."],
  ["same-origin", "application/json", "{}", 401, "DIRECTORY_SIGN_IN_REQUIRED", "Sign in required."],
] as const)("POST returns %s %s %s as %i %s", async (site, contentType, body, status, error, message) => {
  const response = await POST(new NextRequest(url, {
    method: "POST",
    headers: { "sec-fetch-site": site, "content-type": contentType },
    body,
  }));
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ error, message });
});

test("unexpected directory errors return a generic code and English fallback", async () => {
  const list = vi.spyOn(directory, "listStaff").mockRejectedValueOnce(new Error("internal detail"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await GET(new NextRequest(url));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "DIRECTORY_UNAVAILABLE", message: "The directory is unavailable." });
  } finally {
    list.mockRestore();
    log.mockRestore();
  }
});
