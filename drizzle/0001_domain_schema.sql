CREATE TABLE "batch_counters" (
	"origin" text PRIMARY KEY NOT NULL,
	"last_number" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" text NOT NULL,
	"origin_store_id" text NOT NULL,
	"store_id" text NOT NULL,
	"order_number" text NOT NULL,
	"phase" text NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	"added_by_op" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_op" uuid,
	"active" boolean NOT NULL,
	CONSTRAINT "batch_orders_origin_matches_store" CHECK ("batch_orders"."origin_store_id" = "batch_orders"."store_id")
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" text PRIMARY KEY NOT NULL,
	"origin" text NOT NULL,
	"destination" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"contents_changed" boolean DEFAULT false NOT NULL,
	"contents_confirmed_at" timestamp with time zone,
	"contents_confirmed_by" uuid,
	"contents_confirmed_order_keys" jsonb,
	CONSTRAINT "batches_id_origin" UNIQUE("id","origin")
);
--> statement-breakpoint
CREATE TABLE "cents_orders" (
	"store_id" text NOT NULL,
	"order_number" text NOT NULL,
	"cents_order_id" text,
	"status" text NOT NULL,
	"due_at" timestamp with time zone,
	"is_personal_detergent" boolean,
	"customer_first_name" text,
	"customer_last_initial" text,
	"source" text NOT NULL,
	"source_updated_at" timestamp with time zone,
	"last_event_id" bigint,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cents_orders_store_id_order_number_pk" PRIMARY KEY("store_id","order_number")
);
--> statement-breakpoint
CREATE TABLE "cents_raw_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"store_hint" text,
	"fingerprint" text NOT NULL,
	"body" jsonb NOT NULL,
	"duplicate_of" bigint,
	"needs_review" boolean DEFAULT false NOT NULL,
	"review_reason" text
);
--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"batch_id" text NOT NULL,
	"store_id" text NOT NULL,
	"order_number" text NOT NULL,
	"action" text NOT NULL,
	"from_phase" text NOT NULL,
	"to_phase" text NOT NULL,
	"staff_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"corrects" uuid
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"staff_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"batch_id" text,
	"request_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"failed_attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "staff_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "staff_preferences" (
	"staff_id" uuid PRIMARY KEY NOT NULL,
	"board_sections" text[] DEFAULT ARRAY['planned','arriving','received','processing','ready_for_return','returning','recently_returned']::text[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "batch_orders" ADD CONSTRAINT "batch_orders_added_by_op_operations_operation_id_fk" FOREIGN KEY ("added_by_op") REFERENCES "public"."operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_orders" ADD CONSTRAINT "batch_orders_removed_by_op_operations_operation_id_fk" FOREIGN KEY ("removed_by_op") REFERENCES "public"."operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_orders" ADD CONSTRAINT "batch_orders_order_fkey" FOREIGN KEY ("store_id","order_number") REFERENCES "public"."cents_orders"("store_id","order_number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_orders" ADD CONSTRAINT "batch_orders_batch_origin_fkey" FOREIGN KEY ("batch_id","origin_store_id") REFERENCES "public"."batches"("id","origin") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_contents_confirmed_by_staff_id_fk" FOREIGN KEY ("contents_confirmed_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cents_orders" ADD CONSTRAINT "cents_orders_last_event_id_cents_raw_events_id_fk" FOREIGN KEY ("last_event_id") REFERENCES "public"."cents_raw_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cents_raw_events" ADD CONSTRAINT "cents_raw_events_duplicate_of_fkey" FOREIGN KEY ("duplicate_of") REFERENCES "public"."cents_raw_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_operation_id_operations_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_corrects_fkey" FOREIGN KEY ("corrects") REFERENCES "public"."handoffs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_preferences" ADD CONSTRAINT "staff_preferences_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "batch_orders_one_active_assignment" ON "batch_orders" USING btree ("store_id","order_number") WHERE active;--> statement-breakpoint
CREATE UNIQUE INDEX "batch_orders_one_retained_membership" ON "batch_orders" USING btree ("store_id","order_number") WHERE removed_at is null;--> statement-breakpoint
CREATE INDEX "cents_raw_events_fingerprint_idx" ON "cents_raw_events" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "cents_raw_events_received_at_idx" ON "cents_raw_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "otp_requests_phone_requested_at_idx" ON "otp_requests" USING btree ("phone","requested_at");--> statement-breakpoint
CREATE FUNCTION cents_orders_store_id_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.store_id IS DISTINCT FROM OLD.store_id THEN
    RAISE EXCEPTION 'cents_orders.store_id is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER cents_orders_store_id_immutable
  BEFORE UPDATE OF store_id ON cents_orders
  FOR EACH ROW
  EXECUTE FUNCTION cents_orders_store_id_immutable();