/* ------------------------------------------------------------------
   Pulling the rental agreement's text out of whatever file the office
   has it in — PDF, Word, RTF, HTML or plain text.

   The Document tab stores the agreement as STRUCTURE (title, intro,
   clauses, acknowledgement), not as a finished page. That is what lets
   the PDF generator fill in each customer's name and dates, what the
   version history compares, and what the e-signature stamps. So an
   uploaded file is read for its text and folded back into that shape
   rather than stored as an opaque blob.

   Written against the formats directly. The alternatives are large
   dependencies (pdf-parse, mammoth) for a feature used a handful of
   times a year, and every one of them is another thing to patch on a
   server that handles customer contracts.

   Extraction is never perfect on a heavily formatted file, so the
   result lands in the editor for the office to review — it is never
   saved as a version without a human looking at it.
------------------------------------------------------------------- */

const zlib = require('zlib');

/* --------------------------- plain text --------------------------- */

function fromText(buf) {
  return buf.toString('utf8');
}

/* ------------------------------ .docx ------------------------------
   A Word file is a ZIP; the body lives in word/document.xml. Read the
   archive's central directory, inflate that one entry, and strip the
   tags — paragraph breaks become newlines so clause boundaries
   survive. */

function unzipEntry(buf, wanted) {
  /* End of central directory */
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null;
    const nameLen  = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen   = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const method   = buf.readUInt16LE(off + 10);
    const comp     = buf.readUInt32LE(off + 20);
    const name     = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');

    if (name === wanted) {
      if (buf.readUInt32LE(localOff) !== 0x04034b50) return null;
      const lNameLen  = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const at = localOff + 30 + lNameLen + lExtraLen;
      const body = buf.subarray(at, at + comp);
      try {
        return method === 8 ? zlib.inflateRawSync(body) : body;
      } catch { return null; }
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return null;
}

function fromDocx(buf) {
  const xml = unzipEntry(buf, 'word/document.xml');
  if (!xml) return '';
  let s = xml.toString('utf8');

  /* Structure first, so paragraph and line breaks survive the
     tag-stripping below. */
  s = s.replace(/<w:p\b[^>]*\/>/g, '\n')
       .replace(/<\/w:p>/g, '\n')
       .replace(/<w:br\b[^>]*\/?>/g, '\n')
       .replace(/<w:tab\b[^>]*\/?>/g, ' ');

  /* Everything else goes. */
  s = s.replace(/<[^>]+>/g, '');

  return decodeEntities(s);
}

/* ------------------------------- PDF -------------------------------
   Text lives in the content streams, written either as (literal) Tj
   or <hex> Tj. Both forms are read. This recovers wording, not
   layout — which is exactly what is wanted here. */

function fromPdf(buf) {
  const raw = buf.toString('latin1');
  let content = '';

  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(raw))) {
    const body = Buffer.from(m[1], 'latin1');
    try { content += zlib.inflateSync(body).toString('latin1') + '\n'; }
    catch {
      try { content += zlib.inflateRawSync(body).toString('latin1') + '\n'; }
      catch { content += body.toString('latin1') + '\n'; }
    }
  }
  if (!content) content = raw;

  const out = [];

  /* TJ arrays and Tj strings, in document order. */
  const token = /\[((?:[^\][\\]|\\.)*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*Tj|<([0-9A-Fa-f\s]+)>\s*Tj|\bT\*|\bTd\b|\bTD\b|\bTm\b/g;
  while ((m = token.exec(content))) {
    if (m[1] !== undefined) {
      /* An array mixes strings and kerning numbers; keep the strings. */
      const parts = m[1].match(/\(((?:[^()\\]|\\.)*)\)|<([0-9A-Fa-f\s]+)>/g) || [];
      let line = '';
      for (const p of parts) {
        line += p.startsWith('<') ? hexToStr(p.slice(1, -1))
                                  : unescapePdf(p.slice(1, -1));
      }
      out.push(line);
    } else if (m[2] !== undefined) {
      out.push(unescapePdf(m[2]));
    } else if (m[3] !== undefined) {
      out.push(hexToStr(m[3]));
    } else {
      /* a positioning operator — treat as a line break */
      out.push('\n');
    }
  }

  return out.join('')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ');
}

function hexToStr(hex) {
  const h = hex.replace(/\s+/g, '');
  let s = '';
  for (let i = 0; i + 1 < h.length; i += 2) {
    s += String.fromCharCode(parseInt(h.substr(i, 2), 16));
  }
  return s;
}

function unescapePdf(s) {
  return s.replace(/\\([nrtbf()\\])/g, (_, c) =>
    ({ n: '\n', r: '\n', t: ' ', b: '', f: '' }[c] ?? c));
}

/* ------------------------------- RTF ------------------------------- */

function fromRtf(buf) {
  let s = buf.toString('latin1');
  s = s.replace(/\\par[d]?\b/g, '\n')
       .replace(/\\line\b/g, '\n')
       .replace(/\\tab\b/g, ' ')
       .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
       .replace(/\{\\\*[^{}]*\}/g, '')
       .replace(/\\[a-z]+-?\d*\s?/gi, '')
       .replace(/[{}]/g, '');
  return s;
}

/* ------------------------------ HTML ------------------------------- */

function fromHtml(buf) {
  let s = buf.toString('utf8');
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
       .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
       .replace(/<br\b[^>]*>/gi, '\n')
       .replace(/<[^>]+>/g, '');
  return decodeEntities(s);
}

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
          .replace(/&nbsp;/g, ' ')
          .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
          .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
          .replace(/&amp;/g, '&');   /* last, or &amp;lt; double-decodes */
}

/* -------------------------- format sniffing ------------------------
   By magic bytes rather than by filename: an extension is whatever
   someone typed, and a mislabelled file would otherwise be parsed as
   the wrong format and produce nonsense. */

function sniff(buf, name = '') {
  if (!buf || buf.length < 4) return 'unknown';
  const head = buf.subarray(0, 8);

  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (head[0] === 0x50 && head[1] === 0x4b) return 'zip';     /* docx/odt */
  if (head.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
  /* Old .doc (OLE compound file) — not readable without a parser. */
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11) return 'doc';

  /* Images and other binaries. Caught by signature so they are turned
     away with a useful message: without this they fall through to the
     text reader, which "succeeds" and fills the editor with mojibake.
     A photographed or scanned contract is a common thing to try. */
  const sig = head.toString('hex');
  if (sig.startsWith('89504e47')) return 'image';          /* PNG  */
  if (sig.startsWith('ffd8ff'))   return 'image';          /* JPEG */
  if (sig.startsWith('47494638')) return 'image';          /* GIF  */
  if (sig.startsWith('424d'))     return 'image';          /* BMP  */
  if (buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image';
  if (sig.startsWith('49492a00') || sig.startsWith('4d4d002a')) return 'image'; /* TIFF */

  const start = buf.subarray(0, 400).toString('utf8').trim().toLowerCase();
  if (start.startsWith('<!doctype html') || start.startsWith('<html')) return 'html';
  if (/\.html?$/i.test(name)) return 'html';
  return 'text';
}

/* Extracts readable text from a document buffer.

   Returns { text, format, ok, error }. `ok: false` carries a message
   written for the office, not a stack trace — "this format cannot be
   read, save it as X" is actionable; "unexpected token" is not. */
function extractText(buf, name = '') {
  const format = sniff(buf, name);

  try {
    switch (format) {
      case 'pdf': {
        const text = fromPdf(buf);
        return text.trim()
          ? { ok: true, format: 'PDF', text }
          : { ok: false, format: 'PDF', text: '',
              error: 'No text could be read from that PDF. If it is a scan '
                   + 'of a printed page, the words are an image — paste the '
                   + 'text in instead, or upload a Word or text version.' };
      }
      case 'zip': {
        const text = fromDocx(buf);
        return text.trim()
          ? { ok: true, format: 'Word (.docx)', text }
          : { ok: false, format: 'Word (.docx)', text: '',
              error: 'That file could not be read as a Word document. '
                   + 'Try saving it again as .docx, or as PDF.' };
      }
      case 'rtf':  return { ok: true, format: 'RTF', text: fromRtf(buf) };
      case 'html': return { ok: true, format: 'HTML', text: fromHtml(buf) };
      case 'doc':
        return { ok: false, format: 'Word 97-2003 (.doc)', text: '',
                 error: 'The old .doc format cannot be read. Open it in Word '
                      + 'and save as .docx or PDF, then upload that.' };
      case 'image':
        return { ok: false, format: 'Image', text: '',
                 error: 'That is an image, so the words in it are pixels '
                      + 'rather than text. Upload the document itself as PDF, '
                      + 'Word or plain text.' };
      default: {
        const text = fromText(buf);
        return text.trim()
          ? { ok: true, format: 'Text', text }
          : { ok: false, format: 'Unknown', text: '',
              error: 'That file does not appear to contain any text.' };
      }
    }
  } catch (err) {
    return { ok: false, format, text: '',
             error: 'That file could not be read. Try saving it as PDF, '
                  + 'Word (.docx) or plain text.' };
  }
}

/* ------------------- text back into a document --------------------

   A clause starts at a line that LOOKS like a heading: numbered
   ("5. TOLLS"), in capitals, or short and title-like. Everything under
   it, up to the next heading, is its body.

   This is a best guess at a document's shape, which is why the result
   goes to the editor rather than straight into a saved version. */

function looksLikeHeading(line) {
  const s = line.trim();
  if (!s || s.length > 90) return false;

  /* "5. TOLLS" / "5 TOLLS" / "ARTICLE 5 - TOLLS" */
  if (/^(?:article\s+)?\d{1,2}[.):\s-]+\S/i.test(s)) {
    const rest = s.replace(/^(?:article\s+)?\d{1,2}[.):\s-]+/i, '');
    /* a numbered sentence is not a heading */
    if (rest.length <= 70 && !/[.;]$/.test(rest)) return true;
  }
  /* All capitals, and not a whole sentence. */
  if (s === s.toUpperCase() && /[A-Z]{3}/.test(s) && !/[.;]$/.test(s)) return true;
  return false;
}

function cleanHeading(line) {
  return line.trim()
    .replace(/^(?:article\s+)?\d{1,2}[.):\s-]+/i, '')
    .replace(/[:\s]+$/, '')
    .toUpperCase();
}

/* Did this heading carry a clause number? Used below to tell real
   clauses from the capitalised odds and ends around them. */
const isNumberedHeading = line =>
  /^(?:article\s+)?\d{1,2}[.):\s-]+\S/i.test(String(line).trim());

function textToDocument(text, fallback = {}) {
  const lines = String(text || '').split(/\r?\n/);

  let title = '';
  const intro = [];
  const sections = [];
  let current = null;

  /* A printed agreement opens with the letterhead — the company name
     and its tagline — above the document's actual title. Both are
     already held in their own editor fields, so a leading line that
     repeats either of them is skipped rather than taken as the title.
     Compared loosely, because a PDF may print it in capitals. */
  const same = (a, b) => {
    const norm = s => String(s || '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
    return !!norm(a) && norm(a) === norm(b);
  };
  const isLetterhead = line =>
    same(line, fallback.company) || same(line, fallback.tagline);

  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) { if (current) current.paragraphs.push(''); else intro.push(''); continue; }

    if (looksLikeHeading(line)) {
      /* The first heading before any body text is the document's own
         title, not a clause. */
      if (!title && !sections.length && !intro.join('').trim()) {
        if (isLetterhead(line)) continue;
        title = cleanHeading(line);
        continue;
      }
      current = { heading: cleanHeading(line), paragraphs: [],
                  numbered: isNumberedHeading(line) };
      sections.push(current);
      continue;
    }

    if (current) current.paragraphs.push(line);
    else intro.push(line);
  }

  /* Blank-line runs become paragraph breaks. */
  const join = arr => arr.join('\n').split(/\n{2,}/)
    .map(p => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);

  for (const s of sections) s.paragraphs = join(s.paragraphs);

  const introText = join(intro).join(' ');
  let kept = sections.filter(s => s.heading && s.paragraphs.length);

  /* A printed agreement surrounds its clauses with capitalised text
     that is not a clause: the labels of the detail table at the top
     ("DRIVER NAME", "PERIOD END DATE") and the signature block at the
     bottom ("DATE"). Each reads as a heading, and each then swallows
     the next stray line as its body, so dropping empty ones is not
     enough.

     Clause numbering is the dependable signal. When a document numbers
     its clauses — as the agreement in use does — only the numbered
     ones are clauses, and the rest is furniture the editor already
     holds in its own fields. A document with no numbering at all is
     left as it was found. */
  const numbered = kept.filter(s => s.numbered);
  if (numbered.length >= 3) kept = numbered;
  kept = kept.map(({ heading, paragraphs }) => ({ heading, paragraphs }));

  return {
    title: title || fallback.title || '',
    intro: introText || fallback.intro || '',
    sections: kept,
    acknowledgement: fallback.acknowledgement || '',
    /* carried through so the detail table is not lost on an upload */
    detailFields: fallback.detailFields,
    company: fallback.company,
    tagline: fallback.tagline,
    footer: fallback.footer
  };
}

module.exports = { extractText, textToDocument, sniff,
                   fromPdf, fromDocx, fromRtf, fromHtml };
