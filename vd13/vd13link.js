// VD-13 · Kênh liên lạc mã hóa giữa điện thoại và máy tính (qua máy chủ chuyển tin ntfy.sh)
// Mã ghép đôi sinh ra cả tên kênh và khóa mã hóa AES-GCM: máy chủ chỉ thấy dữ liệu đã mã hóa.
(function (g) {
  const HOST = 'https://ntfy.sh';
  const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const te = new TextEncoder(), td = new TextDecoder();
  const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  const b64 = u => { let s = ''; const a = new Uint8Array(u); for (let i = 0; i < a.length; i += 32768) s += String.fromCharCode.apply(null, a.subarray(i, i + 32768)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  function newCode() { const r = crypto.getRandomValues(new Uint8Array(16)); return [...r].map(x => ABC[x % ABC.length]).join('').replace(/(.{4})(?=.)/g, '$1-'); }
  const cleanCode = c => (c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  async function open(code) {
    const c = cleanCode(code); if (c.length < 12) throw new Error('Mã ghép đôi chưa đúng (cần 16 ký tự)');
    const topic = 'vd13_' + hex(await crypto.subtle.digest('SHA-256', te.encode('topic:' + c))).slice(0, 24);
    const raw = await crypto.subtle.digest('SHA-256', te.encode('key:' + c));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const enc = async bytes => { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes); const o = new Uint8Array(12 + ct.byteLength); o.set(iv); o.set(new Uint8Array(ct), 12); return o; };
    const dec = async bytes => { const a = new Uint8Array(bytes); return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: a.subarray(0, 12) }, key, a.subarray(12))); };

    // Gói = [4 byte độ dài JSON][JSON][các file nối tiếp]; JSON.files = [{name,type,size}]
    async function pack(obj, files = []) {
      const metas = [], parts = [];
      for (const f of files) { const b = new Uint8Array(await f.arrayBuffer()); metas.push({ name: f.name || 'file', type: f.type || 'application/octet-stream', size: b.length }); parts.push(b); }
      const j = te.encode(JSON.stringify({ ...obj, files: metas }));
      const total = 4 + j.length + parts.reduce((s, p) => s + p.length, 0);
      const out = new Uint8Array(total); new DataView(out.buffer).setUint32(0, j.length); out.set(j, 4);
      let o = 4 + j.length; for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    }
    function unpack(u) {
      const n = new DataView(u.buffer, u.byteOffset).getUint32(0); const obj = JSON.parse(td.decode(u.subarray(4, 4 + n)));
      let o = 4 + n; obj.files = (obj.files || []).map(m => { const f = new File([u.subarray(o, o + m.size)], m.name, { type: m.type }); o += m.size; return f; });
      return obj;
    }

    async function send(from, kind, id, obj, files = []) {
      const head = `vd13|${from}|${kind}|${id}|`;
      if (!files.length) {
        const body = head + b64(await enc(te.encode(JSON.stringify(obj))));
        if (body.length < 3800) { const r = await fetch(`${HOST}/${topic}`, { method: 'POST', body }); if (!r.ok) throw new Error('Máy chủ chuyển tin từ chối (' + r.status + ')'); return; }
      }
      const data = await enc(await pack(obj, files));
      if (data.length > 15 * 1024 * 1024 - 1024) throw new Error(`Dữ liệu ${(data.length / 1048576).toFixed(1)} MB vượt giới hạn 15 MB của kênh chuyển`);
      const r = await fetch(`${HOST}/${topic}`, { method: 'PUT', body: data, headers: { 'Filename': kind + '.bin', 'X-Message': head } });
      if (!r.ok) throw new Error('Máy chủ chuyển tin từ chối file (' + r.status + ')');
    }

    async function read(m) {
      const parts = (m.message || '').split('|'); if (parts[0] !== 'vd13') return null;
      const [, from, kind, id] = parts; let obj;
      if (m.attachment && m.attachment.url) {
        const r = await fetch(m.attachment.url); if (!r.ok) throw new Error('File đã hết hạn trên máy chủ chuyển tin');
        obj = unpack(await dec(await r.arrayBuffer()));
      } else obj = JSON.parse(td.decode(await dec(unb64(parts.slice(4).join('|')))));
      return { from, kind, id, obj, time: m.time, mid: m.id };
    }

    // Nghe kênh; tự nối lại khi rớt mạng, không bỏ sót tin (since = id tin cuối)
    function listen(onMsg, { since = '1h', onState = () => {} } = {}) {
      let es = null, last = since, stopped = false, timer = null;
      const connect = () => {
        if (stopped) return;
        es = new EventSource(`${HOST}/${topic}/sse?since=${encodeURIComponent(last)}`);
        es.onopen = () => onState('on');
        es.onmessage = async ev => {
          let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.event !== 'message') return; last = m.id;
          try { const r = await read(m); if (r) onMsg(r); } catch (e) { onState('err', e.message); }
        };
        es.onerror = () => { onState('off'); es.close(); clearTimeout(timer); timer = setTimeout(connect, 4000); };
      };
      connect();
      return { stop() { stopped = true; clearTimeout(timer); es && es.close(); } };
    }
    return { topic, send, listen };
  }
  g.VD13Link = { newCode, cleanCode, open, HOST };
})(typeof window !== 'undefined' ? window : self);
