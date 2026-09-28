# Deployment Guide for Hostinger Node.js Hosting

## Prerequisites
- Hostinger Node.js hosting plan purchased
- Domain configured in Hostinger
- MySQL database created in Hostinger (or external MySQL)

## Step 1: Prepare Database on Hostinger

1. Log into Hostinger hPanel
2. Go to **Databases → MySQL Databases**
3. Create a new database:
   - Database name: `reddy_finances` (or your preferred name)
   - Username: `reddy_user` (or your preferred name)
   - Password: **Save this securely**
4. Note down:
   - Database host (usually `localhost` or a specific host like `mysql.hostinger.com`)
   - Database port (usually `3306`)

## Step 2: Import Database Schema & Data

**Option A: Using Hostinger phpMyAdmin**
1. Go to **Databases → phpMyAdmin**
2. Select your database
3. Import `db/schema.sql` first
4. Then import `db/seed.sql`

**Option B: Using MySQL Workbench/Command Line**
```bash
# From your local machine
mysql -h YOUR_DB_HOST -u YOUR_DB_USER -p YOUR_DB_NAME < db/schema.sql
mysql -h YOUR_DB_HOST -u YOUR_DB_USER -p YOUR_DB_NAME < db/seed.sql
```

## Step 3: Configure Environment Variables

In Hostinger hPanel, go to **Node.js App → Environment Variables** and add:

| Variable | Value |
|----------|-------|
| `DB_HOST` | Your MySQL host (e.g., `localhost` or `mysql.hostinger.com`) |
| `DB_PORT` | `3306` |
| `DB_USER` | Your database username |
| `DB_PASSWORD` | Your database password |
| `DB_NAME` | Your database name (e.g., `reddy_finances`) |
| `PORT` | `3000` (Hostinger typically uses port 3000) |
| `NODE_ENV` | `production` |

## Step 4: Deploy Application Files

**Option A: Git Deploy (Recommended)**
1. In Hostinger hPanel → **Node.js App → Git Repository**
2. Connect your GitHub/GitLab repository
3. Set branch to `main` or `master`
4. Click **Deploy**

**Option B: File Manager / FTP**
1. Zip your project (excluding `node_modules/`, `.env`, `.git/`)
2. Upload via Hostinger File Manager or FTP
3. Extract in the Node.js app directory
4. Run `npm install` in the terminal

## Step 5: Configure Node.js App in Hostinger

In **Node.js App** settings:
- **App root**: `/` (or your subdirectory)
- **Startup file**: `server/index.js` (or `index.js` if you move it)
- **Node.js version**: 18.x or 20.x (LTS) — this app uses firebase-admin@13 which supports Node 18+
- **Package manager**: npm

## Step 6: Set Up Domain/SSL

1. In **Domains** section, point your domain to the Node.js app
2. Enable **SSL** (Let's Encrypt) for HTTPS
3. Ensure your domain's A record points to Hostinger's IP

## Step 7: Test Deployment

Visit your domain and verify:
- ✅ Homepage loads
- ✅ API health check: `https://yourdomain.com/api/health`
- ✅ Vehicles load: `https://yourdomain.com/api/vehicles`
- ✅ Admin panel works: `https://yourdomain.com/admin.html`

## Common Issues & Fixes

### "Port already in use" or App won't start
- Hostinger runs on port 3000 - ensure `PORT=3000` in env vars
- The app reads `process.env.PORT` automatically

### Database connection fails
- Verify DB_HOST is correct (often `localhost` on Hostinger)
- Check firewall allows connections from Node.js app
- Ensure database user has proper permissions

### Static files not loading
- Ensure `ROOT` path in `server/index.js` resolves correctly
- The app serves files from project root - verify file structure

### "Module not found" errors
- Run `npm install` in the app directory
- Check `package.json` has `mysql2` in dependencies

## File Structure on Hostinger

```
/home/yourusername/yourdomain.com/
├── server/
│   ├── index.js
│   └── db.js
├── js/
├── css/
├── images/
├── db/
├── index.html
├── admin.html
├── car.html
├── package.json
├── package-lock.json
├── .gitignore
└── node_modules/  (created after npm install)
```

## Updating the App

For future updates:
1. Push to Git → Hostinger auto-deploys (if Git deploy enabled)
2. Or re-upload files and run `npm install` again
3. Restart the Node.js app in hPanel

## Support

If issues persist:
- Check Hostinger Node.js logs in hPanel
- Verify all environment variables are set
- Ensure MySQL is accessible from the Node.js container