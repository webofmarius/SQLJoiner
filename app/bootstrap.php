<?php

declare(strict_types=1);

define('APP_NAME',     'SQL Joiner');
define('APP_VERSION',  '1.124.0');
define('BASE_PATH',    __DIR__);
define('SRC_PATH',     BASE_PATH . '/src');
define('STORAGE_PATH', BASE_PATH . '/storage');

/**
 * Request guard for the whole app (every entry point includes this file).
 *
 * The API can run arbitrary SQL against saved connection profiles, so a web page
 * on any other origin must not be able to drive it from the user's browser:
 *  - cross-origin requests (CSRF / permissive CORS) are rejected via Origin / Sec-Fetch-Site;
 *  - when the server is bound to loopback, the Host header must be a loopback name,
 *    which blocks DNS-rebinding attacks.
 */
(function (): void {
    if (PHP_SAPI === 'cli') return;

    $deny = static function (string $msg): void {
        http_response_code(403);
        header('Content-Type: application/json');
        echo json_encode(['success' => false, 'message' => $msg]);
        exit;
    };

    $hostHeader = strtolower((string) ($_SERVER['HTTP_HOST'] ?? ''));
    $hostName   = preg_match('/^(\[[^\]]+\]|[^:]+)/', $hostHeader, $m) ? $m[1] : '';

    // php -S leaves SERVER_ADDR unset; SERVER_NAME is the bind address there.
    $serverAddr = (string) ($_SERVER['SERVER_ADDR'] ?? $_SERVER['SERVER_NAME'] ?? '');
    if (in_array($serverAddr, ['127.0.0.1', '::1', '[::1]'], true)
        && !in_array($hostName, ['127.0.0.1', 'localhost', '[::1]'], true)) {
        $deny('Forbidden host.');
    }

    $origin = $_SERVER['HTTP_ORIGIN'] ?? null;
    if ($origin !== null && $origin !== '') {
        $originHost = strtolower((string) parse_url($origin, PHP_URL_HOST) . (($p = parse_url($origin, PHP_URL_PORT)) ? ':' . $p : ''));
        $originHost = str_replace(['[', ']'], '', $originHost);
        if ($originHost !== str_replace(['[', ']'], '', $hostHeader)) {
            $deny('Cross-origin requests are not allowed.');
        }
    }

    $site = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? '';
    if ($site !== '' && !in_array($site, ['same-origin', 'none'], true)) {
        $deny('Cross-origin requests are not allowed.');
    }
})();
/**
 * Vanilla PSR-4 style autoloader.
 * Maps namespace segments directly to src/ subdirectories.
 *
 * Examples:
 *   Core\Request        -> src/Core/Request.php
 *   Database\Connection -> src/Database/Connection.php
 *   Query\QueryBuilder  -> src/Query/QueryBuilder.php
 */
spl_autoload_register(function (string $class): void {
    $file = SRC_PATH . '/' . str_replace('\\', '/', $class) . '.php';
    if (file_exists($file)) {
        require_once $file;
    }
});
