# Laptop Station AI assistant (Shopify)

A branded chat assistant for a Shopify storefront: guided product finder, in-chat product carousel with Add to cart / Buy now,
a header cart panel, condition grades, add-on suggestions, policy answers from a knowledge base, order status with identity check,
human hand-over with out-of-hours capture, lead logging and an admin dashboard, and optional abandoned-cart WhatsApp/SMS.

```
Shopper's browser (storefront)                         Your server (this repo)                        Shopify / services
 widget/ls-chat.js ── signed session ──▶  Express + AI tool loop (OpenAI or Claude)  ──▶  products: Storefront API, or the public catalogue
   │  SSE: text, cards, forms, actions        tools: search_products · get_product · show_product_cards      orders: Admin API (identity-checked)
   └─ /cart.js /cart/add.js /cart/change.js   cart_action · lookup_order · search_knowledge · request_human   email: Resend · SMS/WhatsApp: Twilio
      (Shopify Ajax cart = the real cart)     store: JSON files or Supabase · KB: kb/index.json (BM25)
```

## Quick start (local)
```bash
npm install
cp .env.example .env        # fill in: AI key, SHOPIFY_PUBLIC_URL, ALLOWED_ORIGINS (+ SESSION_SECRET, ADMIN_TOKEN)
npm run kb:build            # crawl the website into the knowledge base
npm run check               # PASS/FAIL for config, store, AI key, and operations
npm start
npm run chat -- "show me ASUS laptops under 600"   # terminal test of the full flow
```
Widget test page: create `widget/test.html` containing `<script src="/widget/ls-chat.js" defer></script>` and open
`http://localhost:3000/widget/test.html` (add `http://localhost:3000` to `ALLOWED_ORIGINS`). Add to cart only works on the store's own domain.

**Try the cart flow on localhost (simulated):** set `DEV_MOCK_CART=1` in `.env`, restart, and open `http://localhost:3000/dev`. It is a local simulation of a Shopify store
(product pages, `/cart.js`, `/cart/add.js`, a checkout page), built from your real catalogue. Open any product: the chat greets you with that product, and Add to cart, quantities and the checkout
hand-over all work. It proves the widget's behaviour; it does not prove Shopify itself accepts the request, so still run the live-store test below before going live.

**Test on the live store without touching the theme:** run `cloudflared tunnel --url http://localhost:3000`, open a product page in
an incognito window, and paste into the browser console (Chrome asks you to type `allow pasting` first):
```js
var s=document.createElement('script');s.src='https://YOUR-TUNNEL.trycloudflare.com/widget/ls-chat.js';
s.dataset.productHandle=(location.pathname.split('/products/')[1]||'').split('?')[0];document.body.appendChild(s);
```

## Install on the store
Save `shopify/ls-chat.liquid` as `snippets/ls-chat.liquid` (replace `YOUR-API-HOST`) and add `{% render 'ls-chat' %}` before `</body>` in `layout/theme.liquid`.
Remove any old chat snippet (e.g. Convocore) so there are not two bubbles. Script options: `data-accent`, `data-title`, `data-logo`, `data-greeting`, `data-support-url`.
Test in a **duplicate theme** first.

## Features and where to configure them
| Feature | How it works | Configure |
| --- | --- | --- |
| Product finder | Live catalogue, filters for budget, RAM, storage, screen, OS, condition; sold-out hidden | `SHOPIFY_PUBLIC_URL` or `SHOPIFY_STOREFRONT_TOKEN` |
| Cards / carousel | Swipeable cards with spec chips, grade badge, variant picker | automatic |
| Cart and checkout | Shopify's own cart on the store domain; Buy now goes to `/checkout` | automatic |
| Condition grade | From `CONDITION_METAFIELD`, variant option "Condition"/"Grade", tags (`Grade A`, `Refurbished`…), title, description | `CONDITION_METAFIELD`; ask the client where grades live |
| Add-on suggestions | After the first laptop is added (once per session) the widget shows in-stock add-ons | `ADDON_TYPES`, `ADDON_TAGS`, `ADDON_PRIORITY` |
| Knowledge base | Website pages + policies + `kb/files/*` + curated `kb/faq.md`, searched with BM25 | `npm run kb:build`, `KB_REFRESH_HOURS` |
| Order status | Order number + matching email, DPD tracking link; 5 wrong tries lock an order for an hour | `SHOPIFY_CLIENT_ID/SECRET` (or `SHOPIFY_ADMIN_TOKEN`) |
| Hand-over / leads | Inline form with consent, emailed with transcript, saved to the dashboard; out-of-hours wording | `SUPPORT_HOURS`, `SUPPORT_EMAIL`, `RESEND_API_KEY`, `HANDOFF_WEBHOOK_URL` |
| Logging and analytics | Chats, tool use, add-to-cart/buy/checkout clicks, leads; retention job; delete by email | `RETENTION_DAYS`, `/admin` |
| Abandoned cart | Off by default; see below | `ABANDON_ENABLED=1` plus Twilio settings |

### Knowledge base
1. `npm run kb:build` reads the sitemap (pages, blogs), the Shopify policy pages and `KB_EXTRA_URLS`, plus any `.md/.txt/.html` (and `.pdf` if `pdftotext` is installed) in `kb/files`.
2. Open `kb/faq.md` and replace **every** `<<CONFIRM: ...>>` with the real policy. Entries that still contain the marker are skipped, so the assistant never states an unconfirmed policy. Answers here also power the instant FAQ chips.
3. The server re-crawls every `KB_REFRESH_HOURS`; `/admin` → Tools has a "Re-crawl now" button.

### Admin dashboard
Set `ADMIN_TOKEN`, open `https://YOUR-HOST/admin`, sign in with the token. Overview (conversations, leads, add-to-cart, errors), Leads (+ CSV), Conversations (transcripts), Tools (re-crawl KB, delete a person's data).

### Order lookup credentials
Create an app in the Shopify **Dev Dashboard**, install it on the store, grant `read_orders` (plus `read_all_orders` for orders older than 60 days) and complete the protected-customer-data request.
Put the client ID and secret in `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`; the server fetches and refreshes the short-lived token itself.

### Abandoned-cart WhatsApp / SMS (optional, off by default)
1. Deploy first (you need an https `PUBLIC_BASE_URL`). Set `SHOPIFY_WEBHOOK_SECRET` (or the client secret).
2. `npm run webhooks:register` creates the Shopify webhooks (checkout create/update, order create).
3. Set Twilio details and `MESSAGING_PROVIDER`. Business-initiated WhatsApp messages need an approved template (`TWILIO_CONTENT_SID`). Keep `MESSAGING_PROVIDER=log` for a dry run first.
4. Point Twilio's inbound webhook at `PUBLIC_BASE_URL/webhooks/twilio/inbound` so STOP replies are honoured.
5. Set `ABANDON_ENABLED=1`. Messages go only to people with SMS marketing consent (`ABANDON_CONSENT_MODE=sms`), after `ABANDON_DELAY_MIN`, inside `ABANDON_WINDOW`, once per `ABANDON_COOLDOWN_DAYS`, never after an order.
6. Use `LOG_WEBHOOKS=1` temporarily to confirm Shopify's payload fields (consent flags) match what the code expects.

## Deploy
Any host with long-lived HTTP responses: Render (`render.yaml`), Railway, Fly.io, or `docker build .`. Set the environment variables there. A host with an ephemeral disk loses `data/` on redeploy:
attach a persistent disk and set `DATA_DIR`, or use Supabase (`docs/supabase.sql`, then `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`). Set `SESSION_SECRET` and `ADMIN_TOKEN`. Run `npm run check` against the production settings.

## Runbook
- **Daily:** glance at `/admin` Overview (errors, AI messages today vs cap, out-of-hours leads).
- **Weekly:** read a sample of Conversations; add any recurring unanswered question to `kb/faq.md`.
- **When policies change:** edit the site page, then Re-crawl; update `kb/faq.md` if it covers the same topic.
- **After any change:** `npm test` (must show 0 FAIL).
- **If answers go wrong:** `npm run check`; then `npm run chat -- "..."` to reproduce; check the server log.
- **If the model is retired:** change `OPENAI_MODEL` (or `ANTHROPIC_MODEL`) and run `npm run check`.
- **Privacy requests:** `/admin` → Tools → delete by email. Review `RETENTION_DAYS`, the privacy notice and your data-processing agreement with the AI provider.

## Tests
`npm test` runs the real server, tools and widget against simulated Shopify, AI, email, Twilio and database services (no keys needed) and prints PASS / FAIL / GAP / INFO.
Results are saved to `tests/audit-results.json`. It proves the logic and plumbing; it cannot prove behaviour on your real store, real order data, real WhatsApp delivery or answer quality. Use the manual test plan for those.

## Known limits
- Public-catalogue mode is cached (120 s), has yes/no stock, and Shopify may rate-limit it (HTTP 429). Use the Storefront token (Headless app) for production.
- Cart actions work only on the store's own domain; checkout is Shopify's hosted page (it cannot be embedded in chat).
- Hand-over is "request a person" by email plus out-of-hours capture; there is no live agent inbox.
- Session tokens deter casual abuse; they are not strong authentication. Rate limits and the daily cap are in memory (single instance).
- Not verified against live services: Storefront-API mode, the Dev Dashboard token request, Shopify webhook payload fields, Twilio and Resend delivery, Supabase.
