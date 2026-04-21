/**
 * app.js — Application bootstrap and global state
 *
 * Responsibilities:
 *   - Owns the single source-of-truth state object
 *   - Bootstraps the app on DOMContentLoaded
 *   - Manages profile switching and table loading
 *   - Coordinates top-bar, bottom-bar, and modal events
 *   - Exposes App, Canvas, Results, Modals namespaces used by future phases
 *
 * Phases 3-8 will expand Canvas, Results, and Modals in their own JS files.
 * This file only contains what is needed for Phase 1.
 */

const APP_NAME    = document.querySelector('#app-name')?.textContent?.trim()    ?? 'SQL Joiner';
const APP_VERSION = document.querySelector('#app-version')?.textContent?.trim() ?? '';
const BASE_PAGE_TITLE = APP_VERSION ? `${APP_NAME} ${APP_VERSION}` : APP_NAME;

/* =============================================================================
   Global State
   The single source of truth. Serialising this object IS the "Copy Context".
   ============================================================================= */
const State = {
    activeProfileId: null,

    /** Currently selected database schema (null = use profile default). */
    activeDatabase: null,

    /** @type {Array<{id:string, name:string, alias:string, database:string|null, position:{x:number,y:number}, columns:Array}>} */
    tables: [],

    /** @type {Array<{id:string, fromTableId:string, fromCol:string, toTableId:string, toCol:string, type:string, extraConditions:Array<{fromCol:string,toCol:string}>}>} */
    joins: [],

    /** @type {string[]}  empty = SELECT *  */
    select: [],

    /** When true, zero columns are explicitly selected (SELECT would fail). Distinct from select:[] = SELECT * */
    selectNone: false,

    /** @type {Array<{id:string, expr:string, alias:string, enabled:boolean}>} custom SQL expressions appended to SELECT */
    selectCustomExprs: [],

    /** @type {'combined'|'only'|'exclude'} how custom expressions interact with SELECT columns */
    selectCustomExprsMode: 'exclude',

    /** @type {Object.<string,string>}  map of "alias.col" → SQL column alias */
    selectAliases: {},

    /** @type {Array<{mode:'visual'|'raw', col?:string, op?:string, val?:string, sql?:string}>} */
    where: [],

    /** @type {Array<{col:string, dir:'ASC'|'DESC'}>} */
    orderBy: [],

    /** @type {string[]}  array of alias.colname  */
    groupBy: [],

    /** @type {Array<{mode:'visual'|'raw', col?:string, op?:string, val?:string, sql?:string}>} */
    having: [],

    /** Appended verbatim when ORDER BY mode is raw */
    orderByRaw: '',

    /** Appended verbatim when GROUP BY mode is raw */
    groupByRaw: '',

    /** Verbatim raw HAVING clause — used when havingMode is 'raw' */
    havingRaw: '',

    /** Verbatim raw WHERE clause — used when whereMode is 'raw' */
    whereRaw: '',

    /** Verbatim raw SELECT clause — used when selectMode is 'raw' */
    selectRaw: '',

    /** When true, '|||' is injected between each table's columns in visual SELECT */
    selectAddDelimiter: false,

    /** When true, SELECT columns are sorted A→Z by column name in the query (UI order unchanged) */
    selectSortAlpha: false,

    /** When true, the query uses SELECT DISTINCT */
    selectDistinct: false,

    /** When true, result column headers include the table alias prefix (e.g. "u.id"). Default true = current behaviour */
    selectSchemaAlias: true,

    /** When true, a small origin label (db.table) is shown below each result column header */
    selectTableName: false,

    /** UI mode for each clause section ('visual' | 'raw') — persisted in context */
    selectMode:  'visual',
    whereMode:   'visual',
    orderByMode: 'visual',
    groupByMode: 'visual',
    havingMode:  'visual',

    limit: 10,
    /** Tracks the UI display order of all available columns across all tables. */
    columnOrder: [],

    /** Free-form notes saved with the context. */
    notes: '',

    /** When non-null, current context was loaded from Saved Contexts; top-bar save overwrites this id. */
    loadedContextId: null,
    /** Human-readable name of the loaded context, kept in sync with loadedContextId. */
    loadedContextName: null,

    /** Key of the currently selected island (sorted table IDs joined with '|').
     *  null = no selection (only relevant when 2+ islands exist). */
    selectedIslandKey: null,

    /** User-defined label for each island. Keys are island keys (sorted table IDs joined with '|'). */
    islandNames: {},

    /** User-defined background color for each island (hex string). Keys are island keys. */
    islandColors: {},

    /** Minimized state per island. Keys are island keys; value is true when minimized. */
    islandMinimized: {},

    /** Extended note per island, shown in the note popup (right-click / Alt+E on the island name). Keys are island keys. */
    islandNotesDetail: {},

    /** ID of the table most recently touched by the user (mousedown on a table card).
     *  Used to determine which island to activate after a join is deleted. */
    lastInteractedTableId: null,

    /** Per-island right-pane + Calculus + tableOrder configs (background RAM). */
    islandConfigs: {},

    /** Backdrop-textarea bookmarks. Shape: { [textareaId]: { [1-9]: charOffset } }
     *  Each textarea has its own independent set of 9 bookmark slots.
     *  Set with Alt+Shift+N, jump with Alt+N (only while that textarea is focused). */
    bookmarks: {},

    /** Whether scope mode was active in the Edit Subquery popup when it was last closed.
     *  Persisted with the context so it survives page reload. */
    sqExpandScopeMemory: false,

    /** Whether the syntax-highlight backdrop is enabled on the Run Custom Query textarea. */
    customQueryHighlight: false,

    /** Pinned plot images per island. { [islandKey]: [{ dataUrl, title, minimized, createdAt, borderColor }, ...] } */
    islandPinnedPlots: {},

    /** Sort order for each island's pin container. { [islandKey]: 'asc' | 'desc' } */
    islandPinSortOrder: {},
};

/* =============================================================================
   App — core controller
   ============================================================================= */
const App = (() => {

    // Reference to the subquery card textarea currently being edited in the expand popup
    let _sqExpandTarget = null;

    // JSON snapshot of the last saved/loaded context — used to detect unsaved changes.
    let _lastSavedJson = null;

    // Tracks whether results panel was already collapsed before overview zoom auto-collapsed it.
    let _zoomResultsWasCollapsed = false;

    function _applyOverviewZoom(on) {
        const resultsPanel = document.getElementById('results-panel');
        if (on) {
            _zoomResultsWasCollapsed = resultsPanel?.classList.contains('is-collapsed') ?? false;
            if (!_zoomResultsWasCollapsed) Results.toggle();
        } else {
            if (!_zoomResultsWasCollapsed && resultsPanel?.classList.contains('is-collapsed')) {
                Results.toggle();
            }
        }
        Canvas.setOverviewZoom(on);
        document.getElementById('btn-canvas-overview-zoom')?.classList.toggle('is-active', on);
    }

    // -------------------------------------------------------------------------
    // Initialise
    // -------------------------------------------------------------------------
    async function init() {
        // Profiles.loadAndRender() populates both the modal list and the top-bar select.
        // bindEvents() wires the modal form buttons (save / test / clear).
        await Profiles.loadAndRender();
        Profiles.bindEvents();

        _restoreLastProfile();
        bindTopbar();
        bindBottombar();
        bindModals();
        bindLimitSelect();
        _initPaneToggles();
        _bindTableSearch();
        _bindCanvasDrop();
        _bindKeyboardShortcuts();
        _initMaximizeButtons();

        document.getElementById('btn-add-subquery')
            .addEventListener('click', addSubqueryToCanvas);

        // Sidebar "L" button: load a .sql or .csv file into a new red subquery
        (() => {
            const btn       = document.getElementById('btn-load-file-to-subquery');
            const fileInput = document.createElement('input');
            fileInput.type   = 'file';
            fileInput.accept = '.sql,.csv,text/plain,text/csv';
            fileInput.style.display = 'none';
            document.body.appendChild(fileInput);
            btn.addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });
            fileInput.addEventListener('change', () => {
                const file = fileInput.files[0];
                if (file) _loadFileIntoNewSubquery(file, '#f47c7c');
            });
        })();

        document.getElementById('btn-import-query')
            .addEventListener('click', () => Modals.openImportQuery());

        _bindSqExpandModal();

        // Per-textarea undo/redo (survives popup close/reopen)
        if (typeof UndoManager !== 'undefined') {
            [
                'notes-textarea',
                'calculus-note-textarea',
                'sq-expand-textarea',
                'custom-query-textarea',
                'import-query-textarea',
                'where-raw-input',
                'groupby-raw-input',
                'having-raw-input',
                'orderby-raw-input',
                'select-raw-input',
            ].forEach(id => {
                const el = document.getElementById(id);
                if (el) UndoManager.attach(el);
            });
        }

        // Autocomplete for sidebar schema and table search inputs
        if (typeof Autocomplete !== 'undefined') {
            Autocomplete.attach(document.getElementById('db-schema-search'), {
                getSuggestions: () =>
                    Array.from(document.querySelectorAll('#db-select li[data-db]'))
                         .map(li => li.dataset.db),
                onSelect: db => {
                    document.querySelector(`#db-select li[data-db="${CSS.escape(db)}"]`)?.click();
                },
            });

            Autocomplete.attach(document.getElementById('table-search'), {
                getSuggestions: () =>
                    Array.from(document.querySelectorAll('#table-list li[data-table]'))
                         .map(li => li.dataset.table),
                onSelect: name => addTableToCanvas(name),
            });
        }

        // Close any open tables-menu dropdowns when clicking outside them
        document.addEventListener('click', () => {
            document.querySelectorAll('.tables-dropdown').forEach(d => d.classList.add('hidden'));
            document.querySelectorAll('.btn-tables-trigger').forEach(b => b.classList.remove('is-open'));
        });

        // Wire SqlBackdrop scope extraction → canvas subquery card
        // (must be set after sql-backdrop.js has loaded, i.e. inside DOMContentLoaded)
        if (typeof SqlBackdrop !== 'undefined') {
            SqlBackdrop.onExtractScope = (sql, alias) => _addExtractedSubquery(sql, alias);
            SqlBackdrop.checkAlias     = alias => State.tables.some(t => t.alias === alias);
        }

        // Capture the initial clean-slate baseline so dirty checks work from the start.
        // Use setTimeout so any non-awaited async init work (e.g. _activateProfile)
        // has settled before we snapshot, avoiding false "dirty" positives.
        setTimeout(() => { try { _lastSavedJson = _buildSaveJson(); } catch (_) {} }, 300);
    }

    /**
     * Scroll a backdrop textarea so that the bookmarked char offset is vertically
     * centred in the visible area, then sync the backdrop layers.
     */
    function _jumpToBackdropBookmark(ta, charOffset) {
        const safeOffset = Math.min(charOffset, ta.value.length);
        const cs         = getComputedStyle(ta);
        const lineHeight = parseFloat(cs.lineHeight) || Math.round(parseFloat(cs.fontSize) * 1.5);
        const paddingTop = parseFloat(cs.paddingTop);
        const lineIndex  = ta.value.substring(0, safeOffset).split('\n').length - 1;
        const lineTop    = paddingTop + lineIndex * lineHeight;
        ta.scrollTop     = Math.max(0, lineTop - ta.clientHeight / 2 + lineHeight / 2);
        // The scroll event fires automatically and syncs the backdrop layers.
    }

    /**
     * Bind global keyboard shortcuts.
     *   - Cmd+Enter (Mac) or Ctrl+Enter (Win/Linux) -> Run Query
     *   - Alt+E -> Run EXPLAIN on current query
     *   - Alt+1 -> Toggle Sidebar
     *   - Alt+2 -> Toggle Results Panel
     *   - Alt+3 -> Toggle Config Panel
     */
    function _toggleMaximizePopup(boxEl) {
        const btn = boxEl.querySelector('.btn-popup-maximize');
        if (boxEl.dataset.maximized === '1') {
            const prev = JSON.parse(boxEl.dataset.prevMaxSize || '{}');
            boxEl.style.width        = prev.width        ?? '';
            boxEl.style.height       = prev.height       ?? '';
            boxEl.style.top          = prev.top          ?? '';
            boxEl.style.left         = prev.left         ?? '';
            boxEl.style.transform    = prev.transform    ?? '';
            boxEl.style.resize       = prev.resize       ?? '';
            boxEl.style.maxWidth     = prev.maxWidth     ?? '';
            boxEl.style.maxHeight    = prev.maxHeight    ?? '';
            boxEl.style.borderRadius = prev.borderRadius ?? '';
            delete boxEl.dataset.maximized;
            delete boxEl.dataset.prevMaxSize;
            if (btn) { btn.textContent = '⤢'; btn.title = 'Maximize'; }
        } else {
            boxEl.dataset.prevMaxSize = JSON.stringify({
                width:        boxEl.style.width,
                height:       boxEl.style.height,
                top:          boxEl.style.top,
                left:         boxEl.style.left,
                transform:    boxEl.style.transform,
                resize:       boxEl.style.resize,
                maxWidth:     boxEl.style.maxWidth,
                maxHeight:    boxEl.style.maxHeight,
                borderRadius: boxEl.style.borderRadius,
            });
            boxEl.style.top          = '0';
            boxEl.style.left         = '0';
            boxEl.style.transform    = 'none';
            boxEl.style.width        = '100vw';
            boxEl.style.height       = '100vh';
            boxEl.style.maxWidth     = 'none';
            boxEl.style.maxHeight    = 'none';
            boxEl.style.borderRadius = '0';
            boxEl.style.resize       = 'none';
            boxEl.dataset.maximized  = '1';
            if (btn) { btn.textContent = '⊡'; btn.title = 'Restore size'; }
        }
    }

    function _initMaximizeButtons() {
        document.querySelectorAll('.modal-header').forEach(header => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-popup-maximize';
            btn.textContent = '⤢';
            btn.title = 'Maximize';
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const boxEl = header.closest('.modal-box');
                if (boxEl) _toggleMaximizePopup(boxEl);
            });
            const closeBtn = header.querySelector('.modal-close, [aria-label="Close"]');
            if (closeBtn) header.insertBefore(btn, closeBtn);
            else header.appendChild(btn);
        });
    }

    function _bindKeyboardShortcuts() {
        // Tab / Shift+Tab in any textarea — IDE-style indent/unindent
        document.addEventListener('keydown', e => {
            if (e.key !== 'Tab' || e.target.tagName !== 'TEXTAREA') return;
            e.preventDefault();
            const ta    = e.target;
            const value = ta.value;
            const start = ta.selectionStart;
            const end   = ta.selectionEnd;

            if (start === end) {
                // No selection: Tab inserts a tab; Shift+Tab unindents current line
                if (!e.shiftKey) {
                    ta.value = value.substring(0, start) + '\t' + value.substring(end);
                    ta.selectionStart = ta.selectionEnd = start + 1;
                } else {
                    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
                    const lineHead  = value.substring(lineStart, start);
                    const m         = lineHead.match(/^(\t| {1,4})/);
                    if (m) {
                        ta.value = value.substring(0, lineStart) + value.substring(lineStart + m[0].length);
                        ta.selectionStart = ta.selectionEnd = start - m[0].length;
                    }
                }
            } else {
                // Selection exists: indent or unindent every touched line
                const lineStart = value.lastIndexOf('\n', start - 1) + 1;
                const chunk     = value.substring(lineStart, end);
                const before    = value.substring(0, lineStart);
                const after     = value.substring(end);

                if (!e.shiftKey) {
                    // Indent: prepend a tab to every line in chunk
                    const indented  = chunk.replace(/^/gm, '\t');
                    const lineCount = (chunk.match(/\n/g) || []).length + 1;
                    ta.value = before + indented + after;
                    ta.selectionStart = start + 1;       // one tab added before cursor
                    ta.selectionEnd   = end + lineCount; // one tab added per line
                } else {
                    // Unindent: strip one leading tab (or up to 4 spaces) per line
                    let removedBeforeStart = 0;
                    let totalRemoved       = 0;
                    let firstLine          = true;
                    const unindented = chunk.replace(/^(\t| {1,4})/gm, (m) => {
                        if (firstLine) { removedBeforeStart = m.length; firstLine = false; }
                        totalRemoved += m.length;
                        return '';
                    });
                    ta.value = before + unindented + after;
                    ta.selectionStart = Math.max(lineStart, start - removedBeforeStart);
                    ta.selectionEnd   = end - totalRemoved;
                }
            }

            ta.dispatchEvent(new Event('input', { bubbles: true }));
        }, true); // capture phase so it fires before any stopPropagation

        // ── macOS dead-key fix ────────────────────────────────────────────────
        // On macOS, Option+key (e.g. Option+E → "´") stages a dead-key in the
        // OS IME.  When the shortcut then moves focus to another input the OS
        // flushes the staged character into that element.  Neither a
        // capture-phase keydown preventDefault() nor beforeinput preventDefault()
        // stop this in Chrome on macOS (Chrome ignores preventDefault during
        // IME composition).
        //
        // Solution: let the character land, then strip it in the `input` handler
        // by recognising the exact dead-key characters macOS Option+letter
        // produces (´ ` ˆ ˜ ¨ ˙ ˚ ¸ ˛ ˝).  We only act when an Alt shortcut
        // was the last keydown, so normal typing is never affected.
        let _altDeadKeyPending = false;
        let _strippingDeadKey  = false;
        // Known dead-key characters produced by macOS Option+letter combos
        const _DEAD_KEY_CHARS  = new Set(['\u00b4','\u0060','\u02c6','\u02dc',
                                          '\u00a8','\u02d9','\u02da','\u00b8',
                                          '\u02db','\u02dd']);
        window.addEventListener('keydown', e => {
            if (!e.altKey || e.metaKey || e.ctrlKey) return;
            if (/^(Key[A-Z]|Digit[1-9]|Numpad[1-9])$/.test(e.code)) {
                e.preventDefault();
                _altDeadKeyPending = true;
                setTimeout(() => { _altDeadKeyPending = false; }, 600);
            }
        }, { capture: true });
        document.addEventListener('input', e => {
            if (_strippingDeadKey || !_altDeadKeyPending) return;
            const el = e.target;
            if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return;
            if (e.inputType !== 'insertText' && e.inputType !== 'insertCompositionText') return;
            const ch = e.data;
            if (!ch || !_DEAD_KEY_CHARS.has(ch)) return;
            // Dead-key character confirmed — strip it and sync the backdrop
            _altDeadKeyPending = false;
            _strippingDeadKey  = true;
            const pos  = el.selectionStart;
            el.value   = el.value.slice(0, pos - ch.length) + el.value.slice(pos);
            el.setSelectionRange(pos - ch.length, pos - ch.length);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            _strippingDeadKey = false;
        }, { capture: true });

        window.addEventListener('keydown', async e => {
            const isEnter = e.key === 'Enter';
            const isMod   = e.metaKey || e.ctrlKey;
            const isAlt   = e.altKey;

            // ESC — close the topmost visible modal (highest z-index wins)
            if (e.key === 'Escape') {
                const visible = [...document.querySelectorAll('.modal:not(.hidden)')];
                if (visible.length) {
                    e.preventDefault();
                    const top = visible.reduce((best, el) => {
                        const z = parseInt(getComputedStyle(el).zIndex, 10) || 0;
                        const zBest = parseInt(getComputedStyle(best).zIndex, 10) || 0;
                        return z >= zBest ? el : best;
                    });
                    if (top.id === 'modal-notes')      { Modals.closeNotes(); }
                    else if (top.id === 'modal-sq-expand') { _sqExpandSyncAndClose(); }
                    else { top.classList.add('hidden'); }
                }
                return;
            }

            // Arrow keys — navigate pinned plot viewer
            if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
                !document.getElementById('modal-plot').classList.contains('hidden') &&
                Modals._plotNavList) {
                e.preventDefault();
                Modals._navigatePlot(e.key === 'ArrowLeft' ? -1 : 1);
                return;
            }

            // Run Query: Cmd+Enter / Ctrl+Enter
            if (isEnter && isMod) {
                e.preventDefault();
                runQuery();
                return;
            }

            // F1 — Focus canvas table search (same as Alt+F; prevents browser help)
            if (e.code === 'F1' && !isMod) {
                e.preventDefault();
                const searchInput = document.getElementById('canvas-search-input');
                if (searchInput) { searchInput.focus(); searchInput.select(); }
                return;
            }

            // F3 — Timestamp converter
            if (e.code === 'F3' && !isMod) {
                e.preventDefault();
                document.getElementById('btn-timestamp-conv').click();
                return;
            }

            // F4 — Toggle overview zoom (auto-minimizes results panel while zoomed out)
            if (e.code === 'F4' && !isMod) {
                e.preventDefault();
                const on = !document.body.classList.contains('is-canvas-overview-zoom');
                _applyOverviewZoom(on);
                return;
            }

            // F5 — Focus mode: hide all panels / restore previous visibility
            if (e.code === 'F5' && !isMod) {
                e.preventDefault();
                _toggleFocusMode();
                return;
            }

            // F7 — Toggle results panel minimize / restore
            if (e.code === 'F7' && !isMod) {
                e.preventDefault();
                Results.toggle?.();
                return;
            }

            // F8 — Toggle results panel fullscreen (maximize)
            if (e.code === 'F8' && !isMod) {
                e.preventDefault();
                Results.toggleFullscreen?.();
                return;
            }

            // F9 — Toggle config (right) panel show / hide
            if (e.code === 'F9' && !isMod) {
                e.preventDefault();
                _togglePane('config');
                return;
            }

            // Run Custom Query popup: Cmd/Ctrl+F9
            // — opens the popup if closed, runs the query if already open
            if (isMod && e.code === 'F9') {
                e.preventDefault();
                const modal = document.getElementById('modal-custom-query');
                if (modal.classList.contains('hidden')) {
                    document.getElementById('btn-run-custom-query').click();
                } else {
                    _runCustomQuery();
                }
                return;
            }

            // Explain custom query: Cmd/Ctrl+F8 — only when popup is open
            if (isMod && e.code === 'F8') {
                const modal = document.getElementById('modal-custom-query');
                if (!modal.classList.contains('hidden')) {
                    e.preventDefault();
                    document.getElementById('btn-custom-query-explain').click();
                }
                return;
            }

            // Explain query: Cmd/Ctrl+e
            if (isMod && e.code === 'KeyE') {
                e.preventDefault();
                runExplainQuery();
            }

            // Plot query: Cmd/Ctrl+P (prevent browser print dialog)
            if (isMod && e.code === 'KeyP') {
                e.preventDefault();
                runPlotQuery();
            }

            // AI Knowledge: Cmd/Ctrl+K
            if (isMod && e.code === 'KeyK') {
                e.preventDefault();
                runAiKnowledge();
                return;
            }

            // Pane toggles: Alt + 1/2/3
            if (isAlt) {
                // ── Backdrop-textarea bookmark shortcuts ─────────────────────
                // When a backdrop textarea is focused, Alt+Shift+{1-9} sets a
                // bookmark and Alt+{1-9} jumps to one.  Either way the pane
                // toggles are suppressed so the user never accidentally hides a
                // panel while editing SQL.
                const _bdEl = document.activeElement;
                if (_bdEl?.classList.contains('sql-bd-active') && _bdEl.id) {
                    const _dm = e.code.match(/^(?:Digit|Numpad)([1-9])$/);
                    if (_dm) {
                        e.preventDefault();
                        const num = parseInt(_dm[1], 10);
                        if (e.shiftKey) {
                            // Alt+Shift+N → set bookmark at current cursor position
                            if (!State.bookmarks[_bdEl.id]) State.bookmarks[_bdEl.id] = {};
                            State.bookmarks[_bdEl.id][num] = _bdEl.selectionStart;
                            if (typeof SqlBackdrop !== 'undefined') SqlBackdrop.refreshBookmarks(_bdEl);
                        } else {
                            // Alt+N → jump to bookmark (if set); no-op if not set
                            const off = State.bookmarks[_bdEl.id]?.[num];
                            if (off !== undefined) _jumpToBackdropBookmark(_bdEl, off);
                        }
                        return;
                    }
                }
                // ─────────────────────────────────────────────────────────────

                if (e.code === 'Digit1' || e.code === 'Numpad1') {
                    e.preventDefault();
                    _togglePane('sidebar');

                } else if (e.code === 'Digit2' || e.code === 'Numpad2') {
                    e.preventDefault();
                    Results.toggle();

                } else if (e.code === 'Digit3' || e.code === 'Numpad3') {
                    e.preventDefault();
                    _togglePane('config');

                } else if (e.code === 'KeyF') {
                    e.preventDefault();
                    const searchInput = document.getElementById('canvas-search-input');
                    if (searchInput) { searchInput.focus(); searchInput.select(); }

                } else if (e.code === 'KeyN') {
                    e.preventDefault();
                    const notesModal = document.getElementById('modal-notes');
                    if (notesModal.classList.contains('hidden')) {
                        Modals.openNotes();
                    } else {
                        Modals.closeNotes();
                    }

                } else if (e.code === 'KeyD') {
                    e.preventDefault();
                    document.getElementById('btn-toggle-dim')?.click();

                } else if (e.code === 'KeyV') {
                    e.preventDefault();
                    document.getElementById('btn-duplicates')?.click();

                } else if (e.code === 'KeyK') {
                    e.preventDefault();
                    Results.calcNoteToggle();

                } else if (e.code === 'KeyX' || e.code === 'KeyU') {
                    e.preventDefault();
                    Results.calcToggle();

                } else if (e.code === 'KeyM') {
                    e.preventDefault();
                    document.getElementById('btn-calculus-math')?.click();

                } else if (e.code === 'KeyT') {
                    e.preventDefault();
                    const mathPopup = document.getElementById('calculus-math-popup');
                    if (mathPopup && !mathPopup.classList.contains('hidden')) {
                        document.getElementById('btn-calculus-math-maximize')?.click();
                    } else {
                        const exprPopupEl   = document.querySelector('.expr-popup');
                        const exprVisible   = exprPopupEl && exprPopupEl.style.display === 'flex';
                        const visibleModals = [...document.querySelectorAll('.modal:not(.hidden)')];
                        if (exprVisible) {
                            _toggleMaximizePopup(exprPopupEl);
                        } else if (visibleModals.length > 0) {
                            const boxEl = visibleModals[visibleModals.length - 1].querySelector('.modal-box');
                            if (boxEl) _toggleMaximizePopup(boxEl);
                        } else {
                            document.getElementById('btn-results-fullscreen')?.click();
                        }
                    }

                } else if (e.code === 'KeyG') {
                    e.preventDefault();
                    const colSearch = document.getElementById('select-col-search');
                    if (colSearch) { colSearch.focus(); colSearch.select(); }

                } else if (e.code === 'KeyE') {
                    e.preventDefault();
                    const ae = document.activeElement;
                    if (ae && ae.classList.contains('subquery-textarea')) {
                        openSqExpand(ae);
                    } else {
                        const tableSearch = document.getElementById('table-search');
                        if (tableSearch) { tableSearch.focus(); tableSearch.select(); }
                    }

                } else if (e.code === 'KeyI') {
                    e.preventDefault();
                    document.getElementById('btn-import-query').click();

                } else if (e.code === 'KeyO') {
                    e.preventDefault();
                    Modals.openContext();

                } else if (e.code === 'KeyY') {
                    e.preventDefault();
                    const sqlModal = document.getElementById('modal-sql');
                    if (sqlModal.classList.contains('hidden')) {
                        Modals.openSqlPreview();
                    } else {
                        sqlModal.classList.add('hidden');
                    }

                } else if (e.code === 'KeyS') {
                    e.preventDefault();
                    addSubqueryToCanvas();

                } else if (e.code === 'KeyA') {
                    e.preventDefault();

                    const prevFocused   = document.activeElement;
                    const shouldRestore = prevFocused &&
                        (prevFocused.tagName === 'INPUT' || prevFocused.tagName === 'TEXTAREA');

                    const input = await Dialog.prompt('Add table to canvas\n\nFormat: schema.table');
                    if (!input || !input.trim()) {
                        if (shouldRestore) prevFocused.focus();
                        return;
                    }

                    const trimmed = input.trim().replace(/`/g, '');
                    const match   = trimmed.match(/^([\w$]+)\.([\w$]+)$/);
                    if (!match) {
                        _notify('Invalid format. Expected: schema.table or `schema`.`table`', 'error');
                        if (shouldRestore) prevFocused.focus();
                        return;
                    }

                    const [, schema, table] = match;
                    const tablesBefore = State.tables.length;
                    addTableToCanvas(table, null, schema, true)
                        .then(() => {
                            if (State.tables.length > tablesBefore) {
                                const newTable = State.tables[State.tables.length - 1];
                                if (!State.islandColors) State.islandColors = {};
                                State.islandColors[newTable.id] = '#f0d060'; // yellow
                                if (typeof Islands !== 'undefined') Islands.recompute();
                            }
                            if (shouldRestore) prevFocused.focus();
                        })
                        .catch(() => {
                            if (shouldRestore) prevFocused.focus();
                        });

                }
            }
        });
    }

    /** Restores the last-used profile from localStorage after the select is populated. */
    function _restoreLastProfile() {
        const lastId = localStorage.getItem('activeProfileId');
        if (!lastId) return;
        const sel = document.getElementById('profile-select');
        sel.value = lastId;
        if (sel.value === lastId) {
            _activateProfile(lastId); // async, intentionally not awaited
        }
    }

    // -------------------------------------------------------------------------
    // Profiles — delegated to profiles.js
    // -------------------------------------------------------------------------

    /**
     * Re-fetches and re-renders the profile list + select.
     * Kept here so external callers (e.g. after context load) can refresh.
     */
    async function loadProfiles() {
        await Profiles.loadAndRender();
    }

    async function _activateProfile(profileId) {
        State.activeProfileId = profileId;
        localStorage.setItem('activeProfileId', profileId);
        await loadDatabases();
    }

    /**
     * Fetch the list of non-system databases for the active profile,
     * populate #db-select, set State.activeDatabase, then load tables.
     */
    /** Highlight the currently-active schema in #db-select based on State.activeDatabase. */
    function _markActiveDb() {
        document.querySelectorAll('#db-select li[data-db]').forEach(li => {
            li.classList.toggle('db-active', li.dataset.db === State.activeDatabase);
        });
    }

    /** Build a single <li> for #db-select and attach its click handler. */
    function _createDbListItem(db) {
        const li       = document.createElement('li');
        li.dataset.db  = db;
        li.textContent = db;
        li.title       = db;
        li.addEventListener('click', async () => {
            if (State.activeDatabase === db) return;   // already active
            State.activeDatabase = db;
            _markActiveDb();
            await loadTables();
        });
        return li;
    }

    /** Filter #db-select list items by the text in #db-schema-search (case-insensitive). */
    function _filterDbSelect() {
        const term = (document.getElementById('db-schema-search')?.value ?? '').trim().toLowerCase();
        document.querySelectorAll('#db-select li[data-db]').forEach(li => {
            li.classList.toggle('hidden', term !== '' && !li.textContent.toLowerCase().includes(term));
        });
    }

    async function loadDatabases() {
        if (!State.activeProfileId) return;

        const list = document.getElementById('db-select');
        list.innerHTML = '<li class="sidebar-hint">Loading…</li>';

        // Clear the schema search so all freshly-loaded items are visible
        const schemaSearch = document.getElementById('db-schema-search');
        if (schemaSearch) schemaSearch.value = '';

        try {
            const dbs = await API.schema.databases(State.activeProfileId);

            list.innerHTML = '';
            if (dbs.length === 0) {
                list.innerHTML = '<li class="sidebar-hint">No schemas found</li>';
                return;
            }

            dbs.forEach(db => list.appendChild(_createDbListItem(db)));

            // Keep the previously selected database if it's still in the list,
            // otherwise default to the first one.
            if (!State.activeDatabase || !dbs.includes(State.activeDatabase)) {
                State.activeDatabase = dbs[0];
            }

            _markActiveDb();
            await loadTables();

        } catch {
            list.innerHTML = '<li class="sidebar-hint">Schemas unavailable</li>';
            // Fall back to loading tables from the profile's default database
            await loadTables();
        }
    }

    async function loadTables() {
        if (!State.activeProfileId) return;
        try {
            const tables = await API.schema.tables(State.activeProfileId, State.activeDatabase || '');
            _renderTableList(tables);
        } catch (e) {
            _notify('Failed to load tables: ' + e.message, 'error');
        }
    }

    function _fmtRows(n) {
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
        return String(n);
    }

    function _renderTableList(tables) {
        const list = document.getElementById('table-list');
        list.innerHTML = '';

        // Clear the search so stale filters don't hide the new list
        const searchEl = document.getElementById('table-search');
        if (searchEl) searchEl.value = '';

        if (!tables || tables.length === 0) {
            list.innerHTML = '<li class="sidebar-hint">No tables found in this database.</li>';
            return;
        }

        // Hide the canvas hint once we have tables
        document.getElementById('canvas-hint').style.display = 'none';

        const activeDb = State.activeDatabase || '';

        tables.forEach(({ name, rows }) => {
            const li = document.createElement('li');
            li.dataset.table    = name;
            li.dataset.database = activeDb;
            li.title            = 'Double-click or drag to add to canvas';
            li.draggable        = true;
            li.classList.add('dbl-click-hint');

            li.addEventListener('dragstart', e => {
                e.dataTransfer.setData('text/sidebar-table', name);
                e.dataTransfer.effectAllowed = 'copy';
            });

            const nameSpan = document.createElement('span');
            nameSpan.className   = 'tl-name';
            nameSpan.textContent = name;

            const countSpan = document.createElement('span');
            countSpan.className   = 'tl-rows';
            countSpan.textContent = _fmtRows(rows);

            const copyBtn = document.createElement('button');
            copyBtn.className   = 'tl-copy-btn';
            copyBtn.textContent = '⎘';
            copyBtn.title       = 'Copy table name to clipboard';
            copyBtn.addEventListener('click', e => {
                e.stopPropagation();
                const fullName = activeDb ? `${activeDb}.${name}` : name;
                navigator.clipboard.writeText(fullName).then(() => {
                    copyBtn.textContent = '✓';
                    setTimeout(() => { copyBtn.textContent = '⎘'; }, 1200);
                });
            });

            li.append(nameSpan, copyBtn, countSpan);

            // Mark already-on-canvas tables (match by name AND database)
            if (State.tables.find(t => t.name === name && (t.database || '') === activeDb)) {
                li.classList.add('on-canvas');
            }

            li.addEventListener('dblclick', () => {
                addTableToCanvas(name, null, null, true);
            });
            list.appendChild(li);
        });

        _refilterSidebar();
    }

    function _bindCanvasDrop() {
        const canvasWrapper = document.getElementById('canvas-wrapper');

        // Overlay shown while dragging a file over the canvas
        const canvasFileOverlay = document.createElement('div');
        canvasFileOverlay.className = 'canvas-file-drop-overlay';
        canvasFileOverlay.textContent = 'Drop .sql or .csv to create a new sub-query';
        document.body.appendChild(canvasFileOverlay);

        const _isFileDrag = dt => dt?.types?.includes('Files');

        canvasWrapper.addEventListener('dragover', e => {
            if (e.dataTransfer.types.includes('text/sidebar-table')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            } else if (_isFileDrag(e.dataTransfer)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            }
        });

        canvasWrapper.addEventListener('dragenter', e => {
            if (!_isFileDrag(e.dataTransfer)) return;
            // Only show when entering canvas from outside (not when moving between children)
            if (!e.relatedTarget || !canvasWrapper.contains(e.relatedTarget)) {
                const rect = canvasWrapper.getBoundingClientRect();
                canvasFileOverlay.style.left   = rect.left   + 'px';
                canvasFileOverlay.style.top    = rect.top    + 'px';
                canvasFileOverlay.style.width  = rect.width  + 'px';
                canvasFileOverlay.style.height = rect.height + 'px';
                canvasFileOverlay.classList.add('visible');
            }
        });

        canvasWrapper.addEventListener('dragleave', e => {
            // Only hide when leaving canvas entirely
            if (!e.relatedTarget || !canvasWrapper.contains(e.relatedTarget)) {
                canvasFileOverlay.classList.remove('visible');
            }
        });

        canvasWrapper.addEventListener('drop', e => {
            const tableName = e.dataTransfer.getData('text/sidebar-table');
            if (tableName) {
                e.preventDefault();
                const rect = canvasWrapper.getBoundingClientRect();
                const z = (typeof Canvas !== 'undefined' && Canvas.getContentScale)
                    ? Canvas.getContentScale()
                    : 1;
                const position = {
                    x: Math.round((e.clientX - rect.left + canvasWrapper.scrollLeft) / z),
                    y: Math.round((e.clientY - rect.top  + canvasWrapper.scrollTop) / z),
                };
                addTableToCanvas(tableName, position, null, true);
                return;
            }
            // File drop → create new subquery with red island color
            canvasFileOverlay.classList.remove('visible');
            const file = [...(e.dataTransfer.files || [])].find(f => {
                const n = f.name.toLowerCase();
                return n.endsWith('.sql') || n.endsWith('.csv') || f.type.startsWith('text/');
            });
            if (file) {
                e.preventDefault();
                _loadFileIntoNewSubquery(file, '#f47c7c');
            }
        });
    }

    let _filterCanvas = false;

    function _refilterSidebar() {
        const term = document.getElementById('table-search').value.trim().toLowerCase();
        const list = document.getElementById('table-list');
        let visible = 0;

        list.querySelectorAll('li[data-table]').forEach(li => {
            const matchSearch  = !term || li.dataset.table.toLowerCase().includes(term);
            const matchCanvas  = !_filterCanvas || li.classList.contains('on-canvas');
            const show = matchSearch && matchCanvas;
            li.style.display = show ? '' : 'none';
            if (show) visible++;
        });

        let noMatch = list.querySelector('.search-no-match');
        if (visible === 0 && (term !== '' || _filterCanvas)) {
            if (!noMatch) {
                noMatch = document.createElement('li');
                noMatch.className = 'sidebar-hint search-no-match';
                list.appendChild(noMatch);
            }
            noMatch.textContent = term
                ? `No tables matching "${document.getElementById('table-search').value.trim()}"`
                : 'No canvas tables match the filter.';
        } else if (noMatch) {
            noMatch.remove();
        }
    }

    function _bindTableSearch() {
        document.getElementById('table-search').addEventListener('input', _refilterSidebar);

        const btn = document.getElementById('btn-filter-canvas');
        btn.addEventListener('click', () => {
            _filterCanvas = !_filterCanvas;
            btn.classList.toggle('is-active', _filterCanvas);
            _refilterSidebar();
        });

        // Sidebar actions menu
        const _sidebarMenu = document.getElementById('sidebar-menu');
        document.getElementById('btn-sidebar-menu').addEventListener('click', e => {
            e.stopPropagation();
            _sidebarMenu.classList.toggle('is-open');
        });
        document.addEventListener('click', () => _sidebarMenu.classList.remove('is-open'));

        document.getElementById('sidebar-menu-select').addEventListener('click', () => {
            _sidebarMenu.classList.remove('is-open');
            if (!State.tables.length) { _notify('No tables on canvas.', 'warn'); return; }
            const sql = [...State.tables]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(t => {
                    const ref = t.database ? `\`${t.database}\`.\`${t.name}\`` : `\`${t.name}\``;
                    return `SELECT * FROM ${ref} LIMIT 10;`;
                })
                .join('\n');
            navigator.clipboard.writeText(sql)
                .then(() => _notify('SELECT queries copied to clipboard.', 'success'))
                .catch(() => _notify('Clipboard write failed.', 'error'));
        });

        document.getElementById('sidebar-menu-raw').addEventListener('click', () => {
            _sidebarMenu.classList.remove('is-open');
            if (!State.tables.length) { _notify('No tables on canvas.', 'warn'); return; }
            const text = [...State.tables]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(t => t.name)
                .join('\n');
            navigator.clipboard.writeText(text)
                .then(() => _notify('Table names copied to clipboard.', 'success'))
                .catch(() => _notify('Clipboard write failed.', 'error'));
        });
    }

    async function addTableToCanvas(tableName, position = null, overrideDb = null, allowDuplicate = false) {
        if (!State.activeProfileId) return;

        const activeDb = overrideDb !== null ? overrideDb : (State.activeDatabase || '');

        // Prevent duplicates (same table name AND same database)
        if (!allowDuplicate && State.tables.find(t => t.name === tableName && (t.database || '') === activeDb)) {
            _notify(`"${tableName}" is already on the canvas.`, 'warn');
            return;
        }

        try {
            const columns = await API.schema.columns(State.activeProfileId, tableName, activeDb);

            const tableId = 't_' + Date.now();
            const alias   = _generateAlias(tableName);

            // Capture whether this is the very first table before pushing
            const isFirstTable = State.tables.length === 0;

            const tableData = {
                id: tableId,
                name: tableName,
                alias,
                database: activeDb || null,
                position, // if null, canvas will compute a non-overlapping position
                columns,
                order: State.tables.length + 1, // join chain position; 1 = FROM table
            };
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            State.tables.push(tableData);
            _updateCanvasCount();

            // Update column order with new columns
            columns.forEach(c => {
                const key = `${alias}.${c.name}`;
                if (!State.columnOrder.includes(key)) {
                    State.columnOrder.push(key);
                }
            });

            // Mark as on-canvas in sidebar (match by name + database)
            const li = document.querySelector(
                `#table-list li[data-table="${tableName}"][data-database="${activeDb}"]`
            );
            if (li) li.classList.add('on-canvas');

            Canvas.renderTable(tableData);
            if (typeof Islands !== 'undefined') Islands.recompute();

            if (isFirstTable) {
                // First table on canvas: auto-select its island and initialise all
                // columns as selected. We set the key directly (without a flush) so
                // _initIslandConfig gets a clean slate instead of an empty stored config.
                State.selectedIslandKey = tableId;
                blitIslandConfig(tableId); // _initIslandConfig → all cols + refresh + preview
            } else {
                // Subsequent tables: leave the new island unselected (config created
                // lazily on first click). Only refresh the currently active island's UI.
                if (typeof QueryPanel !== 'undefined') QueryPanel.refresh();
                updateSQLPreview();
            }

            // Fetch approximate row count asynchronously — non-blocking, best-effort
            API.schema.rowCounts(State.activeProfileId, [tableName], activeDb)
                .then(counts => {
                    if (counts[tableName] !== undefined) {
                        Canvas.updateRowCount(tableId, counts[tableName]);
                    }
                })
                .catch(() => { /* row count is cosmetic — silently ignore failures */ });

        } catch (e) {
            _notify('Failed to load columns for "' + tableName + '": ' + e.message, 'error');
        }
    }

    // -------------------------------------------------------------------------
    // Subquery table — add a virtual canvas table backed by a hand-written SQL
    // subquery instead of a real schema table.
    // -------------------------------------------------------------------------
    function addSubqueryToCanvas() {
        // Generate a unique name like sq1, sq2, … that passes the \w+ validation
        const inUseNames = State.tables.map(t => t.name);
        let sqNum = 1;
        while (inUseNames.includes('sq' + sqNum)) sqNum++;
        const sqName  = 'sq' + sqNum;
        const alias   = _generateAlias(sqName);
        const tableId = 't_' + Date.now();

        const tableData = {
            id:         tableId,
            name:       sqName,
            alias,
            database:   null,
            position:   null,    // canvas will auto-place
            columns:    [],      // virtual columns added by the user on the card
            order:      State.tables.length + 1,
            isSubquery: true,
            subquery:   '',
        };

        State.tables.push(tableData);
        _updateCanvasCount();

        Canvas.renderTable(tableData);
        if (typeof Islands !== 'undefined') {
            Islands.recompute();
            Islands.selectIsland(tableId);  // activate the new card's island
        } else {
            if (typeof QueryPanel !== 'undefined') QueryPanel.refresh();
            updateSQLPreview();
        }
        setTimeout(() => {
            document.querySelector(`.table-card[data-table-id="${tableId}"] .subquery-textarea`)?.focus();
        }, 0);
    }

    // -------------------------------------------------------------------------
    // Add a subquery canvas card pre-filled with arbitrary SQL and focus it.
    // Used by the "Bind vars" button when the clone checkbox is checked.
    // -------------------------------------------------------------------------
    function addSubqueryWithSql(sql, parentAlias, color = '#f0d060') {
        const inUseNames = State.tables.map(t => t.name);
        let sqNum = 1;
        while (inUseNames.includes('sq' + sqNum)) sqNum++;
        const sqName = 'sq' + sqNum;

        // When called from a clone operation, derive alias as parentAlias_N
        // where N is one more than the highest existing suffix.
        let alias;
        if (parentAlias) {
            const inUseAliases = State.tables.map(t => t.alias);
            const prefix = parentAlias + '_';
            let maxN = 0;
            inUseAliases.forEach(a => {
                if (a.startsWith(prefix)) {
                    const n = parseInt(a.slice(prefix.length), 10);
                    if (!isNaN(n) && n > maxN) maxN = n;
                }
            });
            alias = prefix + (maxN + 1);
        } else {
            alias = _generateAlias(sqName);
        }

        const tableId = 't_' + Date.now();

        const tableData = {
            id:         tableId,
            name:       sqName,
            alias,
            database:   null,
            position:   null,   // let _findFreePosition handle placement (same as btn-add-subquery)
            columns:    [],
            order:      State.tables.length + 1,
            isSubquery: true,
            subquery:   sql,
        };

        State.tables.push(tableData);
        _updateCanvasCount();
        Canvas.renderTable(tableData);

        // Tint the new island (yellow by default; callers can pass a different color)
        if (!State.islandColors) State.islandColors = {};
        State.islandColors[tableId] = color;

        if (typeof Islands !== 'undefined') {
            Islands.recompute();
            Islands.selectIsland(tableId);  // activate the new card's island
        } else {
            if (typeof QueryPanel !== 'undefined') QueryPanel.refresh();
            updateSQLPreview();
        }
        setTimeout(() => {
            document.querySelector(`.table-card[data-table-id="${tableId}"] .subquery-textarea`)?.focus();
        }, 0);
    }

    // -------------------------------------------------------------------------
    // Copy an entire island — all tables, joins and right-pane config —
    // placing the copy to the right of the canvas with a gap.
    // Calculus state is intentionally not copied.
    // -------------------------------------------------------------------------
    function copyIsland(islandKey) {
        _flushCurrentIslandConfig();

        const sourceTableIds = new Set(islandKey.split('|'));
        const sourceTables   = State.tables.filter(t => sourceTableIds.has(t.id));
        if (!sourceTables.length) return;

        // Bounding box of source island cards (DOM positions)
        let islandMinX = Infinity;
        sourceTables.forEach(t => {
            const card = document.querySelector(`.table-card[data-table-id="${t.id}"]`);
            if (card) islandMinX = Math.min(islandMinX, parseInt(card.style.left, 10) || 0);
        });
        if (!isFinite(islandMinX)) islandMinX = 0;

        // Right edge of all canvas cards — copy goes further right
        let canvasMaxRight = 0;
        document.querySelectorAll('.table-card').forEach(card => {
            canvasMaxRight = Math.max(canvasMaxRight, (parseInt(card.style.left, 10) || 0) + (card.offsetWidth || 0));
        });
        const xShift = canvasMaxRight + 80 - islandMinX;

        // Build alias map (oldAlias → newAlias) and ID map (oldId → newId)
        const inUse    = new Set(State.tables.map(t => t.alias));
        const aliasMap = {};
        const idMap    = {};
        let   idCtr    = Date.now();

        sourceTables.forEach(t => {
            const stem = t.alias.replace(/\d+$/, '');
            let n = 2;
            while (inUse.has(stem + n)) n++;
            const newAlias = stem + n;
            inUse.add(newAlias);
            aliasMap[t.alias] = newAlias;
            idMap[t.id]       = 't_' + (idCtr++);
        });

        // Clone tables
        const newTables = sourceTables.map((t, i) => {
            const pos = t.position ?? { x: islandMinX, y: 40 };
            return {
                ...JSON.parse(JSON.stringify(t)),
                id:       idMap[t.id],
                alias:    aliasMap[t.alias],
                position: { x: pos.x + xShift, y: pos.y },
                order:    State.tables.length + i + 1,
            };
        });

        // Clone joins that connect only tables within this island
        const newJoins = State.joins
            .filter(j => sourceTableIds.has(j.fromTableId) && sourceTableIds.has(j.toTableId))
            .map(j => ({
                ...JSON.parse(JSON.stringify(j)),
                id:          'j_' + (idCtr++),
                fromTableId: idMap[j.fromTableId],
                toTableId:   idMap[j.toTableId],
            }));

        // Clone and alias-substitute the island config
        const sourceConfig = State.islandConfigs?.[islandKey];
        const newConfig    = sourceConfig
            ? _substituteIslandConfig(JSON.parse(JSON.stringify(sourceConfig)), aliasMap, idMap)
            : null;

        // Compute new island key
        const newIslandKey = newTables.map(t => t.id).sort().join('|');

        // Register in State
        State.tables.push(...newTables);
        State.joins.push(...newJoins);
        if (!State.islandConfigs) State.islandConfigs = {};
        if (!State.islandNames)   State.islandNames   = {};
        if (!State.islandColors)  State.islandColors  = {};
        if (newConfig) State.islandConfigs[newIslandKey] = newConfig;
        const sourceName  = State.islandNames[islandKey] ?? '';
        State.islandNames[newIslandKey] = sourceName ? sourceName + ' (copy)' : '';
        const sourceColor = State.islandColors[islandKey] ?? null;
        if (sourceColor) State.islandColors[newIslandKey] = sourceColor;

        // Render cards
        _updateCanvasCount();
        newTables.forEach(t => Canvas.renderTable(t));

        // Render joins + recompute islands in next frame (cards must be in DOM)
        requestAnimationFrame(() => {
            newTables.forEach(t => Joins.redrawForTable(t.id));
            Islands.recompute();
            Islands.selectIsland(newIslandKey);
            if (newTables.length) Canvas.scrollToTableId(newTables[0].id);
        });
    }

    // -------------------------------------------------------------------------
    // Substitute old table aliases → new aliases throughout an island config.
    // -------------------------------------------------------------------------
    function _substituteIslandConfig(config, aliasMap, idMap) {
        const _s = str => {
            if (typeof str !== 'string') return str;
            Object.entries(aliasMap).forEach(([oldA, newA]) => {
                str = str.replaceAll(oldA + '.', newA + '.');
            });
            return str;
        };
        const _cond = c => c ? { ...c, col: _s(c.col), val: _s(c.val), val2: _s(c.val2), expr: _s(c.expr) } : c;

        if (Array.isArray(config.select))
            config.select = config.select.map(_s);
        config.selectRaw = _s(config.selectRaw);

        if (config.selectAliases) {
            const a = {};
            Object.entries(config.selectAliases).forEach(([k, v]) => { a[_s(k)] = v; });
            config.selectAliases = a;
        }
        if (Array.isArray(config.selectCustomExprs))
            config.selectCustomExprs = config.selectCustomExprs.map(e =>
                ({ ...e, id: 'cx_' + (Date.now() + Math.random()), expr: _s(e.expr) }));

        if (Array.isArray(config.where))   config.where   = config.where.map(_cond);
        config.whereRaw   = _s(config.whereRaw);
        if (Array.isArray(config.groupBy)) config.groupBy = config.groupBy.map(_s);
        config.groupByRaw = _s(config.groupByRaw);
        if (Array.isArray(config.having))  config.having  = config.having.map(_cond);
        config.havingRaw  = _s(config.havingRaw);
        if (Array.isArray(config.orderBy))
            config.orderBy = config.orderBy.map(o => ({ ...o, col: _s(o.col) }));
        config.orderByRaw = _s(config.orderByRaw);

        if (config.tableOrder) {
            const to = {};
            Object.entries(config.tableOrder).forEach(([oldId, ord]) => { to[idMap[oldId] ?? oldId] = ord; });
            config.tableOrder = to;
        }
        config.calculus = null;
        return config;
    }

    // -------------------------------------------------------------------------
    // Create a subquery canvas card pre-filled with SQL from scope extraction
    // -------------------------------------------------------------------------
    function _addExtractedSubquery(sql, alias) {
        const inUseNames = State.tables.map(t => t.name);
        let sqNum = 1;
        while (inUseNames.includes('sq' + sqNum)) sqNum++;
        const sqName  = 'sq' + sqNum;
        const usedAliases = State.tables.map(t => t.alias);
        let finalAlias = alias || _generateAlias(sqName);
        if (usedAliases.includes(finalAlias)) {
            let suffix = 2;
            while (usedAliases.includes(finalAlias + suffix)) suffix++;
            finalAlias = finalAlias + suffix;
        }
        const tableId = 't_' + Date.now();
        const tableData = {
            id:         tableId,
            name:       sqName,
            alias:      finalAlias,
            database:   null,
            position:   null,
            columns:    [],
            order:      State.tables.length + 1,
            isSubquery: true,
            subquery:   sql.trim(),
        };
        State.tables.push(tableData);
        _updateCanvasCount();
        Canvas.renderTable(tableData);
        if (typeof Islands    !== 'undefined') Islands.recompute();
        if (typeof QueryPanel !== 'undefined') QueryPanel.refresh();
        updateSQLPreview();
    }

    // -------------------------------------------------------------------------
    // Alias generation
    // -------------------------------------------------------------------------
    function _generateAlias(tableName) {
        // "order_items" -> "oi", "users" -> "u", "products" -> "p"
        const parts    = tableName.toLowerCase().split(/[_\s]+/);
        const base     = parts.map(p => p[0] || '').join('');
        const inUse    = State.tables.map(t => t.alias);
        let candidate  = base || tableName[0];
        let suffix     = 2;
        while (inUse.includes(candidate)) {
            candidate = base + suffix++;
        }
        return candidate;
    }

    // =========================================================================
    // Island config — video buffer model
    //
    // State.islandConfigs[key] = persistent store (background RAM)
    // Flat State fields            = active video buffer
    //
    // On any right-pane change  → auto-flushed via updateSQLPreview()
    // On island switch          → flush outgoing, blit incoming
    // =========================================================================

    /** Stable island key: sorted table IDs joined with '|' */
    function _islandKey(tableIds) {
        return [...tableIds].sort().join('|');
    }

    /** Returns the key for the currently active island (selected or the only one). */
    function _currentIslandKey() {
        if (State.selectedIslandKey) return State.selectedIslandKey;
        const enabledJoins = State.joins.filter(j => j.enabled !== false);
        const islands      = computeIslands(State.tables, enabledJoins);
        if (islands.length === 1) return _islandKey(islands[0]);
        return null;
    }

    /** Read current t.order values for tables in the given island. */
    function _currentTableOrder(key) {
        const ids = new Set(key.split('|'));
        const result = {};
        State.tables.filter(t => ids.has(t.id)).forEach(t => { result[t.id] = t.order ?? 1; });
        return result;
    }

    /** Apply stored tableOrder back to the t.order fields on State.tables. */
    function _applyTableOrder(tableOrder) {
        if (!tableOrder) return;
        State.tables.forEach(t => {
            if (tableOrder[t.id] !== undefined) t.order = tableOrder[t.id];
        });
        if (typeof Canvas !== 'undefined' && Canvas.refreshOrderDropdowns) {
            Canvas.refreshOrderDropdowns();
        }
    }

    /** Snapshot all right-pane + Calculus state from the current video buffer. */
    function _getRightPaneSnapshot() {
        return {
            select:             [...(State.select ?? [])],
            selectRaw:          State.selectRaw          ?? '',
            selectMode:         State.selectMode         ?? 'visual',
            selectCustomExprs:     JSON.parse(JSON.stringify(State.selectCustomExprs ?? [])),
            selectCustomExprsMode: State.selectCustomExprsMode ?? 'exclude',
            selectAliases:         { ...(State.selectAliases ?? {}) },
            selectNone:            State.selectNone         ?? false,
            selectAddDelimiter:    State.selectAddDelimiter    ?? false,
            selectSortAlpha:       State.selectSortAlpha       ?? false,
            selectDistinct:        State.selectDistinct        ?? false,
            selectShowCheckedOnly: (typeof QueryPanel !== 'undefined' && QueryPanel.getShowCheckedOnly)
                                       ? QueryPanel.getShowCheckedOnly()
                                       : false,
            selectCheckedOnlySnapshot: (typeof QueryPanel !== 'undefined' && QueryPanel.getCheckedOnlySnapshot)
                                           ? QueryPanel.getCheckedOnlySnapshot()
                                           : null,
            where:              JSON.parse(JSON.stringify(State.where    ?? [])),
            whereRaw:           State.whereRaw           ?? '',
            whereMode:          State.whereMode          ?? 'visual',
            groupBy:            [...(State.groupBy ?? [])],
            groupByRaw:         State.groupByRaw         ?? '',
            groupByMode:        State.groupByMode        ?? 'visual',
            having:             JSON.parse(JSON.stringify(State.having   ?? [])),
            havingRaw:          State.havingRaw          ?? '',
            havingMode:         State.havingMode         ?? 'visual',
            orderBy:            JSON.parse(JSON.stringify(State.orderBy  ?? [])),
            orderByRaw:         State.orderByRaw         ?? '',
            orderByMode:        State.orderByMode        ?? 'visual',
            limit:              State.limit              ?? 10,
            calculus:           (typeof Results !== 'undefined' && Results.calcGetState)
                                    ? (Results.calcGetState() ?? null)
                                    : null,
        };
    }

    /** Apply a right-pane snapshot to flat State fields + Calculus. */
    function _applyRightPaneSnapshot(snap) {
        if (!snap) return;
        const _prevWhereRaw  = State.whereRaw;
        const _prevWhereMode = State.whereMode;
        Object.assign(State, {
            select:             snap.select             ?? [],
            selectRaw:          snap.selectRaw          ?? '',
            selectMode:         snap.selectMode         ?? 'visual',
            selectCustomExprs:     snap.selectCustomExprs     ?? [],
            selectCustomExprsMode: snap.selectCustomExprsMode ?? 'exclude',
            selectAliases:         snap.selectAliases         ?? {},
            selectNone:            snap.selectNone            ?? false,
            selectAddDelimiter: snap.selectAddDelimiter ?? false,
            selectSortAlpha:    snap.selectSortAlpha    ?? false,
            selectDistinct:     snap.selectDistinct     ?? false,
            where:              snap.where              ?? [],
            whereRaw:           snap.whereRaw           ?? '',
            whereMode:          snap.whereMode          ?? 'visual',
            groupBy:            snap.groupBy            ?? [],
            groupByRaw:         snap.groupByRaw         ?? '',
            groupByMode:        snap.groupByMode        ?? 'visual',
            having:             snap.having             ?? [],
            havingRaw:          snap.havingRaw          ?? '',
            havingMode:         snap.havingMode         ?? 'visual',
            orderBy:            snap.orderBy            ?? [],
            orderByRaw:         snap.orderByRaw         ?? '',
            orderByMode:        snap.orderByMode        ?? 'visual',
            limit:              snap.limit              ?? 10,
        });
        if (_prevWhereMode === 'raw') {
            State.whereRaw  = _prevWhereRaw;
            State.whereMode = 'raw';
        }
        if (typeof QueryPanel !== 'undefined' && QueryPanel.setCheckedOnlySnapshot) {
            QueryPanel.setCheckedOnlySnapshot(snap.selectCheckedOnlySnapshot ?? null);
        }
        if (typeof QueryPanel !== 'undefined' && QueryPanel.setShowCheckedOnly) {
            QueryPanel.setShowCheckedOnly(snap.selectShowCheckedOnly ?? false);
        }
        if (typeof Results !== 'undefined' && Results.calcRestoreFromContext) {
            Results.calcRestoreFromContext(snap.calculus ?? null);
        }
    }

    /** Save the current video buffer into the island config store. */
    function _flushCurrentIslandConfig() {
        const key = _currentIslandKey();
        if (!key) return;
        if (!State.islandConfigs) State.islandConfigs = {};
        const existing = State.islandConfigs[key] ?? {};
        State.islandConfigs[key] = {
            ...(existing.anchorTableId ? { anchorTableId: existing.anchorTableId } : {}),
            tableOrder: _currentTableOrder(key),
            ..._getRightPaneSnapshot(),
        };
    }

    /** Collect backdrop annotations into State so they are included in the next save. */
    function _flushBackdropAnnotations() {
        if (typeof SqlBackdrop === 'undefined') return;
        // NOTE: card textarea has no backdrop, so there is nothing to transfer back.
        // Popup annotations are stored under 'sq-expand-textarea' and will be collected
        // as-is; they are re-applied to the popup on next open via sqExpandScopeMemory.
        State.backdropAnnotations = SqlBackdrop.collectAnnotations();
    }

    /**
     * Create a default island config for a brand-new island (Option B: all columns pre-selected).
     * Also applies it to the flat State so the UI reflects the new island immediately.
     */
    function _initIslandConfig(key) {
        if (!State.islandConfigs) State.islandConfigs = {};
        const ids    = new Set(key.split('|'));
        const tables = State.tables.filter(t => ids.has(t.id));

        // Pre-select all columns
        const select = [];
        tables.forEach(t => {
            (t.columns ?? []).forEach(c => {
                const col = typeof c === 'object' ? (c.name ?? '') : String(c);
                if (col) select.push(`${t.alias}.${col}`);
            });
        });

        const tableOrder = {};
        tables.forEach(t => { tableOrder[t.id] = t.order ?? 1; });

        const config = {
            tableOrder,
            select,
            selectRaw: '', selectMode: 'visual',
            selectCustomExprs: [], selectAliases: {}, selectNone: false,
            selectAddDelimiter: false, selectSortAlpha: false, selectDistinct: false,
            where: [], whereRaw: '', whereMode: 'visual',
            groupBy: [], groupByRaw: '', groupByMode: 'visual',
            having: [], havingRaw: '', havingMode: 'visual',
            orderBy: [], orderByRaw: '', orderByMode: 'visual',
            limit: State.limit ?? 10,
            calculus: null,
        };

        State.islandConfigs[key] = config;
        _applyRightPaneSnapshot(config);
    }

    /**
     * Merge multiple source island configs into a new combined config.
     * Arrays are unioned; tableOrder is rebuilt by appending B's tables after A's.
     */
    function _mergeIslandConfigs(sourceKeys, targetKey) {
        if (!State.islandConfigs) State.islandConfigs = {};

        // For islands that have never been selected their config doesn't exist yet.
        // Synthesize a default config (all columns pre-selected) so their columns
        // are not silently dropped from the merged SELECT.
        const sources = sourceKeys.map(k => {
            if (State.islandConfigs[k]) return State.islandConfigs[k];
            const ids    = new Set(k.split('|'));
            const tables = State.tables.filter(t => ids.has(t.id));
            const select = [];
            tables.forEach(t => {
                (t.columns ?? []).forEach(c => {
                    const col = typeof c === 'object' ? (c.name ?? '') : String(c);
                    if (col) select.push(`${t.alias}.${col}`);
                });
            });
            const tableOrder = {};
            tables.forEach(t => { tableOrder[t.id] = t.order ?? 1; });
            return {
                tableOrder, select,
                selectRaw: '', selectMode: 'visual',
                selectCustomExprs: [], selectAliases: {}, selectNone: false,
                selectAddDelimiter: false, selectSortAlpha: false, selectDistinct: false,
                where: [], whereRaw: '', whereMode: 'visual',
                groupBy: [], groupByRaw: '', groupByMode: 'visual',
                having: [], havingRaw: '', havingMode: 'visual',
                orderBy: [], orderByRaw: '', orderByMode: 'visual',
                limit: State.limit ?? 10, calculus: null,
            };
        });

        if (!sources.length) {
            // No tables found at all — init fresh
            _initIslandConfig(targetKey);
            return;
        }

        // Union arrays, preserving order and avoiding duplicates for simple string arrays
        const unionArr = (arrays) => {
            const seen = new Set();
            return arrays.flat().filter(x => {
                const k = JSON.stringify(x);
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            });
        };

        // tableOrder: destination island keeps its numbers; all other islands are
        // re-numbered sequentially after the destination's max so there are no duplicates.
        // State._pendingMergeToTableId identifies a table in the destination island.
        const _pendingToId = State._pendingMergeToTableId ?? null;
        delete State._pendingMergeToTableId; // consume immediately

        // Find which source is the destination (preserve its order numbers)
        let _destIdx = 0; // default: first source
        if (_pendingToId) {
            const found = sourceKeys.findIndex(k => k.split('|').includes(_pendingToId));
            if (found >= 0) _destIdx = found;
        }

        const tableOrder = {};
        let _maxOrder = 0;

        // First: destination island — preserve order values as-is
        Object.entries(sources[_destIdx].tableOrder ?? {}).forEach(([id, ord]) => {
            tableOrder[id] = ord;
            _maxOrder = Math.max(_maxOrder, ord);
        });

        // Then: every other island — sort by original order, offset after destination's max
        sources.forEach((s, i) => {
            if (i === _destIdx) return;
            const sorted = Object.entries(s.tableOrder ?? {}).sort((a, b) => a[1] - b[1]);
            sorted.forEach(([id], j) => { tableOrder[id] = _maxOrder + j + 1; });
            _maxOrder += sorted.length;
        });

        // Preserve custom expressions that were added to a previous version of this
        // merged island (e.g. C1 added while A+B were joined) but don't belong to any
        // source fragment. These are identified as IDs absent from all source configs.
        const sourceExprIds = new Set(sources.flatMap(s => (s.selectCustomExprs ?? []).map(e => e.id)));
        const existingMergedConfig = State.islandConfigs[targetKey];
        const cachedOnlyExprs = (existingMergedConfig?.selectCustomExprs ?? [])
            .filter(e => !sourceExprIds.has(e.id));

        // Calculus: never blend A's and B's calculus into C.
        // Re-merge restores C's own cached calculus; first-time merge starts empty.
        const mergedCalculus = existingMergedConfig?.calculus ?? null;

        State.islandConfigs[targetKey] = {
            tableOrder,
            select:             unionArr(sources.map(s => s.select ?? [])),
            selectRaw:          sources[0].selectRaw          ?? '',
            selectMode:         sources[0].selectMode         ?? 'visual',
            selectCustomExprs:  unionArr([...sources.map(s => s.selectCustomExprs ?? []), cachedOnlyExprs]),
            selectCustomExprsMode: sources[0].selectCustomExprsMode ?? 'exclude',
            selectAliases:      Object.assign({}, ...sources.map(s => s.selectAliases ?? {})),
            selectNone:         false,
            selectAddDelimiter: sources[0].selectAddDelimiter ?? false,
            selectSortAlpha:    sources[0].selectSortAlpha    ?? false,
            selectDistinct:     sources[0].selectDistinct     ?? false,
            where:              sources.flatMap(s => s.where  ?? []),
            whereRaw:           sources.map(s => s.whereRaw  ?? '').filter(Boolean).join('\nAND '),
            whereMode:          sources[0].whereMode          ?? 'visual',
            groupBy:            unionArr(sources.map(s => s.groupBy ?? [])),
            groupByRaw:         sources.map(s => s.groupByRaw ?? '').filter(Boolean).join(', '),
            groupByMode:        sources[0].groupByMode        ?? 'visual',
            having:             sources.flatMap(s => s.having ?? []),
            havingRaw:          sources.map(s => s.havingRaw ?? '').filter(Boolean).join('\nAND '),
            havingMode:         sources[0].havingMode         ?? 'visual',
            orderBy:            unionArr(sources.map(s => s.orderBy ?? [])),
            orderByRaw:         sources.map(s => s.orderByRaw ?? '').filter(Boolean).join(', '),
            orderByMode:        sources[0].orderByMode        ?? 'visual',
            limit:              sources[0].limit              ?? 10,
            calculus:           mergedCalculus,
        };
    }

    /** Merge Calculus states: union rows, concatenate notes. */
    function _mergeCalculus(calcList) {
        const valid = calcList.filter(Boolean);
        if (!valid.length) return null;
        return {
            note: valid.map(c => c.note ?? '').filter(Boolean).join(' | ') || null,
            rows: valid.flatMap(c => c.rows ?? []),
        };
    }

    /**
     * Split a source island config into N fragment configs.
     * Each fragment gets the subset of config items belonging to its table aliases.
     * WHERE/HAVING conditions that span multiple fragments are copied to both.
     */
    function _splitIslandConfig(sourceKey, targetKeys, allIslands) {
        if (!State.islandConfigs) State.islandConfigs = {};
        const source = State.islandConfigs[sourceKey];
        if (!source) {
            // Nothing to split — init each target fresh
            targetKeys.forEach(k => _initIslandConfig(k));
            return;
        }

        // Build alias sets for each target island
        const targetAliasSets = targetKeys.map(k => {
            const ids = k.split('|');
            const aliases = new Set(
                State.tables.filter(t => ids.includes(t.id)).map(t => t.alias)
            );
            return { key: k, aliases };
        });

        /** Returns which target(s) an item belongs to, based on "alias." prefixes found in JSON. */
        const itemTargets = (item) => {
            const str = JSON.stringify(item);
            return targetAliasSets.filter(({ aliases }) =>
                [...aliases].some(a => str.includes(a + '.'))
            );
        };

        // Build per-fragment sets of custom expression IDs from their original configs
        // (stored before the merge happened, since _mergeIslandConfigs never deletes them).
        // This lets us route each custom expression back to the island it was created in,
        // rather than relying on alias-prefix matching which fails for expressions like
        // COUNT(*) or anything created during the merged-island phase (e.g. C1).
        // Expressions whose IDs are not found in any original fragment config were created
        // while the islands were merged; they are excluded from all fragments so they remain
        // only in State.islandConfigs[sourceKey] as a cache for potential re-merge.
        const fragmentExprIds = {};
        targetKeys.forEach(k => {
            const origCfg = State.islandConfigs[k];
            fragmentExprIds[k] = new Set((origCfg?.selectCustomExprs ?? []).map(e => e.id));
        });

        targetKeys.forEach(targetKey => {
            const ids    = new Set(targetKey.split('|'));
            const tables = State.tables.filter(t => ids.has(t.id));
            const myAliases = new Set(tables.map(t => t.alias));

            const filterStrArr = (arr) =>
                (arr ?? []).filter(s => {
                    const parts = String(s).split('.');
                    return parts.length >= 2 && myAliases.has(parts[0]);
                });

            const filterObjArr = (arr) =>
                (arr ?? []).filter(item => {
                    const matches = itemTargets(item);
                    // Include if this target is in the match list (cross-island items get copied to all)
                    return matches.some(m => m.key === targetKey) || matches.length === 0;
                });

            const tableOrder = {};
            tables.forEach(t => {
                tableOrder[t.id] = (source.tableOrder ?? {})[t.id] ?? t.order ?? 1;
            });
            // Renumber from 1
            const sorted = tables.slice().sort((a, b) => (tableOrder[a.id] ?? 1) - (tableOrder[b.id] ?? 1));
            sorted.forEach((t, i) => { tableOrder[t.id] = i + 1; });

            State.islandConfigs[targetKey] = {
                tableOrder,
                select:             filterStrArr(source.select),
                selectRaw:          source.selectRaw          ?? '',
                selectMode:         source.selectMode         ?? 'visual',
                selectCustomExprs:  (source.selectCustomExprs ?? []).filter(e => fragmentExprIds[targetKey].has(e.id)),
                selectCustomExprsMode: State.islandConfigs[targetKey]?.selectCustomExprsMode ?? source.selectCustomExprsMode ?? 'exclude',
                selectAliases:      Object.fromEntries(
                    Object.entries(source.selectAliases ?? {})
                        .filter(([k]) => myAliases.has(k.split('.')[0]))
                ),
                selectNone:         source.selectNone         ?? false,
                selectAddDelimiter: source.selectAddDelimiter ?? false,
                selectSortAlpha:    source.selectSortAlpha    ?? false,
                selectDistinct:     source.selectDistinct     ?? false,
                where:              filterObjArr(source.where),
                whereRaw:           source.whereRaw           ?? '',
                whereMode:          source.whereMode          ?? 'visual',
                groupBy:            filterStrArr(source.groupBy),
                groupByRaw:         source.groupByRaw         ?? '',
                groupByMode:        source.groupByMode        ?? 'visual',
                having:             filterObjArr(source.having),
                havingRaw:          source.havingRaw          ?? '',
                havingMode:         source.havingMode         ?? 'visual',
                orderBy:            filterObjArr(source.orderBy),
                orderByRaw:         source.orderByRaw         ?? '',
                orderByMode:        source.orderByMode        ?? 'visual',
                limit:              source.limit              ?? 10,
                // Restore each fragment's own calculus from its pre-merge config.
                // Never try to split the merged island's calculus by alias — each
                // island owns its calculus session independently.
                calculus:           State.islandConfigs[targetKey]?.calculus ?? null,
            };
        });
    }

    /** Filter Calculus rows to only those whose items reference the given aliases. */
    function _splitCalculus(calculus, aliases) {
        if (!calculus) return null;
        const rows = (calculus.rows ?? []).map(row => ({
            ...row,
            items: (row.items ?? []).filter(item => {
                const hdr = JSON.stringify(item.headerInfo ?? '');
                return [...aliases].some(a => hdr.includes(a + '.'));
            }),
        })).filter(row => row.items.length > 0);
        return rows.length || calculus.note ? { note: calculus.note ?? null, rows } : null;
    }

    /**
     * Main blit operation: flush outgoing island, load incoming island.
     * Called by Islands.selectIsland() and whenever the active island changes.
     */
    function blitIslandConfig(newKey) {
        // Load incoming island config
        // NOTE: caller is responsible for flushing the outgoing config before updating
        // State.selectedIslandKey — see Islands.selectIsland which calls
        // App.flushCurrentIslandConfig() before switching keys.
        const config = State.islandConfigs?.[newKey];
        if (config) {
            _applyTableOrder(config.tableOrder);
            _applyRightPaneSnapshot(config);
        } else {
            _initIslandConfig(newKey);
        }

        if (typeof QueryPanel !== 'undefined') QueryPanel.refresh();
        updateSQLPreview();
    }

    /**
     * Called by Islands when the island composition changes (merge or split).
     * Handles config inheritance so data is never lost.
     */
    function onIslandTransition(prevKeys, newKeys) {
        const prevSet = new Set(prevKeys);
        const newSet  = new Set(newKeys);

        const added   = newKeys.filter(k => !prevSet.has(k));
        const removed = prevKeys.filter(k => !newSet.has(k));

        // Detect merges: a new key whose component IDs contain all IDs from removed keys
        added.forEach(newKey => {
            const newIds    = new Set(newKey.split('|'));
            const absorbed  = removed.filter(k => k.split('|').every(id => newIds.has(id)));
            if (absorbed.length > 0) {
                _mergeIslandConfigs(absorbed, newKey);
            }
            // If nothing absorbed → truly new island; config will be lazily created on first blit
        });

        // Detect splits: a removed key whose IDs are fully covered by new keys
        removed.forEach(prevKey => {
            const prevIds   = new Set(prevKey.split('|'));
            const fragments = newKeys.filter(k => k.split('|').every(id => prevIds.has(id)));
            if (fragments.length > 1) {
                _splitIslandConfig(prevKey, fragments);
            }
        });

    }

    /**
     * Purge stashed pin data for any island keys that include `tableId`.
     * Called when a table is permanently removed from the canvas so we don't
     * accumulate orphaned entries that can never be restored.
     */
    function cleanupPinsForRemovedTable(tableId) {
        ['islandPinnedPlots', 'islandPinSortOrder'].forEach(prop => {
            if (!State[prop]) return;
            Object.keys(State[prop]).forEach(key => {
                if (key.split('|').includes(tableId)) delete State[prop][key];
            });
        });
    }

    // -------------------------------------------------------------------------
    // SQL Preview — client-side builder (QueryPanel.buildSQL, defined in config.js)
    // -------------------------------------------------------------------------
    function updateSQLPreview() {
        const el = document.getElementById('sql-preview-text');

        // Auto-flush current right-pane to the active island's config slot
        _flushCurrentIslandConfig();

        if (State.tables.length === 0) {
            el.textContent = '-- Add tables to the canvas to begin';
            return;
        }

        if (typeof QueryPanel !== 'undefined') {
            el.textContent = _formatBackdropSQL(_stripSqlComments(QueryPanel.buildSQL(State)));
        } else {
            const names = State.tables.map(t => `${t.name} (${t.alias})`).join(', ');
            el.textContent = `-- Tables on canvas: ${names}`;
        }
    }

    // -------------------------------------------------------------------------
    // results-meta spinner (shown while waiting for any query response)
    // -------------------------------------------------------------------------
    const _SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    let _spinnerTimer = null;
    let _spinnerIdx   = 0;
    let _queryAbortController = null;

    function _showCancelBtn()  { document.getElementById('btn-cancel-query')?.classList.remove('hidden'); }
    function _hideCancelBtn()  { document.getElementById('btn-cancel-query')?.classList.add('hidden'); }

    async function _cancelRunningQuery() {
        if (_queryAbortController) _queryAbortController.abort();
        try {
            await fetch('cancel_query.php', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ profileId: State.activeProfileId }),
            });
        } catch { /* best-effort */ }
    }

    function _startMetaSpinner() {
        const el = document.getElementById('results-meta');
        if (!el) return;
        _spinnerIdx = 0;
        el.textContent = _SPINNER_FRAMES[0];
        el.classList.add('is-spinning');
        _spinnerTimer = setInterval(() => {
            _spinnerIdx = (_spinnerIdx + 1) % _SPINNER_FRAMES.length;
            el.textContent = _SPINNER_FRAMES[_spinnerIdx];
        }, 80);
    }

    function _stopMetaSpinner() {
        if (_spinnerTimer) { clearInterval(_spinnerTimer); _spinnerTimer = null; }
        document.getElementById('results-meta')?.classList.remove('is-spinning');
    }

    // -------------------------------------------------------------------------
    // Run Query
    // -------------------------------------------------------------------------
    async function runQuery() {
        if (!State.activeProfileId) {
            _notify('No connection profile selected.', 'error');
            return;
        }
        if (State.tables.length === 0) {
            _notify('Add at least one table to the canvas first.', 'warn');
            return;
        }
        if (State.selectNone && State.selectMode !== 'raw') {
            const hasCustomExprs = (State.selectCustomExprs ?? []).some(e => e.enabled !== false && e.expr?.trim());
            if (!hasCustomExprs) {
                _notify('No columns selected — please select at least one column before running the query.', 'warn');
                return;
            }
        }

        // Island check — build enabled-join list and compute islands
        const _enabledJoins = State.joins.filter(j => j.enabled !== false);
        const _islands      = computeIslands(State.tables, _enabledJoins);
        if (_islands.length > 1) {
            const selected = State.selectedIslandKey ?? null;
            if (!selected) {
                _notify('Multiple disconnected table groups found. Select one to query.', 'warn');
                return;
            }
            // Validate selected island still exists
            const selIds = new Set(selected.split('|'));
            const match  = _islands.find(g => g.length === selIds.size && g.every(id => selIds.has(id)));
            if (!match) {
                _notify('Selected island no longer exists. Please select one to query.', 'warn');
                return;
            }
        }

        // Build filtered state for the selected island (or the only island)
        const _activeIslandIds = (() => {
            if (_islands.length <= 1) return _islands[0] ? new Set(_islands[0]) : new Set(State.tables.map(t => t.id));
            const selIds = new Set((State.selectedIslandKey ?? '').split('|'));
            return selIds;
        })();
        const _filteredTables = State.tables.filter(t => _activeIslandIds.has(t.id));
        const _filteredJoins  = _enabledJoins.filter(j => _activeIslandIds.has(j.fromTableId) && _activeIslandIds.has(j.toTableId));

        const btn = document.getElementById('btn-run-query');
        btn.disabled    = true;
        btn.textContent = '⏳ Running…';
        _queryAbortController = new AbortController();
        _showCancelBtn();
        _startMetaSpinner();

        try {
            const result = await API.query.execute({
                profileId: State.activeProfileId,
                ...State,
                tables: _filteredTables,
                joins:  _filteredJoins,
            }, _queryAbortController.signal);

            // Attach table reference for JSON export
            if (State.tables.length === 1) {
                const t = State.tables[0];
                result.tableRef = t.database ? `${t.database}.${t.name}` : t.name;
            } else {
                result.tableRef = State.tables
                    .map(t => t.database ? `${t.database}.${t.name}` : t.name)
                    .join(', ');
            }

            Results.calcMarkOutOfSync();
            Results.render(result);
        } catch (e) {
            if (e.name === 'AbortError') {
                Results.renderError('Query cancelled.');
                _notify('Query cancelled.', 'warn');
            } else {
                Results.renderError(e.message);
                _notify('Query failed — see results panel for details.', 'error');
            }
        } finally {
            _queryAbortController = null;
            _hideCancelBtn();
            _stopMetaSpinner();
            btn.disabled    = false;
            btn.textContent = '▶ Run Query';
        }
    }

    // -------------------------------------------------------------------------
    // AI Knowledge
    // -------------------------------------------------------------------------
    async function runAiKnowledge() {
        if (!State.activeProfileId) { _notify('No connection profile selected.', 'error'); return; }

        const sql = (document.getElementById('sql-preview-text').textContent || '').trim();
        if (!sql || sql.startsWith('--')) { _notify('No query to extract tables from.', 'warn'); return; }

        const tables = _extractTableNames(sql);
        if (tables.length === 0) { _notify('No table names found in query.', 'warn'); return; }

        const btn = document.getElementById('btn-ai-knowledge');
        const origLabel = btn.textContent;
        btn.textContent = '⏳';
        btn.disabled    = true;

        const ddls   = [];
        const failed = [];

        for (const t of tables) {
            const dotIdx = t.indexOf('.');
            const schema = dotIdx !== -1 ? t.slice(0, dotIdx) : '';
            const tName  = dotIdx !== -1 ? t.slice(dotIdx + 1) : t;
            try {
                const res = await API.schema.createStatement(State.activeProfileId, tName, schema);
                if (res.ddl) {
                    let ddl = res.ddl;
                    if (schema) {
                        const esc = tName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        ddl = ddl.replace(
                            new RegExp(`(CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)\`?${esc}\`?`, 'i'),
                            `$1\`${schema}\`.\`${tName}\``
                        );
                    }
                    ddls.push(ddl);
                }
            } catch (e) {
                failed.push(t);
            }
        }

        btn.textContent = origLabel;
        btn.disabled    = false;

        if (ddls.length === 0) { _notify('Could not fetch any CREATE TABLE statements.', 'error'); return; }

        if (failed.length > 0) {
            _notify(`${failed.length} table${failed.length !== 1 ? 's' : ''} could not be fetched: ${failed.join(', ')}`, 'warn');
        }

        const createsPart = ddls.map(d => d.trimEnd() + ';').join('\n\n\n\n');
        const combined    = (sql.endsWith(';') ? sql : sql + ';') + '\n\n\n\n' + createsPart;

        const saveChk = document.getElementById('chk-ai-knowledge-save');
        if (saveChk && saveChk.checked) {
            // Checked → save to disk
            const now = new Date();
            const pad = n => String(n).padStart(2, '0');
            const ts  = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
            const blob = new Blob([combined], { type: 'text/plain;charset=utf-8;' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = `ai-knowledge-${ts}.sql`;
            a.click();
            URL.revokeObjectURL(url);
            _notify('AI Knowledge saved to file.', 'success');
        } else {
            // Unchecked → copy to clipboard
            navigator.clipboard.writeText(combined)
                .then(() => {
                    btn.textContent = '✓';
                    setTimeout(() => (btn.textContent = origLabel), 1500);
                    _notify('AI Knowledge copied to clipboard.', 'success');
                })
                .catch(() => _notify('Clipboard write failed.', 'error'));
        }
    }

    // -------------------------------------------------------------------------
    // Explain Query
    // -------------------------------------------------------------------------
    async function runExplainQuery() {
        if (!State.activeProfileId) {
            _notify('No connection profile selected.', 'error');
            return;
        }

        const btn = document.getElementById('btn-explain-query');
        btn.disabled    = true;
        btn.textContent = '⏳ Running…';
        _queryAbortController = new AbortController();
        _showCancelBtn();
        _startMetaSpinner();

        try {
            // Apply the same island filtering as runQuery so EXPLAIN only
            // operates on the active island's tables/joins.
            const _enabledJoins     = State.joins.filter(j => j.enabled !== false);
            const _islands          = computeIslands(State.tables, _enabledJoins);
            const _activeIslandIds  = (() => {
                if (_islands.length <= 1) return _islands[0] ? new Set(_islands[0]) : new Set(State.tables.map(t => t.id));
                const selIds = new Set((State.selectedIslandKey ?? '').split('|'));
                return selIds;
            })();
            const _filteredTables = State.tables.filter(t => _activeIslandIds.has(t.id));
            const _filteredJoins  = _enabledJoins.filter(j => _activeIslandIds.has(j.fromTableId) && _activeIslandIds.has(j.toTableId));

            // Use the server-side preview to get the authoritative multi-line
            // formatted SQL (columns one per line), identical to what execute()
            // would use — so EXPLAIN output matches normal SELECT formatting.
            const preview = await API.query.preview({ profileId: State.activeProfileId, ...State, tables: _filteredTables, joins: _filteredJoins });
            const previewSql = _stripSqlComments((preview.sql || '').trim()).trim();

            if (!previewSql || previewSql.startsWith('--')) {
                _notify('No query to explain yet.', 'warn');
                return;
            }

            // Strip any leading EXPLAIN prefix — safety net so the function is
            // idempotent no matter what the preview returns.
            // Also bind any SET @var declarations embedded inside subqueries so
            // MySQL receives a clean, variable-free query.
            const sqlToExplain = _prepareForExplain(
                previewSql.replace(/^\s*EXPLAIN\s+/i, '').trim()
            );

            const result = await API.query.executeRaw(State.activeProfileId, 'EXPLAIN ' + sqlToExplain, _queryAbortController.signal);
            Results.calcMarkOutOfSync();
            Results.render(result);
        } catch (e) {
            if (e.name === 'AbortError') {
                Results.renderError('Query cancelled.');
                _notify('Query cancelled.', 'warn');
            } else {
                Results.renderError(e.message);
                _notify('EXPLAIN failed — see results panel for details.', 'error');
            }
        } finally {
            _queryAbortController = null;
            _hideCancelBtn();
            _stopMetaSpinner();
            btn.disabled    = false;
            btn.textContent = '⚙ Explain';
            // Restore the preview bar to the SELECT query so it doesn't show the
            // EXPLAIN SQL that Results.render() wrote into it.
            updateSQLPreview();
        }
    }

    // -------------------------------------------------------------------------
    // Plot Query
    // -------------------------------------------------------------------------
    async function runPlotQuery() {
        if (!State.activeProfileId) {
            _notify('No connection profile selected.', 'error');
            return;
        }
        if (State.tables.length === 0) {
            _notify('Add at least one table to the canvas first.', 'warn');
            return;
        }

        // Island check — same as runQuery
        const _enabledJoins = State.joins.filter(j => j.enabled !== false);
        const _islands      = computeIslands(State.tables, _enabledJoins);
        if (_islands.length > 1) {
            const selected = State.selectedIslandKey ?? null;
            if (!selected) {
                _notify('Multiple disconnected table groups found. Select one to plot.', 'warn');
                return;
            }
            const selIds = new Set(selected.split('|'));
            const match  = _islands.find(g => g.length === selIds.size && g.every(id => selIds.has(id)));
            if (!match) {
                _notify('Selected island no longer exists. Please select one to plot.', 'warn');
                return;
            }
        }

        const _activeIslandIds = (() => {
            if (_islands.length <= 1) return _islands[0] ? new Set(_islands[0]) : new Set(State.tables.map(t => t.id));
            return new Set((State.selectedIslandKey ?? '').split('|'));
        })();
        const islandKey      = [..._activeIslandIds].sort().join('|');
        const _filteredTables = State.tables.filter(t => _activeIslandIds.has(t.id));
        const _filteredJoins  = _enabledJoins.filter(j => _activeIslandIds.has(j.fromTableId) && _activeIslandIds.has(j.toTableId));

        // Pass island name as title hint; openPlot falls back to "col1 vs col2" if empty
        const islandName = (State.islandNames?.[islandKey] ?? '').trim() || null;

        const btn = document.getElementById('btn-plot-query');
        btn.disabled    = true;
        btn.textContent = '⏳ Plotting…';
        _queryAbortController = new AbortController();
        _showCancelBtn();
        _startMetaSpinner();

        try {
            const result = await API.query.execute({
                profileId: State.activeProfileId,
                ...State,
                tables: _filteredTables,
                joins:  _filteredJoins,
            }, _queryAbortController.signal);

            Modals.openPlot(result, islandKey, islandName);
            if (document.getElementById('chk-plot-show-results')?.checked) {
                Results.render(result);
            }
        } catch (e) {
            if (e.name === 'AbortError') {
                _notify('Query cancelled.', 'warn');
            } else {
                _notify('Plot query failed: ' + e.message, 'error');
            }
        } finally {
            _queryAbortController = null;
            _hideCancelBtn();
            _stopMetaSpinner();
            btn.disabled    = false;
            btn.textContent = '📊 Plot';
        }
    }

    // -------------------------------------------------------------------------
    // Bind all SET @var declarations in sql and return the resolved query.
    // If no variables are present the original string is returned unchanged.
    // Delegates to Canvas.bindSqlVariables which owns the canonical logic.
    // -------------------------------------------------------------------------
    function _prepareForExplain(sql) {
        const bound = (typeof Canvas !== 'undefined') ? Canvas.bindSqlVariables(sql) : null;
        return bound ?? sql;
    }

    // -------------------------------------------------------------------------
    // Strip SQL comments (-- line, /* block */, # hash) while leaving string
    // literals untouched.  Replaces each comment with whitespace so adjacent
    // tokens never run together.
    // -------------------------------------------------------------------------
    function _stripSqlComments(sql) {
        let result = '';
        let i = 0;
        const len = sql.length;
        while (i < len) {
            const ch = sql[i];
            // String literals — pass through unchanged
            if (ch === "'" || ch === '"' || ch === '`') {
                const quote = ch;
                result += ch; i++;
                while (i < len) {
                    const c = sql[i];
                    result += c;
                    if (c === '\\') { i += 2; continue; }
                    if (c === quote) { i++; break; }
                    i++;
                }
                continue;
            }
            // Block comment /* ... */
            if (ch === '/' && sql[i + 1] === '*') {
                i += 2;
                while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
                i += 2;
                result += ' ';
                continue;
            }
            // Line comment -- ...
            if (ch === '-' && sql[i + 1] === '-') {
                i += 2;
                while (i < len && sql[i] !== '\n') i++;
                if (i < len) result += '\n';
                continue;
            }
            // MySQL hash comment # ...
            if (ch === '#') {
                i++;
                while (i < len && sql[i] !== '\n') i++;
                if (i < len) result += '\n';
                continue;
            }
            result += ch; i++;
        }
        return result;
    }

    // -------------------------------------------------------------------------
    // Custom Query (arbitrary SQL)
    // -------------------------------------------------------------------------

    /**
     * Normalise and optionally prefix table references in a raw SQL string.
     *
     * Step 1 (always runs): backtick-quote unquoted `db.table` references that
     *   appear directly after FROM / JOIN.  Fixes MySQL reserved-word ambiguity
     *   for patterns like `FROM schema.table` → `FROM \`schema\`.\`table\``.
     *   Three-part names (a.b.c) are left alone via the negative lookahead.
     *
     * Step 2 (only when schema is set): prefix bare unqualified table names
     *   after FROM / JOIN with the active schema.
     *
     * Subqueries are safe because `(` is not a valid identifier start.
     */
    function _injectActiveSchema(sql, schema) {
        // Step 1 — backtick-quote unquoted qualified names (word.word)
        sql = sql.replace(
            /\b(FROM|JOIN)\s+([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)(?!\s*\.)/gi,
            (_, kw, db, tbl) => `${kw} \`${db}\`.\`${tbl}\``
        );

        // Step 2 — prefix unqualified names with active schema
        if (!schema) return sql;
        return sql.replace(
            /\b(FROM|JOIN)\s+(`[^`]+`|[a-zA-Z_]\w*)(?!\s*\.)/gi,
            (_, kw, ref) => {
                const name = ref.startsWith('`') ? ref.slice(1, -1) : ref;
                return `${kw} \`${schema}\`.\`${name}\``;
            }
        );
    }

    async function _runCustomQuery(sqlOverride) {
        if (!State.activeProfileId) {
            _notify('No connection profile selected.', 'error');
            return;
        }

        let sql = sqlOverride ?? document.getElementById('custom-query-textarea').value.trim();
        if (!sql) {
            _notify('Please enter a SQL query.', 'warn');
            return;
        }

        // Apply alpha sort to SELECT list if the toggle is on
        if (document.getElementById('select-sort-alpha-toggle')?.checked) {
            sql = QueryPanel.sortSelectInSQL(sql);
        }

        sql = _stripSqlComments(sql).trim();
        sql = _injectActiveSchema(sql, State.activeDatabase);

        // Close modal and run
        document.getElementById('modal-custom-query').classList.add('hidden');

        const btn = document.getElementById('btn-run-custom-query');
        btn.disabled    = true;
        btn.textContent = '⏳ Running…';
        _queryAbortController = new AbortController();
        _showCancelBtn();
        _startMetaSpinner();

        try {
            const result = await API.query.executeRaw(State.activeProfileId, sql, _queryAbortController.signal);
            Results.calcMarkOutOfSync();
            Results.render(result);
        } catch (e) {
            if (e.name === 'AbortError') {
                Results.renderError('Query cancelled.');
                _notify('Query cancelled.', 'warn');
            } else {
                Results.renderError(e.message);
                _notify('Query failed — see results panel for details.', 'error');
            }
        } finally {
            _queryAbortController = null;
            _hideCancelBtn();
            _stopMetaSpinner();
            btn.disabled    = false;
            btn.textContent = '▶ Run Custom Query';
        }
    }

    // -------------------------------------------------------------------------
    // Subquery Expand popup
    // -------------------------------------------------------------------------

    function openSqExpand(sqTextarea) {
        _sqExpandTarget = sqTextarea;
        const ta       = document.getElementById('sq-expand-textarea');
        const selStart = sqTextarea.selectionStart;
        const selEnd   = sqTextarea.selectionEnd;
        const scroll   = sqTextarea.scrollTop;
        // Card textarea has no SqlBackdrop — no activeWord to snapshot.
        if (ta.value !== sqTextarea.value) {
            ta.value = sqTextarea.value;
            ta.dispatchEvent(new Event('input', { bubbles: true })); // refresh backdrop
            if (typeof UndoManager !== 'undefined') UndoManager.reset(ta);
        }
        // Card textarea has no backdrop, so there are no annotations to transfer.
        // The popup starts fresh with its own annotation state.
        // Restore scope mode if it was active when the popup was last closed.
        // Guard against double-toggle in case transferAnnotations already enabled it.
        if (State.sqExpandScopeMemory && typeof SqlBackdrop !== 'undefined'
                && !ta.classList.contains('scope-mode-on')) {
            SqlBackdrop.toggleScopeMode(ta);
            ta.dispatchEvent(new CustomEvent('backdrop-scopetoggle',
                { bubbles: true, detail: { scopeMode: true } }));
        }
        document.getElementById('modal-sq-expand').classList.remove('hidden');
        // Refresh bookmarks now that the popup is visible: getComputedStyle returns
        // lineHeight = 0 while hidden, so any bookmarks loaded from context would
        // all render at the same position.  Re-rendering here fixes that.
        if (typeof SqlBackdrop !== 'undefined') SqlBackdrop.refreshBookmarks(ta);
        ta.focus();
        ta.setSelectionRange(selStart, selEnd);
        ta.scrollTop = scroll;
        // Card textarea has no backdrop — only restore activeWord on the popup.
        if (typeof SqlBackdrop !== 'undefined') {
            const _savedWord = SqlBackdrop.getActiveWord(ta);
            if (_savedWord) {
                setTimeout(() => {
                    SqlBackdrop.restoreActiveWord(ta, _savedWord);
                }, 0);
            }
        }
    }

    function _sqExpandSyncAndClose() {
        const ta     = document.getElementById('sq-expand-textarea');
        const target = _sqExpandTarget;

        // Snapshot scope state, then turn it OFF.
        // Card textarea has no backdrop, so no activeWord snapshot needed.
        State.sqExpandScopeMemory = ta.classList.contains('scope-mode-on');
        if (State.sqExpandScopeMemory && typeof SqlBackdrop !== 'undefined') {
            SqlBackdrop.toggleScopeMode(ta);
            ta.dispatchEvent(new CustomEvent('backdrop-scopetoggle',
                { bubbles: true, detail: { scopeMode: false } }));
        }
        const selStart = ta.selectionStart;
        const selEnd   = ta.selectionEnd;
        const scroll   = ta.scrollTop;
        document.getElementById('modal-sq-expand').classList.add('hidden');
        if (target) {
            if (target.value !== ta.value) {
                // Value changed while popup was open — the real-time sync listener
                // already kept the card in sync keystroke by keystroke, so this
                // should rarely differ.  Dispatch input to update any remaining
                // listeners (this will clear scope highlights, but the content
                // changed so old highlights are no longer meaningful anyway).
                target.value = ta.value;
                target.dispatchEvent(new Event('input'));
            }
            // Card textarea has no backdrop — annotations stay in the popup exclusively.
            setTimeout(() => {
                target.focus();
                target.setSelectionRange(selStart, selEnd);
                target.scrollTop = scroll;
                // Card has no backdrop, so no restoreActiveWord needed.
            }, 0);
        }
    }

    // -------------------------------------------------------------------------
    // Tables menu — shared across SQL modal popups
    // -------------------------------------------------------------------------

    /**
     * Parse unique table references from a SQL string.
     * Returns entries as "schema.table" when a schema qualifier is present,
     * or just "table" when there is none, sorted alphabetically.
     */
    function _extractTableNames(sql) {
        // Strip single-line (--) and block (/* */) comments
        const stripped = sql
            .replace(/--[^\n]*/g, ' ')
            .replace(/\/\*[\s\S]*?\*\//g, ' ');

        const tables = new Set();
        // Match FROM / any JOIN keyword followed by a table reference.
        // Handles: `schema`.`table`, schema.table, `table`, "table", table
        const re = /\b(?:FROM|JOIN)\s+(`[^`]+`|"[^"]+"|[\w$]+)(?:\s*\.\s*(`[^`]+`|"[^"]+"|[\w$]+))?/gi;
        let m;
        while ((m = re.exec(stripped)) !== null) {
            const part1 = m[1].replace(/[`"]/g, '');
            const part2 = m[2] ? m[2].replace(/[`"]/g, '') : null;
            tables.add(part2 ? `${part1}.${part2}` : part1);
        }
        return [...tables].sort();
    }

    /**
     * Wire up a "Tables ▾" dropdown button inside a .tables-menu wrapper.
     * getSql — zero-arg function that returns the SQL text to parse.
     */
    function _bindTablesMenu(triggerBtn, getSql) {
        const menu        = triggerBtn.closest('.tables-menu');
        const dropdown    = menu.querySelector('.tables-dropdown');
        const chk         = menu.querySelector('.tables-save-chk');
        const namesBtn    = menu.querySelector('.btn-tables-names');
        const selectsChk  = menu.querySelector('.tables-selects-save-chk');
        const selectsBtn  = menu.querySelector('.btn-tables-selects');
        const createsChk       = menu.querySelector('.tables-creates-save-chk');
        const createsBtn       = menu.querySelector('.btn-tables-creates');
        const aiKnowledgeChk   = menu.querySelector('.tables-ai-knowledge-save-chk');
        const aiKnowledgeBtn   = menu.querySelector('.btn-tables-ai-knowledge');

        triggerBtn.addEventListener('click', e => {
            e.stopPropagation();
            const willOpen = dropdown.classList.contains('hidden');
            // Close every other open tables dropdown first
            document.querySelectorAll('.tables-dropdown').forEach(d => d.classList.add('hidden'));
            document.querySelectorAll('.btn-tables-trigger').forEach(b => b.classList.remove('is-open'));
            if (willOpen) {
                dropdown.classList.remove('hidden');
                triggerBtn.classList.add('is-open');
            }
        });

        // Clicks inside the dropdown must not bubble up to the global close handler
        dropdown.addEventListener('click', e => e.stopPropagation());

        namesBtn.addEventListener('click', () => {
            // Close dropdown
            dropdown.classList.add('hidden');
            triggerBtn.classList.remove('is-open');

            const sql = getSql().trim();
            if (!sql) { _notify('No query to extract tables from.', 'warn'); return; }

            const tables = _extractTableNames(sql);
            if (tables.length === 0) { _notify('No table names found in query.', 'warn'); return; }

            const text = tables.join('\n');

            if (chk.checked) {
                const now = new Date();
                const pad = n => String(n).padStart(2, '0');
                const ts  = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
                const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href     = url;
                a.download = `table-names-${ts}.txt`;
                a.click();
                URL.revokeObjectURL(url);
                _notify(`${tables.length} table name${tables.length !== 1 ? 's' : ''} saved to file.`, 'success');
            } else {
                navigator.clipboard.writeText(text)
                    .then(() => {
                        const orig = namesBtn.textContent;
                        namesBtn.textContent = '✓';
                        setTimeout(() => (namesBtn.textContent = orig), 1500);
                        _notify(`${tables.length} table name${tables.length !== 1 ? 's' : ''} copied to clipboard.`, 'success');
                    })
                    .catch(() => _notify('Clipboard write failed.', 'error'));
            }
        });

        selectsBtn.addEventListener('click', () => {
            // Close dropdown
            dropdown.classList.add('hidden');
            triggerBtn.classList.remove('is-open');

            const sql = getSql().trim();
            if (!sql) { _notify('No query to extract tables from.', 'warn'); return; }

            const tables = _extractTableNames(sql);
            if (tables.length === 0) { _notify('No table names found in query.', 'warn'); return; }

            const stmts = tables.map(t => {
                const ref = t.includes('.')
                    ? t.split('.').map(p => '`' + p + '`').join('.')
                    : '`' + t + '`';
                return `SELECT * FROM ${ref} ORDER BY \`id\` DESC LIMIT 10;`;
            });
            const text = stmts.join('\n\n\n');

            if (selectsChk.checked) {
                const now = new Date();
                const pad = n => String(n).padStart(2, '0');
                const ts  = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
                const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href     = url;
                a.download = `selects-${ts}.sql`;
                a.click();
                URL.revokeObjectURL(url);
                _notify(`${stmts.length} SELECT${stmts.length !== 1 ? 's' : ''} saved to file.`, 'success');
            } else {
                navigator.clipboard.writeText(text)
                    .then(() => {
                        const orig = selectsBtn.textContent;
                        selectsBtn.textContent = '✓';
                        setTimeout(() => (selectsBtn.textContent = orig), 1500);
                        _notify(`${stmts.length} SELECT${stmts.length !== 1 ? 's' : ''} copied to clipboard.`, 'success');
                    })
                    .catch(() => _notify('Clipboard write failed.', 'error'));
            }
        });

        createsBtn.addEventListener('click', async () => {
            // Close dropdown
            dropdown.classList.add('hidden');
            triggerBtn.classList.remove('is-open');

            if (!State.activeProfileId) { _notify('No connection profile selected.', 'error'); return; }

            const sql = getSql().trim();
            if (!sql) { _notify('No query to extract tables from.', 'warn'); return; }

            const tables = _extractTableNames(sql);
            if (tables.length === 0) { _notify('No table names found in query.', 'warn'); return; }

            const origLabel = createsBtn.textContent;
            createsBtn.textContent = '⏳';
            createsBtn.disabled    = true;

            const ddls    = [];
            const failed  = [];

            for (const t of tables) {
                const dotIdx  = t.indexOf('.');
                const schema  = dotIdx !== -1 ? t.slice(0, dotIdx) : '';
                const tName   = dotIdx !== -1 ? t.slice(dotIdx + 1) : t;
                try {
                    const res = await API.schema.createStatement(State.activeProfileId, tName, schema);
                    if (res.ddl) {
                        let ddl = res.ddl;
                        // MySQL omits the schema in the CREATE TABLE header even when
                        // queried with schema.table — put it back so the DDL is portable.
                        if (schema) {
                            const esc = tName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            ddl = ddl.replace(
                                new RegExp(`(CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)\`?${esc}\`?`, 'i'),
                                `$1\`${schema}\`.\`${tName}\``
                            );
                        }
                        ddls.push(ddl);
                    }
                } catch (e) {
                    failed.push(t);
                }
            }

            createsBtn.textContent = origLabel;
            createsBtn.disabled    = false;

            if (ddls.length === 0) {
                _notify('Could not fetch any CREATE TABLE statements.', 'error');
                return;
            }

            if (failed.length > 0) {
                _notify(`${failed.length} table${failed.length !== 1 ? 's' : ''} could not be fetched: ${failed.join(', ')}`, 'warn');
            }

            const text = ddls.map(d => d.trimEnd() + ';').join('\n\n\n\n');

            if (createsChk.checked) {
                const now = new Date();
                const pad = n => String(n).padStart(2, '0');
                const ts  = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
                const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href     = url;
                a.download = `creates-${ts}.sql`;
                a.click();
                URL.revokeObjectURL(url);
                _notify(`${ddls.length} CREATE TABLE${ddls.length !== 1 ? 's' : ''} saved to file.`, 'success');
            } else {
                navigator.clipboard.writeText(text)
                    .then(() => {
                        const orig = createsBtn.textContent;
                        createsBtn.textContent = '✓';
                        setTimeout(() => (createsBtn.textContent = orig), 1500);
                        _notify(`${ddls.length} CREATE TABLE${ddls.length !== 1 ? 's' : ''} copied to clipboard.`, 'success');
                    })
                    .catch(() => _notify('Clipboard write failed.', 'error'));
            }
        });

        if (aiKnowledgeBtn) {
            aiKnowledgeBtn.addEventListener('click', async () => {
                // Close dropdown
                dropdown.classList.add('hidden');
                triggerBtn.classList.remove('is-open');

                if (!State.activeProfileId) { _notify('No connection profile selected.', 'error'); return; }

                const sql = getSql().trim();
                if (!sql) { _notify('No query to extract tables from.', 'warn'); return; }

                const tables = _extractTableNames(sql);
                if (tables.length === 0) { _notify('No table names found in query.', 'warn'); return; }

                const origLabel = aiKnowledgeBtn.textContent;
                aiKnowledgeBtn.textContent = '⏳';
                aiKnowledgeBtn.disabled    = true;

                const ddls   = [];
                const failed = [];

                for (const t of tables) {
                    const dotIdx = t.indexOf('.');
                    const schema = dotIdx !== -1 ? t.slice(0, dotIdx) : '';
                    const tName  = dotIdx !== -1 ? t.slice(dotIdx + 1) : t;
                    try {
                        const res = await API.schema.createStatement(State.activeProfileId, tName, schema);
                        if (res.ddl) {
                            let ddl = res.ddl;
                            if (schema) {
                                const esc = tName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                                ddl = ddl.replace(
                                    new RegExp(`(CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)\`?${esc}\`?`, 'i'),
                                    `$1\`${schema}\`.\`${tName}\``
                                );
                            }
                            ddls.push(ddl);
                        }
                    } catch (e) {
                        failed.push(t);
                    }
                }

                aiKnowledgeBtn.textContent = origLabel;
                aiKnowledgeBtn.disabled    = false;

                if (ddls.length === 0) {
                    _notify('Could not fetch any CREATE TABLE statements.', 'error');
                    return;
                }

                if (failed.length > 0) {
                    _notify(`${failed.length} table${failed.length !== 1 ? 's' : ''} could not be fetched: ${failed.join(', ')}`, 'warn');
                }

                const createsPart = ddls.map(d => d.trimEnd() + ';').join('\n\n\n\n');
                const combined    = (sql.endsWith(';') ? sql : sql + ';') + '\n\n\n\n' + createsPart;

                if (aiKnowledgeChk && aiKnowledgeChk.checked) {
                    // Checkbox checked → save to disk
                    const now = new Date();
                    const pad = n => String(n).padStart(2, '0');
                    const ts  = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
                    const blob = new Blob([combined], { type: 'text/plain;charset=utf-8;' });
                    const url  = URL.createObjectURL(blob);
                    const a    = document.createElement('a');
                    a.href     = url;
                    a.download = `ai-knowledge-${ts}.sql`;
                    a.click();
                    URL.revokeObjectURL(url);
                    _notify('AI Knowledge saved to file.', 'success');
                } else {
                    // Checkbox unchecked → copy to clipboard
                    navigator.clipboard.writeText(combined)
                        .then(() => {
                            const orig = aiKnowledgeBtn.textContent;
                            aiKnowledgeBtn.textContent = '✓';
                            setTimeout(() => (aiKnowledgeBtn.textContent = orig), 1500);
                            _notify('AI Knowledge copied to clipboard.', 'success');
                        })
                        .catch(() => _notify('Clipboard write failed.', 'error'));
                }
            });
        }
    }

    function _bindSqExpandModal() {
        const ta = document.getElementById('sq-expand-textarea');

        // Run button — reuses _runCustomQuery (sqlOverride avoids reading custom-query-textarea)
        document.getElementById('btn-sq-expand-run').addEventListener('click', () => {
            const sql = ta.value.trim();
            if (!sql) { _notify('Please enter a SQL query.', 'warn'); return; }
            _sqExpandSyncAndClose();
            _runCustomQuery(sql);
        });

        // Explain button
        document.getElementById('btn-sq-expand-explain').addEventListener('click', () => {
            const sql = ta.value.trim();
            if (!sql) { _notify('Please enter a SQL query.', 'warn'); return; }
            const final = _prepareForExplain(sql);
            _sqExpandSyncAndClose();
            _runCustomQuery(/^explain\s/i.test(final) ? final : 'EXPLAIN ' + final);
        });

        // Format button
        document.getElementById('btn-sq-expand-format').addEventListener('click', () => {
            _formatTextareaSql(ta);
        });

        // Bind var button — resolve the @varN under the cursor in-place
        const bindVarBtn = document.getElementById('btn-sq-expand-bind-var');

        function _bindVarAtCursor() {
            const text = ta.value;
            const pos  = ta.selectionStart;

            // Find the @varName the cursor sits on.  Walk over word chars and
            // include the leading '@' if present.
            let s = pos, e = pos;
            while (s > 0 && /\w/.test(text[s - 1])) s--;
            while (e < text.length && /\w/.test(text[e])) e++;
            if (s > 0 && text[s - 1] === '@') s--;

            if (s >= e || text[s] !== '@') {
                _notify('Place the cursor on a variable (e.g. @var1) to bind it.', 'warn');
                return;
            }

            const varName = text.slice(s + 1, e); // name without '@'
            const esc     = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // Find the SET declaration for this variable
            const setRe    = new RegExp('\\bSET[ \\t]+@' + esc + '[ \\t]*:?=[ \\t]*([^;]*)', 'i');
            const setMatch = setRe.exec(text);
            if (!setMatch) {
                _notify('@' + varName + ' has no SET declaration.', 'warn');
                return;
            }
            const value = setMatch[1].trim();

            // Remove the SET line for this variable only
            let result = text.replace(
                new RegExp('\\bSET[ \\t]+@' + esc + '[ \\t]*:?=[ \\t]*[^;]*;?[ \\t]*\\n?', 'gi'), ''
            );
            // Strip blank lines left at the very start
            result = result.replace(/^([ \t]*\n)+/, '');

            // Substitute all @varName usages with the value
            result = result.replace(new RegExp('@' + esc + '(?!\\w)', 'g'), value);

            if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
            ta.value = result;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
        }

        bindVarBtn.addEventListener('click', _bindVarAtCursor);

        // Extract vars button — replace all occurrences of the selected text with
        // a generated @varN variable and prepend a SET declaration.
        const extractChk = document.getElementById('chk-sq-expand-extract');
        const extractBtn = document.getElementById('btn-sq-expand-extract');

        extractBtn.addEventListener('click', async () => {
            const text = ta.value;
            let selStart = ta.selectionStart;
            let selEnd   = ta.selectionEnd;

            // If no explicit selection, auto-expand to the token under the cursor.
            if (selStart === selEnd) {
                const pos = selStart;
                // Try expanding over word chars (letters, digits, _) — covers identifiers & numbers.
                let s = pos, e = pos;
                while (s > 0 && /\w/.test(text[s - 1])) s--;
                while (e < text.length && /\w/.test(text[e])) e++;

                if (s !== e) {
                    // If the word sits inside matching quotes, include them.
                    if (s > 0 && e < text.length) {
                        const q = text[s - 1];
                        if ((q === "'" || q === '"') && text[e] === q) { s--; e++; }
                    }
                } else if (pos < text.length && (text[pos] === "'" || text[pos] === '"')) {
                    // Cursor is directly on an opening/closing quote — select the whole string.
                    const q = text[pos];
                    e = pos + 1;
                    while (e < text.length && text[e] !== q) e++;
                    if (e < text.length) { s = pos; e++; }
                }

                if (s === e) {
                    _notify('Click on a value (number, identifier, or string) to extract it as a variable.', 'warn');
                    return;
                }
                selStart = s;
                selEnd   = e;
            }

            const selectedText = text.slice(selStart, selEnd);

            // If the selected token is immediately followed by '(…)', include the
            // full function call for extraction (e.g. NOW() → SET @v = NOW(); …
            // replaced with @v, not @v()).  The visual selection is unchanged.
            let extractText = selectedText;
            if (selEnd < text.length && text[selEnd] === '(') {
                let depth = 0, i = selEnd;
                while (i < text.length) {
                    if (text[i] === '(') depth++;
                    else if (text[i] === ')') { if (--depth === 0) { i++; break; } }
                    i++;
                }
                extractText = text.slice(selStart, i);
            }

            // Pick the next available @varN name (used as default / fallback)
            let n = 1;
            while (new RegExp('@var' + n + '\\b', 'i').test(ta.value)) n++;
            const defaultVarName = '@var' + n;

            // Ask the user for a variable name; empty input → use the default @varN
            const userInput = await Dialog.prompt('Variable name (leave empty for "' + defaultVarName + '"):', '');
            if (userInput === null) return; // cancelled
            const varName = userInput.trim() === ''
                ? defaultVarName
                : (userInput.trim().startsWith('@') ? userInput.trim() : '@' + userInput.trim());

            // Replace every exact occurrence of the extracted text
            const escaped   = extractText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const replaced  = ta.value.replace(new RegExp(escaped, 'g'), varName);

            // Build finalSql: prepend the SET declaration, ensure exactly 2 blank lines
            // between the last SET statement and the rest of the query.
            const declaration = 'SET ' + varName + ' = ' + extractText + ';';
            const rawFinal    = declaration + '\n' + replaced.replace(/^\n+/, '');
            const finalSql    = rawFinal.replace(
                /^((?:[ \t]*SET[ \t]+@[^\n]*\n)+)\n*/i,
                (_, setBlock) => setBlock.trimEnd() + '\n\n'
            );

            if (!extractChk.checked) {
                // NOT checked: apply in-place to the popup textarea (undoable)
                if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
                ta.value = finalSql;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
            } else {
                // Checked: create a new subquery, close the popup, activate new island
                const _parentCard  = _sqExpandTarget?.closest('.table-card');
                const _parentTable = State.tables.find(t => t.id === _parentCard?.dataset.tableId);
                _sqExpandSyncAndClose();
                addSubqueryWithSql(finalSql, _parentTable?.alias);
            }
        });

        // Disable extract controls while scope mode is active (selection isn't meaningful then)
        ta.addEventListener('backdrop-scopetoggle', e => {
            extractBtn.disabled = e.detail.scopeMode;
            extractChk.disabled = e.detail.scopeMode;
        });

        // Synchronously check whether the cursor sits on a @variable; returns the
        // variable name (without @) or null.  Used to gate preventDefault before async work.
        function _varAtCursor(ta) {
            const text = ta.value;
            const pos  = ta.selectionStart;
            let s = pos, end = pos;
            while (s > 0 && /\w/.test(text[s - 1])) s--;
            while (end < text.length && /\w/.test(text[end])) end++;
            if (s > 0 && text[s - 1] === '@') s--;
            if (s >= end || text[s] !== '@') return null;
            return text.slice(s + 1, end) || null;
        }

        // Rename the @variable under the cursor.  Returns true if "handled"
        // (either renamed or cancelled), false if cursor is not on a variable.
        async function _renameVarAtCursor(ta) {
            const varName = _varAtCursor(ta);
            if (!varName) return false;

            const esc       = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const userInput = await Dialog.prompt('Rename @' + varName + ' to:', '');
            if (userInput === null) return true; // cancelled — still "handled"

            const raw     = userInput.trim();
            const newName = raw.startsWith('@') ? raw.slice(1) : raw;
            if (!newName || !/^\w+$/.test(newName)) {
                _notify('Invalid variable name.', 'warn');
                return true;
            }

            const result = ta.value.replace(new RegExp('@' + esc + '(?!\\w)', 'g'), '@' + newName);
            if (result === ta.value) return true;

            if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
            ta.value = result;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
            return true;
        }

        // Alt+click on a variable — prompt to rename all instances.
        // Capture phase so it runs before the backdrop's bubble-phase click handler;
        // stopImmediatePropagation prevents the backdrop's word-highlight from firing.
        ta.addEventListener('click', async e => {
            if (!e.altKey || e.button !== 0) return;
            if (!_varAtCursor(ta)) return;
            // Synchronously block the backdrop's bubble-phase handler before awaiting
            e.preventDefault();
            e.stopImmediatePropagation();
            await _renameVarAtCursor(ta);
        }, true); // capture phase

        // F2 — if a word is highlighted (activeWord), prompt to rename all occurrences.
        //       Otherwise fall back to @variable rename at cursor.
        ta.addEventListener('keydown', async e => {
            if (e.key !== 'F2') return;
            e.preventDefault();
            e.stopImmediatePropagation();

            const activeWord = (typeof SqlBackdrop !== 'undefined') ? SqlBackdrop.getActiveWord(ta) : null;
            if (activeWord) {
                const newName = await Dialog.prompt('Rename item?', activeWord);
                if (newName === null) return; // cancelled
                const trimmed = newName.trim();
                if (!trimmed) return;
                const esc    = activeWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const result = ta.value.replace(new RegExp(`\\b${esc}\\b`, 'gi'), trimmed);
                if (result === ta.value) return;
                if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
                ta.value = result;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
                return;
            }

            await _renameVarAtCursor(ta);
        });

        // Scope mode
        _bindScopeMode(
            ta,
            document.getElementById('btn-sq-expand-scope'),
            document.getElementById('chk-sq-expand-scope-exclusive')
        );
        // Pressing ESC in this popup closes the modal (handled globally) rather
        // than clearing scope highlights, so disable the ESC-clears-scope behaviour.
        if (typeof SqlBackdrop !== 'undefined') SqlBackdrop.setEscClearsScope(ta, false);

        // ── Disassemble ────────────────────────────────────────────────────────
        // Enabled only when Scope mode is ON and the exclusive checkbox is NOT
        // checked (single-scope / exclusive mode → exactly one scope highlighted).
        const disassembleChk = document.getElementById('chk-sq-expand-disassemble');
        const disassembleBtn = document.getElementById('btn-sq-expand-disassemble');
        const _scopeBtn      = document.getElementById('btn-sq-expand-scope');
        const _chkExclusive  = document.getElementById('chk-sq-expand-scope-exclusive');

        const _syncDisassemble = scopeOn => {
            // chk checked = "multiple" = NOT exclusive; we want exclusive (single) mode
            const enabled = scopeOn && !_chkExclusive.checked;
            disassembleBtn.disabled = !enabled;
            disassembleChk.disabled = !enabled;
        };
        // Scope button click: _bindScopeMode's listener runs first (registered
        // earlier) and updates is-active, so we read the correct state here.
        // backdrop-scopetoggle is NOT dispatched on button click, only on Alt+S,
        // so we must also sync Extract vars here (its listener only covers Alt+S).
        _scopeBtn.addEventListener('click', () => {
            const scopeOn = _scopeBtn.classList.contains('is-active');
            extractBtn.disabled = scopeOn;
            extractChk.disabled = scopeOn;
            _syncDisassemble(scopeOn);
        });
        // Alt+S shortcut dispatches this event (Extract vars listener covers this path)
        ta.addEventListener('backdrop-scopetoggle', e => _syncDisassemble(e.detail.scopeMode));
        // Exclusive checkbox toggle
        _chkExclusive.addEventListener('change', () => _syncDisassemble(_scopeBtn.classList.contains('is-active')));

        disassembleBtn.addEventListener('click', () => {
            const focusRanges = (typeof SqlBackdrop !== 'undefined') ? SqlBackdrop.getFocusRanges(ta) : [];
            if (focusRanges.length === 0) {
                _notify('Select a scope first by clicking on a clause in scope mode.', 'warn');
                return;
            }
            const range  = focusRanges[0];
            const newSql = _disassembleScopeFromSql(ta.value, range);
            if (newSql === ta.value.trim()) {
                _notify('Nothing to disassemble in the selected scope.', 'warn');
                return;
            }
            if (!disassembleChk.checked) {
                // Unchecked: apply in-place (undoable)
                if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
                ta.value = newSql;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
            } else {
                // Checked: apply in-place AND extract the removed scope as a new subquery card
                const scopeText    = ta.value.slice(range.start, range.end).trim();
                const _parentCard  = _sqExpandTarget?.closest('.table-card');
                const _parentTable = State.tables.find(t => t.id === _parentCard?.dataset.tableId);
                if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
                ta.value = newSql;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
                _sqExpandSyncAndClose();
                addSubqueryWithSql(scopeText, _parentTable?.alias);
            }
        });
        // ──────────────────────────────────────────────────────────────────────

        // Real-time sync back to the card textarea while typing.
        // Skip when values are already equal (e.g. the programmatic input fired
        // during openSqExpand) so we don't cascade an input event onto the card
        // and inadvertently clear its scope highlights.
        ta.addEventListener('input', () => {
            if (!_sqExpandTarget) return;
            if (_sqExpandTarget.value === ta.value) return;
            _sqExpandTarget.value = ta.value;
            _sqExpandTarget.dispatchEvent(new Event('input'));
        });

        // Keyboard shortcuts inside the expand popup
        ta.addEventListener('keydown', e => {
            // Alt+E — close and restore cursor/scroll to parent textarea
            if (e.altKey && e.code === 'KeyE') {
                e.preventDefault();
                _sqExpandSyncAndClose();
                return;
            }
            // Alt+F — bind var under cursor (prevents canvas table-search shortcut)
            if (e.altKey && e.code === 'KeyF') {
                e.preventDefault();
                e.stopPropagation();
                _bindVarAtCursor();
                return;
            }
            // Alt+D — extract var (mimics Extract vars button click)
            if (e.altKey && e.code === 'KeyD') {
                e.preventDefault();
                e.stopPropagation();
                if (!extractBtn.disabled) extractBtn.click();
                return;
            }
            // Delete — disassemble selected scope (only when Disassemble is enabled)
            if (e.key === 'Delete' && !disassembleBtn.disabled) {
                e.preventDefault();
                e.stopPropagation();
                disassembleBtn.click();
                return;
            }
            // Delete — remove all selected scopes in multiple-scope mode
            if (e.key === 'Delete' && _chkExclusive.checked && _scopeBtn.classList.contains('is-active')) {
                const focusRanges = SqlBackdrop.getFocusRanges(ta);
                if (!focusRanges.length) return;
                e.preventDefault();
                e.stopPropagation();
                const newSql = _disassembleMultipleScopesFromSql(ta.value, focusRanges);
                if (newSql === ta.value.trim()) { _notify('Nothing to disassemble in the selected scopes.', 'warn'); return; }
                if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
                ta.value = newSql;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
                return;
            }
            // Shift+Enter — same as Alt+E (legacy shortcut kept)
            if (e.shiftKey && e.key === 'Enter') {
                e.preventDefault();
                _sqExpandSyncAndClose();
                return;
            }
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                const sql = ta.value.trim();
                if (sql) _runCustomQuery(sql);
            }
        });

        _bindTablesMenu(
            document.querySelector('#modal-sq-expand .btn-tables-trigger'),
            () => ta.value
        );

        // Help legend toggle
        const legendPanel = document.getElementById('sq-expand-legend');
        document.getElementById('btn-sq-expand-help').addEventListener('click', e => {
            e.stopPropagation();
            legendPanel.classList.toggle('hidden');
        });
        document.getElementById('btn-sq-expand-legend-close').addEventListener('click', () => {
            legendPanel.classList.add('hidden');
        });
        // Close when clicking outside the panel
        document.addEventListener('click', e => {
            if (!legendPanel.classList.contains('hidden') &&
                !legendPanel.contains(e.target) &&
                e.target.id !== 'btn-sq-expand-help') {
                legendPanel.classList.add('hidden');
            }
        });
    }

    // -------------------------------------------------------------------------
    // Import SQL to Canvas
    // -------------------------------------------------------------------------

    function _importStatusShow(msg, type) {
        const el = document.getElementById('import-query-status');
        el.textContent = msg;
        el.className   = 'import-query-status import-query-status--' + type;
        el.classList.remove('hidden');
    }

    function _importStatusHide() {
        document.getElementById('import-query-status').classList.add('hidden');
    }

    async function _importQueryExplain() {
        if (!State.activeProfileId) {
            _notify('No connection profile selected.', 'error');
            return;
        }
        const sql = _stripSqlComments(document.getElementById('import-query-textarea').value.trim()).trim();
        if (!sql) { _notify('Please paste a SQL query first.', 'warn'); return; }

        const btn = document.getElementById('btn-import-query-explain');
        btn.disabled    = true;
        btn.textContent = '⏳';

        _importStatusHide();

        try {
            const final      = _prepareForExplain(sql);
            const explainSql = /^explain\s/i.test(final) ? final : 'EXPLAIN ' + final;
            const result = await API.query.executeRaw(State.activeProfileId, explainSql);
            _importStatusShow(
                '✅ EXPLAIN OK — ' + result.count + ' row(s). Query looks valid.',
                'success'
            );
        } catch (e) {
            _importStatusShow('❌ ' + e.message, 'error');
        } finally {
            btn.disabled    = false;
            btn.textContent = '⚙ Explain';
        }
    }

    async function _importQueryRun() {
        if (!State.activeProfileId) {
            _notify('No connection profile selected.', 'error');
            return;
        }
        const sql = _stripSqlComments(document.getElementById('import-query-textarea').value.trim()).trim();
        if (!sql) { _notify('Please paste a SQL query first.', 'warn'); return; }

        const btn = document.getElementById('btn-import-query-run');
        btn.disabled    = true;
        btn.textContent = '⏳';

        _importStatusHide();

        let parsed;
        try {
            parsed = await API.query.parseFromSQL(State.activeProfileId, sql);
        } catch (e) {
            _importStatusShow('❌ ' + e.message, 'error');
            btn.disabled    = false;
            btn.textContent = '⇄ Import';
            return;
        }

        btn.disabled    = false;
        btn.textContent = '⇄ Import';

        // Build a summary of what will be imported for the confirmation message
        const appendMode = document.getElementById('chk-import-append').checked;
        const tableNames = (parsed.tables ?? []).map(t => `${t.name} (${t.alias})`).join(', ') || 'none';
        const joinCount  = (parsed.joins ?? []).length;
        const confirmMsg = appendMode
            ? 'This will ADD a new island to the canvas with the imported query.\n\n' +
              'Tables found: ' + tableNames + '\n' +
              'Joins found: ' + joinCount + '\n\n' +
              'Continue?'
            : 'This will CLEAR all current canvas tables, joins, and query conditions, then apply the imported query.\n\n' +
              'Tables found: ' + tableNames + '\n' +
              'Joins found: ' + joinCount + '\n\n' +
              'Continue?';

        if (!await Dialog.confirm(confirmMsg)) {
            return;
        }

        _applyImportResult(parsed, appendMode);
        document.getElementById('modal-import-query').classList.add('hidden');
        _notify('Query imported successfully.', 'success');
    }

    /**
     * Apply a parsed SQL structure (returned by query.parseFromSQL) to the canvas
     * and all config panel sections, clearing all existing state first.
     * When appendMode is true, existing canvas content is preserved and the imported
     * query is added as a new island instead.
     */
    function _applyImportResult(parsed, appendMode) {
        if (appendMode) { _applyImportResultAppend(parsed); return; }
        // --- Determine modes based on what was parsed ---
        const hasVisualSelect  = Array.isArray(parsed.select)  && parsed.select.length  > 0;
        const hasCustomExprs   = Array.isArray(parsed.selectCustomExprs) && parsed.selectCustomExprs.length > 0;
        const hasVisualGroupBy = Array.isArray(parsed.groupBy) && parsed.groupBy.length > 0;
        const hasVisualOrderBy = Array.isArray(parsed.orderBy) && parsed.orderBy.length > 0;

        // --- Full state reset + apply ---
        Object.assign(State, {
            tables:             parsed.tables ?? [],
            joins:              parsed.joins  ?? [],

            // SELECT — always visual; alias.col → checkboxes, everything else → custom exprs
            select:             parsed.select ?? [],
            selectRaw:          parsed.selectRaw ?? '',
            selectMode:         'visual',
            selectCustomExprs:     parsed.selectCustomExprs     ?? [],
            selectCustomExprsMode: parsed.selectCustomExprsMode ?? 'exclude',
            selectAliases:      parsed.selectAliases ?? {},
            // selectNone=true when there are only custom exprs and no alias.col items,
            // so the query doesn't produce "SELECT *, custom_expr"
            selectNone:         !hasVisualSelect && hasCustomExprs,
            selectAddDelimiter: false,
            selectSortAlpha:    false,
            selectDistinct:     false,

            // WHERE — always visual; conditions already parsed into structured rows
            // (complex expressions become {type:'raw', expr:...} rows, still shown visually)
            where:              parsed.whereConditions ?? [],
            whereRaw:           parsed.where ?? '',
            whereMode:          'visual',

            // GROUP BY
            groupBy:            hasVisualGroupBy ? parsed.groupBy : [],
            groupByRaw:         parsed.groupByRaw ?? '',
            groupByMode:        hasVisualGroupBy ? 'visual' : (parsed.groupByRaw ? 'raw' : 'visual'),

            // HAVING — visual when backend fully parsed it, raw when it contained
            // aggregate expressions that couldn't be split into simple condition rows
            having:             parsed.havingConditions ?? [],
            havingRaw:          parsed.having ?? '',
            havingMode:         (Array.isArray(parsed.havingConditions) && parsed.havingConditions.length > 0)
                                    ? 'visual'
                                    : (parsed.having ? 'raw' : 'visual'),

            // ORDER BY
            orderBy:            hasVisualOrderBy ? parsed.orderBy : [],
            orderByRaw:         parsed.orderByRaw ?? '',
            orderByMode:        hasVisualOrderBy ? 'visual' : (parsed.orderByRaw ? 'raw' : 'visual'),

            // LIMIT
            limit:              parsed.limit ?? 10,

            // Column order — rebuilt below from the table columns
            columnOrder:        [],

            // Context metadata — cleared
            loadedContextId:    null,
            loadedContextName:  null,
            notes:              '',
            // Island state — reset
            selectedIslandKey:  null,
            islandConfigs:      {},
            islandColors:       {},
            islandMinimized:    {},
        });

        // Ensure every table has a join-order value
        State.tables.forEach((t, i) => { if (t.order == null) t.order = i + 1; });

        // Normalize join fields added by Feature 2 (parser won't include them)
        State.joins.forEach(j => {
            j.color   = j.color   ?? null;
            j.enabled = j.enabled ?? true;
        });

        // Build columnOrder from the columns fetched for each table
        State.tables.forEach(t => {
            (t.columns ?? []).forEach(c => {
                const colName = typeof c === 'object' ? (c.name ?? '') : String(c);
                if (colName) {
                    const key = `${t.alias}.${colName}`;
                    if (!State.columnOrder.includes(key)) State.columnOrder.push(key);
                }
            });
        });

        // Sync LIMIT dropdown
        const limitSel = document.getElementById('limit-select');
        if (limitSel) {
            // Pick the closest available option value
            const available = [...limitSel.options].map(o => parseInt(o.value, 10));
            const target    = parsed.limit ?? 10;
            const best      = available.reduce((prev, cur) =>
                Math.abs(cur - target) < Math.abs(prev - target) ? cur : prev
            );
            limitSel.value = best;
            State.limit    = best;
        }

        // Initialize island config for the single imported island and activate it
        // (import always produces one connected set of tables)
        const _importIslandKey = _islandKey(State.tables.map(t => t.id));
        State.islandConfigs = {};
        State.islandConfigs[_importIslandKey] = {
            tableOrder: _currentTableOrder(_importIslandKey),
            ..._getRightPaneSnapshot(),
        };
        State.selectedIslandKey = _importIslandKey;

        // Rebuild canvas and all config panels
        Canvas.rebuildFromState(State);
        _updateCanvasCount();
        requestAnimationFrame(() => Canvas.focusTables());
        if (typeof QueryPanel !== 'undefined') QueryPanel.refresh();
        updateSQLPreview();

        // Clear the context title bar (no saved context)
        _updateContextTitle('');
        _updateSaveContextButton();
    }

    /**
     * Append a parsed SQL result as a new island without clearing existing canvas state.
     */
    function _applyImportResultAppend(parsed) {
        // Preserve the current island's right-pane state before touching State
        _flushCurrentIslandConfig();

        // Ensure each incoming table has a join-order value (after existing tables)
        const maxExistingOrder = State.tables.reduce((m, t) => Math.max(m, t.order ?? 0), 0);
        parsed.tables.forEach((t, i) => { if (t.order == null) t.order = maxExistingOrder + i + 1; });

        // Normalize join fields
        parsed.joins.forEach(j => {
            j.color   = j.color   ?? null;
            j.enabled = j.enabled ?? true;
        });

        // Compute island bounding boxes from live DOM cards (authoritative during/after drag)
        // so we can place the new island to the right of the closest (rightmost) existing island.
        const ISLAND_GAP  = 80;   // horizontal gap between island rects
        const IPAD        = 28;   // islands.js PADDING (sides)
        const IPAD_T      = 52;   // islands.js PADDING_TOP

        const existingEnabledJoins = State.joins.filter(j => j.enabled !== false);
        const existingIslands      = computeIslands(State.tables, existingEnabledJoins);

        // Build bounding box for each island from DOM card positions
        const islandBoxes = existingIslands.map(islandIds => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            let found = false;
            islandIds.forEach(id => {
                const card = document.querySelector(`.table-card[data-table-id="${id}"]`);
                if (!card) return;
                found = true;
                const x = parseInt(card.style.left, 10) || 0;
                const y = parseInt(card.style.top,  10) || 0;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x + card.offsetWidth);
                maxY = Math.max(maxY, y + card.offsetHeight);
            });
            // Expand to include island rect padding so the new island doesn't overlap it
            return found ? {
                minX: minX - IPAD,
                minY: minY - IPAD_T,
                maxX: maxX + IPAD,
                maxY: maxY + IPAD,
            } : null;
        }).filter(Boolean);

        let offsetX, startY;
        if (islandBoxes.length === 0) {
            // No existing tables — place in the center of the canvas
            const canvasEl = document.getElementById('canvas');
            offsetX = Math.round(canvasEl.offsetWidth  / 2 - 110);
            startY  = Math.round(canvasEl.offsetHeight / 2 - 100);
        } else {
            // Find the rightmost island (greatest maxX) and place to its right
            const rightmost = islandBoxes.reduce((best, b) => b.maxX > best.maxX ? b : best);
            offsetX = rightmost.maxX + ISLAND_GAP;
            startY  = rightmost.minY + IPAD_T; // align top with the rightmost island's table area
        }

        // Assign positions on incoming tables (stacked vertically under each other)
        let newY = startY;
        parsed.tables.forEach(t => {
            t.position = { x: offsetX, y: newY };
            newY += 260;
        });

        // Append to State
        State.tables.push(...parsed.tables);
        State.joins.push(...parsed.joins);

        // Extend columnOrder with new table columns
        parsed.tables.forEach(t => {
            (t.columns ?? []).forEach(c => {
                const colName = typeof c === 'object' ? (c.name ?? '') : String(c);
                if (colName) {
                    const key = `${t.alias}.${colName}`;
                    if (!State.columnOrder.includes(key)) State.columnOrder.push(key);
                }
            });
        });

        // Build the new island key and its right-pane snapshot from the parsed data
        const newKey = _islandKey(parsed.tables.map(t => t.id));

        const hasVisualSelect  = Array.isArray(parsed.select)           && parsed.select.length           > 0;
        const hasCustomExprs   = Array.isArray(parsed.selectCustomExprs) && parsed.selectCustomExprs.length > 0;
        const hasVisualGroupBy = Array.isArray(parsed.groupBy)          && parsed.groupBy.length          > 0;
        const hasVisualOrderBy = Array.isArray(parsed.orderBy)          && parsed.orderBy.length          > 0;

        const newIslandSnap = {
            tableOrder:         _currentTableOrder(newKey),
            select:             parsed.select             ?? [],
            selectRaw:          parsed.selectRaw          ?? '',
            selectMode:         'visual',
            selectCustomExprs:     parsed.selectCustomExprs     ?? [],
            selectCustomExprsMode: parsed.selectCustomExprsMode ?? 'exclude',
            selectAliases:         parsed.selectAliases         ?? {},
            selectNone:            !hasVisualSelect && hasCustomExprs,
            selectAddDelimiter: false,
            selectSortAlpha:    false,
            selectDistinct:     false,
            where:              parsed.whereConditions    ?? [],
            whereRaw:           parsed.where              ?? '',
            whereMode:          'visual',
            groupBy:            hasVisualGroupBy ? parsed.groupBy : [],
            groupByRaw:         parsed.groupByRaw         ?? '',
            groupByMode:        hasVisualGroupBy ? 'visual' : (parsed.groupByRaw ? 'raw' : 'visual'),
            having:             parsed.havingConditions   ?? [],
            havingRaw:          parsed.having             ?? '',
            havingMode:         (Array.isArray(parsed.havingConditions) && parsed.havingConditions.length > 0)
                                    ? 'visual' : (parsed.having ? 'raw' : 'visual'),
            orderBy:            hasVisualOrderBy ? parsed.orderBy : [],
            orderByRaw:         parsed.orderByRaw         ?? '',
            orderByMode:        hasVisualOrderBy ? 'visual' : (parsed.orderByRaw ? 'raw' : 'visual'),
            limit:              parsed.limit              ?? 10,
            calculus:           null,
        };

        // Store config, switch selected island, apply snapshot to top-level State
        State.islandConfigs[newKey] = newIslandSnap;
        State.selectedIslandKey     = newKey;
        _applyRightPaneSnapshot(newIslandSnap);

        // Sync LIMIT dropdown to the new island's limit
        const limitSel = document.getElementById('limit-select');
        if (limitSel) {
            const available = [...limitSel.options].map(o => parseInt(o.value, 10));
            const target    = newIslandSnap.limit;
            const best      = available.reduce((prev, cur) =>
                Math.abs(cur - target) < Math.abs(prev - target) ? cur : prev
            );
            limitSel.value = best;
            State.limit    = best;
        }

        // Rebuild canvas and refresh UI; then scroll to center the newly added island
        Canvas.rebuildFromState(State);
        _updateCanvasCount();
        requestAnimationFrame(() => {
            const newCards = parsed.tables
                .map(t => document.querySelector(`.table-card[data-table-id="${t.id}"]`))
                .filter(Boolean);
            if (!newCards.length) return;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            newCards.forEach(c => {
                const x = parseInt(c.style.left, 10) || 0;
                const y = parseInt(c.style.top,  10) || 0;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x + c.offsetWidth);
                maxY = Math.max(maxY, y + c.offsetHeight);
            });
            Canvas.scrollToLogicalBoundingBox(minX, minY, maxX, maxY);
        });
        if (typeof QueryPanel !== 'undefined') QueryPanel.refresh();
        updateSQLPreview();
    }

    // -------------------------------------------------------------------------
    // Context Copy / Paste
    // -------------------------------------------------------------------------
    function _currentRawQuery() {
        const sql = document.getElementById('sql-preview-text').textContent || '';
        if (sql.startsWith('--')) return '';
        return sql.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    }

    /** Capture full context as a JSON string for the undo stack (no clipboard side-effect). */
    function captureSnapshot() {
        _flushCurrentIslandConfig();
        _flushBackdropAnnotations();
        const ctx = { version: APP_VERSION, ...State, raw_query: _currentRawQuery(), customQuery: document.getElementById('custom-query-textarea').value, allMinimized: QueryPanel.getAllMinimized() };
        return JSON.stringify(ctx);
    }

    function applyContext(json, contextName = '', opts = {}) {
        try {
            const parsed = JSON.parse(json);
            const _prevWhereRaw  = State.whereRaw;
            const _prevWhereMode = State.whereMode;

            // Basic validation
            if (typeof parsed !== 'object' || !Array.isArray(parsed.tables)) {
                throw new Error('Invalid context: missing tables array.');
            }

            // Reset state
            Object.assign(State, {
                tables:         parsed.tables         ?? [],
                joins:          parsed.joins          ?? [],
                select:             parsed.select             ?? [],
                selectRaw:          parsed.selectRaw          ?? '',
                selectMode:         parsed.selectMode         ?? 'visual',
                selectAddDelimiter: parsed.selectAddDelimiter ?? false,
                selectSortAlpha:    parsed.selectSortAlpha    ?? false,
                selectSchemaAlias:  parsed.selectSchemaAlias  ?? true,
                selectTableName:    parsed.selectTableName    ?? false,
                selectCustomExprs:     parsed.selectCustomExprs     ?? [],
                selectCustomExprsMode: parsed.selectCustomExprsMode ?? 'exclude',
                where:          parsed.where          ?? [],
                orderBy:        parsed.orderBy        ?? [],
                orderByRaw:     parsed.orderByRaw     ?? '',
                whereRaw:       parsed.whereRaw       ?? '',
                whereMode:      parsed.whereMode      ?? 'visual',
                orderByMode:    parsed.orderByMode    ?? 'visual',
                limit:          parsed.limit          ?? 10,
                activeDatabase: parsed.activeDatabase ?? State.activeDatabase ?? null,
                notes:          parsed.notes          ?? '',
                selectedIslandKey: parsed.selectedIslandKey ?? null,
                islandConfigs:     parsed.islandConfigs     ?? {},
                islandColors:    (!parsed.islandColors    || Array.isArray(parsed.islandColors))    ? {} : parsed.islandColors,
                islandMinimized: (!parsed.islandMinimized || Array.isArray(parsed.islandMinimized)) ? {} : parsed.islandMinimized,
                islandNames:       (!parsed.islandNames       || Array.isArray(parsed.islandNames))       ? {} : parsed.islandNames,
                islandNotesDetail: (!parsed.islandNotesDetail || Array.isArray(parsed.islandNotesDetail)) ? {} : parsed.islandNotesDetail,
                bookmarks:            parsed.bookmarks            ?? {},
                backdropAnnotations:  parsed.backdropAnnotations  ?? {},
                sqExpandScopeMemory:  parsed.sqExpandScopeMemory  ?? false,
                customQueryHighlight: parsed.customQueryHighlight ?? false,
                islandPinnedPlots:  (!parsed.islandPinnedPlots  || Array.isArray(parsed.islandPinnedPlots))  ? {} : parsed.islandPinnedPlots,
                islandPinSortOrder: (!parsed.islandPinSortOrder || Array.isArray(parsed.islandPinSortOrder)) ? {} : parsed.islandPinSortOrder,
            });

            if (opts.preserveWhereRaw && _prevWhereMode === 'raw') {
                State.whereRaw  = _prevWhereRaw;
                State.whereMode = 'raw';
            }

            // Ensure every table has a join-order value (old contexts won't have it)
            State.tables.forEach((t, i) => { if (t.order == null) t.order = i + 1; });

            // Restore custom query textarea
            if (parsed.customQuery !== undefined) {
                const cqTa = document.getElementById('custom-query-textarea');
                cqTa.value = parsed.customQuery;
                cqTa.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // Restore custom query highlight checkbox + backdrop
            (() => {
                const chk  = document.getElementById('chk-custom-query-html');
                const cqTa = document.getElementById('custom-query-textarea');
                if (!chk || !cqTa) return;
                chk.checked = !!State.customQueryHighlight;
                if (typeof SqlBackdrop === 'undefined') return;
                if (State.customQueryHighlight) {
                    SqlBackdrop.attach(cqTa);
                } else {
                    SqlBackdrop.detach(cqTa);
                }
            })();

            // Sync the database list to match the restored activeDatabase
            const dbList = document.getElementById('db-select');
            if (dbList && State.activeDatabase) {
                const existing = [...dbList.querySelectorAll('li[data-db]')]
                    .find(li => li.dataset.db === State.activeDatabase);
                if (!existing) {
                    dbList.appendChild(_createDbListItem(State.activeDatabase));
                }
                _markActiveDb();
            }

            // Update LIMIT dropdown to match
            document.getElementById('limit-select').value = State.limit;

            Canvas.rebuildFromState(State);
            _updateCanvasCount();
            // Restore backdrop annotations (line colours + scope highlights).
            // Must run after rebuildFromState so subquery textarea elements exist.
            if (typeof SqlBackdrop !== 'undefined' && State.backdropAnnotations) {
                SqlBackdrop.applyAnnotations(State.backdropAnnotations);
            }
            requestAnimationFrame(() => Canvas.focusTables());

            // Blit the active island config so the right-pane reflects the loaded state.
            // For new contexts: island configs live inside islandConfigs[key].
            // For old contexts (no islandConfigs): fall back to top-level fields already
            //   loaded into State above, then restore legacy top-level calculus.
            const hasIslandConfigs = parsed.islandConfigs && Object.keys(parsed.islandConfigs).length > 0;
            if (hasIslandConfigs && State.selectedIslandKey) {
                blitIslandConfig(State.selectedIslandKey);
            } else if (hasIslandConfigs) {
                // No island selected yet — apply the first/only island config if just one island
                const enabledJoins = State.joins.filter(j => j.enabled !== false);
                const islands = computeIslands(State.tables, enabledJoins);
                if (islands.length === 1) {
                    const key = islands[0].sort().join('|');
                    State.selectedIslandKey = key;
                    blitIslandConfig(key);
                } else {
                    if (typeof QueryPanel !== 'undefined') QueryPanel.refresh();
                    updateSQLPreview();
                }
            } else {
                // Old context — no islandConfigs; fields already in State, restore legacy calculus
                if (typeof QueryPanel !== 'undefined') QueryPanel.refresh();
                updateSQLPreview();
                if (typeof Results !== 'undefined') {
                    Results.calcRestoreFromContext(parsed.calculus ?? null);
                }
            }

            // Apply minimize-all after QueryPanel.refresh() so the btn-select-minimize
            // buttons exist in the DOM before we simulate clicking them.
            if (typeof QueryPanel !== 'undefined') QueryPanel.setAllMinimized(parsed.allMinimized ?? false);

            _updateContextTitle(contextName);
            if (typeof SqlBackdrop !== 'undefined') SqlBackdrop.refreshAllBookmarks();
            _lastSavedJson = _buildSaveJson();

            // Rebuild any pinned plot thumbnails from restored state
            if (typeof Islands !== 'undefined' && Islands.renderAllPinContainers) {
                requestAnimationFrame(() => Islands.renderAllPinContainers());
            }

            // Refresh the sidebar table list for the restored database so that
            // on-canvas markers and the db-select reflect the loaded context.
            loadTables();

        } catch (e) {
            _notify('Error: ' + e.message, 'error');
        }
    }

    /** Sync the topbar span and document <title> with the currently loaded context name. */
    function _updateContextTitle(name) {
        const span = document.getElementById('topbar-notes-title');
        span.textContent = name || '';
        span.title = name || '';
        span.setAttribute('alt', name || '');
        document.title = name ? `${BASE_PAGE_TITLE} - ${name}` : BASE_PAGE_TITLE;
    }

    // -------------------------------------------------------------------------
    // Event binding helpers
    // -------------------------------------------------------------------------
    function bindTopbar() {
        document.getElementById('profile-select')
            .addEventListener('change', async e => {
                if (e.target.value) await _activateProfile(e.target.value);
            });

        document.getElementById('db-schema-search')
            .addEventListener('input', _filterDbSelect);

        document.getElementById('btn-refresh-tables')
            .addEventListener('click', loadTables);

        document.getElementById('btn-focus-tables')
            .addEventListener('click', () => Canvas.focusTables());

        const _overviewZoomBtn = document.getElementById('btn-canvas-overview-zoom');
        if (_overviewZoomBtn) {
            _overviewZoomBtn.addEventListener('click', () => {
                const on = !document.body.classList.contains('is-canvas-overview-zoom');
                _applyOverviewZoom(on);
            });
        }

        // Timestamp converter popup
        (() => {
            const modal   = document.getElementById('modal-timestamp-conv');
            const leftEl  = document.getElementById('ts-conv-left');
            const rightEl = document.getElementById('ts-conv-right');
            const status  = document.getElementById('ts-conv-status');

            document.getElementById('btn-timestamp-conv').addEventListener('click', () => {
                modal.classList.toggle('hidden');
                if (!modal.classList.contains('hidden')) leftEl.focus();
            });

            modal.querySelectorAll('.modal-close').forEach(btn =>
                btn.addEventListener('click', () => modal.classList.add('hidden'))
            );

            let _tsTimer = null;
            function _tsConvert(value, direction, targetEl) {
                clearTimeout(_tsTimer);
                if (!value.trim()) { targetEl.value = ''; status.textContent = ''; return; }
                _tsTimer = setTimeout(async () => {
                    const profileId = State.activeProfileId;
                    if (!profileId) {
                        status.textContent = 'No active connection — select a profile first.';
                        return;
                    }
                    status.textContent = '…';
                    try {
                        const data = await API.timestamp.convert(profileId, value.trim(), direction);
                        targetEl.value  = data.result ?? '';
                        status.textContent = data.result === null ? 'MySQL returned NULL (invalid input).' : '';
                    } catch (e) {
                        status.textContent = e.message;
                        targetEl.value = '';
                    }
                }, 400);
            }

            leftEl.addEventListener('input',  () => _tsConvert(leftEl.value,  'to_datetime', rightEl));
            rightEl.addEventListener('input', () => _tsConvert(rightEl.value, 'to_unix',     leftEl));
        })();

        // Topbar menu — toggle open/close
        const _menuEl = document.getElementById('topbar-menu');
        document.getElementById('btn-menu-trigger')
            .addEventListener('click', e => {
                e.stopPropagation();
                _menuEl.classList.toggle('is-open');
            });

        // Close menu when clicking outside
        document.addEventListener('click', () => _menuEl.classList.remove('is-open'));

        document.getElementById('menu-test-connection')
            .addEventListener('click', async () => {
                _menuEl.classList.remove('is-open');
                if (!State.activeProfileId) {
                    _notify('No profile selected.', 'warn');
                    return;
                }
                try {
                    await API.profiles.test({ id: State.activeProfileId });
                    _notify('✅ Connection successful', 'success');
                } catch (e) {
                    _notify('❌ Connection failed: ' + e.message, 'error');
                }
            });

        document.getElementById('menu-show-shortcuts')
            .addEventListener('click', () => {
                _menuEl.classList.remove('is-open');
                Modals.openShortcuts();
            });

        document.getElementById('app-logo')
            .addEventListener('click', () => document.getElementById('menu-about').click());

        document.getElementById('menu-about')
            .addEventListener('click', async () => {
                _menuEl.classList.remove('is-open');
                const modal    = document.getElementById('modal-about');
                const textarea = document.getElementById('about-content');
                textarea.value = 'Loading…';
                modal.classList.remove('hidden');
                try {
                    const data = await API.about.read();
                    textarea.value = data.content;
                } catch (e) {
                    textarea.value = 'Failed to load about.php: ' + e.message;
                }
            });

        document.getElementById('btn-manage-profiles')
            .addEventListener('click', () => Modals.openProfiles());

        document.getElementById('btn-show-notes')
            .addEventListener('click', () => Modals.openNotes());

        document.getElementById('btn-save-context').addEventListener('click', async () => {
            if (State.loadedContextId) {
                _saveLoadedContext();
            } else {
                const name = await Dialog.prompt('Save context as:', '');
                if (name === null || !name.trim()) return;
                _saveContext(name.trim());
            }
        });

        document.getElementById('btn-new-context-shortcut').addEventListener('click', async () => {
            if (!await Dialog.confirm('Starting a new context will clear the canvas and lose all unsaved changes. Continue?')) return;
            applyContext(JSON.stringify({ tables: [], joins: [] }));
            State.loadedContextId   = null;
            State.loadedContextName = null;
            _updateSaveContextButton();
        });

        document.getElementById('topbar-notes-title').addEventListener('click', () => {
            document.getElementById('modal-context').classList.remove('hidden');
        });

        document.getElementById('notes-textarea')
            .addEventListener('input', e => { State.notes = e.target.value; });

        _updateSaveContextButton();
    }

    function bindBottombar() {
        document.getElementById('sql-preview-bar')
            .addEventListener('click', () => Modals.openSqlPreview());

        document.getElementById('btn-run-query')
            .addEventListener('click', runQuery);

        document.getElementById('btn-cancel-query')
            .addEventListener('click', _cancelRunningQuery);

        document.getElementById('btn-explain-query')
            .addEventListener('click', runExplainQuery);

        document.getElementById('btn-plot-query')
            .addEventListener('click', runPlotQuery);

        document.getElementById('btn-ai-knowledge')
            .addEventListener('click', runAiKnowledge);

        document.getElementById('btn-copy-explain')
            .addEventListener('click', _copyExplainSql);

        document.getElementById('btn-copy-sql')
            .addEventListener('click', _copySql);

        document.getElementById('btn-load-context')
            .addEventListener('click', () => Modals.openContext());

        const _ctxSearchEl = document.getElementById('ctx-search-input');
        _ctxSearchEl.addEventListener('input', _filterContextList);
        Autocomplete.attach(_ctxSearchEl, {
            getSuggestions: () =>
                Array.from(document.querySelectorAll('#ctx-saved-list .ctx-row .ctx-row__name'))
                     .map(el => el.textContent.trim()),
            onSelect: name => {
                _filterContextList();
                const row = Array.from(document.querySelectorAll('#ctx-saved-list .ctx-row'))
                    .find(r => r.querySelector('.ctx-row__name')?.textContent.trim() === name);
                row?.click();
            },
        });
    }

    function _copySql() {
        const sql = document.getElementById('sql-preview-text').textContent;
        if (!sql || sql.startsWith('--')) {
            _notify('No SQL to copy yet.', 'warn');
            return;
        }
        navigator.clipboard.writeText(sql)
            .then(() => {
                const btn = document.getElementById('btn-copy-sql');
                const orig = btn.textContent;
                btn.textContent = '✓ Copied!';
                setTimeout(() => (btn.textContent = orig), 1800);
            })
            .catch(() => _notify('Clipboard write failed.', 'error'));
    }

    function _copyExplainSql() {
        const sql = document.getElementById('sql-preview-text').textContent;
        if (!sql || sql.startsWith('--')) {
            _notify('No SQL to copy yet.', 'warn');
            return;
        }
        navigator.clipboard.writeText('EXPLAIN ' + sql)
            .then(() => {
                const btn = document.getElementById('btn-copy-explain');
                const orig = btn.textContent;
                btn.textContent = '✓ Copied!';
                setTimeout(() => (btn.textContent = orig), 1800);
            })
            .catch(() => _notify('Clipboard write failed.', 'error'));
    }

    /**
     * Make a floating box draggable via a handle element.
     * Works for both position:absolute-in-modal and position:fixed popups.
     * On mousedown the current transform-based centering is resolved to px
     * so subsequent drag moves are pure left/top offsets.
     */
    function _makeDraggable(box, handle) {
        handle.addEventListener('mousedown', e => {
            if (e.target.closest('button')) return;   // don't steal button clicks
            if (box.id === 'calculus-toolbox' && box.classList.contains('is-maximized')) return;

            const r = box.getBoundingClientRect();
            // Resolve CSS transform-centering to concrete pixel coords
            box.style.transform = 'none';
            box.style.left      = r.left + 'px';
            box.style.top       = r.top  + 'px';

            const ox = e.clientX - r.left;
            const oy = e.clientY - r.top;

            document.body.style.userSelect = 'none';

            function onMove(ev) {
                let x = ev.clientX - ox;
                let y = ev.clientY - oy;
                x = Math.max(0, Math.min(window.innerWidth  - box.offsetWidth,  x));
                y = Math.max(0, Math.min(window.innerHeight - box.offsetHeight, y));
                box.style.left = x + 'px';
                box.style.top  = y + 'px';
            }

            function onUp() {
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup',   onUp);
            }

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup',   onUp);
            e.preventDefault();
        });
    }

    /**
     * Make a fixed/absolute box resizable by dragging edge/corner handles.
     * Each handle must carry a data-dir attribute: "e" | "s" | "se".
     * On drag-start the box is converted to explicit left/top coordinates
     * (same pattern as _makeDraggable) so right/bottom anchoring doesn't
     * interfere with the resize math.
     */
    function _makeResizable(box) {
        const MIN_W = 320;
        let   MIN_H = 150;

        box.querySelectorAll('.calculus-resize-handle').forEach(handle => {
            handle.addEventListener('mousedown', e => {
                e.preventDefault();
                e.stopPropagation(); // must not trigger drag on the header

                // Capture the box's natural height as the minimum before the first
                // explicit resize — handles popups that are shorter than 150px by default.
                if (!box.style.height && box.offsetHeight < MIN_H) {
                    MIN_H = box.offsetHeight;
                }

                // Resolve any right/transform-based positioning to explicit left+top
                const r = box.getBoundingClientRect();
                box.style.transform = 'none';
                box.style.left      = r.left + 'px';
                box.style.top       = r.top  + 'px';
                box.style.right     = '';
                box.style.bottom    = '';
                // Let the user fully control dimensions — drop CSS constraints
                box.style.maxWidth  = 'none';
                box.style.maxHeight = 'none';

                const dir    = handle.dataset.dir;
                const startX = e.clientX;
                const startY = e.clientY;
                const startW = box.offsetWidth;
                const startH = box.offsetHeight;

                document.body.style.userSelect = 'none';

                function onMove(ev) {
                    const dx = ev.clientX - startX;
                    const dy = ev.clientY - startY;

                    if (dir === 'e' || dir === 'se') {
                        const maxW = window.innerWidth - box.getBoundingClientRect().left;
                        box.style.width = Math.max(MIN_W, Math.min(maxW, startW + dx)) + 'px';
                    }
                    if (dir === 's' || dir === 'se') {
                        const maxH = window.innerHeight - box.getBoundingClientRect().top;
                        box.style.height = Math.max(MIN_H, Math.min(maxH, startH + dy)) + 'px';
                    }
                }

                function onUp() {
                    document.body.style.userSelect = '';
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup',   onUp);
                }

                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup',   onUp);
            });
        });
    }

    function bindModals() {
        // Close buttons inside modals
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => {
                const modal = btn.closest('.modal');
                if (modal.id === 'modal-sq-expand') { _sqExpandSyncAndClose(); return; }
                modal.classList.add('hidden');
            });
        });

        // Click backdrop to close (notes modal uses its own close logic)
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', e => {
                if (e.target !== modal) return;
                if (modal.id === 'modal-notes')    { Modals.closeNotes();       return; }
                if (modal.id === 'modal-sq-expand') { _sqExpandSyncAndClose();  return; }
                modal.classList.add('hidden');
            });
        });

        // Make each modal-box draggable via its header.
        // A MutationObserver resets the position to centered every time
        // the modal is re-opened (hidden class removed).

        // Modals that open maximised by default (contain backdrop textareas or are
        // the Notes modal).  The observer maximises them right after resetting the
        // position so the timing is always correct with no extra setTimeout needed.
        const _AUTO_MAXIMIZE = new Set([
            'modal-notes',
            'modal-custom-query',
            'modal-sq-expand',
            'modal-import-query',
            'modal-sql',
            'modal-create-statement',
            'modal-about',
        ]);

        document.querySelectorAll('.modal').forEach(modal => {
            const box    = modal.querySelector('.modal-box');
            const header = box && box.querySelector('.modal-header');
            if (!box || !header) return;

            _makeDraggable(box, header);

            new MutationObserver(() => {
                if (!modal.classList.contains('hidden')) {
                    // Reset to CSS default (top:50% left:50% transform:-50%)
                    box.style.left      = '';
                    box.style.top       = '';
                    box.style.transform = '';
                    // Auto-maximise on open for designated modals
                    if (_AUTO_MAXIMIZE.has(modal.id) && box.dataset.maximized !== '1') {
                        _toggleMaximizePopup(box);
                    }
                }
            }).observe(modal, { attributes: true, attributeFilter: ['class'] });
        });

        // Calculus toolbox — draggable via its header, resizable via edge/corner handles
        _makeDraggable(
            document.getElementById('calculus-toolbox'),
            document.getElementById('calculus-toolbox-header')
        );
        _makeResizable(document.getElementById('calculus-toolbox'));

        // Calculus history popup — draggable + resizable
        _makeDraggable(
            document.getElementById('calculus-history-popup'),
            document.getElementById('calculus-history-header')
        );
        _makeResizable(document.getElementById('calculus-history-popup'));

        // Calculus math calculator popup — draggable + resizable
        _makeDraggable(
            document.getElementById('calculus-math-popup'),
            document.getElementById('calculus-math-header')
        );
        _makeResizable(document.getElementById('calculus-math-popup'));

        // Notes modal buttons
        document.getElementById('btn-notes-save').addEventListener('click', () => {
            Modals.saveNotes();
            // After saving, close the notes modal without prompting.
            Modals.closeNotes();
        });
        document.getElementById('btn-notes-x').addEventListener('click', () => Modals.closeNotes());

        // Save Value Editor
        document.getElementById('btn-save-value').addEventListener('click', () => {
            if (Modals._onValueSave) {
                const val = document.getElementById('value-editor-input').value;
                Modals._onValueSave(val);
                document.getElementById('modal-value-editor').classList.add('hidden');
            }
        });

        // Custom Query modal
        document.getElementById('btn-run-custom-query').addEventListener('click', () => {
            document.getElementById('modal-custom-query').classList.remove('hidden');
            document.getElementById('custom-query-textarea').focus();
        });

        // Custom query highlight checkbox — attach/detach SqlBackdrop, persist in State
        (() => {
            const chk  = document.getElementById('chk-custom-query-html');
            const cqTa = document.getElementById('custom-query-textarea');
            chk.checked = !!State.customQueryHighlight;
            if (State.customQueryHighlight && typeof SqlBackdrop !== 'undefined') {
                SqlBackdrop.attach(cqTa);
            }
            chk.addEventListener('change', () => {
                State.customQueryHighlight = chk.checked;
                if (typeof SqlBackdrop === 'undefined') return;
                if (chk.checked) {
                    SqlBackdrop.attach(cqTa);
                } else {
                    SqlBackdrop.detach(cqTa);
                }
            });
        })();

        // ? legend toggle
        (() => {
            const helpBtn  = document.getElementById('btn-custom-query-help');
            const legend   = document.getElementById('custom-query-legend');
            const closeBtn = document.getElementById('btn-custom-query-legend-close');
            helpBtn .addEventListener('click', () => legend.classList.toggle('hidden'));
            closeBtn.addEventListener('click', () => legend.classList.add('hidden'));
        })();

        document.getElementById('btn-custom-query-run').addEventListener('click', () => _runCustomQuery());

        document.getElementById('btn-custom-query-explain').addEventListener('click', () => {
            const ta = document.getElementById('custom-query-textarea');
            const sql = ta.value.trim();
            if (!sql) { _notify('Please enter a SQL query.', 'warn'); return; }
            const final = _prepareForExplain(sql);
            _runCustomQuery(/^explain\s/i.test(final) ? final : 'EXPLAIN ' + final);
        });

        document.getElementById('btn-custom-query-format').addEventListener('click', () => {
            _formatTextareaSql(document.getElementById('custom-query-textarea'));
        });

        _bindScopeMode(
            document.getElementById('custom-query-textarea'),
            document.getElementById('btn-custom-query-scope'),
            document.getElementById('chk-custom-query-scope-exclusive')
        );

        document.getElementById('custom-query-textarea').addEventListener('keydown', async e => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                _runCustomQuery();
                return;
            }
            // Delete — remove selected scope(s) when scope mode is on
            if (e.key === 'Delete') {
                const scopeBtn = document.getElementById('btn-custom-query-scope');
                const scopeChk = document.getElementById('chk-custom-query-scope-exclusive');
                const scopeOn  = scopeBtn?.classList.contains('is-active') ?? false;
                if (scopeOn && typeof SqlBackdrop !== 'undefined') {
                    const focusRanges = SqlBackdrop.getFocusRanges(e.currentTarget);
                    if (focusRanges.length) {
                        e.preventDefault();
                        const ta2    = e.currentTarget;
                        const multiple = scopeChk?.checked ?? false;
                        const newSql = multiple
                            ? _disassembleMultipleScopesFromSql(ta2.value, focusRanges)
                            : _disassembleScopeFromSql(ta2.value, focusRanges[0]);
                        if (newSql === ta2.value.trim()) {
                            _notify('Nothing to disassemble in the selected scope(s).', 'warn');
                            return;
                        }
                        if (typeof UndoManager !== 'undefined') UndoManager.push(ta2);
                        ta2.value = newSql;
                        ta2.dispatchEvent(new Event('input', { bubbles: true }));
                        if (typeof UndoManager !== 'undefined') UndoManager.push(ta2);
                        return;
                    }
                }
            }
            if (e.key === 'F2') {
                e.preventDefault();
                const ta2 = e.currentTarget;
                const activeWord = (typeof SqlBackdrop !== 'undefined') ? SqlBackdrop.getActiveWord(ta2) : null;
                if (!activeWord) return;
                const newName = await Dialog.prompt('Rename item?', activeWord);
                if (newName === null) return;
                const trimmed = newName.trim();
                if (!trimmed) return;
                const esc    = activeWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const result = ta2.value.replace(new RegExp(`\\b${esc}\\b`, 'gi'), trimmed);
                if (result === ta2.value) return;
                if (typeof UndoManager !== 'undefined') UndoManager.push(ta2);
                ta2.value = result;
                ta2.dispatchEvent(new Event('input', { bubbles: true }));
                if (typeof UndoManager !== 'undefined') UndoManager.push(ta2);
            }
        });

        // ── .sql file drag-and-drop onto the Custom Query modal ───────────────
        (() => {
            const modal   = document.getElementById('modal-custom-query');
            const ta      = document.getElementById('custom-query-textarea');
            let _dragCounter = 0;   // track nested dragenter/dragleave pairs

            // Create a drop overlay shown while dragging over the modal
            const overlay = document.createElement('div');
            overlay.className = 'sql-drop-overlay';
            overlay.textContent = 'Drop .sql or .csv file to load';
            modal.appendChild(overlay);

            const _isAccepted = dt =>
                dt && [...dt.items].some(it => it.kind === 'file' &&
                    (it.type === 'application/sql' || it.type === 'text/csv' ||
                     it.type === 'text/plain'      || it.type === '' ||
                     it.type.startsWith('text/')));

            modal.addEventListener('dragenter', e => {
                e.preventDefault();
                _dragCounter++;
                if (_isAccepted(e.dataTransfer)) overlay.classList.add('visible');
            });
            modal.addEventListener('dragover', e => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            });
            modal.addEventListener('dragleave', () => {
                if (--_dragCounter <= 0) { _dragCounter = 0; overlay.classList.remove('visible'); }
            });
            modal.addEventListener('drop', e => {
                e.preventDefault();
                _dragCounter = 0;
                overlay.classList.remove('visible');

                const file = [...e.dataTransfer.files].find(f => {
                    const n = f.name.toLowerCase();
                    return n.endsWith('.sql') || n.endsWith('.csv') || f.type.startsWith('text/');
                });
                if (!file) { _notify('Please drop a .sql or .csv file.', 'warn'); return; }
                _loadFile(file);
            });

            /** Shared file-load logic used by both drag-drop and the Load File button. */
            function _loadFile(file) {
                const reader = new FileReader();
                reader.onerror = () => _notify('Could not read file.', 'error');
                reader.onload = ev => {
                    const raw   = ev.target.result;
                    const isCsv = file.name.toLowerCase().endsWith('.csv');
                    let result;
                    if (isCsv) {
                        result = _csvToUnionSql(raw);
                        if (!result) { _notify('CSV appears empty or has no data rows.', 'warn'); return; }
                    } else {
                        result = raw;
                    }
                    UndoManager.push(ta);
                    ta.value = result;
                    ta.dispatchEvent(new Event('input'));
                    UndoManager.push(ta);
                    ta.focus();
                    _notify(`Loaded: ${file.name}`, 'success');
                };
                reader.readAsText(file);
            }

            // ── Load File button → native file dialog ─────────────────────────
            const fileInput = document.getElementById('custom-query-file-input');
            document.getElementById('btn-custom-query-load-file').addEventListener('click', () => {
                fileInput.value = '';   // reset so the same file can be re-selected
                fileInput.click();
            });
            fileInput.addEventListener('change', () => {
                const file = fileInput.files[0];
                if (file) _loadFile(file);
            });
        })();

        _bindTablesMenu(
            document.querySelector('#modal-custom-query .btn-tables-trigger'),
            () => document.getElementById('custom-query-textarea').value
        );

        // ---- Convert SQL to Canvas modal ----
        document.getElementById('btn-import-query-explain').addEventListener('click', () => {
            _importQueryExplain();
        });

        document.getElementById('btn-import-query-format').addEventListener('click', () => {
            _formatTextareaSql(document.getElementById('import-query-textarea'));
        });

        _bindScopeMode(
            document.getElementById('import-query-textarea'),
            document.getElementById('btn-import-query-scope'),
            document.getElementById('chk-import-query-scope-exclusive')
        );

        document.getElementById('btn-import-query-run').addEventListener('click', () => {
            _importQueryRun();
        });

        document.getElementById('import-query-textarea').addEventListener('keydown', async e => {
            // Cmd/Ctrl+Enter triggers Import (same UX pattern as custom-query modal)
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                _importQueryRun();
            }
            if (e.key === 'Delete') {
                const scopeBtn = document.getElementById('btn-import-query-scope');
                const scopeChk = document.getElementById('chk-import-query-scope-exclusive');
                const scopeOn  = scopeBtn?.classList.contains('is-active') ?? false;
                if (scopeOn && typeof SqlBackdrop !== 'undefined') {
                    const focusRanges = SqlBackdrop.getFocusRanges(e.currentTarget);
                    if (focusRanges.length) {
                        e.preventDefault();
                        const ta2 = e.currentTarget;
                        const multiple = scopeChk?.checked ?? false;
                        const newSql = multiple
                            ? _disassembleMultipleScopesFromSql(ta2.value, focusRanges)
                            : _disassembleScopeFromSql(ta2.value, focusRanges[0]);
                        if (newSql === ta2.value.trim()) { _notify('Nothing to disassemble in the selected scope(s).', 'warn'); return; }
                        if (typeof UndoManager !== 'undefined') UndoManager.push(ta2);
                        ta2.value = newSql;
                        ta2.dispatchEvent(new Event('input', { bubbles: true }));
                        if (typeof UndoManager !== 'undefined') UndoManager.push(ta2);
                        return;
                    }
                }
            }
            if (e.key === 'F2') {
                e.preventDefault();
                const ta2 = e.currentTarget;
                const activeWord = (typeof SqlBackdrop !== 'undefined') ? SqlBackdrop.getActiveWord(ta2) : null;
                if (!activeWord) return;
                const newName = await Dialog.prompt('Rename item?', activeWord);
                if (newName === null) return;
                const trimmed = newName.trim();
                if (!trimmed) return;
                const esc    = activeWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const result = ta2.value.replace(new RegExp(`\\b${esc}\\b`, 'gi'), trimmed);
                if (result === ta2.value) return;
                if (typeof UndoManager !== 'undefined') UndoManager.push(ta2);
                ta2.value = result;
                ta2.dispatchEvent(new Event('input', { bubbles: true }));
                if (typeof UndoManager !== 'undefined') UndoManager.push(ta2);
            }
        });

        // Save current context
        document.getElementById('btn-ctx-save')
            .addEventListener('click', _saveContext);
        document.getElementById('ctx-name-input')
            .addEventListener('keydown', e => { if (e.key === 'Enter') _saveContext(); });

        // Load context from a local JSON file
        document.getElementById('btn-ctx-new')
            .addEventListener('click', async () => {
                if (!await _confirmIfDirty()) return;
                _intentionalUnload = true;
                window.location.href = window.location.href;
            });

        document.getElementById('btn-ctx-load-file')
            .addEventListener('click', async () => {
                if (!await _confirmIfDirty()) return;
                const input    = document.createElement('input');
                input.type     = 'file';
                input.accept   = '.json,application/json';

                input.addEventListener('change', async () => {
                    const file = input.files[0];
                    if (!file) return;

                    try {
                        const text   = await file.text();
                        const parsed = JSON.parse(text);

                        if (typeof parsed !== 'object' || !Array.isArray(parsed.tables)) {
                            throw new Error('Not a valid context — missing tables array.');
                        }

                        const name = file.name.replace(/\.json$/i, '') || 'Imported Context';

                        // Check whether a context with the same name already exists
                        const existingList = await API.context.list();
                        const duplicate    = existingList.find(
                            item => item.name.toLowerCase() === name.toLowerCase()
                        );

                        if (duplicate) {
                            if (!confirm(
                                `A saved context named "${duplicate.name}" already exists.\n\n` +
                                `Do you want to overwrite it with the newly loaded file?`
                            )) return;
                        }

                        // Apply to canvas
                        applyContext(text, name);

                        // Save new or overwrite existing on the server
                        let saved;
                        if (duplicate) {
                            await API.context.update(duplicate.id, { name, context: parsed });
                            saved = { id: duplicate.id, name };
                        } else {
                            saved = await API.context.save({ name, context: parsed });
                        }

                        State.loadedContextId   = saved.id;
                        State.loadedContextName = saved.name;
                        _updateSaveContextButton();
                        _loadContextList();

                        document.getElementById('modal-context').classList.add('hidden');
                        _notify(`Context "${name}" loaded and saved.`, 'success');

                    } catch (e) {
                        _notify('Invalid context file: ' + e.message, 'error');
                    }
                });

                input.click();
            });


        _bindScopeMode(
            document.getElementById('sql-pretty-input'),
            document.getElementById('btn-sql-preview-scope'),
            document.getElementById('chk-sql-preview-scope-exclusive')
        );

        document.getElementById('btn-copy-pretty-sql')
            .addEventListener('click', () => {
                const sql = document.getElementById('sql-pretty-input').value;
                navigator.clipboard.writeText(sql).then(() => {
                    const btn = document.getElementById('btn-copy-pretty-sql');
                    const orig = btn.textContent;
                    btn.textContent = '✓ Copied!';
                    setTimeout(() => (btn.textContent = orig), 1500);
                });
            });

        _bindTablesMenu(
            document.querySelector('#modal-sql .btn-tables-trigger'),
            () => document.getElementById('sql-pretty-input').value
        );

        document.getElementById('btn-copy-create-statement')
            .addEventListener('click', () => {
                const ddl = document.getElementById('create-statement-output').value;
                navigator.clipboard.writeText(ddl).then(() => {
                    const btn = document.getElementById('btn-copy-create-statement');
                    const orig = btn.textContent;
                    btn.textContent = '✓ Copied!';
                    setTimeout(() => (btn.textContent = orig), 1500);
                });
            });

        // ---- Plot modal nav buttons ----
        document.getElementById('btn-plot-prev').addEventListener('click', () => Modals._navigatePlot(-1));
        document.getElementById('btn-plot-next').addEventListener('click', () => Modals._navigatePlot(1));

        // ---- Plot modal buttons ----
        document.getElementById('btn-plot-copy').addEventListener('click', () => {
            const canvas = document.getElementById('plot-canvas');
            canvas.toBlob(blob => {
                if (!blob) { _notify('Could not copy image.', 'error'); return; }
                try {
                    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(() => {
                        const btn = document.getElementById('btn-plot-copy');
                        const orig = btn.textContent;
                        btn.textContent = '✓ Copied!';
                        setTimeout(() => (btn.textContent = orig), 1500);
                        document.getElementById('plot-pin-title').focus();
                    }).catch(() => _notify('Clipboard write failed (browser may require HTTPS).', 'error'));
                } catch {
                    _notify('ClipboardItem not supported in this browser.', 'error');
                }
            });
        });

        document.getElementById('btn-plot-save').addEventListener('click', () => {
            const canvas = document.getElementById('plot-canvas');
            const title  = (document.getElementById('modal-plot-title').textContent || 'plot')
                .replace(/[^a-z0-9_\-]/gi, '_').toLowerCase();
            const a = document.createElement('a');
            a.download = title + '.png';
            a.href = canvas.toDataURL('image/png');
            a.click();
        });

        document.getElementById('btn-plot-flip').addEventListener('click', () => {
            Modals.flipPlot();
            document.getElementById('plot-pin-title').focus();
        });

        document.getElementById('plot-pin-title').addEventListener('keydown', e => {
            if (e.key === 'Enter') document.getElementById('btn-plot-pin').click();
        });

        document.getElementById('btn-plot-pin').addEventListener('click', () => {
            const islandKey = Modals._plotIslandKey;
            if (!islandKey) return;
            const canvas = document.getElementById('plot-canvas');
            const title = document.getElementById('plot-pin-title').value.trim()
                       || Modals._plotResolvedTitle
                       || 'Plot';
            // Redraw with the final pin title so the image matches the pin label.
            if (Modals._plotResult) {
                try {
                    if (Modals._plotFlipped) {
                        Plot.drawHorizontal(canvas, Modals._plotResult.rows, Modals._plotResult.cols, title);
                    } else {
                        Plot.draw(canvas, Modals._plotResult.rows, Modals._plotResult.cols, title);
                    }
                } catch (_) { /* ignore — capture whatever is on the canvas */ }
            }
            const dataUrl = canvas.toDataURL('image/png');
            if (typeof Islands !== 'undefined' && Islands.pinPlot) {
                Islands.pinPlot(islandKey, dataUrl, title);
                // After pinning, scroll the canvas so the pin container is centred.
                requestAnimationFrame(() => {
                    const pinContainer = document.querySelector(
                        `.plot-pin-container[data-island-key="${CSS.escape(islandKey)}"]`
                    );
                    if (pinContainer && typeof Canvas !== 'undefined' && Canvas.scrollToLogicalBoundingBox) {
                        const left = parseFloat(pinContainer.style.left)   || 0;
                        const top  = parseFloat(pinContainer.style.top)    || 0;
                        const w    = parseFloat(pinContainer.style.width)  || 0;
                        const h    = parseFloat(pinContainer.style.height) || 0;
                        Canvas.scrollToLogicalBoundingBox(left, top, left + w, top + h);
                    }
                });
            }
            Modals.closePlot();
        });
    }

    // -------------------------------------------------------------------------
    // Context modal — saved contexts list
    // -------------------------------------------------------------------------

    /** Filter the visible ctx-rows by the current search term (case-insensitive). */
    function _filterContextList() {
        const term = (document.getElementById('ctx-search-input')?.value ?? '').trim().toLowerCase();
        document.querySelectorAll('#ctx-saved-list .ctx-row').forEach(row => {
            const name = (row.querySelector('.ctx-row__name')?.textContent ?? '').toLowerCase();
            row.classList.toggle('hidden', term !== '' && !name.includes(term));
        });
    }

    async function _loadContextList() {
        const list = document.getElementById('ctx-saved-list');
        list.innerHTML = '<p class="config-empty">Loading…</p>';
        try {
            const items = await API.context.list();
            _renderContextList(items);
        } catch {
            list.innerHTML = '<p class="config-empty">Could not load saved contexts.</p>';
        }
    }

    function _renderContextList(items) {
        const list = document.getElementById('ctx-saved-list');
        if (!items.length) {
            list.innerHTML = '<p class="config-empty">No saved contexts yet.</p>';
            return;
        }

        list.innerHTML = '';

        // If a context is loaded, pin it at the top followed by a divider
        const loadedItem = State.loadedContextId
            ? items.find(i => i.id === State.loadedContextId)
            : null;
        const rest = loadedItem
            ? items.filter(i => i.id !== State.loadedContextId)
            : items;

        const _buildRow = item => {
            const date = item.savedAt ? new Date(item.savedAt).toLocaleString() : '';
            const row  = document.createElement('div');
            row.className = 'ctx-row' + (item.id === State.loadedContextId ? ' is-loaded' : '');
            row.innerHTML =
                `<span class="ctx-row__name">${_escHtml(item.name)}</span>` +
                `<span class="ctx-row__date">${_escHtml(date)}</span>` +
                `<div class="ctx-row__btns">` +
                    `<button class="btn-ctx-rename" data-id="${_escAttr(item.id)}" data-name="${_escAttr(item.name)}" title="Rename context">Rename</button>` +
                    `<button class="btn-ctx-duplicate" data-id="${_escAttr(item.id)}" data-name="${_escAttr(item.name)}" title="Duplicate context">⧉ Duplicate</button>` +
                    `<button class="btn-ctx-disk" data-id="${_escAttr(item.id)}" data-name="${_escAttr(item.name)}" title="Save to disk">⬇ Save</button>` +
                    `<button class="btn-ctx-delete btn-danger" data-id="${_escAttr(item.id)}">✕</button>` +
                `</div>`;
            row.addEventListener('click', async e => {
                if (e.target.closest('button')) return;
                if (!await _confirmIfDirty()) return;
                try {
                    const context = await API.context.load(item.id);
                    document.getElementById('modal-context').classList.add('hidden');
                    applyContext(JSON.stringify(context), item.name || '');
                    State.loadedContextId   = item.id;
                    State.loadedContextName = item.name || '';
                    _updateSaveContextButton();
                    _notify('Context loaded.', 'success');
                } catch (e) {
                    _notify('Load failed: ' + e.message, 'error');
                }
            });
            return row;
        };

        if (loadedItem) {
            list.appendChild(_buildRow(loadedItem));
            const divider = document.createElement('hr');
            divider.className = 'ctx-list-divider';
            list.appendChild(divider);
        }

        rest.forEach(item => list.appendChild(_buildRow(item)));

        list.querySelectorAll('.btn-ctx-rename').forEach(btn => {
            btn.addEventListener('click', async () => {
                const newName = await Dialog.prompt('New name for this context:', btn.dataset.name || '');
                if (newName === null || newName.trim() === '') return;
                try {
                    await API.context.rename(btn.dataset.id, newName.trim());
                    if (State.loadedContextId === btn.dataset.id) {
                        State.loadedContextName = newName.trim();
                        _updateContextTitle(newName.trim());
                    }
                    _loadContextList();
                    _notify('Context renamed.', 'success');
                } catch (e) {
                    _notify('Rename failed: ' + e.message, 'error');
                }
            });
        });

        list.querySelectorAll('.btn-ctx-delete').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!await Dialog.confirm('Delete this saved context?')) return;
                try {
                    await API.context.delete(btn.dataset.id);
                    if (State.loadedContextId === btn.dataset.id) {
                        State.loadedContextId   = null;
                        State.loadedContextName = null;
                        _updateContextTitle('');
                        _updateSaveContextButton();
                    }
                    _loadContextList();
                } catch (e) {
                    _notify('Delete failed: ' + e.message, 'error');
                }
            });
        });

        list.querySelectorAll('.btn-ctx-duplicate').forEach(btn => {
            btn.addEventListener('click', async () => {
                const dupName = (btn.dataset.name || 'Context') + ' - duplicate';
                try {
                    const context = await API.context.load(btn.dataset.id);
                    await API.context.save({ name: dupName, context });
                    _loadContextList();
                    _notify(`Duplicated as "${dupName}".`, 'success');
                } catch (e) {
                    _notify('Duplicate failed: ' + e.message, 'error');
                }
            });
        });

        list.querySelectorAll('.btn-ctx-disk').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    const context = await API.context.load(btn.dataset.id);
                    const json     = JSON.stringify(context, null, 2);
                    const blob     = new Blob([json], { type: 'application/json' });
                    const url      = URL.createObjectURL(blob);
                    const a        = document.createElement('a');
                    const safeName = (btn.dataset.name || 'context').replace(/[^a-z0-9_\-]/gi, '_');
                    a.href         = url;
                    a.download     = `${safeName}.json`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    URL.revokeObjectURL(url);
                } catch (e) {
                    _notify('Download failed: ' + e.message, 'error');
                }
            });
        });

        // Re-apply any active search term after the list is (re-)rendered
        _filterContextList();
    }

    async function _saveContext(nameOverride = null) {
        const name = nameOverride ?? document.getElementById('ctx-name-input').value.trim();
        if (!name) {
            _showCtxSaveResult('Enter a name first.', 'error');
            return;
        }
        try {
            _flushCurrentIslandConfig();
            _flushBackdropAnnotations();
            const ctx = { version: APP_VERSION, ...State, raw_query: _currentRawQuery(), customQuery: document.getElementById('custom-query-textarea').value, allMinimized: QueryPanel.getAllMinimized() };
            delete ctx.loadedContextId;

            // Check whether a context with the same name already exists
            const existingList = await API.context.list();
            const duplicate    = existingList.find(
                item => item.name.toLowerCase() === name.toLowerCase()
            );

            if (duplicate) {
                if (!await Dialog.confirm(
                    `A saved context named "${duplicate.name}" already exists.\n\n` +
                    `Do you want to overwrite it with the current state?`
                )) return;

                await API.context.update(duplicate.id, { name, context: ctx });
                document.getElementById('ctx-name-input').value = '';
                State.loadedContextId   = duplicate.id;
                State.loadedContextName = duplicate.name;
                _updateContextTitle(duplicate.name);
                _updateSaveContextButton();
                _lastSavedJson = _buildSaveJson();
                _loadContextList();
                document.getElementById('modal-context').classList.add('hidden');
                _notify('Context saved!', 'success');
                return;
            }

            const saved = await API.context.save({ name, context: ctx });
            document.getElementById('ctx-name-input').value = '';
            // Activate the freshly-saved context so btn-save-context works immediately
            // without needing to manually load it from the list first.
            State.loadedContextId   = saved.id;
            State.loadedContextName = saved.name;
            _updateContextTitle(saved.name);
            _updateSaveContextButton();
            _lastSavedJson = _buildSaveJson();
            _loadContextList();
            document.getElementById('modal-context').classList.add('hidden');
            _notify('Context saved!', 'success');
        } catch (e) {
            _notify('Save failed: ' + e.message, 'error');
        }
    }

    /** Update the saved context that was loaded from the list (overwrite with current state). */
    async function _saveLoadedContext() {
        if (!State.loadedContextId) return;
        const name = (State.loadedContextName || '').trim() || 'Context';
        _flushCurrentIslandConfig();
        _flushBackdropAnnotations();
        const ctx = { version: APP_VERSION, ...State, raw_query: _currentRawQuery(), customQuery: document.getElementById('custom-query-textarea').value, allMinimized: QueryPanel.getAllMinimized() };
        delete ctx.loadedContextId;
        try {
            await API.context.update(State.loadedContextId, { name, context: ctx });
            _lastSavedJson = _buildSaveJson();
            _notify('Context saved.', 'success');
            _loadContextList();
        } catch (e) {
            _notify('Save failed: ' + e.message, 'error');
        }
    }

    /** Update the top-bar save-context button title based on loadedContextId. */
    function _updateSaveContextButton() {
        const btn = document.getElementById('btn-save-context');
        if (!btn) return;
        btn.title = State.loadedContextId
            ? 'Save current state to this context'
            : 'Save as a new context';
    }

    /** Build the same JSON payload that gets persisted, for dirty-state comparison. */
    function _buildSaveJson() {
        _flushCurrentIslandConfig();
        _flushBackdropAnnotations();
        const ctx = {
            version: APP_VERSION, ...State,
            raw_query:    _currentRawQuery(),
            customQuery:  document.getElementById('custom-query-textarea')?.value ?? '',
            allMinimized: QueryPanel.getAllMinimized(),
        };
        delete ctx.loadedContextId;
        delete ctx.loadedContextName;
        return JSON.stringify(ctx);
    }

    /** Returns true when the canvas has changes not yet written to disk. */
    function _isContextDirty() {
        if (_lastSavedJson === null) return false;
        try { return _buildSaveJson() !== _lastSavedJson; } catch { return false; }
    }

    /**
     * Shows a "unsaved changes will be lost" confirm only when the context is dirty.
     * Returns true if the caller should proceed, false if the user cancelled.
     */
    async function _confirmIfDirty() {
        if (!_isContextDirty()) return true;
        return Dialog.confirm(
            'You have unsaved changes that will be lost.\n\n' +
            'Do you want to continue without saving?'
        );
    }

    function _showCtxSaveResult(msg, type) {
        const el = document.getElementById('ctx-save-result');
        el.textContent    = msg;
        el.className      = type;
        el.style.display  = 'block';
        setTimeout(() => (el.style.display = 'none'), 3000);
    }

    /** Simple HTML entity escaping for dynamic innerHTML content. */
    function _escHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function _escAttr(str) {
        return String(str).replace(/"/g, '&quot;');
    }

    function bindLimitSelect() {
        document.getElementById('limit-select')
            .addEventListener('change', e => {
                State.limit = parseInt(e.target.value, 10);
                updateSQLPreview();
            });
    }

    // -------------------------------------------------------------------------
    // Pane collapse / expand
    // -------------------------------------------------------------------------

    const _PANE_DEFAULTS = {
        sidebar: { el: null, btn: null, cssVar: '--sidebar-width', defaultW: '300px', collapseW: '0px' },
        config:  { el: null, btn: null, cssVar: '--config-width',  defaultW: '300px', collapseW: '0px' },
    };

    function _initPaneToggles() {
        _PANE_DEFAULTS.sidebar.el  = document.getElementById('sidebar');
        _PANE_DEFAULTS.sidebar.btn = document.getElementById('btn-toggle-sidebar');
        _PANE_DEFAULTS.config.el   = document.getElementById('config-panel');
        _PANE_DEFAULTS.config.btn  = document.getElementById('btn-toggle-config');

        // Restore persisted widths BEFORE applying collapse state so the correct
        // width is used when _applyPaneState sets the CSS var for the expanded state.
        const PANE_MIN_W = 300;
        const savedSW = localStorage.getItem('pane-sidebar-width');
        const savedCW = localStorage.getItem('pane-config-width');
        if (savedSW) _PANE_DEFAULTS.sidebar.defaultW = Math.max(PANE_MIN_W, parseInt(savedSW, 10)) + 'px';
        if (savedCW) _PANE_DEFAULTS.config.defaultW  = Math.max(PANE_MIN_W, parseInt(savedCW, 10)) + 'px';

        // Restore persisted collapse state before wiring clicks
        _applyPaneState('sidebar', localStorage.getItem('pane-sidebar') === 'collapsed');
        _applyPaneState('config',  localStorage.getItem('pane-config')  === 'collapsed');

        _PANE_DEFAULTS.sidebar.btn.addEventListener('click', () => _togglePane('sidebar'));
        _PANE_DEFAULTS.config.btn.addEventListener('click',  () => _togglePane('config'));

        _initPaneResizers();
    }

    function _initPaneResizers() {
        _initResizer('sidebar', document.getElementById('resizer-sidebar'), 'right');
        _initResizer('config',  document.getElementById('resizer-config'),  'left');
    }

    function _initResizer(key, handle, side) {
        const pane  = _PANE_DEFAULTS[key];
        const MIN_W = 300;
        const MAX_W = 600;

        handle.addEventListener('mousedown', e => {
            if (pane.el.classList.contains('is-collapsed')) return;
            e.preventDefault();

            const startX = e.clientX;
            const startW = pane.el.offsetWidth;

            document.body.classList.add('is-resizing');

            function onMove(e) {
                const dx   = side === 'right' ? e.clientX - startX : startX - e.clientX;
                const newW = Math.min(MAX_W, Math.max(MIN_W, startW + dx));
                document.documentElement.style.setProperty(pane.cssVar, newW + 'px');
            }

            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup',   onUp);
                document.body.classList.remove('is-resizing');
                const finalW = pane.el.offsetWidth;
                pane.defaultW = finalW + 'px';
                localStorage.setItem(`pane-${key}-width`, finalW);
            }

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup',   onUp);
        });
    }

    function _togglePane(key) {
        const pane      = _PANE_DEFAULTS[key];
        const collapsed = pane.el.classList.contains('is-collapsed');
        _applyPaneState(key, !collapsed);
        localStorage.setItem(`pane-${key}`, !collapsed ? 'collapsed' : 'expanded');
    }

    let _focusModeState = null; // saved pane state for F5 restore

    function _toggleFocusMode() {
        const resultsEl = document.getElementById('results-panel');
        const sidebarCollapsed = _PANE_DEFAULTS.sidebar.el?.classList.contains('is-collapsed') ?? false;
        const configCollapsed  = _PANE_DEFAULTS.config.el?.classList.contains('is-collapsed')  ?? false;
        const resultsCollapsed = resultsEl?.classList.contains('is-collapsed') ?? false;
        const anyVisible = !sidebarCollapsed || !configCollapsed || !resultsCollapsed;

        if (anyVisible) {
            // At least one pane is open — (re-)save current state and collapse all
            _focusModeState = { sidebarCollapsed, configCollapsed, resultsCollapsed };
            if (!sidebarCollapsed) _applyPaneState('sidebar', true);
            if (!configCollapsed)  _applyPaneState('config',  true);
            if (!resultsCollapsed) Results.toggle?.();
        } else if (_focusModeState) {
            // All panes hidden and we have a saved state — restore it
            if (!_focusModeState.sidebarCollapsed) _applyPaneState('sidebar', false);
            if (!_focusModeState.configCollapsed)  _applyPaneState('config',  false);
            if (!_focusModeState.resultsCollapsed) Results.toggle?.();
            _focusModeState = null;
        }
    }

    function _applyPaneState(key, collapsed) {
        const pane = _PANE_DEFAULTS[key];
        pane.el.classList.toggle('is-collapsed', collapsed);

        // Update the CSS var so #results-panel tracks the live width
        document.documentElement.style.setProperty(
            pane.cssVar,
            collapsed ? pane.collapseW : pane.defaultW
        );

        // Update button arrow direction
        if (key === 'sidebar') {
            pane.btn.textContent = collapsed ? '›' : '‹';
            pane.btn.title       = collapsed ? 'Show sidebar' : 'Hide sidebar';
        } else {
            pane.btn.textContent = collapsed ? '‹' : '›';
            pane.btn.title       = collapsed ? 'Show config panel' : 'Hide config panel';
        }
    }

    // -------------------------------------------------------------------------
    // Update the canvas-count badge on btn-filter-canvas
    // Called from this file and from canvas.js via window.updateCanvasCount
    // -------------------------------------------------------------------------
    function _updateCanvasCount() {
        const btn = document.getElementById('btn-filter-canvas');
        if (!btn) return;
        const n = State.tables.length;
        btn.dataset.count = n > 0 ? n : '';
    }
    window.updateCanvasCount = _updateCanvasCount;

    // -------------------------------------------------------------------------
    // Toast notification (lightweight, no external lib)
    // -------------------------------------------------------------------------
    function _notify(message, type = 'info') {
        // Create a transient toast element
        const toast = document.createElement('div');
        toast.className = `toast toast--${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        // Trigger reflow so the CSS transition fires
        requestAnimationFrame(() => toast.classList.add('toast--visible'));

        setTimeout(() => {
            toast.classList.remove('toast--visible');
            toast.addEventListener('transitionend', () => toast.remove(), { once: true });
        }, 3200);

        // Also log to console for debugging
        if (type === 'error' || type === 'warn') {
            console.warn(`[${APP_NAME}] ${message}`);
        } else {
            console.info(`[${APP_NAME}] ${message}`);
        }
    }

    // -------------------------------------------------------------------------
    // Public surface
    // -------------------------------------------------------------------------
    // -------------------------------------------------------------------------
    // computeIslands — BFS connected-components over enabled joins.
    // Returns an array of arrays of table IDs, one entry per island.
    // Every table (including unconnected single tables) belongs to exactly one island.
    // -------------------------------------------------------------------------
    function computeIslands(tables, enabledJoins) {
        const adj     = {};
        const visited = new Set();
        const islands = [];

        tables.forEach(t => { adj[t.id] = []; });
        enabledJoins.forEach(j => {
            if (adj[j.fromTableId]) adj[j.fromTableId].push(j.toTableId);
            if (adj[j.toTableId])   adj[j.toTableId].push(j.fromTableId);
        });

        tables.forEach(t => {
            if (visited.has(t.id)) return;
            const island = [];
            const queue  = [t.id];
            visited.add(t.id);
            while (queue.length) {
                const id = queue.shift();
                island.push(id);
                (adj[id] || []).forEach(nbr => {
                    if (!visited.has(nbr)) { visited.add(nbr); queue.push(nbr); }
                });
            }
            islands.push(island);
        });

        return islands;
    }

    /**
     * BFS from startTableId through enabledJoins within islandIds.
     * Returns { tableId: orderNumber } for every table in the island,
     * guaranteeing each JOIN target was already introduced earlier in the chain.
     */
    function bfsOrder(startTableId, islandIds, enabledJoins) {
        const idSet = new Set(islandIds);
        const adj   = {};
        islandIds.forEach(id => { adj[id] = []; });
        enabledJoins.forEach(j => {
            if (idSet.has(j.fromTableId) && idSet.has(j.toTableId)) {
                adj[j.fromTableId].push(j.toTableId);
                adj[j.toTableId].push(j.fromTableId);
            }
        });
        const visited = new Set([startTableId]);
        const queue   = [startTableId];
        const order   = {};
        let n = 1;
        while (queue.length) {
            const id = queue.shift();
            order[id] = n++;
            (adj[id] || []).forEach(nbr => {
                if (!visited.has(nbr)) { visited.add(nbr); queue.push(nbr); }
            });
        }
        return order;
    }

    return {
        init,
        loadProfiles,
        loadDatabases,
        loadTables,
        addTableToCanvas,
        addSubqueryToCanvas,
        addSubqueryWithSql,
        copyIsland,
        updateSQLPreview,
        applyContext,
        loadContextList: _loadContextList,
        notify: _notify,   // exposed for use by canvas.js and future phase files
        openSqExpand,
        bindTablesMenu: _bindTablesMenu,
        runSql: _runCustomQuery,
        toggleMaximizePopup: _toggleMaximizePopup,
        computeIslands,
        bfsOrder,
        blitIslandConfig,
        flushCurrentIslandConfig: _flushCurrentIslandConfig,
        captureSnapshot,
        onIslandTransition,
        cleanupPinsForRemovedTable,
        saveLoadedContext: _saveLoadedContext,
        bindNotePopup: (...args) => QueryPanel.bindNotePopup(...args),
        csvToUnionSql: _csvToUnionSql,
        loadFileIntoSubquery: _loadFileIntoSubquery,
    };

    // ── CSV / SQL file helpers (module scope — used by modal, subquery cards, canvas drop) ──

    /** Parse CSV text and return a UNION ALL SELECT query string. */
    function _csvToUnionSql(csvText) {
        const rows = _parseCsv(csvText);
        if (rows.length < 2) return null;
        const headers  = rows[0];
        const dataRows = rows.slice(1).filter(r => r.some(c => c !== ''));
        if (!dataRows.length) return null;
        const colAliases = headers.map(h => '`' + h.replace(/`/g, '``') + '`');
        const selects = dataRows.map(row => {
            const cols = headers.map((_, i) => {
                const val = _csvSqlValue(row[i] ?? '');
                return `${val} AS ${colAliases[i]}`;
            });
            return '(\n    SELECT ' + cols.join(',\n           ') + '\n)';
        });
        return selects.join('\nUNION ALL\n');
    }

    /** Minimal RFC-4180 CSV parser → string[][] */
    function _parseCsv(text) {
        const rows = [];
        let row = [], field = '', inQuotes = false, i = 0;
        const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        while (i < src.length) {
            const ch = src[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
                    inQuotes = false; i++; continue;
                }
                field += ch; i++; continue;
            }
            if (ch === '"')  { inQuotes = true; i++; continue; }
            if (ch === ',')  { row.push(field); field = ''; i++; continue; }
            if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
            field += ch; i++;
        }
        row.push(field);
        if (row.some(c => c !== '')) rows.push(row);
        return rows;
    }

    /** Convert a CSV cell string to an SQL literal. */
    function _csvSqlValue(raw) {
        if (raw === '') return 'NULL';
        if (/^-?\d+(\.\d+)?$/.test(raw)) return raw;
        return "'" + raw.replace(/'/g, "''") + "'";
    }

    /** Load a .sql or .csv file and create a new subquery card with the given island color. */
    /** Load a .sql or .csv file into an existing subquery textarea (in-place, undoable). */
    function _loadFileIntoSubquery(ta) {
        const fileInput = document.createElement('input');
        fileInput.type   = 'file';
        fileInput.accept = '.sql,.csv,text/plain,text/csv';
        fileInput.style.display = 'none';
        document.body.appendChild(fileInput);
        fileInput.addEventListener('change', () => {
            const file = fileInput.files[0];
            document.body.removeChild(fileInput);
            if (!file) return;
            const reader = new FileReader();
            reader.onerror = () => _notify('Could not read file.', 'error');
            reader.onload = ev => {
                const raw   = ev.target.result;
                const isCsv = file.name.toLowerCase().endsWith('.csv');
                let sql;
                if (isCsv) {
                    sql = _csvToUnionSql(raw);
                    if (!sql) { _notify('CSV appears empty or has no data rows.', 'warn'); return; }
                } else {
                    sql = raw;
                }
                if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
                ta.value = sql;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
                ta.focus();
                _notify(`Loaded: ${file.name}`, 'success');
            };
            reader.readAsText(file);
        });
        fileInput.click();
    }

    function _loadFileIntoNewSubquery(file, color) {
        const reader = new FileReader();
        reader.onerror = () => _notify('Could not read file.', 'error');
        reader.onload = ev => {
            const raw   = ev.target.result;
            const isCsv = file.name.toLowerCase().endsWith('.csv');
            let sql;
            if (isCsv) {
                sql = _csvToUnionSql(raw);
                if (!sql) { _notify('CSV appears empty or has no data rows.', 'warn'); return; }
            } else {
                sql = raw;
            }
            addSubqueryWithSql(sql, null, color);
            _notify(`Loaded: ${file.name}`, 'success');
        };
        reader.readAsText(file);
    }

})();

// Per-table color palette — vivid, well-spread across the spectrum,
// chosen for visibility on the dark background of .sql-highlighted.
const _TABLE_COLORS = [
    '#ff6b6b', // red
    '#ffd93d', // yellow
    '#6bcb77', // green
    '#c77dff', // purple
    '#ff9f43', // orange
    '#fd79a8', // pink
    '#00cec9', // teal
    '#74b9ff', // blue
];

/**
 * Builds a stable alias → color map from the current State.tables so that
 * partial SQL fragments (WHERE, HAVING, SELECT raw inputs) can colour table
 * aliases even though they don't contain a FROM / JOIN clause.
 * The nth table in State always gets the nth palette color, giving consistent
 * colors across every backdrop textarea and the SQL Query Preview.
 */
function _getTableColorMap() {
    if (typeof State === 'undefined' || !Array.isArray(State.tables)) return null;
    const map = new Map();
    State.tables.forEach((t, i) => {
        const alias = (t.alias || t.name || '').trim();
        if (alias) map.set(alias, _TABLE_COLORS[i % _TABLE_COLORS.length]);
    });
    return map.size ? map : null;
}

/* -------------------------------------------------------------------------
   Mask SQL literals, backtick identifiers, and comments with equal-length
   spaces so bracket/keyword scanning never misreads quoted content.
   Character positions are preserved for safe offset arithmetic.
------------------------------------------------------------------------- */
function _maskSQLLiterals(sql) {
    let out = '', i = 0;
    while (i < sql.length) {
        if (sql[i] === '-' && sql[i + 1] === '-') {
            const end = sql.indexOf('\n', i);
            const len = (end === -1 ? sql.length : end) - i;
            out += ' '.repeat(len); i += len;
        } else if (sql[i] === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            const len = (end === -1 ? sql.length : end + 2) - i;
            out += ' '.repeat(len); i += len;
        } else if (sql[i] === "'") {
            let j = i + 1;
            while (j < sql.length) { if (sql[j] === "'" && sql[j - 1] !== '\\') { j++; break; } j++; }
            out += ' '.repeat(j - i); i = j;
        } else if (sql[i] === '`') {
            let j = i + 1;
            while (j < sql.length && sql[j] !== '`') j++;
            out += ' '.repeat(j + 1 - i); i = j + 1;
        } else { out += sql[i++]; }
    }
    return out;
}

/* -------------------------------------------------------------------------
   Given SQL text and a cursor position, return the innermost paren scope
   containing the cursor, or the top-level clause range as fallback.
   Returns { start, end, type: 'paren'|'clause' } or null.
------------------------------------------------------------------------- */
function _findContextRange(sql, cursorPos) {
    if (!sql || cursorPos < 0) return null;
    const masked = _maskSQLLiterals(sql);

    // Innermost paren pair containing cursorPos
    const stack = [];
    let best = null;
    for (let j = 0; j < masked.length; j++) {
        if      (masked[j] === '(') stack.push(j);
        else if (masked[j] === ')' && stack.length) {
            const open = stack.pop(), close = j;
            if (open <= cursorPos && cursorPos <= close &&
                (!best || open > best.start))
                best = { start: open, end: close + 1, type: 'paren' };
        }
    }
    if (best) return best;

    // Top-level clause fallback: build depth array
    const depth = new Int32Array(masked.length + 1);
    let d = 0;
    for (let j = 0; j < masked.length; j++) {
        depth[j] = d;
        if      (masked[j] === '(') d++;
        else if (masked[j] === ')') d = Math.max(0, d - 1);
    }
    const KW_RE = /\b(SELECT\s+DISTINCT|SELECT|FROM|(?:(?:LEFT|RIGHT|FULL)(?:\s+OUTER)?\s+|INNER\s+|CROSS\s+)?JOIN|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|UNION(?:\s+ALL)?|INTERSECT|EXCEPT)\b/gi;
    const boundaries = [0];
    let m;
    while ((m = KW_RE.exec(masked)) !== null) {
        if (depth[m.index] === 0) boundaries.push(m.index);
    }
    boundaries.push(masked.length);
    const sorted = [...new Set(boundaries)].sort((a, b) => a - b);
    for (let k = 0; k < sorted.length - 1; k++) {
        if (sorted[k] <= cursorPos && cursorPos < sorted[k + 1])
            return { start: sorted[k], end: sorted[k + 1], type: 'clause' };
    }
    return null;
}

/* =============================================================================
   Disassemble helpers
   Remove a scoped SQL fragment (identified by a {start,end} range) from the
   full SQL string, and cascade-clean all references to the removed table alias
   throughout the remaining clauses (SELECT, GROUP BY, ORDER BY, WHERE, HAVING).
   ============================================================================= */

// Split `content` on top-level commas (depth 0, respecting parentheses).
function _splitTopLevelCommas(content) {
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < content.length; i++) {
        if      (content[i] === '(') depth++;
        else if (content[i] === ')') depth = Math.max(0, depth - 1);
        else if (content[i] === ',' && depth === 0) {
            parts.push(content.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(content.slice(start));
    return parts;
}

// Split WHERE/HAVING content into segments separated by top-level AND/OR.
// Each element: { connector: 'AND'|'OR'|'', text: string }
// The first element always has connector=''; subsequent ones carry their separator.
// AND inside BETWEEN…AND is skipped (not treated as a condition separator).
function _splitTopLevelConditions(content) {
    const masked = _maskSQLLiterals(content);
    const dep = new Int32Array(masked.length + 1);
    let d = 0;
    for (let j = 0; j < masked.length; j++) {
        dep[j] = d;
        if      (masked[j] === '(') d++;
        else if (masked[j] === ')') d = Math.max(0, d - 1);
    }
    const re = /\bBETWEEN\b|\b(AND|OR)\b/gi;
    let mo, betweenPending = 0;
    const splits = [];
    while ((mo = re.exec(masked)) !== null) {
        if (dep[mo.index] !== 0) continue;
        if (/^BETWEEN$/i.test(mo[0])) {
            betweenPending++;
        } else if (/^AND$/i.test(mo[1])) {
            if (betweenPending > 0) betweenPending--;
            else splits.push({ start: mo.index, end: mo.index + mo[0].length });
        } else {
            splits.push({ start: mo.index, end: mo.index + mo[0].length });
        }
    }
    if (splits.length === 0) return [{ connector: '', text: content }];
    const result = [{ connector: '', text: content.slice(0, splits[0].start) }];
    for (let i = 0; i < splits.length; i++) {
        result.push({
            connector: content.slice(splits[i].start, splits[i].end),
            text:      content.slice(splits[i].end, i + 1 < splits.length ? splits[i + 1].start : content.length),
        });
    }
    return result;
}

// Remove items referencing `aliasEsc.` from a comma-separated clause section.
// `isSelect` controls the fallback when every item is removed (→ ' *').
function _disassembleRemoveListItems(content, aliasEsc, isSelect) {
    const aliasRef = new RegExp('(?:`?' + aliasEsc + '`?)\\s*\\.', 'i');
    const parts    = _splitTopLevelCommas(content);
    const filtered = parts.filter(p => !aliasRef.test(p));
    if (filtered.length === parts.length) return content;
    if (filtered.length === 0) return isSelect ? ' *' : '';
    // Re-join and restore the trailing whitespace that was part of the original
    // content (the newline/space sitting between the last item and the next clause
    // keyword).  Without this, the next keyword runs into the last kept item,
    // e.g. "d.created_atFROM".
    const trailingWs = content.match(/\s+$/)?.[0] ?? '';
    const joined = filtered.join(',');
    return (trailingWs && !joined.endsWith(trailingWs)) ? joined + trailingWs : joined;
}

// Remove conditions referencing `aliasEsc.` from a WHERE/HAVING clause section.
function _disassembleRemoveConditions(content, aliasEsc) {
    const aliasRef = new RegExp('(?:`?' + aliasEsc + '`?)\\s*\\.', 'i');
    const segments = _splitTopLevelConditions(content);
    const filtered = segments.filter(seg => !aliasRef.test(seg.text));
    if (filtered.length === segments.length) return content;
    if (filtered.length === 0) return '';
    const trailingWs = content.match(/\s+$/)?.[0] ?? '';
    const joined = filtered.map((seg, i) => (i === 0 ? '' : seg.connector) + seg.text).join('');
    return (trailingWs && !joined.endsWith(trailingWs)) ? joined + trailingWs : joined;
}

// After cleaning, remove clause keywords whose content became empty, and tidy whitespace.
function _disassembleCleanEmptyClauses(sql) {
    const TAIL = '(?=\\s*(?:\\bHAVING\\b|\\bORDER\\s+BY\\b|\\bLIMIT\\b|\\bUNION\\b|\\bINTERSECT\\b|\\bEXCEPT\\b|$))';
    sql = sql.replace(new RegExp('\\bGROUP\\s+BY\\s*' + TAIL, 'gi'), '');
    sql = sql.replace(/\bORDER\s+BY\s*(?=\s*(?:\bLIMIT\b|\bUNION\b|\bINTERSECT\b|\bEXCEPT\b|$))/gi, '');
    sql = sql.replace(/\bHAVING\s*(?=\s*(?:\bORDER\s+BY\b|\bLIMIT\b|\bUNION\b|\bINTERSECT\b|\bEXCEPT\b|$))/gi, '');
    sql = sql.replace(/\bWHERE\s*(?=\s*(?:\bGROUP\s+BY\b|\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|\bUNION\b|\bINTERSECT\b|\bEXCEPT\b|$))/gi, '');
    // Strip orphaned indentation before clause keywords left behind after removal
    sql = sql.replace(/\n[ \t]+(\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT)\b)/gi, '\n$1');
    sql = sql.replace(/\n{3,}/g, '\n\n');
    return sql.trim();
}

// Walk each top-level clause section and strip all references to `alias.`.
function _cleanAliasReferences(sql, alias) {
    const esc    = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const masked = _maskSQLLiterals(sql);

    // Build paren-depth array so we only act on top-level keywords
    const dep = new Int32Array(masked.length + 1);
    let d = 0;
    for (let j = 0; j < masked.length; j++) {
        dep[j] = d;
        if      (masked[j] === '(') d++;
        else if (masked[j] === ')') d = Math.max(0, d - 1);
    }

    const KW_RE = /\b(SELECT(?:\s+DISTINCT)?|FROM|(?:(?:LEFT|RIGHT|FULL)(?:\s+OUTER)?\s+|INNER\s+|CROSS\s+)?JOIN|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|UNION(?:\s+ALL)?|INTERSECT|EXCEPT)\b/gi;
    const bounds = [];
    let m;
    while ((m = KW_RE.exec(masked)) !== null) {
        if (dep[m.index] === 0)
            bounds.push({ kw: m[0].replace(/\s+/g, ' ').toUpperCase().trim(), kwStart: m.index, kwEnd: m.index + m[0].length });
    }
    if (bounds.length === 0) return sql;

    // Content of each section = from end-of-keyword to start-of-next-keyword
    const sections = bounds.map((b, i) => ({
        kw:           b.kw,
        contentStart: b.kwEnd,
        contentEnd:   i + 1 < bounds.length ? bounds[i + 1].kwStart : sql.length,
    }));

    // Process right-to-left so slice offsets stay valid
    let result = sql;
    for (let i = sections.length - 1; i >= 0; i--) {
        const { kw, contentStart, contentEnd } = sections[i];
        if (!/^(SELECT|GROUP BY|ORDER BY|WHERE|HAVING)/.test(kw)) continue;
        const content = result.slice(contentStart, contentEnd);
        const newContent = /^SELECT/.test(kw) || kw === 'GROUP BY' || kw === 'ORDER BY'
            ? _disassembleRemoveListItems(content, esc, /^SELECT/.test(kw))
            : _disassembleRemoveConditions(content, esc);
        if (newContent !== content)
            result = result.slice(0, contentStart) + newContent + result.slice(contentEnd);
    }
    return _disassembleCleanEmptyClauses(result);
}

// Main entry point: remove the scope at `range` from `sql` and cascade-clean.
// After removing a FROM clause, promote the first remaining JOIN to a FROM clause
// (strips the JOIN-type keyword and its ON condition, keeps the table reference).
function _promoteFirstJoinToFrom(sql) {
    const masked = _maskSQLLiterals(sql);
    const dep = new Int32Array(masked.length + 1);
    let d = 0;
    for (let j = 0; j < masked.length; j++) {
        dep[j] = d;
        if      (masked[j] === '(') d++;
        else if (masked[j] === ')') d = Math.max(0, d - 1);
    }
    const KW_RE = /\b(SELECT(?:\s+DISTINCT)?|FROM|(?:(?:LEFT|RIGHT|FULL)(?:\s+OUTER)?\s+|INNER\s+|CROSS\s+)?JOIN|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|UNION(?:\s+ALL)?|INTERSECT|EXCEPT)\b/gi;
    const bounds = [];
    let m;
    while ((m = KW_RE.exec(masked)) !== null) {
        if (dep[m.index] === 0)
            bounds.push({ kw: m[0].replace(/\s+/g, ' ').toUpperCase().trim(), kwStart: m.index, kwEnd: m.index + m[0].length });
    }
    const firstJoinIdx = bounds.findIndex(b => /JOIN/.test(b.kw));
    if (firstJoinIdx === -1) return sql;

    const jb           = bounds[firstJoinIdx];
    const contentStart = jb.kwEnd;
    const contentEnd   = firstJoinIdx + 1 < bounds.length ? bounds[firstJoinIdx + 1].kwStart : sql.length;
    const content      = sql.slice(contentStart, contentEnd);
    const maskedContent = masked.slice(contentStart, contentEnd);

    // Find ON at depth 0 within the JOIN content to isolate the table reference
    const cDep = new Int32Array(maskedContent.length + 1);
    let cd = 0;
    for (let j = 0; j < maskedContent.length; j++) {
        cDep[j] = cd;
        if      (maskedContent[j] === '(') cd++;
        else if (maskedContent[j] === ')') cd = Math.max(0, cd - 1);
    }
    const onRe = /\bON\b/gi;
    let onMatch = null, om;
    while ((om = onRe.exec(maskedContent)) !== null) {
        if (cDep[om.index] === 0) { onMatch = om; break; }
    }
    // tableRef = everything before ON (or the full content for CROSS JOIN / no-ON cases)
    const tableRef = (onMatch ? content.slice(0, onMatch.index) : content).trim();

    // Replace '[TYPE] JOIN table [alias] ON condition' with 'FROM table [alias]'
    return sql.slice(0, jb.kwStart).trimEnd() + '\nFROM ' + tableRef + '\n' + sql.slice(contentEnd);
}

// Remove orphaned UNION / UNION ALL / INTERSECT / EXCEPT operators that are
// left dangling after a component is removed:
//   • trailing operator  — "… UNION ALL"           → "…"
//   • leading operator   — "UNION ALL …"           → "…"
//   • consecutive pair   — "UNION ALL\nUNION ALL"  → "UNION ALL"  (middle removal)
function _cleanSetOperatorOrphans(sql) {
    const OP = '(?:UNION(?:\\s+ALL)?|INTERSECT(?:\\s+ALL)?|EXCEPT(?:\\s+ALL)?)';
    // Consecutive pair: keep the second operator
    sql = sql.replace(new RegExp('\\b' + OP + '\\s+' + OP + '\\b', 'gi'),
        m => m.replace(/^.*\b(UNION(?:\s+ALL)?|INTERSECT(?:\s+ALL)?|EXCEPT(?:\s+ALL)?)\s*$/gi, '$1').trim());
    // Trailing orphan
    sql = sql.replace(new RegExp('\\s*\\b' + OP + '\\s*$', 'gi'), '');
    // Leading orphan
    sql = sql.replace(new RegExp('^\\s*\\b' + OP + '\\s*', 'gi'), '');
    return sql.trim();
}

// Return the position where the SELECT component that follows a set operator ends:
// i.e. the start of the next top-level UNION/INTERSECT/EXCEPT, or sql.length if none.
// `fromPos` is the character position right after the set operator's own scope text.
function _findSetOperatorComponentEnd(sql, fromPos) {
    const masked = _maskSQLLiterals(sql);
    const dep = new Int32Array(masked.length + 1);
    let d = 0;
    for (let j = 0; j < masked.length; j++) {
        dep[j] = d;
        if      (masked[j] === '(') d++;
        else if (masked[j] === ')') d = Math.max(0, d - 1);
    }
    const re = /\b(?:UNION(?:\s+ALL)?|INTERSECT(?:\s+ALL)?|EXCEPT(?:\s+ALL)?)\b/gi;
    re.lastIndex = fromPos;
    let mo;
    while ((mo = re.exec(masked)) !== null) {
        if (dep[mo.index] === 0) return mo.index;
    }
    return sql.length;
}

function _disassembleMultipleScopesFromSql(sql, ranges) {
    const sorted = [...ranges].sort((a, b) => b.start - a.start);
    let result = sql;
    for (const range of sorted) result = _disassembleScopeFromSql(result, range);
    return result;
}

function _disassembleScopeFromSql(sql, range) {
    const scopeText = sql.slice(range.start, range.end);

    // ── JOIN scope ────────────────────────────────────────────────────────────
    if (/^[\s\n]*(?:(?:LEFT|RIGHT|INNER|FULL\s+OUTER|CROSS)\s+)?JOIN\s/i.test(scopeText)) {
        let alias = null;
        const aliasM = /JOIN\s+(?:`[^`]+`|\w+)(?:\.(?:`[^`]+`|\w+))?\s+(?:AS\s+)?(`[^`]+`|\w+)\s+ON/i.exec(scopeText);
        if (aliasM) {
            const cand = aliasM[1].replace(/`/g, '');
            if (!/^ON$/i.test(cand)) alias = cand;
        }
        if (!alias) {
            const tableM = /JOIN\s+(?:`[^`]+`\.)?(?:`([^`]+)`|(\w+))\s+ON/i.exec(scopeText);
            if (tableM) alias = tableM[1] || tableM[2];
        }
        let result = sql.slice(0, range.start) + sql.slice(range.end);
        if (alias) result = _cleanAliasReferences(result, alias);
        return _cleanSetOperatorOrphans(result.replace(/\n{3,}/g, '\n\n'));
    }

    // ── FROM scope ────────────────────────────────────────────────────────────
    if (/^[\s\n]*FROM\s/i.test(scopeText)) {
        let alias = null;
        const fromAliasM = /FROM\s+(?:`[^`]+`|\w+)(?:\.(?:`[^`]+`|\w+))?\s+(?:AS\s+)?(`[^`]+`|\w+)/i.exec(scopeText);
        if (fromAliasM) alias = fromAliasM[1].replace(/`/g, '');
        if (!alias) {
            const fromTableM = /FROM\s+(?:`[^`]+`\.)?(?:`([^`]+)`|(\w+))/i.exec(scopeText);
            if (fromTableM) alias = fromTableM[1] || fromTableM[2];
        }
        let result = sql.slice(0, range.start) + sql.slice(range.end);
        if (alias) result = _cleanAliasReferences(result, alias);
        result = _promoteFirstJoinToFrom(result);
        return _cleanSetOperatorOrphans(result.replace(/\n{3,}/g, '\n\n'));
    }

    // ── UNION / INTERSECT / EXCEPT scope ─────────────────────────────────────
    // The scope only covers the operator keyword itself (up to the next keyword
    // boundary).  Extend the removal to also cover the entire SELECT component
    // that follows it — up to the next top-level set operator or end of SQL.
    if (/^[\s\n]*(?:UNION(?:\s+ALL)?|INTERSECT(?:\s+ALL)?|EXCEPT(?:\s+ALL)?)\b/i.test(scopeText)) {
        const componentEnd = _findSetOperatorComponentEnd(sql, range.end);
        const raw = (sql.slice(0, range.start) + sql.slice(componentEnd)).replace(/\n{3,}/g, '\n\n');
        return _cleanSetOperatorOrphans(raw);
    }

    // ── Other scope: plain text removal ───────────────────────────────────────
    const raw = (sql.slice(0, range.start) + sql.slice(range.end)).replace(/\n{3,}/g, '\n\n');
    return _cleanSetOperatorOrphans(raw);
}

function _highlightSQL(sql, seedAliases = null, focusRanges = null) {
    const SQL_KEYWORDS = new Set([
        'SELECT','FROM','WHERE','JOIN','INNER','LEFT','RIGHT','FULL','OUTER','CROSS',
        'ON','AND','OR','NOT','IN','IS','NULL','LIKE','BETWEEN','EXISTS','HAVING',
        'GROUP','BY','ORDER','LIMIT','OFFSET','AS','DISTINCT','ALL','UNION',
        'CASE','WHEN','THEN','ELSE','END','INSERT','INTO','VALUES','UPDATE','SET',
        'DELETE','CREATE','TABLE','DROP','ALTER','ADD','COLUMN','PRIMARY','KEY',
        'FOREIGN','REFERENCES','DEFAULT','AUTO_INCREMENT','UNSIGNED','EXPLAIN',
        'SHOW','DESCRIBE','USE','DATABASE','SCHEMA','COUNT','SUM','AVG','MIN',
        'MAX','IF','COALESCE','IFNULL','NULLIF','CONCAT','DATE','NOW','ASC','DESC',
        'WITH','RECURSIVE','OVER','PARTITION','ROWS','RANGE','FOLLOWING','PRECEDING',
        'UNBOUNDED','CURRENT','ROW','OVER',
    ]);

    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const tokens = [];
    let i = 0;
    while (i < sql.length) {
        // Single-line comment
        if (sql[i] === '-' && sql[i + 1] === '-') {
            const end = sql.indexOf('\n', i);
            const text = end === -1 ? sql.slice(i) : sql.slice(i, end);
            tokens.push({ type: 'comment', text, start: i, end: i + text.length });
            i += text.length;
        // Multi-line comment
        } else if (sql[i] === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            const text = end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
            tokens.push({ type: 'comment', text, start: i, end: i + text.length });
            i += text.length;
        // String literal
        } else if (sql[i] === "'") {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === "'" && sql[j - 1] !== '\\') { j++; break; }
                j++;
            }
            tokens.push({ type: 'string', text: sql.slice(i, j), start: i, end: j });
            i = j;
        // Backtick identifier
        } else if (sql[i] === '`') {
            let j = i + 1;
            while (j < sql.length && sql[j] !== '`') j++;
            tokens.push({ type: 'ident', text: sql.slice(i, j + 1), start: i, end: j + 1 });
            i = j + 1;
        // Number
        } else if (/\d/.test(sql[i])) {
            let j = i;
            while (j < sql.length && /[\d.]/.test(sql[j])) j++;
            tokens.push({ type: 'number', text: sql.slice(i, j), start: i, end: j });
            i = j;
        // Word (keyword or plain identifier)
        } else if (/[a-zA-Z_]/.test(sql[i])) {
            let j = i;
            while (j < sql.length && /\w/.test(sql[j])) j++;
            tokens.push({ type: 'word', text: sql.slice(i, j), start: i, end: j });
            i = j;
        // Everything else (whitespace, operators, punctuation)
        } else {
            tokens.push({ type: 'other', text: sql[i], start: i, end: i + 1 });
            i++;
        }
    }

    // Helpers used across passes
    const isWS      = t => t.type === 'other' && /^\s$/.test(t.text);
    const isRefPart = t =>
        t?.type === 'ident' ||
        (t?.type === 'word' && !SQL_KEYWORDS.has(t.text.toUpperCase()));

    // Pass 1: merge dotted pairs into typed tokens.
    //   `ident`.`ident`  →  tableref  (schema.table, both backtick-quoted)
    //   word.ident / word.word / ident.word (anything else)  →  colref  (alias.col)
    const merged = [];
    let ti = 0;
    while (ti < tokens.length) {
        const cur  = tokens[ti];
        const dot  = tokens[ti + 1];
        const next = tokens[ti + 2];
        if (dot?.type === 'other' && dot.text === '.' && isRefPart(cur) && isRefPart(next)) {
            const type = (cur.type === 'ident' && next.type === 'ident') ? 'tableref' : 'colref';
            merged.push({ type, text: cur.text + '.' + next.text, start: cur.start, end: next.end });
            ti += 3;
        } else {
            merged.push(cur);
            ti++;
        }
    }

    // tableAliases pre-seeded from caller (backdrop) so alias.col tokens in
    // partial SQL fragments get the same colors as in the full SQL Preview.
    const tableAliases    = seedAliases ? new Map(seedAliases) : new Map();
    const tablerefColors  = new Map(); // tableref text → color (for unaliased refs)
    let colorIdx = seedAliases ? seedAliases.size : 0;
    const _nextColor = () => _TABLE_COLORS[colorIdx++ % _TABLE_COLORS.length];

    // Pass 2: assign per-table colors; detect column aliases.
    //   tableref [WS]* [AS WS*] non-kw-word  →  tablealias  (same color as tableref)
    //   AS [WS]* non-kw-word                 →  colalias
    const final = [];
    let mi = 0;
    while (mi < merged.length) {
        const cur = merged[mi];

        if (cur.type === 'tableref') {
            // Peek ahead for an alias word (with optional AS keyword)
            let j = mi + 1;
            while (j < merged.length && isWS(merged[j])) j++;
            if (j < merged.length && merged[j].type === 'word' && merged[j].text.toUpperCase() === 'AS') {
                j++;
                while (j < merged.length && isWS(merged[j])) j++;
            }

            if (j < merged.length && merged[j].type === 'word' && !SQL_KEYWORDS.has(merged[j].text.toUpperCase())) {
                const alias = merged[j].text;
                if (!tableAliases.has(alias)) tableAliases.set(alias, _nextColor());
                const color = tableAliases.get(alias);
                final.push({ type: 'tableref',   text: cur.text, color, start: cur.start, end: cur.end });
                mi++;
                for (let k = mi; k < j; k++) final.push(merged[k]); // whitespace / AS
                final.push({ type: 'tablealias', text: alias, color, start: merged[j].start, end: merged[j].end });
                mi = j + 1;
            } else {
                // No alias — key color by the tableref text itself
                if (!tablerefColors.has(cur.text)) tablerefColors.set(cur.text, _nextColor());
                final.push({ type: 'tableref', text: cur.text, color: tablerefColors.get(cur.text), start: cur.start, end: cur.end });
                mi++;
            }

        } else if (cur.type === 'word' && cur.text.toUpperCase() === 'AS') {
            final.push(cur);
            mi++;
            let j = mi;
            while (j < merged.length && isWS(merged[j])) j++;
            if (j < merged.length && merged[j].type === 'word' && !SQL_KEYWORDS.has(merged[j].text.toUpperCase())) {
                for (let k = mi; k < j; k++) final.push(merged[k]);
                final.push({ type: 'colalias', text: merged[j].text, start: merged[j].start, end: merged[j].end });
                mi = j + 1;
            }

        } else {
            final.push(cur);
            mi++;
        }
    }

    return final.map(t => {
        const e = esc(t.text);
        const inFocus = focusRanges && focusRanges.length > 0 &&
            focusRanges.some(r => t.start < r.end && t.end > r.start);
        const dimmed  = focusRanges && focusRanges.length > 0 && !inFocus;
        let inner;
        switch (t.type) {
            case 'comment':    inner = `<span class="sql-hl-comment">${e}</span>`; break;
            case 'string':     inner = `<span class="sql-hl-string">${e}</span>`; break;
            case 'tableref':   inner = `<span style="color:${t.color}">${e}</span>`; break;
            case 'tablealias': inner = `<span style="color:${t.color}">${e}</span>`; break;
            case 'colref': {
                const dot = t.text.indexOf('.');
                if (dot > -1) {
                    const left  = t.text.slice(0, dot);
                    const right = t.text.slice(dot + 1);
                    const color = tableAliases.get(left.replace(/`/g, ''));
                    if (color) {
                        inner = `<span style="color:${color}">${esc(left)}</span>`
                              + `.`
                              + `<span class="sql-hl-colref">${esc(right)}</span>`;
                        break;
                    }
                }
                inner = `<span class="sql-hl-colref">${e}</span>`;
                break;
            }
            case 'colalias':   inner = `<span class="sql-hl-colalias">${e}</span>`; break;
            case 'ident':      inner = `<span class="sql-hl-ident">${e}</span>`; break;
            case 'number':     inner = `<span class="sql-hl-number">${e}</span>`; break;
            case 'word':       inner = SQL_KEYWORDS.has(t.text.toUpperCase())
                                   ? `<span class="sql-hl-keyword">${e}</span>`
                                   : e; break;
            default:           inner = e;
        }
        if (dimmed)  return `<span class="sql-hl-dim">${inner}</span>`;
        if (inFocus) return `<span class="sql-hl-focus">${inner}</span>`;
        return inner;
    }).join('');
}

/* =============================================================================
   SQL formatter — "Format" buttons on backdrop textareas
   Applies the same visual conventions as QueryBuilder.assembleSql():
     • Each major clause keyword on its own line
     • SELECT columns one-per-line, tab-indented, comma at end of each line
     • FROM table tab-indented on the next line
     • WHERE / HAVING conditions split on AND / OR, each on its own line
   String literals, backtick identifiers, and comments are protected so their
   content is never accidentally re-formatted.
   ============================================================================= */

/** Split `str` at top-level commas (ignoring those inside parentheses). */
function _sqlSplitCommas(str) {
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < str.length; i++) {
        if      (str[i] === '(') depth++;
        else if (str[i] === ')') depth--;
        else if (str[i] === ',' && depth === 0) { parts.push(str.slice(start, i)); start = i + 1; }
    }
    parts.push(str.slice(start));
    return parts;
}

/**
 * Split a WHERE / HAVING body at top-level AND / OR keywords.
 * Each returned element (except the first) starts with "AND " or "OR ".
 */
function _sqlSplitAndOr(str) {
    const parts = [];
    let depth = 0, start = 0, i = 0;
    while (i < str.length) {
        if      (str[i] === '(') { depth++; i++; }
        else if (str[i] === ')') { depth--; i++; }
        else if (depth === 0) {
            const m = str.slice(i).match(/^(AND|OR)(?=\s)/i);
            if (m) {
                const piece = str.slice(start, i).trim();
                if (piece) parts.push(piece);
                start = i;
                i += m[0].length;
            } else { i++; }
        } else { i++; }
    }
    const last = str.slice(start).trim();
    if (last) parts.push(last);
    return parts;
}

/**
 * Format a SQL string using the same visual conventions as the query builder.
 * Safe to call on arbitrary SQL — literals / backtick identifiers / comments
 * are protected from re-formatting and restored verbatim afterward.
 */
function _formatBackdropSQL(rawSql) {
    if (!rawSql || !rawSql.trim()) return rawSql;

    // ── Preserve leading SET @var = ...; block ────────────────────────────────
    // Extract any contiguous SET @variable lines at the top, leave them as-is,
    // and format only the query body that follows.
    let setBlock = '';
    let sqlToFormat = rawSql;
    const setBlockMatch = rawSql.match(/^((?:[ \t]*SET[ \t]+@[^\n]*\n)+)/i);
    if (setBlockMatch) {
        setBlock    = setBlockMatch[1];
        sqlToFormat = rawSql.slice(setBlock.length);
        if (!sqlToFormat.trim()) return rawSql; // only SET lines, nothing to format
    }

    // ── Step 1: protect literals / comments with NUL-delimited placeholders ──
    const saved = [];
    let s = '', i = 0;
    const src = sqlToFormat;
    while (i < src.length) {
        if (src[i] === '-' && src[i + 1] === '-') {
            const end = src.indexOf('\n', i);
            const chunk = end === -1 ? src.slice(i) : src.slice(i, end);
            saved.push(chunk); s += '\x00' + (saved.length - 1) + '\x00'; i += chunk.length;
        } else if (src[i] === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            const chunk = end === -1 ? src.slice(i) : src.slice(i, end + 2);
            saved.push(chunk); s += '\x00' + (saved.length - 1) + '\x00'; i += chunk.length;
        } else if (src[i] === "'") {
            let j = i + 1;
            while (j < src.length) { if (src[j] === "'" && src[j - 1] !== '\\') { j++; break; } j++; }
            const chunk = src.slice(i, j);
            saved.push(chunk); s += '\x00' + (saved.length - 1) + '\x00'; i = j;
        } else if (src[i] === '`') {
            let j = i + 1;
            while (j < src.length && src[j] !== '`') j++;
            const chunk = src.slice(i, j + 1);
            saved.push(chunk); s += '\x00' + (saved.length - 1) + '\x00'; i = j + 1;
        } else { s += src[i++]; }
    }

    // ── Step 2: collapse all whitespace to single spaces ─────────────────────
    s = s.replace(/[ \t\r\n]+/g, ' ').trim();

    // ── Step 3: insert newline before each major clause keyword ──────────────
    // Ordered longest-first so compound keywords win over shorter prefixes.
    const clausePat = [
        'SELECT\\s+DISTINCT', 'SELECT', 'FROM',
        'LEFT\\s+OUTER\\s+JOIN', 'LEFT\\s+JOIN',
        'RIGHT\\s+OUTER\\s+JOIN', 'RIGHT\\s+JOIN',
        'FULL\\s+OUTER\\s+JOIN', 'FULL\\s+JOIN',
        'INNER\\s+JOIN', 'CROSS\\s+JOIN', 'JOIN',
        'WHERE', 'GROUP\\s+BY', 'HAVING', 'ORDER\\s+BY',
        'LIMIT', 'OFFSET',
        'UNION\\s+ALL', 'UNION', 'INTERSECT', 'EXCEPT',
    ].join('|');
    s = s.replace(
        new RegExp('(?<!\\w)(' + clausePat + ')(?!\\w)', 'gi'),
        (match, _kw, offset) => offset === 0 ? match : '\n' + match
    );
    s = s.trim();

    // ── Step 4: indent each clause's content ─────────────────────────────────
    const result = [];
    const kwRe = /^(SELECT\s+DISTINCT|SELECT|FROM|WHERE|HAVING|GROUP\s+BY|ORDER\s+BY|LIMIT|OFFSET|UNION\s+ALL|UNION|INTERSECT|EXCEPT|(?:INNER|LEFT(?:\s+OUTER)?|RIGHT(?:\s+OUTER)?|FULL(?:\s+OUTER)?|CROSS)\s+JOIN|JOIN)/i;

    for (const rawLine of s.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;

        const kwMatch = line.match(kwRe);
        if (!kwMatch) { result.push(line); continue; }

        const kw   = kwMatch[0];
        const kwUp = kw.toUpperCase().replace(/\s+/g, ' ');
        const rest = line.slice(kw.length).trim();

        if (kwUp === 'SELECT' || kwUp === 'SELECT DISTINCT') {
            if (!rest) { result.push(kwUp); continue; }
            const cols = _sqlSplitCommas(rest);
            if (cols.length > 1) {
                result.push(kwUp);
                cols.forEach((c, idx) => result.push('\t' + c.trim() + (idx < cols.length - 1 ? ',' : '')));
            } else {
                result.push(kwUp + '\n\t' + rest);
            }

        } else if (kwUp === 'FROM') {
            result.push('FROM' + (rest ? '\n\t' + rest : ''));

        } else if (kwUp === 'WHERE' || kwUp === 'HAVING') {
            if (!rest) { result.push(kwUp); continue; }
            const conds = _sqlSplitAndOr(rest);
            if (conds.length > 1) {
                result.push(kwUp);
                conds.forEach((cond, idx) => {
                    if (idx === 0) { result.push('\t    ' + cond); return; }
                    const opM = cond.match(/^(AND|OR)\s+/i);
                    if (opM) result.push('\t' + opM[1].toUpperCase() + ' ' + cond.slice(opM[0].length));
                    else     result.push('\t' + cond);
                });
            } else {
                result.push(kwUp + '\n\t' + rest);
            }

        } else if (kwUp === 'GROUP BY' || kwUp === 'ORDER BY') {
            result.push(kwUp + (rest ? ' ' + rest : ''));

        } else {
            // JOINs, LIMIT, OFFSET, UNION, etc. — keep on their own line as-is
            result.push(line);
        }
    }
    s = result.join('\n');

    // ── Step 5: restore protected literals / comments ─────────────────────────
    s = s.replace(/\x00(\d+)\x00/g, (_, idx) => saved[+idx]);

    // ── Reattach SET block with exactly 2 blank lines before the query ─────────
    return setBlock ? setBlock.trimEnd() + '\n\n' + s : s;
}

/**
 * Apply _formatBackdropSQL to a textarea, pushing both the before and after
 * states onto the UndoManager stack so Ctrl+Z restores the original SQL.
 */
function _formatTextareaSql(ta) {
    const formatted = _formatBackdropSQL(ta.value);
    if (formatted === ta.value) return;            // nothing changed
    UndoManager.push(ta);                          // save pre-format state
    ta.value = formatted;
    ta.dispatchEvent(new Event('input', { bubbles: true })); // refresh backdrop
    UndoManager.push(ta);                          // save post-format state
}

/* -------------------------------------------------------------------------
   _bindScopeMode — wire a Scope toggle button and exclusive checkbox
   to a backdrop textarea.  Safe to call before SqlBackdrop.attach().
------------------------------------------------------------------------- */
function _bindScopeMode(ta, btn, chk) {
    if (!btn || !ta) return;
    const _syncUI = on => {
        btn.classList.toggle('is-active', on);
        if (chk) chk.disabled = !on;
    };
    btn.addEventListener('click', () => _syncUI(SqlBackdrop.toggleScopeMode(ta)));
    // Alt+S inside the textarea fires this event; keep button in sync without
    // needing sql-backdrop.js to know about the DOM button.
    ta.addEventListener('backdrop-scopetoggle', e => _syncUI(e.detail.scopeMode));
    if (chk) {
        // Checked = multiple scopes allowed → exclusiveMode OFF (inverted)
        SqlBackdrop.setExclusiveMode(ta, !chk.checked);
        chk.addEventListener('change', () => {
            SqlBackdrop.setExclusiveMode(ta, !chk.checked);
        });
    }
}

/* =============================================================================
   Modals — namespace
   Expanded in Phase 2 (profiles form logic) and Phase 4 (join editor).
   ============================================================================= */
const Modals = {
    openProfiles() {
        // Always refresh the list when the modal opens so it stays current
        Profiles.loadAndRender();
        Profiles.clearForm();
        document.getElementById('modal-profiles').classList.remove('hidden');
    },
    closeProfiles() {
        document.getElementById('modal-profiles').classList.add('hidden');
    },
    openContext() {
        document.getElementById('ctx-search-input').value = '';
        document.getElementById('modal-context').classList.remove('hidden');
        App.loadContextList();
        setTimeout(() => document.getElementById('ctx-search-input')?.focus(), 50);
    },
    openJoinEditor(joinId) {
        if (typeof Joins !== 'undefined') Joins.openEditor(joinId);
    },
    openSqlPreview() {
        const rawSql = document.getElementById('sql-preview-text').textContent;
        if (!rawSql || rawSql.startsWith('--')) {
            App.notify('No query to preview yet.', 'warn');
            return;
        }

        const _sqlPrettyTA = document.getElementById('sql-pretty-input');
        _sqlPrettyTA.value = rawSql;
        _sqlPrettyTA.dispatchEvent(new Event('input', { bubbles: true })); // refresh backdrop
        document.getElementById('modal-sql').classList.remove('hidden');
        setTimeout(() => _sqlPrettyTA.focus(), 0);
    },
    openShortcuts() {
        document.getElementById('modal-shortcuts').classList.remove('hidden');
    },
    _notesOriginal: '',
    openNotes() {
        this._notesOriginal = State.notes ?? '';
        const notesTa = document.getElementById('notes-textarea');
        if (notesTa.value !== this._notesOriginal) {
            notesTa.value = this._notesOriginal;
            if (typeof UndoManager !== 'undefined') UndoManager.reset(notesTa);
        }
        document.getElementById('modal-notes').classList.remove('hidden');
        notesTa.focus();
    },
    saveNotes() {
        State.notes      = document.getElementById('notes-textarea').value;
        this._notesOriginal = State.notes;
    },
    closeNotes() {
        this.saveNotes();
        document.getElementById('modal-notes').classList.add('hidden');
    },
    openValueEditor(colName, currentValue, onSave) {
        document.getElementById('value-editor-col').textContent = colName;
        document.getElementById('value-editor-input').value = currentValue ?? '';
        Modals._onValueSave = onSave;
        document.getElementById('modal-value-editor').classList.remove('hidden');
        document.getElementById('value-editor-input').focus();
    },
    openImportQuery() {
        // Reset the modal state on each open
        const _importTa = document.getElementById('import-query-textarea');
        _importTa.value = '';
        _importTa.dispatchEvent(new Event('input', { bubbles: true })); // refresh backdrop
        document.getElementById('import-query-status').classList.add('hidden');
        document.getElementById('modal-import-query').classList.remove('hidden');
        document.getElementById('import-query-textarea').focus();
    },
    // ---- Pin container popup ----
    openPinContainer(islandKey) {
        const islandName = (State.islandNames?.[islandKey] ?? '').trim();

        // Title
        document.getElementById('modal-pin-container-title').textContent =
            islandName ? `Pinned Plots — ${islandName}` : 'Pinned Plots';

        const _sortLabel = o => o === 'asc' ? '↑ Oldest first' : o === 'custom' ? '↕ Manual' : '↓ Newest first';

        // Toolbar: sort toggle
        const toolbar = document.getElementById('modal-pin-container-toolbar');
        toolbar.innerHTML = '';
        const sortBtn = document.createElement('button');
        sortBtn.className   = 'plot-pin-sort-btn';
        sortBtn.textContent = _sortLabel(State.islandPinSortOrder?.[islandKey] ?? 'desc');
        sortBtn.addEventListener('click', () => {
            if (!State.islandPinSortOrder) State.islandPinSortOrder = {};
            const cur = State.islandPinSortOrder[islandKey] ?? 'desc';
            State.islandPinSortOrder[islandKey] = cur === 'asc' ? 'desc' : 'asc';
            sortBtn.textContent = _sortLabel(State.islandPinSortOrder[islandKey]);
            _rebuildGrid();
            if (typeof Islands !== 'undefined' && Islands.renderAllPinContainers) {
                Islands.renderAllPinContainers();
            }
        });
        toolbar.appendChild(sortBtn);

        // Grid builder — also serves as drop-handler closure scope
        const grid = document.getElementById('modal-pin-container-grid');
        let _dragIdx = null;

        const _rebuildGrid = () => {
            grid.innerHTML = '';
            const o = State.islandPinSortOrder?.[islandKey] ?? 'desc';
            const pins = State.islandPinnedPlots?.[islandKey] ?? [];
            const sorted = o === 'custom'
                ? [...pins]
                : [...pins].sort((a, b) =>
                    o === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt
                );

            sorted.forEach((pinData, i) => {
                const card = document.createElement('div');
                card.className   = 'modal-pin-card';
                card.draggable   = true;
                if (pinData.borderColor) card.style.borderColor = pinData.borderColor;

                const titleEl = document.createElement('div');
                titleEl.className   = 'modal-pin-card-title';
                titleEl.textContent = pinData.title || 'Plot';
                titleEl.title       = pinData.title || 'Plot';

                const img = document.createElement('img');
                img.src    = pinData.dataUrl;
                img.alt    = pinData.title || 'Plot';
                img.width  = 320;
                img.height = 240;
                img.title  = 'Click to view full plot';
                img.style.cursor = 'pointer';
                img.addEventListener('click', () => {
                    const navList = sorted.map(p => ({ dataUrl: p.dataUrl, title: p.title }));
                    Modals.openPlotFromDataUrl(pinData.dataUrl, pinData.title, navList, i);
                });

                // ---- Drag-and-drop ----
                card.addEventListener('dragstart', e => {
                    _dragIdx = i;
                    e.dataTransfer.effectAllowed = 'move';
                    requestAnimationFrame(() => card.classList.add('dragging'));
                });
                card.addEventListener('dragend', () => {
                    card.classList.remove('dragging');
                    grid.querySelectorAll('.modal-pin-card').forEach(c => c.classList.remove('drag-over'));
                    _dragIdx = null;
                });
                card.addEventListener('dragover', e => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (_dragIdx !== null && _dragIdx !== i) {
                        grid.querySelectorAll('.modal-pin-card').forEach(c => c.classList.remove('drag-over'));
                        card.classList.add('drag-over');
                    }
                });
                card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
                card.addEventListener('drop', e => {
                    e.preventDefault();
                    if (_dragIdx === null || _dragIdx === i) return;
                    // Reorder the sorted array and write back to State
                    const [moved] = sorted.splice(_dragIdx, 1);
                    sorted.splice(i, 0, moved);
                    State.islandPinnedPlots[islandKey] = sorted;
                    // Switch to manual order
                    if (!State.islandPinSortOrder) State.islandPinSortOrder = {};
                    State.islandPinSortOrder[islandKey] = 'custom';
                    sortBtn.textContent = _sortLabel('custom');
                    _dragIdx = null;
                    _rebuildGrid();
                    if (typeof Islands !== 'undefined' && Islands.renderAllPinContainers) {
                        Islands.renderAllPinContainers();
                    }
                });

                card.appendChild(titleEl);
                card.appendChild(img);
                grid.appendChild(card);
            });
        };
        _rebuildGrid();

        const modal = document.getElementById('modal-pin-container');
        modal.classList.remove('hidden');
        // Maximize on open if not already maximized
        const box = modal.querySelector('.modal-box');
        if (box && box.dataset.maximized !== '1') App.toggleMaximizePopup(box);
    },

    // ---- Plot modal ----
    _plotIslandKey:     null,
    _plotResult:        null,
    _plotFlipped:       false,
    _plotResolvedTitle: null,

    openPlot(result, islandKey, title) {
        // result: { cols: string[], rows: any[][] }
        // title may be null — fall back to "col1 vs col2" after validation
        const canvas = document.getElementById('plot-canvas');
        let resolvedTitle = title || null;

        try {
            // Validate early so we never open the modal on bad data
            const extracted = Plot.validateAndExtract(result.rows, result.cols);
            if (!resolvedTitle) {
                resolvedTitle = extracted.xColName !== 'Index'
                    ? `${extracted.xColName} vs ${extracted.yColName}`
                    : extracted.yColName;
            }
            Plot.draw(canvas, result.rows, result.cols, resolvedTitle);
        } catch (e) {
            Dialog.alert(e.message);
            return;
        }

        this._plotIslandKey     = islandKey;
        this._plotResult        = result;
        this._plotFlipped       = false;
        this._plotResolvedTitle = resolvedTitle;
        document.getElementById('modal-plot-title').textContent = resolvedTitle;
        document.getElementById('btn-plot-flip').style.display = '';
        document.getElementById('btn-plot-pin').style.display = '';
        const pinTitleInput = document.getElementById('plot-pin-title');
        pinTitleInput.value       = '';
        pinTitleInput.placeholder = resolvedTitle;
        pinTitleInput.style.display = '';
        requestAnimationFrame(() => pinTitleInput.focus());
        document.getElementById('modal-plot').classList.remove('hidden');
    },

    flipPlot() {
        if (!this._plotResult) return;
        this._plotFlipped = !this._plotFlipped;
        const canvas = document.getElementById('plot-canvas');
        const title  = document.getElementById('modal-plot-title').textContent;
        try {
            if (this._plotFlipped) {
                Plot.drawHorizontal(canvas, this._plotResult.rows, this._plotResult.cols, title);
            } else {
                Plot.draw(canvas, this._plotResult.rows, this._plotResult.cols, title);
            }
        } catch (e) {
            Dialog.alert(e.message);
        }
    },

    openPlotFromDataUrl(dataUrl, title, navList, navIndex) {
        const canvas  = document.getElementById('plot-canvas');
        const ctx     = canvas.getContext('2d');
        const titleEl = document.getElementById('modal-plot-title');

        const img = new Image();
        img.onload = () => {
            titleEl.textContent = title || 'Plot';
            ctx.drawImage(img, 0, 0);
        };
        img.src = dataUrl;

        this._plotIslandKey     = null;
        this._plotResult        = null;
        this._plotFlipped       = false;
        this._plotResolvedTitle = null;
        this._plotNavList       = navList || null;
        this._plotNavIndex      = (navList && navIndex != null) ? navIndex : null;

        document.getElementById('btn-plot-flip').style.display = 'none';
        document.getElementById('btn-plot-pin').style.display = 'none';
        document.getElementById('plot-pin-title').style.display = 'none';

        const prevBtn = document.getElementById('btn-plot-prev');
        const nextBtn = document.getElementById('btn-plot-next');
        if (navList && navList.length > 1) {
            prevBtn.classList.remove('hidden');
            nextBtn.classList.remove('hidden');
            prevBtn.disabled = navIndex <= 0;
            nextBtn.disabled = navIndex >= navList.length - 1;
        } else {
            prevBtn.classList.add('hidden');
            nextBtn.classList.add('hidden');
        }

        document.getElementById('modal-plot').classList.remove('hidden');
    },

    _navigatePlot(delta) {
        if (!this._plotNavList) return;
        const newIdx = this._plotNavIndex + delta;
        if (newIdx < 0 || newIdx >= this._plotNavList.length) return;
        const item = this._plotNavList[newIdx];
        this.openPlotFromDataUrl(item.dataUrl, item.title, this._plotNavList, newIdx);
    },

    closePlot() {
        document.getElementById('modal-plot').classList.add('hidden');
        this._plotIslandKey     = null;
        this._plotResult        = null;
        this._plotFlipped       = false;
        this._plotResolvedTitle = null;
        this._plotNavList       = null;
        this._plotNavIndex      = null;
        document.getElementById('plot-pin-title').value = '';
    },

    async openCreateStatement(tableData) {
        const profileId = State.activeProfileId;
        if (!profileId) {
            App.notify('No profile selected.', 'warn');
            return;
        }

        const title = tableData.database
            ? `${tableData.database}.${tableData.name}`
            : tableData.name;
        document.getElementById('modal-create-statement-title').textContent = `CREATE TABLE — ${title}`;

        const textarea = document.getElementById('create-statement-output');
        const _fireInput = () => textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.value = 'Loading…';
        _fireInput();
        textarea.classList.remove('hidden');
        document.getElementById('modal-create-statement').classList.remove('hidden');

        try {
            const result = await API.schema.createStatement(profileId, tableData.name, tableData.database ?? '');
            textarea.value = result.ddl ?? '';
        } catch (err) {
            textarea.value = `Error: ${err.message}`;
        }
        _fireInput(); // refresh backdrop after async load
    },
};

// Canvas is defined in canvas.js (loaded after app.js).
// Results is defined in results.js (loaded after config.js).

/* =============================================================================
   Boot
   ============================================================================= */
document.addEventListener('DOMContentLoaded', () => App.init());

/* Warn before closing / reloading / navigating away.
   Set _intentionalUnload = true before a deliberate reload to skip the prompt. */
let _intentionalUnload = false;
window.addEventListener('beforeunload', (e) => {
    if (_intentionalUnload) return;
    e.preventDefault();
});
