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
       <span class="glyph">${FAC_GLYPHS[t]}</span>${T().tools[t]}${t === 'select' ? '' : `<span class="tool-cost">¥${FAC[t].cost}</span>`}</button>`).join('') +
    `<div class="hint">${T().toolHint}</div>`;
  $('#toolbar').querySelectorAll('.block').forEach(b => b.onclick = () => { tool = b.dataset.t; buildToolbar(); });
}

// ---------- Block panel: the two control indicators of the selected block ----------
function buildBlockPanel() {
  const P = $('#blockPanel');
  if (selected < 0) { P.innerHTML = `<div class="muted">${T().pickBlock}</div>`; return; }
  const b = selected, u = world.use[b], ok = editable(world, b);
  const head = `<div class="head"><span class="sw" style="background:${TYPE_COLORS[u]}"></span>${T().blockTitle(b, T().types[u])}</div>`;
  if (!ok) { P.innerHTML = head + `<div class="muted">${T().fixedBlock}</div>`; return; }
  const g = Math.round(world.green[b] * 100), k = Math.round(world.intensity[b] * 100);
  P.innerHTML = head + `
    <label class="slider"><span class="row"><span>${T().greenRatio}</span><b id="gv">${g}%</b></span>
      <input id="gs" type="range" min="5" max="50" step="5" value="${g}"></label>
    <label class="slider"><span class="row"><span>${T().intensity}</span><b id="kv">${k}</b></span>
      <input id="ks" type="range" min="0" max="100" step="10" value="${k}">
      <span class="row muted"><span>${T().intensityLow}</span><span>${T().intensityHigh}</span></span></label>`;
  const hook = (id, key, label, show, fmtV) => {
    const el = $(id);
    el.oninput = () => { world[key][b] = +el.value / 100; world.edited[b] = 1; highlight = new Set(); $(show).textContent = fmtV(el.value); scheduleRender(); };
    el.onchange = () => log(T().logSlider(b, label, fmtV(el.value)));
  };
  P.insertAdjacentHTML('beforeend', `<div class="muted" id="blockStats"></div>`);
  hook('#gs', 'green', T().greenRatio, '#gv', v => v + '%');
  hook('#ks', 'intensity', T().intensity, '#kv', v => v);
}
let pending = false;
const scheduleRender = () => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; renderAll(); }); } };

// ---------- Small maps ----------
const LAYER_KEYS = ['lst', 'flood', 'access', 'impact'];
const LAYER_RAMPS = ['diverging', 'floodBlue', 'access', 'linearRed'];
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
  drawHalos(ctx, c);
  drawRoads(ctx, c);
  drawSelection(ctx, c);
  drawFacilities(ctx, c);
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
  $('#readouts').innerHTML = READ_KEYS.map((key, k) =>
    `<div class="readout"><span>${T().readouts[k]}</span><b>${fmt(key, fields.read[key])}</b><canvas id="sp-${key}" width="128" height="32"></canvas></div>`).join('');
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
    meter(T().budgetLabel, R.budget / 200, R.budget >= 0, '¥' + Math.round(R.budget)) +
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
  const v = badness(fields.read);
  ctx.fillStyle = 'rgba(133,127,110,.35)'; ctx.strokeStyle = '#2F2D28'; ctx.lineWidth = 2 * devicePixelRatio;
  ctx.beginPath(); [0, 1, 2, 0].forEach((k, j) => j ? ctx.lineTo(...P(k, v[k])) : ctx.moveTo(...P(k, v[k]))); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#6E685C'; ctx.font = `${11 * devicePixelRatio}px "IBM Plex Mono", monospace`; ctx.textAlign = 'center';
  T().axes.forEach((name, k) => { const [x, y] = P(k, 1.18); ctx.fillText(name, x, y + 4 * devicePixelRatio); });
}

// ---------- Agent log ----------
function applySuggestion(c) {
  if (c.kind === 'move') {
    const F = world.facilities[c.k]; if (F) { F.x = c.to.x; F.y = c.to.y; }
    log(T().logFacMoved(T().tools[c.type], c.b), 'good');
  } else if (c.kind === 'build') {
    world.facilities.push({ type: c.type, x: c.to.x, y: c.to.y });
    log(T().logFacPlaced(T().tools[c.type], c.b), 'good');
  } else {
    world[c.key][c.b] = c.to; world.edited[c.b] = 1; selected = c.b;
    log(T().logApplied, 'good');
  }
  highlight = new Set(); buildBlockPanel(); renderAll();
}
function log(msg, cls = '', suggestion = null) {
  const t = new Date().toTimeString().slice(0, 8);
  const li = document.createElement('li'); li.className = cls;
  li.innerHTML = `<span class="t">${t}</span>${msg}`;
  if (suggestion) { li.classList.add('act'); li.onclick = () => applySuggestion(suggestion); }
  $('#log').appendChild(li); $('#log').scrollTop = 1e9;
}

// HIGHLIGHT (SciVisColor technique): dim everything except the blocks the agent suggests.
let highlight = new Set();
function drawHighlight() {
  if (!highlight.size) return;
  const ctx = map.getContext('2d'), c = map.width / N, bo = world.base.blockOf;
  ctx.fillStyle = 'rgba(110,104,92,.6)';
  for (let i = 0; i < N * N; i++) if (!(bo[i] >= 0 && highlight.has(bo[i]))) ctx.fillRect((i % N) * c, ((i / N) | 0) * c, c + 0.5, c + 0.5);
}

// ---------- Agent view: the evaluation takes over the working area ----------
// 1 perceive (big LST, hottest homes circled) → 2 diagnose (big flood map, wettest circled)
// → 3 compute (every option plotted live: heat change vs flood change) → 4 suggest (cards).
const sleep = ms => new Promise(r => setTimeout(r, ms));
function circleBlocks(canvas, blocks, color) {
  const ctx = canvas.getContext('2d'), S = canvas.width / N;
  ctx.lineWidth = 4; ctx.strokeStyle = color; ctx.fillStyle = color; ctx.font = '600 22px "IBM Plex Mono", monospace';
  blocks.forEach((b, k) => {
    const B = world.base.blocks[b], r = Math.sqrt(B.cells.length / Math.PI) * S + 10;
    ctx.beginPath(); ctx.arc((B.cx + 0.5) * S, (B.cy + 0.5) * S, r, 0, 2 * Math.PI); ctx.stroke();
    ctx.fillText(String(k + 1), (B.cx + 0.5) * S + r * 0.75, (B.cy + 0.5) * S - r * 0.75);
  });
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
  const av = $('#av'); av.classList.remove('hidden');
  $('#avTitle').textContent = T().av.title; $('#avClose').textContent = T().av.close;
  $('#avSteps').innerHTML = ''; $('#avCards').innerHTML = ''; $('#avScCap').textContent = '';
  const big = $('#avMap'), d = diagnose(world, fields);
  // 1. Perceive
  drawField(big, fields.lst, 'diverging'); circleBlocks(big, d.hot, '#2F2D28');
  $('#avCap').textContent = T().layers[0];
  avStep(T().av.s1 + '  ' + T().agentPerceive(fields.read)); await sleep(1400);
  // 2. Diagnose
  drawField(big, fields.flood, 'floodBlue'); circleBlocks(big, d.wet, '#2F2D28');
  $('#avCap').textContent = T().layers[1];
  avStep(T().av.s2 + '  ' + T().diag(d.hot, d.wet)); await sleep(1400);
  // 3. Compute, plotting every option as it is evaluated
  scatterAxes(); $('#avScCap').textContent = T().av.scatterX + ' · ' + T().av.scatterY;
  let total = 1, done = 0; const prog = avStep(T().av.s3(0, '…'));
  const { picks, base } = await runAgent(world, {
    onLine: log,
    onTotal: n => { total = n; },
    onCand: (c, ok, b) => { done++; scatterDot(c, ok, b); if (done % 25 === 0) prog.textContent = T().av.s3(done, total); },
  });
  prog.textContent = T().av.s3(done, done);
  // 4. Suggest
  avStep(picks.length ? T().av.s4 : T().av.none);
  drawField(big, fields.lst, 'diverging');
  circleBlocks(big, picks.map(p => p.b), '#2F2D28');   // ink, not ochre: ochre never goes inside a neatline
  $('#avCap').textContent = T().layers[0];
  picks.forEach((c, k) => {
    scatterDot(c, true, base.read, true);
    const card = document.createElement('div'); card.className = 'card';
    card.innerHTML = `<span class="n">${k + 1}</span><span>${c.text.replace(T().agentClick, '')}</span><button class="block ochre">${T().av.apply}</button>`;
    card.querySelector('button').onclick = () => { av.classList.add('hidden'); applySuggestion(c); };
    $('#avCards').appendChild(card);
  });
  highlight = new Set(picks.map(p => p.b));
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
  LAYER_KEYS.forEach((key, k) => drawField($('#sm-' + key), k === 0 && revealed ? observedLst() : fields[key], LAYER_RAMPS[k]));
  $('#nm-lst').textContent = revealed ? T().layerObserved : T().layers[0];
  $('#nm-lst').closest('figure').classList.toggle('observed', revealed);
  drawReadouts(); drawTrade();
  if (selected >= 0 && $('#blockStats')) $('#blockStats').textContent = T().blockStats(fields.blockLst[selected], fields.blockFlood[selected], fields.pop[selected]);
  const short = fields.read.pop < world.popTarget * 0.98;
  if (short && !warnedPop) log(T().logPopShort, 'warn');
  warnedPop = short;
}

// ---------- Map clicks: select a block, or place / remove a facility ----------
function cellAt(e) {
  const r = map.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width * N, (e.clientY - r.top) / r.height * N];
}
map.addEventListener('pointerdown', e => {
  const [x, y] = cellAt(e);
  if (x < 0 || y < 0 || x >= N || y >= N) return;
  if (tool === 'select') {
    selected = world.base.blockOf[Math.floor(y) * N + Math.floor(x)];
    buildBlockPanel(); drawMap();
    if (selected >= 0 && $('#blockStats')) $('#blockStats').textContent = T().blockStats(fields.blockLst[selected], fields.blockFlood[selected], fields.pop[selected]);
    return;
  }
  const near = world.facilities.findIndex(F => Math.hypot(F.x - x, F.y - y) < 2.5);
  if (near >= 0) { const [F] = world.facilities.splice(near, 1); log(T().logFacRemoved(T().tools[F.type])); }
  else {
    // Siting rules first, then money: every refusal says why, so the rule is the lesson.
    const why = siteCheck(world, tool, x, y);
    if (why) { log(T().site[why], 'warn'); return; }
    if (fields.read.budget < FAC[tool].cost) { log(T().site.budget('¥' + FAC[tool].cost), 'warn'); return; }
    const b = blockAtPoint(world, x, y);
    world.facilities.push({ type: tool, x, y }); log(T().logFacPlaced(T().tools[tool], b));
  }
  highlight = new Set(); renderAll();
});

// ---------- Controls ----------
document.querySelectorAll('#mode .block').forEach(b => b.onclick = () => {
  mode = b.dataset.mode;
  document.querySelectorAll('#mode .block').forEach(o => o.classList.toggle('on', o === b));
  if (!worlds[mode]) worlds[mode] = mode === 'city' ? makeCityWorld() : makeWorld();
  world = worlds[mode]; highlight = new Set(); history.length = 0; selected = -1; buildBlockPanel();
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
{ const d = diagnose(world, fields); log(T().diag(d.hot, d.wet), 'warn'); highlight = new Set([...d.hot, ...d.wet]); drawMap(); }
