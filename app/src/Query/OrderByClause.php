<?php

declare(strict_types=1);

namespace Query;

/**
 * OrderByClause — builds the ORDER BY portion of a SELECT statement.
 *
 * Supports two modes driven by State.orderByMode:
 *
 *   'visual'  — items from State.orderBy: [{ col: "alias.colname", dir: "ASC"|"DESC" }]
 *               Column refs are validated. Direction is whitelisted.
 *
 *   'raw'     — State.orderByRaw passed through verbatim (developer owns the SQL).
 *               Intended for expressions like FIELD(status,'open','closed').
 *
 * Output examples:
 *   ORDER BY o.created_at DESC, u.name ASC
 *   ORDER BY FIELD(o.status,'open','pending','closed')   ← raw mode
 */
class OrderByClause
{
    /** Only ASC and DESC are valid sort directions. */
    private const ALLOWED_DIRS = ['ASC', 'DESC'];

    /**
     * Build the ORDER BY clause string (including the "ORDER BY" keyword).
     *
     * @param  array  $orderBy   state.orderBy array
     * @param  string $rawText   state.orderByRaw — used only in raw mode
     * @param  string $mode      'visual' | 'raw'
     * @return string  "ORDER BY ..." or "" when there are no sort items
     */
    public function build(array $orderBy, string $rawText = '', string $mode = 'visual'): string
    {
        if ($mode === 'raw') {
            $raw = trim($rawText);
            return $raw !== '' ? "ORDER BY $raw" : '';
        }

        if (empty($orderBy)) {
            return '';
        }

        $parts = [];

        foreach ($orderBy as $item) {
            $col = (string) ($item['col'] ?? '');
            $dir = strtoupper((string) ($item['dir'] ?? 'ASC'));

            // Column reference must be alias.colname
            if (!preg_match('/^\w+\.\w+$/', $col)) {
                continue;
            }

            // Direction must be ASC or DESC
            if (!in_array($dir, self::ALLOWED_DIRS, true)) {
                $dir = 'ASC';
            }

            $parts[] = "$col $dir";
        }

        if (empty($parts)) {
            return '';
        }

        return "ORDER BY " . implode(', ', $parts);
    }
}
