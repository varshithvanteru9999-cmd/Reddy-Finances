-- ------------------------------------------------------------------
-- bookings.confirmation_sent
--
-- This column was added to the development database by hand and never
-- captured in a migration, so a fresh database did not have it and
-- migrate-005 failed building a view that reads it.
--
-- Numbered 000 so it runs before the migrations that depend on it.
-- Safe to re-run.
-- ------------------------------------------------------------------

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'confirmation_sent') = 0,
  'ALTER TABLE bookings
     ADD COLUMN confirmation_sent TINYINT(1) NOT NULL DEFAULT 0
     COMMENT "admin has sent the under-confirmation message"
     AFTER license_uploaded_at',
  'SELECT "confirmation_sent exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
