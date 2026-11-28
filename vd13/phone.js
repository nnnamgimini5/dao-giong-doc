// VD-13 · App điện thoại: gửi lệnh cho máy tính, theo dõi tiến độ, nhận video thành phẩm
const $ = id => document.getElementById(id);
const K_CODE = 'vd13p_code', K_JOBS = 'vd13p_jobs';
const get = (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } };
const put = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
let ch = null, sub = null, pingId = '', pingTimer = null, curJob = '';
let jobs = JSON.parse(get(K_JOBS, '[]'));
const files = { char: null, prod: null, ref: null };

function toast(t) { const e = $('toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove('show'), 3200); }
const fmtT = ms => new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
const fmtD = ms => new Date(ms).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const saveJobs = () => { jobs = jobs.slice(-30); put(K_JOBS, JSON.stringify(jobs)); renderHist(); };
const jobOf = id => jobs.find(j => j.id === id);

// ---- Kho video trên điện thoại (IndexedDB) ----
const db = new Promise(ok => { const r = indexedDB.open('vd13p', 1); r.onupgradeneeded = () => r.result.createObjectStore('videos'); r.onsuccess = () => ok(r.result); r.onerror = () => ok(null); });
async function vPut(id, file) { const d = await db; if (!d) return; await new Promise(ok => { const t = d.transaction('videos', 'readwrite'); t.objectStore('videos').put(file, id); t.oncomplete = ok; t.onerror = ok; }); }
async function vGet(id) { const d = await db; if (!d) return null; return new Promise(ok => { const r = d.transaction('videos').objectStore('videos').get(id); r.onsuccess = () => ok(r.result || null); r.onerror = () => ok(null); }); }
async function vDel(id) { const d = await db; if (!d) return; d.transaction('videos', 'readwrite').objectStore('videos').delete(id); }

// ---- Điều hướng ----
function page(p) { document.querySelectorAll('.page').forEach(e => e.classList.toggle('on', e.id === p)); document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.p === p)); scrollTo(0, 0); }
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => page(b.dataset.p));

// ---- Ghép đôi & kết nối ----
function pill(cls, t) { const p = $('conn'); p.className = 'pill ' + cls; p.textContent = t; }
async function connect() {
  const code = get(K_CODE); if (!code) { pill('', 'Chưa ghép'); $('pairCard').hidden = false; return; }
  $('code').value = code;
  if (sub) sub.stop();
  try { ch = await VD13Link.open(code); } catch (e) { $('pairMsg').textContent = e.message; return; }
  const open = jobs.filter(j => j.state === 'sent' || j.state === 'run').map(j => j.at);
  const since = open.length ? String(Math.floor(Math.min(...open) / 1000) - 60) : '2m';
  sub = ch.listen(onMsg, { since, onState: s => { if (s === 'off') pill('wait', 'Đang nối lại…'); } });
  ping();
}
async function ping() {
  if (!ch) return;
  pingId = 'p' + Date.now(); pill('wait', 'Đang tìm máy tính…'); $('pairMsg').textContent = 'Đang hỏi máy tính…';
  clearTimeout(pingTimer);
  pingTimer = setTimeout(() => { pill('off', 'Máy tính chưa bật'); $('pairMsg').innerHTML = '⚠️ Máy tính chưa trả lời. Kiểm tra: máy tính bật, Chrome mở app VD-13, đã tích <b>Nhận lệnh từ điện thoại</b>. Lệnh gửi lúc này vẫn được giữ khoảng 2 giờ.'; }, 20000);
  try { await ch.send('phone', 'ping', pingId, { at: Date.now() }); } catch (e) { $('pairMsg').textContent = 'Lỗi mạng: ' + e.message; }
}
$('bPair').onclick = () => {
  const c = VD13Link.cleanCode($('code').value); if (c.length !== 16) return toast('Mã gồm 16 ký tự, xem trên máy tính');
  put(K_CODE, c); connect();
};
$('bForget').onclick = () => { if (!confirm('Quên mã ghép đôi trên điện thoại này?')) return; put(K_CODE, ''); if (sub) sub.stop(); ch = null; $('code').value = ''; pill('', 'Chưa ghép'); page('pgNew'); };

// ---- Nhận tin từ máy tính ----
async function onMsg(m) {
  if (m.from !== 'pc') return;
  if (m.kind === 'pong' && m.id === pingId) {
    clearTimeout(pingTimer);
    pill('on', m.obj.busy ? 'Máy tính đang bận' : 'Máy tính sẵn sàng');
    $('pairMsg').textContent = m.obj.busy ? `✅ Đã kết nối. Máy tính đang làm một video (còn ${m.obj.queue} việc chờ), lệnh mới sẽ xếp hàng.` : '✅ Đã kết nối máy tính, sẵn sàng tạo video.';
    return;
  }
  const j = jobOf(m.id); if (!j) return;
  if ((j.mids || []).includes(m.mid)) return; j.mids = (j.mids || []).concat(m.mid).slice(-80);
  if (m.kind === 'st') {
    if (j.state === 'done' || j.state === 'err') return;
    j.state = 'run'; j.log = (j.log || []).concat({ t: m.obj.at || Date.now(), x: m.obj.text }).slice(-60); saveJobs();
    if (curJob === j.id) renderLog(j);
    pill('on', 'Đang tạo video');
  }
  if (m.kind === 'done') {
    if (j.state === 'done') return;
    if (m.obj.ok && m.obj.files && m.obj.files[0]) {
      const f = m.obj.files[0]; await vPut(j.id, f);
      j.state = 'done'; j.size = f.size; j.log = (j.log || []).concat({ t: Date.now(), x: '✅ Đã nhận video thành phẩm' }); saveJobs();
      notify('Video đã xong', `"${j.name}" đã về điện thoại`);
      showJob(j.id); page('pgRun');
    } else {
      j.state = 'err'; j.msg = m.obj.error || 'Lỗi không rõ'; j.log = (j.log || []).concat({ t: Date.now(), x: '❌ ' + j.msg }); saveJobs();
      notify('Video chưa tạo được', j.msg);
      if (curJob === j.id) renderLog(j);
    }
    pill('on', 'Máy tính sẵn sàng');
  }
}
function notify(t, b) { toast(t + ': ' + b); try { if (Notification.permission === 'granted') navigator.serviceWorker.ready.then(r => r.showNotification(t, { body: b, icon: 'icon-192.png' })); } catch (e) {} }

// ---- Tệp đính kèm ----
async function shrink(file, max = 1280) {
  const img = await createImageBitmap(file).catch(() => null); if (!img) return file;
  const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const b = await new Promise(r => c.toBlob(r, 'image/jpeg', .88)); return new File([b], 'anh.jpg', { type: 'image/jpeg' });
}
function preview(k, f) {
  const v = $('v' + k[0].toUpperCase() + k.slice(1)); if (!f) { v.hidden = true; return; }
  v.hidden = false; const mb = (f.size / 1048576).toFixed(1);
  v.innerHTML = (f.type.startsWith('image') ? `<img src="${URL.createObjectURL(f)}" alt="">` : '🎞️') + `<span>${esc(f.name)} · ${mb} MB</span><button type="button" data-clr="${k}">Bỏ</button>`;
}
document.addEventListener('click', e => { const b = e.target.closest('[data-clr]'); if (!b) return; const k = b.dataset.clr; files[k] = null; $('f' + k[0].toUpperCase() + k.slice(1)).value = ''; preview(k, null); });
$('fChar').onchange = async e => { const f = e.target.files[0]; files.char = f ? await shrink(f) : null; preview('char', files.char); };
$('fProd').onchange = async e => { const f = e.target.files[0]; files.prod = f ? await shrink(f, 1080) : null; preview('prod', files.prod); };
$('fRef').onchange = e => {
  const f = e.target.files[0] || null;
  if (f && f.size > 12 * 1048576) { toast(`Video ${(f.size / 1048576).toFixed(1)} MB lớn quá (tối đa 12 MB). Hãy cắt ngắn hoặc giảm chất lượng.`); e.target.value = ''; return; }
  files.ref = f; preview('ref', f);
};
$('bSample').onclick = () => { $('script').value = `Cảnh 1: Nhân vật cầm sản phẩm đưa gần ống kính, mỉm cười
Lời thoại: Thích mùi nước hoa cao cấp mà không muốn bỏ vài triệu thì săn em này nè.

Cảnh 2: Cận cảnh xịt thử lên cổ tay, đưa lên ngửi
Lời thoại: Mùi thơm sang, lưu hương cả ngày, chai mini bỏ túi tiện lắm.

Cảnh 3: Giơ hai chai và hai hộp khoe trước ống kính
Lời thoại: Hôm nay shop chơi lớn, mua một tặng một luôn.

Cảnh 4: Chỉ tay xuống góc màn hình
Lời thoại: Bấm giỏ hàng bên dưới đặt ngay kẻo hết nha.`; toast('Đã chèn kịch bản mẫu, anh sửa theo sản phẩm'); };

// ---- Gửi lệnh ----
$('bSend').onclick = async () => {
  if (!ch) { toast('Chưa ghép đôi máy tính'); $('code').focus(); return; }
  const name = $('name').value.trim(), script = $('script').value.trim();
  if (!script && !files.ref) return toast('Nhập kịch bản hoặc chọn video mẫu');
  const id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const fields = { name, features: $('features').value, price: $('price').value, character: $('character').value, ratio: $('ratio').value, voice: 'speak', script, target: +$('target').value || 0, useRef: $('useRef').checked, keepChar: !files.char };
  const list = [];
  if (files.char) list.push(new File([files.char], 'char_anh.jpg', { type: 'image/jpeg' }));
  if (files.prod) list.push(new File([files.prod], 'prod_anh.jpg', { type: 'image/jpeg' }));
  if (files.ref) list.push(new File([files.ref], 'ref_' + files.ref.name, { type: files.ref.type || 'video/mp4' }));
  const b = $('bSend'); b.disabled = true; b.textContent = '⏳ Đang gửi…';
  try {
    try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {}
    jobs.push({ id, name: name || 'Video', at: Date.now(), state: 'sent', log: [{ t: Date.now(), x: '📤 Đã gửi lệnh, chờ máy tính nhận…' }] }); saveJobs();
    await ch.send('phone', 'job', id, { fields }, list);
    showJob(id); page('pgRun'); toast('Đã gửi lệnh cho máy tính');
  } catch (e) {
    jobs = jobs.filter(j => j.id !== id); saveJobs(); toast('Gửi chưa được: ' + e.message);
  } finally { b.disabled = false; b.textContent = '🚀 Gửi máy tính tạo video'; }
};
$('bStop').onclick = async () => { const j = jobOf(curJob); if (!j || !confirm('Dừng tạo video này?')) return; try { await ch.send('phone', 'stop', j.id, {}); toast('Đã gửi lệnh dừng'); } catch (e) { toast(e.message); } };

// ---- Hiển thị ----
function renderLog(j) {
  $('jobName').textContent = '· ' + j.name;
  $('log').innerHTML = (j.log || []).slice().reverse().map(l => `<li><time>${fmtT(l.t)}</time>${esc(l.x)}</li>`).join('') || '<li class="mu">Chưa có tin.</li>';
  $('bStop').hidden = !(j.state === 'sent' || j.state === 'run');
}
let outUrl = '';
async function showJob(id) {
  const j = jobOf(id); if (!j) return; curJob = id; renderLog(j);
  const f = j.state === 'done' ? await vGet(id) : null;
  $('outCard').hidden = !f; if (!f) return;
  if (outUrl) URL.revokeObjectURL(outUrl); outUrl = URL.createObjectURL(f);
  $('out').src = outUrl; $('bSave').href = outUrl; $('bSave').download = f.name || 'video.mp4';
  $('bShare').onclick = async () => {
    try { if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: j.name }); else { $('bSave').click(); toast('Máy không hỗ trợ chia sẻ file, đã lưu về máy'); } }
    catch (e) { if (e.name !== 'AbortError') toast('Chưa chia sẻ được: ' + e.message); }
  };
}
function renderHist() {
  const icon = { sent: '📤', run: '⏳', done: '✅', err: '❌' };
  $('hist').innerHTML = jobs.slice().reverse().map(j => `<li><b>${icon[j.state] || '•'}</b><span>${esc(j.name)}<br><small class="mu">${fmtD(j.at)}${j.size ? ' · ' + (j.size / 1048576).toFixed(1) + ' MB' : ''}${j.msg ? ' · ' + esc(j.msg) : ''}</small></span><button data-open="${j.id}">Xem</button><button data-del="${j.id}">🗑️</button></li>`).join('') || '<li class="mu">Chưa có video nào.</li>';
}
document.addEventListener('click', e => {
  const o = e.target.closest('[data-open]'); if (o) { showJob(o.dataset.open); page('pgRun'); }
  const d = e.target.closest('[data-del]'); if (d && confirm('Xóa video này khỏi điện thoại?')) { vDel(d.dataset.del); jobs = jobs.filter(j => j.id !== d.dataset.del); saveJobs(); }
});

// ---- Cài app ----
let installEv = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEv = e; $('bInstall').hidden = false; });
$('bInstall').onclick = async () => { if (!installEv) return; installEv.prompt(); await installEv.userChoice; installEv = null; $('bInstall').hidden = true; };
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// ---- Khởi động ----
document.addEventListener('visibilitychange', () => { if (!document.hidden && ch) { connect(); } });
(function init() {
  const h = VD13Link.cleanCode(decodeURIComponent(location.hash.slice(1)));
  if (h.length === 16) { put(K_CODE, h); history.replaceState(null, '', location.pathname); toast('Đã nhận mã ghép đôi từ máy tính'); }
  renderHist();
  const last = jobs[jobs.length - 1]; if (last) showJob(last.id);
  connect();
})();
