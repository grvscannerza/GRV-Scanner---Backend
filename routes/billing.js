const express = require('express');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { requireAuth, requireRole, resolveActiveBranch } = require('../middleware/auth');
const { pool } = require('../db');

const router = express.Router();

const PAYSTACK_BASE = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';

// One plan for every branch: R2,999/month excl. VAT = R3,448.85 incl. VAT.
// The Paystack plan itself must be created at 344885 (cents, VAT included).
// Every branch is its own company and pays its own subscription, whether or
// not it belongs to a group.
const PLAN_CONFIG = {
  business: { label: 'Business', price: 2999, planCodeEnv: 'PAYSTACK_PLAN_BUSINESS' },
};

function paystackConfigured() {
  return !!process.env.PAYSTACK_SECRET_KEY;
}

async function paystackFetch(path, options = {}) {
  const response = await fetch(`${PAYSTACK_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json();
  if (!response.ok || data.status === false) {
    throw new Error(data.message || 'Paystack request failed.');
  }
  return data;
}

router.post('/checkout', requireAuth, resolveActiveBranch, requireRole('admin', 'developer'), async (req, res) => {
  if (!paystackConfigured()) {
    return res.status(503).json({ error: 'Payment provider is not connected yet. Add PAYSTACK_SECRET_KEY to your .env to enable real billing.' });
  }

  // Only one plan exists, so the browser doesn't get to choose a price at all.
  const plan = 'business';
  const config = PLAN_CONFIG[plan];

  const planCode = process.env[config.planCodeEnv];
  if (!planCode) {
    return res.status(503).json({ error: `No Paystack plan code configured for ${config.label}. Create the plan in your Paystack dashboard and set ${config.planCodeEnv} in .env.` });
  }

  try {
    const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.userId]);
    const user = userResult.rows[0];
    if (!user || !user.email) {
      return res.status(400).json({ error: 'Your account needs an email address on file before you can subscribe. Add one in Settings.' });
    }

    const result = await paystackFetch('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email: user.email,
        plan: planCode,
        callback_url: process.env.PAYSTACK_CALLBACK_URL || 'http://localhost:3000',
        metadata: { businessId: req.activeBusinessId, planTier: plan },
      }),
    });

    res.json({ authorizationUrl: result.data.authorization_url, reference: result.data.reference });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/verify/:reference', requireAuth, resolveActiveBranch, requireRole('admin', 'developer'), async (req, res) => {
  if (!paystackConfigured()) {
    return res.status(503).json({ error: 'Payment provider is not connected.' });
  }
  try {
    const result = await paystackFetch(`/transaction/verify/${encodeURIComponent(req.params.reference)}`);
    const tx = result.data;

    if (tx.status !== 'success') {
      return res.status(400).json({ error: `Payment was not successful (status: ${tx.status}).` });
    }
    if (!req.accessibleBusinessIds.includes(Number(tx.metadata?.businessId))) {
      return res.status(403).json({ error: 'This transaction does not belong to your business.' });
    }

    await applySuccessfulPayment(tx);
    res.json({ ok: true, plan: tx.metadata.planTier });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

async function generateInvoiceNumber() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM invoices`);
  return `INV${13647 + rows[0].n}`;
}

async function applySuccessfulPayment(tx) {
  const businessId = Number(tx.metadata.businessId);
  const planTier = 'business';
  // paystack_paid_at lets the webhook tell WHICH branch a brand-new
  // subscription belongs to when one owner pays for several branches (they
  // share one Paystack customer, so the customer code alone is ambiguous).
  // A subscription code is only ever stored by the subscription.create
  // webhook, never guessed here.
  await pool.query(`
    UPDATE businesses SET plan = $1, subscription_status = 'active', past_due_since = NULL,
      paystack_customer_code = COALESCE($2, paystack_customer_code), paystack_paid_at = NOW()
    WHERE id = $3
  `, [planTier, tx.customer?.customer_code || null, businessId]);

  await pool.query(
    `INSERT INTO audit_log (business_id, action, target_type, details)
     VALUES ($1, 'billing.payment_success', 'business', $2)`,
    [businessId, JSON.stringify({ reference: tx.reference, plan: planTier, amount: tx.amount })]
  );

  const amountInclVat = Math.round(tx.amount) / 100;
  const amountExclVat = Math.round((amountInclVat / 1.15) * 100) / 100;
  const vatAmount = Math.round((amountInclVat - amountExclVat) * 100) / 100;

  const invoiceNumber = await generateInvoiceNumber();
  await pool.query(`
    INSERT INTO invoices (business_id, invoice_number, plan, amount_incl_vat, amount_excl_vat, vat_amount, paystack_reference)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [businessId, invoiceNumber, planTier, amountInclVat, amountExclVat, vatAmount, tx.reference]);
}

router.post('/cancel', requireAuth, resolveActiveBranch, requireRole('admin', 'developer'), async (req, res) => {
  if (!paystackConfigured()) {
    return res.status(503).json({ error: 'Payment provider is not connected yet, so there is no live subscription to cancel.' });
  }
  try {
    const bizResult = await pool.query(
      'SELECT paystack_subscription_code, paystack_email_token FROM businesses WHERE id = $1',
      [req.activeBusinessId]
    );
    const biz = bizResult.rows[0];
    if (!biz?.paystack_subscription_code || !biz?.paystack_email_token) {
      return res.status(400).json({ error: 'No active subscription found to cancel.' });
    }

    await paystackFetch('/subscription/disable', {
      method: 'POST',
      body: JSON.stringify({ code: biz.paystack_subscription_code, token: biz.paystack_email_token }),
    });
    await pool.query(`UPDATE businesses SET subscription_status = 'cancelled' WHERE id = $1`, [req.activeBusinessId]);
    await pool.query(
      `INSERT INTO audit_log (business_id, actor_user_id, action, target_type)
       VALUES ($1, $2, 'billing.subscription_cancelled', 'business')`,
      [req.activeBusinessId, req.user.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/invoices', requireAuth, resolveActiveBranch, requireRole('admin', 'developer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, invoice_number, plan, amount_incl_vat, amount_excl_vat, vat_amount, issued_at FROM invoices WHERE business_id = $1 ORDER BY issued_at DESC',
      [req.activeBusinessId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

function streamInvoicePDF(res, invoice, business) {
  const planLabels = { business: 'Business Plan', starter: 'Starter Plan', professional: 'Professional Plan', enterprise: 'Enterprise Plan' };

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoice_number}.pdf"`);

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  const fmtR = (n) => 'R' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const black = '#0a0a0a', lime = '#8a9a10', muted = '#666666', border = '#e0e0e0';

  doc.rect(0, 0, doc.page.width, 70).fill(black);
  doc.fontSize(20).fillColor('#c8f135').text('GRV', 50, 24, { continued: true });
  doc.fillColor('#ffffff').text('SCANNER');
  doc.fontSize(9).fillColor('#888888').text('TAX INVOICE', 50, 48);

  doc.fillColor(black);
  doc.moveDown(3);

  const topY = 100;
  doc.fontSize(10).fillColor(muted).text('Invoice Number', 50, topY);
  doc.fontSize(12).fillColor(black).text(invoice.invoice_number, 50, topY + 14);

  doc.fontSize(10).fillColor(muted).text('Date Issued', 300, topY);
  doc.fontSize(12).fillColor(black).text(new Date(invoice.issued_at).toLocaleDateString('en-ZA', { day: '2-digit', month: 'long', year: 'numeric' }), 300, topY + 14);

  doc.fontSize(10).fillColor(muted).text('Billed To', 50, topY + 45);
  doc.fontSize(12).fillColor(black).text(business?.name || 'Customer', 50, topY + 59);
  let billedToY = topY + 75;
  if (business?.address) {
    doc.fontSize(8).fillColor(muted).text(business.address, 50, billedToY, { width: 220 });
    billedToY += 22;
  }
  if (business?.contact_number) { doc.fontSize(8).fillColor(muted).text(`Tel: ${business.contact_number}`, 50, billedToY); billedToY += 11; }
  if (business?.contact_email) { doc.fontSize(8).fillColor(muted).text(business.contact_email, 50, billedToY); billedToY += 11; }
  if (business?.vat_number) { doc.fontSize(8).fillColor(muted).text(`VAT No: ${business.vat_number}`, 50, billedToY); billedToY += 11; }

  doc.fontSize(10).fillColor(muted).text('From', 300, topY + 45);
  doc.fontSize(12).fillColor(black).text('GRV Scanner (Pty) Ltd', 300, topY + 59);
  doc.fontSize(8).fillColor(muted).text('South Africa', 300, topY + 75);

  const tableY = Math.max(billedToY + 20, topY + 110);
  doc.rect(50, tableY, 495, 26).fill('#f0f0f0');
  doc.fontSize(9).fillColor(muted);
  doc.text('DESCRIPTION', 60, tableY + 8);
  doc.text('EXCL. VAT', 330, tableY + 8, { width: 80, align: 'right' });
  doc.text('VAT (15%)', 410, tableY + 8, { width: 60, align: 'right' });
  doc.text('TOTAL', 480, tableY + 8, { width: 60, align: 'right' });

  const rowY = tableY + 36;
  doc.fontSize(11).fillColor(black);
  doc.text(planLabels[invoice.plan] || invoice.plan, 60, rowY);
  doc.text(fmtR(invoice.amount_excl_vat), 330, rowY, { width: 80, align: 'right' });
  doc.text(fmtR(invoice.vat_amount), 410, rowY, { width: 60, align: 'right' });
  doc.text(fmtR(invoice.amount_incl_vat), 480, rowY, { width: 60, align: 'right' });

  doc.moveTo(50, rowY + 30).lineTo(545, rowY + 30).strokeColor(border).stroke();

  const totalsY = rowY + 45;
  doc.fontSize(10).fillColor(muted).text('Subtotal (excl. VAT)', 350, totalsY, { width: 120, align: 'right' });
  doc.fillColor(black).text(fmtR(invoice.amount_excl_vat), 480, totalsY, { width: 60, align: 'right' });

  doc.fillColor(muted).text('VAT (15%)', 350, totalsY + 18, { width: 120, align: 'right' });
  doc.fillColor(black).text(fmtR(invoice.vat_amount), 480, totalsY + 18, { width: 60, align: 'right' });

  doc.moveTo(350, totalsY + 38).lineTo(545, totalsY + 38).strokeColor(border).stroke();

  doc.fontSize(12).fillColor(black).text('Total (incl. VAT)', 350, totalsY + 46, { width: 120, align: 'right' });
  doc.fontSize(14).fillColor(lime).text(fmtR(invoice.amount_incl_vat), 470, totalsY + 44, { width: 75, align: 'right' });

  doc.fontSize(8).fillColor(muted).text('GRVSCANNER.CO.ZA - This is a computer-generated tax invoice.', 50, doc.page.height - 60, { align: 'center', width: 495 });

  doc.end();
}

router.get('/invoices/:id/pdf', requireAuth, resolveActiveBranch, requireRole('admin', 'developer'), async (req, res) => {
  try {
    const invoiceResult = await pool.query('SELECT * FROM invoices WHERE id = $1 AND business_id = $2', [req.params.id, req.activeBusinessId]);
    const invoice = invoiceResult.rows[0];
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
    const businessResult = await pool.query(
      'SELECT name, address, contact_number, contact_email, vat_number FROM businesses WHERE id = $1',
      [req.activeBusinessId]
    );
    streamInvoicePDF(res, invoice, businessResult.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

async function webhookHandler(req, res) {
  const signature = req.headers['x-paystack-signature'] || '';
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return res.status(503).end();

  const expectedSignature = crypto.createHmac('sha512', secret).update(req.body).digest('hex');

  // Constant-time comparison, not a plain !== . A straight string compare
  // returns as soon as it hits the first mismatched character, so how long
  // the check takes leaks how many leading characters an attacker already
  // guessed right - over enough attempts that's a real (if slow) way to
  // forge a valid signature. timingSafeEqual takes the same time regardless
  // of where the mismatch is. It requires equal-length buffers, so a
  // malformed/wrong-length header is rejected by the length check first,
  // before ever reaching timingSafeEqual (which would otherwise throw).
  const signatureBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expectedSignature, 'hex');
  const validSignature = signatureBuf.length === expectedBuf.length && crypto.timingSafeEqual(signatureBuf, expectedBuf);
  if (!validSignature) {
    return res.status(401).json({ error: 'Invalid webhook signature.' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (e) {
    return res.status(400).end();
  }

  try {
    const d = event.data || {};
    // Paystack nests the subscription on invoice events and puts it at the top
    // level on subscription events - accept either shape.
    const subCode = d.subscription_code || d.subscription?.subscription_code || null;
    const customerCode = d.customer?.customer_code || null;

    if (event.event === 'charge.success' && d.metadata?.businessId) {
      await applySuccessfulPayment(d);
    } else if (event.event === 'subscription.create') {
      // One owner can pay for several branches (one Paystack customer, many
      // subscriptions), so a customer code alone can match several branches.
      // Attach the new subscription to exactly ONE branch: the most recently
      // paid branch of this customer that has no subscription yet. Never
      // fan out across all of that customer's branches.
      if (customerCode && subCode) {
        await pool.query(`
          UPDATE businesses SET paystack_subscription_code = $1, paystack_email_token = $2
          WHERE id = (
            SELECT id FROM businesses
            WHERE paystack_customer_code = $3 AND paystack_subscription_code IS NULL
            ORDER BY paystack_paid_at DESC NULLS LAST, id DESC LIMIT 1
          )
        `, [subCode, d.email_token || null, customerCode]);
      }
    } else if (event.event === 'subscription.disable' || event.event === 'subscription.not_renew') {
      if (subCode && event.event === 'subscription.disable') {
        await pool.query(`UPDATE businesses SET subscription_status = 'cancelled' WHERE paystack_subscription_code = $1`, [subCode]);
      }
    } else if (event.event === 'invoice.payment_failed') {
      // COALESCE keeps the original failure timestamp if this fires again
      // (Paystack retries a few times before giving up) - the 3-day grace
      // period should count from the FIRST failure, not reset on every retry.
      // Matched by SUBSCRIPTION code so only the branch whose payment failed is
      // affected. If no subscription code is present, fall back to the
      // customer code ONLY when that customer owns exactly one branch;
      // otherwise do nothing rather than mark a whole group past due.
      if (subCode) {
        await pool.query(`
          UPDATE businesses SET subscription_status = 'past_due', past_due_since = COALESCE(past_due_since, NOW())
          WHERE paystack_subscription_code = $1
        `, [subCode]);
      } else if (customerCode) {
        const owned = await pool.query('SELECT id FROM businesses WHERE paystack_customer_code = $1', [customerCode]);
        if (owned.rows.length === 1) {
          await pool.query(`
            UPDATE businesses SET subscription_status = 'past_due', past_due_since = COALESCE(past_due_since, NOW())
            WHERE id = $1
          `, [owned.rows[0].id]);
        } else {
          console.error('invoice.payment_failed without a subscription code for a customer with multiple branches - not applied:', customerCode);
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing failed:', err);
  }

  res.status(200).end();
}

module.exports = { router, webhookHandler, streamInvoicePDF, paystackConfigured, paystackFetch };
