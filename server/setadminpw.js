/* ------------------------------------------------------------------
   Set or change the admin dashboard password.

     node server/setadminpw.js "new password"
     node server/setadminpw.js "new password" admin@yourdomain.com

   The password is hashed with scrypt and only the hash and its salt are
   written to .env — the password itself is never stored.

   Note: whatever you type here lands in your shell history. Clear it
   afterwards, or change the password again from a fresh terminal.
------------------------------------------------------------------- */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const password = process.argv[2];
const email = process.argv[3];

if (!password) {
  console.log('Usage: node server/setadminpw.js "new password" [admin@email]');
  process.exit(1);
}
if (password.length < 10) {
  console.log('Please choose a password of at least 10 characters.');
  process.exit(1);
}

const envPath = path.join(__dirname, '..', '.env');
let env = '';
try {
  env = fs.readFileSync(envPath, 'utf8');
} catch {
  console.log('No .env file found — copy .env.example to .env first.');
  process.exit(1);
}

/* Keep the existing address unless a new one was given. */
const current = (env.match(/^ADMIN_EMAIL=(.*)$/m) || [])[1];
const finalEmail = (email || current || '').trim();
if (!finalEmail) {
  console.log('No admin email set yet — pass one:');
  console.log('  node server/setadminpw.js "new password" admin@yourdomain.com');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');

/* Replace the whole block so repeated runs never stack up. */
env = env.replace(/\n*# -+ Admin dashboard login -+[\s\S]*$/, '');
env = env.replace(/^ADMIN_(EMAIL|PASSWORD_SALT|PASSWORD_HASH)=.*$/gm, '');
env = env.replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '');

env += '\n\n# ------------------- Admin dashboard login -------------------\n'
     + '# The password is stored as a scrypt hash, never in plain text.\n'
     + '# To change it:  node server/setadminpw.js "new password"\n'
     + `ADMIN_EMAIL=${finalEmail}\n`
     + `ADMIN_PASSWORD_SALT=${salt}\n`
     + `ADMIN_PASSWORD_HASH=${hash}\n`;

fs.writeFileSync(envPath, env);

console.log('Admin password updated.');
console.log(`  email : ${finalEmail}`);
console.log('  hash  : stored in .env (the password itself was not saved)');
console.log('\nRestart the server for it to take effect.');
