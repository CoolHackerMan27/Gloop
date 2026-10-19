# crc — CRC cards as data

Write CRC cards in Markdown or JSON. `crc` checks them (dangling collaborators, inheritance, contracts, requirement coverage, card size, scenario walkthroughs) and draws the collaboration graph for you in the course notation (boxes, numbered contract semicircles, client → contract arrows) as black-and-white SVG or editable draw.io, plus Mermaid, Graphviz and an interactive page that redraws as you edit.

No dependencies. Node 20 or newer.

## Install

```sh
cd crc-tool
npm link          # puts `crc` on your PATH; undo with `npm unlink -g crc-cards`
```

Or run it directly: `node path/to/crc-tool/bin/crc.js <command>`.

## Quick start

```sh
crc init my-cards      # config, example cards, requirements, one scenario
cd my-cards
crc check              # validate (exit 1 on errors)
crc check --watch      # re-check on every save
crc view --watch       # live graph in the browser
crc build              # everything into out/
```

## UI

```sh
python3 path/to/crc-tool/ui/app.py cards.json   # opens http://127.0.0.1:8615/ in your browser
```

A form-based editor for people who'd rather not hand-write JSON. Make, edit and delete class cards (name, kind, subsystem, superclass/subclasses, purpose, responsibilities with K/B, requirements and collaborators, contracts) and subsystem cards, and see each one laid out as a CRC card. **Check** runs `crc check` and marks the cards it complains about; **Graph** shows the collaboration graph, whole or per subsystem.

- Python standard library only (3.8+, no Tkinter needed). Check and Graph call `bin/crc.js`, so they need Node.
- Every save writes the JSON file straight away, keeping anything else in it (walkthroughs). If the file changed on disk since it was loaded, it asks before overwriting.
- Renaming a card's id updates every reference to it. Setting a superclass or subclasses updates the other side. Deleting a card removes references to it.
- Without a path it opens the JSON `cards` file from the nearest `crc.config.json`, or `./cards.json`. It edits JSON only: `crc convert cards.md cards.json` first if your cards are Markdown.
- `--port n`, `--no-open`.

## Commands

| Command | What it does |
|---|---|
| `crc init [dir]` | Start a project. Also sets up VS Code autocomplete for `cards*.json`. |
| `crc check [cards] [--watch] [--json]` | Validate. Exit 1 on errors. |
| `crc build [cards] [--out dir]` | `cards.md`, `contracts.md`, `validation.txt`, `traceability.md`, `scenarios.md`, and `graphs/`: `collaboration.svg`, one SVG per subsystem in `graphs/subsystems/`, `collaboration.drawio`, `.mmd`, `.dot`, `viewer.html`. |
| `crc view [cards] [--watch] [--port n] [--no-open]` | Open the interactive graph. `--watch` serves it locally and redraws when cards change. |
| `crc convert <in> <out> [--from lines]` | Markdown ↔ JSON. `--from lines` reads the plain hand-written format (name, purpose, `Responsibilities:` list, `Collaborators:` list). |
| `crc diff <before> <after>` | Cards, responsibilities and collaborations added, removed or changed. |
| `crc graph [cards] --format svg\|drawio\|mermaid\|inherit\|dot\|html [--subsystem name] [-o file]` | One graph. `svg` (the default) and `drawio` use the course notation; `--subsystem` draws one subsystem with the classes it talks to as dashed boxes. |
| `crc render`, `crc trace`, `crc sequence` | Card Markdown, the requirement → responsibility table, scenario sequence diagrams. |
| `crc compare a=cards.json b=cards.json` | Side-by-side validation of several card sets. |

`cards` can be a `.md` file, a `.json` file, or a folder of them (one file per card is fine).

## Card format (Markdown)

```markdown
## Lending

### Loan

> **Purpose (card back):** The purpose of this class is to represent one book lent to one member.

**Superclass:** none · **Subclasses:** none

**Contracts:**

- **1. Lend a book** — Creates a loan and records when it is due.

| # | Responsibilities | Contract | Reqs | Collaborators |
|---|---|---|---|---|
| R1 | [B] Creates a loan unless the member has an overdue book | 1 | LND-01, LND-03 | `Member` (2) |
| R2 | [K] Knows its due date | 1 | LND-02 | — |
| R3 | [K] Knows the copy it lends | private | LND-01 | — |
```

- `##` starts a subsystem (optional). Each `###` is one card; add `_(actor)_`, `_(interface)_` or `_(external)_` after the name for non-class cards.
- `[K]` = knows, `[B]` = does. Without a tag, "Knows …" is read as K and anything else as B.
- The `#` column is optional. It keeps responsibility ids stable when you reorder rows, which matters because scenario walkthroughs refer to them. Without it, rows are numbered R1, R2, …
- Columns are found by their header names (`Responsibilities`, `Reqs`, `Collaborators`), so order doesn't matter and `Reqs` can be left out.
- Collaborators can be written by name or id, with or without backticks: `Key Store`, `KeyStore` and `` `KeyStore` `` all resolve to the same card. A name that matches no card is reported as an error.
- The card id is the name in PascalCase (`Model Interface` → `ModelInterface`). Add `{#Id}` after the heading to choose a different one.
- Requirement ranges work: `TS-01–TS-05`, `ACC-24–29`.
- **Contracts** (optional, the course's CRC extension): `**Contracts:**` lists the numbered services the class offers, and the `Contract` column puts each responsibility in one of them or marks it `private`. A responsibility can be in at most one contract, and numbers are unique across the whole system. A collaborator written as `` `Member` (2) `` uses contract 2 of Member; the number can be left off when that class offers only one contract. Cards without the `Contract` column look exactly as before.

## Collaboration graph

`crc build` and `crc graph` draw the collaboration graph the way the course slides do (Wirfs-Brock): each class is a box, each contract a numbered semicircle on the edge of the class that offers it, and an arrow runs from each client to the contract it uses, so two clients of one contract point at the same semicircle. Actors, interfaces and external systems carry a «stereotype». It's plain black and white.

- If a class that others use declares no contracts, it is drawn with one contract covering everything it does, numbered after the declared ones; the graph's caption and `contracts.md` say so. Declare contracts to group responsibilities the way the slides' guidelines describe (one contract per set of responsibilities used by the same clients).
- Layout runs left to right, clients before the classes they use, with crossings reduced and each semicircle on the side of its box that faces its clients. A whole-system graph of a large design is dense; the per-subsystem graphs in `graphs/subsystems/` are the readable ones.
- `collaboration.drawio` is the same picture, editable: each class is a group of its box and its semicircles, so dragging a class keeps its contracts attached.

JSON uses the same fields; see `schema/crc.schema.json`. `crc convert cards.md cards.json` shows the mapping.

## Subsystem cards (JSON)

A cards file can also hold subsystem cards, as the course's subsystem lecture describes them. A subsystem's classes are the cards whose `subsystem` is its name, so they aren't repeated here:

```json
{ "cards": [ ... ], "subsystems": [
  { "name": "Lending", "description": "Lends books to members.", "graph": "graphs/subsystems/lending.svg",
    "contracts": [ { "number": 1, "name": "Lend a book", "server": "Loan" } ] }
] }
```

Each contract is one the subsystem offers to classes outside it, with `server` naming the class inside that serves it. The UI makes these and can fill them in from the class contracts used across the boundary. The CLI accepts the field but doesn't check or render it yet.

## Scenario walkthroughs

`walkthroughs.json` role-plays a scenario through the cards:

```json
{ "walkthroughs": [{ "scenarioId": "S1", "title": "Member borrows a book", "steps": [
  { "from": "@Member", "to": "Member", "responsibilityId": "R1" },
  { "from": "Member",  "to": "Loan",   "responsibilityId": "R1" },
  { "break": true, "missing": "Knows the member's fine balance", "reason": "fines block borrowing" }
]}]}
```

Each step must name a responsibility that is on the `to` card, and `from` must list `to` as a collaborator. A `from` starting with `@` is an outside trigger. A `break` records a responsibility that no card has.

## Config: `crc.config.json`

Found in the current folder or the nearest parent. Paths are relative to the config file.

```json
{
  "title": "My system",
  "cards": "cards.md",
  "requirements": "requirements.txt",
  "walkthroughs": "walkthroughs.json",
  "out": "out",
  "requirementIds": { "prefix": "[A-Za-z]{2,5}", "separator": "-", "pad": 2 },
  "maxResponsibilities": 12,
  "requireCitations": null,
  "godObject": { "minResponsibilities": 9, "fanOut": 8 },
  "duplicateSimilarity": 0.8,
  "atomicResponsibilities": { "maxWords": 10, "maxReqs": 3 },
  "rules": { "knowledge-only": "off", "orphan": "error" }
}
```

- **`requirements`**: lines like `INT-01: The system shall …` (also `- INT-01: …` or `INT-01. …`). A heading `## Integrity [INT]` names a section. Leave this out to skip coverage checks entirely.
- **`requirementIds`**: the ID shape, e.g. `{ "prefix": "REQ", "pad": 3 }` for `REQ-007`, or `{ "prefix": "FR", "separator": "", "pad": 1 }` for `FR3`.
- **`requireCitations`**: whether every responsibility must cite a requirement. `null` means "yes when a requirements file is configured".
- **`atomicResponsibilities`**: one responsibility = one verb phrase (the lecture's "verb phrases lead to responsibilities"). `true` or `{ "maxWords": 10, "maxReqs": 3 }` turns on three checks: a line longer than `maxWords`, a behavior citing more than `maxReqs` requirements, and "and"/"or"/";"/"then" joining two actions. Off by default. It stops a card from staying under `maxResponsibilities` by cramming several actions into each line. `crc compare` always shows mean words per responsibility and how many behaviors join actions, whether this is on or not.
- **`rules`**: per issue code, set `"off"`, `"warn"` or `"error"`.

## What gets checked

| Code | Default | Catches |
|---|---|---|
| `dangling-collaborator` | error | A collaborator that has no card. |
| `dangling-superclass`, `dangling-subclass` | error | Inheritance naming a missing card. |
| `inheritance-mismatch`, `inheritance-cycle` | error | Superclass and subclass lists that disagree, or loops. |
| `dup-card`, `dup-resp`, `bad-id`, `schema` | error | Duplicate or malformed ids, missing fields, a type that isn't K/B. |
| `uncovered-req` | error | A requirement no responsibility cites. |
| `unknown-req` | error | A citation of a requirement that doesn't exist. |
| `missing-citation` | error | A responsibility that cites nothing (see `requireCitations`). |
| `card-too-large` | error | More responsibilities than fit on an index card (`maxResponsibilities`). |
| `empty-card` | error | A class with no responsibilities (a warning for actors and external systems). |
| `wt-unknown-card`, `wt-unknown-resp` | error | A walkthrough step naming a card or responsibility that doesn't exist. |
| `wt-no-collaboration` | error | A step from A to B where A doesn't list B as a collaborator. |
| `wt-break` | error | A scenario that can't complete. |
| `resp-too-long` | error | A responsibility over `maxWords` words (only with `atomicResponsibilities`). |
| `resp-too-many-reqs` | error | A behavior citing more than `maxReqs` requirements (only with `atomicResponsibilities`). |
| `resp-compound` | warning | A behavior joining two actions with and/or/;/then (only with `atomicResponsibilities`). |
| `god-object` | warning | A card much bigger or more connected than the rest. |
| `knowledge-only` | warning | A class that only knows things and does nothing (maybe an attribute). |
| `orphan` | warning | A card that neither uses nor is used by anything. |
| `duplicate-responsibility` | warning | The same responsibility on two cards. |
| `kb-mismatch` | warning | `[K]` text that doesn't read as knowledge, or the reverse. |
| `self-collaborator` | warning | A card listing itself as a collaborator. |
| `missing-purpose`, `missing-subsystem`, `missing-name` | warning | Empty card back, no subsystem, no name. |
| `edge-unexercised`, `wt-midstream-trigger` | warning | A collaboration no scenario uses; an outside trigger in the middle of a scenario. |
| `contract-dup-number` | error | Two contracts with the same number (numbers are system-wide). |
| `contract-unknown-resp` | error | A contract listing a responsibility that isn't on the card. |
| `contract-shared-resp` | error | A responsibility in two contracts (it may be in at most one). |
| `contract-ref-unknown` | error | `Server (n)` where Server offers no contract n (inherited contracts count). |
| `contract-ref-not-collaborator` | error | A contract reference to a class that isn't one of the responsibility's collaborators. |
| `contract-unspecified` | warning | Using a class that offers several contracts without saying which. |
| `contract-unused`, `contract-empty` | warning | A declared contract no class uses, or one with no responsibilities. |

## Layout

- `src/lib.js`: all checks and renderers as pure functions (no filesystem). It's one file so it can be embedded elsewhere; the course's agent pipeline inlines it.
- `src/io.js`: config and file loading.
- `src/viewer.js`: the interactive page.
- `bin/crc.js`: the CLI.
- `ui/`: the card editor (`app.py` serves `index.html`).
- `test/`: `npm test`.
