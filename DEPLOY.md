# Deploying Reddy Finances

The site is two pieces:

- a **Node.js server** (the API, admin dashboard, email, PDFs)
- a **MySQL database**

Hostinger's Business plan can host the database but **cannot run Node.js** —
it serves PHP only. So the database goes on Hostinger and the server goes
somewhere that runs Node. Railway is used below; Render or a VPS work the
same way.

---

## 1. The database, on Hostinger

**hPanel → Databases → Management**

1. Create a database. Note the three values it gives you:
   - database name — e.g. `u123456789_reddy`
   - username — e.g. `u123456789_admin`
   - password — the one you set
2. Note the **host**, shown on the same page (e.g. `srv1234.hstgr.io`).
   It is *not* `localhost` from outside Hostinger.

**hPanel → Databases → Remote MySQL**

3. Add the IP allowed to connect. Railway's outbound IP is not fixed on
   the free plan, so start with `%` (any host) to get running.

   `%` means any machine on the internet may *attempt* to connect, with
   only the password stopping them. Restrict it to a fixed IP before real
   customers use the site — see step 6.

---

## 2. Point the app at it

Edit `.env`:

```
DB_HOST=srv1234.hstgr.io
DB_PORT=3306
DB_NAME=u123456789_reddy
DB_USER=u123456789_admin
DB_PASSWORD=your-database-password

APP_URL=https://yourdomain.com
```

`APP_URL` is what customers click in emails, so it must be the real
domain, not localhost.

Then build the tables:

```
node db/setup.js --seed
```

It applies the schema and all seven migrations in order, then loads the
sample fleet. Safe to re-run. Drop `--seed` if the client will add their
own vehicles.

---

## 3. The server, on Railway

1. Push this folder to a GitHub repository.
   **`.env` is gitignored** — secrets are never committed.
2. railway.app → New Project → Deploy from GitHub repo
3. Railway detects Node and runs `npm start`.
4. **Variables** tab → add every line from your `.env`:

   ```
   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
   EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASSWORD, EMAIL_FROM
   FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID
   FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
   AUTH_SESSION_SECRET
   ADMIN_EMAIL, ADMIN_PASSWORD_SALT, ADMIN_PASSWORD_HASH
   APP_URL
   ```

   Do **not** set `OPEN_ADMIN` — it disables the admin login entirely.

   `FIREBASE_PRIVATE_KEY` contains `\n` escapes. Paste it exactly as it
   appears in `.env`, quotes included.

5. Railway gives you a URL like `reddy-production.up.railway.app`.
   Open it and check the site loads.

---

## 4. Your domain

**Railway → Settings → Domains → Custom Domain** — enter your domain.
Railway shows a CNAME target.

**Hostinger → Domains → DNS Zone** — add:

| Type  | Name | Value |
|-------|------|-------|
| CNAME | `@` or `www` | the target Railway showed |

DNS takes minutes to a few hours. Railway issues the HTTPS certificate
automatically once it resolves.

Then set `APP_URL` to that domain in Railway's variables and redeploy.

---

## 5. Firebase

**Firebase console → Authentication → Settings → Authorised domains**

Add your live domain, or Google sign-in fails there with an unhelpful
error.

---

## 6. After it is live

- **Restrict Remote MySQL.** Replace `%` with Railway's outbound IP.
  A paid Railway plan gives a static one; on the free plan, either accept
  the risk knowingly or move the database to Railway too.
- **Check email.** `node server/mailtest.js you@example.com` from a
  machine with the live `.env`.
- **Sign in to `/admin-login.html`** and confirm the dashboard opens.
- **Replace the car photos.** The current ones are Creative Commons and
  credited on `/credits.html`; client-owned photos of the real cars are
  better in every way. The admin can swap them in the Fleet tab.

---

## Troubleshooting

**"Could not connect" from `db/setup.js`**
Remote MySQL is not enabled, or the IP is not allowed, or the host name
is wrong. Hostinger's host is not `localhost` from outside.

**Site loads but nothing saves**
The server cannot reach the database. Check Railway's logs and confirm
the `DB_*` variables match Hostinger exactly.

**Emails do not arrive**
`node server/mailtest.js` prints the reason. Usually `EMAIL_PASSWORD` is
not the 16-character Google App Password.

**Admin login refuses a correct password**
`ADMIN_PASSWORD_SALT` and `ADMIN_PASSWORD_HASH` must both be copied to
the host. They are a pair — one without the other cannot verify.

**Install button missing**
Service workers need HTTPS. It will not appear on a plain `http://` URL.
