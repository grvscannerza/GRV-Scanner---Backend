const express = require('express');
const { requireAuth, requireRole, requireActiveSubscription } = require('../middleware/auth');
const { pool } = require('../db');

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveSubscription);

// Everyone who can scan (including dispatch) needs to see supplier names for the dropdown.
// Only admin/processor can create, edit, or delete suppliers.
router.get('/', requireRole('admin', 'processor', 'dispatch', 'developer'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT sup.*,
        (SELECT COUNT(*)::int FROM scans s WHERE s.supplier_id = sup.id AND s.status = 'approved') AS invoice_count,
        (SELECT COALESCE(SUM(s.total), 0)::float FROM scans s WHERE s.supplier_id = sup.id AND s.status = 'approved') AS total_spend
      FROM suppliers sup WHERE sup.business_id = $1 ORDER BY sup.name
    `, [req.user.businessId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.post('/', requireRole('admin', 'processor', 'developer'), async (req, res) => {
  const { name, accountNo, vatNumber, vatType, contactName, phone, email, terms } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Supplier name is required.' });
  if (email && !email.includes('@')) return res.status(400).json({ error: 'Invalid email address.' });

  try {
    const insertResult = await pool.query(`
      INSERT INTO suppliers (business_id, name, account_no, vat_number, vat_type, contact_name, phone, email, terms)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id
    `, [req.user.businessId, name, accountNo || null, vatNumber || null, vatType || 'vat', contactName || null, phone || null, email || null, terms || null]);
    const newId = insertResult.rows[0].id;

    await pool.query(
      `INSERT INTO audit_log (business_id, actor_user_id, action, target_type, target_id)
       VALUES ($1, $2, 'supplier.created', 'supplier', $3)`,
      [req.user.businessId, req.user.userId, newId]
    );

    res.status(201).json({ id: newId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.put('/:id', requireRole('admin', 'processor', 'developer'), async (req, res) => {
  const { name, accountNo, vatNumber, vatType, contactName, phone, email, terms } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Supplier name is required.' });
  if (email && !email.includes('@')) return res.status(400).json({ error: 'Invalid email address.' });

  try {
    const result = await pool.query(`
      UPDATE suppliers SET name=$1, account_no=$2, vat_number=$3, vat_type=$4, contact_name=$5, phone=$6, email=$7, terms=$8
      WHERE id=$9 AND business_id=$10
    `, [name, accountNo || null, vatNumber || null, vatType || 'vat', contactName || null, phone || null, email || null, terms || null, req.params.id, req.user.businessId]);

    if (result.rowCount === 0) return res.status(404).json({ error: 'Supplier not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.delete('/:id', requireRole('admin', 'processor', 'developer'), async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM suppliers WHERE id = $1 AND business_id = $2',
      [req.params.id, req.user.businessId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Supplier not found.' });

    await pool.query(
      `INSERT INTO audit_log (business_id, actor_user_id, action, target_type, target_id)
       VALUES ($1, $2, 'supplier.deleted', 'supplier', $3)`,
      [req.user.businessId, req.user.userId, req.params.id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

module.exports = router;
