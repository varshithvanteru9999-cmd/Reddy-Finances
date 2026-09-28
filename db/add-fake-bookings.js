/* Add fake customer bookings via the running API for testing the
   admin Bookings filters. Idempotent-ish: re-running just adds more.
   Run: node db/add-fake-bookings.js
*/
const BASE = 'http://localhost:5500/api/bookings';

async function post(body) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const txt = await res.text();
  console.log(`${res.status}  ${JSON.stringify(body).slice(0, 110)}`);
  if (!res.ok) console.log('   ->', txt);
  return res.ok;
}

/* Reliable hosts + vehicles already in the seed, spread across 2025 & 2026
   so month / year / All filters have plenty to chew on. */
const rows = [
  // 2025 span (tests month overlap; Aug 12 -> Sep 30)
  { name: 'James Whitfield', email: 'j.whitfield@example.com', phone: '(214) 555-0191', carId: 'bmw-330i', from: '2025-08-12', to: '2025-09-30', status: 'Completed' },
  { name: 'Aisha Khan',      email: 'aisha.k@example.com',     phone: '(469) 555-0202', carId: 'chevrolet-suburban', from: '2025-07-01', to: '2025-07-10', status: 'Completed' },
  { name: 'Carlos Mendez',   email: 'carlos.m@example.com',    phone: '(972) 555-0213', carId: 'toyota-rav4-hybrid', from: '2025-06-15', to: '2025-06-22', status: 'Completed' },
  { name: 'Linh Nguyen',     email: 'linh.n@example.com',      phone: '(682) 555-0224', carId: 'ford-mustang-gt',   from: '2025-05-03', to: '2025-05-06', status: 'Completed' },

  // 2025 late-year + 2026 cross-year
  { name: 'Grace Osei',      email: 'grace.o@example.com',     phone: '(214) 555-0235', carId: 'jeep-wrangler',     from: '2025-12-28', to: '2026-01-04', status: 'Completed' },

  // 2026 early months
  { name: 'Ryan Callahan',   email: 'ryan.c@example.com',      phone: '(469) 555-0246', carId: 'tesla-model-3',     from: '2026-01-05', to: '2026-01-08', status: 'Confirmed' },
  { name: 'Nadia Haddad',    email: 'nadia.h@example.com',     phone: '(972) 555-0257', carId: 'bmw-330i',          from: '2026-02-10', to: '2026-02-13', status: 'Confirmed' },
  { name: 'Tomás Ferreira',  email: 'tomas.f@example.com',     phone: '(682) 555-0268', carId: 'toyota-rav4-hybrid', from: '2026-03-20', to: '2026-03-25', status: 'Confirmed' },
  { name: 'Eleanor Vasquez', email: 'eleanor.v@example.com',   phone: '(214) 555-0279', carId: 'chevrolet-suburban', from: '2026-04-01', to: '2026-04-09', status: 'Confirmed' },

  // 2026 April -> June and a long multi-month
  { name: 'Hassan Ali',      email: 'hassan.a@example.com',    phone: '(469) 555-0280', carId: 'ford-mustang-gt',   from: '2026-05-11', to: '2026-05-14', status: 'Confirmed' },
  { name: 'Emily Tran',      email: 'emily.t@example.com',     phone: '(972) 555-0291', carId: 'jeep-wrangler',     from: '2026-05-20', to: '2026-08-15', status: 'Prebooked' },
  { name: 'Omar Fayed',      email: 'omar.f@example.com',      phone: '(214) 555-0302', carId: 'tesla-model-3',     from: '2026-09-05', to: '2026-09-12', status: 'Confirmed' },

  // 2026 Oct-Dec (future)
  { name: 'Priyanka Rao',    email: 'priyanka.r@example.com',  phone: '(682) 555-0313', carId: 'bmw-330i',          from: '2026-10-14', to: '2026-10-19', status: 'Prebooked' },
  { name: 'Felix Brandt',    email: 'felix.b@example.com',     phone: '(469) 555-0324', carId: 'toyota-rav4-hybrid', from: '2026-11-02', to: '2026-11-06', status: 'Prebooked' },
  { name: 'Zoe Adams',       email: 'zoe.a@example.com',       phone: '(972) 555-0335', carId: 'chevrolet-suburban', from: '2026-12-15', to: '2026-12-22', status: 'Prebooked' }
];

(async () => {
  let ok = 0, fail = 0;
  for (const r of rows) {
    if (await post(r)) ok++; else fail++;
  }
  console.log(`\nDone: ${ok} added, ${fail} failed`);
})();
