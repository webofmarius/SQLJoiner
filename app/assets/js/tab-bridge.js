/**
 * tab-bridge.js — runs inside every tab iframe (index.php?tab=<id>).
 * Talks to the tab shell (shell.js) in the parent window:
 *   - pushes this window's document.title so the tab label follows the loaded context
 *   - forwards the tab shortcuts (Ctrl+Alt+…), since only the focused frame sees key events
 * No-op when the page is opened on its own (not inside the shell).
 */
(() => {
    if (window.parent === window) return;

    // `App` is a top-level const (not a window property) — expose it for the shell.
    window.__tabApp = App;

    const TAB_ID = new URLSearchParams(location.search).get('tab') || '';
    const send = msg => window.parent.postMessage({ source: 'sqlj-tab', tab: TAB_ID, ...msg }, location.origin);

    // ── Title → tab label ───────────────────────────────────────────────────
    const titleEl = document.querySelector('title');
    if (titleEl) {
        new MutationObserver(() => send({ type: 'title', title: document.title }))
            .observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
    send({ type: 'title', title: document.title });

    // ── Tab shortcuts ───────────────────────────────────────────────────────
    // Capture phase on window: runs before the app's own (Alt-heavy) handlers.
    window.addEventListener('keydown', e => {
        if (!e.ctrlKey || !e.altKey || e.metaKey) return;
        if (!/^(Key[TWD]|Arrow(Left|Right)|Digit[1-9])$/.test(e.code)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        send({ type: 'key', code: e.code, shift: e.shiftKey });
    }, true);
})();
