// ENGINE — mechanisms from BRIEF.md.
// Two resolutions: physics runs on a fine grid (N × N cells, 200 m each);
// students act on STREET BLOCKS, the areas enclosed by arterial roads (and the river).
// Every indicator depends on position (neighbours, flow paths, distances),
// so swapping two blocks changes the result: an arrangement problem, not a sum.

const N = 120;            // 120 × 120 cells = 24 km square
const CELL_KM = 0.2;

// Block functions (student choices). Order matches STRINGS.types.
const RES = 0, COM = 1, IND = 2, PARK = 3, WET = 4, WATER = 5, FARM = 6;
// Physical cover of each fine cell. C_OUT: outside the study area (Changchun mode).
const C_BUILT = 0, C_GREEN = 1, C_FARM = 2, C_WATER = 3, C_WET = 4, C_OUT = 5, C_ROAD = 6;

// What a block of each function looks like from above (cover fractions:
// built, green, farm, water, wetland). Rough, to be checked with Rin.
const TEMPLATE = [
  [0.75, 0.25, 0, 0, 0],      // residential
  [0.90, 0.10, 0, 0, 0],      // commercial / public
  [0.95, 0.05, 0, 0, 0],      // industrial
  [0.10, 0.85, 0, 0.05, 0],   // park
  [0, 0.15, 0, 0.25, 0.60],   // wetland
  [0, 0, 0, 1, 0],            // water
  [0.05, 0.05, 0.90, 0, 0],   // farmland / open
];

// Per-cover physical properties (built, green, farm, water, wetland, outside, road).
const IMPERV = [0.9, 0.1, 0.15, 0, 0, 0.15, 0.95];
// Runoff coefficients (GB 50014 via Rin): hard 0.85–0.95, green 0.10–0.20.
const RUNOFF = [0.9, 0.15, 0.3, 0, 0.05, 0, 0.9];
const STORE = [0, 0.5, 0.2, 0, 6, 0, 0];   // how much upstream water a cell can soak up
// Surface heat source by cover; built cells get a function-specific value instead.
// Green, water and wetland cool by evapotranspiration, so their sources are negative.
// Outside ≈ peri-urban farmland. Roads: asphalt plus traffic.
const HEAT_COVER = [0, -0.25, 0.35, -0.4, -0.35, 0.35, 1.2];
const HEAT_BUILT = [1.0, 1.2, 1.5];        // residential, commercial, industrial
// Factories are point facilities, not zoning: a hot footprint plus a radial halo.
const FACTORY_FOOT = 1.6;                  // footprint radius, cells (~300 m)
const FACTORY_HEAT = 1.4, FACTORY_HEAT_R = 5;   // peak extra heat, e-folding radius in cells (~1 km)
const FACTORY_NUISANCE_KM = 1.5;           // pollution / noise decay distance

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
    func: new Uint8Array(nb).fill(FARM), road: new Uint8Array(nb).fill(1),
    locked: new Uint8Array(nb), edited: new Uint8Array(nb), real: null,
    factories: [],          // point facilities {x, y} in cell coordinates, placed anywhere
    target: { res: Math.round(nb * 0.3), ind: Math.max(2, Math.round(nb * 0.08)) },
  };
}

function makeWorld() {
  const w = newWorld(makeBase(false));
  // Old town: the blocks inside the inner ring are a locked historical core.
  w.base.blocks.forEach((B, b) => {
    const d = Math.hypot(B.cx - CENTER[0], B.cy - CENTER[1]);
    if (d < 9) { w.locked[b] = 1; w.func[b] = b % 2 ? COM : RES; }
  });
  return w;
}

// Changchun mode: cover comes straight from WorldCover until a student edits a block.
// Blocks get a function from their dominant cover so readouts have "homes" to measure;
// satellites can't see residential vs commercial, so all built-up blocks start as residential.
function makeCityWorld() {
  const base = makeBase(true), w = newWorld(base);
  const realCover = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) realCover[i] = base.out[i] ? C_OUT : WC_TO_COVER[CHANGCHUN.worldcover[realIndex(i)]] ?? C_FARM;
  const COVER_TO_FUNC = [RES, PARK, FARM, WATER, WET];
  base.blocks.forEach((B, b) => {
    const n = [0, 0, 0, 0, 0, 0, 0];
    for (const i of B.cells) n[realCover[i]]++;
    let best = 0; for (let c = 1; c < 5; c++) if (n[c] > n[best]) best = c;
    w.func[b] = COVER_TO_FUNC[best];
  });
  w.real = { cover: realCover };
  return w;
}

// ---------- Cover from block functions ----------
function coverOf(w) {
  const cover = new Uint8Array(N * N), bo = w.base.blockOf;
  for (let i = 0; i < N * N; i++) {
    if (w.base.out[i]) { cover[i] = C_OUT; continue; }
    if (w.base.roadCell[i]) { cover[i] = C_ROAD; continue; }
    if (w.base.river[i] || bo[i] < 0) { cover[i] = C_WATER; continue; }
    if (w.real && !w.edited[bo[i]]) { cover[i] = w.real.cover[i]; continue; }
    const t = TEMPLATE[w.func[bo[i]]], r = hash(i);
    let acc = 0, c = 0;
    for (; c < 5; c++) { acc += t[c]; if (r < acc) break; }
    cover[i] = Math.min(c, 4);
  }
  for (const F of w.factories) footprint(F, i => { if (cover[i] !== C_OUT && cover[i] !== C_ROAD && !w.base.river[i]) cover[i] = C_BUILT; });
  return cover;
}

function footprint(F, fn) {
  const r = FACTORY_FOOT;
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
function heat(w, cover) {
  const src = new Float32Array(N * N), built = new Float32Array(N * N), bo = w.base.blockOf;
  const plant = new Uint8Array(N * N); for (const F of w.factories) footprint(F, i => plant[i] = 1);
  for (let i = 0; i < N * N; i++) {
    const c = cover[i];
    built[i] = c === C_BUILT || c === C_ROAD ? 1 : 0;
    const f = bo[i] >= 0 ? w.func[bo[i]] : RES;
    src[i] = c === C_BUILT ? (plant[i] ? HEAT_BUILT[IND] : HEAT_BUILT[f <= COM ? f : RES]) : HEAT_COVER[c];
  }
  const ctx = windowMean(built, 15);
  const T0 = src.map((v, i) => v + 0.8 * ctx[i]);
  // Factories radiate heat in a circle: strongest at the plant, fading over ~1 km.
  for (const F of w.factories) {
    const R = FACTORY_HEAT_R, x0 = Math.max(0, Math.floor(F.x - 3 * R)), x1 = Math.min(N - 1, Math.ceil(F.x + 3 * R));
    const y0 = Math.max(0, Math.floor(F.y - 3 * R)), y1 = Math.min(N - 1, Math.ceil(F.y + 3 * R));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d2 = (x + 0.5 - F.x) ** 2 + (y + 0.5 - F.y) ** 2;
      T0[y * N + x] += FACTORY_HEAT * Math.exp(-d2 / (R * R));
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
function flood(w, cover) {
  const b = w.base, thru = new Float32Array(N * N), inflow = new Float32Array(N * N);
  for (const i of b.order) {
    if (b.sink[i]) continue;
    const c = cover[i];
    const total = RUNOFF[c] + inflow[i];
    thru[i] = total;
    const out = Math.max(0, total - STORE[c]);
    if (b.recv[i] >= 0) inflow[b.recv[i]] += out;
  }
  const f = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const low = 1 - (b.z[i] - b.zlo) / (b.zhi - b.zlo);
    // sqrt rather than log: keeps enough contrast that intercepting upstream flow shows up.
    f[i] = b.sink[i] ? 0 : Math.sqrt(thru[i]) * (0.4 + 0.6 * low) * (0.3 + 0.7 * IMPERV[cover[i]]);
  }
  return f;
}

// 3. Accessibility (Hansen) on the street-block graph. Travel time between
//    neighbouring blocks = centroid distance / speed; crossing the river is slow.
const SPEED = [15, 25, 40];   // km/h for low / mid / high road density
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

// Residents and jobs per km² of block, by function.
const POP = [1, 0.2, 0, 0, 0, 0, 0.05];
const JOBS = [0.1, 1, 0.8, 0.05, 0, 0, 0.05];
const FACTORY_JOBS = 2;   // job units per factory (≈ a 2 km² commercial block)

// Travel times depend only on road densities and the block layout, so cache them:
// changing a block's function (the common edit, and what the agent tries hundreds of times) skips Dijkstra.
let ttKey = '', ttCache = null;
function cachedTravelTimes(w) {
  const key = w.base.blocks.length + ':' + w.road.join('');
  if (key !== ttKey || ttCache.w !== w.base) { ttCache = { t: travelTimes(w), w: w.base }; ttKey = key; }
  return ttCache.t;
}

function evaluate(w) {
  const B = w.nb, blocks = w.base.blocks, bo = w.base.blockOf, cover = coverOf(w);
  const lst = heat(w, cover), fl = flood(w, cover), tt = cachedTravelTimes(w);
  const area = blocks.map(b => b.cells.length * CELL_KM * CELL_KM);   // km²

  // Each factory adds jobs to the block it stands in.
  const extraJobs = new Float32Array(B);
  for (const F of w.factories) { const b = blockAtPoint(w, F.x, F.y); if (b >= 0) extraJobs[b] += FACTORY_JOBS; }
  // Hansen accessibility to jobs for every block; mean commute from gravity shares.
  const acc = new Float32Array(B), workers = new Float32Array(B);
  let commuteSum = 0, popSum = 0;
  for (let i = 0; i < B; i++) {
    let A = 0, tw = 0, L = 0;
    for (let j = 0; j < B; j++) {
      const t = tt[i * B + j]; if (!isFinite(t)) continue;        // unreachable (an isolated block)
      const g = Math.exp(-t / BETA), jobs = JOBS[w.func[j]] * area[j] + extraJobs[j];
      A += jobs * g; tw += jobs * g * t; L += POP[w.func[j]] * area[j] * g;
    }
    acc[i] = A; workers[i] = L;
    const p = POP[w.func[i]] * area[i];
    if (p > 0 && A > 0) { commuteSum += p * tw / A; popSum += p; }
  }

  // Industrial impact: pollution and noise decaying ~1.5 km from each factory.
  const impact = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const x = i % N + 0.5, y = ((i / N) | 0) + 0.5;
    let s = 0;
    for (const F of w.factories) s += Math.exp(-Math.hypot(x - F.x, y - F.y) * CELL_KM / FACTORY_NUISANCE_KM);
    impact[i] = s;
  }

  // Readouts, over the places people live (built cells in residential blocks).
  let n = 0, h = 0, f = 0, comp = 0;
  for (let i = 0; i < N * N; i++) {
    if (cover[i] !== C_BUILT || bo[i] < 0 || w.func[bo[i]] !== RES) continue;
    n++; h += lst[i]; f += fl[i]; comp += impact[i];
  }
  n = n || 1;
  // Output: each factory produces more when more workers can reach it.
  let output = 0;
  for (const F of w.factories) { const b = blockAtPoint(w, F.x, F.y); output += 0.5 + 0.5 * Math.min(1, (b >= 0 ? workers[b] : 0) / 40); }
  const counts = new Array(7).fill(0); for (const v of w.func) counts[v]++;
  counts[IND] = w.factories.length;          // industry now lives in point facilities

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
    r,
    lst: 26 + 10 * h / n,                       // rough °C mapping; calibrate with Rin's LST
    flood: f / n,
    commute: popSum ? commuteSum / popSum : 0,  // minutes
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
  let accMax = 0; for (const v of acc) accMax = Math.max(accMax, v);
  if (w.accRef == null) w.accRef = accMax || 1;
  // Fields for display on fixed scales (so changes stay visible between edits).
  const accCell = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) accCell[i] = bo[i] >= 0 ? Math.min(1, acc[bo[i]] / w.accRef) : 0;
  return {
    cover, read, counts,
    // Relative LST is shown as an anomaly: ±2 standard deviations around this world's starting
    // mean (fixed per world, so later edits still shift the colours). Same rule as the observed
    // LST in the reveal, so the two tiles compare like with like.
    lst: lst.map(v => Math.max(0, Math.min(1, 0.5 + (v - lstRef) / (4 * lstSd)))),
    flood: fl.map(v => Math.min(1, v / 6)),
    access: accCell,
    impact: impact.map(v => Math.min(1, v / 2)),
  };
}
