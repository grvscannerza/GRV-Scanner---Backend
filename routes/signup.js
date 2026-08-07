const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const router = express.Router();

// Public - no requireAuth, since this is how an account gets created in the
// first place. Everything is validated server-side regardless of what the
// frontend's multi-step form already checked, since a request could bypass
// the UI entirely.
router.post('/', async (req, res) => {
  const { personal, company } = req.body || {};

  // ── Personal details - all mandatory ──
  if (!personal) return res.status(400).json({ error: 'Personal details are required.' });
  const { firstName, lastName, username, email, pin } = personal;
  if (!firstName || !firstName.trim()) return res.status(400).json({ error: 'First name is required.' });
  if (!lastName || !lastName.trim()) return res.status(400).json({ error: 'Last name is required.' });
  if (!username || !username.trim()) return res.status(400).json({ error: 'Username is required.' });
  if (!email || !email.trim()) return res.status(400).json({ error: 'Email address is required.' });
  if (!email.includes('@')) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (!pin || !/^\d{4}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });

  // ── Company details - all mandatory except VAT number, since not every
  // South African business is VAT-registered (there's a turnover threshold) ──
  if (!company) return res.status(400).json({ error: 'Company details are required.' });
  const { name, address, contactNumber, contactEmail, vatNumber } = company;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Company name is required.' });
  if (!address || !address.trim()) return res.status(400).json({ error: 'Company address is required.' });
  if (!contactNumber || !contactNumber.trim()) return res.status(400).json({ error: 'Company contact number is required.' });
  if (!contactEmail || !contactEmail.trim()) return res.status(400).json({ error: 'Company email address is required.' });
  if (!contactEmail.includes('@')) return res.status(400).json({ error: 'Please enter a valid company email address.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM users WHERE username = $1 OR email = $2', [username.toLowerCase(), email.toLowerCase()]);
    if (existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'That username or email is already registered. Try logging in instead.' });
    }

    const bizResult = await client.query(
      `INSERT INTO businesses (name, address, contact_number, contact_email, vat_number, plan, subscription_status)
       VALUES ($1, $2, $3, $4, $5, 'starter', 'inactive') RETURNING id`,
      [name.trim(), address.trim(), contactNumber.trim(), contactEmail.trim(), vatNumber && vatNumber.trim() ? vatNumber.trim() : null]
    );
    const businessId = bizResult.rows[0].id;

    const userResult = await client.query(
      `INSERT INTO users (business_id, username, email, first_name, last_name, role, pin_hash, status, permissions)
       VALUES ($1, $2, $3, $4, $5, 'admin', $6, 'active', '{}') RETURNING id`,
      [businessId, username.toLowerCase().trim(), email.toLowerCase().trim(), firstName.trim(), lastName.trim(), bcrypt.hashSync(String(pin), 10)]
    );
    const userId = userResult.rows[0].id;

    await client.query(
      `INSERT INTO business_settings (business_id, settings_json) VALUES ($1, $2)`,
      [businessId, JSON.stringify({ emailNotifications: true, priceAlertThreshold: 10, defaultVatRate: 15 })]
    );

    await client.query(
      `INSERT INTO audit_log (business_id, actor_user_id, action, target_type, target_id)
       VALUES ($1, $2, 'business.signed_up', 'business', $1)`,
      [businessId, userId]
    );

    await client.query('COMMIT');

    const token = jwt.sign(
      { userId, businessId, role: 'admin', username: username.toLowerCase().trim() },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    res.status(201).json({
      token,
      user: {
        id: userId,
        username: username.toLowerCase().trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        role: 'admin',
        permissions: {},
        subscriptionStatus: 'inactive',
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Signup failed:', err);
    res.status(500).json({ error: 'Something went wrong creating your account. Please try again.' });
  } finally {
    client.release();
  }
});

// Lightweight check used by the signup form to give real-time feedback before
// the person finishes the whole form, rather than only failing at the end.
router.get('/check-username', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.json({ available: false });
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username.toLowerCase()]);
  res.json({ available: rows.length === 0 });
});

module.exports = router;
