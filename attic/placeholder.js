// PLACEHOLDER WORLD + FIELDS — exists only so the shell has something to draw.
// These are crude stand-ins, not the engine's mechanisms (see BRIEF.md).
// The engine will replace computeFields() with the real heat / runoff / access / impact models.

const N = 30;
const RES = 0, COM = 1, IND = 2, PARK = 3, WET = 4, WATER = 5, FARM = 6;
const IMPERVIOUS = [0.7, 0.85, 0.9, 0.1, 0, 0, 0.15];

const riverX = y => 19 + 2 * Math.sin(y / 5);

function makeWorld() {
  const type = new Uint8Array(N * N).fill(FARM);
  const locked = new Uint8Array(N * N);
  const z = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, dx = x - riverX(y);
    z[i] = Math.abs(dx) * 0.3 + 0.4 * Math.sin(x / 4) * Math.cos(y / 6);
    if (Math.abs(dx) < 1) { type[i] = WATER; locked[i] = 1; continue; }
    // Old town: a locked historical core west of the river.
    const ox = x - 12, oy = y - 13, r = Math.hypot(ox, oy);
    if (r < 4.2) { type[i] = r < 1.8 ? COM : RES; locked[i] = 1; }
  }
  return { type, locked, z, road: new Uint8Array(N * N).fill(1) };
}

function blur(src, r) {
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0, n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      s += src[ny * N + nx]; n++;
    }
    out[y * N + x] = s / n;
  }
  return out;
}

const normalize = a => {
  let lo = Infinity, hi = -Infinity;
  for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return a.map(v => (v - lo) / ((hi - lo) || 1));
};

function computeFields(w) {
  // Float32Array.from, not w.type.map: mapping a Uint8Array truncates 0.7 → 0.
  const imp = Float32Array.from(w.type, t => IMPERVIOUS[t]);
  const cool = Float32Array.from(w.type, t => (t === PARK || t === WET || t === WATER) ? 1 : 0);
  const b1 = blur(imp, 2), b2 = blur(cool, 1);
  const lst = normalize(b1.map((v, i) => v - 0.35 * b2[i]));

  let zmax = 0; for (const v of w.z) zmax = Math.max(zmax, v);
  const flood = normalize(blur(imp.map((v, i) => v * (1 - w.z[i] / zmax)), 1));

  const jobs = [], fac = [];
  for (let i = 0; i < N * N; i++) { if (w.type[i] === COM || w.type[i] === IND) jobs.push(i); if (w.type[i] === IND) fac.push(i); }
  const near = (i, set, L) => {
    const x = i % N, y = (i / N) | 0; let s = 0;
    for (const j of set) s += Math.exp(-Math.hypot(j % N - x, ((j / N) | 0) - y) / L);
    return s;
  };
  const access = normalize(Float32Array.from({ length: N * N }, (_, i) => near(i, jobs, 6)));
  const impact = normalize(Float32Array.from({ length: N * N }, (_, i) => near(i, fac, 2.5)));

  // Readouts over residential blocks.
  let n = 0, h = 0, f = 0, a = 0, c = 0;
  for (let i = 0; i < N * N; i++) if (w.type[i] === RES) { n++; h += lst[i]; f += flood[i]; a += access[i]; c += impact[i]; }
  n = n || 1;
  const read = {
    lst: h / n, flood: f / n, commute: 1 - a / n,
    output: fac.length * (0.4 + 0.6 * a / n), complaints: Math.round(c * 10),
  };
  const counts = [0, 0, 0, 0, 0, 0, 0]; for (const t of w.type) counts[t]++;
  return { lst, flood, access, impact, read, counts };
}
