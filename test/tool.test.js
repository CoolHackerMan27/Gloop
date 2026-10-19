// Tests for the standalone-tool features: config, loading, Markdown format,
// requirement syntax, rule overrides, diff. Run with: node --test (from crc-tool/)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../src/lib.js');
const io = require('../src/io.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crc-test-'));
const card = (id, resps, extra = {}) => ({ id, name: id, kind: 'class', subsystem: 'S', purpose: `The purpose of ${id}.`, superclass: null, subclasses: [], responsibilities: resps, ...extra });
const R = (id, text, type, reqs, collaborators = []) => ({ id, text, type, reqs, collaborators });

test('custom requirement ID syntax: REQ-007 and FR3', (t) => {
  t.after(() => lib.setRequirementSyntax(lib.DEFAULT_REQ_SYNTAX));
  lib.setRequirementSyntax({ prefix: 'REQ', separator: '-', pad: 3 });
  assert.deepEqual(lib.parseRequirements('REQ-1: a\n- REQ-002: b\nREQ-3. c').ids, ['REQ-001', 'REQ-002', 'REQ-003']);
  assert.deepEqual(lib.expandReqRefs('REQ-1–REQ-3'), ['REQ-001', 'REQ-002', 'REQ-003']);
  lib.setRequirementSyntax({ prefix: 'FR', separator: '', pad: 1 });
  assert.deepEqual(lib.expandReqRefs('FR3, FR5–7'), ['FR3', 'FR5', 'FR6', 'FR7']);
});

test('rule overrides drop or re-grade issues', () => {
  const cards = [card('A', [R('R1', 'Knows x', 'K', [])])];
  const plain = lib.validate(lib.normalizeCards(cards));
  assert.ok(plain.warnings.some((w) => w.code === 'knowledge-only'));
  const off = lib.validate(lib.normalizeCards(cards), { rules: { 'knowledge-only': 'off' } });
  assert.ok(!off.warnings.some((w) => w.code === 'knowledge-only'));
  const err = lib.validate(lib.normalizeCards(cards), { rules: { 'knowledge-only': 'error' } });
  assert.ok(err.errors.some((e) => e.code === 'knowledge-only'));
  assert.equal(err.ok, false);
});

test('Markdown: "#" column keeps ids stable when rows are reordered', () => {
  const md = `## S

### Sender

| # | Responsibilities | Reqs | Collaborators |
|---|---|---|---|
| R2 | [B] Appends a signature | INT-03 | Doc |
| R1 | [B] Signs the document | INT-01 | \`Doc\` |

### Doc

| Responsibilities | Collaborators |
|---|---|
| Knows its content | — |
| [B] Accepts a signature | Sender |
`;
  const { cards } = lib.parseMarkdownCards(md);
  assert.deepEqual(cards[0].responsibilities.map((r) => [r.id, r.text]), [['R2', 'Appends a signature'], ['R1', 'Signs the document']]);
  assert.deepEqual(cards[1].responsibilities.map((r) => [r.id, r.type, r.collaborators]), [['R1', 'K', []], ['R2', 'B', ['Sender']]]);
  assert.deepEqual(cards[0].responsibilities[0].collaborators, ['Doc'], 'plain names resolve to card ids');
});

test('Markdown: explicit {#Id}, kind marker and legacy headings', () => {
  const md = `## Subsystem 1 — Core

### Card 1 — \`Model Interface\` _(interface)_

> **Purpose (card back):** Bridges things.

**Superclass:** none · **Subclasses:** none — attributes, not classes

| Responsibilities | Reqs | Collaborations |
|---|---|---|
| [B] Routes messages | INT-01–INT-02 | — |

### Key Store {#Keys}

**Superclass:** \`Model Interface\`
`;
  const { cards } = lib.parseMarkdownCards(md);
  assert.equal(cards[0].id, 'ModelInterface');
  assert.equal(cards[0].kind, 'interface');
  assert.equal(cards[0].subsystem, 'Core');
  assert.deepEqual(cards[0].subclasses, []);
  assert.deepEqual(cards[0].responsibilities[0].reqs, ['INT-01', 'INT-02']);
  assert.equal(cards[1].id, 'Keys');
  assert.equal(cards[1].superclass, 'ModelInterface');
  const again = lib.parseMarkdownCards(lib.cardsToMarkdown(cards)).cards;
  assert.deepEqual(lib.normalizeCards(again), lib.normalizeCards(cards), 'round trip');
});

test('diffCards reports card, responsibility and edge changes', () => {
  const a = [card('A', [R('R1', 'Does x', 'B', ['INT-01'], ['B'])]), card('B', [R('R1', 'Knows y', 'K', ['INT-02'])])];
  const b = JSON.parse(JSON.stringify(a));
  b[0].responsibilities[0].reqs.push('INT-03');
  b[0].responsibilities.push(R('R2', 'Does z', 'B', ['INT-04'], ['C']));
  b[1].purpose = 'Changed.';
  b.push(card('C', [R('R1', 'Knows w', 'K', ['INT-05'])]));
  const d = lib.diffCards(a, b);
  assert.deepEqual(d.cardsAdded, ['C']);
  assert.equal(d.cardsChanged.length, 2);
  const A = d.cardsChanged.find((c) => c.id === 'A');
  assert.deepEqual(A.respChanged, [{ id: 'R1', reqs: { added: ['INT-03'], removed: [] } }]);
  assert.equal(A.respAdded[0].id, 'R2');
  assert.deepEqual(d.edgesAdded, ['A->C']);
  assert.equal(lib.diffCards(a, a).changed, false);
});

test('loadConfig walks up to the nearest crc.config.json and resolves paths', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'crc.config.json'), JSON.stringify({ cards: 'cards.md', rules: { orphan: 'off' }, godObject: { fanOut: 5 } }));
  const deep = path.join(root, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  const cfg = io.loadConfig(deep);
  assert.equal(cfg.file, path.join(root, 'crc.config.json'));
  assert.equal(cfg.cards, path.join(root, 'cards.md'));
  assert.deepEqual(cfg.rules, { orphan: 'off' });
  assert.deepEqual(cfg.godObject, { minResponsibilities: 9, fanOut: 5 }, 'partial godObject merges with defaults');
  const none = io.loadConfig(tmp());
  assert.equal(none.file, null);
});

test('loadCards: directory of mixed files merges, resolves across files, rejects duplicate ids', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.md'), '### Signer\n\n| Responsibilities | Collaborators |\n|---|---|\n| [B] Signs | Key Store |\n');
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(card('KeyStore', [R('R1', 'Knows keys', 'K', [])], { name: 'Key Store' })));
  const { cards } = io.loadCards(dir);
  assert.deepEqual(cards.map((c) => c.id).sort(), ['KeyStore', 'Signer']);
  assert.deepEqual(cards.find((c) => c.id === 'Signer').responsibilities[0].collaborators, ['KeyStore']);
  assert.ok(lib.validate(cards).errors.every((e) => e.code !== 'dangling-collaborator'));
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify([card('Signer', [])]));
  assert.throws(() => io.loadCards(dir), /defined in both/);
});

test('validateOptions: citations required only when requirements are configured', () => {
  const cfg = io.loadConfig(tmp());
  assert.equal(io.validateOptions(cfg, null, null).requireCitations, false);
  assert.equal(io.validateOptions(cfg, { ids: ['INT-01'] }, null).requireCitations, true);
  assert.equal(io.validateOptions({ ...cfg, requireCitations: false }, { ids: ['INT-01'] }, null).requireCitations, false);
});

// ---- contracts and the collaboration graph (Contracts.pptx / Collaborations and Hierarchies.pptx)

const slideMd = `### Drawing Editor

| Responsibilities | Collaborators |
|---|---|
| [B] Edits the drawing | \`Drawing\` (1) |

### Figure Set

| Responsibilities | Collaborators |
|---|---|
| [B] Holds the figures | Drawing |

### Drawing

**Contracts:**

- **1. Access and modify contents** — Lets clients read and change the drawing.

| # | Responsibilities | Contract | Collaborators |
|---|---|---|---|
| R1 | [K] Knows its figures | 1 | — |
| R2 | [B] Adds and removes figures | 1 | — |
| R3 | [K] Know its file name | private | — |
`;

test('contracts: Markdown list, Contract column and "Name (n)" references round-trip', () => {
  const { cards } = lib.parseMarkdownCards(slideMd);
  const drawing = cards.find((c) => c.id === 'Drawing');
  assert.deepEqual(drawing.contracts, [{ number: 1, name: 'Access and modify contents', description: 'Lets clients read and change the drawing.', responsibilities: ['R1', 'R2'] }]);
  assert.equal(drawing.responsibilities[2].type, 'K', '"Know ..." reads as knowledge');
  assert.deepEqual(cards[0].responsibilities[0].contractRefs, { Drawing: 1 });
  assert.equal(cards[1].responsibilities[0].contractRefs, undefined);
  const again = lib.parseMarkdownCards(lib.cardsToMarkdown(cards)).cards;
  assert.deepEqual(lib.normalizeCards(again), lib.normalizeCards(cards));
  assert.ok(lib.validate(cards).ok);
});

test('contracts: two clients of one contract share one semicircle; derived contracts follow explicit numbers', () => {
  const { cards } = lib.parseMarkdownCards(slideMd);
  const { contracts, links } = lib.resolveContracts(cards);
  assert.deepEqual(links.map((l) => [l.from, l.to, l.contract]), [['DrawingEditor', 'Drawing', 1], ['FigureSet', 'Drawing', 1]]);
  assert.deepEqual(contracts.find((k) => k.number === 1).clients, ['DrawingEditor', 'FigureSet']);
  const plain = [card('A', [R('R1', 'Uses B', 'B', [], ['B'])]), card('B', [R('R1', 'Does b', 'B', [])]), ...cards];
  const k = lib.resolveContracts(plain).contracts.find((x) => x.card === 'B');
  assert.ok(k.derived);
  assert.equal(k.number, 2, 'derived numbers start after the highest declared one');
  const G = lib.collaborationLayout(cards);
  assert.equal(G.marks.length, 1);
  const m = G.marks[0];
  assert.equal(m.side, 'left', 'semicircle faces its clients');
  for (const a of G.arrows) { assert.equal(a.x2, m.cx); assert.equal(a.y2, m.cy); } // the flat side, on the box edge
  const box = G.nodes.find((n) => n.id === m.card);
  assert.equal(m.cx, box.x, 'the semicircle sits on the box edge');
  assert.equal(box.inset.left, 13, 'the box makes room for it');
});

test('contracts: validator enforces the slide rules', () => {
  const base = () => [
    card('S', [R('R1', 'Does a', 'B', []), R('R2', 'Does b', 'B', [])], { contracts: [{ number: 1, name: 'A', responsibilities: ['R1'] }, { number: 2, name: 'B', responsibilities: ['R2'] }] }),
    card('C', [R('R1', 'Uses S', 'B', [], ['S'])]),
  ];
  const codesOf = (v) => [...v.errors, ...v.warnings].map((i) => i.code);
  assert.ok(codesOf(lib.validate(base())).includes('contract-unspecified'), 'client must say which of several contracts');
  let x = base(); x[1].responsibilities[0].contractRefs = { S: 9 };
  assert.ok(codesOf(lib.validate(x)).includes('contract-ref-unknown'));
  x = base(); x[1].responsibilities[0].contractRefs = { T: 1 };
  assert.ok(codesOf(lib.validate(x)).includes('contract-ref-not-collaborator'));
  x = base(); x[0].contracts[1].responsibilities = ['R1'];
  assert.ok(codesOf(lib.validate(x)).includes('contract-shared-resp'), 'a responsibility may be in at most one contract');
  x = base(); x[1].contracts = [{ number: 1, name: 'dup', responsibilities: ['R1'] }];
  assert.ok(codesOf(lib.validate(x)).includes('contract-dup-number'));
  x = base(); x[0].contracts[0].responsibilities = ['R7'];
  assert.ok(codesOf(lib.validate(x)).includes('contract-unknown-resp'));
  x = base(); x[1].responsibilities[0].contractRefs = { S: 2 };
  const v = lib.validate(x);
  assert.ok(v.errors.every((e) => !e.code.startsWith('contract')));
  assert.ok(codesOf(v).includes('contract-unused'), 'contract 1 has no client');
});

test('graph renderers: SVG and draw.io draw one semicircle per contract and one arrow per client-contract pair', () => {
  const { cards } = lib.parseMarkdownCards(slideMd);
  const svg = lib.collaborationSvg(cards, { title: 'Slide 12' });
  assert.equal((svg.match(/<path d="M[^"]* A13,13 0 0 1 /g) || []).length, 1, 'one semicircle, bulging into the box (left side, sweep 1)');
  assert.equal((svg.match(/marker-end="url\(#arrow\)"/g) || []).length, 2, 'two arrows');
  assert.ok(!/fill="#(?!fff|000)[0-9a-f]{3,6}"/i.test(svg), 'black and white only');
  const drawio = lib.collaborationDrawio(cards);
  const ellipseId = drawio.match(/<UserObject label="1"[^>]* id="(c\d+)"><mxCell style="shape=image;image=data:image\/svg\+xml,/)[1];
  assert.equal((drawio.match(new RegExp(`target="${ellipseId}"`, 'g')) || []).length, 2, 'both arrows end on the contract');
  assert.match(lib.collaborationMermaid(cards), /DrawingEditor -->\|"1"\| Drawing/);
});

test('subsystem graph: other subsystems appear as dashed context boxes', () => {
  const cards = [
    card('A', [R('R1', 'Uses B', 'B', [], ['B'])], { subsystem: 'One' }),
    card('B', [R('R1', 'Does b', 'B', [], ['C'])], { subsystem: 'One' }),
    card('C', [R('R1', 'Does c', 'B', [])], { subsystem: 'Two' }),
    card('D', [R('R1', 'Unrelated', 'B', [])], { subsystem: 'Two' }),
  ];
  const G = lib.collaborationLayout(cards, { subsystem: 'One' });
  assert.deepEqual(G.nodes.map((n) => [n.id, n.external]), [['A', false], ['B', false], ['C', true]]);
  assert.match(lib.collaborationSvg(cards, { subsystem: 'One' }), /stroke-dasharray="5 3"/);
});

// ---- prompt helpers for the v2 pipeline

test('cardsToCompact keeps every id, requirement, collaborator and contract; oneLine is a summary', () => {
  const { cards } = lib.parseMarkdownCards(slideMd);
  cards[0].responsibilities[0].reqs = ['INT-01', 'INT-02', 'INT-03'];
  const text = lib.cardsToCompact(cards);
  for (const c of cards) { assert.match(text, new RegExp(`^${c.id}`, 'm')); for (const r of c.responsibilities) assert.match(text, new RegExp(`  ${r.id} ${r.type} `)); }
  assert.match(text, /\[INT-01–INT-03\] -> Drawing\(1\)/);
  assert.match(text, /contracts: 1 Access and modify contents \[R1 R2\]/);
  assert.ok(text.length < JSON.stringify(cards).length * 0.8);
  const one = lib.cardsToCompact(cards, { oneLine: true, only: ['Drawing'] });
  assert.equal(one.trim().split('\n').length, 1);
  assert.doesNotMatch(one, /INT-|->/);
});

test('responsibilitiesCiting finds every responsibility citing the requirements', () => {
  const cards = [card('A', [R('R1', 'x', 'B', ['INT-01', 'INT-02']), R('R2', 'y', 'B', ['INT-03'])]), card('B', [R('R1', 'z', 'B', ['INT-02'])])];
  assert.deepEqual(lib.responsibilitiesCiting(cards, ['INT-02']).map((x) => `${x.card}.${x.resp}`), ['A.R1', 'B.R1']);
});

test('walkthroughAffected: re-walk only when something the scenario used changed', () => {
  const a = [card('A', [R('R1', 'Uses B', 'B', [], ['B']), R('R2', 'Other', 'B', [])]), card('B', [R('R1', 'Does b', 'B', [])])];
  const wt = { steps: [{ from: '@U', to: 'A', responsibilityId: 'R1' }, { from: 'A', to: 'B', responsibilityId: 'R1' }] };
  const b1 = JSON.parse(JSON.stringify(a)); b1[0].responsibilities[1].text = 'Changed but unused';
  assert.equal(lib.walkthroughAffected(wt, lib.diffCards(a, b1)), false);
  const b2 = JSON.parse(JSON.stringify(a)); b2[1].responsibilities[0].text = 'Does something else';
  assert.equal(lib.walkthroughAffected(wt, lib.diffCards(a, b2)), true);
  const b3 = JSON.parse(JSON.stringify(a)); b3[0].responsibilities[0].collaborators = [];
  assert.equal(lib.walkthroughAffected(wt, lib.diffCards(a, b3)), true, 'edge A->B removed');
});

test('wt-private-call: calling a responsibility outside every contract is flagged', () => {
  const { cards } = lib.parseMarkdownCards(slideMd);
  const ok = { scenarioId: 'S1', steps: [{ from: 'DrawingEditor', to: 'Drawing', responsibilityId: 'R2' }] };
  const priv = { scenarioId: 'S2', steps: [{ from: 'DrawingEditor', to: 'Drawing', responsibilityId: 'R3' }] };
  const v = lib.validate(cards, { walkthroughs: [ok, priv] });
  assert.deepEqual(v.warnings.filter((w) => w.code === 'wt-private-call').map((w) => w.scenario), ['S2']);
});
