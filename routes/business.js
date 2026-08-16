const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { pool } = require('../db');
const { getPlanFeatures } = require('./planFeatures');
const { paystackConfigured, paystackFetch } = require('./billing');

const router = express.Router();
router.use(requireAuth);

router.get('/profile', requireRole('admin', 'developer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT name, address, contact_number, contact_email, vat_number FROM businesses WHERE id = $1',
      [req.user.businessId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Business not found.' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// Up to 5 custom VAT rate presets per business - not hardcoded to South
// Africa's 15%, since a customer using GRV Scanner outside SA needs their
// own real rates. These populate the VAT dropdown when creating a supplier.
router.get('/vat-rates', requireRole('admin', 'processor', 'developer'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT vat_rate_presets FROM businesses WHERE id = $1', [req.user.businessId]);
    if (!rows[0]) return res.status(404).json({ error: 'Business not found.' });
    res.json({ vatRates: JSON.parse(rows[0].vat_rate_presets) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.put('/vat-rates', requireRole('admin', 'developer'), async (req, res) => {
  const { vatRates } = req.body || {};
  if (!Array.isArray(vatRates) || vatRates.length === 0) {
    return res.status(400).json({ error: 'At least one VAT rate is required.' });
  }
  if (vatRates.length > 5) {
    return res.status(400).json({ error: 'A maximum of 5 VAT rates is allowed.' });
  }
  for (const r of vatRates) {
    if (!r.label || !r.label.trim()) return res.status(400).json({ error: 'Every VAT rate needs a label.' });
    if (typeof r.rate !== 'number' || r.rate < 0 || r.rate > 100) {
      return res.status(400).json({ error: `"${r.label}" needs a valid rate between 0 and 100.` });
    }
  }
  try {
    await pool.query('UPDATE businesses SET vat_rate_presets = $1 WHERE id = $2', [JSON.stringify(vatRates), req.user.businessId]);
    res.json({ ok: true, vatRates });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.get('/departments', requireRole('admin', 'processor', 'dispatch', 'developer'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT departments FROM businesses WHERE id = $1', [req.user.businessId]);
    if (!rows[0]) return res.status(404).json({ error: 'Business not found.' });
    res.json({ departments: JSON.parse(rows[0].departments) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.put('/departments', requireRole('admin', 'developer'), async (req, res) => {
  const { departments } = req.body || {};
  if (!Array.isArray(departments)) {
    return res.status(400).json({ error: 'departments must be an array.' });
  }
  const cleaned = [];
  for (const d of departments) {
    if (typeof d !== 'string' || !d.trim()) {
      return res.status(400).json({ error: 'Every department needs a real name.' });
    }
    const name = d.trim();
    if (cleaned.some(existing => existing.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ error: `"${name}" is listed more than once.` });
    }
    cleaned.push(name);
  }
  try {
    await pool.query('UPDATE businesses SET departments = $1 WHERE id = $2', [JSON.stringify(cleaned), req.user.businessId]);
    res.json({ ok: true, departments: cleaned });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.put('/profile', requireRole('admin', 'developer'), async (req, res) => {
  const { name, address, contactNumber, contactEmail, vatNumber } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Company name is required.' });
  if (contactEmail && !contactEmail.includes('@')) return res.status(400).json({ error: 'Please enter a valid email address.' });

  try {
    await pool.query(`
      UPDATE businesses SET name = $1, address = $2, contact_number = $3, contact_email = $4, vat_number = $5
      WHERE id = $6
    `, [name.trim(), address || null, contactNumber || null, contactEmail || null, vatNumber || null, req.user.businessId]);

    await pool.query(
      `INSERT INTO audit_log (business_id, actor_user_id, action, target_type)
       VALUES ($1, $2, 'business.profile_updated', 'business')`,
      [req.user.businessId, req.user.userId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.get('/settings', requireRole('admin', 'developer'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT settings_json FROM business_settings WHERE business_id = $1', [req.user.businessId]);
    res.json(rows[0] ? JSON.parse(rows[0].settings_json) : {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.put('/settings', requireRole('admin', 'developer'), async (req, res) => {
  const settings = req.body || {};
  try {
    await pool.query(`
      INSERT INTO business_settings (business_id, settings_json, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (business_id) DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = EXCLUDED.updated_at
    `, [req.user.businessId, JSON.stringify(settings)]);

    await pool.query(
      `INSERT INTO audit_log (business_id, actor_user_id, action, target_type)
       VALUES ($1, $2, 'business.settings_updated', 'business')`,
      [req.user.businessId, req.user.userId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.get('/plan', requireRole('admin', 'developer'), async (req, res) => {
  try {
    const bizResult = await pool.query('SELECT plan, subscription_status, past_due_since, paystack_subscription_code FROM businesses WHERE id = $1', [req.user.businessId]);
    const row = bizResult.rows[0];

    const scansResult = await pool.query(`
      SELECT COUNT(*)::int AS n FROM scans
      WHERE business_id = $1 AND TO_CHAR(scanned_at, 'YYYY-MM') = TO_CHAR(NOW(), 'YYYY-MM')
    `, [req.user.businessId]);

    let gracePeriodDaysLeft = null;
    if (row?.subscription_status === 'past_due' && row.past_due_since) {
      const elapsedMs = Date.now() - new Date(row.past_due_since).getTime();
      const remainingMs = (3 * 24 * 60 * 60 * 1000) - elapsedMs;
      gracePeriodDaysLeft = remainingMs > 0 ? Math.ceil(remainingMs / (24 * 60 * 60 * 1000)) : 0;
    }

    // The real renewal date only exists on Paystack's side - fetched live
    // rather than stored locally, so it's never a stale/guessed value.
    // Fails gracefully (null) rather than breaking the whole dashboard if
    // Paystack is briefly unreachable.
    let renewsAt = null;
    if (row?.paystack_subscription_code && paystackConfigured()) {
      try {
        const subResult = await paystackFetch(`/subscription/${row.paystack_subscription_code}`);
        renewsAt = subResult.data?.next_payment_date || null;
      } catch (err) {
        console.error('Failed to fetch real renewal date from Paystack:', err.message);
      }
    }

    const { features } = await getPlanFeatures(req.user.businessId);

    res.json({
      plan: row ? row.plan : 'professional',
      subscriptionStatus: row ? row.subscription_status : 'inactive',
      scansThisMonth: scansResult.rows[0].n,
      scanLimit: features.scanLimit,
      staffLimit: features.staffLimit,
      gracePeriodDaysLeft,
      renewsAt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// Self-service account deletion - deliberately scoped to req.user.businessId
// only, never a URL parameter, so there is no way for an admin to target any
// business other than their own, however the request is crafted.
router.get('/deletion-impact', requireRole('admin'), async (req, res) => {
  try {
    const bizId = req.user.businessId;
    const userCountResult = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE business_id = $1', [bizId]);
    const supplierCountResult = await pool.query('SELECT COUNT(*)::int AS n FROM suppliers WHERE business_id = $1', [bizId]);
    const itemCountResult = await pool.query('SELECT COUNT(*)::int AS n FROM item_master WHERE business_id = $1', [bizId]);
    const scanCountResult = await pool.query('SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0)::float AS "totalValue" FROM scans WHERE business_id = $1', [bizId]);
    const bizResult = await pool.query('SELECT name, subscription_status FROM businesses WHERE id = $1', [bizId]);

    res.json({
      businessName: bizResult.rows[0]?.name,
      hasActiveSubscription: bizResult.rows[0]?.subscription_status === 'active' || bizResult.rows[0]?.subscription_status === 'past_due',
      userCount: userCountResult.rows[0].n,
      supplierCount: supplierCountResult.rows[0].n,
      itemCount: itemCountResult.rows[0].n,
      scanCount: scanCountResult.rows[0].n,
      totalScanValue: scanCountResult.rows[0].totalValue,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.delete('/', requireRole('admin'), async (req, res) => {
  if (req.query.confirmCascade !== 'true') {
    return res.status(400).json({ error: 'This requires explicit confirmation - see /deletion-impact first.' });
  }
  const bizId = req.user.businessId;

  try {
    // Cancel any real, active Paystack subscription first, so the person
    // is never billed again after deleting their account - deleting the
    // data alone would leave the subscription still running otherwise.
    if (paystackConfigured()) {
      const bizResult = await pool.query(
        'SELECT paystack_subscription_code, paystack_email_token FROM businesses WHERE id = $1',
        [bizId]
      );
      const biz = bizResult.rows[0];
      if (biz?.paystack_subscription_code && biz?.paystack_email_token) {
        try {
          await paystackFetch('/subscription/disable', {
            method: 'POST',
            body: JSON.stringify({ code: biz.paystack_subscription_code, token: biz.paystack_email_token }),
          });
        } catch (payErr) {
          console.error('Failed to cancel Paystack subscription during account deletion:', payErr);
          return res.status(500).json({ error: 'Could not cancel your active subscription, so your account was not deleted. Please try again or contact support.' });
        }
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM item_price_history WHERE item_id IN (SELECT id FROM item_master WHERE business_id = $1)`, [bizId]);
      await client.query(`DELETE FROM item_price_history WHERE scan_id IN (SELECT id FROM scans WHERE business_id = $1)`, [bizId]);
      await client.query('DELETE FROM item_master WHERE business_id = $1', [bizId]);
      await client.query('DELETE FROM scan_line_items WHERE scan_id IN (SELECT id FROM scans WHERE business_id = $1)', [bizId]);
      await client.query('DELETE FROM scans WHERE business_id = $1', [bizId]);
      await client.query('DELETE FROM invoices WHERE business_id = $1', [bizId]);
      await client.query('DELETE FROM audit_log WHERE business_id = $1', [bizId]);
      await client.query('DELETE FROM suppliers WHERE business_id = $1', [bizId]);
      await client.query('DELETE FROM business_settings WHERE business_id = $1', [bizId]);
      await client.query('DELETE FROM users WHERE business_id = $1', [bizId]);
      await client.query('DELETE FROM businesses WHERE id = $1', [bizId]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// Support/testing tool only - directly sets a business's plan without going
// through Paystack. Developer-only, since the real customer-facing flow for
// changing plans now goes through POST /api/billing/checkout (real payment).
router.patch('/plan', requireRole('developer'), async (req, res) => {
  const { plan } = req.body || {};
  if (!['starter', 'professional', 'enterprise'].includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan.' });
  }
  try {
    await pool.query('UPDATE businesses SET plan = $1 WHERE id = $2', [plan, req.user.businessId]);

    await pool.query(
      `INSERT INTO audit_log (business_id, actor_user_id, action, target_type, details)
       VALUES ($1, $2, 'business.plan_changed_manually', 'business', $3)`,
      [req.user.businessId, req.user.userId, JSON.stringify({ newPlan: plan })]
    );

    res.json({ ok: true, plan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

module.exports = router;
