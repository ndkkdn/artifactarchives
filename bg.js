/* Pixel landscape behind the cover view — original procedural artwork, no external assets.
 *
 * Layer 1 (#bg-land): sky texture + dithered dot mountains. Drawn once per resize / theme change.
 * Layer 2 (#bg-cloud): pixel clouds, re-rendered ~30 times a second at one canvas pixel per cell and
 *   scaled up with nearest-neighbour. They drift slowly; moving the mouse pushes them along the
 *   direction of motion and they relax back over a few seconds.
 * Stops animating when the cover view is hidden, the tab is in the background, or the viewer prefers
 * reduced motion (then a still frame is drawn).
 */
(() => {
  const land = document.getElementById('bg-land'), gl = land.getContext('2d');
  const cloud = document.getElementById('bg-cloud'), gc = cloud.getContext('2d');
  const root = document.documentElement;
  const reducedMq = matchMedia('(prefers-reduced-motion: reduce)');
  const darkMq = matchMedia('(prefers-color-scheme: dark)');

  const PALETTES = {
    light: {
      sky: '#d8ddf0', skyDot: '#c4cae6', skyDot2: '#ccd1eb',
      shadow: '#141317', mid: '#f0542a', lit: '#e4dc3a', peak: '#f5f0a8', moss: '#3fbf7f',
      cloud: [253, 248, 230], cloud2: [242, 238, 203], cloudEdge: [236, 238, 250, 235],
    },
    dark: {
      sky: '#14152a', skyDot: '#1c1e3a', skyDot2: '#191a33',
      shadow: '#06060a', mid: '#b8401f', lit: '#8f8a2c', peak: '#c9c27a', moss: '#2a8a5c',
      cloud: [74, 78, 124], cloud2: [56, 60, 102], cloudEdge: [40, 43, 76, 230],
    },
  };
  const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : darkMq.matches;

  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => v / 16);
  const hash = (x, y) => {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const sm = t => t * t * (3 - 2 * t);
  const vn = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  const fbm = (x, y, o) => { let v = 0, a = .5, f = 1; for (let i = 0; i < o; i++) { v += a * vn(x * f, y * f); f *= 2; a *= .5; } return v; };
  const rgba = (r, g, b, a = 255) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;

  let W, H, C, cols, rows, img, buf, dx, dy, P, CL = [];

  function drawLand() {
    P = PALETTES[isDark() ? 'dark' : 'light'];
    CL = [rgba(...P.cloud), rgba(...P.cloud2), rgba(...P.cloudEdge)];
    const dpr = Math.min(2, devicePixelRatio || 1);
    W = innerWidth; H = innerHeight; C = W < 700 ? 5 : 6;
    cols = Math.ceil(W / C); rows = Math.ceil(H / C);
    land.width = Math.round(W * dpr); land.height = Math.round(H * dpr);
    gl.setTransform(dpr, 0, 0, dpr, 0, 0);
    gl.fillStyle = P.sky; gl.fillRect(0, 0, W, H);
    // the ridge stays low so the cover caption keeps sky behind it
    const ridgeAt = new Float32Array(cols);
    for (let i = 0; i < cols; i++) {
      const x = i / cols;
      ridgeAt[i] = .66 + .15 * (1 - fbm(x * 3.2 + 7, 1.3, 6)) - .07 * Math.sin(x * 3.1 + .6);
    }
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const x = i / cols, y = j / rows, ridge = ridgeAt[i], bay = BAYER[(j & 3) * 4 + (i & 3)];
      if (y > ridge) {
        // sunlit ridges go orange → yellow, gullies fall into shadow
        const lit = 1 - Math.abs(2 * fbm(x * 7 + 2, y * 4, 4) - 1);
        const s = .55 * lit + .45 * fbm(x * 16, y * 16 + 3, 4) + .22 * (hash(i * 3, j) - .5) - (y - ridge) * .3;
        const t = Math.min(1, Math.max(0, (s - .36) * 2.4));
        let col = t < .5 + bay * .2 ? P.shadow : t < .72 + bay * .16 ? P.mid : t < .88 + bay * .1 ? P.lit : P.peak;
        if (hash(i, j * 7) > .99) col = P.moss;
        gl.fillStyle = col; gl.beginPath(); gl.arc(i * C + C / 2, j * C + C / 2, C * .46, 0, 7); gl.fill();
      } else {
        const n = fbm(x * 30, y * 30, 3);
        const col = n > .54 + bay * .18 ? P.skyDot : hash(i, j) > .94 ? P.skyDot2 : null;
        if (col) { gl.fillStyle = col; gl.fillRect(i * C + 1, j * C + 1, C - 2, C - 2); }
      }
    }
    cloud.width = cols; cloud.height = rows;
    img = gc.createImageData(cols, rows); buf = new Uint32Array(img.data.buffer);
    dx = new Float32Array(cols * rows); dy = new Float32Array(cols * rows);
  }

  /* cursor wind: recent pointer samples, each pushing nearby cloud cells along its velocity */
  const gusts = [];
  let lastP = null;
  addEventListener('pointermove', e => {
    if (e.pointerType === 'touch' || !W) return;
    const now = performance.now();
    if (lastP) {
      const dt = Math.max(8, now - lastP.t);
      const vx = (e.clientX - lastP.x) / dt, vy = (e.clientY - lastP.y) / dt;
      if (Math.abs(vx) + Math.abs(vy) > .02) {
        const lim = v => Math.max(-.06, Math.min(.06, v));
        gusts.push({ x: e.clientX / W, y: e.clientY / H, vx: lim(vx * 30 / W), vy: lim(vy * 30 / H), life: 1 });
        if (gusts.length > 48) gusts.shift();
      }
    }
    lastP = { x: e.clientX, y: e.clientY, t: now };
    wake();
  }, { passive: true });

  function frame(time) {
    const t = time / 1000, aspect = W / H, R = .16, R2 = R * R;
    for (const g of gusts) { g.x += g.vx * .02; g.y += g.vy * .02; g.life *= .965; }
    while (gusts.length && gusts[0].life < .05) gusts.shift();
    buf.fill(0);
    for (let j = 0; j < rows; j++) {
      const y = j / rows;
      // a high cloud band, plus a low band that drifts in front of the mountain base
      const band = Math.max(1 - Math.abs(y - .2) / .14, (y - .84) / .12);
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i, x = i / cols;
        let ox = dx[k] * .965, oy = dy[k] * .965;
        for (let n = 0; n < gusts.length; n++) {
          const g = gusts[n], ex = (x - g.x) * aspect, ey = y - g.y, d2 = ex * ex + ey * ey;
          if (d2 < R2) { const f = (1 - d2 / R2) * g.life * .12; ox += g.vx * f; oy += g.vy * f; }
        }
        dx[k] = ox; dy[k] = oy;
        if (band <= -.4) continue;
        const v = fbm((x - ox) * 3 - t * .018 + 31, (y - oy) * 5 + 7, 4) + band * .38 + (y > .84 ? .06 : 0);
        const bay = BAYER[(j & 3) * 4 + (i & 3)];
        if (v > .86 - bay * .06) buf[k] = v > .95 ? CL[0] : CL[1];
        else if (v > .8 - bay * .05) buf[k] = CL[2];
      }
    }
    gc.putImageData(img, 0, 0);
  }

  // only animate while the cover view is on screen
  const visible = () => document.body.classList.contains('stage-mode') && !document.hidden;
  let raf = 0, last = 0;
  function loop(now) {
    if (!visible() || reducedMq.matches) { raf = 0; return; }
    raf = requestAnimationFrame(loop);
    if (now - last < 33) return;
    last = now; frame(now);
  }
  function wake() { if (!raf && visible() && !reducedMq.matches) raf = requestAnimationFrame(loop); }

  function redraw() { drawLand(); frame(performance.now()); wake(); }
  redraw();

  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(redraw, 150); });
  document.addEventListener('visibilitychange', wake);
  darkMq.addEventListener('change', redraw);
  reducedMq.addEventListener('change', wake);
  new MutationObserver(redraw).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  new MutationObserver(wake).observe(document.body, { attributes: true, attributeFilter: ['class'] });
})();
