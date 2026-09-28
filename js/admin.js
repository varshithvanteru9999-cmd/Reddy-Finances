/* ------------------------------------------------------------------
   Admin dashboard. Two tabs — fleet and bookings — both backed by
   localStorage through js/store.js, so edits land on the public site.
------------------------------------------------------------------- */

let fleet = [];
let bookings = [];
/* reference -> { count, latest } for payment proofs, so a row can show
   a badge without a request each. Refreshed whenever bookings are. */
let paymentProofCount = {};
let queueRows = [];

/* Bookings and their payment-proof counts always travel together —
   loading one without the other leaves the badges stale. */
async function reloadBookings() {
  const [rows, counts] = await Promise.all([
    loadBookings(),
    loadPaymentProofCounts()
  ]);
  paymentProofCount = counts || {};
  return rows;
}
let bookAllActive = false;
/* The notification bell, once booted — kept so any action that changes
   state can refresh it. */
let notifications = null;

const $ = id => document.getElementById(id);

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
  initRubber('.btn, .tab, .add-inline');
}

const S = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  search: `<svg viewBox="0 0 24 24" ${S}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>`,
  plus:   `<svg viewBox="0 0 24 24" ${S} stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>`
};
document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = ICONS[el.dataset.icon] || ''; });

const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Always two decimals. Without them a figure with a single decimal
   printed as "$48.5", which reads like a truncated number on an
   invoice or a toll statement rather than forty-eight fifty. */
const money = n => '$' + Number(n || 0).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function categoryOf(car) {
  const body = car.body || '';
  if (body === 'Pickup') return 'Truck';
  if (body === 'Coupe' || body === 'Convertible') return 'Luxury';
  if (body.includes('SUV')) return 'SUV';
  return 'Sedan';
}

let toastTimer;
function toast(msg, bad) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('bad', !!bad);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* CSV needs quotes doubled and the whole field wrapped, or commas in
   an address will shear the columns apart. */
function downloadCSV(filename, rows) {
  const body = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---- image handling ----
   No server, so the photo has to live in localStorage as a data URL.
   Raw camera files are far too big for that, so every image is decoded,
   scaled down and re-encoded as JPEG before it is stored. Whatever the
   browser can decode is accepted — JPG, PNG, WebP, GIF, AVIF. */
const IMG_MAX_EDGE = 1400;
const IMG_QUALITY = 0.82;

async function processImage(file) {
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(file.name)) {
    throw new Error('That is not an image file.');
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    /* HEIC from an iPhone is the usual culprit — Chrome cannot decode it */
    throw new Error('This browser cannot read that image format. Try JPG, PNG or WebP.');
  }

  const scale = Math.min(1, IMG_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  /* JPEG has no alpha, so flatten onto white rather than onto black */
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  return canvas.toDataURL('image/jpeg', IMG_QUALITY);
}

const approxKB = dataUrl => Math.round((dataUrl.length * 3 / 4) / 1024);

/* wires the dropzone for whichever sheet is currently open */
function initDropzones() {
  document.querySelectorAll('.dropzone').forEach(zone => {
    const key = zone.id.replace('dz_', '');
    const fileInput = $(`dzfile_${key}`);
    const hidden = $(`f_${key}`);
    const preview = $(`dzimg_${key}`);
    const empty = zone.querySelector('.dz-empty');
    const busy = zone.querySelector('.dz-busy');
    const sizeEl = $(`dzsize_${key}`);
    const clearBtn = document.querySelector(`[data-dz-clear="${key}"]`);

    const show = value => {
      hidden.value = value || '';
      preview.hidden = !value;
      if (value) preview.src = value;
      empty.hidden = !!value;
      clearBtn.hidden = !value;
      sizeEl.textContent = value && value.startsWith('data:') ? `${approxKB(value)} KB stored` : '';
    };

    const take = async file => {
      if (!file) return;
      busy.hidden = false;
      $('sheetError').hidden = true;
      try {
        show(await processImage(file));
      } catch (err) {
        $('sheetError').textContent = err.message;
        $('sheetError').hidden = false;
      } finally {
        busy.hidden = true;
      }
    };

    zone.addEventListener('click', () => fileInput.click());
    zone.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    document.querySelector(`[data-dz-pick="${key}"]`).addEventListener('click', () => fileInput.click());
    clearBtn.addEventListener('click', () => show(''));
    fileInput.addEventListener('change', () => take(fileInput.files[0]));

    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => {
      e.preventDefault(); zone.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => {
      e.preventDefault(); zone.classList.remove('over');
    }));
    zone.addEventListener('drop', e => take(e.dataTransfer?.files?.[0]));
  });
}

/* ============================== TABS ============================== */

const PANELS = ['overview', 'fleet', 'bookings', 'release', 'pending', 'photos', 'actions'];

/* A table wider than the screen puts its scrollbar at its own foot, so
   with fourteen or sixteen columns the admin had to scroll to the last
   row before they could move sideways. This gives each table a second,
   empty scroller pinned to the bottom of the viewport: it carries the
   same scrollable width, and the two are kept in step in both
   directions, so the bar is always in reach and the table keeps its
   full height. */
function syncRail(wrap) {
  let rail = wrap.nextElementSibling;
  if (!rail || !rail.classList.contains('hscroll-rail')) {
    rail = document.createElement('div');
    rail.className = 'hscroll-rail';
    rail.appendChild(document.createElement('div'));
    wrap.after(rail);

    /* Mirror each way, with a flag so one update cannot re-trigger the
       other and fight the user's drag. */
    let lock = false;
    const link = (from, to) => from.addEventListener('scroll', () => {
      if (lock) return;
      lock = true;
      to.scrollLeft = from.scrollLeft;
      requestAnimationFrame(() => { lock = false; });
    }, { passive: true });
    link(rail, wrap);
    link(wrap, rail);
  }

  /* The spacer carries the table's full width, which is what gives the
     rail a thumb of the right size. */
  const inner = rail.firstElementChild;
  const width = wrap.scrollWidth;
  if (inner.style.width !== `${width}px`) inner.style.width = `${width}px`;

  /* Nothing overflowing means nothing to scroll — hide the rail rather
     than leave a dead bar across the screen. */
  rail.classList.toggle('is-idle', wrap.scrollWidth <= wrap.clientWidth + 1);
}

function sizeTables() {
  document.querySelectorAll('.table-wrap').forEach(wrap => {
    if (!wrap.offsetParent) return;          /* hidden panel, nothing to measure */
    syncRail(wrap);
  });
}

/* Re-run whenever the width could have changed: tab switches, window
   resize, and after rows are painted. A ResizeObserver on the panels
   catches the last case for every table at once, rather than hooking
   each render function by hand and missing the ones added later. */
window.addEventListener('resize', sizeTables);
document.addEventListener('DOMContentLoaded', sizeTables);

if (typeof ResizeObserver === 'function') {
  const ro = new ResizeObserver(() => sizeTables());
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[role="tabpanel"]').forEach(p => ro.observe(p));
  });
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t === tab)));
    PANELS.forEach(name => { $(`panel-${name}`).hidden = tab.dataset.tab !== name; });
    /* charts measure themselves, so redraw once the panel is visible */
    if (tab.dataset.tab === 'overview') renderOverview();
    if (tab.dataset.tab === 'actions') renderActions();
    if (tab.dataset.tab === 'release') renderRelease();
    if (tab.dataset.tab === 'photos')  renderPhotos();
    if (tab.dataset.tab === 'pending') renderPending();
    /* after the panel is shown, so the wrapper has a real position */
    requestAnimationFrame(sizeTables);
  });
});

/* ============================== SHEET ============================= */

let onSave = null;

/* Keeps a clock field's hidden 24-hour value in step with its three
   lists. Empty hour means no time agreed, which must stay empty rather
   than defaulting to midnight — a blank contract line is honest, an
   invented 12:00 AM is not. */
function initClockFields(fields) {
  fields.filter(f => f.type === 'clock').forEach(f => {
    const h = $(`f_${f.key}_h`);
    const m = $(`f_${f.key}_m`);
    const out = $(`f_${f.key}`);
    const group = h && h.closest('.clock-field');
    if (!h || !m || !out || !group) return;

    const meridiem = () => {
      const on = group.querySelector('[data-mer].on');
      return on ? on.dataset.val : 'AM';
    };

    /* Writes the 24-hour value the server stores. Anything that is not
       a real time leaves it empty, so a half-typed hour cannot be saved
       as a time nobody agreed to. */
    const sync = () => {
      const hv = h.value.trim();
      const mv = m.value.trim();
      if (!hv) { out.value = ''; return; }
      const hn = Number(hv);
      const mn = mv === '' ? 0 : Number(mv);
      if (!Number.isInteger(hn) || hn < 1 || hn > 12) { out.value = ''; return; }
      if (!Number.isInteger(mn) || mn < 0 || mn > 59) { out.value = ''; return; }
      let hour = hn % 12;                        /* 12 AM -> 0, 12 PM -> 12 */
      if (meridiem() === 'PM') hour += 12;
      out.value = `${String(hour).padStart(2, '0')}:${String(mn).padStart(2, '0')}`;
    };

    /* Digits only while typing — letters in an hour box help nobody. */
    [h, m].forEach(el => {
      el.addEventListener('input', () => {
        const clean = el.value.replace(/\D/g, '').slice(0, 2);
        if (el.value !== clean) el.value = clean;
        sync();
      });
    });

    /* Tidy up once they leave the box rather than fighting them
       mid-keystroke: "7" becomes "07" minutes, an out-of-range hour is
       flagged instead of silently dropped. */
    h.addEventListener('blur', () => {
      const n = Number(h.value.trim());
      if (h.value.trim() && Number.isInteger(n) && n >= 1 && n <= 12) h.value = String(n);
      h.classList.toggle('is-bad', Boolean(h.value.trim()) && !(n >= 1 && n <= 12));
      sync();
    });
    m.addEventListener('blur', () => {
      const raw = m.value.trim();
      const n = Number(raw);
      if (raw === '' && h.value.trim()) m.value = '00';
      else if (raw !== '' && Number.isInteger(n) && n >= 0 && n <= 59) m.value = String(n).padStart(2, '0');
      m.classList.toggle('is-bad', raw !== '' && !(n >= 0 && n <= 59));
      sync();
    });

    group.querySelectorAll('[data-mer]').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('[data-mer]').forEach(b => b.classList.toggle('on', b === btn));
        sync();
      });
    });

    const clear = group.querySelector(`[data-clock-clear="${f.key}"]`);
    if (clear) {
      clear.addEventListener('click', () => {
        h.value = ''; m.value = '';
        h.classList.remove('is-bad'); m.classList.remove('is-bad');
        group.querySelectorAll('[data-mer]').forEach(b => b.classList.toggle('on', b.dataset.val === 'AM'));
        out.value = '';
      });
    }
    sync();
  });
}

function openSheet(title, sub, fields, handler, opts = {}) {
  $('sheetTitle').textContent = title;
  $('sheetSub').textContent = sub;
  $('sheetError').hidden = true;

  /* "Save" is right for a form that edits a record, but wrong for one
     that emails a customer — the button should say what it will do.
     Defaults back to Save so every other sheet is unchanged. */
  const submit = $('sheetSubmit');
  if (submit) submit.textContent = opts.submitLabel || 'Save';

  $('sheetFields').innerHTML = fields.map(f => `
    <div class="field ${f.full ? 'full' : ''}">
      ${f.type === 'html'
        /* An empty label would still reserve its line and leave a gap. */
        ? (f.label ? `<span class="field-label">${esc(f.label)}</span>` : '')
        : f.type === 'clock'
        /* The real input is hidden, so the label points at the hour
           list — the first thing you would actually type into. */
        ? `<label for="f_${f.key}_h">${esc(f.label)}</label>`
        : `<label for="f_${f.key}">${esc(f.label)}</label>`}
      ${f.type === 'panel'
        ? `<div class="quote-panel" id="quotePanel"></div>`
        : f.type === 'clock'
        /* Hour and minute are typed, with AM/PM as a two-way toggle.
           A native time input follows the machine's locale, so on a
           24-hour system it shows 14:30 with no AM or PM anywhere; the
           office reads and writes times as "2:30 PM". Typing beats
           picking from a list for a value the admin already knows. The
           hidden input holds the 24-hour value the server stores. */
        ? (() => {
            const cur = String(f.value || '');
            const m = /^(\d{1,2}):(\d{2})$/.exec(cur);
            const h24 = m ? Number(m[1]) : null;
            const min = m ? m[2] : '';
            const mer = h24 === null ? 'AM' : (h24 < 12 ? 'AM' : 'PM');
            const h12 = h24 === null ? '' : (h24 % 12 === 0 ? 12 : h24 % 12);
            return `
              <div class="clock-field">
                <input id="f_${f.key}_h" class="clock-num" type="text"
                       inputmode="numeric" maxlength="2" placeholder="--"
                       aria-label="Hour" value="${esc(h12)}">
                <span class="clock-sep">:</span>
                <input id="f_${f.key}_m" class="clock-num" type="text"
                       inputmode="numeric" maxlength="2" placeholder="00"
                       aria-label="Minute" value="${esc(min)}">
                <span class="clock-ampm" role="group" aria-label="AM or PM">
                  <button type="button" data-mer="${f.key}" data-val="AM"
                          class="${mer === 'AM' ? 'on' : ''}">AM</button>
                  <button type="button" data-mer="${f.key}" data-val="PM"
                          class="${mer === 'PM' ? 'on' : ''}">PM</button>
                </span>
                <button type="button" class="clock-clear" data-clock-clear="${f.key}"
                        title="Clear the time">Clear</button>
              </div>
              <input type="hidden" id="f_${f.key}" value="${esc(cur)}">`;
          })()
        : f.type === 'html'
        /* Pre-built markup the caller has already escaped — used for
           read-only listings that are not form inputs. */
        ? `<div class="sheet-block">${f.html || ''}</div>`
        : f.type === 'file'
        ? `<div class="dropzone" id="dz_${f.key}" tabindex="0" role="button"
                aria-label="Choose or drop an image">
             <img class="dz-preview" id="dzimg_${f.key}" alt=""${f.value ? ` src="${esc(f.value)}"` : ' hidden'}>
             <span class="dz-empty"${f.value ? ' hidden' : ''}>
               <b>Drop an image here</b>
               <span>or click to choose &mdash; JPG, PNG, WebP, GIF, AVIF</span>
             </span>
             <span class="dz-busy" hidden>Processing&hellip;</span>
           </div>
           <div class="dz-actions">
             <button class="btn btn-line btn-sm" type="button" data-dz-pick="${f.key}">Choose image</button>
             <button class="btn btn-line btn-sm" type="button" data-dz-clear="${f.key}"${f.value ? '' : ' hidden'}>Remove</button>
             <span class="dz-size" id="dzsize_${f.key}"></span>
           </div>
           <input type="file" id="dzfile_${f.key}" accept="image/*" hidden>
           <input type="hidden" id="f_${f.key}" value="${esc(f.value)}">`
        : f.type === 'select'
        ? `<select id="f_${f.key}">${f.options.map(o => {
             const val = o && o.value !== undefined ? o.value : o;
             const label = o && o.label !== undefined ? o.label : o;
             return `<option value="${esc(val)}"${String(val) === String(f.value) ? ' selected' : ''}>${esc(label)}</option>`;
           }).join('')}</select>`
        : `<input id="f_${f.key}" type="${f.type || 'text'}" value="${esc(f.value)}"
             ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}
             ${f.min !== undefined ? `min="${f.min}"` : ''}
             ${f.readOnly ? 'readonly tabindex="-1" class="is-readonly"' : ''}>`}
      ${f.hint ? `<p class="hint">${esc(f.hint)}</p>` : ''}
      ${f.action ? `<button type="button" class="field-action" data-field-action="${esc(f.key)}"
            title="${esc(f.action.title || '')}">${f.action.icon || ''}<span>${esc(f.action.label || '')}</span></button>` : ''}
    </div>`).join('');

  onSave = () => {
    const values = {};
    fields.forEach(f => {
      if (f.type === 'panel' || f.type === 'html') return;  /* display only, no input */
      values[f.key] = $(`f_${f.key}`).value.trim();
    });
    return handler(values);
  };
  initDropzones();
  initClockFields(fields);

  /* Per-field action buttons (the breakdown link under Rental). */
  fields.filter(f => f.action && typeof f.action.onClick === 'function').forEach(f => {
    const btn = document.querySelector(`[data-field-action="${f.key}"]`);
    if (btn) btn.addEventListener('click', f.action.onClick);
  });

  /* the breakdown follows the vehicle, the dates and the tolls */
  if ($('quotePanel')) {
    ['f_carId', 'f_from', 'f_to'].forEach(fid => {
      const el = $(fid);
      if (!el) return;
      el.addEventListener('change', refreshQuotePanel);
      if (el.tagName === 'INPUT') el.addEventListener('input', refreshQuotePanel);
    });
    refreshQuotePanel();
  }

  /* The plate belongs to whichever vehicle is selected, so it has to
     follow the dropdown — otherwise switching the car would leave the
     previous car's number on screen. */
  const carSel = $('f_carId');
  const regBox = $('f_registration');
  if (carSel && regBox) {
    carSel.addEventListener('change', () => {
      const picked = fleet.find(c => c.id === carSel.value);
      regBox.value = (picked && picked.registration) || '—';
    });
  }

  $('sheet').classList.add('open');
  const first = $('sheetFields').querySelector('input:not([type="hidden"]), select');
  if (first) first.focus();
}

function closeSheet() { $('sheet').classList.remove('open'); onSave = null; }

$('sheetCancel').addEventListener('click', closeSheet);
$('sheet').addEventListener('mousedown', e => { if (e.target === $('sheet')) closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

$('sheetForm').addEventListener('submit', e => {
  e.preventDefault();
  if (!onSave) return;
  const err = onSave();
  if (err) { $('sheetError').textContent = err; $('sheetError').hidden = false; return; }
  closeSheet();
});

/* ============================= OVERVIEW =========================== */

const MONTH = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const today = () => new Date().toISOString().slice(0, 10);

const KPI_ICON = {
  fleet: `<svg viewBox="0 0 24 24" ${S}><path d="M5 17h14M4 17v-4l2.5-4.3A2 2 0 0 1 8.2 7.7h7.6a2 2 0 0 1 1.7 1L20 13v4"/><path d="M4 13h16"/><circle cx="7.5" cy="17" r="1.5"/><circle cx="16.5" cy="17" r="1.5"/></svg>`,
  road:  `<svg viewBox="0 0 24 24" ${S}><path d="M4 21 8 3M20 21 16 3M12 4v3M12 11v3M12 18v3"/></svg>`,
  cash:  `<svg viewBox="0 0 24 24" ${S}><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 12h.01M18 12h.01"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" ${S}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`
};

function monthlyRevenue() {
  const live = bookings.filter(b => b.status !== 'Cancelled');
  const buckets = new Map();
  live.forEach(b => {
    const d = new Date(b.from + 'T00:00:00');
    if (isNaN(d)) return;
    const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
    const cur = buckets.get(key) || { label: `${MONTH[d.getMonth()]}`, value: 0, sort: d.getTime() };
    cur.value += bookingTotal(b);
    buckets.set(key, cur);
  });
  /* Walk a continuous six-month window instead of only the months that
     happen to have bookings — a time axis with holes punched out of it
     misrepresents the trend. */
  const end = new Date();
  const latest = Math.max(...[...buckets.values()].map(b => b.sort), end.getTime());
  const cursor = new Date(latest);
  cursor.setDate(1);

  const out = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
    out.push({ label: MONTH[d.getMonth()], value: buckets.get(key)?.value || 0 });
  }
  return out;
}

function renderKPIs() {
  const live = bookings.filter(b => b.status === 'Active' || b.status === 'Confirmed');
  const revenue = bookings.filter(b => b.status !== 'Cancelled').reduce((s, b) => s + bookingTotal(b), 0);
  const rentals = fleet.filter(c => c.type === 'rental');
  const onRoad = bookings.filter(b => b.status === 'Active').length;
  const utilisation = rentals.length ? Math.round((onRoad / rentals.length) * 100) : 0;

  const tiles = [
    ['cash',  money(revenue),        'Booked revenue', `${live.length} active or upcoming`, true],
    ['road',  `${utilisation}%`,     'Fleet utilisation', `${onRoad} of ${rentals.length} rentals out`],
    ['fleet', String(fleet.length),  'Vehicles listed', `${rentals.length} to rent · ${fleet.length - rentals.length} to buy`],
    ['clock', String(bookings.length), 'Bookings on file', `${bookings.filter(b => b.status === 'Cancelled').length} cancelled`]
  ];

  $('kpiRow').innerHTML = tiles.map(([icon, value, label, sub, red]) => `
    <article class="kpi${red ? ' kpi-lead' : ''}">
      <span class="kpi-icon">${KPI_ICON[icon]}</span>
      <b>${esc(value)}</b>
      <span class="kpi-label">${esc(label)}</span>
      <span class="kpi-sub">${esc(sub)}</span>
    </article>`).join('');
}

/* Cars whose renter has given return notice. Releasing one opens it for
   pre-booking, so the next customer can queue before it is even back. */
async function renderReleases() {
  const el = $('releaseList');
  if (!el) return;
  let rows = [];
  try { rows = await loadAwaitingRelease(); }
  catch { el.innerHTML = '<li class="tl-empty">Could not load</li>'; return; }

  el.innerHTML = rows.length ? rows.map(r => {
    const back = r.expected_return_on || r.ends_on;
    const days = r.days_to_return;
    return `
    <li data-slug="${esc(r.slug)}">
      <span class="rl-date">${esc(String(back).slice(5))}</span>
      <span class="rl-lead ${days < NOTICE_DAYS ? 'short' : ''}">${
        days < 0 ? 'overdue' : days + ' days'}</span>
      <span class="rl-who">${esc(r.renter)}</span>
      <span class="rl-car">${esc(r.model_year)} ${esc(r.name)}</span>
      <span class="rl-release-actions">
        <span class="amt-field" data-amt-for="${esc(r.slug)}">
          <span class="amt-dollar">$</span>
          <input type="number" min="0" step="50"
                 class="amt-input">
        </span>
        <button class="btn btn-red btn-sm" data-release-vehicle="${esc(r.slug)}"
                data-back="${esc(back)}">Release</button>
      </span>
    </li>`;
  }).join('') : '<li class="tl-empty">No cars awaiting release</li>';
}

/* ============================= RELEASE ============================= */
/* The whole pre-booking gate in one tab: which cars are out, which have
   given notice, which the office has opened, and who is queued. */

async function renderRelease() {
  initAllRubbers();
  await Promise.all([renderReleases(), renderPrebookingQueue(), renderOnRent()]);
}

/* Every car currently out, with what stage it has reached. */
async function renderOnRent() {
  const el = $('onRentList');
  if (!el) return;

  let rows = [];
  try { rows = await loadBookedVehicles(); }
  catch { el.innerHTML = '<li class="tl-empty">Could not load</li>'; return; }

  /* Headline numbers across the whole list. */
  const stats = $('releaseStats');
  if (stats) {
    const released = rows.filter(r => r.released).length;
    const notice = rows.filter(r => r.noticeGiven && !r.released).length;
    const queued = rows.reduce((n, r) => n + (r.queueLength || 0), 0);
    const paidCount = rows.reduce((n, r) => n + (r.paidCount || 0), 0);
    stats.innerHTML = [
      [rows.length, 'Cars booked'],
      [notice, 'Awaiting release'],
      [released, 'Released'],
      [queued, 'Pre-bookings'],
      [paidCount, 'Payments done']
    ].map(([n, label]) =>
      `<div class="stat"><b${label === 'Awaiting release' && n ? ' class="red"' : ''}>${n}</b><span>${esc(label)}</span></div>`
    ).join('');
  }

  el.innerHTML = rows.length ? rows.map(r => {
    /* Where this car sits in the release flow. */
    const stage = r.released
      ? ['open', 'Released']
      : r.noticeGiven ? ['notice', 'Notice given']
      : ['closed', r.status === 'Active' ? 'On rent' : r.status];

    const contact = [r.email, r.phone].filter(Boolean).join(' · ');
    const amt = r.prebookingAmount != null ? Number(r.prebookingAmount) : 0;

    return `
    <li class="bk-row" data-slug="${esc(r.slug)}">
      <span class="bk-stage ${stage[0]}">${esc(stage[1])}</span>

      <span class="bk-main">
        <b class="bk-customer">${esc(r.customer || 'Customer')}</b>
        <span class="bk-contact">${esc(contact || 'No contact details')}</span>
      </span>

      <span class="bk-car">
        <b>${esc(r.vehicle)}</b>
        <span>${esc(r.reference)}</span>
      </span>

      <span class="bk-dates">
        <b>${esc(r.from)} &rarr; ${esc(r.to)}</b>
        <span>${r.released && r.availableFrom
          ? 'Free from ' + esc(r.availableFrom)
          : r.expectedReturn ? 'Back ' + esc(r.expectedReturn)
          : nightsBetween(r.from, r.to) + ' days'}</span>
      </span>

      <span class="bk-act">
        ${r.released
          ? `<span class="bk-amt">${amt > 0 ? 'Fee: ' + esc(money(amt)) : 'No fee'}</span>
             <button class="btn btn-line btn-sm" data-unrelease="${esc(r.slug)}"
                     title="Close this car to new pre-bookings again">Close pre-booking</button>
             ${r.queueLength ? `<span class="bk-queued">${esc(r.queueLength)} waiting</span>` : ''}`
          : `<span class="amt-field" data-amt-for="${esc(r.slug)}">
               <span class="amt-dollar">$</span>
               <input type="number" min="0" step="50"
                      class="amt-input">
             </span>
             <button class="btn btn-red btn-sm" data-release-vehicle="${esc(r.slug)}"
                     data-back="${esc(r.expectedReturn || r.to)}"
                     title="Open this car for pre-booking on the customer site">Release for pre-booking</button>`}
        <button class="btn btn-line btn-sm bk-free" data-release-normal="${esc(r.slug)}"
                data-ref="${esc(r.reference)}"
                data-customer="${esc(r.customer || '')}"
                data-dates="${esc(r.from)} → ${esc(r.to)}"
                title="The customer never collected this car — cancel the booking and put it back on the site as an ordinary rental"
          >Release car</button>
      </span>
    </li>`;
  }).join('') : '<li class="tl-empty">No cars are booked</li>';
}

/* Who is queued for each released car, in the order they asked.
   Now with customer details, amount, and payment status. */
/* The queue renderer is referred to by both names across this file.
   Defining the short one as an alias keeps every existing call site
   working — several were calling it before it existed, which threw a
   ReferenceError the moment a cash toggle or confirmation ran. */
const renderQueue = () => renderPrebookingQueue();

async function renderPrebookingQueue() {
  const el = $('queueList');
  if (!el) return;
  let rows = [];
  try { rows = await loadPrebookingQueue(); }
  catch { el.innerHTML = '<li class="tl-empty">Could not load</li>'; return; }
  /* Kept so the cash dialog can read this row's reservation fee — it
     is a per-vehicle figure that the booking itself does not carry. */
  queueRows = rows;

  const depth = rows.reduce((m, r) => (m[r.slug] = (m[r.slug] || 0) + 1, m), {});

  el.innerHTML = rows.length ? rows.map(r => {
    const paid = Boolean(r.prebooking_paid);
    const amt = r.prebooking_amount != null ? Number(r.prebooking_amount) : 0;
    const method = r.payment_method || null;

    /* The same green / orange / red the Bookings tab uses, measured
       against the reservation fee rather than the rental total. Only
       confirmed payments count, so an unchecked screenshot leaves the
       row red and says so in the tooltip. */
    const feePaid = Number(r.verified_paid || 0);
    const unchecked = Number(r.unverified_count || 0);
    const scanned = r.proof_scanned_amount != null ? Number(r.proof_scanned_amount) : null;
    const awaiting = unchecked
      ? ` · ${unchecked} screenshot${unchecked > 1 ? 's' : ''} awaiting check`
      : '';
    const feeState =
      paid || (amt > 0 && feePaid + 0.005 >= amt)
        ? { level: 'paid',   title: `Fee paid — ${money(feePaid || amt)} of ${money(amt)}${awaiting}` }
      : feePaid > 0
        ? { level: 'part',   title: `Part paid — ${money(feePaid)} of ${money(amt)}, ${money(amt - feePaid)} short${awaiting}` }
      : amt > 0
        ? { level: 'unpaid', title: `Fee not recorded — ${money(amt)} due${awaiting}` }
        : { level: 'unpaid', title: `No reservation fee set${awaiting}` };
    const proofDot = `<span class="pay-state ${feeState.level}" title="${esc(feeState.title)}"
                            role="img" aria-label="${esc(feeState.title)}"></span>`;
    const contact = [r.email, r.phone].filter(Boolean).join(' · ');
    /* An open return has no agreed hand-back date — the end shown is
       the current month end, so the row says so rather than presenting
       it as a date the customer has committed to. */
    const dates = esc(String(r.starts_on).slice(5)) + ' &rarr; ' + esc(String(r.ends_on).slice(5))
      + (r.open_return ? ' <em class="open-return-tag" title="Open return — billed to month end">open</em>' : '');

    return `
    <li data-ref="${esc(r.reference)}">
      <span class="rl-pos" title="Position in the queue for this car"
        >${esc(r.queue_position)} of ${esc(depth[r.slug])}</span>
      <span class="rl-who">
        <b>${esc(r.customer)}</b>
        <small>${esc(r.license || '—')}</small>
      </span>
      <span class="rl-car">${esc(r.model_year)} ${esc(r.vehicle_name)}<small>${dates}</small></span>
      <span class="rl-contact">${esc(contact)}</span>
      <span class="rl-actions">
        ${proofDot}
        ${(r.proof_count > 0 || unchecked > 0)
          ? (() => {
              /* One button into the same proofs modal the Bookings tab
                 uses. The row can only ever show the latest screenshot,
                 so a customer paying in instalments had the earlier
                 ones hidden — the modal lists every payment, each with
                 its own amount box and confirm tick. */
              const n = Number(r.proof_count || 0);
              const label = unchecked > 0
                ? `Check ${unchecked > 1 ? unchecked + ' payments' : 'payment'}`
                : `Payments${n > 1 ? ` (${n})` : ''}`;
              return `<button class="btn btn-line btn-sm${unchecked > 0 ? ' needs-check' : ''}"
                        data-queue-proofs="${esc(r.reference)}"
                        title="${unchecked > 0
                          ? esc(`${unchecked} payment${unchecked > 1 ? 's' : ''} awaiting confirmation`)
                          : esc(`${n} payment${n > 1 ? 's' : ''} on this reservation`)}"
                      >${label}</button>`;
            })()
          : '<span class="rl-slot"></span>'}
        <span class="rl-amt${paid ? ' paid' : ''}${amt > 0 ? '' : ' is-empty'}"
          >${amt > 0 ? (paid ? 'Paid' : '$' + amt) : '&mdash;'}</span>
        <span class="rl-method">
          <label title="Payment taken in cash at the counter">
            <input type="checkbox" data-cash="${esc(r.reference)}"${method === 'cash' ? ' checked' : ''}>
            Paid by cash
          </label>
          ${method === 'online' ? '<small class="rl-online">Online</small>' : ''}
        </span>
        ${paid
          ? '<span class="pill ok">Payment received</span>'
          : r.confirmation_sent
            ? '<span class="pill under">Under confirmation</span>'
            : `<button class="btn btn-red btn-sm" data-confirm-queue="${esc(r.reference)}"
                     title="Send the under-confirmation message and move this into Bookings"
               >Send confirmation</button>`}
        ${amt > 0 && !paid
          ? `<button class="btn btn-line btn-sm" data-mark-paid="${esc(r.reference)}"
                     title="Record the reservation fee and send this customer to Actions for approval"
               >Payment done</button>`
          : '<span class="rl-slot"></span>'}
      </span>
    </li>`;
  }).join('') : '<li class="tl-empty">Nobody is queued</li>';
}

/* Cash against a reservation fee. Mirrors the Bookings dialog, but the
   figure being settled is the pre-booking fee rather than the rental
   total, and the queue has no Pending column to mirror into. */
async function askQueueCashAmount(ref) {
  let s;
  try {
    s = await bookingSettlement(ref);
  } catch (err) {
    toast(err.message, true);
    return;
  }

  /* The fee is what this row is about; fall back to the booking's own
     total when no fee has been set on the vehicle. */
  const row = (queueRows || []).find(r => r.reference === ref);
  const fee = row && row.prebooking_amount != null ? Number(row.prebooking_amount) : s.due;
  const paid = Number(s.paid || 0);
  const outstanding = Math.max(0, fee - paid);

  const taken = paid > 0 ? ` · already taken ${money(paid)}` : '';
  const awaiting = s.unverified > 0
    ? ` · ${s.unverified} screenshot${s.unverified > 1 ? 's' : ''} not yet checked`
    : '';

  openSheet(
    'Reservation fee received in cash',
    `${ref} — ${money(outstanding)} outstanding of ${money(fee)}${taken}${awaiting}`,
    [{ key: 'qCash', label: 'Amount collected', type: 'number',
       value: '', placeholder: '0.00' }],
    () => {
      const raw = $('f_qCash').value.trim();
      if (raw === '') return 'Enter the amount collected';
      const amount = Number(raw);
      if (!isFinite(amount) || amount < 0) return 'Enter a valid amount';

      (async () => {
        try {
          await addCashPayment(ref, { amount });
          renderQueue();
          renderReleases();
          bookings = await reloadBookings();
          renderBookings();
          toast(`${ref} — ${money(amount)} in cash recorded`);
        } catch (err) {
          toast(err.message, true);
        }
      })();
    }
  );
}

/* When OCR could not read the screenshot there is no figure to agree
   with, so the admin supplies it after looking at the image. */
function askQueueProofAmount(ref, proofId) {
  openSheet(
    'Confirm payment',
    `${ref} — the screenshot could not be read automatically`,
    [{ key: 'qProof', label: 'Amount received', type: 'number',
       value: '', placeholder: '0.00' }],
    () => {
      const raw = $('f_qProof').value.trim();
      if (raw === '') return 'Enter the amount received';
      const amount = Number(raw);
      if (!isFinite(amount) || amount < 0) return 'Enter a valid amount';

      (async () => {
        try {
          await verifyPaymentProof(ref, proofId, { amount });
          renderQueue();
          renderReleases();
          bookings = await reloadBookings();
          renderBookings();
          toast(`${ref} — ${money(amount)} confirmed`);
        } catch (err) {
          toast(err.message, true);
        }
      })();
    }
  );
}

function renderOverview() {
  renderKPIs();

  const rev = monthlyRevenue();
  $('chartRevenue').innerHTML = rev.length
    ? svgColumns({ data: rev, color: VIZ.revenue, format: v => money(v) })
    : `<p class="viz-empty">No bookings yet</p>`;

  $('chartFleet').innerHTML = svgBars({
    data: ['Sedan', 'SUV', 'Truck', 'Luxury'].map(cat => ({
      label: cat, value: fleet.filter(c => categoryOf(c) === cat).length
    })),
    color: VIZ.fleet
  });

  $('chartStatus').innerHTML = svgBars({
    data: STATUSES.map(st => ({
      label: st, value: bookings.filter(b => b.status === st).length, color: VIZ.status[st]
    }))
  });

  /* soonest first, and only what has not already happened */
  const now = today();
  const events = [];
  bookings.filter(b => b.status !== 'Cancelled' && b.status !== 'Completed').forEach(b => {
    const car = fleet.find(c => c.id === b.carId);
    const name = car ? `${car.year} ${car.name}` : 'Vehicle removed';
    if (b.from >= now) events.push({ date: b.from, kind: 'Pick-up', who: b.name, car: name });
    if (b.to >= now) events.push({ date: b.to, kind: 'Return', who: b.name, car: name });
  });
  events.sort((a, b) => a.date.localeCompare(b.date));

  $('timeline').innerHTML = events.length
    ? events.slice(0, 6).map(e => `
      <li>
        <span class="tl-date">${esc(e.date.slice(5))}</span>
        <span class="tl-kind ${e.kind === 'Return' ? 'ret' : ''}">${esc(e.kind)}</span>
        <span class="tl-who">${esc(e.who)}</span>
        <span class="tl-car">${esc(e.car)}</span>
      </li>`).join('')
    : `<li class="tl-empty">Nothing scheduled</li>`;

  initChartTooltips();
  renderReleases();
  renderPrebookingQueue();
}

/* ============================== FLEET ============================= */

function renderFleetStats() {
  const rent = fleet.filter(c => c.type === 'rental');
  const sale = fleet.filter(c => c.type === 'sale');
  const avgMonthly = rent.length
    ? Math.round(rent.reduce((s, c) => s + Number(c.monthlyRate || c.price * 30), 0) / rent.length)
    : 0;

  $('fleetStats').innerHTML = [
    [fleet.length, 'Vehicles total'],
    [rent.length, 'For rent'],
    [sale.length, 'For sale'],
    [money(avgMonthly) + ' / mo', 'Average rental rate', true]
  ].map(([v, label, red]) =>
    `<div class="stat"><b class="${red ? 'red' : ''}">${esc(v)}</b><span>${esc(label)}</span></div>`).join('');

  /* Show the buttons as inactive while a month or year filter is
     driving the window, rather than leaving one lit against figures it
     is not shaping. */
  const live = usePeriodButtons();
  const tabs = document.querySelector('.period-tabs');
  if (tabs) {
    tabs.classList.toggle('is-off', !live);
    tabs.title = live ? '' : 'Cleared by the month and year filters below';
    tabs.querySelectorAll('.period-tab').forEach(b => { b.disabled = !live; });
  }
}

function fleetFiltered() {
  const q = $('fleetSearch').value.trim().toLowerCase();
  const type = $('fleetType').value;
  const cat = $('fleetCat').value;
  return fleet.filter(c => {
    if (type !== 'all' && c.type !== type) return false;
    if (cat !== 'all' && categoryOf(c) !== cat) return false;
    if (!q) return true;
    return [c.name, c.trim, c.location, c.year].join(' ').toLowerCase().includes(q);
  });
}

function renderFleet() {
  const list = fleetFiltered();
  $('fleetRows').innerHTML = list.length ? list.map(c => `
    <tr data-id="${esc(c.id)}">
      <td class="col-main">
        <div class="cell-car">
          <img class="thumb" src="${esc(c.image)}" alt=""
               onerror="this.outerHTML='<span class=\\'thumb-fallback\\'>NO IMAGE</span>'">
          <span>
            <span class="name-cell">${esc(c.year)} ${esc(c.name)}</span>
            <span class="sub">${esc(c.trim)}</span>
          </span>
        </div>
      </td>
      <td data-label="Type"><span class="pill ${esc(c.type)}">${c.type === 'rental' ? 'For rent' : 'For sale'}</span></td>
      <td data-label="Category">${esc(categoryOf(c))}</td>
      <td class="num" data-label="Price">${c.type === 'rental'
        ? money(c.monthlyRate || c.price * 30) +
          `<span class="sub">per month &middot; ${money(Math.round((c.monthlyRate || c.price * 30) / 30))}/day pro-rata</span>`
        : money(c.price)}</td>
      <td data-label="Location">${esc(c.location)}</td>
      <td class="num" style="font-size:13px" data-label="Odometer">${c.type === 'rental'
        ? (c.odometer != null ? Number(c.odometer).toLocaleString('en-US') + '<span class="sub">miles</span>' : '<span class="sub">not set</span>')
        : '<span class="sub">&mdash;</span>'}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-line btn-sm" data-act="edit">Edit</button>
          <button class="btn btn-line btn-sm" data-act="del">Delete</button>
        </div>
      </td>
    </tr>`).join('') : `<tr class="empty-row"><td colspan="7">No vehicles match</td></tr>`;

  $('fleetRows').insertAdjacentHTML('beforeend',
    `<tr class="add-row"><td colspan="7">
       <button class="add-inline" data-add="fleet">${ICONS.plus}Add a vehicle</button>
     </td></tr>`);

  renderFleetStats();
  initAllRubbers();
}

function fleetFields(car) {
  return [
    { key: 'name', label: 'Vehicle name', value: car.name || '', placeholder: 'Tesla Model 3' },
    { key: 'trim', label: 'Trim', value: car.trim || '', placeholder: 'Long Range AWD' },
    { key: 'year', label: 'Year', value: car.year || new Date().getFullYear(), type: 'number' },
    { key: 'type', label: 'Listing type', value: car.type || 'rental', type: 'select', options: ['rental', 'sale'] },
    { key: 'registration', label: 'Vehicle number', value: car.registration || '',
      placeholder: 'AB12 CDE',
      hint: 'UK number plate. Internal only — never shown to customers.' },
    { key: 'fuel', label: 'Fuel type', value: car.fuel || 'Gas', type: 'select',
      options: ['Gas', 'Hybrid', 'Diesel', 'Electric'],
      hint: 'Shown to customers in the vehicle specification.' },
    { key: 'monthlyRate', label: 'Monthly rate (USD)', value: car.monthlyRate ?? '', type: 'number', min: 0,
      hint: 'Part-months bill at this figure divided by 30, times the days used — always 30, even in a 31-day month.' },
    { key: 'odometer', label: 'Current miles', value: car.odometer ?? '', type: 'number', min: 0,
      hint: 'Odometer reading. Shown to customers on cars for sale; kept internal for rentals.' },
    /* The asking price only applies to a sale, but it is the same column
       that carries a rental's day rate, so it stays — relabelled, and
       kept off the top of the form where the day rate used to sit. */
    { key: 'price', label: car.type === 'sale' ? 'Asking price (USD)' : 'Day rate (USD)',
      value: car.price ?? '', type: 'number', min: 0,
      hint: car.type === 'sale'
        ? 'Full asking price for this vehicle.'
        : 'Used as a fallback when no monthly rate is set.' },
    { key: 'body', label: 'Body style', value: car.body || 'Sedan', type: 'select',
      options: ['Sedan', 'SUV', 'Full-Size SUV', 'Coupe', 'Convertible', 'Pickup'],
      hint: 'Drives the category shown on the site.' },
    { key: 'location', label: 'Location', value: car.location || 'Dallas, TX' },
    { key: 'seats', label: 'Seats', value: car.seats ?? 5, type: 'number', min: 1 },
    { key: 'image', label: 'Photo', value: car.image || '', type: 'file', full: true,
      hint: 'Scaled to 1400px and re-encoded as JPEG so it fits in browser storage. Leave it alone to keep the current photo.' }
  ];
}

function editCar(car) {
  const isNew = !car;
  const base = car || { type: 'rental', body: 'Sedan', seats: 5, location: 'Dallas, TX' };

  openSheet(isNew ? 'Add vehicle' : 'Edit vehicle',
    isNew ? 'It appears on the public site as soon as you save.' : `Editing ${base.year || ''} ${base.name || ''}`.trim(),
    fleetFields(base), v => {
      if (!v.name) return 'Vehicle name is required.';
      const price = Number(v.price);
      if (!v.price || isNaN(price) || price < 0) return 'Enter a price of zero or more.';

      /* Plates are written with a space and in capitals ("AB12 CDE"), so
         store them that way however they were typed — otherwise the same
         car reads differently depending on who entered it. Left blank is
         fine; a vehicle may not be registered yet. */
      const registration = String(v.registration || '')
        .toUpperCase().replace(/\s+/g, ' ').trim();
      if (registration && !/^[A-Z0-9 ]{2,16}$/.test(registration)) {
        return 'A vehicle number may only contain letters, numbers and spaces.';
      }

      const patch = {
        name: v.name, trim: v.trim, year: Number(v.year) || new Date().getFullYear(),
        type: v.type, price, body: v.body, location: v.location,
        seats: Number(v.seats) || 5, image: v.image,
        fuel: v.fuel || 'Gas',
        registration,
        monthlyRate: v.monthlyRate === '' ? null : Number(v.monthlyRate),
        odometer: v.odometer === '' ? null : Number(v.odometer)
      };

      const before = JSON.stringify(fleet);

      if (isNew) {
        const taken = fleet.map(c => c.id);
        fleet.push({
          id: slugify(`${patch.name} ${patch.trim}`, taken),
          transmission: 'Automatic', fuel: 'Gasoline', doors: 4,
          economy: '—', drivetrain: '—', engine: '—', power: '—',
          topSpeed: '—', zeroToSixty: '—', color: '—', mileage: '—',
          features: [], description: 'Details to follow.',
          ...patch
        });
      } else {
        Object.assign(car, patch);
      }

      /* Persist to MySQL, then re-read so the table shows what the
         database actually holds rather than what we hoped it would. */
      (async () => {
        try {
          if (isNew) await createVehicle(fleet[fleet.length - 1]);
          else await updateVehicle(car.id, patch);
          fleet = await loadFleet();
          renderFleet();
          toast(isNew ? 'Vehicle added' : 'Vehicle updated');
        } catch (err) {
          fleet = JSON.parse(before);
          renderFleet();
          toast(err.message, true);
        }
      })();
    });
}

$('fleetRows').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  const car = fleet.find(c => c.id === id);
  if (!car) return;

  if (btn.dataset.act === 'edit') return editCar(car);

  if (confirm(`Delete "${car.year} ${car.name}"? This cannot be undone.`)) {
    deleteVehicleApi(id)
      .then(async out => {
        fleet = await loadFleet();
        renderFleet();
        /* a car with bookings is archived, not removed — the booking
           history has to keep pointing at something */
        toast(out.archived
          ? `Archived — ${out.bookings} booking(s) reference it`
          : 'Vehicle deleted');
      })
      .catch(err => toast(err.message, true));
  }
});

$('fleetAdd').addEventListener('click', () => editCar(null));
$('fleetRows').addEventListener('click', e => {
  if (e.target.closest('[data-add="fleet"]')) editCar(null);
});
['fleetSearch', 'fleetType', 'fleetCat'].forEach(id => $(id).addEventListener('input', renderFleet));

$('fleetReset').addEventListener('click', async () => {
  fleet = await loadFleet();
  renderFleet();
  toast('Reloaded from database');
});

$('fleetExport').addEventListener('click', () => {
  downloadCSV('reddy-fleet.csv', [
    ['ID', 'Year', 'Name', 'Trim', 'Type', 'Category', 'Price USD', 'Body', 'Seats', 'Location', 'Image'],
    ...fleetFiltered().map(c => [c.id, c.year, c.name, c.trim, c.type, categoryOf(c),
      c.price, c.body, c.seats, c.location, c.image])
  ]);
  toast('Fleet exported');
});

/* ============================ BOOKINGS ============================ */

const carById = id => fleet.find(c => c.id === id);

/* What the customer owes in total, matching the Total column exactly.
   The advance is a deposit charged ON TOP of the rent (billing.js:
   grandTotal = subtotal + tolls + advance), not money already handed
   over, and pending is a balance carried in — so both are owed. Any
   other definition would put the dot and the dialog at odds with the
   figure the admin is reading in the same row. */
function amountDue(b) {
  /* Rent + tolls + the deposit charged on top. `pending` is deliberately
     NOT added: it is the unpaid remainder of these same charges, not an
     extra one. Including it double-counted — confirming $1,500 against
     $3,895.77 set pending to $2,395.77, which then reappeared in the
     total and reported "$1,500 of $6,291.54". This matches the server's
     settlement(), so the dot and the API can never disagree. */
  return Number(b.total ?? bookingTotal(b))
       + Number(b.tolls || 0)
       + Number(b.advance || 0);
}

/* ---------------------------------------------------------------
   Payment state for the dot beside a booking reference.

     green  — settled: verified payments cover everything owed
     orange — part paid: some verified money has arrived, but less
              than the amount due
     red    — nothing recorded yet (the default)

   Only VERIFIED payments count toward the total. An uploaded screenshot
   that OCR has read but nobody has confirmed leaves the booking red,
   because a misread receipt must never make a debt look settled. The
   dot says so in its tooltip rather than silently ignoring the scan.

   Cash and online payments are rows in one ledger, so a booking part
   paid each way adds up. Cash is not treated as "settled" on its own:
   it now carries an amount like any other payment, and $200 handed
   over against $2,000 owed is a part payment whichever way it arrived.
--------------------------------------------------------------- */
/* What to CALL a booking's status on screen.

   "Prebooked" is the stored status for every request awaiting approval,
   because the queue, the filters and availability all key off it. But
   the word only means something when the car was actually opened for
   pre-booking: a customer booking a freely available car was being
   shown as "Prebooked", which reads as though they had queued for a
   car somebody else still has.

   So the status is renamed for display only — nothing about the
   booking changes. */
function statusLabel(b) {
  if (b.status === 'Prebooked' && !b.carReleased) return 'Booked';
  return b.status;
}

function paymentState(b) {
  const due = amountDue(b);
  const paid = Number(b.verifiedPaid || 0);
  const pendingUnverified = Number(b.unverifiedCount || 0);

  /* A booking with nothing owed is settled by definition; without this
     a $0 booking would sit red forever with no way to clear it. */
  if (due <= 0 && paid <= 0) {
    return { level: 'paid', title: 'Nothing owed on this booking' };
  }

  const awaiting = pendingUnverified
    ? ` · ${pendingUnverified} screenshot${pendingUnverified > 1 ? 's' : ''} awaiting check`
    : '';

  if (paid <= 0) {
    return {
      level: 'unpaid',
      title: `No payment recorded — ${money(due)} due${awaiting}`
    };
  }
  if (paid + 0.005 < due) {
    return {
      level: 'part',
      title: `Part paid — ${money(paid)} of ${money(due)}${split(b)}, ${money(due - paid)} short${awaiting}`
    };
  }
  return {
    level: 'paid',
    title: `Paid in full — ${money(paid)} of ${money(due)}${split(b)}${awaiting}`
  };
}

/* " (x cash, y online)" — only when money genuinely came both ways,
   so the common single-channel case stays uncluttered. */
function split(b) {
  const cash = Number(b.paidCash || 0);
  const online = Number(b.paidOnline || 0);
  return cash > 0 && online > 0
    ? ` (${money(cash)} cash, ${money(online)} online)`
    : '';
}

function bookingTotal(b) {
  const car = carById(b.carId);
  if (!car) return 0;
  return car.type === 'rental' ? Number(car.price || 0) * nightsBetween(b.from, b.to) : Number(car.price || 0);
}

/* Which period the Bookings figures cover. One row of numbers, re-cut
   by the buttons above it, rather than three rows saying the same
   things about different windows. */
let statsPeriod = 'all';

/* The window a period covers, as [from, to]. Bookings are placed by
   PICK-UP date: a rental can span a month boundary, but the office
   counts it when it was taken, and splitting one booking's value
   across two months would make neither figure match the list below. */
function periodWindow(period) {
  const now = new Date();
  /* The last day of the month we are in. Both windows end here: the
     year figure is "January through this month", not the whole
     calendar year, so it cannot include business that has not been
     done yet. Whole months, so a booking taken on the 30th is not
     dropped from a report run on the 27th. */
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  if (period === 'year') {
    return [new Date(now.getFullYear(), 0, 1), monthEnd];
  }
  if (period === 'month') {
    return [new Date(now.getFullYear(), now.getMonth(), 1), monthEnd];
  }
  return [null, null];          /* all time */
}

function inPeriod(b, period) {
  const [from, to] = periodWindow(period);
  if (!from) return true;
  const d = new Date(String(b.from) + 'T00:00:00');
  return !isNaN(d) && d >= from && d <= to;
}

$('pendingSearch').addEventListener('input', renderPending);
$('pendingStatus').addEventListener('change', renderPending);
$('pendingReload').addEventListener('click', async () => {
  bookings = await reloadBookings();
  renderPending();
  toast('Reloaded');
});

/* One row per outstanding booking, in the order the office chases. */
$('pendingExport').addEventListener('click', () => {
  const rows = pendingRows();
  if (!rows.length) return toast('Nothing outstanding to export');
  const head = ['Reference', 'Customer', 'Email', 'Phone', 'Vehicle',
                'From', 'To', 'Status', 'Due', 'Paid', 'Pending'];
  const body = rows.map(({ b, due, paid, owed }) => [
    b.id, b.name || '', b.email || '', b.phone || '',
    [b.vehicleYear, b.vehicleName].filter(Boolean).join(' '),
    b.from, b.to, b.status,
    due.toFixed(2), paid.toFixed(2), owed.toFixed(2)
  ]);
  downloadCSV('pending-payments', [head, ...body]);
});

/* ------------------------------------------------------------------
   Pending list — who still owes money.

   Built from the same amountDue() and verifiedPaid the Bookings tab
   uses, so a balance here always matches the row there. Cancelled
   bookings owe nothing; a booking whose verified payments cover its
   total simply drops off.
------------------------------------------------------------------- */

function pendingRows() {
  const q = ($('pendingSearch').value || '').trim().toLowerCase();
  const status = $('pendingStatus').value;

  return bookings
    .filter(b => b.status !== 'Cancelled')
    .map(b => {
      const due = amountDue(b);
      const paid = Number(b.verifiedPaid || 0);
      return { b, due, paid, owed: Math.round((due - paid) * 100) / 100 };
    })
    /* A cent of rounding noise is not a debt. */
    .filter(r => r.owed >= 0.01)
    .filter(r => status === 'all' || r.b.status === status)
    .filter(r => !q || [r.b.id, r.b.name, r.b.email, r.b.phone, r.b.licenseNumber]
      .filter(Boolean).join(' ').toLowerCase().includes(q))
    /* Largest balance first: that is the order the office chases in. */
    .sort((x, y) => y.owed - x.owed);
}

function renderPending() {
  const rows = pendingRows();

  const totalOwed = rows.reduce((s, r) => s + r.owed, 0);
  const customers = new Set(rows.map(r => (r.b.email || r.b.phone || r.b.name || r.b.id))).size;

  $('pendingStats').innerHTML = [
    [String(rows.length), 'Bookings pending'],
    [String(customers), 'Customers'],
    [money(totalOwed), 'Total outstanding', totalOwed > 0]
  ].map(([v, label, red]) =>
    `<div class="stat"><b class="${red ? 'red' : ''}">${esc(v)}</b><span>${esc(label)}</span></div>`).join('');

  const body = $('pendingRows');
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9" style="padding:30px;text-align:center;color:var(--text-3)">
      Nothing outstanding &mdash; every booking is settled.</td></tr>`;
    return;
  }

  body.innerHTML = rows.map(({ b, due, paid, owed }) => {
    const vehicle = [b.vehicleYear, b.vehicleName].filter(Boolean).join(' ')
                 || carById(b.carId)?.name || '&mdash;';
    /* Nothing paid at all reads differently from a part payment, so it
       is marked rather than shown as another number. */
    const paidCell = paid > 0 ? money(paid)
      : '<span class="pend-none">Nothing paid</span>';

    return `<tr>
      <td data-label="Ref"><button class="ref-link" data-act="pend-ref" type="button"
            data-ref="${esc(b.id)}"
            title="Contact, referral and every payment received">${esc(b.id)}</button></td>
      <td data-label="Customer">${esc(b.name || '')}</td>
      <td data-label="Contact" class="contact-cell">
        ${b.email ? `<span>${esc(b.email)}</span>` : ''}
        ${b.phone ? `<small>${esc(b.phone)}</small>` : ''}
      </td>
      <td data-label="Vehicle">${esc(vehicle)}</td>
      <td data-label="Dates" style="white-space:nowrap">${esc(b.from)} &ndash; ${esc(b.to)}</td>
      <td data-label="Status"><span class="pill ${esc(String(b.status).toLowerCase())}">${esc(b.status)}</span></td>
      <td class="num" data-label="Due">${money(due)}</td>
      <td class="num" data-label="Paid">${paidCell}</td>
      <td class="num" data-label="Pending"><b class="red">${money(owed)}</b></td>
    </tr>`;
  }).join('');

  /* The reference opens the same detail sheet the Bookings tab uses,
     so a balance can be chased without changing tabs to find the
     customer's number. */
  body.querySelectorAll('button[data-act="pend-ref"]').forEach(btn => {
    btn.addEventListener('click', () => openRefSheet(btn.dataset.ref));
  });
}

/* The period buttons are only meaningful while the table is unfiltered
   by date. Once a month or year is picked, that IS the window. */
function usePeriodButtons() {
  const month = $('bookMonth');
  const year = $('bookYear');
  return (!month || month.value === 'all') && (!year || year.value === 'all');
}

function renderBookingStats() {
  /* The figures describe whatever the table below is showing.

     The month, year and status filters used to move the table while
     the headline numbers stayed on the whole book, so picking "June"
     gave a short list under a total that still counted every booking —
     two different answers on one screen. Reading the same filtered
     list means they cannot disagree.

     The period buttons narrow it further, and are disabled while a
     month or year filter is set, since that filter has already chosen
     the window. */
  const filtered = bookingsFiltered();
  const scope = usePeriodButtons()
    ? filtered.filter(b => inPeriod(b, statsPeriod))
    : filtered;
  const live = scope.filter(b => b.status === 'Active' || b.status === 'Confirmed');

  /* A cancelled booking owes nothing and earns nothing, so it is out of
     every money figure below — but it still counts as a booking. */
  const billable = scope.filter(b => b.status !== 'Cancelled');

  /* What the office is owed in total, built from amountDue() — the same
     function the table rows use, so a figure here can never disagree
     with the column beside it.

     It follows edits: amountDue() reads b.total and b.tolls off the
     booking, so changing a toll or adjusting a total moves this number
     with it. The old figure recomputed rent from the car's list price
     and ignored both, which is why an edited booking never showed up
     in the header. */
  const due = billable.reduce((sum, b) => sum + amountDue(b), 0);

  /* What has actually arrived: verified payments only. Money someone
     has claimed to send but nobody has checked is not revenue. */
  const received = billable.reduce((sum, b) => sum + Number(b.verifiedPaid || 0), 0);

  /* The shortfall, floored at zero — an overpayment is not a debt. */
  const outstanding = Math.max(0, due - received);

  /* Counts first, then the two money figures, with the booking count
     sitting directly beside them: "5 bookings, $5,100 to receive,
     $0 received" reads as one sentence across the row. */
  $('bookingStats').innerHTML = [
    [scope.filter(b => b.status === 'Active').length, 'On the road now'],
    [live.length, 'Active + upcoming'],
    [scope.length, 'Total bookings'],
    [money(due), 'Amount to receive', outstanding > 0],
    [money(received), 'Total revenue']
  ].map(([v, label, red]) =>
    `<div class="stat"><b class="${red ? 'red' : ''}">${esc(v)}</b><span>${esc(label)}</span></div>`).join('');
}

/* Every year-month a booking touches, as y*12+m numbers. A rental from
   Aug 12 to Sep 30 covers two buckets, so it shows up in both the August
   and September reports instead of only the month it started in. */
function monthsCovered(b) {
  const from = new Date(b.from + 'T00:00:00');
  const to = new Date(b.to + 'T00:00:00');
  if (isNaN(from) || isNaN(to)) return [];
  const out = [];
  let cur = new Date(from.getFullYear(), from.getMonth(), 1);
  const end = new Date(to.getFullYear(), to.getMonth(), 1);
  while (cur <= end) {
    out.push(cur.getFullYear() * 12 + cur.getMonth());
    cur.setMonth(cur.getMonth() + 1);
  }
  return out;
}

function bookingInPeriod(b, month, year) {
  const covered = monthsCovered(b);
  if (!covered.length) return false;
  if (month !== 'all' && year !== 'all') {
    return covered.includes(Number(year) * 12 + (Number(month) - 1));
  }
  if (month !== 'all') {
    const m = Number(month) - 1;
    return covered.some(ym => ym % 12 === m);
  }
  const y = Number(year);
  return covered.some(ym => Math.floor(ym / 12) === y);
}

/* Cumulative "everything up to and including the selected period". The
   booking counts if it touches the selected month OR any earlier one —
   so with August selected it shows August starts, longer rentals running
   into August, and anything booked before that. */
function bookingBeforeOrIn(b, month, year) {
  const covered = monthsCovered(b);
  if (!covered.length) return false;
  const target = Number(year) * 12 + (Number(month) - 1);
  return Math.min(...covered) <= target;
}

/* A booking is finished once its return date has passed, whether or not
   anyone has marked it Completed — the office should not have to close
   every rental by hand for the lists to stay true.

   It lingers in the live lists for one day after the return date, so a
   car handed back this morning is still in front of the admin while
   they settle tolls or take a final payment. From the day after that it
   belongs in Completed only. A booking the admin has already marked
   Completed is finished from that moment, date notwithstanding. */
function isFinished(b) {
  if (b.status === 'Completed') return true;
  if (b.status === 'Cancelled') return false;   /* cancelled has its own filter */
  if (b.openReturn) return false;               /* no agreed end date yet */
  if (!b.to) return false;

  const end = new Date(b.to + 'T00:00:00');
  if (Number.isNaN(end.getTime())) return false;

  /* The grace day: still live through the day after the return date. */
  const cutoff = new Date(end.getTime() + 86400000);
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return todayMidnight > cutoff;
}

function bookingsFiltered() {
  const q = $('bookSearch').value.trim().toLowerCase();
  const status = $('bookStatus').value;
  const month = $('bookMonth').value;
  const year = $('bookYear').value;
  const allMode = bookAllActive && month !== 'all';
  return bookings.filter(b => {
    /* Bookings holds cars that have actually been handed over.

       A request arrives Prebooked and is worked in Actions: the
       envelope confirms it and sends the pick-up details, which makes
       it Confirmed and opens the customer's photo uploads. It stays
       in Actions through all of that. Only when the car is collected
       and the photos are in does the tick mark it Active — and that
       is what moves it here.

       Selecting a status explicitly still shows those rows, for
       looking something up rather than working the queue. */
    const inActions = b.status === 'Prebooked' || b.status === 'Confirmed';
    if (inActions && status !== b.status) return false;

    /* "Completed" collects everything finished, including bookings whose
       return date has passed but which nobody marked closed. Every other
       view hides those, so a finished rental stops cluttering the live
       list a day after the car came back. */
    if (status === 'Completed') {
      if (!isFinished(b)) return false;
    } else if (status === 'all') {
      if (isFinished(b)) return false;
    } else if (b.status !== status) {
      return false;
    }
    if (allMode) {
      if (year !== 'all') {
        if (!bookingBeforeOrIn(b, month, year)) return false;
      } else {
        /* month only — match any year whose month is <= the selected one */
        const target = Number(month) - 1;
        const covered = monthsCovered(b);
        if (!covered.some(ym => ym % 12 <= target)) return false;
      }
    } else if ((month !== 'all' || year !== 'all') && !bookingInPeriod(b, month, year)) {
      return false;
    }
    if (!q) return true;
    return [b.id, b.name, b.email, b.phone, b.licenseNumber || ''].join(' ').toLowerCase().includes(q);
  });
}

/* Prorated amount a booking contributes to ONE calendar month, using the
   existing monthly billing rule (monthly rate / 30 per day — DIVISOR is
   always 30). A rental 12 Aug -> 30 Oct seen through August is:
   (rate / 30) x number of nights the booking occupies August. If no
   specific month is selected, or the booking has no overlap with it, this
   returns null. */
function bookingMonthAmount(b, car, month, year) {
  if (month === 'all') return null;
  const m = Number(month) - 1;
  const y = year === 'all' ? null : Number(year);

  /* does this booking touch the selected (month[, year]) at all? */
  if (!bookingInPeriod(b, month, year)) return null;

  if (car && car.type === 'sale') {
    return b.total ?? bookingTotal(b);
  }

  const from = new Date(b.from + 'T00:00:00');
  const to = new Date(b.to + 'T00:00:00');
  const monthBegin = new Date(y ?? from.getFullYear(), m, 1, 0, 0, 0);
  const monthEndExcl = new Date(monthBegin.getFullYear(), m + 1, 1, 0, 0, 0);

  /* nights the booking spends inside the selected month */
  const a = from < monthBegin ? monthBegin : from;
  const z = to >= monthEndExcl ? monthEndExcl : new Date(to.getTime() + 86400000);
  const occupied = Math.max(0, Math.round((z - a) / 86400000));
  if (!occupied) return null;

  /* A fixed-return rental is a whole month at the monthly rate — it
     simply does not line up with the calendar. Splitting it made a
     single $3,770 rental read as $377 in September and $3,518.67 in
     October, so the column showed two figures for one charge and
     neither matched the rent. The month it BEGINS in carries it.

     Only an open return is genuinely pro-rated: there the customer is
     billed to month end, so part-months are the real arrangement. */
  if (!b.openReturn) {
    const startsHere = from >= monthBegin && from < monthEndExcl;
    return startsHere ? round2(Number(b.total ?? bookingTotal(b))) : null;
  }

  const rate = Number(b.monthlyRate) > 0 ? Number(b.monthlyRate)
    : round2((car && car.price ? Number(car.price) : 0) * DIVISOR);
  return round2((rate / DIVISOR) * occupied);
}

/* The booking behind a Ref: who it is for, who referred them, and every
   payment received against it.

   The columns can only ever show one figure for Paid, which hides the
   shape of how a customer actually settled — $900 cash on the 21st and
   $400 online on the 28th read as "$1,300". The office needs the dates
   and the channel when a renter queries their balance, so this lists the
   ledger rows themselves, newest last, the way a statement reads. */
/* A row of condition photos for the Ref sheet. The five fixed angles
   are labelled; clicking one opens the same full-screen viewer the
   Photos tab uses. */
function photoStrip(items, emptyText) {
  if (!items || !items.length) return `<p class="pay-empty">${esc(emptyText)}</p>`;
  return `<div class="ref-shots">` + items.map(p => {
    const src = photoUrl(p.src);
    const label = PHOTO_LABELS[p.type] || p.type || '';
    return `<button type="button" class="ref-shot" onclick="openFullImage('${esc(src)}')">
        <img src="${esc(src)}" alt="${esc(label)}" loading="lazy">
        <span>${esc(label)}</span>
      </button>`;
  }).join('') + `</div>`;
}

/* Damage photos carry the renter's own note, which is the point of
   them — "scratch on rear bumper" is what the office is reading. */
function damageStrip(items) {
  if (!items || !items.length) {
    return '<p class="pay-empty">No damage reported.</p>';
  }
  return `<div class="ref-shots">` + items.map(d => {
    const src = photoUrl(d.src);
    const when = d.stage === 'return' ? 'At return' : 'At pick-up';
    const note = d.note ? d.note : when;
    return `<button type="button" class="ref-shot" onclick="openFullImage('${esc(src)}')"
              title="${esc(note)}">
        <img src="${esc(src)}" alt="${esc(note)}" loading="lazy">
        <span>${esc(note)}</span>
      </button>`;
  }).join('') + `</div>`;
}

/* uploads/ is closed to direct URLs, so images come through the
   guarded route rather than their filesystem path. */
function photoUrl(storedPath) {
  /* Stored paths use whichever separator the server's OS produced. */
  const name = String(storedPath || '').split(/[/\\]/).pop();
  return '/api/booking-image/' + encodeURIComponent(name);
}

async function openRefSheet(ref) {
  let detail;
  try {
    detail = await request(`/bookings/${encodeURIComponent(ref)}/detail`);
  } catch (err) {
    toast(err.message || 'Could not load the booking', true);
    return;
  }

  const dateLabel = iso => {
    if (!iso) return 'Date not recorded';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toLocaleDateString('en-US',
      { day: 'numeric', month: 'long', year: 'numeric' });
  };

  const rows = detail.payments.map(p => `
    <div class="pay-entry${p.verified ? '' : ' is-unverified'}">
      <div class="pay-entry-top">
        <span class="pay-entry-date">${esc(dateLabel(p.date))}</span>
        <b class="pay-entry-amt">${esc(money(p.amount))}</b>
      </div>
      <div class="pay-entry-sub">
        <span class="pay-chip ${p.method}">${p.method === 'cash' ? 'Cash' : 'Online'}</span>
        ${p.verified ? '' : '<span class="pay-chip pending">Awaiting confirmation</span>'}
        ${p.note ? `<span class="pay-entry-note">${esc(p.note)}</span>` : ''}
      </div>
    </div>`).join('');

  const settled = detail.payments
    .filter(p => p.verified)
    .reduce((n, p) => n + Number(p.amount || 0), 0);

  const pics = detail.photos || { pickup: [], return: [], damage: [] };

  const list = detail.payments.length
    ? `${rows}<div class="pay-entry pay-entry-total">
         <div class="pay-entry-top">
           <span class="pay-entry-date">Total received</span>
           <b class="pay-entry-amt">${esc(money(settled))}</b>
         </div>
       </div>`
    : '<p class="pay-empty">No payments recorded yet.</p>';

  openSheet(ref, detail.name || 'Booking', [
    { key: 'customer', label: 'Customer', value: detail.name || '—', readOnly: true },
    { key: 'license', label: 'License', value: detail.licenseNumber || '—', readOnly: true },
    /* Email and phone each get their own line — joined into one field
       the address clipped at the box edge and could not be read. */
    { key: 'email', label: 'Email', value: detail.email || '—', readOnly: true },
    { key: 'phone', label: 'Phone', value: detail.phone || '—', readOnly: true },
    /* The collection time agreed with the renter. The contract's detail
       table is headed "PICKUP DATE & TIME" and has printed the date
       alone until now, because nothing recorded the hour. */
    {
      key: 'pickupTime', label: 'Pickup time', type: 'clock',
      value: detail.pickupTime || '',
      hint: detail.pickupDate ? `Collection on ${detail.pickupDate}` : ''
    },
    { key: 'referralName', label: 'Referral name', value: detail.referralName || '' },
    { key: 'referralPhone', label: 'Referral phone', value: detail.referralPhone || '' },
    { key: 'payments', label: 'Payments received', type: 'html', full: true, html: list },
    /* The condition photos, beside the money. The office checks both
       in the same pass, so sending them to the Photos tab to see the
       car broke that. */
    { key: 'pickupPhotos', label: 'Pick-up photos', type: 'html', full: true,
      html: photoStrip(pics.pickup, 'No pick-up photos uploaded yet.') },
    { key: 'returnPhotos', label: 'Return photos', type: 'html', full: true,
      html: photoStrip(pics.return, 'No return photos uploaded yet.') },
    { key: 'damagePhotos', label: 'Damage photos', type: 'html', full: true,
      html: damageStrip(pics.damage) }
  ], async v => {
    /* Only the referral is editable; the rest is shown for reference. */
    await request(`/bookings/${encodeURIComponent(ref)}/referral`, {
      method: 'POST',
      body: JSON.stringify({
        name: v.referralName,
        phone: v.referralPhone,
        pickupTime: v.pickupTime
      })
    });

    /* Keep the in-memory booking in step so reopening the popup shows
       what was just saved rather than the stale value, and repaint the
       tables that display it. */
    const bk = bookings.find(b => b.id === ref);
    if (bk) {
      bk.referralName = v.referralName;
      bk.referralPhone = v.referralPhone;
      bk.pickupTime = v.pickupTime;
    }
    renderActions();
    renderBookings();
    toast('Saved');
  });
}

function renderBookings() {
  syncBookingYearFilter();
  const list = bookingsFiltered();
  const month = $('bookMonth').value;
  const year = $('bookYear').value;
  $('bookRows').innerHTML = list.length ? list.map(b => {
    const car = carById(b.carId);
    const contact = [b.email, b.phone].filter(Boolean);
    const monthAmt = bookingMonthAmount(b, car, month, year);
    return `
    <tr data-id="${esc(b.id)}">
      <td class="num" style="font-size:13px" data-label="Ref">${(() => {
        const pay = paymentState(b);
        return `<span class="pay-state ${pay.level}" title="${esc(pay.title)}"
                      role="img" aria-label="${esc(pay.title)}"></span>`;
      })()}<button class="ref-link" data-act="ref" type="button"
              title="Contact, referral and every payment received">${esc(b.id)}</button></td>
      <td data-label="Customer"><span class="name-cell">${esc(b.name)}</span><span class="sub">Booked ${esc(b.created || '—')}</span></td>
      <td data-label="Contact">${contact.length
            ? `${esc(contact[0])}${contact[1] ? `<span class="sub">${esc(contact[1])}</span>` : ''}`
            : '<span class="sub">Not given</span>'}</td>
      <td data-label="License">${b.licenseNumber ? esc(b.licenseNumber) : '<span class="sub">&mdash;</span>'}</td>
      <td data-label="Vehicle">${car ? `${esc(car.year)} ${esc(car.name)}` : '<span class="sub">Vehicle removed</span>'}</td>
      <td data-label="From">${esc(b.from)}</td>
      ${/* A return notice the customer has filed is the office's cue to
            plan the handover and the next booking, so it is stated here
            rather than only in the Release tab. */''}
      <td data-label="To">${b.returnNoticeGivenAt
        ? `<span class="return-notice" title="The customer gave notice on ${esc(String(b.returnNoticeGivenAt).slice(0, 10))} that the car comes back on ${esc(b.expectedReturnOn || b.to)}.">${esc(b.expectedReturnOn || b.to)}<small>Notice given</small></span>`
        : b.openReturn
        ? `<span class="open-return" title="Open return — the customer has not fixed a return date. Rent is billed to the end of the month; ${esc(b.to)} is the current month end, not an agreed hand-back.">${esc(b.to)}<small>Open return</small></span>`
        : esc(b.to)}</td>
      <td class="num" style="font-size:13px" data-label="Days">${car && car.type === 'sale' ? '&mdash;' : nightsBetween(b.from, b.to)}</td>
      <td class="num" data-label="Rental">${money(b.total ?? bookingTotal(b))}</td>
      <td class="num toll-cell" data-label="Tolls">
        <input type="number" min="0" step="0.01" inputmode="decimal"
               class="toll-input" data-toll="${esc(b.id)}"
               value="${b.tolls || ''}" placeholder="0.00"
               title="Enter tolls for this booking">
        ${/* Tolls are billed on their own, monthly. The rental invoice
             goes out when the car is collected, before any toll
             exists, so this sends a separate statement covering the
             month just gone. */''}
        <button class="toll-send" data-toll-invoice="${esc(b.id)}"
                title="${Number(b.tolls || 0) > 0
                  ? (b.email ? esc('Email a toll statement for ' + money(b.tolls) + ' to ' + b.email)
                             : 'No email address on file')
                  : 'No tolls recorded yet'}"
                ${Number(b.tolls || 0) > 0 && b.email ? '' : 'disabled'}
          >Send toll bill</button>
      </td>
      <!-- The Advance column lives in the Actions tab, where a booking is
           reviewed before approval. The figure still counts toward Total,
           Pending and the invoice; it is only edited elsewhere. -->
      <td class="num" data-label="Total">${money(amountDue(b))}</td>
      <td class="num" data-label="Paid">${(() => {
        /* What has actually come in. A customer may settle in several
           instalments — clicking opens the full list rather than
           leaving one figure to stand for all of them. */
        const paid = Number(b.verifiedPaid || 0);
        const n = Number(b.paidCount || 0);
        if (!paid) return '<span class="sub">&mdash;</span>';
        /* The reservation fee is itself a cash or online payment, so
           listing it alongside those totals would count it twice. It
           is called out separately and netted off the channel it came
           through. */
        const fee = Number(b.prebookingPaid || 0);
        const cash = Number(b.paidCash || 0);
        const online = Number(b.paidOnline || 0);
        const bits = [];
        if (fee > 0) bits.push(`${money(fee)} reservation fee`);
        const restCash = Math.max(0, cash - (online > 0 ? 0 : fee));
        const restOnline = Math.max(0, online - (online > 0 ? fee : 0));
        if (restCash > 0) bits.push(`${money(restCash)} cash`);
        if (restOnline > 0) bits.push(`${money(restOnline)} online`);
        const title = `${n} payment${n > 1 ? 's' : ''}: ${bits.join(' + ')}`;
        return `<button class="paid-cell" data-act="proof" title="${esc(title)}"
                >${money(paid)}${n > 1 ? `<small>${n}&nbsp;payments</small>` : ''}</button>`;
      })()}</td>
      <td class="num toll-cell" data-label="Pending">
        <input type="number" min="0" step="0.01" inputmode="decimal"
               class="toll-input${b.pending ? ' has-pending' : ''}" data-pending="${esc(b.id)}"
               value="${b.pending || ''}" placeholder="0.00"
               title="Unpaid balance carried into the next month">
      </td>
      <td class="num" data-label="Month">${monthAmt === null ? '<span class="sub">&mdash;</span>' : money(monthAmt)}</td>
      <td data-label="Status">
        <span class="pill ${esc(b.status)}">${esc(statusLabel(b))}</span>
        ${b.status === 'Prebooked' && b.leadDays != null && b.leadDays < NOTICE_DAYS
          ? `<span class="pill short" title="Days between the request and the pick-up date">${b.leadDays < 0 ? 'Pick-up passed' : b.leadDays === 0 ? 'Today' : b.leadDays === 1 ? 'Tomorrow' : b.leadDays + ' days ahead'}</span>` : ''}
        <label class="cash-toggle" title="Payment taken in cash at the counter">
          <input type="checkbox" data-cash="${esc(b.id)}"${b.paymentMethod === 'cash' || b.paymentMethod === 'mixed' ? ' checked' : ''}>
          Paid by cash
        </label>
        ${/* 'mixed' means money came both ways, so the tick AND the label
             belong. Testing only for 'online' here left a part-cash,
             part-transfer booking showing neither, which read as though
             nothing had been recorded at all. */''}
        ${b.paymentMethod === 'online' || b.paymentMethod === 'mixed'
          ? '<small class="rl-online" title="A payment screenshot has been confirmed for this booking">Online</small>'
          : ''}
      </td>
      <td>
        <div class="row-actions">
          <button class="btn btn-line btn-sm" data-act="invoice"
                  title="${b.email ? 'Email the invoice to ' + esc(b.email) : 'No email address on file'}"
                  ${b.email ? '' : 'disabled'}>Invoice</button>
          <button class="btn btn-line btn-sm" data-act="edit">Edit</button>
          <button class="btn btn-line btn-sm" data-act="del">Delete</button>
          ${(() => {
            /* Proof of payment the customer sent in. Only shown when
               there is something to look at, so the row stays quiet
               until money is actually claimed. */
            const n = (paymentProofCount[b.id] || {}).count || 0;
            return n
              ? `<button class="btn btn-line btn-sm has-proof" data-act="proof"
                         title="View ${n} payment proof${n > 1 ? 's' : ''} from the customer">
                   Payment ${n > 1 ? `(${n})` : ''}
                 </button>`
              : '';
          })()}
        </div>
      </td>
    </tr>`;
  }).join('') : `<tr class="empty-row"><td colspan="16">No bookings match</td></tr>`;

  $('bookRows').insertAdjacentHTML('beforeend',
    `<tr class="add-row"><td colspan="16">
       <button class="add-inline" data-add="booking">${ICONS.plus}Add a booking</button>
     </td></tr>`);

  renderBookingStats();
  initAllRubbers();
}

/* The figures the breakdown needs that are no longer fields on the
   sheet. Set when a booking sheet opens. */
let quoteContext = { tolls: 0, advance: null };

/* Shows the month-by-month working inside the booking sheet, so the
   admin can see exactly how a total was reached before saving. */
async function refreshQuotePanel() {
  const panel = $('quotePanel');
  if (!panel) return;
  const carId = $('f_carId')?.value;
  const from = $('f_from')?.value;
  const to = $('f_to')?.value;
  /* Tolls and the advance left this form, so the breakdown takes them
     from the booking being edited. Without this the panel would quote
     zero tolls and a default advance, contradicting the table beside it. */
  const tolls = Number(quoteContext.tolls) || 0;
  const advance = quoteContext.advance === undefined || quoteContext.advance === null
    ? null : Number(quoteContext.advance);
  if (!carId || !from || !to) { panel.innerHTML = ''; return; }

  try {
    const q = await quoteBooking({ carId, from, to, tolls, advance, openReturn: true });
    panel.innerHTML = `
      <table class="quote-table">
        <tbody>
          ${q.lines.map(l => `
            <tr>
              <td>${esc(l.label)}</td>
              <td class="q-days">${l.days ? l.days + 'd' : ''}</td>
              <td class="q-note">${esc(l.note)}</td>
              <td class="q-amt">${money(l.amount)}</td>
            </tr>`).join('')}
          ${q.tolls ? `<tr><td>Tolls</td><td></td><td class="q-note">Collected after the ride</td>
                       <td class="q-amt">${money(q.tolls)}</td></tr>` : ''}
          ${q.advance ? `<tr><td>Advance</td><td></td><td class="q-note">Deposit collected up front</td>
                       <td class="q-amt">${money(q.advance)}</td></tr>` : ''}
          <tr class="q-total"><td colspan="3">Total payable</td>
              <td class="q-amt">${money(q.grandTotal != null ? q.grandTotal : q.total)}</td></tr>
        </tbody>
      </table>`;
  } catch (err) {
    panel.innerHTML = `<p class="q-err">${esc(err.message)}</p>`;
  }
}

function editBooking(bk) {
  const isNew = !bk;
  const base = bk || { status: 'Confirmed', from: new Date().toISOString().slice(0, 10),
                       to: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
                       carId: fleet[0] && fleet[0].id };

  /* The breakdown needs these, and they are no longer fields on the form. */
  quoteContext = { tolls: base.tolls ?? 0, advance: base.advance ?? null };

  openSheet(isNew ? 'Add booking' : `Booking ${base.id}`,
    isNew ? 'Record a reservation taken by phone or in person.' : `Customer: ${base.name}`,
    [
      { key: 'name', label: 'Customer name', value: base.name || '', full: true },
      { key: 'email', label: 'Email', value: base.email || '', type: 'email', placeholder: 'name@example.com' },
      { key: 'phone', label: 'Phone', value: base.phone || '', placeholder: '(214) 555-0100' },
      { key: 'license', label: 'Driver license no.', value: base.licenseNumber || '', placeholder: 'e.g. TX12345678' },
      { key: 'carId', label: 'Vehicle', value: base.carId || '', type: 'select',
        options: fleet.map(c => ({ value: c.id,
          label: `${c.year} ${c.name} ${c.trim} — ${c.type === 'rental'
            ? money(c.monthlyRate || c.price * 30) + '/month'
            : money(c.price)}` })),
        full: true,
        hint: 'The charge below is worked out from this vehicle and the dates.' },
      /* Read-only: the plate belongs to the vehicle, so it is changed in
         the Fleet tab, not per booking. Shown here because the office
         needs it to hand the right car over. */
      { key: 'registration', label: 'Vehicle number', readOnly: true,
        value: (fleet.find(c => c.id === base.carId) || {}).registration
               || base.vehicleRegistration || '—',
        hint: 'Set on the vehicle in the Fleet tab.' },
      { key: 'from', label: 'From date', value: base.from || '', type: 'date' },
      { key: 'to', label: 'To date', value: base.to || '', type: 'date' },
      { key: 'status', label: 'Status', value: base.status || 'Prebooked', type: 'select', options: STATUSES },
      /* Tolls and the advance are edited inline in the table — and tolls
         now arrive in bulk from an imported sheet — so they are no longer
         duplicated here. Their stored values are carried through the save
         below rather than re-entered. */
      { key: '_quote', label: 'Charge breakdown', type: 'panel', full: true,
        hint: 'A part-month bills at the monthly rate divided by 30, times the days used.' }
    ], v => {
      if (!v.name) return 'Customer name is required.';
      if (!v.email && !v.phone) return 'Give at least one contact — email or phone.';
      if (v.email && !/^\S+@\S+\.\S+$/.test(v.email)) return 'That email address does not look right.';
      if (!v.from || !v.to) return 'Both dates are required.';
      if (new Date(v.to) < new Date(v.from)) return 'The return date cannot be before the pick-up date.';

      const patch = { name: v.name, email: v.email, phone: v.phone, license: v.license || '',
                      carId: v.carId,
                      from: v.from, to: v.to, status: v.status,
                      /* No longer on this form: carry the stored figures
                         through, or saving any other change would reset
                         the tolls to zero and re-derive the advance. */
                      tolls: Number(base.tolls) || 0,
                      advance: base.advance === undefined || base.advance === null
                        ? null : Number(base.advance),
                      openReturn: base.openReturn,
                      tollNotes: base.tollNotes || '' };
      (async () => {
        try {
          if (isNew) await createBooking(patch);
          else await updateBooking(bk.id, patch);
          bookings = await reloadBookings();
          /* This form is opened from Bookings and from Actions, so both
             tables are repainted — editing from Actions used to save
             and leave the row it was opened from showing stale values. */
          renderBookings();
          renderActions();
          toast(isNew ? 'Booking added' : 'Booking updated');
        } catch (err) {
          toast(err.message, true);
        }
      })();
    });
}

$('bookRows').addEventListener('click', e => {
  /* The toll-statement button carries its own attribute rather than a
     data-act, so the guard admits both or it would never fire. */
  const btn = e.target.closest('button[data-act], button[data-toll-invoice]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  const bk = bookings.find(b => b.id === id);
  if (!bk) return;

  if (btn.dataset.act === 'edit') return editBooking(bk);

  /* The reference itself opens the booking's details and ledger. */
  if (btn.dataset.act === 'ref') return openRefSheet(bk.id);

  /* The payment screenshots the customer sent in. */
  if (btn.dataset.act === 'proof') return showPaymentProofs(bk);

  /* Email the invoice: rental total, toll fees, advance, and the sum. */
  /* Bookings does not handle the deposit, so its summary leaves the
     Advance line out. The total still includes it. */
  if (btn.dataset.act === 'invoice') { emailInvoice(bk, btn, { hideAdvance: true }); return; }

  /* The toll statement, sent on its own. Defaults to the month just
     gone, which is the normal billing cycle — the sheet arrives after
     the month ends and the statement goes out on the 1st. */
  if (btn.dataset.tollInvoice) {
    const amount = Number(bk.tolls || 0);
    if (!(amount > 0)) return toast('No tolls recorded on this booking', true);

    /* The month just gone: the operator's sheet arrives after month end
       and the statement goes out on the 1st. */
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    /* Still sent, because it numbers the statement — it is simply not
       shown, since the admin cannot change it and the customer's copy
       no longer names a month. */
    const period = d.toISOString().slice(0, 7);

    openSheet(
      'Send toll statement',
      `${bk.id} — ${bk.name || ''}${bk.email ? ' · ' + bk.email : ' · no email on file'}`,
      [
        { key: 'tollAmount', label: 'Toll charges', type: 'number',
          value: amount.toFixed(2), placeholder: '0.00' },
        { key: 'tollNotes', label: 'Detail shown to the customer', type: 'text',
          value: bk.tollNotes || '', placeholder: 'e.g. NTTA — 3 crossings', full: true }
      ],
      () => {
        if (!bk.email) return 'This customer has no email address';
        const raw = $('f_tollAmount').value.trim();
        if (raw === '') return 'Enter the toll amount';
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return 'Enter a toll amount above zero';
        const notes = $('f_tollNotes').value.trim();

        (async () => {
          try {
            const out = await sendTollInvoice(bk.id, period, { amount: n, notes });
            bookings = await reloadBookings();
            renderBookings();
            renderActions();
            renderOverview();
            toast(`Toll statement ${out.number} sent to ${out.to}`);
          } catch (err) {
            toast(err.message, true);
          }
        })();
      }
      ,
      { submitLabel: 'Send statement' }
    );
    return;
  }

  /* Only the delete button may fall through to deleting. */
  if (btn.dataset.act !== 'del') return;

  if (confirm(`Delete booking ${bk.id} for ${bk.name}? This cannot be undone.`)) {
    deleteBookingApi(bk.id)
      .then(async () => {
        bookings = await reloadBookings();
        renderBookings();
        renderActions();
        renderOverview();
        toast(`${bk.id} deleted`);
      })
      .catch(err => toast(err.message, true));
  }
});

/* Repaints one row's payment dot in place. */
function refreshRowDot(el, bk) {
  const dot = el.closest('tr')?.querySelector('.pay-state');
  if (!dot) return;
  const pay = paymentState(bk);
  dot.className = `pay-state ${pay.level}`;
  dot.setAttribute('title', pay.title);
  dot.setAttribute('aria-label', pay.title);
}

/* The cash dialog: how much was collected, what that leaves owing.
   The shortfall is shown live as the admin types, so they can see the
   pending figure before committing rather than discovering it after. */
/* Emailing the invoice, shared by the Bookings and Actions tabs so the
   confirmation and the figures can never drift apart between them.
   The breakdown mirrors the invoice itself: the advance is a deposit
   charged on top, and anything already paid is netted off. */
/* The invoice, in an editable sheet rather than a browser confirm.

   A confirm() can only be accepted or dismissed, so a wrong figure
   meant closing it, fixing the row, and starting again. Here the
   amounts are fields: the office corrects what it sees and sends. Any
   change is written to the booking as well, so the row and the
   customer's copy never drift apart.

   Each tab hides the line it does not handle — Bookings has no Advance,
   Actions has no tolls yet — but the total always counts every charge,
   because that is what the customer is actually billed. */
function emailInvoice(bk, btn, opts = {}) {
  const num = v => Number(v || 0);
  const fields = [];

  /* The Actions invoice is the onboarding one: the customer pays a
     month's rent and the deposit before collecting the car, not the
     whole term. A 61-day booking stores $5,720 as its rental, so
     billing that outright asked for two months plus the advance —
     $8,580 instead of $5,720.

     `firstMonthOnly` bills one month at the monthly rate. The rest is
     invoiced later, month by month, from the Bookings tab. */
  const wholeRental = num(bk.total);
  const rate = num(bk.monthlyRate);

  /* The first month is the booking's own first billing segment, not a
     flat month's rate. A car collected on the 27th of October is only
     rented for 5 days of that month, so the opening invoice is $83.33,
     not $500 — charging the full rate would bill 25 days the customer
     has not had the car for, and the November segment would bill them
     again. The breakdown is computed once when the booking is saved
     and travels with it. */
  const segs = Array.isArray(bk.breakdown) ? bk.breakdown : [];

  /* Which month this invoice is for.

     Actions raises the ONBOARDING invoice, so it always bills the
     booking's first segment — that is the month the customer pays
     before collecting the car.

     Bookings raises the monthly invoices that follow, so it bills the
     segment covering TODAY: once October has been invoiced from
     Actions and the month has turned, the Bookings invoice is
     November's. Nothing records which months have already been sent,
     so the current date is the honest signal; if today falls outside
     the term (the booking has ended, or has not started), it falls
     back to the last or first segment rather than showing nothing. */
  const segIndex = (() => {
    if (!segs.length) return -1;
    if (opts.firstMonthOnly === true) return 0;
    const today = new Date().toISOString().slice(0, 10);
    const hit = segs.findIndex(s => today >= s.from && today <= s.to);
    if (hit >= 0) return hit;
    return today < segs[0].from ? 0 : segs.length - 1;
  })();
  const seg = segIndex >= 0 ? segs[segIndex] : null;

  /* Both tabs bill one month at a time. The Bookings invoice used to
     bill `bk.total` — the WHOLE term — so a three-month booking asked
     for everything at once on what is meant to be a monthly bill. */
  const monthAmount = seg ? num(seg.amount)
    : (rate > 0 ? Math.min(rate, wholeRental) : wholeRental);
  const firstMonth = segs.length > 1 ? monthAmount : wholeRental;

  /* Name the month, so the office and the customer can both see which
     period the figure covers rather than inferring it from the dates.
     The onboarding invoice calls it the first month; a later monthly
     bill just names the month it covers. */
  const billsOneMonth = segs.length > 1 && seg;
  const rentalLabel = !billsOneMonth
    ? 'Rental'
    : (opts.firstMonthOnly === true
        ? `Rental (first month — ${seg.label})`
        : `Rental — ${seg.label}`);

  fields.push({
    key: 'invRental',
    label: rentalLabel,
    type: 'text',
    value: money(firstMonth),
    readOnly: true,
    hint: billsOneMonth
      ? `${seg.days} day${seg.days === 1 ? '' : 's'} — ${seg.from} to ${seg.to}`
      : '',
    /* The full month-by-month working behind the figure. A pro-rated
       first month is the line customers query most, so the arithmetic
       is one click away rather than something the office recomputes. */
    /* Emails the rental agreement — the same document the Actions row
       sends, offered here because the office is already looking at the
       booking's figures when they set the paperwork going. */
    action: {
      icon: ACT_SVG.file,
      label: 'Send rental document',
      title: bk.email
        ? `Email the rental agreement to ${bk.email}`
        : 'No email address on file',
      onClick: async (ev) => {
        const btn = ev.currentTarget;
        if (!bk.email) { toast('This customer has no email address', true); return; }
        const was = btn.innerHTML;
        btn.disabled = true;
        btn.textContent = 'Sending…';
        try {
          const res = await fetch(
            `/api/bookings/${encodeURIComponent(bk.id)}/send-contract`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' } });
          const out = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(out.error || 'Could not send the document');
          toast(`Rental agreement sent to ${bk.email}`);
          btn.innerHTML = was;
          btn.disabled = false;
          bookings = await reloadBookings();
          renderActions();
        } catch (err) {
          toast(err.message || 'Could not send the document', true);
          btn.innerHTML = was;
          btn.disabled = false;
        }
      }
    }
  });

  /* What is still to come, beside the month being billed now. The
     office is asked "what will I pay next?" at the counter, and
     without this the answer meant reopening the booking. Every later
     segment is listed with its own month and figure — these are NOT
     being charged on this invoice, so the box is read-only and says
     so. */
  /* Everything after the month being billed — not always the first
     segment, since a Bookings invoice raised in November has October
     behind it. */
  const laterSegs = segIndex >= 0 ? segs.slice(segIndex + 1) : [];
  if (laterSegs.length) {
    const rows = laterSegs.map(s => `
      <div class="mon-row">
        <span class="mon-name">${esc(s.label)}</span>
        <span class="mon-days">${s.days} day${s.days === 1 ? '' : 's'}</span>
        <b class="mon-amt">${esc(money(num(s.amount)))}</b>
      </div>`).join('');
    const laterTotal = laterSegs.reduce((n, s) => n + num(s.amount), 0);
    fields.push({
      key: 'invLater',
      label: 'Upcoming months',
      type: 'html',
      html: `<div class="mon-box">${rows}
        <div class="mon-row mon-total">
          <span class="mon-name">Still to be invoiced</span>
          <b class="mon-amt">${esc(money(laterTotal))}</b>
        </div>
        <p class="mon-note">Billed month by month. Not charged on this invoice.</p>
      </div>`
    });
  }
  if (opts.hideTolls !== true) {
    fields.push({ key: 'invTolls', label: 'Toll fees', type: 'number',
                  value: num(bk.tolls).toFixed(2), placeholder: '0.00' });
  }
  if (opts.hideAdvance !== true) {
    fields.push({ key: 'invAdvance', label: 'Advance (deposit)', type: 'number',
                  value: num(bk.advance).toFixed(2), placeholder: '0.00' });
  }
  fields.push({ key: 'invPending', label: 'Previous balance', type: 'number',
                value: num(bk.pending).toFixed(2), placeholder: '0.00' });
  /* Named for what it is: on the onboarding invoice only the first
     month and the deposit are being collected, so "Total payable"
     alone would read as the whole contract value. */
  fields.push({ key: 'invTotal',
                label: opts.firstMonthOnly === true
                  ? 'Total payable now (first month + advance)'
                  : 'Total payable',
                type: 'text', value: '', readOnly: true, full: true });

  openSheet(
    'Send invoice',
    `${bk.id} — ${bk.name || ''}${bk.email ? ' · ' + bk.email : ' · no email on file'}`,
    fields,
    () => {
      if (!bk.email) return 'This customer has no email address';
      const read = k => {
        const el = $(`f_${k}`);
        if (!el) return null;
        const raw = el.value.trim();
        if (raw === '') return 0;
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : NaN;
      };
      const tolls = read('invTolls');
      const advance = read('invAdvance');
      const pending = read('invPending');
      if ([tolls, advance, pending].some(v => Number.isNaN(v))) {
        return 'Enter valid amounts';
      }

      const edits = {};
      if (tolls !== null) edits.tolls = tolls;
      if (advance !== null) edits.advance = advance;
      if (pending !== null) edits.pending = pending;
      /* Only sent when the invoice covers part of the term, so the
         server bills that figure rather than the whole rental. It does
         not change the booking — the rest is still owed. */
      if (firstMonth < wholeRental) {
        edits.rentalOverride = firstMonth;
        /* The period the figure covers, so the invoice can name the
           month instead of leaving the customer to work out why the
           first bill is smaller than the monthly rate. */
        if (seg && seg.label) {
          edits.periodLabel = seg.label;
          edits.periodFrom = seg.from;
          edits.periodTo = seg.to;
          edits.periodDays = seg.days;
        }
      }

      (async () => {
        try {
          const out = await sendInvoice(bk.id, edits);
          bookings = await reloadBookings();
          renderBookings();
          renderActions();
          renderOverview();
          toast(`Invoice ${out.number} sent to ${out.to}`);
        } catch (err) {
          toast(err.message, true);
        }
      })();
    }
    ,
    { submitLabel: 'Send invoice' }
  );

  /* The total follows the fields as they are edited, so the office can
     see what the customer will owe before committing to it. */
  const live = () => {
    const v = k => {
      const el = $(`f_${k}`);
      return el ? (Number(el.value) || 0) : 0;
    };
    const total = firstMonth + v('invTolls') + v('invAdvance') + v('invPending');
    const paid = num(bk.verifiedPaid);
    const box = $('f_invTotal');
    if (box) {
      box.value = paid > 0
        ? `${money(total)}  −  ${money(paid)} paid  =  ${money(Math.max(0, total - paid))} due`
        : money(total);
    }
  };
  ['invTolls', 'invAdvance', 'invPending'].forEach(k => {
    const el = $(`f_${k}`);
    if (el) el.addEventListener('input', live);
  });
  live();
}


async function askCashAmount(bk, box) {
  /* Ask the server what this booking has actually taken, rather than
     trusting the row. A customer may have paid part online and part in
     cash, and the figures must include every verified payment on both
     sides — otherwise the second payment would be measured against the
     full amount again and overstate what is still owed. */
  let s;
  try {
    s = await bookingSettlement(bk.id);
  } catch (err) {
    toast(err.message, true);
    return;
  }

  const due = s.due;
  const alreadyPaid = s.paid;
  const outstanding = Math.max(0, due - alreadyPaid);

  /* Spell out where the money came from, so the office can see that a
     transfer has already been counted before they add cash to it. */
  const takenSoFar = alreadyPaid > 0
    ? ` · already taken ${money(alreadyPaid)}` +
      (s.paidOnline > 0 && s.paidCash > 0
        ? ` (${money(s.paidCash)} cash, ${money(s.paidOnline)} online)`
        : s.paidOnline > 0 ? ' online' : ' cash')
    : '';
  const awaiting = s.unverified > 0
    ? ` · ${s.unverified} screenshot${s.unverified > 1 ? 's' : ''} not yet checked`
    : '';

  openSheet(
    'Payment received in cash',
    `${bk.id} — ${money(outstanding)} outstanding of ${money(due)}${takenSoFar}${awaiting}`,
    [
      /* Both fields start empty: a pre-filled figure invites a blind
         Save, and the amount is the one thing the office must read off
         the cash in front of them rather than accept from the screen. */
      { key: 'cashAmount', label: 'Amount collected', type: 'number',
        value: '', placeholder: '0.00' },
      { key: 'cashPending', label: 'Pending after this payment', type: 'number',
        value: '', placeholder: '0.00' }
    ],
    () => {
      /* openSheet's handler runs synchronously and closes the sheet
         unless a message is returned, so validation happens here and
         the save follows in its own task — the pattern the booking
         sheet already uses. */
      const rawAmt = $('f_cashAmount').value.trim();
      if (rawAmt === '') return 'Enter the amount collected';
      const paid = Number(rawAmt);
      if (!isFinite(paid) || paid < 0) return 'Enter a valid amount';

      const rawPend = $('f_cashPending').value.trim();
      const pending = rawPend === '' ? 0 : Number(rawPend);
      if (!isFinite(pending) || pending < 0) return 'Enter a valid pending amount';

      (async () => {
        try {
          /* One call: the payment joins the ledger, the booking's
             method is re-summarised (cash / online / mixed) and the
             pending balance is re-derived from every verified payment
             on both channels. */
          const res = await addCashPayment(bk.id, { amount: paid, pending });
          bookings = await reloadBookings();
          renderBookings();
          renderActions();
          renderOverview();
          toast(`${bk.id} — ${money(paid)} in cash recorded` +
                (res.pending > 0 ? `, ${money(res.pending)} pending`
                                 : ', paid in full'));
        } catch (err) {
          toast(err.message, true);
        }
      })();
    }
  );

  /* Keep "pending" in step with what has been typed, until the admin
     overrides it themselves — a manual figure is never overwritten. */
  const amt = $('f_cashAmount');
  const pend = $('f_cashPending');
  if (!amt || !pend) return;

  /* The row's own Pending cell, so the figure appears beside Total in
     the table while it is being typed rather than only after saving.
     It is previewed, not committed — cancelling puts the original
     value back, and only Save writes it to the booking. */
  const cell = box.closest('tr')?.querySelector('input[data-pending]');
  const cellWas = cell ? cell.value : null;
  let restored = false;
  const restore = () => {
    if (restored || !cell) return;
    restored = true;
    cell.value = cellWas;
    cell.classList.toggle('has-pending', Number(cellWas) > 0);
  };
  /* Cancel, Escape and a backdrop click all end the dialog without
     saving, so the preview has to come back off on any of them. */
  $('sheetCancel').addEventListener('click', restore, { once: true });
  $('sheet').addEventListener('mousedown', e => {
    if (e.target === $('sheet')) restore();
  }, { once: true });
  document.addEventListener('keydown', function esc(e) {
    if (e.key !== 'Escape') return;
    document.removeEventListener('keydown', esc);
    restore();
  });

  const preview = value => {
    if (!cell || restored) return;
    cell.value = value === '' ? '' : Number(value).toFixed(2);
    cell.classList.toggle('has-pending', Number(value) > 0);
  };

  let pendingTouched = false;
  pend.addEventListener('input', () => {
    pendingTouched = true;
    preview(pend.value.trim());
  });

  /* While the admin has not set a pending figure of their own, it
     follows what they have typed as collected. An empty amount box
     leaves both blank rather than asserting a balance nobody entered. */
  const sync = () => {
    if (pendingTouched) return;
    const raw = amt.value.trim();
    if (raw === '') { pend.value = ''; preview(''); return; }
    const paid = Number(raw);
    const left = isFinite(paid) ? Math.max(0, outstanding - paid) : outstanding;
    pend.value = left.toFixed(2);
    preview(left);
  };
  amt.addEventListener('input', sync);
}

/* Return/Enter commits the inline toll too. */
/* Tolls and Pending, saved inline. This went missing when the Advance
   column was removed from this tab — the removal took the shared
   MONEY_FIELDS handler with it, and both remaining fields silently
   stopped saving. Advance is deliberately absent: it is edited in the
   Actions tab, where the booking is reviewed before approval. */
$('bookRows').addEventListener('change', e => {
  /* Paid by cash — ticking opens the amount dialog. This was lost when
     the tolls/pending handler was rewritten, so the box saved nothing
     and no dialog appeared. */
  const box = e.target.closest('input[data-cash]');
  if (box) {
    const ref = box.dataset.cash;
    const bk = bookings.find(b => b.id === ref);
    if (!bk) return;

    /* Unticking clears the method and leaves the figures alone. */
    if (!box.checked) {
      box.disabled = true;
      return setPaymentMethod(ref, null)
        .then(async () => {
          bookings = await reloadBookings();
          renderBookings(); renderActions(); renderOverview();
          toast(`${ref} marked unrecorded`);
        })
        .catch(err => { box.checked = true; toast(err.message, true); })
        .finally(() => { box.disabled = false; });
    }

    /* Ticking asks for the amount first. The box goes back to unticked
       until the save succeeds, so an abandoned dialog leaves no trace. */
    box.checked = false;
    askCashAmount(bk, box);
    return;
  }

  const input = e.target.closest('input.toll-input');
  if (!input) return;
  const field = input.dataset.toll ? 'tolls'
              : input.dataset.pending ? 'pending' : null;
  if (!field) return;

  const ref = input.dataset[field === 'tolls' ? 'toll' : 'pending'];
  const bk = bookings.find(b => b.id === ref);
  if (!bk) return;

  const raw = input.value.trim();
  const amount = raw === '' ? 0 : Number(raw);
  if (!isFinite(amount) || amount < 0) {
    input.value = bk[field] || '';
    return toast(`Enter a valid ${field} amount`, true);
  }

  input.disabled = true;
  /* The endpoint rewrites the whole booking, so every figure is sent —
     omitting one would blank it. Advance is passed through untouched. */
  updateBooking(ref, {
    name: bk.name, email: bk.email, phone: bk.phone, carId: bk.carId,
    from: bk.from, to: bk.to, status: bk.status,
    openReturn: bk.openReturn, tollNotes: bk.tollNotes || '',
    tolls: field === 'tolls' ? amount : (bk.tolls || 0),
    advance: bk.advance == null ? null : bk.advance,
    pending: field === 'pending' ? amount : (bk.pending || 0)
  })
    .then(async () => {
      bookings = await reloadBookings();
      renderBookings();
      renderActions();
      renderOverview();
      toast(`${ref} ${field} saved (${money(amount)})`);
    })
    .catch(err => { input.disabled = false; toast(err.message, true); });
});

$('bookRows').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest('input.toll-input');
  if (!input) return;
  e.preventDefault();
  /* Same as the Actions tab: blur() only raises `change` when the
     browser thinks the value is dirty, so the event is sent outright. */
  input.blur();
  input.dispatchEvent(new Event('change', { bubbles: true }));
});

/* ALL = cumulative report up to & including the selected month. */
function renderAllToggle() {
  const btn = $('bookAll');
  btn.classList.toggle('active', bookAllActive);
  btn.disabled = $('bookMonth').value === 'all' && !bookAllActive;
}
$('bookAll').addEventListener('click', () => {
  if ($('bookMonth').value !== 'all') {
    bookAllActive = !bookAllActive;
  } else {
    bookAllActive = false;
  }
  renderAllToggle();
  renderBookings();
});
/* Switching back to "All months" turns ALL off. */
$('bookMonth').addEventListener('change', () => {
  if ($('bookMonth').value === 'all') bookAllActive = false;
  renderAllToggle();
});

/* The Bookings filters had no bindings at all: changing status, month
   or year updated the ALL toggle but never redrew the table, so the
   list stayed on whatever it first rendered. Search is 'input' for
   as-you-type; the selects fire on 'change'. */
$('bookSearch').addEventListener('input', renderBookings);
['bookStatus', 'bookMonth', 'bookYear'].forEach(id => {
  $(id).addEventListener('change', renderBookings);
});

/* The period buttons above the Bookings figures. Only the stat row
   re-renders: the table below keeps its own month/year filters, and
   moving both from one control would hide rows people were reading. */
document.querySelectorAll('.period-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    statsPeriod = btn.dataset.period || 'all';
    document.querySelectorAll('.period-tab').forEach(b => {
      const on = b === btn;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderBookingStats();
  });
});

$('bookReset').addEventListener('click', async () => {
  bookings = await reloadBookings();
  renderBookings();
  renderActions();
  toast('Reloaded from database');
});

/* ---------------------- toll sheet import ------------------------
   Upload the authority's statement and let the server match each plate
   to the booking that had the car. Always previewed first: bulk-editing
   money with no chance to look at it would be reckless. */
$('tollImport').addEventListener('click', () => $('tollFile').click());

$('tollFile').addEventListener('change', async e => {
  const input = e.target;
  const file = input.files && input.files[0];
  if (!file) return;

  const btn = $('tollImport');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Reading…';

  try {
    const data = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(new Error('That file could not be read.'));
      fr.readAsDataURL(file);
    });
    const payload = { name: file.name, type: file.type, size: file.size, data };

    const preview = await importTolls(payload);

    if (!preview.matched.length) {
      const why = preview.unmatched.length
        ? `\n\nNothing matched. First few:\n` +
          preview.unmatched.slice(0, 5).map(u => `  ${u.plate} — ${u.reason}`).join('\n')
        : '\n\nNo usable rows were found.';
      alert(`No charges could be applied.${why}\n\n` +
            `Check that the vehicle numbers in the sheet match the ones set in the Fleet tab.`);
      return;
    }

    const lines = preview.matched.slice(0, 12).map(m =>
      `  ${m.plate.padEnd(10)} ${money(m.amount).padStart(9)}  ${m.reference}  ${m.customer}` +
      (m.exact ? '' : '  (nearest booking)'));
    const more = preview.matched.length > 12 ? `\n  …and ${preview.matched.length - 12} more` : '';
    const problems = [
      preview.unmatched.length ? `${preview.unmatched.length} vehicle(s) had no matching booking` : '',
      preview.skipped.length ? `${preview.skipped.length} row(s) skipped as unreadable` : ''
    ].filter(Boolean);

    const ok = confirm(
      `Apply tolls from ${file.name}?\n\n` +
      `${preview.matched.length} booking(s), ${money(preview.totalAmount)} total:\n\n` +
      lines.join('\n') + more +
      (problems.length ? `\n\nAlso: ${problems.join('; ')}.` : '') +
      `\n\nThis replaces the toll figure on each booking listed.`
    );
    if (!ok) return;

    btn.textContent = 'Applying…';
    const result = await importTolls(payload, { apply: true });
    bookings = await reloadBookings();
    renderBookings();
    renderActions();
    renderOverview();
    toast(`Tolls applied to ${result.matched.length} booking(s) — ${money(result.totalAmount)}`);
  } catch (err) {
    alert(err.message || 'The toll sheet could not be imported.');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    input.value = '';        /* so the same file can be chosen again */
  }
});

$('bookExport').addEventListener('click', () => {
  downloadCSV('reddy-bookings.csv', [
    ['Ref', 'Customer', 'Email', 'Phone', 'License', 'Vehicle', 'From', 'To', 'Days', 'Total USD', 'Status', 'Booked'],
    ...bookingsFiltered().map(b => {
      const car = carById(b.carId);
      return [b.id, b.name, b.email, b.phone, b.licenseNumber || '', car ? `${car.year} ${car.name}` : 'removed',
        b.from, b.to, nightsBetween(b.from, b.to), bookingTotal(b), b.status, b.created];
    })
  ]);
  toast('Bookings exported');
});

/* Releasing hands the car over: Prebooked -> Confirmed. */
document.addEventListener('click', async e => {
  /* Release a VEHICLE for pre-booking (the renter has given notice). */
  const vBtn = e.target.closest('[data-release-vehicle]');
  if (vBtn) {
    const slug = vBtn.dataset.releaseVehicle;
    const back = vBtn.dataset.back || '';
    const suggested = back ? nextDay(back) : '';

    const from = prompt(
      `Release this car for pre-booking.\n\n`
      + `Earliest date the next customer may collect it:`,
      suggested
    );
    if (from === null) return;

    const amtField = document.querySelector(`[data-amt-for="${slug}"]`);
    const amtInput = amtField ? amtField.querySelector('.amt-input') : null;
    const prebookingAmount = amtInput ? (Number(amtInput.value) || 0) : 0;

    vBtn.disabled = true;
    try {
      await releaseVehicle(slug, from.trim() || null, prebookingAmount);
      await Promise.all([renderReleases(), renderPrebookingQueue()]);
      renderOverview();
      notifications?.refresh();
      toast('Car released — customers can now pre-book it' + (prebookingAmount ? ' ($' + prebookingAmount + ' fee)' : ''));
    } catch (err) {
      vBtn.disabled = false;
      toast(err.message, true);
    }
    return;
  }

  /* Put a car back on the site as an ordinary rental. The everyday
     case is a no-show: the customer reserved it, never collected it,
     and pre-booking is the wrong tool — it queues people behind a car
     that is really just free. This cancels the booking holding the
     dates, which is what actually frees them.

     Destructive and not undoable, so the confirmation names the
     booking, the customer and anything already paid rather than
     asking a generic "are you sure". */
  const fBtn = e.target.closest('[data-release-normal]');
  if (fBtn) {
    const slug = fBtn.dataset.releaseNormal;
    const ref = fBtn.dataset.ref || '';
    const who = fBtn.dataset.customer || 'the customer';
    const dates = fBtn.dataset.dates || '';

    /* What has been taken on this booking, so a paid reservation is
       never cancelled without the admin seeing the figure. */
    let paidLine = '';
    try {
      const s = await bookingSettlement(ref);
      if (s && s.paid > 0) {
        paidLine = `

WARNING: ${money(s.paid)} has already been recorded as paid ` +
                   `on this booking. Cancelling does not refund it — handle that separately.`;
      }
    } catch { /* the check is a courtesy; a failure must not block the release */ }

    if (!confirm(
      `Release this car for ordinary booking?

` +
      `${ref} — ${who}
${dates}

` +
      `The booking will be CANCELLED and the dates freed, so anyone can ` +
      `book the car normally. Pre-booking is switched off for it.` +
      paidLine +
      `

This cannot be undone.`
    )) return;

    fBtn.disabled = true;
    try {
      const res = await releaseForNormalBooking(slug, ref);
      await Promise.all([renderReleases(), renderPrebookingQueue(), renderOnRent()]);
      bookings = await reloadBookings();
      renderBookings();
      renderOverview();
      notifications?.refresh();
      toast(`${res.reference} cancelled — ${res.vehicle} is bookable again` +
            (res.stillQueued
              ? `. ${res.stillQueued} pre-booking(s) still queued — review them`
              : ''));
    } catch (err) {
      fBtn.disabled = false;
      toast(err.message, true);
    }
    return;
  }

  /* Close a released car again — used when a release was premature. */
  const uBtn = e.target.closest('[data-unrelease]');
  if (uBtn) {
    const slug = uBtn.dataset.unrelease;
    if (!confirm('Close this car to new pre-bookings again?\n\nExisting requests are kept.')) return;
    uBtn.disabled = true;
    try {
      await unreleaseVehicle(slug);
      await renderRelease();
      toast('Car closed to new pre-bookings');
    } catch (err) {
      uBtn.disabled = false;
      toast(err.message, true);
    }
    return;
  }

  /* Send the under-confirmation message on a queued pre-booking, which
     moves it into the Bookings tab as a live reservation. */
  const qBtn = e.target.closest('[data-confirm-queue]');
  if (qBtn) {
    const ref = qBtn.dataset.confirmQueue;
    qBtn.disabled = true;
    try {
      await sendConfirmation(ref);
      bookings = await reloadBookings();
      await renderPrebookingQueue();
      renderBookings();
      renderActions();
      notifications?.refresh();
      toast(`${ref} moved to Bookings — customer notified`);
    } catch (err) {
      qBtn.disabled = false;
      toast(err.message, true);
    }
    return;
  }

  /* Mark pre-booking fee as paid — promotes the reservation to
     Confirmed and moves it into the Bookings tab. */
  /* "Paid by cash" — the office recording money taken at the counter.
     An online payment sets itself when the screenshot arrives, so this
     only ever moves a booking to cash or back to unrecorded. */
  /* Scoped to the Release queue. This listener is on `document`, and
     the Bookings tab now has its own [data-cash] boxes with their own
     handler — without this guard both fire on one click, sending two
     POSTs and letting the loser's rollback undo the winner's tick. */
  const cashBox = e.target.closest('#queueList [data-cash]');
  if (cashBox) {
    const ref = cashBox.dataset.cash;

    /* Unticking clears the method without touching any figure. */
    if (!cashBox.checked) {
      cashBox.disabled = true;
      setPaymentMethod(ref, null)
        .then(() => { toast(`${ref} marked unrecorded`); renderQueue(); })
        .catch(err => { cashBox.checked = true; toast(err.message, true); })
        .finally(() => { cashBox.disabled = false; });
      return;
    }

    /* Ticking asks how much was handed over, the same as the Bookings
       tab — cash carries no amount of its own. The box goes back to
       unticked until the save succeeds, so an abandoned dialog leaves
       no trace. */
    cashBox.checked = false;
    askQueueCashAmount(ref);
    return;
  }

  /* Every payment on a queued reservation, in the same modal the
     Bookings tab uses — so instalments and corrections work the same
     way in both places. */
  const qProofs = e.target.closest('#queueList [data-queue-proofs]');
  if (qProofs) {
    const ref = qProofs.dataset.queueProofs;
    const row = (queueRows || []).find(r => r.reference === ref);
    if (row) showPaymentProofs(row);
    return;
  }

  /* Confirming the uploaded screenshot from the queue row. Same rule as
     the Bookings tab: nothing counts until a person agrees with the
     figure, and the scan is only ever a suggestion. */
  const confirmBox = e.target.closest('#queueList [data-confirm-proof]');
  if (confirmBox) {
    if (!confirmBox.checked) return;
    const proofId = Number(confirmBox.dataset.confirmProof);
    const ref = confirmBox.dataset.ref;
    const scanned = confirmBox.dataset.scanned;

    /* An unreadable scan has no figure to agree with, so the admin is
       asked for it rather than being allowed to confirm a blank. */
    if (scanned === '') {
      confirmBox.checked = false;
      return askQueueProofAmount(ref, proofId);
    }

    confirmBox.disabled = true;
    verifyPaymentProof(ref, proofId, { amount: Number(scanned) })
      .then(res => {
        toast(`${ref} — ${money(Number(scanned))} confirmed` +
              (res && res.pending > 0 ? `, ${money(res.pending)} still pending` : ''));
        renderQueue();
        renderReleases();
      })
      .catch(err => {
        confirmBox.checked = false;
        confirmBox.disabled = false;
        toast(err.message, true);
      });
    return;
  }

  const pBtn = e.target.closest('[data-mark-paid]');
  if (pBtn) {
    const ref = pBtn.dataset.markPaid;
    if (!confirm(
      `Record the reservation fee as received for ${ref}?\n\n` +
      'The customer moves to the Actions tab for approval — check the ' +
      'licence, contract and dates there, then approve to onboard them ' +
      'into Bookings.'
    )) return;
    pBtn.disabled = true;
    try {
      const out = await markPrebookingPaid(ref);
      bookings = await reloadBookings();
      await Promise.all([renderPrebookingQueue(), renderOnRent()]);
      renderBookings();
      renderActions();
      renderOverview();
      notifications?.refresh();
      toast(`${out.name} (${out.vehicle}) — fee recorded, now awaiting approval in Actions`);
    } catch (err) {
      pBtn.disabled = false;
      toast(err.message, true);
    }
    return;
  }

  const btn = e.target.closest('[data-release]');
  if (!btn) return;
  btn.disabled = true;
  try {
    await releaseBooking(btn.dataset.release);
    bookings = await reloadBookings();
    renderBookings();
    renderActions();
    renderOverview();
    toast('Car released for collection');
  } catch (err) {
    btn.disabled = false;
    toast(err.message, true);
  }
});

/* The day after a given ISO date — the default availability date. */
function nextDay(iso) {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return '';
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/* ============================= ACTIONS ============================= */
/* A streamlined tab showing every booking (rental + sale) with quick
   status-change buttons: Confirm, Release (rental only), Cancel.
   Symbol list:
     - prebooked  -> ✓ (approve), ✗ (reject), ⏳ (send confirmation message)
     - confirmed  -> ✓ (approve), ✗ (reject)
     - active     -> ✓ (complete), ✗ (cancel)
     - completed / cancelled -> no buttons

   ✓ is a green tick that moves the booking forward one step.
   ✗ is a red cross that rejects/cancels.
   ⏳ appears only on pre-bookings: it flags them "under confirmation"
   and sends the customer a message, without changing their status yet. */

function typeOf(b) { return b.carId && carById(b.carId)?.type || 'rental'; }

const ACT_SVG = {
  /* An envelope: re-send the slot confirmation. Distinct from the
     clock, which sends the "under confirmation" holding note. */
  mail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>`,
  pencil: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  cross: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`,
  file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>`,
  money: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 12h.01M18 12h.01"/></svg>`,
  invoice: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8M8 17h5"/></svg>`
};

function actionButtons(b) {
  const ref = esc(b.id);
  const tick = { approve: 'check', reject: 'cross' };
  let btns = '';

  /* Edit, the same form the Bookings tab opens. Onboarding happens
     here, so a wrong date or vehicle is usually spotted here too, and
     sending the admin to another tab to fix it helps nobody. First in
     the row so it sits in the same place whatever else a booking's
     state adds after it. */
  btns += `<button class="act-ico edit-row" data-ref="${ref}" data-action="edit"
     title="Edit this booking">${ACT_SVG.pencil}<span class="sr-only">Edit</span></button>`;

  /* Prebooked gets the extra "under confirmation" clock action. */
  if (b.status === 'Prebooked') {
    const sent = b.confirmationSent;
    btns += `<button class="act-ico send-conf" data-ref="${ref}" data-action="confirm-sent"
       title="${sent ? 'Confirmation already sent' : 'Send under-confirmation message'}"
       ${sent ? 'disabled' : ''}>${ACT_SVG.clock}<span class="sr-only">Under confirmation</span></button>`;
  }

  /* Send the slot confirmation — dates, total and pick-up point.
     Approving onboards the booking; this tells the customer where to
     collect the car. Stays available afterwards, for a changed
     pick-up point or a customer who lost the email. */
  if (['Confirmed', 'Active'].includes(b.status)) {
    const sent = Boolean(b.pickupLocation);
    btns += `<button class="act-ico send-slot${sent ? ' done' : ''}" data-ref="${ref}"
       data-action="slot-confirmation"
       title="${sent ? 'Slot confirmation sent — send again' : 'Send the slot confirmation'}"
       >${ACT_SVG.mail}<span class="sr-only">Send slot confirmation</span></button>`;
  }

  /* Return notice — file it on the renter's behalf when they phone in.
     Only meaningful while the car is actually out. */
  if (b.status === 'Active' && typeOf(b) === 'rental') {
    const given = b.returnNoticeGivenAt;
    btns += `<button class="act-ico give-notice" data-ref="${ref}" data-action="return-notice"
       title="${given ? 'Return notice already given' : 'Record the customer’s return notice'}"
       ${given ? 'disabled' : ''}>${ACT_SVG.back}<span class="sr-only">Return notice</span></button>`;
  }

  /* The payment screenshots, reachable without leaving the tab — the
     licence and the money are usually checked in the same pass. */
  {
    const n = (paymentProofCount[b.id] || {}).count || 0;
    if (n) {
      btns += `<button class="act-ico view-proofs" data-ref="${ref}" data-action="proofs"
         title="View ${n} payment${n > 1 ? 's' : ''} on this booking"
         >${ACT_SVG.money}<span class="sr-only">Payments</span></button>`;
    }
  }

  /* Email the invoice without leaving the tab — the figures are checked
     here, so this is where the office wants to send it from. */
  btns += `<button class="act-ico send-invoice" data-ref="${ref}" data-action="invoice"
     title="${b.email ? 'Email the invoice to ' + esc(b.email) : 'No email address on file'}"
     ${b.email ? '' : 'disabled'}>${ACT_SVG.invoice}<span class="sr-only">Invoice</span></button>`;

  /* The contract comes BEFORE approval, so this is offered from the
     moment a request arrives — not only once it is confirmed. */
  if (['Prebooked', 'Confirmed', 'Active'].includes(b.status) && typeOf(b) === 'rental') {
    const sent = b.contractSentAt;
    const signed = b.contractSignedAt;
    btns += `<button class="act-ico send-contract${signed ? ' done' : sent ? ' waiting' : ''}"
       data-ref="${ref}" data-action="send-contract"
       title="${signed ? 'Signed contract received — click to resend a copy'
              : sent ? 'Contract sent, waiting for the customer to sign — click to resend'
              : 'Step 1: send the rental agreement to the customer'}"
       ${!b.email ? 'disabled' : ''}>${ACT_SVG.file}<span class="sr-only">Send contract</span></button>`;
  }

  /* Forward-step (green tick) and reject (red cross) for active states. */
  if (b.status === 'Prebooked') {
    /* Always clickable — the contract is the usual first step, but the
       office may have settled it off-system. The tooltip says where the
       paperwork stands; it never stops the approval. */
    /* Still waiting on its confirmation: the envelope is the next
       step, so the tick is held back until the slot is confirmed.
       Rejecting is always available. */
    btns += `<button class="act-ico ok" data-ref="${ref}" data-action="approve"
       title="Send the slot confirmation first (envelope)" disabled
       >${ACT_SVG.check}<span class="sr-only">Hand over</span></button>
       <button class="act-ico no" data-ref="${ref}" data-action="reject"
       title="Reject booking">${ACT_SVG.cross}<span class="sr-only">Reject</span></button>`;
  } else if (b.status === 'Confirmed') {
    /* Confirmed and waiting to be collected. The tick records the
       handover — the customer has the car and their pick-up photos
       are in — and moves the booking into the Bookings tab.

       The photo count is on the tooltip rather than enforced: a
       handover happens at a counter, and blocking it because an
       upload has not synced would leave the office stuck. */
    const shot = (b.photos && Object.keys(b.photos).length) || 0;
    const ready = shot >= 5;
    btns += `<button class="act-ico ok${ready ? '' : ' warn'}" data-ref="${ref}"
       data-action="handover"
       title="${ready
         ? 'Car collected — all five photos in. Move to Bookings.'
         : `Car collected — move to Bookings (${shot} of 5 photos uploaded)`}"
       >${ACT_SVG.check}<span class="sr-only">Mark collected</span></button>
       <button class="act-ico no" data-ref="${ref}" data-action="reject"
       title="Cancel this booking">${ACT_SVG.cross}<span class="sr-only">Cancel</span></button>`;
  } else if (b.status === 'Active') {
    btns += `<button class="act-ico ok" data-ref="${ref}" data-action="complete"
       title="Mark booking completed">${ACT_SVG.check}<span class="sr-only">Complete</span></button>
       <button class="act-ico no" data-ref="${ref}" data-action="reject"
       title="Cancel this booking">${ACT_SVG.cross}<span class="sr-only">Cancel</span></button>`;
  }

  return btns;
}

function actionsFiltered() {
  const q = $('actSearch').value.trim().toLowerCase();
  const f = $('actFilter').value;
  return bookings.filter(b => {
    /* Same rule as the Bookings tab: finished and cancelled bookings
       each have their own view, and everything else shows only what is
       still open. A cancelled booking needs no action, so leaving it in
       the working list is just noise. */
    if (f === 'cancelled') {
      if (b.status !== 'Cancelled') return false;
    } else if (f === 'completed') {
      if (!isFinished(b)) return false;
    } else if (isFinished(b) || b.status === 'Cancelled') {
      return false;
    }
    if (f === 'prebooked' && b.status !== 'Prebooked') return false;
    if (f === 'confirmed' && b.status !== 'Confirmed') return false;
    if (q) {
      const car = carById(b.carId);
      const haystack = [b.id, b.name, b.email, b.phone, b.licenseNumber || '', car ? `${car.year} ${car.name}` : ''].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

function renderActionStats() {
  const prebooked = bookings.filter(b => b.status === 'Prebooked').length;
  const confirmed = bookings.filter(b => b.status === 'Confirmed').length;
  const active    = bookings.filter(b => b.status === 'Active').length;
  const total     = bookings.length;
  $('actionStats').innerHTML = [
    [total, 'Total bookings'],
    [prebooked, 'Prebooked', prebooked > 0],
    [confirmed, 'Confirmed', confirmed > 0],
    [active, 'Active']
  ].map(([v, label, warn]) =>
    `<div class="stat"><b class="${warn ? 'warn' : ''}">${v}</b><span>${esc(label)}</span></div>`
  ).join('');
}

function renderActions() {
  renderActionStats();
  initAllRubbers();
  const list = actionsFiltered();
  $('actRows').innerHTML = list.length ? list.map(b => {
    const car = carById(b.carId);
    const contact = [b.email, b.phone].filter(Boolean);
    const t = typeOf(b);
    
    // Contract status indicators
    let contractStatus = '';
    if (b.contractSentAt && !b.contractSignedAt) {
      contractStatus = '<span class="pill pending">Contract Sent</span>';
    } else if (b.contractSignedAt) {
      contractStatus = '<span class="pill completed">Contract Signed</span>';
    }
    
    let licenseStatus = '';
    if (b.licenseUploadedAt) {
      licenseStatus = '<span class="pill completed">License ✓</span>';
    }
    
    return `
    <tr data-id="${esc(b.id)}">
      ${/* Referral details are taken during onboarding, here, before the
            booking is approved — so the same popup the Bookings tab
            uses opens from this reference too. */''}
      <td class="num" style="font-size:13px" data-label="Ref"><button
            class="ref-link" data-act="ref" type="button"
            title="Contact, referral and every payment received">${esc(b.id)}</button></td>
      <td data-label="Type"><span class="pill ${t}">${t === 'rental' ? 'Rental' : 'Sale'}</span></td>
      <td data-label="Customer"><span class="name-cell">${esc(b.name)}</span></td>
      <td data-label="Contact">${contact.length
            ? `${esc(contact[0])}${contact[1] ? `<span class="sub">${esc(contact[1])}</span>` : ''}`
            : '<span class="sub">Not given</span>'}</td>
      <td data-label="License">${b.licenseNumber ? esc(b.licenseNumber) : '<span class="sub">&mdash;</span>'}</td>
      <td data-label="Vehicle">${car ? `${esc(car.year)} ${esc(car.name)}` : '<span class="sub">Removed</span>'}</td>
      <td data-label="From">${esc(b.from)}</td>
      <td data-label="To">${b.openReturn
        ? `<span class="open-return" title="Open return — the customer has not fixed a return date. Rent is billed to the end of the month; ${esc(b.to)} is the current month end, not an agreed hand-back.">${esc(b.to)}<small>Open return</small></span>`
        : esc(b.to)}</td>
      <td class="num toll-cell" data-label="Advance">
        <input type="number" min="0" step="0.01" inputmode="decimal"
               class="toll-input" data-advance="${esc(b.id)}"
               value="${b.advance || ''}" placeholder="0.00"
               title="Advance collected — defaults to one month's rent">
      </td>
      <td class="num" data-label="Total">${money(amountDue(b))}</td>
      <td class="num" data-label="Paid">${(() => {
        /* Same figure the Bookings tab shows: only confirmed payments,
           with every instalment behind the click. */
        const paid = Number(b.verifiedPaid || 0);
        const n = Number(b.paidCount || 0);
        if (!paid) return '<span class="sub">&mdash;</span>';
        const fee = Number(b.prebookingPaid || 0);
        const cash = Number(b.paidCash || 0);
        const online = Number(b.paidOnline || 0);
        const bits = [];
        if (fee > 0) bits.push(`${money(fee)} reservation fee`);
        const restCash = Math.max(0, cash - (online > 0 ? 0 : fee));
        const restOnline = Math.max(0, online - (online > 0 ? fee : 0));
        if (restCash > 0) bits.push(`${money(restCash)} cash`);
        if (restOnline > 0) bits.push(`${money(restOnline)} online`);
        return `<button class="paid-cell" data-act="proof"
                        title="${esc(`${n} payment${n > 1 ? 's' : ''}: ${bits.join(' + ')}`)}"
                >${money(paid)}${n > 1 ? `<small>${n}&nbsp;payments</small>` : ''}</button>`;
      })()}</td>
      <td class="num toll-cell" data-label="Pending">
        <input type="number" min="0" step="0.01" inputmode="decimal"
               class="toll-input${b.pending ? ' has-pending' : ''}" data-pending="${esc(b.id)}"
               value="${b.pending || ''}" placeholder="0.00"
               title="Unpaid balance carried into the next month">
      </td>
      <td data-label="Status"><span class="pill ${esc(b.status)}">${esc(statusLabel(b))}</span>
          ${b.status === 'Prebooked' && b.confirmationSent ? '<span class="pill under">Under confirmation</span>' : ''}
          ${b.status === 'Prebooked' && b.leadDays != null && b.leadDays < NOTICE_DAYS
            ? `<span class="pill short" title="Days between the request and the pick-up date">${b.leadDays < 0 ? 'Pick-up passed' : b.leadDays === 0 ? 'Today' : b.leadDays === 1 ? 'Tomorrow' : b.leadDays + ' days ahead'}</span>` : ''}
          ${contractStatus}
          ${licenseStatus}
          <label class="cash-toggle" title="Payment taken in cash at the counter">
            <input type="checkbox" data-cash="${esc(b.id)}"${b.paymentMethod === 'cash' || b.paymentMethod === 'mixed' ? ' checked' : ''}>
            Paid by cash
          </label>
          ${b.paymentMethod === 'online' || b.paymentMethod === 'mixed'
            ? '<small class="rl-online" title="A payment screenshot has been confirmed">Online</small>'
            : ''}
      </td>
      <td class="act-cell">${actionButtons(b)}</td>
    </tr>`;
  }).join('') : `<tr class="empty-row"><td colspan="14">No bookings match</td></tr>`;

  $('actRows').insertAdjacentHTML('beforeend',
    `<tr class="add-row"><td colspan="14">
       <button class="add-inline" data-add="booking">${ICONS.plus}Add a booking</button>
     </td></tr>`);
}

/* Delegate every action click from the tbody. */
$('actRows').addEventListener('click', async e => {
  /* The reference opens the booking's details and ledger, the same as
     in Bookings — this is where the referral is actually entered. */
  const refBtn = e.target.closest('button.ref-link[data-act="ref"]');
  if (refBtn) {
    const row = refBtn.closest('tr');
    const id = row && (row.dataset.id || refBtn.textContent.trim());
    if (id) return openRefSheet(id);
  }

  const btn = e.target.closest('button.act-ico[data-action]');
  if (!btn) {
    if (e.target.closest('[data-add="booking"]')) return editBooking(null);
    return;
  }
  const ref = btn.dataset.ref;
  const action = btn.dataset.action;
  const bk = bookings.find(b => b.id === ref);
  if (!bk) return;

  /* The same booking form the Bookings tab uses. */
  if (action === 'edit') return editBooking(bk);

  /* Record the renter's return notice. 10 days minimum — the server
     enforces it, so a too-soon date comes back as an error. */
  if (action === 'return-notice') {
    const when = prompt(
      `Return notice for ${ref} (${bk.name}).\n\n`
      + `What date will the car be returned?\n`
      + `At least ${NOTICE_DAYS} days from today.`,
      bk.to || ''
    );
    if (when === null) return;
    btn.disabled = true;
    try {
      const out = await giveReturnNotice(ref, when.trim() || null);
      bookings = await reloadBookings();
      renderActions();
      renderBookings();
      await renderReleases();
      toast(`Return notice recorded — ${out.daysNotice} days notice. You can now release the car.`);
    } catch (err) {
      btn.disabled = false;
      toast(err.message, true);
    }
    return;
  }

  /* The payment screenshots, in the same modal the other tabs use. */
  if (action === 'proofs') { showPaymentProofs(bk); return; }

  /* Same invoice the Bookings tab sends, from the same function. */
  /* Actions reviews the booking before it starts, when no tolls have
     been run up yet, so that line is left out here. */
  if (action === 'invoice') { emailInvoice(bk, btn, { hideTolls: true, firstMonthOnly: true }); return; }

  /* Re-send the slot confirmation. The dialog carries the pick-up
     location so the office can correct it at the same time — that is
     usually why a confirmation gets re-sent. */
  if (action === 'slot-confirmation') {
    if (!bk.email) return toast('That customer has no email address on file', true);

    /* This is where the pick-up point is set — the office knows it by
       now, and the customer is about to be told where to collect. */
    const place = await askPickupLocation(ref, bk, '', {
      title: `Slot confirmation — ${ref}`,
      confirm: 'Send confirmation',
      current: bk.pickupLocation || ''
    });
    if (place === null) return;

    btn.disabled = true;
    try {
      await sendSlotConfirmation(ref, place);
      bookings = await reloadBookings();
      renderActions();
      renderBookings();
      notifications?.refresh();
      toast(`Slot confirmation sent to ${bk.email}`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
    return;
  }

  /* The tick on a confirmed booking: the car has been handed over.
     Moves it Confirmed -> Active, which is what puts it in the
     Bookings tab. */
  if (action === 'handover') {
    const shot = (bk.photos && Object.keys(bk.photos).length) || 0;
    const warn = shot >= 5 ? ''
      : `Only ${shot} of 5 pick-up photos have been uploaded.

`;
    if (!confirm(
      `Hand over ${ref} to ${bk.name}?

`
      + warn
      + 'It moves into the Bookings tab as an active rental.'
    )) return;

    btn.disabled = true;
    try {
      await handoverBooking(ref);
      bookings = await reloadBookings();
      renderActions();
      renderBookings();
      renderOverview();
      notifications?.refresh();
      toast(`${ref} handed over — now in Bookings`);
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
    return;
  }

  /* The clock icon only flags the booking as "under confirmation". */
  if (action === 'confirm-sent') {
    if (bk.confirmationSent) return;
    try {
      await sendConfirmation(ref);
      bookings = await reloadBookings();
      renderActions();
      renderBookings();
      notifications?.refresh();
      toast(`${ref} marked under confirmation — customer notified`);
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  /* Send contract action */
  if (action === 'send-contract') {
    if (!bk.email) return toast('Customer email not available', true);
    if (!confirm(`Send rental agreement to ${bk.name} (${bk.email})?`)) return;
    
    btn.disabled = true;
    try {
      const res = await fetch(`/api/bookings/${encodeURIComponent(ref)}/send-contract`, {
        method: 'POST'
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Failed to send contract');
      
      bookings = await reloadBookings();
      renderActions();
      renderBookings();
      renderOverview();
      toast(`Contract sent to ${bk.email}`);
    } catch (err) {
      btn.disabled = false;
      toast(err.message, true);
    }
    return;
  }

/* Approving a booking asks where the car is collected from.

   It used to be a bare confirm(): the office approved, the customer
   was emailed a date, and nobody had said where to turn up. The
   location varies by vehicle and by who is on shift, so it cannot be
   a fleet-wide constant — it is entered here, stored on the booking,
   and carried into the confirmation email.

   Resolves with the location string, or null if the admin backs out. */
function askPickupLocation(ref, bk, paperwork, opts = {}) {
  /* The same dialog serves approving a booking and re-sending its
     confirmation; only the wording and the starting value differ. */
  const title = opts.title || `Approve ${ref}`;
  const confirmLabel = opts.confirm || 'Approve & send';
  const current = opts.current || '';

  return new Promise(resolve => {
    const host = document.createElement('div');
    host.innerHTML = `
      <div class="ap-backdrop" role="dialog" aria-modal="true" aria-labelledby="apTitle">
        <div class="ap-modal">
          <h3 id="apTitle">${esc(title)}</h3>
          <p class="ap-sub">${esc(bk.name || 'Customer')} &middot; ${esc(
            [bk.vehicleYear, bk.vehicleName].filter(Boolean).join(' ') || 'vehicle')}</p>

          ${paperwork ? `<p class="ap-warn">${esc(paperwork.trim())}</p>` : ''}

          <label class="ap-label" for="apPlace">Pick-up location</label>
          <input type="text" id="apPlace" class="ap-input" maxlength="255"
                 value="${esc(current)}"
                 placeholder="e.g. 1420 Main St, Dallas TX — front forecourt"
                 autocomplete="off">
          <p class="ap-hint">Included in the confirmation email the customer receives.</p>

          <div class="ap-actions">
            <button type="button" class="btn btn-line btn-sm" id="apCancel">Cancel</button>
            <button type="button" class="btn btn-red btn-sm" id="apOk">
              ${esc(confirmLabel)}
            </button>
          </div>
        </div>
      </div>`;
    const backdrop = host.firstElementChild;
    document.body.appendChild(backdrop);

    const input = backdrop.querySelector('#apPlace');
    const okBtn = backdrop.querySelector('#apOk');

    const close = value => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const submit = () => {
      const place = input.value.trim();
      if (!place) {
        /* The whole point of the dialog, so it is required rather than
           silently sending another email with no address in it. */
        input.classList.add('bad');
        input.focus();
        return;
      }
      close(place);
    };
    const onKey = e => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && document.activeElement === input) submit();
    };

    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(null); });
    backdrop.querySelector('#apCancel').onclick = () => close(null);
    okBtn.onclick = submit;
    input.addEventListener('input', () => input.classList.remove('bad'));

    setTimeout(() => input.focus(), 30);
  });
}

  /* Deciding on a NEW request goes through /approve and /reject, which
     record the outcome and email the customer. A rejection asks for a
     reason, because the customer is told why. */
  if (bk.status === 'Prebooked' && (action === 'approve' || action === 'reject')) {
    let reason = '';
    if (action === 'reject') {
      const answer = prompt(`Reject booking ${ref} for ${bk.name}.\n\nReason (sent to the customer):`, '');
      if (answer === null) return;
      reason = answer.trim();
    } else {
      /* The contract is the usual first step, but it is often handled by
         phone or in person — so this warns and asks, never blocks. */
      const isRental = typeOf(bk) === 'rental';
      const paperwork = !isRental ? ''
        : bk.contractSignedAt ? 'Signed contract received.\n\n'
        : bk.contractSentAt
          ? 'Note: the contract was sent but has not come back signed yet.\n\n'
          : 'Note: no contract has been sent for this booking yet.\n\n';

      /* Approving onboards the booking into Bookings. It no longer
         asks for a pick-up location or emails the customer — the
         envelope action does that as a deliberate second step, once
         the office knows where the car will be collected from. */
      if (!confirm(
        `Approve ${ref} for ${bk.name}?

`
        + paperwork
        + 'It moves into Bookings. Send the slot confirmation separately '
        + 'with the envelope button.'
      )) return;
    }

    btn.disabled = true;
    try {
      const out = await decideBooking(ref, action, reason);
      bookings = await reloadBookings();
      renderActions();
      renderBookings();
      renderOverview();
      notifications?.refresh();
      /* Approving no longer emails, so the toast says what actually
         happened and points at the next step. A rejection still
         emails, because the customer needs the reason. */
      toast(action === 'approve'
        ? `${ref} approved — now send the slot confirmation`
        : out.emailSent
          ? `${ref} rejected — customer emailed`
          : `${ref} rejected (email not sent)`,
        action === 'reject' && !out.emailSent);
    } catch (err) {
      btn.disabled = false;
      toast(err.message, true);
    }
    return;
  }

  const label = action === 'approve' ? 'approve' : action === 'complete' ? 'mark complete' : 'reject/cancel';
  if (!confirm(`${label} booking ${ref} for ${bk.name}?`)) return;

  btn.disabled = true;
  try {
    if (action === 'approve') {
      const next = { Prebooked: 'Confirmed', Confirmed: 'Active' }[bk.status];
      /* Confirmed -> Active is a release (timestamps it); otherwise a plain status bump. */
      if (bk.status === 'Confirmed') await releaseBooking(ref);
      else await updateBooking(ref, { ...bk, status: next });
    } else if (action === 'complete') {
      await updateBooking(ref, { ...bk, status: 'Completed' });
    } else if (action === 'reject') {
      await updateBooking(ref, { ...bk, status: 'Cancelled' });
    }
    bookings = await reloadBookings();
    renderActions();
    renderBookings();
    renderOverview();
    toast(`${ref} ${label}d`);
  } catch (err) {
    btn.disabled = false;
    toast(err.message, true);
  }
});

/* Confirm-all: batch confirm every Prebooked reservation. */
$('actConfirmAll').addEventListener('click', async () => {
  const prebooked = bookings.filter(b => b.status === 'Prebooked');
  if (!prebooked.length) return toast('Nothing to confirm');
  if (!confirm(`Confirm ${prebooked.length} prebooked reservation${prebooked.length > 1 ? 's' : ''}?`)) return;

  $('actConfirmAll').disabled = true;
  let done = 0;
  for (const b of prebooked) {
    try {
      await updateBooking(b.id, { ...b, status: 'Confirmed' });
      done++;
    } catch (err) { /* continue on individual failure */ }
  }
  bookings = await reloadBookings();
  renderActions();
  renderBookings();
  renderOverview();
  $('actConfirmAll').disabled = false;
  toast(`${done} booking${done > 1 ? 's' : ''} confirmed`);
});

$('actReset').addEventListener('click', async () => {
  bookings = await reloadBookings();
  renderActions();
  toast('Reloaded from database');
});

/* The Actions tab carries the same money controls as Bookings, so the
   office can record a payment while reviewing a request rather than
   switching tabs to do it. Both handlers mirror the Bookings ones. */
$('actRows').addEventListener('change', e => {
  /* Paid by cash — opens the amount dialog, same as Bookings. */
  const box = e.target.closest('input[data-cash]');
  if (box) {
    const ref = box.dataset.cash;
    const bk = bookings.find(b => b.id === ref);
    if (!bk) return;
    if (!box.checked) {
      box.disabled = true;
      return setPaymentMethod(ref, null)
        .then(async () => {
          bookings = await reloadBookings();
          renderActions(); renderBookings(); renderOverview();
          toast(`${ref} marked unrecorded`);
        })
        .catch(err => { box.checked = true; toast(err.message, true); })
        .finally(() => { box.disabled = false; });
    }
    box.checked = false;
    askCashAmount(bk, box);
    return;
  }

  /* Advance and pending, saved inline. */
  const input = e.target.closest('input.toll-input');
  if (!input) return;
  const field = input.dataset.advance ? 'advance'
              : input.dataset.pending ? 'pending' : null;
  if (!field) return;
  const ref = input.dataset[field];
  const bk = bookings.find(b => b.id === ref);
  if (!bk) return;

  const raw = input.value.trim();
  const amount = raw === '' ? 0 : Number(raw);
  if (!isFinite(amount) || amount < 0) {
    input.value = bk[field] || '';
    return toast(`Enter a valid ${field} amount`, true);
  }

  /* An emptied Advance box means "use the default" — one month's rent —
     not "waive the deposit". Sending 0 for a cleared field is how four
     bookings ended up with no deposit at all. A typed 0 still waives
     it, because that is a figure the office chose. */
  const advanceValue = field !== 'advance' ? (bk.advance || 0)
                     : raw === '' ? null            /* null = re-derive */
                     : amount;

  input.disabled = true;
  /* The endpoint rewrites the whole booking, so every figure is sent —
     omitting one would blank it. */
  updateBooking(ref, {
    name: bk.name, email: bk.email, phone: bk.phone, carId: bk.carId,
    from: bk.from, to: bk.to, status: bk.status,
    openReturn: bk.openReturn, tollNotes: bk.tollNotes || '',
    tolls: bk.tolls || 0,
    advance: advanceValue,
    pending: field === 'pending' ? amount : (bk.pending || 0)
  })
    .then(async () => {
      bookings = await reloadBookings();
      renderActions(); renderBookings(); renderOverview();
      toast(`${ref} ${field} saved (${money(amount)})`);
    })
    .catch(err => { input.disabled = false; toast(err.message, true); });
});

/* Return/Enter commits an amount here too. Without this the value only
   saved when the field happened to lose focus, so typing a figure and
   pressing Enter looked like nothing had happened — the Bookings tab
   has had this since it gained inline amounts. */
$('actRows').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest('input.toll-input');
  if (!input) return;
  e.preventDefault();
  /* blur() alone only fires `change` when the browser considers the
     value dirty, which is not true for every way a figure can get into
     the box. Dispatching it explicitly makes Enter commit the same way
     every time, and the handler is idempotent so the extra event a
     blur might also raise costs nothing. */
  input.blur();
  input.dispatchEvent(new Event('change', { bubbles: true }));
});

['actSearch', 'actFilter'].forEach(id => $(id).addEventListener('input', renderActions));

/* ---------------------------- install ----------------------------- */

/* Chrome/Edge/Android fire beforeinstallprompt and let us show our own
   button. iOS Safari does not — it only offers Share > Add to Home
   Screen — so there we show instructions instead of a dead button. */

let installPrompt = null;
const installBtn = $('installApp');

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();               /* keep Chrome's own bar out of the way */
  installPrompt = e;
  if (installBtn) installBtn.hidden = false;
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  if (installBtn) installBtn.hidden = true;
  toast('Installed — open it from your home screen or app list');
});

if (installBtn) {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches
                  || window.navigator.standalone === true;

  /* Already installed, or iOS where we must explain the manual steps. */
  if (standalone) {
    installBtn.hidden = true;
  } else if (isIOS) {
    installBtn.hidden = false;
    installBtn.textContent = 'Install app';
  }

  installBtn.addEventListener('click', async () => {
    if (installPrompt) {
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === 'accepted') installBtn.hidden = true;
      installPrompt = null;
      return;
    }
    if (isIOS) {
      alert([
        'To install on iPhone or iPad:',
        '',
        '1. Tap the Share button at the bottom of Safari',
        '2. Scroll down and tap "Add to Home Screen"',
        '3. Tap Add',
        '',
        'The dashboard then opens like an app.'
      ].join('\n'));
      return;
    }
    alert([
      'To install:',
      '',
      'Look for the install icon in your browser address bar, or open',
      'the browser menu and choose "Install" / "Add to Home screen".',
      '',
      'Chrome, Edge and Android browsers support this. Safari on Mac',
      'uses File > Add to Dock.'
    ].join('\n'));
  });
}

/* Ends the admin session and returns to the sign-in page. The alert
   chime stops with it, because the dashboard is no longer open. */
$('adminLogout').addEventListener('click', async () => {
  if (!confirm('Sign out of the dashboard?')) return;
  notifications?.stop();          /* no chime after signing out */
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  location.href = 'admin-login.html';
});

$('releaseReload').addEventListener('click', async () => {
  [fleet, bookings] = await Promise.all([loadFleet(), reloadBookings()]);
  await renderRelease();
  toast('Reloaded from database');
});

/* ============================== BOOT ============================== */

['Sedan', 'SUV', 'Truck', 'Luxury'].forEach(c => {
  $('fleetCat').insertAdjacentHTML('beforeend', `<option value="${c}">${c}</option>`);
});
STATUSES.forEach(s => {
  $('bookStatus').insertAdjacentHTML('beforeend', `<option value="${s}">${s}</option>`);
  /* Cancelled is not offered on the pending list: a cancelled booking
     owes nothing, so it is filtered out before this select is read. */
  if (s !== 'Cancelled') {
    $('pendingStatus').insertAdjacentHTML('beforeend', `<option value="${s}">${s}</option>`);
  }
});

MONTHS.forEach((name, i) => {
  $('bookMonth').insertAdjacentHTML('beforeend', `<option value="${i + 1}">${name}</option>`);
});

/* Years are derived from the bookings on file so the dropdown only ever
   shows years that actually have data (plus the current year). */
function syncBookingYearFilter() {
  const seen = new Set();
  bookings.forEach(b => {
    [b.from, b.to].forEach(d => {
      if (d && /^\d{4}/.test(d)) seen.add(d.slice(0, 4));
    });
  });
  const years = Array.from(seen).sort();
  if (!years.includes(String(new Date().getFullYear()))) {
    years.push(String(new Date().getFullYear()));
  }
  years.sort();
  const sel = $('bookYear');
  const wanted = ['all', ...years];
  const have = Array.from(sel.options).map(o => o.value);
  if (JSON.stringify(wanted) !== JSON.stringify(have)) {
    sel.innerHTML = `<option value="all">All years</option>` +
      years.map(y => `<option value="${y}">${y}</option>`).join('');
  }
}

$('fleetAdd').innerHTML = ICONS.plus + 'Add vehicle';
$('bookAdd').innerHTML = ICONS.plus + 'Add booking';
renderAllToggle();

/* ============================== PHOTOS ============================== */

let photoBookings = [];

async function renderPhotos() {
  const rows = $('photoRows');
  rows.innerHTML = '<tr><td colspan="9" style="padding:24px;text-align:center;color:var(--text-muted)">Loading&hellip;</td></tr>';

  try {
    photoBookings = await request('/all-photos');
  } catch {
    rows.innerHTML = '<tr><td colspan="9" style="padding:24px;color:var(--red)">Could not load photos.</td></tr>';
    return;
  }
  paintPhotoRows(photoBookings);
}

function paintPhotoRows(list) {
  const rows = $('photoRows');
  const search = $('photosSearch').value.toLowerCase();
  const filter = $('photosFilter').value;

  let items = list;
  if (search) {
    items = items.filter(b =>
      (b.name + ' ' + b.license + ' ' + b.vehicleName + ' ' + b.vehicleYear + ' ' + b.email + ' ' + b.phone).toLowerCase().includes(search)
    );
  }
  if (filter === 'pickup') items = items.filter(b => Object.keys(b.pickup).length > 0);
  if (filter === 'return') items = items.filter(b => Object.keys(b.return).length > 0);
  if (filter === 'both')   items = items.filter(b => Object.keys(b.pickup).length > 0 && Object.keys(b.return).length > 0);
  if (filter === 'damage') items = items.filter(b => (b.damage || []).length > 0);
  if (filter === 'signed') items = items.filter(b => b.signedContract);

  if (!items.length) {
    rows.innerHTML = '<tr><td colspan="11" style="padding:30px;text-align:center;color:var(--text-muted)">No bookings match.</td></tr>';
    return;
  }

  rows.innerHTML = items.map(b => {
    const pCount = Object.keys(b.pickup).length;
    const rCount = Object.keys(b.return).length;
    const dCount = (b.damage || []).length;
    const vehicle = [b.vehicleYear, b.vehicleName].filter(Boolean).join(' ');
    /* data-label drives the mobile card view: without it these cells
       collapse into unlabelled text on a phone. */
    return `<tr>
      <td class="col-main" data-label="Ref">${esc(b.id)}</td>
      <td data-label="Customer">${esc(b.name)}</td>
      <td data-label="Contact">${esc(b.email || b.phone)}</td>
      <td data-label="License">${esc(b.license)}</td>
      <td data-label="Vehicle">${esc(vehicle)}</td>
      <td data-label="Dates" style="white-space:nowrap">${esc(b.from)} &ndash; ${esc(b.to)}</td>
      <td data-label="Pickup"><span class="ph-badge ${pCount ? 'has' : 'none'}">${pCount}/5</span></td>
      <td data-label="Return"><span class="ph-badge ${rCount ? 'has' : 'none'}">${rCount}/5</span></td>
      <td data-label="Damage"><span class="ph-badge ${dCount ? 'has' : 'none'}">${dCount}</span></td>
      <td data-label="Agreement">${b.signedContract
        ? `<a class="doc-link" href="/api/contract-file/${Number(b.signedContract.id)}"
              target="_blank" rel="noopener" title="Open the signed agreement">Signed PDF</a>`
        : '<span class="ph-badge none">&mdash;</span>'}</td>
      <td class="col-actions" data-label="View">
        <button class="btn btn-line btn-sm" onclick="openPhotoModal('${esc(b.id)}')">View</button>
      </td>
    </tr>`;
  }).join('');
}

$('photosSearch').addEventListener('input', () => paintPhotoRows(photoBookings));
$('photosFilter').addEventListener('change', () => paintPhotoRows(photoBookings));
$('photosReload').addEventListener('click', renderPhotos);

/* ---- Photo modal (viewer) ---- */

window.openPhotoModal = function(ref) {
  const b = photoBookings.find(x => x.id === ref);
  if (!b) return;

  const vehicle = [b.vehicleYear, b.vehicleName].filter(Boolean).join(' ');
  $('pmTitle').textContent = b.id + ' — ' + vehicle;
  $('pmSub').textContent = b.name + ' · ' + (b.license || '—') + ' · ' + (b.phone || '') + (b.email ? ' · ' + b.email : '');

  document.querySelectorAll('.pm-tab').forEach(t => t.classList.toggle('active', t.dataset.stage === 'pickup'));
  renderModalGrid(b, 'pickup');

  $('photoModal').hidden = false;

  document.querySelectorAll('.pm-tab').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.pm-tab').forEach(t => t.classList.toggle('active', t === btn));
      renderModalGrid(b, btn.dataset.stage);
    };
  });
};

/* ---- Payment proofs (viewer) ----
   Reuses the photo modal: same dialog, same full-screen viewer, with
   the stage tabs hidden since payment proofs have no stages. */

async function showPaymentProofs(bk) {
  /* Takes a Bookings row or a Release queue row. They name the same
     things differently, so the fields are read either way rather than
     making the queue build a fake booking object. */
  const ref = bk.id || bk.reference;
  const vehicle = [bk.vehicleYear ?? bk.model_year, bk.vehicleName ?? bk.vehicle_name]
    .filter(Boolean).join(' ') || bk.carId || bk.slug || '';
  const who = bk.name || bk.customer || '';
  $('pmTitle').textContent = `${ref} — payment proofs`;
  $('pmSub').textContent = [who, vehicle, bk.email].filter(Boolean).join(' · ');

  /* No pickup/return split here. */
  const tabs = document.querySelector('.pm-tabs');
  if (tabs) tabs.hidden = true;

  const grid = $('pmGrid');
  grid.innerHTML = '<div class="pm-empty">Loading…</div>';
  $('photoModal').hidden = false;

  try {
    const proofs = await loadPaymentProofs(ref);
    if (!proofs.length) {
      grid.innerHTML = '<div class="pm-empty">No payment proofs uploaded yet.</div>';
      return;
    }
    /* Each proof shows what OCR read, and — until an admin agrees with
       the figure — an amount box and a Confirm button. Nothing counts
       toward the balance until that happens, so this is the step that
       turns an uploaded screenshot into money received. */
    grid.innerHTML = proofs.map(p => {
      const scanned = p.scannedAmount != null ? Number(p.scannedAmount) : null;
      const suggested = p.amount != null ? Number(p.amount)
                      : scanned != null ? scanned : '';
      const scanNote =
        p.scanStatus === 'ok'      ? `Scan read ${money(scanned)}`
      : p.scanStatus === 'short'   ? `Scan read ${money(scanned)} — less than the amount due`
      : p.scanStatus === 'unreadable' ? 'Could not be read automatically — check by eye'
      : scanned != null            ? `Scan read ${money(scanned)}`
      : 'Not scanned';

      return `
      <figure class="pm-item${p.verified ? ' is-verified' : ''}">
        ${p.path
          ? `<img src="/api/payment-image/${p.id}" alt="Payment proof"
                  onclick="openFullImage('/api/payment-image/${p.id}')">`
          : `<div class="pm-cash" title="Cash taken at the counter">Cash</div>`}
        <figcaption>
          <b>${p.amount != null ? esc(money(p.amount)) : 'Amount not confirmed'}</b>
          <span class="sub">${esc(timeAgo(p.uploadedAt))}${p.method === 'cash' ? ' · cash' : ''}</span>
          ${p.path ? `<span class="sub">${esc(scanNote)}</span>` : ''}
          ${p.note ? `<span class="sub">${esc(p.note)}</span>` : ''}
          ${p.verified
            ? '<span class="pm-ok">Confirmed — counted toward the balance</span>'
            : `<div class="pm-verify">
                 <label for="pv_${p.id}">Amount received</label>
                 <input id="pv_${p.id}" type="number" min="0" step="0.01"
                        inputmode="decimal" value="${esc(suggested)}"
                        placeholder="0.00">
                 <label class="pm-check" title="Tick once you have checked the screenshot against the amount">
                   <input type="checkbox" data-verify="${p.id}"
                          data-ref="${esc(ref)}">
                   Payment received — confirm and update the balance
                 </label>
               </div>`}
        </figcaption>
      </figure>`;
    }).join('');
  } catch (err) {
    grid.innerHTML = `<div class="pm-empty">${esc(err.message)}</div>`;
  }
}

/* Confirming an uploaded payment. This is the only place a scanned
   figure is allowed to move a balance: OCR reads the screenshot, an
   admin agrees with the number, and only then does it count. The
   amount stays editable because a misread receipt must be correctable
   before it becomes money, not after. */
$('pmGrid').addEventListener('change', async e => {
  const box = e.target.closest('input[type="checkbox"][data-verify]');
  if (!box || !box.checked) return;

  const proofId = Number(box.dataset.verify);
  const ref = box.dataset.ref;
  const input = $(`pv_${proofId}`);
  const raw = input ? input.value.trim() : '';

  /* The amount is what gets recorded, so it has to be right before the
     tick means anything. An empty or bad figure puts the box back
     rather than confirming a number nobody entered. */
  const fail = msg => { box.checked = false; toast(msg, true); input?.focus(); };
  if (raw === '') return fail('Enter the amount received first');
  const amount = Number(raw);
  if (!isFinite(amount) || amount < 0) return fail('Enter a valid amount');

  box.disabled = true;
  if (input) input.disabled = true;
  try {
    const res = await verifyPaymentProof(ref, proofId, { amount });
    /* The balance has moved, so the row, the dot and the totals all
       need to catch up with it. */
    bookings = await reloadBookings();
    renderBookings();
    renderActions();
    renderOverview();

    /* The modal opens from both tabs, so refresh whichever is behind
       it — confirming from the queue left the queue's own dot stale. */
    const queued = (queueRows || []).some(r => r.reference === ref);
    if (queued) { await renderQueue(); await renderReleases(); }

    const again = bookings.find(b => b.id === ref)
               || (queueRows || []).find(r => r.reference === ref);
    if (again) await showPaymentProofs(again);  /* redraw as confirmed */
    toast(`${ref} — ${money(amount)} confirmed` +
          (res && res.pending > 0 ? `, ${money(res.pending)} still pending`
                                  : ', paid in full'));
  } catch (err) {
    box.checked = false;
    box.disabled = false;
    if (input) input.disabled = false;
    toast(err.message, true);
  }
});

/* The stage tabs belong to the condition photos; restore them whenever
   that viewer is opened after a payment-proof one. */
const _openPhotoModal = window.openPhotoModal;
window.openPhotoModal = function (ref) {
  const tabs = document.querySelector('.pm-tabs');
  if (tabs) tabs.hidden = false;
  return _openPhotoModal(ref);
};

const PHOTO_LABELS = { odometer: 'Odometer', front: 'Front', rear: 'Rear', left_side: 'Left side', right_side: 'Right side' };

function renderModalGrid(b, stage) {
  const photos = stage === 'return' ? b.return : b.pickup;
  const grid = $('pmGrid');
  const entries = Object.entries(photos);

  if (!entries.length) {
    grid.innerHTML = '<div class="pm-empty">No ' + stage + ' photos uploaded for this booking.</div>';
    return;
  }

  grid.innerHTML = entries.map(([type, path]) => `
    <div class="pm-img" onclick="openFullImage('/${esc(path)}')">
      <img src="/${esc(path)}" alt="${esc(PHOTO_LABELS[type] || type)}" loading="lazy">
      <span class="pm-badge">${esc(PHOTO_LABELS[type] || type)}</span>
    </div>`
  ).join('');
}

window.openFullImage = function(src) {
  $('pfImg').src = src;
  $('photoFull').hidden = false;
};

$('pfClose').addEventListener('click', () => { $('photoFull').hidden = true; });
$('photoFull').addEventListener('click', e => { if (e.target === $('photoFull')) $('photoFull').hidden = true; });
$('pmClose').addEventListener('click', () => { $('photoModal').hidden = true; });
$('pmBackdrop').addEventListener('click', () => { $('photoModal').hidden = true; });

/* Everything comes from MySQL, so nothing renders until it arrives. */
(async () => {
  [fleet, bookings] = await Promise.all([loadFleet(), reloadBookings()]);
  renderFleet();
  renderBookings();
  renderOverview();
  renderActions();
  initAllRubbers();
  notifications = initNotifications('admin');
})();
