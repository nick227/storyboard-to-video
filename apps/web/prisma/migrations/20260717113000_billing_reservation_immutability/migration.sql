CREATE FUNCTION guard_final_credit_reservation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."status" IN ('settled', 'settled_not_charged', 'released', 'failed_not_charged', 'completed_without_cost') THEN
    RAISE EXCEPTION 'final credit reservations are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER credit_reservations_final_immutable BEFORE UPDATE OR DELETE ON "credit_reservations"
FOR EACH ROW EXECUTE FUNCTION guard_final_credit_reservation();
