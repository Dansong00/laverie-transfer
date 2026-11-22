CREATE FUNCTION cents_open_transfer_statuses() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['SUBMITTED', 'IN_PROGRESS', 'READY_FOR_PICKUP']::text[]
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION cents_status_allows_transfer(order_status text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT upper(btrim(order_status)) = ANY (cents_open_transfer_statuses())
$$;
