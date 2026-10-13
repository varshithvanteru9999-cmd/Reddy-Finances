/* ------------------------------------------------------------------
   Security helpers: client identity, rate limiting, CSRF, login
   throttling.

   Everything here is in-process and dependency-free, matching the rest
   of the server. The single-process assumption is stated where it
   matters — see the note on TRUST_PROXY below.
  ------------------------------------------------------------------- */

const crypto = require('crypto');

/* ------------------------- client identity ------------------------ */

/* Rate limiting is only as good as the address it keys on, so the rule
   for trusting a forwarded header has to be explicit rather than
   optimistic.

   Behind a platform proxy (Railway, Hostinger, nginx) every socket looks
   like the same handful of egress addresses, so keying on
   req.socket.remoteAddress alone would lump every visitor into one
   bucket and the first busy customer would rate-limit everybody. That
   is why TRUST_PROXY defaults on outside development.

   The cost of trusting the header is that a direct client can forge
   X-Forwarded-For and walk around a per-IP limit. That is acceptable
   here because the credential-facing limits (see loginThrottle) are
   ALSO keyed on the account being targeted, which no header can forge —
   so a spoofed address buys an attacker nothing against password
   guessing, only against bulk spam. Set TRUST_PROXY=0 only when nothing
   sits in front of this process. */
const TRUST_PROXY = /^(0|false|no|off)$/i.test(
  String(process.env.TRUST_PROXY ?? (process.env.NODE_ENV === 'production' ? '1' : '0')).trim()
) ? false : true;

function normaliseIp(value) {
  let ip = String(value || '').trim();
  if (!ip) return 'unknown';
  /* An IPv4-mapped IPv6 address (::ffff:203.0.113.7) and its bare IPv4
     form are the same client; folding them keeps one visitor from
     holding two independent buckets. */
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip.slice(0, 64);
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '');
    if (fwd) {
      /* Left-most entry is the original client; everything after it was
         appended by proxies on the way in. */
      return normaliseIp(fwd.split(',')[0]);
    }
  }
  return normaliseIp(req.socket && req.socket.remoteAddress);
}

/* ----------------------------- rate limit -------------------------- */

/* A fixed-window counter would let a client send the whole allowance at
   11:59:59 and again at 12:00:00, so each key keeps its own expiry and
   is checked against a continuous window instead. */

class RateLimiter {
  constructor({ limit, windowMs, name = 'requests' }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.name = name;
    this.hits = new Map();
  }

  /* Returns { ok, remaining, retryAfterSec }. */
  hit(key, cost = 1) {
    const now = Date.now();
    const rec = this.hits.get(key);
    if (!rec || rec.reset <= now) {
      this.hits.set(key, { count: cost, reset: now + this.windowMs });
      return { ok: true, remaining: Math.max(0, this.limit - cost), retryAfterSec: 0 };
    }
    rec.count += cost;
    return rec.count <= this.limit
      ? { ok: true, remaining: this.limit - rec.count, retryAfterSec: 0 }
      : { ok: false, remaining: 0, retryAfterSec: Math.ceil((rec.reset - now) / 1000) };
  }

  reset(key) {
    this.hits.delete(key);
  }

  /* Without this the Map grows for the life of the process, one entry
     per address that ever appeared. */
  sweep() {
    const now = Date.now();
    for (const [key, rec] of this.hits) if (rec.reset <= now) this.hits.delete(key);
  }
}

/* Sweep on a timer rather than per-request so a burst of traffic does
   not pay for the cleanup. unref() keeps the timer from holding the
   process open on shutdown. */
function startSweeper(limiters, everyMs = 60_000) {
  const t = setInterval(() => {
    for (const l of limiters) l.sweep();
  }, everyMs);
  if (t.unref) t.unref();
  return t;
}

/* -------------------------- login throttle ------------------------- */

/* Failed admin sign-ins are counted per ACCOUNT and per ADDRESS, and a
   run of failures locks that pair out for a cooling-off period.

   Keying on the account as well as the address is the part that matters:
   an attacker can rotate X-Forwarded-For to get a fresh per-IP budget,
   but they still have to guess one password, and the account bucket
   keeps counting no matter where the request claims to come from. A
   successful sign-in clears the account's record. */
class LoginThrottle {
  constructor({ maxFails = 5, windowMs = 15 * 60_000, lockMs = 15 * 60_000 } = {}) {
    this.maxFails = maxFails;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    this.fails = new Map();
  }

  key(email, ip) { return `${String(email || '').toLowerCase()}|${ip}`; }

  /* Returns { locked, retryAfterSec }. */
  check(email, ip) {
    const rec = this.fails.get(this.key(email, ip));
    if (!rec) return { locked: false, retryAfterSec: 0 };
    const now = Date.now();
    if (rec.lockedUntil && rec.lockedUntil > now) {
      return { locked: true, retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000) };
    }
    if (rec.lockedUntil && rec.lockedUntil <= now) {
      /* Lockout served — start the record again rather than forgetting
         it, so the next failure does not buy a full fresh allowance. */
      rec.lockedUntil = 0;
      rec.count = 0;
      rec.reset = now + this.windowMs;
    }
    if (rec.reset <= now) { this.fails.delete(this.key(email, ip)); }
    return { locked: false, retryAfterSec: 0 };
  }

  fail(email, ip) {
    const k = this.key(email, ip);
    const now = Date.now();
    const rec = this.fails.get(k) || { count: 0, reset: now + this.windowMs, lockedUntil: 0 };
    if (rec.reset <= now) { rec.count = 0; rec.reset = now + this.windowMs; }
    rec.count += 1;
    /* Lockout time doubles per repeat offence, so a persistent attacker
       gets locked out for longer each round while a person who simply
       mistyped twice waits the same short while. */
    if (rec.count >= this.maxFails) {
      const over = rec.count - this.maxFails;
      rec.lockedUntil = now + Math.min(this.lockMs * Math.pow(2, Math.min(over, 5)), this.lockMs * 32);
    }
    this.fails.set(k, rec);
    return rec;
  }

  success(email, ip) { this.fails.delete(this.key(email, ip)); }

  sweep() {
    const now = Date.now();
    for (const [k, rec] of this.fails) {
      if ((rec.lockedUntil || 0) <= now && rec.reset <= now) this.fails.delete(k);
    }
  }
}

/* ------------------------------- CSRF ------------------------------- */

/* This API is JSON-only. Two independent checks, either of which alone
   stops a cross-site form attack:

   1. Content-Type. A HTML form can only produce
      application/x-www-form-urlencoded, multipart/form-data or
      text/plain. Requiring application/json on anything that changes
      state means a form cannot reach these routes at all — a scripted
      cross-origin request would need a CORS preflight first, and this
      server answers no preflight.

   2. Origin / Referer. Belt and braces for clients that omit the
      header, and the check that also covers a same-site subdomain
      attacker, who CAN send JSON but cannot forge Origin in a browser.

   Combined with SameSite=Lax on the session cookie, an attacker's page
   gets no cookie, no content type and no origin. */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isStateChanging(req) {
  return !SAFE_METHODS.has(String(req.method || 'GET').toUpperCase());
}

function sameOrigin(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!host) return false;
  const origin = String(req.headers.origin || '').toLowerCase();
  if (origin) {
    try { return new URL(origin).host.toLowerCase() === host; }
    catch { return false; }
  }
  /* No Origin: some older browsers omit it on same-origin form posts.
     Referer is the fallback — and its ABSENCE is a refusal, because
     every real request from this site sends one. */
  const ref = String(req.headers.referer || '').toLowerCase();
  if (!ref) return false;
  try { return new URL(ref).host.toLowerCase() === host; }
  catch { return false; }
}

function isJsonRequest(req) {
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  return ct === 'application/json';
}

/* Returns 0 when the request may proceed, or a status code to refuse
   with. 403 for a cross-site attempt — the caller must not help the
   sender tell "wrong origin" from "wrong content type" beyond what a
   plain refusal already tells them. */
function csrfCheck(req) {
  if (!isStateChanging(req)) return 0;

  /* A request with no session cookie is not a CSRF target: the danger
     is acting AS someone, and with no cookie there is no one to act as.
     The route's own auth guard still applies. */
  const hasSession = String(req.headers.cookie || '').includes('_reddy_session=');
  if (!hasSession) return 0;

  if (!sameOrigin(req)) return 403;
  /* Only block non-JSON when there is actually a body to forge.
     Empty-body requests (logout, DELETE) are safe from form-based CSRF
     because a cross-origin form cannot smuggle state through them. */
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const contentLength = parseInt(req.headers['content-length'] || '0', 10) || 0;
  if (contentLength > 0 && ct !== 'application/json') return 403;
  return 0;
}

/* --------------------------- concurrency --------------------------- */

/* The admin password is checked with scrypt, which is deliberately
   expensive. Doing that work concurrently without a ceiling lets a
   burst of requests occupy every libuv thread at once and starve the
   rest of the process of CPU — the same denial of service, reached
   through the threadpool instead of the event loop.

   Queuing the surplus is the point: an unbounded flood becomes a slow
   trickle that the other requests interleave with, rather than a wall. */
class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }

  async run(fn) {
    if (this.active >= this.limit) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.active += 1;
    try { return await fn(); }
    finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

module.exports = {
  TRUST_PROXY,
  clientIp,
  normaliseIp,
  RateLimiter,
  LoginThrottle,
  Semaphore,
  startSweeper,
  csrfCheck,
  sameOrigin,
  isJsonRequest,
  isStateChanging,
};
