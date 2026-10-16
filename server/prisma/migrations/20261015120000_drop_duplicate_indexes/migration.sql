BEGIN;
DROP INDEX IF EXISTS "sleep_records_side_entered_bed_at_idx";
DROP INDEX IF EXISTS "vitals_side_timestamp_idx";
DROP INDEX IF EXISTS "movement_side_timestamp_idx";
COMMIT;
