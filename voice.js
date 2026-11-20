/* Read-aloud for the scroll-type pages (browser speech, no server).
 * - "듣기" in the top bar starts from where the listener stopped last time, or from the paragraph on screen.
 * - Each section heading gets "이 섹션 듣기".
 * - Floating player: previous / play-pause / next paragraph, speed, close.
 * - Reads headings, paragraphs, list items and quotes in order; skips figures, calculators, footnote
 *   numbers, source lists and glossaries. Labels such as "루머·미확인" or "벤더 수치" are read out.
 * - Hidden when the browser has no Korean voice.
 */
(() => {
  const synth = window.speechSynthesis;
  if (!synth || !window.SpeechSynthesisUtterance) return;

  const SKIP_SECTIONS = ['sources', 'glossary', 'index', 'refs'];
  const SKIP_INSIDE = [
    'script', 'style', 'svg', 'canvas', 'nav', 'button', 'form', 'table', 'pre', 'code', 'footer',
    '.topbar', '.toc', '.refs', '.refs-out', '.gloss', 'aside', 'figure', '.fig', '.calc', '.demo',
    '.ch-credit', '.hero-cta', '.meta', '.toc-mobile', '.terms-hint', '[aria-hidden="true"]', '[hidden]', '.vx-skip',
  ].join(',');
  const BLOCKS = 'h1, h2, h3, h4, p, li, blockquote, dt, dd';
  const STRIP = 'sup, svg, button, script, style, .hn, .sr-only, [aria-hidden="true"]';
  const RATES = [0.8, 1, 1.2, 1.5];
  const KEY = 'archive-voice:' + location.pathname;

  // abbreviations a Korean voice tends to stumble over
  const SAY = [
    [/\bR&D\b/g, '알앤디'], [/\bGA\b/g, '지에이'], [/\bUTC\b/g, '유티씨'], [/\+(\d)/g, ' 플러스 $1'], [/\bKST\b/g, '한국 시간'], [/\bvs\.?\b/gi, '대'],
    [/\bAPI\b/g, '에이피아이'], [/\bIPO\b/g, '아이피오'], [/\bLLM\b/g, '엘엘엠'], [/\bSLA\b/g, '에스엘에이'],
    [/\bGPU\b/g, '지피유'], [/\bMoE\b/g, '엠오이'], [/\bKV\b/g, '케이브이'], [/\bRLHF\b/g, '알엘에이치에프'],
    [/\bSFT\b/g, '에스에프티'], [/\bMS\b/g, '마이크로소프트'], [/\be\.g\./gi, '예를 들어'],
    [/(\d)\s*[~–-]\s*(\d)/g, '$1에서 $2'], [/→/g, ', 그 다음 '], [/[·•|]/g, ', '], [/[“”"「」『』《》]/g, ''],
    [/\s*\/\s*/g, ', '], [/&/g, ' 앤 '], [/\s{2,}/g, ' '], [/\s+([,.])/g, '$1'], [/,\s*,/g, ','], [/[,\s]+$/, '']
  ];

  let voice = null, blocks = [], idx = 0, chunks = [], ci = 0, playing = false, rate = 1, ui = null, sectionEnd = -1;
  let userScrollAt = 0;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } },
  };
  rate = +store.get('archive-voice-rate') || 1;

  /* ── Korean voices, best first: neural/online > premium/enhanced > Google > named system voices ── */
  const NOVELTY = /Grandma|Grandpa|Rocko|Eddy|Flo|Reed|Sandy|Shelley|Bad News|Bells|Bubbles|Jester|Organ|Trinoids|Whisper|Zarvox|Superstar|Wobble|Bahh|Boing|Cellos|Junior|Ralph|Fred|Albert|Kathy/i;
  function score(v) {
    const n = v.name;
    if (NOVELTY.test(n)) return -10;
    let s = 0;
    if (/Natural|Neural/i.test(n)) s = 50;
    else if (/Online/i.test(n)) s = 45;
    else if (/Premium|프리미엄/i.test(n)) s = 40;
    else if (/Enhanced|향상/i.test(n)) s = 35;
    else if (/Google/i.test(n)) s = 30;
    else if (/Yuna|Sora|Heami|SunHi|InJoon|Hyunsu|Minsu|Jimin|Seoyeon/i.test(n)) s = 20;
    return s + (v.localService ? 0 : 1);
  }
  function koVoices() {
    const ko = synth.getVoices().filter(v => /^ko/i.test(v.lang)).sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
    const real = ko.filter(v => score(v) >= 0);                  // drop joke voices unless nothing else exists
    return real.length ? real : ko;
  }
  function pickVoice() {
    const ko = koVoices();
    if (!ko.length) return null;
    const saved = store.get('archive-voice-name');
    return ko.find(v => v.voiceURI === saved || v.name === saved) || ko[0];
  }
  const shortName = v => v.name.replace(/^(Microsoft|Google)\s+/i, m => /Google/i.test(m) ? 'Google ' : '').replace(/\s*[-–]\s*(Korean|한국어).*$/i, '').replace(/\s*\((Korean|한국어).*$/i, '').trim();

  /* ── collect what to read ── */
  function textOf(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll(STRIP).forEach(n => n.remove());
    c.querySelectorAll('br').forEach(n => n.replaceWith(' '));
    if (el.tagName === 'DT') c.querySelectorAll('span').forEach(n => n.after(', '));
    let t = c.textContent.replace(/\s+/g, ' ').trim();
    for (const [re, to] of SAY) t = t.replace(re, to);
    return t.trim();
  }
  function collect() {
    const roots = [...document.querySelectorAll('.hero, #hero, article, main')].filter((r, i, a) => !a.some(o => o !== r && o.contains(r)));
    const out = [];
    roots.forEach(root => root.querySelectorAll(BLOCKS).forEach(el => {
      if (el.closest(SKIP_INSIDE)) return;
      const sec = el.closest('section[id]');
      if (sec && SKIP_SECTIONS.includes(sec.id)) return;
      if (out.some(o => o.el.contains(el))) return;          // already read as part of a bigger block
      if (el.tagName === 'LI' && el.children.length === 1 && el.firstElementChild.tagName === 'A' && el.textContent.trim() === el.firstElementChild.textContent.trim()) return;   // link lists
      const t = textOf(el);
      if (t.length < 2) return;
      out.push({ el, t, sec: sec ? sec.id : '', title: sec ? (sec.dataset.t || '') : '' });
    }));
    return out;
  }

  /* ── split a block into short pieces (Chrome stops long utterances after ~15 s) ── */
  function split(t) {
    const parts = t.split(/(?<=[.!?。…])\s+|(?<=다\.)(?=\S)/).map(s => s.trim()).filter(Boolean);
    const out = [];
    parts.forEach(p => {
      while (p.length > 160) {
        let cut = p.lastIndexOf(', ', 150);
        if (cut < 40) cut = p.lastIndexOf(' ', 150);
        if (cut < 40) cut = 150;
        out.push(p.slice(0, cut + 1)); p = p.slice(cut + 1).trim();
      }
      if (p) out.push(p);
    });
    return out;
  }

  /* ── playback ── */
  function speakNext() {
    if (!playing) return;
    if (ci >= chunks.length) {
      idx++;
      if (idx >= blocks.length || (sectionEnd >= 0 && idx > sectionEnd)) { stop(true); return; }
      loadBlock(); return speakNext();
    }
    const u = new SpeechSynthesisUtterance(chunks[ci]);
    u.lang = 'ko-KR'; u.voice = voice; u.rate = rate;
    u.onend = () => { if (u._dead) return; ci++; speakNext(); };
    u.onerror = e => { if (u._dead || e.error === 'interrupted' || e.error === 'canceled') return; ci++; speakNext(); };
    current = u;
    synth.speak(u);
  }
  let current = null;
  function hush() { if (current) current._dead = true; current = null; synth.cancel(); }

  function loadBlock() {
    chunks = split(blocks[idx].t); ci = 0;
    blocks.forEach((b, k) => b.el.classList.toggle('vx-cur', k === idx));
    store.set(KEY, String(idx));
    const el = blocks[idx].el, r = el.getBoundingClientRect();
    if (Date.now() - userScrollAt > 5000 && (r.top < 90 || r.bottom > innerHeight - 110)) {
      el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
    renderUI();
  }
  function playFrom(i, onlySection) {
    hush();
    idx = Math.max(0, Math.min(blocks.length - 1, i));
    sectionEnd = -1;
    if (onlySection) { const s = blocks[idx].sec; let k = idx; while (k + 1 < blocks.length && blocks[k + 1].sec === s) k++; sectionEnd = k; }
    playing = true; showUI(); loadBlock(); speakNext();
  }
  function pause() { playing = false; hush(); renderUI(); }
  function resume() { playing = true; ci = 0; renderUI(); speakNext(); }   // restart the paragraph: pause() in Chrome is unreliable
  function stop(finished) {
    playing = false; hush(); sectionEnd = -1;
    if (finished && idx >= blocks.length) store.set(KEY, '0');
    renderUI();
  }
  function close() { stop(); blocks.forEach(b => b.el.classList.remove('vx-cur')); if (ui) ui.hidden = true; }
  function step(d) { const keep = sectionEnd; playFrom(idx + d); sectionEnd = keep >= 0 && idx <= keep ? keep : -1; }

  function firstOnScreen() {
    const k = blocks.findIndex(b => b.el.getBoundingClientRect().bottom > 100);
    return k < 0 ? 0 : k;
  }

  /* ── UI ── */
  const ICON = {
    spk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };
  const CSS = `
.vx-cur{background:color-mix(in srgb,var(--gold,#d5a844) 24%,transparent);box-shadow:0 0 0 6px color-mix(in srgb,var(--gold,#d5a844) 24%,transparent);border-radius:4px;transition:background .3s,box-shadow .3s}
.vx-top svg{width:16px;height:16px}
.vx-sec{display:inline-flex;align-items:center;gap:6px;margin:2px 0 12px;padding:5px 11px 5px 9px;font:600 12.5px/1 var(--sans,system-ui,sans-serif);color:var(--ink-2,#666);background:transparent;border:1px solid var(--line,#ccc);border-radius:999px;cursor:pointer}
.vx-sec svg{width:12px;height:12px}
.vx-sec:hover,.vx-sec:focus-visible{color:var(--ink,#111);border-color:var(--gold,#d5a844)}
.vx-bar{position:fixed;left:50%;bottom:max(16px,env(safe-area-inset-bottom));transform:translateX(-50%);z-index:90;display:flex;align-items:center;gap:4px;padding:6px 8px;max-width:calc(100vw - 32px);box-sizing:border-box;color:var(--ink,#111);background:var(--paper,#fff);border:1px solid var(--line,#ccc);border-radius:999px;box-shadow:0 8px 28px rgba(0,0,0,.22);font:500 13px/1.2 var(--sans,system-ui,sans-serif)}
.vx-bar[hidden]{display:none}
.vx-bar button{display:grid;place-items:center;min-width:40px;height:40px;padding:0 8px;border:0;border-radius:999px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.vx-bar button:hover,.vx-bar button:focus-visible{background:var(--paper-2,rgba(0,0,0,.06))}
.vx-bar button svg{width:18px;height:18px}
.vx-bar .vx-pp{background:var(--gold,#d5a844);color:#111}
.vx-bar .vx-pp:hover{background:var(--gold,#d5a844);filter:brightness(1.08)}
.vx-bar .vx-rate{font:600 12.5px/1 var(--mono,ui-monospace,monospace);min-width:48px}
.vx-bar .vx-voice{max-width:150px;height:32px;padding:0 6px;border:1px solid var(--line,#ccc);border-radius:8px;background:var(--paper,#fff);color:inherit;font:inherit;font-size:12.5px;cursor:pointer}
.vx-bar .vx-voice[hidden]{display:none}
.vx-bar .vx-where{max-width:220px;padding:0 6px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--ink-2,#666)}
@media (max-width:520px){.vx-bar{gap:2px;padding:5px 6px}.vx-bar button{min-width:36px;height:38px;padding:0 6px}.vx-bar .vx-rate{min-width:42px}.vx-bar .vx-voice{max-width:92px}.vx-bar .vx-where{display:none}.vx-top .lbl{display:none}}
@media print{.vx-bar,.vx-top,.vx-sec{display:none!important}}`;

  function button(cls, label, html, fn) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.setAttribute('aria-label', label); b.title = label; b.innerHTML = html;
    b.addEventListener('click', e => { e.stopPropagation(); fn(); });
    return b;
  }
  let topBtn, ppBtn, rateBtn, whereEl, voiceSel;
  function buildUI() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

    // top bar button, styled like its neighbours
    const theme = document.getElementById('themeBtn');
    topBtn = button((theme ? theme.className : 'btn') + ' vx-top', '듣기', ICON.spk + '<span class="lbl">듣기</span>', () => {
      if (playing) return pause();
      if (ui && !ui.hidden && blocks[idx]) return resume();
      const saved = +store.get(KEY) || 0;
      playFrom(saved > 0 && saved < blocks.length ? saved : firstOnScreen());
    });
    if (theme) theme.parentNode.insertBefore(topBtn, theme);
    else { topBtn.style.cssText = 'position:fixed;top:12px;right:12px;z-index:90'; document.body.appendChild(topBtn); }

    // per-section buttons under each section heading
    const seen = new Set();
    blocks.forEach((b, k) => {
      if (!b.sec || seen.has(b.sec)) return; seen.add(b.sec);
      const h = b.el.closest('section').querySelector('h2');
      if (!h) return;
      const sb = button('vx-sec', `이 섹션 듣기: ${b.title || h.textContent.trim()}`, ICON.play + '이 섹션 듣기', () => playFrom(blocks.findIndex(x => x.sec === b.sec), true));
      h.insertAdjacentElement('afterend', sb);
    });

    // floating player
    ui = document.createElement('div');
    ui.className = 'vx-bar'; ui.hidden = true; ui.setAttribute('role', 'region'); ui.setAttribute('aria-label', '읽어 주기');
    ppBtn = button('vx-pp', '재생', ICON.play, () => playing ? pause() : resume());
    rateBtn = button('vx-rate', '읽기 속도', '1.0×', () => {
      rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length] || 1; store.set('archive-voice-rate', String(rate));
      if (playing) { hush(); playing = true; speakNext(); }      // re-read the current sentence at the new speed
      renderUI();
    });
    voiceSel = document.createElement('select');
    voiceSel.className = 'vx-voice'; voiceSel.setAttribute('aria-label', '목소리'); voiceSel.title = '목소리';
    voiceSel.addEventListener('change', () => {
      const v = koVoices().find(x => x.voiceURI === voiceSel.value);
      if (!v) return;
      voice = v; store.set('archive-voice-name', v.voiceURI);
      if (playing) { hush(); playing = true; speakNext(); }      // re-read the current sentence in the new voice
    });
    fillVoices();
    synth.addEventListener('voiceschanged', fillVoices);
    whereEl = document.createElement('span'); whereEl.className = 'vx-where'; whereEl.setAttribute('aria-live', 'polite');
    ui.append(button('', '이전 단락', ICON.prev, () => step(-1)), ppBtn, button('', '다음 단락', ICON.next, () => step(1)), rateBtn, voiceSel, whereEl, button('', '읽기 닫기', ICON.x, close));
    document.body.appendChild(ui);

    addEventListener('keydown', e => { if (e.key === 'Escape' && ui && !ui.hidden) close(); });
    ['wheel', 'touchmove'].forEach(t => addEventListener(t, () => { userScrollAt = Date.now(); }, { passive: true }));
    addEventListener('keydown', e => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) userScrollAt = Date.now(); });
    addEventListener('pagehide', () => synth.cancel());
    renderUI();
  }
  function fillVoices() {
    const ko = koVoices();
    if (!ko.length) return;
    if (!store.get('archive-voice-name') || !ko.some(v => v.voiceURI === voice.voiceURI)) voice = pickVoice();   // better voices can arrive late
    voiceSel.innerHTML = '';
    ko.forEach((v, k) => {
      const o = document.createElement('option');
      o.value = v.voiceURI; o.textContent = shortName(v) + (k === 0 && score(v) > 0 ? ' · 추천' : '');
      o.selected = v.voiceURI === voice.voiceURI;
      voiceSel.appendChild(o);
    });
    voiceSel.hidden = ko.length < 2;
  }
  function showUI() { if (ui) ui.hidden = false; }
  function renderUI() {
    if (!ui) return;
    ppBtn.innerHTML = playing ? ICON.pause : ICON.play;
    ppBtn.setAttribute('aria-label', playing ? '일시 정지' : '재생'); ppBtn.title = ppBtn.getAttribute('aria-label');
    rateBtn.textContent = rate.toFixed(1) + '×';
    const b = blocks[idx];
    whereEl.textContent = b ? `${b.title || '머리말'} · ${idx + 1}/${blocks.length}` : '';
    topBtn.setAttribute('aria-pressed', String(playing));
    topBtn.querySelector('.lbl').textContent = playing ? '일시 정지' : '듣기';
  }

  /* ── start once voices are known ── */
  let started = false;
  function init() {
    if (started) return;
    voice = pickVoice();
    if (!voice) return;
    started = true;
    blocks = collect();
    if (!blocks.length) return;
    buildUI();
  }
  const ready = () => { init(); if (!started) synth.addEventListener('voiceschanged', init); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
