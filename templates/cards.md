# Library (example)

Each `###` heading is one card. Edit freely, then run `crc check`.
Collaborators can be written by name or id; `[K]` = knows, `[B]` = does.
`**Contracts:**` lists the numbered services a class offers; the Contract column puts each
responsibility in one (or `private`), and `Loan (1)` means "uses contract 1 of Loan".

## Lending

### Member _(actor)_

> **Purpose (card back):** The purpose of this class is to represent a person who borrows books.

**Superclass:** none · **Subclasses:** none

**Contracts:**

- **2. Report standing** — Tells a loan whether the member may borrow.

| # | Responsibilities | Contract | Reqs | Collaborators |
|---|---|---|---|---|
| R1 | [B] Asks to borrow an available book | private | LND-01 | `Loan` (1) |
| R2 | [K] Knows whether they have an overdue book | 2 | LND-03 | — |

### Loan

> **Purpose (card back):** The purpose of this class is to represent one book lent to one member until it is returned.

**Superclass:** none · **Subclasses:** none

**Contracts:**

- **1. Lend a book** — Creates a loan and records when it is due.

| # | Responsibilities | Contract | Reqs | Collaborators |
|---|---|---|---|---|
| R1 | [B] Creates a loan for an available book unless the member has an overdue book | 1 | LND-01, LND-03 | `Member` (2) |
| R2 | [K] Knows its due date | 1 | LND-02 | — |
