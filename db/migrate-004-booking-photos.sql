

-- ------------------------------------------------------------------
-- booking_photos — stores customer uploaded required photos 
-- (odometer, front, rear, left, right) for a confirmed booking
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_photos (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  booking_id      INT UNSIGNED    NOT NULL,
  photo_type      ENUM('odometer', 'front', 'rear', 'left_side', 'right_side') NOT NULL,
  file_path       VARCHAR(500)    NOT NULL,
  uploaded_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_booking_photo_type (booking_id, photo_type),
  CONSTRAINT fk_booking_photos_booking FOREIGN KEY (booking_id)
    REFERENCES bookings (id) ON DELETE CASCADE
) ENGINE=InnoDB;
