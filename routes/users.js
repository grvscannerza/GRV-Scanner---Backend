const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAuth, requireUsersAccess, requireActiveSubscription } = require('../middleware/auth');
const { pool } = require('../db');
const { getPlanFeatures } = require('./planFeatures');

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveSubscription);

// List staff for the logged-in admin's OWN business only.
// Notice: business_id comes from the verified token (req.user.businessId), never
// from the request body or a query param - the browser cannot ask for another
// business's users no matter what it sends, because the server ignores it.
router.get('/', requireUsersAccess, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.role, u.status, u.last_active_at, u.permissions,
              (SELECT COUNT(*)::int FROM scans s WHERE s.scanned_by = u.id) AS scan_count
       FROM users u WHERE u.business_id = $1 AND u.role NOT IN ('admin','developer') ORDER BY u.id`,
      [req.user.businessId]
    );
    const parsed = rows.map(u => ({ ...u, permissions: JSON.parse(u.permissions || '{}') }));
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.post('/', requireUsersAccess, async (req, res) => {
  const { username, email, firstName, lastName, role, pin, permissions } = req.body || {};

  if (!username || !firstName || !lastName || !role || !pin) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (!['processor', 'dispatch'].includes(role)) {
    return res.status(400).json({ error: 'Role must be processor or dispatch.' });
  }
  // Enforced here, server-side - a modified/hacked frontend cannot bypass this
  // the way it could if the rule only existed in browser JavaScript.
  if (!/^\d{4}$/.test(String(pin))) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username.toLowerCase()]);
    if (existing.rows[0]) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }

    const { features, plan } = await getPlanFeatures(req.user.businessId);
    if (features.staffLimit !== null) {
      const countResult = await pool.query(
        `SELECT COUNT(*) AS n FROM users WHERE business_id = $1 AND role != 'admin' AND role != 'developer'`,
        [req.user.businessId]
      );
      if (parseInt(countResult.rows[0].n, 10) >= features.staffLimit) {
        const msg = features.staffLimit === 0
          ? `The Starter plan doesn't include staff accounts - it's admin-only. Upgrade to Professional to add staff.`
          : `You've reached your ${plan} plan's staff limit (${features.staffLimit}). Upgrade to add more.`;
        return res.status(403).json({ error: msg });
      }
    }

    const insertResult = await pool.query(
      `INSERT INTO users (business_id, username, email, first_name, last_name, role, pin_hash, status, permissions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8) RETURNING id`,
      [req.user.businessId, username.toLowerCase(), email || null, firstName, lastName, role,
        bcrypt.hashSync(String(pin), 10), JSON.stringify(permissions || {})]
    );
    const newId = insertResult.rows[0].id;

    await pool.query(
      `INSERT INTO audit_log (business_id, actor_user_id, action, target_type, target_id)
       VALUES ($1, $2, 'user.created', 'user', $3)`,
      [req.user.businessId, req.user.userId, newId]
    );

    res.status(201).json({ id: newId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// Reset a staff member's PIN. Scoped to the caller's business via the WHERE clause -
// an admin from Business A cannot reset a PIN belonging to Business B even by guessing IDs.
router.post('/:id/reset-pin', requireUsersAccess, async (req, res) => {
  const { pin } = req.body || {};
  if (!/^\d{4}$/.test(String(pin))) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
  }
  try {
    const result = await pool.query(
      'UPDATE users SET pin_hash = $1 WHERE id = $2 AND business_id = $3',
      [bcrypt.hashSync(String(pin), 10), req.params.id, req.user.businessId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    await pool.query(
      `INSERT INTO audit_log (business_id, actor_user_id, action, target_type, target_id)
       VALUES ($1, $2, 'user.pin_reset', 'user', $3)`,
      [req.user.businessId, req.user.userId, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.patch('/:id/deactivate', requireUsersAccess, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE users SET status = 'inactive' WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.user.businessId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// Self-service PIN change - admin, or a processor granted "Full Access - Manage
// Users & PINs". Other staff PINs are managed via the Reset PIN flow instead.
router.post('/me/change-pin', requireUsersAccess, async (req, res) => {
  const { currentPin, newPin } = req.body || {};
  if (!currentPin || !newPin) return res.status(400).json({ error: 'Current and new PIN are required.' });

  const isDeveloper = req.user.role === 'developer';
  if (!isDeveloper && !/^\d{4}$/.test(String(newPin))) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
  }

  try {
    const { rows } = await pool.query('SELECT pin_hash FROM users WHERE id = $1', [req.user.userId]);
    const user = rows[0];
    if (!user || !bcrypt.compareSync(String(currentPin), user.pin_hash)) {
      return res.status(401).json({ error: 'Current PIN is incorrect.' });
    }

    await pool.query('UPDATE users SET pin_hash = $1 WHERE id = $2', [bcrypt.hashSync(String(newPin), 10), req.user.userId]);

    await pool.query(
      `INSERT INTO audit_log (business_id, actor_user_id, action, target_type, target_id)
       VALUES ($1, $2, 'user.self_pin_change', 'user', $3)`,
      [req.user.businessId, req.user.userId, req.user.userId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

module.exports = router;
