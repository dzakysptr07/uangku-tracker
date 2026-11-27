'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uangku-test-'));
process.env.DATA_DIR = tempDir;

const analytics = require('../src/analytics');
const storage = require('../src/storage');
const { createAppServer } = require('../src/server');

async function runTests() {
  let passed = 0;
  function check(name, fn) {
    fn();
    passed++;
    console.log('PASS:', name);
  }

  async function checkAsync(name, fn) {
    await fn();
    passed++;
    console.log('PASS:', name);
  }

  check('Analytics handles empty workspace cleanly', function () {
    const rep = analytics.analyzeMonth({ transactions: [] }, '2026-11', new Date('2026-11-27T12:00:00Z'));
    assert.strictEqual(rep.summary.totalIncome, 0);
    assert.strictEqual(rep.summary.totalExpense, 0);
    assert.strictEqual(rep.summary.healthScore, 0);
    assert.ok(rep.recommendations.length >= 1);
  });

  check('Analytics calculates 50/30/20, safe-to-spend, and category recommendations', function () {
    const data = {
      targetSavingsRate: 20,
      budgets: { kopi: 150000, makan: 1000000 },
      transactions: [
        { id: '1', type: 'income', amount: 5000000, category: 'gaji', wallet: 'bank', date: '2026-11-01' },
        { id: '2', type: 'expense', amount: 800000, category: 'makan', wallet: 'ewallet', date: '2026-11-05' },
        { id: '3', type: 'expense', amount: 50000, category: 'kopi', wallet: 'ewallet', date: '2026-11-06' },
        { id: '4', type: 'expense', amount: 50000, category: 'kopi', wallet: 'ewallet', date: '2026-11-07' },
        { id: '5', type: 'expense', amount: 50000, category: 'kopi', wallet: 'ewallet', date: '2026-11-08' },
        { id: '6', type: 'expense', amount: 50000, category: 'kopi', wallet: 'ewallet', date: '2026-11-09' },
        { id: '7', type: 'expense', amount: 50000, category: 'kopi', wallet: 'ewallet', date: '2026-11-10' },
        { id: '8', type: 'transfer', amount: 500000, category: 'lainnya', wallet: 'bank', toWallet: 'ewallet', date: '2026-11-02' }
      ]
    };
    const rep = analytics.analyzeMonth(data, '2026-11', new Date('2026-11-27T12:00:00Z'));
    assert.strictEqual(rep.summary.totalIncome, 5000000);
    assert.strictEqual(rep.summary.totalExpense, 1050000); // transfer excluded from expense
    assert.strictEqual(rep.summary.netCashflow, 3950000);
    assert.strictEqual(rep.categoryBreakdown[0].id, 'makan');
    assert.ok(rep.recommendations.some(function (r) { return r.title.includes('Anggaran Terlampaui'); }));
    assert.ok(rep.recommendations.some(function (r) { return r.title.includes('Kebiasaan Kecil'); }));

    const md = analytics.renderMarkdownRecap(rep);
    assert.ok(md.includes('# Rekap & Rekomendasi Keuangan — 2026-11'));
    assert.ok(md.includes('Rp5.000.000'));
  });

  check('Storage merges parallel Desktop & Android transactions without losing offline entries', function () {
    storage.upsertTransaction('sync-test', {
      id: 'tx_desktop_1',
      type: 'income',
      amount: 3000000,
      category: 'gaji',
      wallet: 'bank',
      date: '2026-11-01',
      device: 'desktop'
    });
    const merged = storage.syncBatch('sync-test', {
      transactions: [
        {
          id: 'tx_android_1',
          type: 'expense',
          amount: 45000,
          category: 'makan',
          wallet: 'ewallet',
          date: '2026-11-02',
          device: 'android',
          updatedAt: new Date().toISOString()
        }
      ]
    });
    assert.strictEqual(merged.transactions.filter(function (t) { return !t.deleted; }).length, 2);
  });

  await checkAsync('HTTP API, SSE live sync, PIN lock, and PWA static files work end-to-end', async function () {
    const server = createAppServer();
    await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const base = 'http://127.0.0.1:' + port;

    try {
      const health = await fetch(base + '/api/health').then(function (r) { return r.json(); });
      assert.strictEqual(health.ok, true);

      // Connect SSE client and wait for live sync event on POST
      const ssePromise = new Promise(function (resolve, reject) {
        const req = http.get(base + '/api/events?ws=e2e', function (res) {
          let buf = '';
          res.on('data', function (chunk) {
            buf += chunk.toString('utf8');
            if (buf.includes('event: sync')) {
              req.destroy();
              resolve(buf);
            }
          });
        });
        req.on('error', reject);
        setTimeout(function () { req.destroy(); reject(new Error('SSE timeout')); }, 4000);
      });

      // Small delay so SSE subscribes first
      await new Promise(function (r) { setTimeout(r, 120); });

      const postRes = await fetch(base + '/api/transactions?ws=e2e', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'e2e_tx_1',
          type: 'expense',
          amount: 75000,
          category: 'makan',
          wallet: 'tunai',
          date: '2026-11-27',
          note: 'Nasi padang',
          device: 'android'
        })
      }).then(function (r) { return r.json(); });
      assert.strictEqual(postRes.ok, true);

      const sseData = await ssePromise;
      assert.ok(sseData.includes('workspace-updated'));

      // Verify Markdown recap endpoint
      const mdRes = await fetch(base + '/api/recap?ws=e2e&month=2026-11&format=md');
      assert.strictEqual(mdRes.status, 200);
      const mdText = await mdRes.text();
      assert.ok(mdText.includes('Makan & Minum'));

      // Verify PIN protection
      await fetch(base + '/api/settings?ws=e2e', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPin: '1234' })
      });
      const unauth = await fetch(base + '/api/workspace?ws=e2e');
      assert.strictEqual(unauth.status, 401);
      const auth = await fetch(base + '/api/workspace?ws=e2e', {
        headers: { 'X-Workspace-Pin': '1234' }
      });
      assert.strictEqual(auth.status, 200);

      // Verify PWA assets
      const manifestRes = await fetch(base + '/manifest.webmanifest');
      assert.strictEqual(manifestRes.status, 200);
      const iconRes = await fetch(base + '/icons/icon-192.png');
      assert.strictEqual(iconRes.status, 200);
      const swRes = await fetch(base + '/sw.js');
      assert.strictEqual(swRes.status, 200);
    } finally {
      server.close();
    }
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('\nAll ' + passed + ' test suites passed.');
}

runTests().catch(function (err) {
  console.error('TEST FAILED:', err);
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
});
