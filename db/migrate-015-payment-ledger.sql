-- ------------------------------------------------------------------
-- Migration 015 — payments as a ledger, so one booking can be settled
-- through more than one channel
--
-- A customer may hand over part of the money in cash and send the rest
-- by transfer with a screenshot. Until now `bookings.payment_method`
-- held a single value, so recording the second payment overwrote the
-- first and the two could never be added together; cash carried no
-- amount at all, only a pending figure, so there was nothing to add.
--
-- payment_proofs already behaves like a ledger — many rows per booking,
-- each with its own amount and its own verification — so cash joins it
-- as an ordinary row instead of getting a parallel mechanism:
--
--   method     'online' for an uploaded screenshot, 'cash' for money
--              taken at the counter. Existing rows are all uploads.
--   file_path  now nullable: a cash entry has no image to point at.
--
-- bookings.payment_method is left in place and still reflects how the
-- money arrived, now as a summary of the ledger ('cash', 'online', or
-- 'mixed'), so existing screens keep working while the amounts are
-- read from the ledger.
--
-- Safe to re-run: every change is guarded on its current state.
-- ------------------------------------------------------------------

-- How this payment arrived. Existing rows are uploads by definition,
-- so the default backfills them correctly.
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_proofs'
      AND COLUMN_NAME = 'method') = 0,
  'ALTER TABLE payment_proofs
     ADD COLUMN method ENUM(''online'', ''cash'') NOT NULL DEFAULT ''online''
     COMMENT "online = uploaded screenshot, cash = taken at the counter"
     AFTER file_path',
  'SELECT "method exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- A cash payment has no screenshot, so the path must be allowed to be
-- empty. Only widens the column; existing paths are untouched.
SET @sql := IF(
  (SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_proofs'
      AND COLUMN_NAME = 'file_path') = 'NO',
  'ALTER TABLE payment_proofs
     MODIFY COLUMN file_path VARCHAR(255) NULL
     COMMENT "the screenshot; NULL for a cash payment"',
  'SELECT "file_path already nullable"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 'mixed' records a booking settled through both channels. Widening an
-- ENUM keeps every existing value valid.
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'payment_method'
      AND COLUMN_TYPE NOT LIKE '%mixed%') = 1,
  'ALTER TABLE bookings
     MODIFY COLUMN payment_method ENUM(''online'', ''cash'', ''mixed'') NULL
     COMMENT "how the payment arrived; mixed = both channels; NULL until something is recorded"',
  'SELECT "payment_method already allows mixed"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Summing a booking's payments is now the commonest read on this table.
SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_proofs'
      AND INDEX_NAME = 'idx_proofs_booking_verified') = 0,
  'CREATE INDEX idx_proofs_booking_verified
     ON payment_proofs (booking_id, verified_at)',
  'SELECT "index exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
