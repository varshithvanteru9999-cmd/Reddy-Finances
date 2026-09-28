-- ------------------------------------------------------------------
-- Migration 011 — prebooking amount and payment tracking
--
-- When a car is released for pre-booking the admin sets a fee the
-- next customer must pay to hold the slot. The bookings table tracks
-- whether that payment has been completed.
--
-- Safe to re-run: every ALTER is guarded on the column not existing.
-- ------------------------------------------------------------------

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vehicles'
      AND COLUMN_NAME = 'prebooking_amount') = 0,
  'ALTER TABLE vehicles
     ADD COLUMN prebooking_amount DECIMAL(10,2) NULL
     COMMENT "fee the next customer pays to hold a pre-booking slot"',
  'SELECT "prebooking_amount exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'prebooking_paid') = 0,
  'ALTER TABLE bookings
     ADD COLUMN prebooking_paid TINYINT(1) NOT NULL DEFAULT 0
     COMMENT "1 once the admin confirms the pre-booking fee has been received"',
  'SELECT "prebooking_paid exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Refresh the vehicle status view to include prebooking_amount
CREATE OR REPLACE VIEW vw_vehicle_status AS
SELECT
  v.id                            AS vehicle_id,
  v.slug,
  v.name,
  v.model_year,
  v.released_for_prebooking_at,
  v.available_from,
  v.prebooking_amount,
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
