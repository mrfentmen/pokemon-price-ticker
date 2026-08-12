'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Poke = require('../ext/cards.js');

const CHARIZARD = {
  id: 'base1-4',
  name: 'Charizard',
  number: '4',
  set: { name: 'Base' },
  images: { small: 'https://images.pokemontcg.io/base1/4.png', large: 'https://images.pokemontcg.io/base1/4_hires.png' },
  tcgplayer: {
    url: 'https://prices.tcgplayer.com/…/base-charizard-4',
    updatedAt: '2026/08/10',
    prices: { holofoil: { low: 474, mid: 732.49, high: 4640.67, market: 825.38, directLow: 612.06 } }
  },
  cardmarket: {
    url: 'https://www.cardmarket.com/…',
    updatedAt: '2026/08/11',
    avg1: 3939.88, avg7: 2427.79, avg30: 1531.0,
    averageSellPrice: 1531.0, lowPrice: 799.0, trendPrice: 4184.6
  }
};

test('searchUrl quotes the name and orders by newest set', () => {
  const u = Poke.searchUrl('charizard');
  assert.ok(u.startsWith('https://api.pokemontcg.io/v2/cards?q=name:' + encodeURIComponent('"charizard"')));
  assert.ok(u.includes('pageSize=8'));
  assert.ok(u.includes('orderBy=-set.releaseDate'));
});

test('parseSearch maps cards to compact summaries with price', () => {
  const out = Poke.parseSearch({ data: [CHARIZARD] });
  assert.equal(out.length, 1);
  const c = out[0];
  assert.equal(c.id, 'base1-4');
  assert.equal(c.name, 'Charizard');
  assert.equal(c.set, 'Base');
  assert.equal(c.price, 825.38);
  assert.equal(c.variant, 'holofoil');
  assert.ok(c.tcgplayerUrl);
  assert.equal(Poke.parseSearch(null).length, 0);
  assert.equal(Poke.parseSearch({ data: [] }).length, 0);
});

test('parseQuote builds a full quote with trend from 1d vs 7d averages', () => {
  const q = Poke.parseQuote({ data: CHARIZARD });
  assert.equal(q.price, 825.38);
  assert.equal(q.variant, 'holofoil');
  assert.equal(q.currency, 'USD');
  // avg1 3939.88 vs avg7 2427.79 -> positive trend
  assert.ok(q.trend);
  assert.equal(q.trend.dir, 1);
  assert.ok(q.trend.pct > 60 && q.trend.pct < 65);
  assert.equal(q.updatedAt, '2026/08/10');
  assert.equal(Poke.parseQuote(null), null);
  assert.equal(Poke.parseQuote({}), null);
});

test('parseSearch ranks priced cards above unpriced promos', () => {
  const unpriced = { id: 'p1', name: 'Charizard', number: '294', set: { name: 'Promo' }, images: { small: '' }, tcgplayer: { prices: {} } };
  const priced = { id: 's1', name: 'Charizard', number: '130', set: { name: 'Mega' }, images: { small: '' }, tcgplayer: { prices: { holofoil: { market: 12.5 } } } };
  const out = Poke.parseSearch({ data: [unpriced, priced] });
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 's1'); // priced first
  assert.equal(out[0].price, 12.5);
  assert.equal(out[1].price, null);
});

test('pickMarket prefers the primary variant in holofoil > normal > reverse order', () => {
  assert.equal(Poke.pickMarket(CHARIZARD), 825.38); // holofoil wins
  assert.equal(Poke.pickMarket({}), null);
  // no holofoil -> normal (the base variant) is preferred over reverseHolofoil
  assert.equal(
    Poke.pickMarket({ tcgplayer: { prices: { reverseHolofoil: { market: 12 }, normal: { market: 5 } } } }),
    5
  );
  // only reverseHolofoil -> falls back to whatever exists
  assert.equal(
    Poke.pickMarket({ tcgplayer: { prices: { reverseHolofoil: { market: 12 } } } }),
    12
  );
});

test('pickVariantName labels non-normal variants only', () => {
  assert.equal(Poke.pickVariantName(CHARIZARD), 'holofoil');
  assert.equal(Poke.pickVariantName({ tcgplayer: { prices: { normal: { market: 1 } } } }), '');
  assert.equal(Poke.pickVariantName({}), '');
});

test('formatPrice handles USD, EUR and missing', () => {
  assert.equal(Poke.formatPrice(825.38, 'USD'), '$825.38');
  assert.equal(Poke.formatPrice(1531, 'EUR'), '€1,531.00');
  assert.equal(Poke.formatPrice(null), '—');
  assert.equal(Poke.formatPrice(NaN), '—');
});

test('formatTrend signs and rounds', () => {
  assert.equal(Poke.formatTrend({ pct: 62.34 }), '+62.3%');
  assert.equal(Poke.formatTrend({ pct: -4.56 }), '-4.6%');
  assert.equal(Poke.formatTrend(null), '');
});

test('ageLabel formats the offline quote age', () => {
  const now = Date.now();
  assert.equal(Poke.ageLabel(now - 30_000), 'just now');
  assert.equal(Poke.ageLabel(now - 5 * 60_000), '5m ago');
  assert.equal(Poke.ageLabel(now - 3 * 3600_000), '3h ago');
  assert.equal(Poke.ageLabel(now - 2 * 86400_000), '2d ago');
  assert.equal(Poke.ageLabel(now + 60_000), 'just now');
  assert.equal(Poke.ageLabel(null), '');
});

test('fetchJson retries transient 5xx with growing backoff, then succeeds', async () => {
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls < 3) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ data: [{ id: 'x' }] }) };
  };
  try {
    const out = await Poke.fetchJson('https://example.test/cards', { tries: 3, backoff: 1 });
    assert.equal(calls, 3);
    assert.equal(out.data[0].id, 'x');
  } finally {
    global.fetch = realFetch;
  }
});

test('fetchJson does not retry 4xx (name errors are not transient)', async () => {
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 400 }; };
  try {
    await assert.rejects(() => Poke.fetchJson('https://example.test/cards', { tries: 3, backoff: 1 }));
    assert.equal(calls, 1);
  } finally {
    global.fetch = realFetch;
  }
});

test('offlineMsg and staleLevel match the family pattern', () => {
  assert.equal(Poke.offlineMsg(null), 'Offline — showing last prices.');
  assert.match(Poke.offlineMsg(Date.now() - 120_000), /^Offline — quotes from 2m ago$/);
  const now = Date.now();
  assert.equal(Poke.staleLevel(now - 30_000), 'stale-fresh');
  assert.equal(Poke.staleLevel(now - 2 * 3600_000), 'stale-warn');
  assert.equal(Poke.staleLevel(now - 2 * 86400_000), 'stale-old');
  assert.equal(Poke.staleLevel(null), '');
});

test('sparkBars normalizes daily snapshots for the 30-day sparkline', () => {
  const daily = [
    { d: '2026-08-01', p: 100 },
    { d: '2026-08-02', p: 200 },
    { d: '2026-08-03', p: 50 }
  ];
  const bars = Poke.sparkBars(daily, 30);
  assert.equal(bars.length, 3);
  assert.equal(bars[1], 1); // 200/200
  assert.equal(bars[0], 0.5);
  assert.equal(bars[2], 0.25);
  assert.ok(bars[2] >= 0.04); // floor
  assert.equal(Poke.sparkBars([], 30).length, 0);
  assert.equal(Poke.sparkBars(null, 30).length, 0);
});
