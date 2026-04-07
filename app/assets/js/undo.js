/**
 * undo.js — Undo / Redo via full-State snapshots
 *
 * Strategy: before every user-driven mutation, a JSON snapshot of the entire
 * context is pushed onto _undoStack (max 30 entries, oldest discarded).
 * Undo  = pop _undoStack → push current to _redoStack → applyContext(snapshot)
 * Redo  = pop _redoStack → push current to _undoStack → applyContext(snapshot)
 *
 * Snapshots are plain JSON strings (~50 KB each) stored in JS memory only;
 * they vanish on page refresh. No disk / server I/O.
 *
 * Keyboard: Ctrl/Cmd+Z = undo  |  Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y = redo
 * Buttons:  #btn-undo / #btn-redo (disabled when stack is empty)
 *
 * Load order: must come AFTER app.js so App is defined at runtime.
 */

const UndoRedo = (() => {

    const MAX = 30;

    const _undo = [];   // JSON strings, oldest first
    const _redo = [];   // JSON strings

    // =========================================================================
    // Public: capture a snapshot of current State BEFORE a mutation
    // =========================================================================
    function snapshot() {
        if (typeof App === 'undefined') return;
        _undo.push(App.captureSnapshot());
        if (_undo.length > MAX) _undo.shift();
        _redo.length = 0;   // any new action clears the redo branch
        _refreshUI();
    }

    // =========================================================================
    // Public: step backwards
    // =========================================================================
    function undo() {
        if (!_undo.length) return;
        _redo.push(App.captureSnapshot());
        App.applyContext(_undo.pop());
        _refreshUI();
    }

    // =========================================================================
    // Public: step forwards
    // =========================================================================
    function redo() {
        if (!_redo.length) return;
        _undo.push(App.captureSnapshot());
        if (_undo.length > MAX) _undo.shift();
        App.applyContext(_redo.pop());
        _refreshUI();
    }

    // =========================================================================
    // Private: sync button states
    // =========================================================================
    function _refreshUI() {
        const btnUndo = document.getElementById('btn-undo');
        const btnRedo = document.getElementById('btn-redo');
        if (btnUndo) btnUndo.disabled = _undo.length === 0;
        if (btnRedo) btnRedo.disabled = _redo.length === 0;
        if (btnUndo) btnUndo.title = `Undo (Ctrl+Z)${_undo.length ? ' — ' + _undo.length + ' step' + (_undo.length > 1 ? 's' : '') : ''}`;
        if (btnRedo) btnRedo.title = `Redo (Ctrl+Shift+Z)${_redo.length ? ' — ' + _redo.length + ' step' + (_redo.length > 1 ? 's' : '') : ''}`;
    }

    // =========================================================================
    // Init — wire keyboard shortcuts and button clicks
    // =========================================================================
    function init() {
        document.addEventListener('keydown', e => {
            if (!e.ctrlKey && !e.metaKey) return;
            // Let text fields handle their own native undo
            if (document.activeElement?.matches('input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable]')) return;

            if ((e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
                e.preventDefault();
                undo();
            } else if ((e.key === 'z' || e.key === 'Z') && e.shiftKey) {
                e.preventDefault();
                redo();
            } else if (e.key === 'y' || e.key === 'Y') {
                e.preventDefault();
                redo();
            }
        });

        document.getElementById('btn-undo')?.addEventListener('click', undo);
        document.getElementById('btn-redo')?.addEventListener('click', redo);

        _refreshUI();
    }

    return { init, snapshot, undo, redo };

})();

document.addEventListener('DOMContentLoaded', () => UndoRedo.init());
