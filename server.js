/**
 * inSCADA AI Asistan Server
 * Express backend - Claude/Ollama LLM adapter ile tool_use döngüsü
 */

require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const TOOLS = require("./tools");
const { executeTool, inscadaApi } = require("./tool-handlers");
const telemetry = require("./telemetry-influx");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// LLM Provider Config
// ============================================================
const LLM_PROVIDER = process.env.LLM_PROVIDER || "claude";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:14b";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// Claude API client — sadece claude modunda yükle
let anthropic = null;
if (LLM_PROVIDER === "claude") {
  const Anthropic = require("@anthropic-ai/sdk");
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// Gemini/OpenAI — raw HTTP kullanır, SDK gerekmez

// Middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));

// Chart dosyalarını serve et - artık gerekli değil ama ileride eklenebilir
// app.use("/charts", express.static(...));

// Konuşma geçmişi (memory - basit in-memory)
const conversations = new Map();

// SCADA yazma işlemleri için onay mekanizması
const DANGEROUS_TOOLS = new Set(["inscada_set_value", "inscada_run_script", "update_script"]);
// inscada_api: GET serbest, diğer method'lar tehlikeli (dinamik kontrol aşağıda)
function isDangerousTool(toolName, toolInput) {
  if (DANGEROUS_TOOLS.has(toolName)) return true;
  if (toolName === "inscada_api" && toolInput && toolInput.method && toolInput.method.toUpperCase() !== "GET") return true;
  return false;
}
const pendingActions = new Map(); // actionId → { tool, input }

// ============================================================
// Table Bypass — tool sonuçlarını Claude'dan geçirmeden frontend'de göster
// ============================================================

function genericListFormat(title, toolName) {
  return function (result) {
    if (!Array.isArray(result) || !result.length) return null;
    const cols = Object.keys(result[0]);
    return {
      __table: true,
      title: `${title} (${result.length})`,
      columns: cols,
      rows: result.map(r => cols.map(c => r[c])),
      display_hint: "table",
      meta: { tool: toolName, row_count: result.length },
    };
  };
}

const BYPASS_TOOLS = {
  // Tier 1 — Basit Listeler
  list_spaces: { formatFn: genericListFormat("Space Listesi", "list_spaces") },
  list_projects: { formatFn: genericListFormat("Proje Listesi", "list_projects") },
  list_scripts: { formatFn: genericListFormat("Script Listesi", "list_scripts") },
  list_custom_menus: { formatFn: genericListFormat("Custom Menu Listesi", "list_custom_menus") },
  list_connections: { formatFn: genericListFormat("Connection Listesi", "list_connections") },
  list_variables: {
    formatFn(result) {
      const items = result && result.variables;
      if (!Array.isArray(items) || !items.length) return null;
      const cols = Object.keys(items[0]);
      const title = `Değişken Listesi (${result.total || items.length} toplam, sayfa ${(result.page || 0) + 1}/${result.total_pages || 1})`;
      return {
        __table: true, title, columns: cols,
        rows: items.map(r => cols.map(c => r[c])),
        display_hint: "table",
        meta: { tool: "list_variables", row_count: items.length, total: result.total },
      };
    },
  },

  list_animations: { formatFn: genericListFormat("Animasyon Listesi", "list_animations") },

  search_in_scripts: {
    formatFn(result) {
      if (!result || result.error || !result.results || !result.results.length) return null;
      const cols = Object.keys(result.results[0]);
      return {
        __table: true,
        title: `Script Arama Sonuçları (${result.count || result.results.length})`,
        columns: cols,
        rows: result.results.map(r => cols.map(c => r[c])),
        display_hint: "table",
        meta: { tool: "search_in_scripts", row_count: result.results.length },
      };
    },
  },

  // Tier 2 — REST API Okuma
  inscada_get_live_value: {
    formatFn(result) {
      if (!result || result.error) return null;
      const val = result.value !== undefined ? result.value : null;
      if (val === null) return null;
      const rows = [["Değer", val], ["Tarih", result.date || "-"]];
      if (result.variableShortInfo) {
        const info = result.variableShortInfo;
        if (info.name) rows.push(["Değişken", info.name]);
        if (info.project) rows.push(["Proje", info.project]);
        if (info.connection) rows.push(["Bağlantı", info.connection]);
      }
      return {
        __table: true,
        title: "Canlı Değer",
        columns: ["Özellik", "Değer"],
        rows,
        display_hint: "key_value",
        meta: { tool: "inscada_get_live_value", row_count: 1 },
      };
    },
  },

  inscada_get_live_values: {
    formatFn(result) {
      if (!result || result.error || typeof result !== "object") return null;
      const keys = Object.keys(result).filter(k => !k.startsWith("_") && k !== "error");
      if (!keys.length) return null;
      return {
        __table: true,
        title: `Canlı Değerler (${keys.length} değişken)`,
        columns: ["Değişken", "Değer", "Tarih"],
        rows: keys.map(k => {
          const v = result[k];
          return [k, v?.value !== undefined ? v.value : v, v?.date || "-"];
        }),
        display_hint: "table",
        meta: { tool: "inscada_get_live_values", row_count: keys.length },
      };
    },
  },

  inscada_get_fired_alarms: {
    formatFn(result) {
      if (!Array.isArray(result) || !result.length) return null;
      const cols = ["name", "status", "onTime", "dsc", "firedAlarmType", "part"];
      const availCols = cols.filter(c => result[0][c] !== undefined);
      if (!availCols.length) return null;
      return {
        __table: true,
        title: `Aktif Alarmlar (${result.length})`,
        columns: availCols,
        rows: result.map(r => availCols.map(c => r[c])),
        display_hint: "status",
        meta: { tool: "inscada_get_fired_alarms", row_count: result.length },
      };
    },
  },

  inscada_connection_status: {
    formatFn(result) {
      if (!result || result.error || typeof result !== "object") return null;
      const keys = Object.keys(result).filter(k => !k.startsWith("_") && k !== "error");
      if (!keys.length) return null;
      return {
        __table: true,
        title: `Bağlantı Durumları (${keys.length})`,
        columns: ["Bağlantı ID", "Durum"],
        rows: keys.map(k => [k, result[k]]),
        display_hint: "status",
        meta: { tool: "inscada_connection_status", row_count: keys.length },
      };
    },
  },

  inscada_project_status: {
    formatFn(result) {
      if (!result || result.error || typeof result !== "object") return null;
      const keys = Object.keys(result).filter(k => !k.startsWith("_") && k !== "error");
      if (!keys.length) return null;
      const rows = [];
      for (const k of keys) {
        const v = result[k];
        if (typeof v === "object" && v !== null) {
          rows.push([k, JSON.stringify(v)]);
        } else {
          rows.push([k, v]);
        }
      }
      return {
        __table: true,
        title: "Proje Durumu",
        columns: ["Bölüm", "Durum"],
        rows,
        display_hint: "key_value",
        meta: { tool: "inscada_project_status", row_count: rows.length },
      };
    },
  },

  inscada_script_status: {
    formatFn(result) {
      if (result === undefined || result === null || result.error) return null;
      const status = typeof result === "string" ? result : JSON.stringify(result);
      return {
        __table: true,
        title: "Script Durumu",
        columns: ["Özellik", "Değer"],
        rows: [["Durum", status]],
        display_hint: "key_value",
        meta: { tool: "inscada_script_status", row_count: 1 },
      };
    },
  },

  inscada_logged_values: {
    formatFn(result) {
      if (!Array.isArray(result) || !result.length) return null;
      const cols = Object.keys(result[0]);
      const MAX = 200;
      const trunc = result.length > MAX;
      const display = trunc ? result.slice(0, MAX) : result;
      return {
        __table: true,
        title: `Tarihsel Değerler (${result.length} kayıt)`,
        columns: cols,
        rows: display.map(r => cols.map(c => r[c])),
        display_hint: "table",
        meta: { tool: "inscada_logged_values", row_count: display.length, truncated: trunc, total_rows: result.length },
      };
    },
  },

  inscada_logged_stats: {
    formatFn(result) {
      if (!Array.isArray(result) || !result.length) return null;
      const cols = Object.keys(result[0]);
      const MAX = 200;
      const trunc = result.length > MAX;
      const display = trunc ? result.slice(0, MAX) : result;
      return {
        __table: true,
        title: `İstatistikler (${result.length} kayıt)`,
        columns: cols,
        rows: display.map(r => cols.map(c => r[c])),
        display_hint: "table",
        meta: { tool: "inscada_logged_stats", row_count: display.length, truncated: trunc, total_rows: result.length },
      };
    },
  },

  // Tier 3 — Detay Gösterimi
  get_script: {
    formatFn(result) {
      if (!result || result.error || result.warning || !result.code) return null;
      return {
        __table: true,
        title: `Script: ${result.name || "?"} (ID: ${result.script_id || "?"})`,
        columns: ["Özellik", "Değer"],
        rows: [
          ["Script ID", result.script_id],
          ["Ad", result.name],
          ["Proje", result.project_name || "-"],
          ["Space", result.space_name || "-"],
          ["Zamanlama", result.sch_type || "-"],
          ["Son Güncelleme", result.version_dttm || "-"],
        ],
        display_hint: "code",
        code: result.code,
        code_language: "javascript",
        meta: { tool: "get_script", row_count: 1, code_length: result.code.length },
      };
    },
  },

  get_custom_menu: {
    formatFn(result) {
      if (!result || result.error || typeof result !== "object") return null;
      const excludeKeys = new Set(["error", "_truncated", "_original_size"]);
      const keys = Object.keys(result).filter(k => !excludeKeys.has(k));
      if (!keys.length) return null;
      const hasContent = result.content && typeof result.content === "string" && result.content.length > 100;
      return {
        __table: true,
        title: `Custom Menu: ${result.name || "?"}`,
        columns: ["Özellik", "Değer"],
        rows: keys.filter(k => k !== "content").map(k => [k, result[k]]),
        display_hint: hasContent ? "code" : "key_value",
        code: hasContent ? result.content : undefined,
        code_language: hasContent ? "html" : undefined,
        meta: { tool: "get_custom_menu", row_count: 1 },
      };
    },
  },

  get_custom_menu_by_name: {
    formatFn(result) {
      // Same logic as get_custom_menu
      if (!result || result.error || typeof result !== "object") return null;
      const excludeKeys = new Set(["error", "_truncated", "_original_size"]);
      const keys = Object.keys(result).filter(k => !excludeKeys.has(k));
      if (!keys.length) return null;
      const hasContent = result.content && typeof result.content === "string" && result.content.length > 100;
      return {
        __table: true,
        title: `Custom Menu: ${result.name || "?"}`,
        columns: ["Özellik", "Değer"],
        rows: keys.filter(k => k !== "content").map(k => [k, result[k]]),
        display_hint: hasContent ? "code" : "key_value",
        code: hasContent ? result.content : undefined,
        code_language: hasContent ? "html" : undefined,
        meta: { tool: "get_custom_menu_by_name", row_count: 1 },
      };
    },
  },
};

// ============================================================
// LLM Adapter — Claude ve Ollama (OpenAI-compat) arası köprü
// ============================================================

/**
 * Claude tool formatını OpenAI function calling formatına dönüştür
 * Claude: {name, description, input_schema}
 * OpenAI: {type:"function", function:{name, description, parameters}}
 */
function convertToolsToOpenAI(tools) {
  return tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/**
 * Claude mesaj formatını OpenAI chat formatına dönüştür
 * - system param → {role:"system"} mesajı (ayrı verilir)
 * - assistant tool_use blokları → assistant message with tool_calls
 * - user tool_result blokları → {role:"tool"} mesajları
 */
function convertMessagesToOpenAI(systemPrompt, messages) {
  const result = [{ role: "system", content: systemPrompt }];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      // Content array ise tool_use blokları içerebilir
      if (Array.isArray(msg.content)) {
        let textParts = "";
        const toolCalls = [];

        for (const block of msg.content) {
          if (block.type === "text") {
            textParts += block.text;
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }

        const assistantMsg = { role: "assistant", content: textParts || null };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        result.push(assistantMsg);
      } else {
        // Basit text mesaj
        result.push({ role: "assistant", content: msg.content });
      }
    } else if (msg.role === "user") {
      // Content array ise tool_result blokları içerebilir
      if (Array.isArray(msg.content)) {
        const toolResults = [];
        let textParts = "";

        for (const block of msg.content) {
          if (block.type === "tool_result") {
            toolResults.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
            });
          } else if (block.type === "text") {
            textParts += block.text;
          }
        }

        // Önce text varsa ekle
        if (textParts) {
          result.push({ role: "user", content: textParts });
        }
        // Tool result'ları ayrı mesaj olarak ekle
        for (const tr of toolResults) {
          result.push(tr);
        }
      } else {
        result.push({ role: "user", content: msg.content });
      }
    }
  }

  return result;
}

/**
 * Ollama (OpenAI-compat) yanıtını Claude response formatına normalize et
 * Böylece chat() döngüsü hiç değişmeden çalışır.
 */
function normalizeOllamaResponse(ollamaResp) {
  const choice = ollamaResp.choices?.[0];
  if (!choice) {
    return {
      content: [{ type: "text", text: "Ollama yanıt vermedi." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const msg = choice.message;
  const content = [];

  // Text kısmı
  if (msg.content) {
    content.push({ type: "text", text: msg.content });
  }

  // Tool calls → Claude tool_use blokları
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      let args = {};
      try {
        args = typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments;
      } catch { /* JSON parse hatası — boş args */ }

      content.push({
        type: "tool_use",
        id: tc.id || `ollama_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        name: tc.function.name,
        input: args,
      });
    }
  }

  // Content boşsa text ekle
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return {
    content,
    stop_reason: choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
    usage: {
      input_tokens: ollamaResp.usage?.prompt_tokens || 0,
      output_tokens: ollamaResp.usage?.completion_tokens || 0,
    },
  };
}

/**
 * Unified LLM adapter — provider'a göre Claude veya Ollama'ya istek atar.
 * Her iki durumda Claude-uyumlu response döner. chat() döngüsü değişmez.
 */
/**
 * Ollama'ya http modülü ile istek at (fetch'in headers timeout sorunu yok)
 */
/**
 * OpenAI-compat API'ye http/https ile istek at (Bearer token ile)
 * openai SDK bazı provider'larla uyumsuz, bu her yerde çalışır.
 */
function ollamaOpenAIRequest(url, apiKey, bodyObj) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const proto = parsed.protocol === "https:" ? require("https") : require("http");
    const payload = JSON.stringify(bodyObj);

    const req = proto.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname,
      method: "POST",
      timeout: 600000,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Authorization": `Bearer ${apiKey}`,
      },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`API hatası (${res.statusCode}): ${body.substring(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("API yanıtı JSON olarak okunamadı"));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error("API zaman aşımı (10 dk)")); });
    req.write(payload);
    req.end();
  });
}

function ollamaRequest(url, bodyObj) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const proto = parsed.protocol === "https:" ? require("https") : require("http");
    const payload = JSON.stringify(bodyObj);

    const req = proto.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: "POST",
      timeout: 600000, // 10 dk
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Ollama hatası (${res.statusCode}): ${body.substring(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("Ollama yanıtı JSON olarak okunamadı"));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error("Ollama zaman aşımı (10 dk)")); });
    req.write(payload);
    req.end();
  });
}

async function callLLM(systemPrompt, messages, tools, maxTokens) {
  if (LLM_PROVIDER === "ollama") {
    const openaiTools = convertToolsToOpenAI(tools);
    const openaiMessages = convertMessagesToOpenAI(systemPrompt, messages);

    const body = {
      model: OLLAMA_MODEL,
      messages: openaiMessages,
      tools: openaiTools,
      max_tokens: maxTokens,
      temperature: 0.1,
      stream: false,
    };

    const ollamaResp = await ollamaRequest(
      `${OLLAMA_BASE_URL}/v1/chat/completions`,
      body
    );
    return normalizeOllamaResponse(ollamaResp);
  }

  if (LLM_PROVIDER === "gemini") {
    const openaiTools = convertToolsToOpenAI(tools);
    const openaiMessages = convertMessagesToOpenAI(systemPrompt, messages);

    const params = {
      model: GEMINI_MODEL,
      messages: openaiMessages,
      tools: openaiTools,
      max_completion_tokens: maxTokens,
    };

    if (!GEMINI_BASE_URL.includes("cerebras")) {
      params.temperature = 0.1;
    }

    // Raw HTTP request — bazı provider'lar openai SDK ile uyumsuz
    const chatUrl = GEMINI_BASE_URL.replace(/\/+$/, "") + "/chat/completions";
    const ollamaResp = await ollamaOpenAIRequest(chatUrl, GEMINI_API_KEY, params);
    return normalizeOllamaResponse(ollamaResp);
  }

  // Claude (varsayılan)
  return await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    system: systemPrompt,
    tools,
    messages,
  });
}

const SYSTEM_PROMPT = `Sen inSCADA AI asistanısın. SCADA projeleri, scriptler ve endüstriyel veri analizi konusunda yardım ediyorsun. Kullanıcının dilinde yanıt ver.

Kurallar:
- Script güncellemede ÖNCE get_script ile oku
- inscada_set_value → kullanıcıdan onay al (gerçek ekipman komutu)
- Kod değişikliklerinde önce/sonra farkını göster

Script Yazma Kuralları (ÇOK ÖNEMLİ):
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
- Anlık veri tarihi: ins.getVariableValue() dönüşündeki dateInMs epoch ms'dir. Doğru: var diffMs = ins.now().getTime() - varValue.dateInMs; date alanı Java Date objesidir, string parse güvenilir değildir.
- Tarihsel veri tarihi: ins.getLoggedVariableValuesByPage() dönüşündeki dttm alanı ISO 8601 string'dir (örn: "2026-03-03T23:53:23.508+03:00"), epoch ms DEĞİLDİR. Nashorn'da new Date(isoString) çalışmaz (NaN döner). Zaman bilgisi için: var timeStr = ("" + items[i].dttm).substring(11, 19); kullan.
- Tabulator desteği: Script'ler animation element (type=datatable) için Tabulator-uyumlu JSON döndürebilir:
  return {table: JSON.stringify({columns:[{title:"Ad",field:"name"},{title:"Değer",field:"value"}],layout:"fitColumns"}), data:{0:{name:"X",value:1}}, initTime:null, runTime:null, runTimeFunc:"updateOrAddData"};
  table=Tabulator config (JSON string, columns zorunlu), data=satır verileri (obje key=index), runTimeFunc=güncelleme metodu.
- Chart desteği: type=chart element için {dataset:{0:{name,data,color,fill,step}},type:"line"|"bar",labels:[],xAxes:{0:{labels:[]}},options:{}} döndür.
- Chart veri kuralları: Optimal nokta=chartWidthPx/3 (min50,max600), fazla veri→downsample. Label: ≤1h→substring(11,19), ≤24h→substring(11,16), >24h→substring(5,10)+" "+substring(11,16). Logged data ters sıralı gelir→ters döngü kullan. require(ins,"name") fonksiyon property döndürmez→helper'ları inline yaz.
- Animasyon oluşturma (inscada_api ile):
  POST /api/animations body:{name,projectId,mainFlag:false,duration:2000,playOrder:1,svgContent:"<svg>...</svg>"}
  Element: POST /api/animations/{animationId}/elements body:{animationId,domId,name,dsc:null,type,expressionType,expression,status:true,props}
  Script bağlama: POST /api/animations/{animationId}/scripts body:{type:"animation",scriptId:ID} — bağlanan script'teki fonksiyonlar element expression'da direkt çağrılır: expression:"return bar();" (require kullanılmaz)
  Element type'ları (type, expressionType, props):
    Chart: type:"Chart", expressionType:"EXPRESSION", expression:"return ins.executeScript('name');", props:"{\"scriptId\":ID}"
    Datatable: type:"Datatable", aynı yapı (script Tabulator JSON döndürür)
    Get: type:"Get", expressionType:"EXPRESSION", props:"{}" — value→textContent
    Color: type:"Color", expressionType:"SWITCH" — renk: "#hex", "c1/c2"(blink), "c1/c2/gradient/horizontal"
    Visibility: type:"Visibility", expressionType:"EXPRESSION", props:'{"inverse":false}' — value=bool
    Opacity: type:"Opacity", expressionType:"EXPRESSION", props:'{"min":0,"max":100}' — value=number→opacity
    Bar: type:"Bar", expressionType:"EXPRESSION"|"TAG", props:'{"min":0,"max":100,"orientation":"Bottom","fillColor":"#04B3FF","duration":1,"opacity":1}' — orientation:"Bottom"|"Top"|"Left"|"Right"
    Rotate: type:"Rotate", expressionType:"EXPRESSION", props:'{"min":0,"max":360,"offset":"mc"}' — offset: tl/tc/tr/ml/mc/mr/bl/bc/br
    Move: type:"Move", expressionType:"EXPRESSION" — value={orientation:"H"|"V",minVal,maxVal,minPos,maxPos,value}
    Scale: type:"Scale", expressionType:"EXPRESSION", props:'{"min":0,"max":100,"horizontal":true,"vertical":true}'
    Blink: type:"Blink", expressionType:"EXPRESSION", props:'{"duration":500}' — value=bool
    Pipe: type:"Pipe", expressionType:"EXPRESSION" — value={color,speed,direction} akış animasyonu
    Animate: type:"Animate", expressionType:"EXPRESSION", props:'{"animationName":"bounce","duration":"1s","iterationCount":"infinite"}'
    Tooltip: type:"Tooltip", expressionType:"EXPRESSION", props:'{"title":"","color":"#333","size":12}'
    Image: type:"Image", expressionType:"EXPRESSION" — value=URL/base64
    Peity: type:"Peity", expressionType:"EXPRESSION" — value={type:"bar"|"line"|"pie",data:[],fill:["#c"]}
    GetSymbol: type:"GetSymbol", expressionType:"EXPRESSION" — value=symbol adı
    QRCodeGeneration: type:"QRCodeGeneration", expressionType:"EXPRESSION" — value=string
    Faceplate: type:"Faceplate", expressionType:"FACEPLATE", props:'{"faceplateName":"N","alignment":"none","placeholderValues":{"ph":"Var"}}'
    Iframe: type:"Iframe", expressionType:"EXPRESSION" — value=URL
    Slider: type:"Slider", props:'{"variableName":"V","min":0,"max":100}' | Input: type:"Input", props:'{"variableName":"V"}'
    Button: type:"Button", props:'{"label":"Text","variableName":"V","value":1}' | Menu: type:"Menu", props:'{"items":[...]}'
    AlarmIndication: type:"AlarmIndication", props:'{"alarmGroupName":"Group"}' | Access: type:"Access", props:'{"disable":true,"isRoles":true,"roles":[1]}'
    Click(SET): type:"Click", expressionType:"SET", props:'{"variableName":"V","value":1}' — tıkla→değer yaz
    Click(ANIMATION): type:"Click", expressionType:"ANIMATION", props:'{"animationName":"Target"}' — tıkla→animasyona git
    Click(SCRIPT): type:"Click", expressionType:"SCRIPT", props:'{"scriptId":123}' — tıkla→script çalıştır
  SVG ZORUNLU: <svg> tag'i şu 3 özelliği İÇERMELİ: style="width:100%; height:100%;" viewBox="0 0 1920 1080" width="1920" height="1080". Tam: <svg xmlns="http://www.w3.org/2000/svg" style="width:100%; height:100%;" width="1920" height="1080" viewBox="0 0 1920 1080">. Eksik olursa SVG taşar. Koordinatlar 1920x1080 içinde kalmalı.
  KRİTİK: body'de animationId dahil. props asla null olamaz (en az "{}"). SVG id'leri=domId. Varsayılanlar: color:"#E8E8E8", alignment:"none".

CANLI DEĞER KURALI (ÇOK ÖNEMLİ):
- Kullanıcı "canlı değer", "anlık değer", "şu anki değer", "mevcut değer", "live value" gibi ifadeler kullandığında MUTLAKA inscada_get_live_value veya inscada_get_live_values tool'unu kullan.
- inscada_get_live_value parametreleri: project_id (number) ve variable_name (string). Eğer project_id bilmiyorsan önce list_projects ile öğren, sonra kendin seç ve devam et. Kullanıcıya project_id SORMA.
- Eğer variable_name tam bilmiyorsan kullanıcıya sor veya workspace context'ten al.
- Genel kural: Bir bilgiyi tool ile öğrenebiliyorsan kullanıcıya SORMA, tool'u çağır ve sonucunu kullanarak devam et. Sadece birden fazla proje varsa ve hangisi olduğu belirsizse kullanıcıya sor.

Frame'e bağlı değişken değerleri okuma:
- Adım 1: inscada_api(POST, /api/variables/filter/pages, query_params:{pageSize:500}, body:{projectId:X, frameId:Y}) → frame'deki variable listesi (name alanları)
- Adım 2: inscada_get_live_values(project_id:X, variable_names:"name1,name2,...") → canlı değerler
- Tek adımda frameId ile value okuyan endpoint yoktur, bu 2 adımlı akış zorunludur.

Tarihsel Veri ve İstatistik:
- Tarihsel zaman serisi → inscada_logged_values (variable_ids + start_date/end_date)
- İstatistikler (min, max, avg, count) → inscada_logged_stats (project_id + variable_names)
- Değişken ID bilmiyorsan → değişken adını kullanıcıya sor veya workspace context'ten al

Chart:
- Grafik istenince MUTLAKA ilgili chart tool'unu çağır (chart_line/bar/gauge/multi/forecast). Tool çağırmadan "gösterdim/çizdim" DEME.
- chart_line, chart_bar, chart_multi, chart_forecast → variable_names + project_id ile çağır (değişken adlarını bilmiyorsan kullanıcıya sor)
- Yeni seri ekleme → chart_multi ile TÜM serileri birlikte çiz
- Gauge → doğrudan chart_gauge(variable_name, project_id, auto_refresh=true) çağır (inscada_get_live_value çağırma)
- Tahmin → (1) inscada_logged_values ile veri çek, (2) analiz et, (3) forecast_values üret, (4) MUTLAKA chart_forecast çağır. chart_line tahmin çizemez.

Excel: Önce veriyi çek, sonra export_excel({file_name, sheets:[{name,headers,rows}]}).

Custom menü:
- CRUD: list_custom_menus, get_custom_menu/get_custom_menu_by_name, create_custom_menu, update_custom_menu, delete_custom_menu
- TEMPLATE KULLAN (gauge/line_chart/gauge_and_chart/multi_chart) — content GÖNDERME. Serbest HTML sadece şablonlar yetersizse.
- Varsayılanlar: target="Home", position="Bottom", menu_order=1. Her zaman gönder.
- Güncelleme: önce get_custom_menu ile oku
- CSP (Content-Security-Policy) — inSCADA kuralları:
  default-src 'self'; connect-src 'self' (harici API çağrısı YASAK!);
  script-src 'self' 'unsafe-inline' 'unsafe-eval' cdnjs.cloudflare.com ajax.googleapis.com cdn.jsdelivr.net;
  style-src 'self' 'unsafe-inline' data: cdnjs.cloudflare.com fonts.googleapis.com cdn.jsdelivr.net;
  font-src 'self' data: cdnjs.cloudflare.com fonts.gstatic.com;
  img-src 'self' data: blob: *.inscada.com *.inscada.online;
  frame-src 'self' blob: *.inscada.com *.inscada.online inscada.gitbook.io;
  worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self';
  İZİNLİ CDN'ler: cdnjs.cloudflare.com, ajax.googleapis.com, cdn.jsdelivr.net, fonts.googleapis.com, fonts.gstatic.com
  YASAK: Listelenmeyen CDN, harici API fetch (connect-src sadece self)
- REST API çağrısı: fetch("/api/...", {credentials:"include", headers:{"X-Space":"space_adi","Accept":"application/json"}}). projectId zorunlu.
- icon: Font Awesome 5.x Free (fas/far/fab). Varsayılan: "fas fa-industry"

Tool öncelikleri:
- Space→list_spaces, Proje→list_projects, Script→list_scripts/get_script/search_in_scripts, Connection→list_connections, Değişken/Tag→list_variables, Animasyon→list_animations/get_animation
- Connection listesi ve durumu → list_connections(include_status=true). Tüm connection'ları listeleyip durumlarını tek adımda getirir.
- Değişken/tag/point listesi → list_variables(project_id). Projedeki tüm SCADA değişkenlerini döner. search parametresiyle ada göre filtrelenebilir.
- Animasyon listesi → list_animations(project_id). Animasyon detayı → get_animation(animation_id). SVG içeriği için include_svg=true kullan.
- Tek tool yeterliyse birden fazla çağırma

Generic API (625 endpoint erişimi):
- Özel tool yoksa → inscada_api_endpoints(search) ile endpoint bul → inscada_api_schema(path, method) ile parametreleri öğren → inscada_api(method, path, query_params, body, path_params) ile çağır
- ÖNCELİK: Mevcut özel tool'lar (list_spaces, list_projects, chart_gauge vb.) her zaman generic API'den önce gelir. Özel tool yoksa generic kullan.
- inscada_api ile GET istekleri serbest, POST/PUT/DELETE/PATCH → kullanıcı onayı gerekir
- path her zaman /api/ ile başlamalı. Path parametreleri: {id} formatı + path_params ile değiştirilir.
- Query parametreleri: query_params objesi olarak gönder. Array değerler otomatik explode edilir.

Bypass:
- __table sonucu olan tool'ların verileri frontend'de tablo olarak gösterilir. Verileri markdown tablo olarak TEKRARLAMA.
- Sadece kısa yorum/özet yaz (örn: "5 proje bulundu" veya "Script kodu aşağıda").`;

/**
 * Tool result'ı Claude'a göndermeden önce truncate eder.
 * Frontend tam veriyi alır (chartDataList/downloadList ayrı toplanıyor).
 */
function truncateToolResult(toolName, result) {
  if (!result || typeof result !== "object") return result;

  // __chart → sadece meta (data dizilerini kaldır)
  if (result.__chart) {
    return {
      __chart: true,
      chart_type: result.chart_type || "unknown",
      title: result.title || "",
      series_count: Array.isArray(result.data) ? result.data.length : (result.datasets ? result.datasets.length : 1),
      total_points: Array.isArray(result.data) ? result.data.reduce((s, d) => s + (Array.isArray(d.data) ? d.data.length : 0), 0) : 0,
      unit: result.unit || "",
      value: result.value, // gauge value
    };
  }

  // __download → sadece meta
  if (result.__download) {
    return {
      __download: true,
      file_name: result.file_name || "",
      sheet_count: result.sheet_count || 0,
      total_rows: result.total_rows || 0,
    };
  }

  // __table → küçük tablolarda (≤10 satır) satır verisini de Claude'a gönder
  if (result.__table) {
    const rowCount = result.meta?.row_count || (Array.isArray(result.rows) ? result.rows.length : 0);
    const base = {
      __table: true,
      title: result.title || "",
      row_count: rowCount,
      columns: result.columns,
      display_hint: result.display_hint,
      has_code: !!result.code,
    };
    if (rowCount <= 10 && Array.isArray(result.rows)) {
      base.rows = result.rows;
    }
    return base;
  }

  // pending_confirmation → olduğu gibi (küçük)
  if (result.pending_confirmation) return result;

  const str = JSON.stringify(result);

  // Satır sonuçları → ilk 50 satır
  if (Array.isArray(result.rows) && result.rows.length > 50) {
    return {
      columns: result.columns,
      rows: result.rows.slice(0, 50),
      _truncated: true,
      _total_rows: result.rows.length,
    };
  }

  // Array dönen sonuçlar (bazı tool'lar direkt array döner)
  if (Array.isArray(result) && result.length > 50) {
    return {
      data: result.slice(0, 50),
      _truncated: true,
      _total_count: result.length,
    };
  }

  // get_script code → ilk 3000 char
  if (result.code && typeof result.code === "string" && result.code.length > 3000) {
    return {
      ...result,
      code: result.code.substring(0, 3000),
      _code_truncated: true,
      _total_code_length: result.code.length,
    };
  }

  // Genel büyük result → ilk 4000 char
  if (str.length > 8000) {
    return {
      _truncated_result: str.substring(0, 4000),
      _original_size: str.length,
    };
  }

  return result;
}

/**
 * Eski tool_result mesajlarını sıkıştırır (son recentCount mesaj hariç).
 */
function compressOldToolResults(messages, recentCount) {
  if (messages.length <= recentCount) return messages;
  const boundary = messages.length - recentCount;

  return messages.map((msg, idx) => {
    if (idx >= boundary) return msg; // Son mesajlar → dokunma
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;

    const compressed = msg.content.map(block => {
      if (block.type !== "tool_result") return block;

      let parsed;
      try { parsed = JSON.parse(block.content); } catch { return block; }
      if (!parsed || typeof parsed !== "object") return block;

      // Küçük sonuçlar → dokunma
      if (block.content.length < 500) return block;

      let mini;
      if (parsed.__chart) {
        mini = { __chart: true, chart_type: parsed.chart_type, title: parsed.title };
      } else if (parsed.__table) {
        mini = { __table: true, title: parsed.title, row_count: parsed.row_count, _compressed: true };
      } else if (parsed.__download) {
        mini = { __download: true, file_name: parsed.file_name };
      } else if (Array.isArray(parsed.rows)) {
        mini = { rowCount: parsed.rows.length, _compressed: true };
      } else if (Array.isArray(parsed)) {
        mini = { itemCount: parsed.length, _compressed: true };
      } else if (parsed.code && typeof parsed.code === "string" && parsed.code.length > 200) {
        mini = { script_id: parsed.script_id, name: parsed.name, code_length: parsed.code.length, _compressed: true };
      } else if (block.content.length > 2000) {
        mini = { _compressed: true, _original_size: block.content.length };
      } else {
        return block;
      }

      return { ...block, content: JSON.stringify(mini) };
    });

    return { ...msg, content: compressed };
  });
}

/**
 * Claude API ile tool_use döngüsü
 * Claude tool çağrısı yaptıkça çalıştır, sonucu geri gönder, final yanıtı al
 */
async function chat(conversationId, userMessage, workspaceContext) {
  // Konuşma geçmişini al veya oluştur
  if (!conversations.has(conversationId)) {
    conversations.set(conversationId, { messages: [], context: null });
  }
  const conv = conversations.get(conversationId);
  // Workspace context güncelle (her mesajda frontend'den gelir)
  if (workspaceContext && workspaceContext.project_id) {
    conv.context = workspaceContext;
  }
  const ctx = conv.context || {};
  const messages = conv.messages;

  // Kullanıcı mesajını ekle
  messages.push({ role: "user", content: userMessage });

  const chatStart = Date.now();
  const toolResults = []; // İşlenen tool'ları takip et
  const chartDataList = []; // Chart verilerini topla
  const downloadList = []; // Download verilerini topla
  const confirmationList = []; // Onay bekleyen aksiyonları topla
  const tableDataList = []; // Table bypass verilerini topla
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let loopCount = 0;
  let response;
  let currentMessages = [...messages];
  let lastToolResultContents = null; // Confirmation break için conversation history düzeltmesi

  // Tool use döngüsü - Claude tool çağırdıkça devam et
  while (true) {
    loopCount++;
    const apiStart = Date.now();
    // Workspace context varsa SYSTEM_PROMPT'a ekle
    let activePrompt = SYSTEM_PROMPT;
    if (ctx.project_id) {
      activePrompt += `\n\nAKTİF ÇALIŞMA ALANI:
- Space: ${ctx.space_name} (space_id: ${ctx.space_id})
- Proje: ${ctx.project_name} (project_id: ${ctx.project_id})
Tool çağırırken project_id parametresine ${ctx.project_id}, space_id parametresine ${ctx.space_id} değerini kullan. Kullanıcıya project_id veya space_id SORMA.`;
    }
    response = await callLLM(activePrompt, currentMessages, TOOLS, loopCount === 1 ? 4096 : 2048);
    const apiMs = Date.now() - apiStart;
    console.log(`[API] Claude yanıt ${apiMs}ms (in:${response.usage?.input_tokens} out:${response.usage?.output_tokens})`);

    // Token kullanımını topla
    if (response.usage) {
      totalInputTokens += response.usage.input_tokens || 0;
      totalOutputTokens += response.usage.output_tokens || 0;
    }

    // Tool use yoksa döngüden çık
    if (response.stop_reason !== "tool_use") break;

    // Tool çağrılarını işle
    const assistantContent = response.content;
    currentMessages.push({ role: "assistant", content: assistantContent });

    const toolResultContents = [];
    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        // Workspace context: tool parametrelerine otomatik project_id/space_id enjekte et
        if (ctx.project_id && block.input && !block.input.project_id) {
          block.input.project_id = ctx.project_id;
        }
        if (ctx.space_id && block.input && !block.input.space_id) {
          block.input.space_id = ctx.space_id;
        }

        let result;
        try {
          // Tehlikeli tool'ları yakala, onay iste
          if (isDangerousTool(block.name, block.input)) {
            const actionId = `action_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            pendingActions.set(actionId, { tool: block.name, input: block.input });
            result = {
              pending_confirmation: true,
              action_id: actionId,
              tool: block.name,
              input: block.input,
              message: `Bu işlem gerçek ekipmana komut gönderecek. Onay gerekiyor.`
            };
            console.log(`[Tool] ${block.name}(${JSON.stringify(block.input).substring(0, 200)}) → onay bekliyor`);
          } else {
            const toolStart = Date.now();
            result = await executeTool(block.name, block.input);
            const toolMs = Date.now() - toolStart;
            console.log(`[Tool] ${block.name} ${toolMs}ms (${JSON.stringify(block.input).substring(0, 200)})`);
          }

          // Chart data'yı topla
          if (result && result.__chart) {
            chartDataList.push(result);
          }

          // Download data'yı topla
          if (result && result.__download) {
            downloadList.push(result);
          }

          // Onay bekleyen aksiyonu topla
          if (result && result.pending_confirmation) {
            confirmationList.push(result);
          }

          // Table bypass: tool sonucunu doğrudan frontend'e gönder
          if (result && !result.__chart && !result.__download && !result.pending_confirmation && BYPASS_TOOLS[block.name]) {
            const tableData = BYPASS_TOOLS[block.name].formatFn(result, block.input);
            if (tableData) {
              tableDataList.push(tableData);
              result = tableData; // truncateToolResult __table olarak işleyecek
            }
          }

          toolResults.push({
            tool: block.name,
            input: block.input,
            success: true,
            result_preview: JSON.stringify(result).substring(0, 300),
          });
        } catch (err) {
          result = { error: err.message };
          console.log(`[Tool] ${block.name} HATA: ${err.message}`);
          toolResults.push({ tool: block.name, input: block.input, success: false, error: err.message });
        }

        // Claude'a truncated sonuç gönder, frontend tam veriyi alır
        const truncatedResult = truncateToolResult(block.name, result);
        toolResultContents.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(truncatedResult),
        });
      }
    }

    currentMessages.push({ role: "user", content: toolResultContents });

    // Onay bekleyen aksiyon varsa döngüyü kır — Claude'a geri gönderme (tekrar çağırır)
    if (confirmationList.length) {
      lastToolResultContents = toolResultContents;
      break;
    }
  }

  // Yanıt metnini topla
  const assistantContent = response.content;
  let text = "";
  for (const block of assistantContent) {
    if (block.type === "text") {
      text += block.text;
    }
  }

  // Geçmişe kaydet
  messages.push({ role: "assistant", content: assistantContent });

  // Confirmation break: tool_use → tool_result çiftini conversation history'ye ekle
  if (lastToolResultContents) {
    messages.push({ role: "user", content: lastToolResultContents });
  }

  // Geçmiş çok uzunsa kırp (son 20 mesaj)
  // tool_use/tool_result çiftlerini bozmamak için güvenli kırpma noktası bul
  if (messages.length > 20) {
    let trimStart = messages.length - 20;
    // Kırpma noktasının user mesajında başladığından emin ol
    // (assistant tool_use + user tool_result çiftini bölme)
    while (trimStart < messages.length) {
      const msg = messages[trimStart];
      // user role ve content tool_result değilse güvenli başlangıç
      if (msg.role === "user" && !Array.isArray(msg.content)) break;
      // Array content tool_result bloğu olabilir — atla
      if (msg.role === "user" && Array.isArray(msg.content) &&
          msg.content.some(b => b.type === "tool_result")) {
        trimStart++;
        continue;
      }
      // assistant role tool_use içeriyorsa — atla (tool_result'sız kalmasın)
      if (msg.role === "assistant" && Array.isArray(msg.content) &&
          msg.content.some(b => b.type === "tool_use")) {
        trimStart++;
        continue;
      }
      break;
    }
    let trimmed = messages.slice(trimStart);
    // Eski tool_result mesajlarını sıkıştır (son 6 mesaj hariç)
    trimmed = compressOldToolResults(trimmed, 6);
    conv.messages = trimmed;
  }

  const chatDurationMs = Date.now() - chatStart;
  console.log(`[Chat] Toplam ${chatDurationMs}ms, ${loopCount} tur, ${toolResults.length} tool`);

  telemetry.write("chat_message", { source: "server", provider: LLM_PROVIDER }, {
    duration_ms: chatDurationMs,
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    loop_count: loopCount,
    tool_count: toolResults.length,
    chart_count: chartDataList.length,
    download_count: downloadList.length,
  });

  return {
    text,
    charts: chartDataList,
    tables: tableDataList,
    downloads: downloadList,
    confirmations: confirmationList,
    tools_used: toolResults.map(t => ({ tool: t.tool, success: t.success })),
    usage: {
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      total_tokens: totalInputTokens + totalOutputTokens,
      context_window: 200000,
    },
  };
}

// ============================================================
// API Routes
// ============================================================

// Workspace context: space listesi
app.get("/api/spaces", async (req, res) => {
  try {
    const result = await executeTool("list_spaces", {});
    res.json(Array.isArray(result) ? result.map(s => ({ space_id: s.space_id, name: s.name })) : []);
  } catch (err) {
    console.error("Space listesi hatası:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Workspace context: proje listesi (space'e göre)
app.get("/api/projects/:spaceId", async (req, res) => {
  try {
    const result = await executeTool("list_projects", {});
    res.json(Array.isArray(result) ? result.map(p => ({ project_id: p.project_id, name: p.name })) : []);
  } catch (err) {
    console.error("Proje listesi hatası:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Current user: oturum açan kullanıcı bilgisi + rol
app.get("/api/current-user", async (req, res) => {
  try {
    const user = await inscadaApi.request("GET", "/api/auth/currentUser");
    res.json({
      name: user.name || null,
      roles: Array.isArray(user.roles) ? user.roles : [],
      spaces: Array.isArray(user.spaces) ? user.spaces : [],
      activeSpace: user.activeSpace || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chat endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const { message, conversationId = "default", workspaceContext } = req.body;
    if (!message) return res.status(400).json({ error: "Mesaj gerekli" });

    const result = await chat(conversationId, message, workspaceContext);
    res.json(result);
  } catch (err) {
    console.error("Chat hatası:", err);

    telemetry.write("chat_error", { source: "server", provider: LLM_PROVIDER }, {
      message: (err.message || "").substring(0, 500),
      status: err.status || 0,
    });

    // API hatalarında kullanıcı dostu mesajlar
    let errorMsg = err.message;
    const rawMsg = err?.error?.error?.message || err.message || "";

    // Ollama bağlantı hataları
    if (LLM_PROVIDER === "ollama" && (err.cause?.code === "ECONNREFUSED" || rawMsg.includes("ECONNREFUSED") || rawMsg.includes("fetch failed"))) {
      errorMsg = `Ollama'ya bağlanılamadı (${OLLAMA_BASE_URL}). Ollama'nın çalıştığından emin olun: "ollama serve"`;
    } else if (LLM_PROVIDER === "ollama" && rawMsg.includes("model")) {
      errorMsg = `Ollama model hatası: ${rawMsg.substring(0, 200)}. Modeli indirin: "ollama pull ${OLLAMA_MODEL}"`;
    } else if (LLM_PROVIDER === "gemini" && (err.status === 401 || rawMsg.includes("API key"))) {
      errorMsg = "Gemini API key geçersiz. Ayarlar > AI Sağlayıcı bölümünden kontrol edin.";
    } else if (LLM_PROVIDER === "gemini" && err.status === 429) {
      errorMsg = "Gemini API istek limiti aşıldı. Lütfen bir süre bekleyip tekrar deneyin.";
    } else if (err.status === 400 && rawMsg.includes("usage limits")) {
      // "You have reached your specified API usage limits. You will regain access on 2026-04-01..."
      const dateMatch = rawMsg.match(/on (\d{4}-\d{2}-\d{2})/);
      let resetInfo = "";
      if (dateMatch) {
        const d = new Date(dateMatch[1]);
        resetInfo = ` Kullanım hakkınız ${d.toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" })} tarihinde yenilenecektir.`;
      }
      errorMsg = `Aylık API kullanım limitinize ulaştınız.${resetInfo} Daha fazla bilgi için yöneticinize başvurun.`;
    } else if (err.status === 401 || (rawMsg && rawMsg.includes("API key"))) {
      errorMsg = "API kimlik doğrulama hatası. Lisansınızın aktif olduğundan emin olun. (Ayarlar > Lisans Durumu)";
    } else if (err.status === 429) {
      errorMsg = "API istek limiti aşıldı. Lütfen bir süre bekleyip tekrar deneyin.";
    } else if (err.status === 403) {
      errorMsg = "API erişim hatası. Abonelik durumunuzu kontrol edin.";
    } else if (err.status === 400) {
      errorMsg = `İstek hatası: ${rawMsg}`;
    }
    res.status(500).json({ error: errorMsg });
  }
});

// Konuşma geçmişini sil
app.delete("/api/chat/:conversationId", (req, res) => {
  conversations.delete(req.params.conversationId);
  res.json({ success: true });
});

// Konuşma listesi
app.get("/api/conversations", (req, res) => {
  const list = [];
  for (const [id, conv] of conversations) {
    const msgs = conv.messages || [];
    list.push({ id, messageCount: msgs.length, lastMessage: msgs[msgs.length - 1]?.content?.substring?.(0, 100) || "" });
  }
  res.json(list);
});

// Gauge auto-refresh: canlı değer proxy endpoint
app.get("/api/live-value", async (req, res) => {
  const { project_id, variable_name } = req.query;
  if (!project_id || !variable_name) {
    return res.status(400).json({ error: "project_id and variable_name required" });
  }
  try {
    const result = await executeTool("inscada_get_live_value", { project_id: Number(project_id), variable_name });
    // Normalize: her zaman {value: number} dönsün
    const val = result?.value !== undefined ? result.value : (result?.data?.value !== undefined ? result.data.value : null);
    res.json({ value: val, date: result?.date || result?.data?.date || null });
  } catch (err) {
    res.status(502).json({ error: err.message || "Failed to fetch live value" });
  }
});

// SCADA yazma işlemi onay endpoint'i
app.post("/api/confirm-action", async (req, res) => {
  const { actionId, approved } = req.body;
  const action = pendingActions.get(actionId);
  if (!action) return res.status(404).json({ error: "Aksiyon bulunamadı veya süresi doldu." });
  pendingActions.delete(actionId);

  telemetry.write("action_confirm", { source: "server", tool: action.tool, approved: String(!!approved) }, {
    params_preview: JSON.stringify(action.input).substring(0, 200),
  });

  if (!approved) return res.json({ result: { cancelled: true, message: "İşlem kullanıcı tarafından iptal edildi." } });
  try {
    const result = await executeTool(action.tool, action.input);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  let modelName = "Claude Sonnet 4";
  if (LLM_PROVIDER === "ollama") modelName = OLLAMA_MODEL;
  else if (LLM_PROVIDER === "gemini") modelName = GEMINI_MODEL;
  res.json({ status: "ok", tools: TOOLS.length, uptime: process.uptime(), provider: LLM_PROVIDER, model: modelName });
});

// Download endpoint - Excel dosyalarını serve et
app.get("/api/downloads/:filename", (req, res) => {
  const filename = req.params.filename;
  const downloadsDir = path.join(os.tmpdir(), "inscada-downloads");
  const filePath = path.resolve(downloadsDir, filename);

  // Containment: çözülen yol downloads dizininde olmalı
  if (!filePath.startsWith(downloadsDir + path.sep) && filePath !== downloadsDir) {
    return res.status(400).json({ error: "Geçersiz dosya adı" });
  }

  // Dosya adı formatı kontrolü (ek güvenlik)
  if (!/^[a-zA-Z0-9_\-]+_\d+\.xlsx$/.test(filename)) {
    return res.status(400).json({ error: "Geçersiz dosya formatı" });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Dosya bulunamadı" });
  }
  res.download(filePath, filename);
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

telemetry.init();

// inSCADA versiyonunu lazy olarak bir kez al ve telemetry'ye set et
setTimeout(async () => {
  try {
    const ver = await inscadaApi.request("GET", "/api/version");
    const version = typeof ver === "string" ? ver : (ver.version || ver.raw || JSON.stringify(ver));
    telemetry.setInscadaVersion(version.replace(/["\s]/g, ""));
    console.log(`[telemetry] inSCADA version: ${version}`);
  } catch (e) {
    console.error(`[telemetry] inSCADA version alınamadı: ${e.message}`);
  }
}, 5000);

app.listen(PORT, "127.0.0.1", () => {
  const providerInfo = LLM_PROVIDER === "ollama"
    ? `Ollama (${OLLAMA_MODEL})`
    : LLM_PROVIDER === "gemini"
    ? `Gemini (${GEMINI_MODEL})`
    : "Claude API";
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   inSCADA AI Asistan v1.2             ║`);
  console.log(`  ║   http://127.0.0.1:${PORT}             ║`);
  console.log(`  ║   LLM: ${providerInfo.padEnd(29)}║`);
  console.log(`  ║   Tools: ${TOOLS.length} (API+Chart)           ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
