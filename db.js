const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('\nSTOP: Set DATABASE_URL in your .env file - a Postgres connection string.');
  console.error('On Railway, add a Postgres service to your project and it provides this automatically.\n');
  process.exit(1);
}

// Railway's managed Postgres (and most hosted Postgres) requires SSL, but with
// a self-signed-style cert chain that Node rejects by default. This matches
// how Railway's own docs recommend connecting.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
});

async function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema-postgres.sql'), 'utf8');
  await pool.query(schema);
}

// The ONLY thing created automatically, ever - the developer/owner login
// itself. This is not a demo or example customer; it's the actual platform
// admin account (My Business dashboard, recovery panel, etc.) and the app has
// no way to reach those tools without it existing. It gets a minimal
// technical business record purely to satisfy the database's foreign key
// requirement (every user belongs to a business) - no suppliers, no staff,
// no example data of any kind. A brand new deployment therefore starts
// completely empty from a real customer's point of view: no fake business,
// no fake invoices, nothing to clean up before going live.
async function ensureDeveloperAccount() {
  const existing = await pool.query(`SELECT id FROM users WHERE role = 'developer' LIMIT 1`);
  if (existing.rows[0]) return;

  const devPin = process.env.DEVELOPER_PIN;
  if (!devPin || !/^\d{6,10}$/.test(devPin)) {
    console.error('\nSTOP: Set DEVELOPER_PIN in your .env file (6-10 digits) before first run.');
    console.error('This becomes your own developer/owner login PIN - there is no default.\n');
    process.exit(1);
  }
  const devUsername = process.env.DEVELOPER_USERNAME || 'developer';

  const bizResult = await pool.query(
    `INSERT INTO businesses (name, plan, subscription_status) VALUES ($1, 'enterprise', 'active') RETURNING id`,
    ['GRV Scanner (Platform)']
  );
  const businessId = bizResult.rows[0].id;

  await pool.query(
    `INSERT INTO users (business_id, username, email, first_name, last_name, role, pin_hash, status, permissions)
     VALUES ($1, $2, NULL, 'Developer', 'Account', 'developer', $3, 'active', '{}')`,
    [businessId, devUsername, bcrypt.hashSync(devPin, 10)]
  );

  console.log(`Developer account created - username: ${devUsername}`);
}

let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = initSchema().then(ensureDeveloperAccount).catch(err => {
      console.error('Database initialization failed:', err);
      process.exit(1);
    });
  }
  return readyPromise;
}

module.exports = { pool, ready };
