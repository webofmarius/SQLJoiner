/**
 * canvas.js — Visual canvas: table cards + drag-to-reposition
 *
 * Phase 3: renders table cards, card dragging, canvas scroll
 * Phase 4: SVG join lines will be handled by joins.js
 *
 * Depends on (at runtime): State, App  — defined in app.js (loaded before canvas.js)
 * Depends on (at runtime): Joins       — Phase 4 stub called where needed
 */

const Canvas = (() => {

    // =========================================================================
    // Card color palette + column highlight themes
    // =========================================================================
    const CARD_COLORS = [
        { hex: '#b71c1c', label: 'Red'       },
        { hex: '#8a2500', label: 'Orange'    },
        { hex: '#7a4510', label: 'Amber'     },
        { hex: '#33691e', label: 'Green'     },
        { hex: '#006064', label: 'Teal'      },
        { hex: '#1565c0', label: 'Blue'      },
        { hex: '#4a148c', label: 'Purple'    },
        { hex: '#37474f', label: 'Blue Grey' },
    ];

    const COL_THEMES = [
        'col-highlight-1',
        'col-highlight-2',
        'col-highlight-3',
        'col-highlight-4',
    ];

    // Singleton color popup
    let _colorPopup      = null;
    let _colorPopupCard  = null;
    let _colorPopupTable = null;

    // Table search modal — active table id
    let _tableSearchId = null;

    // =========================================================================
    // Canvas table search state
    // =========================================================================
    const _search = {
        groups:  [],   // [{tableIds: [...]}] — one entry per logical match result
        matches: [],   // flat deduplicated tableIds across all groups (for highlight)
        index:   -1,   // which group is currently focused
    };

    // =========================================================================
    // Shared drag state — one global object, no per-card listeners on document
    // =========================================================================
    const _drag = {
        active:   false,
        cardEl:   null,
        tableId:  null,
        offsetX:  0,
        offsetY:  0,
    };

    // =========================================================================
    // Shared resize state
    // =========================================================================
    const _resize = {
        active:    false,
        handle:    'br',  // 'br'|'tr'|'r'|'bl'|'l'|'tl'|'b'|'t'
        cardEl:    null,
        tableId:   null,
        startX:    0,
        startY:    0,
        startW:    0,
        startH:    0,
        startTop:  0,
        startLeft: 0,
    };

    // =========================================================================
    // Shared cut-and-place state — one table may be "cut" at a time
    // =========================================================================
    const _cut = {
        tableId: null,
        cardEl:  null,
    };

    function _exitCutMode() {
        if (!_cut.tableId) return;
        if (_cut.cardEl) {
            _cut.cardEl.classList.remove('is-cut');
            _cut.cardEl.querySelector('.table-card__cut-btn')?.classList.remove('is-active');
        }
        _cut.tableId = null;
        _cut.cardEl  = null;
        document.body.classList.remove('is-cut-mode');
    }

    /** Logical canvas size (matches CSS #canvas min-width / min-height). */
    const CANVAS_LOGICAL_PX   = 5000;
    /** Canvas-only overview zoom — not browser zoom. */
    const OVERVIEW_ZOOM_SCALE = 0.7;

    function _canvasContentScale() {
        return document.body.classList.contains('is-canvas-overview-zoom')
            ? OVERVIEW_ZOOM_SCALE
            : 1;
    }

    function getContentScale() {
        return _canvasContentScale();
    }

    /** Scroll #canvas-wrapper so logical canvas point (cx, cy) is centred. */
    function _scrollWrapperToLogicalCenter(cx, cy, behavior = 'smooth') {
        const s       = _canvasContentScale();
        const wrapper = document.getElementById('canvas-wrapper');
        if (!wrapper) return;
        wrapper.scrollTo({
            left:     cx * s - wrapper.clientWidth  / 2,
            top:      cy * s - wrapper.clientHeight / 2,
            behavior,
        });
    }

    // =========================================================================
    // Shared pan (canvas background drag) state
    // =========================================================================
    const _pan = {
        active:  false,
        startX:  0,
        startY:  0,
        scrollX: 0,
        scrollY: 0,
    };

    // =========================================================================
    // Init — bind the global drag handlers once
    // =========================================================================
    function init() {
        document.addEventListener('mousemove',   _onMouseMove);
        document.addEventListener('mouseup',     _onMouseUp);
        document.addEventListener('click', _onCanvasClick, { capture: true });

        // --- Canvas table search ---
        const searchInput = document.getElementById('canvas-search-input');
        const searchPrev  = document.getElementById('canvas-search-prev');
        const searchNext  = document.getElementById('canvas-search-next');
        const searchClear = document.getElementById('canvas-search-clear');

        const searchFilter = document.getElementById('canvas-search-filter');

        searchInput .addEventListener('input',  () => _runSearch(searchInput.value));
        searchFilter.addEventListener('change', () => _runSearch(searchInput.value));
        searchInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.shiftKey ? _searchStep(-1) : _searchStep(1);
            }
            if (e.key === 'Escape') { searchInput.value = ''; _clearSearch(); }
        });
        searchPrev .addEventListener('click', () => _searchStep(-1));
        searchNext .addEventListener('click', () => _searchStep(1));
        searchClear.addEventListener('click', () => { searchInput.value = ''; _clearSearch(); });

        // Screenshot button
        document.getElementById('btn-screenshot-canvas')
            ?.addEventListener('click', _screenshotCanvas);

        // ── Table search popup ─────────────────────────────────────────────────
        (() => {
            const TABLE_SEARCH_OPS = [
                '=', '!=', '<', '>', '<=', '>=',
                'LIKE', 'NOT LIKE',
                'IS NULL', 'IS NOT NULL',
                'IN', 'NOT IN',
                'BETWEEN', 'NOT BETWEEN',
            ];
            const NO_VALUE_OPS = new Set(['IS NULL', 'IS NOT NULL']);

            const modal    = document.getElementById('modal-table-search');
            const nameEl   = document.getElementById('table-search-name');
            const opSel    = document.getElementById('table-search-op');
            const idxChk   = document.getElementById('table-search-indexed-only');
            const valWrap  = document.getElementById('table-search-value-wrap');
            const valTa    = document.getElementById('table-search-value');

            // Populate operator dropdown once
            TABLE_SEARCH_OPS.forEach(op => {
                const opt = document.createElement('option');
                opt.value = op; opt.textContent = op;
                opSel.appendChild(opt);
            });

            // Attach SqlBackdrop to the value textarea
            if (typeof SqlBackdrop !== 'undefined') SqlBackdrop.attach(valTa);

            const _open = (tableId) => {
                const tableData = (State.tables || []).find(t => t.id === tableId);
                if (!tableData) return;
                _tableSearchId = tableId;
                nameEl.textContent = tableData.alias || tableData.name || tableId;
                // Reset state
                opSel.value = '=';
                valTa.value = '';
                if (typeof SqlBackdrop !== 'undefined') SqlBackdrop.refresh(valTa);
                valWrap.classList.remove('hidden');
                idxChk.checked  = false;
                idxChk.disabled = !!tableData.isSubquery;
                modal.classList.remove('hidden');
                valTa.focus();
            };

            const _close = () => {
                modal.classList.add('hidden');
                _tableSearchId = null;
            };

            const _apply = () => {
                const tableData = (State.tables || []).find(t => t.id === _tableSearchId);
                if (!tableData) { _close(); return; }

                const op      = opSel.value;
                const val     = valTa.value.trim();
                const noVal   = NO_VALUE_OPS.has(op);
                const alias   = tableData.alias || tableData.name;

                // Sub-queries: all manually-exposed columns (no index metadata available).
                // Normal tables: all columns, or only indexed ones when the checkbox is checked.
                const allCols = tableData.columns || [];
                const cols = tableData.isSubquery
                    ? allCols.map(c => c.name)
                    : (idxChk.checked
                        ? allCols.filter(c => c.key).map(c => c.name)
                        : allCols.map(c => c.name));

                if (cols.length === 0) { _close(); return; }

                const clauses = cols.map(col => {
                    const ref = `\`${alias}\`.\`${col}\``;
                    return noVal ? `${ref} ${op}` : `${ref} ${op} ${val}`;
                });

                if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                State.whereRaw  = clauses.join('\nOR ');
                State.whereMode = 'raw';
                if (typeof QueryPanel !== 'undefined') QueryPanel.applyModeUI('where');
                App.updateSQLPreview?.();
                _close();
            };

            // Operator change — hide value textarea for no-value operators
            opSel.addEventListener('change', () => {
                valWrap.classList.toggle('hidden', NO_VALUE_OPS.has(opSel.value));
            });

            document.getElementById('btn-table-search-x')
                .addEventListener('click', _close);
            document.getElementById('btn-table-search-cancel')
                .addEventListener('click', _close);
            document.getElementById('btn-table-search-apply')
                .addEventListener('click', _apply);

            // Ctrl/Cmd+Enter submits; Escape closes
            valTa.addEventListener('keydown', e => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); _apply(); }
                if (e.key === 'Escape') { e.stopPropagation(); _close(); }
            });

            // Store opener so card buttons can call it
            Canvas._openTableSearch = _open;
        })();

        // Bind background pan on the canvas wrapper itself (right-click drag)
        const wrapper = document.getElementById('canvas-wrapper');
        wrapper.addEventListener('contextmenu', e => e.preventDefault());
        wrapper.addEventListener('mousedown', (e) => {
            // Only right-click on the wrapper / scale sleeve / bare canvas (not a card or line)
            const scaleWrap = document.getElementById('canvas-scale-wrap');
            const canvasEl  = document.getElementById('canvas');
            if (e.target !== wrapper && e.target !== canvasEl && e.target !== scaleWrap) return;

            _pan.active  = true;
            _pan.startX  = e.clientX;
            _pan.startY  = e.clientY;
            _pan.scrollX = wrapper.scrollLeft;
            _pan.scrollY = wrapper.scrollTop;

            wrapper.style.cursor = 'grabbing';
            e.preventDefault();
        });
    }

    // =========================================================================
    // Render a single table card onto the canvas
    // =========================================================================
    function renderTable(tableData) {
        // Remove stale card if re-rendering (e.g. after alias cascade)
        _removeCardEl(tableData.id);

        const card = _buildCard(tableData);
        _applySize(card, tableData.size);
        document.getElementById('canvas').appendChild(card);

        // Auto-size on first render (no stored size from a previous context save).
        // Must happen before position so we know the card's true dimensions.
        if (!tableData.size) {
            _autoSize(card, tableData);
        }

        // Normal tables always show all columns without scrolling.
        // _autoSize covers new tables; this covers context-restored tables where
        // only size.w is saved (no size.h) so _applySize never adds is-resized.
        if (!tableData.isSubquery) {
            card.classList.add('is-resized');
        }

        // Position: find a free spot if none stored (new table, not context restore)
        const isNew = !tableData.position;
        if (isNew) {
            tableData.position = _findFreePosition(card);
        }
        _applyPosition(card, tableData.position);
        if (isNew) _scrollToCard(card);

        _bindCardEvents(card, tableData);

        // Refresh all order dropdowns so every card shows the correct 1..N range
        _refreshAllOrderDropdowns();

        // Hide the "add tables" hint once canvas has content
        const hint = document.getElementById('canvas-hint');
        if (hint) hint.style.display = 'none';

        if (typeof Minimap !== 'undefined') Minimap.update();
    }

    // =========================================================================
    // Remove a single card element from the DOM
    // =========================================================================
    function removeTable(tableId) {
        _removeCardEl(tableId);
        if (typeof Minimap !== 'undefined') Minimap.update();
    }

    // =========================================================================
    // SQL variable binding — parse SET @var = val; lines and substitute them
    // =========================================================================
    function _bindSqlVariables(sql) {
        // Extract variable values: everything between '=' and the next ';'
        const vars  = {};
        const varRe = /\bSET[ \t]+@(\w+)[ \t]*:?=[ \t]*([^;]*)/gi;
        let m;
        while ((m = varRe.exec(sql)) !== null) {
            vars[m[1]] = m[2].trim();
        }
        if (Object.keys(vars).length === 0) return null;

        // Remove each SET @var = val; from the text, keeping surrounding SQL
        // (including its semicolons and newlines) intact.
        let result = sql.replace(/\bSET[ \t]+@\w+[ \t]*:?=[ \t]*[^;]*;?[ \t]*\n?/gi, '');

        // Strip blank lines left at the very start (from removed leading SET lines)
        result = result.replace(/^([ \t]*\n)+/, '');

        // Substitute @varname occurrences (longest name first to avoid partial matches)
        const names = Object.keys(vars).sort((a, b) => b.length - a.length);
        for (const name of names) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            result = result.replace(new RegExp('@' + escaped + '(?!\\w)', 'g'), vars[name]);
        }

        return result || null;
    }

    // =========================================================================
    // Rebuild the entire canvas from a state snapshot (used by Load Context)
    // =========================================================================
    function rebuildFromState(state) {
        // Clear all existing cards
        document.querySelectorAll('.table-card').forEach(el => el.remove());

        // Show hint if no tables
        const hint = document.getElementById('canvas-hint');
        if (hint) hint.style.display = state.tables.length === 0 ? '' : 'none';

        // Re-render each table card
        state.tables.forEach(t => renderTable(t));

        if (typeof Joins    !== 'undefined') Joins.rebuildFromState(state);
        if (typeof Islands  !== 'undefined') Islands.recompute();
    }

    // =========================================================================
    // Refresh every visible order-dropdown to reflect the current table count
    // and each table's current order value. Called after any add/remove/swap.
    // =========================================================================
    function _refreshAllOrderDropdowns() {
        // Build a per-table island-size map so each dropdown is scoped to its island
        const enabledJoins = State.joins.filter(j => j.enabled !== false);
        const islands      = typeof App !== 'undefined'
            ? App.computeIslands(State.tables, enabledJoins)
            : [State.tables.map(t => t.id)];
        const islandSizeOf  = {};
        const islandGroupOf = {};
        islands.forEach(group => {
            const key = [...group].sort().join('|');
            group.forEach(id => { islandSizeOf[id] = group.length; islandGroupOf[id] = key; });
        });

        document.querySelectorAll('#canvas .table-card').forEach(card => {
            const t       = State.tables.find(t => t.id === card.dataset.tableId);
            const sel     = card.querySelector('.table-card__order');
            const flagBtn = card.querySelector('.table-card__flag-btn');
            if (!t || !sel) return;
            const n = islandSizeOf[t.id] ?? 1;
            sel.innerHTML = Array.from({length: n}, (_, i) => {
                const v = i + 1;
                return `<option value="${v}"${t.order === v ? ' selected' : ''}>${v}</option>`;
            }).join('');
            if (flagBtn) {
                flagBtn.disabled = (n === 1);
                const islandKey  = islandGroupOf[t.id] ?? t.id;
                const anchorId   = State.islandConfigs?.[islandKey]?.anchorTableId;
                flagBtn.classList.toggle('is-anchor', anchorId === t.id);
            }
        });
    }

    // =========================================================================
    // Build the card DOM element
    // =========================================================================
    function _buildCard(tableData) {
        const card         = document.createElement('div');
        card.className     = 'table-card';
        card.dataset.tableId = tableData.id;

        // --- Header (two rows inside the same drag-handle div) ---
        // Row 1: alias input + close button
        // Row 2: full table name (with db prefix if set) — its own line, can't be squished
        const displayName = tableData.database
            ? `${_esc(tableData.database)}.${_esc(tableData.name)}`
            : _esc(tableData.name);

        const header       = document.createElement('div');
        header.className   = 'table-card__header';

        // Build order-dropdown options (1..M where M = tables in this table's island)
        const _enabledJoins  = State.joins.filter(j => j.enabled !== false);
        const _islands       = typeof App !== 'undefined'
            ? App.computeIslands(State.tables, _enabledJoins)
            : [State.tables.map(t => t.id)];
        const _myIsland      = _islands.find(g => g.includes(tableData.id));
        const _orderN        = _myIsland ? _myIsland.length : 1;
        const _orderOpts     = Array.from({length: _orderN}, (_, i) => {
            const v = i + 1;
            return `<option value="${v}"${tableData.order === v ? ' selected' : ''}>${v}</option>`;
        }).join('');
        const _islandKey     = _myIsland ? [..._myIsland].sort().join('|') : tableData.id;
        const _isAnchor      = State.islandConfigs?.[_islandKey]?.anchorTableId === tableData.id;

        header.innerHTML   = `
            <div class="table-card__tname-row">
                <button class="table-card__ddl-btn btn-icon" title="Show CREATE TABLE statement">{ }</button>
                <button class="table-card__color-btn btn-icon" title="Set card color">⬤</button>
                <button class="table-card__cut-btn btn-icon" title="Cut — right-click anywhere on canvas to place">✂</button>
                <div class="table-card__tname" title="${displayName}">${displayName}</div>
                <button class="table-card__copy-name-btn" title="Copy table name to clipboard">⎘</button>
                <span class="table-card__rowcount" title="Approximate row count">…</span>
            </div>
            <div class="table-card__header-row">
                <select class="table-card__order" title="Join order — 1 means this table is used in FROM, 2+ means JOIN">${_orderOpts}</select>
                <button class="table-card__flag-btn btn-icon${_isAnchor ? ' is-anchor' : ''}" title="Set as join start — auto-number remaining tables" ${_orderN === 1 ? 'disabled' : ''}>⚑</button>
                <div class="table-card__alias-wrap">
                    <span class="table-card__alias-paren">(</span>
                    <input  class="table-card__alias"
                            type="text"
                            value="${_esc(tableData.alias)}"
                            title="Table alias — click to edit"
                            maxlength="30"
                            spellcheck="false">
                    <span class="table-card__alias-paren">)</span>
                </div>
                <button class="table-card__remove btn-icon" title="Remove from canvas">✕</button>
            </div>
            <div class="table-card__note-row">
                <button class="table-card__copy-simple-btn btn-icon" title="Copy SELECT * FROM table ORDER BY id DESC LIMIT 10">⎘</button>
                <button class="table-card__copy-filtered-btn btn-icon" title="Copy SELECT with WHERE filters for this table">≡</button>
                <button class="table-card__count-btn btn-icon" title="Copy COUNT(*) query for this table">#</button>
                <button class="table-card__search-btn btn-icon" title="Search — add WHERE clauses across all columns">🔍</button>
                <input  class="table-card__quick-note"
                        type="text"
                        value="${_esc(tableData.note ?? '')}"
                        placeholder="Quick note…"
                        spellcheck="false">
            </div>
        `;

        if (tableData.isSubquery) {
            // --- Subquery: textarea for SQL + virtual column adder ---
            card.classList.add('is-subquery');

            // Insert HTML-highlight toggle checkbox to the left of the quick-note input
            const sqHtmlChk = document.createElement('input');
            sqHtmlChk.type      = 'checkbox';
            sqHtmlChk.className = 'sq-html-chk';
            sqHtmlChk.title     = 'Toggle syntax-highlighted backdrop (read — write with colours)';
            sqHtmlChk.checked   = !!(tableData.htmlHighlight);

            // Replace copy-simple-btn with "S" (save to disk) and add "L" (load from disk)
            const copySimpleBtn = header.querySelector('.table-card__copy-simple-btn');
            copySimpleBtn.textContent = 'S';
            copySimpleBtn.title = 'Save subquery SQL to disk';
            copySimpleBtn.classList.add('sq-save-btn');

            const sqCountHeaderBtn = document.createElement('button');
            sqCountHeaderBtn.type      = 'button';
            sqCountHeaderBtn.className = 'table-card__sq-count-btn btn-icon';
            sqCountHeaderBtn.textContent = '#';
            sqCountHeaderBtn.title = 'Copy table list + COUNT queries to clipboard';
            copySimpleBtn.insertAdjacentElement('beforebegin', sqCountHeaderBtn);

            const sqLoadHeaderBtn = document.createElement('button');
            sqLoadHeaderBtn.type      = 'button';
            sqLoadHeaderBtn.className = 'table-card__sq-load-btn btn-icon';
            sqLoadHeaderBtn.textContent = 'L';
            sqLoadHeaderBtn.title = 'Load .sql or .csv file into subquery (same as Alt+L)';
            copySimpleBtn.insertAdjacentElement('afterend', sqLoadHeaderBtn);

            const sqBody       = document.createElement('div');
            sqBody.className   = 'subquery-body';

            const sqTextarea         = document.createElement('textarea');
            sqTextarea.className     = 'subquery-textarea';
            sqTextarea.id            = 'sq-ta-' + tableData.id;  // stable id for annotation save/restore
            sqTextarea.placeholder   = 'SELECT …';
            sqTextarea.spellcheck    = false;
            sqTextarea.value         = tableData.subquery || '';
            sqBody.appendChild(sqTextarea);

            // Controls row: expand button + run buttons
            const sqControls      = document.createElement('div');
            sqControls.className  = 'sq-controls';

            const sqExpandBtn        = document.createElement('button');
            sqExpandBtn.type         = 'button';
            sqExpandBtn.className    = 'sq-expand-btn';
            sqExpandBtn.textContent  = '⤢';
            sqControls.appendChild(sqExpandBtn);

            const sqExplainBtn       = document.createElement('button');
            sqExplainBtn.type        = 'button';
            sqExplainBtn.className   = 'sq-explain-btn btn-outline-blue';
            sqExplainBtn.textContent = '⚙ Explain';
            sqControls.appendChild(sqExplainBtn);

            const sqRunBtn           = document.createElement('button');
            sqRunBtn.type            = 'button';
            sqRunBtn.className       = 'sq-run-btn primary';
            sqRunBtn.textContent     = '▶ Run';
            sqControls.appendChild(sqRunBtn);

            const sqFileInput        = document.createElement('input');
            sqFileInput.type         = 'file';
            sqFileInput.accept       = '.sql,.csv,text/plain,text/csv';
            sqFileInput.className    = 'sq-file-input';
            sqBody.appendChild(sqFileInput);

            const sqDropOverlay      = document.createElement('div');
            sqDropOverlay.className  = 'sq-drop-overlay sql-drop-overlay';
            sqDropOverlay.textContent = 'Drop .sql or .csv to load';
            sqBody.appendChild(sqDropOverlay);

            const sqTablesMenu       = document.createElement('div');
            sqTablesMenu.className   = 'tables-menu';
            sqTablesMenu.innerHTML   =
                '<button type="button" class="btn-tables-trigger">Tables ▾</button>' +
                '<div class="tables-dropdown hidden">' +
                    '<div class="tables-menu-row">' +
                        '<input type="checkbox" class="tables-save-chk" title="Save to disk instead of copying to clipboard">' +
                        '<button type="button" class="btn-tables-names">NAMES</button>' +
                    '</div>' +
                    '<div class="tables-menu-row tables-menu-row--sep">' +
                        '<input type="checkbox" class="tables-selects-save-chk" title="Save to disk instead of copying to clipboard">' +
                        '<button type="button" class="btn-tables-selects">SELECTS</button>' +
                    '</div>' +
                    '<div class="tables-menu-row tables-menu-row--sep">' +
                        '<input type="checkbox" class="tables-creates-save-chk" title="Save to disk instead of copying to clipboard">' +
                        '<button type="button" class="btn-tables-creates">CREATES</button>' +
                    '</div>' +
                    '<div class="tables-menu-row tables-menu-row--sep">' +
                        '<input type="checkbox" class="tables-ai-knowledge-save-chk" title="Save to disk instead of copying to clipboard">' +
                        '<button type="button" class="btn-tables-ai-knowledge">AI KNOWLEDGE</button>' +
                    '</div>' +
                '</div>';
            sqTablesMenu.insertBefore(sqHtmlChk, sqTablesMenu.firstChild);
            sqControls.appendChild(sqTablesMenu);

            sqBody.appendChild(sqControls);

            const sqColAdd     = document.createElement('div');
            sqColAdd.className = 'subquery-col-add';
            sqColAdd.innerHTML = '<input class="sq-col-input" type="text" placeholder="Add join column…" spellcheck="false" maxlength="64"><button class="sq-col-btn btn-icon" title="Add column (used for join definitions)">＋</button>';
            sqBody.appendChild(sqColAdd);

            const colList      = document.createElement('ul');
            colList.className  = 'table-card__columns';
            (tableData.columns || []).forEach(col => {
                colList.appendChild(_buildSubqueryColumnRow(col, tableData, colList));
            });
            sqBody.appendChild(colList);

            card.appendChild(header);
            card.appendChild(sqBody);
        } else {
            // --- Normal table: column search + column list ---
            const colSearch       = document.createElement('div');
            colSearch.className   = 'col-search-wrap';
            colSearch.innerHTML   = '<input class="col-search" type="search" placeholder="Filter columns…" autocomplete="off">';

            const colList      = document.createElement('ul');
            colList.className  = 'table-card__columns';
            (tableData.columns || []).forEach(col => {
                colList.appendChild(_buildColumnRow(col, tableData.id, tableData));
            });

            card.appendChild(header);
            card.appendChild(colSearch);
            card.appendChild(colList);
        }

        // --- Resize handles ---
        const resizeHandle       = document.createElement('div');
        resizeHandle.className   = 'table-card__resize';
        resizeHandle.title       = 'Drag to resize';
        card.appendChild(resizeHandle);

        const resizeTR           = document.createElement('div');
        resizeTR.className       = 'table-card__resize-tr';
        resizeTR.title           = 'Drag to resize';
        card.appendChild(resizeTR);

        const resizeR            = document.createElement('div');
        resizeR.className        = 'table-card__resize-r';
        resizeR.title            = 'Drag to resize width';
        card.appendChild(resizeR);

        const resizeTL           = document.createElement('div');
        resizeTL.className       = 'table-card__resize-tl';
        resizeTL.title           = 'Drag to resize';
        card.appendChild(resizeTL);

        const resizeBL           = document.createElement('div');
        resizeBL.className       = 'table-card__resize-bl';
        resizeBL.title           = 'Drag to resize';
        card.appendChild(resizeBL);

        const resizeL            = document.createElement('div');
        resizeL.className        = 'table-card__resize-l';
        resizeL.title            = 'Drag to resize width';
        card.appendChild(resizeL);

        const resizeT            = document.createElement('div');
        resizeT.className        = 'table-card__resize-t';
        resizeT.title            = 'Drag to resize height';
        card.appendChild(resizeT);

        const resizeB            = document.createElement('div');
        resizeB.className        = 'table-card__resize-b';
        resizeB.title            = 'Drag to resize height';
        card.appendChild(resizeB);

        if (tableData.color) {
            _applyCardColor(card, tableData.color);
        }

        return card;
    }

    function _buildColumnRow(col, tableId, tableData) {
        const li              = document.createElement('li');
        li.className          = 'table-card__col';
        li.dataset.col        = col.name;
        li.dataset.tableId    = tableId;
        li.draggable          = true;   // Phase 4 wires the dragstart event
        li.title              = `${col.name}  —  ${col.type}`;

        // Restore saved column highlight
        const savedTheme = tableData?.colHighlights?.[col.name];
        if (savedTheme) li.classList.add(savedTheme);

        // Key badge
        let badge = '';
        if      (col.key === 'PRI') badge = '<span class="col-badge col-badge--pk" title="Primary Key">PK</span>';
        else if (col.key === 'MUL') badge = '<span class="col-badge col-badge--fk" title="Index / Foreign Key">FK</span>';
        else if (col.key === 'UNI') badge = '<span class="col-badge col-badge--uni" title="Unique">UQ</span>';

        // Auto-increment indicator on type
        const typeStr = col.extra === 'auto_increment'
            ? `${_esc(col.shortType)} ↑`
            : _esc(col.shortType);

        li.innerHTML = `
            <span class="table-card__col-name">${_esc(col.name)}</span>
            ${badge}
            <span class="table-card__col-type">${typeStr}</span>
            <button class="table-card__col-copy-btn" title="Copy column name to clipboard">⎘</button>
        `;

        const colCopyBtn = li.querySelector('.table-card__col-copy-btn');
        colCopyBtn.addEventListener('mousedown', e => e.stopPropagation());
        colCopyBtn.addEventListener('click', e => {
            e.stopPropagation();
            navigator.clipboard.writeText(`${tableData.alias}.${col.name}`).then(() => {
                colCopyBtn.textContent = '✓';
                setTimeout(() => { colCopyBtn.textContent = '⎘'; }, 1200);
            });
        });

        let _colClickTimer = null;

        // Double-click → add column to WHERE box (same as drag-drop)
        li.addEventListener('dblclick', e => {
            e.stopPropagation();
            clearTimeout(_colClickTimer); // cancel any pending single-click color cycle
            const zone = document.querySelector('.drop-zone[data-section="where"]');
            if (zone) {
                QueryPanel.onColumnDrop(zone, tableId, col.name);
                document.getElementById('section-where')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                requestAnimationFrame(() => {
                    const rows = document.getElementById('where-conditions')?.querySelectorAll('.condition-row');
                    if (rows?.length) rows[rows.length - 1].querySelector('input[placeholder="value"]')?.focus();
                });
            }
        });

        // Alt+click → toggle column background highlight on/off
        // Debounced so a dblclick (which fires two click events) doesn't accidentally toggle.
        li.addEventListener('click', e => {
            if (!e.altKey) return;
            e.stopPropagation();
            clearTimeout(_colClickTimer);
            _colClickTimer = setTimeout(() => {
                const on = li.classList.toggle(COL_THEMES[0]);
                if (!tableData.colHighlights) tableData.colHighlights = {};
                if (on) {
                    tableData.colHighlights[col.name] = COL_THEMES[0];
                } else {
                    delete tableData.colHighlights[col.name];
                }
            }, 220);
        });

        // Right-click → flash the matching row in the SELECT pane
        li.addEventListener('contextmenu', e => {
            e.preventDefault();
            e.stopPropagation();
            const table = State.tables.find(t => t.id === tableId);
            if (!table) return;

            const key = `${table.alias}.${col.name}`;

            // Alt+right-click → focus matching column in the results table
            if (e.altKey) {
                if (typeof Results !== 'undefined') Results.focusColumn?.(key);
                return;
            }

            const globalIdx = State.columnOrder.indexOf(key);
            if (globalIdx === -1) return;

            const selectRow = document.querySelector(`.select-col-row[data-idx="${globalIdx}"]`);
            if (!selectRow) return;

            selectRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            selectRow.classList.remove('is-highlighted');
            void selectRow.offsetWidth; // force reflow to restart animation
            selectRow.classList.add('is-highlighted');
            setTimeout(() => selectRow.classList.remove('is-highlighted'), 7000);
        });

        return li;
    }

    // =========================================================================
    // Extract distinct table names referenced in a SQL string
    // =========================================================================
    function _extractTablesFromSql(sql) {
        const cleaned = sql
            .replace(/--[^\n]*/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '');
        const tables = new Set();
        const re = /\b(?:FROM|JOIN)\s+`?([\w.]+)`?/gi;
        let m;
        while ((m = re.exec(cleaned)) !== null) {
            tables.add(m[1]);
        }
        return [...tables];
    }

    // =========================================================================
    // Subquery column row — draggable virtual column with a remove button
    // =========================================================================
    function _buildSubqueryColumnRow(col, tableData, colList) {
        const li           = document.createElement('li');
        li.className       = 'table-card__col sq-col-row';
        li.dataset.col     = col.name;
        li.dataset.tableId = tableData.id;
        li.draggable       = true;
        li.title           = col.name + '  —  subquery column';

        const nameSpan       = document.createElement('span');
        nameSpan.className   = 'table-card__col-name';
        nameSpan.textContent = col.name;

        const removeBtn       = document.createElement('button');
        removeBtn.className   = 'sq-col-remove btn-icon';
        removeBtn.textContent = '×';
        removeBtn.title       = 'Remove column';
        removeBtn.addEventListener('mousedown', e => e.stopPropagation());
        removeBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            tableData.columns = tableData.columns.filter(c => c.name !== col.name);
            // Delete any joins that reference this virtual column (removes SVG line + label too)
            if (typeof Joins !== 'undefined') {
                State.joins
                    .filter(j => (j.fromTableId === tableData.id && j.fromCol === col.name) ||
                                 (j.toTableId   === tableData.id && j.toCol   === col.name))
                    .forEach(j => Joins.deleteJoin(j.id));
            }
            li.remove();
            if (typeof QueryPanel !== 'undefined') QueryPanel.refresh();
            App.updateSQLPreview?.();
        });

        li.addEventListener('dblclick', e => {
            e.stopPropagation();
            const zone = document.querySelector('.drop-zone[data-section="where"]');
            if (zone) {
                QueryPanel.onColumnDrop(zone, tableData.id, col.name);
                document.getElementById('section-where')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                requestAnimationFrame(() => {
                    const rows = document.getElementById('where-conditions')?.querySelectorAll('.condition-row');
                    if (rows?.length) rows[rows.length - 1].querySelector('input[placeholder="value"]')?.focus();
                });
            }
        });

        li.append(nameSpan, removeBtn);
        return li;
    }

    // =========================================================================
    // Card events
    // =========================================================================
    function _bindCardEvents(card, tableData) {
        // Auto-select island on any mousedown/touchstart within the card.
        // Capture phase ensures this fires even when child elements call stopPropagation().
        const _selectIsland = () => {
            if (typeof Islands !== 'undefined') Islands.onTableMousedown(tableData.id);
        };
        card.addEventListener('mousedown',  _selectIsland, { capture: true });
        card.addEventListener('touchstart', _selectIsland, { capture: true, passive: true });

        const header      = card.querySelector('.table-card__header');
        const aliasInput  = card.querySelector('.table-card__alias');
        const colSearchEl = card.querySelector('.col-search');

        // --- Column filter (normal tables only) ---
        if (colSearchEl) {
            colSearchEl.addEventListener('mousedown', e => e.stopPropagation()); // don't start card drag
            colSearchEl.addEventListener('input', e => {
                const term    = e.target.value.trim().toLowerCase();
                const colList = card.querySelector('.table-card__columns');
                let visible   = 0;

                colList.querySelectorAll('li[data-col]').forEach(li => {
                    const match = li.dataset.col.toLowerCase().includes(term);
                    li.style.display = match ? '' : 'none';
                    if (match) visible++;
                });

                // No-match hint
                let noMatch = colList.querySelector('.col-search-no-match');
                if (visible === 0 && term !== '') {
                    if (!noMatch) {
                        noMatch = document.createElement('li');
                        noMatch.className = 'col-search-no-match';
                        colList.appendChild(noMatch);
                    }
                    noMatch.textContent = 'No match';
                } else if (noMatch) {
                    noMatch.remove();
                }
            });
        }

        // --- Subquery textarea + virtual column adder ---
        if (tableData.isSubquery) {
            const sqTextarea = card.querySelector('.subquery-textarea');

            // NOTE: SqlBackdrop is intentionally NOT attached to the card textarea by
            // default.  The sq-html-chk toggle attaches/detaches it in lite mode
            // (syntax colours only — no scope, no bookmarks, no line colours, no click-highlight).
            const sqHtmlChkEl = card.querySelector('.sq-html-chk');
            sqHtmlChkEl.addEventListener('change', () => {
                tableData.htmlHighlight = sqHtmlChkEl.checked;
                if (typeof SqlBackdrop === 'undefined') return;
                if (sqHtmlChkEl.checked) {
                    SqlBackdrop.attach(sqTextarea, { lite: true });
                    SqlBackdrop.setScopeToggleShortcut(sqTextarea, false);
                } else {
                    SqlBackdrop.detach(sqTextarea);
                }
            });
            // Re-attach on load if the saved state had it on
            if (tableData.htmlHighlight && typeof SqlBackdrop !== 'undefined') {
                SqlBackdrop.attach(sqTextarea, { lite: true });
                SqlBackdrop.setScopeToggleShortcut(sqTextarea, false);
            }

            // Per-textarea undo/redo stack
            if (typeof UndoManager !== 'undefined') UndoManager.attach(sqTextarea);

            const sqExpandBtn = card.querySelector('.sq-expand-btn');
            sqExpandBtn.addEventListener('mousedown', e => e.stopPropagation());
            sqExpandBtn.addEventListener('click', e => {
                e.stopPropagation();
                App.openSqExpand?.(sqTextarea);
            });

            const sqExplainBtn = card.querySelector('.sq-explain-btn');
            sqExplainBtn.addEventListener('mousedown', e => e.stopPropagation());
            sqExplainBtn.addEventListener('click', e => {
                e.stopPropagation();
                const sql = sqTextarea.value.trim();
                if (!sql) return;
                const bound = _bindSqlVariables(sql);
                const final = bound ?? sql;
                App.runSql?.(/^explain\s/i.test(final) ? final : 'EXPLAIN ' + final);
            });

            const sqRunBtn = card.querySelector('.sq-run-btn');
            sqRunBtn.addEventListener('mousedown', e => e.stopPropagation());
            sqRunBtn.addEventListener('click', e => {
                e.stopPropagation();
                const sql = sqTextarea.value.trim();
                if (!sql) return;
                App.runSql?.(sql);
            });

            const sqTablesMenu    = card.querySelector('.tables-menu');
            const sqTablesTrigger = sqTablesMenu.querySelector('.btn-tables-trigger');
            sqTablesMenu.addEventListener('mousedown', e => e.stopPropagation());
            App.bindTablesMenu?.(sqTablesTrigger, () => sqTextarea.value);

            sqTextarea.addEventListener('mousedown', e => e.stopPropagation());
            sqTextarea.addEventListener('input', () => {
                tableData.subquery = sqTextarea.value;
                App.updateSQLPreview?.();
            });
            sqTextarea.addEventListener('keydown', e => {
                if (e.shiftKey && e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    App.openSqExpand?.(sqTextarea);
                }
                if (e.altKey && e.code === 'KeyL') {
                    e.preventDefault();
                    e.stopPropagation();
                    App.loadFileIntoSubquery?.(sqTextarea);
                }
            });

            const sqColInput = card.querySelector('.sq-col-input');
            const sqColBtn   = card.querySelector('.sq-col-btn');
            const colList    = card.querySelector('.table-card__columns');

            const _addVirtualCol = () => {
                const name = sqColInput.value.trim();
                if (!name) return;
                if (tableData.columns.find(c => c.name === name)) {
                    App.notify?.('Column "' + name + '" already exists.', 'warn');
                    return;
                }
                if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                const col = { name, type: '', shortType: '', key: '', nullable: '', extra: '' };
                tableData.columns.push(col);
                colList.appendChild(_buildSubqueryColumnRow(col, tableData, colList));
                sqColInput.value = '';
                // Update columnOrder so the col appears in the SELECT panel
                const key = tableData.alias + '.' + name;
                if (!State.columnOrder.includes(key)) State.columnOrder.push(key);
                if (typeof QueryPanel !== 'undefined') QueryPanel.refresh();
                App.updateSQLPreview?.();
            };

            sqColInput.addEventListener('mousedown', e => e.stopPropagation());
            sqColInput.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); _addVirtualCol(); }
            });
            sqColBtn.addEventListener('mousedown', e => e.stopPropagation());
            sqColBtn.addEventListener('click',     e => { e.stopPropagation(); _addVirtualCol(); });

            // ── Load file (drag-drop only — no button) ────────────────────────
            const sqFileInput = card.querySelector('.sq-file-input');
            sqFileInput.addEventListener('change', () => {
                const file = sqFileInput.files[0];
                if (file) _loadFileIntoTextarea(file, sqTextarea);
            });

            // ── Drag-and-drop file onto the subquery body ─────────────────────
            const sqBody_       = card.querySelector('.subquery-body');
            const sqDropOverlay = card.querySelector('.sq-drop-overlay');
            const _isFileDrag   = dt => dt?.types?.includes('Files');

            sqBody_.addEventListener('dragenter', e => {
                if (!_isFileDrag(e.dataTransfer)) return;
                e.preventDefault();
                e.stopPropagation();
                if (!e.relatedTarget || !sqBody_.contains(e.relatedTarget)) {
                    sqDropOverlay.classList.add('visible');
                }
            });
            sqBody_.addEventListener('dragover', e => {
                if (!_isFileDrag(e.dataTransfer)) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'copy';
            });
            sqBody_.addEventListener('dragleave', e => {
                e.stopPropagation();
                if (!e.relatedTarget || !sqBody_.contains(e.relatedTarget)) {
                    sqDropOverlay.classList.remove('visible');
                }
            });
            sqBody_.addEventListener('drop', e => {
                e.preventDefault();
                e.stopPropagation();
                sqDropOverlay.classList.remove('visible');
                const file = [...(e.dataTransfer.files || [])].find(f => {
                    const n = f.name.toLowerCase();
                    return n.endsWith('.sql') || n.endsWith('.csv') || f.type.startsWith('text/');
                });
                if (!file) { App.notify?.('Please drop a .sql or .csv file.', 'warn'); return; }
                _loadFileIntoTextarea(file, sqTextarea);
            });
        }

        // --- Drag to reposition (mousedown on header) ---
        header.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            // Don't initiate drag when clicking alias input, remove button, or DDL button
            if (e.target.tagName === 'INPUT' || e.target.classList.contains('table-card__remove') || e.target.classList.contains('table-card__ddl-btn')) return;

            // Auto-select island when touching a table from an unselected island
            if (typeof Islands !== 'undefined') Islands.onTableMousedown(tableData.id);

            const wrapper = document.getElementById('canvas-wrapper');
            const rect    = wrapper.getBoundingClientRect();
            const s       = _canvasContentScale();

            _drag.active  = true;
            _drag.cardEl  = card;
            _drag.tableId = tableData.id;
            // Offset = how far inside the card the mouse clicked (logical canvas coords)
            _drag.offsetX = (e.clientX - rect.left + wrapper.scrollLeft) / s - (parseInt(card.style.left, 10) || 0);
            _drag.offsetY = (e.clientY - rect.top  + wrapper.scrollTop)  / s - (parseInt(card.style.top,  10) || 0);

            card.classList.add('dragging');
            e.preventDefault();
        });

        // --- Quick note ---
        const noteInput = card.querySelector('.table-card__quick-note');
        noteInput.addEventListener('mousedown', e => e.stopPropagation());
        noteInput.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === 'Escape') e.target.blur();
        });
        noteInput.addEventListener('input', () => {
            tableData.note = noteInput.value;
            App.updateSQLPreview?.();
        });

        // Right-click / double-click → open the expr popup as an extended note editor.
        // This popup manages tableData.noteDetail — a separate field from the inline
        // tableData.note label.  Neither field updates the other; both are persisted
        // in the context automatically as part of tableData.
        // Shift+Enter saves the currently loaded context without closing the popup.
        App.bindNotePopup?.(
            noteInput,
            () => {
                const tableRef = tableData.database
                    ? `${tableData.database}.${tableData.name}`
                    : tableData.name;
                return `NOTE — ${tableRef} (${tableData.alias})`;
            },
            () => tableData.noteDetail ?? '',
            val => { tableData.noteDetail = val; },
            () => noteInput.focus(),
            () => App.saveLoadedContext?.()
        );

        // --- Copy buttons ---
        // For subquery tables these copy the subquery SQL itself
        const tableRef = tableData.isSubquery
            ? '(' + (tableData.subquery?.trim() || '…') + ')'
            : tableData.database
                ? `${tableData.database}.${tableData.name}`
                : tableData.name;

        const _buildWhereForTable = alias => {
            const parts = [];
            (State.where || []).forEach(c => {
                if (c.enabled === false || c.type === 'raw') return;
                if (!c.col || c.col.split('.')[0] !== alias) return;
                let part = '';
                if      (c.op === 'IS NULL')     part = `${c.col} IS NULL`;
                else if (c.op === 'IS NOT NULL') part = `${c.col} IS NOT NULL`;
                else if (c.op === 'IN' || c.op === 'NOT IN') {
                    const vals = String(c.val ?? '').split(',').map(v => v.trim()).filter(v => v);
                    part = `${c.col} ${c.op} (${vals.join(', ')})`;
                } else if (c.op === 'BETWEEN' || c.op === 'NOT BETWEEN') {
                    part = `${c.col} ${c.op} ${c.val ?? ''} AND ${c.val2 ?? ''}`;
                } else {
                    part = `${c.col} ${c.op} ${c.val ?? ''}`;
                }
                if (c.startGroup) part = '(' + part;
                if (c.endGroup)   part = part + ')';
                parts.length === 0 ? parts.push(part) : parts.push(`${c.operator || 'AND'} ${part}`);
            });
            return parts.join(' ');
        };

        if (tableData.isSubquery) {
            // Count button doesn't apply to subqueries
            card.querySelector('.table-card__count-btn').style.display = 'none';

            // # button: copy table list + COUNT queries to clipboard
            card.querySelector('.table-card__sq-count-btn').addEventListener('click', e => {
                e.stopPropagation();
                const ta     = card.querySelector('.subquery-textarea');
                const sql    = ta ? ta.value : '';
                const tables = _extractTablesFromSql(sql);
                if (!tables.length) return;
                const list   = tables.join('\n');
                const counts = tables.map(t => `SELECT count(id) FROM ${t};`).join('\n');
                navigator.clipboard.writeText(list + '\n\n' + counts);
            });

            // S button: save subquery SQL to disk via native browser download
            card.querySelector('.table-card__copy-simple-btn').addEventListener('click', e => {
                e.stopPropagation();
                const ta  = card.querySelector('.subquery-textarea');
                const sql = ta ? ta.value : '';
                const blob = new Blob([sql], { type: 'text/plain' });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href     = url;
                a.download = (tableData.name || 'subquery') + '.sql';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            });

            // L button: load .sql or .csv file into this subquery (same as Alt+L)
            card.querySelector('.table-card__sq-load-btn').addEventListener('click', e => {
                e.stopPropagation();
                const ta = card.querySelector('.subquery-textarea');
                if (ta) App.loadFileIntoSubquery?.(ta);
            });
        } else {
            card.querySelector('.table-card__copy-simple-btn').addEventListener('click', e => {
                e.stopPropagation();
                navigator.clipboard.writeText(`SELECT * FROM ${tableRef} ORDER BY id DESC LIMIT 10`);
            });

            card.querySelector('.table-card__count-btn').addEventListener('click', e => {
                e.stopPropagation();
                navigator.clipboard.writeText(`SELECT COUNT(*) FROM ${tableRef}`);
            });
        }

        card.querySelector('.table-card__copy-filtered-btn').addEventListener('click', e => {
            e.stopPropagation();
            const where = _buildWhereForTable(tableData.alias);
            const sql = where
                ? `SELECT * FROM ${tableRef} WHERE ${where} ORDER BY id DESC LIMIT 10`
                : `SELECT * FROM ${tableRef} ORDER BY id DESC LIMIT 10`;
            navigator.clipboard.writeText(sql);
        });

        card.querySelector('.table-card__search-btn').addEventListener('click', e => {
            e.stopPropagation();
            Canvas._openTableSearch?.(tableData.id);
        });

        // --- Join order dropdown ---
        const orderSel  = card.querySelector('.table-card__order');
        const tableId   = tableData.id;   // capture ID — never goes stale
        orderSel.addEventListener('mousedown', e => e.stopPropagation()); // prevent card drag

        // --- Flag button: set this table as join start, BFS-order the rest ---
        const flagBtn = card.querySelector('.table-card__flag-btn');
        flagBtn.addEventListener('mousedown', e => e.stopPropagation());
        flagBtn.addEventListener('click', () => {
            const t = State.tables.find(t => t.id === tableId);
            if (!t) return;
            const ej        = State.joins.filter(j => j.enabled !== false);
            const islands   = App.computeIslands(State.tables, ej);
            const myIsland  = islands.find(g => g.includes(tableId)) ?? [tableId];
            const orderMap  = App.bfsOrder(tableId, myIsland, ej);
            State.tables.forEach(tbl => {
                if (orderMap[tbl.id] !== undefined) tbl.order = orderMap[tbl.id];
            });
            // Persist anchor for this island
            const islandKey = [...myIsland].sort().join('|');
            if (!State.islandConfigs)             State.islandConfigs = {};
            if (!State.islandConfigs[islandKey])  State.islandConfigs[islandKey] = {};
            State.islandConfigs[islandKey].anchorTableId = tableId;
            _refreshAllOrderDropdowns();
            App.updateSQLPreview();
            App.notify?.(`"${t.alias}" set as join anchor`, 'success');
        });

        // --- Cut button: enter/exit cut mode for this card ---
        const cutBtn = card.querySelector('.table-card__cut-btn');
        cutBtn.addEventListener('mousedown', e => e.stopPropagation());
        cutBtn.addEventListener('click', () => {
            if (_cut.tableId === tableId) {
                _exitCutMode();
                return;
            }
            if (_cut.tableId) _exitCutMode();   // cancel any other cut in progress
            _cut.tableId = tableId;
            _cut.cardEl  = card;
            card.classList.add('is-cut');
            cutBtn.classList.add('is-active');
            document.body.classList.add('is-cut-mode');
        });

        orderSel.addEventListener('change', () => {
            const t = State.tables.find(t => t.id === tableId);
            if (!t) return;
            const newOrder = parseInt(orderSel.value, 10);
            const oldOrder = t.order;
            if (newOrder === oldOrder) return;
            // Swap with the table that currently holds the chosen order, scoped to the same island
            const _ej      = State.joins.filter(j => j.enabled !== false);
            const _islands = App.computeIslands(State.tables, _ej);
            const _myGroup = _islands.find(g => g.includes(tableId));
            const _myIds   = new Set(_myGroup ?? [tableId]);
            const other = State.tables.find(t => t.order === newOrder && t.id !== tableId && _myIds.has(t.id));
            if (other) other.order = oldOrder;
            t.order = newOrder;
            _refreshAllOrderDropdowns();
            App.updateSQLPreview();
        });

        // --- Alias inline edit ---
        aliasInput.addEventListener('mousedown', e => e.stopPropagation()); // don't start card drag
        aliasInput.addEventListener('focus', () => { if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot(); });

        aliasInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')  { e.target.blur(); }
            if (e.key === 'Escape') { e.target.value = tableData.alias; e.target.blur(); }
        });

        aliasInput.addEventListener('blur', (e) => {
            const newAlias = e.target.value.trim();
            if (!newAlias || newAlias === tableData.alias) {
                e.target.value = tableData.alias; // revert empty
                return;
            }
            _applyAliasChange(tableData, newAlias, e.target);
        });

        // --- Remove table ---
        card.querySelector('.table-card__remove').addEventListener('click', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            _removeTableFromState(tableData);
        });

        // --- Copy table name to clipboard ---
        const copyNameBtn = card.querySelector('.table-card__copy-name-btn');
        copyNameBtn.addEventListener('mousedown', e => e.stopPropagation());
        copyNameBtn.addEventListener('click', e => {
            e.stopPropagation();
            const name = tableData.database
                ? `${tableData.database}.${tableData.name}`
                : tableData.name;
            navigator.clipboard.writeText(name).then(() => {
                const prev = copyNameBtn.textContent;
                copyNameBtn.textContent = '✓';
                setTimeout(() => { copyNameBtn.textContent = prev; }, 1200);
            });
        });

        // --- Right-click table name → highlight + scroll to matching SELECT panel header ---
        if (!tableData.isSubquery) {
            const tnameEl = card.querySelector('.table-card__tname');
            tnameEl.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
                const hdr = document.querySelector(`.select-table-hdr[data-alias="${CSS.escape(tableData.alias)}"]`);
                if (!hdr) return;
                // Expand config panel if collapsed
                const configPanel = document.getElementById('config-panel');
                if (configPanel?.classList.contains('is-collapsed')) {
                    document.getElementById('btn-toggle-config')?.click();
                }
                hdr.scrollIntoView({ behavior: 'smooth', block: 'center' });
                hdr.classList.remove('select-hdr-flash');
                void hdr.offsetWidth; // restart animation
                hdr.classList.add('select-hdr-flash');
                setTimeout(() => hdr.classList.remove('select-hdr-flash'), 2000);
            });
        }

        // --- Card color picker ---
        const colorBtn = card.querySelector('.table-card__color-btn');
        colorBtn.addEventListener('mousedown', e => e.stopPropagation());
        colorBtn.addEventListener('click', e => {
            e.stopPropagation();
            _openColorPopup(card, tableData, colorBtn);
        });

        // --- Show CREATE TABLE statement (not applicable for subquery tables) ---
        const ddlBtn = card.querySelector('.table-card__ddl-btn');
        if (tableData.isSubquery) {
            ddlBtn.remove(); // subquery cards have no schema — button serves no purpose
        } else {
            ddlBtn.addEventListener('mousedown', e => e.stopPropagation()); // don't start card drag
            ddlBtn.addEventListener('click', async () => {
                if (typeof Modals !== 'undefined' && Modals.openCreateStatement) {
                    await Modals.openCreateStatement(tableData);
                }
            });
        }

        // --- Resize handles ---
        const _startResize = (e, handle) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            _resize.active    = true;
            _resize.handle    = handle;
            _resize.cardEl    = card;
            _resize.tableId   = tableData.id;
            _resize.startX    = e.clientX;
            _resize.startY    = e.clientY;
            _resize.startW    = card.offsetWidth;
            _resize.startH    = card.offsetHeight;
            _resize.startTop  = parseInt(card.style.top,  10) || 0;
            _resize.startLeft = parseInt(card.style.left, 10) || 0;

            card.classList.add('resizing');
            document.body.classList.add('is-card-resizing-' + handle);
        };

        card.querySelector('.table-card__resize')   .addEventListener('mousedown', e => _startResize(e, 'br'));
        card.querySelector('.table-card__resize-tr').addEventListener('mousedown', e => _startResize(e, 'tr'));
        card.querySelector('.table-card__resize-r') .addEventListener('mousedown', e => _startResize(e, 'r'));
        card.querySelector('.table-card__resize-tl').addEventListener('mousedown', e => _startResize(e, 'tl'));
        card.querySelector('.table-card__resize-bl').addEventListener('mousedown', e => _startResize(e, 'bl'));
        card.querySelector('.table-card__resize-l') .addEventListener('mousedown', e => _startResize(e, 'l'));
        card.querySelector('.table-card__resize-t') .addEventListener('mousedown', e => _startResize(e, 't'));
        card.querySelector('.table-card__resize-b') .addEventListener('mousedown', e => _startResize(e, 'b'));

        // Double-click any resize handle → fit height to content, dblclick again to restore
        const _toggleFitHeight = () => {
            if (!card.classList.contains('is-fit-height')) {
                // Expand: save current state, then let the card size to its content
                card.dataset.savedHeight    = card.style.height || '';
                card.dataset.savedIsResized = card.classList.contains('is-resized') ? '1' : '';
                card.style.height = '';
                card.classList.remove('is-resized');
                card.classList.add('is-fit-height');
            } else {
                // Restore: go back to whatever height the card had before
                card.classList.remove('is-fit-height');
                const h = card.dataset.savedHeight || '';
                card.style.height = h;
                if (h && card.dataset.savedIsResized === '1') card.classList.add('is-resized');
            }
            if (typeof Joins   !== 'undefined') Joins.redrawForTable(tableData.id);
            if (typeof Islands !== 'undefined') Islands.redrawPositions();
        };

        card.querySelectorAll('[class*="table-card__resize"]').forEach(h =>
            h.addEventListener('dblclick', e => { e.stopPropagation(); _toggleFitHeight(); })
        );
    }

    // =========================================================================
    // Global mouse move / up — handles both drag-to-reposition and resize
    // =========================================================================
    function _onMouseMove(e) {
        if (_drag.active) {
            const wrapper = document.getElementById('canvas-wrapper');
            const rect    = wrapper.getBoundingClientRect();
            const s       = _canvasContentScale();

            const x = Math.max(0, (e.clientX - rect.left + wrapper.scrollLeft) / s - _drag.offsetX);
            const y = Math.max(0, (e.clientY - rect.top  + wrapper.scrollTop)  / s - _drag.offsetY);

            _drag.cardEl.style.left = x + 'px';
            _drag.cardEl.style.top  = y + 'px';

            if (typeof Joins    !== 'undefined') Joins.redrawForTable(_drag.tableId);
            if (typeof Islands  !== 'undefined') Islands.redrawPositions();
            if (typeof Minimap  !== 'undefined') Minimap.scheduleUpdate();
            return;
        }

        if (_resize.active) {
            const MIN_W = 150;
            const MIN_H = 120;
            const s     = _canvasContentScale();
            const dx    = (e.clientX - _resize.startX) / s;
            const dy    = (e.clientY - _resize.startY) / s;

            if (_resize.handle === 'br') {
                _resize.cardEl.style.width  = Math.max(MIN_W, _resize.startW + dx) + 'px';
                _resize.cardEl.style.height = Math.max(MIN_H, _resize.startH + dy) + 'px';
            } else if (_resize.handle === 'r') {
                _resize.cardEl.style.width  = Math.max(MIN_W, _resize.startW + dx) + 'px';
            } else if (_resize.handle === 'tr') {
                const newW   = Math.max(MIN_W, _resize.startW + dx);
                const newH   = Math.max(MIN_H, _resize.startH - dy);
                const newTop = Math.max(0, _resize.startTop + (_resize.startH - newH));
                _resize.cardEl.style.width  = newW   + 'px';
                _resize.cardEl.style.height = newH   + 'px';
                _resize.cardEl.style.top    = newTop + 'px';
            } else if (_resize.handle === 'bl') {
                const newW    = Math.max(MIN_W, _resize.startW - dx);
                const newLeft = Math.max(0, _resize.startLeft + _resize.startW - newW);
                _resize.cardEl.style.width  = newW    + 'px';
                _resize.cardEl.style.height = Math.max(MIN_H, _resize.startH + dy) + 'px';
                _resize.cardEl.style.left   = newLeft + 'px';
            } else if (_resize.handle === 'l') {
                const newW    = Math.max(MIN_W, _resize.startW - dx);
                const newLeft = Math.max(0, _resize.startLeft + _resize.startW - newW);
                _resize.cardEl.style.width  = newW    + 'px';
                _resize.cardEl.style.left   = newLeft + 'px';
            } else if (_resize.handle === 'tl') {
                const newW    = Math.max(MIN_W, _resize.startW - dx);
                const newLeft = Math.max(0, _resize.startLeft + _resize.startW - newW);
                const newH    = Math.max(MIN_H, _resize.startH - dy);
                const newTop  = Math.max(0, _resize.startTop  + _resize.startH - newH);
                _resize.cardEl.style.width  = newW    + 'px';
                _resize.cardEl.style.height = newH    + 'px';
                _resize.cardEl.style.left   = newLeft + 'px';
                _resize.cardEl.style.top    = newTop  + 'px';
            } else if (_resize.handle === 'b') {
                _resize.cardEl.style.height = Math.max(MIN_H, _resize.startH + dy) + 'px';
            } else if (_resize.handle === 't') {
                const newH   = Math.max(MIN_H, _resize.startH - dy);
                const newTop = Math.max(0, _resize.startTop + (_resize.startH - newH));
                _resize.cardEl.style.height = newH   + 'px';
                _resize.cardEl.style.top    = newTop + 'px';
            }

            _resize.cardEl.classList.add('is-resized');
            if (typeof Joins   !== 'undefined') Joins.redrawForTable(_resize.tableId);
            if (typeof Islands !== 'undefined') Islands.redrawPositions();
            return;
        }

        if (_pan.active) {
            const wrapper = document.getElementById('canvas-wrapper');
            const dx = e.clientX - _pan.startX;
            const dy = e.clientY - _pan.startY;

            wrapper.scrollLeft = _pan.scrollX - dx;
            wrapper.scrollTop  = _pan.scrollY - dy;
        }
    }

    function _onMouseUp() {
        if (_drag.active) {
            _drag.active = false;
            _drag.cardEl.classList.remove('dragging');

            // Persist final position back to State
            const t = State.tables.find(t => t.id === _drag.tableId);
            if (t) {
                if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                t.position = {
                    x: parseInt(_drag.cardEl.style.left, 10) || 0,
                    y: parseInt(_drag.cardEl.style.top,  10) || 0,
                };
            }

            _drag.cardEl  = null;
            _drag.tableId = null;
            if (typeof Minimap !== 'undefined') Minimap.update();
            return;
        }

        if (_resize.active) {
            _resize.cardEl.classList.remove('resizing');
            document.body.classList.remove('is-card-resizing-' + _resize.handle);

            // Persist final size back to State
            const t = State.tables.find(t => t.id === _resize.tableId);
            if (t) {
                if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                t.size = {
                    w: parseInt(_resize.cardEl.style.width,  10) || 200,
                    h: parseInt(_resize.cardEl.style.height, 10) || null,
                };
                // Handles that shift the card's x or y position — persist them
                const movesX = ['bl', 'l', 'tl'].includes(_resize.handle);
                const movesY = ['tr', 'tl', 't'].includes(_resize.handle);
                if (movesX || movesY) {
                    if (!t.position) t.position = { x: 0, y: 0 };
                    if (movesX) t.position.x = parseInt(_resize.cardEl.style.left, 10) || 0;
                    if (movesY) t.position.y = parseInt(_resize.cardEl.style.top,  10) || 0;
                }
            }

            _resize.active    = false;
            _resize.handle    = 'br';
            _resize.cardEl    = null;
            _resize.tableId   = null;
            _resize.startLeft = 0;
            if (typeof Minimap !== 'undefined') Minimap.update();
            return;
        }

        if (_pan.active) {
            _pan.active = false;
            document.getElementById('canvas-wrapper').style.cursor = '';
            // Suppress the context menu that fires when the mouse is released outside the canvas
            document.addEventListener('contextmenu', e => e.preventDefault(), { once: true, capture: true });
        }
    }

    // =========================================================================
    // Cut-and-place click handler
    // Click anywhere in the canvas area places the cut table under the cursor
    // (mouse position = top-centre of the placed card).
    // Same island → keeps joins. Different island or bare canvas → strips joins.
    // =========================================================================

    /** Returns the island key of the island rect that contains the given viewport point, or null. */
    function _islandKeyAtPoint(clientX, clientY) {
        const els = document.querySelectorAll('#island-rects .island-rect[data-island-key]');
        let bestKey = null;
        let bestArea = Infinity;
        for (const el of els) {
            const bb = el.getBoundingClientRect();
            if (clientX >= bb.left && clientX <= bb.right && clientY >= bb.top && clientY <= bb.bottom) {
                const area = bb.width * bb.height;
                if (area < bestArea) {
                    bestArea = area;
                    bestKey = el.dataset.islandKey;
                }
            }
        }
        return bestKey;
    }

    function _onCanvasClick(e) {
        if (!_cut.tableId) return;

        // Ignore clicks on the cut card itself (e.g. cancelling via the cut button)
        if (_cut.cardEl && _cut.cardEl.contains(e.target)) return;

        // Ignore clicks on interactive elements on other cards/UI (buttons, inputs, selects)
        // — we don't want a paste to fire alongside an unrelated button action
        if (e.target.closest('button, input, select')) return;

        // Only act inside the canvas wrapper
        const wrapper = document.getElementById('canvas-wrapper');
        if (!wrapper || !wrapper.contains(e.target)) return;

        // Determine whether the paste lands in the cut table's own island or elsewhere
        const clickedIslandKey = _islandKeyAtPoint(e.clientX, e.clientY);
        const ej        = State.joins.filter(j => j.enabled !== false);
        const islands   = App.computeIslands(State.tables, ej);
        const cutIsland = islands.find(g => g.includes(_cut.tableId));
        const cutKey    = cutIsland ? [...cutIsland].sort().join('|') : null;

        if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();

        // Different island or bare canvas → strip all joins for this table
        const joinsRemoved = !clickedIslandKey || clickedIslandKey !== cutKey;
        if (joinsRemoved) {
            if (typeof Joins !== 'undefined') Joins.removeForTable(_cut.tableId);
            State.joins = State.joins.filter(
                j => j.fromTableId !== _cut.tableId && j.toTableId !== _cut.tableId
            );
        }

        // Position: mouse = top-centre of placed card
        const rect = wrapper.getBoundingClientRect();
        const s    = _canvasContentScale();
        const x    = Math.max(0, (e.clientX - rect.left + wrapper.scrollLeft) / s - (_cut.cardEl.offsetWidth / 2));
        const y    = Math.max(0, (e.clientY - rect.top  + wrapper.scrollTop) / s);

        _cut.cardEl.style.left = x + 'px';
        _cut.cardEl.style.top  = y + 'px';

        const t = State.tables.find(t => t.id === _cut.tableId);
        if (t) t.position = { x, y };

        if (typeof Joins !== 'undefined') Joins.redrawForTable(_cut.tableId);

        if (joinsRemoved) {
            if (typeof Islands !== 'undefined') Islands.recompute();
        } else {
            if (typeof Islands !== 'undefined') Islands.redrawPositions();
        }

        _refreshAllOrderDropdowns();
        App.updateSQLPreview();
        _exitCutMode();
    }

    // =========================================================================
    // Alias cascade
    // Updates State + all SELECT / WHERE / ORDER BY references to the old alias
    // =========================================================================
    function _applyAliasChange(tableData, newAlias, inputEl) {
        // Check uniqueness
        const taken = State.tables
            .filter(t => t.id !== tableData.id)
            .map(t => t.alias);

        if (taken.includes(newAlias)) {
            App.notify(`Alias "${newAlias}" is already used by another table.`, 'warn');
            inputEl.value = tableData.alias;
            return;
        }

        const oldAlias = tableData.alias;

        // Update state reference
        tableData.alias = newAlias;

        // Cascade: SELECT
        State.select = State.select.map(s =>
            s.startsWith(oldAlias + '.') ? newAlias + s.slice(oldAlias.length) : s
        );

        // Cascade: columnOrder
        State.columnOrder = State.columnOrder.map(s =>
            s.startsWith(oldAlias + '.') ? newAlias + s.slice(oldAlias.length) : s
        );

        // Cascade: WHERE (visual conditions — col selector)
        State.where.forEach(cond => {
            if (cond.col?.startsWith(oldAlias + '.')) {
                cond.col = newAlias + cond.col.slice(oldAlias.length);
            }
        });

        // Cascade: ORDER BY
        State.orderBy.forEach(ord => {
            if (ord.col?.startsWith(oldAlias + '.')) {
                ord.col = newAlias + ord.col.slice(oldAlias.length);
            }
        });

        // Cascade: JOINs
        State.joins.forEach(j => {
            if (j.fromAlias === oldAlias) j.fromAlias = newAlias;
            if (j.toAlias   === oldAlias) j.toAlias   = newAlias;
        });

        // Cascade: free-form SQL strings (WHERE expr inputs, WHERE raw, Custom Expressions)
        const _aliasRe = new RegExp('\\b' + oldAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.', 'g');
        State.where.forEach(cond => {
            if (cond.expr) cond.expr = cond.expr.replace(_aliasRe, newAlias + '.');
        });
        if (State.whereRaw) {
            State.whereRaw = State.whereRaw.replace(_aliasRe, newAlias + '.');
        }
        (State.selectCustomExprs ?? []).forEach(ce => {
            if (ce.expr) ce.expr = ce.expr.replace(_aliasRe, newAlias + '.');
        });

        App.updateSQLPreview();
        if (typeof QueryPanel !== 'undefined') QueryPanel.refresh();
    }

    // =========================================================================
    // Remove table — cleans up State, DOM, sidebar, and any joins
    // =========================================================================
    function _removeTableFromState(tableData) {
        const { id: tableId, name: tableName, alias } = tableData;

        // Clean SELECT, WHERE, ORDER BY references for this alias
        State.select  = State.select.filter(s  => !s.startsWith(alias + '.'));
        State.columnOrder = State.columnOrder.filter(s => !s.startsWith(alias + '.'));
        State.where   = State.where.filter(w   => !w.col?.startsWith(alias + '.'));
        State.orderBy = State.orderBy.filter(o => !o.col?.startsWith(alias + '.'));
        if (State.selectAliases) {
            Object.keys(State.selectAliases).forEach(k => {
                if (k.startsWith(alias + '.')) delete State.selectAliases[k];
            });
        }

        // Phase 4: remove SVG join lines BEFORE pruning State.joins
        if (typeof Joins !== 'undefined') Joins.removeForTable(tableId);

        // Remove joins involving this table
        State.joins = State.joins.filter(
            j => j.fromTableId !== tableId && j.toTableId !== tableId
        );

        // Remove from State.tables
        State.tables = State.tables.filter(t => t.id !== tableId);
        if (window.updateCanvasCount) window.updateCanvasCount();

        // Compact order numbers so there are no gaps (e.g. 1,3 → 1,2)
        [...State.tables]
            .sort((a, b) => (a.order ?? 1) - (b.order ?? 1))
            .forEach((t, i) => { t.order = i + 1; });

        // Remove card from DOM, then refresh remaining dropdowns
        _removeCardEl(tableId);
        _refreshAllOrderDropdowns();


        // Un-mark in sidebar (match by name AND database so tables with the same
        // name in different schemas don't accidentally lose their on-canvas state)
        const dbAttr = tableData.database || '';
        const li = document.querySelector(
            `#table-list li[data-table="${tableName}"][data-database="${dbAttr}"]`
        );
        if (li) li.classList.remove('on-canvas');

        // Show hint again if canvas is now empty
        if (State.tables.length === 0) {
            const hint = document.getElementById('canvas-hint');
            if (hint) hint.style.display = '';
        }

        if (typeof App !== 'undefined') App.cleanupPinsForRemovedTable(tableId);
        if (typeof Islands !== 'undefined') Islands.recompute();

        // If recompute() nulled the selected island (the removed table was in it),
        // re-select the single surviving island now — before updateSQLPreview() calls
        // _flushCurrentIslandConfig(), which via _currentIslandKey() would otherwise
        // fall back to that surviving island and overwrite its saved config with the
        // stale flat state left over from the deleted island.
        if (!State.selectedIslandKey && State.tables.length > 0 && typeof App !== 'undefined') {
            const enabledJoins = State.joins.filter(j => j.enabled !== false);
            const remaining    = App.computeIslands(State.tables, enabledJoins);
            if (remaining.length === 1) {
                const survivingKey = [...remaining[0]].sort().join('|');
                State.selectedIslandKey = survivingKey;
                App.blitIslandConfig?.(survivingKey);
            }
        }

        App.updateSQLPreview();
        if (typeof QueryPanel !== 'undefined') QueryPanel.refresh();

        if (typeof Results !== 'undefined') {
            Results.calcMarkOutOfSync();
            Results.clear();
        }
    }

    // =========================================================================
    // Card color picker
    // =========================================================================

    function _applyCardColor(card, color) {
        const header   = card.querySelector('.table-card__header');
        const colorBtn = card.querySelector('.table-card__color-btn');
        if (color) {
            header.style.background = color;
            card.style.borderColor  = color;
            if (colorBtn) {
                colorBtn.style.color = 'rgba(255,255,255,0.85)';
                colorBtn.classList.add('has-color');
            }
        } else {
            header.style.background = '';
            card.style.borderColor  = '';
            if (colorBtn) {
                colorBtn.style.color = '';
                colorBtn.classList.remove('has-color');
            }
        }
    }

    function _openColorPopup(card, tableData, anchorEl) {
        // Toggle: close if already open for this card
        if (_colorPopup && _colorPopupCard === card) {
            _closeColorPopup();
            return;
        }
        _closeColorPopup();

        _colorPopupCard  = card;
        _colorPopupTable = tableData;

        _colorPopup = document.createElement('div');
        _colorPopup.className = 'card-color-popup';

        // Swatches
        const swatchWrap = document.createElement('div');
        swatchWrap.className = 'card-color-swatches';

        CARD_COLORS.forEach(({ hex, label }) => {
            const swatch = document.createElement('button');
            swatch.className = 'card-color-swatch';
            swatch.title = label;
            swatch.style.background = hex;
            if (tableData.color === hex) swatch.classList.add('is-active');
            swatch.addEventListener('click', e => {
                e.stopPropagation();
                if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                tableData.color = hex;
                _applyCardColor(card, hex);
                QueryPanel.refresh?.();
                Results.refreshHeaderColors?.();
                if (typeof Minimap !== 'undefined') Minimap.update();
                _closeColorPopup();
            });
            swatchWrap.appendChild(swatch);
        });

        // Reset button
        const resetBtn = document.createElement('button');
        resetBtn.className = 'card-color-reset';
        resetBtn.textContent = '✕ Reset color';
        resetBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            tableData.color = null;
            _applyCardColor(card, null);
            QueryPanel.refresh?.();
            Results.refreshHeaderColors?.();
            if (typeof Minimap !== 'undefined') Minimap.update();
            _closeColorPopup();
        });

        _colorPopup.appendChild(swatchWrap);
        _colorPopup.appendChild(resetBtn);
        document.body.appendChild(_colorPopup);

        // Position below the anchor button
        const rect = anchorEl.getBoundingClientRect();
        const popW = 160; // approximate
        let left = rect.left;
        let top  = rect.bottom + 6;

        // Keep inside viewport
        if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;

        _colorPopup.style.left = left + 'px';
        _colorPopup.style.top  = top  + 'px';

        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', _closeColorPopup, { once: true });
        }, 0);
    }

    function _closeColorPopup() {
        if (_colorPopup) {
            _colorPopup.remove();
            _colorPopup      = null;
            _colorPopupCard  = null;
            _colorPopupTable = null;
        }
    }

    // =========================================================================
    // Helpers
    // =========================================================================
    function _removeCardEl(tableId) {
        const el = document.querySelector(`.table-card[data-table-id="${tableId}"]`);
        if (el) el.remove();
    }

    /**
     * Auto-size a freshly added card to fit its content.
     * Width: let the browser compute max-content width, then apply it.
     * Height: add is-resized to remove the column list max-height cap so all rows show.
     * Saves the computed width back to tableData.size so context saves it correctly.
     */
    function _autoSize(card, tableData) {
        // Measure natural content width
        card.style.width = 'max-content';
        const naturalW = card.offsetWidth;
        let w = Math.max(200, naturalW + 2); // +2 guards against sub-pixel rounding
        if (tableData.isSubquery) w *= 1.3;
        card.style.width = w + 'px';

        // Remove column list height cap so all rows are always visible
        card.classList.add('is-resized');

        // For subquery cards set an explicit height of 4× the natural card height
        if (tableData.isSubquery) {
            const h = card.offsetHeight * 1.5;
            card.style.height = h + 'px';
            tableData.size = { w, h };
        } else {
            // Persist so context save captures the auto-computed width
            tableData.size = { w };
        }
    }

    /**
     * Find the top-left-most position where the given card fits without overlapping
     * any card already on the canvas, with at least PAD pixels of breathing room.
     *
     * Strategy: build candidate (x, y) pairs from the grid formed by x = 40 and
     * each existing card's right edge + PAD, y = 40 and each card's bottom + PAD.
     * Sort by row-then-column, return the first that doesn't collide.
     */
    function _findFreePosition(card) {
        // Use island bounding rectangles as obstacles so multi-table islands are
        // treated as a single unit and the new table is placed outside the island rect.
        const IPAD   = 28;  // islands.js PADDING  (sides + bottom of each island rect)
        const IPAD_T = 52;  // islands.js PADDING_TOP
        const GAP    = 24;  // visual gap between island rects

        const w = card.offsetWidth;
        const h = card.offsetHeight;

        const allCards = Array.from(document.querySelectorAll('.table-card'))
            .filter(c => c !== card);

        if (allCards.length === 0) {
            const canvasEl = document.getElementById('canvas');
            return {
                x: Math.round(canvasEl.offsetWidth  / 2 - w / 2),
                y: Math.round(canvasEl.offsetHeight / 2 - h / 2),
            };
        }

        // ── Group cards by island ─────────────────────────────────────────────
        const enabledJoins = typeof State !== 'undefined'
            ? State.joins.filter(j => j.enabled !== false) : [];
        const islands = typeof App !== 'undefined'
            ? App.computeIslands(
                typeof State !== 'undefined' ? State.tables : [], enabledJoins
              )
            : [];

        const islandKeyOf = {};
        islands.forEach(group => {
            const key = [...group].sort().join('|');
            group.forEach(id => { islandKeyOf[id] = key; });
        });

        // ── Compute island bounding boxes (table-card positions only) ─────────
        const bounds = {};
        allCards.forEach(c => {
            const tid = c.dataset.tableId;
            if (!tid) return;
            const key = islandKeyOf[tid] ?? tid;
            const cx  = parseInt(c.style.left, 10) || 0;
            const cy  = parseInt(c.style.top,  10) || 0;
            const cw  = c.offsetWidth;
            const ch  = c.offsetHeight;
            if (!bounds[key]) {
                bounds[key] = { minX: cx, minY: cy, maxX: cx + cw, maxY: cy + ch };
            } else {
                const b = bounds[key];
                b.minX = Math.min(b.minX, cx);
                b.minY = Math.min(b.minY, cy);
                b.maxX = Math.max(b.maxX, cx + cw);
                b.maxY = Math.max(b.maxY, cy + ch);
            }
        });

        // Island rect for each island (with IPAD borders applied)
        const obstacles = Object.values(bounds).map(b => ({
            x: b.minX - IPAD,
            y: b.minY - IPAD_T,
            w: (b.maxX - b.minX) + IPAD * 2,
            h: (b.maxY - b.minY) + IPAD_T + IPAD,
        }));

        // ── Overlap check ─────────────────────────────────────────────────────
        // New table at (x,y) has island rect [x-IPAD, y-IPAD_T, x+w+IPAD, y+h+IPAD].
        // Expand by GAP for clearance; check against every obstacle.
        const rectsOverlap = (a, b) =>
            a.x < b.x + b.w && a.x + a.w > b.x &&
            a.y < b.y + b.h && a.y + a.h > b.y;

        const overlaps = (x, y) => {
            if (x < 0 || y < 0) return true;
            const nr = {
                x: x - IPAD - GAP,
                y: y - IPAD_T - GAP,
                w: w + IPAD * 2 + GAP * 2,
                h: h + IPAD_T + IPAD + GAP * 2,
            };
            return obstacles.some(obs => rectsOverlap(nr, obs));
        };

        // ── Prefer right of active island ────────────────────────────────────
        // When islands exist, place the new card to the right of the active one.
        if (typeof State !== 'undefined') {
            const activeKey = (() => {
                if (State.selectedIslandKey) return State.selectedIslandKey;
                if (islands.length === 1) return [...islands[0]].sort().join('|');
                return null;
            })();
            if (activeKey && bounds[activeKey]) {
                const b = bounds[activeKey];
                // x: right edge of island rect (b.maxX + IPAD) + GAP + IPAD for new card
                const x = Math.round(b.maxX + 2 * IPAD + GAP);
                // y: top-aligned with the island's first card
                const y = Math.round(b.minY);
                if (!overlaps(x, y)) return { x, y };
            }
        }

        // ── Candidate positions ───────────────────────────────────────────────
        // Place the new table so its island rect is just outside each obstacle.
        // Derivation (example, "right"):
        //   new island rect left  = obs.right + GAP
        //   x - IPAD              = obs.x + obs.w + GAP
        //   x                     = obs.x + obs.w + GAP + IPAD
        const candidates = [];
        obstacles.forEach(obs => {
            const obsCX = obs.x + obs.w / 2;
            const obsCY = obs.y + obs.h / 2;

            // right of obstacle
            candidates.push({ x: obs.x + obs.w + GAP + IPAD,  y: obs.y + IPAD_T    }); // top-aligned
            candidates.push({ x: obs.x + obs.w + GAP + IPAD,  y: obsCY - h / 2     }); // v-centered
            // below obstacle
            candidates.push({ x: obs.x + IPAD,                y: obs.y + obs.h + GAP + IPAD_T }); // left-aligned
            candidates.push({ x: obsCX - w / 2,               y: obs.y + obs.h + GAP + IPAD_T }); // h-centered
            // left of obstacle
            candidates.push({ x: obs.x - GAP - IPAD - w,      y: obs.y + IPAD_T    }); // top-aligned
            candidates.push({ x: obs.x - GAP - IPAD - w,      y: obsCY - h / 2     }); // v-centered
            // above obstacle
            candidates.push({ x: obs.x + IPAD,                y: obs.y - GAP - IPAD - h }); // left-aligned
            candidates.push({ x: obsCX - w / 2,               y: obs.y - GAP - IPAD - h }); // h-centered
        });

        // ── Sort by distance to centroid of all existing cards ────────────────
        const ccx = allCards.reduce((s, c) => s + (parseInt(c.style.left, 10) || 0) + c.offsetWidth  / 2, 0) / allCards.length;
        const ccy = allCards.reduce((s, c) => s + (parseInt(c.style.top,  10) || 0) + c.offsetHeight / 2, 0) / allCards.length;
        const dist = (x, y) => Math.hypot(x + w / 2 - ccx, y + h / 2 - ccy);

        const seen = new Set();
        const valid = candidates
            .map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }))
            .filter(p => p.x >= 0 && p.y >= 0)
            .filter(p => { const k = `${p.x},${p.y}`; if (seen.has(k)) return false; seen.add(k); return true; })
            .sort((a, b) => dist(a.x, a.y) - dist(b.x, b.y));

        for (const pos of valid) {
            if (!overlaps(pos.x, pos.y)) return pos;
        }

        // ── Fallback: right of rightmost island rect ──────────────────────────
        const rightmost = obstacles.reduce((m, o) => m.x + m.w > o.x + o.w ? m : o);
        return {
            x: Math.round(rightmost.x + rightmost.w + GAP + IPAD),
            y: Math.round(rightmost.y + IPAD_T),
        };
    }

    // =========================================================================
    // Canvas search helpers
    // =========================================================================

    function _runSearch(query) {
        _clearSearchHighlights();
        const q      = query.trim().toLowerCase();
        const filter = document.getElementById('canvas-search-filter')?.value ?? 'all';

        if (!q) {
            _search.groups  = [];
            _search.matches = [];
            _search.index   = -1;
            _updateSearchUI();
            return;
        }

        const groups = [];

        // Tables (name)
        if (filter === 'all' || filter === 'tables') {
            State.tables.forEach(t => {
                if (t.name.toLowerCase().includes(q)) groups.push({ tableIds: [t.id] });
            });
        }

        // Aliases
        if (filter === 'all' || filter === 'aliases') {
            State.tables.forEach(t => {
                // In "all" mode, skip if already matched by table name to avoid duplicates
                if (filter === 'all' && t.name.toLowerCase().includes(q)) return;
                if (t.alias.toLowerCase().includes(q)) groups.push({ tableIds: [t.id] });
            });
        }

        // Join labels
        if (filter === 'all' || filter === 'joins') {
            State.joins.forEach(j => {
                if ((j.label ?? '').toLowerCase().includes(q)) {
                    groups.push({ tableIds: [j.fromTableId, j.toTableId], joinId: j.id });
                }
            });
        }

        // Island labels
        if (filter === 'all' || filter === 'islands') {
            const enabledJoins = State.joins.filter(j => j.enabled !== false);
            const islands      = App.computeIslands(State.tables, enabledJoins);
            islands.forEach(islandIds => {
                const key   = [...islandIds].sort().join('|');
                const label = State.islandNames?.[key] ?? '';
                if (label.toLowerCase().includes(q)) groups.push({ tableIds: islandIds });
            });
        }

        // Results table columns — matches th by bare name, full colKey, or visible header label
        // (e.g. "i.created_at" typed by the user matches the alias-prefixed display label even
        // when dataset.colKey falls back to the bare name during recording replays)
        if (filter === 'results-col') {
            document.querySelectorAll('#results-table thead th[data-col-key]').forEach(th => {
                const raw    = (th.dataset.raw    || '').toLowerCase();
                const colKey = (th.dataset.colKey || '').toLowerCase();
                // Extract the visible label the user sees (mirrors _thGetLabel in results.js)
                const em    = th.querySelector('em');
                let label   = '';
                if (em) {
                    label = em.textContent.trim().toLowerCase();
                } else {
                    for (let i = th.childNodes.length - 1; i >= 0; i--) {
                        const node = th.childNodes[i];
                        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
                            label = node.textContent.trim().toLowerCase();
                            break;
                        }
                    }
                }
                if (raw.includes(q) || colKey.includes(q) || label.includes(q))
                    groups.push({ tableIds: [], colKey: th.dataset.colKey });
            });
        }

        _search.groups  = groups;
        _search.matches = [...new Set(groups.flatMap(g => g.tableIds))];
        _search.index   = groups.length > 0 ? 0 : -1;

        _applySearchHighlights();
        if (groups.length > 0) _focusSearchGroup(0);
        _updateSearchUI();
    }

    function _searchStep(delta) {
        if (_search.groups.length === 0) return;
        _search.index = (_search.index + delta + _search.groups.length) % _search.groups.length;
        _focusSearchGroup(_search.index);
        _updateSearchUI();
    }

    function _focusSearchGroup(idx) {
        document.querySelectorAll('.table-card.is-search-focus')
                .forEach(c => c.classList.remove('is-search-focus'));
        document.querySelectorAll('#join-lines path.is-search-focus')
                .forEach(p => p.classList.remove('is-search-focus'));

        const group = _search.groups[idx];
        if (!group) return;

        // Results-column mode — delegate to Results.focusColumn, skip canvas logic
        if (group.colKey !== undefined) {
            if (typeof Results !== 'undefined') Results.focusColumn?.(group.colKey);
            return;
        }

        group.tableIds.forEach(id => {
            const card = document.querySelector(`.table-card[data-table-id="${id}"]`);
            if (card) card.classList.add('is-search-focus');
        });

        if (group.joinId) {
            const path = document.getElementById('jpath-' + group.joinId);
            if (path) path.classList.add('is-search-focus');
        }

        _scrollToGroup(group.tableIds);
    }

    function _applySearchHighlights() {
        // Results-column mode has no canvas highlights — nothing to do
        if (_search.groups.length && _search.groups[0].colKey !== undefined) return;

        _search.matches.forEach(tableId => {
            const card = document.querySelector(`.table-card[data-table-id="${tableId}"]`);
            if (card) card.classList.add('is-search-match');
        });
        // Highlight matched join lines
        _search.groups.forEach(g => {
            if (g.joinId) {
                const path = document.getElementById('jpath-' + g.joinId);
                if (path) path.classList.add('is-search-match');
            }
        });
        // Focus the current group
        if (_search.index >= 0) {
            const group = _search.groups[_search.index];
            group?.tableIds.forEach(id => {
                const card = document.querySelector(`.table-card[data-table-id="${id}"]`);
                if (card) card.classList.add('is-search-focus');
            });
            if (group?.joinId) {
                const path = document.getElementById('jpath-' + group.joinId);
                if (path) path.classList.add('is-search-focus');
            }
        }
    }

    function _clearSearchHighlights() {
        document.querySelectorAll('.table-card.is-search-match, .table-card.is-search-focus')
                .forEach(c => { c.classList.remove('is-search-match'); c.classList.remove('is-search-focus'); });
        document.querySelectorAll('#join-lines path.is-search-match, #join-lines path.is-search-focus')
                .forEach(p => { p.classList.remove('is-search-match'); p.classList.remove('is-search-focus'); });
    }

    function _clearSearch() {
        _clearSearchHighlights();
        _search.groups  = [];
        _search.matches = [];
        _search.index   = -1;
        _updateSearchUI();
    }

    function _updateSearchUI() {
        const count   = _search.groups.length;
        const idx     = _search.index;
        const countEl = document.getElementById('canvas-search-count');
        const prevBtn = document.getElementById('canvas-search-prev');
        const nextBtn = document.getElementById('canvas-search-next');

        countEl.textContent = count === 0 ? '' : `${idx + 1} / ${count}`;

        const hasMultiple = count > 1;
        prevBtn.disabled = !hasMultiple;
        nextBtn.disabled = !hasMultiple;
    }

    /** Scroll the canvas so the bounding box of the given table IDs is centered in view. */
    function _scrollToGroup(tableIds) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let found = false;

        tableIds.forEach(id => {
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

        if (!found) return;
        _scrollWrapperToLogicalCenter((minX + maxX) / 2, (minY + maxY) / 2);
    }

    /** Smooth-scroll the canvas-wrapper so the given card is centered in the viewport. */
    function _scrollToCard(card) {
        const x = parseInt(card.style.left, 10) || 0;
        const y = parseInt(card.style.top,  10) || 0;
        _scrollWrapperToLogicalCenter(x + card.offsetWidth / 2, y + card.offsetHeight / 2);
    }

    function _scrollToTableId(tableId) {
        const card = document.querySelector(`.table-card[data-table-id="${tableId}"]`);
        if (card) _scrollToCard(card);
    }

    function _scrollToCardTop(card) {
        const s       = _canvasContentScale();
        const wrapper = document.getElementById('canvas-wrapper');
        if (!wrapper) return;
        const x = parseInt(card.style.left, 10) || 0;
        const y = parseInt(card.style.top,  10) || 0;
        wrapper.scrollTo({
            left:     x * s - wrapper.clientWidth / 2 + (card.offsetWidth * s) / 2,
            top:      y * s - 20,
            behavior: 'smooth',
        });
    }

    function _scrollToTableIdTop(tableId) {
        const card = document.querySelector(`.table-card[data-table-id="${tableId}"]`);
        if (card) _scrollToCardTop(card);
    }

    /**
     * Scroll the canvas wrapper so all table cards are centered in view.
     * If there are no cards, does nothing.
     */
    // =========================================================================
    // Binary-tree layout — rearranges each island's tables in level order:
    //   level 0 (order 1) at top, level 1 (orders 2-3) below, etc.
    // =========================================================================
    function _arrangeBinaryTree(singleIslandIds) {
        if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();

        const enabledJoins = State.joins.filter(j => j.enabled !== false);
        const islands      = singleIslandIds
            ? [singleIslandIds]
            : App.computeIslands(State.tables, enabledJoins);
        const CARD_W       = 200;
        const GAP_X        = 300;  // horizontal gap between siblings
        const GAP_Y        = 150;  // vertical gap between levels

        islands.forEach(islandIds => {
            const tables = islandIds
                .map(id => State.tables.find(t => t.id === id))
                .filter(Boolean)
                .sort((a, b) => (a.order ?? 1) - (b.order ?? 1));

            if (tables.length === 0) return;

            // Group by binary-tree level: order 1→lv0, 2-3→lv1, 4-7→lv2, …
            const levels = [];
            tables.forEach(t => {
                const ord = Math.max(1, t.order ?? 1);
                const lv  = Math.floor(Math.log2(ord));
                if (!levels[lv]) levels[lv] = [];
                levels[lv].push(t);
            });

            // Widest level drives the total width used for centering
            const maxCount = Math.max(...levels.filter(Boolean).map(l => l.length));
            const totalW   = maxCount * CARD_W + (maxCount - 1) * GAP_X;

            // Anchor at the island's current top-left card position
            let anchorX = Infinity, anchorY = Infinity;
            tables.forEach(t => {
                anchorX = Math.min(anchorX, t.position?.x ?? 40);
                anchorY = Math.min(anchorY, t.position?.y ?? 40);
            });
            if (!isFinite(anchorX)) { anchorX = 40; anchorY = 40; }

            let currentY = anchorY;

            levels.forEach(levelTables => {
                if (!levelTables) return;
                const count  = levelTables.length;
                const levelW = count * CARD_W + (count - 1) * GAP_X;
                const startX = anchorX + Math.round((totalW - levelW) / 2);
                let maxH = 0;

                levelTables.forEach((t, i) => {
                    const x    = startX + i * (CARD_W + GAP_X);
                    const card = document.querySelector(`.table-card[data-table-id="${t.id}"]`);
                    t.position = { x, y: currentY };
                    if (card) {
                        card.style.left = x + 'px';
                        card.style.top  = currentY + 'px';
                        maxH = Math.max(maxH, card.offsetHeight);
                        if (typeof Joins !== 'undefined') Joins.redrawForTable(t.id);
                    }
                });

                currentY += (maxH || 150) + GAP_Y;
            });
        });

        if (typeof Islands !== 'undefined') Islands.redrawPositions();

        // Scroll so the arranged island is centered — collect all positioned table IDs first
        const arrangedIds = islands.flat();
        requestAnimationFrame(() => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            arrangedIds.forEach(id => {
                const card = document.querySelector(`.table-card[data-table-id="${id}"]`);
                if (!card) return;
                const x = parseInt(card.style.left, 10) || 0;
                const y = parseInt(card.style.top,  10) || 0;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x + card.offsetWidth);
                maxY = Math.max(maxY, y + card.offsetHeight);
            });
            if (isFinite(minX)) scrollToLogicalBoundingBox(minX, minY, maxX, maxY);
        });
    }

    function focusTables() {
        const cards = Array.from(document.querySelectorAll('.table-card'));
        if (!cards.length) return;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        cards.forEach(c => {
            const x = parseInt(c.style.left, 10) || 0;
            const y = parseInt(c.style.top,  10) || 0;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + c.offsetWidth);
            maxY = Math.max(maxY, y + c.offsetHeight);
        });

        _scrollWrapperToLogicalCenter((minX + maxX) / 2, (minY + maxY) / 2);
    }

    /**
     * Scroll so the top of the active island sits at the top of the viewport.
     * Falls back to all cards when no island is selected.
     */
    function _scrollToActiveIslandTop() {
        const wrapper = document.getElementById('canvas-wrapper');
        if (!wrapper) return;

        const activeIds = State.selectedIslandKey
            ? new Set(State.selectedIslandKey.split('|'))
            : null;

        const cards = Array.from(document.querySelectorAll('.table-card'));
        if (!cards.length) return;

        const compute = (subset) => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity;
            subset.forEach(card => {
                const x = parseInt(card.style.left, 10) || 0;
                const y = parseInt(card.style.top,  10) || 0;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x + card.offsetWidth);
            });
            return { minX, minY, maxX };
        };

        let { minX, minY, maxX } = activeIds
            ? compute(cards.filter(c => activeIds.has(c.dataset.tableId)))
            : compute(cards);

        // Fall back to all cards if the island filter produced nothing
        if (!isFinite(minX)) ({ minX, minY, maxX } = compute(cards));
        if (!isFinite(minX)) return;

        const s   = _canvasContentScale();
        const PAD = 40; // screen-pixel gap above the island top
        wrapper.scrollTo({
            left:     ((minX + maxX) / 2) * s - wrapper.clientWidth / 2,
            top:      Math.max(0, minY * s - PAD),
            behavior: 'smooth',
        });
    }

    function _applyPosition(card, pos) {
        card.style.left = (pos?.x ?? 40) + 'px';
        card.style.top  = (pos?.y ?? 40) + 'px';
    }

    function _applySize(card, size) {
        if (!size) return;
        if (size.w) card.style.width  = size.w + 'px';
        if (size.h) {
            card.style.height = size.h + 'px';
            card.classList.add('is-resized');
        }
    }

    function _esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // =========================================================================
    // Canvas screenshot
    // =========================================================================

    /**
     * Lazily loads html2canvas (CDN), crops to the content bounding-box of all
     * table cards, captures the canvas element (dot-grid + cards + SVG joins),
     * and writes the PNG to the clipboard.
     */
    async function _screenshotCanvas() {
        const canvasEl = document.getElementById('canvas');
        const cards    = canvasEl.querySelectorAll('.table-card');

        if (cards.length === 0) {
            App.notify?.('No tables on canvas to screenshot.', 'warn');
            return;
        }

        const btn       = document.getElementById('btn-screenshot-canvas');
        const origText  = btn?.textContent;
        if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

        const wrap           = document.getElementById('canvas-scale-wrap');
        const wasOverview    = document.body.classList.contains('is-canvas-overview-zoom');

        function _suspendOverviewZoomForCapture() {
            if (!wasOverview || !wrap) return;
            document.body.classList.remove('is-canvas-overview-zoom');
            wrap.classList.remove('is-overview-active');
            wrap.style.width  = '';
            wrap.style.height = '';
            canvasEl.classList.remove('is-overview-zoom');
            const jid = new Set();
            (State.joins || []).forEach(j => {
                jid.add(j.fromTableId);
                jid.add(j.toTableId);
            });
            jid.forEach(id => {
                if (typeof Joins !== 'undefined') Joins.redrawForTable(id);
            });
            if (typeof Islands !== 'undefined') Islands.redrawPositions?.();
        }

        function _restoreOverviewZoomAfterCapture() {
            if (!wasOverview || !wrap) return;
            document.body.classList.add('is-canvas-overview-zoom');
            wrap.classList.add('is-overview-active');
            const dim = Math.round(CANVAS_LOGICAL_PX * OVERVIEW_ZOOM_SCALE);
            wrap.style.width  = dim + 'px';
            wrap.style.height = dim + 'px';
            canvasEl.classList.add('is-overview-zoom');
            const jid = new Set();
            (State.joins || []).forEach(j => {
                jid.add(j.fromTableId);
                jid.add(j.toTableId);
            });
            jid.forEach(id => {
                if (typeof Joins !== 'undefined') Joins.redrawForTable(id);
            });
            if (typeof Islands !== 'undefined') Islands.redrawPositions?.();
        }

        try {
            // Compute tight bounding box around all table cards AND island rects.
            // Island rects already include the header padding (PADDING_TOP = 52px above cards),
            // so using them directly ensures the island label row is never clipped.
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            cards.forEach(card => {
                const x = parseInt(card.style.left, 10) || 0;
                const y = parseInt(card.style.top,  10) || 0;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x + card.offsetWidth);
                maxY = Math.max(maxY, y + card.offsetHeight);
            });
            canvasEl.querySelectorAll('.island-rect[data-island-key]').forEach(iRect => {
                const x = parseInt(iRect.style.left, 10) || 0;
                const y = parseInt(iRect.style.top,  10) || 0;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x + iRect.offsetWidth);
                maxY = Math.max(maxY, y + iRect.offsetHeight);
            });

            const PAD   = 16;
            const cropX = Math.max(0, minX - PAD);
            const cropY = Math.max(0, minY - PAD);
            const cropW = maxX - minX + PAD * 2;
            const cropH = maxY - minY + PAD * 2;

            // Lazy-load html2canvas the first time it's needed
            if (!window.html2canvas) {
                await new Promise((resolve, reject) => {
                    const s    = document.createElement('script');
                    s.src      = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
                    s.onload   = resolve;
                    s.onerror  = () => reject(new Error(
                        'Could not load html2canvas — check your internet connection.'
                    ));
                    document.head.appendChild(s);
                });
            }

            // #canvas-scale-wrap uses display:contents — canvasEl.parentElement’s
            // background is often transparent in computed style, leaving false holes
            // in the PNG. Use the scroll viewport behind the canvas.
            const canvasWrapper = document.getElementById('canvas-wrapper');
            const wcs           = getComputedStyle(canvasWrapper);
            let bgColor         = wcs.backgroundColor;
            if (!bgColor || bgColor === 'transparent' || bgColor === 'rgba(0, 0, 0, 0)') {
                bgColor = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
                    || '#1a1a1a';
            }
            // html2canvas 1.4.1 cannot parse modern CSS colour formats such as oklch(),
            // lch(), color(), or color-mix() — common on Windows Chrome/Edge.
            // Resolve to a safe rgb() string by drawing through a temporary 2-D canvas.
            try {
                const _tmp = document.createElement('canvas');
                _tmp.width = _tmp.height = 1;
                const _ctx = _tmp.getContext('2d');
                _ctx.fillStyle = bgColor;
                _ctx.fillRect(0, 0, 1, 1);
                const [_r, _g, _b] = _ctx.getImageData(0, 0, 1, 1).data;
                bgColor = `rgb(${_r},${_g},${_b})`;
            } catch (_) { /* keep original value if resolution fails */ }

            _suspendOverviewZoomForCapture();
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

            // Pre-fetch linked stylesheets and strip color-mix() so html2canvas's
            // own CSS parser never encounters it.  html2canvas extracts just "color"
            // from "color-mix" (its regex stops at "-") and throws
            // "unsupported color function 'color'".  Because onclone is synchronous
            // we must have the patched text ready before calling html2canvas.
            // prep() has already stamped all computed colours as !important inline
            // styles on every element inside canvasEl, so transparent fallbacks in
            // the stylesheet have no visual impact on the captured area.
            const _colorMixRe   = /color-mix\s*\([^)(]*(?:\([^)(]*\)[^)(]*)*\)/g;
            // box-shadow property lines — html2canvas renders them as filled rectangles.
            const _boxShadowRe  = /box-shadow\s*:[^;}{]+/g;
            const _patchedCss   = new Map();
            await Promise.all(
                [...document.querySelectorAll('link[rel="stylesheet"]')].map(async lnk => {
                    try {
                        const res  = await fetch(lnk.href, { cache: 'force-cache' });
                        let   text = await res.text();
                        text = text.replace(_colorMixRe,  'transparent');
                        text = text.replace(_boxShadowRe, 'box-shadow: none');
                        _patchedCss.set(lnk.href, text);
                    } catch (_) { /* leave unpatchable sheets untouched */ }
                })
            );

            const _prepareHtml2canvasClone = (_clonedDoc, clonedCanvasEl) => {
                // Resolves a single CSS colour value to a format html2canvas 1.4.1 can
                // parse. Windows Chrome/Edge returns oklch(), color(), color-mix(), etc.
                // which html2canvas does not support — this converts them to rgb/rgba.
                function _resolveColor(val) {
                    if (!val) return val;
                    if (!/\b(oklch|oklab|lch|lab|color-mix|hwb|color)\s*\(/.test(val)) return val;
                    try {
                        const t = document.createElement('canvas');
                        t.width = t.height = 1;
                        const c = t.getContext('2d');
                        c.fillStyle = val;
                        c.fillRect(0, 0, 1, 1);
                        const [r, g, b, a] = c.getImageData(0, 0, 1, 1).data;
                        return a === 255
                            ? `rgb(${r},${g},${b})`
                            : `rgba(${r},${g},${b},${+(a / 255).toFixed(3)})`;
                    } catch (_) { return val; }
                }

                // Returns true if a compound CSS value (background shorthand, box-shadow…)
                // contains a modern colour function that html2canvas cannot parse.
                function _hasModernColor(val) {
                    return val && /\b(oklch|oklab|lch|lab|color-mix|hwb|color)\s*\(/.test(val);
                }

                function prep(orig, clone) {
                    if (!orig || !clone || orig.nodeType !== Node.ELEMENT_NODE
                            || clone.nodeType !== Node.ELEMENT_NODE) {
                        return;
                    }

                    const cs = window.getComputedStyle(orig);

                    if (orig instanceof HTMLElement && clone instanceof HTMLElement) {
                        clone.style.setProperty('filter', 'none', 'important');
                        clone.style.setProperty('backdrop-filter', 'none', 'important');
                        clone.style.setProperty('mix-blend-mode', 'normal', 'important');
                        clone.style.setProperty('will-change', 'auto', 'important');

                        if (orig === canvasEl) {
                            clone.style.setProperty('transform', 'none', 'important');
                        }

                        // background — fall through to individual properties if the
                        // shorthand contains a modern colour function.
                        const bgSh = cs.background;
                        if (bgSh && bgSh !== 'none' && !_hasModernColor(bgSh)) {
                            clone.style.setProperty('background', bgSh, 'important');
                        } else {
                            clone.style.setProperty('background-color',
                                _resolveColor(cs.backgroundColor), 'important');
                            const bgi = cs.backgroundImage;
                            if (bgi && bgi !== 'none') {
                                clone.style.setProperty('background-image', bgi, 'important');
                                clone.style.setProperty('background-size', cs.backgroundSize, 'important');
                                clone.style.setProperty('background-position', cs.backgroundPosition, 'important');
                                clone.style.setProperty('background-repeat', cs.backgroundRepeat, 'important');
                            }
                        }

                        // border — always use per-side properties so colours can be resolved.
                        const brd = cs.border;
                        if (brd && brd !== 'none' && brd !== '0px none rgb(0, 0, 0)'
                                && !_hasModernColor(brd)) {
                            clone.style.setProperty('border', brd, 'important');
                        } else {
                            ['top', 'right', 'bottom', 'left'].forEach(side => {
                                const w  = cs.getPropertyValue(`border-${side}-width`);
                                const st = cs.getPropertyValue(`border-${side}-style`);
                                const c  = _resolveColor(cs.getPropertyValue(`border-${side}-color`));
                                if (w && st && c && st !== 'none') {
                                    clone.style.setProperty(
                                        `border-${side}`,
                                        `${w} ${st} ${c}`,
                                        'important'
                                    );
                                }
                            });
                        }

                        clone.style.setProperty('color', _resolveColor(cs.color), 'important');

                        // box-shadow is always suppressed: html2canvas renders shadows as
                        // filled opaque rectangles, which appear as ghost boxes on the
                        // canvas and as darker patches on island backgrounds.
                        clone.style.setProperty('box-shadow', 'none', 'important');

                        // outline — skip if it embeds a modern colour.
                        const outl = cs.outline;
                        if (outl && outl !== 'none' && !_hasModernColor(outl)) {
                            clone.style.setProperty('outline', outl, 'important');
                            clone.style.setProperty('outline-offset', cs.outlineOffset, 'important');
                        }

                        clone.style.setProperty('opacity', cs.opacity, 'important');
                        clone.style.setProperty('visibility', cs.visibility, 'important');
                        const webkitFill = cs.getPropertyValue('-webkit-text-fill-color');
                        if (webkitFill) {
                            clone.style.setProperty('-webkit-text-fill-color',
                                _resolveColor(webkitFill), 'important');
                        }

                        if (orig.classList?.contains('island-rect')) {
                            clone.style.setProperty('overflow', 'visible', 'important');
                        }

                    }

                    if (orig instanceof SVGElement && clone instanceof SVGElement && clone.style) {
                        try {
                            clone.style.setProperty('fill', _resolveColor(cs.fill), 'important');
                            clone.style.setProperty('stroke', _resolveColor(cs.stroke), 'important');
                            clone.style.setProperty('stroke-width', cs.strokeWidth, 'important');
                            clone.style.setProperty('opacity', cs.opacity, 'important');
                            clone.style.setProperty('color', _resolveColor(cs.color), 'important');
                        } catch (_e) { /* ignore */ }
                    }

                    const oc = orig.children;
                    const cc = clone.children;
                    for (let i = 0; i < oc.length && i < cc.length; i++) {
                        prep(oc[i], cc[i]);
                    }
                }

                prep(canvasEl, clonedCanvasEl);

                // Replace island label <input> elements with <span> so html2canvas
                // renders the text reliably (inputs are poorly supported on some browsers).
                const _origIslandInputs  = [...canvasEl.querySelectorAll('.island-label-input')];
                const _cloneIslandInputs = [...clonedCanvasEl.querySelectorAll('.island-label-input')];
                _cloneIslandInputs.forEach((cloneInp, i) => {
                    const origInp = _origIslandInputs[i];
                    const val     = origInp ? origInp.value : (cloneInp.value || '');
                    const cs      = origInp ? window.getComputedStyle(origInp) : null;
                    const span    = document.createElement('span');
                    span.textContent = val;
                    span.style.setProperty('display',       'inline-block',                          'important');
                    span.style.setProperty('flex',          '1',                                     'important');
                    span.style.setProperty('min-width',     '0',                                     'important');
                    span.style.setProperty('overflow',      'hidden',                                'important');
                    span.style.setProperty('white-space',   'nowrap',                                'important');
                    span.style.setProperty('text-overflow', 'ellipsis',                              'important');
                    span.style.setProperty('padding',       '0 4px',                                 'important');
                    span.style.setProperty('color',         cs ? cs.color : 'rgba(255,255,255,0.45)','important');
                    span.style.setProperty('font-size',     cs ? cs.fontSize     : '11px',           'important');
                    span.style.setProperty('font-family',   cs ? cs.fontFamily   : 'inherit',        'important');
                    span.style.setProperty('line-height',   cs ? cs.lineHeight   : 'normal',         'important');
                    span.style.setProperty('vertical-align','middle',                                'important');
                    cloneInp.replaceWith(span);
                });

                // Drop empty join label foreignObjects from the clone only. Source of truth: State.joins
                // (html2canvas often mis-clones form values; closest('foreignObject') can fail inside XHTML).
                function _nearestSvgForeignObject(el) {
                    let n = el;
                    while (n) {
                        if (n.namespaceURI === 'http://www.w3.org/2000/svg'
                                && String(n.localName).toLowerCase() === 'foreignobject') {
                            return n;
                        }
                        n = n.parentElement;
                    }
                    return null;
                }
                clonedCanvasEl.querySelectorAll('.join-label-input-fo').forEach(fo => {
                    const inp = fo.querySelector('input.join-line-label-inp');
                    if (!(inp instanceof HTMLInputElement)) {
                        fo.remove();
                        return;
                    }
                    const jid  = inp.getAttribute('data-join-id');
                    const join = jid && typeof State !== 'undefined' && State.joins
                        ? State.joins.find(j => j.id === jid)
                        : null;
                    const fromState = join ? String(join.label ?? '').trim() : '';
                    const fromInput = String(inp.value || '').trim();
                    const text      = fromState || fromInput;
                    if (!text) {
                        fo.remove();
                        return;
                    }
                    if (join) {
                        inp.value = join.label ?? '';
                    }
                });
                // Any stray inputs (no matching fo class) — hide using ancestor walk
                clonedCanvasEl.querySelectorAll('input.join-line-label-inp').forEach(inp => {
                    if (!(inp instanceof HTMLInputElement)) return;
                    if (inp.closest('.join-label-input-fo')) return;
                    const jid  = inp.getAttribute('data-join-id');
                    const join = jid && State?.joins ? State.joins.find(j => j.id === jid) : null;
                    const text = join
                        ? String(join.label ?? '').trim()
                        : String(inp.value || '').trim();
                    if (text) {
                        if (join) inp.value = join.label ?? '';
                        return;
                    }
                    const fo = _nearestSvgForeignObject(inp);
                    if (fo) fo.remove();
                    else inp.remove();
                });

                // Swap every linked stylesheet in the cloned document with an inline
                // <style> whose color-mix() calls have been replaced with 'transparent'.
                // This prevents html2canvas from hitting the unsupported colour function
                // during its own CSS-text parsing step.
                _clonedDoc.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
                    const patched = _patchedCss.get(link.href);
                    if (patched == null) return;
                    const style       = _clonedDoc.createElement('style');
                    style.textContent = patched;
                    link.replaceWith(style);
                });
            };

            const offscreen = await window.html2canvas(canvasEl, {
                x:               cropX,
                y:               cropY,
                width:           cropW,
                height:          cropH,
                backgroundColor: bgColor,
                useCORS:         false,
                allowTaint:      false,
                logging:         false,
                scale:           window.devicePixelRatio || 1,
                onclone:         _prepareHtml2canvasClone,
            });

            const blob = await new Promise(res => offscreen.toBlob(res, 'image/png'));
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            App.notify?.('Canvas screenshot copied to clipboard!', 'success');

        } catch (err) {
            App.notify?.('Screenshot failed: ' + err.message, 'error');
        } finally {
            _restoreOverviewZoomAfterCapture();
            if (wasOverview) {
                requestAnimationFrame(() => requestAnimationFrame(() => focusTables()));
            }
            if (btn) { btn.textContent = origText; btn.disabled = false; }
        }
    }

    // =========================================================================
    // Public surface  — replaces the stubs defined in app.js
    // =========================================================================
    /** Format an approximate row count for display. */
    function _formatRowCount(n) {
        if (n >= 1_000_000) return '~' + (n / 1_000_000).toFixed(1) + 'M';
        if (n >= 1_000)     return '~' + (n / 1_000).toFixed(1)     + 'k';
        return '~' + n;
    }

    /** Update the row-count badge on a specific table card. */
    function updateRowCount(tableId, count) {
        const card = document.querySelector(`.table-card[data-table-id="${tableId}"]`);
        if (!card) return;
        const el = card.querySelector('.table-card__rowcount');
        if (!el) return;
        el.textContent = _formatRowCount(count);
        el.title = count.toLocaleString() + ' rows (approximate)';
    }

    function removeTableByName(tableName, database) {
        const db = database || '';
        const tableData = State.tables.find(
            t => t.name === tableName && (t.database || '') === db
        );
        if (tableData) _removeTableFromState(tableData);
    }

    /**
     * Toggles the `is-in-where` class on every rendered canvas column element
     * based on whether that column appears in State.where.
     * Called by config.js _refreshWhere() so highlights stay in sync.
     */
    function refreshWhereHighlights() {
        // Build a set of "alias.colName" keys from visual WHERE conditions
        const whereCols = new Set(
            (State.where || [])
                .filter(w => !w.type && w.col)
                .map(w => w.col)
        );

        document.querySelectorAll('.table-card__col[data-col]').forEach(colEl => {
            const table = (State.tables || []).find(t => t.id === colEl.dataset.tableId);
            if (!table) return;
            colEl.classList.toggle(
                'is-in-where',
                whereCols.has(`${table.alias}.${colEl.dataset.col}`)
            );
        });
    }

    /**
     * Scroll the canvas so the card for `alias` is centred within the truly
     * visible canvas area (accounting for the fixed results panel that overlays
     * the canvas from the bottom), then briefly flash-highlight the matching
     * column element, scrolling it into view within the card's column list first.
     */
    function focusColumn(alias, colName) {
        const table = (State.tables || []).find(t => t.alias === alias);
        if (!table) return;

        const card = document.querySelector(`.table-card[data-table-id="${table.id}"]`);
        if (!card) return;

        _scrollToCardTop(card);

        // Find the column element
        const colEl = card.querySelector(`.table-card__col[data-col="${colName}"]`);
        if (!colEl) return;

        // Scroll the column into view within the card's own scrollable column list
        // so it is never hidden behind the list's overflow boundary.
        const colList = colEl.closest('.table-card__columns');
        if (colList) {
            const itemTop    = colEl.offsetTop;
            const itemBottom = itemTop + colEl.offsetHeight;
            if (itemBottom > colList.scrollTop + colList.clientHeight) {
                colList.scrollTop = itemBottom - colList.clientHeight;
            } else if (itemTop < colList.scrollTop) {
                colList.scrollTop = itemTop;
            }
        }

        // Flash-highlight the column
        colEl.classList.remove('is-col-focus');
        void colEl.offsetWidth; // force reflow so animation restarts
        colEl.classList.add('is-col-focus');
        colEl.addEventListener('animationend', () => colEl.classList.remove('is-col-focus'), { once: true });
    }

    function removeTableById(tableId) {
        const tableData = State.tables.find(t => t.id === tableId);
        if (tableData) _removeTableFromState(tableData);
    }

    /** Load a .sql or .csv file into a subquery textarea (shared by L-button and drag-drop). */
    function _loadFileIntoTextarea(file, ta) {
        const reader = new FileReader();
        reader.onerror = () => App.notify?.('Could not read file.', 'error');
        reader.onload = ev => {
            const raw   = ev.target.result;
            const isCsv = file.name.toLowerCase().endsWith('.csv');
            let result;
            if (isCsv) {
                result = App.csvToUnionSql?.(raw);
                if (!result) { App.notify?.('CSV appears empty or has no data rows.', 'warn'); return; }
            } else {
                result = raw;
            }
            if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
            ta.value = result;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            if (typeof UndoManager !== 'undefined') UndoManager.push(ta);
            ta.focus();
            App.notify?.(`Loaded: ${file.name}`, 'success');
        };
        reader.readAsText(file);
    }

    function setOverviewZoom(on) {
        const wrap   = document.getElementById('canvas-scale-wrap');
        const canvas = document.getElementById('canvas');
        if (!wrap || !canvas) return;
        const dim = Math.round(CANVAS_LOGICAL_PX * OVERVIEW_ZOOM_SCALE);
        if (on) {
            document.body.classList.add('is-canvas-overview-zoom');
            wrap.classList.add('is-overview-active');
            wrap.style.width  = dim + 'px';
            wrap.style.height = dim + 'px';
            canvas.classList.add('is-overview-zoom');
        } else {
            document.body.classList.remove('is-canvas-overview-zoom');
            wrap.classList.remove('is-overview-active');
            wrap.style.width  = '';
            wrap.style.height = '';
            canvas.classList.remove('is-overview-zoom');
        }
        const jid = new Set();
        (State.joins || []).forEach(j => {
            jid.add(j.fromTableId);
            jid.add(j.toTableId);
        });
        jid.forEach(id => {
            if (typeof Joins !== 'undefined') Joins.redrawForTable(id);
        });
        if (typeof Islands !== 'undefined') Islands.redrawPositions?.();
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                _scrollToActiveIslandTop();
                if (typeof Minimap !== 'undefined') Minimap.update();
            });
        });
    }

    function toggleOverviewZoom() {
        setOverviewZoom(!document.body.classList.contains('is-canvas-overview-zoom'));
    }

    /** Centre viewport on the mid-point of a logical-axis bounding box (table positions). */
    function scrollToLogicalBoundingBox(minX, minY, maxX, maxY, behavior = 'smooth') {
        if (![minX, minY, maxX, maxY].every(Number.isFinite)) return;
        _scrollWrapperToLogicalCenter((minX + maxX) / 2, (minY + maxY) / 2, behavior);
    }

    function _scrollToJoinId(joinId) {
        const path = document.getElementById('jpath-' + joinId);
        if (!path) return;

        // Highlight using the same class as search focus
        document.querySelectorAll('#join-lines path.join-line-pulse')
            .forEach(p => p.classList.remove('join-line-pulse'));
        path.classList.add('join-line-pulse');
        path.addEventListener('animationend', () => path.classList.remove('join-line-pulse'), { once: true });

        // Scroll canvas to midpoint of the path
        const mid = path.getPointAtLength(path.getTotalLength() / 2);
        const s   = _canvasContentScale();
        const wrapper = document.getElementById('canvas-wrapper');
        if (!wrapper) return;
        wrapper.scrollTo({
            left: mid.x * s - wrapper.clientWidth / 2,
            top:  mid.y * s - 20,
            behavior: 'smooth',
        });
    }

    return {
        init,
        CARD_COLORS,
        renderTable,
        removeTable,
        removeTableByName,
        removeTableById,
        rebuildFromState,
        updateRowCount,
        focusTables,
        arrangeBinaryTree: _arrangeBinaryTree,
        refreshWhereHighlights,
        focusColumn,
        refreshOrderDropdowns: _refreshAllOrderDropdowns,
        bindSqlVariables:      _bindSqlVariables,
        getContentScale,
        setOverviewZoom,
        toggleOverviewZoom,
        scrollToTableId:       _scrollToTableId,
        scrollToTableIdTop:    _scrollToTableIdTop,
        scrollToJoinId:        _scrollToJoinId,
        scrollToLogicalBoundingBox,
        startPan(e) {
            const wrapper   = document.getElementById('canvas-wrapper');
            _pan.active  = true;
            _pan.startX  = e.clientX;
            _pan.startY  = e.clientY;
            _pan.scrollX = wrapper.scrollLeft;
            _pan.scrollY = wrapper.scrollTop;
            wrapper.style.cursor = 'grabbing';
            e.preventDefault();
        },
    };

})();

// Initialise drag handlers as soon as the DOM is ready
document.addEventListener('DOMContentLoaded', () => Canvas.init());
