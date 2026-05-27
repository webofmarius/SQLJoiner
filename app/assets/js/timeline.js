/**
 * Timeline — cross-recording row annotation and visual sequencing.
 *
 * Cmd/Ctrl+click any results cell → snapshot that row into the timeline.
 * Each entry remembers which recording it came from, the full row, and which
 * cell triggered it.  Two views:
 *   • List   — compact rows with inline peek and editable labels.
 *   • Visual — horizontal axis, entries as tick marks, grouped by brackets.
 *
 * Public API:
 *   Timeline.init()
 *   Timeline.toggle()
 *   Timeline.addEntry(recId, recName, recColor, rowData, colName, colValue)
 *   Timeline.refresh()          — call after applyContext to re-render
 */
const Timeline = (() => {

    // -------------------------------------------------------------------------
    // Module-level vars
    // -------------------------------------------------------------------------
    let _visible  = false;
    let _viewMode = 'list';   // 'list' | 'visual'
    let _panel, _listEl, _visualEl;
    let _idSeq = 0;

    // Floating peek popup in visual mode
    let _tickPeekEl = null;

    // Floating group-management popup
    let _groupPopup = null;

    // Floating per-entry color picker
    let _colorPickerEl = null;

    // Multi-track mode (visual view only)
    let _multiTrackMode = false;

    // Zoom level for visual / multi-track canvas (1.0 = 100%)
    let _zoomLevel = 1.0;
    const _ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0, 8.0];

    // Saved timelines popup
    let _savedPopup             = null;
    let _savedPopupOutsideClick = null;
    const _ENTRY_PALETTE = [
        '#f87171','#fb923c','#fbbf24','#a3e635',
        '#34d399','#22d3ee','#60a5fa','#818cf8',
        '#a78bfa','#f472b6','#e2e8f0','#94a3b8',
    ];

    // Maximize state (same pattern as Calculus toolbox)
    let _preMaxStyles       = null;   // snapshot of inline styles before maximize
    let _maxResizeObserver  = null;
    let _maxResizeWinListener = null;

    // Auto-color palette for recordings that have no color set
    const _AUTO_COLORS = [
        '#4a9eff','#f87171','#34d399','#fbbf24','#a78bfa',
        '#fb923c','#60a5fa','#f472b6','#2dd4bf','#e879f9',
    ];
    const _recColorMap = {};
    let   _autoColorIdx = 0;

    // -------------------------------------------------------------------------
    // State helpers
    // -------------------------------------------------------------------------
    function _emptyState() {
        return { entries: [], groups: [], panelSize: null };
    }
    /** Always returns (and ensures) State.timeline. */
    function _st() {
        if (!State.timeline || Array.isArray(State.timeline)) {
            State.timeline = _emptyState();
        }
        return State.timeline;
    }

    /** Always returns (and ensures) State.savedTimelines array. */
    function _savedTimelines() {
        if (!Array.isArray(State.savedTimelines)) State.savedTimelines = [];
        return State.savedTimelines;
    }

    function _newStlId() {
        return `stl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    }

    function _newStlGroupId() {
        return `stlg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    }

    function _savedTimelineGroups() {
        if (!Array.isArray(State.savedTimelineGroups)) State.savedTimelineGroups = [];
        return State.savedTimelineGroups;
    }

    // -------------------------------------------------------------------------
    // Init
    // -------------------------------------------------------------------------
    function init() {
        _panel   = document.getElementById('timeline-panel');
        _listEl  = document.getElementById('timeline-list');
        _visualEl= document.getElementById('timeline-visual');

        document.getElementById('btn-timeline-toggle')
            ?.addEventListener('click', toggle);
        document.getElementById('btn-timeline-close')
            ?.addEventListener('click', toggle);
        document.getElementById('btn-timeline-view-list')
            ?.addEventListener('click', () => _setView('list'));
        document.getElementById('btn-timeline-view-visual')
            ?.addEventListener('click', () => _setView('visual'));
        document.getElementById('btn-timeline-screenshot')
            ?.addEventListener('click', _screenshotVisual);
        document.getElementById('btn-timeline-maximize')
            ?.addEventListener('click', _toggleMaximize);
        const _groupBtn = document.getElementById('btn-timeline-add-group');
        _groupBtn?.addEventListener('click', e => {
            e.stopPropagation();
            _toggleGroupPopup(_groupBtn);
        });
        document.getElementById('btn-timeline-clear')
            ?.addEventListener('click', _clearAll);
        document.getElementById('btn-timeline-save')
            ?.addEventListener('click', _saveCurrentTimeline);
        const _savedBtn = document.getElementById('btn-timeline-saved');
        _savedBtn?.addEventListener('click', e => {
            e.stopPropagation();
            _savedPopup ? _closeSavedPopup() : _openSavedPopup(_savedBtn);
        });
        document.getElementById('btn-timeline-multi')
            ?.addEventListener('click', _toggleMultiTrack);
        document.getElementById('btn-timeline-zoom-out')
            ?.addEventListener('click', () => _stepZoom(-1));
        document.getElementById('btn-timeline-zoom-in')
            ?.addEventListener('click', () => _stepZoom(+1));

        _makeDraggable(document.getElementById('timeline-panel-header'), _panel);
        _makeResizable(_panel);
    }

    // -------------------------------------------------------------------------
    // Toggle
    // -------------------------------------------------------------------------
    function toggle() {
        if (_visible && _panel?.classList.contains('is-maximized')) {
            _restoreMaximize(); // always un-maximize before hiding
        }
        _visible = !_visible;
        _panel?.classList.toggle('hidden', !_visible);
        document.getElementById('btn-timeline-toggle')
            ?.classList.toggle('is-active', _visible);
        if (_visible) {
            _applyPanelSize();
            _render();
        }
    }

    // -------------------------------------------------------------------------
    // Public: add an entry (called from results.js on Cmd/Ctrl+click)
    // -------------------------------------------------------------------------
    function addEntry(recId, recName, recColor, rowData, colName, colValue) {
        const st = _st();
        const entry = {
            id:         _newId(),
            recId:      recId    ?? null,
            recName:    recName  || 'Live result',
            recColor:   recColor || null,
            rowData:    rowData  || {},
            colName:    colName  || '',
            colValue:   colValue ?? null,
            label:      '',
            color:      null, // custom dot/bar color (null = use recColor / autoColor)
            groupId:    null,
            pinned:     false,
            pinnedCols: [],   // column names shown under the tick label in visual view
            addedAt:    Date.now(),
        };
        st.entries.push(entry);
        if (_visible) _render();
        const preview = _fmtVal(colValue);
        const short   = preview.length > 30 ? preview.slice(0, 30) + '…' : preview;
        App.notify?.(
            `Timeline ← ${entry.recName} · ${colName}: ${short}`,
            'info'
        );
    }

    // -------------------------------------------------------------------------
    // -------------------------------------------------------------------------
    // Zoom
    // -------------------------------------------------------------------------
    function _stepZoom(dir) {
        const cur = _ZOOM_STEPS.indexOf(
            _ZOOM_STEPS.reduce((prev, z) => Math.abs(z - _zoomLevel) < Math.abs(prev - _zoomLevel) ? z : prev)
        );
        const next = Math.max(0, Math.min(_ZOOM_STEPS.length - 1, cur + dir));
        _zoomLevel = _ZOOM_STEPS[next];
        const lbl = document.getElementById('tl-zoom-level');
        if (lbl) lbl.textContent = Math.round(_zoomLevel * 100) + '%';
        if (_visible) _render();
    }

    // -------------------------------------------------------------------------
    // Public: refresh after applyContext
    // -------------------------------------------------------------------------
    function refresh() {
        _updateSavedCount();
        _updateCount();
        if (_visible) _render();
    }

    // -------------------------------------------------------------------------
    // Render dispatcher
    // -------------------------------------------------------------------------
    function _render() {
        _updateCount();
        if (_viewMode === 'list') {
            _renderList();
        } else if (_multiTrackMode) {
            _renderMultiTrack();
        } else {
            _renderVisual();
        }
    }

    // =========================================================================
    // LIST VIEW
    // =========================================================================
    function _renderList() {
        const st = _st();
        _listEl.classList.remove('hidden');
        _visualEl.classList.add('hidden');
        _listEl.innerHTML = '';

        if (st.entries.length === 0) {
            _listEl.innerHTML =
                '<p class="tl-empty">No entries yet.<br>' +
                'Cmd/Ctrl+click any result cell to pin it here.</p>';
            return;
        }

        // Flat chronological list — groups only affect the visual view
        _sortedEntries().forEach(e => _listEl.appendChild(_buildListEntry(e, st)));
    }

    function _buildListEntry(entry, st) {
        const div   = document.createElement('div');
        div.className  = 'tl-entry';
        div.dataset.id = entry.id;

        // Color bar — click to open color picker
        const colorBar = document.createElement('div');
        colorBar.className = 'tl-entry__color-bar';
        colorBar.style.background = _entryColor(entry);
        colorBar.title = 'Click to change color';
        colorBar.addEventListener('click', e => {
            e.stopPropagation();
            _openColorPicker(colorBar, entry, () => {
                colorBar.style.background = _entryColor(entry);
            });
        });
        div.appendChild(colorBar);

        // Info section
        const info = document.createElement('div');
        info.className = 'tl-entry__info';
        info.innerHTML =
            `<span class="tl-entry__rec${entry.recId ? ' tl-entry__rec--link' : ''}" title="${_esc(entry.recName)}">${_esc(_trunc(entry.recName, 20))}</span>` +
            `<span class="tl-entry__kv">${_esc(entry.colName)}: <strong>${_esc(_trunc(_fmtVal(entry.colValue), 28))}</strong></span>`;
        div.appendChild(info);
        if (entry.recId) {
            info.querySelector('.tl-entry__rec').addEventListener('click', e => {
                e.stopPropagation();
                Recordings.loadResultsById(entry.recId);
            });
        }

        // Label input
        const labelInput = document.createElement('input');
        labelInput.className   = 'tl-entry__label';
        labelInput.type        = 'text';
        labelInput.placeholder = 'label…';
        labelInput.value       = entry.label;
        labelInput.title       = 'Annotation label';
        labelInput.addEventListener('change', () => { entry.label = labelInput.value; });
        div.appendChild(labelInput);

        // Actions cluster
        const actions = document.createElement('div');
        actions.className = 'tl-entry__actions';

        // Group selector (if groups exist)
        if (st.groups.length) {
            const sel = document.createElement('select');
            sel.className = 'tl-entry__group-sel';
            sel.title = 'Assign to group';
            sel.innerHTML =
                '<option value="">— group —</option>' +
                st.groups.map(g =>
                    `<option value="${_esc(g.id)}"${entry.groupId === g.id ? ' selected' : ''}>`+
                    `${_esc(g.label)}</option>`
                ).join('');
            sel.addEventListener('change', () => {
                entry.groupId = sel.value || null;
                _render();
            });
            actions.appendChild(sel);
        }

        // Peek button
        const peekBtn = document.createElement('button');
        peekBtn.className   = 'tl-entry__peek-btn';
        peekBtn.title       = 'Toggle full row detail';
        peekBtn.textContent = '👁';
        actions.appendChild(peekBtn);

        // Delete button
        const delBtn = document.createElement('button');
        delBtn.className   = 'tl-entry__del-btn';
        delBtn.title       = 'Remove from timeline';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', async () => {
            if (!await Dialog.confirm('Remove this entry from the timeline?')) return;
            _removeEntry(entry.id);
        });
        actions.appendChild(delBtn);

        div.appendChild(actions);

        // Peek panel (full row)
        const peekPanel = document.createElement('div');
        peekPanel.className = 'tl-entry__peek';
        if (!entry.pinned) peekPanel.classList.add('hidden');
        _fillPeekPanel(peekPanel, entry);
        div.appendChild(peekPanel);

        peekBtn.addEventListener('click', () => {
            entry.pinned = !entry.pinned;
            peekPanel.classList.toggle('hidden', !entry.pinned);
            peekBtn.classList.toggle('is-active', entry.pinned);
        });
        if (entry.pinned) peekBtn.classList.add('is-active');

        return div;
    }

    /**
     * Fill a peek panel with the full row table.
     * @param {HTMLElement} el       — container to fill
     * @param {object}      entry    — timeline entry
     * @param {HTMLElement} [botLblEl] — if provided, adds checkboxes that toggle
     *                                   pinned column labels under the tick
     */
    function _fillPeekPanel(el, entry, botLblEl) {
        if (!entry.pinnedCols) entry.pinnedCols = []; // migrate old entries
        const table = document.createElement('table');
        table.className = 'tl-peek-table';
        Object.entries(entry.rowData).forEach(([k, v]) => {
            const tr = document.createElement('tr');
            const isNull = v === null || v === undefined;

            const keyTd = document.createElement('td');
            keyTd.className   = 'tl-peek-key';
            keyTd.textContent = k;

            const valTd = document.createElement('td');
            valTd.className   = 'tl-peek-val' + (isNull ? ' is-null' : '');
            valTd.textContent = _fmtVal(v);

            // Checkbox column — only shown in visual peek popup (botLblEl provided)
            if (botLblEl) {
                const chkTd = document.createElement('td');
                chkTd.className = 'tl-peek-chk-td';
                const chk = document.createElement('input');
                chk.type    = 'checkbox';
                chk.className = 'tl-peek-chk';
                chk.title   = 'Show this column under the tick label';
                chk.checked = entry.pinnedCols.includes(k);
                chk.addEventListener('change', e => {
                    e.stopPropagation();
                    if (chk.checked) {
                        if (!entry.pinnedCols.includes(k)) entry.pinnedCols.push(k);
                    } else {
                        entry.pinnedCols = entry.pinnedCols.filter(c => c !== k);
                    }
                    _refreshBotLabel(botLblEl, entry);
                    // In multi-track mode adjust lane heights in-place so the peek
                    // popup is not closed by a full re-render.
                    if (_multiTrackMode) _updateMultiLaneHeights();
                });
                chkTd.appendChild(chk);
                tr.appendChild(chkTd);
            }

            tr.appendChild(keyTd);
            tr.appendChild(valTd);

            table.appendChild(tr);
        });
        el.appendChild(table);
    }

    /** Rebuild the bottom-label content for a tick based on label + pinnedCols. */
    function _refreshBotLabel(botLblEl, entry) {
        if (!entry.pinnedCols) entry.pinnedCols = [];
        const lines = [];
        const mainLabel = entry.label || _trunc(entry.recName, 16);
        if (mainLabel) lines.push(mainLabel);
        entry.pinnedCols.forEach(col => {
            const v = entry.rowData[col];
            lines.push(`${col}: ${_fmtVal(v)}`);
        });
        botLblEl.innerHTML = '';
        lines.forEach((line, i) => {
            const span = document.createElement('span');
            span.className   = i === 0 ? 'tl-bot-main' : 'tl-bot-extra';
            span.textContent = line;
            botLblEl.appendChild(span);
        });
    }

    // =========================================================================
    // VISUAL TIMELINE
    // =========================================================================
    // Layout constants (px) — tune here to adjust vertical spacing
    const VIS = {
        bracketTop:   4,    // top of group bracket
        bracketH:     20,   // height of bracket bar
        labelTop:     26,   // top of "time value" label area
        labelH:       58,   // height of that label area
        axisY:        86,   // y of axis line
        dotR:         6,    // dot radius
        stemTopY:     56,   // where the tick stem starts (inside label area)
        stemBotY:     96,   // where it ends (below axis)
        userLabelTop: 98,   // user label below axis
        userLabelH:   56,   // height
        totalH:       160,  // total track height
        padPct:       0.10, // horizontal padding (fraction of track width on each side)
        tickMinPx:    140,  // min px per tick (drives horizontal scroll)
    };

    function _renderVisual() {
        const st = _st();
        _listEl.classList.add('hidden');
        _visualEl.classList.remove('hidden');
        _visualEl.innerHTML = '';
        _closeTickPeek();

        if (st.entries.length === 0) {
            _visualEl.innerHTML =
                '<p class="tl-empty">No entries yet.<br>' +
                'Cmd/Ctrl+click any result cell to pin it here.</p>';
            return;
        }

        const sorted  = _sortedEntries();
        const n       = sorted.length;
        const trackPx = Math.max(600, n * VIS.tickMinPx + 100) * _zoomLevel;

        // Horizontal layout helpers
        const pad  = VIS.padPct;
        const pxOf = pos => (pad + pos * (1 - 2 * pad)) * trackPx;
        const positions = _computePositions(sorted);
        const xPxArr    = sorted.map((_, i) => pxOf(positions[i]));

        // ── Label collision avoidance ────────────────────────────────────────
        // Each label is 120px wide (CSS); use 128px for the effective slot so
        // adjacent labels get a small gap instead of touching edge-to-edge.
        const LEVEL_STEP = 18;   // px to shift each stagger level
        const topLevels  = _assignLabelLevels(xPxArr, 128);
        const botLevels  = _assignLabelLevels(xPxArr, 128);
        const maxTopLv   = topLevels.length ? Math.max(...topLevels) : 0;
        const maxBotLv   = botLevels.length ? Math.max(...botLevels) : 0;
        // Reserve extra vertical room: top labels grow upward, bot labels downward
        const extraTop   = maxTopLv * LEVEL_STEP;
        const extraBot   = maxBotLv * LEVEL_STEP;
        // Shift every fixed y-coordinate down by extraTop so pushed-up labels
        // still have room above y=0 in the track.
        const Y = base => base + extraTop;

        // Outer scroll wrapper
        const scroller = document.createElement('div');
        scroller.className = 'tl-visual-scroller';

        // Track — taller when labels stagger
        const track = document.createElement('div');
        track.className  = 'tl-track';
        track.style.width  = trackPx + 'px';
        track.style.height = (VIS.totalH + extraTop + extraBot) + 'px';

        // Axis line
        const axis = document.createElement('div');
        axis.className = 'tl-axis';
        axis.style.top = Y(VIS.axisY) + 'px';
        track.appendChild(axis);

        // Draw group brackets
        const groupBuckets = {};
        sorted.forEach((e, i) => {
            if (!e.groupId) return;
            if (!groupBuckets[e.groupId]) groupBuckets[e.groupId] = [];
            groupBuckets[e.groupId].push(xPxArr[i]);
        });

        st.groups.forEach(g => {
            const pxList = groupBuckets[g.id];
            if (!pxList || !pxList.length) return;
            const minPx = Math.min(...pxList);
            const maxPx = Math.max(...pxList);
            const bracket = document.createElement('div');
            bracket.className = 'tl-group-bracket';
            bracket.style.top         = Y(VIS.bracketTop) + 'px';
            bracket.style.height      = VIS.bracketH + 'px';
            bracket.style.left        = (minPx - 30) + 'px';
            bracket.style.width       = (maxPx - minPx + 60) + 'px';
            bracket.style.borderColor = g.color;
            const lbl = document.createElement('span');
            lbl.className   = 'tl-group-bracket__label';
            lbl.textContent = g.label;
            lbl.style.color = g.color;
            lbl.title       = 'Double-click to rename';
            lbl.addEventListener('dblclick', async e => {
                e.stopPropagation();
                const name = await Dialog.prompt('Rename group:', g.label);
                if (!name || !name.trim()) return;
                g.label = name.trim();
                _render();
            });

            const colorDot = document.createElement('button');
            colorDot.className = 'tl-group-bracket__color-dot';
            colorDot.style.background = g.color;
            colorDot.title = 'Change group color';
            colorDot.addEventListener('click', e => {
                e.stopPropagation();
                _openColorPicker(colorDot, g, () => {
                    const c = g.color;
                    colorDot.style.background = c;
                    lbl.style.color           = c;
                    bracket.style.borderColor = c;
                });
            });
            bracket.appendChild(lbl);
            bracket.appendChild(colorDot);
            track.appendChild(bracket);
        });

        // Draw ticks
        sorted.forEach((entry, i) => {
            const color     = _entryColor(entry);
            const xpx       = xPxArr[i];
            const timeLabel = `${entry.colName}: ${_fmtVal(entry.colValue)}`;
            const topLv     = topLevels[i];
            const botLv     = botLevels[i];

            const tick = document.createElement('div');
            tick.className  = 'tl-tick';
            tick.dataset.id = entry.id;
            tick.style.left = xpx + 'px';

            // Stem — extends from the bottom edge of the top label down to
            // below the axis.  When the top label is pushed up (topLv > 0) the
            // stem grows taller to stay connected to the dot.
            const stemTopY = Y(VIS.stemTopY) - topLv * LEVEL_STEP;
            const stem = document.createElement('div');
            stem.className = 'tl-tick__stem';
            stem.style.top    = stemTopY + 'px';
            stem.style.height = (Y(VIS.stemBotY) - stemTopY) + 'px';

            // Dot
            const dot = document.createElement('div');
            dot.className = 'tl-tick__dot';
            dot.style.top        = (Y(VIS.axisY) - VIS.dotR) + 'px';
            dot.style.width      = (VIS.dotR * 2) + 'px';
            dot.style.height     = (VIS.dotR * 2) + 'px';
            dot.style.background = color;
            dot.style.boxShadow  = `0 0 0 2px ${color}44`;

            // Labels are 120 px wide and normally centered on the tick via CSS
            // `left: 50%; transform: translateX(-50%)`.  Near the track edges
            // the centered position would extend past x=0 or x=trackPx and get
            // silently clipped by the scroll container.  Override left/transform
            // inline to clamp the label fully within the track.
            const LABEL_W      = 120;
            const centeredLeft = xpx - LABEL_W / 2;           // ideal left edge
            const clampedLeft  = Math.max(0, Math.min(centeredLeft, trackPx - LABEL_W));
            // Offset is relative to the tick's own left (= xpx; tick has width 0
            // because all its children are position:absolute, so transform:
            // translateX(-50%) on the tick itself is a 0-px translation).
            const lblOffsetPx  = clampedLeft - xpx;
            const lblTransform = 'none';   // disable the CSS translateX(-50%)

            // Top label — col name on first line, value on second.
            // Pushed upward for colliding labels (topLv > 0).
            const topLbl = document.createElement('div');
            topLbl.className = 'tl-tick__top';
            topLbl.title     = timeLabel;
            topLbl.style.top       = (Y(VIS.labelTop) - topLv * LEVEL_STEP) + 'px';
            topLbl.style.height    = (VIS.stemTopY - VIS.labelTop) + 'px';
            topLbl.style.left      = lblOffsetPx + 'px';
            topLbl.style.transform = lblTransform;
            const topColSpan = document.createElement('span');
            topColSpan.className   = 'tl-tick__top-col';
            topColSpan.textContent = entry.colName;
            const topValSpan = document.createElement('span');
            topValSpan.className   = 'tl-tick__top-val';
            topValSpan.textContent = _fmtVal(entry.colValue);
            topLbl.appendChild(topColSpan);
            topLbl.appendChild(topValSpan);

            // Bottom label — pushed downward for colliding labels (botLv > 0).
            const botLbl = document.createElement('div');
            botLbl.className       = 'tl-tick__bottom';
            botLbl.style.top       = (Y(VIS.userLabelTop) + botLv * LEVEL_STEP) + 'px';
            botLbl.style.height    = VIS.userLabelH + 'px';
            botLbl.style.left      = lblOffsetPx + 'px';
            botLbl.style.transform = lblTransform;
            _refreshBotLabel(botLbl, entry);

            tick.appendChild(topLbl);
            tick.appendChild(stem);
            tick.appendChild(dot);
            tick.appendChild(botLbl);

            tick.addEventListener('click', e => {
                e.stopPropagation();
                _showTickPeek(entry, tick, color, xpx, trackPx);
            });

            track.appendChild(tick);
        });

        scroller.appendChild(track);
        _visualEl.appendChild(scroller);

        // Close floating peek on outside click
        scroller.addEventListener('click', () => _closeTickPeek());
    }

    function _showTickPeek(entry, tickEl, color, xpx, trackPx, deletable = true) {
        _closeTickPeek();

        const botLbl = tickEl.querySelector('.tl-tick__bottom');

        // Append to the track (not the tick) so the popup escapes each tick's
        // individual CSS stacking context (caused by transform: translateX(-50%)).
        // This way the popup's z-index is compared against the ticks directly.
        const trackEl = tickEl.closest('.tl-track') || tickEl.parentElement;

        const peek = document.createElement('div');
        peek.className = 'tl-tick-peek';

        // Stop ALL clicks/mousedowns inside the peek from reaching the tick or
        // scroller — prevents the tick handler from recreating the popup (which
        // would kill focus on the label input) and prevents the scroller's
        // outside-click handler from closing it.
        peek.addEventListener('click',     e => e.stopPropagation());
        peek.addEventListener('mousedown', e => e.stopPropagation());

        // Position is finalised after appending so we can measure the actual
        // rendered width (which is now content-driven, not fixed).
        const onRight = xpx < trackPx * 0.65;
        peek.style.top = '0px';

        // Always resolve current color (may have been changed since render)
        const resolvedColor = _entryColor(entry);

        const hdr = document.createElement('div');
        hdr.className = 'tl-tick-peek__header';
        hdr.style.borderLeftColor = resolvedColor;

        // Color swatch — click to open color picker; updates dot + header live
        const colorSwatch = document.createElement('button');
        colorSwatch.className = 'tl-tick-peek__color-swatch';
        colorSwatch.style.background = resolvedColor;
        colorSwatch.title = 'Change dot color';
        colorSwatch.addEventListener('click', e => {
            e.stopPropagation();
            _openColorPicker(colorSwatch, entry, () => {
                const c = _entryColor(entry);
                colorSwatch.style.background = c;
                hdr.style.borderLeftColor    = c;
                // Update dot + shadow on the tick in the track
                const dotEl = tickEl.querySelector('.tl-tick__dot');
                if (dotEl) {
                    dotEl.style.background = c;
                    dotEl.style.boxShadow  = `0 0 0 2px ${c}44`;
                }
            });
        });

        const recSpan = document.createElement('span');
        recSpan.className   = 'tl-tick-peek__rec';
        recSpan.textContent = entry.recName;

        const labelInput = document.createElement('input');
        labelInput.type        = 'text';
        labelInput.className   = 'tl-tick-peek__label';
        labelInput.placeholder = 'label…';
        labelInput.value       = entry.label;
        labelInput.addEventListener('change', () => {
            entry.label = labelInput.value;
            if (botLbl) _refreshBotLabel(botLbl, entry);
        });
        labelInput.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                labelInput.blur();
            }
        });

        const closeBtn = document.createElement('button');
        closeBtn.className   = 'tl-tick-peek__close';
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', () => _closeTickPeek());

        const searchWrap = document.createElement('div');
        searchWrap.className = 'tl-tick-peek__search-wrap';

        const searchInput = document.createElement('input');
        searchInput.type        = 'text';
        searchInput.className   = 'tl-tick-peek__search';
        searchInput.placeholder = 'filter columns…';
        searchInput.setAttribute('autocomplete', 'off');

        const searchClearBtn = document.createElement('button');
        searchClearBtn.type          = 'button';
        searchClearBtn.className     = 'col-search-clear';
        searchClearBtn.textContent   = '✕';
        searchClearBtn.title         = 'Clear filter';
        searchClearBtn.style.display = 'none';

        const _applyColFilter = () => {
            const term = searchInput.value.toLowerCase();
            panel.querySelectorAll('tr').forEach(tr => {
                const keyCell = tr.querySelector('.tl-peek-key');
                const match   = !term || (keyCell?.textContent.toLowerCase().includes(term));
                tr.style.display = match ? '' : 'none';
            });
        };

        searchClearBtn.addEventListener('click', () => {
            searchInput.value            = '';
            searchClearBtn.style.display = 'none';
            _applyColFilter();
            searchInput.focus();
        });
        searchInput.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                searchInput.value            = '';
                searchClearBtn.style.display = 'none';
                _applyColFilter();
            }
        });
        searchInput.addEventListener('input', () => {
            _applyColFilter();
            searchClearBtn.style.display = searchInput.value ? '' : 'none';
        });

        searchWrap.appendChild(searchInput);
        searchWrap.appendChild(searchClearBtn);

        const hdrMain = document.createElement('div');
        hdrMain.className = 'tl-tick-peek__hdr-main';
        hdrMain.appendChild(recSpan);
        hdrMain.appendChild(labelInput);
        hdrMain.appendChild(searchWrap);

        hdr.appendChild(colorSwatch);
        hdr.appendChild(hdrMain);
        hdr.appendChild(closeBtn);
        peek.appendChild(hdr);

        const panel = document.createElement('div');
        panel.className = 'tl-peek-panel';
        _fillPeekPanel(panel, entry, botLbl); // pass botLbl so checkboxes can update it
        peek.appendChild(panel);

        // Bottom bar — Results (if recording) + Delete (if deletable)
        const hasFooterItems = entry.recId || deletable;
        if (hasFooterItems) {
            const footer = document.createElement('div');
            footer.className = 'tl-tick-peek__footer';

            if (entry.recId) {
                const loadRecBtn = document.createElement('button');
                loadRecBtn.className   = 'tl-tick-peek__load-rec';
                loadRecBtn.textContent = 'Results';
                loadRecBtn.title       = 'Load this recording\'s results';
                loadRecBtn.addEventListener('click', () => {
                    Recordings.loadResultsById(entry.recId);
                    requestAnimationFrame(() => {
                        const tbody = document.querySelector('#results-table tbody');
                        const thead = document.querySelector('#results-table thead');
                        if (!tbody || !thead) return;

                        // Build bare-column-name → th-index map
                        const colIdxMap = {};
                        Array.from(thead.querySelectorAll('th')).forEach((th, i) => {
                            const key  = th.dataset.colKey || '';
                            const bare = key.includes('.') ? key.split('.')[1] : key;
                            if (bare) colIdxMap[bare] = i;
                            if (key)  colIdxMap[key]  = i;
                        });

                        // Find first row whose cell values all match entry.rowData
                        const rdEntries = Object.entries(entry.rowData || {});
                        let matchTr = null;
                        for (const tr of tbody.querySelectorAll('tr')) {
                            const tds = tr.querySelectorAll('td');
                            let ok = rdEntries.length > 0;
                            for (const [col, val] of rdEntries) {
                                const bare = col.includes('.') ? col.split('.')[1] : col;
                                const idx  = colIdxMap[col] ?? colIdxMap[bare];
                                if (idx == null) continue;
                                const cell = tds[idx];
                                if (!cell) { ok = false; break; }
                                const raw = cell.dataset.raw ?? cell.textContent ?? null;
                                if (String(raw) !== String(val == null ? '' : val)) { ok = false; break; }
                            }
                            if (ok) { matchTr = tr; break; }
                        }

                        if (matchTr) matchTr.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        Results.focusColumn(entry.colName);
                    });
                });
                footer.appendChild(loadRecBtn);
            }

            if (deletable) {
                const delBtn = document.createElement('button');
                delBtn.className   = 'tl-tick-peek__del';
                delBtn.textContent = '🗑 Delete';
                delBtn.addEventListener('click', async () => {
                    if (!await Dialog.confirm('Remove this entry from the timeline?')) return;
                    _closeTickPeek();
                    _removeEntry(entry.id);
                });
                footer.appendChild(delBtn);
            }

            peek.appendChild(footer);
        }

        // ── Drag to reposition ──────────────────────────────────────────────
        let _dragging = false, _dragX = 0, _dragY = 0, _origL = 0, _origT = 0;

        const _onDragMove = e => {
            if (!_dragging) return;
            peek.style.left = (_origL + e.clientX - _dragX) + 'px';
            peek.style.top  = (_origT + e.clientY - _dragY) + 'px';
        };
        const _onDragUp = () => {
            if (!_dragging) return;
            _dragging = false;
            hdr.style.cursor = 'grab';
            document.removeEventListener('mousemove', _onDragMove);
            document.removeEventListener('mouseup',   _onDragUp);
        };

        hdr.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            if (e.target.closest('button, input')) return;
            _dragging = true;
            _dragX    = e.clientX;
            _dragY    = e.clientY;
            _origL    = parseInt(peek.style.left) || 0;
            _origT    = parseInt(peek.style.top)  || 0;
            hdr.style.cursor = 'grabbing';
            e.preventDefault();
            e.stopPropagation();
            document.addEventListener('mousemove', _onDragMove);
            document.addEventListener('mouseup',   _onDragUp);
        });

        peek._dragCleanup = () => {
            document.removeEventListener('mousemove', _onDragMove);
            document.removeEventListener('mouseup',   _onDragUp);
        };
        // ────────────────────────────────────────────────────────────────────

        _tickPeekEl = peek;
        peek.style.visibility = 'hidden';
        trackEl.appendChild(peek);
        // Measure actual rendered width then position
        const peekW = peek.offsetWidth;
        if (onRight) {
            peek.style.left  = (xpx + 14) + 'px';
            peek.style.right = 'auto';
        } else {
            peek.style.left  = (xpx - peekW - 14) + 'px';
            peek.style.right = 'auto';
        }
        peek.style.visibility = '';
    }

    function _closeTickPeek() {
        if (_tickPeekEl) {
            _tickPeekEl._dragCleanup?.();
            _tickPeekEl.remove();
            _tickPeekEl = null;
        }
    }

    // -------------------------------------------------------------------------
    // Sorted entry list — used by both views
    // -------------------------------------------------------------------------
    /**
     * Returns a copy of entries sorted ascending by the clicked cell value (colValue).
     * Each entry's colValue is whatever cell was Cmd/Ctrl+clicked — it IS the time
     * value, regardless of which table or column it came from.
     * Entries whose colValue cannot be parsed as a date/number sink to the end,
     * falling back to insertion order among themselves.
     */
    function _sortedEntries() {
        const entries = _st().entries.slice(); // never mutate stored order
        return entries.sort((a, b) => {
            const ta = _parseTime(a.colValue);
            const tb = _parseTime(b.colValue);
            if (ta === null && tb === null) return a.addedAt - b.addedAt;
            if (ta === null) return 1;
            if (tb === null) return -1;
            return ta - tb; // ascending: earliest first
        });
    }

    // -------------------------------------------------------------------------
    // Time value parser (shared by sort and position computation)
    // -------------------------------------------------------------------------
    function _parseTime(v) {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        if (!isNaN(n)) return n;
        const d = Date.parse(String(v));
        return isNaN(d) ? null : d;
    }

    // -------------------------------------------------------------------------
    // Position computation for visual view
    // -------------------------------------------------------------------------
    /**
     * Maps each entry to a 0..1 horizontal position based on its colValue.
     * Entries are already sorted ascending by the caller; positions follow
     * the parsed numeric/datetime magnitude of colValue so the visual spacing
     * is proportional to the actual time gaps (not just evenly spaced).
     */
    function _computePositions(entries) {
        if (entries.length === 0) return [];
        if (entries.length === 1) return [0.5];

        const numVals = entries.map(e => _parseTime(e.colValue));
        const valid   = numVals.filter(v => v !== null);

        // If fewer than 2 parseable values, fall back to even spacing
        if (valid.length < 2) {
            return entries.map((_, i) => i / (entries.length - 1));
        }

        const min   = Math.min(...valid);
        const max   = Math.max(...valid);
        const range = max - min;

        if (range === 0) return entries.map(() => 0.5);

        return numVals.map((v, i) =>
            v !== null ? (v - min) / range : i / (entries.length - 1)
        );
    }

    // -------------------------------------------------------------------------
    // Label collision — greedy level assignment
    // -------------------------------------------------------------------------
    /**
     * Given an array of x-pixel centres (already in sorted order), assigns each
     * label a non-negative integer "level" so that no two labels at the same level
     * overlap horizontally.  Level 0 = default position; higher levels are offset
     * further away from the axis (up for top labels, down for bottom labels).
     *
     * @param {number[]} xArr         — sorted tick x-positions in px
     * @param {number}   [labelW=124] — effective label width (CSS width + gap)
     * @returns {number[]}
     */
    function _assignLabelLevels(xArr, labelW = 124) {
        const levels     = new Array(xArr.length).fill(0);
        const levelRight = []; // rightmost right-edge placed at each level

        for (let i = 0; i < xArr.length; i++) {
            const left  = xArr[i] - labelW / 2;
            const right = xArr[i] + labelW / 2;
            let l = 0;
            for (;;) {
                if (l >= levelRight.length || levelRight[l] <= left) {
                    if (l >= levelRight.length) levelRight.push(right);
                    else levelRight[l] = right;
                    levels[i] = l;
                    break;
                }
                l++;
            }
        }
        return levels;
    }

    // -------------------------------------------------------------------------
    // Group management
    // -------------------------------------------------------------------------
    const _GROUP_COLORS = [
        '#e85555','#4a9eff','#f5a623','#7ed321',
        '#bd10e0','#f8e71c','#17c4ba','#ff6b9d',
    ];

    function _toggleGroupPopup(btnEl) {
        if (_groupPopup) {
            _closeGroupPopup();
        } else {
            _openGroupPopup(btnEl);
        }
    }

    function _openGroupPopup(btnEl) {
        _closeGroupPopup();

        const st  = _st();
        const pop = document.createElement('div');
        pop.className = 'tl-group-popup';

        // Stop clicks inside the popup from bubbling to the document close handler
        pop.addEventListener('click',     e => e.stopPropagation());
        pop.addEventListener('mousedown', e => e.stopPropagation());

        function _rebuildRows() {
            // Clear everything except the "+ New Group" button (added last)
            pop.innerHTML = '';

            if (st.groups.length === 0) {
                const empty = document.createElement('p');
                empty.className   = 'tl-group-popup__empty';
                empty.textContent = 'No groups yet.';
                pop.appendChild(empty);
            } else {
                st.groups.forEach(g => {
                    const row = document.createElement('div');
                    row.className = 'tl-group-popup__row';

                    // Color chip — click to change group color
                    const chip = document.createElement('button');
                    chip.className = 'tl-group-popup__chip';
                    chip.style.background = g.color;
                    chip.title = 'Change group color';
                    chip.addEventListener('click', e => {
                        e.stopPropagation();
                        _openColorPicker(chip, g, () => {
                            chip.style.background = g.color;
                            _render();
                        }, { keepGroupPopup: true });
                    });
                    row.appendChild(chip);

                    // Name
                    const name = document.createElement('span');
                    name.className   = 'tl-group-popup__name';
                    name.textContent = g.label;
                    row.appendChild(name);

                    // Rename button
                    const renBtn = document.createElement('button');
                    renBtn.className   = 'tl-group-popup__rename-btn';
                    renBtn.title       = 'Rename group';
                    renBtn.textContent = '✎';
                    renBtn.addEventListener('click', async e => {
                        e.stopPropagation();
                        const newName = await Dialog.prompt('Rename group:', g.label);
                        if (!newName || !newName.trim()) return;
                        g.label = newName.trim();
                        _render();
                        _rebuildRows();
                    });
                    row.appendChild(renBtn);

                    // Delete button
                    const delBtn = document.createElement('button');
                    delBtn.className   = 'tl-group-popup__del-btn';
                    delBtn.title       = 'Delete group';
                    delBtn.textContent = '✕';
                    delBtn.addEventListener('click', e => {
                        e.stopPropagation();
                        _deleteGroup(g.id);
                        _rebuildRows();
                    });
                    row.appendChild(delBtn);

                    pop.appendChild(row);
                });
            }

            // "+ New Group" button — always at the bottom
            const addBtn = document.createElement('button');
            addBtn.className   = 'tl-group-popup__add';
            addBtn.textContent = '＋ New Group';
            addBtn.addEventListener('click', async e => {
                e.stopPropagation();
                const name = await Dialog.prompt('Group name:', '');
                if (!name || !name.trim()) return;
                const color = _GROUP_COLORS[st.groups.length % _GROUP_COLORS.length];
                st.groups.push({ id: _newId(), label: name.trim(), color });
                _render();
                _rebuildRows();
            });
            pop.appendChild(addBtn);
        }

        _rebuildRows();

        // Position below the button, aligned to its left edge
        document.body.appendChild(pop);
        const br = btnEl.getBoundingClientRect();
        pop.style.top  = (br.bottom + window.scrollY + 4) + 'px';
        pop.style.left = (br.left   + window.scrollX)     + 'px';

        _groupPopup = pop;

        // Close on outside click (next tick so this click doesn't immediately close)
        setTimeout(() => {
            document.addEventListener('click', _closeGroupPopup, { once: true });
        }, 0);
    }

    function _closeGroupPopup() {
        if (_groupPopup) { _groupPopup.remove(); _groupPopup = null; }
    }

    function _deleteGroup(groupId) {
        const st  = _st();
        const idx = st.groups.findIndex(g => g.id === groupId);
        if (idx === -1) return;
        st.groups.splice(idx, 1);
        // Unassign entries that belonged to this group
        st.entries.forEach(e => { if (e.groupId === groupId) e.groupId = null; });
        _render();
    }

    function _removeEntry(id) {
        const st  = _st();
        const idx = st.entries.findIndex(e => e.id === id);
        if (idx === -1) return;
        st.entries.splice(idx, 1);
        _render();
    }

    async function _clearAll() {
        const st = _st();
        if (!st.entries.length) return;
        const ok = await Dialog.confirm(
            `Remove all ${st.entries.length} timeline entries?`
        );
        if (!ok) return;
        st.entries = [];
        st.groups  = [];
        _render();
    }

    // -------------------------------------------------------------------------
    // View toggle
    // -------------------------------------------------------------------------
    function _setView(mode) {
        _viewMode = mode;
        document.getElementById('btn-timeline-view-list')
            ?.classList.toggle('is-active', mode === 'list');
        document.getElementById('btn-timeline-view-visual')
            ?.classList.toggle('is-active', mode === 'visual');
        _render();
    }

    // -------------------------------------------------------------------------
    // Badge
    // -------------------------------------------------------------------------
    function _updateCount() {
        const n = _st().entries.length;
        // Panel header badge
        const badge = document.getElementById('timeline-count-badge');
        if (badge) badge.textContent = String(n);
        // Toolbar button badge (uses class, not id)
        const btn = document.getElementById('btn-timeline-toggle');
        if (btn) {
            btn.classList.toggle('tl-has-entries', n > 0);
            const btnBadge = btn.querySelector('.tl-btn-badge');
            if (btnBadge) btnBadge.textContent = String(n);
        }
    }

    // -------------------------------------------------------------------------
    // Auto-color by recId
    // -------------------------------------------------------------------------
    function _autoColor(recId) {
        if (!recId) return '#888888';
        if (_recColorMap[recId]) return _recColorMap[recId];
        const c = _AUTO_COLORS[_autoColorIdx++ % _AUTO_COLORS.length];
        _recColorMap[recId] = c;
        return c;
    }

    /** Resolved color for an entry: custom > recColor > autoColor. */
    function _entryColor(entry) {
        return entry.color || entry.recColor || _autoColor(entry.recId);
    }

    // -------------------------------------------------------------------------
    // Per-entry color picker
    // -------------------------------------------------------------------------
    /**
     * Opens a small floating color picker anchored below `anchorEl`.
     * Calls `onChanged()` whenever the entry color is updated so the caller
     * can refresh the relevant DOM element(s) without a full re-render.
     */
    function _openColorPicker(anchorEl, entry, onChanged, options = {}) {
        _closeColorPicker();
        if (!options.keepGroupPopup) _closeGroupPopup();

        const pop = document.createElement('div');
        pop.className = 'tl-color-picker';
        pop.addEventListener('click',     e => e.stopPropagation());
        pop.addEventListener('mousedown', e => e.stopPropagation());

        // Preset swatch grid
        const grid = document.createElement('div');
        grid.className = 'tl-color-picker__grid';
        _ENTRY_PALETTE.forEach(hex => {
            const sw = document.createElement('button');
            sw.className = 'tl-color-picker__swatch';
            sw.style.background = hex;
            sw.title = hex;
            if (entry.color === hex) sw.classList.add('is-active');
            sw.addEventListener('click', () => {
                entry.color = hex;
                if (!options.keepOpen) _closeColorPicker();
                onChanged();
            });
            grid.appendChild(sw);
        });
        pop.appendChild(grid);

        // Bottom row: native color input + reset
        const row = document.createElement('div');
        row.className = 'tl-color-picker__row';

        const customInput = document.createElement('input');
        customInput.type      = 'color';
        customInput.className = 'tl-color-picker__custom';
        customInput.title     = 'Custom color';
        customInput.value     = entry.color || _entryColor(entry);
        customInput.addEventListener('input', () => {
            entry.color = customInput.value;
            onChanged();
        });
        customInput.addEventListener('change', () => {
            entry.color = customInput.value;
            if (!options.keepOpen) _closeColorPicker();
            onChanged();
        });

        const resetBtn = document.createElement('button');
        resetBtn.className   = 'tl-color-picker__reset';
        resetBtn.textContent = '↺ Reset';
        resetBtn.title       = 'Reset to recording color';
        resetBtn.addEventListener('click', () => {
            entry.color = null;
            if (!options.keepOpen) _closeColorPicker();
            onChanged();
        });

        row.appendChild(customInput);
        row.appendChild(resetBtn);
        pop.appendChild(row);

        document.body.appendChild(pop);
        const br = anchorEl.getBoundingClientRect();
        pop.style.top  = (br.bottom + window.scrollY + 4) + 'px';
        pop.style.left = (br.left   + window.scrollX)     + 'px';

        _colorPickerEl = pop;
        setTimeout(() => {
            document.addEventListener('click', _closeColorPicker, { once: true });
        }, 0);
    }

    function _closeColorPicker() {
        if (_colorPickerEl) { _colorPickerEl.remove(); _colorPickerEl = null; }
    }

    // -------------------------------------------------------------------------
    // Saved timelines — save / load / delete / visibility
    // -------------------------------------------------------------------------

    function _updateSavedCount() {
        const n  = _savedTimelines().length;
        const el = document.getElementById('tl-saved-count');
        if (el) el.textContent = n > 0 ? String(n) : '';
    }

    async function _saveCurrentTimeline() {
        const st = _st();
        if (!st.entries.length) {
            App.notify?.('Nothing to save — timeline is empty.', 'warn');
            return;
        }
        const def  = `Timeline ${new Date().toLocaleDateString()}`;
        const name = await Dialog.prompt('Save timeline as:', def);
        if (!name || !name.trim()) return;
        const trimmed  = name.trim();
        const existing = _savedTimelines().find(s => s.name === trimmed);
        if (existing) {
            if (!await Dialog.confirm('A timeline named "' + trimmed + '" already exists. Overwrite it?')) return;
            existing.entries   = JSON.parse(JSON.stringify(st.entries));
            existing.groups    = JSON.parse(JSON.stringify(st.groups));
            existing.timestamp = Date.now();
        } else {
            _savedTimelines().push({
                id:        _newStlId(),
                name:      trimmed,
                timestamp: Date.now(),
                visible:   true,
                entries:   JSON.parse(JSON.stringify(st.entries)),
                groups:    JSON.parse(JSON.stringify(st.groups)),
            });
        }
        _updateSavedCount();
        if (_visible) _render();
        App.notify?.('Timeline saved.', 'success');
    }

    function _toggleMultiTrack() {
        _multiTrackMode = !_multiTrackMode;
        document.getElementById('btn-timeline-multi')
            ?.classList.toggle('is-active', _multiTrackMode);
        if (_viewMode !== 'visual') {
            _setView('visual');
        } else {
            _render();
        }
    }

    function _openSavedPopup(btnEl) {
        _closeSavedPopup();
        const stls = _savedTimelines();
        const grps = _savedTimelineGroups();

        const pop = document.createElement('div');
        pop.className = 'tl-saved-popup';
        pop.addEventListener('click',     e => e.stopPropagation());
        pop.addEventListener('mousedown', e => e.stopPropagation());

        let _dragStlId   = null;
        let _dragGroupId = null;

        function _rerender() {
            _rebuild();
            if (_multiTrackMode && _viewMode === 'visual') _render();
        }

        function _buildTimelineRow(stl) {
            const row = document.createElement('div');
            row.className = 'tl-saved-popup__row' + (stl.groupId ? ' tl-saved-popup__row--in-group' : '');
            row.draggable = true;
            row.dataset.stlId = stl.id;

            row.addEventListener('dragstart', e => {
                _dragStlId   = stl.id;
                _dragGroupId = null;
                e.dataTransfer.effectAllowed = 'move';
                requestAnimationFrame(() => row.classList.add('tl-saved-popup__row--dragging'));
            });
            row.addEventListener('dragend', () => {
                row.classList.remove('tl-saved-popup__row--dragging');
                _dragStlId = null; _dragGroupId = null;
            });
            row.addEventListener('dragover', e => {
                if (!_dragStlId || _dragStlId === stl.id) return;
                e.preventDefault();
                row.classList.add('tl-saved-popup__row--drag-over');
            });
            row.addEventListener('dragleave', () => row.classList.remove('tl-saved-popup__row--drag-over'));
            row.addEventListener('drop', e => {
                e.preventDefault();
                row.classList.remove('tl-saved-popup__row--drag-over');
                if (!_dragStlId || _dragStlId === stl.id) return;
                const fromIdx = stls.findIndex(s => s.id === _dragStlId);
                const toIdx   = stls.indexOf(stl);
                if (fromIdx === -1 || toIdx === -1) return;
                const [moved] = stls.splice(fromIdx, 1);
                stls.splice(toIdx, 0, moved);
                if (stl.groupId) moved.groupId = stl.groupId;
                else              delete moved.groupId;
                _dragStlId = null;
                _rerender();
            });

            const chk = document.createElement('input');
            chk.type      = 'checkbox';
            chk.checked   = stl.visible !== false;
            chk.className = 'tl-saved-popup__vis';
            chk.title     = 'Show as track in multi-track view';
            chk.addEventListener('change', () => {
                stl.visible = chk.checked;
                if (_multiTrackMode && _viewMode === 'visual') _render();
            });
            row.appendChild(chk);

            const nameSpan = document.createElement('span');
            nameSpan.className   = 'tl-saved-popup__name';
            nameSpan.textContent = stl.name;
            nameSpan.title       = new Date(stl.timestamp).toLocaleString();
            row.appendChild(nameSpan);

            const cnt = document.createElement('span');
            cnt.className   = 'tl-saved-popup__count';
            cnt.textContent = stl.entries.length + ' pts';
            row.appendChild(cnt);

            const loadBtn = document.createElement('button');
            loadBtn.className   = 'tl-saved-popup__load';
            loadBtn.textContent = 'Load';
            loadBtn.title       = 'Replace current timeline entries with this snapshot';
            loadBtn.addEventListener('click', async () => {
                const cur = _st();
                if (cur.entries.length) {
                    if (!await Dialog.confirm(
                        'Replace the ' + cur.entries.length + ' current entries with "' + stl.name + '"?'
                    )) return;
                }
                cur.entries = JSON.parse(JSON.stringify(stl.entries));
                cur.groups  = JSON.parse(JSON.stringify(stl.groups));
                _render();
            });
            row.appendChild(loadBtn);

            const replBtn = document.createElement('button');
            replBtn.className   = 'tl-saved-popup__repl';
            replBtn.textContent = '⇤ Replace';
            replBtn.title       = 'Overwrite this snapshot with the current timeline';
            replBtn.addEventListener('click', async () => {
                const cur = _st();
                if (!cur.entries.length) {
                    App.notify?.('Current timeline is empty — nothing to save.', 'warn');
                    return;
                }
                if (!await Dialog.confirm('Overwrite "' + stl.name + '" with the current timeline?')) return;
                stl.entries   = JSON.parse(JSON.stringify(cur.entries));
                stl.groups    = JSON.parse(JSON.stringify(cur.groups));
                stl.timestamp = Date.now();
                _rebuild();
                if (_multiTrackMode && _viewMode === 'visual') _render();
            });
            row.appendChild(replBtn);

            const renBtn = document.createElement('button');
            renBtn.className   = 'tl-saved-popup__ren';
            renBtn.textContent = '✎';
            renBtn.title       = 'Rename saved timeline';
            renBtn.addEventListener('click', async () => {
                const name = await Dialog.prompt('Rename timeline:', stl.name);
                if (!name || !name.trim()) return;
                stl.name = name.trim();
                _rebuild();
                if (_multiTrackMode && _viewMode === 'visual') _render();
            });
            row.appendChild(renBtn);

            const delBtn = document.createElement('button');
            delBtn.className   = 'tl-saved-popup__del';
            delBtn.textContent = '✕';
            delBtn.title       = 'Delete saved timeline';
            delBtn.addEventListener('click', async () => {
                if (!await Dialog.confirm('Delete saved timeline "' + stl.name + '"?')) return;
                const i = stls.indexOf(stl);
                if (i !== -1) stls.splice(i, 1);
                _updateSavedCount();
                _rerender();
            });
            row.appendChild(delBtn);

            return row;
        }

        function _buildGroupHeader(grp) {
            const members = stls.filter(s => s.groupId === grp.id);

            const hdr = document.createElement('div');
            hdr.className       = 'tl-saved-popup__group-hdr';
            hdr.dataset.groupId = grp.id;
            hdr.draggable       = true;

            hdr.addEventListener('dragstart', e => {
                if (e.target.tagName === 'BUTTON') { e.preventDefault(); return; }
                _dragGroupId = grp.id;
                _dragStlId   = null;
                e.dataTransfer.effectAllowed = 'move';
                requestAnimationFrame(() => hdr.classList.add('tl-saved-popup__group-hdr--dragging'));
            });
            hdr.addEventListener('dragend', () => {
                hdr.classList.remove('tl-saved-popup__group-hdr--dragging');
                _dragGroupId = null; _dragStlId = null;
            });
            hdr.addEventListener('dragover', e => {
                if (_dragStlId) {
                    e.preventDefault();
                    hdr.classList.add('tl-saved-popup__group-hdr--drop-target');
                } else if (_dragGroupId && _dragGroupId !== grp.id) {
                    e.preventDefault();
                    hdr.classList.add('tl-saved-popup__group-hdr--drag-over');
                }
            });
            hdr.addEventListener('dragleave', () => {
                hdr.classList.remove('tl-saved-popup__group-hdr--drop-target',
                                     'tl-saved-popup__group-hdr--drag-over');
            });
            hdr.addEventListener('drop', e => {
                e.preventDefault();
                hdr.classList.remove('tl-saved-popup__group-hdr--drop-target',
                                     'tl-saved-popup__group-hdr--drag-over');
                if (_dragStlId) {
                    const moved = stls.find(s => s.id === _dragStlId);
                    if (moved) { moved.groupId = grp.id; _dragStlId = null; _rerender(); }
                } else if (_dragGroupId && _dragGroupId !== grp.id) {
                    const fi = grps.findIndex(g => g.id === _dragGroupId);
                    const ti = grps.findIndex(g => g.id === grp.id);
                    if (fi !== -1 && ti !== -1) { const [m] = grps.splice(fi, 1); grps.splice(ti, 0, m); }
                    _dragGroupId = null;
                    _rerender();
                }
            });

            const toggle = document.createElement('span');
            toggle.className   = 'tl-saved-popup__group-toggle';
            toggle.textContent = grp.collapsed ? '▶' : '▼';
            toggle.addEventListener('click', e => {
                e.stopPropagation();
                grp.collapsed = !grp.collapsed;
                _rebuild();
            });
            hdr.appendChild(toggle);

            const nameSp = document.createElement('span');
            nameSp.className   = 'tl-saved-popup__group-name';
            nameSp.textContent = grp.name;
            hdr.appendChild(nameSp);

            const cntSp = document.createElement('span');
            cntSp.className   = 'tl-saved-popup__group-count';
            cntSp.textContent = '(' + members.length + ')';
            hdr.appendChild(cntSp);

            const renBtn = document.createElement('button');
            renBtn.className   = 'tl-saved-popup__ren';
            renBtn.textContent = '✎';
            renBtn.title       = 'Rename group';
            renBtn.addEventListener('click', async e => {
                e.stopPropagation();
                const name = await Dialog.prompt('Rename group:', grp.name);
                if (!name || !name.trim()) return;
                grp.name = name.trim();
                _rebuild();
                if (_multiTrackMode && _viewMode === 'visual') _render();
            });
            hdr.appendChild(renBtn);

            const delBtn = document.createElement('button');
            delBtn.className   = 'tl-saved-popup__del';
            delBtn.textContent = '✕';
            delBtn.title       = 'Delete group (timelines will be ungrouped)';
            delBtn.addEventListener('click', async e => {
                e.stopPropagation();
                const memberCount = stls.filter(s => s.groupId === grp.id).length;
                const msg = memberCount
                    ? 'Delete group "' + grp.name + '" and its ' + memberCount + ' timeline(s)?'
                    : 'Delete empty group "' + grp.name + '"?';
                if (!await Dialog.confirm(msg)) return;
                // Remove all member timelines
                for (let i = stls.length - 1; i >= 0; i--) {
                    if (stls[i].groupId === grp.id) stls.splice(i, 1);
                }
                const gi = grps.findIndex(g => g.id === grp.id);
                if (gi !== -1) grps.splice(gi, 1);
                _updateSavedCount();
                _rerender();
            });
            hdr.appendChild(delBtn);

            return hdr;
        }

        function _rebuild() {
            pop.innerHTML = '';

            // Toolbar
            const toolbar = document.createElement('div');
            toolbar.className = 'tl-saved-popup__toolbar';
            const addGrpBtn = document.createElement('button');
            addGrpBtn.className   = 'tl-saved-popup__add-grp';
            addGrpBtn.textContent = '⊞ Group';
            addGrpBtn.title       = 'Create a new group';
            addGrpBtn.addEventListener('click', async () => {
                const name = await Dialog.prompt('Group name:', '');
                if (!name || !name.trim()) return;
                grps.push({ id: _newStlGroupId(), name: name.trim(), collapsed: false });
                _rebuild();
            });
            toolbar.appendChild(addGrpBtn);
            pop.appendChild(toolbar);

            if (!stls.length) {
                const empty = document.createElement('p');
                empty.className   = 'tl-saved-popup__empty';
                empty.textContent = 'No saved timelines yet. Use Save to save the current one.';
                pop.appendChild(empty);
                return;
            }

            const validGroupIds = new Set(grps.map(g => g.id));

            // Groups with their members
            grps.forEach(grp => {
                pop.appendChild(_buildGroupHeader(grp));
                if (!grp.collapsed) {
                    stls.filter(s => s.groupId === grp.id)
                        .forEach(stl => pop.appendChild(_buildTimelineRow(stl)));
                }
            });

            // Ungrouped drop-zone separator (only when groups exist)
            if (grps.length > 0) {
                const sep = document.createElement('div');
                sep.className   = 'tl-saved-popup__ungroup-sep';
                sep.textContent = 'Ungrouped';
                sep.addEventListener('dragover', e => {
                    if (!_dragStlId) return;
                    e.preventDefault();
                    sep.classList.add('tl-saved-popup__ungroup-sep--active');
                });
                sep.addEventListener('dragleave', () =>
                    sep.classList.remove('tl-saved-popup__ungroup-sep--active'));
                sep.addEventListener('drop', e => {
                    e.preventDefault();
                    sep.classList.remove('tl-saved-popup__ungroup-sep--active');
                    const moved = stls.find(s => s.id === _dragStlId);
                    if (moved) { delete moved.groupId; _dragStlId = null; _rerender(); }
                });
                pop.appendChild(sep);
            }

            // Ungrouped timelines (clean up orphaned groupIds on the fly)
            stls.filter(s => !s.groupId || !validGroupIds.has(s.groupId))
                .forEach(stl => {
                    if (stl.groupId && !validGroupIds.has(stl.groupId)) delete stl.groupId;
                    pop.appendChild(_buildTimelineRow(stl));
                });
        }
        _rebuild();

        document.body.appendChild(pop);
        const br = btnEl.getBoundingClientRect();
        pop.style.top  = (br.bottom + window.scrollY + 4) + 'px';
        pop.style.left = (br.left   + window.scrollX)     + 'px';
        _savedPopup = pop;

        _savedPopupOutsideClick = e => {
            if (!_savedPopup) return;
            if (_savedPopup.contains(e.target)) return;
            // Ignore clicks that originated inside the Dialog modal
            if (document.getElementById('dialog-overlay')?.contains(e.target)) return;
            _closeSavedPopup();
        };
        setTimeout(() => {
            document.addEventListener('click', _savedPopupOutsideClick);
        }, 0);
    }
    function _closeSavedPopup() {
        if (_savedPopupOutsideClick) {
            document.removeEventListener('click', _savedPopupOutsideClick);
            _savedPopupOutsideClick = null;
        }
        if (_savedPopup) { _savedPopup.remove(); _savedPopup = null; }
    }

    // -------------------------------------------------------------------------
    // Multi-track visual render — shared axis across all visible saved timelines
    // -------------------------------------------------------------------------

    function _findEntryById(id) {
        const live = _st().entries.find(e => e.id === id);
        if (live) return live;
        for (const stl of _savedTimelines()) {
            const e = stl.entries.find(e => e.id === id);
            if (e) return e;
        }
        return null;
    }

    // Adjust multi-track lane heights in-place (without closing the peek popup).
    function _updateMultiLaneHeights() {
        const BOT_Y  = 68;   // must match BOT_LBL_Y in _renderMultiTrack
        const LINE_H = 13;   // must match LINE_H_PX
        const MIN_H  = 120;  // must match LANE_H_MIN
        const lanes  = _visualEl.querySelectorAll('.tl-multi-lane');
        const labels = _visualEl.querySelectorAll('.tl-multi-label');
        lanes.forEach((lane, i) => {
            let maxLines = 0;
            lane.querySelectorAll('.tl-tick').forEach(tickEl => {
                const entry = _findEntryById(tickEl.dataset.id);
                if (!entry) return;
                const hasMain = !!(entry.label || entry.recName);
                const lines   = (hasMain ? 1 : 0) + (entry.pinnedCols?.length || 0);
                if (lines > maxLines) maxLines = lines;
            });
            const h = Math.max(MIN_H, BOT_Y + maxLines * LINE_H + 16);
            lane.style.height = h + 'px';
            if (labels[i]) labels[i].style.height = h + 'px';
            lane.querySelectorAll('.tl-tick__bottom').forEach(b => {
                b.style.height = (h - BOT_Y) + 'px';
            });
        });
    }

    function _renderMultiTrack() {
        _listEl.classList.add('hidden');
        _visualEl.classList.remove('hidden');
        _visualEl.innerHTML = '';
        _closeTickPeek();

        const stls   = _savedTimelines().filter(s => s.visible !== false);
        const liveSt = _st();

        // Live track is first (omitted when empty); saved tracks follow
        const tracks = [
            ...(liveSt.entries.length > 0
                ? [{ name: 'Current', entries: liveSt.entries, groups: liveSt.groups, isCurrent: true }]
                : []),
            ...stls.map(s => ({ name: s.name, entries: s.entries, groups: s.groups, isCurrent: false })),
        ];

        const hasAny = tracks.some(t => t.entries.length > 0);
        if (!hasAny) {
            _visualEl.innerHTML =
                '<p class="tl-empty">No entries yet.<br>' +
                'Cmd/Ctrl+click any result cell to pin it here.</p>';
            return;
        }

        // Global axis: min/max from all entries across all tracks
        const allValues = tracks.flatMap(t =>
            t.entries.map(e => _parseTime(e.colValue)).filter(v => v !== null)
        );
        let globalMin, globalMax;
        if (allValues.length >= 2) {
            globalMin = Math.min(...allValues);
            globalMax = Math.max(...allValues);
        } else if (allValues.length === 1) {
            globalMin = allValues[0] - 1;
            globalMax = allValues[0] + 1;
        } else {
            globalMin = 0; globalMax = 1;
        }
        const globalRange = globalMax - globalMin || 1;

        const maxN    = Math.max(1, ...tracks.map(t => t.entries.length));
        const trackPx = Math.max(700, maxN * 90 + 100) * _zoomLevel;

        const PAD    = 0.05;
        const pxOf   = pos => (PAD + pos * (1 - 2 * PAD)) * trackPx;
        const gPos   = v => {
            const n = _parseTime(v);
            return n !== null ? (n - globalMin) / globalRange : 0.5;
        };

        // Per-lane layout constants (LANE_H is a minimum; grows per-track below)
        const LANE_H_MIN  = 120;
        const AXIS_Y      = 60;
        const DOT_R       = 5;
        const LBL_TOP_Y   = 4;    // breathing room from lane top
        const LBL_TOP_H   = 30;   // tall enough for col-name + value
        const STEM_TOP_Y  = 34;   // = LBL_TOP_Y + LBL_TOP_H
        const STEM_BOT_Y  = 65;
        const BOT_LBL_Y   = 68;
        const LINE_H_PX   = 13;   // approx height per pinned-col line
        const LABEL_W_PX  = 100;

        const wrapper   = document.createElement('div');
        wrapper.className = 'tl-multi-wrapper';

        const labelsCol = document.createElement('div');
        labelsCol.className = 'tl-multi-labels';

        const scroller = document.createElement('div');
        scroller.className = 'tl-multi-scroller';

        // Keep the labels column vertically in sync with the lane scroller
        scroller.addEventListener('scroll', () => {
            labelsCol.scrollTop = scroller.scrollTop;
        });

        const inner = document.createElement('div');
        inner.className   = 'tl-multi-inner';
        inner.style.width = trackPx + 'px';

        tracks.forEach(trackData => {
            // Dynamic lane height: grows to fit the most-pinned entry in this track
            const maxLines = trackData.entries.length === 0 ? 0 :
                Math.max(...trackData.entries.map(e => {
                    const hasMain = !!(e.label || e.recName);
                    return (hasMain ? 1 : 0) + (e.pinnedCols?.length || 0);
                }));
            const laneH = Math.max(LANE_H_MIN, BOT_LBL_Y + maxLines * LINE_H_PX + 16);

            // Left label
            const labelEl = document.createElement('div');
            labelEl.className    = 'tl-multi-label';
            labelEl.style.height = laneH + 'px';
            labelEl.textContent  = trackData.name;
            labelsCol.appendChild(labelEl);

            // Lane
            const lane = document.createElement('div');
            lane.className    = 'tl-track tl-multi-lane';
            lane.style.width  = trackPx + 'px';
            lane.style.height = laneH + 'px';

            const axisEl = document.createElement('div');
            axisEl.className = 'tl-axis';
            axisEl.style.top = AXIS_Y + 'px';
            lane.appendChild(axisEl);

            const sorted = trackData.entries.slice().sort((a, b) => {
                const ta = _parseTime(a.colValue), tb = _parseTime(b.colValue);
                if (ta === null && tb === null) return a.addedAt - b.addedAt;
                if (ta === null) return 1;
                if (tb === null) return -1;
                return ta - tb;
            });

            sorted.forEach(entry => {
                const color = _entryColor(entry);
                const xpx   = pxOf(gPos(entry.colValue));

                const tick = document.createElement('div');
                tick.className  = 'tl-tick';
                tick.dataset.id = entry.id;
                tick.style.left = xpx + 'px';

                const stem = document.createElement('div');
                stem.className    = 'tl-tick__stem';
                stem.style.top    = STEM_TOP_Y + 'px';
                stem.style.height = (STEM_BOT_Y - STEM_TOP_Y) + 'px';

                const dot = document.createElement('div');
                dot.className      = 'tl-tick__dot';
                dot.style.top      = (AXIS_Y - DOT_R) + 'px';
                dot.style.width    = (DOT_R * 2) + 'px';
                dot.style.height   = (DOT_R * 2) + 'px';
                dot.style.background = color;
                dot.style.boxShadow  = `0 0 0 2px ${color}44`;

                const centered = xpx - LABEL_W_PX / 2;
                const clamped  = Math.max(0, Math.min(centered, trackPx - LABEL_W_PX));
                const lblOff   = clamped - xpx;

                const topLbl = document.createElement('div');
                topLbl.className       = 'tl-tick__top';
                topLbl.title           = `${entry.colName}: ${_fmtVal(entry.colValue)}`;
                topLbl.style.top       = LBL_TOP_Y + 'px';
                topLbl.style.height    = LBL_TOP_H + 'px';
                topLbl.style.left      = lblOff + 'px';
                topLbl.style.transform = 'none';
                const colSpan = document.createElement('span');
                colSpan.className   = 'tl-tick__top-col';
                colSpan.textContent = entry.colName;
                const valSpan = document.createElement('span');
                valSpan.className   = 'tl-tick__top-val';
                valSpan.textContent = _fmtVal(entry.colValue);
                topLbl.appendChild(colSpan);
                topLbl.appendChild(valSpan);

                const botLbl = document.createElement('div');
                botLbl.className       = 'tl-tick__bottom';
                botLbl.style.top       = BOT_LBL_Y + 'px';
                botLbl.style.height    = (laneH - BOT_LBL_Y) + 'px';
                botLbl.style.left      = lblOff + 'px';
                botLbl.style.transform = 'none';
                _refreshBotLabel(botLbl, entry);

                tick.appendChild(topLbl);
                tick.appendChild(stem);
                tick.appendChild(dot);
                tick.appendChild(botLbl);

                tick.addEventListener('click', e => {
                    e.stopPropagation();
                    _showTickPeek(entry, tick, color, xpx, trackPx, trackData.isCurrent);
                });

                lane.appendChild(tick);
            });

            lane.addEventListener('click', () => _closeTickPeek());
            inner.appendChild(lane);
        });

        scroller.appendChild(inner);
        wrapper.appendChild(labelsCol);
        wrapper.appendChild(scroller);
        _visualEl.appendChild(wrapper);
    }

    // -------------------------------------------------------------------------
    // Visual timeline screenshot (html2canvas → clipboard / PNG download)
    // -------------------------------------------------------------------------
    /**
     * Captures the full `.tl-track` element (including horizontally scrolled
     * content) as a PNG, writes it to the clipboard, and falls back to a direct
     * download if the Clipboard API is unavailable.
     *
     * Uses the same lazy-load + CSS-patching approach as _screenshotCanvas in
     * canvas.js to handle modern CSS colour functions (oklch, color-mix, etc.)
     * that html2canvas 1.4.1 cannot parse.
     */
    async function _screenshotVisual() {
        if (_viewMode !== 'visual') {
            App.notify?.('Switch to Visual view first.', 'warn');
            return;
        }

        const trackEl = _visualEl?.querySelector('.tl-track');
        if (!trackEl || _st().entries.length === 0) {
            App.notify?.('Nothing to screenshot — add entries first.', 'warn');
            return;
        }

        const btn      = document.getElementById('btn-timeline-screenshot');
        const origText = btn?.textContent;
        if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

        try {
            // ── 1. Lazy-load html2canvas ────────────────────────────────────
            if (!window.html2canvas) {
                await new Promise((resolve, reject) => {
                    const s  = document.createElement('script');
                    s.src    = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
                    s.onload = resolve;
                    s.onerror = () => reject(new Error(
                        'Could not load html2canvas — check your internet connection.'
                    ));
                    document.head.appendChild(s);
                });
            }

            // ── 2. Resolve background colour to a safe rgb() string ─────────
            let bgColor = getComputedStyle(document.documentElement)
                .getPropertyValue('--surface').trim() || '#1e2128';
            try {
                const tmp = document.createElement('canvas');
                tmp.width = tmp.height = 1;
                const ctx = tmp.getContext('2d');
                ctx.fillStyle = bgColor;
                ctx.fillRect(0, 0, 1, 1);
                const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
                bgColor = `rgb(${r},${g},${b})`;
            } catch (_) { /* keep as-is */ }

            // ── 3. Pre-fetch & patch stylesheets (strip color-mix / box-shadow)
            const _colorMixRe  = /color-mix\s*\([^)(]*(?:\([^)(]*\)[^)(]*)*\)/g;
            const _boxShadowRe = /box-shadow\s*:[^;}{]+/g;
            const _patchedCss  = new Map();
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

            // ── 4. Stamp computed colours on every element before capture ───
            //    html2canvas reads computed styles; resolving them now prevents
            //    it from trying (and failing) to parse oklch / color-mix values.
            function _resolveColor(val) {
                if (!val || !/\b(oklch|oklab|lch|lab|color-mix|hwb)\s*\(/.test(val)) return val;
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

            const onclone = (_clonedDoc) => {
                // Swap linked stylesheets → patched inline <style> blocks
                _clonedDoc.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
                    const patched = _patchedCss.get(link.href);
                    if (patched == null) return;
                    const style       = _clonedDoc.createElement('style');
                    style.textContent = patched;
                    link.replaceWith(style);
                });

                // Walk every element inside the cloned track and bake computed
                // colours into inline styles so html2canvas never touches CSS vars.
                const clonedTrack = _clonedDoc.querySelector('.tl-track');
                if (!clonedTrack) return;
                [...clonedTrack.querySelectorAll('*')].forEach((clonedEl, idx) => {
                    const origEl = trackEl.querySelectorAll('*')[idx];
                    if (!origEl) return;
                    const cs = window.getComputedStyle(origEl);
                    [
                        'color', 'background-color', 'border-color',
                        'border-top-color', 'border-bottom-color',
                        'border-left-color', 'border-right-color',
                    ].forEach(prop => {
                        const v = cs.getPropertyValue(prop);
                        if (v) clonedEl.style.setProperty(prop, _resolveColor(v), 'important');
                    });
                    // Remove filters / backdrop-filter that html2canvas mishandles
                    clonedEl.style.setProperty('filter',          'none', 'important');
                    clonedEl.style.setProperty('backdrop-filter', 'none', 'important');
                });
            };

            // ── 5. Capture ──────────────────────────────────────────────────
            const PAD = 20;
            const offscreen = await window.html2canvas(trackEl, {
                x:               -PAD,
                y:               -PAD,
                width:           trackEl.offsetWidth  + PAD * 2,
                height:          trackEl.offsetHeight + PAD * 2,
                backgroundColor: bgColor,
                useCORS:         false,
                allowTaint:      false,
                logging:         false,
                scale:           window.devicePixelRatio || 1,
                onclone,
            });

            // ── 6. Clipboard → fallback download ────────────────────────────
            try {
                const blob = await new Promise(res => offscreen.toBlob(res, 'image/png'));
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                App.notify?.('Timeline screenshot copied to clipboard!', 'success');
            } catch (_) {
                const a      = document.createElement('a');
                a.href       = offscreen.toDataURL('image/png');
                a.download   = `timeline-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
                a.click();
                App.notify?.('Timeline screenshot downloaded.', 'success');
            }

        } catch (err) {
            App.notify?.('Screenshot failed: ' + err.message, 'error');
        } finally {
            if (btn) { btn.textContent = origText; btn.disabled = false; }
        }
    }

    // -------------------------------------------------------------------------
    // -------------------------------------------------------------------------
    // Maximize / restore (identical pattern to Calculus toolbox)
    // -------------------------------------------------------------------------
    function _toggleMaximize() {
        if (_panel.classList.contains('is-maximized')) {
            _restoreMaximize();
        } else {
            // Snapshot inline styles so we can restore them exactly
            _preMaxStyles = {
                top: _panel.style.top, left: _panel.style.left,
                right: _panel.style.right, bottom: _panel.style.bottom,
                width: _panel.style.width, height: _panel.style.height,
                transform: _panel.style.transform,
                maxWidth: _panel.style.maxWidth, maxHeight: _panel.style.maxHeight,
            };
            _panel.classList.add('is-maximized');
            _syncMaximizeGeometry();
            _attachMaximizeWatch();
            const btn = document.getElementById('btn-timeline-maximize');
            if (btn) { btn.textContent = '⤡'; btn.title = 'Restore'; }
        }
    }

    function _restoreMaximize() {
        _detachMaximizeWatch();
        _panel.classList.remove('is-maximized');
        if (_preMaxStyles) {
            Object.assign(_panel.style, _preMaxStyles);
            _preMaxStyles = null;
        }
        const btn = document.getElementById('btn-timeline-maximize');
        if (btn) { btn.textContent = '⤢'; btn.title = 'Maximize'; }
    }

    /** Fill the canvas-wrapper area, clipped by the results panel when visible. */
    function _syncMaximizeGeometry() {
        if (!_panel || !_panel.classList.contains('is-maximized')) return;
        const cw = document.getElementById('canvas-wrapper');
        if (!cw) return;
        const r      = cw.getBoundingClientRect();
        let top    = r.top,  left   = r.left;
        let width  = r.width, height = r.height;

        const rp = document.getElementById('results-panel');
        if (rp && !rp.classList.contains('hidden') && !rp.classList.contains('is-fullscreen')) {
            const rr = rp.getBoundingClientRect();
            if (rr.top < r.bottom && rr.bottom > r.top) {
                const h = rr.top - r.top;
                if (h >= 80) height = h;
            }
        }

        Object.assign(_panel.style, {
            top: Math.round(top) + 'px',       left: Math.round(left) + 'px',
            width: Math.round(width) + 'px',   height: Math.round(height) + 'px',
            right: 'auto',                     bottom: 'auto',
            transform: 'none',
            maxWidth: 'none',                  maxHeight: 'none',
        });
    }

    function _attachMaximizeWatch() {
        _detachMaximizeWatch();
        const sync = () => _syncMaximizeGeometry();
        _maxResizeWinListener = sync;
        window.addEventListener('resize', sync);
        _maxResizeObserver = new ResizeObserver(sync);
        const cw = document.getElementById('canvas-wrapper');
        const rp = document.getElementById('results-panel');
        if (cw) _maxResizeObserver.observe(cw);
        if (rp) _maxResizeObserver.observe(rp);
    }

    function _detachMaximizeWatch() {
        if (_maxResizeObserver)  { _maxResizeObserver.disconnect(); _maxResizeObserver = null; }
        if (_maxResizeWinListener) {
            window.removeEventListener('resize', _maxResizeWinListener);
            _maxResizeWinListener = null;
        }
    }

    // -------------------------------------------------------------------------
    // Panel size, drag, resize (same pattern as recordings panel)
    // -------------------------------------------------------------------------
    function _savePanelSize() {
        if (!_panel) return;
        _st().panelSize = {
            w: Math.round(_panel.offsetWidth),
            h: Math.round(_panel.offsetHeight),
        };
    }
    function _applyPanelSize() {
        if (!_panel) return;
        const s = _st().panelSize;
        if (!s) return;
        if (s.w) { _panel.style.width = s.w + 'px'; _panel.style.maxWidth  = 'none'; }
        if (s.h) { _panel.style.height= s.h + 'px'; _panel.style.maxHeight = 'none'; }
    }
    function _pinPanelPosition() {
        if (!_panel || _panel.style.transform === 'none') return;
        const r = _panel.getBoundingClientRect();
        _panel.style.left      = r.left + 'px';
        _panel.style.top       = r.top  + 'px';
        _panel.style.right     = 'auto';
        _panel.style.bottom    = 'auto';
        _panel.style.transform = 'none';
    }

    function _makeDraggable(handle, panel) {
        if (!handle || !panel) return;
        handle.style.cursor = 'move';
        let ox = 0, oy = 0;
        handle.addEventListener('mousedown', e => {
            if (['BUTTON','INPUT','SELECT'].includes(e.target.tagName)) return;
            e.preventDefault();
            const r = panel.getBoundingClientRect();
            panel.style.left      = r.left + 'px';
            panel.style.top       = r.top  + 'px';
            panel.style.right     = 'auto';
            panel.style.bottom    = 'auto';
            panel.style.transform = 'none';
            ox = e.clientX - r.left;
            oy = e.clientY - r.top;
            const onMove = ev => {
                panel.style.left = (ev.clientX - ox) + 'px';
                panel.style.top  = (ev.clientY - oy) + 'px';
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup',   onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup',   onUp);
        });
    }

    function _makeResizable(panel) {
        if (!panel) return;
        const MIN_W = 420, MIN_H = 180;
        [
            { cls: 'tl-resize-e',  dirE: true,  dirS: false },
            { cls: 'tl-resize-s',  dirE: false, dirS: true  },
            { cls: 'tl-resize-se', dirE: true,  dirS: true  },
        ].forEach(({ cls, dirE, dirS }) => {
            const el = document.createElement('div');
            el.className = `tl-resize-handle ${cls}`;
            panel.appendChild(el);
            el.addEventListener('mousedown', e => {
                e.preventDefault();
                e.stopPropagation();
                _pinPanelPosition();
                const startX = e.clientX, startY = e.clientY;
                const startW = panel.offsetWidth, startH = panel.offsetHeight;
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
                    _savePanelSize();
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup',   onUp);
            });
        });
    }

    // -------------------------------------------------------------------------
    // Tiny helpers
    // -------------------------------------------------------------------------
    function _fmtVal(v) {
        if (v === null || v === undefined) return 'NULL';
        return String(v);
    }
    function _trunc(s, n) {
        s = String(s ?? '');
        return s.length > n ? s.slice(0, n) + '…' : s;
    }
    function _esc(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _newId() {
        return `tl_${Date.now()}_${++_idSeq}_${Math.random().toString(36).slice(2, 6)}`;
    }

    // -------------------------------------------------------------------------
    return { init, toggle, addEntry, refresh };
})();
