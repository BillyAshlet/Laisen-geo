// AGENT — rule-based, no language model. Perceive → evaluate every small legal move →
// suggest the best few, each with a reason derived from the mechanisms.
// Moves: nudge one block's green ratio or intensity one step, or move one facility to another block.
// Constraint: everyone must stay housed (population ≥ 98% of the starting population).

const AGENT_WEIGHTS = [1, 1, 1];   // heat, flood, commute (equal for now)

function score(read) {
  const b = badness(read);
  return b[0] * AGENT_WEIGHTS[0] + b[1] * AGENT_WEIGHTS[1] + b[2] * AGENT_WEIGHTS[2] + read.complaints / 200;
}

// Blocks whose runoff passes through a lived-in cell on its way downhill.
function upstreamOfHomes(w, cover) {
  const bo = w.base.blockOf, home = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) home[i] = cover[i] === C_BUILT && bo[i] >= 0 && w.use[bo[i]] === RES ? 1 : 0;
  const up = new Float32Array(w.nb);
  for (let i = 0; i < N * N; i++) {
    const b = bo[i]; if (b < 0) continue;
    for (let j = w.base.recv[i], s = 0; j >= 0 && s < 300; j = w.base.recv[j], s++) {
      if (bo[j] !== b && home[j]) { up[b]++; break; }
    }
  }
  return up;
}
const adjacentHomes = (w, b) => w.base.blocks[b].nbrs.filter(n => w.use[n] === RES).length;
function homesWithin(w, x, y, km) {
  return w.base.blocks.filter((B, b) => w.use[b] === RES && Math.hypot(B.cx - x, B.cy - y) * CELL_KM < km).length;
}
const delta = (base, r) => ({ lst: r.lst - base.lst, flood: (r.flood / base.flood - 1) * 100, commute: r.commute - base.commute, comp: r.complaints - base.complaints });

async function runAgent(w, onLine) {
  const L = T(), R = L.reasons;
  const base = evaluate(w), baseScore = score(base.read), minPop = w.popTarget * 0.98;
  onLine(L.agentPerceive(base.read), '');
  const cands = [];
  let tried = 0, rejected = 0;
  const consider = (c, r) => {
    tried++;
    if (r.pop < minPop) { rejected++; return; }
    c.r = r; c.gain = baseScore - score(r); cands.push(c);
  };

  // 1. One step on one block's sliders.
  for (let b = 0; b < w.nb; b++) {
    if (!editable(w, b)) continue;
    const e0 = w.edited[b];
    for (const [key, step, lo, hi] of [['green', 0.1, 0.05, 0.5], ['intensity', 0.2, 0, 1]]) {
      for (const dir of [1, -1]) {
        const from = w[key][b], to = Math.round(Math.min(hi, Math.max(lo, from + dir * step)) * 100) / 100;
        if (to === from) continue;
        w[key][b] = to; w.edited[b] = 1;
        consider({ kind: 'slider', b, key, from, to }, evaluate(w).read);
        w[key][b] = from; w.edited[b] = e0;
      }
    }
    if (b % 8 === 7) await new Promise(res => setTimeout(res, 0));   // let the page breathe
  }
  // 2. Move one facility to the centre of another block.
  for (const [k, F] of w.facilities.entries()) {
    const from = { x: F.x, y: F.y };
    w.base.blocks.forEach((B, b) => {
      if (w.locked[b]) return;
      F.x = B.cx + 0.5; F.y = B.cy + 0.5;
      consider({ kind: 'move', k, type: F.type, from, to: { x: F.x, y: F.y }, b }, evaluate(w).read);
    });
    F.x = from.x; F.y = from.y;
    await new Promise(res => setTimeout(res, 0));
  }
  onLine(L.agentTried(tried, rejected), '');

  const up = upstreamOfHomes(w, base.cover);
  const best = cands.filter(c => c.gain > 0.002).sort((x, y) => y.gain - x.gain);
  const used = new Set(), picks = [];
  for (const c of best) {
    const key = c.kind === 'slider' ? 'b' + c.b : 'f' + c.k;
    if (used.has(key)) continue;
    used.add(key); picks.push(c); if (picks.length === 3) break;
  }
  if (!picks.length) { onLine(L.agentNone, 'good'); return []; }

  for (const c of picks) {
    const d = delta(base.read, c.r), why = [];
    if (c.kind === 'slider') {
      if (c.key === 'green' && c.to > c.from) {
        if (up[c.b] > 3) why.push(R.upstream);
        if (w.use[c.b] === RES || adjacentHomes(w, c.b) >= 2) why.push(R.coolsHomes);
      }
      if (c.key === 'intensity' && c.to < c.from) why.push(R.lessWasteHeat);
      if (c.key === 'intensity' && c.to > c.from) why.push(R.denserHere);
      if (c.key === 'green' && c.to < c.from) why.push(R.greenElsewhere);
      const name = c.key === 'green' ? L.greenRatio : L.intensity;
      const fmtV = v => c.key === 'green' ? Math.round(v * 100) + '%' : String(Math.round(v * 100));
      onLine(L.agentSlider(c.b, name, fmtV(c.from), fmtV(c.to), d, why.length ? why.join(R.and) : R.generic), 'warn', c);
    } else {
      if (c.type === 'factory' && homesWithin(w, c.to.x, c.to.y, FACTORY_NUISANCE_KM) < homesWithin(w, c.from.x, c.from.y, FACTORY_NUISANCE_KM)) why.push(R.industryOut);
      if (c.type === 'factory' && d.commute < -0.05) why.push(R.factoryWorkers);
      if ((c.type === 'park' || c.type === 'pond') && up[c.b] > 3) why.push(R.upstream);
      if ((c.type === 'park' || c.type === 'pond') && adjacentHomes(w, c.b) >= 2) why.push(R.coolsHomes);
      if (c.type === 'station' && d.commute < 0) why.push(R.stationHomes);
      onLine(L.agentMove(L.tools[c.type], c.b, d, why.length ? why.join(R.and) : R.generic), 'warn', c);
    }
  }
  return picks;
}
