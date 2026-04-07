# Electron + PHP Sidecar Setup

## Overview

SQL Joiner is wrapped in Electron, which bundles a Chromium window with a PHP built-in server sidecar. The end result is a self-contained desktop application — no PHP, Node, or Electron installation required for the end user.

---

## How It Works

1. Electron launches and finds a free local port dynamically
2. PHP's built-in server starts on `127.0.0.1:<port>` pointing at the `app/` directory
3. Electron opens a Chromium window loading `http://127.0.0.1:<port>/index.php`
4. On app quit, the PHP process is killed cleanly

PHP runs with 4 workers (`PHP_CLI_SERVER_WORKERS=4`) for better request handling.

---

## Project Structure

```
sql_joiner/
├── app/                 # PHP application
│   ├── src/             # PHP backend classes
│   ├── assets/          # CSS / JS / HTML
│   ├── storage/         # Profiles and saved contexts (JSON)
│   ├── index.php        # Main entry point
│   ├── api.php          # API route dispatcher
│   ├── bootstrap.php    # PSR-4 autoloader and app constants
│   └── *.php            # Other entry points
├── docker/
│   ├── Dockerfile       # Ubuntu 22.04 build environment (Linux builds)
│   └── build.sh         # Linux build script (runs inside Docker)
├── electron/
│   ├── main.js          # Electron main process
│   └── docs/            # Build and setup documentation
├── php-bin/             # Bundled PHP binaries (not in git)
│   ├── mac/             # macOS binary + dylibs
│   ├── win/             # Windows binary + DLLs
│   └── linux/           # Linux binary + libs
├── scripts/
│   ├── build/           # Per-platform build scripts
│   └── server/          # PHP dev server scripts
└── package.json         # Electron + electron-builder config
```

---

## Prerequisites (Developer)

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 24.x+ | [nodejs.org](https://nodejs.org) or Homebrew |
| PHP | 8.4+ | Homebrew: `brew install php` |
| npm | bundled with Node | — |

End users need none of the above — everything is bundled in the distributed package.

---

## Developer Setup

```bash
# Install dependencies (first time only)
npm install

# Run in development
npm start
```

> **Note for macOS:** If `node` is not in your shell PATH (e.g. installed via Homebrew), prefix the command:
> ```bash
> PATH="/usr/local/bin:$PATH" npm start
> ```
> To fix this permanently, add the following to your `~/.zshrc`:
> ```bash
> export PATH="/usr/local/bin:$PATH"
> ```

---

## Building for Distribution

Use the build scripts in `scripts/build/`:

| Platform | Script |
|----------|--------|
| macOS | `./scripts/build/build-mac.sh` |
| Windows | `scripts\build\build-win.bat` |
| Linux | `./scripts/build/build-linux.sh` |

> Before distributing, a PHP binary must be bundled per platform. See [Bundling PHP](#bundling-php) below.

---

## Bundling PHP

For distribution, the PHP binary is embedded in the app package rather than relying on the system PHP.

`electron/main.js` resolves the PHP binary as follows:

```js
function getPhpBinary() {
  const isWin = process.platform === 'win32';
  if (app.isPackaged) {
    // Packaged app: use bundled binary
    const phpExe = isWin ? 'php.exe' : 'php';
    return path.join(process.resourcesPath, 'php-bin', phpExe);
  }
  // Development: use system PHP
  return isWin ? 'php' : '/usr/local/bin/php';
}

function getAppRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app', 'app');
  }
  return path.join(__dirname, '..', 'app');
}
```

For full instructions on bundling PHP per platform see:
- macOS: `electron/docs/build/mac.md`
- Windows: `electron/docs/build/win.md`
- Linux: `electron/docs/build/linux.md`

---

## Licensing

SQL Joiner is licensed under the **SQL Joiner License v1.0**, modelled after the PHP License v3.01 (BSD-style permissive).

- Free to use and distribute for any purpose, including commercially
- The name "SQL Joiner" must not be used to endorse or promote derivative products without prior written permission
- No warranty

Component licenses that are compatible with this model:

| Component | License | Notes |
|-----------|---------|-------|
| Electron | MIT | No restrictions on app licensing |
| PHP + PDO | PHP License v3.01 (BSD-style) | Can be bundled in proprietary software |
| SQL Joiner source | SQL Joiner License v1.0 (BSD-style) | Modelled after PHP License v3.01 |

---

## Performance Notes

| Factor | Impact |
|--------|--------|
| Electron/Chromium shell | ~150–300 MB RAM overhead, ~2–3s startup |
| PHP sidecar | Negligible — same engine and performance as native |
| SQL query execution | Unaffected — handled entirely by PDO/database driver |
| localhost HTTP round-trip | Sub-millisecond, not perceptible |

The bottleneck in SQL Joiner is always the database queries, not the Electron wrapper.
