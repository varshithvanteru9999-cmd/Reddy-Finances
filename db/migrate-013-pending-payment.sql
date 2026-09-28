-- ------------------------------------------------------------------
-- Migration 013 — pending amount, and customer payment proof
--
-- pending_amount: a monthly rental can fall short — the customer pays
-- part of a month, or none of it. The office records the shortfall here
-- and it carries into what is owed next month, so the running balance
-- is visible on the booking rather than kept on paper.
--
-- payment_proofs: once a rental is approved the customer can upload a
-- screenshot of the transfer. Several are expected over a long rental
-- (one per month), so this is a table rather than a column, and the
-- office sees them against the booking in the dashboard.
--
-- Safe to re-run: the ALTER is guarded and the table uses IF NOT EXISTS.
-- ------------------------------------------------------------------

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'pending_amount') = 0,
  'ALTER TABLE bookings
     ADD COLUMN pending_amount DECIMAL(10,2) NOT NULL DEFAULT 0
     COMMENT "unpaid balance carried forward to the next month"
     AFTER advance_amount',
  'SELECT "pending_amount exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

CREATE TABLE IF NOT EXISTS payment_proofs (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_id   INT UNSIGNED NOT NULL,
  file_path    VARCHAR(255) NOT NULL,
  amount       DECIMAL(10,2) NULL COMMENT 'what the customer says they paid',
  note         VARCHAR(300) NULL,
  uploaded_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_payment_proof_booking (booking_id),
  CONSTRAINT fk_payment_proof_booking
    FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
