/* ------------------------------------------------------------------
   Data layer. Talks to the MySQL-backed API in server/.

   The pages were written against a synchronous `FLEET` array, so this
   loads once before boot and hands over a plain array. If the API is
   unreachable the seed in js/data.js is used instead, so the site still
   renders — it just cannot save.
------------------------------------------------------------------- */

const API = '/api';

let FLEET = [];
let API_OK = false;

async function request(path, options) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try { message = (await res.json()).error || message; } catch {}
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

/* ------------------------------ fleet ---------------------------- */

async function loadFleet() {
  try {
    const rows = await request('/vehicles');
    API_OK = true;
    return rows;
  } catch (err) {
    API_OK = false;
    console.warn('API unavailable, falling back to the bundled seed:', err.message);
    return CARS.map(c => ({ ...c }));
  }
}

const createVehicle = car => request('/vehicles', { method: 'POST', body: JSON.stringify(car) });
const updateVehicle = (id, car) => request(`/vehicles/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(car) });
const deleteVehicleApi = id => request(`/vehicles/${encodeURIComponent(id)}`, { method: 'DELETE' });

/* ---------------------------- bookings --------------------------- */

async function loadBookings() {
  try { return await request('/bookings'); }
  catch (err) { console.warn('Bookings unavailable:', err.message); return []; }
}

/* The signed-in customer's own bookings, for My Profile. Scoped by the
   server to their email, so it needs no admin rights. */
async function loadMyBookings() {
  return request('/bookings/mine');
}

/* Send a toll statement for matching. Without `apply` the server only
   reports what it would do, so the admin can check before committing. */
const importTolls = (file, opts = {}) =>
  request('/bookings/import-tolls', {
    method: 'POST',
    body: JSON.stringify({ file, apply: opts.apply === true, on: opts.on })
  });

/* Proof of payment: the customer uploads, the office reads. */
const uploadPaymentProof = (ref, file, extra = {}) =>
  request(`/bookings/${encodeURIComponent(ref)}/payment-proof`, {
    method: 'POST',
    body: JSON.stringify({
      file, amount: extra.amount, note: extra.note,
      /* 'prebooking' for the fee taken to hold a slot; `expected` lets
         the scan judge whether the amount covers what is owed. */
      stage: extra.stage, expected: extra.expected
    })
  });

/* Cash taken at the counter, with the amount. Joins the same ledger as
   an uploaded transfer so both channels add up. */
const addCashPayment = (ref, { amount, note = '', pending = null } = {}) =>
  request(`/bookings/${encodeURIComponent(ref)}/cash-payment`,
          { method: 'POST', body: JSON.stringify({ amount, note, pending }) });

/* What a booking owes and has taken, across both channels. */
const bookingSettlement = ref =>
  request(`/bookings/${encodeURIComponent(ref)}/settlement`);

/* Record how a payment arrived — the office ticking "paid by cash". */
const setPaymentMethod = (ref, method) =>
  request(`/bookings/${encodeURIComponent(ref)}/payment-method`,
          { method: 'POST', body: JSON.stringify({ method }) });

/* An admin agreeing with a scanned amount. Until this runs the figure
   is only a suggestion and no balance has moved. */
const verifyPaymentProof = (ref, proofId, opts = {}) =>
  request(`/bookings/${encodeURIComponent(ref)}/payment-proof/verify`,
          { method: 'POST', body: JSON.stringify({
              proofId, amount: opts.amount, applyShortfall: opts.applyShortfall !== false }) });

const loadPaymentProofs = ref =>
  request(`/bookings/${encodeURIComponent(ref)}/payment-proof`);

async function loadPaymentProofCounts() {
  try { return await request('/bookings/payment-proof-counts'); }
  catch { return {}; }
}

const createBooking = b => request('/bookings', { method: 'POST', body: JSON.stringify(b) });
const updateBooking = (ref, b) => request(`/bookings/${encodeURIComponent(ref)}`, { method: 'PUT', body: JSON.stringify(b) });
const deleteBookingApi = ref => request(`/bookings/${encodeURIComponent(ref)}`, { method: 'DELETE' });

/* ---------------------------- enquiries -------------------------- */

const createEnquiry = e => request('/enquiries', { method: 'POST', body: JSON.stringify(e) });

/* ------------------------- pre-booking --------------------------- */

const loadUpcoming = () => request('/bookings/upcoming');
const releaseBooking = ref => request(`/bookings/${encodeURIComponent(ref)}/release`, { method: 'POST' });

/* The handover: the customer has collected the car. Confirmed -> Active. */
const handoverBooking = ref =>
  request(`/bookings/${encodeURIComponent(ref)}/handover`, { method: 'POST' });
const sendConfirmation = ref => request(`/bookings/${encodeURIComponent(ref)}/confirm`, { method: 'POST' });

/* Re-send the slot confirmation email — the full one with dates,
   total and pick-up point — for a booking already approved. */
const sendSlotConfirmation = (ref, pickupLocation) =>
  request(`/bookings/${encodeURIComponent(ref)}/slot-confirmation`,
          { method: 'POST',
            body: JSON.stringify({ pickupLocation: pickupLocation || null }) });

/* Email the invoice — rental total, toll fees, and the sum of both. */
/* `edits` carries any figure the office corrected in the dialog; the
   server writes them to the booking before building the invoice. */
const sendInvoice = (ref, edits = {}) =>
  request(`/bookings/${encodeURIComponent(ref)}/invoice`,
          { method: 'POST', body: JSON.stringify(edits) });

/* The toll statement, billed on its own each month. */
const sendTollInvoice = (ref, period = null, edits = {}) =>
  request(`/bookings/${encodeURIComponent(ref)}/toll-invoice`,
          { method: 'POST', body: JSON.stringify({ period, ...edits }) });

/* Approve or reject a booking request. The server records the outcome
   and emails the customer; `reason` is included in a rejection, and
   `pickupLocation` — where the car is collected from — goes out with
   an approval's confirmation email. */
const decideBooking = (ref, decision, reason, pickupLocation) =>
  request(`/bookings/${encodeURIComponent(ref)}/${decision === 'approve' ? 'approve' : 'reject'}`,
          { method: 'POST', body: JSON.stringify({
              reason: reason || '',
              pickupLocation: pickupLocation || null
            }) });
const quoteBooking = payload => request('/bookings/quote', { method: 'POST', body: JSON.stringify(payload) });
const setOdometer = (id, miles) =>
  request(`/vehicles/${encodeURIComponent(id)}/odometer`, { method: 'POST', body: JSON.stringify({ miles }) });

/* ---------------- return notice & vehicle release ----------------- */

const giveReturnNotice = (ref, expectedReturnOn) =>
  request(`/bookings/${encodeURIComponent(ref)}/return-notice`,
          { method: 'POST', body: JSON.stringify({ expectedReturnOn }) });

const loadAwaitingRelease = () => request('/vehicles/awaiting-release');

/* Every car currently booked, for the Release tab. */
const loadBookedVehicles = () => request('/vehicles/booked');
const loadPrebookingQueue = () => request('/bookings/prebooking-queue');

const releaseVehicle = (slug, availableFrom, prebookingAmount) =>
  request(`/vehicles/${encodeURIComponent(slug)}/release`,
          { method: 'POST', body: JSON.stringify({ availableFrom, prebookingAmount }) });

/* Free a car for ordinary booking: cancels the booking holding it and
   clears any pre-booking state. */
const releaseForNormalBooking = (slug, reference = null) =>
  request(`/vehicles/${encodeURIComponent(slug)}/release-normal`,
          { method: 'POST', body: JSON.stringify({ reference }) });

const unreleaseVehicle = slug =>
  request(`/vehicles/${encodeURIComponent(slug)}/unrelease`, { method: 'POST' });

const markPrebookingPaid = ref =>
  request(`/bookings/${encodeURIComponent(ref)}/prebooking-paid`, { method: 'POST' });

/* -------------------------- notifications ------------------------- */

const loadNotifications = (audience) =>
  request('/notifications' + (audience === 'admin' ? '?audience=admin' : ''))
    .catch(() => []);

const markNotificationsRead = (audience, ids) =>
  request('/notifications/read' + (audience === 'admin' ? '?audience=admin' : ''),
          { method: 'POST', body: JSON.stringify({ ids: ids || null }) })
    .catch(() => null);

/* "3 minutes ago" / "2 days ago" — a compact relative time. The API
   sends MySQL TIMESTAMPs as UTC with no zone marker ("2026-09-15 03:00:00");
   reading them as browser-local time would show a brand-new event as
   several hours old, so they are parsed as UTC. Strings that already
   carry a timezone are left alone. */
function timeAgo(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const t = /Z$|[+-]\d\d?(:?\d\d)?$/.test(s)
    ? new Date(s)
    : new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(t)) return '';
  const secs = Math.max(0, (Date.now() - t.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return t.toISOString().slice(0, 10);
}

/* ----------------------------- helpers --------------------------- */

const STATUSES = ['Prebooked', 'Confirmed', 'Active', 'Completed', 'Cancelled'];

function slugify(text, taken) {
  const base = String(text).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'vehicle';
  if (!taken) return base;
  let id = base, n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return id;
}

/* Whole days, minimum one — a same-day rental still costs a day. */
function nightsBetween(from, to) {
  const a = new Date(from + 'T00:00:00');
  const b = new Date(to + 'T00:00:00');
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.max(1, Math.round((b - a) / 86400000));
}

/* --------------------------- availability ------------------------- */

/* slug -> [{from, to, firm}] for every car with dates already taken. */
let AVAILABILITY = {};

async function loadAvailability() {
  try { return await request('/vehicles/availability'); }
  catch { return {}; }   /* the listing still renders without it */
}

/* Everything known about one car's availability. */
function carStatus(carId) {
  return AVAILABILITY[carId] || { ranges: [] };
}

/* The ranges a given car is unavailable for. */
function bookedRanges(carId) {
  return carStatus(carId).ranges || [];
}

/* Can a customer request this car at all? A car out on rent stays shut
   until its renter gives return notice and the office releases it. */
function canBook(carId) {
  const s = carStatus(carId);
  return s.bookable !== false;
}

/* Is the car spoken for at any point from today to `withinDays` out?
   Used for the "Booked" flag on a listing card. */
function isBooked(carId, withinDays = 31) {
  const s = carStatus(carId);
  const ranges = s.ranges || [];

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const limit = new Date(today); limit.setDate(limit.getDate() + withinDays);

  for (const r of ranges) {
    const from = new Date(r.from + 'T00:00:00');
    const to = new Date(r.to + 'T00:00:00');
    if (to >= today && from <= limit) {
      return {
        ...r,
        current: from <= today && to >= today,
        released: Boolean(s.released),
        noticeGiven: Boolean(s.noticeGiven),
        availableFrom: s.availableFrom || null,
        queueLength: s.queueLength || 0,
        /* Someone has paid the reservation fee, so the slot is taken
           even though the car is technically still "released". */
        claimed: Boolean(s.prebookingClaimed)
      };
    }
  }
  return null;
}

/* "18 Sep" / "4 Oct 2026" — one date, not a range. */
function formatDay(iso) {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return String(iso || '');
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const yr = d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${M[d.getMonth()]}${yr}`;
}

/* "3 – 9 Sep" / "28 Sep – 4 Oct 2026" — a compact human range. */
function formatRange(from, to) {
  const a = new Date(from + 'T00:00:00');
  const b = new Date(to + 'T00:00:00');
  if (isNaN(a) || isNaN(b)) return `${from} – ${to}`;
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const thisYear = new Date().getFullYear();
  const yr = b.getFullYear() === thisYear ? '' : ` ${b.getFullYear()}`;
  return a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()
    ? `${a.getDate()}–${b.getDate()} ${M[b.getMonth()]}${yr}`
    : `${a.getDate()} ${M[a.getMonth()]} – ${b.getDate()} ${M[b.getMonth()]}${yr}`;
}

/* Pages call this before their own init, so FLEET is populated by the
   time anything reads it. */
async function initStore() {
  const [fleet, avail] = await Promise.all([loadFleet(), loadAvailability()]);
  FLEET = fleet;
  AVAILABILITY = avail || {};
  return FLEET;
}
