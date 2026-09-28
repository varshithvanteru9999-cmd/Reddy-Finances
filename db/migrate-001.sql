-- ==================================================================
-- Migration 001 — pre-booking, pro-rata monthly billing, tolls, odometer
--
--   mysql -u root -p < db/migrate-001.sql
--
-- Safe to re-run: every statement is guarded.
-- ==================================================================

USE reddy_finances;

-- ------------------------------------------------------------------
-- vehicles: monthly rate + odometer
-- monthly_rate is what the admin fixes for a full month. Part-months
-- bill at monthly_rate / 30 per day — always 30, even in a 31-day
-- month, so the daily figure never moves through the year.
-- ------------------------------------------------------------------
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'reddy_finances' AND TABLE_NAME = 'vehicles'
      AND COLUMN_NAME = 'monthly_rate') = 0,
  'ALTER TABLE vehicles ADD COLUMN monthly_rate DECIMAL(10,2) NULL AFTER price',
  'SELECT "monthly_rate exists"'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'reddy_finances' AND TABLE_NAME = 'vehicles'
      AND COLUMN_NAME = 'odometer_miles') = 0,
  'ALTER TABLE vehicles ADD COLUMN odometer_miles INT UNSIGNED NULL AFTER mileage',
  'SELECT "odometer_miles exists"'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'reddy_finances' AND TABLE_NAME = 'vehicles'
      AND COLUMN_NAME = 'odometer_updated') = 0,
  'ALTER TABLE vehicles ADD COLUMN odometer_updated DATE NULL AFTER odometer_miles',
  'SELECT "odometer_updated exists"'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Seed a monthly rate for rentals that lack one: 26 days at the day
-- rate, the usual monthly discount. The admin can edit each afterwards.
UPDATE vehicles
   SET monthly_rate = ROUND(price * 26, 2)
 WHERE listing_type = 'rental' AND monthly_rate IS NULL;

-- ------------------------------------------------------------------
-- bookings: pre-booking, tolls, and the billing breakdown
-- ------------------------------------------------------------------
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'reddy_finances' AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'toll_charges') = 0,
  'ALTER TABLE bookings ADD COLUMN toll_charges DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER total',
  'SELECT "toll_charges exists"'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'reddy_finances' AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'toll_notes') = 0,
  'ALTER TABLE bookings ADD COLUMN toll_notes VARCHAR(300) NULL AFTER toll_charges',
  'SELECT "toll_notes exists"'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 'Prebooked' is a state before 'Confirmed': the customer gave notice,
-- the admin has not yet released the car.
SET @sql = (SELECT IF(
  (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'reddy_finances' AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'status') NOT LIKE '%Prebooked%',
  "ALTER TABLE bookings MODIFY COLUMN status
     ENUM('Prebooked','Confirmed','Active','Completed','Cancelled')
     NOT NULL DEFAULT 'Prebooked'",
  'SELECT "Prebooked exists"'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- how the total was arrived at, kept for the invoice
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'reddy_finances' AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'billing_breakdown') = 0,
  'ALTER TABLE bookings ADD COLUMN billing_breakdown JSON NULL AFTER toll_notes',
  'SELECT "billing_breakdown exists"'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'reddy_finances' AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'monthly_rate') = 0,
  'ALTER TABLE bookings ADD COLUMN monthly_rate DECIMAL(10,2) NULL AFTER day_rate',
  'SELECT "booking monthly_rate exists"'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'reddy_finances' AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'released_at') = 0,
  'ALTER TABLE bookings ADD COLUMN released_at DATETIME NULL AFTER billing_breakdown',
  'SELECT "released_at exists"'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ------------------------------------------------------------------
-- Refreshed view: grand total now folds in tolls.
-- ------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_booking_rows AS
SELECT
  b.reference,
  c.full_name,
  c.email,
  c.phone,
  CONCAT(v.model_year, ' ', v.name)              AS vehicle,
  v.listing_type,
  b.starts_on,
  b.ends_on,
  GREATEST(DATEDIFF(b.ends_on, b.starts_on), 1)  AS days,
  b.total                                        AS rental_total,
  b.toll_charges,
  (COALESCE(b.total, 0) + b.toll_charges)        AS grand_total,
  b.status,
  DATEDIFF(b.starts_on, CURDATE())               AS days_until_pickup,
  b.created_at
FROM bookings b
JOIN customers c ON c.id = b.customer_id
JOIN vehicles  v ON v.id = b.vehicle_id;

-- ------------------------------------------------------------------
-- Cars with a pre-booking not yet released — the admin's queue.
-- ------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_upcoming_releases AS
SELECT
  b.reference,
  c.full_name,
  v.slug                                         AS vehicle_slug,
  CONCAT(v.model_year, ' ', v.name)              AS vehicle,
  b.starts_on,
  b.ends_on,
  DATEDIFF(b.starts_on, CURDATE())               AS days_until_pickup,
  b.status
FROM bookings b
JOIN customers c ON c.id = b.customer_id
JOIN vehicles  v ON v.id = b.vehicle_id
WHERE b.status = 'Prebooked'
ORDER BY b.starts_on;
