/* ------------------------------------------------------------------
   Client-side auth helper.

   Login is *optional* for browsing — but completing a booking (rental)
   or a viewing request (sale) requires the customer to sign in first.
   Sign-in uses the Firebase popup flow with Google as the provider.

   Design goals:
   - Lazy-load the Firebase JS SDK (~170 KB) so every page stays fast.
     The SDK is injected the first time the user *hovers* a login
     control; by the time they click, everything is ready.
   - Never show a blocking modal during the popup. A lightweight toast
     indicator confirms the page is working while the Google window is
     open. The popup can't get "stuck" visually.
   - All errors surface their Firebase error code in the toast.

   Server endpoints used:
     GET  /api/auth/config   → public Firebase web config (or null)
     POST /api/auth/firebase → { idToken } → verifies + sets cookie
     GET  /api/auth/me       → current session, if any
     POST /api/auth/logout   → clears the cookie
  ------------------------------------------------------------------- */

const auth = {
  user: null,              // { id, name, email, picture } or null
  ready: false,            // true once /api/auth/me has been checked
};

/* ==================================================================
   SDK lazy-loading
  ================================================================== */

let sdkLoading = null;

/* Inject the Firebase compat scripts the first time a login control is
   touched (hover or click). Resolves once both scripts are loaded. */
function loadFirebaseSDK() {
  if (sdkLoading) return sdkLoading;

  /* firebase-auth-compat must RUN after firebase-app-compat, but it does
     not have to WAIT to be downloaded. Chaining the second script on the
     first's onload made two round trips strictly serial: on the live
     server (~0.6s latency, 2.3s for the app bundle) that alone put the
     SDK 3.8s into the page load, which is most of the delay a viewer
     returning from Google sat through.

     Both are fetched at once via preload; the second script tag is only
     appended once the first has executed, so ordering still holds — the
     download is simply already done or in flight by then. */
  const preload = href => {
    try {
      const l = document.createElement('link');
      l.rel = 'preload';
      l.as = 'script';
      l.href = href;
      document.head.appendChild(l);
    } catch { /* preload is an optimisation; never fatal */ }
  };
  preload('/js/vendor/firebase-app-compat.js');
  preload('/js/vendor/firebase-auth-compat.js');

  sdkLoading = new Promise((resolve, reject) => {
    const s1 = document.createElement('script');
    s1.src = '/js/vendor/firebase-app-compat.js';
    s1.onload = () => {
      const s2 = document.createElement('script');
      s2.src = '/js/vendor/firebase-auth-compat.js';
      s2.onload = resolve;
      s2.onerror = () => reject(new Error('Failed to load Firebase Auth SDK'));
      document.head.appendChild(s2);
    };
    s1.onerror = () => reject(new Error('Failed to load Firebase SDK'));
    document.head.appendChild(s1);
  });
  return sdkLoading;
}

/* ==================================================================
   Firebase config + init
  ================================================================== */

let firebaseReady = null;

async function initFirebase() {
  /* `if (firebaseReady)` tested the PROMISE, which is truthy even when it
     resolves to false — so one early failure (the hover pre-warm firing
     before the page settled, a transient fetch error) was cached forever
     and every later caller got false without retrying. completeRedirect-
     SignIn() then bailed at `if (!ready) return null`, the token was
     never exchanged, and sign-in silently did nothing for the rest of
     the visit. Only cache a SUCCESSFUL init; let failures be retried. */
  if (firebaseReady) {
    const settled = await firebaseReady;
    if (settled) return true;
    firebaseReady = null;          /* failed — allow a fresh attempt */
  }
  firebaseReady = (async () => {
    try {
      await loadFirebaseSDK();
      const res = await fetch('/api/auth/config', { cache: 'no-store' });
      const { config } = await res.json();
      if (!config || !window.firebase) return false;
      if (!window.firebase.apps || !window.firebase.apps.length) {
        window.firebase.initializeApp(config);
      }

      /* A redirect sign-in leaves the site entirely and comes back as a
         fresh page load. Firebase was defaulting to SESSION persistence,
         which does not carry the pending-redirect state across that trip
         on mobile — so getRedirectResult() returned nothing, no token was
         ever exchanged, and the viewer landed back on the home page still
         signed out. LOCAL persistence (IndexedDB) survives the round trip
         and also keeps them signed in on their next visit. */
      try {
        await window.firebase.auth()
          .setPersistence(window.firebase.auth.Auth.Persistence.LOCAL);
      } catch (err) {
        /* Private browsing can block persistent storage; sign-in still
           works for the current page, so this must not be fatal. */
        console.warn('[auth] could not set local persistence:', err && err.code);
      }
      return true;
    } catch {
      return false;
    }
  })();
  return firebaseReady;
}

/* ==================================================================
   Toast indicator (replaces blocking modal during sign-in)
  ================================================================== */

function showToast(html) {
  let toast = document.getElementById('authToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'authToast';
    toast.className = 'auth-toast';
    document.body.appendChild(toast);
  }
  toast.innerHTML = html;
  toast.hidden = false;
}

function hideToast() {
  const t = document.getElementById('authToast');
  if (t) t.hidden = true;
}

/* ==================================================================
   Sign-in
  ================================================================== */

/* Phones cannot be relied on to keep a popup alive: iOS Safari and
   in-app browsers (Instagram, Gmail) block it outright or sever the
   opener, so the popup handshake never completes and sign-in dies at
   the last step. Firebase's own guidance is to redirect there. */
function prefersRedirect() {
  return window.matchMedia('(max-width: 900px)').matches ||
         /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/* Exchange a Firebase credential for our own session cookie. */
async function startSession(user) {
  const idToken = await user.getIdToken(/* forceRefresh */ true);
  const res = await fetch('/api/auth/firebase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    /* The server logs the real reason; give the viewer something they
       can act on rather than the raw code. */
    if (data.code === 'auth/id-token-expired' || data.code === 'auth/argument-error') {
      throw new Error('That sign-in attempt expired. Please try again.');
    }
    throw new Error(data.error || 'Sign-in failed — please try again.');
  }
  auth.user = data.user || null;
  return auth.user;
}

/* A redirect sign-in finishes on the NEXT page load, not in the call
   that started it — so the credential has to be collected at startup or
   the session is never created and the viewer lands back signed out.

   getRedirectResult() alone is not enough: it reports the credential
   exactly once, on the immediate return hop. Miss that moment — the
   browser restores the tab, an extra navigation intervenes, the SDK
   loads a beat late — and it answers null forever after, while a
   perfectly good signed-in Firebase user sits in IndexedDB unused. That
   is the state this bug kept landing in.

   So the SDK's own resolved user is the authority; getRedirectResult is
   just the fast path that also surfaces errors. */
function firebaseUserReady(authInstance) {
  /* onAuthStateChanged fires once the SDK has finished restoring any
     persisted session — currentUser is often still null before that. */
  return new Promise(resolve => {
    const done = authInstance.onAuthStateChanged(user => { done(); resolve(user || null); },
                                                 () => { done(); resolve(null); });
    setTimeout(() => { try { done(); } catch {} resolve(authInstance.currentUser || null); }, 8000);
  });
}

async function completeRedirectSignIn() {
  try {
    const ready = await initFirebase();
    if (!ready) return null;
    const fbAuth = window.firebase.auth();

    /* Surfaces a failed redirect as a real error rather than silence.

       Capped: this call reaches the configured auth domain, and when
       that domain is slow or unreachable it never settles — taking
       every page that awaits sign-in state down with it. Nothing
       pending is the normal case and answers immediately, so a wait
       this long already means something is wrong. */
    try {
      const result = await Promise.race([
        fbAuth.getRedirectResult(),
        new Promise(r => setTimeout(() => r(null), 6000))
      ]);
      if (result && result.user) return await startSession(result.user);
    } catch (err) {
      console.error('[auth] redirect result failed:', err && err.code, err && err.message);
    }

    /* The credential may already be restored from persistence even when
       getRedirectResult has nothing left to report. */
    const user = await firebaseUserReady(fbAuth);
    if (!user) return null;
    return await startSession(user);
  } catch (err) {
    console.error('[auth] sign-in completion failed:', err && err.code, err && err.message);
    return null;
  } finally {
    clearRedirectFlag();
  }
}

async function firebaseSignIn() {
  const ready = await initFirebase();
  if (!ready) throw new Error('Firebase is not configured on the server yet.');

  const provider = new window.firebase.auth.GoogleAuthProvider();

  if (prefersRedirect()) {
    /* Leaves the page; completeRedirectSignIn() picks it up on return. */
    markRedirectStarted();
    await window.firebase.auth().signInWithRedirect(provider);
    return null;
  }

  const { user } = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Google did not respond — the sign-in window may have been blocked or closed.'));
    }, 60000);

    window.firebase.auth().signInWithPopup(provider)
      .then(result => { clearTimeout(timeout); resolve(result); })
      .catch(err  => { clearTimeout(timeout); reject(err); });
  });

  return startSession(user);
}

/* ==================================================================
   Session restore
  ================================================================== */

/* We set our OWN marker before handing off to Google, rather than
   sniffing Firebase's internal storage keys: those are undocumented and
   version-specific. The first attempt looked for
   "firebase:pendingRedirect", but the SDK actually writes
   "firebase:persistence:<apiKey>:[DEFAULT]" — so the check never fired,
   completeRedirectSignIn() never ran, the token was never exchanged for
   a session, and the viewer came back from Google still signed out. */
const REDIRECT_FLAG = 'reddy.auth.redirecting';

function markRedirectStarted() {
  try { sessionStorage.setItem(REDIRECT_FLAG, String(Date.now())); } catch { /* storage blocked */ }
}

function redirectPending() {
  try {
    const at = Number(sessionStorage.getItem(REDIRECT_FLAG) || 0);
    if (!at) return false;
    /* A stale flag (abandoned sign-in) should not make every later
       visit pay for loading the SDK. */
    if (Date.now() - at > 10 * 60 * 1000) { clearRedirectFlag(); return false; }
    return true;
  } catch { return false; }
}

function clearRedirectFlag() {
  try { sessionStorage.removeItem(REDIRECT_FLAG); } catch { /* ignore */ }
}

async function refreshAuth() {
  /* Start loading the SDK NOW rather than after /me answers. Everything
     used to run in series — /me (~1.1s), then two vendor scripts and the
     config (~1.6s), then the token exchange — so a viewer returning from
     Google sat on a logged-out page for ten seconds and understandably
     concluded sign-in had failed. Overlapping the two roughly halves it.

     Deliberately not awaited here: if there is already a session this
     promise is simply never used, and an unobserved rejection would
     otherwise surface as an unhandled error. */
  const sdkWarm = initFirebase().catch(() => false);

  try {
    const res = await fetch('/api/auth/me', { cache: 'no-store' });
    if (res.ok) { const data = await res.json(); auth.user = data.user || null; }
  } catch { auth.user = null; }

  /* No session yet? A redirect sign-in may still be waiting to be
     collected: the Firebase credential exists in the browser but has
     never been exchanged for our cookie, which is what left the viewer
     on the home page apparently signed out.

     Earlier versions gated this on a sessionStorage flag and on
     document.referrer. Both are unreliable across the trip to Google:
     the referrer arrives empty on the final hop of Firebase's redirect
     chain, and a browser may drop sessionStorage. When BOTH missed, the
     token was never collected and the viewer landed home signed out.

     There is no heuristic worth trusting here, so there is no heuristic:
     if there is no session, ask the SDK. It answers null almost
     immediately when nothing is pending. */
  if (!auth.user) {
    try {
      await sdkWarm;                 /* already in flight since entry */
      const user = await completeRedirectSignIn();
      if (user) auth.user = user;
    } catch { /* leave them signed out */ }
  }

  auth.ready = true;
  syncAuthUI();
  return auth.user;
}

/* ==================================================================
   ensureSignedIn — used by booking flow (car.js)
  ================================================================== */

let loginResolve = null;

function ensureSignedIn() {
  return refreshAuth().then(existing => {
    if (existing) return existing;
    return openLoginPopup();
  });
}

function openLoginPopup() {
  renderLoginModal();
  return new Promise(resolve => { loginResolve = resolve; });
}

function closeLogin(result) {
  const el = document.getElementById('authModal');
  if (el) el.remove();
  if (loginResolve) { const r = loginResolve; loginResolve = null; r(result || null); }
}


/* Google's avatar URLs expire, and some accounts have no picture at all.
   Either way the chip shows the profile icon rather than a broken image
   or a bare letter. */
function avatarFallbackHTML() {
  return `<span class="user-avatar user-avatar-fallback">${ICON.user}</span>`;
}

function showAvatarFallback(img) {
  const span = document.createElement('span');
  span.className = 'user-avatar user-avatar-fallback';
  span.innerHTML = ICON.user;
  img.replaceWith(span);
}
window.showAvatarFallback = showAvatarFallback;

function renderLoginModal() {
  let el = document.getElementById('authModal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'authModal';
    el.className = 'auth-modal';
    el.addEventListener('click', e => { if (e.target === el) closeLogin(); });
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div class="auth-card" role="dialog" aria-modal="true" aria-labelledby="authTitle">
      <button class="auth-close" data-auth-close aria-label="Close">${ICON.close || '✕'}</button>
      <span class="auth-logo">${ICON.swoosh || ''}</span>
      <h2 id="authTitle">Login or sign up</h2>
      <p class="auth-sub">Sign in with your Google account to finish your booking.</p>
      <button type="button" class="auth-google" data-auth-start>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l3.7 2.9c2.2-2.1 3.7-5.1 3.7-8.6z"/>
          <path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.8-2.9l-3.7-2.9c-1 .7-2.4 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5l-3.8 2.9C3.4 21.3 7.4 24 12 24z"/>
          <path fill="#FBBC05" d="M5.3 14.4c-.2-.7-.4-1.5-.4-2.4s.1-1.7.4-2.4L1.5 6.7C.5 8.6 0 10.8 0 12s.5 3.4 1.5 5.3l3.8-2.9z"/>
          <path fill="#EA4335" d="M12 4.7c2.2 0 3.7 1 4.6 1.8l3.3-3.2C17.9 1.4 15.2 0 12 0 7.4 0 3.4 2.7 1.5 6.7l3.8 2.9c.9-2.9 3.6-4.9 6.7-4.9z"/>
        </svg>
        <span>Continue with Google</span>
      </button>
      <p class="auth-error" data-auth-error hidden></p>
      <p class="auth-note">By continuing you agree to the booking terms.</p>
    </div>`;

  el.querySelector('[data-auth-close]').addEventListener('click', closeLogin);

  /* Pre-warm SDK + config on hover so the popup is instant on click */
  el.querySelector('[data-auth-start]').addEventListener('mouseenter', () => initFirebase());

  const btn = el.querySelector('[data-auth-start]');
  btn.addEventListener('click', async e => {
    e.preventDefault();
    const stateEl = btn.querySelector('span');
    const errorEl = el.querySelector('[data-auth-error]');
    errorEl.hidden = true;

    /* Close the modal BEFORE opening the popup so it's never blocking */
    const parentEl = document.getElementById('authModal');
    closeLogin();

    showToast('<div class="auth-toast-spinner"></div><span>Waiting for Google sign-in&hellip;</span><small class="auth-toast-hint">A Google window has opened &mdash; sign in there.</small>');
    try {
      const user = await firebaseSignIn();
      hideToast();
      syncAuthUI();
      window.dispatchEvent(new CustomEvent('auth:change', { detail: user }));
    } catch (err) {
      hideToast();
      const code = err && err.code ? ` (${err.code})` : '';
      showToast(`<span class="auth-toast-error">${esc(err.message || 'Sign-in failed')}${code}</span>`);
      setTimeout(hideToast, 6000);
      /* Re-open the login modal if the user wants to retry */
      loginResolve = null;
    }
  });
}

/* ==================================================================
   Header login button + user chip
  ================================================================== */

function syncAuthUI() {
  const slot = document.getElementById('authSlot');
  if (!slot) return;

  if (auth.user) {
    /* The chip shows the same flat grey user glyph as the WhatsApp /
       phone / mail icons so the header reads as one uniform row; the
       Google photo would break that. The account still opens the
       dropdown — profile, bookings, sign out. */
    slot.innerHTML = `
      <div class="user-chip" data-user-toggle>
        <span class="user-avatar user-avatar-fallback">${ICON.user}</span>
        <div class="user-dropdown" data-user-dropdown hidden>
          <button type="button" class="user-dropdown-item" data-profile>My Profile</button>
          <button type="button" class="user-dropdown-item" data-bookings>My Bookings</button>
          <button type="button" class="user-dropdown-item" data-logout>Sign out</button>
        </div>
      </div>`;
    const chip = slot.querySelector('[data-user-toggle]');
    const dropdown = slot.querySelector('[data-user-dropdown]');

    chip.addEventListener('click', e => {
      e.stopPropagation();
      const willOpen = dropdown.hidden;
      dropdown.hidden = !willOpen;
      if (willOpen) {
        const closeDropdown = () => {
          dropdown.hidden = true;
          document.removeEventListener('click', closeDropdown);
        };
        setTimeout(() => document.addEventListener('click', closeDropdown), 0);
      }
    });

    slot.querySelector('[data-logout]').addEventListener('click', async e => {
      e.preventDefault();
      dropdown.hidden = true;
      try { if (window.firebase && window.firebase.auth) await window.firebase.auth().signOut(); } catch {}
      await fetch('/api/auth/logout', { method: 'POST' });
      auth.user = null;
      syncAuthUI();
      window.dispatchEvent(new CustomEvent('auth:change', { detail: null }));
    });

    slot.querySelector('[data-profile]').addEventListener('click', e => {
      e.preventDefault();
      dropdown.hidden = true;
      window.location.href = '/profile.html';
    });

    slot.querySelector('[data-bookings]').addEventListener('click', e => {
      e.preventDefault();
      dropdown.hidden = true;
      window.location.href = '/bookings.html';
    });
  } else {
    slot.innerHTML = `<button type="button" class="sq-btn auth-login-btn" id="authLoginBtn" aria-label="Login or sign up">${ICON.user}</button>`;
    const btn = document.getElementById('authLoginBtn');

    /* Pre-warm SDK on hover so popup is instant on click */
    btn.addEventListener('mouseenter', () => initFirebase());

    btn.addEventListener('click', async () => {
      /* If already signed in (race), just show chip */
      if (auth.user) { syncAuthUI(); return; }

      /* Show toast BEFORE handing off so the tap gets immediate feedback.
         Phones leave the page entirely, so the pop-up hint is wrong there
         and the spinner would sit until the browser navigates away. */
      showToast(prefersRedirect()
        ? '<div class="auth-toast-spinner"></div><span>Taking you to Google&hellip;</span>'
        : '<div class="auth-toast-spinner"></div><span>Opening Google sign-in&hellip;</span><small class="auth-toast-hint">If a window doesn\'t appear, allow pop-ups for this site.</small>');

      try {
        const user = await firebaseSignIn();
        hideToast();
        syncAuthUI();
        window.dispatchEvent(new CustomEvent('auth:change', { detail: user }));
      } catch (err) {
        hideToast();
        /* popup-blocked → offer modal fallback */
        const code = err && err.code || '';
        if (code === 'auth/popup-blocked' || code === 'auth/cancelled-popup-request') {
          openLoginPopup();
          return;
        }
        showToast(`<span class="auth-toast-error">${esc(err.message || 'Sign-in failed')}${code ? ' (' + code + ')' : ''}</span>`);
        setTimeout(hideToast, 6000);
      }
    });
  }
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Pages can listen for login/logout if they need to re-render. */
window.addEventListener('auth:change', () => {});

/* Expose helpers used by page scripts. */
window.Auth = auth;
window.ensureSignedIn = ensureSignedIn;
window.refreshAuth = refreshAuth;
window.authLoginPopup = {
  open: openLoginPopup,
  close: closeLogin,
};