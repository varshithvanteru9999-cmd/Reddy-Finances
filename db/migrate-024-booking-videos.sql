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

USE reddy_finances;

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
