const jwt = require('jsonwebtoken');
const { pool } = require('../db');

// Verifies the session token sent by the frontend (in the Authorization header).
// If it's missing, expired, or tampered with, the request is rejected before
// touching any business logic. This replaces "the browser decided not to show
// the button" with "the server refuses to answer."
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { userId, businessId, role, username }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
}

// Restricts a route to specific roles. Used AFTER requireAuth.
// Example: router.post('/users', requireAuth, requireRole('admin', 'developer'), handler)
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    next();
  };
}

// User management (Users page, PIN resets) is admin-only by default, UNLESS
// admin has specifically granted a processor "Full Access - Manage Users & PINs"
// on their account. Permissions can change after login, so this checks the
// database directly rather than trusting anything baked into the token.
async function requireUsersAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
  if (req.user.role === 'admin' || req.user.role === 'developer') return next();
  if (req.user.role === 'processor') {
    try {
      const { rows } = await pool.query('SELECT permissions FROM users WHERE id = $1', [req.user.userId]);
      const perms = rows[0] ? JSON.parse(rows[0].permissions || '{}') : {};
      if (perms.users === true) return next();
    } catch (err) {
      return res.status(500).json({ error: 'Something went wrong on our end.' });
    }
  }
  return res.status(403).json({ error: 'You do not have permission to do that.' });
}

// Blocks every real feature (suppliers, item master, scans, reports, staff
// management) unless the business has an actually-paid, active subscription -
// or is within a 3-day grace period after a renewal payment failure. A
// business that never paid at all (inactive) or was cancelled gets no grace
// period - the grace period exists specifically for "was paying, one renewal
// failed", not "never subscribed". The developer/owner account bypasses this
// entirely, since it isn't a paying customer.
const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

async function requireActiveSubscription(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
  if (req.user.role === 'developer') return next();
  try {
    const { rows } = await pool.query(
      'SELECT subscription_status, past_due_since FROM businesses WHERE id = $1',
      [req.user.businessId]
    );
    const status = rows[0]?.subscription_status;
    if (status === 'active') return next();

    if (status === 'past_due' && rows[0].past_due_since) {
      const elapsedMs = Date.now() - new Date(rows[0].past_due_since).getTime();
      if (elapsedMs < GRACE_PERIOD_MS) {
        const daysLeft = Math.ceil((GRACE_PERIOD_MS - elapsedMs) / (24 * 60 * 60 * 1000));
        req.gracePeriodDaysLeft = daysLeft; // available to the route if it wants to warn, without blocking
        return next();
      }
    }

    return res.status(402).json({
      error: status === 'past_due'
        ? 'Your last payment failed and the 3-day grace period has ended. Please update your payment method to continue.'
        : 'Your subscription is not active yet. Complete payment to unlock the app.',
      subscriptionInactive: true,
      subscriptionStatus: status || 'inactive',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on our end.' });
  }
}

module.exports = { requireAuth, requireRole, requireUsersAccess, requireActiveSubscription };
