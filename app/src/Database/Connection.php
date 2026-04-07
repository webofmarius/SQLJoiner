<?php

declare(strict_types=1);

namespace Database;

use \PDO;
use \PDOException;

/**
 * Connection — PDO wrapper.
 *
 * Accepts a profile array and opens a MySQL PDO connection.
 * Throws PDOException on failure so callers can catch and report cleanly.
 */
class Connection
{
    private PDO $pdo;

    /**
     * @param array{host:string, port:int, database:string, user:string, password:string} $profile
     * @throws PDOException
     */
    public function __construct(array $profile)
    {
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
