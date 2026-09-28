-- ------------------------------------------------------------------
-- Return notice and pre-booking release.
--
-- The flow the client asked for:
--   1. A car is out on rent            -> shows BOOKED, cannot be booked
--   2. The renter gives 10 days notice -> return_notice_given_at is set
--   3. The admin releases the car      -> released_for_prebooking_at is set
--   4. Other customers may now pre-book -> they queue as 'Prebooked'
--   5. The admin sends an under-confirmation message on one of them,
--      which moves it into the Bookings tab as a real reservation.
--
-- Safe to re-run: every ALTER is guarded on the column not existing.
-- ------------------------------------------------------------------

USE reddy_finances;

-- ---------------------------------------------------------------- --
-- bookings: when the renter announced their return, and when the
-- office opened the car up for the next customer.
-- ---------------------------------------------------------------- --

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'return_notice_given_at') = 0,
  'ALTER TABLE bookings ADD COLUMN return_notice_given_at DATETIME NULL
     COMMENT "when the renter gave notice they are returning the car"',
  'SELECT "return_notice_given_at exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'expected_return_on') = 0,
  'ALTER TABLE bookings ADD COLUMN expected_return_on DATE NULL
     COMMENT "the date the renter says they will bring it back"',
  'SELECT "expected_return_on exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---------------------------------------------------------------- --
-- vehicles: released for pre-booking. Kept on the VEHICLE, not the
-- booking, because it is the car that becomes available to others.
-- ---------------------------------------------------------------- --

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vehicles'
      AND COLUMN_NAME = 'released_for_prebooking_at') = 0,
  'ALTER TABLE vehicles ADD COLUMN released_for_prebooking_at DATETIME NULL
     COMMENT "admin opened this car for pre-booking by the next customer"',
  'SELECT "released_for_prebooking_at exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vehicles'
      AND COLUMN_NAME = 'available_from') = 0,
  'ALTER TABLE vehicles ADD COLUMN available_from DATE NULL
     COMMENT "earliest date the next customer may collect"',
  'SELECT "available_from exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---------------------------------------------------------------- --
-- Cars out on rent right now, with whether notice has been given and
-- whether the office has released them. Drives both the public card
-- and the admin release queue.
-- ---------------------------------------------------------------- --

CREATE OR REPLACE VIEW vw_vehicle_status AS
SELECT
  v.id                            AS vehicle_id,
  v.slug,
  v.name,
  v.model_year,
  v.released_for_prebooking_at,
  v.available_from,
  b.reference                     AS current_reference,
  b.starts_on                     AS current_from,
  b.ends_on                       AS current_to,
  b.return_notice_given_at,
  b.expected_return_on,
  c.full_name                     AS current_renter,
  DATEDIFF(COALESCE(b.expected_return_on, b.ends_on), CURDATE()) AS days_to_return,
  (SELECT COUNT(*) FROM bookings q
    WHERE q.vehicle_id = v.id AND q.status = 'Prebooked') AS prebooked_count
FROM vehicles v
LEFT JOIN bookings b
       ON b.vehicle_id = v.id
      AND b.status = 'Active'
      AND CURDATE() BETWEEN b.starts_on AND b.ends_on
LEFT JOIN customers c ON c.id = b.customer_id
WHERE v.is_active = 1;

-- ---------------------------------------------------------------- --
-- The release queue: cars whose renter has given notice but which the
-- office has not opened for pre-booking yet.
-- ---------------------------------------------------------------- --

CREATE OR REPLACE VIEW vw_awaiting_release AS
SELECT
  v.slug,
  v.name,
  v.model_year,
  b.reference,
  b.ends_on,
  b.expected_return_on,
  b.return_notice_given_at,
  c.full_name  AS renter,
  c.email      AS renter_email,
  DATEDIFF(COALESCE(b.expected_return_on, b.ends_on), CURDATE()) AS days_to_return
FROM bookings b
JOIN vehicles  v ON v.id = b.vehicle_id
JOIN customers c ON c.id = b.customer_id
WHERE b.status = 'Active'
  AND b.return_notice_given_at IS NOT NULL
  AND v.released_for_prebooking_at IS NULL
ORDER BY COALESCE(b.expected_return_on, b.ends_on);

-- ---------------------------------------------------------------- --
-- The pre-booking queue, in the order requests arrived.
-- ---------------------------------------------------------------- --

CREATE OR REPLACE VIEW vw_prebooking_queue AS
SELECT
  v.slug,
  v.name           AS vehicle_name,
  v.model_year,
  b.reference,
  b.starts_on,
  b.ends_on,
  b.total,
  b.confirmation_sent,
  b.created_at,
  c.full_name      AS customer,
  c.email,
  c.phone,
  ROW_NUMBER() OVER (PARTITION BY v.id ORDER BY b.created_at) AS queue_position
FROM bookings b
JOIN vehicles  v ON v.id = b.vehicle_id
JOIN customers c ON c.id = b.customer_id
WHERE b.status = 'Prebooked'
ORDER BY v.slug, b.created_at;
