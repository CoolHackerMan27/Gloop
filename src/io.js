// src/io.js — everything that touches the filesystem. lib.js stays pure.

const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');

const CONFIG_NAME = 'crc.config.json';

const DEFAULT_CONFIG = {
  title: 'CRC Cards',
  cards: 'cards.md',
  requirements: null,
  walkthroughs: null,
  out: 'out',
  requirementIds: lib.DEFAULT_REQ_SYNTAX,
  maxResponsibilities: 12,
  requireCitations: null, // null = on when a requirements file is configured
  godObject: { minResponsibilities: 9, fanOut: 8 },
  duplicateSimilarity: 0.8,
  atomicResponsibilities: null, // true or { maxWords, maxReqs }: one responsibility = one verb phrase
  rules: {},
};

// Find crc.config.json in `start` or the nearest parent directory (like eslint).
// Returns the merged config with paths resolved against the config's directory,
// or the defaults resolved against `start` when there is no config file.
function loadConfig(start = process.cwd()) {
  let dir = path.resolve(start);
  let file = null;
  for (;;) {
    const candidate = path.join(dir, CONFIG_NAME);
    if (fs.existsSync(candidate)) { file = candidate; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const raw = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const base = file ? path.dirname(file) : path.resolve(start);
  const cfg = { ...DEFAULT_CONFIG, ...raw, godObject: { ...DEFAULT_CONFIG.godObject, ...(raw.godObject || {}) }, file, base };
  for (const k of ['cards', 'requirements', 'walkthroughs', 'out']) if (cfg[k]) cfg[k] = path.resolve(base, cfg[k]);
  lib.setRequirementSyntax(cfg.requirementIds);
  return cfg;
}

// Load cards from a .json file (array or {cards, walkthroughs}), a .md card file,
// or a directory of either (merged; duplicate card ids are an error).
// Returns { cards, walkthroughs, notes } where notes are name resolutions made.
function loadCards(target) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    const files = fs.readdirSync(target).filter((f) => /\.(json|md)$/i.test(f) && !f.startsWith('.')).sort();
    const cards = [];
    const walkthroughs = [];
    const notes = [];
    const seen = new Map();
    for (const f of files) {
      const part = loadCards(path.join(target, f));
      for (const c of part.cards) {
        if (seen.has(c.id)) throw new Error(`Card id "${c.id}" is defined in both ${seen.get(c.id)} and ${f}.`);
        seen.set(c.id, f);
        cards.push(c);
      }
      if (part.walkthroughs) walkthroughs.push(...part.walkthroughs);
      notes.push(...part.notes);
    }
    // Names in one file may refer to cards in another, so resolve across the whole set.
    notes.push(...lib.resolveNames(cards));
    return { cards, walkthroughs: walkthroughs.length ? walkthroughs : null, notes };
  }
  const text = fs.readFileSync(target, 'utf8');
  if (/\.md$/i.test(target)) {
    const { cards, notes } = lib.parseMarkdownCards(text);
    return { cards, walkthroughs: null, notes };
  }
  const data = JSON.parse(text);
  if (Array.isArray(data)) return { cards: data, walkthroughs: null, notes: [] };
  if (data && Array.isArray(data.cards)) return { cards: data.cards, walkthroughs: data.walkthroughs || null, notes: [] };
  if (data && data.id && data.responsibilities) return { cards: [data], walkthroughs: null, notes: [] }; // one card per file
  if (data && Array.isArray(data.walkthroughs)) return { cards: [], walkthroughs: data.walkthroughs, notes: [] };
  throw new Error(`${target}: expected an array of cards, {"cards": [...]}, or a single card object.`);
}

function loadWalkthroughs(file) {
  if (!file || !fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(data) ? data : data.walkthroughs || [];
}

function loadRequirements(file) {
  if (!file || !fs.existsSync(file)) return null;
  return lib.parseRequirements(fs.readFileSync(file, 'utf8'));
}

// The options validate() needs, from a config plus loaded requirements/walkthroughs.
function validateOptions(cfg, reqs, walkthroughs) {
  return {
    reqIds: reqs ? reqs.ids : null,
    walkthroughs: walkthroughs || null,
    requireCitations: cfg.requireCitations == null ? !!reqs : cfg.requireCitations,
    maxResponsibilities: cfg.maxResponsibilities,
    godObject: cfg.godObject,
    duplicateSimilarity: cfg.duplicateSimilarity,
    atomic: cfg.atomicResponsibilities || null,
    rules: cfg.rules || {},
  };
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, text);
}

module.exports = { CONFIG_NAME, DEFAULT_CONFIG, loadConfig, loadCards, loadWalkthroughs, loadRequirements, validateOptions, writeFile };
