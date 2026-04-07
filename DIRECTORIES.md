# Directory Reference

Quick reference for the three non-app directories.

---

## `/scripts`

Shell/batch scripts for common developer tasks.

| Script | Platform | What it does |
|--------|----------|--------------|
| `scripts/build/build-mac.sh` | macOS | Checks for bundled PHP, then runs `npm run build:mac` → `dist/*.dmg` |
| `scripts/build/build-win.bat` | Windows | Checks for bundled PHP, then runs `npm run build:win` → `dist/*.exe` |
| `scripts/build/build-linux.sh` | macOS/Linux | Builds the Docker image (once) and runs the Linux build inside it → `dist/*.AppImage` |
| `scripts/server/server.sh` | macOS/Linux | Starts PHP's built-in dev server on port 90 pointing at `app/` |
| `scripts/server/server.bat` | Windows | Same as above, for Windows |

> For normal development you don't need these — just run `npm start`.
> Use the build scripts when packaging a release for distribution.

---

## `/electron`

Everything related to the Electron wrapper.

| Path | Purpose |
|------|---------|
| `electron/main.js` | Electron main process — starts the PHP sidecar, opens the Chromium window, handles clean shutdown |
| `electron/readme.md` | Full developer guide: architecture, dev setup, build steps, PHP bundling, licensing |
| `electron/docs/build/mac.md` | How to bundle the PHP binary for macOS |
| `electron/docs/build/win.md` | How to bundle the PHP binary for Windows |
| `electron/docs/build/linux.md` | How to bundle the PHP binary for Linux |
| `electron/docs/icon.md` | Icon preparation notes |

> Start here: `electron/readme.md`

---

## `/docker`

Used exclusively for building the Linux AppImage — not needed for macOS or Windows builds.

| File | Purpose |
|------|---------|
| `docker/Dockerfile` | Ubuntu 22.04 image with PHP 8.4, Node.js 24, and AppImage build dependencies |
| `docker/build.sh` | Runs *inside* the container — bundles the Linux PHP binary, installs npm deps, builds the AppImage |

You never call `docker/build.sh` directly. It is invoked automatically by `scripts/build/build-linux.sh`, which manages the Docker image and container lifecycle for you.
