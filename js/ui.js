/* ------------------------------------------------------------------
   Shared helpers for the home page and the vehicle detail page.
------------------------------------------------------------------- */

/* ── RUBBER PRESS ENGINE ────────────────────────────────── */
function applyRubber(el) {
  el.classList.add('pressing');
  el.classList.remove('releasing');
}
function releaseRubber(el) {
  el.classList.remove('pressing');
  el.classList.add('releasing');
  el.addEventListener('animationend', () => el.classList.remove('releasing'), { once: true });
}
function initRubber(selector) {
  document.querySelectorAll(selector).forEach(el => {
    el.addEventListener('mousedown', () => applyRubber(el));
    el.addEventListener('touchstart', () => applyRubber(el), { passive: true });
    el.addEventListener('mouseup', () => releaseRubber(el));
    el.addEventListener('mouseleave', () => { if (el.classList.contains('pressing')) releaseRubber(el); });
    el.addEventListener('touchend', () => releaseRubber(el));
    el.addEventListener('touchcancel', () => { el.classList.remove('pressing'); });
  });
}
function initAllRubbers() {
  /* .sound-btn also carries .sq-btn, so listing both bound the press
     effect to it twice. Dropping it from the list changes nothing
     visually and leaves one set of listeners per element. */
  initRubber('.btn, .sq-btn, .filter-btn, .car-go, .fav, .menu-toggle, .brand-nav > a, .brand-nav .nav-drop-btn, .brand-nav .nav-action');
}

/* One money format for the whole customer site.

   There were two: this one, and a second in car.js that always showed
   two decimals. car.js loads last, so on the car page it silently
   replaced this one and the same figure appeared as "$2,400" in the
   fleet grid and "$2,400.00" in the quote beside it.

   Cents are shown only when there are cents. A monthly rate of $500
   reads as "$500", while $586.67 keeps its precision — padding whole
   figures with ".00" makes a price list noisier without adding
   anything.

   Non-numbers are coerced rather than trusted: this used to call
   n.toLocaleString() directly, which THROWS on null or undefined, and
   a sale listing legitimately has a null total. One such value blanked
   whatever was rendering at the time. */
function money(n) {
  const v = Number(n);
  if (!isFinite(v)) return '$0';
  return '$' + v.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });
}

/* Rentals are advertised by the month. The day figure only exists so a
   part-month can be worked out, and that arithmetic belongs in the
   admin, not on a price card. */
function priceLabel(car) {
  if (car.type !== 'rental') return { value: money(car.price), unit: '' };
  const monthly = Number(car.monthlyRate) > 0
    ? Number(car.monthlyRate)
    : Number(car.price) * 30;
  return { value: money(Math.round(monthly)), unit: '/ month' };
}

function typeLabel(type) {
  return type === 'rental' ? 'For Rent' : 'For Sale';
}

/* Shelf categories derived from the body style, so the data file
   never has to repeat itself. */
function categoryOf(car) {
  if (car.body === 'Pickup') return 'Truck';
  if (car.body === 'Coupe' || car.body === 'Convertible') return 'Luxury';
  if (car.body.includes('SUV')) return 'SUV';
  return 'Sedan';
}

const CATEGORIES = ['Sedan', 'SUV', 'Truck', 'Luxury'];

/* ------------------------------- icons --------------------------- */

const S = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

const ICON = {
  arrow:     `<svg viewBox="0 0 24 24" ${S}><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
  back:      `<svg viewBox="0 0 24 24" ${S}><path d="M19 12H5M11 18l-6-6 6-6"/></svg>`,
  check:     `<svg viewBox="0 0 24 24" ${S} stroke-width="2.4"><path d="M20 6 9 17l-5-5"/></svg>`,
  user:      `<svg viewBox="0 0 24 24" ${S}><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-7 8-7s8 3 8 7"/></svg>`,
  chev:      `<svg viewBox="0 0 24 24" ${S}><path d="m6 9 6 6 6-6"/></svg>`,
  chevDown:  `<svg viewBox="0 0 24 24" ${S}><path d="m6 9 6 6 6-6"/></svg>`,
  close:     `<svg viewBox="0 0 24 24" ${S}><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  install:   `<svg viewBox="0 0 24 24" ${S}><path d="M12 3v12M7 11l5 5 5-5M4 20h16"/></svg>`,
  heart:     `<svg viewBox="0 0 24 24" ${S}><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l8.8 8.8 8.8-8.8a5.5 5.5 0 0 0 0-7.8z"/></svg>`,
  phone:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
  mail:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`,
  pin:       `<svg viewBox="0 0 24 24" ${S}><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
  cal:       `<svg viewBox="0 0 24 24" ${S}><rect x="3" y="4" width="18" height="18"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
  car:       `<svg viewBox="0 0 24 24" ${S}><path d="M5 17h14M4 17v-4.2a2 2 0 0 1 .5-1.3L7 8.4A2 2 0 0 1 8.5 7.7h7a2 2 0 0 1 1.5.7l2.5 3.1a2 2 0 0 1 .5 1.3V17"/><path d="M4 13h16"/><circle cx="7.5" cy="17" r="1.5"/><circle cx="16.5" cy="17" r="1.5"/></svg>`,
  gauge:     `<svg viewBox="0 0 24 24" ${S}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`,
  idCard:    `<svg viewBox="0 0 24 24" ${S}><rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M4.5 17c.7-1.9 1.9-2.8 3.5-2.8s2.8.9 3.5 2.8"/><path d="M15 9h6M15 12h6M15 15h4"/></svg>`,
  ig:        `<svg viewBox="0 0 24 24" ${S}><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none"/></svg>`,
  fb:        `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 9h3V6h-3c-2.2 0-4 1.8-4 4v2H8v3h2v7h3v-7h3l1-3h-4v-2c0-.6.4-1 1-1z"/></svg>`,
  yt:        `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22.5 7.4a2.7 2.7 0 0 0-1.9-1.9C18.9 5 12 5 12 5s-6.9 0-8.6.5A2.7 2.7 0 0 0 1.5 7.4 28 28 0 0 0 1 12a28 28 0 0 0 .5 4.6 2.7 2.7 0 0 0 1.9 1.9C5.1 19 12 19 12 19s6.9 0 8.6-.5a2.7 2.7 0 0 0 1.9-1.9A28 28 0 0 0 23 12a28 28 0 0 0-.5-4.6zM9.8 15.3V8.7l5.7 3.3z"/></svg>`,
  whatsapp:  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>`,
  /* stylised car roofline, echoing the reference wordmark */
  soundOff:  `<svg viewBox="0 0 24 24" ${S}><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m23 9-6 6M17 9l6 6"/></svg>`,
  soundOn:   `<svg viewBox="0 0 24 24" ${S}><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>`,
  sun:       `<svg viewBox="0 0 24 24" ${S}><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`,
  moon:      `<svg viewBox="0 0 24 24" ${S}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  swoosh:    `<img src="images/brand/car-mark.png" width="560" height="204" alt="" aria-hidden="true" decoding="async">`
};

/* Anything carrying data-icon gets its glyph injected. */
function paintIcons(root) {
  (root || document).querySelectorAll('[data-icon]').forEach(el => {
    if (ICON[el.dataset.icon]) el.innerHTML = ICON[el.dataset.icon];
  });
}

/* ---------------------------- US phone ----------------------------- */

/* Format a raw 10-digit string as (XXX) XXX-XXXX, or '' if shorter. */
function usPhone(value) {
  const d = String(value || '').replace(/\D/g, '').slice(0, 10);
  if (!d) return '';
  if (d.length < 4) return d;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/* A complete (XXX) XXX-XXXX, or null when the digits are incomplete. */
function validUSPhone(value) {
  const d = String(value || '').replace(/\D/g, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : null;
}

/* Reformat a tel input live while typing, capped at 10 digits. */
function initPhoneInput(input) {
  if (!input) return;
  input.addEventListener('input', () => {
    const v = input.value;
    const clean = v.replace(/\D/g, '');
    if (!clean) { input.value = ''; return; }
    input.value = usPhone(v);
  });
}

/* ------------------------- image placeholder --------------------- */

function placeholderHTML(label) {
  return `<div class="ph">${label ? `<span class="ph-label">${label}</span>` : ''}</div>`;
}

/* Swap the placeholder for the real photo once it has actually
   loaded. A missing file simply leaves the placeholder in place. */
function loadPhoto(container, src, alt) {
  if (!container || !src) return;
  const img = new Image();
  img.alt = alt || '';
  img.addEventListener('load', () => {
    const ph = container.querySelector('.ph');
    container.insertBefore(img, container.firstChild);
    if (ph) ph.remove();
  });
  img.src = src;
}

/* --------------------------- page chrome ------------------------- */

/* An item is either [label, href] or [label, null, [children]] for a
   dropdown, or [label, null, null, 'action'] for a button. */
const NAV = [
  ['Home', 'index.html'],
  ['Inventory', null, [
    ['Rentals', 'index.html#fleet', 'rental'],
    ['Cars For Sale', 'index.html#fleet', 'sale']
  ]],
  ['Contract', null, null, 'contract'],
  ['Reserve', 'index.html#book'],
  ['Contact', '#contact']
];

const PHONE = '+1 (945) 358-3064';
const PHONE_HREF = 'tel:+19453583064';
const EMAIL = 'reddyfinancialsinc@gmail.com';

function headerHTML() {
  return `
    <div class="shell header-inner">
      <a class="brand" href="index.html">
        <span class="swoosh">${ICON.swoosh}</span>
        <span class="name">Reddy Finances</span>
        <span class="sub">rental &amp; sales</span>
      </a>
      <button class="menu-toggle" id="menuOpen" aria-expanded="false" aria-controls="menuPanel">
        <span class="bars"><span></span><span></span><span></span></span>
        <span class="menu-label">Menu</span>
      </button>
    </div>`;
}

function menuHTML() {
  /* NAV carries three shapes: a plain link, a dropdown with children,
     and an action button. The fullscreen menu has room to show the
     children inline, so a dropdown becomes a heading plus its links —
     mapping blindly over [label, href] produced href="null" and a
     "Not found" page for Inventory and Contract. */
  const items = NAV.map(([label, href, children, action]) => {
    if (children) {
      return `
        <span class="menu-group">
          <span class="menu-group-title">${label}</span>
          ${children.map(([t, h, jump]) =>
            `<a href="${h}"${jump ? ` data-jump="${jump}"` : ''}>${t}</a>`).join('')}
        </span>`;
    }
    if (action) {
      return `<button type="button" class="menu-action" data-nav-action="${action}">${label}</button>`;
    }
    return `<a href="${href}">${label}</a>`;
  }).join('');

  return `
    <button class="menu-close" id="menuClose" aria-label="Close menu">${ICON.close}</button>
    <nav>${items}</nav>`;
}

function footerHTML() {
  const explore = [['Rent a Car', 'index.html#fleet'], ['Buy a Car', 'index.html#fleet'],
                   ['Reserve', 'index.html#book'], ['Sell Your Car', 'index.html#book']];
  const support = [['Contact Us', '#contact'], ['FAQ', '#contact'],
                   ['Rental Policies', '#contact'], ['Privacy Policy', '#contact'],
                   /* CC BY / CC BY-SA photos require visible attribution. */
                   ['Photo Credits', 'credits.html']];
  const col = (title, items) => `
    <div class="footer-col">
      <h4>${title}</h4>
      <ul>${items.map(([l, h]) => `<li><a href="${h}">${l}</a></li>`).join('')}</ul>
    </div>`;

  /* Install closes the Contact column, under the address and hours.
     It reads as a real button rather than another link because it is
     an action, not a destination — there is no URL to install, the
     browser does it. Painted only when the app is not already
     installed, and removed by the appinstalled handler along with the
     other install controls. */
  const installItem = isInstalled() ? '' : `
    <button type="button" class="btn btn-outline footer-install" data-install-btn
            aria-label="Install the Reddy Finances app">
      ${ICON.install}<span>Install the app</span>
    </button>`;

  return `
    <div class="shell">
      <div class="footer-grid">
        <div class="footer-col footer-brand">
          <a class="footer-logo" href="index.html" aria-label="Reddy Finances — home">
            <img src="images/brand/logo-trimmed.png" width="1573" height="289"
                 alt="Reddy Finances" loading="lazy" decoding="async">
          </a>
          <p>Quality cars, great prices, excellent service. Rentals and
             pre-owned sales in Dallas, Texas.</p>
        </div>
        ${col('Explore', explore)}
        ${col('Support', support)}
        <div class="footer-col">
          <h4>Contact</h4>
          <ul>
            <li>Dallas, Texas, USA</li>
            <li><a href="${PHONE_HREF}">${PHONE}</a></li>
            <li><a href="mailto:${EMAIL}">${EMAIL}</a></li>
            <li>Mon &ndash; Sun: 9:00 AM &ndash; 6:00 PM</li>
          </ul>
          ${installItem}
        </div>
      </div>
<div class="footer-bottom">
        <span>&copy; 2026 Reddy Finances</span>
        <span class="fb-design">
          <span class="fb-credit">Designed & Engineered by <a href="https://vexlor.in" target="_blank" rel="noopener">VEXLOR</a></span>
          <span class="fb-vexlor-socials">
            <a class="sq-btn" href="https://wa.me/918125179109" target="_blank" rel="noopener" aria-label="WhatsApp +91 81251 79109" title="WhatsApp +91 81251 79109">${ICON.whatsapp}</a>
            <a class="sq-btn" href="https://instagram.com/varun_vexlor" target="_blank" rel="noopener" aria-label="Instagram">${ICON.ig}</a>
            <a class="sq-btn" href="mailto:vexlor01@gmail.com" aria-label="Email">${ICON.mail}</a>
          </span>
        </span>
      </div>
    </div>`;
}

function initMenu() {
  const panel = document.getElementById('menuPanel');
  const open = document.getElementById('menuOpen');
  if (!panel || !open) return;

  /* The button is markup-wise inside .site-header, which sits inside
     .hero — and .hero creates its own stacking context. A fixed button
     nested in there cannot paint above the sections that follow the
     hero however high its z-index goes, so once the page scrolled past
     the video the button was there but buried: every click landed on
     the card above it.

     Moving the node to <body> on phones puts it in the root stacking
     context, where its z-index actually counts. Desktop keeps it in the
     header, where it belongs in the layout. */
  const FLOAT_AT = window.matchMedia('(max-width: 900px)');
  const homeParent = open.parentElement;
  const homeNext = open.nextElementSibling;

  const placeToggle = () => {
    if (FLOAT_AT.matches) {
      if (open.parentElement !== document.body) document.body.appendChild(open);
    } else if (open.parentElement !== homeParent) {
      homeParent.insertBefore(open, homeNext);
    }
  };
  placeToggle();
  FLOAT_AT.addEventListener('change', placeToggle);

  const setOpen = state => {
    panel.classList.toggle('open', state);
    open.setAttribute('aria-expanded', String(state));
    document.body.style.overflow = state ? 'hidden' : '';
  };

  open.addEventListener('click', () => setOpen(true));
  document.getElementById('menuClose').addEventListener('click', () => setOpen(false));
  panel.querySelectorAll('nav a').forEach(a => a.addEventListener('click', () => setOpen(false)));

  /* The Contract entry is a button, not a link — close the menu and open
     the agreement on top of the page. */
  panel.querySelectorAll('[data-nav-action="contract"]').forEach(b => {
    b.addEventListener('click', e => {
      e.preventDefault();
      setOpen(false);
      openContractModal();
    });
  });

  /* Install, same idea: the fullscreen menu is the only chrome on a
     narrow screen, where the brand bar's icon row is hidden. */
  panel.querySelectorAll('[data-nav-action="install"]').forEach(b => {
    b.addEventListener('click', e => {
      e.preventDefault();
      setOpen(false);
      runInstall();
    });
  });

  document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
}

/* ---- custom cursor ----
   The red ring and dot replace the pointer ONLY over the hero, and only
   while its video is actually playing — exactly as the reference does.
   Everywhere else the normal system cursor is left alone. Skipped on
   touch, where there is no pointer to replace. */
function initCursor() {
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  const hero = document.querySelector('.hero');
  if (!hero) return;

  const ring = document.createElement('div');
  const dot = document.createElement('div');
  ring.className = 'cursor-ring';
  dot.className = 'cursor-dot';
  ring.setAttribute('aria-hidden', 'true');
  dot.setAttribute('aria-hidden', 'true');
  document.body.append(ring, dot);

  const CLICKABLE = 'a, button, [role="tab"], .sq-btn, .menu-toggle';

  let mx = innerWidth / 2, my = innerHeight / 2;
  let rx = mx, ry = my;
  let over = false;      /* pointer is inside the hero */
  let visible = false;   /* ...and the video is actually running */
  const slow = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 0.16;

  const place = (el, x, y) => {
    el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
  };

  const video = hero.querySelector('video');
  /* Only a genuinely broken video hides the ring. Gating on !paused was
     wrong: autoplay gets refused whenever the clip carries sound, which
     would strand the pointer with no cursor at all. */
  const videoUsable = () => !video || !video.error;

  const sync = () => {
    visible = over && videoUsable();
    document.body.classList.toggle('cursor-ready', visible);
  };

  hero.addEventListener('mouseenter', e => {
    over = true;
    /* land the ring on the pointer rather than flying it in from wherever */
    mx = rx = e.clientX; my = ry = e.clientY;
    place(dot, mx, my);
    place(ring, rx, ry);
    sync();
  });

  hero.addEventListener('mouseleave', () => { over = false; sync(); });

  hero.addEventListener('mousemove', e => {
    mx = e.clientX; my = e.clientY;
    place(dot, mx, my);
    if (!over) { over = true; rx = mx; ry = my; place(ring, rx, ry); }
    if (!visible) sync();
    ring.classList.toggle('is-active', !!e.target.closest(CLICKABLE));
  }, { passive: true });

  /* the ring chases the dot rather than snapping to it */
  (function follow() {
    if (visible) {
      rx += (mx - rx) * slow;
      ry += (my - ry) * slow;
      place(ring, rx, ry);
    }
    requestAnimationFrame(follow);
  })();

  /* playback state drives visibility directly */
  if (video) {
    ['error', 'playing', 'canplay', 'loadeddata'].forEach(ev =>
      video.addEventListener(ev, sync));
  }
  addEventListener('blur', () => { over = false; sync(); });
}

/* ---- sound ----
   The clip carries audio, but every browser refuses to autoplay sound.
   So it starts muted (which is what lets it autoplay at all) and the
   viewer turns it on. The click is the user gesture that unlocks it. */
function initSound() {
  const btn = document.getElementById('soundBtn');
  const video = document.querySelector('.hero video');
  if (!btn) return;
  if (!video) { btn.hidden = true; return; }

  const paint = () => {
    btn.innerHTML = video.muted ? ICON.soundOff : ICON.soundOn;
    btn.setAttribute('aria-pressed', String(!video.muted));
    btn.setAttribute('aria-label', video.muted ? 'Turn sound on' : 'Turn sound off');
    btn.classList.toggle('is-on', !video.muted);
  };

  btn.addEventListener('click', async () => {
    video.muted = !video.muted;
    if (!video.muted) {
      video.volume = 1;
      try { await video.play(); } catch { video.muted = true; }
    }
    paint();
  });

  video.addEventListener('volumechange', paint);
  video.addEventListener('error', () => { btn.hidden = true; });
  paint();
}

/* --------------------------- nav dropdown ------------------------- */

/* Click to open, click away or Escape to close. Kept to click rather
   than hover so it behaves the same on a touch screen. */
function initNavDropdowns(nav) {
  nav.querySelectorAll('.nav-drop').forEach(drop => {
    const btn = drop.querySelector('.nav-drop-btn');
    const menu = drop.querySelector('.nav-menu');
    if (!btn || !menu) return;

    const close = () => {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      drop.classList.remove('open');
    };

    btn.addEventListener('click', e => {
      e.stopPropagation();
      const willOpen = menu.hidden;
      /* only one open at a time */
      nav.querySelectorAll('.nav-menu').forEach(m => { m.hidden = true; });
      nav.querySelectorAll('.nav-drop').forEach(d => d.classList.remove('open'));
      nav.querySelectorAll('.nav-drop-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
      if (willOpen) {
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        drop.classList.add('open');
      }
    });

    menu.addEventListener('click', () => close());
    document.addEventListener('click', e => { if (!drop.contains(e.target)) close(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !menu.hidden) { close(); btn.focus(); }
    });
  });

  /* The Contract button opens the agreement on screen. */
  nav.querySelectorAll('[data-nav-action="contract"]').forEach(b => {
    b.addEventListener('click', e => { e.preventDefault(); openContractModal(); });
  });
}

/* -------------------------- contract modal ------------------------ */

/* The same wording the emailed PDF carries — both read from
   /api/contracts/terms, so they can never drift apart. */
let contractTermsCache = null;

async function openContractModal() {
  let modal = document.getElementById('contractModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'contractModal';
    modal.className = 'contract-modal';
    modal.innerHTML = `
      <div class="contract-card" role="dialog" aria-modal="true" aria-labelledby="contractTitle">
        <header class="contract-head">
          <div>
            <span class="contract-eyebrow">Rental agreement</span>
            <h2 id="contractTitle">Terms &amp; conditions</h2>
          </div>
          <button type="button" class="contract-close" aria-label="Close">${ICON.close}</button>
        </header>
        <div class="contract-body" id="contractBody" tabindex="0">
          <p class="contract-loading">Loading the agreement&hellip;</p>
        </div>
        <footer class="contract-foot">
          <span>These terms form part of every rental agreement.</span>
        </footer>
      </div>`;
    document.body.appendChild(modal);

    modal.addEventListener('click', e => { if (e.target === modal) closeContractModal(); });
    modal.querySelector('.contract-close').addEventListener('click', closeContractModal);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal.classList.contains('open')) closeContractModal();
    });
  }

  modal.classList.add('open');
  document.body.style.overflow = 'hidden';   /* stop the page behind scrolling */
  modal.querySelector('.contract-close').focus();

  const body = document.getElementById('contractBody');
  try {
    if (!contractTermsCache) {
      contractTermsCache = await fetch('/api/contracts/terms').then(r => r.json());
    }
    const t = contractTermsCache;
    document.getElementById('contractTitle').textContent = t.title || 'Terms & conditions';
    /* The agreement is nine titled sections, each with its own
       paragraphs — the same structure as the PDF, so the popup and the
       document a customer signs cannot drift apart. */
    body.innerHTML =
      (t.intro ? `<p class="contract-lead">${esc(t.intro)}</p>` : '') +
      (t.sections || []).map(s => `
        <section class="contract-section">
          <h4>${esc(s.number)}. ${esc(s.heading)}</h4>
          ${(s.paragraphs || []).map(p => `<p>${esc(p)}</p>`).join('')}
        </section>`).join('') +
      (t.acknowledgement ? `<p class="contract-ack">${esc(t.acknowledgement)}</p>` : '') +
      `<p class="contract-sign">Full Name: ______________________ &nbsp;
        Signature: ______________ &nbsp; Date: __________</p>`;
  } catch {
    body.innerHTML = '<p class="contract-loading">Could not load the agreement. Please try again.</p>';
  }
}

function closeContractModal() {
  const modal = document.getElementById('contractModal');
  if (!modal) return;
  modal.classList.remove('open');
  document.body.style.overflow = '';
}

/* ------------------------- install the app -------------------------

   The site is already a progressive web app: manifest.json is linked
   on every page and sw.js is registered, so a browser will install it
   to the home screen. Nothing ever told the customer that, so this
   adds the button.

   There is no installable .apk or .ipa to hand out — the app is the
   website, installed by the browser. That shapes everything below:

   - Chrome, Edge and Android fire `beforeinstallprompt`, which hands
     over a prompt we may show once. That is the real install.
   - iOS Safari has no such event. Installing is Share → Add to Home
     Screen, which only the customer can do, so there we explain it.
   - An app already installed must not offer to install again, so the
     button is hidden when running standalone.

   The event fires before this module runs on a fast load, so the
   handler is registered at the top of the file rather than inside
   initChrome, and the captured prompt is kept for whenever the
   button is painted. */

let installPrompt = null;

/* True when the page is already running as an installed app. */
function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.matchMedia('(display-mode: minimal-ui)').matches ||
         /* iOS marks an installed web app this way instead. */
         window.navigator.standalone === true;
}

const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  /* iPadOS reports itself as a Mac; the touch points give it away. */
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

window.addEventListener('beforeinstallprompt', e => {
  /* Chrome shows its own mini-infobar unless this is prevented, and
     once prevented the prompt is ours to trigger from the button. */
  e.preventDefault();
  installPrompt = e;
  paintInstallButton();
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  /* Drop the button rather than leave it offering what just happened. */
  document.querySelectorAll('[data-install-btn]').forEach(b => b.remove());
  if (window.toast) toast('Reddy Finances is installed. Open it from your home screen.');
});

/* Shown only where the browser cannot install on its own. The steps
   differ per browser, so each gets its own, and anything unrecognised
   gets the generic menu wording rather than confident instructions
   for a menu it may not have. */
function installHelpHTML() {
  if (isIOS()) {
    return `
      <p>On iPhone and iPad, Safari installs the app from the Share menu:</p>
      <ol>
        <li>Tap the <strong>Share</strong> button at the bottom of Safari
            (a square with an arrow pointing up).</li>
        <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
        <li>Tap <strong>Add</strong>.</li>
      </ol>
      <p class="install-note">Safari is the only browser on iPhone that can
         install an app. If you are using Chrome here, open this page in
         Safari first.</p>`;
  }
  return `
    <p>Your browser can add this app to your device from its own menu:</p>
    <ol>
      <li>Open the browser menu (<strong>⋮</strong> or <strong>☰</strong>).</li>
      <li>Choose <strong>Install app</strong>, or <strong>Add to Home
          screen</strong>.</li>
    </ol>
    <p class="install-note">If neither appears, the app can still be used in
       the browser — nothing is missing, it simply will not have its own
       icon.</p>`;
}

function openInstallHelp() {
  let modal = document.getElementById('installModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'installModal';
    modal.className = 'install-modal';
    modal.innerHTML = `
      <div class="install-card" role="dialog" aria-modal="true"
           aria-labelledby="installTitle">
        <button type="button" class="install-close" aria-label="Close">
          ${ICON.close}
        </button>
        <h3 id="installTitle">Install Reddy Finances</h3>
        ${installHelpHTML()}
      </div>`;
    document.body.appendChild(modal);

    const shut = () => {
      modal.classList.remove('open');
      document.body.style.overflow = '';
    };
    modal.querySelector('.install-close').addEventListener('click', shut);
    /* A tap on the backdrop closes; a tap inside the card must not. */
    modal.addEventListener('click', e => { if (e.target === modal) shut(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal.classList.contains('open')) shut();
    });
  }
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  modal.querySelector('.install-close').focus();
}

async function runInstall() {
  /* No captured prompt means this browser never offered one, so the
     only honest thing to do is explain how its menu does it. */
  if (!installPrompt) return openInstallHelp();

  const prompt = installPrompt;
  /* A prompt can only be used once. Clearing it first means a second
     tap cannot replay a spent prompt and silently do nothing. */
  installPrompt = null;
  try {
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome !== 'accepted') {
      /* Dismissed, not failed. Chrome will fire the event again on a
         later visit, so say nothing and leave the button in place. */
      paintInstallButton();
    }
  } catch {
    /* Prompting can throw if it was already consumed or the gesture
       expired; fall back to the instructions. */
    openInstallHelp();
  }
}

/* The same offer inside the fullscreen menu, which on a narrow screen
   is the only chrome there is — the brand bar's icon row is hidden at
   that width, so the icon button alone would be unreachable on a
   phone, which is where installing matters most.

   Called before initMenu so the click handler there picks it up. */
function initInstallMenuItem() {
  if (isInstalled()) return;
  const nav = document.querySelector('#menuPanel nav');
  if (!nav || nav.querySelector('[data-nav-action="install"]')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'menu-action menu-install';
  btn.setAttribute('data-nav-action', 'install');
  btn.innerHTML = `${ICON.install}<span>Install the app</span>`;
  nav.appendChild(btn);
}

/* Puts the button in the brand bar and wires up every install control
   on the page — the header icon, the footer entry, and any other that
   carries data-install-btn.

   Safe to call repeatedly: it will not add a second button, and the
   bound flag stops a control picking up a duplicate listener, which
   would fire runInstall twice per tap. */
function paintInstallButton() {
  if (isInstalled()) {
    document.querySelectorAll('[data-install-btn]').forEach(b => b.remove());
    return;
  }
  const slot = document.querySelector('.brand-right');
  if (slot && !slot.querySelector('[data-install-btn]')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sq-btn brand-header-icon install-btn';
    btn.setAttribute('data-install-btn', '');
    btn.setAttribute('aria-label', 'Install the Reddy Finances app');
    btn.title = 'Install the app';
    btn.innerHTML = ICON.install;
    /* Ahead of the notification bell and the account slot, so it does
       not sit between them and separate the two. */
    const before = slot.querySelector('.notif-wrap');
    slot.insertBefore(btn, before || null);
  }

  /* The footer entry is written as markup by footerHTML rather than
     created here, so it arrives without a handler. */
  document.querySelectorAll('[data-install-btn]').forEach(b => {
    if (b.dataset.installBound) return;
    b.dataset.installBound = '1';
    b.addEventListener('click', runInstall);
  });
}

let chromeReady = false;

function initChrome() {
  /* app.js calls this directly AND ui.js binds it to DOMContentLoaded,
     so it ran twice on the home page: every listener bound twice and
     the sound toggle flipped muted on, then straight back off, in a
     single tap. Repainting is also wasted work. Guard it. */
  if (chromeReady) return;
  chromeReady = true;

  /* Not every page carries the full chrome — the profile and bookings
     pages have their own header. Missing pieces are skipped rather than
     throwing and stopping the rest of the script. */
  const header = document.querySelector('.site-header');
  if (header) header.innerHTML = headerHTML();
  const panel = document.getElementById('menuPanel');
  if (panel) panel.innerHTML = menuHTML();
  const footer = document.querySelector('.site-footer');
  if (footer) footer.innerHTML = footerHTML();

  /* Inject nav links + contact icons into the brand bar (above the video, beside the logo) */
  const brandBar = document.querySelector('.brand-bar .shell');
  if (brandBar && !brandBar.querySelector('.brand-nav')) {
    const nav = document.createElement('nav');
    nav.className = 'brand-nav';
    nav.setAttribute('aria-label', 'Primary');
    nav.innerHTML = NAV.map(([label, href, children, action]) => {
      if (children) {
        return `
          <span class="nav-drop">
            <button type="button" class="nav-drop-btn" aria-expanded="false" aria-haspopup="true">
              ${label}<span class="nav-caret" aria-hidden="true"></span>
            </button>
            <span class="nav-menu" hidden>
              ${children.map(([t, h, jump]) =>
                `<a href="${h}"${jump ? ` data-jump="${jump}"` : ''}>${t}</a>`).join('')}
            </span>
          </span>`;
      }
      if (action) {
        return `<button type="button" class="nav-action" data-nav-action="${action}">${label}</button>`;
      }
      return `<a href="${href}">${label}</a>`;
    }).join('');
    initNavDropdowns(nav);
    brandBar.appendChild(nav);

    const brandRight = document.createElement('div');
    brandRight.className = 'brand-right';
    brandRight.innerHTML = `
      <a class="sq-btn brand-header-icon" href="https://wa.me/19453583064" target="_blank" rel="noopener" aria-label="WhatsApp +1 (945) 358-3064" title="WhatsApp +1 (945) 358-3064">${ICON.whatsapp}</a>
      <a class="sq-btn brand-header-icon" href="tel:+19453583064" aria-label="Call +1 (945) 358-3064" title="+1 (945) 358-3064">${ICON.phone}</a>
      <a class="sq-btn brand-header-icon" href="mailto:reddyfinancialsinc@gmail.com" aria-label="Email reddyfinancialsinc@gmail.com" title="reddyfinancialsinc@gmail.com">${ICON.mail}</a>
      <span class="notif-wrap" id="notifWrap"></span>
      <span class="auth-slot" id="authSlot"></span>`;
    brandBar.appendChild(brandRight);
  }
  paintIcons();
  /* Before initMenu, which is what binds the click handler for the
     entry this adds. */
  initInstallMenuItem();
  initMenu();
  initCursor();
  initSound();
  initAllRubbers();
  /* The brand bar exists by now, and beforeinstallprompt may already
     have fired and stored its prompt before this script ran. */
  paintInstallButton();

  /* The auth slot lives in the header we just painted; let the auth module
     (if loaded) fill it in with the current session. */
  if (window.refreshAuth) window.refreshAuth();

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    if (savedTheme === 'system') {
      const root = document.documentElement;
      if (e.matches) {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', initChrome);
