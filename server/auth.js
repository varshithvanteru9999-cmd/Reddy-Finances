/* ------------------------------------------------------------------
   Firebase Authentication + stateless signed-session auth.

   Uses firebase-admin v13 (Node 18+ compatible).
  ------------------------------------------------------------------- */

const crypto = require('crypto');
const admin = require('firebase-admin');

/* .env loader */
const { readFileSync } = require('fs');
const path = require('path');

/* Lazy require to avoid circular dependency issues if db.js ever
   starts importing auth.js in the future. */
let _db = null;
function db() {
  if (!_db) _db = require('./db');
  return _db;
}

function loadEnv() {
  const out = {};
  try {
    const raw = readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();

      /* A quoted value may span lines — which is exactly how a PEM
         private key gets written when it is pasted with real newlines
         rather than \n escapes. Splitting purely on newlines kept only
         "-----BEGIN PRIVATE KEY-----" and silently dropped the rest,
         so Firebase reported app/invalid-credential and every sign-in
         died after the round trip to Google.

         Only a genuinely quoted value gets this treatment: an unquoted
         one is a single line and must be handed back untouched. */
      const q = (val[0] === '"' || val[0] === "'") ? val[0] : null;
      if (q) {
        const closed = val.length > 1 && val.endsWith(q);
        if (closed) {
          val = val.slice(1, -1);
        } else {
          const parts = [val.slice(1)];
          while (++i < lines.length) {
            const nxt = lines[i];
            const end = nxt.lastIndexOf(q);
            if (end !== -1 && nxt.slice(end + 1).trim() === '') {
              parts.push(nxt.slice(0, end));
              break;
            }
            parts.push(nxt);
          }
          val = parts.join('\n');
        }
      }
      out[key] = val;
    }
  } catch { /* fall through to process.env */ }
  return { ...out, ...process.env };
}

const env = loadEnv();

const FIREBASE_PROJECT_ID = env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = env.FIREBASE_CLIENT_EMAIL;
/* The key arrives in whatever shape the host's settings panel left it:
   with literal \n sequences (what a .env file must use), with real
   newlines (what a textarea produces), or wrapped in quotes the panel
   treated as part of the value. Normalising all three is what makes the
   same code work locally and on Hostinger — a malformed key fails as
   "app/invalid-credential", which reaches the customer as a sign-in
   that silently never completes. */
function normalisePrivateKey(raw) {
  let k = String(raw || '').trim();
  if ((k.startsWith('"') && k.endsWith('"')) ||
      (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1);
  }

  /* A hosting panel may store the value already escaped, so the app can
     receive \n, \\n or even \\\\n depending on how many times it passed
     through a form. Unescape repeatedly until it stops changing. */
  for (let pass = 0; pass < 4; pass++) {
    const before = k;
    k = k.replace(/\\r\\n/g, '\n')
         .replace(/\\n/g, '\n')
         .replace(/\\\\/g, '\\');
    if (k === before) break;
  }
  k = k.replace(/\r\n/g, '\n');

  /* Whatever the input looked like, a PEM is delimiter lines wrapping
     pure base64. Rebuilding it from the body is immune to stray spaces,
     lost line breaks and leftover backslashes — the shapes that make
     OpenSSL fail with "DECODER routines::unsupported". */
  const m = k.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (m) {
    const label = m[1];
    const body = m[2].replace(/[^A-Za-z0-9+/=]/g, '');
    const wrapped = body.match(/.{1,64}/g) || [];
    k = `-----BEGIN ${label}-----\n${wrapped.join('\n')}\n-----END ${label}-----\n`;
  }

  if (k && !k.endsWith('\n')) k += '\n';
  return k;
}

const FIREBASE_PRIVATE_KEY = normalisePrivateKey(env.FIREBASE_PRIVATE_KEY);
const FIREBASE_API_KEY = env.FIREBASE_API_KEY;
const FIREBASE_AUTH_DOMAIN = env.FIREBASE_AUTH_DOMAIN;
const SESSION_SECRET = env.AUTH_SESSION_SECRET;

/* A redirect sign-in returns from accounts.google.com, so the browser
   treats the response that sets our cookie as cross-site. Without
   Secure, mobile browsers (iOS Safari especially) drop such a cookie —
   which is exactly "Google accepts the password, you come back, and
   you are still signed out". Secure requires HTTPS, so it is keyed off
   the deployed URL and stays off for local http development. */
const APP_IS_HTTPS = /^https:/i.test(env.APP_URL || '');

/* Firebase (customer Google sign-in) is configured. */
function isConfigured() {
  return Boolean(
    SESSION_SECRET &&
    FIREBASE_PROJECT_ID &&
    FIREBASE_CLIENT_EMAIL &&
    FIREBASE_PRIVATE_KEY
  );
}

/* Sessions themselves only need the signing secret — the admin's
   email + password login works even with Firebase switched off. */
function sessionsConfigured() {
  return Boolean(SESSION_SECRET);
}

function publicConfig(requestHost, isSecure) {
  /* Point the SDK at OUR domain, not <project>.firebaseapp.com. The
     server proxies /__/auth/* through to Firebase, so the sign-in
     handler runs same-origin — and Chrome's third-party storage
     partitioning, which silently swallowed the returning credential on
     Android, no longer applies. */
  let authDomain = FIREBASE_AUTH_DOMAIN || `${FIREBASE_PROJECT_ID}.firebaseapp.com`;
  try {
    /* Use this host ONLY when the page is served over https.

       The SDK always builds the handler URL as https://<authDomain>/.
       Given a plain-http dev host it produced https://localhost:5500,
       which the dev server cannot answer — the popup died on
       ERR_SSL_PROTOCOL_ERROR. There is no way to tell the SDK "http",
       so a non-TLS host simply cannot host the handler, and local
       development falls back to Firebase's own domain. That is
       cross-origin, which is a real limitation only on Android; on a
       desktop dev machine the popup works fine.

       In production (https) this host serves the handler itself
       through the proxy, keeping the flow same-origin where it
       actually matters. */
    const host = String(requestHost || '').trim();
    const looksLikeHost = /^[a-z0-9.\-]+(:\d+)?$/i.test(host);
    if (isSecure && host && looksLikeHost) {
      authDomain = host;
    } else if (!isSecure) {
      /* Leave authDomain as the Firebase domain — an https handler
         that actually exists. */
    }
  } catch { /* keep the Firebase default */ }

  return {
    apiKey: FIREBASE_API_KEY,
    authDomain,
    projectId: FIREBASE_PROJECT_ID,
  };
}

/* Lazy singleton */
let app = null;
function adminApp() {
  if (isConfigured() && !app) {
    app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: FIREBASE_PRIVATE_KEY,
      }),
    });
  }
  return app;
}

async function userFromFirebaseToken(idToken) {
  if (!isConfigured()) throw Object.assign(new Error('Firebase Auth is not configured'), { status: 503 });
  if (!adminApp()) throw Object.assign(new Error('Firebase Auth is not configured'), { status: 503 });
  const decoded = await adminApp().auth().verifyIdToken(String(idToken || ''));
  if (!decoded.uid) throw new Error('Token has no user id');
  return {
    id: decoded.uid,
    email: decoded.email || '',
    name: decoded.name || '',
    picture: decoded.picture || '',
  };
}

/* ------------------------- signed cookie -------------------------- */

const COOKIE_NAME = '_reddy_session';

function sign(value) {
  const exp = Date.now() + AUTH_MAX_AGE_MS;
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(body + '.' + exp)
    .digest('hex');
  return `${body}.${exp}.${sig}`;
}

function unsign(token) {
  if (!SESSION_SECRET) return null;
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [body, exp, sig] = parts;
  if (!body || !exp || !sig) return null;
  const expected = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(body + '.' + exp)
    .digest('hex');

  /* timingSafeEqual THROWS on a length mismatch, and `sig` comes straight
     off the wire — so compare lengths first or a short cookie crashes the
     request instead of being rejected. */
  const sigBuf = Buffer.from(sig, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  if (Number(exp) < Date.now()) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { return null; }
}

const AUTH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/* ------------------- admin email + password ----------------------- */

/* A separate login from the customers' Google sign-in: the office signs
   in with an email and password. The password lives in .env as a scrypt
   hash with its own salt — never in plain text, and never in the repo. */

const ADMIN_EMAIL = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_SALT = String(env.ADMIN_PASSWORD_SALT || '');
const ADMIN_HASH = String(env.ADMIN_PASSWORD_HASH || '');

function passwordLoginConfigured() {
  return Boolean(ADMIN_EMAIL && ADMIN_SALT && ADMIN_HASH);
}

/* Constant-time comparison — a length check first, because
   timingSafeEqual throws when the two buffers differ in size.

   Deliberately ASYNCHRONOUS. The synchronous form blocks the single
   event loop for the whole cost of the KDF (~70ms at these parameters),
   so a handful of concurrent sign-in attempts was enough to stall every
   request the server was handling: /api/health measured 29ms normally
   and 4,364ms while 60 bogus logins were in flight. The async form
   hands the work to the libuv threadpool, so the loop keeps serving
   while the KDF runs. server/security.js caps how many of these may run
   at once, because the threadpool is not infinite either. */
const scryptAsync = (password, salt, keylen) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, keylen, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });

async function hashMatches(password) {
  let derived;
  try {
    derived = (await scryptAsync(password, ADMIN_SALT, 64)).toString('hex');
  } catch {
    return false;
  }
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(ADMIN_HASH, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* Returns the admin user on success, null on any failure. The caller
   must not say WHICH half was wrong — that would confirm the address. */
async function checkAdminPassword(email, password) {
  if (!passwordLoginConfigured()) return null;
  const given = String(email || '').trim().toLowerCase();

  /* Compare the address in constant time too, so response timing does
     not leak whether the email exists. */
  const e1 = Buffer.from(given.padEnd(64).slice(0, 64));
  const e2 = Buffer.from(ADMIN_EMAIL.padEnd(64).slice(0, 64));
  const emailOk = crypto.timingSafeEqual(e1, e2);
  const passOk = await hashMatches(password);

  if (!emailOk || !passOk) return null;
  return { id: 'admin', email: ADMIN_EMAIL, name: 'Administrator', admin: true };
}

/* ---------------------------- admins ------------------------------ */

/* Admins are named by email in .env — ADMIN_EMAILS=a@x.com,b@x.com — and
   sign in through the same Firebase flow as customers. Firebase has
   already proven the address belongs to them, so the list is the only
   extra state we need. No list means no admins: the dashboard stays shut
   rather than falling open. */
const ADMIN_EMAILS = new Set(
  String(env.ADMIN_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

/* Two routes to admin: the ADMIN_EMAILS allow-list (Google sign-in), or
   the email + password login below. Either is sufficient. */
function isAdmin(user) {
  if (!user || !user.email) return false;
  const email = String(user.email).toLowerCase();
  if (user.admin === true && email === ADMIN_EMAIL) return true;
  return ADMIN_EMAILS.has(email);
}

function hasAdmins() {
  return ADMIN_EMAILS.size > 0 || passwordLoginConfigured();
}

function userFromRequest(req) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim());
  const cookie = raw.find(row => row.startsWith(COOKIE_NAME + '='));
  if (!cookie) return null;
  const payload = unsign(cookie.slice(COOKIE_NAME.length + 1));
  if (!payload) return null;
  /* A cookie without a session id is pre-revocation support: still
     honoured, but any sign-in going forward includes one. */
  if (payload.sid && !db().authSessionActive(payload.sid)) return null;
  return payload;
}

/* Whether THIS request arrived over TLS, rather than whether the app's
   configured URL happens to start with https.

   APP_URL is the production address, so on a developer's machine it
   marked every cookie Secure while the page was served over plain
   http://localhost — and browsers silently discard those. Sign-in then
   looked broken in a very particular way: Google authenticated the
   user, the server verified the token and issued a session, and the
   very next request arrived with no cookie at all.

   Behind a proxy the socket is plain even when the visitor is on
   https, so the forwarded header is honoured — and only that header,
   never a guess, so a downgrade cannot strip the flag in production. */
function requestIsSecure(res) {
  const req = res && res.req;
  if (!req) return APP_IS_HTTPS;
  if (req.socket && req.socket.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (proto) return proto.toLowerCase() === 'https';

  /* A plain socket with no proxy header is a plain connection — which
     on a developer's machine is http://localhost. Marking that Secure
     is what broke sign-in, so it is reported honestly. A production
     host that terminates TLS always sets one or the other. */
  return false;
}

function sessionId() {
  return crypto.randomBytes(32).toString('hex');
}

/* Every session cookie carries an opaque id; the authoritative copy of
   whether that id is still live lives in the DB, but the in-memory Set
   in db.js is what is actually checked on the fast path. The two
   together mean sign-out takes effect immediately for this process and
   within one refresh interval (30 s) for anything else sharing the DB.

   setSessionCookie is async now, which it can afford to be: it is only
   called on sign-in, a rare event, and the write is fire-and-forget —
   the caller does not depend on it succeeding. */
async function setSessionCookie(res, user) {
  const sid = sessionId();
  const expiresAt = new Date(Date.now() + AUTH_MAX_AGE_MS);
  const token = sign({ ...user, sid });
  const secure = requestIsSecure(res) ? '; Secure' : '';
  const cookie = `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${Math.floor(AUTH_MAX_AGE_MS / 1000)}`;
  appendCookie(res, cookie);
  /* Fire and forget — if the table does not exist, createAuthSession
     returns false silently and the cookie still works (sidless). */
  db().createAuthSession({
    id: sid,
    userId: user.id || '',
    email: String(user.email || '').toLowerCase(),
    admin: Boolean(user.admin),
    expiresAt,
    ip: res && res.req ? (res.req.headers['x-forwarded-for'] || '').split(',')[0].trim() : undefined,
    userAgent: res && res.req ? String(res.req.headers['user-agent'] || '').slice(0, 255) : undefined,
  }).catch(() => {});
}

/* clearSessionCookie is async for the same reason: the session record
   must actually be revoked, not just have the browser cookie removed. */
async function clearSessionCookie(res) {
  /* The attributes must match the ones the cookie was set with, or the
     browser keeps the old one and the user never signs out. */
  const secure = requestIsSecure(res) ? '; Secure' : '';
  appendCookie(res, `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`);
  if (res && res.req) {
    const payload = userFromRequest(res.req);
    if (payload && payload.sid) {
      db().revokeAuthSession(payload.sid).catch(() => {});
    }
  }
}

/* Convenience: revoke every session for an email except the current
   one — used when the admin password changes so that stolen old
   cookies die immediately. */
async function revokeAllSessionsForEmail(email, { exceptSid = null } = {}) {
  return db().revokeAuthSessionsForEmail(email, { exceptId: exceptSid }).catch(() => 0);
}

function appendCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookie] : cookie);
}

/* ---------------------- credential diagnostics --------------------
   "Sign-in silently does nothing" has two very different causes: a
   service-account key the server cannot load, and a token Firebase
   rejects. They are indistinguishable from the browser, so this
   reports the key's SHAPE — length, delimiters, line count, whether
   Node can parse it — and never any key material. */
async function credentialDiagnostics() {
  const out = {
    projectId: FIREBASE_PROJECT_ID || null,
    clientEmail: FIREBASE_CLIENT_EMAIL
      ? FIREBASE_CLIENT_EMAIL.replace(/^(.{6}).*(@.*)$/, '$1***$2')
      : null,
    sessionSecret: SESSION_SECRET ? 'set' : 'MISSING',
    appIsHttps: APP_IS_HTTPS,
  };

  const k = FIREBASE_PRIVATE_KEY || '';
  out.privateKey = {
    present: Boolean(k),
    length: k.length,
    hasBegin: k.includes('-----BEGIN PRIVATE KEY-----'),
    hasEnd: k.includes('-----END PRIVATE KEY-----'),
    lineCount: k ? k.split('\n').length : 0,
    /* A real PEM is ~28 lines. One line means the newlines were lost. */
    looksTruncated: k.includes('-----BEGIN PRIVATE KEY-----') && k.split('\n').length < 5,
  };

  try {
    crypto.createPrivateKey(k);
    out.privateKey.parses = true;
  } catch (err) {
    out.privateKey.parses = false;
    out.privateKey.parseError = String(err.message).slice(0, 120);
  }

  /* Minting a custom token proves the credential is accepted by Google,
     which is the thing that actually gates sign-in. */
  try {
    const app = adminApp();
    if (!app) throw new Error('admin app not initialised');
    await app.auth().createCustomToken('diagnostic-probe');
    out.credentialAccepted = true;
  } catch (err) {
    out.credentialAccepted = false;
    out.credentialError = (err.code || err.errorInfo?.code || '') + ' ' +
      String(err.message).slice(0, 140);
  }

  out.verdict = out.credentialAccepted
    ? 'Credential healthy — sign-in failures are not the service account.'
    : out.privateKey.looksTruncated
      ? 'PRIVATE KEY LOST ITS NEWLINES — only the first line survived.'
      : 'Service account credential is not usable. See credentialError.';
  return out;
}

module.exports = {
  COOKIE_NAME,
  publicConfig,
  userFromFirebaseToken,
  userFromRequest,
  setSessionCookie,
  clearSessionCookie,
  isConfigured,
  isAdmin,
  hasAdmins,
  checkAdminPassword,
  passwordLoginConfigured,
  sessionsConfigured,
  credentialDiagnostics,
  revokeAllSessionsForEmail,
};