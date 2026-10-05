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
// admin has specifically granted a processor the "Invite/remove Dispatch
// users at their branch" right (permissions.manageDispatchUsers). Permissions
// can change after login, so this checks the database directly rather than
// trusting anything baked into the token. A processor granted this right can
// still only manage Dispatch accounts, never Processor/Admin accounts - that
// restriction is enforced in routes/users.js (a role check), not here.
async function requireUsersAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
  if (req.user.role === 'admin' || req.user.role === 'developer') return next();
  if (req.user.role === 'processor') {
    try {
      const { rows } = await pool.query('SELECT permissions FROM users WHERE id = $1', [req.user.userId]);
      const perms = rows[0] ? JSON.parse(rows[0].permissions || '{}') : {};
      if (perms.manageDispatchUsers === true) return next();
    } catch (err) {
      return res.status(500).json({ error: 'Something went wrong on our end.' });
    }
  }
  return res.status(403).json({ error: 'You do not have permission to do that.' });
}

// Every business id (branch) a user can act on right now. Everyone except a
// group-level Admin is locked to their own single branch. A group Admin
// ("views all branches... can act at any branch") gets every branch in
// their group. Queried live rather than cached in the JWT, since branches
// can be added to or removed from a group after the admin's token was issued.
async function getAccessibleBusinessIds(user) {
  if (user.role !== 'admin' && user.role !== 'developer') return [user.businessId];
  const { rows } = await pool.query('SELECT group_id FROM businesses WHERE id = $1', [user.businessId]);
  const groupId = rows[0]?.group_id;
  if (!groupId) return [user.businessId];
  const branches = await pool.query('SELECT id FROM businesses WHERE group_id = $1 ORDER BY id', [groupId]);
  return branches.rows.map(b => b.id);
}

// Resolves which single branch THIS request is acting on, out of everything
// the user can access. A group Admin switches branches with an X-Branch-Id
// header; everyone else is always pinned to their own business_id. Routes
// should read req.activeBusinessId instead of req.user.businessId directly,
// so branch-switching works everywhere without every route re-implementing
// this check. Must run after requireAuth.
async function resolveActiveBranch(req, res, next) {
  try {
    const accessible = await getAccessibleBusinessIds(req.user);
    req.accessibleBusinessIds = accessible;

    const requestedRaw = req.headers['x-branch-id'];
    const requested = requestedRaw ? parseInt(requestedRaw, 10) : null;
    if (requested) {
      if (!accessible.includes(requested)) {
        return res.status(403).json({ error: 'You do not have access to that branch.' });
      }
      req.activeBusinessId = requested;
    } else {
      req.activeBusinessId = req.user.businessId;
    }
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
}

// Blocks every real feature (suppliers, item master, scans, reports, staff
// management) unless the business has an actually-paid, active subscription -
// or is within a 3-day grace period after a renewal payment failure. For a
// branch that belongs to a Multi-Branch group, billing is consolidated at
// the GROUP level (one invoice for every branch), so the group's own
// subscription_status governs every branch in it, not the branch's own row.
// A standalone (non-grouped) branch still uses its own row exactly as before.
// The developer/owner account bypasses this entirely, since it isn't a
// paying customer.
const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

async function requireActiveSubscription(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
  if (req.user.role === 'developer') return next();
  try {
    const { rows } = await pool.query(
      `SELECT b.group_id, b.subscription_status AS biz_status, b.past_due_since AS biz_past_due,
              g.subscription_status AS grp_status, g.past_due_since AS grp_past_due
       FROM businesses b LEFT JOIN groups g ON g.id = b.group_id
       WHERE b.id = $1`,
      [req.user.businessId]
    );
    const row = rows[0];
    const grouped = !!row?.group_id;
    const status = grouped ? row.grp_status : row?.biz_status;
    const pastDueSince = grouped ? row.grp_past_due : row?.biz_past_due;

    if (status === 'active') return next();

    if (status === 'past_due' && pastDueSince) {
      const elapsedMs = Date.now() - new Date(pastDueSince).getTime();
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

// Gates a single named Processor right (see routes/users.js for the 7 keys
// and their defaults). Admin/developer always pass - this only ever
// restricts a Processor, and Dispatch is kept off these routes entirely via
// requireRole, so it never reaches this check. Re-reads the DB each request
// (not the JWT) so a right revoked mid-shift takes effect immediately, the
// same freshness guarantee requireActiveSubscription and requireUsersAccess
// already give every other permission check in this app.
function requireProcessorPermission(key) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
    if (req.user.role === 'admin' || req.user.role === 'developer') return next();
    if (req.user.role !== 'processor') {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    try {
      const { rows } = await pool.query('SELECT permissions FROM users WHERE id = $1', [req.user.userId]);
      const perms = rows[0] ? JSON.parse(rows[0].permissions || '{}') : {};
      if (perms[key] === true) return next();
    } catch (err) {
      return res.status(500).json({ error: 'Something went wrong on our end.' });
    }
    return res.status(403).json({ error: 'You do not have permission to do that.' });
  };
}

module.exports = {
  requireAuth, requireRole, requireUsersAccess, requireActiveSubscription,
  getAccessibleBusinessIds, resolveActiveBranch, requireProcessorPermission,
};
