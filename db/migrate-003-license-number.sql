-- ==================================================================
-- Migration 003 — customer driver license number
--
--   mysql -u root -p < db/migrate-003-license-number.sql
--
-- Rentals now ask the customer for their driver license number at
-- booking time (mandatory), so it has to be stored somewhere. It lives
-- on the customer, not the booking — it belongs to the person, and an
-- edit of the booking must not lose it.
--
-- Safe to re-run: every statement is guarded.
-- ==================================================================

USE reddy_finances;

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'reddy_finances' AND TABLE_NAME = 'customers'
      AND COLUMN_NAME = 'license_number') = 0,
  'ALTER TABLE customers ADD COLUMN license_number VARCHAR(40) NULL AFTER phone',
  'SELECT "license_number exists"'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;