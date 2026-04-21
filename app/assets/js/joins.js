/**
 * joins.js — Visual join lines and column-to-column drag
 *
 * Phase 4:
 *   - Column-to-column drag creates joins (mouse-based, not HTML5 DnD)
 *   - Draws a live dashed SVG line while dragging
 *   - On valid drop (different table): creates a join, renders a bezier curve
 *   - Click a join path or label to open the join editor modal
 *   - Redraws join lines in-place when cards are repositioned
 *   - Rebuilds all join lines from State (used by Load Context)
 *
 * Depends on (runtime): State, App  — defined in app.js
 * Load order: api.js → profiles.js → app.js → canvas.js → joins.js
 */

const Joins = (() => {

    // =========================================================================
    // Column drag state — one global object (mirrors pattern in canvas.js)
    // =========================================================================
    const _drag = {
        active:      false,
        fromTableId: null,
        fromCol:     null,
        lineEl:      null,       // temporary <line> SVG element
        sourceColEl: null,       // source <li> for class cleanup
    };

    // Join ID currently open in the editor modal
    let _editingJoinId = null;

    // Singleton color popup for inline join color selection
    let _joinColorPopup     = null;
    let _joinColorPopupJoin = null;

    // Palette for distinguishing multiple joins between the same table pair.
    // Colors are chosen to be visually distinct on dark backgrounds.
    const _PAIR_COLORS = [
        '#7eb8f7', // blue
        '#f6a623', // amber
        '#a67cf4', // purple
        '#4fd1a5', // teal
        '#f47c7c', // coral
        '#f0d060', // yellow
        '#74d680', // green
        '#f78fb3', // pink
    ];

    /** CSS scale on #canvas (overview zoom). SVG paths use logical coords → undo viewport scaling. */
    function _canvasContentScale() {
        return (typeof Canvas !== 'undefined' && Canvas.getContentScale)
            ? Canvas.getContentScale()
            : 1;
    }

    function _viewportDeltaToSvgUnits(d) {
        const s = _canvasContentScale();
        return d / s;
    }

    // =========================================================================
    // Init — bind all event handlers once on DOMContentLoaded
    // =========================================================================
    function init() {
        const canvasEl = document.getElementById('canvas');

        // Delegated mousedown on canvas catches column drag starts
        canvasEl.addEventListener('mousedown', _onColMousedown);

        // Prevent browser's HTML5 native drag-ghost on column rows;
        // we use mouse events instead so we can draw our own SVG line.
        canvasEl.addEventListener('dragstart', e => {
            if (e.target.closest('.table-card__col')) e.preventDefault();
        });

        // Global move / end — same pattern as canvas.js card drag
        document.addEventListener('mousemove', _onDragMove);
        document.addEventListener('mouseup',   _onDragEnd);

        // Join editor modal action buttons
        document.getElementById('btn-save-join')  .addEventListener('click', _saveJoin);
        document.getElementById('btn-delete-join').addEventListener('click', _deleteJoin);

    }

    // =========================================================================
    // Column drag — mousedown (start)
    // =========================================================================
    function _onColMousedown(e) {
        if (e.button !== 0) return;

        // Only start when pressing a column row (or one of its child spans)
        const colEl = e.target.closest('.table-card__col');
        if (!colEl) return;

        const tableId = colEl.dataset.tableId;
        const colName = colEl.dataset.col;
        if (!tableId || !colName) return;

        // Compute line-start at the right-midpoint of the column row (SVG coords)
        const start = _colRight(colEl);

        // Create the temporary dashed drag line inside the SVG layer
        const svg  = document.getElementById('join-lines');
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.classList.add('join-drag');
        line.setAttribute('x1', start.x);
        line.setAttribute('y1', start.y);
        line.setAttribute('x2', start.x);
        line.setAttribute('y2', start.y);
        svg.appendChild(line);

        // Source highlight
        colEl.classList.add('is-join-source');

        // Highlight the right config panel so drop zones are visually cued
        document.getElementById('config-panel').classList.add('is-col-drag');

        _drag.active      = true;
        _drag.fromTableId = tableId;
        _drag.fromCol     = colName;
        _drag.lineEl      = line;
        _drag.sourceColEl = colEl;

        e.preventDefault();   // no text-selection during drag
        e.stopPropagation();  // prevent card-header drag from triggering
    }

    // =========================================================================
    // Column drag — mousemove (update line end + highlight drop target)
    // =========================================================================
    function _onDragMove(e) {
        if (!_drag.active) return;

        const canvasRect = document.getElementById('canvas').getBoundingClientRect();
        _drag.lineEl.setAttribute('x2', _viewportDeltaToSvgUnits(e.clientX - canvasRect.left));
        _drag.lineEl.setAttribute('y2', _viewportDeltaToSvgUnits(e.clientY - canvasRect.top));

        // Highlight valid drop target; the drag line has pointer-events:none
        // so elementFromPoint sees through it to the column below.
        _clearDropTargets();
        _clearDragHover();
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const targetCol = el?.closest('.table-card__col');
        if (targetCol && targetCol.dataset.tableId !== _drag.fromTableId) {
            targetCol.classList.add('drop-target');
        }

        // Expand the specific drop zone the cursor is currently over
        const dropZone = el?.closest('.drop-zone[data-section]');
        if (dropZone && !dropZone.classList.contains('hidden')) {
            dropZone.classList.add('is-drag-hover');
        }
    }

    // =========================================================================
    // Column drag — mouseup (attempt to create a join)
    // =========================================================================
    function _onDragEnd(e) {
        if (!_drag.active) return;

        _drag.active = false;

        // Remove temporary drag line
        _drag.lineEl?.remove();
        _drag.lineEl = null;

        // Remove column highlights
        _drag.sourceColEl?.classList.remove('is-join-source');
        _drag.sourceColEl = null;
        _clearDropTargets();

        // Remove config panel and drop zone highlights
        document.getElementById('config-panel').classList.remove('is-col-drag');
        _clearDragHover();

        // Detect drop target
        const el        = document.elementFromPoint(e.clientX, e.clientY);
        const targetCol = el?.closest('.table-card__col');

        if (
            targetCol &&
            targetCol.dataset.tableId &&
            targetCol.dataset.col &&
            targetCol.dataset.tableId !== _drag.fromTableId
        ) {
            // Drop on a different table's column → create join
            _createJoin(
                _drag.fromTableId, _drag.fromCol,
                targetCol.dataset.tableId, targetCol.dataset.col
            );
        } else if (!targetCol) {
            // Not on a column — check if over a config-panel drop zone
            const zone = el?.closest('.drop-zone[data-section]');
            if (zone && typeof QueryPanel !== 'undefined') {
                QueryPanel.onColumnDrop(zone, _drag.fromTableId, _drag.fromCol);
            }
        }

        _drag.fromTableId = null;
        _drag.fromCol     = null;
    }

    // =========================================================================
    // Create a join entry in State and render it
    // =========================================================================
    function _createJoin(fromTableId, fromCol, toTableId, toCol) {
        // Prevent exact duplicate column-pair joins (either direction)
        const dup = State.joins.find(j =>
            (j.fromTableId === fromTableId && j.fromCol === fromCol &&
             j.toTableId   === toTableId   && j.toCol   === toCol)  ||
            (j.fromTableId === toTableId   && j.fromCol === toCol   &&
             j.toTableId   === fromTableId && j.toCol   === fromCol)
        );
        if (dup) {
            App.notify('A join already exists between these columns.', 'warn');
            return;
        }

        // Detect cross-island join before adding it
        const enabledJoinsBefore = State.joins.filter(j => j.enabled !== false);
        const islandsBefore      = App.computeIslands(State.tables, enabledJoinsBefore);
        const fromIslandBefore   = islandsBefore.find(g => g.includes(fromTableId));
        const toIslandBefore     = islandsBefore.find(g => g.includes(toTableId));
        const isMerge            = fromIslandBefore && toIslandBefore && fromIslandBefore !== toIslandBefore;

        // Flush the current island config before merging so _mergeIslandConfigs gets fresh data
        if (isMerge && typeof App !== 'undefined' && App.flushCurrentIslandConfig) {
            App.flushCurrentIslandConfig();
        }
        // Signal the destination island (join target) so _mergeIslandConfigs can
        // preserve its order numbers and offset the source island's numbers after them.
        if (isMerge) State._pendingMergeToTableId = toTableId;

        const join = {
            id:              'j_' + Date.now(),
            fromTableId,
            fromCol,
            toTableId,
            toCol,
            type:            'INNER',
            color:           null,
            enabled:         true,
            label:           '',
            note:            '',
            extraConditions: [],
        };

        if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
        State.joins.push(join);
        _renderJoin(join);
        _rerenderPairSiblings(join);
        _ensureJoinVisible(join); // deferred: moves "to" table if controls are hidden under a card
        if (typeof Islands !== 'undefined') {
            Islands.recompute();
            // If this join merged two islands, activate the new combined island.
            // We bypass Islands.selectIsland() here because its internal flush would
            // overwrite the freshly merged config: at this point selectedIslandKey is
            // null, so _currentIslandKey() resolves to the single merged island and
            // _flushCurrentIslandConfig() would clobber the merged config with the
            // stale live State (which still only has the previously-active island's columns).
            if (isMerge) {
                const enabledJoinsAfter = State.joins.filter(j => j.enabled !== false);
                const islandsAfter      = App.computeIslands(State.tables, enabledJoinsAfter);
                const mergedIsland      = islandsAfter.find(g => g.includes(fromTableId) && g.includes(toTableId));
                if (mergedIsland) {
                    const mergedKey = [...mergedIsland].sort().join('|');
                    State.selectedIslandKey = mergedKey;
                    App.blitIslandConfig(mergedKey);
                    Islands.recompute();
                    return; // blitIslandConfig → updateSQLPreview already called
                }
            }
        }
        App.updateSQLPreview();
    }

    // =========================================================================
    // Right-click on a join line → reposition the label group to the click point
    // =========================================================================
    function _onJoinLabelContextMenu(e, join) {
        e.preventDefault();
        e.stopPropagation();
        const ep = _computeEndpoints(join);
        if (!ep) return;
        const cvr    = document.getElementById('canvas').getBoundingClientRect();
        const clickX = _viewportDeltaToSvgUnits(e.clientX - cvr.left);
        const clickY = _viewportDeltaToSvgUnits(e.clientY - cvr.top);
        // Snapshot BEFORE the mutation so Ctrl+Z can revert to the previous position.
        if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
        // Offset is relative to the un-offset bezier midpoint so it stays meaningful
        // when either table is later moved.
        const baseMidX = (ep.x1 + ep.x2) / 2;
        const baseMidY = (ep.y1 + ep.y2) / 2 - 7;
        join.labelOffset = { dx: clickX - baseMidX, dy: clickY - baseMidY };
        _renderJoin(join);
        App.updateSQLPreview?.();
    }

    // =========================================================================
    // Render a single join (create or update SVG path + label in-place)
    // =========================================================================
    function _renderJoin(join) {
        const ep = _computeEndpoints(join);
        if (!ep) return; // cards not in DOM yet — safe during rebuildFromState

        const svg = document.getElementById('join-lines');

        // --- Bezier path ---
        let path = document.getElementById('jpath-' + join.id);
        if (!path) {
            path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.id = 'jpath-' + join.id;
            path.addEventListener('mousedown', e => {
                if (typeof Islands !== 'undefined') Islands.onJoinInteract(join);
            });
            path.addEventListener('click', e => { e.stopPropagation(); openEditor(join.id); });
            path.addEventListener('contextmenu', e => _onJoinLabelContextMenu(e, join));
            // Insert before any live drag line so the bezier stays beneath it
            const dragLine = svg.querySelector('line.join-drag');
            svg.insertBefore(path, dragLine || null);
        }
        // Refresh class every render (type may have changed since creation)
        const disabled    = join.enabled === false;
        const _extraConds = join.extraConditions ?? [];
        const _totalPairs = 1 + _extraConds.length;
        const hasExtra    = _extraConds.length > 0;
        path.setAttribute('class', `join-line join-line--${join.type}${disabled ? ' join-line--disabled' : ''}${hasExtra ? ' join-line--multi' : ''}`);
        path.setAttribute('d', _bezierPath(ep.x1, ep.y1, ep.x2, ep.y2));
        path.style.stroke      = join.color ?? _joinColor(join);
        path.style.strokeWidth = String(_totalPairs * 2);

        // Keep SVG <title> in sync for browser tooltip on hover
        let pathTitle = path.querySelector('title');
        if (!pathTitle) { pathTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title'); path.appendChild(pathTitle); }
        pathTitle.textContent = join.label ?? '';

        // --- Transparent wide hit-area path (makes the line easier to hover / click) ---
        let hitPath = document.getElementById('jhit-' + join.id);
        if (!hitPath) {
            hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            hitPath.id = 'jhit-' + join.id;
            hitPath.setAttribute('class', 'join-hit');
            hitPath.addEventListener('mousedown', e => {
                if (typeof Islands !== 'undefined') Islands.onJoinInteract(join);
            });
            hitPath.addEventListener('click', e => { e.stopPropagation(); openEditor(join.id); });
            hitPath.addEventListener('contextmenu', e => _onJoinLabelContextMenu(e, join));
            svg.insertBefore(hitPath, path); // sits just behind the visible path
        }
        hitPath.setAttribute('d', _bezierPath(ep.x1, ep.y1, ep.x2, ep.y2));

        // Keep hit path <title> in sync too
        let hitTitle = hitPath.querySelector('title');
        if (!hitTitle) { hitTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title'); hitPath.appendChild(hitTitle); }
        hitTitle.textContent = join.label ?? '';

        // --- Type label + delete button (SVG <g> at bezier midpoint) ---
        // labelOffset is optionally set by a right-click on the line to reposition the group.
        const midX = (ep.x1 + ep.x2) / 2 + (join.labelOffset?.dx ?? 0);
        const midY = (ep.y1 + ep.y2) / 2 - 7 + (join.labelOffset?.dy ?? 0);

        let group = document.getElementById('jlabel-' + join.id);
        if (!group) {
            group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            group.id = 'jlabel-' + join.id;

            // Enable/disable toggle — native checkbox via foreignObject
            const toggleFO = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
            toggleFO.setAttribute('class', 'join-toggle-fo');
            toggleFO.setAttribute('width', '14');
            toggleFO.setAttribute('height', '14');
            toggleFO.style.pointerEvents = 'all';
            const chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.style.cssText = 'width:13px;height:13px;cursor:pointer;margin:0;display:block;accent-color:var(--accent,#7eb8f7)';
            chk.addEventListener('mousedown', e => {
                if (typeof Islands !== 'undefined') Islands.onJoinInteract(join);
                e.stopPropagation();
            });
            chk.addEventListener('change', () => {
                if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                // Flush current island config before any topology change
                if (typeof App !== 'undefined' && App.flushCurrentIslandConfig) {
                    App.flushCurrentIslandConfig();
                }
                // If re-enabling will merge two separate islands, signal the destination
                // so _mergeIslandConfigs can normalize order numbers without duplicates.
                if (chk.checked && typeof App !== 'undefined') {
                    const _ejBefore  = State.joins.filter(j => j.enabled !== false);
                    const _islBefore = App.computeIslands(State.tables, _ejBefore);
                    const _fromIsl   = _islBefore.find(g => g.includes(join.fromTableId));
                    const _toIsl     = _islBefore.find(g => g.includes(join.toTableId));
                    if (_fromIsl && _toIsl && _fromIsl !== _toIsl) {
                        State._pendingMergeToTableId = join.toTableId;
                    }
                }
                join.enabled = chk.checked;
                _renderJoin(join);
                if (typeof Islands !== 'undefined') {
                    Islands.recompute();
                    if (chk.checked) {
                        // Enabling (merge): activate the new combined island.
                        // Same bypass as _createJoin to avoid stale-flush clobbering merged config.
                        const enabledJoinsAfter = State.joins.filter(j => j.enabled !== false);
                        const islandsAfter      = App.computeIslands(State.tables, enabledJoinsAfter);
                        const mergedIsland      = islandsAfter.find(g => g.includes(join.fromTableId) && g.includes(join.toTableId));
                        if (mergedIsland) {
                            const mergedKey = [...mergedIsland].sort().join('|');
                            State.selectedIslandKey = mergedKey;
                            App.blitIslandConfig(mergedKey);
                            Islands.recompute();
                        }
                    } else {
                        // Disabling (split): re-activate the last interacted island
                        if (State.selectedIslandKey === null) {
                            const enabledJoins = State.joins.filter(j => j.enabled !== false);
                            const islands      = App.computeIslands(State.tables, enabledJoins);
                            if (islands.length > 1) {
                                const hintId = State.lastInteractedTableId ?? join.fromTableId;
                                const target = islands.find(g => g.includes(hintId))
                                            ?? islands.find(g => g.includes(join.fromTableId));
                                if (target) Islands.selectIsland([...target].sort().join('|'));
                            }
                        }
                    }
                }
                App.updateSQLPreview();
            });
            toggleFO.appendChild(chk);
            group.appendChild(toggleFO);

            // Color dot circle
            const colorCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            colorCircle.setAttribute('class', 'join-color-dot');
            colorCircle.setAttribute('r', '5');
            colorCircle.addEventListener('mousedown', e => {
                if (typeof Islands !== 'undefined') Islands.onJoinInteract(join);
                e.stopPropagation();
            });
            colorCircle.addEventListener('click', e => {
                e.stopPropagation();
                _openJoinColorPopup(join, colorCircle);
            });
            group.appendChild(colorCircle);

            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('class', 'join-label');
            label.addEventListener('mousedown', () => {
                if (typeof Islands !== 'undefined') Islands.onJoinInteract(join);
            });
            label.addEventListener('click', e => { e.stopPropagation(); openEditor(join.id); });
            group.appendChild(label);

            const delBtn = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            delBtn.setAttribute('class', 'join-delete');
            delBtn.textContent = '✕';
            delBtn.addEventListener('click', e => { e.stopPropagation(); _deleteJoinDirect(join.id); });
            group.appendChild(delBtn);

            // Inline label input — foreignObject so we can use an HTML <input>
            const labelInputFO = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
            labelInputFO.setAttribute('class', 'join-label-input-fo');
            labelInputFO.setAttribute('width',  '140');
            labelInputFO.setAttribute('height', '20');
            labelInputFO.style.overflow      = 'visible';
            labelInputFO.style.pointerEvents = 'all';
            const labelInp = document.createElement('input');
            labelInp.type        = 'text';
            labelInp.className   = 'join-line-label-inp';
            labelInp.dataset.joinId = join.id;
            labelInp.placeholder = 'label…';
            labelInp.value       = join.label ?? '';
            labelInp.addEventListener('mousedown', e => {
                if (typeof Islands !== 'undefined') Islands.onJoinInteract(join);
                e.stopPropagation();
            });
            labelInp.addEventListener('focus', () => { if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot(); });
            labelInp.addEventListener('input', () => {
                join.label = labelInp.value;
                // Keep SVG <title> tooltips in sync
                const lv = labelInp.value;
                document.getElementById('jpath-' + join.id)?.querySelector('title')  && (document.getElementById('jpath-' + join.id).querySelector('title').textContent = lv);
                document.getElementById('jhit-'  + join.id)?.querySelector('title')  && (document.getElementById('jhit-'  + join.id).querySelector('title').textContent = lv);
            });
            labelInp.addEventListener('keydown', e => {
                if (e.shiftKey && e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    _openJoinLabelPopup(join, labelInp);
                } else if (e.key === 'Escape' || e.key === 'Enter') {
                    e.preventDefault();
                    labelInp.blur();
                }
            });
            labelInputFO.appendChild(labelInp);
            group.appendChild(labelInputFO);

            svg.appendChild(group);
        }

        const toggleFO     = group.querySelector('.join-toggle-fo');
        const chkEl        = toggleFO?.querySelector('input');
        const colorCircle  = group.querySelector('.join-color-dot');
        const label        = group.querySelector('.join-label');
        const delBtn       = group.querySelector('.join-delete');
        const labelInputFO = group.querySelector('.join-label-input-fo');
        const labelInp     = labelInputFO?.querySelector('input');

        // Position checkbox foreignObject (14×14, centered on midY-3)
        // and color dot to the left of the join-type label
        const _xPad = hasExtra ? 18 : 0;
        toggleFO.setAttribute('x', String(midX - 52 - _xPad));
        toggleFO.setAttribute('y', String(midY - 10));
        if (chkEl) chkEl.checked = join.enabled !== false;

        colorCircle.setAttribute('cx', String(midX - 28 - _xPad));
        colorCircle.setAttribute('cy', String(midY - 4));
        colorCircle.style.fill = join.color ?? _joinColor(join);

        label.setAttribute('x', midX);
        label.setAttribute('y', midY);
        label.textContent = _totalPairs > 1 ? `${join.type} +(${_totalPairs})` : join.type;
        delBtn.setAttribute('x', midX + 22 + _xPad);
        delBtn.setAttribute('y', midY);

        // Dim label, delete, and color dot for disabled joins; checkbox stays full opacity
        const dimOpacity = disabled ? '0.45' : '';
        label.style.opacity       = dimOpacity;
        delBtn.style.opacity      = dimOpacity;
        colorCircle.style.opacity = dimOpacity;
        group.style.opacity       = '';

        // Position inline label input below the type label row
        if (labelInputFO) {
            labelInputFO.setAttribute('x', String(midX - 70));
            labelInputFO.setAttribute('y', String(midY + 8));
        }
        // Sync value unless the input is currently focused (user is typing)
        if (labelInp) {
            labelInp.dataset.joinId = join.id;
            if (document.activeElement !== labelInp) {
                labelInp.value = join.label ?? '';
            }
        }

        // Mark joined column rows using the join's own color (primary + extra conditions)
        const _joinColColor = join.color ?? _joinColor(join);
        _markJoinedCol(join.fromTableId, join.fromCol, _joinColColor);
        _markJoinedCol(join.toTableId,   join.toCol,   _joinColColor);
        (join.extraConditions ?? []).forEach(ec => {
            _markJoinedCol(join.fromTableId, ec.fromCol, _joinColColor);
            _markJoinedCol(join.toTableId,   ec.toCol,   _joinColColor);
        });
    }

    // =========================================================================
    // Compute the SVG-coordinate endpoints for a join's bezier curve
    // =========================================================================
    function _computeEndpoints(join) {
        const fromEl = document.querySelector(
            `.table-card[data-table-id="${join.fromTableId}"] .table-card__col[data-col="${join.fromCol}"]`
        );
        const toEl = document.querySelector(
            `.table-card[data-table-id="${join.toTableId}"] .table-card__col[data-col="${join.toCol}"]`
        );
        if (!fromEl || !toEl) return null;

        const cvr = document.getElementById('canvas').getBoundingClientRect();
        const fr  = fromEl.getBoundingClientRect();
        const tr  = toEl.getBoundingClientRect();

        // Viewport deltas vs #canvas, then ÷ scale → SVG user units (matches table positions).
        // Y = vertical centre of each column row in SVG space
        const y1 = _viewportDeltaToSvgUnits(fr.top + fr.height / 2 - cvr.top);
        const y2 = _viewportDeltaToSvgUnits(tr.top + tr.height / 2 - cvr.top);

        // X = right or left edge of each card column depending on card positions
        const fromMid = _viewportDeltaToSvgUnits(fr.left + fr.width / 2 - cvr.left);
        const toMid   = _viewportDeltaToSvgUnits(tr.left + tr.width  / 2 - cvr.left);

        let x1, x2;
        if (fromMid <= toMid) {
            // from-card is further left → exit right edge, enter left edge
            x1 = _viewportDeltaToSvgUnits(fr.right - cvr.left);
            x2 = _viewportDeltaToSvgUnits(tr.left  - cvr.left);
        } else {
            // from-card is further right → exit left edge, enter right edge
            x1 = _viewportDeltaToSvgUnits(fr.left  - cvr.left);
            x2 = _viewportDeltaToSvgUnits(tr.right - cvr.left);
        }

        return { x1, y1, x2, y2 };
    }

    // =========================================================================
    // Build a cubic bezier SVG path string
    // =========================================================================
    function _bezierPath(x1, y1, x2, y2) {
        const dx = Math.abs(x2 - x1);
        const cx = Math.max(60, dx * 0.45);
        if (x1 <= x2) {
            return `M ${x1} ${y1} C ${x1+cx} ${y1} ${x2-cx} ${y2} ${x2} ${y2}`;
        } else {
            return `M ${x1} ${y1} C ${x1-cx} ${y1} ${x2+cx} ${y2} ${x2} ${y2}`;
        }
    }

    // =========================================================================
    // Redraw all joins that involve a given table
    // Called by canvas.js every mousemove while a card is being dragged.
    // =========================================================================
    function redrawForTable(tableId) {
        State.joins.forEach(join => {
            if (join.fromTableId === tableId || join.toTableId === tableId) {
                _renderJoin(join);
            }
        });
    }

    // =========================================================================
    // Remove SVG elements for all joins involving a table.
    // MUST be called by canvas.js BEFORE it prunes State.joins so we can read
    // the join list to find which IDs to remove.
    // =========================================================================
    function removeForTable(tableId) {
        State.joins
            .filter(j => j.fromTableId === tableId || j.toTableId === tableId)
            .forEach(j => _removeJoinEl(j.id));

        // Refresh column highlights after State.joins is pruned by the caller
        requestAnimationFrame(_refreshAllColumnHighlights);
    }

    // =========================================================================
    // Rebuild all join lines from a state snapshot (called by Canvas.rebuildFromState)
    // =========================================================================
    function rebuildFromState(state) {
        // Remove all existing join SVG elements (paths and label groups).
        // Must target the <g id="jlabel-*"> wrappers — not just the .join-label
        // text inside them — so that _renderJoin creates fresh children instead
        // of finding a half-emptied group and skipping child creation.
        const svg = document.getElementById('join-lines');
        svg.querySelectorAll('.join-line, .join-hit, [id^="jlabel-"]').forEach(el => el.remove());

        // Defer to next frame so card layout is computed before getBoundingClientRect
        requestAnimationFrame(() => {
            state.joins.forEach(j => _renderJoin(j));
            // Re-run island recompute so minimized-island visibility is applied to
            // the freshly-created join elements (Islands.recompute ran before this
            // frame, when the elements didn't exist yet).
            if (typeof Islands !== 'undefined') Islands.recompute();
        });
    }

    // =========================================================================
    // Open the join editor modal for a given join ID
    // (public — also proxied via Modals.openJoinEditor in app.js)
    // =========================================================================
    function openEditor(joinId) {
        const join = State.joins.find(j => j.id === joinId);
        if (!join) return;

        _editingJoinId = joinId;

        const fromTable = State.tables.find(t => t.id === join.fromTableId);
        const toTable   = State.tables.find(t => t.id === join.toTableId);
        const fromAlias = fromTable?.alias ?? '?';
        const toAlias   = toTable?.alias   ?? '?';
        const fromCols  = (fromTable?.columns ?? []).map(c => (typeof c === 'string' ? c : c.name));
        const toCols    = (toTable?.columns   ?? []).map(c => (typeof c === 'string' ? c : c.name));

        const labelText = (join.label ?? '').trim();
        document.getElementById('join-info').innerHTML =
            (labelText ? `<div class="join-info__label">${_esc(labelText)}</div>` : '') +
            `<span class="join-info__tables">${_esc(fromAlias)} ↔ ${_esc(toAlias)}</span>`;

        // Build condition rows
        const container = document.getElementById('join-conditions');
        container.innerHTML = '';

        const _makeColSelect = (cols, alias, selectedVal, cls) => {
            const sel = document.createElement('select');
            sel.className = cls;
            const colSet = new Set(cols);
            if (selectedVal && !colSet.has(selectedVal)) cols = [selectedVal, ...cols];
            cols.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c;
                opt.textContent = `${alias}.${c}`;
                if (c === selectedVal) opt.selected = true;
                sel.appendChild(opt);
            });
            return sel;
        };

        const _updateDeleteBtns = () => {
            const rows = container.querySelectorAll('.join-condition-row');
            rows.forEach(r => { r.querySelector('.join-cond-delete').disabled = rows.length <= 1; });
        };

        const _addConditionRow = (fromCol, toCol) => {
            const row = document.createElement('div');
            row.className = 'join-condition-row';
            row.appendChild(_makeColSelect(fromCols, fromAlias, fromCol, 'join-cond-from'));
            const eq = document.createElement('span');
            eq.className = 'join-cond-eq';
            eq.textContent = '=';
            row.appendChild(eq);
            row.appendChild(_makeColSelect(toCols, toAlias, toCol, 'join-cond-to'));
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'join-cond-delete';
            del.title = 'Remove condition';
            del.textContent = '✕';
            del.addEventListener('click', () => { row.remove(); _updateDeleteBtns(); });
            row.appendChild(del);
            container.appendChild(row);
        };

        _addConditionRow(join.fromCol, join.toCol);
        (join.extraConditions ?? []).forEach(ec => _addConditionRow(ec.fromCol, ec.toCol));
        _updateDeleteBtns();

        document.getElementById('btn-add-join-condition').onclick = () => {
            _addConditionRow(fromCols[0] ?? '', toCols[0] ?? '');
            _updateDeleteBtns();
        };

        document.getElementById('join-type-select').value = join.type;
        document.getElementById('modal-join').classList.remove('hidden');
    }

    // =========================================================================
    // Save join type change from editor
    // =========================================================================
    function _saveJoin() {
        if (!_editingJoinId) return;

        const join = State.joins.find(j => j.id === _editingJoinId);
        if (join) {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            join.type = document.getElementById('join-type-select').value;

            const rows = document.querySelectorAll('#join-conditions .join-condition-row');
            const conditions = Array.from(rows).map(r => ({
                fromCol: r.querySelector('.join-cond-from').value,
                toCol:   r.querySelector('.join-cond-to').value,
            }));
            if (conditions.length > 0) {
                join.fromCol         = conditions[0].fromCol;
                join.toCol           = conditions[0].toCol;
                join.extraConditions = conditions.slice(1);
            }

            _renderJoin(join);
            if (typeof Islands !== 'undefined') Islands.recompute();
            App.updateSQLPreview();
        }

        document.getElementById('modal-join').classList.add('hidden');
        _editingJoinId = null;
    }

    // =========================================================================
    // Delete join from editor
    // =========================================================================
    function _deleteJoin() {
        if (!_editingJoinId) return;
        _deleteJoinDirect(_editingJoinId);
        document.getElementById('modal-join').classList.add('hidden');
        _editingJoinId = null;
    }

    function _deleteJoinDirect(joinId) {
        if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
        // Flush the current island's live state (including calculus) before splitting,
        // so the merged island's config is fully up to date for a potential re-merge.
        if (typeof App !== 'undefined' && App.flushCurrentIslandConfig) {
            App.flushCurrentIslandConfig();
        }

        const join = State.joins.find(j => j.id === joinId);
        _removeJoinEl(joinId);
        State.joins = State.joins.filter(j => j.id !== joinId);
        if (join) _rerenderPairSiblings(join); // reindex colors after removal
        _refreshAllColumnHighlights();
        if (typeof Islands !== 'undefined') {
            Islands.recompute();
            // If the deletion split an island, selectedIslandKey is now null.
            // Re-activate the island that contains the last table the user touched.
            if (State.selectedIslandKey === null && join) {
                const enabledJoins = State.joins.filter(j => j.enabled !== false);
                const islands = App.computeIslands(State.tables, enabledJoins);
                if (islands.length > 1) {
                    const hintId = State.lastInteractedTableId ?? join.fromTableId;
                    const target = islands.find(g => g.includes(hintId))
                                ?? islands.find(g => g.includes(join.fromTableId));
                    if (target) Islands.selectIsland([...target].sort().join('|'));
                }
            }
        }
        App.updateSQLPreview();
    }

    // =========================================================================
    // Join inline color popup
    // =========================================================================
    function _openJoinColorPopup(join, anchorEl) {
        // Toggle: close if already open for this join
        if (_joinColorPopup && _joinColorPopupJoin === join) {
            _closeJoinColorPopup();
            return;
        }
        _closeJoinColorPopup();
        _joinColorPopupJoin = join;

        _joinColorPopup = document.createElement('div');
        _joinColorPopup.className = 'join-color-popup';

        // Color swatches
        const swatchWrap = document.createElement('div');
        swatchWrap.className = 'join-color-swatches';
        _PAIR_COLORS.forEach(hex => {
            const swatch = document.createElement('button');
            swatch.className = 'join-color-swatch';
            swatch.style.background = hex;
            if (join.color === hex) swatch.classList.add('is-active');
            swatch.addEventListener('click', e => {
                e.stopPropagation();
                if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                join.color = hex;
                _renderJoin(join);
                App.updateSQLPreview();
                _closeJoinColorPopup();
            });
            swatchWrap.appendChild(swatch);
        });

        // Auto reset button
        const resetBtn = document.createElement('button');
        resetBtn.className = 'join-color-reset';
        resetBtn.textContent = '✕ Auto color';
        resetBtn.addEventListener('click', e => {
            e.stopPropagation();
            join.color = null;
            _renderJoin(join);
            App.updateSQLPreview();
            _closeJoinColorPopup();
        });

        _joinColorPopup.appendChild(swatchWrap);
        _joinColorPopup.appendChild(resetBtn);
        document.body.appendChild(_joinColorPopup);

        // Position below the anchor SVG element
        const rect = anchorEl.getBoundingClientRect();
        const popW = 118;
        let left = rect.left + rect.width / 2 - popW / 2;
        let top  = rect.bottom + 6;
        if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
        if (left < 8) left = 8;
        _joinColorPopup.style.left = left + 'px';
        _joinColorPopup.style.top  = top  + 'px';

        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', _closeJoinColorPopup, { once: true });
        }, 0);
    }

    function _closeJoinColorPopup() {
        if (_joinColorPopup) {
            _joinColorPopup.remove();
            _joinColorPopup     = null;
            _joinColorPopupJoin = null;
        }
    }

    // =========================================================================
    // Join label popup — singleton textarea popup for editing join labels
    // Shift+Enter on inline input opens; Shift+Enter or Escape closes + refocuses.
    // Alt+T toggles maximize. No Explain/Run/HTML controls.
    // =========================================================================
    let _joinLabelPopup    = null;
    let _joinLabelPopupTA  = null;
    let _joinLabelOnClose  = null;

    function _ensureJoinLabelPopup() {
        if (_joinLabelPopup) return;

        _joinLabelPopup = document.createElement('div');
        _joinLabelPopup.className = 'join-label-popup';
        _joinLabelPopup.style.display = 'none';
        _joinLabelPopup.innerHTML = `
            <div class="join-label-popup-header">
                <span class="join-label-popup-title">EDIT JOIN NOTE</span>
                <button class="join-label-popup-close" title="Close">✕</button>
            </div>
            <textarea class="join-label-popup-ta" spellcheck="false" placeholder="Join label…"></textarea>`;
        document.body.appendChild(_joinLabelPopup);

        _joinLabelPopupTA = _joinLabelPopup.querySelector('.join-label-popup-ta');

        _joinLabelPopup.querySelector('.join-label-popup-close').addEventListener('click', _closeJoinLabelPopup);

        // Maximize/restore button
        const maxBtn = document.createElement('button');
        maxBtn.type      = 'button';
        maxBtn.className = 'btn-popup-maximize';
        maxBtn.textContent = '⤢';
        maxBtn.title = 'Maximize';
        maxBtn.addEventListener('click', () => App.toggleMaximizePopup?.(_joinLabelPopup));
        _joinLabelPopup.querySelector('.join-label-popup-close').before(maxBtn);

        // Draggable header
        const header = _joinLabelPopup.querySelector('.join-label-popup-header');
        header.addEventListener('mousedown', e => {
            if (e.target.closest('button')) return;
            const r = _joinLabelPopup.getBoundingClientRect();
            _joinLabelPopup.style.transform = 'none';
            _joinLabelPopup.style.left      = r.left + 'px';
            _joinLabelPopup.style.top       = r.top  + 'px';
            const ox = e.clientX - r.left;
            const oy = e.clientY - r.top;
            document.body.style.userSelect = 'none';
            function onMove(ev) {
                let x = ev.clientX - ox;
                let y = ev.clientY - oy;
                x = Math.max(0, Math.min(window.innerWidth  - _joinLabelPopup.offsetWidth,  x));
                y = Math.max(0, Math.min(window.innerHeight - _joinLabelPopup.offsetHeight, y));
                _joinLabelPopup.style.left = x + 'px';
                _joinLabelPopup.style.top  = y + 'px';
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

        // Close on outside click (ignore clicks on any inline join label input)
        document.addEventListener('mousedown', e => {
            if (_joinLabelPopup.style.display === 'none') return;
            if (_joinLabelPopup.contains(e.target)) return;
            if (e.target.classList.contains('join-line-label-inp')) return;
            _closeJoinLabelPopup();
        });

        // Keyboard: Escape or Shift+Enter → close; Alt+T → maximize
        document.addEventListener('keydown', e => {
            if (_joinLabelPopup.style.display === 'none') return;
            if (e.key === 'Escape' || (e.key === 'Enter' && e.shiftKey)) {
                e.preventDefault();
                _closeJoinLabelPopup();
            }
            if (e.altKey && e.code === 'KeyT') {
                e.preventDefault();
                App.toggleMaximizePopup?.(_joinLabelPopup);
            }
        });
    }

    function _openJoinLabelPopup(join, inlineInput) {
        _ensureJoinLabelPopup();
        _joinLabelOnClose = () => inlineInput.focus();
        _joinLabelPopupTA.value = join.note ?? '';

        // Only reset position when popup is currently hidden
        if (_joinLabelPopup.style.display === 'none') {
            _joinLabelPopup.style.left      = '';
            _joinLabelPopup.style.top       = '';
            _joinLabelPopup.style.transform = '';
        }
        _joinLabelPopup.style.display = 'flex';
        setTimeout(() => _joinLabelPopupTA.focus(), 0);

        // Popup edits join.note only — the inline input (join.label) is unaffected
        _joinLabelPopupTA.oninput = () => {
            join.note = _joinLabelPopupTA.value;
        };
    }

    function _closeJoinLabelPopup() {
        if (_joinLabelPopup) _joinLabelPopup.style.display = 'none';
        const cb = _joinLabelOnClose;
        _joinLabelOnClose = null;
        cb?.();
    }

    // =========================================================================
    // Private helpers
    // =========================================================================

    // =========================================================================
    // After creating a join, move the "to" table (if needed) so the join
    // controls (checkbox, type label, delete, label input) are not hidden under
    // a card. Then cascade to resolve any new table/island-rect overlaps.
    // =========================================================================
    function _ensureJoinVisible(join) {
        requestAnimationFrame(() => {
            const ep = _computeEndpoints(join);
            if (!ep) return;

            // Full controls bounding box (see _renderJoin for element positions)
            // label input: midX±70, midY+8 to midY+28
            // toggle FO  : midX-52, midY-10 (14px tall)
            const midX = (ep.x1 + ep.x2) / 2;
            const midY = (ep.y1 + ep.y2) / 2 - 7;
            const M = 14; // margin around controls
            const ctrl = {
                l: midX - 70 - M,
                t: midY - 10 - M,
                r: midX + 70 + M,
                b: midY + 28 + M,
            };

            // Check whether any table card covers the controls area
            const anyOverlap = State.tables.some(t => {
                const c = document.querySelector(`.table-card[data-table-id="${t.id}"]`);
                if (!c) return false;
                const cl = parseInt(c.style.left, 10) || 0;
                const ct = parseInt(c.style.top,  10) || 0;
                return cl < ctrl.r && cl + c.offsetWidth  > ctrl.l
                    && ct < ctrl.b && ct + c.offsetHeight > ctrl.t;
            });
            if (!anyOverlap) return;

            const fromCard = document.querySelector(`.table-card[data-table-id="${join.fromTableId}"]`);
            const toCard   = document.querySelector(`.table-card[data-table-id="${join.toTableId}"]`);
            if (!fromCard || !toCard) return;

            const fx  = parseInt(fromCard.style.left, 10) || 0;
            const fy  = parseInt(fromCard.style.top,  10) || 0;
            const fw  = fromCard.offsetWidth;
            const fh  = fromCard.offsetHeight;
            const tx  = parseInt(toCard.style.left,  10) || 0;
            const ty  = parseInt(toCard.style.top,   10) || 0;
            const tw  = toCard.offsetWidth;
            const th  = toCard.offsetHeight;
            const dcx = (tx + tw / 2) - (fx + fw / 2);
            const dcy = (ty + th / 2) - (fy + fh / 2);

            // Minimum gap needed so controls fit between the two card edges (+20px breathing room)
            const minHorizGap = (ctrl.r - ctrl.l) + 48; // ≈ 216 px
            const minVertGap  = (ctrl.b - ctrl.t) + 48; // ≈  114 px

            let newTx = tx, newTy = ty;
            if (Math.abs(dcx) >= Math.abs(dcy)) {
                // Primarily horizontal: push "to" left or right
                if (dcx >= 0) {
                    const needed = fx + fw + minHorizGap;
                    if (tx < needed) newTx = needed;
                } else {
                    const needed = fx - minHorizGap - tw;
                    if (tx > needed) newTx = needed;
                }
            } else {
                // Primarily vertical: push "to" up or down
                if (dcy >= 0) {
                    const needed = fy + fh + minVertGap;
                    if (ty < needed) newTy = needed;
                } else {
                    const needed = fy - minVertGap - th;
                    if (ty > needed) newTy = needed;
                }
            }
            newTx = Math.max(0, newTx);
            newTy = Math.max(0, newTy);
            if (newTx === tx && newTy === ty) return; // already had enough room

            // Apply move to "to" table
            toCard.style.left = newTx + 'px';
            toCard.style.top  = newTy + 'px';
            const toState = State.tables.find(t => t.id === join.toTableId);
            if (toState) toState.position = { x: newTx, y: newTy };

            // Redraw joins touching the moved table
            State.joins.forEach(j => {
                if (j.fromTableId === join.toTableId || j.toTableId === join.toTableId) _renderJoin(j);
            });

            // Cascade: push any tables now overlapping the moved table.
            // Protect both join endpoints from being re-moved by the cascade.
            _resolveOverlapsCascade(join.toTableId, new Set([join.fromTableId, join.toTableId]));

            if (typeof Islands !== 'undefined') Islands.redrawPositions();
        });
    }

    // Recursively push tables away from movedId until all table cards
    // (and their island rectangles) have sufficient clearance.
    function _resolveOverlapsCascade(movedId, visited) {
        // GAP_X/GAP_Y are large enough to also prevent island-rect overlap:
        //   horizontal: 2 × ISLAND_PADDING (28) = 56 → use 64
        //   vertical  : PADDING_TOP (52) + PADDING (28) = 80 → use 88
        const GAP_X = 64;
        const GAP_Y = 88;

        const movedCard = document.querySelector(`.table-card[data-table-id="${movedId}"]`);
        if (!movedCard) return;
        const mx  = parseInt(movedCard.style.left, 10) || 0;
        const my  = parseInt(movedCard.style.top,  10) || 0;
        const mw  = movedCard.offsetWidth;
        const mh  = movedCard.offsetHeight;
        const mcx = mx + mw / 2;
        const mcy = my + mh / 2;

        State.tables.forEach(t => {
            if (visited.has(t.id)) return;
            const card = document.querySelector(`.table-card[data-table-id="${t.id}"]`);
            if (!card) return;
            const tx  = parseInt(card.style.left, 10) || 0;
            const ty  = parseInt(card.style.top,  10) || 0;
            const tw  = card.offsetWidth;
            const th  = card.offsetHeight;
            const tcx = tx + tw / 2;
            const tcy = ty + th / 2;

            // Minimum center-to-center distance to be "clear" (includes gap)
            const minDX = mw / 2 + tw / 2 + GAP_X;
            const minDY = mh / 2 + th / 2 + GAP_Y;
            const adx   = Math.abs(tcx - mcx);
            const ady   = Math.abs(tcy - mcy);

            // Cards are clear if separated in at least one axis
            if (adx >= minDX || ady >= minDY) return;

            // Determine push axis by proportional penetration (larger ratio → that axis is tighter)
            const penX = (minDX - adx) / minDX;
            const penY = (minDY - ady) / minDY;

            let newX = tx, newY = ty;
            if (penX >= penY) {
                // Resolve horizontally
                newX = mcx <= tcx ? mx + mw + GAP_X : mx - tw - GAP_X;
            } else {
                // Resolve vertically
                newY = mcy <= tcy ? my + mh + GAP_Y : my - th - GAP_Y;
            }
            newX = Math.max(0, newX);
            newY = Math.max(0, newY);

            card.style.left = newX + 'px';
            card.style.top  = newY + 'px';
            const tbl = State.tables.find(tt => tt.id === t.id);
            if (tbl) tbl.position = { x: newX, y: newY };

            // Redraw joins for the displaced table
            State.joins.forEach(j => {
                if (j.fromTableId === t.id || j.toTableId === t.id) _renderJoin(j);
            });

            visited.add(t.id);
            _resolveOverlapsCascade(t.id, visited);
        });
    }

    /** Returns a stable color for a join based on its position within its table-pair group. */
    function _joinColor(join) {
        const colors = { INNER: '#4a9eff', LEFT: '#a78bfa', RIGHT: '#34d399', FULL: '#f0a050', CROSS: '#f05050' };
        return colors[join.type] ?? '#4a9eff';
    }

    /** Re-render all joins in the same table pair as the given join (updates colors after add/delete). */
    function _rerenderPairSiblings(join) {
        const pairKey = [join.fromTableId, join.toTableId].sort().join('|');
        State.joins.forEach(j => {
            if ([j.fromTableId, j.toTableId].sort().join('|') === pairKey && j.id !== join.id) {
                _renderJoin(j);
            }
        });
    }

    function _removeJoinEl(joinId) {
        document.getElementById('jpath-'  + joinId)?.remove();
        document.getElementById('jhit-'   + joinId)?.remove();
        document.getElementById('jlabel-' + joinId)?.remove();
    }

    function _markJoinedCol(tableId, colName, color) {
        const el = document.querySelector(
            `.table-card[data-table-id="${tableId}"] .table-card__col[data-col="${colName}"]`
        );
        if (!el) return;
        el.classList.add('is-joined');
        if (color) el.style.setProperty('--join-col-color', color);
    }

    function _refreshAllColumnHighlights() {
        document.querySelectorAll('.table-card__col.is-joined').forEach(el => {
            el.classList.remove('is-joined');
            el.style.removeProperty('--join-col-color');
        });
        State.joins.forEach(j => {
            const color = j.color ?? _joinColor(j);
            _markJoinedCol(j.fromTableId, j.fromCol, color);
            _markJoinedCol(j.toTableId,   j.toCol,   color);
            (j.extraConditions ?? []).forEach(ec => {
                _markJoinedCol(j.fromTableId, ec.fromCol, color);
                _markJoinedCol(j.toTableId,   ec.toCol,   color);
            });
        });
    }

    function _clearDropTargets() {
        document.querySelectorAll('.table-card__col.drop-target')
                .forEach(el => el.classList.remove('drop-target'));
    }

    function _clearDragHover() {
        document.querySelectorAll('.drop-zone.is-drag-hover')
                .forEach(el => el.classList.remove('is-drag-hover'));
    }

    /** Right-midpoint of a column row in SVG (canvas) coordinates */
    function _colRight(colEl) {
        const cr  = colEl.getBoundingClientRect();
        const cvr = document.getElementById('canvas').getBoundingClientRect();
        return {
            x: _viewportDeltaToSvgUnits(cr.right - cvr.left),
            y: _viewportDeltaToSvgUnits(cr.top + cr.height / 2 - cvr.top),
        };
    }

    function _esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // =========================================================================
    // Public surface
    // =========================================================================
    return {
        init,
        redrawForTable,
        rebuildFromState,
        removeForTable,
        openEditor,
        deleteJoin: _deleteJoinDirect,
    };

})();

// Initialise join handlers as soon as the DOM is ready
document.addEventListener('DOMContentLoaded', () => Joins.init());
