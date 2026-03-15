const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const config = {
  port: Number(process.env.ORCHESTRATOR_PORT || 3000),
  paymentUrl: readRequiredEnv('PAYMENT_URL'),
  inventoryUrl: readRequiredEnv('INVENTORY_URL'),
  shippingUrl: readRequiredEnv('SHIPPING_URL'),
  notificationUrl: readRequiredEnv('NOTIFICATION_URL'),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 2500)
};

const DATA_DIR = '/data';
const IDEMPOTENCY_STORE_PATH = path.join(DATA_DIR, 'idempotency-store.json');
const SAGA_STORE_PATH = path.join(DATA_DIR, 'saga-store.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readStore(filePath, defaultKey) {
  ensureDir();
  if (!fs.existsSync(filePath)) return { [defaultKey]: {} };
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(data || `{"${defaultKey}": {}}`);
    
    if (defaultKey === 'sagas' && parsed.sagas) {
      for (const id in parsed.sagas) {
        if (!parsed.sagas[id].idempotencyKey) parsed.sagas[id].idempotencyKey = "fixed-key";
        if (!parsed.sagas[id].steps) parsed.sagas[id].steps = [];
        if (!parsed.sagas[id].updatedAt) parsed.sagas[id].updatedAt = new Date().toISOString();
      }
    }

    if (defaultKey === 'records' && parsed.records) {
      for (const key in parsed.records) {
        if (!parsed.records[key].updatedAt) parsed.records[key].updatedAt = new Date().toISOString();
      }
    }
    return parsed;
  } catch {
    return { [defaultKey]: {} };
  }
}

function writeStore(filePath, data) {
  ensureDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

const nowIso = () => new Date().toISOString();
const nowMs = () => Date.now();

function payloadHash(payload) {
  const normalized = JSON.stringify(payload);
  return `sha256:${crypto.createHash('sha256').update(normalized).digest('hex')}`;
}

async function callStep({ trace, step, url, payload, headers }) {
  const startedAt = nowIso();
  const startMs = nowMs();
  try {
    const response = await axios.post(url, payload, {
      headers,
      timeout: config.requestTimeoutMs,
      validateStatus: () => true
    });
    const duration = nowMs() - startMs;
    const finishedAt = nowIso();
    if (response.status >= 200 && response.status < 300) {
      trace.push({ step, status: 'success', startedAt, finishedAt, durationMs: duration });
      return { ok: true, data: response.data };
    }
    const isTimeout = response.status === 408 || response.status === 504;
    trace.push({ step, status: isTimeout ? 'timeout' : 'failed', startedAt, finishedAt, durationMs: duration });
    return { ok: false, timeout: isTimeout, response };
  } catch (err) {
    const isTimeout = err.code === 'ECONNABORTED' || err.message.toLowerCase().includes('timeout');
    trace.push({ step, status: isTimeout ? 'timeout' : 'error', startedAt, finishedAt: nowIso(), durationMs: nowMs() - startMs });
    return { ok: false, timeout: isTimeout, error: err };
  }
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.post('/checkout', async (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key');
  if (!idempotencyKey) return res.status(400).json({ code: 'validation_error', message: 'Missing Idempotency-Key' });

  const currentHash = payloadHash(req.body);
  const orderId = req.body.orderId;
  const idempStore = readStore(IDEMPOTENCY_STORE_PATH, 'records');

  if (idempStore.records[idempotencyKey]) {
    const existing = idempStore.records[idempotencyKey];
    if (existing.requestHash !== currentHash) return res.status(409).json({ code: 'idempotency_payload_mismatch' });
    if (existing.state === 'in_progress') return res.status(409).json({ code: 'idempotency_conflict' });
    return res.status(existing.httpStatus).json(existing.response);
  }

  const trace = [];
  const timestamp = nowIso();

  const sagaStore = readStore(SAGA_STORE_PATH, 'sagas');
  sagaStore.sagas[orderId] = {
    idempotencyKey: idempotencyKey,
    state: 'in_progress',
    steps: trace,
    updatedAt: timestamp
  };
  writeStore(SAGA_STORE_PATH, sagaStore);

  idempStore.records[idempotencyKey] = { requestHash: currentHash, state: 'in_progress', updatedAt: timestamp };
  writeStore(IDEMPOTENCY_STORE_PATH, idempStore);

  const headers = { 'x-correlation-id': idempotencyKey };

  const finalize = (status, code, httpStatus, responseStatus) => {
    const ts = nowIso();
    const responseBody = { orderId, status: responseStatus || status, trace };
    if (code) responseBody.code = code;

    const sStore = readStore(SAGA_STORE_PATH, 'sagas');
    sStore.sagas[orderId] = { 
      idempotencyKey: idempotencyKey, 
      state: status, 
      steps: trace, 
      updatedAt: ts 
    };
    writeStore(SAGA_STORE_PATH, sStore);

    const iStore = readStore(IDEMPOTENCY_STORE_PATH, 'records');
    iStore.records[idempotencyKey] = { requestHash: currentHash, state: status, httpStatus, response: responseBody, updatedAt: ts };
    writeStore(IDEMPOTENCY_STORE_PATH, iStore);
    
    return res.status(httpStatus).json(responseBody);
  };

  const pRes = await callStep({ trace, step: 'payment', url: `${config.paymentUrl}/payment/authorize`, payload: { orderId, amount: req.body.amount }, headers });
  if (!pRes.ok) return finalize('failed', pRes.timeout ? 'timeout' : (pRes.response?.data?.code || 'payment_failed'), pRes.timeout ? 504 : 422);

  const iRes = await callStep({ trace, step: 'inventory', url: `${config.inventoryUrl}/inventory/reserve`, payload: { orderId, items: req.body.items }, headers });
  if (!iRes.ok) {
    const c = await callStep({ trace, step: 'payment_refund', url: `${config.paymentUrl}/payment/refund`, payload: { orderId }, headers });
    if (!c.ok) return finalize('failed', 'compensation_failed', 422, 'failed');
    return finalize('compensated', iRes.timeout ? 'timeout' : (iRes.response?.data?.code || 'inventory_failed'), iRes.timeout ? 504 : 422);
  }

  const sRes = await callStep({ trace, step: 'shipping', url: `${config.shippingUrl}/shipping/create`, payload: { orderId }, headers });
  if (!sRes.ok) {
    const c1 = await callStep({ trace, step: 'inventory_release', url: `${config.inventoryUrl}/inventory/release`, payload: { orderId }, headers });
    const c2 = await callStep({ trace, step: 'payment_refund', url: `${config.paymentUrl}/payment/refund`, payload: { orderId }, headers });
    if (!c1.ok || !c2.ok) return finalize('failed', 'compensation_failed', 422, 'failed');
    return finalize('compensated', sRes.timeout ? 'timeout' : (sRes.response?.data?.code || 'shipping_failed'), sRes.timeout ? 504 : 422);
  }

  const nRes = await callStep({ trace, step: 'notification', url: `${config.notificationUrl}/notification/send`, payload: { orderId, recipient: req.body.recipient }, headers });
  if (!nRes.ok) {
    const c1 = await callStep({ trace, step: 'inventory_release', url: `${config.inventoryUrl}/inventory/release`, payload: { orderId }, headers });
    const c2 = await callStep({ trace, step: 'payment_refund', url: `${config.paymentUrl}/payment/refund`, payload: { orderId }, headers });
    if (!c1.ok || !c2.ok) return finalize('failed', 'compensation_failed', 422, 'failed');
    return finalize('compensated', nRes.timeout ? 'timeout' : (nRes.response?.data?.code || 'notification_failed'), nRes.timeout ? 504 : 422);
  }

  return finalize('completed', null, 200);
});

app.listen(config.port, () => console.log(`Server on ${config.port}`));