const express = require('express');
const { requireAuth, requireRole, requireActiveSubscription } = require('../middleware/auth');
const { pool } = require('../db');
const { getPlanFeatures } = require('./planFeatures');

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveSubscription);

// Returns each item with its real previous price and % change, computed from
// the actual price_history table - not fabricated. The comparison itself
// ("price increase detection") is Enterprise-only; other plans see the
// current price with no comparison.
router.get('/', requireRole('admin', 'processor', 'developer'), async (req, res) => {
  try {
    const { features } = await getPlanFeatures(req.user.businessId);
    const { rows: items } = await pool.query(
      'SELECT * FROM item_master WHERE business_id = $1 ORDER BY name',
      [req.user.businessId]
    );

    const enriched = [];
    for (const item of items) {
      if (!features.priceIncreaseDetection) {
        enriched.push({ ...item, previous_price: null, change_pct: null });
        continue;
      }
      const prevResult = await pool.query(
        `SELECT price FROM item_price_history
         WHERE item_id = $1 ORDER BY recorded_at DESC, id DESC LIMIT 1 OFFSET 1`,
        [item.id]
      );
      const previousPrice = prevResult.rows[0] ? prevResult.rows[0].price : null;
      const changePct = previousPrice && previousPrice !== 0
        ? ((item.current_price - previousPrice) / previousPrice) * 100
        : null;
      enriched.push({ ...item, previous_price: previousPrice, change_pct: changePct });
    }

    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.post('/', requireRole('admin', 'processor', 'developer'), async (req, res) => {
  const { code, name, unit, currentPrice, supplierId, vatRate, trackUnit, trackConversion } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'Code and name are required.' });
  const rate = (vatRate === null || vatRate === undefined || vatRate === '') ? null : parseFloat(vatRate);
  if (rate !== null && (isNaN(rate) || rate < 0 || rate > 100)) {
    return res.status(400).json({ error: 'VAT rate must be between 0 and 100.' });
  }
  const trackUnitClean = (trackUnit && trackUnit.trim()) ? trackUnit.trim() : null;
  const trackConversionClean = (trackConversion === null || trackConversion === undefined || trackConversion === '') ? null : parseFloat(trackConversion);
  if (trackConversionClean !== null && (isNaN(trackConversionClean) || trackConversionClean <= 0)) {
    return res.status(400).json({ error: 'Stock conversion must be a positive number.' });
  }
  if (trackUnitClean && trackConversionClean === null) {
    return res.status(400).json({ error: 'Please enter how many units this converts to.' });
  }

  try {
    const insertResult = await pool.query(`
      INSERT INTO item_master (business_id, code, name, unit, current_price, vat_rate, track_unit, track_conversion, supplier_id, last_ordered_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW()) RETURNING id
    `, [req.user.businessId, code, name, unit || 'each', currentPrice || 0, rate, trackUnitClean, trackConversionClean, supplierId || null]);
    const newId = insertResult.rows[0].id;

    await pool.query(`INSERT INTO item_price_history (item_id, price, source) VALUES ($1, $2, 'manual')`, [newId, currentPrice || 0]);

    await pool.query(
      `INSERT INTO audit_log (business_id, actor_user_id, action, target_type, target_id)
       VALUES ($1, $2, 'item.created', 'item_master', $3)`,
      [req.user.businessId, req.user.userId, newId]
    );

    res.status(201).json({ id: newId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.put('/:id', requireRole('admin', 'processor', 'developer'), async (req, res) => {
  const { code, name, unit, currentPrice, supplierId, vatRate, trackUnit, trackConversion } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'Code and name are required.' });
  const rate = (vatRate === null || vatRate === undefined || vatRate === '') ? null : parseFloat(vatRate);
  if (rate !== null && (isNaN(rate) || rate < 0 || rate > 100)) {
    return res.status(400).json({ error: 'VAT rate must be between 0 and 100.' });
  }
  const trackUnitClean = (trackUnit && trackUnit.trim()) ? trackUnit.trim() : null;
  const trackConversionClean = (trackConversion === null || trackConversion === undefined || trackConversion === '') ? null : parseFloat(trackConversion);
  if (trackConversionClean !== null && (isNaN(trackConversionClean) || trackConversionClean <= 0)) {
    return res.status(400).json({ error: 'Stock conversion must be a positive number.' });
  }
  if (trackUnitClean && trackConversionClean === null) {
    return res.status(400).json({ error: 'Please enter how many units this converts to.' });
  }

  try {
    const existingResult = await pool.query(
      'SELECT current_price FROM item_master WHERE id = $1 AND business_id = $2',
      [req.params.id, req.user.businessId]
    );
    const existing = existingResult.rows[0];
    if (!existing) return res.status(404).json({ error: 'Item not found.' });

    const result = await pool.query(`
      UPDATE item_master SET code=$1, name=$2, unit=$3, current_price=$4, vat_rate=$5, track_unit=$6, track_conversion=$7, supplier_id=$8
      WHERE id=$9 AND business_id=$10
    `, [code, name, unit || 'each', currentPrice || 0, rate, trackUnitClean, trackConversionClean, supplierId || null, req.params.id, req.user.businessId]);

    if (result.rowCount === 0) return res.status(404).json({ error: 'Item not found.' });

    if (Number(currentPrice) !== existing.current_price) {
      await pool.query(`INSERT INTO item_price_history (item_id, price, source) VALUES ($1, $2, 'manual')`, [req.params.id, currentPrice || 0]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.delete('/:id', requireRole('admin', 'processor', 'developer'), async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM item_master WHERE id = $1 AND business_id = $2',
      [req.params.id, req.user.businessId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Item not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

module.exports = router;
