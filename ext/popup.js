'use strict';
/* global Poke, chrome */

(function () {
  try { console.log('PokeTicker popup.js loaded'); } catch(_) {}
  var healthEl = document.getElementById('health');
  function health(msg, ok) {
    if (healthEl) { healthEl.textContent = msg; healthEl.style.color = ok ? '#4ade80' : '#f87171'; }
  }
  health('init...', false);
  var REFRESH_MS = 60 * 1000;

  var state = {
    watch: [],
    loading: false,
    snoozeUntil: 0
  };

  var els = {
    search: document.getElementById('search'),
    go: document.getElementById('go'),
    results: document.getElementById('results'),
    list: document.getElementById('list'),
    empty: document.getElementById('empty'),
    status: document.getElementById('status'),
    refresh: document.getElementById('refresh'),
    tapeWrap: document.getElementById('tape-wrap'),
    tape: document.getElementById('tape'),
    clearAll: document.getElementById('clear-all'),
    retry: document.getElementById('retry'),
    alertLogBtn: document.getElementById('alertLogBtn'),
    alertLogPanel: document.getElementById('alertLogPanel'),
    portfolio: document.getElementById('portfolio'),
    sortBy: document.getElementById('sortBy'),
    exportCsv: document.getElementById('exportCsv'),
    copyClip: document.getElementById('copyClip'),
    compactToggle: document.getElementById('compactToggle'),
    themeToggle: document.getElementById('themeToggle'),
    ctxMenu: document.getElementById('ctxMenu'),
    refreshAge: document.getElementById('refreshAge'),
    sparkTooltip: document.getElementById('sparkTooltip'),
    chartTooltip: document.getElementById('chartTooltip'),
    recentSearches: document.getElementById('recentSearches'),
    snoozeBtn: document.getElementById('snoozeBtn'),
    copyAll: document.getElementById('copyAll')
  };

  var ctxTarget = null;
  var focusIdx = -1;
  var lastRefreshTime = 0;
  var lastRemoved = null;
  var undoTimer = null;
  var countdownTimer = null;
  var dragIdx = -1;
  var compact = false;
  var cardRange = {};   // per-card chart range: '7d' | '30d' | 'all'

  var chimeCtx = null;
  function chime() {
    try {
      if (!chimeCtx) chimeCtx = new (window.AudioContext || window.webkitAudioContext)();
      var o = chimeCtx.createOscillator();
      var g = chimeCtx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(880, chimeCtx.currentTime);
      o.frequency.setValueAtTime(1100, chimeCtx.currentTime + 0.08);
      g.gain.setValueAtTime(0.12, chimeCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, chimeCtx.currentTime + 0.3);
      o.connect(g); g.connect(chimeCtx.destination);
      o.start(chimeCtx.currentTime); o.stop(chimeCtx.currentTime + 0.3);
    } catch (_) {}
  }

  var hintTimer = null;
  var pageZoom = 1;
  var debounce = null;
  var searchId = 0;
  var refreshId = 0;

  function setStatus(msg, isError) {
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    els.status.textContent = msg || '';
    els.status.classList.toggle('error', !!isError);
    els.status.classList.remove('stale-fresh', 'stale-warn', 'stale-old');
    els.retry.hidden = true;
  }

  function setStale(ts) {
    var lv = Poke.staleLevel(ts);
    if (lv) els.status.classList.add(lv);
    if (lv) els.retry.hidden = false;
  }

  function flashAlert(entry, dir) {
    if (state.snoozeUntil && Date.now() < state.snoozeUntil) return;
    if (!Array.isArray(entry.alertLog)) entry.alertLog = [];
    var threshold = dir === 'above' ? entry.alertAbove : entry.alertBelow;
    var verb = dir === 'above' ? 'hit' : 'dropped below';
    if (threshold == null && entry.alertPct) { threshold = entry.alertPct; verb = 'moved ±' + entry.alertPct + '% from'; }
    entry.alertLog.push({ ts: Date.now(), dir: dir, threshold: threshold, price: entry.price, name: entry.name });
    if (entry.alertLog.length > 50) entry.alertLog = entry.alertLog.slice(-50);
    save();
    renderAlertLog();
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    var thStr = entry.alertPct && threshold === entry.alertPct ? '±' + threshold + '%' : '$' + threshold.toLocaleString();
    els.status.textContent = '🔔 ' + entry.name + ' ' + verb + ' ' + thStr + ' — now ' + Poke.formatPrice(entry.price) + '!';
    els.status.classList.remove('error', 'stale-fresh', 'stale-warn', 'stale-old');
    els.status.classList.add('alert');
    els.retry.hidden = true;
    hintTimer = setTimeout(function () {
      els.status.classList.remove('alert');
      els.status.textContent = '';
    }, 5000);
  }

  // ---------- persistence ----------
  function save() {
    chrome.storage.local.set({ ptWatchlist: state.watch });
  }

  function load(cb) {
    chrome.storage.local.get('ptWatchlist', function (d) {
      var w = d && d.ptWatchlist;
      if (Array.isArray(w)) {
        state.watch = w.filter(function (c) { return c && c.id && c.name; }).map(function (c) {
          if (!Array.isArray(c.daily)) c.daily = [];
          if (!c.daily.length && c.price != null) { var today = new Date().toISOString().slice(0, 10); c.daily.push({ d: today, p: c.price }); }
          if (!Array.isArray(c.alertLog)) c.alertLog = [];
          else c.alertLog = c.alertLog.filter(function (a) { return a && typeof a.ts === 'number' && typeof a.price === 'number'; }).slice(-50);
          return c;
        });
      }
      if (cb) cb();
    });
  }

  // ---------- search ----------
  var recentSearches = [];

  function loadRecent() {
    chrome.storage.local.get('ptRecent', function (d) {
      if (Array.isArray(d && d.ptRecent)) recentSearches = d.ptRecent.slice(0, 5);
      renderRecent();
    });
  }

  function saveRecent(q) {
    recentSearches = recentSearches.filter(function (s) { return s !== q; });
    recentSearches.unshift(q);
    if (recentSearches.length > 5) recentSearches.length = 5;
    chrome.storage.local.set({ ptRecent: recentSearches });
    renderRecent();
  }

  function renderRecent() {
    if (!recentSearches.length) { els.recentSearches.innerHTML = ''; return; }
    var html = '';
    recentSearches.forEach(function (s) {
      html += '<button class="recent-chip" type="button">' + esc(s) + '</button>';
    });
    els.recentSearches.innerHTML = html;
    els.recentSearches.querySelectorAll('.recent-chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        els.search.value = btn.textContent;
        doSearch(btn.textContent);
      });
    });
  }

  function doSearch(query) {
    var q = query.trim();
    if (q.length < 2) { els.results.hidden = true; return; }
    if (typeof Poke === 'undefined' || typeof Poke.fetchJson !== 'function') { setStatus('Module not loaded — reload the extension', true); return; }
    var myId = ++searchId;
    els.results.innerHTML = '<div class="res-note">Searching…</div>';
    els.results.hidden = false;
    savePopupState();
    Poke.fetchJson(Poke.searchUrl(q), { tries: 3, backoff: 700 })
      .then(function (json) {
        if (myId !== searchId) return;
        var cards = Poke.parseSearch(json);
        saveRecent(q);
        renderResults(cards, q);
        savePopupState();
      })
      .catch(function (err) {
        if (myId !== searchId) return;
        var msg = (err && err.status === 404) ? 'No cards found for "' + esc(q) + '".'
          : 'The price feed is hiccuping — try again in a moment.';
        els.results.innerHTML = '<div class="res-note">' + msg + '</div>';
      });
  }

  function renderResults(cards, q) {
    els.results.innerHTML = '';
    if (!cards.length) {
      els.results.innerHTML = '<div class="res-note">No cards found for "' + esc(q) + '".</div>';
      return;
    }
    cards.forEach(function (c) {
      var row = document.createElement('button');
      row.type = 'button'; row.className = 'res-row';
      var thumb = document.createElement('img');
      thumb.className = 'res-thumb'; thumb.alt = ''; thumb.src = c.image;
      thumb.addEventListener('error', function () { thumb.remove(); });
      var body = document.createElement('span'); body.className = 'res-body';
      var name = document.createElement('span'); name.className = 'res-name';
      name.textContent = c.name + (c.number ? ' · ' + c.number : '');
      var set = document.createElement('span'); set.className = 'res-set';
      set.textContent = c.set || '';
      body.appendChild(name); body.appendChild(set);
      var price = document.createElement('span'); price.className = 'res-price';
      price.textContent = c.price != null ? Poke.formatPrice(c.price) : '—';
      row.appendChild(thumb); row.appendChild(body); row.appendChild(price);
      row.addEventListener('click', function () {
        addCard(c);
        els.results.hidden = true;
        els.search.value = '';
      });
      els.results.appendChild(row);
    });
  }

  els.search.addEventListener('input', function () {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(function () { doSearch(els.search.value); }, 250);
    savePopupState();
  });
  els.search.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { doSearch(els.search.value); }
    if (ev.key === 'Escape') { els.results.hidden = true; }
  });
  if (els.go) {
    els.go.addEventListener('click', function () { doSearch(els.search.value); });
  } else {
    console.error('PokéTicker: #go button not found in DOM');
  }
  if (!els.search) console.error('PokéTicker: #search input not found in DOM');
  else console.log('PokéTicker: search input found, listeners attached');
  document.addEventListener('click', function (ev) {
    if (!ev.target.closest('.search-wrap')) els.results.hidden = true;
  });

  // ---------- popup state persistence (search text, scroll, results) ----------
  function savePopupState() {
    chrome.storage.local.set({
      ptPopupState: {
        searchText: els.search.value,
        scrollY: window.scrollY || document.documentElement.scrollTop || 0,
        resultsOpen: !els.results.hidden,
        resultsHTML: els.results.hidden ? '' : els.results.innerHTML
      }
    });
  }
  function restorePopupState() {
    chrome.storage.local.get('ptPopupState', function(d) {
      var ps = d && d.ptPopupState;
      if (!ps) return;
      if (ps.searchText) {
        els.search.value = ps.searchText;
        doSearch(ps.searchText);
      }
      if (ps.resultsOpen && ps.resultsHTML) {
        els.results.innerHTML = ps.resultsHTML;
        els.results.hidden = false;
      }
      if (ps.scrollY) {
        setTimeout(function () { window.scrollTo(0, ps.scrollY); }, 50);
      }
    });
  }
  // Save on scroll (debounced)
  var scrollTimer = null;
  document.addEventListener('scroll', function () {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(savePopupState, 200);
  }, { passive: true });
  // Save right before the popup closes
  window.addEventListener('beforeunload', savePopupState);

  // ---------- watchlist ----------
  function addCard(c) {
    var existing = state.watch.some(function (w) { return w.id === c.id; });
    if (existing) { setStatus('Already on your ticker.'); return; }
    var daily = [];
    if (c.price != null) { var today = new Date().toISOString().slice(0, 10); daily.push({ d: today, p: c.price }); }
    state.watch.unshift({
      id: c.id, name: c.name, set: c.set, number: c.number, image: c.image,
      price: c.price, variant: c.variant, trend: null, updatedAt: '', tcgplayerUrl: c.tcgplayerUrl,
      ts: Date.now(), daily: daily
    });
    save(); render(); refreshCard(state.watch[0]);
  }

  function removeCard(id) {
    var removed = state.watch.find(function (w) { return w.id === id; });
    if (!removed) return;
    lastRemoved = removed;
    state.watch = state.watch.filter(function (w) { return w.id !== id; });
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(function () { lastRemoved = null; save(); }, 4000);
    save(); render();
    setStatus('Removed ' + removed.name + ' — <button id="undoRemove" class="undo-link">Undo</button>');
    setTimeout(function () {
      var btn = document.getElementById('undoRemove');
      if (btn) btn.addEventListener('click', function () {
        if (!lastRemoved) return;
        state.watch.push(lastRemoved);
        if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
        lastRemoved = null; save(); render();
        setStatus('Restored ' + removed.name + '.');
      });
    }, 10);
  }

  function refreshCard(entry) {
    var myId = ++refreshId;
    Poke.fetchJson(Poke.cardUrl(entry.id), { tries: 3, backoff: 700 })
      .then(function (json) {
        if (myId !== refreshId) return;
        var q = Poke.parseQuote(json);
        if (!q) throw new Error('bad payload');
        applyQuote(entry.id, q); setStatus('');
      })
      .catch(function () {
        if (myId !== refreshId) return;
        if (entry.ts) { setStatus(Poke.offlineMsg(entry.ts)); setStale(entry.ts); }
        else { setStatus('Could not fetch a quote for ' + entry.name + '.', true); }
      });
  }

  function refreshAll() {
    if (!state.watch.length) return;
    var myId = ++refreshId;
    els.refresh.classList.add('spinning');
    var pending = state.watch.length;
    var succeeded = 0;
    state.watch.forEach(function (entry) {
      Poke.fetchJson(Poke.cardUrl(entry.id), { tries: 3, backoff: 700 })
        .then(function (json) {
          if (myId !== refreshId) return;
          var q = Poke.parseQuote(json);
          if (q) { applyQuote(entry.id, q); succeeded++; }
        })
        .catch(function () {})
        .finally(function () {
          if (myId !== refreshId) return;
          pending--;
          if (pending > 0) return;
          els.refresh.classList.remove('spinning');
          if (succeeded > 0) { setStatus(''); lastRefreshTime = Date.now(); updateRefreshAge(); }
          else {
            var oldest = null;
            state.watch.forEach(function (w) { if (w.ts && (oldest === null || w.ts < oldest)) oldest = w.ts; });
            if (oldest) { setStatus(Poke.offlineMsg(oldest)); setStale(oldest); }
            else { setStatus('Could not reach the price feed. Check your connection.', true); }
          }
        });
    });
  }

  function applyQuote(id, q) {
    var entry = state.watch.find(function (w) { return w.id === id; });
    if (!entry) return;
    var oldPrice = entry.price;
    var crossedAbove = entry.alertAbove != null && oldPrice != null && oldPrice < entry.alertAbove && q.price != null && q.price >= entry.alertAbove;
    var crossedBelow = entry.alertBelow != null && oldPrice != null && oldPrice > entry.alertBelow && q.price != null && q.price <= entry.alertBelow;
    entry.price = q.price; entry.variant = q.variant; entry.trend = q.trend;
    entry.updatedAt = q.updatedAt; entry.tcgplayerUrl = q.tcgplayerUrl;
    entry.image = q.image || entry.image;
    entry.cmAvg1 = q.cmAvg1; entry.cmAvg7 = q.cmAvg7; entry.cmAvg30 = q.cmAvg30;
    entry.ts = Date.now();
    if (crossedAbove) { flashAlert(entry, 'above'); chime(); updateBadge(); }
    if (crossedBelow) { flashAlert(entry, 'below'); chime(); updateBadge(); }
    if (entry.alertPct && entry.alertPctBase != null && oldPrice != null && q.price != null) {
      var pctChange = Math.abs(q.price - entry.alertPctBase) / entry.alertPctBase * 100;
      var prevPct = Math.abs(oldPrice - entry.alertPctBase) / entry.alertPctBase * 100;
      if (prevPct < entry.alertPct && pctChange >= entry.alertPct) {
        flashAlert(entry, q.price >= entry.alertPctBase ? 'above' : 'below'); chime();
      }
    }
    if (q.price != null) {
      if (!entry.daily) entry.daily = [];
      var today = new Date().toISOString().slice(0, 10);
      var last = entry.daily.length ? entry.daily[entry.daily.length - 1] : null;
      if (last && last.d === today) { last.p = q.price; }
      else { entry.daily.push({ d: today, p: q.price }); if (entry.daily.length > 30) entry.daily = entry.daily.slice(-30); }
    }
    save(); render();
    if (oldPrice != null && q.price != null && oldPrice !== q.price) {
      setTimeout(function () {
        var rows = els.list.querySelectorAll('.card-row');
        for (var i = 0; i < rows.length; i++) {
          if (rows[i]._watchId === id) {
            var priceEl = rows[i].querySelector('.card-price');
            if (priceEl) {
              priceEl.classList.add(q.price > oldPrice ? 'flash-up' : 'flash-down');
              setTimeout(function () { priceEl.classList.remove('flash-up', 'flash-down'); }, 600);
            }
            break;
          }
        }
      }, 10);
    }
  }

  // ---------- rendering ----------
  function render() {
    els.empty.hidden = state.watch.length > 0;
    els.tapeWrap.hidden = state.watch.length === 0;
    els.clearAll.hidden = state.watch.length === 0;
    els.exportCsv.hidden = state.watch.length === 0;
    els.copyClip.hidden = state.watch.length === 0;
    els.copyAll.hidden = state.watch.length === 0;
    renderTape();
    var sum = 0; var priced = 0;
    state.watch.forEach(function (w) { if (w.price != null) { sum += w.price; priced++; } });
    var daySum = 0;
    state.watch.forEach(function (w) { var d = dayChange(w); if (d != null) daySum += d; });
    var dayStr = daySum !== 0 ? (' <span class="portfolio-day ' + (daySum > 0 ? 'up' : 'down') + '">' + (daySum > 0 ? '+' : '') + '$' + Math.abs(daySum).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' 24h</span>') : '';
    els.portfolio.innerHTML = (priced ? 'Total: $' + sum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' (' + priced + ' cards)' + dayStr : '');

    var sort = els.sortBy.value;
    var sorted = state.watch.slice();
    sorted.sort(function (a, b) { return (b.fav ? 1 : 0) - (a.fav ? 1 : 0); });
    var favs = sorted.filter(function (w) { return w.fav; });
    var rest = sorted.filter(function (w) { return !w.fav; });
    if (sort === 'name') rest.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    else if (sort === 'price-desc') rest.sort(function (a, b) { return (b.price || 0) - (a.price || 0); });
    else if (sort === 'price-asc') rest.sort(function (a, b) { return (a.price || 0) - (b.price || 0); });
    else if (sort === 'trend-desc') rest.sort(function (a, b) { var ta = a.trend ? a.trend.pct : 0; var tb = b.trend ? b.trend.pct : 0; return tb - ta; });
    else if (sort === 'trend-asc') rest.sort(function (a, b) { var ta = a.trend ? a.trend.pct : 0; var tb = b.trend ? b.trend.pct : 0; return ta - tb; });
    sorted = favs.concat(rest);

    els.list.innerHTML = '';
    sorted.forEach(function (w) {
      els.list.appendChild(rowFor(w));
    });

    // draw all charts now that DOM is populated
    var wraps = els.list.querySelectorAll('.card-wrap');
    for (var ci = 0; ci < wraps.length; ci++) {
      var wc = wraps[ci];
      var wcCanvas = wc.querySelector('.price-chart');
      var wcId = wc.querySelector('.card-row')._watchId;
      var wcW = state.watch.find(function (x) { return x.id === wcId; });
      if (wcCanvas && wcW) {
        drawChart(wcCanvas, wcW, cardRange[wcId] || '30d');
      }
    }
  }

  // ---------- flat card row with chart always visible ----------
  function rowFor(w) {
    var wrap = document.createElement('div');
    wrap.className = 'card-wrap';

    // ---- top row ----
    var row = document.createElement('article');
    row.className = 'card-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.title = w.tcgplayerUrl ? 'Open on TCGplayer' : w.name;
    row._watchId = w.id;

    var thumb = document.createElement('img');
    thumb.className = 'card-thumb'; thumb.alt = ''; thumb.loading = 'lazy'; thumb.src = w.image;
    thumb.addEventListener('error', function () {
      var ph = document.createElement('div'); ph.className = 'card-thumb ph';
      thumb.replaceWith(ph);
    });

    var info = document.createElement('div'); info.className = 'card-info';
    var nameEl = document.createElement('div'); nameEl.className = 'card-name'; nameEl.textContent = w.name;
    info.appendChild(nameEl);

    var quote = document.createElement('div'); quote.className = 'card-quote';
    var priceEl = document.createElement('div'); priceEl.className = 'card-price'; priceEl.textContent = Poke.formatPrice(w.price);
    if (w.variant) {
      var vEl = document.createElement('span'); vEl.className = 'card-variant';
      vEl.textContent = w.variant.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
      priceEl.appendChild(vEl);
    }
    var trendEl = document.createElement('div');
    trendEl.className = 'card-trend' + (w.trend ? (w.trend.dir === 1 ? ' up' : ' down') : ' flat');
    trendEl.textContent = w.trend ? (w.trend.dir === 1 ? '▲ ' : '▼ ') + Math.abs(w.trend.pct).toFixed(1) + '%' : '—';
    quote.appendChild(priceEl); quote.appendChild(trendEl);

    var grip = document.createElement('span'); grip.className = 'drag-grip';
    grip.textContent = '⋮⋮'; grip.title = 'Drag to reorder';

    var favBtn = document.createElement('button');
    favBtn.className = 'fav-btn' + (w.fav ? ' fav-on' : ''); favBtn.type = 'button';
    favBtn.title = w.fav ? 'Unpin from top' : 'Pin to top';
    favBtn.textContent = w.fav ? '⭐' : '☆';
    favBtn.addEventListener('click', function (ev) { ev.stopPropagation(); w.fav = !w.fav; save(); render(); });

    var x = document.createElement('button'); x.className = 'row-x'; x.type = 'button';
    x.title = 'Remove from ticker'; x.textContent = '✕';
    x.addEventListener('click', function (ev) { ev.stopPropagation(); removeCard(w.id); });

    row.appendChild(grip); row.appendChild(thumb); row.appendChild(info);
    row.appendChild(quote); row.appendChild(favBtn); row.appendChild(x);

    // ---- chart section ----
    var chart = document.createElement('div'); chart.className = 'card-chart';
    var tools = document.createElement('div'); tools.className = 'chart-tools';
    var range = cardRange[w.id] || '30d';
    ['7d', '30d', 'All'].forEach(function (rng) {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.textContent = rng;
      btn.classList.toggle('active', range === (rng === 'All' ? 'all' : rng));
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var val = rng === 'All' ? 'all' : rng;
        cardRange[w.id] = val;
        tools.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        drawChart(canvas, w, val);
      });
      tools.appendChild(btn);
    });
    chart.appendChild(tools);
    var canvas = document.createElement('canvas');
    canvas.className = 'price-chart'; canvas.width = 408; canvas.height = 180;
    chart.appendChild(canvas);

    // hover tracking
    canvas.addEventListener('mousemove', function (ev) {
      var rect = canvas.getBoundingClientRect();
      var mx = ev.clientX - rect.left;
      var scaleX = canvas.width / rect.width;
      var data = getChartData(w, cardRange[w.id] || '30d');
      if (!data.length) return;
      var pad = { left: 52, right: 14 };
      var pw = canvas.width - pad.left - pad.right;
      var nearest = 0; var bestDist = Infinity;
      for (var di = 0; di < data.length; di++) {
        var sx = pad.left + (di / Math.max(1, data.length - 1)) * pw;
        var dist = Math.abs(mx * scaleX - sx);
        if (dist < bestDist) { bestDist = dist; nearest = di; }
      }
      if (bestDist > 35) { nearest = null; els.chartTooltip.hidden = true; }
      drawChart(canvas, w, cardRange[w.id] || '30d', nearest);
      if (nearest != null) {
        var dp = data[nearest];
        els.chartTooltip.textContent = dp.d + ' — $' + dp.p.toFixed(2);
        els.chartTooltip.style.left = ev.clientX + 'px';
        els.chartTooltip.style.top = (ev.clientY - 14) + 'px';
        els.chartTooltip.hidden = false;
      }
    });
    canvas.addEventListener('mouseleave', function () {
      drawChart(canvas, w, cardRange[w.id] || '30d');
      els.chartTooltip.hidden = true;
    });

    // chart meta: sparkline + 24h + ATH/ATL + volatility
    var meta = document.createElement('div'); meta.className = 'chart-meta';
    var bars = document.createElement('div'); bars.className = 'card-bars';
    bars.title = '30-day sparkline';
    bars.addEventListener('mouseenter', function (ev) { showSparkTooltip(w, ev); });
    bars.addEventListener('mouseleave', function () { els.sparkTooltip.hidden = true; });
    var heights = Poke.sparkBars(w.daily, 30);
    if (heights.length) {
      heights.forEach(function (v) {
        var b = document.createElement('span'); b.className = 'bar';
        b.style.height = Math.round(v * 18) + 'px'; bars.appendChild(b);
      });
    }
    meta.appendChild(bars);

    var ath = allTimeHigh(w); var atl = allTimeLow(w);
    if (ath != null && atl != null && ath !== atl && w.price != null) {
      var pct = Math.max(0, Math.min(100, (w.price - atl) / (ath - atl) * 100));
      var pb = document.createElement('div'); pb.className = 'card-posbar';
      var pf = document.createElement('div'); pf.className = 'card-posfill'; pf.style.width = pct + '%';
      pb.appendChild(pf); meta.appendChild(pb);
    }

    var dayChg = dayChange(w);
    if (dayChg != null) {
      var dc = document.createElement('span'); dc.className = 'card-daychg' + (dayChg > 0 ? ' up' : dayChg < 0 ? ' down' : '');
      dc.textContent = (dayChg >= 0 ? '+' : '') + Poke.formatPrice(dayChg) + ' 24h'; meta.appendChild(dc);
    }
    if (ath != null && atl != null) {
      var rngEl = document.createElement('span'); rngEl.className = 'card-range';
      rngEl.textContent = 'H ' + Poke.formatPrice(ath) + ' L ' + Poke.formatPrice(atl); meta.appendChild(rngEl);
    }
    if (Array.isArray(w.daily) && w.daily.length >= 2) {
      var last7d = w.daily.slice(-7); var dmin = Infinity; var dmax = -Infinity;
      last7d.forEach(function (d) { if (d.p < dmin) dmin = d.p; if (d.p > dmax) dmax = d.p; });
      if (dmin > 0 && dmax > dmin) {
        var vol = ((dmax - dmin) / dmin * 100).toFixed(1);
        var ve = document.createElement('span'); ve.className = 'card-vol';
        ve.textContent = '±' + vol + '% 7d'; meta.appendChild(ve);
      }
    }
    chart.appendChild(meta);

    // ---- alert panel ----
    var panel = document.createElement('div'); panel.className = 'alert-panel'; panel.hidden = true;

    var alertBtn = document.createElement('button');
    alertBtn.className = 'alert-btn'; alertBtn.type = 'button';
    var hasAlert = w.alertAbove || w.alertBelow || w.alertPct;
    if (hasAlert) { alertBtn.classList.remove('alert-off'); alertBtn.title = 'Edit alerts'; }
    else { alertBtn.classList.add('alert-off'); alertBtn.title = 'Set price alert'; }
    alertBtn.textContent = '🔔';
    alertBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      panel.hidden = !panel.hidden;
      if (!panel.hidden) { var fi = panel.querySelector('.alert-input'); if (fi) fi.focus(); }
    });
    row.appendChild(alertBtn);

    function mkAlertRow(label, key) {
      var ar = document.createElement('div'); ar.className = 'alert-row';
      var al = document.createElement('span'); al.className = 'alert-label'; al.textContent = label;
      var ainp = document.createElement('input'); ainp.className = 'alert-input'; ainp.type = 'number'; ainp.min = '0.01'; ainp.step = 'any';
      ainp.value = (w[key] || '');
      ainp.placeholder = key === 'alertPct' ? '10' : (w.price != null ? w.price.toFixed(2) : '0.00');
      if (key === 'alertPct') ainp.title = 'Base: ' + (w.alertPctBase != null ? Poke.formatPrice(w.alertPctBase) : 'not set');
      var aset = document.createElement('button'); aset.className = 'alert-set'; aset.type = 'button'; aset.textContent = 'Set';
      var aclr = document.createElement('button'); aclr.className = 'alert-clear'; aclr.type = 'button'; aclr.textContent = 'Clear';
      ar.appendChild(al); ar.appendChild(ainp); ar.appendChild(aset); ar.appendChild(aclr);
      aset.addEventListener('click', function (ev) { ev.stopPropagation(); var v = parseFloat(ainp.value); if (isNaN(v) || v <= 0) { panel.hidden = true; return; } w[key] = v; if (key === 'alertPct') w.alertPctBase = w.price; updateAlertBtn(); panel.hidden = true; save(); });
      aclr.addEventListener('click', function (ev) { ev.stopPropagation(); w[key] = null; if (key === 'alertPct') w.alertPctBase = null; ainp.value = ''; updateAlertBtn(); panel.hidden = true; save(); });
      return ar;
    }
    function updateAlertBtn() {
      var has = w.alertAbove || w.alertBelow || w.alertPct;
      if (has) { alertBtn.classList.remove('alert-off'); alertBtn.title = 'Edit alerts'; }
      else { alertBtn.classList.add('alert-off'); alertBtn.title = 'Set price alert'; }
    }
    panel.appendChild(mkAlertRow('Alert above $', 'alertAbove'));
    panel.appendChild(mkAlertRow('Alert below $', 'alertBelow'));
    panel.appendChild(mkAlertRow('Alert if ±%', 'alertPct'));

    // range-colored left border
    if (ath != null && atl != null && ath !== atl && w.price != null) {
      var pctBorder = Math.max(0, Math.min(100, (w.price - atl) / (ath - atl) * 100));
      wrap.style.borderLeft = '3px solid hsl(' + (pctBorder * 1.2) + ', 70%, 45%)';
    }

    wrap.appendChild(row);
    wrap.appendChild(chart);
    wrap.appendChild(panel);

    // ---- row click opens TCGplayer ----
    row.addEventListener('click', function (ev) {
      if (ev.target.closest('.alert-btn') || ev.target.closest('.fav-btn') || ev.target.closest('.row-x') || ev.target.closest('.drag-grip') || ev.target.closest('.chart-tools') || ev.target.closest('canvas')) return;
      if (w.tcgplayerUrl) chrome.windows.create({ type: 'popup', url: w.tcgplayerUrl, width: 900, height: 700 });
    });
    row.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        if (w.tcgplayerUrl) chrome.windows.create({ type: 'popup', url: w.tcgplayerUrl, width: 900, height: 700 });
      }
    });

    // ---- right-click ----
    row.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      ctxTarget = w;
      els.ctxMenu.style.top = Math.min(ev.clientY, window.innerHeight - 120) + 'px';
      els.ctxMenu.style.left = Math.min(ev.clientX, window.innerWidth - 130) + 'px';
      els.ctxMenu.hidden = false;
    });

    // ---- middle-click copy ----
    row.addEventListener('auxclick', function (ev) {
      if (ev.button === 1 && w.price != null) {
        ev.preventDefault();
        navigator.clipboard.writeText(Poke.formatPrice(w.price)).then(function () {
          setStatus('📋 Copied ' + Poke.formatPrice(w.price));
        }).catch(function () {});
      }
    });

    // ---- drag-to-reorder ----
    row.draggable = true;
    row.addEventListener('dragstart', function (ev) {
      dragIdx = Array.prototype.indexOf.call(els.list.children, wrap);
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', '');
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', function () {
      row.classList.remove('dragging');
      els.list.querySelectorAll('.drag-over').forEach(function (el) { el.classList.remove('drag-over'); });
      dragIdx = -1;
    });
    wrap.addEventListener('dragover', function (ev) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      if (dragIdx >= 0 && !wrap.classList.contains('drag-over')) {
        els.list.querySelectorAll('.drag-over').forEach(function (el) { el.classList.remove('drag-over'); });
        wrap.classList.add('drag-over');
      }
    });
    wrap.addEventListener('drop', function (ev) {
      ev.preventDefault();
      wrap.classList.remove('drag-over');
      if (dragIdx < 0) return;
      var dropIdx = Array.prototype.indexOf.call(els.list.children, wrap);
      if (dropIdx === dragIdx) return;
      var item = state.watch.splice(dragIdx, 1)[0];
      state.watch.splice(dropIdx, 0, item);
      save(); render();
    });

    return wrap;
  }

  function renderTape() {
    if (!state.watch.length) { els.tape.innerHTML = ''; return; }
    var parts = state.watch.map(function (w) {
      var cls = w.trend ? (w.trend.dir === 1 ? 'up' : 'down') : 'flat';
      var chg = w.trend ? Poke.formatTrend(w.trend) : '—';
      return '<span class="tape-item"><span class="tape-name">' + esc(w.name) + '</span>' +
        '<span class="tape-sep">·</span>' +
        '<span class="tape-price">' + esc(Poke.formatPrice(w.price)) + '</span>' +
        '<span class="tape-chg ' + cls + '">' + esc(chg) + '</span></span>';
    });
    els.tape.innerHTML = parts.join('') + parts.join('');
    els.tape.style.animation = 'none';
    void els.tape.offsetWidth;
    els.tape.style.animation = '';
  }

  // ---------- helpers ----------
  function dayChange(w) {
    if (!Array.isArray(w.daily) || w.daily.length < 2) return null;
    var now = Date.now(); var day = 24 * 60 * 60 * 1000;
    var best = null;
    for (var i = w.daily.length - 1; i >= 0; i--) {
      var d = w.daily[i];
      var dt = new Date(d.d + 'T12:00:00Z').getTime();
      var ago = now - dt;
      if (ago >= day * 0.8 && ago <= day * 1.3) { best = d.p; break; }
      if (ago > day * 1.3 && best == null) { best = d.p; }
    }
    if (best == null && w.daily.length) best = w.daily[0].p;
    if (best == null || w.price == null) return null;
    return +(w.price - best).toFixed(2);
  }

  function allTimeHigh(w) {
    if (!Array.isArray(w.daily) || !w.daily.length) return w.price;
    var max = w.price || 0;
    w.daily.forEach(function (d) { if (d.p > max) max = d.p; });
    return max;
  }

  function allTimeLow(w) {
    if (!Array.isArray(w.daily) || !w.daily.length) return w.price;
    var min = w.price || Infinity;
    w.daily.forEach(function (d) { if (d.p < min) min = d.p; });
    return min === Infinity ? w.price : min;
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // ---------- alert log ----------
  function renderAlertLog() {
    var now = Date.now(); var day = 24 * 60 * 60 * 1000;
    var items = [];
    state.watch.forEach(function (w) {
      if (!Array.isArray(w.alertLog)) return;
      w.alertLog.forEach(function (a) { if (now - a.ts <= day) items.push(a); });
    });
    items.sort(function (a, b) { return b.ts - a.ts; });
    if (!items.length) {
      els.alertLogBtn.classList.remove('has-log');
      els.alertLogBtn.removeAttribute('data-count');
      if (!els.alertLogPanel.hidden) els.alertLogPanel.hidden = true;
      return;
    }
    els.alertLogBtn.classList.add('has-log');
    els.alertLogBtn.setAttribute('data-count', items.length);
    var html = '';
    items.forEach(function (a) {
      var time = new Date(a.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      var dir = a.dir === 'above' ? '↑ hit' : '↓ below';
      html += '<div class="alert-log-item"><span class="alert-log-name">' + esc(a.name) + '</span> <span class="alert-log-dir">' + dir + ' $' + (a.threshold || 0).toLocaleString() + '</span> <span class="alert-log-price">→ ' + Poke.formatPrice(a.price) + '</span> <span class="alert-log-time">' + time + '</span></div>';
    });
    els.alertLogPanel.innerHTML = html;
    if (!els.alertLogPanel.hidden) els.alertLogPanel.scrollTop = 0;
  }

  els.alertLogBtn.addEventListener('click', function () {
    renderAlertLog();
    els.alertLogPanel.hidden = !els.alertLogPanel.hidden;
  });

  // ---------- refresh + auto-refresh ----------
  els.sortBy.addEventListener('change', function () { render(); });
  els.exportCsv.addEventListener('click', exportCsv);
  els.copyAll.addEventListener('click', function () {
    var lines = state.watch.map(function (w) { return w.name + '\t' + (w.price != null ? '$' + w.price.toFixed(2) : '—'); });
    navigator.clipboard.writeText(lines.join('\n')).then(function () {
      setStatus('📋 Copied ' + state.watch.length + ' prices');
    }).catch(function () { setStatus('Could not copy', true); });
  });
  els.copyClip.addEventListener('click', function () {
    var lines = state.watch.map(function (w) {
      var trendStr = w.trend ? (w.trend.dir === 1 ? '+' : '') + w.trend.pct.toFixed(1) + '%' : '—';
      return [w.name, w.price != null ? '$' + w.price.toFixed(2) : '', trendStr].join('\t');
    });
    navigator.clipboard.writeText(lines.join('\n')).then(function () {
      setStatus('📋 Copied ' + state.watch.length + ' cards to clipboard');
    }).catch(function () { setStatus('Could not copy — click 📥 CSV instead', true); });
  });

  function updateSnooze() {
    if (!state.snoozeUntil || Date.now() >= state.snoozeUntil) {
      state.snoozeUntil = 0;
      els.snoozeBtn.textContent = '🔕 Snooze';
      els.snoozeBtn.classList.remove('active');
    } else {
      var left = Math.max(0, Math.ceil((state.snoozeUntil - Date.now()) / 60000));
      els.snoozeBtn.textContent = '🔕 ' + left + 'm';
      els.snoozeBtn.classList.add('active');
    }
  }

  els.snoozeBtn.addEventListener('click', function () {
    if (state.snoozeUntil && Date.now() < state.snoozeUntil) {
      state.snoozeUntil = 0; updateSnooze(); setStatus('Alerts re-enabled');
    } else {
      state.snoozeUntil = Date.now() + 3600000; updateSnooze(); setStatus('Alerts snoozed for 1 hour');
    }
  });

  els.themeToggle.addEventListener('click', function () {
    document.body.classList.toggle('light');
    var isLight = document.body.classList.contains('light');
    chrome.storage.local.set({ ptLight: isLight });
    els.themeToggle.textContent = isLight ? '🌙' : '☀️';
  });
  function applyTheme() {
    chrome.storage.local.get('ptLight', function (d) {
      var isLight = !!(d && d.ptLight);
      document.body.classList.toggle('light', isLight);
      els.themeToggle.textContent = isLight ? '🌙' : '☀️';
    });
  }

  els.compactToggle.addEventListener('click', function () {
    compact = !compact;
    document.body.classList.toggle('compact', compact);
    chrome.storage.local.set({ ptCompact: compact });
    els.compactToggle.textContent = compact ? '📐' : '📏';
  });
  function applyCompact() {
    chrome.storage.local.get('ptCompact', function (d) {
      compact = !!(d && d.ptCompact);
      document.body.classList.toggle('compact', compact);
      els.compactToggle.textContent = compact ? '📐' : '📏';
    });
  }
  els.refresh.addEventListener('click', refreshAll);
  els.retry.addEventListener('click', refreshAll);
  els.clearAll.addEventListener('click', function () {
    state.watch = []; save(); setStatus('Cleared your ticker'); render();
  });

  // ---------- context menu ----------
  document.addEventListener('click', function () { els.ctxMenu.hidden = true; });
  els.ctxMenu.addEventListener('click', function (ev) {
    ev.stopPropagation();
    var action = (ev.target.closest('[data-action]') || {}).dataset && ev.target.closest('[data-action]').dataset.action;
    if (!action || !ctxTarget) return;
    var w = ctxTarget;
    if (action === 'copy-price') navigator.clipboard.writeText(Poke.formatPrice(w.price));
    else if (action === 'copy-name') navigator.clipboard.writeText(w.name);
    else if (action === 'remove') removeCard(w.id);
    els.ctxMenu.hidden = true; ctxTarget = null;
  });

  // ---------- keyboard page zoom ----------
  function applyPageZoom(z) {
    pageZoom = Math.round(z * 10) / 10;
    document.body.style.zoom = pageZoom === 1 ? '' : String(pageZoom);
  }
  function flashZoomHint() {
    setStatus('Zoom ' + Math.round(pageZoom * 100) + '%');
    hintTimer = setTimeout(function () { setStatus(''); }, 1400);
  }
  document.addEventListener('keydown', function (ev) {
    if (!ev.ctrlKey && !ev.metaKey) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        var cards = els.list.querySelectorAll('.card-row');
        if (!cards.length) return;
        if (focusIdx >= 0) cards[focusIdx].classList.remove('focused');
        focusIdx += ev.key === 'ArrowDown' ? 1 : -1;
        if (focusIdx < 0) focusIdx = 0;
        if (focusIdx >= cards.length) focusIdx = cards.length - 1;
        cards[focusIdx].classList.add('focused');
        cards[focusIdx].focus({ preventScroll: true });
        return;
      }
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && focusIdx >= 0) {
        ev.preventDefault();
        var all = els.list.querySelectorAll('.card-row');
        var idx = focusIdx; focusIdx = -1;
        if (all[idx]) all[idx].classList.remove('focused');
        var sorted = state.watch.slice();
        sorted.sort(function (a, b) { return (b.fav ? 1 : 0) - (a.fav ? 1 : 0); });
        var favs = sorted.filter(function (w) { return w.fav; });
        var rest = sorted.filter(function (w) { return !w.fav; });
        var sort = els.sortBy.value;
        if (sort === 'name') rest.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
        else if (sort === 'price-desc') rest.sort(function (a, b) { return (b.price || 0) - (a.price || 0); });
        else if (sort === 'price-asc') rest.sort(function (a, b) { return (a.price || 0) - (b.price || 0); });
        else if (sort === 'trend-desc') rest.sort(function (a, b) { var ta = a.trend ? a.trend.pct : 0; var tb = b.trend ? b.trend.pct : 0; return tb - ta; });
        else if (sort === 'trend-asc') rest.sort(function (a, b) { var ta = a.trend ? a.trend.pct : 0; var tb = b.trend ? b.trend.pct : 0; return ta - tb; });
        sorted = favs.concat(rest);
        if (idx < sorted.length) removeCard(sorted[idx].id);
        return;
      }
      if (ev.key === 'Enter' && focusIdx >= 0) {
        var rows = els.list.querySelectorAll('.card-row');
        if (rows[focusIdx]) rows[focusIdx].click();
        return;
      }
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'r' || ev.key === 'R')) { ev.preventDefault(); refreshAll(); return; }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) { ev.preventDefault(); els.search.focus(); els.search.select(); return; }
    if (!(ev.ctrlKey || ev.metaKey)) return;
    var k = ev.key;
    if (k === '+' || k === '=' || k === '-' || k === '_') {
      ev.preventDefault();
      var dz = (k === '+' || k === '=') ? 0.1 : -0.1;
      applyPageZoom(Math.max(0.5, Math.min(2, pageZoom + dz)));
      flashZoomHint();
    } else if (k === '0') { ev.preventDefault(); applyPageZoom(1); flashZoomHint(); }
  });

  // ---------- CSV export ----------
  function exportCsv() {
    var rows = [['Name','Price','Trend','Alert Above','Alert Below','Alert ±%','24h Alerts']];
    state.watch.forEach(function (w) {
      var trendStr = w.trend ? (w.trend.dir === 1 ? '+' : '') + w.trend.pct.toFixed(1) + '%' : '—';
      var alertCount = 0;
      if (Array.isArray(w.alertLog)) { var day = 24 * 60 * 60 * 1000; alertCount = w.alertLog.filter(function (a) { return Date.now() - a.ts <= day; }).length; }
      rows.push([w.name, w.price != null ? w.price.toFixed(2) : '', trendStr, w.alertAbove != null ? w.alertAbove.toFixed(2) : '', w.alertBelow != null ? w.alertBelow.toFixed(2) : '', w.alertPct != null ? w.alertPct + '%' : '', String(alertCount)]);
    });
    var csv = rows.map(function (r) { return r.map(function (c) { return '"' + c + '"'; }).join(','); }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'poketicker-watchlist.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  function showSparkTooltip(w, ev) {
    if (!Array.isArray(w.daily) || w.daily.length < 2) { els.sparkTooltip.hidden = true; return; }
    var last7 = w.daily.slice(-7);
    var min = Infinity; var max = -Infinity;
    last7.forEach(function (d) { if (d.p < min) min = d.p; if (d.p > max) max = d.p; });
    var range = max - min || 1;
    var html = '<div class="spark-title">7-day trend</div><div class="spark-bars">';
    last7.forEach(function (d) {
      var h = Math.round((d.p - min) / range * 40);
      html += '<span class="spark-bar-wrap"><span class="spark-bar" style="height:' + h + 'px" title="' + d.d + ': ' + Poke.formatPrice(d.p) + '"></span></span>';
    });
    html += '</div>';
    var first = last7[0]; var last = last7[last7.length - 1]; var chg = last.p - first.p;
    html += '<div class="spark-summary">' + (chg >= 0 ? '+' : '') + Poke.formatPrice(chg) + ' over 7 days</div>';
    els.sparkTooltip.innerHTML = html;
    els.sparkTooltip.style.top = (ev.clientY - 90) + 'px';
    els.sparkTooltip.style.left = Math.min(ev.clientX - 60, window.innerWidth - 170) + 'px';
    els.sparkTooltip.hidden = false;
  }

  // ---------- canvas price chart ----------
  function getChartData(w, range) {
    if (!Array.isArray(w.daily) || !w.daily.length) return [];
    var now = Date.now();
    var cutoff = 0;
    if (range === '7d') cutoff = now - 7 * 86400000;
    else if (range === '30d') cutoff = now - 30 * 86400000;
    return w.daily.filter(function (d) {
      if (!cutoff) return true;
      return new Date(d.d + 'T12:00:00Z').getTime() >= cutoff;
    });
  }

  function drawChart(canvas, w, range, hoverIdx) {
    var data = getChartData(w, range);
    var ctx = canvas.getContext('2d');
    if (!data.length) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#1e2c4d'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#6b7c9e'; ctx.font = '13px -apple-system, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('Price history builds daily — check back tomorrow', canvas.width / 2, canvas.height / 2);
      return;
    }
    var W = canvas.width; var H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    var pad = { top: 20, right: 14, bottom: 28, left: 52 };
    var pw = W - pad.left - pad.right;
    var ph = H - pad.top - pad.bottom;

    var prices = data.map(function (d) { return d.p; });
    var min = Math.min.apply(null, prices);
    var max = Math.max.apply(null, prices);
    var spread = max - min || 1;
    min -= spread * 0.05; max += spread * 0.05;
    var yr = max - min || 1;

    function x(i) { return pad.left + (i / Math.max(1, data.length - 1)) * pw; }
    function y(p) { return pad.top + (1 - (p - min) / yr) * ph; }

    // grid lines
    ctx.strokeStyle = '#2a3a5c'; ctx.lineWidth = 0.5;
    var steps = 4;
    for (var g = 0; g <= steps; g++) {
      var gVal = min + (yr * g / steps);
      var gy = y(gVal);
      ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(W - pad.right, gy); ctx.stroke();
      ctx.fillStyle = '#b0bfdb'; ctx.font = 'bold 10px -apple-system, sans-serif';
      ctx.textAlign = 'right'; ctx.fillText('$' + gVal.toFixed(0), pad.left - 6, gy + 4);
    }

    // gradient fill
    var grad = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
    grad.addColorStop(0, 'rgba(56, 189, 248, 0.25)');
    grad.addColorStop(1, 'rgba(56, 189, 248, 0.02)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x(0), y(prices[0]));
    for (var i = 1; i < data.length; i++) { ctx.lineTo(x(i), y(prices[i])); }
    ctx.lineTo(x(data.length - 1), H - pad.bottom);
    ctx.lineTo(x(0), H - pad.bottom);
    ctx.closePath(); ctx.fill();

    // line
    ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x(0), y(prices[0]));
    for (var j = 1; j < data.length; j++) { ctx.lineTo(x(j), y(prices[j])); }
    ctx.stroke();

    // dots
    var dotStep = Math.max(1, Math.floor(data.length / 8));
    for (var k = 0; k < data.length; k += dotStep) {
      var dx = x(k); var dy = y(prices[k]);
      ctx.fillStyle = '#38bdf8'; ctx.beginPath(); ctx.arc(dx, dy, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0e1626'; ctx.beginPath(); ctx.arc(dx, dy, 1.2, 0, Math.PI * 2); ctx.fill();
    }

    // date labels
    ctx.fillStyle = '#b0bfdb'; ctx.font = 'bold 10px -apple-system, sans-serif'; ctx.textAlign = 'center';
    var labelCount = Math.min(6, data.length);
    for (var l = 0; l < labelCount; l++) {
      var idx = Math.floor(l * (data.length - 1) / Math.max(1, labelCount - 1));
      ctx.fillText(data[idx].d.slice(5), x(idx), H - 8);
    }

    // ---- hover highlight ----
    if (hoverIdx != null && hoverIdx >= 0 && hoverIdx < data.length) {
      var hx = x(hoverIdx); var hy = y(prices[hoverIdx]);
      // vertical guide line
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'; ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(hx, pad.top); ctx.lineTo(hx, H - pad.bottom); ctx.stroke();
      ctx.setLineDash([]);
      // outer glow ring
      ctx.fillStyle = 'rgba(56, 189, 248, 0.3)'; ctx.beginPath(); ctx.arc(hx, hy, 6, 0, Math.PI * 2); ctx.fill();
      // inner dot
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(hx, hy, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(hx, hy, 3.5, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function updateRefreshAge() {
    if (!lastRefreshTime) { els.refreshAge.textContent = ''; return; }
    var sec = Math.floor((Date.now() - lastRefreshTime) / 1000);
    if (sec < 10) els.refreshAge.textContent = '• Live';
    else if (sec < 60) els.refreshAge.textContent = '• ' + sec + 's ago';
    else if (sec < 3600) els.refreshAge.textContent = '• ' + Math.floor(sec / 60) + 'm ago';
    else els.refreshAge.textContent = '• ' + Math.floor(sec / 3600) + 'h ago';
  }

  function updateBadge() {
    var day = 24 * 60 * 60 * 1000; var total = 0;
    state.watch.forEach(function (w) {
      if (!Array.isArray(w.alertLog)) return;
      w.alertLog.forEach(function (a) { if (Date.now() - a.ts <= day) total++; });
    });
    chrome.action.setBadgeText({ text: total ? String(Math.min(total, 99)) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#a78bfa' });
  }

  // ---------- init ----------
  try {
  health('checking Poke...', false);
  if (typeof Poke === 'undefined') { health('POKE MISSING', false); throw new Error('Poke not loaded'); }
  health('Poke OK, init...', false);
  restorePopupState();
  chrome.action.setBadgeText({ text: '' });
  applyTheme();
  applyCompact();
  loadRecent();
  load(function () {
    render();
    if (state.watch.length) refreshAll();
    var intervalStart = Date.now();
    setInterval(refreshAll, REFRESH_MS);
    setTimeout(function () { updateBadge(); }, 500);
    setInterval(updateRefreshAge, 10000);
    countdownTimer = setInterval(function () {
      var elapsed = Date.now() - intervalStart;
      var pct = Math.min(100, (elapsed % REFRESH_MS) / REFRESH_MS * 100);
      els.refresh.style.setProperty('--progress', pct + '%');
      els.refresh.classList.add('refreshing');
    }, 250);
  });
  health('READY', true);
  } catch(e) { health('ERROR: ' + (e.message || 'unknown'), false); console.error(e); }
})();
