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
const TOKEN = process.env.META_API_TOKEN;                // AANGEPAST: was METAAPI_TOKEN
const REGION = process.env.METAAPI_REGION || 'london';   // 'london'
const STRATEGY = process.env.PROVIDER_STRATEGY_ID || '3DvG';

if (!TOKEN) {
  console.warn('⚠️  META_API_TOKEN is missing. Set it in your hosting env.');
}

// SSL certificaat fix voor Vercel
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Health + token test
app.get('/api/health', async (_, res) => {
  const tokenValid = await testMetaApiToken();
  return res.json({ 
    ok: true, 
    tokenValid,
    region: REGION,
    hasToken: !!TOKEN 
  });
});

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
    // DIRECT API CALL - ZONDER v1
    const createAccountResponse = await fetch(`https://mt-provisioning-api-london.agiliumtrade.ai/users/current/accounts`, {
      method: 'POST',
      headers: {
        'auth-token': TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: `${login}@${brokerServer}`,
        type: 'cloud',
        region: REGION,
        platform: 'mt5',
        server: brokerServer,
        login: login.toString(),
        password,
        application: 'CopyFactory'
      })
    });

    if (!createAccountResponse.ok) {
      const errorText = await createAccountResponse.text();
      throw new Error(`Create account failed: ${createAccountResponse.status} - ${errorText}`);
    }

    const accountData = await createAccountResponse.json();
    const accountId = accountData.id;

    // Deploy account - ZONDER v1
    const deployResponse = await fetch(`https://mt-provisioning-api-london.agiliumtrade.ai/users/current/accounts/${accountId}/deploy`, {
      method: 'POST',
      headers: {
        'auth-token': TOKEN,
        'Content-Type': 'application/json'
      }
    });

    if (!deployResponse.ok) {
      const errorText = await deployResponse.text();
      throw new Error(`Deploy failed: ${deployResponse.status} - ${errorText}`);
    }

    if (dryRun) {
      // Test verbinding: opruimen na succesvolle check - ZONDER v1
      await fetch(`https://mt-provisioning-api-london.agiliumtrade.ai/users/current/accounts/${accountId}`, {
        method: 'DELETE',
        headers: {
          'auth-token': TOKEN,
          'Content-Type': 'application/json'
        }
      });
      return res.json({ ok:true, dryRun:true });
    }

    return res.json({ ok:true, accountId, region: REGION });
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    console.error('Link account error:', message);
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
  if (!TOKEN) return res.status(500).json({ ok:false, error:'META_API_TOKEN missing' });

  try {
    const api = new MetaApi(TOKEN, { domain: `${REGION}.agiliumtrade.ai` });
    const account = await api.metatraderAccountApi.getAccount(id);
    
    // AANGEPAST: Check account status eerst
    if (account.state !== 'DEPLOYED') {
      return res.status(400).json({ ok:false, error:'Account not deployed' });
    }
    
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
    console.error('Account metrics error:', err); // AANGEPAST: logging toegevoegd
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
  if (!TOKEN) return res.status(500).json({ ok:false, error:'META_API_TOKEN missing' });

  try {
    // AANGEPAST: Correcte domain format voor CopyFactory
    const cf = new CopyFactory(TOKEN, { domain: `${REGION}.agiliumtrade.ai` });

    // 1) Zorg dat er een subscriber is (per SDK-versie kan dit iets verschillen)
    let subscriberExists = false;
    try {
      await cf.subscriberApi.getSubscriber(accountId);
      subscriberExists = true;
    } catch (_) {
      console.log('Subscriber does not exist, creating new one');
    }

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
      // AANGEPAST: Modernere syntax voor risk scaling
      tradeSizeScaling: {
        mode: 'balance',
        baseBalance: 1000,
        targetBalance: multiplier * 1000
      }
    }]);

    // 3) Mirror open trades
    if (mirrorOpenTrades) {
      await cf.subscriberApi.resynchronize(accountId);
    }

    return res.json({ ok:true, subscriberId: accountId, strategyId: STRATEGY, multiplier, mirrored: mirrorOpenTrades });
  } catch (err) {
    console.error('Copy link error:', err); // AANGEPAST: logging toegevoegd
    return res.status(400).json({ ok:false, error: String(err && err.message ? err.message : err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Node MetaApi service running on :${PORT}`));
