// Squadrats user manual — hero tile animation, chapter index, lightbox,
// integration filter and the Garmin Edge illustration.
(() => {
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── hero: a loop ride claiming squadratinhos ──────────────────────────────
  const cv = document.getElementById('hero-grid');
  if (cv) {
    const ctx = cv.getContext('2d');
    let W, H, C, cols, rows, owned, path, dpr, start = null, claimed = new Map(), raf;
    const hudSqi = document.querySelector('[data-hud="sqi"]');
    const hudKm = document.querySelector('[data-hud="km"]');
    const rnd = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(42);

    function layout() {
      dpr = Math.min(2, devicePixelRatio || 1);
      W = cv.clientWidth; H = cv.clientHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      C = W < 700 ? 18 : 24;
      cols = Math.ceil(W / C) + 1; rows = Math.ceil(H / C) + 1;
      // territory already collected: a lumpy blob on the right
      owned = new Set();
      const cx = cols * .72, cy = rows * .5;
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const dx = (x - cx) / (cols * .26), dy = (y - cy) / (rows * .42);
        const d = Math.hypot(dx, dy) + Math.sin(x * .7) * .08 + Math.cos(y * .9) * .08 + (rnd() - .5) * .22;
        if (d < 1) owned.add(x + ',' + y);
      }
      // loop route that leaves the territory, sweeps through new ground and returns
      path = [];
      const N = 420;
      for (let i = 0; i <= N; i++) {
        const t = i / N * Math.PI * 2;
        const r = 1 + .18 * Math.sin(3 * t) + .07 * Math.cos(5 * t);
        path.push([W * (.6 + .27 * r * Math.cos(t + .4)), H * (.5 + .36 * r * Math.sin(t + .4))]);
      }
      claimed = new Map();
    }

    function frame(now) {
      if (start === null) start = now;
      const T = reduce ? 1 : Math.min(1, (now - start) / 7000);
      const upto = Math.floor(T * (path.length - 1));
      for (let i = 0; i <= upto; i++) {
        const k = Math.floor(path[i][0] / C) + ',' + Math.floor(path[i][1] / C);
        if (!claimed.has(k) && !owned.has(k)) claimed.set(k, reduce ? -1e9 : now);
      }
      const green = css('--sq'), orange = css('--new'), line = css('--line'), uber = css('--uber'), route = css('--route');
      ctx.clearRect(0, 0, W, H);
      ctx.lineWidth = 1; ctx.strokeStyle = line;
      ctx.beginPath();
      for (let x = 0; x <= cols; x++) { ctx.moveTo(x * C + .5, 0); ctx.lineTo(x * C + .5, H); }
      for (let y = 0; y <= rows; y++) { ctx.moveTo(0, y * C + .5); ctx.lineTo(W, y * C + .5); }
      ctx.stroke();
      ctx.globalAlpha = .26; ctx.fillStyle = green;
      for (const k of owned) { const [x, y] = k.split(',').map(Number); ctx.fillRect(x * C + 1, y * C + 1, C - 1, C - 1); }
      for (const [k, t0] of claimed) {
        const [x, y] = k.split(',').map(Number), age = (now - t0) / 1400;
        ctx.globalAlpha = age < 1 ? .75 - age * .45 : .3;
        ctx.fillStyle = age < 1 ? orange : green;
        ctx.fillRect(x * C + 1, y * C + 1, C - 1, C - 1);
      }
      // Übersquadratinho of the territory
      ctx.globalAlpha = .9; ctx.strokeStyle = uber; ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
      const us = Math.round(Math.min(cols, rows) * .34);
      ctx.strokeRect(Math.round(cols * .72 - us / 2) * C, Math.round(rows * .5 - us / 2) * C, us * C, us * C);
      ctx.setLineDash([]);
      // route
      ctx.globalAlpha = 1; ctx.strokeStyle = route; ctx.lineWidth = 3.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(...path[0]);
      for (let i = 1; i <= upto; i++) ctx.lineTo(...path[i]);
      ctx.stroke();
      const hd = path[upto];
      ctx.fillStyle = green; ctx.beginPath(); ctx.arc(hd[0], hd[1], 6, 0, 7); ctx.fill();
      ctx.globalAlpha = .25; ctx.beginPath(); ctx.arc(hd[0], hd[1], 14, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
      if (hudSqi) hudSqi.textContent = '+' + claimed.size;
      if (hudKm) hudKm.textContent = (T * 48).toFixed(1).replace('.', document.documentElement.lang === 'pl' ? ',' : '.');
      if (T < 1 || [...claimed.values()].some(t0 => now - t0 < 1500)) raf = requestAnimationFrame(frame);
    }
    const run = () => { cancelAnimationFrame(raf); layout(); start = null; raf = requestAnimationFrame(frame); };
    run();
    let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(run, 200); });
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', run);
  }

  // ── chapter index: highlight the chapter in view ──────────────────────────
  const links = [...document.querySelectorAll('.toc a')];
  const byId = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
  const io = new IntersectionObserver(es => {
    for (const e of es) if (e.isIntersecting) {
      links.forEach(a => a.classList.remove('on'));
      byId.get(e.target.id)?.classList.add('on');
    }
  }, { rootMargin: '-30% 0px -60% 0px' });
  document.querySelectorAll('.chapter[id]').forEach(s => io.observe(s));

  // ── lightbox ──────────────────────────────────────────────────────────────
  document.addEventListener('click', e => {
    const img = e.target.closest('img.shot');
    if (!img) return;
    const box = document.createElement('div');
    box.className = 'lb'; box.tabIndex = 0;
    box.innerHTML = `<img src="${img.currentSrc || img.src}" alt="${img.alt.replace(/"/g, '&quot;')}">`;
    const close = () => box.remove();
    box.addEventListener('click', close);
    box.addEventListener('keydown', ev => { if (ev.key === 'Escape') close(); });
    document.body.appendChild(box); box.focus();
  });

  // ── integrations filter ───────────────────────────────────────────────────
  const fl = document.querySelector('.int-filter');
  if (fl) fl.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    fl.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    const f = b.dataset.f;
    document.querySelectorAll('.int').forEach(c => { c.hidden = f !== 'all' && c.dataset.cat !== f; });
  });

  // ── Garmin Edge data field (illustration) ─────────────────────────────────
  const ed = document.getElementById('edge-field');
  if (ed) {
    const c = ed.getContext('2d'), w = ed.width = 360, h = ed.height = 520, s = 20;
    const r2 = (s => () => (s = (s * 48271) % 2147483647) / 2147483647)(7);
    c.fillStyle = '#f1f3ef'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#d5dad2'; c.lineWidth = 1;
    for (let x = 0; x <= w; x += s) { c.beginPath(); c.moveTo(x + .5, 0); c.lineTo(x + .5, h - 92); c.stroke(); }
    for (let y = 0; y <= h - 92; y += s) { c.beginPath(); c.moveTo(0, y + .5); c.lineTo(w, y + .5); c.stroke(); }
    for (let y = 0; y < h - 92; y += s) for (let x = 0; x < w; x += s) {
      const d = Math.hypot(x - 230, y - 150) + r2() * 70;
      if (d < 150) { c.fillStyle = 'rgba(0,161,82,.45)'; c.fillRect(x + 1, y + 1, s - 1, s - 1); }
    }
    c.strokeStyle = '#7c4dff'; c.lineWidth = 3;
    c.strokeRect(160 + .5, 80 + .5, 8 * s, 8 * s);     // one squadrat = 8×8 squadratinhos
    c.fillStyle = 'rgba(232,98,12,.8)';
    [[3, 16], [4, 16], [4, 15], [5, 15], [5, 14], [6, 14], [6, 13]].forEach(([x, y]) => c.fillRect(x * s + 1, y * s + 1, s - 1, s - 1));
    c.strokeStyle = '#2563eb'; c.lineWidth = 4; c.lineCap = 'round';
    c.beginPath(); c.moveTo(20, 400); c.lineTo(70, 335); c.lineTo(130, 280); c.stroke();
    c.fillStyle = '#0d1626'; c.beginPath(); c.moveTo(130, 268); c.lineTo(140, 292); c.lineTo(130, 286); c.lineTo(120, 292); c.closePath(); c.fill();
    c.fillStyle = '#0d1626'; c.fillRect(0, h - 92, w, 92);
    c.fillStyle = '#fff'; c.font = '600 30px "JetBrains Mono", monospace';
    c.fillText('+7', 22, h - 44); c.fillText('1', 200, h - 44);
    c.font = '500 15px "Space Grotesk", sans-serif'; c.fillStyle = '#9fb0c8';
    c.fillText('SQI', 22, h - 18); c.fillText('SQ', 200, h - 18);
  }
})();
