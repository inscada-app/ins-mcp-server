/**
 * inSCADA Chat — Electron Main Process
 * Express server'ı gömülü çalıştırır, Settings yönetimi yapar
 */

const { app, BrowserWindow, Menu, ipcMain, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");

let mainWindow = null;
let settingsWindow = null;
let splashWindow = null;
let aboutWindow = null;
let appPort = null;

// ── Settings dosya yolu ──────────────────────────────────────────
function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  const p = getSettingsPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function saveSettings(settings) {
  const dir = path.dirname(getSettingsPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), "utf-8");
}

// ── Env'ye uygula ────────────────────────────────────────────────
const KEY_MAP = {
  anthropicApiKey: "ANTHROPIC_API_KEY",
  dbHost: "INSCADA_DB_HOST",
  dbPort: "INSCADA_DB_PORT",
  dbName: "INSCADA_DB_NAME",
  dbUser: "INSCADA_DB_USER",
  dbPassword: "INSCADA_DB_PASSWORD",
  influxHost: "INFLUX_HOST",
  influxPort: "INFLUX_PORT",
  influxDb: "INFLUX_DB",
  influxUser: "INFLUX_USER",
  influxPassword: "INFLUX_PASSWORD",
  influxUseSsl: "INFLUX_USE_SSL",
  inscadaApiUrl: "INSCADA_API_URL",
  inscadaUsername: "INSCADA_USERNAME",
  inscadaPassword: "INSCADA_PASSWORD",
};

function applySettings(settings) {
  for (const [jsonKey, envKey] of Object.entries(KEY_MAP)) {
    if (settings[jsonKey] !== undefined && settings[jsonKey] !== "") {
      process.env[envKey] = String(settings[jsonKey]);
    }
  }
}

// ── Boş port bul ────────────────────────────────────────────────
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// ── Window State Persistence ────────────────────────────────────
function getWindowStatePath() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function loadWindowState() {
  try {
    const p = getWindowStatePath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function saveWindowState() {
  if (!mainWindow) return;
  const state = {};
  state.isMaximized = mainWindow.isMaximized();
  if (!state.isMaximized) {
    const bounds = mainWindow.getBounds();
    state.x = bounds.x;
    state.y = bounds.y;
    state.width = bounds.width;
    state.height = bounds.height;
  }
  try {
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state, null, 2), "utf-8");
  } catch { /* ignore */ }
}

function getValidWindowBounds(saved) {
  if (!saved) return { width: 1200, height: 800 };
  const displays = screen.getAllDisplays();
  const inBounds = displays.some((d) => {
    const b = d.bounds;
    return saved.x >= b.x - 100 && saved.y >= b.y - 100 &&
           saved.x < b.x + b.width && saved.y < b.y + b.height;
  });
  if (!inBounds) return { width: saved.width || 1200, height: saved.height || 800 };
  return saved;
}

// ── Pencereler ──────────────────────────────────────────────────
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 360,
    height: 260,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    center: true,
    skipTaskbar: true,
    icon: path.join(__dirname, "assets", "icon.ico"),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile("splash.html");
  splashWindow.on("closed", () => { splashWindow = null; });
}

function createMainWindow() {
  const saved = loadWindowState();
  const bounds = getValidWindowBounds(saved);

  mainWindow = new BrowserWindow({
    width: bounds.width || 1200,
    height: bounds.height || 800,
    x: bounds.x,
    y: bounds.y,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    icon: path.join(__dirname, "assets", "icon.ico"),
    title: "inSCADA Chat",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${appPort}`);

  mainWindow.once("ready-to-show", () => {
    if (saved && saved.isMaximized) mainWindow.maximize();
    mainWindow.show();
    if (splashWindow) {
      splashWindow.close();
      splashWindow = null;
    }
  });

  // Save state on resize/move/close
  mainWindow.on("resize", saveWindowState);
  mainWindow.on("move", saveWindowState);
  mainWindow.on("close", saveWindowState);
  mainWindow.on("closed", () => { mainWindow = null; });
}

function createSettingsWindow(isFirstRun = false) {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 560,
    height: 720,
    resizable: true,
    minimizable: false,
    icon: path.join(__dirname, "assets", "icon.ico"),
    title: "inSCADA Chat — Ayarlar",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile("settings.html");

  settingsWindow.on("closed", () => {
    settingsWindow = null;
    // İlk çalıştırmada settings kapanırsa ve main yok → çık
    if (isFirstRun && !mainWindow) app.quit();
  });
}

function createAboutWindow() {
  if (aboutWindow) {
    aboutWindow.focus();
    return;
  }

  aboutWindow = new BrowserWindow({
    width: 340,
    height: 320,
    resizable: false,
    minimizable: false,
    maximizable: false,
    frame: false,
    parent: mainWindow || undefined,
    modal: !!mainWindow,
    icon: path.join(__dirname, "assets", "icon.ico"),
    title: "Hakkında",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  aboutWindow.setMenuBarVisibility(false);
  aboutWindow.loadFile("about.html");
  aboutWindow.on("closed", () => { aboutWindow = null; });
}

// ── Menü ────────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        { label: "Settings", click: () => createSettingsWindow(false) },
        { type: "separator" },
        { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => mainWindow?.webContents.reload() },
        { label: "Developer Tools", accelerator: "F12", click: () => mainWindow?.webContents.toggleDevTools() },
        { type: "separator" },
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", role: "zoomIn" },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", role: "zoomOut" },
        { label: "Reset Zoom", accelerator: "CmdOrCtrl+0", role: "resetZoom" },
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "About", click: () => createAboutWindow() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC: Settings ───────────────────────────────────────────────
ipcMain.handle("get-settings", () => {
  return loadSettings() || {};
});

ipcMain.handle("save-settings", async (_event, settings) => {
  saveSettings(settings);
  return { success: true };
});

ipcMain.handle("first-run-start", async (_event, settings) => {
  saveSettings(settings);
  applySettings(settings);
  if (settingsWindow) {
    settingsWindow.close();
    settingsWindow = null;
  }
  createSplashWindow();
  await startServer();
  createMainWindow();
  buildMenu();
  return { success: true };
});

ipcMain.handle("request-relaunch", () => {
  app.relaunch();
  app.exit(0);
});

// ── IPC: Window controls ────────────────────────────────────────
ipcMain.on("window-minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.on("window-maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.isMaximized() ? win.unmaximize() : win.maximize();
  }
});

ipcMain.on("window-close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.handle("window-is-maximized", (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() || false;
});

// ── IPC: About info ─────────────────────────────────────────────
ipcMain.handle("get-app-info", () => {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
  };
});

ipcMain.on("close-about", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.on("open-settings", () => {
  createSettingsWindow(false);
});

ipcMain.on("open-about", () => {
  createAboutWindow();
});

// ── IPC: Test connections ───────────────────────────────────────
ipcMain.handle("test-postgres", async (_event, config) => {
  try {
    const { Pool } = require("pg");
    const pool = new Pool({
      host: config.host || "localhost",
      port: parseInt(config.port) || 5432,
      database: config.database || "inscada",
      user: config.user || "postgres",
      password: config.password || "",
      connectionTimeoutMillis: 5000,
    });
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    await pool.end();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("test-influx", async (_event, config) => {
  return new Promise((resolve) => {
    const protocol = config.useSsl ? require("https") : http;
    const url = `${config.useSsl ? "https" : "http"}://${config.host || "localhost"}:${config.port || 8086}/ping`;
    const req = protocol.get(url, { timeout: 5000 }, (res) => {
      resolve({ success: res.statusCode === 204 || res.statusCode === 200 });
      res.resume();
    });
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ success: false, error: "Timeout" }); });
  });
});

ipcMain.handle("test-inscada-api", async (_event, config) => {
  return new Promise((resolve) => {
    const url = config.url || "http://localhost:8081";
    const req = http.get(url, { timeout: 5000 }, (res) => {
      resolve({ success: res.statusCode < 500 });
      res.resume();
    });
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ success: false, error: "Timeout" }); });
  });
});

// ── Express sunucuyu başlat ─────────────────────────────────────
async function startServer() {
  appPort = await findFreePort();
  process.env.PORT = String(appPort);
  require("./server");
  // server.js listen() asenkron — kısa bekle
  await new Promise((resolve) => setTimeout(resolve, 500));
}

// ── Uygulama başlat ─────────────────────────────────────────────
async function startApp() {
  const settings = loadSettings();

  if (!settings) {
    // İlk çalıştırma — settings penceresi aç
    createSettingsWindow(true);
    return;
  }

  // Settings mevcut — splash göster, sunucuyu başlat
  createSplashWindow();
  applySettings(settings);
  await startServer();
  createMainWindow();
  buildMenu();
}

app.whenReady().then(startApp);

app.on("window-all-closed", () => {
  app.quit();
});
