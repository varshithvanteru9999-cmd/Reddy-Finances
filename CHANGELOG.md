# Project Memory — Reddy Finances (Car Rental & Sale)

> This file is a manual record of the project so future sessions have context.
> Update it whenever significant changes/addons are made.

## Overview
A car rental & sale web app branded "Reddy Finances". Built as a static
front-end served by a small Node `http` server that also exposes a JSON API
backed by MySQL.

Run with: `node server/index.js`  ->  http://localhost:5500

## Stack
- Node.js (built-in `http`, no Express)
- MySQL2 connection pool (parameterised queries)
- Plain HTML/CSS/JS front-end (no framework)
- Tiny hand-rolled .env reader (no dotenv dependency)

## File map
- `server/index.js` — static server + JSON API (port 5500), path-traversal
  protection, range requests for video, 8MB body limit.
- `server/db.js` — MySQL pool + all queries; customer match on
  email/phone/name; booking date-conflict check; soft-delete for vehicles
  that have bookings.
- `js/app.js` — main site logic (most recently edited).
- `js/admin.js` — admin dashboard.
- `js/billing.js` — shared billing/quote engine (used by API + front-end).
- `js/charts.js`, `js/data.js`, `js/store.js`, `js/ui.js`, `js/car.js`
- `admin.html`, `index.html`, `car.html`, `sign-contract.html`
- `db/schema.sql`, `db/migrate-001.sql`, `db/migrate-002-contracts.sql`, `db/seed.sql`, `db/make-seed.js`
- `db/add-fake-bookings.js` — one-off script to POST fake bookings via the API.
- `uploads/contracts/` — generated and signed contract PDFs.
- `uploads/licenses/` — customer uploaded driver licenses.

## API endpoints
- GET  /api/health
- Vehicles: GET /api/vehicles, POST, PUT /api/vehicles/:id,
  POST /api/vehicles/:id/odometer, DELETE /api/vehicles/:id
- Bookings: GET /api/bookings, GET /api/bookings/upcoming,
  GET /api/bookings/pending-contracts,
  POST /api/bookings/quote, POST /api/bookings/:id/release,
  POST /api/bookings/:id/send-contract,
  POST, PUT /api/bookings/:id, DELETE /api/bookings/:id
- Contracts: GET /api/contracts/preview?ref=BK-####,
  POST /api/contracts/upload
- POST /api/enquiries

## DB notes
- DB name default: `reddy_finances` (configurable via .env: DB_HOST, DB_PORT,
  DB_USER, DB_PASSWORD, DB_NAME)
- Customers deduplicated by email -> phone -> name.
- Bookings reference format: `BK-####` (starts at 1041).
- Vehicles soft-deleted (is_active=0) if they have bookings.
- View `vw_upcoming_releases` feeds the upcoming-releases API.

## Change log
- (Initial build) Full app: server, API, DB schema/seed, front-end pages.
- Bookings tab: added Month (name) + Year dropdown filters alongside status +
  search. Filtering is by the booking's "From" date. Year options are derived
   from the bookings on file (plus current year).
- BUG FIX: admin.js declared `const MONTHS`, which already existed in
  billing.js. The duplicate broke the whole admin.js (SyntaxError), making
  all buttons unresponsive. Removed the duplicate; reuse billing.js MONTHS.
- Bookings Month/Year filters now match by RANGE OVERLAP, not just the
  start date. A booking 2025-08-12 -> 2025-09-30 appears in both the
  August and September reports. Year dropdown also lists years from the
   booking's end date (cross-year bookings show in both years).
- Bookings toolbar: added an "All" toggle button (left of the month
  dropdown). Selecting a month then clicking All switches to a CUMULATIVE
  report — every booking touching the selected month OR any earlier one
  (e.g. month=August → August starts, longer rentals running into August,
   and anything booked before). Button turns red when active; disabled when
   the month is "All months".
- Added 15 fake customer bookings (BK-1048..BK-1062) via the API for
  testing the filters, spread across 2025 (May-Dec, incl. cross-year
  Grace Osei Dec28-Jan4 and multi-month James Whitfield Aug12-Sep30) and
  2026 (Jan-Dec, incl. Emily Tran May20-Aug15). Script: db/add-fake-bookings.js.
- Bookings table: added a "Month" column. When a specific month is selected
  (and it overlaps the booking), it shows that booking's PRORATED amount for
  the month: monthly rate / 30 x nights occupied in that month (billing
  DIVISOR is always 30). E.g. rental 12 Aug -> 30 Sep @ $2400/mo shows
  $1600 for Aug (20 nights) and $2400 for Sep (full month). Sales show the
  one-off asking price. The Month column prorates EVERY month per-day (incl.
  full months: a full Aug @ $2400/mo shows $2480 = 2400/30 x 31 in the report
   column only) — stored billing/quotes stay flat for full months.
- **CUSTOMER BOOKING (end-to-end):** the car detail page (car.html)
  now has a fully functional booking form for rentals: pick-up/return
  dates, customer name + email/phone, a live quote panel (via
  POST /api/bookings/quote), and a "Confirm booking" button that
  creates a Prebooked reservation via POST /api/bookings. Sales show
  a "Request a viewing" form that creates an enquiry. The booking
  appears in the admin dashboard immediately. Notice-day and date
  validation run client-side. Added `esc` helper, `user` icon,
  debounce utility, and light-mode booking CSS to ui.js / style.css.
- **ADMIN ACTIONS TAB:** a new "Actions" tab shows every rental and sale
  booking with quick one-click status-change buttons: Confirm (Prebooked
  → Confirmed), Release (Confirmed → Active, with timestamp), Complete
  (Active → Completed), Cancel. A "Confirm all" bulk button confirms
  every Prebooked reservation in one shot. Search and status filter
  included. Actions tab is refreshed on every booking change across
  all tabs. Blue = confirm, green = release, purple = complete.
- **ACTIONS RE-WORK (icon-based):** Action buttons replaced with simple
  ✓/✗/⏳ symbol controls. Prebooked → ✓ approve, ✗ reject, ⏳ send
  confirmation. Confirmed → ✓ release, ✗ reject. Active → ✓ complete,
  ✗ cancel. The ⏳ clock marks a booking "under confirmation" (new
  `confirmation_sent` column, POST /api/bookings/:ref/confirm) and sends
  the customer the confirmation message without changing status; a purple
  "Under confirmation" pill is shown.
- **INLINE TOLLS:** the Bookings table's Tolls cell is now an editable
  number input. The admin types an amount and it saves straight to the
  booking via PUT (Enter/blur commits), no need to open the Edit sheet.
  Total and Month amounts refresh immediately after saving.
- **CONTRACT EMAIL & E-SIGN:** admin Actions tab now has a "Send Contract"
  button (file icon) for Confirmed/Active rental bookings. Clicking it
  generates a PDF from the contract template with booking details filled
  in (customer name, vehicle, dates, rate), saves it to uploads/contracts/,
  records it in the new `contract_documents` table, marks the booking's
  `contract_sent_at`, and emails the PDF to the customer with a link to
  sign and upload. If Gmail credentials are not configured, the PDF is
  still generated and saved — the email error is logged but non-fatal.
- **CUSTOMER SIGNING PAGE:** `/sign-contract.html?ref=BK-####` is a
  standalone page where the customer can view the contract PDF, upload
  the signed copy, and upload their driver's license. Files are stored in
  `uploads/contracts/` and `uploads/licenses/`. Admin gets an email
  notification (non-fatal if SMTP fails). A 3-step progress indicator
  guides the user through Review → Sign & Upload → Complete.
- **UPLOAD API:** POST /api/contracts/upload accepts base64-encoded
  contract PDF and license file, saves them to disk, records in
  `contract_documents` and `license_uploads` tables, updates
  `contract_signed_at` and `license_uploaded_at` on the booking.
- **CONTRACT PREVIEW:** GET /api/contracts/preview?ref=BK-#### serves
  the generated contract PDF for inline viewing or downloading.
- **DB MIGRATION 002:** adds `contract_documents` and `license_uploads`
  tables, plus `contract_sent_at`, `contract_signed_at`,
  `license_uploaded_at` columns on bookings. Safe to re-run.
- **ADMIN STATUS PILLS:** Actions tab now shows "Contract Sent" (amber)
  and "Contract Signed" / "License ✓" (green) pills per booking row.
  Send Contract button is blue, disabled when customer has no email.
- **FIREBASE AUTH (replaces Google OAuth):** customer sign-in now goes
  through Firebase Authentication instead of the server-side Google
  redirect flow.
  - Server: `server/auth.js` verifies Firebase ID tokens via the Admin
    SDK (`firebase-admin`) and still issues the same signed HttpOnly
    session cookie. New `POST /api/auth/firebase` (token -> session) and
    `GET /api/auth/config` (serves the public web config to bootstrap
    the JS SDK). Removed `/api/auth/google` and the OAuth callback.
  - Client: `js/auth.js` signs in with the Firebase JS SDK Google
    provider popup, POSTs the ID token to the server, and keeps the
    `Auth`/`ensureSignedIn` interface — pages are unchanged.
  - Vendored Firebase JS SDK into `js/vendor/` (firebase-app-compat.js,
    firebase-auth-compat.js); included on index.html, car.html, temp.html.
  - New env vars (see .env.example): FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN,
    FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.
  - Not yet configured here: `.env` values are blank until the Firebase
    project is created (guides in .env.example).
- **FIREBASE CONFIG + FIXES:** project `reddy-finance-cbf47` wired into
  `.env` (hosted web config + service account key, never committed).
  - firebase-admin v14 dropped `admin.credential.cert()` / `app.auth()`;
    now uses modular imports `firebase-admin/app` (`cert`) and
    `firebase-admin/auth` (`getAuth`). This was the cause of the first
    "invalid or expired token" — verification silently failed.
  - Sign-in uses the Firebase POPUP flow (Google window) with a 60s
    timeout + visible error codes. Initially switched to
    `signInWithRedirect` but that round-trip is unreliable over
    http://localhost (returned logged out), so it was reverted to popup.
  - Verified: server accepts real Google-signed ID tokens (minted via
    Admin SDK custom token + REST exchange) and issues the session
    cookie; headless Chrome shows the modal + popup fire correctly.
