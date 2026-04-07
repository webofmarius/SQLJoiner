# Building SQL Joiner for macOS

## Prerequisites

| Tool | Version | Download |
|------|---------|----------|
| Node.js | 24.x+ | https://nodejs.org |
| npm | bundled with Node | — |
| Homebrew | latest | https://brew.sh |
| PHP 8.4 | via Homebrew | `brew install php` |
| dylibbundler | via Homebrew | `brew install dylibbundler` |

---

## 1. Install Dependencies

```bash
npm install
```

> If `node` is not in your PATH (common with Homebrew installs), prefix commands with:
> ```bash
> PATH="/usr/local/bin:$PATH" npm install
> ```
> To fix permanently, add `export PATH="/usr/local/bin:$PATH"` to your `~/.zshrc`.

---

## 2. Bundle the PHP Binary

This only needs to be done once, or when PHP is updated.

```bash
# Create the php-bin/mac directory
mkdir -p php-bin/mac

# Copy the Homebrew PHP binary
cp /usr/local/bin/php php-bin/mac/php

# Bundle all Homebrew dylib dependencies alongside the binary
# -i /usr/lib tells dylibbundler to ignore macOS system libs (already on every Mac)
/usr/local/bin/dylibbundler -od -b \
  -x php-bin/mac/php \
  -d php-bin/mac/libs \
  -p @executable_path/libs/ \
  -i /usr/lib

# Verify
php-bin/mac/php --version
php-bin/mac/php -m | grep -i pdo
```

The result is `php-bin/mac/php` (binary) + `php-bin/mac/libs/` (all dylib dependencies). The binary is fully self-contained — no Homebrew required on the end user's machine.

---

## 3. App Icon (optional)

Place the following in the `build/` folder at the project root:

| File | Size |
|------|------|
| `build/icon.icns` | generated from 1024x1024 PNG (see below) |

**Generating `icon.icns` from a PNG:**

```bash
mkdir icon.iconset
sips -z 16 16     icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon.png --out icon.iconset/icon_512x512.png
sips -z 1024 1024 icon.png --out icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset
mv icon.icns build/icon.icns
rm -rf icon.iconset
```

---

## 4. Build

```bash
./scripts/build/build-mac.sh
```

Or directly via npm:
```bash
npm run build:mac
```

Output: `dist/SQL Joiner-x.x.x.dmg`

---

## Notes

- The `.dmg` contains the app and a shortcut to `/Applications` — standard macOS distribution format
- `php-bin/` is excluded from git (see `.gitignore`) — the bundling step must be run on each developer machine
- Build must be performed on macOS — cross-compiling for macOS from other platforms is not supported by electron-builder
