<?php

declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

use Core\Request;
use Core\Response;

// Session is used to share the active MySQL connection ID with cancel_query.php
session_start();

// Always respond with JSON
header('Content-Type: application/json');

// CORS for local dev (safe to remove in production)
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$request = new Request();
$action  = $request->getAction();

if (empty($action)) {
    Response::error('No action specified.', 400);
}

/**
 * Route map: action string => [ClassName, methodName]
 *
 * Each handler class receives the Request object and is responsible
 * for calling Response::success() or Response::error() before returning.
 */
$routes = [
    // --- Profiles (Phase 2) ---
    'profile.list'   => ['Database\ProfileManager', 'list'],
    'profile.save'   => ['Database\ProfileManager', 'save'],
    'profile.delete' => ['Database\ProfileManager', 'delete'],
    'profile.test'   => ['Database\ProfileManager', 'test'],

    // --- Schema (Phase 3) ---
    'schema.databases'       => ['Database\SchemaInspector', 'getDatabases'],
    'schema.tables'          => ['Database\SchemaInspector', 'getTables'],
    'schema.columns'         => ['Database\SchemaInspector', 'getColumns'],
    'schema.createStatement' => ['Database\SchemaInspector', 'getCreateStatement'],
    'schema.rowCounts'       => ['Database\SchemaInspector', 'getRowCounts'],

    // --- Query (Phase 6) ---
    'query.execute'    => ['Query\QueryBuilder', 'execute'],
    'query.executeRaw' => ['Query\QueryBuilder', 'executeRaw'],
    'query.preview'    => ['Query\QueryBuilder', 'preview'],

    // --- Context (Phase 8) ---
    'context.save'   => ['Core\ContextManager', 'save'],
    'context.load'   => ['Core\ContextManager', 'load'],
    'context.list'   => ['Core\ContextManager', 'listAll'],
    'context.delete'    => ['Core\ContextManager', 'delete'],
    'context.rename'    => ['Core\ContextManager', 'rename'],
    'context.update'    => ['Core\ContextManager', 'update'],

    // --- About ---
    'about.read' => ['Core\AboutManager', 'read'],

    // --- Import SQL to canvas ---
    'query.parseFromSQL' => ['Query\QueryParser', 'parse'],
];

if (!isset($routes[$action])) {
    Response::error("Unknown action: {$action}", 404);
}

[$className, $methodName] = $routes[$action];

if (!class_exists($className)) {
    Response::error("Handler not implemented: {$className}", 501);
}

$handler = new $className();

if (!method_exists($handler, $methodName)) {
    Response::error("Method not implemented: {$className}::{$methodName}", 501);
}

try {
    $handler->{$methodName}($request);
} catch (\Throwable $e) {
    Response::error($e->getMessage(), 500);
}
