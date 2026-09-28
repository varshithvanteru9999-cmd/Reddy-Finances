/* Where the customer collects the car.

   The office fixes this when it approves a booking — it varies by
   vehicle and by who is on shift, so it cannot be a fleet-wide
   constant. It goes out on the confirmation email, which until now
   told the customer the date but never the place. */

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'bookings'
              AND COLUMN_NAME = 'pickup_location');

SET @sql := IF(@c = 0,
  'ALTER TABLE bookings ADD COLUMN pickup_location VARCHAR(255) NULL AFTER pickup_time',
  'SELECT 1');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
