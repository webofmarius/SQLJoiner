# Feature: Query Plot & Pinned Plot Images

## Overview

Per-island query plotting: execute the final island query, draw an X-Y bar chart from the result columns, and optionally pin the resulting image to the island as a persistent thumbnail.

---

## UI Entry Points

### Plot Button & Named Checkbox

Located in the main toolbar, immediately after the **Explain Query** button. Only present on the main island query bar (not on custom-query, sq-expand, or import-query variants — those bypass the 1000-row limit enforced by the query builder).

```
[ Explain Query ]  [ Plot ]  [ ] Named
```

- **Plot** (`#btn-plot-query`): Executes the final query and opens the plot popup.
- **Named** (`#chk-plot-named`): Checkbox that controls pin title behavior.
  - **Unchecked**: pin title = island name, or `"col1 vs col2"` if island name is blank.
  - **Checked**: before plotting, a `Dialog.prompt("Enter plot title:")` is shown. If the user cancels, the entire plot operation is aborted.

---

## Query Execution & Column Validation

Uses `API.query.execute()` — same path as the Run Query button, same 1000-row limit.

### Column rules (checked in this order):

| Situation | Outcome |
|---|---|
| 0 numeric columns | Error: "No numeric columns to plot." |
| >2 numeric columns | Error: "Plotting supports a maximum of 2 numeric columns. This query returned N." |
| NULL in any plotted column | Error: "NULL value found in column '[name]' at row N. NULLs are not supported for plotting." |
| Non-numeric value in a numeric column | Error: "Non-numeric value found in column '[name]' at row N." |
| 1 numeric column | X axis = first string/text column values (or row index if no text column); Y = numeric column |
| 2 numeric columns | X = col1, Y = col2; string/text columns are ignored |

---

## Plot Drawing (`plot.js` — `Plot` namespace)

Canvas size: **640 × 480 px**.

### Visual style (matplotlib-inspired):
- White plot area, light gray background outside plot area
- Light gray horizontal grid lines
- Solid axis lines (X and Y)
- Tick labels on both axes
- Axis labels = column names
- Title displayed at top
- Bars: blue fill with slight transparency

### Modes:
- **1-column mode**: Bar chart. X = first text column values or row index. Y = numeric column.
- **2-column mode**: Bar chart. X = col1 values as tick labels. Y = col2 values.
- Y axis auto-scaled to data range with ~10% padding above the maximum value.

---

## Plot Popup (`#modal-plot`)

Structure follows the existing `.modal → .modal-box → .modal-header + .modal-body` pattern.

- **Header**: "Plot" title + close button (×)
- **Body**: `<canvas id="plot-canvas" width="640" height="480">`
- **Footer**: three action buttons:
  - **Copy** — `canvas.toBlob()` → `ClipboardItem` → `navigator.clipboard.write()`
  - **Save to Disk** — `canvas.toDataURL('image/png')` → programmatic `<a download>` click
  - **Pin to Island** — calls `Islands.pinPlot(islandKey, dataUrl, title)`; hidden when viewing an already-pinned plot

---

## Pin Container

Each island that has at least one pinned plot gets a `.plot-pin-container` element rendered to the left of the island.

### Positioning:
- Right edge of container = `islandLeft - 10px`
- Top = `islandTop`
- Height = island height (kept in sync via `_updatePinContainerGeometry()` called from `Islands.recompute()` and during island drag)
- Width = 340px (320px thumbnail + 10px padding each side)

### Container structure:
```
.plot-pin-container
  .plot-pin-container-header
    button.plot-pin-sort      "↑ Oldest" / "↓ Newest"  (toggle)
    button.plot-pin-close-all "Close All"
  .plot-pin-scroll-area       overflow-y: auto; remaining height
    .plot-pin  (× N)
```

### Container header controls:

| Control | Behavior |
|---|---|
| Sort toggle | Flips between "↑ Oldest first" and "↓ Newest first"; re-orders pins in DOM; state stored in `State.islandPinSortOrder[islandKey]` |
| Close All | Shows `Dialog.confirm("Close all plots for this island?")`. On confirm: clears `State.islandPinnedPlots[islandKey]`, removes container from DOM. |

### Container lifecycle:
- Created when the first pin is added to an island.
- Destroyed when the last pin is closed.
- Hidden if island has 0 pins.

### Height synchronization:
- `Islands.recompute()` calls `_updatePinContainerGeometry(islandKey)` for every island with a container.
- During island drag (`mousemove`), the container receives the same position delta as the island rect.

---

## Individual Pin (`.plot-pin`)

### Normal state structure:
```
.plot-pin
  .plot-pin-header
    span.plot-pin-title       (title text, truncated)
    button.plot-pin-color     ●  (color picker dot)
    button.plot-pin-minimize  –
    button.plot-pin-close     ×
  .plot-pin-body
    img.plot-pin-thumb        (320 × 240, src = dataUrl, cursor: pointer)
```

### Minimized state:
Collapses to a single narrow bar (~32px tall): small `[▣]` icon + truncated title. Full `.plot-pin-body` and header buttons are hidden. Clicking anywhere on the minimized bar restores to normal state.

### Pin interactions:

| Control | Behavior |
|---|---|
| Click thumbnail | Opens `#modal-plot` in view-only mode (no "Pin to Island" button) |
| Color picker `●` | Opens swatch popup (same palette/pattern as island color picker). Chosen color: sets `border: 3px solid <color>` on `.plot-pin`; updates dot fill. Reset option restores `border: 1px solid #ccc`. |
| Minimize `–` | Collapses pin to narrow bar |
| Close `×` | Removes pin from DOM and from `State.islandPinnedPlots[islandKey]` array |

### Sorting:
Each pin has a `data-created-at` attribute (Unix timestamp ms) used for DOM reordering when sort order changes.

---

## State

### New fields on the global `State` object:

```js
State.islandPinnedPlots  = {}  // { [islandKey]: [{ dataUrl, title, minimized, createdAt, borderColor }, ...] }
State.islandPinSortOrder = {}  // { [islandKey]: 'asc' | 'desc' }
```

### Persistence:
- Both fields included in `_buildSaveJson()` serialization.
- Restored in `applyContext()`: pin containers and thumbnails re-rendered from stored `dataUrl` values.
- `App.onIslandTransition()`: pins for island keys that no longer exist after a merge/split are dropped.

---

## CSS Summary

| Selector | Purpose |
|---|---|
| `.plot-pin-container` | Absolute positioned, left of island, white bg, border, box-shadow, z-index above islands, `overflow: hidden` |
| `.plot-pin-container-header` | Flex row, sort toggle left, close-all right, always visible (not scrolled) |
| `.plot-pin-scroll-area` | `overflow-y: auto`, fills remaining container height |
| `.plot-pin` | White bg, `border: 1px solid #ccc` default, rounded corners |
| `.plot-pin.colored` | `border: 3px solid <color>` (applied via inline style) |
| `.plot-pin-header` | Small flex bar, title truncated, buttons right-aligned |
| `.plot-pin-thumb` | 320 × 240, `display: block`, `cursor: pointer` |
| `.plot-pin.minimized` | Height ~32px, body hidden, single restore affordance |
| `#btn-plot-query` | Matches existing toolbar button styles |
| `#chk-plot-named` + label | Inline with button row |

---

## Files Modified / Created

| File | Change |
|---|---|
| `assets/js/plot.js` | **New** — `Plot` namespace: `Plot.draw(ctx, rows, colNames, title, options)` |
| `assets/js/app.js` | Add `runPlotQuery()`, extend `State`, `_buildSaveJson()`, `applyContext()`, `Modals.openPlot()`, `App.onIslandTransition()` |
| `assets/js/islands.js` | Add `Islands.pinPlot()`, `_updatePinContainerGeometry()`, container drag sync, pin DOM management |
| `index.php` | Add `#btn-plot-query`, `#chk-plot-named`, `#modal-plot` |
| `assets/css/app.css` | All new selectors listed above |
