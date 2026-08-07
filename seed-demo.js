// OPTIONAL - for local development and testing only. Never run automatically
// by the server. A real deployment should never have fake example data in it.
//
// Usage: node seed-demo.js
//
// Creates a sample business ("John's Restaurant") with an admin, two staff
// accounts, two suppliers, and one item master entry - useful for trying out
// the app locally or running the test suite, which expects these accounts
// to exist. Safe to run multiple times - does nothing if this demo business
// already exists.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, ready } = require('./db');

async function seedDemoBusiness() {
  await ready(); // make sure the schema (and the real developer account) exist first

  const existing = await pool.query(`SELECT id FROM businesses WHERE name = $1`, ["John's Restaurant"]);
  if (existing.rows[0]) {
    console.log("Demo business \"John's Restaurant\" already exists - nothing to do.");
    await pool.end();
    return;
  }

  const bizResult = await pool.query(
    `INSERT INTO businesses (name, address, contact_number, contact_email, vat_number, plan, subscription_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING id`,
    ["John's Restaurant", '14 Voortrekker Street, Johannesburg, 2001, South Africa', '011 555 0100', 'accounts@johnsrestaurant.co.za', '4123456789', 'professional']
  );
  const businessId = bizResult.rows[0].id;

  const seedUsers = [
    { username: 'john.dlamini', email: 'john@johnsrestaurant.co.za', first_name: 'John', last_name: 'Dlamini', role: 'admin', pin: '1010', permissions: {} },
    { username: 'sarah.mokoena', email: 'sarah@johnsrestaurant.co.za', first_name: 'Sarah', last_name: 'Mokoena', role: 'processor', pin: '1478', permissions: { approvals: true, suppliers: true, itemmaster: true, insights: false, daily: false, settings: false, users: false } },
    { username: 'bongani.nkosi', email: 'bongani@johnsrestaurant.co.za', first_name: 'Bongani', last_name: 'Nkosi', role: 'dispatch', pin: '2589', permissions: {} },
  ];

  for (const u of seedUsers) {
    await pool.query(
      `INSERT INTO users (business_id, username, email, first_name, last_name, role, pin_hash, status, permissions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)`,
      [businessId, u.username, u.email, u.first_name, u.last_name, u.role, bcrypt.hashSync(u.pin, 10), JSON.stringify(u.permissions)]
    );
  }

  await pool.query(
    `INSERT INTO suppliers (business_id, name, account_no, vat_number, vat_type, contact_name, phone, email, terms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [businessId, 'Unilever SA', 'UNI-001', '4123456789', 'vat', 'John Sales', '011 555 0001', 'john.sales@unilever.co.za', '30 days']
  );
  await pool.query(
    `INSERT INTO suppliers (business_id, name, account_no, vat_number, vat_type, contact_name, phone, email, terms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [businessId, 'Fresh Produce Co', 'FPC-014', null, 'exempt', 'Themba Nkosi', '082 555 0010', 'themba@freshproduceco.co.za', '7 days']
  );

  const unileverResult = await pool.query('SELECT id FROM suppliers WHERE name = $1', ['Unilever SA']);
  const unileverId = unileverResult.rows[0].id;
  const itemResult = await pool.query(
    `INSERT INTO item_master (business_id, code, name, unit, current_price, supplier_id, last_ordered_at)
     VALUES ($1,$2,$3,$4,$5,$6, NOW()) RETURNING id`,
    [businessId, 'SUN-750', 'Sunlight Dishwashing Liquid 750ml', 'each', 18.50, unileverId]
  );
  await pool.query(`INSERT INTO item_price_history (item_id, price, source) VALUES ($1, $2, 'manual')`, [itemResult.rows[0].id, 18.50]);

  await pool.query(
    `INSERT INTO business_settings (business_id, settings_json) VALUES ($1, $2)`,
    [businessId, JSON.stringify({ emailNotifications: true, priceAlertThreshold: 10, defaultVatRate: 15 })]
  );

  console.log('Demo business seeded: "John\'s Restaurant" (1 admin, 2 staff, 2 suppliers, 1 item).');
  console.log('Admin login -> username: john.dlamini   PIN: 1010');
  await pool.end();
}

seedDemoBusiness().catch(err => { console.error('Seeding failed:', err); process.exit(1); });
