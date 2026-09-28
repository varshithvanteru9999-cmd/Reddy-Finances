/* ------------------------------------------------------------------
   Set the Gmail App Password and prove it works.

     node server/setmailpw.js "abcd efgh ijkl mnop"
     node server/setmailpw.js "abcdefghijklmnop" you@example.com

   Writes EMAIL_PASSWORD to .env, verifies it against Gmail, and — if an
   address is given — sends a real test message. Spaces are stripped, so
   you can paste the App Password exactly as Google shows it.
------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const raw = process.argv[2];
const testTo = process.argv[3];

if (!raw) {
  console.log('Usage: node server/setmailpw.js "your 16-character app password" [test@address]');
  console.log('');
  console.log('Get one at https://myaccount.google.com/apppasswords');
  console.log('(2-Step Verification must be on first.)');
  process.exit(1);
}

const pass = raw.replace(/\s+/g, '');

if (pass.length !== 16) {
  console.log(`That is ${pass.length} characters; a Google App Password is exactly 16.`);
  console.log('');
  console.log('It is NOT your normal Google password — it is a separate one');
  console.log('generated at https://myaccount.google.com/apppasswords and shown');
  console.log('as four groups of four letters, e.g. "abcd efgh ijkl mnop".');
  process.exit(1);
}

const envPath = path.join(__dirname, '..', '.env');
let env;
try {
  env = fs.readFileSync(envPath, 'utf8');
} catch {
  console.log('No .env found — copy .env.example to .env first.');
  process.exit(1);
}

const user = (env.match(/^EMAIL_USER=(.*)$/m) || [])[1];
if (!user) {
  console.log('EMAIL_USER is not set in .env.');
  process.exit(1);
}

/* Keep a copy of the old value so a bad paste can be undone. */
const previous = (env.match(/^EMAIL_PASSWORD=(.*)$/m) || [])[1] || '';

env = /^EMAIL_PASSWORD=/m.test(env)
  ? env.replace(/^EMAIL_PASSWORD=.*$/m, `EMAIL_PASSWORD=${pass}`)
  : env.replace(/\s*$/, '') + `\nEMAIL_PASSWORD=${pass}\n`;

fs.writeFileSync(envPath, env);
console.log(`Saved to .env for ${user}.`);

(async () => {
  const host = (env.match(/^EMAIL_HOST=(.*)$/m) || [])[1] || 'smtp.gmail.com';
  const port = Number((env.match(/^EMAIL_PORT=(.*)$/m) || [])[1] || 587);

  const tx = nodemailer.createTransport({
    host, port, secure: port === 465, auth: { user, pass }
  });

  process.stdout.write('Checking it with Gmail... ');
  try {
    await tx.verify();
    console.log('accepted.');
  } catch (err) {
    console.log('REJECTED.');
    console.log(`  ${String(err.response || err.message).split('\n')[0]}`);
    console.log('');
    console.log('The App Password was saved but Gmail will not accept it. Check that');
    console.log('you copied all 16 characters, and that it belongs to this account:');
    console.log(`  ${user}`);
    if (previous) {
      console.log('');
      console.log('To put the old value back, set this line in .env:');
      console.log(`  EMAIL_PASSWORD=${previous}`);
    }
    process.exit(1);
  }

  if (!testTo) {
    console.log('');
    console.log('Email is working. Restart the server to pick it up.');
    console.log('To send yourself a test:  node server/setmailpw.js "<same password>" you@example.com');
    process.exit(0);
  }

  process.stdout.write(`Sending a test message to ${testTo}... `);
  try {
    const from = (env.match(/^EMAIL_FROM=(.*)$/m) || [])[1] || `Reddy Finances <${user}>`;
    const info = await tx.sendMail({
      from, to: testTo,
      subject: 'Reddy Finances — email is working',
      html: '<p>This message was sent by your Reddy Finances server.</p>'
          + '<p>Booking confirmations, contracts and invoices will now go out normally.</p>'
    });
    console.log('sent.');
    console.log(`  message id: ${info.messageId}`);
    console.log('');
    console.log('Restart the server to pick up the new setting.');
  } catch (err) {
    console.log('failed.');
    console.log(`  ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
})();
