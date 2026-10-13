/* ------------------------------------------------------------------
   MySQL connection pool + the queries the API needs.

   Every query is parameterised — values go in the `?` slots, never
   into the SQL string. That is what keeps a name like O'Brien from
   breaking the query, and a hostile one from rewriting it.
------------------------------------------------------------------- */

const mysql = require('mysql2/promise');
const billing = require('../js/billing.js');
const { readFileSync } = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { PDFDocument, rgb } = require('pdf-lib');

/* Tiny .env reader — one dependency is enough for this project. */
function loadEnv() {
  const out = {};
  try {
    const raw = readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      /* only split on the FIRST '=', or a password containing one is truncated */
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    /* fall through to process.env */
  }
  return { ...out, ...process.env };
}

const env = loadEnv();

/* Read-only view of .env for the other server modules, so they do not
   each re-parse the file. */
function envValue(key) {
  return env[key];
}

const DB_HOST = env.DB_HOST || '127.0.0.1';
const DB_IS_LOCAL = /^(127\.0\.0\.1|localhost|::1)$/.test(DB_HOST);

const pool = mysql.createPool({
  host: DB_HOST,
  port: Number(env.DB_PORT || 3306),
  user: env.DB_USER || 'root',
  password: env.DB_PASSWORD || '',
  database: env.DB_NAME || 'reddy_finances',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4_general_ci',
  dateStrings: true,  /* DATE columns come back 'YYYY-MM-DD', not shifted
                         into a JS Date in the server's timezone */

  /* A database reached over the internet must be encrypted in transit —
     it carries names, emails and licence numbers. Managed hosts usually
     present a self-signed certificate, so verification is relaxed while
     the connection itself stays encrypted. A local socket needs none of
     this. Set DB_SSL=0 only if your host genuinely does not offer TLS. */
  ssl: (DB_IS_LOCAL || env.DB_SSL === '0')
    ? undefined
    : { rejectUnauthorized: false },

  /* A remote hop is slower than a local socket; fail clearly rather
     than hanging a request forever. */
  connectTimeout: DB_IS_LOCAL ? 10000 : 20000
});

/* ----------------------------- vehicles --------------------------- */

/* The front end expects the shape in js/data.js, so map column names
   back to the keys the pages already read. */
function toCar(row, features) {
  return {
    id: row.slug,
    type: row.listing_type,
    name: row.name,
    trim: row.trim_level || '',
    year: row.model_year,
    price: Number(row.price),
    monthlyRate: row.monthly_rate === null ? null : Number(row.monthly_rate),
    odometer: row.odometer_miles === null ? null : Number(row.odometer_miles),
    odometerUpdated: row.odometer_updated || '',
    body: row.body,
    seats: row.seats,
    doors: row.doors,
    transmission: row.transmission || '',
    fuel: row.fuel || '',
    economy: row.economy || '',
    drivetrain: row.drivetrain || '',
    engine: row.engine || '',
    power: row.power || '',
    topSpeed: row.top_speed || '',
    zeroToSixty: row.zero_to_sixty || '',
    color: row.color || '',
    mileage: row.mileage || '',
    location: row.location,
    image: row.image_path || '',
    description: row.description || '',
    features: features || []
  };
}

/* This one listing feeds both the public site and the dashboard, so the
   registration number is opt-in: `toCar` never returns it, and only an
   authenticated admin asks for it to be added back. A plate must not
   reach an anonymous visitor. */
async function listVehicles({ includeRegistration = false, includeHidden = false } = {}) {
  const where = includeHidden
    ? 'is_active = 1'
    : 'is_active = 1 AND is_visible = 1';
  const [rows] = await pool.query(
    `SELECT * FROM vehicles WHERE ${where} ORDER BY listing_type, model_year DESC, name`
  );
  const [feats] = await pool.query(
    'SELECT vehicle_id, feature FROM vehicle_features ORDER BY id'
  );

  const byVehicle = new Map();
  for (const f of feats) {
    if (!byVehicle.has(f.vehicle_id)) byVehicle.set(f.vehicle_id, []);
    byVehicle.get(f.vehicle_id).push(f.feature);
  }
  return rows.map(r => {
    const car = toCar(r, byVehicle.get(r.id));
    if (includeRegistration) car.registration = r.registration || '';
    car.isVisible = Boolean(r.is_visible);
    return car;
  });
}

const VEHICLE_COLS = [
  ['name', 'name'], ['trim', 'trim_level'], ['year', 'model_year'],
  ['type', 'listing_type'], ['price', 'price'],
  ['monthlyRate', 'monthly_rate'], ['odometer', 'odometer_miles'],
  ['body', 'body'],
  ['seats', 'seats'], ['doors', 'doors'], ['location', 'location'],
  ['image', 'image_path'], ['transmission', 'transmission'],
  ['fuel', 'fuel'], ['color', 'color'], ['mileage', 'mileage'],
  ['registration', 'registration'],
  ['description', 'description']
];

/* Plates are stored uppercase with single spaces, so the same car reads
   the same however it was entered. The dashboard tidies input too, but
   the API is reachable without it, and inconsistent plates would be
   worse than none. */
function cleanRegistration(value) {
  const reg = String(value == null ? '' : value)
    .toUpperCase().replace(/\s+/g, ' ').trim().slice(0, 16);
  return /^[A-Z0-9 ]*$/.test(reg) ? reg : '';
}

async function createVehicle(body) {
  const cols = [], marks = [], vals = [];
  for (const [key, col] of VEHICLE_COLS) {
    if (body[key] === undefined) continue;
    cols.push(col); marks.push('?');
    vals.push(key === 'registration' ? cleanRegistration(body[key]) : body[key]);
  }
  cols.push('slug'); marks.push('?'); vals.push(body.id);

  const [res] = await pool.query(
    `INSERT INTO vehicles (${cols.join(',')}) VALUES (${marks.join(',')})`, vals
  );
  await replaceFeatures(res.insertId, body.features);
  return body.id;
}

async function updateVehicle(slug, body) {
  const sets = [], vals = [];
  for (const [key, col] of VEHICLE_COLS) {
    if (body[key] === undefined) continue;
    sets.push(`${col} = ?`);
    vals.push(key === 'registration' ? cleanRegistration(body[key]) : body[key]);
  }
  if (!sets.length) return false;
  vals.push(slug);

  const [res] = await pool.query(
    `UPDATE vehicles SET ${sets.join(', ')} WHERE slug = ?`, vals
  );
  if (Array.isArray(body.features)) {
    const [[row]] = await pool.query('SELECT id FROM vehicles WHERE slug = ?', [slug]);
    if (row) await replaceFeatures(row.id, body.features);
  }
  return res.affectedRows > 0;
}

async function replaceFeatures(vehicleId, features) {
  if (!Array.isArray(features)) return;
  await pool.query('DELETE FROM vehicle_features WHERE vehicle_id = ?', [vehicleId]);
  if (!features.length) return;
  await pool.query(
    'INSERT IGNORE INTO vehicle_features (vehicle_id, feature) VALUES ?',
    [features.map(f => [vehicleId, f])]
  );
}

async function deleteVehicle(slug) {
  /* A vehicle with bookings against it must not vanish — the FK is
     RESTRICT, so soft-delete instead of failing the request. */
  const [[row]] = await pool.query('SELECT id FROM vehicles WHERE slug = ?', [slug]);
  if (!row) return { ok: false, reason: 'not found' };

  const [[{ n }]] = await pool.query(
    'SELECT COUNT(*) AS n FROM bookings WHERE vehicle_id = ?', [row.id]
  );
  if (n > 0) {
    await pool.query('UPDATE vehicles SET is_active = 0 WHERE id = ?', [row.id]);
    return { ok: true, archived: true, bookings: n };
  }
  await pool.query('DELETE FROM vehicles WHERE id = ?', [row.id]);
  return { ok: true, archived: false };
}

/* ----------------------------- bookings --------------------------- */

async function listBookings() {
  const [rows] = await pool.query(`
    SELECT b.id AS _bookingId, b.reference AS id, c.full_name AS name, c.email, c.phone,
           c.license_number AS licenseNumber,
           v.slug AS carId, v.registration AS vehicleRegistration,
           b.starts_on AS \`from\`, b.ends_on AS \`to\`,
           b.status, b.total, b.toll_charges, b.toll_notes,
           b.advance_amount, b.booking_deposit, b.pending_amount, b.open_return,
           b.billing_breakdown, b.monthly_rate, b.confirmation_sent,
           b.payment_method,
           /* What the customer has demonstrably paid: only proofs an
              admin has verified count, so a misread screenshot can
              never make a booking look settled on its own. */
           (SELECT COALESCE(SUM(p.amount), 0) FROM payment_proofs p
             WHERE p.booking_id = b.id AND p.verified_at IS NOT NULL) AS verified_paid,
           (SELECT COALESCE(SUM(p.amount), 0) FROM payment_proofs p
             WHERE p.booking_id = b.id AND p.verified_at IS NOT NULL
               AND p.method = 'cash') AS paid_cash,
           (SELECT COALESCE(SUM(p.amount), 0) FROM payment_proofs p
             WHERE p.booking_id = b.id AND p.verified_at IS NOT NULL
               AND p.method = 'online') AS paid_online,
           /* How many separate payments have been confirmed — a customer
              may settle in instalments, and one figure hides that. */
           (SELECT COUNT(*) FROM payment_proofs p
             WHERE p.booking_id = b.id AND p.verified_at IS NOT NULL) AS paid_count,
           (SELECT COALESCE(SUM(p.amount), 0) FROM payment_proofs p
             WHERE p.booking_id = b.id AND p.verified_at IS NOT NULL
               AND p.stage = 'prebooking') AS prebooking_settled,
           (SELECT COUNT(*) FROM payment_proofs p
             WHERE p.booking_id = b.id) AS proof_count,
           (SELECT COUNT(*) FROM payment_proofs p
             WHERE p.booking_id = b.id AND p.verified_at IS NULL) AS unverified_count,
           b.contract_sent_at, b.contract_signed_at, b.license_uploaded_at,
            b.return_notice_given_at, b.expected_return_on, b.pickup_location,
            v.released_for_prebooking_at,
           DATEDIFF(b.starts_on, CURDATE()) AS leadDays,
           DATE(b.created_at) AS created
      FROM bookings b
      JOIN customers c ON c.id = b.customer_id
      JOIN vehicles  v ON v.id = b.vehicle_id
     /* Newest first: a customer just onboarded is the one the office
        is working on, so it belongs at the top rather than buried by
        pick-up date. created_at is the moment the booking was taken;
        starts_on only says when the car goes out. */
     ORDER BY b.created_at DESC, b.id DESC`);

  const [photos] = await pool.query('SELECT booking_id, photo_type, stage, file_path FROM booking_photos');
  const photosByBooking = new Map();
  for (const p of photos) {
    if (!photosByBooking.has(p.booking_id)) photosByBooking.set(p.booking_id, {});
    const key = p.stage === 'return' ? 'return' : 'pickup';
    if (!photosByBooking.get(p.booking_id)[key]) photosByBooking.get(p.booking_id)[key] = {};
    photosByBooking.get(p.booking_id)[key][p.photo_type] = p.file_path;
  }

  return rows.map(r => ({
    ...r,
    email: r.email || '',
    phone: r.phone || '',
    licenseNumber: r.licenseNumber || '',
    vehicleRegistration: r.vehicleRegistration || '',
    returnNoticeGivenAt: r.return_notice_given_at || null,
    expectedReturnOn: r.expected_return_on || null,
    total: r.total === null ? null : Number(r.total),
    tolls: Number(r.toll_charges || 0),
    tollNotes: r.toll_notes || '',
    advance: Number(r.advance_amount || 0),
    /* What the customer paid online to reserve the car. Separate
       from the advance: this comes OFF the rent, the advance is
       owed on top and refunded at handback. */
    bookingDeposit: Number(r.booking_deposit || 0),
    pending: Number(r.pending_amount || 0),
    openReturn: Boolean(r.open_return),
    monthlyRate: r.monthly_rate === null ? null : Number(r.monthly_rate),
    breakdown: typeof r.billing_breakdown === 'string'
      ? JSON.parse(r.billing_breakdown) : (r.billing_breakdown || null),
    leadDays: r.leadDays,
    confirmationSent: Boolean(r.confirmation_sent),
    /* Set when the slot confirmation is sent, so the dashboard can
       show which bookings still need one. */
    pickupLocation: r.pickup_location || null,
    paymentMethod: r.payment_method || null,
    carReleased: Boolean(r.released_for_prebooking_at),
    verifiedPaid: Number(r.verified_paid || 0),
    paidCash: Number(r.paid_cash || 0),
    paidOnline: Number(r.paid_online || 0),
    paidCount: Number(r.paid_count || 0),
    prebookingPaid: Number(r.prebooking_settled || 0),
    proofCount: Number(r.proof_count || 0),
    unverifiedCount: Number(r.unverified_count || 0),
    contractSentAt: r.contract_sent_at,
    contractSignedAt: r.contract_signed_at,
    licenseUploadedAt: r.license_uploaded_at,
    photos: (photosByBooking.get(r._bookingId) || {}).pickup || {},
    returnPhotos: (photosByBooking.get(r._bookingId) || {}).return || {}
  }));
}

/* Customers are matched on email, then phone, then name — so editing a
   booking does not quietly create a duplicate person each time. */
async function findOrCreateCustomer(conn, { name, email, phone, license }) {
  const tries = [];
  if (email) tries.push(['email = ?', email]);
  if (phone) tries.push(['phone = ?', phone]);
  tries.push(['full_name = ?', name]);

  /* The rental booking form makes the driver license number mandatory,
     so it is stored with the customer. Only touched when a value is
     actually supplied — admin edits must not wipe it by omission. */
  const licenseVal = typeof license === 'string' && license.trim()
    ? license.trim().slice(0, 40) : null;
  const licenseSet = licenseVal ? ', license_number = ?' : '';

  for (const [where, val] of tries) {
    const [[hit]] = await conn.query(`SELECT id FROM customers WHERE ${where} LIMIT 1`, [val]);
    if (hit) {
      const args = [name, email || null, phone || null];
      if (licenseVal) args.push(licenseVal);
      args.push(hit.id);
      await conn.query(
        `UPDATE customers SET full_name = ?, email = COALESCE(?, email), phone = COALESCE(?, phone)${licenseSet} WHERE id = ?`,
        args
      );
      return hit.id;
    }
  }
  const fields = ['full_name', 'email', 'phone'];
  const vals = [name, email || null, phone || null];
  if (licenseVal) { fields.push('license_number'); vals.push(licenseVal); }
  const [res] = await conn.query(
    `INSERT INTO customers (${fields.join(', ')}) VALUES (${vals.map(() => '?').join(', ')})`,
    vals
  );
  return res.insertId;
}

async function getCustomerByEmail(email) {
  if (!email) return null;
  const [[row]] = await pool.query(
    `SELECT id, full_name, email, phone, license_number, created_at FROM customers WHERE email = ? LIMIT 1`,
    [email]
  );
  return row || null;
}

async function updateCustomer(email, { name, phone, licenseNumber }) {
  if (!email) throw Object.assign(new Error('Email required'), { status: 400 });
  const fields = [];
  const vals = [];
  if (name !== undefined) { fields.push('full_name = ?'); vals.push(name); }
  if (phone !== undefined) { fields.push('phone = ?'); vals.push(phone); }
  if (licenseNumber !== undefined) { fields.push('license_number = ?'); vals.push(licenseNumber || null); }
  if (fields.length === 0) return { affectedRows: 0 };
  vals.push(email);
  const [res] = await pool.query(
    `UPDATE customers SET ${fields.join(', ')} WHERE email = ?`,
    vals
  );
  return res;
}

async function nextReference(conn) {
  const [[row]] = await conn.query(
    "SELECT MAX(CAST(SUBSTRING(reference, 4) AS UNSIGNED)) AS n FROM bookings WHERE reference LIKE 'BK-%'"
  );
  return 'BK-' + (Math.max(1040, row.n || 0) + 1);
}

async function saveBooking(reference, body) {
  const conn = await pool.getConnection();
  try {
    /* customer + booking must land together or not at all */
    await conn.beginTransaction();

    const customerId = await findOrCreateCustomer(conn, body);
    const [[car]] = await conn.query(
      `SELECT id, price, monthly_rate, listing_type,
              released_for_prebooking_at, available_from
         FROM vehicles WHERE slug = ?`, [body.carId]
    );
    if (!car) throw Object.assign(new Error('Unknown vehicle'), { status: 400 });

    /* Is the car out with someone right now? */
    const [[onRent]] = await conn.query(
      `SELECT reference, COALESCE(expected_return_on, ends_on) AS back
         FROM bookings
        WHERE vehicle_id = ? AND status = 'Active'
          AND CURDATE() BETWEEN starts_on AND ends_on
        LIMIT 1`, [car.id]
    );

    /* A car in use is closed to everyone until the office releases it —
       that only happens once its renter has given return notice. Admin
       edits (which pass a reference) are not subject to this. */
    if (onRent && !reference && !car.released_for_prebooking_at) {
      throw Object.assign(new Error(
        'This car is currently on rent and not yet open for pre-booking. ' +
        'Please check back once it is released.'
      ), { status: 409 });
    }

    /* Once released, later customers queue behind the current rental —
       so the ACTIVE booking is not treated as a clash. Two pre-bookings
       that genuinely overlap each other still are. */
    const [clashes] = await conn.query(
      `SELECT reference FROM bookings
        WHERE vehicle_id = ? AND status NOT IN ('Cancelled','Completed')
          AND starts_on <= ? AND ends_on >= ?
          ${car.released_for_prebooking_at ? "AND status <> 'Active'" : ''}
          ${reference ? 'AND reference <> ?' : ''}
        LIMIT 1`,
      reference ? [car.id, body.to, body.from, reference] : [car.id, body.to, body.from]
    );
    if (clashes.length) {
      throw Object.assign(
        new Error(`Already pre-booked on those dates (${clashes[0].reference})`),
        { status: 409 }
      );
    }

    /* Cannot collect before the current renter brings it back. */
    if (!reference && car.available_from && body.from < car.available_from) {
      throw Object.assign(new Error(
        `This car is available from ${car.available_from}. Please choose a later pick-up date.`
      ), { status: 409 });
    }

    /* Rentals are sold by the month. A shorter stay is only allowed when
       the customer has explicitly asked for an open return, so enforce
       that here as well as in the browser — the form is not the only way
       a request can reach this endpoint. Admin edits (which carry a
       reference) are trusted to override. */
    const openReturn = Boolean(body.openReturn);

    /* A pick-up date in the past was only ever rejected in the browser,
       so any request that skipped the form — a stale tab, a retried
       submission, anything hitting the API directly — created a booking
       dated years ago. The form is not the only way in, so the rule has
       to live here too. Admin edits carry a reference and may legitimately
       correct historic records, so they are exempt. */
    if (!reference) {
      /* Applies to a sale as much as a rental: no listing should accept
         a date years in the past, or a return before the pick-up. Only
         the monthly-term rule below is rental-specific. */
      const notice = billing.noticeCheck(body.from);
      if (!notice.ok) {
        throw Object.assign(new Error(
          notice.message || 'That pick-up date has already passed.'
        ), { status: 400 });
      }
      if (body.to < body.from) {
        throw Object.assign(new Error(
          'The return date cannot be before the pick-up date.'
        ), { status: 400 });
      }
    }

    /* How far ahead a customer may book. Enforced here as well as on
       the form, because the form can be bypassed — a crafted request
       could otherwise hold a car months out.

       Only on NEW customer bookings: editing an existing one must not
       fail because its date has since drifted outside the window, and
       the office books by hand for dates the public cannot reach. */
    if (!reference && car.listing_type !== 'sale' && !body.byAdmin) {
      const notice = billing.noticeCheck(body.from);
      if (!notice.ok) {
        throw Object.assign(new Error(notice.message), { status: 400 });
      }
    }

    if (!reference && car.listing_type !== 'sale') {
      const term = billing.meetsMinimumTerm(body.from, body.to, openReturn);
      if (!term.ok) {
        throw Object.assign(new Error(
          'Rentals run for a minimum of 1 month. '
          + 'Choose a return date at least 30 days from pick-up, or tick "open return".'
        ), { status: 400 });
      }
    }

    /* One billing engine for the quote and for what is stored. */
    const q = billing.quote({
      startsOn: body.from,
      endsOn: body.to,
      monthlyRate: car.monthly_rate,
      dayRate: car.price,
      listingType: car.listing_type,
      tolls: body.tolls,
      advance: body.advance
    });
    const total = q.subtotal;
    const tolls = q.tolls;
    const advance = q.advance;
    /* What the customer still owes from earlier months. Kept as given —
       the office decides the figure; nothing here derives it. */
    const pending = Math.max(0, Number(body.pending) || 0);
    const breakdown = JSON.stringify(q.lines);

    let ref = reference;
    if (ref) {
      const [res] = await conn.query(
        `UPDATE bookings SET customer_id = ?, vehicle_id = ?, starts_on = ?,
                ends_on = ?, status = ?, day_rate = ?, monthly_rate = ?,
                total = ?, toll_charges = ?, toll_notes = ?,
                advance_amount = ?, pending_amount = ?, open_return = ?,
                billing_breakdown = ?
           WHERE reference = ?`,
        [customerId, car.id, body.from, body.to, body.status, car.price,
         car.monthly_rate, total, tolls, body.tollNotes || null,
         advance, pending, openReturn ? 1 : 0, breakdown, ref]
      );
      if (!res.affectedRows) throw Object.assign(new Error('Unknown booking'), { status: 404 });
    } else {
      ref = await nextReference(conn);
      await conn.query(
        `INSERT INTO bookings (reference, customer_id, vehicle_id, starts_on,
                               ends_on, status, day_rate, monthly_rate,
                               total, toll_charges, toll_notes,
                               advance_amount, pending_amount, open_return,
                               billing_breakdown)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ref, customerId, car.id, body.from, body.to, body.status || 'Prebooked',
         car.price, car.monthly_rate, total, tolls, body.tollNotes || null,
         advance, pending, openReturn ? 1 : 0, breakdown]
      );
    }

    await conn.commit();

    /* Cancelling from the dashboard frees the car the same way
       rejecting does, so a cancelled booking never leaves a vehicle
       reserved against nothing. After the commit — the status must be
       durable before the fleet is told the car is spare. */
    if (String(body.status) === 'Cancelled') {
      try {
        const [[row]] = await pool.query(
          'SELECT id, vehicle_id FROM bookings WHERE reference = ?', [ref]);
        if (row) await freeVehicleIfUnheld(row.vehicle_id, row.id);
      } catch (err) {
        console.error('freeing vehicle after cancel failed:', err.message);
      }
    }

    /* Tell both sides a request has landed. After the commit, so a
       notification problem can never lose the booking itself. */
    if (!reference) {
      try {
        const [[row]] = await pool.query(
          `SELECT b.id, b.customer_id, b.starts_on, b.ends_on, b.status,
                  c.full_name, v.name AS vehicle_name, v.model_year
             FROM bookings b
             JOIN customers c ON c.id = b.customer_id
             JOIN vehicles  v ON v.id = b.vehicle_id
            WHERE b.reference = ?`, [ref]
        );
        if (row) {
          const car = `${row.model_year || ''} ${row.vehicle_name || ''}`.trim();
          await notifyBoth(row.customer_id, row.id, 'booking_requested',
            {
              title: 'Booking request sent',
              body: `Your request for the ${car} (${ref}), `
                  + `${row.starts_on} to ${row.ends_on} has been received `
                  + `and is awaiting confirmation.`,
              link: `bookings.html?ref=${encodeURIComponent(ref)}`
            },
            {
              title: `New booking request ${ref}`,
              body: `${row.full_name || 'A customer'} — ${car}, ${row.starts_on} to ${row.ends_on}.`,
              link: 'admin.html#actions'
            }
          );
        }
      } catch (err) {
        console.error('booking notification failed:', err.message);
      }
    }
    return ref;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/* Admin releasing a pre-booked car for the customer to collect. */
async function releaseBooking(reference) {
  const [res] = await pool.query(
    `UPDATE bookings SET status = 'Confirmed', released_at = NOW()
      WHERE reference = ? AND status = 'Prebooked'`, [reference]
  );
  return res.affectedRows > 0;
}

/* The handover: the customer has collected the car.

   This is the tick in the Actions tab, and it is what moves a booking
   into Bookings — Confirmed means "slot is yours, here is where to
   collect", Active means "the car is out". The pick-up photos should
   be in by now; the count is reported rather than enforced, because a
   handover happens at a counter and a stalled upload must not block
   the office. */
async function handoverBooking(reference) {
  const ref = safeRef(reference);
  const [[booking]] = await pool.query(
    `SELECT b.id, b.status, b.customer_id, b.reference,
            c.full_name,
            v.name AS vehicle_name, v.model_year,
            (SELECT COUNT(*) FROM booking_photos p
              WHERE p.booking_id = b.id AND p.stage = 'pickup') AS pickup_photos
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       JOIN vehicles  v ON v.id = b.vehicle_id
      WHERE b.reference = ?`, [ref]
  );
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });

  if (booking.status !== 'Confirmed') {
    throw Object.assign(
      new Error(booking.status === 'Prebooked'
        ? `${ref} has not been confirmed yet — send the slot confirmation first`
        : `${ref} is ${String(booking.status).toLowerCase()}`),
      { status: 409 }
    );
  }

  await pool.query(
    "UPDATE bookings SET status = 'Active', released_at = COALESCE(released_at, NOW()) WHERE id = ?",
    [booking.id]
  );

  const car = `${booking.model_year || ''} ${booking.vehicle_name || ''}`.trim();
  await notifyBoth(booking.customer_id, booking.id, 'approved',
    {
      title: 'Your rental has started',
      body: `${car} (${ref}) is now with you. Add any damage you find, and `
          + `remember the return photos when you bring it back.`,
      link: 'bookings.html'
    },
    {
      title: `${ref} handed over`,
      body: `${booking.full_name || 'Customer'} — ${car}. `
          + `${booking.pickup_photos} of 5 pick-up photos on file.`,
      link: 'admin.html#bookings'
    }
  );

  return { reference: ref, status: 'Active',
           pickupPhotos: Number(booking.pickup_photos) };
}

/* Cars with a pre-booking the admin has not released yet. */
async function upcomingReleases() {
  const [rows] = await pool.query('SELECT * FROM vw_upcoming_releases');
  return rows;
}

/* Price a booking without saving it — used by the reserve form. */
async function quoteBooking({ carId, from, to, tolls, advance, openReturn,
                              includeAdvance = false }) {
  const [[car]] = await pool.query(
    'SELECT price, monthly_rate, listing_type FROM vehicles WHERE slug = ?', [carId]
  );
  if (!car) throw Object.assign(new Error('Unknown vehicle'), { status: 400 });
  const q = billing.quote({
    startsOn: from, endsOn: to, monthlyRate: car.monthly_rate,
    dayRate: car.price, listingType: car.listing_type, tolls, advance
  });
  /* The page shows the minimum-term warning before the customer submits,
     so the quote carries the verdict rather than the form recomputing it. */
  if (car.listing_type !== 'sale') {
    q.term = billing.meetsMinimumTerm(from, to, Boolean(openReturn));
  }

  /* The car page now quotes what is due at pickup — the first month's
     rent plus the refundable advance — so the advance has to reach the
     customer here rather than waiting for the invoice. What stays back
     is `grandTotal`: the whole term's rent plus advance is not what
     anyone pays on the day, and showing it as a total reads as the
     price of the booking. The dashboard asks for it explicitly. */
  if (!includeAdvance) {
    delete q.grandTotal;
  }
  return q;
}

async function setOdometer(slug, miles) {
  const [res] = await pool.query(
    'UPDATE vehicles SET odometer_miles = ?, odometer_updated = CURDATE() WHERE slug = ?',
    [miles, slug]
  );
  return res.affectedRows > 0;
}

async function toggleVehicleVisibility(idOrSlug) {
  /* The id column is INT UNSIGNED, so a non-numeric string (like a
     slug) must not reach it — MySQL would compare 'bmw-330i' against
     the integer column and silently round it to 0. Match on slug
     first; only try the numeric id when the value is actually a
     number. */
  const isNum = /^\d+$/.test(String(idOrSlug));
  const where = isNum
    ? '(slug = ? OR id = ?)'
    : 'slug = ?';
  const params = isNum ? [idOrSlug, idOrSlug] : [idOrSlug];

  const [res] = await pool.query(
    `UPDATE vehicles SET is_visible = NOT is_visible WHERE ${where}`, params
  );
  if (!res.affectedRows) return null;
  const [[row]] = await pool.query(
    `SELECT slug, is_visible FROM vehicles WHERE ${where}`, params
  );
  return row ? { slug: row.slug, isVisible: Boolean(row.is_visible) } : null;
}

async function deleteBooking(reference) {
  const [res] = await pool.query('DELETE FROM bookings WHERE reference = ?', [reference]);
  return res.affectedRows > 0;
}

/* "Under confirmation" — the office has picked this request up and is
   working on it. The customer is told so in the app straight away. */
/* Send the slot confirmation: the email that tells a customer their
   booking is confirmed, where to collect the car and what it costs.

   This is a step of its own, not a side effect of approval. Approving
   onboards a booking into the Bookings tab; the office then sets the
   pick-up point and sends this when it is ready. Sending it again
   later is fine — a customer who lost the email, or a changed
   collection point.

   Distinct from markConfirmationSent(), which sends a holding note
   ("under confirmation, we will be in touch") while a request is
   still being decided. */
async function sendSlotConfirmationEmail(bookingRef, pickupLocation = null) {
  const ref = safeRef(bookingRef);
  const [[booking]] = await pool.query(
    `SELECT b.id, b.reference, b.status, b.starts_on, b.ends_on,
            b.total, b.toll_charges, b.pickup_location, b.customer_id,
            b.advance_amount,
            /* What has actually been confirmed as received, so the
               email can show the deposit and what is left to pay. */
            COALESCE((SELECT SUM(p.amount) FROM payment_proofs p
                       WHERE p.booking_id = b.id
                         AND p.verified_at IS NOT NULL), 0) AS verified_paid,
            c.full_name, c.email,
            v.name AS vehicle_name, v.model_year
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       JOIN vehicles  v ON v.id = b.vehicle_id
      WHERE b.reference = ?`, [ref]
  );
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });

  /* This is the step that CONFIRMS a booking: it tells the customer
     the slot is theirs and where to collect, so the booking becomes
     Confirmed at the same moment. That opens their photo uploads,
     which they need before collection.

     It stays in the Actions tab until the car is actually handed
     over — the tick does that, and moves it into Bookings. */
  if (['Completed', 'Cancelled'].includes(String(booking.status))) {
    throw Object.assign(
      new Error(`${ref} is ${String(booking.status).toLowerCase()}`),
      { status: 409 }
    );
  }
  if (!booking.email) {
    throw Object.assign(new Error('That customer has no email address on file'),
                        { status: 400 });
  }

  const place = String(pickupLocation || '').trim().slice(0, 255);
  if (place && place !== booking.pickup_location) {
    await pool.query('UPDATE bookings SET pickup_location = ? WHERE id = ?',
                     [place, booking.id]);
    booking.pickup_location = place;
  }

  /* Promote it as the confirmation goes out — the two belong together:
     a customer told their slot is confirmed should find it confirmed. */
  if (booking.status === 'Prebooked') {
    await pool.query('UPDATE bookings SET status = ? WHERE id = ?',
                     ['Confirmed', booking.id]);
    booking.status = 'Confirmed';
  }

  const appUrl = env.APP_URL || 'http://localhost:5500';
  const mail = slotBookedEmail(booking, appUrl);
  await sendEmail({ to: booking.email, subject: mail.subject, html: mail.html });

  const car = `${booking.model_year || ''} ${booking.vehicle_name || ''}`.trim();
  await notifyBoth(booking.customer_id, booking.id, 'approved',
    {
      title: 'Your slot is confirmed',
      body: `${car} (${ref}) — pick-up ${booking.starts_on}.`
          + (booking.pickup_location ? ` Collect from ${booking.pickup_location}.` : ''),
      link: 'bookings.html'
    },
    {
      title: `${ref} slot confirmation sent`,
      body: `${booking.full_name || 'Customer'} — ${car}.`,
      link: 'admin.html#bookings'
    }
  );

  return { reference: ref, emailSent: true, status: booking.status,
           pickupLocation: booking.pickup_location || null };
}

async function markConfirmationSent(reference) {
  const [res] = await pool.query(
    'UPDATE bookings SET confirmation_sent = 1 WHERE reference = ?', [reference]
  );
  if (!res.affectedRows) return false;

  const [[b]] = await pool.query(
    `SELECT b.id, b.reference, b.starts_on, b.ends_on, b.customer_id,
            c.full_name, c.email, v.name AS vehicle_name, v.model_year
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       JOIN vehicles  v ON v.id = b.vehicle_id
      WHERE b.reference = ?`, [reference]
  );
  if (b) {
    const car = `${b.model_year || ''} ${b.vehicle_name || ''}`.trim();
    await notifyBoth(b.customer_id, b.id, 'under_confirmation',
      {
        title: 'Your booking is under confirmation',
        body: `We are reviewing your request for the ${car} (${b.reference}). `
            + `We will confirm shortly.`,
        link: `bookings.html?ref=${encodeURIComponent(b.reference)}`
      },
      {
        title: `${b.reference} marked under confirmation`,
        body: `${b.full_name || 'A customer'} — ${car}, ${b.starts_on} to ${b.ends_on}.`,
        link: 'admin.html#bookings'
      }
    );

    /* Email too, when the office's mailbox is working. */
    if (b.email) {
      try {
        await sendEmail({
          to: b.email,
          subject: `Your booking is under confirmation - ${b.reference}`,
          html: `<p>Hello ${escapeHtml(b.full_name || '')},</p>
                 <p>Your booking <strong>${escapeHtml(b.reference)}</strong> for the
                    <strong>${escapeHtml(car)}</strong> is now
                    <strong>under confirmation</strong>.</p>
                 <p>Pick-up ${escapeHtml(b.starts_on)} &middot; return ${escapeHtml(b.ends_on)}.</p>
                 <p>We will be in touch as soon as it is confirmed.</p>`
        });
      } catch (err) {
        console.error(`Under-confirmation email failed for ${reference}:`, err.message);
      }
    }
  }
  return true;
}

/* ---------------------------- enquiries --------------------------- */

/* Anything outside the enum would be rejected by MySQL and the enquiry
   lost, so an unknown kind falls back to 'general' rather than failing. */
const ENQUIRY_KINDS = ['consultation', 'sell', 'general', 'viewing'];

async function createEnquiry(body) {
  const kind = ENQUIRY_KINDS.includes(body.kind) ? body.kind : 'general';
  const [res] = await pool.query(
    `INSERT INTO enquiries (kind, full_name, email, phone, message,
                            car_make, car_year, car_miles, zip_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [kind, body.name, body.email || null, body.phone || null,
     body.message || null, body.carMake || null, body.carYear || null,
     body.carMiles || null, body.zip || null]
  );
  return res.insertId;
}

/* Every enquiry, newest first, for the dashboard.

   Writing them was only ever half the job: they went into this table
   and nothing read them back, so a customer asking to view a car for
   sale was told "we will be in touch" and no one in the office could
   see the request. Outstanding ones sort above handled ones so the
   list opens on what still needs a reply. */
async function listEnquiries({ kind = null, limit = 300 } = {}) {
  const where = kind ? 'WHERE kind = ?' : '';
  const args = kind ? [kind] : [];
  const [rows] = await pool.query(
    `SELECT id, kind, full_name AS name, email, phone, message,
            car_make AS carMake, car_year AS carYear, car_miles AS carMiles,
            zip_code AS zip, handled, created_at AS createdAt
       FROM enquiries ${where}
      ORDER BY handled ASC, created_at DESC
      LIMIT ?`,
    [...args, Number(limit) || 300]
  );
  return rows.map(r => ({ ...r, handled: !!r.handled }));
}

/* Marks one enquiry dealt with, or puts it back on the list. */
async function setEnquiryHandled(id, handled) {
  const [res] = await pool.query(
    'UPDATE enquiries SET handled = ? WHERE id = ?',
    [handled ? 1 : 0, Number(id)]
  );
  if (!res.affectedRows) {
    const err = new Error('That enquiry was not found');
    err.status = 404;
    throw err;
  }
  return { id: Number(id), handled: !!handled };
}

/* How many are still waiting, for the badge on the tab. */
async function unhandledEnquiryCount() {
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS n FROM enquiries WHERE handled = 0');
  return row.n;
}

async function ping() {
  const [[row]] = await pool.query('SELECT VERSION() AS v');
  return row.v;
}

/* ---------------------------- email service ------------------------- */

let transporter = null;

/* Google shows an App Password as "abcd efgh ijkl mnop". Pasting it with
   the spaces is the single most common reason SMTP auth fails, so strip
   them rather than making the user notice. */
function mailPassword() {
  return String(env.EMAIL_PASSWORD || '').replace(/\s+/g, '');
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.EMAIL_HOST || 'smtp.gmail.com',
      port: Number(env.EMAIL_PORT || 587),
      secure: Number(env.EMAIL_PORT || 587) === 465,
      auth: {
        user: env.EMAIL_USER,
        pass: mailPassword()
      }
    });
  }
  return transporter;
}

async function sendEmail({ to, subject, html, attachments = [] }) {
  const tx = getTransporter();
  /* Always from the business mailbox — Gmail rejects a From it does not
     own, so this must match EMAIL_USER. */
  const from = env.EMAIL_FROM || `Reddy Finances <${env.EMAIL_USER}>`;
  try {
    return await tx.sendMail({ from, to, subject, html, attachments });
  } catch (err) {
    if (err.code === 'EAUTH') {
      throw Object.assign(new Error(
        'Email is not set up: Gmail rejected the login. EMAIL_PASSWORD must be a '
        + '16-character Google App Password, not the account password. '
        + 'Create one at https://myaccount.google.com/apppasswords, then run '
        + '"node server/mailtest.js" to check it.'
      ), { status: 503, code: 'EAUTH' });
    }
    throw err;
  }
}

/* Ask the SMTP server whether our credentials work, without sending
   anything. Used at start-up and by `node server/mailtest.js`. */
async function verifyEmail() {
  const pass = mailPassword();
  if (!env.EMAIL_USER || !pass) {
    return { ok: false, reason: 'EMAIL_USER or EMAIL_PASSWORD is not set in .env' };
  }
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (err) {
    /* Gmail's own hint: an App Password is 16 letters. A longer secret
       here is nearly always the account password, which Google refuses
       over SMTP however correct it is. */
    const looksLikeAccountPassword =
      /gmail/i.test(env.EMAIL_HOST || '') && pass.replace(/\s/g, '').length !== 16;
    return {
      ok: false,
      code: err.code || '',
      reason: String(err.response || err.message || '').split('\n')[0],
      hint: looksLikeAccountPassword
        ? 'EMAIL_PASSWORD does not look like a Gmail App Password (those are exactly 16 letters). '
        + 'Create one at https://myaccount.google.com/apppasswords with 2-Step Verification on, '
        + 'and put that in .env instead of the account password.'
        : ''
    };
  }
}

/* --------------------------- PDF generation ------------------------- */

const fs = require('fs').promises;
/* The agreement is drawn from server/contract.js, which holds the
   clauses as text. No binary template to maintain, and the customer
   reads on screen exactly what the PDF will say. */
const { generateContractPdf, contractTerms } = require('./contract.js');

/* Which month a contract copy covers.

   The agreement renews monthly ("a monthly rental agreement with a
   one-month minimum"), so each copy carries one month's dates rather
   than the whole term: the first covers the opening segment, and once
   that month has passed the next copy carries the next month's dates.
   The segment covering TODAY is the one to send — before the term
   starts that is the first month, after it ends the last.

   Used by BOTH the unsigned send and the signed regeneration: if the
   signed copy were built without it, signing would silently revert the
   document to whole-term dates. */
function contractPeriod(booking) {
  let segs = [];
  try {
    segs = typeof booking.billing_breakdown === 'string'
      ? JSON.parse(booking.billing_breakdown)
      : (booking.billing_breakdown || []);
  } catch { segs = []; }
  if (!Array.isArray(segs) || !segs.length) return {};
  const today = new Date().toISOString().slice(0, 10);
  let seg = segs.find(s => today >= s.from && today <= s.to);
  if (!seg) seg = today < segs[0].from ? segs[0] : segs[segs.length - 1];
  return {
    period_label: seg.label || '',
    period_from: seg.from || '',
    period_to: seg.to || '',
    period_amount: seg.amount
  };
}
/* --------------------- document templates -------------------------- */

/* The rental agreement, versioned.

   Its wording used to live only in server/contract-terms.js, so a
   change meant editing source and redeploying — the office could not
   correct a clause themselves. These functions keep every version in
   the database instead: an edit inserts a new row, nothing is ever
   rewritten, and one version per document type is marked active so a
   contract sent without a choice uses the current wording.

   Past versions are kept because an agreement already sent has to stay
   readable exactly as it was sent. */

const TEMPLATE_TYPES = ['rental_agreement', 'sale_agreement'];

function safeTemplateType(t) {
  const v = String(t || 'rental_agreement');
  return TEMPLATE_TYPES.includes(v) ? v : 'rental_agreement';
}

/* The shape the PDF generator reads. Anything missing falls back to the
   file, so a half-filled template cannot produce a blank agreement. */
function normaliseTemplateBody(body) {
  const T = require('./contract-terms.js');
  const src = body && typeof body === 'object' ? body : {};
  const sections = Array.isArray(src.sections) && src.sections.length
    ? src.sections.map((s, i) => ({
        number: i + 1,
        heading: String(s && s.heading || '').slice(0, 200),
        paragraphs: (Array.isArray(s && s.paragraphs) ? s.paragraphs : [])
          .map(p => String(p == null ? '' : p)).filter(Boolean)
      }))
    : T.SECTIONS.map((s, i) => ({ number: i + 1, heading: s.heading,
                                  paragraphs: s.paragraphs }));
  /* The detail table at the head of the document.

     Only the LABELS are stored. Each row keeps the `key` the PDF looks
     up on the booking, so "DRIVER NAME" can be renamed or a row
     removed, while the value beside it is still filled per customer at
     send time. Nobody's data is kept in the template — a template is
     the blank form, not a filled-in copy. */
  const toCell = cell => {
    if (!cell) return null;
    /* Accept both shapes: {label,key} from the editor, and the
       [label,key] pair the PDF uses — a version saved before this,
       or one round-tripped through getDocumentTemplate, arrives as the
       pair and must not be silently dropped. */
    if (Array.isArray(cell)) {
      return cell[1] ? [String(cell[0] || '').slice(0, 60),
                        String(cell[1]).slice(0, 60)] : null;
    }
    return cell.key ? [String(cell.label || '').slice(0, 60),
                       String(cell.key).slice(0, 60)] : null;
  };

  const mapped = (Array.isArray(src.detailFields) ? src.detailFields : [])
    .map(row => (Array.isArray(row) ? row : []).slice(0, 2).map(toCell))
    .filter(row => row.some(Boolean))
    .map(row => [row[0] || null, row[1] || null]);

  /* Only fall back when nothing usable survived — an empty result here
     meant the PDF quietly reverted to the built-in labels even though
     the office had edited them. */
  const fields = mapped.length ? mapped : T.DETAIL_FIELDS;

  return {
    /* letterhead */
    company: String(src.company || T.COMPANY).slice(0, 120),
    tagline: String(src.tagline ?? T.COMPANY_TAGLINE).slice(0, 160),
    title: String(src.title || T.TITLE).slice(0, 200),
    intro: String(src.intro || T.INTRO),
    detailFields: fields,
    sections,
    acknowledgement: String(src.acknowledgement || T.ACKNOWLEDGEMENT),
    footer: String(src.footer ?? T.FOOTER).slice(0, 300)
  };
}

/* Every version, newest first — which is the order the office reads
   them in: the current wording is what they are usually after. */
async function listDocumentTemplates(documentType = 'rental_agreement') {
  const type = safeTemplateType(documentType);
  const [rows] = await pool.query(
    `SELECT id, document_type, version, note, source_file, is_active,
            created_by, created_at
       FROM document_templates
      WHERE document_type = ?
      ORDER BY version DESC`, [type]
  );
  return rows.map(r => ({
    id: r.id,
    documentType: r.document_type,
    version: r.version,
    note: r.note || '',
    fromUpload: Boolean(r.source_file),
    isActive: Boolean(r.is_active),
    createdBy: r.created_by || '',
    createdAt: r.created_at
  }));
}

/* One version in full, for the editor and for rendering. */
async function getDocumentTemplate(id) {
  const [[row]] = await pool.query(
    `SELECT id, document_type, version, body, note, source_file,
            is_active, created_by, created_at
       FROM document_templates WHERE id = ?`, [Number(id) || 0]
  );
  if (!row) return null;
  const body = typeof row.body === 'string' ? JSON.parse(row.body) : row.body;
  return {
    id: row.id,
    documentType: row.document_type,
    version: row.version,
    body: normaliseTemplateBody(body),
    note: row.note || '',
    fromUpload: Boolean(row.source_file),
    isActive: Boolean(row.is_active),
    createdBy: row.created_by || '',
    createdAt: row.created_at
  };
}

/* The version a contract is sent with unless the office picks another.

   Falls back to the wording in contract-terms.js when nothing has been
   saved yet, so the agreement works on a fresh install exactly as it
   did before any of this existed. */
async function activeDocumentTemplate(documentType = 'rental_agreement') {
  const type = safeTemplateType(documentType);
  const [[row]] = await pool.query(
    `SELECT id FROM document_templates
      WHERE document_type = ? AND is_active = 1
      ORDER BY version DESC LIMIT 1`, [type]
  );
  if (row) return getDocumentTemplate(row.id);

  const T = require('./contract-terms.js');
  return {
    id: null,
    documentType: type,
    version: 0,
    body: normaliseTemplateBody(null),
    note: 'Built-in wording — no edited version saved yet',
    fromUpload: false,
    isActive: true,
    createdBy: '',
    createdAt: null
  };
}

/* Saves an edit as a NEW version and makes it the active one.

   Never updates an existing row: a version that has already gone to a
   customer must keep saying what it said when it was sent. */
async function saveDocumentTemplate({ documentType = 'rental_agreement',
                                      body, note = '', sourceFile = null,
                                      createdBy = '', activate = true } = {}) {
  const type = safeTemplateType(documentType);
  const clean = normaliseTemplateBody(body);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[last]] = await conn.query(
      `SELECT COALESCE(MAX(version), 0) AS v
         FROM document_templates WHERE document_type = ? FOR UPDATE`, [type]
    );
    const version = Number(last.v) + 1;

    if (activate) {
      await conn.query(
        'UPDATE document_templates SET is_active = 0 WHERE document_type = ?',
        [type]
      );
    }

    const [res] = await conn.query(
      `INSERT INTO document_templates
         (document_type, version, body, note, source_file, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [type, version, JSON.stringify(clean),
       String(note || '').slice(0, 300) || null,
       sourceFile || null, activate ? 1 : 0,
       String(createdBy || '').slice(0, 190) || null]
    );
    await conn.commit();
    return { id: res.insertId, version, documentType: type };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/* Choose which saved version is sent by default. */
async function activateDocumentTemplate(id) {
  const tpl = await getDocumentTemplate(id);
  if (!tpl) throw Object.assign(new Error('That document version was not found'),
                                { status: 404 });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'UPDATE document_templates SET is_active = 0 WHERE document_type = ?',
      [tpl.documentType]
    );
    await conn.query(
      'UPDATE document_templates SET is_active = 1 WHERE id = ?', [tpl.id]
    );
    await conn.commit();
    return { id: tpl.id, version: tpl.version, documentType: tpl.documentType };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/* -------------------------- contract functions ---------------------- */

/* `signed` marks the copy that came back with a signature on it. The
   column existed but was never written, so a signed agreement and the
   blank one sent out beforehand looked identical in the table — and
   the dashboard had no way to show the office the executed copy. */
async function createContractDocument(bookingId, documentType, filePath, fileSize,
                                      signed = false) {
  const [res] = await pool.query(
    `INSERT INTO contract_documents
       (booking_id, document_type, file_path, file_size, sent_at, signed_at)
     VALUES (?, ?, ?, ?, NOW(), ?)`,
    [bookingId, documentType, filePath, fileSize, signed ? new Date() : null]
  );
  return res.insertId;
}

async function markContractSent(bookingId) {
  await pool.query(
    'UPDATE bookings SET contract_sent_at = NOW() WHERE id = ?',
    [bookingId]
  );
}

async function markContractSigned(bookingId) {
  await pool.query(
    'UPDATE bookings SET contract_signed_at = NOW() WHERE id = ?',
    [bookingId]
  );
  await pool.query(
    'UPDATE contract_documents SET signed_at = NOW() WHERE booking_id = ?',
    [bookingId]
  );
}

async function saveLicenseUpload(bookingId, filePath, fileName, fileSize, mimeType) {
  const [res] = await pool.query(
    `INSERT INTO license_uploads (booking_id, file_path, file_name, file_size, mime_type)
     VALUES (?, ?, ?, ?, ?)`,
    [bookingId, filePath, fileName, fileSize, mimeType]
  );
  await pool.query(
    'UPDATE bookings SET license_uploaded_at = NOW() WHERE id = ?',
    [bookingId]
  );
  return res.insertId;
}

async function getContractByBooking(bookingId) {
  const [[doc]] = await pool.query(
    'SELECT * FROM contract_documents WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1',
    [bookingId]
  );
  return doc;
}

async function getLicenseByBooking(bookingId) {
  const [[doc]] = await pool.query(
    'SELECT * FROM license_uploads WHERE booking_id = ? ORDER BY uploaded_at DESC LIMIT 1',
    [bookingId]
  );
  return doc;
}

/* `templateId` names the saved version to send. Omitting it uses the
   active one, which is what the dashboard sends unless the office
   picks a different version from the list. */
async function sendContractEmail(bookingRef, templateId = null) {
  const [[booking]] = await pool.query(
    `SELECT b.*, c.full_name, c.email, c.phone, c.license_number,
            v.slug, v.name AS vehicle_name, v.model_year, v.trim_level,
            v.color, v.odometer_miles, v.monthly_rate AS vehicle_monthly_rate,
            v.price, v.listing_type
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN vehicles v ON v.id = b.vehicle_id
     WHERE b.reference = ?`,
    [bookingRef]
  );

  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });
  if (!booking.email) throw Object.assign(new Error('Customer has no email address'), { status: 400 });

  const period = contractPeriod(booking);

  /* The wording to send: the version the office chose, or the active
     one. activeDocumentTemplate() falls back to contract-terms.js when
     nothing has been saved, so this works on a fresh install. */
  const template = templateId
    ? await getDocumentTemplate(templateId)
    : await activeDocumentTemplate('rental_agreement');
  if (templateId && !template) {
    throw Object.assign(new Error('That document version was not found'),
                        { status: 404 });
  }

  /* Unsigned copy — the customer signs it on the sign page, and that
     submission regenerates the PDF with their signature stamped in. */
  const pdfBuffer = await generateContractPdf({
    ...booking,
    ...period,
    monthly_rate: booking.monthly_rate || booking.vehicle_monthly_rate
  }, null, template && template.body);

  /* Remember which wording this customer received, so a contract sent
     months ago can still be traced to the version it carried. */
  if (template && template.id) {
    await pool.query('UPDATE bookings SET contract_template_id = ? WHERE id = ?',
                     [template.id, booking.id]);
  }

  // Save contract document record
  const fileName = `contract-${bookingRef}.pdf`;
  const filePath = path.join(__dirname, '..', 'uploads', 'contracts', fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, pdfBuffer);

  await createContractDocument(booking.id, 'rental_agreement', filePath, pdfBuffer.length);
  await markContractSent(booking.id);

  let emailSent = false;
  let emailError = null;

  try {
    const subject = `Your Rental Agreement - ${bookingRef} - Reddy Finances`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a2e;">Rental Agreement - ${escapeHtml(bookingRef)}</h2>
        <p>Dear ${escapeHtml(booking.full_name)},</p>
        <p>Please find attached your rental agreement for the <strong>${escapeHtml(`${booking.model_year || ''} ${booking.vehicle_name || ''} ${booking.trim_level || ''}`.trim())}</strong>.</p>
        <p><strong>Rental Period:</strong> ${escapeHtml(booking.starts_on)} to ${escapeHtml(booking.ends_on)}</p>
        <p><strong>Monthly Rate:</strong> $${Number(booking.monthly_rate || booking.vehicle_monthly_rate || Math.round((booking.price || 0) * 26)).toLocaleString()}</p>
        <p>You can sign the agreement online &mdash; draw or type your signature, no printer needed &mdash;
           and upload your driver's license at the same time:</p>
        <p style="text-align: center; margin: 30px 0;">
          <a href="${env.APP_URL || 'http://localhost:5500'}/sign-contract.html?ref=${bookingRef}"
             style="background: #c0392b; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">
            Sign the agreement online
          </a>
        </p>
        <p style="color: #666;">Or copy this link: ${env.APP_URL || 'http://localhost:5500'}/sign-contract.html?ref=${bookingRef}</p>
        <p>If you have any questions, please contact us.</p>
        <hr style="margin: 30px 0; border-color: #eee;">
        <p style="font-size: 12px; color: #999;">Reddy Finances &mdash; Dallas, TX</p>
      </div>
    `;

    await sendEmail({
      to: booking.email,
      subject,
      html,
      attachments: [
        {
          filename: fileName,
          content: pdfBuffer,
          contentType: 'application/pdf'
        }
      ]
    });
    emailSent = true;
  } catch (err) {
    emailError = err.message;
    console.error(`Email send failed for ${bookingRef}:`, err.message);
  }

  return {
    success: true,
    contractPath: filePath,
    contractUrl: `/api/contracts/preview?ref=${bookingRef}`,
    signUrl: `/sign-contract.html?ref=${bookingRef}`,
    emailSent,
    emailError: emailSent ? null : emailError
  };
}

/* Who owns this booking? Used by the route guards to keep one customer
   out of another's documents. Returns null when the booking is unknown. */
async function bookingOwnerEmail(reference) {
  const [[row]] = await pool.query(
    `SELECT c.email
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
      WHERE b.reference = ?`, [reference]
  );
  return row ? (row.email || '') : null;
}

/* ------------------------- upload safety -------------------------- */

/* The extension decides how the static server later serves the file, so
   it must never come from the client: a name like "x.html" would write a
   servable HTML file into the site root and give stored XSS on our own
   origin. Derive it from the declared MIME type against a fixed map and
   reject anything not on it. */
const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif'
};
const DOC_TYPES = { ...IMAGE_TYPES, 'application/pdf': '.pdf' };

function safeExt(file, allowed, label) {
  const mime = String(file.mimetype || '').toLowerCase().split(';')[0].trim();
  const ext = allowed[mime];
  if (!ext) {
    throw Object.assign(
      new Error(`Unsupported ${label} format. Allowed: ${[...new Set(Object.values(allowed))].join(', ')}`),
      { status: 400 }
    );
  }
  return ext;
}

/* A reference reaches a filename, so keep it to the shape references
   actually have — no separators, no dots, nothing that walks a path. */
function safeRef(ref) {
  const clean = String(ref || '').trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(clean)) {
    throw Object.assign(new Error('Invalid booking reference'), { status: 400 });
  }
  return clean;
}

async function handleContractUpload(bookingRef, contractFile, licenseFile) {
  const ref = safeRef(bookingRef);
  const [[booking]] = await pool.query('SELECT id FROM bookings WHERE reference = ?', [ref]);
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });

  const results = {};

  if (contractFile) {
    /* A signed contract is always a PDF — validate rather than assume, so
       a mislabelled upload fails loudly instead of landing as a .pdf. */
    safeExt(contractFile, { 'application/pdf': '.pdf' }, 'contract');
    const fileName = `signed-contract-${ref}-${Date.now()}.pdf`;
    const filePath = path.join(__dirname, '..', 'uploads', 'contracts', fileName);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contractFile.buffer);
    await createContractDocument(booking.id, 'rental_agreement', filePath, contractFile.size);
    await markContractSigned(booking.id);
    results.contract = filePath;
  }

  if (licenseFile) {
    const ext = safeExt(licenseFile, DOC_TYPES, 'license');
    const fileName = `license-${ref}-${Date.now()}${ext}`;
    const filePath = path.join(__dirname, '..', 'uploads', 'licenses', fileName);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, licenseFile.buffer);
    await saveLicenseUpload(booking.id, filePath, fileName, licenseFile.size, licenseFile.mimetype);
    results.license = filePath;
  }

  // Notify admin (email failure is non-fatal)
  try {
    await sendEmail({
      to: env.EMAIL_USER,
      subject: `New Document Uploaded - ${ref}`,
      html: `
        <p>Customer uploaded documents for booking <strong>${escapeHtml(ref)}</strong>.</p>
        ${results.contract ? `<p>Signed contract received.</p>` : ''}
        ${results.license ? `<p>Driver license received.</p>` : ''}
      `
    });
  } catch (err) {
    console.error(`Admin notification email failed for ${bookingRef}:`, err.message);
  }

  return { success: true, ...results };
}

/* ----------------------------- invoices --------------------------- */

const { invoiceHtml, invoicePdf, tollInvoiceHtml, tollModel } = require('./invoice.js');
const { slotBookedEmail, slotRejectedEmail } = require('./emails.js');

/* Build the invoice for a booking and email it to the customer. The
   figures come from the database, never from the browser. */
/* Email the toll statement on its own.

   Tolls are billed separately from rent: the rental invoice is raised
   when the car is collected, before any toll exists, and the operator's
   sheet only arrives afterwards. This sends just the tolls currently
   recorded against the booking, for the period given.

   It refuses to send nothing — a statement for $0 only confuses the
   customer and makes the real ones easier to ignore. */
async function sendTollInvoice(bookingRef, { period = null, amount: newAmount = null, notes = null } = {}) {
  const ref = safeRef(bookingRef);

  /* A corrected amount is written to the booking before the statement
     is built, so the Tolls column and the customer's copy stay the
     same figure. */
  if (newAmount !== null && newAmount !== undefined && newAmount !== '') {
    const n = Number(newAmount);
    if (!Number.isFinite(n) || n < 0) {
      throw Object.assign(new Error('Enter a valid toll amount'), { status: 400 });
    }
    await pool.query('UPDATE bookings SET toll_charges = ? WHERE reference = ?', [round2(n), ref]);
  }
  if (typeof notes === 'string') {
    await pool.query('UPDATE bookings SET toll_notes = ? WHERE reference = ?',
                     [notes.slice(0, 500) || null, ref]);
  }

  const [[booking]] = await pool.query(
    `SELECT b.reference, b.toll_charges, b.toll_notes,
            c.full_name, c.email, c.phone,
            v.name AS vehicle_name, v.model_year, v.trim_level,
            v.registration
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       JOIN vehicles  v ON v.id = b.vehicle_id
      WHERE b.reference = ?`, [ref]
  );
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });
  if (!booking.email) {
    throw Object.assign(new Error('This customer has no email address'), { status: 400 });
  }
  const amount = Number(booking.toll_charges || 0);
  if (!(amount > 0)) {
    throw Object.assign(new Error('No tolls are recorded on this booking'), { status: 400 });
  }

  /* Default to the month just gone: the statement normally goes out on
     the 1st and covers the previous month's crossings. */
  const when = period || (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 7);
  })();

  const model = tollModel(booking, { period: when });

  await sendEmail({
    to: booking.email,
    subject: `Toll statement ${model.number} - ${ref} - Reddy Finances`,
    html: tollInvoiceHtml(booking, { period: when })
  });

  return { sent: true, to: booking.email, number: model.number, amount, period: when };
}

async function sendInvoice(bookingRef, overrides = {}) {
  const ref = safeRef(bookingRef);

  /* The office can correct a figure in the invoice dialog before it
     goes out. Whatever they send is written to the booking first, so
     the row and the customer's copy can never disagree — an invoice
     that says one thing while the dashboard says another is worse than
     a wrong figure, because nobody can tell which is right. */
  const money = k => {
    const v = overrides[k];
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? round2(n) : undefined;
  };
  const patch = {
    toll_charges: money('tolls'),
    advance_amount: money('advance'),
    pending_amount: money('pending')
  };
  const sets = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (sets.length) {
    await pool.query(
      `UPDATE bookings SET ${sets.map(([k]) => `${k} = ?`).join(', ')} WHERE reference = ?`,
      [...sets.map(([, v]) => v), ref]
    );
    if (typeof overrides.tollNotes === 'string') {
      await pool.query('UPDATE bookings SET toll_notes = ? WHERE reference = ?',
                       [overrides.tollNotes.slice(0, 500) || null, ref]);
    }
  }

  let [[booking]] = await pool.query(
    `SELECT b.reference, b.starts_on, b.ends_on, b.total, b.toll_charges,
            b.toll_notes, b.monthly_rate, b.advance_amount,
            b.pending_amount,
            /* Confirmed payments only: an unchecked screenshot must not
               reduce what the invoice asks for. */
            (SELECT COALESCE(SUM(p.amount), 0) FROM payment_proofs p
              WHERE p.booking_id = b.id AND p.verified_at IS NOT NULL) AS paid,
            c.full_name, c.email, c.phone,
            v.name AS vehicle_name, v.model_year, v.trim_level
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       JOIN vehicles  v ON v.id = b.vehicle_id
      WHERE b.reference = ?`, [ref]
  );
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });
  if (!booking.email) {
    throw Object.assign(new Error('This customer has no email address'), { status: 400 });
  }

  /* The onboarding invoice covers one month, not the whole term, so
     the caller can bill a smaller rental than the booking stores. It
     is a billing figure only — the booking keeps its full total, and
     the remainder is invoiced in later months. */
  const override = Number(overrides.rentalOverride);
  if (Number.isFinite(override) && override >= 0 && override < Number(booking.total || 0)) {
    /* Only the instalment being collected now goes on the invoice,
       together with the period it covers — a first month that starts
       mid-month is billed for those days alone, and the invoice has to
       say which days or the smaller figure looks like an error. */
    const label = String(overrides.periodLabel || '').slice(0, 40);
    booking = {
      ...booking,
      total: round2(override),
      period_label: label || null,
      period_from: overrides.periodFrom || null,
      period_to: overrides.periodTo || null,
      period_days: Number(overrides.periodDays) || null
    };
  }

  const { buffer, model } = await invoicePdf(booking);

  await sendEmail({
    to: booking.email,
    subject: `Invoice ${model.number} - ${ref} - Reddy Finances`,
    html: invoiceHtml(booking),
    attachments: [{
      filename: `${model.number}.pdf`,
      content: buffer,
      contentType: 'application/pdf'
    }]
  });

  return {
    sent: true,
    to: booking.email,
    number: model.number,
    rental: model.rental,
    tolls: model.tolls,
    total: model.total
  };
}

/* One customer's own bookings, for the My Profile page. Matched on the
   email their session carries, and deliberately narrower than
   listBookings() — no other customer's data can appear here. */
async function bookingsForCustomer(email) {
  if (!email) return [];
  const [rows] = await pool.query(`
    SELECT b.id AS _bookingId, b.reference AS id, c.full_name AS name,
           c.email, c.phone, c.license_number AS licenseNumber,
           v.slug AS carId, v.name AS vehicleName, v.model_year AS vehicleYear,
           v.image_path AS vehicleImage,
           b.starts_on AS \`from\`, b.ends_on AS \`to\`,
           b.status, b.total, b.toll_charges, b.monthly_rate,
           b.advance_amount, b.booking_deposit, b.pending_amount, b.open_return,
           b.confirmation_sent, b.contract_sent_at, b.contract_signed_at,
           b.license_uploaded_at, b.return_notice_given_at, b.expected_return_on,
           b.pickup_location, b.payment_method,
           /* Whether this customer has already sent proof of payment,
              so the card can say "received" instead of asking again. */
           (SELECT COUNT(*) FROM payment_proofs p
             WHERE p.booking_id = b.id)                       AS proof_count,
           (SELECT COUNT(*) FROM payment_proofs p
             WHERE p.booking_id = b.id
               AND p.verified_at IS NOT NULL)                 AS verified_proof_count,
           DATE(b.created_at) AS created
      FROM bookings b
      JOIN customers c ON c.id = b.customer_id
      JOIN vehicles  v ON v.id = b.vehicle_id
     WHERE c.email = ?
     ORDER BY b.starts_on DESC`, [email]);

  /* Which condition photos are already in — the page needs this to show
     each upload box as done or still outstanding. Split into the pickup
     set (handover) and the return set (handback). */
  const [photos] = await pool.query(`
    SELECT p.booking_id, p.photo_type, p.stage, p.file_path
      FROM booking_photos p
      JOIN bookings b  ON b.id = p.booking_id
      JOIN customers c ON c.id = b.customer_id
     WHERE c.email = ?`, [email]);

  const byBooking = new Map();
  for (const p of photos) {
    if (!byBooking.has(p.booking_id)) byBooking.set(p.booking_id, { pickup: {}, return: {} });
    const stage = p.stage === 'return' ? 'return' : 'pickup';
    byBooking.get(p.booking_id)[stage][p.photo_type] = p.file_path;
  }

  /* Damage photos: a list per booking rather than a keyed set, since
     there can be any number of them and each carries its own note. */
  const [damage] = await pool.query(`
    SELECT d.id, d.booking_id, d.file_path, d.note, d.stage
      FROM booking_damage_photos d
      JOIN bookings b  ON b.id = d.booking_id
      JOIN customers c ON c.id = b.customer_id
     WHERE c.email = ?
     ORDER BY d.uploaded_at ASC, d.id ASC`, [email]);

  const damageByBooking = new Map();
  for (const d of damage) {
    if (!damageByBooking.has(d.booking_id)) damageByBooking.set(d.booking_id, []);
    damageByBooking.get(d.booking_id).push({
      id: d.id, src: d.file_path, note: d.note || '', stage: d.stage
    });
  }

  /* Walkaround videos, grouped by stage so each section on the card
     shows only its own. */
  const [videos] = await pool.query(
    `SELECT v.id, v.booking_id, v.stage, v.file_path, v.note,
            v.duration_secs, v.file_bytes
       FROM booking_videos v
       JOIN bookings b  ON b.id = v.booking_id
       JOIN customers c ON c.id = b.customer_id
      WHERE c.email = ?
      ORDER BY v.uploaded_at ASC, v.id ASC`, [email]);

  const videosByBooking = new Map();
  for (const v of videos) {
    if (!videosByBooking.has(v.booking_id)) {
      videosByBooking.set(v.booking_id, { pickup: [], return: [], damage: [] });
    }
    const bucket = videosByBooking.get(v.booking_id)[v.stage];
    if (bucket) bucket.push({
      id: v.id, src: v.file_path, note: v.note || '',
      durationSecs: v.duration_secs, bytes: v.file_bytes
    });
  }

  return rows.map(({ advance_amount, ...r }) => ({
    /* The advance is negotiated between the office and the customer, so
       it belongs on the invoice the admin sends — not on the customer's
       own screens, where a figure on display cannot be bargained over.
       Destructured out of the row as well as left unmapped, or the
       spread below would put it back. */
    ...r,
    total: r.total === null ? null : Number(r.total),
    tolls: Number(r.toll_charges || 0),
    /* The customer should know what they still owe. */
    pending: Number(r.pending_amount || 0),
    openReturn: Boolean(r.open_return),
    monthlyRate: r.monthly_rate === null ? null : Number(r.monthly_rate),
    confirmationSent: Boolean(r.confirmation_sent),
    /* Set when the slot confirmation is sent, so the dashboard can
       show which bookings still need one. */
    pickupLocation: r.pickup_location || null,
    /* How the money arrived. The page needs it because a booking
       settled in cash has no screenshot to upload: the office ticks it
       off at the counter, and the customer's photo steps open on the
       strength of that instead. */
    paymentMethod: r.payment_method || null,
    /* What the customer has already put down, and whether a screenshot
       of it is on file.

       Neither reached this page before, so a booking made seconds
       earlier WITH a deposit still said "upload your payment
       screenshot below" and offered the button again. To the customer
       that reads as the payment having vanished — they had just paid,
       uploaded proof, and been redirected here to be asked for it
       afresh. */
    bookingDeposit: Number(r.booking_deposit || 0),
    proofCount: Number(r.proof_count || 0),
    paymentVerified: Number(r.verified_proof_count || 0) > 0,
    contractSentAt: r.contract_sent_at,
    contractSignedAt: r.contract_signed_at,
    licenseUploadedAt: r.license_uploaded_at,
    returnNoticeGivenAt: r.return_notice_given_at,
    expectedReturnOn: r.expected_return_on,
    photos: (byBooking.get(r._bookingId) || {}).pickup || {},
    returnPhotos: (byBooking.get(r._bookingId) || {}).return || {},
    damagePhotos: damageByBooking.get(r._bookingId) || [],
    videos: videosByBooking.get(r._bookingId)
            || { pickup: [], return: [], damage: [] }
  }));
}

/* -------------------------- notifications -------------------------- */

/* Written whenever something happens that either side should know
   about. Never allowed to break the action that produced it — a
   notification failing must not roll back an approval. */
async function notify({ audience, customerId = null, bookingId = null, kind, title, body = '', link = '' }) {
  try {
    await pool.query(
      `INSERT INTO notifications
         (audience, customer_id, booking_id, kind, title, body, link)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [audience, customerId, bookingId, kind, String(title).slice(0, 160),
       String(body).slice(0, 500), String(link).slice(0, 200)]
    );
  } catch (err) {
    console.error('notification write failed:', err.message);
  }
}

/* Both sides of one event in a single call. */
async function notifyBoth(customerId, bookingId, kind, customer, admin) {
  await notify({ audience: 'customer', customerId, bookingId, kind, ...customer });
  await notify({ audience: 'admin', bookingId, kind, ...admin });
}

/* The dashboard's list. */
async function adminNotifications(limit = 40) {
  const [rows] = await pool.query(
    `SELECT n.id, n.kind, n.title, n.body, n.link, n.is_read, n.created_at,
            b.reference
       FROM notifications n
       LEFT JOIN bookings b ON b.id = n.booking_id
      WHERE n.audience = 'admin'
      ORDER BY n.created_at DESC
      LIMIT ?`, [Number(limit) || 40]
  );
  return rows.map(r => ({ ...r, is_read: Boolean(r.is_read) }));
}

/* One customer's list, matched on the email their session carries. */
async function customerNotifications(email, limit = 40) {
  if (!email) return [];
  const [rows] = await pool.query(
    `SELECT n.id, n.kind, n.title, n.body, n.link, n.is_read, n.created_at,
            b.reference
       FROM notifications n
       JOIN customers c ON c.id = n.customer_id
       LEFT JOIN bookings b ON b.id = n.booking_id
      WHERE n.audience = 'customer' AND c.email = ?
      ORDER BY n.created_at DESC
      LIMIT ?`, [email, Number(limit) || 40]
  );
  return rows.map(r => ({ ...r, is_read: Boolean(r.is_read) }));
}

/* Marking read is scoped to the caller, so nobody can clear anyone
   else's notifications by guessing ids. */
async function markNotificationsRead(audience, email, ids) {
  const list = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : null;

  if (audience === 'admin') {
    if (list && list.length) {
      await pool.query(
        'UPDATE notifications SET is_read = 1 WHERE audience = "admin" AND id IN (?)', [list]
      );
    } else {
      await pool.query('UPDATE notifications SET is_read = 1 WHERE audience = "admin"');
    }
    return true;
  }

  if (!email) return false;
  const [[cust]] = await pool.query('SELECT id FROM customers WHERE email = ?', [email]);
  if (!cust) return false;

  if (list && list.length) {
    await pool.query(
      'UPDATE notifications SET is_read = 1 WHERE customer_id = ? AND id IN (?)', [cust.id, list]
    );
  } else {
    await pool.query('UPDATE notifications SET is_read = 1 WHERE customer_id = ?', [cust.id]);
  }
  return true;
}

/* ------------------------- auth sessions --------------------------- */

/* A signed cookie says WHO; it cannot say "not any more". This registry
   is the half that can: the cookie carries an opaque id and this table
   decides whether that id is still good.

   Revocation is checked against an in-memory set rather than a query
   per request, so signing in does not cost a database round trip on
   every page. The trade is honest about its limit: a revocation made
   by ANOTHER process (or another server) lands within one refresh
   interval, whereas a sign-out on THIS process is effective
   immediately, because the id is dropped from the set as it is revoked.
   A single-process deployment — which is what this is — therefore has no
   window at all.

   If the table has not been created yet, everything degrades to the old
   stateless behaviour and sessionsAvailable() reports false, so the
   server can say so out loud rather than pretending revocation works. */

const SESSION_REFRESH_MS = 30_000;
let sessionTableChecked = false;
let sessionTablePresent = false;
const activeSessions = new Set();

async function sessionsAvailable() {
  if (sessionTableChecked) return sessionTablePresent;
  sessionTableChecked = true;
  try {
    await pool.query('SELECT 1 FROM auth_sessions LIMIT 1');
    sessionTablePresent = true;
  } catch {
    sessionTablePresent = false;
  }
  return sessionTablePresent;
}

async function loadActiveSessions() {
  if (!sessionTableChecked) await sessionsAvailable();
  if (!sessionTablePresent) return;
  try {
    const [rows] = await pool.query(
      `SELECT id FROM auth_sessions
        WHERE revoked_at IS NULL AND expires_at > NOW()`
    );
    const next = new Set(rows.map(r => r.id));
    /* Replace rather than add: a session revoked since the last poll
       must disappear, and a set that only ever grows would keep
       honouring it. */
    activeSessions.clear();
    for (const id of next) activeSessions.add(id);
    /* Opportunistic cleanup — nobody is waiting on these rows. */
    pool.query(
      `DELETE FROM auth_sessions
        WHERE expires_at < NOW()
           OR revoked_at < NOW() - INTERVAL 30 DAY`
    ).catch(() => {});
  } catch { /* keep the previous view; a transient blip is not a logout */ }
}

function startSessionWatcher() {
  /* Load once straight away, not only on the first tick. The startup
     block has already confirmed the table exists, which flips
     sessionTablePresent to true — so with an empty in-memory set until
     the first 30s tick, every signed-in visitor would have been treated
     as signed out and bounced to the login page on a server restart. */
  loadActiveSessions().catch(() => {});
  const t = setInterval(loadActiveSessions, SESSION_REFRESH_MS);
  if (t.unref) t.unref();
  return t;
}

async function createAuthSession({ id, userId, email, admin, expiresAt, ip, userAgent }) {
  if (!sessionTablePresent) return false;
  try {
    await pool.query(
      `INSERT INTO auth_sessions (id, user_id, email, admin, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, String(userId || ''), String(email || ''), admin ? 1 : 0,
       expiresAt, ip || null, String(userAgent || '').slice(0, 255) || null]
    );
    activeSessions.add(id);
    return true;
  } catch (err) {
    console.error('[auth] could not record session:', err.message);
    return false;
  }
}

/* Synchronous by design — the guards that call it cannot await without
   every route becoming async. Reads the in-memory set, which loadActive-
   Sessions() keeps current. */
function authSessionActive(id) {
  if (!sessionTablePresent) return true;   /* no table -> stateless mode */
  if (!id) return false;
  return activeSessions.has(id);
}

async function revokeAuthSession(id) {
  if (!id) return;
  /* Drop from the set first: that is what makes sign-out take effect
     for the very next request from this process. */
  activeSessions.delete(id);
  if (!sessionTablePresent) return;
  try {
    await pool.query(
      `UPDATE auth_sessions SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL`, [id]
    );
  } catch (err) {
    console.error('[auth] revoke failed:', err.message);
  }
}

/* Used when the admin password changes: every session that was signed
   in under the old password has to go, or the change buys nothing. */
async function revokeAuthSessionsForEmail(email, { exceptId = null } = {}) {
  const mail = String(email || '').toLowerCase();
  if (!mail) return 0;
  for (const id of [...activeSessions]) {
    if (exceptId && id === exceptId) continue;
    activeSessions.delete(id);
  }
  if (!sessionTablePresent) return 0;
  try {
    const [res] = await pool.query(
      `UPDATE auth_sessions SET revoked_at = NOW()
        WHERE LOWER(email) = ? AND revoked_at IS NULL${exceptId ? ' AND id <> ?' : ''}`,
      exceptId ? [mail, exceptId] : [mail]
    );
    return res.affectedRows || 0;
  } catch (err) {
    console.error('[auth] bulk revoke failed:', err.message);
    return 0;
  }
}

/* ------------------- return notice & release ---------------------- */

/* The renter tells us they are bringing the car back. The client wants
   at least 10 days warning, so the car can be advertised to the next
   customer before it is even returned. */
const RETURN_NOTICE_DAYS = 10;

async function giveReturnNotice(bookingRef, expectedReturnOn) {
  const ref = safeRef(bookingRef);
  const [[booking]] = await pool.query(
    `SELECT b.id, b.status, b.ends_on, v.id AS vehicle_id, v.name AS vehicle_name,
            c.full_name, c.email
       FROM bookings b
       JOIN vehicles  v ON v.id = b.vehicle_id
       JOIN customers c ON c.id = b.customer_id
      WHERE b.reference = ?`, [ref]
  );
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });
  if (!['Active', 'Confirmed'].includes(booking.status)) {
    throw Object.assign(
      new Error('Only a car currently on rent can be given return notice'), { status: 409 }
    );
  }

  const returnOn = expectedReturnOn || booking.ends_on;
  const lead = billing.daysUntil(returnOn);
  if (lead < RETURN_NOTICE_DAYS) {
    throw Object.assign(new Error(
      `Please give at least ${RETURN_NOTICE_DAYS} days notice — that date is ${lead} day${lead === 1 ? '' : 's'} away.`
    ), { status: 400 });
  }

  await pool.query(
    `UPDATE bookings
        SET return_notice_given_at = NOW(), expected_return_on = ?
      WHERE id = ?`, [returnOn, booking.id]
  );

  try {
    await sendEmail({
      to: env.EMAIL_USER,
      subject: `Return notice - ${ref}`,
      html: `<p><strong>${escapeHtml(booking.full_name || 'A customer')}</strong> will return the
             <strong>${escapeHtml(booking.vehicle_name || '')}</strong> on
             <strong>${escapeHtml(returnOn)}</strong> (booking ${escapeHtml(ref)}).</p>
             <p>You can now release this car for pre-booking.</p>`
    });
  } catch (err) {
    console.error(`Return-notice email failed for ${ref}:`, err.message);
  }

  return { reference: ref, expectedReturnOn: returnOn, daysNotice: lead };
}

/* Every car that is currently spoken for, whatever stage it is at, with
   the customer on it and what they owe. This is the Release tab's main
   list: the office wants one place showing who has what, and a button to
   open each car up for the next customer. */
async function bookedVehicles() {
  const [rows] = await pool.query(`
    SELECT b.reference, b.starts_on, b.ends_on, b.status, b.total,
           b.toll_charges, b.return_notice_given_at, b.expected_return_on,
           c.full_name, c.email, c.phone,
           v.slug, v.name AS vehicle_name, v.model_year, v.image_path,
           v.released_for_prebooking_at, v.available_from, v.prebooking_amount,
           DATEDIFF(COALESCE(b.expected_return_on, b.ends_on), CURDATE()) AS days_to_return,
           (SELECT COUNT(*) FROM bookings q
             WHERE q.vehicle_id = v.id AND q.status = 'Prebooked') AS queue_length,
           (SELECT COUNT(*) FROM bookings q
             WHERE q.vehicle_id = v.id AND q.status = 'Prebooked' AND q.prebooking_paid = 1) AS paid_count
      FROM bookings b
      JOIN customers c ON c.id = b.customer_id
      JOIN vehicles  v ON v.id = b.vehicle_id
     WHERE b.status IN ('Active','Confirmed','Prebooked')
       AND b.ends_on >= CURDATE()
     /* Stage still leads — a car on rent is more urgent than one only
        reserved — but within a stage the newest booking comes first. */
     ORDER BY FIELD(b.status,'Active','Confirmed','Prebooked'),
              b.created_at DESC, b.id DESC`);

  return rows.map(r => ({
    reference: r.reference,
    slug: r.slug,
    vehicle: `${r.model_year || ''} ${r.vehicle_name || ''}`.trim(),
    image: r.image_path || '',
    customer: r.full_name || '',
    email: r.email || '',
    phone: r.phone || '',
    from: r.starts_on,
    to: r.ends_on,
    status: r.status,
    total: Number(r.total || 0) + Number(r.toll_charges || 0),
    noticeGiven: Boolean(r.return_notice_given_at),
    expectedReturn: r.expected_return_on,
    daysToReturn: r.days_to_return,
    released: Boolean(r.released_for_prebooking_at),
    availableFrom: r.available_from,
    prebookingAmount: r.prebooking_amount != null ? Number(r.prebooking_amount) : null,
    queueLength: Number(r.queue_length || 0),
    paidCount: Number(r.paid_count || 0)
  }));
}

/* Cars whose renter has given notice but which are not yet open to the
   next customer — the admin's release queue. */
async function awaitingRelease() {
  const [rows] = await pool.query('SELECT * FROM vw_awaiting_release');
  return rows;
}

/* Open a car for pre-booking. From here other customers may queue for
   it, even though it is still physically out with someone. */
async function releaseVehicle(slug, availableFrom, prebookingAmount) {
  const [[vehicle]] = await pool.query(
    'SELECT id, name, released_for_prebooking_at FROM vehicles WHERE slug = ?', [slug]
  );
  if (!vehicle) throw Object.assign(new Error('Vehicle not found'), { status: 404 });
  if (vehicle.released_for_prebooking_at) {
    throw Object.assign(new Error('This car is already released for pre-booking'), { status: 409 });
  }

  /* Default to the day after the current renter says they will return. */
  let from = availableFrom;
  if (!from) {
    const [[cur]] = await pool.query(
      `SELECT COALESCE(expected_return_on, ends_on) AS back
         FROM bookings
        WHERE vehicle_id = ? AND status = 'Active'
        ORDER BY ends_on DESC LIMIT 1`, [vehicle.id]
    );
    if (cur && cur.back) {
      const d = new Date(cur.back + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      from = d.toISOString().slice(0, 10);
    }
  }

  const amount = prebookingAmount != null && prebookingAmount !== '' ? Number(prebookingAmount) : null;

  await pool.query(
    `UPDATE vehicles
        SET released_for_prebooking_at = NOW(), available_from = ?,
            prebooking_amount = ?
      WHERE id = ?`, [from || null, amount, vehicle.id]
  );

  await notify({
    audience: 'admin', kind: 'released',
    title: `${vehicle.name} released for pre-booking`,
    body: (amount ? `$${amount} prebooking fee. ` : '')
        + (from ? `Customers can now request it from ${from}.`
                : 'Customers can now request it.'),
    link: 'admin.html#overview'
  });

  return { slug, availableFrom: from || null, released: true, prebookingAmount: amount };
}

/* Undo a release — closes the car to new pre-bookings again. */
async function unreleaseVehicle(slug) {
  const [res] = await pool.query(
    `UPDATE vehicles
        SET released_for_prebooking_at = NULL, available_from = NULL
      WHERE slug = ?`, [slug]
  );
  return res.affectedRows > 0;
}

/* Free a car for ordinary booking.

   The everyday case is a no-show: the customer reserved the car, never
   collected it, and the office wants it back on the site immediately.
   Pre-booking is the wrong tool there — it queues people behind a car
   that is still nominally out. Cancelling the booking that holds the
   dates is what actually frees them, because availability is derived
   from live bookings, and it also closes any pre-booking queue that
   built up in the meantime.

   Money already recorded is deliberately left alone. A refund is a
   decision for a person, and silently erasing payments to tidy the
   row would destroy the only record that they were ever taken. The
   caller is told what was paid so it can say so. */
/* Hand a car back to the fleet.

   A cancelled booking must not keep its vehicle reserved: the car is
   free the moment the booking dies, and the site should be taking
   bookings for it again. The prebooking flags live on the vehicle
   rather than the booking, so flipping a status alone left cars held
   by bookings that no longer existed.

   Only clears the flags when no other live booking is holding the car
   — a second renter queued on the same vehicle keeps their claim. */
async function freeVehicleIfUnheld(vehicleId, exceptBookingId = null) {
  const [held] = await pool.query(
    `SELECT id FROM bookings
      WHERE vehicle_id = ?
        AND status IN ('Prebooked','Confirmed','Active')
        AND ends_on >= CURDATE()
        ${exceptBookingId ? 'AND id <> ?' : ''}
      LIMIT 1`,
    exceptBookingId ? [vehicleId, exceptBookingId] : [vehicleId]
  );
  if (held.length) return { freed: false, heldBy: held.length };

  await pool.query(
    `UPDATE vehicles
        SET released_for_prebooking_at = NULL,
            available_from = NULL,
            prebooking_amount = NULL
      WHERE id = ?`, [vehicleId]
  );
  return { freed: true, heldBy: 0 };
}

async function releaseForNormalBooking(slug, { reference = null } = {}) {
  const [[vehicle]] = await pool.query(
    'SELECT id, name, slug FROM vehicles WHERE slug = ?', [slug]
  );
  if (!vehicle) throw Object.assign(new Error('Vehicle not found'), { status: 404 });

  /* The booking holding the car now: the named one, or whichever live
     booking is currently occupying it. */
  const [holders] = reference
    ? await pool.query(
        `SELECT id, reference, status, starts_on, ends_on
           FROM bookings
          WHERE vehicle_id = ? AND reference = ?`, [vehicle.id, safeRef(reference)])
    : await pool.query(
        `SELECT id, reference, status, starts_on, ends_on
           FROM bookings
          WHERE vehicle_id = ?
            AND status IN ('Active','Confirmed','Prebooked')
            AND ends_on >= CURDATE()
          ORDER BY FIELD(status,'Active','Confirmed','Prebooked'), starts_on
          LIMIT 1`, [vehicle.id]);

  const holder = holders[0] || null;
  if (!holder) {
    throw Object.assign(new Error('No live booking is holding this car'), { status: 409 });
  }

  /* What has been taken against it, so the caller can flag a refund. */
  const s = await settlement(holder.id);

  await pool.query(
    `UPDATE bookings SET status = 'Cancelled' WHERE id = ?`, [holder.id]
  );

  /* Anyone queued behind it is left alone. Their reservations are real
     bookings with real money against them, and cancelling someone
     else's booking as a side effect of freeing a car is not a decision
     this function should take on its own. They are counted so the
     caller can tell the office they are still waiting. */
  const [queued] = await pool.query(
    `SELECT id FROM bookings
      WHERE vehicle_id = ? AND status = 'Prebooked' AND id <> ?
        AND ends_on >= CURDATE()`,
    [vehicle.id, holder.id]
  );

  await pool.query(
    `UPDATE vehicles
        SET released_for_prebooking_at = NULL,
            available_from = NULL,
            prebooking_amount = NULL
      WHERE id = ?`, [vehicle.id]
  );

  return {
    slug: vehicle.slug,
    vehicle: vehicle.name,
    reference: holder.reference,
    wasStatus: holder.status,
    from: holder.starts_on,
    to: holder.ends_on,
    paid: s.paid,
    stillQueued: queued.length
  };
}

/* Everyone queued for a car, oldest request first — now with customer
   details, prebooking amount, and payment status so the admin can
   review and mark payments. */
async function prebookingQueue() {
  const [rows] = await pool.query(`
    SELECT v.slug, v.name AS vehicle_name, v.model_year, v.prebooking_amount,
           b.reference, b.starts_on, b.ends_on, b.total, b.prebooking_paid,
           b.payment_method, b.confirmation_sent, b.created_at, b.open_return,
           c.full_name AS customer, c.email, c.phone,
           c.license_number AS license,
           /* The screenshot the customer sent with their pre-booking,
              so the office can check it without leaving the tab. */
           (SELECT p.file_path FROM payment_proofs p
             WHERE p.booking_id = b.id
             ORDER BY p.uploaded_at DESC LIMIT 1) AS proof_path,
           (SELECT p.id FROM payment_proofs p
             WHERE p.booking_id = b.id
             ORDER BY p.uploaded_at DESC LIMIT 1) AS proof_id,
           (SELECT p.scan_status FROM payment_proofs p
             WHERE p.booking_id = b.id
             ORDER BY p.uploaded_at DESC LIMIT 1) AS proof_scan_status,
           (SELECT p.scanned_amount FROM payment_proofs p
             WHERE p.booking_id = b.id
             ORDER BY p.uploaded_at DESC LIMIT 1) AS proof_scanned_amount,
           /* Confirmed payments against this reservation, so the queue
              can show what has actually been taken rather than only
              whether a screenshot exists. */
           (SELECT COALESCE(SUM(p.amount), 0) FROM payment_proofs p
             WHERE p.booking_id = b.id AND p.verified_at IS NOT NULL) AS verified_paid,
           (SELECT COUNT(*) FROM payment_proofs p
             WHERE p.booking_id = b.id AND p.verified_at IS NULL) AS unverified_count,
           (SELECT COUNT(*) FROM payment_proofs p
             WHERE p.booking_id = b.id) AS proof_count,
           ROW_NUMBER() OVER (PARTITION BY v.id ORDER BY b.created_at) AS queue_position
      FROM bookings b
      JOIN vehicles  v ON v.id = b.vehicle_id
      JOIN customers c ON c.id = b.customer_id
     WHERE b.status = 'Prebooked'
     /* Cars are ordered by their newest request, so the one somebody
        just queued for sits at the top. WITHIN a car the order stays
        oldest-first: that is the waiting list, and queue_position is
        derived from it — reversing it would tell the office the wrong
        person is next in line. */
     ORDER BY (SELECT MAX(b2.created_at) FROM bookings b2
                WHERE b2.vehicle_id = v.id AND b2.status = 'Prebooked') DESC,
              v.slug,
              b.created_at`);
  return rows;
}

/* --------------------------- availability -------------------------- */

/* Which dates is each car already spoken for? Cancelled and completed
   bookings do not hold a car, so they are left out. Only the dates are
   returned — never who booked them, because this feeds the public site. */
async function vehicleAvailability() {
  /* Which dates are unavailable to the next customer.

     A car is held only once its deposit is in. An unpaid Prebooked
     request is someone who filled the form and walked away — blocking
     the car for it took the car off sale for a booking nobody had paid
     for, and a single abandoned form could hold a vehicle for weeks.

     Confirmed and Active bookings always block: the office accepted
     them, which is a stronger signal than the deposit flag. */
  const [rows] = await pool.query(`
    SELECT v.slug, b.starts_on, b.ends_on, b.status
      FROM bookings b
      JOIN vehicles v ON v.id = b.vehicle_id
     WHERE b.ends_on >= CURDATE()
       AND (
         b.status IN ('Confirmed','Active')
         OR (b.status = 'Prebooked'
             AND (b.prebooking_paid = 1
                  OR EXISTS (SELECT 1 FROM payment_proofs p
                              WHERE p.booking_id = b.id)))
       )
     ORDER BY v.slug, b.starts_on`);

  /* Per-car state: is it out right now, has its renter given notice,
     and has the office opened it for the next customer? */
  const [status] = await pool.query(`
    SELECT slug, current_reference, current_from, current_to,
           return_notice_given_at, expected_return_on,
           released_for_prebooking_at, available_from, prebooked_count,
           prebooking_amount
      FROM vw_vehicle_status`);

  /* Reservations whose fee has actually been settled — a confirmed
     screenshot or cash taken at the counter. Once one customer has
     paid to hold a car, the slot is theirs: the site must stop taking
     further pre-bookings for it rather than queueing people behind a
     reservation that is already paid for. */
  const [claimed] = await pool.query(`
    SELECT v.slug, COUNT(*) AS n
      FROM bookings b
      JOIN vehicles v ON v.id = b.vehicle_id
     WHERE b.status = 'Prebooked'
       AND b.ends_on >= CURDATE()
       AND (b.prebooking_paid = 1
            OR EXISTS (SELECT 1 FROM payment_proofs p
                        WHERE p.booking_id = b.id
                          AND p.verified_at IS NOT NULL))
     GROUP BY v.slug`);
  const paidHold = {};
  for (const c of claimed) paidHold[c.slug] = Number(c.n);

  const out = {};
  for (const r of rows) {
    const e = (out[r.slug] = out[r.slug] || { ranges: [] });
    e.ranges.push({
      from: r.starts_on,
      to: r.ends_on,
      /* A request still awaiting approval is not a firm hold, so the
         site says "requested" rather than "booked". */
      firm: r.status !== 'Prebooked'
    });
  }

  for (const s of status) {
    const e = (out[s.slug] = out[s.slug] || { ranges: [] });
    e.inUse = Boolean(s.current_reference);
    e.noticeGiven = Boolean(s.return_notice_given_at);
    e.released = Boolean(s.released_for_prebooking_at);
    e.availableFrom = s.available_from || null;
    e.expectedReturn = s.expected_return_on || s.current_to || null;
    e.queueLength = Number(s.prebooked_count || 0);
    e.prebookingAmount = s.prebooking_amount != null ? Number(s.prebooking_amount) : null;

    /* Someone has paid to hold this car. */
    e.prebookingClaimed = Number(paidHold[s.slug] || 0) > 0;

    /* A car that is out and has NOT been released cannot be booked by
       anyone else yet. Once released it reopens — but only until a
       customer pays the reservation fee, at which point the slot is
       taken and the site shows it as booked rather than inviting more
       pre-bookings behind a paid hold. */
    e.bookable = (!e.inUse || e.released) && !e.prebookingClaimed;
  }
  return out;
}

/* ------------------- approve / reject a booking ------------------- */

/* The admin decides on every request by hand. Approving moves it to
   Confirmed; rejecting moves it to Cancelled with the reason recorded.
   Both tell the customer by email — a failed send is logged, never
   allowed to undo the decision the admin already made. */
async function decideBooking(bookingRef, approve, reason = '', force = false,
                             pickupLocation = null) {
  const ref = safeRef(bookingRef);
  const [[booking]] = await pool.query(
    `SELECT b.id, b.reference, b.status, b.starts_on, b.ends_on,
            b.vehicle_id,
            b.contract_sent_at, b.contract_signed_at,
            c.full_name, c.email,
            v.name AS vehicle_name, v.model_year, v.listing_type
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       JOIN vehicles  v ON v.id = b.vehicle_id
      WHERE b.reference = ?`, [ref]
  );
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });
  if (['Completed', 'Cancelled'].includes(booking.status)) {
    throw Object.assign(
      new Error(`This booking is already ${booking.status.toLowerCase()}`), { status: 409 }
    );
  }

  /* The contract normally comes first, but the office often settles it
     by phone or in person — so this is advice, not a lock. The admin can
     always approve; the dashboard simply asks them to confirm when the
     paperwork is not on file. */

  const status = approve ? 'Confirmed' : 'Cancelled';
  const note = String(reason || '').slice(0, 500);

  /* Where to collect the car, set by the office as it approves. Only
     on approval: a rejected booking has no pick-up. */
  const place = approve ? String(pickupLocation || '').trim().slice(0, 255) : '';
  if (place) {
    await pool.query(
      'UPDATE bookings SET status = ?, pickup_location = ? WHERE id = ?',
      [status, place, booking.id]);
  } else {
    await pool.query('UPDATE bookings SET status = ? WHERE id = ?', [status, booking.id]);
  }
  booking.pickup_location = place || booking.pickup_location || null;

  /* Rejecting frees the car: nothing is holding it any more, so it goes
     back on the site rather than sitting reserved for a booking that
     was just refused. */
  if (!approve && booking.vehicle_id) {
    await freeVehicleIfUnheld(booking.vehicle_id, booking.id);
  }

  {
    const car = `${booking.model_year || ''} ${booking.vehicle_name || ''}`.trim();
    const [[cust]] = await pool.query(
      'SELECT customer_id FROM bookings WHERE id = ?', [booking.id]
    );
    await notifyBoth(cust && cust.customer_id, booking.id,
      approve ? 'approved' : 'rejected',
      approve
        ? {
            title: 'Slot booked — your booking is confirmed',
            body: `${car} (${ref}) — pick-up ${booking.starts_on}, return ${booking.ends_on}. `
                + (place ? `Collect from ${place}. ` : '')
                + `Please upload the five vehicle photos before collection.`
                + (note ? ` ${note}` : ''),
            link: 'bookings.html'
          }
        : {
            title: 'Slot rejected — the car is unavailable',
            body: `We could not confirm ${car} (${ref}).`
                + (note ? ` ${note}` : ' The vehicle is not available for those dates.'),
            link: 'index.html#fleet'
          },
      {
        title: `${ref} ${approve ? 'approved' : 'rejected'}`,
        body: `${booking.full_name || 'Customer'} — ${car}.` + (note ? ` ${note}` : ''),
        link: 'admin.html#bookings'
      }
    );
  }
  if (note) {
    await pool.query(
      'UPDATE bookings SET toll_notes = CONCAT(COALESCE(toll_notes, ""), ?) WHERE id = ?',
      [`\n[${status} ${new Date().toISOString().slice(0, 10)}] ${note}`, booking.id]
    );
  }

  /* Approving ONBOARDS the booking: it moves from Actions into
     Bookings and the customer is told, in the bell, that it went
     through. It does NOT send the slot confirmation — that is its own
     step, so the office can set the pick-up point and check the
     details before the customer is told where to turn up. The
     envelope action in the Actions tab sends it.

     A rejection still emails, because a cancelled booking needs a
     reason and there is no later step that would carry one. */
  let emailSent = false;
  if (!approve && booking.email) {
    try {
      const appUrl = env.APP_URL || 'http://localhost:5500';
      const mail = slotRejectedEmail(booking, note, appUrl);
      await sendEmail({ to: booking.email, subject: mail.subject, html: mail.html });
      emailSent = true;
    } catch (err) {
      console.error(`Decision email failed for ${ref}:`, err.message);
    }
  }

  return { reference: ref, status, emailSent };
}

/* Customer-supplied text ends up inside HTML emails, so escape it —
   a name like `O'Brien <script>` must arrive as text, not markup. */
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/* ---------------------------- e-signing --------------------------- */

/* The customer signs on screen; we regenerate the agreement with their
   signature stamped in and store THAT as the signed original. Nothing
   is trusted from the browser except the signature mark itself — every
   other field is re-read from the database. */
async function signContract(bookingRef, { dataUrl, typedName, method, ip } = {}) {
  const ref = safeRef(bookingRef);
  const [[booking]] = await pool.query(
    `SELECT b.*, c.full_name, c.email, c.phone, c.license_number,
            v.name AS vehicle_name, v.model_year, v.trim_level,
            v.monthly_rate AS vehicle_monthly_rate, v.price
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       JOIN vehicles  v ON v.id = b.vehicle_id
      WHERE b.reference = ?`, [ref]
  );
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });

  /* A drawn signature must be a PNG data URL and nothing else — this
     string gets embedded in a document we then hand back out. */
  if (dataUrl) {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/.test(String(dataUrl))) {
      throw Object.assign(new Error('Signature image must be a PNG'), { status: 400 });
    }
    if (String(dataUrl).length > 2_000_000) {
      throw Object.assign(new Error('Signature image is too large'), { status: 400 });
    }
  }
  const name = String(typedName || '').trim().slice(0, 120);
  if (!dataUrl && !name) {
    throw Object.assign(new Error('A signature is required'), { status: 400 });
  }

  const signedOn = new Date().toISOString().slice(0, 10);

  /* Sign the wording this customer was actually SENT, not whatever is
     active now. contract_template_id was stamped when the agreement
     went out; without it the signed copy could carry a clause the
     customer never agreed to, because the office had edited the
     document in between. Falls back to the active version for older
     bookings that predate the versioning. */
  const signedTemplate = booking.contract_template_id
    ? await getDocumentTemplate(booking.contract_template_id)
    : await activeDocumentTemplate('rental_agreement');

  const pdfBuffer = await generateContractPdf(
    { ...booking, ...contractPeriod(booking),
      monthly_rate: booking.monthly_rate || booking.vehicle_monthly_rate },
    { dataUrl, typedName: name || booking.full_name, method, signedOn, ip },
    signedTemplate && signedTemplate.body
  );

  const fileName = `signed-contract-${ref}-${Date.now()}.pdf`;
  const filePath = path.join(__dirname, '..', 'uploads', 'contracts', fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, pdfBuffer);

  await createContractDocument(booking.id, 'rental_agreement', filePath,
                               pdfBuffer.length, /* signed */ true);
  await markContractSigned(booking.id);

  /* Send the office the signed agreement itself, not just word that one
     exists. The notification used to arrive without the document, so
     the only copy lived on the server and someone had to go and find
     it — the whole point of the email is to put the signed contract in
     the office's hands. Email trouble must not undo a signature the
     customer has already given. */
  try {
    await sendEmail({
      to: env.EMAIL_USER,
      subject: `Contract signed - ${ref}`,
      html: `<p><strong>${escapeHtml(booking.full_name || 'A customer')}</strong> has signed the rental agreement for <strong>${escapeHtml(ref)}</strong>.</p>
             <p>Signed on ${escapeHtml(signedOn)}${ip ? ' from ' + escapeHtml(String(ip)) : ''}.</p>
             <p>The signed agreement is attached, and is also filed against
                this booking in the dashboard's Photos tab.</p>`,
      attachments: [{
        filename: `signed-agreement-${ref}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf'
      }]
    });
  } catch (err) {
    console.error(`Signed-contract notification failed for ${ref}:`, err.message);
  }

  return { success: true, signedOn, reference: ref };
}

async function listPendingContracts() {
  const [rows] = await pool.query('SELECT * FROM vw_pending_contracts');
  return rows;
}

async function handleBookingPhotoUpload(bookingRef, photoType, stage, file) {
  const ref = safeRef(bookingRef);
  const [[booking]] = await pool.query(
    'SELECT id, status, starts_on FROM bookings WHERE reference = ?', [ref]);
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });

  /* Condition photos record the state of a car at handover, so they
     only open once the office has ACCEPTED the booking — before that
     there is no handover to record. Payment is the step available
     beforehand; it has its own endpoint and no such gate. */
  const open = ['Confirmed', 'Active'];
  if (!open.includes(String(booking.status))) {
    throw Object.assign(
      new Error('Vehicle photos can be uploaded once your booking is confirmed'),
      { status: 409 }
    );
  }

  /* Pick-up photos cannot be taken before the pick-up day, whoever the
     booking belongs to and however it was paid for.

     This matters most for a cash booking. The office ticks "paid by
     cash" at the counter, which confirms the booking and opens these
     steps — but confirming can happen weeks ahead, and the shots are
     meant to show the car as it is handed over. Without this a customer
     could upload last month's photos and then claim damage was already
     there. The first of these uploads also stamps pickup_time, which
     would otherwise record a moment that is not the handover at all.

     Return photos are exempt: they belong to the other end of the
     rental and are gated by the return notice instead. */
  if (stage === 'pickup' && booking.starts_on) {
    const startsOn = new Date(booking.starts_on);
    startsOn.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (today < startsOn) {
      throw Object.assign(
        new Error('Vehicle photos open on your pick-up day, '
                + startsOn.toDateString().slice(4)),
        { status: 409 }
      );
    }
  }

  /* Condition photos are images only — never a PDF, never anything the
     browser would execute. */
  const ext = safeExt(file, IMAGE_TYPES, 'photo');
  const fileName = `booking-${ref}-${stage}-${photoType}-${Date.now()}${ext}`;
  const filePath = path.join(__dirname, '..', 'uploads', 'bookings', fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, file.buffer);

  await pool.query(
    `INSERT INTO booking_photos (booking_id, photo_type, stage, file_path)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE file_path = VALUES(file_path)`,
    [booking.id, photoType, stage, `uploads/bookings/${fileName}`]
  );

  /* The odometer photo carries a number the business needs — how far
     the car was driven — and until now only the image was kept, so
     nothing could report mileage.

     Read here, but written as a SUGGESTION: source 'ocr' means the
     office has not checked it. A dashboard photo is a hard read, so
     the dashboard shows unconfirmed figures as such and lets the
     office correct them. A reading already confirmed by the office is
     never overwritten by a later scan. */
  let odometer = null;
  if (photoType === 'odometer' && (stage === 'pickup' || stage === 'return')) {
    try {
      const scan = await scanOdometer(file.buffer);
      if (scan && scan.miles !== null) {
        const col = stage === 'pickup' ? 'odometer_pickup' : 'odometer_return';
        const src = stage === 'pickup'
          ? 'odometer_pickup_source' : 'odometer_return_source';
        const [res] = await pool.query(
          `UPDATE bookings SET ${col} = ?, ${src} = 'ocr'
            WHERE id = ? AND (${src} IS NULL OR ${src} = 'ocr')`,
          [scan.miles, booking.id]
        );
        if (res.affectedRows) odometer = scan.miles;
      }
    } catch { /* a failed read must never block the upload */ }
  }

  /* The pick-up time, stamped from the first pick-up photo.

     That photo is taken at the counter as the car changes hands, so
     its upload IS the handover moment — more reliable than asking the
     office to type a time in afterwards, which was easy to forget and
     left the rental agreement showing a date with no time on it.

     Only the FIRST one sets it: the remaining four are minutes apart
     and would otherwise keep pushing the recorded time later. Return
     photos never touch it — they belong to the other end of the
     rental. */
  let pickupTime = null;
  if (stage === 'pickup') {
    const [res] = await pool.query(
      `UPDATE bookings SET pickup_time = CURRENT_TIME()
        WHERE id = ? AND pickup_time IS NULL`, [booking.id]);
    if (res.affectedRows) {
      const [[row]] = await pool.query(
        'SELECT pickup_time FROM bookings WHERE id = ?', [booking.id]);
      pickupTime = row && row.pickup_time ? String(row.pickup_time).slice(0, 5) : null;
    }
  }

  return { path: `uploads/bookings/${fileName}`, pickupTime, odometer };
}

/* Damage photos: any number per booking, each with its own note.

   Separate from the five condition shots because those are one-per-
   angle by design, while damage is however many marks the renter
   finds. The agreement asks them to record existing damage before
   driving away; this is where that evidence goes. */
async function addDamagePhoto(bookingRef, stage, file, note = '') {
  const ref = safeRef(bookingRef);
  const [[booking]] = await pool.query(
    'SELECT id, status FROM bookings WHERE reference = ?', [ref]);
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });

  /* Same gate as the condition photos: damage is recorded against a
     car the customer actually has, which means an accepted booking. */
  const open = ['Confirmed', 'Active'];
  if (!open.includes(String(booking.status))) {
    throw Object.assign(
      new Error('Damage photos can be uploaded once your booking is confirmed'),
      { status: 409 }
    );
  }

  /* A cap, so a stuck upload loop cannot fill the disk. Generous
     enough that nobody documenting real damage will reach it. */
  const [[{ n }]] = await pool.query(
    'SELECT COUNT(*) AS n FROM booking_damage_photos WHERE booking_id = ? AND stage = ?',
    [booking.id, stage]);
  if (n >= 20) {
    throw Object.assign(
      new Error('Up to 20 damage photos per booking'), { status: 409 });
  }

  const ext = safeExt(file, IMAGE_TYPES, 'photo');
  const fileName = `damage-${ref}-${stage}-${Date.now()}${ext}`;
  const filePath = path.join(__dirname, '..', 'uploads', 'bookings', fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, file.buffer);

  const clean = String(note || '').trim().slice(0, 300) || null;
  const [res] = await pool.query(
    `INSERT INTO booking_damage_photos (booking_id, file_path, note, stage)
     VALUES (?, ?, ?, ?)`,
    [booking.id, `uploads/bookings/${fileName}`, clean, stage]
  );
  return { id: res.insertId, path: `uploads/bookings/${fileName}`, note: clean || '' };
}

/* ---------------------------- mileage ------------------------------ */

/* Every booking with an odometer reading at either end, for the
   Overview tab's Miles tracker.

   Miles driven is the difference between the two readings, and is only
   reported when BOTH exist — one reading on its own says nothing about
   distance. A return figure below the pickup figure is flagged rather
   than shown as a negative: it means one of the two was misread, and
   silently printing "-4,210 miles" would be worse than saying so.

   `pickupSource`/`returnSource` tell the dashboard which figures are
   still unconfirmed OCR guesses, so it can mark them. */
async function mileageReport({ from = null, to = null } = {}) {
  const where = ['(b.odometer_pickup IS NOT NULL OR b.odometer_return IS NOT NULL)'];
  const args = [];
  if (from) { where.push('b.starts_on >= ?'); args.push(from); }
  if (to)   { where.push('b.starts_on <= ?'); args.push(to); }

  const [rows] = await pool.query(
    `SELECT b.reference, b.starts_on, b.ends_on, b.status,
            b.odometer_pickup, b.odometer_return,
            b.odometer_pickup_source, b.odometer_return_source,
            c.full_name, c.email,
            v.name AS vehicle_name, v.model_year, v.slug
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       JOIN vehicles  v ON v.id = b.vehicle_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.starts_on DESC, b.id DESC`, args);

  return rows.map(r => {
    const pickup = r.odometer_pickup === null ? null : Number(r.odometer_pickup);
    const ret    = r.odometer_return === null ? null : Number(r.odometer_return);
    const both   = pickup !== null && ret !== null;
    return {
      reference: r.reference,
      customer: r.full_name || '',
      email: r.email || '',
      vehicle: [r.model_year, r.vehicle_name].filter(Boolean).join(' '),
      carId: r.slug || '',
      from: r.starts_on,
      to: r.ends_on,
      status: r.status,
      pickup,
      return: ret,
      pickupSource: r.odometer_pickup_source,
      returnSource: r.odometer_return_source,
      /* null until both ends are known. */
      miles: both ? ret - pickup : null,
      /* a return lower than the pickup is a misread, not a journey */
      suspect: both && ret < pickup,
      unconfirmed: r.odometer_pickup_source === 'ocr'
                || r.odometer_return_source === 'ocr'
    };
  });
}

/* The office correcting a reading, or supplying one the scan missed.
   Writing by hand marks it 'admin', which stops a later photo upload
   from overwriting it. */
async function setOdometer(bookingRef, stage, miles) {
  const ref = safeRef(bookingRef);
  const which = stage === 'return' ? 'return' : 'pickup';
  const col = which === 'pickup' ? 'odometer_pickup' : 'odometer_return';
  const src = which === 'pickup'
    ? 'odometer_pickup_source' : 'odometer_return_source';

  const [[booking]] = await pool.query(
    'SELECT id FROM bookings WHERE reference = ?', [ref]);
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });

  /* An empty value clears the reading rather than storing zero — the
     office may be removing a bad scan. */
  const raw = String(miles == null ? '' : miles).trim();
  if (raw === '') {
    await pool.query(
      `UPDATE bookings SET ${col} = NULL, ${src} = NULL WHERE id = ?`, [booking.id]);
    return { reference: ref, stage: which, miles: null };
  }

  const n = Math.round(Number(raw));
  if (!isFinite(n) || n < 0 || n > 999999) {
    throw Object.assign(new Error('Enter a mileage between 0 and 999,999'),
                        { status: 400 });
  }
  await pool.query(
    `UPDATE bookings SET ${col} = ?, ${src} = 'admin' WHERE id = ?`,
    [n, booking.id]);
  return { reference: ref, stage: which, miles: n };
}

/* -------------------------- walkaround videos ---------------------- */

/* The formats a browser can produce from the compression step, plus
   the ones a phone might hand over untouched if compression was
   skipped. MOV is included because iOS records it and older Safari
   cannot always re-encode. */
const VIDEO_TYPES = {
  'video/webm': '.webm',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-m4v': '.m4v'
};

/* Optional video alongside the condition photos, for any of the three
   stages: pickup, return, damage.

   What arrives has normally been compressed in the browser already —
   downscaled and re-encoded before upload — so the 25MB ceiling here
   is a backstop for a device where that failed, not the expected
   size. A 30-second walkaround compresses to roughly 2-4 MB. */
async function handleBookingVideoUpload(bookingRef, stage, file, note = '',
                                        meta = {}) {
  const ref = safeRef(bookingRef);
  const [[booking]] = await pool.query(
    'SELECT id, status, starts_on FROM bookings WHERE reference = ?', [ref]);
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });

  const clean = ['pickup', 'return', 'damage'].includes(String(stage))
    ? String(stage) : 'pickup';

  /* Same gate as the photos: a video records the car changing hands,
     so it waits for the office to accept the booking. */
  if (!['Confirmed', 'Active'].includes(String(booking.status))) {
    throw Object.assign(
      new Error('Videos can be uploaded once your booking is confirmed'),
      { status: 409 }
    );
  }

  /* And, for the pickup stage, the same day gate the photos use — a
     pickup video taken three weeks early is not a pickup video. */
  if (clean === 'pickup' && booking.starts_on) {
    const startsOn = new Date(booking.starts_on);
    startsOn.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (today < startsOn) {
      throw Object.assign(
        new Error('Videos open on your pick-up day, '
                + startsOn.toDateString().slice(4)),
        { status: 409 }
      );
    }
  }

  if (!file || !file.buffer || !file.buffer.length) {
    throw Object.assign(new Error('That video is empty'), { status: 400 });
  }
  if (file.buffer.length > 25e6) {
    throw Object.assign(
      new Error('That video is too large (25MB limit). Try a shorter clip.'),
      { status: 413 }
    );
  }

  /* A cap per stage, so a retry loop cannot fill the disk. */
  const [[{ n }]] = await pool.query(
    'SELECT COUNT(*) AS n FROM booking_videos WHERE booking_id = ? AND stage = ?',
    [booking.id, clean]);
  const LIMIT = clean === 'damage' ? 5 : 2;
  if (n >= LIMIT) {
    throw Object.assign(
      new Error(`Up to ${LIMIT} video${LIMIT > 1 ? 's' : ''} for this step`),
      { status: 409 });
  }

  const ext = safeExt(file, VIDEO_TYPES, 'video');
  const fileName = `video-${ref}-${clean}-${Date.now()}${ext}`;
  const filePath = path.join(__dirname, '..', 'uploads', 'bookings', fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, file.buffer);

  const theNote = String(note || '').trim().slice(0, 300) || null;
  const secs = Number(meta.durationSecs);
  const origin = Number(meta.originalBytes);

  const [res] = await pool.query(
    `INSERT INTO booking_videos
       (booking_id, stage, file_path, note, duration_secs,
        file_bytes, original_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [booking.id, clean, `uploads/bookings/${fileName}`, theNote,
     isFinite(secs) && secs > 0 ? Math.min(Math.round(secs), 65535) : null,
     file.buffer.length,
     isFinite(origin) && origin > 0 ? Math.round(origin) : null]
  );

  await notify({
    audience: 'admin',
    bookingId: booking.id,
    kind: 'booking-video',
    title: 'Vehicle video uploaded',
    body: `${ref}: the customer uploaded a ${clean} video.`,
    link: 'admin.html#photos'
  });

  return {
    id: res.insertId,
    path: `uploads/bookings/${fileName}`,
    stage: clean,
    note: theNote || '',
    bytes: file.buffer.length
  };
}

/* Every video on one booking, for the customer's page. */
async function bookingVideos(bookingRef) {
  const ref = safeRef(bookingRef);
  const [rows] = await pool.query(
    `SELECT v.id, v.stage, v.file_path, v.note, v.duration_secs,
            v.file_bytes, v.original_bytes, v.uploaded_at
       FROM booking_videos v
       JOIN bookings b ON b.id = v.booking_id
      WHERE b.reference = ?
      ORDER BY v.uploaded_at ASC, v.id ASC`, [ref]);
  return rows.map(r => ({
    id: r.id,
    stage: r.stage,
    src: r.file_path,
    note: r.note || '',
    durationSecs: r.duration_secs,
    bytes: r.file_bytes,
    originalBytes: r.original_bytes,
    uploadedAt: r.uploaded_at
  }));
}

/* Removing one the customer uploaded by mistake. */
async function deleteBookingVideo(bookingRef, videoId) {
  const ref = safeRef(bookingRef);
  const [[row]] = await pool.query(
    `SELECT v.id, v.file_path FROM booking_videos v
       JOIN bookings b ON b.id = v.booking_id
      WHERE b.reference = ? AND v.id = ?`, [ref, Number(videoId) || 0]);
  if (!row) throw Object.assign(new Error('Video not found'), { status: 404 });

  await pool.query('DELETE FROM booking_videos WHERE id = ?', [row.id]);
  try { await fs.unlink(path.join(__dirname, '..', row.file_path)); }
  catch { /* already gone — the row is what matters */ }
  return { id: row.id };
}

async function damagePhotos(bookingRef) {
  const ref = safeRef(bookingRef);
  const [rows] = await pool.query(
    `SELECT d.id, d.file_path, d.note, d.stage, d.uploaded_at
       FROM booking_damage_photos d
       JOIN bookings b ON b.id = d.booking_id
      WHERE b.reference = ?
      ORDER BY d.uploaded_at ASC, d.id ASC`, [ref]);
  return rows.map(r => ({
    id: r.id,
    src: r.file_path,
    note: r.note || '',
    stage: r.stage,
    uploadedAt: r.uploaded_at
  }));
}

/* The renter can remove a shot they took by mistake — their own
   booking only, and only while it is still open. */
async function deleteDamagePhoto(bookingRef, id) {
  const ref = safeRef(bookingRef);
  const [[row]] = await pool.query(
    `SELECT d.id, d.file_path FROM booking_damage_photos d
       JOIN bookings b ON b.id = d.booking_id
      WHERE b.reference = ? AND d.id = ?`, [ref, Number(id) || 0]);
  if (!row) throw Object.assign(new Error('Photo not found'), { status: 404 });

  await pool.query('DELETE FROM booking_damage_photos WHERE id = ?', [row.id]);
  /* The row is the record; a file left behind is harmless, a failed
     delete that loses the row is not. */
  try {
    await fs.unlink(path.join(__dirname, '..', row.file_path));
  } catch { /* already gone */ }
  return { ok: true };
}

/* Admin Photos tab — every booking that has at least one condition photo,
   with the customer's name, license, phone, email, and both photo sets
   keyed by type. */
async function allBookingsWithPhotos() {
  const [rows] = await pool.query(`
    SELECT b.id AS _bookingId, b.reference AS id, c.full_name AS name,
           c.email, c.phone, c.license_number AS license,
           v.slug AS carId, v.name AS vehicleName, v.model_year AS vehicleYear,
           v.image_path AS vehicleImage,
           b.starts_on AS \`from\`, b.ends_on AS \`to\`,
           b.status, b.return_notice_given_at, b.expected_return_on
      FROM bookings b
      JOIN customers c ON c.id = b.customer_id
      JOIN vehicles  v ON v.id = b.vehicle_id
     ORDER BY b.created_at DESC, b.id DESC`);

  const [photos] = await pool.query(`
    SELECT p.booking_id, p.photo_type, p.stage, p.file_path
      FROM booking_photos p`);

  const byBooking = new Map();
  for (const p of photos) {
    if (!byBooking.has(p.booking_id)) byBooking.set(p.booking_id, { pickup: {}, return: {} });
    const stage = p.stage === 'return' ? 'return' : 'pickup';
    byBooking.get(p.booking_id)[stage][p.photo_type] = p.file_path;
  }

  /* Damage photos belong on this tab too — the office reviewing
     condition wants the marks the renter flagged, not just the five
     fixed angles. A list, since there can be any number. */
  const [damage] = await pool.query(`
    SELECT d.booking_id, d.id, d.file_path, d.note, d.stage
      FROM booking_damage_photos d
     ORDER BY d.uploaded_at ASC, d.id ASC`);
  const damageBy = new Map();
  for (const d of damage) {
    if (!damageBy.has(d.booking_id)) damageBy.set(d.booking_id, []);
    damageBy.get(d.booking_id).push({
      id: d.id, src: d.file_path, note: d.note || '', stage: d.stage
    });
  }

  /* Walkaround videos, grouped by stage so the dashboard can show
     each one beside the photos it belongs with. */
  const [vids] = await pool.query(`
    SELECT v.booking_id, v.id, v.stage, v.file_path, v.note,
           v.duration_secs, v.file_bytes, v.original_bytes
      FROM booking_videos v
     ORDER BY v.uploaded_at ASC, v.id ASC`);
  const videoBy = new Map();
  for (const v of vids) {
    if (!videoBy.has(v.booking_id)) {
      videoBy.set(v.booking_id, { pickup: [], return: [], damage: [] });
    }
    const bucket = videoBy.get(v.booking_id)[v.stage];
    if (bucket) bucket.push({
      id: v.id, src: v.file_path, note: v.note || '',
      durationSecs: v.duration_secs, bytes: v.file_bytes,
      originalBytes: v.original_bytes
    });
  }

  /* The signed agreement belongs on this tab too: it is the other
     document a customer hands back, and the office should not have to
     dig through the server to find it. Only signed copies — the blank
     one sent out is not evidence of anything. */
  const [docs] = await pool.query(`
    SELECT d.booking_id, d.id, d.file_path, d.signed_at
      FROM contract_documents d
     WHERE d.signed_at IS NOT NULL
     ORDER BY d.signed_at DESC, d.id DESC`);
  const docBy = new Map();
  for (const d of docs) {
    /* Newest signed copy wins; a re-signature supersedes the earlier one. */
    if (!docBy.has(d.booking_id)) {
      docBy.set(d.booking_id, {
        id: d.id,
        /* The guarded route, not a filesystem path: uploads/ is closed
           to direct URLs, so this id is how the dashboard reads it. */
        url: '/api/contract-file/' + d.id,
        filename: path.basename(String(d.file_path)),
        signedAt: d.signed_at
      });
    }
  }

  return rows
    .filter(r => {
      const pics = byBooking.get(r._bookingId);
      const dmg = damageBy.get(r._bookingId);
      const vid = videoBy.get(r._bookingId);
      return (pics && (Object.keys(pics.pickup).length || Object.keys(pics.return).length))
          || (dmg && dmg.length)
          /* a booking with only a video still belongs on this tab */
          || (vid && (vid.pickup.length || vid.return.length || vid.damage.length))
          || docBy.has(r._bookingId);
    })
    .map(r => ({
      id: r.id,
      name: r.name || '',
      email: r.email || '',
      phone: r.phone || '',
      license: r.license || '',
      carId: r.carId || '',
      vehicleName: r.vehicleName || '',
      vehicleYear: r.vehicleYear || '',
      vehicleImage: r.vehicleImage || '',
      from: r.from,
      to: r.to,
      status: r.status,
      expectedReturnOn: r.expected_return_on,
      pickup: (byBooking.get(r._bookingId) || {}).pickup || {},
      return: (byBooking.get(r._bookingId) || {}).return || {},
      damage: damageBy.get(r._bookingId) || [],
      videos: videoBy.get(r._bookingId)
              || { pickup: [], return: [], damage: [] },
      signedContract: docBy.get(r._bookingId) || null
    }));
}

/* Mark a pre-booking's fee as paid and promote it to Confirmed — the
   customer is now moving from the release queue into the bookings tab. */
async function markPrebookingPaid(reference) {
  const ref = safeRef(reference);
  const [[booking]] = await pool.query(
    `SELECT b.id, b.status, c.full_name, c.email, v.name AS vehicle_name,
            v.prebooking_amount
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       JOIN vehicles  v ON v.id = b.vehicle_id
      WHERE b.reference = ?`, [ref]
  );
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });
  if (booking.status !== 'Prebooked') {
    throw Object.assign(new Error('Only a Prebooked reservation can be marked as paid'), { status: 409 });
  }

  /* The fee is recorded and the reservation is handed to the Actions
     tab for approval — it is NOT confirmed here. Taking the money and
     confirming the booking are two different decisions: the office
     still has to check the licence, the contract and the dates before
     the customer is onboarded, and doing both on one click skipped
     that review entirely.

     `confirmation_sent` marks it as under confirmation so the customer
     sees that it is being processed while it waits. */
  await pool.query(
    `UPDATE bookings SET prebooking_paid = 1, confirmation_sent = 1
      WHERE id = ?`, [booking.id]
  );

  /* The reservation fee is money the customer has already handed over.
     Marking the reservation paid used to flip a flag and nothing more,
     so the fee vanished: a customer who paid $100 to hold a $300 car
     was then billed the full $300. It is recorded as a payment against
     the booking so it comes off the balance like any other.

     Only when nothing is already recorded — if the office confirmed
     the customer's screenshot, or took the fee in cash, that payment
     is already in the ledger and adding it again would double-count. */
  const fee = Number(booking.prebooking_amount || 0);
  if (fee > 0) {
    const [[existing]] = await pool.query(
      `SELECT COUNT(*) AS n FROM payment_proofs
        WHERE booking_id = ? AND stage = 'prebooking'
          AND verified_at IS NOT NULL`, [booking.id]
    );
    if (!Number(existing.n)) {
      await pool.query(
        `INSERT INTO payment_proofs
           (booking_id, file_path, method, amount, note, stage, verified_at)
         VALUES (?, NULL, 'cash', ?, 'Reservation fee', 'prebooking', NOW())`,
        [booking.id, round2(fee)]
      );
    }
    await syncPaymentMethod(booking.id);
    const s = await settlement(booking.id);
    await pool.query('UPDATE bookings SET pending_amount = ? WHERE id = ?',
                     [s.pending, booking.id]);
  }

  return { reference: ref, name: booking.full_name, vehicle: booking.vehicle_name };
}

/* ----------------------- payment proofs ---------------------------
   Once a rental is approved the customer uploads a screenshot of each
   transfer. A long rental produces several, so they are kept as rows
   against the booking and shown to the office in the dashboard.
------------------------------------------------------------------- */

async function addPaymentProof(bookingRef, file,
                               { amount = null, note = '', stage = 'rental', expected = null } = {}) {
  const ref = safeRef(bookingRef);
  const [[booking]] = await pool.query(
    `SELECT id, reference, total, toll_charges, advance_amount, pending_amount
       FROM bookings WHERE reference = ?`, [ref]
  );
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });

  /* Images only — never a document the browser might execute. */
  const ext = safeExt(file, IMAGE_TYPES, 'payment');
  const fileName = `payment-${ref}-${Date.now()}${ext}`;
  const filePath = path.join(__dirname, '..', 'uploads', 'payments', fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, file.buffer);

  const stored = `uploads/payments/${fileName}`;
  const clean = amount === null || amount === '' ? null
    : Math.max(0, Number(amount) || 0);

  /* What this payment ought to cover. Passed in for a pre-booking fee;
     otherwise it is whatever the booking still owes. */
  const owed = expected !== null && expected !== undefined
    ? Math.max(0, Number(expected) || 0)
    : Number(booking.pending_amount || 0) > 0
      ? Number(booking.pending_amount)
      : null;

  /* Read the figure off the image. Advisory only — `verified_at` stays
     null until a person agrees, and nothing touches a balance here. */
  let scan = { amount: null, status: null, shortfall: 0 };
  try {
    scan = await scanPayment(file.buffer, owed);
  } catch { /* a scan problem must never block the upload */ }

  const [res] = await pool.query(
    `INSERT INTO payment_proofs
       (booking_id, file_path, amount, note, stage, scanned_amount, scan_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [booking.id, stored, clean, String(note || '').slice(0, 300) || null,
     stage === 'prebooking' ? 'prebooking' : 'rental',
     scan.amount, scan.status]
  );

  /* An uploaded screenshot means the money came in online. Cash is the
     office ticking its own box, so it never overwrites this. */
  await pool.query(
    `UPDATE bookings SET payment_method = 'online'
      WHERE id = ? AND (payment_method IS NULL OR payment_method = 'online')`,
    [booking.id]
  );

  /* The reservation deposit, written onto the booking.

     booking_deposit was added by migration 022 and then read in six
     places while nothing ever wrote it, so every booking reported a
     deposit of 0.00 however much the customer had actually sent. The
     dashboard's Deposit column had nothing to show, which is the
     "deposit does not appear" fault.

     What goes in is the CLAIM — what the customer says they paid, or
     failing that what OCR read off the image. It is not proof, and it
     is deliberately not treated as proof: prebookingPaid still counts
     only verified payments, so the office's confirmation step is
     unchanged. This figure exists so the claim is visible at all.

     Only for the prebooking stage, and only when the booking has no
     deposit yet: a second screenshot against the same booking must not
     silently rewrite the first figure. */
  if (stage === 'prebooking') {
    const claimed = clean !== null && clean !== undefined ? Number(clean)
                  : scan.amount !== null ? Number(scan.amount)
                  : null;
    if (claimed !== null && isFinite(claimed) && claimed > 0) {
      await pool.query(
        `UPDATE bookings SET booking_deposit = ?
          WHERE id = ? AND (booking_deposit IS NULL OR booking_deposit = 0)`,
        [round2(claimed), booking.id]
      );
    }
  }

  /* The office needs to know money has been claimed, so it is chased
     rather than sitting unseen in a folder. */
  const scanNote = scan.amount !== null
    ? ` Scan read $${scan.amount.toFixed(2)}` +
      (scan.status === 'short' ? ` — $${scan.shortfall.toFixed(2)} short of what is owed.` : '.')
    : '';
  await notify({
    audience: 'admin',
    bookingId: booking.id,
    kind: 'payment-proof',
    title: 'Payment proof uploaded',
    body: `${ref}: the customer uploaded proof of payment` +
          (clean ? ` for $${clean.toFixed(2)}` : '') + '.' + scanNote,
    link: 'admin.html#bookings'
  });

  return {
    path: stored,
    id: res.insertId,
    scan: { amount: scan.amount, status: scan.status, shortfall: scan.shortfall }
  };
}

/* An admin agrees with a proof's amount. This is the only place a scan
   is allowed to move money: until now the figure was a suggestion.
   A shortfall is added to the pending balance so it carries forward. */
async function verifyPaymentProof(proofId, { amount = null, applyShortfall = true } = {}) {
  const id = Number(proofId) || 0;
  const [[proof]] = await pool.query(
    `SELECT p.id, p.booking_id, p.amount, p.scanned_amount, p.scan_status,
            b.reference, b.pending_amount, b.total, b.toll_charges
       FROM payment_proofs p
       JOIN bookings b ON b.id = p.booking_id
      WHERE p.id = ?`, [id]
  );
  if (!proof) throw Object.assign(new Error('Payment proof not found'), { status: 404 });

  /* The admin's figure wins; otherwise fall back to what was claimed,
     then to what the scan read. */
  const settled = amount !== null && amount !== ''
    ? Math.max(0, Number(amount) || 0)
    : (proof.amount !== null ? Number(proof.amount)
       : proof.scanned_amount !== null ? Number(proof.scanned_amount) : 0);

  await pool.query(
    'UPDATE payment_proofs SET amount = ?, verified_at = NOW() WHERE id = ?',
    [settled, id]
  );

  /* The booking's method is re-summarised because verifying an upload
     may be the moment a cash-only booking becomes 'mixed'. */
  await syncPaymentMethod(proof.booking_id);

  /* Pending is re-derived from the whole ledger rather than subtracted
     from the previous figure. Subtracting would double-count when cash
     had already been recorded against this booking: that payment
     reduced pending once, and would reduce it again here. */
  let pending = Number(proof.pending_amount || 0);
  if (applyShortfall) {
    const s = await settlement(proof.booking_id);
    pending = s.pending;
    await pool.query('UPDATE bookings SET pending_amount = ? WHERE id = ?',
                     [pending, proof.booking_id]);
  }

  return { id, reference: proof.reference, amount: settled, pending };
}

/* Money is compared and stored to the cent; floating point drift
   would otherwise leave a booking a fraction short of settled. */
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* What a booking owes and what it has taken, across BOTH channels.
   Cash and uploaded transfers are rows in the same ledger, so a
   booking part-paid each way adds up instead of one overwriting the
   other. Only verified rows count toward `paid` — an unchecked
   screenshot must never make a debt look settled.

   `due` matches the Total column the office reads in the dashboard:
   the advance is a deposit charged on top, not money already in. */
/* Everything the Ref popup shows: who the booking is for, who referred
   them, and every payment received against it.

   The payment rows are the ledger itself rather than the summed totals
   the dashboard columns use — the office wants to see that $900 arrived
   as cash on the 21st and $400 online on the 28th, which a single
   `verifiedPaid` figure cannot tell them. Unverified rows are returned
   too, marked, because a screenshot awaiting a tick is exactly what the
   admin opens this popup to find. */
async function bookingDetail(ref) {
  const [[b]] = await pool.query(
    `SELECT b.id, b.reference, b.referral_name, b.referral_phone,
            b.starts_on, b.pickup_time,
            c.full_name, c.email, c.phone, c.license_number
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
      WHERE b.reference = ?`, [ref]
  );
  if (!b) throw Object.assign(new Error('Unknown booking'), { status: 404 });

  const [rows] = await pool.query(
    `SELECT id, method, amount, note, uploaded_at, verified_at, stage,
            (file_path IS NOT NULL) AS hasImage
       FROM payment_proofs
      WHERE booking_id = ?
      ORDER BY COALESCE(verified_at, uploaded_at) ASC, id ASC`, [b.id]
  );

  /* The five fixed angles at each end of the rental, and any damage
     the renter flagged along the way. */
  const [photos] = await pool.query(
    `SELECT photo_type, stage, file_path
       FROM booking_photos
      WHERE booking_id = ?
      ORDER BY FIELD(photo_type,'odometer','front','rear','left','right')`,
    [b.id]
  );
  const [damage] = await pool.query(
    `SELECT id, file_path, note, stage, uploaded_at
       FROM booking_damage_photos
      WHERE booking_id = ?
      ORDER BY uploaded_at ASC, id ASC`,
    [b.id]
  );
  const [clips] = await pool.query(
    `SELECT id, stage, file_path, note, duration_secs,
            file_bytes, original_bytes
       FROM booking_videos
      WHERE booking_id = ?
      ORDER BY uploaded_at ASC, id ASC`,
    [b.id]
  );

  return {
    ref: b.reference,
    name: b.full_name,
    email: b.email,
    phone: b.phone,
    licenseNumber: b.license_number,
    referralName: b.referral_name || '',
    referralPhone: b.referral_phone || '',
    pickupDate: b.starts_on || null,
    /* TIME comes back as 'HH:MM:SS'; the form field wants 'HH:MM'. */
    pickupTime: b.pickup_time ? String(b.pickup_time).slice(0, 5) : '',
    payments: rows.map(r => ({
      id: r.id,
      method: r.method === 'cash' ? 'cash' : 'online',
      amount: Number(r.amount || 0),
      note: r.note || '',
      /* The date the money is recorded against: when it was confirmed
         if it has been, otherwise when it arrived. */
      date: (r.verified_at || r.uploaded_at) || null,
      verified: Boolean(r.verified_at),
      hasImage: Boolean(r.hasImage),
      stage: r.stage || null
    })),
    /* The condition photos, so the Ref sheet can show them beside the
       money — the office checks both in the same pass, and sending
       them to another tab to see the car breaks that. */
    photos: {
      pickup: photos.filter(p => p.stage !== 'return')
        .map(p => ({ type: p.photo_type, src: p.file_path })),
      return: photos.filter(p => p.stage === 'return')
        .map(p => ({ type: p.photo_type, src: p.file_path })),
      damage: damage.map(d => ({
        id: d.id, src: d.file_path, note: d.note || '',
        stage: d.stage, at: d.uploaded_at
      }))
    },
    /* The optional walkaround clips, grouped the same way. */
    videos: ['pickup', 'return', 'damage'].reduce((out, stage) => {
      out[stage] = clips.filter(v => v.stage === stage).map(v => ({
        id: v.id, src: v.file_path, note: v.note || '',
        durationSecs: v.duration_secs, bytes: v.file_bytes,
        originalBytes: v.original_bytes
      }));
      return out;
    }, {})
  };
}

/* The office records who referred a renter after the fact, so this is
   an update on its own rather than part of the booking form. Blank
   clears the field — a referral entered by mistake must be removable. */
async function setReferral(ref, { name = '', phone = '', pickupTime } = {}) {
  const clean = v => {
    const s = String(v == null ? '' : v).trim();
    return s ? s.slice(0, 120) : null;
  };

  /* The collection time is agreed with the renter and typed here, so it
     is saved with the referral rather than needing its own trip. Only
     'HH:MM' or 'HH:MM:SS' is accepted; anything else is refused rather
     than silently stored as a time nobody agreed to. */
  let time;
  if (pickupTime !== undefined) {
    const t = String(pickupTime == null ? '' : pickupTime).trim();
    if (!t) {
      time = null;
    } else if (/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(t)) {
      time = t.length === 5 ? `${t}:00` : t;
    } else {
      throw Object.assign(
        new Error('Enter the pickup time as HH:MM, for example 14:30'),
        { status: 400 });
    }
  }

  const sets = ['referral_name = ?', 'referral_phone = ?'];
  const args = [clean(name), clean(phone)];
  if (time !== undefined) { sets.push('pickup_time = ?'); args.push(time); }
  args.push(ref);

  const [res] = await pool.query(
    `UPDATE bookings SET ${sets.join(', ')} WHERE reference = ?`, args
  );
  if (!res.affectedRows) {
    throw Object.assign(new Error('Unknown booking'), { status: 404 });
  }
  return {
    referralName: clean(name) || '',
    referralPhone: clean(phone) || '',
    pickupTime: time ? time.slice(0, 5) : ''
  };
}

async function settlement(booking) {
  /* Takes the numeric id used internally, or a BK- reference from the
     API, so callers on either side need no lookup of their own. */
  const byRef = typeof booking === 'string' && !/^\d+$/.test(booking);
  const [[b]] = await pool.query(
    `SELECT id, total, toll_charges, advance_amount, booking_deposit
       FROM bookings
      WHERE ${byRef ? 'reference' : 'id'} = ?`,
    [byRef ? safeRef(booking) : booking]
  );
  if (!b) throw Object.assign(new Error('Booking not found'), { status: 404 });
  const bookingId = b.id;

  const [[sums]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN verified_at IS NOT NULL THEN amount END), 0)            AS paid,
       COALESCE(SUM(CASE WHEN verified_at IS NOT NULL AND method = 'cash'
                         THEN amount END), 0)                                         AS paid_cash,
       COALESCE(SUM(CASE WHEN verified_at IS NOT NULL AND method = 'online'
                         THEN amount END), 0)                                         AS paid_online,
       SUM(CASE WHEN verified_at IS NULL THEN 1 ELSE 0 END)                           AS unverified
     FROM payment_proofs WHERE booking_id = ?`, [bookingId]
  );

  /* Three sums, and they behave differently.

       rent + tolls      what the rental costs
       booking_deposit   paid online to reserve the car. Money already
                         received, so it comes OFF the rent.
       advance_amount    the refundable security advance, one month's
                         rent. Paid at pickup and returned at handback,
                         so it is owed ON TOP of the rent but is not
                         revenue.

     For a $500/month car with $100 down: $400 of rent remains, plus a
     $500 advance — $900 due at pickup, of which $500 comes back. */
  const rent    = Number(b.total || 0) + Number(b.toll_charges || 0);
  const deposit = Number(b.booking_deposit || 0);
  const advance = Number(b.advance_amount || 0);

  /* What the customer still has to hand over. */
  const due     = rent + advance;
  const paid    = Number(sums.paid || 0) + deposit;

  return {
    rent:       round2(rent),
    due:        round2(due),
    deposit:    round2(deposit),
    advance:    round2(advance),
    paid:       round2(paid),
    paidCash:   round2(Number(sums.paid_cash || 0)),
    paidOnline: round2(Number(sums.paid_online || 0)),
    pending:    round2(Math.max(0, due - paid)),
    unverified: Number(sums.unverified || 0)
  };
}

/* Summarises the ledger back onto the booking: 'cash', 'online',
   'mixed' when money came both ways, or NULL when nothing is recorded.
   Kept in step on every write so existing screens stay correct. */
async function syncPaymentMethod(bookingId) {
  const [[m]] = await pool.query(
    `SELECT
       SUM(method = 'cash')   AS cash,
       SUM(method = 'online') AS online
     FROM payment_proofs WHERE booking_id = ?`, [bookingId]
  );
  const cash = Number(m && m.cash || 0), online = Number(m && m.online || 0);
  const method = cash && online ? 'mixed' : cash ? 'cash' : online ? 'online' : null;
  await pool.query('UPDATE bookings SET payment_method = ? WHERE id = ?', [method, bookingId]);
  return method;
}

/* Money taken at the counter. It joins the same ledger as an uploaded
   transfer — no file, and verified on the spot, because the person
   recording it is the person who took it. The pending balance is then
   re-derived from everything paid rather than overwritten, so a cash
   payment that follows an online one does not erase it. */
async function addCashPayment(bookingRef, { amount, note = '', pending = null } = {}) {
  const ref = safeRef(bookingRef);
  const [[booking]] = await pool.query(
    'SELECT id, reference FROM bookings WHERE reference = ?', [ref]
  );
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });

  const paid = Number(amount);
  if (!isFinite(paid) || paid <= 0) {
    throw Object.assign(new Error('Enter a valid cash amount'), { status: 400 });
  }

  await pool.query(
    `INSERT INTO payment_proofs
       (booking_id, file_path, method, amount, note, stage, verified_at)
     VALUES (?, NULL, 'cash', ?, ?, 'rental', NOW())`,
    [booking.id, round2(paid), String(note || '').slice(0, 300) || null]
  );

  await syncPaymentMethod(booking.id);
  const s = await settlement(booking.id);

  /* An explicit figure from the office wins — they may be carrying a
     balance forward deliberately — otherwise the shortfall stands. */
  const finalPending = pending === null || pending === undefined || pending === ''
    ? s.pending
    : round2(Math.max(0, Number(pending) || 0));

  await pool.query('UPDATE bookings SET pending_amount = ? WHERE id = ?',
                   [finalPending, booking.id]);

  return { reference: ref, ...s, pending: finalPending };
}

/* Record how a payment arrived. 'cash' is the office saying so; the
   online case is set automatically when a screenshot is uploaded. */
async function setPaymentMethod(bookingRef, method) {
  const ref = safeRef(bookingRef);
  const clean = method === 'cash' ? 'cash' : method === 'online' ? 'online' : null;
  const [res] = await pool.query(
    'UPDATE bookings SET payment_method = ? WHERE reference = ?', [clean, ref]
  );
  if (!res.affectedRows) throw Object.assign(new Error('Booking not found'), { status: 404 });
  return { reference: ref, paymentMethod: clean };
}

/* Every proof for one booking, newest first. */
async function paymentProofs(bookingRef) {
  const ref = safeRef(bookingRef);
  const [rows] = await pool.query(
    `SELECT p.id, p.file_path, p.method, p.amount, p.note, p.uploaded_at,
            p.stage, p.scanned_amount, p.scan_status, p.verified_at
       FROM payment_proofs p
       JOIN bookings b ON b.id = p.booking_id
      WHERE b.reference = ?
      ORDER BY p.uploaded_at DESC`, [ref]
  );
  return rows.map(r => ({
    id: r.id,
    path: r.file_path,
    method: r.method || 'online',
    amount: r.amount === null ? null : Number(r.amount),
    note: r.note || '',
    uploadedAt: r.uploaded_at,
    stage: r.stage || 'rental',
    scannedAmount: r.scanned_amount === null ? null : Number(r.scanned_amount),
    scanStatus: r.scan_status || null,
    verified: Boolean(r.verified_at)
  }));
}

/* Proof counts for the whole bookings table, so the dashboard can show
   a badge without a query per row. */
async function paymentProofCounts() {
  const [rows] = await pool.query(
    `SELECT b.reference, COUNT(p.id) AS n, MAX(p.uploaded_at) AS latest
       FROM bookings b
       JOIN payment_proofs p ON p.booking_id = b.id
      GROUP BY b.reference`
  );
  const out = {};
  for (const r of rows) out[r.reference] = { count: Number(r.n), latest: r.latest };
  return out;
}

/* ------------------------- toll sheet import ----------------------
   Match a statement of plate numbers and charges to bookings, and put
   each amount on the right one.

   A plate identifies a vehicle, not a booking, so a car with a history
   has several candidates. The charge belongs to whoever had the car —
   so the booking whose dates cover the statement is chosen, falling
   back to the most recent one that has started. A vehicle with no such
   booking is reported rather than guessed at.
------------------------------------------------------------------- */
const { readTollSheet, plateKey } = require('./tollsheet.js');
const { scanPayment, scanOdometer } = require('./paymentscan.js');

/* The booking deposit: what a customer pays up front to hold a car.
   Every new booking needs evidence of at least this much before the
   office will look at it. */
const BOOKING_DEPOSIT_MIN = 100;

/* The office's handling charge on a toll, added on top of what the
   operator billed:

     up to $20      no charge
     over $20       +$5
     $50 and over   +$10

   Banded, not cumulative — a $60 toll takes $10, not $15.

   The two boundaries deliberately differ: $20 is exclusive ("more than
   20") while $50 is inclusive ("more than or equal to 50"), which is
   how the office worded each one. */
const TOLL_FEE_BANDS = [
  { from: 50, fee: 10, inclusive: true },
  { from: 20, fee: 5,  inclusive: false }
];

/* Read a deposit screenshot BEFORE the booking exists.

   The customer is still on the car page — there is no reference to
   attach a proof to yet — so this scans the image, reports what it
   found, and stores nothing. The booking is created only once the
   amount clears, and the same image is then filed against it. */
async function scanDeposit(imageBase64, { minimum = BOOKING_DEPOSIT_MIN } = {}) {
  let buffer;
  try {
    buffer = Buffer.from(String(imageBase64 || ''), 'base64');
  } catch {
    return { ok: false, amount: null, status: 'unreadable', minimum };
  }
  if (!buffer.length) {
    return { ok: false, amount: null, status: 'unreadable', minimum };
  }
  if (buffer.length > 8e6) {
    throw Object.assign(new Error('That image is too large — 8MB maximum.'),
                        { status: 413 });
  }

  const scan = await scanPayment(buffer, minimum);
  const amount = scan.amount;

  /* Three outcomes the page has to tell apart: a readable amount that
     covers the deposit, a readable amount that falls short, and an
     image we could not read at all. The last is NOT treated as a
     failure to pay — OCR misreads happen, and refusing an honest
     customer over a blurry photo is worse than letting the office
     check it — so it goes through with a flag on it. */
  const readable = amount !== null;
  /* No rounding tolerance here: $99.99 is not a $100 deposit. The
     scanPayment() helper allows a cent either way, which suits an
     invoice total reached by adding lines up, but a minimum is a
     floor and reads better to a customer when it means what it says. */
  const covers = readable && amount >= minimum;

  return {
    ok: !readable || covers,
    amount,
    minimum,
    status: !readable ? 'unreadable' : covers ? 'ok' : 'short',
    shortfall: readable && !covers
      ? Math.round((minimum - amount) * 100) / 100
      : 0,
    confidence: scan.confidence
  };
}

function tollSurcharge(amount) {
  const n = Number(amount) || 0;
  for (const band of TOLL_FEE_BANDS) {
    if (band.inclusive ? n >= band.from : n > band.from) return band.fee;
  }
  return 0;
}

async function importTollSheet(fileBuffer, filename, { apply = false, on = null } = {}) {
  const sheet = readTollSheet(fileBuffer, filename);

  /* Every plate we know, keyed the same way the sheet is. */
  const [vehicles] = await pool.query(
    `SELECT id, slug, name, registration
       FROM vehicles
      WHERE registration IS NOT NULL AND registration <> ''`
  );
  const byPlate = new Map();
  for (const v of vehicles) byPlate.set(plateKey(v.registration), v);

  /* Candidate bookings for those vehicles, newest first. */
  const ids = vehicles.map(v => v.id);
  let bookingsByVehicle = new Map();
  if (ids.length) {
    const [rows] = await pool.query(
      `SELECT b.id, b.reference, b.vehicle_id, b.starts_on, b.ends_on,
              b.toll_charges, b.status, c.full_name AS customer
         FROM bookings b
         JOIN customers c ON c.id = b.customer_id
        WHERE b.vehicle_id IN (?)
          AND b.status IN ('Active', 'Confirmed', 'Completed', 'Prebooked')
        ORDER BY b.starts_on DESC`, [ids]
    );
    for (const r of rows) {
      if (!bookingsByVehicle.has(r.vehicle_id)) bookingsByVehicle.set(r.vehicle_id, []);
      bookingsByVehicle.get(r.vehicle_id).push(r);
    }
  }

  /* The date the charges relate to. Defaults to today, so "the booking
     that had the car" means the current one unless told otherwise. */
  const onDate = /^\d{4}-\d{2}-\d{2}$/.test(String(on || '')) ? String(on)
    : new Date().toISOString().slice(0, 10);

  const matched = [], unmatched = [];

  for (const entry of sheet.entries) {
    const vehicle = byPlate.get(entry.plateKey);
    if (!vehicle) {
      unmatched.push({ plate: entry.plate, amount: entry.amount, reason: 'no vehicle with that number' });
      continue;
    }
    const candidates = bookingsByVehicle.get(vehicle.id) || [];
    if (!candidates.length) {
      unmatched.push({ plate: entry.plate, amount: entry.amount,
                       vehicle: vehicle.name, reason: 'no booking for this vehicle' });
      continue;
    }
    const covering = candidates.find(b =>
      String(b.starts_on).slice(0, 10) <= onDate && onDate <= String(b.ends_on).slice(0, 10));
    const started = candidates.find(b => String(b.starts_on).slice(0, 10) <= onDate);
    const chosen = covering || started || candidates[0];

    /* What the operator billed, plus the office's handling charge. The
       invoice shows the total; both parts are reported so the preview
       can explain the difference rather than appearing to inflate the
       sheet. */
    const surcharge = tollSurcharge(entry.amount);
    const billed = Math.round((Number(entry.amount) + surcharge) * 100) / 100;

    matched.push({
      plate: entry.plate,
      amount: billed,
      tollAmount: Number(entry.amount),
      surcharge,
      crossings: entry.rows,
      vehicle: vehicle.name,
      reference: chosen.reference,
      customer: chosen.customer,
      from: String(chosen.starts_on).slice(0, 10),
      to: String(chosen.ends_on).slice(0, 10),
      previousTolls: Number(chosen.toll_charges || 0),
      exact: Boolean(covering)
    });
  }

  /* A preview runs the same matching and changes nothing, so the admin
     sees exactly what will happen before committing. */
  if (apply) {
    for (const m of matched) {
      await pool.query(
        'UPDATE bookings SET toll_charges = ? WHERE reference = ?',
        [m.amount, m.reference]
      );
    }
  }

  return {
    applied: Boolean(apply),
    onDate,
    totalRows: sheet.totalRows,
    matched,
    unmatched,
    skipped: sheet.skipped,
    totalAmount: Math.round(matched.reduce((s, m) => s + m.amount, 0) * 100) / 100
  };
}

module.exports = {
  pool, ping,
  importTollSheet, scanDeposit, BOOKING_DEPOSIT_MIN,
  addPaymentProof, paymentProofs, paymentProofCounts, verifyPaymentProof,
  addCashPayment, settlement, syncPaymentMethod, releaseForNormalBooking,
  bookingDetail, setReferral, freeVehicleIfUnheld,
  addDamagePhoto, damagePhotos, deleteDamagePhoto,
  setPaymentMethod,
  listVehicles, createVehicle, updateVehicle, deleteVehicle,
  listBookings, saveBooking, deleteBooking, releaseBooking,
  upcomingReleases, quoteBooking, setOdometer, markConfirmationSent,
  sendSlotConfirmationEmail, handoverBooking,
  createEnquiry,
  listEnquiries,
  setEnquiryHandled,
  unhandledEnquiryCount,
  sendContractEmail, handleContractUpload, listPendingContracts, bookingOwnerEmail,
  signContract, contractTerms, decideBooking, envValue, vehicleAvailability,
  listDocumentTemplates, getDocumentTemplate, activeDocumentTemplate,
  saveDocumentTemplate, activateDocumentTemplate,
  handleBookingVideoUpload, bookingVideos, deleteBookingVideo,
  mileageReport, setOdometer,
  giveReturnNotice, awaitingRelease, releaseVehicle, unreleaseVehicle,
  prebookingQueue, RETURN_NOTICE_DAYS, bookedVehicles,
  adminNotifications, customerNotifications, markNotificationsRead,
  bookingsForCustomer, sendInvoice, sendTollInvoice, verifyEmail, sendEmail,
  getContractByBooking, getLicenseByBooking, markContractSigned,
  getCustomerByEmail, updateCustomer,
  handleBookingPhotoUpload, allBookingsWithPhotos,
  markPrebookingPaid,
  sessionsAvailable, startSessionWatcher, loadActiveSessions,
  createAuthSession, authSessionActive, revokeAuthSession, revokeAuthSessionsForEmail,
  toggleVehicleVisibility
};
