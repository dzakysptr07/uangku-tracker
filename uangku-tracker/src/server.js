'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const storage = require('./storage');
const analytics = require('./analytics');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

// Active SSE subscribers per workspaceId
const subscribers = new Map();

function addSubscriber(wsId, res) {
  if (!subscribers.has(wsId)) {
    subscribers.set(wsId, new Set());
  }
  subscribers.get(wsId).add(res);
}

function removeSubscriber(wsId, res) {
  const set = subscribers.get(wsId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) subscribers.delete(wsId);
}

function broadcastWorkspaceUpdate(ws) {
  const set = subscribers.get(ws.workspaceId);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify({
    type: 'workspace-updated',
    workspaceId: ws.workspaceId,
    revision: ws.revision,
    updatedAt: ws.updatedAt
  });
  for (const res of set) {
    try {
      res.write('event: sync\ndata: ' + payload + '\n\n');
    } catch (_) {
      removeSubscriber(ws.workspaceId, res);
    }
  }
}

function getLanUrls(port) {
  const interfaces = os.networkInterfaces();
  const urls = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        urls.push('http://' + iface.address + ':' + port);
      }
    }
  }
  return urls;
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Workspace-Pin');
}

function sendJson(res, statusCode, body) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise(function (resolve, reject) {
    let raw = '';
    let size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      raw += chunk.toString('utf8');
    });
    req.on('end', function () {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function checkPin(ws, req, parsedUrl) {
  if (!ws.pinHash) return true;
  const headerPin = req.headers['x-workspace-pin'] || parsedUrl.searchParams.get('pin') || '';
  return storage.hashPin(headerPin) === ws.pinHash;
}

function serveStatic(reqPath, res) {
  let cleanPath = reqPath === '/' ? '/index.html' : reqPath;
  if (cleanPath === '/analytics.js') {
    const analyticsPath = path.join(__dirname, 'analytics.js');
    fs.readFile(analyticsPath, function (err, buf) {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      setCorsHeaders(res);
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }

  const resolved = path.normalize(path.join(PUBLIC_DIR, cleanPath));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(resolved, function (err, stat) {
    if (err || !stat.isFile()) {
      // SPA fallback for client routes
      const indexFile = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexFile, function (idxErr, buf) {
        if (idxErr) {
          res.writeHead(404);
          return res.end('Not found');
        }
        setCorsHeaders(res);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buf);
      });
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const cacheHeader = (cleanPath === '/sw.js' || cleanPath === '/index.html') ? 'no-cache' : 'public, max-age=3600';
    fs.readFile(resolved, function (readErr, buf) {
      if (readErr) {
        res.writeHead(500);
        return res.end('Read error');
      }
      setCorsHeaders(res);
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': cacheHeader });
      res.end(buf);
    });
  });
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;
  const wsId = storage.sanitizeWorkspaceId(parsedUrl.searchParams.get('ws') || 'pribadi');

  try {
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        service: 'uangku-tracker',
        time: new Date().toISOString(),
        lanUrls: getLanUrls(PORT),
        activeSubscribers: subscribers.size
      });
    }

    if (pathname === '/api/events' && req.method === 'GET') {
      const ws = storage.readWorkspace(wsId);
      if (!checkPin(ws, req, parsedUrl)) {
        return sendJson(res, 401, { error: 'PIN workspace salah atau diperlukan' });
      }
      setCorsHeaders(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
      });
      res.write('event: connected\ndata: ' + JSON.stringify({ workspaceId: wsId, revision: ws.revision }) + '\n\n');
      addSubscriber(wsId, res);

      const heartbeat = setInterval(function () {
        try {
          res.write(': ping\n\n');
        } catch (_) {
          clearInterval(heartbeat);
          removeSubscriber(wsId, res);
        }
      }, 25000);

      req.on('close', function () {
        clearInterval(heartbeat);
        removeSubscriber(wsId, res);
      });
      return;
    }

    if (pathname === '/api/workspace' && req.method === 'GET') {
      const ws = storage.readWorkspace(wsId);
      if (!checkPin(ws, req, parsedUrl)) {
        return sendJson(res, 401, { error: 'PIN workspace salah atau diperlukan', requiresPin: true });
      }
      const month = parsedUrl.searchParams.get('month') || '';
      const view = storage.sanitizeClientView(ws);
      view.report = analytics.analyzeMonth(ws, month);
      return sendJson(res, 200, view);
    }

    if (pathname === '/api/recap' && req.method === 'GET') {
      const ws = storage.readWorkspace(wsId);
      if (!checkPin(ws, req, parsedUrl)) {
        return sendJson(res, 401, { error: 'PIN workspace salah atau diperlukan', requiresPin: true });
      }
      const month = parsedUrl.searchParams.get('month') || '';
      const format = parsedUrl.searchParams.get('format') || 'json';
      const report = analytics.analyzeMonth(ws, month);
      if (format === 'md' || format === 'markdown') {
        setCorsHeaders(res);
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        return res.end(analytics.renderMarkdownRecap(report));
      }
      return sendJson(res, 200, report);
    }

    if (pathname === '/api/transactions' && req.method === 'POST') {
      const wsCheck = storage.readWorkspace(wsId);
      if (!checkPin(wsCheck, req, parsedUrl)) {
        return sendJson(res, 401, { error: 'PIN workspace salah atau diperlukan', requiresPin: true });
      }
      const body = await parseBody(req);
      const result = storage.upsertTransaction(wsId, body);
      broadcastWorkspaceUpdate(result.workspace);
      return sendJson(res, 200, {
        ok: true,
        transaction: result.transaction,
        revision: result.workspace.revision,
        updatedAt: result.workspace.updatedAt
      });
    }

    if (pathname.startsWith('/api/transactions/') && req.method === 'DELETE') {
      const wsCheck = storage.readWorkspace(wsId);
      if (!checkPin(wsCheck, req, parsedUrl)) {
        return sendJson(res, 401, { error: 'PIN workspace salah atau diperlukan', requiresPin: true });
      }
      const txId = decodeURIComponent(pathname.slice('/api/transactions/'.length));
      const result = storage.deleteTransaction(wsId, txId);
      if (result.deleted) {
        broadcastWorkspaceUpdate(result.workspace);
      }
      return sendJson(res, 200, {
        ok: true,
        deleted: result.deleted,
        revision: result.workspace.revision
      });
    }

    if (pathname === '/api/sync' && req.method === 'POST') {
      const wsCheck = storage.readWorkspace(wsId);
      if (!checkPin(wsCheck, req, parsedUrl)) {
        return sendJson(res, 401, { error: 'PIN workspace salah atau diperlukan', requiresPin: true });
      }
      const body = await parseBody(req);
      const ws = storage.syncBatch(wsId, body);
      broadcastWorkspaceUpdate(ws);
      const month = parsedUrl.searchParams.get('month') || '';
      const view = storage.sanitizeClientView(ws);
      view.report = analytics.analyzeMonth(ws, month);
      return sendJson(res, 200, view);
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const wsCheck = storage.readWorkspace(wsId);
      if (!checkPin(wsCheck, req, parsedUrl)) {
        return sendJson(res, 401, { error: 'PIN workspace salah atau diperlukan', requiresPin: true });
      }
      const body = await parseBody(req);
      const ws = storage.updateSettings(wsId, body);
      broadcastWorkspaceUpdate(ws);
      return sendJson(res, 200, storage.sanitizeClientView(ws));
    }

    if (pathname === '/api/demo' && req.method === 'POST') {
      const wsCheck = storage.readWorkspace(wsId);
      if (!checkPin(wsCheck, req, parsedUrl)) {
        return sendJson(res, 401, { error: 'PIN workspace salah atau diperlukan', requiresPin: true });
      }
      const ws = storage.seedDemoData(wsId);
      broadcastWorkspaceUpdate(ws);
      const view = storage.sanitizeClientView(ws);
      view.report = analytics.analyzeMonth(ws, '');
      return sendJson(res, 200, view);
    }

    if (!pathname.startsWith('/api/')) {
      return serveStatic(pathname, res);
    }

    return sendJson(res, 404, { error: 'Endpoint tidak ditemukan' });
  } catch (err) {
    return sendJson(res, 400, { error: err.message || 'Bad request' });
  }
}

function createAppServer() {
  return http.createServer(handleRequest);
}

if (require.main === module) {
  const server = createAppServer();
  server.listen(PORT, HOST, function () {
    const lan = getLanUrls(PORT);
    console.log('UangKu Tracker berjalan:');
    console.log('  - Desktop (lokal): http://localhost:' + PORT);
    if (lan.length) {
      lan.forEach(function (u) {
        console.log('  - Android (satu Wi-Fi): ' + u);
      });
    }
  });
}

module.exports = {
  createAppServer: createAppServer,
  getLanUrls: getLanUrls
};
