-- Cents-side filter for eligible-order reads and batch membership writes.
CREATE FUNCTION cents_status_allows_transfer(order_status text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT order_status NOT IN ('COMPLETED', 'CANCELLED')
$$;
--> statement-breakpoint
-- A webhook may complete an order during any transfer phase. Validate additions
-- and reassignments, while allowing existing memberships to finish their trip.
CREATE FUNCTION batch_orders_check_cents_status() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.batch_id, NEW.store_id, NEW.order_number) IS NOT DISTINCT FROM
       (OLD.batch_id, OLD.store_id, OLD.order_number)
       AND NOT (NEW.active AND NOT OLD.active)
       AND NOT (NEW.removed_at IS NULL AND OLD.removed_at IS NOT NULL) THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT status INTO order_status FROM cents_orders
    WHERE store_id = NEW.store_id AND order_number = NEW.order_number FOR SHARE;
  IF NOT cents_status_allows_transfer(order_status) THEN
    RAISE EXCEPTION 'Cannot add a terminal Cents order to a batch'
      USING ERRCODE = '23514', CONSTRAINT = 'batch_orders_nonterminal_order';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER batch_orders_nonterminal_order
  BEFORE INSERT OR UPDATE OF batch_id, store_id, order_number, active, removed_at ON batch_orders
  FOR EACH ROW EXECUTE FUNCTION batch_orders_check_cents_status();
