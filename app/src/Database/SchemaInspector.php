<?php

declare(strict_types=1);

namespace Database;

use Core\Request;
use Core\Response;

/**
 * SchemaInspector — Factory + Proxy for database schema introspection.
 *
 * Reads the connection type from the stored profile and delegates every call
 * to the appropriate implementation (MySqlSchemaInspector / SqliteSchemaInspector).
 * The routing layer (api.php) is unaware of the database type.
 */
class SchemaInspector
{
    private ProfileManager $profileManager;

    public function __construct()
    {
        $this->profileManager = new ProfileManager();
    }

    public function getDatabases(Request $request): void
    {
        $this->make($request)->getDatabases($request);
    }

    public function getTables(Request $request): void
    {
        $this->make($request)->getTables($request);
    }

    public function getColumns(Request $request): void
    {
        $this->make($request)->getColumns($request);
    }

    public function getCreateStatement(Request $request): void
    {
        $this->make($request)->getCreateStatement($request);
    }

    public function getRowCounts(Request $request): void
    {
        $this->make($request)->getRowCounts($request);
    }

    // -------------------------------------------------------------------------

    private function make(Request $request): SchemaInspectorInterface
    {
        $profileId = $request->get('profileId');
        if (!$profileId) {
            Response::error('profileId is required.', 400);
        }

        $profile = $this->profileManager->getProfileById($profileId);
        if (!$profile) {
            Response::error('Profile not found.', 404);
        }

        return match($profile['type'] ?? 'mysql') {
            'sqlite' => new SqliteSchemaInspector($profile),
            default  => new MySqlSchemaInspector($profile),
        };
    }
}
