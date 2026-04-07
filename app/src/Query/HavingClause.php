<?php

declare(strict_types=1);

namespace Query;

/**
 * HavingClause — builds the HAVING portion of a SELECT statement.
 */
class HavingClause
{
    /** Whitelisted comparison operators. */
    private const ALLOWED_OPS = [
        '=', '!=', '<', '>', '<=', '>=',
        'LIKE', 'NOT LIKE',
        'IS NULL', 'IS NOT NULL',
        'IN', 'NOT IN',
    ];

    /**
     * Build the HAVING clause string (including the "HAVING" keyword).
     *
     * @param  array  $conditions   state.having array
     * @param  \PDO   $pdo          used to quote() string values safely
     * @param  string $rawHaving     state.havingRaw — used only in raw mode
     * @param  string $mode         'visual' | 'raw'
     * @return string  "HAVING ..." or "" when there are no conditions
     */
    public function build(
        array  $conditions,
        \PDO   $pdo,
        string $rawHaving = '',
        string $mode     = 'visual'
    ): string {
        if ($mode === 'raw') {
            $raw = trim($rawHaving);
            return $raw !== '' ? "HAVING\n\t$raw" : '';
        }

        if (empty($conditions)) {
            return '';
        }

        $parts = [];

        foreach ($conditions as $cond) {
            $col = (string) ($cond['col'] ?? '');
            $op  = (string) ($cond['op']  ?? '=');
            $val = (string) ($cond['val'] ?? '');

            if (!in_array($op, self::ALLOWED_OPS, true)) {
                continue;
            }

            // HAVING often uses aggregate functions or aliases, so validation might be different.
            // But let's stay consistent with WHERE for now, or maybe allow more.
            // If it's the visual builder, it's usually alias.colname.
            if (!preg_match('/^\w+\.\w+$/', $col)) {
                continue;
            }

            if ($op === 'IS NULL' || $op === 'IS NOT NULL') {
                $parts[] = "$col $op";
            } elseif ($op === 'IN' || $op === 'NOT IN') {
                $vals    = array_map('trim', explode(',', $val));
                $parts[] = "$col $op (" . implode(', ', $vals) . ")";
            } else {
                $parts[] = "$col $op $val";
            }
        }

        if (empty($parts)) {
            return '';
        }

        return "HAVING\n\t    " . implode("\n\tAND ", $parts);
    }
}
