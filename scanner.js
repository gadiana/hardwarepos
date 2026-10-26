/* scanner.js — camera barcode/QR scanning.
 * 1) Uses the browser's built-in BarcodeDetector (Chrome / Edge / Samsung Internet on Android). Works offline.
 * 2) If unavailable, loads the OPTIONAL local file lib/html5-qrcode.min.js (see README) for iPhone / Firefox.
 * 3) Always offers a "type barcode" box, which also accepts USB / Bluetooth scanners (they type like a keyboard). */
(function () {
  'use strict';
  var FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar', 'qr_code', 'data_matrix'];
  var active = null;

  function $(id) { return document.getElementById(id); }

  function beep() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = beep.ctx || (beep.ctx = new Ctx());
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 1300; g.gain.value = 0.08;
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.09);
    } catch (e) { /* audio is a nicety only */ }
    if (navigator.vibrate) navigator.vibrate(40);
  }

  function loadFallbackLib() {
    return new Promise(function (resolve, reject) {
      if (window.Html5Qrcode) return resolve();
      var s = document.createElement('script');
      s.src = 'lib/html5-qrcode.min.js';
      s.onload = function () { window.Html5Qrcode ? resolve() : reject(new Error('lib')); };
      s.onerror = function () { reject(new Error('missing')); };
      document.head.appendChild(s);
    });
  }

  /**
   * opts: { title, continuous, onCode(code, ctl) }   (onCode may be async)
   * Resolves when the scanner is closed.
   */
  function open(opts) {
    if (active) return active.promise;
    var dlg = $('scanner'), video = $('scanVideo'), reader = $('scanReader'), status = $('scanStatus');
    var torchBtn = $('scanTorch'), form = $('scanManual'), input = $('scanManualInput');
    var closed = false, busy = false, stream = null, timer = null, track = null, torchOn = false, h5 = null;
    var last = { code: '', t: 0 };
    var resolveClose;
    var promise = new Promise(function (r) { resolveClose = r; });

    function setStatus(t) { status.textContent = t || ''; }
    var ctl = { close: close, setStatus: setStatus };

    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      if (h5) { try { h5.stop().then(function () { h5.clear(); }).catch(function () {}); } catch (e) {} }
      video.srcObject = null;
      torchBtn.hidden = true;
      try { if (dlg.open) dlg.close(); } catch (e) {}
      active = null;
      resolveClose();
    }

    async function handle(raw, manual) {
      var code = Core.canonBarcode(raw);
      if (!code || closed) return;
      var now = Date.now();
      if (!manual && code === last.code && now - last.t < 1500) { last.t = now; return; }
      if (busy) return;
      last = { code: code, t: now };
      busy = true;
      beep();
      try { await opts.onCode(code, ctl); } finally { busy = false; last.t = Date.now(); }
      if (!opts.continuous) close();
    }

    // ---- UI wiring ----
    $('scanTitle').textContent = opts.title || 'Scan barcode';
    setStatus('Starting camera…');
    video.hidden = false; reader.hidden = true; input.value = '';
    $('scanClose').onclick = close;
    dlg.oncancel = function (e) { e.preventDefault(); close(); };
    form.onsubmit = function (e) { e.preventDefault(); var v = input.value; input.value = ''; handle(v, true); };
    torchBtn.onclick = async function () {
      try { torchOn = !torchOn; await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) { torchOn = false; }
    };
    if (!dlg.open) dlg.showModal();

    // ---- engines ----
    async function startNative() {
      var formats = FORMATS;
      try {
        var sup = await window.BarcodeDetector.getSupportedFormats();
        formats = FORMATS.filter(function (f) { return sup.indexOf(f) !== -1; });
      } catch (e) { /* keep default list */ }
      if (!formats.length) return false;
      var detector = new window.BarcodeDetector({ formats: formats });
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false
      });
      if (closed) { stream.getTracks().forEach(function (t) { t.stop(); }); return true; }
      video.srcObject = stream;
      await video.play();
      track = stream.getVideoTracks()[0];
      try { var caps = track.getCapabilities && track.getCapabilities(); if (caps && caps.torch) torchBtn.hidden = false; } catch (e) {}
      setStatus('Point the camera at a barcode');
      (function tick() {
        if (closed) return;
        if (video.readyState >= 2 && !busy) {
          detector.detect(video).then(function (res) { if (res && res.length) handle(res[0].rawValue); }).catch(function () {});
        }
        timer = setTimeout(tick, 120);
      })();
      return true;
    }

    async function startFallback() {
      try { await loadFallbackLib(); }
      catch (e) {
        setStatus("This browser can't scan with the camera. Use Chrome on Android, a USB/Bluetooth scanner, or type the barcode below.");
        return;
      }
      video.hidden = true; reader.hidden = false;
      var F = window.Html5QrcodeSupportedFormats, cfg = { verbose: false };
      if (F) cfg.formatsToSupport = [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.CODE_93, F.ITF, F.CODABAR, F.QR_CODE, F.DATA_MATRIX].filter(function (x) { return x !== undefined; });
      h5 = new window.Html5Qrcode('scanReader', cfg);
      await h5.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 260, height: 160 } },
        function (text) { handle(text); }, function () {});
      setStatus('Point the camera at a barcode');
    }

    (async function start() {
      try {
        if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setStatus('Camera needs a secure (https) page. You can still type the barcode below.');
          return;
        }
        var ok = 'BarcodeDetector' in window ? await startNative() : false;
        if (!ok && !closed) await startFallback();
      } catch (e) {
        var n = e && e.name;
        if (n === 'NotAllowedError' || n === 'SecurityError') setStatus('Camera permission was denied. Allow camera access in the browser settings, or type the barcode below.');
        else if (n === 'NotFoundError' || n === 'OverconstrainedError') setStatus('No camera found. Type the barcode below.');
        else if (n === 'NotReadableError') setStatus('The camera is busy in another app. Close it and try again.');
        else setStatus('Could not start the camera. You can type the barcode below.');
      }
    })();

    active = { promise: promise, close: close };
    return promise;
  }

  window.Scanner = { open: open };
})();
