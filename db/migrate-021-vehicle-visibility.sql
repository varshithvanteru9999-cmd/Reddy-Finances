-- ------------------------------------------------------------------
-- Vehicle visibility toggle.
--
-- Lets the admin hide a car from the public site without removing it
-- from the fleet. Useful for temporarily pulling a listing while it is
-- being serviced, or for keeping a car on file without it appearing in
-- search results. The vehicle stays in the database and in every admin
-- tab — it simply vanishes from the public grid.
--
-- Safe to re-run.
-- ------------------------------------------------------------------

USE reddy_finances;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'vehicles'
    AND COLUMN_NAME  = 'is_visible'
);

SET @sql := IF(@exists = 0,
  'ALTER TABLE vehicles ADD COLUMN is_visible TINYINT(1) NOT NULL DEFAULT 1 AFTER is_active',
  'SELECT "is_visible already exists"');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
