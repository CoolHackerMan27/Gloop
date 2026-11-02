#!/usr/bin/env node
// bin/crc.js — command-line front end for the CRC card toolkit.
//
// Commands read crc.config.json (found in this or a parent directory), so a
// bare `crc check` works inside a project. Paths and flags override the config.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const lib = require('../src/lib.js');
const io = require('../src/io.js');
const { viewerHtml } = require('../src/viewer.js');
const ui = require('../src/ui.js');

const USAGE = `crc — CRC cards as data: check them, graph them, keep them honest.

  crc ui [cards.json] [--port n] [--no-open]
                                 the card editor in your browser: make, import, check and graph cards
  crc init [dir]                 start a project (config, example cards, requirements, scenario)
  crc check [cards] [--watch] [--json]
                                 validate; exit 1 on errors
  crc build [cards] [--out dir]  cards.md, contracts.md, traceability, scenarios, graphs (svg per system
                                 and per subsystem, drawio, mermaid, dot, viewer)
  crc view [cards] [--watch] [--port n] [--no-open]
                                 open the interactive graph; --watch redraws as you edit
  crc convert <in> <out> [--from lines]
                                 cards.md <-> cards.json (--from lines: the plain hand-written format)
  crc diff <before> <after>      what changed between two versions of a card set
  crc graph [cards] --format svg|drawio|mermaid|inherit|dot|html [--subsystem name] [-o file]
                                 svg/drawio: collaboration graph in course notation (boxes, numbered
                                 contract semicircles, client -> contract arrows), black and white
  crc render | trace | sequence [cards] [-o file]
  crc compare label=cards.json ... [-o file]

Common flags: --reqs <file> --walkthroughs <file> --config-dir <dir>
Config reference and card format: crc-tool/README.md`;

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') flags.o = argv[++i];
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) flags[key] = true;
      else flags[key] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

// Everything a command needs: config, cards, requirements, walkthroughs, validate options.
function project(pos, flags) {
  const cfg = io.loadConfig(flags['config-dir'] || process.cwd());
  const cardsPath = pos[0] ? path.resolve(pos[0]) : cfg.cards;
  if (!cardsPath || !fs.existsSync(cardsPath)) {
    throw new Error(`No cards at ${cardsPath || '(none configured)'}. Pass a path, or run \`crc init\` to start a project.`);
  }
  const loaded = io.loadCards(cardsPath);
  const reqs = io.loadRequirements(flags.reqs ? path.resolve(flags.reqs) : cfg.requirements);
  const walkthroughs = flags.walkthroughs ? io.loadWalkthroughs(path.resolve(flags.walkthroughs)) : loaded.walkthroughs || io.loadWalkthroughs(cfg.walkthroughs);
  if (flags.max) cfg.maxResponsibilities = +flags.max;
  return { cfg, cardsPath, cards: loaded.cards, notes: loaded.notes, reqs, walkthroughs, vopts: io.validateOptions(cfg, reqs, walkthroughs) };
}

function emit(text, out) {
  const body = text.endsWith('\n') ? text : text + '\n';
  if (out) { io.writeFile(out, body); console.error(`wrote ${path.relative(process.cwd(), out) || out}`); }
  else process.stdout.write(body);
}

const clone = (x) => JSON.parse(JSON.stringify(x));

function openInBrowser(target) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  execFile(cmd, args, () => {});
}

// Re-run `fn` whenever any of the files change (debounced). Directories are watched recursively.
function watch(paths, fn) {
  let timer = null;
  const trigger = () => { clearTimeout(timer); timer = setTimeout(fn, 150); };
  for (const p of paths.filter((x) => x && fs.existsSync(x))) {
    fs.watch(p, { recursive: fs.statSync(p).isDirectory() }, trigger);
  }
  fn();
}

const commands = {
  init({ pos, flags }) {
    const dir = path.resolve(pos[0] || '.');
    const tpl = path.join(__dirname, '..', 'templates');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(tpl)) {
      const dest = path.join(dir, f);
      if (fs.existsSync(dest) && !flags.force) { console.error(`kept existing ${f}`); continue; }
      fs.copyFileSync(path.join(tpl, f), dest);
      console.error(`wrote ${f}`);
    }
    // Editor autocomplete for hand-written JSON cards: map cards*.json to the schema.
    const settingsFile = path.join(dir, '.vscode', 'settings.json');
    let settings = {};
    if (fs.existsSync(settingsFile)) {
      try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { console.error('.vscode/settings.json is not plain JSON; left it alone'); settings = null; }
    }
    if (settings) {
      const url = pathToFileURL(path.join(__dirname, '..', 'schema', 'crc.schema.json')).href;
      const schemas = (settings['json.schemas'] || []).filter((s) => s.url !== url);
      schemas.push({ fileMatch: ['cards*.json', '**/cards*.json'], url });
      settings['json.schemas'] = schemas;
      io.writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n');
      console.error('wrote .vscode/settings.json (JSON autocomplete for cards*.json)');
    }
    const rel = path.relative(process.cwd(), dir) || '.';
    console.error(`\nNext: cd ${rel.startsWith('..') ? dir : rel} && crc check`);
  },

  check({ pos, flags }) {
    const run = () => {
      let p;
      try { p = project(pos, flags); } catch (e) { console.error(`error: ${e.message}`); process.exitCode = 2; return; }
      const result = lib.validate(clone(p.cards), p.vopts);
      if (flags.watch) process.stdout.write('\x1b[2J\x1b[H');
      if (flags.json) emit(JSON.stringify(result, null, 2));
      else {
        emit(lib.formatReport(result));
        if (p.notes.length && !flags.quiet) emit(`\nResolved names: ${p.notes.join('; ')}`);
      }
      if (flags.watch) console.error(`\nwatching ${path.relative(process.cwd(), p.cardsPath) || p.cardsPath} — Ctrl+C to stop`);
      process.exitCode = result.ok ? 0 : 1;
    };
    if (!flags.watch) return run();
    const cfg = io.loadConfig(flags['config-dir'] || process.cwd());
    watch([pos[0] ? path.resolve(pos[0]) : cfg.cards, cfg.requirements, cfg.walkthroughs, cfg.file], run);
  },

  build({ pos, flags }) {
    const p = project(pos, flags);
    const out = flags.out ? path.resolve(flags.out) : p.cfg.out;
    const title = flags.title || p.cfg.title;
    const result = lib.validate(clone(p.cards), p.vopts);
    const g = (f) => path.join(out, 'graphs', f);
    // Never overwrite the source file when the cards are written in Markdown.
    let mdOut = path.join(out, 'cards.md');
    if (path.resolve(mdOut) === path.resolve(p.cardsPath)) mdOut = path.join(out, 'cards.rendered.md');
    emit(lib.cardsToMarkdown(p.cards, { title }), mdOut);
    emit(lib.formatReport(result), path.join(out, 'validation.txt'));
    if (p.reqs) emit(lib.traceabilityMarkdown(p.cards, p.reqs), path.join(out, 'traceability.md'));
    if (p.walkthroughs && p.walkthroughs.length) emit(lib.scenariosMarkdown(p.cards, p.walkthroughs, `${title} — Scenario Walkthroughs`, p.vopts), path.join(out, 'scenarios.md'));
    emit(lib.contractsMarkdown(p.cards, { title: `${title} — Contracts` }), path.join(out, 'contracts.md'));
    emit(lib.collaborationSvg(p.cards, { title: `${title} — Collaboration Graph` }), g('collaboration.svg'));
    const subsystems = lib.subsystemsOf(p.cards);
    if (subsystems.length > 1) {
      for (const sub of subsystems) {
        const slug = sub.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'subsystem';
        emit(lib.collaborationSvg(p.cards, { title: `${sub} — Collaboration Graph`, subsystem: sub }), g(path.join('subsystems', `${slug}.svg`)));
      }
    }
    emit(lib.collaborationMermaid(p.cards), g('collaboration.mmd'));
    emit(lib.inheritanceMermaid(p.cards), g('inheritance.mmd'));
    emit(lib.collaborationDot(p.cards), g('collaboration.dot'));
    emit(lib.collaborationDrawio(p.cards, { name: title }), g('collaboration.drawio'));
    emit(viewerHtml({ cards: p.cards, walkthroughs: p.walkthroughs || [] }, { title }), g('viewer.html'));
    console.error(lib.formatReport(result, { errorsOnly: true }).split('\n').slice(0, 3).join('\n'));
    process.exitCode = result.ok ? 0 : 1;
  },

  view({ pos, flags }) {
    const first = project(pos, flags);
    const title = flags.title || first.cfg.title;
    if (!flags.watch) {
      const file = path.join(first.cfg.out, 'graphs', 'viewer.html');
      emit(viewerHtml({ cards: first.cards, walkthroughs: first.walkthroughs || [] }, { title }), file);
      if (!flags['no-open']) openInBrowser(file);
      return;
    }
    // Live: serve the viewer and the current cards; the page polls /cards.json.
    const server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      try {
        if (url === '/cards.json') {
          const p = project(pos, flags);
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ cards: p.cards, walkthroughs: p.walkthroughs || [], contracts: Object.fromEntries(lib.contractLabels(p.cards)) }));
        } else if (url === '/' || url === '/index.html') {
          const p = project(pos, flags);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(viewerHtml({ cards: p.cards, walkthroughs: p.walkthroughs || [] }, { title, live: true }));
        } else { res.writeHead(404); res.end(); }
      } catch (e) {
        // A half-saved file can fail to parse; the page keeps its last good state.
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(e.message);
      }
    });
    server.listen(+flags.port || 0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      console.error(`live viewer at ${url} — edit your cards and the graph redraws. Ctrl+C to stop.`);
      if (!flags['no-open']) openInBrowser(url);
    });
  },

  ui({ pos, flags }) {
    const file = pos[0] ? path.resolve(pos[0]) : ui.defaultCardsPath();
    if (/\.md$/i.test(file)) {
      throw new Error(`the UI edits JSON cards. Open a JSON file and use Import, or convert first:\n  crc convert ${pos[0]} ${pos[0].replace(/\.md$/i, '.json')}`);
    }
    if (fs.existsSync(file)) {
      try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file} isn't valid JSON: ${e.message}`); }
    }
    io.loadConfig(path.dirname(file));
    const server = ui.createUiServer(file);
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && !server.retried) { server.retried = true; server.listen(0, '127.0.0.1'); return; } // port taken: pick a free one
      console.error(`error: ${e.message}`);
      process.exit(2);
    });
    server.on('listening', () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      console.error(`CRC cards UI at ${url}\nediting ${file}${fs.existsSync(file) ? '' : ' (new file)'}\nCtrl+C to stop.`);
      if (!flags['no-open']) openInBrowser(url);
    });
    server.listen(flags.port ? +flags.port : 8615, '127.0.0.1');
  },

  convert({ pos, flags }) {
    const [src, dest] = pos;
    if (!src || !dest) throw new Error('usage: crc convert <in> <out> [--from lines]');
    io.loadConfig(path.dirname(path.resolve(src))); // picks up a custom requirement-ID syntax, if any
    let cards;
    let walkthroughs = null;
    if (flags.from === 'lines') {
      const r = lib.importLineCards(fs.readFileSync(src, 'utf8'));
      cards = r.cards;
      for (const n of r.notes) console.error(`resolved ${n}`);
    } else {
      const r = io.loadCards(path.resolve(src));
      cards = r.cards;
      walkthroughs = r.walkthroughs;
      for (const n of r.notes) console.error(`resolved ${n}`);
    }
    if (/\.md$/i.test(dest)) emit(lib.cardsToMarkdown(cards, { title: flags.title }), dest);
    else emit(JSON.stringify(walkthroughs ? { cards: lib.normalizeCards(cards), walkthroughs } : { cards: lib.normalizeCards(cards) }, null, 2) + '\n', dest);
  },

  diff({ pos }) {
    if (pos.length < 2) throw new Error('usage: crc diff <before> <after>');
    io.loadConfig(process.cwd());
    const d = lib.diffCards(io.loadCards(path.resolve(pos[0])).cards, io.loadCards(path.resolve(pos[1])).cards);
    emit(lib.formatDiff(d));
    process.exitCode = d.changed ? 1 : 0;
  },

  graph({ pos, flags }) {
    const p = project(pos, flags);
    const format = flags.format || 'svg';
    const sub = typeof flags.subsystem === 'string' ? flags.subsystem : undefined;
    if (sub && !lib.subsystemsOf(p.cards).includes(sub)) throw new Error(`no subsystem "${sub}" (have: ${lib.subsystemsOf(p.cards).join(', ')})`);
    const make = {
      svg: () => lib.collaborationSvg(p.cards, { title: flags.title || `${sub || p.cfg.title} — Collaboration Graph`, subsystem: sub }),
      mermaid: () => lib.collaborationMermaid(p.cards, { labels: !flags['no-labels'] }),
      inherit: () => lib.inheritanceMermaid(p.cards),
      dot: () => lib.collaborationDot(p.cards),
      drawio: () => lib.collaborationDrawio(p.cards, { title: flags.title || `${sub || p.cfg.title} — Collaboration Graph`, subsystem: sub }),
      html: () => viewerHtml({ cards: p.cards, walkthroughs: p.walkthroughs || [] }, { title: flags.title || p.cfg.title }),
    }[format];
    if (!make) throw new Error(`unknown --format ${format} (svg, drawio, mermaid, inherit, dot, html)`);
    emit(make(), flags.o);
  },

  render({ pos, flags }) {
    const p = project(pos, flags);
    emit(lib.cardsToMarkdown(p.cards, { title: flags.title || p.cfg.title }), flags.o);
  },

  trace({ pos, flags }) {
    const p = project(pos, flags);
    if (!p.reqs) throw new Error('trace needs requirements: set "requirements" in crc.config.json or pass --reqs');
    emit(lib.traceabilityMarkdown(p.cards, p.reqs), flags.o);
  },

  sequence({ pos, flags }) {
    const p = project(pos, flags);
    if (!p.walkthroughs) throw new Error('sequence needs walkthroughs: set "walkthroughs" in crc.config.json or pass --walkthroughs');
    emit(lib.scenariosMarkdown(p.cards, p.walkthroughs, flags.title, p.vopts), flags.o);
  },

  compare({ pos, flags }) {
    const cfg = io.loadConfig(flags['config-dir'] || process.cwd());
    const reqs = io.loadRequirements(flags.reqs ? path.resolve(flags.reqs) : cfg.requirements);
    const sets = pos.map((p) => {
      const [label, file] = p.includes('=') ? p.split(/=(.*)/s) : [path.basename(p), p];
      return { label, cards: io.loadCards(path.resolve(file)).cards };
    });
    emit(lib.compareMarkdown(sets, reqs ? reqs.ids : null), flags.o);
  },
};

// Older spellings kept working.
commands.validate = commands.check;
commands.import = ({ pos, flags }) => commands.convert({ pos: [pos[0], flags.o || 'cards.json'], flags: { ...flags, from: flags.format === 'lines' ? 'lines' : undefined } });

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(USAGE); return; }
  if (!commands[cmd]) { console.error(`unknown command "${cmd}"\n\n${USAGE}`); process.exit(2); }
  try {
    commands[cmd](parseArgs(rest));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(2);
  }
}

main();
