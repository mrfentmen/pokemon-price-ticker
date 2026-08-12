(function () {
  var f = document.getElementById('pv');
  var box = document.getElementById('box');

  // Seed the popup preview with demo ticker content (pure DOM, no chrome.*).
  // The real popup would need chrome.storage to render its empty state, so
  // we paint the product state the store shot should show.
  function seed() {
    try {
      var doc = f.contentDocument;
      if (!doc) return;
      var tape = doc.getElementById('tape-wrap');
      var tapeEl = doc.getElementById('tape');
      var clear = doc.getElementById('clear-all');
      var empty = doc.getElementById('empty');
      if (tape) tape.hidden = false;
      if (clear) clear.hidden = false;
      if (empty) empty.hidden = true;
      var parts = [
        ['Charizard', '$825.38', 'up', '+62.3%'],
        ['Umbreon', '$1,204.55', 'up', '+18.9%'],
        ['Pikachu', '$412.10', 'down', '-4.2%'],
        ['Mewtwo', '$289.99', 'flat', '—']
      ];
      var items = parts.map(function (p) {
        return '<span class="tape-item"><span class="tape-name">' + p[0] + '</span>' +
          '<span class="tape-price">' + p[1] + '</span>' +
          '<span class="tape-chg ' + p[2] + '">' + p[3] + '</span></span>';
      }).join('');
      if (tapeEl) tapeEl.innerHTML = items + items; // duplicated for the seamless loop
      var list = doc.getElementById('list');
      if (list) {
        list.innerHTML =
          '<article class="card-row" tabindex="0" role="button">' +
          '<div class="card-thumb ph">🃏</div>' +
          '<div class="card-info"><div class="card-name">Charizard</div><div class="card-set">Base · 4</div></div>' +
          '<div class="card-bars" title="1d · 7d · 30d sale averages"><span class="bar" style="height:16px"></span><span class="bar" style="height:10px"></span><span class="bar" style="height:7px"></span></div>' +
          '<div class="card-quote"><div class="card-price">$825.38<span class="card-variant">HOLOFOIL</span></div><div class="card-trend up">▲ +62.3%</div></div>' +
          '<button class="row-x" type="button" title="Remove from ticker">✕</button>' +
          '</article>' +
          '<article class="card-row" tabindex="0" role="button">' +
          '<div class="card-thumb ph">🃏</div>' +
          '<div class="card-info"><div class="card-name">Umbreon</div><div class="card-set">Evolving Skies · 215</div></div>' +
          '<div class="card-bars" title="1d · 7d · 30d sale averages"><span class="bar" style="height:16px"></span><span class="bar" style="height:12px"></span><span class="bar" style="height:9px"></span></div>' +
          '<div class="card-quote"><div class="card-price">$1,204.55<span class="card-variant">HOLOFOIL</span></div><div class="card-trend up">▲ +18.9%</div></div>' +
          '<button class="row-x" type="button" title="Remove from ticker">✕</button>' +
          '</article>';
      }
    } catch (e) { /* iframe not ready yet */ }
  }

  function done() {
    window.__storeReady = true;
    window.dispatchEvent(new Event('store-ready'));
  }

  function measure() {
    var w = 380, h = 590;
    try {
      var doc = f.contentDocument;
      if (doc && doc.body) {
        w = Math.max(doc.body.scrollWidth, doc.documentElement ? doc.documentElement.scrollWidth : 0, 320);
        h = Math.max(doc.body.scrollHeight, doc.documentElement ? doc.documentElement.scrollHeight : 0, 180);
      }
    } catch (e) {}
    var scale = Math.min(430 / w, 560 / h, 1.25);
    f.width = w; f.height = h;
    box.style.width = Math.round(w * scale) + 'px';
    box.style.height = Math.round(h * scale) + 'px';
    f.style.transform = 'scale(' + scale + ')';
    f.style.transformOrigin = 'top left';
    done();
  }

  window.addEventListener('load', function () {
    try {
      var doc = f.contentDocument;
      if (doc && doc.readyState === 'complete') { seed(); measure(); }
      else { f.addEventListener('load', function () { seed(); measure(); }); }
    } catch (e) { f.addEventListener('load', function () { seed(); measure(); }); }
  });
  // Safety net: never leave the screenshot stuck waiting.
  setTimeout(done, 4000);
})();
