/* ------------------------------------------------------------------
   Referral details for a booking.

   The rental agreement has carried REFERRAL NAME and REFERRAL PHONE
   since the office supplied it, and server/contract.js already reads
   `referral_name` / `referral_phone` when it fills the detail table —
   but the columns were never created, so those two boxes have printed
   blank on every contract. This adds them.

   They are captured by the admin from the booking's Ref popup rather
   than by the customer at booking time: a referral is something the
   office knows, not something the renter supplies.
------------------------------------------------------------------- */

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'bookings'
    AND COLUMN_NAME = 'referral_name'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE bookings ADD COLUMN referral_name VARCHAR(120) NULL AFTER notes',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'bookings'
    AND COLUMN_NAME = 'referral_phone'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE bookings ADD COLUMN referral_phone VARCHAR(40) NULL AFTER referral_name',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
