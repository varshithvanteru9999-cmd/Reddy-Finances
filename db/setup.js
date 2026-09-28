/* ------------------------------------------------------------------
   Build the database from nothing, in the right order.

     node db/setup.js            use the .env connection
     node db/setup.js --seed     also load the sample fleet

   Runs schema.sql then every migration in order. Safe to re-run: the
   schema uses CREATE TABLE IF NOT EXISTS and each migration guards its
   own changes, so a second run reports "already applied" rather than
   failing.

   Point .env at the remote database first — this writes wherever
   DB_HOST says, so check it before running against production.
------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function loadEnv() {
  const out = {};
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  } catch { /* fall through to process.env */ }
  return { ...out, ...process.env };
}

const { stripDbStatements, splitOffViews } = require('./_strip.js');

const env = loadEnv();
const withSeed = process.argv.includes('--seed');

/* Order matters: the schema first, then each migration as it was written. */
const FILES = [
  'schema.sql',
  'migrate-000-confirmation-sent.sql',
  'migrate-001.sql',
  'migrate-002-contracts.sql',
  'migrate-003-license-number.sql',
  'migrate-004-booking-photos.sql',
  'migrate-005-return-notice.sql',
  'migrate-006-notifications.sql',
  'migrate-007-enquiry-viewing.sql',
  'migrate-008-advance-open-return.sql',
  'migrate-009-fuel-normalise.sql',
  'migrate-010-return-photos.sql',
  'migrate-011-prebooking-amount.sql',
  'migrate-012-vehicle-reg.sql',
  'migrate-013-pending-payment.sql',
  'migrate-014-payment-method.sql',
  'migrate-015-payment-ledger.sql',
  'migrate-016-referral.sql',
  'migrate-017-pickup-time.sql',
  'migrate-018-damage-photos.sql',
  'migrate-019-pickup-location.sql'
];

(async () => {
  const host = env.DB_HOST || '127.0.0.1';
  const name = env.DB_NAME || 'reddy_finances';

  console.log(`Target: ${env.DB_USER}@${host}:${env.DB_PORT || 3306}/${name}`);
  if (!/^(127\.0\.0\.1|localhost)$/.test(host)) {
    console.log('This is a REMOTE database. Ctrl+C now if that is not what you meant.\n');
    await new Promise(r => setTimeout(r, 4000));
  }

  let conn;
  try {
    conn = await mysql.createConnection({
      host,
      port: Number(env.DB_PORT || 3306),
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      multipleStatements: true,
      /* Hostinger and most managed MySQL require TLS; allow the
         self-signed certificates they commonly present. */
      ssl: /^(127\.0\.0\.1|localhost)$/.test(host)
        ? undefined
        : { rejectUnauthorized: false }
    });
  } catch (err) {
    console.log('\nCould not connect.');
    console.log(`  ${err.code || ''} ${err.message}`);
    console.log('\nCheck that:');
    console.log('  * Remote MySQL is enabled and allows this machine\'s IP');
    console.log('  * DB_HOST, DB_USER and DB_PASSWORD in .env are right');
    process.exit(1);
  }

  /* The database itself may not exist yet on a fresh host. */
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${name}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`
  ).catch(() => {
    /* Managed hosts often pre-create it and forbid CREATE DATABASE. */
    console.log('(could not create the database — assuming it already exists)');
  });
  await conn.query(`USE \`${name}\``);

  let deferredViews = '';

  for (const file of FILES) {
    const full = path.join(__dirname, file);
    if (!fs.existsSync(full)) { console.log(`  skip   ${file} (not found)`); continue; }

    /* The files were written for a local `reddy_finances` database, so
       they carry CREATE DATABASE and USE statements. A managed host
       names the database for you and forbids creating one, so strip
       both and let the connection's own database apply. */
    let sql = stripDbStatements(fs.readFileSync(full, 'utf8'));

    /* schema.sql ends with views that read columns the later migrations
       add. On a fresh database those columns do not exist yet, so hold
       the views back and create them once everything else is in. */
    if (file === 'schema.sql') {
      const parts = splitOffViews(sql);
      sql = parts.body;
      deferredViews = parts.views;
    }


    process.stdout.write(`  apply  ${file} ... `);
    try {
      await conn.query(sql);
      console.log('ok');
    } catch (err) {
      /* Re-running is expected to hit "already exists" style errors. */
      const benign = ['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME', 'ER_TABLE_EXISTS_ERROR',
                      'ER_DUP_ENTRY', 'ER_CANT_DROP_FIELD_OR_KEY'];
      if (benign.includes(err.code)) {
        console.log('already applied');
      } else {
        console.log('FAILED');
        console.log(`     ${err.code}: ${err.sqlMessage || err.message}`);
        await conn.end();
        process.exit(1);
      }
    }
  }

  if (deferredViews.trim()) {
    process.stdout.write('  views  from schema.sql ... ');
    try { await conn.query(deferredViews); console.log('ok'); }
    catch (err) { console.log(`FAILED: ${err.sqlMessage || err.message}`); }
  }

  if (withSeed) {
    const seed = path.join(__dirname, 'seed.sql');
    if (fs.existsSync(seed)) {
      process.stdout.write('  seed   seed.sql ... ');
      try {
        await conn.query(stripDbStatements(fs.readFileSync(seed, 'utf8')));
        console.log('ok');
      } catch (err) {
        console.log(`skipped (${err.code || err.message})`);
      }
    }
  }

  const [tables] = await conn.query(
    `SELECT TABLE_NAME t FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY t`, [name]
  );
  console.log(`\nDone. ${tables.length} tables: ${tables.map(r => r.t).join(', ')}`);

  if (!withSeed) {
    console.log('\nNo vehicles loaded. To add the sample fleet:  node db/setup.js --seed');
  }

  await conn.end();
})();
