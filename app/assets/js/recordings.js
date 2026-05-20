/**
 * Recordings — capture, browse and restore query results + island configs.
 *
 * Public API:
 *   Recordings.init()            — wire DOM, called once from App.init()
 *   Recordings.toggle()          — show/hide the recordings panel
 *   Recordings.toggleRecord()    — pause/resume recording
 *   Recordings.onQuerySuccess(r) — called by Results.render() after a successful query
 *   Recordings.refresh()         — resync badges after context load
 */
const Recordings = (() => {
    let _panel      = null;
    let _visible    = false;
    let _idSeq      = 0;
    let _newIsland  = false;   // global "restore in new island" preference
    let _dragId     = null;    // id of entry currently being dragged
    let _dimMode    = false;   // show only checked rows
    let _sameColor  = false;   // show only rows matching color of checked rows
    let _pinnedSqlPreview = null; // { btn, hideFn } — currently pinned SQL preview

    // -------------------------------------------------------------------------
    // Public
    // -------------------------------------------------------------------------

    function init() {
        if (!Array.isArray(State.recordings))  State.recordings      = [];
        if (State.recordingActive == null)      State.recordingActive = true;

        _panel = document.getElementById('recordings-panel');

        document.getElementById('btn-recordings-toggle')
            ?.addEventListener('click', toggle);
        document.getElementById('btn-recordings-close')
            ?.addEventListener('click', () => { _visible = true; toggle(); });
        document.getElementById('btn-rec-record')
            ?.addEventListener('click', toggleRecord);
        document.getElementById('btn-rec-delete-selected')
            ?.addEventListener('click', _deleteSelected);
        document.getElementById('btn-rec-compare')
            ?.addEventListener('click', _compareSelected);
        document.getElementById('chk-rec-select-all')
            ?.addEventListener('change', e => _selectAll(e.target.checked));
        document.getElementById('btn-rec-dim')
            ?.addEventListener('click', _toggleDim);
        document.getElementById('btn-rec-same-color')
            ?.addEventListener('click', _toggleSameColor);

        const helpBtn   = document.getElementById('btn-rec-help');
        const helpPopup = document.getElementById('rec-help-popup');
        // Move popup to <body> so it escapes the panel's overflow:hidden clipping
        if (helpPopup) document.body.appendChild(helpPopup);
        helpBtn?.addEventListener('click', e => {
            e.stopPropagation();
            const isHidden = helpPopup.classList.toggle('hidden');
            if (!isHidden) {
                const r = helpBtn.getBoundingClientRect();
                helpPopup.style.top = (r.bottom + 6) + 'px';
            }
        });
        document.addEventListener('click', e => {
            if (helpPopup && !helpPopup.classList.contains('hidden') &&
                !helpPopup.contains(e.target) && e.target !== helpBtn) {
                helpPopup.classList.add('hidden');
            }
        });

        _makeDraggable(
            document.getElementById('recordings-panel-header'),
            _panel
        );

        _updateBadges();
    }

    function toggle() {
        _visible = !_visible;
        _panel?.classList.toggle('hidden', !_visible);
        document.getElementById('btn-recordings-toggle')
            ?.classList.toggle('is-active', _visible);
        if (_visible) {
            _renderList();
        } else {
            // Reset filter toggles on close
            _dimMode   = false;
            _sameColor = false;
            document.getElementById('btn-rec-dim')?.classList.remove('is-active');
            document.getElementById('btn-rec-same-color')?.classList.remove('is-active');
        }
    }

    function toggleRecord() {
        State.recordingActive = !State.recordingActive;
        _updateBadges();
    }

    /**
     * Called by Results.render() after a successful non-diff, non-replay query.
     */
    function onQuerySuccess(result) {
        if (!State.recordingActive) return;
        if (!result?.cols) return;

        App.flushCurrentIslandConfig?.();

        const islandKey = State.selectedIslandKey;
        if (!islandKey) return;

        const islandTableIds = new Set(islandKey.split('|'));
        const tables = State.tables
            .filter(t => islandTableIds.has(t.id))
            .map(t => JSON.parse(JSON.stringify(t)));
        const joins = State.joins
            .filter(j => islandTableIds.has(j.fromTableId) && islandTableIds.has(j.toTableId))
            .map(j => JSON.parse(JSON.stringify(j)));
        const islandConfig = JSON.parse(JSON.stringify(
            State.islandConfigs?.[islandKey] ?? {}
        ));

        const nextSeq = Math.max(0, ...(State.recordings || []).map(r => r.seq ?? 0)) + 1;

        const entry = {
            id:        _newId('rec'),
            seq:       nextSeq,
            timestamp: Date.now(),
            name:      null,
            sql:       result.sql || document.getElementById('sql-preview-text')?.textContent || '',
            results: {
                cols:       (result.cols       || []).slice(),
                rows:       (result.rows       || []).map(r => r.slice()),
                col_tables: (result.col_tables || []).slice(),
                col_types:  (result.col_types  || []).slice(),
                count:      result.count ?? result.rows?.length ?? 0,
            },
            island: {
                key:    islandKey,
                tables,
                joins,
                config: islandConfig,
                name:   State.islandNames?.[islandKey]  ?? null,
                color:  State.islandColors?.[islandKey] ?? null,
            },
        };

        if (!Array.isArray(State.recordings)) State.recordings = [];
        State.recordings.unshift(entry);

        _updateBadges();
        if (_visible) _renderList();
    }

    /** Resync badges and list after a context load. */
    function refresh() {
        if (!Array.isArray(State.recordings)) State.recordings = [];
        if (State.recordingActive == null)    State.recordingActive = true;
        _updateBadges();
        if (_visible) _renderList();
    }

    // -------------------------------------------------------------------------
    // List rendering
    // -------------------------------------------------------------------------

    function _renderList() {
        const list = document.getElementById('recordings-list');
        if (!list) return;

        // Snapshot checked IDs BEFORE wiping the DOM
        const checkedIds = new Set(
            [...list.querySelectorAll('.rec-entry-chk:checked')]
                .map(c => c.closest('.rec-entry')?.dataset.id).filter(Boolean)
        );

        // Clean up any pinned SQL preview — its button is about to be destroyed
        if (_pinnedSqlPreview) {
            _pinnedSqlPreview.btn.classList.remove('is-active');
            _pinnedSqlPreview.hideFn();
            _pinnedSqlPreview = null;
        }

        list.innerHTML = '';

        // reset select-all and action buttons
        const selAll = document.getElementById('chk-rec-select-all');
        if (selAll) selAll.checked = false;
        document.getElementById('btn-rec-delete-selected').disabled = true;
        document.getElementById('btn-rec-compare').disabled         = true;
        document.getElementById('btn-rec-dim').disabled             = true;
        document.getElementById('btn-rec-same-color').disabled      = true;

        const allRecs = State.recordings || [];
        if (!allRecs.length) {
            list.innerHTML = '<div class="rec-empty">No recordings yet. Run a query while recording is active.</div>';
            return;
        }

        // --- compute visible set based on filter modes ---
        // Intersect checkedIds with what still exists (deletions remove entries from State)
        const validCheckedRecs = allRecs.filter(r => checkedIds.has(r.id));

        let recs = allRecs;
        if (_dimMode) {
            if (validCheckedRecs.length === 0) {
                // All checked rows were deleted — end DIM
                _dimMode = false;
                document.getElementById('btn-rec-dim')?.classList.remove('is-active');
            } else {
                recs = recs.filter(r => checkedIds.has(r.id));
            }
        }
        if (_sameColor) {
            const activeColors = new Set(
                validCheckedRecs.filter(r => (r.color ?? null) !== null).map(r => r.color)
            );
            if (activeColors.size === 0) {
                // No colored checked rows remain — end Same color
                _sameColor = false;
                document.getElementById('btn-rec-same-color')?.classList.remove('is-active');
            } else {
                recs = recs.filter(r => activeColors.has(r.color ?? null));
            }
        }

        recs.forEach(rec => {
            const row = document.createElement('div');
            row.className  = 'rec-entry';
            row.dataset.id = rec.id;
            row.draggable  = true;

            // Drag-and-drop handlers
            row.addEventListener('dragstart', e => {
                _dragId = rec.id;
                e.dataTransfer.effectAllowed = 'move';
                requestAnimationFrame(() => row.classList.add('rec-entry--dragging'));
            });
            row.addEventListener('dragend', () => {
                _dragId = null;
                list.querySelectorAll('.rec-entry--dragging, .rec-entry--drag-over')
                    .forEach(el => el.classList.remove('rec-entry--dragging', 'rec-entry--drag-over'));
            });
            row.addEventListener('dragover', e => {
                if (!_dragId || _dragId === rec.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                list.querySelectorAll('.rec-entry--drag-over')
                    .forEach(el => el.classList.remove('rec-entry--drag-over'));
                row.classList.add('rec-entry--drag-over');
            });
            row.addEventListener('dragleave', e => {
                if (!row.contains(e.relatedTarget)) row.classList.remove('rec-entry--drag-over');
            });
            row.addEventListener('drop', e => {
                e.preventDefault();
                if (!_dragId || _dragId === rec.id) return;
                const fromIdx = State.recordings.findIndex(r => r.id === _dragId);
                const toIdx   = State.recordings.findIndex(r => r.id === rec.id);
                if (fromIdx === -1 || toIdx === -1) return;
                const [moved] = State.recordings.splice(fromIdx, 1);
                State.recordings.splice(toIdx, 0, moved);
                _renderList();
            });

            // Seq number
            const seqEl = document.createElement('span');
            seqEl.className   = 'rec-entry-seq';
            seqEl.textContent = rec.seq ?? '';
            row.appendChild(seqEl);

            // Checkbox — restore checked state so filters & button states survive re-render
            const chk = document.createElement('input');
            chk.type    = 'checkbox';
            chk.checked = checkedIds.has(rec.id);
            chk.className = 'rec-entry-chk';
            chk.addEventListener('change', _onCheckChange);
            row.appendChild(chk);

            // Name
            const nameWrap = document.createElement('span');
            nameWrap.className = 'rec-entry-name';

            const nameEl = document.createElement('span');
            nameEl.className   = 'rec-entry-name-text';
            nameEl.textContent = rec.name || _fmtTs(rec.timestamp);
            nameEl.addEventListener('click', e => { e.stopPropagation(); chk.checked = !chk.checked; _onCheckChange(); });
            nameWrap.appendChild(nameEl);

            row.appendChild(nameWrap);

            // Single click anywhere on the row toggles the checkbox
            row.addEventListener('click', e => {
                if (e.target === chk) return;                 // checkbox handles itself
                if (e.target.closest('button, input')) return; // buttons / rename input
                chk.checked = !chk.checked;
                _onCheckChange();
            });

            // Right-click cycles through colors (null → color[0] → color[1] → … → null)
            row.addEventListener('contextmenu', e => {
                e.preventDefault();
                const colors = (typeof Canvas !== 'undefined' && Canvas.CARD_COLORS)
                    ? Canvas.CARD_COLORS.map(c => c.hex)
                    : [];
                const currentIdx = colors.indexOf(rec.color ?? null);
                // -1 = no color → first color; last color → null; otherwise advance
                rec.color = currentIdx === -1
                    ? colors[0]
                    : currentIdx === colors.length - 1
                        ? null
                        : colors[currentIdx + 1];
                _applyEntryColor(row, colorBtn, rec.color);
                if (_sameColor) _renderList();
            });

            // Row count
            const badge = document.createElement('span');
            badge.className = 'rec-entry-rowcount';
            badge.textContent = (rec.results?.count ?? rec.results?.rows?.length ?? '?') + ' rows';
            row.appendChild(badge);

            // Action buttons
            const actions = document.createElement('div');
            actions.className = 'rec-entry-actions';

            // Color dot — left of Results
            const colorBtn = document.createElement('button');
            colorBtn.className = 'rec-color-btn';
            colorBtn.title     = 'Set row color';
            _applyEntryColor(row, colorBtn, rec.color ?? null);
            colorBtn.addEventListener('click', e => {
                e.stopPropagation();
                _openEntryColorPopup(rec, row, colorBtn);
            });
            actions.appendChild(colorBtn);

            const colorSep = document.createElement('span');
            colorSep.className = 'rec-action-sep';
            actions.appendChild(colorSep);

            const renameActionBtn = _btn('✎', 'Rename this recording', () => _startRename(rec.id, nameEl, rec));
            actions.appendChild(renameActionBtn);

            // SQL Preview button — hover reveals a floating syntax-highlighted preview;
            // click pins/unpins it so it stays visible until clicked again.
            const sqlPreviewBtn = _btn('⌕ Peek', 'Hover to preview SQL · Click to pin', null);
            let _sqlPreviewPopup = null;
            let _sqlHideTimer    = null;

            const isPinned = () => _pinnedSqlPreview?.btn === sqlPreviewBtn;

            const showSqlPreview = () => {
                clearTimeout(_sqlHideTimer);
                if (_sqlPreviewPopup) return;

                const popup = document.createElement('div');
                popup.className = 'rec-sql-preview-popup';

                // Header row: drag handle + close button
                const header = document.createElement('div');
                header.className = 'rec-sql-preview-header';

                const dragHandle = document.createElement('span');
                dragHandle.className = 'rec-sql-preview-drag';
                header.appendChild(dragHandle);

                const closeBtn = document.createElement('button');
                closeBtn.className   = 'rec-sql-preview-close';
                closeBtn.textContent = '✕';
                closeBtn.title       = 'Close preview';
                closeBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    if (isPinned()) {
                        sqlPreviewBtn.classList.remove('is-active');
                        _pinnedSqlPreview = null;
                    }
                    hideSqlPreview();
                });
                header.appendChild(closeBtn);
                popup.appendChild(header);

                // Drag logic — convert right→left on first move so left/top are authoritative
                header.addEventListener('mousedown', e => {
                    if (e.target === closeBtn) return;
                    e.preventDefault();
                    const pr  = popup.getBoundingClientRect();
                    // Switch from right-based to left-based positioning
                    popup.style.left  = pr.left + 'px';
                    popup.style.right = 'auto';
                    let ox = e.clientX - pr.left;
                    let oy = e.clientY - pr.top;
                    const onMove = ev => {
                        popup.style.left = (ev.clientX - ox) + 'px';
                        popup.style.top  = (ev.clientY - oy) + 'px';
                    };
                    const onUp = () => {
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup',   onUp);
                    };
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup',   onUp);
                });

                const ta = document.createElement('textarea');
                ta.className  = 'rec-sql-preview-ta';
                ta.readOnly   = true;
                ta.spellcheck = false;
                ta.value      = rec.sql || '';
                popup.appendChild(ta);
                document.body.appendChild(popup);
                _sqlPreviewPopup = popup;
                sqlPreviewBtn.classList.add('is-previewing');

                if (typeof SqlBackdrop !== 'undefined') SqlBackdrop.attach(ta);

                ta.addEventListener('keydown', e => {
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        if (isPinned()) {
                            sqlPreviewBtn.classList.remove('is-active');
                            _pinnedSqlPreview = null;
                        }
                        hideSqlPreview();
                    }
                });

                // Position: right edge 10px left of the color button's left edge
                const colorBtnRect = colorBtn.getBoundingClientRect();
                const btnRect      = sqlPreviewBtn.getBoundingClientRect();
                popup.style.right = (window.innerWidth - colorBtnRect.left + 10) + 'px';
                requestAnimationFrame(() => {
                    const ph = popup.offsetHeight;
                    let top = btnRect.top + btnRect.height / 2 - ph / 2;
                    top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
                    popup.style.top = top + 'px';
                });

                popup.addEventListener('mouseenter', () => clearTimeout(_sqlHideTimer));
                popup.addEventListener('mouseleave', () => {
                    if (isPinned()) return;
                    _sqlHideTimer = setTimeout(hideSqlPreview, 120);
                });

                // Clicking the popup or its textarea pins the Peek button
                popup.addEventListener('click', () => {
                    if (isPinned()) return;
                    // Unpin any other active preview first
                    if (_pinnedSqlPreview) {
                        _pinnedSqlPreview.btn.classList.remove('is-active');
                        _pinnedSqlPreview.hideFn();
                        _pinnedSqlPreview = null;
                    }
                    sqlPreviewBtn.classList.add('is-active');
                    _pinnedSqlPreview = { btn: sqlPreviewBtn, hideFn: hideSqlPreview };
                });
            };

            const hideSqlPreview = () => {
                if (!_sqlPreviewPopup) return;
                if (typeof SqlBackdrop !== 'undefined') {
                    const ta = _sqlPreviewPopup.querySelector('textarea');
                    if (ta) SqlBackdrop.detach(ta);
                }
                _sqlPreviewPopup.remove();
                _sqlPreviewPopup = null;
                sqlPreviewBtn.classList.remove('is-previewing');
            };

            sqlPreviewBtn.addEventListener('mouseenter', () => {
                if (_pinnedSqlPreview && !isPinned()) return; // another button is pinned
                showSqlPreview();
            });
            sqlPreviewBtn.addEventListener('mouseleave', () => {
                if (isPinned()) return;
                _sqlHideTimer = setTimeout(hideSqlPreview, 120);
            });

            sqlPreviewBtn.addEventListener('click', e => {
                e.stopPropagation();
                // Unpin any previously pinned button
                if (_pinnedSqlPreview && _pinnedSqlPreview.btn !== sqlPreviewBtn) {
                    _pinnedSqlPreview.btn.classList.remove('is-active');
                    _pinnedSqlPreview.hideFn();
                    _pinnedSqlPreview = null;
                }
                if (isPinned()) {
                    // Unpin this button
                    sqlPreviewBtn.classList.remove('is-active');
                    _pinnedSqlPreview = null;
                } else {
                    // Pin this button
                    sqlPreviewBtn.classList.add('is-active');
                    _pinnedSqlPreview = { btn: sqlPreviewBtn, hideFn: hideSqlPreview };
                    showSqlPreview();
                }
            });

            actions.appendChild(sqlPreviewBtn);

            const actionSep = document.createElement('span');
            actionSep.className = 'rec-action-sep';
            actions.appendChild(actionSep);

            actions.appendChild(_btn('Results', 'Load results into table', () => _loadResults(rec)));
            actions.appendChild(_btn('SQL',     'View generated SQL',      () => _showSQL(rec)));

            // "New island" checkbox sits directly left of the Island button
            const newIslChk = document.createElement('input');
            newIslChk.type    = 'checkbox';
            newIslChk.checked = _newIsland;
            newIslChk.title   = 'Restore in a new island instead of replacing the current one';
            newIslChk.className = 'rec-new-island-chk';
            newIslChk.addEventListener('change', e => { _newIsland = e.target.checked; });
            actions.appendChild(newIslChk);

            actions.appendChild(_btn('Island',  'Restore island config',   () => _restoreIsland(rec)));
            const del = _btn('✕', 'Delete', () => _deleteEntry(rec.id));
            del.classList.add('rec-btn-del');
            actions.appendChild(del);
            row.appendChild(actions);

            list.appendChild(row);
        });

        // Recompute button states — no re-render (we're already inside _renderList)
        _updateHeaderButtons(false);

        // Sync select-all checkbox: check it iff every visible row is checked
        const allVisibleChks = [...list.querySelectorAll('.rec-entry-chk')];
        const selAllEl = document.getElementById('chk-rec-select-all');
        if (selAllEl) {
            selAllEl.checked = allVisibleChks.length > 0 && allVisibleChks.every(c => c.checked);
        }
    }

    function _btn(label, title, onClick) {
        const b = document.createElement('button');
        b.className = 'rec-action-btn';
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', onClick);
        return b;
    }

    // -------------------------------------------------------------------------
    // Rename
    // -------------------------------------------------------------------------

    function _startRename(id, nameEl, rec) {
        const input = document.createElement('input');
        input.type      = 'text';
        input.className = 'rec-rename-input';
        input.value     = rec.name || _fmtTs(rec.timestamp);
        nameEl.replaceWith(input);
        input.focus();
        input.select();

        const commit = () => {
            const val = input.value.trim();
            rec.name = val || null;
            nameEl.textContent = rec.name || _fmtTs(rec.timestamp);
            input.replaceWith(nameEl);
        };
        input.addEventListener('blur',    commit);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter')  { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { input.replaceWith(nameEl); }
        });
    }

    // -------------------------------------------------------------------------
    // Delete
    // -------------------------------------------------------------------------

    function _deleteEntry(id) {
        State.recordings = (State.recordings || []).filter(r => r.id !== id);
        _updateBadges();
        _renderList();
    }

    async function _deleteSelected() {
        const ids = new Set(
            [...document.querySelectorAll('.rec-entry-chk:checked')]
                .map(c => c.closest('.rec-entry')?.dataset.id)
                .filter(Boolean)
        );
        const n = ids.size;
        if (!n) return;
        if (!await Dialog.confirm(`Delete ${n} selected recording${n !== 1 ? 's' : ''}?`)) return;
        State.recordings = (State.recordings || []).filter(r => !ids.has(r.id));
        _updateBadges();
        _renderList();
    }

    function _selectAll(checked) {
        document.querySelectorAll('.rec-entry-chk').forEach(c => { c.checked = checked; });
        _onCheckChange();
    }

    // Updates header button states from the current DOM check state.
    // Pass rerender=true only from user-triggered events (not from inside _renderList).
    function _updateHeaderButtons(rerender) {
        const checked = [...document.querySelectorAll('.rec-entry-chk:checked')];
        const checkedCount = checked.length;

        const hasColoredChecked = checked.some(c => {
            const id  = c.closest('.rec-entry')?.dataset.id;
            const rec = (State.recordings || []).find(r => r.id === id);
            return rec && (rec.color ?? null) !== null;
        });

        document.getElementById('btn-rec-delete-selected').disabled = checkedCount === 0;
        document.getElementById('btn-rec-compare').disabled         = checkedCount !== 2;

        const dimShouldDisable       = checkedCount === 0;
        const sameColorShouldDisable = !hasColoredChecked;

        document.getElementById('btn-rec-dim').disabled        = dimShouldDisable;
        document.getElementById('btn-rec-same-color').disabled = sameColorShouldDisable;

        // If a filter gets disabled while active, turn it off
        let filterDeactivated = false;
        if (dimShouldDisable && _dimMode) {
            _dimMode = false;
            filterDeactivated = true;
            document.getElementById('btn-rec-dim')?.classList.remove('is-active');
        }
        if (sameColorShouldDisable && _sameColor) {
            _sameColor = false;
            filterDeactivated = true;
            document.getElementById('btn-rec-same-color')?.classList.remove('is-active');
        }

        // Re-render if a filter is active OR was just deactivated — only from user events
        if (rerender && (_dimMode || _sameColor || filterDeactivated)) _renderList();
    }

    function _onCheckChange() {
        _updateHeaderButtons(true);
    }

    function _toggleDim() {
        _dimMode = !_dimMode;
        document.getElementById('btn-rec-dim')?.classList.toggle('is-active', _dimMode);
        _renderList();
    }

    function _toggleSameColor() {
        _sameColor = !_sameColor;
        document.getElementById('btn-rec-same-color')?.classList.toggle('is-active', _sameColor);
        _renderList();
    }

    function _compareSelected() {
        const checked = [...document.querySelectorAll('.rec-entry-chk:checked')];
        if (checked.length !== 2) return;
        const ids  = checked.map(c => c.closest('.rec-entry')?.dataset.id);
        const recs = ids.map(id => (State.recordings || []).find(r => r.id === id));
        if (!recs[0] || !recs[1]) return;
        if (typeof Results === 'undefined') return;
        // Top entry in the list = "before" (snapshot), bottom = "after"
        Results.compareRecordings(recs[0].results, recs[1].results);
    }

    // -------------------------------------------------------------------------
    // Apply: Results
    // -------------------------------------------------------------------------

    function _loadResults(rec) {
        if (!rec.results?.cols) { App.notify?.('No results data in this recording.', 'warn'); return; }
        if (typeof Results === 'undefined') return;
        Results.render({
            cols:           rec.results.cols,
            rows:           rec.results.rows,
            col_tables:     rec.results.col_tables || [],
            col_types:      rec.results.col_types  || [],
            count:          rec.results.count ?? rec.results.rows.length,
            sql:            rec.sql || '',
            _fromRecording: true,
        });
    }

    // -------------------------------------------------------------------------
    // Apply: SQL popup — reuse the Run Custom Query modal
    // -------------------------------------------------------------------------

    function _showSQL(rec) {
        const modal = document.getElementById('modal-custom-query');
        const ta    = document.getElementById('custom-query-textarea');
        if (!modal || !ta) return;

        ta.value = rec.sql || '';
        ta.dispatchEvent(new Event('input', { bubbles: true }));

        modal.classList.remove('hidden');
        requestAnimationFrame(() => ta.focus());
    }

    // -------------------------------------------------------------------------
    // Apply: Island restore
    // -------------------------------------------------------------------------

    function _restoreIsland(rec) {
        if (!rec.island?.tables?.length) {
            App.notify?.('No island data in this recording.', 'warn');
            return;
        }

        const inNewIsland = _newIsland;

        // Generate fresh IDs for all tables and joins to avoid conflicts
        const idMap = {};
        rec.island.tables.forEach(t => { idMap[t.id] = _newId('t'); });

        // Compute position offset for new-island mode (place to the right of existing content)
        let offsetX = 0;
        if (inNewIsland && State.tables.length) {
            const maxX    = Math.max(...State.tables.map(t => (t.position?.x ?? 0) + 260));
            const minRecX = Math.min(...rec.island.tables.map(t => t.position?.x ?? 0));
            offsetX = maxX + 80 - minRecX;
        }

        const newTables = rec.island.tables.map(t => ({
            ...JSON.parse(JSON.stringify(t)),
            id:       idMap[t.id],
            position: { x: (t.position?.x ?? 200) + offsetX, y: t.position?.y ?? 200 },
        }));

        const newJoins = rec.island.joins.map(j => ({
            ...JSON.parse(JSON.stringify(j)),
            id:          _newId('j'),
            fromTableId: idMap[j.fromTableId],
            toTableId:   idMap[j.toTableId],
        }));

        const newKey = newTables.map(t => t.id).sort().join('|');

        // Remap tableOrder keys in the island config
        const config = JSON.parse(JSON.stringify(rec.island.config ?? {}));
        if (config.tableOrder) {
            const remapped = {};
            Object.entries(config.tableOrder).forEach(([oldId, order]) => {
                if (idMap[oldId]) remapped[idMap[oldId]] = order;
            });
            config.tableOrder = remapped;
        }

        // Save current right-pane state before modifying
        App.flushCurrentIslandConfig?.();

        if (!inNewIsland && State.selectedIslandKey) {
            // Remove current island's tables and joins
            const curIds = new Set(State.selectedIslandKey.split('|'));
            State.tables = State.tables.filter(t => !curIds.has(t.id));
            State.joins  = State.joins.filter(j =>
                !curIds.has(j.fromTableId) && !curIds.has(j.toTableId)
            );
            if (State.islandConfigs) delete State.islandConfigs[State.selectedIslandKey];
        }

        // Add restored tables and joins
        State.tables.push(...newTables);
        State.joins.push(...newJoins);

        // Store config and metadata
        if (!State.islandConfigs) State.islandConfigs = {};
        State.islandConfigs[newKey] = config;
        if (rec.island.name)  { if (!State.islandNames)  State.islandNames  = {}; State.islandNames[newKey]  = rec.island.name; }
        if (rec.island.color) { if (!State.islandColors) State.islandColors = {}; State.islandColors[newKey] = rec.island.color; }

        // Rebuild canvas, then select/blit the restored island
        State.selectedIslandKey = newKey;
        Canvas.rebuildFromState(State);
        App.blitIslandConfig(newKey);
    }

    // -------------------------------------------------------------------------
    // Entry color picker
    // -------------------------------------------------------------------------

    let _entryColorPopup = null;

    function _applyEntryColor(row, btn, color) {
        if (color) {
            row.style.borderLeft = `3px solid ${color}`;
            row.style.background = _hexToRgba(color, 0.13);
            btn.style.background = color;
            btn.classList.add('has-color');
        } else {
            row.style.borderLeft = '3px solid transparent';
            row.style.background = '';
            btn.style.background = '';
            btn.classList.remove('has-color');
        }
    }

    function _hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    function _openEntryColorPopup(rec, row, anchorBtn) {
        // Toggle
        if (_entryColorPopup) { _entryColorPopup.remove(); _entryColorPopup = null; return; }

        const COLORS = (typeof Canvas !== 'undefined' && Canvas.CARD_COLORS) ? Canvas.CARD_COLORS : [];

        const popup = document.createElement('div');
        popup.className = 'card-color-popup';

        const swatchWrap = document.createElement('div');
        swatchWrap.className = 'card-color-swatches';

        COLORS.forEach(({ hex, label }) => {
            const sw = document.createElement('button');
            sw.className       = 'card-color-swatch';
            sw.title           = label;
            sw.style.background = hex;
            if (rec.color === hex) sw.classList.add('is-active');
            sw.addEventListener('click', e => {
                e.stopPropagation();
                rec.color = hex;
                _applyEntryColor(row, anchorBtn, hex);
                popup.remove();
                _entryColorPopup = null;
            });
            swatchWrap.appendChild(sw);
        });

        const resetBtn = document.createElement('button');
        resetBtn.className   = 'card-color-reset';
        resetBtn.textContent = '✕ Reset color';
        resetBtn.addEventListener('click', e => {
            e.stopPropagation();
            rec.color = null;
            _applyEntryColor(row, anchorBtn, null);
            popup.remove();
            _entryColorPopup = null;
        });

        popup.appendChild(swatchWrap);
        popup.appendChild(resetBtn);
        document.body.appendChild(popup);
        _entryColorPopup = popup;

        // Position below anchor
        const rect = anchorBtn.getBoundingClientRect();
        let left = rect.left;
        let top  = rect.bottom + 6;
        if (left + 160 > window.innerWidth - 8) left = window.innerWidth - 168;
        popup.style.left = left + 'px';
        popup.style.top  = top  + 'px';

        setTimeout(() => {
            document.addEventListener('click', function close() {
                popup.remove();
                _entryColorPopup = null;
                document.removeEventListener('click', close);
            }, { once: true });
        }, 0);
    }

    // -------------------------------------------------------------------------
    // Badges & state display
    // -------------------------------------------------------------------------

    function _updateBadges() {
        const count  = (State.recordings || []).length;
        const active = !!State.recordingActive;

        // Panel header count
        const panelBadge = document.getElementById('rec-count-badge');
        if (panelBadge) panelBadge.textContent = count;

        // Toolbar toggle button
        const toggleBtn = document.getElementById('btn-recordings-toggle');
        if (toggleBtn) {
            const countSpan = toggleBtn.querySelector('.rec-toggle-count');
            if (countSpan) countSpan.textContent = count;
            toggleBtn.classList.toggle('rec-is-recording', active);
        }

        // REC button inside panel
        const recBtn = document.getElementById('btn-rec-record');
        if (recBtn) {
            recBtn.textContent = active ? '■ Stop' : '● Record';
            recBtn.classList.toggle('is-recording', active);
            recBtn.title = active ? 'Recording active — click to stop' : 'Recording stopped — click to resume';
        }
    }

    // -------------------------------------------------------------------------
    // Drag
    // -------------------------------------------------------------------------

    function _makeDraggable(handle, panel) {
        if (!handle || !panel) return;
        let ox = 0, oy = 0;
        handle.style.cursor = 'move';
        handle.addEventListener('mousedown', e => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
            e.preventDefault();
            const r = panel.getBoundingClientRect();
            // Pin to current rendered position and remove the centering transform
            // so that style.left/top map 1:1 to screen coordinates going forward.
            panel.style.left      = r.left + 'px';
            panel.style.top       = r.top  + 'px';
            panel.style.right     = 'auto';
            panel.style.bottom    = 'auto';
            panel.style.transform = 'none';
            ox = e.clientX - r.left;
            oy = e.clientY - r.top;
            const onMove = ev => {
                panel.style.left   = (ev.clientX - ox) + 'px';
                panel.style.top    = (ev.clientY - oy) + 'px';
                panel.style.right  = 'auto';
                panel.style.bottom = 'auto';
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup',   onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup',   onUp);
        });
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _newId(prefix) {
        return `${prefix}_${Date.now()}_${++_idSeq}_${Math.random().toString(36).slice(2, 6)}`;
    }

    function _fmtTs(ts) {
        const d   = new Date(ts);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
               `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    // -------------------------------------------------------------------------
    return { init, toggle, toggleRecord, onQuerySuccess, refresh };
})();
