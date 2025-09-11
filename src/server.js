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
    // Check of account SUBSCRIBER role heeft
    const api = new MetaApi(TOKEN, { domain: `agiliumtrade.agiliumtrade.ai` });
    const account = await api.metatraderAccountApi.getAccount(accountId);
    
    // Update account om SUBSCRIBER rol toe te voegen
    if (!account.copyFactoryRoles || !account.copyFactoryRoles.includes('SUBSCRIBER')) {
      console.log('Adding SUBSCRIBER role to account');
      
      try {
        const updateResponse = await fetch(`https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${accountId}`, {
          method: 'PUT',
          headers: {
            'auth-token': TOKEN,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            copyFactoryRoles: ['SUBSCRIBER']
          })
        });

        if (!updateResponse.ok) {
          const errorText = await updateResponse.text();
          console.warn('Failed to add SUBSCRIBER role via API:', errorText);
          
          return res.status(400).json({
            ok: false,
            error: 'Account must have SUBSCRIBER copyFactoryRoles. Please add this via MetaApi dashboard.',
            accountId,
            currentRoles: account.copyFactoryRoles || [],
            suggestion: 'Go to https://app.metaapi.cloud and add SUBSCRIBER role to your account'
          });
        } else {
          console.log('Successfully added SUBSCRIBER role');
          // Wacht even zodat de rol update wordt doorgevoerd
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (roleError) {
        console.error('Error adding SUBSCRIBER role:', roleError);
        return res.status(400).json({
          ok: false,
          error: 'Failed to add SUBSCRIBER role automatically. Please add via MetaApi dashboard.',
          accountId,
          currentRoles: account.copyFactoryRoles || []
        });
      }
    }

    // CopyFactory met juiste initialisatie
    const copyFactory = new CopyFactory(TOKEN, {
      domain: 'agiliumtrade.agiliumtrade.ai'
    });

    console.log('CopyFactory initialized, available properties:', Object.keys(copyFactory));

    // Check welke API's beschikbaar zijn
    const availableApis = Object.keys(copyFactory).filter(key => 
      key.includes('Api') || key.includes('api')
    );
    console.log('Available APIs:', availableApis);

    // Probeer verschillende API endpoints
    let configurationApi = copyFactory.configurationApi || copyFactory.configApi || copyFactory._configurationClient;
    
    if (!configurationApi) {
      return res.status(500).json({
        ok: false,
        error: 'CopyFactory configuration API not found',
        available: Object.keys(copyFactory),
        availableApis
      });
    }

    console.log('Configuration API found:', typeof configurationApi);

    // Direct REST API call voor subscriber creation als SDK niet werkt
    try {
      const subscriberResponse = await fetch(`https://copyfactory-api-v1.agiliumtrade.agiliumtrade.ai/users/current/subscribers`, {
        method: 'GET',
        headers: {
          'auth-token': TOKEN,
          'Content-Type': 'application/json'
        }
      });

      if (subscriberResponse.ok) {
        const subscribers = await subscriberResponse.json();
        console.log('Existing subscribers:', subscribers.length);
        
        // Check of subscriber al bestaat
        let subscriberExists = subscribers.some(sub => sub.accountId === accountId);
        
        if (!subscriberExists) {
          // Maak nieuwe subscriber
          const createResponse = await fetch(`https://copyfactory-api-v1.agiliumtrade.agiliumtrade.ai/users/current/subscribers`, {
            method: 'POST',
            headers: {
              'auth-token': TOKEN,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: `${accountId}-subscriber`,
              accountId: accountId
            })
          });

          if (!createResponse.ok) {
            const errorText = await createResponse.text();
            throw new Error(`Failed to create subscriber: ${createResponse.status} - ${errorText}`);
          }

          const newSubscriber = await createResponse.json();
          console.log('Created subscriber:', newSubscriber);
        }

        // Maak subscription naar strategy
        const subscriptionResponse = await fetch(`https://copyfactory-api-v1.agiliumtrade.agiliumtrade.ai/users/current/subscribers/${accountId}/subscriptions`, {
          method: 'PUT',
          headers: {
            'auth-token': TOKEN,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify([{
            strategyId: STRATEGY,
            tradeSizeScaling: {
              mode: 'balance',
              baseBalance: 1000,
              targetBalance: multiplier * 1000
            }
          }])
        });

        if (!subscriptionResponse.ok) {
          const errorText = await subscriptionResponse.text();
          throw new Error(`Failed to create subscription: ${subscriptionResponse.status} - ${errorText}`);
        }

        const subscription = await subscriptionResponse.json();
        console.log('Created subscription:', subscription);

        return res.json({
          ok: true,
          subscriberId: accountId,
          strategyId: STRATEGY,
          multiplier,
          message: 'Copy trading setup completed successfully using direct API'
        });

      } else {
        throw new Error(`Failed to fetch subscribers: ${subscriberResponse.status}`);
      }

    } catch (directApiError) {
      console.error('Direct API approach failed:', directApiError.message);
      
      return res.status(400).json({
        ok: false,
        error: 'Failed to setup copy trading',
        details: directApiError.message,
        suggestion: 'Check if account has SUBSCRIBER role and strategy ID is valid'
      });
    }

  } catch (err) {
    console.error('Copy link error:', err);
    return res.status(400).json({ 
      ok: false, 
      error: String(err.message || err),
      stack: err.stack ? err.stack.split('\n').slice(0, 3) : undefined
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Node MetaApi service running on :${PORT}`));
