const express = require('express');
const { requireAuth, requireRole, requireActiveSubscription } = require('../middleware/auth');
const { pool } = require('../db');
const { getPlanFeatures } = require('./planFeatures');

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveSubscription);

// Real aggregated report for a date range, built from actual scans - not generated.
// GET /api/reports/summary?start=2026-07-31&end=2026-07-31  (inclusive, business-local dates)
// Real numbers for the home page's quick-stats strip - previously this was
// entirely hardcoded placeholder text left over from the original mockup
// (a fake "4 waiting", "18 scanned today", etc. that never changed no
// matter what was actually in the database).
router.get('/home-summary', requireRole('admin', 'processor', 'developer'), async (req, res) => {
  try {
    const { features } = await getPlanFeatures(req.user.businessId);

    const pendingResult = await pool.query(
      `SELECT COUNT(*)::int AS n FROM scans WHERE business_id = $1 AND status = 'pending'`,
      [req.user.businessId]
    );

    const todayResult = await pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(total), 0)::float AS "totalValue", COALESCE(SUM(price_alerts), 0)::int AS "priceAlertCount"
       FROM scans WHERE business_id = $1 AND scanned_at::date = CURRENT_DATE`,
      [req.user.businessId]
    );

    res.json({
      pendingCount: pendingResult.rows[0].n,
      scannedToday: todayResult.rows[0].n,
      valueToday: todayResult.rows[0].totalValue,
      priceAlertsToday: features.priceIncreaseDetection ? todayResult.rows[0].priceAlertCount : 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.get('/summary', requireRole('admin', 'processor', 'developer'), async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end query params are required (YYYY-MM-DD).' });

  try {
    const { features } = await getPlanFeatures(req.user.businessId);

    // "Unlimited scan history" is a Professional+ feature - Starter can only
    // pull reports for the last N days. Clamp the effective range rather than
    // hard-error, so a request that partially overlaps the allowed window
    // still returns what it can, with a clear flag for the frontend to explain why.
    let effectiveStart = start;
    let historyLimited = false;
    if (features.historyLimitDays !== null) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - features.historyLimitDays);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      if (start < cutoffStr) {
        effectiveStart = cutoffStr;
        historyLimited = true;
      }
    }

    const scansResult = await pool.query(`
      SELECT s.*, sup.name AS supplier_name, u.first_name, u.last_name
      FROM scans s
      JOIN suppliers sup ON sup.id = s.supplier_id
      JOIN users u ON u.id = s.scanned_by
      WHERE s.business_id = $1 AND s.scanned_at::date >= $2::date AND s.scanned_at::date <= $3::date
      ORDER BY s.scanned_at ASC
    `, [req.user.businessId, effectiveStart, end]);
    const scans = scansResult.rows;

    const itemCountResult = await pool.query(`
      SELECT COUNT(*)::int AS n FROM scan_line_items sli
      JOIN scans s ON s.id = sli.scan_id
      WHERE s.business_id = $1 AND s.scanned_at::date >= $2::date AND s.scanned_at::date <= $3::date
    `, [req.user.businessId, effectiveStart, end]);
    const itemCounts = itemCountResult.rows[0].n;

    const staffCount = new Set(scans.map(s => s.scanned_by)).size;
    const vatTotal = scans.reduce((sum, s) => sum + s.vat, 0);
    const grandTotal = scans.reduce((sum, s) => sum + s.total, 0);
    // Price increase detection is an Enterprise feature - Starter/Professional
    // see 0 here rather than real alert counts, matching what they're paying for.
    const priceAlerts = features.priceIncreaseDetection ? scans.reduce((sum, s) => sum + (s.price_alerts || 0), 0) : 0;
    // Duplicate detection is Professional+ - Starter never sees flagged duplicates.
    const duplicates = features.duplicateDetection ? scans.filter(s => s.is_duplicate).length : 0;

    const scanRows = [];
    for (let i = 0; i < scans.length; i++) {
      const s = scans[i];
      const row = {
        scanNumber: i + 1,
        id: s.id,
        supplier: s.supplier_name,
        priceIncreases: features.priceIncreaseDetection ? s.price_alerts : 0,
        exclVat: s.excl_vat,
        vat: s.vat,
        total: s.total,
        isDuplicate: features.duplicateDetection ? s.is_duplicate : false,
        scannedBy: `${s.first_name} ${s.last_name}`,
        scannedAt: s.scanned_at,
      };
      if (features.duplicateDetection && s.is_duplicate && s.duplicate_of_scan_id) {
        const origResult = await pool.query(`
          SELECT s.scanned_at, s.status, s.invoice_number, u.first_name, u.last_name
          FROM scans s JOIN users u ON u.id = s.scanned_by
          WHERE s.id = $1
        `, [s.duplicate_of_scan_id]);
        const orig = origResult.rows[0];
        if (orig) {
          row.duplicateOf = {
            invoiceNumber: orig.invoice_number,
            scannedAt: orig.scanned_at,
            scannedBy: `${orig.first_name} ${orig.last_name}`,
            status: orig.status,
          };
        }
      }
      scanRows.push(row);
    }

    res.json({
      stats: {
        totalScans: scans.length,
        activeStaff: staffCount,
        lineItems: itemCounts,
        vatTotal,
        priceAlerts,
        duplicates,
        grandTotal,
      },
      scans: scanRows,
      planFeatures: features,
      historyLimited,
      historyLimitDays: features.historyLimitDays,
      effectiveStart,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// Real aggregated data for the Insights page - approved scans only, since those
// are the only financially "real" numbers (pending/rejected scans don't count
// as actual spend yet).
router.get('/insights', requireRole('admin', 'processor', 'developer'), async (req, res) => {
  const bizId = req.user.businessId;
  const { start, end } = req.query;
  // Every query below optionally respects this same date range, so the whole
  // page consistently reflects whatever period is selected - a scan_id join
  // is used for the line-item queries since scan_line_items itself has no date.
  const dateFilter = (start && end) ? `AND s.scanned_at::date BETWEEN $2 AND $3` : '';
  const dateFilterNoAlias = (start && end) ? `AND scanned_at::date BETWEEN $2 AND $3` : '';
  const params = (start && end) ? [bizId, start, end] : [bizId];

  try {
    const { features } = await getPlanFeatures(bizId);
    // Insights is a Professional+ feature - Starter doesn't get it at all,
    // matching what Starter's plan card actually promises.
    if (!features.fullInsights) {
      return res.status(403).json({ error: 'Insights requires the Professional plan or higher.', gated: true, requiredPlan: 'professional' });
    }

    const statsResult = await pool.query(`
      SELECT COUNT(*)::int AS "invoicesScanned", COALESCE(SUM(total),0)::float AS "totalSpend", COALESCE(SUM(price_alerts),0)::int AS "priceAlerts"
      FROM scans WHERE business_id = $1 AND status = 'approved' ${dateFilterNoAlias}
    `, params);
    const stats = statsResult.rows[0];

    const activeSuppliersResult = await pool.query(`
      SELECT COUNT(DISTINCT supplier_id)::int AS n FROM scans WHERE business_id = $1 AND status = 'approved' ${dateFilterNoAlias}
    `, params);
    const activeSuppliers = activeSuppliersResult.rows[0].n;

    const mostOrderedResult = await pool.query(`
      SELECT sli.description, SUM(sli.qty)::float AS "totalQty"
      FROM scan_line_items sli JOIN scans s ON s.id = sli.scan_id
      WHERE s.business_id = $1 AND s.status = 'approved' ${dateFilter}
      GROUP BY sli.description ORDER BY "totalQty" DESC LIMIT 1
    `, params);
    const mostOrdered = mostOrderedResult.rows[0];

    const spendPerSupplierResult = await pool.query(`
      SELECT sup.name AS supplier, COALESCE(SUM(s.total),0)::float AS total
      FROM suppliers sup LEFT JOIN scans s ON s.supplier_id = sup.id AND s.status = 'approved' ${dateFilter}
      WHERE sup.business_id = $1 GROUP BY sup.id, sup.name ORDER BY total DESC
    `, params);

    const invoicesPerSupplierResult = await pool.query(`
      SELECT sup.name AS supplier, COUNT(s.id)::int AS count
      FROM suppliers sup LEFT JOIN scans s ON s.supplier_id = sup.id AND s.status = 'approved' ${dateFilter}
      WHERE sup.business_id = $1 GROUP BY sup.id, sup.name ORDER BY count DESC
    `, params);

    const topProductsResult = await pool.query(`
      SELECT sli.description, SUM(sli.qty)::float AS qty
      FROM scan_line_items sli JOIN scans s ON s.id = sli.scan_id
      WHERE s.business_id = $1 AND s.status = 'approved' ${dateFilter}
      GROUP BY sli.description ORDER BY qty DESC LIMIT 7
    `, params);

    const monthlySpendResult = await pool.query(`
      SELECT TO_CHAR(scanned_at, 'YYYY-MM') AS month, COALESCE(SUM(total),0)::float AS total
      FROM scans WHERE business_id = $1 AND status = 'approved' ${dateFilterNoAlias}
      GROUP BY month ORDER BY month ASC
    `, params);

    // Pick the two items with the most price history activity for the trend charts.
    // Price trend charts are Enterprise-only ("Price increase detection").
    let priceTrends = [];
    if (features.priceIncreaseDetection) {
      const trendItemsResult = await pool.query(`
        SELECT im.id, im.code, im.name, sup.name AS supplier_name, COUNT(iph.id)::int AS history_count
        FROM item_master im
        LEFT JOIN item_price_history iph ON iph.item_id = im.id
        LEFT JOIN suppliers sup ON sup.id = im.supplier_id
        WHERE im.business_id = $1
        GROUP BY im.id, sup.name ORDER BY history_count DESC LIMIT 2
      `, [bizId]);

      for (const item of trendItemsResult.rows) {
        const historyDateFilter = (start && end) ? `AND recorded_at::date BETWEEN $2 AND $3` : '';
        const historyParams = (start && end) ? [item.id, start, end] : [item.id];
        const historyResult = await pool.query(
          `SELECT price, recorded_at FROM item_price_history WHERE item_id = $1 ${historyDateFilter} ORDER BY recorded_at ASC`,
          historyParams
        );
        priceTrends.push({ code: item.code, name: item.name, supplier: item.supplier_name, history: historyResult.rows });
      }
    }

    res.json({
      stats: {
        invoicesScanned: stats.invoicesScanned,
        activeSuppliers,
        totalSpend: stats.totalSpend,
        priceAlerts: features.priceIncreaseDetection ? stats.priceAlerts : 0,
        mostOrderedItem: mostOrdered ? mostOrdered.description : null,
      },
      spendPerSupplier: spendPerSupplierResult.rows,
      invoicesPerSupplier: invoicesPerSupplierResult.rows,
      topProducts: topProductsResult.rows,
      monthlySpend: monthlySpendResult.rows,
      priceTrends,
      planFeatures: features,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// "Supplier or Product Lookup" - everything relevant to ONE specific
// supplier or product, rather than the aggregate/side-by-side comparisons
// the rest of the Insights page shows. Respects the same date range as the
// main dashboard for consistency.
router.get('/lookup', requireRole('admin', 'processor', 'developer'), async (req, res) => {
  const bizId = req.user.businessId;
  const { type, id, start, end } = req.query;

  if (type !== 'supplier' && type !== 'product') {
    return res.status(400).json({ error: 'type must be "supplier" or "product".' });
  }
  if (!id) return res.status(400).json({ error: 'id is required.' });

  const dateFilter = (start && end) ? `AND s.scanned_at::date BETWEEN $3 AND $4` : '';
  const dateParams = (start && end) ? [start, end] : [];

  try {
    if (type === 'supplier') {
      const supResult = await pool.query('SELECT id, name FROM suppliers WHERE id = $1 AND business_id = $2', [id, bizId]);
      if (!supResult.rows[0]) return res.status(404).json({ error: 'Supplier not found.' });

      const statsResult = await pool.query(`
        SELECT COUNT(*)::int AS "invoiceCount", COALESCE(SUM(total),0)::float AS "totalSpend"
        FROM scans s WHERE s.business_id = $2 AND s.supplier_id = $1 AND s.status = 'approved' ${dateFilter}
      `, [id, bizId, ...dateParams]);

      const spendOverTimeResult = await pool.query(`
        SELECT TO_CHAR(s.scanned_at, 'YYYY-MM') AS month, COALESCE(SUM(s.total),0)::float AS total
        FROM scans s WHERE s.business_id = $2 AND s.supplier_id = $1 AND s.status = 'approved' ${dateFilter}
        GROUP BY month ORDER BY month ASC
      `, [id, bizId, ...dateParams]);

      const topItemsResult = await pool.query(`
        SELECT sli.description, SUM(sli.qty)::float AS qty, SUM(sli.qty * sli.unit_price)::float AS "totalSpent"
        FROM scan_line_items sli JOIN scans s ON s.id = sli.scan_id
        WHERE s.business_id = $2 AND s.supplier_id = $1 AND s.status = 'approved' ${dateFilter}
        GROUP BY sli.description ORDER BY "totalSpent" DESC LIMIT 10
      `, [id, bizId, ...dateParams]);

      return res.json({
        type: 'supplier',
        name: supResult.rows[0].name,
        invoiceCount: statsResult.rows[0].invoiceCount,
        totalSpend: statsResult.rows[0].totalSpend,
        spendOverTime: spendOverTimeResult.rows,
        topItems: topItemsResult.rows,
      });
    } else {
      const itemResult = await pool.query(
        'SELECT im.id, im.code, im.name, im.current_price, sup.name AS supplier_name FROM item_master im LEFT JOIN suppliers sup ON sup.id = im.supplier_id WHERE im.id = $1 AND im.business_id = $2',
        [id, bizId]
      );
      if (!itemResult.rows[0]) return res.status(404).json({ error: 'Product not found.' });
      const item = itemResult.rows[0];

      const priceHistoryDateFilter = (start && end) ? `AND recorded_at::date BETWEEN $2 AND $3` : '';
      const priceHistoryParams = (start && end) ? [id, start, end] : [id];
      const priceHistoryResult = await pool.query(
        `SELECT price, recorded_at FROM item_price_history WHERE item_id = $1 ${priceHistoryDateFilter} ORDER BY recorded_at ASC`,
        priceHistoryParams
      );

      const qtyResult = await pool.query(`
        SELECT COALESCE(SUM(sli.qty),0)::float AS "totalQty", COALESCE(SUM(sli.qty * sli.unit_price),0)::float AS "totalSpend", COUNT(DISTINCT s.id)::int AS "invoiceCount"
        FROM scan_line_items sli JOIN scans s ON s.id = sli.scan_id
        WHERE s.business_id = $2 AND sli.code = $1 AND s.status = 'approved' ${dateFilter}
      `, [item.code, bizId, ...dateParams]);

      return res.json({
        type: 'product',
        code: item.code,
        name: item.name,
        supplierName: item.supplier_name,
        currentPrice: item.current_price,
        totalQty: qtyResult.rows[0].totalQty,
        totalSpend: qtyResult.rows[0].totalSpend,
        invoiceCount: qtyResult.rows[0].invoiceCount,
        priceHistory: priceHistoryResult.rows,
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

module.exports = router;
