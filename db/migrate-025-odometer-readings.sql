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

USE reddy_finances;

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
