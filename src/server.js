// Laad .env variabelen
require('dotenv').config();

// Node API-service die MetaApi aanroept met de officiële SDK.
// Endpoints:
//  - POST /api/link-account        { brokerServer, login, password, dryRun? }
//  - GET  /api/account-metrics?id=<metaapiAccountId>
//  - POST /api/create-copy-link    { accountId, multiplier?, mirrorOpenTrades? }
//  - GET  /api/health

const express = require('express');
const MetaApiSdk = require('metaapi.cloud-sdk');
const MetaApi = MetaApiSdk.default;
const { CopyFactory } = MetaApiSdk;

const app = express();
app.use(express.json());

// === ENV ===
const TOKEN = process.env.METAAPI_TOKEN;                 // Vereist
const REGION = process.env.METAAPI_REGION || 'london';   // 'london'
const STRATEGY = process.env.PROVIDER_STRATEGY_ID || '3DvG';

if (!TOKEN) {
  console.warn('⚠️  METAAPI_TOKEN is missing. Set it in your hosting env.');
}

// Health
app.get('/api/health', (_, res) => res.json({ ok: true }));

/**
 * POST /api/link-account
 * Body: { brokerServer, login, password, dryRun?: boolean }
 * Doel: MT5-account provisionen bij MetaApi (create -> deploy -> wachten tot CONNECTED).
 */
app.post('/api/link-account', async (req, res) => {
  const { brokerServer, login, password, dryRun } = req.body || {};
  if (!brokerServer || !login || !password) {
    return res.status(400).json({ ok:false, error:'Missing fields: brokerServer, login, password' });
  }
  if (!TOKEN) return res.status(500).json({ ok:false, error:'METAAPI_TOKEN missing' });

  try {
    const api = new MetaApi(TOKEN, { domain: `${REGION}.agiliumtrade.ai` });

    // 1) Create account (application=CopyFactory i.v.m. copytrading)
    const account = await api.metatraderAccountApi.createAccount({
      name: `${login}@NAGA`,
      type: 'cloud',
      region: REGION,
      platform: 'mt5',
      server: brokerServer,   // "NagaMarkets-Demo" of "NagaMarkets-Live"
      login,
      password,               // MASTER password (géén investor)
      application: 'CopyFactory'
    });

    // 2) Deploy & wachten tot CONNECTED
    await account.deploy();
    await account.waitConnected(); // wacht totdat state=DEPLOYED & connectionStatus=CONNECTED

    if (dryRun) {
      // Test verbinding: opruimen na succesvolle check
      await account.remove();
      return res.json({ ok:true, dryRun:true });
    }

    return res.json({ ok:true, accountId: account.id, region: REGION });
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    return res.status(400).json({ ok:false, error: message });
  }
});

/**
 * GET /api/account-metrics?id=<metaapiAccountId>
 * Haalt snapshot op: balance, equity, positions count, etc.
 */
app.get('/api/account-metrics', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ ok:false, error:'Missing id' });
  if (!TOKEN) return res.status(500).json({ ok:false, error:'METAAPI_TOKEN missing' });

  try {
    const api = new MetaApi(TOKEN, { domain: `${REGION}.agiliumtrade.ai` });
    const account = await api.metatraderAccountApi.getAccount(id);
    await account.waitConnected();

    const info = await account.getAccountInformation();
    const positions = await account.getPositions();
    const orders = await account.getOrders();

    return res.json({
      ok: true,
      info,
      counts: { positions: positions?.length || 0, orders: orders?.length || 0 }
    });
  } catch (err) {
    return res.status(400).json({ ok:false, error: String(err && err.message ? err.message : err) });
  }
});

/**
 * POST /api/create-copy-link
 * Body: { accountId, multiplier?: number, mirrorOpenTrades?: boolean }
 * Abonneer account op strategie STRATEGY met scale-by-equity; spiegel open posities.
 */
app.post('/api/create-copy-link', async (req, res) => {
  const { accountId, multiplier = 1.0, mirrorOpenTrades = true } = req.body || {};
  if (!accountId) return res.status(400).json({ ok:false, error:'Missing accountId' });
  if (!TOKEN) return res.status(500).json({ ok:false, error:'METAAPI_TOKEN missing' });

  try {
    const cf = new CopyFactory(TOKEN);

    // 1) Zorg dat er een subscriber is (per SDK-versie kan dit iets verschillen)
    let subscriberExists = false;
    try {
      await cf.subscriberApi.getSubscriber(accountId);
      subscriberExists = true;
    } catch (_) {}

    if (!subscriberExists) {
      await cf.subscriberApi.createSubscriber({
        id: accountId,
        name: `${accountId}-subscriber`,
        accounts: [{ id: accountId }]
      });
    } else {
      await cf.subscriberApi.updateSubscriber(accountId, {
        name: `${accountId}-subscriber`,
        accounts: [{ id: accountId }]
      });
    }

    // 2) Subscription instellen naar onze strategie met scale-by-equity
    await cf.subscriberApi.updateSubscriptions(accountId, [{
      strategyId: STRATEGY,
      // Let op: afhankelijk van SDK-versie kan dit 'risk' of 'tradeSizeScaling' heten.
      // Dit werkt vaak zo:
      risk: { riskType: 'equity', value: multiplier }
    }]);

    // 3) Mirror open trades
    if (mirrorOpenTrades) {
      await cf.subscriberApi.resynchronize(accountId);
    }

    return res.json({ ok:true, subscriberId: accountId, strategyId: STRATEGY, multiplier, mirrored: mirrorOpenTrades });
  } catch (err) {
    return res.status(400).json({ ok:false, error: String(err && err.message ? err.message : err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Node MetaApi service running on :${PORT}`));
