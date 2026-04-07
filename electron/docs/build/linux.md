# Building SQL Joiner for Linux

The Linux build uses Docker to provide a consistent Ubuntu 22.04 build environment. This avoids having to set up a Linux VM or install Linux-specific tools on your Mac. The AppImage output lands directly in your Mac's `dist/` folder.

---

## Prerequisites

| Tool | Download |
|------|----------|
| Docker Desktop | https://www.docker.com/products/docker-desktop |

That's it. Everything else (Node.js, PHP 8.4, patchelf) runs inside the container.

---

## Project Files

| File | Purpose |
|------|---------|
| `docker/Dockerfile` | Defines the Ubuntu 22.04 build environment |
| `docker/build.sh` | Runs inside the container — bundles PHP, installs deps, builds AppImage |

---

## First Time Setup — Build the Docker Image

This only needs to be done once, or when the Dockerfile changes:

```bash
docker build -t sql-joiner-builder -f docker/Dockerfile .
```

This creates a local Docker image (~940MB) with Ubuntu 22.04, Node.js 24, PHP 8.4, and patchelf pre-installed.

---

## Building the AppImage

Run this from the project root every time you want to build:

```bash
./scripts/build/build-linux.sh
```

Or manually via Docker:
```bash
docker run --rm \
  -v "$(pwd):/app" \
  sql-joiner-builder \
  bash docker/build.sh
```

The build script does three things automatically:

1. **Bundles PHP** — copies PHP 8.4 binary + all shared library dependencies into `php-bin/linux/`, patches the binary with `patchelf`, and creates a wrapper script as the entry point
2. **Installs npm dependencies** — runs `npm install` inside the container
3. **Builds the AppImage** — runs `npm run build:linux` via electron-builder

Output: `dist/SQL Joiner-x.x.x.AppImage`

---

## What the PHP Bundling Does

On Linux, PHP links against shared system libraries that may not exist on the end user's machine. The build script makes it portable by:

- Copying all non-system `.so` dependencies into `php-bin/linux/libs/`
- Using `patchelf --set-rpath '$ORIGIN/libs'` to tell the binary to look for libs next to itself
- Creating a wrapper script `php-bin/linux/php` that sets `LD_LIBRARY_PATH` before launching PHP

The result is a fully self-contained PHP binary that works on any modern Linux distro.

---

## App Icon (optional)

Place a `512x512` PNG at `build/icon.png` in the project root before building.

---

## Distributing the AppImage

AppImage runs on any modern Linux distro without installation:

```bash
chmod +x "SQL Joiner-1.0.0.AppImage"
./"SQL Joiner-1.0.0.AppImage"
```

End users can optionally integrate it with their desktop environment using **AppImageLauncher**:
https://github.com/TheAssassin/AppImageLauncher

---

## Notes

- `php-bin/` is excluded from git — it is generated fresh inside the container on each build
- `node_modules/` is also excluded from git — npm install runs inside the container
- The build must be run from the project root so the volume mount works correctly
- If Docker is not in your PATH, prefix commands with `PATH="/usr/local/bin:/usr/bin:$PATH"`
