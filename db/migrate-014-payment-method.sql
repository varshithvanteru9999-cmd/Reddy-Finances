-- ------------------------------------------------------------------
-- Migration 014 — payment method, and scanned payment proof
--
-- payment_method: how the money arrived. 'online' is set automatically
-- when the customer uploads a screenshot; 'cash' is the office ticking
-- the box. NULL means nothing has been recorded yet.
--
-- On payment_proofs:
--   scanned_amount  what OCR read from the image, before anyone checks it
--   scan_status     ok / short / unreadable — drives the green/red dot
--   verified_at     set once an admin agrees with the figure. Until then
--                   the amount is a suggestion and must not move money.
--
-- The scan is deliberately advisory: reading a number off a screenshot
-- is unreliable, so nothing adjusts a balance until a person confirms.
--
-- Safe to re-run: every ALTER is guarded on the column not existing.
-- ------------------------------------------------------------------

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'payment_method') = 0,
  'ALTER TABLE bookings
     ADD COLUMN payment_method ENUM(''online'', ''cash'') NULL
     COMMENT "how the payment arrived; NULL until something is recorded"
     AFTER prebooking_paid',
  'SELECT "payment_method exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_proofs'
      AND COLUMN_NAME = 'scanned_amount') = 0,
  'ALTER TABLE payment_proofs
     ADD COLUMN scanned_amount DECIMAL(10,2) NULL
     COMMENT "amount OCR read from the image, unverified"',
  'SELECT "scanned_amount exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_proofs'
      AND COLUMN_NAME = 'scan_status') = 0,
  'ALTER TABLE payment_proofs
     ADD COLUMN scan_status VARCHAR(20) NULL
     COMMENT "ok | short | unreadable"',
  'SELECT "scan_status exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_proofs'
      AND COLUMN_NAME = 'verified_at') = 0,
  'ALTER TABLE payment_proofs
     ADD COLUMN verified_at TIMESTAMP NULL
     COMMENT "when an admin agreed with the amount"',
  'SELECT "verified_at exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- A pre-booking proof arrives before the booking row is confirmed, so
-- the upload must be allowed on any status, not only approved rentals.
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_proofs'
      AND COLUMN_NAME = 'stage') = 0,
  'ALTER TABLE payment_proofs
     ADD COLUMN stage VARCHAR(20) NOT NULL DEFAULT ''rental''
     COMMENT "prebooking | rental"',
  'SELECT "stage exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
