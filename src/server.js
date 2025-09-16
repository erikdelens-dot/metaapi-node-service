
/**
 * server.js — Complete MetaApi + CopyFactory service met statistieken en positie management
 *
 * Endpoints:
 *  - GET  /api/health
 *  - POST /api/link-account
 *  - GET  /api/account-metrics?id=<metaapiAccountId>
 *  - GET  /api/account-statistics?id=<metaapiAccountId>  [NIEUW]
 *  - POST /api/copy/enable-subscriber
 *  - POST /api/subscriber/configure
 *  - POST /api/strategy/create
 *  - POST /api/copy/start
 *  - POST /api/copy/stop                  [UITGEBREID met positie sluiting]
 *  - GET  /api/copy/diagnose
 *  - POST /api/positions/close-all        [NIEUW]
 */

const express = require('express');
const MetaApiSdk = require('metaapi.cloud-sdk');
const MetaApi = MetaApiSdk.default;

// === ENV / CONSTANTS ===
const TOKEN   = process.env.METAAPI_TOKEN || '';
const REGION  = process.env.METAAPI_REGION || 'london';
const STRAT   = process.env.PROVIDER_STRATEGY_ID || '3DvG';
const PROV    = `https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai`;
const CLIENT  = `https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai`;
const CF      = `https://copyfactory-api-v1.london.agiliumtrade.ai`;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY || '';

if (!TOKEN) console.warn('⚠️  METAAPI_TOKEN ontbreekt — voeg die toe in je env.');

// SSL certificaat fix
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

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-internal-key');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Internal key protection
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

async function resolveStrategyId(strategyMaybe) {
  let r = await fetch(`${CF}/users/current/configuration/strategies/${encodeURIComponent(strategyMaybe)}`, { headers: h() });
  if (r.ok) return strategyMaybe;

  const list = await fetch(`${CF}/users/current/configuration/strategies`, { headers: h() }).then(x => x.json());
  const items = Array.isArray(list) ? list : [];
  const hit = items.find(s => s._id === strategyMaybe || s.name === strategyMaybe || s.code === strategyMaybe);
  if (!hit) {
    throw new Error(`Strategy not found for '${strategyMaybe}'. Maak/zoek de strategy in CopyFactory en gebruik de _id.`);
  }
  return hit._id;
}

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

// ---------- NIEUW: Functie om alle posities te sluiten ----------
async function closeAllPositions(accountId) {
  try {
    const api = new MetaApi(TOKEN, { domain: `agiliumtrade.ai` });
    const account = await api.metatraderAccountApi.getAccount(accountId);
    
    // Wacht tot account verbonden is
    await Promise.race([
      account.waitConnected(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timeout')), 30000))
    ]);

    // Haal alle open posities op
    const positions = await account.getPositions();
    
    if (positions.length === 0) {
      return { ok: true, closedCount: 0, message: 'Geen open posities gevonden' };
    }

    // Sluit alle posities
    const closeResults = [];
    for (const position of positions) {
      try {
        const result = await account.closePosition(position.id);
        closeResults.push({ success: true, positionId: position.id, symbol: position.symbol });
      } catch (err) {
        closeResults.push({ success: false, positionId: position.id, error: err.message });
      }
    }

    const successCount = closeResults.filter(r => r.success).length;
    
    return {
      ok: true,
      closedCount: successCount,
      totalPositions: positions.length,
      results: closeResults
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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

// ---------- Link account ----------

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
    const createBody = {
      name: `${login}@${brokerServer}`,
      type: 'cloud',
      region,
      platform,
      server: brokerServer,
      login: login.toString(),
      password,
      application,
      baseCurrency,
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

    if (copyFactoryRoles?.length) {
      const enable = await fetch(`${PROV}/users/current/accounts/${id}/enable-copy-factory-api`, {
        method: 'POST', headers: h(),
        body: JSON.stringify({ copyFactoryRoles, copyFactoryResourceSlots: 1 })
      });
      if (!enable.ok) {
        console.warn('enable-copy-factory-api failed:', await enable.text());
      }
    }

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

    const wait = await waitAccountConnected(id, 90000);
    if (!wait.ok) {
      return res.status(400).json({ ok: false, step: 'poll', ...wait, accountId: id });
    }

    // Enable MetaStats voor statistieken
    try {
      const enableStats = await fetch(`${PROV}/users/current/accounts/${id}/enable-account-features`, {
        method: 'POST', 
        headers: h(),
        body: JSON.stringify({ 
          metastatsApiEnabled: true 
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

// ---------- Account metrics ----------

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
      positions,
      counts: { positions: positions.length, orders: orders.length },
      accountState: account.state,
      connectionStatus: account.connectionStatus
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- NIEUW: Account statistieken endpoint ----------
app.get('/api/account-statistics', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });
  if (!TOKEN) return res.status(500).json({ ok: false, error: 'METAAPI_TOKEN missing' });

  try {
    // Gebruik de directe MetaStats API endpoint
    const metricsResponse = await fetch(`${PROV}/users/current/accounts/${id}/metrics`, {
      headers: h()
    });

    if (metricsResponse.ok) {
      const metrics = await metricsResponse.json();
      
      // Bereken rendement percentages
      const dailyGrowth = metrics.dailyGrowth || 0;
      const monthlyGrowth = metrics.monthlyGrowth || 0;
      const totalGrowth = metrics.gain || 0;

      res.json({
        ok: true,
        statistics: {
          balance: metrics.balance || 0,
          equity: metrics.equity || 0,
          profit: metrics.profit || 0,
          dailyGrowth: dailyGrowth,
          monthlyGrowth: monthlyGrowth,
          totalGrowth: totalGrowth,
          deposits: metrics.deposits || 0,
          withdrawals: metrics.withdrawals || 0,
          totalTrades: metrics.trades || 0,
          wonTrades: metrics.wonTrades || 0,
          lostTrades: metrics.lostTrades || 0,
          winRate: metrics.wonTrades && metrics.trades ? 
            ((metrics.wonTrades / metrics.trades) * 100).toFixed(2) : 0,
          averageWin: metrics.averageWin || 0,
          averageLoss: metrics.averageLoss || 0,
          bestTrade: metrics.bestTrade || 0,
          worstTrade: metrics.worstTrade || 0,
          maxDrawdown: metrics.absoluteDrawdown || 0,
          riskRewardRatio: metrics.averageWin && metrics.averageLoss ? 
            (Math.abs(metrics.averageWin / metrics.averageLoss)).toFixed(2) : 0
        }
      });
    } else {
      // Als MetaStats niet beschikbaar is, val terug op basis account info
      const api = new MetaApi(TOKEN, { domain: `agiliumtrade.ai` });
      const account = await api.metatraderAccountApi.getAccount(id);
      
      await Promise.race([
        account.waitConnected(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timeout')), 15000))
      ]);

      const info = await account.getAccountInformation();
      
      res.json({
        ok: true,
        statistics: {
          balance: info.balance || 0,
          equity: info.equity || 0,
          profit: (info.equity - info.balance) || 0,
          margin: info.margin || 0,
          freeMargin: info.freeMargin || 0,
          marginLevel: info.marginLevel || 0,
          dailyGrowth: 0,
          monthlyGrowth: 0,
          totalGrowth: 0,
          message: 'MetaStats wordt geactiveerd, statistieken komen beschikbaar na eerste trades'
        }
      });
    }
  } catch (e) {
    // Fallback naar basis account info
    try {
      const api = new MetaApi(TOKEN, { domain: `agiliumtrade.ai` });
      const account = await api.metatraderAccountApi.getAccount(id);
      
      await Promise.race([
        account.waitConnected(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timeout')), 15000))
      ]);

      const info = await account.getAccountInformation();
      
      res.json({
        ok: true,
        statistics: {
          balance: info.balance || 0,
          equity: info.equity || 0,
          profit: (info.equity - info.balance) || 0,
          margin: info.margin || 0,
          freeMargin: info.freeMargin || 0,
          marginLevel: info.marginLevel || 0,
          dailyGrowth: 0,
          monthlyGrowth: 0,
          totalGrowth: 0,
          totalTrades: 0,
          winRate: 0,
          maxDrawdown: 0,
          riskRewardRatio: 0,
          message: 'Uitgebreide statistieken worden verzameld...'
        }
      });
    } catch (fallbackError) {
      res.status(400).json({ 
        ok: false, 
        error: 'Statistieken tijdelijk niet beschikbaar',
        details: e.message 
      });
    }
  }
});

// ---------- Enable subscriber ----------

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

// ---------- Strategy create ----------

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

// ---------- Subscriber configure ----------

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

// ---------- Copy start ----------

app.post('/api/copy/start', async (req, res) => {
  const { accountId, multiplier = 1.0, mirrorOpenTrades = true, strategy } = req.body || {};
  if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

  try {
    await ensureSubscriberRole(accountId);

    const strategyHint = strategy || STRAT;
    const strategyId = await resolveStrategyId(strategyHint);

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

// ---------- VERBETERD: Copy stop met positie sluiting ----------

app.post('/api/copy/stop', async (req, res) => {
  const { accountId, closePositions = true } = req.body || {};
  if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

  try {
    // 1. Stop eerst de copy trading
    const put = await fetch(`${CF}/users/current/configuration/subscribers/${accountId}`, {
      method: 'PUT', headers: h(),
      body: JSON.stringify({ name: `${accountId}-subscriber`, subscriptions: [] })
    });
    if (!put.ok) {
      return res.status(400).json({ ok: false, error: `unsubscribe failed: ${put.status} ${await put.text()}` });
    }

    // 2. Sluit alle open posities als gevraagd
    let closeResult = null;
    if (closePositions) {
      closeResult = await closeAllPositions(accountId);
    }

    res.json({ 
      ok: true, 
      copyingStopped: true,
      positionsClosed: closeResult
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- NIEUW: Endpoint om alleen posities te sluiten ----------
app.post('/api/positions/close-all', async (req, res) => {
  const { accountId } = req.body || {};
  if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

  try {
    const result = await closeAllPositions(accountId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- Diagnose ----------

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
