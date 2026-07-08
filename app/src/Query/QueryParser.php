<?php

declare(strict_types=1);

namespace Query;

use Core\Request;
use Core\Response;
use Database\Connection;
use Database\ProfileManager;

/**
 * QueryParser — validates and parses an external SELECT query into the
 * structured state shape that the canvas/config panels understand.
 *
 * Route: query.parseFromSQL
 *
 * Request body: { profileId: string, sql: string }
 *
 * Response data on success:
 * {
 *   tables  : [{id, name, alias, database, columns, order, position}],
 *   joins   : [{id, fromTableId, fromCol, toTableId, toCol, type}],
 *   select  : string[],          // alias.col items for visual mode (empty = use selectRaw)
 *   selectRaw : string,
 *   where   : string,            // always raw
 *   groupBy : string[],          // alias.col items for visual mode (empty = use groupByRaw)
 *   groupByRaw : string,
 *   having  : string,            // always raw
 *   orderBy : [{col, dir}][],    // visual (empty = use orderByRaw)
 *   orderByRaw : string,
 *   limit   : int,
 * }
 */
class QueryParser
{
    // =========================================================================
    // Public route handler
    // =========================================================================

    public function parse(Request $request): void
    {
        $profileId = (string) $request->get('profileId', '');
        if ($profileId === '') {
            Response::error('profileId is required.', 400);
        }

        $sql = trim((string) $request->get('sql', ''));
        if ($sql === '') {
            Response::error('sql is required.', 400);
        }

        // --- Connect ---
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

        // --- EXPLAIN validation ---
        // Strip any leading EXPLAIN prefix the user may have included
        $cleanSql = preg_replace('/^\s*EXPLAIN\s+/i', '', $sql);
        try {
            $pdo->query('EXPLAIN ' . $cleanSql);
        } catch (\PDOException $e) {
            Response::error('Query validation failed: ' . $e->getMessage(), 400);
        }

        // --- Parse ---
        $parsed = $this->parseSql($cleanSql);

        // --- Enrich tables with real columns from INFORMATION_SCHEMA ---
        foreach ($parsed['tables'] as &$table) {
            if (!empty($table['isSubquery'])) {
                continue; // virtual tables keep empty columns
            }
            try {
                $db   = (string) ($table['database'] ?? '');
                $stmt = $pdo->prepare(
                    'SELECT COLUMN_NAME    AS `name`,
                            COLUMN_TYPE    AS `type`,
                            DATA_TYPE      AS `shortType`,
                            IS_NULLABLE    AS `nullable`,
                            COLUMN_KEY     AS `key`,
                            COLUMN_DEFAULT AS `default`,
                            EXTRA          AS `extra`
                       FROM INFORMATION_SCHEMA.COLUMNS
                      WHERE TABLE_NAME   = ?
                        AND TABLE_SCHEMA = IFNULL(NULLIF(?, \'\'), DATABASE())
                      ORDER BY ORDINAL_POSITION'
                );
                $stmt->execute([$table['name'], $db]);
                $rows = $stmt->fetchAll(\PDO::FETCH_ASSOC);
                if (!empty($rows)) {
                    $table['columns'] = array_map(fn(array $c) => [
                        'name'      => $c['name'],
                        'type'      => $c['type'],
                        'shortType' => strtolower($c['shortType']),
                        'nullable'  => $c['nullable'] === 'YES',
                        'key'       => $c['key'],       // PRI | UNI | MUL | ""
                        'default'   => $c['default'],
                        'extra'     => strtolower((string) $c['extra']),
                    ], $rows);
                }
                // else: leave as empty array — table may not exist in current db context
            } catch (\PDOException $e) {
                // Non-fatal — keep empty columns; the canvas will still render the card
            }
        }
        unset($table);

        Response::success($parsed);
    }

    // =========================================================================
    // SQL parsing
    // =========================================================================

    private function parseSql(string $sql): array
    {
        $sql = $this->stripComments($sql);

        $sections = $this->splitSections($sql);

        // SELECT
        [$select, $selectRaw, $selectAliases, $selectCustomExprs] = !empty($sections['select'])
            ? $this->parseSelect($sections['select'])
            : [[], '', [], []];

        // FROM + JOINs
        [$tables, $joins] = !empty($sections['from'])
            ? $this->parseFrom($sections['from'])
            : [[], []];

        // WHERE — raw text + parsed visual conditions
        $where            = trim($sections['where'] ?? '');
        $whereConditions  = $this->parseWhereConditions($where);

        // GROUP BY
        [$groupBy, $groupByRaw] = !empty($sections['groupby'])
            ? $this->parseGroupBy($sections['groupby'])
            : [[], ''];

        // HAVING — raw text + parsed visual conditions (null = fall back to raw mode)
        $having           = trim($sections['having'] ?? '');
        $havingConditions = $this->parseHavingConditions($having);

        // ORDER BY
        [$orderBy, $orderByRaw] = !empty($sections['orderby'])
            ? $this->parseOrderBy($sections['orderby'])
            : [[], ''];

        // LIMIT
        $limit = 10;
        if (!empty($sections['limit'])) {
            $lv = (int) preg_replace('/[^0-9]/', '', $sections['limit']);
            if ($lv > 0) {
                $limit = min($lv, 5000);
            }
        }

        return [
            'tables'            => $tables,
            'joins'             => $joins,
            'select'            => $select,
            'selectRaw'         => $selectRaw,
            'selectAliases'     => $selectAliases,
            'selectCustomExprs' => $selectCustomExprs,
            'where'             => $where,
            'whereConditions'  => $whereConditions,
            'groupBy'          => $groupBy,
            'groupByRaw'       => $groupByRaw,
            'having'           => $having,
            'havingConditions' => $havingConditions,  // null = use raw mode
            'orderBy'          => $orderBy,
            'orderByRaw'       => $orderByRaw,
            'limit'            => $limit,
        ];
    }

    // -------------------------------------------------------------------------
    // Strip SQL comments
    // -------------------------------------------------------------------------

    private function stripComments(string $sql): string
    {
        // Multi-line comments /* ... */
        $sql = preg_replace('/\/\*.*?\*\//s', ' ', $sql);
        // Single-line comments -- ...
        $sql = preg_replace('/--[^\n]*/', ' ', $sql);
        return trim($sql);
    }

    // -------------------------------------------------------------------------
    // Split the SQL into top-level clause sections
    // -------------------------------------------------------------------------

    /**
     * Returns an array keyed by section name ('select', 'from', 'where', etc.)
     * where each value is the raw text of that clause (WITHOUT the keyword itself).
     */
    private function splitSections(string $sql): array
    {
        $sectionMap = [
            'SELECT'   => 'select',
            'FROM'     => 'from',
            'WHERE'    => 'where',
            'GROUP BY' => 'groupby',
            'HAVING'   => 'having',
            'ORDER BY' => 'orderby',
            'LIMIT'    => 'limit',
        ];

        // Find every top-level keyword occurrence: [[keyword, startPos, endPos], ...]
        $positions = $this->findTopLevelKeywords($sql, array_keys($sectionMap));

        // Sort by position
        usort($positions, fn($a, $b) => $a[1] <=> $b[1]);

        $sections = [];
        $sqlLen   = strlen($sql);

        for ($i = 0; $i < count($positions); $i++) {
            [$kw, , $kwEnd] = $positions[$i];
            $nextStart = isset($positions[$i + 1]) ? $positions[$i + 1][1] : $sqlLen;
            $key = $sectionMap[$kw];
            $sections[$key] = trim(substr($sql, $kwEnd, $nextStart - $kwEnd));
        }

        return $sections;
    }

    /**
     * Scan the SQL string character by character, tracking string literals and
     * parenthesis depth, and return positions of top-level keyword occurrences.
     *
     * @param  string   $sql
     * @param  string[] $keywords  uppercase, may contain spaces (e.g. "GROUP BY")
     * @return array               [[keyword, startPos, endPosAfterKeyword], ...]
     */
    private function findTopLevelKeywords(string $sql, array $keywords): array
    {
        $found    = [];
        $len      = strlen($sql);
        $upper    = strtoupper($sql);
        $depth    = 0;
        $inString = false;
        $strChar  = '';
        $i        = 0;

        while ($i < $len) {
            // String literal entry
            if (!$inString && ($sql[$i] === "'" || $sql[$i] === '"')) {
                $inString = true;
                $strChar  = $sql[$i];
                $i++;
                continue;
            }

            // String literal: look for closing quote (handle doubled-quote escapes)
            if ($inString) {
                if ($sql[$i] === $strChar) {
                    if (($i + 1) < $len && $sql[$i + 1] === $strChar) {
                        $i += 2; // doubled quote — skip both
                        continue;
                    }
                    $inString = false;
                }
                $i++;
                continue;
            }

            // Backtick identifier — skip entirely (cannot contain keywords)
            if ($sql[$i] === '`') {
                $j = $i + 1;
                while ($j < $len && $sql[$j] !== '`') {
                    $j++;
                }
                $i = $j + 1;
                continue;
            }

            // Parenthesis depth tracking
            if ($sql[$i] === '(') { $depth++; $i++; continue; }
            if ($sql[$i] === ')') { $depth--; $i++; continue; }

            // Only match keywords at depth 0
            if ($depth === 0) {
                foreach ($keywords as $kw) {
                    $kwLen = strlen($kw);
                    if (substr($upper, $i, $kwLen) !== $kw) {
                        continue;
                    }
                    // Word boundary AFTER keyword
                    $afterKw = $i + $kwLen;
                    $charAfter = $afterKw < $len ? $upper[$afterKw] : ' ';
                    if (ctype_alnum($charAfter) || $charAfter === '_') {
                        continue;
                    }
                    // Word boundary BEFORE keyword
                    $charBefore = $i > 0 ? $upper[$i - 1] : ' ';
                    if (ctype_alnum($charBefore) || $charBefore === '_') {
                        continue;
                    }
                    $found[] = [$kw, $i, $afterKw];
                    $i = $afterKw;
                    continue 2;
                }
            }

            $i++;
        }

        return $found;
    }

    // -------------------------------------------------------------------------
    // SELECT parsing
    // -------------------------------------------------------------------------

    /**
     * Returns [$visualCols, $rawText, $selectAliases, $selectCustomExprs].
     *
     * Each SELECT item is classified:
     *   alias.col [AS col_alias]  → added to $visualCols (checkbox in SELECT panel)
     *                               col_alias recorded in $selectAliases map
     *   anything else             → added to $selectCustomExprs (Custom Expression row)
     *
     * SELECT * is ignored (leaves $visualCols empty = SELECT *).
     */
    private function parseSelect(string $text): array
    {
        $rawText       = trim($text);
        $parts         = $this->splitByTopLevelComma($text);
        $cols          = [];
        $selectAliases = [];
        $customExprs   = [];

        foreach ($parts as $part) {
            $part = trim($part);
            if ($part === '') {
                continue;
            }

            // SELECT * — skip, visual mode will default to SELECT *
            $cleanForStar = strtoupper(trim(str_replace('`', '', $part)));
            if ($cleanForStar === '*') {
                continue;
            }

            // Strip backticks for pattern matching only
            $clean = str_replace('`', '', $part);

            // Simple: alias.col [AS col_alias]
            if (preg_match('/^(\w+)\.(\w+)(?:\s+AS\s+(\w+))?$/i', $clean, $m)) {
                $key = strtolower($m[1]) . '.' . $m[2];
                $cols[] = $key;
                if (!empty($m[3])) {
                    $selectAliases[$key] = $m[3];
                }
                continue;
            }

            // Everything else: subquery, literal, function call, arithmetic, cast, …
            [$expr, $alias] = $this->extractExprAndAlias($part);
            $customExprs[] = [
                'id'      => 'cx_' . bin2hex(random_bytes(4)),
                'expr'    => $expr,
                'alias'   => $alias,
                'label'   => $alias,
                'enabled' => true,
            ];
        }

        return [$cols, $rawText, $selectAliases, $customExprs];
    }

    /**
     * Split a SELECT item into [expression, alias].
     * Looks for a trailing AS identifier at depth 0 (ignoring AS inside subqueries
     * or string literals). Strips backticks from the alias.
     *
     * Examples:
     *   "COUNT(*) AS total"                  → ["COUNT(*)", "total"]
     *   "(SELECT 1 FROM t) AS sub"           → ["(SELECT 1 FROM t)", "sub"]
     *   "(1=1) AS flag"                      → ["(1=1)", "flag"]
     *   "'hello' AS greeting"                → ["'hello'", "greeting"]
     *   "u.name || ' ' || u.surname"         → ["u.name || ' ' || u.surname", ""]
     */
    private function extractExprAndAlias(string $text): array
    {
        $text  = trim($text);
        $upper = strtoupper($text);
        $len   = strlen($text);

        $depth    = 0;
        $inString = false;
        $strChar  = '';
        $lastAs   = -1;
        $lastAsEnd = -1;

        for ($i = 0; $i < $len; $i++) {
            if (!$inString && ($text[$i] === "'" || $text[$i] === '"')) {
                $inString = true; $strChar = $text[$i]; continue;
            }
            if ($inString) {
                if ($text[$i] === $strChar) {
                    if (($i + 1) < $len && $text[$i + 1] === $strChar) { $i++; continue; }
                    $inString = false;
                }
                continue;
            }
            if ($text[$i] === '(') { $depth++; continue; }
            if ($text[$i] === ')') { $depth--; continue; }

            if ($depth === 0 && substr($upper, $i, 2) === 'AS') {
                $after      = $i + 2;
                $charBefore = $i > 0 ? $upper[$i - 1] : ' ';
                $charAfter  = $after < $len ? $upper[$after] : ' ';
                if ((!ctype_alnum($charBefore) && $charBefore !== '_')
                    && (!ctype_alnum($charAfter) && $charAfter !== '_')) {
                    $lastAs    = $i;
                    $lastAsEnd = $after;
                }
            }
        }

        if ($lastAs !== -1) {
            $expr  = trim(substr($text, 0, $lastAs));
            $alias = trim(str_replace('`', '', substr($text, $lastAsEnd)));
            if (preg_match('/^\w+$/', $alias)) {
                return [$expr, $alias];
            }
        }

        return [$text, ''];
    }

    // -------------------------------------------------------------------------
    // FROM / JOIN parsing
    // -------------------------------------------------------------------------

    /**
     * Returns [$tables, $joins].
     */
    private function parseFrom(string $fromText): array
    {
        $tables = [];
        $joins  = [];

        $parts = $this->splitByJoin($fromText);

        if (empty($parts)) {
            return [[], []];
        }

        // First segment = FROM anchor table
        $fromTable = $this->parseTableRef(trim($parts[0]['text']));
        if ($fromTable !== null) {
            $fromTable['order'] = 1;
            $tables[] = $fromTable;
        }

        // Remaining segments = JOINs
        for ($i = 1; $i < count($parts); $i++) {
            $part      = $parts[$i];
            $joinType  = $this->normaliseJoinType($part['joinType'] ?? 'JOIN');
            $joinText  = trim($part['text']);

            // Split on ON keyword at depth 0
            [$tableRef, $onClause] = $this->splitOnKeyword($joinText);

            $joinTable = $this->parseTableRef(trim($tableRef));
            if ($joinTable === null) {
                continue;
            }

            $joinTable['order'] = count($tables) + 1;
            $tables[] = $joinTable;

            if (trim($onClause) !== '') {
                $joinDef = $this->parseOnClause(trim($onClause), $joinType, $tables);
                if ($joinDef !== null) {
                    $joins[] = $joinDef;
                }
            }
        }

        // --- Populate virtual columns for subquery tables from join references ---
        // Canvas join lines are anchored to column <li> elements.  A subquery table
        // starts with columns:[] so the DOM query in _computeEndpoints() would return
        // null and no line would be drawn.  Add every column referenced in an ON clause
        // to the relevant subquery table so the card renders the column item.
        foreach ($joins as $joinDef) {
            foreach ($tables as &$table) {
                if (empty($table['isSubquery'])) {
                    continue;
                }
                if ($table['id'] === $joinDef['fromTableId']) {
                    foreach (array_merge([['fromCol' => $joinDef['fromCol']]], array_map(fn($ec) => ['fromCol' => $ec['fromCol']], $joinDef['extraConditions'] ?? [])) as $pair) {
                        $col = $pair['fromCol'];
                        if ($col !== '' && !$this->hasColumn($table['columns'], $col)) {
                            $table['columns'][] = ['name' => $col];
                        }
                    }
                }
                if ($table['id'] === $joinDef['toTableId']) {
                    foreach (array_merge([['toCol' => $joinDef['toCol']]], array_map(fn($ec) => ['toCol' => $ec['toCol']], $joinDef['extraConditions'] ?? [])) as $pair) {
                        $col = $pair['toCol'];
                        if ($col !== '' && !$this->hasColumn($table['columns'], $col)) {
                            $table['columns'][] = ['name' => $col];
                        }
                    }
                }
            }
            unset($table);
        }

        return [$tables, $joins];
    }

    /**
     * Return true when $columns already contains a column named $name.
     * Handles both object form ['name'=>…] and plain string entries.
     */
    private function hasColumn(array $columns, string $name): bool
    {
        foreach ($columns as $col) {
            $n = is_array($col) ? ($col['name'] ?? '') : (string) $col;
            if ($n === $name) {
                return true;
            }
        }
        return false;
    }

    /**
     * Split the FROM text into segments at top-level JOIN keywords.
     * Returns [{text: string, joinType: string|null}, ...]
     */
    private function splitByJoin(string $text): array
    {
        // Order matters: longer patterns first to avoid partial matches
        $joinKeywords = [
            'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN',
            'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN', 'FULL JOIN', 'JOIN',
        ];

        $parts    = [];
        $len      = strlen($text);
        $upper    = strtoupper($text);
        $depth    = 0;
        $inString = false;
        $strChar  = '';
        $start    = 0;
        $curJoin  = null;
        $i        = 0;

        while ($i < $len) {
            if (!$inString && ($text[$i] === "'" || $text[$i] === '"')) {
                $inString = true; $strChar = $text[$i]; $i++; continue;
            }
            if ($inString) {
                if ($text[$i] === $strChar) {
                    if (($i + 1) < $len && $text[$i + 1] === $strChar) { $i += 2; continue; }
                    $inString = false;
                }
                $i++; continue;
            }
            if ($text[$i] === '(') { $depth++; $i++; continue; }
            if ($text[$i] === ')') { $depth--; $i++; continue; }

            if ($depth === 0) {
                foreach ($joinKeywords as $jk) {
                    $jkLen = strlen($jk);
                    if (substr($upper, $i, $jkLen) !== $jk) {
                        continue;
                    }
                    $after     = $i + $jkLen;
                    $charAfter = $after < $len ? $upper[$after] : ' ';
                    // Ensure it is a word boundary after the keyword
                    if (ctype_alnum($charAfter) || $charAfter === '_') {
                        continue;
                    }
                    // Ensure word boundary before (can't be mid-word)
                    $charBefore = $i > 0 ? $upper[$i - 1] : ' ';
                    if (ctype_alnum($charBefore) || $charBefore === '_') {
                        continue;
                    }
                    // Save the current segment
                    $parts[] = ['text' => substr($text, $start, $i - $start), 'joinType' => $curJoin];
                    $curJoin  = $jk;
                    $i        = $after;
                    $start    = $i;
                    continue 2;
                }
            }

            $i++;
        }

        // Final segment
        if ($start < $len) {
            $parts[] = ['text' => substr($text, $start), 'joinType' => $curJoin];
        }

        return $parts;
    }

    /**
     * Split "table [alias] ON condition" at the first top-level ON keyword.
     * Returns [tableRefPart, onClausePart].
     */
    private function splitOnKeyword(string $text): array
    {
        $len      = strlen($text);
        $upper    = strtoupper($text);
        $depth    = 0;
        $inString = false;
        $strChar  = '';
        $i        = 0;

        while ($i < $len) {
            if (!$inString && ($text[$i] === "'" || $text[$i] === '"')) {
                $inString = true; $strChar = $text[$i]; $i++; continue;
            }
            if ($inString) {
                if ($text[$i] === $strChar) {
                    if (($i + 1) < $len && $text[$i + 1] === $strChar) { $i += 2; continue; }
                    $inString = false;
                }
                $i++; continue;
            }
            if ($text[$i] === '(') { $depth++; $i++; continue; }
            if ($text[$i] === ')') { $depth--; $i++; continue; }

            if ($depth === 0 && substr($upper, $i, 2) === 'ON') {
                $after  = $i + 2;
                $before = $i > 0 ? $upper[$i - 1] : ' ';
                $cAfter = $after < $len ? $upper[$after] : ' ';
                if ((!ctype_alnum($before) && $before !== '_')
                    && (!ctype_alnum($cAfter) && $cAfter !== '_')) {
                    return [substr($text, 0, $i), substr($text, $after)];
                }
            }

            $i++;
        }

        return [$text, ''];
    }

    /**
     * Parse a table reference: [schema.]table [[AS] alias]
     * Also handles subquery table refs: (SELECT ...) [AS] alias
     * Returns an array ready for State.tables, or null on failure.
     */
    private function parseTableRef(string $text): ?array
    {
        $text = trim($text);
        if ($text === '') {
            return null;
        }

        // Subquery table ref: (SELECT ...) [AS] alias
        if ($text[0] === '(') {
            return $this->parseSubqueryTableRef($text);
        }

        // Strip backticks for normal table matching
        $text = str_replace('`', '', $text);

        // schema.table [AS alias] or schema.table [alias]
        if (preg_match('/^(\w+)\.(\w+)(?:\s+(?:AS\s+)?(\w+))?$/i', $text, $m)) {
            return [
                'id'       => 't_' . bin2hex(random_bytes(5)),
                'name'     => $m[2],
                'alias'    => !empty($m[3]) ? $m[3] : $m[2],
                'database' => $m[1],
                'columns'  => [],
                'position' => null,
            ];
        }

        // table [AS alias] or table [alias]
        if (preg_match('/^(\w+)(?:\s+(?:AS\s+)?(\w+))?$/i', $text, $m)) {
            return [
                'id'       => 't_' . bin2hex(random_bytes(5)),
                'name'     => $m[1],
                'alias'    => !empty($m[2]) ? $m[2] : $m[1],
                'database' => null,
                'columns'  => [],
                'position' => null,
            ];
        }

        return null;
    }

    /**
     * Parse a subquery table reference of the form:
     *   (SELECT …) [AS] alias
     *
     * Finds the matching closing parenthesis at depth 0, extracts the inner SQL,
     * then reads the alias from whatever follows.  Returns null when no valid
     * alias is found (a subquery without an alias cannot be placed on the canvas).
     */
    private function parseSubqueryTableRef(string $text): ?array
    {
        $len      = strlen($text);
        $depth    = 0;
        $closePos = -1;
        $inString = false;
        $strChar  = '';

        for ($i = 0; $i < $len; $i++) {
            if (!$inString && ($text[$i] === "'" || $text[$i] === '"')) {
                $inString = true; $strChar = $text[$i]; continue;
            }
            if ($inString) {
                if ($text[$i] === $strChar) {
                    if (($i + 1) < $len && $text[$i + 1] === $strChar) { $i++; continue; }
                    $inString = false;
                }
                continue;
            }
            if ($text[$i] === '(') { $depth++; continue; }
            if ($text[$i] === ')') {
                $depth--;
                if ($depth === 0) { $closePos = $i; break; }
            }
        }

        if ($closePos < 0) {
            return null; // unbalanced parentheses
        }

        $subquerySql = trim(substr($text, 1, $closePos - 1));
        $after       = trim(substr($text, $closePos + 1));

        // Alias is required; optional AS keyword allowed
        if (!preg_match('/^(?:AS\s+)?(\w+)$/i', $after, $m)) {
            return null;
        }

        $alias = $m[1];

        return [
            'id'         => 'sq_' . bin2hex(random_bytes(5)),
            'name'       => $alias,   // synthetic name = alias (used as canvas label)
            'alias'      => $alias,
            'database'   => null,
            'columns'    => [],
            'position'   => null,
            'isSubquery' => true,
            'subquery'   => $subquerySql,
        ];
    }

    /**
     * Parse a JOIN ON clause.  Handles one or more equality conditions joined by AND:
     *   alias1.col1 = alias2.col2 [AND alias1.col3 = alias2.col4 ...]
     * Backtick-quoted identifiers (e.g. `col_name`) are stripped before matching.
     * Returns a join array or null if no valid condition is found.
     */
    private function parseOnClause(string $onText, string $joinType, array $tables): ?array
    {
        $clean = str_replace('`', '', $onText);
        preg_match_all('/(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/i', $clean, $allMatches, PREG_SET_ORDER);

        if (empty($allMatches)) {
            return null;
        }

        // Build alias → table lookup
        $tablesByAlias = [];
        foreach ($tables as $t) {
            $tablesByAlias[strtolower($t['alias'])] = $t;
        }

        // Primary condition = first match
        $primary = $allMatches[0];
        $alias1  = strtolower($primary[1]); $col1 = $primary[2];
        $alias2  = strtolower($primary[3]); $col2 = $primary[4];

        $fromTable = $tablesByAlias[$alias1] ?? null;
        $toTable   = $tablesByAlias[$alias2] ?? null;

        if ($fromTable === null || $toTable === null) {
            return null;
        }

        $join = [
            'id'              => 'j_' . bin2hex(random_bytes(5)),
            'fromTableId'     => $fromTable['id'],
            'fromCol'         => $col1,
            'toTableId'       => $toTable['id'],
            'toCol'           => $col2,
            'type'            => $joinType,
            'extraConditions' => [],
        ];

        // Map remaining AND-connected pairs to extraConditions, oriented to fromTable
        $fromAlias = strtolower($fromTable['alias']);
        for ($i = 1; $i < count($allMatches); $i++) {
            $m      = $allMatches[$i];
            $mA1    = strtolower($m[1]); $mC1 = $m[2];
            $mA2    = strtolower($m[3]); $mC2 = $m[4];
            if ($mA1 === $fromAlias) {
                $join['extraConditions'][] = ['fromCol' => $mC1, 'toCol' => $mC2];
            } else {
                $join['extraConditions'][] = ['fromCol' => $mC2, 'toCol' => $mC1];
            }
        }

        return $join;
    }

    // -------------------------------------------------------------------------
    // GROUP BY / ORDER BY parsing
    // -------------------------------------------------------------------------

    /**
     * Returns [$visualCols, $rawText].
     */
    private function parseGroupBy(string $text): array
    {
        $parts      = $this->splitByTopLevelComma($text);
        $cols       = [];
        $hasComplex = false;

        foreach ($parts as $part) {
            $part  = str_replace('`', '', trim($part));
            if (preg_match('/^(\w+)\.(\w+)$/i', $part, $m)) {
                $cols[] = strtolower($m[1]) . '.' . $m[2];
            } else {
                $hasComplex = true;
            }
        }

        if ($hasComplex || empty($cols)) {
            return [[], trim($text)];
        }

        return [$cols, ''];
    }

    /**
     * Returns [$visualCols, $rawText] where $visualCols is [{col, dir}, ...].
     */
    private function parseOrderBy(string $text): array
    {
        $parts      = $this->splitByTopLevelComma($text);
        $cols       = [];
        $hasComplex = false;

        foreach ($parts as $part) {
            $part = str_replace('`', '', trim($part));
            if (preg_match('/^(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i', $part, $m)) {
                $cols[] = [
                    'col' => strtolower($m[1]) . '.' . $m[2],
                    'dir' => !empty($m[3]) ? strtoupper($m[3]) : 'ASC',
                ];
            } else {
                $hasComplex = true;
            }
        }

        if ($hasComplex || empty($cols)) {
            return [[], trim($text)];
        }

        return [$cols, ''];
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /**
     * Split a string by top-level (depth-0) commas, respecting string literals
     * and nested parentheses.
     */
    private function splitByTopLevelComma(string $text): array
    {
        $parts    = [];
        $depth    = 0;
        $inString = false;
        $strChar  = '';
        $len      = strlen($text);
        $cur      = '';

        for ($i = 0; $i < $len; $i++) {
            if (!$inString && ($text[$i] === "'" || $text[$i] === '"')) {
                $inString = true; $strChar = $text[$i]; $cur .= $text[$i]; continue;
            }
            if ($inString) {
                $cur .= $text[$i];
                if ($text[$i] === $strChar) {
                    if (($i + 1) < $len && $text[$i + 1] === $strChar) { $cur .= $text[++$i]; continue; }
                    $inString = false;
                }
                continue;
            }
            if ($text[$i] === '(') { $depth++; $cur .= $text[$i]; continue; }
            if ($text[$i] === ')') { $depth--; $cur .= $text[$i]; continue; }
            if ($text[$i] === ',' && $depth === 0) { $parts[] = $cur; $cur = ''; continue; }
            $cur .= $text[$i];
        }

        if (trim($cur) !== '') {
            $parts[] = $cur;
        }

        return $parts;
    }

    // -------------------------------------------------------------------------
    // WHERE / HAVING condition parsing
    // -------------------------------------------------------------------------

    /**
     * Parse a WHERE clause into an array of visual condition objects.
     * Simple conditions   → {col, op, val, operator, enabled}
     * Complex expressions → {type:'raw', expr:..., operator:..., enabled:true}
     * The 'raw' type is rendered as a free-form row in the WHERE visual panel.
     */
    private function parseWhereConditions(string $text): array
    {
        $text = trim($text);
        if ($text === '') {
            return [];
        }

        $parts      = $this->splitByAndOr($text);
        $conditions = [];

        foreach ($parts as [$connector, $expr]) {
            $expr = trim($expr);
            if ($expr === '') {
                continue;
            }

            $cond              = $this->parseConditionExpr($expr);
            $cond['operator']  = $connector ?? 'AND';
            $cond['enabled']   = true;
            $conditions[]      = $cond;
        }

        return $conditions;
    }

    /**
     * Parse a HAVING clause into visual condition objects.
     * Returns null if any condition is too complex (caller will use raw mode).
     * HAVING visual rows do not support {type:'raw'} rows in the UI.
     *
     * @return array|null  array of {col, op, val, operator} or null on failure
     */
    private function parseHavingConditions(string $text): ?array
    {
        $text = trim($text);
        if ($text === '') {
            return [];
        }

        $parts      = $this->splitByAndOr($text);
        $conditions = [];

        foreach ($parts as [$connector, $expr]) {
            $expr = trim($expr);
            if ($expr === '') {
                continue;
            }

            $cond = $this->parseConditionExpr($expr);

            // HAVING has no raw-condition-row support — bail out so caller uses raw mode
            if (isset($cond['type']) && $cond['type'] === 'raw') {
                return null;
            }

            // If the column reference is not in alias.col format (e.g. a computed
            // alias like _counter, or an aggregate like COUNT(id)), this condition
            // cannot be represented in the visual HAVING builder — force raw mode.
            if (!isset($cond['col']) || !preg_match('/^\w+\.\w+$/', $cond['col'])) {
                return null;
            }

            $cond['operator'] = $connector ?? 'AND';
            $conditions[]     = $cond;
        }

        return $conditions;
    }

    /**
     * Split a WHERE/HAVING clause by top-level AND/OR operators.
     * Returns [[connector|null, exprText], ...] where connector is 'AND', 'OR', or null
     * (null for the very first segment which has no preceding connector).
     */
    private function splitByAndOr(string $text): array
    {
        $parts          = [];
        $len            = strlen($text);
        $upper          = strtoupper($text);
        $depth          = 0;
        $inString       = false;
        $strChar        = '';
        $start          = 0;
        $curConn        = null;
        $betweenPending = 0; // BETWEEN keywords awaiting their AND
        $i              = 0;

        while ($i < $len) {
            if (!$inString && ($text[$i] === "'" || $text[$i] === '"')) {
                $inString = true; $strChar = $text[$i]; $i++; continue;
            }
            if ($inString) {
                if ($text[$i] === $strChar) {
                    if (($i + 1) < $len && $text[$i + 1] === $strChar) { $i += 2; continue; }
                    $inString = false;
                }
                $i++; continue;
            }
            if ($text[$i] === '(') { $depth++; $i++; continue; }
            if ($text[$i] === ')') { $depth--; $i++; continue; }

            if ($depth === 0) {
                // BETWEEN — the AND that follows is part of the range, not a separator
                if (substr($upper, $i, 7) === 'BETWEEN') {
                    $after      = $i + 7;
                    $charBefore = $i > 0 ? $upper[$i - 1] : ' ';
                    $charAfter  = $after < $len ? $upper[$after] : ' ';
                    if ((!ctype_alnum($charBefore) && $charBefore !== '_')
                        && (!ctype_alnum($charAfter) && $charAfter !== '_')) {
                        $betweenPending++;
                        $i = $after;
                        continue;
                    }
                }
                // AND (3 chars)
                if (substr($upper, $i, 3) === 'AND') {
                    $after      = $i + 3;
                    $charBefore = $i > 0 ? $upper[$i - 1] : ' ';
                    $charAfter  = $after < $len ? $upper[$after] : ' ';
                    if ((!ctype_alnum($charBefore) && $charBefore !== '_')
                        && (!ctype_alnum($charAfter) && $charAfter !== '_')) {
                        if ($betweenPending > 0) {
                            // This AND closes a BETWEEN range — skip it as a separator
                            $betweenPending--;
                            $i = $after;
                            continue;
                        }
                        $parts[]  = [$curConn, substr($text, $start, $i - $start)];
                        $curConn  = 'AND';
                        $i        = $after;
                        $start    = $i;
                        continue;
                    }
                }
                // OR (2 chars)
                if (substr($upper, $i, 2) === 'OR') {
                    $after      = $i + 2;
                    $charBefore = $i > 0 ? $upper[$i - 1] : ' ';
                    $charAfter  = $after < $len ? $upper[$after] : ' ';
                    if ((!ctype_alnum($charBefore) && $charBefore !== '_')
                        && (!ctype_alnum($charAfter) && $charAfter !== '_')) {
                        $parts[]  = [$curConn, substr($text, $start, $i - $start)];
                        $curConn  = 'OR';
                        $i        = $after;
                        $start    = $i;
                        continue;
                    }
                }
            }

            $i++;
        }

        // Final segment
        if ($start < $len) {
            $parts[] = [$curConn, substr($text, $start)];
        }

        return $parts;
    }

    /**
     * Try to parse a single condition expression into a visual condition array.
     * Returns {col, op, val} on success, or {type:'raw', expr} when too complex.
     */
    private function parseConditionExpr(string $expr): array
    {
        $clean = trim($this->stripOuterParens(trim($expr)));
        $clean = str_replace('`', '', $clean);

        // Conditions containing a subquery cannot be represented by the visual
        // col/op/val builder — the column dropdown only lists table columns, and
        // the operator regexes below would match keywords inside the subquery
        // (e.g. the "=" in "(SELECT x FROM t WHERE a = b) = 'val'").
        // Keep the whole condition as a raw row instead.
        if ($this->containsSubquery($clean)) {
            return ['type' => 'raw', 'expr' => trim($expr)];
        }

        // IS NOT NULL  (must check before IS NULL)
        if (preg_match('/^(.+?)\s+IS\s+NOT\s+NULL\s*$/i', $clean, $m)) {
            return ['col' => trim($m[1]), 'op' => 'IS NOT NULL', 'val' => ''];
        }

        // IS NULL
        if (preg_match('/^(.+?)\s+IS\s+NULL\s*$/i', $clean, $m)) {
            return ['col' => trim($m[1]), 'op' => 'IS NULL', 'val' => ''];
        }

        // NOT BETWEEN … AND …  (before NOT LIKE to avoid ambiguity)
        if (preg_match('/^(.+?)\s+NOT\s+BETWEEN\s+(.+?)\s+AND\s+(.+)$/i', $clean, $m)) {
            return ['col' => trim($m[1]), 'op' => 'NOT BETWEEN', 'val' => trim($m[2]), 'val2' => trim($m[3])];
        }

        // BETWEEN … AND …
        if (preg_match('/^(.+?)\s+BETWEEN\s+(.+?)\s+AND\s+(.+)$/i', $clean, $m)) {
            return ['col' => trim($m[1]), 'op' => 'BETWEEN', 'val' => trim($m[2]), 'val2' => trim($m[3])];
        }

        // NOT LIKE  (before LIKE)
        if (preg_match('/^(.+?)\s+NOT\s+LIKE\s+(.+)$/i', $clean, $m)) {
            return ['col' => trim($m[1]), 'op' => 'NOT LIKE', 'val' => trim($m[2])];
        }

        // NOT IN
        if (preg_match('/^(.+?)\s+NOT\s+IN\s*\((.+)\)\s*$/is', $clean, $m)) {
            return ['col' => trim($m[1]), 'op' => 'NOT IN', 'val' => $this->normaliseInVal($m[2])];
        }

        // IN
        if (preg_match('/^(.+?)\s+IN\s*\((.+)\)\s*$/is', $clean, $m)) {
            return ['col' => trim($m[1]), 'op' => 'IN', 'val' => $this->normaliseInVal($m[2])];
        }

        // LIKE
        if (preg_match('/^(.+?)\s+LIKE\s+(.+)$/i', $clean, $m)) {
            return ['col' => trim($m[1]), 'op' => 'LIKE', 'val' => trim($m[2])];
        }

        // Symbolic operators — longest first to avoid partial matches
        foreach (['<>', '!=', '<=', '>=', '=', '<', '>'] as $op) {
            $escaped = preg_quote($op, '/');
            if (preg_match('/^(.+?)\s*' . $escaped . '\s*(.+)$/s', $clean, $m)) {
                $normOp = ($op === '<>') ? '!=' : $op;
                return ['col' => trim($m[1]), 'op' => $normOp, 'val' => trim($m[2])];
            }
        }

        // No match — raw condition row (still shown in visual mode as a free-form row)
        return ['type' => 'raw', 'expr' => $expr];
    }

    /**
     * Strip a single layer of enclosing parentheses if the entire expression
     * is wrapped (e.g. "(u.id = 1)" → "u.id = 1").
     * Does not strip if the parens close before the end of the string.
     */
    private function stripOuterParens(string $text): string
    {
        $text = trim($text);
        if ($text === '' || $text[0] !== '(') {
            return $text;
        }

        $depth = 0;
        $len   = strlen($text);
        for ($i = 0; $i < $len; $i++) {
            if ($text[$i] === '(') { $depth++; }
            elseif ($text[$i] === ')') {
                $depth--;
                if ($depth === 0 && $i < $len - 1) {
                    return $text; // closing paren is not at the end — don't strip
                }
            }
        }

        // The whole string is wrapped — strip one layer and recurse
        return $this->stripOuterParens(trim(substr($text, 1, $len - 2)));
    }

    /**
     * True when the expression contains a parenthesized subquery — "(SELECT …" —
     * anywhere outside of string literals.
     */
    private function containsSubquery(string $text): bool
    {
        $len      = strlen($text);
        $inString = false;
        $strChar  = '';

        for ($i = 0; $i < $len; $i++) {
            $ch = $text[$i];
            if (!$inString && ($ch === "'" || $ch === '"')) {
                $inString = true;
                $strChar  = $ch;
                continue;
            }
            if ($inString) {
                if ($ch === $strChar) {
                    if (($i + 1) < $len && $text[$i + 1] === $strChar) { $i++; continue; }
                    $inString = false;
                }
                continue;
            }
            if ($ch === '(' && preg_match('/\G\(\s*SELECT\b/iA', $text, $m, 0, $i)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Normalise whitespace around commas in an IN value list so that multi-line
     * SQL like "(\n    1,\n    2,\n    3\n)" displays cleanly as "1, 2, 3" in the
     * UI value textbox.  Only the whitespace adjacent to commas is collapsed —
     * internal whitespace inside string literals is left untouched.
     */
    private function normaliseInVal(string $raw): string
    {
        return trim(preg_replace('/\s*,\s*/s', ', ', trim($raw)));
    }

    /**
     * Normalise a raw JOIN keyword string to one of the tokens the canvas uses:
     * INNER | LEFT | RIGHT | CROSS | FULL
     */
    private function normaliseJoinType(string $raw): string
    {
        $up = strtoupper(trim($raw));
        if (str_contains($up, 'LEFT'))  { return 'LEFT';  }
        if (str_contains($up, 'RIGHT')) { return 'RIGHT'; }
        if (str_contains($up, 'CROSS')) { return 'CROSS'; }
        if (str_contains($up, 'FULL'))  { return 'FULL';  }
        return 'INNER';
    }
}
