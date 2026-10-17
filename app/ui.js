// Shell wiring: tools, block sliders, facilities, small maps, readouts, trade-off, agent log.
const $ = s => document.querySelector(s);
// Changchun first: analyse a real city before playing in the sandbox.
const worlds = { city: makeCityWorld(), sandbox: null };
let world = worlds.city;
let fields;
let tool = 'select', selected = -1, mode = 'city';
const history = [];
const COVER_COLORS = ['#B8B2A3', '#ABE3A9', '#C3C9B5', '#5D93CB', '#82BCC4', '#F6F2EA', '#7A7466'];   // …, outside, road
const ROAD_COLORS = ['#8E8676', '#8E8676', '#5A554B'];   // arterial, expressway
const FAC_TYPES = ['factory', 'park', 'pond', 'station'];

// ---------- Tools: select a block, or place a facility ----------
function buildToolbar() {
  $('#toolbar').innerHTML = ['select', ...FAC_TYPES].map(t =>
    `<button class="block${t === tool ? ' on' : ''}" data-t="${t}" style="--c:${FAC_COLORS[t]};color:${t === 'factory' ? '#fff' : '#2F2D28'}">
       <span class="glyph">${FAC_GLYPHS[t]}</span>${T().tools[t]}${t === 'station' ? `<span class="tool-cost">${world.facilities.filter(F => F.type === 'station').length}/${MAX_STATIONS}</span>` : ''}</button>`).join('') +
    `<div class="hint">${T().toolHint}</div>
     <h2>${T().rainHead}</h2>
     <nav class="seg" id="rain">${T().rain.map((r, k) => `<button class="block${(world.rain ?? 1) === k ? ' on' : ''}" data-r="${k}">${r}</button>`).join('')}</nav>`;
  $('#toolbar').querySelectorAll('.block[data-t]').forEach(b => b.onclick = () => { tool = b.dataset.t; buildToolbar(); });
  $('#toolbar').querySelectorAll('.block[data-r]').forEach(b => b.onclick = () => {
    world.rain = +b.dataset.r; buildToolbar(); renderAll(); log(T().logRain(T().rain[world.rain], fields.read.flood.toFixed(2)));
  });
}

// ---------- Block popup: opens next to the clicked block ----------
// Sliders for the block's two control indicators, the block's own numbers, and how the
// city-wide goals have moved since the popup opened — so every cost is in front of you.
let popBase = null;
function buildBlockPanel() {
  const P = $('#popup');
  if (selected < 0) { P.classList.add('hidden'); popBase = null; return; }
  const b = selected, u = world.use[b], ok = editable(world, b), B = world.base.blocks[b];
  popBase = { ...fields.read };
  const head = `<div class="head"><span class="sw" style="background:${TYPE_COLORS[u]}"></span><b>${T().blockTitle(b, T().types[u])}</b>
    <button class="x" id="popX" aria-label="close">×</button></div>`;
  if (!ok) P.innerHTML = head + `<div class="muted">${T().fixedBlock}</div>`;
  else {
    const g = Math.round(world.green[b] * 100), k = Math.round(world.intensity[b] * 100);
    P.innerHTML = head + `
      <label class="slider"><span class="row"><span>${T().greenRatio}</span><b id="gv">${g}%</b></span>
        <input id="gs" type="range" min="5" max="50" step="5" value="${g}"></label>
      <label class="slider"><span class="row"><span>${T().intensity}</span><b id="kv">${k}</b></span>
        <input id="ks" type="range" min="0" max="100" step="10" value="${k}">
        <span class="row muted"><span>${T().intensityLow}</span><span>${T().intensityHigh}</span></span></label>
      <div class="muted" id="blockStats"></div>
      <div class="deltas" id="popDelta"></div>`;
    const hook = (id, key, label, show, fmtV) => {
      const el = $(id);
      el.oninput = () => { world[key][b] = +el.value / 100; world.edited[b] = 1; highlight = new Set(); $(show).textContent = fmtV(el.value); scheduleRender(); };
      el.onpointerdown = () => { el._start = fields.read; };
      el.onchange = () => {
        log(T().logSlider(b, label, fmtV(el.value)));
        if (el._start) toast(world.base.blocks[b].cx, world.base.blocks[b].cy, el._start);
      };
    };
    hook('#gs', 'green', T().greenRatio, '#gv', v => v + '%');
    hook('#ks', 'intensity', T().intensity, '#kv', v => v);
  }
  $('#popX').onclick = () => { selected = -1; buildBlockPanel(); drawMap(); };
  // Place it beside the block, on whichever side has room.
  const W = map.clientWidth, px = (B.cx + 0.5) / N * W, py = (B.cy + 0.5) / N * W;
  P.classList.remove('hidden');
  const pw = P.offsetWidth, ph = P.offsetHeight;
  const left = px < W / 2 ? Math.min(W - pw - 8, px + 30) : Math.max(8, px - pw - 30);
  P.style.left = left + 'px'; P.style.top = Math.max(8, Math.min(W - ph - 8, py - ph / 2)) + 'px';
  updatePopup();
}
function updatePopup() {
  if (selected < 0 || !$('#blockStats')) return;
  $('#blockStats').textContent = T().blockStats(fields.blockLst[selected], fields.blockFlood[selected], fields.pop[selected]);
  const r = fields.read, o = popBase || r, L = T().popRows;
  const row = (name, now, d, good) => `<span>${name}</span><b>${now}</b><i class="${d === 0 ? '' : good ? 'up' : 'down'}">${d === 0 ? '·' : sgn(d, 1)}</i>`;
  const pct = v => Math.round(v * 100) + '%';
  $('#popDelta').innerHTML =
    row(L.housed, pct(r.pop / world.popTarget), Math.round((r.pop - o.pop) / world.popTarget * 1000) / 10, r.pop >= o.pop) +
    row(L.jobs, pct(r.jobsShare), Math.round((r.jobsShare - o.jobsShare) * 1000) / 10, r.jobsShare >= o.jobsShare) +
    row(L.heat, r.lst.toFixed(1) + '°', Math.round((r.lst - o.lst) * 100) / 100, r.lst <= o.lst) +
    row(L.flood, r.flood.toFixed(2), Math.round((r.flood / o.flood - 1) * 1000) / 10, r.flood <= o.flood) +
    row(L.commute, r.commute.toFixed(1) + "'", Math.round((r.commute - o.commute) * 10) / 10, r.commute <= o.commute);
}
let pending = false;
const scheduleRender = () => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; renderAll(); }); } };

// ---------- Small maps ----------
// Four maps, each moved by several levers: heat, ponding, commute minutes, people per block.
const LAYER_KEYS = ['lst', 'flood', 'commute', 'density'];
const LAYER_RAMPS = ['diverging', 'floodBlue', 'access', 'density'];
function buildSmalls() {
  $('#smalls').innerHTML = LAYER_KEYS.map((key, k) => `
    <figure class="neatline small">
      <canvas id="sm-${key}" width="240" height="240"></canvas>
      <figcaption><span class="name" id="nm-${key}">${T().layers[k]}</span>
        <span class="legend">${T().lowHigh[k][0]}<i style="background:${rampCss(LAYER_RAMPS[k])}"></i>${T().lowHigh[k][1]}</span>
      </figcaption>
    </figure>`).join('');
}

// Bilinear upsample of the fine field, quantised into bands → contour-band look.
function drawField(canvas, field, ramp, bands = 8) {
  const S = canvas.width, ctx = canvas.getContext('2d'), img = ctx.createImageData(S, S);
  for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
    const fx = px / S * (N - 1), fy = py / S * (N - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(N - 1, x0 + 1), y1 = Math.min(N - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const v = (field[y0 * N + x0] * (1 - tx) + field[y0 * N + x1] * tx) * (1 - ty)
            + (field[y1 * N + x0] * (1 - tx) + field[y1 * N + x1] * tx) * ty;
    const cv = fields.cover[Math.round(fy) * N + Math.round(fx)];
    const [r, g, b] = cv === C_OUT ? [246, 242, 234] : cv === C_WATER ? [93, 147, 203] : rampAt(ramp, v, bands);
    img.data.set([r, g, b, 255], (py * S + px) * 4);
  }
  ctx.putImageData(img, 0, 0);
}

// Each thematic layer in its own cartographic form:
//  LST and ponding → smooth contour bands; commute → pale minutes underlay + flow lines
//  (home block → job block, width ∝ trips); population → dot density (one dot ≈ DOT people).
const DOT = 8;
function drawLayer(canvas, key, f, ramp) {
  if (key === 'lst' || key === 'flood') { drawField(canvas, f[key], ramp); return; }
  const S = canvas.width, ctx = canvas.getContext('2d'), c = S / N, B = world.base.blocks;
  if (key === 'commute') {
    drawField(canvas, f.commute.map(v => v * 0.55), ramp);           // pale underlay: minutes
    const vmax = Math.max(1, ...f.flows.map(x => x[2]));
    const P = b => [(B[b].cx + 0.5) * c, (B[b].cy + 0.5) * c], SP = s => [f.stations[s].x * c, f.stations[s].y * c];
    const width = v => Math.max(1, c * 2.2 * Math.sqrt(v / vmax));
    ctx.lineCap = 'round';
    // Road trips: curved lines straight from home block to job block.
    for (const [i, j, v, si] of [...f.flows].reverse()) {
      if (si >= 0) continue;
      const a = B[i], b = B[j], mx = (a.cx + b.cx) / 2 - (b.cy - a.cy) * 0.18, my = (a.cy + b.cy) / 2 + (b.cx - a.cx) * 0.18;
      ctx.strokeStyle = `rgba(23,78,90,${0.2 + 0.5 * v / vmax})`; ctx.lineWidth = width(v);
      ctx.beginPath(); ctx.moveTo(...P(i)); ctx.quadraticCurveTo((mx + 0.5) * c, (my + 0.5) * c, ...P(j)); ctx.stroke();
    }
    // Transit trips: home → stop (feeder), stop → stop (the line, summed), stop → job (feeder).
    const feeder = new Map(), trunk = new Map(), add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
    for (const [i, j, v, si, sj] of f.flows) {
      if (si < 0) continue;
      add(feeder, i + ':' + si, v); add(feeder, j + ':' + sj, v); add(trunk, Math.min(si, sj) + ':' + Math.max(si, sj), v);
    }
    ctx.strokeStyle = 'rgba(195,74,59,.55)';
    for (const [k, v] of feeder) { const [b, st] = k.split(':').map(Number); ctx.lineWidth = Math.max(1, width(v) * 0.7); ctx.beginPath(); ctx.moveTo(...P(b)); ctx.lineTo(...SP(st)); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(140,33,49,.9)';
    for (const [k, v] of trunk) { const [a, b] = k.split(':').map(Number); ctx.lineWidth = Math.max(2, width(v) * 1.4); ctx.beginPath(); ctx.moveTo(...SP(a)); ctx.lineTo(...SP(b)); ctx.stroke(); }
    for (const F of world.facilities) if (F.type === 'factory' || F.type === 'station') {      // where the flows go
      ctx.fillStyle = FAC_COLORS[F.type]; ctx.strokeStyle = '#2F2D28'; ctx.lineWidth = 1.5;
      const r = Math.max(3, c * 1.4);
      ctx.beginPath(); F.type === 'station' ? ctx.rect(F.x * c - r, F.y * c - r, 2 * r, 2 * r) : ctx.arc(F.x * c, F.y * c, r, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    }
    return;
  }
  // density: dots on built cells of each block, a fixed hash order so dots stay put as numbers change
  ctx.fillStyle = '#F6F2EA'; ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < N * N; i++) {
    const cv = f.cover[i]; if (cv === C_OUT) continue;
    ctx.fillStyle = cv === C_WATER ? '#C6DCEE' : '#EEE8DC'; ctx.fillRect((i % N) * c, ((i / N) | 0) * c, c + 0.5, c + 0.5);
  }
  ctx.fillStyle = '#5A447F';
  B.forEach((Bk, b) => {
    const n = Math.round(f.pop[b] / DOT); if (!n) return;
    const built = Bk.cells.filter(i => f.cover[i] === C_BUILT);
    for (let k = 0; k < n && built.length; k++) {
      const i = built[(k * 7919 + b * 104729) % built.length], jx = hash(i * 3 + k), jy = hash(i * 5 + k * 11);
      ctx.beginPath(); ctx.arc((i % N + jx) * c, (((i / N) | 0) + jy) * c, Math.max(1.2, c * 0.38), 0, 2 * Math.PI); ctx.fill();
    }
  });
}

// Difference map: after − before on the same fixed scale, blue = went down, red = went up.
// Unchanged places are neutral paper (not the ramp's pale middle, which reads as a colour),
// and the road network is drawn faintly so the map is recognisably the same city.
function drawDiff(canvas, before, after, gain = 2.5) {
  const S = canvas.width, ctx = canvas.getContext('2d'), img = ctx.createImageData(S, S);
  for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
    const i = Math.floor(py / S * N) * N + Math.floor(px / S * N), cv = fields.cover[i];
    const d = after[i] - before[i];
    const [r, g, b] = cv === C_OUT ? [246, 242, 234] : cv === C_WATER ? [190, 210, 230]
      : Math.abs(d) < 0.01 ? [238, 232, 220] : rampAt('diverging', 0.5 + gain * d);
    img.data.set([r, g, b, 255], (py * S + px) * 4);
  }
  ctx.putImageData(img, 0, 0);
  ctx.save(); ctx.globalAlpha = 0.45; drawRoads(ctx, S / N); ctx.restore();
}

// ---------- Main map ----------
const map = $('#map');
// Fit everything on one screen: the working area's height drives the layout;
// the main map gets priority, the small maps take the width that is left.
function sizeLayout() {
  const L = $('#layout'), root = document.documentElement.style;
  const cs = getComputedStyle(L), padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const H = L.clientHeight - padY, cap = 50, gap = 16;
  root.setProperty('--H', H + 'px');
  const room = L.clientWidth - padX - 200 - 2 * gap - 6;
  const tileMax = (H - 10) / 2 - cap - 3, tileMin = 110;
  let M = H - 24;
  let tile = Math.min(tileMax, (room - M - 10) / 2 - 3);
  if (tile < tileMin) { tile = tileMin; M = Math.max(200, room - 2 * (tile + 3) - 10); }
  root.setProperty('--M', M + 'px');
  root.setProperty('--T', tile + 'px');
}
function sizeMap() { map.width = map.height = Math.round(map.clientWidth * devicePixelRatio); }

// Drawn as a map, not as pixels: flat block fills in the use colour, green cells as tree dots
// (so the green ratio is visible), round-cornered water, vector roads on top (they cover the
// stepped block edges), facilities as symbols with their reach.
function drawMap() {
  const ctx = map.getContext('2d'), s = map.width, c = s / N, bo = world.base.blockOf;
  ctx.fillStyle = '#F6F2EA'; ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < N * N; i++) {
    const x = (i % N) * c, y = ((i / N) | 0) * c, cv = fields.cover[i];
    if (cv === C_OUT) continue;
    if (bo[i] < 0) { if (!world.base.river[i]) { ctx.fillStyle = '#E4DED2'; ctx.fillRect(x, y, c + 0.5, c + 0.5); } continue; }
    ctx.fillStyle = TYPE_COLORS[world.use[bo[i]]];
    ctx.fillRect(x, y, c + 0.5, c + 0.5);
    if (world.locked[bo[i]] && ((i % N) - ((i / N) | 0)) % 5 === 0) { ctx.fillStyle = 'rgba(47,45,40,.18)'; ctx.fillRect(x, y, c + 0.5, c + 0.5); }
  }
  // Green inside urban blocks: tree dots. Wetland: teal dots.
  for (let i = 0; i < N * N; i++) {
    const cv = fields.cover[i]; if (bo[i] < 0 || !isUrban(world.use[bo[i]])) continue;
    if (cv !== C_GREEN && cv !== C_WET) continue;
    ctx.fillStyle = cv === C_GREEN ? '#7FC67A' : '#5FA69E';
    ctx.beginPath(); ctx.arc((i % N + 0.5) * c, (((i / N) | 0) + 0.5) * c, c * 0.48, 0, 2 * Math.PI); ctx.fill();
  }
  // Water (river, lakes) as soft discs so edges read as shorelines.
  ctx.fillStyle = TYPE_COLORS[WATER];
  for (let i = 0; i < N * N; i++) {
    if (fields.cover[i] !== C_WATER) continue;
    ctx.beginPath(); ctx.arc((i % N + 0.5) * c, (((i / N) | 0) + 0.5) * c, c * 0.78, 0, 2 * Math.PI); ctx.fill();
  }
  drawFlow(ctx, c);
  drawHalos(ctx, c);
  drawRoads(ctx, c);
  drawSelection(ctx, c);
  drawTransitLine(ctx, c);
  drawFacilities(ctx, c);
  drawDiagRings(ctx, c);
  drawHighlight();
}

function drawRoads(ctx, c) {
  ctx.lineCap = ctx.lineJoin = 'round';
  const stroke = (lv, path) => {
    ctx.strokeStyle = '#F6F2EA'; ctx.lineWidth = c * (lv === 2 ? 1.5 : 1.15); path(); ctx.stroke();   // casing
    ctx.strokeStyle = ROAD_COLORS[lv]; ctx.lineWidth = c * (lv === 2 ? 0.95 : 0.6); path(); ctx.stroke();
  };
  if (world.real) {
    for (const lv of [1, 2]) for (const [level, pts] of CHANGCHUN.roadLines) {
      if (level !== lv) continue;
      stroke(lv, () => { ctx.beginPath(); for (let k = 0; k < pts.length; k += 2) ctx[k ? 'lineTo' : 'moveTo']((pts[k] + OX) * c, (pts[k + 1] + OY) * c); });
    }
  } else {
    // Same geometry as sandboxRoads() in the engine.
    for (let k = 0; k < 12; k++) {
      const a = k * Math.PI / 6 + 0.2;
      stroke(1, () => { ctx.beginPath(); ctx.moveTo((CENTER[0] + 0.5 + 4 * Math.cos(a)) * c, (CENTER[1] + 0.5 + 4 * Math.sin(a)) * c); ctx.lineTo((CENTER[0] + 0.5 + 80 * Math.cos(a)) * c, (CENTER[1] + 0.5 + 80 * Math.sin(a)) * c); });
    }
    for (const [r, lv] of [[11, 1], [23, 1], [37, 2]])
      stroke(lv, () => { ctx.beginPath(); ctx.arc((CENTER[0] + 0.5) * c, (CENTER[1] + 0.5) * c, r * c, 0, 2 * Math.PI); });
  }
}

// Surface runoff network: each cell's flow drawn to the cell it drains into, thicker where more
// water converges. Where flow exceeds the drains (PIPE_CAP) the line turns dark: that is where it floods.
function drawFlow(ctx, c) {
  const th = fields.thru, recv = world.base.recv;
  ctx.lineCap = 'round';
  for (let i = 0; i < N * N; i++) {
    const t = th[i]; if (t < 5 || recv[i] < 0) continue;
    const j = recv[i], over = t > PIPE_CAP;
    ctx.strokeStyle = over ? 'rgba(14,42,92,.85)' : 'rgba(70,130,190,.55)';
    ctx.lineWidth = Math.min(c * 1.1, c * 0.14 * Math.sqrt(t / 5));
    ctx.beginPath(); ctx.moveTo((i % N + 0.5) * c, (((i / N) | 0) + 0.5) * c); ctx.lineTo((j % N + 0.5) * c, (((j / N) | 0) + 0.5) * c); ctx.stroke();
  }
}

// Each facility's reach drawn on the map itself: a radial gradient following the same
// Gaussian fall-off the engine uses (warm for factories, cool for parks and ponds).
function drawHalos(ctx, c) {
  for (const F of world.facilities) {
    const { heat: H, heatR: R } = FAC[F.type]; if (!H) continue;
    const x = F.x * c, y = F.y * c, rad = 2.5 * R * c;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const col = H > 0 ? '200,84,26' : '46,140,150';
    for (let k = 0; k <= 6; k++) { const d = k / 6 * 2.5; g.addColorStop(k / 6, `rgba(${col},${(0.55 * Math.exp(-d * d)).toFixed(3)})`); }
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad, 0, 2 * Math.PI); ctx.fill();
  }
}

// Outline the selected block: draw the cell edges where it meets anything else.
function drawSelection(ctx, c) {
  if (selected < 0) return;
  const bo = world.base.blockOf;
  ctx.strokeStyle = '#2F2D28'; ctx.lineWidth = Math.max(2, c * 0.35); ctx.beginPath();
  for (const i of world.base.blocks[selected].cells) {
    const x = i % N, y = (i / N) | 0;
    if (x + 1 >= N || bo[i + 1] !== selected) { ctx.moveTo((x + 1) * c, y * c); ctx.lineTo((x + 1) * c, (y + 1) * c); }
    if (x - 1 < 0 || bo[i - 1] !== selected) { ctx.moveTo(x * c, y * c); ctx.lineTo(x * c, (y + 1) * c); }
    if (y + 1 >= N || bo[i + N] !== selected) { ctx.moveTo(x * c, (y + 1) * c); ctx.lineTo((x + 1) * c, (y + 1) * c); }
    if (y - 1 < 0 || bo[i - N] !== selected) { ctx.moveTo(x * c, y * c); ctx.lineTo((x + 1) * c, y * c); }
  }
  ctx.stroke();
}

// The transit line: stops joined in the order they were placed.
function drawTransitLine(ctx, c) {
  const st = world.facilities.filter(F => F.type === 'station'); if (st.length < 2) return;
  ctx.save(); ctx.lineCap = ctx.lineJoin = 'round';
  ctx.strokeStyle = '#F6F2EA'; ctx.lineWidth = c * 1.4; ctx.beginPath(); st.forEach((F, k) => ctx[k ? 'lineTo' : 'moveTo'](F.x * c, F.y * c)); ctx.stroke();
  ctx.strokeStyle = '#8C2131'; ctx.lineWidth = c * 0.8; ctx.setLineDash([c * 1.6, c * 0.6]);
  ctx.beginPath(); st.forEach((F, k) => ctx[k ? 'lineTo' : 'moveTo'](F.x * c, F.y * c)); ctx.stroke();
  ctx.restore();
}

// Symbols, each with a dashed ring for its reach (nuisance for factories, walk-in for stations).
function drawFacilities(ctx, c) {
  for (const F of world.facilities) {
    const x = F.x * c, y = F.y * c, r = c * 1.5;
    const ring = F.type === 'factory' ? FACTORY_NUISANCE_KM : F.type === 'station' ? STATION_KM : 0;
    if (ring) {
      ctx.strokeStyle = 'rgba(80,75,66,.75)'; ctx.setLineDash([c * 0.6, c * 0.5]); ctx.lineWidth = Math.max(1, c * 0.15);
      ctx.beginPath(); ctx.arc(x, y, ring / CELL_KM * c, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.fillStyle = FAC_COLORS[F.type]; ctx.strokeStyle = '#2F2D28'; ctx.lineWidth = Math.max(1, c * 0.18);
    ctx.beginPath();
    if (F.type === 'factory') { ctx.moveTo(x, y - r * 1.1); ctx.lineTo(x + r, y + r * 0.7); ctx.lineTo(x - r, y + r * 0.7); ctx.closePath(); }
    else if (F.type === 'station') { ctx.rect(x - r * 0.75, y - r * 0.75, r * 1.5, r * 1.5); }
    else ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fill(); ctx.stroke();
  }
}

// ---------- Readouts + constraints ----------
const READ_KEYS = ['lst', 'flood', 'commute', 'output', 'complaints'];
const fmt = (key, v) => key === 'lst' ? v.toFixed(1) + '°' : key === 'commute' ? v.toFixed(1) + "'" : key === 'complaints' ? String(v) : v.toFixed(key === 'flood' ? 2 : 1);
function drawReadouts() {
  // Each readout shows its change since the previous step and flashes green (better) or red (worse).
  // For every readout here, lower is better except output.
  const prev = history.length > 1 ? history[history.length - 2] : null;
  const EPS = { lst: 0.01, flood: 0.005, commute: 0.05, output: 0.05, complaints: 0.5 };
  $('#readouts').innerHTML = READ_KEYS.map((key, k) => {
    const dv = prev ? fields.read[key] - prev[key] : 0, moved = Math.abs(dv) >= EPS[key];
    const better = key === 'output' ? dv > 0 : dv < 0;
    const cls = moved ? (better ? 'better' : 'worse') : '';
    const dTxt = moved ? sgn(dv, key === 'complaints' ? 0 : key === 'flood' ? 2 : 1) : '';
    return `<div class="readout ${cls}"><span>${T().readouts[k]}</span><b>${fmt(key, fields.read[key])}</b><em>${dTxt}</em><canvas id="sp-${key}" width="128" height="32"></canvas></div>`;
  }).join('');
  READ_KEYS.forEach(key => {
    const cv = $('#sp-' + key), ctx = cv.getContext('2d'), vals = history.map(h => h[key]);
    if (vals.length < 2) return;
    const lo = Math.min(...vals), hi = Math.max(...vals), W = cv.width, H = cv.height;
    ctx.strokeStyle = '#E9E4D8'; ctx.lineWidth = 2; ctx.beginPath();   // sparklines sit on the dark footer
    vals.forEach((v, k) => { const X = k / (vals.length - 1) * (W - 4) + 2, Y = H - 4 - (v - lo) / ((hi - lo) || 1) * (H - 8); k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
    ctx.stroke();
  });
  // Housing constraint: everyone must stay housed. Facilities: counts by type.
  const R = fields.read, share = R.pop / (world.popTarget || 1), js = R.jobsShare;
  const counts = FAC_TYPES.map(t => `${FAC_GLYPHS[t]} ${fields.counts[t]}`).join('　');
  const meter = (label, v, ok, txt) => `<div class="meter ${ok ? 'ok' : 'bad'}"><div class="row"><span>${label}</span><b>${txt}</b></div>
      <div class="bar"><i style="width:${Math.max(0, Math.min(100, v * 100))}%"></i></div></div>`;
  $('#constraints').innerHTML =
    meter(T().popLabel, share, share >= 0.98, Math.round(share * 100) + '%') +
    meter(T().jobsLabel, js, js >= 1, Math.round(js * 100) + '%') +
    `<div class="meter"><div class="row"><span>${T().facLabel}</span><b>${counts}</b></div></div>`;
}

// ---------- Trade-off triangle ----------
// Each corner = how far that indicator is from ideal (0 = ideal, 1 = bad), on fixed reference ranges.
function badness(r) {
  const c = v => Math.max(0.04, Math.min(1, v));
  return [c((r.lst - 28) / 10), c(r.flood / 2), c(r.commute / 40)];
}
function drawTrade() {
  const cv = $('#trade'); cv.width = cv.height = cv.clientWidth * devicePixelRatio;
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height, cx = W / 2, cy = H * 0.56, R = H * 0.34;
  const ang = k => -Math.PI / 2 + k * 2 * Math.PI / 3, P = (k, r) => [cx + Math.cos(ang(k)) * R * r, cy + Math.sin(ang(k)) * R * r];
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = '#D9D1C1'; ctx.lineWidth = devicePixelRatio;
  for (const r of [0.33, 0.66, 1]) { ctx.beginPath(); [0, 1, 2, 0].forEach((k, j) => j ? ctx.lineTo(...P(k, r)) : ctx.moveTo(...P(k, r))); ctx.stroke(); }
  if (history.length > 1) {      // the previous step's shape, dashed, so you can see which way it moved
    const p = badness(history[history.length - 2]);
    ctx.strokeStyle = '#B9AE98'; ctx.lineWidth = 1.5 * devicePixelRatio; ctx.setLineDash([4 * devicePixelRatio, 3 * devicePixelRatio]);
    ctx.beginPath(); [0, 1, 2, 0].forEach((k, j) => j ? ctx.lineTo(...P(k, p[k])) : ctx.moveTo(...P(k, p[k]))); ctx.stroke(); ctx.setLineDash([]);
  }
  const v = badness(fields.read);
  ctx.fillStyle = 'rgba(133,127,110,.35)'; ctx.strokeStyle = '#2F2D28'; ctx.lineWidth = 2 * devicePixelRatio;
  ctx.beginPath(); [0, 1, 2, 0].forEach((k, j) => j ? ctx.lineTo(...P(k, v[k])) : ctx.moveTo(...P(k, v[k]))); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#6E685C'; ctx.font = `${11 * devicePixelRatio}px "IBM Plex Mono", monospace`; ctx.textAlign = 'center';
  T().axes.forEach((name, k) => { const [x, y] = P(k, 1.18); ctx.fillText(name, x, y + 4 * devicePixelRatio); });
}

// ---------- Agent log ----------
function applySuggestion(c) {
  const before = fields;
  if (c.kind === 'move') {
    const F = world.facilities[c.k]; if (F) { F.x = c.to.x; F.y = c.to.y; }
    log(T().logFacMoved(T().tools[c.type], c.b), 'good');
  } else if (c.kind === 'build') {
    world.facilities.push({ type: c.type, x: c.to.x, y: c.to.y });
    log(T().logFacPlaced(T().tools[c.type], c.b), 'good');
  } else {
    world[c.key][c.b] = c.to; world.edited[c.b] = 1; selected = -1;
    log(T().logApplied, 'good');
  }
  highlight = new Set(); buildBlockPanel(); renderAll();
  showChangeView(before, fields, c);
}

// ---------- Change view: four difference maps with the changed place circled ----------
function showChangeView(before, after, c) {
  const L = T(), cv = $('#cv');
  $('#av').classList.add('hidden'); cv.classList.remove('hidden');
  $('#cvTitle').textContent = L.cv.title; $('#cvBack').textContent = L.cv.back;
  const d = delta(before.read, after.read);
  $('#cvSummary').textContent = L.cv.summary(c.text ? (c.text.split(/[：:]/)[1] || '').trim() : '', d);
  const rows = [
    ['lst', L.layers[0], sgn(d.lst, 2) + '°', d.lst],
    ['flood', L.layers[1], sgn(d.flood, 1) + '%', d.flood],
    ['commute', L.layers[2], sgn(d.commute, 1) + "'", d.commute],
    ['density', L.layers[3], sgn((after.read.pop / before.read.pop - 1) * 100, 1) + '%', after.read.pop - before.read.pop],
  ];
  $('#cvGrid').innerHTML = rows.map(([k, name, txt, v]) => `<figure class="neatline"><canvas id="cv-${k}" width="360" height="360"></canvas>
    <figcaption><span>${name} · ${L.cv.diff}</span><span class="d ${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${txt}</span>
    <span class="legend">${L.cv.down}<i style="background:${rampCss('diverging')}"></i>${L.cv.up}</span></figcaption></figure>`).join('');
  // Where the change happened: the block for a slider; new site (and old site, for a move) for a facility.
  const marks = c.kind === 'slider'
    ? [{ x: world.base.blocks[c.b].cx + 0.5, y: world.base.blocks[c.b].cy + 0.5, r: Math.sqrt(world.base.blocks[c.b].cells.length / Math.PI) + 2, label: L.cv.here, solid: true }]
    : [{ x: c.to.x, y: c.to.y, r: 5, label: L.cv.to, solid: true }, ...(c.kind === 'move' ? [{ x: c.from.x, y: c.from.y, r: 5, label: L.cv.from, solid: false }] : [])];
  for (const [k] of rows) {
    const canvas = $('#cv-' + k);
    drawDiff(canvas, before[k], after[k]);
    const ctx = canvas.getContext('2d'), S = canvas.width / N;
    ctx.font = '600 13px "IBM Plex Mono", monospace';
    for (const m of marks) {
      ctx.strokeStyle = ctx.fillStyle = '#2F2D28'; ctx.lineWidth = 2.5; ctx.setLineDash(m.solid ? [] : [6, 4]);
      ctx.beginPath(); ctx.arc(m.x * S, m.y * S, m.r * S, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillText(m.label, m.x * S + m.r * S * 0.75, m.y * S - m.r * S * 0.75 - 2);
    }
    if (marks.length === 2) {          // an arrow from the old site to the new one
      const [a, b] = [marks[1], marks[0]], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const sx = (a.x + dx / len * a.r) * S, sy = (a.y + dy / len * a.r) * S, ex = (b.x - dx / len * b.r) * S, ey = (b.y - dy / len * b.r) * S;
      ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      const ang = Math.atan2(ey - sy, ex - sx);
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - 9 * Math.cos(ang - 0.4), ey - 9 * Math.sin(ang - 0.4)); ctx.lineTo(ex - 9 * Math.cos(ang + 0.4), ey - 9 * Math.sin(ang + 0.4)); ctx.closePath(); ctx.fill();
    }
  }
}
$('#cvBack').onclick = () => { $('#cv').classList.add('hidden'); drawMap(); };

function log(msg, cls = '', suggestion = null) {
  const t = new Date().toTimeString().slice(0, 8);
  const li = document.createElement('li'); li.className = cls;
  li.innerHTML = `<span class="t">${t}</span>${msg}`;
  if (suggestion) { li.classList.add('act'); li.onclick = () => applySuggestion(suggestion); }
  $('#log').appendChild(li); $('#log').scrollTop = 1e9;
}

// HIGHLIGHT (SciVisColor technique): dim everything except the blocks the agent suggests.
let highlight = new Set();
// Diagnosis rings: hottest (dark red) and wettest (dark blue) residential blocks, until the first edit.
let diagRings = null;
function drawDiagRings(ctx, c) {
  if (!diagRings) return;
  ctx.lineWidth = Math.max(2, c * 0.4); ctx.setLineDash([c * 1.2, c * 0.6]);
  for (const [list, col] of [[diagRings.hot, '#8A0B14'], [diagRings.wet, '#0E2A5C']]) {
    ctx.strokeStyle = col;
    for (const b of list) {
      const B = world.base.blocks[b], r = Math.sqrt(B.cells.length / Math.PI) * c + c * 2;
      ctx.beginPath(); ctx.arc((B.cx + 0.5) * c, (B.cy + 0.5) * c, r, 0, 2 * Math.PI); ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}
function drawHighlight() {
  if (!highlight.size) return;
  const ctx = map.getContext('2d'), c = map.width / N, bo = world.base.blockOf;
  // One path, one fill: per-cell translucent rects overlap at their edges and leave a grid of seams.
  ctx.fillStyle = 'rgba(110,104,92,.6)'; ctx.beginPath();
  for (let i = 0; i < N * N; i++) if (!(bo[i] >= 0 && highlight.has(bo[i]))) ctx.rect((i % N) * c, ((i / N) | 0) * c, c + 0.5, c + 0.5);
  ctx.fill();
}

// ---------- Agent view: the evaluation takes over the working area ----------
// 1 perceive (big LST, hottest homes circled) → 2 diagnose (big flood map, wettest circled)
// → 3 compute (every option plotted live: heat change vs flood change) → 4 suggest (cards).
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Rings around blocks. Problem rings (diagnosis) are thin and dashed; suggestion rings are solid
// and labelled, so after the agent finishes both stay readable on the same map.
function circleBlocks(canvas, blocks, color, { dashed = false, width = 3, labels = null } = {}) {
  const ctx = canvas.getContext('2d'), S = canvas.width / N;
  ctx.lineWidth = width; ctx.strokeStyle = color; ctx.fillStyle = color; ctx.font = '600 16px "IBM Plex Mono", monospace';
  ctx.setLineDash(dashed ? [6, 4] : []);
  blocks.forEach((b, k) => {
    const B = world.base.blocks[b]; if (!B) return;
    const r = Math.sqrt(B.cells.length / Math.PI) * S + 10;
    ctx.beginPath(); ctx.arc((B.cx + 0.5) * S, (B.cy + 0.5) * S, r, 0, 2 * Math.PI); ctx.stroke();
    const lab = labels ? labels[k] : String(k + 1);
    if (lab) ctx.fillText(lab, (B.cx + 0.5) * S + r * 0.75, (B.cy + 0.5) * S - r * 0.75);
  });
  ctx.setLineDash([]);
}
function avStep(text) {
  $('#avSteps').querySelectorAll('li').forEach(li => li.classList.remove('now'));
  const li = document.createElement('li'); li.className = 'now'; li.textContent = text; $('#avSteps').appendChild(li);
  return li;
}
// Scatter: x = change in homes' LST (°), y = change in flood exposure (%). Each dot one option.
const SC = { x: 0.4, y: 4 };   // ±0.4 °C, ±4 %: single steps are small, so zoom in
function scatterAxes() {
  const cv = $('#avScatter'), ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(95,166,158,.12)'; ctx.fillRect(0, H / 2, W / 2, H / 2);       // cooler and drier: the good quadrant
  ctx.strokeStyle = '#D9D1C1'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
  ctx.fillStyle = '#6E685C'; ctx.font = '12px "IBM Plex Mono", monospace';
  ctx.fillText(T().av.scatterX, 8, H - 8); ctx.save(); ctx.translate(14, H - 30); ctx.rotate(-Math.PI / 2); ctx.fillText(T().av.scatterY, 0, 0); ctx.restore();
}
const SC_COL = { slider: '#857F6E', move: '#2F7A7C', build: '#4682BE' };
function scatterDot(c, ok, base, big = false) {
  const cv = $('#avScatter'), ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  const d = delta(base, c.r);
  const x = W / 2 + Math.max(-1, Math.min(1, d.lst / SC.x)) * (W / 2 - 8);
  const y = H / 2 - Math.max(-1, Math.min(1, d.flood / SC.y)) * (H / 2 - 8);
  if (big) { ctx.strokeStyle = '#2F2D28'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, 9, 0, 2 * Math.PI); ctx.stroke(); return; }
  ctx.fillStyle = ok ? SC_COL[c.kind] : 'rgba(110,104,92,.25)';
  ctx.beginPath(); ctx.arc(x, y, ok ? 3 : 2, 0, 2 * Math.PI); ctx.fill();
}
async function openAgentView() {
  const av = $('#av'), L = T(); av.classList.remove('hidden');
  $('#avTitle').textContent = L.av.title; $('#avClose').textContent = L.av.close;
  $('#avSteps').innerHTML = ''; $('#avCards').innerHTML = ''; $('#avScCap').textContent = '';
  const d = diagnose(world, fields);
  const stages = [
    ['lst', 0, d.hot, L.av.s1 + '  ' + L.agentPerceive(fields.read)],
    ['flood', 1, d.wet, L.av.s2],
    ['commute', 2, d.far, L.av.s2b(d.far)],
    ['density', 3, d.dense, L.av.s2c(d.dense)],
  ];
  // Start with all four maps faint; each stage brings one forward and circles its problem blocks.
  for (const [key, k] of stages) {
    drawLayer($('#av-' + key), key, fields, LAYER_RAMPS[k]);
    const fig = $('#avf-' + key); fig.className = 'neatline'; fig.querySelector('figcaption').textContent = L.layers[k];
  }
  for (const [key, k, blocks, text] of stages) {
    const fig = $('#avf-' + key); fig.classList.add('now');
    circleBlocks($('#av-' + key), blocks, '#2F2D28');
    avStep(text); await sleep(1100);
    fig.classList.remove('now'); fig.classList.add('done');
  }
  // Compute, plotting every option as it is evaluated
  scatterAxes(); $('#avScCap').textContent = L.av.scatterX + ' · ' + L.av.scatterY;
  let total = 1, done = 0; const prog = avStep(L.av.s3(0, '…'));
  const { picks, base } = await runAgent(world, {
    onLine: log,
    onTotal: n => { total = n; },
    onCand: (c, ok, b) => { done++; scatterDot(c, ok, b); if (done % 25 === 0) prog.textContent = L.av.s3(done, total); },
  });
  prog.textContent = L.av.s3(done, done);
  // Suggest: the chosen places circled on all four maps
  avStep(picks.length ? L.av.s4 : L.av.none);
  const where = picks.map(p => p.b).filter(b => b >= 0);
  for (const [key, k] of stages) {
    drawLayer($('#av-' + key), key, fields, LAYER_RAMPS[k]);
    circleBlocks($('#av-' + key), where, '#2F2D28', { labels: where.map((_, n) => L.av.pick(n + 1)) });              // the suggestions
  }
  picks.forEach((c, k) => {
    scatterDot(c, true, base.read, true);
    const card = document.createElement('div'); card.className = 'card';
    card.innerHTML = `<span class="n">${k + 1}</span><span>${c.text.replace(L.agentClick, '')}</span><button class="block ochre">${L.av.apply}</button>`;
    card.querySelector('button').onclick = () => { av.classList.add('hidden'); applySuggestion(c); };
    $('#avCards').appendChild(card);
  });
  highlight = new Set(where);
}
$('#avClose').onclick = () => { $('#av').classList.add('hidden'); drawMap(); };
$('#ask').onclick = async () => {
  $('#ask').disabled = true;
  try { await openAgentView(); } finally { $('#ask').disabled = false; }
};

// ---------- Render all ----------
let lastMs = 0, warnedPop = false;
function renderAll() {
  const t0 = performance.now();
  fields = evaluate(world);
  lastMs = performance.now() - t0;
  history.push(fields.read); if (history.length > 40) history.shift();
  drawMap();
  LAYER_KEYS.forEach((key, k) => k === 0 && revealed ? drawField($('#sm-lst'), observedLst(), LAYER_RAMPS[0]) : drawLayer($('#sm-' + key), key, fields, LAYER_RAMPS[k]));
  $('#nm-lst').textContent = revealed ? T().layerObserved : T().layers[0];
  $('#nm-lst').closest('figure').classList.toggle('observed', revealed);
  drawReadouts(); drawTrade();
  updatePopup();
  const short = fields.read.pop < world.popTarget * 0.98;
  if (short && !warnedPop) log(T().logPopShort, 'warn');
  warnedPop = short;
}

// ---------- On-map change toast: the consequence appears where the action happened ----------
function toast(x, y, before) {
  const d = delta(before, fields.read), L = T().popRows, fig = $('.main');
  const parts = [[L.heat, sgn(d.lst, 2) + '°', d.lst], [L.flood, sgn(d.flood, 1) + '%', d.flood], [L.commute, sgn(d.commute, 1) + '′', d.commute]]
    .filter(([, , v]) => Math.abs(v) >= 0.01);
  if (!parts.length) return;
  const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = parts.map(([n, t, v]) => `<span class="${v < 0 ? 'good' : 'bad'}">${n} ${t}</span>`).join('');
  const W = map.clientWidth;
  el.style.left = Math.min(W - 180, Math.max(8, x / N * W + 14)) + 'px'; el.style.top = Math.max(8, y / N * W - 36) + 'px';
  fig.appendChild(el); setTimeout(() => el.remove(), 2600);
}

// ---------- Map clicks: select a block, or place / remove a facility ----------
function cellAt(e) {
  const r = map.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width * N, (e.clientY - r.top) / r.height * N];
}
map.addEventListener('pointerdown', e => {
  diagRings = null;
  const [x, y] = cellAt(e);
  if (x < 0 || y < 0 || x >= N || y >= N) return;
  if (tool === 'select') {
    selected = world.base.blockOf[Math.floor(y) * N + Math.floor(x)];
    if (selected < 0) { buildBlockPanel(); drawMap(); return; }
    drawMap(); buildBlockPanel(); return;
  }
  const near = world.facilities.findIndex(F => Math.hypot(F.x - x, F.y - y) < 2.5);
  if (near >= 0) { const [F] = world.facilities.splice(near, 1); log(T().logFacRemoved(T().tools[F.type])); }
  else {
    // Siting rules first, then money: every refusal says why, so the rule is the lesson.
    const why = siteCheck(world, tool, x, y);
    if (why) { log(T().site[why], 'warn'); return; }
    const b = blockAtPoint(world, x, y);
    world.facilities.push({ type: tool, x, y }); log(T().logFacPlaced(T().tools[tool], b));
  }
  const before = fields.read;
  highlight = new Set(); renderAll(); buildToolbar(); toast(x, y, before);
  if (tool === 'station') log(T().logTransit(Math.round(fields.read.transitShare * 100), fields.read.commute.toFixed(1)));
});

// ---------- Controls ----------
document.querySelectorAll('#mode .block').forEach(b => b.onclick = () => {
  mode = b.dataset.mode;
  document.querySelectorAll('#mode .block').forEach(o => o.classList.toggle('on', o === b));
  if (!worlds[mode]) worlds[mode] = mode === 'city' ? makeCityWorld() : makeWorld();
  world = worlds[mode]; highlight = new Set(); diagRings = null; history.length = 0; selected = -1; buildBlockPanel(); buildToolbar();
  if (mode !== 'city' && revealed) { revealed = false; $('#reveal').textContent = T().reveal; }
  log(T().logMode(b.textContent, world.nb));
  renderAll();
  if (fields.read.r != null) log(T().logFit(fields.read.r.toFixed(2)), 'good');
});
// ---------- Reveal: swap the LST tile between the model and the observed 2023 LST ----------
// Both are shown as anomalies (±2 standard deviations around their own mean), so the
// comparison is about the spatial pattern, not the absolute °C the model can't claim.
let revealed = false, obsCache = null;
function observedLst() {
  if (obsCache) return obsCache;
  const vals = CHANGCHUN.lst.filter(v => v != null);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  obsCache = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const k = realIndex(i), v = k >= 0 ? CHANGCHUN.lst[k] : null;
    obsCache[i] = v == null ? 0.5 : Math.max(0, Math.min(1, 0.5 + (v - mean) / (4 * sd)));
  }
  return obsCache;
}
$('#reveal').onclick = () => {
  if (mode !== 'city') { log(T().logRevealNeedsCity, 'warn'); return; }
  revealed = !revealed;
  $('#reveal').textContent = revealed ? T().revealBack : T().reveal;
  log(revealed ? T().logReveal(fields.read.r.toFixed(2)) : T().logRevealBack, 'good');
  renderAll();
};
$('#lang').onclick = () => {
  LANG = LANG === 'zh' ? 'en' : 'zh';
  $('#lang').textContent = LANG === 'zh' ? 'EN' : '中文';
  applyStrings(); buildToolbar(); buildBlockPanel(); buildSmalls(); renderAll(); log(T().logLang);
  if (revealed) $('#reveal').textContent = T().revealBack;
};
addEventListener('resize', () => { sizeLayout(); sizeMap(); drawMap(); drawTrade(); });

// ---------- Boot ----------
applyStrings(); buildToolbar(); buildBlockPanel(); buildSmalls(); sizeLayout(); sizeMap(); renderAll();
log(T().logMode(T().modeCity, world.nb)); log(T().logEngine(lastMs.toFixed(0)));
log(T().logFit(fields.read.r.toFixed(2)), 'good');
{ const d = diagnose(world, fields); log(T().diag(d.hot, d.wet), 'warn'); diagRings = { hot: d.hot, wet: d.wet }; drawMap(); }
