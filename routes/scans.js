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
  const { supplierId, invoiceNumber, note, exclVat, vat, total, priceAlerts, lineItems, imageMediaType, imageBase64 } = req.body || {};
  if (!supplierId || total == null) {
    return res.status(400).json({ error: 'supplierId and total are required.' });
  }
  // The image is optional - an older client, or a scan where the upload
  // somehow didn't carry through, shouldn't fail the whole scan over it.
  // Capped well above what the frontend's own compression produces (it
  // targets ~1568px JPEGs), just as a sanity backstop against something huge
  // getting through some other path and bloating the database.
  const MAX_IMAGE_BASE64_CHARS = 8 * 1024 * 1024; // ~8MB of base64 text
  const hasImage = typeof imageBase64 === 'string' && imageBase64.length > 0 && imageBase64.length <= MAX_IMAGE_BASE64_CHARS;

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
      INSERT INTO scans (business_id, supplier_id, scanned_by, invoice_number, note, excl_vat, vat, total, price_alerts, status, is_duplicate, duplicate_of_scan_id, image_media_type, image_data)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12, $13) RETURNING id
    `, [req.user.businessId, supplierId, req.user.userId, invoiceNumber || null, note || null,
        exclVat || 0, vat || 0, total, priceAlerts || 0, !!duplicateMatch, duplicateMatch ? duplicateMatch.id : null,
        hasImage ? (imageMediaType || 'image/jpeg') : null, hasImage ? imageBase64 : null]);
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
    // Deliberately NOT selecting s.image_data here - it's base64 image text
    // that can run into the hundreds of KB per scan, and this query returns
    // every scan at once. Pulling that into every list load would bloat the
    // response for no reason, since the list view never displays the image
    // itself - has_image is enough for the UI to know whether to show a
    // "View Invoice Image" button; the real bytes are fetched on demand via
    // GET /:id/image only when someone actually opens that scan.
    const listColumns = `s.id, s.business_id, s.supplier_id, s.scanned_by, s.invoice_number, s.note,
        s.scanned_at, s.excl_vat, s.vat, s.total, s.price_alerts, s.status, s.approved_by, s.approved_at,
        s.is_duplicate, s.duplicate_of_scan_id, (s.image_data IS NOT NULL) AS has_image,
        sup.name AS supplier_name, u.first_name, u.last_name`;
    let result;
    if (req.user.role === 'dispatch') {
      result = await pool.query(`
        SELECT ${listColumns}
        FROM scans s JOIN suppliers sup ON sup.id = s.supplier_id JOIN users u ON u.id = s.scanned_by
        WHERE s.business_id = $1 AND s.scanned_by = $2 ORDER BY s.scanned_at DESC
      `, [req.user.businessId, req.user.userId]);
    } else {
      result = await pool.query(`
        SELECT ${listColumns}
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

// Returns the original scanned invoice image/PDF as base64, so it can be
// pulled up later next to the AI's reading of it - not just when the scan
// was first done. Returned as JSON (not raw bytes) so the frontend can use
// the same authenticated apiFetch() helper as everywhere else in the app,
// rather than needing a separate blob-fetching code path just for this.
router.get('/:id/image', requireRole('admin', 'processor', 'dispatch', 'developer'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT image_media_type, image_data FROM scans WHERE id = $1 AND business_id = $2',
      [req.params.id, req.user.businessId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Scan not found.' });
    const { image_media_type, image_data } = result.rows[0];
    if (!image_data) return res.status(404).json({ error: 'No image was saved for this scan.' });
    res.json({ mediaType: image_media_type || 'image/jpeg', base64: image_data });
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

// AI invoice extraction happens here, server-side, rather than the browser
// calling Anthropic directly - a real API key can never be safely exposed to
// client-side JS, and Anthropic's API doesn't support being called directly
// from an arbitrary browser origin anyway (no CORS allowance for that).
router.post('/extract', requireRole('admin', 'processor', 'dispatch', 'developer'), async (req, res) => {
  const { mediaType, base64Data } = req.body || {};
  if (!mediaType || !base64Data) {
    return res.status(400).json({ error: 'Missing file data.' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Invoice scanning is not configured on this server yet. Contact support.' });
  }

  try {
    const isPdf = mediaType === 'application/pdf';
    const fileContentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } };

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            fileContentBlock,
            { type: 'text', text: 'This is a photo or PDF of a supplier invoice or delivery note (GRV). Extract the invoice/document number and every line item. Respond with ONLY a raw JSON object, no markdown code fences, no prose before or after. The object must have exactly two fields: "invoiceNumber" (string, the invoice/GRV/document number as printed - if none is visible, use an empty string) and "items" (array). Each element of "items" must have exactly these fields: "desc" (string, product description), "code" (string, product code/SKU as printed on the invoice, or a short uppercase code you invent from the description if none is printed), "qty" (number), "unit" (string, e.g. "each", "box", "kg"), "up" (number, unit price in Rand, no currency symbol). If a field is not visible on the invoice, make a reasonable estimate rather than omitting it. Do not include VAT, totals, or header/footer rows in items - only product line items.' }
          ]
        }]
      }),
    });

    if (!anthropicResponse.ok) {
      const errData = await anthropicResponse.json().catch(() => ({}));
      console.error('Anthropic API error:', anthropicResponse.status, errData);
      const realMessage = errData?.error?.message;
      return res.status(502).json({ error: realMessage ? `Invoice extraction failed: ${realMessage}` : `Invoice extraction failed (${anthropicResponse.status}). Please try again.` });
    }

    const data = await anthropicResponse.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) {
      return res.status(502).json({ error: 'No readable content came back from invoice extraction.' });
    }

    let jsonText = textBlock.text.trim();
    // Strip markdown code fences if the model wrapped its JSON in them anyway
    jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (parseErr) {
      console.error('Could not parse extraction response as JSON:', jsonText.slice(0, 500));
      return res.status(502).json({ error: 'Could not read the invoice - the extraction result was not valid.' });
    }

    res.json(parsed);
  } catch (err) {
    console.error('Invoice extraction error:', err);
    res.status(500).json({ error: 'Something went wrong while extracting the invoice. Please try again.' });
  }
});

module.exports = router;
