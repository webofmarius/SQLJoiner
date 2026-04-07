# SQLForge — Feature: SQL Backdrop (Live Syntax Highlighting Behind Textareas)

---

## Overview

The backdrop technique makes any `<textarea>` appear syntax-highlighted while remaining fully editable. A `<pre>` element with colored SQL tokens is positioned precisely behind the textarea. The textarea's own text is made transparent so the colors show through, while the native caret, selection, and resize handle remain intact.

This is the same approach used by editors like CodeMirror v1 and several online code playgrounds — no external dependency, no contenteditable tricks.

---

## Files Involved

| File | Role |
|---|---|
| `assets/js/sql-backdrop.js` | `SqlBackdrop` module — attaches / detaches the backdrop |
| `assets/css/app.css` (section 17) | CSS for the wrapper, the backdrop `<pre>`, and the transparent textarea |
| `index.php` | `data-sql-backdrop` attributes on static textareas; script load tag |
| `assets/js/canvas.js` | Calls `SqlBackdrop.attach()` for dynamic subquery card textareas |
| `assets/js/config.js` | Calls `SqlBackdrop.attach()` for the expression-popup textarea |
| `assets/js/app.js` | Provides `_highlightSQL()` — the tokenizer used by the backdrop |

---

## How It Works

### DOM structure after attach

```
<div class="sql-bd-wrapper">          ← new wrapper (position: relative)
    <pre class="sql-bd-pre            ← backdrop (position: absolute, z-index: 0)
              sql-highlighted">
        ... colored HTML tokens ...
    </pre>
    <textarea class="sql-bd-active">  ← original textarea (z-index: 1,
        ...                                background: transparent,
    </textarea>                             color: transparent,
</div>                                      caret-color: normal)
```

### Style mirroring

Before making the textarea transparent, `_mirrorStyles()` copies from the textarea's computed style to the `<pre>`:

- `fontFamily`, `fontSize`, `lineHeight`, `letterSpacing`, `wordSpacing`, `tabSize`
- `padding` (so tokens align with the textarea characters exactly)
- `borderTopWidth` / `borderRightWidth` / `borderBottomWidth` / `borderLeftWidth` (transparent, to preserve box-model alignment without adding a visible second border)
- `backgroundColor` (so the `<pre>` blends with the textarea's original background)
- `borderRadius`

### Scroll sync

On every `scroll` event on the textarea, `pre.scrollTop` and `pre.scrollLeft` are updated to match. This keeps the visible token colors in sync when the content overflows.

### Resize handle support

For block-layout textareas (those with `resize: vertical`), a `ResizeObserver` watches the textarea and updates `wrapper.style.height` on every resize, keeping the absolute-positioned `<pre>` (which uses `height: 100%`) fully covering the textarea at all times.

For flex-layout textareas (e.g., those with `flex: 1` inside modals), the wrapper inherits the textarea's flex properties and the `<pre>` fills it naturally — no `ResizeObserver` needed.

### Coexistence with the existing "html" toggle

Many textareas already have a paired `<pre class="sql-highlighted hidden">` and an "html" checkbox that hides the textarea and shows the `<pre>`. This mechanism still works:

- When the toggle is checked, the textarea gets class `hidden`. The CSS rule `.sql-bd-wrapper:has(> textarea.hidden) { display: none }` hides the entire wrapper (backdrop included), leaving the existing toggle `<pre>` to display cleanly.
- When the toggle is unchecked, the wrapper reappears and the live backdrop is active again.

---

## Enabling / Disabling per Textarea

### Static textareas (defined in `index.php`)

**Enable** — add the `data-sql-backdrop` attribute:
```html
<textarea id="where-raw-input" rows="24" data-sql-backdrop></textarea>
```

**Disable** — remove the attribute:
```html
<textarea id="where-raw-input" rows="24"></textarea>
```

`SqlBackdrop.init()` runs automatically on `DOMContentLoaded` and attaches to every `textarea[data-sql-backdrop]` it finds.

### Dynamic textareas (created in JavaScript)

Call `attach` / `detach` directly after the element is in the DOM:

```javascript
// Enable
if (typeof SqlBackdrop !== 'undefined') SqlBackdrop.attach(myTextarea);

// Disable
if (typeof SqlBackdrop !== 'undefined') SqlBackdrop.detach(myTextarea);
```

---

## Textareas with Backdrop Enabled

| Textarea ID / selector | Location | Notes |
|---|---|---|
| `#where-raw-input` | Config panel — WHERE | SQL |
| `#groupby-raw-input` | Config panel — GROUP BY | SQL |
| `#having-raw-input` | Config panel — HAVING | SQL |
| `#orderby-raw-input` | Config panel — ORDER BY | SQL |
| `#select-raw-input` | Config panel — SELECT | SQL |
| `#custom-query-textarea` | Custom Query modal | SQL |
| `#import-query-textarea` | Import Query modal | SQL |
| `#sq-expand-textarea` | Subquery expand modal | SQL |
| `#sql-pretty-input` | SQL Preview modal | SQL, readonly |
| `#create-statement-output` | CREATE TABLE modal | SQL, readonly |
| `#calculus-math-input` | Calculus toolbox | Math expressions |
| `#calculus-history-textarea` | Calculus history popup | Readonly |
| `#context-input` | Context modal | JSON paste |
| `#value-editor-input` | Cell value editor modal | |
| `#about-content` | About modal | Readonly |
| `.subquery-textarea` (dynamic) | Subquery cards on canvas | SQL, attached in `canvas.js` |
| `.expr-popup-ta` (dynamic) | Expression edit popup | SQL, attached in `config.js` |

## Textareas WITHOUT Backdrop (intentionally excluded)

| Textarea ID | Reason |
|---|---|
| `#notes-textarea` | Free-form notes — plain text, no benefit |
| `#calculus-note-textarea` | Free-form notes — plain text, no benefit |

---

## SqlBackdrop API

```javascript
SqlBackdrop.attach(textareaElement)   // Enable backdrop on one textarea
SqlBackdrop.detach(textareaElement)   // Disable and fully restore textarea
SqlBackdrop.init()                    // Attach all textarea[data-sql-backdrop]
                                      // (called automatically on DOMContentLoaded)
```

`detach()` is fully reversible: the textarea is unwrapped, its inline styles are restored to their pre-attach values, and the wrapper + backdrop `<pre>` are removed from the DOM.

---

## Token Colors (inherited from `_highlightSQL` / `.sql-hl-*`)

| Token type | CSS class | Color |
|---|---|---|
| Keywords (`SELECT`, `FROM`, …) | `.sql-hl-keyword` | `#569cd6` (blue) |
| String literals | `.sql-hl-string` | `#ce9178` (orange-brown) |
| Numbers | `.sql-hl-number` | `#b5cea8` (light green) |
| Comments | `.sql-hl-comment` | `#6a9955` (green, italic) |
| Backtick identifiers | `.sql-hl-ident` | `#9cdcfe` (light blue) |
| Column references (`alias.col`) | `.sql-hl-colref` | `#ffffff` |
| Column aliases (after `AS`) | `.sql-hl-colalias` | `#dcdcaa` (yellow) |
| Table refs / aliases | inline `style="color:…"` | Rotating palette (8 colors) |

---

## Known Constraints

- **`:has()` CSS selector** is used to hide the wrapper when the textarea gets class `hidden`. Supported in Chrome 105+, Firefox 121+, Safari 15.4+. Since this is a developer tool, older browser support is not a concern.
- **Placeholder text** is not visible through the backdrop (the placeholder is rendered by the browser inside the transparent textarea and appears above the colored pre, so it is visible normally).
- **Non-SQL content** (e.g., the About textarea or the Context JSON textarea) will still display — the tokenizer produces plain (uncolored) output for text it does not recognize, so there is no visual breakage.
