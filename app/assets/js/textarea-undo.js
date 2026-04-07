/* textarea-undo.js — reusable per-textarea undo/redo stack
 *
 * Keeps its own history in a WeakMap so the stack survives popup close/reopen
 * regardless of display:none or programmatic .value changes.
 *
 * Public API:
 *   UndoManager.attach(ta)   – start managing a textarea (safe to call multiple times)
 *   UndoManager.detach(ta)   – stop managing and free memory
 *   UndoManager.push(ta)     – immediately commit current state as a snapshot
 *   UndoManager.reset(ta)    – wipe history and seed from current value
 *                              (call this after an external .value change so the
 *                               old history isn't misleading)
 *
 * Ctrl/Cmd+Z = undo  |  Ctrl/Cmd+Shift+Z  or  Ctrl/Cmd+Y = redo
 *
 * Note: undo.js (canvas-level undo) already skips textareas when one is focused,
 * so there is no conflict between the two systems.
 */
const UndoManager = (() => {
    const _store   = new WeakMap();   // textarea → { history[], ptr, timer }
    const MAX_SIZE = 500;             // max snapshots per textarea
    const DEBOUNCE = 400;             // ms of idle typing before snapshotting

    /* ---- snapshot helpers ---- */

    function _snap(ta) {
        return {
            value:     ta.value,
            selStart:  ta.selectionStart,
            selEnd:    ta.selectionEnd,
            scrollTop: ta.scrollTop,
        };
    }

    function _apply(ta, snap) {
        ta.value = snap.value;
        // Dispatch input so State, backdrops, and sync listeners stay up-to-date.
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        // Restore cursor + scroll after the browser has processed the value change.
        setTimeout(() => {
            try {
                ta.setSelectionRange(snap.selStart, snap.selEnd);
                ta.scrollTop = snap.scrollTop;
            } catch (_) { /* readonly or detached — ignore */ }
        }, 0);
    }

    function _commit(ta) {
        const d = _store.get(ta);
        if (!d) return;
        clearTimeout(d.timer);
        const snap = _snap(ta);
        // Skip if value didn't change since the current head.
        if (d.history[d.ptr] && d.history[d.ptr].value === snap.value) return;
        d.history.splice(d.ptr + 1);        // drop any redo branch
        d.history.push(snap);
        if (d.history.length > MAX_SIZE) d.history.shift();   // trim oldest
        d.ptr = d.history.length - 1;
    }

    /* ---- event handlers (stable references so removeEventListener works) ---- */

    function _onInput(e) {
        const d = _store.get(e.target);
        if (!d) return;
        clearTimeout(d.timer);
        d.timer = setTimeout(() => _commit(e.target), DEBOUNCE);
    }

    function _onPasteOrCut(e) {
        // Snapshot the state BEFORE the browser applies the change, then AFTER.
        _commit(e.target);
        setTimeout(() => _commit(e.target), 0);
    }

    function _onKeydown(e) {
        if (!(e.metaKey || e.ctrlKey)) return;
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
            e.preventDefault();
            undo(e.target);
        } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
            e.preventDefault();
            redo(e.target);
        }
    }

    function _onBlur(e) {
        _commit(e.target);   // always snapshot when leaving the textarea
    }

    /* ---- public API ---- */

    function attach(ta) {
        if (!ta || _store.has(ta)) return;
        _store.set(ta, { history: [_snap(ta)], ptr: 0, timer: null });
        ta.addEventListener('input',   _onInput);
        ta.addEventListener('paste',   _onPasteOrCut);
        ta.addEventListener('cut',     _onPasteOrCut);
        ta.addEventListener('keydown', _onKeydown);
        ta.addEventListener('blur',    _onBlur);
    }

    function detach(ta) {
        if (!ta || !_store.has(ta)) return;
        clearTimeout(_store.get(ta).timer);
        _store.delete(ta);
        ta.removeEventListener('input',   _onInput);
        ta.removeEventListener('paste',   _onPasteOrCut);
        ta.removeEventListener('cut',     _onPasteOrCut);
        ta.removeEventListener('keydown', _onKeydown);
        ta.removeEventListener('blur',    _onBlur);
    }

    function push(ta) {
        _commit(ta);
    }

    function reset(ta) {
        const d = _store.get(ta);
        if (!d) return;
        clearTimeout(d.timer);
        d.history = [_snap(ta)];
        d.ptr = 0;
    }

    function undo(ta) {
        const d = _store.get(ta);
        if (!d) return;
        // Commit any unsaved in-flight changes first so they can be redone.
        const cur = _snap(ta);
        if (d.history[d.ptr] && d.history[d.ptr].value !== cur.value) _commit(ta);
        if (d.ptr <= 0) return;
        d.ptr--;
        _apply(ta, d.history[d.ptr]);
    }

    function redo(ta) {
        const d = _store.get(ta);
        if (!d || d.ptr >= d.history.length - 1) return;
        d.ptr++;
        _apply(ta, d.history[d.ptr]);
    }

    return { attach, detach, push, reset, undo, redo };
})();
