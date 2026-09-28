USE reddy_finances;
SET NAMES utf8mb4;

-- =====================================================
-- TEST DATA — customers, bookings, features
-- Safe to re-run (INSERT IGNORE on unique keys)
-- =====================================================

-- --- Customers ---------------------------------------------------
INSERT IGNORE INTO customers (full_name, email, phone, license_number)
VALUES
  ('Rajesh Kumar',   'rajesh@test.com',   '(214) 555-1001', 'TX-12345678'),
  ('Priya Sharma',   'priya@test.com',    '(214) 555-1002', 'TX-87654321'),
  ('Amit Patel',     'amit@test.com',     '(214) 555-1003', 'TX-11223344'),
  ('Sneha Reddy',    'sneha@test.com',    '(214) 555-1004', 'TX-55667788'),
  ('Vikram Singh',   'vikram@test.com',   '(214) 555-1005', 'TX-99887766');

-- --- Bookings ----------------------------------------------------
-- 1. Active rental (Rajesh has the Tesla, started yesterday)
INSERT IGNORE INTO bookings
  (reference, customer_id, vehicle_id, starts_on, ends_on, status, total, monthly_rate, created_at)
SELECT 'TEST-001',
       c.id, v.id,
       DATE_SUB(CURDATE(), INTERVAL 3 DAY),   -- started 3 days ago
       DATE_ADD(CURDATE(), INTERVAL 27 DAY),   -- ends in 27 days
       'Active', 267.00, 89.00,
       DATE_SUB(CURDATE(), INTERVAL 5 DAY)
FROM customers c, vehicles v
WHERE c.email = 'rajesh@test.com' AND v.slug = 'tesla-model-3';

-- 2. Upcoming confirmed booking (Priya — BMW, starts in 5 days)
INSERT IGNORE INTO bookings
  (reference, customer_id, vehicle_id, starts_on, ends_on, status, total, monthly_rate, confirmation_sent, created_at)
SELECT 'TEST-002',
       c.id, v.id,
       DATE_ADD(CURDATE(), INTERVAL 5 DAY),
       DATE_ADD(CURDATE(), INTERVAL 35 DAY),
       'Confirmed', 720.00, 240.00, 1,
       DATE_SUB(CURDATE(), INTERVAL 2 DAY)
FROM customers c, vehicles v
WHERE c.email = 'priya@test.com' AND v.slug = 'bmw-x5';

-- 3. Active rental with return notice given (Amit — Mercedes, notice to return in 10 days)
INSERT IGNORE INTO bookings
  (reference, customer_id, vehicle_id, starts_on, ends_on, status, total, monthly_rate, return_notice_given_at, expected_return_on, created_at)
SELECT 'TEST-003',
       c.id, v.id,
       DATE_SUB(CURDATE(), INTERVAL 40 DAY),
       DATE_ADD(CURDATE(), INTERVAL 20 DAY),
       'Active', 1600.00, 400.00,
       NOW(), DATE_ADD(CURDATE(), INTERVAL 10 DAY),
       DATE_SUB(CURDATE(), INTERVAL 42 DAY)
FROM customers c, vehicles v
WHERE c.email = 'amit@test.com' AND v.slug = 'mercedes-c300';

-- 4. Prebooked (Sneha — queuing for the Mercedes after Amit returns)
INSERT IGNORE INTO bookings
  (reference, customer_id, vehicle_id, starts_on, ends_on, status, total, monthly_rate, created_at)
SELECT 'TEST-004',
       c.id, v.id,
       DATE_ADD(CURDATE(), INTERVAL 12 DAY),
       DATE_ADD(CURDATE(), INTERVAL 42 DAY),
       'Prebooked', 1200.00, 400.00,
       DATE_SUB(CURDATE(), INTERVAL 1 DAY)
FROM customers c, vehicles v
WHERE c.email = 'sneha@test.com' AND v.slug = 'mercedes-c300';

-- 5. Prebooked (Vikram — also waiting for Mercedes)
INSERT IGNORE INTO bookings
  (reference, customer_id, vehicle_id, starts_on, ends_on, status, total, monthly_rate, created_at)
SELECT 'TEST-005',
       c.id, v.id,
       DATE_ADD(CURDATE(), INTERVAL 14 DAY),
       DATE_ADD(CURDATE(), INTERVAL 44 DAY),
       'Prebooked', 1200.00, 400.00,
       DATE_SUB(CURDATE(), INTERVAL 12 HOUR)
FROM customers c, vehicles v
WHERE c.email = 'vikram@test.com' AND v.slug = 'mercedes-c300';

-- 6. Completed past booking (Rajesh — Ford Mustang, already returned)
INSERT IGNORE INTO bookings
  (reference, customer_id, vehicle_id, starts_on, ends_on, status, total, monthly_rate, created_at)
SELECT 'TEST-006',
       c.id, v.id,
       DATE_SUB(CURDATE(), INTERVAL 90 DAY),
       DATE_SUB(CURDATE(), INTERVAL 60 DAY),
       'Completed', 500.00, 500.00,
       DATE_SUB(CURDATE(), INTERVAL 95 DAY)
FROM customers c, vehicles v
WHERE c.email = 'rajesh@test.com' AND v.slug = 'ford-mustang';

-- --- Release the Mercedes for pre-booking (so prebooking queue works) -
UPDATE vehicles SET released_for_prebooking_at = NOW(),
  available_from = DATE_ADD(CURDATE(), INTERVAL 11 DAY),
  prebooking_amount = 150.00
WHERE slug = 'mercedes-c300';

-- --- Release the Tesla for pre-booking (for testing release flow) ---
UPDATE vehicles SET released_for_prebooking_at = NOW(),
  available_from = DATE_ADD(CURDATE(), INTERVAL 28 DAY),
  prebooking_amount = 0
WHERE slug = 'tesla-model-3';

-- --- Some condition photos for the active Tesla booking (Rajesh) -----
INSERT IGNORE INTO booking_photos (booking_id, photo_type, stage, file_path)
SELECT b.id, 'odometer', 'pickup', 'uploads/bookings/test-tesla-odometer.jpg'
  FROM bookings b WHERE b.reference = 'TEST-001';
INSERT IGNORE INTO booking_photos (booking_id, photo_type, stage, file_path)
SELECT b.id, 'front', 'pickup', 'uploads/bookings/test-tesla-front.jpg'
  FROM bookings b WHERE b.reference = 'TEST-001';
INSERT IGNORE INTO booking_photos (booking_id, photo_type, stage, file_path)
SELECT b.id, 'rear', 'pickup', 'uploads/bookings/test-tesla-rear.jpg'
  FROM bookings b WHERE b.reference = 'TEST-001';
