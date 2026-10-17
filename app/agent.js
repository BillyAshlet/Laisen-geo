// AGENT — rule-based, no language model. Perceive → evaluate every legal one-block
// change → suggest the best few, each with a reason derived from the mechanisms.
// Constraints are kept: a change may not drop residential or industrial blocks below target.

const AGENT_WEIGHTS = [1, 1, 1];   // heat, flood, commute (equal for now)

function score(read) {
  const b = badness(read);
  return b[0] * AGENT_WEIGHTS[0] + b[1] * AGENT_WEIGHTS[1] + b[2] * AGENT_WEIGHTS[2] + read.complaints / 200;
}

// Blocks whose runoff passes through a lived-in cell on its way downhill.
function upstreamOfHomes(w, cover) {
  const home = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) home[i] = cover[i] === C_BUILT && w.base.blockOf[i] >= 0 && w.func[w.base.blockOf[i]] === RES ? 1 : 0;
  const up = new Float32Array(w.nb), bo = w.base.blockOf;
  for (let i = 0; i < N * N; i++) {
    const b = bo[i]; if (b < 0) continue;
    for (let j = w.base.recv[i], s = 0; j >= 0 && s < 300; j = w.base.recv[j], s++) {
      if (bo[j] !== b && home[j]) { up[b]++; break; }
    }
  }
  return up;
}

function adjacentHomes(w, b) {
  return w.base.blocks[b].nbrs.filter(n => w.func[n] === RES).length;
}

// Mean elevation of a block, relative to the whole map (0 = lowest, 1 = highest).
function blockLowness(w, b) {
  const cells = w.base.blocks[b].cells; let s = 0;
  for (const i of cells) s += w.base.z[i];
  return (s / cells.length - w.base.zlo) / (w.base.zhi - w.base.zlo);
}

// Reasons for a swap: the mover (fa) leaves block a and arrives at block b; fb goes the other way.
function reasonFor(w, a, b, fa, fb, up) {
  const R = T().reasons, out = [];
  if ((fa === WET || fa === PARK) && up[b] > 3) out.push(R.upstream);
  if ((fa === WET || fa === PARK) && adjacentHomes(w, b) >= 2) out.push(R.coolsHomes);
  if (fa === IND && adjacentHomes(w, a) >= 1 && adjacentHomes(w, b) < adjacentHomes(w, a)) out.push(R.industryOut);
  if (fb === RES && blockLowness(w, b) < 0.35 && blockLowness(w, a) > blockLowness(w, b)) out.push(R.homesUphill);
  return out.length ? out.join(R.and) : R.generic;
}

// Two kinds of move, both keep every count the same, so the agent can only rearrange,
// never "solve" by deleting homes or adding parks:
//  - SWAP the functions of a green/wetland block and another block;
//  - MOVE a factory to the centre of another block.
// Runs in small chunks so the log can print progress while it works.
function homesWithin(w, x, y, km) {
  return w.base.blocks.filter((B, b) => w.func[b] === RES && Math.hypot(B.cx - x, B.cy - y) * CELL_KM < km).length;
}
function delta(base, r) {
  return { lst: r.lst - base.lst, flood: (r.flood / base.flood - 1) * 100, commute: r.commute - base.commute, comp: r.complaints - base.complaints };
}
async function runAgent(w, onLine) {
  const L = T();
  const base = evaluate(w), baseScore = score(base.read);
  onLine(L.agentPerceive(base.read), '');
  const movers = [], cands = [];
  for (let b = 0; b < w.nb; b++) if (!w.locked[b] && (w.func[b] === PARK || w.func[b] === WET)) movers.push(b);
  let tried = 0;
  for (const a of movers) {
    for (let b = 0; b < w.nb; b++) {
      if (b === a || w.locked[b] || w.func[b] === w.func[a]) continue;
      const fa = w.func[a], fb = w.func[b];
      const ea = w.edited[a], eb = w.edited[b];
      w.func[a] = fb; w.func[b] = fa; w.edited[a] = w.edited[b] = 1;
      const r = evaluate(w).read;
      w.func[a] = fa; w.func[b] = fb; w.edited[a] = ea; w.edited[b] = eb; tried++;
      cands.push({ kind: 'swap', a, b, fa, fb, r, gain: baseScore - score(r) });
    }
    await new Promise(res => setTimeout(res, 0));   // let the page breathe between movers
  }
  w.factories.forEach((F, k) => {
    const from = { x: F.x, y: F.y };
    w.base.blocks.forEach((B, b) => {
      if (w.locked[b]) return;
      F.x = B.cx + 0.5; F.y = B.cy + 0.5;
      const r = evaluate(w).read; tried++;
      cands.push({ kind: 'move', k, from, to: { x: F.x, y: F.y }, b, r, gain: baseScore - score(r) });
    });
    F.x = from.x; F.y = from.y;
  });
  onLine(L.agentTried(tried, movers.length, w.factories.length), '');
  const up = upstreamOfHomes(w, base.cover);
  const best = cands.filter(c => c.gain > 0.002).sort((x, y) => y.gain - x.gain);
  // Top three; each block or factory used at most once.
  const used = new Set(), picks = [];
  for (const c of best) {
    const keys = c.kind === 'swap' ? ['b' + c.a, 'b' + c.b] : ['f' + c.k, 'b' + c.b];
    if (keys.some(k => used.has(k))) continue;
    keys.forEach(k => used.add(k)); picks.push(c); if (picks.length === 3) break;
  }
  if (!picks.length) { onLine(movers.length || w.factories.length ? L.agentNone : L.agentNoMovers, 'good'); return []; }
  for (const c of picks) {
    const d = delta(base.read, c.r);
    if (c.kind === 'swap') {
      onLine(L.agentSuggest(c.a, L.types[c.fa], c.b, L.types[c.fb], d, reasonFor(w, c.a, c.b, c.fa, c.fb, up)), 'warn', c);
    } else {
      const R = T().reasons, why = [];
      if (homesWithin(w, c.to.x, c.to.y, FACTORY_NUISANCE_KM) < homesWithin(w, c.from.x, c.from.y, FACTORY_NUISANCE_KM)) why.push(R.industryOut);
      if (d.commute < -0.05) why.push(R.factoryWorkers);
      onLine(L.agentMove(c.k + 1, c.b, d, why.length ? why.join(R.and) : R.generic), 'warn', c);
    }
  }
  return picks;
}
