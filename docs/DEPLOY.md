# Putting ZET online — Firebase App Hosting + Neon (free tier)

The test setup: **$0/month** while traffic stays inside Google's free
allowance and the data inside Neon's free 0.5 GB. Decided 29/09/2026 as a
trial; moving the database to a paid plan later is a copy, not a rewrite.

```
 browser ──► Firebase App Hosting (the Next.js app, Europe)
                 │  DATABASE_URL (as zet_app)
                 ▼
             Neon Postgres (Frankfurt) ◄── GitHub Actions, nightly pg_dump ──► R2 zet-backups
                 
 browser ──► Cloudflare R2 zet-receipts (photos, signed URLs)
```

Do the steps **in order**. Step 5 before step 6 matters — see the note there.
Anything in `<angle brackets>` is yours to fill in. Secrets go into the
places named here and **nowhere else**: not into a file in the repo, not into
chat.

---

## 0. Before starting

```
npm test          # all passing
npm run build     # must be clean — Firebase runs this same build
npm install -g firebase-tools
```

## 1. GitHub — a private repo

1. github.com → **New repository** → name `zet` → **Private** → do NOT add a
   README, .gitignore or licence (the repo already has them).
2. In Terminal:
   ```
   cd ~/zet
   git remote add origin https://github.com/<your-username>/zet.git
   git push -u origin main
   ```
3. On GitHub, check `.env.local` is **not** in the file list. (It is
   gitignored and has never been committed; this is the belt-and-braces look.)

## 2. Neon — the database

1. neon.com → sign up → **Create project**: name `zet`, region
   **AWS Europe Central 1 (Frankfurt)**, Postgres version: the default.
2. On the project dashboard → **Connect** → switch **Connection pooling OFF**
   → copy the connection string. It is for the role `neondb_owner` and looks
   like `postgresql://neondb_owner:…@ep-….eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`.
   This is the **owner** URL: it is only ever used by the setup script and
   the backup job, never by the app.
3. In Terminal (single quotes matter — the URL has `&` in it):
   ```
   cd ~/zet
   OWNER_DATABASE_URL='<the owner URL>' ./scripts/db-deploy.sh
   ```
   It applies the migrations, creates the restricted `zet_app` login, seeds
   the five restaurants and the admin, checks `zet_app` cannot bypass
   row-level security, and prints **DATABASE_URL** and **ADMIN_USER_ID**.
   Keep that terminal open for step 5.

**After any future migration** (a new file in `db/migrations/`), run the same
command again BEFORE `git push` — the new code expects the new columns, so the
database has to have them first. On every run after the first the script
leaves `zet_app`'s password alone and says so: there is nothing to change in
Firebase. To deliberately set a new password, put `ROTATE_PASSWORD=1` in
front; the printed DATABASE_URL then has to replace the `zet-database-url`
secret, followed by a new rollout.

## 3. A production password

```
npm run hash-password
```

Use a **different** password from your laptop's. It prints two blocks — use
the second, "For a HOST secret store": the hash **without** backslashes.
Then a separate session secret:

```
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## 4. Firebase — project and billing

1. console.firebase.google.com → **Create a project** → name `zet` (Google
   Analytics: off — not needed).
2. **Upgrade** → **Blaze (pay as you go)** → add the card. App Hosting
   requires it. Expected cost at ZET's traffic: $0.
3. Set a budget alert so a surprise cannot go unnoticed: Google Cloud console
   → **Billing → Budgets & alerts → Create budget** → €5, alerts at 50% and
   100%. (An alert emails you; it does not stop anything.
   `maxInstances: 2` in apphosting.yaml is the actual ceiling.)
4. In Terminal:
   ```
   firebase login
   cd ~/zet
   firebase use --add        # pick the zet project, alias: default
   ```

## 5. Secrets — ALL of them, before the app exists

App Hosting has an open bug (firebase-tools #10391, April 2026): a secret
added to an **existing** backend is silently left off the running app. So
every secret is created now, before step 6. Each command asks for the value
— paste it and press Enter. If it asks whether to grant a backend access,
say no for now (there is no backend yet; step 6 grants it).

| Secret | Value |
|---|---|
| `zet-database-url` | DATABASE_URL printed in step 2 |
| `zet-admin-user-id` | ADMIN_USER_ID printed in step 2 |
| `zet-admin-password-hash` | the hash from step 3, **no backslashes** |
| `zet-session-secret` | the random string from step 3 |
| `zet-r2-account-id` | same as `R2_ACCOUNT_ID` in your `.env.local` |
| `zet-r2-access-key-id` | same as `R2_ACCESS_KEY_ID` in `.env.local` |
| `zet-r2-secret-access-key` | same as `R2_SECRET_ACCESS_KEY` in `.env.local` |
| `zet-anthropic-api-key` | same as `ANTHROPIC_API_KEY` in `.env.local` |

```
firebase apphosting:secrets:set zet-database-url
firebase apphosting:secrets:set zet-admin-user-id
firebase apphosting:secrets:set zet-admin-password-hash
firebase apphosting:secrets:set zet-session-secret
firebase apphosting:secrets:set zet-r2-account-id
firebase apphosting:secrets:set zet-r2-access-key-id
firebase apphosting:secrets:set zet-r2-secret-access-key
firebase apphosting:secrets:set zet-anthropic-api-key
```

The trial reuses the laptop's R2 bucket (`zet-receipts`) and Anthropic key.
Photos are stored under random names, so the two cannot collide.

## 6. App Hosting — the app

1. Firebase console → **Build → App Hosting → Get started**.
2. Region: the **European** one offered (europe-west4, Netherlands).
3. Connect GitHub → repository `zet` → root directory `/` → live branch
   `main` → **automatic rollouts ON**. Backend name: `zet`.
4. Grant the backend access to the secrets:
   ```
   for s in zet-database-url zet-admin-user-id zet-admin-password-hash zet-session-secret \
            zet-r2-account-id zet-r2-access-key-id zet-r2-secret-access-key zet-anthropic-api-key; do
     firebase apphosting:secrets:grantaccess "$s" --backend zet
   done
   ```
5. The first rollout may have failed for lack of that access. App Hosting →
   `zet` → **Rollouts → Create rollout** from `main`. Takes a few minutes.
6. The address is on the backend's page:
   `https://zet--<project-id>.europe-west4.hosted.app` (roughly).

From now on every `git push` to `main` deploys automatically.

## 7. Check it

1. Open the address → sign in with the step-3 password.
2. Go to **`/status`** on that address. Every line should be ✓, and the
   database line should say **5** restaurants. A ✗ on a setting means
   Firebase did not pass that secret: `grantaccess` it again and create a
   new rollout.
3. File a test night for any restaurant; open it in the archive; export it.

The first request after a quiet spell takes a few seconds: both the app and
the database sleep when unused. That is what makes it free.

## 8. R2 — let the live address upload photos

Cloudflare → R2 → `zet-receipts` → **Settings → CORS policy** → add the
address from step 6 to `AllowedOrigins`, exactly — `https://`, no trailing
slash — keeping `http://localhost:3000`:

```json
"AllowedOrigins": [
  "http://localhost:3000",
  "https://<the hosted.app address>"
],
```

Then attach a photo on the live site. See `docs/R2-CORS.md` if it fails.

## 9. Nightly backups

Neon's free plan can only roll back **6 hours**. This keeps every night.

1. Cloudflare → R2 → **Create bucket** `zet-backups` (private).
2. That bucket → **Settings → Object lifecycle rules → Add rule**: prefix
   `daily/`, delete objects after **30 days**.
3. R2 → **Manage API tokens → Create token**: Object Read & Write, **only**
   the `zet-backups` bucket. Separate from the app's token on purpose.
4. GitHub → `zet` repo → **Settings → Secrets and variables → Actions → New
   repository secret**, five of them:

   | Name | Value |
   |---|---|
   | `BACKUP_DATABASE_URL` | the Neon **owner** URL from step 2 |
   | `R2_ACCOUNT_ID` | the Cloudflare account id |
   | `R2_BACKUP_ACCESS_KEY_ID` | from the new token |
   | `R2_BACKUP_SECRET_ACCESS_KEY` | from the new token |
   | `R2_BACKUP_BUCKET` | `zet-backups` |

5. GitHub → **Actions → Nightly database backup → Run workflow**. When it is
   green, `zet-backups/daily/` holds a `zet-….dump`. After that it runs by
   itself at 02:30 UTC. GitHub emails you if a run fails.

**Restoring** (hopefully never): download a dump from R2, create an empty
database in Neon (or a branch), then
`OWNER_DATABASE_URL='<its owner URL>' ./scripts/db-restore.sh <file>` and
`./scripts/db-deploy.sh` against the same URL, and put the printed
DATABASE_URL into the `zet-database-url` secret. Tested end to end on
29/09/2026 against the August demo data.

## 10. Letting Alex test

Send the address and the admin password (not in the same message). The
admin sees every restaurant; for a manager, create a restaurant login
instead (step 11).

## 11. Restaurant logins

Each restaurant gets its own username and password. A restaurant login sees
and files only its own nights and archive, and can edit a night until it is
approved; another restaurant's pages answer "not found". Approving,
correcting an approved night and the Sofia export are the admin's only. The
admin login is unchanged (the `zet-admin-*` secrets) and sees everything.

The first time, on a database made before 05/10/2026, apply migrations 0008
and 0009 — BEFORE pushing to main, since a push to main rolls out:

```
OWNER_DATABASE_URL='<the neondb_owner URL>' ./scripts/db-deploy.sh
```

It must print `0008_restaurant_logins.sql ... ok` and
`0009_admin_approves_and_corrects.sql ... ok`, and say that `zet_app`'s
password was left as it is. Nothing in Firebase changes. Then create a
rollout of the new code. Everyone is signed out once by that rollout (old
cookies are refused on purpose) and signs in again.

Then, signed in as the admin: **Λογαριασμοί** → for each restaurant, a
username (small Latin letters/digits, e.g. `anamma`), a name, and a
password of at least 10 characters. Give each manager only their own.

**Νέος κωδικός** on the same page resets a password. It signs that
restaurant out on every phone at once.

---

## What this setup does not give you (yet)

- **The laptop and the live site have separate databases.** Nothing typed
  into one appears in the other.
- **No automatic restore history beyond 6 hours** on Neon free; the nightly
  backup covers whole days only. Neon's paid plan gives 7 days of
  to-the-minute restore.
- **Cold starts**: a few seconds after idle. `minInstances: 1` removes it and
  costs money.
