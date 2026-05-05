'use strict';

/* =============================================================================
   Results — renders the query result table and handles CSV / JSON export.

   Replaces the Phase 1–6 stub in app.js.

   Public API:
     Results.render(result)   show the panel with query data
     Results.clear()          hide the panel and reset the table

   Result shape (from QueryBuilder.execute):
     { sql: string, cols: string[], rows: object[], count: int }
   ============================================================================= */
const Results = (() => {
    let _lastResult = null;
    let _colThemes = {};
    let _selectedCell = null;

    // Remembers whether the panel was 'fullscreen', 'tall', or 'normal' before
    // being collapsed, so the correct mode is restored on expand.
    let _preCollapseState = 'normal';

    // Compare mode
    let _compareMode = false;
    let _compareRefValue = null; // raw value of the first clicked cell in compare mode
    let _compareRefCell  = null; // the actual first TD element (reference)

    // Dataset compare state
    let _datasetCompareActive     = false;
    let _datasetCompareTrs        = []; // <tr> elements marked row-highlighted by compare
    let _datasetCompareTds        = []; // <td> elements marked col-highlight-4 by compare
    let _datasetCompareBannerTr   = null; // injected status banner row (green = all equal, red = diffs)

    // Duplicates mode
    let _duplicateMode = false;
    let _duplicateOriginCell = null; // the originally clicked cell

    // Calculus note (independent of State.notes)
    let _calculusNote         = '';
    let _calculusNoteOriginal = '';

    // Calculus mode
    let _calculusMode      = false;
    let _calculusRows      = []; // [{ id, items: [{header, value}] }]
    let _calculusActiveId  = null;
    let _calculusNextId    = 1;
    let _calculusOutOfSync     = false; // true after query re-run / table removal
    let _calculusBindModeRowId    = null;  // id of the row currently in "bind" mode, or null
    let _calcBindHoverSnapshot          = null;  // saved item values/originTds before hover preview
    let _calcBindHoverBroadcastSnapshot = null;  // saved states for all OTHER rows (sync-all mode)
    let _calcBindHoverLastTr            = null;  // last <tr> previewed to avoid redundant updates
    let _calcBindHoverHandlers          = null;  // { wrapper, onMove, onLeave } — removed on exit
    let _calculusEvalMode        = false; // true while waiting for a click after Eval prompt
    let _calculusEvalItems       = null;  // parsed items [{col,binaryOp,openParen,closeParen}]
    let _calculusEvalExpr        = '';    // original expression string (used as row name)
    let _calculusEvalTargetRowId = null;  // if set, Apply replaces this row instead of adding new
    let _calculusEvalTargetName  = null;  // saved name to apply when replacing an existing row

    // Calculus drag-to-reorder (rows)
    let _calcDragSourceId = null;

    // Calculus column drag-to-swap
    let _calcColDragSrcItem  = null;
    let _calcColDragSrcRowId = null;

    // Calculus highlight feature — set of calculus row ids with highlight active
    let _calcHighlightActiveIds = new Set();

    // Inline column filter inputs
    let _colFilters = {}; // colIdx (number) → filter text

    // True when the current result came from a CSV file (drives Excel-style header letters)
    let _lastResultIsCsv = false;

    // Column highlight (SELECT box ☆ checkbox)
    const _highlightedCols = new Set();

    // Results-header column drag-to-reorder
    let _dragReorderSrcIdx = -1;

    // Results-table client-side sort
    let _sortColIdx      = -1;
    let _sortDir         = 0;   // 0=none, 1=asc, -1=desc
    let _sortOriginalRows = [];

    // Track Alt key state independently — e.altKey is unreliable on Windows
    // (the OS may swallow Alt before mouse events fire).
    let _altKeyHeld = false;
    window.addEventListener('keydown', e => { if (e.key === 'Alt') _altKeyHeld = true;  });
    window.addEventListener('keyup',   e => { if (e.key === 'Alt') _altKeyHeld = false; });
    window.addEventListener('blur',    ()  => { _altKeyHeld = false; }); // safety reset on focus loss

    // Alt+J — copy the selected row as Heidi JSON to clipboard
    window.addEventListener('keydown', e => {
        if (!e.altKey || e.code !== 'KeyJ') return;
        if (!_selectedCell || !_lastResult) return;
        e.preventDefault();
        const tr   = _selectedCell.closest('tr');
        if (!tr) return;
        const tds  = Array.from(tr.querySelectorAll('td:not(.td-row-num)'));
        const keys = _buildJsonKeys();
        const row  = Object.fromEntries(keys.map((k, i) => [k, tds[i]?.dataset.raw ?? tds[i]?.textContent ?? null]));
        const payload = { table: _lastResult.tableRef || '', rows: [row] };
        navigator.clipboard.writeText(JSON.stringify(payload, null, '\t'))
            .then(() => App.notify?.('Row copied as JSON', 'success'));
    });

    // Flag set by the mousedown handler when Alt+right-click is detected, so the
    // subsequent contextmenu event knows to skip its own logic (avoids double-firing
    // on platforms where altKey is still present in the contextmenu event).
    let _altRightClickHandled = false;

    const THEMES = [
        'col-highlight-1',
        'col-highlight-2',
        'col-highlight-3',
        'col-highlight-4'
    ];

    // -------------------------------------------------------------------------
    // Public
    // -------------------------------------------------------------------------

    function init() {
        document.getElementById('chk-explain-colors')
            .addEventListener('change', e => {
                if (e.target.checked) {
                    if (_lastResult) _applyExplainColors(_lastResult.cols, _lastResult.rows);
                } else {
                    _clearExplainColors();
                }
            });

        document.getElementById('btn-compare')
            .addEventListener('click', _toggleCompareMode);

        document.getElementById('btn-duplicates')
            .addEventListener('click', _toggleDuplicateMode);

        document.getElementById('btn-export-csv')
            .addEventListener('click', _exportCsv);

        document.getElementById('btn-export-json')
            .addEventListener('click', _exportJson);

        document.getElementById('btn-copy-sql-select')
            .addEventListener('click', _copyAsSqlSelect);

        document.getElementById('btn-toggle-dim')
            .addEventListener('click', _toggleDimmed);

        // ---- Search toggle ----
        document.getElementById('btn-search-cols').addEventListener('click', () => {
            const panel = document.getElementById('results-panel');
            const btn   = document.getElementById('btn-search-cols');
            const isOn  = panel.classList.toggle('search-active');
            btn.classList.toggle('active', isOn);
            if (!isOn) {
                // Hide — clear all filter inputs and rerun filter
                _colFilters = {};
                document.querySelectorAll('#results-table .th-filter-input').forEach(inp => {
                    inp.value = '';
                    inp.classList.remove('has-value');
                });
                _applyColFilter();
            }
        });

        // ---- Dataset compare modal ----
        (function () {
            const modal       = document.getElementById('modal-compare-datasets');
            const btnOpen     = document.getElementById('btn-compare-datasets');
            const btnExit     = document.getElementById('btn-exit-compare-datasets');
            const btnClose    = document.getElementById('btn-compare-ds-x');
            const btnCancel   = document.getElementById('btn-compare-ds-cancel');
            const btnRun      = document.getElementById('btn-compare-ds-run');
            const btnLoadFile = document.getElementById('btn-compare-ds-load-file');
            const fileInput   = document.getElementById('compare-ds-file-input');
            const pasteArea   = document.getElementById('compare-ds-paste-area');
            const infoA       = document.getElementById('compare-ds-info-a');
            const infoB       = document.getElementById('compare-ds-info-b');
            const errEl       = document.getElementById('compare-ds-error');
            const chkHeader   = document.getElementById('chk-compare-csv-header');

            function _resetModal() {
                btnRun.disabled = true;
                pasteArea.value = '';
                infoB.textContent = '';
                errEl.classList.add('hidden');
                errEl.textContent = '';
            }

            function _close() { modal.classList.add('hidden'); }

            btnOpen.addEventListener('click', () => {
                if (!_lastResult) {
                    App.notify?.('Run a query or load a CSV first.', 'error');
                    return;
                }
                _resetModal();
                const rc = _lastResult.count;
                const cc = _lastResult.cols.length;
                infoA.textContent = `Dataset A (current result): ${rc.toLocaleString()} row${rc !== 1 ? 's' : ''} × ${cc} col${cc !== 1 ? 's' : ''}`;
                modal.classList.remove('hidden');
                pasteArea.focus();
            });

            btnClose.addEventListener('click', _close);
            btnCancel.addEventListener('click', _close);
            modal.addEventListener('click', e => { if (e.target === modal) _close(); });

            btnLoadFile.addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', () => {
                const file = fileInput.files[0];
                if (!file) return;
                fileInput.value = '';
                const reader = new FileReader();
                reader.onload = ev => {
                    pasteArea.value = ev.target.result;
                    infoB.textContent = `File: ${file.name}`;
                    btnRun.disabled = false;
                    errEl.classList.add('hidden');
                    pasteArea.focus();
                };
                reader.readAsText(file, 'UTF-8');
            });

            pasteArea.addEventListener('input', () => {
                btnRun.disabled = !pasteArea.value.trim();
                infoB.textContent = '';
                errEl.classList.add('hidden');
            });

            btnRun.addEventListener('click', () => {
                const err = _runDatasetCompare(pasteArea.value, chkHeader.checked);
                if (err) {
                    errEl.textContent = err;
                    errEl.classList.remove('hidden');
                } else {
                    _close();
                }
            });

            btnExit.addEventListener('click', _exitDatasetCompare);
        })();

        document.getElementById('btn-calculus')
            .addEventListener('click', _toggleCalculusMode);

        const _applyCalcCompactMode = (mode) => {
            // mode: null | 'semi' | 'full'
            const toolbox  = document.getElementById('calculus-toolbox');
            const btnSemi  = document.getElementById('btn-calculus-semi-compact');
            const btnFull  = document.getElementById('btn-calculus-compact');
            toolbox.classList.remove('is-semi-compact', 'is-compact');
            if (mode === 'semi') {
                toolbox.classList.add('is-semi-compact');
                btnSemi.textContent = '▥'; btnSemi.title = 'Expand rows';
                btnFull.textContent = '⊟'; btnFull.title = 'Collapse rows — show only results bar';
            } else if (mode === 'full') {
                toolbox.classList.add('is-compact');
                btnSemi.textContent = '▤'; btnSemi.title = 'Collapse table — show row headers and results bar';
                btnFull.textContent = '⊞'; btnFull.title = 'Expand rows';
            } else {
                btnSemi.textContent = '▤'; btnSemi.title = 'Collapse table — show row headers and results bar';
                btnFull.textContent = '⊟'; btnFull.title = 'Collapse rows — show only results bar';
            }
        };

        document.getElementById('btn-calculus-semi-compact')
            .addEventListener('click', () => {
                const toolbox = document.getElementById('calculus-toolbox');
                _applyCalcCompactMode(toolbox.classList.contains('is-semi-compact') ? null : 'semi');
            });

        document.getElementById('btn-calculus-compact')
            .addEventListener('click', () => {
                const toolbox = document.getElementById('calculus-toolbox');
                _applyCalcCompactMode(toolbox.classList.contains('is-compact') ? null : 'full');
            });

        document.getElementById('btn-calculus-close')
            .addEventListener('click', () => { if (_calculusMode) _toggleCalculusMode(); });

        document.getElementById('btn-calculus-maximize')
            .addEventListener('click', _toggleCalculusMaximize);

        document.getElementById('btn-calculus-clear')
            .addEventListener('click', async () => {
                if (await Dialog.confirm('Clear all Calculus expressions?')) _calcClearAll();
            });

        document.getElementById('btn-calculus-add-row')
            .addEventListener('click', _calcAddRow);

        document.getElementById('btn-calculus-legend')
            .addEventListener('click', () => {
                document.getElementById('calculus-legend-comparison').classList.toggle('hidden');
            });

        document.getElementById('btn-calculus-eval')
            .addEventListener('click', async () => {
                const input = await Dialog.prompt(
                    'Enter a SELECT expression to build as a Calculus.\n' +
                    'Use column names exactly as shown in the results table.\n' +
                    'Operators: + − * / %   Grouping: ( )\n\n' +
                    'Examples:\n' +
                    '  t1.revenue - t2.cost\n' +
                    '  (t1.price * t1.qty) + t1.discount\n' +
                    '  t1.a + t1.b - (t1.c * t1.d)'
                );
                if (input === null || !input.trim()) return; // cancelled or empty

                const parsed = _calcParseExpr(input.trim());
                if (parsed.error) {
                    await Dialog.alert(`Cannot parse expression:\n${parsed.error}`);
                    return;
                }

                // Validate column names against current results table
                const ths = Array.from(document.querySelectorAll('#results-table thead tr th'));
                if (ths.length === 0) {
                    await Dialog.alert('No results table found — run a query first.');
                    return;
                }
                const missing = parsed.items.filter(item => _findThIndexByLabel(ths, item.col) === -1);
                if (missing.length > 0) {
                    const available = ths.map(th => `"${_thGetLabel(th)}"`).join(', ');
                    await Dialog.alert(
                        `Column(s) not found in the results table:\n` +
                        `  ${missing.map(it => `"${it.col}"`).join(', ')}\n\n` +
                        `Available columns:\n  ${available}`
                    );
                    return;
                }

                _calcEnterEvalMode(parsed.items, input.trim());
            });

        // Calculus Note button
        document.getElementById('btn-calculus-note')
            .addEventListener('click', () => {
                const modal = document.getElementById('modal-calculus-note');
                if (modal.classList.contains('hidden')) _openCalculusNote();
                else _closeCalculusNote();
            });

        document.getElementById('btn-calculus-note-save')
            .addEventListener('click', () => { _saveCalculusNote(); _closeCalculusNote(); });

        document.getElementById('btn-calculus-note-x')
            .addEventListener('click', _closeCalculusNote);

        document.getElementById('calculus-note-textarea')
            .addEventListener('input', e => { _calculusNote = e.target.value; });

        // Math calculator popup
        const _mathPopup  = document.getElementById('calculus-math-popup');
        const _mathInput  = document.getElementById('calculus-math-input');
        const _mathResult = document.getElementById('calculus-math-result');

        function _mathEval(rawExpr) {
            const expr = rawExpr.trim();
            if (!expr) return { ok: false, error: 'Please enter a math expression.' };
            if (!/^[\d\s+\-*/%.()]+$/.test(expr)) {
                return { ok: false, error: 'Not a valid math expression — only numbers and operators (+  −  *  /  %  .) are allowed.' };
            }
            try {
                // eslint-disable-next-line no-new-func
                const result = Function('"use strict"; return (' + expr + ')')();
                if (typeof result !== 'number') return { ok: false, error: 'Not a valid math expression.' };
                if (!isFinite(result)) return { ok: false, error: isNaN(result) ? 'Not a valid math expression.' : 'Result is infinite (division by zero?).' };
                return { ok: true, result };
            } catch (e) {
                return { ok: false, error: 'Not a valid math expression.' };
            }
        }

        function _mathShowResult() {
            const { ok, result, error } = _mathEval(_mathInput.value);
            _mathResult.className = ok ? 'is-ok' : 'is-error';
            _mathResult.textContent = ok
                ? `= ${result.toLocaleString(undefined, { maximumFractionDigits: 10, useGrouping: false })}`
                : error;
        }

        let _mathSynced = false;
        function _mathToggle() {
            const isHidden = _mathPopup.classList.toggle('hidden');
            if (!isHidden) {
                if (!_mathSynced) {
                    const btnH = document.getElementById('btn-calculus-math-calc').offsetHeight;
                    if (btnH > 0) {
                        _mathInput.style.height    = btnH + 'px';
                        _mathInput.style.minHeight = btnH + 'px';
                        _mathSynced = true;
                    }
                }
                _mathInput.focus();
            }
        }

        document.getElementById('btn-calculus-math')
            .addEventListener('click', _mathToggle);

        document.getElementById('btn-calculus-math-close')
            .addEventListener('click', () => _mathPopup.classList.add('hidden'));

        document.getElementById('btn-calculus-math-calc')
            .addEventListener('click', _mathShowResult);

        document.getElementById('btn-calculus-math-clear')
            .addEventListener('click', () => {
                _mathInput.value = '';
                _mathInput.dispatchEvent(new Event('input', { bubbles: true })); // refresh backdrop
                _mathResult.className = '';
                _mathResult.textContent = '';
                _mathInput.focus();
            });

        _mathInput.addEventListener('keydown', e => {
            if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault();
                _mathShowResult();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                _mathPopup.classList.add('hidden');
            } else if (e.altKey && e.code === 'KeyC') {
                e.preventDefault();
                e.stopPropagation();
                _mathInput.value = '';
                _mathInput.dispatchEvent(new Event('input', { bubbles: true })); // refresh backdrop
                _mathResult.className = '';
                _mathResult.textContent = '';
                _mathInput.focus();
            }
        });

        // Maximize / restore
        let _mathPreMaxStyles = null;
        document.getElementById('btn-calculus-math-maximize')
            .addEventListener('click', () => {
                const btn   = document.getElementById('btn-calculus-math-maximize');
                const isMax = _mathPopup.classList.contains('is-maximized');
                if (isMax) {
                    _mathPopup.classList.remove('is-maximized');
                    if (_mathPreMaxStyles) { Object.assign(_mathPopup.style, _mathPreMaxStyles); _mathPreMaxStyles = null; }
                    btn.textContent = '⛶';
                    btn.title       = 'Maximize (Alt+T)';
                } else {
                    _mathPreMaxStyles = { top: _mathPopup.style.top, left: _mathPopup.style.left, right: _mathPopup.style.right, bottom: _mathPopup.style.bottom, width: _mathPopup.style.width, height: _mathPopup.style.height, transform: _mathPopup.style.transform, maxWidth: _mathPopup.style.maxWidth, maxHeight: _mathPopup.style.maxHeight };
                    _mathPopup.classList.add('is-maximized');
                    btn.textContent = '⊡';
                    btn.title       = 'Restore (Alt+T)';
                }
                _mathInput.focus();
            });

        // When a resize drag starts, drop the JS-set explicit height so flex
        // layout can stretch the textarea to fill the popup naturally.
        _mathPopup.querySelectorAll('.calculus-resize-handle').forEach(h => {
            h.addEventListener('mousedown', () => { _mathInput.style.height = ''; });
        });

        // History popup — close, maximize/restore, copy, CSV export
        const _histPopup   = document.getElementById('calculus-history-popup');
        const _histTextarea = document.getElementById('calculus-history-textarea');
        let   _histPreMaxStyles = null;

        document.getElementById('btn-calculus-history-close')
            .addEventListener('click', () => _histPopup.classList.add('hidden'));

        document.getElementById('btn-calculus-history-maximize')
            .addEventListener('click', () => {
                const isMax = _histPopup.classList.contains('is-maximized');
                if (isMax) {
                    _histPopup.classList.remove('is-maximized');
                    if (_histPreMaxStyles) { Object.assign(_histPopup.style, _histPreMaxStyles); _histPreMaxStyles = null; }
                    document.getElementById('btn-calculus-history-maximize').textContent = '⛶';
                    document.getElementById('btn-calculus-history-maximize').title = 'Maximize';
                } else {
                    _histPreMaxStyles = { top: _histPopup.style.top, left: _histPopup.style.left, right: _histPopup.style.right, bottom: _histPopup.style.bottom, width: _histPopup.style.width, height: _histPopup.style.height, transform: _histPopup.style.transform, maxWidth: _histPopup.style.maxWidth, maxHeight: _histPopup.style.maxHeight };
                    _histPopup.classList.add('is-maximized');
                    document.getElementById('btn-calculus-history-maximize').textContent = '⊡';
                    document.getElementById('btn-calculus-history-maximize').title = 'Restore';
                }
                _histTextarea.focus();
            });

        // Alt+T while the textarea is focused → toggle maximize / restore.
        // Use e.code ('KeyT') instead of e.key — on macOS, Alt+T produces the
        // dagger character '†' as e.key, so the letter check would never match.
        // stopPropagation() prevents the global window Alt+T handler (app.js)
        // from also firing.
        _histTextarea.addEventListener('keydown', e => {
            if (e.altKey && e.code === 'KeyT') {
                e.preventDefault();
                e.stopPropagation();
                document.getElementById('btn-calculus-history-maximize').click();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                _histPopup.classList.add('hidden');
            }
        });

        document.getElementById('btn-calculus-history-copy')
            .addEventListener('click', () => {
                navigator.clipboard.writeText(_histTextarea.value)
                    .then(() => App.notify?.('History copied', 'success'))
                    .catch(() => App.notify?.('Copy failed', 'error'));
            });

        document.getElementById('btn-calculus-history-csv')
            .addEventListener('click', () => {
                const rowData = _calculusRows.find(r => r.id === _historyActiveRowId);
                if (!rowData) return;
                const csv  = _calcHistoryToCsv(rowData.historyRows ?? []);
                const blob = new Blob([csv], { type: 'text/csv' });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                const name = (rowData.historyRows?.find(r => r.type === 'header')?.name || 'calculus-history').replace(/\s+/g, '_');
                const _d   = new Date();
                const _pad = n => String(n).padStart(2, '0');
                const _ts  = `${_d.getFullYear()}-${_pad(_d.getMonth()+1)}-${_pad(_d.getDate())}_${_pad(_d.getHours())}_${_pad(_d.getMinutes())}_${_pad(_d.getSeconds())}`;
                a.href = url; a.download = `${name}_${_ts}.csv`; a.click();
                URL.revokeObjectURL(url);
            });

        document.getElementById('btn-results-tall')
            .addEventListener('click', _toggleTall);

        document.getElementById('btn-results-fullscreen')
            .addEventListener('click', _toggleFullscreen);

        document.getElementById('btn-toggle-results')
            .addEventListener('click', _toggleCollapsed);

        _initResultsResizer();

        // Restore persisted collapse state (panel is hidden at this point, so no visual jump)
        if (localStorage.getItem('results-collapsed') === 'true') {
            document.getElementById('results-panel').classList.add('is-collapsed');
            document.getElementById('btn-toggle-results').textContent = '▲';
            document.getElementById('btn-toggle-results').title = 'Restore results';
        }

        // Restore persisted tall / fullscreen state (mutually exclusive)
        if (localStorage.getItem('results-fullscreen') === 'true') {
            _setFullscreen(true);
        } else if (localStorage.getItem('results-tall') === 'true') {
            _setTall(true);
        }

        // Global copy listener
        window.addEventListener('keydown', _onKeyDown);
    }

    /**
     * Populate and show the results panel.
     * Also updates the SQL preview bar with the server-generated SQL.
     * Always expands the panel so fresh results are immediately visible.
     */
    function render(result) {
        // If a dataset compare is active, clean it up — the table is being replaced
        if (_datasetCompareActive) {
            _datasetCompareTrs = [];
            _datasetCompareTds = [];
            _datasetCompareBannerTr = null; // tbody is about to be wiped
            _datasetCompareActive = false;
            document.getElementById('btn-exit-compare-datasets')?.classList.add('hidden');
            document.getElementById('btn-compare-datasets')?.classList.remove('hidden');
            _setDimmed(false);
        }

        // Clear any previous error banner
        const errEl = document.getElementById('results-error');
        if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }

        _lastResult = result;

        // Debug: log col_types to help diagnose remote-DB metadata issues.
        if (result.col_types?.length) {
            console.debug('[SQL Joiner] col_types:', result.col_types,
                          'cols:', result.cols?.slice(0, result.col_types.length));
        }

        _colFilters = {};
        _lastResultIsCsv = !!result._csvSource;
        _populateTable(result.cols, result.rows, result.col_tables || [], result.col_types || []);
        _applyExplainColors(result.cols, result.rows);

        // Lock column widths after the initial layout so filtering never resizes columns
        requestAnimationFrame(() => {
            document.querySelectorAll('#results-table thead th')
                .forEach(th => { th.style.minWidth = th.offsetWidth + 'px'; });
        });

        document.getElementById('results-meta').textContent =
            `${result.count.toLocaleString()} row${result.count !== 1 ? 's' : ''}`;

        // Expand on new results so the user always sees the data
        _setCollapsed(false);

        document.getElementById('results-panel').classList.remove('hidden');

        // Enable the Calculus button now that there are valid results to work with
        const _calcBtn = document.getElementById('btn-calculus');
        if (_calcBtn) {
            _calcBtn.disabled = false;
            _calcBtn.title = 'Calculus mode — double-click numeric cells to build expressions';
        }

        // Mirror the server-generated SQL in the preview bar so the user sees
        // exactly what ran (after parameter substitution and JOIN ordering).
        if (result.sql) {
            document.getElementById('sql-preview-text').textContent = result.sql;
        }
    }

    /** Hide the panel and wipe all content. */
    function clear() {
        if (_datasetCompareActive) {
            _datasetCompareTrs = [];
            _datasetCompareTds = [];
            _datasetCompareBannerTr = null; // tbody is about to be wiped
            _datasetCompareActive = false;
            document.getElementById('btn-exit-compare-datasets')?.classList.add('hidden');
            document.getElementById('btn-compare-datasets')?.classList.remove('hidden');
        }
        _lastResult = null;
        _colThemes = {};
        _selectedCell = null;
        _compareMode = false;
        _compareRefValue = null;
        _compareRefCell  = null;
        const btnCompare = document.getElementById('btn-compare');
        if (btnCompare) {
            btnCompare.classList.remove('is-active');
            btnCompare.title = 'Compare cell values';
        }
        _duplicateMode = false;
        _duplicateOriginCell = null;
        const btnDup = document.getElementById('btn-duplicates');
        if (btnDup) {
            btnDup.classList.remove('is-active');
            btnDup.textContent = '⧉ Duplicates';
            btnDup.title = 'Highlight duplicate cell values';
        }
        document.getElementById('results-panel').classList.add('hidden');
        _colFilters = {};
        _lastResultIsCsv = false;
        document.querySelector('#results-table thead').innerHTML = '';
        document.querySelector('#results-table tbody').innerHTML = '';
        document.getElementById('results-meta').textContent = '';
        const errEl = document.getElementById('results-error');
        if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }

        // No valid results — disable Calculus and close it if open
        _disableCalculusBtn();
    }

    /**
     * Display a server/query error inside the results panel so the full
     * message is readable (especially for long SQL errors that get clipped
     * in the toast notification).
     */
    function renderError(message) {
        _lastResult = null;

        // Wipe any stale table content
        document.querySelector('#results-table thead').innerHTML = '';
        document.querySelector('#results-table tbody').innerHTML = '';
        document.getElementById('results-meta').textContent = 'Error';

        // Show the error banner
        const errEl = document.getElementById('results-error');
        if (errEl) {
            errEl.textContent = message;
            errEl.classList.remove('hidden');
        }

        // Expand the panel so the error is immediately visible
        _setCollapsed(false);
        document.getElementById('results-panel').classList.remove('hidden');

        // No valid results — disable Calculus and close it if open
        _disableCalculusBtn();
    }

    // -------------------------------------------------------------------------
    // Collapse / expand
    // -------------------------------------------------------------------------

    function _toggleCollapsed() {
        const panel       = document.getElementById('results-panel');
        const isCollapsed = panel.classList.contains('is-collapsed');
        const isFull      = panel.classList.contains('is-fullscreen');
        const isTall      = panel.classList.contains('is-tall');

        if (isCollapsed) {
            // Restore: expand first, then re-apply whichever mode was active before
            _setCollapsed(false);
            if (_preCollapseState === 'fullscreen') _setFullscreen(true);
            else if (_preCollapseState === 'tall')  _setTall(true);
            // 'normal' → no extra step needed
        } else {
            // Save current mode so we can restore it on expand
            _preCollapseState = isFull ? 'fullscreen' : isTall ? 'tall' : 'normal';
            // Expanding modes override is-collapsed via CSS cascade, so exit them first
            if (isFull) _setFullscreen(false);
            if (isTall) _setTall(false);
            _setCollapsed(true);
        }
    }

    function _setCollapsed(collapsed) {
        const panel = document.getElementById('results-panel');
        const btn   = document.getElementById('btn-toggle-results');
        panel.classList.toggle('is-collapsed', collapsed);
        btn.textContent = collapsed ? '▲' : '▼';
        btn.title       = collapsed ? 'Restore results' : 'Minimize results';
        localStorage.setItem('results-collapsed', collapsed);
    }

    // -------------------------------------------------------------------------
    // Tall (stretch height only, keep horizontal bounds)
    // -------------------------------------------------------------------------

    function _toggleTall() {
        const panel = document.getElementById('results-panel');
        _setTall(!panel.classList.contains('is-tall'));
    }

    function _setTall(tall) {
        const panel = document.getElementById('results-panel');
        const btn   = document.getElementById('btn-results-tall');
        panel.classList.toggle('is-tall', tall);
        if (btn) {
            btn.textContent = tall ? '↕' : '↕';
            btn.title       = tall ? 'Restore results height' : 'Stretch results height';
            btn.classList.toggle('active', tall);
        }
        localStorage.setItem('results-tall', tall);

        if (tall) {
            _setCollapsed(false);
            // Deactivate fullscreen — they are mutually exclusive
            _setFullscreen(false);
        }
    }

    // -------------------------------------------------------------------------
    // Fullscreen (maximize results over canvas — height + width)
    // -------------------------------------------------------------------------

    function _toggleFullscreen() {
        const panel = document.getElementById('results-panel');
        const isFull = panel.classList.contains('is-fullscreen');
        _setFullscreen(!isFull);
    }

    function _setFullscreen(full) {
        const panel = document.getElementById('results-panel');
        const btn   = document.getElementById('btn-results-fullscreen');
        panel.classList.toggle('is-fullscreen', full);
        if (btn) {
            btn.textContent = full ? '⤡' : '⤢';
            btn.title       = full ? 'Restore results size' : 'Maximize results';
        }
        localStorage.setItem('results-fullscreen', full);

        if (full) {
            _setCollapsed(false);
            // Deactivate tall — they are mutually exclusive
            _setTall(false);
        }
    }

    // -------------------------------------------------------------------------
    // Results panel height resizer
    // -------------------------------------------------------------------------

    function _initResultsResizer() {
        const handle = document.getElementById('resizer-results');
        if (!handle) return;

        const MIN_H = 80;

        handle.addEventListener('mousedown', e => {
            const panel = document.getElementById('results-panel');
            if (panel.classList.contains('is-collapsed') ||
                panel.classList.contains('is-tall') ||
                panel.classList.contains('is-fullscreen')) return;

            e.preventDefault();

            const startY = e.clientY;
            const startH = panel.offsetHeight;

            document.body.classList.add('is-resizing-results');

            const topbarH    = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--topbar-height'))    || 46;
            const bottombarH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottombar-height')) || 58;
            const MAX_H = window.innerHeight - topbarH - bottombarH - 10;

            function onMove(e) {
                const dy   = startY - e.clientY;
                const newH = Math.min(MAX_H, Math.max(MIN_H, startH + dy));
                document.documentElement.style.setProperty('--results-height', newH + 'px');
            }

            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup',   onUp);
                document.body.classList.remove('is-resizing-results');
                localStorage.setItem('results-height', panel.offsetHeight);
            }

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup',   onUp);
        });

        // Restore persisted height
        const savedH = localStorage.getItem('results-height');
        if (savedH) {
            document.documentElement.style.setProperty('--results-height', savedH + 'px');
        }
    }

    // -------------------------------------------------------------------------
    // Dimming
    // -------------------------------------------------------------------------

    function _dimWantRowMode(tbody) {
        return (tbody && tbody.querySelector('tr.row-highlighted') !== null)
            || _calcHighlightActiveIds.size > 0
            || (tbody && THEMES.some(t => tbody.querySelector(`td.td-row-num.${t}`) !== null));
    }

    function _toggleDimmed() {
        const table = document.getElementById('results-table');
        const isDimmed = table.classList.contains('is-dimmed');
        _setDimmed(!isDimmed);
    }

    // Columns that were colored at any point during the current Dim session.
    // Once pinned, a column stays visible even if its color is later removed.
    let _dimPinnedCols = new Set();

    // When true, Dim hides/fades rows (row-mode); when false it hides columns (col-mode).
    let _dimRowMode = false;

    function _setDimmed(dimmed) {
        const table = document.getElementById('results-table');
        const btn   = document.getElementById('btn-toggle-dim');
        table.classList.toggle('is-dimmed', dimmed);
        btn.classList.toggle('is-active', dimmed);

        if (dimmed) {
            const tbody = table.querySelector('tbody');
            _dimRowMode = _dimWantRowMode(tbody);

            if (!_dimRowMode) {
                // Column mode: seed pinned set with already-colored columns
                _dimPinnedCols = new Set();
                if (_lastResult) {
                    _lastResult.cols.forEach((_col, colIdx) => {
                        if (_colThemes[colIdx]) { _dimPinnedCols.add(colIdx); return; }
                        const nth = colIdx + 2;
                        if (tbody && THEMES.some(t => tbody.querySelector(`tr td:nth-child(${nth}).${t}`)))
                            _dimPinnedCols.add(colIdx);
                    });
                }
            } else {
                _dimPinnedCols = new Set();
            }
        } else {
            // Turning Dim off: remove row-mode classes; keep row-highlighted state intact
            _dimRowMode = false;
            _dimPinnedCols = new Set();
            const tbody = table.querySelector('tbody');
            if (tbody) {
                tbody.querySelectorAll('tr.dim-row-hidden')
                    .forEach(tr => tr.classList.remove('dim-row-hidden'));
                tbody.querySelectorAll('tr.row-hl-faded')
                    .forEach(tr => tr.classList.remove('row-hl-faded'));
            }
        }
        _applyDimVisibility();
        _applyDimRowVisibility();
    }

    function _applyDimVisibility() {
        const table = document.getElementById('results-table');
        if (!table || !_lastResult) return;
        const isDimmed = table.classList.contains('is-dimmed');
        // In row-mode, columns are all visible
        _lastResult.cols.forEach((_col, colIdx) => {
            const hide = isDimmed && !_dimRowMode && !_dimPinnedCols.has(colIdx);
            const nth = colIdx + 2;
            table.querySelectorAll(`th:nth-child(${nth}), td:nth-child(${nth})`).forEach(cell => {
                cell.style.display = hide ? 'none' : '';
            });
        });
    }

    /**
     * Apply row-mode Dim visibility.
     * - If Dim is off: no-op (state already cleared in _setDimmed).
     * - If Dim is on and _dimRowMode:
     *     - row-highlighted, row-hl-faded, or calculus-hl rows → visible (remove dim-row-hidden)
     *     - other rows → dim-row-hidden
     *   If no row-highlighted rows and no cols pinned → hide everything (headers only).
     */
    function _applyDimRowVisibility() {
        const table = document.getElementById('results-table');
        if (!table) return;
        const isDimmed = table.classList.contains('is-dimmed');
        if (!isDimmed || !_dimRowMode) return;

        const tbody = table.querySelector('tbody');
        if (!tbody) return;

        tbody.querySelectorAll('tr').forEach(tr => {
            const isHighlighted   = tr.classList.contains('row-highlighted');
            const isFaded         = tr.classList.contains('row-hl-faded');
            const isCalculusHl    = tr.classList.contains('calculus-hl');
            const isCompareBanner = tr.classList.contains('compare-banner-row');
            const hasRowColor     = THEMES.some(t => tr.querySelector('.td-row-num')?.classList.contains(t));
            if (isHighlighted || isFaded || isCalculusHl || isCompareBanner || hasRowColor) {
                tr.classList.remove('dim-row-hidden');
            } else {
                tr.classList.add('dim-row-hidden');
            }
        });
    }

    /**
     * Compare the current result table (Dataset A) against a CSV string (Dataset B).
     * Highlights mismatched rows with row-highlighted and mismatched cells with
     * col-highlight-4 (red), then auto-activates DIM in row-mode.
     * Returns an error string on failure, or null on success.
     */
    function _runDatasetCompare(csvText, hasHeader) {
        if (!_lastResult) return 'No current result to compare against.';

        const parsed = _parseCsv(csvText);
        if (parsed.error) return parsed.error;

        // _parseCsv always treats row 0 as cols (header) and rest as data rows.
        // When hasHeader=false the first CSV row is real data — prepend it back.
        const bRows = hasHeader
            ? parsed.rows
            : [parsed.cols, ...parsed.rows];

        const tbody   = document.querySelector('#results-table tbody');
        const aTrs    = Array.from(tbody.querySelectorAll('tr'));
        const aColCnt = _lastResult.cols.length;
        const bColCnt = parsed.cols.length;

        if (aColCnt !== bColCnt) {
            return `Column count mismatch: Dataset A has ${aColCnt} column${aColCnt !== 1 ? 's' : ''}, Dataset B has ${bColCnt} column${bColCnt !== 1 ? 's' : ''}.`;
        }

        const aRowCnt = aTrs.length;
        const bRowCnt = bRows.length;
        if (aRowCnt !== bRowCnt) {
            return `Row count mismatch: Dataset A has ${aRowCnt.toLocaleString()} row${aRowCnt !== 1 ? 's' : ''}, Dataset B has ${bRowCnt.toLocaleString()} row${bRowCnt !== 1 ? 's' : ''}.`;
        }

        _datasetCompareTrs = [];
        _datasetCompareTds = [];

        aTrs.forEach((tr, ri) => {
            const tds  = Array.from(tr.querySelectorAll('td:not(.td-row-num)'));
            const bRow = bRows[ri];
            let mismatch = false;

            tds.forEach((td, ci) => {
                const aVal = String(td.dataset.raw ?? '');
                const bVal = String(bRow[ci] ?? '');
                if (aVal === bVal) return;
                // Numeric fallback: "0.4500" (from DB) vs 0.45 (parsed by _parseCsv)
                const aNum = Number(aVal);
                const bNum = Number(bVal);
                if (aVal !== '' && bVal !== '' && !isNaN(aNum) && !isNaN(bNum) && aNum === bNum) return;
                td.classList.add('col-highlight-4');
                _datasetCompareTds.push(td);
                mismatch = true;
            });

            if (mismatch) {
                tr.classList.add('row-highlighted');
                _datasetCompareTrs.push(tr);
            }
        });

        _datasetCompareActive = true;
        document.getElementById('btn-compare-datasets').classList.add('hidden');
        document.getElementById('btn-exit-compare-datasets').classList.remove('hidden');

        const colSpan = (_lastResult.cols.length || 1) + 1; // +1 for row-num col
        const bannerTr = document.createElement('tr');
        const bannerTd = document.createElement('td');
        bannerTd.colSpan = colSpan;
        tbody.insertBefore(bannerTr, tbody.firstChild);
        _datasetCompareBannerTr = bannerTr;

        if (_datasetCompareTrs.length === 0) {
            // All rows matched
            bannerTr.className = 'compare-banner-row compare-banner-row--ok';
            bannerTd.textContent = '✓ All rows are equal';
        } else {
            // Differences found
            const rc = _datasetCompareTrs.length;
            const dc = new Set(_datasetCompareTds.map(td => td.cellIndex)).size;
            const ec = _datasetCompareTds.length;
            bannerTr.className = 'compare-banner-row compare-banner-row--diff';
            bannerTd.textContent = `✕ ${rc.toLocaleString()} row${rc !== 1 ? 's' : ''}, ${dc.toLocaleString()} column${dc !== 1 ? 's' : ''}, ${ec.toLocaleString()} cell${ec !== 1 ? 's' : ''} have differences`;
            // row-highlighted marks are already set — _dimWantRowMode will pick up row-mode
            _setDimmed(true);
        }
        bannerTr.appendChild(bannerTd);

        return null;
    }

    function _exitDatasetCompare() {
        _datasetCompareTrs.forEach(tr => tr.classList.remove('row-highlighted'));
        _datasetCompareTds.forEach(td => td.classList.remove('col-highlight-4'));
        _datasetCompareTrs = [];
        _datasetCompareTds = [];
        _datasetCompareBannerTr?.remove();
        _datasetCompareBannerTr = null;
        _datasetCompareActive = false;

        _setDimmed(false);

        document.getElementById('btn-exit-compare-datasets').classList.add('hidden');
        document.getElementById('btn-compare-datasets').classList.remove('hidden');
    }

    /**
     * While Dim is on, recompute row vs column mode from row marks and active calculus HL,
     * then re-apply column/row visibility.
     */
    function _dimRefreshModeIfDimmed() {
        const table = document.getElementById('results-table');
        if (!table?.classList.contains('is-dimmed')) return;
        const tbody = table.querySelector('tbody');
        const wantRowMode = _dimWantRowMode(tbody);
        if (wantRowMode !== _dimRowMode) {
            _dimRowMode = wantRowMode;
            if (_dimRowMode) {
                _dimPinnedCols = new Set();
            } else {
                _dimPinnedCols = new Set();
                if (_lastResult) {
                    _lastResult.cols.forEach((_col, colIdx) => {
                        if (_colThemes[colIdx]) { _dimPinnedCols.add(colIdx); return; }
                        const nth = colIdx + 2;
                        if (tbody && THEMES.some(t => tbody.querySelector(`tr td:nth-child(${nth}).${t}`)))
                            _dimPinnedCols.add(colIdx);
                    });
                }
                if (tbody) {
                    tbody.querySelectorAll('tr.dim-row-hidden')
                        .forEach(tr => tr.classList.remove('dim-row-hidden'));
                    tbody.querySelectorAll('tr.row-hl-faded')
                        .forEach(tr => tr.classList.remove('row-hl-faded'));
                }
            }
        }
        _applyDimVisibility();
        _applyDimRowVisibility();
    }

    /**
     * Handle Alt+right-click on a result row.
     * Dim OFF: toggle row-highlighted (mark / unmark).
     * Dim ON (row-mode): cycle visible→faded→visible; if row is dim-hidden (shouldn't happen
     *   normally) it gets marked instead.
     */
    function _altRightClickRow(tr) {
        const table = document.getElementById('results-table');
        const isDimmed = table?.classList.contains('is-dimmed');

        if (!isDimmed || !_dimRowMode) {
            // Dim is off: simple toggle mark
            tr.classList.toggle('row-highlighted');
        } else {
            // Dim is on, row-mode: cycle faded → normal (highlighted) → faded
            if (tr.classList.contains('row-hl-faded')) {
                tr.classList.remove('row-hl-faded');
                // Row stays visible (highlighted), no dim-row-hidden
            } else if (tr.classList.contains('row-highlighted')) {
                tr.classList.add('row-hl-faded');
            } else {
                // Was dim-hidden — promote to highlighted
                tr.classList.remove('dim-row-hidden');
                tr.classList.add('row-highlighted');
            }
        }
        if (table?.classList.contains('is-dimmed')) _dimRefreshModeIfDimmed();
    }

    function _likeToRegex(pattern) {
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        return new RegExp('^' + escaped.replace(/%/g, '.*') + '$', 'i');
    }

    function _applyColFilter() {
        const tbody = document.querySelector('#results-table tbody');
        if (!tbody) return;
        const ths = Array.from(document.querySelectorAll('#results-table thead th'));

        // Restore all rows first so widths are measured with full data visible
        tbody.querySelectorAll('tr.row-col-filter-hidden')
            .forEach(tr => tr.classList.remove('row-col-filter-hidden'));

        const entries = Object.entries(_colFilters).filter(([, v]) => v.trim());
        if (!entries.length) return;

        Array.from(tbody.querySelectorAll('tr')).forEach(tr => {
            const tds = Array.from(tr.querySelectorAll('td:not(.td-row-num)'));
            const passes = entries.every(([idx, text]) => {
                const cell = tds[+idx];
                const val  = cell?.dataset.raw ?? cell?.textContent ?? '';
                return _likeToRegex(text).test(val);
            });
            if (!passes) tr.classList.add('row-col-filter-hidden');
        });
        _calcApplyAllActiveHighlights?.();
    }

    function _dimPinCol(colIdx) {
        if (document.getElementById('results-table')?.classList.contains('is-dimmed'))
            _dimPinnedCols.add(colIdx);
    }

    // -------------------------------------------------------------------------
    // Table rendering
    // -------------------------------------------------------------------------

    /**
     * Find the strongest index key ('PRI' > 'UNI' > 'MUL') for a column name
     * by searching across all tables currently in State.
     */
    function _getColKey(colName) {
        const bare     = colName.includes('.') ? colName.split('.').pop() : colName;
        const priority = { PRI: 3, UNI: 2, MUL: 1 };
        let best = '';
        for (const table of (State.tables ?? [])) {
            const col = (table.columns ?? []).find(c => c.name === bare);
            if (col?.key && (priority[col.key] ?? 0) > (priority[best] ?? 0)) {
                best = col.key;
            }
        }
        return best;
    }

    /** Convert a 0-based column index to an Excel-style letter label (A, B, … Z, AA, AB, …). */
    function _excelCol(idx) {
        let label = '';
        let n = idx;
        do {
            label = String.fromCharCode(65 + (n % 26)) + label;
            n = Math.floor(n / 26) - 1;
        } while (n >= 0);
        return label;
    }

    /**
     * Format the table header label for a result column.
     * If the column name matches a user-defined alias (SELECT ... AS alias),
     * return it as-is. Otherwise, prefix with the table alias inferred from State.
     *
     * @param {string} colName   - raw column name from the result set
     * @param {number} colIdx    - position of this column in the result cols array
     * @param {string[]} allCols - the full result cols array (needed for duplicate detection)
     */
    function _formatHeaderLabel(colName, colIdx = 0, allCols = [], colTable = '', allColTables = [], activeIds = null) {
        const name            = String(colName ?? '');
        const nameLc          = name.toLowerCase();
        const bareName        = name.includes('.') ? name.split('.').pop() : name;
        const selectAliases   = State.selectAliases || {};
        const sortAlphaOn     = State.selectSortAlpha   ?? false;
        const showSchemaAlias = State.selectSchemaAlias ?? true;

        // Helper: alias-aware sort key for a "tableAlias.colName" key
        const _sortKey = k => {
            const al = (selectAliases[k] || '').trim();
            return al ? al.toLowerCase()
                      : (k.includes('.') ? k.split('.')[1] : k).toLowerCase();
        };

        // 0) PRIMARY path: PDO gives us the real table name for every result column.
        //    Map it to the user-assigned alias from State.tables (case-insensitive).
        //    This is the most reliable source — no guessing, no order-dependency.
        //    Use occurrence-index logic so self-joins (multiple aliases for the same
        //    real table) each get their own correct alias (a1, a2, a3…).
        if (colTable) {
            const colTableLc    = colTable.toLowerCase();
            const matchingTbls  = Array.isArray(State.tables)
                ? State.tables.filter(t =>
                    (t.name.toLowerCase() === colTableLc || (t.alias || '').toLowerCase() === colTableLc) &&
                    (!activeIds || activeIds.has(t.id))
                )
                : [];
            if (matchingTbls.length > 0) {
                const occurrenceBefore = allColTables
                    .slice(0, colIdx)
                    .filter(ct => (ct || '').toLowerCase() === colTableLc)
                    .length;
                const tbl = matchingTbls[occurrenceBefore] ?? matchingTbls[matchingTbls.length - 1];
                if (tbl?.alias) {
                    return showSchemaAlias ? `${tbl.alias}.${bareName}` : bareName;
                }
            }
        }

        // 1) Column alias match: the DB returns the alias as the column name.
        //    Always prefix with the table alias so the user knows which table it
        //    belongs to.  Use occurrence-index logic so two aliases with the same
        //    value (from different tables) are resolved in the correct order.
        const matchingAliasKeys = Object.keys(selectAliases)
            .filter(k => (selectAliases[k] || '').trim().toLowerCase() === nameLc);

        if (matchingAliasKeys.length > 0) {
            const occurrenceBeforeAlias = allCols.slice(0, colIdx)
                .filter(c => String(c).toLowerCase() === nameLc).length;

            const sortedAliasKeys = sortAlphaOn
                ? [...matchingAliasKeys].sort((a, b) => _sortKey(a).localeCompare(_sortKey(b)))
                : matchingAliasKeys;

            const matchedKey = sortedAliasKeys[occurrenceBeforeAlias] ?? sortedAliasKeys[0];
            const tblAlias   = matchedKey.includes('.') ? matchedKey.split('.')[0] : null;
            return (tblAlias && showSchemaAlias) ? `${tblAlias}.${name}` : name;
        }

        // Custom-expression aliases — return as-is (no table prefix makes sense here)
        const customExprs = State.selectCustomExprs ?? [];
        if (customExprs.some(e => (e.alias ?? '') === name)) {
            return name;
        }

        // 2) Fallback A: infer from columnOrder (case-insensitive, sort-aware).
        //    Restrict to active island columns to avoid picking up the same column
        //    name from a different island's table.
        const bareNameLc  = bareName.toLowerCase();
        const rawColOrder = (State.columnOrder || []).filter(k => {
            if (!activeIds) return true;
            const alias = k.split('.')[0];
            return (State.tables || []).some(t => t.alias === alias && activeIds.has(t.id));
        });

        const effectiveOrder = sortAlphaOn
            ? [...rawColOrder].sort((a, b) => _sortKey(a).localeCompare(_sortKey(b)))
            : rawColOrder;

        const occurrenceBefore = allCols.slice(0, colIdx).filter(c => {
            const b = String(c).includes('.') ? String(c).split('.').pop() : String(c);
            return b.toLowerCase() === bareNameLc;
        }).length;

        let tableAlias = null;
        let matchCount = 0;
        for (const key of effectiveOrder) {
            const parts = String(key).split('.');
            if (parts[1]?.toLowerCase() === bareNameLc && parts[0]) {
                if (matchCount === occurrenceBefore) {
                    tableAlias = parts[0];
                    break;
                }
                matchCount++;
            }
        }

        // 3) Fallback B: scan State.tables directly (case-insensitive, active island only).
        if (!tableAlias && Array.isArray(State.tables)) {
            let tableMatchCount = 0;
            const tbls = activeIds
                ? State.tables.filter(t => activeIds.has(t.id))
                : State.tables;
            for (const t of tbls) {
                if ((t.columns ?? []).some(c => c.name.toLowerCase() === bareNameLc)) {
                    if (tableMatchCount === occurrenceBefore) {
                        tableAlias = t.alias || null;
                        break;
                    }
                    tableMatchCount++;
                }
            }
        }

        return (tableAlias && showSchemaAlias) ? `${tableAlias}.${bareName}` : (tableAlias ? bareName : name);
    }

    /** Returns '#ffffff' or '#1a1a1a' — whichever is more readable on `hex` background. */
    function _readableTextColor(hex) {
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        const lin = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        return L > 0.179 ? '#1a1a1a' : '#ffffff';
    }

    /**
     * Reconstruct the SELECT state key (e.g. "u.age") for a result column.
     * Used to tag <th> elements so the highlight feature can locate them.
     */
    function _computeColKey(col, colTable, colIdx = 0, allColTables = [], activeIds = null) {
        // If col is an explicit alias, find the original select key
        const nameLc = String(col).toLowerCase();
        const aliasEntry = Object.entries(State.selectAliases || {})
            .find(([, v]) => (v || '').trim().toLowerCase() === nameLc);
        if (aliasEntry) return aliasEntry[0];

        const bare     = col.includes('.') ? col.split('.').pop() : col;
        const bareNameLc = bare.toLowerCase();

        // Reconstruct from table alias + bare column name.
        // Use occurrence-index so self-joins resolve to the correct alias.
        // Restrict to active island to avoid picking up the same table from another island.
        if (colTable) {
            const colTableLc   = colTable.toLowerCase();
            const matchingTbls = Array.isArray(State.tables)
                ? State.tables.filter(t =>
                    (t.name.toLowerCase() === colTableLc || (t.alias || '').toLowerCase() === colTableLc) &&
                    (!activeIds || activeIds.has(t.id))
                )
                : [];
            if (matchingTbls.length > 0) {
                const occurrenceBefore = allColTables
                    .slice(0, colIdx)
                    .filter(ct => (ct || '').toLowerCase() === colTableLc)
                    .length;
                const tbl = matchingTbls[occurrenceBefore] ?? matchingTbls[matchingTbls.length - 1];
                if (tbl?.alias) return `${tbl.alias}.${bare}`;
            }
        }

        // Fallback A: infer from columnOrder (active island only).
        const occurrenceBefore = allColTables.slice(0, colIdx).filter(ct => !ct).length;
        const colOrder = (State.columnOrder || []).filter(k => {
            if (!activeIds) return true;
            const alias = k.split('.')[0];
            return (State.tables || []).some(t => t.alias === alias && activeIds.has(t.id));
        });
        let matchCount = 0;
        for (const key of colOrder) {
            const parts = String(key).split('.');
            if (parts[1]?.toLowerCase() === bareNameLc && parts[0]) {
                if (matchCount === occurrenceBefore) return key;
                matchCount++;
            }
        }

        // Fallback B: scan State.tables directly (active island only).
        if (Array.isArray(State.tables)) {
            const tbls = activeIds ? State.tables.filter(t => activeIds.has(t.id)) : State.tables;
            let tableMatchCount = 0;
            for (const t of tbls) {
                if ((t.columns ?? []).some(c => c.name.toLowerCase() === bareNameLc)) {
                    if (tableMatchCount === occurrenceBefore) {
                        return t.alias ? `${t.alias}.${bare}` : col;
                    }
                    tableMatchCount++;
                }
            }
        }

        return col; // fallback (custom expressions, derived columns)
    }

    /** Apply or remove the highlight class on a result column by its select key. */
    /** Apply or remove col-deselected styling on a result column by its select key. */
    function _applyColDeselected(key, isDeselected) {
        const thead = document.querySelector('#results-table thead');
        const tbody = document.querySelector('#results-table tbody');
        if (!thead || !tbody) return;

        const ths = Array.from(thead.querySelectorAll('th'));
        let colIdx = -1;

        // Strategy 1: exact colKey match
        ths.forEach((th, i) => { if (th.dataset.colKey === key) colIdx = i; });

        // Strategy 2: bare column name fallback (only when unambiguous)
        if (colIdx === -1) {
            const bare = key.split('.').pop().toLowerCase();
            let matches = 0;
            ths.forEach((th, i) => {
                if ((th.dataset.raw || '').toLowerCase() === bare) { colIdx = i; matches++; }
            });
            if (matches > 1) colIdx = -1; // ambiguous — skip
        }

        if (colIdx === -1) return;

        ths[colIdx].classList.toggle('col-deselected', isDeselected);
        tbody.querySelectorAll(`tr td:nth-child(${colIdx + 2})`).forEach(td => {
            td.classList.toggle('col-deselected', isDeselected);
        });
    }

    function _applyColHighlight(colKey, on, scrollTo = false) {
        const thead = document.querySelector('#results-table thead');
        const tbody = document.querySelector('#results-table tbody');
        if (!thead || !tbody) return;

        const ths = thead.querySelectorAll('th');
        if (!ths.length) return;

        let colIdx = -1;

        // Strategy 1: data-col-key exact match
        ths.forEach((th, i) => {
            if (th.dataset.colKey === colKey) colIdx = i;
        });

        // Strategy 2: scan _lastResult cols + col_tables with _computeColKey
        if (colIdx === -1 && _lastResult) {
            const lcols   = _lastResult.cols       || [];
            const ltables = _lastResult.col_tables || [];
            lcols.forEach((col, i) => {
                if (colIdx !== -1) return;
                if (_computeColKey(col, ltables[i] || '', i, ltables) === colKey) colIdx = i;
            });
        }

        // Strategy 3: bare column name match (handles table-name mismatches)
        if (colIdx === -1) {
            const bare = colKey.includes('.') ? colKey.split('.')[1] : colKey;
            ths.forEach((th, i) => {
                if (colIdx !== -1) return;
                const thBare = (th.dataset.colKey || '').split('.').pop();
                if (thBare === bare) colIdx = i;
            });
        }

        if (colIdx === -1) return;

        ths[colIdx].classList.toggle('col-highlighted', on);
        tbody.querySelectorAll(`tr td:nth-child(${colIdx + 2})`).forEach(td => {
            td.classList.toggle('col-highlighted', on);
        });

        if (scrollTo) {
            ths[colIdx].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
    }

    /** Re-apply all active highlights after the table is re-rendered. */
    function _reapplyHighlights() {
        _highlightedCols.forEach(key => _applyColHighlight(key, true, false));
    }

    /** Returns true when the DB result column name is an explicit user-defined alias. */
    function _isColumnAlias(colName) {
        const nameLc = String(colName ?? '').toLowerCase();
        return Object.values(State.selectAliases || {})
            .some(v => (v || '').trim().toLowerCase() === nameLc);
    }

    /** Re-apply table colors to all result header cells (called after a table color changes). */
    function _applyResultHeaderColors() {
        document.querySelectorAll('#results-table thead th').forEach(th => {
            const colKey = th.dataset.colKey || '';
            const alias  = colKey.includes('.') ? colKey.split('.')[0] : '';
            const tbl    = alias ? (State.tables || []).find(t => t.alias === alias) : null;
            if (tbl?.color) {
                th.style.backgroundColor = tbl.color;
                th.style.color = _readableTextColor(tbl.color);
            } else {
                th.style.backgroundColor = '';
                th.style.color = '';
            }
        });
    }

    /** Returns true when the column is the '|||' table-delimiter sentinel. */
    function _isDelimiterColumn(colName) {
        return String(colName ?? '').trim() === '|||';
    }

    /** Returns true when the DB result column name comes from a custom expression. */
    function _isCustomExprColumn(colName) {
        const nameLc = String(colName ?? '').toLowerCase();
        return (State.selectCustomExprs ?? []).some(e => {
            if (e.enabled === false) return false;
            const alias = (e.alias ?? '').trim();
            const expr  = (e.expr  ?? '').trim();
            return (alias ? alias : expr).toLowerCase() === nameLc;
        });
    }

    function _reorderResultsColumn(thead, tbody, fromIdx, toIdx) {
        [thead, tbody].forEach(section => {
            if (!section) return;
            Array.from(section.rows).forEach(row => {
                const cells = Array.from(row.cells);
                // +1 to skip the leading # column
                const fromCell = cells[fromIdx + 1];
                const toCell   = cells[toIdx   + 1];
                if (!fromCell || !toCell) return;
                if (fromIdx < toIdx) {
                    row.insertBefore(fromCell, toCell.nextSibling);
                } else {
                    row.insertBefore(fromCell, toCell);
                }
            });
        });
        // Keep data-col-idx in sync (skip the # column, re-number data ths from 0)
        let dataIdx = 0;
        Array.from(thead.querySelectorAll('th')).forEach(th => {
            if (th.classList.contains('th-row-num')) return;
            th.dataset.colIdx = String(dataIdx++);
        });
    }

    function _applySortToTbody(tbody, colIdx, dir) {
        const dataRows = Array.from(tbody.querySelectorAll('tr')).filter(tr => !tr.querySelector('.results-empty'));
        if (dataRows.length === 0) return;
        if (dir === 0) {
            _sortOriginalRows.forEach(tr => tbody.appendChild(tr));
            return;
        }
        dataRows.sort((a, b) => {
            const aRaw = a.cells[colIdx + 1]?.dataset.raw ?? a.cells[colIdx + 1]?.textContent ?? '';
            const bRaw = b.cells[colIdx + 1]?.dataset.raw ?? b.cells[colIdx + 1]?.textContent ?? '';
            const aNull = a.cells[colIdx + 1]?.classList.contains('is-null');
            const bNull = b.cells[colIdx + 1]?.classList.contains('is-null');
            if (aNull && bNull) return 0;
            if (aNull) return 1;
            if (bNull) return -1;
            const aNum = Number(aRaw);
            const bNum = Number(bRaw);
            const numericSort = isFinite(aNum) && isFinite(bNum) && aRaw !== '' && bRaw !== '';
            const cmp = numericSort ? aNum - bNum : aRaw.localeCompare(bRaw, undefined, { numeric: true, sensitivity: 'base' });
            return dir * cmp;
        });
        dataRows.forEach(tr => tbody.appendChild(tr));
    }

    function _populateTable(cols, rows, colTables = [], colTypes = []) {
        const thead = document.querySelector('#results-table thead');
        const tbody = document.querySelector('#results-table tbody');

        // Compute active island table IDs once so header labels use the correct
        // aliases even when the same table name exists in other islands.
        let _activeResultIds = null;
        if (State.selectedIslandKey && Array.isArray(State.tables) && State.joins) {
            const enabledJoins = State.joins.filter(j => j.enabled !== false);
            const islands = typeof App !== 'undefined'
                ? App.computeIslands(State.tables, enabledJoins) : null;
            if (islands && islands.length > 1) {
                _activeResultIds = new Set(State.selectedIslandKey.split('|'));
            }
        }

        // Reset sort state for every new query result
        _sortColIdx = -1;
        _sortDir = 0;
        _sortOriginalRows = [];

        // --- Header ---
        const trHead = document.createElement('tr');
        const thRowNum = document.createElement('th');
        thRowNum.className = 'th-row-num';
        thRowNum.textContent = '#';
        trHead.appendChild(thRowNum);
        cols.forEach((col, colIdx) => {
            const th  = document.createElement('th');
            const key = _getColKey(col);
            if (key) {
                const badge = document.createElement('span');
                if (key === 'PRI') {
                    badge.className = 'col-badge col-badge--pk';
                    badge.textContent = 'PK';
                    badge.title = 'Primary Key';
                } else if (key === 'UNI') {
                    badge.className = 'col-badge col-badge--uni';
                    badge.textContent = 'UQ';
                    badge.title = 'Unique';
                } else {
                    badge.className = 'col-badge col-badge--fk';
                    badge.textContent = 'IDX';
                    badge.title = 'Index';
                }
                th.appendChild(badge);
            }
            // Tag with the select-state key so the highlight feature can find it
            th.dataset.colKey = _computeColKey(col, colTables[colIdx] || '', colIdx, colTables, _activeResultIds);
            // Store raw column name so Ctrl+C copies only the name, not badge/origin text
            th.dataset.raw = col;

            // Tooltip: show full schema.table origin on hover; also apply table color
            const colTableAlias = colTables[colIdx] || '';
            if (colTableAlias) {
                const colTableLc  = colTableAlias.toLowerCase();
                const originTable = (State.tables || []).find(t => t.alias?.toLowerCase() === colTableLc)
                                 ?? (State.tables || []).find(t => t.name?.toLowerCase()  === colTableLc);
                if (originTable) {
                    th.title = originTable.database
                        ? `${originTable.database}.${originTable.name}`
                        : originTable.name;
                    if (originTable.color) {
                        th.style.backgroundColor = originTable.color;
                        th.style.color = _readableTextColor(originTable.color);
                    }
                }
            }

            // Header label: prefix with table alias when possible (e.g. "u.id").
            // If the column has a user-defined alias, render it in italic so it's
            // visually distinct from real column names.
            const labelText = _formatHeaderLabel(col, colIdx, cols, colTables[colIdx] || '', colTables, _activeResultIds);
            const displayLabel = _lastResultIsCsv ? `${_excelCol(colIdx)} - ${labelText}` : labelText;
            if (_isDelimiterColumn(col)) {
                th.classList.add('th-delimiter');
                th.appendChild(document.createTextNode('|||'));
            } else if (_isCustomExprColumn(col)) {
                th.classList.add('th-custom-expr');
                th.appendChild(document.createTextNode(displayLabel));
            } else if (_isColumnAlias(col)) {
                th.classList.add('th-alias');
                const em = document.createElement('em');
                em.textContent = displayLabel;
                th.appendChild(em);
            } else {
                th.appendChild(document.createTextNode(displayLabel));
            }

            // DB Table Name origin label — shown below the header text when enabled.
            // colTables[colIdx] may be either the real table name or the SQL alias
            // depending on PDO/MySQL version, so try alias-lookup first, then
            // name-lookup, and always display tbl.name (real table), not the raw value.
            if (State.selectTableName && colTables[colIdx]) {
                const colTableVal = colTables[colIdx];
                const colTableLc  = colTableVal.toLowerCase();
                const tbl = (State.tables || []).find(t => t.alias?.toLowerCase() === colTableLc)
                         ?? (State.tables || []).find(t => t.name?.toLowerCase()  === colTableLc);
                const originText = tbl
                    ? (tbl.database ? `${tbl.database}.${tbl.name}` : tbl.name)
                    : colTableVal;
                const originSpan = document.createElement('span');
                originSpan.className   = 'th-table-origin';
                originSpan.textContent = originText;
                th.appendChild(originSpan);
            }

            // Restore column theme
            if (_colThemes[colIdx]) {
                th.classList.add(_colThemes[colIdx]);
            }

            // Right-click: toggle SELECT checkbox · Alt+right-click: cycle column color
            th.addEventListener('contextmenu', e => {
                e.preventDefault();

                // Normal right-click: find the matching SELECT panel checkbox, toggle it,
                // scroll the config panel to that row, and flash it.
                const colKey = th.dataset.colKey;
                const rawCol = (th.dataset.raw || '').toLowerCase();
                const rows = document.querySelectorAll('#select-columns .select-col-row');
                let targetRow = null;
                let fallbackRow = null;
                let fallbackCount = 0;
                rows.forEach(row => {
                    const idx = parseInt(row.dataset.idx, 10);
                    if (isNaN(idx) || !Array.isArray(State.columnOrder)) return;
                    const key = State.columnOrder[idx];
                    if (!key) return;
                    if (key === colKey) {
                        targetRow = row; // exact match wins
                    } else if (rawCol && key.split('.').pop().toLowerCase() === rawCol) {
                        fallbackRow = row; // bare column name match as fallback
                        fallbackCount++;
                    }
                });
                // Use fallback only when there's exactly one match (avoids ambiguity)
                if (!targetRow && fallbackCount === 1) targetRow = fallbackRow;
                if (!targetRow) {
                    App.notify?.('Column not found in SELECT panel', 'warn');
                    return;
                }

                // Re-query after re-render so we animate the live DOM node
                const rowIdx = targetRow.dataset.idx; // save before potential re-render
                const freshRow = document.querySelector(`.select-col-row[data-idx="${rowIdx}"]`) || targetRow;
                freshRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                freshRow.classList.remove('is-highlighted');
                void freshRow.offsetWidth; // force reflow to restart animation
                freshRow.classList.add('is-highlighted');
                setTimeout(() => freshRow.classList.remove('is-highlighted'), 7000);

                return;
            });

            // Click: in compare/duplicate mode act on the whole column (header click still applies there)
            let _thClickTimer = null;
            th.addEventListener('click', e => {
                // Alt+click: copy `alias`.`column` to clipboard
                if (e.altKey) {
                    const colKey  = th.dataset.colKey || '';
                    const raw     = th.dataset.raw    || '';
                    const hasDot  = colKey.includes('.');
                    let   alias   = hasDot ? colKey.split('.')[0] : '';
                    // Fallback: extract alias from the visible header label (e.g. "t.country")
                    if (!alias) {
                        const label = _thGetLabel(th);
                        if (label.includes('.')) alias = label.split('.')[0];
                    }
                    const col  = raw || (hasDot ? colKey.split('.')[1] : colKey);
                    const text = alias ? `${alias}.\`${col}\`` : `\`${col}\``;
                    navigator.clipboard.writeText(text)
                        .then(() => App.notify?.(`Copied ${text}`, 'success'))
                        .catch(() => App.notify?.('Copy failed', 'error'));
                    return;
                }
                if (_compareMode) {
                    _compareColumn(colIdx, tbody);
                } else if (_duplicateMode) {
                    _duplicateColumn(colIdx, tbody);
                } else {
                    clearTimeout(_thClickTimer);
                    _thClickTimer = setTimeout(() => {
                    e.preventDefault();

                    // Click: find the matching SELECT panel checkbox, toggle it,
                    // scroll the config panel to that row, and flash it.
                    const colKey = th.dataset.colKey;
                    const rawCol = (th.dataset.raw || '').toLowerCase();
                    const rows = document.querySelectorAll('#select-columns .select-col-row');
                    let targetRow = null;
                    let fallbackRow = null;
                    let fallbackCount = 0;
                    rows.forEach(row => {
                        const idx = parseInt(row.dataset.idx, 10);
                        if (isNaN(idx) || !Array.isArray(State.columnOrder)) return;
                        const key = State.columnOrder[idx];
                        if (!key) return;
                        if (key === colKey) {
                            targetRow = row; // exact match wins
                        } else if (rawCol && key.split('.').pop().toLowerCase() === rawCol) {
                            fallbackRow = row; // bare column name match as fallback
                            fallbackCount++;
                        }
                    });
                    // Use fallback only when there's exactly one match (avoids ambiguity)
                    if (!targetRow && fallbackCount === 1) targetRow = fallbackRow;
                    if (!targetRow) {
                        App.notify?.('Column not found in SELECT panel', 'warn');
                        return;
                    }

                    const rowIdx = targetRow.dataset.idx; // save before potential re-render
                    const chk = targetRow.querySelector('input[type="checkbox"]:not(.col-highlight-chk)');
                    if (chk) {
                        chk.checked = !chk.checked;
                        chk.dispatchEvent(new Event('change')); // may re-render the SELECT panel
                    }
                    const deselected = chk && !chk.checked;
                    th.classList.toggle('col-deselected', deselected);
                    const currentIdx = parseInt(th.dataset.colIdx, 10);
                    tbody.querySelectorAll(`tr td:nth-child(${currentIdx + 2})`).forEach(td => {
                        td.classList.toggle('col-deselected', deselected);
                    });

                    // Re-query after re-render so we animate the live DOM node
                    const freshRow = document.querySelector(`.select-col-row[data-idx="${rowIdx}"]`) || targetRow;
                    freshRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    freshRow.classList.remove('is-highlighted');
                    void freshRow.offsetWidth; // force reflow to restart animation
                    freshRow.classList.add('is-highlighted');
                    setTimeout(() => freshRow.classList.remove('is-highlighted'), 7000);
                    }, 220); // debounce — cancelled if dblclick fires first
                    return;
                }
                // no action for normal mode — use double-click to add to WHERE
            });

            // Double-click: add column to WHERE as a new visual condition
            th.addEventListener('dblclick', e => {
                clearTimeout(_thClickTimer); // cancel pending single-click
                e.preventDefault();
                const colKey = th.dataset.colKey;
                if (!colKey) {
                    App.notify?.('Cannot add expression column to WHERE', 'warn');
                    return;
                }
                if (!State.where) State.where = [];
                State.where.push({ col: colKey, op: '=', val: '', operator: 'AND' });
                QueryPanel.refresh();
                App.updateSQLPreview?.();
                App.notify?.(`Added ${colKey} to WHERE`, 'success');
                const configPanel = document.getElementById('config-panel');
                if (configPanel) configPanel.scrollTop = 0;
                requestAnimationFrame(() => {
                    const container = document.getElementById('where-conditions');
                    if (!container) return;
                    const rows = container.querySelectorAll('.condition-row');
                    if (!rows.length) return;
                    const newRow = rows[rows.length - 1];
                    newRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    newRow.classList.add('where-row-calculus-flash');
                    setTimeout(() => newRow.classList.remove('where-row-calculus-flash'), 2000);
                    newRow.querySelector('input[placeholder="value"]')?.focus();
                });
            });

            th.dataset.colIdx = String(colIdx);

            // Sort button — click to cycle asc → desc → none
            const sortBtn = document.createElement('span');
            sortBtn.className = 'th-sort-btn';
            sortBtn.textContent = '⇅';
            sortBtn.title = 'Sort';
            sortBtn.addEventListener('click', e => {
                e.stopPropagation();
                e.preventDefault();
                const clickedIdx = parseInt(th.dataset.colIdx, 10);
                if (_sortColIdx === clickedIdx) {
                    _sortDir = _sortDir === 1 ? -1 : (_sortDir === -1 ? 0 : 1);
                    if (_sortDir === 0) _sortColIdx = -1;
                } else {
                    _sortColIdx = clickedIdx;
                    _sortDir = 1;
                }
                thead.querySelectorAll('th').forEach(t => {
                    const btn = t.querySelector('.th-sort-btn');
                    if (!btn) return;
                    const idx    = parseInt(t.dataset.colIdx, 10);
                    const active = idx === _sortColIdx && _sortDir !== 0;
                    btn.textContent = active ? (_sortDir === 1 ? '▲' : '▼') : '⇅';
                    btn.classList.toggle('is-active', active);
                });
                _applySortToTbody(tbody, _sortColIdx, _sortDir);
            });
            th.appendChild(sortBtn);

            // Inline filter input — stops propagation so header click handlers don't fire
            const filterWrap  = document.createElement('div');
            filterWrap.className = 'th-filter-wrap';

            const filterInput = document.createElement('input');
            filterInput.type = 'text';
            filterInput.placeholder = '%like%';
            filterInput.className = 'th-filter-input';

            const filterClear = document.createElement('button');
            filterClear.type = 'text';
            filterClear.className = 'th-filter-clear';
            filterClear.textContent = '×';
            filterClear.tabIndex = -1;
            filterClear.title = 'Clear filter';

            const _clearFilterInput = () => {
                filterInput.focus();
                filterInput.select();
                document.execCommand('insertText', false, '');
            };

            ['click', 'dblclick', 'mousedown'].forEach(evt =>
                filterWrap.addEventListener(evt, e => e.stopPropagation())
            );
            filterInput.addEventListener('focus', () => { th.draggable = false; });
            filterInput.addEventListener('blur',  () => { if (th.dataset.colKey) th.draggable = true; });
            filterInput.addEventListener('input', () => {
                const v = filterInput.value;
                if (v) _colFilters[colIdx] = v;
                else   delete _colFilters[colIdx];
                filterInput.classList.toggle('has-value', v.length > 0);
                _applyColFilter();
            });
            filterInput.addEventListener('keydown', e => {
                if (e.key === 'Escape') { e.preventDefault(); _clearFilterInput(); }
            });
            filterClear.addEventListener('click', () => _clearFilterInput());

            filterWrap.appendChild(filterInput);
            filterWrap.appendChild(filterClear);
            th.appendChild(filterWrap);

            // Drag: reorder columns in results table + WHERE / GROUP BY / HAVING / ORDER BY drop zones
            if (th.dataset.colKey) {
                th.draggable = true;
                th.addEventListener('dragstart', e => {
                    e.dataTransfer.effectAllowed = 'copyMove';
                    e.dataTransfer.setData('text/x-col-key', th.dataset.colKey);
                    _dragReorderSrcIdx = parseInt(th.dataset.colIdx, 10);
                    th.classList.add('th-dragging');
                });
                th.addEventListener('dragend', () => {
                    _dragReorderSrcIdx = -1;
                    th.classList.remove('th-dragging');
                    document.querySelectorAll('.drop-zone.is-drag-hover')
                        .forEach(z => z.classList.remove('is-drag-hover'));
                    document.querySelectorAll('th.th-drop-target')
                        .forEach(t => t.classList.remove('th-drop-target'));
                });
                th.addEventListener('dragover', e => {
                    const dstIdx = parseInt(th.dataset.colIdx, 10);
                    if (_dragReorderSrcIdx === -1 || _dragReorderSrcIdx === dstIdx) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    document.querySelectorAll('th.th-drop-target')
                        .forEach(t => t.classList.remove('th-drop-target'));
                    th.classList.add('th-drop-target');
                });
                th.addEventListener('dragleave', () => {
                    th.classList.remove('th-drop-target');
                });
                th.addEventListener('drop', e => {
                    e.preventDefault();
                    th.classList.remove('th-drop-target');
                    const srcIdx = _dragReorderSrcIdx;
                    const dstIdx = parseInt(th.dataset.colIdx, 10);
                    _dragReorderSrcIdx = -1;
                    if (srcIdx === -1 || srcIdx === dstIdx) return;

                    const srcTh  = thead.querySelector(`th[data-col-idx="${srcIdx}"]`);
                    const srcKey = srcTh?.dataset.colKey;
                    const dstKey = th.dataset.colKey;
                    if (!srcKey || !dstKey || srcKey === dstKey) return;

                    // Reorder State.columnOrder
                    const fromStateIdx = State.columnOrder.indexOf(srcKey);
                    const toStateIdx   = State.columnOrder.indexOf(dstKey);
                    if (fromStateIdx === -1 || toStateIdx === -1) return;
                    const [moved] = State.columnOrder.splice(fromStateIdx, 1);
                    State.columnOrder.splice(toStateIdx, 0, moved);

                    // Keep State.select sorted by new columnOrder
                    if (Array.isArray(State.select)) {
                        State.select.sort((a, b) => {
                            const ai = State.columnOrder.indexOf(a);
                            const bi = State.columnOrder.indexOf(b);
                            return (ai === -1 ? 99999 : ai) - (bi === -1 ? 99999 : bi);
                        });
                    }

                    // DOM: move the column across all rows without re-running the query
                    _reorderResultsColumn(thead, tbody, srcIdx, dstIdx);

                    // Clear sort state — column indices changed, sort would be stale
                    _sortColIdx = -1;
                    _sortDir = 0;
                    thead.querySelectorAll('.th-sort-btn').forEach(btn => {
                        btn.textContent = '⇅';
                        btn.classList.remove('is-active');
                    });

                    // Sync SELECT panel + SQL preview
                    QueryPanel.refresh();
                    App.updateSQLPreview();
                });
            }

            trHead.appendChild(th);
        });
        thead.innerHTML = '';
        thead.appendChild(trHead);

        // --- Body ---
        tbody.innerHTML = '';

        if (rows.length === 0) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = (cols.length || 1) + 1; // +1 for the # column
            td.className = 'results-empty';
            td.textContent = 'No rows returned';
            tr.appendChild(td);
            tbody.appendChild(tr);
            return;
        }

        rows.forEach((row, rowIdx) => {
            const tr = document.createElement('tr');
            const tdRowNum = document.createElement('td');
            tdRowNum.className = 'td-row-num';
            tdRowNum.textContent = String(rowIdx + 1);
            tr.appendChild(tdRowNum);

            // Left-click #: toggle row highlight (identical to Alt+right-click on a data cell).
            tdRowNum.addEventListener('click', () => _altRightClickRow(tr));

            // Right-click #: cycle the whole row through cell-color themes.
            tdRowNum.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
                const allTds   = Array.from(tr.querySelectorAll('td'));
                const current  = THEMES.find(t => tdRowNum.classList.contains(t));
                const nextIdx  = (THEMES.indexOf(current) + 1) % (THEMES.length + 1);
                THEMES.forEach(t => allTds.forEach(td => td.classList.remove(t)));
                if (nextIdx < THEMES.length) {
                    allTds.forEach(td => td.classList.add(THEMES[nextIdx]));
                    // Register all data columns as pinned (consistent with cell right-click).
                    _lastResult?.cols.forEach((_, ci) => _dimPinCol(ci));
                }
                _applyDimVisibility();
                _applyDimRowVisibility();
            });

            cols.forEach((col, colIdx) => {
                const td = document.createElement('td');
                // Rows are positional arrays (FETCH_NUM) so that duplicate column
                // names from different tables are preserved correctly.
                const val = row[colIdx];

                const colType = colTypes[colIdx] || '';
                const colTypeUp = colType.toUpperCase();

                if (val === null || val === undefined) {
                    td.textContent = 'NULL';
                    td.className = 'is-null';
                } else if (_looksLikeUnixTs(col, colType, val)) {
                    _buildTemporalCell(td, val, _formatUnixTs(val));
                    td.classList.add('is-number', 'td-unix-ts');
                } else if (_isDatetimeValue(colType, val)) {
                    _buildTemporalCell(td, val, _formatTemporal(val));
                    td.classList.add('td-datetime');
                } else if (_isDateValue(colType, val)) {
                    _buildTemporalCell(td, val, _formatTemporal(val));
                    td.classList.add('td-date');
                } else if (_isNumeric(val)) {
                    td.textContent = val;
                    td.className = 'is-number';
                } else {
                    td.textContent = val;
                }

                // Delimiter column — override styling regardless of value type
                if (_isDelimiterColumn(col)) {
                    td.className = 'td-delimiter';
                    td.textContent = '|||';
                }

                // Preserve the original raw value (including any line breaks) for copy-to-clipboard.
                if (val !== null && val !== undefined) {
                    td.dataset.raw = String(val);
                }

                // Apply column theme if any
                if (_colThemes[colIdx]) {
                    td.classList.add(_colThemes[colIdx]);
                }

                // Left-click: eval mode / bind mode intercept, then compare / duplicates / normal
                td.addEventListener('click', e => {
                    // Alt+click: copy entire row as plain JSON object to clipboard + flash cell
                    if (e.altKey) {
                        e.preventDefault();
                        e.stopPropagation();
                        const tds  = Array.from(tr.querySelectorAll('td:not(.td-row-num)'));
                        const keys = _buildJsonKeys();
                        const row  = Object.fromEntries(keys.map((k, i) => [k, tds[i]?.dataset.raw ?? tds[i]?.textContent ?? null]));
                        navigator.clipboard.writeText(JSON.stringify(row, null, 2))
                            .then(() => App.notify?.('Row copied as JSON', 'success'));
                        td.classList.remove('cell-calculus-flash');
                        void td.offsetWidth; // force reflow so animation restarts on repeat clicks
                        td.classList.add('cell-calculus-flash');
                        return;
                    }
                    if (_calculusEvalMode) {
                        e.stopPropagation();
                        _calcApplyEval(td);
                        return;
                    }
                    if (_calculusBindModeRowId !== null) {
                        e.stopPropagation();
                        _calcTryBind(td);
                        return;
                    }
                    if (_compareMode) {
                        _compareCell(td);
                    } else if (_duplicateMode) {
                        _duplicateCell(td);
                    } else {
                        _selectCell(td);
                    }
                });

                // Double-click: Calculus mode — add numeric cell to toolbox
                td.addEventListener('dblclick', e => {
                    if (!_calculusMode) return;
                    if (!td.classList.contains('is-number')) return;
                    e.preventDefault();

                    // Build the same header info that _populateTable uses
                    const col          = cols[colIdx];
                    const colTableVal  = colTables[colIdx] || '';
                    const colTableLc   = colTableVal.toLowerCase();
                    const tbl          = (State.tables || []).find(t => t.alias?.toLowerCase() === colTableLc)
                                      ?? (State.tables || []).find(t => t.name?.toLowerCase()  === colTableLc);
                    // Read the label from the actual <th> so it always matches what _calcTryBind
                    // sees — including the Excel-column prefix added for CSV/XLSX results.
                    const ths   = Array.from(td.closest('table').querySelectorAll('thead tr th'));
                    const thEl  = ths[colIdx + 1]; // +1 to skip the leading # column
                    const headerInfo = {
                        label:        thEl ? _thGetLabel(thEl) : _formatHeaderLabel(col, colIdx, cols, colTableVal, colTables),
                        origin:       tbl
                                        ? (tbl.database ? `${tbl.database}.${tbl.name}` : tbl.name)
                                        : colTableVal,
                        isAlias:      _isColumnAlias(col),
                        isCustomExpr: _isCustomExprColumn(col),
                        colKey:       _computeColKey(col, colTableVal, colIdx, colTables),
                    };

                    const value = td.dataset.raw ?? td.textContent;
                    _calcAddCell(headerInfo, value, td);
                    td.classList.remove('cell-calculus-flash');
                    void td.offsetWidth; // force reflow so animation restarts on repeat clicks
                    td.classList.add('cell-calculus-flash');
                });

                // mousedown catches Alt+right-click reliably on Windows (where the
                // contextmenu event may not carry altKey).
                td.addEventListener('mousedown', e => {
                    if (e.button === 2 && _altKeyHeld) {
                        _altRightClickRow(tr);
                        _altRightClickHandled = true;
                    }
                });

                // Right-click to toggle cell color; Alt+right-click to toggle row highlight;
                // in compare mode: right-click compares all cells in the row against this cell
                td.addEventListener('contextmenu', e => {
                    e.preventDefault();
                    e.stopPropagation(); // Don't trigger header contextmenu if somehow bubbled

                    // If mousedown already handled this as an Alt+right-click, skip.
                    if (_altRightClickHandled) { _altRightClickHandled = false; return; }

                    // Fallback: check our own Alt-key tracker in case mousedown was skipped.
                    if (_altKeyHeld) {
                        _altRightClickRow(tr);
                        return;
                    }

                    // Compare mode: right-click sets this cell as reference and compares the row
                    if (_compareMode) {
                        _compareRow(tr, td);
                        return;
                    }

                    // Duplicate mode: right-click searches for duplicates within the row
                    if (_duplicateMode) {
                        _duplicateRow(tr, td);
                        return;
                    }

                    const currentTheme = THEMES.find(t => td.classList.contains(t));
                    const currentIndex = THEMES.indexOf(currentTheme);
                    const nextIndex = currentIndex + 1;

                    if (currentTheme) {
                        td.classList.remove(currentTheme);
                    }

                    const nextTheme = THEMES[nextIndex];
                    if (nextTheme) {
                        td.classList.add(nextTheme);
                        _dimPinCol(colIdx);
                    }
                    _applyDimVisibility();
                    _applyDimRowVisibility();
                });

                // Drag to WHERE / GROUP BY / HAVING / ORDER BY drop zones
                const tdColKey = trHead.querySelectorAll('th')[colIdx]?.dataset.colKey;
                if (tdColKey) {
                    td.draggable = true;
                    td.addEventListener('dragstart', e => {
                        e.dataTransfer.effectAllowed = 'copy';
                        e.dataTransfer.setData('text/x-col-key', tdColKey);
                        const rawVal = td.dataset.raw ?? td.textContent;
                        if (rawVal !== null && rawVal !== undefined && rawVal !== 'NULL') {
                            e.dataTransfer.setData('text/x-col-value', String(rawVal));
                        }
                    });
                    td.addEventListener('dragend', () => {
                        document.querySelectorAll('.drop-zone.is-drag-hover')
                            .forEach(z => z.classList.remove('is-drag-hover'));
                    });
                }

                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });

        // Snapshot original row order so sort can be cleared back to it
        _sortOriginalRows = Array.from(tbody.querySelectorAll('tr'));

        // Re-apply any active column highlights after the table is rebuilt
        _reapplyHighlights();
        // New query → reset row-mode dim state and marked rows
        _dimRowMode = false;
        _dimPinnedCols = new Set();
        // Re-apply dim visibility in case dim mode was already active
        _applyDimVisibility();
        _applyDimRowVisibility();
        // Re-apply calculus row highlights
        _calcApplyAllActiveHighlights();
    }

    // -------------------------------------------------------------------------
    // EXPLAIN colour-coding
    // -------------------------------------------------------------------------

    /** Returns 'bad' | 'ok' | 'good' | null for a single EXPLAIN cell. */
    function _explainScore(colName, val) {
        const s = (val === null || val === undefined) ? 'NULL' : String(val).trim();
        const col = colName.toLowerCase();

        if (col === 'type') {
            if (['all', 'index'].includes(s.toLowerCase()))                          return 'bad';
            if (['range', 'ref', 'fulltext', 'ref_or_null', 'index_merge'].includes(s.toLowerCase())) return 'ok';
            if (['eq_ref', 'const', 'system', 'null'].includes(s.toLowerCase()))     return 'good';
        }

        if (col === 'select_type') {
            if (['dependent subquery', 'uncacheable subquery', 'uncacheable union'].includes(s.toLowerCase())) return 'bad';
            if (['subquery', 'derived', 'dependent union'].includes(s.toLowerCase())) return 'ok';
            if (['simple', 'primary', 'union', 'union result'].includes(s.toLowerCase())) return 'good';
        }

        if (col === 'key' || col === 'possible_keys') {
            if (s === 'NULL') return 'bad';
            return 'good';
        }

        if (col === 'rows') {
            const n = parseFloat(s);
            if (!isNaN(n)) {
                if (n > 10000) return 'bad';
                if (n > 1000)  return 'ok';
                return 'good';
            }
        }

        if (col === 'filtered') {
            const n = parseFloat(s);
            if (!isNaN(n)) {
                if (n < 10)  return 'bad';
                if (n < 50)  return 'ok';
                return 'good';
            }
        }

        if (col === 'extra') {
            if (s === 'NULL' || s === '') return null;
            const lower = s.toLowerCase();
            const isBad  = lower.includes('filesort') || lower.includes('temporary');
            const isGood = lower.includes('using index') && !lower.includes('using index condition');
            const isOk   = lower.includes('using where') || lower.includes('using index condition');
            if (isBad)  return 'bad';
            if (isOk)   return 'ok';
            if (isGood) return 'good';
        }

        return null;
    }

    /**
     * Detects if the result looks like a MySQL EXPLAIN output, then applies
     * explain-bad / explain-ok / explain-good CSS classes to each scored cell.
     * Respects the #chk-explain-colors checkbox.
     */
    function _applyExplainColors(cols, rows) {
        const lowerCols = cols.map(c => c.toLowerCase());
        // Must have both 'type' and 'extra' to be treated as EXPLAIN output
        if (!lowerCols.includes('type') || !lowerCols.includes('extra')) return;

        const enabled = document.getElementById('chk-explain-colors')?.checked !== false;
        if (!enabled) return;

        const tbody = document.querySelector('#results-table tbody');
        const trs   = tbody.querySelectorAll('tr');

        trs.forEach((tr, rowIdx) => {
            const row = rows[rowIdx];
            if (!row) return;
            const tds = tr.querySelectorAll('td:not(.td-row-num)');
            tds.forEach((td, colIdx) => {
                const score = _explainScore(cols[colIdx], row[colIdx]);
                if (score) td.classList.add('explain-' + score);
            });
        });
    }

    /** Remove all explain colour classes from the current table. */
    function _clearExplainColors() {
        document.querySelectorAll('#results-table td.explain-bad, #results-table td.explain-ok, #results-table td.explain-good')
            .forEach(td => td.classList.remove('explain-bad', 'explain-ok', 'explain-good'));
    }

    /**
     * Returns true for numbers and numeric strings (integer or float).
     * Excludes empty strings and pure-whitespace strings.
     */
    function _isNumeric(val) {
        if (typeof val === 'number') return true;
        if (typeof val !== 'string' || val.trim() === '') return false;
        return !isNaN(+val);
    }

    // -------------------------------------------------------------------------
    // Temporal cell detection & formatting
    // -------------------------------------------------------------------------

    // Normalised type tokens from QueryBuilder::normaliseColType().
    // Used as a CONFIRMATION signal, not a hard gate, because PDO metadata
    // is unreliable on remote TCP connections.
    const _DATE_TYPES     = new Set(['DATE']);
    const _DATETIME_TYPES = new Set(['DATETIME']);
    const _INT_TYPES      = new Set(['INT']);

    // Value patterns that unambiguously identify temporal strings.
    const _RE_DATE     = /^\d{4}-\d{2}-\d{2}$/;
    const _RE_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;

    // Column names that strongly suggest a Unix timestamp.
    const _TS_NAME_RE = /(_at|_ts|_time|_timestamp|_date)$|^(created|updated|deleted|modified|published|expired|timestamp)$|timestamp/i;

    /**
     * Returns true when the value + name look like a Unix timestamp.
     *
     * Strategy: only bail out early if the type is CONFIRMED to be a temporal type
     * (DATE/DATETIME) — because then the integer value is actually an epoch cast, not
     * a raw unix-ts.  Any other type (including unknown strings from remote DBs) falls
     * through to the value-range + column-name heuristic.
     */
    function _looksLikeUnixTs(colName, colType, val) {
        // A confirmed temporal type means the integer is a cast, not a raw unix-ts.
        if (_DATE_TYPES.has(colType) || _DATETIME_TYPES.has(colType)) return false;
        const n = Number(val);
        if (!Number.isFinite(n) || !Number.isInteger(n)) return false;
        const isSec = n >= 1_000_000_000  && n <= 9_999_999_999;
        const isMs  = n >= 1_000_000_000_000 && n <= 9_999_999_999_999;
        if (!isSec && !isMs) return false;
        return _TS_NAME_RE.test(colName || '');
    }

    /**
     * Returns true for DATE string values.
     *
     * We only suppress pattern-matching when the type is CONFIRMED to be something
     * incompatible (DATETIME or INT).  Any unknown/unrecognised colType (common for
     * remote TCP connections) falls through to the regex pattern check, which is
     * unambiguous for YYYY-MM-DD strings.
     */
    function _isDateValue(colType, val) {
        if (_DATE_TYPES.has(colType)) return true;
        if (_DATETIME_TYPES.has(colType) || _INT_TYPES.has(colType)) return false;
        return _RE_DATE.test(String(val));
    }

    /**
     * Returns true for DATETIME/TIMESTAMP string values.
     *
     * Same strategy as _isDateValue — only block on known conflicting types so that
     * remote DBs with non-standard/empty native_type still get pattern-based detection.
     */
    function _isDatetimeValue(colType, val) {
        if (_DATETIME_TYPES.has(colType)) return true;
        if (_DATE_TYPES.has(colType) || _INT_TYPES.has(colType)) return false;
        return _RE_DATETIME.test(String(val));
    }

    /**
     * Formats a Unix timestamp value as "1673500000 — 2023-01-12 07:06:40 UTC".
     * Always uses UTC so the result is timezone-independent regardless of where
     * the browser or the DB server runs.
     */
    function _formatUnixTs(val) {
        const n = Number(val);
        const d = new Date(n > 9_999_999_999 ? n : n * 1000);
        const p = v => String(v).padStart(2, '0');
        const human = `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ` +
                      `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
        return `${val} — ${human}`;
    }

    /**
     * Formats a Date/DateTime string value as "original — unix_timestamp (UTC)".
     * Appends "Z" before parsing so the DB string is treated as UTC rather than
     * browser-local time, keeping the result consistent across all timezones.
     * Returns the original value unchanged if it can't be parsed.
     */
    function _formatTemporal(val) {
        const s = String(val).replace(' ', 'T');          // MySQL space → ISO separator
        const d = new Date(s.endsWith('Z') ? s : s + 'Z'); // treat as UTC
        if (isNaN(d.getTime())) return String(val);
        return `${val} — ${Math.floor(d.getTime() / 1000)} UTC`;
    }

    /**
     * Populates a temporal td with a single inner flex wrapper:
     *   <div class="td-temporal-wrap">
     *     <span>formatted text</span>
     *     <button>⎘</button>
     *   </div>
     *
     * The <td> itself keeps its default table-cell display to avoid breaking
     * the table layout. Flex is applied only to the inner wrapper.
     * The button copies the full formatted string; regular cell click still
     * copies the raw original value via dataset.raw.
     */
    function _buildTemporalCell(td, rawVal, formatted) {
        td.dataset.formatted = formatted;

        const wrap = document.createElement('div');
        wrap.className = 'td-temporal-wrap';

        const textSpan = document.createElement('span');
        textSpan.textContent = formatted;

        const copyBtn = document.createElement('button');
        copyBtn.className   = 'td-copy-formatted';
        copyBtn.textContent = '⎘';
        copyBtn.title       = 'Copy formatted value';
        copyBtn.addEventListener('click', e => {
            e.stopPropagation();
            navigator.clipboard.writeText(formatted).then(() => {
                const prev = copyBtn.textContent;
                copyBtn.textContent = '✓';
                setTimeout(() => { copyBtn.textContent = prev; }, 1200);
            });
        });

        wrap.appendChild(textSpan);
        wrap.appendChild(copyBtn);
        td.appendChild(wrap);
    }

    // -------------------------------------------------------------------------
    // Compare mode
    // -------------------------------------------------------------------------

    function _toggleCompareMode() {
        _compareMode = !_compareMode;
        const btn = document.getElementById('btn-compare');
        btn.classList.toggle('is-active', _compareMode);
        btn.title = _compareMode ? 'Exit compare mode' : 'Compare cell values';
        document.getElementById('legend-compare')?.classList.toggle('hidden', !_compareMode);

        if (!_compareMode) {
            // Exiting: clear only compare highlights, preserve manual right-click colors
            _compareRefValue = null;
            _compareRefCell  = null;
            document.querySelectorAll('#results-table td.cell-compare-ref, #results-table td.cell-compare-match, #results-table td.cell-compare-diff')
                .forEach(td => {
                    td.classList.remove('cell-compare-ref', 'cell-compare-match', 'cell-compare-diff');
                });
        }
    }

    function _compareCell(td) {
        const val = td.dataset.raw ?? td.textContent;

        if (_compareRefValue === null) {
            // First click: mark as the reference cell with a distinct darker style
            _compareRefValue = val;
            _compareRefCell  = td;
            td.classList.remove('cell-compare-match', 'cell-compare-diff');
            td.classList.add('cell-compare-ref');
        } else {
            // If the user clicks the reference cell again, don't change it
            if (td === _compareRefCell) return;
            // Subsequent clicks: compare against reference
            td.classList.remove('cell-compare-ref', 'cell-compare-match', 'cell-compare-diff');
            td.classList.add(val === _compareRefValue ? 'cell-compare-match' : 'cell-compare-diff');
        }
    }

    // Compare all cells in a column against the first value cell (triggered by header click)
    function _compareColumn(colIdx, tbody) {
        const cells = [...tbody.querySelectorAll(`tr td:nth-child(${colIdx + 2})`)];
        if (!cells.length) return;
        document.querySelectorAll('#results-table td.cell-compare-ref, #results-table td.cell-compare-match, #results-table td.cell-compare-diff')
            .forEach(td => td.classList.remove('cell-compare-ref', 'cell-compare-match', 'cell-compare-diff'));
        const ref = cells[0];
        _compareRefValue = ref.dataset.raw ?? ref.textContent;
        _compareRefCell  = ref;
        ref.classList.add('cell-compare-ref');
        for (let i = 1; i < cells.length; i++) {
            const val = cells[i].dataset.raw ?? cells[i].textContent;
            cells[i].classList.add(val === _compareRefValue ? 'cell-compare-match' : 'cell-compare-diff');
        }
    }

    // Compare all cells in a row against a right-clicked reference cell
    function _compareRow(tr, referenceTd) {
        document.querySelectorAll('#results-table td.cell-compare-ref, #results-table td.cell-compare-match, #results-table td.cell-compare-diff')
            .forEach(td => td.classList.remove('cell-compare-ref', 'cell-compare-match', 'cell-compare-diff'));
        const refVal = referenceTd.dataset.raw ?? referenceTd.textContent;
        _compareRefValue = refVal;
        _compareRefCell  = referenceTd;
        referenceTd.classList.add('cell-compare-ref');
        tr.querySelectorAll('td:not(.td-row-num)').forEach(td => {
            if (td === referenceTd) return;
            const val = td.dataset.raw ?? td.textContent;
            td.classList.add(val === refVal ? 'cell-compare-match' : 'cell-compare-diff');
        });
    }

    // -------------------------------------------------------------------------
    // Duplicates mode
    // -------------------------------------------------------------------------

    function _toggleDuplicateMode() {
        _duplicateMode = !_duplicateMode;
        const btn = document.getElementById('btn-duplicates');
        btn.classList.toggle('is-active', _duplicateMode);
        btn.title = _duplicateMode ? 'Exit duplicates mode' : 'Highlight duplicate cell values';
        document.getElementById('legend-duplicates')?.classList.toggle('hidden', !_duplicateMode);

        if (!_duplicateMode) {
            // Exiting: clear only duplicate highlights, preserve compare/manual colors
            document.querySelectorAll('#results-table td.cell-dup-origin, #results-table td.cell-dup-match, #results-table td.cell-dup-unique')
                .forEach(td => td.classList.remove('cell-dup-origin', 'cell-dup-match', 'cell-dup-unique'));
            _duplicateOriginCell = null;
            btn.textContent = '⧉ Duplicates';
        }
    }

    function _duplicateCell(td) {
        // Clear previous duplicate highlights only — leave compare/manual colors intact
        document.querySelectorAll('#results-table td.cell-dup-origin, #results-table td.cell-dup-match')
            .forEach(cell => cell.classList.remove('cell-dup-origin', 'cell-dup-match'));
        _duplicateOriginCell = null;

        const val = td.dataset.raw ?? td.textContent;

        // Mark the origin cell distinctly
        td.classList.add('cell-dup-origin');
        _duplicateOriginCell = td;

        // Find all other cells in the table body with the same raw value
        let count = 1; // origin counts as 1
        document.querySelectorAll('#results-table tbody td').forEach(cell => {
            if (cell === td) return;
            const cellVal = cell.dataset.raw ?? cell.textContent;
            if (cellVal === val) {
                cell.classList.add('cell-dup-match');
                count++;
            }
        });

        // Update button label with total duplicate count
        const btn = document.getElementById('btn-duplicates');
        if (btn) btn.textContent = `⧉ Duplicates (${count})`;
    }

    function _clearDupHighlights() {
        document.querySelectorAll('#results-table td.cell-dup-origin, #results-table td.cell-dup-match, #results-table td.cell-dup-unique')
            .forEach(td => td.classList.remove('cell-dup-origin', 'cell-dup-match', 'cell-dup-unique'));
        _duplicateOriginCell = null;
    }

    // Duplicate search scoped to a single column (triggered by header click).
    // Every cell in the column gets coloured: origin / match / unique (not a duplicate).
    function _duplicateColumn(colIdx, tbody) {
        const cells = [...tbody.querySelectorAll(`tr td:nth-child(${colIdx + 2})`)];
        if (!cells.length) return;
        _clearDupHighlights();
        const origin = cells[0];
        const refVal = origin.dataset.raw ?? origin.textContent;
        origin.classList.add('cell-dup-origin');
        _duplicateOriginCell = origin;
        let count = 1;
        for (let i = 1; i < cells.length; i++) {
            const v = cells[i].dataset.raw ?? cells[i].textContent;
            if (v === refVal) {
                cells[i].classList.add('cell-dup-match');
                count++;
            } else {
                cells[i].classList.add('cell-dup-unique');
            }
        }
        const btn = document.getElementById('btn-duplicates');
        if (btn) btn.textContent = `⧉ Duplicates (${count})`;
    }

    // Duplicate search scoped to a single row (triggered by right-click on a cell).
    // Every cell in the row gets coloured: origin / match / unique (not a duplicate).
    function _duplicateRow(tr, referenceTd) {
        _clearDupHighlights();
        const refVal = referenceTd.dataset.raw ?? referenceTd.textContent;
        referenceTd.classList.add('cell-dup-origin');
        _duplicateOriginCell = referenceTd;
        let count = 1;
        tr.querySelectorAll('td:not(.td-row-num)').forEach(td => {
            if (td === referenceTd) return;
            const v = td.dataset.raw ?? td.textContent;
            if (v === refVal) {
                td.classList.add('cell-dup-match');
                count++;
            } else {
                td.classList.add('cell-dup-unique');
            }
        });
        const btn = document.getElementById('btn-duplicates');
        if (btn) btn.textContent = `⧉ Duplicates (${count})`;
    }

    // -------------------------------------------------------------------------
    // Cell selection & Keyboard
    // -------------------------------------------------------------------------

    function _selectCell(td) {
        if (_selectedCell) {
            _selectedCell.classList.remove('cell-selected');
        }

        if (_selectedCell === td) {
            _selectedCell = null;
            window.getSelection().removeAllRanges();
            return;
        }

        _selectedCell = td;
        td.classList.add('cell-selected');

        // Select text within the cell
        const range = document.createRange();
        range.selectNodeContents(td);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    }

    function _onKeyDown(e) {
        // Escape — exit eval mode if active (restores toolbox + cursor)
        if (e.key === 'Escape' && _calculusEvalMode) {
            e.preventDefault();
            _calcExitEvalMode();
            return;
        }

        // Escape — exit bind mode silently if it is active
        if (e.key === 'Escape' && _calculusBindModeRowId !== null) {
            e.preventDefault();
            _calcExitBindMode();
            return;
        }

        const isCopy = (e.metaKey || e.ctrlKey) && e.key === 'c';
        if (!isCopy || !_selectedCell) return;

        // If something else is focused (like a textarea), don't interfere
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
            return;
        }

        // We handle the copy ourselves so that multi-line cell content (with real \n)
        // is preserved. Prevent the browser's default copy, which would copy the
        // visually-rendered, potentially single-line text instead.
        e.preventDefault();

        // Prefer the original raw value (which may contain line breaks) when present.
        const text = _selectedCell.dataset.raw ?? _selectedCell.textContent;

        navigator.clipboard.writeText(text).then(() => {
            // Optional: visual feedback
            App.notify?.('Cell copied to clipboard', 'success');
        });
    }

    // -------------------------------------------------------------------------
    // Export helpers
    // -------------------------------------------------------------------------

async function _copyAsSqlSelect() {
        if (!_lastResult) {
            App.notify?.('No results to copy.', 'warn');
            return;
        }

        const { cols, rows } = _lastResult;
        const { visibleRowIndices, visibleColIndices } = _getVisibleIndices();

        const visibleRows = visibleRowIndices.map(i => rows[i]);
        const visibleCols = visibleColIndices.map(i => cols[i]);

        if (visibleRows.length === 0) {
            App.notify?.('No rows to copy.', 'warn');
            return;
        }

        const ROW_LIMIT = 5000;
        if (visibleRows.length > ROW_LIMIT) {
            if (!await Dialog.confirm(`The result has ${visibleRows.length.toLocaleString()} rows. Generating SQL for all of them may produce a very large string. Continue?`)) return;
        }

        // Escape a single value to a SQL literal.
        function sqlLiteral(val) {
            if (val === null || val === undefined) return 'NULL';
            const str = String(val);
            // Integers and decimals — output unquoted
            if (/^-?\d+(\.\d+)?$/.test(str)) return str;
            // Everything else — single-quote with escaped inner quotes
            return "'" + str.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
        }

        // Deduplicate column aliases — JOIN results can have same-named columns from
        // different tables, which MySQL rejects when the SELECT is used in a UNION.
        const seenCols = {};
        const uniqueCols = visibleCols.map(col => {
            if (!seenCols[col]) { seenCols[col] = 1; return col; }
            seenCols[col]++;
            return `${col}_${seenCols[col]}`;
        });

        const selectBlocks = visibleRows.map((row, rowIdx) => {
            const exprs = uniqueCols.map((col, ki) => {
                const lit = sqlLiteral(row[visibleColIndices[ki]]);
                // Column aliases only on the first SELECT row
                return rowIdx === 0 ? `${lit} AS \`${col}\`` : lit;
            });
            return '(\nSELECT\n\t' + exprs.join(',\n\t') + '\n)';
        });

        const sql = selectBlocks.join('\nUNION ALL\n');

        navigator.clipboard.writeText(sql)
            .then(() => {
                const btn = document.getElementById('btn-copy-sql-select');
                const orig = btn.textContent;
                btn.textContent = '✓ Copied!';
                setTimeout(() => (btn.textContent = orig), 1800);
            })
            .catch(() => App.notify?.('Clipboard write failed.', 'error'));
    }

    /**
     * Read column labels exactly as rendered in the results table header.
     * Strips .col-badge and .th-table-origin sub-elements so only the label
     * text remains (e.g. "a1.age", "a2.age"). Used by CSV / JSON exports so
     * they stay in sync with whatever the table currently shows.
     */
    function _getRenderedHeaders() {
        const ths = document.querySelectorAll('#results-table thead th:not(.th-row-num)');
        return Array.from(ths).map(th => {
            const clone = th.cloneNode(true);
            clone.querySelectorAll('.th-table-origin, .col-badge, .th-sort-btn, .th-filter-wrap').forEach(el => el.remove());
            return clone.textContent.trim();
        });
    }

    /**
     * Returns the indices of rows and columns that are currently visible in the
     * results table, accounting for column filters (row-col-filter-hidden) and Dim
     * (inline display:none on cells). Exports use this so they only include
     * what the user can actually see.
     */
    function _getVisibleIndices() {
        if (!_lastResult) return { visibleRowIndices: [], visibleColIndices: [] };

        // Rows: skip the compare banner (not a data row), exclude column-filter-hidden
        // and dim-row-hidden rows. dataIdx tracks the position in _lastResult.rows.
        const trs = Array.from(document.querySelectorAll('#results-table tbody tr'));
        const visibleRowIndices = [];
        let dataIdx = 0;
        trs.forEach(tr => {
            if (tr.classList.contains('compare-banner-row')) return; // not a data row
            if (!tr.classList.contains('row-col-filter-hidden') &&
                !tr.classList.contains('dim-row-hidden')) {
                visibleRowIndices.push(dataIdx);
            }
            dataIdx++;
        });

        // Columns: Dim sets display:none on header and data cells
        const colCount = _lastResult.cols.length;
        const visibleColIndices = [];
        for (let i = 0; i < colCount; i++) {
            const th = document.querySelector(`#results-table thead th[data-col-idx="${i}"]`);
            if (!th || th.style.display !== 'none') {
                visibleColIndices.push(i);
            }
        }

        return { visibleRowIndices, visibleColIndices };
    }

    function _exportCsv() {
        if (!_lastResult) return;

        const { cols, rows } = _lastResult;
        const { visibleRowIndices, visibleColIndices } = _getVisibleIndices();

        // Use the rendered header labels (respect DB Schema Alias toggle),
        // falling back to raw cols if the table hasn't been rendered yet.
        const rendered    = _getRenderedHeaders();
        const allHeaders  = rendered.length === cols.length ? rendered : cols;
        const headers     = visibleColIndices.map(i => allHeaders[i]);
        const visibleRows = visibleRowIndices.map(i => rows[i]);

        const esc = v => {
            if (v === null || v === undefined) return '""';
            return '"' + String(v).replace(/"/g, '""') + '"';
        };

        const lines = [
            headers.map(esc).join(','),
            ...visibleRows.map(row => visibleColIndices.map(i => esc(row[i])).join(',')),
        ];

        const csvContent = lines.join('\r\n');

        if (document.getElementById('chk-csv-to-file')?.checked) {
            const isFilteredCsv   = visibleRows.length !== rows.length || visibleColIndices.length !== cols.length;
            const filteredSuffix  = isFilteredCsv ? '_filtered' : '';
            const nowCsv = new Date();
            const padCsv = n => String(n).padStart(2, '0');
            const filenameCsv = `query-result-${nowCsv.getFullYear()}-${padCsv(nowCsv.getMonth()+1)}-${padCsv(nowCsv.getDate())}_${padCsv(nowCsv.getHours())}-${padCsv(nowCsv.getMinutes())}-${padCsv(nowCsv.getSeconds())}${filteredSuffix}.csv`;
            _download(csvContent, filenameCsv, 'text/csv;charset=utf-8;');
        } else {
            navigator.clipboard.writeText(csvContent)
                .then(() => App.notify?.('CSV copied to clipboard', 'success'));
        }
    }

    /** Build deduplicated JSON keys from rendered headers (duplicate names get _2, _3 suffix). */
    function _buildJsonKeys() {
        const { cols } = _lastResult;
        const rendered = _getRenderedHeaders();
        const headers  = rendered.length === cols.length ? rendered : cols;
        const seen     = {};
        return headers.map(c => {
            const base = String(c);
            if (!seen[base]) { seen[base] = 1; return base; }
            seen[base]++;
            return `${base}_${seen[base]}`;
        });
    }

    function _exportJson() {
        if (!_lastResult) return;
        const { rows } = _lastResult;
        const { visibleRowIndices, visibleColIndices } = _getVisibleIndices();

        const allKeys     = _buildJsonKeys();
        const keys        = visibleColIndices.map(i => allKeys[i]);
        const visibleRows = visibleRowIndices.map(i => rows[i]);

        const payload = {
            table: _lastResult.tableRef || '',
            rows:  visibleRows.map(row => Object.fromEntries(keys.map((k, ki) => [k, row[visibleColIndices[ki]]]))),
        };
        const content = JSON.stringify(payload, null, '\t');

        if (document.getElementById('chk-json-to-clipboard')?.checked) {
            const isFilteredJson  = visibleRows.length !== rows.length || visibleColIndices.length !== (_lastResult.cols?.length ?? 0);
            const filteredSuffix  = isFilteredJson ? '_filtered' : '';
            const nowJson = new Date();
            const padJson = n => String(n).padStart(2, '0');
            const filenameJson = `query-result-${nowJson.getFullYear()}-${padJson(nowJson.getMonth()+1)}-${padJson(nowJson.getDate())}_${padJson(nowJson.getHours())}-${padJson(nowJson.getMinutes())}-${padJson(nowJson.getSeconds())}${filteredSuffix}.json`;
            _download(content, filenameJson, 'application/json');
            return;
        }

        navigator.clipboard.writeText(content)
            .then(() => App.notify?.('JSON copied to clipboard', 'success'));
    }

    function _download(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    /** Re-render the current result table in place (e.g. after a header-display toggle). */
    function rerender() {
        if (!_lastResult) return;
        _populateTable(
            _lastResult.cols,
            _lastResult.rows,
            _lastResult.col_tables || [],
            _lastResult.col_types  || []
        );
    }

    // -------------------------------------------------------------------------
    // Calculus toolbox — multi-row
    // -------------------------------------------------------------------------

    /** Disable the Calculus button and close the toolbox if it's currently open. */
    function _disableCalculusBtn() {
        const btn = document.getElementById('btn-calculus');
        if (!btn) return;
        btn.disabled = true;
        btn.title = 'Run a query first to enable Calculus mode';
        if (_calculusMode) _toggleCalculusMode();  // closes the toolbox
    }

    // Saved inline styles captured before maximizing, used to restore exact position/size.
    let _calcPreMaximizeStyles = null;
    let _calcEvalPreStyles     = null; // inline styles snapshot taken before entering eval mode
    let _calcMaxResizeObserver = null;
    let _calcMaxResizeWinListener = null;

    /** Dock the toolbox to the visible canvas column (#canvas-wrapper), clipping above the results strip when shown. */
    function _syncCalculusMaximizedGeometry() {
        const toolbox = document.getElementById('calculus-toolbox');
        if (!toolbox || !toolbox.classList.contains('is-maximized')) return;

        const cwEl = document.getElementById('canvas-wrapper');
        if (!cwEl) return;

        const r = cwEl.getBoundingClientRect();
        let top    = r.top;
        let left   = r.left;
        let width  = r.width;
        let height = r.height;

        const rp = document.getElementById('results-panel');
        if (rp && !rp.classList.contains('hidden') && !rp.classList.contains('is-fullscreen')) {
            const rr = rp.getBoundingClientRect();
            const overlapsVert = rr.top < r.bottom && rr.bottom > r.top;
            if (overlapsVert) {
                const hClip = rr.top - r.top;
                if (hClip >= 80) height = hClip;
            }
        }

        const geom = {
            top: `${Math.round(top)}px`,
            left: `${Math.round(left)}px`,
            width: `${Math.round(width)}px`,
            right: 'auto',
            bottom: 'auto',
            transform: 'none',
            maxWidth: 'none',
            maxHeight: 'none',
        };
        // Eval mode uses `height: auto !important` — only top/left/width matter until eval exits.
        if (!toolbox.classList.contains('is-eval-minimized')) {
            geom.height = `${Math.round(height)}px`;
        }
        Object.assign(toolbox.style, geom);
    }

    function _detachCalculusMaximizeLayoutWatch() {
        if (_calcMaxResizeObserver) {
            _calcMaxResizeObserver.disconnect();
            _calcMaxResizeObserver = null;
        }
        if (_calcMaxResizeWinListener) {
            window.removeEventListener('resize', _calcMaxResizeWinListener);
            _calcMaxResizeWinListener = null;
        }
    }

    function _attachCalculusMaximizeLayoutWatch() {
        _detachCalculusMaximizeLayoutWatch();
        const sync = () => { _syncCalculusMaximizedGeometry(); };
        _calcMaxResizeWinListener = sync;
        window.addEventListener('resize', sync);
        _calcMaxResizeObserver = new ResizeObserver(sync);
        const cwEl = document.getElementById('canvas-wrapper');
        const rp   = document.getElementById('results-panel');
        const lay  = document.getElementById('layout');
        if (cwEl) _calcMaxResizeObserver.observe(cwEl);
        if (rp) _calcMaxResizeObserver.observe(rp);
        if (lay) _calcMaxResizeObserver.observe(lay);
        requestAnimationFrame(() => {
            requestAnimationFrame(sync);
        });
    }

    function _toggleCalculusMaximize() {
        const toolbox = document.getElementById('calculus-toolbox');
        const btn     = document.getElementById('btn-calculus-maximize');
        if (toolbox.classList.contains('is-maximized')) {
            _detachCalculusMaximizeLayoutWatch();
            // Restore — put back the saved inline styles (empty string clears to CSS default)
            toolbox.classList.remove('is-maximized');
            if (_calcPreMaximizeStyles) {
                Object.assign(toolbox.style, _calcPreMaximizeStyles);
                _calcPreMaximizeStyles = null;
            }
            btn.textContent = '⤢';
            btn.title       = 'Maximize';
        } else {
            // Maximize — snapshot current inline styles so we can restore them later
            _calcPreMaximizeStyles = {
                top: toolbox.style.top, left: toolbox.style.left,
                right: toolbox.style.right, bottom: toolbox.style.bottom,
                width: toolbox.style.width, height: toolbox.style.height,
                transform: toolbox.style.transform,
                maxWidth: toolbox.style.maxWidth, maxHeight: toolbox.style.maxHeight,
            };
            toolbox.classList.add('is-maximized');
            _syncCalculusMaximizedGeometry();
            _attachCalculusMaximizeLayoutWatch();
            btn.textContent = '⤡';
            btn.title       = 'Restore';
        }
    }

    function _toggleCalculusMode() {
        _calculusMode = !_calculusMode;
        const btn = document.getElementById('btn-calculus');
        btn.classList.toggle('is-active', _calculusMode);
        btn.title = _calculusMode
            ? 'Exit Calculus mode'
            : 'Calculus mode — double-click numeric cells to build expressions';

        const toolbox = document.getElementById('calculus-toolbox');
        if (_calculusMode) {
            // Clear any inline position/size set by a previous drag or resize so
            // the CSS translate(-50%,-50%) centering always applies on open.
            ['left','top','right','bottom','transform','width','height','maxWidth','maxHeight']
                .forEach(p => { toolbox.style[p] = ''; });
            toolbox.classList.remove('hidden');
            // Auto-create first row if the toolbox is empty
            if (_calculusRows.length === 0) _calcAddRow();
        } else {
            _calcExitBindMode(); // clear bind mode on close (no fail flash)
            _calcExitEvalMode(); // restore from minimized if needed; toolbox.classList.add('hidden') below re-hides it
            // Reset maximized state so the toolbox always opens at default size/position
            _detachCalculusMaximizeLayoutWatch();
            toolbox.classList.remove('is-maximized');
            _calcPreMaximizeStyles = null;
            const maxBtn = document.getElementById('btn-calculus-maximize');
            maxBtn.textContent = '⤢';
            maxBtn.title       = 'Maximize';
            toolbox.classList.add('hidden');
        }
    }

    /** Returns true when every item in rowData originated from the exact same <tr>. */
    function _calcIsSameRow(rowData) {
        if (!rowData.items.length) return false;
        const trs = rowData.items.map(item => item.originTd?.closest('tr'));
        // All items live and from the same row
        if (trs.every(tr => tr && tr === trs[0])) return true;
        // After context restore all originTds are null. If the row was saved with
        // all items from the same result row, honour that so Bind Row stays visible.
        if (rowData.sameRowRestored && trs.every(tr => !tr)) return true;
        // Hybrid: all live (in-DOM) cells point to the same row — stale cells ignored
        const liveTrs = rowData.items
            .filter(item => item.originTd && document.body.contains(item.originTd))
            .map(item => item.originTd.closest('tr'));
        if (liveTrs.length > 0 && liveTrs.every(tr => tr && tr === liveTrs[0])) return true;
        return false;
    }

/** Show or hide the SELECT menu, WHERE menu, and Bind Row button based on the same-row condition. */
    function _calcUpdateToWhereBtn(rowEl, rowData) {
        const sameRow = _calcIsSameRow(rowData);

        const selMenu = rowEl.querySelector('.calculus-select-menu');
        if (selMenu) {
            selMenu.classList.toggle('hidden', !sameRow);
            if (!sameRow) {
                selMenu.querySelector('.calculus-select-dropdown')?.classList.add('hidden');
                selMenu.querySelector('.btn-calculus-select-trigger')?.classList.remove('is-open');
            }
        }

        const whereMenu = rowEl.querySelector('.calculus-where-menu');
        if (whereMenu) {
            whereMenu.classList.toggle('hidden', !sameRow);
            if (!sameRow) {
                whereMenu.querySelector('.calculus-where-dropdown')?.classList.add('hidden');
                whereMenu.querySelector('.btn-calculus-where-trigger')?.classList.remove('is-open');
            }
        }

        // Bind Row button follows the exact same same-row visibility rule
        const bindRowBtn = rowEl.querySelector('.btn-calculus-bind-row');
        if (bindRowBtn) {
            bindRowBtn.classList.toggle('hidden', !sameRow);
            // If this row just lost same-row eligibility while it was in bind mode, exit cleanly
            if (!sameRow && _calculusBindModeRowId === rowData.id) _calcExitBindMode();
        }

    }

    /**
     * Return the correct SQL token for one Calculus item:
     *  - Custom-expression column  → look up the actual SQL from State and wrap in (…)
     *  - Alias column              → wrap the alias name in (…) so it's unambiguous
     *  - Regular column            → use the label as-is (e.g. "t1.revenue")
     */
    function _calcGetSqlRef(item) {
        const { headerInfo } = item;

        if (headerInfo.isCustomExpr) {
            // Try to find the underlying SQL expression by alias or label
            const lbl = (headerInfo.label ?? '').trim();
            const found = (State.selectCustomExprs ?? []).find(e => {
                const a = (e.alias ?? '').trim();
                const l = (e.label ?? '').trim();
                return (a && a === lbl) || (l && l === lbl);
            });
            const rawExpr = found?.expr?.trim();
            return rawExpr ? `(${rawExpr})` : `(${lbl})`;
        }

        if (headerInfo.isAlias) {
            return `(${headerInfo.label})`;
        }

        // Plain column reference — already in "alias.col" or "col" form
        return headerInfo.label;
    }

    /**
     * Build and return the SQL expression string for a row, using column
     * references instead of numeric values. Shared by _calcToWhere and
     * _calcCopyAsWhere so the two always produce identical output.
     */
    function _calcBuildSqlExpr(id, rowEl) {
        const rowData = _calculusRows.find(r => r.id === id);
        if (!rowData || rowData.items.length === 0) return null;

        const selects = Array.from(rowEl.querySelectorAll('.calculus-op-select'));

        // Build list of included items: item[i] is excluded when the operator
        // directly to its left (selects[i-1]) is 'nop', along with its parens.
        // The bridging operator between two consecutive included items at original
        // indices a → b is selects[b-1] (guaranteed !== 'nop' for included items).
        const prefixNopd = rowEl._prefixSel?.value === 'nop';
        const included = [];
        rowData.items.forEach((item, i) => {
            if (i === 0 && prefixNopd) return;
            if (i > 0 && selects[i - 1]?.value === 'nop') return;
            included.push({ item, origIdx: i });
        });

        let sqlExpr = '';
        included.forEach(({ item, origIdx }, pi) => {
            if (item.openParen)  sqlExpr += '(';
            sqlExpr += _calcGetSqlRef(item);
            if (item.closeParen) sqlExpr += ')';
            if (pi < included.length - 1) {
                const bridgeSel = selects[included[pi + 1].origIdx - 1];
                const sqlOp = { '*': '*', '/': '/' }[bridgeSel.value] ?? bridgeSel.value;
                sqlExpr += ` ${sqlOp} `;
            }
        });
        return sqlExpr.trim();
    }

    /**
     * Build a SQL custom expression from the row's column references (not values)
     * and push it into State.selectCustomExprs, then refresh the SELECT panel.
     */
    function _calcToWhere(id, rowEl) {
        const rowData = _calculusRows.find(r => r.id === id);
        if (!rowData || rowData.items.length === 0) return;
        if (!_calcIsSameRow(rowData)) return;

        const sqlExpr = _calcBuildSqlExpr(id, rowEl);
        if (!sqlExpr) return;

        // Label and alias from the expression name input
        const nameRaw = rowEl.querySelector('.calculus-expr-name').value.trim();
        const label   = nameRaw || '* new from Calculus';
        const alias   = nameRaw.replace(/\s+/g, '_').substring(0, 30);

        // Push into State and refresh the SELECT panel
        if (!State.selectCustomExprs) State.selectCustomExprs = [];
        State.selectCustomExprs.push({
            id:      'cx_' + Date.now(),
            expr:    `(${sqlExpr})`,
            alias:   alias,
            label:   label,
            enabled: false,   // added unchecked — user opts in deliberately
        });

        QueryPanel.refresh();
        App.updateSQLPreview();
        App.notify?.(`Custom expression "${label}" added to SELECT (unchecked)`, 'success');

        // Scroll to the new row and flash it so the user spots it immediately
        requestAnimationFrame(() => {
            const rows = document.querySelectorAll('#select-columns .select-expr-row');
            const newRow = rows[rows.length - 1];
            if (newRow) {
                newRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                newRow.classList.add('expr-row-calculus-flash');
                setTimeout(() => newRow.classList.remove('expr-row-calculus-flash'), 2000);
            }
        });
    }

    /** Copy the SQL column-reference expression to the clipboard (no State mutation). */
    function _calcCopyAsWhere(id, rowEl) {
        const sqlExpr = _calcBuildSqlExpr(id, rowEl);
        if (!sqlExpr) {
            App.notify?.('Nothing to copy — add some cells first.', 'warn');
            return;
        }
        const nameRaw = rowEl.querySelector('.calculus-expr-name').value.trim();
        const alias   = nameRaw
            ? nameRaw.replace(/\s+/g, '_').substring(0, 30)
            : 'custom_expression';
        const text = `(${sqlExpr}) AS ${alias}`;
        navigator.clipboard.writeText(text)
            .then(() => App.notify?.('SQL expression copied', 'success'))
            .catch(() => App.notify?.('Copy failed — check clipboard permissions', 'error'));
    }

    /**
     * Copy the calculus expression as a raw WHERE filter string to the clipboard
     * (same format as _calcToWhereFilter but does NOT add it to State.where).
     */
    function _calcCopyWhereFilter(id, rowEl) {
        const sqlExpr = _calcBuildSqlExpr(id, rowEl);
        if (!sqlExpr) {
            App.notify?.('Nothing to copy — add some cells first.', 'warn');
            return;
        }
        navigator.clipboard.writeText(`(${sqlExpr})`)
            .then(() => App.notify?.('WHERE expression copied to clipboard', 'success'))
            .catch(() => App.notify?.('Copy failed', 'error'));
    }

    /**
     * Push the calculus expression as a raw WHERE filter and refresh the WHERE panel.
     * The expression uses column references and preserves any user-toggled parentheses.
     */
    function _calcToWhereFilter(id, rowEl) {
        const sqlExpr = _calcBuildSqlExpr(id, rowEl);
        if (!sqlExpr) {
            App.notify?.('Nothing to add — add some cells first.', 'warn');
            return;
        }

        if (!State.where) State.where = [];
        State.where.push({ type: 'raw', expr: `(${sqlExpr})`, operator: 'AND', enabled: false });

        QueryPanel.refresh();
        App.updateSQLPreview();
        App.notify?.('WHERE filter added (unchecked)', 'success');

        // Scroll to, flash, and focus the new WHERE condition row
        requestAnimationFrame(() => {
            const container = document.getElementById('where-conditions');
            if (!container) return;
            const newRow = container.lastElementChild;
            if (newRow) {
                newRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                newRow.classList.add('where-row-calculus-flash');
                setTimeout(() => newRow.classList.remove('where-row-calculus-flash'), 2000);
                newRow.querySelector('.where-expr-input')?.focus();
            }
        });
    }

    /** Create a new expression row and make it the active target. */
    function _calcAddRow() {
        const id = _calculusNextId++;
        _calculusRows.push({ id, items: [], historyRows: [], outOfSync: false, highlightActive: false, highlightInverted: false });
        _calcSetActiveRow(id);

        document.getElementById('calculus-hint').classList.add('hidden');

        const rowEl = document.createElement('div');
        rowEl.className = 'calculus-expr-row is-active';
        rowEl.dataset.rowId = id;
        rowEl.dataset.color = ((id - 1) % 8) + 1;
        rowEl.innerHTML = `
            <div class="calculus-expr-header">
                <span class="calculus-drag-handle" draggable="true" title="Drag to reorder">⠿</span>
                <button class="btn-calculus-clip-save" title="Copy this expression to clipboard">↓ Copy</button>
                <button class="btn-calculus-clip-load" title="Load expression from pasted JSON">↑ Load</button>
                <label class="calculus-hl-invert-label" title="When checked: highlight rows that DO NOT pass the comparison"><input type="checkbox" class="calculus-hl-invert-cb"></label>
                <button class="btn-calculus-hl-toggle" title="Highlight results rows where this expression matches the title comparison">◈ HL</button>
                <input type="text" class="calculus-expr-name" placeholder="Expression name…">
                <button class="btn-calculus-expr-delete" title="Remove this expression">✕</button>
            </div>
            <div class="calculus-clip-panel hidden">
                <textarea class="calculus-clip-textarea" placeholder="Line 1: expression name&#10;Lines 2+: formula  (e.g. Age&#10;+ Effort&#10;- Sleep)" rows="4" spellcheck="false"></textarea>
                <div class="calculus-clip-actions">
                    <button class="btn-calculus-clip-apply">Apply</button>
                    <button class="btn-calculus-clip-cancel">✕</button>
                </div>
            </div>
            <div class="calculus-sync-msg hidden">⚠ Out of sync — references a previous query result. Alt+click highlighting is disabled.</div>
            <div class="calculus-expr-hint">Double-click numeric cells in the table to add them here.</div>
            <div class="calculus-expr-table-wrap hidden">
                <table class="calculus-expr-table">
                    <thead><tr></tr></thead>
                    <tbody><tr></tr></tbody>
                </table>
            </div>
            <div class="calculus-expr-footer hidden">
                <span class="calculus-expr-result"></span>
                <input type="checkbox" class="chk-calculus-sync-all-bind" checked title="Sync All — when checked: syncs all other expressions to this row on Bind Row, on hover preview, and when changing the expression name">
                <button class="btn-calculus-bind-row hidden" title="Bind to a results row — enter bind mode, then click any result row to re-link all cells to that row">◎ Bind Row</button>
                <div class="calculus-clone-menu">
                    <button class="btn-calculus-clone-trigger" title="Clone expression actions">Clone ▾</button>
                    <div class="calculus-clone-dropdown hidden">
                        <button class="btn-calculus-deflate" title="Create new calculus from enabled columns only">⊟ Deflate</button>
                        <button class="btn-calculus-complement" title="Create new calculus from disabled columns only">⊞ Complement</button>
                    </div>
                </div>
                <div class="calculus-where-menu">
                    <button class="btn-calculus-where-trigger" title="WHERE expression actions">WHERE ▾</button>
                    <div class="calculus-where-dropdown hidden">
                        <button class="btn-calculus-copy-where-filter" title="Copy raw WHERE expression to clipboard">RAW</button>
                        <button class="btn-calculus-where-filter" title="Add as a raw WHERE filter">to WHERE</button>
                    </div>
                </div>
                <div class="calculus-select-menu">
                    <button class="btn-calculus-select-trigger" title="SELECT expression actions">SELECT ▾</button>
                    <div class="calculus-select-dropdown hidden">
                        <button class="btn-calculus-as-where" title="Copy SQL column-reference expression to clipboard">RAW</button>
                        <button class="btn-calculus-to-where" title="All cells are from the same row — add as Custom Expression to SELECT">to SELECT - Custom Expression</button>
                    </div>
                </div>
                <div class="calculus-data-menu">
                    <button class="btn-calculus-data-trigger" title="Data copy actions">Data ▾</button>
                    <div class="calculus-data-dropdown hidden">
                        <button class="btn-calculus-expr-copy-formula" title="Copy formula (column labels + operators + parentheses)">⧉ Formula</button>
                        <button class="btn-calculus-expr-copy-data"  title="Copy values and operators only">⧉ Data</button>
                        <button class="btn-calculus-expr-copy-plain" title="Copy formula as plain text">⧉ All</button>
                        <button class="btn-calculus-history" title="View expression history">⊞ History</button>                        
                    </div>
                </div>
            </div>`;

        // Clicking anywhere in the row (except delete) sets it as active
        rowEl.addEventListener('mousedown', e => {
            if (e.target.classList.contains('btn-calculus-expr-delete')) return;
            _calcSetActiveRow(id);
        });

        rowEl.querySelector('.btn-calculus-expr-delete')
            .addEventListener('click', () => _calcDeleteRow(id, rowEl));

        // Sync All checkbox: when transitioning to checked, immediately broadcast this row to all others
        rowEl.querySelector('.chk-calculus-sync-all-bind')
            .addEventListener('change', function () {
                if (this.checked) _calcBroadcastRow(id);
            });

        // ---- Clipboard Save ----
        rowEl.querySelector('.btn-calculus-clip-save')
            .addEventListener('click', e => {
                e.stopPropagation();
                const rowData = _calculusRows.find(r => r.id === id);
                if (!rowData) return;
                const json = _calcSerialiseRow(rowData, rowEl);
                navigator.clipboard.writeText(json)
                    .then(() => App.notify?.('Expression copied to clipboard', 'success'))
                    .catch(() => App.notify?.('Copy failed — check clipboard permissions', 'error'));
            });

        // ---- Clipboard Load (toggle paste panel) ----
        const _clipPanel = rowEl.querySelector('.calculus-clip-panel');

        const _clipLoadBtn = rowEl.querySelector('.btn-calculus-clip-load');
        _clipLoadBtn.addEventListener('click', e => {
            e.stopPropagation();
            const opening = _clipPanel.classList.contains('hidden');
            _clipPanel.classList.toggle('hidden', !opening);
            _clipLoadBtn.classList.toggle('is-open', opening);
            if (opening) _clipPanel.querySelector('.calculus-clip-textarea').focus();
        });

        _clipPanel.querySelector('.calculus-clip-textarea')
            .addEventListener('keydown', e => {
                if (e.key === 'Enter' && e.shiftKey) {
                    e.preventDefault();
                    rowEl.querySelector('.btn-calculus-clip-apply').click();
                }
            });

        rowEl.querySelector('.btn-calculus-clip-apply')
            .addEventListener('click', e => {
                e.stopPropagation();
                const ta   = _clipPanel.querySelector('.calculus-clip-textarea');
                const text = ta.value.trim();
                if (!text) return;

                // Format: line 1 = name, lines 2+ = formula (same syntax as Eval prompt)
                const newlineIdx = text.indexOf('\n');
                const name    = (newlineIdx === -1 ? text : text.slice(0, newlineIdx)).trim();
                const formula = (newlineIdx === -1 ? '' : text.slice(newlineIdx + 1)).trim();

                if (!formula) {
                    App.notify?.('No formula found — paste the name on line 1 and the formula from line 2', 'error');
                    return;
                }

                const parsed = _calcParseExpr(formula);
                if (parsed.error) {
                    App.notify?.(`Cannot parse formula: ${parsed.error}`, 'error');
                    return;
                }

                // Validate column names against the current results table
                const ths = Array.from(document.querySelectorAll('#results-table thead tr th'));
                if (ths.length === 0) {
                    App.notify?.('No results table found — run a query first', 'error');
                    return;
                }
                const missing = parsed.items.filter(item => _findThIndexByLabel(ths, item.col) === -1);
                if (missing.length > 0) {
                    App.notify?.(
                        `Column(s) not found in results: ${missing.map(it => `"${it.col}"`).join(', ')}`,
                        'error'
                    );
                    return;
                }

                // Close the panel regardless of which path we take
                ta.value = '';
                _clipPanel.classList.add('hidden');
                _clipLoadBtn.classList.remove('is-open');

                _calculusEvalTargetRowId = id;
                _calculusEvalTargetName  = name;

                // If the row is already in sync, find its live bound <tr> and apply immediately
                const rowData  = _calculusRows.find(r => r.id === id);
                const liveTd   = rowData?.items.find(item => item.originTd && document.body.contains(item.originTd))?.originTd;
                const liveTr   = liveTd?.closest('tr');

                if (liveTr) {
                    // Auto-apply: set eval state directly (skip the toolbox-minimize UI)
                    _calculusEvalMode  = true;
                    _calculusEvalItems = parsed.items;
                    _calculusEvalExpr  = formula;
                    _calcApplyEval(liveTr.querySelector('td') ?? liveTd);
                } else {
                    // Not in sync — enter normal eval mode, user must click a result row
                    _calcEnterEvalMode(parsed.items, formula);
                    App.notify?.('Click any result row to load the expression into this calculus', 'info');
                }
            });

        rowEl.querySelector('.btn-calculus-clip-cancel')
            .addEventListener('click', e => {
                e.stopPropagation();
                _clipPanel.querySelector('.calculus-clip-textarea').value = '';
                _clipPanel.classList.add('hidden');
                _clipLoadBtn.classList.remove('is-open');
            });

        rowEl.querySelector('.btn-calculus-bind-row')
            .addEventListener('click', () => {
                // Toggle off if this row is already in bind mode
                if (_calculusBindModeRowId === id) { _calcExitBindMode(); return; }
                const rowData = _calculusRows.find(r => r.id === id);
                if (!rowData || rowData.items.length === 0) return;
                _calcEnterBindMode(id);
            });

        rowEl.querySelector('.btn-calculus-history')
            .addEventListener('click', () => {
                const rowData = _calculusRows.find(r => r.id === id);
                if (rowData) _calcShowHistory(rowData, rowEl);
            });

        const _cloneTrigger  = rowEl.querySelector('.btn-calculus-clone-trigger');
        const _cloneDropdown = rowEl.querySelector('.calculus-clone-dropdown');

        _cloneTrigger.addEventListener('click', e => {
            e.stopPropagation();
            const opening = _cloneDropdown.classList.contains('hidden');
            document.querySelectorAll('.calculus-clone-dropdown')
                .forEach(d => d.classList.add('hidden'));
            document.querySelectorAll('.btn-calculus-clone-trigger')
                .forEach(b => b.classList.remove('is-open'));
            if (opening) {
                _cloneDropdown.classList.remove('hidden');
                _cloneTrigger.classList.add('is-open');
            }
        });

        rowEl.querySelector('.btn-calculus-deflate')
            .addEventListener('click', () => {
                _cloneDropdown.classList.add('hidden');
                _cloneTrigger.classList.remove('is-open');
                const rowData = _calculusRows.find(r => r.id === id);
                if (!rowData || rowData.items.length === 0) return;

                const opSelects  = Array.from(rowEl.querySelectorAll('.calculus-op-select'));
                const prefixNopd = rowEl._prefixSel?.value === 'nop';

                // Pair each enabled item with the operator that preceded it in the source row
                const enabledEntries = rowData.items
                    .map((item, i) => ({ item, op: i === 0 ? null : opSelects[i - 1]?.value }))
                    .filter((_, i) => i === 0 ? !prefixNopd : opSelects[i - 1]?.value !== 'nop');

                if (enabledEntries.length === 0) return;

                const sourceName = rowEl.querySelector('.calculus-expr-name').value.trim();
                _calcAddRow();
                const newRowEl = document.querySelector(`.calculus-expr-row[data-row-id="${_calculusActiveId}"]`);
                if (newRowEl) {
                    rowEl.after(newRowEl); // insert directly after source row
                    if (sourceName) newRowEl.querySelector('.calculus-expr-name').value = `${sourceName} (deflated)`;
                }
                enabledEntries.forEach(({ item }) => _calcAddCell(item.headerInfo, item.value, item.originTd));

                // Apply the original operators and parentheses
                if (newRowEl) {
                    const newOpSelects = Array.from(newRowEl.querySelectorAll('.calculus-op-select'));
                    const valueTds     = Array.from(newRowEl.querySelectorAll('tbody tr td.calculus-value'));
                    enabledEntries.forEach(({ item, op }, i) => {
                        if (i > 0 && op && newOpSelects[i - 1]) {
                            newOpSelects[i - 1].value = op;
                            newOpSelects[i - 1].dispatchEvent(new Event('change'));
                        }
                        if (item.openParen)  valueTds[i]?.querySelector('.calc-paren-o')?.click();
                        if (item.closeParen) valueTds[i]?.querySelector('.calc-paren-c')?.click();
                    });
                }
            });

        rowEl.querySelector('.btn-calculus-complement')
            .addEventListener('click', () => {
                _cloneDropdown.classList.add('hidden');
                _cloneTrigger.classList.remove('is-open');
                const rowData = _calculusRows.find(r => r.id === id);
                if (!rowData || rowData.items.length === 0) return;

                const opSelects  = Array.from(rowEl.querySelectorAll('.calculus-op-select'));
                const prefixNopd = rowEl._prefixSel?.value === 'nop';

                const disabledItems = rowData.items.filter((item, i) =>
                    i === 0 ? prefixNopd : opSelects[i - 1]?.value === 'nop'
                );
                if (disabledItems.length === 0) return;

                const sourceName = rowEl.querySelector('.calculus-expr-name').value.trim();
                _calcAddRow();
                const newRowEl = document.querySelector(`.calculus-expr-row[data-row-id="${_calculusActiveId}"]`);
                if (newRowEl) {
                    rowEl.after(newRowEl); // insert directly after source row
                    if (sourceName) newRowEl.querySelector('.calculus-expr-name').value = `${sourceName} (complement)`;
                }
                disabledItems.forEach(item => _calcAddCell(item.headerInfo, item.value, item.originTd));
            });

        const _dataTrigger  = rowEl.querySelector('.btn-calculus-data-trigger');
        const _dataDropdown = rowEl.querySelector('.calculus-data-dropdown');

        _dataTrigger.addEventListener('click', e => {
            e.stopPropagation();
            const opening = _dataDropdown.classList.contains('hidden');
            document.querySelectorAll('.calculus-data-dropdown')
                .forEach(d => d.classList.add('hidden'));
            document.querySelectorAll('.btn-calculus-data-trigger')
                .forEach(b => b.classList.remove('is-open'));
            if (opening) {
                _dataDropdown.classList.remove('hidden');
                _dataTrigger.classList.add('is-open');
            }
        });

        rowEl.querySelector('.btn-calculus-expr-copy-formula')
            .addEventListener('click', () => {
                _dataDropdown.classList.add('hidden');
                _dataTrigger.classList.remove('is-open');
                _calcCopyRow(id, rowEl, 'formula');
            });

        rowEl.querySelector('.btn-calculus-expr-copy-data')
            .addEventListener('click', () => {
                _dataDropdown.classList.add('hidden');
                _dataTrigger.classList.remove('is-open');
                _calcCopyRow(id, rowEl, 'data');
            });

        rowEl.querySelector('.btn-calculus-expr-copy-plain')
            .addEventListener('click', () => {
                _dataDropdown.classList.add('hidden');
                _dataTrigger.classList.remove('is-open');
                _calcCopyRow(id, rowEl, 'plain');
            });

        // SELECT dropdown — toggle on trigger click, close on item click
        const _selTrigger  = rowEl.querySelector('.btn-calculus-select-trigger');
        const _selDropdown = rowEl.querySelector('.calculus-select-dropdown');

        _selTrigger.addEventListener('click', e => {
            e.stopPropagation();
            const opening = _selDropdown.classList.contains('hidden');
            // Close every open dropdown across all rows first
            document.querySelectorAll('.calculus-select-dropdown')
                .forEach(d => d.classList.add('hidden'));
            document.querySelectorAll('.btn-calculus-select-trigger')
                .forEach(b => b.classList.remove('is-open'));
            if (opening) {
                _selDropdown.classList.remove('hidden');
                _selTrigger.classList.add('is-open');
            }
        });

        // WHERE dropdown — toggle on trigger click, close on item click
        const _whereTrigger  = rowEl.querySelector('.btn-calculus-where-trigger');
        const _whereDropdown = rowEl.querySelector('.calculus-where-dropdown');

        _whereTrigger.addEventListener('click', e => {
            e.stopPropagation();
            const opening = _whereDropdown.classList.contains('hidden');
            document.querySelectorAll('.calculus-where-dropdown')
                .forEach(d => d.classList.add('hidden'));
            document.querySelectorAll('.btn-calculus-where-trigger')
                .forEach(b => b.classList.remove('is-open'));
            if (opening) {
                _whereDropdown.classList.remove('hidden');
                _whereTrigger.classList.add('is-open');
            }
        });

        rowEl.querySelector('.btn-calculus-copy-where-filter')
            .addEventListener('click', () => {
                _whereDropdown.classList.add('hidden');
                _whereTrigger.classList.remove('is-open');
                _calcCopyWhereFilter(id, rowEl);
            });

        rowEl.querySelector('.btn-calculus-where-filter')
            .addEventListener('click', () => {
                _whereDropdown.classList.add('hidden');
                _whereTrigger.classList.remove('is-open');
                _calcToWhereFilter(id, rowEl);
            });

        rowEl.querySelector('.btn-calculus-to-where')
            .addEventListener('click', () => {
                _selDropdown.classList.add('hidden');
                _selTrigger.classList.remove('is-open');
                _calcToWhere(id, rowEl);
            });

        rowEl.querySelector('.btn-calculus-as-where')
            .addEventListener('click', () => {
                _selDropdown.classList.add('hidden');
                _selTrigger.classList.remove('is-open');
                _calcCopyAsWhere(id, rowEl);
            });

        // One global click-outside listener (registered only once)
        if (!window._calcSelectMenuListenerAdded) {
            window._calcSelectMenuListenerAdded = true;
            document.addEventListener('click', () => {
                document.querySelectorAll('.calculus-select-dropdown')
                    .forEach(d => d.classList.add('hidden'));
                document.querySelectorAll('.btn-calculus-select-trigger')
                    .forEach(b => b.classList.remove('is-open'));
                document.querySelectorAll('.calculus-where-dropdown')
                    .forEach(d => d.classList.add('hidden'));
                document.querySelectorAll('.btn-calculus-where-trigger')
                    .forEach(b => b.classList.remove('is-open'));
                document.querySelectorAll('.calculus-data-dropdown')
                    .forEach(d => d.classList.add('hidden'));
                document.querySelectorAll('.btn-calculus-data-trigger')
                    .forEach(b => b.classList.remove('is-open'));
                document.querySelectorAll('.calculus-clone-dropdown')
                    .forEach(d => d.classList.add('hidden'));
                document.querySelectorAll('.btn-calculus-clone-trigger')
                    .forEach(b => b.classList.remove('is-open'));
            });
        }

        const _resultEl = rowEl.querySelector('.calculus-expr-result');

        const _mathAppend = text => {
            const mathPopup = document.getElementById('calculus-math-popup');
            const mathInput = document.getElementById('calculus-math-input');
            if (mathPopup.classList.contains('hidden'))
                document.getElementById('btn-calculus-math').click();
            // Multi-item expressions (contain spaces between operator tokens) get wrapped
            // in parentheses; single values are appended as-is.
            const isMulti = /\s/.test(text.trim());
            const toAdd   = isMulti ? `(${text})` : text;
            mathInput.value = mathInput.value ? mathInput.value + ' + ' + toAdd : toAdd;
            mathInput.dispatchEvent(new Event('input', { bubbles: true }));
            mathInput.scrollTop = mathInput.scrollHeight;
            mathInput.focus();
        };

        _resultEl.addEventListener('click', function (e) {
            const valEl = this.querySelector('.calculus-result-val');
            const fmlEl = this.querySelector('.calculus-result-formula');
            if (valEl && (e.target === valEl || valEl.contains(e.target))) {
                navigator.clipboard.writeText(valEl.textContent)
                    .then(() => App.notify?.('Value copied', 'success'))
                    .catch(() => App.notify?.('Copy failed — check clipboard permissions', 'error'));
            } else if (fmlEl && (e.target === fmlEl || fmlEl.contains(e.target))) {
                if (!this._expr) return;
                navigator.clipboard.writeText(this._expr)
                    .then(() => App.notify?.('Formula copied', 'success'))
                    .catch(() => App.notify?.('Copy failed — check clipboard permissions', 'error'));
            }
        });

        _resultEl.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            const valEl = this.querySelector('.calculus-result-val');
            const fmlEl = this.querySelector('.calculus-result-formula');
            if (valEl && (e.target === valEl || valEl.contains(e.target))) {
                _mathAppend(valEl.textContent);
            } else if (fmlEl && (e.target === fmlEl || fmlEl.contains(e.target)) && this._expr) {
                _mathAppend(this._expr);
            }
        });

        rowEl.querySelector('.calculus-expr-name')
            .addEventListener('input', () => {
                _calcCheckTitleComparison(id, rowEl);
                _calcApplyHighlightForId(id);
                // If Sync All is checked, propagate the name to all other rows
                if (rowEl.querySelector('.chk-calculus-sync-all-bind')?.checked) {
                    const val = rowEl.querySelector('.calculus-expr-name').value;
                    for (const other of _calculusRows) {
                        if (other.id === id) continue;
                        const otherEl = document.querySelector(`.calculus-expr-row[data-row-id="${other.id}"]`);
                        if (!otherEl) continue;
                        _calcCheckTitleComparison(other.id, otherEl);
                        _calcApplyHighlightForId(other.id);
                    }
                }
            });

        rowEl.querySelector('.btn-calculus-hl-toggle')
            .addEventListener('click', () => {
                const rowData = _calculusRows.find(r => r.id === id);
                if (!rowData) return;
                rowData.highlightActive = !rowData.highlightActive;
                rowEl.querySelector('.btn-calculus-hl-toggle')
                    .classList.toggle('is-active', rowData.highlightActive);
                if (rowData.highlightActive) {
                    _calcHighlightActiveIds.add(id);
                    _calcApplyHighlightForId(id);
                } else {
                    _calcHighlightActiveIds.delete(id);
                    _calcClearHighlightForId(id);
                }
                _dimRefreshModeIfDimmed();
            });

        rowEl.querySelector('.calculus-hl-invert-cb')
            .addEventListener('change', () => {
                const rowData = _calculusRows.find(r => r.id === id);
                if (!rowData) return;
                rowData.highlightInverted = rowEl.querySelector('.calculus-hl-invert-cb').checked;
                if (rowData.highlightActive) _calcApplyHighlightForId(id);
            });

        // ---- Drag to reorder ----
        const dragHandle = rowEl.querySelector('.calculus-drag-handle');

        dragHandle.addEventListener('dragstart', e => {
            _calcDragSourceId = id;
            e.dataTransfer.effectAllowed = 'move';
            // Use the whole row as the drag ghost image
            e.dataTransfer.setDragImage(rowEl, 0, 0);
            // Defer class addition so the ghost image is captured first
            requestAnimationFrame(() => rowEl.classList.add('is-dragging'));
        });

        dragHandle.addEventListener('dragend', () => {
            rowEl.classList.remove('is-dragging');
            document.querySelectorAll('#calculus-rows-container .calculus-expr-row')
                .forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));
            _calcDragSourceId = null;
        });

        rowEl.addEventListener('dragover', e => {
            if (_calcDragSourceId === null || _calcDragSourceId === id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const rect = rowEl.getBoundingClientRect();
            const before = e.clientY < rect.top + rect.height / 2;
            document.querySelectorAll('#calculus-rows-container .calculus-expr-row')
                .forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));
            rowEl.classList.add(before ? 'drag-over-top' : 'drag-over-bottom');
        });

        rowEl.addEventListener('dragleave', e => {
            // Only clear if leaving the row entirely (not moving to a child)
            if (!rowEl.contains(e.relatedTarget)) {
                rowEl.classList.remove('drag-over-top', 'drag-over-bottom');
            }
        });

        rowEl.addEventListener('drop', e => {
            e.preventDefault();
            rowEl.classList.remove('drag-over-top', 'drag-over-bottom');
            if (_calcDragSourceId === null || _calcDragSourceId === id) return;

            const container = document.getElementById('calculus-rows-container');
            const sourceEl  = container.querySelector(`[data-row-id="${_calcDragSourceId}"]`);
            if (!sourceEl) return;

            const rect   = rowEl.getBoundingClientRect();
            const before = e.clientY < rect.top + rect.height / 2;
            container.insertBefore(sourceEl, before ? rowEl : rowEl.nextSibling);

            // Keep _calculusRows array in sync with DOM order
            const domOrder = Array.from(container.querySelectorAll('.calculus-expr-row'))
                .map(el => Number(el.dataset.rowId));
            _calculusRows.sort((a, b) => domOrder.indexOf(a.id) - domOrder.indexOf(b.id));
        });

        document.getElementById('calculus-rows-container').appendChild(rowEl);
        rowEl.querySelector('.calculus-expr-name').focus();
    }

    /** Make a row the active target for incoming double-clicks. */
    function _calcSetActiveRow(id) {
        _calculusActiveId = id;
        document.querySelectorAll('.calculus-expr-row').forEach(el => {
            el.classList.toggle('is-active', Number(el.dataset.rowId) === id);
        });
    }

    let _calcOriginTimer = null;

    /**
     * Evaluate a flat token list [num, op, num, op, …] left-to-right.
     * Preserves the existing % = (a/b)*100 semantics.
     */
    function _evalFlat(tokens) {
        if (!tokens.length) return 0;
        let result = +tokens[0];
        for (let i = 1; i < tokens.length; i += 2) {
            const op  = tokens[i];
            const rhs = +tokens[i + 1];
            if      (op === '+') result = result + rhs;
            else if (op === '-') result = result - rhs;
            else if (op === '*') result = result * rhs;
            else if (op === '/') result = rhs !== 0 ? result / rhs : NaN;
            else if (op === '%') result = rhs !== 0 ? (result / rhs) * 100 : NaN;
        }
        return result;
    }

    /**
     * Evaluate an expression that may contain parentheses.
     * items  — rowData.items array (each has .value, .openParen, .closeParen)
     * opVals — array of raw operator strings (+, -, *, /, %) between items
     *
     * Strategy: iteratively resolve the innermost ( … ) group until none remain,
     * then evaluate the resulting flat token list.
     */
    function _evalWithParens(items, opVals, firstNopd = false) {
        // Filter out nop'd items.
        //   item[0] is excluded when firstNopd is true (prefix-nop).
        //   item[i>0] is excluded when opVals[i-1] === 'nop'.
        // The bridging op for a surviving item is opVals[i-1], but only pushed
        // when there is already an active item before it — using activeItems.length
        // instead of i>0 correctly handles a prefix-nop'd item[0] where item[1]
        // becomes the first active entry and needs no preceding operator.
        const activeItems = [];
        const activeOps   = [];
        items.forEach((item, i) => {
            if (i === 0 && firstNopd) return;
            if (i > 0 && opVals[i - 1] === 'nop') return;
            if (activeItems.length > 0) activeOps.push(opVals[i - 1]);
            activeItems.push(item);
        });

        // Build a flat token list: mix of numbers, operators and paren strings
        const tokens = [];
        activeItems.forEach((item, i) => {
            if (item.openParen)  tokens.push('(');
            tokens.push(parseFloat(item.value));
            if (item.closeParen) tokens.push(')');
            if (i < activeOps.length) tokens.push(activeOps[i]);
        });

        // Iteratively resolve innermost groups
        let safety = 0;
        while (tokens.includes('(')) {
            if (++safety > 200) break; // guard against infinite loop on bad input
            const closeIdx = tokens.indexOf(')');
            if (closeIdx === -1) break; // unmatched ( — evaluate as-is

            let openIdx = -1;
            for (let i = closeIdx - 1; i >= 0; i--) {
                if (tokens[i] === '(') { openIdx = i; break; }
            }
            if (openIdx === -1) break; // unmatched ) — evaluate as-is

            const sub    = tokens.slice(openIdx + 1, closeIdx);
            const subVal = _evalFlat(sub);
            tokens.splice(openIdx, closeIdx - openIdx + 1, subVal);
        }

        return _evalFlat(tokens);
    }

    /** Clear the stale result display for a row. */
    function _calcClearRowResult(rowEl) {
        rowEl.querySelector('.calculus-expr-result').textContent = '';
        if (rowEl._resultTd) {
            rowEl._resultTd.textContent = '—';
            rowEl._resultTd.className   = 'calculus-result-td';
        }
    }

    /** Mark all expression rows as out of sync with the current results table. */
    // -------------------------------------------------------------------------
    // Calculus Note
    // -------------------------------------------------------------------------

    function _openCalculusNote() {
        _calculusNoteOriginal = _calculusNote;
        const ta = document.getElementById('calculus-note-textarea');
        if (ta.value !== _calculusNote) {
            ta.value = _calculusNote;
            if (typeof UndoManager !== 'undefined') UndoManager.reset(ta);
        }
        document.getElementById('modal-calculus-note').classList.remove('hidden');
        ta.focus();
    }

    function _saveCalculusNote() {
        _calculusNote         = document.getElementById('calculus-note-textarea').value;
        _calculusNoteOriginal = _calculusNote;
    }

    function _closeCalculusNote() {
        _saveCalculusNote();
        document.getElementById('modal-calculus-note').classList.add('hidden');
    }

    /**
     * Returns the sync state of a row based on live DOM presence of each item's originTd:
     *   'out-of-sync' — all cells are stale / null
     *   'hybrid'      — mix of fresh and stale cells
     *   'in-sync'     — all cells are fresh (or row is empty)
     */
    function _calcGetRowSyncState(rowData) {
        if (rowData.items.length === 0) return 'in-sync';
        const hasFresh = rowData.items.some(item => item.originTd && document.body.contains(item.originTd));
        const hasStale = rowData.items.some(item => !item.originTd || !document.body.contains(item.originTd));
        if (hasFresh && hasStale) return 'hybrid';
        if (hasStale) return 'out-of-sync';
        return 'in-sync';
    }

    /** Apply the visual sync state to a single row element and update rowData.outOfSync. */
    function _calcApplyRowSyncVisual(rowData, rowEl, state) {
        rowEl.classList.remove('is-out-of-sync', 'is-hybrid');
        const msgEl = rowEl.querySelector('.calculus-sync-msg');
        if (state === 'out-of-sync') {
            rowData.outOfSync = true;
            rowEl.classList.add('is-out-of-sync');
            if (msgEl) {
                msgEl.textContent = '⚠ Out of sync — references a previous query result. Alt+click highlighting is disabled.';
                msgEl.classList.remove('hidden');
            }
        } else if (state === 'hybrid') {
            rowData.outOfSync = false;
            rowEl.classList.add('is-hybrid');
            if (msgEl) {
                msgEl.textContent = '⚠ Mixed — some cells reference the current result, others a previous one. Alt+click is disabled for stale cells.';
                msgEl.classList.remove('hidden');
            }
        } else {
            rowData.outOfSync = false;
            if (msgEl) msgEl.classList.add('hidden');
        }
    }

    /** Mark all expression rows as out of sync with the current results table. */
    function _calcMarkOutOfSync() {
        if (_calculusRows.length === 0) return;
        _calculusOutOfSync = true;
        _calculusRows.forEach(rowData => {
            const rowEl = document.querySelector(`.calculus-expr-row[data-row-id="${rowData.id}"]`);
            if (rowEl) _calcApplyRowSyncVisual(rowData, rowEl, 'out-of-sync');
            else rowData.outOfSync = true;
        });
    }

    /** Recompute and apply the sync state for a single row (called when a fresh cell is added). */
    function _calcMarkRowInSync(rowId) {
        const rowData = _calculusRows.find(r => r.id === rowId);
        if (!rowData) return;
        const rowEl = document.querySelector(`.calculus-expr-row[data-row-id="${rowId}"]`);
        if (rowEl) _calcApplyRowSyncVisual(rowData, rowEl, _calcGetRowSyncState(rowData));
        else rowData.outOfSync = false;
        _calculusOutOfSync = _calculusRows.some(r => r.outOfSync);
    }

    /** Reset the global sync flag (called by _calcClearAll — rows are removed anyway). */
    function _calcMarkInSync() {
        _calculusOutOfSync = false;
    }

    /**
     * Replace the value span in a calculus cell with a numeric <input>, de-syncing the item.
     * The item remembers both the input element and the original span for later restoration.
     */
    function _calcEnterManualInput(item, td, rowData, rowEl) {
        if (item._manualInputEl) return; // already in manual mode
        const valSpan = td.querySelector('.calc-val');
        if (!valSpan) return;

        const savedOriginTd = item.originTd;

        const inputEl = document.createElement('input');
        inputEl.type      = 'number';
        inputEl.className = 'calc-manual-input';
        inputEl.value     = item.value;
        inputEl.step      = 'any';
        inputEl.title     = '';

        const closeBtn = document.createElement('button');
        closeBtn.className   = 'calc-manual-close';
        closeBtn.textContent = '×';
        closeBtn.title       = 'Restore original value';
        closeBtn.addEventListener('click', e => {
            e.stopPropagation();
            const origTd = item._manualOriginTd;
            const origVal = item._manualValSpan?.textContent ?? item.value;
            item.value    = origVal;
            item.originTd = origTd;
            item._manualOriginTd = null;
            _calcExitManualInput(item, td);
            const restoredSpan = td.querySelector('.calc-val');
            if (restoredSpan) restoredSpan.textContent = origVal;
            if (origTd && document.body.contains(origTd)) td.classList.add('has-origin');
            _calcMarkRowInSync(rowData.id);
            _calcCalculateRow(rowData.id, rowEl);
        });

        td.replaceChild(inputEl, valSpan);
        td.appendChild(closeBtn);
        item._manualInputEl  = inputEl;
        item._manualValSpan  = valSpan;
        item._manualCloseBtn = closeBtn;
        item._manualOriginTd = savedOriginTd;
        item.originTd = null;
        td.classList.remove('has-origin');

        _calcApplyRowSyncVisual(rowData, rowEl, 'out-of-sync');

        inputEl.addEventListener('input', () => {
            item.value = inputEl.value !== '' ? inputEl.value : '0';
            _calcCalculateRow(rowData.id, rowEl);
        });
        inputEl.addEventListener('click', e => e.stopPropagation());
        inputEl.addEventListener('contextmenu', e => e.stopPropagation());
        inputEl.focus();
        inputEl.select();
    }

    /**
     * Restore the original value span in a calculus cell, removing the manual input element.
     * Safe to call even if the item has no manual input active.
     */
    function _calcExitManualInput(item, valueCellEl) {
        if (!item._manualInputEl) return;
        const inputEl  = item._manualInputEl;
        const valSpan  = item._manualValSpan;
        const closeBtn = item._manualCloseBtn;
        if (valueCellEl && inputEl.parentNode === valueCellEl) {
            valueCellEl.replaceChild(valSpan, inputEl);
        }
        if (closeBtn && closeBtn.parentNode) closeBtn.parentNode.removeChild(closeBtn);
        item._manualInputEl  = null;
        item._manualValSpan  = null;
        item._manualCloseBtn = null;
        item._manualOriginTd = null;
    }

    /** Briefly highlight a cell in the results table and scroll it into view. */
    function _calcHighlightOriginCell(originTd) {
        if (!originTd || !document.body.contains(originTd)) return; // stale or missing
        document.querySelectorAll('.calculus-origin-highlight')
            .forEach(el => el.classList.remove('calculus-origin-highlight'));
        clearTimeout(_calcOriginTimer);
        originTd.classList.add('calculus-origin-highlight');
        originTd.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        _calcOriginTimer = setTimeout(() => {
            originTd.classList.remove('calculus-origin-highlight');
        }, 2500);
    }

    // -------------------------------------------------------------------------
    // Bind mode — re-link an out-of-sync expression to a new results row
    // -------------------------------------------------------------------------

    /**
     * Extract the visible label text from a results-table <th>.
     * Alias columns wrap the label in <em>; normal columns append a text node
     * (after an optional PK/UQ/IDX badge <span>).
     */
    function _thGetLabel(th) {
        const em = th.querySelector('em');
        if (em) return em.textContent.trim();
        // Walk child nodes in reverse to find the last meaningful text node
        for (let i = th.childNodes.length - 1; i >= 0; i--) {
            const node = th.childNodes[i];
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
                return node.textContent.trim();
            }
        }
        return th.textContent.trim();
    }

    /** Returns true when the sync-all-on-bind checkbox is checked for the active bind-mode row. */
    function _calcIsSyncAllBind() {
        if (_calculusBindModeRowId === null) return false;
        return document.querySelector(
            `.calculus-expr-row[data-row-id="${_calculusBindModeRowId}"] .chk-calculus-sync-all-bind`
        )?.checked ?? false;
    }

    /** Snapshot current item values/originTds for the bind-mode row (and all others if sync-all). */
    function _calcSaveHoverSnapshot() {
        const rowData = _calculusRows.find(r => r.id === _calculusBindModeRowId);
        if (!rowData) return;
        _calcBindHoverSnapshot = rowData.items.map(item => ({ value: item.value, originTd: item.originTd }));

        if (_calcIsSyncAllBind()) {
            _calcBindHoverBroadcastSnapshot = _calculusRows
                .filter(r => r.id !== _calculusBindModeRowId)
                .map(r => ({ id: r.id, items: r.items.map(item => ({ value: item.value, originTd: item.originTd })) }));
        }
    }

    /** Restore item values/originTds from snapshot and refresh the display. */
    function _calcRestoreHoverSnapshot() {
        if (!_calcBindHoverSnapshot) return;

        // Restore bind-mode row
        const rowData = _calculusRows.find(r => r.id === _calculusBindModeRowId);
        if (rowData) {
            const rowEl      = document.querySelector(`.calculus-expr-row[data-row-id="${_calculusBindModeRowId}"]`);
            const valueCells = rowEl ? Array.from(rowEl.querySelectorAll('td.calculus-value')) : [];
            _calcBindHoverSnapshot.forEach((snap, i) => {
                if (!rowData.items[i]) return;
                const item = rowData.items[i];
                item.value    = snap.value;
                item.originTd = snap.originTd;
                if (item._manualInputEl) {
                    item._manualInputEl.value = snap.value;
                } else {
                    const valSpan = valueCells[i]?.querySelector('.calc-val');
                    if (valSpan) valSpan.textContent = snap.value;
                }
            });
            if (rowEl) _calcCalculateRow(_calculusBindModeRowId, rowEl);
        }
        _calcBindHoverSnapshot = null;

        // Restore all other rows if broadcast snapshot exists
        if (_calcBindHoverBroadcastSnapshot) {
            for (const snap of _calcBindHoverBroadcastSnapshot) {
                const rd    = _calculusRows.find(r => r.id === snap.id);
                if (!rd) continue;
                const rowEl      = document.querySelector(`.calculus-expr-row[data-row-id="${snap.id}"]`);
                const valueCells = rowEl ? Array.from(rowEl.querySelectorAll('td.calculus-value')) : [];
                snap.items.forEach((s, i) => {
                    if (!rd.items[i]) return;
                    const item = rd.items[i];
                    item.value    = s.value;
                    item.originTd = s.originTd;
                    if (item._manualInputEl) {
                        item._manualInputEl.value = s.value;
                    } else {
                        const valSpan = valueCells[i]?.querySelector('.calc-val');
                        if (valSpan) valSpan.textContent = s.value;
                    }
                });
                if (rowEl) _calcCalculateRow(snap.id, rowEl);
            }
            _calcBindHoverBroadcastSnapshot = null;
        }
    }

    /** Temporarily apply values from hoveredTr to the bind-mode row (and all others if sync-all). */
    function _calcApplyHoverPreview(hoveredTr) {
        if (_calculusBindModeRowId === null) return;
        const rowData = _calculusRows.find(r => r.id === _calculusBindModeRowId);
        if (!rowData || rowData.items.length === 0) return;

        const resultsTable = hoveredTr.closest('table');
        if (!resultsTable) return;

        const ths        = Array.from(resultsTable.querySelectorAll('thead tr th'));
        const thLabels   = ths.map(th => _thGetLabel(th));
        const colIndices = rowData.items.map(item => thLabels.indexOf(item.headerInfo.label));
        if (colIndices.some(idx => idx === -1)) return; // column mismatch — skip silently

        const resultTds  = Array.from(hoveredTr.querySelectorAll('td'));
        const calcRowEl  = document.querySelector(`.calculus-expr-row[data-row-id="${_calculusBindModeRowId}"]`);
        const valueCells = calcRowEl ? Array.from(calcRowEl.querySelectorAll('td.calculus-value')) : [];

        colIndices.forEach((colIdx, itemIdx) => {
            const item  = rowData.items[itemIdx];
            const newTd = resultTds[colIdx];
            if (!newTd) return;
            item.value    = newTd.dataset.raw ?? newTd.textContent.trim();
            item.originTd = newTd;
            if (item._manualInputEl) {
                item._manualInputEl.value = item.value;
            } else {
                const valSpan = valueCells[itemIdx]?.querySelector('.calc-val');
                if (valSpan) valSpan.textContent = item.value;
            }
        });
        if (calcRowEl) _calcCalculateRow(_calculusBindModeRowId, calcRowEl);

        // Broadcast hover preview to all other rows if sync-all is enabled
        if (_calcIsSyncAllBind()) {
            for (const rd of _calculusRows) {
                if (rd.id === _calculusBindModeRowId) continue;
                const rowEl = document.querySelector(`.calculus-expr-row[data-row-id="${rd.id}"]`);
                _calcBindToTr(rd, rowEl, hoveredTr);
            }
        }
    }

    /** Activate bind mode for the given row: tints it and switches the cursor. */
    function _calcEnterBindMode(rowId) {
        if (_calculusBindModeRowId !== null) _calcExitBindMode(); // drop previous silently
        _calculusBindModeRowId = rowId;
        const rowEl = document.querySelector(`.calculus-expr-row[data-row-id="${rowId}"]`);
        rowEl?.classList.add('is-bind-mode');
        rowEl?.querySelector('.btn-calculus-bind-row')?.classList.add('is-active');
        document.body.classList.add('calculus-bind-cursor');

        // Hover preview — apply calculus temporarily while mousing over results rows
        _calcBindHoverSnapshot = null;
        _calcBindHoverLastTr   = null;
        const wrapper = document.getElementById('results-table-wrapper');
        if (wrapper) {
            const onMove = e => {
                const tr = e.target.closest('tbody tr');
                if (!tr || tr === _calcBindHoverLastTr) return;
                if (!_calcBindHoverSnapshot) _calcSaveHoverSnapshot();
                _calcBindHoverLastTr = tr;
                _calcApplyHoverPreview(tr);
            };
            const onLeave = () => {
                _calcBindHoverLastTr = null;
                _calcRestoreHoverSnapshot();
            };
            wrapper.addEventListener('mouseover', onMove);
            wrapper.addEventListener('mouseleave', onLeave);
            _calcBindHoverHandlers = { wrapper, onMove, onLeave };
        }
    }

    /**
     * Deactivate bind mode.
     * @param {boolean} showFail  When true, flash the row red (column mismatch).
     */
    function _calcExitBindMode(showFail = false) {
        if (_calculusBindModeRowId === null) return;

        // Remove hover preview listeners
        if (_calcBindHoverHandlers) {
            const { wrapper, onMove, onLeave } = _calcBindHoverHandlers;
            wrapper.removeEventListener('mouseover', onMove);
            wrapper.removeEventListener('mouseleave', onLeave);
            _calcBindHoverHandlers = null;
        }
        // Restore snapshots if mid-hover (no-ops if already cleared by a commit click)
        _calcRestoreHoverSnapshot();
        _calcBindHoverBroadcastSnapshot = null;
        _calcBindHoverLastTr = null;

        const prevId = _calculusBindModeRowId;
        _calculusBindModeRowId = null;
        const rowEl = document.querySelector(`.calculus-expr-row[data-row-id="${prevId}"]`);
        if (rowEl) {
            rowEl.classList.remove('is-bind-mode');
            if (showFail) {
                rowEl.classList.add('bind-failed-flash');
                rowEl.addEventListener('animationend',
                    () => rowEl.classList.remove('bind-failed-flash'), { once: true });
                App.notify?.('Column mismatch — could not bind row', 'error');
            }
        }
        rowEl?.querySelector('.btn-calculus-bind-row')?.classList.remove('is-active');
        document.body.classList.remove('calculus-bind-cursor');
    }

    /**
     * Try to re-bind the active bind-mode row to the result row that contains clickedTd.
     * Succeeds only when EVERY item in the expression has a matching column label in the
     * current results table.  On success the values and originTd refs are updated,
     * the row is recalculated, and bind mode is exited.  On failure the row flashes red.
     */
    function _calcTryBind(clickedTd) {
        if (_calculusBindModeRowId === null) return;

        const rowData = _calculusRows.find(r => r.id === _calculusBindModeRowId);
        if (!rowData || rowData.items.length === 0) { _calcExitBindMode(); return; }

        const resultsTable = clickedTd.closest('table');
        if (!resultsTable) { _calcExitBindMode(true); return; }

        // Build a label→colIndex map from the results <thead>
        const ths       = Array.from(resultsTable.querySelectorAll('thead tr th'));
        const thLabels  = ths.map(th => _thGetLabel(th));

        // Every item must have an exact label match in the current results columns
        const colIndices = rowData.items.map(item => thLabels.indexOf(item.headerInfo.label));
        if (colIndices.some(idx => idx === -1)) { _calcExitBindMode(true); return; }

        // Collect all <td>s in the clicked result row
        const resultTds  = Array.from(clickedTd.closest('tr').querySelectorAll('td'));

        // Re-link items: update value + originTd + displayed text
        const calcRowEl  = document.querySelector(`.calculus-expr-row[data-row-id="${_calculusBindModeRowId}"]`);
        const valueCells = calcRowEl
            ? Array.from(calcRowEl.querySelectorAll('td.calculus-value'))
            : [];

        const boundId = _calculusBindModeRowId; // capture before exiting bind mode

        colIndices.forEach((colIdx, itemIdx) => {
            const item    = rowData.items[itemIdx];
            const newTd   = resultTds[colIdx];
            if (!newTd) return;
            const newVal  = newTd.dataset.raw ?? newTd.textContent.trim();
            item.value    = newVal;
            item.originTd = newTd;
            // Refresh the displayed value span and ensure has-origin is set
            const valueCellEl = valueCells[itemIdx];
            if (valueCellEl) {
                _calcExitManualInput(item, valueCellEl);
                const valSpan = valueCellEl.querySelector('.calc-val');
                if (valSpan) valSpan.textContent = newVal;
                valueCellEl.classList.add('has-origin'); // enables alt+click highlight
            }
        });

        // Recalculate and mark in sync
        if (calcRowEl) {
            _calcCalculateRow(boundId, calcRowEl);
            // Brief success flash before sync classes are re-applied
            calcRowEl.classList.add('bind-success-flash');
            calcRowEl.addEventListener('animationend',
                () => calcRowEl.classList.remove('bind-success-flash'), { once: true });
        }
        _calcMarkRowInSync(boundId);
        const broadcastOnCommit = _calcIsSyncAllBind();
        _calcBindHoverSnapshot          = null; // commit — don't restore old values on exit
        _calcBindHoverBroadcastSnapshot = null;
        _calcExitBindMode(); // success — no fail flash
        if (broadcastOnCommit) _calcBroadcastRow(boundId);
    }

    /**
     * Bind a single calculus row to targetTr without requiring a click event.
     * Returns true on success, false if any column label is missing in the results header.
     */
    function _calcBindToTr(rowData, rowEl, targetTr) {
        if (!rowData || rowData.items.length === 0) return false;

        const resultsTable = targetTr.closest('table');
        if (!resultsTable) return false;

        const ths      = Array.from(resultsTable.querySelectorAll('thead tr th'));
        const thLabels = ths.map(th => _thGetLabel(th));

        const colIndices = rowData.items.map(item => thLabels.indexOf(item.headerInfo.label));
        if (colIndices.some(idx => idx === -1)) return false;

        const resultTds  = Array.from(targetTr.querySelectorAll('td'));
        const valueCells = rowEl ? Array.from(rowEl.querySelectorAll('td.calculus-value')) : [];

        colIndices.forEach((colIdx, itemIdx) => {
            const item = rowData.items[itemIdx];
            const newTd = resultTds[colIdx];
            if (!newTd) return;
            item.value    = newTd.dataset.raw ?? newTd.textContent.trim();
            item.originTd = newTd;
            const valueCellEl = valueCells[itemIdx];
            if (valueCellEl) {
                _calcExitManualInput(item, valueCellEl);
                const valSpan = valueCellEl.querySelector('.calc-val');
                if (valSpan) valSpan.textContent = item.value;
                valueCellEl.classList.add('has-origin');
            }
        });

        if (rowEl) _calcCalculateRow(rowData.id, rowEl);
        _calcMarkRowInSync(rowData.id);
        return true;
    }

    /**
     * Re-bind every other expression row to the same result <tr> that sourceId is bound to.
     * Rows whose column labels don't all exist in that <tr> are skipped.
     */
    function _calcBroadcastRow(sourceId) {
        const sourceRowData = _calculusRows.find(r => r.id === sourceId);
        if (!sourceRowData) return;

        // Use the first live originTd as the row reference — works for in-sync and hybrid rows
        const liveTd = sourceRowData.items.find(item => item.originTd && document.body.contains(item.originTd))?.originTd;
        if (!liveTd) return;
        const targetTr = liveTd.closest('tr');
        if (!targetTr) return;

        let bound = 0, skipped = 0;
        for (const rowData of _calculusRows) {
            if (rowData.id === sourceId) continue;
            const rowEl = document.querySelector(`.calculus-expr-row[data-row-id="${rowData.id}"]`);
            if (_calcBindToTr(rowData, rowEl, targetTr)) {
                rowEl?.classList.add('bind-success-flash');
                rowEl?.addEventListener('animationend',
                    () => rowEl.classList.remove('bind-success-flash'), { once: true });
                bound++;
            } else {
                skipped++;
            }
        }

        if (_calculusRows.length <= 1) {
            App.notify?.('No other expressions to sync.', 'warn');
            return;
        }
        const msg = skipped === 0
            ? `Synced ${bound} expression${bound !== 1 ? 's' : ''} to this row`
            : `Synced ${bound}, skipped ${skipped} (column mismatch)`;
        App.notify?.(msg, skipped > 0 ? 'warn' : 'success');
    }

    // -------------------------------------------------------------------------
    // Eval mode — type a SELECT expression, click a row to materialise it
    // -------------------------------------------------------------------------

    /**
     * Tokenise and structurally parse a flat SELECT expression into Calculus items.
     *
     * Supported syntax:
     *   colRef ( op colRef )*          — simple chain
     *   ( colRef op colRef ) op colRef — one level of grouping with ( )
     *
     * Returns { items: [{col, binaryOp, openParen, closeParen}] }
     *      or { error: string }
     */
    function _calcParseExpr(input) {
        // ---- Tokenise ----
        const tokens = [];
        let i = 0;
        while (i < input.length) {
            const ch = input[i];
            if (/\s/.test(ch))          { i++; continue; }
            if (ch === '(')             { tokens.push({ t: '(' }); i++; continue; }
            if (ch === ')')             { tokens.push({ t: ')' }); i++; continue; }
            if ('+-*/%'.includes(ch))   { tokens.push({ t: 'op', v: ch }); i++; continue; }
            if (/[A-Za-z_]/.test(ch)) {
                const m = input.slice(i).match(/^[A-Za-z_][\w.]*/);
                if (m) { tokens.push({ t: 'col', v: m[0] }); i += m[0].length; continue; }
            }
            return { error: `Unexpected character "${ch}" at position ${i + 1}` };
        }
        if (tokens.length === 0) return { error: 'Expression is empty' };

        // ---- Balanced-paren check ----
        let depth = 0;
        for (const tok of tokens) {
            if (tok.t === '(') depth++;
            if (tok.t === ')') { depth--; if (depth < 0) return { error: 'Unbalanced parentheses' }; }
        }
        if (depth !== 0) return { error: 'Unbalanced parentheses' };

        // ---- Structural parse ----
        // Leading unary operators are not supported (prefix select only has + / nop).
        // Grammar: item ( op item )*   where item = '('? colRef ')'?
        let pos = 0;
        const items = [];
        const peek  = () => (pos < tokens.length ? tokens[pos] : null);
        const next  = () => tokens[pos++];

        while (pos < tokens.length) {
            let binaryOp   = null;
            let openParen  = false;
            let closeParen = false;

            if (items.length > 0) {
                const opTok = peek();
                if (!opTok || opTok.t !== 'op')
                    return { error: items.length === 0
                        ? 'Expression must start with a column name (leading unary operators are not supported)'
                        : `Expected operator before token ${pos + 1}` };
                binaryOp = next().v;
            }

            if (peek()?.t === '(') { openParen = true; next(); }

            const colTok = peek();
            if (!colTok || colTok.t !== 'col')
                return { error: items.length === 0
                    ? 'Expression must start with a column name (leading unary operators are not supported)'
                    : `Expected column name at token ${pos + 1}` };
            const col = next().v;

            if (peek()?.t === ')') { closeParen = true; next(); }

            items.push({ col, binaryOp, openParen, closeParen });
        }

        if (items.length === 0) return { error: 'No column references found' };
        return { items };
    }

    /** Build a headerInfo object from a results-table <th> element. */
    function _headerInfoFromTh(th) {
        return {
            label:        _thGetLabel(th),
            origin:       th.title || '',
            isAlias:      th.classList.contains('th-alias'),
            isCustomExpr: th.classList.contains('th-custom-expr'),
            colKey:       th.dataset.colKey || '',
        };
    }

    /**
     * Find the index of the th whose label best matches colName.
     * Tries: exact → case-insensitive → column-part-only (after last dot).
     */
    function _findThIndexByLabel(ths, colName) {
        const labels = ths.map(th => _thGetLabel(th));
        let idx = labels.findIndex(l => l === colName);
        if (idx !== -1) return idx;
        idx = labels.findIndex(l => l.toLowerCase() === colName.toLowerCase());
        if (idx !== -1) return idx;
        const part = colName.split('.').pop().toLowerCase();
        return labels.findIndex(l => l.split('.').pop().toLowerCase() === part);
    }

    /**
     * Enter Eval mode: collapse the toolbox to its title bar only and switch cursor.
     * Current inline size/position is saved so it can be restored exactly on exit.
     */
    function _calcEnterEvalMode(items, expr) {
        _calculusEvalMode  = true;
        _calculusEvalItems = items;
        _calculusEvalExpr  = expr;

        const toolbox = document.getElementById('calculus-toolbox');
        // Snapshot current inline styles (mirrors the maximize save pattern)
        _calcEvalPreStyles = {
            top: toolbox.style.top, left: toolbox.style.left,
            right: toolbox.style.right, bottom: toolbox.style.bottom,
            width: toolbox.style.width, height: toolbox.style.height,
            transform: toolbox.style.transform,
            maxWidth: toolbox.style.maxWidth, maxHeight: toolbox.style.maxHeight,
        };
        toolbox.classList.add('is-eval-minimized');
        document.body.classList.add('calculus-bind-cursor');
    }

    /**
     * Exit Eval mode: restore the toolbox to its pre-eval size/position and cursor.
     * (When called from _toggleCalculusMode the toolbox is re-hidden by that function.)
     */
    function _calcExitEvalMode() {
        if (!_calculusEvalMode) return;
        _calculusEvalMode        = false;
        _calculusEvalItems       = null;
        _calculusEvalExpr        = '';
        _calculusEvalTargetRowId = null;
        _calculusEvalTargetName  = null;
        document.body.classList.remove('calculus-bind-cursor');

        const toolbox = document.getElementById('calculus-toolbox');
        toolbox.classList.remove('is-eval-minimized');
        if (_calcEvalPreStyles) {
            Object.assign(toolbox.style, _calcEvalPreStyles);
            _calcEvalPreStyles = null;
        }
    }

    /**
     * Apply the parsed Eval expression to the result row that contains clickedTd.
     * Creates a new Calculus row, adds cells, sets operators + parens, names the row.
     * On column mismatch: exits eval mode and notifies the user.
     */
    function _calcApplyEval(clickedTd) {
        if (!_calculusEvalMode || !_calculusEvalItems) { _calcExitEvalMode(); return; }

        const resultsTable = clickedTd.closest('table');
        if (!resultsTable) { _calcExitEvalMode(); return; }

        const ths  = Array.from(resultsTable.querySelectorAll('thead tr th'));
        const tds  = Array.from(clickedTd.closest('tr').querySelectorAll('td'));
        const items = _calculusEvalItems;
        const expr  = _calculusEvalExpr;

        // Re-validate in case results were re-rendered after the prompt
        const colIndices = items.map(item => _findThIndexByLabel(ths, item.col));
        if (colIndices.some(idx => idx === -1)) {
            _calcExitEvalMode(); // restores toolbox
            App.notify?.('Some columns no longer exist in the results table — expression not applied.', 'error');
            return;
        }

        // Capture load-mode state before exiting eval mode clears it
        const targetRowId   = _calculusEvalTargetRowId;
        const targetRowName = _calculusEvalTargetName;

        // Exit eval mode first so the toolbox is already visible while we build the row
        _calcExitEvalMode();

        let rowId, calcRowEl;
        if (targetRowId !== null) {
            // Load mode: replace the existing row in-place
            rowId     = targetRowId;
            calcRowEl = document.querySelector(`.calculus-expr-row[data-row-id="${rowId}"]`);
            if (!calcRowEl) return;
            const existingRowData = _calculusRows.find(r => r.id === rowId);
            if (!existingRowData) return;
            _calcClearRowContent(existingRowData, calcRowEl);
            _calcSetActiveRow(rowId);
        } else {
            // Normal eval mode: create a new row
            _calcAddRow();
            rowId     = _calculusActiveId;
            calcRowEl = document.querySelector(`.calculus-expr-row[data-row-id="${rowId}"]`);
        }

        colIndices.forEach((thIdx) => {
            const originTd   = tds[thIdx];
            const headerInfo = _headerInfoFromTh(ths[thIdx]);
            const value      = originTd.dataset.raw ?? originTd.textContent.trim();
            _calcAddCell(headerInfo, value, originTd);
        });

        // Set operator selects (dispatching 'change' also updates mirror text + recalculates)
        const opSelects = Array.from(calcRowEl.querySelectorAll('.calculus-op-select'));
        items.forEach((item, i) => {
            if (i === 0) return; // no operator before the first item
            const sel = opSelects[i - 1];
            if (!sel) return;
            sel.value = item.binaryOp || '+';
            sel.dispatchEvent(new Event('change'));
        });

        // Apply paren states: update data model + activate the paren buttons in the DOM
        const rowData    = _calculusRows.find(r => r.id === rowId);
        const valueCells = Array.from(calcRowEl.querySelectorAll('td.calculus-value'));
        let   parensSet  = false;
        items.forEach((parsedItem, i) => {
            const calcItem = rowData?.items[i];
            const vcell    = valueCells[i];
            if (!calcItem || !vcell) return;
            if (parsedItem.openParen) {
                calcItem.openParen = true;
                vcell.querySelector('.calc-paren-o')?.classList.add('is-active');
                parensSet = true;
            }
            if (parsedItem.closeParen) {
                calcItem.closeParen = true;
                vcell.querySelector('.calc-paren-c')?.classList.add('is-active');
                parensSet = true;
            }
        });

        // Re-calculate once with parens applied (operator change events already ran)
        if (parensSet) _calcCalculateRow(rowId, calcRowEl);

        // Name the row: use the saved title in load mode, otherwise the typed expression
        const nameInput = calcRowEl.querySelector('.calculus-expr-name');
        if (nameInput) nameInput.value = targetRowName !== null ? targetRowName : expr;

        // If the title is a comparison expression, apply it now (the name was just set
        // programmatically so the 'input' listener didn't fire, and the earlier calculate
        // calls ran before the name was written).
        _calcCheckTitleComparison(rowId, calcRowEl);

        // Reset history after programmatic setup: operator-change events fired above
        // each call _calcHistoryAppend, producing phantom entries. Reset once here so
        // history starts clean with just the header + initial value row.
        if (rowData) _calcHistoryReset(rowData, calcRowEl);
    }

    /** Add a cell (headerInfo + value) to the currently active expression row. */
    function _calcAddCell(headerInfo, value, originTd = null) {
        // If no active row exists yet, create one
        if (_calculusActiveId === null || !_calculusRows.find(r => r.id === _calculusActiveId)) {
            _calcAddRow();
        }

        const rowData = _calculusRows.find(r => r.id === _calculusActiveId);
        if (!rowData) return;
        rowData.items.push({ headerInfo, value, originTd, openParen: false, closeParen: false });
        const item = rowData.items[rowData.items.length - 1];

        const rowEl    = document.querySelector(`.calculus-expr-row[data-row-id="${_calculusActiveId}"]`);
        const theadRow = rowEl.querySelector('thead tr');
        const tbodyRow = rowEl.querySelector('tbody tr');

        rowEl.querySelector('.calculus-expr-hint').classList.add('hidden');
        rowEl.querySelector('.calculus-expr-table-wrap').classList.remove('hidden');
        rowEl.querySelector('.calculus-expr-footer').classList.remove('hidden');

        // Helper: build an operator <th>/<td> pair, inserting before the RESULT column
        const _makeOpCol = () => {
            const opTh = document.createElement('th');
            opTh.className = 'calculus-op-col';
            const sel = document.createElement('select');
            sel.className = 'calculus-op-select';
            sel.title = 'Operation';
            ['+', '−', '×', '÷', '%', 'nop'].forEach((label, i) => {
                const opt = document.createElement('option');
                opt.value = ['+', '-', '*', '/', '%', 'nop'][i];
                opt.textContent = label;
                sel.appendChild(opt);
            });
            opTh.appendChild(sel);
            theadRow.insertBefore(opTh, rowEl._resultTh);

            const opTd = document.createElement('td');
            opTd.className = 'calculus-op-col calculus-op-mirror';
            opTd.textContent = '+';
            sel.addEventListener('change', () => {
                const isNop = sel.value === 'nop';
                opTd.textContent = sel.options[sel.selectedIndex].textContent;
                opTd.classList.toggle('calculus-op-nop', isNop);

                // Find which operator index this select is, then toggle .calc-nop
                // on the <td> and <th> of the column immediately to its right.
                const allSelects   = Array.from(rowEl.querySelectorAll('.calculus-op-select'));
                const allValueTds  = Array.from(rowEl.querySelectorAll('tbody  tr td.calculus-value'));
                const allHeaderThs = Array.from(rowEl.querySelectorAll('thead  tr th'))
                                         .filter(th => !th.classList.contains('calculus-op-col') && th !== rowEl._resultTh);
                const opIdx = allSelects.indexOf(sel);
                if (allValueTds[opIdx + 1])  allValueTds[opIdx + 1].classList.toggle('calc-nop', isNop);
                if (allHeaderThs[opIdx + 1]) allHeaderThs[opIdx + 1].classList.toggle('calc-nop', isNop);

                // Auto-recalculate immediately
                const _opRowId = Number(rowEl.dataset.rowId);
                _calcCalculateRow(_opRowId, rowEl);
                // Append operator-change snapshot to history
                const _opRowData = _calculusRows.find(r => r.id === _opRowId);
                if (_opRowData) _calcHistoryAppend(_opRowData, rowEl);
            });
            tbodyRow.insertBefore(opTd, rowEl._resultTd);
            return { opTh, opTd };
        };

        // Build the <th> the same way _populateTable does
        const th = document.createElement('th');
        th.classList.add('calculus-col-th');
        th.title = headerInfo.label + (headerInfo.origin ? `\n${headerInfo.origin}` : '');
        if (headerInfo.isCustomExpr) {
            th.classList.add('th-custom-expr');
            th.appendChild(document.createTextNode(headerInfo.label));
        } else if (headerInfo.isAlias) {
            th.classList.add('th-alias');
            const em = document.createElement('em');
            em.textContent = headerInfo.label;
            th.appendChild(em);
        } else {
            th.appendChild(document.createTextNode(headerInfo.label));
        }
        if (headerInfo.origin) {
            const originSpan = document.createElement('span');
            originSpan.className   = 'th-table-origin';
            originSpan.textContent = headerInfo.origin;
            th.appendChild(originSpan);
        }
        const delBtn = document.createElement('button');
        delBtn.className   = 'btn-calc-col-delete';
        delBtn.textContent = '×';
        delBtn.title       = 'Remove this column';
        delBtn.addEventListener('click', e => {
            e.stopPropagation();
            const currentRowData = _calculusRows.find(r => r.id === _calculusActiveId || r.items.includes(item));
            if (!currentRowData) return;
            const currentRowEl = document.querySelector(`.calculus-expr-row[data-row-id="${currentRowData.id}"]`);
            if (!currentRowEl) return;
            const idx = currentRowData.items.indexOf(item);
            if (idx !== -1) _calcDeleteCell(currentRowData, currentRowEl, idx);
        });
        th.appendChild(delBtn);

        th.draggable = true;
        th.addEventListener('dragstart', e => {
            _calcColDragSrcItem  = item;
            _calcColDragSrcRowId = rowData.id;
            e.dataTransfer.setData('text/x-calc-col', '1');
            e.dataTransfer.effectAllowed = 'move';
            setTimeout(() => th.classList.add('calc-col-dragging'), 0);
        });
        th.addEventListener('dragend', () => {
            th.classList.remove('calc-col-dragging');
            _calcColDragSrcItem  = null;
            _calcColDragSrcRowId = null;
            document.querySelectorAll('.calc-col-drag-over')
                    .forEach(el => el.classList.remove('calc-col-drag-over'));
        });
        th.addEventListener('dragover', e => {
            if (_calcColDragSrcRowId !== rowData.id || _calcColDragSrcItem === item) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            th.classList.add('calc-col-drag-over');
        });
        th.addEventListener('dragleave', () => th.classList.remove('calc-col-drag-over'));
        th.addEventListener('drop', e => {
            e.preventDefault();
            th.classList.remove('calc-col-drag-over');
            if (_calcColDragSrcRowId !== rowData.id || !_calcColDragSrcItem || _calcColDragSrcItem === item) return;
            const rd  = _calculusRows.find(r => r.items.includes(item));
            if (!rd) return;
            const rel = document.querySelector(`.calculus-expr-row[data-row-id="${rd.id}"]`);
            if (!rel) return;
            const srcIdx = rd.items.indexOf(_calcColDragSrcItem);
            const dstIdx = rd.items.indexOf(item);
            if (srcIdx === -1 || dstIdx === -1 || srcIdx === dstIdx) return;
            _calcSwapCells(rd, rel, srcIdx, dstIdx);
        });

        const td = document.createElement('td');
        td.className = 'calculus-value';
        td.title = 'Click to copy · Right-click to add to Math · Alt+click to highlight · Alt+right-click for manual input';
        td.addEventListener('click', e => {
            if (e.target.classList.contains('calc-paren')) return;
            if (e.altKey) {
                _calcEnterManualInput(item, td, rowData, rowEl);
                return;
            }
            // Always read from item.value so rebinds are reflected immediately
            navigator.clipboard.writeText(item.value)
                .then(() => App.notify?.('Value copied', 'success'))
                .catch(() => App.notify?.('Copy failed — check clipboard permissions', 'error'));
        });
        td.addEventListener('contextmenu', e => {
            if (e.target.classList.contains('calc-paren')) return;
            e.preventDefault();
            if (e.altKey) {
                // Always read from item.originTd so rebinds are reflected immediately
                if (item.originTd) _calcHighlightOriginCell(item.originTd);
                return;
            }
            const allValueTds = Array.from(rowEl.querySelectorAll('tbody tr td.calculus-value'));
            const allSelects  = Array.from(rowEl.querySelectorAll('.calculus-op-select'));
            const tdIdx = allValueTds.indexOf(td);
            const mathPopup = document.getElementById('calculus-math-popup');
            const mathInput = document.getElementById('calculus-math-input');
            if (mathPopup.classList.contains('hidden'))
                document.getElementById('btn-calculus-math').click();
            let append = String(item.value); // read live from item so rebinds are reflected
            if (tdIdx > 0) {
                const opVal = allSelects[tdIdx - 1]?.value;
                append = (opVal && opVal !== 'nop') ? (' ' + opVal + ' ' + append) : (' ' + append);
            } else {
                if (mathInput.value) append = ' + ' + append;
            }
            mathInput.value = mathInput.value ? mathInput.value + append : append;
            mathInput.dispatchEvent(new Event('input', { bubbles: true })); // refresh backdrop
            mathInput.scrollTop = mathInput.scrollHeight; // scroll to show appended content
            mathInput.focus();
        });
        if (originTd) {
            td.classList.add('has-origin');
            _calcMarkRowInSync(_calculusActiveId); // row now references current results
        }

        const btnOpen = document.createElement('button');
        btnOpen.className   = 'calc-paren calc-paren-o';
        btnOpen.textContent = '(';
        btnOpen.title       = 'Toggle opening parenthesis before this value';
        btnOpen.addEventListener('click', e => {
            e.stopPropagation();
            item.openParen = !item.openParen;
            btnOpen.classList.toggle('is-active', item.openParen);
            const opens  = rowData.items.filter(it => it.openParen).length;
            const closes = rowData.items.filter(it => it.closeParen).length;
            if (opens === closes) _calcCalculateRow(rowData.id, rowEl);
            else _calcClearRowResult(rowEl);
        });

        const valSpan = document.createElement('span');
        valSpan.className   = 'calc-val';
        valSpan.textContent = value;

        const btnClose = document.createElement('button');
        btnClose.className   = 'calc-paren calc-paren-c';
        btnClose.textContent = ')';
        btnClose.title       = 'Toggle closing parenthesis after this value';
        btnClose.addEventListener('click', e => {
            e.stopPropagation();
            item.closeParen = !item.closeParen;
            btnClose.classList.toggle('is-active', item.closeParen);
            const opens  = rowData.items.filter(it => it.openParen).length;
            const closes = rowData.items.filter(it => it.closeParen).length;
            if (opens === closes) _calcCalculateRow(rowData.id, rowEl);
            else _calcClearRowResult(rowEl);
        });

        td.appendChild(btnOpen);
        td.appendChild(valSpan);
        td.appendChild(btnClose);

        item._th = th;
        item._td = td;

        if (rowData.items.length === 1) {
            // First cell: append data, then create the RESULT column
            theadRow.appendChild(th);
            tbodyRow.appendChild(td);

            const resultTh = document.createElement('th');
            resultTh.className   = 'calculus-result-th';
            resultTh.textContent = 'RESULT';
            theadRow.appendChild(resultTh);
            rowEl._resultTh = resultTh;

            const resultTd = document.createElement('td');
            resultTd.className   = 'calculus-result-td';
            resultTd.textContent = '—';
            tbodyRow.appendChild(resultTd);
            rowEl._resultTd = resultTd;

            // Prefix operator column — appears before the first data column.
            // Only offers 'nop' (disable) since arithmetic before a leading operand
            // is meaningless; the neutral default means "include this column".
            const prefixTh  = document.createElement('th');
            prefixTh.className = 'calculus-op-col calculus-prefix-col';
            const prefixSel = document.createElement('select');
            prefixSel.className = 'calculus-prefix-select';
            prefixSel.title     = 'Disable / enable first column';
            [{ v: '',    l: '+'   },
             { v: 'nop', l: 'nop' }].forEach(({ v, l }) => {
                const opt = document.createElement('option');
                opt.value = v; opt.textContent = l;
                prefixSel.appendChild(opt);
            });
            prefixTh.appendChild(prefixSel);
            theadRow.insertBefore(prefixTh, theadRow.firstChild);

            const prefixTd  = document.createElement('td');
            prefixTd.className = 'calculus-op-col calculus-op-mirror calculus-prefix-col';
            prefixTd.textContent = '+';
            prefixSel.addEventListener('change', () => {
                const isNop = prefixSel.value === 'nop';
                prefixTd.textContent = isNop ? 'nop' : '+';
                prefixTd.classList.toggle('calculus-op-nop', isNop);
                // Toggle .calc-nop on the first data <td> and <th>
                const firstValTd = rowEl.querySelector('tbody tr td.calculus-value');
                const firstValTh = Array.from(rowEl.querySelectorAll('thead tr th'))
                    .find(th => !th.classList.contains('calculus-op-col') && th !== rowEl._resultTh);
                firstValTd?.classList.toggle('calc-nop', isNop);
                firstValTh?.classList.toggle('calc-nop', isNop);
                const _pfxRowId   = Number(rowEl.dataset.rowId);
                _calcCalculateRow(_pfxRowId, rowEl);
                const _pfxRowData = _calculusRows.find(r => r.id === _pfxRowId);
                if (_pfxRowData) _calcHistoryAppend(_pfxRowData, rowEl);
            });
            tbodyRow.insertBefore(prefixTd, tbodyRow.firstChild);
            rowEl._prefixSel = prefixSel;
            rowEl._prefixTh  = prefixTh;
            rowEl._prefixTd  = prefixTd;
        } else {
            // Subsequent cells: insert op + data columns before RESULT
            const { opTh, opTd } = _makeOpCol();
            item._opTh = opTh;
            item._opTd = opTd;
            theadRow.insertBefore(th, rowEl._resultTh);
            tbodyRow.insertBefore(td, rowEl._resultTd);
        }

        // Auto-calculate now that a new cell has been added
        _calcCalculateRow(_calculusActiveId, rowEl);
        // Reset history so the header always reflects the current column set
        _calcHistoryReset(rowData, rowEl);

        // Show "to WHERE" only when every cell originates from the same results row
        _calcUpdateToWhereBtn(rowEl, rowData);
    }

    /** Delete a single expression row. */
    function _calcDeleteRow(id, rowEl) {
        if (_calculusBindModeRowId === id) _calcExitBindMode(); // silent exit — row is gone
        _calcClearHighlightForId(id);
        _calcHighlightActiveIds.delete(id);
        _calculusRows = _calculusRows.filter(r => r.id !== id);
        rowEl.remove();
        _dimRefreshModeIfDimmed();

        if (_calculusActiveId === id) {
            if (_calculusRows.length > 0) {
                _calcSetActiveRow(_calculusRows[_calculusRows.length - 1].id);
            } else {
                _calculusActiveId = null;
                document.getElementById('calculus-hint').classList.remove('hidden');
            }
        }
    }

    /** Remove a single column (item) from a calculus expression row. */
    function _calcDeleteCell(rowData, rowEl, itemIdx) {
        const items    = rowData.items;
        const item     = items[itemIdx];
        const theadRow = rowEl.querySelector('thead tr');
        const tbodyRow = rowEl.querySelector('tbody tr');

        if (items.length === 1) {
            // Last cell — reset the row to its empty state
            while (theadRow.firstChild) theadRow.removeChild(theadRow.firstChild);
            while (tbodyRow.firstChild) tbodyRow.removeChild(tbodyRow.firstChild);
            rowEl._resultTh  = null;
            rowEl._resultTd  = null;
            rowEl._prefixSel = null;
            rowEl._prefixTh  = null;
            rowEl._prefixTd  = null;
            rowData.items    = [];
            rowEl.querySelector('.calculus-expr-hint').classList.remove('hidden');
            rowEl.querySelector('.calculus-expr-table-wrap').classList.add('hidden');
            rowEl.querySelector('.calculus-expr-footer').classList.add('hidden');
            _calcClearRowResult(rowEl);
            return;
        }

        if (itemIdx === 0) {
            // Remove prefix columns
            rowEl._prefixTh?.remove();
            rowEl._prefixTd?.remove();
            rowEl._prefixSel = null;
            rowEl._prefixTh  = null;
            rowEl._prefixTd  = null;
            // Remove this item's th/td
            item._th.remove();
            item._td.remove();
            // Remove the op that was between items[0] and items[1] — now the new first has no preceding op
            const nextItem = items[1];
            nextItem._opTh?.remove();
            nextItem._opTd?.remove();
            nextItem._opTh = null;
            nextItem._opTd = null;
        } else {
            // Remove the op column preceding this item, then the item's th/td
            item._opTh?.remove();
            item._opTd?.remove();
            item._th.remove();
            item._td.remove();
        }

        items.splice(itemIdx, 1);
        _calcCalculateRow(rowData.id, rowEl);
        _calcHistoryReset(rowData, rowEl);
        _calcUpdateToWhereBtn(rowEl, rowData);
    }

    /** Swap two DOM nodes in the same parent, regardless of relative order. */
    function _swapDomNodes(a, b) {
        if (!a || !b || a === b) return;
        const aNext = a.nextSibling;
        const bNext = b.nextSibling;
        const parent = a.parentNode;
        if      (aNext === b) parent.insertBefore(b, a);
        else if (bNext === a) parent.insertBefore(a, b);
        else { parent.insertBefore(b, aNext); parent.insertBefore(a, bNext); }
    }

    /**
     * Swap two consecutive DOM node pairs [a1,a2] and [b1,b2] in the same parent.
     * Each pair must be consecutive in the DOM; the pairs can be in either relative order.
     */
    function _swapDomNodePair(parent, a1, a2, b1, b2) {
        if (!a1 || !a2 || !b1 || !b2) return;
        const afterB2 = b2.nextSibling; // save before any mutation
        if (a2.nextSibling === b1) {
            // Adjacent: [a1, a2, b1, b2]
            parent.insertBefore(b1, a1);
            parent.insertBefore(b2, a1);
        } else if (b2.nextSibling === a1) {
            // Adjacent reversed: [b1, b2, a1, a2]
            parent.insertBefore(a1, b1);
            parent.insertBefore(a2, b1);
        } else {
            // Non-adjacent (handles both a-before-b and b-before-a)
            parent.insertBefore(b1, a1);
            parent.insertBefore(b2, a1);
            parent.insertBefore(a1, afterB2);
            parent.insertBefore(a2, afterB2);
        }
    }

    /** Recompute and apply .calc-nop classes to all data th/td in a calculus row. */
    function _calcRefreshNopClasses(rowEl) {
        const allSelects   = Array.from(rowEl.querySelectorAll('.calculus-op-select'));
        const allValueTds  = Array.from(rowEl.querySelectorAll('tbody tr td.calculus-value'));
        const allHeaderThs = Array.from(rowEl.querySelectorAll('thead tr th'))
                                 .filter(t => !t.classList.contains('calculus-op-col') && t !== rowEl._resultTh);
        allValueTds.forEach(td => td.classList.remove('calc-nop'));
        allHeaderThs.forEach(t  => t.classList.remove('calc-nop'));
        const prefixNopd = rowEl._prefixSel?.value === 'nop';
        allValueTds[0]?.classList.toggle('calc-nop', prefixNopd);
        allHeaderThs[0]?.classList.toggle('calc-nop', prefixNopd);
        allSelects.forEach((sel, i) => {
            const nop = sel.value === 'nop';
            allValueTds[i + 1]?.classList.toggle('calc-nop', nop);
            allHeaderThs[i + 1]?.classList.toggle('calc-nop', nop);
        });
    }

    /**
     * Swap two calculus columns (by item index).
     * For non-zero pairs: the entire block (op + data) moves together.
     * For swaps involving item[0]: only data columns move (prefix stays put).
     */
    function _calcSwapCells(rowData, rowEl, srcIdx, dstIdx) {
        const items   = rowData.items;
        const srcItem = items[srcIdx];
        const dstItem = items[dstIdx];

        // Save op references before any mutation
        const srcOpTh = srcItem._opTh;
        const srcOpTd = srcItem._opTd;
        const dstOpTh = dstItem._opTh;
        const dstOpTd = dstItem._opTd;

        // Swap in the items array
        items[srcIdx] = dstItem;
        items[dstIdx] = srcItem;

        const theadRow = rowEl.querySelector('thead tr');
        const tbodyRow = rowEl.querySelector('tbody tr');

        if (srcIdx > 0 && dstIdx > 0) {
            // Block swap: op column travels with its data column
            _swapDomNodePair(theadRow, srcOpTh, srcItem._th, dstOpTh, dstItem._th);
            _swapDomNodePair(tbodyRow, srcOpTd, srcItem._td, dstOpTd, dstItem._td);
            // _opTh/_opTd refs are automatically correct: each item moved with its own op
        } else {
            // Item[0] (prefix) is involved — swap data th/td only; prefix stays in place
            _swapDomNodes(srcItem._th, dstItem._th);
            _swapDomNodes(srcItem._td, dstItem._td);
            // Fix _opTh/_opTd: the new item[0] uses the prefix (no _opTh); the other
            // keeps the non-prefix op that was always at that DOM position
            items[0]._opTh = null;
            items[0]._opTd = null;
            const otherIdx = srcIdx === 0 ? dstIdx : srcIdx;
            items[otherIdx]._opTh = dstOpTh ?? srcOpTh; // whichever was the non-prefix op
            items[otherIdx]._opTd = dstOpTd ?? srcOpTd;
            _calcRefreshNopClasses(rowEl);
        }

        _calcCalculateRow(rowData.id, rowEl);
        _calcHistoryReset(rowData, rowEl);
        _calcUpdateToWhereBtn(rowEl, rowData);
    }

    /** Clear every expression row and remove any origin highlights from the results table. */
    function _calcClearAll() {
        _calcExitBindMode(); // silent exit before DOM is wiped
        _calcExitEvalMode(); // exit eval mode if active (toolbox stays open via classList.remove)
        // Clear all row highlights before wiping rows
        _calcHighlightActiveIds.forEach(id => _calcClearHighlightForId(id));
        _calcHighlightActiveIds = new Set();
        _calculusRows     = [];
        _calculusActiveId = null;
        _calculusNextId   = 1;
        clearTimeout(_calcOriginTimer);
        document.querySelectorAll('.calculus-origin-highlight')
            .forEach(el => el.classList.remove('calculus-origin-highlight'));
        document.getElementById('calculus-rows-container').innerHTML = '';
        document.getElementById('calculus-hint').classList.remove('hidden');
        _calcMarkInSync();
        _dimRefreshModeIfDimmed();
    }

    /**
     * Evaluate a title comparison string against a numeric value.
     * labelValMap: { [label: string]: number } — used to resolve column-label RHS references.
     * Returns: true | false | null (null = title is plain text / unrecognised condition).
     */
    function _calcEvalTitle(title, numVal, labelValMap, colKeyValMap) {
        if (!title.trim()) return null;

        // ── Helper: substitute column labels + resolve ABS(), evaluate numerically ──
        const _evalExpr = exprStr => {
            let expr = exprStr;
            // Replace {alias.column} references first (explicit colKey syntax)
            if (colKeyValMap && Object.keys(colKeyValMap).length) {
                expr = expr.replace(/\{([\w.]+)\}/g, (match, key) => {
                    const val = colKeyValMap[key];
                    return val !== undefined ? String(val) : match;
                });
            }
            if (labelValMap && Object.keys(labelValMap).length) {
                const sorted = Object.keys(labelValMap).sort((a, b) => b.length - a.length);
                sorted.forEach(label => {
                    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const re = new RegExp(`(?<![\\w.])${escaped}(?![\\w.])`, 'g');
                    expr = expr.replace(re, String(labelValMap[label]));
                });
            }
            expr = expr.replace(/\bABS\s*\(/gi, 'Math.abs(');
            const stripped = expr.replace(/Math\.abs/g, '');
            if (!/^[\d\s+\-*/%.()]+$/.test(stripped)) return null;
            try {
                const v = new Function(`return (${expr})`)();
                return (typeof v === 'number' && isFinite(v)) ? v : null;
            } catch { return null; }
        };

        // ── Parse and evaluate one condition against numVal ──────────────────────
        const _evalCondition = cond => {
            cond = cond.trim();
            if (!cond) return null;
            let op, rhsStr;
            const notInMatch = cond.match(/^not\s+in\s*\((.+)\)\s*$/i);
            const inMatch    = cond.match(/^in\s*\((.+)\)\s*$/i);
            if      (notInMatch)            { op = 'NOT IN'; rhsStr = notInMatch[1].trim(); }
            else if (inMatch)               { op = 'IN';     rhsStr = inMatch[1].trim(); }
            else if (cond.startsWith('<=')) { op = '<=';     rhsStr = cond.slice(2).trim(); }
            else if (cond.startsWith('>=')) { op = '>=';     rhsStr = cond.slice(2).trim(); }
            else if (cond.startsWith('!=')) { op = '!=';     rhsStr = cond.slice(2).trim(); }
            else if (cond.startsWith('<'))  { op = '<';      rhsStr = cond.slice(1).trim(); }
            else if (cond.startsWith('>'))  { op = '>';      rhsStr = cond.slice(1).trim(); }
            else if (cond.startsWith('='))  { op = '=';      rhsStr = cond.slice(1).trim(); }
            else return null;
            if (!rhsStr) return null;
            if (op === 'IN' || op === 'NOT IN') {
                const values = [];
                for (const raw of rhsStr.split(',')) {
                    const v = _evalExpr(raw.trim());
                    if (v === null) return null;
                    values.push(v);
                }
                if (!values.length) return null;
                const found = values.includes(numVal);
                return op === 'IN' ? found : !found;
            }
            const rhs = _evalExpr(rhsStr);
            if (rhs === null) return null;
            return op === '='  ? numVal === rhs
                 : op === '!=' ? numVal !== rhs
                 : op === '<=' ? numVal <= rhs
                 : op === '>=' ? numVal >= rhs
                 : op === '<'  ? numVal <  rhs
                 :               numVal >  rhs;
        };

        // ── Paren-aware split on AND / OR keywords ───────────────────────────────
        const _splitLogical = str => {
            const parts = [];
            let depth = 0, segStart = 0, segOp = null;
            const up = str.toUpperCase();
            for (let i = 0; i < str.length; i++) {
                if (str[i] === '(') { depth++; continue; }
                if (str[i] === ')') { depth--; continue; }
                if (depth !== 0) continue;
                const prevSpace = i === 0 || /\s/.test(str[i - 1]);
                if (!prevSpace) continue;
                let kw = null;
                if (up.slice(i, i + 4) === 'AND ') kw = 'AND';
                else if (up.slice(i, i + 3) === 'OR ') kw = 'OR';
                if (!kw) continue;
                parts.push({ op: segOp, cond: str.slice(segStart, i).trim() });
                segOp = kw;
                i += kw.length;
                while (i < str.length && str[i] === ' ') i++;
                segStart = i;
                i--;
            }
            parts.push({ op: segOp, cond: str.slice(segStart).trim() });
            return parts.filter(p => p.cond);
        };

        const tokens = _splitLogical(title);
        if (!tokens.length) return null;
        const results = tokens.map(t => ({ op: t.op, val: _evalCondition(t.cond) }));
        if (results.some(r => r.val === null)) return null;
        const orGroups = [[]];
        for (const r of results) {
            if (r.op === 'OR') orGroups.push([r]);
            else               orGroups[orGroups.length - 1].push(r);
        }
        return orGroups.some(group => group.every(r => r.val === true));
    }

    /**
     * Inspect the title input for one or more comparison conditions joined by AND / OR.
     * Colours the result span green (.calc-result-pass) or red (.calc-result-fail).
     */
    function _calcCheckTitleComparison(id, rowEl) {
        const resultEl = rowEl?.querySelector('.calculus-expr-result');
        if (!resultEl) return;
        resultEl.classList.remove('calc-result-pass', 'calc-result-fail');

        const title = rowEl.querySelector('.calculus-expr-name')?.value ?? '';
        if (!title.trim()) return;

        const calcResult = resultEl._numResult;
        if (calcResult === undefined || calcResult === null || isNaN(calcResult)) return;

        const rowData = _calculusRows.find(r => r.id === id);
        const labelValMap  = {};
        const colKeyValMap = {};
        if (rowData?.items.length) {
            rowData.items.forEach(item => {
                labelValMap[item.headerInfo.label] = Number(item.value);
                if (item.headerInfo.colKey) colKeyValMap[item.headerInfo.colKey] = Number(item.value);
            });
        }

        const pass = _calcEvalTitle(title, calcResult, labelValMap, colKeyValMap);
        if (pass === null) return; // plain text title
        resultEl.classList.add(pass ? 'calc-result-pass' : 'calc-result-fail');
    }

    /**
     * Evaluate the calculus formula against an arbitrary results <tr>.
     * Returns the numeric result, or null if any input is missing/non-numeric/hidden/filtered.
     */
    function _calcEvalForResultTr(rowData, tr, rowEl) {
        if (!tr) return null;
        if (tr.classList.contains('row-col-filter-hidden')) return null;
        if (tr.classList.contains('dim-row-hidden'))        return null;

        const ths      = Array.from(document.querySelectorAll('#results-table thead tr th'));
        const thLabels = ths.map(th => _thGetLabel(th));
        const tds      = Array.from(tr.querySelectorAll('td'));

        // Build temp items with cell values from this result row
        const tempItems = [];
        for (const item of rowData.items) {
            const colIdx = thLabels.indexOf(item.headerInfo.label);
            if (colIdx === -1) return null;
            const td = tds[colIdx];
            if (!td || td.style.display === 'none') return null;
            const raw = (td.dataset.raw ?? td.textContent).trim();
            if (raw === '' || raw === 'NULL' || raw === 'null') return null;
            const num = Number(raw);
            if (!isFinite(num) || isNaN(num)) return null;
            tempItems.push({ ...item, value: String(num) });
        }

        const selects    = Array.from(rowEl.querySelectorAll('.calculus-op-select'));
        const opVals     = selects.map(s => s.value);
        const prefixNopd = rowEl._prefixSel?.value === 'nop';

        const included = tempItems.filter((_, i) => {
            if (i === 0 && prefixNopd) return false;
            if (i > 0 && opVals[i - 1] === 'nop') return false;
            return true;
        });
        if (included.length === 0) return null;
        if (included.length === 1) {
            const num = Number(included[0].value);
            return isFinite(num) ? num : null;
        }
        try {
            const result = _evalWithParens(tempItems, opVals, prefixNopd);
            return (typeof result === 'number' && isFinite(result)) ? result : null;
        } catch { return null; }
    }

    /**
     * Apply (or re-apply) highlight for one calculus id.
     * Sets data-calchl_{id} = '1' or '0' on every non-filtered result row.
     */
    function _calcApplyHighlightForId(id) {
        const rowData = _calculusRows.find(r => r.id === id);
        if (!rowData || !rowData.highlightActive) return;

        const rowEl = document.querySelector(`#calculus-rows-container .calculus-expr-row[data-row-id="${id}"]`);
        if (!rowEl) return;

        const title = rowEl.querySelector('.calculus-expr-name')?.value ?? '';
        const tbody = document.querySelector('#results-table tbody');
        if (!tbody) return;

        const labelValMapBase = {};
        // (label→value will be built per-row inside the loop)

        tbody.querySelectorAll('tr').forEach(tr => {
            const numVal = _calcEvalForResultTr(rowData, tr, rowEl);
            let hit = '0';
            if (numVal !== null) {
                // Build labelValMap from this row's cell values
                const ths      = Array.from(document.querySelectorAll('#results-table thead tr th'));
                const thLabels = ths.map(th => _thGetLabel(th));
                const tds      = Array.from(tr.querySelectorAll('td'));
                const labelValMap  = {};
                const colKeyValMap = {};
                rowData.items.forEach(item => {
                    const ci  = thLabels.indexOf(item.headerInfo.label);
                    const td  = ci !== -1 ? tds[ci] : null;
                    if (td) {
                        const num = Number(td.dataset.raw ?? td.textContent);
                        labelValMap[item.headerInfo.label] = num;
                        if (item.headerInfo.colKey) colKeyValMap[item.headerInfo.colKey] = num;
                    }
                });
                const pass = _calcEvalTitle(title, numVal, labelValMap, colKeyValMap);
                if (pass !== null) {
                    const matches = rowData.highlightInverted ? !pass : pass;
                    hit = matches ? '1' : '0';
                }
            }
            tr.dataset[`calchl_${id}`] = hit;
            _calcRefreshRowHighlightClass(tr);
        });
        if (document.getElementById('results-table')?.classList.contains('is-dimmed') && _dimRowMode)
            _applyDimRowVisibility();
    }

    /** Remove highlight data for one calculus id from all result rows and refresh classes. */
    function _calcClearHighlightForId(id) {
        const tbody = document.querySelector('#results-table tbody');
        if (!tbody) return;
        const key = `calchl_${id}`;
        tbody.querySelectorAll('tr').forEach(tr => {
            delete tr.dataset[key];
            _calcRefreshRowHighlightClass(tr);
        });
    }

    /**
     * Set or clear the `calculus-hl` class on a result row based on ALL active highlight ids.
     * AND logic: every active id must have dataset value '1'.
     */
    function _calcRefreshRowHighlightClass(tr) {
        if (_calcHighlightActiveIds.size === 0) {
            tr.classList.remove('calculus-hl');
            return;
        }
        const allPass = [..._calcHighlightActiveIds].every(id => tr.dataset[`calchl_${id}`] === '1');
        tr.classList.toggle('calculus-hl', allPass);
    }

    /** Re-apply highlights for all currently active calculus ids. */
    function _calcApplyAllActiveHighlights() {
        if (_calcHighlightActiveIds.size === 0) return;
        _calcHighlightActiveIds.forEach(id => _calcApplyHighlightForId(id));
    }

    /** Evaluate the expression for one row and display the result. */
    function _calcCalculateRow(id, rowEl) {
        const rowData = _calculusRows.find(r => r.id === id);
        if (!rowData || rowData.items.length === 0) return;

        const selects = Array.from(rowEl.querySelectorAll('.calculus-op-select'));
        const opVals  = selects.map(s => s.value);

        // Build human-readable expression string — skip nop'd items and their parens.
        // Use the same included-items + bridging-operator approach as _calcBuildSqlExpr
        // so the display always matches the evaluated result.
        const prefixNopd = rowEl._prefixSel?.value === 'nop';
        const included = [];
        rowData.items.forEach((item, i) => {
            if (i === 0 && prefixNopd) return;
            if (i > 0 && opVals[i - 1] === 'nop') return;
            included.push({ item, origIdx: i });
        });
        if (included.length === 0) { _calcClearRowResult(rowEl); return; }

        // Normalise display operators to ASCII for clipboard/eval use
        const _normaliseExpr = s => s.replace(/\u2212/g, '-').replace(/\u00d7/g, '*').replace(/\u00f7/g, '/');

        // Single active item — show its value directly as the result
        if (included.length === 1) {
            const { item } = included[0];
            const result   = Number(item.value);
            const resultEl = rowEl.querySelector('.calculus-expr-result');
            const expr     = (item.openParen ? '(' : '') + item.value + (item.closeParen ? ')' : '');
            resultEl._expr = _normaliseExpr(expr);
            if (isNaN(result)) {
                resultEl._numResult = NaN;
                resultEl.innerHTML  = `<span class="calculus-error">Error</span><span class="calculus-result-formula"> = ${expr}</span>`;
                if (rowEl._resultTd) { rowEl._resultTd.textContent = 'Error'; rowEl._resultTd.className = 'calculus-result-td calculus-result-error'; }
            } else {
                resultEl._numResult = result;
                const fmt = result.toLocaleString(undefined, { maximumFractionDigits: 10, useGrouping: false });
                resultEl.innerHTML  = `<strong class="calculus-result-val">${fmt}</strong><span class="calculus-result-formula"> = ${expr}</span>`;
                if (rowEl._resultTd) { rowEl._resultTd.textContent = fmt; rowEl._resultTd.className = 'calculus-result-td calculus-result-ok'; }
            }
            _calcCheckTitleComparison(id, rowEl);
            _calcApplyHighlightForId(id);
            return;
        }

        let expr = '';
        included.forEach(({ item, origIdx }, pi) => {
            if (item.openParen)  expr += '(';
            expr += item.value;
            if (item.closeParen) expr += ')';
            if (pi < included.length - 1) {
                const bridgeSel = selects[included[pi + 1].origIdx - 1];
                expr += ` ${bridgeSel.options[bridgeSel.selectedIndex].textContent} `;
            }
        });

        let result;
        try { result = _evalWithParens(rowData.items, opVals, prefixNopd); }
        catch (e) { result = NaN; }

        const resultEl = rowEl.querySelector('.calculus-expr-result');
        resultEl._expr = _normaliseExpr(expr);
        if (isNaN(result)) {
            resultEl._numResult = NaN;
            resultEl.innerHTML = `<span class="calculus-error">Error (÷ 0)</span><span class="calculus-result-formula"> = ${expr}</span>`;
            if (rowEl._resultTd) {
                rowEl._resultTd.textContent = 'Error';
                rowEl._resultTd.className   = 'calculus-result-td calculus-result-error';
            }
        } else {
            resultEl._numResult = result;
            const fmt = result.toLocaleString(undefined, { maximumFractionDigits: 10, useGrouping: false });
            resultEl.innerHTML = `<strong class="calculus-result-val">${fmt}</strong><span class="calculus-result-formula"> = ${expr}</span>`;
            if (rowEl._resultTd) {
                rowEl._resultTd.textContent = fmt;
                rowEl._resultTd.className   = 'calculus-result-td calculus-result-ok';
            }
        }
        _calcCheckTitleComparison(id, rowEl);
        _calcApplyHighlightForId(id);
    }

    /**
     * Collect all data needed to render a copy of one expression row.
     * Returns { name, columns, exprStr, resultStr } or null if the row is empty.
     *
     * columns is an alternating array of:
     *   { type:'data',  label, origin, value, w }
     *   { type:'op',    symbol, w }
     */
    function _calcBuildData(id, rowEl) {
        const rowData = _calculusRows.find(r => r.id === id);
        if (!rowData || rowData.items.length === 0) return null;

        const name    = rowEl.querySelector('.calculus-expr-name').value.trim();
        const selects = Array.from(rowEl.querySelectorAll('.calculus-op-select'));
        const items   = rowData.items;

        // Alternating [data][op][data][op]…[data] — nop'd items are omitted entirely.
        const prefixNopdData = rowEl._prefixSel?.value === 'nop';
        const opValsData = selects.map(s => s.value);
        const columns = [];
        items.forEach((item, i) => {
            if (i === 0 && prefixNopdData) return; // skip prefix-nop'd first item
            if (i > 0 && opValsData[i - 1] === 'nop') return; // skip nop'd item
            if (columns.length > 0) { // only add bridging op when there's a preceding data col
                const sel = selects[i - 1];
                columns.push({
                    type:    'op',
                    symbol:  sel ? sel.options[sel.selectedIndex].textContent : '+',
                    opValue: sel ? sel.value : '+',
                });
            }
            columns.push({
                type:       'data',
                label:      item.headerInfo.label,
                origin:     item.headerInfo.origin || '',
                openParen:  item.openParen  || false,
                closeParen: item.closeParen || false,
                // Embed parens into the display value for copy output
                value:  (item.openParen ? '(' : '') + String(item.value) + (item.closeParen ? ')' : ''),
            });
        });

        // Compute result and expression string — skip nop'd items.
        let exprStr = null, resultStr = null;
        if (items.length >= 2) {
            const inclData = [];
            items.forEach((item, i) => {
                if (i === 0 && prefixNopdData) return;
                if (i > 0 && opValsData[i - 1] === 'nop') return;
                inclData.push({ item, origIdx: i });
            });
            exprStr = '';
            inclData.forEach(({ item, origIdx }, pi) => {
                if (item.openParen)  exprStr += '(';
                exprStr += item.value;
                if (item.closeParen) exprStr += ')';
                if (pi < inclData.length - 1) {
                    const bridgeSel = selects[inclData[pi + 1].origIdx - 1];
                    exprStr += ` ${bridgeSel.options[bridgeSel.selectedIndex].textContent} `;
                }
            });
            exprStr = exprStr.trimEnd();

            let r;
            try { r = _evalWithParens(items, selects.map(s => s.value), prefixNopdData); }
            catch (e) { r = NaN; }
            resultStr = isNaN(r)
                ? 'Error (÷ 0)'
                : r.toLocaleString(undefined, { maximumFractionDigits: 10, useGrouping: false });
        }

        // Append the RESULT column (always present; value is '—' if not yet computable)
        const resultVal = resultStr ?? '—';
        columns.push({
            type:   'result',
            label:  'RESULT',
            origin: '',
            value:  resultVal,
        });

        // Assign column widths
        columns.forEach(col => {
            if (col.type === 'data') {
                col.w = Math.max(col.label.length, col.origin.length, col.value.length, 1);
            } else if (col.type === 'result') {
                col.w = Math.max('RESULT'.length, col.value.length, 1);
            } else {
                col.w = Math.max(col.symbol.length, 1);
            }
        });

        return { name, columns, exprStr, resultStr };
    }

    // -------------------------------------------------------------------------
    // Calculus history
    // -------------------------------------------------------------------------

    // ID of the row whose history is currently displayed in the popup.
    let _historyActiveRowId = null;

    /**
     * Collect ALL columns (data + op) for the row regardless of nop state.
     * Each entry carries a `nopd` flag so text/CSV renderers can blank it out.
     */
    function _calcHistoryAllCols(rowData, rowEl) {
        const selects    = Array.from(rowEl.querySelectorAll('.calculus-op-select'));
        const opVals     = selects.map(s => s.value);
        const prefixNopd = rowEl._prefixSel?.value === 'nop';
        const allCols    = [];
        rowData.items.forEach((item, i) => {
            if (i > 0) {
                const sel    = selects[i - 1];
                const opNopd = opVals[i - 1] === 'nop';
                allCols.push({ type: 'op', symbol: sel.options[sel.selectedIndex].textContent, nopd: opNopd });
            }
            const isNopd = (i === 0 && prefixNopd) || (i > 0 && opVals[i - 1] === 'nop');
            allCols.push({ type: 'data', label: item.headerInfo.label, value: String(item.value), nopd: isNopd });
        });
        return allCols;
    }

    function _calcHistoryGetResult(rowEl) {
        const strong = rowEl.querySelector('.calculus-expr-result strong');
        return strong ? strong.textContent : null;
    }

    /** Reset history for the row and seed it with a header row + initial value row. */
    function _calcHistoryReset(rowData, rowEl) {
        const name    = rowEl.querySelector('.calculus-expr-name').value.trim();
        const allCols = _calcHistoryAllCols(rowData, rowEl);
        const result  = _calcHistoryGetResult(rowEl);
        rowData.historyRows = [
            { type: 'header', name, allCols: allCols.map(c => ({ ...c })), result },
            { type: 'value',       allCols: allCols.map(c => ({ ...c })), result },
        ];
    }

    /** Append a value snapshot to history (called on operator change). */
    function _calcHistoryAppend(rowData, rowEl) {
        if (!rowData.historyRows?.length) return;
        const allCols = _calcHistoryAllCols(rowData, rowEl);
        const result  = _calcHistoryGetResult(rowEl);
        rowData.historyRows.push({ type: 'value', allCols, result });
    }

    /**
     * Render historyRows as a fixed-width plain-text block.
     * Nop'd data columns show spaces; nop'd operator columns also show spaces.
     * All columns align vertically across every line.
     */
    function _calcHistoryToText(historyRows) {
        if (!historyRows?.length) return '';

        const n      = historyRows[0].allCols.length;
        const widths = new Array(n).fill(0);
        historyRows.forEach(row =>
            row.allCols.forEach((col, ci) => {
                const len = col.type === 'data'
                    ? Math.max(col.label.length, col.value.length)
                    : col.symbol.length;
                widths[ci] = Math.max(widths[ci], len);
            })
        );
        let resultW = 'RESULT'.length;
        historyRows.forEach(r => { if (r.result) resultW = Math.max(resultW, r.result.length); });

        const padEnd = (s, w) => String(s ?? '').padEnd(w);
        const center = (s, w) => {
            const str      = String(s ?? '');
            const padTotal = Math.max(0, w - str.length);
            const padLeft  = Math.floor(padTotal / 2);
            const padRight = padTotal - padLeft;
            return ' '.repeat(padLeft) + str + ' '.repeat(padRight);
        };

        const lines = [];
        const firstName = historyRows.find(r => r.type === 'header')?.name;
        if (firstName) lines.push(firstName);

        historyRows.forEach(row => {
            const parts = [];
            row.allCols.forEach((col, ci) => {
                const w = widths[ci];
                if (col.type === 'data') {
                    const text = row.type === 'header' ? col.label : (col.nopd ? '' : col.value);
                    parts.push(padEnd(text, w));
                } else {
                    const text = row.type === 'header' ? col.symbol : (col.nopd ? '' : col.symbol);
                    parts.push(center(text, w));
                }
            });
            const rText = row.type === 'header' ? 'RESULT' : (row.result ?? '—');
            parts.push('= ' + padEnd(rText, resultW));
            lines.push(parts.join('  '));
        });
        return lines.join('\n');
    }

    /**
     * Export historyRows as CSV — all data AND operator columns are included.
     * Operator column headers are empty strings; operator cell values are the
     * math symbol (+, −, ×, ÷, %) when active, or empty when nop'd.
     * Each cell is wrapped in double-quotes per RFC 4180.
     */
    function _calcHistoryToCsv(historyRows) {
        if (!historyRows?.length) return '';
        const headerRow = historyRows.find(r => r.type === 'header');
        if (!headerRow) return '';

        const esc = s => `"${String(s ?? '').replace(/"/g, '""')}"`;

        // Header row: data label | '' for op cols | 'RESULT'
        const csvHeader = [
            ...headerRow.allCols.map(c => c.type === 'data' ? esc(c.label) : esc('')),
            esc('RESULT'),
        ];

        const csvRows = [csvHeader];
        historyRows.filter(r => r.type === 'value').forEach(row => {
            const vals = row.allCols.map(c => {
                if (c.type === 'data') return esc(c.nopd ? '' : c.value);
                // Operator: emit symbol only when it is a real math op (nopd === false)
                return esc(c.nopd ? '' : c.symbol);
            });
            vals.push(esc(row.result ?? ''));
            csvRows.push(vals);
        });
        return csvRows.map(r => r.join(',')).join('\n');
    }

    /** Open the history popup for a specific row. */
    function _calcShowHistory(rowData, rowEl) {
        _historyActiveRowId = rowData.id;
        const idx      = _calculusRows.findIndex(r => r.id === rowData.id);
        const popup    = document.getElementById('calculus-history-popup');
        const textarea = document.getElementById('calculus-history-textarea');
        const rowTitle = rowEl.querySelector('.calculus-expr-name')?.value.trim() || '';
        const titleLabel = rowTitle ? rowTitle : `${idx + 1}`;
        document.querySelector('#calculus-history-header > span').textContent = `⊞ Calculus History - ${titleLabel}`;
        textarea.value = _calcHistoryToText(rowData.historyRows ?? []);
        textarea.dispatchEvent(new Event('input', { bubbles: true })); // refresh backdrop
        popup.classList.remove('hidden');
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }

    /** Copy the row's formula + result in the chosen format. */
    function _calcCopyRow(id, rowEl, format) {
        const data = _calcBuildData(id, rowEl);
        if (!data || !data.columns.length) {
            App.notify?.('Nothing to copy — add some cells first.', 'warn');
            return;
        }

        const { name, columns, exprStr, resultStr } = data;
        const resultLine = (exprStr && resultStr) ? `${exprStr} = ${resultStr}` : null;

        // Treat 'result' cells the same as 'data' cells for text rendering
        const isDataLike = c => c.type === 'data' || c.type === 'result';

        const pad = (s, w) => String(s ?? '').padEnd(w);
        const ctr = (s, w) => { const str = String(s ?? ''); const p = Math.max(0, w - str.length); const l = Math.floor(p / 2); return ' '.repeat(l) + str + ' '.repeat(p - l); };
        // Normalize display-only operator glyphs to their ASCII equivalents so
        // pasting into the math calculator (which only accepts ASCII operators) works.
        const normOp = s => String(s ?? '').replace(/\u2212/g, '-').replace(/\u00d7/g, '*').replace(/\u00f7/g, '/');
        const buildRow = (getData, getOp) =>
            columns.map(c => isDataLike(c) ? pad(getData(c), c.w) : ctr(getOp(c), c.w)).join('  ');

        let text;
        const lines = [];

        if (format === 'formula') {
            // Inline formula using column labels + operators + parentheses
            // Built directly from rowData so paren flags are accessible
            const rowData    = _calculusRows.find(r => r.id === id);
            const selects2   = Array.from(rowEl.querySelectorAll('.calculus-op-select'));
            const opVals2    = selects2.map(s => s.value);
            const prefixNopd = rowEl._prefixSel?.value === 'nop';
            const parts      = [];
            rowData.items.forEach((item, i) => {
                if (i === 0 && prefixNopd) return;
                if (i > 0 && opVals2[i - 1] === 'nop') return;
                let token = '';
                if (parts.length > 0) {
                    const sel = selects2[i - 1];
                    token += (sel ? sel.options[sel.selectedIndex].textContent : '+') + ' ';
                }
                if (item.openParen)  token += '(';
                token += item.headerInfo.label;
                if (item.closeParen) token += ')';
                parts.push(token);
            });
            text = parts.join(' ');

        } else if (format === 'data') {
            // Values + operators only — no header or origin rows
            if (name) lines.push(name);
            lines.push(buildRow(c => c.value, c => normOp(c.symbol)));

        } else { // plain — headers + values, no origin row
            if (name) lines.push(name);
            lines.push(buildRow(c => (c.openParen ? '(' : '') + c.label + (c.closeParen ? ')' : ''), c => normOp(c.symbol)));
            lines.push(buildRow(c => c.value, c => normOp(c.symbol)));
        }

        if (format !== 'formula') text = lines.join('\n');

        const formatLabel = format === 'formula' ? 'formula' : format === 'data' ? 'data' : 'plain text';
        navigator.clipboard.writeText(text)
            .then(() => App.notify?.(`Copied as ${formatLabel}`, 'success'))
            .catch(() => App.notify?.('Copy failed — check clipboard permissions', 'error'));
    }

    /**
     * Serialise the current Calculus state for context persistence.
     * Returns null when there are no expression rows.
     */
    // -------------------------------------------------------------------------
    // Clipboard save / load helpers
    // -------------------------------------------------------------------------

    /**
     * Serialise a single calculus row for clipboard export.
     * Format: first line = expression name; remaining lines = text formula
     * (same syntax accepted by the Eval prompt / _calcParseExpr).
     *
     *   Test User XP
     *   Age
     *   + Effort
     *   - Sleep
     */
    function _calcSerialiseRow(rowData, rowEl) {
        const name     = rowEl.querySelector('.calculus-expr-name')?.value ?? '';
        const selects  = Array.from(rowEl.querySelectorAll('.calculus-op-select'));
        const opVals   = selects.map(s => s.value);
        const prefixNopd = rowEl._prefixSel?.value === 'nop';

        const lines = [];
        rowData.items.forEach((item, i) => {
            if (i === 0 && prefixNopd)           return; // prefix-nop'd — skip
            if (i > 0  && opVals[i - 1] === 'nop') return; // nop'd — skip

            let token = '';
            if (i > 0) token = opVals[i - 1] + ' '; // e.g. "+ " or "- "
            if (item.openParen)  token += '(';
            token += item.headerInfo.label;
            if (item.closeParen) token += ')';
            lines.push(token);
        });

        return `${name}\n${lines.join('\n')}`;
    }

    /** Wipe a row's table content so it can be repopulated from serialised data. */
    function _calcClearRowContent(rowData, rowEl) {
        rowData.items       = [];
        rowData.historyRows = [];
        rowEl.querySelector('thead tr').innerHTML = '';
        rowEl.querySelector('tbody tr').innerHTML = '';
        rowEl._resultTh  = null;
        rowEl._resultTd  = null;
        rowEl._prefixSel = null;
        rowEl.querySelector('.calculus-expr-hint').classList.remove('hidden');
        rowEl.querySelector('.calculus-expr-table-wrap').classList.add('hidden');
        rowEl.querySelector('.calculus-expr-footer').classList.add('hidden');
        const res = rowEl.querySelector('.calculus-expr-result');
        if (res) { res.textContent = ''; res._expr = ''; }
    }


    function _calcGetState() {
        if (_calculusRows.length === 0 && !_calculusNote) return null;
        return {
            note: _calculusNote || null,
            rows: _calculusRows.map(rowData => {
                const rowEl     = document.querySelector(`.calculus-expr-row[data-row-id="${rowData.id}"]`);
                const opSelects = rowEl ? Array.from(rowEl.querySelectorAll('.calculus-op-select')).map(s => s.value) : [];
                const prefixOp  = rowEl?._prefixSel?.value ?? '';
                const name      = rowEl?.querySelector('.calculus-expr-name')?.value ?? '';
                return {
                    name,
                    sameRow: _calcIsSameRow(rowData),
                    items: rowData.items.map(item => ({
                        headerInfo: item.headerInfo,
                        value:      item.value,
                        openParen:  item.openParen,
                        closeParen: item.closeParen,
                    })),
                    operators: opSelects,
                    prefixOp,
                };
            }),
        };
    }

    /**
     * Restore Calculus from a previously saved context snapshot.
     * Rebuilds expression rows without showing the toolbox popup.
     * All restored rows are immediately marked as out-of-sync because
     * there are no live originTd references.
     */
    function _calcRestoreFromContext(savedData) {
        if (!savedData) {
            // Island has no calculus — reset everything so the previous island's
            // rows and note don't bleed into the newly activated island.
            _calcClearAll();
            _calculusNote         = '';
            _calculusNoteOriginal = '';
            return;
        }

        // Restore note (independent of rows)
        _calculusNote         = savedData.note ?? '';
        _calculusNoteOriginal = _calculusNote;

        if (!Array.isArray(savedData.rows) || savedData.rows.length === 0) {
            _calcClearAll();
            return;
        }

        _calcClearAll(); // reset state + mark in-sync (then we'll mark out-of-sync below)

        for (const savedRow of savedData.rows) {
            if (!savedRow.items || savedRow.items.length === 0) continue;

            _calcAddRow();
            const rowData = _calculusRows.find(r => r.id === _calculusActiveId);
            const rowEl   = document.querySelector(`.calculus-expr-row[data-row-id="${_calculusActiveId}"]`);
            if (!rowData || !rowEl) continue;

            // Carry forward the same-row flag so Bind Row stays visible after restore
            rowData.sameRowRestored = savedRow.sameRow ?? false;

            // Set expression name
            if (savedRow.name) {
                rowEl.querySelector('.calculus-expr-name').value = savedRow.name;
            }

            // Add each item (originTd = null — no live results table yet)
            for (const item of savedRow.items) {
                _calcAddCell(item.headerInfo, item.value, null);
            }

            // Restore paren toggle states
            const valueTds = Array.from(rowEl.querySelectorAll('tbody tr td.calculus-value'));
            rowData.items.forEach((dataItem, i) => {
                const saved = savedRow.items[i];
                if (!saved || !valueTds[i]) return;
                if (saved.openParen) {
                    valueTds[i].querySelector('.calc-paren-o')?.click();
                }
                if (saved.closeParen) {
                    valueTds[i].querySelector('.calc-paren-c')?.click();
                }
            });

            // Restore operator selections
            if (savedRow.operators?.length) {
                const opSelects = Array.from(rowEl.querySelectorAll('.calculus-op-select'));
                savedRow.operators.forEach((op, i) => {
                    if (opSelects[i] && op !== undefined) {
                        opSelects[i].value = op;
                        opSelects[i].dispatchEvent(new Event('change'));
                    }
                });
            }

            // Restore prefix operator
            if (savedRow.prefixOp !== undefined && rowEl._prefixSel) {
                rowEl._prefixSel.value = savedRow.prefixOp;
                rowEl._prefixSel.dispatchEvent(new Event('change'));
            }
        }

        // Restored calculus is always out of sync — no live originTd references
        _calcMarkOutOfSync();
    }

    // -------------------------------------------------------------------------
    // CSV loader
    // -------------------------------------------------------------------------

    /**
     * RFC 4180-compliant CSV parser.
     * Handles quoted fields (with embedded commas/newlines/doubled-quote escapes),
     * strips a leading UTF-8 BOM, and auto-detects the delimiter from the first line.
     *
     * @param  {string} text  raw file contents
     * @returns {{ cols:string[], rows:any[][], delim:string } | { error:string }}
     */
    function _parseCsv(text) {
        // Strip UTF-8 BOM
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        if (!text.trim()) return { error: 'The file is empty.' };

        // Auto-detect delimiter from the first line
        const firstLine = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'));
        const candidates = [',', ';', '\t'];
        const delim = candidates.reduce((best, d) =>
            (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',');

        // Character-by-character RFC 4180 parse
        const rows   = [];
        let   row    = [];
        let   field  = '';
        let   inQ    = false;
        const n      = text.length;

        for (let i = 0; i < n; i++) {
            const ch = text[i];

            if (inQ) {
                if (ch === '"') {
                    if (text[i + 1] === '"') { field += '"'; i++; }   // escaped "
                    else inQ = false;                                   // closing "
                } else {
                    field += ch;
                }
            } else if (ch === '"') {
                inQ = true;
            } else if (ch === delim) {
                row.push(field); field = '';
            } else if (ch === '\n') {
                row.push(field); field = '';
                // Skip bare \r preceding \n
                if (row.length === 1 && row[0] === '\r') { row = []; continue; }
                // Strip trailing \r from last field if present (Windows CRLF)
                if (row.length > 0) {
                    row[row.length - 1] = row[row.length - 1].replace(/\r$/, '');
                }
                rows.push(row); row = [];
            } else if (ch === '\r') {
                // \r without \n — treat as line ending
                if (text[i + 1] !== '\n') {
                    row.push(field); field = '';
                    rows.push(row);  row   = [];
                }
                // \r\n — the \n branch handles it; just skip \r
            } else {
                field += ch;
            }
        }
        // Flush last field / row
        if (field || row.length) { row.push(field); rows.push(row); }

        // Remove completely blank trailing rows
        while (rows.length && rows[rows.length - 1].every(c => c === '')) rows.pop();

        if (rows.length < 1) return { error: 'The file contains no data.' };

        const cols     = rows[0].map(c => c.trim());
        const dataRows = rows.slice(1);

        if (cols.length === 0) return { error: 'Could not detect any columns.' };

        // Infer column types: if every non-empty value in a column is a finite
        // number, mark it as numeric so the table renders it right-aligned.
        const colTypes = cols.map((_, ci) => {
            const allNumeric = dataRows.every(r => {
                const v = (r[ci] ?? '').trim();
                return v === '' || (v !== '' && isFinite(Number(v)));
            });
            return allNumeric ? 'DECIMAL' : 'VARCHAR';
        });

        // Convert numeric columns to numbers (or null for empty cells)
        const typedRows = dataRows.map(r =>
            cols.map((_, ci) => {
                const v = (r[ci] ?? '').trim();
                if (v === '') return null;
                return colTypes[ci] === 'DECIMAL' ? Number(v) : v;
            })
        );

        return { cols, rows: typedRows, colTypes, delim };
    }

    /**
     * Read a File object as text, parse it as CSV, and populate the results table.
     * Does not touch the SQL preview or the right-hand query panel.
     *
     * @param {File} file
     */
    function loadCsvFile(file) {
        const reader = new FileReader();
        reader.onerror = () => renderError('Could not read the file.');
        reader.onload  = e => {
            const parsed = _parseCsv(e.target.result);
            if (parsed.error) { renderError(parsed.error); return; }

            const delimLabel = parsed.delim === '\t' ? 'TAB' : parsed.delim;
            render({
                cols:       parsed.cols,
                rows:       parsed.rows,
                count:      parsed.rows.length,
                col_types:  parsed.colTypes,
                col_tables: [],          // no table mapping → right panel untouched
                sql:        null,        // don't overwrite the SQL preview
                _csvSource: `${file.name} (delimiter: ${delimLabel})`,
            });

            // Show the file name in the meta bar instead of just the row count
            const metaEl = document.getElementById('results-meta');
            if (metaEl) {
                const rowLabel = `${parsed.rows.length.toLocaleString()} row${parsed.rows.length !== 1 ? 's' : ''}`;
                metaEl.textContent = `${rowLabel} — ${file.name}`;
            }
        };
        reader.readAsText(file, 'UTF-8');
    }

    // =========================================================================
    // XLSX reader — vanilla, no third-party libraries
    // =========================================================================

    // Decompress a raw DEFLATE buffer using the native DecompressionStream API.
    async function _xlsxDecompress(data) {
        const ds     = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        writer.write(data);
        writer.close();
        const chunks = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            total += value.length;
        }
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        return out;
    }

    // Parse a ZIP ArrayBuffer and return a Map<filename, Uint8Array> of all entries.
    async function _zipRead(buffer) {
        const view  = new DataView(buffer);
        const bytes = new Uint8Array(buffer);
        const len   = buffer.byteLength;

        // Locate End of Central Directory (signature PK\x05\x06 = 0x06054b50).
        // Search backwards from the end; the optional comment pushes it up by at most 65535 bytes.
        let eocd = -1;
        for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
            if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd === -1) throw new Error('Not a valid XLSX file (ZIP signature not found).');

        const cdCount  = view.getUint16(eocd + 10, true);
        const cdOffset = view.getUint32(eocd + 16, true);

        const entries = new Map();
        let pos = cdOffset;

        for (let i = 0; i < cdCount; i++) {
            if (view.getUint32(pos, true) !== 0x02014b50)
                throw new Error('Corrupt ZIP central directory.');

            const method         = view.getUint16(pos + 10, true);
            const compressedSz   = view.getUint32(pos + 20, true);
            const nameLen        = view.getUint16(pos + 28, true);
            const extraLen       = view.getUint16(pos + 30, true);
            const commentLen     = view.getUint16(pos + 32, true);
            const localOffset    = view.getUint32(pos + 42, true);
            const name           = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
            pos += 46 + nameLen + extraLen + commentLen;

            // Read the local file header to find where the data starts.
            const localNameLen  = view.getUint16(localOffset + 26, true);
            const localExtraLen = view.getUint16(localOffset + 28, true);
            const dataStart     = localOffset + 30 + localNameLen + localExtraLen;
            const compressed    = bytes.subarray(dataStart, dataStart + compressedSz);

            if (method === 0) {
                entries.set(name, compressed);
            } else if (method === 8) {
                entries.set(name, await _xlsxDecompress(compressed));
            }
            // Other compression methods are rare in XLSX and skipped.
        }
        return entries;
    }

    // Decode a ZIP entry as a UTF-8 string and parse it as XML.
    function _xlsxXml(entries, path) {
        const data = entries.get(path);
        if (!data) return null;
        return new DOMParser().parseFromString(new TextDecoder().decode(data), 'text/xml');
    }

    // Build the shared-string table from xl/sharedStrings.xml.
    function _xlsxSharedStrings(entries) {
        const doc = _xlsxXml(entries, 'xl/sharedStrings.xml');
        if (!doc) return [];
        return Array.from(doc.getElementsByTagName('si')).map(si =>
            Array.from(si.getElementsByTagName('t')).map(t => t.textContent).join('')
        );
    }

    // Resolve the file path of the first sheet via workbook.xml + its rels file.
    function _xlsxFirstSheetPath(entries) {
        const wbDoc = _xlsxXml(entries, 'xl/workbook.xml');
        if (!wbDoc) throw new Error('Missing xl/workbook.xml');

        const sheetEl = wbDoc.getElementsByTagName('sheet')[0];
        if (!sheetEl) throw new Error('No sheets found in workbook.');

        // r:id lives in the relationships namespace.
        const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
        const rId  = sheetEl.getAttributeNS(R_NS, 'id') || sheetEl.getAttribute('r:id');

        const relsDoc = _xlsxXml(entries, 'xl/_rels/workbook.xml.rels');
        if (!relsDoc || !rId) return 'xl/worksheets/sheet1.xml'; // safe fallback

        const rel = Array.from(relsDoc.getElementsByTagName('Relationship'))
            .find(r => r.getAttribute('Id') === rId);
        if (!rel) return 'xl/worksheets/sheet1.xml';

        const target = rel.getAttribute('Target');
        // Target is relative to xl/, unless it starts with /
        return target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    }

    // Convert a column reference string ("A", "BC") to a 0-based column index.
    function _xlsxColIndex(ref) {
        let col = 0;
        for (let i = 0; i < ref.length; i++) {
            const ch = ref.charCodeAt(i);
            if (ch < 65 || ch > 90) break;
            col = col * 26 + (ch - 64);
        }
        return col - 1;
    }

    // Return the set of cellXfs indices (style indices) that represent date/time formats.
    function _xlsxDateStyles(entries) {
        const doc = _xlsxXml(entries, 'xl/styles.xml');
        if (!doc) return new Set();

        // Built-in Excel numFmtIds that are date/time (per OOXML spec).
        const BUILTIN_DATE_IDS = new Set([
            14, 15, 16, 17, 18, 19, 20, 21, 22,
            27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
            45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58, 81,
        ]);

        // Collect custom format IDs whose format string looks like a date/time.
        const customDateIds = new Set();
        for (const nf of doc.getElementsByTagName('numFmt')) {
            const id  = parseInt(nf.getAttribute('numFmtId'), 10);
            const fmt = nf.getAttribute('formatCode') || '';
            // Strip quoted literals and bracket expressions, then look for date/time tokens.
            const bare = fmt.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
            if (/[yYdD]/.test(bare) || /[hH]/.test(bare)) customDateIds.add(id);
        }

        // Map each cellXfs entry index to a boolean.
        const dateIdxs = new Set();
        const xfs = doc.getElementsByTagName('cellXfs')[0];
        if (xfs) {
            Array.from(xfs.getElementsByTagName('xf')).forEach((xf, i) => {
                const fmtId = parseInt(xf.getAttribute('numFmtId') || '0', 10);
                if (BUILTIN_DATE_IDS.has(fmtId) || customDateIds.has(fmtId)) dateIdxs.add(i);
            });
        }
        return dateIdxs;
    }

    // Convert an Excel date serial number to a "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" string.
    function _xlsxSerialToDate(serial) {
        const days = Math.floor(serial);
        const frac = serial - days;
        // Excel epoch: serial 25569 = 1970-01-01 UTC (already corrects for the 1900 leap-year bug).
        const ms = (days - 25569) * 86400000;
        const d  = new Date(ms);
        const p  = n => String(n).padStart(2, '0');
        const dateStr = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
        if (frac > 1e-6) {
            const totalSecs = Math.round(frac * 86400);
            return `${dateStr} ${p(Math.floor(totalSecs / 3600))}:${p(Math.floor((totalSecs % 3600) / 60))}`;
        }
        return dateStr;
    }

    // Parse a worksheet XML into { cols, rows, colTypes }, matching _parseCsv output shape.
    function _xlsxParseSheet(data, sst, dateStyles) {
        if (!data) throw new Error('Sheet XML not found in file.');
        const doc = new DOMParser().parseFromString(new TextDecoder().decode(data), 'text/xml');

        // Build sparse grid: grid[rowIndex][colIndex] = string value
        const grid = [];
        let maxCol = 0;

        for (const rowEl of doc.getElementsByTagName('row')) {
            const rowIdx = parseInt(rowEl.getAttribute('r'), 10) - 1;
            if (!grid[rowIdx]) grid[rowIdx] = [];

            for (const cellEl of rowEl.getElementsByTagName('c')) {
                const ref    = cellEl.getAttribute('r') || '';
                const t      = cellEl.getAttribute('t') || '';
                const sIdx   = parseInt(cellEl.getAttribute('s') || '-1', 10);
                const vEl    = cellEl.getElementsByTagName('v')[0];
                // Inline string: <is><t>...</t></is>
                const isEl   = (cellEl.getElementsByTagName('is')[0] || null);
                const isT    = isEl ? isEl.getElementsByTagName('t')[0] : null;

                let value = '';
                if (isT) {
                    value = isT.textContent;
                } else if (vEl) {
                    const raw = vEl.textContent;
                    if (t === 's') {
                        value = sst[parseInt(raw, 10)] ?? '';
                    } else if (t === 'b') {
                        value = raw === '1' ? 'TRUE' : 'FALSE';
                    } else if (t === '' && dateStyles.has(sIdx)) {
                        value = _xlsxSerialToDate(parseFloat(raw));
                    } else {
                        value = raw; // number or formula-result string
                    }
                }

                const colIdx = _xlsxColIndex(ref);
                grid[rowIdx][colIdx] = value;
                if (colIdx + 1 > maxCol) maxCol = colIdx + 1;
            }
        }

        // Flatten sparse grid, filling missing cells with empty string
        const flat = [];
        for (let r = 0; r < grid.length; r++) {
            const row = [];
            for (let c = 0; c < maxCol; c++) row.push((grid[r] && grid[r][c] != null) ? grid[r][c] : '');
            flat.push(row);
        }

        // Strip trailing all-empty rows
        while (flat.length && flat[flat.length - 1].every(v => v === '')) flat.pop();

        if (flat.length < 1) throw new Error('The sheet contains no data.');

        const cols     = flat[0].map(v => String(v).trim());
        const dataRows = flat.slice(1);
        if (cols.length === 0) throw new Error('Could not detect any columns.');

        // Type inference — same logic as _parseCsv
        const colTypes = cols.map((_, ci) => {
            const allNumeric = dataRows.every(r => {
                const v = String(r[ci] ?? '').trim();
                return v === '' || isFinite(Number(v));
            });
            return allNumeric ? 'DECIMAL' : 'VARCHAR';
        });

        const typedRows = dataRows.map(r =>
            cols.map((_, ci) => {
                const v = String(r[ci] ?? '').trim();
                if (v === '') return null;
                return colTypes[ci] === 'DECIMAL' ? Number(v) : v;
            })
        );

        return { cols, rows: typedRows, colTypes };
    }

    // Read a .xlsx File object and populate the results table.
    async function loadXlsxFile(file) {
        try {
            const buffer   = await file.arrayBuffer();
            const entries  = await _zipRead(buffer);
            const sst        = _xlsxSharedStrings(entries);
            const dateStyles = _xlsxDateStyles(entries);
            const sheetPath  = _xlsxFirstSheetPath(entries);
            const { cols, rows, colTypes } = _xlsxParseSheet(entries.get(sheetPath), sst, dateStyles);

            render({
                cols,
                rows,
                count:      rows.length,
                col_types:  colTypes,
                col_tables: [],
                sql:        null,
                _csvSource: file.name,
            });

            const metaEl = document.getElementById('results-meta');
            if (metaEl) {
                const rowLabel = `${rows.length.toLocaleString()} row${rows.length !== 1 ? 's' : ''}`;
                metaEl.textContent = `${rowLabel} — ${file.name}`;
            }
        } catch (err) {
            renderError('Could not read XLSX file: ' + err.message);
        }
    }

    // -------------------------------------------------------------------------
    return {
        init,
        render,
        renderError,
        rerender,
        clear,
        toggle:           _toggleCollapsed,
        toggleTall:       _toggleTall,
        toggleFullscreen: _toggleFullscreen,
        setFullscreen:    _setFullscreen,
        /** Apply or remove col-deselected styling on a result column by its select key. */
        syncColDeselected: _applyColDeselected,
        /** Re-apply table colors to all result header cells (call after a table color changes). */
        refreshHeaderColors: _applyResultHeaderColors,
        /** Toggle highlight on a result column. scrollTo=true scrolls to the column. */
        highlightColumn(colKey, on, scrollTo = false) {
            if (on) _highlightedCols.add(colKey);
            else    _highlightedCols.delete(colKey);
            _applyColHighlight(colKey, on, scrollTo);
        },
        /** Returns true if the given select key is currently highlighted. */
        isHighlighted: key => _highlightedCols.has(key),
        /** Mark Calculus as out of sync with the current results (query re-run / table removed). */
        calcMarkOutOfSync: _calcMarkOutOfSync,
        /** Serialise current Calculus state for context persistence. */
        calcGetState: _calcGetState,
        /** Restore Calculus from a saved context snapshot (popup stays hidden). */
        calcRestoreFromContext: _calcRestoreFromContext,
        /** Toggle the Calculus toolbox open/closed (bypasses the toolbar button's disabled state). */
        calcToggle: _toggleCalculusMode,
        /** Toggle the Calculus Note modal open/closed. */
        calcNoteToggle: () => {
            const modal = document.getElementById('modal-calculus-note');
            if (modal.classList.contains('hidden')) _openCalculusNote();
            else _closeCalculusNote();
        },
        /** Destroy all Calculus expression rows. */
        calcClear: _calcClearAll,
        /** Turn off Dim (called on context load/reset). */
        clearDim: () => _setDimmed(false),
        /** Exit dataset compare mode, stripping all compare highlights and turning off Dim. */
        exitDatasetCompare: _exitDatasetCompare,
        /** Parse a CSV File object and load it into the results table. */
        loadCsvFile,
        /** Parse an XLSX File object and load it into the results table. */
        loadXlsxFile,
        /** Parse a CSV string and load it into the results table. Returns an error string or null. */
        loadCsvText(text) {
            const parsed = _parseCsv(text);
            if (parsed.error) return parsed.error;
            const delimLabel = parsed.delim === '\t' ? 'TAB' : parsed.delim;
            render({
                cols:       parsed.cols,
                rows:       parsed.rows,
                count:      parsed.rows.length,
                col_types:  parsed.colTypes,
                col_tables: [],
                sql:        null,
                _csvSource: `memory (delimiter: ${delimLabel})`,
            });
            const metaEl = document.getElementById('results-meta');
            if (metaEl) {
                const rowLabel = `${parsed.rows.length.toLocaleString()} row${parsed.rows.length !== 1 ? 's' : ''}`;
                metaEl.textContent = `${rowLabel} — CSV (memory)`;
            }
            return null;
        },
    };
})();

document.addEventListener('DOMContentLoaded', () => Results.init());
