/**
 * Chain Timeline — cross-recording temporal pivot analysis using Recording Groups.
 *
 * When chain mode is active for a Recording Group, clicking a mapped date cell
 * in any recording sets it as the "pivot".  The module then finds the closest
 * rows (before / same / after) in every other recording in the group and
 * populates a chain preview timeline.  The user can remove individual preview
 * entries before confirming (adds all to main timeline) or discarding.
 */
const Chain = (() => {

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------
    let _activeGroupId  = null;   // Recording Group currently in chain mode
    let _hasPreview     = false;  // preview built, awaiting confirm/discard
    let _previewEntries = [];
    let _idSeq          = 0;

    const PROX_COLORS = {
        pivot:  '#f59e0b',
        before: '#60a5fa',
        same:   '#34d399',
        after:  '#f472b6',
    };

    // -------------------------------------------------------------------------
    // Config helpers — State.chainConfig[groupId] = { mappings: { recId: { colIdx, color } } }
    // -------------------------------------------------------------------------
    function _cfg(groupId) {
        if (!State.chainConfig) State.chainConfig = {};
        if (!State.chainConfig[groupId]) State.chainConfig[groupId] = { mappings: {} };
        return State.chainConfig[groupId];
    }

    function _groupRecs(groupId) {
        return (State.recordings || []).filter(r => r.groupId === groupId && r.results?.cols);
    }

    function _parseTime(v) {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        if (!isNaN(n)) return n;
        const d = Date.parse(String(v));
        return isNaN(d) ? null : d;
    }

    function _isDateCol(cols, rows, idx) {
        const nameLc = (cols[idx] || '').toLowerCase();
        if (/date|time|_at$|_on$|_ts$|timestamp/.test(nameLc)) return true;
        const samples = rows.slice(0, 8).map(r => r[idx])
            .filter(v => v !== null && v !== undefined && v !== '');
        return samples.some(v => {
            const s = String(v);
            if (/^\d+$/.test(s)) return false; // pure integer — not a date string
            return !isNaN(Date.parse(s));
        });
    }

    // -------------------------------------------------------------------------
    // Public predicates
    // -------------------------------------------------------------------------
    function isActive(groupId) {
        if (groupId !== undefined) return _activeGroupId === groupId;
        return _activeGroupId !== null;
    }

    function getActiveGroupId() { return _activeGroupId; }

    // -------------------------------------------------------------------------
    // Column mapping modal
    // -------------------------------------------------------------------------
    async function openColumnMapping(groupId) {
        const recs = _groupRecs(groupId);
        if (recs.length < 2) {
            App.notify?.('Need at least 2 recordings with results in the group.', 'warn');
            return false;
        }

        const cfg   = _cfg(groupId);
        const modal = document.getElementById('modal-chain-mapping');
        if (!modal) return false;

        // Fill group name in title
        const group = (State.recordingGroups || []).find(g => g.id === groupId);
        const titleEl = modal.querySelector('.chain-mapping-title-name');
        if (titleEl) titleEl.textContent = group?.name || 'Group';

        const body = modal.querySelector('.chain-mapping-body');
        body.innerHTML = '';

        recs.forEach(rec => {
            // Ensure a mapping entry exists with a concrete color so it is always
            // written to cfg even when the user never touches the color picker.
            if (!cfg.mappings[rec.id]) cfg.mappings[rec.id] = {};
            if (!cfg.mappings[rec.id].color) cfg.mappings[rec.id].color = PROX_COLORS.same;
            const mapping   = cfg.mappings[rec.id];
            const cols      = rec.results.cols        || [];
            const colTables = rec.results.col_tables  || [];

            // Build "table.col" labels in results data order
            const colLabels = cols.map((col, idx) =>
                (colTables[idx] ? colTables[idx] + '.' : '') + col
            );

            const recRow = document.createElement('div');
            recRow.className = 'chain-mapping-row';

            const nameEl = document.createElement('div');
            nameEl.className   = 'chain-mapping-rec-name';
            nameEl.textContent = rec.name || new Date(rec.timestamp).toLocaleString();
            recRow.appendChild(nameEl);

            const controls = document.createElement('div');
            controls.className = 'chain-mapping-controls';

            // Color picker swatch
            const colorBtn = document.createElement('button');
            colorBtn.className = 'chain-mapping-color-btn';
            colorBtn.title     = 'Entry color for this recording';
            colorBtn.style.background = mapping.color || PROX_COLORS.same;
            colorBtn.addEventListener('click', e => {
                e.stopPropagation();
                const colorProxy = { color: cfg.mappings[rec.id]?.color || PROX_COLORS.same };
                if (typeof Timeline !== 'undefined') {
                    Timeline.openColorPicker(colorBtn, colorProxy, () => {
                        if (!cfg.mappings[rec.id]) cfg.mappings[rec.id] = {};
                        cfg.mappings[rec.id].color = colorProxy.color;
                        colorBtn.style.background  = colorProxy.color || PROX_COLORS.same;
                    });
                }
            });
            const labelInp = document.createElement('input');
            labelInp.type        = 'text';
            labelInp.className   = 'chain-mapping-label-inp';
            labelInp.placeholder = 'label…';
            labelInp.value       = mapping.label || '';
            labelInp.setAttribute('autocomplete', 'off');
            labelInp.addEventListener('input', () => {
                if (!cfg.mappings[rec.id]) cfg.mappings[rec.id] = {};
                cfg.mappings[rec.id].label = labelInp.value;
            });

            const topRow = document.createElement('div');
            topRow.className = 'chain-mapping-controls-top';
            topRow.appendChild(colorBtn);
            topRow.appendChild(labelInp);

            const searchInp = document.createElement('input');
            searchInp.type        = 'text';
            searchInp.className   = 'chain-mapping-col-search';
            searchInp.placeholder = 'filter columns...';
            searchInp.setAttribute('autocomplete', 'off');

            controls.appendChild(topRow);
            controls.appendChild(searchInp);

            recRow.appendChild(controls);

            // Column table — styled like the timeline mini-popup, date/datetime cols only
            const colList = document.createElement('table');
            colList.className = 'tl-peek-table chain-mapping-col-list';

            const dateColIdxs = cols.map((_, idx) => idx)
                .filter(idx => _isDateCol(cols, rec.results.rows || [], idx));

            dateColIdxs.forEach(idx => {
                const tr = document.createElement('tr');
                tr.dataset.label = colLabels[idx]; // used by search filter

                // Radio cell
                const radioCd = document.createElement('td');
                radioCd.className = 'tl-peek-chk-td';
                const radio = document.createElement('input');
                radio.type      = 'radio';
                radio.className = 'tl-peek-chk';
                radio.name      = 'chain-col-' + rec.id;
                radio.value     = String(idx);
                radio.checked   = mapping.colIdx === idx;
                let _wasChecked = false;
                radio.addEventListener('mousedown', () => { _wasChecked = radio.checked; });
                radio.addEventListener('click', () => {
                    if (_wasChecked) {
                        radio.checked = false;
                        if (cfg.mappings[rec.id]) delete cfg.mappings[rec.id].colIdx;
                    } else {
                        if (!cfg.mappings[rec.id]) cfg.mappings[rec.id] = {};
                        cfg.mappings[rec.id].colIdx = idx;
                    }
                    _wasChecked = false;
                });
                radioCd.appendChild(radio);
                tr.appendChild(radioCd);

                // Key cell — column name, colored by live results header alias
                const keyTd = document.createElement('td');
                keyTd.className    = 'tl-peek-key';
                keyTd.textContent  = colLabels[idx];
                keyTd.style.cursor = 'pointer';
                keyTd.addEventListener('click', () => radio.click());
                const liveTh = document.querySelector(`#results-table thead th[data-col-key="${colLabels[idx]}"]`);
                if (liveTh?.style.backgroundColor) {
                    keyTd.style.background   = liveTh.style.backgroundColor;
                    keyTd.style.color        = liveTh.style.color || '';
                    keyTd.style.borderRadius = '3px';
                    keyTd.style.padding      = '1px 6px';
                }
                tr.appendChild(keyTd);

                colList.appendChild(tr);
            });

            searchInp.addEventListener('input', () => {
                const term = searchInp.value.toLowerCase();
                colList.querySelectorAll('tr').forEach(tr => {
                    const label = tr.dataset.label || '';
                    tr.style.display = (!term || label.toLowerCase().includes(term)) ? '' : 'none';
                });
            });

            recRow.appendChild(colList);
            body.appendChild(recRow);
        });

        modal.classList.remove('hidden');

        return new Promise(resolve => {
            const okBtn      = modal.querySelector('.chain-mapping-ok');
            const cancelBtns = modal.querySelectorAll('.chain-mapping-cancel');

            const done = ok => {
                modal.classList.add('hidden');
                okBtn.onclick = null;
                cancelBtns.forEach(b => { b.onclick = null; });
                modal.removeEventListener('click', onBackdrop);
                resolve(ok);
            };
            const onBackdrop = e => { if (e.target === modal) done(false); };
            modal.addEventListener('click', onBackdrop);
            okBtn.onclick = () => done(true);
            cancelBtns.forEach(b => { b.onclick = () => done(false); });
        });
    }

    // -------------------------------------------------------------------------
    // Toggle chain mode for a Recording Group
    // -------------------------------------------------------------------------
    async function toggle(groupId) {
        // Turn off
        if (_activeGroupId === groupId) {
            if (_hasPreview && !await Dialog.confirm('Discard current chain preview and exit chain mode?')) return;
            if (_hasPreview) _clearPreviewSilent();
            _activeGroupId = null;
            _updateGroupBtn(groupId, false);
            applyHighlight(); // clears column highlights (_activeGroupId is now null)
            App.notify?.('Chain mode off.', 'info');
            return;
        }

        // Switch from another group
        if (_activeGroupId) {
            if (_hasPreview && !await Dialog.confirm('Discard current chain preview and switch groups?')) return;
            if (_hasPreview) _clearPreviewSilent();
            _updateGroupBtn(_activeGroupId, false);
            // highlights will be re-applied for the new group after mapping is confirmed
        }

        // Open column mapping dialog
        const ok = await openColumnMapping(groupId);
        if (!ok) return;

        // Validate: at least 2 recordings have a mapped column (pivot + at least one other)
        const cfg     = _cfg(groupId);
        const recs    = _groupRecs(groupId);
        const mapped  = recs.filter(r => cfg.mappings[r.id]?.colIdx !== undefined);
        if (mapped.length < 2) {
            App.notify?.('Map a date column for at least 2 recordings.', 'warn');
            return;
        }

        _activeGroupId = groupId;
        _updateGroupBtn(groupId, true);
        applyHighlight();
        App.notify?.('Chain mode active — click a mapped date cell in any recording.', 'info');
    }

    function _updateGroupBtn(groupId, active) {
        document.querySelectorAll('.rec-group-header[data-group-id="' + groupId + '"] .rec-group-chain-btn')
            .forEach(btn => btn.classList.toggle('is-active', active));
    }

    // -------------------------------------------------------------------------
    // Cell click handler — returns true if click was consumed (caller should stop)
    // -------------------------------------------------------------------------
    function onCellClick(recId, colIdx, row, cols, colTables) {
        if (!_activeGroupId) return false;

        if (_hasPreview) {
            App.notify?.('Confirm or discard the current chain preview first.', 'warn');
            return true;
        }

        // Verify this recording belongs to the active group
        const recObj = (State.recordings || []).find(r => r.id === recId);
        if (!recObj || recObj.groupId !== _activeGroupId) return false;

        // Verify this is the mapped date column
        const cfg     = _cfg(_activeGroupId);
        const mapping = cfg.mappings[recId];
        if (!mapping || mapping.colIdx !== colIdx) return false;

        const pivotTime = _parseTime(row[colIdx]);
        if (pivotTime === null) {
            App.notify?.('Could not parse a date value from this cell.', 'warn');
            return true;
        }

        // Build pivot entry
        const recName    = recObj.name || new Date(recObj.timestamp).toLocaleString();
        const pivotColor = cfg.mappings[recId]?.color || PROX_COLORS.same;
        const pivotEntry = _makeEntry(
            recId, recName, pivotColor,
            _buildRowData(cols, row), cols[colIdx] || '', row[colIdx] ?? null,
            _buildColAliases(cols, colTables || []), _buildColOrder(cols), 'pivot'
        );
        pivotEntry.label = cfg.mappings[recId]?.label || '';

        // Find proximities in all other recordings in the group
        const proxEntries = [];
        _groupRecs(_activeGroupId).filter(r => r.id !== recId).forEach(rec => {
            const om = cfg.mappings[rec.id];
            if (!om || om.colIdx === undefined) return;

            const oCols = rec.results.cols        || [];
            const oRows = rec.results.rows        || [];
            const oCT   = rec.results.col_tables  || [];
            const oi    = om.colIdx;
            const oName = rec.name || new Date(rec.timestamp).toLocaleString();
            const oColor = om.color || PROX_COLORS.same;

            const sameRows = [];
            let beforeRow = null, beforeTime = -Infinity;
            let afterRow  = null, afterTime  =  Infinity;

            oRows.forEach(r => {
                const t = _parseTime(r[oi]);
                if (t === null) return;
                if (t === pivotTime) {
                    sameRows.push(r);
                } else if (t < pivotTime && t > beforeTime) {
                    beforeTime = t; beforeRow = r;
                } else if (t > pivotTime && t < afterTime) {
                    afterTime  = t; afterRow  = r;
                }
            });

            const oLabel = om.label || '';
            if (sameRows.length) {
                sameRows.forEach(r => {
                    const e = _makeEntry(
                        rec.id, oName, oColor,
                        _buildRowData(oCols, r), oCols[oi] || '', r[oi] ?? null,
                        _buildColAliases(oCols, oCT), _buildColOrder(oCols), 'same'
                    );
                    e.label = oLabel;
                    proxEntries.push(e);
                });
            } else {
                if (beforeRow) {
                    const e = _makeEntry(
                        rec.id, oName, oColor,
                        _buildRowData(oCols, beforeRow), oCols[oi] || '', beforeRow[oi] ?? null,
                        _buildColAliases(oCols, oCT), _buildColOrder(oCols), 'before'
                    );
                    e.label = oLabel;
                    proxEntries.push(e);
                }
                if (afterRow) {
                    const e = _makeEntry(
                        rec.id, oName, oColor,
                        _buildRowData(oCols, afterRow), oCols[oi] || '', afterRow[oi] ?? null,
                        _buildColAliases(oCols, oCT), _buildColOrder(oCols), 'after'
                    );
                    e.label = oLabel;
                    proxEntries.push(e);
                }
            }
        });

        _previewEntries = [pivotEntry, ...proxEntries];
        _hasPreview = true;

        if (typeof Timeline !== 'undefined') {
            Timeline.setPreviewEntries(_previewEntries);
            // Open timeline panel if it's closed
            const tlPanel = document.getElementById('timeline-panel');
            if (tlPanel?.classList.contains('hidden')) Timeline.toggle();
        }

        _showControls(true);
        return true;
    }

    // -------------------------------------------------------------------------
    // Preview management
    // -------------------------------------------------------------------------
    function removePreviewEntry(id) {
        _previewEntries = _previewEntries.filter(e => e.id !== id);
        if (_previewEntries.length === 0) {
            _clearPreviewSilent();
            if (typeof Timeline !== 'undefined') Timeline.setPreviewEntries([]);
        } else {
            if (typeof Timeline !== 'undefined') Timeline.setPreviewEntries(_previewEntries);
        }
    }

    function confirm() {
        if (!_hasPreview) return;
        _previewEntries.forEach(e => {
            if (typeof Timeline !== 'undefined') {
                Timeline.addEntry(e.recId, e.recName, e.color, e.rowData, e.colName, e.colValue, e.colAliases, e.colOrder, null, null, { label: e.label || '' });
            }
        });
        _clearPreviewSilent();
        if (typeof Timeline !== 'undefined') Timeline.setPreviewEntries([]);
        App.notify?.('Chain entries added to timeline.', 'ok');
    }

    function discard() {
        _clearPreviewSilent();
        if (typeof Timeline !== 'undefined') Timeline.setPreviewEntries([]);
    }

    function _clearPreviewSilent() {
        _previewEntries = [];
        _hasPreview     = false;
        _showControls(false);
    }

    function _showControls(show) {
        document.getElementById('timeline-chain-controls')?.classList.toggle('hidden', !show);
    }

    // -------------------------------------------------------------------------
    // Highlight mapped column in results table after Results.render()
    // -------------------------------------------------------------------------
    function applyHighlight() {
        // --- Reset results table ---
        document.querySelectorAll('.chain-col-highlight').forEach(el => el.classList.remove('chain-col-highlight'));
        const tbl = document.getElementById('results-table');
        if (tbl) tbl.classList.remove('chain-pivot-focus');

        // --- Reset recordings list ---
        const recList = document.getElementById('recordings-list');
        document.querySelectorAll('.chain-group-active').forEach(el => el.classList.remove('chain-group-active'));
        if (recList) recList.classList.remove('chain-pivot-focus');

        if (!_activeGroupId) return;

        // --- Dim recordings list: mark active group elements, dim everything else ---
        if (recList) {
            recList.classList.add('chain-pivot-focus');
            recList.querySelectorAll(
                `.rec-entry[data-group-id="${_activeGroupId}"], .rec-group-header[data-group-id="${_activeGroupId}"]`
            ).forEach(el => el.classList.add('chain-group-active'));
        }

        // --- Results table: highlight mapped pivot column ---
        const recId = typeof Recordings !== 'undefined' ? Recordings.getCurrentRecId?.() : null;
        if (!recId) return;

        const recObj = (State.recordings || []).find(r => r.id === recId);
        if (!recObj || recObj.groupId !== _activeGroupId) return;

        const mapping = (_cfg(_activeGroupId).mappings || {})[recId];
        if (!mapping || mapping.colIdx === undefined) return;

        // +2: nth-child is 1-indexed, and first column is the row-number column
        const nth = mapping.colIdx + 2;
        document.querySelectorAll('#results-table th:nth-child(' + nth + '), #results-table td:nth-child(' + nth + ')')
            .forEach(el => el.classList.add('chain-col-highlight'));

        // Dim all non-pivot columns so the pivot column stands out
        if (tbl) tbl.classList.add('chain-pivot-focus');
    }

    // -------------------------------------------------------------------------
    // Entry factory and row-data helpers
    // -------------------------------------------------------------------------
    function _makeEntry(recId, recName, color, rowData, colName, colValue, colAliases, colOrder, proxType) {
        return {
            id:         'chain_' + Date.now() + '_' + (++_idSeq),
            recId, recName, color,
            rowData:    rowData    || {},
            colName:    colName    || '',
            colValue:   colValue   ?? null,
            colAliases: colAliases || {},
            colOrder:   Array.isArray(colOrder) ? [...colOrder] : null,
            label:      '',
            proxType,
            groupId:    null,
            pinned:     false,
            pinnedCols: [],
            addedAt:    Date.now(),
        };
    }

    function _buildRowData(cols, row) {
        const obj = {}, seen = new Set();
        cols.forEach((c, i) => {
            let key = c;
            if (seen.has(key)) { let n = 2; while (seen.has(c + '_' + n)) n++; key = c + '_' + n; }
            seen.add(key);
            obj[key] = row[i] ?? null;
        });
        return obj;
    }

    function _buildColAliases(cols, colTables) {
        const m = {}, seen = new Set();
        cols.forEach((c, i) => {
            let key = c;
            if (seen.has(key)) { let n = 2; while (seen.has(c + '_' + n)) n++; key = c + '_' + n; }
            seen.add(key);
            if (colTables[i]) m[key] = colTables[i] + '.' + c;
        });
        return m;
    }

    function _buildColOrder(cols) {
        const out = [], seen = new Set();
        cols.forEach(c => {
            let key = c;
            if (seen.has(key)) { let n = 2; while (seen.has(c + '_' + n)) n++; key = c + '_' + n; }
            seen.add(key);
            out.push(key);
        });
        return out;
    }

    // -------------------------------------------------------------------------
    function init() {
        document.getElementById('chain-confirm-btn')?.addEventListener('click', confirm);
        document.getElementById('chain-discard-btn')?.addEventListener('click', discard);
    }

    return {
        init,
        isActive,
        getActiveGroupId,
        toggle,
        onCellClick,
        applyHighlight,
        removePreviewEntry,
        confirm,
        discard,
    };
})();
