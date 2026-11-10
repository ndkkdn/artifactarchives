/* Artifact Archives — 관리 모드 (추가·수정·삭제)
 *
 * GitHub Pages는 정적 호스팅이라 서버가 없습니다. 그래서 이 스크립트는 브라우저에서
 * GitHub API로 저장소에 직접 커밋합니다. 한 번 저장하면 items.js와 올린 파일들이
 * 커밋 하나로 묶여 main 브랜치에 들어가고, Pages가 1~2분 안에 다시 배포합니다.
 *
 * 필요한 것: 이 저장소에 대한 Fine-grained token (Contents: Read and write).
 * 토큰은 이 브라우저(localStorage 또는 sessionStorage)에만 저장되고 GitHub API 외에는 보내지 않습니다.
 */
(() => {
  const REPO = 'ndkkdn/artifactarchives';
  const BRANCH = 'main';
  const DATA_PATH = 'items.js';
  const TOKEN_KEY = 'archive-gh-token';
  const API = 'https://api.github.com';

  const A = window.Archive;
  const esc = A.esc;
  const $ = id => document.getElementById(id);
  let token = '';
  let dataSha = '';          // blob sha of items.js we last read — used to detect edits made elsewhere
  let items = A.items.slice();
  const previews = {};       // href -> data URL, so freshly uploaded thumbnails show before Pages redeploys

  /* ── styles ─────────────────────────────── */
  const css = document.createElement('style');
  css.textContent = `
    .adm-dialog { border: 0; padding: 0; border-radius: 14px; background: var(--surface); color: var(--text); width: min(620px, calc(100vw - 32px)); max-height: calc(100dvh - 32px);
      box-shadow: 0 40px 80px -20px rgba(0,0,0,.45); }
    .adm-dialog::backdrop { background: rgba(10,10,12,.45); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
    .adm-dialog form { display: flex; flex-direction: column; max-height: calc(100dvh - 32px); }
    .adm-head { padding: 22px 24px 6px; }
    .adm-head h3 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -.02em; }
    .adm-head p { margin: 6px 0 0; color: var(--text-60); font-size: 13px; line-height: 1.55; }
    .adm-body { padding: 14px 24px 8px; overflow-y: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .adm-body .full { grid-column: 1 / -1; }
    .adm-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .adm-field > span { font-size: 12px; font-weight: 500; color: var(--text-60); }
    .adm-field > span b { color: var(--accent); font-weight: 600; }
    .adm-field small { font-size: 12px; color: var(--text-40); line-height: 1.45; }
    .adm-field input[type=text], .adm-field input[type=date], .adm-field input[type=password], .adm-field textarea {
      font: inherit; font-size: 15px; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; width: 100%; min-width: 0; }
    .adm-field textarea { min-height: 84px; resize: vertical; line-height: 1.5; }
    .adm-field input:focus, .adm-field textarea:focus { outline: 0; border-color: var(--text); }
    .adm-field input[type=file] { font: inherit; font-size: 13px; color: var(--text-60); }
    .adm-seg { display: flex; gap: 4px; background: var(--bg); border-radius: 999px; padding: 3px; width: max-content; max-width: 100%; }
    .adm-seg label { padding: 6px 12px; border-radius: 999px; font-size: 13px; font-weight: 500; cursor: pointer; color: var(--text-60); }
    .adm-dialog [hidden] { display: none !important; }
    .adm-seg label { position: relative; }
    .adm-seg input { position: absolute; opacity: 0; pointer-events: none; }
    .adm-seg label:has(input:checked) { background: var(--text); color: var(--bg); }
    .adm-thumb { display: flex; gap: 14px; align-items: center; }
    .adm-thumb img { width: 160px; aspect-ratio: 16/9; object-fit: cover; object-position: top center; border-radius: 6px; background: var(--bg-2); flex: none; }
    .adm-check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; color: var(--text-60); line-height: 1.5; }
    .adm-check input { margin-top: 3px; }
    .adm-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 24px 20px; border-top: 1px solid var(--line); margin-top: 8px; }
    .adm-foot .pill { height: 38px; padding: 0 18px; font-size: 14px; }
    .adm-foot .pill.danger { background: #d93a1b; color: #fff; }
    .adm-err { grid-column: 1 / -1; color: #d93a1b; font-size: 13px; line-height: 1.5; margin: 0; }
    .adm-err:empty { display: none; }
    .adm-list { margin: 0; padding-left: 18px; font-size: 12.5px; color: var(--text-60); line-height: 1.7; font-family: "JetBrains Mono", monospace; word-break: break-all; }
    .adm-badge { font-size: 11px; font-weight: 600; color: var(--accent); white-space: nowrap; }
    .adm-toast { position: fixed; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom, 0px)); transform: translate(-50%, 20px); z-index: 60; opacity: 0;
      background: var(--text); color: var(--bg); padding: 12px 18px; border-radius: 999px; font-size: 13px; font-weight: 500; transition: opacity .3s, transform .3s;
      max-width: calc(100vw - 32px); text-align: center; pointer-events: none; }
    .adm-toast.show { opacity: 1; transform: translate(-50%, 0); }
    .adm-dialog[aria-busy="true"] .adm-foot .pill { opacity: .5; pointer-events: none; }
    @media (max-width: 620px) {
      .adm-body { grid-template-columns: 1fr; }
      .adm-thumb { flex-direction: column; align-items: flex-start; }
      .adm-bar-label { display: none; }
    }`;
  document.head.appendChild(css);

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
  async function gh(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28',
                 ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      cache: 'no-store',
    });
    if (!res.ok) {
      let msg = ''; try { msg = (await res.json()).message || ''; } catch (_) {}
      const e = new Error(
        res.status === 401 ? '토큰이 올바르지 않거나 만료되었습니다.' :
        res.status === 403 || res.status === 404 ? `권한이 없습니다. 토큰에 ${REPO} 저장소의 Contents: Read and write 권한이 있는지 확인해 주세요. (${msg})` :
        res.status === 409 || res.status === 422 ? `저장소가 그 사이 바뀌었습니다. 새로고침 후 다시 시도해 주세요. (${msg})` :
        `GitHub API 오류 ${res.status}: ${msg}`);
      e.status = res.status; throw e;
    }
    return res.status === 204 ? null : res.json();
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

  function loginDialog() {
    const d = dialog(`
      <form method="dialog">
        <div class="adm-head"><h3>관리 모드</h3>
          <p>아티팩트를 추가·수정·삭제하면 <b>${REPO}</b> 저장소에 바로 커밋됩니다. 이 저장소에 쓰기 권한이 있는 GitHub 토큰이 필요해요.</p></div>
        <div class="adm-body">
          <label class="adm-field full"><span>GitHub 토큰 <b>*</b></span>
            <input type="password" name="token" autocomplete="off" required placeholder="github_pat_…">
            <small><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Fine-grained token 만들기 ↗</a> — Repository access는 <b>${REPO.split('/')[1]}</b>만, Permissions는 <b>Contents: Read and write</b>만 주면 됩니다.</small>
          </label>
          <label class="adm-check full"><input type="checkbox" name="remember" checked> 이 브라우저에 기억하기 (공용 컴퓨터라면 끄세요)</label>
          <p class="adm-err"></p>
        </div>
        <div class="adm-foot"><button type="button" class="pill" data-close>취소</button><button type="submit" class="pill primary">시작하기</button></div>
      </form>`);
    const f = d.querySelector('form');
    f.addEventListener('submit', e => {
      e.preventDefault();
      busy(d, async () => {
        token = f.elements.token.value.trim();
        const r = await gh(`/repos/${REPO}`);
        if (r.permissions && !r.permissions.push) throw new Error('이 토큰으로는 저장소에 쓸 수 없습니다.');
        await refresh(A.current && A.current.href);
        try { (f.elements.remember.checked ? localStorage : sessionStorage).setItem(TOKEN_KEY, token); } catch (_) {}
        enter(); d.close(); toast('관리 모드를 켰습니다.');
      }).catch(() => {});
    });
  }

  const TYPES = () => [...new Set(items.map(i => i.type))];

  function itemDialog(orig) {
    const isNew = !orig;
    const it = orig || { href: '', title: '', desc: '', type: '', tags: [], date: today(), thumb: '' };
    const local = isLocal(it.href);
    const d = dialog(`
      <form method="dialog" novalidate>
        <div class="adm-head"><h3>${isNew ? '새 아티팩트' : '아티팩트 수정'}</h3>
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
              <label><input type="radio" name="src" value="upload" ${isNew ? 'checked' : ''}>HTML 파일 올리기</label>
              <label><input type="radio" name="src" value="path" ${isNew ? '' : 'checked'}>경로·URL 입력</label>
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
          <p><b>${esc(it.title)}</b>을(를) 아카이브 목록에서 지웁니다. git 기록에는 남아 있어 나중에 되살릴 수 있어요.</p></div>
        <div class="adm-body">
          ${own.length ? `<label class="adm-check full"><input type="checkbox" name="files" checked> 저장소 파일도 함께 삭제 (${own.length}개)</label>
          <ul class="adm-list full">${own.slice(0, 12).map(p => `<li>${esc(p)}</li>`).join('')}${own.length > 12 ? `<li>… 외 ${own.length - 12}개</li>` : ''}</ul>` : ''}
          <p class="adm-err"></p>
        </div>
        <div class="adm-foot"><button type="button" class="pill" data-close>취소</button><button type="submit" class="pill danger">삭제</button></div>
      </form>`);
    const f = d.querySelector('form');
    f.addEventListener('submit', e => {
      e.preventDefault();
      busy(d, async () => {
        const del = own.length && f.elements.files && f.elements.files.checked ? own : [];
        await commit(`Remove artifact: ${it.title}`, items.filter(i => i !== it), [], del);
        delete previews[it.href];
        applyItems();
        d.close();
        toast('삭제했습니다.');
      }).catch(() => {});
    });
  }

  /* ── admin chrome ───────────────────────── */
  const bar = document.createElement('div');
  bar.className = 'admin-only'; bar.style.cssText = 'gap:8px;align-items:center';
  bar.innerHTML = `<span class="adm-badge adm-bar-label">관리 모드</span>
    <button type="button" class="pill primary" data-act="add">+ 추가</button>
    <button type="button" class="pill" data-act="logout" title="관리 모드 끄기">종료</button>`;
  document.querySelector('.actions').prepend(bar);

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b || !document.body.classList.contains('admin')) return;
    const act = b.dataset.act;
    if (act === 'add') itemDialog();
    else if (act === 'logout') leave();
    else {
      const it = items.find(i => i.href === b.dataset.href); if (!it) return;
      act === 'edit' ? itemDialog(it) : deleteDialog(it);
    }
  });

  function enter() { document.body.classList.add('admin'); }
  function leave() {
    try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch (_) {}
    token = ''; document.body.classList.remove('admin');
    toast('관리 모드를 껐습니다. 토큰은 이 브라우저에서 지웠어요.');
  }

  async function open() {
    if (document.body.classList.contains('admin')) return;
    let saved = '';
    try { saved = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || ''; } catch (_) {}
    if (!saved) return loginDialog();
    token = saved;
    try { await refresh(A.current && A.current.href); enter(); }
    catch (e) {
      if (e.status === 401) { try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch (_) {} }
      toast(e.message); loginDialog();
    }
  }

  window.ArchiveAdmin = { open };
  open();
})();
