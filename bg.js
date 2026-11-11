/* Pixel seascape behind the cover view — original procedural artwork, no external assets.
 *
 * The scene follows the viewer's local clock: night → dawn → day → sunset → dusk, with the sun and
 * moon travelling across the sky and the palette blending smoothly between key times.
 *   ?hour=18.5     pin the scene to a time of day (preview)
 *   ?timelapse     run a full day in about a minute
 *
 * Layers
 *   #bg-land   sky gradient, texture, stars, sun/moon — redrawn about once a minute
 *   #bg-sea    the sea, one canvas pixel per cell, masked into a dot grid by CSS; animated
 *   #bg-cloud  pixel clouds that drift and stream away from the mouse; animated
 * The body gets .sky-light / .sky-dark so the top bar can keep its text readable, and --hl / --hl-text
 * on :root so the title highlight changes colour with the sky.
 * Animation pauses when the cover view is hidden, the tab is in the background, or the viewer prefers
 * reduced motion (a still frame is drawn instead).
 */
(() => {
  const land = document.getElementById('bg-land'), gl = land.getContext('2d');
  const sea = document.getElementById('bg-sea'), gs = sea.getContext('2d');
  const cloud = document.getElementById('bg-cloud'), gc = cloud.getContext('2d');
  const root = document.documentElement, body = document.body;
  const reducedMq = matchMedia('(prefers-reduced-motion: reduce)');
  const darkMq = matchMedia('(prefers-color-scheme: dark)');
  const params = new URLSearchParams(location.search);
  const pinned = params.has('hour') ? ((+params.get('hour') % 24) + 24) % 24 : null;
  const timelapse = params.has('timelapse');
  const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : darkMq.matches;

  /* ── palettes at key times of day (hour → colours), blended in between ── */
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const P = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? hex(v) : v]));
  const NIGHT = P({ hl: '#f2c94c', skyTop: '#0b1030', skyBot: '#232b5a', glow: '#3a4580', seaDeep: '#060a20', seaMid: '#111943', seaLight: '#2a3878', foam: '#8a9ad2', glint: '#f4f1de', cloud: '#3c4474', cloud2: '#2e355f', cloudEdge: '#242a52', stars: 1 });
  const DAWN = P({ hl: '#d9486a', skyTop: '#46559a', skyBot: '#f6bca4', glow: '#ffb38a', seaDeep: '#152150', seaMid: '#334483', seaLight: '#b87d97', foam: '#ffdcc6', glint: '#ffe6b0', cloud: '#ffdccc', cloud2: '#f2b6aa', cloudEdge: '#f6d2cc', stars: .15 });
  const DAY = P({ hl: '#f0542a', skyTop: '#8cb6f0', skyBot: '#dbe7f8', glow: '#ffffff', seaDeep: '#08295e', seaMid: '#1450a8', seaLight: '#3a86d8', foam: '#e6f5ff', glint: '#ffffff', cloud: '#fdfdfa', cloud2: '#e8eef8', cloudEdge: '#dce7f8', stars: 0 });
  const SUNSET = P({ hl: '#c9302c', skyTop: '#3b4088', skyBot: '#ff8d50', glow: '#ff6a3d', seaDeep: '#141541', seaMid: '#4a2862', seaLight: '#d65d38', foam: '#ffc27c', glint: '#ffe08a', cloud: '#ffb07c', cloud2: '#e07c70', cloudEdge: '#c47494', stars: 0 });
  const DUSK = P({ hl: '#7d3fa6', skyTop: '#1a1e50', skyBot: '#7a508e', glow: '#b05a7a', seaDeep: '#0c1034', seaMid: '#252963', seaLight: '#6a4a8a', foam: '#c4a0d0', glint: '#e8c0d8', cloud: '#94709e', cloud2: '#6e5482', cloudEdge: '#52406e', stars: .55 });
  const KEYS = [[0, NIGHT], [4.6, NIGHT], [6, DAWN], [8, DAY], [16.2, DAY], [18, SUNSET], [19.4, DUSK], [20.8, NIGHT], [24, NIGHT]];
  const SUNRISE = 6, SUNSET_H = 19;

  function paletteAt(h) {
    let k = 0; while (k < KEYS.length - 2 && h >= KEYS[k + 1][0]) k++;
    const [h0, a] = KEYS[k], [h1, b] = KEYS[k + 1];
    const t = h1 === h0 ? 0 : (h - h0) / (h1 - h0), s = t * t * (3 - 2 * t);
    const out = {};
    for (const key in a) out[key] = Array.isArray(a[key]) ? a[key].map((v, i) => v + (b[key][i] - v) * s) : a[key] + (b[key] - a[key]) * s;
    if (isDark()) for (const key in out) if (Array.isArray(out[key]) && key !== 'hl') out[key] = out[key].map((v, i) => v * .55 + [14, 16, 40][i] * .3);
    return out;
  }
  const css = c => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const lum = c => (.2126 * c[0] + .7152 * c[1] + .0722 * c[2]) / 255;
  const pack = (c, a = 255) => ((a << 24) | ((c[2] | 0) << 16) | ((c[1] | 0) << 8) | (c[0] | 0)) >>> 0;

  /* ── noise ── */
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => v / 16);
  const hash = (x, y) => { let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  const sm = t => t * t * (3 - 2 * t);
  const vn = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf; };
  const fbm = (x, y, o) => { let v = 0, a = .5, f = 1; for (let i = 0; i < o; i++) { v += a * vn(x * f, y * f); f *= 2; a *= .5; } return v; };

  let W, H, C, cols, rows, HZ, seaRow0, pal, sunPos = null, moonPos = null;
  let seaImg, seaBuf, cloudImg, cloudBuf, dx, dy;

  const hourNow = now => {
    if (pinned !== null) return pinned;
    if (timelapse) return (now / 1000 * .4 + 6) % 24;          // ~1 minute per day
    const d = new Date(); return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  };
  // sun/moon travel a short arc on the left, the side the covers leave open (the title owns the centre
  // and the receding covers the right); null when below the horizon
  function arc(h, rise, set) {
    const span = (set - rise + 24) % 24, p = ((h - rise + 24) % 24) / span;
    if (p < -.02 || p > 1.02) return null;
    return { x: .05 + .22 * p, y: HZ - Math.sin(Math.PI * Math.min(1, Math.max(0, p))) * (HZ - .16), p };
  }

  function layout() {
    W = innerWidth; H = innerHeight; C = W < 700 ? 5 : 6;
    cols = Math.ceil(W / C); rows = Math.ceil(H / C);
    HZ = .64; seaRow0 = Math.floor(rows * HZ);
    const dpr = Math.min(2, devicePixelRatio || 1);
    land.width = Math.round(W * dpr); land.height = Math.round(H * dpr); gl.setTransform(dpr, 0, 0, dpr, 0, 0);
    // pixel layers: exactly one canvas pixel per C×C cell, so the CSS dot mask lines up
    for (const cv of [sea, cloud]) { cv.style.width = cols * C + 'px'; cv.style.height = rows * C + 'px'; }
    sea.width = cols; sea.height = rows; cloud.width = cols; cloud.height = rows;
    sea.style.setProperty('--cell', C + 'px');
    seaImg = gs.createImageData(cols, rows); seaBuf = new Uint32Array(seaImg.data.buffer);
    cloudImg = gc.createImageData(cols, rows); cloudBuf = new Uint32Array(cloudImg.data.buffer);
    dx = new Float32Array(cols * rows); dy = new Float32Array(cols * rows);
  }

  function drawSky(h) {
    pal = paletteAt(h);
    sunPos = arc(h, SUNRISE, SUNSET_H);
    moonPos = arc(h, SUNSET_H + .3, SUNRISE + .4);
    const sky = mix(pal.skyTop, pal.skyBot, .7);
    root.style.setProperty('--sky', css(sky));
    root.style.setProperty('--sky-rgb', sky.map(v => v | 0).join(', '));
    // title highlight follows the sky; ink is whichever of white / deep navy reads better on it
    root.style.setProperty('--hl', css(pal.hl));
    root.style.setProperty('--hl-text', lum(pal.hl) > .55 ? '#14152a' : '#ffffff');
    body.classList.toggle('sky-dark', lum(mix(pal.skyTop, pal.skyBot, .25)) < .42);
    body.classList.toggle('sky-light', lum(mix(pal.skyTop, pal.skyBot, .25)) >= .42);

    for (let j = 0; j < seaRow0 + 1; j++) {
      const y = j / rows, g = Math.min(1, y / HZ);
      const base = mix(pal.skyTop, pal.skyBot, g * g * .9 + g * .1);
      for (let i = 0; i < cols; i++) {
        const x = i / cols, bay = BAYER[(j & 3) * 4 + (i & 3)];
        let c = base;
        // soft glow around the sun, dithered into bands
        if (sunPos) {
          const ex = (x - sunPos.x) * W / H, ey = y - sunPos.y, d = Math.sqrt(ex * ex + ey * ey);
          const gw = Math.max(0, 1 - d / .34); if (gw * .9 > bay * .6 + .15) c = mix(c, pal.glow, Math.min(.55, gw * .7));
        }
        // texture: a few cells slightly darker or lighter
        const n = fbm(x * 30, y * 30, 3);
        if (n > .56 + bay * .16) c = mix(c, pal.skyTop, .14);
        else if (hash(i, j) > .955) c = mix(c, pal.skyBot, .25);
        gl.fillStyle = css(c); gl.fillRect(i * C, j * C, C, C);
        if (pal.stars > .05 && y < HZ - .04 && hash(i * 7, j * 13) > 1 - .006 * pal.stars) {
          gl.fillStyle = `rgba(240,242,255,${(.5 + .5 * hash(i, j * 3)) * pal.stars})`; gl.fillRect(i * C + 1, j * C + 1, C - 2, C - 2);
        }
      }
    }
    // under the dotted sea: a dark water base, so the gaps between dots read as deep water instead of sky
    for (let j = seaRow0 + 1; j < rows; j++) {
      const depth = (j - seaRow0) / Math.max(1, rows - seaRow0);
      gl.fillStyle = css(mix(mix(pal.seaMid, pal.seaDeep, .55), pal.seaDeep, Math.min(1, depth * 1.3)));
      gl.fillRect(0, j * C, cols * C, C);
    }
    const disk = (pos, fill, crescent) => {
      if (!pos) return;
      const cx = pos.x * cols, cy = pos.y * rows, R = Math.max(4, Math.round(rows * .034));
      for (let j = Math.floor(cy - R); j <= cy + R; j++) for (let i = Math.floor(cx - R); i <= cx + R; i++) {
        const d = Math.hypot(i + .5 - cx, j + .5 - cy);
        if (d > R || j >= seaRow0) continue;
        if (crescent && Math.hypot(i + .5 - cx - R * .45, j + .5 - cy + R * .1) < R * .85) continue;
        gl.fillStyle = css(d > R - 1 ? mix(fill, pal.glow, .35) : fill); gl.fillRect(i * C, j * C, C, C);
      }
    };
    disk(sunPos, [255, 236, 170]);
    disk(moonPos, [244, 240, 222], true);
  }

  /* ── cursor wind (clouds) and ripples (sea) ── */
  const gusts = [], ripples = [];
  let lastP = null;
  addEventListener('pointermove', e => {
    if (e.pointerType === 'touch' || !W) return;
    const now = performance.now();
    if (lastP) {
      const dt = Math.max(8, now - lastP.t), vx = (e.clientX - lastP.x) / dt, vy = (e.clientY - lastP.y) / dt;
      if (Math.abs(vx) + Math.abs(vy) > .02) {
        const lim = v => Math.max(-.06, Math.min(.06, v));
        gusts.push({ x: e.clientX / W, y: e.clientY / H, vx: lim(vx * 30 / W), vy: lim(vy * 30 / H), life: 1 });
        if (gusts.length > 48) gusts.shift();
        if (e.clientY / H > HZ && (!ripples.length || now - ripples[ripples.length - 1].t0 > 90)) {
          ripples.push({ x: e.clientX / C, y: e.clientY / C, t0: now });
          if (ripples.length > 14) ripples.shift();
        }
      }
    }
    lastP = { x: e.clientX, y: e.clientY, t: now };
    wake();
  }, { passive: true });

  function drawSea(now) {
    const t = now / 1000;
    seaBuf.fill(0);
    const deep = pal.seaDeep, mid = pal.seaMid, light = pal.seaLight;
    const cDeep = pack(deep), cMid = pack(mid), cLight = pack(light), cFoam = pack(pal.foam), cGlint = pack(pal.glint);
    const cHaze = pack(mix(light, pal.skyBot, .55));
    const glintX = sunPos ? sunPos.x : moonPos ? moonPos.x : null;
    const glintStrength = sunPos ? Math.sin(Math.PI * sunPos.p) * .6 + .4 : moonPos ? .55 : 0;
    while (ripples.length && now - ripples[0].t0 > 2600) ripples.shift();
    for (let j = seaRow0; j < rows; j++) {
      const depth = (j - seaRow0) / Math.max(1, rows - seaRow0);   // 0 at the horizon, 1 at the bottom
      const s = .35 + depth * 1.8;                                   // waves grow toward the viewer
      for (let i = 0; i < cols; i++) {
        const bay = BAYER[(j & 3) * 4 + (i & 3)];
        let v = .5
          + .26 * Math.sin(i / (2.6 * s) + t * 1.3 + j * .9)
          + .18 * Math.sin(i / (6.5 * s) - t * .7 + j * .37)
          + .34 * (vn(i / (5 * s) + t * .35, j * .55 - t * .2) - .5);
        for (let r = 0; r < ripples.length; r++) {
          const R = ripples[r], age = (now - R.t0) / 1000, ddx = i - R.x, ddy = (j - R.y) * 2.2;
          const dist = Math.sqrt(ddx * ddx + ddy * ddy), front = age * 22;
          if (Math.abs(dist - front) < 5) v += Math.cos((dist - front) * 1.1) * .35 * (1 - age / 2.6);
        }
        v -= .06 + depth * .22;
        let c;
        if (depth < .05 && bay > .3) c = cHaze;                      // hazy horizon line
        else if (v < .34 + bay * .16) c = cDeep;
        else if (v < .58 + bay * .14) c = cMid;
        else if (v < .8 + bay * .1) c = cLight;
        else c = cFoam;
        if (glintX !== null) {
          const gx = (i / cols - glintX) * W / H, wdt = .012 + depth * .09;
          if (Math.exp(-(gx * gx) / (wdt * wdt)) * glintStrength > .35 + bay * .4 && v > .45) c = cGlint;
        }
        seaBuf[j * cols + i] = c;
      }
    }
    gs.putImageData(seaImg, 0, 0);
  }

  function drawClouds(now) {
    const t = now / 1000, aspect = W / H, R = .16, R2 = R * R;
    for (const g of gusts) { g.x += g.vx * .02; g.y += g.vy * .02; g.life *= .965; }
    while (gusts.length && gusts[0].life < .05) gusts.shift();
    cloudBuf.fill(0);
    const C0 = pack(pal.cloud), C1 = pack(pal.cloud2), CE = pack(pal.cloudEdge, 230);
    const lastRow = Math.floor(rows * (HZ - .02));
    for (let j = 0; j < lastRow; j++) {
      const y = j / rows, band = 1 - Math.abs(y - .22) / .16;
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i, x = i / cols;
        let ox = dx[k] * .965, oy = dy[k] * .965;
        for (let n = 0; n < gusts.length; n++) {
          const g = gusts[n], ex = (x - g.x) * aspect, ey = y - g.y, d2 = ex * ex + ey * ey;
          if (d2 < R2) { const f = (1 - d2 / R2) * g.life * .12; ox += g.vx * f; oy += g.vy * f; }
        }
        dx[k] = ox; dy[k] = oy;
        if (band <= -.5) continue;
        const v = fbm((x - ox) * 3 - t * .018 + 31, (y - oy) * 5 + 7, 4) + band * .38;
        const bay = BAYER[(j & 3) * 4 + (i & 3)];
        if (v > .86 - bay * .06) cloudBuf[k] = v > .95 ? C0 : C1;
        else if (v > .8 - bay * .05) cloudBuf[k] = CE;
      }
    }
    gc.putImageData(cloudImg, 0, 0);
  }

  /* ── loop ── */
  const visible = () => body.classList.contains('stage-mode') && !document.hidden;
  let raf = 0, last = 0, lastSky = -1e9, lastHour = null;
  function frame(now) {
    const h = hourNow(now);
    // repaint the sky once a minute (or every frame-ish during a timelapse)
    if (now - lastSky > (timelapse ? 250 : 60000) || lastHour === null || Math.abs(h - lastHour) > .02 && timelapse) { drawSky(h); lastSky = now; lastHour = h; }
    drawSea(now); drawClouds(now);
  }
  function loop(now) {
    if (!visible() || reducedMq.matches) { raf = 0; return; }
    raf = requestAnimationFrame(loop);
    if (now - last < 33) return;
    last = now; frame(now);
  }
  function wake() { if (!raf && visible() && !reducedMq.matches) raf = requestAnimationFrame(loop); }
  function redraw() { layout(); lastSky = -1e9; frame(performance.now()); wake(); }
  redraw();

  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(redraw, 150); });
  document.addEventListener('visibilitychange', () => { lastSky = -1e9; wake(); });
  darkMq.addEventListener('change', redraw);
  reducedMq.addEventListener('change', wake);
  new MutationObserver(() => { lastSky = -1e9; frame(performance.now()); }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  new MutationObserver(wake).observe(body, { attributes: true, attributeFilter: ['class'] });
  // reduced motion still gets the right time of day
  setInterval(() => { if (reducedMq.matches && visible()) frame(performance.now()); }, 60000);
})();
