/* ------------------------------------------------------------------
   Reddy Finances — static files + JSON API on one port.

   Node's built-in http is plenty here; adding Express would be a
   second dependency for routing we can write in forty lines.

     node server/index.js       ->  http://localhost:5500
------------------------------------------------------------------- */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const db = require('./db');
const auth = require('./auth');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 5500);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8'
};

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      /* refuse to buffer an unbounded upload */
      if (raw.length > 50e6) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/* ----------------------------- guards ----------------------------- */

/* Every guard returns the user on success, or null after having already
   answered the request — so callers do `const u = requireX(...); if (!u) return;`

   Auth being unconfigured is a 503, never an open door: a half-set-up
   server must refuse rather than serve customer records to the world. */

/* ------------------------------------------------------------------
   LOCAL DEVELOPMENT ESCAPE HATCH

   Set OPEN_ADMIN=1 in .env to switch every admin check off, so the
   dashboard opens without signing in. It exists to keep local work
   moving, and it is dangerous anywhere else: with it on, ANYONE who
   can reach this server reads every customer's name, email, phone and
   driving-licence number, and can edit or delete bookings.

   Before this goes anywhere other people can reach: delete the line
   from .env (or set it to 0) and set ADMIN_EMAILS instead. The server
   prints a warning on every start while it is on.
------------------------------------------------------------------- */
const OPEN_ADMIN = /^(1|true|yes)$/i.test(String(db.envValue('OPEN_ADMIN') || '').trim());

/* Who OPEN_ADMIN signs you in as. Defaults to a throwaway identity,
   but a real address lets the customer pages show that customer's own
   bookings — which is the point of the switch during local work.
   Ignored entirely unless OPEN_ADMIN is on. */
const OPEN_ADMIN_EMAIL =
  String(db.envValue('OPEN_ADMIN_EMAIL') || '').trim() || 'dev@localhost';

function requireUser(req, res) {
  /* A real session always wins. OPEN_ADMIN only stands in when nobody
     is signed in — otherwise a signed-in customer would be replaced by
     the stand-in identity and see none of their own bookings. */
  const user = auth.isConfigured() ? auth.userFromRequest(req) : null;
  if (user) return user;

  if (OPEN_ADMIN) {
    return { email: OPEN_ADMIN_EMAIL, name: 'Local developer', id: 'dev' };
  }

  if (!auth.isConfigured()) {
    json(res, 503, { error: 'Authentication is not configured on the server' });
    return null;
  }
  json(res, 401, { error: 'Please sign in to continue' });
  return null;
}

function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (OPEN_ADMIN) return user;
  if (!auth.hasAdmins()) {
    json(res, 503, { error: 'No administrators are configured (set ADMIN_EMAILS)' });
    return null;
  }
  if (!auth.isAdmin(user)) {
    json(res, 403, { error: 'Administrator access required' });
    return null;
  }
  return user;
}

/* A customer may only touch their OWN booking. Admins may touch any.
   Matching is on the booking's email, which is what the session carries. */
async function requireBookingAccess(req, res, ref) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (auth.hasAdmins() && auth.isAdmin(user)) return user;

  const owner = await db.bookingOwnerEmail(ref);
  if (!owner) {
    json(res, 404, { error: 'Booking not found' });
    return null;
  }
  if (!user.email || owner.toLowerCase() !== String(user.email).toLowerCase()) {
    json(res, 403, { error: 'This booking belongs to another account' });
    return null;
  }
  return user;
}

/* ------------------------------- API ------------------------------ */

async function api(req, res, url) {
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const [resource, id] = seg;
  const method = req.method;

  if (resource === 'health') {
    return json(res, 200, { ok: true, mysql: await db.ping() });
  }

  if (resource === 'all-photos') {
    if (!requireAdmin(req, res)) return;
    return json(res, 200, await db.allBookingsWithPhotos());
  }

  if (resource === 'vehicles') {
    /* Booked date ranges per car, so the listing can show what is taken.
       Public, and deliberately carries no customer details. */
    if (method === 'GET' && id === 'availability') {
      return json(res, 200, await db.vehicleAvailability());
    }
    /* Every car currently booked, with who has it and what they owe —
       the Release tab's main list. */
    if (method === 'GET' && id === 'booked') {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, await db.bookedVehicles());
    }

    /* Cars whose renter has given return notice, waiting to be opened
       up for the next customer. */
    if (method === 'GET' && id === 'awaiting-release') {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, await db.awaitingRelease());
    }

    /* Open / close a car for pre-booking. */
    if (method === 'POST' && seg[2] === 'release') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 200, await db.releaseVehicle(
          decodeURIComponent(id), body.availableFrom, body.prebookingAmount
        ));
      } catch (err) {
        return json(res, err.status || 500, { error: err.message });
      }
    }
    /* Free the car for ordinary booking — the no-show case. Cancels
       the booking holding the dates, so the car returns to the site
       without any pre-booking step. */
    if (method === 'POST' && seg[2] === 'release-normal') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 200, await db.releaseForNormalBooking(
          decodeURIComponent(id), { reference: body.reference || null }));
      } catch (err) {
        return json(res, err.status || 500, { error: err.message });
      }
    }

    if (method === 'POST' && seg[2] === 'unrelease') {
      if (!requireAdmin(req, res)) return;
      const ok = await db.unreleaseVehicle(decodeURIComponent(id));
      return ok ? json(res, 200, { slug: id, released: false })
                : json(res, 404, { error: 'Vehicle not found' });
    }

    /* The listing is the public shop window; everything that writes to it
       is administrators only. */
    /* The registration number is an internal detail, and this endpoint is
       the public shop window — so the plate is attached only once the
       caller is a signed-in admin, never for an anonymous visitor. */
    if (method === 'GET') {
      const isAdmin = auth.isConfigured() && auth.isAdmin(auth.userFromRequest(req));
      return json(res, 200, await db.listVehicles({ includeRegistration: isAdmin }));
    }
    if (method === 'PUT' && id) {
      if (!requireAdmin(req, res)) return;
      const ok = await db.updateVehicle(decodeURIComponent(id), await readBody(req));
      return ok ? json(res, 200, { id }) : json(res, 404, { error: 'Vehicle not found' });
    }
    if (method === 'POST' && seg[2] === 'odometer') {
      if (!requireAdmin(req, res)) return;
      const { miles } = await readBody(req);
      const n = Number(miles);
      if (!Number.isFinite(n) || n < 0) return json(res, 400, { error: 'Miles must be zero or more' });
      const ok = await db.setOdometer(decodeURIComponent(id), Math.round(n));
      return ok ? json(res, 200, { id, miles: Math.round(n) })
                : json(res, 404, { error: 'Vehicle not found' });
    }
    if (method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      if (!body.id || !body.name) return json(res, 400, { error: 'id and name are required' });
      await db.createVehicle(body);
      return json(res, 201, { id: body.id });
    }
    if (method === 'DELETE' && id) {
      if (!requireAdmin(req, res)) return;
      const out = await db.deleteVehicle(decodeURIComponent(id));
      return out.ok ? json(res, 200, out) : json(res, 404, { error: 'Vehicle not found' });
    }
  }

  if (resource === 'bookings') {
    /* Bulk toll entry: upload the authority's statement and have each
       charge land on the booking that had the car. Previews by default —
       nothing is written until the admin confirms with apply: true. */
    if (method === 'POST' && id === 'import-tolls') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      if (!body.file || !body.file.data) {
        return json(res, 400, { error: 'No file was uploaded.' });
      }
      let buffer;
      try {
        buffer = Buffer.from(body.file.data, 'base64');
      } catch {
        return json(res, 400, { error: 'That file could not be read.' });
      }
      if (!buffer.length) return json(res, 400, { error: 'That file is empty.' });
      if (buffer.length > 8e6) return json(res, 413, { error: 'That file is too large (8MB limit).' });

      try {
        return json(res, 200, await db.importTollSheet(buffer, String(body.file.name || ''), {
          apply: body.apply === true,
          on: body.on
        }));
      } catch (err) {
        return json(res, err.status || 400, { error: err.message });
      }
    }

    /* A customer's own bookings — the My Profile page. Scoped to the
       signed-in email, so it needs no admin rights and can never show
       anyone else's reservation. */
    if (method === 'GET' && id === 'mine') {
      const user = requireUser(req, res);
      if (!user) return;
      return json(res, 200, await db.bookingsForCustomer(user.email));
    }

    /* These three expose every customer's name, contact details and
       licence number, so they are administrators only. */
    if (method === 'GET' && id === 'upcoming') {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, await db.upcomingReleases());
    }
    if (method === 'GET' && id === 'pending-contracts') {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, await db.listPendingContracts());
    }
    /* Everyone queued for a released car, oldest request first. */
    if (method === 'GET' && id === 'prebooking-queue') {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, await db.prebookingQueue());
    }
    /* How many proofs each booking has — one query for the whole table
       so the dashboard can badge rows without a request per row. */
    if (method === 'GET' && id === 'payment-proof-counts') {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, await db.paymentProofCounts());
    }

    /* An admin agrees with a proof's amount. The only place a scanned
       figure is allowed to change a balance. */
    if (method === 'POST' && seg[2] === 'payment-proof' && seg[3] === 'verify') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 200, await db.verifyPaymentProof(body.proofId, {
          amount: body.amount, applyShortfall: body.applyShortfall !== false
        }));
      } catch (err) {
        return json(res, err.status || 500, { error: err.message });
      }
    }

    /* Cash taken at the counter, with the amount. It joins the same
       ledger as an uploaded transfer, so a booking paid partly each
       way adds up instead of one channel overwriting the other. */
    if (method === 'POST' && seg[2] === 'cash-payment') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 200, await db.addCashPayment(decodeURIComponent(id), {
          amount: body.amount, note: body.note, pending: body.pending
        }));
      } catch (err) {
        return json(res, err.status || 500, { error: err.message });
      }
    }

    /* What this booking owes and has taken, across both channels. */
    /* Everything behind the Ref link: contact, referral and the full
       payment ledger. Admin only — it carries a licence number and a
       payment history. */
    if (method === 'GET' && seg[2] === 'detail') {
      if (!requireAdmin(req, res)) return;
      try {
        return json(res, 200, await db.bookingDetail(decodeURIComponent(id)));
      } catch (err) {
        return json(res, err.status || 500, { error: err.message });
      }
    }
    if (method === 'POST' && seg[2] === 'referral') {
      if (!requireAdmin(req, res)) return;
      try {
        const body = await readBody(req);
        return json(res, 200, await db.setReferral(decodeURIComponent(id), body));
      } catch (err) {
        return json(res, err.status || 500, { error: err.message });
      }
    }
    if (method === 'GET' && seg[2] === 'settlement') {
      if (!requireAdmin(req, res)) return;
      try {
        return json(res, 200, await db.settlement(decodeURIComponent(id)));
      } catch (err) {
        return json(res, err.status || 500, { error: err.message });
      }
    }

    /* Cash taken at the counter — the office records it directly. */
    if (method === 'POST' && seg[2] === 'payment-method') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 200, await db.setPaymentMethod(decodeURIComponent(id), body.method));
      } catch (err) {
        return json(res, err.status || 500, { error: err.message });
      }
    }

    /* The proofs on one booking — its own customer, or an admin. */
    if (method === 'GET' && seg[2] === 'payment-proof') {
      if (!await requireBookingAccess(req, res, decodeURIComponent(id))) return;
      return json(res, 200, await db.paymentProofs(decodeURIComponent(id)));
    }

    if (method === 'GET') {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, await db.listBookings());
    }
    if (method === 'POST' && id === 'quote') {
      /* Public endpoint — the car page quotes with it. Only the
         dashboard gets the advance back, and that is decided here from
         the session rather than from anything the caller sends. */
      const body = await readBody(req);
      const isAdmin = auth.isConfigured() && auth.isAdmin(auth.userFromRequest(req));
      return json(res, 200, await db.quoteBooking({ ...body, includeAdvance: isAdmin }));
    }
    if (method === 'POST' && seg[2] === 'release') {
      if (!requireAdmin(req, res)) return;
      const ok = await db.releaseBooking(decodeURIComponent(id));
      return ok ? json(res, 200, { id, status: 'Confirmed' })
                : json(res, 409, { error: 'Not a pre-booking, or already released' });
    }
    /* Send the slot confirmation email — dates, total and pick-up
       point. A step of its own: approving onboards the booking, this
       tells the customer where to turn up. */
    if (method === 'POST' && seg[2] === 'slot-confirmation') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 200, await db.sendSlotConfirmationEmail(
          decodeURIComponent(id), body.pickupLocation));
      } catch (err) {
        return json(res, err.status || 500,
                    { error: err.message || 'Could not send the confirmation' });
      }
    }

    /* The handover — the customer has collected the car. Moves the
       booking Confirmed -> Active, and so into the Bookings tab. */
    if (method === 'POST' && seg[2] === 'handover') {
      if (!requireAdmin(req, res)) return;
      try {
        return json(res, 200, await db.handoverBooking(decodeURIComponent(id)));
      } catch (err) {
        return json(res, err.status || 500,
                    { error: err.message || 'Could not record the handover' });
      }
    }

    if (method === 'POST' && seg[2] === 'confirm') {
      if (!requireAdmin(req, res)) return;
      const ok = await db.markConfirmationSent(decodeURIComponent(id));
      return ok ? json(res, 200, { id, confirmationSent: true })
                : json(res, 404, { error: 'Booking not found' });
    }
    if (method === 'POST' && seg[2] === 'prebooking-paid') {
      if (!requireAdmin(req, res)) return;
      try {
        const out = await db.markPrebookingPaid(decodeURIComponent(id));
        return json(res, 200, out);
      } catch (err) {
        return json(res, err.status || 500, { error: err.message });
      }
    }
    /* The renter announces their return — 10 days notice minimum.
       Either the customer themselves or the office may file it. */
    if (method === 'POST' && seg[2] === 'return-notice') {
      if (!await requireBookingAccess(req, res, decodeURIComponent(id))) return;
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 200, await db.giveReturnNotice(
          decodeURIComponent(id), body.expectedReturnOn
        ));
      } catch (err) {
        return json(res, err.status || 500, { error: err.message });
      }
    }

    /* Approve or reject, by hand, one booking at a time. */
    if (method === 'POST' && (seg[2] === 'approve' || seg[2] === 'reject')) {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req).catch(() => ({}));
      try {
        const out = await db.decideBooking(
          decodeURIComponent(id), seg[2] === 'approve', body.reason, body.force,
          body.pickupLocation
        );
        return json(res, 200, out);
      } catch (err) {
        return json(res, err.status || 500, { error: err.message || 'Could not update booking' });
      }
    }
    /* Email the toll statement on its own — tolls are billed monthly,
       after the rental invoice has already gone out. */
    if (method === 'POST' && seg[2] === 'toll-invoice') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 200, await db.sendTollInvoice(decodeURIComponent(id), {
          period: body.period || null, amount: body.amount, notes: body.notes
        }));
      } catch (err) {
        return json(res, err.status || 500, { error: err.message || 'Could not send the toll statement' });
      }
    }

    /* Email the invoice: rental total, toll fees, and the sum. */
    if (method === 'POST' && seg[2] === 'invoice') {
      if (!requireAdmin(req, res)) return;
      try {
        const body = await readBody(req).catch(() => ({}));
        return json(res, 200, await db.sendInvoice(decodeURIComponent(id), body || {}));
      } catch (err) {
        return json(res, err.status || 500, { error: err.message || 'Could not send the invoice' });
      }
    }

    if (method === 'POST' && seg[2] === 'send-contract') {
      if (!requireAdmin(req, res)) return;
      const result = await db.sendContractEmail(decodeURIComponent(id));
      return json(res, 200, result);
    }
    /* Proof of payment. The customer uploads it from My Bookings once
       their rental is approved; the office reviews it in the dashboard.
       requireBookingAccess lets the booking's own customer through and
       keeps everyone else out. */
    if (method === 'POST' && seg[2] === 'payment-proof') {
      if (!await requireBookingAccess(req, res, decodeURIComponent(id))) return;
      const body = await readBody(req);
      if (!body.file || !body.file.data) {
        return json(res, 400, { error: 'A photo of the payment is required.' });
      }
      let buffer;
      try { buffer = Buffer.from(body.file.data, 'base64'); }
      catch { return json(res, 400, { error: 'That image could not be read.' }); }
      if (!buffer.length) return json(res, 400, { error: 'That image is empty.' });
      if (buffer.length > 8e6) return json(res, 413, { error: 'That image is too large (8MB limit).' });

      const file = {
        buffer,
        originalname: body.file.name,
        size: body.file.size,
        mimetype: body.file.type
      };
      try {
        return json(res, 200, await db.addPaymentProof(decodeURIComponent(id), file, {
          amount: body.amount, note: body.note,
          stage: body.stage, expected: body.expected
        }));
      } catch (err) {
        return json(res, err.status || 500, { error: err.message });
      }
    }

    /* Damage photos — any number per booking, each with an optional
       note. Same access gate as the condition photos: the booking's
       own customer, or an admin. */
    if (seg[2] === 'damage-photos') {
      if (!await requireBookingAccess(req, res, decodeURIComponent(id))) return;

      if (method === 'GET') {
        try {
          return json(res, 200, await db.damagePhotos(decodeURIComponent(id)));
        } catch (err) {
          return json(res, err.status || 500, { error: err.message });
        }
      }

      if (method === 'POST') {
        const body = await readBody(req);
        if (!body.file || !body.file.data) {
          return json(res, 400, { error: 'File data is required' });
        }
        const stage = body.stage === 'return' ? 'return' : 'pickup';
        const file = {
          buffer: Buffer.from(body.file.data, 'base64'),
          originalname: body.file.name,
          size: body.file.size,
          mimetype: body.file.type
        };
        try {
          return json(res, 200,
            await db.addDamagePhoto(decodeURIComponent(id), stage, file, body.note));
        } catch (err) {
          return json(res, err.status || 500, { error: err.message });
        }
      }

      if (method === 'DELETE') {
        try {
          return json(res, 200,
            await db.deleteDamagePhoto(decodeURIComponent(id), seg[3]));
        } catch (err) {
          return json(res, err.status || 500, { error: err.message });
        }
      }
    }

    if (method === 'POST' && seg[2] === 'photos') {
      if (!await requireBookingAccess(req, res, decodeURIComponent(id))) return;
      const body = await readBody(req);
      if (!body.type || !body.file || !body.file.data) {
        return json(res, 400, { error: 'Photo type and file data are required' });
      }
      const allowedTypes = ['odometer', 'front', 'rear', 'left_side', 'right_side'];
      if (!allowedTypes.includes(body.type)) {
        return json(res, 400, { error: 'Invalid photo type' });
      }
      const stage = body.stage === 'return' ? 'return' : 'pickup';

      const file = {
        buffer: Buffer.from(body.file.data, 'base64'),
        originalname: body.file.name,
        size: body.file.size,
        mimetype: body.file.type
      };

      try {
        const result = await db.handleBookingPhotoUpload(decodeURIComponent(id), body.type, stage, file);
        return json(res, 200, result);
      } catch (err) {
        return json(res, err.status || 500, { error: err.message });
      }
    }
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body.name) return json(res, 400, { error: 'name is required' });
      if (!body.email && !body.phone) return json(res, 400, { error: 'email or phone is required' });

      /* The booking window applies to the public, not to the office,
         which takes bookings by phone for any date.

         Decided from the SESSION, never from the request: a flag in
         the body would be a one-line bypass of the rule it exempts. */
      const who = auth.isConfigured() ? auth.userFromRequest(req) : null;
      body.byAdmin = Boolean(who && auth.hasAdmins() && auth.isAdmin(who));

      try {
        const ref = await db.saveBooking(null, body);
        return json(res, 201, { id: ref });
      } catch (err) {
        return json(res, err.status || 500, { error: err.message });
      }
    }
    /* Editing or cancelling an existing booking rewrites money and dates —
       administrators only. */
    if (method === 'PUT' && id) {
      if (!requireAdmin(req, res)) return;
      const ref = await db.saveBooking(decodeURIComponent(id), await readBody(req));
      return json(res, 200, { id: ref });
    }
    if (method === 'DELETE' && id) {
      if (!requireAdmin(req, res)) return;
      const ok = await db.deleteBooking(decodeURIComponent(id));
      return ok ? json(res, 200, { id }) : json(res, 404, { error: 'Booking not found' });
    }
  }

  /* The agreement wording, so the sign page shows exactly what the PDF
     says. Public: it is the same text printed on every contract. */
  if (resource === 'contracts' && method === 'GET' && id === 'terms') {
    return json(res, 200, db.contractTerms());
  }

  /* E-signature: draw or type. The signed PDF is generated server-side
     from database values, so the browser cannot alter the terms. */
  if (resource === 'contracts' && method === 'POST' && id === 'sign') {
    const body = await readBody(req);
    if (!body.bookingRef) return json(res, 400, { error: 'bookingRef is required' });
    if (!await requireBookingAccess(req, res, String(body.bookingRef))) return;
    if (!body.accepted) {
      return json(res, 400, { error: 'You must accept the terms before signing' });
    }
    try {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
              || req.socket.remoteAddress || '';
      const out = await db.signContract(String(body.bookingRef), {
        dataUrl: body.signature,
        typedName: body.typedName,
        method: body.method,
        ip
      });
      return json(res, 200, out);
    } catch (err) {
      return json(res, err.status || 500, { error: err.message || 'Could not sign' });
    }
  }

  if (resource === 'contracts' && method === 'POST' && id === 'upload') {
    // Handle multipart form data for file uploads
    // For simplicity, we'll handle JSON with base64 encoded files
    const body = await readBody(req);
    if (!body.bookingRef) return json(res, 400, { error: 'bookingRef is required' });
    if (!await requireBookingAccess(req, res, String(body.bookingRef))) return;
    if (!body.contractFile && !body.licenseFile) return json(res, 400, { error: 'At least one file required' });
    
    const contractFile = body.contractFile ? {
      buffer: Buffer.from(body.contractFile.data, 'base64'),
      originalname: body.contractFile.name,
      size: body.contractFile.size,
      mimetype: body.contractFile.type
    } : null;
    
    const licenseFile = body.licenseFile ? {
      buffer: Buffer.from(body.licenseFile.data, 'base64'),
      originalname: body.licenseFile.name,
      size: body.licenseFile.size,
      mimetype: body.licenseFile.type
    } : null;

    const result = await db.handleContractUpload(body.bookingRef, contractFile, licenseFile);
    return json(res, 200, result);
  }

  /* Read the deposit screenshot the customer is about to book with.

     Public on purpose: this runs BEFORE the booking exists, and often
     before the visitor has signed in. It stores nothing and reveals
     nothing about anyone else — it reads an image the caller already
     has and reports the number on it. */
  if (resource === 'scan-deposit' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    try {
      const out = await db.scanDeposit(body.data, {
        minimum: Number(body.minimum) || db.BOOKING_DEPOSIT_MIN
      });
      return json(res, 200, out);
    } catch (err) {
      return json(res, err.status || 500, { error: err.message });
    }
  }

  /* A condition photo — the five pick-up/return angles, or a damage
     shot. Same reasoning as the payment images: uploads/ is closed to
     direct URLs, so this guarded route is the only way to read one and
     it checks who is asking.

     Without it the dashboard's photo grids were requesting
     /uploads/bookings/... straight off the filesystem path and getting
     404s — the modal opened with broken images. */
  if (resource === 'booking-image' && method === 'GET') {
    const name = path.basename(decodeURIComponent(id || ''));
    if (!name || !/^(booking|damage)-/.test(name)) {
      return json(res, 400, { error: 'Invalid image' });
    }
    try {
      /* The reference is in the filename the server generated, so the
         owner check runs against the booking it belongs to. */
      const m = /^(?:booking|damage)-([A-Za-z0-9-]+?)-(?:pickup|return)-/.exec(name);
      if (!m) return json(res, 400, { error: 'Invalid image' });
      if (!await requireBookingAccess(req, res, m[1])) return;

      const base = path.resolve(ROOT, 'uploads', 'bookings');
      const full = path.resolve(base, name);
      if (!full.startsWith(base + path.sep)) {
        return json(res, 403, { error: 'Forbidden' });
      }

      const stat = await fsp.stat(full).catch(() => null);
      if (!stat || !stat.isFile()) return json(res, 404, { error: 'Not found' });

      const ext = path.extname(full).toLowerCase();
      const type = ext === '.png'  ? 'image/png'
                 : ext === '.webp' ? 'image/webp'
                 : ext === '.heic' ? 'image/heic'
                 : ext === '.heif' ? 'image/heif'
                 : 'image/jpeg';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Cache-Control': 'private, max-age=300'
      });
      return fs.createReadStream(full).pipe(res);
    } catch (err) {
      return json(res, err.status || 500, { error: err.message });
    }
  }

  /* A signed rental agreement, served to the booking's own customer or
     an admin. Same reasoning as the payment images below: uploads/ is
     closed to direct URLs, so this guarded route is the only way to
     read one, and it checks who is asking. */
  if (resource === 'contract-file' && method === 'GET') {
    const docId = Number(id);
    if (!Number.isInteger(docId) || docId <= 0) {
      return json(res, 400, { error: 'Invalid document id' });
    }
    try {
      const [[row]] = await db.pool.query(
        `SELECT d.file_path, b.reference
           FROM contract_documents d
           JOIN bookings b ON b.id = d.booking_id
          WHERE d.id = ?`, [docId]
      );
      if (!row || !row.file_path) return json(res, 404, { error: 'Not found' });
      if (!await requireBookingAccess(req, res, row.reference)) return;

      /* The stored path may be absolute (older rows) or relative, so it
         is rebuilt from the basename and bounded to uploads/contracts —
         a tampered row cannot reach outside that directory. */
      const name = path.basename(String(row.file_path));
      const base = path.resolve(ROOT, 'uploads', 'contracts');
      const full = path.resolve(base, name);
      if (!full.startsWith(base + path.sep)) {
        return json(res, 403, { error: 'Forbidden' });
      }

      const stat = await fsp.stat(full).catch(() => null);
      if (!stat || !stat.isFile()) return json(res, 404, { error: 'Not found' });

      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': stat.size,
        'Content-Disposition': `inline; filename="${name.replace(/[^\w.-]/g, '_')}"`,
        'Cache-Control': 'private, max-age=300'
      });
      return fs.createReadStream(full).pipe(res);
    } catch (err) {
      return json(res, err.status || 500, { error: err.message });
    }
  }

  /* A payment screenshot, served only to the booking's own customer or
     an admin. uploads/ is deliberately unreachable by direct URL — a
     guessable link would hand out other people's bank screenshots — so
     this route is the only way in, and it checks who is asking. */
  if (resource === 'payment-image' && method === 'GET') {
    const proofId = Number(id);
    if (!Number.isInteger(proofId) || proofId <= 0) {
      return json(res, 400, { error: 'Invalid payment proof id' });
    }
    try {
      const [[row]] = await db.pool.query(
        `SELECT p.file_path, b.reference
           FROM payment_proofs p
           JOIN bookings b ON b.id = p.booking_id
          WHERE p.id = ?`, [proofId]
      );
      if (!row || !row.file_path) return json(res, 404, { error: 'Not found' });
      if (!await requireBookingAccess(req, res, row.reference)) return;

      /* The stored path is built by the server, never by the client,
         but it is still resolved and bounded to uploads/payments so a
         tampered row cannot reach outside it. */
      const full = path.resolve(ROOT, row.file_path);
      const base = path.resolve(ROOT, 'uploads', 'payments');
      if (!full.startsWith(base + path.sep)) {
        return json(res, 403, { error: 'Forbidden' });
      }

      const stat = await fsp.stat(full).catch(() => null);
      if (!stat || !stat.isFile()) return json(res, 404, { error: 'Not found' });

      const ext = path.extname(full).toLowerCase();
      const type = ext === '.png'  ? 'image/png'
                 : ext === '.webp' ? 'image/webp'
                 : ext === '.gif'  ? 'image/gif'
                 : ext === '.avif' ? 'image/avif'
                 : 'image/jpeg';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        /* Private: a shared cache must not keep one customer's receipt
           where another request could be served it. */
        'Cache-Control': 'private, max-age=300'
      });
      return fs.createReadStream(full).pipe(res);
    } catch (err) {
      return json(res, err.status || 500, { error: err.message });
    }
  }

  if (resource === 'contracts' && method === 'GET' && id === 'preview') {
    const ref = url.searchParams.get('ref');
    if (!ref) return json(res, 400, { error: 'ref parameter required' });
    if (!await requireBookingAccess(req, res, ref)) return;

    // Try the database first, fall back to filesystem
    try {
      const [[row]] = await db.pool.query('SELECT id FROM bookings WHERE reference = ?', [ref]);
      if (row) {
        const doc = await db.getContractByBooking(row.id);
        if (doc) {
          const stat = await fsp.stat(doc.file_path);
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': stat.size,
            'Accept-Ranges': 'bytes'
          });
          return fs.createReadStream(doc.file_path).pipe(res);
        }
      }
    } catch (e) { /* fall through to filesystem */ }

    // Fall back to the generated file on disk
    const filePath = path.join(ROOT, 'uploads', 'contracts', `contract-${ref}.pdf`);
    try {
      const stat = await fsp.stat(filePath);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes'
      });
      fs.createReadStream(filePath).pipe(res);
    } catch {
      return json(res, 404, { error: 'Contract not found' });
    }
  }

  /* ------------------------- notifications ------------------------ */
  /* One endpoint, two audiences: an admin sees the dashboard's feed,
     a signed-in customer sees only their own. */
  if (resource === 'notifications') {
    const wantsAdmin = url.searchParams.get('audience') === 'admin';

    if (method === 'GET') {
      if (wantsAdmin) {
        if (!requireAdmin(req, res)) return;
        return json(res, 200, await db.adminNotifications(40));
      }
      /* A signed-out visitor simply has nothing waiting — an empty list
         is the honest answer, not an error. */
      const user = auth.isConfigured() ? auth.userFromRequest(req) : null;
      if (!user || !user.email) return json(res, 200, []);
      return json(res, 200, await db.customerNotifications(user.email, 40));
    }

    if (method === 'POST' && id === 'read') {
      const body = await readBody(req).catch(() => ({}));
      if (wantsAdmin) {
        if (!requireAdmin(req, res)) return;
        await db.markNotificationsRead('admin', null, body.ids);
        return json(res, 200, { ok: true });
      }
      const user = requireUser(req, res);
      if (!user) return;
      await db.markNotificationsRead('customer', user.email, body.ids);
      return json(res, 200, { ok: true });
    }
  }

  if (resource === 'enquiries' && method === 'POST') {
    const body = await readBody(req);
    if (!body.name) return json(res, 400, { error: 'name is required' });
    if (!body.email && !body.phone) return json(res, 400, { error: 'email or phone is required' });
    return json(res, 201, { id: await db.createEnquiry(body) });
  }

  if (resource === 'auth') {
    /* Firebase sign-in: the browser sends the ID token from the JS SDK,
       we verify it against the project and swap it for a session cookie.

       /me and /logout must always answer (even while unconfigured the
       client wants a clean "nobody is signed in"). */

    /* Public Firebase web config — safe to serve, the API key only
       identifies the project. The browser needs it to initialise the JS SDK. */
    if (method === 'GET' && id === 'config') {
      /* The host the browser actually asked for, so a page served on
         localhost is not handed the production sign-in domain. */
      return json(res, 200, {
        config: auth.isConfigured()
          ? auth.publicConfig(req.headers.host, requestIsHttps(req))
          : null
      });
    }

    /* Why is sign-in failing? Reports the SHAPE of the service-account
       credential — never its contents — so a broken key can be told
       apart from a rejected token without shell access to the host.

       Admin-only. It was public while the sign-in bug was being chased,
       which handed anyone the project id and the service-account address
       — no secret, but a free map of the auth setup. */
    if (method === 'GET' && id === 'diag') {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, await auth.credentialDiagnostics());
    }

    /* Verify a Firebase ID token and start a session. */
    if (method === 'POST' && id === 'firebase') {
      if (!auth.isConfigured()) return json(res, 503, { error: 'Firebase Auth is not configured on the server' });
      const { idToken } = await readBody(req);
      if (!idToken) return json(res, 400, { error: 'idToken is required' });
      try {
        const user = await auth.userFromFirebaseToken(idToken);
        auth.setSessionCookie(res, user);
        return json(res, 200, { user });
      } catch (err) {
        /* The client only ever saw "Invalid or expired token", which
           hid why sign-in failed — a clock skew, an unauthorised
           domain and a malformed token all looked identical. Log the
           real reason server-side; the client still gets a generic
           message, since the detail would only help an attacker. */
        const code = err.code || (err.errorInfo && err.errorInfo.code) || 'unknown';
        console.error(`[auth] Firebase token rejected: ${code} — ${err.message}`);
        return json(res, 401, { error: 'Invalid or expired token', code });
      }
    }

    /* Admin sign-in with email + password. Deliberately vague on
       failure: never say which half was wrong. */
    if (method === 'POST' && id === 'admin-login') {
      if (!auth.sessionsConfigured()) {
        return json(res, 503, { error: 'Sessions are not configured (AUTH_SESSION_SECRET)' });
      }
      if (!auth.passwordLoginConfigured()) {
        return json(res, 503, {
          error: 'Admin login is not set up. Run: node server/setadminpw.js "your password"'
        });
      }
      const { email, password } = await readBody(req);
      const user = auth.checkAdminPassword(email, password);
      if (!user) {
        /* A small delay blunts password guessing without a rate limiter. */
        await new Promise(r => setTimeout(r, 600));
        return json(res, 401, { error: 'That email and password do not match.' });
      }
      auth.setSessionCookie(res, user);
      return json(res, 200, { user });
    }

    /* Who am I? Returns the signed-in profile or null.

       This has to agree with requireUser(): when OPEN_ADMIN stands in
       for a session, every other endpoint serves that identity, so
       reporting null here left the customer pages believing nobody was
       signed in — they showed "Please sign in" while /bookings/mine was
       happily returning that customer's bookings. */
    if (method === 'GET' && id === 'me') {
      const real = auth.isConfigured() ? auth.userFromRequest(req) : null;
      const user = real || (OPEN_ADMIN
        ? { email: OPEN_ADMIN_EMAIL, name: 'Local developer', id: 'dev' }
        : null);
      return json(res, 200, { user });
    }

    /* End the session. */
    if (method === 'POST' && id === 'logout') {
      auth.clearSessionCookie(res);
      return json(res, 200, { ok: true });
    }

    /* Profile: GET returns customer record, PUT updates it */
    if ((method === 'GET' || method === 'PUT') && id === 'profile') {
      const user = auth.userFromRequest(req);
      if (!user?.email) return json(res, 401, { error: 'Not signed in' });
      
      if (method === 'GET') {
        const customer = await db.getCustomerByEmail(user.email);
        if (!customer) return json(res, 404, { error: 'Profile not found' });
        return json(res, 200, { customer });
      }
      
      // PUT - update profile
      const body = await readBody(req);
      const { name, phone, licenseNumber } = body || {};
      const result = await db.updateCustomer(user.email, { name, phone, licenseNumber });
      const updated = await db.getCustomerByEmail(user.email);
      return json(res, 200, { customer: updated });
    }
  }

  json(res, 404, { error: 'No such endpoint' });
}

/* ---------------------------- static ------------------------------ */

/* ------------------- Firebase auth handler proxy -------------------
   Firebase serves its sign-in handler from <project>.firebaseapp.com,
   a DIFFERENT origin to this site. The redirect flow hands the
   credential back through storage on that origin — and Chrome on
   Android now partitions third-party storage, so the credential was
   written where this site can never read it. Google authenticated the
   user correctly every time and the page still came back signed out.

   Proxying those few paths through our own domain makes the whole flow
   same-origin, so there is nothing left to partition. This is the
   arrangement Firebase documents for custom domains. */
const FIREBASE_AUTH_HOST = (() => {
  /* Read it the same way auth.js does — the value lives in .env on this
     host, and process.env alone would be empty there. */
  try {
    const raw = require('fs').readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > 0 && t.slice(0, eq).trim() === 'FIREBASE_AUTH_DOMAIN') {
        return t.slice(eq + 1).trim();
      }
    }
  } catch { /* fall through */ }
  return (process.env.FIREBASE_AUTH_DOMAIN || '').trim();
})();

function proxyFirebaseAuth(req, res, url) {
  const https = require('https');
  const target = {
    host: FIREBASE_AUTH_HOST,
    path: url.pathname + (url.search || ''),
    method: req.method,
    headers: { ...req.headers, host: FIREBASE_AUTH_HOST }
  };
  delete target.headers['accept-encoding'];   /* pass through undecoded */

  const upstream = https.request(target, up => {
    const headers = { ...up.headers };
    /* The handler frames itself and sets its own cookies; both must keep
       working from this origin. */
    delete headers['content-encoding'];
    delete headers['content-length'];
    res.writeHead(up.statusCode || 502, headers);
    up.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Auth handler unavailable');
  });
  req.pipe(upstream);
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  /* Firebase's own endpoints, served from this origin. */
  if (FIREBASE_AUTH_HOST && rel.startsWith('/__/')) {
    return proxyFirebaseAuth(req, res, url);
  }

  /* Resolve, then confirm the result is still inside ROOT — otherwise
     a path like /../../.env walks straight out of the site. */
  const filePath = path.resolve(ROOT, '.' + rel);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    return json(res, 403, { error: 'Forbidden' });
  }
  /* .env and friends are inside ROOT but must never be served */
  if (/(^|[\\/])\.(env|git)/i.test(filePath.slice(ROOT.length))) {
    return json(res, 403, { error: 'Forbidden' });
  }

  /* ------------------------------------------------------------------
     ALLOWLIST, not a denylist.

     This handler used to block a handful of known-bad paths and serve
     whatever else was asked for — so the whole project was readable:
     /server/db.js gave away every query, /db/schema.sql the schema,
     /package.json the dependency list, and a deployment zip left in the
     folder could be downloaded entire. Naming what IS public is the
     only version of this that stays safe as files get added.
  ------------------------------------------------------------------ */
  const webPath = filePath.slice(ROOT.length).replace(/\\/g, '/');

  /* Directories whose contents are meant for a browser. */
  const PUBLIC_DIRS = /^\/(css|js|images|videos|fonts)\//i;
  /* Individual files at the root that the site needs. */
  const PUBLIC_FILES = new Set([
    '/index.html', '/car.html', '/bookings.html', '/profile.html',
    '/admin.html', '/admin-login.html', '/credits.html', '/sign-contract.html',
    '/manifest.json', '/sw.js', '/favicon.ico', '/robots.txt'
  ]);

  if (!PUBLIC_DIRS.test(webPath) && !PUBLIC_FILES.has(webPath.toLowerCase())) {
    /* 404 rather than 403: "forbidden" confirms the file exists, which
       hands a map to anyone probing. */
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }

  /* uploads/ holds signed contracts, driving licences and condition
     photos. They live under ROOT so the API can read them, but the file
     server must never hand one out on a guessable URL — the guarded
     /api/contracts/preview route is the only way in. */
  if (/^[\\/]uploads([\\/]|$)/i.test(filePath.slice(ROOT.length))) {
    return json(res, 403, { error: 'Forbidden' });
  }

  /* The dashboard's data is already gated at the API, but serving the
     page to strangers only invites them to try — so gate the page too.
     A signed-in non-admin gets 403, everyone else gets sent to sign in. */
  if (!OPEN_ADMIN && /^[\\/]admin\.html$/i.test(filePath.slice(ROOT.length))) {
    const user = auth.sessionsConfigured() ? auth.userFromRequest(req) : null;
    if (!user || !auth.hasAdmins() || !auth.isAdmin(user)) {
      /* Send them to the sign-in page, not the shop front — a bounce to
         the home page reads as a broken link. */
      res.writeHead(302, { Location: '/admin-login.html', 'Cache-Control': 'no-store' });
      return res.end();
    }
  }

  let stat;
  try { stat = await fsp.stat(filePath); }
  catch { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  if (stat.isDirectory()) { res.writeHead(404); return res.end('Not found'); }

  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

  /* Everything was served no-cache, so the 170KB Firebase SDK was
     re-downloaded on every single page load — about 2.3s on the live
     server, paid again each visit, and most of the wait a viewer
     returning from Google sat through before appearing signed in.

     Third-party vendor bundles and media are versioned by their path and
     never change in place, so they can be cached hard. The app's own
     HTML/CSS/JS keeps revalidating, so a redeploy still takes effect
     immediately. */
  const servedPath = filePath.replace(/\\/g, '/');
  const immutable = /\/js\/vendor\/|\/images\/|\/fonts\//.test(servedPath);
  const headers = {
    'Content-Type': type,
    'Cache-Control': immutable
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
  };

  /* Range support, or the browser cannot scrub the hero video */
  const range = req.headers.range;
  if (range && /^bytes=/.test(range)) {
    const [startStr, endStr] = range.replace('bytes=', '').split('-');
    const start = Number(startStr) || 0;
    const end = endStr ? Number(endStr) : stat.size - 1;
    if (start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1
    });
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(filePath).pipe(res);
}

/* ----------------------------- server ----------------------------- */

/* ------------------------------------------------------------------
   Security headers, set on every response.

   None of these were present, which a vulnerability scan will report
   and which leaves real gaps: without X-Frame-Options the dashboard can
   be framed by another site to trick an admin into clicking through it,
   and without nosniff a served file can be re-interpreted as script.

   The CSP is deliberately permissive about styles and images — the pages
   use inline styles and data: URIs — but it does stop script from any
   origin we do not name, which is what limits the damage if markup ever
   gets injected. 'unsafe-inline' for script stays because the pages
   carry inline <script> blocks; removing it needs those extracted first.
------------------------------------------------------------------- */
/* Is the browser talking to us over TLS? Either the socket itself is
   encrypted, or a proxy terminated TLS and said so. Used to decide
   whether this host can serve the Firebase sign-in handler, which the
   SDK only ever requests over https. */
function requestIsHttps(req) {
  if (!req) return false;
  if (req.socket && req.socket.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto.toLowerCase() === 'https';
}

function setSecurityHeaders(res, isHttps, requestHost) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  /* Google sign-in opens https://<authDomain>/__/auth/handler and that
     window posts the credential back. The list below used to name only
     *.firebaseapp.com, so a project with its own authDomain — like
     rfentity.com — had the handler blocked: the popup appeared, the
     account was chosen, and then it died before it could answer, which
     Firebase reports as the misleading "popup-closed-by-user".

     Deriving it from the configured authDomain keeps the two from
     drifting apart again. */
  const authHost = (auth.publicConfig(requestHost, isHttps) || {}).authDomain || '';
  /* When the handler is same-origin (https, proxied here) 'self'
     already covers it. Otherwise it is Firebase's own https domain and
     must be named explicitly — but never as https://<a plain-http
     host>, which matches nothing. */
  const isSameHost = authHost && requestHost && authHost === requestHost;
  const authOrigin = (authHost && !isSameHost) ? ` https://${authHost}` : '';

  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://apis.google.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.googleapis.com" + authOrigin,
    "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com" + authOrigin,
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join('; '));
  /* Only meaningful over TLS, and harmful on a plain-http dev server —
     a browser that sees it once will refuse http for a year. */
  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  /* Hostinger terminates TLS and forwards the original scheme. */
  const isHttps = /^https$/i.test(String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim());
  setSecurityHeaders(res, isHttps, req.headers.host);
  try {
    if (url.pathname.startsWith('/api')) return await api(req, res, url);
    await serveStatic(req, res, url);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, err.message);
    /* never leak a SQL error string to the client */
    json(res, status, { error: status >= 500 ? 'Server error' : err.message });
  }
});

server.listen(PORT, async () => {
  try {
    const version = await db.ping();
    console.log(`Reddy Finances  http://localhost:${PORT}`);
    console.log(`MySQL ${version} connected`);
    /* Email is business-critical here, so say plainly at start-up
       whether it works instead of failing silently later. */
    const mail = await db.verifyEmail();
    if (mail.ok) {
      console.log('Email       ready');
    } else {
      console.warn('');
      console.warn('  !!  EMAIL IS NOT WORKING — invoices and booking messages will not send.');
      if (mail.reason) console.warn(`  !!  ${mail.reason}`);
      if (mail.hint) console.warn(`  !!  ${mail.hint}`);
      console.warn('  !!  Test it with:  node server/mailtest.js');
      console.warn('');
    }

    if (OPEN_ADMIN) {
      console.warn('');
      console.warn('  !!  OPEN_ADMIN is on — the admin dashboard needs no sign-in.');
      console.warn('  !!  Anyone who can reach this server can read customer names,');
      console.warn('  !!  emails, phone numbers and licence numbers.');
      console.warn('  !!  Remove OPEN_ADMIN from .env before deploying.');
      console.warn('');
    }
  } catch (err) {
    console.error('MySQL connection FAILED:', err.message);
    console.error('The pages will still serve, but the API will not work.');
  }
});
