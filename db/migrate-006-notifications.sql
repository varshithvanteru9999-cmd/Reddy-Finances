-- ------------------------------------------------------------------
-- Notifications.
--
-- Two audiences share one table:
--   * a row with a customer_id  -> shown to that customer
--   * a row with audience='admin' -> shown in the dashboard
--
-- Every meaningful event writes one: a booking request arrives, the
-- admin marks it under confirmation, approves, rejects, or releases a
-- car. The customer sees "your booking is under confirmation" without
-- anyone having to send an email.
--
-- Safe to re-run.
-- ------------------------------------------------------------------

USE reddy_finances;

CREATE TABLE IF NOT EXISTS notifications (
  id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  audience     ENUM('customer','admin') NOT NULL,
  customer_id  INT UNSIGNED  NULL
               COMMENT 'set for audience=customer; NULL for admin rows',
  booking_id   INT UNSIGNED  NULL,
  kind         VARCHAR(40)   NOT NULL
               COMMENT 'booking_requested | under_confirmation | approved | rejected | released | contract_sent | signed',
  title        VARCHAR(160)  NOT NULL,
  body         VARCHAR(500)  NOT NULL DEFAULT '',
  link         VARCHAR(200)  NOT NULL DEFAULT '',
  is_read      TINYINT(1)    NOT NULL DEFAULT 0,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_customer  (customer_id, is_read, created_at),
  KEY idx_audience  (audience, is_read, created_at),

  CONSTRAINT fk_notif_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE,
  CONSTRAINT fk_notif_booking FOREIGN KEY (booking_id)
    REFERENCES bookings (id) ON DELETE CASCADE
) ENGINE=InnoDB;
