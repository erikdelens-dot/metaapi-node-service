/**
 * server.js — Complete MetaApi + CopyFactory service (Node/Express)
 *
 * Endpoints:
 *  - GET  /api/health
 *  - POST /api/link-account              { brokerServer, login, password, dryRun?, baseCurrency?, copyFactoryRoles?, platform?, region?, application? }
 *  - GET  /api/account-metrics?id=<metaapiAccountId>
 *  - POST /api/copy/enable-subscriber    { accountId }
 *  - POST /api/subscriber/configure      { accountId, strategyId, multiplier=1.0 }
 *  - POST /api/strategy/create           { name, accountId, description?, riskLimits? }
 *  - POST /api/copy/start                { accountId, multiplier=1.0, mirrorOpenTrades=true, strategy? }
 *  - POST /api/copy/stop                 { accountId }
 *  - GET  /api/copy/diagnose             ?accountId=...&strategy=...
 *
 * Node 18+ (fetch beschikbaar). Anders: npm i node-fetch en polyfill global.fetch.
 */

const express = require('express');
const MetaApiSdk = require('metaapi.cloud-sdk'); // npm i metaapi.cloud-sdk
const MetaApi = MetaApiSdk.default;

// === ENV / CONSTANTS ===
const TOKEN   = process.env.METAAPI_TOKEN || '';
const REGION  = process.env.METAAPI_REGION || 'london';
const STRAT   = process.env.PROVIDER_STRATEGY_ID || '3DvG'; // mag _id, name of code; we resolven naar _id
const PROV    = `https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai`;
const CLIENT  = `https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai`;
const CF      = `https://copyfactory-api-v1.london.agiliumtrade.ai`;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY || '';

// Waarschuwing als token ontbreekt
if (!TOKEN) console.warn('⚠️  METAAPI_TOKEN ontbreekt — voeg die toe in je env.');

// SSL certificaat fix voor Vercel (Agiliumtrade certs kunnen streng staan)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const https = require('https');
const originalFetch = global.fetch;
global.fetch = (url, options = {}) => {
  if (url.includes('agiliumtrade.ai')) {
    options.agent = new https.Agent({ rejectUnauthorized: false });
  }
  return originalFetch(url, options);
};

const app = express();
app.use(express.json());

// CORS middleware toevoegen
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-internal-key');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// (Optioneel) simpele header protectie voor alle POST routes
app.use((req, res, next) => {
  if (INTERNAL_KEY && req.method === 'POST') {
    const k = req.headers['x-internal-key'];
    if (k !== INTERNAL_KEY) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }
  next();
});

function h() {
  return { 'auth-token': TOKEN, 'Content-Type': 'application/json' };
}

// ---------- Helpers ----------

/** Wacht tot account DEPLOYED & CONNECTED is (maxWaitMs) */
async function waitAccountConnected(accountId, maxWaitMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const r = await fetch(`${PROV}/users/current/accounts/${accountId}`, { headers: h() });
    const j = await r.json();
    const state = j.state;
    const cs = j.connectionStatus;
    const err = j.errorCode;

    if (state === 'DEPLOYED' && cs === 'CONNECTED') return { ok: true, state, connectionStatus: cs };
    if (state === 'DEPLOY_FAILED' || err) return { ok: false, state, connectionStatus: cs, errorCode: err, raw: j };

    await new Promise(s => setTimeout(s, 2500));
  }
  return { ok: false, error: 'Timeout waiting for CONNECTED' };
}

/** Resolve echte strategyId (_id). STRAT kan _id, name of code zijn. */
async function resolveStrategyId(strategyMaybe) {
  // 1) Probeer direct als _id
  let r = await fetch(`${CF}/users/current/configuration/strategies/${encodeURIComponent(strategyMaybe)}`, { headers: h() });
  if (r.ok) return strategyMaybe;

  // 2) Zo niet: lijst ophalen en matchen op _id, name, code
  const list = await fetch(`${CF}/users/current/configuration/strategies`, { headers: h() }).then(x => x.json());
  const items = Array.isArray(list) ? list : [];
  const hit = items.find(s => s._id === strategyMaybe || s.name === strategyMaybe || s.code === strategyMaybe);
  if (!hit) {
    throw new Error(`Strategy not found for '${strategyMaybe}'. Maak/zoek de strategy in CopyFactory en gebruik de _id.`);
  }
  return hit._id;
}

/** Zorg dat account de SUBSCRIBER CopyFactory rol heeft */
async function ensureSubscriberRole(accountId) {
  const info = await fetch(`${PROV}/users/current/accounts/${accountId}`, { headers: h() }).then(r => r.json());
  if (info.copyFactoryRoles?.includes('SUBSCRIBER')) return true;

  const r = await fetch(`${PROV}/users/current/accounts/${accountId}/enable-copy-factory-api`, {
    method: 'POST', headers: h(),
    body: JSON.stringify({ copyFactoryRoles: ['SUBSCRIBER'], copyFactoryResourceSlots: 1 })
  });
  if (!r.ok) {
    throw new Error(`enable SUBSCRIBER failed: ${r.status} ${await r.text()}`);
  }
  await new Promise(s => setTimeout(s, 1500));
  return true;
}

// ---------- Health ----------

app.get('/api/health', async (_req, res) => {
  try {
    const r = await fetch(`${PROV}/users/current/accounts`, { headers: h() });
    res.json({ ok: r.ok, status: r.status, region: REGION, tokenPresent: !!TOKEN });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- Link account (create -> deploy -> poll) ----------

/**
 * Body: {
 *  brokerServer, login, password,
 *  dryRun?, baseCurrency?=EUR, copyFactoryRoles?, platform?=mt5, region?=london, application?=CopyFactory
 * }
 * Voorbeeld Provider (EUR):
 * {
 *   "brokerServer":"NagaMarkets-Live",
 *   "login":"8313355",
 *   "password":"***",
 *   "baseCurrency":"EUR",
 *   "copyFactoryRoles":["PROVIDER"]
 * }
 */
app.post('/api/link-account', async (req, res) => {
  const {
    brokerServer, login, password, dryRun,
    baseCurrency = 'EUR',
    copyFactoryRoles,
    platform = 'mt5',
    region = 'london',
    application = 'CopyFactory'
  } = req.body || {};

  if (!brokerServer || !login || !password) {
    return res.status(400).json({ ok: false, error: 'Missing fields: brokerServer, login, password' });
  }
  if (!TOKEN) return res.status(500).json({ ok: false, error: 'METAAPI_TOKEN missing' });

  try {
    // 1) Create (inclusief baseCurrency + roles indien meegegeven)
    const createBody = {
      name: `${login}@${brokerServer}`,
      type: 'cloud',
      region,
      platform,
      server: brokerServer,
      login: login.toString(),
      password,
      application,
      baseCurrency, // <<< BELANGRIJK: EUR instellen bij creatie
      magic: Math.floor(Math.random() * 1000000),
      keywords: [],
      ...(copyFactoryRoles ? { copyFactoryRoles } : {})
    };

    const create = await fetch(`${PROV}/users/current/accounts`, {
      method: 'POST', headers: h(), body: JSON.stringify(createBody)
    });
    if (!create.ok) {
      return res.status(400).json({ ok: false, step: 'create', status: create.status, error: await create.text() });
    }
    const acc = await create.json();
    const id = acc.id;

    // 1b) Als roles niet in create zaten, kun je nog enable doen (let op: baseCurrency is NIET achteraf wijzigbaar)
    if (copyFactoryRoles?.length) {
      const enable = await fetch(`${PROV}/users/current/accounts/${id}/enable-copy-factory-api`, {
        method: 'POST', headers: h(),
        body: JSON.stringify({ copyFactoryRoles, copyFactoryResourceSlots: 1 })
      });
      if (!enable.ok) {
        console.warn('enable-copy-factory-api failed:', await enable.text());
      }
    }

    // 2) Deploy
    const dep = await fetch(`${PROV}/users/current/accounts/${id}/deploy`, {
      method: 'POST', headers: h()
    });
    if (!dep.ok) {
      await fetch(`${PROV}/users/current/accounts/${id}`, { method: 'DELETE', headers: h() }).catch(() => {});
      return res.status(400).json({ ok: false, step: 'deploy', status: dep.status, error: await dep.text() });
    }

    if (dryRun) {
      await fetch(`${PROV}/users/current/accounts/${id}`, { method: 'DELETE', headers: h() }).catch(() => {});
      return res.json({ ok: true, dryRun: true });
    }

 // 3) Poll voor connection
    const wait = await waitAccountConnected(id, 90000);
    if (!wait.ok) {
      return res.status(400).json({ ok: false, step: 'poll', ...wait, accountId: id });
    }

    // VOEG DIT TOE - MetaStats activeren voor account metrics
    try {
      const enableStats = await fetch(`${PROV}/users/current/accounts/${id}/enable-risk-management-api`, {
        method: 'POST', 
        headers: h(),
        body: JSON.stringify({ 
          riskManagementApiEnabled: true 
        })
      });
      
      if (enableStats.ok) {
        console.log('MetaStats enabled for account:', id);
      } else {
        console.warn('MetaStats enable failed:', await enableStats.text());
      }
    } catch (e) {
      console.warn('MetaStats enable error:', e.message);
    }

    return res.json({ ok: true, accountId: id, region, connection: wait });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- Account metrics (via officiële SDK) ----------

/**
 * Query: ?id=<metaapiAccountId>
 */
app.get('/api/account-metrics', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });
  if (!TOKEN) return res.status(500).json({ ok: false, error: 'METAAPI_TOKEN missing' });

  try {
    const api = new MetaApi(TOKEN, { domain: `agiliumtrade.ai` });
    const account = await api.metatraderAccountApi.getAccount(id);

    const state = account.state;
    const cs = account.connectionStatus;
    if (state !== 'DEPLOYED') {
      return res.status(400).json({ ok: false, error: 'Account not deployed', state, connectionStatus: cs });
    }

    try {
      await Promise.race([
        account.waitConnected(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timeout')), 30000))
      ]);
    } catch (_e) {
      return res.status(400).json({ ok: false, error: 'Account connection timeout', state, connectionStatus: account.connectionStatus });
    }

    if (!account.getAccountInformation || typeof account.getAccountInformation !== 'function') {
      return res.status(400).json({
        ok: false,
        error: 'Account methods not available. Account may still be starting up.',
        accountId: id,
        state: account.state,
        connectionStatus: account.connectionStatus,
        suggestion: 'Try again shortly'
      });
    }

    let info, positions = [], orders = [];
    try { info = await account.getAccountInformation(); } catch (infoErr) {
      return res.status(400).json({
        ok: false,
        error: 'Failed to retrieve account information',
        details: infoErr.message
      });
    }
    try { positions = await account.getPositions(); } catch {}
    try { orders = await account.getOrders(); } catch {}

    res.json({
      ok: true,
      info,
      counts: { positions: positions.length, orders: orders.length },
      accountState: account.state,
      connectionStatus: account.connectionStatus
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- CopyFactory: enable SUBSCRIBER ----------

/**
 * Body: { accountId }
 */
app.post('/api/copy/enable-subscriber', async (req, res) => {
  const { accountId } = req.body || {};
  if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

  try {
    await ensureSubscriberRole(accountId);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- Strategy: create ----------

/**
 * Body: { name, accountId, description?, riskLimits? }
 */
app.post('/api/strategy/create', async (req, res) => {
  const { name, accountId, description = 'EUR provider strategy', riskLimits = { maxLeverage: 100 } } = req.body || {};
  if (!name || !accountId) return res.status(400).json({ ok: false, error: 'name and accountId are required' });

  try {
    const r = await fetch(`${CF}/users/current/configuration/strategies`, {
      method: 'POST',
      headers: h(),
      body: JSON.stringify({ name, description, accountId, riskLimits })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ ok: false, error: data });

    return res.json({ ok: true, strategy: data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- Subscriber: configure (equity scaling) ----------

/**
 * Body: { accountId, strategyId, multiplier=1.0 }
 * Maakt/overschrijft de subscriber-config voor dit account.
 */
app.post('/api/subscriber/configure', async (req, res) => {
  const { accountId, strategyId, multiplier = 1.0 } = req.body || {};
  if (!accountId || !strategyId) return res.status(400).json({ ok: false, error: 'accountId and strategyId required' });

  try {
    const put = await fetch(`${CF}/users/current/configuration/subscribers/${accountId}`, {
      method: 'PUT',
      headers: h(),
      body: JSON.stringify({
        name: `${accountId}-subscriber`,
        subscriptions: [
          {
            strategyId,
            tradeSizeScaling: { mode: 'equity' }
          }
        ]
      })
    });
    const data = await put.json().catch(() => ({}));
    if (!put.ok) return res.status(400).json({ ok: false, error: data });

    return res.json({ ok: true, config: data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- CopyFactory: start (kept for convenience; uses resolve + resync) ----------

/**
 * Body: { accountId, multiplier=1.0, mirrorOpenTrades=true, strategy? }
 */
app.post('/api/copy/start', async (req, res) => {
  const { accountId, multiplier = 1.0, mirrorOpenTrades = true, strategy } = req.body || {};
  if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

  try {
    // 1) zorg dat SUBSCRIBER rol aan staat
    await ensureSubscriberRole(accountId);

    // 2) resolve echte strategyId
    const strategyHint = strategy || STRAT;
    const strategyId = await resolveStrategyId(strategyHint);

    // 3) upsert subscriber config met equity scaling
    const put = await fetch(`${CF}/users/current/configuration/subscribers/${accountId}`, {
      method: 'PUT', headers: h(),
      body: JSON.stringify({
        name: `${accountId}-subscriber`,
        subscriptions: [{
          strategyId,
          tradeSizeScaling: { mode: 'equity' }
        }]
      })
    });
    if (!put.ok) {
      return res.status(400).json({ ok: false, error: `subscriber upsert failed: ${put.status} ${await put.text()}` });
    }

    // 4) spiegel open posities
    if (mirrorOpenTrades) {
      const rs = await fetch(`${CF}/users/current/subscribers/${accountId}/resynchronize`, {
        method: 'POST', headers: h()
      });
      if (!rs.ok) {
        return res.json({
          ok: true, strategyId, multiplier, mirrorOpenTrades,
          warning: `resync failed: ${rs.status} ${await rs.text()}`
        });
      }
    }

    res.json({ ok: true, strategyId, multiplier, mirrorOpenTrades });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- CopyFactory: stop (subscriptions leegmaken) ----------

/**
 * Body: { accountId }
 */
app.post('/api/copy/stop', async (req, res) => {
  const { accountId } = req.body || {};
  if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

  try {
    const put = await fetch(`${CF}/users/current/configuration/subscribers/${accountId}`, {
      method: 'PUT', headers: h(),
      body: JSON.stringify({ name: `${accountId}-subscriber`, subscriptions: [] })
    });
    if (!put.ok) {
      return res.status(400).json({ ok: false, error: `unsubscribe failed: ${put.status} ${await put.text()}` });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- Diagnose ----------

/**
 * Query: ?accountId=...&strategy=...
 * Laat zien: account state, roles, baseCurrency/broker currency/exchangeRate, strategy resolve, subscriber config.
 */
app.get('/api/copy/diagnose', async (req, res) => {
  const { accountId, strategy } = req.query || {};
  if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

  try {
    const accResp = await fetch(`${PROV}/users/current/accounts/${accountId}`, { headers: h() });
    const acc = await accResp.json();

    let strategyId = null, strategiesList = null, subscriberCfg = null;
    try {
      strategyId = await resolveStrategyId(strategy || STRAT);
    } catch (e) {
      const listResp = await fetch(`${CF}/users/current/configuration/strategies`, { headers: h() });
      strategiesList = listResp.ok ? await listResp.json() : { error: await listResp.text() };
    }

    const subResp = await fetch(`${CF}/users/current/configuration/subscribers/${accountId}`, { headers: h() });
    if (subResp.ok) subscriberCfg = await subResp.json();

    res.json({
      ok: true,
      account: {
        id: accountId,
        state: acc.state,
        connectionStatus: acc.connectionStatus,
        copyFactoryRoles: acc.copyFactoryRoles,
        baseCurrency: acc.baseCurrency,
        brokerAccountCurrency: acc.brokerAccountCurrency,
        accountCurrencyExchangeRate: acc.accountCurrencyExchangeRate
      },
      strategyHint: strategy || STRAT,
      strategyId,
      subscriberConfig: subscriberCfg || null,
      strategies: strategiesList || undefined
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- Boot ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ MetaApi service running on :${PORT} (region=${REGION})`);
});
