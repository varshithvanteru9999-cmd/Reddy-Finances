-- ------------------------------------------------------------------
-- Migration 012 — vehicle registration number
--
-- The office needs each car's number plate on screen when handling a
-- booking. It is an internal detail: the public site never shows it, so
-- it lives on the vehicle and is only read back in the admin dashboard.
--
-- UK plates are at most 8 characters including the space ("AB12 CDE"),
-- but a little headroom costs nothing and avoids a truncation bug if a
-- personalised or imported plate turns up.
--
-- Safe to re-run: the ALTER is guarded on the column not existing.
-- ------------------------------------------------------------------

SET @sql := IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vehicles'
      AND COLUMN_NAME = 'registration') = 0,
  'ALTER TABLE vehicles
     ADD COLUMN registration VARCHAR(16) NULL
     COMMENT "number plate — internal only, never shown to customers"',
  'SELECT "registration exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
