<?php

declare(strict_types=1);

namespace Query;

/**
 * JoinClause — builds the JOIN portion of a SELECT statement.
 *
 * Uses the same chain-following algorithm as the JS buildSQL in config.js so that
 * the server-generated SQL matches the client-side preview identically.
 *
 * Input (from state.joins[]):
 *   { id, fromTableId, fromCol, toTableId, toCol, type }
 *
 * Input (from state.tables[]):
 *   { id, name, alias, columns, position, database? }
 *   When the optional `database` field is present the table reference is
 *   emitted as `db`.`table`; otherwise just `table`.
 *
 * Output example:
 *   INNER JOIN `schema_a`.`users` u ON o.`user_id` = u.`id`
 *   LEFT JOIN `schema_b`.`products` p ON o.`product_id` = p.`id`
 */
class JoinClause
{
    private const JOIN_KEYWORDS = [
        'INNER' => 'INNER JOIN',
        'LEFT'  => 'LEFT JOIN',
        'RIGHT' => 'RIGHT JOIN',
        'FULL'  => 'FULL OUTER JOIN',
        'CROSS' => 'CROSS JOIN',
    ];

    /**
     * Build all JOIN lines for the query.
     *
     * @param  array $joins  state.joins array
     * @param  array $tables state.tables array
     * @return string  one or more JOIN lines (no leading/trailing whitespace per line)
     */
    public function build(array $joins, array $tables): string
    {
        if (empty($joins)) {
            return '';
        }

        $tableMap = [];
        foreach ($tables as $t) {
            $tableMap[$t['id']] = $t;
        }

        // Start the chain with the first table (= the FROM table)
        $chain = [];
        if (!empty($tables)) {
            $chain[$tables[0]['id']] = true;
        }

        $lines = [];

        foreach ($joins as $join) {
            $fromId = $join['fromTableId'] ?? '';
            $toId   = $join['toTableId']   ?? '';
            $fromT  = $tableMap[$fromId] ?? null;
            $toT    = $tableMap[$toId]   ?? null;

            if ($fromT === null || $toT === null) {
                continue; // orphaned join (table removed from canvas)
            }

            $kw = self::JOIN_KEYWORDS[$join['type'] ?? 'INNER'] ?? 'INNER JOIN';

            $fromInChain = isset($chain[$fromId]);
            $toInChain   = isset($chain[$toId]);

            if (!$toInChain) {
                // Normal order: from-table is the driver, to-table is new
                $joinTable = $toT;
                $onLeft    = $fromT['alias'] . '.' . $this->col($join['fromCol'] ?? '');
                $onRight   = $toT['alias']   . '.' . $this->col($join['toCol']   ?? '');
                $chain[$toId] = true;
            } elseif (!$fromInChain) {
                // Reversed: to-table is the driver, from-table is new
                $joinTable = $fromT;
                $onLeft    = $toT['alias']   . '.' . $this->col($join['toCol']   ?? '');
                $onRight   = $fromT['alias'] . '.' . $this->col($join['fromCol'] ?? '');
                $chain[$fromId] = true;
            } else {
                // Both already in chain — emit as an additional ON join
                $joinTable = $toT;
                $onLeft    = $fromT['alias'] . '.' . $this->col($join['fromCol'] ?? '');
                $onRight   = $toT['alias']   . '.' . $this->col($join['toCol']   ?? '');
            }

            $lines[] = sprintf(
                '%s %s %s ON %s = %s',
                $kw,
                $this->tableRef($joinTable),
                $joinTable['alias'],
                $onLeft,
                $onRight
            );
        }

        return implode("\n", $lines);
    }

    /**
     * Return which table IDs are "in the chain" after following all joins.
     * Used by QueryBuilder to detect unchained tables.
     *
     * @param  array $joins
     * @param  array $tables
     * @return string[]  table IDs that are reachable through joins from the first table
     */
    public function getChainedIds(array $joins, array $tables): array
    {
        if (empty($tables)) {
            return [];
        }

        $chain = [$tables[0]['id'] => true];

        // Multi-pass BFS: repeat until no new table is added.  A single pass is
        // insufficient when joins arrive out of chain order (e.g. [B→C, A→B] with
        // FROM=A would miss C on the first pass).
        do {
            $added = false;
            foreach ($joins as $j) {
                $fromId = $j['fromTableId'] ?? '';
                $toId   = $j['toTableId']   ?? '';

                if (isset($chain[$fromId]) && !isset($chain[$toId])) {
                    $chain[$toId] = true;
                    $added = true;
                } elseif (isset($chain[$toId]) && !isset($chain[$fromId])) {
                    $chain[$fromId] = true;
                    $added = true;
                }
            }
        } while ($added);

        return array_keys($chain);
    }

    /**
     * Return all connected components (islands) as an array of table-ID arrays.
     * Every table — including single unconnected tables — belongs to exactly one island.
     *
     * @param  array $joins   enabled joins only
     * @param  array $tables
     * @return array[]  e.g. [['t1','t2'], ['t3']]
     */
    public function getConnectedComponents(array $joins, array $tables): array
    {
        if (empty($tables)) {
            return [];
        }

        $adj     = [];
        $visited = [];
        foreach ($tables as $t) {
            $adj[$t['id']] = [];
        }
        foreach ($joins as $j) {
            $fid = $j['fromTableId'] ?? '';
            $tid = $j['toTableId']   ?? '';
            if (isset($adj[$fid])) $adj[$fid][] = $tid;
            if (isset($adj[$tid])) $adj[$tid][] = $fid;
        }

        $islands = [];
        foreach ($tables as $t) {
            $id = $t['id'];
            if (isset($visited[$id])) continue;
            $island = [];
            $queue  = [$id];
            $visited[$id] = true;
            while (!empty($queue)) {
                $cur = array_shift($queue);
                $island[] = $cur;
                foreach ($adj[$cur] ?? [] as $nbr) {
                    if (!isset($visited[$nbr])) {
                        $visited[$nbr] = true;
                        $queue[] = $nbr;
                    }
                }
            }
            $islands[] = $island;
        }

        return $islands;
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /**
     * Build a fully-qualified (or plain) table reference.
     * With database:  `schema`.`table`
     * Without:        `table`
     * Subquery table: (SELECT …)
     */
    private function tableRef(array $table): string
    {
        if (!empty($table['isSubquery'])) {
            return '(' . trim((string) ($table['subquery'] ?? '')) . ')';
        }
        $name = '`' . $this->escapeName($table['name']) . '`';
        if (!empty($table['database'])) {
            return '`' . $this->escapeName($table['database']) . '`.' . $name;
        }
        return $name;
    }

    /** Backtick-quote a column name: foo → `foo` */
    private function col(string $name): string
    {
        return '`' . $this->escapeName($name) . '`';
    }

    /** Escape backticks inside an identifier (double them). */
    private function escapeName(string $name): string
    {
        return str_replace('`', '``', $name);
    }
}
