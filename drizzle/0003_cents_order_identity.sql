-- Keep the original ticket spelling and foreign keys. Refuse ambiguous existing
-- identities rather than merging historical orders or their batch memberships.
CREATE FUNCTION cents_order_identity(code text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN trimmed ~ '^[0-9]+$' THEN coalesce(nullif(ltrim(trimmed, '0'), ''), '0')
              ELSE trimmed END
  FROM (SELECT btrim(code, E' \t\n\r') AS trimmed) AS normalized
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX cents_orders_store_identity_idx
  ON cents_orders (store_id, cents_order_identity(order_number));
