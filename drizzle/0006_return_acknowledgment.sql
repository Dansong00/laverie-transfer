ALTER TABLE "batches" ADD COLUMN "return_acknowledged_at" timestamp with time zone;--> statement-breakpoint
UPDATE batches AS b
SET return_acknowledged_at = ack.at
FROM (
  SELECT batch_id, max(at) AS at FROM handoffs
  WHERE action = 'acknowledgeReturn' AND to_phase = 'returned'
  GROUP BY batch_id
) AS ack
WHERE b.id = ack.batch_id;
--> statement-breakpoint
CREATE INDEX "batches_return_acknowledged_at_idx" ON "batches" USING btree ("return_acknowledged_at");