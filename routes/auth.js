const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../db');

const router = express.Router();

// A 4-digit PIN only has 10,000 possible combinations, so without a limiter,
// login is guessable in seconds by a script. This caps each IP to 30 attempts
// per 15 minutes across the whole app, regardless of which username is tried.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, pin } = req.body || {};
  if (!username || !pin) {
    return res.status(400).json({ error: 'Username and PIN are required.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE username = $1 OR email = $1',
      [username.toLowerCase()]
    );
    const user = rows[0];
    if (!user) {
      // Deliberately identical error to "wrong PIN" below - never reveal whether
      // a username exists. This stops attackers from enumerating valid usernames.
      return res.status(401).json({ error: 'Incorrect username or PIN.' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ error: 'This account has been deactivated.' });
    }

    const pinMatches = bcrypt.compareSync(String(pin), user.pin_hash);
    if (!pinMatches) {
      return res.status(401).json({ error: 'Incorrect username or PIN.' });
    }

    const token = jwt.sign(
      { userId: user.id, businessId: user.business_id, role: user.role, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    await pool.query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [user.id]);
    await pool.query(
      `INSERT INTO audit_log (business_id, actor_user_id, action, target_type, target_id, details)
       VALUES ($1, $2, 'user.login', 'user', $3, NULL)`,
      [user.business_id, user.id, user.id]
    );

    const bizResult = await pool.query('SELECT subscription_status, past_due_since FROM businesses WHERE id = $1', [user.business_id]);
    let gracePeriodDaysLeft = null;
    if (bizResult.rows[0]?.subscription_status === 'past_due' && bizResult.rows[0].past_due_since) {
      const elapsedMs = Date.now() - new Date(bizResult.rows[0].past_due_since).getTime();
      const remainingMs = (3 * 24 * 60 * 60 * 1000) - elapsedMs;
      gracePeriodDaysLeft = remainingMs > 0 ? Math.ceil(remainingMs / (24 * 60 * 60 * 1000)) : 0;
    }

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        role: user.role,
        permissions: JSON.parse(user.permissions || '{}'),
        subscriptionStatus: bizResult.rows[0]?.subscription_status || 'inactive',
        gracePeriodDaysLeft,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// Used on page load to restore a session from a token saved in the browser -
// re-checks the token is still valid AND re-fetches current permissions/status
// from the database (not just what was baked into the token at login time),
// so a deactivated account or a revoked permission takes effect immediately.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.userId]);
    const user = rows[0];
    if (!user || user.status !== 'active') {
      return res.status(401).json({ error: 'Session no longer valid.' });
    }
    const bizResult = await pool.query('SELECT subscription_status, past_due_since FROM businesses WHERE id = $1', [user.business_id]);
    let gracePeriodDaysLeft = null;
    if (bizResult.rows[0]?.subscription_status === 'past_due' && bizResult.rows[0].past_due_since) {
      const elapsedMs = Date.now() - new Date(bizResult.rows[0].past_due_since).getTime();
      const remainingMs = (3 * 24 * 60 * 60 * 1000) - elapsedMs;
      gracePeriodDaysLeft = remainingMs > 0 ? Math.ceil(remainingMs / (24 * 60 * 60 * 1000)) : 0;
    }
    res.json({
      user: {
        id: user.id,
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        role: user.role,
        permissions: JSON.parse(user.permissions || '{}'),
        subscriptionStatus: bizResult.rows[0]?.subscription_status || 'inactive',
        gracePeriodDaysLeft,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

module.exports = router;
