-- GRV Scanner backend schema - PostgreSQL version.

-- A "business" is one customer account (e.g. one restaurant). Everything else
-- belongs to exactly one business, so businesses can never see each other's data.
CREATE TABLE IF NOT EXISTS businesses (
  id                        SERIAL PRIMARY KEY,
  name                      TEXT NOT NULL,
  address                   TEXT,
  contact_number            TEXT,
  contact_email             TEXT,
  vat_number                TEXT,
  plan                      TEXT NOT NULL DEFAULT 'professional',
  subscription_status       TEXT NOT NULL DEFAULT 'inactive' CHECK (subscription_status IN ('inactive','active','past_due','cancelled')),
  past_due_since            TIMESTAMPTZ,
  paystack_customer_code    TEXT,
  paystack_subscription_code TEXT,
  paystack_email_token      TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every human who can log in: the business owner (admin), processors, and dispatch staff.
-- pin_hash / password_hash store a bcrypt hash - the real PIN/password is never stored.
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  business_id     INTEGER NOT NULL REFERENCES businesses(id),
  username        TEXT NOT NULL UNIQUE,
  email           TEXT,
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin','processor','dispatch','developer')),
  pin_hash        TEXT NOT NULL,          -- bcrypt hash of a 4-digit PIN (or the dev account's longer PIN)
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  permissions     TEXT NOT NULL DEFAULT '{}',  -- JSON blob, e.g. {"insights":true,"daily":false,"settings":false}
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS suppliers (
  id            SERIAL PRIMARY KEY,
  business_id   INTEGER NOT NULL REFERENCES businesses(id),
  name          TEXT NOT NULL,
  account_no    TEXT,
  vat_number    TEXT,
  vat_type      TEXT NOT NULL DEFAULT 'vat' CHECK (vat_type IN ('vat','exempt')),
  contact_name  TEXT,
  phone         TEXT,
  email         TEXT,
  terms         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS item_master (
  id              SERIAL PRIMARY KEY,
  business_id     INTEGER NOT NULL REFERENCES businesses(id),
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  unit            TEXT NOT NULL DEFAULT 'each',
  current_price   REAL NOT NULL DEFAULT 0,
  supplier_id     INTEGER REFERENCES suppliers(id),
  last_ordered_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(business_id, code)
);

CREATE TABLE IF NOT EXISTS scans (
  id             SERIAL PRIMARY KEY,
  business_id    INTEGER NOT NULL REFERENCES businesses(id),
  supplier_id    INTEGER NOT NULL REFERENCES suppliers(id),
  scanned_by     INTEGER NOT NULL REFERENCES users(id),
  invoice_number TEXT,
  note           TEXT,
  scanned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  excl_vat       REAL NOT NULL,
  vat            REAL NOT NULL,
  total          REAL NOT NULL,
  price_alerts   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approved_by    INTEGER REFERENCES users(id),
  approved_at    TIMESTAMPTZ,
  is_duplicate   BOOLEAN NOT NULL DEFAULT false,
  duplicate_of_scan_id INTEGER REFERENCES scans(id)
);

CREATE TABLE IF NOT EXISTS scan_line_items (
  id            SERIAL PRIMARY KEY,
  scan_id       INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  description   TEXT NOT NULL,
  code          TEXT,
  qty           REAL NOT NULL DEFAULT 0,
  unit          TEXT NOT NULL DEFAULT 'each',
  unit_price    REAL NOT NULL DEFAULT 0,
  flag          TEXT NOT NULL DEFAULT 'ok' CHECK (flag IN ('ok','up','down','new'))
);

-- One row per successful subscription payment. Prices shown to the user are
-- VAT-inclusive, so amount_excl_vat and vat_amount are derived by dividing
-- back out the 15% (SA VAT rate), not charged separately.
CREATE TABLE IF NOT EXISTS invoices (
  id                SERIAL PRIMARY KEY,
  business_id       INTEGER NOT NULL REFERENCES businesses(id),
  invoice_number    TEXT NOT NULL UNIQUE,
  plan              TEXT NOT NULL,
  amount_incl_vat   REAL NOT NULL,
  amount_excl_vat   REAL NOT NULL,
  vat_amount        REAL NOT NULL,
  paystack_reference TEXT,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every meaningful action, kept even if the acting user is later deleted.
-- This is what lets you answer "who did this and when" after the fact.
CREATE TABLE IF NOT EXISTS audit_log (
  id            SERIAL PRIMARY KEY,
  business_id   INTEGER NOT NULL,
  actor_user_id INTEGER,
  action        TEXT NOT NULL,      -- e.g. 'user.created', 'supplier.deleted', 'scan.approved'
  target_type   TEXT,               -- e.g. 'user', 'supplier', 'scan'
  target_id     INTEGER,
  details       TEXT,               -- JSON blob with whatever's useful for that action
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per business, holding whatever preferences the Settings page exposes.
-- Kept as a flexible JSON blob rather than one column per setting, since the
-- exact set of settings tends to grow over time.
CREATE TABLE IF NOT EXISTS business_settings (
  business_id   INTEGER PRIMARY KEY REFERENCES businesses(id),
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every time an item's price changes (via a scan or a manual edit), a row goes
-- here. This is what lets Item Master show a real "previous price" and "%
-- change" instead of a fabricated one.
CREATE TABLE IF NOT EXISTS item_price_history (
  id          SERIAL PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES item_master(id) ON DELETE CASCADE,
  price       REAL NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','scan')),
  scan_id     INTEGER REFERENCES scans(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
