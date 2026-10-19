// Run with: node --test (from crc-tool/)
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/lib.js');

const card = (id, resps, extra = {}) => ({
  id, name: id, kind: 'class', subsystem: 'S', purpose: `The purpose of ${id}.`,
  superclass: null, subclasses: [], responsibilities: resps, ...extra,
});
const R = (id, text, type, reqs, collaborators = []) => ({ id, text, type, reqs, collaborators });
const codes = (result) => result.errors.map((e) => e.code);

const good = () => [
  card('Sender', [R('R1', 'Signs the document', 'B', ['INT-01'], ['Doc'])]),
  card('Doc', [R('R1', 'Knows its content', 'K', ['INT-02']), R('R2', 'Appends a signature', 'B', ['INT-03'], ['Sender'])]),
];
const REQS = ['INT-01', 'INT-02', 'INT-03'];

test('a clean card set passes', () => {
  const v = lib.validate(good(), { reqIds: REQS });
  assert.equal(v.ok, true, lib.formatReport(v));
  assert.equal(v.stats.reqsCovered, 3);
  assert.equal(v.stats.collaborationEdges, 2);
});

test('expandReqRefs handles lists, full ranges, short ranges, unpadded ids', () => {
  assert.deepEqual(lib.expandReqRefs('SEC-01, SEC-02'), ['SEC-01', 'SEC-02']);
  assert.deepEqual(lib.expandReqRefs('TS-01–TS-03'), ['TS-01', 'TS-02', 'TS-03']);
  assert.deepEqual(lib.expandReqRefs('ACC-24–26'), ['ACC-24', 'ACC-25', 'ACC-26']);
  assert.deepEqual(lib.expandReqRefs(['int-1', 'INT-2 - INT-3']), ['INT-01', 'INT-02', 'INT-03']);
  assert.equal(lib.compressReqs(['TS-03', 'TS-01', 'TS-02', 'SEC-09']), 'SEC-09, TS-01–TS-03');
});

test('dangling collaborator is an error, reported once per card', () => {
  const cards = good();
  cards[0].responsibilities.push(R('R2', 'Notifies IT', 'B', ['INT-01'], ['Notifier']));
  cards[0].responsibilities.push(R('R3', 'Notifies the user', 'B', ['INT-01'], ['Notifier']));
  const v = lib.validate(cards, { reqIds: REQS });
  const d = v.errors.filter((e) => e.code === 'dangling-collaborator');
  assert.equal(d.length, 1);
  assert.match(d[0].message, /R2, R3/);
});

test('uncovered and unknown requirements are errors', () => {
  const cards = good();
  cards[1].responsibilities[1].reqs = ['INT-99'];
  const v = lib.validate(cards, { reqIds: REQS });
  assert.ok(codes(v).includes('uncovered-req'));
  assert.ok(codes(v).includes('unknown-req'));
  assert.equal(v.errors.find((e) => e.code === 'uncovered-req').req, 'INT-03');
});

test('missing citation is an error', () => {
  const cards = good();
  cards[0].responsibilities[0].reqs = [];
  assert.ok(codes(lib.validate(cards, { requireCitations: true })).includes('missing-citation'));
  assert.ok(codes(lib.validate(cards, { reqIds: REQS })).includes('missing-citation'), 'on by default when requirements are given');
  assert.ok(!codes(lib.validate(cards)).includes('missing-citation'), 'off by default without requirements');
});

test('inheritance mismatch and cycles are caught', () => {
  const cards = good();
  cards[0].superclass = 'Doc'; // Doc does not list Sender as a subclass
  assert.ok(codes(lib.validate(cards)).includes('inheritance-mismatch'));

  const cyc = good();
  cyc[0].superclass = 'Doc'; cyc[1].subclasses = ['Sender'];
  cyc[1].superclass = 'Sender'; cyc[0].subclasses = ['Doc'];
  assert.ok(codes(lib.validate(cyc)).includes('inheritance-cycle'));
});

test('oversized card and duplicate ids are errors', () => {
  const cards = good();
  for (let i = 2; i <= 14; i++) cards[1].responsibilities.push(R(`R${i + 1}`, `Does thing ${i}`, 'B', ['INT-02']));
  cards.push(card('Doc', [R('R1', 'Knows x', 'K', ['INT-01'])]));
  const c = codes(lib.validate(cards));
  assert.ok(c.includes('card-too-large'));
  assert.ok(c.includes('dup-card'));
});

test('walkthrough steps must match real responsibilities and real collaborations', () => {
  const cards = good();
  const wts = [
    { scenarioId: 'S1', title: 'ok', steps: [{ from: 'Sender', to: 'Doc', responsibilityId: 'R2' }] },
    { scenarioId: 'S2', title: 'invented resp', steps: [{ from: 'Sender', to: 'Doc', responsibilityId: 'R9' }] },
    { scenarioId: 'S3', title: 'no edge', steps: [{ from: 'Doc', to: 'Sender', responsibilityId: 'R1' }, { from: 'Doc', to: 'Doc', responsibilityId: 'R1' }] },
    { scenarioId: 'S4', title: 'break', steps: [{ break: true, missing: 'Encrypts the hash', reason: 'no cipher' }] },
    { scenarioId: 'S5', title: 'external trigger', steps: [{ from: '@User', to: 'Sender', responsibilityId: 'R1' }, { from: 'Sender', to: 'Doc', responsibilityId: 'R2' }] },
  ];
  cards[1].responsibilities[1].collaborators = []; // remove Doc -> Sender
  const v = lib.validate(cards, { walkthroughs: wts });
  const by = (s) => v.errors.filter((e) => e.scenario === s).map((e) => e.code);
  assert.deepEqual(by('S1'), []);
  assert.deepEqual(by('S2'), ['wt-unknown-resp']);
  assert.deepEqual(by('S3'), ['wt-no-collaboration']); // self-step is fine
  assert.deepEqual(by('S4'), ['wt-break']);
  assert.deepEqual(by('S5'), []);
  assert.equal(v.stats.walkthroughs.complete, 2);
});

test('line-format importer handles misspelled headers and flags dangling names', () => {
  const md = `Email:\nKnowledge class about emails\nSubclass:\nSuperclass:\nResonsibility:\nKnows sender\nCollaborators:\nAttachment\nmodel interface\n\nModel Interface:\nBridge\nSubclass\nSuperclass\nResonibilitys:\nencrypts\nCollaborators\nemail\n`;
  const { cards, notes } = lib.importLineCards(md);
  assert.deepEqual(cards.map((c) => c.id), ['Email', 'ModelInterface']);
  assert.deepEqual(cards[0].responsibilities[0].collaborators, ['Attachment', 'ModelInterface']);
  assert.equal(cards[1].responsibilities[0].type, 'B');
  assert.ok(notes.some((n) => n.includes('ModelInterface')));
  const v = lib.validate(cards);
  assert.ok(v.errors.some((e) => e.code === 'dangling-collaborator' && e.collaborator === 'Attachment'));
});

test('table-format importer round-trips through the markdown renderer', () => {
  const md = lib.cardsToMarkdown(good(), { title: 'T' }).replace(/^## S$/m, '## Subsystem 1 — S');
  const { cards } = lib.importTableCards(md);
  assert.deepEqual(cards.map((c) => c.id), ['Sender', 'Doc']);
  assert.deepEqual(cards[1].responsibilities.map((r) => [r.type, r.text, r.reqs, r.collaborators]),
    [['K', 'Knows its content', ['INT-02'], []], ['B', 'Appends a signature', ['INT-03'], ['Sender']]]);
  assert.equal(cards[0].purpose, 'The purpose of Sender.');
});

test('graph renderers include every edge and mark dangling targets', () => {
  const cards = good();
  cards[0].responsibilities[0].collaborators.push('Ghost');
  const mmd = lib.collaborationMermaid(cards);
  assert.match(mmd, /Sender -->/);
  assert.match(mmd, /Doc -->/);
  assert.equal((mmd.match(/Ghost\["⚠/g) || []).length, 1);
  const drawio = lib.collaborationDrawio(cards);
  assert.equal((drawio.match(/edge="1"/g) || []).length, 3); // the arrow to the missing class is drawn too...
  assert.match(drawio, /Ghost \(no card\)/); // ...to a dashed "(no card)" box
  assert.match(lib.walkthroughMermaid({ steps: [{ from: 'Sender', to: 'Doc', responsibilityId: 'R2' }] }, cards), /Sender->>Doc: R2: Appends a signature/);
});

test('atomic responsibilities: long lines, overloaded behaviors and joined actions', () => {
  const long = 'Validate each attached document against the accepted formats before the signature is generated';
  const cards = [
    card('Sender', [
      R('R1', long, 'B', ['INT-01']),
      R('R2', 'Sign the document', 'B', ['INT-01', 'INT-02', 'INT-03', 'SEC-01']),
      R('R3', 'Validate the file and send it', 'B', ['INT-01']),
      R('R4', 'Hash the file; encrypt the hash', 'B', ['INT-02']),
      R('R5', 'Receive a message and its documents', 'B', ['INT-03']),
      R('R6', 'Knows the accepted extensions: .doc, .txt and .csv', 'K', ['SEC-01', 'SEC-02', 'SEC-03', 'SEC-04']),
      R('R7', 'Knows its sender and recipient', 'K', ['INT-01']),
    ]),
  ];
  assert.deepEqual(codes(lib.validate(JSON.parse(JSON.stringify(cards)))), [], 'off by default');
  const v = lib.validate(cards, { atomic: true });
  const at = (code) => [...v.errors, ...v.warnings].filter((i) => i.code === code).map((i) => i.resp);
  assert.deepEqual(at('resp-too-long'), ['R1']);
  assert.deepEqual(at('resp-too-many-reqs'), ['R2'], 'knowledge lines may cite several requirements');
  assert.deepEqual(at('resp-compound'), ['R3', 'R4'], '"and its documents" is one action; K lines are not checked');
  assert.equal(v.warnings.find((w) => w.code === 'resp-compound').severity, 'warning');
  assert.equal(lib.validate(cards, { atomic: { maxWords: 20, maxReqs: 5 } }).errors.length, 0, 'limits are configurable');
  assert.equal(v.stats.compoundBehaviors, 2);
  assert.ok(v.stats.meanWords > 5);
});
