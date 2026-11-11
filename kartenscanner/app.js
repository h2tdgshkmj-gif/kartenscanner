/* Kartenscanner – erkennt deutsche Pokémon-Karten an Set-Kürzel und Nummer
   und zeigt den Cardmarket-Preis aus der offenen TCGdex-Datenbank.
   Datenschutz: Kamerabilder bleiben im Arbeitsspeicher, nichts wird gespeichert,
   ins Netz gehen nur Anfragen an api.tcgdex.net (Set und Nummer) und Kartenbilder. */
(function () {
  'use strict';

  var API = 'https://api.tcgdex.net/v2/';
  var DEBUG = /[?&]debug\b/.test(location.search); // ?debug zeigt den erkannten Text in der Konsole
  var LANG = 'de';

  var $ = function (id) { return document.getElementById(id); };
  var euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  var dateFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });

  var state = {
    stream: null,
    photoUrl: null,
    setsCache: null,
    setCache: {},
    card: null,
    cardmarket: null,
    variant: 'normal',
    lastInput: { code: '', number: '' }
  };

  /* ---------- Bildschirme ---------- */

  var screens = ['start', 'scan', 'busy', 'sets', 'confirm', 'price', 'manual'];

  function show(name) {
    screens.forEach(function (s) { $('screen-' + s).hidden = s !== name; });
    if (name !== 'scan') stopCamera();
    window.scrollTo(0, 0);
  }

  function busy(text) {
    $('busy-text').textContent = text;
    show('busy');
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-back]'), function (b) {
    b.addEventListener('click', function () { show(b.getAttribute('data-back')); });
  });

  /* ---------- Kamera ---------- */

  async function startCamera() {
    show('scan');
    $('btn-shutter').disabled = true;
    $('scan-hint').textContent = 'Lege die Karte in den Rahmen. Gutes Licht und keine Schutzhülle helfen.';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      openManual({ error: 'Die Kamera funktioniert hier nicht. Die Seite muss über https:// geöffnet werden. Du kannst die Nummer aber selbst eingeben.' });
      return;
    }
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      var video = $('video');
      video.srcObject = state.stream;
      await video.play();
      $('btn-shutter').disabled = false;
      warmUpOcr();
    } catch (e) {
      var msg = (e && e.name === 'NotAllowedError')
        ? 'Du hast den Kamerazugriff nicht erlaubt. Erlaube ihn in Safari über „aA“ › Website-Einstellungen › Kamera, oder gib die Nummer selbst ein.'
        : 'Die Kamera konnte nicht gestartet werden. Du kannst die Nummer selbst eingeben.';
      openManual({ error: msg });
    }
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach(function (t) { t.stop(); });
      state.stream = null;
    }
    var video = $('video');
    if (video) video.srcObject = null;
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.stream) show('start');
  });

  // Schneidet den Bereich innerhalb des Rahmens aus dem Videobild aus.
  function captureCard() {
    var video = $('video');
    var vw = video.videoWidth, vh = video.videoHeight;
    var vf = $('viewfinder').getBoundingClientRect();
    var g = $('guide').getBoundingClientRect();
    var scale = Math.max(vf.width / vw, vf.height / vh); // object-fit: cover
    var offX = (vf.width - vw * scale) / 2;
    var offY = (vf.height - vh * scale) / 2;
    var sx = (g.left - vf.left - offX) / scale;
    var sy = (g.top - vf.top - offY) / scale;
    var sw = g.width / scale;
    var sh = g.height / scale;
    sx = Math.max(0, sx); sy = Math.max(0, sy);
    sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
    var c = document.createElement('canvas');
    c.width = Math.round(sw); c.height = Math.round(sh);
    c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }

  // Unterer Kartenrand, vergrößert, in Graustufen und mit gestrecktem Kontrast.
  function bottomStrip(card, invert) {
    var top = Math.round(card.height * 0.85);
    var h = card.height - top;
    var target = 1800;
    var k = Math.max(1, target / card.width);
    var c = document.createElement('canvas');
    c.width = Math.round(card.width * k);
    c.height = Math.round(h * k);
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(card, 0, top, card.width, h, 0, 0, c.width, c.height);
    var img = ctx.getImageData(0, 0, c.width, c.height);
    var d = img.data, min = 255, max = 0, i, v;
    for (i = 0; i < d.length; i += 4) {
      v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    var range = Math.max(1, max - min);
    for (i = 0; i < d.length; i += 4) {
      v = (d[i] - min) * 255 / range;
      if (invert) v = 255 - v;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /* ---------- Texterkennung (läuft komplett im Browser) ---------- */

  var ocrWorkerPromise = null;

  function warmUpOcr() {
    if (!ocrWorkerPromise) {
      var base = new URL('vendor/tesseract/', document.baseURI).href;
      ocrWorkerPromise = Tesseract.createWorker('eng', 1, {
        workerPath: base + 'worker.min.js',
        corePath: base + 'core/',
        langPath: base + 'lang/',
        workerBlobURL: false,
        gzip: true,
        cacheMethod: 'none' // nichts im Browser speichern
      }).then(function (w) {
        return w.setParameters({
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/',
          tessedit_pageseg_mode: '11'
        }).then(function () { return w; });
      }).catch(function (e) {
        ocrWorkerPromise = null;
        throw e;
      });
    }
    return ocrWorkerPromise;
  }

  var DIGIT_FIX = { O: '0', D: '0', Q: '0', I: '1', L: '1', T: '1', S: '5', B: '8', Z: '2', G: '6' };

  function fixDigits(s) {
    return s.replace(/[A-Z]/g, function (ch) { return DIGIT_FIX[ch] || ch; });
  }

  // Sucht "025/165" und ein Set-Kürzel wie "MEW" im erkannten Text.
  function parseOcr(text) {
    var t = (text || '').toUpperCase();
    var result = { number: null, total: null, code: null };
    var m, re = /([0-9ODQILTSBZG]{1,3})\s*\/\s*([0-9ODQILTSBZG]{2,3})/g;
    while ((m = re.exec(t))) {
      var n = parseInt(fixDigits(m[1]), 10), tot = parseInt(fixDigits(m[2]), 10);
      if (!isNaN(n) && !isNaN(tot) && n > 0 && tot >= 10) {
        result.number = n; result.total = tot;
        break;
      }
    }
    // Die Texterkennung lässt Leerzeichen oft weg ("GMEWDE025/165"), daher ohne Leerzeichen suchen.
    var known = window.SET_CODES || {};
    var compact = t.replace(/\s+/g, '');
    var withLang = /([A-Z]{3})DE[0-9ODQILTSBZG]{1,3}\//.exec(compact);
    if (withLang) {
      result.code = withLang[1];
    } else {
      var codes = Object.keys(known);
      for (var i = 0; i < codes.length; i++) {
        if (compact.indexOf(codes[i]) !== -1) { result.code = codes[i]; break; }
      }
    }
    return result;
  }

  async function onShutter() {
    var video = $('video');
    if (!video.videoWidth) return;
    var card = captureCard();
    stopCamera();
    setPhoto(card);
    busy(ocrWorkerPromise ? 'Nummer wird gelesen …' : 'Texterkennung wird geladen …');
    var parsed;
    try {
      var worker = await warmUpOcr();
      $('busy-text').textContent = 'Nummer wird gelesen …';
      var r = await worker.recognize(bottomStrip(card, false));
      if (DEBUG) console.info('OCR 1:', JSON.stringify(r.data.text));
      parsed = parseOcr(r.data.text);
      if (!parsed.number) {
        var r2 = await worker.recognize(bottomStrip(card, true)); // helle Schrift auf dunklem Grund
        if (DEBUG) console.info('OCR 2:', JSON.stringify(r2.data.text));
        var p2 = parseOcr(r2.data.text);
        if (p2.number) parsed = p2;
        if (!parsed.code && p2.code) parsed.code = p2.code;
      }
    } catch (e) {
      openManual({ error: 'Die Texterkennung konnte nicht geladen werden. Prüfe deine Internetverbindung oder gib die Nummer selbst ein.' });
      return;
    }
    if (!parsed.number) {
      openManual({ tips: true, code: parsed.code || '' });
      return;
    }
    findCard(parsed.code, parsed.number, parsed.total);
  }

  function setPhoto(canvas) {
    if (state.photoUrl) { URL.revokeObjectURL(state.photoUrl); state.photoUrl = null; }
    if (!canvas) return;
    canvas.toBlob(function (blob) {
      if (!blob) return;
      state.photoUrl = URL.createObjectURL(blob);
      $('img-mine').src = state.photoUrl;
    }, 'image/jpeg', 0.85);
  }

  /* ---------- Kartendatenbank TCGdex ---------- */

  async function api(path, lang) {
    var res;
    try {
      res = await fetch(API + (lang || LANG) + '/' + path, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store'
      });
    } catch (e) {
      var err = new Error('offline'); err.kind = 'network'; throw err;
    }
    if (res.status === 404) return null;
    if (!res.ok) { var e2 = new Error('http ' + res.status); e2.kind = 'network'; throw e2; }
    return res.json();
  }

  async function getSets() {
    if (!state.setsCache) state.setsCache = await api('sets');
    return state.setsCache || [];
  }

  async function getSet(id) {
    if (!state.setCache[id]) state.setCache[id] = await api('sets/' + encodeURIComponent(id));
    return state.setCache[id];
  }

  function netError() {
    openManual({ error: 'Die Kartendatenbank ist gerade nicht erreichbar. Prüfe deine Internetverbindung und versuche es gleich noch einmal.' });
  }

  async function findCard(code, number, total) {
    state.lastInput = { code: code || '', number: pad(number) + (total ? '/' + pad(total) : '') };
    busy('Karte wird gesucht …');
    try {
      var sets = await getSets();
      var known = window.SET_CODES || {};
      var candidates = sets.filter(function (s) {
        return s.cardCount && s.cardCount.official === total;
      });
      if (code && known[code]) {
        var exact = candidates.filter(function (s) { return s.id === known[code]; });
        if (exact.length) candidates = exact;
      }
      if (!candidates.length) {
        openManual({ error: 'Ich finde kein deutsches Set mit ' + total + ' Karten. Prüfe die Zahl hinter dem Schrägstrich.' });
        return;
      }
      if (candidates.length === 1) {
        await loadCard(candidates[0].id, number);
      } else {
        showSetChoice(candidates.slice().reverse(), number, total);
      }
    } catch (e) {
      netError();
    }
  }

  function showSetChoice(list, number, total) {
    var ul = $('set-list');
    ul.textContent = '';
    $('sets-intro').textContent = 'Es gibt mehrere Sets mit ' + total + ' Karten. Vergleiche das kleine Set-Symbol auf deiner Karte.';
    list.forEach(function (s) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'set-item';
      var sym = document.createElement('img');
      sym.alt = '';
      if (s.symbol) sym.src = s.symbol + '.png';
      var txt = document.createElement('span');
      txt.className = 'set-text';
      var name = document.createElement('span');
      name.className = 'set-name';
      name.textContent = s.name;
      var meta = document.createElement('span');
      meta.className = 'muted small';
      meta.textContent = total + ' Karten';
      txt.appendChild(name); txt.appendChild(meta);
      b.appendChild(sym); b.appendChild(txt);
      b.addEventListener('click', function () {
        busy('Karte wird gesucht …');
        loadCard(s.id, number).catch(netError);
      });
      li.appendChild(b);
      ul.appendChild(li);
    });
    show('sets');
  }

  async function loadCard(setId, number) {
    var set = await getSet(setId);
    if (!set) { openManual({ error: 'Dieses Set fehlt in der Datenbank.' }); return; }
    var brief = (set.cards || []).filter(function (c) { return parseInt(c.localId, 10) === number; })[0];
    if (!brief) {
      openManual({ error: 'Im Set „' + set.name + '“ gibt es keine Karte mit der Nummer ' + number + '.' });
      return;
    }
    var card = await api('cards/' + encodeURIComponent(brief.id));
    if (!card) { openManual({ error: 'Die Karte wurde nicht gefunden.' }); return; }

    var cm = card.pricing && card.pricing.cardmarket;
    var image = card.image;
    if (!cm || !image) {
      // Preise und Bilder sind nicht immer in jeder Sprache hinterlegt.
      var en = await api('cards/' + encodeURIComponent(brief.id), 'en').catch(function () { return null; });
      if (en) {
        if (!cm) cm = en.pricing && en.pricing.cardmarket;
        if (!image) image = en.image;
      }
    }
    state.card = card;
    state.cardmarket = cm || null;
    state.variant = 'normal';
    showConfirm(card, set, image);
  }

  /* ---------- Bestätigen ---------- */

  function hasReversePrice(cm) {
    return !!cm && ['avg30-holo', 'trend-holo', 'avg-holo'].some(function (k) { return cm[k] > 0; });
  }

  function showConfirm(card, set, image) {
    var official = $('img-official');
    official.removeAttribute('src');
    official.alt = 'Offizielles Kartenbild';
    if (image) official.src = image + '/high.webp';
    $('img-mine').parentNode.parentNode.hidden = !state.photoUrl;
    $('screen-confirm').classList.toggle('single', !state.photoUrl);

    $('confirm-name').textContent = card.name;
    var total = set.cardCount && set.cardCount.official;
    $('confirm-meta').textContent = set.name + ' · Nr. ' + card.localId + (total ? '/' + pad(total) : '');

    var showVariant = !!(card.variants && card.variants.reverse) && hasReversePrice(state.cardmarket);
    $('variant-block').hidden = !showVariant;
    $('variant-help').hidden = true;
    setVariant('normal');
    show('confirm');
  }

  function setVariant(v) {
    state.variant = v;
    $('variant-normal').setAttribute('aria-checked', String(v === 'normal'));
    $('variant-reverse').setAttribute('aria-checked', String(v === 'reverse'));
  }

  /* ---------- Preis ---------- */

  function pick(cm, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (cm[keys[i]] > 0) return { key: keys[i], value: cm[keys[i]] };
    }
    return null;
  }

  function showPrice() {
    var card = state.card, cm = state.cardmarket;
    var sfx = state.variant === 'reverse' ? '-holo' : '';
    $('price-name').textContent = card.name;
    $('price-meta').textContent = (card.set ? card.set.name + ' · ' : '') + 'Nr. ' + card.localId + ' · ' + (state.variant === 'reverse' ? 'Reverse Holo' : 'Standard');

    var main = cm && pick(cm, ['avg30' + sfx, 'trend' + sfx, 'avg' + sfx]);
    $('price-hero').hidden = !main;
    $('price-details').hidden = !main;
    $('price-none').hidden = !!main;
    if (main) {
      $('price-main').textContent = euro.format(main.value);
      var basis = {
        avg30: 'wert. Durchschnitt der letzten 30 Tage auf Cardmarket.',
        trend: 'wert. Aktueller Trendpreis auf Cardmarket (kein 30-Tage-Wert vorhanden).',
        avg: 'wert. Durchschnittlicher Verkaufspreis auf Cardmarket (kein 30-Tage-Wert vorhanden).'
      };
      $('price-basis').textContent = basis[main.key.replace('-holo', '')];
      var trend = cm['trend' + sfx], avg7 = cm['avg7' + sfx];
      $('price-trend').textContent = trend > 0 ? euro.format(trend) : '–';
      $('price-avg7').textContent = avg7 > 0 ? euro.format(avg7) : '–';
      var d = cm.updated ? new Date(cm.updated) : null;
      $('price-date').textContent = d && !isNaN(d) ? dateFmt.format(d) : '–';
    }
    show('price');
  }

  /* ---------- Manuelle Eingabe ---------- */

  function openManual(opts) {
    opts = opts || {};
    $('manual-title').textContent = opts.tips ? 'Nummer nicht lesbar' : (opts.title || 'Nummer eingeben');
    $('manual-tips').hidden = !opts.tips;
    var err = $('manual-error');
    err.hidden = !opts.error;
    err.textContent = opts.error || '';
    $('in-set').value = opts.code != null ? opts.code : state.lastInput.code;
    $('in-number').value = opts.number != null ? opts.number : state.lastInput.number;
    show('manual');
  }

  $('manual-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var code = $('in-set').value.trim().toUpperCase().replace(/[^A-Z]/g, '');
    var raw = $('in-number').value.trim();
    var m = /^(\d{1,3})\s*\/\s*(\d{1,3})$/.exec(raw);
    if (!m) {
      var err = $('manual-error');
      err.textContent = 'Bitte gib die Nummer mit Schrägstrich ein, so wie sie auf der Karte steht, zum Beispiel 025/165.';
      err.hidden = false;
      $('in-number').focus();
      return;
    }
    setPhoto(null);
    findCard(code, parseInt(m[1], 10), parseInt(m[2], 10));
  });

  function pad(n) { return n < 100 ? ('00' + n).slice(-3) : String(n); }

  /* ---------- Knöpfe ---------- */

  $('btn-start-scan').addEventListener('click', startCamera);
  $('btn-start-manual').addEventListener('click', function () {
    setPhoto(null);
    openManual({ code: '', number: '' });
  });
  $('btn-shutter').addEventListener('click', onShutter);
  $('btn-rescan').addEventListener('click', startCamera);
  $('btn-confirm-yes').addEventListener('click', showPrice);
  $('btn-confirm-no').addEventListener('click', function () {
    openManual({ title: 'Andere Karte wählen' });
  });
  $('btn-next-scan').addEventListener('click', startCamera);
  $('variant-normal').addEventListener('click', function () { setVariant('normal'); });
  $('variant-reverse').addEventListener('click', function () { setVariant('reverse'); });
  $('btn-variant-help').addEventListener('click', function () {
    $('variant-help').hidden = !$('variant-help').hidden;
  });
  $('img-official').addEventListener('error', function () {
    this.removeAttribute('src');
    this.alt = 'Kein Bild vorhanden';
  });

  // Nur für automatische Tests
  window.__kartenscanner = { parseOcr: parseOcr };
})();
