// Registers the Shopify webhooks the abandoned-cart feature needs. Run once after deploying:  npm run webhooks:register
// Needs PUBLIC_BASE_URL (your deployed backend) and Admin credentials. Re-running may report "already exists": that's fine.
import 'dotenv/config';
import { adminQuery } from '../server/shopify.js';
const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
if (!base.startsWith('https://')) { console.error('Set PUBLIC_BASE_URL to your https backend address first.'); process.exit(1); }
const M = `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } } }`;
for (const [topic, p] of [['CHECKOUTS_CREATE', '/webhooks/shopify/checkouts'], ['CHECKOUTS_UPDATE', '/webhooks/shopify/checkouts'], ['ORDERS_CREATE', '/webhooks/shopify/orders']]) {
  try {
    const d = (await adminQuery(M, { topic, sub: { callbackUrl: base + p, format: 'JSON' } })).webhookSubscriptionCreate;
    console.log(`${topic}: ${d.userErrors.length ? d.userErrors.map((e) => e.message).join('; ') : `registered ${d.webhookSubscription.id}`}`);
  } catch (e) { console.error(`${topic}: failed (${e.message}). Check the app scopes and protected customer data approval.`); }
}
