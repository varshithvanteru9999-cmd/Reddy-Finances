/* ------------------------------------------------------------------
   Populate the database with rich fake data for the admin dashboard:
   - Customers with driver license numbers
   - Bookings in every status (Prebooked, Confirmed, Active, Completed, Cancelled)
   - Toll charges and billing breakdowns
   - Spread across 2025–2026 for month/year filters
   - Run: node db/add-fake-data.js
------------------------------------------------------------------- */

delete require.cache[require.resolve('../server/db')];
const d = require('../server/db');

const LICENSES = [
  'TX12345678', 'TX87654321', 'CA98765432', 'NY55667788',
  'FL11223344', 'IL44332211', 'AZ99887766', 'GA77665544',
  'WA33445566', 'CO66554433', 'MA22118899', 'TN88991122',
  'OH55443322', 'PA11229988', 'NC33221199', 'OH77886655',
  'TX44556677', 'CA88776655', 'NY33221100', 'FL99887711',
  'IL11223344', 'AZ55667788', 'GA99887766', 'WA77665544',
  'CO22334455', 'MA66554433', 'TN22118899', 'OH55443322',
  'PA33221199', 'NC88991122'
];

const NAMES = [
  'Alex Morgan', 'Jordan Lee', 'Sam Patel', 'Casey Brooks',
  'Riley Chen', 'Drew Harrison', 'Quinn Foster', 'Avery Sullivan',
  'Blake Torres', 'Cameron Diaz', 'Dakota Reed', 'Finley Stone',
  'Harper James', 'Jamie Fox', 'Kendall Ray', 'Logan Hayes',
  'Mason Clark', 'Nora Bennett', 'Oscar Rivera', 'Parker Young',
  'Reese Howard', 'Skyler King', 'Taylor Quinn', 'Uma Sharma',
  'Vera Campbell', 'Wade Mitchell', 'Xena Lopez', 'Yara Shah',
  'Zane Cooper', 'Bella Dawson'
];

const CITIES = ['Dallas, TX', 'Plano, TX', 'Irving, TX', 'Fort Worth, TX', 'Arlington, TX', 'Frisco, TX', 'McKinney, TX', 'Garland, TX'];
const VEHICLES = [
  'tesla-model-3', 'ford-mustang-gt', 'toyota-rav4-hybrid',
  'chevrolet-suburban', 'bmw-330i', 'jeep-wrangler',
  'porsche-911', 'audi-q5', 'ford-f150', 'honda-accord',
  'mercedes-c300', 'rivian-r1t'
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function phone() {
  const a = ['214','469','972','682','817','512','361','409'];
  return `(${pick(a)}) 555-${String(Math.floor(1000 + Math.random() * 9000))}`;
}
function dateStr(y, m, d) { return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }

function randomDate(year, month, dayRange) {
  const d = Math.min(dayRange[1], 1 + Math.floor(Math.random() * (dayRange[1])));
  return dateStr(year, month, d);
}

const bookings = [
  // ── ACTIVE ──────────────────────────────────
  { nameIdx: 0,  licIdx: 0,  car: 'tesla-model-3',      from: '2026-08-25', to: '2026-09-10', status: 'Active',     tolls: 12.50 },
  { nameIdx: 1,  licIdx: 1,  car: 'bmw-330i',            from: '2026-08-20', to: '2026-08-31', status: 'Active',     tolls: 8.75 },
  { nameIdx: 2,  licIdx: 2,  car: 'ford-mustang-gt',     from: '2026-08-28', to: '2026-09-05', status: 'Active',     tolls: 0 },
  { nameIdx: 3,  licIdx: 3,  car: 'jeep-wrangler',       from: '2026-08-15', to: '2026-09-15', status: 'Active',     tolls: 24.00 },
  { nameIdx: 4,  licIdx: 4,  car: 'toyota-rav4-hybrid',  from: '2026-08-22', to: '2026-09-01', status: 'Active',     tolls: 5.25 },

  // ── CONFIRMED (upcoming, within 30 days) ────
  { nameIdx: 5,  licIdx: 5,  car: 'chevrolet-suburban',  from: '2026-09-05', to: '2026-09-12', status: 'Confirmed',  tolls: 0 },
  { nameIdx: 6,  licIdx: 6,  car: 'porsche-911',         from: '2026-09-10', to: '2026-09-15', status: 'Confirmed',  tolls: 0 },
  { nameIdx: 7,  licIdx: 7,  car: 'audi-q5',             from: '2026-09-14', to: '2026-09-20', status: 'Confirmed',  tolls: 0 },
  { nameIdx: 8,  licIdx: 8,  car: 'tesla-model-3',       from: '2026-09-18', to: '2026-09-25', status: 'Confirmed',  tolls: 0 },
  { nameIdx: 9,  licIdx: 9,  car: 'bmw-330i',            from: '2026-09-22', to: '2026-09-28', status: 'Confirmed',  tolls: 0 },

  // ── CONFIRMED (October) ────────────────────
  { nameIdx: 10, licIdx: 10, car: 'ford-f150',           from: '2026-10-01', to: '2026-10-08', status: 'Confirmed',  tolls: 0 },
  { nameIdx: 11, licIdx: 11, car: 'honda-accord',        from: '2026-10-05', to: '2026-10-10', status: 'Confirmed',  tolls: 0 },
  { nameIdx: 12, licIdx: 12, car: 'mercedes-c300',       from: '2026-10-12', to: '2026-10-18', status: 'Confirmed',  tolls: 0 },
  { nameIdx: 13, licIdx: 13, car: 'rivian-r1t',          from: '2026-10-20', to: '2026-10-28', status: 'Confirmed',  tolls: 0 },

  // ── PREBOOKED (November–December) ──────────
  { nameIdx: 14, licIdx: 14, car: 'jeep-wrangler',       from: '2026-11-01', to: '2026-11-08', status: 'Prebooked',  tolls: 0 },
  { nameIdx: 15, licIdx: 15, car: 'tesla-model-3',       from: '2026-11-10', to: '2026-11-15', status: 'Prebooked',  tolls: 0 },
  { nameIdx: 16, licIdx: 16, car: 'ford-mustang-gt',     from: '2026-11-18', to: '2026-11-25', status: 'Prebooked',  tolls: 0 },
  { nameIdx: 17, licIdx: 17, car: 'bmw-330i',            from: '2026-12-01', to: '2026-12-08', status: 'Prebooked',  tolls: 0 },
  { nameIdx: 18, licIdx: 18, car: 'chevrolet-suburban',  from: '2026-12-10', to: '2026-12-18', status: 'Prebooked',  tolls: 0 },
  { nameIdx: 19, licIdx: 19, car: 'porsche-911',         from: '2026-12-20', to: '2026-12-28', status: 'Prebooked',  tolls: 0 },

  // ── COMPLETED (2026 recent past) ───────────
  { nameIdx: 20, licIdx: 20, car: 'toyota-rav4-hybrid',  from: '2026-07-01', to: '2026-07-08', status: 'Completed',  tolls: 15.00 },
  { nameIdx: 21, licIdx: 21, car: 'ford-mustang-gt',     from: '2026-07-10', to: '2026-07-15', status: 'Completed',  tolls: 0 },
  { nameIdx: 22, licIdx: 22, car: 'audi-q5',             from: '2026-07-18', to: '2026-07-25', status: 'Completed',  tolls: 22.50 },
  { nameIdx: 23, licIdx: 23, car: 'jeep-wrangler',       from: '2026-06-01', to: '2026-06-10', status: 'Completed',  tolls: 0 },
  { nameIdx: 24, licIdx: 24, car: 'honda-accord',        from: '2026-06-15', to: '2026-06-20', status: 'Completed',  tolls: 7.50 },
  { nameIdx: 25, licIdx: 25, car: 'bmw-330i',            from: '2026-05-05', to: '2026-05-12', status: 'Completed',  tolls: 0 },

  // ── COMPLETED (2025 — cross-year, month filter testing) ──
  { nameIdx: 26, licIdx: 26, car: 'tesla-model-3',       from: '2025-08-12', to: '2025-09-30', status: 'Completed',  tolls: 18.00 },
  { nameIdx: 27, licIdx: 27, car: 'chevrolet-suburban',  from: '2025-07-01', to: '2025-07-10', status: 'Completed',  tolls: 0 },
  { nameIdx: 28, licIdx: 28, car: 'ford-f150',           from: '2025-12-20', to: '2026-01-03', status: 'Completed',  tolls: 30.00 },
  { nameIdx: 29, licIdx: 29, car: 'mercedes-c300',       from: '2025-11-01', to: '2025-11-08', status: 'Completed',  tolls: 0 },

  // ── CANCELLED ─────────────────────────────
  { nameIdx: 10, licIdx: 10, car: 'rivian-r1t',          from: '2026-08-01', to: '2026-08-08', status: 'Cancelled',  tolls: 0 },
  { nameIdx: 15, licIdx: 15, car: 'audi-q5',             from: '2026-09-20', to: '2026-09-28', status: 'Cancelled',  tolls: 0 },
  { nameIdx: 20, licIdx: 20, car: 'porsche-911',         from: '2026-11-05', to: '2026-11-12', status: 'Cancelled',  tolls: 0 },
];

async function seed() {
  const conn = await d.pool.getConnection();
  try {
    await conn.beginTransaction();

    let customersCreated = 0;
    let bookingsCreated = 0;
    const customerCache = {};

    for (const b of bookings) {
      const name = NAMES[b.nameIdx];
      const email = name.toLowerCase().replace(/ /g, '.') + '@example.com';
      const ph = phone();
      const city = pick(CITIES);
      const lic = LICENSES[b.licIdx];

      // Find or create customer
      if (!customerCache[name]) {
        // Check if customer exists
        const [[existing]] = await conn.query(
          'SELECT id FROM customers WHERE full_name = ? LIMIT 1', [name]
        );
        if (existing) {
          // Update with license number if missing
          await conn.query(
            'UPDATE customers SET license_number = COALESCE(license_number, ?) WHERE id = ?',
            [lic, existing.id]
          );
          customerCache[name] = existing.id;
        } else {
          const [res] = await conn.query(
            'INSERT INTO customers (full_name, email, phone, city, license_number) VALUES (?, ?, ?, ?, ?)',
            [name, email, ph, city, lic]
          );
          customerCache[name] = res.insertId;
          customersCreated++;
        }
      }

      const customerId = customerCache[name];

      // Check if booking already exists for this customer + dates
      const [[existingBooking]] = await conn.query(
        'SELECT id FROM bookings WHERE customer_id = ? AND starts_on = ? LIMIT 1',
        [customerId, b.from]
      );
      if (existingBooking) continue;

      // Generate reference
      const [[maxRef]] = await conn.query(
        "SELECT MAX(CAST(SUBSTRING(reference, 4) AS UNSIGNED)) AS n FROM bookings WHERE reference LIKE 'BK-%'"
      );
      const nextNum = (maxRef?.n || 0) + 1 + bookingsCreated;
      const ref = `BK-${String(nextNum).padStart(4, '0')}`;

      // Get vehicle info
      const [[vehicle]] = await conn.query(
        'SELECT id, price, monthly_rate, listing_type FROM vehicles WHERE slug = ?', [b.car]
      );
      if (!vehicle) { console.log(`  SKIP vehicle ${b.car} not found`); continue; }

      const dayRate = Number(vehicle.price);
      const monthlyRate = Number(vehicle.monthly_rate || dayRate * 30);
      const from = new Date(b.from + 'T00:00:00');
      const to = new Date(b.to + 'T00:00:00');
      const days = Math.max(1, Math.round((to - from) / 86400000));
      let total;
      if (vehicle.listing_type === 'rental') {
        total = Math.round((monthlyRate / 30) * days * 100) / 100;
      } else {
        total = dayRate;
      }

      // Build billing breakdown
      const breakdown = JSON.stringify([{
        label: `${b.from.slice(0,7)}`,
        from: b.from,
        to: b.to,
        days: days,
        amount: total,
        perDay: Math.round((monthlyRate / 30) * 100) / 100,
        whole: false,
        monthLength: 30,
        note: `${days} of 30 days at ${(monthlyRate / 30).toFixed(2)}/day`
      }]);

      await conn.query(
        `INSERT INTO bookings
           (reference, customer_id, vehicle_id, starts_on, ends_on, status,
            day_rate, monthly_rate, total, toll_charges, billing_breakdown, confirmation_sent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ref, customerId, vehicle.id, b.from, b.to, b.status,
         dayRate, monthlyRate, total, b.tolls || 0, breakdown, b.status === 'Prebooked' ? 0 : 1]
      );
      bookingsCreated++;
    }

    await conn.commit();
    console.log(`\nDone!`);
    console.log(`  ${customersCreated} new customers created`);
    console.log(`  ${bookingsCreated} new bookings created`);

    // Show summary
    const [stats] = await d.pool.query(`
      SELECT status, COUNT(*) as n, 
             ROUND(AVG(total), 0) as avg_total,
             SUM(toll_charges) as total_tolls
      FROM bookings GROUP BY status ORDER BY FIELD(status, 'Active','Confirmed','Prebooked','Completed','Cancelled')
    `);
    console.log('\nBooking summary:');
    stats.forEach(s => console.log(`  ${s.status}: ${s.n} (avg $${s.avg_total}, tolls $${s.total_tolls})`));

    const [licCount] = await d.pool.query('SELECT COUNT(*) as n FROM customers WHERE license_number IS NOT NULL');
    console.log(`\n  ${licCount[0].n} customers have license numbers`);

  } catch (err) {
    await conn.rollback();
    console.error('Error:', err.message);
  } finally {
    conn.release();
    process.exit(0);
  }
}

seed();
