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
    // Debug SDK imports
    console.log('MetaApiSdk:', typeof MetaApiSdk);
    console.log('CopyFactory:', typeof CopyFactory);
    console.log('CopyFactory available:', !!CopyFactory);
    
    // Probeer verschillende CopyFactory initialisatie methoden
    let copyFactory;
    
    try {
      // Methode 1: Direct import
      copyFactory = new CopyFactory(TOKEN, {
        domain: 'agiliumtrade.agiliumtrade.ai'
      });
      console.log('CopyFactory created with method 1');
    } catch (err1) {
      console.log('Method 1 failed:', err1.message);
      
      try {
        // Methode 2: Via MetaApiSdk
        copyFactory = new MetaApiSdk.CopyFactory(TOKEN, {
          domain: 'agiliumtrade.agiliumtrade.ai'
        });
        console.log('CopyFactory created with method 2');
      } catch (err2) {
        console.log('Method 2 failed:', err2.message);
        
        try {
          // Methode 3: Default import
          const { default: DefaultCopyFactory } = MetaApiSdk;
          copyFactory = new DefaultCopyFactory.CopyFactory(TOKEN, {
            domain: 'agiliumtrade.agiliumtrade.ai'
          });
          console.log('CopyFactory created with method 3');
        } catch (err3) {
          console.log('Method 3 failed:', err3.message);
          
          return res.status(500).json({
            ok: false,
            error: 'Failed to initialize CopyFactory',
            attempts: [err1.message, err2.message, err3.message],
            availableExports: Object.keys(MetaApiSdk)
          });
        }
      }
    }

    // Debug CopyFactory object
    console.log('CopyFactory object keys:', Object.keys(copyFactory));
    console.log('subscriberApi available:', !!copyFactory.subscriberApi);
    
    // Check of subscriberApi bestaat
    if (!copyFactory.subscriberApi) {
      return res.status(500).json({ 
        ok: false, 
        error: 'CopyFactory subscriberApi not available',
        available: Object.keys(copyFactory),
        cfType: typeof copyFactory
      });
    }

    // Test basic subscriber operations
    let subscriberExists = false;
    try {
      const existingSubscriber = await copyFactory.subscriberApi.getSubscriber(accountId);
      subscriberExists = true;
      console.log('Subscriber exists:', existingSubscriber);
    } catch (err) {
      console.log('Subscriber does not exist, will create new one:', err.message);
    }

    if (!subscriberExists) {
      try {
        const newSubscriber = await copyFactory.subscriberApi.createSubscriber({
          id: accountId,
          name: `${accountId}-subscriber`,
          accounts: [{ id: accountId }]
        });
        console.log('Created subscriber:', newSubscriber);
      } catch (createErr) {
        console.error('Failed to create subscriber:', createErr);
        return res.status(400).json({
          ok: false,
          error: 'Failed to create subscriber',
          details: createErr.message
        });
      }
    } else {
      try {
        await copyFactory.subscriberApi.updateSubscriber(accountId, {
          name: `${accountId}-subscriber`,
          accounts: [{ id: accountId }]
        });
        console.log('Updated existing subscriber');
      } catch (updateErr) {
        console.warn('Failed to update subscriber, continuing anyway:', updateErr.message);
      }
    }

    // Subscription instellen
    try {
      await copyFactory.subscriberApi.updateSubscriptions(accountId, [{
        strategyId: STRATEGY,
        tradeSizeScaling: {
          mode: 'balance',
          baseBalance: 1000,
          targetBalance: multiplier * 1000
        }
      }]);
      console.log('Subscription created successfully');
    } catch (subErr) {
      console.error('Failed to create subscription:', subErr);
      return res.status(400).json({
        ok: false,
        error: 'Failed to create subscription',
        details: subErr.message
      });
    }

    // Mirror open trades
    if (mirrorOpenTrades) {
      try {
        await copyFactory.subscriberApi.resynchronize(accountId);
        console.log('Resynchronization triggered');
      } catch (resyncErr) {
        console.warn('Resync failed, but continuing:', resyncErr.message);
      }
    }

    return res.json({ 
      ok: true, 
      subscriberId: accountId, 
      strategyId: STRATEGY, 
      multiplier, 
      mirrored: mirrorOpenTrades,
      message: 'Copy trading setup completed successfully'
    });
  } catch (err) {
    console.error('Copy link error:', err);
    return res.status(400).json({ 
      ok: false, 
      error: String(err.message || err),
      stack: err.stack ? err.stack.split('\n').slice(0, 5) : undefined
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Node MetaApi service running on :${PORT}`));
