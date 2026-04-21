/**
 * config.js — Right-panel query configurator
 *
 * Phase 5:
 *   - SELECT column picker (per-table checkbox groups; unchecking collapses SELECT *)
 *   - WHERE clause builder (visual conditions + raw textarea toggle)
 *   - ORDER BY builder    (visual sort rows  + raw textarea toggle)
 *   - Client-side SQL preview builder  (QueryPanel.buildSQL)
 *   - Column drag-to-zone from canvas (onColumnDrop, called by joins.js)
 *
 * Depends on (runtime): State, App  — defined in app.js
 * Load order: … → canvas.js → joins.js → config.js
 */

const QueryPanel = (() => {

    // =========================================================================
    // Init — bind static UI elements once on DOMContentLoaded
    // =========================================================================
    function init() {
        // Mode-toggle buttons (.btn-toggle-mode[data-section])
        document.querySelectorAll('.btn-toggle-mode').forEach(btn => {
            btn.addEventListener('click', () => _toggleMode(btn.dataset.section));
        });


        // Raw textarea → State sync (snapshot on focus, before user starts typing)
        ['select-raw-input', 'where-raw-input', 'orderby-raw-input', 'groupby-raw-input', 'having-raw-input'].forEach(id => {
            document.getElementById(id)?.addEventListener('focus', () => { if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot(); });
        });
        document.getElementById('select-raw-input').addEventListener('input', e => {
            State.selectRaw = e.target.value;
            App.updateSQLPreview();
        });
        document.getElementById('where-raw-input').addEventListener('input', e => {
            State.whereRaw = e.target.value;
            App.updateSQLPreview();
        });
        document.getElementById('orderby-raw-input').addEventListener('input', e => {
            State.orderByRaw = e.target.value;
            App.updateSQLPreview();
        });
        document.getElementById('groupby-raw-input').addEventListener('input', e => {
            State.groupByRaw = e.target.value;
            App.updateSQLPreview();
        });
        document.getElementById('having-raw-input').addEventListener('input', e => {
            State.havingRaw = e.target.value;
            App.updateSQLPreview();
        });

        document.getElementById('select-table-name-toggle').addEventListener('change', e => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            State.selectTableName = e.target.checked;
            Results.rerender();
        });

        document.getElementById('select-schema-alias-toggle').addEventListener('change', e => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            State.selectSchemaAlias = e.target.checked;
            Results.rerender();
        });

        document.getElementById('select-distinct-toggle').addEventListener('change', e => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            State.selectDistinct = e.target.checked;
            App.updateSQLPreview();
        });

        document.getElementById('select-delimiter-toggle').addEventListener('change', e => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            State.selectAddDelimiter = e.target.checked;
            App.updateSQLPreview();
        });

        document.getElementById('select-sort-alpha-toggle').addEventListener('change', e => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            State.selectSortAlpha = e.target.checked;
            App.updateSQLPreview();
        });

        // Sync LIMIT dropdown → already wired in app.js, nothing extra needed here

        // Render initial modes
        _applyModeUI('select');
        _applyModeUI('where');
        _applyModeUI('orderby');
        _applyModeUI('groupby');
        _applyModeUI('having');

        // HTML5 drop zones — accept dragged result-table headers / cells
        document.querySelectorAll('.drop-zone[data-section]').forEach(zone => {
            zone.addEventListener('dragover', e => {
                if (!e.dataTransfer.types.includes('text/x-col-key')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                zone.classList.add('is-drag-hover');
            });
            zone.addEventListener('dragleave', e => {
                if (zone.contains(e.relatedTarget)) return;
                zone.classList.remove('is-drag-hover');
            });
            zone.addEventListener('drop', e => {
                zone.classList.remove('is-drag-hover');
                const colKey = e.dataTransfer.getData('text/x-col-key');
                if (!colKey) return;
                e.preventDefault();
                const cellValue = e.dataTransfer.getData('text/x-col-value') || '';
                _dropColKey(zone, colKey, cellValue);
                App.notify?.(`"${colKey}" added to ${zone.dataset.section.toUpperCase()}`, 'success');
                // For WHERE / HAVING: scroll to the new row and focus the value input
                const sec = zone.dataset.section;
                if (sec === 'where' || sec === 'having') {
                    requestAnimationFrame(() => {
                        const id   = sec === 'where' ? 'where-conditions' : 'having-conditions';
                        const rows = document.querySelectorAll(`#${id} .condition-row`);
                        if (!rows.length) return;
                        const newRow = rows[rows.length - 1];
                        newRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        newRow.querySelector('input[placeholder="value"]')?.focus({ preventScroll: true });
                    });
                }
            });
        });

        // Alt+click a SELECT column row → add it to WHERE (capture phase to prevent checkbox toggle)
        document.getElementById('select-columns')?.addEventListener('click', e => {
            if (!e.altKey) return;
            const row = e.target.closest('.select-col-row');
            if (!row) return;
            if (e.target.closest('.col-alias-input') || e.target.closest('.col-highlight-chk')) return;
            e.preventDefault();
            e.stopPropagation();
            const key = State.columnOrder[parseInt(row.dataset.idx, 10)];
            if (!key) return;
            if (!Array.isArray(State.where)) State.where = [];
            State.where.push({ col: key, op: '=', val: '', operator: 'AND' });
            QueryPanel.refresh();
            App.updateSQLPreview?.();
            App.notify?.(`"${key}" added to WHERE`, 'success');
            // Focus the new WHERE value input without scrolling
            requestAnimationFrame(() => {
                const crows = document.querySelectorAll('#where-conditions .condition-row');
                if (crows.length) crows[crows.length - 1].querySelector('input[type="text"]')?.focus({ preventScroll: true });
            });
            // Flash the row — re-query after refresh since DOM was rebuilt
            const freshRow = document.querySelector(`#select-columns .select-col-row[data-idx="${row.dataset.idx}"]`);
            if (freshRow) {
                freshRow.classList.remove('select-col-flash');
                void freshRow.offsetWidth; // force reflow to restart animation
                freshRow.classList.add('select-col-flash');
            }
        }, true);
    }

    // =========================================================================
    // refresh() — called after any State change that affects the panel
    // =========================================================================
    function refresh() {
        _refreshSelect();
        _refreshWhere();
        _refreshGroupBy();
        _refreshHaving();
        _refreshOrderBy();
        // Also sync raw textareas in case mode was raw when state was restored
        if (State.selectMode   === 'raw') document.getElementById('select-raw-input').value   = State.selectRaw   ?? '';
        if (State.whereMode    === 'raw') document.getElementById('where-raw-input').value    = State.whereRaw    ?? '';
        if (State.groupByMode  === 'raw') document.getElementById('groupby-raw-input').value  = State.groupByRaw  ?? '';
        if (State.havingMode   === 'raw') document.getElementById('having-raw-input').value   = State.havingRaw   ?? '';
        if (State.orderByMode  === 'raw') document.getElementById('orderby-raw-input').value  = State.orderByRaw  ?? '';
        _applyModeUI('select');
        _applyModeUI('where');
        _applyModeUI('groupby');
        _applyModeUI('having');
        _applyModeUI('orderby');

        // Sync delimiter + sort-alpha + schema-alias + table-name toggles
        document.getElementById('select-delimiter-toggle').checked    = State.selectAddDelimiter ?? false;
        document.getElementById('select-sort-alpha-toggle').checked   = State.selectSortAlpha    ?? false;
        document.getElementById('select-table-name-toggle').checked   = State.selectTableName    ?? false;
        document.getElementById('select-schema-alias-toggle').checked = State.selectSchemaAlias  ?? true;
        document.getElementById('select-distinct-toggle').checked     = State.selectDistinct      ?? false;

        // Copy Visual SELECT/WHERE/GROUP BY/HAVING/ORDER BY to Raw
        document.getElementById('btn-select-to-raw') .addEventListener('click', _copySelectVisualToRaw);
        document.getElementById('btn-where-to-raw')  .addEventListener('click', _copyWhereVisualToRaw);
        document.getElementById('btn-groupby-to-raw').addEventListener('click', _copyGroupByVisualToRaw);
        document.getElementById('btn-having-to-raw') .addEventListener('click', _copyHavingVisualToRaw);
        document.getElementById('btn-orderby-to-raw').addEventListener('click', _copyOrderByVisualToRaw);

        // WHERE from JSON
        const _whereJsonModal = document.getElementById('modal-where-from-json');
        const _whereJsonTa    = document.getElementById('where-from-json-textarea');

        if (typeof SqlBackdrop !== 'undefined') SqlBackdrop.attach(_whereJsonTa);

        const _whereRawInput = document.getElementById('where-raw-input');

        const _closeWhereJsonModal = () => {
            _whereJsonModal.classList.add('hidden');
            _whereRawInput.focus();
        };

        document.getElementById('btn-where-from-json').addEventListener('click', () => {
            _whereJsonModal.classList.remove('hidden');
            _whereJsonTa.focus();
        });

        _whereJsonModal.querySelector('.modal-close').addEventListener('click', _closeWhereJsonModal);

        _whereJsonModal.addEventListener('click', e => {
            if (e.target === _whereJsonModal) _closeWhereJsonModal();
        });

        document.getElementById('btn-where-from-json-apply').addEventListener('click', () => {
            const op = document.getElementById('where-from-json-operator').value;
            _applyWhereFromJson(_whereJsonTa.value.trim(), op);
        });

        _whereJsonTa.addEventListener('keydown', e => {
            if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault();
                document.getElementById('btn-where-from-json-apply').click();
            }
        });

        // Alt+J on the WHERE raw textarea: open the popup
        _whereRawInput.addEventListener('keydown', e => {
            if (!e.altKey || e.code !== 'KeyJ') return;
            e.preventDefault();
            e.stopPropagation();
            _whereJsonModal.classList.remove('hidden');
            _whereJsonTa.focus();
        });

        // Alt+J anywhere: close the popup when it is visible
        document.addEventListener('keydown', e => {
            if (!e.altKey || e.code !== 'KeyJ') return;
            if (_whereJsonModal.classList.contains('hidden')) return;
            e.preventDefault();
            e.stopPropagation();
            _closeWhereJsonModal();
        }, true); // capture phase so stopPropagation blocks the window-level handler
    }

    // =========================================================================
    // SELECT section
    // =========================================================================
    function _applyExprModeToCheckboxes(mode) {
        const disabled = mode === 'only';

        // SELECT option checkboxes (in the delimiter row)
        ['select-sort-alpha-toggle', 'select-delimiter-toggle', 'select-table-name-toggle',
         'select-schema-alias-toggle', 'select-distinct-toggle'].forEach(id => {
            const el  = document.getElementById(id);
            const lbl = el?.closest('label');
            if (!el) return;
            el.disabled = disabled;
            if (lbl) lbl.style.opacity = disabled ? '0.4' : '';
        });

        // Column panel controls (rebuilt each render, so query by ID set above)
        ['chk-select-visibility', 'btn-minimize-all', 'btn-checked-columns'].forEach(id => {
            const el  = document.getElementById(id);
            const lbl = el?.closest('label');
            if (!el) return;
            el.disabled = disabled;
            const target = lbl ?? el;
            target.style.opacity = disabled ? '0.4' : '';
        });
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

    function _refreshSelect() {
        const container = document.getElementById('select-columns');
        const emptyEl   = document.querySelector('#section-select .config-empty');

        if (State.tables.length === 0) {
            container.innerHTML = '';
            if (emptyEl) emptyEl.style.display = '';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        const prevSearch = document.getElementById('select-col-search')?.value ?? '';
        container.innerHTML = '';

        // Initialize columnOrder if empty
        if (!State.columnOrder || State.columnOrder.length === 0) {
            State.columnOrder = _allColumns();
        } else {
            // Ensure all current columns are in columnOrder
            const currentCols = _allColumns();
            currentCols.forEach(c => {
                if (!State.columnOrder.includes(c)) State.columnOrder.push(c);
            });
            // Remove columns that are no longer on the canvas
            State.columnOrder = State.columnOrder.filter(c => currentCols.includes(c));
        }

        // Build the set of active-island table aliases for display filtering
        const activeAliases = new Set(_activeTables().map(t => t.alias));

        // Star annotation when SELECT * is active
        if (State.tables.length > 0 && State.select.length === 0 && !State.selectNone) {
            const star = document.createElement('div');
            star.className = 'select-star-note';
            star.textContent = 'All columns selected (SELECT *)';
            container.appendChild(star);
        } else {
            const star = document.createElement('div');
            star.className = 'select-star-note';
            star.textContent = 'Columns filtered';
            container.appendChild(star);
        }

        const listHeader = document.createElement('div');
        listHeader.className = 'select-group-hdr select-group-hdr--row';
        const listHeaderTxt = document.createElement('span');
        listHeaderTxt.textContent = 'Columns (Drag Table or Column)';
        listHeader.appendChild(listHeaderTxt);
        const checkedOnlyBtn = document.createElement('button');
        checkedOnlyBtn.id        = 'btn-checked-columns';
        checkedOnlyBtn.className = 'btn-toggle-mode' + (_showCheckedOnly ? ' active' : '');
        checkedOnlyBtn.textContent = 'Checked columns';
        checkedOnlyBtn.title = 'Show only checked columns';
        checkedOnlyBtn.addEventListener('click', () => {
            _showCheckedOnly = !_showCheckedOnly;
            checkedOnlyBtn.classList.toggle('active', _showCheckedOnly);
            if (_showCheckedOnly) {
                // Snapshot which columns are checked right now; keep showing them even if unchecked later
                _checkedOnlySnapshot = new Set();
                const col = document.getElementById('select-columns');
                col?.querySelectorAll('.select-col-row').forEach(r => {
                    if (r.querySelector('input[type="checkbox"]')?.checked) {
                        const key = State.columnOrder[parseInt(r.dataset.idx)];
                        if (key) _checkedOnlySnapshot.add(key);
                    }
                });
            } else {
                _checkedOnlySnapshot = null;
            }
            _filterSelectColumns();
        });
        // Visibility checkbox — check/uncheck all columns globally
        const allActiveCols  = _activeColumns();
        const visAllChecked  = !State.selectNone && (State.select.length === 0 || allActiveCols.every(k => State.select.includes(k)));
        const visNoneChecked = State.selectNone  || (State.select.length > 0 && allActiveCols.every(k => !State.select.includes(k)));

        const visLbl = document.createElement('label');
        visLbl.className = 'select-visibility-label';
        visLbl.title = 'Check / uncheck all columns';
        const visChk = document.createElement('input');
        visChk.type = 'checkbox';
        visChk.id   = 'chk-select-visibility';
        visChk.checked       = visAllChecked;
        visChk.indeterminate = !visAllChecked && !visNoneChecked;
        visChk.addEventListener('change', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            if (visChk.checked) {
                State.selectNone = false;
                State.select     = [];
            } else {
                if (State.select.length === 0) State.select = _activeColumns();
                State.select     = [];
                State.selectNone = true;
            }
            _refreshSelect();
            App.updateSQLPreview();
            Results.syncColDeselected?.(null, !visChk.checked);
        });
        visLbl.appendChild(visChk);
        const visLblTxt = document.createElement('span');
        visLblTxt.textContent = 'Visibility';
        visLbl.appendChild(visLblTxt);
        listHeader.appendChild(visLbl);

        const minimizeAllBtn = document.createElement('button');
        minimizeAllBtn.id        = 'btn-minimize-all';
        minimizeAllBtn.className = 'btn-toggle-mode' + (_allMinimized ? ' active' : '');
        minimizeAllBtn.title     = 'Minimize all table column lists';
        minimizeAllBtn.textContent = 'Minimize all';
        minimizeAllBtn.addEventListener('click', () => {
            _allMinimized = !_allMinimized;
            minimizeAllBtn.classList.toggle('active', _allMinimized);
            document.querySelectorAll('.btn-select-minimize').forEach(b => {
                const isMinimized = b.textContent.trim() === '▸';
                if (_allMinimized && !isMinimized) b.click();
                if (!_allMinimized && isMinimized) b.click();
            });
        });
        listHeader.appendChild(minimizeAllBtn);
        listHeader.appendChild(checkedOnlyBtn);
        container.appendChild(listHeader);

        const colLegend = document.createElement('div');
        colLegend.className = 'select-expr-legend';
        colLegend.textContent = 'Right-click to center canvas on column';
        container.appendChild(colLegend);

        // Group columns by table alias for display
        const grouped = [];
        State.columnOrder.forEach(key => {
            const alias = key.split('.')[0];
            let group = grouped.find(g => g.alias === alias);
            if (!group) {
                group = { alias, columns: [] };
                grouped.push(group);
            }
            group.columns.push(key);
        });

        grouped.forEach((group, gIdx) => {
            // Skip tables that belong to a different island
            if (!activeAliases.has(group.alias)) return;

            const table = State.tables.find(t => t.alias === group.alias);
            const tableName = table ? table.name : group.alias;
            const groupAllChecked  = !State.selectNone && group.columns.every(key => State.select.length === 0 || State.select.includes(key));
            const groupNoneChecked = State.selectNone   || (State.select.length > 0 && group.columns.every(key => !State.select.includes(key)));

            // --- Table Header ---
            const hdr = document.createElement('div');
            hdr.className = 'select-table-hdr is-draggable';
            hdr.draggable = true;
            hdr.dataset.alias = group.alias;

            const dragHandleHdr = document.createElement('div');
            dragHandleHdr.className = 'drag-handle';
            dragHandleHdr.innerHTML = '⋮⋮';
            dragHandleHdr.title = 'Drag to reorder table';
            hdr.appendChild(dragHandleHdr);

            const lblHdr = document.createElement('label');
            const chkHdr = document.createElement('input');
            chkHdr.type = 'checkbox';
            chkHdr.checked = groupAllChecked;
            chkHdr.indeterminate = !groupAllChecked && !groupNoneChecked;
            chkHdr.addEventListener('change', () => {
                if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                if (chkHdr.checked) {
                    // Checking: re-select all columns in this group
                    State.selectNone = false;
                    if (State.select.length === 0) {
                        // Coming from selectNone — select only this group explicitly
                        State.select = [...group.columns];
                    } else {
                        group.columns.forEach(key => {
                            if (!State.select.includes(key)) State.select.push(key);
                        });
                    }
                    // Collapse back to SELECT * if everything in this island is now selected
                    if (_activeColumns().every(k => State.select.includes(k))) State.select = [];
                } else {
                    // Uncheck all in this table
                    if (State.select.length === 0) {
                        State.select = _activeColumns(); // expand SELECT * first (active island only)
                    }
                    State.select = State.select.filter(key => !group.columns.includes(key));
                    if (State.select.length === 0) State.selectNone = true;
                }
                State.select.sort((a, b) => State.columnOrder.indexOf(a) - State.columnOrder.indexOf(b));
                _refreshSelect();
                App.updateSQLPreview();
                group.columns.forEach(k => Results.syncColDeselected?.(k, !chkHdr.checked));
            });
            lblHdr.appendChild(chkHdr);

            const txtHdr = document.createElement('span');
            txtHdr.className = 'select-table-hdr-txt' + (groupNoneChecked ? ' select-table-hdr-txt--none' : '');
            txtHdr.innerHTML = `<span class="sel-alias">${_esc(group.alias)}</span> <span class="sel-tname">(${_esc(tableName)})</span>`;
            lblHdr.appendChild(txtHdr);

            const locateBtn = document.createElement('button');
            locateBtn.className = 'btn-select-locate';
            locateBtn.textContent = '⊙';
            locateBtn.title = 'Highlight this table on the canvas';
            locateBtn.addEventListener('mousedown', e => e.stopPropagation());
            locateBtn.addEventListener('click', e => {
                e.stopPropagation();
                const t = State.tables.find(t => t.alias === group.alias);
                if (!t) return;
                const card = document.querySelector(`.table-card[data-table-id="${t.id}"]`);
                if (!card) return;
                if (typeof Canvas !== 'undefined' && Canvas.scrollToLogicalBoundingBox) {
                    const x = parseInt(card.style.left, 10) || 0;
                    const y = parseInt(card.style.top, 10) || 0;
                    Canvas.scrollToLogicalBoundingBox(
                        x, y, x + card.offsetWidth, y + card.offsetHeight
                    );
                }
                card.classList.remove('table-card--flash');
                void card.offsetWidth;
                card.classList.add('table-card--flash');
                setTimeout(() => card.classList.remove('table-card--flash'), 2000);
            });
            hdr.appendChild(locateBtn);

            if (table?.color) {
                const colorChk = document.createElement('input');
                colorChk.type = 'checkbox';
                colorChk.className = 'hdr-color-chk';
                colorChk.checked = !_colorDisabledGroups.has(group.alias);
                colorChk.title = 'Apply table color to this header';
                colorChk.addEventListener('mousedown', e => e.stopPropagation());
                colorChk.addEventListener('change', e => {
                    e.stopPropagation();
                    if (colorChk.checked) {
                        _colorDisabledGroups.delete(group.alias);
                        hdr.style.backgroundColor = table.color;
                        hdr.style.color = _readableTextColor(table.color);
                    } else {
                        _colorDisabledGroups.add(group.alias);
                        hdr.style.backgroundColor = '';
                        hdr.style.color = '';
                    }
                });
                hdr.appendChild(colorChk);
            }

            const minimizeBtn = document.createElement('button');
            minimizeBtn.className = 'btn-select-locate btn-select-minimize';
            const isMinimized = _minimizedGroups.has(group.alias);
            minimizeBtn.textContent = isMinimized ? '▸' : '▾';
            minimizeBtn.title = isMinimized ? 'Expand columns' : 'Collapse columns';
            minimizeBtn.addEventListener('mousedown', e => e.stopPropagation());
            minimizeBtn.addEventListener('click', e => {
                e.stopPropagation();
                if (_minimizedGroups.has(group.alias)) {
                    _minimizedGroups.delete(group.alias);
                    minimizeBtn.textContent = '▾';
                    minimizeBtn.title = 'Collapse columns';
                } else {
                    _minimizedGroups.add(group.alias);
                    minimizeBtn.textContent = '▸';
                    minimizeBtn.title = 'Expand columns';
                }
                _filterSelectColumns();
            });
            hdr.appendChild(minimizeBtn);

            hdr.appendChild(lblHdr);
            if (table?.color && !_colorDisabledGroups.has(group.alias)) {
                hdr.style.backgroundColor = table.color;
                hdr.style.color = _readableTextColor(table.color);
            }
            container.appendChild(hdr);

            // Per-group column search
            const grpSearchWrap = document.createElement('div');
            grpSearchWrap.className = 'col-group-search-wrap';

            const grpSearchInput = document.createElement('input');
            grpSearchInput.type = 'text';
            grpSearchInput.className = 'col-search col-group-search';
            grpSearchInput.placeholder = 'Filter columns\u2026';
            grpSearchInput.setAttribute('autocomplete', 'off');
            grpSearchInput.value = _groupSearchTerms[group.alias] ?? '';

            const grpClearBtn = document.createElement('button');
            grpClearBtn.type = 'button';
            grpClearBtn.className = 'col-search-clear';
            grpClearBtn.textContent = '✕';
            grpClearBtn.title = 'Clear filter';
            grpClearBtn.style.display = grpSearchInput.value ? '' : 'none';

            grpClearBtn.addEventListener('click', e => {
                e.stopPropagation();
                grpSearchInput.value = '';
                _groupSearchTerms[group.alias] = '';
                grpClearBtn.style.display = 'none';
                _filterSelectColumns();
                grpSearchInput.focus();
            });

            grpSearchInput.addEventListener('mousedown', e => e.stopPropagation());
            grpSearchInput.addEventListener('keydown', e => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    grpSearchInput.value = '';
                    _groupSearchTerms[group.alias] = '';
                    grpClearBtn.style.display = 'none';
                    _filterSelectColumns();
                }
            });
            grpSearchInput.addEventListener('input', () => {
                _groupSearchTerms[group.alias] = grpSearchInput.value;
                grpClearBtn.style.display = grpSearchInput.value ? '' : 'none';
                _filterSelectColumns();
            });

            grpSearchWrap.appendChild(grpSearchInput);
            grpSearchWrap.appendChild(grpClearBtn);
            container.appendChild(grpSearchWrap);

            // Table Header Drag Events
            hdr.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/table-alias', group.alias);
                e.dataTransfer.effectAllowed = 'move';
                hdr.classList.add('is-dragging');
            });
            hdr.addEventListener('dragover', (e) => {
                if (e.dataTransfer.types.includes('text/table-alias')) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    hdr.classList.add('drag-over');
                }
            });
            hdr.addEventListener('dragleave', () => hdr.classList.remove('drag-over'));
            hdr.addEventListener('dragend', () => {
                hdr.classList.remove('is-dragging');
                hdr.classList.remove('drag-over');
            });
            hdr.addEventListener('drop', (e) => {
                const fromAlias = e.dataTransfer.getData('text/table-alias');
                if (fromAlias && fromAlias !== group.alias) {
                    e.preventDefault();
                    hdr.classList.remove('drag-over');

                    // Reorder State.columnOrder by moving all columns of fromAlias
                    const fromCols = State.columnOrder.filter(k => k.split('.')[0] === fromAlias);
                    const remainingCols = State.columnOrder.filter(k => k.split('.')[0] !== fromAlias);
                    
                    // Find where to insert
                    const targetIdx = remainingCols.findIndex(k => k.split('.')[0] === group.alias);
                    
                    // To handle moving down correctly (dropping on a header means inserting AFTER that table's columns)
                    const targetTableColsCount = remainingCols.filter(k => k.split('.')[0] === group.alias).length;
                    
                    // Determine if we are moving down or up
                    const allAliases = [];
                    State.columnOrder.forEach(k => {
                        const a = k.split('.')[0];
                        if (!allAliases.includes(a)) allAliases.push(a);
                    });
                    const fromPos = allAliases.indexOf(fromAlias);
                    const toPos   = allAliases.indexOf(group.alias);

                    if (fromPos < toPos) {
                        // Moving DOWN: insert after the target table's columns
                        remainingCols.splice(targetIdx + targetTableColsCount, 0, ...fromCols);
                    } else {
                        // Moving UP: insert before the target table's columns
                        remainingCols.splice(targetIdx, 0, ...fromCols);
                    }
                    
                    State.columnOrder = remainingCols;
                    
                    if (State.select.length > 0) {
                        State.select.sort((a, b) => State.columnOrder.indexOf(a) - State.columnOrder.indexOf(b));
                    }
                    _refreshSelect();
                    App.updateSQLPreview();
                }
            });

            // --- Column Rows ---
            group.columns.forEach((key) => {
                const globalIdx = State.columnOrder.indexOf(key);
                const isChecked = !State.selectNone && (State.select.length === 0 || State.select.includes(key));

                const row = document.createElement('div');
                row.className = 'select-col-row is-draggable';
                row.dataset.idx = globalIdx;
                if (table?.color && !_colorDisabledGroups.has(group.alias)) {
                    const r = parseInt(table.color.slice(1, 3), 16);
                    const g = parseInt(table.color.slice(3, 5), 16);
                    const b = parseInt(table.color.slice(5, 7), 16);
                    row.style.backgroundColor = `rgba(${r}, ${g}, ${b}, 0.10)`;
                }

                const dragHandle = document.createElement('div');
                dragHandle.className = 'drag-handle';
                dragHandle.innerHTML = '⋮⋮';
                dragHandle.title = 'Drag to reorder column';
                row.appendChild(dragHandle);
                let _fromHandle = false;
                dragHandle.addEventListener('mousedown', () => {
                    _fromHandle = true;
                    row.draggable = true;
                    document.addEventListener('mouseup', () => { row.draggable = false; }, { once: true, passive: true });
                });

                const lbl = document.createElement('label');
                const chk = document.createElement('input');
                chk.type = 'checkbox';
                chk.checked = isChecked;
                chk.addEventListener('change', () => {
                    if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                    if (!chk.checked) {
                        if (State.select.length === 0 && !State.selectNone) {
                            // Expand SELECT * to explicit list first, then remove this key
                            State.select = State.columnOrder.filter(k => k !== key);
                        } else {
                            State.select = State.select.filter(k => k !== key);
                        }
                        if (State.select.length === 0) State.selectNone = true;
                    } else {
                        State.selectNone = false;
                        if (!State.select.includes(key)) {
                            State.select.push(key);
                            State.select.sort((a, b) => State.columnOrder.indexOf(a) - State.columnOrder.indexOf(b));
                        }
                        if (_allColumns().every(k => State.select.includes(k))) State.select = [];
                    }
                    _refreshSelect();
                    App.updateSQLPreview();
                    Results.syncColDeselected?.(key, !chk.checked);
                });
                lbl.appendChild(chk);

                const colName = key.split('.')[1];
                const txt = document.createElement('span');
                txt.textContent = colName;
                lbl.appendChild(txt);

                // Index badge — only when the column has an index
                const colData = table?.columns?.find(c => c.name === colName);
                const colKey  = colData?.key ?? '';
                if (colKey === 'PRI' || colKey === 'UNI' || colKey === 'MUL') {
                    const badge = document.createElement('span');
                    if (colKey === 'PRI') {
                        badge.className = 'col-badge col-badge--pk';
                        badge.textContent = 'PK';
                        badge.title = 'Primary Key';
                    } else if (colKey === 'UNI') {
                        badge.className = 'col-badge col-badge--uni';
                        badge.textContent = 'UQ';
                        badge.title = 'Unique';
                    } else {
                        badge.className = 'col-badge col-badge--fk';
                        badge.textContent = 'IDX';
                        badge.title = 'Index';
                    }
                    lbl.appendChild(badge);
                }

                row.appendChild(lbl);

                // Alias input (visual mode only)
                const aliasInput = document.createElement('input');
                aliasInput.type = 'text';
                aliasInput.className = 'col-alias-input';
                aliasInput.placeholder = 'AS …';
                aliasInput.value = (State.selectAliases || {})[key] || '';
                aliasInput.title = 'Column alias (AS …)';
                aliasInput.addEventListener('mousedown', e => e.stopPropagation());
                aliasInput.addEventListener('focus', () => { if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot(); });
                aliasInput.addEventListener('dragstart', e => e.stopPropagation());
                aliasInput.addEventListener('input', () => {
                    const v = aliasInput.value.trim();
                    if (!State.selectAliases) State.selectAliases = {};
                    if (v) {
                        State.selectAliases[key] = v;
                    } else {
                        delete State.selectAliases[key];
                    }
                    App.updateSQLPreview();
                });
                row.appendChild(aliasInput);

                // Highlight checkbox — lights up the matching results column
                const highlightChk = document.createElement('input');
                highlightChk.type      = 'checkbox';
                highlightChk.className = 'col-highlight-chk';
                highlightChk.title     = 'Highlight this column in results';
                highlightChk.checked   = Results.isHighlighted?.(key) ?? false;
                highlightChk.addEventListener('mousedown', e => e.stopPropagation());
                highlightChk.addEventListener('dragstart', e => e.stopPropagation());
                highlightChk.addEventListener('change', () => {
                    // Scroll to the column whenever the highlight state changes
                    // so the user can immediately see the affected data
                    Results.highlightColumn?.(key, highlightChk.checked, true);
                });
                row.appendChild(highlightChk);

                // Right-click → center canvas on this column's table and flash-highlight the column
                row.addEventListener('contextmenu', e => {
                    e.preventDefault();
                    const [alias, colName] = key.split('.');
                    Canvas.focusColumn(alias, colName);
                });

                container.appendChild(row);

                // Column Drag Events
                row.addEventListener('dragstart', (e) => {
                    if (!_fromHandle) { e.preventDefault(); return; }
                    _fromHandle = false;
                    e.dataTransfer.setData('text/col-idx', globalIdx);
                    e.dataTransfer.effectAllowed = 'move';
                    row.classList.add('is-dragging');
                    e.stopPropagation(); // Prevent table header drag start
                });
                row.addEventListener('dragover', (e) => {
                    if (e.dataTransfer.types.includes('text/col-idx')) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        row.classList.add('drag-over');
                    }
                });
                row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
                row.addEventListener('dragend', () => {
                    _fromHandle = false;
                    row.draggable = false;
                    row.classList.remove('is-dragging');
                    row.classList.remove('drag-over');
                });
                row.addEventListener('drop', (e) => {
                    const fromIdx = parseInt(e.dataTransfer.getData('text/col-idx'), 10);
                    const toIdx = parseInt(row.dataset.idx, 10);
                    if (fromIdx !== toIdx && !isNaN(fromIdx)) {
                        e.preventDefault();
                        row.classList.remove('drag-over');
                        if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                        const movedItem = State.columnOrder.splice(fromIdx, 1)[0];
                        State.columnOrder.splice(toIdx, 0, movedItem);
                        if (State.select.length > 0) {
                            State.select.sort((a, b) => State.columnOrder.indexOf(a) - State.columnOrder.indexOf(b));
                        }
                        _refreshSelect();
                        App.updateSQLPreview();
                    }
                });
            });
        });

        // --- Search Columns bar (above Custom Expressions) ---
        const searchWrap = document.createElement('div');
        searchWrap.id = 'select-col-search-wrap';
        searchWrap.style.cssText = 'padding: 4px 0 6px; position: relative; display: flex; align-items: center;';
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.id = 'select-col-search';
        searchInput.className = 'col-search';
        searchInput.placeholder = 'Search columns\u2026';
        searchInput.setAttribute('autocomplete', 'off');
        searchInput.value = prevSearch;

        const searchClearBtn = document.createElement('button');
        searchClearBtn.type = 'button';
        searchClearBtn.className = 'col-search-clear';
        searchClearBtn.textContent = '✕';
        searchClearBtn.title = 'Clear search';
        searchClearBtn.style.display = prevSearch ? '' : 'none';
        searchClearBtn.addEventListener('click', () => {
            searchInput.value = '';
            searchClearBtn.style.display = 'none';
            _filterSelectColumns();
            searchInput.focus();
        });

        searchInput.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                searchInput.value = '';
                searchClearBtn.style.display = 'none';
                _filterSelectColumns();
            }
        });
        searchInput.addEventListener('input', () => {
            _filterSelectColumns();
            searchClearBtn.style.display = searchInput.value ? '' : 'none';
            searchInput.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        });
        searchWrap.appendChild(searchInput);
        searchWrap.appendChild(searchClearBtn);
        container.appendChild(searchWrap);

        // --- Custom Expressions section ---
        const exprs = State.selectCustomExprs ?? [];

        const exprSectionHdr = document.createElement('div');
        exprSectionHdr.className = 'select-table-hdr';
        exprSectionHdr.style.marginTop = '12px';

        const exprHdrTxt = document.createElement('span');
        exprHdrTxt.style.flex = '1';
        exprHdrTxt.style.fontFamily = 'var(--font-mono)';
        exprHdrTxt.style.color = 'var(--text-muted)';
        exprHdrTxt.textContent = 'Custom Expressions';
        exprSectionHdr.appendChild(exprHdrTxt);

        const addExprBtn = document.createElement('button');
        addExprBtn.className = 'btn-add-expr';
        addExprBtn.textContent = '+ Add';
        addExprBtn.title = 'Add a custom SQL expression to the SELECT list';
        addExprBtn.addEventListener('mousedown', e => e.stopPropagation());
        addExprBtn.addEventListener('click', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            if (!State.selectCustomExprs) State.selectCustomExprs = [];
            State.selectCustomExprs.push({ id: 'cx_' + Date.now(), expr: '', alias: '', label: '', enabled: true });
            _refreshSelect();
            App.updateSQLPreview();
            // Focus the new expression input and scroll the Add button into view
            const rows = container.querySelectorAll('.select-expr-row');
            rows[rows.length - 1]?.querySelector('.col-alias-input')?.focus();
            document.querySelector('.btn-add-expr')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        container.appendChild(exprSectionHdr);

        // Mode radio buttons: Combined / Only / Exclude
        const exprModeBar = document.createElement('div');
        exprModeBar.className = 'expr-mode-bar';
        const currentMode = State.selectCustomExprsMode ?? 'exclude';
        [['combined', '↑↓ Combined'], ['exclude', '↑ Exclude'], ['only', '↓ Only']].forEach(([val, label]) => {
            const lbl = document.createElement('label');
            lbl.className = 'expr-mode-option';
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'expr-mode';
            radio.value = val;
            radio.checked = currentMode === val;
            radio.addEventListener('change', () => {
                if (!radio.checked) return;
                State.selectCustomExprsMode = val;
                _refreshSelect();
                App.updateSQLPreview();
            });
            lbl.appendChild(radio);
            lbl.append(' ' + label);
            exprModeBar.appendChild(lbl);
        });
        container.appendChild(exprModeBar);

        const exprLegend = document.createElement('div');
        exprLegend.className = 'select-expr-legend';
        exprLegend.textContent = 'Click to edit SQL alias · Right-click (or Shift + Enter) to edit expression';
        container.appendChild(exprLegend);

        exprs.forEach((expr, idx) => {
            container.appendChild(_buildCustomExprRow(expr, idx));
        });

        container.appendChild(addExprBtn);

        // Apply mode-based visual state to the container and option checkboxes
        const mode = State.selectCustomExprsMode ?? 'exclude';
        container.classList.toggle('exprs-mode-only',    mode === 'only');
        container.classList.toggle('exprs-mode-exclude', mode === 'exclude');
        _applyExprModeToCheckboxes(mode);

        _filterSelectColumns();
    }

    // -------------------------------------------------------------------------
    // SELECT filter state
    // -------------------------------------------------------------------------
    let _showCheckedOnly     = false;
    let _checkedOnlySnapshot = null; // Set of column keys that were checked when the toggle was activated
    const _minimizedGroups   = new Set(); // aliases of collapsed table groups
    const _colorDisabledGroups = new Set(); // aliases where table color is suppressed in SELECT header
    const _groupSearchTerms  = {};   // alias → current per-group search string
    let _allMinimized        = false;

    // -------------------------------------------------------------------------
    // Custom expression expand popup (singleton)
    // -------------------------------------------------------------------------
    let _exprPopup = null;
    let _exprPopupTA = null;
    let _exprPopupInput = null;
    let _exprPopupOnClose = null;
    let _exprPopupOnShiftEnter = null; // when set, Shift+Enter calls this instead of closing

    function _ensureExprPopup() {
        if (_exprPopup) return;

        _exprPopup = document.createElement('div');
        _exprPopup.className = 'expr-popup';
        _exprPopup.style.display = 'none';
        _exprPopup.innerHTML = `
            <div class="expr-popup-header">
                <span class="expr-popup-title">EDIT SELECT EXPRESSION</span>
                <button class="expr-popup-close" title="Close">✕</button>
            </div>
            <textarea class="expr-popup-ta" spellcheck="false" placeholder="SQL expression…"></textarea>
            <input type="text" class="expr-popup-input" spellcheck="false" placeholder="Label…">
            <div class="expr-popup-actions">
                <button type="button" class="btn-outline-blue expr-popup-explain">⚙ Explain</button>
                <button type="button" class="primary expr-popup-run">▶ Run</button>
            </div>`;
        document.body.appendChild(_exprPopup);

        _exprPopupTA    = _exprPopup.querySelector('.expr-popup-ta');
        _exprPopupInput = _exprPopup.querySelector('.expr-popup-input');

        // Backdrop is attached in _openExprPopup, after the popup is visible,
        // so the layout (flex vs block) is detected correctly.

        _exprPopup.querySelector('.expr-popup-run').addEventListener('click', () => {
            const sql = _exprPopupTA.value.trim();
            if (!sql) return;
            App.runSql(sql);
        });

        _exprPopup.querySelector('.expr-popup-explain').addEventListener('click', () => {
            const sql = _exprPopupTA.value.trim();
            if (!sql) return;
            const explainSql = /^explain\s/i.test(sql) ? sql : 'EXPLAIN ' + sql;
            App.runSql(explainSql);
        });

        _exprPopup.querySelector('.expr-popup-close').addEventListener('click', _closeExprPopup);

        const _epMaxBtn = document.createElement('button');
        _epMaxBtn.type = 'button';
        _epMaxBtn.className = 'btn-popup-maximize';
        _epMaxBtn.textContent = '⤢';
        _epMaxBtn.title = 'Maximize';
        _epMaxBtn.addEventListener('click', () => App.toggleMaximizePopup?.(_exprPopup));
        _exprPopup.querySelector('.expr-popup-close').before(_epMaxBtn);

        // Make the popup draggable via its header
        const _epHeader = _exprPopup.querySelector('.expr-popup-header');
        _epHeader.addEventListener('mousedown', e => {
            if (e.target.closest('button')) return;
            const r = _exprPopup.getBoundingClientRect();
            _exprPopup.style.transform = 'none';
            _exprPopup.style.left      = r.left + 'px';
            _exprPopup.style.top       = r.top  + 'px';
            const ox = e.clientX - r.left;
            const oy = e.clientY - r.top;
            document.body.style.userSelect = 'none';
            function onMove(ev) {
                let x = ev.clientX - ox;
                let y = ev.clientY - oy;
                x = Math.max(0, Math.min(window.innerWidth  - _exprPopup.offsetWidth,  x));
                y = Math.max(0, Math.min(window.innerHeight - _exprPopup.offsetHeight, y));
                _exprPopup.style.left = x + 'px';
                _exprPopup.style.top  = y + 'px';
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

        document.addEventListener('mousedown', e => {
            if (_exprPopup.style.display !== 'none'
                && !_exprPopup.contains(e.target)
                && !e.target.classList.contains('btn-expr-expand')
                && !e.target.dataset.exprTrigger) {
                _closeExprPopup();
            }
        });

        // Alt+E while the popup textarea/input is focused → save + close.
        // Using a listener on the elements themselves (rather than document) lets
        // stopPropagation prevent the global Alt+G / Alt+E canvas shortcuts.
        const _altEClose = e => {
            if (e.altKey && e.code === 'KeyE') {
                e.preventDefault();
                e.stopPropagation();
                if (_exprPopupOnShiftEnter) _exprPopupOnShiftEnter();
                _closeExprPopup();
            }
        };
        _exprPopupTA.addEventListener('keydown',    _altEClose);
        _exprPopupInput.addEventListener('keydown', _altEClose);

        document.addEventListener('keydown', e => {
            if (_exprPopup.style.display === 'none') return;
            if (e.key === 'Escape') {
                e.preventDefault();
                _closeExprPopup();
                return;
            }
            // Shift+Enter: run the onShiftEnter callback (if any) then always close
            if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault();
                if (_exprPopupOnShiftEnter) _exprPopupOnShiftEnter();
                _closeExprPopup();
            }
        });
    }

    // Bind right-click + Shift+Enter on any input to open the expr popup,
    // and return focus to that input when the popup closes.
    // getTitle is called at open-time so it can reflect current input state.
    function _bindExprPopupTrigger(input, getTitle, getValue, onUpdate) {
        input.dataset.exprTrigger = '1';
        const _open = () => _openExprPopup(getValue, onUpdate, getTitle(), false, () => input.focus());
        input.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); _open(); });
        input.addEventListener('dblclick',    e => { if (!e.altKey) return; e.stopPropagation(); _open(); });
        input.addEventListener('keydown', e => {
            if (e.shiftKey && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); _open(); }
            if (e.altKey  && e.code === 'KeyE')  { e.preventDefault(); e.stopPropagation(); _open(); }
        });
    }

    // options: { hideActions: bool, onShiftEnter: fn }
    function _openExprPopup(getValue, onUpdate, title, isLabel = false, onClose = null, options = {}) {
        _exprPopupOnClose      = onClose;
        _exprPopupOnShiftEnter = options.onShiftEnter ?? null;
        _ensureExprPopup();
        _exprPopup.querySelector('.expr-popup-title').textContent = title;
        _exprPopup.classList.toggle('expr-popup--label', isLabel);
        // Show or hide the Run / Explain action buttons depending on context
        _exprPopup.querySelector('.expr-popup-actions').style.display =
            (options.hideActions || isLabel) ? 'none' : '';

        const activeEl  = isLabel ? _exprPopupInput : _exprPopupTA;
        const inactiveEl = isLabel ? _exprPopupTA : _exprPopupInput;

        inactiveEl.style.display = 'none';
        activeEl.style.display   = 'block';
        if (isLabel) _exprPopup.style.height = '';
        activeEl.value = getValue();

        // Only reset to centre when the popup is currently hidden so a dragged
        // position is preserved when switching between expression inputs.
        if (_exprPopup.style.display === 'none') {
            _exprPopup.style.left      = '';
            _exprPopup.style.top       = '';
            _exprPopup.style.transform = '';
        }
        _exprPopup.style.display = 'flex';
        // Attach backdrop now that the popup is visible so the flex layout is
        // detected correctly. attach() is idempotent; refresh() re-renders the
        // pre with the value that was just loaded (setValue fires no input event).
        if (typeof SqlBackdrop !== 'undefined') {
            SqlBackdrop.attach(_exprPopupTA);
            SqlBackdrop.refresh(_exprPopupTA);
        }
        setTimeout(() => _exprPopupTA.focus(), 0);

        activeEl.oninput = () => {
            onUpdate(activeEl.value);
        };
    }

    function _closeExprPopup() {
        if (_exprPopup) _exprPopup.style.display = 'none';
        _exprPopupOnShiftEnter = null;
        const cb = _exprPopupOnClose;
        _exprPopupOnClose = null;
        cb?.();
    }

    function _buildCustomExprRow(expr, idx) {
        const row = document.createElement('div');
        row.className = 'select-expr-row is-draggable';
        row.dataset.exprIdx = idx;

        const dragHandle = document.createElement('div');
        dragHandle.className = 'drag-handle';
        dragHandle.innerHTML = '⋮⋮';
        dragHandle.title = 'Drag to reorder expression';
        row.appendChild(dragHandle);
        let _fromHandle = false;
        dragHandle.addEventListener('mousedown', () => {
            _fromHandle = true;
            row.draggable = true;
            document.addEventListener('mouseup', () => { row.draggable = false; }, { once: true, passive: true });
        });

        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = expr.enabled !== false;
        chk.style.flexShrink = '0';
        chk.addEventListener('change', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            State.selectCustomExprs[idx].enabled = chk.checked;
            App.updateSQLPreview();
        });
        row.appendChild(chk);

        const aliasInput = document.createElement('input');
        aliasInput.type = 'text';
        aliasInput.className = 'col-alias-input';
        aliasInput.placeholder = 'AS …';
        aliasInput.value = expr.alias ?? '';
        aliasInput.title = 'Column alias (AS …) · Right-click to edit SQL expression';
        aliasInput.addEventListener('mousedown', e => e.stopPropagation());
        aliasInput.addEventListener('focus', () => { if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot(); });
        aliasInput.addEventListener('dragstart', e => e.stopPropagation());
        _bindExprPopupTrigger(
            aliasInput,
            () => `EDIT SELECT EXPRESSION ${idx + 1}` + (aliasInput.value.trim() ? ` - ${aliasInput.value.trim()}` : ''),
            () => State.selectCustomExprs[idx].expr,
            val => { State.selectCustomExprs[idx].expr = val; App.updateSQLPreview(); }
        );
        aliasInput.addEventListener('input', () => {
            const oldAlias = State.selectCustomExprs[idx]?.alias?.trim();
            const newAlias = aliasInput.value.trim();
            // If alias changed while highlighted, remove the old highlight
            if (oldAlias && highlightChk.checked && oldAlias !== newAlias) {
                Results.highlightColumn?.(oldAlias, false, false);
                highlightChk.checked = false;
            }
            State.selectCustomExprs[idx].alias = newAlias;
            App.updateSQLPreview();
            // Enable highlight checkbox only when an alias is set
            highlightChk.disabled = !newAlias;
            highlightChk.title    = newAlias
                ? 'Highlight this column in results'
                : 'Set an alias to enable column highlighting';
        });
        row.appendChild(aliasInput);

        // Highlight checkbox — works only when an alias is set (alias = DB column name)
        const hlKey = expr.alias?.trim() || null;
        const highlightChk = document.createElement('input');
        highlightChk.type      = 'checkbox';
        highlightChk.className = 'col-highlight-chk';
        highlightChk.disabled  = !hlKey;
        highlightChk.title     = hlKey
            ? 'Highlight this column in results'
            : 'Set an alias to enable column highlighting';
        highlightChk.checked   = hlKey ? (Results.isHighlighted?.(hlKey) ?? false) : false;
        highlightChk.addEventListener('mousedown', e => e.stopPropagation());
        highlightChk.addEventListener('dragstart', e => e.stopPropagation());
        highlightChk.addEventListener('change', () => {
            const key = State.selectCustomExprs[idx]?.alias?.trim();
            if (key) Results.highlightColumn?.(key, highlightChk.checked, true);
        });
        row.appendChild(highlightChk);

        const rmBtn = document.createElement('button');
        rmBtn.className = 'btn-remove';
        rmBtn.textContent = '✕';
        rmBtn.title = 'Remove expression';
        rmBtn.addEventListener('click', async () => {
            if (!await Dialog.confirm('Remove this custom expression?')) return;
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            // Clean up any active highlight before removing the row
            const key = State.selectCustomExprs[idx]?.alias?.trim();
            if (key && highlightChk.checked) Results.highlightColumn?.(key, false, false);
            State.selectCustomExprs.splice(idx, 1);
            _refreshSelect();
            App.updateSQLPreview();
        });
        row.appendChild(rmBtn);

        // Drag-to-reorder events
        row.addEventListener('dragstart', e => {
            if (!_fromHandle) { e.preventDefault(); return; }
            _fromHandle = false;
            e.dataTransfer.setData('text/expr-idx', idx);
            e.dataTransfer.effectAllowed = 'move';
            row.classList.add('is-dragging');
            e.stopPropagation();
        });
        row.addEventListener('dragover', e => {
            if (e.dataTransfer.types.includes('text/expr-idx')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                row.classList.add('drag-over');
            }
        });
        row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
        row.addEventListener('dragend',   () => {
            _fromHandle = false;
            row.draggable = false;
            row.classList.remove('is-dragging');
            row.classList.remove('drag-over');
        });
        row.addEventListener('drop', e => {
            if (!e.dataTransfer.types.includes('text/expr-idx')) return;
            e.preventDefault();
            e.stopPropagation();
            row.classList.remove('drag-over');
            const fromIdx = parseInt(e.dataTransfer.getData('text/expr-idx'), 10);
            const toIdx   = parseInt(row.dataset.exprIdx, 10);
            if (isNaN(fromIdx) || fromIdx === toIdx) return;
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            const exprs = State.selectCustomExprs;
            const [moved] = exprs.splice(fromIdx, 1);
            exprs.splice(toIdx, 0, moved);
            _refreshSelect();
            App.updateSQLPreview();
        });

        return row;
    }

    function _filterSelectColumns() {
        const term = (document.getElementById('select-col-search')?.value ?? '').trim().toLowerCase();
        const container = document.getElementById('select-columns');
        if (!container) return;

        // If _showCheckedOnly is active but no snapshot yet (e.g. after context restore),
        // build it now from all column rows across all groups before filtering.
        if (_showCheckedOnly && _checkedOnlySnapshot === null) {
            _checkedOnlySnapshot = new Set();
            container.querySelectorAll('.select-col-row').forEach(r => {
                if (r.querySelector('input[type="checkbox"]')?.checked) {
                    const key = State.columnOrder[parseInt(r.dataset.idx)];
                    if (key) _checkedOnlySnapshot.add(key);
                }
            });
        }

        let anyVisible = false;
        const hdrs = container.querySelectorAll('.select-table-hdr');

        hdrs.forEach(hdr => {
            const alias = hdr.dataset.alias ?? '';
            const groupTerm = (_groupSearchTerms[alias] ?? '').trim().toLowerCase();
            // collect all column rows and the group search wrap following this header until the next header
            const rows = [];
            let grpWrap = null;
            let el = hdr.nextElementSibling;
            while (el && !el.classList.contains('select-table-hdr')) {
                if (el.classList.contains('select-col-row')) rows.push(el);
                else if (el.classList.contains('col-group-search-wrap')) grpWrap = el;
                el = el.nextElementSibling;
            }

            const minimized = _minimizedGroups.has(alias);

            if (minimized) {
                // Keep the header visible so the user can expand; hide rows and group search
                hdr.style.display = '';
                if (grpWrap) grpWrap.style.display = 'none';
                rows.forEach(r => (r.style.display = 'none'));
                anyVisible = true;
                return;
            }

            if (grpWrap) grpWrap.style.display = '';

            if (!term && !groupTerm && !_showCheckedOnly) {
                hdr.style.display = '';
                rows.forEach(r => (r.style.display = ''));
                anyVisible = true;
                return;
            }

            let groupVisible = false;
            rows.forEach(r => {
                const colName = r.querySelector('label span')?.textContent?.toLowerCase() ?? '';
                const matchesTerm = !term || colName.includes(term) || alias.toLowerCase().includes(term);
                const matchesGroupTerm = !groupTerm || colName.includes(groupTerm);
                const matchesChecked = !_showCheckedOnly ||
                    _checkedOnlySnapshot.has(State.columnOrder[parseInt(r.dataset.idx)] ?? '');
                const visible = matchesTerm && matchesGroupTerm && matchesChecked;
                r.style.display = visible ? '' : 'none';
                if (visible) groupVisible = true;
            });

            // Keep header visible when the per-group search is active (even with 0 matches)
            hdr.style.display = (groupVisible || groupTerm) ? '' : 'none';
            if (groupVisible || groupTerm) anyVisible = true;
        });

        // "no match" message
        let noMatch = container.querySelector('.col-search-no-match');
        if (term && !anyVisible) {
            if (!noMatch) {
                noMatch = document.createElement('div');
                noMatch.className = 'col-search-no-match';
                container.appendChild(noMatch);
            }
            noMatch.textContent = `No columns matching "${document.getElementById('select-col-search').value.trim()}"`;
        } else if (noMatch) {
            noMatch.remove();
        }
    }

    /** Returns all alias.col keys across every table currently on the canvas */
    function _allColumns() {
        const out = [];
        State.tables.forEach(t => (t.columns ?? []).forEach(c => out.push(`${t.alias}.${c.name}`)));
        return out;
    }

    /**
     * Returns only the tables belonging to the currently selected island.
     * Falls back to all tables when there is only 1 island or no island is selected.
     */
    function _activeTables() {
        if (!State.selectedIslandKey) return State.tables;
        const enabledJoins = State.joins.filter(j => j.enabled !== false);
        const islands = App.computeIslands(State.tables, enabledJoins);
        if (islands.length <= 1) return State.tables;
        const ids = new Set(State.selectedIslandKey.split('|'));
        return State.tables.filter(t => ids.has(t.id));
    }

    /** Returns alias.col keys for only the active island's tables. */
    function _activeColumns() {
        const out = [];
        _activeTables().forEach(t => (t.columns ?? []).forEach(c => out.push(`${t.alias}.${c.name}`)));
        return out;
    }

    /**
     * Given a flat array of "alias.col" keys, inject '|||' between consecutive
     * runs that belong to different table aliases.
     * e.g. ['t1.a','t1.b','t2.c'] → "t1.a, t1.b, '|||', t2.c"
     */
    function _colWithAlias(key) {
        const sqlAlias = (State.selectAliases || {})[key];
        return sqlAlias ? `${key} AS ${sqlAlias}` : key;
    }

    function _injectDelimiters(cols) {
        const parts = [];
        let prevAlias = null;
        cols.forEach(key => {
            const alias = key.split('.')[0];
            if (prevAlias !== null && alias !== prevAlias) {
                parts.push("'|||'");
            }
            parts.push(_colWithAlias(key));
            prevAlias = alias;
        });
        return parts.join(', ');
    }

    /**
     * Used when BOTH sort-alpha AND delimiter are active.
     * Columns are already alpha-sorted by sort key; insert '|||' between
     * groups whose sort key (alias or bare column name) differs.
     */
    function _injectDelimitersByGroup(cols) {
        const aliases = State.selectAliases || {};
        const sortKeyFor = key => {
            const alias = (aliases[key] || '').trim();
            if (alias) return alias.toLowerCase();
            return (String(key).includes('.') ? String(key).split('.')[1] : String(key)).toLowerCase();
        };
        const parts = [];
        let prevSortKey = null;
        cols.forEach(key => {
            const sk = sortKeyFor(key);
            if (prevSortKey !== null && sk !== prevSortKey) {
                parts.push("'|||'");
            }
            parts.push(_colWithAlias(key));
            prevSortKey = sk;
        });
        return parts.join(', ');
    }

    // =========================================================================
    // WHERE section
    // =========================================================================
    function _refreshWhere() {
        const container = document.getElementById('where-conditions');
        container.innerHTML = '';

        State.where.forEach((cond, idx) => {
            container.appendChild(_buildConditionRow(cond, idx));
        });

        // "+ Raw Condition" button (visual mode only)
        if (State.whereMode !== 'raw') {
            const addRawBtn = document.createElement('button');
            addRawBtn.className = 'btn-add-raw-cond';
            addRawBtn.textContent = '+ Raw Condition';
            addRawBtn.title = 'Add a free-form SQL condition (subqueries, EXISTS, expressions, etc.)';
            addRawBtn.addEventListener('click', () => {
                if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                State.where.push({ type: 'raw', expr: '', operator: 'AND' });
                _refreshWhere();
                App.updateSQLPreview();
                container.querySelectorAll('.where-expr-input')
                    [container.querySelectorAll('.where-expr-input').length - 1]?.focus();
            });
            container.appendChild(addRawBtn);
        }

        // Sync raw textarea
        if (State.whereMode === 'raw') {
            document.getElementById('where-raw-input').value = State.whereRaw ?? '';
        }

        // Keep canvas column highlights in sync with WHERE state
        Canvas.refreshWhereHighlights();
    }

    function _buildConditionRow(cond, idx) {
        if (cond.type === 'raw') return _buildRawConditionRow(cond, idx);

        const OPS = ['=', '!=', '<', '>', '<=', '>=', 'LIKE', 'NOT LIKE', 'IS NULL', 'IS NOT NULL', 'IN', 'NOT IN', 'BETWEEN', 'NOT BETWEEN'];
        const noVal    = cond.op === 'IS NULL' || cond.op === 'IS NOT NULL';
        const isBetween = cond.op === 'BETWEEN' || cond.op === 'NOT BETWEEN';

        const row = document.createElement('div');
        row.className = 'condition-row';
        if (cond.enabled === false) row.classList.add('is-excluded');
        row.dataset.idx = idx;
        if (cond.startGroup) row.classList.add('has-start-paren');
        if (cond.endGroup)   row.classList.add('has-end-paren');

        // Enable / disable checkbox — leftmost element
        const enableChk = document.createElement('input');
        enableChk.type = 'checkbox';
        enableChk.className = 'cond-enable-chk';
        enableChk.checked = cond.enabled !== false;
        enableChk.title = 'Include this condition in the query';
        enableChk.addEventListener('mousedown', e => e.stopPropagation());
        enableChk.addEventListener('change', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            State.where[idx].enabled = enableChk.checked;
            row.classList.toggle('is-excluded', !enableChk.checked);
            App.updateSQLPreview();
        });
        row.appendChild(enableChk);

        // Drag handle
        const dragHandle = document.createElement('div');
        dragHandle.className = 'drag-handle';
        dragHandle.innerHTML = '⋮⋮';
        dragHandle.title = 'Drag to reorder';
        row.appendChild(dragHandle);
        let _fromHandle = false;
        dragHandle.addEventListener('mousedown', () => {
            _fromHandle = true;
            row.draggable = true;
            document.addEventListener('mouseup', () => { row.draggable = false; }, { once: true, passive: true });
        });

        // AND/OR Toggle (only if NOT the first row)
        if (idx > 0) {
            const opToggle = document.createElement('button');
            opToggle.className = 'btn-toggle-operator';
            opToggle.textContent = cond.operator || 'AND';
            opToggle.title = 'Click to toggle between AND / OR';
            opToggle.addEventListener('click', () => {
                if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                const nextOp = opToggle.textContent === 'AND' ? 'OR' : 'AND';
                opToggle.textContent = nextOp;
                State.where[idx].operator = nextOp;
                App.updateSQLPreview();
            });
            row.appendChild(opToggle);
        }

        // Grouping Toggles
        const startParen = document.createElement('button');
        startParen.className = 'btn-paren btn-paren--start' + (cond.startGroup ? ' is-active' : '');
        startParen.textContent = '(';
        startParen.title = 'Click to toggle opening parenthesis';
        startParen.addEventListener('click', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            cond.startGroup = !cond.startGroup;
            startParen.classList.toggle('is-active', cond.startGroup);
            row.classList.toggle('has-start-paren', cond.startGroup);
            App.updateSQLPreview();
        });
        row.appendChild(startParen);

        // Column name badge
        const colSpan = document.createElement('span');
        colSpan.className = 'col-name';
        colSpan.textContent = cond.col;
        colSpan.title = cond.col;
        // Left-click → open the value editor popup (same as right-clicking the value input)
        colSpan.addEventListener('click', () => {
            _openExprPopup(
                () => valInput.value,
                val => { valInput.value = val; State.where[idx].val = val; App.updateSQLPreview(); },
                `EDIT WHERE VALUE — ${cond.col}`,
                false,
                () => valInput.focus()
            );
        });
        // Right-click → center and flash-highlight the column in the canvas table
        colSpan.addEventListener('contextmenu', e => {
            e.preventDefault();
            e.stopPropagation();
            if (cond.col && cond.col.includes('.')) {
                const [alias, colName] = cond.col.split('.');
                Canvas.focusColumn(alias, colName);
            }
        });

        // Wrapper so the schema sub-label sits directly below the col-name span
        const colWrap = document.createElement('div');
        colWrap.className = 'col-name-wrap';
        colWrap.appendChild(colSpan);
        row.appendChild(colWrap);

        // Index badge for the WHERE column
        if (cond.col && cond.col.includes('.')) {
            const [colAlias, colName] = cond.col.split('.');
            const table = State.tables.find(t => t.alias === colAlias);

            // Update the column span tooltip and add a toggleable schema.table sub-label
            if (table) {
                const schemaTable = table.database
                    ? `${table.database}.${table.name}`
                    : table.name;
                colSpan.title = schemaTable;
                colSpan.setAttribute('alt', schemaTable);

                const originLabel = document.createElement('span');
                originLabel.className = 'col-name-origin';
                originLabel.textContent = schemaTable;
                originLabel.addEventListener('click', () => {
                    originLabel.textContent = originLabel.textContent === '...'
                        ? schemaTable
                        : '...';
                });
                colWrap.appendChild(originLabel);
            }

            const colData = table?.columns?.find(c => c.name === colName);
            const colKey = colData?.key ?? '';
            if (colData && colKey !== 'PRI' && colKey !== 'UNI' && colKey !== 'MUL') {
                colSpan.classList.add('col-name--no-index');
            }
            if (colKey === 'PRI' || colKey === 'UNI' || colKey === 'MUL') {
                const badge = document.createElement('span');
                if (colKey === 'PRI') {
                    badge.className = 'col-badge col-badge--pk';
                    badge.textContent = 'PK';
                    badge.title = 'Primary Key';
                } else if (colKey === 'UNI') {
                    badge.className = 'col-badge col-badge--uni';
                    badge.textContent = 'UQ';
                    badge.title = 'Unique';
                } else {
                    badge.className = 'col-badge col-badge--fk';
                    badge.textContent = 'IDX';
                    badge.title = 'Index';
                }
                row.appendChild(badge);
            }
        }

        // Operator select
        const opSel = document.createElement('select');
        OPS.forEach(op => {
            const opt = document.createElement('option');
            opt.value = op; opt.textContent = op;
            if (op === cond.op) opt.selected = true;
            opSel.appendChild(opt);
        });
        opSel.addEventListener('change', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            State.where[idx].op = opSel.value;
            const noV  = opSel.value === 'IS NULL' || opSel.value === 'IS NOT NULL';
            const isBtw = opSel.value === 'BETWEEN' || opSel.value === 'NOT BETWEEN';
            valInput.style.display  = noV ? 'none' : '';
            valInput.placeholder    = isBtw ? 'from' : 'value';
            val2Input.style.display = (!noV && isBtw) ? '' : 'none';
            App.updateSQLPreview();
        });
        row.appendChild(opSel);

        // Value input
        const valInput = document.createElement('input');
        valInput.type        = 'text';
        valInput.placeholder = isBetween ? 'from' : 'value';
        valInput.value       = cond.val ?? '';
        valInput.style.display = noVal ? 'none' : '';
        valInput.addEventListener('focus', () => { if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot(); });
        valInput.addEventListener('input', () => {
            State.where[idx].val = valInput.value;
            App.updateSQLPreview();
        });
        _bindExprPopupTrigger(
            valInput,
            () => `EDIT WHERE VALUE — ${cond.col}`,
            () => valInput.value,
            val => { valInput.value = val; State.where[idx].val = val; App.updateSQLPreview(); }
        );
        row.appendChild(valInput);

        // Second value input for BETWEEN / NOT BETWEEN
        const val2Input = document.createElement('input');
        val2Input.type        = 'text';
        val2Input.placeholder = 'to';
        val2Input.value       = cond.val2 ?? '';
        val2Input.style.display = isBetween ? '' : 'none';
        val2Input.addEventListener('focus', () => { if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot(); });
        val2Input.addEventListener('input', () => {
            State.where[idx].val2 = val2Input.value;
            App.updateSQLPreview();
        });
        _bindExprPopupTrigger(
            val2Input,
            () => `EDIT WHERE VALUE — ${cond.col}`,
            () => val2Input.value,
            val => { val2Input.value = val; State.where[idx].val2 = val; App.updateSQLPreview(); }
        );
        row.appendChild(val2Input);

        const endParen = document.createElement('button');
        endParen.className = 'btn-paren btn-paren--end' + (cond.endGroup ? ' is-active' : '');
        endParen.textContent = ')';
        endParen.title = 'Click to toggle closing parenthesis';
        endParen.addEventListener('click', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            cond.endGroup = !cond.endGroup;
            endParen.classList.toggle('is-active', cond.endGroup);
            row.classList.toggle('has-end-paren', cond.endGroup);
            App.updateSQLPreview();
        });
        row.appendChild(endParen);

        const rmBtn = document.createElement('button');
        rmBtn.className = 'btn-remove';
        rmBtn.textContent = '✕';
        rmBtn.title = 'Remove condition';
        rmBtn.addEventListener('click', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            State.where.splice(idx, 1);
            _refreshWhere();
            App.updateSQLPreview();
        });
        row.appendChild(rmBtn);

        // --- Drag events ---
        row.addEventListener('dragstart', (e) => {
            if (!_fromHandle) { e.preventDefault(); return; }
            _fromHandle = false;
            e.dataTransfer.setData('text/plain', idx);
            e.dataTransfer.effectAllowed = 'move';
            row.classList.add('is-dragging');
        });

        row.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            row.classList.add('drag-over');
        });

        row.addEventListener('dragleave', () => {
            row.classList.remove('drag-over');
        });

        row.addEventListener('dragend', () => {
            _fromHandle = false;
            row.draggable = false;
            row.classList.remove('is-dragging');
            row.classList.remove('drag-over');
        });

        row.addEventListener('drop', (e) => {
            e.preventDefault();
            row.classList.remove('drag-over');
            const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
            const toIdx = parseInt(row.dataset.idx, 10);

            if (fromIdx !== toIdx && !isNaN(fromIdx)) {
                if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                const movedItem = State.where.splice(fromIdx, 1)[0];
                State.where.splice(toIdx, 0, movedItem);
                _refreshWhere();
                App.updateSQLPreview();
            }
        });

        return row;
    }

    function _buildRawConditionRow(cond, idx) {
        const row = document.createElement('div');
        row.className = 'condition-row condition-row--raw';
        if (cond.enabled === false) row.classList.add('is-excluded');
        row.dataset.idx = idx;
        if (cond.startGroup) row.classList.add('has-start-paren');
        if (cond.endGroup)   row.classList.add('has-end-paren');

        // Enable / disable checkbox — leftmost element
        const enableChk = document.createElement('input');
        enableChk.type = 'checkbox';
        enableChk.className = 'cond-enable-chk';
        enableChk.checked = cond.enabled !== false;
        enableChk.title = 'Include this condition in the query';
        enableChk.addEventListener('mousedown', e => e.stopPropagation());
        enableChk.addEventListener('change', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            State.where[idx].enabled = enableChk.checked;
            row.classList.toggle('is-excluded', !enableChk.checked);
            App.updateSQLPreview();
        });
        row.appendChild(enableChk);

        // Drag handle
        const dragHandle = document.createElement('div');
        dragHandle.className = 'drag-handle';
        dragHandle.innerHTML = '⋮⋮';
        dragHandle.title = 'Drag to reorder';
        row.appendChild(dragHandle);
        let _fromHandle = false;
        dragHandle.addEventListener('mousedown', () => {
            _fromHandle = true;
            row.draggable = true;
            document.addEventListener('mouseup', () => { row.draggable = false; }, { once: true, passive: true });
        });

        // AND/OR toggle (skip for first row)
        if (idx > 0) {
            const opToggle = document.createElement('button');
            opToggle.className = 'btn-toggle-operator';
            opToggle.textContent = cond.operator || 'AND';
            opToggle.title = 'Click to toggle AND / OR';
            opToggle.addEventListener('click', () => {
                if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                const next = opToggle.textContent === 'AND' ? 'OR' : 'AND';
                opToggle.textContent = next;
                State.where[idx].operator = next;
                App.updateSQLPreview();
            });
            row.appendChild(opToggle);
        }

        // Opening paren
        const startParen = document.createElement('button');
        startParen.className = 'btn-paren btn-paren--start' + (cond.startGroup ? ' is-active' : '');
        startParen.textContent = '(';
        startParen.title = 'Toggle opening parenthesis';
        startParen.addEventListener('click', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            cond.startGroup = !cond.startGroup;
            startParen.classList.toggle('is-active', cond.startGroup);
            row.classList.toggle('has-start-paren', cond.startGroup);
            App.updateSQLPreview();
        });
        row.appendChild(startParen);

        // Expression input
        const exprInput = document.createElement('input');
        exprInput.type = 'text';
        exprInput.className = 'where-expr-input';
        exprInput.placeholder = 'SQL condition…';
        exprInput.value = cond.expr ?? '';
        exprInput.title = 'Free-form SQL condition (e.g. EXISTS (SELECT ...) or u.score > (SELECT AVG(...)))';
        exprInput.addEventListener('mousedown', e => e.stopPropagation());
        exprInput.addEventListener('focus', () => { if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot(); });
        exprInput.addEventListener('dragstart', e => e.stopPropagation());
        exprInput.addEventListener('input', () => {
            State.where[idx].expr = exprInput.value;
            App.updateSQLPreview();
        });
        _bindExprPopupTrigger(
            exprInput,
            () => 'EDIT WHERE EXPRESSION',
            () => exprInput.value,
            val => { exprInput.value = val; State.where[idx].expr = val; App.updateSQLPreview(); }
        );
        row.appendChild(exprInput);

        // Expand button (reuses shared popup)
        const expandBtn = document.createElement('button');
        expandBtn.className = 'btn-expr-expand';
        expandBtn.title = 'Edit in expanded view';
        expandBtn.textContent = '⤢';
        expandBtn.addEventListener('mousedown', e => e.stopPropagation());
        expandBtn.addEventListener('click', e => {
            e.stopPropagation();
            _openExprPopup(
                () => exprInput.value,
                val => { exprInput.value = val; State.where[idx].expr = val; App.updateSQLPreview(); },
                `Edit Expression`
            );
        });
        row.appendChild(expandBtn);

        // Closing paren
        const endParen = document.createElement('button');
        endParen.className = 'btn-paren btn-paren--end' + (cond.endGroup ? ' is-active' : '');
        endParen.textContent = ')';
        endParen.title = 'Toggle closing parenthesis';
        endParen.addEventListener('click', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            cond.endGroup = !cond.endGroup;
            endParen.classList.toggle('is-active', cond.endGroup);
            row.classList.toggle('has-end-paren', cond.endGroup);
            App.updateSQLPreview();
        });
        row.appendChild(endParen);

        // Remove button
        const rmBtn = document.createElement('button');
        rmBtn.className = 'btn-remove';
        rmBtn.textContent = '✕';
        rmBtn.title = 'Remove condition';
        rmBtn.addEventListener('click', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            State.where.splice(idx, 1);
            _refreshWhere();
            App.updateSQLPreview();
        });
        row.appendChild(rmBtn);

        // Drag events
        row.addEventListener('dragstart', e => {
            if (!_fromHandle) { e.preventDefault(); return; }
            _fromHandle = false;
            e.dataTransfer.setData('text/plain', String(idx));
            e.dataTransfer.effectAllowed = 'move';
            row.classList.add('is-dragging');
        });
        row.addEventListener('dragend', () => { _fromHandle = false; row.draggable = false; row.classList.remove('is-dragging'); });
        row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('drag-over'); });
        row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
        row.addEventListener('drop', e => {
            const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
            const toIdx = parseInt(row.dataset.idx, 10);
            if (fromIdx !== toIdx && !isNaN(fromIdx)) {
                e.preventDefault();
                row.classList.remove('drag-over');
                if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                const moved = State.where.splice(fromIdx, 1)[0];
                State.where.splice(toIdx, 0, moved);
                _refreshWhere();
                App.updateSQLPreview();
            }
        });

        return row;
    }

    // =========================================================================
    // GROUP BY section
    // =========================================================================
    function _refreshGroupBy() {
        const container = document.getElementById('groupby-columns');
        container.innerHTML = '';

        State.groupBy.forEach((col, idx) => {
            const row = _buildGroupRow(col, idx);
            container.appendChild(row);
        });

        if (State.groupByMode === 'raw') {
            document.getElementById('groupby-raw-input').value = State.groupByRaw ?? '';
        }
    }

    function _buildGroupRow(col, idx) {
        const row = document.createElement('div');
        row.className = 'condition-row';

        const colSpan = document.createElement('span');
        colSpan.className = 'col-name';
        colSpan.textContent = col;
        colSpan.title = col;
        colSpan.addEventListener('contextmenu', e => {
            e.preventDefault();
            e.stopPropagation();
            if (col.includes('.')) {
                const [alias, colName] = col.split('.');
                Canvas.focusColumn(alias, colName);
            }
        });
        row.appendChild(colSpan);

        const rmBtn = document.createElement('button');
        rmBtn.className = 'btn-remove';
        rmBtn.textContent = '✕';
        rmBtn.title = 'Remove group column';
        rmBtn.addEventListener('click', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            State.groupBy.splice(idx, 1);
            _refreshGroupBy();
            App.updateSQLPreview();
        });
        row.appendChild(rmBtn);

        return row;
    }

    // =========================================================================
    // HAVING section
    // =========================================================================
    function _refreshHaving() {
        const container = document.getElementById('having-conditions');
        container.innerHTML = '';

        State.having.forEach((cond, idx) => {
            const row = _buildHavingRow(cond, idx);
            container.appendChild(row);
        });

        if (State.havingMode === 'raw') {
            document.getElementById('having-raw-input').value = State.havingRaw ?? '';
        }
    }

    function _buildHavingRow(cond, idx) {
        const row = document.createElement('div');
        row.className = 'condition-row';

        const colSpan = document.createElement('span');
        colSpan.className = 'col-name';
        colSpan.textContent = cond.col;
        colSpan.title = cond.col;
        colSpan.addEventListener('contextmenu', e => {
            e.preventDefault();
            e.stopPropagation();
            if (cond.col.includes('.')) {
                const [alias, colName] = cond.col.split('.');
                Canvas.focusColumn(alias, colName);
            }
        });
        row.appendChild(colSpan);

        // Operator dropdown
        const opSel = document.createElement('select');
        const ops = ['=', '!=', '<', '>', '<=', '>=', 'LIKE', 'NOT LIKE', 'IS NULL', 'IS NOT NULL', 'IN', 'NOT IN'];
        ops.forEach(op => {
            const opt = document.createElement('option');
            opt.value = op;
            opt.textContent = op;
            if (cond.op === op) opt.selected = true;
            opSel.appendChild(opt);
        });
        opSel.addEventListener('change', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            State.having[idx].op = opSel.value;
            _refreshHaving(); // re-render to hide/show val input
            App.updateSQLPreview();
        });
        row.appendChild(opSel);

        // Value input
        if (cond.op !== 'IS NULL' && cond.op !== 'IS NOT NULL') {
            const valInp = document.createElement('input');
            valInp.type = 'text';
            valInp.value = cond.val ?? '';
            valInp.placeholder = (cond.op === 'IN' || cond.op === 'NOT IN') ? 'val1, val2, …' : 'value…';
            valInp.addEventListener('focus', () => { if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot(); });
            valInp.addEventListener('input', () => {
                State.having[idx].val = valInp.value;
                App.updateSQLPreview();
            });
            _bindExprPopupTrigger(
                valInp,
                () => `EDIT HAVING VALUE — ${cond.col}`,
                () => valInp.value,
                val => { valInp.value = val; State.having[idx].val = val; App.updateSQLPreview(); }
            );
            row.appendChild(valInp);
        }

        const rmBtn = document.createElement('button');
        rmBtn.className = 'btn-remove';
        rmBtn.textContent = '✕';
        rmBtn.title = 'Remove condition';
        rmBtn.addEventListener('click', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            State.having.splice(idx, 1);
            _refreshHaving();
            App.updateSQLPreview();
        });
        row.appendChild(rmBtn);

        return row;
    }

    // =========================================================================
    // ORDER BY section
    // =========================================================================
    function _refreshOrderBy() {
        const container = document.getElementById('orderby-columns');
        container.innerHTML = '';

        State.orderBy.forEach((item, idx) => {
            const row = _buildOrderRow(item, idx);
            container.appendChild(row);
        });

        if (State.orderByMode === 'raw') {
            document.getElementById('orderby-raw-input').value = State.orderByRaw ?? '';
        }
    }

    function _buildOrderRow(item, idx) {
        const row = document.createElement('div');
        row.className = 'condition-row';

        const colSpan = document.createElement('span');
        colSpan.className = 'col-name';
        colSpan.textContent = item.col;
        colSpan.title = item.col;
        colSpan.addEventListener('contextmenu', e => {
            e.preventDefault();
            e.stopPropagation();
            if (item.col.includes('.')) {
                const [alias, colName] = item.col.split('.');
                Canvas.focusColumn(alias, colName);
            }
        });
        row.appendChild(colSpan);

        // ASC / DESC toggle
        const dirBtn = document.createElement('button');
        dirBtn.className   = 'btn-dir';
        dirBtn.textContent = item.dir ?? 'ASC';
        dirBtn.title = 'Toggle sort direction';
        dirBtn.addEventListener('click', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            State.orderBy[idx].dir = State.orderBy[idx].dir === 'ASC' ? 'DESC' : 'ASC';
            dirBtn.textContent = State.orderBy[idx].dir;
            App.updateSQLPreview();
        });
        row.appendChild(dirBtn);

        const rmBtn = document.createElement('button');
        rmBtn.className = 'btn-remove';
        rmBtn.textContent = '✕';
        rmBtn.title = 'Remove sort column';
        rmBtn.addEventListener('click', () => {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            State.orderBy.splice(idx, 1);
            _refreshOrderBy();
            App.updateSQLPreview();
        });
        row.appendChild(rmBtn);

        return row;
    }

    // =========================================================================
    // Mode toggle (Visual ↔ Raw) for WHERE and ORDER BY
    // =========================================================================
    function _toggleMode(section) {
        if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
        const key = section === 'select'  ? 'selectMode'
                  : section === 'where'   ? 'whereMode'
                  : section === 'groupby' ? 'groupByMode'
                  : section === 'having'  ? 'havingMode'
                  :                         'orderByMode';
        State[key] = State[key] === 'visual' ? 'raw' : 'visual';
        _applyModeUI(section);
        App.updateSQLPreview();
    }

    function _setRawTextarea(id, text) {
        const ta = document.getElementById(id);
        if (!ta) return;
        ta.value = text;
        if (typeof SqlBackdrop !== 'undefined') SqlBackdrop.refresh(ta);
    }

    function _applyModeUI(section) {
        const mode  = section === 'select'  ? State.selectMode
                    : section === 'where'   ? State.whereMode
                    : section === 'groupby' ? State.groupByMode
                    : section === 'having'  ? State.havingMode
                    :                         State.orderByMode;
        const isRaw = mode === 'raw';
        const btn   = document.querySelector(`.btn-toggle-mode[data-section="${section}"]`);
        if (btn) {
            btn.textContent = isRaw ? 'Raw' : 'Visual';
            btn.classList.toggle('active', isRaw);
        }

        // Reset html toggle when leaving raw mode so state is clean on re-entry
        if (!isRaw) {
            const chk = document.getElementById(`chk-${section}-raw-html`);
            if (chk?.checked) {
                chk.checked = false;
                document.getElementById(`${section}-raw-highlighted`)?.classList.add('hidden');
                document.getElementById(`${section}-raw-input`)?.classList.remove('hidden');
            }
        }

        if (section === 'select') {
            document.getElementById('btn-select-to-raw').classList.toggle('hidden', isRaw);
            document.getElementById('select-columns').classList.toggle('hidden', isRaw);
            document.querySelector('#section-select .config-empty')?.classList.toggle('hidden', isRaw);
            document.getElementById('select-raw')   .classList.toggle('hidden', !isRaw);
            document.getElementById('select-schema-alias-toggle').closest('label').classList.toggle('hidden', isRaw);
            document.getElementById('select-delimiter-toggle').closest('label').classList.toggle('hidden', isRaw);
            document.getElementById('select-distinct-toggle').closest('label').classList.toggle('hidden', isRaw);
            if (isRaw) _setRawTextarea('select-raw-input',  State.selectRaw  ?? '');
        } else if (section === 'where') {
            document.getElementById('btn-where-to-raw')   .classList.toggle('hidden', isRaw);
            document.getElementById('where-drop-zone')    .classList.toggle('hidden', isRaw);
            document.getElementById('where-conditions')   .classList.toggle('hidden', isRaw);
            document.getElementById('where-raw')          .classList.toggle('hidden', !isRaw);
            document.getElementById('btn-where-from-json').classList.toggle('hidden', !isRaw);
            if (isRaw) _setRawTextarea('where-raw-input',   State.whereRaw   ?? '');
        } else if (section === 'groupby') {
            document.getElementById('btn-groupby-to-raw').classList.toggle('hidden', isRaw);
            document.getElementById('groupby-drop-zone') .classList.toggle('hidden', isRaw);
            document.getElementById('groupby-columns')   .classList.toggle('hidden', isRaw);
            document.getElementById('groupby-raw')       .classList.toggle('hidden', !isRaw);
            if (isRaw) _setRawTextarea('groupby-raw-input', State.groupByRaw ?? '');
        } else if (section === 'having') {
            document.getElementById('btn-having-to-raw').classList.toggle('hidden', isRaw);
            document.getElementById('having-drop-zone') .classList.toggle('hidden', isRaw);
            document.getElementById('having-conditions').classList.toggle('hidden', isRaw);
            document.getElementById('having-raw')       .classList.toggle('hidden', !isRaw);
            if (isRaw) _setRawTextarea('having-raw-input',  State.havingRaw  ?? '');
        } else {
            document.getElementById('btn-orderby-to-raw').classList.toggle('hidden', isRaw);
            document.getElementById('orderby-drop-zone') .classList.toggle('hidden', isRaw);
            document.getElementById('orderby-columns')   .classList.toggle('hidden', isRaw);
            document.getElementById('orderby-raw')        .classList.toggle('hidden', !isRaw);
            if (isRaw) _setRawTextarea('orderby-raw-input', State.orderByRaw ?? '');
        }
    }

    // =========================================================================
    // Column drag dropped onto a config-panel drop zone
    // Called by joins.js _onDragEnd (canvas drag) and the HTML5 drop listeners
    // wired in init() (results-table drag).
    // =========================================================================

    /**
     * Core drop handler — expects a pre-formed colKey ("alias.col").
     * cellValue is optionally pre-filled into WHERE / HAVING val fields.
     */
    function _dropColKey(zone, colKey, cellValue) {
        switch (zone.dataset.section) {
            case 'where':
                if (State.whereMode === 'visual') {
                    if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                    State.where.push({ col: colKey, op: '=', val: cellValue ?? '', operator: 'AND' });
                    _refreshWhere();
                    App.updateSQLPreview();
                }
                break;
            case 'groupby':
                if (State.groupByMode === 'visual') {
                    if (!State.groupBy.includes(colKey)) {
                        if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                        State.groupBy.push(colKey);
                        _refreshGroupBy();
                        App.updateSQLPreview();
                    }
                }
                break;
            case 'having':
                if (State.havingMode === 'visual') {
                    if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                    State.having.push({ col: colKey, op: '=', val: cellValue ?? '' });
                    _refreshHaving();
                    App.updateSQLPreview();
                }
                break;
            case 'orderby':
                if (State.orderByMode === 'visual') {
                    if (!State.orderBy.find(o => o.col === colKey)) {
                        if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                        State.orderBy.push({ col: colKey, dir: 'ASC' });
                        _refreshOrderBy();
                        App.updateSQLPreview();
                    }
                }
                break;
        }
    }

    /** Called by joins.js when a canvas column is dropped onto a drop zone. */
    function onColumnDrop(zone, tableId, colName) {
        const table = State.tables.find(t => t.id === tableId);
        if (!table) return;
        _dropColKey(zone, `${table.alias}.${colName}`);
    }

    /** Generates the SELECT clause part from State.select */
    function _copySelectVisualToRaw() {
        if (State.tables.length === 0) {
            App.notify?.('No tables on canvas.', 'warn');
            return;
        }
        if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();

        const useDelimiter = State.selectAddDelimiter;
        const useSortAlpha = State.selectSortAlpha ?? false;
        const _alphaSortedCopy = cols => {
            const aliases = State.selectAliases || {};
            const keyFor  = k => {
                const alias = (aliases[k] || '').trim();
                if (alias) return alias.toLowerCase();
                return (String(k).includes('.') ? String(k).split('.')[1] : String(k)).toLowerCase();
            };
            return [...cols].sort((a, b) => keyFor(a).localeCompare(keyFor(b)));
        };

        let rawText = '*';
        if (State.selectNone) {
            rawText = '';
        } else if (State.select.length > 0) {
            const cols = useSortAlpha ? _alphaSortedCopy(State.select) : State.select;
            rawText = useDelimiter
                ? (useSortAlpha ? _injectDelimitersByGroup(cols) : _injectDelimiters(cols))
                : cols.map(_colWithAlias).join(', ');
        } else if (State.columnOrder && State.columnOrder.length > 0) {
            const defaultOrder = _allColumns();
            const isDefault = State.columnOrder.length === defaultOrder.length &&
                              State.columnOrder.every((v, i) => v === defaultOrder[i]);

            const hasAliases = State.columnOrder.some(k => (State.selectAliases || {})[k]);
            if (useDelimiter || useSortAlpha) {
                if (useDelimiter && State.tables.some(t => t.isSubquery)) {
                    const tables = [...State.tables].sort((a, b) => (a.order ?? 1) - (b.order ?? 1));
                    rawText = tables.reduce((acc, t, i) => acc + (i > 0 ? ", '|||', " : '') + `${t.alias}.*`, '');
                } else {
                    const cols = useSortAlpha ? _alphaSortedCopy(State.columnOrder) : State.columnOrder;
                    rawText = useDelimiter
                        ? (useSortAlpha ? _injectDelimitersByGroup(cols) : _injectDelimiters(cols))
                        : cols.map(_colWithAlias).join(', ');
                }
            } else if (!isDefault || hasAliases) {
                rawText = State.columnOrder.map(_colWithAlias).join(', ');
            }
        } else if (useDelimiter || useSortAlpha) {
            if (useDelimiter && State.tables.some(t => t.isSubquery)) {
                const tables = [...State.tables].sort((a, b) => (a.order ?? 1) - (b.order ?? 1));
                rawText = tables.reduce((acc, t, i) => acc + (i > 0 ? ", '|||', " : '') + `${t.alias}.*`, '');
            } else {
                const allCols = _allColumns();
                if (allCols.length > 0) {
                    const cols = useSortAlpha ? _alphaSortedCopy(allCols) : allCols;
                    rawText = useDelimiter
                        ? (useSortAlpha ? _injectDelimitersByGroup(cols) : _injectDelimiters(cols))
                        : cols.map(_colWithAlias).join(', ');
                }
            }
        }

        // Append custom expressions
        let customParts = (State.selectCustomExprs ?? [])
            .filter(e => e.enabled !== false && e.expr?.trim())
            .map(e => {
                let ex = e.expr.trim();
                if (/^select\s/i.test(ex)) ex = `(${ex})`;
                const text = e.alias?.trim() ? `${ex} AS ${e.alias.trim()}` : ex;
                return { text, key: (e.alias?.trim() || ex).toLowerCase() };
            });
        if (useSortAlpha && customParts.length > 0) {
            customParts.sort((a, b) => a.key.localeCompare(b.key));
        }
        const customTexts = customParts.map(p => p.text);
        if (customTexts.length > 0) {
            rawText = (rawText && rawText !== '') ? rawText + ', ' + customTexts.join(', ') : customTexts.join(', ');
        }

        State.selectRaw = rawText;
        const _selTa = document.getElementById('select-raw-input');
        _selTa.value = rawText;
        if (typeof SqlBackdrop !== 'undefined') SqlBackdrop.refresh(_selTa);

        App.notify?.('SELECT columns copied to Raw mode.', 'success');

        // Toggle the view to Raw mode
        _toggleMode('select');
    }

    /** Generates the WHERE clause part (without the WHERE keyword) from State.where */
    function _copyWhereVisualToRaw() {
        if (!State.where || State.where.length === 0) {
            App.notify?.('No WHERE filters to copy.', 'warn');
            return;
        }
        if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();

        const parts = [];
        State.where.forEach((c, idx) => {
            if (c.enabled === false) return;
            let part = '';
            if (c.type === 'raw') {
                const expr = (c.expr ?? '').trim();
                if (!expr) return;
                part = /^select\s/i.test(expr) ? `(${expr})` : expr;
            } else if (c.op === 'IS NULL')          { part = `${c.col} IS NULL`; }
            else if (c.op === 'IS NOT NULL') { part = `${c.col} IS NOT NULL`; }
            else if (c.op === 'IN' || c.op === 'NOT IN') {
                const vals = String(c.val ?? '').split(',').map(v => v.trim()).filter(v => v !== '');
                part = `${c.col} ${c.op} (${vals.join(', ')})`;
            } else if (c.op === 'BETWEEN' || c.op === 'NOT BETWEEN') {
                part = `${c.col} ${c.op} ${String(c.val ?? '')} AND ${String(c.val2 ?? '')}`;
            } else {
                const v = String(c.val ?? '');
                part = `${c.col} ${c.op} ${v}`;
            }

            if (c.startGroup) part = '(' + part;
            if (c.endGroup)   part = part + ')';

            if (parts.length === 0) {
                parts.push(part);
            } else {
                const op = c.operator || 'AND';
                parts.push(`    ${op} ${part}`);
            }
        });

        const rawText = parts.join('\n');
        State.whereRaw = rawText;
        const _whereTa = document.getElementById('where-raw-input');
        _whereTa.value = rawText;
        if (typeof SqlBackdrop !== 'undefined') SqlBackdrop.refresh(_whereTa);

        App.notify?.('WHERE filters copied to Raw mode.', 'success');

        // Toggle the view to Raw mode
        _toggleMode('where');
    }

    function _copyGroupByVisualToRaw() {
        if (!State.groupBy || State.groupBy.length === 0) {
            App.notify?.('No GROUP BY columns to copy.', 'warn');
            return;
        }
        if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
        const rawText = State.groupBy.join(', ');
        State.groupByRaw = rawText;
        const _gbTa = document.getElementById('groupby-raw-input');
        _gbTa.value = rawText;
        if (typeof SqlBackdrop !== 'undefined') SqlBackdrop.refresh(_gbTa);
        App.notify?.('GROUP BY columns copied to Raw mode.', 'success');
        _toggleMode('groupby');
    }

    function _copyHavingVisualToRaw() {
        if (!State.having || State.having.length === 0) {
            App.notify?.('No HAVING conditions to copy.', 'warn');
            return;
        }
        if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
        const parts = [];
        State.having.forEach(c => {
            let part = '';
            if (c.op === 'IS NULL')        { part = `${c.col} IS NULL`; }
            else if (c.op === 'IS NOT NULL') { part = `${c.col} IS NOT NULL`; }
            else if (c.op === 'IN' || c.op === 'NOT IN') {
                const vals = String(c.val ?? '').split(',').map(v => v.trim()).filter(v => v !== '');
                part = `${c.col} ${c.op} (${vals.join(', ')})`;
            } else {
                part = `${c.col} ${c.op} ${String(c.val ?? '')}`;
            }
            if (parts.length === 0) {
                parts.push(part);
            } else {
                parts.push(`    AND ${part}`);
            }
        });
        const rawText = parts.join('\n');
        State.havingRaw = rawText;
        const _havTa = document.getElementById('having-raw-input');
        _havTa.value = rawText;
        if (typeof SqlBackdrop !== 'undefined') SqlBackdrop.refresh(_havTa);
        App.notify?.('HAVING conditions copied to Raw mode.', 'success');
        _toggleMode('having');
    }

    function _copyOrderByVisualToRaw() {
        if (!State.orderBy || State.orderBy.length === 0) {
            App.notify?.('No ORDER BY columns to copy.', 'warn');
            return;
        }
        if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
        const rawText = State.orderBy.map(o => `${o.col} ${o.dir}`).join(', ');
        State.orderByRaw = rawText;
        const _obTa = document.getElementById('orderby-raw-input');
        _obTa.value = rawText;
        if (typeof SqlBackdrop !== 'undefined') SqlBackdrop.refresh(_obTa);
        App.notify?.('ORDER BY columns copied to Raw mode.', 'success');
        _toggleMode('orderby');
    }

    /**
     * Parse a JSON object pasted by the user and convert it to a formatted
     * WHERE clause, then write it into the raw WHERE textarea.
     * Format mirrors _copyWhereVisualToRaw: first condition unindented,
     * subsequent ones indented with "    AND ".
     * Numeric-looking values are left bare; all others are single-quoted.
     */
    function _applyWhereFromJson(jsonStr, operator = 'AND') {
        if (!jsonStr) { App.notify?.('Nothing to parse — textarea is empty', 'warn'); return; }

        let obj;
        try { obj = JSON.parse(jsonStr); }
        catch { App.notify?.('Invalid JSON — could not parse input', 'error'); return; }

        if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
            App.notify?.('Input must be a plain JSON object { key: value, … }', 'error');
            return;
        }

        const entries = Object.entries(obj);
        if (!entries.length) { App.notify?.('JSON object has no entries', 'warn'); return; }

        const parts = entries.map(([key, raw], i) => {
            const str       = raw === null ? 'NULL' : String(raw);
            const isNumeric = raw !== null && raw !== '' && !isNaN(Number(raw));
            const isNull    = raw === null;
            const sqlVal    = isNull    ? 'NULL'
                            : isNumeric ? str
                            : `'${str.replace(/'/g, "''")}'`;
            const condition = `${key} = ${sqlVal}`;
            return i === 0 ? condition : `    ${operator} ${condition}`;
        });

        if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();

        const rawText = parts.join('\n');
        State.whereRaw = rawText;
        const ta = document.getElementById('where-raw-input');
        ta.value = rawText;
        ta.dispatchEvent(new Event('input')); // refresh SqlBackdrop

        App.updateSQLPreview?.();
        App.notify?.('WHERE clause built from JSON', 'success');

        document.getElementById('modal-where-from-json').classList.add('hidden');
        document.getElementById('where-raw-input').focus();
    }

    // =========================================================================
    // SELECT sort helpers (used by buildSQL and _copySelectVisualToRaw)
    // =========================================================================

    /**
     * Split a raw SELECT list by top-level commas, skipping commas inside
     * parentheses so expressions like CONCAT(a, b) are kept intact.
     */
    function _splitSelectExprs(raw) {
        const parts = [];
        let depth = 0;
        let cur   = '';
        for (const ch of raw) {
            if      (ch === '(' || ch === '[') { depth++; cur += ch; }
            else if (ch === ')' || ch === ']') { depth--; cur += ch; }
            else if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
            else cur += ch;
        }
        if (cur.trim()) parts.push(cur);
        return parts;
    }

    /**
     * Extract a sort key from a single SQL SELECT expression.
     * Priority: AS alias → dotted column name → first bare word.
     */
    function _exprSortKey(expr) {
        const t = expr.trim();
        const asMatch = t.match(/\bAS\s+`?(\w+)`?\s*$/i);
        if (asMatch) return asMatch[1].toLowerCase();
        const dotMatch = t.match(/\w+\.`?(\w+)`?/);
        if (dotMatch) return dotMatch[1].toLowerCase();
        const wordMatch = t.replace(/`/g, '').match(/^\s*(\w+)/);
        return wordMatch ? wordMatch[1].toLowerCase() : t.toLowerCase();
    }

    /**
     * Sort the SELECT column list inside an arbitrary SQL string alphabetically.
     * Handles strings and nested parentheses to locate the top-level FROM keyword.
     * Returns the SQL unchanged if no SELECT prefix is found.
     */
    function _sortSelectInSQL(sql) {
        const trimmed = sql.trimStart();
        const prefixMatch = trimmed.match(/^(SELECT\s+(?:DISTINCT\s+|ALL\s+)?)/i);
        if (!prefixMatch) return sql;

        // How many leading spaces were stripped
        const lead      = sql.length - trimmed.length;
        const prefixLen = lead + prefixMatch[1].length;
        const after     = sql.substring(prefixLen); // everything after "SELECT [DISTINCT] "

        // Scan for the top-level FROM keyword, respecting strings and parentheses
        let depth = 0, inStr = false, strChar = '', i = 0;
        let fromIdx = -1;

        while (i < after.length) {
            const ch = after[i];
            if (inStr) {
                if (ch === strChar) inStr = false;
                i++; continue;
            }
            if (ch === "'" || ch === '"' || ch === '`') {
                inStr = true; strChar = ch; i++; continue;
            }
            if (ch === '(') { depth++; i++; continue; }
            if (ch === ')') { depth--; i++; continue; }

            if (depth === 0 && after.slice(i, i + 4).toUpperCase() === 'FROM') {
                const before = i === 0 ? ' ' : after[i - 1];
                const next   = after[i + 4] ?? ' ';
                if (/\s/.test(before) && /[\s(]/.test(next)) {
                    fromIdx = i;
                    break;
                }
            }
            i++;
        }

        const colsPart = fromIdx === -1 ? after         : after.substring(0, fromIdx);
        const tail     = fromIdx === -1 ? ''             : after.substring(fromIdx);

        const sorted = _splitSelectExprs(colsPart)
            .sort((a, b) => _exprSortKey(a).localeCompare(_exprSortKey(b)))
            .map(s => s.trim())
            .join(', ');

        return sql.substring(0, prefixLen) + sorted + (tail ? ' ' + tail.trimStart() : '');
    }

    // =========================================================================
    // Client-side SQL preview builder
    // Produces a human-readable SELECT statement from State.
    // The server (Phase 6) will generate the authoritative query.
    // =========================================================================
    function buildSQL(state) {
        if (!state.tables.length) return '-- Add tables to the canvas to begin';

        const tMap = {};
        state.tables.forEach(t => (tMap[t.id] = t));

        // --- SELECT ---
        const useDelimiter  = state.selectAddDelimiter && state.selectMode !== 'raw';
        const useSortAlpha  = state.selectSortAlpha ?? false;
        const useSortVisual = useSortAlpha && state.selectMode !== 'raw';

        /**
         * Sort a column-key array by alias (if set) or column name (part after '.'),
         * leaving UI order intact.
         */
        const _alphaSorted = cols => {
            const aliases = state.selectAliases || {};
            const keyFor  = k => {
                const alias = (aliases[k] || '').trim();
                if (alias) return alias.toLowerCase();
                return (String(k).includes('.') ? String(k).split('.')[1] : String(k)).toLowerCase();
            };
            return [...cols].sort((a, b) => keyFor(a).localeCompare(keyFor(b)));
        };

        // Compute the active island's tables / columns upfront so the SELECT clause
        // never leaks columns from other islands (e.g. same table name, different alias).
        // This mirrors the island detection done later for the FROM clause, but we need
        // it here before selectPart is built.
        const _preEnabledJoins = state.joins.filter(j => j.enabled !== false);
        const _preIslands      = typeof App !== 'undefined'
            ? App.computeIslands(state.tables, _preEnabledJoins)
            : [state.tables.map(t => t.id)];
        let _preActiveIds;
        if (_preIslands.length > 1 && state.selectedIslandKey) {
            _preActiveIds = new Set(state.selectedIslandKey.split('|'));
        } else {
            _preActiveIds = new Set(_preIslands.length === 1 ? _preIslands[0] : state.tables.map(t => t.id));
        }
        const _preActiveAliases = new Set(state.tables.filter(t => _preActiveIds.has(t.id)).map(t => t.alias));
        const _activeColOrder   = (state.columnOrder || []).filter(k => _preActiveAliases.has(k.split('.')[0]));
        const _activeAllCols    = () => {
            const out = [];
            state.tables.filter(t => _preActiveIds.has(t.id))
                .forEach(t => (t.columns ?? []).forEach(c => out.push(`${t.alias}.${c.name}`)));
            return out;
        };

        // Subquery tables (joined islands) only expose join-key columns in their metadata.
        // When delimiter is on and no explicit columns are chosen, use alias.* per table.
        const _hasSubqueryTables = () => state.tables.some(t => _preActiveIds.has(t.id) && t.isSubquery);
        const _delimStarSelect   = () => {
            const tables = state.tables.filter(t => _preActiveIds.has(t.id))
                .sort((a, b) => (a.order ?? 1) - (b.order ?? 1));
            const parts = [];
            tables.forEach((t, i) => {
                if (i > 0) parts.push("'|||'");
                parts.push(`${t.alias}.*`);
            });
            return parts.join(', ');
        };

        let selectPart = '*';
        if (state.selectNone && state.selectMode !== 'raw') {
            selectPart = '/* no columns selected */';
        } else if (state.selectMode === 'raw' && state.selectRaw?.trim()) {
            const raw = state.selectRaw.trim();
            selectPart = useSortAlpha
                ? _splitSelectExprs(raw)
                    .sort((a, b) => _exprSortKey(a).localeCompare(_exprSortKey(b)))
                    .map(s => s.trim())
                    .join(', ')
                : raw;
        } else if (state.select.length > 0) {
            const cols = useSortVisual ? _alphaSorted(state.select) : state.select;
            selectPart = useDelimiter
                ? (useSortVisual ? _injectDelimitersByGroup(cols) : _injectDelimiters(cols))
                : cols.map(_colWithAlias).join(', ');
        } else if (_activeColOrder.length > 0) {
            const defaultOrder = _activeAllCols();
            const isDefault = _activeColOrder.length === defaultOrder.length &&
                              _activeColOrder.every((v, i) => v === defaultOrder[i]);

            const hasAliases = _activeColOrder.some(k => (state.selectAliases || {})[k]);
            if (useDelimiter || useSortVisual) {
                if (useDelimiter && _hasSubqueryTables()) {
                    selectPart = _delimStarSelect();
                } else {
                    // Always expand to explicit columns when delimiter or sort-alpha is on —
                    // SELECT * cannot carry ordering or '|||' markers.
                    const cols = useSortVisual ? _alphaSorted(_activeColOrder) : _activeColOrder;
                    selectPart = useDelimiter
                        ? (useSortVisual ? _injectDelimitersByGroup(cols) : _injectDelimiters(cols))
                        : cols.map(_colWithAlias).join(', ');
                }
            } else if (!isDefault || hasAliases) {
                selectPart = _activeColOrder.map(_colWithAlias).join(', ');
            } else {
                selectPart = '*';
            }
        } else if (useDelimiter || useSortVisual) {
            // columnOrder not yet populated; derive from active island tables
            if (useDelimiter && _hasSubqueryTables()) {
                selectPart = _delimStarSelect();
            } else {
                const allCols = _activeAllCols();
                if (allCols.length > 0) {
                    const cols = useSortVisual ? _alphaSorted(allCols) : allCols;
                    selectPart = useDelimiter
                        ? (useSortVisual ? _injectDelimitersByGroup(cols) : _injectDelimiters(cols))
                        : cols.map(_colWithAlias).join(', ');
                }
            }
        }

        // In 'only' mode: custom expressions replace all SELECT columns
        const exprMode = state.selectCustomExprsMode ?? 'exclude';
        if (exprMode === 'only' && state.selectMode !== 'raw') {
            selectPart = '/* no columns selected */';
        }

        // Append enabled custom expressions (visual mode only; skipped in 'exclude' mode)
        if (state.selectMode !== 'raw' && exprMode !== 'exclude') {
            let customParts = (state.selectCustomExprs ?? [])
                .filter(e => e.enabled !== false && e.expr?.trim())
                .map(e => {
                    let ex = e.expr.trim();
                    if (/^select\s/i.test(ex)) ex = `(${ex})`;
                    const text = e.alias?.trim() ? `${ex} AS ${e.alias.trim()}` : ex;
                    return { text, key: (e.alias?.trim() || ex).toLowerCase() };
                });
            if (useSortAlpha && customParts.length > 0) {
                customParts.sort((a, b) => a.key.localeCompare(b.key));
            }
            const customTexts = customParts.map(p => p.text);
            if (customTexts.length > 0) {
                selectPart = (selectPart === '/* no columns selected */')
                    ? customTexts.join(', ')
                    : selectPart + ', ' + customTexts.join(', ');
            }
        }

        // --- FROM + JOINs ---
        // Helper: produce `db`.`table` for normal tables, or (subquery SQL) for subquery tables
        const tableRef = t => t.isSubquery && t.subquery?.trim()
            ? `(${t.subquery.trim()})`
            : t.database
                ? `\`${t.database}\`.\`${t.name}\``
                : t.name;

        // Strip disabled joins — excluded from SQL and connectivity
        const enabledJoins = state.joins.filter(j => j.enabled !== false);

        // Compute islands and resolve active table set
        const _islands = typeof App !== 'undefined'
            ? App.computeIslands(state.tables, enabledJoins)
            : [state.tables.map(t => t.id)];

        let activeTables = state.tables;
        let activeJoins  = enabledJoins;

        if (_islands.length > 1) {
            const selected = state.selectedIslandKey ?? null;
            if (selected) {
                const selIds = new Set(selected.split('|'));
                activeTables = state.tables.filter(t => selIds.has(t.id));
                activeJoins  = enabledJoins.filter(j => selIds.has(j.fromTableId) && selIds.has(j.toTableId));
            } else {
                return '-- Multiple disconnected table groups found.\n-- Select one group to query.';
            }
        } else if (_islands.length === 1) {
            const ids    = new Set(_islands[0]);
            activeTables = state.tables.filter(t => ids.has(t.id));
            activeJoins  = enabledJoins.filter(j => ids.has(j.fromTableId) && ids.has(j.toTableId));
        }

        if (!activeTables.length) return '-- Add tables to the canvas to begin';

        // Rebuild tMap for the active table set
        activeTables.forEach(t => (tMap[t.id] = t));

        // Sort tables by user-defined join order (1 = FROM, 2+ = JOIN sequence)
        const orderedTables = [...activeTables].sort((a, b) => (a.order ?? 1) - (b.order ?? 1));

        // Sort joins so tables with lower order values are introduced into the
        // chain first, matching the user's intended join sequence
        const sortedJoins = [...activeJoins].sort((a, b) => {
            const minA = Math.min(tMap[a.fromTableId]?.order ?? 99, tMap[a.toTableId]?.order ?? 99);
            const minB = Math.min(tMap[b.fromTableId]?.order ?? 99, tMap[b.toTableId]?.order ?? 99);
            return minA - minB;
        });

        const first = orderedTables[0];
        const chain = new Set([first.id]);
        const _selectKw = (state.selectDistinct ?? false) ? 'SELECT DISTINCT' : 'SELECT';
        const _selParts = _splitSelectExprs(selectPart).map(s => s.trim());
        const _fmtSel   = _selParts.length <= 1
            ? `${_selectKw}\n\t${selectPart}`
            : `${_selectKw}\n\t${_selParts.join(',\n\t')}`;
        let sql = `${_fmtSel}\nFROM\n\t${tableRef(first)} ${first.alias}`;

        sortedJoins.forEach(j => {
            const fromT = tMap[j.fromTableId];
            const toT   = tMap[j.toTableId];
            if (!fromT || !toT) return;

            const kw = { INNER: 'INNER JOIN', LEFT: 'LEFT JOIN', RIGHT: 'RIGHT JOIN',
                         FULL: 'FULL OUTER JOIN', CROSS: 'CROSS JOIN' }[j.type] ?? 'JOIN';

            // Which table is the "new" one to add to the chain?
            let joinT, onL, onR;
            if (!chain.has(j.toTableId)) {
                joinT = toT;   onL = `${fromT.alias}.${j.fromCol}`; onR = `${toT.alias}.${j.toCol}`;
                chain.add(j.toTableId);
            } else if (!chain.has(j.fromTableId)) {
                joinT = fromT; onL = `${toT.alias}.${j.toCol}`;   onR = `${fromT.alias}.${j.fromCol}`;
                chain.add(j.fromTableId);
            } else {
                // Both already in chain — additional ON condition between them
                joinT = toT;   onL = `${fromT.alias}.${j.fromCol}`; onR = `${toT.alias}.${j.toCol}`;
            }
            sql += `\n${kw} ${tableRef(joinT)} ${joinT.alias} ON ${onL} = ${onR}`;
        });


        // --- WHERE ---
        if (state.whereMode === 'raw' && state.whereRaw?.trim()) {
            sql += `\nWHERE\n\t${state.whereRaw.trim()}`;
        } else if (state.where?.length) {
            let whereSql = '';
            let firstPart = true;
            state.where.forEach((c, idx) => {
                if (c.enabled === false) return;
                let part = '';
                if (c.type === 'raw') {
                    const expr = (c.expr ?? '').trim();
                    if (!expr) return;
                    part = /^select\s/i.test(expr) ? `(${expr})` : expr;
                } else if (c.op === 'IS NULL')     { part = `${c.col} IS NULL`; }
                else if (c.op === 'IS NOT NULL')   { part = `${c.col} IS NOT NULL`; }
                else if (c.op === 'IN' || c.op === 'NOT IN') {
                    const vals = String(c.val ?? '').split(',').map(v => v.trim()).filter(v => v !== '');
                    part = `${c.col} ${c.op} (${vals.join(', ')})`;
                } else if (c.op === 'BETWEEN' || c.op === 'NOT BETWEEN') {
                    part = `${c.col} ${c.op} ${String(c.val ?? '')} AND ${String(c.val2 ?? '')}`;
                } else {
                    const v = String(c.val ?? '');
                    part = `${c.col} ${c.op} ${v}`;
                }

                if (c.startGroup) part = '(' + part;
                if (c.endGroup)   part = part + ')';

                if (firstPart) {
                    whereSql += `\nWHERE\n\t    ${part}`;
                    firstPart = false;
                } else {
                    const op = c.operator || 'AND';
                    whereSql += `\n\t${op} ${part}`;
                }
            });
            sql += whereSql;
        }

        // --- GROUP BY ---
        if (state.groupByMode === 'raw' && state.groupByRaw?.trim()) {
            sql += `\nGROUP BY ${state.groupByRaw.trim()}`;
        } else if (state.groupBy?.length) {
            sql += `\nGROUP BY ${state.groupBy.join(', ')}`;
        }

        // --- HAVING ---
        if (state.havingMode === 'raw' && state.havingRaw?.trim()) {
            sql += `\nHAVING\n\t${state.havingRaw.trim()}`;
        } else if (state.having?.length) {
            const parts = state.having.map(c => {
                if (c.op === 'IS NULL')     return `${c.col} IS NULL`;
                if (c.op === 'IS NOT NULL') return `${c.col} IS NOT NULL`;
                if (c.op === 'IN' || c.op === 'NOT IN') {
                    const list = String(c.val ?? '').split(',').map(v => v.trim()).join(', ');
                    return `${c.col} ${c.op} (${list})`;
                }
                return `${c.col} ${c.op} ${String(c.val ?? '')}`;
            });
            sql += `\nHAVING\n\t    ${parts.join('\n\tAND ')}`;
        }

        // --- ORDER BY ---
        if (state.orderByMode === 'raw' && state.orderByRaw?.trim()) {
            sql += `\nORDER BY ${state.orderByRaw.trim()}`;
        } else if (state.orderBy?.length) {
            sql += `\nORDER BY ${state.orderBy.map(o => `${o.col} ${o.dir}`).join(', ')}`;
        }

        // --- LIMIT ---
        sql += `\nLIMIT ${state.limit}`;

        return sql;
    }

    // =========================================================================
    // Private helpers
    // =========================================================================
    function _esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // =========================================================================
    // Note popup — for canvas table descriptions
    // Right-click / double-click on a note input opens the expr popup in
    // "note mode": textarea editor, no Run/Explain buttons.
    // Shift+Enter calls onShiftEnter (e.g. save loaded context) without closing.
    // onClose is called when the popup closes normally (X, ESC, click-outside).
    // =========================================================================
    function bindNotePopup(input, getTitle, getValue, onUpdate, onClose, onShiftEnter) {
        input.dataset.exprTrigger = '1'; // prevent the click-outside handler from closing on the input itself
        const _open = () => _openExprPopup(
            getValue, onUpdate, getTitle(), false, onClose,
            { hideActions: true, onShiftEnter }
        );
        input.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); _open(); });
        input.addEventListener('dblclick',    e => { if (!e.altKey) return; e.stopPropagation(); _open(); });
        input.addEventListener('keydown', e => {
            if (e.altKey && e.code === 'KeyE') { e.preventDefault(); e.stopPropagation(); _open(); }
        });
    }

    // =========================================================================
    // Public surface
    // =========================================================================
    return {
        init,
        refresh,
        buildSQL,
        onColumnDrop,
        sortSelectInSQL: _sortSelectInSQL,
        bindNotePopup,
        getShowCheckedOnly: () => _showCheckedOnly,
        setShowCheckedOnly: (val) => { _showCheckedOnly = !!val; },
        getCheckedOnlySnapshot: () => _checkedOnlySnapshot ? [..._checkedOnlySnapshot] : null,
        setCheckedOnlySnapshot: (arr) => { _checkedOnlySnapshot = arr ? new Set(arr) : null; },
        getAllMinimized: () => _allMinimized,
        setAllMinimized: (val) => {
            _allMinimized = !!val;
            document.getElementById('btn-minimize-all')?.classList.toggle('active', _allMinimized);
            document.querySelectorAll('.btn-select-minimize').forEach(b => {
                const isMinimized = b.textContent.trim() === '▸';
                if (_allMinimized && !isMinimized) b.click();
                if (!_allMinimized && isMinimized) b.click();
            });
        },
    };

})();

document.addEventListener('DOMContentLoaded', () => QueryPanel.init());
