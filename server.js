require('./load-env-local')();
const path = require('path');
const express = require('express');
const cors = require('cors');
const db = require('./db');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'replace_this_with_a_long_random_string') {
  console.error('\nSTOP: Set a real JWT_SECRET in your .env file before running this.');
  console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n');
  process.exit(1);
}

const app = express();

// The Paystack webhook needs the RAW request body to verify its signature -
// it must be registered with express.raw() BEFORE the global express.json()
// below, or the body would already be parsed into an object by the time it
// gets there and signature verification would fail for every real webhook.
const billing = require('./routes/billing');
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), billing.webhookHandler);

// Default 100kb is far too small for a base64-encoded invoice photo (even
// compressed client-side, this can easily be a few hundred KB) - without
// raising this, every scan gets silently rejected before reaching any route
// at all, showing only a generic error with no useful detail.
app.use(express.json({ limit: '15mb' }));

// ALLOWED_ORIGIN can be a comma-separated list (e.g.
// "https://grvscanner.co.za,https://www.grvscanner.co.za") so the real
// production domain(s) can be locked in via a Railway environment variable,
// without a code change. Left unset, this falls back to "*" (any origin) -
// the same open behaviour as before - so nothing breaks before that
// variable is added. A request with no Origin header at all (server-to-server
// calls, curl, the Paystack webhook) is always allowed, since the Origin
// check only ever matters for requests made from inside a browser.
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '*').split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // Deliberately callback(null, false), not an Error - an Error here would
    // fall through to the catch-all error handler and show as a fake 500 in
    // logs/monitoring for what is just an ordinary disallowed cross-origin
    // request, not a real server fault. false simply skips adding the
    // Access-Control-Allow-Origin header, which is all a browser actually
    // checks to block the response - the request still gets a normal status
    // code, there's just nothing in the CORS header for it to match.
    callback(null, false);
  },
}));

// Public marketing page needs this too, but visitors aren't logged in yet -
// this is the ONLY place plan numbers should ever be read for that page, so
// it can never say something different from what the app actually delivers.
app.get('/api/public/plan-features', (req, res) => {
  const { PLAN_FEATURES } = require('./routes/planFeatures');
  res.json(PLAN_FEATURES);
});

app.post('/api/public/contact', async (req, res) => {
  const { name, phone, email, message } = req.body || {};
  if (!name?.trim() || !phone?.trim() || !email?.trim() || !message?.trim()) {
    return res.status(400).json({ error: 'Please fill in every field.' });
  }
  if (!email.includes('@')) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  try {
    const { pool } = require('./db');
    await pool.query(
      'INSERT INTO contact_submissions (name, phone, email, message) VALUES ($1, $2, $3, $4)',
      [name.trim(), phone.trim(), email.trim(), message.trim()]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/signup', require('./routes/signup'));
app.use('/api/users', require('./routes/users'));
app.use('/api/suppliers', require('./routes/suppliers'));
app.use('/api/item-master', require('./routes/itemMaster'));
app.use('/api/scans', require('./routes/scans'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/business', require('./routes/business'));
app.use('/api/dev', require('./routes/dev'));
app.use('/api/billing', billing.router);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Serve the frontend HTML file too, so Railway can host backend + frontend as
// one app. Put GRV-Scanner-App.html in this same folder (or point
// FRONTEND_DIR at wherever it lives) for this to work.
const frontendDir = process.env.FRONTEND_DIR ? path.resolve(process.env.FRONTEND_DIR) : __dirname;
app.use(express.static(frontendDir));
app.get('/', (req, res, next) => {
  const indexPath = path.join(frontendDir, 'GRV-Scanner-App.html');
  res.sendFile(indexPath, (err) => { if (err) next(); });
});

// Catch-all error handler - never leak internal error details to the client.
app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That file is too large. Please try a smaller photo or a lower-resolution scan.' });
  }
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

const port = process.env.PORT || 4000;

// Don't start accepting requests until the database schema is applied and
// seeded (if needed) - otherwise the very first requests could race against
// table creation and fail confusingly.
db.ready().then(() => {
  app.listen(port, () => {
    console.log(`GRV Scanner API listening on http://localhost:${port}`);
  });
}).catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
