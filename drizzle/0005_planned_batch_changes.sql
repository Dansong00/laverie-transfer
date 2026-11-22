ALTER TABLE "batch_orders" ADD COLUMN "removal_note" text;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "cancelled_at" timestamp with time zone;
--> statement-breakpoint
-- A send handoff must refer to a retained order that can travel with this batch.
CREATE FUNCTION check_send_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM batches
    WHERE id = NEW.batch_id AND cancelled_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT FROM batch_orders WHERE batch_id = NEW.batch_id AND store_id = NEW.store_id
      AND order_number = NEW.order_number AND active AND removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot send an order outside an active batch membership'
      USING ERRCODE = '23514', CONSTRAINT = 'handoffs_send_requires_membership';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER handoffs_send_requires_membership BEFORE INSERT ON handoffs
  FOR EACH ROW WHEN (NEW.action = 'send') EXECUTE FUNCTION check_send_membership();
