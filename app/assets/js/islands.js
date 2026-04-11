/**
 * islands.js — Island visualization: bounding rectangles + radio selection + opacity
 *
 * An "island" is a connected component of tables linked by enabled joins.
 * Single unconnected tables are their own island.
 *
 * Rectangles are always rendered (one per island, including single-table islands).
 *
 * When 2+ islands exist:
 *   - A padded rectangle is drawn behind each island's tables
 *   - A radio button at the top-left allows selecting one island to query
 *   - Selected island → 100% opacity; unselected → 70% opacity
 *   - Interacting with any element of an unselected island auto-selects it
 *
 * When exactly 1 island exists:
 *   - Rectangle still rendered; no opacity changes (nothing to dim)
 *
 * Depends on (runtime): State, App — defined in app.js
 * Load order: app.js → canvas.js → joins.js → islands.js → config.js
 */

const Islands = (() => {

    const PADDING          = 28;  // px of space on the bottom and sides around each island's bounding box
    const PADDING_TOP      = 52;  // px on top: PADDING (28) + island header height (6 top + 18 input = 24)
    const MINIMIZED_HEIGHT = 36;  // px height of collapsed island (header only)

    // Background color palette for island tinting
    const _BG_COLORS = [
        '#7eb8f7', // blue
        '#f6a623', // amber
        '#a67cf4', // purple
        '#4fd1a5', // teal
        '#f47c7c', // coral
        '#f0d060', // yellow
        '#74d680', // green
        '#f78fb3', // pink
    ];

    let _container     = null;  // #island-rects div, first child of #canvas
    let _pinLayer      = null;  // #plot-pin-layer div, sibling of #island-rects
    let _prevIslandKeys = new Set(); // island keys from last recompute (for transition detection)
    let _recomputing    = false;     // reentrance guard

    // Singleton color popup state
    let _islandColorPopup    = null;
    let _islandColorPopupKey = null;

    // Pin container constants
    const PIN_CONTAINER_WIDTH          = 220; // px, wide enough for all header buttons + thumb
    const PIN_CONTAINER_COLLAPSED_WIDTH = 24;  // px when collapsed horizontally (just the toggle button)
    const PIN_CONTAINER_GAP            = 10;  // px between island left edge and container right edge

    // Pin color popup singleton (separate from island color popup)
    let _pinColorPopup    = null;
    let _pinColorPopupEl  = null;    // the .plot-pin element that owns the open popup

    // Collapsed state for each pin container (keyed by island key); ephemeral UI state
    const _pinContainerCollapsed = {};
    const _PIN_COLORS = [
        '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
        '#1abc9c', '#3498db', '#9b59b6', '#e91e63',
    ];

    // Island drag state — moves all tables in an island together
    const _drag = {
        active:         false,
        pending:        false,  // mousedown seen; waiting to confirm it's a drag
        key:            null,
        startX:         0,
        startY:         0,
        startPositions: [],     // [{id, x, y}] snapshot at drag start
    };

    // =========================================================================
    // Init — create the container layer
    // =========================================================================
    function init() {
        _container = document.createElement('div');
        _container.id = 'island-rects';

        _pinLayer = document.createElement('div');
        _pinLayer.id = 'plot-pin-layer';

        // Insert as first child of canvas so it sits below the SVG join lines
        // and all table cards (DOM order determines stacking for z-index: auto).
        const canvas = document.getElementById('canvas');
        canvas.insertBefore(_pinLayer, canvas.firstChild);
        canvas.insertBefore(_container, _pinLayer);

        document.addEventListener('mousemove', _onDragMove);
        document.addEventListener('mouseup',   _onDragUp);
    }

    // =========================================================================
    // recompute — main entry point called after any state change
    // =========================================================================
    function recompute() {
        if (!_container || _recomputing) return;
        _recomputing = true;

        try {
            const enabledJoins   = State.joins.filter(j => j.enabled !== false);
            const islands        = App.computeIslands(State.tables, enabledJoins);
            const newIslandKeys  = new Set(islands.map(_islandKey));

            // Detect island composition changes and notify app for config merge/split
            if (!_setsEqual(_prevIslandKeys, newIslandKeys)) {
                if (typeof App !== 'undefined' && App.onIslandTransition) {
                    App.onIslandTransition([..._prevIslandKeys], [...newIslandKeys]);
                }
                _prevIslandKeys = new Set(newIslandKeys);
            }

            // Validate selectedIslandKey still corresponds to a real island
            if (State.selectedIslandKey) {
                const selIds      = new Set(State.selectedIslandKey.split('|'));
                const stillExists = islands.some(
                    g => g.length === selIds.size && g.every(id => selIds.has(id))
                );
                if (!stillExists) State.selectedIslandKey = null;
            }

            if (islands.length === 0) {
                _container.innerHTML = '';
                return;
            }

            _renderRects(islands);
            _applyOpacity(State.selectedIslandKey, islands);
            _applyMinimizedVisibility(islands);
            _renderPinContainers(islands);
        } finally {
            _recomputing = false;
        }
    }

    function _setsEqual(a, b) {
        if (a.size !== b.size) return false;
        for (const k of a) if (!b.has(k)) return false;
        return true;
    }

    // =========================================================================
    // redrawPositions — fast path during table drag (only reposition rects)
    // =========================================================================
    function redrawPositions() {
        if (!_container) return;

        const enabledJoins = State.joins.filter(j => j.enabled !== false);
        const islands      = App.computeIslands(State.tables, enabledJoins);
        if (islands.length === 0) return;

        islands.forEach(islandIds => {
            const key  = _islandKey(islandIds);
            const rect = _container.querySelector(`.island-rect[data-island-key="${CSS.escape(key)}"]`);
            if (!rect) return;
            const bbox = _boundingBox(islandIds);
            if (!bbox) return;
            const isMinimized = State.islandMinimized?.[key];
            const rectH = isMinimized ? MINIMIZED_HEIGHT : (bbox.h + PADDING_TOP + PADDING);
            rect.style.left   = (bbox.x - PADDING) + 'px';
            rect.style.top    = (bbox.y - PADDING_TOP) + 'px';
            rect.style.width  = (bbox.w + PADDING * 2) + 'px';
            rect.style.height = rectH + 'px';

            // Keep pin container in sync
            _updatePinContainerGeometry(key, bbox.x - PADDING, bbox.y - PADDING_TOP, rectH);
        });
    }

    // =========================================================================
    // selectIsland — public; selects an island by key and blits state
    // =========================================================================
    function selectIsland(key) {
        const changed = State.selectedIslandKey !== key;
        if (changed) {
            // Flush outgoing island's config while selectedIslandKey still points to it
            if (typeof App !== 'undefined' && App.flushCurrentIslandConfig) {
                App.flushCurrentIslandConfig();
            }
            State.selectedIslandKey = key;
        }
        // Always blit to ensure right pane reflects the active island
        if (typeof App !== 'undefined' && App.blitIslandConfig) {
            App.blitIslandConfig(key);
        } else {
            App.updateSQLPreview();
        }
        // Only re-render rects when the selected island changed (avoids destroying
        // focused inputs, e.g. the label input, when clicking the same island)
        if (changed) recompute();
    }

    // =========================================================================
    // onTableMousedown — auto-select island when user touches a table card
    // =========================================================================
    function onTableMousedown(tableId) {
        State.lastInteractedTableId = tableId;

        const enabledJoins = State.joins.filter(j => j.enabled !== false);
        const islands      = App.computeIslands(State.tables, enabledJoins);

        const island = islands.find(g => g.includes(tableId));
        if (!island) return;
        const key = _islandKey(island);
        if (State.selectedIslandKey !== key) selectIsland(key);
    }

    // =========================================================================
    // onJoinInteract — auto-select island when user clicks a join line.
    // Exception: disabled joins bridging two different islands → no auto-select.
    // =========================================================================
    function onJoinInteract(join) {
        if (join.enabled === false) {
            const enabledJoins = State.joins.filter(j => j.enabled !== false);
            const islands      = App.computeIslands(State.tables, enabledJoins);
            if (islands.length > 1) {
                const fromIsland = islands.find(g => g.includes(join.fromTableId));
                const toIsland   = islands.find(g => g.includes(join.toTableId));
                if (fromIsland !== toIsland) return; // cross-island disabled join
            }
        }
        onTableMousedown(join.fromTableId);
    }

    // =========================================================================
    // Island drag — move all tables in an island together
    // =========================================================================
    function _onDragMove(e) {
        if (!_drag.active && !_drag.pending) return;

        const dx = e.clientX - _drag.startX;
        const dy = e.clientY - _drag.startY;

        // Promote pending → active once mouse moves more than 4px
        if (_drag.pending && Math.hypot(dx, dy) < 4) return;
        if (_drag.pending) {
            _drag.pending = false;
            _drag.active  = true;
            document.getElementById('canvas-wrapper').style.cursor = 'grabbing';
        }

        const scale = (typeof Canvas !== 'undefined' && Canvas.getContentScale)
            ? Canvas.getContentScale()
            : 1;

        // Move every table in the island (dx/dy are screen pixels → logical canvas space)
        _drag.startPositions.forEach(({ id, x, y }) => {
            const card = document.querySelector(`.table-card[data-table-id="${id}"]`);
            if (!card) return;
            card.style.left = Math.max(0, x + dx / scale) + 'px';
            card.style.top  = Math.max(0, y + dy / scale) + 'px';
            if (typeof Joins !== 'undefined') Joins.redrawForTable(id);
        });

        redrawPositions();
    }

    function _onDragUp() {
        if (!_drag.active && !_drag.pending) return;

        if (_drag.active) {
            if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
            // Persist final positions to State
            _drag.startPositions.forEach(({ id }) => {
                const card = document.querySelector(`.table-card[data-table-id="${id}"]`);
                const t    = State.tables.find(t => t.id === id);
                if (card && t) {
                    t.position = {
                        x: parseInt(card.style.left, 10) || 0,
                        y: parseInt(card.style.top,  10) || 0,
                    };
                }
            });
            document.getElementById('canvas-wrapper').style.cursor = '';
            recompute();
        }

        _drag.active         = false;
        _drag.pending        = false;
        _drag.key            = null;
        _drag.startPositions = [];
    }

    // =========================================================================
    // Private: render island rectangles
    // =========================================================================
    function _renderRects(islands) {
        _container.innerHTML = '';

        islands.forEach(islandIds => {
            const key         = _islandKey(islandIds);
            const isSelected  = State.selectedIslandKey === key;
            const isMinimized = State.islandMinimized?.[key] ?? false;
            const bbox        = _boundingBox(islandIds);
            if (!bbox) return;

            const rect = document.createElement('div');
            rect.className        = 'island-rect' + (isSelected ? ' island-rect--selected' : '');
            rect.dataset.islandKey = key;
            rect.style.left   = (bbox.x - PADDING) + 'px';
            rect.style.top    = (bbox.y - PADDING_TOP) + 'px';
            rect.style.width  = (bbox.w + PADDING * 2) + 'px';
            rect.style.height = isMinimized ? MINIMIZED_HEIGHT + 'px' : (bbox.h + PADDING_TOP + PADDING) + 'px';
            rect.style.overflow = 'hidden';
            const _islandLabel = State.islandNames?.[key] ?? '';
            rect.title = _islandLabel;
            rect.alt   = _islandLabel;

            // Header row: radio + name input + color dot + minimize + close
            const header = document.createElement('div');
            header.className = 'island-header';

            const radio = document.createElement('div');
            radio.className = 'island-radio' + (isSelected ? ' island-radio--selected' : '');
            header.appendChild(radio);

            const labelInput = document.createElement('input');
            labelInput.type        = 'text';
            labelInput.className   = 'island-label-input';
            labelInput.placeholder = 'Island name…';
            labelInput.value       = State.islandNames?.[key] ?? '';
            labelInput.addEventListener('mousedown', e => {
                e.stopPropagation();
                const wasSelected = State.selectedIslandKey === key;
                selectIsland(key);
                // If the island wasn't active, selectIsland() triggered a full re-render
                // which replaced this very input element with a new one. Focus the new one.
                if (!wasSelected) {
                    requestAnimationFrame(() => {
                        const newInput = _container?.querySelector(
                            `.island-rect[data-island-key="${CSS.escape(key)}"] .island-label-input`
                        );
                        newInput?.focus();
                    });
                }
            });
            labelInput.addEventListener('focus', () => { selectIsland(key); if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot(); });
            labelInput.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === 'Escape') e.target.blur();
            });
            labelInput.addEventListener('input', () => {
                if (!State.islandNames || Array.isArray(State.islandNames)) State.islandNames = {};
                State.islandNames[key] = labelInput.value;
                rect.title = labelInput.value;
                rect.alt   = labelInput.value;
            });
            // Right-click / Alt+E → open extended note popup (islandNotesDetail)
            if (typeof App !== 'undefined' && App.bindNotePopup) {
                App.bindNotePopup(
                    labelInput,
                    () => {
                        const name = (State.islandNames?.[key] ?? '').trim();
                        return 'NOTE — ' + (name || islandIds.length + ' tables');
                    },
                    () => {
                        if (!State.islandNotesDetail) State.islandNotesDetail = {};
                        return State.islandNotesDetail[key] ?? '';
                    },
                    val => {
                        if (!State.islandNotesDetail || Array.isArray(State.islandNotesDetail)) State.islandNotesDetail = {};
                        State.islandNotesDetail[key] = val;
                    },
                    () => labelInput.focus(),
                    () => typeof App !== 'undefined' && App.saveLoadedContext?.()
                );
            }
            header.appendChild(labelInput);

            // Color dot — opens background color picker
            const colorDot = document.createElement('div');
            colorDot.className = 'island-color-dot';
            const savedColor = State.islandColors?.[key] ?? null;
            if (savedColor) {
                colorDot.style.background = savedColor;
                colorDot.classList.add('has-color');
            }
            colorDot.addEventListener('mousedown', e => { e.stopPropagation(); selectIsland(key); });
            colorDot.addEventListener('click', e => {
                e.stopPropagation();
                _openIslandColorPopup(key, colorDot, rect);
            });
            header.appendChild(colorDot);

            // Tree-layout button — rearranges this island's tables as a binary tree
            const treeBtn = document.createElement('button');
            treeBtn.className   = 'island-tree-btn';
            treeBtn.textContent = '⊤';
            treeBtn.title       = 'Arrange tables as binary tree';
            treeBtn.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });
            treeBtn.addEventListener('click', async e => {
                e.stopPropagation();

                if (!await Dialog.confirm('Arrange table as binary tree?')) {
                    return;
                }

                if (typeof Canvas !== 'undefined' && Canvas.arrangeBinaryTree) {
                    Canvas.arrangeBinaryTree(islandIds);
                }
            });
            header.appendChild(treeBtn);

            // Minimize button — collapses the island to its header
            const minimizeBtn = document.createElement('button');
            minimizeBtn.className   = 'island-minimize-btn';
            minimizeBtn.textContent = isMinimized ? '▲' : '▼';
            minimizeBtn.title       = isMinimized ? 'Restore island' : 'Minimize island';
            minimizeBtn.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });
            minimizeBtn.addEventListener('click', e => {
                e.stopPropagation();
                _toggleMinimize(key, islandIds);
            });
            header.appendChild(minimizeBtn);

            // Close button — removes all tables in the island after confirmation
            const closeBtn = document.createElement('button');
            closeBtn.className   = 'island-close-btn';
            closeBtn.textContent = '✕';
            closeBtn.title       = 'Close island — removes all its tables from the canvas';
            closeBtn.addEventListener('mousedown', async e => {
                e.stopPropagation();
                e.preventDefault();
                const name  = (State.islandNames?.[key] ?? '').trim();
                const count = islandIds.length;
                const label = name || 'this island';
                const noun  = count === 1 ? 'table' : 'tables';
                if (!await Dialog.confirm(`Close ${label}?\n\nAll ${count} ${noun} will be removed from the canvas.`)) return;
                if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                // Snapshot the ids first — state mutates as each table is removed
                [...islandIds].forEach(id => {
                    if (typeof Canvas !== 'undefined') Canvas.removeTableById(id);
                });
            });
            header.appendChild(closeBtn);

            header.addEventListener('touchstart', () => selectIsland(key), { capture: true, passive: true });
            rect.appendChild(header);
            _applyIslandColor(rect, key);

            // Right-click on island background pans the canvas instead of dragging the island
            rect.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
            });

            // Mousedown: select island + begin drag tracking
            rect.addEventListener('mousedown', e => {
                if (e.button === 2) {
                    e.stopPropagation();
                    if (typeof Canvas !== 'undefined') Canvas.startPan(e);
                    return;
                }
                if (e.button !== 0) return;
                // Cut-and-place completes on document click (canvas.js). This handler's
                // preventDefault() suppresses the synthetic click on island backgrounds in
                // most browsers, so paste never ran when targeting another island's rect.
                // Skip interception for non-control hits while cut mode is active.
                if (document.body.classList.contains('is-cut-mode') &&
                        !e.target.closest('button, input, select')) {
                    return;
                }
                e.stopPropagation();
                e.preventDefault();

                // Blur any focused join label input before taking focus
                document.querySelector('.join-line-label-inp:focus')?.blur();

                selectIsland(key);

                // Start drag (pending until mouse moves > 4px)
                const tableIds = key.split('|');
                _drag.pending        = true;
                _drag.key            = key;
                _drag.startX         = e.clientX;
                _drag.startY         = e.clientY;
                _drag.startPositions = tableIds.map(id => {
                    const card = document.querySelector(`.table-card[data-table-id="${id}"]`);
                    return {
                        id,
                        x: parseInt(card?.style.left, 10) || 0,
                        y: parseInt(card?.style.top,  10) || 0,
                    };
                });
            });

            _container.appendChild(rect);
        });
    }

    // =========================================================================
    // Private: toggle minimized state for an island
    // =========================================================================
    function _toggleMinimize(key, islandIds) {
        if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
        if (!State.islandMinimized || Array.isArray(State.islandMinimized)) State.islandMinimized = {};
        if (State.islandMinimized[key]) {
            delete State.islandMinimized[key];
        } else {
            State.islandMinimized[key] = true;
        }
        recompute();
    }

    // =========================================================================
    // Private: hide/show table cards and join lines for minimized islands
    // =========================================================================
    function _applyMinimizedVisibility(islands) {
        const hiddenTableIds = new Set();
        islands.forEach(islandIds => {
            const key = _islandKey(islandIds);
            if (State.islandMinimized?.[key]) {
                islandIds.forEach(id => hiddenTableIds.add(id));
            }
        });

        State.tables.forEach(t => {
            const card = document.querySelector(`.table-card[data-table-id="${t.id}"]`);
            if (card) card.style.visibility = hiddenTableIds.has(t.id) ? 'hidden' : '';
        });

        State.joins.forEach(j => {
            const hidden = hiddenTableIds.has(j.fromTableId) || hiddenTableIds.has(j.toTableId);
            const path  = document.getElementById('jpath-'  + j.id);
            const label = document.getElementById('jlabel-' + j.id);
            if (path)  path.style.visibility = hidden ? 'hidden' : '';
            if (label) label.style.visibility = hidden ? 'hidden' : '';
        });
    }

    // =========================================================================
    // Private: apply opacity to table cards and join lines
    // =========================================================================
    function _applyOpacity(selectedKey, islands) {
        if (!selectedKey || islands.length <= 1) {
            // All elements at full opacity
            document.querySelectorAll('.table-card')
                .forEach(el => { el.style.opacity = ''; el.style.transition = ''; });
            State.joins.forEach(j => {
                const path  = document.getElementById('jpath-'  + j.id);
                const label = document.getElementById('jlabel-' + j.id);
                if (path)  { path.style.opacity  = ''; path.style.transition  = ''; }
                if (label) { label.style.opacity = ''; label.style.transition = ''; }
            });
            return;
        }

        const selectedIds = new Set(selectedKey.split('|'));

        // Table cards
        State.tables.forEach(t => {
            const card = document.querySelector(`.table-card[data-table-id="${t.id}"]`);
            if (!card) return;
            card.style.transition = 'opacity 0.15s ease';
            card.style.opacity    = selectedIds.has(t.id) ? '' : '0.7';
        });

        // Join lines (path + label group)
        State.joins.forEach(j => {
            const inSelected = selectedIds.has(j.fromTableId) && selectedIds.has(j.toTableId);
            const opacity    = inSelected ? '' : '0.7';
            const path  = document.getElementById('jpath-'  + j.id);
            const label = document.getElementById('jlabel-' + j.id);
            if (path) {
                path.style.transition = 'opacity 0.15s ease';
                path.style.opacity    = opacity;
            }
            if (label) {
                label.style.transition = 'opacity 0.15s ease';
                label.style.opacity    = opacity;
            }
        });
    }

    // =========================================================================
    // Island background color popup
    // =========================================================================
    function _hexToRgbComponents(hex) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `${r}, ${g}, ${b}`;
    }

    function _applyIslandColor(rectEl, key) {
        const color = State.islandColors?.[key] ?? null;
        if (color) {
            rectEl.style.setProperty('--island-color-rgb', _hexToRgbComponents(color));
        } else {
            rectEl.style.removeProperty('--island-color-rgb');
        }
    }

    function _openIslandColorPopup(key, dotEl, rectEl) {
        if (_islandColorPopup && _islandColorPopupKey === key) {
            _closeIslandColorPopup();
            return;
        }
        _closeIslandColorPopup();
        _islandColorPopupKey = key;

        _islandColorPopup = document.createElement('div');
        _islandColorPopup.className = 'island-color-popup';

        const swatchWrap = document.createElement('div');
        swatchWrap.className = 'island-color-swatches';
        const currentColor = State.islandColors?.[key] ?? null;
        _BG_COLORS.forEach(hex => {
            const swatch = document.createElement('button');
            swatch.className = 'island-color-swatch';
            swatch.style.background = hex;
            if (currentColor === hex) swatch.classList.add('is-active');
            swatch.addEventListener('click', e => {
                e.stopPropagation();
                if (typeof UndoRedo !== 'undefined') UndoRedo.snapshot();
                if (!State.islandColors || Array.isArray(State.islandColors)) State.islandColors = {};
                State.islandColors[key] = hex;
                _applyIslandColor(rectEl, key);
                dotEl.style.background = hex;
                dotEl.classList.add('has-color');
                _closeIslandColorPopup();
            });
            swatchWrap.appendChild(swatch);
        });

        const resetBtn = document.createElement('button');
        resetBtn.className = 'island-color-reset-bg';
        resetBtn.textContent = '✕ Auto color';
        resetBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (State.islandColors) delete State.islandColors[key];
            _applyIslandColor(rectEl, key);
            dotEl.style.background = '';
            dotEl.classList.remove('has-color');
            _closeIslandColorPopup();
        });

        _islandColorPopup.appendChild(swatchWrap);
        _islandColorPopup.appendChild(resetBtn);
        document.body.appendChild(_islandColorPopup);

        const r   = dotEl.getBoundingClientRect();
        const popW = 118;
        let left = r.left + r.width / 2 - popW / 2;
        let top  = r.bottom + 6;
        if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
        if (left < 8) left = 8;
        _islandColorPopup.style.left = left + 'px';
        _islandColorPopup.style.top  = top  + 'px';

        setTimeout(() => {
            document.addEventListener('click', _closeIslandColorPopup, { once: true });
        }, 0);
    }

    function _closeIslandColorPopup() {
        if (_islandColorPopup) {
            _islandColorPopup.remove();
            _islandColorPopup    = null;
            _islandColorPopupKey = null;
        }
    }

    // =========================================================================
    // Private: compute bounding box from a list of table IDs
    // Reads live DOM positions/sizes so it stays accurate during drag and resize
    // (State.tables[x].position/size are only flushed at mouseup).
    // =========================================================================
    function _boundingBox(islandIds) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let found = false;

        islandIds.forEach(id => {
            const card = document.querySelector(`.table-card[data-table-id="${id}"]`);
            if (!card) return;
            found = true;
            const x = parseInt(card.style.left, 10) || 0;
            const y = parseInt(card.style.top,  10) || 0;
            const w = card.offsetWidth;
            const h = card.offsetHeight;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + w);
            maxY = Math.max(maxY, y + h);
        });

        return found ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
    }

    // =========================================================================
    // Private: stable island key = sorted table IDs joined with '|'
    // =========================================================================
    function _islandKey(islandIds) {
        return [...islandIds].sort().join('|');
    }

    // =========================================================================
    // Pin containers — full management
    // =========================================================================

    /** Fast-path geometry update for one island's pin container (called during drag). */
    function _updatePinContainerGeometry(key, islandLeft, islandTop, islandHeight) {
        if (!_pinLayer) return;
        const container = _pinLayer.querySelector(`.plot-pin-container[data-island-key="${CSS.escape(key)}"]`);
        if (!container) return;
        const w = _pinContainerCollapsed[key] ? PIN_CONTAINER_COLLAPSED_WIDTH : PIN_CONTAINER_WIDTH;
        container.style.left   = (islandLeft - w - PIN_CONTAINER_GAP) + 'px';
        container.style.top    = islandTop + 'px';
        container.style.height = islandHeight + 'px';
    }

    /**
     * Called from recompute() — creates, updates geometry and content of all pin containers.
     * Containers for keys that no longer exist as islands are removed.
     */
    function _renderPinContainers(islands) {
        if (!_pinLayer) return;

        const activeKeys = new Set(islands.map(_islandKey));

        // Remove containers for islands that no longer exist
        _pinLayer.querySelectorAll('.plot-pin-container').forEach(el => {
            if (!activeKeys.has(el.dataset.islandKey)) el.remove();
        });

        islands.forEach(islandIds => {
            const key  = _islandKey(islandIds);
            const pins = State.islandPinnedPlots?.[key];

            if (!pins || pins.length === 0) {
                _pinLayer.querySelector(`.plot-pin-container[data-island-key="${CSS.escape(key)}"]`)?.remove();
                return;
            }

            const bbox        = _boundingBox(islandIds);
            if (!bbox) return;

            const isMinimized = State.islandMinimized?.[key];
            const islandLeft  = bbox.x - PADDING;
            const islandTop   = bbox.y - PADDING_TOP;
            const islandH     = isMinimized ? MINIMIZED_HEIGHT : (bbox.h + PADDING_TOP + PADDING);

            let container = _pinLayer.querySelector(`.plot-pin-container[data-island-key="${CSS.escape(key)}"]`);
            if (!container) {
                container = _buildPinContainer(key);
                _pinLayer.appendChild(container);
            }

            // Geometry — width depends on collapsed state
            const cw = _pinContainerCollapsed[key] ? PIN_CONTAINER_COLLAPSED_WIDTH : PIN_CONTAINER_WIDTH;
            container.style.left   = (islandLeft - cw - PIN_CONTAINER_GAP) + 'px';
            container.style.top    = islandTop + 'px';
            container.style.width  = cw + 'px';
            container.style.height = islandH + 'px';

            // Rebuild scroll area content (cheap; only invoked on full recompute)
            _rebuildPinScrollArea(container, key);
        });
    }

    /** Build the outer container element with header controls (sort + close-all). */
    function _buildPinContainer(key) {
        const container = document.createElement('div');
        container.className = 'plot-pin-container';
        container.dataset.islandKey = key;
        container.style.width = PIN_CONTAINER_WIDTH + 'px';

        // Header
        const header = document.createElement('div');
        header.className = 'plot-pin-container-header';

        const isCollapsed = !!_pinContainerCollapsed[key];
        if (isCollapsed) container.classList.add('collapsed');

        const collapseBtn = document.createElement('button');
        collapseBtn.className   = 'plot-pin-collapse-btn';
        collapseBtn.textContent = isCollapsed ? '◀' : '▶';
        collapseBtn.title       = isCollapsed ? 'Restore container' : 'Collapse container';
        collapseBtn.addEventListener('click', e => {
            e.stopPropagation();
            const nowCollapsed = container.classList.toggle('collapsed');
            _pinContainerCollapsed[key] = nowCollapsed;
            collapseBtn.textContent = nowCollapsed ? '◀' : '▶';
            collapseBtn.title       = nowCollapsed ? 'Restore container' : 'Collapse container';
            // Reposition immediately so the container right-edge stays flush with the island
            const islandRect = _container.querySelector(`.island-rect[data-island-key="${CSS.escape(key)}"]`);
            if (islandRect) {
                const islandLeft = parseInt(islandRect.style.left, 10) || 0;
                const w = nowCollapsed ? PIN_CONTAINER_COLLAPSED_WIDTH : PIN_CONTAINER_WIDTH;
                container.style.left  = (islandLeft - w - PIN_CONTAINER_GAP) + 'px';
                container.style.width = w + 'px';
            }
        });

        const sortBtn = document.createElement('button');
        sortBtn.className = 'plot-pin-sort-btn';
        const _sortLabel = o => o === 'asc' ? '↑ Oldest first' : o === 'custom' ? '↕ Manual' : '↓ Newest first';
        const order = State.islandPinSortOrder?.[key] ?? 'desc';
        sortBtn.textContent = _sortLabel(order);
        sortBtn.title = 'Toggle sort order';
        sortBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (!State.islandPinSortOrder) State.islandPinSortOrder = {};
            const cur = State.islandPinSortOrder[key] ?? 'desc';
            // custom → desc → asc → desc …
            State.islandPinSortOrder[key] = cur === 'asc' ? 'desc' : 'asc';
            sortBtn.textContent = _sortLabel(State.islandPinSortOrder[key]);
            _rebuildPinScrollArea(container, key);
        });

        const closeAllBtn = document.createElement('button');
        closeAllBtn.className = 'plot-pin-close-all-btn';
        closeAllBtn.textContent = '✕ All';
        closeAllBtn.title = 'Close all pinned plots for this island';
        closeAllBtn.addEventListener('click', async e => {
            e.stopPropagation();
            if (!await Dialog.confirm('Close all plots pinned to this island?')) return;
            if (State.islandPinnedPlots) delete State.islandPinnedPlots[key];
            delete _pinContainerCollapsed[key];
            container.remove();
        });

        const popupBtn = document.createElement('button');
        popupBtn.className   = 'plot-pin-popup-btn';
        popupBtn.textContent = '⤢';
        popupBtn.title       = 'Open in popup';
        popupBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (typeof Modals !== 'undefined' && Modals.openPinContainer) {
                Modals.openPinContainer(key);
            }
        });

        header.appendChild(collapseBtn);
        header.appendChild(popupBtn);
        header.appendChild(sortBtn);
        header.appendChild(closeAllBtn);
        container.appendChild(header);

        // Scroll area (content filled by _rebuildPinScrollArea)
        const scrollArea = document.createElement('div');
        scrollArea.className = 'plot-pin-scroll-area';
        container.appendChild(scrollArea);

        return container;
    }

    /** Rebuild the pins DOM inside a container's scroll area from state. */
    function _rebuildPinScrollArea(container, key) {
        const scrollArea = container.querySelector('.plot-pin-scroll-area');
        if (!scrollArea) return;
        scrollArea.innerHTML = '';

        const pins  = State.islandPinnedPlots?.[key] ?? [];
        const order = State.islandPinSortOrder?.[key] ?? 'desc';
        const sorted = order === 'custom'
            ? [...pins]
            : [...pins].sort((a, b) =>
                order === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt
            );

        sorted.forEach(pinData => {
            const pinEl = _buildPinEl(pinData, key);
            scrollArea.appendChild(pinEl);
        });
    }

    /** Build one .plot-pin element for a given pin data object. */
    function _buildPinEl(pinData, islandKey) {
        const pinEl = document.createElement('div');
        pinEl.className = 'plot-pin';
        if (pinData.minimized) pinEl.classList.add('minimized');
        if (pinData.borderColor) {
            pinEl.style.border = `3px solid ${pinData.borderColor}`;
        }

        // --- Header ---
        const hdr = document.createElement('div');
        hdr.className = 'plot-pin-header';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'plot-pin-title';
        titleSpan.textContent = pinData.title || 'Plot';
        titleSpan.title = pinData.title || 'Plot';

        const colorBtn = document.createElement('button');
        colorBtn.className = 'plot-pin-color-btn';
        colorBtn.title = 'Set border colour';
        colorBtn.innerHTML = '&#11044;'; // ⬤
        if (pinData.borderColor) colorBtn.style.color = pinData.borderColor;
        colorBtn.addEventListener('click', e => {
            e.stopPropagation();
            _openPinColorPopup(pinEl, pinData, colorBtn);
        });

        const minimizeBtn = document.createElement('button');
        minimizeBtn.className = 'plot-pin-minimize-btn';
        minimizeBtn.textContent = '–';
        minimizeBtn.title = pinData.minimized ? 'Restore' : 'Minimize';
        minimizeBtn.addEventListener('click', e => {
            e.stopPropagation();
            pinData.minimized = !pinData.minimized;
            pinEl.classList.toggle('minimized', pinData.minimized);
            minimizeBtn.title = pinData.minimized ? 'Restore' : 'Minimize';
        });

        const closeBtn = document.createElement('button');
        closeBtn.className = 'plot-pin-close-btn';
        closeBtn.textContent = '✕';
        closeBtn.title = 'Close this plot';
        closeBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (!State.islandPinnedPlots?.[islandKey]) return;
            const idx = State.islandPinnedPlots[islandKey].indexOf(pinData);
            if (idx !== -1) State.islandPinnedPlots[islandKey].splice(idx, 1);
            pinEl.remove();
            // Remove container if no pins left
            if (State.islandPinnedPlots[islandKey].length === 0) {
                delete State.islandPinnedPlots[islandKey];
                pinEl.closest('.plot-pin-container')?.remove();
            }
        });

        hdr.appendChild(titleSpan);
        hdr.appendChild(colorBtn);
        hdr.appendChild(minimizeBtn);
        hdr.appendChild(closeBtn);
        pinEl.appendChild(hdr);

        // --- Body (thumbnail) ---
        const body = document.createElement('div');
        body.className = 'plot-pin-body';

        const thumb = document.createElement('img');
        thumb.className = 'plot-pin-thumb';
        thumb.src = pinData.dataUrl;
        thumb.alt = pinData.title || 'Plot';
        thumb.width  = 160;
        thumb.height = 120;
        thumb.title  = 'Click to view full plot';
        thumb.addEventListener('click', e => {
            e.stopPropagation();
            if (typeof Modals !== 'undefined' && Modals.openPlotFromDataUrl) {
                Modals.openPlotFromDataUrl(pinData.dataUrl, pinData.title);
            }
        });

        body.appendChild(thumb);
        pinEl.appendChild(body);

        return pinEl;
    }

    // =========================================================================
    // Pin color popup
    // =========================================================================
    function _openPinColorPopup(pinEl, pinData, colorBtnEl) {
        // Toggle off if already open for this pin
        if (_pinColorPopup && _pinColorPopupEl === pinEl) {
            _closePinColorPopup();
            return;
        }
        _closePinColorPopup();
        _pinColorPopupEl = pinEl;

        _pinColorPopup = document.createElement('div');
        _pinColorPopup.className = 'island-color-popup'; // reuse same styles

        const swatchWrap = document.createElement('div');
        swatchWrap.className = 'island-color-swatches';

        _PIN_COLORS.forEach(hex => {
            const swatch = document.createElement('button');
            swatch.className = 'island-color-swatch';
            swatch.style.background = hex;
            if (pinData.borderColor === hex) swatch.classList.add('is-active');
            swatch.addEventListener('click', e => {
                e.stopPropagation();
                pinData.borderColor = hex;
                pinEl.style.border = `3px solid ${hex}`;
                colorBtnEl.style.color = hex;
                _closePinColorPopup();
            });
            swatchWrap.appendChild(swatch);
        });

        const resetBtn = document.createElement('button');
        resetBtn.className = 'island-color-reset-bg';
        resetBtn.textContent = '✕ No border';
        resetBtn.addEventListener('click', e => {
            e.stopPropagation();
            pinData.borderColor = null;
            pinEl.style.border = '';
            colorBtnEl.style.color = '';
            _closePinColorPopup();
        });

        _pinColorPopup.appendChild(swatchWrap);
        _pinColorPopup.appendChild(resetBtn);
        document.body.appendChild(_pinColorPopup);

        const r    = colorBtnEl.getBoundingClientRect();
        const popW = 118;
        let left = r.left + r.width / 2 - popW / 2;
        let top  = r.bottom + 6;
        if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
        if (left < 8) left = 8;
        _pinColorPopup.style.left = left + 'px';
        _pinColorPopup.style.top  = top  + 'px';

        setTimeout(() => {
            document.addEventListener('click', _closePinColorPopup, { once: true });
        }, 0);
    }

    function _closePinColorPopup() {
        if (_pinColorPopup) {
            _pinColorPopup.remove();
            _pinColorPopup   = null;
            _pinColorPopupEl = null;
        }
    }

    // =========================================================================
    // Public: add a new pin to an island
    // =========================================================================
    function pinPlot(islandKey, dataUrl, title) {
        if (!State.islandPinnedPlots) State.islandPinnedPlots = {};
        if (!State.islandPinnedPlots[islandKey]) State.islandPinnedPlots[islandKey] = [];
        State.islandPinnedPlots[islandKey].push({
            dataUrl,
            title:       title || 'Plot',
            minimized:   false,
            createdAt:   Date.now(),
            borderColor: null,
        });
        recompute();
    }

    // =========================================================================
    // Public: rebuild all pin containers from state (called after applyContext)
    // =========================================================================
    function renderAllPinContainers() {
        if (!_pinLayer || !_container) return;
        const enabledJoins = State.joins.filter(j => j.enabled !== false);
        const islands      = App.computeIslands(State.tables, enabledJoins);
        _renderPinContainers(islands);
    }

    // =========================================================================
    // Public surface
    // =========================================================================
    return {
        init,
        recompute,
        redrawPositions,
        selectIsland,
        onTableMousedown,
        onJoinInteract,
        pinPlot,
        renderAllPinContainers,
    };

})();

document.addEventListener('DOMContentLoaded', () => Islands.init());
