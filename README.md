# Dynamic Test Generator

A production-ready web application that builds tests **dynamically from an existing
QID-based question bank**. Users describe what they need — question types, subjects,
areas, sub-areas, difficulty mixes, tags, section structure — and the system finds
the eligible QIDs and assembles the test.

Questions are classified against a four-level taxonomy:

```
Subject  →  Area / Topic  →  Sub-Area / Sub-Topic (optional)  →  Tags (optional)
```

A QID may be mapped to **one or more** branches of that tree. The shipped taxonomy
holds **35 subjects, 293 areas, 18 sub-areas and 2,294 tags**.

The application never authors questions **for** you — nothing is invented, and no
question text is generated. It does let you author, import, review and retire the
questions the bank holds, and it measures how those questions behave once real
candidates have answered them.

---

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [The taxonomy](#the-taxonomy)
- [Feature map](#feature-map)
- [Beyond the specification](#beyond-the-specification)
- [Architecture](#architecture)
- [Data model](#data-model)
- [The filter engine](#the-filter-engine)
- [Selection at scale](#selection-at-scale)
- [Reproducibility](#reproducibility)
- [Roles and permissions](#roles-and-permissions)
- [API reference](#api-reference)
- [Configuration](#configuration)
- [Testing](#testing)
- [Deployment](#deployment)

---

## Quick start

```bash
npm install
cp .env.example .env          # then set JWT_SECRET to a long random value
npm run migrate               # schema, taxonomy and the bootstrap admin
npm run seed                  # load a 5,000-question demo bank
npm run build                 # build the web client
npm start                     # http://localhost:4000
```

For development with hot reload:

```bash
npm run dev                   # API on :4000, Vite dev server on :5173
```

### Demo accounts

Created by `npm run seed`. **Change these before exposing the app to anyone.**

| Role | Email | Password | Can |
|---|---|---|---|
| Admin | `admin@example.com` | `Admin@12345` | Everything, including user management |
| Test Creator | `creator@example.com` | `Creator@12345` | Create and manage their own tests |
| Viewer | `viewer@example.com` | `Viewer@12345` | Read-only; never sees answer keys |

### Seeding a larger bank

The seeder is deterministic and scales to the volumes the app is designed for:

```bash
npm run seed -- --count 300000 --seed BIG    # ~300k questions
npm run seed -- --fresh                      # wipe the bank first
npm run reset                                # delete the database entirely
```

---

## The taxonomy

The classification hierarchy is reference data, shipped with the application in
`server/db/taxonomy/taxonomy.json` and loaded by every migration. The workbook it
was generated from is kept alongside it for provenance.

```
Subject                     35   e.g. "Operating System", "Data Structures and Algorithms"
└── Area / Topic           293   e.g. "Memory Management", "Graphs"
    └── Sub-Area          18   e.g. "Virtual Memory and Paging"   (only 9 areas have any)
        └── Tags        2,294   e.g. "Page Replacement (FIFO, LRU, Optimal, LFU)"   optional
```

### Regenerating it from a workbook

```bash
npm install --save-dev xlsx        # only needed to re-import; the JSON is committed
npm run taxonomy:import -- server/db/taxonomy/Technical_Questions_Taxonomy.xlsx
npm run migrate                    # load the updated tree
```

The importer expects one row per Area:

| Subject | Area | Sub Areas | Tags |
|---|---|---|---|
| Operating System | Memory Management | Address Spaces and Allocation, Virtual Memory and Paging | Paging, Page Replacement (FIFO, LRU, Optimal, LFU), Thrashing |

Splitting the comma-separated columns is **bracket-aware**. A tag such as
`Page Replacement (FIFO, LRU, Optimal, LFU)` contains commas that belong to the
tag; a naive split shreds 265 tags in the supplied workbook. The importer's
totals are cross-checked against the workbook's own Summary sheet.

Loading is idempotent. Areas that disappear from a new revision of the workbook
are **reported, not deleted**, because questions may still be mapped to them.

### Mapping a QID

A question's classification lives in `question_taxonomy`, one row per branch:

```
QID1087  ─┬─ Operating System  › Memory Management › Virtual Memory and Paging   (primary)
          └─ Generative AI     › Fine-Tuning and Customization
```

Exactly one branch is marked primary; that is what single-value displays (a table
column, an export cell) show. Filtering matches a question if **any** of its
branches satisfies the constraint.

### Why levels must match on the same branch

19 area names are shared between subjects — `Process Management` exists under both
*Operating System* and *Linux*, and `Arrays and Strings` under four subjects. So
`Subject = Operating System AND Area = Process Management` compiles to **one**
lookup with both conditions on the same mapping row:

```sql
q.id IN (SELECT qt.question_id FROM question_taxonomy qt
          WHERE qt.subject_id IN (?) AND qt.area_id IN (?, ?))
```

Compiling one lookup per level instead would let a question mapped to
*Linux › Process Management* **and** some unrelated *Operating System* area satisfy
both halves and match a branch it does not actually have.

---

## How it works

```
 ┌─────────────────┐      ┌──────────────────┐      ┌────────────────────┐
 │  User describes │      │  Filter engine   │      │  Question bank     │
 │  what they need │─────▶│  compiles rules  │─────▶│  (indexed, by QID) │
 │                 │      │  to indexed SQL  │      │                    │
 └─────────────────┘      └──────────────────┘      └────────────────────┘
         │                         │                          │
         │                         ▼                          │
         │                ┌──────────────────┐                │
         │                │  Availability    │◀───────────────┘
         │                │  check (live)    │
         │                └──────────────────┘
         │                         │
         ▼                         ▼
 ┌─────────────────────────────────────────────────┐
 │  Generator: distribution → seeded sampling →    │
 │  cross-section deduplication → validation       │
 └─────────────────────────────────────────────────┘
                         │
                         ▼
          ┌──────────────────────────────┐
          │  Test = sections + QIDs only │
          │  (question content is never  │
          │   copied out of the bank)    │
          └──────────────────────────────┘
```

Three ideas hold the design together:

1. **A test stores QIDs, not questions.** `test_questions` holds a QID and a
   reference; content is resolved from the bank at read time. The bank stays the
   single source of truth, and a question edited in the bank is immediately
   correct in every test that references it.

2. **The filter engine is metadata-driven.** Nothing in the query layer knows
   that "subject" or "difficulty" are special. Fields are declared in a registry
   (`server/core/metadata.js`); the engine, the API and the filter-builder UI all
   read from it. Adding *Company*, *Bloom's Taxonomy* or *Quality Score* as a
   filterable field is a one-line change with no migration.

3. **Nothing is generated silently.** Availability is checked live as filters
   change, before generation, and again at save time. A section that cannot be
   filled produces an explicit shortfall and a list of remedies — never a quietly
   shorter test.

---

## Feature map

Every numbered requirement from the specification, and where it lives.

| § | Requirement | Implementation |
|---|---|---|
| 1–2 | QID-based bank, selection not authoring | `server/core/questions.js`, `db/schema.sql` |
| 3 | Step 1 — test information | `client/src/pages/CreateTest.jsx` |
| 4 | Step 2 — multiple sections | `client/src/components/SectionEditor.jsx` |
| 5 | Advanced selection, cascading Subject→Area→Sub-Area→Tags | `client/src/components/FilterPanel.jsx`, `core/filterEngine.js`, `core/taxonomy.js` |
| 6 | Question distribution (% and exact counts) | `server/core/distribution.js` |
| 7 | Availability check with remedies | `server/core/availability.js` |
| 8 | Automatic / Manual / Hybrid modes | `server/core/generator.js`, `components/ManualPicker.jsx` |
| 9 | Duplicate prevention (default ON) | `generator.js`, `validation.js` |
| 10 | Randomization + reproducible seed | `server/core/rng.js` |
| 11 | Full test preview | `components/PreviewPanel.jsx`, `pages/TestDetail.jsx` |
| 12 | Replace a question | `services/testService.js` → `replacementOptions` |
| 13 | Question Bank dashboard | `client/src/pages/QuestionBank.jsx` |
| 14 | Inventory / availability while building | `components/Availability.jsx` |
| 15 | Smart filter builder (AND/OR/NOT) | `components/RuleBuilder.jsx`, `core/filterEngine.js` |
| 16 | Test templates | `server/routes/templates.js`, `pages/Templates.jsx` |
| 17 | Test versions A/B/C… | `generator.js` → `generateVersions` |
| 18 | Test history | `pages/GeneratedTests.jsx` |
| 19 | PDF / Excel / CSV / JSON export | `server/services/exportService.js` |
| 20 | Database design | `server/db/schema.sql` |
| — | Taxonomy import and QID mapping | `scripts/import-taxonomy.mjs`, `core/taxonomy.js`, `db/backfill.js` |
| 21 | Large-scale performance | indexes, facet counters, window sampling |
| 22 | Validation rules | `server/core/validation.js` |
| 23 | Three-panel UI | `pages/CreateTest.jsx`, `styles/app.css` |
| 24 | Live availability | `components/Availability.jsx` |
| 25 | "Why was this selected?" | `generator.js` → `explainSelection` |
| 26 | Smart generation from blueprints | `server/services/blueprint.js` |
| 27 | End-to-end scenario | covered by `tests/api.test.js` |
| 28 | Future metadata extensibility | `server/core/metadata.js`, `question_attributes` |
| 29 | Role-based access control | `server/middleware/auth.js` |
| 30 | Separation of concerns | four distinct tables, no content duplication |

---

## Beyond the specification

Ten capabilities the specification does not require, added because a bank that is
only ever *read* eventually stops being trustworthy. Each is enforced server-side
and covered by `tests/authoring.test.js` and `tests/assessment.test.js`.

| Capability | Why it exists | Implementation |
|---|---|---|
| **Question authoring** | The spec assumes the bank already exists. Without CRUD, a typo in a live question has no fix inside the product. | `services/questionService.js`, `components/QuestionEditor.jsx` |
| **Bulk import with taxonomy matching** | Banks arrive as spreadsheets. Subjects are matched against the taxonomy — "operating systems" resolves to *Operating System* — and anything uncertain is flagged rather than guessed. | `services/importService.js`, `components/ImportWizard.jsx` |
| **Exposure control** | Duplicate prevention works *within* a test. This stops the same questions being reused across successive papers: never-used-before, cooldown windows, usage caps, and parallel forms ("nothing that appeared in form A"). | `core/exposure.js` |
| **Near-duplicate detection** | Duplicate prevention keys on QID, so it cannot see two *different* QIDs carrying the same question — which banks assembled from several sources are full of. Word shingles and a MinHash-style sketch find them. | `core/similarity.js`, `components/DuplicatesPanel.jsx` |
| **Blueprint coverage** | Availability answers *can this section be filled*. Coverage answers the question a designer actually has afterwards: *did the test cover what I intended, in the proportions I intended?* | `core/coverage.js`, `components/CoveragePanel.jsx` |
| **Response capture and item analytics** | This product does not deliver tests, but without response data no one can tell a good item from a bad one. Results are ingested from an LMS, proctoring platform or OMR scanner; each question gets a p-value, a point-biserial discrimination index and distractor analysis. | `core/itemAnalytics.js`, `routes/results.js` |
| **QTI 2.1 export** | PDF and Excel are for humans. QTI is an IMS content package an LMS can actually deliver — which is also how responses come back. | `services/qtiService.js` |
| **Approval workflow** | `draft → review → approved → published`, with sign-off deliberately separated from `tests:write`: nobody approves their own test, and editing the questions of an approved test revokes the approval. | `services/testService.js` |
| **Paper layout options** | Two-column layout, page break per section, reserved answer space, and installation branding on the printed paper. | `services/exportService.js`, `routes/settings.js` |
| **Saved question sets** | A template saves a whole test; this saves a *filter* on its own, with a live count — because a set that matched 300 questions last month may match 40 today. | `routes/sets.js`, `components/SavedSets.jsx` |

Two things were deliberately **not** built:

- **AI question generation.** The specification is explicit that the system
  selects from an existing bank and never invents questions. Generating item text
  would break that contract, not extend it.
- **Multi-tenancy.** It touches every query and every index. It is a different
  product shape, not a feature.

### Reading the item statistics

| Measure | What it is | How to read it |
|---|---|---|
| p-value | Share of candidates who answered correctly | Higher means *easier*. Below 0.2 or above 0.9 is flagged. |
| Discrimination | Point-biserial correlation between getting this item right and total score | < 0.1 poor · 0.1–0.2 marginal · 0.2–0.3 acceptable · ≥ 0.3 good. **Negative means the key is probably wrong.** |
| Difficulty flag | Observed difficulty against the authored label | `harder_than_labelled` and its opposite mark a disagreement worth resolving. |
| Dead distractor | An option nobody ever chose | Adds length without adding discrimination. |

Statistics need at least 20 responses before a question is flagged; below that
the numbers are noise, and the API says so rather than reporting a figure.

---

## Architecture

```
server/
├── config.js               environment configuration
├── app.js                  express app (helmet, rate limits, SPA hosting)
├── index.js                bootstrap + graceful shutdown
├── db/
│   ├── schema.sql          tables, indexes, FTS5, facet triggers
│   ├── migrate.js          idempotent migration + taxonomy load + bootstrap admin
│   ├── backfill.js         upgrade path from the pre-taxonomy schema
│   ├── seed.js             deterministic bank generator
│   └── taxonomy/           taxonomy.json (committed) + source workbook
├── core/
│   ├── taxonomy.js         hierarchy loading, cascades, name→id index
│   ├── metadata.js         FIELD REGISTRY — drives everything filterable
│   ├── filterEngine.js     boolean tree → parameterised SQL; explainability
│   ├── questions.js        counting, paging, seeded sampling, facets
│   ├── distribution.js     largest-remainder allocation
│   ├── availability.js     shortfall detection + feasible remedies
│   ├── generator.js        three modes, versions, replacement, audit
│   ├── validation.js       pre-save validation rules
│   └── rng.js              seeded, reproducible randomness
├── middleware/             auth, RBAC, validation, error handling
├── routes/                 auth, questions, tests, templates, exports, analytics, users
└── services/               testService, exportService, blueprint

client/src/
├── pages/                  Dashboard, CreateTest, QuestionBank, Templates,
│                           GeneratedTests, TestDetail, Analytics, Settings
├── components/             SectionEditor, FilterPanel, RuleBuilder, Availability,
│                           ManualPicker, PreviewPanel, Replace/Explain modals, ui
└── lib/                    api client, auth context, hooks
```

Stack: **Node 20+ / Express 5 / SQLite (better-sqlite3, WAL) / React 19 / Vite**.

SQLite was chosen because the workload is read-heavy with a single writer, and
because WAL plus proper indexing comfortably handles hundreds of thousands of
questions (see [Selection at scale](#selection-at-scale)). Nothing in the data
layer is SQLite-specific beyond `server/db/`; the schema is ordinary normalised
SQL and ports to PostgreSQL with the FTS and `seeded_hash` pieces swapped.

---

## Data model

Four concerns, kept deliberately separate (spec §30):

```
taxonomy_subjects ── taxonomy_areas ── taxonomy_sub_areas   the classification tree
                            └── taxonomy_area_tags ── taxonomy_tags

questions ───┬── question_taxonomy      QID → branch(es), many-to-many
             ├── question_options       the bank — never modified by test generation
             ├── question_tags
             └── question_attributes    extensible metadata (any future field)

tests ───┬── test_sections             the rules: what each section should contain
         └── test_questions            the outcome: which QIDs were selected

test_templates                         reusable configurations
audit_log                              who did what
facet_counts                           incrementally maintained aggregates
```

`test_sections.selection_rules` stores the rule and distribution as JSON, so a
test remembers *how* it was built. That is what makes **Regenerate**, **Replace**
and **"Why was this question selected?"** possible long after generation.

### Indexes

```sql
idx_questions_selection   (status, question_type, difficulty, id)
idx_questions_difficulty  (difficulty, status, id)
idx_questions_type        (question_type, status, id)
idx_qtax_subject          (subject_id, question_id)   -- taxonomy lookups are range scans
idx_qtax_area             (area_id, question_id)
idx_qtax_sub_area         (sub_area_id, question_id)
idx_qtax_unique           (question_id, area_id, COALESCE(sub_area_id, 0))  UNIQUE
idx_tags_tag              (tag, question_id)          -- tag lookups are range scans
idx_attr_lookup           (attr_key, attr_value, question_id)
idx_attr_numeric          (attr_key, num_value, question_id)
questions_fts             FTS5 external-content index over question_text
```

Taxonomy and tag predicates compile to `q.id IN (SELECT question_id FROM … WHERE …)`
rather than a correlated `EXISTS`. That lets SQLite build the matching set once
from the leading index column instead of probing per candidate row — on a
300,000-question bank the difference is about 9 ms versus 72 ms.

`facet_counts` is maintained by triggers, so the Question Bank dashboard, the
taxonomy dropdowns and the tag vocabulary are O(1) lookups instead of
`SELECT DISTINCT` scans over the whole bank.

---

## The filter engine

Two input shapes, one compiler.

**Quick filters** — what section rules use:

```json
{
  "question_type": ["MCQ"],
  "subject": ["Operating System"],
  "area": ["Memory Management"],
  "sub_area": ["Virtual Memory and Paging"],
  "difficulty": ["Hard"],
  "includeTags": ["Demand Paging"],
  "excludeTags": ["beginner"]
}
```

The three taxonomy levels are compiled together as a single same-branch
constraint (see [Why levels must match on the same branch](#why-levels-must-match-on-the-same-branch)).

**Boolean tree** — what the Smart Filter Builder emits, nestable to 12 levels:

```json
{
  "op": "AND",
  "children": [
    { "field": "subject", "operator": "in", "value": ["Operating System"] },
    { "op": "OR", "children": [
      { "field": "difficulty", "operator": "eq", "value": "Hard" },
      { "field": "tags", "operator": "has_any", "value": ["advanced"] }
    ]},
    { "op": "NOT", "children": [
      { "field": "tags", "operator": "has_any", "value": ["beginner"] }
    ]}
  ]
}
```

Both compile to a parameterised `WHERE` clause. Every value is bound — user input
never reaches the SQL string, and an unknown field name is rejected outright.

### Adding a new filterable field

Append one descriptor to `server/core/metadata.js`:

```js
{ key: 'exam_board', label: 'Exam Board', source: 'attribute',
  attrKey: 'exam_board', dataType: 'enum',
  operators: ['in', 'not_in', 'eq', 'neq'], group: 'Context' }
```

It is then immediately filterable through the API, usable in section rules, and
visible in the filter-builder UI. No migration, no SQL, no UI change.

---

## Selection at scale

Random selection never materialises the matching set. Two strategies, chosen by
match size:

- **Match set ≤ `SELECTION_POOL_THRESHOLD`** (default 20,000) — order by a
  SQLite-registered `seeded_hash(seed, qid)` function and take the top N. Exact,
  uniform, reproducible, and the database does the work.
- **Larger match sets** — seeded *window sampling*: jump to random anchor IDs and
  read short runs from the covering index. Each draw is an index seek rather than
  a scan, so cost is independent of bank size.

Measured on a **300,000-question** bank (this machine, cold cache warmed by one
`ANALYZE`):

| Operation | Time |
|---|---|
| Count: subject | 42 ms |
| Count: subject + area | 9 ms |
| Count: subject + area + sub-area | 4 ms |
| Count: ambiguous area name, unscoped | 8 ms |
| Count: whole active bank | 11 ms |
| Count: taxonomy + tag exclusion | 31 ms |
| Full-text search | 2–15 ms |
| Subject / area / sub-area cascades | 0.3–0.8 ms |
| Taxonomy tag suggestions for a branch | 0.3 ms |
| Full taxonomy tree with question counts | 26 ms |
| Bank dashboard statistics | 1.0 ms |
| Filtered listing, page 1 and page 200 (hydrated) | 29–38 ms |
| Sample 20 from a narrow branch | 12 ms |
| Sample 50 from a bank-wide match set | 38 ms |
| Availability check with 3-way distribution | 56 ms |
| **Generate a 50-question, 3-section test** | **214 ms** |

The browser never receives the bank: search is paginated and capped by
`MAX_PAGE_SIZE`, and every filter is applied server-side.

---

## Reproducibility

Every random decision flows through a seeded PRNG. Given the same seed and the
same rules, generation is deterministic:

```
Seed "DSA2026" + section rules  →  always the same QIDs, in the same order
```

This is what makes test **versions** meaningful: versions A/B/C share the rules
and therefore the difficulty and taxonomy distribution, but derive distinct seeds
(`DSA2026:vA`, `:vB`, `:vC`) and therefore distinct questions. With
`uniqueAcrossVersions`, no QID is shared between them — and if the bank is too
small for that, the system says so rather than silently overlapping.

---

## Roles and permissions

Enforced server-side on every request (`server/middleware/auth.js`). The client
uses the same matrix only to hide controls.

| Capability | Admin | Test Creator | Viewer |
|---|:---:|:---:|:---:|
| Browse the question bank | ✓ | ✓ | ✓ |
| Create / generate tests | ✓ | ✓ | — |
| Edit **any** test | ✓ | own only | — |
| Delete tests | ✓ | own only | — |
| Manage templates | ✓ | ✓ | — |
| Author / retire questions | ✓ | — | — |
| Bulk-import questions | ✓ | — | — |
| **Approve** a test for publication | ✓ | — | — |
| Save and share question sets | ✓ | ✓ | read only |
| Import results | ✓ | ✓ | read only |
| Export student paper | ✓ | ✓ | ✓ |
| Export **answer key** | ✓ | ✓ | — |
| View analytics | ✓ | ✓ | ✓ |
| Change installation branding | ✓ | — | — |
| Manage users | ✓ | — | — |

Approval sits behind its own `tests:approve` capability rather than `tests:write`,
because the entire point of a review step is that the author is not the person who
signs it off. The service refuses self-approval even for an administrator.

Authentication is a JWT delivered both as an httpOnly cookie and a bearer token.
The user record is re-read on every request, so deactivating an account or
changing a role takes effect immediately rather than at token expiry. The last
active administrator cannot be demoted or disabled.

---

## API reference

All routes are under `/api` and require authentication except `/api/auth/login`
and `/api/health`.

### Auth
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/login` | Sign in; returns token + capability list |
| `POST` | `/auth/logout` | Clear the session cookie |
| `GET` | `/auth/me` | Current user and permissions |
| `POST` | `/auth/change-password` | Change own password |

### Question bank
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/questions/metadata` | Field registry, operators, facet vocabularies |
| `GET` | `/questions/statistics` | Dashboard counters |
| `GET` | `/questions/taxonomy` | Full Subject → Area → Sub-Area tree with counts |
| `GET` | `/questions/facets/:dimension` | Facet values; `?parent=` cascades areas from subjects and sub-areas from areas |
| `GET` | `/questions/tags?q=` | Tag autocomplete; `?subject=`/`?area=` scope it, `?source=taxonomy` returns the defined vocabulary |
| `POST` | `/questions/search` | Paginated, filtered, sorted listing |
| `POST` | `/questions/count` | Live availability count for a filter |
| `POST` | `/questions/lookup` | Batch fetch by QID |
| `GET` | `/questions/:qid` | One question (`?withAnswers=true`) |
| `POST` | `/questions` | Author a new question (QID assigned automatically) |
| `PATCH` | `/questions/:qid` | Update a question; omitted fields are left alone |
| `DELETE` | `/questions/:qid` | Retire; `?hard=true` deletes, refused while a test references it |
| `POST` | `/questions/import/preview` | Analyse a parsed file — writes nothing |
| `POST` | `/questions/import/commit` | Write the rows the operator accepted |
| `GET` | `/questions/import/template` | The columns an import file may contain |
| `GET` | `/questions/duplicates` | Bank-wide near-duplicate groups (`?threshold=`) |
| `POST` | `/questions/duplicates/reindex` | Recompute fingerprints for rows lacking one |
| `GET` | `/questions/:qid/similar` | Near-duplicates of one question |
| `GET` | `/questions/:qid/usage` | Which tests have used this question |
| `GET` | `/questions/:qid/analytics` | p-value, discrimination, distractor analysis |
| `GET` | `/questions/exposure/overview` | Reuse across the whole bank |

### Test planning
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/tests/availability` | Availability for a whole draft |
| `POST` | `/tests/availability/section` | Availability for one section + remedies |
| `POST` | `/tests/validate` | Dry-run validation report |
| `POST` | `/tests/preview` | Generate a selection without saving |

### Tests
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/tests` | History (paginated, filterable) |
| `POST` | `/tests` | Validate → generate → save |
| `GET` | `/tests/:id` | Full test with sections and questions |
| `PATCH` | `/tests/:id` | Update metadata |
| `DELETE` | `/tests/:id` | Delete |
| `POST` | `/tests/:id/archive` | Archive |
| `POST` | `/tests/:id/duplicate` | Copy configuration and selection |
| `POST` | `/tests/:id/regenerate` | Re-run the stored rules with a new seed |
| `POST` | `/tests/:id/versions` | Create versions A/B/C… |
| `GET` | `/tests/:id/versions` | List the test and its versions |
| `POST` | `/tests/:id/submit-review` | draft → review |
| `POST` | `/tests/:id/approve` | review → approved (needs `tests:approve`) |
| `POST` | `/tests/:id/reject` | review → draft, with the reviewer's note |
| `POST` | `/tests/:id/publish` | approved → published |
| `GET` | `/tests/:id/coverage` | Intended vs actual on one axis (`?axis=`, or `all`) |
| `GET` | `/tests/:id/coverage/axes` | Axes this test can be measured on |
| `GET` | `/tests/:id/duplicate-warnings` | Near-duplicate questions drawn into this test |

### Question-level editing
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/tests/:id/questions/:tqId/replacements` | Alternatives matching the same rule |
| `POST` | `/tests/:id/questions/:tqId/replace` | Swap in a replacement |
| `GET` | `/tests/:id/questions/:tqId/explain` | Why this question was selected |
| `POST` | `/tests/:id/questions/:tqId/move` | Move to another section |
| `DELETE` | `/tests/:id/questions/:tqId` | Remove from the test |
| `POST` | `/tests/:id/sections/:sId/questions` | Add questions |
| `POST` | `/tests/:id/sections/:sId/reorder` | Reorder within a section |

### Templates, exports, analytics, users
| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST`/`PUT`/`DELETE` | `/templates[/:id]` | Template CRUD |
| `GET` | `/templates/blueprints` | Predefined blueprints |
| `POST` | `/templates/blueprints/expand` | Blueprint → sections + feasibility |
| `GET` | `/exports/:id/{json,csv,xlsx,pdf}` | Export a test |
| `GET` | `/exports/:id/pdf?columns=2&pageBreaks=true&answerSpace=false&branding=false` | Paper layout options |
| `GET` | `/exports/:id/qti` | QTI 2.1 IMS content package (zip) |
| `GET` | `/exports/:id/answer-key.pdf` | Answer key (not available to viewers) |
| `GET`/`POST`/`PUT`/`DELETE` | `/sets[/:id]` | Saved question sets, with live counts |
| `GET` | `/sets/:id/questions` | What a saved set currently matches |
| `POST` | `/results/tests/:id/attempts` | Ingest structured attempts |
| `POST` | `/results/tests/:id/responses` | Ingest a flat results file (one row per response) |
| `GET` | `/results/tests/:id/results` | Attempt and item results for one test |
| `DELETE` | `/results/tests/:id/attempts` | Clear results and recompute |
| `GET` | `/results/items/overview` | Bank-wide item quality |
| `POST` | `/results/items/recompute` | Force a statistics recompute |
| `GET`/`PUT` | `/settings` | Installation branding (admin to write) |
| `GET` | `/analytics/overview` | Bank and test analytics |
| `GET` | `/analytics/tests/:id` | Composition of one test |
| `GET` | `/analytics/audit` | Audit trail (admin) |
| `GET`/`POST`/`PATCH` | `/users[/:id]` | User administration (admin) |

---

## Configuration

All settings come from the environment; see `.env.example`.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `NODE_ENV` | `development` | `production` enables CSP and secure cookies |
| `DATABASE_PATH` | `./data/test-generator.db` | SQLite file, or `:memory:` |
| `JWT_SECRET` | — | **Required in production**; startup fails without it |
| `JWT_EXPIRES_IN` | `12h` | Token lifetime |
| `COOKIE_SECURE` | follows `NODE_ENV` | Set `true` behind HTTPS |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | see `.env.example` | Bootstrap admin, created once |
| `SELECTION_POOL_THRESHOLD` | `20000` | Switch point to window sampling |
| `MAX_PAGE_SIZE` | `200` | Hard cap on listing responses |

---

## Testing

```bash
npm test
```

129 tests across six suites, each running against a fresh temporary database
seeded with 4,000 questions classified against the real taxonomy:

- **`tests/engine.test.js`** — filter compilation and SQL-injection safety,
  AND/OR/NOT evaluation, extensible attribute filtering, largest-remainder
  allocation, seed reproducibility, cross-section deduplication, honest
  shortfall reporting, distribution-aware availability remedies, version
  disjointness, and selection explainability.
- **`tests/api.test.js`** — authentication, the full RBAC matrix, ownership
  checks, pagination caps, the end-to-end scenario from spec §27, replace /
  add / move / remove consistency, duplicate rejection, versions, templates,
  immediate token invalidation on deactivation, and audit logging.
- **`tests/taxonomy.test.js`** — bracket-aware workbook parsing, the shipped
  tree matching the workbook's own Summary totals, idempotent loading,
  many-to-many mapping with exactly one primary branch, per-level filtering,
  case-insensitive name resolution, unknown names excluding rather than
  widening, **same-branch semantics for ambiguous area names**, cascading
  lookups, branch-scoped tag suggestions, and the legacy upgrade path
  (including the word-boundary rule that stops "Graph" matching
  "Crypto*graph*y").
- **`tests/exports.test.js`** — JSON structure, CSV field-count integrity with
  quoted separators, a real Excel workbook read back with ExcelJS, and PDF
  content extracted from the compressed content streams to assert that the
  student paper contains the questions but **never** the answers, and that the
  QID toggle works.
- **`tests/authoring.test.js`** — question CRUD including the rule that a PATCH
  omitting a field must not wipe it (Zod's `.partial()` does not suppress a
  `.default()`), refusal to invent an unknown taxonomy branch, hard delete
  blocked while a test references the QID, import preview writing nothing,
  fuzzy taxonomy matching and attribute passthrough on commit, near-duplicate
  detection catching two QIDs with the same question, and exposure rules
  (never-used, cooldown windows) actually shrinking the eligible pool.
- **`tests/assessment.test.js`** — the approval state machine including
  self-approval refusal and approval revoked by a post-approval edit, blueprint
  coverage against both a distribution and a single-value filter, every
  advertised coverage axis, results ingestion in both shapes with re-upload
  replacing rather than duplicating an attempt, discrimination that actually
  separates a strong cohort from a weak one, a QTI package unzipped and checked
  against its own manifest, each PDF layout option changing the document, saved
  question sets with live counts and ownership rules, and branding that refuses
  a remote logo URL.

---

## Deployment

```bash
npm ci                       # install everything, including the build tooling
npm run build                # produce client/dist
npm prune --omit=dev         # optional: drop the build tooling afterwards

export NODE_ENV=production
export JWT_SECRET="$(openssl rand -hex 32)"
npm run migrate
npm start
```

The Express server hosts the built SPA and the API on one origin, so no CORS
configuration is needed. Behind a reverse proxy, terminate TLS there and set
`COOKIE_SECURE=true`.

Operational notes:

- The database runs in WAL mode; back up `data/*.db` together with `-wal` and
  `-shm`, or use `sqlite3 .backup`.
- `npm run migrate` is idempotent and safe to run on every deploy. It creates the
  bootstrap admin only when no admin exists.
- Helmet sets a strict CSP in production; rate limiting protects the API broadly
  and the login route specifically.
