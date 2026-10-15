/* ------------------------------------------------------------------
   Clear every trace of customer activity and start fresh.
   KEEPS the fleet: vehicles and vehicle_features are never touched.

       node db/clear-customers.js            dry run — shows what WOULD go
       node db/clear-customers.js --confirm  backs up, then deletes

   What goes:
       bookings and everything hanging off them — condition photos,
       damage photos, walkaround videos, signed contracts, licence
       uploads, payment proofs, notifications
       customers
       enquiries (viewing requests and contact messages)
       auth_sessions (everyone is signed out; staff sign in again)
       the uploaded FILES behind those rows

   What stays:
       vehicles, vehicle_features        the fleet
       document_templates                the rental agreement wording

   A backup is written first, always, to db/backups/. It holds real
   names, emails, phone numbers and licence numbers, so it is excluded
   from git and must not be committed or emailed.
------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
/* The application's own pool, so this reads the same .env the server
   does and talks to whichever database that points at. */
const db = require('../server/db');

/* Child rows go before their parents where the key is RESTRICT; the
   CASCADE ones would go on their own, but naming them keeps the count
   honest in the report and makes the order obvious to a reader. */
const CUSTOMER_TABLES = [
  'booking_damage_photos',
  'booking_photos',
  'booking_videos',
  'contract_documents',
  'license_uploads',
  'payment_proofs',
  'notifications',
  'bookings',
  'customers',
  'enquiries',
  'auth_sessions'
];

/* Never deleted. Listed so the script fails loudly if someone adds one
   of these to the list above by mistake. */
const KEEP = ['vehicles', 'vehicle_features', 'document_templates'];

/* Uploaded files belonging to customers. uploads/ itself stays — the
   server expects the directory to exist. */
const UPLOAD_DIRS = ['contracts', 'licenses', 'payments', 'photos', 'videos'];

const ROOT = path.join(__dirname, '..');

async function main() {
  const confirm = process.argv.includes('--confirm');
  const pool = db.pool;

  const [[dbRow]] = await pool.query('SELECT DATABASE() AS name');
  console.log('\nDatabase: ' + dbRow.name + '\n');

  /* ---- what is there ---- */
  const counts = {};
  for (const t of [...CUSTOMER_TABLES, ...KEEP]) {
    try {
      const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM `' + t + '`');
      counts[t] = r.n;
    } catch {
      counts[t] = null;          /* table not on this server yet */
    }
  }

  console.log('TO BE DELETED');
  let total = 0;
  for (const t of CUSTOMER_TABLES) {
    if (counts[t] === null) { console.log('   ' + t.padEnd(24) + '(no such table)'); continue; }
    console.log('   ' + t.padEnd(24) + counts[t] + ' row' + (counts[t] === 1 ? '' : 's'));
    total += counts[t];
  }

  console.log('\nTO BE KEPT');
  for (const t of KEEP) {
    console.log('   ' + t.padEnd(24)
      + (counts[t] === null ? '(no such table)' : counts[t] + ' row' + (counts[t] === 1 ? '' : 's')));
  }

  /* ---- the files ---- */
  let fileCount = 0, fileBytes = 0;
  for (const d of UPLOAD_DIRS) {
    const dir = path.join(ROOT, 'uploads', d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) { fileCount++; fileBytes += st.size; }
      } catch {}
    }
  }
  console.log('\nUPLOADED FILES');
  console.log('   ' + fileCount + ' file(s), '
    + (fileBytes / 1048576).toFixed(1) + ' MB across ' + UPLOAD_DIRS.join(', '));

  if (!confirm) {
    console.log('\n' + '-'.repeat(62));
    console.log('  DRY RUN — nothing has been changed.');
    console.log('  To go ahead:   node db/clear-customers.js --confirm');
    console.log('-'.repeat(62) + '\n');
    process.exit(0);
  }

  if (total === 0 && fileCount === 0) {
    console.log('\nNothing to clear — already empty.\n');
    process.exit(0);
  }

  /* ---- back up first, always ---- */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = path.join(__dirname, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, 'customer-data-' + stamp + '.json');

  const dump = { takenAt: new Date().toISOString(), database: dbRow.name, tables: {} };
  for (const t of CUSTOMER_TABLES) {
    if (counts[t] === null) continue;
    const [rows] = await pool.query('SELECT * FROM `' + t + '`');
    dump.tables[t] = rows;
  }
  fs.writeFileSync(backupFile, JSON.stringify(dump, null, 2), 'utf8');
  console.log('\nBackup written:');
  console.log('   ' + backupFile);
  console.log('   ' + (fs.statSync(backupFile).size / 1024).toFixed(0) + ' KB — real customer details, keep it private');

  /* ---- delete ---- */
  console.log('\nClearing...');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const t of CUSTOMER_TABLES) {
      if (counts[t] === null) continue;
      const [res] = await conn.query('DELETE FROM `' + t + '`');
      console.log('   ' + t.padEnd(24) + res.affectedRows + ' deleted');
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error('\nFAILED — rolled back, nothing was deleted.');
    console.error('   ' + err.message);
    process.exit(1);
  } finally {
    conn.release();
  }

  /* Reset the reference counter so the next booking is not BK-1043 on
     an empty table. Done after the commit: a failed ALTER must not
     take the deletion down with it. */
  try {
    await pool.query('ALTER TABLE bookings AUTO_INCREMENT = 1');
    await pool.query('ALTER TABLE customers AUTO_INCREMENT = 1');
  } catch { /* not fatal; references simply continue from where they were */ }

  /* ---- the files ----

     Only when the database being cleared is the one this installation
     actually serves. uploads/ sits beside the application, not beside
     the database, so pointing the script at a copy (a test database,
     a restored dump) and having it delete the live server's files
     would destroy signed contracts that copy never owned.

     Read straight from the .env FILE, not through db.envValue: that
     merges process.env over .env, so a DB_NAME passed on the command
     line would agree with itself and the check would always pass. The
     file is the only record of which database this installation
     actually serves. */
  let envDb = 'reddy_finances';
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = raw.match(/^\s*DB_NAME\s*=\s*(.+)$/m);
    if (m) envDb = m[1].trim();
  } catch { /* no .env — assume the default name */ }
  const servesThisDb = envDb === dbRow.name;

  if (!servesThisDb) {
    console.log('   uploaded files          SKIPPED — connected to "'
      + dbRow.name + '" but this installation serves "' + envDb
      + '", so uploads/ does not belong to these rows');
  } else {
    let removed = 0;
    for (const d of UPLOAD_DIRS) {
      const dir = path.join(ROOT, 'uploads', d);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f === '.gitkeep') continue;
        try { fs.unlinkSync(path.join(dir, f)); removed++; } catch {}
      }
    }
    console.log('   uploaded files          ' + removed + ' deleted');
  }

  /* ---- prove it ---- */
  console.log('\nAfter:');
  let left = 0;
  for (const t of CUSTOMER_TABLES) {
    if (counts[t] === null) continue;
    const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM `' + t + '`');
    left += r.n;
    if (r.n) console.log('   STILL THERE: ' + t + ' = ' + r.n);
  }
  for (const t of KEEP) {
    if (counts[t] === null) continue;
    const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM `' + t + '`');
    const ok = r.n === counts[t];
    console.log('   ' + t.padEnd(24) + r.n + ' row' + (r.n === 1 ? '' : 's')
      + (ok ? '  kept' : '  CHANGED — was ' + counts[t]));
  }

  console.log('\n' + '='.repeat(62));
  console.log(left === 0
    ? '  Done. Customer data cleared, fleet intact.'
    : '  WARNING: ' + left + ' customer row(s) remain.');
  console.log('  Backup: ' + backupFile);
  console.log('='.repeat(62) + '\n');
  process.exit(left === 0 ? 0 : 1);
}

main().catch(err => { console.error('\n' + err.message + '\n'); process.exit(1); });
