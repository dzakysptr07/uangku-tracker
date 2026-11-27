'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const analytics = require('./analytics');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function sanitizeWorkspaceId(wsId) {
  const clean = String(wsId || 'pribadi')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 48);
  return clean || 'pribadi';
}

function hashPin(pin) {
  if (!pin) return null;
  return crypto.createHash('sha256').update('uangku:' + String(pin)).digest('hex');
}

function createDefaultWorkspace(wsId) {
  return {
    workspaceId: sanitizeWorkspaceId(wsId),
    revision: 1,
    updatedAt: new Date().toISOString(),
    targetSavingsRate: 20,
    pinHash: null,
    categories: analytics.DEFAULT_CATEGORIES,
    wallets: analytics.DEFAULT_WALLETS,
    budgets: {
      makan: 1500000,
      kopi: 400000,
      transport: 600000,
      tagihan: 1500000,
      belanja: 750000,
      hiburan: 400000
    },
    transactions: []
  };
}

function getWorkspacePath(wsId) {
  ensureDataDir();
  return path.join(DATA_DIR, sanitizeWorkspaceId(wsId) + '.json');
}

function readWorkspace(wsId) {
  const cleanId = sanitizeWorkspaceId(wsId);
  const filePath = getWorkspacePath(cleanId);
  if (!fs.existsSync(filePath)) {
    const fresh = createDefaultWorkspace(cleanId);
    writeWorkspaceAtomic(cleanId, fresh);
    return fresh;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.transactions)) parsed.transactions = [];
    if (!Array.isArray(parsed.categories) || !parsed.categories.length) parsed.categories = analytics.DEFAULT_CATEGORIES;
    if (!Array.isArray(parsed.wallets) || !parsed.wallets.length) parsed.wallets = analytics.DEFAULT_WALLETS;
    if (!parsed.budgets || typeof parsed.budgets !== 'object') parsed.budgets = {};
    if (!parsed.revision) parsed.revision = 1;
    parsed.workspaceId = cleanId;
    return parsed;
  } catch (err) {
    const fallback = createDefaultWorkspace(cleanId);
    return fallback;
  }
}

function writeWorkspaceAtomic(wsId, data) {
  const cleanId = sanitizeWorkspaceId(wsId);
  const filePath = getWorkspacePath(cleanId);
  const tmpPath = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function sanitizeClientView(ws) {
  return {
    workspaceId: ws.workspaceId,
    revision: ws.revision,
    updatedAt: ws.updatedAt,
    hasPin: Boolean(ws.pinHash),
    targetSavingsRate: ws.targetSavingsRate || 20,
    categories: ws.categories,
    wallets: ws.wallets,
    budgets: ws.budgets,
    transactions: ws.transactions.filter(function (t) { return !t.deleted; }),
    tombstones: ws.transactions.filter(function (t) { return t.deleted; }).map(function (t) {
      return { id: t.id, updatedAt: t.updatedAt, deleted: true };
    })
  };
}

function normalizeTransaction(tx) {
  const nowIso = new Date().toISOString();
  const id = String(tx.id || ('tx_' + crypto.randomUUID())).slice(0, 64);
  const type = ['expense', 'income', 'transfer'].includes(tx.type) ? tx.type : 'expense';
  const amount = Math.max(0, Math.round(Number(tx.amount) || 0));
  const date = typeof tx.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(tx.date)
    ? tx.date.slice(0, 19)
    : nowIso.slice(0, 10);

  return {
    id: id,
    type: type,
    amount: amount,
    category: String(tx.category || (type === 'income' ? 'gaji' : 'lainnya')).slice(0, 48),
    wallet: String(tx.wallet || 'tunai').slice(0, 48),
    toWallet: type === 'transfer' ? String(tx.toWallet || 'bank').slice(0, 48) : undefined,
    date: date,
    note: String(tx.note || '').slice(0, 200),
    device: String(tx.device || 'web').slice(0, 32),
    deleted: Boolean(tx.deleted),
    createdAt: tx.createdAt || nowIso,
    updatedAt: tx.updatedAt || nowIso
  };
}

function mergeTransactions(existing, incoming) {
  const map = new Map();
  for (let i = 0; i < existing.length; i++) {
    map.set(existing[i].id, existing[i]);
  }
  let changed = false;
  for (let i = 0; i < incoming.length; i++) {
    const norm = normalizeTransaction(incoming[i]);
    const prev = map.get(norm.id);
    if (!prev || String(norm.updatedAt) > String(prev.updatedAt)) {
      map.set(norm.id, norm);
      changed = true;
    }
  }
  const merged = Array.from(map.values()).sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return String(a.createdAt) < String(b.createdAt) ? 1 : -1;
  });
  return { merged: merged, changed: changed };
}

function upsertTransaction(wsId, txInput) {
  const ws = readWorkspace(wsId);
  const nowIso = new Date().toISOString();
  const tx = normalizeTransaction(Object.assign({}, txInput, { updatedAt: nowIso }));
  const res = mergeTransactions(ws.transactions, [tx]);
  ws.transactions = res.merged;
  ws.revision += 1;
  ws.updatedAt = nowIso;
  writeWorkspaceAtomic(wsId, ws);
  return { workspace: ws, transaction: tx };
}

function deleteTransaction(wsId, txId) {
  const ws = readWorkspace(wsId);
  const nowIso = new Date().toISOString();
  const existing = ws.transactions.find(function (t) { return t.id === txId; });
  if (!existing) return { workspace: ws, deleted: false };
  existing.deleted = true;
  existing.updatedAt = nowIso;
  ws.revision += 1;
  ws.updatedAt = nowIso;
  writeWorkspaceAtomic(wsId, ws);
  return { workspace: ws, deleted: true };
}

function syncBatch(wsId, payload) {
  const ws = readWorkspace(wsId);
  const nowIso = new Date().toISOString();
  const incomingTx = Array.isArray(payload.transactions) ? payload.transactions : [];
  const res = mergeTransactions(ws.transactions, incomingTx);
  let metaChanged = false;

  if (payload.budgets && typeof payload.budgets === 'object') {
    ws.budgets = Object.assign({}, ws.budgets, payload.budgets);
    metaChanged = true;
  }
  if (payload.targetSavingsRate !== undefined) {
    const rate = Math.max(1, Math.min(80, Number(payload.targetSavingsRate) || 20));
    ws.targetSavingsRate = rate;
    metaChanged = true;
  }
  if (Array.isArray(payload.wallets) && payload.wallets.length > 0) {
    ws.wallets = payload.wallets;
    metaChanged = true;
  }

  if (res.changed || metaChanged) {
    ws.transactions = res.merged;
    ws.revision += 1;
    ws.updatedAt = nowIso;
    writeWorkspaceAtomic(wsId, ws);
  }
  return ws;
}

function updateSettings(wsId, payload) {
  const ws = readWorkspace(wsId);
  const nowIso = new Date().toISOString();
  if (payload.budgets && typeof payload.budgets === 'object') {
    const cleanBudgets = {};
    Object.keys(payload.budgets).forEach(function (k) {
      const v = Math.max(0, Math.round(Number(payload.budgets[k]) || 0));
      if (v > 0) cleanBudgets[k] = v;
    });
    ws.budgets = cleanBudgets;
  }
  if (payload.targetSavingsRate !== undefined) {
    ws.targetSavingsRate = Math.max(1, Math.min(80, Number(payload.targetSavingsRate) || 20));
  }
  if (Array.isArray(payload.wallets) && payload.wallets.length > 0) {
    ws.wallets = payload.wallets.map(function (w) {
      return {
        id: String(w.id || 'wallet').slice(0, 32),
        name: String(w.name || 'Dompet').slice(0, 40),
        icon: String(w.icon || '💳').slice(0, 8),
        initialBalance: Number(w.initialBalance) || 0
      };
    });
  }
  if (payload.newPin !== undefined) {
    ws.pinHash = payload.newPin ? hashPin(payload.newPin) : null;
  }
  ws.revision += 1;
  ws.updatedAt = nowIso;
  writeWorkspaceAtomic(wsId, ws);
  return ws;
}

function seedDemoData(wsId, refDate) {
  const now = refDate instanceof Date ? refDate : new Date();
  const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const prevYm = prevDate.getFullYear() + '-' + String(prevDate.getMonth() + 1).padStart(2, '0');
  const day = function (m, d) {
    const maxD = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();
    const safeD = Math.min(d, maxD);
    return m + '-' + String(safeD).padStart(2, '0');
  };

  const samples = [
    // Previous month baseline for MoM comparison
    { id: 'demo_p1', type: 'income', amount: 7500000, category: 'gaji', wallet: 'bank', date: day(prevYm, 1), note: 'Gaji Bulanan', device: 'desktop' },
    { id: 'demo_p2', type: 'expense', amount: 1400000, category: 'tagihan', wallet: 'bank', date: day(prevYm, 3), note: 'Kos & Listrik', device: 'desktop' },
    { id: 'demo_p3', type: 'expense', amount: 1200000, category: 'makan', wallet: 'ewallet', date: day(prevYm, 10), note: 'Makan harian & warteg', device: 'android' },
    { id: 'demo_p4', type: 'expense', amount: 320000, category: 'kopi', wallet: 'ewallet', date: day(prevYm, 14), note: 'Kopi susu & snack', device: 'android' },
    { id: 'demo_p5', type: 'expense', amount: 480000, category: 'transport', wallet: 'ewallet', date: day(prevYm, 18), note: 'Bensin & ojol', device: 'android' },
    { id: 'demo_p6', type: 'expense', amount: 1000000, category: 'tabungan', wallet: 'bank', date: day(prevYm, 25), note: 'Tabungan reksadana', device: 'desktop' },

    // Current month rich data
    { id: 'demo_c1', type: 'income', amount: 7500000, category: 'gaji', wallet: 'bank', date: day(ym, 1), note: 'Gaji Bulanan', device: 'desktop' },
    { id: 'demo_c2', type: 'income', amount: 950000, category: 'bonus', wallet: 'bank', date: day(ym, 8), note: 'Project Freelance UI', device: 'desktop' },
    { id: 'demo_c3', type: 'transfer', amount: 1500000, category: 'lainnya', wallet: 'bank', toWallet: 'ewallet', date: day(ym, 2), note: 'Top up E-Wallet bulanan', device: 'android' },
    { id: 'demo_c4', type: 'transfer', amount: 500000, category: 'lainnya', wallet: 'bank', toWallet: 'tunai', date: day(ym, 2), note: 'Tarik tunai ATM', device: 'android' },
    { id: 'demo_c5', type: 'expense', amount: 1450000, category: 'tagihan', wallet: 'bank', date: day(ym, 3), note: 'Sewa kos + internet', device: 'desktop' },
    { id: 'demo_c6', type: 'expense', amount: 650000, category: 'belanja', wallet: 'ewallet', date: day(ym, 4), note: 'Groceries & perlengkapan mandi', device: 'android' },
    { id: 'demo_c7', type: 'expense', amount: 420000, category: 'makan', wallet: 'ewallet', date: day(ym, 5), note: 'Makan siang kantor minggu 1', device: 'android' },
    { id: 'demo_c8', type: 'expense', amount: 55000, category: 'kopi', wallet: 'ewallet', date: day(ym, 6), note: 'Kopi susu + roti', device: 'android' },
    { id: 'demo_c9', type: 'expense', amount: 48000, category: 'kopi', wallet: 'ewallet', date: day(ym, 8), note: 'Es kopi sore', device: 'android' },
    { id: 'demo_c10', type: 'expense', amount: 310000, category: 'transport', wallet: 'ewallet', date: day(ym, 9), note: 'Ojol & tol minggu 1-2', device: 'android' },
    { id: 'demo_c11', type: 'expense', amount: 185000, category: 'hiburan', wallet: 'bank', date: day(ym, 10), note: 'Streaming & musik', device: 'desktop' },
    { id: 'demo_c12', type: 'expense', amount: 490000, category: 'makan', wallet: 'tunai', date: day(ym, 12), note: 'Makan malam & traktir', device: 'android' },
    { id: 'demo_c13', type: 'expense', amount: 65000, category: 'kopi', wallet: 'ewallet', date: day(ym, 14), note: 'Boba & cemilan', device: 'android' },
    { id: 'demo_c14', type: 'expense', amount: 45000, category: 'kopi', wallet: 'ewallet', date: day(ym, 16), note: 'Kopi kenangan', device: 'android' },
    { id: 'demo_c15', type: 'expense', amount: 270000, category: 'transport', wallet: 'tunai', date: day(ym, 18), note: 'Isi bensin & parkir', device: 'android' },
    { id: 'demo_c16', type: 'expense', amount: 380000, category: 'makan', wallet: 'ewallet', date: day(ym, 20), note: 'Makan siang & pesan antar', device: 'android' },
    { id: 'demo_c17', type: 'expense', amount: 295000, category: 'hiburan', wallet: 'ewallet', date: day(ym, 21), note: 'Nonton bioskop weekend', device: 'android' },
    { id: 'demo_c18', type: 'expense', amount: 72000, category: 'kopi', wallet: 'ewallet', date: day(ym, 23), note: 'Matcha latte & pastry', device: 'android' },
    { id: 'demo_c19', type: 'expense', amount: 1500000, category: 'tabungan', wallet: 'bank', date: day(ym, 24), note: 'Autodebit tabungan & RDPU', device: 'desktop' }
  ];

  const ws = syncBatch(wsId, { transactions: samples });
  return ws;
}

module.exports = {
  DATA_DIR: DATA_DIR,
  sanitizeWorkspaceId: sanitizeWorkspaceId,
  hashPin: hashPin,
  readWorkspace: readWorkspace,
  sanitizeClientView: sanitizeClientView,
  upsertTransaction: upsertTransaction,
  deleteTransaction: deleteTransaction,
  syncBatch: syncBatch,
  updateSettings: updateSettings,
  seedDemoData: seedDemoData
};
