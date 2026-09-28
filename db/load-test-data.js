/* ------------------------------------------------------------------
   Reset the database with fresh, realistic test data.
   Clears all customer/booking/notification/enquiry data (fleet kept)
   and loads:
     - 8 customers (mix of email-only, phone-only, both)
     - 11 bookings covering every status: Active (3), Confirmed (2, one
       open return), Prebooked (3, queued behind released cars),
       Completed (1, full photo set + tolls), Cancelled (1)
     - return-notice + release flow on two cars, pre-booking queues
     - contract signed / license uploaded on confirmed + completed
     - booking photos (pickup and return) where relevant
     - customer + admin notifications through every stage
     - viewing / consultation / sell enquiries for the sale fleet
   Uses the app's own billing engine so every figure is exact.
------------------------------------------------------------------- */

const { readFileSync } = require('fs');
const mysql = require('C:/Users/varsh/Music/OneDrive/Desktop/Car rental and sale/node_modules/mysql2/promise');
const billing = require('../js/billing.js');

const env = {};
for (const line of readFileSync('C:/Users/varsh/Music/OneDrive/Desktop/Car rental and sale/.env', 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq === -1) continue;
  env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}

const plus = days => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const isoNow = d => {
  const x = d ? new Date(d) : new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')} ${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}:00`;
};
const ago = days => isoNow(Date.now() - days * 86400000);

async function main() {
  const pool = mysql.createPool({
    host: env.DB_HOST, port: env.DB_PORT || 3306,
    user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME,
    dateStrings: true, connectionLimit: 5
  });
  const c = await pool.getConnection();

  try {
    await c.beginTransaction();
    await c.query('SET FOREIGN_KEY_CHECKS = 0');

    for (const t of ['booking_photos', 'notifications', 'contract_documents', 'license_uploads',
                     'bookings', 'enquiries', 'customers']) {
      await c.query(`DELETE FROM ${t}`);
    }
    await c.query('ALTER TABLE customers AUTO_INCREMENT = 1');
    await c.query('ALTER TABLE bookings AUTO_INCREMENT = 1001');
    await c.query('ALTER TABLE notifications AUTO_INCREMENT = 1');
    await c.query('ALTER TABLE enquiries AUTO_INCREMENT = 1');
    await c.query('ALTER TABLE booking_photos AUTO_INCREMENT = 1');

    // ---- customers ----
    const customers = [
      ['Rajesh Kumar',    'rajesh.kumar@gmail.com',    '(214) 555-1001', 'TX12345678', 'Dallas'],
      ['Priya Sharma',    'priya.sharma@outlook.com',  '(214) 555-1002', 'CA98765432', 'Los Angeles'],
      ['Amit Patel',      'amit.patel@yahoo.com',      '(312) 555-1003', 'IL55512345', 'Chicago'],
      ['Sneha Reddy',     'sneha.reddy@gmail.com',     '(720) 555-1004', 'CO33344455', 'Denver'],
      ['Vikram Singh',    'vikram.singh@hotmail.com',  '(602) 555-1005', 'AZ77788899', 'Phoenix'],
      ['Marcus Williams', 'marcus.w@yahoo.com',        '(305) 555-1006', 'FL11122233', 'Miami'],
      ['Elena Rodriguez', 'elena.r@gmail.com',         null,             'TX44455566', 'Houston'],
      ['James Thompson',  'james.thompson@outlook.com', null,            'GA66677788', 'Atlanta']
    ];
    const custId = {};
    for (const [i, cus] of customers.entries()) {
      const [r] = await c.query(
        'INSERT INTO customers (full_name, email, phone, license_number, city) VALUES (?,?,?,?,?)', cus);
      custId[i + 1] = r.insertId;
    }

    // ---- vehicles: actual id, day rate, monthly rate ----
    const V = { tesla: 1, mustang: 2, rav4: 3, suburban: 4, bmw: 5, jeep: 6 };
    const rates = {
      [V.tesla]:    { day: 89.00,  month: 2314.00 },
      [V.mustang]:  { day: 145.00, month: 3770.00 },
      [V.rav4]:     { day: 72.00,  month: 1872.00 },
      [V.suburban]: { day: 135.00, month: 3510.00 },
      [V.bmw]:      { day: 98.00,  month: 500.00 },
      [V.jeep]:     { day: 110.00, month: 2860.00 }
    };

    const qt = (vehicle, from, to, tolls = 0) => {
      const q = billing.quote({
        startsOn: from, endsOn: to,
        monthlyRate: rates[vehicle].month, dayRate: rates[vehicle].day,
        listingType: 'rental', tolls, advance: null
      });
      return { total: q.subtotal + q.tolls, advance: q.advance, breakdown: JSON.stringify(q.lines) };
    };

    const insertBooking = async (ref, custKey, vehicleId, from, to, status, opts = {}) => {
      const q = qt(vehicleId, from, to, opts.tolls || 0);
      const [r] = await c.query(
        `INSERT INTO bookings
           (reference, customer_id, vehicle_id, starts_on, ends_on, status,
            day_rate, monthly_rate, total, toll_charges, toll_notes,
            billing_breakdown, advance_amount, open_return, confirmation_sent,
            return_notice_given_at, expected_return_on, contract_sent_at,
            contract_signed_at, license_uploaded_at, released_at, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ref, custId[custKey], vehicleId, from, to, status,
         rates[vehicleId].day, rates[vehicleId].month,
         q.total, opts.tolls || 0, opts.tollNotes || null,
         q.breakdown, opts.advance === undefined ? q.advance : opts.advance,
         opts.openReturn ? 1 : 0, opts.confirmationSent ? 1 : 0,
         opts.returnNotice || null, opts.expectedReturn || null,
         opts.contractSent || null, opts.contractSigned || null,
         opts.licenseUploaded || null, opts.released || null, opts.notes || null]);
      return r.insertId;
    };

    const bid = {};   // ref -> bookings.id

    bid.BK1041 = await insertBooking('BK-1041', 1, V.tesla, plus(-7), plus(23), 'Active',
      { tolls: 12.50, tollNotes: 'Downtown toll plaza', confirmationSent: true });

    bid.BK1042 = await insertBooking('BK-1042', 2, V.suburban, plus(-12), plus(28), 'Active',
      { confirmationSent: true, returnNotice: ago(6), expectedReturn: plus(28),
        released: ago(5), tolls: 45.50, tollNotes: 'Highway tolls (round trip)' });

    bid.BK1043 = await insertBooking('BK-1043', 6, V.mustang, plus(-20), plus(10), 'Active',
      { confirmationSent: true, returnNotice: ago(3), expectedReturn: plus(10), released: ago(3) });

    bid.BK1044 = await insertBooking('BK-1044', 3, V.bmw, plus(5), plus(35), 'Confirmed',
      { confirmationSent: true, contractSent: ago(2), contractSigned: ago(1), licenseUploaded: ago(1) });

    bid.BK1045 = await insertBooking('BK-1045', 7, V.rav4, plus(2), plus(32), 'Confirmed',
      { confirmationSent: true, openReturn: true, contractSent: ago(1), contractSigned: ago(1) });

    bid.BK1046 = await insertBooking('BK-1046', 4, V.rav4, plus(33), plus(63), 'Prebooked', { advance: 0 });

    bid.BK1047 = await insertBooking('BK-1047', 5, V.mustang, plus(11), plus(41), 'Prebooked', { advance: 0 });

    bid.BK1048 = await insertBooking('BK-1048', 7, V.mustang, plus(42), plus(72), 'Prebooked', { advance: 0 });

    bid.BK1049 = await insertBooking('BK-1049', 8, V.suburban, plus(29), plus(59), 'Prebooked', { advance: 0 });

    bid.BK1050 = await insertBooking('BK-1050', 8, V.jeep, plus(-95), plus(-65), 'Completed',
      { confirmationSent: true, contractSent: ago(92), contractSigned: ago(90),
        licenseUploaded: ago(94), released: ago(66),
        tolls: 87.25, tollNotes: 'Tolls during rental', expectedReturn: plus(-65) });

    bid.BK1051 = await insertBooking('BK-1051', 4, V.jeep, plus(15), plus(45), 'Cancelled',
      { notes: 'Customer cancelled — no longer needed.' });

    // ---- vehicle release / pre-booking flags ----
    const clearFlag = async slug => {
      await c.query(`UPDATE vehicles SET released_for_prebooking_at = NULL,
                     available_from = NULL, prebooking_amount = NULL WHERE slug = ?`, [slug]);
    };
    for (const s of ['tesla-model-3', 'bmw-330i', 'jeep-wrangler', 'toyota-rav4-hybrid']) await clearFlag(s);
    await c.query(`UPDATE vehicles SET released_for_prebooking_at = ?, available_from = ?, prebooking_amount = ?
                   WHERE slug = 'chevrolet-suburban'`, [ago(5), plus(28), 150.00]);
    await c.query(`UPDATE vehicles SET released_for_prebooking_at = ?, available_from = ?, prebooking_amount = ?
                   WHERE slug = 'ford-mustang-gt'`, [ago(3), plus(10), 200.00]);

    // ---- booking photos ----
    const photo = async (bId, type, stage) => {
      await c.query(
        'INSERT INTO booking_photos (booking_id, photo_type, stage, file_path) VALUES (?,?,?,?)',
        [bId, type, stage, `/uploads/photos/${stage}-${type}-${bId}.jpg`]);
    };
    // Tesla pickup (BK-1041)
    await photo(bid.BK1041, 'odometer', 'pickup'); await photo(bid.BK1041, 'front', 'pickup'); await photo(bid.BK1041, 'rear', 'pickup');
    // Suburban pickup + return odometer (BK-1042)
    await photo(bid.BK1042, 'front', 'pickup'); await photo(bid.BK1042, 'rear', 'pickup'); await photo(bid.BK1042, 'odometer', 'pickup');
    await photo(bid.BK1042, 'odometer', 'return');
    // Mustang pickup (BK-1043)
    await photo(bid.BK1043, 'odometer', 'pickup'); await photo(bid.BK1043, 'front', 'pickup');
    // Completed Jeep full pickup + return sets (BK-1050)
    const types = ['odometer', 'front', 'rear', 'left_side', 'right_side'];
    for (const t of types) { await photo(bid.BK1050, t, 'pickup'); }
    for (const t of types) { await photo(bid.BK1050, t, 'return'); }

    // ---- notifications ----
    const custDesc = { 1: 'Rajesh Kumar', 2: 'Priya Sharma', 3: 'Amit Patel', 4: 'Sneha Reddy',
                       5: 'Vikram Singh', 6: 'Marcus Williams', 7: 'Elena Rodriguez', 8: 'James Thompson' };
    const carName = { 1: '2024 Tesla Model 3', 2: '2021 Ford Mustang GT', 3: '2023 Toyota RAV4 Hybrid',
                      4: '2022 Chevrolet Suburban', 5: '2022 BMW 330i', 6: '2021 Jeep Wrangler' };
    const notif = async (audience, custKey, bId, kind, daysAgo, title, body, link) => {
      await c.query(
        `INSERT INTO notifications (audience, customer_id, booking_id, kind, title, body, link, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [audience, custKey ? custId[custKey] : null, bId, kind, title, body,
         link || '', daysAgo === undefined ? isoNow() : ago(daysAgo)]);
    };
    const titleFor = (kind, admin) => {
      if (kind === 'booking_requested') return admin ? 'New booking request' : 'Booking request sent';
      if (kind === 'under_confirmation') return admin ? 'Booking under review' : 'We are reviewing your request';
      if (kind === 'approved') return admin ? 'Booking approved' : 'Booking confirmed';
      if (kind === 'rejected') return admin ? 'Booking rejected' : 'Booking not available';
      if (kind === 'released') return 'Car released for pre-booking';
      if (kind === 'contract_sent') return 'Rental agreement ready';
      if (kind === 'signed') return 'Rental agreement signed';
      return kind;
    };
    const bookNotif = async (ref, custKey, vehicleId, kind, daysAgo, extra) => {
      const car = carName[vehicleId];
      const bId = bid[ref];
      await notif('customer', custKey, bId, kind, daysAgo, titleFor(kind, false),
        `${custDesc[custKey]} — ${car} (${ref}). ${extra || ''}`, `bookings.html?ref=${ref}`);
      await notif('admin', null, bId, kind, daysAgo, titleFor(kind, true),
        `${custDesc[custKey]} — ${car} (${ref}).`, 'admin.html#actions');
    };

    await bookNotif('BK1041', 1, V.tesla, 'booking_requested', 7);
    await bookNotif('BK1041', 1, V.tesla, 'under_confirmation', 6);
    await bookNotif('BK1041', 1, V.tesla, 'approved', 5);

    await bookNotif('BK1042', 2, V.suburban, 'booking_requested', 12);
    await bookNotif('BK1042', 2, V.suburban, 'approved', 10);
    await notif('customer', 2, bid.BK1042, 'released', 5, 'Car released for pre-booking',
      'The Chevrolet Suburban you are renting is now open for pre-booking after your return.', '');
    await notif('admin', null, bid.BK1042, 'released', 5, 'Car released for pre-booking',
      'Chevrolet Suburban released — queue open for dates after its return.', 'admin.html#release');

    await bookNotif('BK1043', 6, V.mustang, 'booking_requested', 20);
    await bookNotif('BK1043', 6, V.mustang, 'approved', 18);
    await notif('admin', null, bid.BK1043, 'released', 3, 'Car released for pre-booking',
      'Ford Mustang GT released — queue open for dates after its return.', 'admin.html#release');

    await bookNotif('BK1044', 3, V.bmw, 'booking_requested', 7);
    await bookNotif('BK1044', 3, V.bmw, 'under_confirmation', 5);
    await bookNotif('BK1044', 3, V.bmw, 'approved', 4);
    await bookNotif('BK1044', 3, V.bmw, 'contract_sent', 2);
    await bookNotif('BK1044', 3, V.bmw, 'signed', 1);

    await bookNotif('BK1045', 7, V.rav4, 'booking_requested', 4);
    await bookNotif('BK1045', 7, V.rav4, 'under_confirmation', 3);
    await bookNotif('BK1045', 7, V.rav4, 'approved', 2);
    await bookNotif('BK1045', 7, V.rav4, 'contract_sent', 1);
    await bookNotif('BK1045', 7, V.rav4, 'signed', 0);

    await bookNotif('BK1046', 4, V.rav4, 'booking_requested', 1);
    await bookNotif('BK1047', 5, V.mustang, 'booking_requested', 2);
    await bookNotif('BK1048', 7, V.mustang, 'booking_requested', 1);
    await bookNotif('BK1049', 8, V.suburban, 'booking_requested', 2);

    await bookNotif('BK1050', 8, V.jeep, 'booking_requested', 95);
    await bookNotif('BK1050', 8, V.jeep, 'approved', 93);
    await bookNotif('BK1050', 8, V.jeep, 'contract_sent', 92);
    await bookNotif('BK1050', 8, V.jeep, 'signed', 90);

    await notif('customer', 4, bid.BK1051, 'rejected', 3, 'Booking cancelled',
      'Your Jeep Wrangler booking (BK-1051) was cancelled. Nothing has been charged.', 'bookings.html?ref=BK-1051');
    await notif('admin', null, bid.BK1051, 'rejected', 3, 'Booking cancelled',
      'Sneha Reddy cancelled Jeep Wrangler (BK-1051) — car available again.', 'admin.html#bookings');

    // ---- enquiries ----
    const enquiry = async (kind, name, email, phone, message, carMake, carYear, carMiles, zip) => {
      await c.query(
        `INSERT INTO enquiries (kind, full_name, email, phone, message, car_make, car_year, car_miles, zip_code, handled)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [kind, name, email, phone, message, carMake, carYear, carMiles, zip, 0]);
    };
    await enquiry('viewing', 'Rajesh Kumar', 'rajesh.kumar@gmail.com', '(214) 555-1001',
      'Would like to see the 2021 Porsche 911 this weekend.', '992 Carrera S', 2021, 12000, '75001');
    await enquiry('viewing', 'Amit Patel', 'amit.patel@yahoo.com', '(312) 555-1003',
      'Interested in the Audi Q5 — is a test drive possible?', 'Q5 Premium Plus', 2022, 21000, '60601');
    await enquiry('consultation', 'Sneha Reddy', 'sneha.reddy@gmail.com', '(720) 555-1004',
      'Looking for advice about financing a Ford F-150 for my business.', 'F-150 Lariat', 2023, 8000, '80001');
    await enquiry('sell', 'Elena Rodriguez', 'elena.r@gmail.com', '(469) 555-1007',
      'I would like a valuation for my Honda Accord, one owner, 45k miles.', 'Accord EX', 2019, 45000, '77001');
    await enquiry('general', 'James Thompson', 'james.thompson@outlook.com', null,
      'Do you offer long-term (6 month) rentals on the RAV4?', null, null, null, null);

    await c.query('SET FOREIGN_KEY_CHECKS = 1');
    await c.commit();

    const [[cnt]] = await c.query(`SELECT
      (SELECT COUNT(*) FROM customers) customers,
      (SELECT COUNT(*) FROM vehicles) vehicles,
      (SELECT COUNT(*) FROM bookings) bookings,
      (SELECT COUNT(*) FROM notifications) notifications,
      (SELECT COUNT(*) FROM booking_photos) photos,
      (SELECT COUNT(*) FROM enquiries) enquiries`);
    console.log('Loaded test data:', JSON.stringify(cnt));
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });