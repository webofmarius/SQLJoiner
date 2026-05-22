'use strict';

/**
 * Dialog — custom replacements for window.alert / window.confirm / window.prompt.
 * Required because Electron's renderer disables the native dialog APIs.
 *
 * Usage (all async):
 *   await Dialog.alert('Something happened.');
 *   const ok = await Dialog.confirm('Are you sure?');          // true / false
 *   const val = await Dialog.prompt('Enter a name:', 'default'); // string | null
 */
const Dialog = (() => {
    let _resolve = null;

    function _ensureDOM() {
        if (document.getElementById('dialog-overlay')) return;

        const el = document.createElement('div');
        el.id        = 'dialog-overlay';
        el.className = 'modal hidden';
        el.style.zIndex = '9999';
        el.innerHTML = `
            <div class="modal-box" id="dialog-box" style="width:400px;max-width:92vw;">
                <div class="modal-body">
                    <p id="dialog-message" style="margin:0 0 14px;white-space:pre-wrap;line-height:1.55;"></p>
                    <input id="dialog-input" type="text" autocomplete="off"
                           style="display:none;width:100%;box-sizing:border-box;margin-bottom:4px;">
                    <div class="form-actions" style="justify-content:flex-end;">
                        <button id="dialog-cancel">Cancel</button>
                        <button id="dialog-ok" class="primary">OK</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(el);

        document.getElementById('dialog-ok').addEventListener('click', _ok);
        document.getElementById('dialog-cancel').addEventListener('click', _cancel);
        document.getElementById('dialog-input').addEventListener('keydown', e => {
            if (e.key === 'Enter')  { e.preventDefault(); _ok(); }
            if (e.key === 'Escape') { e.preventDefault(); _cancel(); }
        });
        el.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); _cancel(); }
        });
    }

    function _show(msg, mode, def) {
        _ensureDOM();
        document.getElementById('dialog-message').textContent = msg;

        const input    = document.getElementById('dialog-input');
        const cancelBtn = document.getElementById('dialog-cancel');
        const isPrompt = mode === 'prompt';

        input.style.display    = isPrompt ? '' : 'none';
        input.value            = isPrompt ? (def ?? '') : '';
        cancelBtn.style.display = mode === 'alert' ? 'none' : '';

        document.getElementById('dialog-overlay').classList.remove('hidden');

        setTimeout(() => {
            if (isPrompt) { input.focus(); input.select(); }
            else          { document.getElementById('dialog-ok').focus(); }
        }, 30);

        return new Promise(res => { _resolve = res; });
    }

    function _ok() {
        const overlay = document.getElementById('dialog-overlay');
        if (!overlay || !_resolve) return;
        overlay.classList.add('hidden');
        const input = document.getElementById('dialog-input');
        const val   = input.style.display !== 'none' ? input.value : true;
        const r = _resolve; _resolve = null; r(val);
    }

    function _cancel() {
        const overlay = document.getElementById('dialog-overlay');
        if (!overlay || !_resolve) return;
        overlay.classList.add('hidden');
        const r = _resolve; _resolve = null; r(null);
    }

    return {
        alert:   (msg)           => _show(msg, 'alert').then(() => undefined),
        confirm: (msg)           => _show(msg, 'confirm').then(v => v !== null),
        prompt:  (msg, def = '') => _show(msg, 'prompt', def),
    };
})();
