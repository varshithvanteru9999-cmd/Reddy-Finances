/* ------------------------------------------------------------------
   Notification bell — used by both the customer site and the admin
   dashboard. Same data shape, same markup, different audience.

   The panel is plain DOM: a button with an unread count, and a list
   that opens under it. Everything the server sends is escaped on the
   way in, because a booking carries a customer-typed name.
------------------------------------------------------------------- */

const NOTIF_POLL_MS = 60000;   /* a quiet minute between refreshes */

/* ------------------------- alert sound ---------------------------- */

/* A short two-note chime, synthesised rather than loaded, so there is no
   audio file to ship and nothing to 404. Deliberately soft and brief —
   this fires while someone is working, and a harsh tone gets muted.

   Admin dashboard only: a customer browsing cars should never hear it. */

let audioCtx = null;
let soundArmed = false;

/* The office may want silence during a meeting. Remembered per browser,
   so it survives a refresh but is not forced on anyone else. */
const NOTIF_MUTE_KEY = 'reddy.admin.notifMuted';

function notifMuted() {
  try { return localStorage.getItem(NOTIF_MUTE_KEY) === '1'; }
  catch { return false; }   /* private mode can throw on access */
}

function setNotifMuted(muted) {
  try { localStorage.setItem(NOTIF_MUTE_KEY, muted ? '1' : '0'); }
  catch { /* not remembered, but the session still honours it */ }
}

/* Browsers refuse to play audio until the user has interacted with the
   page, so the context is created on the first click and kept. */
function armNotificationSound() {
  if (soundArmed) return;
  soundArmed = true;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch {
    audioCtx = null;
  }
}

function playNotificationSound() {
  if (notifMuted()) return;
  if (!audioCtx) return;

  /* A context can be suspended again after a tab has been in the
     background, so nudge it awake and play once it is. */
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().then(() => {
      if (audioCtx.state === 'running') emitChime();
    }).catch(() => {});
    return;
  }
  emitChime();
}

function emitChime() {
  /* Respect a machine set to reduce motion/effects. */
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const now = audioCtx.currentTime;
  /* Two notes a fifth apart — reads as a notification rather than an
     alarm. Sine waves keep it soft on laptop speakers. */
  [[880, 0], [1318.5, 0.11]].forEach(([freq, at]) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now + at);

    /* Quick attack, gentle decay — no click at either end. */
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(0.16, now + at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.34);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now + at);
    osc.stop(now + at + 0.36);
  });
}

const NOTIF_ICON = {
  bell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
           <path d="M13.7 21a2 2 0 0 1-3.4 0"/>
         </svg>`
};

/* Kind -> the accent shown on the left of a row. */
const NOTIF_TONE = {
  booking_requested: 'info',
  under_confirmation: 'wait',
  approved: 'good',
  rejected: 'bad',
  released: 'good',
  contract_sent: 'info',
  signed: 'good'
};

function notifEsc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initNotifications(audience, mountId) {
  const mount = document.getElementById(mountId || 'notifWrap');
  if (!mount) return null;

  mount.innerHTML = `
    <button class="notif-btn sq-btn" id="notifBtn" type="button"
            aria-expanded="false" aria-haspopup="true" aria-label="Notifications">
      ${NOTIF_ICON.bell}
      <span class="notif-dot" id="notifDot" hidden></span>
    </button>
    <div class="notif-panel" id="notifPanel" role="dialog" aria-label="Notifications" hidden>
      <header class="notif-head">
        <h3>Notifications</h3>
        <span class="notif-head-actions">
          ${audience === 'admin' ? `
            <button class="notif-mute" id="notifMute" type="button"
                    aria-pressed="false" title="Mute the alert sound">
              <span class="notif-mute-icon" aria-hidden="true"></span>
              <span class="notif-mute-label">Sound</span>
            </button>` : ''}
          <button class="notif-clear" id="notifClear" type="button">Mark all read</button>
        </span>
      </header>
      <ul class="notif-list" id="notifList">
        <li class="notif-empty">Loading&hellip;</li>
      </ul>
    </div>`;

  const btn = document.getElementById('notifBtn');
  const dot = document.getElementById('notifDot');
  const panel = document.getElementById('notifPanel');
  const list = document.getElementById('notifList');
  const clear = document.getElementById('notifClear');
  const mute = document.getElementById('notifMute');

  /* Mute toggle — admin only, and only rendered there. */
  if (mute) {
    const paintMute = () => {
      const off = notifMuted();
      mute.classList.toggle('muted', off);
      mute.setAttribute('aria-pressed', String(off));
      mute.title = off ? 'Alert sound is off — click to turn it on'
                       : 'Alert sound is on — click to mute';
      mute.querySelector('.notif-mute-label').textContent = off ? 'Muted' : 'Sound';
    };
    paintMute();

    mute.addEventListener('click', e => {
      e.stopPropagation();
      const nowMuted = !notifMuted();
      setNotifMuted(nowMuted);
      paintMute();
      /* Unmuting plays the chime once, so the volume is obvious. */
      if (!nowMuted) { armNotificationSound(); playNotificationSound(); }
    });
  }

  let items = [];

  /* The alert chime is for the office only, and only once the admin has
     interacted with the page (browsers block audio before that). */
  const wantsSound = audience === 'admin';
  let knownIds = null;      /* null until the first load, so opening the
                               dashboard with a backlog stays silent */

  if (wantsSound) {
    /* Any click or key press counts as the interaction browsers require. */
    document.addEventListener('click', armNotificationSound, { once: true });
    document.addEventListener('keydown', armNotificationSound, { once: true });
  }

  const unread = () => items.filter(n => !n.is_read).length;

  function paint() {
    const n = unread();
    dot.hidden = n === 0;
    /* The exact number, not "9+": the office wants to know whether
       twelve things happened or ninety. The badge widens to fit. */
    dot.textContent = String(n);
    dot.classList.toggle('wide', n > 9);
    btn.classList.toggle('has-unread', n > 0);
    btn.setAttribute('aria-label',
      n ? `Notifications, ${n} unread` : 'Notifications');

    list.innerHTML = items.length ? items.map(it => {
      const tone = NOTIF_TONE[it.kind] || 'info';
      const body = it.body ? `<p>${notifEsc(it.body)}</p>` : '';
      const inner = `
        <span class="notif-title">${notifEsc(it.title)}</span>
        ${body}
        <span class="notif-when">${notifEsc(timeAgo(it.created_at))}</span>`;
      return `<li class="notif-item ${tone}${it.is_read ? '' : ' unread'}">${
        it.link ? `<a href="${notifEsc(it.link)}">${inner}</a>` : `<div>${inner}</div>`
      }</li>`;
    }).join('') : '<li class="notif-empty">Nothing yet</li>';
  }

  async function refresh() {
    const next = await loadNotifications(audience) || [];

    /* Sound only for notifications that were not there last time — a
       poll that returns the same rows must stay quiet. */
    if (wantsSound && knownIds) {
      const fresh = next.filter(n => !n.is_read && !knownIds.has(n.id));
      if (fresh.length) playNotificationSound();
    }
    if (wantsSound) knownIds = new Set(next.map(n => n.id));

    items = next;
    paint();
  }

  function open(state) {
    const show = state === undefined ? panel.hidden : state;
    panel.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
    if (show) refresh();
  }

  btn.addEventListener('click', e => { e.stopPropagation(); open(); });

  /* Click-away and Escape both close it. */
  document.addEventListener('click', e => {
    if (!panel.hidden && !mount.contains(e.target)) open(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !panel.hidden) { open(false); btn.focus(); }
  });

  clear.addEventListener('click', async () => {
    if (!unread()) return;
    items = items.map(n => ({ ...n, is_read: true }));
    paint();
    await markNotificationsRead(audience, null);
  });

  /* Opening a linked notification marks just that one read. */
  list.addEventListener('click', async e => {
    const li = e.target.closest('.notif-item');
    if (!li || !li.classList.contains('unread')) return;
    const idx = [...list.children].indexOf(li);
    const it = items[idx];
    if (!it) return;
    it.is_read = true;
    paint();
    await markNotificationsRead(audience, [it.id]);
  });

  refresh();

  /* Keep polling for the whole session — the office leaves the dashboard
     open all day, and a new booking should chime whenever it lands. The
     timer only ends when the page does: signing out navigates away. */
  const timer = setInterval(refresh, NOTIF_POLL_MS);

  /* A tab that has been in the background can be minutes stale, so catch
     up the moment it is looked at again. */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });

  return {
    refresh,
    stop() { clearInterval(timer); }
  };
}
