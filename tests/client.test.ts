import { expect, test } from "vitest";
import { createPool } from "../db/client";

test("bounds connection and query waits", async () => {
  const pool = createPool("postgresql://laverie:laverie@127.0.0.1:5432/laverie");
  try {
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    expect(pool.options.query_timeout).toBe(5_000);
  } finally {
    await pool.end();
  }
});

test("an idle client error stays inside the pool", async () => {
  const pool = createPool("postgresql://laverie:laverie@127.0.0.1:5432/laverie");
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    expect(() => {
      pool.emit(
        "error",
        Object.assign(new Error("connection ended"), { code: "ECONNRESET" }),
      );
    }).not.toThrow();
    expect(logged).toEqual([["idle postgres client error", "ECONNRESET"]]);
  } finally {
    console.error = original;
    await pool.end();
  }
});
