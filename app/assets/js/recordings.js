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
    let _dragId      = null;    // id of recording currently being dragged
    let _dragGroupId = null;    // id of group currently being dragged (group reorder)
    let _dimMode    = false;   // show only checked rows
    let _sameColor  = false;   // show only rows matching color of checked rows
    let _peekPopup     = null;   // currently visible SQL preview popup DOM element
    let _peekHideTimer = null;
    let _peekRec       = null;   // rec whose SQL is shown in _peekPopup
    let _peekPinned    = false;  // true = stays open until explicitly closed
    let _peekRowEl     = null;   // row element that has the is-peeked dashed border
    let _currentRecId  = null;  // id of the recording whose results are currently shown
    let _searchTerm    = '';    // current recording search filter

    // -------------------------------------------------------------------------
    // Public
    // -------------------------------------------------------------------------

    function init() {
        if (!Array.isArray(State.recordings))      State.recordings      = [];
        if (!Array.isArray(State.recordingGroups)) State.recordingGroups = [];
        if (State.recordingActive == null)         State.recordingActive = true;

        _panel = document.getElementById('recordings-panel');

        document.getElementById('btn-recordings-toggle')
            ?.addEventListener('click', toggle);
        document.getElementById('btn-recordings-toggle')
            ?.addEventListener('contextmenu', e => { e.preventDefault(); toggleRecord(); });
        document.getElementById('btn-recordings-close')
            ?.addEventListener('click', () => { _visible = true; toggle(); });
        document.getElementById('btn-rec-record')
            ?.addEventListener('click', toggleRecord);
        document.getElementById('btn-save-view-state')
            ?.addEventListener('click', _saveViewState);
        document.getElementById('rec-search-input')
            ?.addEventListener('input', e => { _searchTerm = e.target.value.trim(); _filterRecordingList(); });
        document.getElementById('rec-search-input')
            ?.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } });
        document.getElementById('btn-rec-delete-selected')
            ?.addEventListener('click', _deleteSelected);
        document.getElementById('btn-rec-add-group')
            ?.addEventListener('click', _createGroup);
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
        _makeResizable(_panel);

        _updateBadges();
    }

    function toggle() {
        _visible = !_visible;
        _panel?.classList.toggle('hidden', !_visible);
        document.getElementById('btn-recordings-toggle')
            ?.classList.toggle('is-active', _visible);
        if (_visible) {
            _applyPanelSize(_panel);
            _searchTerm = '';
            const srch = document.getElementById('rec-search-input');
            if (srch) srch.value = '';
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
            id:           _newId('rec'),
            seq:          nextSeq,
            timestamp:    Date.now(),
            name:         null,
            fromRunQuery: !!result._fromRunQuery,
            sql:          result.sql || document.getElementById('sql-preview-text')?.textContent || '',
            results: {
                cols:       (result.cols       || []).slice(),
                rows:       (result.rows       || []).map(r => r.slice()),
                col_tables: (result.col_tables || []).slice(),
                col_types:  (result.col_types  || []).slice(),
                count:      result.count ?? result.rows?.length ?? 0,
                // Rendering context — used by _loadResults so header labels match
                // what was shown when the recording was made, regardless of current State.
                selectSchemaAlias: State.selectSchemaAlias ?? true,
                selectAliases:     JSON.parse(JSON.stringify(State.selectAliases || {})),
                selectSortAlpha:   State.selectSortAlpha   ?? false,
                columnOrder:       (State.columnOrder || []).slice(),
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

        setCurrentRec(entry.id);
        _updateBadges();
        if (_visible) _renderList();
    }

    /**
     * Set which recording is the source of the current results table.
     * Pass null to clear (no associated recording).
     * Shows/hides the Save-state button and refreshes the list highlight.
     */
    function setCurrentRec(id) {
        _currentRecId = id;
        const btn = document.getElementById('btn-save-view-state');
        if (btn) btn.classList.toggle('hidden', id === null);
        if (_visible) _renderList();
    }

    /**
     * Capture the current results-table visual state and attach it to the
     * recording that is currently being displayed (_currentRecId).
     */
    async function _saveViewState() {
        if (!_currentRecId) return;
        const rec = (State.recordings || []).find(r => r.id === _currentRecId);
        if (!rec) return;
        if (typeof Results === 'undefined') return;
        if (rec.viewState) {
            const ok = await Dialog.confirm('This recording already has a saved visual state. Overwrite it?');
            if (!ok) return;
        }
        rec.viewState = Results.captureViewState();
        App.notify?.('Visual state saved to recording.', 'info');
        if (_visible) _renderList();
    }

    /**
     * Replace an existing recording's data with the current query result, island
     * config, and visual state — preserving the recording's label, color, and position.
     */
    async function _replaceWithCurrent(rec) {
        const label = rec.name || _fmtTs(rec.timestamp);
        if (!await Dialog.confirm(`Replace "${label}" with the current result?\n\nThe label will be kept.`)) return;

        const lastResult = typeof Results !== 'undefined' ? Results.getLastResult?.() : null;
        if (!lastResult?.cols) {
            App.notify?.('No current result to replace with.', 'warn');
            return;
        }

        App.flushCurrentIslandConfig?.();

        const islandKey = State.selectedIslandKey;
        if (!islandKey) {
            App.notify?.('No active island to capture.', 'warn');
            return;
        }

        const islandTableIds = new Set(islandKey.split('|'));
        const tables = State.tables
            .filter(t => islandTableIds.has(t.id))
            .map(t => JSON.parse(JSON.stringify(t)));
        const joins = State.joins
            .filter(j => islandTableIds.has(j.fromTableId) && islandTableIds.has(j.toTableId))
            .map(j => JSON.parse(JSON.stringify(j)));
        const islandConfig = JSON.parse(JSON.stringify(State.islandConfigs?.[islandKey] ?? {}));

        // Overwrite data — keep: name, id, seq, color, groupId, timestamp
        rec.sql     = lastResult.sql || document.getElementById('sql-preview-text')?.textContent || '';
        rec.results = {
            cols:       (lastResult.cols       || []).slice(),
            rows:       (lastResult.rows       || []).map(r => r.slice()),
            col_tables: (lastResult.col_tables || []).slice(),
            col_types:  (lastResult.col_types  || []).slice(),
            count:      lastResult.count ?? lastResult.rows?.length ?? 0,
            selectSchemaAlias: State.selectSchemaAlias ?? true,
            selectAliases:     JSON.parse(JSON.stringify(State.selectAliases || {})),
            selectSortAlpha:   State.selectSortAlpha   ?? false,
            columnOrder:       (State.columnOrder || []).slice(),
        };
        rec.island = {
            key:    islandKey,
            tables,
            joins,
            config: islandConfig,
            name:   State.islandNames?.[islandKey]  ?? null,
            color:  State.islandColors?.[islandKey] ?? null,
        };
        rec.viewState    = Results.captureViewState?.() ?? null;
        rec.fromRunQuery = !!lastResult._fromRunQuery;

        App.notify?.(`"${label}" replaced with current result.`, 'success');
        _renderList();
    }

    /** Resync badges and list after a context load. */
    function refresh() {
        if (!Array.isArray(State.recordings))      State.recordings      = [];
        if (!Array.isArray(State.recordingGroups)) State.recordingGroups = [];
        if (State.recordingActive == null)         State.recordingActive = true;
        _updateBadges();
        if (_visible) _renderList();
    }

    // -------------------------------------------------------------------------
    // SQL peek popup (Alt+hover / Alt+click on recording rows)
    // -------------------------------------------------------------------------

    function _openPeekPopup(rec, mouseX, mouseY, pin) {
        clearTimeout(_peekHideTimer);

        // If a pinned popup is open and we're not explicitly pinning a new one → ignore
        if (_peekPinned && !pin) return;

        // Alt+click on already-pinned row → unpin and close
        if (pin && _peekPinned && _peekRec === rec) {
            _closePeekPopup();
            return;
        }

        // Already showing for this exact rec and not pinning → just reposition
        if (_peekPopup && _peekRec === rec && !pin) {
            _positionPeekPopup(mouseX, mouseY);
            return;
        }

        // Close whatever was open before building a fresh popup
        _closePeekPopup();

        const popup = document.createElement('div');
        popup.className = 'rec-sql-preview-popup';

        // Header row
        const header = document.createElement('div');
        header.className = 'rec-sql-preview-header';

        const dragHandle = document.createElement('span');
        dragHandle.className = 'rec-sql-preview-drag';
        header.appendChild(dragHandle);

        const closeBtn = document.createElement('button');
        closeBtn.className   = 'rec-sql-preview-close';
        closeBtn.textContent = '✕';
        closeBtn.title       = 'Close preview';
        closeBtn.addEventListener('click', e => { e.stopPropagation(); _closePeekPopup(); });
        header.appendChild(closeBtn);
        popup.appendChild(header);

        // Drag: switch to left-based positioning on first drag so coordinates are stable
        header.addEventListener('mousedown', e => {
            if (e.target === closeBtn) return;
            e.preventDefault();
            const pr = popup.getBoundingClientRect();
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

        _peekPopup  = popup;
        _peekRec    = rec;
        _peekPinned = !!pin;
        if (pin) {
            _peekRowEl = document.querySelector(`#recordings-list .rec-entry[data-id="${rec.id}"]`);
            if (_peekRowEl) _peekRowEl.classList.add('is-peeked');
        }

        _positionPeekPopup(mouseX, mouseY);

        if (typeof SqlBackdrop !== 'undefined') SqlBackdrop.attach(ta);

        ta.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); _closePeekPopup(); }
        });

        // Hovering into the popup cancels any pending hide
        popup.addEventListener('mouseenter', () => clearTimeout(_peekHideTimer));
        popup.addEventListener('mouseleave', () => {
            if (_peekPinned) return;
            _peekHideTimer = setTimeout(_closePeekPopup, 120);
        });

        // Clicking inside the popup body (not close btn) pins it
        popup.addEventListener('click', e => {
            if (e.target === closeBtn) return;
            _peekPinned = true;
        });
    }

    function _closePeekPopup() {
        clearTimeout(_peekHideTimer);
        if (!_peekPopup) return;
        if (typeof SqlBackdrop !== 'undefined') {
            const ta = _peekPopup.querySelector('textarea');
            if (ta) SqlBackdrop.detach(ta);
        }
        _peekPopup.remove();
        _peekPopup  = null;
        _peekRec    = null;
        _peekPinned = false;
        if (_peekRowEl) { _peekRowEl.classList.remove('is-peeked'); _peekRowEl = null; }
    }

    function _positionPeekPopup(mouseX, mouseY) {
        if (!_peekPopup) return;
        _peekPopup.style.right = (window.innerWidth - mouseX + 30) + 'px';
        requestAnimationFrame(() => {
            if (!_peekPopup) return;
            const ph = _peekPopup.offsetHeight;
            let top = mouseY - ph / 2;
            top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
            _peekPopup.style.top = top + 'px';
        });
    }

    // -------------------------------------------------------------------------
    // List rendering
    // -------------------------------------------------------------------------

    /** Hide/show rendered rows based on the current search term. No re-render. */
    function _filterRecordingList() {
        const list = document.getElementById('recordings-list');
        if (!list) return;
        const term = _searchTerm.toLowerCase();

        list.querySelectorAll('.rec-entry').forEach(row => {
            const id  = row.dataset.id;
            const rec = (State.recordings || []).find(r => r.id === id);
            if (!rec) return;
            const name = (rec.name || _fmtTs(rec.timestamp)).toLowerCase();
            row.classList.toggle('hidden', term !== '' && !name.includes(term));
        });

        // Show/hide group headers: visible when the group name matches OR any member is visible
        list.querySelectorAll('.rec-group-header').forEach(hdr => {
            const gid   = hdr.dataset.groupId;
            const group = (State.recordingGroups || []).find(g => g.id === gid);
            const nameMatch = term === '' || (group?.name || '').toLowerCase().includes(term);
            const hasVis    = term === '' || [...list.querySelectorAll(`.rec-entry[data-group-id="${gid}"]`)]
                .some(r => !r.classList.contains('hidden'));
            hdr.classList.toggle('hidden', !nameMatch && !hasVis);
        });

        // Show/hide the "Ungrouped" separator when there are visible ungrouped rows
        const ugSep = list.querySelector('.rec-ungroup-sep');
        if (ugSep) {
            const hasVisUngrouped = [...list.querySelectorAll('.rec-entry[data-group-id=""]')]
                .some(r => !r.classList.contains('hidden'));
            ugSep.classList.toggle('rec-ungroup-sep--empty', !hasVisUngrouped);
        }
    }

    function _renderList() {
        const list = document.getElementById('recordings-list');
        if (!list) return;

        // Snapshot checked IDs BEFORE wiping the DOM
        const checkedIds = new Set(
            [...list.querySelectorAll('.rec-entry-chk:checked')]
                .map(c => c.closest('.rec-entry')?.dataset.id).filter(Boolean)
        );

        // Close any open SQL preview — its row element is about to be destroyed
        _closePeekPopup();

        list.innerHTML = '';

        // reset select-all and action buttons
        const selAll = document.getElementById('chk-rec-select-all');
        if (selAll) selAll.checked = false;
        document.getElementById('btn-rec-delete-selected').disabled = true;
        document.getElementById('btn-rec-compare').disabled         = true;
        document.getElementById('btn-rec-dim').disabled             = true;
        document.getElementById('btn-rec-same-color').disabled      = true;

        if (!Array.isArray(State.recordingGroups)) State.recordingGroups = [];
        const allRecs   = State.recordings || [];
        const allGroups = State.recordingGroups;

        if (!allRecs.length && !allGroups.length) {
            list.innerHTML = '<div class="rec-empty">No recordings yet. Run a query while recording is active.</div>';
            return;
        }

        // --- compute visible set based on filter modes ---
        const validCheckedRecs = allRecs.filter(r => checkedIds.has(r.id));
        let recs = allRecs;
        if (_dimMode) {
            if (validCheckedRecs.length === 0) {
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
                _sameColor = false;
                document.getElementById('btn-rec-same-color')?.classList.remove('is-active');
            } else {
                recs = recs.filter(r => activeColors.has(r.color ?? null));
            }
        }

        const validGroupIds = new Set(allGroups.map(g => g.id));

        // --- Render groups then their contained recordings ---
        allGroups.forEach(group => {
            const allGroupRecs = allRecs.filter(r => r.groupId === group.id);
            const visGroupRecs = recs.filter(r => r.groupId === group.id);
            list.appendChild(_buildGroupHeader(group, allGroupRecs, list));
            if (!group.collapsed) {
                visGroupRecs.forEach(rec => list.appendChild(_buildRecEntry(rec, checkedIds, group.id, list)));
            }
        });

        // --- Ungrouped separator (drop zone) — only when groups exist ---
        if (allGroups.length) {
            const ugSep = document.createElement('div');
            ugSep.className       = 'rec-ungroup-sep';
            ugSep.textContent     = 'Ungrouped';
            ugSep.dataset.isUngroupZone = '1';
            ugSep.addEventListener('dragover', e => {
                if (!_dragId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                ugSep.classList.add('rec-ungroup-sep--active');
            });
            ugSep.addEventListener('dragleave', e => {
                if (!ugSep.contains(e.relatedTarget)) ugSep.classList.remove('rec-ungroup-sep--active');
            });
            ugSep.addEventListener('drop', e => {
                e.preventDefault();
                ugSep.classList.remove('rec-ungroup-sep--active');
                if (!_dragId) return;
                const moved = State.recordings.find(r => r.id === _dragId);
                if (moved) { delete moved.groupId; _renderList(); }
            });
            list.appendChild(ugSep);
        }

        // --- Render ungrouped recordings ---
        const ungrouped = recs.filter(r => !r.groupId || !validGroupIds.has(r.groupId));
        ungrouped.forEach(rec => list.appendChild(_buildRecEntry(rec, checkedIds, null, list)));

        // Recompute button states — no re-render (we're already inside _renderList)
        _updateHeaderButtons(false);

        // Apply active search filter to freshly rendered rows
        _filterRecordingList();

        // Sync select-all checkbox: check it iff every visible row is checked
        const allVisibleChks = [...list.querySelectorAll('.rec-entry-chk')];
        const selAllEl = document.getElementById('chk-rec-select-all');
        if (selAllEl) {
            selAllEl.checked = allVisibleChks.length > 0 && allVisibleChks.every(c => c.checked);
        }
    }

    // -------------------------------------------------------------------------
    // Build a single recording row element
    // -------------------------------------------------------------------------

    function _buildRecEntry(rec, checkedIds, groupId, list) {
        const row = document.createElement('div');
        row.className      = 'rec-entry' +
            (rec.id === _currentRecId ? ' is-current-rec'   : '') +
            (groupId                  ? ' rec-entry--in-group' : '');
        row.dataset.id      = rec.id;
        row.dataset.groupId = groupId || '';
        row.draggable       = true;

        // Drag-and-drop handlers (recording reorder + cross-group move)
        row.addEventListener('dragstart', e => {
            _dragId      = rec.id;
            _dragGroupId = null;
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
            // Adopt the target's group context
            if (groupId) {
                moved.groupId = groupId;
            } else {
                delete moved.groupId;
            }
            _renderList();
        });

        // Seq number
        const seqEl = document.createElement('span');
        seqEl.className   = 'rec-entry-seq';
        seqEl.textContent = rec.seq ?? '';
        row.appendChild(seqEl);

        // Checkbox — restore checked state so filters & button states survive re-render
        const chk = document.createElement('input');
        chk.type      = 'checkbox';
        chk.checked   = checkedIds.has(rec.id);
        chk.className = 'rec-entry-chk';
        chk.addEventListener('change', _onCheckChange);
        chk.addEventListener('click', e => { if (e.altKey) { e.preventDefault(); _openPeekPopup(rec, e.clientX, e.clientY, true); } });
        row.appendChild(chk);

        // Name
        const nameWrap = document.createElement('span');
        nameWrap.className = 'rec-entry-name';

        const nameEl = document.createElement('span');
        nameEl.className   = 'rec-entry-name-text';
        nameEl.textContent = rec.name || _fmtTs(rec.timestamp);
        nameEl.addEventListener('click', e => { e.stopPropagation(); if (e.altKey) { _openPeekPopup(rec, e.clientX, e.clientY, true); return; } chk.checked = !chk.checked; _onCheckChange(); });
        nameWrap.appendChild(nameEl);

        if (rec.viewState) {
            const vsBadge     = document.createElement('span');
            vsBadge.className = 'rec-viewstate-badge';
            vsBadge.title     = 'Has saved visual state (Compare / Duplicates / colors / Dim)';
            vsBadge.textContent = '🎨';
            nameWrap.appendChild(vsBadge);
        }

        row.appendChild(nameWrap);

        // Single click anywhere on the row toggles the checkbox;
        // Alt+click opens/pins the SQL peek popup instead
        row.addEventListener('click', e => {
            if (e.altKey) { e.preventDefault(); _openPeekPopup(rec, e.clientX, e.clientY, true); return; }
            if (e.target === chk) return;
            if (e.target.closest('button, input')) return;
            chk.checked = !chk.checked;
            _onCheckChange();
        });

        // Alt+hover → show SQL peek; leaving row hides it (unless pinned)
        row.addEventListener('mouseenter', e => { if (!e.altKey || _peekPinned) return; _openPeekPopup(rec, e.clientX, e.clientY, false); });
        row.addEventListener('mousemove', e => {
            if (_peekPinned) return;
            if (e.altKey) { _openPeekPopup(rec, e.clientX, e.clientY, false); }
            else if (_peekRec === rec) { clearTimeout(_peekHideTimer); _peekHideTimer = setTimeout(_closePeekPopup, 120); }
        });
        row.addEventListener('mouseleave', () => {
            if (_peekPinned || _peekRec !== rec) return;
            clearTimeout(_peekHideTimer);
            _peekHideTimer = setTimeout(_closePeekPopup, 120);
        });

        // Right-click cycles through colors
        row.addEventListener('contextmenu', e => {
            e.preventDefault();
            const colors = (typeof Canvas !== 'undefined' && Canvas.CARD_COLORS) ? Canvas.CARD_COLORS.map(c => c.hex) : [];
            const currentIdx = colors.indexOf(rec.color ?? null);
            rec.color = currentIdx === -1 ? colors[0] : currentIdx === colors.length - 1 ? null : colors[currentIdx + 1];
            _applyEntryColor(row, colorBtn, rec.color);
            if (_sameColor) _renderList();
        });

        // Row count
        const badge = document.createElement('span');
        badge.className   = 'rec-entry-rowcount';
        badge.textContent = (rec.results?.count ?? rec.results?.rows?.length ?? '?') + ' rows';
        row.appendChild(badge);

        // Action buttons
        const actions   = document.createElement('div');
        actions.className = 'rec-entry-actions';

        const colorBtn    = document.createElement('button');
        colorBtn.className = 'rec-color-btn';
        colorBtn.title     = 'Set row color';
        _applyEntryColor(row, colorBtn, rec.color ?? null);
        colorBtn.addEventListener('click', e => { e.stopPropagation(); _openEntryColorPopup(rec, row, colorBtn); });
        actions.appendChild(colorBtn);

        const colorSep    = document.createElement('span');
        colorSep.className = 'rec-action-sep';
        actions.appendChild(colorSep);

        actions.appendChild(_btn('✎', 'Rename this recording', () => _startRename(rec.id, nameEl, rec)));

        const actionSep    = document.createElement('span');
        actionSep.className = 'rec-action-sep';
        actions.appendChild(actionSep);

        actions.appendChild(_btn('Results', 'Load results into table', () => _loadResults(rec)));
        actions.appendChild(_btn('SQL',     'View generated SQL',      () => _showSQL(rec)));

        // Island button + new-island checkbox are only meaningful when the recording
        // was produced by Run Query (right-panel filters → DB). CSV loads, custom
        // queries, EXPLAIN runs etc. don't carry a matching island config.
        // rec.fromRunQuery === undefined means an old recording → keep enabled for compat.
        const canUseIsland = rec.fromRunQuery !== false;

        const newIslChk     = document.createElement('input');
        newIslChk.type      = 'checkbox';
        newIslChk.checked   = _newIsland;
        newIslChk.title     = canUseIsland
            ? 'Restore in a new island instead of replacing the current one'
            : 'Not available — result was not produced by Run Query';
        newIslChk.className = 'rec-new-island-chk';
        newIslChk.disabled  = !canUseIsland;
        newIslChk.addEventListener('change', e => { _newIsland = e.target.checked; });
        actions.appendChild(newIslChk);

        const islBtn = _btn(
            'Island',
            canUseIsland
                ? 'Restore island config'
                : 'Not available — result was not produced by Run Query',
            canUseIsland ? () => _restoreIsland(rec) : null,
        );
        islBtn.disabled = !canUseIsland;
        actions.appendChild(islBtn);
        const replBtn = _btn('Replace', 'Replace this recording with the current result (keeps label)', () => _replaceWithCurrent(rec));
        replBtn.classList.add('rec-btn-replace');
        actions.appendChild(replBtn);
        const del = _btn('✕', 'Delete', () => _deleteEntry(rec.id));
        del.classList.add('rec-btn-del');
        actions.appendChild(del);
        row.appendChild(actions);

        return row;
    }

    // -------------------------------------------------------------------------
    // Build a group header row
    // -------------------------------------------------------------------------

    function _buildGroupHeader(group, allGroupRecs, list) {
        const hdr = document.createElement('div');
        hdr.className      = 'rec-group-header';
        hdr.dataset.groupId = group.id;
        hdr.draggable       = true;

        // Group drag — reorder groups
        hdr.addEventListener('dragstart', e => {
            if (e.target.tagName === 'INPUT') { e.preventDefault(); return; }
            _dragGroupId = group.id;
            _dragId      = null;
            e.dataTransfer.effectAllowed = 'move';
            requestAnimationFrame(() => hdr.classList.add('rec-group-header--dragging'));
        });
        hdr.addEventListener('dragend', () => {
            _dragGroupId = null;
            list.querySelectorAll('.rec-group-header--dragging, .rec-group-header--drag-over, .rec-group-header--drop-target')
                .forEach(el => el.classList.remove('rec-group-header--dragging', 'rec-group-header--drag-over', 'rec-group-header--drop-target'));
        });
        hdr.addEventListener('dragover', e => {
            e.preventDefault();
            if (_dragId) {
                // A recording being dragged → offer "move into this group"
                e.dataTransfer.dropEffect = 'move';
                list.querySelectorAll('.rec-group-header--drop-target')
                    .forEach(el => el.classList.remove('rec-group-header--drop-target'));
                hdr.classList.add('rec-group-header--drop-target');
            } else if (_dragGroupId && _dragGroupId !== group.id) {
                // Another group being dragged → offer reorder
                e.dataTransfer.dropEffect = 'move';
                list.querySelectorAll('.rec-group-header--drag-over')
                    .forEach(el => el.classList.remove('rec-group-header--drag-over'));
                hdr.classList.add('rec-group-header--drag-over');
            }
        });
        hdr.addEventListener('dragleave', e => {
            if (!hdr.contains(e.relatedTarget))
                hdr.classList.remove('rec-group-header--drop-target', 'rec-group-header--drag-over');
        });
        hdr.addEventListener('drop', e => {
            e.preventDefault();
            hdr.classList.remove('rec-group-header--drop-target', 'rec-group-header--drag-over');
            if (_dragId) {
                // Move recording into this group
                const moved = State.recordings.find(r => r.id === _dragId);
                if (moved) { moved.groupId = group.id; _renderList(); }
            } else if (_dragGroupId && _dragGroupId !== group.id) {
                // Reorder groups
                const fromIdx = (State.recordingGroups || []).findIndex(g => g.id === _dragGroupId);
                const toIdx   = (State.recordingGroups || []).findIndex(g => g.id === group.id);
                if (fromIdx !== -1 && toIdx !== -1) {
                    const [moved] = State.recordingGroups.splice(fromIdx, 1);
                    State.recordingGroups.splice(toIdx, 0, moved);
                    _renderList();
                }
            }
        });

        // Collapse / expand toggle
        const toggle     = document.createElement('span');
        toggle.className = 'rec-group-toggle';
        toggle.textContent = group.collapsed ? '▶' : '▼';
        toggle.title       = group.collapsed ? 'Expand group' : 'Collapse group';
        toggle.addEventListener('click', e => { e.stopPropagation(); group.collapsed = !group.collapsed; _renderList(); });
        hdr.appendChild(toggle);

        // Group name label
        const nameEl     = document.createElement('span');
        nameEl.className = 'rec-group-name';
        nameEl.textContent = group.name || 'Unnamed group';
        hdr.appendChild(nameEl);

        // Member count badge
        const countEl     = document.createElement('span');
        countEl.className = 'rec-group-count';
        countEl.textContent = `(${allGroupRecs.length})`;
        hdr.appendChild(countEl);

        // Rename button
        const renameBtn     = document.createElement('button');
        renameBtn.className = 'rec-group-btn';
        renameBtn.title     = 'Rename group';
        renameBtn.textContent = '✎';
        renameBtn.addEventListener('click', e => { e.stopPropagation(); _startGroupRename(group, nameEl, hdr); });
        hdr.appendChild(renameBtn);

        // Delete button
        const delBtn     = document.createElement('button');
        delBtn.className = 'rec-group-btn rec-group-btn--del';
        delBtn.title     = 'Delete group — recordings become ungrouped';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', async e => {
            e.stopPropagation();
            const n   = allGroupRecs.length;
            const msg = n
                ? `Delete group "${group.name || 'this group'}"? Its ${n} recording${n !== 1 ? 's' : ''} will also be deleted.`
                : `Delete group "${group.name || 'this group'}"?`;
            if (!await Dialog.confirm(msg)) return;
            const groupRecIds = new Set(allGroupRecs.map(r => r.id));
            State.recordings = (State.recordings || []).filter(r => !groupRecIds.has(r.id));
            State.recordingGroups = (State.recordingGroups || []).filter(g => g.id !== group.id);
            _renderList();
        });
        hdr.appendChild(delBtn);

        return hdr;
    }

    // -------------------------------------------------------------------------
    // Group lifecycle helpers
    // -------------------------------------------------------------------------

    function _createGroup() {
        if (!Array.isArray(State.recordingGroups)) State.recordingGroups = [];
        const group = { id: _newId('grp'), name: '', collapsed: false };
        State.recordingGroups.push(group);
        _renderList();
        // Immediately start inline rename on the freshly rendered group header
        const hdrEl  = document.querySelector(`[data-group-id="${group.id}"]`);
        const nameEl = hdrEl?.querySelector('.rec-group-name');
        if (nameEl && hdrEl) _startGroupRename(group, nameEl, hdrEl);
    }

    function _startGroupRename(group, nameEl, hdrEl) {
        const input     = document.createElement('input');
        input.type      = 'text';
        input.className = 'rec-rename-input';
        input.value     = group.name || '';
        input.placeholder = 'Group name…';
        nameEl.replaceWith(input);
        if (hdrEl) hdrEl.draggable = false;
        input.focus();
        input.select();

        const restore = () => { if (hdrEl) hdrEl.draggable = true; };
        const commit  = () => {
            const val  = input.value.trim();
            group.name = val || 'Group';
            nameEl.textContent = group.name;
            input.replaceWith(nameEl);
            restore();
        };
        input.addEventListener('blur',    commit);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter')  { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.replaceWith(nameEl); restore(); }
        });
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
        // Grab row before modifying the DOM — needed to toggle draggable
        const row = nameEl.closest('.rec-entry');

        const input = document.createElement('input');
        input.type      = 'text';
        input.className = 'rec-rename-input';
        input.value     = rec.name || _fmtTs(rec.timestamp);
        nameEl.replaceWith(input);
        input.focus();
        input.select();

        // Disable row drag while renaming so mouse-drag on text selects, not drags
        if (row) row.draggable = false;

        const restore = () => { if (row) row.draggable = true; };

        const commit = () => {
            const val = input.value.trim();
            rec.name = val || null;
            nameEl.textContent = rec.name || _fmtTs(rec.timestamp);
            input.replaceWith(nameEl);
            restore();
        };
        input.addEventListener('blur',    commit);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter')  { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.replaceWith(nameEl); restore(); }
        });
    }

    // -------------------------------------------------------------------------
    // Delete
    // -------------------------------------------------------------------------

    async function _deleteEntry(id) {
        if (!await Dialog.confirm('Delete this recording?')) return;
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
            // Saved rendering context — ensures header labels (alias prefix, sort order)
            // match what was shown when the recording was made, not the current canvas state.
            _replayTables:       rec.island?.tables || [],
            _replaySchemaAlias:  rec.results.selectSchemaAlias ?? true,
            _replayAliases:      rec.results.selectAliases     ?? {},
            _replaySortAlpha:    rec.results.selectSortAlpha   ?? false,
            _replayColumnOrder:  rec.results.columnOrder       ?? [],
        });
        if (rec.viewState) Results.applyViewState?.(rec.viewState);
        setCurrentRec(rec.id);
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
    // Drag & Resize
    // -------------------------------------------------------------------------

    function _savePanelSize(panel) {
        State.recPanelSize = {
            w: Math.round(panel.offsetWidth),
            h: Math.round(panel.offsetHeight),
        };
    }

    function _applyPanelSize(panel) {
        const s = State.recPanelSize;
        if (!s) return;
        if (s.w) { panel.style.width    = s.w + 'px'; panel.style.maxWidth  = 'none'; }
        if (s.h) { panel.style.height   = s.h + 'px'; panel.style.maxHeight = 'none'; }
    }

    function _pinPanelPosition(panel) {
        // Remove the initial centering transform if still active,
        // so style.left/top map 1:1 to screen coordinates.
        if (panel.style.transform !== 'none') {
            const r = panel.getBoundingClientRect();
            panel.style.left      = r.left + 'px';
            panel.style.top       = r.top  + 'px';
            panel.style.right     = 'auto';
            panel.style.bottom    = 'auto';
            panel.style.transform = 'none';
        }
    }

    function _makeResizable(panel) {
        const MIN_W = 340, MIN_H = 180;

        [
            { cls: 'rec-resize-e',  dirE: true,  dirS: false },
            { cls: 'rec-resize-s',  dirE: false, dirS: true  },
            { cls: 'rec-resize-se', dirE: true,  dirS: true  },
        ].forEach(({ cls, dirE, dirS }) => {
            const el = document.createElement('div');
            el.className = `rec-resize-handle ${cls}`;
            panel.appendChild(el);

            el.addEventListener('mousedown', e => {
                e.preventDefault();
                e.stopPropagation();

                _pinPanelPosition(panel);

                const startX = e.clientX;
                const startY = e.clientY;
                const startW = panel.offsetWidth;
                const startH = panel.offsetHeight;

                const onMove = ev => {
                    if (dirE) {
                        const w = Math.max(MIN_W, startW + (ev.clientX - startX));
                        panel.style.width    = w + 'px';
                        panel.style.maxWidth = 'none';
                    }
                    if (dirS) {
                        const h = Math.max(MIN_H, startH + (ev.clientY - startY));
                        panel.style.height    = h + 'px';
                        panel.style.maxHeight = 'none';
                    }
                };
                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup',   onUp);
                    _savePanelSize(panel);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup',   onUp);
            });
        });
    }

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
    return { init, toggle, toggleRecord, onQuerySuccess, refresh, setCurrentRec, getCurrentRecId: () => _currentRecId };
})();
