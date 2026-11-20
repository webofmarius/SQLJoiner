'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadResultsInternals(state) {
    const resultsPath = path.join(__dirname, '..', 'assets', 'js', 'results.js');
    let source = fs.readFileSync(resultsPath, 'utf8');
    const marker = '        return col; // fallback (custom expressions, derived columns)\n    }';
    assert.ok(source.includes(marker), 'private helper exposure marker must remain available');
    source = source.replace(marker, `${marker}\n    globalThis.__computeColKey = _computeColKey;`);
    const permutationMarker = '    function reorderColumnsToMatch(order) {';
    assert.ok(source.includes(permutationMarker), 'permutation helper exposure marker must remain available');
    source = source.replace(
        permutationMarker,
        '    globalThis.__columnPermutationForOrder = _columnPermutationForOrder;\n' +
        '    globalThis.__isDelimiterColumn = _isDelimiterColumn;\n\n' + permutationMarker
    );

    const context = {
        State: state,
        console,
        document: {
            addEventListener() {},
            getElementById() { return null; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
        },
        window: { addEventListener() {} },
        navigator: {},
        setTimeout,
        clearTimeout,
        CustomEvent: function CustomEvent() {},
        Blob: function Blob() {},
        URL: {},
    };
    vm.runInNewContext(source, context, { filename: resultsPath });
    return {
        computeColKey: context.__computeColKey,
        columnPermutationForOrder: context.__columnPermutationForOrder,
        isDelimiterColumn: context.__isDelimiterColumn,
    };
}

function baseState() {
    return {
        selectAliases: {},
        select: [],
        columnOrder: ['u.id', 'u.name', 'o.id', 'o.total'],
        tables: [
            { id: '1', name: 'users', alias: 'u', columns: [{ name: 'id' }, { name: 'name' }] },
            { id: '2', name: 'orders', alias: 'o', columns: [{ name: 'id' }, { name: 'total' }] },
        ],
    };
}

test('reconstructs every result key when the driver omits table metadata', () => {
    const state = baseState();
    const { computeColKey: compute } = loadResultsInternals(state);
    const cols = ['id', 'name', 'id', 'total'];
    const keys = cols.map((col, idx) => compute(col, '', idx, cols, [], null));

    assert.deepEqual(keys, state.columnOrder);
});

test('does not assign an unselected same-named column', () => {
    const state = baseState();
    state.select = ['u.name', 'o.id', 'o.total'];
    const { computeColKey: compute } = loadResultsInternals(state);
    const cols = ['name', 'id', 'total'];
    const keys = cols.map((col, idx) => compute(col, '', idx, cols, [], null));

    assert.deepEqual(keys, state.select);
});

test('keeps all columns together for aliases of the same self-joined table', () => {
    const state = {
        selectAliases: {},
        select: [],
        columnOrder: ['e.id', 'e.name', 'm.id', 'm.name'],
        tables: [
            { id: '1', name: 'employees', alias: 'e', columns: [{ name: 'id' }, { name: 'name' }] },
            { id: '2', name: 'employees', alias: 'm', columns: [{ name: 'id' }, { name: 'name' }] },
        ],
    };
    const { computeColKey: compute } = loadResultsInternals(state);
    const cols = ['id', 'name', 'id', 'name'];
    const tables = ['employees', 'employees', 'employees', 'employees'];
    const keys = cols.map((col, idx) => compute(col, tables[idx], idx, cols, tables, null));

    assert.deepEqual(keys, state.columnOrder);
});

test('moves the table delimiter to the reordered table boundary', () => {
    const state = baseState();
    const { columnPermutationForOrder } = loadResultsInternals(state);
    const keys = ['u.id', '|||', 'o.id', 'o.total', 'o.status'];
    const delimiters = [false, true, false, false, false];
    const order = ['o.id', 'o.total', 'o.status', 'u.id'];

    assert.deepEqual(
        columnPermutationForOrder(keys, delimiters, order, true),
        [2, 3, 4, 1, 0]
    );
});

test('moves the delimiter after all seven columns in the reported b/af case', () => {
    const state = baseState();
    const { columnPermutationForOrder, isDelimiterColumn } = loadResultsInternals(state);
    const keys = [
        'b.id', 'b.timestamp', 'b.sursa', 'b.url', "'|||'",
        'af.id', 'af.url', 'af.stored_name', 'af.original_name',
        'af.mime_type', 'af.size', 'af.uploaded_at',
    ];
    const delimiters = keys.map(isDelimiterColumn);
    const order = [
        'af.id', 'af.url', 'af.stored_name', 'af.original_name',
        'af.mime_type', 'af.size', 'af.uploaded_at',
        'b.id', 'b.timestamp', 'b.sursa', 'b.url',
    ];

    assert.deepEqual(
        columnPermutationForOrder(keys, delimiters, order, true),
        [5, 6, 7, 8, 9, 10, 11, 4, 0, 1, 2, 3]
    );
});

test('recognizes plain and SQL-quoted delimiter result headers', () => {
    const state = baseState();
    const { isDelimiterColumn } = loadResultsInternals(state);

    assert.equal(isDelimiterColumn('|||'), true);
    assert.equal(isDelimiterColumn("'|||'"), true);
    assert.equal(isDelimiterColumn('"|||"'), true);
    assert.equal(isDelimiterColumn('`|||`'), true);
    assert.equal(isDelimiterColumn("'|||"), false);
    assert.equal(isDelimiterColumn('af.original_name'), false);
});

test('moves an existing delimiter even after the option is unchecked', () => {
    const state = baseState();
    const { columnPermutationForOrder } = loadResultsInternals(state);
    const keys = ['u.id', '|||', 'o.id', 'o.total', 'o.status'];
    const delimiters = [false, true, false, false, false];
    const order = ['o.id', 'o.total', 'o.status', 'u.id'];

    assert.deepEqual(
        // reorderColumnsToMatch derives this from the rendered delimiter itself,
        // not from the now-unchecked option.
        columnPermutationForOrder(keys, delimiters, order, delimiters.some(Boolean)),
        [2, 3, 4, 1, 0]
    );
});
