/**
 * SqlBackdrop — live SQL syntax-highlighting backdrop for <textarea> elements.
 *
 * The textarea remains fully editable; a <pre> sits behind it with colored
 * text that perfectly lines up with the textarea's characters.
 *
 * ── How to enable / disable a textarea ───────────────────────────────────────
 *
 *  Static  (defined in index.php):
 *    Enable  → add     data-sql-backdrop   attribute to the <textarea>
 *    Disable → remove  data-sql-backdrop   attribute from the <textarea>
 *
 *  Dynamic (created in JavaScript):
 *    Enable  → SqlBackdrop.attach(element)
 *    Disable → SqlBackdrop.detach(element)
 *
 * ── Scope mode ────────────────────────────────────────────────────────────────
 *
 *  SqlBackdrop.toggleScopeMode(ta)      — turn scope mode on/off for a textarea
 *  SqlBackdrop.setExclusiveMode(ta, v)  — when true, only one scope at a time
 *  SqlBackdrop.onExtractScope           — assign a callback(sql, alias) to
 *                                         handle Alt+click → create subquery
 *  Alt+right-click (scope mode on)     — copy all highlighted scopes to clipboard
 *
 * ── Line colours ─────────────────────────────────────────────────────────────
 *
 *  Right-click a line to cycle through 4 colours (yellow→green→blue→red→none).
 *  Colours are independent of scope mode and survive scope toggles.
 *  Typing in the textarea clears all line colour annotations.
 *  Arrow-Up / Arrow-Down while the cursor is on a coloured line jumps to the
 *  nearest line of the SAME colour above / below.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
const SqlBackdrop = (() => {

    // WeakMap: textarea → { wrapper, pre, lineHlLayer, ro,
    //                        onInput, onScroll, onClick, onContextMenu, onKeydown,
    //                        savedStyles, activeWord,
    //                        focusRanges, scopeMode, exclusiveMode,
    //                        lineColors }
    const _map = new WeakMap();

    // Document-level capture listener that prevents the browser context menu when
    // shift+right-clicking inside any backdrop wrapper.  Registered once on first
    // attach().  Capture phase runs before any bubble-phase or browser-native handling,
    // making it the only reliable way to suppress Shift+right-click on macOS Chrome.
    let _contextMenuGuardActive = false;
    function _ensureContextMenuGuard() {
        if (_contextMenuGuardActive) return;
        _contextMenuGuardActive = true;
        document.addEventListener('contextmenu', e => {
            if (!e.shiftKey && !e.altKey) return;

            if (e.target.closest?.('.sql-bd-wrapper')) {
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        }, true); // capture phase — fires before all bubble handlers and browser UI
    }

    // Callback invoked on Alt+click extract: SqlBackdrop.onExtractScope(sql, alias)
    let onExtractScope = null;

    // Optional validator: SqlBackdrop.checkAlias(alias) → true if the alias is
    // already in use on the canvas.  Set from app.js after the canvas is ready.
    let checkAlias = null;

    // Line-colour palette — index 0 = none, 1-4 match results-table col highlights.
    const LINE_COLORS = [
        null,
        'rgba(253,216,53,0.22)',   // 1 — yellow
        'rgba(67,160,71,0.22)',    // 2 — green
        'rgba(30,136,229,0.22)',   // 3 — blue
        'rgba(229,57,53,0.22)',    // 4 — red
    ];

    /* -------------------------------------------------------------------------
       Escape a string for use in a RegExp
    ------------------------------------------------------------------------- */
    function _escRe(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /* -------------------------------------------------------------------------
       Extract the SQL identifier word at a given character position.
       Uses [a-zA-Z0-9_] boundaries (no dot) so clicking on `o` inside
       `o.status` yields "o", letting the user highlight all alias references.
    ------------------------------------------------------------------------- */
    function _wordAtPos(text, pos) {
        let s = pos, e = pos;
        while (s > 0 && /[a-zA-Z0-9_]/.test(text[s - 1])) s--;
        while (e < text.length && /[a-zA-Z0-9_]/.test(text[e])) e++;
        return text.slice(s, e);
    }

    /* -------------------------------------------------------------------------
       Walk all text nodes inside `pre` and wrap whole-word matches of `word`
       in <mark class="sql-bd-match"> elements (DOM-based, safe with spans).
    ------------------------------------------------------------------------- */
    function _applyOccurrenceHighlights(pre, word) {
        if (!word) return;
        const re = new RegExp(`\\b${_escRe(word)}\\b`, 'gi');
        const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let n;
        while ((n = walker.nextNode())) nodes.push(n);
        nodes.forEach(textNode => {
            const text = textNode.textContent;
            const matches = [...text.matchAll(re)];
            if (!matches.length) return;
            const frag = document.createDocumentFragment();
            let last = 0;
            for (const m of matches) {
                if (m.index > last)
                    frag.appendChild(document.createTextNode(text.slice(last, m.index)));
                const mark = document.createElement('mark');
                mark.className = 'sql-bd-match';
                mark.textContent = m[0];
                frag.appendChild(mark);
                last = m.index + m[0].length;
            }
            if (last < text.length)
                frag.appendChild(document.createTextNode(text.slice(last)));
            textNode.replaceWith(frag);
        });
    }

    /* -------------------------------------------------------------------------
       Style mirroring — called BEFORE adding sql-bd-active to the textarea so
       we capture its original (opaque) background and border values.
       The background is placed on the wrapper (not the pre) so the line-hl-layer
       that sits between the wrapper and the pre shows through correctly.
    ------------------------------------------------------------------------- */
    function _mirrorStyles(ta, pre, wrapper) {
        const cs = getComputedStyle(ta);

        // Font & text
        pre.style.fontFamily    = cs.fontFamily;
        pre.style.fontSize      = cs.fontSize;
        pre.style.lineHeight    = cs.lineHeight;
        pre.style.letterSpacing = cs.letterSpacing;
        pre.style.wordSpacing   = cs.wordSpacing;
        pre.style.tabSize       = cs.tabSize;

        // Box model — must match the textarea exactly so characters align
        pre.style.padding       = cs.padding;
        pre.style.boxSizing     = cs.boxSizing;

        // Transparent border with correct widths keeps the box model in sync
        // with the textarea (which still shows its own visible border on top)
        pre.style.borderTopWidth    = cs.borderTopWidth;
        pre.style.borderRightWidth  = cs.borderRightWidth;
        pre.style.borderBottomWidth = cs.borderBottomWidth;
        pre.style.borderLeftWidth   = cs.borderLeftWidth;
        pre.style.borderStyle       = 'solid';
        pre.style.borderColor       = 'transparent';

        // Background lives on the wrapper so the line-hl-layer shows through the
        // transparent pre. The pre itself must be transparent.
        wrapper.style.backgroundColor = cs.backgroundColor;
        wrapper.style.borderRadius    = cs.borderRadius;
        pre.style.backgroundColor     = 'transparent';
        pre.style.borderRadius        = cs.borderRadius;
    }

    /* -------------------------------------------------------------------------
       Resolve the actual rendered line-height in pixels for a textarea.
       getComputedStyle returns "normal" when no explicit line-height is set,
       which parseFloat can't handle.  We measure it once with a throwaway span
       and cache the result on the textarea's handle to avoid repeated DOM work.
    ------------------------------------------------------------------------- */
    function _resolveLineHeight(ta) {
        const h = _map.get(ta);
        if (h?.resolvedLineHeight) return h.resolvedLineHeight;

        const cs = getComputedStyle(ta);
        const parsed = parseFloat(cs.lineHeight);
        if (!isNaN(parsed)) {
            if (h) h.resolvedLineHeight = parsed;
            return parsed;
        }

        // line-height: normal — measure the real rendered height with a test span
        const span = document.createElement('span');
        span.style.cssText = `font-family:${cs.fontFamily};font-size:${cs.fontSize};` +
                             `line-height:normal;visibility:hidden;position:fixed;white-space:pre`;
        span.textContent = 'x';
        document.body.appendChild(span);
        const measured = span.getBoundingClientRect().height;
        document.body.removeChild(span);
        const resolved = measured || Math.round(parseFloat(cs.fontSize) * 1.2);
        if (h) h.resolvedLineHeight = resolved;
        return resolved;
    }

    /* -------------------------------------------------------------------------
       Rebuild the absolutely-positioned line-colour strips inside lineHlLayer.
       Each coloured line becomes a full-width <div> at the correct vertical offset.
    ------------------------------------------------------------------------- */
    function _updateLineHlLayer(layer, lineColors, ta) {
        const entries = Object.entries(lineColors);
        if (entries.length === 0) { layer.innerHTML = ''; return; }

        const cs         = getComputedStyle(ta);
        const lineHeight = _resolveLineHeight(ta);
        const paddingTop = parseFloat(cs.paddingTop);

        // Wrap the absolutely-positioned strips in a single inner div and drive
        // scroll via transform.  Abs-positioned children don't contribute to
        // scrollHeight, so setting scrollTop on the layer itself gets clamped to 0
        // and the strips would never move.  translateY on an inner container works.
        const strips = entries.map(([idx, colorIdx]) => {
            const color = LINE_COLORS[colorIdx];
            if (!color) return '';
            const top = paddingTop + parseInt(idx, 10) * lineHeight;
            return `<div style="position:absolute;left:0;right:0;top:${top}px;height:${lineHeight}px;background:${color}"></div>`;
        }).join('');
        layer.innerHTML = `<div style="position:absolute;top:0;left:0;right:0;transform:translateY(-${ta.scrollTop}px)">${strips}</div>`;
    }

    /* -------------------------------------------------------------------------
       Rebuild the "×" clear buttons inside colorClearLayer — one per colored line.
    ------------------------------------------------------------------------- */
    function _updateColorClearLayer(layer, lineColors, ta) {
        const entries = Object.entries(lineColors);
        if (entries.length === 0) { layer.innerHTML = ''; return; }

        const cs         = getComputedStyle(ta);
        const lineHeight = _resolveLineHeight(ta);
        const paddingTop = parseFloat(cs.paddingTop);

        const badges = entries.map(([idx, colorIdx]) => {
            if (!LINE_COLORS[colorIdx]) return '';
            const top = paddingTop + parseInt(idx, 10) * lineHeight + Math.round((lineHeight - 14) / 2);
            return `<div class="sql-bd-color-clear-btn" data-line="${idx}" style="top:${top}px" title="Clear line color">\u00d7</div>`;
        }).join('');
        layer.innerHTML = `<div style="position:absolute;top:0;left:0;right:0;transform:translateY(-${ta.scrollTop}px)">${badges}</div>`;
    }

    /* -------------------------------------------------------------------------
       Rebuild the bookmark number badges inside bookmarkLayer.
       Reads bookmark data from the global State object (set by app.js).
       Each badge is pinned to the right edge at the vertical position of the
       bookmarked line and scrolls in sync with the textarea.
    ------------------------------------------------------------------------- */
    function _updateBookmarkLayer(ta) {
        const h = _map.get(ta);
        if (!h || !h.bookmarkLayer || !ta.id) return;

        // Read bookmarks for this textarea from State (defined globally in app.js)
        const taBookmarks = (typeof State !== 'undefined' && State.bookmarks?.[ta.id]) || {};
        const entries = Object.entries(taBookmarks);

        if (entries.length === 0) { h.bookmarkLayer.innerHTML = ''; return; }

        const cs         = getComputedStyle(ta);
        const lineHeight = _resolveLineHeight(ta);
        const paddingTop = parseFloat(cs.paddingTop);

        // Same transform-based scroll sync as lineHlLayer (see comment there).
        const badges = entries.map(([num, charOffset]) => {
            const safeOffset = Math.min(charOffset, ta.value.length);
            const lineIndex  = ta.value.substring(0, safeOffset).split('\n').length - 1;
            const top        = paddingTop + lineIndex * lineHeight + Math.round((lineHeight - 15) / 2);
            return `<div class="sql-bd-bookmark-badge" style="top:${top}px">${num}</div>`;
        }).join('');
        h.bookmarkLayer.innerHTML = `<div style="position:absolute;top:0;left:0;right:0;transform:translateY(-${ta.scrollTop}px)">${badges}</div>`;
    }

    /* -------------------------------------------------------------------------
       Compute the pixel width the line-number gutter needs for a given line count.
       Width grows in steps as the digit count increases.
    ------------------------------------------------------------------------- */
    function _computeGutterWidth(lineCount, charWidthPx) {
        const digits = String(Math.max(1, lineCount)).length;
        // right-padding (8px) + left-padding (4px) + digits × char width
        return 4 + digits * charWidthPx + 8;
    }

    /* -------------------------------------------------------------------------
       Rebuild the line-number gutter content and update left-padding on both
       the textarea and its backdrop <pre> so content stays aligned.
    ------------------------------------------------------------------------- */
    function _updateLineNumLayer(ta) {
        const h = _map.get(ta);
        if (!h || !h.lineNumLayer) return;

        const lineCount = ta.value === '' ? 1 : ta.value.split('\n').length;
        const cs        = getComputedStyle(ta);
        const lineHeight   = _resolveLineHeight(ta);
        const fontSize     = parseFloat(cs.fontSize)    || 13;
        const fontFamily   = cs.fontFamily;
        const paddingTop    = parseFloat(cs.paddingTop)    || 0;
        const paddingBottom = parseFloat(cs.paddingBottom) || 0;

        // Approximate monospace char width as ~0.6× font-size
        const charWidthPx  = Math.round(fontSize * 0.6);
        const gutterWidth  = _computeGutterWidth(lineCount, charWidthPx);

        // Update left-padding on ta + pre only when the gutter width actually changed
        if (gutterWidth !== h.gutterWidth) {
            h.gutterWidth = gutterWidth;
            const totalLeft = h.origPaddingLeft + gutterWidth;
            ta.style.paddingLeft  = totalLeft + 'px';
            h.pre.style.paddingLeft = totalLeft + 'px';
        }

        // Size and style the gutter layer
        const layer = h.lineNumLayer;
        layer.style.width           = gutterWidth + 'px';
        layer.style.paddingTop      = paddingTop + 'px';
        layer.style.paddingBottom   = paddingBottom + 'px';
        layer.style.backgroundColor = h.gutterBg;
        layer.style.fontSize        = fontSize + 'px';
        layer.style.fontFamily      = fontFamily;
        layer.style.lineHeight      = lineHeight + 'px';

        // Render one element per line
        let html = '';
        for (let i = 1; i <= lineCount; i++) {
            html += `<span class="sql-bd-line-num" style="line-height:${lineHeight}px;font-size:${fontSize}px;font-family:${fontFamily}">${i}</span>`;
        }
        layer.innerHTML = html;

        // Keep scroll in sync
        layer.scrollTop = ta.scrollTop;
    }

    /* -------------------------------------------------------------------------
       Update backdrop content from textarea value
    ------------------------------------------------------------------------- */
    function _update(ta, pre) {
        const h = _map.get(ta);

        // _highlightSQL and _getTableColorMap are defined globally in app.js.
        // Passing the alias map lets partial SQL fragments (WHERE, HAVING, …)
        // colour table aliases even without a FROM / JOIN clause in the text.
        const focusRanges = (h?.scopeMode && h.focusRanges.length) ? h.focusRanges : null;
        const html = (typeof _highlightSQL === 'function')
            ? _highlightSQL(ta.value,
                typeof _getTableColorMap === 'function' ? _getTableColorMap() : null,
                focusRanges)
            : ta.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // Trailing '\n' prevents the last line from collapsing in the pre
        pre.innerHTML = html + '\n';

        // Dim the whole pre when scope mode is on but nothing is highlighted yet,
        // so the user immediately sees they are in scope mode.
        pre.classList.toggle('scope-mode-empty', !!(h?.scopeMode && !h.focusRanges.length));

        // Highlight all occurrences of the active word (click-to-highlight feature)
        if (h?.activeWord) _applyOccurrenceHighlights(pre, h.activeWord);

        pre.scrollTop  = ta.scrollTop;
        pre.scrollLeft = ta.scrollLeft;

        // Rebuild line colour strips
        if (h?.lineHlLayer) _updateLineHlLayer(h.lineHlLayer, h.lineColors, ta);

        // Rebuild color-clear "×" buttons
        if (h?.colorClearLayer) _updateColorClearLayer(h.colorClearLayer, h.lineColors, ta);

        // Rebuild line number gutter
        if (h?.lineNumLayer) _updateLineNumLayer(ta);
    }

    /* -------------------------------------------------------------------------
       attach(ta) — wrap a textarea with a syntax-coloured backdrop
    ------------------------------------------------------------------------- */
    function attach(ta, opts = {}) {
        if (_map.has(ta)) return;
        _ensureContextMenuGuard();

        // ── Build backdrop pre ──────────────────────────────────────────────
        const pre = document.createElement('pre');
        pre.className = 'sql-bd-pre sql-highlighted';
        pre.setAttribute('aria-hidden', 'true');

        // ── Build wrapper ────────────────────────────────────────────────────
        const wrapper = document.createElement('div');
        wrapper.className = 'sql-bd-wrapper';
        ta.parentNode.insertBefore(wrapper, ta);
        wrapper.appendChild(pre);
        wrapper.appendChild(ta);

        // ── Line highlight layer — sits below the pre, above the wrapper bg ──
        const lineHlLayer = document.createElement('div');
        lineHlLayer.className = 'sql-bd-line-hl-layer';
        wrapper.insertBefore(lineHlLayer, pre);

        // ── Bookmark badge layer — sits between the pre and the textarea ──────
        const bookmarkLayer = document.createElement('div');
        bookmarkLayer.className = 'sql-bd-bookmark-layer';
        wrapper.insertBefore(bookmarkLayer, ta);

        // ── Color-clear "×" button layer ─────────────────────────────────────
        const colorClearLayer = document.createElement('div');
        colorClearLayer.className = 'sql-bd-color-clear-layer';
        wrapper.insertBefore(colorClearLayer, ta);
        colorClearLayer.addEventListener('click', e => {
            const btn = e.target.closest('.sql-bd-color-clear-btn');
            if (!btn) return;
            const h = _map.get(ta);
            if (!h) return;
            const lineIdx = parseInt(btn.dataset.line, 10);
            delete h.lineColors[lineIdx];
            _update(ta, pre);
        });

        // ── Layout: wrapper must fill the same space as textarea did ─────────
        //
        // After wrapping, the wrapper is the direct flex/grid/block child.
        // We transfer the textarea's layout properties to the wrapper so it
        // occupies the same slot, then make the textarea fill the wrapper.
        //
        const savedStyles = {
            flex:        ta.style.flex,
            minHeight:   ta.style.minHeight,
            width:       ta.style.width,
            height:      ta.style.height,
            paddingLeft: ta.style.paddingLeft,
        };

        const parentDisplay = getComputedStyle(wrapper.parentNode).display;
        const isFlex = parentDisplay === 'flex' || parentDisplay === 'inline-flex';
        const isGrid = parentDisplay === 'grid' || parentDisplay === 'inline-grid';
        let ro = null;

        if (isFlex || isGrid) {
            // Read the textarea's flex/size before we alter it
            const taCs = getComputedStyle(ta);
            wrapper.style.flexGrow   = taCs.flexGrow;
            wrapper.style.flexShrink = taCs.flexShrink;
            wrapper.style.flexBasis  = taCs.flexBasis;
            wrapper.style.minWidth   = taCs.minWidth;
            wrapper.style.minHeight  = taCs.minHeight;
            wrapper.style.maxHeight  = taCs.maxHeight;
            wrapper.style.width      = taCs.width === 'auto' ? '100%' : taCs.width;
            // Wrapper becomes a flex column so the textarea fills it
            wrapper.style.display        = 'flex';
            wrapper.style.flexDirection  = 'column';
            // Textarea fills wrapper
            ta.style.flex      = '1 1 auto';
            ta.style.minHeight = '0';
            ta.style.width     = '100%';
        } else {
            // Block layout: sync wrapper height to textarea height so the
            // absolute-positioned pre (height: 100%) fills the right area.
            // ResizeObserver keeps them in sync when the user drags the handle.
            const _syncHeight = () => {
                const h = ta.offsetHeight;
                wrapper.style.height = h > 0 ? h + 'px' : '';
            };
            _syncHeight();
            ro = new ResizeObserver(_syncHeight);
            ro.observe(ta);
        }

        // ── Mirror visual styles BEFORE making textarea transparent ──────────
        _mirrorStyles(ta, pre, wrapper);

        // ── Line-number gutter ───────────────────────────────────────────────
        // Capture the textarea's original paddingLeft AFTER _mirrorStyles (which
        // reads computed styles while the textarea is still opaque) so we have
        // the true baseline to add the gutter width on top of.
        const lineNumLayer = document.createElement('div');
        lineNumLayer.className = 'sql-bd-line-num-layer';
        wrapper.insertBefore(lineNumLayer, pre);       // leftmost layer, behind everything

        const origPaddingLeft = parseFloat(getComputedStyle(ta).paddingLeft) || 0;
        // Compute a rough gutter bg to match the wrapper background (slightly darker)
        const gutterBg = 'rgba(0,0,0,0.12)';

        // ── Make textarea transparent (text + background) ────────────────────
        ta.classList.add('sql-bd-active');

        // ── Events ───────────────────────────────────────────────────────────
        const onInput = () => {
            const h = _map.get(ta);
            if (!h) return;
            // Clear occurrence highlights whenever the content changes
            h.activeWord = null;
            // Clear scope highlights when typing (scope mode is a reading mode)
            if (h.scopeMode) h.focusRanges = [];
            // Clear all line colour annotations — content has changed
            if (Object.keys(h.lineColors).length > 0) h.lineColors = {};
            _update(ta, pre);
        };

        const onScroll = () => {
            pre.scrollTop  = ta.scrollTop;
            pre.scrollLeft = ta.scrollLeft;
            // lineHlLayer and bookmarkLayer use transform-based scroll (their children
            // are all position:absolute and don't contribute to scrollHeight, so
            // setting scrollTop on the layer itself would always be clamped to 0).
            const ty = `translateY(-${ta.scrollTop}px)`;
            if (lineHlLayer.firstChild)    lineHlLayer.firstChild.style.transform    = ty;
            if (bookmarkLayer.firstChild)  bookmarkLayer.firstChild.style.transform  = ty;
            if (colorClearLayer.firstChild) colorClearLayer.firstChild.style.transform = ty;
            lineNumLayer.scrollTop = ta.scrollTop;   // in-flow spans → scrollTop works
        };

        // Click: in scope mode → Alt+click extracts to subquery, plain click toggles highlight.
        const onClick = (e) => {
            if (e.button !== 0) return;
            const h = _map.get(ta);
            if (!h) return;
            if (h.lite) return;

            if (h.scopeMode) {
                const range = (typeof _findContextRange === 'function')
                    ? _findContextRange(ta.value, ta.selectionStart)
                    : null;
                if (!range) return;

                if (e.altKey) {
                    // Alt+click → copy all highlighted scopes to clipboard
                    e.preventDefault();
                    if (!h.focusRanges.length) return;
                    const text = h.focusRanges
                        .map(r => ta.value.slice(r.start, r.end).trim())
                        .filter(Boolean)
                        .join('\n\n');
                    navigator.clipboard.writeText(text)
                        .then(() => {
                            const count = h.focusRanges.length;
                            if (typeof App !== 'undefined') App.notify(
                                `${count} scope${count === 1 ? '' : 's'} copied to clipboard.`, 'success'
                            );
                        })
                        .catch(() => {
                            if (typeof App !== 'undefined') App.notify('Clipboard write failed.', 'error');
                        });
                } else {
                    // Plain click → toggle highlight on/off
                    const idx = h.focusRanges.findIndex(r => r.start === range.start && r.end === range.end);
                    if (idx !== -1) {
                        h.focusRanges.splice(idx, 1);
                    } else if (h.exclusiveMode) {
                        h.focusRanges = [range];
                    } else {
                        h.focusRanges.push(range);
                    }
                    _update(ta, pre);
                }
            } else {
                const word = _wordAtPos(ta.value, ta.selectionStart);
                // Toggle off if same word clicked again, or if cursor landed on whitespace
                h.activeWord = (word && word !== h.activeWord) ? word : null;
                _update(ta, pre);
            }
        };

        // Right-click on a line → cycle its background colour (works in all modes).
        // Alt+right-click in scope mode → copy all highlighted scopes to clipboard.
        const onContextMenu = (e) => {
            const h = _map.get(ta);
            if (!h) return;
            if (h.lite) return;
            e.preventDefault();

            // Shift+right-click and Alt+right-click are handled in the mousedown listener
            // (preventDefault on mousedown suppresses the browser menu in Chrome/Safari).
            // On Firefox contextmenu still fires — e.preventDefault() above suppresses
            // the menu and this early return prevents double-handling.
            if (e.shiftKey || e.altKey) return;

            // Determine which line was right-clicked using pixel math.
            // selectionStart is NOT reliably updated before contextmenu fires, so
            // cursor-based indexing targets the wrong line.  Pixel math mirrors the
            // coordinate system used by _updateLineHlLayer (top = paddingTop + idx * lineHeight).
            const rect       = ta.getBoundingClientRect();
            const cs2        = getComputedStyle(ta);
            const lineHeight = _resolveLineHeight(ta);
            const paddingTop = parseFloat(cs2.paddingTop);
            const rawIdx     = Math.floor((e.clientY - rect.top - paddingTop + ta.scrollTop) / lineHeight);
            const lineIndex  = Math.max(0, Math.min(rawIdx, ta.value.split('\n').length - 1));

            // Cycle forward: no color → 1 → 2 → 3 → 4 → no color
            const current = h.lineColors[lineIndex] ?? 0;
            const next    = current + 1;
            if (next >= LINE_COLORS.length) {
                delete h.lineColors[lineIndex];
            } else {
                h.lineColors[lineIndex] = next;
            }

            _update(ta, pre);
        };

        // Keyboard:
        //   Escape          — clear all scope highlights (scope mode)
        //                     (suppressed when escClearsScope === false, e.g. in the
        //                      expand popup where ESC closes the modal instead)
        //   Alt+S           — toggle scope mode; stopPropagation prevents the global
        //                     Alt+S shortcut (add sub-query canvas card) from firing
        //   Alt+G           — "Go to line" prompt; scrolls the target line to centre
        //   ArrowUp/Down    — jump between same-colour lines when cursor is on one
        const onKeydown = async (e) => {
            const h = _map.get(ta);
            if (!h) return;

            // Escape: clear scope highlights (only when escClearsScope is not disabled)
            if (h.scopeMode && e.key === 'Escape' && h.escClearsScope !== false) {
                h.focusRanges = [];
                _update(ta, pre);
                return;
            }

            // Alt+S — toggle scope mode (only when scopeToggleShortcut is enabled)
            if (e.altKey && e.code === 'KeyS' && h.scopeToggleShortcut !== false) {
                e.preventDefault();
                e.stopPropagation(); // block global Alt+S (add sub-query canvas card)
                const on = toggleScopeMode(ta);
                ta.dispatchEvent(new CustomEvent('backdrop-scopetoggle', {
                    bubbles: true,
                    detail:  { scopeMode: on },
                }));
                return;
            }

            // Alt+G — Go to line
            if (e.altKey && e.code === 'KeyG') {
                e.preventDefault();
                e.stopPropagation(); // suppress the global Alt+G (SELECT column search)
                const raw = await Dialog.prompt('Go to line:');
                if (raw === null) return; // cancelled
                const lineNum = parseInt(raw.trim(), 10);
                if (!Number.isFinite(lineNum)) return; // not a valid number
                const lines      = ta.value.split('\n');
                const lineIdx    = Math.max(0, Math.min(lineNum - 1, lines.length - 1));
                // Move cursor to start of target line
                let pos = 0;
                for (let i = 0; i < lineIdx; i++) pos += lines[i].length + 1;
                ta.focus();
                ta.setSelectionRange(pos, pos);
                // Scroll so the line lands near the vertical centre of the textarea
                const cs         = getComputedStyle(ta);
                const lineHeight = _resolveLineHeight(ta);
                const paddingTop = parseFloat(cs.paddingTop) || 0;
                const topOfLine  = paddingTop + lineIdx * lineHeight;
                ta.scrollTop     = topOfLine - (ta.clientHeight / 2) + (lineHeight / 2);
                return;
            }

            // Cmd+/ (macOS) or Ctrl+/ (Windows) — toggle SQL line comments on selected lines
            if ((e.metaKey || e.ctrlKey) && e.key === '/') {
                e.preventDefault();
                e.stopPropagation();

                const val   = ta.value;
                const start = ta.selectionStart;
                const end   = ta.selectionEnd;

                // Expand to full lines
                const lineStart = val.lastIndexOf('\n', start - 1) + 1;
                const lineEndRaw = val.indexOf('\n', end);
                const lineEnd    = lineEndRaw === -1 ? val.length : lineEndRaw;

                const lines    = val.substring(lineStart, lineEnd).split('\n');
                const nonEmpty = lines.filter(l => l.trim() !== '');

                // If every non-empty line is already commented → uncomment; else comment
                const allCommented = nonEmpty.length > 0 && nonEmpty.every(l => /^--/.test(l));

                const newLines = lines.map(line => {
                    if (allCommented) return line.replace(/^--\s?/, '');
                    return '-- ' + line;
                });

                const newBlock = newLines.join('\n');
                ta.value = val.substring(0, lineStart) + newBlock + val.substring(lineEnd);
                ta.setSelectionRange(lineStart, lineStart + newBlock.length);
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                return;
            }

            // Arrow navigation between same-colour lines
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                if (Object.keys(h.lineColors).length === 0) return;

                const currentLineIdx = ta.value.substring(0, ta.selectionStart).split('\n').length - 1;
                const currentColor   = h.lineColors[currentLineIdx];
                if (!currentColor) return; // cursor not on a coloured line — normal arrow

                // All lines sharing the same colour, sorted ascending
                const sameColorLines = Object.keys(h.lineColors)
                    .map(Number)
                    .filter(l => h.lineColors[l] === currentColor)
                    .sort((a, b) => a - b);

                let target;
                if (e.key === 'ArrowUp') {
                    target = [...sameColorLines].reverse().find(l => l < currentLineIdx);
                } else {
                    target = sameColorLines.find(l => l > currentLineIdx);
                }
                if (target === undefined) return; // no target — let normal arrow work

                e.preventDefault();

                // Move cursor to the start of the target line
                const lines = ta.value.split('\n');
                let pos = 0;
                for (let i = 0; i < target; i++) pos += lines[i].length + 1;
                ta.setSelectionRange(pos, pos);

                // Scroll so the target line is centred in the visible area
                const cs         = getComputedStyle(ta);
                const lineHeight = _resolveLineHeight(ta);
                const topOfLine  = parseFloat(cs.paddingTop) + target * lineHeight;
                ta.scrollTop     = topOfLine - (ta.clientHeight / 2) + (lineHeight / 2);
            }
        };

        ta.addEventListener('input',       onInput);
        ta.addEventListener('scroll',      onScroll);
        ta.addEventListener('click',       onClick);
        ta.addEventListener('contextmenu', onContextMenu);
        ta.addEventListener('keydown',     onKeydown);

        // Shift+right-click and Alt+right-click must be handled in mousedown because
        // Chrome/Safari do not honour e.preventDefault() in 'contextmenu' for these
        // modifier+right-click combos — the browser menu appears regardless.
        // preventDefault() in mousedown suppresses the contextmenu event itself in
        // Chromium.  Firefox still fires 'contextmenu' but the early returns in
        // onContextMenu prevent double-handling (and its own e.preventDefault() blocks
        // the menu there).
        ta.addEventListener('mousedown', e => {
            if (e.button !== 2 || (!e.shiftKey && !e.altKey)) return;
            e.preventDefault();
            const isShift = e.shiftKey;
            const isAlt   = e.altKey;
            // selectionStart may not be updated yet; defer until after browser processes
            setTimeout(async () => {
                const h2 = _map.get(ta);
                if (!h2) return;

                // Alt+right-click in scope mode: extract clicked scope to a new subquery card
                if (isAlt && h2.scopeMode) {
                    const range = (typeof _findContextRange === 'function')
                        ? _findContextRange(ta.value, ta.selectionStart)
                        : null;
                    if (!range) return;
                    const sql = ta.value.slice(range.start, range.end).trim();
                    if (!sql) return;
                    let lastAlias = 'sq';
                    while (true) {
                        const raw = await Dialog.prompt('Create subquery — enter an alias:', lastAlias);
                        if (raw === null) return;
                        const alias = raw.trim();
                        if (typeof checkAlias === 'function' && checkAlias(alias)) {
                            await Dialog.alert(`Alias "${alias}" already exists on the canvas.\nPlease choose a different alias.`);
                            lastAlias = alias;
                            continue;
                        }
                        if (typeof onExtractScope === 'function') onExtractScope(sql, alias);
                        break;
                    }
                    return;
                }

                const lineIdx = ta.value.substring(0, ta.selectionStart).split('\n').length - 1;
                const curr    = h2.lineColors[lineIdx] ?? 0;
                if (isShift) {
                    // Backward cycle
                    const prev = curr <= 1 ? 0 : curr - 1;
                    if (prev === 0) delete h2.lineColors[lineIdx];
                    else            h2.lineColors[lineIdx] = prev;
                } else {
                    // Alt+right-click (no scope mode): forward cycle
                    const next = curr + 1;
                    if (next >= LINE_COLORS.length) delete h2.lineColors[lineIdx];
                    else                            h2.lineColors[lineIdx] = next;
                }
                _update(ta, pre);
            }, 0);
        });

        // ── Register in map BEFORE initial render so _update can access h ────
        _map.set(ta, {
            wrapper, pre, lineHlLayer, lineNumLayer, bookmarkLayer, colorClearLayer, ro,
            onInput, onScroll, onClick, onContextMenu, onKeydown,
            savedStyles,
            origPaddingLeft,
            gutterBg,
            gutterWidth:    0,    // filled on first _updateLineNumLayer call
            activeWord:     null,
            focusRanges:    [],
            scopeMode:      false,
            exclusiveMode:  false,
            escClearsScope:       true,  // set to false to prevent ESC from clearing highlights
            scopeToggleShortcut:  true,  // set to false to disable Alt+S scope toggle (e.g. canvas card textareas)
            lineColors:     {},
            lite:           !!opts.lite, // suppresses click-to-highlight and right-click line colouring
        });

        // ── Initial render ───────────────────────────────────────────────────
        _update(ta, pre);
    }

    /* -------------------------------------------------------------------------
       detach(ta) — remove backdrop and restore textarea to normal
    ------------------------------------------------------------------------- */
    function detach(ta) {
        const h = _map.get(ta);
        if (!h) return;

        ta.removeEventListener('input',       h.onInput);
        ta.removeEventListener('scroll',      h.onScroll);
        ta.removeEventListener('click',       h.onClick);
        ta.removeEventListener('contextmenu', h.onContextMenu);
        ta.removeEventListener('keydown',     h.onKeydown);
        if (h.ro) h.ro.disconnect();

        // Unwrap: move textarea back out, then remove wrapper (and its children)
        h.wrapper.parentNode.insertBefore(ta, h.wrapper);
        h.wrapper.remove();

        // Restore textarea inline styles
        ta.style.flex        = h.savedStyles.flex;
        ta.style.minHeight   = h.savedStyles.minHeight;
        ta.style.width       = h.savedStyles.width;
        ta.style.height      = h.savedStyles.height;
        ta.style.paddingLeft = h.savedStyles.paddingLeft;

        ta.classList.remove('sql-bd-active', 'scope-mode-on');
        _map.delete(ta);
    }

    /* -------------------------------------------------------------------------
       init() — auto-attach all  textarea[data-sql-backdrop]  elements
    ------------------------------------------------------------------------- */
    function init() {
        document.querySelectorAll('textarea[data-sql-backdrop]').forEach(attach);
    }

    // Auto-init after DOM is ready (app.js / _highlightSQL must already be loaded)
    document.addEventListener('DOMContentLoaded', init);

    /* -------------------------------------------------------------------------
       refresh(ta) — force a re-render of the backdrop without re-attaching.
       Call this after the host element becomes visible or after setting
       ta.value programmatically (which doesn't fire an input event).
    ------------------------------------------------------------------------- */
    function refresh(ta) {
        const h = _map.get(ta);
        if (!h) return;
        _update(ta, h.pre);
    }

    /* -------------------------------------------------------------------------
       toggleScopeMode(ta) — enable or disable scope mode for one textarea.
       Returns true if scope mode is now on, false if now off.
    ------------------------------------------------------------------------- */
    function toggleScopeMode(ta) {
        const h = _map.get(ta);
        if (!h) return false;
        h.scopeMode = !h.scopeMode;
        // focusRanges are intentionally preserved so that turning scope mode back
        // on restores the previously highlighted ranges.
        ta.classList.toggle('scope-mode-on', h.scopeMode);
        _update(ta, h.pre);
        return h.scopeMode;
    }

    /* -------------------------------------------------------------------------
       setExclusiveMode(ta, val) — when true, clicking always replaces the
       current highlight with the new scope instead of accumulating.
    ------------------------------------------------------------------------- */
    function setExclusiveMode(ta, val) {
        const h = _map.get(ta);
        if (h) h.exclusiveMode = !!val;
    }

    /* -------------------------------------------------------------------------
       collectAnnotations() — snapshot the per-textarea state of every attached
       textarea that has an id.  Used by the context-save path.

       Format:
         {
           [textareaId]: {
             lineColors:  { [lineIndex]: colorIndex },   // same as internal storage
             scopeRanges: [ { start, length }, … ],      // positions, no raw SQL
             scopeMode:   true | false
           }
         }
       Only non-empty / non-default values are included so the saved blob stays
       small.  Textareas without an id are skipped (they can't be looked up on
       restore).
    ------------------------------------------------------------------------- */
    function collectAnnotations() {
        const result = {};
        document.querySelectorAll('textarea.sql-bd-active').forEach(ta => {
            if (!ta.id) return;
            const h = _map.get(ta);
            if (!h) return;
            const ann = {};
            if (Object.keys(h.lineColors).length > 0) {
                ann.lineColors = { ...h.lineColors };
            }
            if (h.focusRanges.length > 0) {
                ann.scopeRanges = h.focusRanges.map(r => ({
                    start:  r.start,
                    length: r.end - r.start,
                }));
            }
            if (h.scopeMode) ann.scopeMode = true;
            if (h.activeWord) ann.activeWord = h.activeWord;
            if (Object.keys(ann).length > 0) result[ta.id] = ann;
        });
        return result;
    }

    /* -------------------------------------------------------------------------
       applyAnnotations(data) — restore per-textarea state from a previously
       collected annotations object.  Silently skips unknown ids.
       Dispatches backdrop-scopetoggle so any bound Scope buttons stay in sync.
    ------------------------------------------------------------------------- */
    function applyAnnotations(data) {
        if (!data || typeof data !== 'object') return;
        Object.entries(data).forEach(([id, ann]) => {
            const ta = document.getElementById(id);
            if (!ta) return;
            const h = _map.get(ta);
            if (!h) return;
            if (ann.lineColors) h.lineColors = { ...ann.lineColors };
            if (ann.scopeRanges) {
                h.focusRanges = ann.scopeRanges.map(r => ({
                    start: r.start,
                    end:   r.start + r.length,
                }));
            }
            if (ann.activeWord) h.activeWord = ann.activeWord;
            const scopeOn = ann.scopeMode ?? false;
            h.scopeMode = scopeOn;
            ta.classList.toggle('scope-mode-on', scopeOn);
            _update(ta, h.pre);
            // Notify _bindScopeMode listeners so the Scope button reflects the state
            ta.dispatchEvent(new CustomEvent('backdrop-scopetoggle', {
                bubbles: true,
                detail:  { scopeMode: scopeOn },
            }));
        });
    }

    /* -------------------------------------------------------------------------
       setEscClearsScope(ta, val) — when false, pressing Escape inside this
       textarea will NOT clear scope highlights.  Use for textareas inside a
       modal where Escape is already bound to "close the modal".
    ------------------------------------------------------------------------- */
    function setEscClearsScope(ta, val) {
        const h = _map.get(ta);
        if (h) h.escClearsScope = !!val;
    }

    function setScopeToggleShortcut(ta, val) {
        const h = _map.get(ta);
        if (h) h.scopeToggleShortcut = !!val;
    }

    /* -------------------------------------------------------------------------
       refreshBookmarks(ta) — redraw the bookmark badge layer for one textarea.
       Call this from app.js after setting or clearing a bookmark.
    ------------------------------------------------------------------------- */
    function refreshBookmarks(ta) {
        _updateBookmarkLayer(ta);
    }

    /* -------------------------------------------------------------------------
       refreshAllBookmarks() — redraw bookmark badges for every attached textarea.
       Call this after applyContext() so loaded bookmark state becomes visible.
    ------------------------------------------------------------------------- */
    function refreshAllBookmarks() {
        document.querySelectorAll('textarea.sql-bd-active').forEach(ta => {
            _updateBookmarkLayer(ta);
        });
    }

    /* -------------------------------------------------------------------------
       transferAnnotations(fromTa, toTa) — copy lineColors, focusRanges, and
       scopeMode from one attached textarea to another and re-render the target.
       Used to keep the sq-expand popup and its backing card textarea in sync.
    ------------------------------------------------------------------------- */
    function transferAnnotations(fromTa, toTa) {
        const hFrom = _map.get(fromTa);
        const hTo   = _map.get(toTa);
        if (!hFrom || !hTo) return;
        hTo.lineColors  = { ...hFrom.lineColors };
        hTo.focusRanges = hFrom.focusRanges.map(r => ({ ...r }));
        hTo.scopeMode   = hFrom.scopeMode;
        hTo.activeWord  = hFrom.activeWord;
        toTa.classList.toggle('scope-mode-on', hTo.scopeMode);
        _update(toTa, hTo.pre);
        toTa.dispatchEvent(new CustomEvent('backdrop-scopetoggle', {
            bubbles: true,
            detail:  { scopeMode: hTo.scopeMode },
        }));
    }

    /* -------------------------------------------------------------------------
       getActiveWord(ta) / restoreActiveWord(ta, word)
       Low-level helpers used by the sq-expand open/close path to preserve the
       clicked-word highlight across Alt+E transitions (the keypress can trigger
       a stray OS-level input event that would otherwise clear activeWord).
    ------------------------------------------------------------------------- */
    function getActiveWord(ta) {
        return _map.get(ta)?.activeWord ?? null;
    }

    /* -------------------------------------------------------------------------
       getFocusRanges(ta) — return a shallow copy of the current focus ranges
       for the textarea.  Used by the Disassemble feature to identify which
       scope the user has highlighted.
    ------------------------------------------------------------------------- */
    function getFocusRanges(ta) {
        return (_map.get(ta)?.focusRanges ?? []).map(r => ({ ...r }));
    }
    function restoreActiveWord(ta, word) {
        const h = _map.get(ta);
        if (!h) return;
        h.activeWord = word;
        _update(ta, h.pre);
    }

    return { attach, detach, init, refresh, toggleScopeMode, setExclusiveMode,
             setEscClearsScope, setScopeToggleShortcut,
             collectAnnotations, applyAnnotations, transferAnnotations,
             refreshBookmarks, refreshAllBookmarks,
             getActiveWord, restoreActiveWord, getFocusRanges,
             get onExtractScope() { return onExtractScope; },
             set onExtractScope(fn) { onExtractScope = fn; },
             get checkAlias() { return checkAlias; },
             set checkAlias(fn) { checkAlias = fn; } };

})();
