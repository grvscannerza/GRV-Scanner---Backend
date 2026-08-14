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
  const { name, accountNo, vatNumber, vatRate, department, contactName, phone, email, terms } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Supplier name is required.' });
  if (email && !email.includes('@')) return res.status(400).json({ error: 'Invalid email address.' });

  const rate = typeof vatRate === 'number' ? vatRate : 15;
  if (rate < 0 || rate > 100) return res.status(400).json({ error: 'VAT rate must be between 0 and 100.' });
  const legacyVatType = rate === 0 ? 'exempt' : 'vat'; // kept for older parts of the app that still read this

  try {
    const insertResult = await pool.query(`
      INSERT INTO suppliers (business_id, name, account_no, vat_number, vat_type, vat_rate, department, contact_name, phone, email, terms)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id
    `, [req.user.businessId, name, accountNo || null, vatNumber || null, legacyVatType, rate, department || null, contactName || null, phone || null, email || null, terms || null]);
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
  const { name, accountNo, vatNumber, vatRate, department, contactName, phone, email, terms } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Supplier name is required.' });
  if (email && !email.includes('@')) return res.status(400).json({ error: 'Invalid email address.' });

  const rate = typeof vatRate === 'number' ? vatRate : 15;
  if (rate < 0 || rate > 100) return res.status(400).json({ error: 'VAT rate must be between 0 and 100.' });
  const legacyVatType = rate === 0 ? 'exempt' : 'vat';

  try {
    const result = await pool.query(`
      UPDATE suppliers SET name=$1, account_no=$2, vat_number=$3, vat_type=$4, vat_rate=$5, department=$6, contact_name=$7, phone=$8, email=$9, terms=$10
      WHERE id=$11 AND business_id=$12
    `, [name, accountNo || null, vatNumber || null, legacyVatType, rate, department || null, contactName || null, phone || null, email || null, terms || null, req.params.id, req.user.businessId]);

    if (result.rowCount === 0) return res.status(404).json({ error: 'Supplier not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// Shows exactly what's linked to this supplier, so the person can see the
// real impact before confirming a deletion that would otherwise fail (or
// worse, be attempted blindly) - genuinely accurate counts, not estimates.
router.get('/:id/deletion-impact', requireRole('admin', 'processor', 'developer'), async (req, res) => {
  try {
    const supResult = await pool.query('SELECT id, name FROM suppliers WHERE id = $1 AND business_id = $2', [req.params.id, req.user.businessId]);
    if (!supResult.rows[0]) return res.status(404).json({ error: 'Supplier not found.' });

    const itemCountResult = await pool.query('SELECT COUNT(*)::int AS n FROM item_master WHERE supplier_id = $1', [req.params.id]);
    const scanCountResult = await pool.query('SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0)::float AS "totalValue" FROM scans WHERE supplier_id = $1', [req.params.id]);
    const priceHistoryCountResult = await pool.query(
      `SELECT COUNT(*)::int AS n FROM item_price_history WHERE item_id IN (SELECT id FROM item_master WHERE supplier_id = $1)`,
      [req.params.id]
    );

    res.json({
      supplierName: supResult.rows[0].name,
      itemCount: itemCountResult.rows[0].n,
      scanCount: scanCountResult.rows[0].n,
      totalScanValue: scanCountResult.rows[0].totalValue,
      priceHistoryCount: priceHistoryCountResult.rows[0].n,
      hasLinkedData: itemCountResult.rows[0].n > 0 || scanCountResult.rows[0].n > 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.delete('/:id', requireRole('admin', 'processor', 'developer'), async (req, res) => {
  const confirmCascade = req.query.confirmCascade === 'true';

  try {
    const supResult = await pool.query('SELECT id, name FROM suppliers WHERE id = $1 AND business_id = $2', [req.params.id, req.user.businessId]);
    if (!supResult.rows[0]) return res.status(404).json({ error: 'Supplier not found.' });

    // Without explicit confirmation, refuse to delete if anything real is
    // still linked - tell the caller exactly why, rather than let the
    // database throw a confusing foreign-key error.
    if (!confirmCascade) {
      const itemCountResult = await pool.query('SELECT COUNT(*)::int AS n FROM item_master WHERE supplier_id = $1', [req.params.id]);
      const scanCountResult = await pool.query('SELECT COUNT(*)::int AS n FROM scans WHERE supplier_id = $1', [req.params.id]);
      if (itemCountResult.rows[0].n > 0 || scanCountResult.rows[0].n > 0) {
        return res.status(409).json({
          error: 'This supplier still has linked items and/or scan history.',
          needsConfirmation: true,
          itemCount: itemCountResult.rows[0].n,
          scanCount: scanCountResult.rows[0].n,
        });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (confirmCascade) {
        // Delete order matters: item_price_history cascades automatically
        // when its item_master row is deleted, and scan_line_items cascades
        // automatically when its scan row is deleted - but item_price_history
        // rows tied to a scan_id (not just an item_id) need an explicit pass
        // too, in the rare case a line item matched an item from a different
        // supplier during one of this supplier's scans.
        await client.query(
          `DELETE FROM item_price_history WHERE scan_id IN (SELECT id FROM scans WHERE supplier_id = $1)`,
          [req.params.id]
        );
        await client.query('DELETE FROM item_master WHERE supplier_id = $1', [req.params.id]);
        await client.query('DELETE FROM scans WHERE supplier_id = $1', [req.params.id]);
      }
      const deleteResult = await client.query('DELETE FROM suppliers WHERE id = $1 AND business_id = $2', [req.params.id, req.user.businessId]);
      if (deleteResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Supplier not found.' });
      }
      await client.query(
        `INSERT INTO audit_log (business_id, actor_user_id, action, target_type, target_id)
         VALUES ($1, $2, 'supplier.deleted', 'supplier', $3)`,
        [req.user.businessId, req.user.userId, req.params.id]
      );
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

module.exports = router;
