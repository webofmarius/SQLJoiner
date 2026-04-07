/**
 * profiles.js — Connection profile management UI
 *
 * Owns everything related to the Profiles modal:
 *   - Rendering the profile list inside the modal
 *   - Populating the top-bar profile <select>
 *   - Add / Edit / Delete / Test connection form
 *
 * Depends on: api.js (API), app.js (State) — referenced at runtime only.
 * Loaded before app.js, so App/State/Modals are NOT available at definition time.
 */

const Profiles = (() => {

    /** In-memory cache of profiles (passwords always stripped). */
    let _cache = [];

    // =========================================================================
    // Load & Render
    // =========================================================================

    /**
     * Fetches profiles from the server, updates the cache,
     * re-renders the modal list, and repopulates the top-bar select.
     */
    async function loadAndRender() {
        try {
            _cache = await API.profiles.list();
        } catch {
            _cache = [];
        }
        _renderModalList();
        _populateSelect();
    }

    /** Renders the profile cards inside the modal. */
    function _renderModalList() {
        const container = document.getElementById('profiles-list');
        container.innerHTML = '';

        if (_cache.length === 0) {
            container.innerHTML =
                '<p style="font-size:12px;color:var(--text-muted);font-style:italic">No profiles yet. Add one below.</p>';
            return;
        }

        _cache.forEach(p => {
            const item = document.createElement('div');
            item.className      = 'profile-item';
            item.dataset.id     = p.id;

            item.innerHTML = `
                <div class="profile-item__info">
                    <div class="profile-item__name">${_esc(p.name)}</div>
                    <div class="profile-item__host">
                        ${_esc(p.user)}@${_esc(p.host)}:${p.port}
                        &nbsp;/&nbsp;<strong>${_esc(p.database)}</strong>
                    </div>
                </div>
                <div class="profile-item__actions">
                    <button class="btn-icon btn-edit" title="Edit profile">✏</button>
                    <button class="btn-icon btn-delete" title="Delete profile">✕</button>
                </div>
            `;

            item.querySelector('.btn-edit')
                .addEventListener('click', () => _populateForm(p));

            item.querySelector('.btn-delete')
                .addEventListener('click', () => _confirmDelete(p.id, p.name));

            item.addEventListener('click', e => {
                if (e.target.closest('button')) return;
                item.querySelector('.btn-edit')?.click();
            });

            container.appendChild(item);
        });
    }

    /** Populates the top-bar <select> from the cached profile list. */
    function _populateSelect() {
        const sel     = document.getElementById('profile-select');
        const current = sel.value;

        sel.innerHTML = '<option value="">— Select Connection —</option>';

        _cache.forEach(p => {
            const opt       = document.createElement('option');
            opt.value       = p.id;
            opt.textContent = p.name;
            sel.appendChild(opt);
        });

        // Restore previously selected value if still valid
        if (current) sel.value = current;
    }

    // =========================================================================
    // Form helpers
    // =========================================================================

    /** Fills the form fields for editing an existing profile. */
    function _populateForm(profile) {
        document.getElementById('profile-form-title').textContent = 'Edit Profile';
        document.getElementById('profile-id').value               = profile.id;
        document.getElementById('profile-name').value             = profile.name;
        document.getElementById('profile-host').value             = profile.host;
        document.getElementById('profile-port').value             = profile.port;
        document.getElementById('profile-database').value         = profile.database;
        document.getElementById('profile-user').value             = profile.user;
        document.getElementById('profile-password').value         = '';
        document.getElementById('profile-password').placeholder   = '(leave blank to keep existing password)';
        _clearTestResult();
    }

    /** Resets the form to "Add Profile" state. */
    function clearForm() {
        document.getElementById('profile-form-title').textContent = 'Add Profile';
        document.getElementById('profile-form').reset();
        document.getElementById('profile-id').value             = '';
        document.getElementById('profile-port').value           = '3306';
        document.getElementById('profile-password').placeholder = '(leave blank if none)';
        _clearTestResult();
    }

    /** Reads current form values into a plain object. */
    function _readForm() {
        return {
            id:       document.getElementById('profile-id').value.trim() || null,
            name:     document.getElementById('profile-name').value.trim(),
            host:     document.getElementById('profile-host').value.trim(),
            port:     parseInt(document.getElementById('profile-port').value, 10) || 3306,
            database: document.getElementById('profile-database').value.trim(),
            user:     document.getElementById('profile-user').value.trim(),
            password: document.getElementById('profile-password').value,
        };
    }

    // =========================================================================
    // Save
    // =========================================================================

    async function _saveProfile() {
        const data = _readForm();

        if (!data.name || !data.host || !data.database || !data.user) {
            _showTestResult('Name, Host, Database and Username are required.', 'error');
            return;
        }

        const duplicate = _cache.find(
            p => p.name.trim().toLowerCase() === data.name.toLowerCase() && p.id !== data.id
        );
        if (duplicate) {
            _showTestResult(`Name "${data.name}" is already used by another profile. Please choose a different name.`, 'error');
            document.getElementById('profile-name').focus();
            return;
        }

        const btn      = document.getElementById('btn-save-profile');
        const original = btn.textContent;
        btn.textContent = 'Saving…';
        btn.disabled    = true;

        try {
            const saved  = await API.profiles.save(data);
            const isNew  = !data.id;

            await loadAndRender();
            clearForm();
            _showTestResult('Profile saved.', 'success');

            // Auto-select and activate newly created profiles
            if (isNew && saved?.id) {
                const sel   = document.getElementById('profile-select');
                sel.value   = saved.id;
                // Trigger App's change handler (activates the profile + loads tables)
                sel.dispatchEvent(new Event('change'));
            } else if (data.id && data.id === document.getElementById('profile-select').value) {
                // If we just edited the active profile, reload tables
                App.loadTables();
            }

        } catch (e) {
            _showTestResult('Save failed: ' + e.message, 'error');
        } finally {
            btn.textContent = original;
            btn.disabled    = false;
        }
    }

    // =========================================================================
    // Delete
    // =========================================================================

    async function _confirmDelete(id, name) {
        if (!await Dialog.confirm(`Delete profile "${name}"?\n\nThis cannot be undone.`)) return;

        try {
            await API.profiles.delete(id);

            // If deleting the active profile, clear the selection
            if (typeof State !== 'undefined' && State.activeProfileId === id) {
                State.activeProfileId = null;
                localStorage.removeItem('activeProfileId');
                document.getElementById('profile-select').value = '';
                document.getElementById('table-list').innerHTML =
                    '<li class="sidebar-hint">Select a connection above</li>';
            }

            await loadAndRender();
        } catch (e) {
            Dialog.alert('Delete failed: ' + e.message);
        }
    }

    // =========================================================================
    // Test connection
    // =========================================================================

    async function _testProfile() {
        const data = _readForm();

        if (!data.host || !data.database || !data.user) {
            _showTestResult('Host, Database and Username are required to test.', 'error');
            return;
        }

        const btn      = document.getElementById('btn-test-profile');
        const original = btn.textContent;
        btn.textContent = 'Testing…';
        btn.disabled    = true;

        try {
            await API.profiles.test(data);
            _showTestResult('✅ Connection successful!', 'success');
        } catch (e) {
            _showTestResult('❌ ' + e.message, 'error');
        } finally {
            btn.textContent = original;
            btn.disabled    = false;
        }
    }

    // =========================================================================
    // Feedback helpers
    // =========================================================================

    function _showTestResult(msg, type) {
        const el    = document.getElementById('profile-test-result');
        el.textContent = msg;
        el.className   = type; // 'success' or 'error' — matches CSS classes
    }

    function _clearTestResult() {
        const el       = document.getElementById('profile-test-result');
        el.textContent = '';
        el.className   = '';
    }

    /** Minimal HTML escaping to prevent XSS in dynamically built markup. */
    function _esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // =========================================================================
    // Event binding — called once from App.init()
    // =========================================================================

    function bindEvents() {
        document.getElementById('btn-save-profile')
            .addEventListener('click', _saveProfile);

        document.getElementById('btn-test-profile')
            .addEventListener('click', _testProfile);

        document.getElementById('btn-clear-profile-form')
            .addEventListener('click', clearForm);
    }

    // =========================================================================
    // Public surface
    // =========================================================================
    return {
        loadAndRender,
        clearForm,
        bindEvents,
    };

})();
