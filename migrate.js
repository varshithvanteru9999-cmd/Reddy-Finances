const { pool } = require('./server/db.js');
const fs = require('fs');

async function run() {
  try {
    const sql = fs.readFileSync('db/migrate-004-booking-photos.sql', 'utf8');
    await pool.query(sql);
    console.log('Migration successful');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
run();
