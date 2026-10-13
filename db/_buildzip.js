/* ------------------------------------------------------------------
   Build the Hostinger deployment archive.

     node db/_buildzip.js

   Writes ONE archive, deploy-all.zip: the whole application, code and
   assets together. Verify the result with:

     node db/_verifyzip.js deploy-all.zip

   There is deliberately no code-only or assets-only build. Splitting
   the release produced two archives that drifted apart — a code zip
   carrying the new work and a full zip carrying the old, so whichever
   went up last decided what the live site ran, and uploading the
   wrong one silently reverted the release. One archive cannot drift.

   Packs the application and leaves out everything the host either
   rebuilds itself (node_modules) or must never see (.env, .git,
   uploaded customer files, seed and test data).

   Stages a filtered copy of the tree, then writes the archive with
   db/_zipwriter.js. Staging keeps the working tree untouched and is
   what makes the exclusions below possible.
------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const { writeZip } = require('./_zipwriter');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'deploy-all.zip');
const STAGE = path.join(require('os').tmpdir(), `rf-deploy-${process.pid}`);

const SKIP_DIR = new Set([
  'node_modules', '.git', 'uploads', '.claude',
  /* Working folders that live beside the app but are never served:
     design sources, screenshots, saved transcripts, raw video. They
     added tens of megabytes to every upload for no benefit. */
  'New logo', 'UI change', 'car image', 'conversations', 'wrong', 'videos',
  /* Staging folders a previous build left behind — packing them
     would nest one release inside the next. */
  'hostinger-deploy-preview', 'hostinger-deploy-staging'
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
  /^Reddy_Finances_Car_Rental_Contract.*\.pdf$/i,
  /* Seed, demo and test data. These write invented customers and
     bookings into whatever database they are pointed at, so they have
     no business on the live server. */
  /^add-fake-/i,
  /^load-test-data\.js$/i,
  /^make-seed\.js$/i,
  /^seed-demo\.js$/i,
  /^seed-sample\.sql$/i,
  /^test-data\.sql$/i,
  /^live-backup-.*\.json$/i
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

/* Written with our own zip writer rather than PowerShell's
   Compress-Archive. Compress-Archive stores Windows paths verbatim,
   with backslashes, which the ZIP spec (APPNOTE 4.4.17.1) forbids:
   Hostinger's extractor then reads "server\index.js" as one oddly
   named file at the top level, so nothing lands in a directory and
   the deployment is silently wrong. */
console.log('Compressing...');
fs.rmSync(OUT, { force: true });
writeZip(STAGE, OUT);

fs.rmSync(STAGE, { recursive: true, force: true });

const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
console.log(`\nWrote deploy-all.zip (${mb} MB)`);
console.log('Verify with:  node db/_verifyzip.js deploy-all.zip');
