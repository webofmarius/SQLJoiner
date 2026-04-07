/* =============================================================================
   Autocomplete — reusable input autocomplete module.
   Usage:
       const handle = Autocomplete.attach(inputEl, {
           getSuggestions : () => string[],   // called on every keystroke
           onSelect       : (value) => void,  // called when user confirms a pick
           minChars       : 0,                // optional, default 0
           maxItems       : 12,               // optional, default 12
       });
       handle.detach(); // remove all listeners and dropdown
   ============================================================================= */

const Autocomplete = (() => {

    function attach(inputEl, opts = {}) {
        const getSuggestions = opts.getSuggestions ?? (() => []);
        const onSelect       = opts.onSelect       ?? (() => {});
        const minChars       = opts.minChars       ?? 0;
        const maxItems       = opts.maxItems       ?? 12;

        let dropdown        = null;   // the floating <ul>
        let activeIndex     = -1;     // keyboard-highlighted item index
        let _highlightTimer = null;   // debounce timer for auto-highlighting first item

        // ------------------------------------------------------------------
        // Dropdown lifecycle
        // ------------------------------------------------------------------

        function _open(items) {
            _close();

            dropdown = document.createElement('ul');
            dropdown.className = 'ac-dropdown';

            items.forEach((value, idx) => {
                const li = document.createElement('li');
                li.className   = 'ac-item';
                li.textContent = value;

                // mousedown fires before blur, so we can select before the
                // input loses focus and the blur handler closes the dropdown.
                li.addEventListener('mousedown', e => {
                    e.preventDefault(); // prevent input blur
                    _pick(value);
                });

                li.addEventListener('mousemove', () => _highlight(idx));

                dropdown.appendChild(li);
            });

            document.body.appendChild(dropdown);
            _position();
            activeIndex = -1;
        }

        function _close() {
            clearTimeout(_highlightTimer);
            if (dropdown) { dropdown.remove(); dropdown = null; }
            activeIndex = -1;
        }

        function _position() {
            if (!dropdown) return;
            const r = inputEl.getBoundingClientRect();
            dropdown.style.left  = r.left + 'px';
            dropdown.style.top   = (r.bottom + 2) + 'px';
            dropdown.style.width = r.width + 'px';
        }

        function _highlight(idx) {
            if (!dropdown) return;
            const items = dropdown.querySelectorAll('.ac-item');
            items.forEach((li, i) => li.classList.toggle('ac-active', i === idx));
            activeIndex = idx;
        }

        function _pick(value) {
            inputEl.value = value;
            _close();
            onSelect(value);
        }

        // ------------------------------------------------------------------
        // Input event — filter and show/hide dropdown
        // ------------------------------------------------------------------

        function _onInput() {
            const term = inputEl.value.trim().toLowerCase();

            if (term.length < minChars && minChars > 0) { _close(); return; }

            const all     = getSuggestions();
            const matches = all
                .filter(v => v.toLowerCase().includes(term))
                .slice(0, maxItems);

            if (matches.length === 0) { _close(); return; }

            _open(matches);
            clearTimeout(_highlightTimer);
            if (term === '') {
                _highlight(0); _scrollIntoView();
            } else {
                _highlightTimer = setTimeout(() => { _highlight(0); _scrollIntoView(); }, 500);
            }
        }

        // ------------------------------------------------------------------
        // Keyboard navigation
        // ------------------------------------------------------------------

        function _onKeydown(e) {
            if (!dropdown) {
                // Re-trigger suggestions on ArrowDown when closed
                if (e.key === 'ArrowDown') { e.preventDefault(); _onInput(); _highlight(0); _scrollIntoView(); }
                return;
            }

            const items = dropdown.querySelectorAll('.ac-item');
            const count = items.length;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                _highlight(activeIndex < count - 1 ? activeIndex + 1 : 0);
                _scrollIntoView();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                _highlight(activeIndex > 0 ? activeIndex - 1 : count - 1);
                _scrollIntoView();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const target = activeIndex >= 0 ? items[activeIndex] : items[0];
                if (target) _pick(target.textContent);
            } else if (e.key === 'Escape' || e.key === 'Tab') {
                _close();
            }
        }

        function _scrollIntoView() {
            if (!dropdown || activeIndex < 0) return;
            const item = dropdown.querySelectorAll('.ac-item')[activeIndex];
            item?.scrollIntoView({ block: 'nearest' });
        }

        // ------------------------------------------------------------------
        // Close on blur (small delay to let mousedown on item fire first)
        // ------------------------------------------------------------------

        function _onBlur() {
            setTimeout(_close, 120);
        }

        // ------------------------------------------------------------------
        // Reposition if window resizes or scrolls
        // ------------------------------------------------------------------

        function _onScroll() { _position(); }

        // ------------------------------------------------------------------
        // Wire up
        // ------------------------------------------------------------------

        inputEl.addEventListener('input',   _onInput);
        inputEl.addEventListener('keydown', _onKeydown);
        inputEl.addEventListener('blur',    _onBlur);
        window .addEventListener('scroll',  _onScroll, true);
        window .addEventListener('resize',  _onScroll);

        // ------------------------------------------------------------------
        // Public handle
        // ------------------------------------------------------------------

        return {
            detach() {
                _close();
                inputEl.removeEventListener('input',   _onInput);
                inputEl.removeEventListener('keydown', _onKeydown);
                inputEl.removeEventListener('blur',    _onBlur);
                window .removeEventListener('scroll',  _onScroll, true);
                window .removeEventListener('resize',  _onScroll);
            },
        };
    }

    return { attach };

})();
