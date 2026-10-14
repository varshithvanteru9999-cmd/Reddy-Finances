/* ------------------------------------------------------------------
   Service worker — the minimum an installable app needs.

   Deliberately conservative: it caches the shell (pages, CSS, JS, the
   logo) so the app opens without a connection, but NEVER caches an API
   response. Bookings, availability and notifications must always come
   from the server — a stale booking list would be worse than an error.
------------------------------------------------------------------- */

const CACHE = 'reddy-v34';

/* bookings.html and profile.html are deliberately NOT here: both show
   one signed-in customer's own data, so a cached copy can outlive a
   sign-out or a code change and leave the page showing nothing — or,
   worse, the wrong person's view. They are always fetched fresh. */
const SHELL = [
  '/index.html',
  '/car.html',
  '/credits.html',
  '/css/style.css',
  '/js/data.js',
  '/js/billing.js',
  '/js/store.js',
  '/js/ui.js',
  '/js/auth.js',
  '/js/notify.js',
  '/js/app.js',
  '/images/brand/logo-trimmed.png',
  '/images/brand/car-mark.png',
  '/images/icons/icon-192.png'
];

self.addEventListener('install', event => {
  /* A missing file must not abort the whole install, so add them
     individually and tolerate failures. */
  event.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /* Live data and anything private is never served from cache.
     The admin assets are matched by filename as well as by path: they
     live at /js/admin.js and /css/admin.css, neither of which starts
     with '/admin', so a path test alone would quietly cache them and
     keep serving a stale admin panel after a deploy. The admin panel
     is staff-only and always online, so it gains nothing from the
     offline shell and only suffers from it. */
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/uploads/') ||
      url.pathname.startsWith('/admin') ||
      /\/admin[^/]*\.(js|css)$/.test(url.pathname) ||
      /^\/(bookings|profile)\.html$/.test(url.pathname)) {
    return;
  }

  /* Video goes straight to the network, never through here.
     A <video> asks for byte ranges, and the server answers 206. Caching
     cannot help with that: a stored 200 replayed against a Range request
     hands the browser a whole file where it asked for a slice, which
     Safari and iOS refuse to play. And the offline fallback below would
     answer a failed range request with index.html — HTML arriving where
     the decoder expects video, which kills the element for good. The
     clips are ~10MB each; they have no business in the offline shell. */
  if (request.destination === 'video' ||
      request.destination === 'audio' ||
      request.headers.has('range') ||
      /\.(mp4|webm|ogg|ogv|mov|m4v)$/i.test(url.pathname)) {
    return;
  }

  /* Network first, cache as the fallback — so an online visitor always
     sees the current site, and an offline one still sees something. */
  event.respondWith(
    fetch(request)
      .then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request).then(hit => hit || caches.match('/index.html')))
  );
});
