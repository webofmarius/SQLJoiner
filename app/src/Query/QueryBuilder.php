<?php

declare(strict_types=1);

namespace Query;

use Core\Request;
use Core\Response;
use Database\Connection;
use Database\ProfileManager;

/**
 * QueryBuilder — assembles and executes SELECT statements from the canvas state.
 *
 * Routes:
 *   query.execute  → execute()   runs the query, returns rows + metadata
 *   query.preview  → preview()   returns the generated SQL string only (no execution)
 *
 * State shape received from the front-end (mirrors the JS State object):
 * {
 *   profileId    : string,
 *   tables       : [{ id, name, alias, columns, database? }],
 *   joins        : [{ id, fromTableId, fromCol, toTableId, toCol, type }],
 *   select            : string[],           // empty = SELECT * (ignored in raw mode)
 *   selectRaw         : string,             // used when selectMode='raw'
 *   selectMode        : 'visual'|'raw',
 *   selectCustomExprs : [{id, expr, alias, enabled}],  // custom SQL expressions appended to SELECT
 *   selectAliases     : object,  // map "alias.col" → column alias (AS name) for visual SELECT
 *   where        : [{ col, op, val }], // visual conditions
 *   whereRaw     : string,             // used when whereMode='raw'
 *   whereMode    : 'visual'|'raw',
 *   orderBy      : [{ col, dir }],
 *   orderByRaw   : string,
 *   orderByMode  : 'visual'|'raw',
 *   limit        : int
 * }
 *
 * Security notes:
 *   - Table names and aliases are validated with /^\w+$/
 *   - Column refs in SELECT/WHERE/ORDER BY validated with /^\w+\.\w+$/
 *   - WHERE values are passed verbatim (user is responsible for quoting)
 *   - Raw WHERE/ORDER BY text is passed verbatim (developer-controlled)
 *   - LIMIT is cast to int and capped at 5000 to prevent runaway queries
 */
class QueryBuilder
{
    private const MAX_LIMIT = 5000;

    // =========================================================================
    // Public route handlers
    // =========================================================================

    /**
     * Execute the query and return rows + metadata.
     * Response data: { sql, cols, rows, count }
     */
    public function execute(Request $request): void
    {
        [$pdo, $sql, $warnings] = $this->buildFromRequest($request);

        // Reject if island validation produced warnings (buildFromRequest already
        // called Response::error for execute mode, but guard here for safety)
        if (!empty($warnings)) {
            Response::error(implode(' ', $warnings), 400);
        }

        if ($this->containsVariables($sql)) {
            Response::error('Queries containing session variables (@name) cannot be executed against the database. Remove variables before running.', 400);
        }

        try {
            $this->registerConnectionId($pdo);
            $stmt = $pdo->query($sql);
            // FETCH_NUM preserves duplicate column names (FETCH_ASSOC collapses them).
            $rows = $stmt->fetchAll(\PDO::FETCH_NUM);

            // Extract column names and source table names from PDO statement metadata.
            // col_tables[i] is the real table name (not alias) for cols[i]; empty string
            // for derived/expression columns.  The frontend uses this to look up the alias.
            // getColumnMeta() can return false on remote TCP connections — guard against it.
            $cols      = [];
            $colTables = [];
            $colTypes  = [];
            for ($i = 0; $i < $stmt->columnCount(); $i++) {
                $meta        = $stmt->getColumnMeta($i) ?: [];
                $cols[]      = $meta['name'] ?? "col_{$i}";
                $colTables[] = $meta['table'] ?? '';
                $colTypes[]  = $this->normaliseColType($meta);
            }

            Response::success([
                'sql'        => $sql,
                'cols'       => $cols,
                'col_tables' => $colTables,
                'col_types'  => $colTypes,
                'rows'       => $rows,
                'count'      => count($rows),
            ]);
        } catch (\PDOException $e) {
            Response::error('Query failed: ' . $e->getMessage(), 400);
        }
    }

    /**
     * Execute an arbitrary SQL string supplied by the user.
     * Response data: { sql, cols, col_tables, rows, count }
     */
    public function executeRaw(Request $request): void
    {
        $profileId = (string) $request->get('profileId', '');
        if ($profileId === '') {
            Response::error('profileId is required.', 400);
        }

        $sql = trim((string) $request->get('sql', ''));
        if ($sql === '') {
            Response::error('sql is required.', 400);
        }

        $pm      = new ProfileManager();
        $profile = $pm->getProfileById($profileId);
        if ($profile === null) {
            Response::error('Profile not found.', 404);
        }

        try {
            $conn = new Connection($profile);
            $pdo  = $conn->getPdo();
        } catch (\PDOException $e) {
            Response::error('Connection failed: ' . $e->getMessage(), 503);
        }

        if ($this->containsVariables($sql)) {
            Response::error('Queries containing session variables (@name) cannot be executed against the database. Remove variables before running.', 400);
        }

        try {
            $this->registerConnectionId($pdo);
            $stmt = $pdo->query($sql);

            // Iterate through result sets and return the FIRST one that has columns.
            // This supports multi-statement SQL with session variables, e.g.:
            //   SET @age = 38;
            //   SELECT @age;
            // The SET produces an empty result set (columnCount = 0), so the loop
            // skips it and fetches the SELECT on the next rowset.
            //
            // We stop at the first non-empty result set rather than continuing to
            // the last one.  Continuing caused (SELECT ...) UNION ALL (SELECT ...)
            // queries to be split by the MySQL PDO driver into two rowsets — the
            // full UNION result followed by the second SELECT alone — and the loop
            // would overwrite $rows with the partial second-SELECT result, losing
            // the first query's rows and producing incorrect output vs. HeidiSQL.
            $rows      = [];
            $cols      = [];
            $colTables = [];
            $colTypes  = [];
            do {
                $colCount = $stmt->columnCount();
                if ($colCount > 0) {
                    $cols      = [];
                    $colTables = [];
                    $colTypes  = [];
                    for ($i = 0; $i < $colCount; $i++) {
                        $meta        = $stmt->getColumnMeta($i) ?: [];
                        $cols[]      = $meta['name'] ?? "col_{$i}";
                        $colTables[] = $meta['table'] ?? '';
                        $colTypes[]  = $this->normaliseColType($meta);
                    }
                    // FETCH_NUM preserves duplicate column names (FETCH_ASSOC collapses them).
                    $rows = $stmt->fetchAll(\PDO::FETCH_NUM);
                    break; // stop at the first result set that has columns
                }
            } while ($stmt->nextRowset());

            Response::success([
                'sql'        => $sql,
                'cols'       => $cols,
                'col_tables' => $colTables,
                'col_types'  => $colTypes,
                'rows'       => $rows,
                'count'      => count($rows),
            ]);
        } catch (\PDOException $e) {
            Response::error('Query failed: ' . $e->getMessage(), 400);
        }
    }

    /**
     * Return the generated SQL string without executing it.
     * Unchained tables appear as CROSS JOIN ... -- no join defined (diagnostic).
     * Response data: { sql, warnings }
     */
    public function preview(Request $request): void
    {
        [$pdo, $sql, $warnings] = $this->buildFromRequest($request, forPreview: true);

        Response::success([
            'sql'      => $sql,
            'warnings' => $warnings,
        ]);
    }

    // =========================================================================
    // Build pipeline
    // =========================================================================

    /**
     * Parse the request, connect to the database, and build the SQL.
     *
     * @param  bool  $forPreview  if true, unchained tables produce CROSS JOIN comments
     * @return array{0:\PDO, 1:string, 2:string[]}  [pdo, sql, warnings]
     */
    private function buildFromRequest(Request $request, bool $forPreview = false): array
    {
        $profileId = (string) $request->get('profileId', '');
        if ($profileId === '') {
            Response::error('profileId is required.', 400);
        }

        $pm      = new ProfileManager();
        $profile = $pm->getProfileById($profileId);
        if ($profile === null) {
            Response::error('Profile not found.', 404);
        }

        try {
            $conn = new Connection($profile);
            $pdo  = $conn->getPdo();
        } catch (\PDOException $e) {
            Response::error('Connection failed: ' . $e->getMessage(), 503);
        }

        // Extract and coerce state fields
        $tables      = (array)  $request->get('tables',      []);
        $joins       = (array)  $request->get('joins',       []);
        $select             = (array)  $request->get('select',             []);
        $selectRaw          = (string) $request->get('selectRaw',          '');
        $selectMode         = (string) $request->get('selectMode',         'visual');
        $selectAddDelimiter = (bool)   $request->get('selectAddDelimiter', false);
        $selectSortAlpha    = (bool)   $request->get('selectSortAlpha',    false);
        $selectDistinct     = (bool)   $request->get('selectDistinct',     false);
        $selectNone             = (bool)   $request->get('selectNone',             false);
        $selectCustomExprs      = (array)  $request->get('selectCustomExprs',      []);
        $selectCustomExprsMode  = (string) $request->get('selectCustomExprsMode',  'combined');
        $selectAliases          = (array)  $request->get('selectAliases',          []);
        $columnOrder        = (array)  $request->get('columnOrder',        []);
        $where       = (array)  $request->get('where',       []);
        $whereRaw    = (string) $request->get('whereRaw',    '');
        $whereMode   = (string) $request->get('whereMode',   'visual');
        $orderBy     = (array)  $request->get('orderBy',     []);
        $orderByRaw  = (string) $request->get('orderByRaw',  '');
        $orderByMode = (string) $request->get('orderByMode', 'visual');
        $groupBy     = (array)  $request->get('groupBy',     []);
        $groupByRaw  = (string) $request->get('groupByRaw',  '');
        $groupByMode = (string) $request->get('groupByMode', 'visual');
        $having      = (array)  $request->get('having',      []);
        $havingRaw   = (string) $request->get('havingRaw',   '');
        $havingMode  = (string) $request->get('havingMode',  'visual');
        $limit       = min((int) $request->get('limit', 10), self::MAX_LIMIT);

        if (empty($tables)) {
            Response::error('No tables specified.', 400);
        }

        // Strip disabled joins — they are excluded from SQL and connectivity checks
        $joins = array_values(array_filter($joins, fn($j) => ($j['enabled'] ?? true) !== false));

        // Mirror the JS buildSQL sort: tables ordered by their user-defined join order
        // (1 = FROM anchor, 2+ = JOIN sequence).  Without this sort, $tables[0] may not
        // be the FROM table when the array order diverges from the order field (e.g. after
        // loading a context and reordering / deleting / re-adding tables).
        usort($tables, fn($a, $b) => ($a['order'] ?? 1) <=> ($b['order'] ?? 1));

        // Sort joins so tables with lower order values are introduced into the chain first,
        // matching the JS sortedJoins logic and ensuring the single-pass chain algorithm
        // in JoinClause works correctly regardless of the order joins were created.
        if (!empty($joins)) {
            $orderMap = [];
            foreach ($tables as $t) {
                $orderMap[$t['id'] ?? ''] = $t['order'] ?? 1;
            }
            usort($joins, function ($a, $b) use ($orderMap) {
                $minA = min($orderMap[$a['fromTableId'] ?? ''] ?? 99, $orderMap[$a['toTableId'] ?? ''] ?? 99);
                $minB = min($orderMap[$b['fromTableId'] ?? ''] ?? 99, $orderMap[$b['toTableId'] ?? ''] ?? 99);
                return $minA <=> $minB;
            });
        }

        // Restrict columnOrder and select to the active island's table aliases.
        // State.columnOrder / State.select on the frontend span ALL islands; $tables
        // has already been filtered to the active island by the caller.  Without this
        // restriction the delimiter / sort-alpha / alias expansion blocks below would
        // pull in column keys from other islands and inject them into the SELECT of
        // the current query, causing "Unknown column" errors.
        $activeAliases = array_flip(
            array_filter(array_map(fn($t) => strtolower((string) ($t['alias'] ?? '')), $tables))
        );
        $aliasFilter = function (string $k) use ($activeAliases): bool {
            $dot = strpos($k, '.');
            return $dot !== false && isset($activeAliases[strtolower(substr($k, 0, $dot))]);
        };
        if (!empty($columnOrder)) {
            $columnOrder = array_values(array_filter($columnOrder, fn($k) => $aliasFilter((string) $k)));
        }
        if (!empty($select)) {
            $select = array_values(array_filter($select, fn($k) => $aliasFilter((string) $k)));
        }

        // When delimiter is on, SELECT * cannot carry delimiters — expand to explicit columns.
        // Use the columnOrder sent by the frontend (respects drag-reorder); fall back to
        // deriving from the tables array in declaration order.
        // Exception: subquery (joined-island) tables only expose join-key columns in their
        // metadata — use alias.* per table so all columns appear between delimiters.
        if ($selectAddDelimiter && empty($select) && $selectMode !== 'raw') {
            $hasSubquery = !empty(array_filter($tables, fn($t) => !empty($t['isSubquery'])));
            if ($hasSubquery) {
                foreach ($tables as $t) {
                    $select[] = ($t['alias'] ?? '') . '.*';
                }
            } elseif (!empty($columnOrder)) {
                $select = array_values(array_filter(
                    $columnOrder,
                    fn($k) => preg_match('/^\w+\.\w+$/', (string) $k)
                ));
            } else {
                foreach ($tables as $t) {
                    foreach ((array) ($t['columns'] ?? []) as $col) {
                        $colName = is_array($col) ? ($col['name'] ?? '') : (string) $col;
                        if ($colName !== '') {
                            $select[] = $t['alias'] . '.' . $colName;
                        }
                    }
                }
            }
        }

        // When sort-alpha is on, SELECT * cannot be sorted — expand to explicit columns.
        if ($selectSortAlpha && empty($select) && $selectMode !== 'raw') {
            if (!empty($columnOrder)) {
                $select = array_values(array_filter(
                    $columnOrder,
                    fn($k) => preg_match('/^\w+\.\w+$/', (string) $k)
                ));
            } else {
                foreach ($tables as $t) {
                    foreach ((array) ($t['columns'] ?? []) as $col) {
                        $colName = is_array($col) ? ($col['name'] ?? '') : (string) $col;
                        if ($colName !== '') {
                            $select[] = $t['alias'] . '.' . $colName;
                        }
                    }
                }
            }
        }

        // When any column alias is defined in visual mode, we must expand SELECT *
        // to an explicit column list so that aliases are preserved in the final
        // query. This mirrors the client-side logic that switches away from '*'
        // when aliases are present.
        if (empty($select) && $selectMode !== 'raw' && !empty($selectAliases)) {
            if (!empty($columnOrder)) {
                $select = array_values(array_filter(
                    $columnOrder,
                    fn($k) => preg_match('/^\w+\.\w+$/', (string) $k)
                ));
            } else {
                foreach ($tables as $t) {
                    foreach ((array) ($t['columns'] ?? []) as $col) {
                        $colName = is_array($col) ? ($col['name'] ?? '') : (string) $col;
                        if ($colName !== '') {
                            $select[] = $t['alias'] . '.' . $colName;
                        }
                    }
                }
            }
        }

        // Validate every table has a safe name, alias, and optional database.
        // Subquery tables skip the name validation (the name is a synthetic identifier
        // like "sq1"; the actual SQL comes from the subquery field which is user-trusted
        // raw SQL, same as raw WHERE/ORDER BY).
        foreach ($tables as $t) {
            if (!empty($t['isSubquery'])) {
                // Only validate the alias for subquery tables
                if (!preg_match('/^\w+$/', (string) ($t['alias'] ?? ''))) {
                    Response::error('Invalid table alias: ' . ($t['alias'] ?? ''), 400);
                }
                continue;
            }
            if (!preg_match('/^\w+$/', (string) ($t['name']  ?? ''))) {
                Response::error('Invalid table name: '  . ($t['name']  ?? ''), 400);
            }
            if (!preg_match('/^\w+$/', (string) ($t['alias'] ?? ''))) {
                Response::error('Invalid table alias: ' . ($t['alias'] ?? ''), 400);
            }
            if (!empty($t['database']) && !preg_match('/^\w+$/', (string) $t['database'])) {
                Response::error('Invalid database name: ' . $t['database'], 400);
            }
        }

        [$sql, $warnings] = $this->assembleSql(
            $pdo, $tables, $joins, $select, $selectRaw, $selectMode, $selectAddDelimiter, $selectSortAlpha, $selectDistinct, $selectNone, $selectCustomExprs, $selectCustomExprsMode, $selectAliases,
            $where, $whereRaw, $whereMode,
            $groupBy, $groupByRaw, $groupByMode,
            $having, $havingRaw, $havingMode,
            $orderBy, $orderByRaw, $orderByMode,
            $limit, $forPreview
        );

        return [$pdo, $sql, $warnings];
    }

    /**
     * Assemble the full SELECT statement from validated state components.
     *
     * @return array{0:string, 1:string[]}  [sql, warnings]
     */
    private function assembleSql(
        \PDO   $pdo,
        array  $tables,
        array  $joins,
        array  $select,
        string $selectRaw,
        string $selectMode,
        bool   $selectAddDelimiter,
        bool   $selectSortAlpha,
        bool   $selectDistinct,
        bool   $selectNone,
        array  $selectCustomExprs,
        string $selectCustomExprsMode,
        array  $selectAliases,
        array  $where,
        string $whereRaw,
        string $whereMode,
        array  $groupBy,
        string $groupByRaw,
        string $groupByMode,
        array  $having,
        string $havingRaw,
        string $havingMode,
        array  $orderBy,
        string $orderByRaw,
        string $orderByMode,
        int    $limit,
        bool   $forPreview
    ): array {
        // --- SELECT ---
        if ($selectMode === 'raw' && trim($selectRaw) !== '') {
            $raw = trim($selectRaw);
            if ($selectSortAlpha) {
                $exprs = $this->splitSelectExprs($raw);
                usort($exprs, fn($a, $b) => strcmp($this->exprSortKey($a), $this->exprSortKey($b)));
                $raw = implode(', ', array_map('trim', $exprs));
            }
            $selectSql = $raw;
        } else {
            // In 'only' mode custom expressions replace all SELECT columns
            if ($selectCustomExprsMode === 'only') {
                $selectSql = '/* no columns selected */';
            } else {
                $selectSql = $this->buildSelect($select, $selectAddDelimiter, $selectAliases, $selectSortAlpha);
            }
        }

        // Append custom expressions (visual mode only; skipped in 'exclude' mode)
        if ($selectMode !== 'raw' && $selectCustomExprsMode !== 'exclude') {
            $customParts = [];
            foreach ($selectCustomExprs as $e) {
                if (($e['enabled'] ?? true) === false) continue;
                $expr = trim((string) ($e['expr'] ?? ''));
                if ($expr === '') continue;
                if (preg_match('/^select\s/i', $expr)) $expr = "($expr)";
                $alias = trim((string) ($e['alias'] ?? ''));
                $customParts[] = [
                    'sql' => $alias !== '' ? "$expr AS $alias" : $expr,
                    'key' => strtolower($alias !== '' ? $alias : $expr),
                ];
            }
            if ($selectSortAlpha && !empty($customParts)) {
                usort($customParts, fn($a, $b) => strcmp($a['key'], $b['key']));
            }
            if (!empty($customParts)) {
                $customSql = implode(', ', array_column($customParts, 'sql'));
                $selectSql = ($selectCustomExprsMode === 'only' || ($selectNone && $selectSql === '*'))
                    ? $customSql
                    : "$selectSql, $customSql";
            }
        }

        // --- FROM (first table is the anchor) ---
        $first   = $tables[0];
        $fromSql = $this->tableRefSql($first) . ' ' . $first['alias'];

        // --- JOINs ---
        $joinClause  = new JoinClause();
        $joinSql     = $joinClause->build($joins, $tables);
        $components  = $joinClause->getConnectedComponents($joins, $tables);

        // --- Island validation ---
        // The frontend should always send a single pre-filtered island.
        // If multiple components arrive (e.g. direct API call), block with a clear error.
        $warnings = [];
        if (count($components) > 1) {
            $islandLabels = array_map(function ($island) use ($tables) {
                $tableMap = array_column($tables, null, 'id');
                $names    = array_map(fn($id) => ($tableMap[$id]['name'] ?? $id), $island);
                return '[' . implode(', ', $names) . ']';
            }, $components);
            $msg = 'Multiple disconnected table groups found: ' . implode(' and ', $islandLabels) .
                   '. Select one group to query.';
            if (!$forPreview) {
                Response::error($msg, 400);
            }
            $warnings[] = $msg;
        }

        // --- WHERE ---
        $whereSql = (new WhereClause())->build($where, $pdo, $whereRaw, $whereMode);

        // --- GROUP BY ---
        $groupBySql = (new GroupByClause())->build($groupBy, $groupByRaw, $groupByMode);

        // --- HAVING ---
        $havingSql = (new HavingClause())->build($having, $pdo, $havingRaw, $havingMode);

        // --- ORDER BY ---
        $orderSql = (new OrderByClause())->build($orderBy, $orderByRaw, $orderByMode);

        // --- Format SELECT: one column per line for readability ---
        $selectParts = $this->splitSelectExprs($selectSql);
        $selectKw = $selectDistinct ? 'SELECT DISTINCT' : 'SELECT';
        if (count($selectParts) <= 1) {
            $selectLine = "$selectKw\n\t$selectSql";
        } else {
            $trimmed    = array_map('trim', $selectParts);
            $selectLine = "$selectKw\n\t" . implode(",\n\t", $trimmed);
        }

        // --- Assemble lines ---
        $lines   = [$selectLine, "FROM\n\t$fromSql"];
        if ($joinSql !== '') {
            $lines[] = $joinSql;
        }
        if ($whereSql !== '') {
            $lines[] = $whereSql;
        }
        if ($groupBySql !== '') {
            $lines[] = $groupBySql;
        }
        if ($havingSql !== '') {
            $lines[] = $havingSql;
        }
        if ($orderSql !== '') {
            $lines[] = $orderSql;
        }
        $lines[] = "LIMIT $limit";

        return [implode("\n", $lines), $warnings];
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    /**
     * Build the SELECT column list.
     * Empty array → SELECT *.
     * Each item must be "alias.colname"; alias used as-is, colname is backtick-quoted.
     * When $addDelimiter is true, '|||' is injected between consecutive groups of
     * columns that belong to different table aliases.
     * $selectAliases is a map of "alias.colname" → column alias (AS name); only \w+ allowed.
     */
    private function buildSelect(array $select, bool $addDelimiter = false, array $selectAliases = [], bool $sortAlpha = false): string
    {
        if (empty($select)) {
            return '*';
        }

        $cols = [];
        foreach ($select as $item) {
            $item = (string) $item;
            if (preg_match('/^(\w+)\.\*$/', $item, $m)) {
                // alias.* — used for subquery tables where full column list is unavailable
                $cols[] = [
                    'alias'   => $m[1],
                    'colname' => '*',
                    'sortkey' => $m[1],
                    'expr'    => $m[1] . '.*',
                ];
                continue;
            }
            if (!preg_match('/^(\w+)\.(\w+)$/', $item, $m)) {
                continue; // silently skip malformed items
            }
            $expr = $m[1] . '.`' . $this->esc($m[2]) . '`';
            $colAlias = isset($selectAliases[$item]) ? trim((string) $selectAliases[$item]) : '';
            if ($colAlias !== '' && preg_match('/^\w+$/', $colAlias)) {
                $expr .= ' AS `' . $this->esc($colAlias) . '`';
            }
            $colAliasSortKey = ($colAlias !== '' && preg_match('/^\w+$/', $colAlias)) ? $colAlias : '';
            $cols[] = [
                'alias'    => $m[1],
                'colname'  => $m[2],
                'sortkey'  => $colAliasSortKey !== '' ? $colAliasSortKey : $m[2],
                'expr'     => $expr,
            ];
        }

        if (empty($cols)) {
            return '*';
        }

        // Sort alphabetically by column alias (if set) or column name, leaving UI order intact
        if ($sortAlpha) {
            usort($cols, fn($a, $b) => strcasecmp($a['sortkey'], $b['sortkey']));
        }

        if (!$addDelimiter) {
            return implode(', ', array_column($cols, 'expr'));
        }

        // When both sort-alpha and delimiter are active, columns are already sorted
        // by sortkey — insert '|||' between groups whose sortkey changes so that
        // same-named columns from different tables appear together between delimiters.
        if ($sortAlpha) {
            $parts       = [];
            $prevSortkey = null;
            foreach ($cols as $c) {
                $sk = strtolower($c['sortkey']);
                if ($prevSortkey !== null && $sk !== $prevSortkey) {
                    $parts[] = "'|||'";
                }
                $parts[]     = $c['expr'];
                $prevSortkey = $sk;
            }
            return implode(', ', $parts);
        }

        // Delimiter only: inject '|||' between consecutive runs from different table aliases
        $parts     = [];
        $prevAlias = null;
        foreach ($cols as $c) {
            if ($prevAlias !== null && $c['alias'] !== $prevAlias) {
                $parts[] = "'|||'";
            }
            $parts[]   = $c['expr'];
            $prevAlias = $c['alias'];
        }

        return implode(', ', $parts);
    }

    /**
     * Build a fully-qualified (or plain) table reference.
     * With database:  `schema`.`table`
     * Without:        `table`
     * Subquery table: (SELECT …)
     */
    private function tableRefSql(array $table): string
    {
        if (!empty($table['isSubquery'])) {
            return '(' . trim((string) ($table['subquery'] ?? '')) . ')';
        }
        $name = '`' . $this->esc($table['name']) . '`';
        if (!empty($table['database'])) {
            return '`' . $this->esc($table['database']) . '`.' . $name;
        }
        return $name;
    }

    /**
     * Split a raw SELECT expression list by top-level commas,
     * skipping commas inside parentheses (e.g. CONCAT(a, b)).
     */
    private function splitSelectExprs(string $raw): array
    {
        $parts = [];
        $depth = 0;
        $cur   = '';
        $len   = strlen($raw);
        for ($i = 0; $i < $len; $i++) {
            $ch = $raw[$i];
            if ($ch === '(' || $ch === '[') { $depth++; $cur .= $ch; }
            elseif ($ch === ')' || $ch === ']') { $depth--; $cur .= $ch; }
            elseif ($ch === ',' && $depth === 0) { $parts[] = $cur; $cur = ''; }
            else $cur .= $ch;
        }
        if (trim($cur) !== '') $parts[] = $cur;
        return $parts;
    }

    /**
     * Extract a sort key from a single SQL SELECT expression.
     * Priority: AS alias → dotted column name → first bare word.
     */
    private function exprSortKey(string $expr): string
    {
        $t = trim($expr);
        if (preg_match('/\bAS\s+`?(\w+)`?\s*$/i', $t, $m)) {
            return strtolower($m[1]);
        }
        if (preg_match('/\w+\.`?(\w+)`?/', $t, $m)) {
            return strtolower($m[1]);
        }
        $clean = str_replace('`', '', $t);
        if (preg_match('/^\s*(\w+)/', $clean, $m)) {
            return strtolower($m[1]);
        }
        return strtolower($t);
    }

    /**
     * Return true if the SQL string contains a MySQL user-defined variable
     * (@identifier).  Matches @name anywhere in the string, including inside
     * SET @var = … and SELECT @var patterns.
     * Strings inside single/double quotes are NOT excluded — a conservative
     * approach that errs on the side of safety.
     */
    private function containsVariables(string $sql): bool
    {
        return (bool) preg_match('/@[a-zA-Z_][a-zA-Z0-9_]*/', $sql);
    }

    /** Escape backticks inside a MySQL identifier (double them). */
    private function esc(string $name): string
    {
        return str_replace('`', '``', $name);
    }

    /**
     * Normalise the raw PDO column metadata into one of four stable tokens
     * that the frontend can rely on regardless of MySQL version or connection
     * type (local socket vs TCP remote):
     *
     *   'INT'      — any integer type
     *   'DATE'     — DATE column
     *   'DATETIME' — DATETIME or TIMESTAMP column
     *   ''         — everything else (string, float, blob, …)
     *
     * PDO::PARAM_INT (=1) is used as a reliable fallback when native_type is
     * absent or non-standard, which commonly happens on remote connections.
     */

    /**
     * Store the current MySQL connection ID in the session so cancel_query.php
     * can issue a KILL QUERY on a separate connection, then immediately release
     * the session lock so the cancel request is not blocked while the query runs.
     */
    private function registerConnectionId(\PDO $pdo): void
    {
        $connId = (int) $pdo->query('SELECT CONNECTION_ID()')->fetchColumn();
        $_SESSION['active_query_conn_id'] = $connId;
        session_write_close(); // release lock before blocking query
    }

    private function normaliseColType(array $meta): string
    {
        $native  = strtoupper(trim((string) ($meta['native_type'] ?? '')));
        $pdoType = (int) ($meta['pdo_type'] ?? 0);

        // Integer types — native_type varies wildly across drivers/versions
        $intNatives = ['TINY', 'SHORT', 'LONG', 'LONGLONG', 'INT24',
                       'TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT',
                       'INTEGER', 'BIGINT'];
        if (in_array($native, $intNatives, true) || $pdoType === \PDO::PARAM_INT) {
            return 'INT';
        }

        if (in_array($native, ['DATE', 'NEWDATE'], true)) {
            return 'DATE';
        }

        if (in_array($native, ['DATETIME', 'TIMESTAMP'], true)) {
            return 'DATETIME';
        }

        return '';
    }
}
