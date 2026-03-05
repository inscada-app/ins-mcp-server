/**
 * inSCADA Tool Handlers
 * inSCADA REST API + Chart (frontend-rendered)
 */
const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const os = require("os");
const pathMod = require("path");
const XLSX = require("xlsx");

const DOWNLOADS_DIR = pathMod.join(os.tmpdir(), "inscada-downloads");
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// ============================================================
// OpenAPI Index — api-docs.json'dan hafif endpoint kataloğu
// Startup'ta bir kez yüklenir, Claude tool'ları ile aranır
// ============================================================
const API_DOCS_PATH = pathMod.join(__dirname, "api-docs.json");
let API_INDEX = [];    // [{path, method, summary, tag, category, params[], hasBody, bodyRef}]
let API_SCHEMAS = {};  // component schemas (raw)
let API_SPEC = null;   // full spec (for schema resolution)

try {
  const raw = fs.readFileSync(API_DOCS_PATH, "utf-8");
  API_SPEC = JSON.parse(raw);
  API_SCHEMAS = (API_SPEC.components && API_SPEC.components.schemas) || {};

  // Kategori ataması: tag → insan-okunur kategori
  function tagToCategory(tag) {
    if (!tag) return "other";
    const t = tag.toLowerCase();
    if (t.includes("alarm")) return "alarms";
    if (t.includes("variable") || t.includes("value")) return "variables";
    if (t.includes("connection") || t.includes("device") || t.includes("frame")) return "connections";
    if (t.includes("script")) return "scripts";
    if (t.includes("project")) return "projects";
    if (t.includes("report") || t.includes("jasper") || t.includes("pdf")) return "reports";
    if (t.includes("animation") || t.includes("faceplate") || t.includes("symbol")) return "visualization";
    if (t.includes("trend") || t.includes("monitor") || t.includes("board")) return "trends";
    if (t.includes("user") || t.includes("role") || t.includes("permission") || t.includes("auth") || t.includes("login")) return "users";
    if (t.includes("space")) return "spaces";
    if (t.includes("menu")) return "menus";
    if (t.includes("expression")) return "expressions";
    if (t.includes("data-transfer")) return "data-transfer";
    if (t.includes("custom")) return "custom";
    if (t.includes("modbus") || t.includes("opc") || t.includes("mqtt") || t.includes("s-7") || t.includes("iec") || t.includes("dnp") || t.includes("fatek") || t.includes("ethernet") || t.includes("local")) return "protocols";
    if (t.includes("template")) return "templates";
    if (t.includes("keyword") || t.includes("language") || t.includes("map") || t.includes("search") || t.includes("metadata")) return "system";
    return "other";
  }

  const paths = API_SPEC.paths || {};
  for (const [pathStr, methods] of Object.entries(paths)) {
    for (const [method, spec] of Object.entries(methods)) {
      if (["get", "post", "put", "delete", "patch"].indexOf(method) === -1) continue;
      const tag = (spec.tags && spec.tags[0]) || "";
      // Parametreleri çıkar (header auth parametrelerini hariç tut)
      const params = (spec.parameters || [])
        .filter(p => p.in !== "header")
        .map(p => ({
          name: p.name,
          in: p.in,
          required: !!p.required,
          type: (p.schema && p.schema.type) || "string",
        }));
      // Body ref
      let hasBody = false;
      let bodyRef = null;
      if (spec.requestBody && spec.requestBody.content) {
        hasBody = true;
        const jsonContent = spec.requestBody.content["application/json"] || spec.requestBody.content["*/*"];
        if (jsonContent && jsonContent.schema && jsonContent.schema["$ref"]) {
          bodyRef = jsonContent.schema["$ref"].replace("#/components/schemas/", "");
        }
      }
      API_INDEX.push({
        path: pathStr,
        method: method.toUpperCase(),
        summary: spec.summary || "",
        operationId: spec.operationId || "",
        tag,
        category: tagToCategory(tag),
        params,
        hasBody,
        bodyRef,
      });
    }
  }

  // Non-protocol endpoint'leri öne al (daha sık kullanılır)
  const protocolPriority = (ep) => ep.category === "protocols" ? 1 : 0;
  API_INDEX.sort((a, b) => protocolPriority(a) - protocolPriority(b));

  console.error(`[API Index] ${API_INDEX.length} endpoints indexed from api-docs.json`);
} catch (err) {
  console.error(`[API Index] api-docs.json yüklenemedi: ${err.message}`);
}

/**
 * $ref çözümleme — max depth ile circular ref koruması
 */
function resolveSchemaRef(refName, depth = 0) {
  if (depth > 3) return { _note: `$ref depth limit: ${refName}` };
  const schema = API_SCHEMAS[refName];
  if (!schema) return { _note: `Schema bulunamadı: ${refName}` };

  const resolved = { ...schema };
  if (resolved.properties) {
    const props = {};
    for (const [key, val] of Object.entries(resolved.properties)) {
      if (val["$ref"]) {
        const nestedRef = val["$ref"].replace("#/components/schemas/", "");
        props[key] = resolveSchemaRef(nestedRef, depth + 1);
      } else if (val.items && val.items["$ref"]) {
        const nestedRef = val.items["$ref"].replace("#/components/schemas/", "");
        props[key] = { type: "array", items: resolveSchemaRef(nestedRef, depth + 1) };
      } else {
        props[key] = val;
      }
    }
    resolved.properties = props;
  }
  return resolved;
}

/**
 * Endpoint'in tam şemasını çöz (params + body + response)
 */
function resolveEndpointSchema(pathStr, method) {
  if (!API_SPEC) return null;
  const pathSpec = API_SPEC.paths[pathStr];
  if (!pathSpec) return null;
  const methodSpec = pathSpec[method.toLowerCase()];
  if (!methodSpec) return null;

  const result = {
    path: pathStr,
    method: method.toUpperCase(),
    summary: methodSpec.summary || "",
    tag: (methodSpec.tags && methodSpec.tags[0]) || "",
  };

  // Query/path parametreleri
  result.parameters = (methodSpec.parameters || [])
    .filter(p => p.in !== "header")
    .map(p => ({
      name: p.name,
      in: p.in,
      required: !!p.required,
      type: (p.schema && p.schema.type) || "string",
      description: p.description || "",
    }));

  // Request body
  if (methodSpec.requestBody && methodSpec.requestBody.content) {
    const jsonContent = methodSpec.requestBody.content["application/json"] || methodSpec.requestBody.content["*/*"];
    if (jsonContent && jsonContent.schema) {
      if (jsonContent.schema["$ref"]) {
        const refName = jsonContent.schema["$ref"].replace("#/components/schemas/", "");
        result.requestBody = resolveSchemaRef(refName, 0);
      } else {
        result.requestBody = jsonContent.schema;
      }
    }
  }

  // Response (200)
  const resp200 = methodSpec.responses && methodSpec.responses["200"];
  if (resp200 && resp200.content) {
    const respContent = resp200.content["*/*"] || resp200.content["application/json"];
    if (respContent && respContent.schema) {
      if (respContent.schema["$ref"]) {
        const refName = respContent.schema["$ref"].replace("#/components/schemas/", "");
        result.responseSchema = resolveSchemaRef(refName, 0);
      } else if (respContent.schema.items && respContent.schema.items["$ref"]) {
        const refName = respContent.schema.items["$ref"].replace("#/components/schemas/", "");
        result.responseSchema = { type: "array", items: resolveSchemaRef(refName, 0) };
      } else {
        result.responseSchema = respContent.schema;
      }
    }
  }

  return result;
}

// ============================================================
// inSCADA REST API Client
// Auth: POST /login (form-data) → ins_access_token + ins_refresh_token cookies
// Token auto-refresh: 3.5 dk (4 dk expiry'den önce)
// Her istekte X-Space header gönderilir (varsayılan: default_space, set_space ile değiştirilebilir)
// Tarih formatı (loggedValues): "yyyy-MM-dd HH:mm:ss"
// variableIds: explode format (variableIds=1&variableIds=2)
// Fired alarms: project_id varsa /monitor endpoint kullanılır
// ============================================================
const INSCADA_API_URL = process.env.INSCADA_API_URL || "http://localhost:8081";
const INSCADA_USERNAME = process.env.INSCADA_USERNAME;
const INSCADA_PASSWORD = process.env.INSCADA_PASSWORD;

class InscadaAPI {
  constructor() {
    this.accessToken = null;
    this.refreshToken = null;
    this.refreshTimer = null;
    this.currentSpace = "default_space";
  }

  setSpace(name) {
    this.currentSpace = name;
  }

  async login() {
    const parsed = new URL(INSCADA_API_URL);
    const protocol = parsed.protocol === "https:" ? https : http;
    const boundary = "----FormBoundary" + Date.now().toString(16);
    const formParts = [];
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="username"\r\n\r\n${INSCADA_USERNAME}`);
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="password"\r\n\r\n${INSCADA_PASSWORD}`);
    const body = formParts.join("\r\n") + `\r\n--${boundary}--\r\n`;

    return new Promise((resolve, reject) => {
      const req = protocol.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: "/login",
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": Buffer.byteLength(body),
        },
        rejectUnauthorized: false,
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const cookies = res.headers["set-cookie"] || [];
          for (const c of cookies) {
            const match = c.match(/^([^=]+)=([^;]*)/);
            if (match) {
              if (match[1] === "ins_access_token") this.accessToken = match[2];
              if (match[1] === "ins_refresh_token") this.refreshToken = match[2];
            }
          }
          // Fallback: cookie yoksa body'den token oku (bazı inSCADA sürümleri token'ı body'de döner)
          if (!this.accessToken && data) {
            try {
              const json = JSON.parse(data);
              if (json.token) this.accessToken = json.token;
            } catch {}
          }
          if (!this.accessToken) {
            reject(new Error(`inSCADA login başarısız (HTTP ${res.statusCode}): ${data.substring(0, 200)}`));
            return;
          }
          // 3.5 dk'da bir token yenile
          if (this.refreshTimer) clearInterval(this.refreshTimer);
          this.refreshTimer = setInterval(() => this.login().catch(console.error), 3.5 * 60 * 1000);
          resolve();
        });
      });
      req.on("error", (err) => reject(new Error(`inSCADA login bağlantı hatası: ${err.message}`)));
      req.setTimeout(10000, () => { req.destroy(); reject(new Error("inSCADA login zaman aşımı")); });
      req.write(body);
      req.end();
    });
  }

  async request(method, pathWithQuery, body) {
    if (!this.accessToken) await this.login();
    const parsed = new URL(INSCADA_API_URL);
    const protocol = parsed.protocol === "https:" ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;

    return new Promise((resolve, reject) => {
      const headers = {
        Accept: "application/json",
        Cookie: `ins_access_token=${this.accessToken}; ins_refresh_token=${this.refreshToken}`,
        "X-Space": this.currentSpace,
      };
      if (bodyStr) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }

      const req = protocol.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: pathWithQuery,
        method,
        headers,
        rejectUnauthorized: false,
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            this.accessToken = null;
            reject(new Error(`inSCADA API yetki hatası (${res.statusCode}). Tekrar deneyin.`));
            return;
          }
          if (res.statusCode >= 400) {
            reject(new Error(`inSCADA API hatası (${res.statusCode}): ${data.substring(0, 500)}`));
            return;
          }
          try {
            resolve(data ? JSON.parse(data) : { success: true, statusCode: res.statusCode });
          } catch {
            resolve({ raw: data, statusCode: res.statusCode });
          }
        });
      });
      req.on("error", (err) => reject(new Error(`inSCADA API bağlantı hatası: ${err.message}`)));
      req.setTimeout(30000, () => { req.destroy(); reject(new Error("inSCADA API zaman aşımı")); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }
}

const inscadaApi = new InscadaAPI();

// ============================================================
// Helpers — REST API veri çekme yardımcıları
// ============================================================

/** time_range ("24h","7d","1h") → {startDate, endDate} (yyyy-MM-dd HH:mm:ss) */
function timeRangeToDateRange(timeRange) {
  const match = (timeRange || "24h").match(/^(\d+)([smhdw])$/);
  if (!match) throw new Error("Geçersiz zaman aralığı formatı: " + timeRange);
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  const ms = parseInt(match[1]) * (multipliers[match[2]] || 3600000);
  const end = new Date();
  const start = new Date(end.getTime() - ms);
  const fmt = (d) => d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  return { startDate: fmt(start), endDate: fmt(end) };
}

/** variable_names (string, virgüllü) + project_id → [{variable_id, name}] via REST API */
async function resolveVariableIds(projectId, variableNames) {
  const names = variableNames.split(",").map(n => n.trim()).filter(Boolean);
  if (!names.length) throw new Error("variable_names boş olamaz.");
  const result = await inscadaApi.request("GET",
    `/api/variables/names?projectId=${projectId}&names=${encodeURIComponent(names.join(","))}`);
  if (!Array.isArray(result) || !result.length)
    throw new Error(`Değişken bulunamadı: ${names.join(", ")} (project_id: ${projectId})`);
  return result.map(v => ({ variable_id: v.id, name: v.name }));
}

const MAX_CHART_POINTS = 3000;

/**
 * Tarih aralığına göre optimal interval (ms) hesaplar.
 * Saniyede 1 veri loglandığı kabul edilir. Toplam saniye MAX_CHART_POINTS'i aşarsa
 * interval = ceil(totalSeconds / MAX_CHART_POINTS) * 1000 ms döner. Aşmazsa minimum 1000ms.
 */
function calcSmartInterval(startDate, endDate) {
  const s = new Date(startDate.replace(" ", "T") + "Z").getTime();
  const e = new Date(endDate.replace(" ", "T") + "Z").getTime();
  const totalSeconds = Math.max(1, Math.round((e - s) / 1000));
  if (totalSeconds <= MAX_CHART_POINTS) return 1000;
  return Math.ceil(totalSeconds / MAX_CHART_POINTS) * 1000;
}

/**
 * Akıllı veri çekme: calcSmartInterval ile hesaplanan interval (min 1000ms) ile
 * loggedValues/stats endpoint'ini kullanır. [{x, y, name}] formatında normalize döner.
 */
async function smartFetch(variableIds, startDate, endDate) {
  const interval = calcSmartInterval(startDate, endDate);
  const stats = await fetchLoggedStats(variableIds, startDate, endDate, interval);
  if (!Array.isArray(stats)) return [];
  return stats.map(r => ({ x: r.dttm, y: r.avgValue, name: r.name || String(r.variableId) }));
}

/** loggedValues endpoint çağrısı — variableIds + startDate/endDate → [{value, dttm, name, ...}] */
async function fetchLoggedValues(variableIds, startDate, endDate) {
  const ids = Array.isArray(variableIds) ? variableIds : [variableIds];
  const idParams = ids.map(id => `variableIds=${id}`).join("&");
  let path = `/api/variables/loggedValues?${idParams}`;
  if (startDate) path += `&startDate=${encodeURIComponent(startDate)}`;
  if (endDate) path += `&endDate=${encodeURIComponent(endDate)}`;
  return inscadaApi.request("GET", path);
}

/** loggedValues/stats endpoint — variableIds + startDate/endDate + interval → stats */
async function fetchLoggedStats(variableIds, startDate, endDate, interval) {
  const ids = Array.isArray(variableIds) ? variableIds : [variableIds];
  const idParams = ids.map(id => `variableIds=${id}`).join("&");
  let path = `/api/variables/loggedValues/stats?${idParams}`;
  if (startDate) path += `&startDate=${encodeURIComponent(startDate)}`;
  if (endDate) path += `&endDate=${encodeURIComponent(endDate)}`;
  if (interval) path += `&interval=${interval}`;
  return inscadaApi.request("GET", path);
}

/** stats/daily endpoint — projectId + names → daily stats */
async function fetchDailyStats(projectId, names, startDate, endDate) {
  const nameList = Array.isArray(names) ? names.join(",") : names;
  let path = `/api/variables/loggedValues/stats/daily?projectId=${projectId}&names=${encodeURIComponent(nameList)}`;
  if (startDate) path += `&startDate=${encodeURIComponent(startDate)}`;
  if (endDate) path += `&endDate=${encodeURIComponent(endDate)}`;
  return inscadaApi.request("GET", path);
}

// ============================================================
// Custom Menu Template Helpers
// ============================================================

/** HTML-escape for template interpolation (XSS koruması) */
function _escTpl(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Common <head> block: charset, viewport, Chart.js CDN, date adapter, Inter font */
function _templateHead(title) {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${_escTpl(title)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">`;
}

/** Common CSS styles — Webix Flat theme (light, clean, teal accent) */
function _templateStyles(extra) {
  return `<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:#EBEDF0;color:#475466;min-height:100vh}
.dashboard-header{background:#FFFFFF;padding:18px 24px;border-bottom:1px solid #DADEE0;display:flex;align-items:center;gap:12px}
.dashboard-header h1{font-size:17px;font-weight:600;color:#313131}
.dashboard-header .live-dot{width:8px;height:8px;border-radius:50%;background:#55CD97;animation:pulse-dot 2s infinite}
@keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:.4}}
.dashboard-body{padding:20px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.card{background:#FFFFFF;border:1px solid #DADEE0;border-radius:6px;padding:20px;position:relative}
.card-title{font-size:13px;font-weight:500;color:#657584;margin-bottom:12px;text-transform:uppercase;letter-spacing:.5px}
.gauge-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:260px}
.gauge-value{font-size:42px;font-weight:700;color:#313131;margin-top:-30px}
.gauge-unit{font-size:14px;color:#657584;margin-top:4px}
.gauge-range{display:flex;justify-content:space-between;width:100%;max-width:220px;margin-top:8px;font-size:12px;color:#657584}
.chart-wrap{position:relative;min-height:260px}
.update-time{font-size:11px;color:#94a1b0;position:absolute;bottom:8px;right:12px}
@media(max-width:768px){.grid-2{grid-template-columns:1fr}}
${extra || ""}
</style>`;
}

/** JS helper: apiFetch with credentials + X-Space header */
function _fetchHelperJS(spaceName) {
  const sp = _escTpl(spaceName || inscadaApi.currentSpace || "default_space");
  return `
function apiFetch(url){
  return fetch(url,{method:"GET",credentials:"include",headers:{"X-Space":"${sp}",Accept:"application/json"}}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.json()});
}`;
}

/** Single gauge template — doughnut 180°, color zones (green/yellow/red), auto-refresh */
function _templateGauge(params) {
  const { variable_name, project_id, title, unit = "", min = 0, max = 100, refresh_interval = 2000, space_name } = params;
  const safeTitle = _escTpl(title || variable_name);
  const safeUnit = _escTpl(unit);
  const safeVar = _escTpl(variable_name);

  return `${_templateHead(safeTitle)}
${_templateStyles("")}
</head>
<body>
<div class="dashboard-header">
  <div class="live-dot"></div>
  <h1>${safeTitle}</h1>
</div>
<div class="dashboard-body">
  <div class="card">
    <div class="card-title">${safeVar}</div>
    <div class="gauge-wrap">
      <canvas id="gauge" width="260" height="160"></canvas>
      <div class="gauge-value" id="gaugeVal">--</div>
      <div class="gauge-unit">${safeUnit}</div>
      <div class="gauge-range"><span>${_escTpl(min)}</span><span>${_escTpl(max)}</span></div>
    </div>
    <div class="update-time" id="updateTime"></div>
  </div>
</div>
<script>
${_fetchHelperJS(space_name)}
var gaugeMin=${JSON.stringify(min)},gaugeMax=${JSON.stringify(max)};
var chart,dataRef={value:null};

function createGauge(val){
  var pct=Math.max(0,Math.min(1,(val-gaugeMin)/(gaugeMax-gaugeMin)));
  var color=pct<0.6?"#55CD97":pct<0.85?"#FDBF4C":"#FF5C4C";
  var ctx=document.getElementById("gauge").getContext("2d");
  chart=new Chart(ctx,{
    type:"doughnut",
    data:{datasets:[{data:[pct,1-pct],backgroundColor:[color,"#EDEFF0"],borderWidth:0}]},
    options:{
      responsive:false,
      rotation:-90,
      circumference:180,
      cutout:"78%",
      plugins:{tooltip:{enabled:false},legend:{display:false}},
      animation:{duration:600}
    }
  });
}

function updateGauge(val){
  if(val==null)return;
  dataRef.value=val;
  var pct=Math.max(0,Math.min(1,(val-gaugeMin)/(gaugeMax-gaugeMin)));
  var color=pct<0.6?"#55CD97":pct<0.85?"#FDBF4C":"#FF5C4C";
  document.getElementById("gaugeVal").textContent=parseFloat(val).toFixed(2);
  if(chart){
    chart.data.datasets[0].data=[pct,1-pct];
    chart.data.datasets[0].backgroundColor=[color,"#EDEFF0"];
    chart.update("none");
  }
  document.getElementById("updateTime").textContent=new Date().toLocaleTimeString("tr-TR");
}

function fetchValue(){
  apiFetch("/api/variables/value?projectId=${project_id}&name=${encodeURIComponent(variable_name)}")
    .then(function(d){var v=d.value!=null?d.value:(d.data?d.data.value:null);updateGauge(v);})
    .catch(function(){});
}

createGauge(0);
fetchValue();
setInterval(fetchValue,${JSON.stringify(refresh_interval)});
</script>
</body>
</html>`;
}

/** Single line chart template — sliding window, auto-refresh */
function _templateLineChart(params) {
  const { variable_name, project_id, title, unit = "", time_range = "1h", refresh_interval = 2000, space_name } = params;
  const safeTitle = _escTpl(title || variable_name);
  const safeUnit = _escTpl(unit);
  const safeVar = _escTpl(variable_name);
  // Convert time_range like "1h" to ms for sliding window
  const trMatch = (time_range || "1h").match(/^(\d+)([smhdw])$/);
  const trMultipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  const windowMs = trMatch ? parseInt(trMatch[1]) * (trMultipliers[trMatch[2]] || 3600000) : 3600000;

  return `${_templateHead(safeTitle)}
${_templateStyles("")}
</head>
<body>
<div class="dashboard-header">
  <div class="live-dot"></div>
  <h1>${safeTitle}</h1>
</div>
<div class="dashboard-body">
  <div class="card">
    <div class="card-title">${safeVar} (${_escTpl(time_range)})</div>
    <div class="chart-wrap">
      <canvas id="lineChart"></canvas>
    </div>
    <div class="update-time" id="updateTime"></div>
  </div>
</div>
<script>
${_fetchHelperJS(space_name)}
var windowMs=${JSON.stringify(windowMs)};
var chartData=[];
var chart;

function createChart(){
  var ctx=document.getElementById("lineChart").getContext("2d");
  chart=new Chart(ctx,{
    type:"line",
    data:{datasets:[{label:"${safeVar}",data:chartData,borderColor:"#1CA1C1",backgroundColor:"rgba(28,161,193,0.08)",borderWidth:2,fill:true,pointRadius:0,tension:0.3}]},
    options:{
      responsive:true,
      maintainAspectRatio:false,
      scales:{
        x:{type:"time",time:{tooltipFormat:"HH:mm:ss",displayFormats:{second:"HH:mm:ss",minute:"HH:mm",hour:"HH:mm"}},grid:{color:"#EDEFF0"},ticks:{color:"#657584",maxTicksLimit:8}},
        y:{grid:{color:"#EDEFF0"},ticks:{color:"#657584"},title:{display:${unit ? "true" : "false"},text:"${safeUnit}",color:"#475466"}}
      },
      plugins:{legend:{display:false},tooltip:{mode:"index",intersect:false}},
      animation:{duration:0}
    }
  });
}

function fetchValue(){
  apiFetch("/api/variables/value?projectId=${project_id}&name=${encodeURIComponent(variable_name)}")
    .then(function(d){
      var v=d.value!=null?d.value:(d.data?d.data.value:null);
      if(v==null)return;
      var now=Date.now();
      chartData.push({x:now,y:parseFloat(v)});
      var cutoff=now-windowMs;
      while(chartData.length>0&&chartData[0].x<cutoff)chartData.shift();
      if(chart)chart.update("none");
      document.getElementById("updateTime").textContent=new Date().toLocaleTimeString("tr-TR");
    })
    .catch(function(){});
}

createChart();
fetchValue();
setInterval(fetchValue,${JSON.stringify(refresh_interval)});
</script>
</body>
</html>`;
}

/** Gauge + line chart side by side — single fetch updates both */
function _templateGaugeAndChart(params) {
  const { variable_name, project_id, title, unit = "", min = 0, max = 100, time_range = "1h", refresh_interval = 2000, space_name } = params;
  const safeTitle = _escTpl(title || variable_name);
  const safeUnit = _escTpl(unit);
  const safeVar = _escTpl(variable_name);
  const trMatch = (time_range || "1h").match(/^(\d+)([smhdw])$/);
  const trMultipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  const windowMs = trMatch ? parseInt(trMatch[1]) * (trMultipliers[trMatch[2]] || 3600000) : 3600000;

  return `${_templateHead(safeTitle)}
${_templateStyles("")}
</head>
<body>
<div class="dashboard-header">
  <div class="live-dot"></div>
  <h1>${safeTitle}</h1>
</div>
<div class="dashboard-body">
  <div class="grid-2">
    <div class="card">
      <div class="card-title">${safeVar} — Anlık</div>
      <div class="gauge-wrap">
        <canvas id="gauge" width="260" height="160"></canvas>
        <div class="gauge-value" id="gaugeVal">--</div>
        <div class="gauge-unit">${safeUnit}</div>
        <div class="gauge-range"><span>${_escTpl(min)}</span><span>${_escTpl(max)}</span></div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">${safeVar} — Trend (${_escTpl(time_range)})</div>
      <div class="chart-wrap">
        <canvas id="lineChart"></canvas>
      </div>
    </div>
  </div>
  <div class="update-time" id="updateTime" style="text-align:right;margin-top:8px"></div>
</div>
<script>
${_fetchHelperJS(space_name)}
var gaugeMin=${JSON.stringify(min)},gaugeMax=${JSON.stringify(max)},windowMs=${JSON.stringify(windowMs)};
var gaugeChart,lineChart,chartData=[];

function initGauge(){
  var ctx=document.getElementById("gauge").getContext("2d");
  gaugeChart=new Chart(ctx,{
    type:"doughnut",
    data:{datasets:[{data:[0,1],backgroundColor:["#55CD97","#EDEFF0"],borderWidth:0}]},
    options:{responsive:false,rotation:-90,circumference:180,cutout:"78%",plugins:{tooltip:{enabled:false},legend:{display:false}},animation:{duration:600}}
  });
}

function initLine(){
  var ctx=document.getElementById("lineChart").getContext("2d");
  lineChart=new Chart(ctx,{
    type:"line",
    data:{datasets:[{label:"${safeVar}",data:chartData,borderColor:"#1CA1C1",backgroundColor:"rgba(28,161,193,0.08)",borderWidth:2,fill:true,pointRadius:0,tension:0.3}]},
    options:{
      responsive:true,maintainAspectRatio:false,
      scales:{
        x:{type:"time",time:{tooltipFormat:"HH:mm:ss",displayFormats:{second:"HH:mm:ss",minute:"HH:mm",hour:"HH:mm"}},grid:{color:"#EDEFF0"},ticks:{color:"#657584",maxTicksLimit:8}},
        y:{grid:{color:"#EDEFF0"},ticks:{color:"#657584"},title:{display:${unit ? "true" : "false"},text:"${safeUnit}",color:"#475466"}}
      },
      plugins:{legend:{display:false},tooltip:{mode:"index",intersect:false}},animation:{duration:0}
    }
  });
}

function fetchAndUpdate(){
  apiFetch("/api/variables/value?projectId=${project_id}&name=${encodeURIComponent(variable_name)}")
    .then(function(d){
      var v=d.value!=null?d.value:(d.data?d.data.value:null);
      if(v==null)return;
      v=parseFloat(v);
      // gauge
      var pct=Math.max(0,Math.min(1,(v-gaugeMin)/(gaugeMax-gaugeMin)));
      var color=pct<0.6?"#55CD97":pct<0.85?"#FDBF4C":"#FF5C4C";
      document.getElementById("gaugeVal").textContent=v.toFixed(2);
      if(gaugeChart){gaugeChart.data.datasets[0].data=[pct,1-pct];gaugeChart.data.datasets[0].backgroundColor=[color,"#EDEFF0"];gaugeChart.update("none");}
      // line
      var now=Date.now();
      chartData.push({x:now,y:v});
      var cutoff=now-windowMs;
      while(chartData.length>0&&chartData[0].x<cutoff)chartData.shift();
      if(lineChart)lineChart.update("none");
      document.getElementById("updateTime").textContent="Son güncelleme: "+new Date().toLocaleTimeString("tr-TR");
    })
    .catch(function(){});
}

initGauge();initLine();
fetchAndUpdate();
setInterval(fetchAndUpdate,${JSON.stringify(refresh_interval)});
</script>
</body>
</html>`;
}

/** Multi-variable line chart — uses /api/variables/values for batch fetch, legend enabled */
function _templateMultiChart(params) {
  const { variables = [], project_id, title, unit = "", time_range = "1h", refresh_interval = 2000, space_name } = params;
  const safeTitle = _escTpl(title || "Multi Chart");
  const safeUnit = _escTpl(unit);
  const trMatch = (time_range || "1h").match(/^(\d+)([smhdw])$/);
  const trMultipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  const windowMs = trMatch ? parseInt(trMatch[1]) * (trMultipliers[trMatch[2]] || 3600000) : 3600000;

  const defaultColors = ["#1CA1C1", "#55CD97", "#FDBF4C", "#FF5C4C", "#a855f7", "#1992af", "#f97316", "#17839d"];
  const varsJson = JSON.stringify(variables.map((v, i) => ({
    name: v.name,
    label: v.label || v.name,
    color: v.color || defaultColors[i % defaultColors.length],
  })));
  const varNames = variables.map(v => v.name).join(",");

  return `${_templateHead(safeTitle)}
${_templateStyles("")}
</head>
<body>
<div class="dashboard-header">
  <div class="live-dot"></div>
  <h1>${safeTitle}</h1>
</div>
<div class="dashboard-body">
  <div class="card">
    <div class="card-title">${_escTpl(variables.length)} Değişken — ${_escTpl(time_range)}</div>
    <div class="chart-wrap">
      <canvas id="multiChart"></canvas>
    </div>
    <div class="update-time" id="updateTime"></div>
  </div>
</div>
<script>
${_fetchHelperJS(space_name)}
var VARS=${varsJson};
var windowMs=${JSON.stringify(windowMs)};
var seriesData={};
VARS.forEach(function(v){seriesData[v.name]=[];});
var chart;

function initChart(){
  var datasets=VARS.map(function(v){
    return{label:v.label,data:seriesData[v.name],borderColor:v.color,backgroundColor:"transparent",borderWidth:2,pointRadius:0,tension:0.3};
  });
  var ctx=document.getElementById("multiChart").getContext("2d");
  chart=new Chart(ctx,{
    type:"line",
    data:{datasets:datasets},
    options:{
      responsive:true,maintainAspectRatio:false,
      scales:{
        x:{type:"time",time:{tooltipFormat:"HH:mm:ss",displayFormats:{second:"HH:mm:ss",minute:"HH:mm",hour:"HH:mm"}},grid:{color:"#EDEFF0"},ticks:{color:"#657584",maxTicksLimit:8}},
        y:{grid:{color:"#EDEFF0"},ticks:{color:"#657584"},title:{display:${unit ? "true" : "false"},text:"${safeUnit}",color:"#475466"}}
      },
      plugins:{legend:{display:true,labels:{color:"#475466"}},tooltip:{mode:"index",intersect:false}},
      animation:{duration:0}
    }
  });
}

function fetchValues(){
  apiFetch("/api/variables/values?projectId=${project_id}&names=${encodeURIComponent(varNames)}")
    .then(function(d){
      var now=Date.now();
      VARS.forEach(function(v){
        var entry=d[v.name]||d[v.label];
        if(entry){
          var val=entry.value!=null?entry.value:(entry.data?entry.data.value:null);
          if(val!=null)seriesData[v.name].push({x:now,y:parseFloat(val)});
        }
        var cutoff=now-windowMs;
        while(seriesData[v.name].length>0&&seriesData[v.name][0].x<cutoff)seriesData[v.name].shift();
      });
      if(chart)chart.update("none");
      document.getElementById("updateTime").textContent=new Date().toLocaleTimeString("tr-TR");
    })
    .catch(function(){});
}

initChart();
fetchValues();
setInterval(fetchValues,${JSON.stringify(refresh_interval)});
</script>
</body>
</html>`;
}

/** Map template name to generator function */
const MENU_TEMPLATES = {
  gauge: _templateGauge,
  line_chart: _templateLineChart,
  gauge_and_chart: _templateGaugeAndChart,
  multi_chart: _templateMultiChart,
};

// ============================================================
// Handlers
// ============================================================
const handlers = {
  // --- Space Management ---
  async set_space({ space_name }) {
    inscadaApi.setSpace(space_name);
    return { success: true, message: `X-Space header "${space_name}" olarak ayarlandı. Bundan sonraki tüm API istekleri bu space üzerinden yapılacak.`, current_space: space_name };
  },

  // --- inSCADA REST API (data) ---
  async list_spaces({ search }) {
    const spaces = await inscadaApi.request("GET", "/api/spaces");
    let result = Array.isArray(spaces) ? spaces.map(s => ({
      space_id: s.id, name: s.name,
      insert_user: s.createdBy || null, insert_dttm: s.creationDate || null,
    })) : [];
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(r => r.name && r.name.toLowerCase().includes(s));
    }
    result.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return result;
  },

  async list_projects({ space_id, space_name, search }) {
    const projects = await inscadaApi.request("GET", "/api/projects");
    let result = Array.isArray(projects) ? projects.map(p => ({
      project_id: p.id, name: p.name, dsc: p.dsc || null, active_flag: p.isActive,
    })) : [];
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(r => r.name && r.name.toLowerCase().includes(s));
    }
    result.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return result;
  },

  async list_variables({ project_id, search, connection_id, page_size, page_number }) {
    const size = Math.min(page_size || 500, 2000);
    const page = page_number || 0;

    let result;
    if (connection_id) {
      // Connection filtresi — POST /api/variables/filter/pages
      const filter = { projectId: project_id, connectionId: connection_id };
      result = await inscadaApi.request("POST",
        `/api/variables/filter/pages?size=${size}&page=${page}&paged=true`, filter);
    } else {
      // Tüm değişkenler — GET /api/variables/pages
      result = await inscadaApi.request("GET",
        `/api/variables/pages?projectId=${project_id}&size=${size}&page=${page}&paged=true`);
    }

    const content = Array.isArray(result.content) ? result.content : (Array.isArray(result) ? result : []);
    let variables = content.map(v => ({
      variable_id: v.id, name: v.name, dsc: v.dsc || null,
      unit: v.unit || null, code: v.code || null,
      project_id: v.projectId, connection_id: v.connectionId || null,
      is_active: v.isActive != null ? v.isActive : v.active_flag,
      eng_zero_scale: v.engZeroScale, eng_full_scale: v.engFullScale,
      log_type: v.logType || null,
    }));

    // Client-side arama (API filtresi güvenilir olmayabilir)
    if (search) {
      const s = search.toLowerCase();
      variables = variables.filter(v =>
        (v.name && v.name.toLowerCase().includes(s)) ||
        (v.dsc && v.dsc.toLowerCase().includes(s)) ||
        (v.code && v.code.toLowerCase().includes(s))
      );
    }

    return {
      variables,
      total: search ? variables.length : (result.totalElements || variables.length),
      page: result.number || page,
      page_size: result.size || size,
      total_pages: search ? 1 : (result.totalPages || 1),
    };
  },

  async list_scripts({ project_id, project_name, space_name, search }) {
    let path = "/api/scripts/summary";
    if (project_id) path += `?projectId=${project_id}`;
    const scripts = await inscadaApi.request("GET", path);
    let result = Array.isArray(scripts) ? scripts.map(s => ({
      script_id: s.id, name: s.name, dsc: s.dsc || null,
      sch_type: s.type || null, project_id: s.projectId, version_dttm: s.lastModifiedDate || null,
    })) : [];
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(r => r.name && r.name.toLowerCase().includes(s));
    }
    if (project_name && !project_id) {
      const projects = await inscadaApi.request("GET", "/api/projects");
      const ids = new Set(projects.filter(p => p.name && p.name.toLowerCase().includes(project_name.toLowerCase())).map(p => p.id));
      result = result.filter(r => ids.has(r.project_id));
    }
    result.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return result;
  },

  async get_script({ script_id, script_name, project_name }) {
    const mapScript = (s) => ({
      script_id: s.id, name: s.name, dsc: s.dsc || null,
      code: s.code || "", sch_type: s.type, project_id: s.projectId,
      version_dttm: s.lastModifiedDate || null, version_user: s.lastModifiedBy || null,
    });
    if (script_id) {
      const s = await inscadaApi.request("GET", `/api/scripts/${script_id}`);
      return mapScript(s);
    }
    // Search by name
    const scripts = await inscadaApi.request("GET", "/api/scripts/summary");
    let matches = Array.isArray(scripts) ? scripts : [];
    if (script_name) {
      const sn = script_name.toLowerCase();
      matches = matches.filter(sc => sc.name && sc.name.toLowerCase().includes(sn));
    }
    if (project_name) {
      const projects = await inscadaApi.request("GET", "/api/projects");
      const ids = new Set(projects.filter(p => p.name && p.name.toLowerCase().includes(project_name.toLowerCase())).map(p => p.id));
      matches = matches.filter(sc => ids.has(sc.projectId));
    }
    if (!matches.length) return { error: "Script bulunamadı." };
    if (matches.length > 1) return { warning: `${matches.length} script bulundu:`, scripts: matches.map(r => ({ script_id: r.id, name: r.name, project_id: r.projectId })) };
    const full = await inscadaApi.request("GET", `/api/scripts/${matches[0].id}`);
    return mapScript(full);
  },

  async update_script({ script_id, code }) {
    await inscadaApi.request("PATCH", `/api/scripts/${script_id}/code`, { code });
    const updated = await inscadaApi.request("GET", `/api/scripts/${script_id}`);
    return { success: true, script_id: updated.id, name: updated.name, message: `"${updated.name}" güncellendi.` };
  },

  async list_connections({ project_id, search, include_status }) {
    let path = "/api/connections";
    if (project_id) path += `?projectId=${project_id}`;
    const conns = await inscadaApi.request("GET", path);
    let result = Array.isArray(conns) ? conns.map(c => ({
      conn_id: c.id, name: c.name, dsc: c.dsc || null,
      protocol: c.protocol || null, ip: c.ip || null, port: c.port || null,
      project_id: c.projectId,
    })) : [];
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(r => r.name && r.name.toLowerCase().includes(s));
    }
    result.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    if (include_status && result.length) {
      const ids = result.map(r => r.conn_id).join(",");
      const statuses = await inscadaApi.request("GET", `/api/connections/status?connectionIds=${encodeURIComponent(ids)}`);
      for (const r of result) {
        r.status = (statuses && statuses[String(r.conn_id)]) || "Unknown";
      }
    }
    return result;
  },

  async search_in_scripts({ search_text, project_name }) {
    const scripts = await inscadaApi.request("GET", "/api/scripts");
    let matches = [];
    const searchLower = search_text.toLowerCase();
    for (const sc of (Array.isArray(scripts) ? scripts : [])) {
      if (!sc.code) continue;
      const idx = sc.code.toLowerCase().indexOf(searchLower);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 100);
      matches.push({
        script_id: sc.id, name: sc.name, project_id: sc.projectId,
        snippet: sc.code.substring(start, start + 250),
      });
    }
    if (project_name) {
      const projects = await inscadaApi.request("GET", "/api/projects");
      const ids = new Set(projects.filter(p => p.name && p.name.toLowerCase().includes(project_name.toLowerCase())).map(p => p.id));
      matches = matches.filter(m => ids.has(m.project_id));
    }
    return { count: matches.length, results: matches.slice(0, 50) };
  },

  // --- Animations ---
  async list_animations({ project_id, search }) {
    const anims = await inscadaApi.request("GET", `/api/animations?projectId=${project_id}`);
    let result = Array.isArray(anims) ? anims.map(a => ({
      animation_id: a.id, name: a.name, dsc: a.dsc || null,
      project_id: a.projectId, main_flag: a.mainFlag != null ? a.mainFlag : a.main_flag,
      color: a.color || null, duration: a.duration || null,
      play_order: a.playOrder != null ? a.playOrder : a.play_order,
    })) : [];
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(r =>
        (r.name && r.name.toLowerCase().includes(s)) ||
        (r.dsc && r.dsc.toLowerCase().includes(s))
      );
    }
    result.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return result;
  },

  async get_animation({ animation_id, animation_name, project_id, include_svg, include_elements }) {
    const mapAnim = (a) => ({
      animation_id: a.id, name: a.name, dsc: a.dsc || null,
      project_id: a.projectId, main_flag: a.mainFlag != null ? a.mainFlag : a.main_flag,
      color: a.color || null, duration: a.duration || null,
      play_order: a.playOrder != null ? a.playOrder : a.play_order,
      alignment: a.alignment || null, placeholders: a.placeholders || null,
      configs: a.configs || null,
    });

    let anim;
    if (animation_id) {
      anim = await inscadaApi.request("GET", `/api/animations/${animation_id}`);
    } else if (animation_name && project_id) {
      const anims = await inscadaApi.request("GET", `/api/animations?projectId=${project_id}`);
      const sn = animation_name.toLowerCase();
      const matches = (Array.isArray(anims) ? anims : []).filter(a => a.name && a.name.toLowerCase().includes(sn));
      if (!matches.length) return { error: "Animasyon bulunamadı." };
      if (matches.length > 1) return { warning: `${matches.length} animasyon bulundu:`, animations: matches.map(a => ({ animation_id: a.id, name: a.name })) };
      anim = await inscadaApi.request("GET", `/api/animations/${matches[0].id}`);
    } else {
      return { error: "animation_id veya (animation_name + project_id) gerekli." };
    }

    const result = mapAnim(anim);

    if (include_elements !== false) {
      const elements = await inscadaApi.request("GET", `/api/animations/${anim.id}/elements`);
      result.elements = Array.isArray(elements) ? elements.map(e => ({
        element_id: e.id, name: e.name, dsc: e.dsc || null,
        type: e.type || null, dom_id: e.domId || null,
        expression: e.expression || null, expression_type: e.expressionType || null,
        props: e.props || null, status_flag: e.statusFlag,
      })) : [];
    }

    if (include_svg) {
      try {
        const svgResp = await inscadaApi.request("GET", `/api/animations/${anim.id}/svg`);
        result.svg_content = typeof svgResp === "string" ? svgResp : (svgResp.raw || svgResp.svgContent || JSON.stringify(svgResp));
      } catch { result.svg_content = null; }
    }

    return result;
  },

  // --- Charts (veri döner, frontend çizer) — REST API tabanlı ---
  async chart_line({ variable_names, project_id, time_range = "24h", start_date, end_date, title, y_label }) {
    if (!project_id) throw new Error("project_id gerekli.");
    if (!variable_names) throw new Error("variable_names gerekli.");

    const vars = await resolveVariableIds(project_id, variable_names);
    let startDate = start_date, endDate = end_date;
    if (!startDate || !endDate) {
      const range = timeRangeToDateRange(time_range);
      startDate = startDate || range.startDate;
      endDate = endDate || range.endDate;
    }

    const rows = await smartFetch(vars.map(v => v.variable_id), startDate, endDate);
    if (!rows.length) return { error: "Veri bulunamadı." };

    // Verileri variable bazında grupla
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.name]) grouped[row.name] = [];
      grouped[row.name].push({ x: row.x, y: row.y });
    }

    const series = Object.entries(grouped).map(([name, data]) => ({ label: name, data }));
    if (!series.length) return { error: "Veri bulunamadı." };

    return {
      __chart: true,
      chart_type: "line",
      title: title || `${variable_names} (${time_range})`,
      y_label: y_label || "Değer",
      series,
    };
  },

  async chart_bar({ variable_names, project_id, aggregation = "mean", time_range = "24h", start_date, end_date, title, y_label }) {
    if (!project_id) throw new Error("project_id gerekli.");
    if (!variable_names) throw new Error("variable_names gerekli.");

    let startDate = start_date, endDate = end_date;
    if (!startDate || !endDate) {
      const range = timeRangeToDateRange(time_range);
      startDate = startDate || range.startDate;
      endDate = endDate || range.endDate;
    }

    const names = variable_names.split(",").map(n => n.trim()).filter(Boolean);
    const statsData = await fetchDailyStats(project_id, names, startDate, endDate);

    // İstatistikleri variable bazında grupla ve aggregation uygula
    const aggMap = {};
    const rows = Array.isArray(statsData) ? statsData : [];
    for (const row of rows) {
      const name = row.name || String(row.variableId);
      if (!aggMap[name]) aggMap[name] = [];
      aggMap[name].push(row);
    }

    const aggField = { mean: "avgValue", max: "maxValue", min: "minValue", sum: "sumValue", count: "countValue" }[aggregation] || "avgValue";
    const labels = [], values = [];
    for (const name of names) {
      const entries = aggMap[name];
      if (!entries || !entries.length) continue;
      // Birden fazla gün varsa ortalama al
      const vals = entries.map(e => e[aggField]).filter(v => v != null);
      if (!vals.length) continue;
      labels.push(name);
      values.push(vals.reduce((a, b) => a + b, 0) / vals.length);
    }

    if (!labels.length) return { error: "Veri bulunamadı." };

    return {
      __chart: true,
      chart_type: "bar",
      title: title || `${aggregation}(${variable_names}) (${time_range})`,
      y_label: y_label || aggregation,
      labels,
      values,
    };
  },

  async chart_gauge({ variable_name, project_id, min = 0, max = 100, title, unit = "", auto_refresh }) {
    if (!project_id) throw new Error("project_id gerekli.");
    if (!variable_name) throw new Error("variable_name gerekli.");

    // Canlı değeri REST API'den al
    const liveResult = await inscadaApi.request("GET", `/api/variables/value?projectId=${project_id}&name=${encodeURIComponent(variable_name)}`);
    const val = liveResult?.value !== undefined ? liveResult.value : (liveResult?.data?.value !== undefined ? liveResult.data.value : null);
    if (val === null || val === undefined) return { error: "Değer okunamadı." };

    const result = {
      __chart: true,
      chart_type: "gauge",
      title: title || variable_name,
      value: parseFloat(val),
      min, max, unit,
    };

    if (auto_refresh) {
      result.auto_refresh = true;
      result.refresh_project_id = project_id;
      result.refresh_variable_name = variable_name;
    }

    return result;
  },

  // --- inSCADA REST API ---
  async inscada_get_live_value({ project_id, variable_name }) {
    if (!project_id) {
      const projects = await inscadaApi.request("GET", "/api/projects");
      if (!Array.isArray(projects) || !projects.length) return { error: "Proje bulunamadı" };
      project_id = projects[0].id;
    }
    return inscadaApi.request("GET", `/api/variables/value?projectId=${project_id}&name=${encodeURIComponent(variable_name)}`);
  },

  async inscada_get_live_values({ project_id, variable_names }) {
    if (!project_id) {
      const projects = await inscadaApi.request("GET", "/api/projects");
      if (!Array.isArray(projects) || !projects.length) return { error: "Proje bulunamadı" };
      project_id = projects[0].id;
    }
    const names = Array.isArray(variable_names) ? variable_names.join(",") : variable_names;
    return inscadaApi.request("GET", `/api/variables/values?projectId=${project_id}&names=${encodeURIComponent(names)}`);
  },

  async inscada_set_value({ project_id, variable_name, value }) {
    return inscadaApi.request("POST", `/api/variables/value?projectId=${project_id}&name=${encodeURIComponent(variable_name)}`, { value });
  },

  async inscada_get_fired_alarms({ project_id, count = 100 }) {
    if (project_id) {
      return inscadaApi.request("GET", `/api/alarms/fired-alarms/monitor?projectId=${project_id}&count=${count}`);
    }
    return inscadaApi.request("GET", `/api/alarms/fired-alarms?pageSize=${count}&paged=true`);
  },

  async inscada_connection_status({ connection_ids }) {
    const ids = Array.isArray(connection_ids) ? connection_ids.join(",") : connection_ids;
    return inscadaApi.request("GET", `/api/connections/status?connectionIds=${encodeURIComponent(ids)}`);
  },

  async inscada_project_status({ project_id }) {
    return inscadaApi.request("GET", `/api/projects/${project_id}/status`);
  },

  async inscada_run_script({ script_id }) {
    return inscadaApi.request("POST", `/api/scripts/${script_id}/run`);
  },

  async inscada_script_status({ script_id }) {
    return inscadaApi.request("GET", `/api/scripts/${script_id}/status`);
  },

  async inscada_logged_values({ variable_ids, start_date, end_date }) {
    const ids = Array.isArray(variable_ids) ? variable_ids : String(variable_ids).split(",").map(s => s.trim());
    const idParams = ids.map(id => `variableIds=${id}`).join("&");
    // inSCADA expects "yyyy-MM-dd HH:mm:ss" format
    const fmtDate = (d) => d.replace("T", " ").replace(/\.\d+/, "").replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
    let path = `/api/variables/loggedValues?${idParams}`;
    if (start_date) path += `&startDate=${encodeURIComponent(fmtDate(start_date))}`;
    if (end_date) path += `&endDate=${encodeURIComponent(fmtDate(end_date))}`;
    return inscadaApi.request("GET", path);
  },

  async inscada_logged_stats({ project_id, variable_names, time_range = "24h", start_date, end_date, interval = "daily" }) {
    if (!project_id) throw new Error("project_id gerekli.");
    if (!variable_names) throw new Error("variable_names gerekli.");

    let startDate = start_date, endDate = end_date;
    if (!startDate || !endDate) {
      const range = timeRangeToDateRange(time_range);
      startDate = startDate || range.startDate;
      endDate = endDate || range.endDate;
    }

    const names = Array.isArray(variable_names) ? variable_names.join(",") : variable_names;

    if (interval === "hourly") {
      // Hourly stats: variableIds gerekli, önce resolve et
      const vars = await resolveVariableIds(project_id, names);
      return fetchLoggedStats(vars.map(v => v.variable_id), startDate, endDate);
    }

    // Daily stats: projectId + names ile çalışır
    return fetchDailyStats(project_id, names, startDate, endDate);
  },

  // --- Custom Menu (inSCADA REST API) ---
  // inSCADA content formatı: JSON {css, js, html} — düz HTML'den dönüştürme
  _formatMenuContent(rawContent) {
    if (!rawContent) return JSON.stringify({ css: "", js: "", html: "" });
    // Zaten JSON formatındaysa dokunma
    try {
      const parsed = JSON.parse(rawContent);
      if (parsed.html !== undefined || parsed.css !== undefined || parsed.js !== undefined) return rawContent;
    } catch { /* JSON değil, parse et */ }

    // Düz HTML'den css/js/html ayır
    let css = "", js = "", html = rawContent;

    // <style> taglerini çıkar
    html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, content) => {
      css += content.trim() + "\n";
      return "";
    });

    // Sadece inline <script> taglerini çıkar, harici CDN <script src="..."> taglerini HTML'de bırak
    html = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs, content) => {
      // src attribute varsa harici kütüphane — HTML'de bırak
      if (/\bsrc\s*=/i.test(attrs)) return match;
      // Inline script — js alanına taşı
      if (content.trim()) js += content.trim() + "\n";
      return "";
    });

    return JSON.stringify({ css: css.trim(), js: js.trim(), html: html.trim() });
  },
  async list_custom_menus({ search }) {
    const menus = await inscadaApi.request("GET", "/api/custom-menus");
    if (!search) return menus;
    const s = search.toLowerCase();
    const filter = (items) => items.filter(m => m.name && m.name.toLowerCase().includes(s));
    return Array.isArray(menus) ? filter(menus) : menus;
  },

  async get_custom_menu({ custom_menu_id }) {
    return inscadaApi.request("GET", `/api/custom-menus/${custom_menu_id}`);
  },

  async get_custom_menu_by_name({ name }) {
    return inscadaApi.request("GET", `/api/custom-menus/name?customMenuName=${encodeURIComponent(name)}`);
  },

  async create_custom_menu({ name, content, icon, target = "Home", position = "Bottom", menu_order = 1, parent_menu_id, second_menu_id, template, variable_name, project_id, title, unit, min, max, refresh_interval, time_range, space_name, variables }) {
    // Template varsa şablon fonksiyonundan HTML üret
    let finalContent = content;
    if (template) {
      const tplFn = MENU_TEMPLATES[template];
      if (!tplFn) throw new Error(`Bilinmeyen template: ${template}. Geçerli: ${Object.keys(MENU_TEMPLATES).join(", ")}`);
      if (template === "multi_chart") {
        if (!variables || !variables.length) throw new Error("multi_chart template için variables[] gerekli.");
        if (!project_id) throw new Error("multi_chart template için project_id gerekli.");
      } else {
        if (!variable_name) throw new Error(`${template} template için variable_name gerekli.`);
        if (!project_id) throw new Error(`${template} template için project_id gerekli.`);
      }
      finalContent = tplFn({ variable_name, project_id, title: title || name, unit, min, max, refresh_interval, time_range, space_name, variables });
    }
    const body = {
      name,
      content: handlers._formatMenuContent(finalContent),
      contentType: "Html",
      icon: icon || "fas fa-industry",
      target,
      position,
      menuOrder: menu_order,
    };

    // 3 seviye hiyerarşi: parent_menu_id yoksa 1. seviye, varsa 2. seviye, second_menu_id de varsa 3. seviye
    if (parent_menu_id && second_menu_id) {
      return inscadaApi.request("POST", `/api/custom-menus/${parent_menu_id}/second/${second_menu_id}/third`, body);
    } else if (parent_menu_id) {
      return inscadaApi.request("POST", `/api/custom-menus/${parent_menu_id}/second`, body);
    }
    return inscadaApi.request("POST", "/api/custom-menus", body);
  },

  async update_custom_menu({ custom_menu_id, name, content, icon, target, position, menu_order, parent_menu_id, second_menu_id, template, variable_name, project_id, title, unit, min, max, refresh_interval, time_range, space_name, variables }) {
    // Template varsa şablon fonksiyonundan HTML üret
    if (template) {
      const tplFn = MENU_TEMPLATES[template];
      if (!tplFn) throw new Error(`Bilinmeyen template: ${template}. Geçerli: ${Object.keys(MENU_TEMPLATES).join(", ")}`);
      if (template === "multi_chart") {
        if (!variables || !variables.length) throw new Error("multi_chart template için variables[] gerekli.");
        if (!project_id) throw new Error("multi_chart template için project_id gerekli.");
      } else {
        if (!variable_name) throw new Error(`${template} template için variable_name gerekli.`);
        if (!project_id) throw new Error(`${template} template için project_id gerekli.`);
      }
      content = tplFn({ variable_name, project_id, title: title || name, unit, min, max, refresh_interval, time_range, space_name, variables });
    }
    // Önce mevcut veriyi al
    let existing;
    if (parent_menu_id && second_menu_id) {
      existing = await inscadaApi.request("GET", `/api/custom-menus/${parent_menu_id}/second/${second_menu_id}/third/${custom_menu_id}`);
    } else if (parent_menu_id) {
      existing = await inscadaApi.request("GET", `/api/custom-menus/${parent_menu_id}/second/${custom_menu_id}`);
    } else {
      existing = await inscadaApi.request("GET", `/api/custom-menus/${custom_menu_id}`);
    }

    const body = {
      name: name !== undefined ? name : existing.name,
      content: content !== undefined ? handlers._formatMenuContent(content) : existing.content,
      contentType: "Html",
      icon: icon !== undefined ? icon : existing.icon,
      target: target !== undefined ? target : existing.target,
      position: position !== undefined ? position : existing.position,
      menuOrder: menu_order !== undefined ? menu_order : existing.menuOrder,
    };

    if (parent_menu_id && second_menu_id) {
      return inscadaApi.request("PUT", `/api/custom-menus/${parent_menu_id}/second/${second_menu_id}/third/${custom_menu_id}`, body);
    } else if (parent_menu_id) {
      return inscadaApi.request("PUT", `/api/custom-menus/${parent_menu_id}/second/${custom_menu_id}`, body);
    }
    return inscadaApi.request("PUT", `/api/custom-menus/${custom_menu_id}`, body);
  },

  async delete_custom_menu({ custom_menu_id, parent_menu_id, second_menu_id }) {
    if (parent_menu_id && second_menu_id) {
      return inscadaApi.request("DELETE", `/api/custom-menus/${parent_menu_id}/second/${second_menu_id}/third/${custom_menu_id}`);
    } else if (parent_menu_id) {
      return inscadaApi.request("DELETE", `/api/custom-menus/${parent_menu_id}/second/${custom_menu_id}`);
    }
    return inscadaApi.request("DELETE", `/api/custom-menus/${custom_menu_id}`);
  },

  // --- Charts: multi seri ---
  async chart_multi({ series, time_range = "24h", start_date, end_date, title, y_label }) {
    if (!series || !series.length) throw new Error("series dizisi gerekli.");

    let startDate = start_date, endDate = end_date;
    if (!startDate || !endDate) {
      const range = timeRangeToDateRange(time_range);
      startDate = startDate || range.startDate;
      endDate = endDate || range.endDate;
    }

    const allSeries = [];
    for (const s of series) {
      if (!s.variable_name || !s.project_id) continue;
      const vars = await resolveVariableIds(s.project_id, s.variable_name);
      const rows = await smartFetch(vars.map(v => v.variable_id), startDate, endDate);
      if (rows.length) {
        allSeries.push({
          label: s.label || s.variable_name,
          data: rows.map(d => ({ x: d.x, y: d.y })),
        });
      }
    }

    if (!allSeries.length) return { error: "Veri bulunamadı." };

    return {
      __chart: true,
      chart_type: "line",
      title: title || `Multi Chart (${time_range})`,
      y_label: y_label || "Değer",
      series: allSeries,
    };
  },

  // --- Export ---
  async export_excel({ file_name, sheets }) {
    const wb = XLSX.utils.book_new();
    let totalRows = 0;
    for (const sheet of sheets) {
      const sheetName = (sheet.name || "Sheet").substring(0, 31);
      const data = [sheet.headers, ...sheet.rows];
      const ws = XLSX.utils.aoa_to_sheet(data);

      // Auto-size columns based on header lengths
      ws["!cols"] = sheet.headers.map((h, i) => {
        let maxLen = h.length;
        for (const row of sheet.rows) {
          if (row[i] != null) maxLen = Math.max(maxLen, String(row[i]).length);
        }
        return { wch: Math.min(maxLen + 2, 50) };
      });

      XLSX.utils.book_append_sheet(wb, ws, sheetName);
      totalRows += sheet.rows.length;
    }

    const safeName = file_name.replace(/[^a-zA-Z0-9_\-]/g, "_");
    const fileName = `${safeName}_${Date.now()}.xlsx`;
    const filePath = pathMod.join(DOWNLOADS_DIR, fileName);
    XLSX.writeFile(wb, filePath);

    return {
      __download: true,
      file_name: fileName,
      download_url: `/api/downloads/${fileName}`,
      sheet_count: sheets.length,
      total_rows: totalRows,
    };
  },

  async chart_forecast({ variable_names, project_id, time_range = "24h", start_date, end_date, forecast_values, forecast_label, title, y_label }) {
    if (!project_id) throw new Error("project_id gerekli.");
    if (!variable_names) throw new Error("variable_names gerekli.");
    if (!forecast_values || !forecast_values.length) throw new Error("forecast_values gerekli.");

    const vars = await resolveVariableIds(project_id, variable_names);
    let startDate = start_date, endDate = end_date;
    if (!startDate || !endDate) {
      const range = timeRangeToDateRange(time_range);
      startDate = startDate || range.startDate;
      endDate = endDate || range.endDate;
    }

    const rows = await smartFetch(vars.map(v => v.variable_id), startDate, endDate);

    // Tarihsel serileri is_forecast: false ile işaretle
    const allSeries = [];
    if (rows.length) {
      const grouped = {};
      for (const row of rows) {
        if (!grouped[row.name]) grouped[row.name] = [];
        grouped[row.name].push({ x: row.x, y: row.y });
      }
      for (const [name, data] of Object.entries(grouped)) {
        allSeries.push({ label: name, data, is_forecast: false });
      }
    }

    // Tahmin serisini oluştur
    const forecastData = forecast_values.map(p => ({ x: new Date(p.x).toISOString(), y: p.y }));

    // Köprü noktası: tarihsel serinin son noktasını tahmin serisinin başına ekle
    if (allSeries.length > 0) {
      const lastHistorical = allSeries[allSeries.length - 1];
      if (lastHistorical.data.length > 0) {
        const bridgePoint = lastHistorical.data[lastHistorical.data.length - 1];
        forecastData.unshift({ x: bridgePoint.x, y: bridgePoint.y });
      }
    }

    allSeries.push({
      label: forecast_label || "Tahmin",
      data: forecastData,
      is_forecast: true,
    });

    if (!allSeries.length) return { error: "Veri bulunamadı." };

    return {
      __chart: true,
      chart_type: "line",
      title: title || `${variable_names} Tahmin (${time_range})`,
      y_label: y_label || "Değer",
      series: allSeries,
    };
  },

  // ==================== Generic API Tools ====================

  async inscada_api_endpoints({ search, category, method, tag, limit: maxResults }) {
    if (!API_INDEX.length) return { error: "API index yüklenmedi. api-docs.json dosyası bulunamadı." };

    let results = API_INDEX;

    // Filtreler
    if (category) {
      const cat = category.toLowerCase();
      results = results.filter(ep => ep.category === cat);
    }
    if (method) {
      const m = method.toUpperCase();
      results = results.filter(ep => ep.method === m);
    }
    if (tag) {
      const t = tag.toLowerCase();
      results = results.filter(ep => ep.tag.toLowerCase().includes(t));
    }
    if (search) {
      const terms = search.toLowerCase().split(/\s+/);
      results = results.filter(ep => {
        const text = `${ep.path} ${ep.summary} ${ep.tag} ${ep.operationId} ${ep.category}`.toLowerCase();
        return terms.every(term => text.includes(term));
      });
    }

    const cap = Math.min(maxResults || 30, 50);
    const total = results.length;
    results = results.slice(0, cap);

    // Mevcut kategorileri listele (filtre yoksa)
    const categories = !search && !category && !method && !tag
      ? [...new Set(API_INDEX.map(ep => ep.category))].sort()
      : undefined;

    return {
      total,
      showing: results.length,
      categories,
      endpoints: results.map(ep => ({
        method: ep.method,
        path: ep.path,
        summary: ep.summary,
        category: ep.category,
        tag: ep.tag,
        params: ep.params.length ? ep.params : undefined,
        hasBody: ep.hasBody || undefined,
        bodyRef: ep.bodyRef || undefined,
      })),
    };
  },

  async inscada_api_schema({ path: pathStr, method = "GET" }) {
    if (!pathStr) return { error: "path parametresi gerekli." };
    if (!API_SPEC) return { error: "API spec yüklenmedi. api-docs.json dosyası bulunamadı." };

    const schema = resolveEndpointSchema(pathStr, method);
    if (!schema) {
      // Yakın eşleşme öner
      const similar = API_INDEX.filter(ep =>
        ep.path.includes(pathStr) || pathStr.includes(ep.path)
      ).slice(0, 5);
      return {
        error: `Endpoint bulunamadı: ${method.toUpperCase()} ${pathStr}`,
        similar: similar.map(ep => `${ep.method} ${ep.path}`),
      };
    }

    return schema;
  },

  async inscada_api({ method = "GET", path: pathStr, query_params, body, path_params }) {
    if (!pathStr) return { error: "path parametresi gerekli." };
    if (!pathStr.startsWith("/api/")) {
      return { error: "Güvenlik: path '/api/' ile başlamalıdır." };
    }

    // Path parametrelerini yerleştir: /api/projects/{id} → /api/projects/52
    let resolvedPath = pathStr;
    if (path_params && typeof path_params === "object") {
      for (const [key, val] of Object.entries(path_params)) {
        resolvedPath = resolvedPath.replace(`{${key}}`, encodeURIComponent(val));
      }
    }

    // Query parametrelerini ekle
    if (query_params && typeof query_params === "object") {
      const parts = [];
      for (const [key, val] of Object.entries(query_params)) {
        if (Array.isArray(val)) {
          // Explode format: variableIds=1&variableIds=2
          for (const v of val) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
        } else {
          parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
        }
      }
      if (parts.length) {
        resolvedPath += (resolvedPath.includes("?") ? "&" : "?") + parts.join("&");
      }
    }

    const result = await inscadaApi.request(method.toUpperCase(), resolvedPath, body || undefined);
    return result;
  },

  async inscada_guide() {
    return { guide: INSCADA_GUIDE };
  },
};

const INSCADA_GUIDE = `# inSCADA MCP Server — Rules & Best Practices

## 1. MCP Security
- inscada_set_value: Writes to real equipment — confirm with user before calling
- inscada_run_script: Executes server-side script — confirm with user before calling
- update_script: Modifies script code — read current code with get_script first, show diff to user
- inscada_api: GET requests are free, POST/PUT/DELETE/PATCH — confirm with user before calling

## 2. Script Writing Rules (CRITICAL)
- Engine: Nashorn ECMAScript 5 (JDK11). DO NOT USE let/const, arrow functions (=>), template literals, destructuring, async/await, class. Only var, function, for, if/else, try/catch, switch, while.
- STRUCTURE: All script code MUST be wrapped in a function block:
  function main() { /* code here */ }
  main();
- Global objects: ins (SCADA API), user, require(ins, "scriptName"), toJS(javaObj), fixJSONStr(str)
- ins.* API:
  Read: ins.getVariableValue(name) → {value, date, dateInMs}
  Write: ins.setVariableValue(name, {value: N})
  Bulk read: ins.getVariableValues(names[]) → {name: {value}, ...}
  Toggle: ins.toggleVariableValue(name)
  Connection: ins.getConnectionStatus(name), ins.startConnection(name), ins.stopConnection(name)
  Alarm: ins.getAlarmStatus(name), ins.activateAlarmGroup(name), ins.deactivateAlarmGroup(name)
  Alarm fired: ins.getLastFiredAlarms(index, count), ins.getAlarmLastFiredAlarms(includeOff)
  Script: ins.executeScript(name), ins.getGlobalObject(name), ins.setGlobalObject(name, obj)
  Log: ins.writeLog(type, activity, msg) — type: "INFO"/"WARN"/"ERROR"
  Notify: ins.sendMail(users[], subject, content), ins.sendSMS(users[], message), ins.notify(type, title, msg)
  Historical: ins.getLoggedVariableValuesByPage(names[], start, end, page, size)
  Stats: ins.getLoggedVariableValueStats(names[], start, end)
  Utility: ins.now(), ins.uuid(), ins.ping(addr, timeout), ins.rest(method, url, contentType, body)
  SQL: ins.runSql(sql), ins.runSql(datasource, sql)
  File: ins.writeToFile(name, text, append), ins.readFile(name)
  System: ins.consoleLog(obj), ins.refreshAllClients()
- Most methods have (projectName, ...) overloads. Without projectName, uses script's project.
- Convert Java collections: var list = toJS(ins.getVariables())
- Module import: var helper = require(ins, "HelperScript"); helper.myFunc();
- Date: var now = ins.now(); var d = ins.getDate(epochMs); or new java.util.Date(). ins.now() returns Java Date object, use ins.now().getTime() for epoch ms
- setVariableValue: {value: N} — only value key required
- Live date: ins.getVariableValue().dateInMs is epoch ms
- Historical date: dttm field is ISO 8601 string. Nashorn new Date(isoString) returns NaN! Use: var timeStr = ("" + items[i].dttm).substring(11, 19);
- ins.getLoggedVariableValuesByPage & ins.getLoggedVariableValueStatsByInterval rules:
  1. names param → MUST be JS array: ["TagName"]. Java list (javaArrayList) DOES NOT WORK. Single string DOES NOT WORK.
  2. startDate/endDate → MUST be Java Date via ins.getDate(epochMs). String format DOES NOT WORK. Epoch ms number DOES NOT WORK.
     Example: var dt = ins.now(); var year = 1900 + dt.getYear(); var month = dt.getMonth(); var day = dt.getDate(); var startDate = ins.getDate((new Date(year, month, day)).getTime());
     Note: dt.getMonth() is 0-indexed, do NOT add +1 when passing to new Date()
  3. Data comes in reverse order (newest first) → use reverse loop: for (var i = items.length - 1; i >= 0; i--) { ... }
  4. dttm field is ISO 8601 string → extract time with substring(11,19): var saat = ("" + items[i].dttm).substring(11, 19); // "HH:mm:ss"

## 3. Script Management — run vs schedule
- POST /api/scripts/{id}/run → One-time execution (test/debug only)
- POST /api/scripts/{id}/schedule → Periodic execution (production use)
- POST /api/scripts/{id}/cancel → Stop scheduled script
- RULE: Use schedule for simulation and periodic scripts, NOT run!
- Bulk: POST /api/scripts/schedule?projectId=X (start all), /api/scripts/unschedule?projectId=X (stop all)
- schType values: Periodic (ms interval), Cron, Once, Manual
- POST /api/scripts requires: name, projectId, code (non-empty), schType, logFlag (boolean)
- Before updating: read with get_script first, show before/after diff

## 4. Tabulator & Chart Script Return Formats
- Tabulator (type=Datatable): return {table: JSON.stringify({columns:[{title:"Name",field:"name"}],layout:"fitColumns"}), data:{0:{name:"X",value:1}}, initTime:null, runTime:null, runTimeFunc:"updateOrAddData"};
- Chart (type=Chart): return {dataset:{0:{name,data,color,fill,step}},type:"line"|"bar",labels:[],xAxes:{0:{labels:[]}},options:{}};
- Optimal points: chartWidthPx/3 (min50,max600). Logged data is reverse-ordered → reverse loop.

## 5. Animation Creation
- POST /api/animations body:{name,projectId,mainFlag:false,duration:2000,playOrder:1,svgContent:"<svg>...</svg>"}
- Element: POST /api/animations/{animationId}/elements body:{animationId,domId,name,dsc:null,type,expressionType,expression,status:true,props}
- Script binding: POST /api/animations/{animationId}/scripts body:{type:"animation",scriptId:ID}
- CRITICAL: props must never be null (at least "{}"). SVG ids = domId. Cross-project: ins.getVariableValue('ProjectName','TagName')
- SVG REQUIRED: <svg> must include: style="width:100%; height:100%;" viewBox="0 0 1920 1080" width="1920" height="1080"
- Element types:
  Get: type:"Get", expressionType:"EXPRESSION", props:"{}"
  Color: type:"Color", expressionType:"SWITCH" — "#hex", "c1/c2"(blink), "c1/c2/gradient/horizontal"
  Visibility: type:"Visibility", expressionType:"EXPRESSION", props:'{"inverse":false}'
  Opacity: type:"Opacity", expressionType:"EXPRESSION", props:'{"min":0,"max":100}'
  Bar: type:"Bar", expressionType:"EXPRESSION"|"TAG", props:'{"min":0,"max":100,"orientation":"Bottom","fillColor":"#04B3FF","duration":1,"opacity":1}'
  Rotate: type:"Rotate", expressionType:"EXPRESSION", props:'{"min":0,"max":360,"offset":"mc"}'
  Move: type:"Move", expressionType:"EXPRESSION" — value={orientation:"H"|"V",minVal,maxVal,minPos,maxPos,value}
  Scale: type:"Scale", expressionType:"EXPRESSION", props:'{"min":0,"max":100,"horizontal":true,"vertical":true}'
  Blink: type:"Blink", expressionType:"EXPRESSION", props:'{"duration":500}'
  Pipe: type:"Pipe", expressionType:"EXPRESSION" — value={color,speed,direction}
  Animate: type:"Animate", expressionType:"EXPRESSION", props:'{"animationName":"bounce","duration":"1s","iterationCount":"infinite"}'
  Tooltip: type:"Tooltip", expressionType:"EXPRESSION", props:'{"title":"","color":"#333","size":12}'
  Image: type:"Image", expressionType:"EXPRESSION" — value=URL/base64
  Peity: type:"Peity", expressionType:"EXPRESSION" — value={type:"bar"|"line"|"pie",data:[],fill:["#c"]}
  GetSymbol: type:"GetSymbol", expressionType:"EXPRESSION" — value=symbol name
  QRCodeGeneration: type:"QRCodeGeneration", expressionType:"EXPRESSION" — value=string
  Faceplate: type:"Faceplate", expressionType:"FACEPLATE", props:'{"faceplateName":"N","alignment":"none","placeholderValues":{"ph":"Var"}}'
  Iframe: type:"Iframe", expressionType:"EXPRESSION" — value=URL
  Slider: type:"Slider", props:'{"variableName":"V","min":0,"max":100}'
  Input: type:"Input", props:'{"variableName":"V"}'
  Button: type:"Button", props:'{"label":"Text","variableName":"V","value":1}'
  Menu: type:"Menu", props:'{"items":[...]}'
  AlarmIndication: type:"AlarmIndication", props:'{"alarmGroupName":"Group"}'
  Access: type:"Access", props:'{"disable":true,"isRoles":true,"roles":[1]}'
  Click(SET): type:"Click", expressionType:"SET", props:'{"variableName":"V","value":1}'
  Click(ANIMATION): type:"Click", expressionType:"ANIMATION", props:'{"animationName":"Target"}'
  Click(SCRIPT): type:"Click", expressionType:"SCRIPT", props:'{"scriptId":123}'
  Chart: type:"Chart", expressionType:"EXPRESSION", expression:"return ins.executeScript('name');", props:'{"scriptId":ID}'
  Datatable: type:"Datatable", same structure as Chart

## 6. Live Value Rules (CRITICAL)
- Live value → MUST use inscada_get_live_value or inscada_get_live_values (NOT inscada_api)
  - Correct: GET /api/variables/value?projectId=X&name=Y (single) / GET /api/variables/values?projectId=X&names=Y1,Y2 (multiple)
  - WRONG (DO NOT USE): /api/variables/live-value, /api/variables/current, /api/runtime/*, /api/communication/*, /api/variables/{id}/live-value, POST /api/variables/live-values
- If project_id unknown → use list_projects, do NOT ask user
- General rule: If you can get info via a tool, do NOT ask user — call the tool

## 7. Frame-Bound Variable Reading (2-step)
- Step 1: inscada_api(POST, /api/variables/filter/pages, query_params:{pageSize:500}, body:{projectId:X, frameId:Y}) → variable list
- Step 2: inscada_get_live_values(project_id:X, variable_names:"name1,name2,...") → live values
- No single endpoint reads values by frameId

## 8. Historical Data & Statistics
- Time series → inscada_logged_values (variable_ids + start_date/end_date)
- Statistics (min, max, avg, count) → inscada_logged_stats (project_id + variable_names)
- Paged: GET /api/variables/loggedValues/pages?variableIds=X&startDate=S&endDate=E&pageSize=5000&pageNumber=0
- Stats: GET /api/variables/loggedValues/stats/hourly (or /daily)?variableIds=X&startDate=S&endDate=E
- Trends: GET /api/trends → groups, GET /api/trends/{id}/tags → tags with variableId, color, scale

## 9. Chart Rules
- MUST call chart tool (chart_line/bar/gauge/multi/forecast). Never say "I showed/drew" without calling the tool.
- chart_line, chart_bar, chart_multi, chart_forecast → variable_names + project_id
- Add series → chart_multi with ALL series together
- Gauge → chart_gauge(variable_name, project_id, auto_refresh=true) directly (do NOT call inscada_get_live_value)
- Forecast → (1) inscada_logged_values, (2) analyze, (3) generate forecast_values, (4) MUST call chart_forecast

## 10. Custom Menu
- CRUD: list_custom_menus, get_custom_menu/get_custom_menu_by_name, create_custom_menu, update_custom_menu, delete_custom_menu
- USE TEMPLATES (gauge/line_chart/gauge_and_chart/multi_chart) — do not send content. Free HTML only if templates are insufficient.
- css and js fields MUST be empty strings. All CSS/JS/HTML goes into html field as complete HTML document
- Format: {"css":"","js":"","html":"<!DOCTYPE html><html>...</html>"}
- Script tag escape: </script> → <\\/script>
- Defaults: target="Home", position="Bottom", menu_order=1
- Before update: read with get_custom_menu first
- CSP: CDN only cdnjs.cloudflare.com, ajax.googleapis.com, cdn.jsdelivr.net. External API forbidden.
- REST API: fetch("/api/...", {credentials:"include", headers:{"X-Space":"space_name","Accept":"application/json"}}). projectId required.
- icon: Font Awesome 5.x Free (fas/far/fab). Default: "fas fa-industry"

## 11. Space Management
- Projects: /api/projects, NOT /api/spaces/{id}/projects (no such endpoint)
- Different space: use set_space tool first
- Default: "default_space" — persists for session

## 12. Tool Priorities
- Space→list_spaces, Project→list_projects, Script→list_scripts/get_script/search_in_scripts, Connection→list_connections, Variable→list_variables, Animation→list_animations/get_animation
- Connection + status → list_connections(include_status=true)
- Variable list → list_variables(project_id), filter with search param
- Animation detail → get_animation(animation_id), SVG: include_svg=true
- If one tool suffices, don't call multiple
- PRIORITY: Dedicated tools always before generic API

## 13. Generic API (inscada_api)
- No dedicated tool → inscada_api_endpoints(search) → inscada_api_schema(path, method) → inscada_api(...)
- path must start with /api/. Path params: {id} format + path_params
- Query params: query_params object. Array values auto-exploded

## 14. Excel Export
- Fetch data first, then export_excel({file_name, sheets:[{name,headers,rows}]})

## 15. Interrupted Task Resume
1. NEVER restart from scratch — check what's already done
2. Before creating resources, query existing ones
3. Before modifying code, read current state
4. Compare target vs current state, perform remaining steps only
5. Summarize completed/remaining before continuing`;

async function executeTool(name, args) {
  const handler = handlers[name];
  if (!handler) throw new Error(`Bilinmeyen tool: ${name}`);
  return await handler(args || {});
}

module.exports = { executeTool, inscadaApi, INSCADA_GUIDE };
