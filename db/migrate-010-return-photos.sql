-- ------------------------------------------------------------------
-- Migration 010 — return condition photos
--
-- Condition photos were captured only at handover (pickup). The client
-- now wants the same five photos taken by the customer again when the
-- car is returned, so the office can compare the two states.
--
-- Add a `stage` column (pickup / return) to booking_photos and widen the
-- uniqueness key so a booking can hold both a pickup and a return set of
-- the same photo type. Existing rows default to 'pickup', so nothing
-- already uploaded is lost.
--
-- The old unique key (booking_id, photo_type) also serves the foreign
-- key on booking_id, so InnoDB will not drop it while it is the only
-- index covering that column. Create the wider unique key FIRST — it has
-- booking_id as its leftmost column too — then drop the old one.
--
-- Safe to re-run: every ALTER is guarded on the column / constraint.
-- ------------------------------------------------------------------

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'booking_photos'
      AND COLUMN_NAME = 'stage') = 0,
  'ALTER TABLE booking_photos
     ADD COLUMN stage ENUM(''pickup'', ''return'') NOT NULL DEFAULT ''pickup''
     COMMENT "which handover this photo records"',
  'SELECT "stage exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'booking_photos'
      AND INDEX_NAME = 'uq_booking_photo_stage') = 0,
  'ALTER TABLE booking_photos
     ADD UNIQUE KEY uq_booking_photo_stage (booking_id, photo_type, stage)',
  'SELECT "uq_booking_photo_stage exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'booking_photos'
      AND INDEX_NAME = 'uq_booking_photo_type') > 0,
  'ALTER TABLE booking_photos DROP INDEX uq_booking_photo_type',
  'SELECT "uq_booking_photo_type already dropped"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
