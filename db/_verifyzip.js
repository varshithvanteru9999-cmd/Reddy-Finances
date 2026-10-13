/* ------------------------------------------------------------------
   Check what is actually inside the deployment zip.

     node db/_verifyzip.js deploy-all.zip

   Reads the central directory rather than shelling out, so the answer
   does not depend on shell quoting. Confirms the files the server needs
   are present and that no secrets were packaged.
------------------------------------------------------------------- */

const fs = require('fs');

const zipPath = process.argv[2] || 'deploy-all.zip';
const buf = fs.readFileSync(zipPath);

const names = [];
for (let i = 0; i < buf.length - 4; i++) {
  if (buf.readUInt32LE(i) === 0x02014b50) {          /* central dir header */
    const nameLen = buf.readUInt16LE(i + 28);
    const raw = buf.toString('utf8', i + 46, i + 46 + nameLen);
    names.push(raw.split('\\').join('/'));           /* Windows writes backslashes */
  }
}

const MUST_HAVE = [
  'package.json',
  'server/index.js', 'server/db.js', 'server/auth.js',
  'server/contract.js', 'server/invoice.js', 'server/emails.js',
  'db/setup.js', 'db/schema.sql',
  'js/app.js', 'js/store.js', 'js/ui.js', 'js/auth.js', 'js/notify.js',
  'css/style.css', 'css/admin.css',
  'index.html', 'admin.html', 'admin-login.html', 'bookings.html',
  'manifest.json', 'sw.js',
  'images/icons/icon-192.png', 'images/brand/logo.png'
];

const MUST_NOT = names.filter(n =>
  /(^|\/)\.env$/.test(n) || /node_modules/.test(n) || /(^|\/)\.git\//.test(n)
);

console.log(`entries: ${names.length}`);

const missing = MUST_HAVE.filter(f => !names.includes(f));
console.log(`\nrequired files: ${MUST_HAVE.length - missing.length}/${MUST_HAVE.length} present`);
if (missing.length) missing.forEach(f => console.log(`  MISSING  ${f}`));

console.log(`\nsecrets: ${MUST_NOT.length ? 'LEAK -> ' + MUST_NOT.join(', ')
                                          : 'clean (no .env, node_modules or .git)'}`);

const size = (fs.statSync(zipPath).size / 1048576).toFixed(1);
console.log(`\nsize: ${size} MB`);
process.exit(missing.length || MUST_NOT.length ? 1 : 0);
