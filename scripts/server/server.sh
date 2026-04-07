#!/bin/bash

export PATH="/usr/local/bin:$PATH"

SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
APP_DIR="$(cd "$SCRIPT_DIR/../../app" && pwd)"

php -S 0.0.0.0:90 -t "$APP_DIR"
