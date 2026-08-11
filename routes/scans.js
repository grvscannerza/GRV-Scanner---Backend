const express = require('express');
const { requireAuth, requireRole, requireActiveSubscription } = require('../middleware/auth');
const { pool } = require('../db');
const { getPlanFeatures } = require('./planFeatures');

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveSubscription);

// Real duplicate detection: same business + same supplier + same invoice
// number (trimmed, case-insensitive), matched against any scan that isn't
// rejected. A rejected scan doesn't count, since it was never a real record.
async function findDuplicate(businessId, supplierId, invoiceNumber, excludeScanId) {
  if (!invoiceNumber || !invoiceNumber.trim()) return null;
  const { rows } = await pool.query(`
    SELECT s.id, s.invoice_number, s.scanned_at, s.status, sup.name AS supplier_name,
           u.first_name, u.last_name
    FROM scans s
    JOIN suppliers sup ON sup.id = s.supplier_id
    JOIN users u ON u.id = s.scanned_by
    WHERE s.business_id = $1 AND s.supplier_id = $2
      AND LOWER(TRIM(s.invoice_number)) = LOWER(TRIM($3))
      AND s.status != 'rejected'
      AND s.id != COALESCE($4, -1)
    ORDER BY s.scanned_at ASC LIMIT 1
  `, [businessId, supplierId, invoiceNumber, excludeScanId || null]);
  return rows[0] || null;
}

// Called by the frontend right after AI extraction, once the invoice number
// is known - lets the scan page warn the user BEFORE they lock the scan,
// not just after the fact.
router.get('/check-duplicate', requireRole('admin', 'processor', 'dispatch', 'developer'), async (req, res) => {
  const { supplierId, invoiceNumber } = req.query;
  if (!supplierId || !invoiceNumber) return res.json({ duplicate: null });
  try {
    const { features } = await getPlanFeatures(req.user.businessId);
    if (!features.duplicateDetection) return res.json({ duplicate: null, gated: true });

    const match = await findDuplicate(req.user.businessId, supplierId, invoiceNumber, null);
    res.json({ duplicate: match || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// Everyone who can log in can create a scan (dispatch's whole job is scanning).
router.post('/', requireRole('admin', 'processor', 'dispatch', 'developer'), async (req, res) => {
  const { supplierId, invoiceNumber, note, exclVat, vat, total, priceAlerts, lineItems } = req.body || {};
  if (!supplierId || total == null) {
    return res.status(400).json({ error: 'supplierId and total are required.' });
  }

  try {
    const { features, plan } = await getPlanFeatures(req.user.businessId);

    // Enforce the plan's real monthly scan cap - not just a number on the
    // Billing usage bar. Checked before creating anything.
    if (features.scanLimit !== null) {
      const monthCountResult = await pool.query(`
        SELECT COUNT(*)::int AS n FROM scans
        WHERE business_id = $1 AND TO_CHAR(scanned_at, 'YYYY-MM') = TO_CHAR(NOW(), 'YYYY-MM')
      `, [req.user.businessId]);
      if (monthCountResult.rows[0].n >= features.scanLimit) {
        return res.status(403).json({
          error: `You've reached your ${plan} plan's monthly scan limit (${features.scanLimit}). Upgrade to keep scanning this month.`,
          limitReached: true,
        });
      }
    }

    // Server-side safety net - the frontend already checks and warns before
    // locking, but this catches it regardless of how the scan was submitted.
    const duplicateMatch = features.duplicateDetection
      ? await findDuplicate(req.user.businessId, supplierId, invoiceNumber, null)
      : null;

    const scanResult = await pool.query(`
      INSERT INTO scans (business_id, supplier_id, scanned_by, invoice_number, note, excl_vat, vat, total, price_alerts, status, is_duplicate, duplicate_of_scan_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11) RETURNING id
    `, [req.user.businessId, supplierId, req.user.userId, invoiceNumber || null, note || null,
        exclVat || 0, vat || 0, total, priceAlerts || 0, !!duplicateMatch, duplicateMatch ? duplicateMatch.id : null]);
    const scanId = scanResult.rows[0].id;

    if (Array.isArray(lineItems) && lineItems.length) {
      for (const li of lineItems) {
        const lineVatRate = typeof li.vatRate === 'number' ? li.vatRate : 15;
        await pool.query(`
          INSERT INTO scan_line_items (scan_id, description, code, qty, unit, unit_price, vat_rate, flag)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [scanId, li.desc || '', li.code || '', li.qty || 0, li.unit || 'each', li.unitPrice || 0, lineVatRate, li.flag || 'ok']);

        // If this line item matches a known Item Master code, keep its price current
        // and record the change, so Item Master reflects what's actually been paid.
        // Also remember this item's VAT rate - a single supplier can sell both
        // VAT-able and zero-rated items, so the rate has to be remembered per
        // product, not just assumed from the supplier, next time it's scanned.
        if (li.code) {
          const itemResult = await pool.query(
            'SELECT id, current_price, vat_rate FROM item_master WHERE business_id = $1 AND code = $2',
            [req.user.businessId, li.code]
          );
          const item = itemResult.rows[0];
          if (item) {
            await pool.query(
              'UPDATE item_master SET current_price = $1, vat_rate = $2, last_ordered_at = NOW() WHERE id = $3',
              [li.unitPrice, lineVatRate, item.id]
            );
            if (Number(li.unitPrice) !== item.current_price) {
              await pool.query(
                `INSERT INTO item_price_history (item_id, price, source, scan_id) VALUES ($1, $2, 'scan', $3)`,
                [item.id, li.unitPrice, scanId]
              );
            }
          } else {
            // A genuinely new product code, never seen before - create the
            // Item Master entry now so its price AND VAT rate really are
            // remembered the next time this exact product gets scanned,
            // rather than only ever working for items someone had already
            // added manually.
            const newItemResult = await pool.query(`
              INSERT INTO item_master (business_id, code, name, unit, current_price, vat_rate, supplier_id, last_ordered_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id
            `, [req.user.businessId, li.code, li.desc || li.code, li.unit || 'each', li.unitPrice || 0, lineVatRate, supplierId]);
            await pool.query(
              `INSERT INTO item_price_history (item_id, price, source, scan_id) VALUES ($1, $2, 'scan', $3)`,
              [newItemResult.rows[0].id, li.unitPrice || 0, scanId]
            );
          }
        }
      }
    }

    await pool.query(
      `INSERT INTO audit_log (business_id, actor_user_id, action, target_type, target_id, details)
       VALUES ($1, $2, 'scan.created', 'scan', $3, $4)`,
      [req.user.businessId, req.user.userId, scanId, duplicateMatch ? JSON.stringify({ duplicateOf: duplicateMatch.id }) : null]
    );

    res.status(201).json({ id: scanId, isDuplicate: !!duplicateMatch, duplicateOf: duplicateMatch || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// Dispatch can see their own scans; admin/processor can see everyone's.
router.get('/', requireRole('admin', 'processor', 'dispatch', 'developer'), async (req, res) => {
  try {
    let result;
    if (req.user.role === 'dispatch') {
      result = await pool.query(`
        SELECT s.*, sup.name AS supplier_name, u.first_name, u.last_name
        FROM scans s JOIN suppliers sup ON sup.id = s.supplier_id JOIN users u ON u.id = s.scanned_by
        WHERE s.business_id = $1 AND s.scanned_by = $2 ORDER BY s.scanned_at DESC
      `, [req.user.businessId, req.user.userId]);
    } else {
      result = await pool.query(`
        SELECT s.*, sup.name AS supplier_name, u.first_name, u.last_name
        FROM scans s JOIN suppliers sup ON sup.id = s.supplier_id JOIN users u ON u.id = s.scanned_by
        WHERE s.business_id = $1 ORDER BY s.scanned_at DESC
      `, [req.user.businessId]);
    }
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.get('/:id/line-items', requireRole('admin', 'processor', 'dispatch', 'developer'), async (req, res) => {
  try {
    const scanResult = await pool.query('SELECT id FROM scans WHERE id = $1 AND business_id = $2', [req.params.id, req.user.businessId]);
    if (!scanResult.rows[0]) return res.status(404).json({ error: 'Scan not found.' });
    const itemsResult = await pool.query('SELECT * FROM scan_line_items WHERE scan_id = $1', [req.params.id]);
    res.json(itemsResult.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// Only admin/processor can approve or reject - dispatch cannot approve their own scans.
router.patch('/:id/approve', requireRole('admin', 'processor', 'developer'), async (req, res) => {
  try {
    const result = await pool.query(`
      UPDATE scans SET status='approved', approved_by=$1, approved_at=NOW()
      WHERE id=$2 AND business_id=$3 AND status='pending'
    `, [req.user.userId, req.params.id, req.user.businessId]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Scan not found or already processed.' });

    await pool.query(
      `INSERT INTO audit_log (business_id, actor_user_id, action, target_type, target_id)
       VALUES ($1, $2, 'scan.approved', 'scan', $3)`,
      [req.user.businessId, req.user.userId, req.params.id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.patch('/:id/reject', requireRole('admin', 'processor', 'developer'), async (req, res) => {
  try {
    const result = await pool.query(`
      UPDATE scans SET status='rejected', approved_by=$1, approved_at=NOW()
      WHERE id=$2 AND business_id=$3 AND status='pending'
    `, [req.user.userId, req.params.id, req.user.businessId]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Scan not found or already processed.' });

    await pool.query(
      `INSERT INTO audit_log (business_id, actor_user_id, action, target_type, target_id)
       VALUES ($1, $2, 'scan.rejected', 'scan', $3)`,
      [req.user.businessId, req.user.userId, req.params.id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

module.exports = router;
