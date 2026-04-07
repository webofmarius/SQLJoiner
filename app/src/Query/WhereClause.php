<?php

declare(strict_types=1);

namespace Query;

/**
 * WhereClause — builds the WHERE portion of a SELECT statement.
 *
 * Supports two modes driven by State.whereMode:
 *
 *   'visual'  — conditions from State.where:  { col, op, val }
 *               Values are passed verbatim (user is responsible for quoting).
 *               Operators are whitelisted.
 *               Column refs (alias.colname) are validated against \w+\.\w+.
 *
 *   'raw'     — State.whereRaw passed through verbatim (developer owns the SQL).
 *               Intended for complex expressions the visual builder can't express.
 *
 * Output examples:
 *   WHERE u.name LIKE 'john%'
 *     AND o.total > 500
 *     AND o.status IS NOT NULL
 */
class WhereClause
{
    /** Whitelisted comparison operators — anything else is silently skipped. */
    private const ALLOWED_OPS = [
        '=', '!=', '<', '>', '<=', '>=',
        'LIKE', 'NOT LIKE',
        'IS NULL', 'IS NOT NULL',
        'IN', 'NOT IN',
    ];

    /**
     * Build the WHERE clause string (including the "WHERE" keyword).
     *
     * @param  array  $conditions   state.where array
     * @param  \PDO   $pdo          used to quote() string values safely
     * @param  string $rawWhere     state.whereRaw — used only in raw mode
     * @param  string $mode         'visual' | 'raw'
     * @return string  "WHERE ..." or "" when there are no conditions
     */
    public function build(
        array  $conditions,
        \PDO   $pdo,
        string $rawWhere = '',
        string $mode     = 'visual'
    ): string {
        if ($mode === 'raw') {
            $raw = trim($rawWhere);
            return $raw !== '' ? "WHERE\n\t$raw" : '';
        }

        if (empty($conditions)) {
            return '';
        }

        $parts = [];

        foreach ($conditions as $idx => $cond) {
            // Skip conditions that have been disabled via the enable checkbox
            if (isset($cond['enabled']) && $cond['enabled'] === false) continue;

            $type     = (string) ($cond['type']     ?? 'column');
            $operator = strtoupper((string) ($cond['operator'] ?? 'AND'));

            if ($operator !== 'AND' && $operator !== 'OR') {
                $operator = 'AND';
            }

            $part = '';

            if ($type === 'raw') {
                $expr = trim((string) ($cond['expr'] ?? ''));
                if ($expr === '') continue;
                if (preg_match('/^select\s/i', $expr)) $expr = "($expr)";
                $part = $expr;
            } else {
                $col = (string) ($cond['col'] ?? '');
                $op  = (string) ($cond['op']  ?? '=');
                $val = (string) ($cond['val'] ?? '');

                // Operator must be in the whitelist
                if (!in_array($op, self::ALLOWED_OPS, true)) continue;

                // Column reference must be alias.colname
                if (!preg_match('/^\w+\.\w+$/', $col)) continue;

                if ($op === 'IS NULL' || $op === 'IS NOT NULL') {
                    $part = "$col $op";
                } elseif ($op === 'IN' || $op === 'NOT IN') {
                    $vals = array_map('trim', explode(',', $val));
                    $list = implode(', ', $vals);
                    $part = "$col $op ($list)";
                } else {
                    $part = "$col $op $val";
                }
            }

            if (!empty($cond['startGroup'])) $part = "($part";
            if (!empty($cond['endGroup']))   $part = "$part)";

            if (empty($parts)) {
                $parts[] = "WHERE\n\t    $part";
            } else {
                $parts[] = "\t$operator $part";
            }
        }

        return implode("\n", $parts);
    }
}
