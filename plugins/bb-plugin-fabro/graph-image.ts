import type { RunGraph } from './graph-contract';

const COLORS: Record<string, [string, string]> = {
  succeeded: ['#dcfce7', '#15803d'], running: ['#dbeafe', '#2563eb'],
  failed: ['#fee2e2', '#b91c1c'], skipped: ['#f1f5f9', '#64748b'],
  partially_succeeded: ['#fef3c7', '#a16207'],
};
export function latestStages(graph: RunGraph) {
  const latest = new Map<string, RunGraph['stages'][number]>();
  for (const stage of graph.stages) {
    if ((latest.get(stage.node_id)?.visit ?? -1) <= stage.visit) latest.set(stage.node_id, stage);
  }
  return latest;
}

// Keep SVG geometry as data; never insert remote markup into the page DOM.
// An allowlisted SVG is rendered in an image context, without links or scripts.
export function graphImage(graph: RunGraph) {
  const doc = new DOMParser().parseFromString(graph.svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || doc.querySelector('parsererror')) throw new Error('Invalid Fabro graph');
  const tags = new Set(['svg', 'g', 'title', 'text', 'tspan', 'path', 'polygon', 'polyline', 'ellipse', 'circle', 'rect', 'line']);
  const attrs = new Set(['viewBox', 'width', 'height', 'transform', 'points', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'text-anchor', 'font-size', 'font-family', 'stroke-width', 'stroke-dasharray', 'class']);
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (!tags.has(el.localName)) { el.remove(); continue; }
    for (const attr of Array.from(el.attributes)) if (!attrs.has(attr.name)) el.removeAttribute(attr.name);
    if (['path', 'polygon', 'polyline', 'ellipse', 'circle', 'rect', 'line'].includes(el.localName)) {
      el.setAttribute('fill', 'none'); el.setAttribute('stroke', '#94a3b8');
    }
    if (['text', 'tspan'].includes(el.localName)) el.setAttribute('fill', '#334155');
  }
  for (const arrow of Array.from(root.querySelectorAll('g.edge polygon'))) arrow.setAttribute('fill', '#94a3b8');
  const latest = latestStages(graph);
  for (const node of Array.from(root.querySelectorAll('g.node'))) {
    const id = node.querySelector('title')?.textContent ?? '';
    const status = latest.get(id)?.status ?? 'pending';
    const [fill, stroke] = COLORS[status] ?? ['#f8fafc', '#94a3b8'];
    for (const shape of Array.from(node.querySelectorAll('polygon, ellipse, rect, circle'))) {
      shape.setAttribute('fill', fill); shape.setAttribute('stroke', stroke); shape.setAttribute('stroke-width', '1.5');
    }
    for (const line of Array.from(node.querySelectorAll('path, polyline'))) line.setAttribute('stroke', stroke);
  }
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(root));
}
