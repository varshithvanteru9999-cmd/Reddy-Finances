/* ------------------------------------------------------------------
   The time of day the car is handed over.

   The rental agreement's detail table asks for "PICKUP DATE & TIME",
   but bookings only ever stored `starts_on`, a DATE — so the time half
   of that field has printed blank on every contract. The office agrees
   a collection time with the renter during onboarding, and this is
   where it goes.

   Nullable: older bookings have no recorded time, and a blank must
   stay blank rather than claim midnight.
------------------------------------------------------------------- */

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'bookings'
    AND COLUMN_NAME = 'pickup_time'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE bookings ADD COLUMN pickup_time TIME NULL AFTER starts_on',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
