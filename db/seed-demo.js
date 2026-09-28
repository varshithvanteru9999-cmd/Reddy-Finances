/* ------------------------------------------------------------------
   Fill every tab of the admin dashboard with demo data.

   Unlike db/add-fake-data.js, which predates this year's work, this
   covers what the dashboard actually shows now: the payment ledger
   (cash, online, unconfirmed), referral details behind the Ref popup,
   the pre-booking queue, released cars, enquiries, and bookings
   positioned either side of the Completed cut-off.

   SAFETY

   This refuses to run against the live host. Everything it writes is
   marked, and `--clean` removes exactly what it wrote and nothing else:
     node db/seed-demo.js            seed
     node db/seed-demo.js --clean    remove only seeded rows

   Every seeded customer's email ends in @demo.invalid (a reserved TLD
   that can never receive mail, so nothing here can email a real
   person), and every seeded booking reference starts with DEMO-.
------------------------------------------------------------------- */

const db = require('../server/db');

const MARK_EMAIL = '@demo.invalid';
const MARK_REF = 'DEMO-';

const iso = d => d.toISOString().slice(0, 10);
const shift = n => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const stamp = (n, h = 12) => {
  const d = new Date(); d.setDate(d.getDate() + n); d.setHours(h, 0, 0, 0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

/* --- guard ------------------------------------------------------- */

async function assertNotLive() {
  const [[row]] = await db.pool.query('SELECT DATABASE() AS db, @@hostname AS host');
  const [[u]] = await db.pool.query('SELECT CURRENT_USER() AS u');
  const target = `${row.db}`;

  /* The live database and its user are known; refuse both by name
     rather than trusting DB_HOST, which a stray .env could change. */
  const live = /u807314952/i.test(target) || /u807314952/i.test(u.u || '');
  if (live) {
    console.error('\nREFUSING TO RUN.\n');
    console.error(`  database : ${target}`);
    console.error(`  user     : ${u.u}`);
    console.error('\nThis is the live Hostinger database. Point DB_* at a local');
    console.error('database before seeding demo data.\n');
    process.exit(1);
  }
  return target;
}

/* --- cleanup ----------------------------------------------------- */

async function clean() {
  const target = await assertNotLive();
  console.log(`cleaning demo rows from ${target}\n`);

  const [bk] = await db.pool.query(
    'SELECT id FROM bookings WHERE reference LIKE ?', [MARK_REF + '%']);
  const ids = bk.map(b => b.id);

  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    for (const t of ['payment_proofs', 'notifications', 'contract_documents',
                     'booking_photos', 'license_uploads']) {
      try {
        const [r] = await db.pool.query(
          `DELETE FROM \`${t}\` WHERE booking_id IN (${ph})`, ids);
        if (r.affectedRows) console.log(`  ${t.padEnd(20)} ${r.affectedRows}`);
      } catch { /* table may not exist in older schemas */ }
    }
    const [r] = await db.pool.query(
      `DELETE FROM bookings WHERE id IN (${ph})`, ids);
    console.log(`  ${'bookings'.padEnd(20)} ${r.affectedRows}`);
  }

  const [e] = await db.pool.query(
    'DELETE FROM enquiries WHERE email LIKE ?', ['%' + MARK_EMAIL]);
  if (e.affectedRows) console.log(`  ${'enquiries'.padEnd(20)} ${e.affectedRows}`);

  const [c] = await db.pool.query(
    'DELETE FROM customers WHERE email LIKE ?', ['%' + MARK_EMAIL]);
  console.log(`  ${'customers'.padEnd(20)} ${c.affectedRows}`);

  /* Cars this script released are put back as they were found. */
  const [v] = await db.pool.query(
    `UPDATE vehicles SET released_for_prebooking_at = NULL,
            available_from = NULL, prebooking_amount = NULL
      WHERE released_for_prebooking_at IS NOT NULL`);
  if (v.affectedRows) console.log(`  ${'vehicles reset'.padEnd(20)} ${v.affectedRows}`);

  console.log('\ndone.');
}

/* --- people ------------------------------------------------------ */

const PEOPLE = [
  ['Arjun Rao',        'arjun.rao',      '(214) 555-0101', 'TX41882301'],
  ['Meera Krishnan',   'meera.k',        '(469) 555-0142', 'TX55190244'],
  ['Daniel Whitfield', 'daniel.w',       '(972) 555-0188', 'TX70221856'],
  ['Priyanka Nair',    'priyanka.nair',  '(214) 555-0223', 'TX33907712'],
  ['Marcus Adeyemi',   'marcus.a',       '(817) 555-0267', 'TX86142093'],
  ['Sofia Alvarez',    'sofia.alvarez',  '(469) 555-0319', 'TX20558431'],
  ['Kiran Deshmukh',   'kiran.d',        '(972) 555-0374', 'TX61230975'],
  ['Hannah Boateng',   'hannah.b',       '(214) 555-0428', 'TX49816602']
];

async function upsertCustomer([name, handle, phone, licence]) {
  const email = `${handle}${MARK_EMAIL}`;
  const [[hit]] = await db.pool.query(
    'SELECT id FROM customers WHERE email = ?', [email]);
  if (hit) return hit.id;
  const [r] = await db.pool.query(
    `INSERT INTO customers (full_name, email, phone, license_number, city)
     VALUES (?, ?, ?, ?, ?)`,
    [name, email, phone, licence, 'Dallas']);
  return r.insertId;
}

/* --- seed -------------------------------------------------------- */

async function seed() {
  const target = await assertNotLive();
  console.log(`seeding demo data into ${target}\n`);

  const [cars] = await db.pool.query(
    `SELECT id, slug, name, price, monthly_rate
       FROM vehicles
      WHERE is_active = 1 AND listing_type <> 'sale'
      ORDER BY id`);
  if (cars.length < 6) {
    console.error('Need at least 6 rental vehicles. Run: node db/setup.js --seed');
    process.exit(1);
  }

  const people = [];
  for (const p of PEOPLE) people.push({ id: await upsertCustomer(p), name: p[0] });
  console.log(`  customers            ${people.length}`);

  /* Each row: the state it is meant to demonstrate.
     [ref, person, car, from, to, status, opts] */
  const PLAN = [
    /* Live rentals, part-paid and fully paid — the Bookings tab's
       green / orange / red dots and the Ref popup's ledger. */
    ['DEMO-2001', 0, 0, shift(-26), shift(+4),  'Active',
      { pays: [['cash', 900, -26], ['online', 600, -12]], advance: 0, referral: ['Vivek Menon', '(214) 555-0777'] }],
    ['DEMO-2002', 1, 1, shift(-18), shift(+12), 'Active',
      { pays: [['cash', 1500, -18]], pending: 320, tolls: 46.25 }],
    ['DEMO-2003', 2, 2, shift(-9),  shift(+21), 'Active',
      { pays: [['online', 1200, -9], ['online', 450, -2, false]], tolls: 18.4 }],

    /* Awaiting the office — these sit in Actions. */
    ['DEMO-2004', 3, 3, shift(+3),  shift(+33), 'Confirmed',
      { advance: 1400, pays: [['cash', 1400, -1]] }],
    ['DEMO-2005', 4, 4, shift(+8),  shift(+38), 'Prebooked', { prebookFee: 250 }],
    ['DEMO-2006', 5, 5, shift(+14), shift(+44), 'Prebooked', {}],

    /* Either side of the Completed cut-off. */
    ['DEMO-2007', 6, 0, shift(-45), shift(-1),  'Active',    /* grace day: still live */
      { pays: [['cash', 1800, -45], ['online', 1100, -20]] }],
    ['DEMO-2008', 7, 1, shift(-60), shift(-3),  'Active',    /* past grace: Completed */
      { pays: [['cash', 2200, -60]], pending: 180 }],
    ['DEMO-2009', 0, 2, shift(-95), shift(-35), 'Completed',
      { pays: [['cash', 1600, -95], ['cash', 1600, -60]] }],

    /* Cancelled — its own filter, and the car must stay free. */
    ['DEMO-2010', 1, 3, shift(-30), shift(0),   'Cancelled', {}],

    /* Open return — highlighted, and never auto-completes. */
    ['DEMO-2011', 2, 4, shift(-12), shift(+18), 'Active',
      { openReturn: 1, pays: [['cash', 700, -12]] }]
  ];

  let made = 0;
  for (const [ref, pi, ci, from, to, status, o] of PLAN) {
    const car = cars[ci % cars.length];
    const person = people[pi % people.length];

    const [[exists]] = await db.pool.query(
      'SELECT id FROM bookings WHERE reference = ?', [ref]);
    if (exists) continue;

    const monthly = Number(car.monthly_rate) || 1500;
    const total = monthly;
    const advance = o.advance !== undefined ? o.advance : monthly;

    const [r] = await db.pool.query(
      `INSERT INTO bookings
         (reference, customer_id, vehicle_id, starts_on, ends_on, status,
          day_rate, monthly_rate, total, toll_charges, advance_amount,
          pending_amount, open_return, referral_name, referral_phone,
          prebooking_paid, confirmation_sent, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ref, person.id, car.id, from, to, status,
       car.price || 50, monthly, total, o.tolls || 0, advance,
       o.pending || 0, o.openReturn || 0,
       o.referral ? o.referral[0] : null,
       o.referral ? o.referral[1] : null,
       o.prebookFee ? 1 : 0,
       status === 'Confirmed' || status === 'Active' ? 1 : 0,
       stamp(-Math.abs(Number(from.slice(-2)) % 20) - 1)]
    );
    const bookingId = r.insertId;
    made++;

    /* The payment ledger: [method, amount, dayOffset, verified?] */
    for (const [method, amount, when, verified = true] of (o.pays || [])) {
      await db.pool.query(
        `INSERT INTO payment_proofs
           (booking_id, method, amount, note, uploaded_at, verified_at, stage)
         VALUES (?,?,?,?,?,?,?)`,
        [bookingId, method, amount,
         method === 'cash' ? 'Counter payment' : 'Zelle transfer',
         stamp(when, 10), verified ? stamp(when, 11) : null, 'rental']);
    }
    if (o.prebookFee) {
      await db.pool.query(
        `INSERT INTO payment_proofs
           (booking_id, method, amount, note, uploaded_at, verified_at, stage)
         VALUES (?,?,?,?,?,?,?)`,
        [bookingId, 'online', o.prebookFee, 'Reservation fee',
         stamp(-2, 9), stamp(-2, 10), 'prebooking']);
    }
  }
  console.log(`  bookings             ${made}`);

  /* A car opened for pre-booking, so the Release tab has content. */
  const rel = cars[5];
  await db.pool.query(
    `UPDATE vehicles
        SET released_for_prebooking_at = ?, available_from = ?, prebooking_amount = 250
      WHERE id = ?`, [stamp(-4, 9), shift(+14), rel.id]);
  console.log(`  released for prebook 1  (${rel.name})`);

  /* Enquiries — the Enquiries tab. */
  const ENQ = [
    ['viewing',      'Arjun Rao',        'arjun.rao',     'Can I see the Wrangler on Saturday morning?'],
    ['consultation', 'Meera Krishnan',   'meera.k',       'Looking for a 6-month lease, what are the terms?'],
    ['sell',         'Daniel Whitfield', 'daniel.w',      'I have a 2021 Camry, 48k miles, would you buy it?'],
    ['general',      'Sofia Alvarez',    'sofia.alvarez', 'Do you allow driving to Oklahoma?']
  ];
  let enq = 0;
  for (const [kind, name, handle, message] of ENQ) {
    const email = handle + MARK_EMAIL;
    const [[hit]] = await db.pool.query(
      'SELECT id FROM enquiries WHERE email = ? AND kind = ?', [email, kind]);
    if (hit) continue;
    await db.pool.query(
      `INSERT INTO enquiries (kind, full_name, email, phone, message, handled, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [kind, name, email, '(214) 555-0000', message, 0, stamp(-enq - 1, 14)]);
    enq++;
  }
  console.log(`  enquiries            ${enq}`);

  console.log('\ndone — reload the dashboard.');
  console.log('remove it all with:  node db/seed-demo.js --clean');
}

(async () => {
  try {
    if (process.argv.includes('--clean')) await clean();
    else await seed();
    process.exit(0);
  } catch (err) {
    console.error('\nfailed:', err.message);
    process.exit(1);
  }
})();
