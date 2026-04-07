#!/bin/bash
set -e

export PATH="/usr/local/bin:/usr/bin:$PATH"

# Navigate to project root regardless of where the script is called from
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== SQL Joiner — Linux Build (Docker) ==="

# Check Docker is available
if ! command -v docker &>/dev/null; then
    echo ""
    echo "Error: docker not found. Please install Docker Desktop from https://www.docker.com/products/docker-desktop"
    exit 1
fi

# Check Docker is running
if ! docker info &>/dev/null; then
    echo ""
    echo "Error: Docker is not running. Please start Docker Desktop and try again."
    exit 1
fi

# Build the Docker image if it doesn't exist
if ! docker image inspect sql-joiner-builder &>/dev/null; then
    echo ""
    echo "Docker image not found — building it now (this only happens once)..."
    docker build -t sql-joiner-builder -f docker/Dockerfile .
fi

echo ""
echo "Running build inside Docker container..."
docker run --rm \
    -v "$(pwd):/app" \
    sql-joiner-builder \
    bash docker/build.sh

echo ""
echo "=== Build complete! ==="
echo "Output: dist/*.AppImage"
