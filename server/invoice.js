/* ------------------------------------------------------------------
   Invoices.

   Two renderings of the same figures:
     invoiceHtml() — the email body
     invoicePdf()  — the attachment

   The money is always the same three lines the client asked for:
     rental total due, toll fees, and the sum of the two.
------------------------------------------------------------------- */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const COMPANY = 'Reddy Finances';
const COMPANY_LINES = [
  'Reddy Finances — Car Rental & Sales',
  'Dallas, TX',
  'reddyfinancialsinc@gmail.com'
];

const money = n => '$' + Number(n || 0).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* WinAnsi cannot draw smart quotes or dashes and pdf-lib throws on them. */
const ascii = v => String(v == null ? '' : v)
  .replace(/[‘’‛]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/…/g, '...')
  .replace(/[^\x20-\x7E]/g, '');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* Everything the two renderers need, worked out once. */
function invoiceModel(booking) {
  const rental = Number(booking.total || 0);
  const tolls = Number(booking.tolls ?? booking.toll_charges ?? 0);
  const advance = Number(booking.advance ?? booking.advance_amount ?? 0);
  /* A balance carried over from an earlier period. It belongs on the
     invoice: leaving it off bills the customer less than they owe and
     the shortfall never reappears anywhere. */
  const storedPending = Number(booking.pending ?? booking.pending_amount ?? 0);
  /* What has already been settled, so the invoice can show what is
     actually left to pay rather than the gross figure again. */
  const paid = Number(booking.paid ?? booking.verifiedPaid ?? 0);

  /* The Pending column holds two different things depending on how it
     was written: a balance carried in from an earlier month, or the
     shortfall left by a part payment on THESE charges.

     Only the first is a charge. The second is already covered — those
     charges are on the invoice and the payment is subtracted below —
     so adding it again billed the same money twice: a $400 payment on
     a $1,026.77 booking produced a $1,653.54 invoice.

     Anything the payments already account for is therefore dropped. */
  /* The deposit is money received, not a charge: it is credited
     alongside the payments rather than added to what is owed. */
  const received = round2(paid + advance);
  const unpaidHere = Math.max(0, round2(rental + tolls - received));
  const pending = round2(Math.max(0, storedPending - unpaidHere));

  const vehicle = [
    booking.vehicleYear || booking.model_year,
    booking.vehicleName || booking.vehicle_name,
    booking.trim_level
  ].filter(Boolean).join(' ');

  const number = `INV-${String(booking.reference || booking.id || '').replace(/^BK-/, '')}`;

  return {
    number,
    reference: booking.reference || booking.id || '',
    issued: new Date().toISOString().slice(0, 10),
    customer: booking.full_name || booking.name || '',
    email: booking.email || '',
    phone: booking.phone || '',
    vehicle: vehicle || 'Vehicle',
    from: booking.starts_on || booking.from || '',
    to: booking.ends_on || booking.to || '',
    rental,
    tolls,
    advance,
    pending,
    paid,
    /* Rounded to the cent: adding four floats leaves drift like
       5167.780000000001, which would reach the printed invoice. */
    /* The deposit does not appear in the total — it is subtracted in
       `due` as money already handed over. Adding it billed the
       customer for their own deposit: a $500 rental with $100 down
       invoiced $600 and still showed $500 outstanding. */
    total: round2(rental + tolls + pending),
    due: round2(Math.max(0, rental + tolls + pending - paid - advance)),
    /* Set only when this invoice bills part of the term: the month it
       covers and the days within it. A first month starting mid-month
       is billed for those days alone, and without naming the period the
       smaller figure reads as a mistake. */
    periodLabel: booking.period_label || '',
    periodFrom: booking.period_from || '',
    periodTo: booking.period_to || '',
    periodDays: Number(booking.period_days) || 0,
    tollNotes: booking.tollNotes || booking.toll_notes || ''
  };
}

/* ------------------------- toll statement -------------------------
   Tolls cannot go on the rental invoice: that one is raised when the
   customer collects the car, before a single toll has been run up.
   They arrive later, on a statement the operator sends, and are billed
   on their own — normally on the 1st, covering the month just gone.

   Deliberately a separate document, not a variant of the rental
   invoice: nothing here is pro-rated, there is no advance and no
   balance brought forward, and the customer should be able to see at a
   glance that this is a pass-through charge rather than rent.
------------------------------------------------------------------- */
function tollModel(booking, opts = {}) {
  const amount = round2(Number(booking.tolls ?? booking.toll_charges ?? 0));
  const notes = booking.tollNotes || booking.toll_notes || '';

  const vehicle = [
    booking.vehicleYear || booking.model_year,
    booking.vehicleName || booking.vehicle_name,
    booking.trim_level
  ].filter(Boolean).join(' ');

  const ref = booking.reference || booking.id || '';
  /* A distinct series from the rental invoice, so the two can never be
     mistaken for each other in the customer's records or in yours. */
  const number = `TOLL-${String(ref).replace(/^BK-/, '')}-${(opts.period || todayISO()).replace(/-/g, '').slice(0, 6)}`;

  return {
    number,
    reference: ref,
    issued: opts.issued || todayISO(),
    period: opts.period || todayISO().slice(0, 7),
    customer: booking.full_name || booking.name || '',
    email: booking.email || '',
    phone: booking.phone || '',
    vehicle: vehicle || 'Vehicle',
    registration: booking.vehicleRegistration || booking.registration || '',
    amount,
    notes
  };
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

function tollInvoiceHtml(booking, opts = {}) {
  const m = tollModel(booking, opts);

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#111;">
    <div style="border-bottom:3px solid #E2A03F;padding-bottom:14px;margin-bottom:22px;">
      <h1 style="margin:0;font-size:22px;letter-spacing:.02em;">TOLL STATEMENT</h1>
      <p style="margin:6px 0 0;font-size:13px;color:#666;">
        ${esc(m.number)} &middot; issued ${esc(m.issued)}
      </p>
    </div>

    <p style="margin:0 0 20px;font-size:13.5px;line-height:1.6;color:#444;">
      Tolls recorded against your rental. These are charged separately
      from your rent, at the amount billed by the toll operator.
    </p>

    <table style="width:100%;border-collapse:collapse;margin-bottom:22px;">
      <tr>
        <td style="vertical-align:top;font-size:13px;line-height:1.6;color:#555;">
          <strong style="color:#111;">From</strong><br>
          ${COMPANY_LINES.map(esc).join('<br>')}
        </td>
        <td style="vertical-align:top;font-size:13px;line-height:1.6;color:#555;text-align:right;">
          <strong style="color:#111;">Billed to</strong><br>
          ${esc(m.customer)}<br>
          ${m.email ? esc(m.email) + '<br>' : ''}
          ${m.phone ? esc(m.phone) : ''}
        </td>
      </tr>
    </table>

    <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #ececf0;font-size:14px;color:#555;">Booking reference</td>
        <td style="padding:10px 0;border-bottom:1px solid #ececf0;font-size:14px;text-align:right;color:#111;">${esc(m.reference)}</td>
      </tr>
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #ececf0;font-size:14px;color:#555;">Vehicle</td>
        <td style="padding:10px 0;border-bottom:1px solid #ececf0;font-size:14px;text-align:right;color:#111;">${esc(m.vehicle)}${m.registration ? ' &middot; ' + esc(m.registration) : ''}</td>
      </tr>
    </table>

    <table style="width:100%;border-collapse:collapse;margin-top:20px;">
      <tr>
        <td style="padding:14px 0 0;font-size:16px;font-weight:700;color:#111;">Toll charges</td>
        <td style="padding:14px 0 0;font-size:20px;font-weight:700;text-align:right;color:#E2A03F;">${esc(money(m.amount))}</td>
      </tr>
    </table>

    ${m.notes ? `
      <p style="margin:20px 0 0;padding:12px 14px;background:#faf7f0;border-left:3px solid #E2A03F;font-size:12.5px;line-height:1.55;color:#584a2e;">
        <strong>Detail:</strong> ${esc(m.notes)}
      </p>` : ''}

    <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#777;">
      Tolls are passed through at cost. Queries about a specific crossing
      should quote this statement number.
    </p>
  </div>`;
}

/* ------------------------------ HTML ------------------------------ */

function invoiceHtml(booking) {
  const m = invoiceModel(booking);

  const row = (label, value, opts = {}) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #ececf0;font-size:14px;color:${opts.strong ? '#111' : '#555'};${opts.strong ? 'font-weight:700;' : ''}">${esc(label)}</td>
      <td style="padding:10px 0;border-bottom:1px solid #ececf0;font-size:14px;text-align:right;color:#111;${opts.strong ? 'font-weight:700;' : ''}">${esc(value)}</td>
    </tr>`;

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#111;">
    <div style="border-bottom:3px solid #DF0000;padding-bottom:14px;margin-bottom:22px;">
      <h1 style="margin:0;font-size:22px;letter-spacing:.02em;">INVOICE</h1>
      <p style="margin:6px 0 0;font-size:13px;color:#666;">
        ${esc(m.number)} &middot; issued ${esc(m.issued)}
      </p>
    </div>

    <table style="width:100%;border-collapse:collapse;margin-bottom:22px;">
      <tr>
        <td style="vertical-align:top;font-size:13px;line-height:1.6;color:#555;">
          <strong style="color:#111;">From</strong><br>
          ${COMPANY_LINES.map(esc).join('<br>')}
        </td>
        <td style="vertical-align:top;font-size:13px;line-height:1.6;color:#555;text-align:right;">
          <strong style="color:#111;">Billed to</strong><br>
          ${esc(m.customer)}<br>
          ${m.email ? esc(m.email) + '<br>' : ''}
          ${m.phone ? esc(m.phone) : ''}
        </td>
      </tr>
    </table>

    <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
      ${row('Booking reference', m.reference)}
      ${row('Vehicle', m.vehicle)}
      ${row('Rental period', `${m.from} to ${m.to}`)}
      ${m.periodLabel
        ? row('This invoice covers',
              `${esc(m.periodLabel)} — ${esc(m.periodFrom)} to ${esc(m.periodTo)}`
              + (m.periodDays ? ` (${m.periodDays} day${m.periodDays === 1 ? '' : 's'})` : ''))
        : ''}
    </table>

    <table style="width:100%;border-collapse:collapse;margin-top:20px;">
      ${row(m.periodLabel ? `Rental (${esc(m.periodLabel)})` : 'Total due (rental)', money(m.rental))}
      ${row('Toll fees', money(m.tolls))}
      ${m.advance ? row('Advance (deposit)', money(m.advance)) : ''}
      ${m.pending ? row('Previous balance (unpaid)', money(m.pending)) : ''}
      <tr>
        <td style="padding:14px 0 0;font-size:16px;font-weight:700;color:#111;">Total payable</td>
        <td style="padding:14px 0 0;font-size:20px;font-weight:700;text-align:right;color:#DF0000;">${esc(money(m.total))}</td>
      </tr>
      ${/* The deposit is refundable, so the invoice says so rather than
           leaving the customer to read it as rent. The wording matches
           the rental agreement exactly — an invoice that promised
           something softer or firmer than the contract would be the
           document people argue from. */''}
      ${m.advance > 0 ? `
      <tr>
        <td colspan="2" style="padding:10px 0 0;font-size:12px;line-height:1.55;color:#777;">
          The advance of <strong style="color:#111;">${esc(money(m.advance))}</strong> is a
          refundable deposit, returned in full two weeks after the vehicle
          is returned, less any tolls owed or late-return charges.
        </td>
      </tr>` : ''}
      ${m.paid ? `
      <tr>
        <td style="padding:6px 0 0;font-size:13px;color:#2e7d52;">Already paid</td>
        <td style="padding:6px 0 0;font-size:13px;text-align:right;color:#2e7d52;">&minus;${esc(money(m.paid))}</td>
      </tr>
      <tr>
        <td style="padding:8px 0 0;font-size:15px;font-weight:700;color:#111;">Balance due</td>
        <td style="padding:8px 0 0;font-size:17px;font-weight:700;text-align:right;color:#DF0000;">${esc(money(m.due))}</td>
      </tr>` : ''}
    </table>

    ${m.tollNotes ? `
      <p style="margin:20px 0 0;padding:12px 14px;background:#faf7f0;border-left:3px solid #E2A03F;font-size:12.5px;line-height:1.55;color:#584a2e;">
        <strong>Toll notes:</strong> ${esc(m.tollNotes)}
      </p>` : ''}

    <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#777;">
      Toll fees are charged after your ride, as set out in your rental agreement.
      Please settle this invoice by the date agreed with our office.
    </p>

    <hr style="margin:26px 0 14px;border:0;border-top:1px solid #ececf0;">
    <p style="margin:0;font-size:11px;color:#999;">${esc(COMPANY)} &mdash; Dallas, TX</p>
  </div>`;
}

/* ------------------------------- PDF ------------------------------ */

async function invoicePdf(booking) {
  const m = invoiceModel(booking);

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const RED = rgb(0.87, 0, 0);
  const INK = rgb(0.07, 0.07, 0.07);
  const MUTED = rgb(0.42, 0.42, 0.42);
  const GREEN = rgb(0.18, 0.49, 0.32);
  const M = 52;
  let y = 740;

  const text = (str, x, size, f = font, color = INK) =>
    page.drawText(ascii(str), { x, y, size, font: f, color });

  const right = (str, xRight, size, f = font, color = INK) => {
    const s = ascii(str);
    page.drawText(s, { x: xRight - f.widthOfTextAtSize(s, size), y, size, font: f, color });
  };

  const line = (yy, thickness = 0.8, color = rgb(0.88, 0.88, 0.9)) =>
    page.drawLine({ start: { x: M, y: yy }, end: { x: 612 - M, y: yy }, thickness, color });

  /* header */
  text('INVOICE', M, 24, bold);
  y -= 18;
  text(`${m.number}  .  issued ${m.issued}`, M, 10, font, MUTED);
  y -= 12;
  page.drawRectangle({ x: M, y, width: 612 - M * 2, height: 2.4, color: RED });

  /* parties */
  y -= 34;
  const colR = 330;
  text('FROM', M, 8, bold, MUTED);
  page.drawText('BILLED TO', { x: colR, y, size: 8, font: bold, color: MUTED });
  y -= 14;
  const fromLines = COMPANY_LINES;
  const toLines = [m.customer, m.email, m.phone].filter(Boolean);
  const rows = Math.max(fromLines.length, toLines.length);
  for (let i = 0; i < rows; i++) {
    if (fromLines[i]) page.drawText(ascii(fromLines[i]), { x: M, y, size: 10, font, color: INK });
    if (toLines[i]) page.drawText(ascii(toLines[i]), { x: colR, y, size: 10, font, color: INK });
    y -= 14;
  }

  /* booking detail */
  y -= 14;
  line(y); y -= 20;
  for (const [k, v] of [
    ['Booking reference', m.reference],
    ['Vehicle', m.vehicle],
    ['Rental period', `${m.from} to ${m.to}`],
    ...(m.periodLabel
      ? [['This invoice covers',
          `${m.periodLabel} - ${m.periodFrom} to ${m.periodTo}`
          + (m.periodDays ? ` (${m.periodDays} day${m.periodDays === 1 ? '' : 's'})` : '')]]
      : [])
  ]) {
    text(k, M, 10, font, MUTED);
    right(v, 612 - M, 10, font, INK);
    y -= 18;
  }

  /* money — the three lines the client asked for */
  y -= 8;
  line(y); y -= 24;

  text(m.periodLabel ? `Rental (${m.periodLabel})` : 'Total due (rental)', M, 11, font, INK);
  right(money(m.rental), 612 - M, 11, font, INK);
  y -= 20;

  text('Toll fees', M, 11, font, INK);
  right(money(m.tolls), 612 - M, 11, font, INK);
  y -= 20;

  if (m.advance) {
    text('Advance (deposit)', M, 11, font, INK);
    right(money(m.advance), 612 - M, 11, font, INK);
    y -= 20;
  }
  if (m.pending) {
    text('Previous balance (unpaid)', M, 11, font, INK);
    right(money(m.pending), 612 - M, 11, font, INK);
    y -= 20;
  }
  y += 8;

  line(y, 0.8); y -= 26;

  text('TOTAL PAYABLE', M, 12, bold, INK);
  right(money(m.total), 612 - M, 19, bold, RED);
  y -= 28;


  /* The deposit is refundable; the wording matches the rental
     agreement so the two documents cannot be read against each other. */
  if (m.advance > 0) {
    text(`The advance of ${money(m.advance)} is a refundable deposit, returned in full`, M, 9.5, font, MUTED);
    y -= 13;
    text('two weeks after the vehicle is returned, less any tolls owed or', M, 9.5, font, MUTED);
    y -= 13;
    text('late-return charges.', M, 9.5, font, MUTED);
    y -= 20;
  }

  /* When money has already come in, the invoice ends on what is left
     rather than the gross figure — otherwise a part-paid customer is
     shown a number that looks like a fresh demand for the whole sum. */
  if (m.paid) {
    text('Already paid', M, 11, font, GREEN);
    right('-' + money(m.paid), 612 - M, 11, font, GREEN);
    y -= 22;
    text('BALANCE DUE', M, 12, bold, INK);
    right(money(m.due), 612 - M, 17, bold, RED);
    y -= 28;
  }

  if (m.tollNotes) {
    line(y); y -= 18;
    text('Toll notes', M, 9, bold, MUTED);
    y -= 13;
    /* wrap the note by hand — pdf-lib has no line breaking */
    const words = ascii(m.tollNotes).split(/\s+/);
    let ln = '';
    for (const w of words) {
      const next = ln ? `${ln} ${w}` : w;
      if (font.widthOfTextAtSize(next, 9.5) > 612 - M * 2) {
        page.drawText(ln, { x: M, y, size: 9.5, font, color: INK });
        y -= 13;
        ln = w;
      } else ln = next;
    }
    if (ln) { page.drawText(ln, { x: M, y, size: 9.5, font, color: INK }); y -= 13; }
  }

  y -= 10;
  page.drawText(
    ascii('Toll fees are charged after your ride, as set out in your rental agreement.'),
    { x: M, y, size: 8.5, font, color: MUTED }
  );

  return { buffer: Buffer.from(await pdf.save()), model: m };
}

module.exports = { invoiceHtml, invoicePdf, invoiceModel,
                   tollInvoiceHtml, tollModel };
