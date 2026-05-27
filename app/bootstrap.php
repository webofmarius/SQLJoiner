<?php

declare(strict_types=1);

define('APP_NAME',     'SQL Joiner');
define('APP_VERSION',  '1.64.1');
define('BASE_PATH',    __DIR__);
define('SRC_PATH',     BASE_PATH . '/src');
define('STORAGE_PATH', BASE_PATH . '/storage');
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
