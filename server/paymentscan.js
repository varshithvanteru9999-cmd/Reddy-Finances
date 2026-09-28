/* ------------------------------------------------------------------
   Read the amount off a payment screenshot.

   Reading a number out of an arbitrary bank or UPI screenshot is not a
   solved problem: fonts vary, dark mode inverts everything, and phone
   screenshots are often low resolution. So this is deliberately built
   as a SUGGESTION — it reports what it thinks it saw and how confident
   it is, and the office confirms before any balance moves.

   Everything is optional: if OCR is unavailable or the image defeats
   it, the caller gets `{ amount: null, status: 'unreadable' }` and the
   admin simply types the figure in as before.
------------------------------------------------------------------- */

/* Loaded lazily — the worker pulls in a few MB and most requests never
   need it. A failure here must not take the upload down with it. */
let tesseract = null;
function ocr() {
  if (tesseract === null) {
    try { tesseract = require('tesseract.js'); }
    catch { tesseract = false; }
  }
  return tesseract || null;
}

/* Currency amounts as they appear on a receipt: an optional symbol, then
   digits with optional thousands separators and up to two decimals.
   Indian grouping (1,23,456.00) is matched as well as Western. */
const AMOUNT_RE = /(?:₹|rs\.?|inr|\$|usd)?\s*(\d[\d,]*(?:\.\d{1,2})?)(?!\d)/gi;

/* Lines that tend to carry the figure we want, in preference order.
   A screenshot often shows several numbers — a balance, a fee, a
   reference — and the labelled one is the safest bet. */
const STRONG_LABELS = /(amount\s*paid|total\s*paid|you\s*paid|paid|amount|total|sent|transferred|debited)/i;
/* Numbers next to these are definitely NOT the payment. */
/* Anchored on word boundaries: an unanchored "txn" matched inside
   "Transaction Successful", so a perfectly good receipt header rejected
   the amount printed beneath it. Identifier labels only — never a word
   that can appear in ordinary success text. */
const REJECT_LABELS = /\b(balance|bal|avail|available|limit|a\/c|acct|account\s*(no|number)|ref|reference|utr|txn|transaction\s*(id|no)|upi\s*id|order\s*id|invoice\s*(no|id)|confirmation(\s*(no|number|#))?|memo|phone|remaining)\b/i;

/* Fragments that are never a payment amount, matched against the raw
   text of the line before any figure is pulled out of it. Zelle and US
   bank receipts print a date and a masked account on their own lines,
   and both look like plain numbers once OCR has stripped the styling:
   "Sent to X on 09/19/2026" yielded 2026, and "Deposited into ...4471"
   yielded 4471 — each a confident, wrong answer. */
const NOISE_RE = [
  /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/g,            /* 09/19/2026, 19-09-26   */
  /\b\d{4}-\d{2}-\d{2}\b/g,                            /* 2026-09-19             */
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s*\d{2,4}\b/gi,
  /\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s*\d{2,4}\b/gi,
  /\.{2,}\s*\d+/g,                                     /* ...4471 masked account */
  /[x*\u2022]{2,}\s*\d+/gi,                            /* ****4471, xxxx4471     */
  /\b\d{1,2}:\d{2}\s*(am|pm)?\b/gi,                    /* 4:30 pm                */
  /\(\d{3}\)\s*\d{3}[- ]?\d{4}/g,                      /* (214) 555-0100         */
  /\b\d{3}[- ]\d{3}[- ]\d{4}\b/g                       /* 214-555-0100           */
];

/* Strip those fragments so their digits can never be read as money. */
function deNoise(line) {
  let out = String(line || '');
  for (const re of NOISE_RE) out = out.replace(re, ' ');
  return out;
}

function parseAmount(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    /* A receipt often puts the label on one line and the figure on the
       next ("Available Balance" / "₹50,000"). Judging the line on its
       own let a balance masquerade as the payment, so the line above
       counts as context too — but only for labelling. */
    const prev = (lines[i - 1] || '').trim();
    const context = (prev + ' ' + line).trim();
    /* Zelle's headline is "Sent $X to NAME" — the verb is the label and
       it sits on the same line as the figure, which STRONG_LABELS
       already covers via `sent`. Nothing Zelle-specific is needed here
       beyond not being fooled by the noise stripped below. */

    /* Reject when the label sits on THIS line, or when the line above
       is a bare label with no figure of its own (the "Available
       Balance" case). A previous line that already carried its own
       amount is a finished entry and says nothing about this one —
       treating it as context discarded good figures. */
    const prevIsBareLabel = prev && REJECT_LABELS.test(prev) && !/\d/.test(prev);

    /* A reject label normally kills the line. One shape is worth
       rescuing: the bank SMS that names the account and the amount in
       one breath — "Your a/c XX4471 debited by Rs.990.00". Thrown away
       it loses a real payment; kept naively the account digits win.

       The rescue is deliberately narrow: ONLY an account-style label
       (a/c, acct, account), and ONLY when a debit/credit verb sits
       directly against the amount. A balance or a limit is never
       rescued, however it is worded — "Total available balance
       $9,999" reads as a payment under any looser rule. */
    const ACCOUNT_ONLY = /\b(a\/c|acct|account)\b/i;
    const BALANCEish = /\b(balance|bal|available|avail|limit|remaining)\b/i;
    const DEBIT_VERB = /\b(debited|credited|paid|sent|transferred)\b[^\n]{0,20}?(?:₹|rs\.?|inr|\$|usd)\s*\d/i;

    const rescued = ACCOUNT_ONLY.test(line)
                 && !BALANCEish.test(line)
                 && DEBIT_VERB.test(line);

    if ((REJECT_LABELS.test(line) && !rescued) || prevIsBareLabel) continue;

    /* Dates, masked accounts and phone numbers are removed before any
       figure is read, so their digits cannot be mistaken for money. */
    const clean = deNoise(line);

    AMOUNT_RE.lastIndex = 0;
    let m;
    while ((m = AMOUNT_RE.exec(clean))) {
      const n = Number(String(m[1]).replace(/,/g, ''));
      if (!Number.isFinite(n) || n <= 0) continue;
      /* A long digit run with no separators is a reference number, not
         a price. */
      if (n > 10_000_000) continue;
      out.push({ value: n, labelled: STRONG_LABELS.test(context) });
    }
  }
  if (!out.length) return null;

  /* Prefer a labelled figure; among equals take the largest, since a
     receipt's headline amount is usually the biggest number on it. */
  const labelled = out.filter(a => a.labelled);
  const pool = labelled.length ? labelled : out;
  return pool.reduce((best, a) => (a.value > best.value ? a : best)).value;
}

/* Magic bytes for the formats the upload endpoint accepts. Checking
   these costs nothing and keeps a malformed file away from the OCR
   worker, whose failure mode is an uncatchable async throw. */
function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false;
  const b = buf;
  /* JPEG */
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  /* PNG */
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
  /* GIF */
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true;
  /* BMP */
  if (b[0] === 0x42 && b[1] === 0x4d) return true;
  /* WebP and HEIC/HEIF both sit inside a RIFF/ISO-BMFF container */
  const tag = b.toString('latin1', 0, 12);
  if (/^RIFF.{4}WEBP$/s.test(tag)) return true;
  if (/ftyp(heic|heix|hevc|mif1|msf1)/i.test(b.toString('latin1', 0, 32))) return true;
  return false;
}

/* Compare what was read against what is owed.
     ok         — covers the expected amount (within a cent)
     short      — a figure was read, but it is less than expected
     unreadable — nothing usable came out of the image
   `expected` may be null, in which case any readable amount is 'ok'. */
function compare(amount, expected) {
  if (amount === null) return 'unreadable';
  if (expected === null || expected === undefined) return 'ok';
  const owed = Number(expected) || 0;
  if (owed <= 0) return 'ok';
  return amount + 0.01 >= owed ? 'ok' : 'short';
}

/**
 * Scan an image buffer for a payment amount.
 * Never throws: OCR problems come back as 'unreadable'.
 *
 * @param {Buffer} buffer      the uploaded image
 * @param {number|null} expected  what the customer is meant to have paid
 * @returns {{amount:number|null, status:string, shortfall:number, confidence:number}}
 */
async function scanPayment(buffer, expected = null) {
  const fail = { amount: null, status: 'unreadable', shortfall: 0, confidence: 0 };

  const engine = ocr();
  if (!engine || !buffer || !buffer.length) return fail;

  /* A quick sanity check on the bytes. Tesseract reports an unreadable
     image by throwing from inside its worker thread — which escapes a
     plain try/catch and takes the process down with it — so anything
     that is obviously not an image is rejected before it gets there. */
  if (!looksLikeImage(buffer)) return fail;

  let text = '', confidence = 0;
  try {
    /* A single recognise call, with a ceiling on how long it may take:
       a pathological image must not hold a request open indefinitely. */
    const result = await Promise.race([
      engine.recognize(buffer, 'eng'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('scan timed out')), 20000))
    ]);
    text = (result && result.data && result.data.text) || '';
    confidence = Number((result && result.data && result.data.confidence) || 0);
  } catch {
    return fail;
  }

  const amount = parseAmount(text);
  const status = compare(amount, expected);
  const owed = Number(expected) || 0;
  const shortfall = (status === 'short' && amount !== null)
    ? Math.round((owed - amount) * 100) / 100
    : 0;

  return { amount, status, shortfall, confidence: Math.round(confidence) };
}

module.exports = { scanPayment, parseAmount, compare };
