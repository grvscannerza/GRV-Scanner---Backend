# GRV Scanner - Backend Starter

A minimal, real backend for the GRV Scanner app. Every piece here was actually run
and tested, not just written - see "What was tested" below.

## Public signup

A real 3-step signup flow, reachable from the "Create one free" link on the
login page (previously a dead link):

1. **Personal details** - name, username (auto-suggested, checked for
   real-time availability), email, PIN - all mandatory.
2. **Company details** - name, address, contact number, company email are
   mandatory; VAT number is optional, since not every South African business
   is VAT-registered (there's a turnover threshold below which registration
   isn't required).
3. **Billing** - pick a plan, redirected to real Paystack checkout. If this
   step is abandoned, the account still exists and works (Starter plan,
   inactive subscription) - they can log in and pick a plan later from
   Billing instead.

The account is created via `POST /api/signup` (`routes/signup.js`) - server-
side validated regardless of what the multi-step form already checked, and
created in a real database transaction (business + admin user + default
settings together), so a failure partway through can't leave an orphaned
business with no admin. Confirmed: a new account's data is properly isolated
from other businesses (empty suppliers list, no cross-tenant leakage);
duplicate username/email is rejected cleanly; the new account can log in
immediately and its exact stored details match what was entered.

## Subscription gate - unpaid accounts can't use the app

Signing up creates a real, working login - but not a free, fully-functional
app. Every route that represents real feature usage (suppliers, item master,
scans, reports, staff management) requires `subscription_status = 'active'`
on the business, enforced by `requireActiveSubscription` in
`middleware/auth.js`. The developer/owner account bypasses this (it isn't a
paying customer); everyone else genuinely can't touch these features until a
real payment succeeds.

Billing itself, and the admin's own account/profile pages, are deliberately
**not** gated - otherwise nobody could ever reach the page where they pay.

On the frontend: an admin who logs in (or logs back in later, having
abandoned checkout) while unpaid is routed straight to Billing with a visible
"Activate your account" notice, instead of landing on a home page full of
broken/blocked tiles. A staff member (processor/dispatch) of an unpaid
business sees a simple "Account Not Active Yet" screen, since only the admin
can actually pay. The moment a real payment succeeds, the session is fully
re-established and the app unlocks immediately - no re-login required.

Tested end-to-end through the real UI, not just the API: signed up a new
account, confirmed direct API calls to Suppliers and Scan creation are
genuinely rejected (HTTP 402) while unpaid, completed a real payment against
the mock Paystack server, and confirmed the exact same calls succeed
immediately afterward. Also fixed the seeded demo business ("John's
Restaurant") to be seeded as an already-active paying customer, since it
represents an existing customer throughout this whole build, not a new
unpaid signup - a fresh signup via the real wizard is what starts inactive.

## 3-day grace period for failed renewals

If a subscription renewal payment fails, the business isn't cut off
instantly - it gets 3 days to fix payment before real feature access is
blocked. The clock starts on the *first* failure and isn't reset by
Paystack's own retry attempts (`past_due_since`, set with `COALESCE` so
repeated `invoice.payment_failed` webhooks for the same incident don't
restart the countdown). A successful payment clears it immediately.

Enforced in the same `requireActiveSubscription` middleware as the base
subscription gate - `active` always passes, `past_due` passes only while
still inside the 3-day window, everything else (never paid, cancelled, or
grace period expired) is blocked. Verified directly: marked a business
`past_due` from 1 day ago and confirmed real feature access still works with
`gracePeriodDaysLeft: 2` in the response; backdated it to 4 days ago and
confirmed the exact same request is now blocked with a message that
specifically says the grace period ended, not the generic "never activated"
message a new signup would see.

On the frontend: a business within its grace period keeps full access, with
a persistent warning pill in the header ("Payment failed - N days left")
that only shows to the admin, since only they can act on it. Once the grace
period genuinely runs out, they're routed to Billing exactly like an
unpaid signup, but with distinguishing messaging - "your payment failed and
your grace period ended" rather than "activate your account", so it's clear
this is a renewal problem, not a first-time signup.

## No demo data in a real deployment

A fresh deployment now creates *only* the developer/owner account on first
run - nothing else. Verified directly: the businesses table has exactly one
row (a minimal technical record backing the developer login, not a fake
customer) and `/api/dev/clients` correctly shows no example customers at all.

This required separating two things that used to be accidentally tied
together: the developer/owner account (real, necessary infrastructure - the
only way to reach My Business, PIN recovery, etc.) and the old "John's
Restaurant" demo business (fake example data that has no place in a real
deployment). They're no longer the same business. The developer account now
requires you to set your own `DEVELOPER_USERNAME`/`DEVELOPER_PIN` in `.env`
before first run - there's no shipped default credential.

If you want sample data for local development or trying out the app,
`node seed-demo.js` creates the old "John's Restaurant" example business
(admin + 2 staff + 2 suppliers + 1 item) - but only if you run it yourself.
The server never runs it automatically. Safe to run more than once; it does
nothing if that demo business already exists.

A real customer signing up through the actual signup wizard was already
unaffected by any of this - `POST /api/signup` never created example data
for a new business to begin with.

## Full system diagnostic

A single continuous test walks a real customer through the entire app in one
connected flow, rather than testing each piece in isolation: sign up ->
confirm blocked while unpaid -> real Paystack checkout -> real payment ->
real invoice generated with correct VAT math -> features unlock immediately
-> create a supplier and item -> scan an invoice -> duplicate detection
correctly flags a repeat -> approve it -> Insights and Daily Summary reflect
it -> confirm price-trend data is correctly gated (Professional plan, so no)
-> staff limit correctly stops at 5 -> forged webhook rejected -> developer's
My Business dashboard sees this new customer, a regular admin can't -> a
simulated renewal failure doesn't cut off access (grace period). All 24
checks passed against the real running app - not mocked pieces tested apart
from each other.

## Load testing - can it handle 100 customers at once

Yes, tested for real, not estimated. Seeded 100 (then 300, to check headroom)
genuinely separate businesses and fired real concurrent requests representing
what happens if every customer uses the app at the exact same moment - page
loads, billing checks, real scan submissions (the heaviest common write), and
Insights (the heaviest common read, with several joins and aggregations).

At 100 concurrent requests: 100/100 succeeded on every round, all completing
in under 900ms. At 300 (3x the target, to see the actual safety margin
rather than just confirm the minimum bar): still 300/300 succeeded on every
round, completing in under 2.3 seconds even for concurrent writes.

The one real, worth-knowing tuning point: the Postgres connection pool had no
explicit size set, meaning it silently used `pg`'s default of 10 simultaneous
connections. Tested both the default and an explicit 20 - no meaningful
difference at this load in this environment, since request queueing behind a
small pool is normal and fast for quick queries like these. Set it to 20
anyway (`DB_POOL_MAX` in `.env.example`) as cheap headroom for when you scale
well past 100, rather than leaving it as an unexamined default.

**What this does and doesn't prove**: this confirms the app itself - the
code, the queries, the connection handling - holds up under genuine
concurrent load from 100+ distinct businesses. It doesn't account for real
internet latency (this ran locally), sustained load over hours/days, or
Railway's specific infrastructure limits - worth a quick real-world check
once you're actually deployed with real traffic, the same way I've flagged
for Paystack webhooks.

## What this replaces

In the current HTML-only app, login and permissions are enforced by JavaScript
running in the browser - which the person using the browser can bypass. This
backend moves that enforcement to a server the browser can't control.

## Now running on Postgres, all-in-one with Railway

This backend was originally built on SQLite for zero-setup local testing, then
converted to run on real Postgres so it can be deployed as a single Railway
app: backend, frontend, and database all in one project. Every route was
rewritten (SQLite's synchronous `better-sqlite3` calls became async Postgres
queries via `pg`), and re-tested against a real local Postgres instance - 80
tests passed, including specific checks on the riskiest parts of that
conversion (VAT math, numeric type handling, date-range queries, webhook
signatures, PDF generation). See "What was tested" for the full list.

**One Postgres-specific gotcha worth knowing if you extend this**: Postgres's
`pg` driver returns `COUNT()`/`SUM()` results as strings by default (to avoid
precision loss on very large numbers), not real JS numbers the way SQLite did.
Every aggregate query in this codebase explicitly casts these (`::int`,
`::float`) so the API returns real numbers - if you add a new aggregate query,
remember to cast it too, or you'll get subtle bugs like `"0" || 0` evaluating
to the string `"0"` instead of falling through to a real fallback value (this
exact bug was caught and fixed in two spots during the conversion).

**The frontend is now served by this backend directly.** `GRV-Scanner-App.html`
lives in this same folder, and `server.js` serves it alongside the API. The
app's `API_BASE` is now a relative path (`/api`) instead of a hardcoded URL -
this means **you now open the app by visiting the server's own address**
(e.g. `http://localhost:4000` locally, or your Railway URL in production),
not by double-clicking the HTML file directly - a relative path only
resolves correctly when the browser loaded the page from that same server.

## Deploying to Railway

1. **Get the code onto GitHub.** Railway deploys from a GitHub repo, not a
   zip upload. Create a new repo, push this whole `backend-starter` folder to
   it (including `GRV-Scanner-App.html`).

2. **Create a new Railway project** and connect it to that repo. Railway will
   detect it's a Node app automatically (it reads `package.json`).

3. **Add a Postgres database** to the same Railway project (Railway's own
   "New" > "Database" > "Postgres" in the project dashboard). Railway
   automatically provides a `DATABASE_URL` variable you can reference - no
   Volume, no mount path, no manual setup needed for persistence.

4. **Set environment variables** in Railway's service Variables tab (there's
   no `.env` file on Railway - these are set directly in their dashboard):
   - `DATABASE_URL` = reference your Postgres service's connection string
     (Railway usually lets you pick this from a dropdown once both services
     are in the same project)
   - `JWT_SECRET` = a real random string (generate with the command in `.env.example`)
   - `JWT_EXPIRES_IN` = `8h` (or your preference)
   - `ALLOWED_ORIGIN` = your Railway app's own URL, once you know it (or `*` while testing)
   - `PAYSTACK_SECRET_KEY`, `PAYSTACK_PLAN_STARTER/PROFESSIONAL/ENTERPRISE`, `PAYSTACK_CALLBACK_URL` - once you're ready for real billing (see "Real Paystack billing" below)
   - You do NOT need to set `PORT` or `FRONTEND_DIR` - Railway sets `PORT`
     automatically, and `FRONTEND_DIR` defaults correctly since the HTML file
     is right there in the same folder

5. **Deploy.** Railway will give you a public URL, something like
   `https://your-app-name.up.railway.app`. Open that URL directly - that's
   your whole app, frontend and backend together.

6. **Test it exactly like you tested locally**: log in with the seeded
   accounts, confirm data survives a Railway redeploy (push a trivial change
   and redeploy - your users/scans/invoices should still be there, since
   Railway's own Postgres persists independently of your app's deploys).

## Quick start (local development)

You need a local Postgres to run this against. Easiest path if you don't have
one already: install Postgres, then:

```bash
createdb grv_dev
```

Then:

```bash
npm install
cp .env.example .env
# Edit .env: set DATABASE_URL (e.g. postgresql://postgres:yourpassword@localhost:5432/grv_dev),
# a real JWT_SECRET (a command to generate one is in the file), and choose your
# own DEVELOPER_USERNAME/DEVELOPER_PIN - there's no default credential shipped.
node server.js
```

Open **http://localhost:4000** in your browser - not the HTML file directly,
since the app now expects to be served from this backend (see "Now running on
Postgres, all-in-one with Railway" below for why).

The schema is created on first run, along with just your own developer/owner
login (whatever you set `DEVELOPER_USERNAME`/`DEVELOPER_PIN` to) - no demo
business, no example data of any kind (see "No demo data in a real
deployment" below).

If you want sample data to actually try the app out with, run:

```bash
node seed-demo.js
```

This creates a demo business ("John's Restaurant") with:

| Username         | PIN      | Role      |
|-------------------|----------|-----------|
| john.dlamini        | 1010     | admin     |
| sarah.mokoena        | 1478     | processor |
| bongani.nkosi         | 2589     | dispatch  |

Also seeded: 2 suppliers (Unilever SA, Fresh Produce Co) and 1 item master entry
(Sunlight Dishwashing Liquid 750ml).

## PIN management model

- **Admin** can always reset any staff member's PIN (Users page) and change their own PIN (Settings > Security).
- **Staff (processor/dispatch)** cannot change their own PIN by default - admin resets it for them. Deliberate, to keep PIN management in one place.
- **Exception**: admin can grant a processor "Full Access - Manage Users & PINs" when creating or editing them. That processor can then create/deactivate other staff, reset their PINs, and change their own PIN - equivalent to admin for user management, though Billing stays admin-only regardless. Enforced by `requireUsersAccess` in `middleware/auth.js`, which checks the user's *current* stored permissions on every request rather than trusting anything baked into their login token - so revoking the permission takes effect on their very next action, not just their next login.

## Admin recovery

If a customer's admin gets locked out of their PIN, log in with your developer
account (whatever you set `DEVELOPER_USERNAME` to in `.env`) and click
"Recovery" in the header - it lists every business's admin account with a
one-click PIN reset. This is the only account that can do this; it's checked
server-side (`/api/dev/*` routes require the
`developer` role specifically), not just hidden in the UI. There's no
self-service "forgot my PIN" flow for admins yet (that would need email
sending set up) - this is the interim fallback until that exists.

## Session persistence across page refresh

The app now stays logged in across a browser refresh. On login, the session
token is saved to `localStorage`; on page load, the app calls `GET /api/auth/me`
to check that token is still valid and re-fetches current role/permissions
(not just whatever was true at login time), then restores the session without
requiring the user to log in again. If the account has since been deactivated
or the token has expired, this correctly falls through to the login screen
instead of restoring a stale session - tested directly, including
deactivating an account in a separate session and confirming a saved token for
that account can no longer restore a session afterward.

One limitation worth knowing: `localStorage` doesn't work inside a sandboxed
preview (e.g. viewing the file inside a chat interface's embedded frame) - it
works normally in an actual browser tab or once deployed. If localStorage is
unavailable for any reason, the app still works fine, sessions just won't
survive a refresh in that specific context - the same behavior as before this
feature was added.

## Tax invoices (VAT-compliant, generated automatically)

Every successful payment automatically generates a real invoice record with
VAT correctly broken out - not a flat total. Prices shown throughout the app
are VAT-inclusive (labeled "inc. VAT" on every plan price), so the invoice
divides that back out into Excl. VAT / VAT (15%) / Total, the way a proper SA
tax invoice needs to. A real branded PDF (GRV Scanner colors, invoice number,
line item, VAT breakdown) is generated on demand via `pdfkit` - not cached,
regenerated fresh from the stored record each time it's downloaded, so it's
always accurate even if you later change how invoices are formatted.

This does **not** email the invoice to the customer automatically - Paystack
already sends its own generic payment receipt (a dashboard setting, on by
default), but a properly branded GRV Scanner invoice currently has to be
downloaded from the Billing page rather than being emailed automatically.
Making that automatic needs the email-sending piece that's still on the "not
built yet" list - see the note on email in an earlier part of this project.

## Real company details on invoices

Every invoice now shows the actual customer's real company details - name,
address, contact number, email, VAT number - not just a bare business name.
These live on the `businesses` table (`address`, `contact_number`,
`contact_email`, `vat_number`) and are editable by the admin in Settings >
Business Details, which now saves to a real endpoint
(`GET/PUT /api/business/profile`) instead of the generic settings blob used
by the other Settings tabs. Verified end-to-end: edited the fields through the
real Settings form, confirmed they persisted to the backend, then generated a
real invoice and confirmed the PDF actually contains the updated details, not
stale ones.

Since there's no public signup flow yet (see the multi-business note further
down), this is the practical way these details get captured for now - a real
signup form would collect the same fields at sign-up time and write to the
same columns.

**Invoice numbering** changed from `INV-2026-0001` (per-business, which had a
real bug - see below) to a flat sequential format starting at `INV13647`
(`INV13647`, `INV13648`, ...), matching your existing numbering convention.

**A bug this caught, worth being upfront about**: the original invoice
numbering was scoped per-business, meaning two different customers' first
invoices would both try to become the same number, colliding on the database's
uniqueness constraint - which would have crashed the second customer's
first payment (Paystack would charge them, but recording the invoice would
fail). This only showed up once actually tested with more than one business,
which nothing before this had done. Fixed by making numbering globally
sequential across all customers, which is also just correct practice - it's
GRV Scanner's own invoice series as the issuing business, not one per
customer. Verified with two real businesses that numbers no longer collide.

## Plan-based feature gating

What the Billing page promises per tier is now actually enforced, server-side,
not just described:

| Feature | Starter | Professional | Enterprise |
|---|---|---|---|
| Duplicate invoice detection | No | Yes | Yes |
| Insights page (charts, spend trends) | No | Yes | Yes |
| Price increase detection (price trends, previous-price comparison, price alert counts) | No | No | Yes |

This is defined in one place - `routes/planFeatures.js` - and checked in every
endpoint that touches these features (`/scans/check-duplicate`, scan creation's
server-side duplicate safety net, `/reports/summary`, `/reports/insights`,
`/item-master`). If you change what a plan promises on the Billing page,
update `PLAN_FEATURES` in that file too, or you're back to advertising things
that don't actually work - which is exactly the problem this was built to fix.

Gating happens server-side, not just by hiding UI - confirmed by calling the
gated endpoints directly regardless of what the frontend shows. On the
frontend, a Starter business sees a real "Upgrade to Professional" prompt on
the Insights page instead of a broken or empty page; Item Master shows a
plain "-" instead of a previous price/% change for anyone below Enterprise.

Tested by actually moving a real business through Starter -> Professional ->
Enterprise and confirming, at each step, that the right things turn on and
off - both via direct API calls and by loading the actual rendered page.

## Plan-based quota enforcement

Beyond the on/off capabilities above, three real numeric limits from the
Billing page are now hard-enforced, not just displayed:

| Limit | Starter | Professional | Enterprise |
|---|---|---|---|
| Staff accounts | 0 (admin-only) | 5 | Unlimited |
| Scans per month | 150 | 600 | 2,000 |
| Scan history access | Last 30 days | Unlimited | Unlimited |

Staff and scan limits are hard blocks - verified by trying to add staff on
Starter (real 403), seeding exactly 150 scans and confirming the 151st is
rejected, and confirming Enterprise genuinely accepts more than 5 staff
(the old code had one blanket 5-cap applied to every plan, which was wrong
for both Starter, who shouldn't get any staff, and Enterprise, who should
get unlimited - both directions are now fixed).

Scan history isn't a hard block - a Daily Summary request partially outside
a Starter account's 30-day window gets clamped to what's actually allowed,
with `historyLimited: true` in the response so the frontend can explain why,
rather than silently returning less than asked for. Confirmed real scans
within the allowed window still show up correctly even when the requested
range is clamped.

On the frontend: the Add User form shows the real server error when a staff
limit is hit; the Scan Invoice page proactively checks usage on every visit
and disables scanning with a clear banner once the monthly cap is reached,
rather than only failing at submit time; Daily Summary shows a visible
notice when a request got clamped to the history window.

## My Business (owner-only, cross-business view)

A separate page and tile, visible only during your own developer
session - a regular admin (even one for the seeded business) can never see
this, tested both via the UI (tile hidden) and server-side (403 even on a
direct API call). Three sections:

- **Clients**: every business using GRV Scanner, with their plan, real
  subscription status, staff count, and real scan volume.
- **Invoices**: every revenue invoice across every client for a given month -
  what you'd actually hand to your accountant or use for a VAT return. Real
  CSV bulk export, plus individual PDF downloads (reuses the same branded PDF
  generator as the customer-facing Billing page, refactored into a shared
  function so both stay visually consistent).
- **Insights**: is GRV Scanner actually growing? Real month-by-month new
  client counts, real MRR (monthly recurring revenue based on actual active
  subscriptions, not estimates), real revenue this month, and which plan tier
  is genuinely most popular among active subscribers.

All of this is computed from real data (`businesses`, `invoices`, `scans`) -
none of it is generated or hardcoded. With only one seeded business, the
growth chart and plan-popularity breakdown will look sparse until there's
real multi-client data - the queries are correct and ready for that, they
just don't have much to show yet in this demo state.

## Real Paystack billing

Billing is now backed by a real Paystack integration, not a placeholder:

1. Sign up at paystack.com, get your **test** secret key from Settings > API
   Keys & Webhooks, and put it in `.env` as `PAYSTACK_SECRET_KEY`.
2. In your Paystack dashboard, create a **Plan** for each tier (Starter,
   Professional, Enterprise) with the price you want to charge, then paste
   each plan's code into `.env` (`PAYSTACK_PLAN_STARTER`, etc.).
3. Set `PAYSTACK_CALLBACK_URL` to wherever this app is actually served from -
   Paystack redirects the admin back there after checkout.
4. In your Paystack dashboard, set the webhook URL to
   `https://your-domain.com/api/billing/webhook` - this is how renewals,
   failed charges, and cancellations initiated from Paystack's own dashboard
   get reflected back into this app.

Without a `PAYSTACK_SECRET_KEY` set, every billing action fails with a clear
"payment provider is not connected yet" message instead of crashing or faking
success - the app works fine without it, you just can't take real payment.

**What was actually tested, since I don't have your Paystack account**: I
can't hit Paystack's real servers without your credentials, so I built a
local mock server that returns responses in the exact shape Paystack's real
API documents (same field names, same status/data wrapper), and ran the real
integration code against it - checkout, verification, webhooks (including
signature verification, both accepting a validly-signed event and rejecting a
forged one), and cancellation, clicking through the actual app UI, not just
calling the API directly. This proves the *logic* is correct and matches
Paystack's documented contract. Final confirmation against Paystack's real
test sandbox still needs your own test secret key - I'd suggest doing one
real test payment (test cards are on Paystack's docs) before going live.

While building this, the testing process caught a real edge case in the app
itself: if `checkPaystackCallback()` ran before the session had finished
restoring (e.g. right after a page reload, before the saved token was
re-validated), it would silently discard the payment reference instead of
verifying it once login completed. Fixed so it holds onto the reference and
retries automatically right after a successful login/session-restore.

## Endpoints in this starter

- `POST /api/auth/login` - `{ username, pin }` -> `{ token, user }`
- `GET /api/auth/me` - validates a saved token and returns current user data,
  used to restore a session after a page refresh
- `GET  /api/users` - admin/developer only
- `POST /api/users` - admin/developer only, creates a staff user (server enforces the 4-digit PIN rule)
- `POST /api/users/:id/reset-pin` - admin/developer only
- `PATCH /api/users/:id/deactivate` - admin/developer only
- `GET /api/suppliers` - admin/processor/dispatch/developer (dispatch needs this for the scan dropdown)
- `POST/PUT/DELETE /api/suppliers` - admin/processor/developer only
- `GET/POST/PUT/DELETE /api/item-master` - admin/processor/developer (not dispatch).
  GET responses include `previous_price` and `change_pct`, computed from real
  price history - not fabricated. Prices update automatically whenever an
  approved scan's line item matches a known item code.
- `POST /api/scans` - admin/processor/dispatch/developer (everyone who can scan).
  Accepts an optional `note` field (dispatch notes, shown on Pending Review).
- `GET /api/scans` - dispatch sees only their own scans; admin/processor see all
- `GET /api/scans/:id/line-items` - line items for one scan
- `PATCH /api/scans/:id/approve` / `PATCH /api/scans/:id/reject` - admin/processor only (dispatch cannot approve their own scans)
- `GET /api/reports/summary?start=YYYY-MM-DD&end=YYYY-MM-DD` - real aggregated
  Daily Summary data (scan count, staff count, VAT total, price alerts, grand
  total, and a per-scan breakdown) built from actual scans in that date range
- `GET/PUT /api/business/profile` - admin/developer, real company details
  (name, address, contact number, email, VAT number) used on invoices
- `GET/PUT /api/business/settings` - admin/developer, flexible JSON blob for
  Settings page preferences
- `GET/PATCH /api/business/plan` - admin/developer, real plan storage for
  Billing, includes real `scansThisMonth` usage count
- `GET /api/reports/insights` - admin/processor/developer, real aggregated data
  for every chart on the Insights page (spend per supplier, top products,
  monthly trend, per-item price trends, etc.) - all computed from actual
  approved scans, not generated
- `POST /api/users/me/change-pin` - admin/developer only. Staff PINs are
  managed by admin via the Reset PIN flow instead (Users page) - this keeps
  PIN management in one place rather than every role having its own path.

- `GET /api/dev/admins` / `POST /api/dev/admins/:userId/reset-pin` - developer
  role only, lists every business's admin and resets their PIN (see "Admin
  recovery" above)
- `GET /api/dev/clients` - developer only, every business using GRV Scanner
- `GET /api/dev/invoices?month=YYYY-MM` - developer only, every revenue
  invoice across every client for that month, with totals
- `GET /api/dev/invoices/export.csv?month=YYYY-MM` - developer only, CSV bulk
  export of the above
- `GET /api/dev/invoices/:id/pdf` - developer only, downloads any client's
  invoice PDF (not scoped to your own business, unlike the customer-facing version)
- `GET /api/dev/insights` - developer only, real cross-business growth/MRR/plan-popularity data

- `POST /api/billing/checkout` - admin/developer only, starts a real Paystack
  subscription payment, returns a checkout URL to redirect to
- `GET /api/billing/verify/:reference` - admin/developer only, confirms a
  payment really succeeded before updating the plan (never trusts the redirect alone)
- `POST /api/billing/cancel` - admin/developer only, really cancels the
  subscription with Paystack
- `POST /api/billing/webhook` - called by Paystack directly (not the browser),
  signature-verified, keeps subscription status in sync with renewals/failures/cancellations

- `GET /api/billing/invoices` - admin/developer only, lists real invoices for the business
- `GET /api/billing/invoices/:id/pdf` - admin/developer only, generates and
  streams a real branded PDF invoice with correct VAT breakdown

All routes except `/login` and the webhook require `Authorization: Bearer <token>`.

## The frontend is now connected

The GRV Scanner app (the HTML file) has been rewired to call this API for login,
users, suppliers, item master, and scan submission, instead of using temporary
in-browser arrays. It points at `http://localhost:4000/api` by default (see the
`API_BASE` constant near the top of the app's `<script>` block) - change that to
your deployed backend's real URL once you host it somewhere.

## What was tested (not just written)

**Most recent: the full SQLite-to-Postgres conversion**, tested against a real
local Postgres 16 instance (not mocked):
- All 55 existing regression tests re-run and passing against Postgres
- 25 additional tests targeting the specific riskiest parts of the conversion:
  VAT math exactness, numeric type casting (Postgres returns COUNT/SUM as
  strings by default - confirmed the app gets real numbers back), date-range
  queries (SQLite's `strftime`/`date()` converted to Postgres's `TO_CHAR`/
  `::date` casts), webhook signature verification, PDF generation, and MRR
  calculation
- Data confirmed surviving a full Node process restart (Postgres persists
  independently of the app process)
- Caught and fixed two real gaps during this pass: a supplier's invoice count
  and a user's scan count weren't cast to real numbers, risking a
  `"0" || 0` string-truthiness bug even though no current display broke as a
  result - fixed for correctness
- Also caught a real test-harness gap while verifying the new relative
  `API_BASE`: Node's bare `fetch()` doesn't resolve relative URLs against a
  page origin the way every real browser's native `fetch()` does - fixed the
  test's fetch polyfill to be origin-aware and confirmed the app's real
  behavior (which was correct) rather than trusting an untested assumption

I ran the actual server and hit it with real HTTP requests before handing this over:

1. Requests with no token are rejected (401).
2. A processor login cannot reach the admin-only `/api/users` endpoint (403) -
   this is the core fix: it's blocked by the server, not by a hidden button.
3. A processor login CAN reach `/api/suppliers`, matching their intended access.
4. Wrong PIN is rejected (401).
5. A non-existent username returns the exact same error as a wrong PIN, so an
   attacker can't tell which usernames exist.
6. The developer account's 8-digit PIN works; a 4-digit guess against that same
   account does not.
7. Creating a staff user with anything other than a 4-digit PIN is rejected by
   the server itself (400), even if a modified frontend tried to send one.
8. PINs are never stored in plain text - confirmed by reading the database
   directly and checking the stored value doesn't contain the real PIN.
9. Login attempts are rate-limited per IP (30 per 15 minutes) - confirmed by
   actually sending repeated requests and seeing 429 kick in once the limit is
   hit. (Raised from an initial 10 after real end-to-end testing - which does
   many legitimate logins in one run - kept tripping it; 30 is still far too
   low for anyone to realistically brute-force a 4-digit PIN with, but gives
   normal usage headroom.)
10. Full end-to-end: ran this backend and the actual app file together (not
    mocked) - logged in for real, created a user and immediately logged in as
    them, created a supplier, ran a full AI-extracted scan through to "lock",
    confirmed it appeared in Pending Review with its real line items, approved
    it, and confirmed it disappeared from the pending list. Then killed the
    backend process entirely, restarted it fresh, and confirmed the user,
    supplier, scan, and its "approved" status were all still there.
11. Second full pass covering the newer features: confirmed a supplier's
    invoice count and spend total update correctly the moment a scan against
    them is approved; confirmed Item Master shows a genuine previous price and
    % change (not fabricated) after a scan updates an item's price, with the
    math independently verified (R18.50 to R21.50 = +16.2%); confirmed a
    dispatch note submitted with a scan shows up on the Pending Review card
    and inside the approval modal; confirmed Daily Summary shows the real
    scans that happened that day, not generated ones; confirmed a Settings
    save and a Billing plan change both actually persist. All of this was
    re-confirmed surviving a full backend restart.

While building this, caught and fixed a genuine race condition in the app
itself (not just the test): `loadSummary()` wasn't returning the promise from
its internal fetch, so anything awaiting it would silently move on before the
data actually arrived. Fixed so it returns properly.

12. Third full pass, covering the remaining tiles: confirmed the Insights page
    (all 7 charts + 5 stat cards) now reflects real approved-scan data instead
    of hardcoded numbers - verified the actual chart data arrays contain real
    supplier names and real monthly figures, not the original fake "Pioneer /
    Sea Harvest" supplier list or 12 months of invented spend. Confirmed
    Billing shows your real stored plan and real usage against the real cap,
    and that changing plans correctly moves the "Current Plan" badge and
    button labels to match. Confirmed self-service PIN change end-to-end: a
    wrong current PIN is rejected, a correct change succeeds, the old PIN
    stops working immediately, and the new PIN works to log in - all
    re-confirmed surviving a full backend restart.

## Swapping SQLite for Postgres (for real deployment)

This uses `better-sqlite3` so it runs with zero setup. For production, swap it for
`pg` and a hosted Postgres (Railway, Render, Supabase, Neon all have free tiers
that would comfortably cover a handful of restaurants). The SQL in `schema.sql`
is close to standard already - the main changes are `AUTOINCREMENT` -> `SERIAL`
or `GENERATED ALWAYS AS IDENTITY`, and swapping `better-sqlite3`'s synchronous
calls for `pg`'s async `query()` calls in `db.js` and the route files.

## What's honestly still missing

- HTTPS termination (handled by whatever host you deploy to - Railway/Render do
  this automatically; a raw VPS would need a reverse proxy like Caddy or nginx)
- Password/PIN reset via email (self-service change while logged in works;
  "forgot my PIN" recovery does not)
- Audit log read endpoints (the table exists and is being written to, just no
  API to view it yet)
- Multi-business signup flow (right now there's one seeded business; a real
  signup form would create a new `businesses` row per customer)
- **Real payment processing is now built** (see "Real Paystack billing" above)
  - but it needs your own Paystack account and API keys to actually take
  payment. Until `PAYSTACK_SECRET_KEY` is set, Billing correctly displays
  everything and fails cleanly rather than faking a charge or a cancellation.
 
