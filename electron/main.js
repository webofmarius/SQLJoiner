const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

let phpProcess = null;
let mainWindow = null;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function getPhpBinary() {
  const isWin = process.platform === 'win32';
  if (app.isPackaged) {
    const phpExe = isWin ? 'php.exe' : 'php';
    const phpPath = path.join(process.resourcesPath, 'php-bin', phpExe);
    if (!require('fs').existsSync(phpPath)) {
      throw new Error(`PHP binary not found at expected path:\n${phpPath}\n\nresourcesPath: ${process.resourcesPath}`);
    }
    return phpPath;
  }
  return isWin ? 'php' : '/usr/local/bin/php';
}

function getAppRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app', 'app');
  }
  return path.join(__dirname, '..', 'app');
}

function startPhpServer(port) {
  return new Promise((resolve, reject) => {
    const phpBin = getPhpBinary();
    const appRoot = getAppRoot();

    phpProcess = spawn(phpBin, ['-S', `127.0.0.1:${port}`, '-t', appRoot], {
      cwd: appRoot,
      env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4' }
    });

    phpProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('started') || msg.includes('Listening')) {
        resolve(port);
      }
    });

    phpProcess.on('error', (err) => reject(err));

    // Fallback: resolve after 1.5s if no expected stderr message
    setTimeout(() => resolve(port), 1500);
  });
}

function getAppIcon() {
  if (process.platform === 'darwin') {
    return path.join(__dirname, '..', 'build', 'logo.icns');
  }
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app', 'app', 'assets', 'img', 'logo.png');
  }
  return path.join(__dirname, '..', 'app', 'assets', 'img', 'logo.png');
}

async function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'SQL Joiner',
    icon: getAppIcon(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/index.php`);

  // The web app uses beforeunload/e.preventDefault() to warn before closing a
  // browser tab. In Electron this blocks the window close entirely. We override
  // it here so the X button always works as expected in a native app.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    const port = await findFreePort();
    await startPhpServer(port);
    await createWindow(port);
  } catch (err) {
    dialog.showErrorBox('Startup Error', `Failed to start SQL Joiner:\n\n${err.message}`);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (phpProcess) {
    phpProcess.kill();
    phpProcess = null;
  }
  app.quit();
});

app.on('before-quit', () => {
  if (phpProcess) {
    phpProcess.kill();
    phpProcess = null;
  }
});
