<?php

declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

use Database\Connection;
use Database\ProfileManager;

header('Content-Type: application/json');

// Read the session in read-and-close mode so we don't block the running query
// (which already called session_write_close() before executing SQL).
session_start(['read_and_close' => true]);

$connId = $_SESSION['active_query_conn_id'] ?? null;

if ($connId === null) {
    echo json_encode(['success' => false, 'message' => 'No active query found.']);
    exit;
}

$body      = json_decode((string) file_get_contents('php://input'), true) ?? [];
$profileId = (string) ($body['profileId'] ?? '');

if ($profileId === '') {
    echo json_encode(['success' => false, 'message' => 'profileId is required.']);
    exit;
}

$pm      = new ProfileManager();
$profile = $pm->getProfileById($profileId);

if ($profile === null) {
    echo json_encode(['success' => false, 'message' => 'Profile not found.']);
    exit;
}

try {
    // Open a separate connection — the original one is busy executing the query.
    $pdo = (new Connection($profile))->getPdo();
    $pdo->exec('KILL QUERY ' . (int) $connId);
    echo json_encode(['success' => true]);
} catch (\PDOException $e) {
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}
