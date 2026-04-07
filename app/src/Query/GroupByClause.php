<?php

declare(strict_types=1);

namespace Query;

/**
 * GroupByClause — builds the GROUP BY portion of a SELECT statement.
 */
class GroupByClause
{
    /**
     * Build the GROUP BY clause string (including the "GROUP BY" keyword).
     *
     * @param  array  $groupBy   state.groupBy array: string[] (alias.colname)
     * @param  string $rawText   state.groupByRaw — used only in raw mode
     * @param  string $mode      'visual' | 'raw'
     * @return string  "GROUP BY ..." or "" when there are no items
     */
    public function build(array $groupBy, string $rawText = '', string $mode = 'visual'): string
    {
        if ($mode === 'raw') {
            $raw = trim($rawText);
            return $raw !== '' ? "GROUP BY $raw" : '';
        }

        if (empty($groupBy)) {
            return '';
        }

        $parts = [];

        foreach ($groupBy as $col) {
            $col = (string) $col;

            // Column reference must be alias.colname
            if (!preg_match('/^\w+\.\w+$/', $col)) {
                continue;
            }

            $parts[] = $col;
        }

        if (empty($parts)) {
            return '';
        }

        return "GROUP BY " . implode(', ', $parts);
    }
}
