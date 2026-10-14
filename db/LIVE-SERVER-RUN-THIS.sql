-- ------------------------------------------------------------------
-- Reddy Finances — the three migrations the live server is missing.
--
-- WHAT THIS IS FOR
--   The Documents tab, the video uploads and the Miles tracker each
--   need tables that do not exist on the host yet, which is why the
--   dashboard says "This feature is not set up on the server yet".
--
-- HOW TO RUN IT
--   phpMyAdmin -> pick the database (u807314952_reddy) in the left
--   column -> SQL tab -> paste all of this -> Go.
--
--   Or, with shell access, the better route:   node db/setup.js
--
-- IS IT SAFE?
--   Yes. Every statement checks first and does nothing if the table or
--   column is already there, so running it twice changes nothing. It
--   only ADDS; no existing table, column or row is altered or removed.
--
--   The USE and CREATE DATABASE lines have been removed on purpose, so
--   this applies to whichever database you have selected. Select the
--   right one before pressing Go.
-- ------------------------------------------------------------------


-- =============== migrate-023-document-templates.sql ===============
-- ------------------------------------------------------------------
-- The rental agreement as an editable, versioned document.
--
-- Until now the agreement's wording lived in server/contract-terms.js,
-- so changing a clause meant editing source and redeploying. The office
-- needs to amend it themselves, keep every past wording, and choose
-- which version goes to a customer.
--
-- One row per version. Versions are never updated or deleted — an
-- agreement already sent to a customer has to stay readable exactly as
-- it was sent — so an edit always inserts a new row.
--
-- `is_active` marks the version used by default when a contract is
-- sent. Exactly one row per document_type carries it; the application
-- clears the others in the same transaction.
--
-- `body` holds the document as JSON in the shape contract-terms.js
-- exports (title, intro, sections[], acknowledgement), so the PDF
-- generator needs no change to render a stored version.
--
-- `source_file` is set when a version came from an uploaded file rather
-- than the editor, so the office can see which is which.
--
-- Safe to re-run.
-- ------------------------------------------------------------------



SET @exists := (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'document_templates'
);

SET @sql := IF(@exists = 0, '
  CREATE TABLE document_templates (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    document_type ENUM("rental_agreement","sale_agreement")
                  NOT NULL DEFAULT "rental_agreement",
    version       INT UNSIGNED NOT NULL
                  COMMENT "1, 2, 3 ... per document_type",
    body          JSON NOT NULL
                  COMMENT "title, intro, sections[], acknowledgement",
    note          VARCHAR(300) NULL
                  COMMENT "what changed, typed by the admin",
    source_file   VARCHAR(500) NULL
                  COMMENT "set when the version came from an upload",
    is_active     TINYINT(1) NOT NULL DEFAULT 0
                  COMMENT "the version sent unless another is chosen",
    created_by    VARCHAR(190) NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_type_version (document_type, version),
    KEY idx_type_active (document_type, is_active),
    KEY idx_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
', 'SELECT "document_templates already exists"');

PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Which template version a booking was actually sent. Without it, a
-- contract sent last month cannot be traced to the wording it carried.
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'bookings'
    AND COLUMN_NAME = 'contract_template_id'
);

SET @sql := IF(@col = 0, '
  ALTER TABLE bookings
    ADD COLUMN contract_template_id INT UNSIGNED NULL
    COMMENT "document_templates.id of the version sent to this customer"
', 'SELECT "bookings.contract_template_id already exists"');

PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- =============== migrate-024-booking-videos.sql ===============
-- ------------------------------------------------------------------
-- Walkaround videos, alongside the condition photos.
--
-- The office asked for an optional video in each of the three places a
-- customer already uploads photos: pickup, return and damage. A video
-- shows what a still cannot — a rattle, a door that does not close
-- flush, the state of a panel from several angles in one pass.
--
-- A table of its own rather than a column on booking_photos: the photo
-- table is keyed by the five fixed slots (odometer, front, rear, left,
-- right) and a video belongs to no slot. Damage videos have a note,
-- the same as damage photos.
--
-- `stage` carries all three cases, so one table serves every section.
--
-- Videos are compressed in the BROWSER before upload (downscaled and
-- re-encoded to VP9/WebM), so what arrives here is already small —
-- typically 2-4 MB for a 30-second walkaround. original_bytes records
-- what the customer actually selected, so the office can see how much
-- was saved and spot a device that failed to compress.
--
-- Safe to re-run.
-- ------------------------------------------------------------------



SET @exists := (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'booking_videos'
);

SET @sql := IF(@exists = 0, '
  CREATE TABLE booking_videos (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    booking_id     INT UNSIGNED NOT NULL,
    stage          ENUM("pickup","return","damage") NOT NULL,
    file_path      VARCHAR(500) NOT NULL,
    note           VARCHAR(300) NULL
                   COMMENT "what it shows; used by damage videos",
    duration_secs  SMALLINT UNSIGNED NULL,
    file_bytes     INT UNSIGNED NULL
                   COMMENT "size as stored, after browser compression",
    original_bytes INT UNSIGNED NULL
                   COMMENT "size the customer selected, before compression",
    uploaded_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_booking_stage (booking_id, stage),
    CONSTRAINT fk_booking_videos_booking
      FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
', 'SELECT "booking_videos already exists"');

PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- =============== migrate-025-odometer-readings.sql ===============
-- ------------------------------------------------------------------
-- Odometer readings, so miles driven can be reported.
--
-- The customer already photographs the odometer at pickup and again at
-- return — but only the IMAGE was stored, and a photo of a dashboard
-- is not a number. Nothing in the system could say how far a car had
-- been driven.
--
-- Two columns on the booking rather than a table of their own: a
-- booking has exactly one pickup reading and one return reading, and
-- miles driven is the difference. A table would add a join for no
-- gain.
--
-- `*_source` records where each figure came from:
--     'ocr'    read automatically from the photo, NOT yet confirmed
--     'admin'  typed or corrected by the office
--     NULL     no reading yet
--
-- The distinction matters: OCR on a dashboard photo is far less
-- reliable than on a payment screenshot — glare, angle, trip meters
-- sitting beside the true odometer, and digits mid-roll. An unconfirmed
-- figure is shown as a suggestion the office must accept, never as a
-- fact, and the Miles tracker marks it so.
--
-- Safe to re-run.
-- ------------------------------------------------------------------



SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'bookings'
    AND COLUMN_NAME = 'odometer_pickup'
);

SET @sql := IF(@col = 0, '
  ALTER TABLE bookings
    ADD COLUMN odometer_pickup INT UNSIGNED NULL
      COMMENT "miles on the clock when the car was collected",
    ADD COLUMN odometer_return INT UNSIGNED NULL
      COMMENT "miles on the clock when it came back",
    ADD COLUMN odometer_pickup_source ENUM("ocr","admin") NULL
      COMMENT "ocr = read from the photo, unconfirmed; admin = checked",
    ADD COLUMN odometer_return_source ENUM("ocr","admin") NULL
', 'SELECT "odometer columns already exist"');

PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
