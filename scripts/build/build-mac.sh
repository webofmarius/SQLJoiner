#!/bin/bash
set -e

export PATH="/usr/local/bin:$PATH"

# Navigate to project root regardless of where the script is called from
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== SQL Joiner — macOS Build ==="

# Check PHP binary is bundled
if [ ! -f "php-bin/mac/php" ]; then
    echo ""
    echo "Error: php-bin/mac/php not found."
    echo "Please bundle PHP first. See electron/docs/build/mac.md for instructions."
    exit 1
fi

# Check npm is available
if ! command -v npm &>/dev/null; then
    echo ""
    echo "Error: npm not found. Please install Node.js from https://nodejs.org"
    exit 1
fi

echo ""
echo "Building..."
npm install dmg-license --save-optional
npm run build:mac

echo ""
echo "=== Build complete! ==="
echo "Output: dist/*.dmg"
