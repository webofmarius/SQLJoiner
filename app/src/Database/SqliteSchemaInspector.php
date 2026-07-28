<?php

declare(strict_types=1);

namespace Database;

use Core\Request;
use Core\Response;

class SqliteSchemaInspector implements SchemaInspectorInterface
{
    private \PDO $pdo;

    public function __construct(array $profile)
    {
        try {
            $this->pdo = (new Connection($profile))->getPdo();
        } catch (\PDOException $e) {
            Response::error('Connection failed: ' . $e->getMessage());
        }
    }

    /**
     * SQLite has no concept of multiple databases in one connection.
     * Return ["main"] so the front-end database-selection step works unchanged.
     */
    public function getDatabases(Request $request): void
    {
        Response::success(['main']);
    }

    public function getTables(Request $request): void
    {
        try {
            $stmt = $this->pdo->query(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                 ORDER BY name"
            );

            $tables = [];
            while ($row = $stmt->fetch(\PDO::FETCH_ASSOC)) {
                $tables[] = ['name' => $row['name'], 'rows' => 0];
            }

            Response::success($tables);
        } catch (\PDOException $e) {
            Response::error('Failed to fetch tables: ' . $e->getMessage());
        }
    }

    /**
     * Maps PRAGMA table_info output to the same shape as MySqlSchemaInspector:
     *   { name, type, shortType, nullable, key, default, extra }
     *
     * PRAGMA columns: cid | name | type | notnull | dflt_value | pk
     */
    public function getColumns(Request $request): void
    {
        $table = $request->get('table');
        if (!$table) Response::error('table is required.', 400);

        if (!preg_match('/^\w+$/', $table)) {
            Response::error('Invalid table name.', 400);
        }

        try {
            $normalised = self::fetchColumns($this->pdo, $table);

            if (empty($normalised)) {
                Response::error("Table '{$table}' not found.", 404);
            }

            Response::success($normalised);
        } catch (\PDOException $e) {
            Response::error('Failed to fetch columns: ' . $e->getMessage());
        }
    }

    /**
     * Data-returning column lookup shared with QueryParser, which already
     * holds an open PDO connection for the profile and needs the raw array
     * (not a Response) while enriching tables parsed out of an imported SQL query.
     *
     * @throws \PDOException
     */
    public static function fetchColumns(\PDO $pdo, string $table): array
    {
        $stmt    = $pdo->query("PRAGMA table_info(\"{$table}\")");
        $columns = $stmt->fetchAll(\PDO::FETCH_ASSOC);

        return array_map(fn(array $col) => [
            'name'      => $col['name'],
            'type'      => $col['type'],
            'shortType' => self::shortType($col['type']),
            'nullable'  => $col['notnull'] == 0,
            'key'       => $col['pk'] == 1 ? 'PRI' : '',
            'default'   => $col['dflt_value'],
            'extra'     => '',
        ], $columns);
    }

    public function getCreateStatement(Request $request): void
    {
        $table = $request->get('table');
        if (!$table) Response::error('table is required.', 400);

        if (!preg_match('/^\w+$/', $table)) {
            Response::error('Invalid table name.', 400);
        }

        try {
            $stmt = $this->pdo->prepare(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
            );
            $stmt->execute([$table]);
            $ddl = $stmt->fetchColumn();

            if ($ddl === false) {
                Response::error("Table '{$table}' not found.", 404);
            }

            Response::success(['ddl' => $ddl]);
        } catch (\PDOException $e) {
            Response::error('Failed to fetch CREATE statement: ' . $e->getMessage());
        }
    }

    /**
     * SQLite has no information_schema, so we run COUNT(*) per table.
     * Accurate but O(n) queries — acceptable for typical SQLite file sizes.
     */
    public function getRowCounts(Request $request): void
    {
        $tables = $request->get('tables') ?? [];

        if (!is_array($tables) || empty($tables)) Response::error('tables array is required.', 400);

        foreach ($tables as $t) {
            if (!preg_match('/^\w+$/', (string) $t)) {
                Response::error('Invalid table name: ' . $t, 400);
            }
        }

        try {
            $counts = [];
            foreach ($tables as $table) {
                $stmt             = $this->pdo->query("SELECT COUNT(*) FROM \"{$table}\"");
                $counts[$table]   = (int) $stmt->fetchColumn();
            }

            Response::success($counts);
        } catch (\PDOException $e) {
            Response::error('Failed to fetch row counts: ' . $e->getMessage());
        }
    }

    private static function shortType(string $type): string
    {
        return strtolower(preg_replace('/\(.*\)/', '', $type));
    }
}
