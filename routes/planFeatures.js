const { pool } = require('../db');

// This must stay in sync with what the Billing page actually advertises per
// tier - if you change what a plan promises, update this too, or you're back
// to advertising things that don't actually work.
// staffLimit/scanLimit/historyLimitDays: null means unlimited.
const PLAN_FEATURES = {
  starter:      { duplicateDetection: false, priceIncreaseDetection: false, fullInsights: false, staffLimit: 0, scanLimit: 150,  historyLimitDays: 30 },
  professional: { duplicateDetection: true,  priceIncreaseDetection: false, fullInsights: true,  staffLimit: 5, scanLimit: 600,  historyLimitDays: null },
  enterprise:   { duplicateDetection: true,  priceIncreaseDetection: true,  fullInsights: true,  staffLimit: null, scanLimit: 2000, historyLimitDays: null },
};

async function getPlanFeatures(businessId) {
  const { rows } = await pool.query('SELECT plan FROM businesses WHERE id = $1', [businessId]);
  const plan = rows[0]?.plan || 'starter';
  return { plan, features: PLAN_FEATURES[plan] || PLAN_FEATURES.starter };
}

module.exports = { PLAN_FEATURES, getPlanFeatures };
