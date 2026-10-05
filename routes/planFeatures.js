const { pool } = require('../db');

// Business and Multi-Branch are feature-identical - the only difference
// between them is how billing is calculated (see routes/billing.js), not
// what the app lets you do. This replaces the old Starter/Professional/
// Enterprise tiers, which no longer exist.
// scanLimit is 2,000 PER BRANCH per month (not per account), so a Multi-
// Branch group with several branches is unaffected by having more than one.
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
