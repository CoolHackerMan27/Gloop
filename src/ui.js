// src/ui.js — the card editor behind `crc ui`: a small local server for ui/index.html.
// It edits one JSON cards file; checks, graphs and imports go straight through lib.js.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const lib = require('./lib.js');
const io = require('./io.js');

const INDEX = path.join(__dirname, '..', 'ui', 'index.html');
const SCHEMA = path.join(__dirname, '..', 'schema', 'crc.schema.json');
const clone = (x) => JSON.parse(JSON.stringify(x));

// The file to edit when none is given: the config's cards if they're JSON, else ./cards.json.
function defaultCardsPath(start = process.cwd()) {
  const cfg = io.loadConfig(start);
  if (cfg.file && /\.json$/i.test(cfg.cards || '')) return cfg.cards;
  return path.resolve(start, 'cards.json');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const normSub = (s) => ({ name: s.name || '', description: s.description || '', graph: s.graph || '', contracts: (s.contracts || []).map((k) => ({ number: +k.number, name: k.name || '', server: k.server || '' })) });

// What overwriting `a` with `b` changes, one line each, in formatDiff's +/-/~ style.
function cardChanges(a, b) {
  return lib.formatDiff(lib.diffCards([a], [b])).split('\n').filter((l) => /^\s/.test(l)).map((l) => l.trim());
}

function subsystemChanges(a, b) {
  const L = [];
  for (const f of ['description', 'graph']) if (a[f] !== b[f]) L.push(`${f}: "${a[f]}" → "${b[f]}"`);
  const label = (k) => `${k.number}. ${k.name}${k.server ? ` (served by ${k.server})` : ''}`;
  for (const k of b.contracts) {
    const o = a.contracts.find((x) => x.number === k.number);
    if (!o) L.push(`+ contract ${label(k)}`);
    else if (o.name !== k.name || o.server !== k.server) L.push(`~ contract ${label(o)} → ${label(k)}`);
  }
  for (const k of a.contracts) if (!b.contracts.some((x) => x.number === k.number)) L.push(`- contract ${label(k)}`);
  return L;
}

// Sort an imported file's cards against the ones open in the page: new, already here
// unchanged, or a conflict, with the merged card when an automatic merge is possible.
// Nothing is written here; the page applies the choices and saves.
function analyzeImport({ name = '', text = '', cards = [], subsystems = [] }, cardsFile) {
  io.loadConfig(path.dirname(cardsFile)); // the project's requirement-ID syntax, for parsing
  let parsed;
  try {
    if (/\.txt$/i.test(name)) parsed = { ...lib.importLineCards(text), format: 'plain text' };
    else if (/\.(md|json)$/i.test(name)) parsed = { ...io.parseCards(text, name), format: /\.md$/i.test(name) ? 'Markdown' : 'JSON' };
    else return { error: `Import takes .json, .md or .txt files, not ${name || 'that'}.` };
  } catch (e) {
    return { error: `Couldn't read ${name}: ${e.message}` };
  }
  const incoming = lib.normalizeCards(parsed.cards);
  const seen = new Set();
  for (const c of incoming) {
    if (seen.has(c.id)) return { error: `${name} has two cards with the id ${c.id}.` };
    seen.add(c.id);
  }
  const same = (a, b) => JSON.stringify(lib.normalizeCards([a])) === JSON.stringify(lib.normalizeCards([b]));
  const have = new Map(cards.map((c) => [c.id, c]));
  const cardItems = incoming.map((c) => {
    const ours = have.get(c.id);
    if (!ours) return { id: c.id, name: c.name, status: 'new', incoming: c };
    if (same(ours, c)) return { id: c.id, name: ours.name || c.id, status: 'same' };
    const m = lib.mergeCard(ours, c);
    return {
      id: c.id, name: ours.name || c.id, status: 'conflict', incoming: c, merged: m.card, conflicts: m.conflicts,
      mergeChanges: m.card ? cardChanges(ours, m.card) : [], overwriteChanges: cardChanges(ours, c),
    };
  });
  const haveSub = new Map(subsystems.map((s) => [s.name, normSub(s)]));
  const subItems = (parsed.subsystems || []).filter((s) => s && s.name).map(normSub).map((s) => {
    const ours = haveSub.get(s.name);
    if (!ours) return { name: s.name, status: 'new', incoming: s };
    if (JSON.stringify(ours) === JSON.stringify(s)) return { name: s.name, status: 'same' };
    const m = lib.mergeSubsystem(ours, s);
    return {
      name: s.name, status: 'conflict', incoming: s, merged: m.subsystem, conflicts: m.conflicts,
      mergeChanges: m.subsystem ? subsystemChanges(ours, m.subsystem) : [], overwriteChanges: subsystemChanges(ours, s),
    };
  });
  return { source: name, format: parsed.format, cards: cardItems, subsystems: subItems, walkthroughs: (parsed.walkthroughs || []).length };
}

function createUiServer(file) {
  let mtime = null;

  // The whole file as an object with at least cards and subsystems.
  function readProject() {
    if (!fs.existsSync(file)) { mtime = null; return { cards: [], subsystems: [] }; }
    let data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(data)) data = { cards: data }; // a bare array of cards is valid crc input too
    mtime = fs.statSync(file).mtimeMs;
    return { ...data, cards: data.cards || [], subsystems: data.subsystems || [] };
  }

  // Replace cards and subsystem cards, keeping anything else in the file (walkthroughs, $schema).
  function writeProject(cards, subsystems) {
    let old = {};
    if (fs.existsSync(file)) {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d && !Array.isArray(d)) old = d;
    }
    // $schema first gives VS Code autocomplete when the file is opened by hand.
    const { $schema = pathToFileURL(SCHEMA).href, ...rest } = old;
    const data = { $schema, ...rest, cards };
    if (subsystems.length) data.subsystems = subsystems;
    else delete data.subsystems;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, file);
    mtime = fs.statSync(file).mtimeMs;
  }

  // Same as `crc check --json`, with the config from the cards file's folder.
  function check() {
    if (!fs.existsSync(file)) return { error: 'Save a card first.' };
    const cfg = io.loadConfig(path.dirname(file));
    const loaded = io.loadCards(file);
    const reqs = io.loadRequirements(cfg.requirements);
    const walkthroughs = loaded.walkthroughs || io.loadWalkthroughs(cfg.walkthroughs);
    return lib.validate(clone(loaded.cards), io.validateOptions(cfg, reqs, walkthroughs));
  }

  function graph(subsystem) {
    if (!fs.existsSync(file)) return { error: 'Save a card first.' };
    io.loadConfig(path.dirname(file));
    const { cards } = io.loadCards(file);
    if (subsystem && !lib.subsystemsOf(cards).includes(subsystem)) return { error: `No class card is in the subsystem "${subsystem}".` };
    const title = subsystem ? `${subsystem} — Collaboration Graph` : 'Collaboration Graph';
    return { svg: lib.collaborationSvg(cards, { title, subsystem: subsystem || undefined }) };
  }

  return http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const send = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    // Only this page gets in: other sites open in the browser can't reach the API,
    // whether by posting here directly or through a DNS name pointed at 127.0.0.1.
    const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '');
    const sameOrigin = !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;
    if (!local || !sameOrigin) { res.writeHead(403); res.end(); return; }

    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(INDEX));
      return;
    }
    if (req.method === 'GET' && url === '/api/project') {
      try {
        const data = readProject();
        send({ path: file, exists: fs.existsSync(file), mtime, cards: data.cards, subsystems: data.subsystems });
      } catch (e) {
        send({ error: `Couldn't read ${file}: ${e.message}` }, 500);
      }
      return;
    }
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let body;
    try { body = await readBody(req); } catch { send({ error: 'bad JSON' }, 400); return; }

    if (url === '/api/save') {
      const disk = fs.existsSync(file) ? fs.statSync(file).mtimeMs : null;
      // Someone else (an editor, the agent pipeline) changed the file since the page loaded it.
      if (!body.force && disk !== (body.mtime ?? null)) {
        send({ conflict: true, error: `${path.basename(file)} changed on disk since it was loaded.` }, 409);
        return;
      }
      try {
        writeProject(body.cards || [], body.subsystems || []);
        send({ ok: true, mtime });
      } catch (e) {
        send({ error: e.message }, 500);
      }
      return;
    }
    const routes = {
      '/api/check': () => check(),
      '/api/graph': () => graph(body.subsystem),
      '/api/import': () => analyzeImport(body, file),
    };
    if (!routes[url]) { res.writeHead(404); res.end(); return; }
    try { send(routes[url]()); } catch (e) { send({ error: e.message }); }
  });
}

module.exports = { createUiServer, defaultCardsPath, analyzeImport };
