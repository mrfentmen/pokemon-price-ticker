'use strict';
/*
 * Pure helpers for PokéTicker. No DOM, no chrome.* calls — the same module
 * runs in the extension (browser) and in the Node unit tests.
 *
 * Data comes from the free, keyless Pokemon TCG API (pokemontcg.io v2):
 * card search + metadata, TCGplayer market prices per variant, and
 * Cardmarket 1d/7d/30d sale averages used for the trend arrows.
 */
(function (root) {
  var API = 'https://api.pokemontcg.io/v2';
  var UA = 'PokeTicker/1.0 (https://github.com/mrfentmen/pokemon-price-ticker; contactae2000@gmail.com)';

  function searchUrl(query, pageSize) {
    return API + '/cards?q=name:' + encodeURIComponent(query + '*') +
      '&pageSize=' + (pageSize || 8) + '&orderBy=-set.releaseDate';
  }

  function cardUrl(id) {
    return API + '/cards/' + encodeURIComponent(id);
  }

  // Parse the search endpoint into compact card summaries.
  // Priced cards rank first: the newest sets are often promos with no market
  // data yet, and for a price ticker those belong below tradable cards (the
  // relative newest-set order is kept within each group — stable sort).
  function parseSearch(json) {
    if (!json || !Array.isArray(json.data)) return [];
    return json.data.map(function (c) {
      return {
        id: c.id,
        name: c.name || '',
        set: (c.set && c.set.name) || '',
        number: c.number || '',
        image: (c.images && (c.images.small || c.images.large)) || '',
        price: pickMarket(c),
        variant: pickVariantName(c),
        tcgplayerUrl: (c.tcgplayer && c.tcgplayer.url) || ''
      };
    }).filter(function (c) { return c.name; })
      .sort(function (a, b) {
        return ((b.price != null) - (a.price != null));
      });
  }

  // Full quote for a watchlist card: price, trend, recency, page link.
  function parseQuote(json) {
    if (!json || typeof json !== 'object' || !json.data) return null;
    var c = json.data;
    var market = pickMarket(c);
    var variant = pickVariantName(c);
    var cm = c.cardmarket || {};
    var avg1 = cm.avg1, avg7 = cm.avg7, avg30 = cm.avg30;
    var trend = null; // {pct, dir} using 1d vs 7d sale averages
    if (avg1 != null && avg7 != null && avg7 > 0) {
      trend = { pct: ((avg1 - avg7) / avg7) * 100, dir: avg1 >= avg7 ? 1 : -1 };
    }
    return {
      id: c.id,
      name: c.name || '',
      set: (c.set && c.set.name) || '',
      number: c.number || '',
      image: (c.images && (c.images.small || c.images.large)) || '',
      price: market,
      variant: variant,
      currency: market != null ? 'USD' : (cm.averageSellPrice != null ? 'EUR' : ''),
      cmAvg1: avg1, cmAvg7: avg7, cmAvg30: avg30,
      trend: trend,
      updatedAt: (c.tcgplayer && c.tcgplayer.updatedAt) || '',
      tcgplayerUrl: (c.tcgplayer && c.tcgplayer.url) || ''
    };
  }

  // Highest-value variant's market price, preferring holofoil.
  function pickMarket(c) {
    var p = c.tcgplayer && c.tcgplayer.prices;
    if (!p) return null;
    var order = ['holofoil', 'normal', 'reverseHolofoil', '1stEditionHolofoil'];
    var keys = Object.keys(p);
    for (var i = 0; i < order.length; i++) {
      var v = p[order[i]];
      if (v && typeof v.market === 'number') return v.market;
    }
    // fall back to the highest market among whatever variants exist
    var best = null;
    keys.forEach(function (k) {
      var v = p[k];
      if (v && typeof v.market === 'number' && (best === null || v.market > best.market)) best = v;
    });
    return best ? best.market : null;
  }

  function pickVariantName(c) {
    var p = c.tcgplayer && c.tcgplayer.prices;
    if (!p) return '';
    var order = ['holofoil', 'normal', 'reverseHolofoil', '1stEditionHolofoil'];
    for (var i = 0; i < order.length; i++) {
      var v = p[order[i]];
      if (v && typeof v.market === 'number') return order[i] === 'normal' ? '' : order[i];
    }
    var keys = Object.keys(p);
    if (keys.length) return keys[0];
    return '';
  }

  function formatPrice(n, currency) {
    if (n == null || isNaN(n)) return '—';
    var sym = currency === 'EUR' ? '€' : '$';
    return sym + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatTrend(trend) {
    if (!trend) return '';
    var sign = trend.pct >= 0 ? '+' : '';
    return sign + trend.pct.toFixed(1) + '%';
  }

  // Relative age for "quotes from X ago" (ms timestamps).
  function ageLabel(ts) {
    if (!ts) return '';
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  // Offline status message for cached quotes, with their age.
  function offlineMsg(ts) {
    var age = ageLabel(ts);
    return age ? 'Offline — quotes from ' + age : 'Offline — showing last prices.';
  }

  // Staleness class for the offline status: green < 1h, amber 1-24h, red 24h+.
  function staleLevel(ts) {
    if (!ts) return '';
    var h = (Date.now() - ts) / 3600000;
    if (h < 1) return 'stale-fresh';
    if (h < 24) return 'stale-warn';
    return 'stale-old';
  }

  // Normalized heights (0..1) for the last `n` daily price snapshots — the
  // 30-day sparkline. Each snapshot is {d, p}.
  function sparkBars(pts, n) {
    n = n || 30;
    if (!Array.isArray(pts) || !pts.length) return [];
    var slice = pts.slice(-n).map(function (h) { return h.p; });
    var max = Math.max.apply(null, slice);
    if (!(max > 0)) return slice.map(function () { return 0; });
    return slice.map(function (p) { return Math.max(0.04, p / max); });
  }

  // Timeout + quiet retries with a growing backoff (the family resilience
  // pattern): retries only network errors and 5xx/429, never 4xx. The wait
  // before each retry is backoff * attempt-number (800ms, 1600ms, …) so a
  // flapping feed gets a real second (and third) chance without hammering it.
  function fetchJson(url, opts) {
    opts = opts || {};
    var tries = opts.tries != null ? opts.tries : 2;
    var ms = opts.ms || 12000;
    var backoff = opts.backoff || 800;
    function attempt(left) {
      return fetch(url, {
        headers: { 'Api-User-Agent': UA },
        signal: AbortSignal.timeout(ms)
      })
        .then(function (r) {
          if (!r.ok) {
            var e = new Error('HTTP ' + r.status);
            e.status = r.status;
            throw e;
          }
          return r.json();
        })
        .catch(function (err) {
          var retryable = !err.status || err.status === 429 || err.status >= 500;
          if (retryable && left > 1) {
            var wait = backoff * (tries - left + 1);
            return new Promise(function (resolve) { setTimeout(resolve, wait); })
              .then(function () { return attempt(left - 1); });
          }
          throw err;
        });
    }
    return attempt(tries);
  }

  var api = {
    searchUrl: searchUrl,
    cardUrl: cardUrl,
    parseSearch: parseSearch,
    parseQuote: parseQuote,
    pickMarket: pickMarket,
    pickVariantName: pickVariantName,
    formatPrice: formatPrice,
    formatTrend: formatTrend,
    ageLabel: ageLabel,
    offlineMsg: offlineMsg,
    staleLevel: staleLevel,
    sparkBars: sparkBars,
    fetchJson: fetchJson,
    UA: UA
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.Poke = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
