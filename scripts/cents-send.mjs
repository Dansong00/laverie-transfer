import { readFile } from "node:fs/promises";

const [, , fixture] = process.argv;
const header = process.env.CENTS_WEBHOOK_HEADER_NAME;
const secret = process.env.CENTS_WEBHOOK_HEADER_SECRET;
if (!fixture || !header || !secret) {
  throw new Error("Provide a fixture path and configure both Cents webhook header variables.");
}
const url = new URL("/api/cents/webhook", "http://127.0.0.1:3000");
url.port = process.env.PORT || "3000";
const response = await fetch(url, {
  method: "POST",
  redirect: "error",
  headers: { "content-type": "application/json", [header]: secret },
  body: await readFile(fixture, "utf8"),
});
console.log(response.status);
if (!response.ok) process.exitCode = 1;
