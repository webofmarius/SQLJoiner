# Building SQL Joiner for Windows

## Prerequisites

| Tool | Version | Download |
|------|---------|----------|
| Node.js | 24.x+ | https://nodejs.org/en/download (Windows Installer `.msi`) |
| PHP 8.4 NTS x64 | zip package | https://windows.php.net/download |

---

## 1. Install Node.js

- Download and run the `.msi` installer from https://nodejs.org
- The installer adds Node and npm to PATH automatically
- Verify in Command Prompt:
  ```cmd
  node --version
  npm --version
  ```

---

## 2. Make PHP Portable

On Windows, PHP's zip package already includes all required `.dll` files alongside `php.exe` — no extra bundling tool needed. You just copy the right files.

**Download:**
- Go to https://windows.php.net/download
- Download **PHP 8.4 — Non Thread Safe — x64** (the `.zip` file)
- Extract the zip

**Copy into the project:**

From the extracted zip, copy the following into `php-bin/win/` in the project root:

| What to copy | Why |
|---|---|
| `php.exe` | The PHP binary |
| All `.dll` files in the root folder | Runtime dependencies (OpenSSL, libssh2, etc.) |
| The entire `ext/` folder | PHP extension DLLs |

Your `php-bin/win/` should look like this:
```
php-bin/win/
├── php.exe
├── libcrypto-3-x64.dll
├── libssl-3-x64.dll
├── libssh2.dll
├── ... (other .dll files)
├── ext/
│   ├── php_pdo_mysql.dll
│   ├── php_pdo_sqlite.dll
│   └── ... (other extension DLLs)
└── php.ini               ← you create this (see below)
```

**Create `php-bin/win/php.ini`:**
```ini
extension_dir = "ext"
extension=pdo_mysql
extension=pdo_sqlite
```

**Verify it works** — open Command Prompt in the project root:
```cmd
php-bin\win\php.exe --version
php-bin\win\php.exe -m | findstr /i pdo
```

---

## 3. Install Project Dependencies

Open Command Prompt in the project root:
```cmd
npm install
```

---

## 4. App Icon (optional)

Place `build\icon.ico` (256x256 minimum) at the project root `build\` folder.

You can convert a PNG to `.ico` using:
- **ImageMagick** (if installed): `magick icon.png -resize 256x256 icon.ico`
- **Online converter**: https://convertio.co/png-ico

---

## 5. Test in Development First

```cmd
npm start
```

Make sure the app launches correctly before building the installer.

---

## 6. Build the Windows Installer

```cmd
scripts\build\build-win.bat
```

Or directly via npm:
```cmd
npm run build:win
```

Output: `dist\SQL Joiner Setup x.x.x.exe`

This produces a standard NSIS installer — the end user runs it, chooses an install directory, and gets a Start Menu shortcut and uninstaller.

---

## Notes

- `php-bin/` is excluded from git (see `.gitignore`) — the PHP files must be copied manually on each machine used for building
- Build must be performed on Windows — cross-compiling for Windows from macOS requires Wine (`brew install --cask wine-stable`) and is less reliable
- The NTS (Non Thread Safe) build is correct for `php -S` (built-in server). Do not use the TS build.
