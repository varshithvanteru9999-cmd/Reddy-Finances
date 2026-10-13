/* ------------------------------------------------------------------
   Home page: hero, marquee, fleet grid, stats, reserve panel.
------------------------------------------------------------------- */

const grid       = document.getElementById('grid');
const filterWrap = document.querySelector('.filters');
const viewAllBtn = document.getElementById('viewAll');
const countEl    = document.getElementById('resultCount');

const PAGE_SIZE = 6;

/* alternate rental/sale on initial load so both types appear */
function getMixedList(all) {
  if (activeType !== 'all' || expanded) return all;
  const rental = all.filter(c => c.type === 'rental');
  const sale = all.filter(c => c.type === 'sale');
  const mixed = [];
  const maxPairs = Math.ceil(PAGE_SIZE / 2);
  for (let i = 0; i < maxPairs; i++) {
    if (rental[i]) mixed.push(rental[i]);
    if (sale[i]) mixed.push(sale[i]);
  }
  return mixed.slice(0, PAGE_SIZE);
}

let activeType     = 'all';   /* all | rental | sale */
let activeCategory = null;
let activeCity     = 'any';
let expanded       = false;

/* ============================= CONTENT ============================ */

const BRANDS = ['Tesla', 'Porsche', 'BMW', 'Mercedes-Benz', 'Audi', 'Ford',
                'Toyota', 'Jeep', 'Chevrolet', 'Honda', 'Rivian'];

const STATS = [
  ['01', 'Choose your car', 'Browse our fleet of premium vehicles. Filter by type, price, or style to find the perfect match.'],
  ['02', 'Pick your dates', 'Select rental duration — daily, weekly, or monthly. Or choose to buy outright with flexible financing.'],
  ['03', 'Drive away', 'Collect your car or get it delivered. Insurance and roadside cover included from the first mile.'],
  ['04', 'Own it later', 'Loved your rental? Convert it to a purchase. We\'ll handle the paperwork and offset what you\'ve already paid.']
];

const QUOTES = [
  ['Smooth booking and a great car!',
   'The rental process was quick and simple. The car was clean, comfortable, and exactly as shown online. I will definitely book again.',
   'Vinothini Ganes', 'Dallas, TX'],
  ['Found the perfect car within my budget.',
   'I was able to compare cars easily and found a reliable vehicle at a fair price. The team made the entire buying process stress-free.',
   'Sophia Miller', 'Plano, TX'],
  ['Selling my car was easier than expected.',
   'I submitted my car details and received a fair valuation quickly. The process was transparent, secure, and very convenient.',
   'Daniel Roberts', 'Fort Worth, TX'],
  ['Perfect option for my monthly travel needs.',
   'The flexible rental plan saved me time and money. Customer support was helpful, and the vehicle was maintained perfectly.',
   'Emily Wilson', 'Irving, TX']
];

const CONTACTS = [];

/* ======================= STATIC PAGE CONTENT ====================== */

function renderStaticContent() {
  /* the marquee runs twice so the -50% loop is seamless */
  document.getElementById('marquee').innerHTML =
    [...BRANDS, ...BRANDS].map(b => `<span>${b}</span>`).join('');

  document.getElementById('statGrid').innerHTML = STATS.map(([num, title, copy]) => `
    <article class="stat">
      <span class="stat-num">${num}</span>
      <h3>${title}</h3>
      <p>${copy}</p>
    </article>`).join('');

  

  if (document.getElementById('contactGrid')) {
    document.getElementById('contactGrid').innerHTML = CONTACTS.map(([title, body]) => `
      <div class="contact-cell"><h3>${title}</h3><p>${body}</p></div>`).join('');
  }
}

/* Real photography slots in over the placeholders when present. */
function loadBackdrops() {
  const media = document.getElementById('heroMedia');
  const img = new Image();
  img.alt = '';
  img.addEventListener('load', () => media.insertBefore(img, media.querySelector('video')));
  img.src = 'images/hero/hero.jpg';
}

/* The still underneath stays as the fallback: if the file is missing or
   the browser cannot play webm, the video element is simply removed. */
function initVideo() {
  const media = document.getElementById('heroMedia');
  const video = media.querySelector('video');
  const source = video && video.querySelector('source');

  if (!video || !source || !source.getAttribute('src')) {
    if (video) video.remove();
    return;
  }

  video.addEventListener('error', () => video.remove(), { once: true });
  source.addEventListener('error', () => video.remove(), { once: true });

  /* autoplay can be refused (low power mode, some mobile browsers) */
  const play = video.play();
  if (play && play.catch) play.catch(() => {});
}

/* ============================= RESERVE ============================ */

/* Where customers collect from. Shown on the reserve panel as a plain
   label rather than a choice: the office runs from one location, and
   the city dropdown that used to sit here was built from whatever had
   been typed into each vehicle record — so it offered a dozen cities
   the business does not operate in. */
const PICKUP_CITY = 'Irving';

/* A date N days from today, as YYYY-MM-DD in LOCAL terms.

   toISOString() converts to UTC first, so local midnight comes back as
   the previous day anywhere west of Greenwich — the panel would offer
   a pick-up date a day earlier than intended for most of the day in
   Texas. */
function isoDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function renderFields(mode) {
  const wrap = document.getElementById('reserveFields');
  const btn = document.getElementById('searchBtn');
  const note = document.getElementById('reserveNote');

  const isRental = mode === 'rental';

  wrap.innerHTML = `
    <div class="field">
      <label for="f-loc">Pick-up location</label>
      ${/* The office operates from one location, so this states where
           the cars are rather than offering a choice. The value stays
           "any" so nothing is filtered out: the city list came from
           whatever was typed into each vehicle record, and filtering on
           a city no vehicle is recorded against would return an empty
           fleet. Should a second location open, this goes back to a
           <select>. */''}
      <div class="field-box static-field">${ICON.pin}
        <span id="f-loc" data-value="any">${esc(PICKUP_CITY)}</span>
      </div>
    </div>
    <div class="field">
      <label for="f-from">${isRental ? 'Pick-up date' : 'Available from'}</label>
      <div class="field-box date-box">${ICON.cal}<input id="f-from" type="date" value="${isoDate(1)}"></div>
    </div>
    <div class="field">
      <label for="f-to">${isRental ? 'Return date' : 'Viewing by'}</label>
      ${/* A rental runs for a month minimum, so the default return date
           has to clear it. This offered four days for both modes: a
           customer who searched with the dates already in the boxes,
           picked a car and pressed Confirm was told rentals run for at
           least 30 days — rejected by the form for using the figures
           the site itself had filled in. A viewing is not a rental, so
           the sale side keeps its short window. */''}
      <div class="field-box date-box">${ICON.cal}<input id="f-to" type="date"
           value="${isRental ? isoDate(31) : isoDate(4)}"></div>
    </div>
    <div class="field">
      <label for="f-type">Vehicle type</label>
      <div class="field-box">${ICON.car}
        <select id="f-type">
          <option value="any">All types</option>
          ${CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}
        </select>
        <span class="chev">${ICON.chev}</span>
      </div>
    </div>`;

  btn.textContent = isRental ? 'Search rentals' : 'Search cars for sale';
  /* "Insurance options" was removed: the agreement requires the driver
     to carry their own cover, so offering options here promised
     something the business does not sell. */
  note.textContent = `No hidden fees · Book any date, we confirm by email`;

  wrap.querySelectorAll('.date-box').forEach(box => {
    const input = box.querySelector('input[type="date"]');
    box.addEventListener('click', e => {
      if (e.target === input) return;
      if (input.showPicker) { try { input.showPicker(); } catch { input.focus(); } }
      else input.focus();
    });
  });
}

function initReserve() {
  const tabs = document.querySelectorAll('.tab');

  tabs.forEach(tab => tab.addEventListener('click', () => {
    tabs.forEach(t => t.setAttribute('aria-selected', String(t === tab)));
    renderFields(tab.dataset.mode);
  }));

  document.getElementById('searchBtn').addEventListener('click', () => {
    const mode = document.querySelector('.tab[aria-selected="true"]').dataset.mode;

    /* Rentals need 10 days notice — say so here rather than letting
       someone fill the whole form and be refused at the end. */
    const from = document.getElementById('f-from');
    if (mode === 'rental' && from) {
      const check = noticeCheck(from.value);
      if (!check.ok) {
        document.getElementById('reserveNote').textContent = check.message;
        document.getElementById('reserveNote').classList.add('warn');
        return;
      }
      document.getElementById('reserveNote').classList.remove('warn');
    }

    const loc = document.getElementById('f-loc');
    const type = document.getElementById('f-type');
    /* The location is a fixed label now, not a <select>, so it carries
       its value in a data attribute. `.value` is still read first so a
       future <select> works without touching this. */
    activeCity = loc ? (loc.value || loc.dataset.value || 'any') : 'any';
    activeCategory = type && type.value !== 'any' ? type.value : null;

    setType(mode, filterWrap.querySelector(`[data-filter="${mode}"]`));
    document.getElementById('fleet').scrollIntoView({ behavior: 'smooth' });
  });

  renderFields('rental');
}

/* ============================= LISTINGS =========================== */

function matches(car) {
  if (activeType !== 'all' && car.type !== activeType) return false;
  if (activeCategory && categoryOf(car) !== activeCategory) return false;
  if (activeCity !== 'any' && car.location !== activeCity) return false;
  return true;
}

function cardHTML(car) {
  const { value, unit } = priceLabel(car);

  /* A rental already spoken for this month gets a ribbon across the
     photo and its taken dates under the title, so nobody picks a car
     only to find out at checkout. Sales cars are never "booked". */
  const held = car.type === 'rental' ? isBooked(car.id) : null;
  const open = car.type !== 'rental' || canBook(car.id);

  /* A car out on rent reads "Booked". Once its renter has given notice
     and the office has released it, it reads "Prebooking open" instead,
     because other customers may now queue for it. */
  /* A released car invites pre-bookings only until someone pays to
     hold it. Once the fee is settled the slot belongs to that customer,
     so the card reads "Booked" rather than inviting more requests
     behind a reservation that is already paid for. */
  const flagText = !held ? ''
    : held.current
      ? (held.released && !held.claimed ? 'Prebooking open' : 'Booked')
      : held.firm ? 'Booked' : 'Requested';

  const flagClass = !held ? ''
    : held.current && held.released && !held.claimed ? ' open'
    : held.firm ? '' : ' pending';

  const ribbon = held ? `<span class="booked-flag${flagClass}">${flagText}</span>` : '';

  let dateLine = '';
  if (held && held.current && held.released && !held.claimed && held.availableFrom) {
    dateLine = `Available from ${formatDay(held.availableFrom)}`
             + (held.queueLength ? ` · ${held.queueLength} waiting` : '');
  } else if (held && held.current) {
    dateLine = `On rent ${formatRange(held.from, held.to)}`;
  } else if (held) {
    dateLine = `Booked ${formatRange(held.from, held.to)}`;
  }

  const dates = dateLine
    ? `<p class="car-booked-dates${open ? '' : ' locked'}">${dateLine}</p>`
    : '';

  return `
    <article class="car-card enter${held ? ' is-booked' : ''}">
      <a class="car-link" href="car.html?id=${car.id}"
         aria-label="${car.year} ${car.name} ${car.trim} — view details"></a>

      <div class="car-media" data-media>
        <span class="badge ${car.type}">${typeLabel(car.type)}</span>
        ${ribbon}
        <button class="fav" type="button" aria-pressed="false" aria-label="Save ${car.name}">${ICON.heart}</button>
        ${placeholderHTML(car.name)}
      </div>

      <div class="car-body">
        <span class="car-cat">${categoryOf(car)} &middot; ${car.location}</span>
        <h3>${car.year} ${car.name}</h3>
        ${dates}

        <ul class="car-specs">
          <li>${car.seats} seats</li>
          <li>${car.transmission.includes('Manual') ? 'Manual' : 'Auto'}</li>
          <li>${car.fuel}</li>
        </ul>

        <div class="car-foot">
          <span class="car-price"><b>${value}</b><span>${unit}</span></span>
          <span class="car-go">${ICON.arrow}</span>
        </div>
      </div>
    </article>`;
}

function render() {
  const all = FLEET.filter(matches);
  const list = expanded ? all : getMixedList(all);

  /* Say so when the list is not live. Without this the page renders a
     fleet that looks authoritative but may predate the newest change —
     a car published or hidden by the office after the last successful
     load simply would not be there, with nothing to explain why. */
  const stale = typeof isFleetStale === 'function' && isFleetStale();
  const warn = document.getElementById('fleetStale');
  if (warn) {
    warn.hidden = !stale;
    if (stale) warn.textContent =
      'Showing the last saved fleet — we could not reach the server, so this list may be out of date.';
  }

  grid.innerHTML = list.length
    ? list.map(cardHTML).join('')
    : `<div class="empty">No vehicles match that combination</div>`;

  countEl.textContent = all.length
    ? `${all.length} ${all.length === 1 ? 'vehicle' : 'vehicles'}`
    : '';

  grid.querySelectorAll('.car-card').forEach((card, i) => {
    const car = list[i];
    loadPhoto(card.querySelector('[data-media]'), car.image, `${car.year} ${car.name}`);
    requestAnimationFrame(() => setTimeout(() => card.classList.add('enter-in'), i * 55));
  });

  viewAllBtn.innerHTML = expanded ? `Show less ${ICON.arrow}` : `View all inventory ${ICON.arrow}`;
  viewAllBtn.hidden = all.length <= PAGE_SIZE;
  initAllRubbers();
}

function setType(value, btn) {
  activeType = value;
  filterWrap.querySelectorAll('.filter-btn').forEach(b => {
    b.setAttribute('aria-selected', String(b === btn));
  });
  render();
}

filterWrap.addEventListener('click', e => {
  const btn = e.target.closest('.filter-btn');
  if (btn && btn.dataset.filter !== activeType) setType(btn.dataset.filter, btn);
});

viewAllBtn.addEventListener('click', () => {
  expanded = !expanded;
  render();
});

/* Favourite toggle sits above the full-card link, so stop the click
   from also navigating to the detail page. */
grid.addEventListener('click', e => {
  const fav = e.target.closest('.fav');
  if (!fav) return;
  e.preventDefault();
  e.stopPropagation();
  fav.setAttribute('aria-pressed', fav.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
});

/* Hero buttons and the Inventory dropdown jump to the fleet with a
   filter already applied. Delegated, because the nav is built later by
   initChrome() — binding directly would miss those links. */
document.addEventListener('click', e => {
  const link = e.target.closest('[data-jump]');
  if (!link) return;
  activeCategory = null;
  activeCity = 'any';
  setType(link.dataset.jump, filterWrap.querySelector(`[data-filter="${link.dataset.jump}"]`));
});

/* ============================== BOOT ============================== */

/* The consultation request, filed as an enquiry for the office to
   follow up. (It once had no backend and only acknowledged the
   submission; it now posts to /api/enquiries.) */
function initConsult() {
  const form = document.getElementById('consultForm');
  const note = document.getElementById('consultNote');
  if (!form) return;
  initPhoneInput(document.getElementById('c-phone'));
  form.addEventListener('submit', e => {
    e.preventDefault();
    const name = document.getElementById('c-name').value.trim();
    const phone = document.getElementById('c-phone').value.trim();
    const mail = document.getElementById('c-mail').value.trim();
    if (!validUSPhone(phone)) {
      note.textContent = 'Please enter a valid 10-digit US phone number, e.g. (214) 555-0134.';
      return;
    }
    /* The address was collected and sent without ever being checked, so
       a typo became an enquiry the office could not reply to. Blank is
       still allowed — the phone number is the required contact — but a
       typed address has to look like one. */
    if (mail && !/^\S+@\S+\.\S+$/.test(mail)) {
      note.textContent = 'That email address does not look right — check it, or leave it blank.';
      return;
    }
    const payload = {
      kind: 'consultation',
      name,
      email: mail,
      phone: usPhone(phone)
    };
    note.textContent = 'Sending…';
    createEnquiry(payload)
      .then(() => {
        note.textContent = `Thanks${name ? ', ' + name : ''} — we will call you back within one business day.`;
        form.reset();
      })
      .catch(err => { note.textContent = `Could not send: ${err.message}`; });
  });
}

/* The three hero messages cross-fade, and the right-edge rail both
   tracks and controls them. Auto-rotation pauses on hover so a message
   is never yanked away mid-read. */
function initHeroSlides() {
  const slides = [...document.querySelectorAll('.hero-slide')];
  const dots = [...document.querySelectorAll('.hero-slides button')];
  if (slides.length < 2) return;

  let i = 0, timer = null;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const go = n => {
    i = (n + slides.length) % slides.length;
    slides.forEach((s, k) => s.classList.toggle('on', k === i));
    dots.forEach((d, k) => d.classList.toggle('on', k === i));
  };
  const start = () => { stop(); if (!calm) timer = setInterval(() => go(i + 1), 6500); };
  const stop = () => { if (timer) clearInterval(timer); timer = null; };

  dots.forEach((d, k) => d.addEventListener('click', () => { go(k); start(); }));

  const hero = document.querySelector('.hero');
  hero.addEventListener('mouseenter', stop);
  hero.addEventListener('mouseleave', start);
  document.addEventListener('visibilitychange', () => document.hidden ? stop() : start());

  go(0);
  start();
}

function init() {
  initChrome();
/* The bell lives in the brand bar; it shows nothing when signed out. */
initNotifications('customer');
  renderStaticContent();
  paintIcons();
  loadBackdrops();
  initVideo();
  initHeroSlides();
  initReserve();
  initConsult();
  render();
}

/* FLEET arrives over the network now, so boot after it lands. */
initStore().then(init).catch(err => {
  console.error('Startup failed:', err);
  init();
});
