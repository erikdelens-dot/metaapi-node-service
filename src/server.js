/**
 * server.js — Complete MetaApi + CopyFactory service (Node/Express)
 *
 * Endpoints:
 *  - GET  /api/health
 *  - POST /api/link-account              { brokerServer, login, password, dryRun? }
 *  - GET  /api/account-metrics?id=<metaapiAccountId>
 *  - POST /api/copy/enable-subscriber    { accountId }
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
const STRAT   = process.env.PROVIDER_STRATEGY_ID || '3DvG'; // mag naam/code/_id; we resolven naar _id
const PROV    = `https://mt-provisioning-api-v1.${REGION}.agiliumtrade.ai`;
const CLIENT  = `https://mt-client-api-v1.${REGION}.agiliumtrade.ai`;
const CF      = `https://copyfactory-api-v1.${REGION}.agiliumtrade.ai`;

if (!TOKEN) {
  console.warn('⚠️  METAAPI_TOKEN ontbreekt — voeg die toe in je env.');
}

const app = express();
app.use(express.json());

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

/** Resolves echte strategyId (_id). STRAT kan _id, name of code zijn. */
async function resolveStrategyId(strategyMaybe) {
  // 1) Probeer direct als _id
  let r = await fetch(`${CF}/users/current/configuration/strategies/${encodeURIComponent(strategyMaybe)}`, { headers: h() });
  if (r.ok) return strategyMaybe;

  // 2) Zo niet: lijst ophalen en matchen op _id, name, code
  const list = await fetch(`${CF}/users/current/configuration/strategies`, { headers: h() }).then(x => x.json());
  const items = list.items || [];
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
    const r = await fetch(`${PROV}/users/current`, { headers: h() });
    res.json({
      ok: r.ok,
      status: r.status,
      region: REGION,
      tokenPresent: !!TOKEN
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- Link account (create -> credentials -> deploy -> poll) ----------

/**
 * Body: { brokerServer, login, password, dryRun? }
 */
app.post('/api/link-account', async (req, res) => {
  const { brokerServer, login, password, dryRun } = req.body || {};
  if (!brokerServer || !login || !password) {
    return res.status(400).json({ ok: false, error: 'Missing fields: brokerServer, login, password' });
  }
  if (!TOKEN) return res.status(500).json({ ok: false, error: 'METAAPI_TOKEN missing' });

  try {
    // 1) Create
    const create = await fetch(`${PROV}/users/current/accounts`, {
      method: 'POST', headers: h(),
      body: JSON.stringify({
        name: `${login}@${brokerServer}`,
        platform: 'mt5',
        server: brokerServer,
        application: 'CopyFactory'
      })
    });
    if (!create.ok) {
      return res.status(400).json({ ok: false, step: 'create', status: create.status, error: await create.text() });
    }
    const acc = await create.json();
    const id = acc.id;

    // 2) Credentials
    const cred = await fetch(`${PROV}/users/current/accounts/${id}/credentials`, {
      method: 'PUT', headers: h(),
      body: JSON.stringify({ login: String(login), password, type: 'master' })
    });
    if (!cred.ok) {
      // opruimen
      await fetch(`${PROV}/users/current/accounts/${id}`, { method: 'DELETE', headers: h() }).catch(() => {});
      return res.status(400).json({ ok: false, step: 'credentials', status: cred.status, error: await cred.text() });
    }

    // 3) Deploy
    const dep = await fetch(`${PROV}/users/current/accounts/${id}/deploy`, {
      method: 'POST', headers: h()
    });
    if (!dep.ok) {
      await fetch(`${PROV}/users/current/accounts/${id}`, { method: 'DELETE', headers: h() }).catch(() => {});
      return res.status(400).json({ ok: false, step: 'deploy', status: dep.status, error: await dep.text() });
    }

    // 4) Poll
    const wait = await waitAccountConnected(id, 90000);
    if (dryRun) {
      // test: opruimen
      await fetch(`${PROV}/users/current/accounts/${id}`, { method: 'DELETE', headers: h() }).catch(() => {});
    }
    if (!wait.ok) {
      return res.status(400).json({ ok: false, step: 'poll', ...wait, accountId: id });
    }

    return res.json({ ok: true, accountId: id, region: REGION, connection: wait });
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
    const api = new MetaApi(TOKEN, { domain: `agiliumtrade.agiliumtrade.ai` });
    const account = await api.metatraderAccountApi.getAccount(id);

    // Staat & connectie check
    const state = account.state;
    const cs = account.connectionStatus;
    if (state !== 'DEPLOYED') {
      return res.status(400).json({ ok: false, error: 'Account not deployed', state, connectionStatus: cs });
    }

    // wacht op connect (SDK helper)
    try {
      await Promise.race([
        account.waitConnected(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timeout')), 30000))
      ]);
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'Account connection timeout', state, connectionStatus: account.connectionStatus });
    }

    const info = await account.getAccountInformation();
    let positions = [], orders = [];
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

// ---------- CopyFactory: start (Scale-by-Equity + resync) ----------

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

    // 3) upsert subscriber config met tradeSizeScaling.mode='equity'
    const put = await fetch(`${CF}/users/current/configuration/subscribers/${accountId}`, {
      method: 'PUT', headers: h(),
      body: JSON.stringify({
        name: `${accountId}-subscriber`,
        subscriptions: [{
          strategyId,
          tradeSizeScaling: { mode: 'equity', multiplier } // ✅ juiste payload
          // optioneel: symbolMapping, riskLimits, minTradeVolume, etc.
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
 * Laat zien: account state, roles, strategyId-resolve, bestaande subscriber config.
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
        copyFactoryRoles: acc.copyFactoryRoles
      },
      strategyHint: strategy || STRAT,
      strategyId,                       // null als niet resolvebaar; zie strategiesList
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
