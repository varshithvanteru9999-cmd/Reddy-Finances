/* ------------------------------------------------------------------
   Toll sheets — read a spreadsheet of plate numbers and amounts.

   Toll authorities send either a CSV or an .xlsx. Rather than take on a
   spreadsheet dependency for one screen, both are parsed here: an .xlsx
   is a ZIP of XML, and Node already ships zlib.

   The sheet is assumed to have a header row naming a plate column and an
   amount column; everything else is ignored, so an operator can hand
   over whatever their provider exported without editing it first.
------------------------------------------------------------------- */

const zlib = require('zlib');

/* Header names seen on real toll statements. Matched case-insensitively
   against the header row, most specific first. */
const PLATE_HEADERS = [
  'vehicle number', 'vehicle no', 'vehicle_no', 'plate number', 'plate no',
  'number plate', 'registration', 'reg no', 'reg number', 'licence plate',
  'license plate', 'vrm', 'plate', 'vehicle'
];
const AMOUNT_HEADERS = [
  'toll amount', 'toll charge', 'toll fee', 'total amount', 'amount due',
  'charge', 'amount', 'toll', 'fee', 'total', 'cost'
];

/* --------------------------- plate keys --------------------------- */

/* Plates are compared with spaces, case and punctuation removed, so
   "AB12 CDE", "ab12cde" and "AB12-CDE" all match the same vehicle. */
function plateKey(value) {
  return String(value == null ? '' : value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/* --------------------------- CSV parsing -------------------------- */

/* A small RFC-4180 reader: handles quoted fields, embedded commas and
   doubled quotes. Not a general CSV library, but correct for the shape
   toll statements come in. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',' || ch === ';' || ch === '\t') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

/* --------------------------- XLSX parsing ------------------------- */

/* Minimal ZIP reader: walks the central directory and inflates the two
   entries a workbook needs. Avoids a dependency for a single feature. */
function unzip(buffer) {
  const files = {};
  /* End-of-central-directory, searched from the back (it carries a
     variable-length comment). */
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Not a valid .xlsx file.');

  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOff = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);

    /* The local header repeats the name and extra fields, and its extra
       length may differ from the central one. */
    const lhNameLen = buffer.readUInt16LE(localOff + 26);
    const lhExtraLen = buffer.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compSize);

    if (/sharedStrings\.xml$|sheet1\.xml$|workbook\.xml$/.test(name)) {
      try {
        files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
      } catch { /* skip an entry we cannot read */ }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function xmlDecode(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/* Column letters to a zero-based index: A→0, B→1, AA→26. */
function colIndex(ref) {
  const letters = String(ref).replace(/\d+/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseXlsx(buffer) {
  const files = unzip(buffer);

  const sheetName = Object.keys(files).find(f => /sheet1\.xml$/.test(f));
  if (!sheetName) throw new Error('No worksheet found in that .xlsx file.');

  /* Shared strings: most text cells point into this table. */
  const shared = [];
  const ssName = Object.keys(files).find(f => /sharedStrings\.xml$/.test(f));
  if (ssName) {
    const xml = files[ssName].toString('utf8');
    for (const si of xml.match(/<si[\s>][\s\S]*?<\/si>/g) || []) {
      /* A cell's text can be split across several <t> runs. */
      const parts = (si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
        .map(t => xmlDecode(t.replace(/<[^>]+>/g, '')));
      shared.push(parts.join(''));
    }
  }

  const sheet = files[sheetName].toString('utf8');
  const rows = [];
  for (const rowXml of sheet.match(/<row[\s>][\s\S]*?<\/row>/g) || []) {
    const cells = [];
    for (const c of rowXml.match(/<c[\s>][\s\S]*?(?:<\/c>|\/>)/g) || []) {
      const ref = (c.match(/r="([A-Z]+\d+)"/) || [])[1];
      const type = (c.match(/t="([^"]+)"/) || [])[1];
      let value = '';
      if (type === 'inlineStr') {
        value = xmlDecode((c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
      } else {
        const v = (c.match(/<v[^>]*>([\s\S]*?)<\/v>/) || [])[1];
        if (v !== undefined) {
          value = type === 's' ? (shared[Number(v)] ?? '') : xmlDecode(v);
        }
      }
      const idx = ref ? colIndex(ref) : cells.length;
      while (cells.length < idx) cells.push('');
      cells[idx] = value;
    }
    if (cells.some(c => String(c).trim() !== '')) rows.push(cells);
  }
  return rows;
}

/* --------------------------- the reader --------------------------- */

function findColumn(header, candidates) {
  const cleaned = header.map(h => String(h || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim());
  for (const want of candidates) {
    const exact = cleaned.indexOf(want);
    if (exact !== -1) return exact;
  }
  for (const want of candidates) {
    const partial = cleaned.findIndex(h => h.includes(want));
    if (partial !== -1) return partial;
  }
  return -1;
}

function toAmount(value) {
  /* Strips currency symbols, thousands separators and stray spaces.
     Stripping can leave nothing at all ("n/a" -> ""), and Number('') is
     0 — which would quietly turn a malformed cell into a zero charge.
     Anything that is not a recognisable number must fail instead. */
  const cleaned = String(value == null ? '' : value).replace(/[^0-9.\-]/g, '');
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

/* Reads a toll sheet into [{ plate, plateKey, amount }].
   Several rows for one plate are summed — statements usually list each
   crossing separately, and the office wants the total per vehicle. */
function readTollSheet(buffer, filename = '') {
  const isXlsx = /\.xlsx$/i.test(filename) ||
    (buffer.length > 1 && buffer[0] === 0x50 && buffer[1] === 0x4b);

  let rows;
  if (isXlsx) {
    rows = parseXlsx(buffer);
  } else {
    /* Strip a UTF-8 BOM, which Excel adds when saving CSV. */
    let text = buffer.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    rows = parseCsv(text);
  }

  if (!rows.length) throw new Error('That file has no rows.');

  const header = rows[0];
  const plateCol = findColumn(header, PLATE_HEADERS);
  const amountCol = findColumn(header, AMOUNT_HEADERS);

  if (plateCol === -1 || amountCol === -1) {
    throw new Error(
      'Could not find the columns. The first row must name one column for ' +
      'the vehicle number (e.g. "Vehicle Number") and one for the amount ' +
      '(e.g. "Toll Amount").'
    );
  }

  const totals = new Map();
  const skipped = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const plateRaw = String(row[plateCol] ?? '').trim();
    const amount = toAmount(row[amountCol]);

    if (!plateRaw) continue;
    if (!Number.isFinite(amount)) { skipped.push({ row: i + 1, plate: plateRaw, reason: 'amount is not a number' }); continue; }
    if (amount < 0) { skipped.push({ row: i + 1, plate: plateRaw, reason: 'amount is negative' }); continue; }

    const key = plateKey(plateRaw);
    if (!key) { skipped.push({ row: i + 1, plate: plateRaw, reason: 'not a usable plate' }); continue; }

    const existing = totals.get(key) || { plate: plateRaw, plateKey: key, amount: 0, rows: 0 };
    existing.amount = Math.round((existing.amount + amount) * 100) / 100;
    existing.rows += 1;
    totals.set(key, existing);
  }

  return { entries: [...totals.values()], skipped, totalRows: rows.length - 1 };
}

module.exports = { readTollSheet, plateKey };
