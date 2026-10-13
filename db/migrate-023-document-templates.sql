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

USE reddy_finances;

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
