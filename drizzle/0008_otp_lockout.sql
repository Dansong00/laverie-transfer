CREATE TABLE "otp_failures" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"failed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_traffic" (
	"action" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"attempts" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "otp_failures_phone_time_idx" ON "otp_failures" USING btree ("phone","failed_at");
--> statement-breakpoint
-- Earlier codes only recorded a count. Use the latest time a failure could
-- have occurred so an in-progress lockout is not shortened during rollout.
INSERT INTO otp_failures (phone, failed_at)
SELECT phone, least(expires_at, coalesce(consumed_at, now()), now())
FROM otp_codes
CROSS JOIN LATERAL generate_series(1, least(failed_attempts, 5))
WHERE failed_attempts > 0
  AND least(expires_at, coalesce(consumed_at, now()), now()) > now() - interval '24 hours';
