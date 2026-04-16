<?php

declare(strict_types=1);

namespace Query;

use Core\Request;
use Core\Response;
use Database\Connection;
use Database\ProfileManager;

/**
 * TimestampConverter — converts between Unix timestamps and datetime strings via MySQL.
 *
 * Routes:
 *   timestamp.convert  → convert()
 *
 * Request body:
 *   { profileId: string, value: string, direction: 'to_datetime'|'to_unix' }
 *
 * Security:
 *   - direction is whitelisted to exactly two values
 *   - value is length-capped and restricted to safe datetime characters before
 *     being passed to MySQL as a bound PDO parameter (no raw interpolation)
 */
class TimestampConverter
{
    private const MAX_VALUE_LENGTH = 64;

    /** Characters allowed in a Unix timestamp or datetime string. */
    private const VALUE_PATTERN = '/^[\d\s\-:\.T+Z]+$/';

    public function convert(Request $request): void
    {
        $profileId = (string) $request->get('profileId', '');
        if ($profileId === '') {
            Response::error('profileId is required.', 400);
        }

        $direction = (string) $request->get('direction', '');
        if ($direction !== 'to_datetime' && $direction !== 'to_unix') {
            Response::error('direction must be "to_datetime" or "to_unix".', 400);
        }

        $value = (string) $request->get('value', '');
        if ($value === '') {
            Response::error('value is required.', 400);
        }
        if (strlen($value) > self::MAX_VALUE_LENGTH) {
            Response::error('value is too long (max ' . self::MAX_VALUE_LENGTH . ' chars).', 400);
        }
        if (!preg_match(self::VALUE_PATTERN, $value)) {
            Response::error('value contains invalid characters.', 400);
        }

        $pm = new ProfileManager();
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

        try {
            if ($direction === 'to_datetime') {
                // Accept either a Unix integer or a datetime string — normalise via round-trip
                $sql  = is_numeric(trim($value))
                    ? 'SELECT FROM_UNIXTIME(:v) AS result'
                    : 'SELECT FROM_UNIXTIME(UNIX_TIMESTAMP(:v)) AS result';
            } else {
                $sql = 'SELECT UNIX_TIMESTAMP(:v) AS result';
            }

            $stmt = $pdo->prepare($sql);
            $stmt->execute([':v' => trim($value)]);
            $row = $stmt->fetch(\PDO::FETCH_ASSOC);

            Response::success(['result' => $row['result'] ?? null]);
        } catch (\PDOException $e) {
            Response::error('MySQL error: ' . $e->getMessage(), 400);
        }
    }
}
