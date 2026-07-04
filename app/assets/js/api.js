/**
 * api.js — Central fetch wrapper for all calls to api.php
 *
 * All functions return a Promise that resolves with response.data
 * on success, or rejects with an Error containing the server message.
 *
 * Usage:
 *   const profiles = await API.profiles.list();
 *   await API.profiles.save({ name: 'Local', host: 'localhost', ... });
 */

const API = (() => {

    const ENDPOINT = 'api.php';

    /**
     * Core fetch helper.
     * @param {string} action  - matches a route key in api.php
     * @param {object} data    - JSON body payload
     * @returns {Promise<any>} - resolves with response.data
     */
    async function call(action, data = {}, signal = null) {
        let response;

        try {
            response = await fetch(`${ENDPOINT}?action=${encodeURIComponent(action)}`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(data),
                signal:  signal ?? undefined,
            });
        } catch (networkError) {
            if (networkError.name === 'AbortError') throw networkError; // let callers handle cancellation
            throw new Error(`Network error on [${action}]: ${networkError.message}`);
        }

        // Always parse the JSON body first — Response::error() sets a non-2xx
        // HTTP status but the real error message lives in json.message, so we
        // must not bail out on !response.ok before reading the body.
        let json;
        try {
            json = await response.json();
        } catch {
            // Body isn't JSON at all — fall back to the HTTP status line
            throw new Error(`HTTP ${response.status} on [${action}]`);
        }

        if (!json.success) {
            throw new Error(json.message || `HTTP ${response.status} on [${action}]`);
        }

        return json.data;
    }

    // -------------------------------------------------------------------------
    // Public API surface — mirrors the route map in api.php
    // -------------------------------------------------------------------------
    return {

        /** Connection profile CRUD */
        profiles: {
            list:   ()       => call('profile.list'),
            save:   (data)   => call('profile.save',   data),
            delete: (id)     => call('profile.delete', { id }),
            test:   (data)   => call('profile.test',   data),
        },

        /** Database schema discovery */
        schema: {
            databases:       (profileId)                           => call('schema.databases',       { profileId }),
            tables:          (profileId, database = '')            => call('schema.tables',          { profileId, database }),
            columns:         (profileId, tableName, database = '') => call('schema.columns',         { profileId, table: tableName, database }),
            createStatement: (profileId, tableName, database = '') => call('schema.createStatement', { profileId, table: tableName, database }),
            rowCounts:       (profileId, tables, database = '')    => call('schema.rowCounts',       { profileId, tables, database }),
        },

        /** Query building and execution */
        query: {
            execute:       (queryState, signal)     => call('query.execute',    queryState,         signal),
            executeRaw:    (profileId, sql, signal) => call('query.executeRaw', { profileId, sql }, signal),
            preview:       (queryState)             => call('query.preview',    queryState),
            parseFromSQL:  (profileId, sql)         => call('query.parseFromSQL', { profileId, sql }),
        },

        /** Canvas context save/load/list/delete */
        context: {
            save:      (contextData) => call('context.save',      contextData),
            load:      (id)          => call('context.load',      { id }),
            list:      ()            => call('context.list'),
            delete:    (id)          => call('context.delete',    { id }),
            rename:    (id, name)    => call('context.rename',   { id, name }),
            update:    (id, data)   => call('context.update',   { id, ...data }),
        },

        /** About text */
        about: {
            read: () => call('about.read'),
        },

        /** Timestamp converter */
        timestamp: {
            convert: (profileId, value, direction) => call('timestamp.convert', { profileId, value, direction }),
        },


    };

})();
