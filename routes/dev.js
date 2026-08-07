const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAuth, requireRole } = require('../middleware/auth');
const { streamInvoicePDF } = require('./billing');
const { pool } = require('../db');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('developer')); // every route here is developer-only, no exceptions

// Lists every business and its admin account. This is intentionally NOT scoped
// to req.user.businessId - the developer/owner account is the one place that
// legitimately needs visibility across all customer businesses, since it's the
// fallback when a customer's admin is locked out and has no one else to ask.
router.get('/admins', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT b.id AS business_id, b.name AS business_name, u.id AS user_id,
             u.username, u.email, u.status
      FROM businesses b
      JOIN users u ON u.business_id = b.id AND u.role = 'admin'
      ORDER BY b.name
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.post('/admins/:userId/reset-pin', async (req, res) => {
  const { pin } = req.body || {};
  if (!/^\d{4}$/.test(String(pin))) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
  }

  try {
    const targetResult = await pool.query('SELECT id, business_id, role FROM users WHERE id = $1', [req.params.userId]);
    const target = targetResult.rows[0];
    if (!target || target.role !== 'admin') {
      return res.status(404).json({ error: 'Admin account not found.' });
    }

    await pool.query('UPDATE users SET pin_hash = $1 WHERE id = $2', [bcrypt.hashSync(String(pin), 10), target.id]);

    await pool.query(
      `INSERT INTO audit_log (business_id, actor_user_id, action, target_type, target_id, details)
       VALUES ($1, $2, 'admin.pin_reset_by_developer', 'user', $3, $4)`,
      [target.business_id, req.user.userId, target.id, JSON.stringify({ resetBy: req.user.username })]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// ── Clients: every business using GRV Scanner ──
router.get('/clients', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT b.id, b.name, b.plan, b.subscription_status, b.created_at,
             u.username AS admin_username, u.email AS admin_email,
             (SELECT COUNT(*)::int FROM users WHERE business_id = b.id AND role != 'admin' AND role != 'developer') AS staff_count,
             (SELECT COUNT(*)::int FROM scans WHERE business_id = b.id) AS total_scans
      FROM businesses b
      LEFT JOIN users u ON u.business_id = b.id AND u.role = 'admin'
      ORDER BY b.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// ── Invoices: every invoice across every client, for a given month ──
// This is what you'd hand to your accountant or use for a VAT return - real
// revenue records, not estimates.
router.get('/invoices', async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM
  try {
    const { rows } = await pool.query(`
      SELECT i.id, i.invoice_number, i.plan, i.amount_incl_vat, i.amount_excl_vat, i.vat_amount, i.issued_at,
             b.name AS business_name
      FROM invoices i
      JOIN businesses b ON b.id = i.business_id
      WHERE TO_CHAR(i.issued_at, 'YYYY-MM') = $1
      ORDER BY i.issued_at ASC
    `, [month]);

    const totals = rows.reduce((acc, r) => ({
      exclVat: acc.exclVat + r.amount_excl_vat,
      vat: acc.vat + r.vat_amount,
      inclVat: acc.inclVat + r.amount_incl_vat,
    }), { exclVat: 0, vat: 0, inclVat: 0 });

    res.json({ month, invoices: rows, totals });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.get('/invoices/export.csv', async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  try {
    const { rows } = await pool.query(`
      SELECT i.invoice_number, b.name AS business_name, i.plan, i.amount_excl_vat, i.vat_amount, i.amount_incl_vat, i.issued_at
      FROM invoices i JOIN businesses b ON b.id = i.business_id
      WHERE TO_CHAR(i.issued_at, 'YYYY-MM') = $1
      ORDER BY i.issued_at ASC
    `, [month]);

    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const header = ['Invoice Number', 'Client', 'Plan', 'Excl. VAT', 'VAT (15%)', 'Total (incl. VAT)', 'Date Issued'];
    const lines = [header, ...rows.map(r => [
      r.invoice_number, r.business_name, r.plan,
      r.amount_excl_vat.toFixed(2), r.vat_amount.toFixed(2), r.amount_incl_vat.toFixed(2),
      new Date(r.issued_at).toLocaleDateString('en-ZA'),
    ])].map(row => row.map(esc).join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="GRV-Scanner-Revenue-${month}.csv"`);
    res.send(lines);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// ── Insights: is the business growing, and what's actually selling ──
router.get('/insights', async (req, res) => {
  try {
    const totalClientsResult = await pool.query('SELECT COUNT(*)::int AS n FROM businesses');
    const totalClients = totalClientsResult.rows[0].n;

    const activeClientsResult = await pool.query(`SELECT COUNT(*)::int AS n FROM businesses WHERE subscription_status = 'active'`);
    const activeClients = activeClientsResult.rows[0].n;

    // New clients per month, last 12 months - the real growth signal.
    const growthResult = await pool.query(`
      SELECT TO_CHAR(created_at, 'YYYY-MM') AS month, COUNT(*)::int AS "newClients"
      FROM businesses
      WHERE created_at >= NOW() - INTERVAL '12 months'
      GROUP BY month ORDER BY month ASC
    `);

    // Which plan tier is actually most popular among currently active subscriptions.
    const planPopularityResult = await pool.query(`
      SELECT plan, COUNT(*)::int AS count FROM businesses WHERE subscription_status = 'active' GROUP BY plan ORDER BY count DESC
    `);

    const planPrices = { starter: 649, professional: 1199, enterprise: 2999 };
    const activePlansResult = await pool.query(`SELECT plan FROM businesses WHERE subscription_status = 'active'`);
    const mrr = activePlansResult.rows.reduce((sum, b) => sum + (planPrices[b.plan] || 0), 0);

    const thisMonth = new Date().toISOString().slice(0, 7);
    const revenueResult = await pool.query(`
      SELECT COALESCE(SUM(amount_incl_vat), 0)::float AS total FROM invoices WHERE TO_CHAR(issued_at, 'YYYY-MM') = $1
    `, [thisMonth]);
    const revenueThisMonth = revenueResult.rows[0].total;

    res.json({
      totalClients, activeClients, mrr, revenueThisMonth,
      growth: growthResult.rows, planPopularity: planPopularityResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// Support/testing tool - directly sets a SPECIFIC client's plan without going
// through Paystack. Developer-only. Needed because the developer's own
// account is a separate technical business, not any particular customer -
// this lets support fix a customer's plan by their real business ID.
router.patch('/businesses/:id/plan', async (req, res) => {
  const { plan } = req.body || {};
  if (!['starter', 'professional', 'enterprise'].includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan.' });
  }
  try {
    const result = await pool.query('UPDATE businesses SET plan = $1 WHERE id = $2', [plan, req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Business not found.' });

    await pool.query(
      `INSERT INTO audit_log (business_id, actor_user_id, action, target_type, details)
       VALUES ($1, $2, 'business.plan_changed_by_support', 'business', $3)`,
      [req.params.id, req.user.userId, JSON.stringify({ newPlan: plan })]
    );

    res.json({ ok: true, plan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.get('/invoices/:id/pdf', async (req, res) => {
  try {
    const invoiceResult = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    const invoice = invoiceResult.rows[0];
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
    const businessResult = await pool.query(
      'SELECT name, address, contact_number, contact_email, vat_number FROM businesses WHERE id = $1',
      [invoice.business_id]
    );
    streamInvoicePDF(res, invoice, businessResult.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

module.exports = router;
