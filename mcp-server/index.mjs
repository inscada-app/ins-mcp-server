#!/usr/bin/env node
/**
 * inSCADA MCP Server
 * Mevcut tool'ları (inSCADA REST API, Chart) MCP protokolü üzerinden dışarıya açar.
 * Claude Desktop, VS Code Copilot ve diğer MCP client'lar bağlanabilir.
 *
 * Kullanım: node index.mjs
 * npx:      npx @inscada/mcp-server
 */

import { createRequire } from "module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
// CommonJS modüllerini yükle
const require = createRequire(import.meta.url);
require("dotenv").config();
// Paketlenmiş .cjs dosyalarını dene, yoksa parent'tan yükle (dev ortamı)
let TOOLS, executeTool, inscadaApi, telemetry;
try {
  TOOLS = require("./tools.cjs");
  ({ executeTool, inscadaApi } = require("./tool-handlers.cjs"));
  telemetry = require("./telemetry-influx.cjs");
} catch {
  TOOLS = require("../tools.js");
  ({ executeTool, inscadaApi } = require("../tool-handlers.js"));
  telemetry = require("../telemetry-influx.js");
}
const { init, write, flush, shutdown, uptimeSeconds } = telemetry;

// MCP Server kuralları — AI client'lara iletilir
const SERVER_INSTRUCTIONS = `
# inSCADA MCP Server — Rules & Best Practices

## 1. MCP Security
- inscada_set_value, inscada_run_script, update_script are BLOCKED in MCP mode
- These can only be executed through the inSCADA AI Assistant app with user confirmation
- inscada_api ile GET istekleri serbest, POST/PUT/DELETE/PATCH → kullanıcı onayı gerekir

## 2. Script Yazma Kuralları (ÇOK ÖNEMLİ)
- Motor: Nashorn ECMAScript 5 (JDK11). let/const, arrow function (=>), template literal, destructuring, async/await, class KULLANMA. Sadece var, function, for, if/else, try/catch, switch, while.
- YAPI: Tüm script kodu function bloğuna SARILMALI ve en altta çağrılmalı:
  function main() {
    // kod buraya
  }
  main();
- Global objeler: ins (SCADA API), user (kullanıcı), require(ins, "scriptName"), toJS(javaObj), fixJSONStr(str)
- ins.* API (sık kullanılanlar):
  Değer okuma: ins.getVariableValue(name) → {value, date}
  Değer yazma: ins.setVariableValue(name, {value: N})
  Toplu okuma: ins.getVariableValues(names[]) → {name: {value}, ...}
  Toggle: ins.toggleVariableValue(name)
  Connection: ins.getConnectionStatus(name), ins.startConnection(name), ins.stopConnection(name)
  Alarm: ins.getAlarmStatus(name), ins.activateAlarmGroup(name), ins.deactivateAlarmGroup(name)
  Alarm fired: ins.getLastFiredAlarms(index, count), ins.getAlarmLastFiredAlarms(includeOff)
  Script: ins.executeScript(name), ins.getGlobalObject(name), ins.setGlobalObject(name, obj)
  Log: ins.writeLog(type, activity, msg) — type: "INFO"/"WARN"/"ERROR"
  Bildirim: ins.sendMail(users[], subject, content), ins.sendSMS(users[], message), ins.notify(type, title, msg)
  Tarihsel: ins.getLoggedVariableValuesByPage(names[], start, end, page, size)
  İstatistik: ins.getLoggedVariableValueStats(names[], start, end)
  Yardımcı: ins.now(), ins.uuid(), ins.ping(addr, timeout), ins.rest(method, url, contentType, body)
  SQL: ins.runSql(sql), ins.runSql(datasource, sql)
  Dosya: ins.writeToFile(name, text, append), ins.readFile(name)
  Sistem: ins.consoleLog(obj), ins.refreshAllClients()
- Çoğu method'un (projectName, ...) ve (...) overload'u var. projectName verilmezse script'in bağlı olduğu proje kullanılır.
- Java koleksiyonları JS'e dönüştürmek için toJS() kullan: var list = toJS(ins.getVariables())
- require ile modül import: var helper = require(ins, "HelperScript"); helper.myFunc();
- Tarih oluşturma: var now = ins.now(); var d = ins.getDate(1709251200000); veya new java.util.Date()
- setVariableValue detay objesi: {value: N} — sadece value key'i zorunlu
- Anlık veri tarihi: ins.getVariableValue() dönüşündeki dateInMs epoch ms'dir. Doğru: var diffMs = ins.now().getTime() - varValue.dateInMs;
- Tarihsel veri tarihi: ins.getLoggedVariableValuesByPage() dönüşündeki dttm alanı ISO 8601 string'dir. Nashorn'da new Date(isoString) çalışmaz (NaN döner). Zaman bilgisi için: var timeStr = ("" + items[i].dttm).substring(11, 19); kullan.

## 3. Script Management — run vs schedule
- POST /api/scripts/{id}/run → One-time execution (test/debug only)
- POST /api/scripts/{id}/schedule → Periodic execution (production use)
- POST /api/scripts/{id}/cancel → Stop scheduled script
- RULE: Use \`schedule\` for simulation and periodic scripts, NOT \`run\`!
- Bulk: POST /api/scripts/schedule?projectId=X (start all), /api/scripts/unschedule?projectId=X (stop all)
- schType values: Periodic (ms interval), Cron, Once, Manual
- POST /api/scripts requires: name, projectId, code (non-empty), schType, logFlag (boolean)
- Script güncellemede ÖNCE get_script ile oku, kod değişikliklerinde önce/sonra farkını göster

## 4. Tabulator & Chart Script Dönüş Formatları
- Tabulator (animation element type=Datatable): return {table: JSON.stringify({columns:[{title:"Ad",field:"name"}],layout:"fitColumns"}), data:{0:{name:"X",value:1}}, initTime:null, runTime:null, runTimeFunc:"updateOrAddData"};
- Chart (animation element type=Chart): return {dataset:{0:{name,data,color,fill,step}},type:"line"|"bar",labels:[],xAxes:{0:{labels:[]}},options:{}};
- Chart veri kuralları: Optimal nokta=chartWidthPx/3 (min50,max600), fazla veri→downsample. Logged data ters sıralı gelir→ters döngü kullan.

## 5. Animasyon Oluşturma
- POST /api/animations body:{name,projectId,mainFlag:false,duration:2000,playOrder:1,svgContent:"<svg>...</svg>"}
- Element: POST /api/animations/{animationId}/elements body:{animationId,domId,name,dsc:null,type,expressionType,expression,status:true,props}
- Script bağlama: POST /api/animations/{animationId}/scripts body:{type:"animation",scriptId:ID}
- KRİTİK: props asla null olamaz (en az "{}"). SVG id'leri=domId. Cross-project: ins.getVariableValue('ProjectName','TagName')
- SVG ZORUNLU: <svg> tag'i şu 3 özelliği İÇERMELİ: style="width:100%; height:100%;" viewBox="0 0 1920 1080" width="1920" height="1080"
- Element type'ları (type, expressionType, props):
  Get: type:"Get", expressionType:"EXPRESSION", props:"{}" — value→textContent
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
  GetSymbol: type:"GetSymbol", expressionType:"EXPRESSION" — value=symbol adı
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
  Datatable: type:"Datatable", aynı yapı

## 6. Canlı Değer Kuralları (ÇOK ÖNEMLİ)
- Canlı değer → MUTLAKA inscada_get_live_value veya inscada_get_live_values tool'unu kullan (inscada_api DEĞİL)
  - Doğru endpoint: GET /api/variables/value?projectId=X&name=Y (tek) / GET /api/variables/values?projectId=X&names=Y1,Y2 (çoklu)
  - YANLIŞ endpoint'ler (KULLANMA): /api/variables/live-value, /api/variables/current, /api/runtime/*, /api/communication/*, /api/variables/{id}/live-value, POST /api/variables/live-values
- project_id bilmiyorsan list_projects ile öğren, kullanıcıya SORMA
- variable_name bilmiyorsan kullanıcıya sor veya workspace context'ten al
- Genel kural: Bir bilgiyi tool ile öğrenebiliyorsan kullanıcıya SORMA, tool'u çağır

## 7. Frame'e Bağlı Değişken Okuma (2 adımlı)
- Adım 1: inscada_api(POST, /api/variables/filter/pages, query_params:{pageSize:500}, body:{projectId:X, frameId:Y}) → variable listesi
- Adım 2: inscada_get_live_values(project_id:X, variable_names:"name1,name2,...") → canlı değerler
- Tek adımda frameId ile value okuyan endpoint yoktur

## 8. Tarihsel Veri ve İstatistik
- Tarihsel zaman serisi → inscada_logged_values (variable_ids + start_date/end_date)
- İstatistikler (min, max, avg, count) → inscada_logged_stats (project_id + variable_names)
- Paged: GET /api/variables/loggedValues/pages?variableIds=X&startDate=S&endDate=E&pageSize=5000&pageNumber=0
- Stats: GET /api/variables/loggedValues/stats/hourly (or /daily)?variableIds=X&startDate=S&endDate=E
- Trends: GET /api/trends → groups, GET /api/trends/{id}/tags → tags with variableId, color, scale

## 9. Chart Kuralları
- Grafik istenince MUTLAKA ilgili chart tool'unu çağır (chart_line/bar/gauge/multi/forecast). Tool çağırmadan "gösterdim/çizdim" DEME.
- chart_line, chart_bar, chart_multi, chart_forecast → variable_names + project_id ile çağır
- Yeni seri ekleme → chart_multi ile TÜM serileri birlikte çiz
- Gauge → doğrudan chart_gauge(variable_name, project_id, auto_refresh=true) çağır (inscada_get_live_value çağırma)
- Tahmin → (1) inscada_logged_values ile veri çek, (2) analiz et, (3) forecast_values üret, (4) MUTLAKA chart_forecast çağır

## 10. Custom Menü
- CRUD: list_custom_menus, get_custom_menu/get_custom_menu_by_name, create_custom_menu, update_custom_menu, delete_custom_menu
- TEMPLATE KULLAN (gauge/line_chart/gauge_and_chart/multi_chart) — content GÖNDERME. Serbest HTML sadece şablonlar yetersizse.
- \`css\` ve \`js\` alanları MUTLAKA boş string olmalı. Tüm CSS/JS/HTML \`html\` alanına complete HTML document olarak yazılmalı
- Format: {"css":"","js":"","html":"<!DOCTYPE html><html>...</html>"}
- Script tag escape: </script> → <\\/script>
- Varsayılanlar: target="Home", position="Bottom", menu_order=1
- Güncelleme: önce get_custom_menu ile oku
- CSP: CDN sadece cdnjs.cloudflare.com, ajax.googleapis.com, cdn.jsdelivr.net. Harici API yasak (connect-src: self).
- REST API çağrısı: fetch("/api/...", {credentials:"include", headers:{"X-Space":"space_adi","Accept":"application/json"}}). projectId zorunlu.
- icon: Font Awesome 5.x Free (fas/far/fab). Varsayılan: "fas fa-industry"

## 11. Space Management
- Projects are listed from \`/api/projects\`, NOT \`/api/spaces/{id}/projects\` (no such endpoint)
- To access a different space, use the \`set_space\` tool first
- Default space is "default_space" — changes persist for the session

## 12. Tool Öncelikleri
- Space→list_spaces, Proje→list_projects, Script→list_scripts/get_script/search_in_scripts, Connection→list_connections, Değişken→list_variables, Animasyon→list_animations/get_animation
- Connection listesi ve durumu → list_connections(include_status=true)
- Değişken listesi → list_variables(project_id), search parametresiyle filtrelenir
- Animasyon detayı → get_animation(animation_id), SVG için include_svg=true
- Tek tool yeterliyse birden fazla çağırma
- ÖNCELİK: Özel tool'lar her zaman generic API'den önce gelir

## 13. Generic API (inscada_api)
- Özel tool yoksa → inscada_api_endpoints(search) ile endpoint bul → inscada_api_schema(path, method) ile parametreleri öğren → inscada_api(...) ile çağır
- path her zaman /api/ ile başlamalı. Path parametreleri: {id} formatı + path_params ile değiştirilir
- Query parametreleri: query_params objesi olarak gönder. Array değerler otomatik explode edilir

## 14. Excel Export
- Önce veriyi çek, sonra export_excel({file_name, sheets:[{name,headers,rows}]})

## 15. Interrupted Task Resume
When a long-running task is interrupted (timeout, retry, or reconnection):
1. NEVER restart from scratch — first check what has already been done
2. Before creating resources, query existing ones to see what was already created
3. Before modifying code, read the current state to see if changes were already applied
4. Compare target state with current state, then only perform remaining steps
5. Summarize what was already completed and what remains before continuing

## 16. Response Format
- __table sonucu olan tool'ların verileri frontend'de tablo olarak gösterilir. Verileri tekrar listeleme.
- Sadece kısa yorum/özet yaz (örn: "5 proje bulundu" veya "Script kodu aşağıda").
`.trim();

// MCP Server oluştur
const server = new Server(
  {
    name: "inscada-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: SERVER_INSTRUCTIONS,
  }
);

let toolCount = 0;

const DANGEROUS_TOOLS = new Set(["inscada_set_value", "inscada_run_script", "update_script"]);

// tools/list — Mevcut tool tanımlarını MCP formatında döndür
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
    })),
  };
});

// tools/call — Tool çağrısını mevcut handler'lara yönlendir
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (DANGEROUS_TOOLS.has(name)) {
    write("tool_call", { tool: name, success: "false", source: "mcp" }, {
      duration_ms: 0,
      params_preview: "BLOCKED: dangerous tool",
    });
    flush();
    return {
      content: [{ type: "text", text: `Güvenlik: "${name}" MCP üzerinden çalıştırılamaz. Bu işlem sadece inSCADA AI Asistan uygulamasından onay ile yapılabilir.` }],
      isError: true,
    };
  }

  const start = Date.now();
  try {
    const result = await executeTool(name, args);
    const durationMs = Date.now() - start;
    toolCount++;

    write("tool_call", { tool: name, success: "true", source: "mcp" }, {
      duration_ms: durationMs,
      params_preview: JSON.stringify(args).substring(0, 200),
    });
    flush();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const durationMs = Date.now() - start;
    toolCount++;

    write("tool_call", { tool: name, success: "false", source: "mcp" }, {
      duration_ms: durationMs,
      params_preview: JSON.stringify(args).substring(0, 200),
    });
    write("error", { source: "mcp", tool: name }, {
      message: (error.message || "").substring(0, 500),
    });
    flush();

    return {
      content: [
        {
          type: "text",
          text: `Hata: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Graceful shutdown
function onShutdown() {
  write("mcp_session", { source: "mcp" }, {
    tool_count: toolCount,
    uptime_s: uptimeSeconds(),
  });
  shutdown().finally(() => process.exit(0));
}
process.on("SIGINT", onShutdown);
process.on("SIGTERM", onShutdown);

// Sunucuyu başlat
async function main() {
  init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("inSCADA MCP Server başlatıldı (stdio)");
  console.error(`${TOOLS.length} tool kayıtlı`);

  // inSCADA versiyonunu lazy olarak bir kez al
  setTimeout(async () => {
    try {
      const ver = await inscadaApi.request("GET", "/api/version");
      const version = typeof ver === "string" ? ver : (ver.version || ver.raw || JSON.stringify(ver));
      telemetry.setInscadaVersion(version.replace(/["\s]/g, ""));
      console.error(`[telemetry] inSCADA version: ${version}`);
    } catch (e) {
      console.error(`[telemetry] inSCADA version alınamadı: ${e.message}`);
    }
  }, 5000);
}

main().catch((error) => {
  console.error("MCP Server başlatılamadı:", error);
  process.exit(1);
});
