/**
 * inSCADA AI Asistan — Electron Main Process
 * Express server'ı gömülü çalıştırır, Settings yönetimi yapar
 */

const { app, BrowserWindow, Menu, ipcMain, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");
const https = require("https");
// openai client — lazy load (test-gemini IPC handler'da kullanılır)

let mainWindow = null;
let settingsWindow = null;
let licenseWindow = null;
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

// ── Lisans yönetimi (License4J SaaS entegrasyonu) ───────────────
const L4J_BASE_URL = process.env.L4J_BASE_URL || "https://cloud.license4j.com";
// License4J ürün API key — build öncesi buraya yazılır
// License4J paneli: Automation > Integrations > API Key
const L4J_API_KEY = process.env.L4J_API_KEY || "ymsqTFZx1nWsh3jKPeene7t9OvXmeAZNEE81WwTS";
const LICENSE_CACHE_TTL = 24 * 60 * 60 * 1000;       // 24 saat — normal revalidation
const LICENSE_GRACE_PERIOD = 7 * 24 * 60 * 60 * 1000; // 7 gün — offline grace period

function loadLicense() {
  const settings = loadSettings();
  return settings?.licenseKey || null;
}

function loadLicenseCache() {
  const settings = loadSettings();
  return settings?.licenseCache || null;
}

function saveLicense(licenseKey, cache) {
  const settings = loadSettings() || {};
  settings.licenseKey = licenseKey;
  if (cache) settings.licenseCache = cache;
  saveSettings(settings);
}

function saveLicenseCache(cache) {
  const settings = loadSettings() || {};
  settings.licenseCache = cache;
  saveSettings(settings);
}

function removeLicenseKey() {
  const settings = loadSettings() || {};
  delete settings.licenseKey;
  delete settings.licenseCache;
  saveSettings(settings);
}

/**
 * Format doğrulama — License4J key formatı: XXXXX-XXXXX-XXXXX-XXXXX (esnek)
 */
function validateLicenseFormat(key) {
  if (!key || typeof key !== "string") return { valid: false, error: "Lisans anahtarı gerekli." };
  const normalized = key.trim();
  // License4J genellikle 5x5 veya 5x4 gruplar üretir, esnek tutalım
  if (normalized.length < 10) {
    return { valid: false, error: "Lisans anahtarı çok kısa." };
  }
  return { valid: true, key: normalized };
}

/**
 * License4J REST API — GET /v5/api/license?licensekey=XXX
 * Lisans key ile License4J sunucusunu sorgular
 * Başarılı response: JSON array [ { id, licensekey, licensetype, dateExpires, ... } ]
 */
function queryLicense4J(key) {
  return new Promise((resolve) => {
    const https = require("https");
    const encodedKey = encodeURIComponent(key);
    const urlPath = `/v5/api/license?licensekey=${encodedKey}`;

    const req = https.request({
      hostname: new URL(L4J_BASE_URL).hostname,
      port: 443,
      path: urlPath,
      method: "GET",
      timeout: 15000,
      headers: {
        "X-API-KEY": L4J_API_KEY,
        "Accept": "application/json",
      },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          // License4J 404 veya boş dizi → key bulunamadı
          if (res.statusCode === 404) {
            resolve({ found: false, error: "Lisans anahtarı bulunamadı." });
            return;
          }
          if (res.statusCode === 401 || res.statusCode === 403) {
            resolve({ found: false, error: "Lisans sunucusu yetkilendirme hatası." });
            return;
          }
          const data = JSON.parse(body);
          // License4J GET response: array veya tek obje
          const licenses = Array.isArray(data) ? data : [data];
          if (licenses.length === 0) {
            resolve({ found: false, error: "Lisans anahtarı bulunamadı." });
            return;
          }
          resolve({ found: true, license: licenses[0], statusCode: res.statusCode });
        } catch {
          resolve({ found: false, error: "Sunucu yanıtı okunamadı." });
        }
      });
    });

    req.on("error", () => {
      resolve({ found: false, error: "Lisans sunucusuna ulaşılamadı.", offline: true });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ found: false, error: "Lisans sunucusu zaman aşımı.", offline: true });
    });

    req.end();
  });
}

/**
 * Lisans doğrulama — License4J ile online, offline ise cache/grace
 */
async function validateLicense(key) {
  // 1) Format kontrolü
  const fmt = validateLicenseFormat(key);
  if (!fmt.valid) return fmt;

  // 2) License4J online doğrulama
  const result = await queryLicense4J(fmt.key);

  if (result.found) {
    const lic = result.license;

    // Süresi dolmuş mu kontrol et
    if (lic.dateExpires) {
      const expires = new Date(lic.dateExpires);
      if (expires < new Date()) {
        return { valid: false, error: `Lisans süresi dolmuş (${expires.toLocaleDateString("tr-TR")}).` };
      }
    }

    // Cache oluştur
    const cache = {
      validatedAt: Date.now(),
      expiresAt: lic.dateExpires || null,
      plan: lic.licensetype || "standard",
      fullname: lic.fullname || null,
      email: lic.email || null,
      features: lic.features || null,
    };

    console.log(`[License] License4J doğrulandı — tür: ${lic.licensetype}, kullanıcı: ${lic.fullname || "N/A"}`);
    return { valid: true, key: fmt.key, cache, fromServer: true };
  }

  // 3) Offline ise — mevcut cache'e bak (grace period)
  if (result.offline) {
    const cache = loadLicenseCache();
    if (cache && cache.validatedAt) {
      const age = Date.now() - cache.validatedAt;
      if (age < LICENSE_GRACE_PERIOD) {
        console.log(`[License] Offline — grace period (${Math.round(age / 3600000)}h / ${Math.round(LICENSE_GRACE_PERIOD / 3600000)}h)`);
        return { valid: true, key: fmt.key, cache, fromCache: true };
      }
      return { valid: false, error: "Çevrimdışı süre aşıldı (7 gün). Lütfen internete bağlanıp tekrar deneyin." };
    }
    return { valid: false, error: "İlk doğrulama için internet bağlantısı gerekli." };
  }

  // 4) Online erişildi ama key bulunamadı/hata
  return { valid: false, error: result.error || "Geçersiz lisans anahtarı." };
}

/**
 * License4J features string'inden key=value parse et
 * Format: "Mode=Basic\nDay=365\nAPI_KEY=sk-ant-..."
 */
function parseLicenseFeatures(featuresStr) {
  if (!featuresStr) return {};
  const map = {};
  for (const line of featuresStr.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      map[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
    }
  }
  return map;
}

/**
 * License features'dan ek bilgi çek (API key artık settings'ten girilir)
 */
function applyLicenseApiKey() {
  // API key artık lisanstan alınmıyor, kullanıcı settings'ten girer
  return false;
}

/**
 * Cache taze mi kontrol et (startApp için hızlı kontrol)
 */
function isLicenseCacheValid() {
  const cache = loadLicenseCache();
  if (!cache || !cache.validatedAt) return false;
  const age = Date.now() - cache.validatedAt;
  return age < LICENSE_GRACE_PERIOD;
}

// ── Env'ye uygula ────────────────────────────────────────────────
const KEY_MAP = {
  llmProvider: "LLM_PROVIDER",
  ollamaBaseUrl: "OLLAMA_BASE_URL",
  ollamaModel: "OLLAMA_MODEL",
  anthropicApiKey: "ANTHROPIC_API_KEY",
  geminiApiKey: "GEMINI_API_KEY",
  geminiBaseUrl: "GEMINI_BASE_URL",
  geminiModel: "GEMINI_MODEL",
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
    title: "inSCADA AI Asistan",
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

function createLicenseWindow() {
  if (licenseWindow) {
    licenseWindow.focus();
    return;
  }

  licenseWindow = new BrowserWindow({
    width: 480,
    height: 520,
    resizable: false,
    minimizable: false,
    icon: path.join(__dirname, "assets", "icon.ico"),
    title: "inSCADA AI Asistan — Lisans",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  licenseWindow.setMenuBarVisibility(false);
  licenseWindow.loadFile("license.html");

  licenseWindow.on("closed", () => {
    licenseWindow = null;
    // Lisans penceresi kapanırsa ve ana pencere yoksa → çık
    if (!mainWindow && !settingsWindow) app.quit();
  });
}

function createSettingsWindow(isFirstRun = false) {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 520,
    height: 740,
    resizable: true,
    minimizable: false,
    icon: path.join(__dirname, "assets", "icon.ico"),
    title: "inSCADA AI Asistan — Ayarlar",
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
    height: 350,
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
  const existing = loadSettings() || {};
  saveSettings({ ...existing, ...settings });
  return { success: true };
});

ipcMain.handle("first-run-start", async (_event, settings) => {
  const existing = loadSettings() || {};
  const merged = { ...existing, ...settings };
  saveSettings(merged);
  applySettings(merged);
  createSplashWindow();
  await startServer();
  createMainWindow();
  buildMenu();
  if (settingsWindow) {
    settingsWindow.close();
    settingsWindow = null;
  }
  return { success: true };
});

ipcMain.handle("request-relaunch", () => {
  app.relaunch();
  app.exit(0);
});

// ── IPC: License ────────────────────────────────────────────────
ipcMain.handle("validate-license", async (_event, key) => {
  const result = await validateLicense(key);
  if (!result.valid) return result;

  // Lisansı ve cache'i kaydet
  saveLicense(result.key, result.cache);

  // Features'dan API key varsa otomatik kaydet
  applyLicenseApiKey();

  return { valid: true, key: result.key };
});

ipcMain.handle("get-license-status", () => {
  const licenseKey = loadLicense();
  if (!licenseKey) return { hasLicense: false };

  const fmt = validateLicenseFormat(licenseKey);
  const cacheValid = isLicenseCacheValid();
  const cache = loadLicenseCache();
  return {
    hasLicense: fmt.valid && cacheValid,
    licenseKey: licenseKey,
    maskedKey: licenseKey ? licenseKey.substring(0, 10) + "••••-••••" : null,
    plan: cache?.plan || null,
    expiresAt: cache?.expiresAt || null,
  };
});

ipcMain.handle("remove-license", () => {
  removeLicenseKey();
  return { success: true };
});

ipcMain.handle("license-activate-and-start", async (_event, settings) => {
  // Lisans doğrulandıktan sonra settings ekranından çağrılır
  const existing = loadSettings() || {};
  const merged = { ...existing, ...settings };
  saveSettings(merged);
  applySettings(merged);
  createSplashWindow();
  await startServer();
  createMainWindow();
  buildMenu();
  // Settings'i mainWindow oluştuktan SONRA kapat (closed event'te app.quit önlenir)
  if (settingsWindow) {
    settingsWindow.close();
    settingsWindow = null;
  }
  return { success: true };
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

ipcMain.on("license-open-settings", () => {
  if (licenseWindow) {
    licenseWindow.close();
    licenseWindow = null;
  }
  createSettingsWindow(true);
});

ipcMain.on("open-about", () => {
  createAboutWindow();
});

// ── IPC: Test connections ───────────────────────────────────────
ipcMain.handle("test-inscada-api", async (_event, config) => {
  return new Promise((resolve) => {
    const url = config.url || "http://localhost:8081";
    const isHttps = url.startsWith("https");
    const mod = isHttps ? https : http;
    const opts = { timeout: 5000 };
    if (isHttps) opts.rejectUnauthorized = false;
    const req = mod.get(url, opts, (res) => {
      resolve({ success: res.statusCode < 500 });
      res.resume();
    });
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ success: false, error: "Timeout" }); });
  });
});

ipcMain.handle("test-claude", async (_event, config) => {
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: config.apiKey });
    const resp = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    });
    const text = resp.content?.[0]?.text || "";
    return { success: true, message: text.substring(0, 50) };
  } catch (err) {
    const rawMsg = err?.error?.error?.message || err.message || "";
    if (rawMsg.includes("usage limits")) {
      const dateMatch = rawMsg.match(/on (\d{4}-\d{2}-\d{2})/);
      const resetDate = dateMatch ? ` (${dateMatch[1]})` : "";
      return { success: false, error: `API limiti dolmuş${resetDate}` };
    }
    return { success: false, error: err.message || "Hata" };
  }
});

ipcMain.handle("test-ollama", async (_event, config) => {
  return new Promise((resolve) => {
    const baseUrl = config.url || "http://localhost:11434";
    const url = `${baseUrl}/api/tags`;
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) {
            resolve({ success: false, error: `HTTP ${res.statusCode}` });
            return;
          }
          const data = JSON.parse(body);
          const models = (data.models || []).map(m => m.name || m.model);
          resolve({ success: true, models });
        } catch {
          resolve({ success: false, error: "Yanıt okunamadı" });
        }
      });
    });
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ success: false, error: "Timeout" }); });
  });
});

// Gemini / OpenAI bağlantı testi
ipcMain.handle("test-gemini", async (_event, config) => {
  try {
    const { OpenAI } = require("openai");
    const baseUrl = config.baseUrl || "https://generativelanguage.googleapis.com/v1beta/openai";
    const client = new OpenAI({ apiKey: config.apiKey, baseURL: baseUrl });
    const resp = await client.chat.completions.create({
      model: config.model || "gemini-2.0-flash",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 5,
    });
    const reply = resp.choices?.[0]?.message?.content || "";
    return { success: true, models: `${config.model || "gemini-2.0-flash"} — yanıt: "${reply.substring(0, 50)}"` };
  } catch (err) {
    return { success: false, error: err.message || "Hata" };
  }
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
  const licenseKey = loadLicense();

  // Lisans key yoksa veya format geçersizse → lisans ekranı
  if (!licenseKey || !validateLicenseFormat(licenseKey).valid) {
    createLicenseWindow();
    return;
  }

  // Cache kontrolü — taze mi?
  const cacheValid = isLicenseCacheValid();
  if (!cacheValid) {
    // Cache eski — online doğrulama dene
    const result = await validateLicense(licenseKey);
    if (!result.valid) {
      createLicenseWindow();
      return;
    }
    // Cache güncellendi
    if (result.cache) saveLicenseCache(result.cache);
  }

  // License features'dan API key'i otomatik al
  applyLicenseApiKey();

  // Settings'i yeniden oku (API key güncellenmiş olabilir)
  const freshSettings = loadSettings() || {};

  // Lisans geçerli ama settings henüz tamamlanmamışsa → settings ekranı
  if (!freshSettings.inscadaApiUrl) {
    createSettingsWindow(true);
    return;
  }

  // Settings mevcut — splash göster, sunucuyu başlat
  createSplashWindow();
  applySettings(freshSettings);
  await startServer();
  createMainWindow();
  buildMenu();

}

app.whenReady().then(startApp);

app.on("window-all-closed", () => {
  app.quit();
});
