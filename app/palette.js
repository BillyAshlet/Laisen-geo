// Colours. Hex values are estimated from a SciVisColor screenshot;
// replace with exact values from the SciVisColor colormap files before the pitch.

// DISCRETE set → block types (order matches STRINGS.types).
// Commercial uses a coral from LINEAR so it can't be confused with the ochre UI accent.
const TYPE_COLORS = ['#FCEB8F', '#E39A7E', '#857F6E', '#ABE3A9', '#82BCC4', '#5D93CB', '#C3C9B5'];
const TYPE_GLYPHS = ['⌂', '◆', '▲', '♣', '≈', '~', '·'];
const TYPE_INK = ['#2F2D28', '#2F2D28', '#FFFFFF', '#2F2D28', '#2F2D28', '#FFFFFF', '#2F2D28'];

// Ramps, low → high.
const RAMPS = {
  diverging: ['#1A0A7A', '#0B5BBF', '#00B6D8', '#7EF0D5', '#FFFBE6', '#F7E07A', '#E9A43B', '#C8541A', '#8A0B14', '#3F0010'],
  floodBlue: ['#F4F8FB', '#C6DCEE', '#86B4DA', '#4682BE', '#1D518F', '#0E2A5C'],
  access: ['#F7F3E3', '#D6E6C4', '#9FCBA8', '#5FA69E', '#2F7A7C', '#174E5A'],
  linearRed: ['#F6DCD3', '#E89A78', '#C34A3B', '#8C2131', '#4A0E1E'],
};

const hex2rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

// Sample a ramp at t ∈ [0, 1]; `bands` > 0 quantises into flat bands (contour-band look).
function rampAt(name, t, bands = 0) {
  const stops = RAMPS[name];
  t = Math.max(0, Math.min(1, t));
  if (bands) t = Math.min(bands - 1, Math.floor(t * bands)) / (bands - 1);
  const f = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), k = f - i;
  const a = hex2rgb(stops[i]), b = hex2rgb(stops[i + 1]);
  return a.map((v, j) => Math.round(v + (b[j] - v) * k));
}

const rampCss = name => `linear-gradient(90deg, ${RAMPS[name].join(',')})`;
