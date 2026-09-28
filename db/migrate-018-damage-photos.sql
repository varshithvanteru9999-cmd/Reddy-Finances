/* ------------------------------------------------------------------
   Damage photos.

   The five condition photos live in `booking_photos`, which carries a
   UNIQUE key on (booking_id, photo_type, stage) — exactly one shot per
   named angle. Damage is different: a renter may find one scratch or
   nine, and each needs its own picture and its own note. So damage
   gets its own table rather than a sixth enum value that the unique
   key would immediately reject.

   The agreement already asks for this ("Before driving away, the
   Driver should take videos of any damage already present"), but the
   app gave them nowhere to put it, so the evidence lived in WhatsApp
   or not at all.

   `stage` mirrors booking_photos: damage found at pickup is the
   renter protecting themselves, damage at return is the office
   recording what happened.
------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS booking_damage_photos (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_id   INT UNSIGNED NOT NULL,
  file_path    VARCHAR(500) NOT NULL,
  note         VARCHAR(300) NULL,
  stage        ENUM('pickup','return') NOT NULL DEFAULT 'pickup',
  uploaded_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_damage_booking (booking_id, stage),
  CONSTRAINT fk_damage_booking FOREIGN KEY (booking_id)
    REFERENCES bookings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
