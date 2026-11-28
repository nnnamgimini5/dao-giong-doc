/* Nhân bản giọng từ file ghi âm (miễn phí qua Hugging Face Space).
   - Mẫu giọng: tải file hoặc ghi âm bằng mic, chuẩn hóa về WAV mono 24 kHz, tối đa 30 giây.
   - Giọng đã lưu nằm trong IndexedDB của máy (đồng bộ GitHub qua sync.js).
   - Máy chủ: Space Gradio bất kỳ có ô "âm thanh mẫu" + ô "chữ cần đọc"; app tự dò cách gọi. */
(function () {
  'use strict';

  var DEFAULT_SPACE = 'hynt/F5-TTS-Vietnamese-100h';
  var CFG_KEY = 'dgd_clone_cfg';
  var RATE = 24000;
  var MAX_SEC = 30;
  var CHUNK = 300;
  var GRADIO_URLS = [
    'https://cdn.jsdelivr.net/npm/@gradio/client@1.8.0/dist/index.min.js',
    'https://cdn.jsdelivr.net/npm/@gradio/client@1.8.0/+esm',
    'https://esm.sh/@gradio/client@1.8.0'
  ];

  var st = {
    sample: null,      // {blob, duration, fromVoiceId}
    rec: null,         // {mr, stream, chunks, timer, t0}
    busy: false,
    cancel: false,
    result: null,      // {pcm, rate}
    resultUrl: null,
    sampleUrl: null,
    gradio: null,
    client: null,
    clientKey: ''
  };

  function $(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
  function status(id, msg, kind) {
    var el = $(id); if (!el) return;
    el.textContent = msg || '';
    el.classList.remove('is-ok', 'is-error', 'is-warn', 'is-busy');
    if (kind) el.classList.add('is-' + kind);
  }
  function toast(msg) {
    var e = $('global-toast'); if (!e) return;
    e.textContent = msg; e.hidden = false; e.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(function () { e.hidden = true; e.classList.remove('show'); }, 4500);
  }
  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function download(blob, name) {
    var u = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
  }
  function fmtSec(s) { return (Math.round(s * 10) / 10).toString().replace('.', ',') + ' giây'; }

  /* ---------- cấu hình ---------- */
  function getCfg() {
    try { return Object.assign({ space: DEFAULT_SPACE, token: '', endpoint: '', swap: false }, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); }
    catch (e) { return { space: DEFAULT_SPACE, token: '', endpoint: '', swap: false }; }
  }
  function setCfg(c) { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }

  /* ---------- IndexedDB ---------- */
  function db() {
    if (db.p) return db.p;
    db.p = new Promise(function (res, rej) {
      var r = indexedDB.open('dgd-clone', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('voices', { keyPath: 'id' }); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { db.p = null; rej(r.error); };
    });
    return db.p;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction('voices', mode), s = t.objectStore('voices'), out = fn(s);
        t.oncomplete = function () { res(out && 'result' in out ? out.result : undefined); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }
  function listVoices() {
    return tx('readonly', function (s) { return s.getAll(); }).then(function (a) {
      return (a || []).sort(function (x, y) { return (y.createdAt || 0) - (x.createdAt || 0); });
    });
  }
  function putVoice(v) { return tx('readwrite', function (s) { s.put(v); }); }
  function deleteVoice(id) { return tx('readwrite', function (s) { s.delete(id); }); }

  /* ---------- âm thanh ---------- */
  function encodeWav(pcm, rate) {
    var n = pcm.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    function w(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    for (var i = 0, o = 44; i < n; i++, o += 2) {
      var x = Math.max(-1, Math.min(1, pcm[i]));
      v.setInt16(o, x < 0 ? x * 32768 : x * 32767, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /* Giải mã mọi định dạng trình duyệt đọc được, trộn về mono, đổi về 24 kHz */
  async function decodeMono(blob) {
    var ab = await blob.arrayBuffer();
    var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var ctx = new Ctx(1, 1, RATE);
    var audio = await new Promise(function (res, rej) {
      var p = ctx.decodeAudioData(ab, res, rej);
      if (p && p.then) p.then(res, rej);
    });
    var ch = audio.numberOfChannels, len = audio.length, out = new Float32Array(len);
    for (var c = 0; c < ch; c++) {
      var d = audio.getChannelData(c);
      for (var i = 0; i < len; i++) out[i] += d[i] / ch;
    }
    if (audio.sampleRate !== RATE) out = resample(out, audio.sampleRate, RATE);
    return out;
  }
  function resample(x, from, to) {
    var n = Math.round(x.length * to / from), y = new Float32Array(n), r = from / to;
    for (var i = 0; i < n; i++) {
      var p = i * r, k = Math.floor(p), f = p - k;
      y[i] = (x[k] || 0) * (1 - f) + (x[k + 1] || 0) * f;
    }
    return y;
  }
  /* Cắt khoảng lặng hai đầu, giới hạn độ dài, chuẩn hóa âm lượng */
  function cleanSample(pcm) {
    var thr = 0.02, win = Math.floor(RATE * 0.02), a = 0, b = pcm.length;
    function loud(i) { var m = 0; for (var j = i; j < i + win && j < pcm.length; j++) m = Math.max(m, Math.abs(pcm[j])); return m > thr; }
    while (a < b && !loud(a)) a += win;
    while (b > a && !loud(Math.max(a, b - win))) b -= win;
    a = Math.max(0, a - Math.floor(RATE * 0.15));
    b = Math.min(pcm.length, b + Math.floor(RATE * 0.25));
    var trimmed = false;
    if (b - a > MAX_SEC * RATE) { b = a + MAX_SEC * RATE; trimmed = true; }
    var y = pcm.slice(a, b), peak = 0;
    for (var i = 0; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]));
    if (peak > 0.01) { var g = Math.min(4, 0.9 / peak); for (i = 0; i < y.length; i++) y[i] *= g; }
    return { pcm: y, trimmed: trimmed };
  }

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = res; s.onerror = function () { rej(new Error('Không tải được thư viện: ' + src)); };
      document.head.appendChild(s);
    });
  }
  async function encodeMp3(pcm, rate) {
    if (!window.lamejs) await loadScript('https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js');
    var enc = new window.lamejs.Mp3Encoder(1, rate, 128), parts = [], step = 1152;
    var i16 = new Int16Array(pcm.length);
    for (var i = 0; i < pcm.length; i++) { var x = Math.max(-1, Math.min(1, pcm[i])); i16[i] = x < 0 ? x * 32768 : x * 32767; }
    for (i = 0; i < i16.length; i += step) {
      var b = enc.encodeBuffer(i16.subarray(i, i + step));
      if (b.length) parts.push(new Int8Array(b));
    }
    var f = enc.flush(); if (f.length) parts.push(new Int8Array(f));
    return new Blob(parts, { type: 'audio/mpeg' });
  }

  /* ---------- mẫu giọng ---------- */
  async function setSample(blob, fromVoiceId) {
    var pcm = await decodeMono(blob);
    var c = cleanSample(pcm);
    if (c.pcm.length < RATE * 2) throw new Error('Mẫu quá ngắn hoặc quá nhỏ tiếng. Cần ít nhất 3 giây giọng nói rõ.');
    var wav = encodeWav(c.pcm, RATE), dur = c.pcm.length / RATE;
    st.sample = { blob: wav, duration: dur, fromVoiceId: fromVoiceId || null };
    if (st.sampleUrl) URL.revokeObjectURL(st.sampleUrl);
    st.sampleUrl = URL.createObjectURL(wav);
    var au = $('clone-sample-audio'); au.src = st.sampleUrl; au.hidden = false;
    var msg = 'Mẫu giọng: ' + fmtSec(dur) + '.';
    if (c.trimmed) msg += ' Đã cắt còn ' + MAX_SEC + ' giây đầu: câu chữ mẫu chỉ ghi phần này.';
    else if (dur < 6) msg += ' Hơi ngắn, 8 đến 20 giây sẽ giống giọng hơn.';
    status('clone-sample-status', msg, c.trimmed || dur < 6 ? 'warn' : 'ok');
    renderPick();
    return st.sample;
  }

  async function startRec() {
    if (!navigator.mediaDevices || !window.MediaRecorder) { status('clone-sample-status', 'Trình duyệt này không ghi âm được. Hãy tải file lên.', 'error'); return; }
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      var mr = new MediaRecorder(stream), chunks = [];
      mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = async function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        clearInterval(st.rec && st.rec.timer); st.rec = null; recUi(false);
        try { await setSample(new Blob(chunks, { type: mr.mimeType || 'audio/webm' })); }
        catch (e) { status('clone-sample-status', e.message, 'error'); }
      };
      st.rec = { mr: mr, stream: stream, t0: Date.now() };
      st.rec.timer = setInterval(function () {
        var s = (Date.now() - st.rec.t0) / 1000;
        status('clone-sample-status', '🔴 Đang ghi âm: ' + Math.floor(s) + '/' + MAX_SEC + ' giây. Đọc to, rõ, nơi yên tĩnh.', 'busy');
        if (s >= MAX_SEC) stopRec();
      }, 250);
      mr.start(); recUi(true);
    } catch (e) {
      status('clone-sample-status', 'Không mở được mic: ' + (e.name === 'NotAllowedError' ? 'anh chưa cho phép dùng mic.' : e.message), 'error');
    }
  }
  function stopRec() { if (st.rec && st.rec.mr.state !== 'inactive') st.rec.mr.stop(); }
  function recUi(r) {
    $('btn-clone-rec').textContent = r ? '⏹️ Dừng ghi' : '🎤 Ghi âm';
    $('btn-clone-rec').classList.toggle('btn-danger', r);
  }

  /* ---------- danh sách giọng đã lưu ---------- */
  async function renderList() {
    var box = $('clone-list'), empty = $('clone-empty');
    var vs = await listVoices();
    box.innerHTML = '';
    empty.hidden = vs.length > 0;
    vs.forEach(function (v) {
      var row = document.createElement('div'); row.className = 'row-item';
      var t = document.createElement('div'); t.className = 'row-title'; t.textContent = '🧬 ' + v.name;
      var m = document.createElement('div'); m.className = 'row-meta'; m.textContent = fmtSec(v.duration || 0) + (v.refText ? ' · có câu chữ mẫu' : ' · chưa có câu chữ mẫu');
      var acts = document.createElement('div'); acts.className = 'row-actions';
      var bPlay = mk('▶️', 'Nghe mẫu', function () {
        var u = URL.createObjectURL(v.blob), a = new Audio(u);
        a.onended = function () { URL.revokeObjectURL(u); }; a.play();
      });
      var bUse = mk('Dùng', 'Dùng giọng này để đọc', function () {
        $('clone-voice').value = v.id; toast('Đã chọn giọng "' + v.name + '".');
        $('clone-gen-text').focus();
      });
      bUse.classList.add('btn-primary');
      var bDel = mk('Xóa', 'Xóa giọng', async function () {
        if (!confirm('Xóa giọng "' + v.name + '"?')) return;
        await deleteVoice(v.id); renderList();
      });
      bDel.classList.add('btn-danger');
      acts.appendChild(bPlay); acts.appendChild(bUse); acts.appendChild(bDel);
      row.appendChild(t); row.appendChild(acts); row.appendChild(m); box.appendChild(row);
    });
    renderPick(vs);
  }
  function mk(txt, title, fn) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = txt; b.title = title;
    b.addEventListener('click', fn); return b;
  }
  async function renderPick(vs) {
    vs = vs || await listVoices();
    var sel = $('clone-voice'), cur = sel.value;
    sel.innerHTML = '';
    if (st.sample && !st.sample.fromVoiceId) {
      var o = document.createElement('option'); o.value = '__sample'; o.textContent = '🎤 Mẫu vừa ghi hoặc tải (chưa lưu)'; sel.appendChild(o);
    }
    vs.forEach(function (v) { var o = document.createElement('option'); o.value = v.id; o.textContent = '🧬 ' + v.name; sel.appendChild(o); });
    if (!sel.options.length) { var e = document.createElement('option'); e.value = ''; e.textContent = 'Chưa có giọng, hãy tạo mẫu ở bước 1'; sel.appendChild(e); }
    if (cur && sel.querySelector('option[value="' + cur + '"]')) sel.value = cur;
  }

  async function saveVoice() {
    if (!st.sample) { status('clone-sample-status', 'Chưa có mẫu giọng. Hãy ghi âm hoặc tải file lên.', 'warn'); return; }
    var name = $('clone-name').value.trim() || ('Giọng ' + stamp());
    var v = { id: 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name,
      refText: $('clone-ref-text').value.trim(), duration: st.sample.duration, blob: st.sample.blob, createdAt: Date.now() };
    await putVoice(v);
    st.sample.fromVoiceId = v.id;
    $('clone-name').value = '';
    await renderList();
    $('clone-voice').value = v.id;
    status('clone-sample-status', 'Đã lưu giọng "' + name + '". Giờ nhập chữ ở bước 3 để đọc bằng giọng này.', 'ok');
  }

  /* ---------- Gradio ---------- */
  async function gradio() {
    if (st.gradio) return st.gradio;
    var err;
    for (var i = 0; i < GRADIO_URLS.length; i++) {
      try { var m = await import(GRADIO_URLS[i]); if (m && m.Client) { st.gradio = m; return m; } }
      catch (e) { err = e; }
    }
    throw new Error('Không tải được thư viện kết nối Hugging Face. ' + (err && err.message || ''));
  }
  async function client() {
    var c = getCfg(), key = c.space + '|' + c.token;
    if (st.client && st.clientKey === key) return st.client;
    var g = await gradio();
    var opts = {}; if (c.token) opts.hf_token = c.token;
    st.client = await g.Client.connect(c.space, opts);
    st.clientKey = key;
    return st.client;
  }

  var RX_REF = /ref|refer|tham.?chi|m[ẫa]u|prompt|transcri|ph[ụu].?đ[ềe]/i;
  var RX_GEN = /gen|target|synth|input.?text|text.?to|c[ầa]n.?đ[ọo]c|n[ộo]i.?dung|v[ăa]n.?b[ảa]n/i;
  var RX_SPEED = /speed|t[ốo]c.?đ[ộo]/i;
  function plabel(p) { return (p.label || '') + ' ' + (p.parameter_name || ''); }

  /* Dò endpoint có 1 ô âm thanh vào + ô chữ, trả về âm thanh */
  function detect(api) {
    var eps = Object.assign({}, api.named_endpoints || {});
    var best = null;
    Object.keys(eps).forEach(function (name) {
      var e = eps[name], ps = e.parameters || [], rs = e.returns || [];
      var audio = [], text = [];
      ps.forEach(function (p, i) {
        var comp = String(p.component || '').toLowerCase();
        if (comp === 'audio' || comp === 'file') audio.push(i);
        else if (comp === 'textbox') text.push(i);
      });
      var outAudio = rs.some(function (r) { return /audio|file/i.test(String(r.component || '')); });
      if (!audio.length || !text.length || !outAudio) return;
      var score = 10 - Math.abs(ps.length - 4) * 0.5;
      if (/infer|tts|synth|generat|clone|basic/i.test(name)) score += 5;
      if (/podcast|multi|emotion|chat/i.test(name)) score -= 6;
      if (!best || score > best.score) best = { name: name, ep: e, audio: audio[0], text: text, score: score };
    });
    if (!best) return null;
    var ps = best.ep.parameters, ref = -1, gen = -1, speed = -1;
    best.text.forEach(function (i) {
      var l = plabel(ps[i]);
      if (ref < 0 && RX_REF.test(l)) ref = i;
      else if (gen < 0 && RX_GEN.test(l)) gen = i;
    });
    if (gen < 0) gen = best.text.filter(function (i) { return i !== ref; })[0];
    if (gen === undefined) gen = -1;
    if (ref < 0 && best.text.length > 1) ref = best.text.filter(function (i) { return i !== gen; })[0];
    ps.forEach(function (p, i) {
      if (speed < 0 && /slider|number/i.test(String(p.component)) && RX_SPEED.test(plabel(p))) speed = i;
    });
    return { endpoint: best.name, params: ps, audio: best.audio, ref: ref, gen: gen, speed: speed };
  }

  async function probe() {
    var c = getCfg();
    status('clone-server-status', 'Đang kết nối ' + c.space + '...', 'busy');
    try {
      st.client = null;
      var cl = await client();
      var api = await cl.view_api();
      var m = detect(api);
      if (!m) throw new Error('Space này không có chức năng nhận âm thanh mẫu và chữ để đọc. Hãy chọn Space khác.');
      st.map = m;
      showMap();
      status('clone-server-status', 'Kết nối được. Chức năng dùng: ' + m.endpoint + '.', 'ok');
      return m;
    } catch (e) {
      st.map = null; showMap();
      status('clone-server-status', niceErr(e), 'error');
      throw e;
    }
  }
  function showMap() {
    var box = $('clone-map'), m = st.map, c = getCfg();
    if (!m) { box.textContent = ''; box.hidden = true; return; }
    var ref = m.ref, gen = m.gen;
    if (c.swap && ref >= 0 && gen >= 0) { var t = ref; ref = gen; gen = t; }
    function lb(i) { return i < 0 ? '(không có)' : '"' + (m.params[i].label || m.params[i].parameter_name) + '"'; }
    box.hidden = false;
    box.textContent = 'Âm thanh mẫu → ' + lb(m.audio) + '\nCâu chữ mẫu → ' + lb(ref) + '\nChữ cần đọc → ' + lb(gen) + '\nTốc độ → ' + lb(m.speed);
    $('btn-clone-swap').hidden = !(m.ref >= 0 && m.gen >= 0);
  }
  function niceErr(e) {
    var s = e && e.message ? e.message : String(e);
    if (/quota|ZeroGPU|exceeded/i.test(s)) return 'Hết lượt GPU miễn phí của Hugging Face. Chờ một lúc rồi thử lại, hoặc nhập khóa Hugging Face (miễn phí) ở phần Máy chủ.';
    if (/sleep|paused|building|runtime error/i.test(s)) return 'Space đang ngủ hoặc đang khởi động. Chờ 1 đến 2 phút rồi bấm lại.';
    if (/fetch|network|load failed/i.test(s)) return 'Không kết nối được máy chủ. Kiểm tra mạng, hoặc Space đang tắt.';
    if (/not found|404|could not resolve/i.test(s)) return 'Không tìm thấy Space. Kiểm tra lại tên Space (dạng tên-người/tên-space).';
    return 'Lỗi: ' + s;
  }

  function splitText(text) {
    var sents = (window.DaoTTS && window.DaoTTS.splitSentences) ? window.DaoTTS.splitSentences(text)
      : String(text).split(/(?<=[.!?…])\s+|\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var out = [], cur = '';
    sents.forEach(function (s) {
      if (cur && (cur + ' ' + s).length > CHUNK) { out.push(cur); cur = s; }
      else cur = cur ? cur + ' ' + s : s;
    });
    if (cur) out.push(cur);
    return out;
  }

  function pickAudioUrl(data) {
    for (var i = 0; i < (data || []).length; i++) {
      var d = data[i];
      if (!d) continue;
      if (typeof d === 'object' && d.url) return d.url;
      if (typeof d === 'object' && d.value && d.value.url) return d.value.url;
      if (typeof d === 'string' && /^https?:.*\.(wav|mp3|flac|ogg|m4a)(\?|$)/i.test(d)) return d;
    }
    return null;
  }

  async function genChunk(m, sampleBlob, refText, text, speed) {
    var c = getCfg(), g = await gradio(), cl = await client();
    var ref = m.ref, gen = m.gen;
    if (c.swap && ref >= 0 && gen >= 0) { var t = ref; ref = gen; gen = t; }
    var args = m.params.map(function (p, i) {
      if (i === m.audio) return g.handle_file(sampleBlob);
      if (i === gen) return text;
      if (i === ref) return refText || '';
      if (i === m.speed) return speed;
      if (p.parameter_has_default) return p.parameter_default;
      if (p.example_input !== undefined && !/audio|file|image/i.test(String(p.component))) return p.example_input;
      return null;
    });
    var r = await cl.predict(m.endpoint, args);
    var url = pickAudioUrl(r && r.data);
    if (!url) throw new Error('Máy chủ không trả về âm thanh.');
    var res = await fetch(url, c.token ? { headers: { Authorization: 'Bearer ' + c.token } } : undefined);
    if (!res.ok) throw new Error('Không tải được âm thanh kết quả (' + res.status + ').');
    return decodeMono(await res.blob());
  }

  async function generate() {
    if (st.busy) { st.cancel = true; status('clone-gen-status', 'Đang dừng sau đoạn hiện tại...', 'warn'); return; }
    var text = $('clone-gen-text').value.trim();
    if (!text) { status('clone-gen-status', 'Hãy nhập chữ cần đọc.', 'warn'); return; }
    var vid = $('clone-voice').value, sample, refText;
    if (vid === '__sample') {
      if (!st.sample) { status('clone-gen-status', 'Chưa có mẫu giọng.', 'warn'); return; }
      sample = st.sample.blob; refText = $('clone-ref-text').value.trim();
    } else {
      var v = (await listVoices()).filter(function (x) { return x.id === vid; })[0];
      if (!v) { status('clone-gen-status', 'Hãy tạo hoặc chọn giọng ở bước 1 và 2.', 'warn'); return; }
      sample = v.blob; refText = v.refText;
    }
    var speed = parseFloat($('clone-speed').value) || 1;
    var btn = $('btn-clone-gen');
    st.busy = true; st.cancel = false; btn.textContent = '⏹️ Dừng';
    $('btn-clone-dl').disabled = true; $('btn-clone-dl-mp3').disabled = true;
    try {
      var m = st.map || await probe();
      var parts = splitText(text), pcms = [], total = 0, gap = new Float32Array(Math.floor(RATE * 0.25));
      for (var i = 0; i < parts.length; i++) {
        if (st.cancel) throw new Error('Đã dừng.');
        status('clone-gen-status', 'Đang tạo đoạn ' + (i + 1) + '/' + parts.length + '... (máy chủ miễn phí, có thể phải chờ hàng đợi)', 'busy');
        bar(i / parts.length);
        var p = await genChunk(m, sample, refText, parts[i], speed);
        pcms.push(p); total += p.length;
        if (i < parts.length - 1) { pcms.push(gap); total += gap.length; }
      }
      var all = new Float32Array(total), o = 0;
      pcms.forEach(function (p) { all.set(p, o); o += p.length; });
      st.result = { pcm: all, rate: RATE };
      if (st.resultUrl) URL.revokeObjectURL(st.resultUrl);
      st.resultUrl = URL.createObjectURL(encodeWav(all, RATE));
      var au = $('clone-audio'); au.src = st.resultUrl; au.hidden = false;
      try { await au.play(); } catch (e) {}
      $('btn-clone-dl').disabled = false; $('btn-clone-dl-mp3').disabled = false;
      status('clone-gen-status', 'Xong: ' + fmtSec(all.length / RATE) + '.', 'ok');
    } catch (e) {
      status('clone-gen-status', e.message === 'Đã dừng.' ? 'Đã dừng.' : niceErr(e), e.message === 'Đã dừng.' ? 'warn' : 'error');
    } finally {
      st.busy = false; st.cancel = false; btn.textContent = '🧬 Đọc bằng giọng nhân bản'; bar(null);
    }
  }
  function bar(v) {
    var p = $('clone-progress'), b = $('clone-progress-bar');
    if (v == null) { p.hidden = true; return; }
    p.hidden = false; b.style.width = Math.round(v * 100) + '%';
  }

  /* ---------- khởi tạo ---------- */
  function init() {
    if (!$('panel-clone')) return;
    var c = getCfg();
    $('clone-space').value = c.space;
    $('clone-hf-token').value = c.token;

    on($('btn-clone-rec'), 'click', function () { st.rec ? stopRec() : startRec(); });
    on($('clone-file'), 'change', async function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      status('clone-sample-status', 'Đang đọc file...', 'busy');
      try {
        await setSample(f);
        if (!$('clone-name').value) $('clone-name').value = f.name.replace(/\.[^.]+$/, '');
      } catch (err) { status('clone-sample-status', 'Không đọc được file âm thanh: ' + err.message, 'error'); }
      e.target.value = '';
    });
    on($('btn-clone-save'), 'click', function () { saveVoice().catch(function (e) { status('clone-sample-status', e.message, 'error'); }); });
    on($('btn-clone-gen'), 'click', generate);
    on($('clone-speed'), 'input', function () { $('clone-speed-val').textContent = $('clone-speed').value; });
    on($('btn-clone-dl'), 'click', function () { if (st.result) download(encodeWav(st.result.pcm, st.result.rate), 'giong-nhan-ban-' + stamp() + '.wav'); });
    on($('btn-clone-dl-mp3'), 'click', async function () {
      if (!st.result) return;
      try { download(await encodeMp3(st.result.pcm, st.result.rate), 'giong-nhan-ban-' + stamp() + '.mp3'); }
      catch (e) { status('clone-gen-status', 'Không mã hóa được mp3, hãy tải wav. ' + e.message, 'warn'); }
    });
    on($('btn-clone-save-server'), 'click', function () {
      var c = getCfg();
      c.space = $('clone-space').value.trim() || DEFAULT_SPACE;
      c.token = $('clone-hf-token').value.trim();
      c.swap = false;
      setCfg(c); st.client = null; st.map = null;
      probe().catch(function () {});
    });
    on($('btn-clone-swap'), 'click', function () { var c = getCfg(); c.swap = !c.swap; setCfg(c); showMap(); });

    renderList().catch(function (e) { status('clone-sample-status', 'Không mở được bộ nhớ giọng: ' + e.message, 'error'); });
  }

  window.DaoClone = {
    listVoices: listVoices, putVoice: putVoice, deleteVoice: deleteVoice,
    refresh: function () { return renderList(); }, encodeWav: encodeWav, detect: detect
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
