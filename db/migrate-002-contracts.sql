-- ==================================================================
-- Migration 002 — Contract documents and license uploads
--
--   mysql -u root -p < db/migrate-002-contracts.sql
--
-- Safe to re-run: every statement is guarded.
-- ==================================================================

USE reddy_finances;

-- ------------------------------------------------------------------
-- bookings: add contract tracking columns
-- ------------------------------------------------------------------
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'reddy_finances' AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'contract_sent_at') = 0,
  'ALTER TABLE bookings ADD COLUMN contract_sent_at DATETIME NULL AFTER released_at',
  'SELECT "contract_sent_at exists"'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'reddy_finances' AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'contract_signed_at') = 0,
  'ALTER TABLE bookings ADD COLUMN contract_signed_at DATETIME NULL AFTER contract_sent_at',
  'SELECT "contract_signed_at exists"'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'reddy_finances' AND TABLE_NAME = 'bookings'
      AND COLUMN_NAME = 'license_uploaded_at') = 0,
  'ALTER TABLE bookings ADD COLUMN license_uploaded_at DATETIME NULL AFTER contract_signed_at',
  'SELECT "license_uploaded_at exists"'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ------------------------------------------------------------------
-- contract_documents — stores generated PDFs sent to customers
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contract_documents (
  id            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  booking_id    INT UNSIGNED    NOT NULL,
  document_type ENUM('rental_agreement','sale_agreement') NOT NULL DEFAULT 'rental_agreement',
  file_path     VARCHAR(500)    NOT NULL,
  file_size     INT UNSIGNED    NULL,
  sent_at       DATETIME        NULL,
  signed_at     DATETIME        NULL,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_contract_docs_booking (booking_id),
  CONSTRAINT fk_contract_docs_booking FOREIGN KEY (booking_id)
    REFERENCES bookings (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------------
-- license_uploads — stores customer uploaded license documents
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS license_uploads (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  booking_id      INT UNSIGNED    NOT NULL,
  file_path       VARCHAR(500)    NOT NULL,
  file_name       VARCHAR(255)    NOT NULL,
  file_size       INT UNSIGNED    NULL,
  mime_type       VARCHAR(100)    NULL,
  uploaded_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_license_uploads_booking (booking_id),
  CONSTRAINT fk_license_uploads_booking FOREIGN KEY (booking_id)
    REFERENCES bookings (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------------
-- Updated view: include contract/license status
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
  b.contract_sent_at,
  b.contract_signed_at,
  b.license_uploaded_at,
  b.created_at
FROM bookings b
JOIN customers c ON c.id = b.customer_id
JOIN vehicles  v ON v.id = b.vehicle_id;

-- ------------------------------------------------------------------
-- View for contracts pending signature
-- ------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_pending_contracts AS
SELECT
  b.reference,
  c.full_name,
  c.email,
  c.phone,
  CONCAT(v.model_year, ' ', v.name)              AS vehicle,
  v.listing_type,
  b.starts_on,
  b.ends_on,
  b.contract_sent_at,
  b.contract_signed_at,
  b.license_uploaded_at,
  cd.file_path AS contract_path,
  lu.file_path AS license_path
FROM bookings b
JOIN customers c ON c.id = b.customer_id
JOIN vehicles  v ON v.id = b.vehicle_id
LEFT JOIN contract_documents cd ON cd.booking_id = b.id AND cd.document_type = 'rental_agreement'
LEFT JOIN license_uploads lu ON lu.booking_id = b.id
WHERE b.status IN ('Prebooked','Confirmed','Active')
ORDER BY b.starts_on;