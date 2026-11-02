# Gloop

A little local app for making CRC cards that actually checks your work.

You fill out cards in a browser form (or pull them in from a file you already have), it shows each one laid out like a real index card, and with one click it tells you what's broken (missing collaborators, uncovered requirements, overstuffed cards, contract mixups) and draws the collaboration graph in the course notation. Everything saves to a plain JSON file, so there's also a CLI if you'd rather script it or hand-edit.

## What you need

Just **Node 20+**. No dependencies, nothing to `npm install`.

## Fire up the UI

```sh
git clone https://github.com/CoolHackerMan27/Gloop.git
cd Gloop
npm link          # puts `crc` on your PATH; undo with `npm unlink -g crc-cards`
```

Then, from wherever you keep your cards:

```sh
crc ui cards.json
```

That opens http://127.0.0.1:8615/ in your browser. If `cards.json` doesn't exist yet, it gets created the first time you save (or import) a card.

You can leave the path off. Then it uses the `cards` file from the nearest `crc.config.json`, or `./cards.json` if there isn't one. Other flags: `--port n` picks a different port (if 8615 is taken it grabs a free one anyway) and `--no-open` skips opening the browser.

The UI edits a JSON file, but you can bring in Markdown or plain-text cards with the Import button (more on that below).

## A tour of the UI

### The sidebar

All your class cards, grouped by subsystem, with a filter box at the top. Actors, interfaces and external systems are tagged so you can spot them. Once you've run Check, any card with problems gets a red dot (errors) or yellow dot (warnings).

Below that are the subsystem cards. Subsystems your cards mention but haven't documented yet show up greyed out with a "no card" tag, so you can see what's left to write up.

### Viewing a card

Click a card and it's laid out like the index card you'd draw on paper:

- **Responsibilities on the left.** Each one has its id (R1, R2, ...), a K/B badge for "knows" vs. "does", and its requirements and contract underneath.
- **Collaborators on the right.** Click one to jump straight to that card. If a collaborator points at a card that doesn't exist, it shows up with a `?`.
- Superclass, subclasses, contracts, and the purpose (the back of the card).
- **Used by**, which lists every card that has this one as a collaborator. Handy for seeing who depends on a class before you go changing it.

### Making and editing cards

Hit **+ New** or **Edit** and you get a form instead of raw JSON:

- Type a name and the id fills itself in (`Key Store` → `KeyStore`). Change the id by hand and it stops auto-filling.
- Subsystem autocompletes from the ones you've already used. Superclass is a dropdown and subclasses are chips.
- Each responsibility gets a K/B picker, a text box, a requirements box (comma-separated, ranges like `TS-01–TS-05` work), and a collaborator picker. Reorder them with the arrows and the ids stay the same, so your walkthroughs don't break.
- If a collaborator offers more than one contract, a little dropdown on its chip asks which contract you're using.
- **Contracts** get a number (it auto-picks the next free one across the whole system), a name, and checkboxes for which responsibilities belong to it. A responsibility can only be in one contract, so checking it in one unchecks it everywhere else.
- `⌘S` / `Ctrl+S` saves. If you try to click away with unsaved changes, it asks first.

When you save, it catches the obvious mistakes before writing anything: a missing name, a bad or duplicate id, or a contract number that another card already uses.

### Importing cards

Hit **Import** (or just drag a file onto the window) to pull in cards from a `.json` file, a Markdown `.md` file, or the plain hand-written `.txt` format. It works like copying files into a folder:

- Cards you don't have yet get added.
- Cards that are exactly the same as yours are left alone.
- For each card whose id you already have but whose contents differ, it stops and asks, showing you exactly what each option would change:
  - **Merge** keeps both: anything the imported card has that yours doesn't gets added (new responsibilities, requirements, collaborators, contracts), and blank fields get filled in. It's greyed out when the two versions actually disagree, like two different purposes or the same responsibility reworded, the same way git won't auto-merge two edits to the same line. The dialog lists what's in the way.
  - **Overwrite** replaces your card with the imported one.
  - **Skip** keeps yours and ignores the imported one.
- Tick **Do this for the remaining conflicts** to stop being asked. If you picked Merge, it'll still stop on any card that can't be merged automatically.
- **Cancel import** (or `Esc`) bails out and nothing changes. Nothing gets saved until you've answered every conflict.

Subsystem cards in an imported JSON file get the same treatment. Once the import's saved, it runs Check for you, since imports are a classic way to end up with collaborators pointing at cards that don't exist.

### Subsystem cards

These are the subsystem cards from the lecture. Each one has a name, a description, a reference to its graph, and the contracts it offers to classes outside it, each one handed off to a "server" class inside. Its class list fills itself in from whichever cards have that subsystem.

The nice part is **Fill in from class contracts**. It looks at which class contracts are actually used from outside the subsystem and adds them for you. It also tells you which classes get called from outside but haven't declared any contracts yet. It warns you if a server class isn't in the subsystem or doesn't have that contract number.

### Check

The **Check** button runs the full `crc check` against your saved file and opens a panel listing every error and warning. Click an issue to jump to the card it's about. Once the panel is open, it re-checks automatically every time you save, so you can just keep fixing things and watch the list shrink.

### Graph

The **Graph** button draws the collaboration graph in the course notation: boxes for classes, numbered semicircles for contracts, and arrows from each client to the contract it uses. Pick the whole system or one subsystem from the dropdown. Per-subsystem graphs are way easier to read once your design gets big. You can also get there from a subsystem card's "show it" link.

### It's careful with your file

- Every save goes straight to the JSON file, and it's written atomically, so a crash halfway through won't leave you with a half-written file.
- It only touches `cards` and `subsystems`. Anything else in the file (walkthroughs, etc.) is left alone. It also adds a `$schema` line so VS Code gives you autocomplete if you open the file by hand.
- If the file changed on disk since the page loaded (say you edited it in VS Code), it asks before overwriting.
- Rename a card's id and every reference to it gets updated: collaborators, inheritance, contract refs, subsystem contract servers. Rename a subsystem and its cards follow along.
- Set a superclass or subclass and the other card gets updated to match.
- Delete a card and it tells you who was using it, then cleans up those references.

---

## The CLI

The UI is built on the same code as `crc`, and the CLI can do a bunch more: Markdown cards, requirement traceability, scenario walkthroughs, diffs, draw.io export, and so on. If you ran `npm link` above, it's already on your PATH. Otherwise run `node path/to/Gloop/bin/crc.js <command>`.

### Quick start

```sh
crc init my-cards      # config, example cards, requirements, one scenario
cd my-cards
crc check              # validate (exit 1 on errors)
crc check --watch      # re-check on every save
crc view --watch       # live graph in the browser
crc build              # everything into out/
```

### Commands

| Command                                                                                            | What it does                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crc ui [cards.json] [--port n] [--no-open]`                                                       | The card editor in your browser (everything in the tour above).                                                                                                                                                            |
| `crc init [dir]`                                                                                   | Start a project. Also sets up VS Code autocomplete for `cards*.json`.                                                                                                                                                      |
| `crc check [cards] [--watch] [--json]`                                                             | Validate. Exit 1 on errors.                                                                                                                                                                                                |
| `crc build [cards] [--out dir]`                                                                    | `cards.md`, `contracts.md`, `validation.txt`, `traceability.md`, `scenarios.md`, and `graphs/`: `collaboration.svg`, one SVG per subsystem in `graphs/subsystems/`, `collaboration.drawio`, `.mmd`, `.dot`, `viewer.html`. |
| `crc view [cards] [--watch] [--port n] [--no-open]`                                                | Open the interactive graph. `--watch` serves it locally and redraws when cards change.                                                                                                                                     |
| `crc convert <in> <out> [--from lines]`                                                            | Markdown ↔ JSON. `--from lines` reads the plain hand-written format (name, purpose, `Responsibilities:` list, `Collaborators:` list).                                                                                      |
| `crc diff <before> <after>`                                                                        | Cards, responsibilities and collaborations added, removed or changed.                                                                                                                                                      |
| `crc graph [cards] --format svg\|drawio\|mermaid\|inherit\|dot\|html [--subsystem name] [-o file]` | One graph. `svg` (the default) and `drawio` use the course notation; `--subsystem` draws one subsystem with the classes it talks to as dashed boxes.                                                                       |
| `crc render`, `crc trace`, `crc sequence`                                                          | Card Markdown, the requirement → responsibility table, scenario sequence diagrams.                                                                                                                                         |
| `crc compare a=cards.json b=cards.json`                                                            | Side-by-side validation of several card sets.                                                                                                                                                                              |

`cards` can be a `.md` file, a `.json` file, or a folder of them (one file per card is totally fine).

---

## Reference

The nitty-gritty. You don't need any of this to use the UI, but it's here when you want it.

### Card format (Markdown)

If you'd rather write cards by hand, here's what one looks like:

```markdown
## Lending

### Loan

> **Purpose (card back):** The purpose of this class is to represent one book lent to one member.

**Superclass:** none · **Subclasses:** none

**Contracts:**

- **1. Lend a book** — Creates a loan and records when it is due.

| #   | Responsibilities                                         | Contract | Reqs           | Collaborators |
| --- | -------------------------------------------------------- | -------- | -------------- | ------------- |
| R1  | [B] Creates a loan unless the member has an overdue book | 1        | LND-01, LND-03 | `Member` (2)  |
| R2  | [K] Knows its due date                                   | 1        | LND-02         | —             |
| R3  | [K] Knows the copy it lends                              | private  | LND-01         | —             |
```

- `##` starts a subsystem (optional). Each `###` is one card. Tack `_(actor)_`, `_(interface)_` or `_(external)_` onto the name for non-class cards.
- `[K]` = knows, `[B]` = does. Leave the tag off and anything starting with "Knows …" counts as K, everything else as B.
- The `#` column is optional, but it keeps responsibility ids stable when you reorder rows, which matters because walkthroughs refer to them. Without it, rows are just numbered R1, R2, …
- Columns are found by header name (`Responsibilities`, `Reqs`, `Collaborators`), so order doesn't matter and `Reqs` can be skipped.
- Collaborators can be written by name or id, with or without backticks: `Key Store`, `KeyStore` and `` `KeyStore` `` all resolve to the same card. A name that matches nothing is an error.
- The card id is the name in PascalCase (`Model Interface` → `ModelInterface`). Put `{#Id}` after the heading if you want a different one.
- Requirement ranges work: `TS-01–TS-05`, `ACC-24–29`.
- **Contracts** are optional (they're the course's CRC extension). `**Contracts:**` lists the numbered services the class offers, and the `Contract` column puts each responsibility in one of them or marks it `private`. A responsibility can be in at most one contract, and numbers are unique across the whole system. A collaborator written as `` `Member` (2) `` uses Member's contract 2; you can leave the number off when that class only offers one contract. Cards without a `Contract` column work exactly like before.

JSON uses the same fields; see `schema/crc.schema.json`. Running `crc convert cards.md cards.json` is the easiest way to see how they map.

### Collaboration graph

`crc build`, `crc graph` and the UI's Graph button draw the collaboration graph the way the course slides do (Wirfs-Brock): each class is a box, each contract is a numbered semicircle on the edge of the class that offers it, and an arrow runs from each client to the contract it uses, so two clients of the same contract point at the same semicircle. Actors, interfaces and external systems get a «stereotype». It's plain black and white.

- If a class that others use doesn't declare any contracts, it gets drawn with one contract covering everything it does, numbered after the declared ones, and the caption and `contracts.md` say so. Declaring contracts lets you group responsibilities the way the slides suggest (one contract per set of responsibilities used by the same clients).
- Layout runs left to right, clients before the classes they use, with crossings kept down and each semicircle on the side of its box that faces its clients. A whole-system graph of a big design gets dense; the per-subsystem graphs in `graphs/subsystems/` are the readable ones.
- `collaboration.drawio` is the same picture but editable. Each class is grouped with its semicircles, so dragging a class keeps its contracts attached.

### Subsystem cards (JSON)

Subsystem cards live in the same file as the class cards. A subsystem's classes are just the cards whose `subsystem` matches its name, so they aren't repeated here:

```json
{ "cards": [ ... ], "subsystems": [
  { "name": "Lending", "description": "Lends books to members.", "graph": "graphs/subsystems/lending.svg",
    "contracts": [ { "number": 1, "name": "Lend a book", "server": "Loan" } ] }
] }
```

Each contract is one the subsystem offers to classes outside it, and `server` names the class inside that handles it. The UI is the main way to make these. The CLI accepts the field but doesn't check or render it yet.

### Scenario walkthroughs

`walkthroughs.json` role-plays a scenario through your cards:

```json
{
  "walkthroughs": [
    {
      "scenarioId": "S1",
      "title": "Member borrows a book",
      "steps": [
        { "from": "@Member", "to": "Member", "responsibilityId": "R1" },
        { "from": "Member", "to": "Loan", "responsibilityId": "R1" },
        {
          "break": true,
          "missing": "Knows the member's fine balance",
          "reason": "fines block borrowing"
        }
      ]
    }
  ]
}
```

Each step has to name a responsibility that's on the `to` card, and `from` has to list `to` as a collaborator. A `from` starting with `@` is an outside trigger. A `break` marks a spot where you needed a responsibility no card has.

### Config: `crc.config.json`

`crc` looks for this in the current folder or the nearest parent. Paths are relative to the config file.

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

- **`requirements`**: lines like `INT-01: The system shall …` (or `- INT-01: …` or `INT-01. …`). A heading like `## Integrity [INT]` names a section. Leave it out to skip coverage checks entirely.
- **`requirementIds`**: what your IDs look like, e.g. `{ "prefix": "REQ", "pad": 3 }` for `REQ-007`, or `{ "prefix": "FR", "separator": "", "pad": 1 }` for `FR3`.
- **`requireCitations`**: whether every responsibility has to cite a requirement. `null` means "yes, if there's a requirements file".
- **`atomicResponsibilities`**: one responsibility = one verb phrase (the lecture's "verb phrases lead to responsibilities"). Set it to `true` or `{ "maxWords": 10, "maxReqs": 3 }` to turn on three checks: lines longer than `maxWords`, behaviors citing more than `maxReqs` requirements, and "and"/"or"/";"/"then" gluing two actions together. It's off by default. Its whole point is to stop you from dodging `maxResponsibilities` by cramming several actions into one line. `crc compare` always shows mean words per responsibility and how many behaviors join actions, whether this is on or not.
- **`rules`**: per issue code, set `"off"`, `"warn"` or `"error"`.

### What gets checked

| Code                                                   | Default | Catches                                                                                  |
| ------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------- |
| `dangling-collaborator`                                | error   | A collaborator that has no card.                                                         |
| `dangling-superclass`, `dangling-subclass`             | error   | Inheritance naming a missing card.                                                       |
| `inheritance-mismatch`, `inheritance-cycle`            | error   | Superclass and subclass lists that disagree, or loops.                                   |
| `dup-card`, `dup-resp`, `bad-id`, `schema`             | error   | Duplicate or malformed ids, missing fields, a type that isn't K/B.                       |
| `uncovered-req`                                        | error   | A requirement no responsibility cites.                                                   |
| `unknown-req`                                          | error   | A citation of a requirement that doesn't exist.                                          |
| `missing-citation`                                     | error   | A responsibility that cites nothing (see `requireCitations`).                            |
| `card-too-large`                                       | error   | More responsibilities than fit on an index card (`maxResponsibilities`).                 |
| `empty-card`                                           | error   | A class with no responsibilities (a warning for actors and external systems).            |
| `wt-unknown-card`, `wt-unknown-resp`                   | error   | A walkthrough step naming a card or responsibility that doesn't exist.                   |
| `wt-no-collaboration`                                  | error   | A step from A to B where A doesn't list B as a collaborator.                             |
| `wt-break`                                             | error   | A scenario that can't complete.                                                          |
| `resp-too-long`                                        | error   | A responsibility over `maxWords` words (only with `atomicResponsibilities`).             |
| `resp-too-many-reqs`                                   | error   | A behavior citing more than `maxReqs` requirements (only with `atomicResponsibilities`). |
| `resp-compound`                                        | warning | A behavior joining two actions with and/or/;/then (only with `atomicResponsibilities`).  |
| `god-object`                                           | warning | A card much bigger or more connected than the rest.                                      |
| `knowledge-only`                                       | warning | A class that only knows things and does nothing (maybe an attribute).                    |
| `orphan`                                               | warning | A card that neither uses nor is used by anything.                                        |
| `duplicate-responsibility`                             | warning | The same responsibility on two cards.                                                    |
| `kb-mismatch`                                          | warning | `[K]` text that doesn't read as knowledge, or the reverse.                               |
| `self-collaborator`                                    | warning | A card listing itself as a collaborator.                                                 |
| `missing-purpose`, `missing-subsystem`, `missing-name` | warning | Empty card back, no subsystem, no name.                                                  |
| `edge-unexercised`, `wt-midstream-trigger`             | warning | A collaboration no scenario uses; an outside trigger in the middle of a scenario.        |
| `contract-dup-number`                                  | error   | Two contracts with the same number (numbers are system-wide).                            |
| `contract-unknown-resp`                                | error   | A contract listing a responsibility that isn't on the card.                              |
| `contract-shared-resp`                                 | error   | A responsibility in two contracts (it may be in at most one).                            |
| `contract-ref-unknown`                                 | error   | `Server (n)` where Server offers no contract n (inherited contracts count).              |
| `contract-ref-not-collaborator`                        | error   | A contract reference to a class that isn't one of the responsibility's collaborators.    |
| `contract-unspecified`                                 | warning | Using a class that offers several contracts without saying which.                        |
| `contract-unused`, `contract-empty`                    | warning | A declared contract no class uses, or one with no responsibilities.                      |

### What's where

- `ui/index.html`: the card editor page. The whole front end lives in this one file.
- `src/ui.js`: the little local server behind `crc ui`. It reads and saves the cards file and answers Check, Graph and Import by calling `lib.js` directly.
- `src/lib.js`: all the checks, renderers and the import merge as pure functions (no filesystem). It's one file on purpose so it can be embedded elsewhere; the course's agent pipeline inlines it.
- `src/io.js`: config and file loading.
- `src/viewer.js`: the interactive graph page.
- `bin/crc.js`: the CLI.
- `test/`: run with `npm test`.
