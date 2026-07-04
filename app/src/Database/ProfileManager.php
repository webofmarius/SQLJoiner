<?php

declare(strict_types=1);

namespace Database;

use Core\Request;
use Core\Response;

/**
 * ProfileManager — CRUD for connection profiles.
 *
 * Profiles are stored in storage/profiles.json as a JSON array.
 * Each profile shape: { id, name, host, port, database, user, password }
 *
 * Security note: passwords are stored in plain text in the JSON file.
 * The storage/ directory is blocked from web access via .htaccess.
 * This tool is intended for internal / developer use only.
 *
 * Password handling:
 *   - list()  → passwords are NEVER sent to the browser
 *   - save()  → if password field is empty on an update, the stored password is preserved
 *   - test()  → if testing an existing profile by ID, the stored password is used
 */
class ProfileManager
{
    private string $storageFile;

    public function __construct()
    {
        $this->storageFile = STORAGE_PATH . '/profiles.json';
    }

    // -------------------------------------------------------------------------
    // list — returns all profiles, passwords stripped
    // -------------------------------------------------------------------------
    public function list(Request $request): void
    {
        $profiles = $this->readProfiles();

        $safe = array_map(
            fn(array $p) => array_merge($p, ['password' => '']),
            $profiles
        );

        Response::success(array_values($safe));
    }

    // -------------------------------------------------------------------------
    // save — create or update a profile
    // -------------------------------------------------------------------------
    public function save(Request $request): void
    {
        $data = $request->all();
        $type = $data['type'] ?? 'mysql';

        if ($type === 'sqlite') {
            $this->requireFields($data, ['name', 'file_path']);
        } else {
            $this->requireFields($data, ['name', 'host', 'database', 'user']);
        }

        $profiles = $this->readProfiles();
        $id       = $data['id'] ?? null;

        if ($id) {
            // --- Update existing ---
            $found = false;
            foreach ($profiles as &$stored) {
                if ($stored['id'] !== $id) continue;

                // Preserve password if the client sent an empty string
                $password = ($data['password'] ?? '') !== ''
                    ? $data['password']
                    : ($stored['password'] ?? '');

                $stored = $this->buildProfile($data, $id, $password);
                $found  = true;
                break;
            }
            unset($stored);

            if (!$found) {
                Response::error("Profile not found: {$id}", 404);
            }
        } else {
            // --- Create new ---
            $id        = uniqid('p_', true);
            $profiles[] = $this->buildProfile($data, $id, $data['password'] ?? '');
        }

        $this->writeProfiles($profiles);

        // Return the saved profile (password stripped)
        $saved = $this->findById($profiles, $id);
        Response::success(
            array_merge($saved, ['password' => '']),
            'Profile saved.'
        );
    }

    // -------------------------------------------------------------------------
    // delete — remove a profile by id
    // -------------------------------------------------------------------------
    public function delete(Request $request): void
    {
        $id = $request->get('id');
        if (!$id) {
            Response::error('Profile ID is required.', 400);
        }

        $profiles = $this->readProfiles();
        $filtered = array_values(
            array_filter($profiles, fn(array $p) => $p['id'] !== $id)
        );

        if (count($filtered) === count($profiles)) {
            Response::error("Profile not found: {$id}", 404);
        }

        $this->writeProfiles($filtered);
        Response::success(null, 'Profile deleted.');
    }

    // -------------------------------------------------------------------------
    // test — verify a connection
    //
    // Two modes:
    //   A) { id }               → load stored profile (including stored password)
    //   B) { host, database, user, password?, ... } → test with submitted data
    //      If id is present but password is blank, stored password is used.
    // -------------------------------------------------------------------------
    public function test(Request $request): void
    {
        $data = $request->all();

        // Mode A: only an id is provided — load the full stored profile
        $isModeA = !empty($data['id']) && empty($data['host']) && empty($data['file_path']);

        if ($isModeA) {
            $profiles = $this->readProfiles();
            $profile  = $this->findById($profiles, $data['id']);
            if (!$profile) {
                Response::error('Profile not found.', 404);
            }
        } else {
            // Mode B: test with form data
            $type    = $data['type'] ?? 'mysql';
            $profile = $data;

            if ($type === 'sqlite') {
                $this->requireFields($data, ['file_path']);
            } else {
                $this->requireFields($data, ['host', 'database', 'user']);

                // If editing an existing profile and password was left blank,
                // pull the stored password so the test uses real credentials
                if (!empty($data['id']) && ($data['password'] ?? '') === '') {
                    $profiles = $this->readProfiles();
                    $existing = $this->findById($profiles, $data['id']);
                    $profile['password'] = $existing['password'] ?? '';
                }
            }
        }

        try {
            new Connection($profile);
            Response::success(null, 'Connection successful.');
        } catch (\PDOException $e) {
            Response::error('Connection failed: ' . $e->getMessage());
        }
    }

    // =========================================================================
    // Private helpers
    // =========================================================================

    private function buildProfile(array $data, string $id, string $password): array
    {
        $type = $data['type'] ?? 'mysql';

        if ($type === 'sqlite') {
            return [
                'id'        => $id,
                'name'      => trim($data['name']      ?? ''),
                'type'      => 'sqlite',
                'file_path' => trim($data['file_path'] ?? ''),
            ];
        }

        return [
            'id'       => $id,
            'name'     => trim($data['name']     ?? ''),
            'type'     => 'mysql',
            'host'     => trim($data['host']     ?? 'localhost'),
            'port'     => (int) ($data['port']   ?? 3306),
            'database' => trim($data['database'] ?? ''),
            'user'     => trim($data['user']     ?? ''),
            'password' => $password,
        ];
    }

    private function readProfiles(): array
    {
        if (!file_exists($this->storageFile)) {
            return [];
        }
        $json = file_get_contents($this->storageFile);
        return json_decode($json, true) ?? [];
    }

    private function writeProfiles(array $profiles): void
    {
        $dir = dirname($this->storageFile);
        if (!is_dir($dir)) {
            mkdir($dir, 0755, true);
        }
        file_put_contents(
            $this->storageFile,
            json_encode(array_values($profiles), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE),
            LOCK_EX
        );
    }

    /**
     * Public lookup used by SchemaInspector and QueryBuilder.
     * Returns the full profile including password.
     */
    public function getProfileById(string $id): ?array
    {
        return $this->findById($this->readProfiles(), $id);
    }

    private function findById(array $profiles, string $id): ?array
    {
        foreach ($profiles as $p) {
            if ($p['id'] === $id) return $p;
        }
        return null;
    }

    private function requireFields(array $data, array $fields): void
    {
        foreach ($fields as $field) {
            if (empty($data[$field])) {
                Response::error("Field '{$field}' is required.", 400);
            }
        }
    }
}
