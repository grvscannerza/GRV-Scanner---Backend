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

app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

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
