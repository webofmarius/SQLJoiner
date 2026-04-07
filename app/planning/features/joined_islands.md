# SQLForge — Feature Planning

---

## Feature 1: Connected-Only Tables + Island Detection

### Overview

Only include tables in the final query if they are connected to at least one other table via an enabled join. If the canvas results in multiple disconnected groups (islands), block query execution and prompt island selection (see Feature 3).

---

### Algorithm

**Step 1 — Filter unconnected tables**

Before building the query, scan all tables (both normal and subquery):
- If a table has zero enabled joins referencing its ID (as `fromTableId` or `toTableId`), exclude it from the working table set
- This applies equally to normal tables and subquery tables

**Step 2 — Compute connected components on the filtered set**

- Build an adjacency graph from the remaining tables and their enabled joins
- Run BFS/DFS from each unvisited table to identify all connected islands
- Result: a list of groups, e.g. `[[A, B], [C, D]]`

**Step 3 — Validate**

- If total remaining tables = 1 → that single table is an island, proceed
- If connected components = 1 → proceed normally
- If connected components ≥ 2 → block and show island selection UI (see Feature 3)

**Step 4 — Build query with filtered tables/joins**

- The existing order-based sorting, chain-following, and FROM/JOIN assembly remain unchanged
- They simply receive the filtered table/join arrays

---

### Behavior by Scenario

| Canvas state | Current behavior | New behavior |
|---|---|---|
| Single table | Runs | Runs (unchanged) |
| A→B (connected) | Runs | Runs (unchanged) |
| A→B + unconnected subquery sq1 | Rejects (unchained) | sq1 silently dropped, runs A→B |
| A→B + unconnected normal table C | Rejects (unchained) | C silently dropped, runs A→B |
| A→B and C→D (two islands) | Rejects (unchained) | Island selection UI shown (Feature 3) |
| A→B→sq1 (subquery connected) | Works | Works (unchanged) |

---

### Files to Modify

- `assets/js/config.js` — `QueryPanel.buildSQL()`: add filtering + island detection before table sorting
- `src/Query/QueryBuilder.php` — `buildFromRequest()`: same filter + island detection; throw validation error on multiple islands
- `src/Query/JoinClause.php` — add static helper `getConnectedComponents(array $joins, array $tables): array`

---

---

## Feature 2: Join Line Color + Enable/Disable Toggle

### Overview

Each join line gets two new properties: a custom color override and an enabled/disabled toggle. Disabled joins are excluded from SQL generation and from island/connectivity calculations.

---

### Data Model Changes

Add two new fields to each join object:

```js
{
    id: string,
    fromTableId: string,
    fromCol: string,
    toTableId: string,
    toCol: string,
    type: 'INNER'|'LEFT'|'RIGHT'|'FULL'|'CROSS',
    color: string|null,   // hex color; null = use auto palette
    enabled: boolean      // false = excluded from query and connectivity; default true
}
```

Same two fields added to the PHP-side join parsing in `QueryBuilder.php`. Persisted via JSON storage in `ContextManager`.

---

### UI Changes

**Join editor modal** (in `config.js` / `canvas.js`):
- Add a color picker input — when set, overrides the auto table-pair color palette for that line
- Add an "Enabled" checkbox — unchecked means the join is disabled

**Join line rendering (`joins.js`)**:
- If `join.color` is set, use it instead of the auto palette color
- If `join.enabled === false`: render the line dashed + semi-transparent (visually distinct, still visible on canvas)

---

### Query Building Changes

In both `config.js` (`QueryPanel.buildSQL`) and `QueryBuilder.php` (`buildFromRequest`):
- Exclude disabled joins from the working join set before any processing
- Disabled joins do not count as connections for the island detection / filtering logic — a table connected only via disabled joins is treated as unconnected

---

### Behavior Summary

| Scenario | Behavior |
|---|---|
| Join with custom color | Line renders in that color instead of auto palette |
| Join unchecked (disabled) | Dashed/faded line on canvas, excluded from SQL entirely |
| Table connected only via disabled join | Treated as unconnected → becomes its own island |
| Disabled join re-enabled | Immediately included again in preview/query |

---

### Files to Modify

- `assets/js/joins.js` — rendering logic (color + dashed style for disabled)
- `assets/js/config.js` — join editor modal UI (color picker + checkbox); exclude disabled joins in `buildSQL`
- `src/Query/QueryBuilder.php` — exclude disabled joins before assembly
- `assets/js/app.js` — initialize `color: null, enabled: true` on new join creation

---

---

## Feature 3: Island Visualization & Selection

### Overview

When 2+ islands exist, render a bounding rectangle per island on the canvas with a radio button for selection. Only the selected island's tables and joins are used for the final query. Every table — including single unconnected tables — counts as an island and gets a rectangle.

---

### What Counts as an Island

- An island is any connected component of 1 or more tables connected via **enabled joins**
- A single unconnected table **is** an island — it gets a rectangle and radio button
- Every table on the canvas belongs to exactly one island at all times

---

### State Changes

```js
state.selectedIslandKey: string|null  // stable key of the currently selected island
```

**Island Key**: sorted table IDs of the group joined with `|` (e.g. `"t_001|t_002"`). Stable across recomputations — if the same group persists after a join toggle, the selection is preserved.

---

### Island Rectangle Rendering

New rendering layer in `canvas.js` (or a dedicated `islands.js`):
- Rendered behind table cards, above the canvas background
- Each rectangle = bounding box of all tables in the island + fixed padding (e.g. 24px)
- Redraws on: join enable/disable, table drag/move, table add/remove
- **Selected island**: colored border (accent color) + subtle tinted background fill
- **Unselected island**: muted gray border + very light or transparent background

**Radio button**: positioned at the top-left corner of each rectangle
- Custom-styled to match the app's visual language
- Clicking anywhere on the rectangle or the radio button selects that island
- Only one island can be selected at a time

**Single island**: no rectangles shown, query runs normally without requiring selection.

---

### Island Recomputation Triggers

Recompute islands whenever:
- A join is enabled or disabled
- A join is added or removed
- A table is added or removed
- A table is moved (rectangles redraw for position; groupings unchanged)

**Recomputation logic:**
1. Take all enabled joins only
2. Run connected-components on all tables
3. Every component (including single tables) is an island
4. Compare new island keys against `selectedIslandKey`:
   - If previously selected island still exists → keep selection
   - If it no longer exists → clear selection (`selectedIslandKey = null`)

---

### Query Execution with Islands

| State | Behavior |
|---|---|
| 1 island (any size) | No rectangles shown, query runs normally with that island |
| 2+ islands, none selected | Show rectangles + radio buttons; show message: "Multiple disconnected table groups found. Select one to query." Block run. |
| 2+ islands, one selected | Run query using only the selected island's tables and enabled joins |

---

### Dynamic Join Toggle Examples

**Setup**: A→B (island [A,B]), B--C disabled, C→D (island [C,D])

| Action | Result |
|---|---|
| Re-enable B→C | Single island [A,B,C,D] — rectangles disappear, query runs normally |
| Disable A→B | Island [A] and island [B,C,D] — 2 rectangles shown, selection required |
| Re-enable A→B | Back to single island [A,B,C,D] |
| Disable both A→B and C→D | Three islands: [A], [B], [C,D] — 3 rectangles shown |

---

### Files to Modify

| File | Change |
|---|---|
| `assets/js/app.js` | Add `selectedIslandKey` to state; add `computeIslands()` utility; trigger recompute on join toggle/add/remove |
| `assets/js/canvas.js` (or new `islands.js`) | Island rectangle rendering, radio button UI, click-to-select handler, redraw-on-table-move |
| `assets/js/joins.js` | Call island recompute after enable/disable toggle |
| `assets/js/config.js` | `buildSQL()` uses selected island's filtered tables/joins; show island-selection message when blocked |
| `src/Query/QueryBuilder.php` | Receives pre-filtered tables/joins from frontend (island filtering happens client-side before the request) |

---

---

## Feature 4: Per-Island Right-Pane + Calculus Config

### Overview

Each island persists its own complete right-pane configuration (SELECT, WHERE, GROUP BY, HAVING, ORDER BY, table order, and Calculus state). Selecting an island loads its config; modifying anything saves back to that island. When islands merge or split, configs are intelligently inherited.

---

### Architecture Decision: Video Buffer Model

The right-pane and Calculus state uses a **video buffer pattern**:

- **The video buffer** = flat `State` fields (`State.select`, `State.where`, `State.orderBy`, `_calculusRows`, etc.) — all existing UI code reads from these directly, unchanged
- **Background RAM** = `State.islandConfigs` — stores the full config snapshot for every island key that has ever existed
- **Island switch** = a "blit" operation: flush current flat State into the outgoing island's slot, then load the incoming island's slot into flat State
- **Right-pane change** = auto-save back to `islandConfigs[currentIslandKey]`, keeping buffer and background RAM in sync

This means no existing rendering or query-building code needs to know about islands — it always reads from the same flat State fields.

---

### Island Config Structure

```js
state.islandConfigs: {
  [islandKey]: {
    // Table ordering within this island (moved here from table object)
    tableOrder: { [tableId]: number },  // 1 = FROM, 2+ = JOIN sequence

    // Right-pane fields (mirrors of flat State fields)
    select: [...],
    selectRaw: '',
    selectMode: 'visual'|'raw',
    selectCustomExprs: [...],
    selectAliases: {},
    selectNone: false,
    selectAddDelimiter: false,
    selectSortAlpha: false,
    selectDistinct: false,

    where: [...],
    whereRaw: '',
    whereMode: 'visual'|'raw',

    groupBy: [...],
    groupByRaw: '',
    groupByMode: 'visual'|'raw',

    having: [...],
    havingRaw: '',
    havingMode: 'visual'|'raw',

    orderBy: [...],
    orderByRaw: '',
    orderByMode: 'visual'|'raw',

    limit: number,

    // Calculus toolbox state
    calculus: {
      note: string|null,
      rows: [...],   // same shape as Results.calcGetState() output
    } | null,
  }
}
```

`islandKey` matches the same stable key used in Feature 3. Persisted in context JSON via `ContextManager`.

---

### The `order` Field Moves to Island Config

Previously `table.order` (1 = FROM, 2+ = JOIN sequence) lived on the table object itself. It now lives in `islandConfigs[key].tableOrder[tableId]`.

- The order dropdown on table cards reads/writes `islandConfigs[currentIslandKey].tableOrder[tableId]`
- On island switch, the incoming island's `tableOrder` is applied, making the right table the FROM for that island
- **Merge**: A's tableOrder is kept as-is; B's tables are appended and renumbered to continue the sequence. A's FROM table (order 1) becomes C's FROM table.
- **Split**: Each resulting island filters C's `tableOrder` to its own table IDs and renumbers from 1. The lowest-ordered table in each subset becomes the new FROM.

---

### Load / Save Behavior

- **Selecting an island** via radio button → flush current flat State to outgoing island slot → load incoming island slot into flat State + call `Results.calcRestoreFromContext()`
- **Any right-pane change** → auto-save back to `islandConfigs[currentIslandKey]`
- **Single island** (no rectangles shown) → still saves/loads from its key, seamlessly and transparently

---

### Merge Behavior (A + B → C)

When a join is added/re-enabled between two islands, they form island C with key = sorted union of all table IDs.

**C's config is initialized as the union of A's and B's configs:**
- `tableOrder`: A's ordering kept, B's tables appended and renumbered
- `select`: union of both SELECT columns
- `where`: union of both WHERE conditions (appended; user can clean up)
- `groupBy`, `orderBy`: union of both
- `having`: union of both
- `calculus`: union of both Calculus row sets; notes concatenated

**On re-merge** (A and B were split, modified independently, then re-joined): C's config is re-initialized from the current A and B configs, overwriting any stale C config.

---

### Split Behavior (C → A + B)

When a join is removed/disabled, C splits back into A and B.

Each resulting island inherits a **filtered subset of C's config** based on which tables the config items reference:
- `tableOrder`: filtered to each island's table IDs, renumbered from 1
- `select`: A gets columns prefixed with A's table aliases, B gets B's
- `groupBy`, `orderBy`: same — each item has a table alias prefix, routed accordingly
- `calculus.rows`: each row's items are filtered by table alias; rows with no remaining items are dropped
- `calculus.note`: copied to both islands
- `where` / `having`: see cross-island conditions below

---

### Design Challenge: Cross-Island WHERE / HAVING Conditions

Some WHERE or HAVING conditions may reference columns from **both** A and B (e.g. `a.id > b.foreign_count`). These cannot cleanly belong to either resulting island alone.

**Rule**: Any condition referencing tables from both resulting islands is **copied to both islands** (not dropped). The user can then remove the irrelevant copy.

A subtle warning indicator flags these as "inherited cross-island conditions" to prompt the user to review them.

---

### Calculus Behavior on Island Switch

Calculus rows bind to actual result cell values from the last query run. When switching islands:
- The outgoing island's Calculus state is flushed via `Results.calcGetState()` into `islandConfigs[outgoingKey].calculus`
- The incoming island's Calculus state is restored via `Results.calcRestoreFromContext(islandConfigs[incomingKey].calculus)`
- Restored rows are marked **out-of-sync** (no live `originTd` references) — same behavior as loading a saved context today
- Running the query on the newly selected island re-syncs the Calculus rows against the fresh results

---

### Import Behavior

The import flow (paste SQL → parse → confirm → `_applyImportResult`) always produces a single connected island. Updates needed:

1. Compute the island key from the imported tables after parsing
2. Populate `islandConfigs[islandKey]` with all right-pane fields from the parsed result
3. Populate `islandConfigs[islandKey].tableOrder` from table order assignments (instead of setting `table.order` directly)
4. Set `State.selectedIslandKey` to the new island key
5. Apply `color: null, enabled: true` defaults to all imported joins
6. Calculus starts empty for the imported island (no calculus in parsed SQL — same as today)

---

### Island Key Lifecycle Example

| Action | Islands | islandConfigs keys active |
|---|---|---|
| Start: A, B, C, D all separate | [A], [B], [C], [D] | `A`, `B`, `C`, `D` |
| Join A→B | [A,B], [C], [D] | `A\|B` (initialized from A+B), `C`, `D` |
| Join C→D | [A,B], [C,D] | `A\|B`, `C\|D` |
| Select A\|B island, modify SELECT | — | `A\|B` updated |
| Join B→C (merges everything) | [A,B,C,D] | `A\|B\|C\|D` (initialized from `A\|B` + `C\|D`) |
| Disable B→C (split) | [A,B], [C,D] | `A\|B` and `C\|D` restored as filtered subsets of `A\|B\|C\|D` |

Old configs are never deleted — they become stale but are overwritten cleanly on re-merge or re-split.

---

### Global (Non-Island) State Fields

The following fields are **not** part of island config — they remain global on `State`:
- `notes` — canvas notes field, shared across all islands
- `customQuery` — raw SQL textarea content, shared across all islands
- `columnOrder` — derived field, recomputed from the incoming island's tables on every island switch (not stored)

---

### Initial Island Config (New Island)

When a new island is created (table first added to canvas), its config is initialized with **all columns pre-selected** in SELECT (matching current app behavior when a table lands on the canvas). All other fields start empty/default.

---

### Island Opacity & Interaction

**Opacity rules:**
- **1 island** (no rectangles shown): everything at 100%, no opacity logic applies
- **2+ islands, nothing selected yet**: all islands at 100%
- **2+ islands, one selected**: selected island at 100%, all others at 70% (rectangles + table cards + their join lines)
- CSS `transition: opacity 0.15s ease` on all affected elements for smooth switching

**Auto-select on interaction:**
- Clicking or mousedown-dragging anything within an unselected island (table card, column, join line within the island) automatically triggers a full island switch — identical to clicking the radio button (flush outgoing → blit incoming)
- The island switch happens on **mousedown** so that drag operations begin on an already-selected island
- **Exception**: clicking a disabled join line that bridges two different islands does **not** trigger an auto-select — just opens the join editor normally

---

### Files to Modify

| File | Change |
|---|---|
| `assets/js/app.js` | Add `islandConfigs` + `selectedIslandKey` to state; add `mergeIslandConfigs()`, `splitIslandConfigs()`, `selectIsland()` blit logic; update `_applyImportResult()` |
| `assets/js/config.js` | Auto-save right-pane changes to `islandConfigs[currentIslandKey]`; load on island selection; table order dropdown reads/writes `tableOrder` |
| `assets/js/canvas.js` / `islands.js` | Trigger island config load/save on radio button selection; apply opacity to table cards; auto-select on mousedown |
| `assets/js/joins.js` | Apply opacity to join lines of unselected islands; auto-select on join line mousedown (except cross-island disabled joins) |
| `assets/js/results.js` | No changes needed — existing `calcGetState()` / `calcRestoreFromContext()` API is sufficient |
| `src/Core/ContextManager.php` | Persist `islandConfigs` in save/load |

---

---

## Implementation Order

Features must be implemented in this sequence due to hard dependencies:

1. **Feature 2** — Join `enabled` + `color` fields (everything else depends on "enabled joins")
2. **Feature 1** — Connected-only filtering + island detection logic
3. **Feature 3** — Island rectangle visualization + radio button selection UI
4. **Feature 4** — Per-island right-pane + Calculus config (video buffer model)
