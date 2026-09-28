-- ------------------------------------------------------------------
-- Migration 008 — advance payment, and the one-month minimum term
--
-- advance_amount: the deposit the office collects up front. It defaults
-- to one month's rent, but the admin can override it per booking, so it
-- is stored rather than derived.
--
-- open_return: rentals are monthly by default. A customer who ticks
-- "open return" is booking a short, day-rated stay instead, and the flag
-- records which of the two they chose.
-- ------------------------------------------------------------------

SET @s := (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'advance_amount') = 0,
  'ALTER TABLE bookings ADD COLUMN advance_amount DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER toll_notes',
  'SELECT "advance_amount exists"'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s := (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'open_return') = 0,
  'ALTER TABLE bookings ADD COLUMN open_return TINYINT(1) NOT NULL DEFAULT 0 AFTER advance_amount',
  'SELECT "open_return exists"'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
