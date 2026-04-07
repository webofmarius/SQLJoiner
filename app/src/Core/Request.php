<?php

declare(strict_types=1);

namespace Core;

/**
 * Wraps an incoming HTTP request.
 *
 * Reads JSON body from php://input (for fetch() POST calls)
 * and falls back to $_GET / $_POST for query string params.
 */
class Request
{
    private array $body;

    public function __construct()
    {
        $raw        = file_get_contents('php://input');
        $this->body = ($raw !== false && $raw !== '')
            ? (json_decode($raw, true) ?? [])
            : [];
    }

    /**
     * The "action" param can come from ?action=foo in the URL
     * or from the JSON body { "action": "foo" }.
     */
    public function getAction(): string
    {
        return $_GET['action'] ?? $this->body['action'] ?? '';
    }

    /**
     * Get a single value by key.
     * Priority: JSON body > $_GET > $_POST > $default
     */
    public function get(string $key, mixed $default = null): mixed
    {
        return $this->body[$key] ?? $_GET[$key] ?? $_POST[$key] ?? $default;
    }

    /**
     * Return the full decoded JSON body.
     */
    public function all(): array
    {
        return $this->body;
    }
}
