// ENGINE — mechanisms from BRIEF.md.
// Three layers, like real planning:
//  1. BASE (fixed): terrain, river, existing green/water, each street block's use (residential / commercial);
//  2. BLOCK CONTROLS (sliders, per street block): green ratio and development intensity —
//     the indicators of a Chinese regulatory detailed plan (控规: 绿地率, 开发强度/容积率);
//  3. FACILITIES (points, placed anywhere): factory, park, wetland/retention pond, transit station.
// Physics runs on a fine grid (N × N cells, 200 m). Street blocks are what arterial roads enclose.
// Every indicator depends on position, so where a change happens matters as much as how big it is.

const N = 120;            // 120 × 120 cells = 24 km square
const CELL_KM = 0.2;

// Block uses. RES and COM are urban (editable); the rest are natural/open base (fixed).
const RES = 0, COM = 1, IND = 2, PARK = 3, WET = 4, WATER = 5, FARM = 6;
const isUrban = u => u === RES || u === COM;
// Physical cover of each fine cell. C_OUT: outside the study area (Changchun mode).
const C_BUILT = 0, C_GREEN = 1, C_FARM = 2, C_WATER = 3, C_WET = 4, C_OUT = 5, C_ROAD = 6;

// Per-cover physical properties (built, green, farm, water, wetland, outside, road).
const IMPERV = [0.9, 0.1, 0.15, 0, 0, 0.15, 0.95];
// Runoff coefficients (GB 50014 via Rin): hard 0.85–0.95, green 0.10–0.20.
const RUNOFF = [0.9, 0.15, 0.3, 0, 0.05, 0, 0.9];
const STORE = [0, 0.5, 0.2, 0, 6, 0, 0];   // how much upstream water a cell can soak up
// Surface heat source by cover. Green, water and wetland cool by evapotranspiration
// (negative sources). Outside ≈ peri-urban farmland. Roads: asphalt plus traffic.
const HEAT_COVER = [0, -0.25, 0.35, -0.4, -0.35, 0.35, 1.2];
// Built cells: base heat by use, scaled by development intensity (taller, denser, more waste heat).
const HEAT_BUILT = [1.0, 1.2, 1.5];
const heatBuilt = (use, k) => HEAT_BUILT[use] * (0.7 + 0.6 * k);
// People per built cell (0.04 km²) by use, scaled by intensity: low-rise 0.4× … high-rise 2×.
const DENSITY = [1, 0.25];
const popFactor = k => 0.4 + 1.6 * k;

// ---------- Facilities ----------
// Each has a footprint (cells it occupies, by radius) and a radial effect.
// Strong enough that one facility shifts LST by a few degrees within ~1 km (Rin: park cooling
// reaches 100–300 m, large or connected parks 300–500 m; the halo here is the e-folding radius).
const FAC = {
  factory: { foot: 2.0, cover: C_BUILT, heat: 2.4, heatR: 5 },   // hot plant + ~1 km halo; brings jobs
  park:    { foot: 2.6, cover: C_GREEN, heat: -2.2, heatR: 4 },  // cooling island, ~800 m
  pond:    { foot: 2.4, cover: C_WET,   heat: -1.6, heatR: 3 },  // wetland / retention: intercepts runoff
  station: { foot: 0.8, cover: C_BUILT, heat: 0, heatR: 0 },     // transit stop: fast trips nearby
};
// No money: the scarce resource is LAND. Every footprint displaces homes, and the plan must
// still house everyone and provide jobs. Transit is limited to one line's worth of stops.
const MAX_STATIONS = 3;
const JOBS_GOAL = 0.4;     // jobs needed per resident

// Siting rules: why a facility can or can't go somewhere. Returns null if fine, else a reason key.
function siteCheck(w, type, x, y) {
  const i = Math.floor(y) * N + Math.floor(x), b = w.base;
  if (b.out[i] || b.river[i]) return 'water';
  const bl = blockAtPoint(w, x, y);
  if (bl >= 0 && w.locked[bl]) return 'locked';
  const nearRoad = (lv, km) => {
    const r = Math.ceil(km / CELL_KM);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const cx = Math.floor(x) + dx, cy = Math.floor(y) + dy;
      if (cx >= 0 && cy >= 0 && cx < N && cy < N && b.roadCell[cy * N + cx] >= lv && Math.hypot(dx, dy) * CELL_KM <= km) return true;
    }
    return false;
  };
  if (type === 'factory' && !nearRoad(2, 1.2)) return 'needFreight';         // goods go out by expressway
  if (type === 'station' && !nearRoad(1, 0.3)) return 'needRoad';            // stops sit on a road
  if (type === 'station' && w.facilities.filter(F => F.type === 'station').length >= MAX_STATIONS) return 'stationLimit';
  if (type === 'pond' && (b.z[i] - b.zlo) / (b.zhi - b.zlo) > 0.4) return 'tooHigh';   // water must flow to it
  return null;
}
const FACTORY_NUISANCE_KM = 1.5;   // pollution / noise decay distance
// A metro-like line: stops reach blocks within 2 km by a feeder leg (bus / e-bike), then 60 km/h.
// With peak-hour road speeds this makes transit win for trips over ~4 km and lose for short ones.
const STATION_KM = 2, FEEDER_KMH = 30, TRANSIT_KMH = 60, TRANSIT_WAIT = 2;

const hash = i => { const s = Math.sin(i * 12.9898 + 4.1) * 43758.5453; return s - Math.floor(s); };

// Changchun mode: Rin's 103 × 99 grid sits inside our 120 × 120 grid at this offset.
const OX = 8, OY = 10;
const realIndex = i => {
  const x = i % N - OX, y = ((i / N) | 0) - OY;
  return x >= 0 && y >= 0 && x < CHANGCHUN.w && y < CHANGCHUN.h ? y * CHANGCHUN.w + x : -1;
};
// ESA WorldCover class → our cover. Bare/sparse (60) is treated like open farmland.
const WC_TO_COVER = { 10: C_GREEN, 20: C_GREEN, 30: C_GREEN, 40: C_FARM, 50: C_BUILT, 60: C_FARM, 80: C_WATER, 90: C_WET, 95: C_WET };

// ---------- Sandbox road skeleton: three rings and twelve radials ----------
// (Changchun itself is ring + radial + grid; this keeps the sandbox recognisably urban.)
const CENTER = [52, 56];
function sandboxRoads() {
  const road = new Uint8Array(N * N);
  const put = (x, y, lv) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < N && y < N) road[y * N + x] = Math.max(road[y * N + x], lv); };
  for (const [r, lv] of [[11, 1], [23, 1], [37, 2]])
    for (let a = 0; a < 2 * Math.PI; a += 0.5 / r) put(CENTER[0] + r * Math.cos(a), CENTER[1] + r * Math.sin(a), lv);
  for (let k = 0; k < 12; k++) {
    const a = k * Math.PI / 6 + 0.2;
    for (let r = 4; r < 80; r += 0.5) put(CENTER[0] + r * Math.cos(a), CENTER[1] + r * Math.sin(a), 1);
  }
  return road;
}

// ---------- Street blocks: what roads, river and boundary enclose ----------
// Flood-fill the non-wall cells, then merge slivers (cut off by link roads or the
// raster edge) into their biggest neighbour until blocks are a sensible size.
const MIN_BLOCK = 30, MAX_BLOCKS = 70;      // cells (30 cells = 1.2 km²)
function cutBlocks(wall) {
  const L = new Int32Array(N * N).fill(-1);
  let k = 0;
  for (let s = 0; s < N * N; s++) {
    if (wall[s] || L[s] >= 0) continue;
    const stack = [s]; L[s] = k;
    while (stack.length) {
      const c = stack.pop(), x = c % N, y = (c / N) | 0;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        const j = ny * N + nx;
        if (nx >= 0 && ny >= 0 && nx < N && ny < N && !wall[j] && L[j] < 0) { L[j] = k; stack.push(j); }
      }
    }
    k++;
  }
  // Union–find over components; adjacency = within 2 cells of each other (across a road).
  const parent = Int32Array.from({ length: k }, (_, i) => i), size = new Int32Array(k);
  const find = a => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  for (let i = 0; i < N * N; i++) if (L[i] >= 0) size[L[i]]++;
  const edges = new Map();
  for (let i = 0; i < N * N; i++) {
    if (L[i] < 0) continue;
    const x = i % N, y = (i / N) | 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const j = ny * N + nx; if (L[j] < 0 || L[j] === L[i]) continue;
      const a = Math.min(L[i], L[j]), b = Math.max(L[i], L[j]);
      edges.set(a * k + b, 1);
    }
  }
  const adj = Array.from({ length: k }, () => []);
  for (const key of edges.keys()) { const a = Math.floor(key / k), b = key % k; adj[a].push(b); adj[b].push(a); }
  let count = k; const stuck = new Uint8Array(k);
  while (true) {
    let small = -1;
    for (let c = 0; c < k; c++) if (find(c) === c && !stuck[c] && (small < 0 || size[c] < size[small])) small = c;
    if (small < 0 || (size[small] >= MIN_BLOCK && count <= MAX_BLOCKS)) break;
    // Biggest neighbouring root of any member of this root's component.
    let best = -1;
    for (let c = 0; c < k; c++) {
      if (find(c) !== small) continue;
      for (const n of adj[c]) { const r = find(n); if (r !== small && (best < 0 || size[r] > size[best])) best = r; }
    }
    if (best < 0) { stuck[small] = 1; continue; }
    parent[small] = best; size[best] += size[small]; count--;
  }
  // Relabel roots 0..nb-1 and collect block geometry.
  const id = new Int32Array(k).fill(-1); let nb = 0;
  const blockOf = new Int32Array(N * N).fill(-1);
  for (let i = 0; i < N * N; i++) {
    if (L[i] < 0) continue;
    const r = find(L[i]); if (id[r] < 0) id[r] = nb++;
    blockOf[i] = id[r];
  }
  const blocks = Array.from({ length: nb }, () => ({ cells: [], cx: 0, cy: 0, nbrs: new Set() }));
  for (let i = 0; i < N * N; i++) if (blockOf[i] >= 0) { const B = blocks[blockOf[i]]; B.cells.push(i); B.cx += i % N; B.cy += (i / N) | 0; }
  for (const B of blocks) { B.cx /= B.cells.length; B.cy /= B.cells.length; }
  for (const key of edges.keys()) {
    const a = id[find(Math.floor(key / k))], b = id[find(key % k)];
    if (a !== b) { blocks[a].nbrs.add(b); blocks[b].nbrs.add(a); }
  }
  return { blockOf, blocks: blocks.map(B => ({ ...B, nbrs: [...B.nbrs] })) };
}

// ---------- Natural + historical base (fixed) ----------
// Sandbox: a stylised Changchun — high ground in the west, a river valley in the east,
// gullies draining west → east into it. City: Rin's DSM and WorldCover water.
const riverX = y => 0.64 * N + 4 * Math.sin(y / 14);
function makeBase(real = false) {
  const z = new Float32Array(N * N), river = new Uint8Array(N * N), out = new Uint8Array(N * N);
  let roadCell;
  if (real) {
    roadCell = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) {
      const k = realIndex(i), wc = k >= 0 ? CHANGCHUN.worldcover[k] : 0;
      if (!wc) { out[i] = 1; z[i] = 300; continue; }
      z[i] = CHANGCHUN.dem[k];
      if (wc === 80) river[i] = 1;
      roadCell[i] = CHANGCHUN.road[k];
    }
  } else {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x, rx = riverX(y);
      let h = 240 - 50 * x / N - 12 * Math.exp(-(((x - rx) / 8) ** 2));
      if (x < rx) for (const yk of [25, 60, 95]) h -= 4 * Math.exp(-(((y - yk) / 3) ** 2));
      z[i] = h + 0.3 * hash(i);
      if (Math.abs(x - rx) < 1.5) river[i] = 1;
    }
    roadCell = sandboxRoads();
  }
  for (let i = 0; i < N * N; i++) if (roadCell[i]) river[i] = 0;    // a road over the river is a bridge
  // Water and outside cells are sinks: runoff that reaches them leaves the system.
  const sink = river.map((v, i) => v || out[i]);
  // D8: each cell drains to its lowest lower neighbour.
  const recv = new Int32Array(N * N).fill(-1);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x; if (sink[i]) continue;
    let best = z[i];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if ((dx || dy) && nx >= 0 && ny >= 0 && nx < N && ny < N && z[ny * N + nx] < best) { best = z[ny * N + nx]; recv[i] = ny * N + nx; }
    }
  }
  const order = Int32Array.from([...Array(N * N).keys()].sort((a, b) => z[b] - z[a]));
  let zlo = Infinity, zhi = -Infinity;
  for (let i = 0; i < N * N; i++) if (!out[i]) { zlo = Math.min(zlo, z[i]); zhi = Math.max(zhi, z[i]); }
  const wall = roadCell.map((v, i) => v || river[i] || out[i]);
  return { z, river, out, sink, recv, order, zlo, zhi, roadCell, ...cutBlocks(wall) };
}

function newWorld(base) {
  const nb = base.blocks.length;
  return {
    base, nb,
    use: new Uint8Array(nb).fill(FARM),
    green: new Float32Array(nb).fill(0.2),      // green ratio 0.05–0.5
    intensity: new Float32Array(nb).fill(0.5),  // development intensity 0–1
    road: new Uint8Array(nb).fill(1),
    locked: new Uint8Array(nb), edited: new Uint8Array(nb), real: null,
    facilities: [],          // {type, x, y} in cell coordinates
    rain: 1,                 // rain scenario index into RAIN
    popTarget: 0,            // set from the starting layout: the city must keep housing everyone
  };
}
const editable = (w, b) => !w.locked[b] && isUrban(w.use[b]);

function makeWorld() {
  const w = newWorld(makeBase(false));
  // Inside the outer ring: urban blocks (mostly residential, some commercial).
  // Inner ring: the locked old town. Outside: farmland (fixed base).
  w.base.blocks.forEach((B, b) => {
    const d = Math.hypot(B.cx - CENTER[0], B.cy - CENTER[1]);
    if (d < 36) { w.use[b] = b % 4 === 0 ? COM : RES; w.green[b] = 0.2; w.intensity[b] = d < 20 ? 0.6 : 0.4; }
    if (d < 9) w.locked[b] = 1;
  });
  w.popTarget = evaluate(w).read.pop;
  return w;
}

// Changchun mode: cover comes straight from WorldCover until a student edits a block.
// Built-up blocks become urban (satellites can't tell residential from commercial, so all
// start residential) with their observed green share as the starting green ratio.
function makeCityWorld() {
  const base = makeBase(true), w = newWorld(base);
  const realCover = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) realCover[i] = base.out[i] ? C_OUT : WC_TO_COVER[CHANGCHUN.worldcover[realIndex(i)]] ?? C_FARM;
  const COVER_TO_USE = [RES, PARK, FARM, WATER, WET];
  base.blocks.forEach((B, b) => {
    const n = [0, 0, 0, 0, 0, 0, 0];
    for (const i of B.cells) n[realCover[i]]++;
    let best = 0; for (let c = 1; c < 5; c++) if (n[c] > n[best]) best = c;
    w.use[b] = COVER_TO_USE[best];
    w.green[b] = Math.min(0.5, Math.max(0.05, (n[C_GREEN] + n[C_WET] + n[C_WATER]) / B.cells.length));
    w.intensity[b] = 0.5;
  });
  w.real = { cover: realCover };
  w.popTarget = evaluate(w).read.pop;
  return w;
}

// ---------- Cover from block controls + facilities ----------
// An edited urban block: a share `green` of its cells (picked by a fixed per-cell hash, so
// raising the slider adds green cell by cell instead of reshuffling) is green; the rest is built.
function coverOf(w) {
  const cover = new Uint8Array(N * N), bo = w.base.blockOf;
  for (let i = 0; i < N * N; i++) {
    if (w.base.out[i]) { cover[i] = C_OUT; continue; }
    if (w.base.roadCell[i]) { cover[i] = C_ROAD; continue; }
    if (w.base.river[i] || bo[i] < 0) { cover[i] = C_WATER; continue; }
    const b = bo[i];
    if (w.real && !w.edited[b]) { cover[i] = w.real.cover[i]; continue; }
    const u = w.use[b];
    cover[i] = isUrban(u) ? (hash(i) < w.green[b] ? C_GREEN : C_BUILT)
             : u === PARK ? C_GREEN : u === WET ? C_WET : u === WATER ? C_WATER : C_FARM;
  }
  for (const F of w.facilities) footprint(F, i => { if (cover[i] !== C_OUT && cover[i] !== C_ROAD && !w.base.river[i]) cover[i] = FAC[F.type].cover; });
  return cover;
}

function footprint(F, fn) {
  const r = FAC[F.type].foot;
  for (let y = Math.max(0, Math.floor(F.y - r)); y <= Math.min(N - 1, Math.ceil(F.y + r)); y++)
    for (let x = Math.max(0, Math.floor(F.x - r)); x <= Math.min(N - 1, Math.ceil(F.x + r)); x++)
      if ((x + 0.5 - F.x) ** 2 + (y + 0.5 - F.y) ** 2 <= r * r) fn(y * N + x);
}
// The block a factory stands in (or the nearest one, if it sits on a road).
function blockAtPoint(w, x, y) {
  for (let r = 0; r < 4; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const cx = Math.floor(x) + dx, cy = Math.floor(y) + dy;
    if (cx >= 0 && cy >= 0 && cx < N && cy < N && w.base.blockOf[cy * N + cx] >= 0) return w.base.blockOf[cy * N + cx];
  }
  return -1;
}

// Sum over a (2r+1)² window via a summed-area table.
function windowMean(src, r) {
  const S = new Float64Array((N + 1) * (N + 1));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
    S[(y + 1) * (N + 1) + x + 1] = src[y * N + x] + S[y * (N + 1) + x + 1] + S[(y + 1) * (N + 1) + x] - S[y * (N + 1) + x];
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const x0 = Math.max(0, x - r), x1 = Math.min(N, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(N, y + r + 1);
    out[y * N + x] = (S[y1 * (N + 1) + x1] - S[y0 * (N + 1) + x1] - S[y1 * (N + 1) + x0] + S[y0 * (N + 1) + x0]) / ((x1 - x0) * (y1 - y0));
  }
  return out;
}

// ---------- Indicators ----------
// 1. Land surface temperature (relative). Local source + contiguous built-up
//    context within ~3 km + a few relaxation steps so heat spreads to neighbours
//    and green/water cool their surroundings (~0.5–1 km reach).
// traffic: city-wide driving relative to a 15-minute commute; scales road heat (more km driven, hotter roads).
function heat(w, cover, traffic = 1) {
  const src = new Float32Array(N * N), built = new Float32Array(N * N), bo = w.base.blockOf;
  const plant = new Uint8Array(N * N);
  for (const F of w.facilities) if (F.type === 'factory') footprint(F, i => plant[i] = 1);
  for (let i = 0; i < N * N; i++) {
    const c = cover[i], b = bo[i];
    built[i] = c === C_BUILT || c === C_ROAD ? 1 : 0;
    if (c !== C_BUILT) { src[i] = c === C_ROAD ? HEAT_COVER[c] * traffic : HEAT_COVER[c]; continue; }
    src[i] = plant[i] ? HEAT_BUILT[IND] : b >= 0 && isUrban(w.use[b]) ? heatBuilt(w.use[b], w.intensity[b]) : HEAT_BUILT[RES];
  }
  const ctx = windowMean(built, 15);
  const T0 = src.map((v, i) => v + 0.8 * ctx[i]);
  // Facilities radiate in a circle: factories heat, parks and ponds cool, strongest at the centre.
  for (const F of w.facilities) {
    const { heat: H, heatR: R } = FAC[F.type]; if (!H) continue;
    const x0 = Math.max(0, Math.floor(F.x - 3 * R)), x1 = Math.min(N - 1, Math.ceil(F.x + 3 * R));
    const y0 = Math.max(0, Math.floor(F.y - 3 * R)), y1 = Math.min(N - 1, Math.ceil(F.y + 3 * R));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d2 = (x + 0.5 - F.x) ** 2 + (y + 0.5 - F.y) ** 2;
      T0[y * N + x] += H * Math.exp(-d2 / (R * R));
    }
  }
  let T = T0.slice(), U = new Float32Array(N * N);
  for (let it = 0; it < 8; it++) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const a = T[y * N + Math.max(0, x - 1)] + T[y * N + Math.min(N - 1, x + 1)] + T[Math.max(0, y - 1) * N + x] + T[Math.min(N - 1, y + 1) * N + x];
      U[i] = 0.5 * T0[i] + 0.5 * a / 4;
    }
    [T, U] = [U, T];
  }
  return T;
}

// 2. Relative waterlogging susceptibility. Runoff follows D8 down the DEM and
//    accumulates; green and wetland soak some up; low, wet, hard cells score high.
// Rain scenarios (rough return-period levels) scale the runoff every cell produces.
const RAIN = [0.6, 1, 1.7];          // 小雨 / 暴雨 / 特大暴雨
// Each cell's drains can take this much flow; anything above it ponds. This threshold is what
// makes waterlogging non-linear: fine most of the time, then suddenly bad where flow converges.
const PIPE_CAP = 9;
// A pond / wetland intercepts every flow that passes within POND_REACH cells, up to its volume.
const POND_REACH = 3, POND_VOLUME = 90;
function flood(w, cover) {
  const b = w.base, rain = RAIN[w.rain ?? 1];
  const thru = new Float32Array(N * N), inflow = new Float32Array(N * N);
  // Which pond (if any) intercepts each cell's flow.
  const ponds = w.facilities.filter(F => F.type === 'pond');
  const zone = new Int16Array(N * N).fill(-1), left = ponds.map(() => POND_VOLUME);
  ponds.forEach((F, p) => {
    for (let y = Math.max(0, Math.floor(F.y - POND_REACH)); y <= Math.min(N - 1, Math.ceil(F.y + POND_REACH)); y++)
      for (let x = Math.max(0, Math.floor(F.x - POND_REACH)); x <= Math.min(N - 1, Math.ceil(F.x + POND_REACH)); x++)
        if ((x + 0.5 - F.x) ** 2 + (y + 0.5 - F.y) ** 2 <= POND_REACH * POND_REACH) zone[y * N + x] = p;
  });
  let caught = 0;
  for (const i of b.order) {
    if (b.sink[i]) continue;
    const c = cover[i];
    const total = RUNOFF[c] * rain + inflow[i];
    thru[i] = total;
    let out = Math.max(0, total - STORE[c]);
    const p = zone[i];
    if (p >= 0 && left[p] > 0) { const take = Math.min(out, left[p]); left[p] -= take; out -= take; caught += take; }
    if (b.recv[i] >= 0) inflow[b.recv[i]] += out;
  }
  const f = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) f[i] = b.sink[i] ? 0 : Math.max(0, thru[i] - PIPE_CAP);
  return { f, thru, caught };
}

// 3. Accessibility (Hansen) on the street-block graph. Travel time between
//    neighbouring blocks = centroid distance / speed; crossing the river is slow.
const SPEED = [12, 20, 32];   // km/h for low / mid / high road density (peak-hour speeds)
const BETA = 15;              // minutes; distance-decay of the gravity model
function travelTimes(w) {
  const B = w.nb, blocks = w.base.blocks;
  const stepMin = (a, b) => {
    const A = blocks[a], C = blocks[b];
    let wet = 0;
    for (let s = 1; s < 6; s++) {
      const x = Math.round(A.cx + (C.cx - A.cx) * s / 6), y = Math.round(A.cy + (C.cy - A.cy) * s / 6);
      if (w.base.river[y * N + x]) wet = 1;
    }
    const v = (SPEED[w.road[a]] + SPEED[w.road[b]]) / 2 * (wet ? 0.5 : 1);
    return Math.hypot(C.cx - A.cx, C.cy - A.cy) * CELL_KM / v * 60;
  };
  const t = new Float32Array(B * B).fill(Infinity);
  for (let s = 0; s < B; s++) {             // Dijkstra from every block (~70 nodes: cheap)
    const d = t.subarray(s * B, s * B + B), done = new Uint8Array(B); d[s] = 0;
    for (let k = 0; k < B; k++) {
      let u = -1, best = Infinity;
      for (let v = 0; v < B; v++) if (!done[v] && d[v] < best) { best = d[v]; u = v; }
      if (u < 0) break; done[u] = 1;
      for (const v of blocks[u].nbrs) { const nd = d[u] + stepMin(u, v); if (nd < d[v]) d[v] = nd; }
    }
  }
  return t;
}

// Jobs per built cell by use; each factory adds a fixed number of jobs where it stands.
const JOBS_PER_CELL = [0.1, 1];
const FACTORY_JOBS = 400;   // an industrial park's worth of jobs

// Travel times depend only on road densities and the block layout, so cache them:
// slider moves and facility placements (what the agent tries hundreds of times) skip Dijkstra.
let ttKey = '', ttCache = null;
function cachedTravelTimes(w) {
  const key = w.base.blocks.length + ':' + w.road.join('');
  if (key !== ttKey || ttCache.w !== w.base) { ttCache = { t: travelTimes(w), w: w.base }; ttKey = key; }
  return ttCache.t;
}

function evaluate(w) {
  const B = w.nb, blocks = w.base.blocks, bo = w.base.blockOf, cover = coverOf(w);
  const { f: fl, thru, caught } = flood(w, cover), road = cachedTravelTimes(w);

  // People and jobs per block, from what is actually built there (facility footprints take land).
  const pop = new Float32Array(B), jobs = new Float32Array(B), builtN = new Float32Array(B);
  for (let i = 0; i < N * N; i++) if (cover[i] === C_BUILT && bo[i] >= 0) builtN[bo[i]]++;
  for (let b = 0; b < B; b++) {
    const u = w.use[b]; if (!isUrban(u)) continue;
    pop[b] = builtN[b] * DENSITY[u] * popFactor(w.intensity[b]);
    jobs[b] = builtN[b] * JOBS_PER_CELL[u] * popFactor(w.intensity[b]);
  }
  for (const F of w.facilities) if (F.type === 'factory') { const b = blockAtPoint(w, F.x, F.y); if (b >= 0) jobs[b] += FACTORY_JOBS; }

  // Transit: each block within reach of a stop uses its nearest one. A transit trip is
  // feeder leg to the stop + wait + ride between stops + feeder leg to the destination;
  // a trip takes transit only when that beats the road. Trips then visibly gather at stops.
  const stations = w.facilities.filter(F => F.type === 'station');
  const nearStop = blocks.map(Bk => {
    let best = -1, km = Infinity;
    stations.forEach((F, s) => { const d = Math.hypot(Bk.cx + 0.5 - F.x, Bk.cy + 0.5 - F.y) * CELL_KM; if (d < STATION_KM && d < km) { best = s; km = d; } });
    return [best, km];
  });
  const transitTime = (i, j) => {
    const [si, ki] = nearStop[i], [sj, kj] = nearStop[j];
    if (si < 0 || sj < 0 || si === sj) return Infinity;
    const ride = Math.hypot(stations[si].x - stations[sj].x, stations[si].y - stations[sj].y) * CELL_KM;
    return (ki + kj) / FEEDER_KMH * 60 + TRANSIT_WAIT + ride / TRANSIT_KMH * 60;
  };
  const tt = (i, j) => Math.min(road[i * B + j], transitTime(i, j));
  let tripsAll = 0, tripsTransit = 0;

  // Hansen accessibility to jobs; mean commute from gravity shares.
  const acc = new Float32Array(B), workers = new Float32Array(B), commuteB = new Float32Array(B), flows = [];
  let commuteSum = 0, popSum = 0;
  for (let i = 0; i < B; i++) {
    let A = 0, tw = 0, L = 0;
    for (let j = 0; j < B; j++) {
      const t = tt(i, j); if (!isFinite(t)) continue;        // unreachable (an isolated block)
      const g = Math.exp(-t / BETA);
      A += jobs[j] * g; tw += jobs[j] * g * t; L += pop[j] * g;
    }
    acc[i] = A; workers[i] = L; commuteB[i] = A > 0 ? tw / A : 60;
    // Commuting flows (gravity shares) for the flow-line map.
    if (pop[i] > 0 && A > 0) for (let j = 0; j < B; j++) {
      if (j === i || !jobs[j]) continue;
      const tr = transitTime(i, j), t = Math.min(road[i * B + j], tr); if (!isFinite(t)) continue;
      const v = pop[i] * jobs[j] * Math.exp(-t / BETA) / A, byTransit = tr <= t;
      tripsAll += v; if (byTransit) tripsTransit += v;
      // [home block, job block, trips, stop near home, stop near job] (stops −1 when by road)
      if (v > 1) flows.push(byTransit ? [i, j, v, nearStop[i][0], nearStop[j][0]] : [i, j, v, -1, -1]);
    }
    if (pop[i] > 0 && A > 0) { commuteSum += pop[i] * tw / A; popSum += pop[i]; }
  }
  // Heat comes after travel: a spread-out city drives more, and its roads run hotter.
  const meanCommute = popSum ? commuteSum / popSum : 0;
  const lst = heat(w, cover, Math.max(0.6, Math.min(1.8, meanCommute / 15)));

  // Industrial impact: pollution and noise decaying ~1.5 km from each factory.
  const impact = new Float32Array(N * N);
  const plants = w.facilities.filter(F => F.type === 'factory');
  for (let i = 0; i < N * N; i++) {
    const x = i % N + 0.5, y = ((i / N) | 0) + 0.5;
    let s = 0;
    for (const F of plants) s += Math.exp(-Math.hypot(x - F.x, y - F.y) * CELL_KM / FACTORY_NUISANCE_KM);
    impact[i] = s;
  }

  // Readouts, weighted by where people live.
  let n = 0, h = 0, f = 0, comp = 0;
  for (let i = 0; i < N * N; i++) {
    if (cover[i] !== C_BUILT || bo[i] < 0 || w.use[bo[i]] !== RES) continue;
    const wgt = popFactor(w.intensity[bo[i]]);
    n += wgt; h += lst[i] * wgt; f += fl[i] * wgt; comp += impact[i] * wgt;
  }
  n = n || 1;
  // Output: each factory produces more when more workers can reach it.
  let output = 0;
  for (const F of plants) { const b = blockAtPoint(w, F.x, F.y); output += 0.5 + 0.5 * Math.min(1, (b >= 0 ? workers[b] : 0) / 800); }
  let totalPop = 0, totalJobs = 0; for (let b = 0; b < B; b++) { totalPop += pop[b]; totalJobs += jobs[b]; }

  const counts = { factory: 0, park: 0, pond: 0, station: 0 };
  for (const F of w.facilities) counts[F.type]++;

  // Changchun mode: how well does the model's heat pattern match the observed 2023 LST?
  let r = null;
  if (w.real) {
    const a = [], o = [];
    for (let i = 0; i < N * N; i++) { const k = realIndex(i); if (k >= 0 && CHANGCHUN.lst[k] != null) { a.push(lst[i]); o.push(CHANGCHUN.lst[k]); } }
    const m = v => v.reduce((s, x) => s + x, 0) / v.length, ma = m(a), mo = m(o);
    let sab = 0, saa = 0, sbb = 0;
    for (let k = 0; k < a.length; k++) { sab += (a[k] - ma) * (o[k] - mo); saa += (a[k] - ma) ** 2; sbb += (o[k] - mo) ** 2; }
    r = sab / Math.sqrt(saa * sbb);
  }
  const read = {
    r, pop: totalPop, jobs: totalJobs,
    transitShare: tripsAll ? tripsTransit / tripsAll : 0,
    jobsShare: totalJobs / (JOBS_GOAL * totalPop || 1),   // 100% = the jobs goal is met
    lst: 26 + 10 * h / n,                       // rough °C mapping; calibrate with Rin's LST
    flood: f / n,
    commute: meanCommute,                       // minutes
    output,
    complaints: Math.round(comp / n * 100),
  };
  // Baseline mean and spread are taken once per world, then held fixed.
  if (w.lstRef == null) {
    let m = 0, q = 0, k = 0;
    for (let i = 0; i < N * N; i++) if (cover[i] !== C_OUT) { m += lst[i]; q += lst[i] ** 2; k++; }
    w.lstRef = m / k; w.lstSd = Math.sqrt(q / k - w.lstRef ** 2);
  }
  const lstRef = w.lstRef, lstSd = w.lstSd;
  // Fields for display on fixed scales (so changes stay visible between edits):
  // commute in minutes (5 → 35), population density relative to this world's starting peak.
  const dens = blocks.map((Bk, b) => pop[b] / Bk.cells.length);
  if (w.densRef == null) w.densRef = Math.max(...dens) || 1;
  const commuteCell = new Float32Array(N * N), densCell = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const b = bo[i]; if (b < 0) continue;
    commuteCell[i] = pop[b] > 0 ? Math.max(0, Math.min(1, (commuteB[b] - 5) / 30)) : 0;
    densCell[i] = Math.min(1, dens[b] / w.densRef);
  }
  // Per-block mean LST and flood (same °C mapping as the readout), for the block panel.
  const blockLst = new Float32Array(B), blockFlood = new Float32Array(B), bn = new Float32Array(B);
  for (let i = 0; i < N * N; i++) { const b = bo[i]; if (b < 0) continue; blockLst[b] += lst[i]; blockFlood[b] += fl[i]; bn[b]++; }
  for (let b = 0; b < B; b++) { blockLst[b] = 26 + 10 * blockLst[b] / (bn[b] || 1); blockFlood[b] /= bn[b] || 1; }
  return {
    cover, read, counts, blockLst, blockFlood, pop,
    // Relative LST is shown as an anomaly: ±2 standard deviations around this world's starting
    // mean (fixed per world, so later edits still shift the colours). Same rule as the observed
    // LST in the reveal, so the two tiles compare like with like.
    lst: lst.map(v => Math.max(0, Math.min(1, 0.5 + (v - lstRef) / (4 * lstSd)))),
    flood: fl.map(v => Math.min(1, Math.sqrt(v / 40))),
    thru, caught,
    commute: commuteCell, density: densCell, commuteB,
    flows: [...flows.filter(f => f[3] < 0).sort((p, q) => q[2] - p[2]).slice(0, 80),
            ...flows.filter(f => f[3] >= 0).sort((p, q) => q[2] - p[2]).slice(0, 60)],
    stations,
    impact: impact.map(v => Math.min(1, v / 2)),
  };
}
