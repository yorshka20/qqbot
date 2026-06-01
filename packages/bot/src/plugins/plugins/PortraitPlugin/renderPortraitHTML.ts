// Radar-chart HTML for a user's portrait. Pure inline SVG (no chart library),
// rendered to an image by the shared BrowserService. The `.portrait-container`
// element is what the screenshot clips to.

export interface PortraitRenderAxis {
  name: string;
  /** 0..100 normalized radar value. */
  value: number;
  /** Raw accumulated score, shown next to the axis label. */
  raw: number;
}

export interface PortraitRenderData {
  title: string;
  subtitle?: string;
  axes: PortraitRenderAxis[];
}

const SIZE = 560; // svg viewport
const CENTER = SIZE / 2;
const RADIUS = 190; // outer ring radius
const RINGS = 4;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** Angle (radians) for axis i of n, starting at the top and going clockwise. */
function axisAngle(i: number, n: number): number {
  return -Math.PI / 2 + (i * 2 * Math.PI) / n;
}

function pointAt(angle: number, r: number): [number, number] {
  return [CENTER + r * Math.cos(angle), CENTER + r * Math.sin(angle)];
}

function buildSvg(axes: PortraitRenderAxis[]): string {
  const n = axes.length;

  // Concentric grid rings.
  let rings = '';
  for (let ring = 1; ring <= RINGS; ring++) {
    const r = (RADIUS * ring) / RINGS;
    const pts = axes
      .map((_, i) => {
        const [x, y] = pointAt(axisAngle(i, n), r);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    rings += `<polygon points="${pts}" class="grid" />`;
  }

  // Axis spokes + labels.
  let spokes = '';
  let labels = '';
  axes.forEach((axis, i) => {
    const angle = axisAngle(i, n);
    const [ex, ey] = pointAt(angle, RADIUS);
    spokes += `<line x1="${CENTER}" y1="${CENTER}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" class="spoke" />`;

    const [lx, ly] = pointAt(angle, RADIUS + 34);
    const cos = Math.cos(angle);
    const anchor = Math.abs(cos) < 0.25 ? 'middle' : cos > 0 ? 'start' : 'end';
    labels +=
      `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" class="axis-label">` +
      `${escapeHtml(axis.name)}<tspan class="axis-raw" dx="6">${axis.raw}</tspan></text>`;
  });

  // Value polygon + vertex dots.
  const valuePts = axes
    .map((axis, i) => {
      const v = Math.max(0, Math.min(100, axis.value));
      const [x, y] = pointAt(axisAngle(i, n), (RADIUS * v) / 100);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const dots = axes
    .map((axis, i) => {
      const v = Math.max(0, Math.min(100, axis.value));
      const [x, y] = pointAt(axisAngle(i, n), (RADIUS * v) / 100);
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" class="dot" />`;
    })
    .join('');

  return `
    <svg viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
      ${rings}
      ${spokes}
      <polygon points="${valuePts}" class="value-area" />
      ${dots}
      ${labels}
    </svg>`;
}

export function renderPortraitHTML(data: PortraitRenderData): string {
  const svg = buildSvg(data.axes);
  const subtitle = data.subtitle ? `<div class="subtitle">${escapeHtml(data.subtitle)}</div>` : '';

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: transparent; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .portrait-container {
    width: ${SIZE + 60}px;
    padding: 32px 30px 26px;
    background: linear-gradient(160deg, #1b1f2e 0%, #2a2140 100%);
    border-radius: 24px;
    color: #e8eaf2;
  }
  .header { text-align: center; margin-bottom: 6px; }
  .title { font-size: 30px; font-weight: 700; letter-spacing: 1px; }
  .subtitle { font-size: 15px; color: #9aa0b8; margin-top: 4px; }
  svg { display: block; margin: 4px auto 0; }
  .grid { fill: none; stroke: rgba(255,255,255,0.10); stroke-width: 1; }
  .spoke { stroke: rgba(255,255,255,0.14); stroke-width: 1; }
  .value-area { fill: rgba(124,131,255,0.32); stroke: #7c83ff; stroke-width: 2.5; stroke-linejoin: round; }
  .dot { fill: #fff; stroke: #7c83ff; stroke-width: 2; }
  .axis-label { fill: #d7dbf0; font-size: 17px; font-weight: 600; }
  .axis-raw { fill: #7f86b5; font-size: 13px; font-weight: 400; }
</style>
</head>
<body>
  <div class="portrait-container">
    <div class="header">
      <div class="title">${escapeHtml(data.title)}</div>
      ${subtitle}
    </div>
    ${svg}
  </div>
</body>
</html>`;
}
