import { app, devCart, startBackground } from './app.js';
import { providerName, modelName, keyPresent } from './llm.js';
import * as sec from './security.js';
import { kbStats } from './kb/search.js';

startBackground();
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Laptop Station chat backend on :${port} (${providerName()} / ${modelName()})`);
  if (!keyPresent()) console.warn('WARNING: no API key for the selected provider. Run `npm run check`.');
  if (!sec.secretIsPersistent()) console.warn('WARNING: SESSION_SECRET not set: sessions reset on every restart. Set a long random value.');
  if (!process.env.ADMIN_TOKEN) console.warn('NOTE: ADMIN_TOKEN not set: the /admin dashboard is disabled.');
  if (!kbStats().chunks) console.warn('NOTE: knowledge base is empty (run `npm run kb:build`).');
  if (devCart) console.warn(`LOCAL TEST MODE: simulated Shopify cart is ON. Open http://localhost:${port}/dev to try the widget. Never enable this in production.`);
});
