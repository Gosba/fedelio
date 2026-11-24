// Abonnements PayPal (API REST v1 : catalogs, billing plans, subscriptions, webhooks)
'use strict';
const MODE = process.env.PAYPAL_MODE === 'live' ? 'live' : 'sandbox';
const API = process.env.PAYPAL_API_BASE || (MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const enabled = !!(CLIENT_ID && SECRET);

const EVENTS = [
  'BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.UPDATED', 'BILLING.SUBSCRIPTION.RE-ACTIVATED',
  'BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED', 'PAYMENT.SALE.COMPLETED',
];

let token = null, tokenExp = 0;
async function auth() {
  if (token && Date.now() < tokenExp) return token;
  const r = await fetch(API + '/v1/oauth2/token', {
    method: 'POST', body: 'grant_type=client_credentials',
    headers: { Authorization: 'Basic ' + Buffer.from(CLIENT_ID + ':' + SECRET).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('PayPal refuse les identifiants (' + (d.error_description || r.status) + ')');
  token = d.access_token; tokenExp = Date.now() + (d.expires_in - 120) * 1000; return token;
}
async function call(method, path, body) {
  if (!enabled) throw new Error('PayPal n\'est pas configuré');
  const r = await fetch(API + path, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: 'Bearer ' + await auth(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
  });
  if (r.status === 204) return {};
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('PayPal : ' + (d.details?.[0]?.description || d.message || d.name || r.status));
  return d;
}

// Crée le produit, l'offre mensuelle et le webhook en une fois
async function setup({ price, name, webhookUrl }) {
  const product = await call('POST', '/v1/catalogs/products', { name: `${name} — abonnement boutique`, type: 'SERVICE', category: 'SOFTWARE' });
  const plan = await call('POST', '/v1/billing/plans', {
    product_id: product.id, name: `${name} — ${price} € par mois`, status: 'ACTIVE',
    billing_cycles: [{ frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0,
      pricing_scheme: { fixed_price: { value: String(price), currency_code: 'EUR' } } }],
    payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CONTINUE', payment_failure_threshold: 2 },
  });
  let webhook;
  try { webhook = await call('POST', '/v1/notifications/webhooks', { url: webhookUrl, event_types: EVENTS.map(name => ({ name })) }); }
  catch (e) {
    // Webhook déjà déclaré pour cette adresse : on le réutilise
    const list = await call('GET', '/v1/notifications/webhooks');
    webhook = (list.webhooks || []).find(w => w.url === webhookUrl);
    if (!webhook) throw e;
    await call('PATCH', `/v1/notifications/webhooks/${webhook.id}`, [{ op: 'replace', path: '/event_types', value: EVENTS.map(name => ({ name })) }]).catch(() => {});
  }
  return { productId: product.id, planId: plan.id, webhookId: webhook.id };
}

const getSubscription = (id) => call('GET', '/v1/billing/subscriptions/' + encodeURIComponent(id));
const cancelSubscription = (id, reason) => call('POST', `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { reason: reason || 'Résiliation demandée par le commerçant' });

async function verifyWebhook(headers, event, webhookId) {
  const d = await call('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'],
    webhook_id: webhookId, webhook_event: event,
  });
  return d.verification_status === 'SUCCESS';
}

module.exports = { enabled, MODE, CLIENT_ID, setup, getSubscription, cancelSubscription, verifyWebhook };
