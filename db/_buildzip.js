/* ------------------------------------------------------------------
   Build the Hostinger deployment archive.

     node db/_buildzip.js

   Packs the application and leaves out everything the host either
   rebuilds itself (node_modules) or must never see (.env, .git,
   uploaded customer files). Verify the result with:

     node db/_verifyzip.js hostinger-deploy.zip

   Shells out to PowerShell's Compress-Archive so there is no
   dependency to install. It stages a copy first, because
   Compress-Archive has no exclude option — filtering has to happen
   before the archive is written, and staging keeps the working tree
   untouched.
------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'hostinger-deploy.zip');
const STAGE = path.join(require('os').tmpdir(), `rf-deploy-${process.pid}`);

/* Anything matching these is never packaged. The secrets entries are
   the important ones: .env carries the database and mail passwords. */
const SKIP_DIR = new Set([
  'node_modules', '.git', 'uploads', '.claude',
  /* Working folders that live beside the app but are never served:
     design sources, screenshots, saved transcripts, raw video. They
     added tens of megabytes to every upload for no benefit. */
  'New logo', 'UI change', 'car image', 'conversations', 'wrong', 'videos'
]);
const SKIP_FILE = [
  /^\.env$/i,               /* every flavour of it */
  /^\.env\./i,
  /\.env$/i,                /* hostinger.env, hostinger-min.env */
  /^\.DS_Store$/i,
  /^npm-debug\.log/i,
  /* Any archive at all. Previous builds packed the old deploy zips
     inside the new one, so each release carried every release before
     it — 54MB of dead weight and growing with every deploy. */
  /\.zip$/i,
  /* A stray copy of the contract; the server generates its own. */
  /^Reddy_Finances_Car_Rental_Contract.*\.pdf$/i
];

let copied = 0;

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      copyTree(src, dst);
    } else if (entry.isFile()) {
      if (SKIP_FILE.some(re => re.test(entry.name))) continue;
      fs.copyFileSync(src, dst);
      copied++;
    }
  }
}

console.log('Staging...');
fs.rmSync(STAGE, { recursive: true, force: true });
copyTree(ROOT, STAGE);
console.log(`  ${copied} files`);

/* uploads/ is excluded above, but the server expects the directory to
   exist on boot rather than creating it, so ship it empty. */
fs.mkdirSync(path.join(STAGE, 'uploads'), { recursive: true });
fs.writeFileSync(path.join(STAGE, 'uploads', '.gitkeep'), '');

console.log('Compressing...');
fs.rmSync(OUT, { force: true });
execFileSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-Command',
  'Compress-Archive -Path $env:RF_STAGE\\* -DestinationPath $env:RF_OUT -Force'
], { env: { ...process.env, RF_STAGE: STAGE, RF_OUT: OUT }, stdio: 'inherit' });

fs.rmSync(STAGE, { recursive: true, force: true });

const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
console.log(`\nWrote hostinger-deploy.zip (${mb} MB)`);
console.log('Verify with:  node db/_verifyzip.js hostinger-deploy.zip');
