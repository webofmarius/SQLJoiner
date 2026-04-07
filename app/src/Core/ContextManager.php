<?php

declare(strict_types=1);

namespace Core;

/**
 * ContextManager — saves and loads named canvas states to storage/contexts/.
 *
 * Each saved context is a JSON file: storage/contexts/{id}.json
 *
 * File schema:
 *   {
 *     id:      string,          // slug + short unique suffix
 *     name:    string,          // human label supplied by the user
 *     savedAt: string (ISO 8601),
 *     context: <State object>   // serialised JS State
 *   }
 *
 * Routes (wired in api.php):
 *   context.save    save($request)     { name, context }  → { id, name, savedAt }
 *   context.load    load($request)     { id }             → <State object>
 *   context.list    listAll($request)  (no body)          → [{ id, name, savedAt }]
 *   context.delete  delete($request)   { id }             → null
 *   context.rename  rename($request)   { id, name }       → { id, name, savedAt }
 *   context.update  update($request)   { id, name, context } → { id, name, savedAt }
 *
 * Security:
 *   - File names are derived only from a strict slug + uniqid() — no user input reaches
 *     the filesystem directly.
 *   - The filePath() helper re-sanitises the id before building the path, preventing
 *     any directory traversal even if the id stored in the file is somehow manipulated.
 */
class ContextManager
{
    private string $dir;

    public function __construct()
    {
        $this->dir = STORAGE_PATH . '/contexts';
    }

    // =========================================================================
    // Route handlers
    // =========================================================================

    /**
     * Save the current canvas state under a user-supplied name.
     * A new file is always created — saving does not overwrite existing entries.
     *
     * Request body: { name: string, context: object }
     * Response:     { id, name, savedAt }
     */
    public function save(Request $request): void
    {
        $name    = trim((string) $request->get('name', ''));
        $context = $request->get('context');

        if ($name === '') {
            Response::error('Context name is required.', 400);
        }
        if (!is_array($context)) {
            Response::error('Context payload is required.', 400);
        }

        $this->ensureDir();

        $id      = $this->makeId($name);
        $savedAt = (new \DateTimeImmutable())->format(\DateTimeInterface::ATOM);

        $payload = [
            'id'      => $id,
            'name'    => $name,
            'savedAt' => $savedAt,
            'context' => $context,
        ];

        file_put_contents(
            $this->filePath($id),
            json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE),
            LOCK_EX
        );

        Response::success(
            ['id' => $id, 'name' => $name, 'savedAt' => $savedAt],
            'Context saved.'
        );
    }

    /**
     * Load a saved context by its id.
     *
     * Request body: { id: string }
     * Response:     <State object>
     */
    public function load(Request $request): void
    {
        $id   = (string) $request->get('id', '');
        $file = $this->requireFile($id);

        $payload = json_decode(file_get_contents($file), true);
        if (!is_array($payload)) {
            Response::error('Corrupt context file.', 500);
        }

        Response::success($payload['context'] ?? $payload);
    }

    /**
     * List all saved contexts, newest first, metadata only (no context payload).
     *
     * Response: [{ id, name, savedAt }]
     */
    public function listAll(Request $request): void
    {
        $this->ensureDir();

        $files = glob($this->dir . '/*.json') ?: [];
        $list  = [];

        foreach ($files as $file) {
            $payload = json_decode(file_get_contents($file), true);
            if (!is_array($payload) || !isset($payload['id'])) {
                continue; // skip corrupt files silently
            }
            $list[] = [
                'id'      => $payload['id'],
                'name'    => $payload['name']    ?? $payload['id'],
                'savedAt' => $payload['savedAt'] ?? '',
            ];
        }

        // Sort newest first (ISO strings sort lexicographically)
        usort($list, fn($a, $b) => strcmp($b['savedAt'], $a['savedAt']));

        Response::success(array_values($list));
    }

    /**
     * Delete a saved context by id.
     *
     * Request body: { id: string }
     * Response:     null
     */
    public function delete(Request $request): void
    {
        $id   = (string) $request->get('id', '');
        $file = $this->requireFile($id);

        unlink($file);
        Response::success(null, 'Context deleted.');
    }

    /**
     * Rename a saved context (updates the display name only; id/filename unchanged).
     *
     * Request body: { id: string, name: string }
     * Response:     { id, name, savedAt }
     */
    public function rename(Request $request): void
    {
        $id   = (string) $request->get('id', '');
        $name = trim((string) $request->get('name', ''));

        if ($name === '') {
            Response::error('Context name is required.', 400);
        }

        $file = $this->requireFile($id);
        $payload = json_decode(file_get_contents($file), true);
        if (!is_array($payload) || !isset($payload['id'])) {
            Response::error('Corrupt context file.', 500);
        }

        $payload['name'] = $name;
        file_put_contents(
            $file,
            json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE),
            LOCK_EX
        );

        Response::success([
            'id'      => $payload['id'],
            'name'    => $payload['name'],
            'savedAt' => $payload['savedAt'] ?? '',
        ], 'Context renamed.');
    }

    /**
     * Update an existing saved context (overwrite name and context payload).
     * Used when the user has loaded a context from the list and then saves from the top bar.
     *
     * Request body: { id: string, name: string, context: object }
     * Response:     { id, name, savedAt }
     */
    public function update(Request $request): void
    {
        $id      = (string) $request->get('id', '');
        $name    = trim((string) $request->get('name', ''));
        $context = $request->get('context');

        if ($name === '') {
            Response::error('Context name is required.', 400);
        }
        if (!is_array($context)) {
            Response::error('Context payload is required.', 400);
        }

        $file = $this->requireFile($id);
        $payload = json_decode(file_get_contents($file), true);
        if (!is_array($payload) || !isset($payload['id'])) {
            Response::error('Corrupt context file.', 500);
        }

        $payload['name']    = $name;
        $payload['context'] = $context;
        $payload['savedAt'] = (new \DateTimeImmutable())->format(\DateTimeInterface::ATOM);

        file_put_contents(
            $file,
            json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE),
            LOCK_EX
        );

        Response::success([
            'id'      => $payload['id'],
            'name'    => $payload['name'],
            'savedAt' => $payload['savedAt'],
        ], 'Context updated.');
    }

    // =========================================================================
    // Private helpers
    // =========================================================================

    /**
     * Resolve the file path for an id, rejecting any traversal characters.
     * Only word chars (\w) and hyphens are kept; everything else is stripped.
     */
    private function filePath(string $id): string
    {
        $safe = preg_replace('/[^\w\-]/', '', $id);
        return $this->dir . '/' . $safe . '.json';
    }

    /**
     * Resolve and validate that the file exists, or emit a 404.
     */
    private function requireFile(string $id): string
    {
        if ($id === '') {
            Response::error('Context id is required.', 400);
        }

        $file = $this->filePath($id);
        if (!file_exists($file)) {
            Response::error('Context not found.', 404);
        }

        return $file;
    }

    /**
     * Generate a URL-safe, filesystem-safe id from a human name.
     * Format: {slug-up-to-40-chars}_{6-char-unique-suffix}
     */
    private function makeId(string $name): string
    {
        $slug = preg_replace('/[^\w]+/', '-', strtolower($name));
        $slug = trim($slug, '-');
        $slug = $slug ?: 'context';
        return substr($slug, 0, 40) . '_' . substr(uniqid(), -6);
    }

    private function ensureDir(): void
    {
        if (!is_dir($this->dir)) {
            mkdir($this->dir, 0755, true);
        }
    }
}
