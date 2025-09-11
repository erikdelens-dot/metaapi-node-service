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
const TOKEN = process.env.METAAPI_TOKEN;
const REGION = process.env.METAAPI_REGION || 'london';
const STRATEGY = process.env.PROVIDER_STRATEGY_ID || '3DvG';

if (!TOKEN) {
  console.warn('⚠️  METAAPI_TOKEN is missing. Set it in your hosting env.');
}

// SSL certificaat fix voor Vercel
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// EXTRA TLS FIXES voor Node.js fetch
const https = require('https');
const originalFetch = global.fetch;
global.fetch = (url, options = {}) => {
  if (url.includes('agiliumtrade.ai')) {
    options.agent = new https.Agent({
      rejectUnauthorized: false
    });
  }
  return originalFetch(url, options);
};

// Token validatie functie met CORRECTE URL
async function testMetaApiToken() {
  if (!TOKEN) return false;
  
  try {
    const response = await fetch(`https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts`, {
      method: 'GET',
      headers: {
        'auth-token': TOKEN,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('MetaApi token test response:', response.status);
    return response.status !== 401 && response.status !== 403;
  } catch (err) {
    console.error('MetaApi token test failed:', err.message);
    return false;
  }
}

// Test token bij startup
testMetaApiToken().then(valid => {
  if (valid) {
    console.log('✅ MetaApi token is valid');
  } else {
    console.log('❌ MetaApi token is invalid or missing');
  }
});

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
    // DIRECT API CALL met CORRECTE URL en vereiste velden
    const createAccountResponse = await fetch(`https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts`, {
      method: 'POST',
      headers: {
        'auth-token': TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: `${login}@${brokerServer}`,
        type: 'cloud',
        region: 'london',
        platform: 'mt5',
        server: brokerServer,
        login: login.toString(),
        password,
        application: 'CopyFactory',
        magic: Math.floor(Math.random() * 1000000), // Vereist veld volgens docs
        keywords: [] // Optioneel maar soms vereist
      })
    });

    if (!createAccountResponse.ok) {
      const errorText = await createAccountResponse.text();
      throw new Error(`Create account failed: ${createAccountResponse.status} - ${errorText}`);
    }

    const accountData = await createAccountResponse.json();
    const accountId = accountData.id;

    // Deploy account met CORRECTE URL
    const deployResponse = await fetch(`https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${accountId}/deploy`, {
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
      // Test verbinding: opruimen na succesvolle check met CORRECTE URL
      await fetch(`https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${accountId}`, {
        method: 'DELETE',
        headers: {
          'auth-token': TOKEN,
          'Content-Type': 'application/json'
        }
      });
      return res.json({ ok:true, dryRun:true });
    }

    return res.json({ ok:true, accountId, region: 'london' });
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
  if (!TOKEN) return res.status(500).json({ ok:false, error:'METAAPI_TOKEN missing' });

  try {
    // SDK met CORRECTE domain
    const api = new MetaApi(TOKEN, { domain: `agiliumtrade.agiliumtrade.ai` });
    const account = await api.metatraderAccountApi.getAccount(id);
    
    console.log('Account state:', account.state);
    console.log('Account connection status:', account.connectionStatus);
    
    if (account.state !== 'DEPLOYED') {
      return res.status(400).json({ 
        ok:false, 
        error:'Account not deployed', 
        state: account.state,
        connectionStatus: account.connectionStatus 
      });
    }
    
    // Wacht op verbinding met timeout
    try {
      await Promise.race([
        account.waitConnected(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 30000))
      ]);
    } catch (timeoutErr) {
      return res.status(400).json({ 
        ok:false, 
        error: 'Account connection timeout. Try again in a few minutes.',
        state: account.state,
        connectionStatus: account.connectionStatus 
      });
    }

    // Check of methods bestaan voordat je ze aanroept
    if (!account.getAccountInformation || typeof account.getAccountInformation !== 'function') {
      return res.status(400).json({ 
        ok:false, 
        error: 'Account methods not available. Account may still be starting up.',
        accountId: id,
        state: account.state,
        connectionStatus: account.connectionStatus,
        suggestion: 'Wait a few minutes and try again'
      });
    }

    // Probeer account informatie op te halen
    let info, positions, orders;
    
    try {
      info = await account.getAccountInformation();
    } catch (infoErr) {
      console.error('Failed to get account info:', infoErr);
      return res.status(400).json({ 
        ok:false, 
        error: 'Failed to retrieve account information',
        details: infoErr.message,
        suggestion: 'Account may still be connecting. Try again in a few minutes.'
      });
    }

    try {
      positions = await account.getPositions();
      orders = await account.getOrders();
    } catch (posErr) {
      console.warn('Failed to get positions/orders:', posErr);
      // Continue zonder positions/orders als dat faalt
      positions = [];
      orders = [];
    }

    return res.json({
      ok: true,
      info,
      counts: { 
        positions: positions?.length || 0, 
        orders: orders?.length || 0 
      },
      accountState: account.state,
      connectionStatus: account.connectionStatus
    });
  } catch (err) {
    console.error('Account metrics error:', err);
    return res.status(400).json({ 
      ok:false, 
      error: String(err && err.message ? err.message : err),
      details: err.name || 'Unknown error',
      suggestion: 'If account was just created, wait a few minutes for it to fully initialize'
    });
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
    // CopyFactory met CORRECTE domain
    const cf = new CopyFactory(TOKEN, { domain: `agiliumtrade.agiliumtrade.ai` });

    // 1) Zorg dat er een subscriber is
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

    // 2) Subscription instellen naar onze strategie
    await cf.subscriberApi.updateSubscriptions(accountId, [{
      strategyId: STRATEGY,
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
    console.error('Copy link error:', err);
    return res.status(400).json({ ok:false, error: String(err && err.message ? err.message : err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Node MetaApi service running on :${PORT}`));
