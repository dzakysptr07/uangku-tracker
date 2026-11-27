(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.UangKuAnalytics = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_CATEGORIES = [
    { id: 'makan', name: 'Makan & Minum', icon: '🍜', type: 'expense', bucket: 'needs', color: '#f97316' },
    { id: 'kopi', name: 'Kopi & Jajan', icon: '☕', type: 'expense', bucket: 'wants', color: '#eab308' },
    { id: 'transport', name: 'Transportasi', icon: '🛵', type: 'expense', bucket: 'needs', color: '#3b82f6' },
    { id: 'tagihan', name: 'Tagihan & Kos', icon: '🏠', type: 'expense', bucket: 'needs', color: '#8b5cf6' },
    { id: 'belanja', name: 'Belanja & Kebutuhan', icon: '🛒', type: 'expense', bucket: 'needs', color: '#14b8a6' },
    { id: 'hiburan', name: 'Hiburan & Langganan', icon: '🎬', type: 'expense', bucket: 'wants', color: '#ec4899' },
    { id: 'kesehatan', name: 'Kesehatan', icon: '💊', type: 'expense', bucket: 'needs', color: '#ef4444' },
    { id: 'pendidikan', name: 'Pendidikan & Buku', icon: '📚', type: 'expense', bucket: 'needs', color: '#06b6d4' },
    { id: 'tabungan', name: 'Tabungan & Investasi', icon: '💎', type: 'expense', bucket: 'savings', color: '#10b981' },
    { id: 'lainnya', name: 'Lain-lain', icon: '📦', type: 'expense', bucket: 'wants', color: '#64748b' },
    { id: 'gaji', name: 'Gaji & Utama', icon: '💼', type: 'income', bucket: 'income', color: '#22c55e' },
    { id: 'bonus', name: 'Bonus & Freelance', icon: '🚀', type: 'income', bucket: 'income', color: '#0ea5e9' },
    { id: 'invest_return', name: 'Hasil Investasi', icon: '📈', type: 'income', bucket: 'income', color: '#10b981' },
    { id: 'masuk_lain', name: 'Pemasukan Lain', icon: '🎁', type: 'income', bucket: 'income', color: '#84cc16' }
  ];

  const DEFAULT_WALLETS = [
    { id: 'tunai', name: 'Tunai / Dompet', icon: '💵', initialBalance: 0 },
    { id: 'bank', name: 'Rekening Bank', icon: '🏦', initialBalance: 0 },
    { id: 'ewallet', name: 'E-Wallet / QRIS', icon: '📱', initialBalance: 0 }
  ];

  function formatIDR(amount) {
    const n = Math.round(Number(amount) || 0);
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return sign + 'Rp' + abs;
  }

  function toMonthKey(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return '';
    return dateStr.slice(0, 7);
  }

  function getPreviousMonthKey(monthKey) {
    const parts = monthKey.split('-').map(Number);
    if (parts.length !== 2 || !parts[0] || !parts[1]) return '';
    let y = parts[0];
    let m = parts[1] - 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
    return String(y) + '-' + String(m).padStart(2, '0');
  }

  function daysInMonth(monthKey) {
    const parts = monthKey.split('-').map(Number);
    if (parts.length !== 2 || !parts[0] || !parts[1]) return 30;
    return new Date(parts[0], parts[1], 0).getDate();
  }

  function buildCategoryMap(categories) {
    const map = {};
    const list = Array.isArray(categories) && categories.length ? categories : DEFAULT_CATEGORIES;
    for (let i = 0; i < list.length; i++) {
      map[list[i].id] = list[i];
    }
    return map;
  }

  function computeWalletBalances(transactions, wallets) {
    const walletList = Array.isArray(wallets) && wallets.length ? wallets : DEFAULT_WALLETS;
    const balances = {};
    for (let i = 0; i < walletList.length; i++) {
      const w = walletList[i];
      balances[w.id] = {
        id: w.id,
        name: w.name,
        icon: w.icon || '💳',
        balance: Number(w.initialBalance) || 0,
        income: 0,
        expense: 0
      };
    }

    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      if (tx.deleted) continue;
      const amt = Number(tx.amount) || 0;
      const wId = tx.wallet || 'tunai';
      if (!balances[wId]) {
        balances[wId] = { id: wId, name: wId, icon: '💳', balance: 0, income: 0, expense: 0 };
      }
      if (tx.type === 'income') {
        balances[wId].balance += amt;
        balances[wId].income += amt;
      } else if (tx.type === 'expense') {
        balances[wId].balance -= amt;
        balances[wId].expense += amt;
      } else if (tx.type === 'transfer') {
        balances[wId].balance -= amt;
        const toW = tx.toWallet || 'bank';
        if (!balances[toW]) {
          balances[toW] = { id: toW, name: toW, icon: '💳', balance: 0, income: 0, expense: 0 };
        }
        balances[toW].balance += amt;
      }
    }

    return Object.keys(balances).map(function (k) { return balances[k]; });
  }

  /**
   * Generates a complete financial recap & future recommendations for a target month (YYYY-MM).
   */
  function analyzeMonth(data, targetMonth, nowDate) {
    const now = nowDate instanceof Date ? nowDate : new Date();
    const monthKey = targetMonth || (now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0'));
    const prevMonthKey = getPreviousMonthKey(monthKey);

    const allTx = (data && Array.isArray(data.transactions) ? data.transactions : []).filter(function (t) {
      return t && !t.deleted;
    });
    const categories = (data && Array.isArray(data.categories) && data.categories.length)
      ? data.categories
      : DEFAULT_CATEGORIES;
    const catMap = buildCategoryMap(categories);
    const budgets = (data && data.budgets) || {};
    const wallets = (data && data.wallets) || DEFAULT_WALLETS;
    const monthlyGoalSavingsRate = (data && Number(data.targetSavingsRate)) || 20;

    const currentTx = allTx.filter(function (t) { return toMonthKey(t.date) === monthKey; });
    const prevTx = allTx.filter(function (t) { return toMonthKey(t.date) === prevMonthKey; });

    let totalIncome = 0;
    let totalExpense = 0;
    let totalSavedCategory = 0;
    const categoryTotals = {};
    const walletSpending = {};
    const dailyTotals = {};
    const bucketTotals = { needs: 0, wants: 0, savings: 0 };

    for (let i = 0; i < currentTx.length; i++) {
      const tx = currentTx[i];
      const amt = Number(tx.amount) || 0;
      const day = (tx.date || '').slice(0, 10);
      if (day && !dailyTotals[day]) {
        dailyTotals[day] = { date: day, income: 0, expense: 0 };
      }

      if (tx.type === 'income') {
        totalIncome += amt;
        if (day) dailyTotals[day].income += amt;
      } else if (tx.type === 'expense') {
        const cat = catMap[tx.category] || { id: tx.category || 'lainnya', name: tx.category || 'Lainnya', icon: '📦', bucket: 'wants', color: '#64748b' };
        const bucket = cat.bucket || 'wants';

        if (bucket === 'savings') {
          totalSavedCategory += amt;
          bucketTotals.savings += amt;
        } else {
          totalExpense += amt;
          if (day) dailyTotals[day].expense += amt;
          if (bucket === 'needs') bucketTotals.needs += amt;
          else bucketTotals.wants += amt;
        }

        if (!categoryTotals[cat.id]) {
          categoryTotals[cat.id] = {
            id: cat.id,
            name: cat.name,
            icon: cat.icon,
            color: cat.color || '#64748b',
            bucket: bucket,
            amount: 0,
            count: 0,
            budget: Number(budgets[cat.id]) || 0
          };
        }
        categoryTotals[cat.id].amount += amt;
        categoryTotals[cat.id].count += 1;

        const wId = tx.wallet || 'tunai';
        walletSpending[wId] = (walletSpending[wId] || 0) + amt;
      }
    }

    // Previous month category totals for comparison
    let prevTotalExpense = 0;
    let prevTotalIncome = 0;
    const prevCategoryTotals = {};
    for (let i = 0; i < prevTx.length; i++) {
      const tx = prevTx[i];
      const amt = Number(tx.amount) || 0;
      if (tx.type === 'income') {
        prevTotalIncome += amt;
      } else if (tx.type === 'expense') {
        const cat = catMap[tx.category] || { id: tx.category || 'lainnya', bucket: 'wants' };
        if (cat.bucket !== 'savings') {
          prevTotalExpense += amt;
        }
        prevCategoryTotals[cat.id] = (prevCategoryTotals[cat.id] || 0) + amt;
      }
    }

    const totalOutflowWithSavings = totalExpense + totalSavedCategory;
    const netCashflow = totalIncome - totalExpense;
    const effectiveSavings = Math.max(0, netCashflow); // includes unspent cashflow + explicit savings category
    const savingsRate = totalIncome > 0 ? Math.round((effectiveSavings / totalIncome) * 1000) / 10 : 0;

    // Build sorted category breakdown (excluding or tagging savings)
    const categoryBreakdown = Object.keys(categoryTotals)
      .map(function (id) {
        const item = categoryTotals[id];
        const base = item.bucket === 'savings' ? Math.max(totalOutflowWithSavings, 1) : Math.max(totalExpense, 1);
        const prevAmt = prevCategoryTotals[id] || 0;
        const deltaPct = prevAmt > 0 ? Math.round(((item.amount - prevAmt) / prevAmt) * 100) : null;
        const budgetUsedPct = item.budget > 0 ? Math.round((item.amount / item.budget) * 100) : null;
        return Object.assign({}, item, {
          sharePct: item.bucket === 'savings' ? 0 : Math.round((item.amount / base) * 1000) / 10,
          prevAmount: prevAmt,
          deltaPct: deltaPct,
          budgetUsedPct: budgetUsedPct
        });
      })
      .sort(function (a, b) { return b.amount - a.amount; });

    const expenseCategories = categoryBreakdown.filter(function (c) { return c.bucket !== 'savings'; });

    // Top 5 largest single expenses
    const topExpenses = currentTx
      .filter(function (t) {
        const c = catMap[t.category];
        return t.type === 'expense' && (!c || c.bucket !== 'savings');
      })
      .sort(function (a, b) { return (Number(b.amount) || 0) - (Number(a.amount) || 0); })
      .slice(0, 5)
      .map(function (t) {
        const c = catMap[t.category] || { name: t.category || 'Lainnya', icon: '📦' };
        return {
          id: t.id,
          date: t.date,
          note: t.note || c.name,
          categoryName: c.name,
          icon: c.icon,
          amount: Number(t.amount) || 0,
          wallet: t.wallet
        };
      });

    // Safe-to-spend daily limit
    const totalDays = daysInMonth(monthKey);
    const currentMonthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    let remainingDays = totalDays;
    let elapsedDays = totalDays;
    if (monthKey === currentMonthKey) {
      const today = now.getDate();
      elapsedDays = Math.max(1, today);
      remainingDays = Math.max(1, totalDays - today + 1);
    }

    const totalBudgetCap = Object.keys(budgets).reduce(function (acc, k) {
      const c = catMap[k];
      if (c && c.bucket === 'savings') return acc;
      return acc + (Number(budgets[k]) || 0);
    }, 0);

    const targetMonthlySpend = totalIncome > 0
      ? Math.round(totalIncome * (1 - monthlyGoalSavingsRate / 100))
      : (totalBudgetCap > 0 ? totalBudgetCap : totalExpense);

    const remainingSpendRoom = targetMonthlySpend - totalExpense;
    const safeDailySpend = (currentTx.length > 0 && remainingSpendRoom > 0)
      ? Math.floor(remainingSpendRoom / remainingDays)
      : 0;
    const avgDailySpend = Math.round(totalExpense / Math.max(1, elapsedDays));

    // 50 / 30 / 20 ratios (relative to income if available, otherwise relative to total outflow)
    const ratioBase = totalIncome > 0 ? totalIncome : Math.max(1, totalOutflowWithSavings);
    const needsPct = Math.round((bucketTotals.needs / ratioBase) * 1000) / 10;
    const wantsPct = Math.round((bucketTotals.wants / ratioBase) * 1000) / 10;
    const savingsBucketPct = totalIncome > 0
      ? Math.max(0, Math.round((effectiveSavings / totalIncome) * 1000) / 10)
      : Math.round((bucketTotals.savings / ratioBase) * 1000) / 10;

    // Financial Health Score (0 - 100)
    let healthScore = 50;
    if (currentTx.length === 0) {
      healthScore = 0;
    } else {
      let score = 40;
      if (totalIncome > 0) {
        if (savingsRate >= 20) score += 30;
        else if (savingsRate >= 10) score += 20;
        else if (savingsRate > 0) score += 10;
        else score -= 15;
      }
      if (wantsPct <= 30) score += 15;
      else if (wantsPct <= 40) score += 5;
      else score -= 10;

      const overBudgetCount = expenseCategories.filter(function (c) { return c.budget > 0 && c.amount > c.budget; }).length;
      if (overBudgetCount === 0) score += 15;
      else score -= Math.min(20, overBudgetCount * 7);

      healthScore = Math.max(0, Math.min(100, Math.round(score)));
    }

    // Generate Smart Recommendations
    const recommendations = [];

    if (currentTx.length === 0) {
      recommendations.push({
        priority: 'info',
        title: 'Mulai Catat Transaksi Bulan Ini',
        summary: 'Belum ada transaksi tercatat di periode ' + monthKey + '. Catat pemasukan dan pengeluaran harianmu agar analisis dan rekomendasi berjalan akurat.',
        action: 'Tambahkan pemasukan utama dan minimal 3 transaksi pengeluaran hari ini.'
      });
    } else {
      // 1. Cashflow / Savings Rate check
      if (totalIncome > 0 && netCashflow < 0) {
        recommendations.push({
          priority: 'high',
          title: 'Pengeluaran Melebihi Pemasukan (' + formatIDR(Math.abs(netCashflow)) + ' Defisit)',
          summary: 'Total pengeluaran bulan ini (' + formatIDR(totalExpense) + ') sudah melampaui pemasukan (' + formatIDR(totalIncome) + ').',
          action: 'Hentikan sementara pengeluaran kategori Keinginan (wants) dan evaluasi kategori terbesar: ' + (expenseCategories[0] ? expenseCategories[0].name : '-') + '.'
        });
      } else if (totalIncome > 0 && savingsRate < monthlyGoalSavingsRate) {
        const gap = Math.round((totalIncome * (monthlyGoalSavingsRate / 100)) - effectiveSavings);
        recommendations.push({
          priority: 'medium',
          title: 'Tingkatkan Rasio Tabungan Menuju ' + monthlyGoalSavingsRate + '%',
          summary: 'Rasio tabungan saat ini ' + savingsRate + '% (' + formatIDR(effectiveSavings) + '). Kamu butuh menghemat sekitar ' + formatIDR(gap) + ' lagi agar mencapai target ' + monthlyGoalSavingsRate + '%.',
          action: 'Sisihkan tabungan di awal saat menerima gaji (metode Pay Yourself First) sebesar ' + formatIDR(Math.round(totalIncome * (monthlyGoalSavingsRate / 100))) + '.'
        });
      } else if (totalIncome > 0) {
        recommendations.push({
          priority: 'good',
          title: 'Arus Kas Sehat — Rasio Tabungan ' + savingsRate + '%',
          summary: 'Selamat! Kamu berhasil menyisihkan ' + formatIDR(effectiveSavings) + ' (' + savingsRate + '% dari pemasukan) bulan ini.',
          action: 'Pertahankan batas belanja harian maksimal ' + formatIDR(safeDailySpend) + '/hari hingga akhir bulan, dan alokasikan kelebihan ke dana darurat/investasi.'
        });
      }

      // 2. Dominant Category / Pareto Warning
      if (expenseCategories.length > 0 && totalExpense > 0) {
        const topCat = expenseCategories[0];
        if (topCat.sharePct >= 35) {
          const suggestedCut = Math.round(topCat.amount * 0.15);
          recommendations.push({
            priority: 'medium',
            title: topCat.icon + ' ' + topCat.name + ' Menyerap ' + topCat.sharePct + '% Pengeluaran',
            summary: 'Pos pengeluaran terbesar adalah ' + topCat.name + ' sebesar ' + formatIDR(topCat.amount) + ' (' + topCat.count + ' transaksi).',
            action: 'Jika bulan depan kamu memangkas 15% pos ini, kamu bisa berhemat ekstra ' + formatIDR(suggestedCut) + '/bulan.'
          });
        }
      }

      // 3. Budget Overrun / Near-Limit Warning
      const overCats = expenseCategories.filter(function (c) { return c.budget > 0 && c.amount > c.budget; });
      const nearCats = expenseCategories.filter(function (c) { return c.budget > 0 && c.amount <= c.budget && c.budgetUsedPct >= 80; });

      if (overCats.length > 0) {
        const names = overCats.map(function (c) { return c.name + ' (' + c.budgetUsedPct + '%)'; }).join(', ');
        recommendations.push({
          priority: 'high',
          title: 'Anggaran Terlampaui di ' + overCats.length + ' Kategori',
          summary: 'Kategori yang sudah melewati batas budget bulan ini: ' + names + '.',
          action: 'Bekukan belanja non-esensial pada kategori tersebut dan revisi batas budget bulan depan agar lebih realistis.'
        });
      } else if (nearCats.length > 0) {
        const names = nearCats.map(function (c) { return c.name + ' (' + c.budgetUsedPct + '%)'; }).join(', ');
        recommendations.push({
          priority: 'medium',
          title: 'Mendekati Batas Anggaran',
          summary: 'Kategori ' + names + ' sudah memakai ≥80% anggaran bulanan.',
          action: 'Gunakan sisa anggaran secara ketat dengan batas harian ' + formatIDR(safeDailySpend) + '/hari.'
        });
      }

      // 4. 50/30/20 Wants Check
      if (wantsPct > 30) {
        const excessWants = Math.round(bucketTotals.wants - (ratioBase * 0.30));
        recommendations.push({
          priority: 'medium',
          title: 'Pengeluaran Gaya Hidup (Wants) ' + wantsPct + '% (Ideal ≤ 30%)',
          summary: 'Total pengeluaran kategori keinginan/gaya hidup mencapai ' + formatIDR(bucketTotals.wants) + '.',
          action: 'Kurangi sekitar ' + formatIDR(excessWants) + ' pada pos kopi/jajan, hiburan, atau belanja impulsif bulan depan.'
        });
      }

      // 5. Frequent Small Spending ("Latte Factor")
      const smallFrequent = expenseCategories.filter(function (c) {
        return c.count >= 5 && (c.amount / c.count) <= 75000 && c.bucket === 'wants';
      });
      if (smallFrequent.length > 0) {
        const f = smallFrequent[0];
        const avgTicket = Math.round(f.amount / f.count);
        recommendations.push({
          priority: 'info',
          title: 'Deteksi Kebiasaan Kecil Berulang: ' + f.name,
          summary: 'Tercatat ' + f.count + ' transaksi kecil (rata-rata ' + formatIDR(avgTicket) + ') dengan total ' + formatIDR(f.amount) + '.',
          action: 'Terapkan aturan "minggu tanpa jajan" 2 hari/minggu untuk memangkas 25% pos ini (' + formatIDR(Math.round(f.amount * 0.25)) + ').'
        });
      }

      // 6. Month-over-month spike
      const spiked = expenseCategories.filter(function (c) { return c.deltaPct !== null && c.deltaPct >= 25 && c.amount >= 100000; });
      if (spiked.length > 0) {
        const s = spiked[0];
        recommendations.push({
          priority: 'medium',
          title: 'Lonjakan +' + s.deltaPct + '% di ' + s.name + ' vs Bulan Lalu',
          summary: 'Bulan lalu ' + formatIDR(s.prevAmount) + ', bulan ini naik menjadi ' + formatIDR(s.amount) + '.',
          action: 'Cek kembali daftar transaksi ' + s.name + ' untuk memastikan tidak ada biaya langganan/kebocoran yang terlewat.'
        });
      }

      // 7. Emergency Fund Projection
      if (totalExpense > 0) {
        const emergencyTarget = totalExpense * 3;
        const monthlySave = effectiveSavings > 0 ? effectiveSavings : Math.round((totalIncome || totalExpense) * 0.15);
        const monthsNeeded = monthlySave > 0 ? Math.ceil(emergencyTarget / monthlySave) : null;
        recommendations.push({
          priority: 'info',
          title: 'Proyeksi Dana Darurat Minimal (3x Pengeluaran)',
          summary: 'Dengan pola pengeluaran ' + formatIDR(totalExpense) + '/bulan, target dana darurat awalmu adalah ' + formatIDR(emergencyTarget) + '.',
          action: monthsNeeded
            ? 'Dengan tabungan ' + formatIDR(monthlySave) + '/bulan, target ini tercapai dalam ~' + monthsNeeded + ' bulan.'
            : 'Tetapkan target tabungan bulanan agar proyeksi dana darurat dapat dihitung.'
        });
      }
    }

    // Suggested Next-Month Budget Plan
    const nextMonthPlan = expenseCategories.map(function (c) {
      let suggested = c.amount;
      let rationale = 'Pertahankan sesuai pola bulan ini';
      if (c.bucket === 'wants' && (wantsPct > 30 || (c.deltaPct !== null && c.deltaPct > 15))) {
        suggested = Math.round((c.amount * 0.85) / 10000) * 10000;
        rationale = 'Pangkas 15% untuk efisiensi gaya hidup';
      } else if (c.budget > 0 && c.amount > c.budget) {
        suggested = Math.round(((c.budget + c.amount) / 2) / 10000) * 10000;
        rationale = 'Penyesuaian moderat antara budget lama & realisasi';
      } else if (c.budget > 0) {
        suggested = c.budget;
        rationale = 'Sesuai anggaran yang sudah ditetapkan';
      }
      return {
        categoryId: c.id,
        name: c.name,
        icon: c.icon,
        currentAmount: c.amount,
        suggestedBudget: Math.max(0, suggested),
        rationale: rationale
      };
    });

    const dailySeries = Object.keys(dailyTotals).sort().map(function (d) { return dailyTotals[d]; });
    const walletBalances = computeWalletBalances(allTx, wallets);

    return {
      month: monthKey,
      previousMonth: prevMonthKey,
      summary: {
        totalIncome: totalIncome,
        totalExpense: totalExpense,
        totalSavedCategory: totalSavedCategory,
        netCashflow: netCashflow,
        effectiveSavings: effectiveSavings,
        savingsRate: savingsRate,
        prevTotalIncome: prevTotalIncome,
        prevTotalExpense: prevTotalExpense,
        expenseDeltaPct: prevTotalExpense > 0 ? Math.round(((totalExpense - prevTotalExpense) / prevTotalExpense) * 100) : null,
        avgDailySpend: avgDailySpend,
        safeDailySpend: safeDailySpend,
        remainingDays: remainingDays,
        transactionCount: currentTx.length,
        healthScore: healthScore
      },
      rule503020: {
        needsAmount: bucketTotals.needs,
        wantsAmount: bucketTotals.wants,
        savingsAmount: effectiveSavings,
        needsPct: needsPct,
        wantsPct: wantsPct,
        savingsPct: savingsBucketPct
      },
      categoryBreakdown: categoryBreakdown,
      topExpenses: topExpenses,
      walletSpending: walletSpending,
      walletBalances: walletBalances,
      dailySeries: dailySeries,
      recommendations: recommendations,
      nextMonthPlan: nextMonthPlan
    };
  }

  function renderMarkdownRecap(report) {
    const s = report.summary;
    const r = report.rule503020;
    const lines = [];
    lines.push('# Rekap & Rekomendasi Keuangan — ' + report.month);
    lines.push('');
    lines.push('## Ringkasan Bulan ' + report.month);
    lines.push('- **Total Pemasukan**: ' + formatIDR(s.totalIncome));
    lines.push('- **Total Pengeluaran**: ' + formatIDR(s.totalExpense) + (s.expenseDeltaPct !== null ? ' (' + (s.expenseDeltaPct >= 0 ? '+' : '') + s.expenseDeltaPct + '% vs bulan lalu)' : ''));
    lines.push('- **Sisa Arus Kas / Tabungan Efektif**: ' + formatIDR(s.effectiveSavings) + ' (' + s.savingsRate + '%)');
    lines.push('- **Rata-rata Belanja Harian**: ' + formatIDR(s.avgDailySpend) + '/hari');
    lines.push('- **Batas Aman Belanja Harian (Safe-to-Spend)**: ' + formatIDR(s.safeDailySpend) + '/hari (sisa ' + s.remainingDays + ' hari)');
    lines.push('- **Skor Kesehatan Keuangan**: ' + s.healthScore + '/100');
    lines.push('');
    lines.push('## Proporsi 50 / 30 / 20');
    lines.push('- **Kebutuhan (Needs, ideal ≤50%)**: ' + r.needsPct + '% (' + formatIDR(r.needsAmount) + ')');
    lines.push('- **Keinginan (Wants, ideal ≤30%)**: ' + r.wantsPct + '% (' + formatIDR(r.wantsAmount) + ')');
    lines.push('- **Tabungan (Savings, ideal ≥20%)**: ' + r.savingsPct + '% (' + formatIDR(r.savingsAmount) + ')');
    lines.push('');
    lines.push('## Pengeluaran Terbesar per Kategori');
    if (report.categoryBreakdown.length === 0) {
      lines.push('- Belum ada pengeluaran tercatat.');
    } else {
      report.categoryBreakdown.forEach(function (c, idx) {
        const budgetInfo = c.budget > 0 ? ' | Budget: ' + formatIDR(c.budget) + ' (' + c.budgetUsedPct + '%)' : '';
        lines.push((idx + 1) + '. ' + c.icon + ' **' + c.name + '**: ' + formatIDR(c.amount) + ' (' + c.sharePct + '%, ' + c.count + 'x)' + budgetInfo);
      });
    }
    lines.push('');
    lines.push('## Rekomendasi Kedepannya');
    report.recommendations.forEach(function (rec, idx) {
      lines.push((idx + 1) + '. **[' + rec.priority.toUpperCase() + '] ' + rec.title + '**');
      lines.push('   - Situasi: ' + rec.summary);
      lines.push('   - Langkah: ' + rec.action);
    });
    if (report.nextMonthPlan.length > 0) {
      lines.push('');
      lines.push('## Saran Target Budget Bulan Depan');
      report.nextMonthPlan.forEach(function (p) {
        lines.push('- ' + p.icon + ' **' + p.name + '**: ' + formatIDR(p.suggestedBudget) + ' (' + p.rationale + ')');
      });
    }
    return lines.join('\n');
  }

  return {
    DEFAULT_CATEGORIES: DEFAULT_CATEGORIES,
    DEFAULT_WALLETS: DEFAULT_WALLETS,
    formatIDR: formatIDR,
    analyzeMonth: analyzeMonth,
    renderMarkdownRecap: renderMarkdownRecap,
    computeWalletBalances: computeWalletBalances
  };
});
