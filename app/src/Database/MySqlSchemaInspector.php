<?php

declare(strict_types=1);

namespace Database;

use Core\Request;
use Core\Response;

class MySqlSchemaInspector implements SchemaInspectorInterface
{
    private \PDO $pdo;

    private const SYSTEM_DBS = ['information_schema', 'performance_schema', 'mysql', 'sys'];

    public function __construct(array $profile)
    {
        try {
            $this->pdo = (new Connection($profile))->getPdo();
        } catch (\PDOException $e) {
            Response::error('Connection failed: ' . $e->getMessage());
        }
    }

    public function getDatabases(Request $request): void
    {
        try {
            $stmt      = $this->pdo->query('SHOW DATABASES');
            $databases = $stmt->fetchAll(\PDO::FETCH_COLUMN);

            $databases = array_values(array_filter(
                $databases,
                fn($db) => !in_array(strtolower((string) $db), self::SYSTEM_DBS, true)
            ));

            sort($databases);
            Response::success($databases);
        } catch (\PDOException $e) {
            Response::error('Failed to fetch databases: ' . $e->getMessage());
        }
    }

    public function getTables(Request $request): void
    {
        $database = (string) ($request->get('database') ?? '');

        if ($database !== '' && !preg_match('/^\w+$/', $database)) {
            Response::error('Invalid database name.', 400);
        }

        try {
            if ($database === '') {
                $database = (string) $this->pdo->query('SELECT DATABASE()')->fetchColumn();
            }

            if ($database === '') {
                Response::error('No database selected.', 400);
            }

            $stmt = $this->pdo->prepare(
                "SELECT TABLE_NAME, TABLE_ROWS
                 FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = ?
                   AND TABLE_TYPE = 'BASE TABLE'
                 ORDER BY TABLE_NAME"
            );
            $stmt->execute([$database]);

            $tables = [];
            while ($row = $stmt->fetch(\PDO::FETCH_ASSOC)) {
                $tables[] = [
                    'name' => $row['TABLE_NAME'],
                    'rows' => (int) ($row['TABLE_ROWS'] ?? 0),
                ];
            }

            Response::success($tables);
        } catch (\PDOException $e) {
            Response::error('Failed to fetch tables: ' . $e->getMessage());
        }
    }

    public function getColumns(Request $request): void
    {
        $table    = $request->get('table');
        $database = (string) ($request->get('database') ?? '');

        if (!$table) Response::error('table is required.', 400);

        if (!preg_match('/^\w+$/', $table)) {
            Response::error('Invalid table name.', 400);
        }

        if ($database !== '' && !preg_match('/^\w+$/', $database)) {
            Response::error('Invalid database name.', 400);
        }

        try {
            Response::success(self::fetchColumns($this->pdo, $table, $database));
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
    public static function fetchColumns(\PDO $pdo, string $table, string $database = ''): array
    {
        $tableRef = $database !== ''
            ? "`{$database}`.`{$table}`"
            : "`{$table}`";

        $stmt    = $pdo->query("DESCRIBE {$tableRef}");
        $columns = $stmt->fetchAll();

        return array_map(fn(array $col) => [
            'name'      => $col['Field'],
            'type'      => $col['Type'],
            'shortType' => self::shortType($col['Type']),
            'nullable'  => $col['Null'] === 'YES',
            'key'       => $col['Key'],
            'default'   => $col['Default'],
            'extra'     => $col['Extra'],
        ], $columns);
    }

    public function getCreateStatement(Request $request): void
    {
        $table    = $request->get('table');
        $database = (string) ($request->get('database') ?? '');

        if (!$table) Response::error('table is required.', 400);

        if (!preg_match('/^\w+$/', $table)) {
            Response::error('Invalid table name.', 400);
        }

        if ($database !== '' && !preg_match('/^\w+$/', $database)) {
            Response::error('Invalid database name.', 400);
        }

        try {
            $tableRef = $database !== ''
                ? "`{$database}`.`{$table}`"
                : "`{$table}`";

            $stmt = $this->pdo->query("SHOW CREATE TABLE {$tableRef}");
            $row  = $stmt->fetch(\PDO::FETCH_ASSOC);

            $ddl = $row['Create Table'] ?? $row[array_keys($row)[1]] ?? '';

            if ($database !== '' && $ddl !== '') {
                $ddl = preg_replace(
                    '/^(CREATE TABLE\s+)`/',
                    '$1`' . $database . '`.`',
                    $ddl
                );
            }

            Response::success(['ddl' => $ddl]);
        } catch (\PDOException $e) {
            Response::error('Failed to fetch CREATE statement: ' . $e->getMessage());
        }
    }

    public function getRowCounts(Request $request): void
    {
        $tables   = $request->get('tables') ?? [];
        $database = (string) ($request->get('database') ?? '');

        if (!is_array($tables) || empty($tables)) Response::error('tables array is required.', 400);

        foreach ($tables as $t) {
            if (!preg_match('/^\w+$/', (string) $t)) {
                Response::error('Invalid table name: ' . $t, 400);
            }
        }

        if ($database !== '' && !preg_match('/^\w+$/', $database)) {
            Response::error('Invalid database name.', 400);
        }

        try {
            if ($database === '') {
                $database = (string) $this->pdo->query('SELECT DATABASE()')->fetchColumn();
            }

            if ($database === '') {
                Response::error('No database selected.', 400);
            }

            $placeholders = implode(',', array_fill(0, count($tables), '?'));
            $stmt = $this->pdo->prepare(
                "SELECT TABLE_NAME, TABLE_ROWS
                 FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = ?
                   AND TABLE_NAME IN ({$placeholders})"
            );
            $stmt->execute([$database, ...$tables]);

            $counts = [];
            while ($row = $stmt->fetch(\PDO::FETCH_ASSOC)) {
                $counts[$row['TABLE_NAME']] = (int) ($row['TABLE_ROWS'] ?? 0);
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
