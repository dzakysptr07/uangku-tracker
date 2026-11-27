'use strict';

const fs = require('fs');
const path = require('path');
const storage = require('../src/storage');
const analytics = require('../src/analytics');

function parseArgs(argv) {
  const args = { ws: 'pribadi', month: '', save: false, json: false, url: '', pin: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ws' && argv[i + 1]) args.ws = argv[++i];
    else if (a === '--month' && argv[i + 1]) args.month = argv[++i];
    else if (a === '--url' && argv[i + 1]) args.url = argv[++i];
    else if (a === '--pin' && argv[i + 1]) args.pin = argv[++i];
    else if (a === '--save') args.save = true;
    else if (a === '--json') args.json = true;
  }
  return args;
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  let report;

  if (opts.url) {
    const base = opts.url.replace(/\/+$/, '');
    const u = new URL(base + '/api/recap');
    u.searchParams.set('ws', opts.ws);
    if (opts.month) u.searchParams.set('month', opts.month);
    const headers = {};
    if (opts.pin) headers['X-Workspace-Pin'] = opts.pin;
    const res = await fetch(u.toString(), { headers: headers });
    if (!res.ok) {
      throw new Error('Gagal mengambil rekap dari server: HTTP ' + res.status);
    }
    report = await res.json();
  } else {
    const ws = storage.readWorkspace(opts.ws);
    report = analytics.analyzeMonth(ws, opts.month);
  }

  const output = opts.json
    ? JSON.stringify(report, null, 2)
    : analytics.renderMarkdownRecap(report);

  console.log(output);

  if (opts.save) {
    const reportsDir = path.join(__dirname, '..', 'reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    const ext = opts.json ? '.json' : '.md';
    const outFile = path.join(reportsDir, 'rekap-' + opts.ws + '-' + report.month + ext);
    fs.writeFileSync(outFile, output, 'utf8');
    console.error('Laporan disimpan ke: ' + outFile);
  }
}

run().catch(function (err) {
  console.error(err.message);
  process.exit(1);
});
