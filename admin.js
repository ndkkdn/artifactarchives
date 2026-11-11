/* Artifact Archives — 관리 모드 (추가·수정·삭제)
 *
 * GitHub Pages는 정적 호스팅이라 서버가 없습니다. 그래서 이 스크립트는 브라우저에서
 * GitHub API로 저장소에 직접 커밋합니다. 한 번 저장하면 items.js와 올린 파일들이
 * 커밋 하나로 묶여 main 브랜치에 들어가고, Pages가 1~2분 안에 다시 배포합니다.
 *
 * 필요한 것: 이 저장소에 대한 Fine-grained token (Contents: Read and write).
 * 토큰은 GitHub API 외에는 보내지 않습니다. 이 기기에 저장할 때는 직접 정한 패스워드로 암호화해
 * (PBKDF2-SHA256 600,000회 → AES-256-GCM) localStorage에 넣고, 평문 토큰은 지금 열린 탭의
 * sessionStorage에만 둡니다. 패스워드를 5번 틀리면 저장된 토큰을 지웁니다.
 */
(() => {
  const REPO = 'ndkkdn/artifactarchives';
  const BRANCH = 'main';
  const DATA_PATH = 'items.js';
  const TOKEN_KEY = 'archive-gh-token';      // plaintext: sessionStorage only (legacy: localStorage)
  const VAULT_KEY = 'archive-gh-vault';      // password-encrypted token in localStorage
  const MAX_FAILS = 5, PBKDF2_ITER = 600000, MIN_PW = 8;
  const API = 'https://api.github.com';

  const A = window.Archive;
  const esc = A.esc;
  const $ = id => document.getElementById(id);
  let token = '';
  let dataSha = '';          // blob sha of items.js we last read — used to detect edits made elsewhere
  let items = A.items.slice();
  const previews = {};       // href -> data URL, so freshly uploaded thumbnails show before Pages redeploys

  /* ── styles ─────────────────────────────── */
  if (!document.querySelector('link[href="dialog.css"]')) {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = 'dialog.css'; document.head.appendChild(link);
  }

  /* ── small helpers ─────────────────────── */
  const toastEl = document.createElement('div');
  toastEl.className = 'adm-toast'; toastEl.setAttribute('role', 'status');
  document.body.appendChild(toastEl);
  let toastT;
  function toast(msg, ms = 3200) {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const randId = () => Math.random().toString(36).slice(2, 8);

  function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const textToB64 = t => bytesToB64(new TextEncoder().encode(t));
  const b64ToText = b => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, '')), c => c.charCodeAt(0)));

  // a local, repo-relative path we are allowed to write/delete (no absolute URLs, no "..", no leading slash)
  const isLocal = h => !!h && !/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith('/') && !h.startsWith('//') && !h.split('/').includes('..');
  const safeHref = h => isLocal(h) || /^https?:\/\//i.test(h);
  const slugOk = s => /^[a-z0-9][a-z0-9-]{0,60}$/.test(s);

  function serialize(list) {
    const clean = list.map(({ href, title, desc, type, tags, date, thumb }) => ({ href, title, desc, type, tags, date, thumb }));
    const json = JSON.stringify(clean, null, 2)
      .replace(/\[\n\s+("[^\]]*?")\n\s+\]/g, (m, inner) => '[' + inner.split(/,\n\s+/).join(', ') + ']');
    return '// 아카이브 데이터. 관리 모드(편집)에서 저장하면 이 파일이 자동으로 다시 쓰입니다.\n' +
           '// 직접 고칠 때도 JSON 형식(따옴표 붙은 키)을 유지해 주세요.\n' +
           'window.ITEMS = ' + json + ';\n';
  }
  function parseData(text) {
    const a = text.indexOf('['), b = text.lastIndexOf(']');
    const list = JSON.parse(text.slice(a, b + 1));
    if (!Array.isArray(list)) throw new Error('items.js 형식을 읽을 수 없습니다.');
    return list;
  }

  /* ── GitHub API ─────────────────────────── */
  // A public repo answers reads for any token, so a token without write access only fails on the
  // first write — and GitHub reports that as 404 Not Found. Explain what to fix instead.
  const WRITE_HELP = `이 토큰으로는 저장소에 쓸 수 없어요. (GitHub 응답: Not Found)
공개 저장소라 읽기는 되지만, 저장·삭제에는 쓰기 권한이 있어야 해요. 다음을 확인해 주세요.
• Fine-grained token: Repository access에 ${REPO.split('/')[1]}가 선택돼 있고, Permissions의 Contents가 "Read and write"인지 (Read-only면 안 돼요)
• Classic token: public_repo 또는 repo 범위가 체크돼 있는지
• 토큰을 만든 계정이 ${REPO.split('/')[0]}인지
권한을 고친 뒤 토큰을 다시 넣어 주세요. (Fine-grained token은 권한만 바꾸면 같은 토큰을 그대로 써도 돼요.)`;

  async function gh(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28',
                 ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      cache: 'no-store',
    });
    if (!res.ok) {
      let msg = ''; try { msg = (await res.json()).message || ''; } catch (_) {}
      const write = (opts.method || 'GET') !== 'GET';
      const e = new Error(
        res.status === 401 ? '토큰이 올바르지 않거나 만료되었습니다.' :
        write && (res.status === 403 || res.status === 404) ? WRITE_HELP :
        res.status === 403 || res.status === 404 ? `권한이 없습니다. 토큰에 ${REPO} 저장소의 Contents: Read and write 권한이 있는지 확인해 주세요. (${msg})` :
        res.status === 409 || res.status === 422 ? `저장소가 그 사이 바뀌었습니다. 새로고침 후 다시 시도해 주세요. (${msg})` :
        `GitHub API 오류 ${res.status}: ${msg}`);
      e.status = res.status; e.noWrite = write && (res.status === 403 || res.status === 404); throw e;
    }
    return res.status === 204 ? null : res.json();
  }

  // proves write access up front by creating a tiny unreferenced blob (harmless; GitHub garbage-collects it)
  async function checkWrite() {
    await gh(`/repos/${REPO}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: 'archive write check', encoding: 'utf-8' }) });
  }

  async function readData(ref = BRANCH) {
    const f = await gh(`/repos/${REPO}/contents/${DATA_PATH}?ref=${encodeURIComponent(ref)}`);
    return { sha: f.sha, list: parseData(b64ToText(f.content)) };
  }

  // one atomic commit: files = [{ path, b64 }] to write, del = [path] to remove
  async function commit(message, nextItems, files = [], del = []) {
    const ref = await gh(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
    const head = ref.object.sha;
    const headCommit = await gh(`/repos/${REPO}/git/commits/${head}`);
    const remote = await gh(`/repos/${REPO}/contents/${DATA_PATH}?ref=${head}`);
    if (remote.sha !== dataSha) {
      const e = new Error('다른 곳에서 아카이브가 수정되었습니다. 최신 내용을 불러왔으니 다시 시도해 주세요.');
      e.conflict = true; throw e;
    }
    const all = [{ path: DATA_PATH, b64: textToB64(serialize(nextItems)) }, ...files];
    const tree = [];
    for (const f of all) {
      const blob = await gh(`/repos/${REPO}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: f.b64, encoding: 'base64' }) });
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newDataSha = tree[0].sha;
    for (const p of del) tree.push({ path: p, mode: '100644', type: 'blob', sha: null });
    const t = await gh(`/repos/${REPO}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }) });
    const c = await gh(`/repos/${REPO}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: t.sha, parents: [head] }) });
    await gh(`/repos/${REPO}/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: c.sha }) });
    dataSha = newDataSha;
    items = nextItems;
    return c;
  }

  async function listFilesUnder(prefix) {
    const ref = await gh(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
    const c = await gh(`/repos/${REPO}/git/commits/${ref.object.sha}`);
    const t = await gh(`/repos/${REPO}/git/trees/${c.tree.sha}?recursive=1`);
    return t.tree.filter(e => e.type === 'blob' && e.path.startsWith(prefix)).map(e => e.path);
  }

  async function refresh(focusHref) {
    const d = await readData();
    dataSha = d.sha; items = d.list;
    applyItems(focusHref);
  }
  function applyItems(focusHref) {
    A.setItems(items.map(i => previews[i.href] ? { ...i, _preview: previews[i.href] } : i), focusHref);
  }

  /* ── images ─────────────────────────────── */
  function loadImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('이미지를 읽을 수 없습니다.')); };
      img.src = url;
    });
  }
  // 960×540 JPEG, cropped from the top like the covers show it
  async function makeThumb(file) {
    const img = await loadImage(file);
    const W = 960, H = 540, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d'); const s = Math.max(W / img.width, H / img.height);
    const w = img.width * s, h = img.height * s;
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    g.drawImage(img, (W - w) / 2, 0, w, h);
    return cv.toDataURL('image/jpeg', .86);
  }
  // typographic cover for artifacts without a screenshot
  async function autoThumb(it) {
    try { await Promise.race([document.fonts.load('700 60px "Pretendard Variable"'), new Promise(r => setTimeout(r, 1500))]); } catch (_) {}
    const W = 960, H = 540, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    let hash = 0; for (const ch of it.type + it.title) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const hue = hash % 360;
    const grd = g.createLinearGradient(0, 0, W, H);
    grd.addColorStop(0, `hsl(${hue} 40% 94%)`); grd.addColorStop(1, `hsl(${(hue + 40) % 360} 45% 86%)`);
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    const font = '"Pretendard Variable", Pretendard, system-ui, sans-serif';
    g.fillStyle = `hsl(${hue} 45% 38%)`; g.font = `600 22px ${font}`; g.fillText(it.type, 64, 88);
    g.fillStyle = '#16141a'; g.font = `700 60px ${font}`;
    const words = it.title.split(/(\s+)/); let line = '', y = 170; const lines = [];
    for (const w of words) { const t = line + w; if (g.measureText(t).width > W - 128 && line.trim()) { lines.push(line.trim()); line = w.trimStart(); } else line = t; }
    lines.push(line.trim());
    lines.slice(0, 4).forEach((l, k) => g.fillText(l, 64, y + k * 74));
    g.fillStyle = 'rgba(22,20,26,.5)'; g.font = `500 22px "JetBrains Mono", ui-monospace, monospace`; g.fillText(it.date, 64, H - 64);
    return cv.toDataURL('image/jpeg', .86);
  }
  const dataUrlB64 = u => u.slice(u.indexOf(',') + 1);
  const fileB64 = async f => bytesToB64(new Uint8Array(await f.arrayBuffer()));

  /* ── dialogs ────────────────────────────── */
  function dialog(html) {
    const d = document.createElement('dialog'); d.className = 'adm-dialog';
    d.innerHTML = html; document.body.appendChild(d);
    const nativeClose = d.close.bind(d);
    d.close = () => { if (d.open) nativeClose(); d.remove(); };
    d.addEventListener('close', () => d.remove());
    d.addEventListener('click', e => { if (e.target === d) d.close(); });
    d.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => d.close()));
    d.showModal();
    return d;
  }
  async function busy(d, fn) {
    const err = d.querySelector('.adm-err'); err.textContent = '';
    d.setAttribute('aria-busy', 'true');
    try { await fn(); }
    catch (e) {
      err.textContent = e.message || String(e);
      if (e.conflict) { try { await refresh(); } catch (_) {} }
    }
    finally { d.removeAttribute('aria-busy'); }
  }

  /* ── token vault: the token is kept encrypted with a password the owner picks ── */
  const ls = {
    get: k => { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} },
    del: k => { try { localStorage.removeItem(k); } catch (_) {} },
  };
  const ss = {
    get: k => { try { return sessionStorage.getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (_) {} },
    del: k => { try { sessionStorage.removeItem(k); } catch (_) {} },
  };
  const b64 = u8 => bytesToB64(u8);
  const unb64 = t => Uint8Array.from(atob(t), c => c.charCodeAt(0));
  const canCrypt = !!(window.crypto && crypto.subtle && window.isSecureContext);
  function readVault() { try { const v = JSON.parse(ls.get(VAULT_KEY) || 'null'); return v && v.ct ? v : null; } catch (_) { return null; } }
  async function deriveKey(pw, salt, iter) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function sealToken(tok, pw) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pw, salt, PBKDF2_ITER);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(tok)));
    ls.set(VAULT_KEY, JSON.stringify({ v: 1, iter: PBKDF2_ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct), fails: 0 }));
  }
  async function openVault(pw) {
    const v = readVault(); if (!v) throw new Error('저장된 토큰이 없습니다.');
    try {
      const key = await deriveKey(pw, unb64(v.salt), v.iter || PBKDF2_ITER);
      const tok = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(v.iv) }, key, unb64(v.ct)));
      if (v.fails) { v.fails = 0; ls.set(VAULT_KEY, JSON.stringify(v)); }
      return tok;
    } catch (_) {
      v.fails = (v.fails || 0) + 1;
      if (v.fails >= MAX_FAILS) { ls.del(VAULT_KEY); const e = new Error(`패스워드를 ${MAX_FAILS}번 틀려서 이 기기에 저장된 토큰을 지웠어요. 토큰을 다시 넣어 주세요.`); e.wiped = true; throw e; }
      ls.set(VAULT_KEY, JSON.stringify(v));
      throw new Error(`패스워드가 맞지 않아요. (${MAX_FAILS - v.fails}번 남음)`);
    }
  }
  function forgetAll() { ls.del(VAULT_KEY); ls.del(TOKEN_KEY); ss.del(TOKEN_KEY); }
  function checkNewPw(f) {
    const pw = f.elements.pw.value, pw2 = f.elements.pw2.value;
    if (pw.length < MIN_PW) throw new Error(`패스워드는 ${MIN_PW}자 이상으로 정해 주세요. 단어 몇 개를 이은 문장이면 기억하기 쉽고 안전해요.`);
    if (pw !== pw2) throw new Error('패스워드 확인이 일치하지 않아요.');
    return pw;
  }
  const pwFields = `
          <label class="adm-field"><span>새 패스워드 <b>*</b></span><input type="password" name="pw" autocomplete="new-password" minlength="${MIN_PW}" placeholder="${MIN_PW}자 이상"></label>
          <label class="adm-field"><span>패스워드 확인 <b>*</b></span><input type="password" name="pw2" autocomplete="new-password"></label>
          <p class="adm-field full" style="margin:0"><small>이 패스워드로 토큰을 암호화해 이 기기에만 저장해요. 패스워드는 어디에도 보내지 않아서 잊으면 되찾을 수 없고, 토큰을 다시 넣으면 돼요.</small></p>`;

  async function unlocked(tok, d) {
    token = tok;
    await checkWrite();
    await refresh(A.current && A.current.href);
    ss.set(TOKEN_KEY, token);                // stays usable in this tab until it is closed
    enter(); d && d.close();
  }

  // first time on this device: token + a password to lock it with
  function loginDialog(msg) {
    const d = dialog(`
      <form method="dialog">
        <div class="adm-head"><h3>관리 모드</h3>
          <p>아티팩트를 추가·수정·삭제하면 <b>${REPO}</b> 저장소에 바로 커밋됩니다. 이 저장소에 쓰기 권한이 있는 GitHub 토큰이 필요해요. 이 기기에서는 한 번만 넣고, 다음부터는 패스워드로 열 수 있어요.</p></div>
        <div class="adm-body">
          <label class="adm-field full"><span>GitHub 토큰 <b>*</b></span>
            <input type="password" name="token" autocomplete="off" required placeholder="github_pat_…">
            <small><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Fine-grained token 만들기 ↗</a> — Repository access는 <b>${REPO.split('/')[1]}</b>만, Permissions는 <b>Contents: Read and write</b>를 주세요. 방문자 제출을 승인·거절할 때 이슈도 자동으로 닫으려면 <b>Issues: Read and write</b>도 추가해요.</small>
          </label>
          <label class="adm-check full"><input type="checkbox" name="remember" ${canCrypt ? 'checked' : 'disabled'}> 이 기기에 패스워드로 잠가 저장하기${canCrypt ? ' (공용 컴퓨터라면 끄세요. 끄면 이 탭을 닫을 때까지만 써요)' : ' — 이 브라우저는 암호화를 지원하지 않아 이번 탭에서만 써요'}</label>
          <div class="pw-wrap adm-body" style="padding:0;grid-column:1/-1">${pwFields}</div>
          <p class="adm-err">${msg ? esc(msg) : ''}</p>
        </div>
        <div class="adm-foot"><button type="button" class="pill" data-close>취소</button><button type="submit" class="pill primary">시작하기</button></div>
      </form>`);
    const f = d.querySelector('form'), wrap = d.querySelector('.pw-wrap');
    const sync = () => { wrap.style.display = f.elements.remember.checked ? '' : 'none'; };
    f.elements.remember.addEventListener('change', sync); sync();
    f.addEventListener('submit', e => {
      e.preventDefault();
      busy(d, async () => {
        const tok = f.elements.token.value.trim();
        if (!tok) throw new Error('토큰을 입력해 주세요.');
        const pw = f.elements.remember.checked ? checkNewPw(f) : null;
        await unlocked(tok, null);
        ls.del(TOKEN_KEY);
        if (pw) { await sealToken(token, pw); toast('관리 모드를 켰습니다. 다음부터는 패스워드로 열 수 있어요.'); }
        else { ls.del(VAULT_KEY); toast('관리 모드를 켰습니다. 이 탭을 닫으면 토큰은 사라져요.'); }
        d.close();
      }).catch(() => {});
    });
    return d;
  }

  // saved on this device: just the password
  function unlockDialog(msg) {
    const d = dialog(`
      <form method="dialog">
        <div class="adm-head"><h3>관리 모드</h3><p>이 기기에 저장해 둔 토큰을 패스워드로 엽니다.</p></div>
        <div class="adm-body">
          <label class="adm-field full"><span>패스워드</span><input type="password" name="pw" autocomplete="current-password" required autofocus></label>
          <p class="adm-field full" style="margin:0"><small><a href="#" data-forget>패스워드를 잊었어요 · 다른 토큰 쓰기</a> — 저장된 토큰을 지우고 토큰을 다시 넣어요.</small></p>
          <p class="adm-err">${msg ? esc(msg) : ''}</p>
        </div>
        <div class="adm-foot"><button type="button" class="pill" data-close>취소</button><button type="submit" class="pill primary">열기</button></div>
      </form>`);
    const f = d.querySelector('form');
    d.querySelector('[data-forget]').addEventListener('click', e => { e.preventDefault(); forgetAll(); d.close(); loginDialog(); });
    f.addEventListener('submit', e => {
      e.preventDefault();
      busy(d, async () => {
        let tok;
        try { tok = await openVault(f.elements.pw.value); }
        catch (err) { if (err.wiped) { d.close(); loginDialog(err.message); return; } f.elements.pw.select(); throw err; }
        try { await unlocked(tok, d); toast('관리 모드를 켰습니다.'); }
        catch (err) {
          // the password was right but the token no longer works (expired, revoked, permissions changed)
          if (err.status === 401 || err.noWrite) { forgetAll(); d.close(); loginDialog(err.message + '\n저장돼 있던 토큰을 지웠어요. 새 토큰을 넣어 주세요.'); return; }
          throw err;
        }
      }).catch(() => {});
    });
    return d;
  }

  // an older version kept the token in plain text on this device: lock it with a password now
  function migrateDialog(legacy) {
    const d = dialog(`
      <form method="dialog">
        <div class="adm-head"><h3>패스워드 설정</h3><p>이 기기에 토큰이 <b>암호화 없이</b> 저장돼 있어요. 패스워드를 정하면 토큰을 암호화해서 다시 저장하고, 다음부터는 패스워드로 열어요.</p></div>
        <div class="adm-body">${pwFields}<p class="adm-err"></p></div>
        <div class="adm-foot"><button type="button" class="pill" data-skip>저장하지 않고 이번만 쓰기</button><button type="submit" class="pill primary">패스워드로 잠그기</button></div>
      </form>`);
    const f = d.querySelector('form');
    d.querySelector('[data-skip]').addEventListener('click', () => busy(d, async () => {
      ls.del(TOKEN_KEY); await unlocked(legacy, d); toast('관리 모드를 켰습니다. 이 탭을 닫으면 토큰은 사라져요.');
    }).catch(() => {}));
    f.addEventListener('submit', e => {
      e.preventDefault();
      busy(d, async () => {
        const pw = checkNewPw(f);
        await unlocked(legacy, null);
        await sealToken(token, pw); ls.del(TOKEN_KEY);
        d.close(); toast('토큰을 패스워드로 잠갔어요. 다음부터는 패스워드로 열 수 있어요.');
      }).catch(() => {});
    });
    return d;
  }

  const TYPES = () => [...new Set(items.map(i => i.type))];

  // opts.prefill: field values for a new item (e.g. from a visitor submission)
  // opts.heading: dialog title; opts.onSaved(next): runs after a successful commit
  function itemDialog(orig, opts = {}) {
    const isNew = !orig;
    const it = orig || { href: '', title: '', desc: '', type: '', tags: [], date: today(), thumb: '', ...opts.prefill };
    const pathFirst = !isNew || !!it.href;
    const local = isLocal(it.href);
    const d = dialog(`
      <form method="dialog" novalidate>
        <div class="adm-head"><h3>${esc(opts.heading || (isNew ? '새 아티팩트' : '아티팩트 수정'))}</h3>
          <p>저장하면 커밋 하나로 저장소에 올라가고, 사이트에는 1~2분 뒤 반영됩니다.</p></div>
        <div class="adm-body">
          <label class="adm-field full"><span>제목 <b>*</b></span><input type="text" name="title" required value="${esc(it.title)}"></label>
          <label class="adm-field"><span>종류 <b>*</b></span><input type="text" name="type" list="adm-types" required value="${esc(it.type)}" placeholder="기획서, 슬라이드…">
            <datalist id="adm-types">${TYPES().map(t => `<option value="${esc(t)}">`).join('')}</datalist></label>
          <label class="adm-field"><span>날짜 <b>*</b></span><input type="date" name="date" required value="${esc(it.date)}"></label>
          <label class="adm-field full"><span>설명</span><textarea name="desc">${esc(it.desc)}</textarea></label>
          <label class="adm-field full"><span>태그</span><input type="text" name="tags" value="${esc(it.tags.join(', '))}" placeholder="쉼표로 구분"></label>

          <div class="adm-field full"><span>페이지</span>
            <div class="adm-seg" role="radiogroup">
              <label><input type="radio" name="src" value="upload" ${pathFirst ? '' : 'checked'}>HTML 파일 올리기</label>
              <label><input type="radio" name="src" value="path" ${pathFirst ? 'checked' : ''}>경로·URL 입력</label>
            </div>
          </div>
          <div class="adm-field full" data-src="upload">
            <input type="file" name="html" accept=".html,.htm,text/html">
            <small>${isNew ? '<b>폴더 이름</b> 아래 <code>index.html</code>로 저장됩니다.' : local ? `<code>${esc(it.href.endsWith('/') ? it.href + 'index.html' : it.href)}</code> 파일을 새 파일로 교체합니다.` : ''} 이미지·스크립트가 따로 있는 여러 파일짜리 페이지는 git으로 올려 주세요.</small>
          </div>
          ${isNew ? `<label class="adm-field full" data-src="upload"><span>폴더 이름 <b>*</b></span><input type="text" name="slug" value="a-${today().replace(/-/g, '')}-${randId()}" pattern="[a-z0-9][a-z0-9-]*"><small>영문 소문자·숫자·하이픈. 주소가 <code>…/artifactarchives/폴더이름/</code>이 됩니다.</small></label>` : ''}
          <label class="adm-field full" data-src="path"><span>경로 또는 URL <b>*</b></span><input type="text" name="href" value="${esc(it.href)}" placeholder="llm-guide/ 또는 https://…"><small>저장소 안의 경로(예: <code>plans/p-xxxx/</code>)나 외부 주소.</small></label>

          <div class="adm-field full"><span>썸네일</span>
            <div class="adm-thumb">
              <img id="adm-prev" alt="" src="${esc(previews[it.href] || it.thumb || '')}" ${it.thumb || previews[it.href] ? '' : 'hidden'}>
              <div class="adm-field"><input type="file" name="thumb" accept="image/*">
                <small>${isNew ? '비워 두면 제목으로 표지를 자동으로 만듭니다.' : '새 이미지를 고르면 교체합니다.'} 960×540으로 줄여서 저장해요.</small></div>
            </div>
          </div>
          <p class="adm-err"></p>
        </div>
        <div class="adm-foot"><button type="button" class="pill" data-close>취소</button><button type="submit" class="pill primary">${isNew ? '추가' : '저장'}</button></div>
      </form>`);
    const f = d.querySelector('form');
    const syncSrc = () => d.querySelectorAll('[data-src]').forEach(el => el.hidden = el.dataset.src !== f.elements.src.value);
    f.addEventListener('change', e => {
      if (e.target.name === 'src') syncSrc();
      if (e.target.name === 'thumb' && f.elements.thumb.files[0]) {
        const p = $('adm-prev'); p.hidden = false; p.src = URL.createObjectURL(f.elements.thumb.files[0]);
      }
    });
    syncSrc();

    f.addEventListener('submit', e => {
      e.preventDefault();
      busy(d, async () => {
        const v = k => f.elements[k].value.trim();
        if (!v('title')) throw new Error('제목을 입력해 주세요.');
        if (!v('type')) throw new Error('종류를 입력해 주세요.');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v('date'))) throw new Error('날짜를 입력해 주세요.');
        const next = {
          href: it.href, title: v('title'), desc: v('desc'), type: v('type'),
          tags: v('tags').split(/[,，]/).map(s => s.trim().replace(/^#/, '')).filter(Boolean),
          date: v('date'), thumb: it.thumb,
        };
        const files = [];
        const htmlFile = f.elements.html.files[0];

        if (f.elements.src.value === 'upload') {
          if (isNew) {
            const slug = v('slug');
            if (!slugOk(slug)) throw new Error('폴더 이름은 영문 소문자·숫자·하이픈만 쓸 수 있어요.');
            if (!htmlFile) throw new Error('올릴 HTML 파일을 골라 주세요.');
            if (items.some(i => i.href === slug + '/')) throw new Error('같은 폴더 이름이 이미 있어요.');
            const existing = await listFilesUnder(slug + '/');
            if (existing.length) throw new Error(`저장소에 ${slug}/ 폴더가 이미 있어요. 다른 이름을 써 주세요.`);
            next.href = slug + '/';
            files.push({ path: slug + '/index.html', b64: await fileB64(htmlFile) });
          } else if (htmlFile) {
            if (!local) throw new Error('외부 주소로 연결된 항목에는 파일을 올릴 수 없어요. 경로·URL을 저장소 경로로 바꿔 주세요.');
            files.push({ path: it.href.endsWith('/') ? it.href + 'index.html' : it.href, b64: await fileB64(htmlFile) });
          }
        } else {
          const h = v('href');
          if (!h) throw new Error('경로 또는 URL을 입력해 주세요.');
          if (!safeHref(h)) throw new Error('저장소 안의 상대 경로나 http(s) 주소만 쓸 수 있어요.');
          if (h !== it.href && items.some(i => i.href === h)) throw new Error('같은 경로를 쓰는 아티팩트가 이미 있어요.');
          next.href = h;
        }

        // thumbnail
        const base = (next.href.replace(/^https?:\/\//, '').replace(/\/$/, '').split('/').pop() || randId()).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
        let thumbUrl = null;
        if (f.elements.thumb.files[0]) thumbUrl = await makeThumb(f.elements.thumb.files[0]);
        else if (!next.thumb) thumbUrl = await autoThumb(next);
        if (thumbUrl) {
          let path = it.thumb && isLocal(it.thumb) && it.thumb.startsWith('thumbs/') ? it.thumb : `thumbs/${base}.jpg`;
          if (!it.thumb && items.some(i => i.thumb === path)) path = `thumbs/${base}-${randId()}.jpg`;
          next.thumb = path;
          files.push({ path, b64: dataUrlB64(thumbUrl) });
        }

        const nextItems = isNew ? [next, ...items] : items.map(i => i === orig ? next : i);
        await commit(`${isNew ? 'Add' : 'Update'} artifact: ${next.title}`, nextItems, files);
        if (thumbUrl) previews[next.href] = thumbUrl;
        if (orig && orig.href !== next.href) delete previews[orig.href];
        applyItems(next.href);
        d.close();
        toast(`${isNew ? '추가' : '저장'}했습니다. 사이트에는 1~2분 뒤 반영돼요.`, 4200);
        if (opts.onSaved) opts.onSaved(next);
      }).catch(() => {});
    });
  }

  async function deleteDialog(it) {
    const local = isLocal(it.href);
    // the files that only this artifact uses: its folder (or single file) and its thumbnail
    let own = [];
    if (local) {
      const prefix = it.href.endsWith('/') ? it.href : null;
      const shared = items.some(i => i !== it && (prefix ? i.href.startsWith(prefix) || (i.thumb || '').startsWith(prefix) : i.href === it.href));
      if (!shared && prefix && prefix.split('/').filter(Boolean).length >= 1) {
        try { own = await listFilesUnder(prefix); } catch (_) { own = []; }
      } else if (!shared && !prefix) own = [it.href];
    }
    if (it.thumb && isLocal(it.thumb) && !items.some(i => i !== it && i.thumb === it.thumb)) own.push(it.thumb);
    const d = dialog(`
      <form method="dialog">
        <div class="adm-head"><h3>아티팩트 삭제</h3>
          <p><b>${esc(it.title)}</b>을(를) 아카이브에서 지우고, 이 항목의 페이지·썸네일 파일도 저장소에서 함께 삭제합니다.</p></div>
        <div class="adm-body">
          ${own.length ? `<p class="adm-check full" style="margin:0">함께 삭제되는 파일 ${own.length}개</p>
          <ul class="adm-list full">${own.slice(0, 12).map(p => `<li>${esc(p)}</li>`).join('')}${own.length > 12 ? `<li>… 외 ${own.length - 12}개</li>` : ''}</ul>` : ''}
          <p class="adm-err"></p>
        </div>
        <div class="adm-foot"><button type="button" class="pill" data-close>취소</button><button type="submit" class="pill danger">삭제</button></div>
      </form>`);
    const f = d.querySelector('form');
    f.addEventListener('submit', e => {
      e.preventDefault();
      busy(d, async () => {
        const del = own;
        await commit(`Remove artifact: ${it.title}`, items.filter(i => i !== it), [], del);
        delete previews[it.href];
        applyItems();
        d.close();
        toast('삭제했습니다.');
      }).catch(() => {});
    });
  }


  /* ── visitor submissions (GitHub issues labelled "submission") ── */
  const SITE = `https://${REPO.split('/')[0]}.github.io/${REPO.split('/')[1]}/`;
  const ISSUE_HELP = '토큰에 Issues: Read and write 권한을 추가하면 이슈도 자동으로 닫혀요.';
  let pending = [];

  // issue forms render as "### <label>\n\n<value>" blocks
  function parseIssue(body = '') {
    const out = {};
    const parts = body.split(/^###\s+/m).slice(1);
    for (const part of parts) {
      const nl = part.indexOf('\n');
      const key = part.slice(0, nl).trim(), val = part.slice(nl + 1).trim();
      out[key] = val === '_No response_' ? '' : val;
    }
    const url = (out['링크'] || '').split(/\s/)[0];
    return {
      title: (out['제목'] || '').slice(0, 120),
      type: (out['종류'] || '').slice(0, 30),
      url: /^https?:\/\//i.test(url) ? url : '',
      desc: (out['설명'] || '').slice(0, 600),
      tags: (out['태그'] || '').split(/[,，]/).map(t => t.trim().replace(/^#/, '')).filter(Boolean).slice(0, 8),
      author: (out['만든 사람'] || '').slice(0, 60),
    };
  }

  async function loadSubmissions() {
    const list = await gh(`/repos/${REPO}/issues?labels=submission&state=open&per_page=50`);
    pending = list.filter(i => !i.pull_request).map(i => ({ n: i.number, url: i.html_url, by: i.user && i.user.login, at: i.created_at.slice(0, 10), ...parseIssue(i.body) }));
    const badge = document.querySelector('[data-act="queue"] .q-count');
    if (badge) { badge.textContent = pending.length; badge.hidden = !pending.length; }
    return pending;
  }

  async function closeIssue(n, comment, reason) {
    try {
      await gh(`/repos/${REPO}/issues/${n}/comments`, { method: 'POST', body: JSON.stringify({ body: comment }) });
      await gh(`/repos/${REPO}/issues/${n}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: reason }) });
      return true;
    } catch (e) {
      if (e.noWrite) { toast('이슈를 닫지 못했어요. ' + ISSUE_HELP, 6000); return false; }
      throw e;
    }
  }

  async function queueDialog() {
    const d = dialog(`
      <form method="dialog">
        <div class="adm-head"><h3>제출 검토</h3>
          <p>방문자가 제안한 아티팩트예요. 링크를 열어 확인한 뒤 승인하면 아카이브에 올라가고, 제출 이슈가 닫혀요.</p></div>
        <div class="adm-body"><div class="adm-queue full"><p class="adm-muted">불러오는 중…</p></div><p class="adm-err"></p></div>
        <div class="adm-foot"><a class="pill" href="https://github.com/${REPO}/issues?q=is%3Aissue+label%3Asubmission" target="_blank" rel="noopener">GitHub에서 보기 ↗</a><button type="button" class="pill" data-close>닫기</button></div>
      </form>`);
    const box = d.querySelector('.adm-queue'), err = d.querySelector('.adm-err');
    const render = () => {
      box.innerHTML = pending.length ? pending.map(p => `
        <div class="adm-sub" data-n="${p.n}">
          <div class="adm-sub-meta mono">#${p.n} · ${esc(p.at)} · ${esc(p.by || '')}${p.type ? ' · ' + esc(p.type) : ''}</div>
          <div class="adm-sub-title">${esc(p.title || '(제목 없음)')}</div>
          ${p.url ? `<a class="adm-sub-link" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url)} ↗</a>` : '<div class="adm-err">링크가 올바르지 않아요</div>'}
          ${p.desc ? `<p class="adm-sub-desc">${esc(p.desc)}</p>` : ''}
          <div class="adm-sub-actions">
            <a class="pill" href="${esc(p.url ? `https://github.com/${REPO}/issues/${p.n}` : '#')}" target="_blank" rel="noopener">이슈 ↗</a>
            <button type="button" class="pill danger-ghost" data-q="reject">거절</button>
            <button type="button" class="pill primary" data-q="approve" ${p.url ? '' : 'disabled'}>승인…</button>
          </div>
        </div>`).join('') : '<p class="adm-muted">검토할 제출이 없어요.</p>';
    };
    try { await loadSubmissions(); render(); } catch (e) { box.innerHTML = ''; err.textContent = e.message; }

    box.addEventListener('click', async e => {
      const b = e.target.closest('[data-q]'); if (!b) return;
      const p = pending.find(x => x.n === +b.closest('.adm-sub').dataset.n); if (!p) return;
      if (b.dataset.q === 'approve') {
        d.close();
        itemDialog(null, {
          heading: `제출 승인 · #${p.n}`,
          prefill: { title: p.title, type: p.type, desc: p.desc, tags: p.tags, href: p.url, date: today() },
          onSaved: async () => {
            const ok = await closeIssue(p.n, `감사합니다! 아카이브에 게시했어요 → ${SITE}`, 'completed').catch(() => false);
            await loadSubmissions().catch(() => {});
            if (ok) toast(`#${p.n} 제출을 게시하고 이슈를 닫았어요.`, 4200);
          },
        });
      } else {
        if (!confirm(`#${p.n} "${p.title}" 제출을 거절할까요? 이슈에 안내 댓글을 남기고 닫아요.`)) return;
        b.disabled = true; err.textContent = '';
        try {
          await closeIssue(p.n, '검토해 주셔서 감사해요. 이번에는 아카이브에 싣지 않기로 했어요.', 'not_planned');
          await loadSubmissions(); render(); toast(`#${p.n} 제출을 거절했어요.`);
        } catch (er) { err.textContent = er.message; b.disabled = false; }
      }
    });
  }

  /* ── admin chrome ───────────────────────── */
  const bar = document.createElement('div');
  bar.className = 'admin-only'; bar.style.cssText = 'gap:8px;align-items:center';
  bar.innerHTML = `<span class="adm-badge adm-bar-label">관리 모드</span>
    <button type="button" class="pill" data-act="queue" title="방문자 제출 검토">제출 <span class="q-count" hidden>0</span></button>
    <button type="button" class="pill primary" data-act="add">+ 추가</button>
    <button type="button" class="pill" data-act="logout" title="관리 모드 끄기">종료</button>`;
  document.querySelector('.actions').prepend(bar);

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b || !document.body.classList.contains('admin')) return;
    const act = b.dataset.act;
    if (act === 'add') itemDialog();
    else if (act === 'queue') queueDialog();
    else if (act === 'logout') leave();
    else {
      const it = items.find(i => i.href === b.dataset.href); if (!it) return;
      act === 'edit' ? itemDialog(it) : deleteDialog(it);
    }
  });

  function enter() { document.body.classList.add('admin'); loadSubmissions().catch(() => {}); }
  function leave() {
    ss.del(TOKEN_KEY); ls.del(TOKEN_KEY);
    token = ''; document.body.classList.remove('admin');
    toast(readVault() ? '관리 모드를 껐습니다. 다음엔 패스워드로 열 수 있어요.' : '관리 모드를 껐습니다. 토큰은 이 브라우저에서 지웠어요.');
  }

  async function open() {
    if (document.body.classList.contains('admin') || opening || document.querySelector('dialog.adm-dialog[open]')) return;
    opening = true;
    try { await openFlow(); } finally { opening = false; }
  }
  let opening = false;
  async function openFlow() {
    const session = ss.get(TOKEN_KEY), legacy = ls.get(TOKEN_KEY);
    if (session) {                                   // already unlocked in this tab
      try { await unlocked(session, null); return; }
      catch (e) { ss.del(TOKEN_KEY); if (e.status === 401 || e.noWrite) { forgetAll(); return loginDialog(e.message); } }
    }
    if (legacy && canCrypt) return migrateDialog(legacy);
    if (legacy) { ls.del(TOKEN_KEY); try { await unlocked(legacy, null); return; } catch (e) { return loginDialog(e.message); } }
    if (readVault() && canCrypt) return unlockDialog();
    return loginDialog();
  }

  window.ArchiveAdmin = { open };
  open();
})();
