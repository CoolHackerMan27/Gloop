// src/lib.js — CRC card toolkit core.
//
// Pure functions only: no filesystem, no Date, no randomness, no dependencies.
// Keep it one file: it is inlined verbatim into agent Workflow scripts so the
// agents and the CLI run exactly the same checks. Filesystem work is in io.js.
//
// Data model (see schema/crc.schema.json):
//   Card { id, name, kind, subsystem, purpose, superclass, subclasses[],
//          responsibilities: [{ id, text, type: 'K'|'B', reqs[], collaborators[] }] }
//   Walkthrough { scenarioId, title, steps: [{ from, to, responsibilityId, note? } | { break: true, missing, reason }] }
//   A step whose `from` starts with '@' (e.g. '@User') is an external trigger: no card or edge is required for it.

const CRC_KINDS = ['class', 'interface', 'actor', 'external'];
const CRC_ID_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------- requirements

// Requirement IDs are PREFIX + SEPARATOR + NUMBER, e.g. "INT-01", "REQ-007", "FR3".
// The default fits "ABC-01". setRequirementSyntax() changes it for a project;
// the CLI calls it once from crc.config.json.
const DEFAULT_REQ_SYNTAX = { prefix: '[A-Za-z]{2,5}', separator: '-', pad: 2 };
let REQ_SYNTAX = compileReqSyntax(DEFAULT_REQ_SYNTAX);

function compileReqSyntax(syn) {
  const s = { ...DEFAULT_REQ_SYNTAX, ...(syn || {}) };
  const sep = String(s.separator).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    ...s,
    // one reference, optionally a range: "TS-01–TS-05", "ACC-24–29"
    refRe: new RegExp(`(${s.prefix})${sep}(\\d+)(?:\\s*[–—-]\\s*(?:(${s.prefix})${sep})?(\\d+))?`, 'gi'),
    idRe: new RegExp(`^(${s.prefix})${sep}(\\d+)$`, 'i'),
    // requirement line: "ID: text", "- ID: text", "ID. text", "ID) text"
    lineRe: new RegExp(`^(?:[-*]\\s+)?(${s.prefix})${sep}(\\d+)\\s*[:.)–-]?\\s+(.*)$`, 'i'),
  };
}

function setRequirementSyntax(syn) {
  REQ_SYNTAX = compileReqSyntax(syn);
  return REQ_SYNTAX;
}

function normalizeReqId(prefix, num) {
  return `${prefix.toUpperCase()}${REQ_SYNTAX.separator}${String(parseInt(num, 10)).padStart(REQ_SYNTAX.pad, '0')}`;
}

// Parse a numbered requirements file ("INT-01: The model shall ...") into
// { ids: [...in order], text: {id: text}, sections: {prefix: title} }.
// A heading "## Title [PREFIX]" names the section for that prefix.
function parseRequirements(source) {
  const ids = [];
  const text = {};
  const sections = {};
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = line.match(/^#{1,6}\s+(.+?)\s*\[([A-Za-z]+)\]\s*$/);
    if (sec) { sections[sec[2].toUpperCase()] = sec[1]; continue; }
    const m = line.match(REQ_SYNTAX.lineRe);
    if (m) {
      const id = normalizeReqId(m[1], m[2]);
      if (!(id in text)) ids.push(id);
      text[id] = m[3];
    }
  }
  return { ids, text, sections };
}

// Expand a free-text list of requirement references into individual IDs.
// Handles "SEC-01, SEC-02", "TS-01–TS-05", "ACC-24–29", "INT-1 - INT-3".
function expandReqRefs(input) {
  const parts = Array.isArray(input) ? input : [input];
  const out = [];
  const re = REQ_SYNTAX.refRe;
  for (const part of parts) {
    if (part == null) continue;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(String(part)))) {
      const prefix = m[1].toUpperCase();
      const start = parseInt(m[2], 10);
      if (m[4] && (!m[3] || m[3].toUpperCase() === prefix)) {
        const end = parseInt(m[4], 10);
        for (let n = start; n <= end; n++) out.push(normalizeReqId(prefix, n));
      } else {
        out.push(normalizeReqId(prefix, start));
        if (m[4]) out.push(normalizeReqId(m[3], m[4])); // cross-prefix "range" = two refs
      }
    }
  }
  return [...new Set(out)];
}

// Collapse ["TS-01","TS-02","TS-03","SEC-04"] into "TS-01–TS-03, SEC-04" for display.
function compressReqs(ids) {
  const sorted = [...new Set(ids)].sort(reqSort);
  const out = [];
  let i = 0;
  while (i < sorted.length) {
    const [p, n] = splitReq(sorted[i]);
    let j = i;
    while (j + 1 < sorted.length) {
      const [p2, n2] = splitReq(sorted[j + 1]);
      if (p2 !== p || n2 !== n + (j + 1 - i)) break;
      j++;
    }
    out.push(j - i >= 2 ? `${sorted[i]}–${sorted[j]}` : sorted.slice(i, j + 1).join(', '));
    i = j + 1;
  }
  return out.join(', ');
}

function splitReq(id) {
  const m = String(id).match(REQ_SYNTAX.idRe);
  return m ? [m[1].toUpperCase(), parseInt(m[2], 10)] : [String(id), 0];
}

function reqSort(a, b) {
  const [pa, na] = splitReq(a);
  const [pb, nb] = splitReq(b);
  return pa === pb ? na - nb : pa < pb ? -1 : 1;
}

// ---------------------------------------------------------------- graph model

// Directed collaboration edges, each carrying the responsibilities that create it.
function collaborationEdges(cards) {
  const map = new Map();
  for (const card of cards) {
    for (const r of card.responsibilities || []) {
      for (const to of r.collaborators || []) {
        const key = `${card.id}->${to}`;
        if (!map.has(key)) map.set(key, { from: card.id, to, resps: [] });
        map.get(key).resps.push({ id: r.id, text: r.text, type: r.type });
      }
    }
  }
  return [...map.values()];
}

function cardCollaborators(card) {
  return [...new Set((card.responsibilities || []).flatMap((r) => r.collaborators || []))];
}

function subsystemsOf(cards) {
  const order = [];
  for (const c of cards) {
    const s = c.subsystem || 'Unassigned';
    if (!order.includes(s)) order.push(s);
  }
  return order;
}

// ---------------------------------------------------------------- contracts

// A contract (Wirfs-Brock) is a numbered set of a class's public responsibilities
// that clients can depend on. Cards may declare them:
//   card.contracts = [{ number: 4, name, description, responsibilities: ['R1', 'R2'] }]
//   responsibility.contractRefs = { DisplayScreen: 7 }   // which contract of a collaborator it uses
// Responsibilities in no contract are private. Numbers are unique across the system,
// and a subclass offers its superclass's contracts too.
// A class that others use but that declares no contracts gets one derived contract
// covering all its responsibilities, so a collaboration graph can always be drawn.
function resolveContracts(cards) {
  const list = cards.filter(Boolean);
  const byId = new Map(list.map((c) => [c.id, c]));
  const contracts = [];
  let max = 0;
  for (const c of list) {
    for (const k of Array.isArray(c.contracts) ? c.contracts : []) {
      const number = parseInt(k.number, 10);
      contracts.push({ number, card: c.id, name: k.name || '', description: k.description || '', responsibilities: [...(k.responsibilities || [])], derived: false, clients: [] });
      if (number > max) max = number;
    }
  }
  const own = (id) => contracts.filter((k) => k.card === id);
  const available = (id, seen = new Set()) => {
    if (!id || seen.has(id) || !byId.has(id)) return [];
    seen.add(id);
    return [...own(id), ...available(byId.get(id).superclass, seen)];
  };
  const used = new Set();
  for (const c of list) for (const r of c.responsibilities || []) for (const s of r.collaborators || []) if (s !== c.id && byId.has(s)) used.add(s);
  for (const c of list) {
    if (!used.has(c.id) || available(c.id).length) continue;
    contracts.push({ number: ++max, card: c.id, name: c.name || c.id, description: '', responsibilities: (c.responsibilities || []).map((r) => r.id), derived: true, clients: [] });
  }
  // One link per (client, server, contract); unresolved = the server offers several and the card doesn't say which.
  const links = [];
  const index = new Map();
  const unresolved = [];
  for (const c of list) {
    for (const r of c.responsibilities || []) {
      for (const s of r.collaborators || []) {
        if (s === c.id || !byId.has(s)) continue;
        const offered = available(s);
        const ref = r.contractRefs ? r.contractRefs[s] : undefined;
        let k = null;
        if (ref != null) k = offered.find((x) => x.number === parseInt(ref, 10)) || null;
        else if (offered.length === 1) k = offered[0];
        if (!k) unresolved.push({ client: c.id, resp: r.id, server: s, ref: ref == null ? null : ref });
        const key = `${c.id}->${s}#${k ? k.number : '?'}`;
        if (!index.has(key)) { const l = { from: c.id, to: s, contract: k ? k.number : null, resps: [] }; index.set(key, l); links.push(l); }
        index.get(key).resps.push(r.id);
        if (k && !k.clients.includes(c.id)) k.clients.push(c.id);
      }
    }
  }
  return { contracts, links, unresolved, available };
}

// ---------------------------------------------------------------- validation

const STOPWORDS = new Set('a an the of to its it for and or when is are that with on in each every by from as be this their his her knows know whether'.split(' '));

function contentTokens(text) {
  return new Set(String(text).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !STOPWORDS.has(w)));
}

// ---------------------------------------------------------------- responsibility granularity

// One responsibility is one verb phrase (CRC lecture: "verb phrases lead to responsibilities").
// A line that needs many words, many requirement citations, or "and" between two actions is
// usually several responsibilities written as one, which is how a card stays under the
// index-card limit while doing too much.
const DEFAULT_ATOMIC = { maxWords: 10, maxReqs: 3 };
const COMMON_VERBS = new Set(('accept add alert allow append approve ask block calculate cancel check compare compute confirm create '
  + 'decide decrypt delete deliver detect display encrypt ensure extract fetch flag forward generate grant hand hash hold keep list '
  + 'load log measure notify pass pause queue read receive record refuse reject release remove replace report request restore resume '
  + 'retrain return route save schedule send show sign start stop store tell track update upload validate verify warn write '
  + 'apply enable give inform install mark monitor provide pull run set use').split(' '));

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

// "validates" -> "validate", "notifies" -> "notify", "passes" -> "pass".
function verbBase(word) {
  const w = String(word).toLowerCase();
  if (/ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (/(?:ss|sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);
  return w.replace(/s$/, '');
}

// Leading verbs of the set's behavior lines plus common ones: "Validate X and send Y" is
// two actions, "Receive a message and its documents" is one.
function behaviorVerbs(cards) {
  const verbs = new Set(COMMON_VERBS);
  for (const c of cards) for (const r of (c && c.responsibilities) || []) {
    if (r && r.type === 'B' && r.text) verbs.add(verbBase(String(r.text).trim().split(/\s+/)[0]));
  }
  verbs.delete('know');
  return verbs;
}

function isCompound(text, verbs) {
  const t = String(text || '');
  if (/;|\bthen\b|\bas well as\b/i.test(t)) return true;
  return [...t.matchAll(/\b(?:and|or)\s+([A-Za-z]+)/gi)].some((m) => verbs.has(verbBase(m[1])));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// validate(cards, options) -> { ok, errors, warnings, stats }
//   reqIds               requirement IDs to check coverage against (omit to skip coverage)
//   walkthroughs         scenario walkthroughs to check step by step
//   requireCitations     every responsibility must cite a requirement (default: true when reqIds given)
//   maxResponsibilities  index-card size limit (12)
//   godObject            { minResponsibilities: 9, fanOut: 8 } thresholds for the god-object warning
//   duplicateSimilarity  word-overlap ratio that flags two owners of one responsibility (0.8)
//   rules                { code: 'off' | 'warn' | 'error' } to silence or re-grade any issue code
//   atomic               true or { maxWords: 10, maxReqs: 3 }: one responsibility = one verb phrase
//                        (off by default; the granularity stats are computed either way)
//   -> { ok, errors: Issue[], warnings: Issue[], stats }
// Issue = { severity, code, card?, resp?, scenario?, step?, req?, message }
function validate(cards, opts = {}) {
  const maxResp = opts.maxResponsibilities ?? 12;
  const requireCitations = opts.requireCitations ?? !!opts.reqIds;
  const godMin = (opts.godObject && opts.godObject.minResponsibilities) ?? 9;
  const godFanOut = (opts.godObject && opts.godObject.fanOut) ?? 8;
  const dupSimilarity = opts.duplicateSimilarity ?? 0.8;
  const reqIds = opts.reqIds || null;
  const walkthroughs = opts.walkthroughs || null;
  const atomic = opts.atomic ? { ...DEFAULT_ATOMIC, ...(typeof opts.atomic === 'object' ? opts.atomic : {}) } : null;
  const issues = [];
  let edges = [];
  let wtStats = null;
  let contractView = null;
  const cited = new Map(); // reqId -> ["Card.R1", ...]
  const add = (severity, code, fields, message) => issues.push({ severity, code, ...fields, message });
  const err = (code, fields, message) => add('error', code, fields, message);
  const warn = (code, fields, message) => add('warning', code, fields, message);

  if (!Array.isArray(cards)) {
    err('schema', {}, 'Card set must be an array of cards.');
    return finish();
  }

  // --- shape ---------------------------------------------------------------
  const byId = new Map();
  for (const [i, c] of cards.entries()) {
    const where = { card: c && c.id ? c.id : `#${i}` };
    if (!c || typeof c !== 'object') { err('schema', where, 'Card is not an object.'); continue; }
    if (typeof c.id !== 'string' || !CRC_ID_RE.test(c.id)) err('bad-id', where, `Card id "${c.id}" must be an identifier (letters, digits, underscore; no spaces).`);
    if (byId.has(c.id)) err('dup-card', where, `Duplicate card id "${c.id}".`);
    else byId.set(c.id, c);
    if (!c.name) warn('missing-name', where, 'Card has no display name.');
    if (c.kind && !CRC_KINDS.includes(c.kind)) err('schema', where, `kind "${c.kind}" must be one of ${CRC_KINDS.join(', ')}.`);
    if (!c.purpose || !String(c.purpose).trim()) warn('missing-purpose', where, `${where.card}: card back is empty (no one-sentence purpose).`);
    if (!c.subsystem) warn('missing-subsystem', where, 'Card is not assigned to a subsystem.');
    if (!Array.isArray(c.responsibilities)) { err('schema', where, 'responsibilities must be an array.'); c.responsibilities = []; }
    if (c.subclasses != null && !Array.isArray(c.subclasses)) { err('schema', where, 'subclasses must be an array.'); c.subclasses = []; }

    const rIds = new Set();
    for (const [j, r] of c.responsibilities.entries()) {
      const rw = { card: c.id, resp: r && r.id ? r.id : `#${j}` };
      if (!r || typeof r !== 'object') { err('schema', rw, 'Responsibility is not an object.'); continue; }
      if (!r.id) err('schema', rw, 'Responsibility has no id.');
      else if (rIds.has(r.id)) err('dup-resp', rw, `Duplicate responsibility id "${r.id}" on ${c.id}.`);
      rIds.add(r.id);
      if (!r.text || !String(r.text).trim()) err('schema', rw, 'Responsibility has no text.');
      if (r.type !== 'K' && r.type !== 'B') err('schema', rw, `type must be "K" (knowledge) or "B" (behavior), got "${r.type}".`);
      if (!Array.isArray(r.reqs)) r.reqs = [];
      if (!Array.isArray(r.collaborators)) r.collaborators = [];
      const startsKnows = /^knows?\b/i.test(String(r.text || '').trim());
      if (r.type === 'K' && !startsKnows) warn('kb-mismatch', rw, `[K] responsibility does not read as knowledge: "${r.text}".`);
      if (r.type === 'B' && startsKnows) warn('kb-mismatch', rw, `[B] responsibility reads as knowledge: "${r.text}".`);
    }
  }

  // --- references ----------------------------------------------------------
  for (const c of cards) {
    if (!c || !Array.isArray(c.responsibilities)) continue;
    const dangling = new Map(); // collaborator name -> [resp ids], reported once per card
    for (const r of c.responsibilities) {
      for (const to of r.collaborators || []) {
        if (!byId.has(to)) dangling.set(to, [...(dangling.get(to) || []), r.id]);
        else if (to === c.id) warn('self-collaborator', { card: c.id, resp: r.id }, `${c.id}.${r.id} lists itself as a collaborator.`);
      }
    }
    for (const [to, rs] of dangling) err('dangling-collaborator', { card: c.id, resp: rs[0], collaborator: to }, `${c.id} names collaborator "${to}" (on ${rs.join(', ')}), which has no card.`);
    if (c.superclass && !byId.has(c.superclass)) err('dangling-superclass', { card: c.id }, `Superclass "${c.superclass}" has no card.`);
    for (const s of c.subclasses || []) {
      if (!byId.has(s)) err('dangling-subclass', { card: c.id }, `Subclass "${s}" has no card.`);
    }
  }

  // --- inheritance ---------------------------------------------------------
  for (const c of cards) {
    if (!c) continue;
    if (c.superclass && byId.has(c.superclass)) {
      const sup = byId.get(c.superclass);
      if (!(sup.subclasses || []).includes(c.id)) err('inheritance-mismatch', { card: c.id }, `${c.id} names ${sup.id} as superclass, but ${sup.id} does not list ${c.id} as a subclass.`);
    }
    for (const s of c.subclasses || []) {
      const sub = byId.get(s);
      if (sub && sub.superclass !== c.id) err('inheritance-mismatch', { card: c.id }, `${c.id} lists ${s} as a subclass, but ${s}'s superclass is "${sub.superclass || 'none'}".`);
    }
  }
  for (const c of cards) {
    if (!c) continue;
    const seen = new Set([c.id]);
    let cur = c.superclass;
    while (cur && byId.has(cur)) {
      if (seen.has(cur)) { err('inheritance-cycle', { card: c.id }, `Inheritance cycle through ${[...seen].join(' → ')}.`); break; }
      seen.add(cur);
      cur = byId.get(cur).superclass;
    }
  }

  // --- contracts -------------------------------------------------------------
  const contractHome = new Map();
  for (const c of cards) {
    if (!c || c.contracts == null) continue;
    if (!Array.isArray(c.contracts)) { err('schema', { card: c.id }, 'contracts must be an array.'); continue; }
    const respIds = new Set((c.responsibilities || []).map((r) => r.id));
    const inContract = new Map();
    for (const k of c.contracts) {
      const n = parseInt(k && k.number, 10);
      if (!(n >= 1)) { err('schema', { card: c.id }, `Contract "${(k && k.name) || '?'}" on ${c.id} needs a whole number of 1 or more.`); continue; }
      if (contractHome.has(n)) err('contract-dup-number', { card: c.id }, `Contract ${n} is defined on both ${contractHome.get(n)} and ${c.id}; contract numbers are unique across the system.`);
      else contractHome.set(n, c.id);
      if (!(k.responsibilities || []).length) warn('contract-empty', { card: c.id }, `Contract ${n} on ${c.id} groups no responsibilities.`);
      for (const rid of k.responsibilities || []) {
        if (!respIds.has(rid)) err('contract-unknown-resp', { card: c.id }, `Contract ${n} on ${c.id} lists ${rid}, which is not on the card.`);
        else if (inContract.has(rid)) err('contract-shared-resp', { card: c.id, resp: rid }, `${c.id}.${rid} is in contracts ${inContract.get(rid)} and ${n}; a responsibility may be part of at most one contract.`);
        else inContract.set(rid, n);
      }
    }
  }
  contractView = resolveContracts(cards.filter((c) => c && Array.isArray(c.responsibilities)));
  for (const c of cards) {
    for (const r of (c && c.responsibilities) || []) {
      if (!r || !r.contractRefs) continue;
      for (const [s, n] of Object.entries(r.contractRefs)) {
        if (!(r.collaborators || []).includes(s)) err('contract-ref-not-collaborator', { card: c.id, resp: r.id }, `${c.id}.${r.id} names contract ${n} of ${s}, but ${s} is not one of its collaborators.`);
        else if (byId.has(s) && !contractView.available(s).some((k) => k.number === parseInt(n, 10))) err('contract-ref-unknown', { card: c.id, resp: r.id }, `${c.id}.${r.id} uses contract ${n} of ${s}, which ${s} does not offer.`);
      }
    }
  }
  for (const u of contractView.unresolved) if (u.ref == null) warn('contract-unspecified', { card: u.client, resp: u.resp }, `${u.client}.${u.resp} uses ${u.server}, which offers several contracts; say which, e.g. "${u.server} (${contractView.available(u.server)[0].number})".`);
  for (const k of contractView.contracts) if (!k.derived && !k.clients.length) warn('contract-unused', { card: k.card }, `No class uses contract ${k.number} (${k.name}) of ${k.card}.`);

  // --- requirements traceability ------------------------------------------
  for (const c of cards) {
    if (!c || !Array.isArray(c.responsibilities)) continue;
    for (const r of c.responsibilities) {
      const refs = expandReqRefs(r.reqs || []);
      if (requireCitations && !refs.length && c.kind !== 'external') err('missing-citation', { card: c.id, resp: r.id }, `${c.id}.${r.id} cites no requirement: "${r.text}".`);
      for (const q of refs) {
        if (!cited.has(q)) cited.set(q, []);
        cited.get(q).push(`${c.id}.${r.id}`);
        if (reqIds && !reqIds.includes(q)) err('unknown-req', { card: c.id, resp: r.id, req: q }, `${c.id}.${r.id} cites ${q}, which does not exist.`);
      }
    }
  }
  const uncovered = reqIds ? reqIds.filter((q) => !cited.has(q)) : [];
  for (const q of uncovered) err('uncovered-req', { req: q }, `${q} is not cited by any responsibility.`);

  // --- responsibility granularity (opt-in) ----------------------------------
  if (atomic) {
    const verbs = behaviorVerbs(cards);
    for (const c of cards) {
      for (const r of (c && c.responsibilities) || []) {
        if (!r || !r.text) continue;
        const rw = { card: c.id, resp: r.id };
        const n = wordCount(r.text);
        if (n > atomic.maxWords) err('resp-too-long', rw, `${c.id}.${r.id} is ${n} words (limit ${atomic.maxWords}); a responsibility is one verb phrase: "${r.text}".`);
        const q = expandReqRefs(r.reqs || []).length;
        if (r.type === 'B' && q > atomic.maxReqs) err('resp-too-many-reqs', rw, `${c.id}.${r.id} cites ${q} requirements (limit ${atomic.maxReqs} for a behavior); it is probably several responsibilities.`);
        if (r.type === 'B' && isCompound(r.text, verbs)) warn('resp-compound', rw, `${c.id}.${r.id} joins several actions; each is its own responsibility: "${r.text}".`);
      }
    }
  }

  // --- size / shape heuristics --------------------------------------------
  edges = collaborationEdges(cards.filter((c) => c && Array.isArray(c.responsibilities)));
  const inDeg = new Map();
  const outDeg = new Map();
  for (const e of edges) {
    if (e.from === e.to) continue;
    outDeg.set(e.from, (outDeg.get(e.from) || 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
  }
  const sizes = cards.filter(Boolean).map((c) => (c.responsibilities || []).length);
  const mean = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;
  const meanFanOut = sizes.length ? [...outDeg.values()].reduce((a, b) => a + b, 0) / sizes.length : 0;
  const fanOutLimit = Math.max(godFanOut, Math.ceil(1.5 * meanFanOut));
  for (const c of cards) {
    if (!c) continue;
    const n = (c.responsibilities || []).length;
    if (n === 0) (c.kind === 'actor' || c.kind === 'external' ? warn : err)('empty-card', { card: c.id }, `${c.id} has no responsibilities.`);
    if (n > maxResp) err('card-too-large', { card: c.id }, `${c.id} has ${n} responsibilities (limit ${maxResp}); it would not fit on an index card.`);
    const fanOut = outDeg.get(c.id) || 0;
    if ((n >= godMin && n >= 1.5 * mean) || fanOut >= fanOutLimit) warn('god-object', { card: c.id }, `${c.id} may be a God object: ${n} responsibilities (mean ${mean.toFixed(1)}), collaborates with ${fanOut} classes (flag at ${fanOutLimit}).`);
    if (!inDeg.get(c.id) && !outDeg.get(c.id) && cards.length > 1) warn('orphan', { card: c.id }, `${c.id} neither uses nor is used by any other card.`);
    if (n > 0 && c.kind !== 'actor' && c.kind !== 'external' && (c.responsibilities || []).every((r) => r.type === 'K')) warn('knowledge-only', { card: c.id }, `${c.id} only knows things and does nothing; consider whether it is a class or an attribute.`);
  }

  // --- duplicate ownership --------------------------------------------------
  const flat = [];
  for (const c of cards) for (const r of (c && c.responsibilities) || []) flat.push({ c: c.id, r, t: contentTokens(r.text) });
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      const a = flat[i], b = flat[j];
      if (a.c === b.c || a.r.type !== b.r.type || a.t.size < 3 || b.t.size < 3) continue;
      if (jaccard(a.t, b.t) >= dupSimilarity) warn('duplicate-responsibility', { card: a.c, resp: a.r.id }, `${a.c}.${a.r.id} and ${b.c}.${b.r.id} look like the same responsibility with two owners: "${a.r.text}" / "${b.r.text}".`);
    }
  }

  // --- walkthroughs ---------------------------------------------------------
  wtStats = walkthroughs ? checkWalkthroughs(walkthroughs, cards, byId, edges, err, warn, contractView) : null;

  return finish();

  function finish() {
    // Apply rule overrides, lint-style: 'off' drops the issue, 'warn' / 'error' re-grade it.
    const rules = opts.rules || {};
    const graded = issues
      .filter((i) => rules[i.code] !== 'off')
      .map((i) => (rules[i.code] === 'warn' ? { ...i, severity: 'warning' } : rules[i.code] === 'error' ? { ...i, severity: 'error' } : i));
    const errors = graded.filter((i) => i.severity === 'error');
    const warnings = graded.filter((i) => i.severity === 'warning');
    const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
    const resps = list.flatMap((c) => c.responsibilities || []);
    const setVerbs = behaviorVerbs(list);
    const stats = {
      cards: list.length,
      byKind: Object.fromEntries(CRC_KINDS.map((k) => [k, list.filter((c) => (c.kind || 'class') === k).length])),
      subsystems: subsystemsOf(list).length,
      responsibilities: resps.length,
      knowledge: resps.filter((r) => r.type === 'K').length,
      behavior: resps.filter((r) => r.type === 'B').length,
      largestCard: list.reduce((best, c) => ((c.responsibilities || []).length > best.n ? { id: c.id, n: c.responsibilities.length } : best), { id: null, n: 0 }),
      meanResponsibilities: list.length ? +(resps.length / list.length).toFixed(2) : 0,
      meanWords: resps.length ? +(resps.reduce((a, r) => a + wordCount(r.text), 0) / resps.length).toFixed(1) : 0,
      compoundBehaviors: resps.filter((r) => r.type === 'B' && isCompound(r.text, setVerbs)).length,
      collaborationEdges: edges.filter((e) => e.from !== e.to).length,
      contracts: contractView ? contractView.contracts.length : 0,
      derivedContracts: contractView ? contractView.contracts.filter((k) => k.derived).length : 0,
      citedResponsibilities: resps.filter((r) => expandReqRefs(r.reqs || []).length).length,
      reqsTotal: reqIds ? reqIds.length : null,
      reqsCovered: reqIds ? reqIds.filter((q) => cited.has(q)).length : null,
      walkthroughs: wtStats,
      errorsByCode: countBy(errors, 'code'),
      warningsByCode: countBy(warnings, 'code'),
    };
    return { ok: errors.length === 0, errors, warnings, stats };
  }
}

function checkWalkthroughs(walkthroughs, cards, byId, edges, err, warn, contractView) {
  const edgeSet = new Set(edges.map((e) => `${e.from}->${e.to}`));
  // Public responsibilities per card that declares contracts (own or inherited); others are private.
  const publicOf = (id) => {
    const offered = contractView ? contractView.available(id).filter((k) => !k.derived) : [];
    return offered.length ? new Set(offered.flatMap((k) => k.responsibilities)) : null;
  };
  const used = new Set();
  const results = [];
  for (const wt of walkthroughs) {
    const sid = wt.scenarioId || wt.title || '?';
    let ok = true;
    let broken = false;
    for (const [i, s] of (wt.steps || []).entries()) {
      const at = { scenario: sid, step: i + 1 };
      if (s.break) {
        broken = true;
        ok = false;
        err('wt-break', at, `Scenario ${sid} breaks at step ${i + 1}: missing "${s.missing}"${s.reason ? ` (${s.reason})` : ''}.`);
        break;
      }
      const external = String(s.from || '').startsWith('@'); // '@User', '@Timer': a stimulus from outside the card set
      if (external && i > 0 && !String((wt.steps[i - 1] || {}).from || '').startsWith('@')) warn('wt-midstream-trigger', at, `Scenario ${sid} step ${i + 1}: external trigger "${s.from}" appears mid-scenario; check that a card should not initiate this step.`);
      if (!external && !byId.has(s.from)) { ok = false; err('wt-unknown-card', at, `Scenario ${sid} step ${i + 1}: "${s.from}" has no card.`); continue; }
      if (!byId.has(s.to)) { ok = false; err('wt-unknown-card', at, `Scenario ${sid} step ${i + 1}: "${s.to}" has no card.`); continue; }
      const target = byId.get(s.to);
      const resp = (target.responsibilities || []).find((r) => r.id === s.responsibilityId);
      if (!resp) { ok = false; err('wt-unknown-resp', at, `Scenario ${sid} step ${i + 1}: ${s.to} has no responsibility "${s.responsibilityId}".`); continue; }
      if (!external && s.from !== s.to) {
        const pub = publicOf(s.to);
        if (pub && !pub.has(s.responsibilityId)) warn('wt-private-call', at, `Scenario ${sid} step ${i + 1}: ${s.from} calls ${s.to}.${s.responsibilityId}, which is private (in none of ${s.to}'s contracts).`);
        if (edgeSet.has(`${s.from}->${s.to}`)) used.add(`${s.from}->${s.to}`);
        else {
          ok = false;
          const reverse = edgeSet.has(`${s.to}->${s.from}`);
          err('wt-no-collaboration', at, `Scenario ${sid} step ${i + 1}: ${s.from} calls ${s.to}.${s.responsibilityId}, but ${s.from} does not list ${s.to} as a collaborator${reverse ? ` (only ${s.to} → ${s.from} exists)` : ''}.`);
        }
      }
    }
    results.push({ scenarioId: sid, complete: ok, broken, steps: (wt.steps || []).length });
  }
  for (const e of edges) {
    if (e.from !== e.to && byId.has(e.to) && !used.has(`${e.from}->${e.to}`)) warn('edge-unexercised', { card: e.from }, `No walkthrough exercises ${e.from} → ${e.to}.`);
  }
  return { total: results.length, complete: results.filter((r) => r.complete).length, results };
}

function countBy(list, key) {
  const out = {};
  for (const x of list) out[x[key]] = (out[x[key]] || 0) + 1;
  return out;
}

// Short human-readable report. Long uncovered-requirement lists are collapsed.
function formatReport(result, opts = {}) {
  const { errors, warnings, stats } = result;
  const lines = [];
  lines.push(`${result.ok ? 'PASS' : 'FAIL'} — ${errors.length} error(s), ${warnings.length} warning(s)`);
  lines.push(`cards ${stats.cards} · responsibilities ${stats.responsibilities} (${stats.knowledge} K / ${stats.behavior} B) · edges ${stats.collaborationEdges} · largest ${stats.largestCard.id} (${stats.largestCard.n})`);
  if (stats.reqsTotal != null) lines.push(`requirements covered ${stats.reqsCovered}/${stats.reqsTotal} · responsibilities with citations ${stats.citedResponsibilities}/${stats.responsibilities}`);
  if (stats.walkthroughs) lines.push(`walkthroughs complete ${stats.walkthroughs.complete}/${stats.walkthroughs.total}`);
  const section = (title, list) => {
    if (!list.length) return;
    lines.push('', `${title}:`);
    const uncovered = list.filter((i) => i.code === 'uncovered-req');
    const missingCite = list.filter((i) => i.code === 'missing-citation');
    for (const i of list) {
      if (i.code === 'uncovered-req') continue;
      if (i.code === 'missing-citation' && missingCite.length > (opts.collapseOver ?? 15)) continue;
      lines.push(`  [${i.code}] ${i.message}`);
    }
    if (missingCite.length > (opts.collapseOver ?? 15)) lines.push(`  [missing-citation] ${missingCite.length} responsibilities cite no requirement.`);
    if (uncovered.length) lines.push(`  [uncovered-req] ${uncovered.length} requirement(s) not cited: ${compressReqs(uncovered.map((i) => i.req))}`);
  };
  section('Errors', errors);
  if (!opts.errorsOnly) section('Warnings', warnings);
  return lines.join('\n');
}

// ---------------------------------------------------------------- renderers

function esc(s) { return String(s ?? ''); }

// Markdown card format (what cardsToMarkdown writes and parseMarkdownCards reads):
//
//   ## Subsystem name
//
//   ### Model Interface _(interface)_          <- optional kind; "{#Id}" if the id isn't the name in PascalCase
//
//   > **Purpose (card back):** The purpose of this class is to ...
//
//   **Superclass:** none · **Subclasses:** none
//
//   **Contracts:**                              <- optional (course CRC extension)
//
//   - **3. Sign documents** — Signs each outgoing document.
//
//   | # | Responsibilities | Contract | Reqs | Collaborators |
//   |---|---|---|---|---|
//   | R1 | [K] Knows the sending model | private | INT-15, INT-16 | `HashModel` |
//   | R2 | [B] Signs each document | 3 | SEC-49 | `SignatureGenerator` (5), `Message` |
//
// The "#" column keeps responsibility ids stable when rows are reordered; without
// it rows are numbered R1, R2, ... in order. The Contract column appears only on
// cards that declare contracts; "private" (or blank) means in no contract.
// "`SignatureGenerator` (5)" means this responsibility uses that class's contract 5.
function cardsToMarkdown(cards, opts = {}) {
  const lines = [];
  if (opts.title) lines.push(`# ${opts.title}`, '');
  if (opts.intro) lines.push(opts.intro, '');
  for (const sub of subsystemsOf(cards)) {
    lines.push(`## ${sub}`, '');
    for (const c of cards.filter((x) => (x.subsystem || 'Unassigned') === sub)) {
      const kind = c.kind && c.kind !== 'class' ? ` _(${c.kind})_` : '';
      const name = c.name || c.id;
      const explicitId = toIdentifier(name) === c.id ? '' : ` {#${c.id}}`;
      lines.push(`### ${name}${kind}${explicitId}`, '');
      lines.push(`> **Purpose (card back):** ${esc(c.purpose) || '_none_'}`, '');
      const subs = (c.subclasses || []).map((s) => `\`${s}\``).join(', ') || 'none';
      lines.push(`**Superclass:** ${c.superclass ? `\`${c.superclass}\`` : 'none'} · **Subclasses:** ${subs}`, '');
      const contracts = Array.isArray(c.contracts) ? c.contracts : [];
      const contractOf = new Map();
      if (contracts.length) {
        lines.push('**Contracts:**', '');
        for (const k of contracts) {
          lines.push(`- **${k.number}. ${esc(k.name)}**${k.description ? ` — ${esc(k.description)}` : ''}`);
          for (const rid of k.responsibilities || []) contractOf.set(rid, k.number);
        }
        lines.push('', '| # | Responsibilities | Contract | Reqs | Collaborators |', '|---|---|---|---|---|');
      } else lines.push('| # | Responsibilities | Reqs | Collaborators |', '|---|---|---|---|');
      for (const r of c.responsibilities || []) {
        const reqs = compressReqs(expandReqRefs(r.reqs || [])) || '—';
        const refs = r.contractRefs || {};
        const col = (r.collaborators || []).map((x) => `\`${x}\`${refs[x] != null ? ` (${refs[x]})` : ''}`).join(', ') || '—';
        const text = `[${r.type}] ${esc(r.text).replace(/\|/g, '\\|')}`;
        if (contracts.length) lines.push(`| ${r.id} | ${text} | ${contractOf.has(r.id) ? contractOf.get(r.id) : 'private'} | ${reqs} | ${col} |`);
        else lines.push(`| ${r.id} | ${text} | ${reqs} | ${col} |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function traceabilityMarkdown(cards, reqs) {
  const cited = new Map();
  for (const c of cards) for (const r of c.responsibilities || []) for (const q of expandReqRefs(r.reqs || [])) {
    if (!cited.has(q)) cited.set(q, []);
    cited.get(q).push(`${c.id}.${r.id}`);
  }
  const lines = ['# Requirements Traceability', ''];
  let section = null;
  for (const id of reqs.ids) {
    const prefix = splitReq(id)[0];
    if (prefix !== section) {
      section = prefix;
      lines.push('', `## ${reqs.sections[prefix] || prefix} [${prefix}]`, '', '| Req | Requirement | Discharged by |', '|---|---|---|');
    }
    const by = cited.get(id);
    const txt = (reqs.text[id] || '').replace(/\|/g, '\\|');
    lines.push(`| ${id} | ${txt.length > 110 ? txt.slice(0, 107) + '…' : txt} | ${by ? by.map((x) => `\`${x}\``).join(', ') : '❌ **uncovered**'} |`);
  }
  return lines.join('\n') + '\n';
}

function mermaidId(id) { return String(id).replace(/[^A-Za-z0-9_]/g, '_'); }
function mermaidText(s) { return String(s).replace(/"/g, '#quot;').replace(/[<>]/g, ''); }
function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// "3" or "3, 5" — the contract numbers a client uses on a server ("?" when unspecified).
function contractLabels(cards) {
  const m = new Map();
  for (const l of resolveContracts(cards).links) {
    const key = `${l.from}->${l.to}`;
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(l.contract == null ? '?' : l.contract);
  }
  return new Map([...m].map(([k, v]) => [k, v.sort((a, b) => (a === '?') - (b === '?') || a - b).join(', ')]));
}

// Black-and-white Mermaid flowchart; each arrow is labelled with the contract number(s) it uses.
function collaborationMermaid(cards, opts = {}) {
  const lines = ['%%{init: {"theme": "base", "themeVariables": {"primaryColor": "#ffffff", "primaryBorderColor": "#000000", "primaryTextColor": "#000000", "lineColor": "#000000", "clusterBkg": "#ffffff", "clusterBorder": "#000000", "edgeLabelBackground": "#ffffff", "fontFamily": "Helvetica, Arial, sans-serif"}}}%%', 'flowchart LR'];
  const contractsOf = contractLabels(cards);
  const known = new Set(cards.map((c) => c.id));
  for (const sub of subsystemsOf(cards)) {
    lines.push(`  subgraph ${mermaidId('sub_' + sub)}["${mermaidText(sub)}"]`);
    for (const c of cards.filter((x) => (x.subsystem || 'Unassigned') === sub)) {
      const label = mermaidText(c.name || c.id);
      const text = c.kind && c.kind !== 'class' ? `«${c.kind}»<br/>${label}` : label;
      lines.push(`    ${mermaidId(c.id)}["${text}"]`);
    }
    lines.push('  end');
  }
  const declared = new Set();
  for (const e of collaborationEdges(cards)) {
    if (e.from === e.to) continue;
    if (!known.has(e.to) && !declared.has(e.to)) { declared.add(e.to); lines.push(`  ${mermaidId(e.to)}["⚠ ${mermaidText(e.to)}"]:::dangling`); }
    const label = opts.labels === false || !known.has(e.to) ? '' : contractsOf.get(`${e.from}->${e.to}`) || '';
    lines.push(label ? `  ${mermaidId(e.from)} -->|"${mermaidText(label)}"| ${mermaidId(e.to)}` : `  ${mermaidId(e.from)} --> ${mermaidId(e.to)}`);
  }
  lines.push('  classDef dangling fill:#fff,stroke:#000,stroke-dasharray:5 3,color:#000;');
  return lines.join('\n') + '\n';
}

function inheritanceMermaid(cards) {
  const lines = ['%%{init: {"theme": "base", "themeVariables": {"primaryColor": "#ffffff", "primaryBorderColor": "#000000", "primaryTextColor": "#000000", "lineColor": "#000000"}}}%%', 'classDiagram'];
  let any = false;
  for (const c of cards) {
    if (c.superclass) { lines.push(`  ${mermaidId(c.superclass)} <|-- ${mermaidId(c.id)}`); any = true; }
  }
  if (!any) lines.push('  class NoInheritance["No inheritance in this card set"]');
  return lines.join('\n') + '\n';
}

function walkthroughMermaid(wt, cards) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const lines = ['sequenceDiagram'];
  const participants = [];
  for (const s of wt.steps || []) for (const p of [s.from, s.to]) if (p && !participants.includes(p)) participants.push(p);
  for (const p of participants) {
    const c = byId.get(p);
    const ext = String(p).startsWith('@');
    lines.push(`  ${ext || (c && c.kind === 'actor') ? 'actor' : 'participant'} ${mermaidId(p)} as ${mermaidText(c ? c.name || c.id : ext ? p.slice(1) : '⚠ ' + p)}`);
  }
  let last = participants[0];
  for (const s of wt.steps || []) {
    if (s.break) {
      lines.push(`  Note over ${mermaidId(last || 'Nobody')}: ❌ BREAK — missing: ${mermaidText(s.missing || '?')}`);
      break;
    }
    const resp = byId.get(s.to) && (byId.get(s.to).responsibilities || []).find((r) => r.id === s.responsibilityId);
    const text = resp ? `${s.responsibilityId}: ${truncate(resp.text, 60)}` : `⚠ ${s.responsibilityId} (not on card)`;
    lines.push(`  ${mermaidId(s.from)}->>${mermaidId(s.to)}: ${mermaidText(text).replace(/[;#]/g, ',')}`);
    last = s.to;
  }
  return lines.join('\n') + '\n';
}

// One Markdown page: per scenario, whether it completes and a sequence diagram.
function scenariosMarkdown(cards, walkthroughs, title, validateOpts = {}) {
  const v = validate(JSON.parse(JSON.stringify(cards)), { ...validateOpts, reqIds: null, walkthroughs });
  const status = new Map((v.stats.walkthroughs ? v.stats.walkthroughs.results : []).map((r) => [r.scenarioId, r]));
  const lines = [`# ${title || 'Scenario Walkthroughs'}`, ''];
  for (const wt of walkthroughs) {
    const s = status.get(wt.scenarioId);
    const badge = s && s.complete ? '✅ completes using only responsibilities on the cards' : s && s.broken ? '❌ breaks — a needed responsibility is missing' : '⚠ has steps that do not match the cards';
    lines.push(`## ${wt.scenarioId} — ${wt.title || ''}`, '', `**Result:** ${badge}`, '');
    const problems = v.errors.filter((e) => e.scenario === wt.scenarioId);
    for (const p of problems) lines.push(`- ${p.message}`);
    if (problems.length) lines.push('');
    lines.push('```mermaid', walkthroughMermaid(wt, cards).trimEnd(), '```', '');
  }
  return lines.join('\n');
}

function collaborationDot(cards) {
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  const contractsOf = contractLabels(cards);
  const lines = ['digraph CRC {', '  rankdir=LR; bgcolor=white; node [shape=box, color=black, fontcolor=black, fontname="Helvetica"]; edge [color=black, fontcolor=black, fontname="Helvetica", fontsize=10, arrowhead=normal];'];
  subsystemsOf(cards).forEach((sub, i) => {
    lines.push(`  subgraph cluster_${i} { label=${q(sub)}; style=dashed;`);
    for (const c of cards.filter((x) => (x.subsystem || 'Unassigned') === sub)) {
      const label = c.kind && c.kind !== 'class' ? `«${c.kind}»\n${c.name || c.id}` : c.name || c.id;
      lines.push(`    ${q(c.id)} [label=${q(label)}];`);
    }
    lines.push('  }');
  });
  for (const e of collaborationEdges(cards)) {
    if (e.from === e.to) continue;
    lines.push(`  ${q(e.from)} -> ${q(e.to)} [tooltip=${q(e.resps.map((r) => r.text).join('; '))}, label=${q(contractsOf.get(`${e.from}->${e.to}`) || '')}];`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

function xmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
}
function htmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------- compact encoding (for prompts)

// One line per responsibility, far fewer tokens than JSON, every id kept:
//   ## Subsystem
//   ModelInterface "Model Interface" «interface» extends Base: <purpose>
//     contracts: 3 Sign documents [R2 R3]; 4 Report failures [R5]
//     R1 K Knows the sending model [INT-15–INT-19, PORT-01] -> HashModel, SignatureGenerator(5)
// oneLine: `Id «kind»: purpose | R1 text; R2 text` for context-only cards.
function cardsToCompact(cards, opts = {}) {
  const only = opts.only ? new Set(opts.only) : null;
  const list = cards.filter((c) => !only || only.has(c.id));
  const purpose = (c) => String(c.purpose || '').replace(/^The purpose of this class is to /i, '');
  const head = (c) => `${c.id}${c.name && c.name !== c.id ? ` "${c.name}"` : ''}${c.kind && c.kind !== 'class' ? ` «${c.kind}»` : ''}${c.superclass ? ` extends ${c.superclass}` : ''}`;
  if (opts.oneLine) return list.map((c) => `${head(c)}: ${purpose(c)} | ${(c.responsibilities || []).map((r) => `${r.id} ${r.text}`).join('; ')}`).join('\n') + '\n';
  const out = [];
  for (const sub of subsystemsOf(list)) {
    out.push(`## ${sub}`);
    for (const c of list.filter((x) => (x.subsystem || 'Unassigned') === sub)) {
      out.push(`${head(c)}: ${purpose(c)}`);
      if (Array.isArray(c.contracts) && c.contracts.length) out.push(`  contracts: ${c.contracts.map((k) => `${k.number} ${k.name} [${(k.responsibilities || []).join(' ')}]`).join('; ')}`);
      for (const r of c.responsibilities || []) {
        const refs = r.contractRefs || {};
        const col = (r.collaborators || []).map((x) => `${x}${refs[x] != null ? `(${refs[x]})` : ''}`).join(', ');
        out.push(`  ${r.id} ${r.type} ${r.text} [${compressReqs(expandReqRefs(r.reqs || []))}]${col ? ` -> ${col}` : ''}`);
      }
    }
  }
  return out.join('\n') + '\n';
}

// Every responsibility citing any of the given requirements: what an auditor needs
// to judge whether a requirement is covered across several cards.
function responsibilitiesCiting(cards, reqIds) {
  const want = new Set(expandReqRefs(reqIds || []));
  const out = [];
  for (const c of cards) for (const r of c.responsibilities || []) {
    const reqs = expandReqRefs(r.reqs || []).filter((q) => want.has(q));
    if (reqs.length) out.push({ card: c.id, resp: r.id, text: r.text, reqs });
  }
  return out;
}

// What a walkthrough relied on: responsibilities ("Card.R1"), collaboration edges, cards.
// If none of these changed, re-walking the scenario would give the same answer.
function walkthroughDependencies(wt) {
  const resps = new Set(), edges = new Set(), cardsUsed = new Set();
  for (const s of (wt && wt.steps) || []) {
    if (s.break) continue;
    if (s.to) { cardsUsed.add(s.to); if (s.responsibilityId) resps.add(`${s.to}.${s.responsibilityId}`); }
    if (s.from && !String(s.from).startsWith('@')) { cardsUsed.add(s.from); if (s.from !== s.to) edges.add(`${s.from}->${s.to}`); }
  }
  return { resps, edges, cards: cardsUsed };
}

// Does a diffCards() result touch anything this walkthrough depended on?
function walkthroughAffected(wt, diff) {
  const dep = walkthroughDependencies(wt);
  for (const id of diff.cardsRemoved) if (dep.cards.has(id)) return true;
  for (const e of diff.edgesRemoved) if (dep.edges.has(e)) return true;
  for (const c of diff.cardsChanged) {
    if (!dep.cards.has(c.id)) continue;
    if (c.fields.contracts) return true;
    for (const r of [...c.respRemoved, ...c.respChanged]) if (dep.resps.has(`${c.id}.${r.id}`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- collaboration graph
//
// Wirfs-Brock collaboration graph, as in the course slides: each class is a box,
// each contract a numbered semicircle set into the server's edge (the box stays a
// rectangle; the flat side of the semicircle lies on its border), and an arrow runs from
// a client to the contract it uses (two clients of one contract share a semicircle).
// Layout is left to right by dependency, clients left of their servers, with
// barycenter ordering to reduce crossings; each semicircle sits on the side of its
// box that faces its clients. The SVG and draw.io renderers draw this same layout.

const GRAPH = { boxH: 40, stereoH: 14, padX: 16, charW: 7.4, minW: 92, gapX: 130, gapY: 30, r: 13, margin: 30, titleH: 30, captionLine: 14 };

function collaborationLayout(cards, opts = {}) {
  const { contracts, links: allLinks } = resolveContracts(cards);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const inside = opts.subsystem ? new Set(cards.filter((c) => (c.subsystem || 'Unassigned') === opts.subsystem).map((c) => c.id)) : null;
  const links = allLinks.filter((l) => l.from !== l.to && (!inside || inside.has(l.from) || inside.has(l.to)));
  // Collaborators with no card stay visible: a dashed "(no card)" box, arrow straight to it.
  const missing = [];
  for (const c of cards) {
    if (inside && !inside.has(c.id)) continue;
    for (const r of c.responsibilities || []) for (const to of r.collaborators || []) {
      if (byId.has(to)) continue;
      let l = links.find((x) => x.from === c.id && x.to === to);
      if (!l) { l = { from: c.id, to, contract: null, resps: [] }; links.push(l); }
      l.resps.push(r.id);
      if (!missing.includes(to)) missing.push(to);
    }
  }
  const wanted = inside ? new Set([...inside, ...links.flatMap((l) => [l.from, l.to])]) : new Set([...cards.map((c) => c.id), ...missing]);
  const order = [...cards.map((c) => c.id), ...missing].filter((id) => wanted.has(id));
  const subIndex = new Map(subsystemsOf(cards).map((sname, i) => [sname, i]));

  const nodes = new Map(order.map((id) => {
    const c = byId.get(id) || { id, name: `${id} (no card)`, kind: 'class', missing: true };
    const label = c.name || c.id;
    const stereo = c.kind && c.kind !== 'class' ? `«${c.kind}»` : '';
    const w = Math.max(GRAPH.minW, Math.ceil(Math.max(label.length, stereo.length * 0.8) * GRAPH.charW) + 2 * GRAPH.padX);
    return [id, { id, label, stereo, external: c.missing || (!!inside && !inside.has(id)), missing: !!c.missing, w, h: GRAPH.boxH + (stereo ? GRAPH.stereoH : 0), x: 0, y: 0, layer: 0, sub: c.missing ? 1e9 : subIndex.get(c.subsystem || 'Unassigned') || 0 }];
  }));

  // Columns. Order the classes so most arrows point forward (greedy feedback-arc-set
  // ordering: clients early, servers late). Small graphs keep their true dependency
  // layers; dense ones are cut into a few balanced columns sized for a slide.
  const out = new Map(order.map((id) => [id, new Set()]));
  const inn = new Map(order.map((id) => [id, new Set()]));
  for (const l of links) { out.get(l.from).add(l.to); inn.get(l.to).add(l.from); }
  const left = [], right = [];
  const alive = new Set(order);
  const deg = (id, m) => [...m.get(id)].filter((x) => alive.has(x)).length;
  while (alive.size) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const id of order) if (alive.has(id) && !deg(id, out)) { right.unshift(id); alive.delete(id); moved = true; }
      for (const id of order) if (alive.has(id) && !deg(id, inn)) { left.push(id); alive.delete(id); moved = true; }
    }
    if (!alive.size) break;
    let best = null, bestScore = -Infinity;
    for (const id of order) if (alive.has(id)) { const sc = deg(id, out) - deg(id, inn); if (sc > bestScore) { best = id; bestScore = sc; } }
    left.push(best);
    alive.delete(best);
  }
  const linear = [...left, ...right];
  const at = new Map(linear.map((id, i) => [id, i]));
  // True layers on the forward edges of that order (longest path).
  for (const id of linear) for (const v of out.get(id)) if (at.get(v) > at.get(id) && nodes.get(v).layer < nodes.get(id).layer + 1) nodes.get(v).layer = nodes.get(id).layer + 1;
  let layerCount = Math.max(0, ...[...nodes.values()].map((n) => n.layer)) + 1;
  const avgW = [...nodes.values()].reduce((a, n) => a + n.w, 0) / Math.max(1, nodes.size);
  const maxCols = Math.max(links.length ? 2 : 1, Math.ceil(Math.sqrt(nodes.size * 1.6 * (GRAPH.boxH + GRAPH.gapY) / (avgW + GRAPH.gapX))));
  if (layerCount > maxCols) {
    // Too many layers for a slide: place each class one column right of its latest
    // client where possible, with a per-column capacity so columns stay balanced.
    layerCount = Math.min(maxCols, linear.length);
    const cap = Math.ceil(linear.length / layerCount) + 1;
    const count = Array(layerCount).fill(0);
    const col = new Map();
    for (const id of linear) {
      const preds = [...inn.get(id)].filter((u) => col.has(u));
      let c = Math.min(layerCount - 1, preds.length ? Math.max(...preds.map((u) => col.get(u) + 1)) : 0);
      while (c < layerCount && count[c] >= cap) c++;
      if (c === layerCount) { c = layerCount - 1; while (c > 0 && count[c] >= cap) c--; }
      col.set(id, c);
      count[c]++;
      nodes.get(id).layer = c;
    }
  }
  const layers = Array.from({ length: layerCount }, () => []);
  for (const id of linear) layers[nodes.get(id).layer].push(id);
  for (const L of layers) L.sort((a, b) => nodes.get(a).sub - nodes.get(b).sub);

  // Order within layers: barycenter of neighbours in other layers, a few sweeps.
  const neighbours = new Map(order.map((id) => [id, [...out.get(id), ...inn.get(id)]]));
  const rank = () => { const m = new Map(); for (const L of layers) L.forEach((id, i) => m.set(id, L.length > 1 ? i / (L.length - 1) : 0.5)); return m; };
  for (let sweep = 0; sweep < 8; sweep++) {
    const pos = rank();
    for (const L of layers) {
      const bary = new Map(L.map((id, i) => {
        const ns = neighbours.get(id).filter((n) => nodes.get(n).layer !== nodes.get(id).layer);
        return [id, ns.length ? ns.reduce((a, n) => a + pos.get(n), 0) / ns.length : pos.get(id)];
      }));
      L.sort((a, b) => bary.get(a) - bary.get(b));
    }
  }

  const place = () => {
    let x = GRAPH.margin;
    const top = GRAPH.margin + (opts.title ? GRAPH.titleH : 0);
    const colH = layers.map((L) => L.reduce((a, id) => a + nodes.get(id).h, 0) + GRAPH.gapY * Math.max(0, L.length - 1));
    const maxH = Math.max(0, ...colH);
    layers.forEach((L, i) => {
      const colW = Math.max(0, ...L.map((id) => nodes.get(id).w));
      let y = top + (maxH - colH[i]) / 2;
      for (const id of L) {
        const n = nodes.get(id);
        n.x = x + (colW - n.w) / 2;
        n.y = y;
        y += n.h + GRAPH.gapY;
      }
      x += colW + GRAPH.gapX;
    });
    return { width: x - GRAPH.gapX + GRAPH.margin, height: top + maxH + GRAPH.margin + 3 * GRAPH.captionLine };
  };
  place();

  // Contracts to draw on each box: its own (whole-system graph, or a class inside the
  // subsystem) plus any contract a drawn arrow points at.
  const marks = [];
  const markKey = new Map();
  const centre = (n) => [n.x + n.w / 2, n.y + n.h / 2];
  const addMark = (cardId, number) => {
    const key = `${cardId}#${number}`;
    if (markKey.has(key) || !nodes.has(cardId)) return;
    const k = contracts.find((x) => x.number === number);
    const m = { number, card: cardId, derived: !!(k && k.derived), name: k ? k.name : '', side: 'left', cx: 0, cy: 0 };
    markKey.set(key, m);
    marks.push(m);
  };
  for (const k of contracts) if (nodes.has(k.card) && !nodes.get(k.card).external && (!k.derived || links.some((l) => l.to === k.card))) addMark(k.card, k.number);
  for (const l of links) if (l.contract != null) addMark(l.to, l.contract);

  const chooseSides = () => {
    for (const m of marks) {
      const n = nodes.get(m.card);
      const clients = links.filter((l) => l.to === m.card && l.contract === m.number).map((l) => nodes.get(l.from)).filter(Boolean);
      if (!clients.length) { m.side = 'left'; continue; }
      const [cx, cy] = centre(n);
      const dx = clients.reduce((a, c) => a + (c.layer === n.layer ? cx + n.w : centre(c)[0]), 0) / clients.length - cx;
      const dy = clients.reduce((a, c) => a + centre(c)[1], 0) / clients.length - cy;
      m.side = Math.abs(dx) >= Math.abs(dy) * 0.6 ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'top' : 'bottom');
      m.sortKey = m.side === 'left' || m.side === 'right' ? cy + dy : cx + dx;
    }
  };
  chooseSides();
  // Grow boxes that carry several contracts on one side, then re-place.
  const slot = 2 * GRAPH.r + 10;
  let grew = false;
  for (const n of nodes.values()) {
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const k = marks.filter((m) => m.card === n.id && m.side === side).length;
      if (!k) continue;
      if ((side === 'left' || side === 'right') && n.h < k * slot + 10) { n.h = k * slot + 10; grew = true; }
      if ((side === 'top' || side === 'bottom') && n.w < k * slot + 10) { n.w = k * slot + 10; grew = true; }
    }
  }
  let size = place();
  if (grew) { chooseSides(); size = place(); }
  // Semicircles are inset, so a side that carries contracts gets a radius of extra room
  // and the label is centred in what's left (renderers shift it by n.inset).
  let insetGrew = false;
  for (const n of nodes.values()) {
    const has = (side) => (marks.some((m) => m.card === n.id && m.side === side) ? GRAPH.r : 0);
    n.inset = { left: has('left'), right: has('right'), top: has('top'), bottom: has('bottom') };
    const dw = n.inset.left + n.inset.right;
    const dh = n.inset.top + n.inset.bottom;
    if (dw || dh) { n.w += dw; n.h += dh; insetGrew = true; }
  }
  if (insetGrew) size = place();
  for (const n of nodes.values()) {
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const ms = marks.filter((m) => m.card === n.id && m.side === side).sort((a, b) => (a.sortKey || 0) - (b.sortKey || 0) || a.number - b.number);
      ms.forEach((m, i) => {
        const t = (i + 1) / (ms.length + 1);
        if (side === 'left') { m.cx = n.x; m.cy = n.y + n.h * t; }
        if (side === 'right') { m.cx = n.x + n.w; m.cy = n.y + n.h * t; }
        if (side === 'top') { m.cx = n.x + n.w * t; m.cy = n.y; }
        if (side === 'bottom') { m.cx = n.x + n.w * t; m.cy = n.y + n.h; }
      });
    }
  }

  // Arrow geometry: from the client's box edge to the middle of the semicircle's flat side,
  // which is on the server's border.
  const edgePoint = (n, tx, ty) => {
    const [cx, cy] = centre(n);
    const dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return [cx, cy];
    const sx = dx ? (n.w / 2) / Math.abs(dx) : Infinity;
    const sy = dy ? (n.h / 2) / Math.abs(dy) : Infinity;
    const k = Math.min(sx, sy);
    return [cx + dx * k, cy + dy * k];
  };
  const apex = (m) => [m.cx, m.cy];
  const arrows = links.map((l) => {
    const target = nodes.get(l.to);
    const m = l.contract != null ? markKey.get(`${l.to}#${l.contract}`) : null;
    const [tx, ty] = m ? apex(m) : edgePoint(target, ...centre(nodes.get(l.from)));
    const src = nodes.get(l.from);
    const sameColumn = src.layer === target.layer;
    // Arrows within one column bend out to the right of it instead of crossing the boxes between.
    // ...on the side where the target's semicircle is, so the arrowhead stays visible.
    const out = Math.abs(ty - centre(src)[1]) * 0.25 + 40;
    const bend = !sameColumn ? null : m && m.side === 'left'
      ? [Math.min(src.x, target.x) - out, (centre(src)[1] + ty) / 2]
      : [Math.max(src.x + src.w, target.x + target.w) + out, (centre(src)[1] + ty) / 2];
    const [sx, sy] = edgePoint(src, ...(bend || [tx, ty]));
    return { from: l.from, to: l.to, contract: l.contract, resps: l.resps, x1: sx, y1: sy, x2: tx, y2: ty, bend };
  });

  return {
    title: opts.title || '',
    nodes: [...nodes.values()],
    marks,
    arrows,
    width: Math.ceil(size.width),
    height: Math.ceil(size.height),
    derived: marks.some((m) => m.derived),
    unspecified: arrows.filter((a) => a.contract == null).length,
  };
}

function fmt(n) { return Math.round(n * 10) / 10; }

// Black-and-white SVG of the collaboration graph (paste into a report or slides).
function collaborationSvg(cards, opts = {}) {
  const G = collaborationLayout(cards, opts);
  const r = GRAPH.r;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${G.width}" height="${G.height}" viewBox="0 0 ${G.width} ${G.height}" font-family="Helvetica, Arial, sans-serif">`);
  out.push('<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#000"/></marker></defs>');
  out.push(`<rect width="${G.width}" height="${G.height}" fill="#fff"/>`);
  if (G.title) out.push(`<text x="${GRAPH.margin}" y="${GRAPH.margin + 4}" font-size="16" font-weight="bold" fill="#000">${htmlEsc(G.title)}</text>`);
  for (const a of G.arrows) {
    const tip = `<title>${htmlEsc(`${a.from} → ${a.to}${a.contract != null ? ` (${a.contract})` : ''}: ${a.resps.join(', ')}`)}</title>`;
    if (a.bend) out.push(`<path d="M${fmt(a.x1)},${fmt(a.y1)} Q${fmt(a.bend[0])},${fmt(a.bend[1])} ${fmt(a.x2)},${fmt(a.y2)}" fill="none" stroke="#000" stroke-width="1" marker-end="url(#arrow)">${tip}</path>`);
    else out.push(`<line x1="${fmt(a.x1)}" y1="${fmt(a.y1)}" x2="${fmt(a.x2)}" y2="${fmt(a.y2)}" stroke="#000" stroke-width="1" marker-end="url(#arrow)">${tip}</line>`);
  }
  for (const n of G.nodes) {
    out.push(`<rect x="${fmt(n.x)}" y="${fmt(n.y)}" width="${fmt(n.w)}" height="${fmt(n.h)}" fill="#fff" stroke="#000" stroke-width="1.2"${n.external ? ' stroke-dasharray="5 3"' : ''}/>`);
    const cx = n.x + n.w / 2 + (n.inset.left - n.inset.right) / 2;
    const cy = n.y + n.h / 2 + (n.inset.top - n.inset.bottom) / 2;
    if (n.stereo) {
      out.push(`<text x="${fmt(cx)}" y="${fmt(cy - 6)}" font-size="11" text-anchor="middle" fill="#000">${htmlEsc(n.stereo)}</text>`);
      out.push(`<text x="${fmt(cx)}" y="${fmt(cy + 10)}" font-size="13" text-anchor="middle" fill="#000">${htmlEsc(n.label)}</text>`);
    } else {
      out.push(`<text x="${fmt(cx)}" y="${fmt(cy + 4.5)}" font-size="13" text-anchor="middle" fill="#000">${htmlEsc(n.label)}</text>`);
    }
  }
  for (const m of G.marks) {
    const [ax, ay, bx, by, sweep, tx, ty] = {
      left: [m.cx, m.cy - r, m.cx, m.cy + r, 1, m.cx + r * 0.47, m.cy], // bulges into the box
      right: [m.cx, m.cy - r, m.cx, m.cy + r, 0, m.cx - r * 0.47, m.cy],
      top: [m.cx - r, m.cy, m.cx + r, m.cy, 0, m.cx, m.cy + r * 0.42],
      bottom: [m.cx - r, m.cy, m.cx + r, m.cy, 1, m.cx, m.cy - r * 0.42],
    }[m.side];
    out.push(`<path d="M${fmt(ax)},${fmt(ay)} A${r},${r} 0 0 ${sweep} ${fmt(bx)},${fmt(by)} Z" fill="#fff" stroke="#000" stroke-width="1.2"><title>${htmlEsc(`Contract ${m.number}: ${m.name}${m.derived ? ' (derived)' : ''}`)}</title></path>`);
    out.push(`<text x="${fmt(tx)}" y="${fmt(ty + 3.2)}" font-size="${m.number >= 100 ? 7.5 : m.number >= 10 ? 8.5 : 10}" text-anchor="middle" fill="#000">${m.number}</text>`);
  }
  const notes = ['Arrows run from a client to the numbered contract (semicircle) it uses.'];
  if (opts.subsystem) notes.push('Dashed boxes are classes outside this subsystem.');
  if (G.nodes.some((n) => n.missing)) notes.push('"(no card)" boxes are collaborators named on a card that has no card of its own.');
  if (G.derived) notes.push('Classes whose cards declare no contracts are shown with one contract each.');
  notes.forEach((t, i) => out.push(`<text x="${GRAPH.margin}" y="${fmt(G.height - GRAPH.margin / 2 - (notes.length - 1 - i) * GRAPH.captionLine)}" font-size="10" fill="#000">${htmlEsc(t)}</text>`));
  out.push('</svg>');
  return out.join('\n') + '\n';
}

// draw.io file of the same graph, editable: each class is a group of its box and
// its contract semicircles, so they move together. draw.io has no half-circle shape,
// so each semicircle is a small SVG image set into the box edge, labelled with its number.
const HALF_CIRCLE_SVG = (() => {
  const r = GRAPH.r, k = r - 0.6; // keep the stroke inside the image
  const svg = (w, h, d) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="#ffffff" stroke="#000000" stroke-width="1.2"/></svg>`;
  const b64 = (x) => (typeof Buffer !== 'undefined' ? Buffer.from(x).toString('base64') : btoa(x));
  return {
    left: b64(svg(r, 2 * r, `M0,${r - k} A${k},${k} 0 0 1 0,${r + k} Z`)),
    right: b64(svg(r, 2 * r, `M${r},${r - k} A${k},${k} 0 0 0 ${r},${r + k} Z`)),
    top: b64(svg(2 * r, r, `M${r - k},0 A${k},${k} 0 0 0 ${r + k},0 Z`)),
    bottom: b64(svg(2 * r, r, `M${r - k},${r} A${k},${k} 0 0 1 ${r + k},${r} Z`)),
  };
})();
function collaborationDrawio(cards, opts = {}) {
  const G = collaborationLayout(cards, opts);
  const r = GRAPH.r;
  const cells = [];
  let nextId = 2;
  const nid = () => `c${nextId++}`;
  const boxId = new Map();
  const markId = new Map();
  if (G.title) cells.push(`<mxCell id="${nid()}" value="${xmlEsc(G.title)}" style="text;html=1;fontStyle=1;fontSize=16;align=left;verticalAlign=top;fontColor=#000000;" vertex="1" parent="1"><mxGeometry x="${GRAPH.margin}" y="${GRAPH.margin - 10}" width="600" height="24" as="geometry"/></mxCell>`);
  for (const n of G.nodes) {
    const gx = n.x, gy = n.y;
    const gid = nid();
    cells.push(`<mxCell id="${gid}" value="" style="group" vertex="1" connectable="0" parent="1"><mxGeometry x="${fmt(gx)}" y="${fmt(gy)}" width="${fmt(n.w)}" height="${fmt(n.h)}" as="geometry"/></mxCell>`);
    // Box first, semicircles on top of it.
    const bid = nid();
    boxId.set(n.id, bid);
    const label = n.stereo ? `${htmlEsc(n.stereo)}<br>${htmlEsc(n.label)}` : htmlEsc(n.label);
    const spacing = `spacingLeft=${n.inset.left};spacingRight=${n.inset.right};spacingTop=${n.inset.top};spacingBottom=${n.inset.bottom};`;
    cells.push(`<mxCell id="${bid}" value="${xmlEsc(label)}" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#000000;fontColor=#000000;fontSize=13;${spacing}${n.external ? 'dashed=1;' : ''}" vertex="1" parent="${gid}"><mxGeometry x="0" y="0" width="${fmt(n.w)}" height="${fmt(n.h)}" as="geometry"/></mxCell>`);
    for (const m of G.marks.filter((x) => x.card === n.id)) {
      const id = nid();
      markId.set(`${m.card}#${m.number}`, id);
      const [x, y, w, h] = { left: [m.cx, m.cy - r, r, 2 * r], right: [m.cx - r, m.cy - r, r, 2 * r], top: [m.cx - r, m.cy, 2 * r, r], bottom: [m.cx - r, m.cy - r, 2 * r, r] }[m.side];
      cells.push(`<UserObject label="${m.number}" tooltip="${xmlEsc(`Contract ${m.number}: ${m.name}${m.derived ? ' (derived)' : ''}`)}" id="${id}"><mxCell style="shape=image;image=data:image/svg+xml,${HALF_CIRCLE_SVG[m.side]};imageAspect=0;html=1;fontColor=#000000;fontSize=${m.number >= 100 ? 7 : m.number >= 10 ? 8 : 10};" vertex="1" parent="${gid}"><mxGeometry x="${fmt(x - gx)}" y="${fmt(y - gy)}" width="${w}" height="${h}" as="geometry"/></mxCell></UserObject>`);
    }
  }
  for (const a of G.arrows) {
    const target = a.contract != null ? markId.get(`${a.to}#${a.contract}`) : boxId.get(a.to);
    const tip = `${a.from} → ${a.to}${a.contract != null ? ` (contract ${a.contract})` : ''}: ${a.resps.join(', ')}`;
    const points = a.bend ? `<Array as="points"><mxPoint x="${fmt(a.bend[0])}" y="${fmt(a.bend[1])}"/></Array>` : '';
    cells.push(`<UserObject label="" tooltip="${xmlEsc(tip)}" id="${nid()}"><mxCell style="endArrow=block;endFill=1;html=1;rounded=0;strokeColor=#000000;${a.bend ? 'curved=1;' : ''}" edge="1" parent="1" source="${boxId.get(a.from)}" target="${target}"><mxGeometry relative="1" as="geometry">${points}</mxGeometry></mxCell></UserObject>`);
  }
  return `<mxfile host="crc-toolkit"><diagram name="${xmlEsc(opts.name || opts.title || 'Collaboration graph')}" id="crc"><mxGraphModel grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" page="0" background="#FFFFFF"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel></diagram></mxfile>\n`;
}

// Contract documentation, in the course's CRC-extension layout (Contracts.pptx, slide 13).
function contractsMarkdown(cards, opts = {}) {
  const { contracts } = resolveContracts(cards);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const L = [`# ${opts.title || 'Contracts'}`, ''];
  L.push('Contract numbers are unique across the system; the collaboration graph shows each one as a numbered semicircle.');
  if (contracts.some((k) => k.derived)) L.push('Contracts marked *derived* belong to classes whose cards declare no contracts: the class is shown as offering all its responsibilities as one contract.');
  L.push('', '| # | Contract | Class | Used by |', '|---|---|---|---|');
  for (const k of [...contracts].sort((a, b) => a.number - b.number)) {
    const c = byId.get(k.card);
    L.push(`| ${k.number} | ${k.name}${k.derived ? ' _(derived)_' : ''} | ${c ? c.name || c.id : k.card} | ${k.clients.map((x) => (byId.get(x) || {}).name || x).join(', ') || '—'} |`);
  }
  for (const c of cards) {
    const mine = contracts.filter((k) => k.card === c.id).sort((a, b) => a.number - b.number);
    if (!mine.length) continue;
    const resp = new Map((c.responsibilities || []).map((r) => [r.id, r]));
    const line = (r) => {
      const refs = r.contractRefs || {};
      const col = (r.collaborators || []).map((x) => `${(byId.get(x) || {}).name || x}${refs[x] != null ? ` (${refs[x]})` : ''}`).join(', ');
      return `| ${r.text} | ${col || ''} |`;
    };
    L.push('', `## Class: ${c.name || c.id}`, '', `**Superclass:** ${c.superclass ? (byId.get(c.superclass) || {}).name || c.superclass : 'none'}  `, `**Description:** ${c.purpose || ''}`, '', '**Contracts:**');
    const inContract = new Set();
    for (const k of mine) {
      L.push('', `${k.number}. **${k.name}**${k.derived ? ' _(derived)_' : ''}${k.description ? ` — ${k.description}` : ''}`, '', '| Responsibilities | Collaborators |', '|---|---|');
      for (const rid of k.responsibilities) { if (resp.has(rid)) { L.push(line(resp.get(rid))); inContract.add(rid); } }
    }
    const priv = (c.responsibilities || []).filter((r) => !inContract.has(r.id));
    if (priv.length) L.push('', '**Private Responsibilities:**', '', '| Responsibilities | Collaborators |', '|---|---|', ...priv.map(line));
  }
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- importers

function normName(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function toIdentifier(s) {
  const words = String(s).replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const id = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(id) ? id : 'X' + id;
}

// Resolve collaborator names to card ids, case- and space-insensitively.
// Unresolvable names are kept (as identifiers) so the validator reports them.
function resolveNames(cards) {
  const lookup = new Map(cards.map((c) => [normName(c.name || c.id), c.id]));
  const notes = [];
  const fix = (name, where) => {
    const id = lookup.get(normName(name));
    if (id && id !== name) notes.push(`${where}: "${name}" → ${id}`);
    return id || toIdentifier(name);
  };
  for (const c of cards) {
    if (c.superclass) c.superclass = fix(c.superclass, `${c.id} superclass`);
    c.subclasses = (c.subclasses || []).map((s) => fix(s, `${c.id} subclass`));
    for (const r of c.responsibilities) {
      r.collaborators = [...new Set(r.collaborators.map((x) => fix(x, `${c.id}.${r.id}`)))];
      if (r.contractRefs) r.contractRefs = Object.fromEntries(Object.entries(r.contractRefs).map(([k, v]) => [lookup.get(normName(k)) || toIdentifier(k), v]));
    }
  }
  return notes;
}

// Line-based format used by the hand-made cards:
//   Name[:] / purpose / Subclass: / SuperClass: / Responsibilities: / ... / Collaborators: / ...
// Header spellings vary ("Resonsibilites", "Resonibilitys"), so they are matched loosely.
// Card-level collaborators are attached to every behavior responsibility, since
// the source format does not say which responsibility needs which collaborator.
function importLineCards(text) {
  const blocks = text.split(/\r?\n\s*\r?\n/).map((b) => b.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)).filter((b) => b.length);
  const cards = [];
  const isResp = (l) => /^re[a-z]*bili[a-z]*:?$/i.test(l);
  const isCollab = (l) => /^collaborators?:?$/i.test(l);
  const sub = (l) => l.match(/^sub\s*class(?:es)?\s*:?\s*(.*)$/i);
  const sup = (l) => l.match(/^super\s*class(?:es)?\s*:?\s*(.*)$/i);
  for (const b of blocks) {
    const name = b[0].replace(/:$/, '').trim();
    const card = { id: toIdentifier(name), name, kind: 'class', subsystem: 'Unassigned', purpose: '', superclass: null, subclasses: [], responsibilities: [] };
    let mode = 'purpose';
    const collabs = [];
    for (const l of b.slice(1)) {
      let m;
      if ((m = sub(l))) { mode = 'sub'; if (m[1]) card.subclasses.push(...m[1].split(/,\s*/)); continue; }
      if ((m = sup(l))) { mode = 'sup'; if (m[1]) card.superclass = m[1]; continue; }
      if (isResp(l)) { mode = 'resp'; continue; }
      if (isCollab(l)) { mode = 'collab'; continue; }
      if (mode === 'purpose') card.purpose = card.purpose ? `${card.purpose} ${l}` : l;
      else if (mode === 'resp') card.responsibilities.push({ id: `R${card.responsibilities.length + 1}`, text: l, type: /^knows?\b/i.test(l) ? 'K' : 'B', reqs: [], collaborators: [] });
      else if (mode === 'collab') collabs.push(l);
      else if (mode === 'sub') card.subclasses.push(l);
      else if (mode === 'sup') card.superclass = l;
    }
    for (const r of card.responsibilities) if (r.type === 'B' || card.responsibilities.every((x) => x.type === 'K')) r.collaborators = [...collabs];
    if (!card.responsibilities.length && collabs.length) card.responsibilities.push({ id: 'R1', text: '(collaborators listed without a responsibility)', type: 'B', reqs: [], collaborators: [...collabs] });
    cards.push(card);
  }
  const notes = resolveNames(cards);
  return { cards, notes };
}

// Read the Markdown card format (see cardsToMarkdown). Forgiving on purpose:
// tables are read by header name, so column order doesn't matter; "Card N — `Name`"
// headings, "## Subsystem N — Title" headings and backtick-free names all work;
// "## Part ..." sections (prose, scenario tables) are skipped.
function parseMarkdownCards(md) {
  const cards = [];
  let subsystem = 'Unassigned';
  let skipping = false;
  let card = null;
  let cols = null; // column index map for the current table
  const names = (s) => {
    if (/^\s*(none|—|-|n\/a)\b/i.test(s)) return []; // "none — they are attributes" means none
    const ticked = (s.match(/`([^`]+)`/g) || []).map((x) => x.slice(1, -1).trim());
    if (ticked.length) return ticked;
    return s.split(/\s*,\s*/).map((x) => x.trim()).filter((x) => x && !/^(none|—|-|n\/a)$/i.test(x));
  };
  const cells = (line) => line.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((x) => x.trim());
  // "`DisplayScreen` (7), Keypad" -> names [DisplayScreen, Keypad], refs {DisplayScreen: 7}
  const collabCell = (s) => {
    const refs = {};
    const list = [];
    if (/^\s*(none|—|-|n\/a)\s*$/i.test(s)) return { list, refs };
    for (const part of s.split(/\s*,\s*/)) {
      const m = part.match(/^`?([^`(]+?)`?\s*(?:\((\d+)\))?\s*$/);
      if (!m || !m[1].trim() || /^(none|—|-|n\/a)$/i.test(m[1].trim())) continue;
      list.push(m[1].trim());
      if (m[2]) refs[m[1].trim()] = parseInt(m[2], 10);
    }
    return { list, refs };
  };
  // "- **3. Sign documents** — description" / "- 3. Sign documents: description"
  const contractLine = (s) => {
    let t = s.replace(/^[-*]\s+/, '').trim();
    let m = t.match(/^\*\*\s*(\d+)[.)]\s*(.*?)\*\*\s*(?:[—–:-]\s*)?(.*)$/);
    if (m) return { number: parseInt(m[1], 10), name: m[2].trim(), description: m[3].trim(), responsibilities: [] };
    m = t.match(/^(\d+)[.)]\s*(.*?)(?:\s+[—–]\s+|:\s+)(.*)$/) || t.match(/^(\d+)[.)]\s*(.*)$/);
    return m ? { number: parseInt(m[1], 10), name: (m[2] || '').trim(), description: (m[3] || '').trim(), responsibilities: [] } : null;
  };
  let inContracts = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^##\s+(?!#)(.+)$/))) {
      const title = m[1].trim();
      card = null; cols = null;
      skipping = /^Part\b/i.test(title);
      if (!skipping) subsystem = title.replace(/^Subsystem\s+\d+\s*[—–:-]\s*/i, '').trim();
      continue;
    }
    if (skipping) continue;
    if ((m = line.match(/^###\s+(.+)$/))) {
      let head = m[1].trim();
      let id = null;
      let kind = 'class';
      const idm = head.match(/\{#([A-Za-z][A-Za-z0-9_]*)\}\s*$/);
      if (idm) { id = idm[1]; head = head.slice(0, idm.index).trim(); }
      const km = head.match(/[_*]\((class|interface|actor|external)\)[_*]\s*$/i);
      if (km) { kind = km[1].toLowerCase(); head = head.slice(0, km.index).trim(); }
      head = head.replace(/^Card\s+\d+\s*[—–:-]\s*/i, '').replace(/^`|`$/g, '').trim();
      card = { id: id || toIdentifier(head), name: head, kind, subsystem, purpose: '', superclass: null, subclasses: [], responsibilities: [] };
      cards.push(card);
      cols = null;
      inContracts = false;
      continue;
    }
    if (!card) continue;
    if (/^\*\*Contracts:?\*\*:?\s*$/i.test(line)) { inContracts = true; card.contracts = card.contracts || []; continue; }
    if (inContracts && /^[-*]\s+/.test(line)) {
      const k = contractLine(line);
      if (k) card.contracts.push(k);
      continue;
    }
    if (inContracts && line && !/^[-*]\s+/.test(line)) inContracts = false;
    if ((m = line.match(/^>\s*(.*)$/))) {
      const text = m[1].replace(/^\*\*[^*]*\*\*\s*/, '').trim();
      card.purpose = text === '_none_' ? '' : card.purpose ? `${card.purpose} ${text}` : text;
      continue;
    }
    if ((m = line.match(/\*\*Superclass(?:es)?:\*\*\s*([^·|]*?)\s*(?:[·|]|$)/i))) {
      card.superclass = names(m[1])[0] || null;
      const sm = line.match(/\*\*Subclass(?:es)?:\*\*\s*(.*)$/i);
      if (sm) card.subclasses = names(sm[1]);
      continue;
    }
    if ((m = line.match(/^\*\*Subclass(?:es)?:\*\*\s*(.*)$/i))) { card.subclasses = names(m[1]); continue; }
    if (!line.startsWith('|')) continue;
    const row = cells(line);
    if (!cols) {
      const find = (re) => row.findIndex((h) => re.test(h));
      const resp = find(/^respons/i);
      if (resp < 0) continue; // not a card table
      cols = { id: find(/^(#|id)$/i), resp, reqs: find(/^req/i), collab: find(/^collab/i), contract: find(/^contract/i) };
      continue;
    }
    if (row.every((x) => /^:?-{3,}:?$/.test(x))) continue; // separator row
    let text = (row[cols.resp] || '').replace(/\\\|/g, '|').replace(/\s*⚠\s*/g, ' ').trim();
    if (!text) continue;
    let type = /^knows?\b/i.test(text) ? 'K' : 'B';
    const tm = text.match(/^\[(K|B)\]\s*/i);
    if (tm) { type = tm[1].toUpperCase(); text = text.slice(tm[0].length).trim(); }
    const given = cols.id >= 0 ? (row[cols.id] || '').trim() : '';
    const collab = cols.collab >= 0 ? collabCell(row[cols.collab] || '') : { list: [], refs: {} };
    const resp = {
      id: given || null,
      text,
      type,
      reqs: cols.reqs >= 0 ? expandReqRefs(row[cols.reqs] || '') : [],
      collaborators: collab.list,
    };
    if (Object.keys(collab.refs).length) resp.contractRefs = collab.refs;
    card.responsibilities.push(resp);
    const cn = cols.contract >= 0 ? (row[cols.contract] || '').match(/^\s*(\d+)\s*$/) : null;
    if (cn) resp._contract = parseInt(cn[1], 10);
  }
  // Rows without an explicit id get the next free R<n>, so explicit ids never collide.
  for (const c of cards) {
    const used = new Set(c.responsibilities.map((r) => r.id).filter(Boolean));
    let n = 0;
    for (const r of c.responsibilities) {
      if (r.id) continue;
      do n++; while (used.has(`R${n}`));
      r.id = `R${n}`;
      used.add(r.id);
    }
    // The Contract column assigns responsibilities to the listed contracts.
    for (const r of c.responsibilities) {
      if (r._contract == null) continue;
      c.contracts = c.contracts || [];
      let k = c.contracts.find((x) => x.number === r._contract);
      if (!k) { k = { number: r._contract, name: `Contract ${r._contract}`, description: '', responsibilities: [] }; c.contracts.push(k); }
      k.responsibilities.push(r.id);
      delete r._contract;
    }
  }
  const notes = resolveNames(cards);
  return { cards, notes };
}

// Kept for older callers: the AI run's table format is a subset of the Markdown format.
const importTableCards = parseMarkdownCards;

// Canonical form for comparison and clean output: every field present,
// requirement refs expanded and sorted, subsystem defaulted.
function normalizeCards(cards) {
  return cards.map((c) => ({
    id: c.id,
    name: c.name || c.id,
    kind: c.kind || 'class',
    subsystem: c.subsystem || 'Unassigned',
    purpose: c.purpose || '',
    superclass: c.superclass || null,
    subclasses: [...(c.subclasses || [])],
    ...(Array.isArray(c.contracts) && c.contracts.length ? {
      contracts: c.contracts.map((k) => ({ number: parseInt(k.number, 10), name: k.name || '', description: k.description || '', responsibilities: [...(k.responsibilities || [])] })),
    } : {}),
    responsibilities: (c.responsibilities || []).map((r) => ({
      id: r.id,
      text: r.text,
      type: r.type,
      reqs: expandReqRefs(r.reqs || []).sort(reqSort),
      collaborators: [...(r.collaborators || [])],
      ...(r.contractRefs && Object.keys(r.contractRefs).length ? {
        contractRefs: Object.fromEntries(Object.entries(r.contractRefs).sort().map(([k, v]) => [k, parseInt(v, 10)])),
      } : {}),
    })),
  }));
}

// ---------------------------------------------------------------- diff

// What changed between two versions of a card set. Cards and responsibilities
// are matched by id, so a renamed class keeps its id and shows as a name change.
function diffCards(before, after) {
  const A = new Map(normalizeCards(before).map((c) => [c.id, c]));
  const B = new Map(normalizeCards(after).map((c) => [c.id, c]));
  const setDiff = (x, y) => ({ added: y.filter((v) => !x.includes(v)), removed: x.filter((v) => !y.includes(v)) });
  const out = { cardsAdded: [], cardsRemoved: [], cardsChanged: [], edgesAdded: [], edgesRemoved: [] };
  for (const id of B.keys()) if (!A.has(id)) out.cardsAdded.push(id);
  for (const id of A.keys()) if (!B.has(id)) out.cardsRemoved.push(id);
  for (const [id, b] of B) {
    const a = A.get(id);
    if (!a) continue;
    const fields = {};
    for (const f of ['name', 'kind', 'subsystem', 'purpose', 'superclass']) if (a[f] !== b[f]) fields[f] = [a[f], b[f]];
    const subs = setDiff(a.subclasses, b.subclasses);
    if (subs.added.length || subs.removed.length) fields.subclasses = subs;
    if (JSON.stringify(a.contracts || []) !== JSON.stringify(b.contracts || [])) fields.contracts = [a.contracts || [], b.contracts || []];
    const ra = new Map(a.responsibilities.map((r) => [r.id, r]));
    const rb = new Map(b.responsibilities.map((r) => [r.id, r]));
    const respAdded = [...rb.values()].filter((r) => !ra.has(r.id));
    const respRemoved = [...ra.values()].filter((r) => !rb.has(r.id));
    const respChanged = [];
    for (const [rid, r2] of rb) {
      const r1 = ra.get(rid);
      if (!r1) continue;
      const ch = {};
      if (r1.text !== r2.text) ch.text = [r1.text, r2.text];
      if (r1.type !== r2.type) ch.type = [r1.type, r2.type];
      const rq = setDiff(r1.reqs, r2.reqs);
      if (rq.added.length || rq.removed.length) ch.reqs = rq;
      const co = setDiff(r1.collaborators, r2.collaborators);
      if (co.added.length || co.removed.length) ch.collaborators = co;
      if (JSON.stringify(r1.contractRefs || {}) !== JSON.stringify(r2.contractRefs || {})) ch.contractRefs = [r1.contractRefs || {}, r2.contractRefs || {}];
      if (Object.keys(ch).length) respChanged.push({ id: rid, ...ch });
    }
    if (Object.keys(fields).length || respAdded.length || respRemoved.length || respChanged.length) {
      out.cardsChanged.push({ id, fields, respAdded, respRemoved, respChanged });
    }
  }
  const key = (e) => `${e.from}->${e.to}`;
  const ea = new Set(collaborationEdges([...A.values()]).map(key));
  const eb = new Set(collaborationEdges([...B.values()]).map(key));
  out.edgesAdded = [...eb].filter((e) => !ea.has(e));
  out.edgesRemoved = [...ea].filter((e) => !eb.has(e));
  out.changed = out.cardsAdded.length + out.cardsRemoved.length + out.cardsChanged.length > 0;
  return out;
}

function formatDiff(d) {
  if (!d.changed) return 'No changes.';
  const L = [];
  const list = (xs) => xs.join(', ');
  if (d.cardsAdded.length) L.push(`+ cards added: ${list(d.cardsAdded)}`);
  if (d.cardsRemoved.length) L.push(`- cards removed: ${list(d.cardsRemoved)}`);
  for (const c of d.cardsChanged) {
    L.push(`~ ${c.id}`);
    for (const [f, v] of Object.entries(c.fields)) {
      if (f === 'subclasses') L.push(`    subclasses ${v.added.length ? `+${list(v.added)} ` : ''}${v.removed.length ? `-${list(v.removed)}` : ''}`.trimEnd());
      else if (f === 'contracts') L.push(`    contracts: ${v[0].map((k) => `${k.number}. ${k.name} [${k.responsibilities.join(' ')}]`).join('; ') || 'none'} → ${v[1].map((k) => `${k.number}. ${k.name} [${k.responsibilities.join(' ')}]`).join('; ') || 'none'}`);
      else L.push(`    ${f}: "${v[0] ?? ''}" → "${v[1] ?? ''}"`);
    }
    for (const r of c.respAdded) L.push(`    + ${r.id} [${r.type}] ${r.text}`);
    for (const r of c.respRemoved) L.push(`    - ${r.id} [${r.type}] ${r.text}`);
    for (const r of c.respChanged) {
      const bits = [];
      if (r.text) bits.push(`text "${r.text[0]}" → "${r.text[1]}"`);
      if (r.type) bits.push(`type ${r.type[0]} → ${r.type[1]}`);
      if (r.reqs) bits.push(`reqs ${r.reqs.added.map((x) => '+' + x).concat(r.reqs.removed.map((x) => '-' + x)).join(' ')}`);
      if (r.collaborators) bits.push(`collaborators ${r.collaborators.added.map((x) => '+' + x).concat(r.collaborators.removed.map((x) => '-' + x)).join(' ')}`);
      if (r.contractRefs) bits.push(`contracts used ${JSON.stringify(r.contractRefs[0])} → ${JSON.stringify(r.contractRefs[1])}`);
      L.push(`    ~ ${r.id}: ${bits.join('; ')}`);
    }
  }
  if (d.edgesAdded.length) L.push(`+ collaborations: ${list(d.edgesAdded)}`);
  if (d.edgesRemoved.length) L.push(`- collaborations: ${list(d.edgesRemoved)}`);
  return L.join('\n');
}

// ---------------------------------------------------------------- comparison

function compareMarkdown(sets, reqIds) {
  const rows = sets.map(({ label, cards }) => ({ label, v: validate(JSON.parse(JSON.stringify(cards)), { reqIds }) }));
  const codes = [...new Set(rows.flatMap((r) => [...Object.keys(r.v.stats.errorsByCode), ...Object.keys(r.v.stats.warningsByCode)]))].sort();
  const head = ['Measure', ...rows.map((r) => r.label)];
  const line = (name, f) => `| ${name} | ${rows.map((r) => f(r.v.stats, r.v)).join(' | ')} |`;
  const out = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  out.push(line('Cards', (s) => s.cards));
  out.push(line('Subsystems', (s) => s.subsystems));
  out.push(line('Responsibilities (K / B)', (s) => `${s.responsibilities} (${s.knowledge} / ${s.behavior})`));
  out.push(line('Mean responsibilities per card', (s) => s.meanResponsibilities));
  out.push(line('Largest card', (s) => `${s.largestCard.id} (${s.largestCard.n})`));
  out.push(line('Mean words per responsibility', (s) => s.meanWords));
  out.push(line('Behaviors joining several actions', (s) => `${s.compoundBehaviors}/${s.behavior}`));
  out.push(line('Collaboration edges', (s) => s.collaborationEdges));
  out.push(line('Responsibilities citing a requirement', (s) => `${s.citedResponsibilities}/${s.responsibilities}`));
  if (reqIds) out.push(line('Requirements covered', (s) => `${s.reqsCovered}/${s.reqsTotal} (${Math.round((100 * s.reqsCovered) / s.reqsTotal)}%)`));
  out.push(line('**Validator errors**', (s, v) => `**${v.errors.length}**`));
  out.push(line('Validator warnings', (s, v) => v.warnings.length));
  for (const c of codes) out.push(line(`&nbsp;&nbsp;\`${c}\``, (s) => s.errorsByCode[c] || s.warningsByCode[c] || 0));
  return out.join('\n') + '\n';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CRC_KINDS, parseRequirements, expandReqRefs, compressReqs, reqSort,
    collaborationEdges, cardCollaborators, subsystemsOf,
    validate, formatReport,
    cardsToMarkdown, traceabilityMarkdown, scenariosMarkdown, collaborationMermaid, inheritanceMermaid, walkthroughMermaid,
    collaborationDot, collaborationDrawio, collaborationSvg, collaborationLayout, contractsMarkdown, resolveContracts, contractLabels,
    importLineCards, importTableCards, parseMarkdownCards, normalizeCards, resolveNames, toIdentifier,
    setRequirementSyntax, DEFAULT_REQ_SYNTAX, DEFAULT_ATOMIC, wordCount, isCompound, behaviorVerbs,
    compareMarkdown, diffCards, formatDiff,
    cardsToCompact, responsibilitiesCiting, walkthroughDependencies, walkthroughAffected,
  };
}
