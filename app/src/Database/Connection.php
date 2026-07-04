<?php

declare(strict_types=1);

namespace Database;

use \PDO;
use \PDOException;

/**
 * Connection — PDO wrapper.
 *
 * Accepts a profile array and opens a PDO connection.
 * Supports MySQL (type: 'mysql') and SQLite file databases (type: 'sqlite').
 * Throws PDOException on failure so callers can catch and report cleanly.
 */
class Connection
{
    private PDO $pdo;

    /**
     * @param array $profile  Shape depends on type:
     *   MySQL:  { type, host, port, database, user, password }
     *   SQLite: { type, file_path }
     * @throws PDOException
     */
    public function __construct(array $profile)
    {
        $type = $profile['type'] ?? 'mysql';

        if ($type === 'sqlite') {
            $this->pdo = new PDO(
                'sqlite:' . $profile['file_path'],
                null,
                null,
                [
                    PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                ]
            );
            return;
        }

        $dbPart = !empty($profile['database']) ? ';dbname=' . $profile['database'] : '';
        $dsn = sprintf(
            'mysql:host=%s;port=%d%s;charset=utf8mb4',
            $profile['host'],
            (int) ($profile['port'] ?? 3306),
            $dbPart
        );

        $this->pdo = new PDO(
            $dsn,
            $profile['user'],
            $profile['password'] ?? '',
            [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_TIMEOUT            => 5,
                // SET NAMES sets the client charset.
                // SET time_zone forces the session to UTC so that TIMESTAMP columns
                // are always returned as UTC strings, regardless of the DB server's
                // system timezone.  DATETIME columns are unaffected (they carry no
                // timezone metadata).
                PDO::MYSQL_ATTR_INIT_COMMAND => "SET NAMES 'utf8mb4'",
            ]
        );
    }

    public function getPdo(): PDO
    {
        return $this->pdo;
    }
}
