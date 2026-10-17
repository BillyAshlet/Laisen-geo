// Shell wiring: palette, block painting, small maps, readouts, trade-off, agent log.
const $ = s => document.querySelector(s);
const worlds = { sandbox: makeWorld(), city: null };
let world = worlds.sandbox;
let fields;
let tool = RES, roadLevel = 1, mode = 'sandbox';
const history = [];
const COVER_COLORS = ['#B8B2A3', '#ABE3A9', '#C3C9B5', '#5D93CB', '#82BCC4', '#F6F2EA', '#7A7466'];   // …, outside, road
const ROAD_COLORS = ['#8E8676', '#8E8676', '#5A554B'];   // arterial, expressway

// ---------- Palette ----------
// Zoning (block functions) and facilities (points) are separate tools. Industry is a facility.
const ZONES = [RES, COM, PARK, WET, FARM, WATER];
const FACTORY = 'factory';
function buildPalette() {
  $('#palette').innerHTML = ZONES.map(k =>
    `<button class="block${k === tool ? ' on' : ''}${k === WATER ? ' locked' : ''}" data-k="${k}"
       style="--c:${TYPE_COLORS[k]};color:${TYPE_INK[k]}"><span class="glyph">${TYPE_GLYPHS[k]}</span>${T().types[k]}</button>`).join('') +
    `<h2>${T().facilitiesHead}</h2>
     <button class="block${tool === FACTORY ? ' on' : ''}" data-k="${FACTORY}" style="--c:${TYPE_COLORS[IND]};color:#fff">
       <span class="glyph">▲</span>${T().factory}</button>`;
  $('#palette').querySelectorAll('.block').forEach(b => b.onclick = () => {
    const k = b.dataset.k; if (+k === WATER) return;
    tool = k === FACTORY ? FACTORY : +k; buildPalette();
  });
}

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

// Drawn as a map, not as pixels: flat block fills, round-cornered water, vector roads on top
// (the road lines cover the stepped block edges), factories as symbols with their nuisance radius.
function drawMap() {
  const ctx = map.getContext('2d'), s = map.width, c = s / N, bo = world.base.blockOf;
  ctx.fillStyle = '#F6F2EA'; ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < N * N; i++) {
    const x = (i % N) * c, y = ((i / N) | 0) * c, cv = fields.cover[i];
    if (cv === C_OUT) continue;
    if (bo[i] < 0) { if (!world.base.river[i]) { ctx.fillStyle = '#E4DED2'; ctx.fillRect(x, y, c + 0.5, c + 0.5); } continue; }
    const f = world.func[bo[i]];
    // Real Changchun blocks keep their observed green; edited and sandbox blocks are flat.
    const real = world.real && !world.edited[bo[i]];
    ctx.fillStyle = real && cv === C_GREEN ? COVER_COLORS[C_GREEN] : TYPE_COLORS[f];
    ctx.fillRect(x, y, c + 0.5, c + 0.5);
    if (world.locked[bo[i]] && ((i % N) - ((i / N) | 0)) % 5 === 0) { ctx.fillStyle = 'rgba(47,45,40,.18)'; ctx.fillRect(x, y, c + 0.5, c + 0.5); }
  }
  // Water (river, lakes, wetland cells) as soft discs so edges read as shorelines.
  ctx.fillStyle = TYPE_COLORS[WATER];
  for (let i = 0; i < N * N; i++) {
    if (fields.cover[i] !== C_WATER) continue;
    ctx.beginPath(); ctx.arc((i % N + 0.5) * c, (((i / N) | 0) + 0.5) * c, c * 0.78, 0, 2 * Math.PI); ctx.fill();
  }
  drawRoads(ctx, c);
  drawFactories(ctx, c);
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

function drawFactories(ctx, c) {
  for (const F of world.factories) {
    const x = F.x * c, y = F.y * c;
    ctx.strokeStyle = 'rgba(133,127,110,.7)'; ctx.setLineDash([c * 0.6, c * 0.5]); ctx.lineWidth = Math.max(1, c * 0.15);
    ctx.beginPath(); ctx.arc(x, y, FACTORY_NUISANCE_KM / CELL_KM * c, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = TYPE_COLORS[IND]; ctx.strokeStyle = '#2F2D28'; ctx.lineWidth = Math.max(1, c * 0.18);
    ctx.beginPath(); ctx.moveTo(x, y - c * 1.6); ctx.lineTo(x + c * 1.5, y + c * 1.1); ctx.lineTo(x - c * 1.5, y + c * 1.1); ctx.closePath(); ctx.fill(); ctx.stroke();
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
  const dev = world.nb - fields.counts[FARM];
  const rows = [[fields.counts[RES], world.target.res], [fields.counts[IND], world.target.ind], [dev, world.nb]];
  $('#constraints').innerHTML = rows.map(([v, max], k) =>
    `<div class="meter${k < 2 && v >= max ? ' ok' : ''}"><div class="row"><span>${T().constraints[k]}</span><b>${v} / ${max}</b></div>
     <div class="bar"><i style="width:${Math.min(100, v / max * 100)}%"></i></div></div>`).join('');
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
function log(msg, cls = '', suggestion = null) {
  const t = new Date().toTimeString().slice(0, 8);
  const li = document.createElement('li'); li.className = cls;
  li.innerHTML = `<span class="t">${t}</span>${msg}`;
  if (suggestion) {                       // clicking a suggestion applies it
    li.classList.add('act');
    li.onclick = () => {
      if (suggestion.kind === 'move') {
        const F = world.factories[suggestion.k]; F.x = suggestion.to.x; F.y = suggestion.to.y;
        highlight = new Set(); log(T().logFactoryMoved(suggestion.k + 1, suggestion.b), 'good');
      } else {
        const { a, b, fa, fb } = suggestion;
        world.func[a] = fb; world.func[b] = fa; world.edited[a] = world.edited[b] = 1; highlight = new Set();
        log(T().logApplied(a, b), 'good');
      }
      renderAll();
    };
  }
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

$('#ask').onclick = async () => {
  $('#ask').disabled = true;
  const picks = await runAgent(world, log);
  highlight = new Set(picks.flatMap(p => p.kind === 'move' ? [p.b, blockAtPoint(world, p.from.x, p.from.y)] : [p.a, p.b]));
  drawMap();
  $('#ask').disabled = false;
};

// ---------- Render all ----------
let lastMs = 0;
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
}

// ---------- Painting (one block at a time) ----------
let painting = false, lastBlock = -1;
function blockAt(e) {
  const r = map.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / r.width * N), y = Math.floor((e.clientY - r.top) / r.height * N);
  if (x < 0 || y < 0 || x >= N || y >= N) return -1;
  return world.base.blockOf[y * N + x];      // -1 on roads, the river and outside
}
function placeFactory(e) {
  const r = map.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width * N, y = (e.clientY - r.top) / r.height * N;
  const near = world.factories.findIndex(F => Math.hypot(F.x - x, F.y - y) < 2.5);
  if (near >= 0) { world.factories.splice(near, 1); log(T().logFactoryRemoved); }
  else {
    const i = Math.floor(y) * N + Math.floor(x);
    if (world.base.out[i] || world.base.river[i]) return;
    const b = blockAtPoint(world, x, y);
    if (b >= 0 && world.locked[b]) { log(T().logLocked(b), 'warn'); return; }
    world.factories.push({ x, y }); log(T().logFactoryPlaced(world.factories.length, b));
  }
  highlight = new Set(); renderAll();
}
function paintAt(e) {
  const b = blockAt(e); if (b < 0 || b === lastBlock) return; lastBlock = b;
  if (world.locked[b]) { log(T().logLocked(b), 'warn'); return; }
  if (world.func[b] === tool && world.road[b] === roadLevel) return;
  world.func[b] = tool; world.road[b] = roadLevel; world.edited[b] = 1; highlight = new Set();
  log(T().logPlace(T().types[tool], b));
  renderAll();
}
map.addEventListener('pointerdown', e => {
  if (tool === FACTORY) { placeFactory(e); return; }   // factories: one click, one plant (click again to remove)
  painting = true; lastBlock = -1; map.setPointerCapture(e.pointerId); paintAt(e);
});
map.addEventListener('pointermove', e => painting && tool !== FACTORY && paintAt(e));
map.addEventListener('pointerup', () => painting = false);

// ---------- Controls ----------
document.querySelectorAll('#road .block').forEach(b => b.onclick = () => {
  roadLevel = +b.dataset.road;
  document.querySelectorAll('#road .block').forEach(o => o.classList.toggle('on', o === b));
});
document.querySelectorAll('#mode .block').forEach(b => b.onclick = () => {
  mode = b.dataset.mode;
  document.querySelectorAll('#mode .block').forEach(o => o.classList.toggle('on', o === b));
  if (mode === 'city' && !worlds.city) worlds.city = makeCityWorld();
  world = worlds[mode]; highlight = new Set(); history.length = 0;
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
  applyStrings(); buildPalette(); buildSmalls(); renderAll(); log(T().logLang);
  if (revealed) $('#reveal').textContent = T().revealBack;
};
addEventListener('resize', () => { sizeLayout(); sizeMap(); drawMap(); drawTrade(); });

// ---------- Boot ----------
applyStrings(); buildPalette(); buildSmalls(); sizeLayout(); sizeMap(); renderAll();
log(T().logBoot(world.nb)); log(T().logEngine(lastMs.toFixed(0)));
