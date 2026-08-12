'use strict';
/* global Poke, chrome */

(function () {
  var REFRESH_MS = 60 * 1000; // auto-refresh quotes while the popup is open

  var state = {
    watch: [],   // {id, name, set, number, image, price, variant, trend, updatedAt, tcgplayerUrl, ts}
    loading: false
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
    exportCsv: document.getElementById('exportCsv')
  };

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
    } catch (_) { /* audio not available */ }
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
    if (!Array.isArray(entry.alertLog)) entry.alertLog = [];
    var threshold = dir === 'above' ? entry.alertAbove : entry.alertBelow;
    var verb = dir === 'above' ? 'hit' : 'dropped below';
    // percentage alert fallback
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
          if (!Array.isArray(c.alertLog)) c.alertLog = [];
          else c.alertLog = c.alertLog.filter(function (a) { return a && typeof a.ts === 'number' && typeof a.price === 'number'; }).slice(-50);
          return c;
        });
      }
      if (cb) cb();
    });
  }

  // ---------- search ----------
  function doSearch(query) {
    var q = query.trim();
    if (q.length < 2) {
      els.results.hidden = true;
      return;
    }
    var myId = ++searchId;
    els.results.innerHTML = '<div class="res-note">Searching…</div>';
    els.results.hidden = false;
    // Three tries with a growing backoff: the feed can flap, and one retry
    // is not always enough to ride out a bad patch.
    Poke.fetchJson(Poke.searchUrl(q), { tries: 3, backoff: 700 })
      .then(function (json) {
        if (myId !== searchId) return;
        var cards = Poke.parseSearch(json);
        renderResults(cards, q);
      })
      .catch(function (err) {
        if (myId !== searchId) return;
        // A network/5xx failure means the feed is down — the card name is
        // probably fine. Only a 4xx (or an empty parse) means "not found".
        var feedProblem = !err || !err.status || err.status === 429 || err.status >= 500;
        els.results.innerHTML = feedProblem
          ? '<div class="res-note">The price feed is hiccuping — try again in a moment.</div>'
          : '<div class="res-note">No luck — check the name and try again.</div>';
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
      row.type = 'button';
      row.className = 'res-row';
      var thumb = document.createElement('img');
      thumb.className = 'res-thumb';
      thumb.alt = '';
      thumb.src = c.image;
      thumb.addEventListener('error', function () { thumb.remove(); });
      var body = document.createElement('span');
      body.className = 'res-body';
      var name = document.createElement('span');
      name.className = 'res-name';
      name.textContent = c.name + (c.number ? ' · ' + c.number : '');
      var set = document.createElement('span');
      set.className = 'res-set';
      set.textContent = c.set || '';
      body.appendChild(name);
      body.appendChild(set);
      var price = document.createElement('span');
      price.className = 'res-price';
      price.textContent = c.price != null ? Poke.formatPrice(c.price) : '—';
      row.appendChild(thumb);
      row.appendChild(body);
      row.appendChild(price);
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
  });
  els.search.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { doSearch(els.search.value); }
    if (ev.key === 'Escape') { els.results.hidden = true; }
  });
  els.go.addEventListener('click', function () { doSearch(els.search.value); });
  document.addEventListener('click', function (ev) {
    if (!ev.target.closest('.search-wrap')) els.results.hidden = true;
  });

  // ---------- watchlist ----------
  function addCard(c) {
    var existing = state.watch.some(function (w) { return w.id === c.id; });
    if (existing) {
      setStatus('Already on your ticker.');
      return;
    }
    state.watch.unshift({
      id: c.id, name: c.name, set: c.set, number: c.number, image: c.image,
      price: c.price, variant: c.variant, trend: null, updatedAt: '', tcgplayerUrl: c.tcgplayerUrl,
      // Seed ts from the search result: the price shown is real and fresh, so
      // a failed quote refresh degrades to the staleness path ("quotes from
      // just now") instead of a red error.
      ts: Date.now()
    });
    save();
    render();
    refreshCard(state.watch[0]);
  }

  function removeCard(id) {
    state.watch = state.watch.filter(function (w) { return w.id !== id; });
    save();
    render();
  }

  // Refresh a single card's quote (used right after adding).
  function refreshCard(entry) {
    var myId = ++refreshId;
    // Same 3-try ladder as search: quotes are the core of the ticker.
    Poke.fetchJson(Poke.cardUrl(entry.id), { tries: 3, backoff: 700 })
      .then(function (json) {
        if (myId !== refreshId) return;
        var q = Poke.parseQuote(json);
        if (!q) throw new Error('bad payload');
        applyQuote(entry.id, q);
        setStatus('');
      })
      .catch(function () {
        if (myId !== refreshId) return;
        // keep the search-list price; say so honestly
        if (entry.ts) {
          setStatus(Poke.offlineMsg(entry.ts));
          setStale(entry.ts);
        } else {
          setStatus('Could not fetch a quote for ' + entry.name + '.', true);
        }
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
        .catch(function () { /* per-card failure keeps the cached quote */ })
        .finally(function () {
          if (myId !== refreshId) return;
          pending--;
          if (pending > 0) return;
          els.refresh.classList.remove('spinning');
          if (succeeded > 0) {
            setStatus('');
          } else {
            // everything failed: fall back to cached quotes with their age
            var oldest = null;
            state.watch.forEach(function (w) {
              if (w.ts && (oldest === null || w.ts < oldest)) oldest = w.ts;
            });
            if (oldest) {
              setStatus(Poke.offlineMsg(oldest));
              setStale(oldest);
            } else {
              setStatus('Could not reach the price feed. Check your connection.', true);
            }
          }
        });
    });
  }

  function applyQuote(id, q) {
    var entry = state.watch.find(function (w) { return w.id === id; });
    if (!entry) return;
    var oldPrice = entry.price;
    var crossedAbove = entry.alertAbove != null && oldPrice != null &&
      oldPrice < entry.alertAbove && q.price != null && q.price >= entry.alertAbove;
    var crossedBelow = entry.alertBelow != null && oldPrice != null &&
      oldPrice > entry.alertBelow && q.price != null && q.price <= entry.alertBelow;
    entry.price = q.price;
    entry.variant = q.variant;
    entry.trend = q.trend;
    entry.updatedAt = q.updatedAt;
    entry.tcgplayerUrl = q.tcgplayerUrl;
    entry.image = q.image || entry.image;
    entry.cmAvg1 = q.cmAvg1; entry.cmAvg7 = q.cmAvg7; entry.cmAvg30 = q.cmAvg30;
    entry.ts = Date.now();
    if (crossedAbove) { flashAlert(entry, 'above'); chime(); updateBadge(); }
    if (crossedBelow) { flashAlert(entry, 'below'); chime(); updateBadge(); }
    // percentage-based alert crossing
    if (entry.alertPct && entry.alertPctBase != null && oldPrice != null && q.price != null) {
      var pctChange = Math.abs(q.price - entry.alertPctBase) / entry.alertPctBase * 100;
      var prevPct = Math.abs(oldPrice - entry.alertPctBase) / entry.alertPctBase * 100;
      if (prevPct < entry.alertPct && pctChange >= entry.alertPct) {
        flashAlert(entry, q.price >= entry.alertPctBase ? 'above' : 'below'); chime();
      }
    }
    // daily price snapshot (30-day sparkline — update today's entry or push a new day)
    if (q.price != null) {
      if (!entry.daily) entry.daily = [];
      var today = new Date().toISOString().slice(0, 10);
      var last = entry.daily.length ? entry.daily[entry.daily.length - 1] : null;
      if (last && last.d === today) { last.p = q.price; }
      else { entry.daily.push({ d: today, p: q.price }); if (entry.daily.length > 30) entry.daily = entry.daily.slice(-30); }
    }
    save();
    render();
  }

  // ---------- rendering ----------
  function render() {
    els.empty.hidden = state.watch.length > 0;
    els.tapeWrap.hidden = state.watch.length === 0;
    els.clearAll.hidden = state.watch.length === 0;
    els.exportCsv.hidden = state.watch.length === 0;
    renderTape();
    // portfolio total
    var sum = 0; var priced = 0;
    state.watch.forEach(function (w) { if (w.price != null) { sum += w.price; priced++; } });
    els.portfolio.textContent = priced ? 'Total: $' + sum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' (' + priced + ' cards)' : '';
    // sort
    var sort = els.sortBy.value;
    var sorted = state.watch.slice();
    if (sort === 'name') sorted.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    else if (sort === 'price-desc') sorted.sort(function (a, b) { return (b.price || 0) - (a.price || 0); });
    else if (sort === 'price-asc') sorted.sort(function (a, b) { return (a.price || 0) - (b.price || 0); });
    else if (sort === 'trend-desc') sorted.sort(function (a, b) { var ta = a.trend ? a.trend.pct : 0; var tb = b.trend ? b.trend.pct : 0; return tb - ta; });
    else if (sort === 'trend-asc') sorted.sort(function (a, b) { var ta = a.trend ? a.trend.pct : 0; var tb = b.trend ? b.trend.pct : 0; return ta - tb; });
    els.list.innerHTML = '';
    sorted.forEach(function (w) {
      els.list.appendChild(rowFor(w));
    });
  }

  function rowFor(w) {
    var row = document.createElement('article');
    row.className = 'card-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.title = w.tcgplayerUrl ? 'Open on TCGplayer' : w.name;

    var thumb = document.createElement('img');
    thumb.className = 'card-thumb';
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.src = w.image;
    thumb.addEventListener('error', function () {
      thumb.remove();
      row.insertBefore(thumbPlaceholder(), row.querySelector('.card-info') || row.firstChild);
    });

    var info = document.createElement('div');
    info.className = 'card-info';
    var name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = w.name;
    var set = document.createElement('div');
    set.className = 'card-set';
    set.textContent = w.set || '';
    info.appendChild(name);
    info.appendChild(set);

    var quote = document.createElement('div');
    quote.className = 'card-quote';
    var price = document.createElement('div');
    price.className = 'card-price';
    price.textContent = Poke.formatPrice(w.price);
    if (w.variant) {
      var v = document.createElement('span');
      v.className = 'card-variant';
      v.textContent = w.variant.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
      price.appendChild(v);
    }
    var trend = document.createElement('div');
    trend.className = 'card-trend' + (w.trend ? (w.trend.dir === 1 ? ' up' : ' down') : ' flat');
    trend.textContent = w.trend ? '▲ ' + Poke.formatTrend(w.trend) : '—';
    quote.appendChild(price);
    quote.appendChild(trend);

    var bars = document.createElement('div');
    bars.className = 'card-bars';
    bars.title = '30-day price sparkline';
    var heights = Poke.sparkBars(w.daily, 30);
    if (heights.length) {
      heights.forEach(function (v) {
        var b = document.createElement('span');
        b.className = 'bar';
        b.style.height = Math.round(v * 16) + 'px';
        bars.appendChild(b);
      });
    } else {
      bars.title = '';
    }

    var x = document.createElement('button');
    x.className = 'row-x';
    x.type = 'button';
    x.title = 'Remove from ticker';
    x.setAttribute('aria-label', 'Remove ' + w.name + ' from ticker');
    x.textContent = '✕';
    x.addEventListener('click', function (ev) {
      ev.stopPropagation();
      removeCard(w.id);
    });

    row.appendChild(thumb);
    row.appendChild(info);
    row.appendChild(bars);
    row.appendChild(quote);
    row.appendChild(x);

    // ---- alert affordance ----
    var alertBtn = document.createElement('button');
    alertBtn.className = 'alert-btn';
    alertBtn.type = 'button';
    var hasAlert = w.alertAbove || w.alertBelow;
    if (hasAlert) {
      var parts = [];
      if (w.alertAbove) parts.push('above $' + w.alertAbove.toLocaleString());
      if (w.alertBelow) parts.push('below $' + w.alertBelow.toLocaleString());
      alertBtn.title = 'Alert: ' + parts.join(' · ') + ' (click to change)';
      alertBtn.classList.remove('alert-off');
    } else {
      alertBtn.title = 'Set a price alert';
      alertBtn.classList.add('alert-off');
    }
    alertBtn.textContent = '🔔';
    row.appendChild(alertBtn);

    var panel = document.createElement('div');
    panel.className = 'alert-panel';
    panel.hidden = true;

    function mkRow(label, key) {
      var row = document.createElement('div');
      row.className = 'alert-row';
      var al = document.createElement('span');
      al.className = 'alert-label'; al.textContent = label;
      var ainp = document.createElement('input');
      ainp.className = 'alert-input'; ainp.type = 'number'; ainp.min = '0.01'; ainp.step = 'any';
      ainp.value = (w[key] || '');
      ainp.placeholder = key === 'alertPct' ? '10' : (w.price != null ? w.price.toFixed(2) : '0.00');
      if (key === 'alertPct') ainp.title = 'Current base: ' + (w.alertPctBase != null ? Poke.formatPrice(w.alertPctBase) : 'not set') + ' — alert fires when price moves ± this % from the base';
      var aset = document.createElement('button');
      aset.className = 'alert-set'; aset.type = 'button'; aset.textContent = 'Set';
      var aclr = document.createElement('button');
      aclr.className = 'alert-clear'; aclr.type = 'button'; aclr.textContent = 'Clear';
      row.appendChild(al); row.appendChild(ainp); row.appendChild(aset); row.appendChild(aclr);

      aset.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var v = parseFloat(ainp.value);
        if (isNaN(v) || v <= 0) { panel.hidden = true; return; }
        w[key] = v;
        if (key === 'alertPct') w.alertPctBase = w.price;
        updateAlertBtn();
        panel.hidden = true;
        save();
      });
      aclr.addEventListener('click', function (ev) {
        ev.stopPropagation();
        w[key] = null;
        if (key === 'alertPct') w.alertPctBase = null;
        ainp.value = '';
        updateAlertBtn();
        panel.hidden = true;
        save();
      });
      return row;
    }

    function updateAlertBtn() {
      var has = w.alertAbove || w.alertBelow || w.alertPct;
      if (has) {
        var p = [];
        if (w.alertAbove) p.push('above $' + w.alertAbove.toLocaleString());
        if (w.alertBelow) p.push('below $' + w.alertBelow.toLocaleString());
        if (w.alertPct) p.push('±' + w.alertPct + '%');
        alertBtn.title = 'Alert: ' + p.join(' · ') + ' (click to change)';
        alertBtn.classList.remove('alert-off');
      } else {
        alertBtn.title = 'Set a price alert';
        alertBtn.classList.add('alert-off');
      }
    }

    panel.appendChild(mkRow('Alert above $', 'alertAbove'));
    panel.appendChild(mkRow('Alert below $', 'alertBelow'));
    panel.appendChild(mkRow('Alert if ±%', 'alertPct'));

    alertBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        var firstInput = panel.querySelector('.alert-input');
        if (firstInput) firstInput.focus();
      }
    });

    var wrap = document.createElement('div');
    wrap.appendChild(row);
    wrap.appendChild(panel);

    row.addEventListener('click', function () {
      if (w.tcgplayerUrl) chrome.windows.create({ type: 'popup', url: w.tcgplayerUrl, width: 900, height: 700 });
    });
    row.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        if (w.tcgplayerUrl) chrome.windows.create({ type: 'popup', url: w.tcgplayerUrl, width: 900, height: 700 });
      }
    });
    return wrap;
  }

  function thumbPlaceholder() {
    var d = document.createElement('div');
    d.className = 'card-thumb ph';
    d.textContent = '🃏';
    return d;
  }

  function renderTape() {
    if (!state.watch.length) {
      els.tape.innerHTML = '';
      return;
    }
    var parts = state.watch.map(function (w) {
      var cls = w.trend ? (w.trend.dir === 1 ? 'up' : 'down') : 'flat';
      var chg = w.trend ? Poke.formatTrend(w.trend) : '—';
      return '<span class="tape-item"><span class="tape-name">' + esc(w.name) + '</span>' +
        '<span class="tape-price">' + esc(Poke.formatPrice(w.price)) + '</span>' +
        '<span class="tape-chg ' + cls + '">' + esc(chg) + '</span></span>';
    });
    // duplicate for a seamless loop
    els.tape.innerHTML = parts.join('') + parts.join('');
    els.tape.style.animation = 'none';
    void els.tape.offsetWidth;
    els.tape.style.animation = '';
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // ---------- alert log ----------
  function renderAlertLog() {
    var now = Date.now();
    var day = 24 * 60 * 60 * 1000;
    var items = [];
    state.watch.forEach(function (w) {
      if (!Array.isArray(w.alertLog)) return;
      w.alertLog.forEach(function (a) {
        if (now - a.ts <= day) items.push(a);
      });
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

  // ---------- refresh button + auto-refresh ----------
  els.sortBy.addEventListener('change', function () { render(); });
  els.exportCsv.addEventListener('click', exportCsv);
  els.refresh.addEventListener('click', refreshAll);
  els.retry.addEventListener('click', refreshAll);
  els.clearAll.addEventListener('click', function () {
    state.watch = [];
    save();
    setStatus('Cleared your ticker');
    render();
  });

  // ---------- keyboard page zoom (family pattern) ----------
  function applyPageZoom(z) {
    pageZoom = Math.round(z * 10) / 10;
    document.body.style.zoom = pageZoom === 1 ? '' : String(pageZoom);
  }
  function flashZoomHint() {
    setStatus('Zoom ' + Math.round(pageZoom * 100) + '%');
    hintTimer = setTimeout(function () { setStatus(''); }, 1400);
  }
  document.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      els.search.focus();
      els.search.select();
      return;
    }
    if (!(ev.ctrlKey || ev.metaKey)) return;
    var k = ev.key;
    if (k === '+' || k === '=' || k === '-' || k === '_') {
      ev.preventDefault();
      var dz = (k === '+' || k === '=') ? 0.1 : -0.1;
      applyPageZoom(Math.max(0.5, Math.min(2, pageZoom + dz)));
      flashZoomHint();
    } else if (k === '0') {
      ev.preventDefault();
      applyPageZoom(1);
      flashZoomHint();
    }
  });

  // ---------- CSV export ----------
  function exportCsv() {
    var rows = [['Name','Price','Trend','Alert Above','Alert Below','Alert ±%','24h Alerts']];
    state.watch.forEach(function (w) {
      var trendStr = w.trend ? (w.trend.dir === 1 ? '+' : '') + w.trend.pct.toFixed(1) + '%' : '—';
      var alertCount = 0;
      if (Array.isArray(w.alertLog)) {
        var day = 24 * 60 * 60 * 1000;
        alertCount = w.alertLog.filter(function (a) { return Date.now() - a.ts <= day; }).length;
      }
      rows.push([
        w.name,
        w.price != null ? w.price.toFixed(2) : '',
        trendStr,
        w.alertAbove != null ? w.alertAbove.toFixed(2) : '',
        w.alertBelow != null ? w.alertBelow.toFixed(2) : '',
        w.alertPct != null ? w.alertPct + '%' : '',
        String(alertCount)
      ]);
    });
    var csv = rows.map(function (r) { return r.map(function (c) { return '"' + c + '"'; }).join(','); }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'poketicker-watchlist.csv'; a.click();
    URL.revokeObjectURL(url);
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
  chrome.action.setBadgeText({ text: '' });
  load(function () {
    render();
    if (state.watch.length) refreshAll();
    setInterval(refreshAll, REFRESH_MS);
    setTimeout(function () { updateBadge(); }, 500);
  });
})();
