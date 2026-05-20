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
        document.getElementById('btn-rec-delete-all')
            ?.addEventListener('click', _deleteAll);
        document.getElementById('btn-rec-delete-selected')
            ?.addEventListener('click', _deleteSelected);
        document.getElementById('btn-rec-compare')
            ?.addEventListener('click', _compareSelected);
        document.getElementById('chk-rec-select-all')
            ?.addEventListener('change', e => _selectAll(e.target.checked));

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
        if (_visible) _renderList();
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
        list.innerHTML = '';

        // reset select-all and action buttons
        const selAll = document.getElementById('chk-rec-select-all');
        if (selAll) selAll.checked = false;
        document.getElementById('btn-rec-delete-selected').disabled = true;
        document.getElementById('btn-rec-compare').disabled         = true;

        const recs = State.recordings || [];
        if (!recs.length) {
            list.innerHTML = '<div class="rec-empty">No recordings yet. Run a query while recording is active.</div>';
            return;
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

            // Checkbox
            const chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.className = 'rec-entry-chk';
            chk.addEventListener('change', _onCheckChange);
            row.appendChild(chk);

            // Name (click to rename)
            const nameEl = document.createElement('span');
            nameEl.className = 'rec-entry-name';
            nameEl.textContent = rec.name || _fmtTs(rec.timestamp);
            nameEl.title = 'Click to rename';
            nameEl.addEventListener('click', () => _startRename(rec.id, nameEl, rec));
            row.appendChild(nameEl);

            // Row count
            const badge = document.createElement('span');
            badge.className = 'rec-entry-rowcount';
            badge.textContent = (rec.results?.count ?? rec.results?.rows?.length ?? '?') + ' rows';
            row.appendChild(badge);

            // Action buttons
            const actions = document.createElement('div');
            actions.className = 'rec-entry-actions';
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

    function _deleteSelected() {
        const ids = new Set(
            [...document.querySelectorAll('.rec-entry-chk:checked')]
                .map(c => c.closest('.rec-entry')?.dataset.id)
                .filter(Boolean)
        );
        State.recordings = (State.recordings || []).filter(r => !ids.has(r.id));
        _updateBadges();
        _renderList();
    }

    function _deleteAll() {
        const n = (State.recordings || []).length;
        if (!n) return;
        if (!confirm(`Delete all ${n} recording${n !== 1 ? 's' : ''}?`)) return;
        State.recordings = [];
        _updateBadges();
        _renderList();
    }

    function _selectAll(checked) {
        document.querySelectorAll('.rec-entry-chk').forEach(c => { c.checked = checked; });
        _onCheckChange();
    }

    function _onCheckChange() {
        const checked = document.querySelectorAll('.rec-entry-chk:checked');
        document.getElementById('btn-rec-delete-selected').disabled = checked.length === 0;
        document.getElementById('btn-rec-compare').disabled         = checked.length !== 2;
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
