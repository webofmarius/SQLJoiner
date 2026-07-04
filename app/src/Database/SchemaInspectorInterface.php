<?php

declare(strict_types=1);

namespace Database;

use Core\Request;

interface SchemaInspectorInterface
{
    public function getDatabases(Request $request): void;
    public function getTables(Request $request): void;
    public function getColumns(Request $request): void;
    public function getCreateStatement(Request $request): void;
    public function getRowCounts(Request $request): void;
}
