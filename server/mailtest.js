/* ------------------------------------------------------------------
   Email self-test.

     node server/mailtest.js                 check the credentials
     node server/mailtest.js you@example.com send a real test message

   Run this after changing EMAIL_* in .env — it says exactly what is
   wrong rather than leaving a 535 buried in the server log.
------------------------------------------------------------------- */

const db = require('./db.js');

(async () => {
  const to = process.argv[2];

  process.stdout.write('Checking SMTP credentials... ');
  const check = await db.verifyEmail();

  if (!check.ok) {
    console.log('FAILED\n');
    if (check.code) console.log(`  code   : ${check.code}`);
    if (check.reason) console.log(`  server : ${check.reason}`);
    if (check.hint) console.log(`\n  ${check.hint}`);
    console.log('\nNothing was sent.');
    process.exit(1);
  }

  console.log('OK — the mail server accepted our credentials.');

  if (!to) {
    console.log('\nTo send a real test message:');
    console.log('  node server/mailtest.js you@example.com');
    process.exit(0);
  }

  process.stdout.write(`Sending a test message to ${to}... `);
  try {
    await db.sendEmail({
      to,
      subject: 'Reddy Finances — mail test',
      html: '<p>This is a test from your Reddy Finances server.</p>'
          + '<p>If you can read this, invoices and booking emails will go out.</p>'
    });
    console.log('sent.');
  } catch (err) {
    console.log('FAILED');
    console.log(`  ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
})();
