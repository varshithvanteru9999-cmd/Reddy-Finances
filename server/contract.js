/* ------------------------------------------------------------------
   The rental agreement, drawn as a PDF.

   Two jobs, deliberately kept apart: the wording lives in
   contract-terms.js so the office can correct a clause without anyone
   touching layout code, and this file only draws it.

   The document is sent unsigned when a booking is approved, then
   regenerated with the renter's signature once they sign on the web
   page. Both paths call generateContractPdf() — the second simply
   passes a signature — so the signed copy can never say something
   different from the one the customer agreed to.
------------------------------------------------------------------- */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const T = require('./contract-terms.js');

const COMPANY = T.COMPANY;

/* ------------------------------ layout ---------------------------- */

const PAGE = { w: 612, h: 792 };          /* US Letter, points */
const MARGIN = 50;
const BODY_W = PAGE.w - MARGIN * 2;

/* pdf-lib's standard fonts are WinAnsi, so a smart quote or dash from a
   pasted clause throws rather than printing. Fold them to ASCII. */
function ascii(text) {
  return String(text == null ? '' : text)
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—―]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[^\x20-\x7E]/g, '');
}

function wrap(text, font, size, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/* The agreement's wording, for anywhere that wants to show the terms
   outside the PDF. */
function contractTerms() {
  return {
    title: T.TITLE,
    intro: T.INTRO,
    sections: T.SECTIONS.map((s, i) => ({
      number: i + 1,
      heading: s.heading,
      paragraphs: s.paragraphs
    })),
    acknowledgement: T.ACKNOWLEDGEMENT
  };
}

/* --------------------------- the document ------------------------- */

/* `template` is a saved version from document_templates — title, intro,
   sections[] and acknowledgement in the same shape contract-terms.js
   exports. Omitting it falls back to the file, so every existing caller
   behaves exactly as before and a fresh install with no saved version
   still produces the agreement. */
async function generateContractPdf(data = {}, signature = null, template = null) {
  const DOC = {
    company: (template && template.company) || T.COMPANY,
    tagline: (template && template.tagline != null) ? template.tagline : T.COMPANY_TAGLINE,
    title: (template && template.title) || T.TITLE,
    intro: (template && template.intro) || T.INTRO,
    /* Labels + lookup keys only. The VALUES still come from the booking
       at render time, so a template never carries a customer's data. */
    detailFields: (template && Array.isArray(template.detailFields) && template.detailFields.length)
      ? template.detailFields : T.DETAIL_FIELDS,
    sections: (template && Array.isArray(template.sections) && template.sections.length)
      ? template.sections : T.SECTIONS,
    acknowledgement: (template && template.acknowledgement) || T.ACKNOWLEDGEMENT,
    footer: (template && template.footer != null) ? template.footer : T.FOOTER
  };

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);

  let page = pdf.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - MARGIN;

  const INK = rgb(0.08, 0.08, 0.08);
  const MUTED = rgb(0.45, 0.45, 0.45);
  const LINE = rgb(0.72, 0.72, 0.72);

  /* Start a fresh page when the next block would not fit. Measured
     before drawing so a heading never lands alone at the foot. */
  const need = height => {
    if (y - height < MARGIN + 30) {
      page = pdf.addPage([PAGE.w, PAGE.h]);
      y = PAGE.h - MARGIN;
    }
  };

  const write = (text, opts = {}) => {
    const size = opts.size || 9.8;
    const f = opts.bold ? bold : opts.italic ? italic : font;
    const indent = opts.indent || 0;
    const lines = wrap(ascii(text), f, size, BODY_W - indent);
    const lead = size * (opts.lead || 1.36);
    need(lines.length * lead);
    for (const line of lines) {
      page.drawText(line, {
        x: MARGIN + indent,
        y: y - size,
        size,
        font: f,
        color: opts.color || INK
      });
      y -= lead;
    }
    if (opts.after) y -= opts.after;
  };

  const rule = (gap = 8, thickness = 0.7, color = LINE) => {
    need(gap + 2);
    y -= gap;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE.w - MARGIN, y },
      thickness,
      color
    });
    y -= gap;
  };

  /* ------------------------------ head ---------------------------- */

  write(DOC.company.toUpperCase(), { size: 19, bold: true, lead: 1.15 });
  y -= 1;
  write(DOC.tagline, { size: 7.6, color: MUTED, lead: 1.2, after: 4 });

  /* The double rule under the letterhead. */
  need(6);
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE.w - MARGIN, y }, thickness: 1.4, color: INK });
  y -= 3;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE.w - MARGIN, y }, thickness: 0.6, color: INK });
  y -= 18;

  /* Centred title. */
  {
    const size = 13;
    const w = bold.widthOfTextAtSize(ascii(DOC.title), size);
    need(size * 1.6);
    page.drawText(ascii(DOC.title), {
      x: MARGIN + (BODY_W - w) / 2, y: y - size, size, font: bold, color: INK
    });
    y -= size * 1.7;
  }

  write(DOC.intro, { size: 9.5, lead: 1.38, after: 10 });

  /* --------------------------- detail table ----------------------- */

  const vehicleName = [
    data.model_year || data.year,
    data.vehicle_name || data.name,
    data.trim_level || data.trim
  ].filter(Boolean).join(' ');

  const monthly = Number(data.monthly_rate || data.monthlyRate || 0);
  const money = n => '$' + Number(n || 0).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /* 2026-10-27 -> "27 October 2026". Built from the ISO parts rather
     than through a Date, so a date-only string cannot shift a day
     either way on a machine in a behind-UTC timezone. Anything that is
     not a plain ISO date is passed through untouched. */
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const longDate = v => {
    const s = String(v == null ? '' : v).slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return String(v == null ? '' : v);
    const mi = Number(m[2]) - 1;
    if (mi < 0 || mi > 11) return s;
    return `${Number(m[3])} ${MONTHS[mi]} ${m[1]}`;
  };

  /* A blank cell is left blank rather than filled with a dash: the form
     is also printed and completed by hand, and a dash reads as "none". */
  const values = {
    driverName: data.full_name || data.customerName || '',
    vehicle: [vehicleName, data.registration || data.vehicleRegistration]
      .filter(Boolean).join('  -  '),
    /* The field is headed "PICKUP DATE & TIME", so it carries both when
       a collection time has been agreed. Without one it stays a bare
       date rather than inventing midnight. */
    pickup: (() => {
      const raw0 = data.starts_on || data.from || '';
      if (!raw0) return '';
      const date = longDate(raw0);
      const raw = data.pickup_time || data.pickupTime || '';
      const t = String(raw).trim().slice(0, 5);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return String(date);
      /* 14:30 -> 2:30 PM, which is how the office writes it. */
      const [h, m] = t.split(':').map(Number);
      const ampm = h < 12 ? 'AM' : 'PM';
      const h12 = h % 12 === 0 ? 12 : h % 12;
      return `${date}   ${h12}:${String(m).padStart(2, '0')} ${ampm}`;
    })(),
    /* The exact term the agreement covers. Written out ("27 October
       2026") rather than as 2026-10-27, because the document is read
       and signed by hand and a numeric date is ambiguous between the
       US and every other convention. An open return has no agreed end
       date, so it says so instead of printing a placeholder the renter
       might mistake for a commitment. */
    /* The month this copy covers, not the whole term. The agreement is
       a monthly one that renews ("a monthly rental agreement with a
       one-month minimum"), so each month gets its own dated copy: the
       first covers the opening segment, and once that month is behind
       them the next copy carries the next month's dates. The caller
       passes the segment; without one this falls back to the full term
       so any older code path still produces a valid document. */
    startDate: longDate(data.period_from || data.starts_on || data.from || ''),
    endDate: (data.open_return || data.openReturn)
      ? 'Open return - no fixed date'
      : longDate(data.period_to || data.ends_on || data.to || ''),
    monthlyRent: monthly ? `${money(monthly)} / month` : '',
    /* Which month this copy is for, and what is owed for it. A part
       month is charged for its days, so the figure here can differ
       from the monthly rent above — saying both keeps the renter from
       reading the smaller sum as an error. */
    periodLabel: data.period_label || '',
    periodAmount: data.period_amount != null && data.period_amount !== ''
      ? money(data.period_amount) : '',
    licence: data.license_number || data.licenseNumber || '',
    phone: data.phone || '',
    email: data.email || '',
    referralName: data.referral_name || '',
    referralPhone: data.referral_phone || ''
  };

  const ROW_H = 19;
  const COL = BODY_W / 2;
  const LABEL_W = 118;

  need(DOC.detailFields.length * ROW_H + 8);
  const tableTop = y;

  DOC.detailFields.forEach((row, i) => {
    const rowY = tableTop - i * ROW_H;

    row.forEach((cell, side) => {
      if (!cell) return;
      const [label, key] = cell;
      const x = MARGIN + side * COL;
      /* A full-width cell (email) spans both columns. */
      const cellW = row[1] === null ? BODY_W : COL;

      page.drawRectangle({
        x, y: rowY - ROW_H, width: LABEL_W, height: ROW_H,
        color: rgb(0.965, 0.965, 0.962)
      });
      page.drawText(ascii(label), {
        x: x + 6, y: rowY - ROW_H + 6.5, size: 7.3, font, color: MUTED
      });
      /* Fit the value to its cell. A long "vehicle - plate" ran past
         the table edge, so it is shrunk a little before being trimmed —
         a registration cut short is worse than one set a point smaller,
         since the plate is what identifies the car. */
      const valW = cellW - LABEL_W - 12;
      let val = ascii(values[key] || '');
      let valSize = 9.3;
      while (valSize > 7.2 && font.widthOfTextAtSize(val, valSize) > valW) valSize -= 0.2;
      while (val && font.widthOfTextAtSize(val, valSize) > valW) val = val.slice(0, -1);
      page.drawText(val, {
        x: x + LABEL_W + 7, y: rowY - ROW_H + 6, size: valSize, font, color: INK
      });

      /* cell borders */
      page.drawRectangle({
        x, y: rowY - ROW_H, width: cellW, height: ROW_H,
        borderColor: LINE, borderWidth: 0.6, opacity: 0
      });
      page.drawLine({
        start: { x: x + LABEL_W, y: rowY - ROW_H },
        end: { x: x + LABEL_W, y: rowY },
        thickness: 0.6, color: LINE
      });
    });
  });

  y = tableTop - DOC.detailFields.length * ROW_H - 16;

  /* ---------------------------- sections -------------------------- */

  DOC.sections.forEach((section, i) => {
    const headingSize = 9.6;
    /* Keep a heading with at least its first two lines. */
    need(headingSize * 1.6 + 30);

    write(`${i + 1}.  ${section.heading}`, {
      size: headingSize, bold: true, lead: 1.35
    });
    rule(3, 0.5);

    section.paragraphs.forEach((para, pi) => {
      write(para, {
        size: 9.4,
        lead: 1.38,
        after: pi === section.paragraphs.length - 1 ? 7 : 4
      });
    });
  });

  /* --------------------------- signature -------------------------- */

  need(140);
  rule(10, 0.8, INK);
  write(DOC.acknowledgement, { size: 9.4, after: 22 });

  const signedName = ascii(
    (signature && (signature.typedName || signature.name)) ||
    data.full_name || data.customerName || ''
  );
  const signedOn = ascii(
    (signature && signature.signedOn) || new Date().toISOString().slice(0, 10)
  );

  /* Decode the drawn signature first, but do NOT draw it yet: the
     space for the signature block is reserved below, and only then is
     `lineY` known. Drawing beforehand placed the image against a `y`
     that the following need(70) could still move, so the signature
     could sit away from the rule it belongs to — or on the wrong page.
     It is stamped after lineY is fixed, sitting on the DRIVER
     SIGNATURE line exactly as a pen would. */
  let sigPng = null;
  if (signature && signature.dataUrl) {
    try {
      const base64 = String(signature.dataUrl).split(',').pop();
      sigPng = await pdf.embedPng(Buffer.from(base64, 'base64'));
    } catch {
      /* An unreadable signature must not lose the whole contract —
         fall through to the typed name on the line. */
    }
  }

  /* Reserve the block plus room for the signature image above it. */
  const sigH = sigPng
    ? Math.min(44, sigPng.height * Math.min(180 / sigPng.width, 44 / sigPng.height, 1))
    : 0;
  need(70 + sigH);
  const lineY = y - 26;

  let stamped = false;
  if (sigPng) {
    const scale = Math.min(180 / sigPng.width, 44 / sigPng.height, 1);
    const w = sigPng.width * scale, h = sigPng.height * scale;
    /* Sits ON the rule: a couple of points of clearance so the ink
       does not touch the line, as a hand-signed form looks. */
    page.drawImage(sigPng, {
      x: MARGIN + COL + 4,
      y: lineY + 3,
      width: w,
      height: h
    });
    stamped = true;
  }
  const sigCols = [
    ['FULL NAME (PRINT)', MARGIN, COL - 24],
    ['DRIVER SIGNATURE', MARGIN + COL, COL - 24]
  ];
  for (const [label, x, w] of sigCols) {
    page.drawLine({
      start: { x, y: lineY }, end: { x: x + w, y: lineY },
      thickness: 0.7, color: rgb(0.3, 0.3, 0.3)
    });
    page.drawText(ascii(label), {
      x, y: lineY - 11, size: 7.3, font, color: MUTED
    });
  }
  page.drawText(signedName, { x: MARGIN + 2, y: lineY + 7, size: 10.5, font, color: INK });
  if (!stamped && signedName) {
    page.drawText(signedName, {
      x: MARGIN + COL + 4, y: lineY + 7, size: 13, font: italic, color: INK
    });
  }

  /* The date sits on its own line beneath, as on the printed form. */
  const dateY = lineY - 34;
  page.drawLine({
    start: { x: MARGIN, y: dateY }, end: { x: MARGIN + COL - 24, y: dateY },
    thickness: 0.7, color: rgb(0.3, 0.3, 0.3)
  });
  page.drawText('DATE', { x: MARGIN, y: dateY - 11, size: 7.3, font, color: MUTED });
  page.drawText(signedOn, { x: MARGIN + 2, y: dateY + 7, size: 10.5, font, color: INK });

  y = dateY - 30;

  if (signature) {
    const how = signature.dataUrl && stamped
      ? 'drawn on screen'
      : signature.method === 'upload' ? 'uploaded' : 'typed';
    const meta = `Signed electronically (${how}) on ${signedOn}`
      + (signature.ip ? ` from ${signature.ip}` : '');
    write(meta, { size: 7.5, italic: true, color: MUTED, after: 6 });
  }

  /* ----------------------------- footer --------------------------- */

  {
    const size = 7.6;
    const w = font.widthOfTextAtSize(ascii(DOC.footer), size);
    need(26);
    rule(8, 0.6);
    page.drawText(ascii(DOC.footer), {
      x: MARGIN + (BODY_W - w) / 2, y: y - size, size, font, color: MUTED
    });
  }

  return Buffer.from(await pdf.save());
}

module.exports = {
  generateContractPdf,
  contractTerms,
  COMPANY,
  /* Kept for callers that referenced the old flat lists. */
  CLAUSES: T.SECTIONS,
  HEADER_TERMS: []
};
