/* Kartenscanner – erkennt deutsche Pokémon-Karten an Set-Kürzel und Nummer
   und zeigt den Cardmarket-Preis aus der offenen TCGdex-Datenbank.
   Datenschutz: Kamerabilder bleiben im Arbeitsspeicher, nichts wird gespeichert,
   ins Netz gehen nur Anfragen an api.tcgdex.net (Set und Nummer) und Kartenbilder. */
(function () {
  'use strict';

  var API = 'https://api.tcgdex.net/v2/';
  var LANG = 'de';
  var DEBUG = /[?&]debug\b/.test(location.search); // ?debug zeigt auf dem Bildschirm, was erkannt wurde
  var AUTO_INTERVAL_MS = 700;

  var $ = function (id) { return document.getElementById(id); };
  var euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  var dateFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });

  var state = {
    stream: null,
    scanToken: 0,       // erhöht sich bei jedem Start/Stopp, beendet alte Auto-Scans
    busyOcr: false,
    photoUrl: null,
    setsCache: null,
    setCache: {},
    card: null,
    cardmarket: null,
    image: null,
    hasPhoto: false,
    variant: 'normal',
    lastInput: { code: '', number: '' }
  };

  if (DEBUG) $('debug').hidden = false;

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

  function scanStatus(text) { $('scan-status').textContent = text; }

  Array.prototype.forEach.call(document.querySelectorAll('[data-back]'), function (b) {
    b.addEventListener('click', function () { show(b.getAttribute('data-back')); });
  });

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- Kamera ---------- */

  async function startCamera() {
    show('scan');
    var token = ++state.scanToken;
    $('btn-shutter').disabled = true;
    $('guide').classList.remove('found');
    scanStatus('Kamera startet …');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      openManual({ error: 'Die Kamera funktioniert hier nicht. Die Seite muss über https:// geöffnet werden. Du kannst die Nummer aber selbst eingeben.' });
      return;
    }
    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }
      });
      if (token !== state.scanToken) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      state.stream = stream;
      var track = stream.getVideoTracks()[0];
      // Dauer-Autofokus, wenn das Gerät es erlaubt
      try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) { /* egal */ }
      var video = $('video');
      video.srcObject = stream;
      await video.play();
      $('btn-shutter').disabled = false;
      getSets().catch(function () { return null; }); // Setliste schon mal laden (nur öffentliche Daten)
      autoScan(token);
    } catch (e) {
      var msg = (e && e.name === 'NotAllowedError')
        ? 'Du hast den Kamerazugriff nicht erlaubt. Erlaube ihn in Safari über „aA“ › Website-Einstellungen › Kamera, oder gib die Nummer selbst ein.'
        : 'Die Kamera konnte nicht gestartet werden. Probiere „Kamera-App“ oder gib die Nummer selbst ein.';
      openManual({ error: msg });
    }
  }

  function stopCamera() {
    state.scanToken++;
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
    // etwas Rand dazunehmen, falls die Karte nicht ganz im Rahmen liegt
    var padX = g.width * 0.04, padY = g.height * 0.04;
    var sx = (g.left - padX - vf.left - offX) / scale;
    var sy = (g.top - padY - vf.top - offY) / scale;
    var sw = (g.width + 2 * padX) / scale;
    var sh = (g.height + 2 * padY) / scale;
    sx = Math.max(0, sx); sy = Math.max(0, sy);
    sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
    var c = document.createElement('canvas');
    c.width = Math.round(sw); c.height = Math.round(sh);
    c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }

  /* ---------- Bildaufbereitung ---------- */

  // Schneidet einen Bereich der Karte aus (Anteile 0..1), vergrößert ihn
  // und wandelt ihn in Graustufen mit gestrecktem Kontrast um.
  // mode: 'stretch' | 'invert' | 'binary' | 'binary-invert' | 'adaptive' | 'adaptive-light'
  function region(card, x0, y0, x1, y1, mode) {
    var sx = Math.round(card.width * x0), sy = Math.round(card.height * y0);
    var sw = Math.round(card.width * (x1 - x0)), sh = Math.round(card.height * (y1 - y0));
    // Gleicher Maßstab für alle Ausschnitte: Kartenbreite ca. 1800 px, so ist die Schrift gut lesbar
    var k = Math.min(4, Math.max(1, 1800 / card.width));
    var c = document.createElement('canvas');
    c.width = Math.round(sw * k);
    c.height = Math.round(sh * k);
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(card, sx, sy, sw, sh, 0, 0, c.width, c.height);
    var img = ctx.getImageData(0, 0, c.width, c.height);
    var d = img.data, n = d.length / 4, i, v;
    var gray = new Uint8ClampedArray(n);
    var hist = new Array(256).fill(0);
    for (i = 0; i < n; i++) {
      v = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
      gray[i] = v; hist[v]++;
    }
    // Kontrast an 1 % / 99 % strecken, damit einzelne Glanzpunkte nicht stören
    var lo = 0, hi = 255, acc = 0;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc > n * 0.01) { lo = i; break; } }
    acc = 0;
    for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc > n * 0.01) { hi = i; break; } }
    var range = Math.max(1, hi - lo);
    if (mode === 'adaptive' || mode === 'adaptive-light') {
      adaptive(gray, c.width, c.height, lo, range, mode === 'adaptive-light', d);
      ctx.putImageData(img, 0, 0);
      return c;
    }
    var invert = mode === 'invert' || mode === 'binary-invert';
    var binary = mode === 'binary' || mode === 'binary-invert';
    var t = binary ? otsu(hist, n) : 0;
    for (i = 0; i < n; i++) {
      v = binary ? (gray[i] > t ? 255 : 0) : (gray[i] - lo) * 255 / range;
      if (invert) v = 255 - v;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // Schwellwert je Bildstelle (lokaler Mittelwert): große dunkle Flächen wie der Tisch
  // neben der Karte werden weiß, nur feine Schrift bleibt schwarz.
  // light = true sucht helle Schrift auf dunklem Grund.
  function adaptive(gray, w, h, lo, range, light, out) {
    var r = Math.max(10, Math.round(w / 50));
    var C = 18;
    var integ = new Float64Array((w + 1) * (h + 1));
    var x, y, i;
    for (y = 1; y <= h; y++) {
      var rowSum = 0;
      for (x = 1; x <= w; x++) {
        rowSum += (gray[(y - 1) * w + (x - 1)] - lo) * 255 / range;
        integ[y * (w + 1) + x] = integ[(y - 1) * (w + 1) + x] + rowSum;
      }
    }
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        var area = (y1 - y0) * (x1 - x0);
        var sum = integ[y1 * (w + 1) + x1] - integ[y0 * (w + 1) + x1] - integ[y1 * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
        var mean = sum / area;
        i = y * w + x;
        var v = (gray[i] - lo) * 255 / range;
        var ink = light ? (v > mean + C) : (v < mean - C);
        var o = ink ? 0 : 255;
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = o;
        out[i * 4 + 3] = 255;
      }
    }
  }

  function otsu(hist, total) {
    var sum = 0, i;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, best = 0, t = 127;
    for (i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      var wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; t = i; }
    }
    return t;
  }

  // Erkennungsversuche, nach Erfolgsaussicht sortiert.
  // Neue Karten: Nummer unten links; ältere Karten: teils unten rechts; Vollbild-Karten: helle Schrift.
  var L = [0, 0.86, 0.6, 1], R = [0.4, 0.86, 1, 1], FULL = [0, 0.84, 1, 1], WIDE = [0, 0.76, 1, 1];
  var PASSES_QUICK = [
    { name: 'links', box: L, mode: 'adaptive' },
    { name: 'links Kontrast', box: L, mode: 'stretch' }
  ];
  // Im Auto-Scan wird reihum links, rechts (ältere Karten) und helle Schrift (Vollbild-Karten) gesucht
  var PASSES_QUICK_RIGHT = [
    { name: 'rechts', box: R, mode: 'adaptive' },
    { name: 'rechts Kontrast', box: R, mode: 'stretch' }
  ];
  var PASSES_QUICK_LIGHT = [
    { name: 'links helle Schrift', box: L, mode: 'adaptive-light' }
  ];
  var AUTO_ROUNDS = [PASSES_QUICK, PASSES_QUICK_RIGHT, PASSES_QUICK_LIGHT];
  var PASSES_FULL = PASSES_QUICK.concat([
    { name: 'ganze Breite', box: FULL, mode: 'adaptive' },
    { name: 'links helle Schrift', box: L, mode: 'adaptive-light' },
    { name: 'rechts', box: R, mode: 'adaptive' },
    { name: 'ganze Breite Kontrast', box: FULL, mode: 'stretch' },
    { name: 'unten weit', box: WIDE, mode: 'adaptive' },
    { name: 'ganze Breite helle Schrift', box: FULL, mode: 'adaptive-light' },
    { name: 'links s/w', box: L, mode: 'binary' }
  ]);
  // Fotos aus der Kamera-App: Karte füllt das Bild nicht exakt, daher größere Bereiche
  var PASSES_PHOTO = [
    { name: 'Foto unten', box: [0, 0.72, 1, 1], mode: 'adaptive' },
    { name: 'Foto unten links', box: [0, 0.75, 0.6, 1], mode: 'adaptive' },
    { name: 'Foto unten rechts', box: [0.4, 0.75, 1, 1], mode: 'adaptive' },
    { name: 'Foto unten Kontrast', box: [0, 0.72, 1, 1], mode: 'stretch' },
    { name: 'Foto unten helle Schrift', box: [0, 0.72, 1, 1], mode: 'adaptive-light' },
    { name: 'Foto ganz', box: [0, 0, 1, 1], mode: 'adaptive' }
  ];

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
          tessedit_pageseg_mode: '11',
          user_defined_dpi: '300'
        }).then(function () { return w; });
      }).catch(function (e) {
        ocrWorkerPromise = null;
        throw e;
      });
    }
    return ocrWorkerPromise;
  }

  var DIGIT_FIX = { O: '0', D: '0', Q: '0', U: '0', I: '1', L: '1', T: '1', J: '1', Z: '2', A: '4', S: '5', G: '6', B: '8' };

  function fixDigits(s) {
    return s.replace(/[A-Z]/g, function (ch) { return DIGIT_FIX[ch] || ch; });
  }

  // Liefert alle möglichen Lesarten von "025/165" plus Set-Kürzel aus dem erkannten Text.
  function parseOcr(text) {
    var t = (text || '').toUpperCase();
    var compact = t.replace(/\s+/g, ''); // Leerzeichen gehen bei der Erkennung oft verloren
    var known = window.SET_CODES || {};
    var code = null;
    var withLang = /([A-Z]{3})DE[0-9ODQIL]{1,3}[\/1I7]/.exec(compact);
    if (withLang) code = withLang[1];
    if (!code || !known[code]) {
      var codes = Object.keys(known);
      for (var i = 0; i < codes.length; i++) {
        if (compact.indexOf(codes[i]) !== -1) { code = codes[i]; break; }
      }
    }
    var cands = [];
    var seen = {};
    function add(a, b, weak) {
      var n = parseInt(fixDigits(a), 10), tot = parseInt(fixDigits(b), 10);
      if (isNaN(n) || isNaN(tot) || n < 1 || tot < 10 || n > tot * 2) return;
      var key = n + '/' + tot;
      if (seen[key]) return;
      seen[key] = true;
      cands.push({ number: n, total: tot, code: code, weak: !!weak });
    }
    var m, D = '[0-9ODQILTSBZGUJA]';
    // 1) klarer Schrägstrich
    var re = new RegExp('(' + D + '{1,3})\\s*\\/\\s*(' + D + '{2,3})', 'g');
    while ((m = re.exec(t))) add(m[1], m[2]);
    re = new RegExp('(' + D + '{1,3})\\/(' + D + '{2,3})', 'g');
    while ((m = re.exec(compact))) add(m[1], m[2]);
    // 2) Schrägstrich als 1, I oder 7 gelesen, direkt nach "DE" ("MEWDE0251165")
    re = /DE([0-9ODQ]{3})[1I7]([0-9ODQ]{2,3})(?![0-9])/g;
    while ((m = re.exec(compact))) add(m[1], m[2], true);
    return cands;
  }

  // Wählt die Lesart, die zu einem echten Set passt (Kartenanzahl hinter dem Schrägstrich).
  function pickCandidate(cands, sets) {
    if (!cands.length) return null;
    if (!sets) return cands.filter(function (c) { return !c.weak; })[0] || null;
    var known = window.SET_CODES || {};
    var counts = {};
    sets.forEach(function (s) { if (s.cardCount) counts[s.cardCount.official] = true; });
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (c.code && known[c.code]) {
        var set = sets.filter(function (s) { return s.id === known[c.code]; })[0];
        if (set && set.cardCount && set.cardCount.official === c.total) return c;
      }
    }
    for (i = 0; i < cands.length; i++) {
      if (counts[cands[i].total]) return cands[i];
    }
    return null;
  }

  async function runPasses(card, passes, token) {
    var worker = await warmUpOcr();
    var sets = await getSets().catch(function () { return null; });
    var all = [];
    var log = [];
    for (var i = 0; i < passes.length; i++) {
      if (token != null && token !== state.scanToken) return null;
      var p = passes[i];
      var img = region(card, p.box[0], p.box[1], p.box[2], p.box[3], p.mode);
      var r = await worker.recognize(img);
      var cands = parseOcr(r.data.text);
      all = all.concat(cands);
      var hit = pickCandidate(cands, sets);
      if (DEBUG) log.push({ name: p.name, img: img, text: r.data.text, hit: hit });
      if (hit) { debugShow(log); return hit; }
    }
    if (DEBUG) debugShow(log);
    // Kein einzelner Versuch passte sicher: alle Lesarten zusammen prüfen
    return pickCandidate(all, sets);
  }

  // Prüft laufend das Kamerabild und löst selbst aus, sobald eine Nummer passt.
  async function autoScan(token) {
    try {
      scanStatus('Texterkennung lädt …');
      await warmUpOcr();
    } catch (e) {
      if (token === state.scanToken) scanStatus('Texterkennung nicht geladen – Foto-Knopf drücken');
      return;
    }
    var lastKey = null, round = 0;
    while (token === state.scanToken) {
      scanStatus('SUCHE NUMMER … KARTE RUHIG HALTEN');
      await sleep(AUTO_INTERVAL_MS);
      if (token !== state.scanToken || state.busyOcr) continue;
      var video = $('video');
      if (!video.videoWidth) continue;
      state.busyOcr = true;
      var card = captureCard();
      var hit = null;
      var passes = AUTO_ROUNDS[round++ % AUTO_ROUNDS.length];
      try { hit = await runPasses(card, passes, token); } catch (e) { hit = null; }
      state.busyOcr = false;
      if (token !== state.scanToken || !hit) { lastKey = null; continue; }
      // Ohne Setliste (offline) zur Sicherheit zweimal dieselbe Nummer abwarten
      var key = hit.number + '/' + hit.total;
      if (!state.setsCache && key !== lastKey) { lastKey = key; continue; }
      $('guide').classList.add('found');
      scanStatus('GEFUNDEN: ' + pad(hit.number) + '/' + pad(hit.total));
      if (navigator.vibrate) navigator.vibrate(30);
      stopCamera();
      setPhoto(card);
      await sleep(250);
      findCard(hit.code, hit.number, hit.total);
      return;
    }
  }

  async function onShutter() {
    var video = $('video');
    if (!video.videoWidth) return;
    var card = captureCard();
    stopCamera();
    await recognizeCard(card, PASSES_FULL);
  }

  async function recognizeCard(card, passes) {
    setPhoto(card);
    busy(ocrWorkerPromise ? 'Nummer wird gelesen …' : 'Texterkennung wird geladen …');
    var hit;
    try {
      await warmUpOcr();
      $('busy-text').textContent = 'Nummer wird gelesen …';
      hit = await runPasses(card, passes, null);
    } catch (e) {
      openManual({ error: 'Die Texterkennung konnte nicht geladen werden. Prüfe deine Internetverbindung oder gib die Nummer selbst ein.' });
      return;
    }
    if (!hit) {
      openManual({ tips: true });
      return;
    }
    findCard(hit.code, hit.number, hit.total);
  }

  // Foto aus der Kamera-App (volle Auflösung, echter Autofokus)
  $('photo-input').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    stopCamera();
    busy('Foto wird geladen …');
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var maxSide = 2600;
      var k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      var w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
      // Auf Kartenformat zuschneiden (Mitte), falls das Foto breiter ist
      var cardW = w, cardH = h, ratio = 63 / 88;
      if (w / h > ratio) cardW = Math.round(h * ratio); else cardH = Math.round(w / ratio);
      var c = document.createElement('canvas');
      c.width = cardW; c.height = cardH;
      c.getContext('2d').drawImage(img, (img.naturalWidth - cardW / k) / 2, (img.naturalHeight - cardH / k) / 2, cardW / k, cardH / k, 0, 0, cardW, cardH);
      recognizeCard(c, PASSES_PHOTO);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      openManual({ error: 'Das Foto konnte nicht geöffnet werden.' });
    };
    img.src = url;
  });

  function setPhoto(canvas) {
    if (state.photoUrl) { URL.revokeObjectURL(state.photoUrl); state.photoUrl = null; }
    $('img-mine').removeAttribute('src');
    state.hasPhoto = !!canvas;
    if (!canvas) return;
    canvas.toBlob(function (blob) {
      if (!blob) return;
      state.photoUrl = URL.createObjectURL(blob);
      $('img-mine').src = state.photoUrl;
    }, 'image/jpeg', 0.85);
  }

  function debugShow(log) {
    if (!DEBUG) return;
    var list = $('debug-list');
    list.textContent = '';
    log.forEach(function (e) {
      var item = document.createElement('div');
      item.className = 'debug-item';
      var title = document.createElement('span');
      title.className = 'small muted';
      title.textContent = 'Versuch: ' + e.name;
      var img = document.createElement('img');
      img.alt = '';
      img.src = e.img.toDataURL('image/png');
      var code = document.createElement('code');
      code.textContent = JSON.stringify(e.text);
      item.appendChild(title); item.appendChild(img); item.appendChild(code);
      if (e.hit) {
        var hit = document.createElement('span');
        hit.className = 'hit';
        hit.textContent = 'Treffer: ' + (e.hit.code || '–') + ' ' + e.hit.number + '/' + e.hit.total;
        item.appendChild(hit);
      }
      list.appendChild(item);
    });
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

  var setsPromise = null;
  function getSets() {
    if (state.setsCache) return Promise.resolve(state.setsCache);
    if (!setsPromise) {
      setsPromise = api('sets').then(function (s) {
        state.setsCache = s || [];
        return state.setsCache;
      }).catch(function (e) { setsPromise = null; throw e; });
    }
    return setsPromise;
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
    state.image = image ? image + '/high.webp' : null;
    state.variant = 'normal';
    showConfirm(card, set);
  }

  /* ---------- Bestätigen ---------- */

  function hasReversePrice(cm) {
    return !!cm && ['avg30-holo', 'trend-holo', 'avg-holo'].some(function (k) { return cm[k] > 0; });
  }

  function setImg(el, src, fallbackAlt) {
    el.removeAttribute('src');
    el.alt = fallbackAlt;
    if (src) el.src = src;
  }

  function showConfirm(card, set) {
    setImg($('img-official'), state.image, 'Offizielles Kartenbild');
    $('fig-mine').hidden = !state.hasPhoto;
    $('screen-confirm').classList.toggle('single', $('fig-mine').hidden);

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
    setImg($('price-thumb'), state.image, '');
    $('price-name').textContent = card.name;
    $('price-meta').textContent = (card.set ? card.set.name + ' · ' : '') + 'Nr. ' + card.localId;
    $('price-variant').textContent = state.variant === 'reverse' ? 'Reverse Holo' : 'Standard';

    var main = cm && pick(cm, ['avg30' + sfx, 'trend' + sfx, 'avg' + sfx]);
    $('price-value').hidden = !main;
    $('price-details').hidden = !main;
    $('price-none').hidden = !!main;
    if (main) {
      $('price-main').textContent = euro.format(main.value);
      var basis = {
        avg30: ['KARTENWERT · 30 TAGE', 'Durchschnitt auf Cardmarket'],
        trend: ['KARTENWERT · TREND', 'Aktueller Trendpreis auf Cardmarket (kein 30-Tage-Wert vorhanden)'],
        avg: ['KARTENWERT', 'Durchschnittlicher Verkaufspreis auf Cardmarket (kein 30-Tage-Wert vorhanden)']
      }[main.key.replace('-holo', '')];
      $('price-label').textContent = basis[0];
      $('price-basis').textContent = basis[1];
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
  ['img-official', 'price-thumb'].forEach(function (id) {
    $(id).addEventListener('error', function () {
      this.removeAttribute('src');
      this.alt = 'Kein Bild vorhanden';
    });
  });

  // Nur für automatische Tests
  window.__kartenscanner = { parseOcr: parseOcr, pickCandidate: pickCandidate, region: region, captureCard: captureCard, warmUpOcr: warmUpOcr };
})();
