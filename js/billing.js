/* ------------------------------------------------------------------
   Rental billing.

   The rule, as specified by the client:

     - A full calendar month bills at the monthly rate.
     - A part-month bills at (monthly rate / 30) x days used.
     - The divisor is ALWAYS 30, even in a 31-day month.
     - Rentals run for a minimum of one month.
     - Open-return bookings default to the end of the pickup month.

   Worked example — picked up 2 Sep, returned 31 Oct, monthly $2,400:
     Sep  2–30  = 29 days  ->  2400/30 = $80/day  ->  $2,320
     Oct  1–31  = full     ->                          $2,400
     total                                              $4,720

   Shared by the browser and the server, so one set of numbers governs
   what the customer is quoted and what the database stores.
------------------------------------------------------------------- */

const DIVISOR = 30;   /* fixed by the billing rule, not by month length */

const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* Local-noon parsing keeps a date from sliding a day under a timezone
   offset, which would silently change what gets billed. */
function asDate(value) {
  if (value instanceof Date) return value;
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

/* The last day a month can be BILLED for.

   Every month is treated as 30 days, so a 31-day month bills to the
   30th and the 31st is skipped — the next period starts on the 1st of
   the following month. February is untouched: it ends when it ends.

   This is the office's current rule and is under review with the
   client; it lives in one place so reverting it is a one-line change.
   Note the consequence: on a 31-day month the customer holds the car
   for a day that no period covers and no invoice charges. */
const BILL_DAY_CAP = 30;
const billableMonthEnd = (y, m) => Math.min(daysInMonth(y, m), BILL_DAY_CAP);
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

/* Inclusive of both ends: the 2nd to the 30th is 29 days. */
function inclusiveDays(from, to) {
  return Math.round((asDate(to) - asDate(from)) / 86400000) + 1;
}

/* Is this date one the customer is charged for? The 31st is not. */
function isBillableDay(d) {
  return d.getDate() <= BILL_DAY_CAP;
}

/* The return date that gives the customer `days` BILLABLE days from a
   given pick-up.

   Counting a flat 29 days forward is wrong whenever a 31st falls in
   the span: that day is skipped by the billing rule, so the customer
   paid a full month's rent and received 29 charged days instead of 30.
   Across a year roughly four bookings in ten span a 31st, so this was
   not an edge case.

   Walking the calendar and counting only billable days costs nothing
   at this size and cannot drift from the rule above, which is the
   point of keeping it in this file. */
function returnDateFor(startsOn, days = BILL_DAY_CAP) {
  const d = asDate(startsOn);
  let counted = isBillableDay(d) ? 1 : 0;
  /* A bounded walk: even a 30-day term spanning several 31sts settles
     well inside this, and it can never spin. */
  for (let guard = 0; counted < days && guard < 400; guard++) {
    d.setDate(d.getDate() + 1);
    if (isBillableDay(d)) counted++;
  }
  return iso(d);
}

/* ------------------------------------------------------------------
   Splits a rental into calendar months and prices each one.
   Returns { lines, subtotal, days } — lines carry their own arithmetic
   so an invoice can show the working rather than just a figure.
------------------------------------------------------------------- */
function monthlyBreakdown(startsOn, endsOn, monthlyRate) {
  const start = asDate(startsOn);
  const end = asDate(endsOn);
  const rate = Number(monthlyRate) || 0;
  const perDay = round2(rate / DIVISOR);

  if (end < start) return { lines: [], subtotal: 0, days: 0 };

  const lines = [];
  let cursor = new Date(start);

  while (cursor <= end) {
    const y = cursor.getFullYear();
    const m = cursor.getMonth();
    /* Bills to the 30th even in a 31-day month: the 31st is skipped
       and the next period starts on the 1st. */
    const lastBillable = new Date(y, m, billableMonthEnd(y, m), 12, 0, 0);
    const segmentEnd = end < lastBillable ? end : lastBillable;

    const used = inclusiveDays(cursor, segmentEnd);

    /* A pick-up ON the 31st has no billable day left in that month, so
       the segment runs from the 31st back to the 30th: zero days, and
       a date range that reads backwards. It was still pushed as a line,
       and the quote showed "October 2026 · 0 of 30 days · $0.00" over
       "2026-10-31 → 2026-10-30".

       Nothing is owed for it — that is the rule — but an empty line
       priced at nothing does not belong on a customer's quote or an
       invoice, so the month is skipped and billing starts on the 1st. */
    if (used <= 0) {
      cursor = new Date(y, m + 1, 1, 12, 0, 0);
      continue;
    }
    const monthLength = daysInMonth(y, m);
    const billableLength = billableMonthEnd(y, m);

    /* Whole month = starts on the 1st and runs to the last BILLABLE
       day. A 31-day month ending on the 30th is still a whole month;
       a short February is not, and stays priced per-day. */
    const isWholeMonth = cursor.getDate() === 1
      && segmentEnd.getDate() === billableLength
      && monthLength >= DIVISOR;
    /* Multiply before rounding. Rounding the daily rate first and then
       multiplying loses cents: 2860/30 rounds to 95.33, and 95.33 x 30
       is 2859.90 — a month's rent ten cents short of the fleet price.
       `perDay` is still reported for the invoice's working. */
    const amount = isWholeMonth ? round2(rate) : round2((rate / DIVISOR) * used);

    lines.push({
      label: `${MONTHS[m]} ${y}`,
      from: iso(cursor),
      to: iso(segmentEnd),
      days: used,
      monthLength,
      whole: isWholeMonth,
      perDay,
      amount,
      note: isWholeMonth
        ? 'Full month at the monthly rate'
        : `${used} of ${DIVISOR} days at ${perDay.toFixed(2)}/day`
    });

    cursor = new Date(y, m + 1, 1, 12, 0, 0);
  }

  /* Each segment is rounded on its own, so a stretch split across three
     calendar months can land a cent either side of the true figure —
     30 days at 2860/30 came out as 2859.99. When the whole booking is
     exactly one billing month and no segment was charged flat, the
     difference is put back on the largest segment so the customer pays
     the monthly rate to the cent. */
  const totalDays = inclusiveDays(start, end);
  let subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));

  if (totalDays === DIVISOR && lines.length && !lines.some(l => l.whole)) {
    const drift = round2(rate - subtotal);
    if (drift !== 0) {
      const biggest = lines.reduce((a, l) => (l.days > a.days ? l : a));
      biggest.amount = round2(biggest.amount + drift);
      subtotal = round2(rate);
    }
  }

  return { lines, subtotal, days: totalDays };
}

/* ------------------------------------------------------------------
   Full quote for a booking.
   Sale vehicles are a single asking price, not a per-day charge.
------------------------------------------------------------------- */
function quote({ startsOn, endsOn, monthlyRate, dayRate, listingType = 'rental',
                 tolls = 0, advance = null }) {
  const toll = round2(Number(tolls) || 0);

  if (listingType === 'sale') {
    const price = round2(Number(dayRate) || 0);
    return {
      lines: [{ label: 'Asking price', days: 0, amount: price, note: 'One-off purchase' }],
      subtotal: price, tolls: toll, advance: 0,
      total: round2(price + toll), days: 0
    };
  }

  /* Without a monthly rate, fall back to the day rate so a booking can
     still be priced rather than coming out at zero. */
  const rate = Number(monthlyRate) > 0
    ? Number(monthlyRate)
    : round2((Number(dayRate) || 0) * DIVISOR);

  const { lines, subtotal, days } = monthlyBreakdown(startsOn, endsOn, rate);

  /* The advance is one month's rent unless the office sets its own
     figure. `advance` is only honoured when it is an actual number —
     null and '' mean "use the default", while 0 is a deliberate waiver
     and must survive. */
  const advanceGiven = advance !== null && advance !== undefined && advance !== '';
  const adv = advanceGiven ? round2(Math.max(0, Number(advance) || 0)) : round2(rate);

  return {
    lines, subtotal, tolls: toll, advance: adv,
    total: round2(subtotal + toll),
    grandTotal: round2(subtotal + toll + adv)
  };
}

/* ------------------------------------------------------------------
   Rentals are a monthly product: a booking must run at least one full
   month unless the customer opts into an open return, where the return
   date is hidden and defaults to the end of the pickup month.
------------------------------------------------------------------- */
const MIN_TERM_DAYS = 30;

function meetsMinimumTerm(startsOn, endsOn, openReturn = false) {
  if (openReturn) return { ok: true };
  const days = inclusiveDays(startsOn, endsOn);
  if (!Number.isFinite(days) || days <= 0) return { ok: false, minimum: 1 };
  return { ok: days >= MIN_TERM_DAYS, minimum: 1 };
}

/* ---------------------- pre-booking notice ------------------------ */

const NOTICE_DAYS = 10;

/* Whole days between today and pick-up. Negative means it is past. */
function daysUntil(dateStr) {
  const today = asDate(new Date());
  today.setHours(12, 0, 0, 0);
  return Math.round((asDate(dateStr) - today) / 86400000);
}

/* How far ahead a car may be booked. A booking is a held car, so the
   window is deliberately short: a customer booking for 4 October may
   do so from 27 September, and not before.

   The pick-up date itself is firm — the car is reserved for that day,
   not for a range around it. */
const MAX_LEAD_DAYS = 7;

/* NOTICE_DAYS is unrelated: it is the threshold for the "short notice"
   badge in the dashboard, so the office can see at a glance which
   requests are last-minute. It imposes no minimum wait. */
function noticeCheck(startsOn) {
  const lead = daysUntil(startsOn);

  if (lead < 0) {
    return { lead, ok: false, short: false,
             message: 'That date has already passed.' };
  }

  if (lead > MAX_LEAD_DAYS) {
    /* Say WHEN they can book rather than only that they cannot: the
       customer wants the date, and the useful answer is the day the
       booking opens. */
    const opens = asDate(startsOn);
    opens.setDate(opens.getDate() - MAX_LEAD_DAYS);
    const when = opens.toLocaleDateString(undefined,
      { day: 'numeric', month: 'long' });
    return {
      lead, ok: false, short: false, opensOn: opens,
      message: `Bookings open one week before pick-up. For that date you `
             + `can book from ${when}.`
    };
  }

  return {
    lead,
    ok: true,
    short: lead < NOTICE_DAYS,
    message: ''
  };
}

/* Does a proposed booking collide with one already on the car? */
function overlaps(a, b) {
  return asDate(a.from) <= asDate(b.to) && asDate(b.from) <= asDate(a.to);
}

/* Browser gets globals; the server gets module.exports. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { quote, monthlyBreakdown, noticeCheck, daysUntil, overlaps,
                     inclusiveDays, round2, meetsMinimumTerm, returnDateFor,
                     NOTICE_DAYS, MAX_LEAD_DAYS, DIVISOR, MIN_TERM_DAYS,
                     BILL_DAY_CAP };
}
