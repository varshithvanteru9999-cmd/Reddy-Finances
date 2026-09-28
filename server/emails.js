/* ------------------------------------------------------------------
   Customer email templates.

   Plain tables and inline styles throughout — email clients strip
   <style> blocks and understand very little CSS, so anything cleverer
   than this arrives broken in Outlook.
------------------------------------------------------------------- */

const COMPANY = 'Reddy Finances';
const CITY = 'Dallas, TX';

const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = n => '$' + Number(n || 0).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const prettyDate = iso => {
  const d = new Date(String(iso) + 'T00:00:00');
  if (isNaN(d)) return String(iso || '');
  const M = ['January','February','March','April','May','June',
             'July','August','September','October','November','December'];
  return `${d.getDate()} ${M[d.getMonth()]} ${d.getFullYear()}`;
};

/* Shared frame: coloured header bar, body, sign-off. */
function shell({ accent, eyebrow, heading, intro, rows, callout, cta, closing }) {
  const rowHtml = (rows || []).map(([k, v]) => `
    <tr>
      <td style="padding:9px 0;border-bottom:1px solid #ececf0;font-size:13px;color:#666;width:42%;">${esc(k)}</td>
      <td style="padding:9px 0;border-bottom:1px solid #ececf0;font-size:13px;color:#111;font-weight:600;">${esc(v)}</td>
    </tr>`).join('');

  return `
  <div style="margin:0;padding:24px 12px;background:#f4f4f6;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06);">

      <div style="background:${accent};padding:22px 28px;">
        <div style="font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.82);">${esc(eyebrow)}</div>
        <div style="font-size:21px;font-weight:700;color:#ffffff;margin-top:5px;">${esc(heading)}</div>
      </div>

      <div style="padding:28px;">
        <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#333;">${intro}</p>

        ${rowHtml ? `<table style="width:100%;border-collapse:collapse;margin-bottom:20px;">${rowHtml}</table>` : ''}

        ${callout ? `
          <div style="margin:0 0 20px;padding:14px 16px;background:${callout.bg};border-left:4px solid ${callout.border};border-radius:4px;">
            ${callout.title ? `<div style="font-size:13px;font-weight:700;color:${callout.ink};margin-bottom:6px;">${esc(callout.title)}</div>` : ''}
            <div style="font-size:13px;line-height:1.6;color:${callout.ink};">${callout.body}</div>
          </div>` : ''}

        ${cta ? `
          <div style="text-align:center;margin:26px 0 6px;">
            <a href="${esc(cta.href)}"
               style="display:inline-block;padding:13px 30px;background:${accent};color:#ffffff;
                      text-decoration:none;border-radius:999px;font-size:13px;font-weight:700;
                      letter-spacing:.08em;">${esc(cta.label)}</a>
          </div>` : ''}

        ${closing ? `<p style="margin:22px 0 0;font-size:13px;line-height:1.6;color:#555;">${closing}</p>` : ''}
      </div>

      <div style="padding:16px 28px;background:#fafafa;border-top:1px solid #ececf0;">
        <p style="margin:0;font-size:11px;color:#999;">${esc(COMPANY)} &mdash; ${esc(CITY)}</p>
      </div>
    </div>
  </div>`;
}

/* ------------------------- slot booked ---------------------------- */

function slotBookedEmail(b, appUrl) {
  const car = `${b.model_year || ''} ${b.vehicle_name || ''}`.trim() || 'your vehicle';
  /* Rent + tolls + the deposit charged on top — the same sum the
     dashboard's amountDue() uses, so a customer reading this email and
     an admin reading the booking row see the same number. The old
     figure left the deposit out entirely and understated the total. */
  const rent = Number(b.total || 0) + Number(b.toll_charges || 0);
  const deposit = Number(b.advance_amount || 0);
  const total = rent + deposit;
  const paid = Number(b.verified_paid || 0);
  const outstanding = Math.max(0, total - paid);
  const place = String(b.pickup_location || '').trim();

  return {
    subject: `Slot booked — ${b.reference} confirmed`,
    html: shell({
      accent: '#0f7a4a',
      eyebrow: 'Booking confirmed',
      heading: 'Your slot is booked',
      intro: `Hello ${esc(b.full_name || 'there')},<br><br>`
           + `Good news — your booking for the <strong>${esc(car)}</strong> has been approved `
           + `and the slot is reserved in your name.`,
      /* The address leads.

         It is the one thing the customer has to act on — everything
         else they already know from booking. Buried fourth in the
         list it read as another detail; at the top it is the answer
         to "where do I go?". The date follows it, then the rest. */
      rows: [
        ...(place ? [['Collect from', esc(place)]] : []),
        ['Pick-up', prettyDate(b.starts_on)],
        ['Return', prettyDate(b.ends_on)],
        ['Vehicle', car],
        ['Reference', b.reference],
        /* The money, broken out rather than given as one figure: a
           customer who has paid a deposit wants to see it counted. */
        ...(deposit ? [['Deposit paid', money(deposit)]] : []),
        ...(total ? [['Total', money(total)]] : []),
        ...(paid && paid !== deposit ? [['Received', money(paid)]] : []),
        ...(total && outstanding !== total
              ? [['Balance due', money(outstanding)]] : [])
      ],
      callout: {
        bg: '#fff8e6', border: '#E2A03F', ink: '#6b5120',
        title: 'Before you collect the car',
        body: (place
                ? `Collect the car from <strong>${esc(place)}</strong> on `
                  + `${prettyDate(b.starts_on)}.<br><br>`
                : '')
            + 'You must upload five photos of the vehicle: the odometer, and the '
            + 'front, rear, left and right sides. This is required &mdash; it records '
            + 'the car&rsquo;s condition at handover and protects you from being '
            + 'charged for damage that was already there.'
      },
      cta: { href: `${appUrl}/bookings.html`, label: 'Upload your photos' },
      closing: 'If anything about these details looks wrong, reply to this email and we will sort it out.'
    })
  };
}

/* ------------------------ slot rejected --------------------------- */

function slotRejectedEmail(b, reason, appUrl) {
  const car = `${b.model_year || ''} ${b.vehicle_name || ''}`.trim() || 'the vehicle';

  return {
    subject: `Slot rejected — ${b.reference}`,
    html: shell({
      accent: '#B02020',
      eyebrow: 'Booking not confirmed',
      heading: 'Slot rejected',
      intro: `Hello ${esc(b.full_name || 'there')},<br><br>`
           + `We are sorry &mdash; we could not confirm your booking for the `
           + `<strong>${esc(car)}</strong>. The car is not available for the dates you asked for.`,
      rows: [
        ['Reference', b.reference],
        ['Vehicle', car],
        ['Requested pick-up', prettyDate(b.starts_on)],
        ['Requested return', prettyDate(b.ends_on)]
      ],
      callout: reason ? {
        bg: '#fdf0f0', border: '#B02020', ink: '#6b2020',
        title: 'Reason', body: esc(reason)
      } : null,
      cta: { href: `${appUrl}/index.html#fleet`, label: 'See available cars' },
      closing: 'Nothing has been charged. Plenty of other cars are free for those dates &mdash; '
             + 'have a look, or reply to this email and we will find you something.'
    })
  };
}

module.exports = { slotBookedEmail, slotRejectedEmail };
