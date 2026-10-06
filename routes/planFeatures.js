const { pool } = require('../db');

// There is one plan, 'business' (R2,999/month excl. VAT per branch). Every
// branch gets every feature. The old Starter/Professional/Enterprise tiers
// no longer exist; any leftover plan name falls back to this same set.
// scanLimit is 2,000 PER BRANCH per month (not per account), so a group
// with several branches is unaffected by having more than one.
// staffLimit/historyLimitDays: null means unlimited.
const PLAN_FEATURES_SHARED = {
  duplicateDetection: true,
  priceIncreaseDetection: true,
  fullInsights: true,
  staffLimit: null,
  scanLimit: 2000,
  historyLimitDays: null,
};

// Kept as a lookup keyed by plan name so any existing caller that
// destructures PLAN_FEATURES[plan] keeps working - both plan names resolve
// to the same feature set today.
const PLAN_FEATURES = {
  business: PLAN_FEATURES_SHARED,
  multi_branch: PLAN_FEATURES_SHARED,
};

async function getPlanFeatures(businessId) {
  const { rows } = await pool.query('SELECT plan FROM businesses WHERE id = $1', [businessId]);
  const plan = rows[0]?.plan || 'business';
  return { plan, features: PLAN_FEATURES[plan] || PLAN_FEATURES_SHARED };
}

module.exports = { PLAN_FEATURES, getPlanFeatures };
