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
    clearAll: document.getElementById('clear-all')
  };

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
  }

  function setStale(ts) {
    var lv = Poke.staleLevel(ts);
    if (lv) els.status.classList.add(lv);
  }

  // ---------- persistence ----------
  function save() {
    chrome.storage.local.set({ ptWatchlist: state.watch });
  }

  function load(cb) {
    chrome.storage.local.get('ptWatchlist', function (d) {
      var w = d && d.ptWatchlist;
      if (Array.isArray(w)) {
        state.watch = w.filter(function (c) { return c && c.id && c.name; });
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
    entry.price = q.price;
    entry.variant = q.variant;
    entry.trend = q.trend;
    entry.updatedAt = q.updatedAt;
    entry.tcgplayerUrl = q.tcgplayerUrl;
    entry.image = q.image || entry.image;
    entry.cmAvg1 = q.cmAvg1; entry.cmAvg7 = q.cmAvg7; entry.cmAvg30 = q.cmAvg30;
    entry.ts = Date.now();
    save();
    render();
  }

  // ---------- rendering ----------
  function render() {
    els.empty.hidden = state.watch.length > 0;
    els.tapeWrap.hidden = state.watch.length === 0;
    els.clearAll.hidden = state.watch.length === 0;
    renderTape();
    els.list.innerHTML = '';
    state.watch.forEach(function (w) {
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
    bars.title = '1d · 7d · 30d sale averages';
    [w.cmAvg1, w.cmAvg7, w.cmAvg30].forEach(function (v) {
      var b = document.createElement('span');
      b.className = 'bar';
      if (v != null) b.style.height = Math.max(3, Math.round((v / Math.max(w.cmAvg1, w.cmAvg7, w.cmAvg30)) * 16)) + 'px';
      bars.appendChild(b);
    });
    if (!w.cmAvg1 && !w.cmAvg7 && !w.cmAvg30) bars.title = '';

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

    row.addEventListener('click', function () {
      if (w.tcgplayerUrl) chrome.tabs.create({ url: w.tcgplayerUrl });
    });
    row.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        if (w.tcgplayerUrl) chrome.tabs.create({ url: w.tcgplayerUrl });
      }
    });
    return row;
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

  // ---------- refresh button + auto-refresh ----------
  els.refresh.addEventListener('click', refreshAll);
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

  // ---------- init ----------
  load(function () {
    render();
    if (state.watch.length) refreshAll();
    setInterval(refreshAll, REFRESH_MS);
  });
})();
