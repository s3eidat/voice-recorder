/* Voice Recorder — MediaRecorder + AnalyserNode, recordings kept in IndexedDB on this device. */
(function () {
  "use strict";
  var $ = S3.$;

  // ---------- pure helpers (tested in S3_SELFTEST) ----------
  // 16-bit PCM WAV from Float32 channel arrays.
  function encodeWAV(chans, rate) {
    var n = chans.length, len = chans[0].length, block = n * 2, buf = new ArrayBuffer(44 + len * block), v = new DataView(buf);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, "RIFF"); v.setUint32(4, 36 + len * block, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, n, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * block, true); v.setUint16(32, block, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, len * block, true);
    for (var i = 0, o = 44; i < len; i++) for (var c = 0; c < n; c++, o += 2) {
      var s = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buf;
  }
  function decode(ctx, ab) { return new Promise(function (res, rej) { ctx.decodeAudioData(ab, res, rej); }); }
  function bufferChans(b) { var a = []; for (var c = 0; c < b.numberOfChannels; c++) a.push(b.getChannelData(c)); return a; }
  function fmtTime(sec, tenths) {
    sec = Math.max(0, sec || 0);
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ":" + String(s).padStart(2, "0") + (tenths ? "." + Math.floor(sec * 10 % 10) : "");
  }
  function rms(arr) { var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i] * arr[i]; return Math.sqrt(s / arr.length); }
  function toDb(x) { return x > 0 ? 20 * Math.log10(x) : -Infinity; }
  function downsample(levels, n) { // max per bucket, 0..1
    var out = [];
    if (!levels.length) return out;
    for (var i = 0; i < n; i++) {
      var a = Math.floor(i * levels.length / n), b = Math.max(a + 1, Math.floor((i + 1) * levels.length / n)), m = 0;
      for (var j = a; j < b && j < levels.length; j++) if (levels[j] > m) m = levels[j];
      out.push(+m.toFixed(3));
    }
    return out;
  }
  function pickMime(isSupported) {
    var c = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];
    for (var i = 0; i < c.length; i++) if (isSupported(c[i])) return c[i];
    return "";
  }
  function extFor(mime) { return /ogg/.test(mime) ? "ogg" : /mp4|aac/.test(mime) ? "m4a" : /wav/.test(mime) ? "wav" : "webm"; }
  function safeName(s) { return (s || "recording").replace(/[\\/:*?"<>|]+/g, "-").trim().slice(0, 80) || "recording"; }
  // visual level: map dB -60..0 to 0..1
  function levelOf(r) { var d = toDb(r); return d === -Infinity ? 0 : Math.max(0, Math.min(1, (d + 60) / 60)); }

  // ---------- IndexedDB (falls back to memory if blocked) ----------
  function openDB(name) {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) return rej(new Error("no IndexedDB"));
      var r = indexedDB.open(name, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("recs", { keyPath: "id" }); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function tx(db, mode, fn) {
    return new Promise(function (res, rej) {
      var t = db.transaction("recs", mode), req = fn(t.objectStore("recs"));
      t.oncomplete = function () { res(req && req.result); };
      t.onerror = t.onabort = function () { rej(t.error); };
    });
  }
  var mem = {};
  var store = {
    db: null,
    all: function () { return this.db ? tx(this.db, "readonly", function (s) { return s.getAll(); }) : Promise.resolve(Object.values(mem)); },
    put: function (r) { if (!this.db) { mem[r.id] = r; return Promise.resolve(); } return tx(this.db, "readwrite", function (s) { return s.put(r); }); },
    del: function (id) { if (!this.db) { delete mem[id]; return Promise.resolve(); } return tx(this.db, "readwrite", function (s) { return s.delete(id); }); }
  };

  // ---------- state ----------
  var settings = Object.assign({ ns: true, ec: true, agc: true }, S3.store("voicerec") || {});
  ["ns", "ec", "agc"].forEach(function (k) {
    $("#" + k).checked = settings[k];
    $("#" + k).addEventListener("change", function () { settings[k] = this.checked; S3.store("voicerec", settings); });
  });
  var canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  var mimeType = canRecord ? pickMime(function (m) { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } }) : "";
  var recs = [], rec = null, ctx = null, history = [], player = new Audio(), playing = null, urls = {};
  $("#fmt").textContent = canRecord ? "Format: " + (mimeType ? mimeType.split(";")[0] : "browser default") : "";
  if (!canRecord) notice(window.isSecureContext === false ? "Recording needs a secure page (https or localhost)." : "This browser can't record audio. Try the latest Chrome, Edge, Firefox or Safari.");

  function notice(text) { var n = $("#notice"); n.hidden = !text; n.textContent = text || ""; }
  function setStatus(t, kind) { var s = $("#status"); s.textContent = t; s.className = "chip" + (kind ? " " + kind : ""); }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function fit(canvas) {
    var d = window.devicePixelRatio || 1, w = Math.round(canvas.clientWidth * d), h = Math.round(canvas.clientHeight * d);
    if (w && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; }
    return d;
  }

  // ---------- live waveform ----------
  function drawLive() {
    var c = $("#wave"), d = fit(c), g = c.getContext("2d"), W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    var bw = 3 * d, gap = 2 * d, step = bw + gap, n = Math.ceil(W / step), mid = H / 2 + 8 * d;
    g.fillStyle = cssVar("--line-strong"); g.fillRect(0, mid - 0.5 * d, W, d);
    g.fillStyle = cssVar(rec && rec.state === "paused" ? "--text-3" : "--accent");
    var start = Math.max(0, history.length - n);
    for (var i = start; i < history.length; i++) {
      var x = W - (history.length - i) * step, hh = Math.max(d, history[i] * (H * 0.4));
      g.fillRect(x, mid - hh, bw, hh * 2);
    }
  }
  function loop() {
    if (!rec) return;
    var buf = new Float32Array(rec.analyser.fftSize);
    rec.analyser.getFloatTimeDomainData(buf);
    var r = rms(buf), lv = levelOf(r);
    if (rec.state === "recording") { history.push(lv); rec.levels.push(lv); }
    $("#level").style.width = (lv * 100).toFixed(1) + "%";
    var db = toDb(r); $("#db").textContent = (db === -Infinity ? "—" : db.toFixed(0)) + " dB";
    $("#timer").textContent = fmtTime(elapsed(), true);
    drawLive();
    rec.raf = requestAnimationFrame(loop);
  }
  function elapsed() { if (!rec) return 0; return ((rec.pausedAt || performance.now()) - rec.t0 - rec.pausedTotal) / 1000; }

  // ---------- record ----------
  async function start() {
    if (!canRecord) return;
    notice("");
    var stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: settings.ns, echoCancellation: settings.ec, autoGainControl: settings.agc } });
    } catch (e) {
      var why = e && e.name === "NotAllowedError" ? "Microphone access was blocked. Allow it from the address bar (the lock or mic icon) and press Record again."
        : e && e.name === "NotFoundError" ? "No microphone was found. Plug one in and try again."
        : e && e.name === "NotReadableError" ? "The microphone is busy in another app." : "Couldn't open the microphone: " + (e && e.message || e);
      notice(why); setStatus("No microphone", "bad"); return;
    }
    if (!ctx) ctx = new AudioContext();
    await ctx.resume();
    var src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser(); an.fftSize = 2048; src.connect(an);
    var mr = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : undefined);
    rec = { stream: stream, src: src, analyser: an, mr: mr, chunks: [], levels: [], t0: performance.now(), pausedAt: 0, pausedTotal: 0, state: "recording", discard: false };
    history = [];
    mr.ondataavailable = function (e) { if (e.data && e.data.size) rec.chunks.push(e.data); };
    mr.onstop = saveRec;
    mr.start(500);
    document.body.classList.add("is-rec");
    $("#recLbl").textContent = "Stop & save"; $("#rec").setAttribute("aria-label", "Stop and save recording");
    $("#pause").disabled = false; $("#discard").disabled = false;
    setStatus("● Recording", "bad");
    loop();
  }
  function stop(discard) { if (!rec) return; rec.discard = !!discard; if (rec.mr.state !== "inactive") rec.mr.stop(); }
  function togglePause() {
    if (!rec) return;
    if (rec.state === "recording") { rec.mr.pause(); rec.state = "paused"; rec.pausedAt = performance.now(); setStatus("Paused", "warn"); $("#pause span").textContent = "Resume"; $("#pause use").setAttribute("href", "#i-play"); }
    else { rec.mr.resume(); rec.state = "recording"; rec.pausedTotal += performance.now() - rec.pausedAt; rec.pausedAt = 0; setStatus("● Recording", "bad"); $("#pause span").textContent = "Pause"; $("#pause use").setAttribute("href", "#i-pause"); }
  }
  async function saveRec() {
    var r = rec; rec = null;
    cancelAnimationFrame(r.raf);
    var dur = ((r.pausedAt || performance.now()) - r.t0 - r.pausedTotal) / 1000;
    r.stream.getTracks().forEach(function (t) { t.stop(); }); r.src.disconnect();
    document.body.classList.remove("is-rec");
    $("#recLbl").textContent = "Record"; $("#rec").setAttribute("aria-label", "Start recording");
    $("#pause").disabled = true; $("#discard").disabled = true; $("#pause span").textContent = "Pause"; $("#pause use").setAttribute("href", "#i-pause");
    $("#level").style.width = "0"; $("#db").textContent = "— dB";
    if (r.discard) { setStatus("Discarded"); history = []; drawLive(); $("#timer").textContent = fmtTime(0, true); return; }
    var blob = new Blob(r.chunks, { type: (r.mr.mimeType || mimeType || "audio/webm").split(";")[0] });
    var d = new Date(), item = {
      id: d.getTime() + "-" + Math.random().toString(36).slice(2, 7),
      name: "Memo " + d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
      created: d.getTime(), dur: dur, mime: blob.type, blob: blob, peaks: downsample(r.levels, 120)
    };
    try { await store.put(item); setStatus("Saved", "ok"); }
    catch (e) { setStatus("Not saved", "bad"); S3.toast("Couldn't save to browser storage (full or blocked). Download it now.", "error"); }
    recs.unshift(item); render(); S3.done();
  }

  // ---------- list ----------
  function urlFor(r) { return urls[r.id] || (urls[r.id] = URL.createObjectURL(r.blob)); }
  function drawPeaks(canvas, peaks, progress) {
    var d = fit(canvas), g = canvas.getContext("2d"), W = canvas.width, H = canvas.height;
    g.clearRect(0, 0, W, H);
    if (!peaks || !peaks.length) return;
    var step = W / peaks.length, acc = cssVar("--accent"), dim = cssVar("--text-3");
    for (var i = 0; i < peaks.length; i++) {
      var hh = Math.max(d, peaks[i] * H * 0.48);
      g.fillStyle = i / peaks.length < progress ? acc : dim;
      g.fillRect(i * step, H / 2 - hh, Math.max(d, step - d), hh * 2);
    }
  }
  function render() {
    var list = $("#list"); list.innerHTML = "";
    recs.sort(function (a, b) { return b.created - a.created; });
    $("#empty").hidden = recs.length > 0;
    $("#count").textContent = recs.length ? recs.length + "" : "";
    recs.forEach(function (r) {
      var cv = S3.h("canvas", { "aria-hidden": "true" });
      var playBtn = S3.h("button", { "class": "btn primary play", "aria-label": "Play " + r.name, html: S3.icon(playing && playing.r === r && !player.paused ? "pause" : "play") });
      var nameIn = S3.h("input", { "class": "input grow", value: r.name, "aria-label": "Recording name", dir: "auto", maxlength: "80" });
      var delBtn = S3.h("button", { "class": "btn small ghost danger", html: S3.icon("trash"), "aria-label": "Delete " + r.name });
      var el = S3.h("div", { "class": "rec" + (playing && playing.r === r ? " playing" : "") }, [
        S3.h("div", { "class": "rec-top" }, [playBtn, nameIn]),
        cv,
        S3.h("div", { "class": "rec-meta" }, [
          S3.h("span", { "class": "faint", title: new Date(r.created).toLocaleString(), text: fmtTime(r.dur) + " · " + S3.fmtBytes(r.blob.size) + " · " + new Date(r.created).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) }),
          S3.h("span", { "class": "acts" }, [
            S3.h("button", { "class": "btn small", title: "Download the original recording", html: S3.icon("download") + extFor(r.mime).toUpperCase(), onclick: function () { S3.download(r.blob, safeName(r.name) + "." + extFor(r.mime)); S3.done(); } }),
            extFor(r.mime) === "wav" ? null : S3.h("button", { "class": "btn small", title: "Convert to WAV and download", html: S3.icon("download") + "WAV", onclick: function () { exportWav(r, this); } }),
            delBtn
          ])
        ])
      ]);
      r._cv = cv; r._el = el; r._play = playBtn;
      nameIn.addEventListener("change", function () { r.name = nameIn.value.trim() || r.name; nameIn.value = r.name; store.put(r).catch(function () {}); });
      nameIn.addEventListener("keydown", function (e) { if (e.key === "Enter") nameIn.blur(); });
      playBtn.addEventListener("click", function () { togglePlay(r); });
      cv.addEventListener("click", function (e) {
        var p = e.offsetX / cv.clientWidth;
        if (!playing || playing.r !== r) togglePlay(r, p); else player.currentTime = p * (player.duration && isFinite(player.duration) ? player.duration : r.dur);
      });
      delBtn.addEventListener("click", function () {
        if (!delBtn.classList.contains("armed")) { delBtn.classList.add("armed"); delBtn.innerHTML = S3.icon("trash") + "Delete?"; setTimeout(function () { delBtn.classList.remove("armed"); delBtn.innerHTML = S3.icon("trash"); }, 3000); return; }
        if (playing && playing.r === r) { player.pause(); playing = null; }
        store.del(r.id).then(function () {
          recs.splice(recs.indexOf(r), 1);
          if (urls[r.id]) { URL.revokeObjectURL(urls[r.id]); delete urls[r.id]; }
          render(); usage();
        }, function () { S3.toast("Couldn't delete", "error"); });
      });
      list.appendChild(el);
      drawPeaks(cv, r.peaks, 0);
    });
    usage();
  }
  function togglePlay(r, at) {
    if (playing && playing.r === r) { if (player.paused) player.play(); else player.pause(); return; }
    player.pause(); player.src = urlFor(r); playing = { r: r };
    var go = function () { if (at) player.currentTime = at * (isFinite(player.duration) ? player.duration : r.dur); player.play().catch(function () { S3.toast("This browser can't play that format", "error"); }); };
    if (at) player.addEventListener("loadedmetadata", go, { once: true }); else go();
    render();
  }
  function progress() {
    if (playing && playing.r._cv) {
      var dur = isFinite(player.duration) && player.duration ? player.duration : playing.r.dur;
      drawPeaks(playing.r._cv, playing.r.peaks, dur ? player.currentTime / dur : 0);
    }
    if (!player.paused) requestAnimationFrame(progress);
  }
  player.addEventListener("play", function () { if (playing) playing.r._play.innerHTML = S3.icon("pause"); progress(); });
  player.addEventListener("pause", function () { if (playing) playing.r._play.innerHTML = S3.icon("play"); });
  player.addEventListener("ended", function () { if (playing) { drawPeaks(playing.r._cv, playing.r.peaks, 0); playing.r._el.classList.remove("playing"); } playing = null; });

  async function exportWav(r, btn) {
    btn.disabled = true;
    try {
      var ab = await r.blob.arrayBuffer();
      var b = await decode(new OfflineAudioContext(1, 1, 48000), ab);
      S3.download(new Blob([encodeWAV(bufferChans(b), b.sampleRate)], { type: "audio/wav" }), safeName(r.name) + ".wav");
      S3.done();
    } catch (e) { S3.toast("This browser can't decode that recording to WAV", "error"); }
    btn.disabled = false;
  }
  function usage() {
    if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(function (e) {
      $("#usage").textContent = e.usage != null ? S3.fmtBytes(e.usage) + " used on this device" : "";
    }).catch(function () {});
  }

  // ---------- wiring ----------
  $("#rec").addEventListener("click", function () { if (rec) stop(false); else start(); });
  $("#pause").addEventListener("click", togglePause);
  $("#discard").addEventListener("click", function () { stop(true); });
  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName) && e.key === " ") return;
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === "r" || e.key === "R") { e.preventDefault(); $("#rec").click(); }
    else if (e.key === " " && rec) { e.preventDefault(); togglePause(); }
  });
  window.addEventListener("resize", S3.debounce(function () { drawLive(); recs.forEach(function (r) { if (r._cv) drawPeaks(r._cv, r.peaks, 0); }); }, 150));
  window.addEventListener("beforeunload", function (e) { if (rec) { e.preventDefault(); e.returnValue = ""; } });

  drawLive();
  var ready = openDB("s3-voice-recorder").then(function (db) { store.db = db; return store.all(); }, function () {
    $("#storeNote").textContent = "Browser storage is blocked here (private mode?), so recordings last only until you close the tab. Download the ones you want to keep.";
    return [];
  }).then(function (all) { recs = all || []; render(); });

  // ---------- demo + self-test ----------
  function synthVoice(rate, secs, seed) {
    var n = Math.floor(rate * secs), out = new Float32Array(n), f0 = 140 + seed * 30;
    for (var i = 0; i < n; i++) {
      var t = i / rate, syl = Math.max(0, Math.sin(t * Math.PI * (2.6 + seed * 0.4))) * (0.55 + 0.45 * Math.sin(t * 0.9 + seed));
      var f = f0 * (1 + 0.06 * Math.sin(t * 3));
      out[i] = syl * 0.5 * (Math.sin(2 * Math.PI * f * t) * 0.6 + Math.sin(4 * Math.PI * f * t) * 0.25 + Math.sin(6 * Math.PI * f * t) * 0.15);
    }
    return out;
  }
  function peaksOf(samples, n) {
    var lv = [], step = 400;
    for (var i = 0; i + step <= samples.length; i += step) lv.push(levelOf(rms(samples.subarray(i, i + step))));
    return downsample(lv, n);
  }
  window.S3_DEMO = async function () {
    await ready;
    var names = ["Grocery list", "Idea: weekend trip", "Meeting notes, Monday"], now = Date.now();
    recs = names.map(function (nm, k) {
      var s = synthVoice(16000, 4 + k * 3, k);
      return { id: "demo" + k, name: nm, created: now - k * 86400000 - 3600000 * k, dur: s.length / 16000, mime: "audio/wav", blob: new Blob([encodeWAV([s], 16000)], { type: "audio/wav" }), peaks: peaksOf(s, 120) };
    });
    render();
    var live = synthVoice(16000, 9, 3);
    history = []; for (var i = 0; i + 300 <= live.length; i += 300) history.push(levelOf(rms(live.subarray(i, i + 300))));
    drawLive();
    $("#timer").textContent = "0:09.4"; $("#level").style.width = "62%"; $("#db").textContent = "-23 dB";
  };

  window.S3_SELFTEST = async function () {
    var src = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
    var wav = encodeWAV([src], 8000), v = new DataView(wav), u8 = new Uint8Array(wav);
    var hdr = String.fromCharCode.apply(null, u8.subarray(0, 4)) + String.fromCharCode.apply(null, u8.subarray(8, 16)) + String.fromCharCode.apply(null, u8.subarray(36, 40));
    var ok = hdr === "RIFFWAVEfmt data" && wav.byteLength === 56 && v.getUint32(4, true) === 48 && v.getUint16(20, true) === 1 &&
      v.getUint16(22, true) === 1 && v.getUint32(24, true) === 8000 && v.getUint32(28, true) === 16000 && v.getUint16(32, true) === 2 &&
      v.getUint16(34, true) === 16 && v.getUint32(40, true) === 12 &&
      v.getInt16(44, true) === 0 && v.getInt16(46, true) === 16383 && v.getInt16(48, true) === -16384 && v.getInt16(50, true) === 32767 && v.getInt16(52, true) === -32768;
    // stereo interleave + decode round-trip through the browser's own WAV decoder
    var L = new Float32Array(400), R = new Float32Array(400);
    for (var i = 0; i < 400; i++) { L[i] = Math.sin(i / 7) * 0.8; R[i] = -L[i] / 2; }
    var b = await decode(new OfflineAudioContext(2, 400, 8000), encodeWAV([L, R], 8000));
    var err = 0, l2 = b.getChannelData(0), r2 = b.getChannelData(1);
    for (i = 0; i < 400; i++) err = Math.max(err, Math.abs(l2[i] - L[i]), Math.abs(r2[i] - R[i]));
    ok = ok && b.numberOfChannels === 2 && b.length === 400 && b.sampleRate === 8000 && err < 1 / 16000;
    ok = ok && fmtTime(65.37, true) === "1:05.3" && fmtTime(0) === "0:00" && Math.abs(toDb(0.5) + 6.0206) < 1e-3 && levelOf(1) === 1 && levelOf(0) === 0;
    var ds = downsample([0.1, 0.9, 0.2, 0.3, 0.5, 0.4], 3);
    ok = ok && ds.join() === "0.9,0.3,0.5";
    ok = ok && pickMime(function (m) { return m === "audio/mp4"; }) === "audio/mp4" && extFor("audio/mp4") === "m4a" && extFor("audio/webm") === "webm";
    ok = ok && safeName('a/b:c?') === "a-b-c-" && safeName("  ") === "recording";
    // IndexedDB put/get/delete on a throwaway database
    try {
      var db = await openDB("s3-voice-recorder-selftest");
      await tx(db, "readwrite", function (s) { return s.put({ id: "t", blob: new Blob(["x"]), name: "T" }); });
      var got = await tx(db, "readonly", function (s) { return s.get("t"); });
      await tx(db, "readwrite", function (s) { return s.delete("t"); });
      var gone = await tx(db, "readonly", function (s) { return s.get("t"); });
      ok = ok && got && got.name === "T" && got.blob.size === 1 && gone === undefined;
      db.close(); indexedDB.deleteDatabase("s3-voice-recorder-selftest");
    } catch (e) { return "indexeddb: " + e; }
    return ok;
  };
})();
