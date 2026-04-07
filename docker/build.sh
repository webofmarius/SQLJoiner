#!/bin/bash
set -e

echo "=== SQL Joiner — Linux Build ==="

# -------------------------------------------------------
# Step 1 — Bundle PHP
# -------------------------------------------------------
echo ""
echo "[1/3] Bundling PHP binary..."

mkdir -p php-bin/linux/libs

PHP_BIN=$(which php8.4)
cp "$PHP_BIN" php-bin/linux/php-bin

# Copy all non-system shared library dependencies
ldd "$PHP_BIN" | grep "=> /" | awk '{print $3}' | while read lib; do
    case "$lib" in
        /lib/x86_64-linux-gnu/libc.so*)      continue ;;
        /lib/x86_64-linux-gnu/libpthread*)   continue ;;
        /lib/x86_64-linux-gnu/libdl*)        continue ;;
        /lib/x86_64-linux-gnu/libm.so*)      continue ;;
        /lib64/ld-linux*)                    continue ;;
    esac
    cp -n "$lib" php-bin/linux/libs/ 2>/dev/null || true
done

# Tell the binary to look for libs next to itself
patchelf --set-rpath '$ORIGIN/libs' php-bin/linux/php-bin

# Create wrapper script (entry point called by Electron)
cat > php-bin/linux/php << 'EOF'
#!/bin/bash
DIR="$(dirname "$(readlink -f "$0")")"
export LD_LIBRARY_PATH="$DIR/libs:$LD_LIBRARY_PATH"
exec "$DIR/php-bin" "$@"
EOF

chmod +x php-bin/linux/php
chmod +x php-bin/linux/php-bin

# Verify
echo "PHP version check:"
php-bin/linux/php --version
echo "PDO check:"
php-bin/linux/php -m | grep -i pdo

# -------------------------------------------------------
# Step 2 — Install npm dependencies
# -------------------------------------------------------
echo ""
echo "[2/3] Installing npm dependencies..."
npm install

# -------------------------------------------------------
# Step 3 — Build AppImage
# -------------------------------------------------------
echo ""
echo "[3/3] Building AppImage..."
npm run build:linux

echo ""
echo "=== Build complete! ==="
echo "Output: dist/*.AppImage"
