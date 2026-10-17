// AGENT — rule-based, no language model. Perceive → diagnose → evaluate every small legal
// move → suggest the best few, each with a reason derived from the mechanisms.
// Moves: nudge one block's green ratio or intensity one step; move a facility to another block;
// or build a new park / pond / factory where the siting rules and the budget allow.
// Constraint: people stay housed. If the plan is already short of the target, a move may not
// make it worse (otherwise every move would be rejected and the agent would have nothing to say).

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

// Diagnosis: the residential blocks that are hottest and most flood-prone right now.
function diagnose(w, f) {
  const res = [...Array(w.nb).keys()].filter(b => w.use[b] === RES && f.pop[b] > 0);
  const hot = [...res].sort((a, b) => f.blockLst[b] - f.blockLst[a]).slice(0, 3);
  const wet = [...res].sort((a, b) => f.blockFlood[b] - f.blockFlood[a]).slice(0, 3);
  const far = [...res].sort((a, b) => f.commuteB[b] - f.commuteB[a]).slice(0, 3);
  const dense = [...res].sort((a, b) => f.pop[b] / w.base.blocks[b].cells.length - f.pop[a] / w.base.blocks[a].cells.length).slice(0, 3);
  return { hot, wet, far, dense };
}

// hooks: onLine(text, cls, suggestion), onTotal(n), onCand(candidate, accepted)
async function runAgent(w, hooks) {
  const L = T(), R = L.reasons, { onLine, onTotal = () => {}, onCand = () => {} } = hooks;
  const base = evaluate(w), baseScore = score(base.read);
  const minPop = Math.min(w.popTarget * 0.98, base.read.pop * 0.999);
  const cands = [];
  let tried = 0, rejected = 0;
  const consider = (c, r) => {
    tried++; c.r = r; c.gain = baseScore - score(r);
    const ok = r.pop >= minPop;
    if (!ok) rejected++; else cands.push(c);
    onCand(c, ok, base.read);
  };

  // Count what we are about to try, so the view can show progress.
  const editableBlocks = [...Array(w.nb).keys()].filter(b => editable(w, b));
  const openBlocks = [...Array(w.nb).keys()].filter(b => !w.locked[b]);
  onTotal(editableBlocks.length * 4 + w.facilities.length * openBlocks.length + 2 * openBlocks.length + 50);

  // 1. One step on one block's sliders.
  for (const [n, b] of editableBlocks.entries()) {
    const e0 = w.edited[b];
    for (const [key, step, lo, hi] of [['green', 0.1, 0.05, 0.5], ['intensity', 0.2, 0, 1]]) {
      for (const dir of [1, -1]) {
        const from = w[key][b], to = Math.round(Math.min(hi, Math.max(lo, from + dir * step)) * 100) / 100;
        if (to === from) { tried++; continue; }
        w[key][b] = to; w.edited[b] = 1;
        consider({ kind: 'slider', b, key, from, to }, evaluate(w).read);
        w[key][b] = from; w.edited[b] = e0;
      }
    }
    if (n % 4 === 3) await new Promise(res => setTimeout(res, 0));   // let the page draw
  }
  // 2. Move each existing facility to the centre of every other open block.
  for (const [k, F] of w.facilities.entries()) {
    const from = { x: F.x, y: F.y };
    for (const b of openBlocks) {
      const B = w.base.blocks[b], x = B.cx + 0.5, y = B.cy + 0.5;
      if (siteCheck(w, F.type, x, y)) { tried++; continue; }
      F.x = x; F.y = y;
      consider({ kind: 'move', k, type: F.type, from, to: { x, y }, b }, evaluate(w).read);
    }
    F.x = from.x; F.y = from.y;
    await new Promise(res => setTimeout(res, 0));
  }
  // 3. Build one new park or factory at every open block centre, and one new pond on the
  //    runoff network (ponds only work where flow converges, so try points on the flow lines).
  const sites = { park: [], factory: [], pond: [] };
  for (const b of openBlocks) { const B = w.base.blocks[b]; sites.park.push([B.cx + 0.5, B.cy + 0.5]); sites.factory.push([B.cx + 0.5, B.cy + 0.5]); }
  const th = base.thru; const flowCells = [];
  for (let i = 0; i < N * N; i++) if (th[i] > 12 && w.base.blockOf[i] >= 0) flowCells.push(i);
  for (let k = 0; k < flowCells.length; k += Math.max(1, Math.floor(flowCells.length / 50))) sites.pond.push([flowCells[k] % N + 0.5, ((flowCells[k] / N) | 0) + 0.5]);
  for (const type of ['park', 'pond', 'factory']) {
    for (const [x, y] of sites[type]) {
      if (siteCheck(w, type, x, y)) { tried++; continue; }
      w.facilities.push({ type, x, y });
      consider({ kind: 'build', type, to: { x, y }, b: blockAtPoint(w, x, y) }, evaluate(w).read);
      w.facilities.pop();
    }
    await new Promise(res => setTimeout(res, 0));
  }
  onLine(L.agentTried(tried, rejected), '');

  const up = upstreamOfHomes(w, base.cover);
  const best = cands.filter(c => c.gain > 0.002).sort((x, y) => y.gain - x.gain);
  const used = new Set(), picks = [];
  for (const c of best) {
    const key = c.kind === 'slider' ? 'b' + c.b : c.kind === 'move' ? 'f' + c.k : 'n' + c.type;
    if (used.has(key) || used.has('b' + c.b)) continue;
    used.add(key); used.add('b' + c.b); picks.push(c); if (picks.length === 3) break;
  }
  if (!picks.length) { onLine(L.agentNone, 'good'); return { picks, base }; }

  for (const c of picks) {
    const d = delta(base.read, c.r), why = [];
    c.d = d;
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
      c.text = L.agentSlider(c.b, name, fmtV(c.from), fmtV(c.to), d, why.length ? why.join(R.and) : R.generic);
    } else {
      if (c.type === 'factory' && c.kind === 'move' && homesWithin(w, c.to.x, c.to.y, FACTORY_NUISANCE_KM) < homesWithin(w, c.from.x, c.from.y, FACTORY_NUISANCE_KM)) why.push(R.industryOut);
      if (c.type === 'factory' && d.commute < -0.05) why.push(R.factoryWorkers);
      if (c.type === 'factory' && c.kind === 'build') why.push(R.factoryIncome);
      if ((c.type === 'park' || c.type === 'pond') && up[c.b] > 3) why.push(R.upstream);
      if ((c.type === 'park' || c.type === 'pond') && adjacentHomes(w, c.b) >= 2) why.push(R.coolsHomes);
      if (c.type === 'station' && d.commute < 0) why.push(R.stationHomes);
      const text = why.length ? why.join(R.and) : R.generic;
      c.text = c.kind === 'move' ? L.agentMove(L.tools[c.type], c.b, d, text) : L.agentBuild(L.tools[c.type], c.b, d, text);
    }
    onLine(c.text, 'warn', c);
  }
  return { picks, base };
}
