/**
 * shell.js — tab manager for shell.php.
 *
 * Every tab is an <iframe> loading index.php?tab=<id>: a full, independent copy
 * of the app (its own State, canvas, results, undo…). Switching tabs only toggles
 * visibility, so a tab keeps its state and any running query.
 *
 * Duplicate / Reopen-closed-tab move a tab's state between windows via
 * App.exportTabState() / App.importTabState() (via window.__tabApp, set by tab-bridge.js) (same-origin, called directly).
 *
 * Shortcuts (also forwarded from the iframes by tab-bridge.js):
 *   Ctrl+Alt+T new · Ctrl+Alt+W close · Ctrl+Alt+D duplicate · Ctrl+Alt+Shift+T reopen
 *   Ctrl+Alt+←/→ previous / next · Ctrl+Alt+1…9 jump
 */
(() => {
    const MAX_TABS    = 12;
    const MAX_CLOSED  = 10;
    const STORE_KEY   = 'sqlj-shell-tabs';   // { count, active } — tabs reopen blank
    const BASE_TITLE  = document.title;

    const tabsEl   = document.getElementById('tabs');
    const framesEl = document.getElementById('tab-frames');
    const menuEl   = document.getElementById('tab-menu');
    const reopenEl = document.getElementById('tab-reopen');

    const tabs   = [];   // { id, el, titleEl, frame, autoTitle, customTitle, loaded }
    const closed = [];   // most recent last: { snap, customTitle }
    let activeId = null;
    let seq      = 0;

    // ── helpers ─────────────────────────────────────────────────────────────
    const byId     = id => tabs.find(t => t.id === id) ?? null;
    const active   = () => byId(activeId);
    const win      = t => t?.frame.contentWindow ?? null;
    const label    = t => t.customTitle || t.autoTitle || 'New tab';
    const notify   = (msg, type = 'warn') => {
        const w = win(active());
        if (w?.__tabApp?.notify) w.__tabApp.notify(msg, type); else console.warn(msg);
    };

    function persist() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify({
                count:  tabs.length,
                active: Math.max(0, tabs.indexOf(active())),
            }));
        } catch (_) { /* storage unavailable — tabs just won't be remembered */ }
    }

    function refreshLabel(t) {
        t.titleEl.textContent = label(t);
        t.el.title = label(t);
        if (t.id === activeId) document.title = t.autoTitle ? `${BASE_TITLE} - ${t.autoTitle}` : BASE_TITLE;
    }

    function refreshReopen() {
        reopenEl.disabled = closed.length === 0;
    }

    // ── create / activate ───────────────────────────────────────────────────
    /**
     * opts.snapshot     state to restore into the new tab (exportTabState() result)
     * opts.keepIdentity restore the saved-context link too (reopen) vs. a detached copy (duplicate)
     * opts.customTitle  user-chosen tab name
     * opts.afterId      insert after this tab (default: at the end)
     * opts.lazy         don't load the app until the tab is first activated (blank restored tabs)
     * opts.activate     default true
     */
    function createTab(opts = {}) {
        if (tabs.length >= MAX_TABS) { notify(`Tab limit reached (${MAX_TABS}).`); return null; }

        const id = 't' + Date.now().toString(36) + (seq++);
        const t  = { id, autoTitle: '', customTitle: opts.customTitle || '', loaded: false, snapshot: opts.snapshot ?? null, keepIdentity: !!opts.keepIdentity };

        const el = document.createElement('div');
        el.className = 'tab';
        el.dataset.id = id;
        el.draggable = true;
        el.setAttribute('role', 'tab');

        const titleEl = document.createElement('span');
        titleEl.className = 'tab-title';
        const closeEl = document.createElement('button');
        closeEl.type = 'button';
        closeEl.className = 'tab-close';
        closeEl.textContent = '✕';
        closeEl.title = 'Close tab (Ctrl+Alt+W)';
        el.append(titleEl, closeEl);

        const frame = document.createElement('iframe');
        frame.className = 'tab-frame';
        frame.title = 'Tab';
        frame.setAttribute('allow', 'fullscreen');   // lets the app's full-screen button work from inside the frame

        Object.assign(t, { el, titleEl, frame });

        const afterIdx = opts.afterId ? tabs.indexOf(byId(opts.afterId)) : -1;
        if (afterIdx >= 0) {
            tabs.splice(afterIdx + 1, 0, t);
            tabsEl.insertBefore(el, tabs[afterIdx].el.nextSibling);
        } else {
            tabs.push(t);
            tabsEl.appendChild(el);
        }
        framesEl.appendChild(frame);
        refreshLabel(t);
        bindTabEvents(t, closeEl);

        if (!opts.lazy) loadFrame(t);
        if (opts.activate !== false) activate(id);
        persist();
        return t;
    }

    function loadFrame(t) {
        if (t.loaded) return;
        t.loaded = true;
        t.frame.addEventListener('load', async () => {
            if (!t.snapshot) return;
            const snap = t.snapshot;
            t.snapshot = null;
            try {
                await whenReady(t.frame.contentWindow);
                await t.frame.contentWindow.__tabApp.importTabState(snap, { keepIdentity: t.keepIdentity });
            } catch (e) {
                console.error('Tab restore failed', e);
                notify('Could not restore tab state: ' + e.message, 'error');
            }
        }, { once: true });
        t.frame.src = 'index.php?tab=' + encodeURIComponent(t.id);
    }

    function whenReady(w) {
        return new Promise(resolve => {
            if (w.appReady) return resolve();
            w.addEventListener('app-ready', () => resolve(), { once: true });
        });
    }

    function activate(id) {
        const t = byId(id);
        if (!t) return;
        const wasActive = activeId === id;
        activeId = id;
        loadFrame(t);
        tabs.forEach(x => {
            const on = x === t;
            x.el.classList.toggle('is-active', on);
            x.el.setAttribute('aria-selected', on ? 'true' : 'false');
            x.frame.classList.toggle('is-active', on);
        });
        refreshLabel(t);
        t.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        persist();
        // Hand keyboard focus to the app so its own shortcuts work right away
        // (not when re-clicking the active tab — that would steal focus from a rename in progress)
        if (!wasActive) setTimeout(() => { try { win(t)?.focus(); } catch (_) {} }, 0);
    }

    // ── close / reopen / duplicate ──────────────────────────────────────────
    function snapshotOf(t) {
        try {
            const w = win(t);
            if (!t.loaded || !w?.__tabApp?.exportTabState) return null;
            return w.__tabApp.exportTabState();
        } catch (_) { return null; }
    }

    /** A tab worth bringing back: has tables, a custom query or notes. */
    function isMeaningful(snap) {
        if (!snap) return false;
        try {
            const c = JSON.parse(snap.json);
            return (c.tables?.length > 0) || !!(c.customQuery || '').trim() || !!(c.notes || '').trim();
        } catch (_) { return false; }
    }

    function closeTab(id, { quiet = false } = {}) {
        const t = byId(id);
        if (!t) return;

        const snap = snapshotOf(t);
        if (isMeaningful(snap)) {
            closed.push({ snap, customTitle: t.customTitle });
            if (closed.length > MAX_CLOSED) closed.shift();
        }
        refreshReopen();

        const idx = tabs.indexOf(t);
        tabs.splice(idx, 1);
        t.el.remove();
        t.frame.src = 'about:blank';   // release the page before removing the frame
        t.frame.remove();

        if (tabs.length === 0) {
            createTab();               // never leave the window without a tab
        } else if (activeId === id) {
            activate(tabs[Math.min(idx, tabs.length - 1)].id);
        }
        if (!quiet) persist();
    }

    function closeOthers(id) {
        tabs.filter(t => t.id !== id).forEach(t => closeTab(t.id, { quiet: true }));
        activate(id);
        persist();
    }

    function reopenClosed() {
        const entry = closed.pop();
        refreshReopen();
        if (!entry) return;
        const t = createTab({ snapshot: entry.snap, keepIdentity: true, customTitle: entry.customTitle });
        if (!t) { closed.push(entry); refreshReopen(); }
    }

    function duplicateTab(id) {
        const src  = byId(id);
        const snap = snapshotOf(src);
        if (!snap) { notify('This tab is still loading — try again in a moment.'); return; }
        createTab({
            snapshot:    snap,
            keepIdentity: false,
            customTitle: src.customTitle ? `${src.customTitle} (copy)` : '',
            afterId:     id,
        });
    }

    // ── rename ──────────────────────────────────────────────────────────────
    function startRename(t) {
        if (t.titleEl.querySelector('input')) return;
        const input = document.createElement('input');
        input.className = 'tab-title-input';
        input.value = label(t);
        input.maxLength = 60;
        t.el.draggable = false;
        t.titleEl.textContent = '';
        t.titleEl.appendChild(input);
        input.focus();
        input.select();

        let done = false;
        const finish = commit => {
            if (done) return;
            done = true;
            if (commit) {
                const v = input.value.trim();
                // Typing the auto title (or nothing) clears the override so the tab follows its context again
                t.customTitle = (v && v !== (t.autoTitle || 'New tab')) ? v : '';
            }
            t.el.draggable = true;
            refreshLabel(t);
        };
        input.addEventListener('keydown', e => {
            e.stopPropagation();
            if (e.key === 'Enter')  finish(true);
            if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('click', e => e.stopPropagation());
        input.addEventListener('dblclick', e => e.stopPropagation());
    }

    // ── tab events: click, middle-click, context menu, drag-reorder ─────────
    function bindTabEvents(t, closeEl) {
        t.el.addEventListener('click', e => {
            if (e.target === closeEl) return;
            activate(t.id);
        });
        t.el.addEventListener('auxclick', e => {          // middle-click closes
            if (e.button === 1) { e.preventDefault(); closeTab(t.id); }
        });
        t.el.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
        closeEl.addEventListener('click', e => { e.stopPropagation(); closeTab(t.id); });
        t.el.addEventListener('dblclick', e => {            // anywhere on the tab (except ✕) renames it
            if (e.target === closeEl) return;
            startRename(t);
        });
        t.el.addEventListener('contextmenu', e => { e.preventDefault(); showMenu(t, e.clientX, e.clientY); });

        t.el.addEventListener('dragstart', e => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/x-tab-id', t.id);
            t.el.classList.add('is-dragging');
        });
        t.el.addEventListener('dragend', () => {
            t.el.classList.remove('is-dragging');
            tabs.forEach(x => x.el.classList.remove('drop-before', 'drop-after'));
        });
        t.el.addEventListener('dragover', e => {
            if (!e.dataTransfer.types.includes('text/x-tab-id')) return;
            e.preventDefault();
            const before = e.clientX < t.el.getBoundingClientRect().left + t.el.offsetWidth / 2;
            t.el.classList.toggle('drop-before', before);
            t.el.classList.toggle('drop-after', !before);
        });
        t.el.addEventListener('dragleave', () => t.el.classList.remove('drop-before', 'drop-after'));
        t.el.addEventListener('drop', e => {
            const srcId = e.dataTransfer.getData('text/x-tab-id');
            const src   = byId(srcId);
            const before = t.el.classList.contains('drop-before');
            t.el.classList.remove('drop-before', 'drop-after');
            if (!src || src === t) return;
            e.preventDefault();
            tabs.splice(tabs.indexOf(src), 1);
            const to = tabs.indexOf(t) + (before ? 0 : 1);
            tabs.splice(to, 0, src);
            tabsEl.insertBefore(src.el, before ? t.el : t.el.nextSibling);
            persist();
        });
    }

    // ── context menu ────────────────────────────────────────────────────────
    function showMenu(t, x, y) {
        const items = [
            ['Duplicate tab',         () => duplicateTab(t.id)],
            ['Rename…',               () => startRename(t)],
            null,
            ['Close tab',             () => closeTab(t.id)],
            ['Close other tabs',      () => closeOthers(t.id), tabs.length < 2],
            null,
            ['Reopen closed tab',     () => reopenClosed(), closed.length === 0],
        ];
        menuEl.innerHTML = '';
        for (const it of items) {
            const li = document.createElement('li');
            if (!it) { li.className = 'menu-sep'; menuEl.appendChild(li); continue; }
            li.textContent = it[0];
            li.setAttribute('role', 'menuitem');
            if (it[2]) li.classList.add('is-disabled');
            else li.addEventListener('click', () => { hideMenu(); it[1](); });
            menuEl.appendChild(li);
        }
        menuEl.classList.remove('hidden');
        const r = menuEl.getBoundingClientRect();
        menuEl.style.left = Math.min(x, window.innerWidth  - r.width  - 4) + 'px';
        menuEl.style.top  = Math.min(y, window.innerHeight - r.height - 4) + 'px';
    }
    function hideMenu() { menuEl.classList.add('hidden'); }

    document.addEventListener('mousedown', e => { if (!menuEl.contains(e.target)) hideMenu(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') hideMenu(); });
    window.addEventListener('blur', hideMenu);   // focus moved into an iframe

    // ── shortcuts ───────────────────────────────────────────────────────────
    function handleKey(code, shift) {
        const cur = tabs.indexOf(active());
        if (code === 'KeyT')            return shift ? reopenClosed() : createTab();
        if (code === 'KeyW')            return closeTab(activeId);
        if (code === 'KeyD')            return duplicateTab(activeId);
        if (code === 'ArrowRight')      return activate(tabs[(cur + 1) % tabs.length].id);
        if (code === 'ArrowLeft')       return activate(tabs[(cur - 1 + tabs.length) % tabs.length].id);
        const m = code.match(/^Digit([1-9])$/);
        if (m) {
            const n = parseInt(m[1], 10);
            // Like browsers: 9 always means "last tab"
            const target = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
            if (target) activate(target.id);
        }
    }

    // F11 / Cmd|Ctrl+Alt+F while focus is in the shell itself (inside a tab, the app handles it)
    window.addEventListener('keydown', e => {
        const isF11 = e.code === 'F11' && !e.ctrlKey && !e.metaKey && !e.altKey;
        const isCtrlAltF = e.code === 'KeyF' && e.altKey && (e.metaKey || e.ctrlKey);
        if (!isF11 && !isCtrlAltF) return;
        e.preventDefault();
        if (document.fullscreenElement) document.exitFullscreen?.();
        else document.documentElement.requestFullscreen?.().catch(() => {});
    });

    // Keys pressed while focus is in the shell itself (e.g. after clicking the tab bar)
    window.addEventListener('keydown', e => {
        if (!e.ctrlKey || !e.altKey || e.metaKey) return;
        if (!/^(Key[TWD]|Arrow(Left|Right)|Digit[1-9])$/.test(e.code)) return;
        e.preventDefault();
        handleKey(e.code, e.shiftKey);
    }, true);

    // Messages from tab-bridge.js inside the iframes
    window.addEventListener('message', e => {
        if (e.origin !== location.origin || e.data?.source !== 'sqlj-tab') return;
        const t = tabs.find(x => x.frame.contentWindow === e.source);
        if (!t) return;
        if (e.data.type === 'title') {
            const title = String(e.data.title || '');
            const prefix = BASE_TITLE + ' - ';
            t.autoTitle = title.startsWith(prefix) ? title.slice(prefix.length) : '';
            if (!t.titleEl.querySelector('input')) refreshLabel(t);
        } else if (e.data.type === 'key' && t.id === activeId) {
            handleKey(String(e.data.code), !!e.data.shift);
        }
    });

    document.getElementById('tab-new').addEventListener('click', () => createTab());
    reopenEl.addEventListener('click', reopenClosed);

    // ── boot: reopen the same number of (blank) tabs as last time ───────────
    let saved = { count: 1, active: 0 };
    try { saved = { ...saved, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; } catch (_) {}
    const count = Math.min(MAX_TABS, Math.max(1, parseInt(saved.count, 10) || 1));
    const start = Math.min(count - 1, Math.max(0, parseInt(saved.active, 10) || 0));
    for (let i = 0; i < count; i++) {
        // Only the starting tab loads now; the rest load on first visit (they're blank anyway)
        createTab({ lazy: i !== start, activate: false });
    }
    activate(tabs[start].id);
    refreshReopen();
})();
