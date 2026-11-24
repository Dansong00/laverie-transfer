ALTER TABLE "otp_codes" ALTER COLUMN "code_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "otp_codes" ADD COLUMN "verification_sid" text;