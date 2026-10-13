-- ------------------------------------------------------------------
-- The booking deposit, separate from the security advance.
--
-- Two different sums were sharing advance_amount:
--
--   booking_deposit  what the customer pays online to reserve the car
--                    (a fixed $100). Comes OFF the rent.
--   advance_amount   the refundable security advance, equal to one
--                    month's rent, paid at pickup and returned at
--                    handback. Comes ON TOP of the rent.
--
-- For a $500/month car: $100 deposit at booking, then $400 remaining
-- plus a $500 advance at pickup — $900 on the day.
--
-- Safe to re-run.
-- ------------------------------------------------------------------

USE reddy_finances;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'bookings'
    AND COLUMN_NAME  = 'booking_deposit'
);

SET @sql := IF(@exists = 0,
  'ALTER TABLE bookings ADD COLUMN booking_deposit DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER advance_amount',
  'SELECT "booking_deposit already exists"');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
