/* Đồng bộ dữ liệu qua một repo GitHub riêng của anh.
   Trong repo:  giong-doc/data.json        (giọng yêu thích, thiết lập, kịch bản, danh sách giọng nhân bản)
                giong-doc/voices/<id>.wav  (file mẫu của từng giọng nhân bản)
   Khóa GitHub chỉ lưu trên máy này, không bao giờ đẩy lên repo. */
(function () {
  'use strict';

  var CFG_KEY = 'dgd_gh';
  var DIR = 'giong-doc';
  var API = 'https://api.github.com';
  var LS_KEYS = { favorites: 'dgd2_favorites', pref: 'dgd2_pref' };

  function $(id) { return document.getElementById(id); }
  function status(msg, kind) {
    var el = $('gh-status'); if (!el) return;
    el.textContent = msg || '';
    el.classList.remove('is-ok', 'is-error', 'is-warn', 'is-busy');
    if (kind) el.classList.add('is-' + kind);
  }
  function getCfg() {
    try { return Object.assign({ token: '', repo: '', branch: 'main', last: '' }, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); }
    catch (e) { return { token: '', repo: '', branch: 'main', last: '' }; }
  }
  function setCfg(c) { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  async function gh(method, path, body, accept) {
    var c = getCfg();
    var res = await fetch(API + path, {
      method: method,
      headers: Object.assign({
        Authorization: 'Bearer ' + c.token,
        Accept: accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      var msg = ''; try { msg = (await res.json()).message; } catch (e) {}
      if (res.status === 401) throw new Error('Khóa GitHub sai hoặc đã hết hạn.');
      if (res.status === 403) throw new Error('Khóa GitHub không đủ quyền ghi vào repo này (' + msg + ').');
      if (res.status === 409) throw new Error('Repo đang trống hoặc bị xung đột. Thử lại sau vài giây.');
      throw new Error('GitHub báo lỗi ' + res.status + ': ' + msg);
    }
    if (accept === 'application/vnd.github.raw') return res.blob();
    return res.status === 204 ? {} : res.json();
  }
  function enc(p) { return p.split('/').map(encodeURIComponent).join('/'); }
  function repoPath() { return '/repos/' + getCfg().repo; }
  function ref() { return '?ref=' + encodeURIComponent(getCfg().branch || 'main'); }

  function b64FromText(s) {
    var bytes = new TextEncoder().encode(s), bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function textFromB64(b) {
    var bin = atob(b.replace(/\n/g, '')), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(u);
  }
  function b64FromBlob(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(',')[1]); };
      r.onerror = function () { rej(r.error); };
      r.readAsDataURL(blob);
    });
  }

  async function putFile(path, b64, sha, msg) {
    return gh('PUT', repoPath() + '/contents/' + enc(path), {
      message: msg, content: b64, branch: getCfg().branch || 'main', sha: sha || undefined
    });
  }

  /* Kiểm tra repo, chưa có thì tạo repo riêng tư */
  async function ensureRepo() {
    var c = getCfg();
    if (!c.token) throw new Error('Chưa nhập khóa GitHub.');
    if (!c.repo) throw new Error('Chưa nhập tên repo.');
    if (c.repo.indexOf('/') < 0) {
      var me = await gh('GET', '/user');
      c.repo = me.login + '/' + c.repo; setCfg(c); $('gh-repo').value = c.repo;
    }
    var r = await gh('GET', '/repos/' + c.repo);
    if (r) {
      if (!c.branch) { c.branch = r.default_branch; setCfg(c); }
      return r;
    }
    var name = c.repo.split('/')[1];
    status('Chưa có repo, đang tạo repo riêng tư "' + name + '"...', 'busy');
    var created = await gh('POST', '/user/repos', { name: name, private: true, auto_init: true, description: 'Dữ liệu đồng bộ của app Giọng đọc Đạo Pro' });
    if (!created) throw new Error('Không tạo được repo. Nếu repo thuộc tổ chức, hãy tạo trước trên GitHub.');
    c.repo = created.full_name; c.branch = created.default_branch || 'main'; setCfg(c);
    await new Promise(function (r) { setTimeout(r, 1500); });
    return created;
  }

  async function readRemoteData() {
    var f = await gh('GET', repoPath() + '/contents/' + enc(DIR + '/data.json') + ref());
    if (!f) return { sha: null, data: null };
    var txt = f.content ? textFromB64(f.content) : await (await gh('GET', repoPath() + '/contents/' + enc(DIR + '/data.json') + ref(), null, 'application/vnd.github.raw')).text();
    return { sha: f.sha, data: JSON.parse(txt) };
  }
  async function listRemoteVoices() {
    var l = await gh('GET', repoPath() + '/contents/' + enc(DIR + '/voices') + ref());
    var m = {};
    (Array.isArray(l) ? l : []).forEach(function (f) { m[f.name] = f.sha; });
    return m;
  }

  /* Máy này → GitHub: GitHub thành giống hệt máy này */
  async function push() {
    status('Đang kiểm tra repo...', 'busy');
    await ensureRepo();
    var voices = window.DaoClone ? await window.DaoClone.listVoices() : [];
    var remoteFiles = await listRemoteVoices();
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i], fn = v.id + '.wav';
      if (remoteFiles[fn]) continue;
      status('Đang đẩy giọng ' + (i + 1) + '/' + voices.length + ': ' + v.name + '...', 'busy');
      await putFile(DIR + '/voices/' + fn, await b64FromBlob(v.blob), null, 'Thêm giọng nhân bản: ' + v.name);
    }
    var keep = {};
    voices.forEach(function (v) { keep[v.id + '.wav'] = 1; });
    var stale = Object.keys(remoteFiles).filter(function (n) { return !keep[n]; });
    for (i = 0; i < stale.length; i++) {
      status('Đang xóa giọng cũ trên GitHub ' + (i + 1) + '/' + stale.length + '...', 'busy');
      await gh('DELETE', repoPath() + '/contents/' + enc(DIR + '/voices/' + stale[i]), { message: 'Xóa giọng: ' + stale[i], sha: remoteFiles[stale[i]], branch: getCfg().branch || 'main' });
    }
    var st = $('script-text');
    var data = {
      app: 'dao-giong-doc', format: 1, updatedAt: new Date().toISOString(),
      favorites: lsGet(LS_KEYS.favorites, []),
      pref: lsGet(LS_KEYS.pref, null),
      scriptText: st ? st.value : '',
      cloneVoices: voices.map(function (v) {
        return { id: v.id, name: v.name, refText: v.refText || '', duration: v.duration, createdAt: v.createdAt, file: 'voices/' + v.id + '.wav' };
      })
    };
    status('Đang lưu danh sách...', 'busy');
    var cur = await readRemoteData();
    await putFile(DIR + '/data.json', b64FromText(JSON.stringify(data, null, 2)), cur.sha, 'Đồng bộ từ app Giọng đọc');
    done('Đã đẩy lên GitHub: ' + voices.length + ' giọng nhân bản, ' + data.favorites.length + ' giọng yêu thích.');
  }

  /* GitHub → máy này: thêm cái còn thiếu, không xóa gì trên máy */
  async function pull() {
    status('Đang đọc dữ liệu trên GitHub...', 'busy');
    await ensureRepo();
    var r = await readRemoteData();
    if (!r.data) { status('Trên GitHub chưa có dữ liệu. Hãy bấm "Đẩy lên" từ máy có dữ liệu trước.', 'warn'); return; }
    var d = r.data, addedV = 0, addedF = 0;

    var favs = lsGet(LS_KEYS.favorites, []), have = {};
    favs.forEach(function (f) { have[f.id] = 1; });
    (d.favorites || []).forEach(function (f) { if (f && f.id && !have[f.id]) { favs.push(f); addedF++; } });
    lsSet(LS_KEYS.favorites, favs);
    if (d.pref && lsGet(LS_KEYS.pref, null) == null) lsSet(LS_KEYS.pref, d.pref);

    var st = $('script-text');
    if (st && d.scriptText && !st.value.trim()) st.value = d.scriptText;

    if (window.DaoClone) {
      var local = await window.DaoClone.listVoices(), ids = {};
      local.forEach(function (v) { ids[v.id] = 1; });
      var list = (d.cloneVoices || []).filter(function (v) { return v && v.id && !ids[v.id]; });
      for (var i = 0; i < list.length; i++) {
        var v = list[i];
        status('Đang tải giọng ' + (i + 1) + '/' + list.length + ': ' + v.name + '...', 'busy');
        var blob = await gh('GET', repoPath() + '/contents/' + enc(DIR + '/' + v.file) + ref(), null, 'application/vnd.github.raw');
        if (!blob) continue;
        await window.DaoClone.putVoice({ id: v.id, name: v.name, refText: v.refText || '', duration: v.duration, createdAt: v.createdAt || Date.now(),
          blob: new Blob([blob], { type: 'audio/wav' }) });
        addedV++;
      }
      await window.DaoClone.refresh();
    }
    done('Đã kéo về: thêm ' + addedV + ' giọng nhân bản, ' + addedF + ' giọng yêu thích.');
  }

  function done(msg) {
    var c = getCfg(); c.last = new Date().toLocaleString('vi-VN'); setCfg(c);
    status(msg, 'ok'); showLast();
  }
  function showLast() {
    var c = getCfg(), el = $('gh-last');
    if (el) el.textContent = c.last ? 'Lần đồng bộ gần nhất: ' + c.last : '';
    var link = $('gh-link');
    if (link) { link.hidden = !c.repo || c.repo.indexOf('/') < 0; link.href = 'https://github.com/' + c.repo + '/tree/' + (c.branch || 'main') + '/' + DIR; }
  }

  function wrap(fn) {
    return async function () {
      var btns = document.querySelectorAll('.gh-btn');
      btns.forEach(function (b) { b.disabled = true; });
      try { saveForm(); await fn(); }
      catch (e) { status(/fetch|network|load failed/i.test(e.message) ? 'Không kết nối được GitHub. Kiểm tra mạng.' : e.message, 'error'); }
      finally { btns.forEach(function (b) { b.disabled = false; }); }
    };
  }
  function saveForm() {
    var c = getCfg();
    c.token = $('gh-token').value.trim();
    var repo = $('gh-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    if (repo !== c.repo) c.branch = '';
    c.repo = repo;
    setCfg(c);
  }

  function init() {
    if (!$('gh-token')) return;
    var c = getCfg();
    $('gh-token').value = c.token;
    $('gh-repo').value = c.repo || 'giong-doc-data';
    showLast();
    $('btn-gh-push').addEventListener('click', wrap(push));
    $('btn-gh-pull').addEventListener('click', wrap(pull));
    $('btn-gh-forget').addEventListener('click', function () {
      var c = getCfg(); c.token = ''; setCfg(c); $('gh-token').value = '';
      status('Đã xóa khóa GitHub khỏi máy này.', 'ok');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
