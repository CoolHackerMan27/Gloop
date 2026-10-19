// src/viewer.js — builds a standalone interactive HTML viewer for a card set.
// The card JSON is embedded, and the page can also load any other cards.json
// from disk, so the graph is always derived from the cards themselves.
// With opts.live (used by `crc view --watch`) the page polls ./cards.json and
// redraws when the cards change. Plain black-on-white, UML-style: classes are
// boxes (with a «stereotype» for actors, interfaces and external systems) and
// each arrow is labelled with the contract number(s) the client uses.

const { contractLabels } = require('./lib.js');

function viewerHtml(data, opts = {}) {
  const title = opts.title || 'CRC Collaboration Viewer';
  const cards = data.cards || data;
  const payload = JSON.stringify({ cards, walkthroughs: data.walkthroughs || [], contracts: Object.fromEntries(contractLabels(cards)) }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, '&lt;')}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/layout-base@2.0.1/layout-base.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cose-base@2.2.0/cose-base.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-fcose@2.2.0/cytoscape-fcose.js"></script>
<style>
:root {
  --bg: #ffffff; --panel: #ffffff; --ink: #000000; --muted: #555555; --line: #bdbdbd;
  --card: #ffffff; --rule: #000000; --accent: #000000; --warn: #000000; --ok: #000000;
  --node: #ffffff; --node-ink: #000000; --group: #ffffff; --edge: #000000;
}
* { box-sizing: border-box; }
body { margin: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
header h1 { font-size: 16px; margin: 0 12px 0 0; }
.stats { color: var(--muted); font-size: 13px; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; align-items: center; }
input[type=search], select, button, label.file { font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 5px 9px; }
label.file { cursor: pointer; }
#wt { max-width: 260px; }
label.file input { display: none; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 16px; border-bottom: 1px solid var(--line); }
.chip { font-size: 12px; border: 1px solid var(--line); border-radius: 3px; padding: 3px 10px; cursor: pointer; user-select: none; background: var(--panel); }
.chip.off { opacity: 0.4; text-decoration: line-through; }
main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 380px; }
#cy { width: 100%; height: 100%; }
aside { border-left: 1px solid var(--line); background: var(--panel); overflow: auto; padding: 16px; }
aside .hint { color: var(--muted); }
.crc { background: var(--card); border: 1px solid #000; }
.crc h2 { margin: 0; padding: 10px 12px; font-size: 16px; border-bottom: 2px solid var(--rule); }
.crc h2 small { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 6px; }
.crc .meta { padding: 6px 12px; font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--rule); }
.crc table { width: 100%; border-collapse: collapse; font-size: 13px; }
.crc td { padding: 5px 12px; border-bottom: 1px solid var(--rule); vertical-align: top; }
.crc td.col { width: 38%; border-left: 1px solid var(--rule); }
.crc .reqs { color: var(--muted); font-size: 11px; }
.crc .back { padding: 10px 12px; font-style: italic; font-size: 13px; }
.tag { display: inline-block; font-size: 10px; font-weight: 600; padding: 0 4px; margin-right: 4px; border: 1px solid #000; }
.link { color: var(--accent); cursor: pointer; text-decoration: underline; }
.dangling { color: var(--warn); }
.edgebox h3, .wt h3 { margin: 0 0 8px; font-size: 15px; }
.wt ol { padding-left: 20px; }
.wt li.bad { color: var(--warn); }
@media (max-width: 760px) {
  body { height: auto; overflow-x: hidden; overflow-y: auto; }
  .controls { width: 100%; }
  .controls > * { flex: 1 1 140px; min-width: 0; }
  #wt { max-width: none; }
  main { grid-template-columns: minmax(0, 1fr); grid-template-rows: 60vh auto; }
  aside { border-left: 0; border-top: 1px solid var(--line); }
  .controls { margin-left: 0; }
}
</style>
</head>
<body>
<header>
  <h1>${title.replace(/</g, '&lt;')}</h1>
  <span class="stats" id="stats"></span>
  <div class="controls">
    <input type="search" id="q" placeholder="Find a class…" aria-label="Find a class">
    <select id="wt" aria-label="Highlight a scenario"><option value="">Highlight scenario…</option></select>
    <select id="layout" aria-label="Layout"><option value="fcose">Grouped by subsystem</option><option value="cose">Force layout</option><option value="breadthfirst">Hierarchy</option><option value="concentric">Concentric</option></select>
    <label class="file">Load cards.json<input type="file" id="file" accept=".json,application/json"></label>
  </div>
</header>
<div class="chips" id="chips"></div>
<main>
  <div id="cy"></div>
  <aside id="side"><p class="hint">Click a class to see its card. Click an arrow to see which responsibilities need that collaborator.</p></aside>
</main>
<script>
let DATA = ${payload};
const LIVE = ${opts.live ? 'true' : 'false'};
let cy, hidden = new Set();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function build() {
  const cards = DATA.cards || [];
  const byId = new Map(cards.map((c) => [c.id, c]));
  const subs = [...new Set(cards.map((c) => c.subsystem || 'Unassigned'))];
  const els = subs.map((s) => ({ data: { id: 'sub:' + s, label: s, group: true } }));
  for (const c of cards) els.push({ data: { id: c.id, label: (c.kind && c.kind !== 'class' ? '«' + c.kind + '»\\n' : '') + (c.name || c.id), parent: 'sub:' + (c.subsystem || 'Unassigned'), kind: c.kind || 'class', n: (c.responsibilities || []).length } });
  const edges = new Map();
  for (const c of cards) for (const r of c.responsibilities || []) for (const to of r.collaborators || []) {
    if (to === c.id) continue;
    if (!byId.has(to) && !els.find((e) => e.data.id === to)) els.push({ data: { id: to, label: '⚠ ' + to, kind: 'dangling' } });
    const k = c.id + '->' + to;
    if (!edges.has(k)) edges.set(k, { data: { id: k, source: c.id, target: to, resps: [] } });
    edges.get(k).data.resps.push(r.id + ': ' + r.text);
  }
  for (const e of edges.values()) { e.data.w = e.data.resps.length; e.data.contract = (DATA.contracts || {})[e.data.id] || ''; els.push(e); }

  // Keep node positions across a live reload when the set of classes is unchanged.
  const prevPos = cy ? Object.fromEntries(cy.nodes('[!group]').map((n) => [n.id(), { ...n.position() }])) : null;
  if (cy) cy.destroy();
  cy = cytoscape({
    container: $('cy'), elements: els, wheelSensitivity: 0.25,
    style: [
      { selector: 'node', style: { label: 'data(label)', 'font-size': 12, color: '#000', 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'background-color': '#fff', shape: 'rectangle', width: 'label', height: 'label', padding: 10, 'border-width': 1.2, 'border-color': '#000' } },
      { selector: 'node[kind = "dangling"]', style: { 'border-style': 'dashed' } },
      { selector: 'node[?group]', style: { 'background-color': '#fff', 'border-color': '#999', 'border-style': 'dashed', 'border-width': 1, label: 'data(label)', 'text-valign': 'top', 'text-halign': 'center', color: '#555', 'font-size': 12, shape: 'rectangle', padding: 14 } },
      { selector: 'edge', style: { width: 1, 'line-color': '#000', 'target-arrow-color': '#000', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': 0.9, opacity: 0.55, label: 'data(contract)', 'font-size': 10, color: '#000', 'text-background-color': '#fff', 'text-background-opacity': 1, 'text-background-padding': 1 } },
      { selector: '.faded', style: { opacity: 0.12 } },
      { selector: '.hl', style: { width: 2.2, 'border-width': 2.4, opacity: 1, 'z-index': 9 } },
      { selector: '.bad', style: { 'line-style': 'dashed', width: 2, opacity: 1 } },
    ],
  });
  const ids = cy.nodes('[!group]').map((n) => n.id());
  if (prevPos && ids.length === Object.keys(prevPos).length && ids.every((id) => prevPos[id])) {
    cy.layout({ name: 'preset', positions: (n) => prevPos[n.id()], fit: false, animate: false }).run();
  } else relayout();
  cy.on('tap', 'node[!group]', (e) => focusNode(e.target.id()));
  cy.on('tap', 'edge', (e) => showEdge(e.target));
  cy.on('tap', (e) => { if (e.target === cy) clearHL(); });

  const resps = cards.flatMap((c) => c.responsibilities || []);
  $('stats').textContent = cards.length + ' cards · ' + resps.length + ' responsibilities · ' + edges.size + ' collaborations';
  $('chips').innerHTML = subs.map((s) => '<span class="chip" data-s="' + esc(s) + '">' + esc(s) + '</span>').join('');
  $('wt').innerHTML = '<option value="">Highlight scenario…</option>' + (DATA.walkthroughs || []).map((w, i) => '<option value="' + i + '">' + esc(w.scenarioId + ' — ' + (w.title || '')) + '</option>').join('');
  hidden.clear();
}

function relayout() {
  const name = $('layout').value;
  const opts = {
    fcose: { name: 'fcose', quality: 'proof', animate: false, randomize: true, padding: 24, nodeRepulsion: 12000, idealEdgeLength: 110, edgeElasticity: 0.3, nestingFactor: 0.15, gravityCompound: 1.2, tilingPaddingVertical: 20, tilingPaddingHorizontal: 20, nodeSeparation: 90 },
    cose: { name: 'cose', animate: false, nodeRepulsion: 12000, idealEdgeLength: 110, padding: 24, componentSpacing: 80, nestingFactor: 1.2 },
  }[name] || { name, animate: false, padding: 24, spacingFactor: 1.1 };
  if (opts.name === 'fcose' && typeof cytoscapeFcose === 'undefined') opts.name = 'cose'; // CDN unavailable
  cy.layout(opts).run();
}

function clearHL() { cy.elements().removeClass('faded hl bad'); }

function focusNode(id) {
  clearHL();
  const n = cy.getElementById(id);
  const hood = n.closedNeighborhood();
  cy.elements('[!group]').not(hood).addClass('faded');
  hood.edges().addClass('hl');
  n.addClass('hl');
  showCard(id);
}

function showCard(id) {
  const c = (DATA.cards || []).find((x) => x.id === id);
  if (!c) { $('side').innerHTML = '<p class="dangling">⚠ <b>' + esc(id) + '</b> is named as a collaborator but has no card.</p>'; return; }
  const known = new Set(DATA.cards.map((x) => x.id));
  const users = DATA.cards.filter((x) => (x.responsibilities || []).some((r) => (r.collaborators || []).includes(id))).map((x) => x.id);
  const ref = (r, x) => (r.contractRefs && r.contractRefs[x] != null ? ' (' + r.contractRefs[x] + ')' : '');
  const col = (r) => (r.collaborators || []).map((x) => known.has(x) ? '<span class="link" data-go="' + esc(x) + '">' + esc(x) + '</span>' + ref(r, x) : '<span class="dangling">⚠ ' + esc(x) + '</span>').join(', ') || '—';
  const contractOf = {};
  for (const k of c.contracts || []) for (const rid of k.responsibilities || []) contractOf[rid] = k.number;
  const contracts = (c.contracts || []).length ? '<div class="meta">Contracts: ' + c.contracts.map((k) => esc(k.number + '. ' + k.name)).join('; ') + '</div>' : '';
  const tag = (r) => (c.contracts || []).length ? ' <span class="reqs">' + (contractOf[r.id] != null ? 'contract ' + contractOf[r.id] : 'private') + '</span>' : '';
  $('side').innerHTML = '<div class="crc"><h2>' + esc(c.name || c.id) + '<small>' + esc(c.kind || 'class') + ' · ' + esc(c.subsystem || '') + '</small></h2>' +
    '<div class="meta">Superclass: ' + esc(c.superclass || 'none') + ' · Subclasses: ' + esc((c.subclasses || []).join(', ') || 'none') + '</div>' + contracts +
    '<table>' + (c.responsibilities || []).map((r) => '<tr><td><span class="tag">' + r.type + '</span>' + esc(r.text) + tag(r) + (r.reqs && r.reqs.length ? '<div class="reqs">' + esc(r.reqs.join(', ')) + '</div>' : '') + '</td><td class="col">' + col(r) + '</td></tr>').join('') + '</table>' +
    '<div class="back">' + esc(c.purpose || 'No purpose on the card back.') + '</div></div>' +
    '<p class="hint">Used by: ' + (users.map((u) => '<span class="link" data-go="' + esc(u) + '">' + esc(u) + '</span>').join(', ') || 'nobody') + '</p>';
}

function showEdge(e) {
  clearHL();
  cy.elements('[!group]').not(e.union(e.connectedNodes())).addClass('faded');
  e.addClass('hl');
  $('side').innerHTML = '<div class="edgebox"><h3>' + esc(e.data('source')) + ' → ' + esc(e.data('target')) + '</h3><p class="hint">Responsibilities of ' + esc(e.data('source')) + ' that need this collaborator:</p><ul>' + e.data('resps').map((r) => '<li>' + esc(r) + '</li>').join('') + '</ul></div>';
}

function showWalkthrough(i) {
  clearHL();
  const w = (DATA.walkthroughs || [])[i];
  if (!w) return;
  const items = [];
  cy.elements('[!group]').addClass('faded');
  for (const s of w.steps || []) {
    if (s.break) { items.push('<li class="bad">❌ BREAK — missing: ' + esc(s.missing) + (s.reason ? ' (' + esc(s.reason) + ')' : '') + '</li>'); break; }
    const to = (DATA.cards || []).find((c) => c.id === s.to);
    const r = to && (to.responsibilities || []).find((x) => x.id === s.responsibilityId);
    const edge = cy.getElementById(s.from + '->' + s.to);
    [s.from, s.to].forEach((id) => cy.getElementById(id).removeClass('faded').addClass('hl'));
    const ok = r && (s.from === s.to || edge.length);
    if (edge.length) edge.removeClass('faded').addClass('hl');
    items.push('<li class="' + (ok ? '' : 'bad') + '">' + esc(s.from) + ' → ' + esc(s.to) + '.' + esc(s.responsibilityId) + (r ? ': ' + esc(r.text) : ' ⚠ not on card') + (!ok && r ? ' ⚠ no collaboration edge' : '') + '</li>');
  }
  $('side').innerHTML = '<div class="wt"><h3>' + esc(w.scenarioId + ' — ' + (w.title || '')) + '</h3><ol>' + items.join('') + '</ol></div>';
}

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { focusNode(go.dataset.go); return; }
  const chip = e.target.closest('.chip');
  if (chip) {
    const s = chip.dataset.s;
    hidden.has(s) ? hidden.delete(s) : hidden.add(s);
    chip.classList.toggle('off');
    const g = cy.getElementById('sub:' + s);
    g.union(g.children()).style('display', hidden.has(s) ? 'none' : 'element');
  }
});
$('q').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  clearHL();
  if (!q) return;
  const hits = cy.nodes('[!group]').filter((n) => n.data('label').toLowerCase().includes(q));
  cy.elements('[!group]').not(hits).addClass('faded');
  hits.addClass('hl');
  if (hits.length === 1) showCard(hits[0].id());
});
$('wt').addEventListener('change', (e) => e.target.value === '' ? clearHL() : showWalkthrough(+e.target.value));
$('layout').addEventListener('change', relayout);
$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const parsed = JSON.parse(await f.text());
    DATA = Array.isArray(parsed) ? { cards: parsed, walkthroughs: [], contracts: {} } : { cards: parsed.cards || [], walkthroughs: parsed.walkthroughs || [], contracts: parsed.contracts || {} };
    build();
  } catch (err) { alert('Could not read that file as a card set: ' + err.message); }
});
build();
if (LIVE) {
  let last = JSON.stringify(DATA);
  setInterval(async () => {
    try {
      const res = await fetch('./cards.json', { cache: 'no-store' });
      if (!res.ok) return;
      const text = await res.text();
      if (text === last) return;
      last = text;
      const parsed = JSON.parse(text);
      const view = cy.extent && { zoom: cy.zoom(), pan: { ...cy.pan() } };
      DATA = { cards: parsed.cards || [], walkthroughs: parsed.walkthroughs || [], contracts: parsed.contracts || {} };
      build();
      if (view) { cy.zoom(view.zoom); cy.pan(view.pan); }
      $('stats').textContent += ' · live';
    } catch (e) { /* server stopped or file mid-write; try again next tick */ }
  }, 1500);
}
</script>
</body>
</html>
`;
}

module.exports = { viewerHtml };
