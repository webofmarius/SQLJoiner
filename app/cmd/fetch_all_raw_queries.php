#!/usr/bin/env php
<?php
/**
 * fetch_all_raw_queries.php
 *
 * CLI tool — collects every "raw_query" value found inside .json files
 * located in a given directory, then prints them (one per line) and
 * optionally writes the result to an output file.
 *
 * Usage:
 *   php fetch_all_raw_queries.php <directory> [output_file]
 *
 *   <directory>   Required. Path to the directory containing .json files.
 *   [output_file] Optional. If provided, the result is also written to this file.
 */

// ── helpers ──────────────────────────────────────────────────────────────────

function usage(): void
{
    $script = basename(__FILE__);
    echo <<<HELP
Usage:
  php {$script} <directory> [output_file]

Arguments:
  <directory>    Path to the directory to scan for .json files (non-recursive).
  [output_file]  Optional path to a file where the output will also be saved.
                 The file is created if it does not exist, overwritten if it does.

Description:
  Scans <directory> for .json files, extracts the "raw_query" key from each
  valid JSON object, and prints all found queries — one per line — to STDOUT.
  Files that are not valid JSON or do not contain a "raw_query" key are skipped.

Examples:
  php {$script} ~/contexts
  php {$script} ~/contexts /tmp/queries.sql

HELP;
}

function abort(string $message, int $code = 1): never
{
    fwrite(STDERR, "Error: {$message}\n");
    exit($code);
}

// ── argument validation ───────────────────────────────────────────────────────

if ($argc < 2) {
    usage();
    exit(0);
}

$dirArg    = $argv[1];
$outputArg = $argv[2] ?? null;

// Resolve the directory
$dir = realpath($dirArg);
if ($dir === false || !is_dir($dir)) {
    abort("'{$dirArg}' is not a valid directory.");
}

// Validate the output file path (if provided)
if ($outputArg !== null) {
    // Allow a path to a not-yet-existing file, but its parent directory must exist
    $outputFile = $outputArg;
    $parentDir  = dirname($outputFile);
    if (!is_dir($parentDir)) {
        abort("Output directory '{$parentDir}' does not exist.");
    }
    if (is_dir($outputFile)) {
        abort("'{$outputFile}' is a directory, not a file.");
    }
}

// ── scan directory for .json files ───────────────────────────────────────────

$jsonFiles = glob($dir . DIRECTORY_SEPARATOR . '*.json');

if ($jsonFiles === false || count($jsonFiles) === 0) {
    fwrite(STDERR, "No .json files found in '{$dir}'.\n");
    exit(0);
}

// Sort files alphabetically for deterministic output
sort($jsonFiles);

// ── extract raw_query values ─────────────────────────────────────────────────

$lines = [];

foreach ($jsonFiles as $file) {
    $raw = @file_get_contents($file);
    if ($raw === false) {
        fwrite(STDERR, "Warning: Cannot read '{$file}', skipping.\n");
        continue;
    }

    $data = json_decode($raw, associative: true);
    if (!is_array($data)) {
        fwrite(STDERR, "Warning: '{$file}' is not a valid JSON object, skipping.\n");
        continue;
    }

    if (!array_key_exists('raw_query', $data)) {
        fwrite(STDERR, "Warning: '{$file}' has no 'raw_query' key, skipping.\n");
        continue;
    }

    $query = (string) $data['raw_query'];
    if ($query === '') {
        fwrite(STDERR, "Warning: '{$file}' has an empty 'raw_query', skipping.\n");
        continue;
    }

    $lines[] = $query;
}

if (count($lines) === 0) {
    fwrite(STDERR, "No 'raw_query' values found in any .json file.\n");
    exit(0);
}

// ── assemble output ───────────────────────────────────────────────────────────

$output = implode("\n", $lines) . "\n";

// Print to STDOUT
echo $output;

// Optionally write to file
if ($outputArg !== null) {
    $written = @file_put_contents($outputFile, $output);
    if ($written === false) {
        abort("Could not write to '{$outputFile}'.");
    }
    fwrite(STDERR, "Output also written to '{$outputFile}'.\n");
}

exit(0);
