/* ------------------------------------------------------------------
   Demo data for testing.

   The existing rows were too uniform to exercise the app: one
   customer, every booking Prebooked, every deposit equal to the whole
   rental, and no payments, photos or enquiries at all. Bugs hid in
   that — the deposit being charged instead of credited looked correct
   when the deposit happened to equal the total.

   This seeds a spread that touches every state the screens render:
   each booking status, part-paid and fully-settled ledgers, verified
   and unverified payments, pickup and return photos, damage with
   notes, and a signed contract.

     node db/seed-demo.js          add the demo rows
     node db/seed-demo.js --reset  remove them first, then add

   Only touches rows it created (emails on @example.com, and the
   bookings attached to them), so real data is left alone.
------------------------------------------------------------------- */

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const db = require(path.join(__dirname, '..', 'server', 'db.js'));

const RESET = process.argv.includes('--reset');
/* --wipe-all clears EVERY customer and booking, not just the demo
   rows, so the dashboard starts from a known state. The fleet is left
   alone — vehicles are configuration, not test data. */
const WIPE_ALL = process.argv.includes('--wipe-all');

/* A small PNG in a given colour, so the photo grids have something
   real to show rather than broken images. */
function png(r, g, b, w = 160, h = 120) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3;
      /* a soft gradient, so the thumbnails are distinguishable */
      raw[o]     = Math.min(255, r + Math.floor((x / w) * 40));
      raw[o + 1] = Math.min(255, g + Math.floor((y / h) * 30));
      raw[o + 2] = b;
    }
  }
  let T = null;
  const crc32 = buf => {
    if (!T) {
      T = [];
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        T[n] = c;
      }
    }
    let c = 0xffffffff;
    for (const x of buf) c = T[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

/* The demo customers.

   My Bookings finds a booking by the SIGNED-IN address, so seeding
   against addresses you can actually sign in with is what makes the
   page show something rather than sit empty. Those were hard-coded
   here as real Gmail addresses — which is fine on your own machine and
   wrong in a public repository, where scrapers harvest them.

   So they come from the environment instead. Put your own in .env:

     SEED_EMAILS=you@gmail.com,second@gmail.com

   and the seed uses them; with nothing set it falls back to example.com
   addresses, which seed cleanly but cannot be signed in as. */
const SEED_EMAILS = String(process.env.SEED_EMAILS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const CUSTOMERS = [
  ['Demo Customer One',   SEED_EMAILS[0] || 'demo.one@example.com',   '(214) 555-0118', 'TX4471902'],
  ['Demo Customer Two',   SEED_EMAILS[1] || 'demo.two@example.com',   '(469) 555-0143', 'TX8830215'],
  ['Demo Customer Three', SEED_EMAILS[2] || 'demo.three@example.com', '(972) 555-0177', 'TX2259461']
];

/* --reset matches on these exact addresses rather than a domain, so it
   removes what the seed created and nothing else. */
const DEMO_EMAILS = CUSTOMERS.map(c => c[1]);

const iso = d => d.toISOString().slice(0, 10);
const daysFrom = n => { const d = new Date(); d.setDate(d.getDate() + n); return d; };

/* Everything customer-shaped, whoever it belongs to. Used by
   --wipe-all; the fleet and its features are untouched. */
async function wipeEverything() {
  const [all] = await db.pool.query('SELECT id FROM bookings');
  const ids = all.map(r => r.id);

  for (const table of ['booking_photos', 'booking_damage_photos', 'payment_proofs']) {
    const [files] = await db.pool.query(`SELECT file_path FROM ${table}`);
    for (const f of files) { try { fs.unlinkSync(f.file_path); } catch {} }
    await db.pool.query(`DELETE FROM ${table}`);
  }
  const [docs] = await db.pool.query('SELECT file_path FROM contract_documents');
  for (const d of docs) { try { fs.unlinkSync(d.file_path); } catch {} }

  await db.pool.query('DELETE FROM contract_documents');
  await db.pool.query('DELETE FROM license_uploads');
  await db.pool.query('DELETE FROM notifications');
  await db.pool.query('DELETE FROM bookings');
  await db.pool.query('DELETE FROM enquiries');
  await db.pool.query('DELETE FROM customers');

  /* A car left flagged for pre-booking has nothing holding it now. */
  await db.pool.query(
    `UPDATE vehicles SET released_for_prebooking_at = NULL,
            available_from = NULL, prebooking_amount = NULL`);

  return ids.length;
}

async function wipe() {
  const [rows] = await db.pool.query(
    `SELECT id FROM customers WHERE email IN (${DEMO_EMAILS.map(() => '?').join(',')})`,
    DEMO_EMAILS);
  if (!rows.length) return 0;
  const ids = rows.map(r => r.id);
  const [bk] = await db.pool.query(
    `SELECT id FROM bookings WHERE customer_id IN (${ids.map(() => '?').join(',')})`, ids);
  const bids = bk.map(r => r.id);

  if (bids.length) {
    const q = bids.map(() => '?').join(',');
    /* Remove the files too, or uploads/ fills with orphans. */
    for (const table of ['booking_photos', 'booking_damage_photos', 'payment_proofs']) {
      const [files] = await db.pool.query(
        `SELECT file_path FROM ${table} WHERE booking_id IN (${q})`, bids);
      for (const f of files) { try { fs.unlinkSync(f.file_path); } catch {} }
      await db.pool.query(`DELETE FROM ${table} WHERE booking_id IN (${q})`, bids);
    }
    await db.pool.query(`DELETE FROM contract_documents WHERE booking_id IN (${q})`, bids);
    await db.pool.query(`DELETE FROM notifications WHERE booking_id IN (${q})`, bids);
    await db.pool.query(`DELETE FROM bookings WHERE id IN (${q})`, bids);
  }
  await db.pool.query(
    `DELETE FROM enquiries WHERE email IN (${DEMO_EMAILS.map(() => '?').join(',')})`,
    DEMO_EMAILS);
  await db.pool.query(
    `DELETE FROM customers WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  return bids.length;
}

async function run() {
  if (WIPE_ALL) {
    const n = await wipeEverything();
    console.log(`cleared ${n} booking(s) and every customer — fleet kept`);
  } else if (RESET) {
    const n = await wipe();
    console.log(`removed ${n} demo booking(s) and their customers`);
  }

  /* ---- customers ---- */
  const custIds = [];
  for (const [name, email, phone, licence] of CUSTOMERS) {
    const [[existing]] = await db.pool.query(
      'SELECT id FROM customers WHERE email = ?', [email]);
    if (existing) { custIds.push(existing.id); continue; }
    const [res] = await db.pool.query(
      `INSERT INTO customers (full_name, email, phone, license_number)
       VALUES (?, ?, ?, ?)`, [name, email, phone, licence]);
    custIds.push(res.insertId);
  }
  console.log(`${custIds.length} demo customers ready`);

  /* ---- vehicles to book ---- */
  const [cars] = await db.pool.query(
    `SELECT id, slug, monthly_rate, price FROM vehicles
      WHERE listing_type = 'rental' AND is_active = 1 ORDER BY id`);
  if (cars.length < 4) {
    console.log('not enough rental vehicles to seed bookings');
    return;
  }

  /* Each row is one state the screens have to render.
     [customer, car, startOffset, days, status, deposit, tolls, payments, opts] */
  const PLAN = [
    /* --- in the Actions queue --- */
    /* minimum deposit, nothing else paid: the common new request */
    [0, 0,   2, 30, 'Prebooked', 100,  0, []],
    /* a bigger deposit, to prove the figure is not hard-coded */
    [1, 1,   6, 30, 'Prebooked', 250,  0, []],
    /* a payment waiting to be confirmed — the orange state */
    [2, 2,   9, 30, 'Prebooked', 100,  0, [{ amount: 250, method: 'online', verified: false }]],
    /* no deposit at all, so the "nothing paid" path is covered */
    [0, 3,  12, 30, 'Prebooked',   0,  0, []],

    /* --- confirmed, slot sent, waiting to be collected --- */
    [1, 0,   4, 30, 'Confirmed', 100,  0, [{ amount: 150, method: 'online', verified: true }]],
    /* open return: billed to month end, no fixed hand-back date */
    [2, 2,   3, 30, 'Confirmed', 100,  0, [], { openReturn: true }],

    /* --- out on the road --- */
    /* part paid with tolls added, so Pending has a real balance */
    [0, 1,  -6, 30, 'Active',    100, 45, [{ amount: 200, method: 'online', verified: true }]],
    /* settled in full, paid in two instalments through both channels */
    [1, 3, -10, 30, 'Active',    100,  0, [{ amount: 250, method: 'cash',   verified: true },
                                            { amount: 150, method: 'online', verified: true }]],

    /* --- finished --- */
    [2, 0, -45, 30, 'Completed', 100, 20, [{ amount: 420, method: 'cash',   verified: true }]],

    /* --- cancelled, for the filters to exclude --- */
    [0, 1,  14, 30, 'Cancelled',   0,  0, []]
  ];

  const made = [];
  for (const [ci, vi, startOff, days, status, deposit, tolls, payments, opts = {}] of PLAN) {
    const car = cars[vi % cars.length];
    const from = iso(daysFrom(startOff));
    const to = iso(daysFrom(startOff + days));
    const rate = Number(car.monthly_rate || car.price || 500);

    const [[last]] = await db.pool.query(
      "SELECT reference FROM bookings ORDER BY id DESC LIMIT 1");
    const next = 'BK-' + (Number(String(last?.reference || 'BK-1000').slice(3)) + 1);

    const [res] = await db.pool.query(
      /* Two separate sums: the booking deposit the customer paid
         online to reserve the car, and the refundable security
         advance, which is one month's rent. */
      `INSERT INTO bookings
         (reference, customer_id, vehicle_id, starts_on, ends_on, status,
          total, toll_charges, booking_deposit, advance_amount,
          pending_amount, monthly_rate, open_return)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [next, custIds[ci], car.id, from, to, status, rate, tolls,
       deposit, rate, rate, opts.openReturn ? 1 : 0]);

    const bookingId = res.insertId;
    made.push({ ref: next, status, deposit, bookingId, car: car.slug });

    /* ---- payment proofs ---- */
    for (const p of payments) {
      const name = `payment-${next}-${Date.now()}.png`;
      const dir = path.join(__dirname, '..', 'uploads', 'payments');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), png(40, 90, 70));
      await db.pool.query(
        `INSERT INTO payment_proofs
           (booking_id, file_path, method, amount, verified_at, stage, note)
         VALUES (?, ?, ?, ?, ?, 'rental', ?)`,
        [bookingId, `uploads/payments/${name}`, p.method, p.amount,
         p.verified ? new Date() : null,
         p.verified ? 'Confirmed against the bank statement' : '']);
    }

    /* ---- condition photos, for bookings that have been collected ---- */
    if (['Active', 'Completed'].includes(status)) {
      /* The column is an enum — 'left_side'/'right_side', not 'left'/'right'. */
      const angles = ['odometer', 'front', 'rear', 'left_side', 'right_side'];
      const dir = path.join(__dirname, '..', 'uploads', 'bookings');
      fs.mkdirSync(dir, { recursive: true });
      for (const a of angles) {
        const n1 = `booking-${next}-pickup-${a}-${Date.now()}.png`;
        fs.writeFileSync(path.join(dir, n1), png(70, 95, 150));
        await db.pool.query(
          `INSERT INTO booking_photos (booking_id, photo_type, stage, file_path)
           VALUES (?, ?, 'pickup', ?)`,
          [bookingId, a, `uploads/bookings/${n1}`]);
      }
      /* the finished rental also has its return set */
      if (status === 'Completed') {
        for (const a of angles) {
          const n2 = `booking-${next}-return-${a}-${Date.now()}.png`;
          fs.writeFileSync(path.join(dir, n2), png(95, 140, 100));
          await db.pool.query(
            `INSERT INTO booking_photos (booking_id, photo_type, stage, file_path)
             VALUES (?, ?, 'return', ?)`,
            [bookingId, a, `uploads/bookings/${n2}`]);
        }
      }
      /* a damage note, so that section is not always empty */
      const dn = `damage-${next}-pickup-${Date.now()}.png`;
      fs.writeFileSync(path.join(dir, dn), png(160, 80, 80));
      await db.pool.query(
        `INSERT INTO booking_damage_photos (booking_id, file_path, note, stage)
         VALUES (?, ?, ?, 'pickup')`,
        [bookingId, `uploads/bookings/${dn}`, 'Scuff on the nearside rear door']);

      /* a pick-up time, as the first photo upload would have set */
      await db.pool.query(
        'UPDATE bookings SET pickup_time = ?, pickup_location = ? WHERE id = ?',
        ['10:30:00', '1420 Main St, Dallas TX — front forecourt', bookingId]);
    }
  }

  /* ---- enquiries, one of each kind the dashboard handles ---- */
  const [[anyEnq]] = await db.pool.query(
    `SELECT COUNT(*) n FROM enquiries WHERE email IN (${DEMO_EMAILS.map(() => '?').join(',')})`,
    DEMO_EMAILS);
  if (!anyEnq.n) {
    const ENQ = [
      ['viewing', 0, 'Is the Porsche still available? I would like to see it this week.', null, null, null],
      ['sell',    1, 'Looking to sell my car — what would you offer?', 'Honda Civic', 2019, 48000],
      ['consultation', 2, 'I need a car for three months. What are my options?', null, null, null]
    ];
    for (const [kind, ci, message, make, year, miles] of ENQ) {
      await db.pool.query(
        `INSERT INTO enquiries
           (kind, full_name, email, phone, message, car_make, car_year, car_miles, zip_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [kind, CUSTOMERS[ci][0], CUSTOMERS[ci][1], CUSTOMERS[ci][2],
         message, make, year, miles, '75201']);
    }
    console.log(`${ENQ.length} enquiries added`);
  }

  console.log('');
  console.log('bookings created:');
  for (const m of made) {
    const s = await db.settlement(m.ref);
    console.log(`   ${m.ref}  ${m.status.padEnd(10)} ${m.car.padEnd(20)}` +
                ` rent $${String(s.rent).padEnd(7)}` +
                ` dep $${String(s.deposit).padEnd(5)}` +
                ` adv $${String(s.advance).padEnd(6)}` +
                ` due $${String(s.due).padEnd(7)} paid $${String(s.paid).padEnd(7)}` +
                ` pending $${s.pending}`);
  }
}

run()
  .then(() => { console.log(''); console.log('done'); process.exit(0); })
  .catch(e => { console.error('seed failed:', e.message); process.exit(1); });
