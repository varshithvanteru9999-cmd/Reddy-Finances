/* ------------------------------------------------------------------
   Detail page: reads ?id= from the URL and renders that vehicle.
------------------------------------------------------------------- */

const params = new URLSearchParams(location.search);
const root = document.getElementById('detail');

/* esc is a global shared helper, declared in js/auth.js — do not redeclare
   it here (a const would throw "already been declared" and blank the page). */

initChrome();
/* The bell lives in the brand bar; it shows nothing when signed out. */
initNotifications('customer');

let car = null;
initStore().then(() => {
  car = FLEET.find(c => c.id === params.get('id'));
  start();
});

function start() {

/* Unknown or missing id — say so rather than rendering an empty shell. */
if (!car) {
  document.title = 'Vehicle not found — Reddy Finances';
  root.innerHTML = `
    <div class="shell">
      <a class="back" href="index.html">${ICON.back} Back to all vehicles</a>
      <div class="empty">We could not find that vehicle. It may have been sold or returned to the fleet.</div>
    </div>`;
} else {
    renderCar(car);
    initBooking(car);
    initAllRubbers();
  }
}

function renderCar(car) {
  document.title = `${car.year} ${car.name} ${car.trim} — Reddy Finances`;

  const { value, unit } = priceLabel(car);
  const isRental = car.type === 'rental';

  /* Rentals and sales genuinely care about different numbers, so the
     summary block differs while the full spec table stays the same. */
  const summary = isRental
    ? [['Pickup city', car.location], ['Body style', car.body], ['Seats', car.seats], ['Transmission', car.transmission]]
    : [['Location', car.location], ['Mileage', formatMiles(car.odometer) || car.mileage], ['Exterior', car.color], ['Body style', car.body]];

  /* The buy-card block is rendered inline rather than on index.html so the
     customer can book a rental or request a viewing without leaving the car. */
  const booking = bookingBlock(car);

  const specs = [
    ['Engine', car.engine],
    ['Power', car.power],
    ['Drivetrain', car.drivetrain],
    ['Transmission', car.transmission],
    ['Fuel', car.fuel],
    [car.fuel === 'Electric' ? 'Range' : 'Economy', car.economy],
    ['0 to 60 mph', car.zeroToSixty],
    ['Top speed', car.topSpeed],
    ['Seats', car.seats],
    ['Doors', car.doors],
    ['Exterior', car.color],
    /* Current miles matter to a buyer and are nobody's business on a
       rental, so the odometer is only surfaced on cars for sale. It
       falls back to the older free-text mileage field for vehicles
       whose reading has not been entered yet. */
    [isRental ? 'Pickup' : 'Mileage',
     isRental ? car.location : formatMiles(car.odometer) || car.mileage]
  ];

  root.innerHTML = `
    <div class="shell">
      <a class="back" href="index.html">${ICON.back} Back to all vehicles</a>

      <div class="detail-grid">
        <div class="detail-media" data-media>
          <span class="badge ${car.type}">${typeLabel(car.type)}</span>
          ${placeholderHTML(car.name)}
        </div>

        <div>
          <div class="detail-title">
            <span class="eyebrow">${car.year} &middot; ${categoryOf(car)}</span>
            <h1>${car.name}</h1>
            <p class="sub">${car.trim}</p>
          </div>

          <div class="buy-card">
            <div class="buy-price">
              <b>${value}</b><span>${unit || 'asking price'}</span>
            </div>

            <div class="kv">
              ${summary.map(([k, v]) => `<div><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')}
            </div>

            ${booking}
          </div>
        </div>
      </div>

      <div class="block">
        <h2>Overview</h2>
        <p>${car.description}</p>
      </div>

      <div class="block">
        <h2>Specification</h2>
        <div class="spec-grid">
          ${specs.map(([k, v]) => `<div><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')}
        </div>
      </div>

      <div class="block">
        <h2>Features</h2>
        <ul class="feature-list">
          ${car.features.map(f => `<li>${ICON.check}${f}</li>`).join('')}
        </ul>
      </div>
    </div>`;

  loadPhoto(root.querySelector('[data-media]'), car.image, `${car.year} ${car.name} ${car.trim}`);
}

/* ========================== CUSTOMER BOOKING ====================== */
/* Rentals book end-to-end from this page: pick dates, see a live quote,
   enter contact details and submit — the booking lands in MySQL and
   shows up in the admin dashboard. Sales send a viewing request. */

function isoPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* The earliest span of `nights` days that clears every booking already
   on the car. Walks forward from the first allowed day; if the whole
   next year is somehow full it gives up and returns that day anyway,
   because the server is the real authority. */
function firstFreeWindow(carId, availableFrom, nights) {
  const ranges = bookedRanges(carId);
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  const DAY = 86400000;

  let start = new Date(isoPlus(1) + 'T00:00:00').getTime();
  if (availableFrom) {
    const av = new Date(availableFrom + 'T00:00:00').getTime();
    if (av > start) start = av;
  }

  /* `nights` days inclusive of both ends, so the span is nights - 1. */
  const span = Math.max(0, nights - 1);
  for (let i = 0; i < 366; i++) {
    const from = day(start);
    const to = day(start + span * DAY);
    if (!ranges.some(r => from <= r.to && to >= r.from)) return { from, to };
    start += DAY;
  }
  return { from: day(start), to: day(start + span * DAY) };
}

function fieldHTML({ id, label, icon, type = 'text', value = '', placeholder = '', min, max, required, hint }) {
  return `
    <div class="field field-dark">
      <label for="${id}">${label}${required ? '<em class="req">*</em>' : ''}</label>
      <div class="field-box">${ICON[icon] || ''}
        <input id="${id}" type="${type}" value="${escAttr(value)}"
               placeholder="${escAttr(placeholder)}"${min !== undefined ? ` min="${min}"` : ''}${max !== undefined ? ` max="${max}"` : ''}${required ? ' required' : ''}>
      </div>
      ${hint ? `<small class="field-hint">${hint}</small>` : ''}
    </div>`;
}

/* The window a pick-up date may fall in: today through MAX_LEAD_DAYS
   ahead. Handed to the date input so the calendar greys out everything
   outside it — a customer should not be able to pick a date the form
   will then refuse. */
function pickupWindow() {
  const today = new Date();
  const last = new Date();
  last.setDate(last.getDate() + MAX_LEAD_DAYS);
  const iso = d => d.toISOString().slice(0, 10);
  return { min: iso(today), max: iso(last) };
}

/* A calendar the page draws itself.

   Chrome renders its native date popup in a browser-owned window that
   no page CSS can reach, and it greys every day belonging to an
   adjacent month. So with a window of 27 September to 4 October, the
   1st to the 4th appeared faded — exactly the dates we most want the
   customer to see as available. There is no selector for those cells,
   so the calendar is drawn here instead, where availability decides
   the colour rather than which month a day happens to fall in. */

const CAL_DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const CAL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];

/* The two rules that govern a pick-up date.

   Shown on the form as well as inside the calendar: the calendar only
   appears once the field is tapped, so a customer reading the form
   top to bottom would otherwise never see them. One builder, so the
   two copies cannot drift apart. */
/* Inside the calendar: the dates are in front of them, so this only
   has to name the limit and confirm the pick-up date is firm. */
function dateRulesHTML(cls = 'date-rules') {
  const last = new Date(pickupWindow().max + 'T00:00:00');
  const when = `${CAL_MONTHS[last.getMonth()].slice(0, 3)} ${last.getDate()}`;
  return `
    <ul class="${cls}">
      <li>Book up to <b>${when}</b> &mdash; one week ahead.</li>
      <li>Collect the car on the date you select.</li>
    </ul>`;
}

/* On the form: stated as the policy rather than as today's dates,
   because it is read before any date has been chosen. */
function bookingPolicyHTML() {
  return `
    <p class="date-rules">
      <b>Bookings open one week before pick-up.</b>
      Choose a date within the next 7 days, and collect the car on that
      date.
    </p>`;
}

const isoOf = d => {
  /* Local date, not UTC: toISOString() shifts backwards for anyone
     behind GMT and would offer yesterday as today. */
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

/* Which month the calendar is showing. Starts on the pick-up month. */
let calCursor = null;

function calendarHTML(selectedIso) {
  const { min, max } = pickupWindow();
  const view = calCursor || new Date();

  const year = view.getFullYear();
  const month = view.getMonth();

  /* Monday-first grid. getDay() is Sunday-first, so Sunday maps to 6. */
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - lead);

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const iso = isoOf(d);
    const open = iso >= min && iso <= max;
    const outside = d.getMonth() !== month;
    const on = iso === selectedIso;

    /* `open` decides the colour, NOT `outside`. A day inside the
       booking window is shown as available whichever month it is
       printed under — which is the whole reason this exists. */
    const cls = ['cal-day'];
    if (open) cls.push('open');
    else cls.push('shut');
    if (outside) cls.push('adj');
    if (on) cls.push('on');

    cells.push(
      `<button type="button" class="${cls.join(' ')}" data-date="${iso}"` +
      `${open ? '' : ' disabled'}` +
      ` aria-label="${d.getDate()} ${CAL_MONTHS[d.getMonth()]}"` +
      `${on ? ' aria-current="date"' : ''}>${d.getDate()}</button>`
    );
  }

  /* Only offer months the window actually touches. */
  const prevOk = new Date(year, month, 0) >= new Date(min + 'T00:00:00');
  const nextOk = new Date(year, month + 1, 1) <= new Date(max + 'T00:00:00');

  return `
    <div class="cal" id="bookCal" role="dialog" aria-label="Choose a pick-up date">
      <div class="cal-head">
        <button type="button" class="cal-nav" id="calPrev"
                ${prevOk ? '' : 'disabled'} aria-label="Previous month">&#8249;</button>
        <b>${CAL_MONTHS[month]} ${year}</b>
        <button type="button" class="cal-nav" id="calNext"
                ${nextOk ? '' : 'disabled'} aria-label="Next month">&#8250;</button>
      </div>
      <div class="cal-dow">${CAL_DOW.map(d => `<span>${d}</span>`).join('')}</div>
      <div class="cal-grid">${cells.join('')}</div>
      ${dateRulesHTML('cal-note')}
    </div>`;
}

function bookingBlock(car) {
  if (car.type === 'sale') {
    // Sales = viewing request via enquiries.
    return `
      <form id="bookingForm" class="book-form" novalidate>
        <h3 class="book-title">Request a viewing</h3>
        <div class="book-fields">${fieldHTML({ id: 'bk-name', label: 'Your name', icon: 'user', placeholder: 'Full name' })}
        ${fieldHTML({ id: 'bk-email', label: 'Email', icon: 'mail', type: 'email', placeholder: 'you@example.com' })}
        ${fieldHTML({ id: 'bk-phone', label: 'Phone', icon: 'phone', type: 'tel', placeholder: '(214) 555-0134' })}</div>
        <button class="btn btn-red btn-block" type="submit">Request viewing</button>
        <p class="book-note">No obligation &middot; we confirm by phone or email</p>
        <p class="book-msg" id="bookMsg" hidden></p>
      </form>`;
  }

  /* A car out on rent is shut to new customers until its renter gives
     return notice and the office releases it. Say so plainly instead of
     showing a form that would only fail on submit. */
  const status = carStatus(car.id);
  if (status.inUse && !status.released) {
    const back = status.expectedReturn;
    return `
      <div class="book-closed">
        <span class="book-closed-flag">Currently on rent</span>
        <p class="book-closed-lead">This car is out with a customer.</p>
        <p class="book-closed-note">
          ${back ? `It is due back on <strong>${formatDay(back)}</strong>. ` : ''}
          Pre-booking opens once the current renter confirms their return date.
        </p>
        <a class="btn btn-red btn-block" href="index.html#fleet">See available cars</a>
      </div>`;
  }

  // Rentals = full booking with a live quote.
  /* Default to the first free window, not merely the first available
     day — otherwise the pre-filled dates can land on top of an existing
     booking and the form fails the moment it is submitted. */
  const { from, to } = firstFreeWindow(car.id, status.availableFrom, 30);

  /* Show every date already taken, so the customer picks a free window
     rather than finding out when they submit. */
  const taken = bookedRanges(car.id);
  const takenBlock = taken.length ? `
      <div class="booked-list">
        <span class="booked-list-head">Already booked</span>
        <ul>
          ${taken.map(r => `
            <li class="${r.firm ? '' : 'pending'}">
              <span>${formatRange(r.from, r.to)}</span>
              <em>${r.firm ? 'Booked' : 'Requested'}</em>
            </li>`).join('')}
        </ul>
        <p class="booked-list-note">Any other dates are available.</p>
      </div>` : '';

  /* Released but still out — the customer is joining a queue, not
     collecting straight away. Be explicit about that. */
  const prebookNote = status.inUse && status.released ? `
      <div class="prebook-note">
        <span class="prebook-flag">Pre-booking</span>
        <p>This car is still out, and available from
           <strong>${status.availableFrom ? formatDay(status.availableFrom) : 'its return'}</strong>.
           ${status.queueLength ? `${status.queueLength} customer${status.queueLength === 1 ? ' is' : 's are'} already waiting. ` : ''}
           ${status.prebookingAmount ? `<strong>A pre-booking fee of $${status.prebookingAmount} is required to hold your slot.</strong> ` : ''}
           We confirm your place by email.</p>
      </div>` : '';

  /* A pre-booking is a paid slot: the fee must be settled and evidenced
     before the request is worth taking, so the submit button stays
     disabled until a screenshot is attached. An ordinary booking has
     nothing to pay yet and is unaffected. */
  const isPrebooking = Boolean(status.inUse && status.released);
  const feeText = status.prebookingAmount ? ` — $${status.prebookingAmount}` : '';

  return `
    <form id="bookingForm" class="book-form" novalidate>
      <h3 class="book-title">${status.inUse && status.released ? 'Pre-book this car' : 'Book this car'}</h3>
      ${prebookNote}
      ${takenBlock}
      <div class="book-fields">
        ${fieldHTML({ id: 'bk-from', label: 'Pick-up date', icon: 'cal', type: 'date',
                      value: from, required: true,
                      min: pickupWindow().min, max: pickupWindow().max })}
        <div id="bk-to-wrap">${fieldHTML({ id: 'bk-to', label: 'Return date', icon: 'cal', type: 'date', value: to, required: true })}</div>
        ${bookingPolicyHTML()}
        <label class="book-open" for="bk-open">
          <input type="checkbox" id="bk-open">
          <span>
            <b>Open return</b>
            <small>I don't know my return date yet. The return date will be
                   set to the end of the pickup month and billed for those days.</small>
          </span>
        </label>
        ${fieldHTML({ id: 'bk-name', label: 'Your name', icon: 'user', placeholder: 'Full name', required: true })}
        ${fieldHTML({ id: 'bk-email', label: 'Email', icon: 'mail', type: 'email', placeholder: 'you@example.com' })}
        ${fieldHTML({ id: 'bk-phone', label: 'Phone', icon: 'phone', type: 'tel', placeholder: '(214) 555-0134' })}
        ${fieldHTML({ id: 'bk-license', label: 'License number', icon: 'idCard', placeholder: 'e.g. TX12345678', required: true })}
      </div>
      <div class="book-quote" id="bookQuote">
        <span class="book-quote-row line"></span>
        <span class="book-quote-total"></span>
      </div>
      <p style="color:#dc2626;font-size:0.85rem;margin:0 0 10px;text-align:center;">Toll amount will be added on 1st every month</p>
      ${isPrebooking ? `
      <div class="pay-gate" id="payGate">
        <div class="pay-gate-head">
          <b>Pre-booking fee${feeText}</b>
          <small>Pay the fee, then upload a screenshot of your payment.
                 We hold your place as soon as we receive it.</small>
        </div>
        <label class="pay-drop" id="payDrop">
          <span class="pay-plus" aria-hidden="true">+</span>
          <span class="pay-text">
            <b id="payDropLabel">Upload payment screenshot</b>
            <small>Required &middot; JPG or PNG</small>
          </span>
          <input type="file" id="bk-payment" accept="image/*" hidden>
        </label>
      </div>` : ''}
      <button class="btn btn-red btn-block" type="submit"
              id="bookSubmit"${isPrebooking ? ' disabled' : ''}>Confirm booking</button>
      <p class="book-note">A $${DEPOSIT_MIN} deposit secures your booking &middot; we confirm by email</p>
      <p class="book-msg" id="bookMsg" hidden></p>
    </form>`;
}

/* The pre-booking payment screenshot, held until the booking exists and
   has a reference the upload can be attached to. */
/* The booking deposit. Kept in step with BOOKING_DEPOSIT_MIN on the
   server, which is what actually enforces it — this copy only drives
   the wording and the client-side check. */
const DEPOSIT_MIN = 100;

/* The deposit step, shown when the customer confirms a booking.

   It is a dialog rather than another field on the form because it is a
   decision point, not a detail: the customer pays, uploads proof, and
   only then does the booking exist. Putting it inline let people skip
   past it and submit a booking with nothing behind it. */
let depositFile = null;
let depositScan = null;

/* Opens the deposit dialog and resolves with the accepted file, or
   null if the customer backs out. The caller awaits it, so the booking
   is only created once this has come back with a payment. */
function askForDeposit() {
  return new Promise(resolve => {
    depositFile = null;
    depositScan = null;

    const host = document.createElement('div');
    host.innerHTML = depositModalHTML();
    const backdrop = host.firstElementChild;
    document.body.appendChild(backdrop);
    document.body.style.overflow = 'hidden';

    const input   = backdrop.querySelector('#depInput');
    const label   = backdrop.querySelector('#depLabel');
    const hint    = backdrop.querySelector('#depHint');
    const drop    = backdrop.querySelector('#depDrop');
    const result  = backdrop.querySelector('#depResult');
    const confirm = backdrop.querySelector('#depConfirm');

    const close = value => {
      document.body.style.overflow = '';
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = e => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);

    backdrop.querySelector('#depClose').onclick  = () => close(null);
    backdrop.querySelector('#depCancel').onclick = () => close(null);
    /* Clicking the backdrop itself closes; clicking the card does not. */
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(null); });

    const say = (tone, html) => {
      result.hidden = false;
      result.className = 'dep-result ' + tone;
      result.innerHTML = html;
    };

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;

      if (!/^image\//.test(file.type)) {
        input.value = '';
        return say('bad', 'That file is not an image. Upload a screenshot of your payment.');
      }
      if (file.size > 8e6) {
        input.value = '';
        return say('bad', 'That image is too large. The maximum size is 8MB.');
      }

      label.textContent = file.name.length > 30
        ? file.name.slice(0, 27) + '…' : file.name;
      drop.classList.add('filled');
      hint.textContent = 'Checking the amount…';
      confirm.disabled = true;
      say('busy', 'Reading your screenshot…');

      /* The OCR pass. A failure to read is not a failure to pay, so an
         unreadable image still lets the booking through — the office
         checks it against the bank either way. */
      try {
        const data = await new Promise((res2, rej) => {
          const fr = new FileReader();
          fr.onload = () => res2(String(fr.result).split(',')[1] || '');
          fr.onerror = () => rej(new Error('could not read that file'));
          fr.readAsDataURL(file);
        });

        const r = await fetch('/api/scan-deposit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data, minimum: DEPOSIT_MIN })
        });
        const scan = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(scan.error || 'could not check that image');

        depositScan = scan;
        hint.textContent = 'JPG or PNG · 8MB maximum';

        if (scan.status === 'ok') {
          depositFile = file;
          confirm.disabled = false;
          say('good', `Payment of <strong>$${Number(scan.amount).toFixed(2)}</strong>
               detected. Press Confirm booking to continue.`);
        } else if (scan.status === 'short') {
          depositFile = null;
          confirm.disabled = true;
          say('bad', `This screenshot shows <strong>$${Number(scan.amount).toFixed(2)}</strong>,
               which is $${Number(scan.shortfall).toFixed(2)} below the
               $${DEPOSIT_MIN} minimum. Upload proof of the full deposit.`);
        } else {
          /* Unreadable: allow it, but say plainly what will happen. */
          depositFile = file;
          confirm.disabled = false;
          say('warn', `We could not read the amount on that image. You can still
               continue &mdash; our team will verify the payment against our
               records before confirming your booking.`);
        }
      } catch (err) {
        depositFile = null;
        confirm.disabled = true;
        hint.textContent = 'JPG or PNG · 8MB maximum';
        say('bad', 'We could not check that image. Please try again.');
      }
    });

    /* A disabled button with no explanation reads as a broken page.
       Clicking it says what it is waiting for and draws the eye to the
       upload, rather than doing nothing at all. */
    const blocked = backdrop.querySelector('#depBlocked');
    blocked.addEventListener('click', () => {
      if (!confirm.disabled) return;
      if (!depositScan) {
        say('bad', 'Upload a screenshot of your payment first.');
      } else if (depositScan.status === 'short') {
        say('bad', `That payment is below the $${DEPOSIT_MIN} minimum.
             Upload proof of the full deposit to continue.`);
      }
      drop.classList.add('nudge');
      setTimeout(() => drop.classList.remove('nudge'), 350);
      drop.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    confirm.onclick = () => { if (depositFile) close(depositFile); };
  });
}

function depositModalHTML() {
  return `
    <div class="dep-backdrop" id="depBackdrop" role="dialog" aria-modal="true"
         aria-labelledby="depTitle">
      <div class="dep-modal">
        <button type="button" class="dep-close" id="depClose"
                aria-label="Close">&times;</button>

        <h3 class="dep-title" id="depTitle">Secure your booking</h3>
        <p class="dep-lead">
          Pay a deposit of at least <strong>$${DEPOSIT_MIN}</strong> to reserve
          this car, then upload a screenshot of the payment below.
          The amount is deducted from your rental total.
        </p>

        <label class="dep-drop" id="depDrop">
          <span class="dep-plus" aria-hidden="true">+</span>
          <span class="dep-text">
            <b id="depLabel">Upload payment screenshot</b>
            <small id="depHint">JPG or PNG &middot; 8MB maximum</small>
          </span>
          <input type="file" id="depInput" accept="image/*" hidden>
        </label>

        <div class="dep-result" id="depResult" hidden></div>

        <div class="dep-actions">
          <button type="button" class="btn btn-line" id="depCancel">Cancel</button>
          <span class="dep-confirm-wrap" id="depBlocked">
            <button type="button" class="btn btn-red" id="depConfirm" disabled>
              Confirm booking
            </button>
          </span>
        </div>
      </div>
    </div>`;
}

let pendingPaymentFile = null;

function initBooking(car) {
  const form = document.getElementById('bookingForm');
  if (!form) return;
  const msg = document.getElementById('bookMsg');
  const isRental = car.type === 'rental';

  /* If this customer is already signed in (e.g. just returned from the
     Google redirect), pre-fill their details so all they have to do is
     confirm. */
  const prefillIfSignedIn = () => {
    if (!window.Auth || !Auth.user) return;
    const name = document.getElementById('bk-name');
    const email = document.getElementById('bk-email');
    if (name && !name.value && Auth.user.name) name.value = Auth.user.name;
    if (email && !email.value && Auth.user.email) email.value = Auth.user.email;
  };
  prefillIfSignedIn();
  window.addEventListener('auth:change', prefillIfSignedIn);

  initPhoneInput(document.getElementById('bk-phone'));

  /* The native picker indicator is hidden on these fields, so the
     calendar glyph beside each date field must open the picker itself. */
  ['bk-from', 'bk-to'].forEach(id => {
    const input = document.getElementById(id);
    const box = input?.closest('.field-box');
    if (!box) return;
    box.addEventListener('click', e => {
      if (e.target === input) return;
      if (input.showPicker) { try { input.showPicker(); } catch { input.focus(); } }
      else input.focus();
    });
  });

  // Quote the rental live as the dates change (or when contact fields empty out).
  if (isRental) {
    const refresh = debounce(renderQuote, 250);

    /* Helper: last day of the month containing `isoDate`. */
    function monthEnd(isoDate) {
      const [y, m] = isoDate.split('-').map(Number);
      const last = new Date(y, m, 0);  // day 0 = last day of previous month = last of m
      return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
    }

    /* When open return is ticked: hide the return-date field and set it
       to the last day of the pickup month. Un-ticking shows the field
       and resets the return date to pickup + 30 days. */
    function syncReturnDate() {
      const fromEl = document.getElementById('bk-from');
      const toEl   = document.getElementById('bk-to');
      const wrap   = document.getElementById('bk-to-wrap');
      const open   = document.getElementById('bk-open');
      if (!fromEl || !toEl || !wrap || !open) return;
      if (open.checked) {
        wrap.hidden = true;
        if (fromEl.value) toEl.value = monthEnd(fromEl.value);
      } else {
        wrap.hidden = false;
        if (fromEl.value) {
          /* Billing prices a month as 30 days counted inclusively, so
             the return date is pick-up + 29. Adding a flat 30 made every
             booking 31 days and charged a day of rent on top of the
             monthly rate — $498 became $514.60.

             Stepping by calendar month instead looks tidier but bills
             worse: a 28-day February or a 31-day March is not 30 days,
             and the engine charges per-day for anything that is not a
             whole calendar month. */
          const d = new Date(fromEl.value + 'T12:00:00');
          d.setDate(d.getDate() + 29);
          toEl.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }
      }
    }

    document.getElementById('bk-from')?.addEventListener('change', () => {
      if (document.getElementById('bk-open')?.checked) syncReturnDate();
      refresh();
    });
    ['bk-from', 'bk-to'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', refresh);
    });

    /* Ticking open return toggles the return-date visibility and
       refreshes the quote. */
    const openBox = document.getElementById('bk-open');
    if (openBox) openBox.addEventListener('change', () => { syncReturnDate(); renderQuote(); });
    syncReturnDate();
    renderQuote();
  }

  /* Pre-booking is a paid slot, so Confirm stays disabled until the
     customer attaches proof of the fee. The file is held in memory and
     uploaded once the booking exists and has a reference to attach to. */
  const payInput = document.getElementById('bk-payment');
  if (payInput) {
    payInput.addEventListener('change', () => {
      const file = payInput.files && payInput.files[0];
      const submit = document.getElementById('bookSubmit');
      const label = document.getElementById('payDropLabel');
      const drop = document.getElementById('payDrop');
      if (!file) {
        pendingPaymentFile = null;
        if (submit) submit.disabled = true;
        if (label) label.textContent = 'Add payment screenshot';
        if (drop) drop.classList.remove('filled');
        return;
      }
      if (!/^image\//.test(file.type)) {
        payInput.value = '';
        return fail('That needs to be an image of your payment.');
      }
      if (file.size > 8e6) {
        payInput.value = '';
        return fail('That image is too large — 8MB maximum.');
      }
      pendingPaymentFile = file;
      if (submit) submit.disabled = false;
      if (label) label.textContent = file.name.length > 28
        ? file.name.slice(0, 25) + '…' : file.name;
      if (drop) drop.classList.add('filled');
    });
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = document.getElementById('bk-name').value.trim();
    const email = document.getElementById('bk-email').value.trim();
    const phone = document.getElementById('bk-phone').value.trim();
    const license = (document.getElementById('bk-license')?.value || '').trim();
    const from = document.getElementById('bk-from').value;
    const to = document.getElementById('bk-to').value;
    const openReturn = Boolean(document.getElementById('bk-open')?.checked);

    /* Booking stage gate — finish the booking only when signed in. */
    const user = await ensureSignedIn();
    if (!user) { /* user closed the login popup, stop here */ return; }

    /* Pre-fill what Google gave us, so the request goes out under the
       signed-in identity. */
    if (!name && user.name) document.getElementById('bk-name').value = user.name;
    if (!email && user.email) document.getElementById('bk-email').value = user.email;

    /* Everything missing, gathered in one pass.

       These checks used to return on the first failure, so a customer
       with three blanks fixed one, pressed the button, and met the
       next — three round trips to learn what the form wanted. Now
       every empty required field is named and marked together. */
    const missing = [];
    if (!name && !user.name) missing.push(['bk-name', 'your name']);
    if ((!email && !user.email) && !phone) {
      missing.push(['bk-email', 'an email address or phone number']);
    }
    if (isRental) {
      if (!license) missing.push(['bk-license', 'your driver license number']);
      if (!from) missing.push(['bk-from', 'a pick-up date']);
      if (!openReturn && !to) missing.push(['bk-to', 'a return date']);
    }

    if (missing.length) {
      const what = missing.map(m => m[1]);
      const phrase = what.length === 1
        ? what[0]
        : what.slice(0, -1).join(', ') + ' and ' + what[what.length - 1];
      return fail(`Please add ${phrase} before booking.`, missing.map(m => m[0]));
    }

    /* Wrongly-filled, as opposed to empty. These stay one at a time:
       each needs its own explanation, and only one can be the reason a
       value is rejected. */
    if (phone && !validUSPhone(phone)) {
      return fail('Enter a valid 10-digit US phone number, e.g. (214) 555-0134.', 'bk-phone');
    }
    if (isRental) {
      if (!openReturn && new Date(to) < new Date(from)) {
        return fail('The return date cannot be before the pick-up date.', ['bk-to', 'bk-from']);
      }
      /* No waiting period — any future date may be requested, and the
         admin approves it. Only a past date, or a clash with dates the
         car is already committed to, is rejected here. */
      const check = noticeCheck(from);
      if (!check.ok) return fail(check.message, 'bk-from');

      const clash = bookedRanges(car.id).find(r => from <= r.to && to >= r.from);
      if (clash) {
        return fail(`This car is already taken ${formatRange(clash.from, clash.to)}. Please choose other dates.`,
                    ['bk-from', 'bk-to']);
      }

      /* Minimum one-month rental. Open-return bookings are priced to the
         end of the pickup month, so the term check is not needed. */
      if (!openReturn) {
        const term = meetsMinimumTerm(from, to, false);
        if (!term.ok) {
          return fail('Rentals run for a minimum of 1 month. Choose a return date at least 30 days from pick-up.',
                      'bk-to');
        }
      }
    } else {
      if ((email || user.email) && !/^\S+@\S+\.\S+$/.test(email || user.email)) {
        return fail('That email address does not look right.', 'bk-email');
      }
    }

    const finalName = (name || user.name).trim();
    /* A signed-in account's email wins over whatever is typed in the
       box. My Bookings finds a booking by the SESSION's email, so a
       customer who signed in as one address and typed another filed a
       booking they could never see: the redirect worked, the page came
       up empty, and the booking looked lost. The typed value is only
       used when nobody is signed in. */
    const finalEmail = (user.email || email).trim();

    /* The deposit gate. A pre-booking already collected its fee on the
       form above, so it is not asked twice; every other rental stops
       here until a payment screenshot has been read and accepted.

       Nothing is created if they back out — the booking begins life
       only after the deposit clears. */
    /* isPrebooking belongs to the markup builder, not to this handler,
       so the same condition is derived here from live status rather
       than reaching across scopes for a variable that is not in it. */
    const st = carStatus(car.id);
    const prebookingFlow = Boolean(st.inUse && st.released);

    if (isRental && !prebookingFlow) {
      const paid = await askForDeposit();
      if (!paid) return;            /* cancelled — no booking made */
      pendingPaymentFile = paid;
    }

    setBusy(true, 'Submitting…');
    try {
      if (isRental) {
        const ref = await createBooking({ name: finalName, email: finalEmail, phone, license, carId: car.id, from, to, openReturn, status: 'Prebooked' });

        /* The pre-booking fee screenshot, now that there is a reference
           to attach it to. A failure here must not lose the booking —
           it exists either way — so it is reported, not thrown. */
        if (pendingPaymentFile) {
          try {
            const data = await new Promise((resolve, reject) => {
              const fr = new FileReader();
              fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
              fr.onerror = () => reject(new Error('could not read the image'));
              fr.readAsDataURL(pendingPaymentFile);
            });
            await uploadPaymentProof(ref, {
              name: pendingPaymentFile.name,
              type: pendingPaymentFile.type,
              size: pendingPaymentFile.size,
              data
            }, { stage: 'prebooking', expected: carStatus(car.id).prebookingAmount || null });
            pendingPaymentFile = null;
          } catch {
            ok(`Booking ${ref} created, but the payment screenshot did not ` +
               `upload. You can add it from My Bookings.`);
            form.hidden = true;
            setTimeout(() => {
              location.href = `bookings.html?ref=${encodeURIComponent(ref)}`;
            }, 2600);
            return;
          }
        }

        ok(`Booking confirmed — reference ${ref}. Taking you to My Bookings…`);
        form.hidden = true;
        /* Land them on their bookings list, where the request they just
           made is waiting. The reference goes with them so the page can
           scroll to that booking and mark it — on a list of several,
           "it's in there somewhere" is not an answer. */
        setTimeout(() => {
          location.href = `bookings.html?ref=${encodeURIComponent(ref)}`;
        }, 1800);
      } else {
        await createEnquiry({
          kind: 'viewing', name: finalName, email: finalEmail, phone, carMake: `${car.year} ${car.name}`, message: `Viewing request for ${car.year} ${car.name}`
        });
        ok(`Thanks${finalName ? ', ' + finalName : ''} — we will be in touch shortly about viewing the ${car.name}.`);
        form.hidden = true;
      }
    } catch (err) {
      fail(err.message || 'Could not complete your request.');
    } finally {
      setBusy(false);
    }
  });

  function setBusy(busy, text) {
    const btn = form.querySelector('button[type="submit"]');
    if (text) btn.textContent = text;
    btn.disabled = busy;
  }
  function ok(text) {
    clearMarks();
    msg.textContent = text; msg.hidden = false; msg.classList.remove('err');
  }

  /* Every field previously marked wrong, cleared. Called before each
     new attempt so an error the customer has since fixed does not stay
     highlighted. */
  function clearMarks() {
    form.querySelectorAll('.field-bad').forEach(el => {
      el.classList.remove('field-bad');
      el.removeAttribute('aria-invalid');
    });
  }

  /* Report a problem. `ids` names the fields at fault, so the customer
     is shown WHERE to look rather than only what is wrong — the message
     alone sat at the foot of the form and left them hunting.

     The first bad field is focused and scrolled to; the rest stay
     marked so several omissions are visible at once instead of being
     discovered one submit at a time. */
  function fail(text, ids) {
    clearMarks();
    msg.textContent = text;
    msg.hidden = false;
    msg.classList.add('err');

    const list = Array.isArray(ids) ? ids : (ids ? [ids] : []);
    let first = null;
    for (const id of list) {
      const el = document.getElementById(id);
      if (!el) continue;
      const wrap = el.closest('.book-field') || el.parentElement;
      (wrap || el).classList.add('field-bad');
      el.setAttribute('aria-invalid', 'true');
      if (!first) first = el;
    }

    if (first) {
      try {
        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        first.focus({ preventScroll: true });
      } catch { first.focus(); }
    }
    return undefined;
  }

  /* Clearing a field's mark as soon as it is edited: leaving it red
     while they type reads as though the correction was not accepted. */
  /* The page's own calendar, opened from the pick-up field.

     The native picker is suppressed: showPicker() is never called and
     the field is read-only, so tapping it opens this instead. The
     input keeps its type, value, min and max, so validation, the quote
     and form submission all behave exactly as before. */
  const fromField = document.getElementById('bk-from');

  /* The popup is mounted INSIDE the pick-up field's own wrapper.

     It first sat as a sibling in .book-fields, which is a two-column
     grid — so the empty host took a grid cell of its own and pushed
     the Return date across, and the popup anchored to that cell
     rather than to the field it belongs to. Mounted here it hangs off
     the field itself and the grid is untouched. */
  const fromWrap = fromField && fromField.closest('.field');
  let calHost = null;
  if (fromWrap) {
    calHost = document.createElement('div');
    calHost.className = 'cal-host';
    calHost.id = 'calHost';
    calHost.hidden = true;
    fromWrap.classList.add('has-cal');   /* :has() fallback */
    fromWrap.appendChild(calHost);
  }

  if (fromField && calHost) {
    fromField.readOnly = true;

    const paintCal = () => {
      calHost.innerHTML = calendarHTML(fromField.value);
      calHost.querySelector('#calPrev').onclick = () => {
        const v = calCursor || new Date();
        calCursor = new Date(v.getFullYear(), v.getMonth() - 1, 1);
        paintCal();
      };
      calHost.querySelector('#calNext').onclick = () => {
        const v = calCursor || new Date();
        calCursor = new Date(v.getFullYear(), v.getMonth() + 1, 1);
        paintCal();
      };
      calHost.querySelectorAll('.cal-day.open').forEach(btn => {
        btn.onclick = () => {
          fromField.value = btn.dataset.date;
          closeCal();
          /* The same events typing would raise, so the quote and the
             error-clearing react identically however the date was set. */
          fromField.dispatchEvent(new Event('input', { bubbles: true }));
          fromField.dispatchEvent(new Event('change', { bubbles: true }));
        };
      });
    };

    const openCal = () => {
      calCursor = fromField.value
        ? new Date(fromField.value + 'T00:00:00')
        : new Date();
      paintCal();
      calHost.hidden = false;
      document.addEventListener('click', onOutside, true);
      document.addEventListener('keydown', onEsc);
    };
    const closeCal = () => {
      calHost.hidden = true;
      document.removeEventListener('click', onOutside, true);
      document.removeEventListener('keydown', onEsc);
    };
    const onOutside = e => {
      if (!calHost.contains(e.target) && e.target !== fromField) closeCal();
    };
    const onEsc = e => { if (e.key === 'Escape') closeCal(); };

    fromField.addEventListener('focus', openCal);
    fromField.addEventListener('click', e => {
      e.preventDefault();
      calHost.hidden ? openCal() : closeCal();
    });
    /* Belt and braces: some builds still open the native popup on
       certain interactions even with readOnly set. */
    fromField.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCal(); }
    });
  }

  form.addEventListener('input', e => {
    const wrap = e.target.closest && e.target.closest('.field-bad');
    if (wrap) {
      wrap.classList.remove('field-bad');
      e.target.removeAttribute('aria-invalid');
    }
  });
}

async function renderQuote() {
  const el = document.getElementById('bookQuote');
  if (!el) return;
  const from = document.getElementById('bk-from').value;
  const to = document.getElementById('bk-to').value;
  if (!from || !to) { el.innerHTML = ''; return; }
  const openReturn = Boolean(document.getElementById('bk-open')?.checked);
  try {
    const q = await quoteBooking({ carId: car.id, from, to, openReturn });

    /* Only the first month is collected at pickup. Listing every later
       month here and totalling them made the panel read as the price of
       the whole term, when what the customer actually hands over on the
       day is this month's rent plus the advance. Later months are billed
       when they come round, so they are not quoted as due now. */
    const firstLine = q.lines[0];
    const rows = firstLine
      ? `<span class="book-quote-row">
           <span>${esc(firstLine.label)}</span>
           <b>${esc(money(firstLine.amount))}</b>
         </span>`
      : '';

    const advanceRow = q.advance
      ? `<span class="book-quote-row">
           <span>Advance <small>(refundable deposit)</small></span>
           <b>${esc(money(q.advance))}</b>
         </span>`
      : '';

    /* What is handed over on the day: the first month's rent and the
       advance, nothing further ahead. */
    const firstAmount = Number(firstLine ? firstLine.amount : q.total);
    const dueAtPickup = Math.round((firstAmount + Number(q.advance || 0)) * 100) / 100;
    const totalLabel = 'Due at the time of Pickup';
    const grand = dueAtPickup;

    /* Say why the dates will be refused before they press Confirm.
       Without this the quote just shows a large total for a short stay
       and the refusal only arrives on submit, which reads as a fault. */
    const warn = (q.term && !q.term.ok)
      ? `<span class="book-quote-warn">Rentals run for a minimum of one
           month. Choose a later return date, or tick <b>open return</b>
           above to book a shorter stay.</span>`
      : '';

    el.innerHTML = rows + advanceRow +
      `<span class="book-quote-total"><span>${totalLabel}</span><b>${esc(money(grand))}</b></span>` +
      warn;
  } catch (err) {
    el.innerHTML = `<span class="book-quote-total err">${esc(err.message)}</span>`;
  }
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function escAttr(v) { return esc(v).replace(/"/g, '&quot;'); }
function money(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

/* Odometer readings are stored as a number; buyers read them with
   separators and a unit. Returns '' when there is no reading, so the
   caller can fall back to the older free-text mileage field. */
function formatMiles(n) {
  if (n === null || n === undefined || n === '') return '';
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  return v.toLocaleString('en-US') + ' mi';
}
