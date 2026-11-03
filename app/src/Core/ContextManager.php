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
 *   context.groups.get    groupsGet($request)    (no body)               → { groups, groupMap }
 *   context.groups.save   groupsSave($request)   { groups, groupMap }    → { groups, groupMap }
 *   context.groups.delete groupsDelete($request) { id }                  → { groups, groupMap }
 *     (deletes the group AND every context in it; disbanding is a client-side groups.save)
 *
 *   context.groups.export { id }                  → { filename, data(base64 zip) }  (one <name>.json per context)
 *   context.groups.import { name, data(base64) }  → { group, count }
 *     The zip is fully validated (flat *.json entries only, every one a valid context) BEFORE anything
 *     is read out of it; the uploaded temp copy is deleted afterwards. Nothing is extracted to disk.
 *
 * Groups live in storage/context_groups.json:
 *   { groups: [{ id, name, collapsed, favorite, color }], groupMap: { contextId: groupId }, colors: { contextId: '#rrggbb' } }
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

        Response::success($this->writeContext($name, $context), 'Context saved.');
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
    // Groups
    // =========================================================================

    public function groupsGet(Request $request): void
    {
        Response::success($this->readGroups());
    }

    /**
     * Replace the whole groups document (create / rename / disband / move are all client-side edits).
     *
     * Request body: { groups: [{ id, name, collapsed, favorite, color }], groupMap: { contextId: groupId }, colors: { contextId: '#rrggbb' } }
     */
    public function groupsSave(Request $request): void
    {
        $doc = $this->sanitiseGroups([
            'groups'   => $request->get('groups', []),
            'groupMap' => $request->get('groupMap', []),
            'colors'   => $request->get('colors', []),
        ]);
        $this->writeGroups($doc);
        Response::success($doc, 'Groups saved.');
    }

    /**
     * Delete a group together with all contexts assigned to it.
     *
     * Request body: { id: string }
     */
    public function groupsDelete(Request $request): void
    {
        $gid = preg_replace('/[^\w\-]/', '', (string) $request->get('id', ''));
        $doc = $this->readGroups();

        foreach ($doc['groupMap'] as $ctxId => $groupId) {
            if ($groupId !== $gid) {
                continue;
            }
            $file = $this->filePath((string) $ctxId);
            if (is_file($file)) {
                unlink($file);
            }
            unset($doc['groupMap'][$ctxId], $doc['colors'][$ctxId]);
        }
        $doc['groups'] = array_values(array_filter($doc['groups'], fn($g) => $g['id'] !== $gid));

        $this->writeGroups($doc);
        Response::success($doc, 'Group deleted.');
    }

    /**
     * Export every context of a group as <name>.json files inside one zip.
     *
     * Request body: { id: string }
     * Response:     { filename, data }   data = base64 zip
     */
    public function groupsExport(Request $request): void
    {
        $gid   = preg_replace('/[^\w\-]/', '', (string) $request->get('id', ''));
        $doc   = $this->readGroups();
        $group = null;
        foreach ($doc['groups'] as $g) {
            if ($g['id'] === $gid) { $group = $g; }
        }
        if ($group === null) {
            Response::error('Group not found.', 404);
        }
        if (!class_exists(\ZipArchive::class)) {
            Response::error('The PHP zip extension is not available.', 501);
        }

        $tmp = tempnam(sys_get_temp_dir(), 'ctxzip');
        try {
            $zip = new \ZipArchive();
            if ($zip->open($tmp, \ZipArchive::OVERWRITE) !== true) {
                Response::error('Could not create the zip file.', 500);
            }
            $used  = [];
            $count = 0;
            foreach ($doc['groupMap'] as $ctxId => $groupId) {
                if ($groupId !== $gid) { continue; }
                $file = $this->filePath((string) $ctxId);
                if (!is_file($file)) { continue; }
                $payload = json_decode((string) file_get_contents($file), true);
                if (!is_array($payload) || !is_array($payload['context'] ?? null)) { continue; }

                $base = trim((string) preg_replace('/[\x00-\x1f\x7f\\\\\/:*?"<>|]+/u', '_', (string) ($payload['name'] ?? $ctxId)), " ._");
                $base = $base !== '' ? mb_substr($base, 0, 120) : 'context';
                $name = $base;
                for ($n = 2; isset($used[mb_strtolower($name)]); $n++) { $name = $base . '_' . $n; }
                $used[mb_strtolower($name)] = true;

                $exported = $payload['context'];
                if (isset($doc['colors'][$ctxId])) { $exported['_color'] = $doc['colors'][$ctxId]; }
                $zip->addFromString($name . '.json', json_encode($exported, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
                $count++;
            }
            if ($count === 0) {
                $zip->close();
                Response::error('This group has no contexts to export.', 400);
            }
            if ($group['color'] !== '') {
                $zip->addFromString(self::ZIP_META, json_encode(['color' => $group['color']], JSON_PRETTY_PRINT));
            }
            $zip->close();

            $safe = trim((string) preg_replace('/[^\w\- ]+/u', '_', $group['name']), ' _') ?: 'group';
            Response::success(['filename' => $safe . '.zip', 'data' => base64_encode((string) file_get_contents($tmp))]);
        } finally {
            if (is_file($tmp)) { unlink($tmp); }
        }
    }

    /**
     * Import a zip of contexts as a new group. The archive is validated completely first;
     * if anything is wrong nothing is imported.
     *
     * Request body: { name: string (group name), data: string (base64 zip) }
     * Response:     { group: {id,name}, count }
     */
    public function groupsImport(Request $request): void
    {
        $name = trim((string) $request->get('name', ''));
        $raw  = base64_decode((string) $request->get('data', ''), true);
        if ($name === '') { $name = 'Imported group'; }
        if ($raw === false || $raw === '') {
            Response::error('No zip data received.', 400);
        }
        if (strlen($raw) > self::ZIP_MAX_BYTES) {
            Response::error('Zip file is too large.', 400);
        }
        if (!class_exists(\ZipArchive::class)) {
            Response::error('The PHP zip extension is not available.', 501);
        }

        $tmp = tempnam(sys_get_temp_dir(), 'ctxzip');
        try {
            file_put_contents($tmp, $raw);
            [$contexts, $meta] = $this->readValidatedZip($tmp); // contexts: [ [name, context], ... ] or error()
        } finally {
            if (is_file($tmp)) { unlink($tmp); } // uploaded copy is always removed
        }

        // Validation passed — only now write anything.
        $doc   = $this->readGroups();
        $names = array_map(fn($g) => mb_strtolower($g['name']), $doc['groups']);
        $final = $name;
        for ($n = 2; in_array(mb_strtolower($final), $names, true); $n++) { $final = $name . ' (' . $n . ')'; }

        $gid = 'g' . substr(md5(uniqid('', true)), 0, 12);
        $doc['groups'][] = ['id' => $gid, 'name' => $final, 'collapsed' => false, 'favorite' => false, 'color' => $this->cleanColor($meta['color'] ?? '')];
        foreach ($contexts as [$ctxName, $context]) {
            $color = $this->cleanColor($context['_color'] ?? '');
            unset($context['_color']);
            $saved = $this->writeContext($ctxName, $context);
            $doc['groupMap'][$saved['id']] = $gid;
            if ($color !== '') { $doc['colors'][$saved['id']] = $color; }
        }
        $this->writeGroups($doc);

        Response::success(['group' => ['id' => $gid, 'name' => $final], 'count' => count($contexts)], 'Group imported.');
    }

    private const ZIP_MAX_BYTES   = 6 * 1024 * 1024;    // uploaded archive
    private const ZIP_MAX_ENTRIES = 500;
    private const ZIP_META        = '_group.json';        // group metadata, not a context
    private const ZIP_MAX_ENTRY   = 10 * 1024 * 1024;   // one uncompressed context
    private const ZIP_MAX_TOTAL   = 50 * 1024 * 1024;   // all contexts uncompressed

    /**
     * Strictly validate a zip: flat, non-empty, only *.json files, sane sizes, each a context
     * (a JSON object with a "tables" array). Reads entries in memory only. Emits an error and
     * exits on the first problem.
     *
     * @return array{0: array<int, array{0:string,1:array}>, 1: array}  [[contextName, context], ...], group metadata
     */
    private function readValidatedZip(string $path): array
    {
        $zip = new \ZipArchive();
        if ($zip->open($path, \ZipArchive::CHECKCONS) !== true) {
            Response::error('Not a valid .zip file.', 400);
        }
        $count = $zip->numFiles;
        if ($count < 1) {
            Response::error('The zip is empty.', 400);
        }
        if ($count > self::ZIP_MAX_ENTRIES) {
            Response::error('The zip has too many files (max ' . self::ZIP_MAX_ENTRIES . ').', 400);
        }

        // Pass 1 — names and declared sizes only (nothing decompressed yet).
        $total = 0;
        $seen  = [];
        for ($i = 0; $i < $count; $i++) {
            $st = $zip->statIndex($i);
            $entry = $st['name'] ?? '';
            if ($entry === '' || str_ends_with($entry, '/')
                || preg_match('/[\x00-\x1f\x7f\\\\\/]/', $entry) || str_contains($entry, '..')) {
                Response::error("Rejected: \"{$entry}\" is not a plain file at the top level of the zip.", 400);
            }
            if (!preg_match('/\.json$/i', $entry) || strlen($entry) <= 5) {
                Response::error("Rejected: \"{$entry}\" is not a .json context file.", 400);
            }
            $key = mb_strtolower($entry);
            if (isset($seen[$key])) {
                Response::error("Rejected: duplicate entry \"{$entry}\".", 400);
            }
            $seen[$key] = true;
            $size = (int) ($st['size'] ?? 0);
            if ($size > self::ZIP_MAX_ENTRY) {
                Response::error("Rejected: \"{$entry}\" is too large.", 400);
            }
            $total += $size;
            if ($total > self::ZIP_MAX_TOTAL) {
                Response::error('Rejected: the zip expands to too much data.', 400);
            }
        }

        // Pass 2 — content: every entry must be a valid context (except the metadata entry).
        $out  = [];
        $meta = [];
        for ($i = 0; $i < $count; $i++) {
            $entry = $zip->getNameIndex($i);
            $body  = $zip->getFromIndex($i, self::ZIP_MAX_ENTRY + 1);
            if ($body === false || strlen($body) > self::ZIP_MAX_ENTRY) {
                Response::error("Rejected: could not read \"{$entry}\".", 400);
            }
            $ctx = json_decode($body, true);
            if (strtolower($entry) === self::ZIP_META) {
                if (is_array($ctx) && !array_is_list($ctx)) { $meta = $ctx; }
                continue;
            }
            if (!is_array($ctx) || array_is_list($ctx) || !isset($ctx['tables']) || !is_array($ctx['tables'])) {
                Response::error("Rejected: \"{$entry}\" is not a valid context (missing tables array).", 400);
            }
            $out[] = [substr($entry, 0, -5), $ctx];
        }
        $zip->close();
        if (!$out) {
            Response::error('The zip contains no contexts.', 400);
        }
        return [$out, $meta];
    }

    private function groupsPath(): string
    {
        return STORAGE_PATH . '/context_groups.json';
    }

    private function readGroups(): array
    {
        $raw = is_file($this->groupsPath()) ? json_decode((string) file_get_contents($this->groupsPath()), true) : null;
        return $this->sanitiseGroups(is_array($raw) ? $raw : []);
    }

    private function writeGroups(array $doc): void
    {
        $doc['groupMap'] = (object) $doc['groupMap']; // keep {} (not []) when empty
        $doc['colors']   = (object) $doc['colors'];
        file_put_contents(
            $this->groupsPath(),
            json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE),
            LOCK_EX
        );
    }

    /** '#rrggbb' (lower-cased) or '' when not a valid hex colour. */
    private function cleanColor(mixed $v): string
    {
        return is_string($v) && preg_match('/^#[0-9a-fA-F]{6}$/', $v) ? strtolower($v) : '';
    }

    /** Normalise to { groups: [{id,name,collapsed}], groupMap: {ctxId: existingGroupId} }. */
    private function sanitiseGroups(array $raw): array
    {
        $groups = [];
        $seen   = [];
        foreach (is_array($raw['groups'] ?? null) ? $raw['groups'] : [] as $g) {
            if (!is_array($g)) {
                continue;
            }
            $id   = preg_replace('/[^\w\-]/', '', (string) ($g['id'] ?? ''));
            $name = trim((string) ($g['name'] ?? ''));
            if ($id === '' || $name === '' || isset($seen[$id])) {
                continue;
            }
            $seen[$id] = true;
            $groups[]  = ['id' => $id, 'name' => $name, 'collapsed' => !empty($g['collapsed']), 'favorite' => !empty($g['favorite']), 'color' => $this->cleanColor($g['color'] ?? '')];
        }

        $map = [];
        foreach (is_array($raw['groupMap'] ?? null) ? $raw['groupMap'] : [] as $ctxId => $gid) {
            $ctxId = preg_replace('/[^\w\-]/', '', (string) $ctxId);
            if ($ctxId !== '' && is_string($gid) && isset($seen[$gid])) {
                $map[$ctxId] = $gid;
            }
        }

        $colors = [];
        foreach (is_array($raw['colors'] ?? null) ? $raw['colors'] : [] as $ctxId => $hex) {
            $ctxId = preg_replace('/[^\w\-]/', '', (string) $ctxId);
            $hex   = $this->cleanColor($hex);
            if ($ctxId !== '' && $hex !== '') {
                $colors[$ctxId] = $hex;
            }
        }

        return ['groups' => $groups, 'groupMap' => $map, 'colors' => $colors];
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

    /** Write a new context file; returns { id, name, savedAt }. */
    private function writeContext(string $name, array $context): array
    {
        $this->ensureDir();

        $id      = $this->makeId($name);
        $savedAt = (new \DateTimeImmutable())->format(\DateTimeInterface::ATOM);

        file_put_contents(
            $this->filePath($id),
            json_encode(['id' => $id, 'name' => $name, 'savedAt' => $savedAt, 'context' => $context], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE),
            LOCK_EX
        );

        return ['id' => $id, 'name' => $name, 'savedAt' => $savedAt];
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
