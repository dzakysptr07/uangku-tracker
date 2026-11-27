(function () {
  'use strict';

  const A = window.UangKuAnalytics;
  const CONFIG_KEY = 'uangku_client_config_v1';

  function detectDeviceLabel() {
    const ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    return 'desktop';
  }

  function currentMonthStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function loadConfig() {
    let cfg = { workspaceId: 'pribadi', serverUrl: '', pin: '' };
    try {
      const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
      if (saved.workspaceId) cfg.workspaceId = saved.workspaceId;
      if (saved.serverUrl) cfg.serverUrl = saved.serverUrl;
      if (saved.pin) cfg.pin = saved.pin;
    } catch (_) {}

    const params = new URLSearchParams(window.location.search);
    let urlChanged = false;
    if (params.get('ws')) {
      cfg.workspaceId = params.get('ws').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'pribadi';
      urlChanged = true;
    }
    if (params.get('server')) {
      cfg.serverUrl = params.get('server').replace(/\/+$/, '');
      urlChanged = true;
    }
    if (urlChanged) saveConfig(cfg);
    return cfg;
  }

  function saveConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  }

  const state = {
    config: loadConfig(),
    month: currentMonthStr(),
    activeTab: 'dashboard',
    device: detectDeviceLabel(),
    workspace: {
      workspaceId: 'pribadi',
      revision: 0,
      targetSavingsRate: 20,
      categories: A.DEFAULT_CATEGORIES,
      wallets: A.DEFAULT_WALLETS,
      budgets: {},
      transactions: []
    },
    pendingQueue: [],
    report: null,
    syncMode: 'connecting', // 'live' | 'polling' | 'offline' | 'connecting'
    eventSource: null,
    deferredInstallPrompt: null
  };

  function cacheKey() { return 'uangku_cache_' + state.config.workspaceId; }
  function queueKey() { return 'uangku_queue_' + state.config.workspaceId; }

  function loadLocalCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey()) || 'null');
      if (cached && Array.isArray(cached.transactions)) {
        state.workspace = cached;
      }
      const q = JSON.parse(localStorage.getItem(queueKey()) || '[]');
      if (Array.isArray(q)) state.pendingQueue = q;
    } catch (_) {}
  }

  function saveLocalCache() {
    try {
      localStorage.setItem(cacheKey(), JSON.stringify(state.workspace));
      localStorage.setItem(queueKey(), JSON.stringify(state.pendingQueue));
    } catch (_) {}
  }

  function apiBase() {
    return state.config.serverUrl ? state.config.serverUrl.replace(/\/+$/, '') : '';
  }

  function buildUrl(path, extraParams) {
    const url = new URL(apiBase() + path, window.location.origin);
    url.searchParams.set('ws', state.config.workspaceId);
    if (extraParams) {
      Object.keys(extraParams).forEach(function (k) {
        if (extraParams[k] !== undefined && extraParams[k] !== '') {
          url.searchParams.set(k, extraParams[k]);
        }
      });
    }
    return url.toString();
  }

  async function apiFetch(path, options, extraParams) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, (options && options.headers) || {});
    if (state.config.pin) {
      headers['X-Workspace-Pin'] = state.config.pin;
    }
    const res = await fetch(buildUrl(path, extraParams), Object.assign({}, options, { headers: headers }));
    if (res.status === 401) {
      document.getElementById('pinModal').classList.remove('hidden');
      throw new Error('PIN diperlukan');
    }
    if (!res.ok) {
      const errBody = await res.json().catch(function () { return {}; });
      throw new Error(errBody.error || ('HTTP ' + res.status));
    }
    return res.json();
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      el.classList.add('hidden');
    }, 2800);
  }

  function updateSyncBadges() {
    const qLen = state.pendingQueue.length;
    let cls = 'sync-pill';
    let text = 'Menghubungkan...';
    if (!navigator.onLine || state.syncMode === 'offline') {
      cls += ' offline';
      text = qLen > 0 ? 'Offline (' + qLen + ' tertunda)' : 'Mode Offline';
    } else if (state.syncMode === 'live') {
      cls += ' online';
      text = qLen > 0 ? 'Menyinkronkan (' + qLen + ')...' : 'Live Sync ●';
    } else if (state.syncMode === 'polling') {
      cls += ' online';
      text = qLen > 0 ? 'Sync (' + qLen + ')...' : 'Cloud Sync ●';
    }
    ['syncBadgeDesktop', 'syncBadgeMobile'].forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.className = id === 'syncBadgeMobile' ? cls + ' mobile-only' : cls;
      el.querySelector('.sync-text').textContent = text;
    });
  }

  function mergeLocalQueueIntoWorkspace() {
    if (!state.pendingQueue.length) return;
    const map = new Map();
    state.workspace.transactions.forEach(function (t) { map.set(t.id, t); });
    state.pendingQueue.forEach(function (t) {
      const prev = map.get(t.id);
      if (!prev || String(t.updatedAt) >= String(prev.updatedAt)) {
        if (t.deleted) map.delete(t.id);
        else map.set(t.id, t);
      }
    });
    state.workspace.transactions = Array.from(map.values()).sort(function (a, b) {
      return a.date < b.date ? 1 : -1;
    });
  }

  async function flushQueueAndFetch() {
    if (!navigator.onLine) {
      state.syncMode = 'offline';
      updateSyncBadges();
      return;
    }
    try {
      if (state.pendingQueue.length > 0) {
        const res = await apiFetch('/api/sync', {
          method: 'POST',
          body: JSON.stringify({ transactions: state.pendingQueue })
        }, { month: state.month });
        state.pendingQueue = [];
        state.workspace = res;
      } else {
        const res = await apiFetch('/api/workspace', { method: 'GET' }, { month: state.month });
        state.workspace = res;
      }
      if (state.syncMode !== 'live') state.syncMode = 'polling';
      saveLocalCache();
      renderAll();
    } catch (err) {
      if (err.message !== 'PIN diperlukan') {
        state.syncMode = 'offline';
        updateSyncBadges();
      }
    }
  }

  function connectSse() {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    if (!navigator.onLine) {
      state.syncMode = 'offline';
      updateSyncBadges();
      return;
    }
    try {
      const es = new EventSource(buildUrl('/api/events', { pin: state.config.pin || '' }));
      state.eventSource = es;

      es.addEventListener('connected', function () {
        state.syncMode = 'live';
        updateSyncBadges();
      });

      es.addEventListener('sync', function (ev) {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.revision && msg.revision !== state.workspace.revision) {
            flushQueueAndFetch();
          }
        } catch (_) {
          flushQueueAndFetch();
        }
      });

      es.onerror = function () {
        state.syncMode = navigator.onLine ? 'polling' : 'offline';
        updateSyncBadges();
      };
    } catch (_) {
      state.syncMode = 'polling';
      updateSyncBadges();
    }
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getCategory(id) {
    return state.workspace.categories.find(function (c) { return c.id === id; }) || {
      id: id || 'lainnya', name: id || 'Lainnya', icon: '📦', bucket: 'wants', color: '#64748b'
    };
  }

  function getWallet(id) {
    return state.workspace.wallets.find(function (w) { return w.id === id; }) || {
      id: id || 'tunai', name: id || 'Tunai', icon: '💳'
    };
  }

  function computeReport() {
    mergeLocalQueueIntoWorkspace();
    state.report = A.analyzeMonth(state.workspace, state.month, new Date());
    return state.report;
  }

  function renderDonutChart(categories, totalExpense) {
    const wrap = document.getElementById('donutChart');
    if (!categories.length || totalExpense <= 0) {
      wrap.innerHTML = '<div class="muted small">Belum ada data pengeluaran</div>';
      return;
    }
    const size = 170;
    const stroke = 26;
    const r = (size - stroke) / 2;
    const circ = 2 * Math.PI * r;
    let offset = 0;

    const slices = categories.slice(0, 6).map(function (c) {
      const pct = c.amount / totalExpense;
      const len = pct * circ;
      const seg = '<circle cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '" fill="none" stroke="' + escHtml(c.color) + '" stroke-width="' + stroke + '" stroke-dasharray="' + len.toFixed(2) + ' ' + circ.toFixed(2) + '" stroke-dashoffset="' + (-offset).toFixed(2) + '" transform="rotate(-90 ' + (size / 2) + ' ' + (size / 2) + ')" />';
      offset += len;
      return seg;
    }).join('');

    wrap.innerHTML =
      '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
      '<circle cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '" fill="none" stroke="rgba(148,163,184,0.14)" stroke-width="' + stroke + '" />' +
      slices +
      '<text x="50%" y="46%" text-anchor="middle" fill="#94a3b8" font-size="11">Total Keluar</text>' +
      '<text x="50%" y="58%" text-anchor="middle" fill="#f8fafc" font-size="13" font-weight="700">' + escHtml(A.formatIDR(totalExpense)) + '</text>' +
      '</svg>';
  }

  function renderDailyChart(dailySeries) {
    const wrap = document.getElementById('dailyChart');
    if (!dailySeries.length) {
      wrap.innerHTML = '<div class="muted small">Belum ada aktivitas transaksi pada bulan ini.</div>';
      return;
    }
    const maxVal = Math.max.apply(null, dailySeries.map(function (d) { return Math.max(d.expense, d.income, 1); }));
    const h = 180;
    const w = Math.max(320, dailySeries.length * 26);
    const barW = Math.max(6, Math.min(14, Math.floor((w - 20) / (dailySeries.length * 2.4))));

    const bars = dailySeries.map(function (d, idx) {
      const x = 12 + idx * (barW * 2 + 6);
      const expH = Math.round((d.expense / maxVal) * (h - 32));
      const incH = Math.round((d.income / maxVal) * (h - 32));
      const dayNum = d.date.slice(8, 10);
      return (
        '<g>' +
        '<title>' + d.date + ' | Masuk: ' + A.formatIDR(d.income) + ' | Keluar: ' + A.formatIDR(d.expense) + '</title>' +
        '<rect x="' + x + '" y="' + (h - 22 - incH) + '" width="' + barW + '" height="' + incH + '" rx="3" fill="#22c55e" opacity="0.85" />' +
        '<rect x="' + (x + barW + 2) + '" y="' + (h - 22 - expH) + '" width="' + barW + '" height="' + expH + '" rx="3" fill="#fb7185" opacity="0.9" />' +
        '<text x="' + (x + barW) + '" y="' + (h - 6) + '" text-anchor="middle" fill="#94a3b8" font-size="10">' + dayNum + '</text>' +
        '</g>'
      );
    }).join('');

    wrap.innerHTML = '<svg viewBox="0 0 ' + w + ' ' + h + '" style="width:100%;height:' + h + 'px;overflow:visible">' + bars + '</svg>';
  }

  function renderTxItem(tx, withActions) {
    const cat = getCategory(tx.category);
    const w = getWallet(tx.wallet);
    const toW = tx.toWallet ? getWallet(tx.toWallet) : null;
    const amtSign = tx.type === 'income' ? '+' : (tx.type === 'expense' ? '-' : '⇄ ');
    const amtClass = tx.type === 'income' ? 'text-green' : (tx.type === 'expense' ? 'text-red' : 'muted');
    const title = tx.note || (tx.type === 'transfer' ? ('Transfer ' + w.name + ' → ' + (toW ? toW.name : '')) : cat.name);
    const subParts = [tx.date, tx.type === 'transfer' ? (w.icon + ' ' + w.name + ' → ' + (toW ? toW.name : '')) : (cat.name + ' · ' + w.icon + ' ' + w.name)];

    return (
      '<div class="tx-item">' +
      '  <div class="tx-left">' +
      '    <div class="tx-icon">' + escHtml(tx.type === 'transfer' ? '🔁' : cat.icon) + '</div>' +
      '    <div class="tx-meta">' +
      '      <div class="tx-title">' + escHtml(title) + '</div>' +
      '      <div class="tx-sub"><span>' + escHtml(subParts.join(' · ')) + '</span><span class="device-tag">' + escHtml(tx.device || 'web') + '</span></div>' +
      '    </div>' +
      '  </div>' +
      '  <div class="tx-right">' +
      '    <span class="tx-amount ' + amtClass + '">' + amtSign + A.formatIDR(tx.amount) + '</span>' +
      (withActions
        ? '<div class="tx-actions">' +
          '<button class="icon-btn" data-edit-tx="' + escHtml(tx.id) + '" title="Edit">✏️</button>' +
          '<button class="icon-btn" data-del-tx="' + escHtml(tx.id) + '" title="Hapus">🗑️</button>' +
          '</div>'
        : '') +
      '  </div>' +
      '</div>'
    );
  }

  function renderRecommendationsList(recs, containerId, limit) {
    const el = document.getElementById(containerId);
    const list = limit ? recs.slice(0, limit) : recs;
    el.innerHTML = list.map(function (r) {
      return (
        '<div class="rec-card ' + escHtml(r.priority) + '">' +
        '  <div class="rec-title">' + escHtml(r.title) + '</div>' +
        '  <div class="rec-summary">' + escHtml(r.summary) + '</div>' +
        '  <div class="rec-action"><strong>Saran:</strong> ' + escHtml(r.action) + '</div>' +
        '</div>'
      );
    }).join('');
  }

  function renderDashboard(report) {
    const s = report.summary;
    document.getElementById('kpiIncome').textContent = A.formatIDR(s.totalIncome);
    document.getElementById('kpiIncomeSub').textContent = s.prevTotalIncome > 0 ? ('Bulan lalu: ' + A.formatIDR(s.prevTotalIncome)) : 'Pemasukan bulan ini';
    document.getElementById('kpiExpense').textContent = A.formatIDR(s.totalExpense);
    document.getElementById('kpiExpenseSub').textContent = s.expenseDeltaPct !== null
      ? ((s.expenseDeltaPct >= 0 ? '+' : '') + s.expenseDeltaPct + '% vs bulan lalu')
      : ('Rata-rata ' + A.formatIDR(s.avgDailySpend) + '/hari');

    const cashEl = document.getElementById('kpiCashflow');
    cashEl.textContent = A.formatIDR(s.netCashflow);
    cashEl.className = 'kpi-value ' + (s.netCashflow >= 0 ? 'text-green' : 'text-red');
    document.getElementById('kpiSavingsRate').textContent = 'Rasio tabungan ' + s.savingsRate + '% (Target ' + (state.workspace.targetSavingsRate || 20) + '%)';

    document.getElementById('kpiSafeDaily').textContent = A.formatIDR(s.safeDailySpend);
    document.getElementById('kpiSafeDailySub').textContent = 'Untuk ' + s.remainingDays + ' hari tersisa';
    document.getElementById('workspaceLabel').textContent = 'Workspace: ' + state.config.workspaceId;

    document.getElementById('emptyBanner').classList.toggle('hidden', s.transactionCount > 0);

    document.getElementById('walletStrip').innerHTML = report.walletBalances.map(function (w) {
      return (
        '<div class="wallet-card">' +
        '  <div><div class="wallet-name">' + escHtml(w.icon + ' ' + w.name) + '</div>' +
        '  <div class="wallet-bal">' + A.formatIDR(w.balance) + '</div></div>' +
        '  <div class="small muted">-' + A.formatIDR(w.expense) + '</div>' +
        '</div>'
      );
    }).join('');

    const expenseCats = report.categoryBreakdown.filter(function (c) { return c.bucket !== 'savings'; });
    renderDonutChart(expenseCats, s.totalExpense);

    const topCatsEl = document.getElementById('topCategoriesList');
    if (!expenseCats.length) {
      topCatsEl.innerHTML = '<div class="muted small">Belum ada pengeluaran tercatat.</div>';
    } else {
      topCatsEl.innerHTML = expenseCats.slice(0, 5).map(function (c) {
        return (
          '<div class="cat-bar-item">' +
          '  <div class="cat-bar-head"><span>' + escHtml(c.icon + ' ' + c.name) + '</span><span><strong>' + A.formatIDR(c.amount) + '</strong> (' + c.sharePct + '%)</span></div>' +
          '  <div class="bar-track"><div class="bar-fill" style="width:' + Math.min(100, c.sharePct) + '%;background:' + escHtml(c.color) + '"></div></div>' +
          '</div>'
        );
      }).join('');
    }

    renderDailyChart(report.dailySeries);
    renderRecommendationsList(report.recommendations, 'dashboardRecs', 3);

    const monthTx = state.workspace.transactions.filter(function (t) {
      return !t.deleted && (t.date || '').slice(0, 7) === state.month;
    });
    const recentEl = document.getElementById('recentTxList');
    recentEl.innerHTML = monthTx.length
      ? monthTx.slice(0, 5).map(function (t) { return renderTxItem(t, false); }).join('')
      : '<div class="muted small">Belum ada transaksi di bulan ' + escHtml(state.month) + '.</div>';
  }

  function renderTransactionsTab() {
    const search = (document.getElementById('filterSearch').value || '').toLowerCase();
    const fType = document.getElementById('filterType').value;
    const fCat = document.getElementById('filterCategory').value;
    const fWallet = document.getElementById('filterWallet').value;

    const filtered = state.workspace.transactions.filter(function (t) {
      if (t.deleted) return false;
      if ((t.date || '').slice(0, 7) !== state.month) return false;
      if (fType !== 'all' && t.type !== fType) return false;
      if (fCat !== 'all' && t.category !== fCat) return false;
      if (fWallet !== 'all' && t.wallet !== fWallet) return false;
      if (search) {
        const catName = getCategory(t.category).name.toLowerCase();
        const note = (t.note || '').toLowerCase();
        if (!catName.includes(search) && !note.includes(search)) return false;
      }
      return true;
    });

    let sumIn = 0;
    let sumOut = 0;
    filtered.forEach(function (t) {
      if (t.type === 'income') sumIn += Number(t.amount) || 0;
      if (t.type === 'expense') sumOut += Number(t.amount) || 0;
    });

    document.getElementById('txSummaryBar').innerHTML =
      '<span><strong>' + filtered.length + '</strong> transaksi</span>' +
      '<span class="text-green">Masuk: <strong>' + A.formatIDR(sumIn) + '</strong></span>' +
      '<span class="text-red">Keluar: <strong>' + A.formatIDR(sumOut) + '</strong></span>';

    const listEl = document.getElementById('allTxList');
    listEl.innerHTML = filtered.length
      ? filtered.map(function (t) { return renderTxItem(t, true); }).join('')
      : '<div class="muted small">Tidak ada transaksi yang cocok dengan filter.</div>';
  }

  function renderRekapTab(report) {
    const r = report.rule503020;
    const rows503020 = [
      { label: 'Kebutuhan Pokok (Needs)', pct: r.needsPct, target: 'Ideal ≤ 50%', amt: r.needsAmount, color: '#3b82f6' },
      { label: 'Gaya Hidup / Keinginan (Wants)', pct: r.wantsPct, target: 'Ideal ≤ 30%', amt: r.wantsAmount, color: r.wantsPct > 30 ? '#f43f5e' : '#f59e0b' },
      { label: 'Tabungan & Investasi (Savings)', pct: r.savingsPct, target: 'Ideal ≥ 20%', amt: r.savingsAmount, color: '#10b981' }
    ];

    document.getElementById('rule503020Box').innerHTML = rows503020.map(function (row) {
      return (
        '<div class="rule-row">' +
        '  <div class="rule-head"><span>' + escHtml(row.label) + ' <small class="muted">(' + row.target + ')</small></span><strong>' + row.pct + '% · ' + A.formatIDR(row.amt) + '</strong></div>' +
        '  <div class="bar-track"><div class="bar-fill" style="width:' + Math.min(100, row.pct) + '%;background:' + row.color + '"></div></div>' +
        '</div>'
      );
    }).join('');

    const topEl = document.getElementById('topExpensesBox');
    topEl.innerHTML = report.topExpenses.length
      ? report.topExpenses.map(function (e) {
          return (
            '<div class="tx-item">' +
            '  <div class="tx-left"><div class="tx-icon">' + escHtml(e.icon) + '</div>' +
            '  <div class="tx-meta"><div class="tx-title">' + escHtml(e.note) + '</div><div class="tx-sub">' + escHtml(e.date + ' · ' + e.categoryName) + '</div></div></div>' +
            '  <span class="tx-amount text-red">-' + A.formatIDR(e.amount) + '</span>' +
            '</div>'
          );
        }).join('')
      : '<div class="muted small">Belum ada pengeluaran tercatat.</div>';

    const expenseCats = state.workspace.categories.filter(function (c) { return c.type === 'expense'; });
    const mapBreakdown = {};
    report.categoryBreakdown.forEach(function (b) { mapBreakdown[b.id] = b; });

    document.getElementById('categoryBudgetTable').innerHTML = expenseCats.map(function (cat) {
      const info = mapBreakdown[cat.id] || { amount: 0, count: 0, sharePct: 0 };
      const budget = Number(state.workspace.budgets[cat.id]) || 0;
      const pct = budget > 0 ? Math.round((info.amount / budget) * 100) : 0;
      const barColor = pct > 100 ? '#f43f5e' : (pct >= 80 ? '#f59e0b' : '#10b981');
      return (
        '<div class="budget-row">' +
        '  <div><strong>' + escHtml(cat.icon + ' ' + cat.name) + '</strong><div class="small muted">' + info.count + ' transaksi · ' + info.sharePct + '% dari pengeluaran</div></div>' +
        '  <div><div>Terpakai: <strong>' + A.formatIDR(info.amount) + '</strong></div><div class="small muted">' + (budget > 0 ? (pct + '% dari budget') : 'Belum ada batas budget') + '</div></div>' +
        '  <div><div class="bar-track"><div class="bar-fill" style="width:' + Math.min(100, pct) + '%;background:' + barColor + '"></div></div></div>' +
        '  <div><input type="number" min="0" step="50000" data-budget-cat="' + escHtml(cat.id) + '" value="' + (budget || '') + '" placeholder="Batas budget (Rp)" /></div>' +
        '</div>'
      );
    }).join('');
  }

  function renderRekomendasiTab(report) {
    const score = report.summary.healthScore;
    document.getElementById('healthScoreValue').textContent = String(score);
    const circle = document.getElementById('healthScoreCircle');
    circle.style.borderColor = score >= 75 ? '#10b981' : (score >= 50 ? '#f59e0b' : '#f43f5e');

    let label = 'Perlu Perhatian Segera';
    if (score >= 80) label = 'Sangat Sehat & Terkendali';
    else if (score >= 60) label = 'Cukup Baik, Masih Bisa Dioptimalkan';
    else if (report.summary.transactionCount === 0) label = 'Menunggu Data Transaksi';
    document.getElementById('healthScoreTitle').textContent = 'Skor Kesehatan Keuangan: ' + label;

    renderRecommendationsList(report.recommendations, 'fullRecommendationsList');

    const planEl = document.getElementById('nextMonthPlanList');
    planEl.innerHTML = report.nextMonthPlan.length
      ? report.nextMonthPlan.map(function (p) {
          return (
            '<div class="plan-item">' +
            '  <div><strong>' + escHtml(p.icon + ' ' + p.name) + '</strong><div class="small muted">' + escHtml(p.rationale) + ' (Saat ini: ' + A.formatIDR(p.currentAmount) + ')</div></div>' +
            '  <div class="text-emerald"><strong>' + A.formatIDR(p.suggestedBudget) + '</strong></div>' +
            '</div>'
          );
        }).join('')
      : '<div class="muted small">Tambahkan beberapa transaksi pengeluaran terlebih dahulu untuk mendapatkan proyeksi budget bulan depan.</div>';
  }

  function populateSelectOptions() {
    const catFilter = document.getElementById('filterCategory');
    const walletFilter = document.getElementById('filterWallet');
    const txWallet = document.getElementById('txWallet');
    const txToWallet = document.getElementById('txToWallet');

    catFilter.innerHTML = '<option value="all">Semua Kategori</option>' +
      state.workspace.categories.map(function (c) {
        return '<option value="' + escHtml(c.id) + '">' + escHtml(c.icon + ' ' + c.name) + '</option>';
      }).join('');

    const walletOpts = state.workspace.wallets.map(function (w) {
      return '<option value="' + escHtml(w.id) + '">' + escHtml(w.icon + ' ' + w.name) + '</option>';
    }).join('');
    walletFilter.innerHTML = '<option value="all">Semua Dompet</option>' + walletOpts;
    txWallet.innerHTML = walletOpts;
    txToWallet.innerHTML = walletOpts;
    if (state.workspace.wallets.length > 1) {
      txToWallet.value = state.workspace.wallets[1].id;
    }
  }

  function populateTxCategories(txType) {
    const sel = document.getElementById('txCategory');
    const targetType = txType === 'income' ? 'income' : 'expense';
    const cats = state.workspace.categories.filter(function (c) { return c.type === targetType; });
    sel.innerHTML = cats.map(function (c) {
      return '<option value="' + escHtml(c.id) + '">' + escHtml(c.icon + ' ' + c.name) + '</option>';
    }).join('');
  }

  function renderAll() {
    const report = computeReport();
    populateSelectOptions();
    renderDashboard(report);
    renderTransactionsTab();
    renderRekapTab(report);
    renderRekomendasiTab(report);
    updateSyncBadges();
  }

  function switchTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll('.tab-panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'tab-' + tab);
    });
    document.querySelectorAll('.nav-btn, .bnav-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
  }

  function openTxModal(tx) {
    const modal = document.getElementById('txModal');
    const type = (tx && tx.type) || 'expense';
    setModalType(type);
    document.getElementById('txModalTitle').textContent = tx ? 'Edit Transaksi' : 'Catat Transaksi';
    document.getElementById('txId').value = tx ? tx.id : '';
    document.getElementById('txAmount').value = tx ? tx.amount : '';
    document.getElementById('txDate').value = tx ? tx.date.slice(0, 10) : todayStr();
    document.getElementById('txNote').value = tx ? (tx.note || '') : '';
    if (tx && tx.category) document.getElementById('txCategory').value = tx.category;
    if (tx && tx.wallet) document.getElementById('txWallet').value = tx.wallet;
    if (tx && tx.toWallet) document.getElementById('txToWallet').value = tx.toWallet;
    modal.classList.remove('hidden');
    setTimeout(function () { document.getElementById('txAmount').focus(); }, 50);
  }

  function closeTxModal() {
    document.getElementById('txModal').classList.add('hidden');
  }

  function setModalType(type) {
    document.querySelectorAll('.type-pill').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-type') === type);
    });
    populateTxCategories(type);
    const isTransfer = type === 'transfer';
    document.getElementById('txCategoryWrap').classList.toggle('hidden', isTransfer);
    document.getElementById('txToWalletWrap').classList.toggle('hidden', !isTransfer);
    document.getElementById('txWalletLabel').textContent = isTransfer ? 'Dari Dompet' : 'Sumber Dompet';
  }

  async function submitTransaction(ev) {
    ev.preventDefault();
    const activeTypeBtn = document.querySelector('.type-pill.active');
    const type = activeTypeBtn ? activeTypeBtn.getAttribute('data-type') : 'expense';
    const amount = Number(document.getElementById('txAmount').value) || 0;
    if (amount <= 0) return showToast('Nominal harus lebih dari 0');

    const nowIso = new Date().toISOString();
    const txId = document.getElementById('txId').value || ('tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
    const tx = {
      id: txId,
      type: type,
      amount: Math.round(amount),
      category: type === 'transfer' ? 'lainnya' : document.getElementById('txCategory').value,
      wallet: document.getElementById('txWallet').value,
      toWallet: type === 'transfer' ? document.getElementById('txToWallet').value : undefined,
      date: document.getElementById('txDate').value || todayStr(),
      note: document.getElementById('txNote').value.trim(),
      device: state.device,
      deleted: false,
      updatedAt: nowIso
    };

    closeTxModal();
    state.pendingQueue.push(tx);
    saveLocalCache();
    renderAll();

    if (navigator.onLine) {
      await flushQueueAndFetch();
      showToast('Transaksi tersimpan & tersinkron');
    } else {
      showToast('Tersimpan offline — akan disinkronkan saat online');
    }
  }

  async function deleteTx(txId) {
    const existing = state.workspace.transactions.find(function (t) { return t.id === txId; });
    if (!existing) return;
    const tombstone = Object.assign({}, existing, { deleted: true, updatedAt: new Date().toISOString() });
    state.workspace.transactions = state.workspace.transactions.filter(function (t) { return t.id !== txId; });
    state.pendingQueue.push(tombstone);
    saveLocalCache();
    renderAll();

    if (navigator.onLine) {
      await flushQueueAndFetch();
      showToast('Transaksi dihapus');
    } else {
      showToast('Penghapusan disimpan ke antrean offline');
    }
  }

  async function loadLanInfo() {
    const box = document.getElementById('lanInfoBox');
    try {
      const health = await apiFetch('/api/health', { method: 'GET' });
      const urls = (health.lanUrls || []).map(function (u) {
        return '<code>' + escHtml(u + '?ws=' + state.config.workspaceId) + '</code>';
      });
      box.innerHTML = urls.length
        ? '<strong>Alamat Wi-Fi Lokal (buka di Chrome Android dalam 1 jaringan):</strong><br>' + urls.join('<br>')
        : 'Server berjalan di <code>' + escHtml(window.location.origin) + '</code>';
    } catch (_) {
      box.textContent = 'Sedang offline atau menggunakan cache lokal.';
    }
  }

  function shiftMonth(delta) {
    const parts = state.month.split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1 + delta, 1);
    state.month = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    document.getElementById('monthPicker').value = state.month;
    renderAll();
  }

  function exportCsv() {
    const rows = [['Tanggal', 'Tipe', 'Kategori', 'Dompet', 'Nominal', 'Catatan', 'Perangkat']];
    state.workspace.transactions.filter(function (t) { return !t.deleted; }).forEach(function (t) {
      rows.push([
        t.date,
        t.type,
        getCategory(t.category).name,
        getWallet(t.wallet).name,
        t.amount,
        '"' + String(t.note || '').replace(/"/g, '""') + '"',
        t.device || 'web'
      ]);
    });
    const csv = rows.map(function (r) { return r.join(','); }).join('\n');
    downloadFile('uangku-' + state.config.workspaceId + '.csv', csv, 'text/csv;charset=utf-8');
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function bindEvents() {
    document.querySelectorAll('[data-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-tab')); });
    });
    document.querySelectorAll('[data-jump]').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-jump')); });
    });

    document.getElementById('monthPicker').value = state.month;
    document.getElementById('monthPicker').addEventListener('change', function (e) {
      if (e.target.value) {
        state.month = e.target.value;
        renderAll();
      }
    });
    document.getElementById('btnPrevMonth').addEventListener('click', function () { shiftMonth(-1); });
    document.getElementById('btnNextMonth').addEventListener('click', function () { shiftMonth(1); });

    ['btnAddDesktop', 'btnAddMobile', 'btnAddTxTab', 'btnQuickAddEmpty'].forEach(function (id) {
      document.getElementById(id).addEventListener('click', function () { openTxModal(null); });
    });
    document.getElementById('btnCloseTxModal').addEventListener('click', closeTxModal);
    document.getElementById('btnCancelTx').addEventListener('click', closeTxModal);
    document.getElementById('txModalBackdrop').addEventListener('click', closeTxModal);

    document.querySelectorAll('.type-pill').forEach(function (btn) {
      btn.addEventListener('click', function () { setModalType(btn.getAttribute('data-type')); });
    });

    document.querySelectorAll('.quick-amounts .chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        const input = document.getElementById('txAmount');
        input.value = (Number(input.value) || 0) + Number(chip.getAttribute('data-amt'));
      });
    });

    document.getElementById('txForm').addEventListener('submit', submitTransaction);

    document.getElementById('allTxList').addEventListener('click', function (ev) {
      const editBtn = ev.target.closest('[data-edit-tx]');
      if (editBtn) {
        const tx = state.workspace.transactions.find(function (t) { return t.id === editBtn.getAttribute('data-edit-tx'); });
        if (tx) openTxModal(tx);
        return;
      }
      const delBtn = ev.target.closest('[data-del-tx]');
      if (delBtn) {
        deleteTx(delBtn.getAttribute('data-del-tx'));
      }
    });

    ['filterSearch', 'filterType', 'filterCategory', 'filterWallet'].forEach(function (id) {
      document.getElementById(id).addEventListener('input', renderTransactionsTab);
      document.getElementById(id).addEventListener('change', renderTransactionsTab);
    });

    document.getElementById('btnSaveBudgets').addEventListener('click', async function () {
      const newBudgets = {};
      document.querySelectorAll('[data-budget-cat]').forEach(function (inp) {
        const val = Number(inp.value) || 0;
        if (val > 0) newBudgets[inp.getAttribute('data-budget-cat')] = val;
      });
      state.workspace.budgets = newBudgets;
      saveLocalCache();
      renderAll();
      try {
        await apiFetch('/api/settings', { method: 'POST', body: JSON.stringify({ budgets: newBudgets }) });
        showToast('Budget berhasil disimpan & disinkronkan');
      } catch (_) {
        showToast('Budget tersimpan lokal');
      }
    });

    document.getElementById('btnApplyNextPlan').addEventListener('click', async function () {
      if (!state.report || !state.report.nextMonthPlan.length) return;
      const newBudgets = Object.assign({}, state.workspace.budgets);
      state.report.nextMonthPlan.forEach(function (p) {
        if (p.suggestedBudget > 0) newBudgets[p.categoryId] = p.suggestedBudget;
      });
      state.workspace.budgets = newBudgets;
      saveLocalCache();
      renderAll();
      try {
        await apiFetch('/api/settings', { method: 'POST', body: JSON.stringify({ budgets: newBudgets }) });
        showToast('Saran budget diterapkan!');
      } catch (_) {
        showToast('Saran budget diterapkan secara lokal');
      }
    });

    document.getElementById('btnCopyMarkdownRecap').addEventListener('click', function () {
      const md = A.renderMarkdownRecap(state.report);
      navigator.clipboard.writeText(md).then(function () {
        showToast('Rekap Markdown disalin ke clipboard');
      });
    });

    document.getElementById('btnDownloadMarkdownRecap').addEventListener('click', function () {
      const md = A.renderMarkdownRecap(state.report);
      downloadFile('rekap-uangku-' + state.month + '.md', md, 'text/markdown;charset=utf-8');
    });

    document.getElementById('btnExportCsv').addEventListener('click', exportCsv);
    document.getElementById('btnExportJson').addEventListener('click', function () {
      downloadFile('backup-uangku-' + state.config.workspaceId + '.json', JSON.stringify(state.workspace, null, 2), 'application/json');
    });

    document.getElementById('inputImportJson').addEventListener('change', async function (ev) {
      const file = ev.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed.transactions)) throw new Error('Format JSON tidak valid');
        state.pendingQueue = state.pendingQueue.concat(parsed.transactions);
        saveLocalCache();
        await flushQueueAndFetch();
        showToast('Data JSON berhasil diimpor!');
      } catch (err) {
        showToast('Gagal impor: ' + err.message);
      }
    });

    async function triggerDemoSeed() {
      try {
        const res = await apiFetch('/api/demo', { method: 'POST' });
        state.workspace = res;
        saveLocalCache();
        renderAll();
        showToast('Data contoh berhasil dimuat');
      } catch (err) {
        showToast('Gagal memuat contoh: ' + err.message);
      }
    }
    document.getElementById('btnLoadDemo').addEventListener('click', triggerDemoSeed);
    document.getElementById('btnSeedDemoSettings').addEventListener('click', triggerDemoSeed);

    document.getElementById('inputWorkspaceId').value = state.config.workspaceId;
    document.getElementById('inputServerUrl').value = state.config.serverUrl;
    document.getElementById('inputSavingsTarget').value = state.workspace.targetSavingsRate || 20;

    document.getElementById('syncForm').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      state.config.workspaceId = document.getElementById('inputWorkspaceId').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'pribadi';
      state.config.serverUrl = document.getElementById('inputServerUrl').value.trim().replace(/\/+$/, '');
      const pinVal = document.getElementById('inputWorkspacePin').value;
      const targetRate = Number(document.getElementById('inputSavingsTarget').value) || 20;
      if (pinVal) state.config.pin = pinVal;
      saveConfig(state.config);
      loadLocalCache();
      try {
        await apiFetch('/api/settings', {
          method: 'POST',
          body: JSON.stringify({ targetSavingsRate: targetRate, newPin: pinVal || undefined })
        });
      } catch (_) {}
      await flushQueueAndFetch();
      connectSse();
      loadLanInfo();
      showToast('Terhubung ke workspace "' + state.config.workspaceId + '"');
    });

    document.getElementById('btnCopyPairLink').addEventListener('click', function () {
      const url = new URL(window.location.origin);
      url.searchParams.set('ws', state.config.workspaceId);
      if (state.config.serverUrl) url.searchParams.set('server', state.config.serverUrl);
      navigator.clipboard.writeText(url.toString()).then(function () {
        showToast('Link pairing disalin! Buka link tersebut di Android.');
      });
    });

    document.getElementById('pinUnlockForm').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      state.config.pin = document.getElementById('pinUnlockInput').value;
      saveConfig(state.config);
      document.getElementById('pinModal').classList.add('hidden');
      await flushQueueAndFetch();
      connectSse();
    });

    document.getElementById('btnForceSync').addEventListener('click', function () {
      flushQueueAndFetch().then(function () { showToast('Data diperbarui'); });
    });

    window.addEventListener('online', function () {
      flushQueueAndFetch();
      connectSse();
    });
    window.addEventListener('offline', function () {
      state.syncMode = 'offline';
      updateSyncBadges();
    });

    // PWA Install prompt
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      document.getElementById('btnInstallPwaSidebar').classList.remove('hidden');
      document.getElementById('btnInstallPwaTop').classList.remove('hidden');
    });

    async function handleInstallClick() {
      if (!state.deferredInstallPrompt) return;
      state.deferredInstallPrompt.prompt();
      await state.deferredInstallPrompt.userChoice;
      state.deferredInstallPrompt = null;
      document.getElementById('btnInstallPwaSidebar').classList.add('hidden');
      document.getElementById('btnInstallPwaTop').classList.add('hidden');
    }
    document.getElementById('btnInstallPwaSidebar').addEventListener('click', handleInstallClick);
    document.getElementById('btnInstallPwaTop').addEventListener('click', handleInstallClick);
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    }
  }

  function handleQueryShortcuts() {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    if (tab) switchTab(tab);
    if (params.get('action') === 'add') openTxModal(null);
  }

  function init() {
    loadLocalCache();
    bindEvents();
    renderAll();
    registerServiceWorker();
    handleQueryShortcuts();
    flushQueueAndFetch();
    connectSse();
    loadLanInfo();
    setInterval(function () {
      if (navigator.onLine && state.syncMode !== 'live') {
        flushQueueAndFetch();
      }
    }, 20000);
  }

  init();
})();
