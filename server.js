/**
 * inSCADA AI Asistan Server
 * Express backend - Claude API ile tool_use döngüsü
 */

require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const Anthropic = require("@anthropic-ai/sdk");
const TOOLS = require("./tools");
const { executeTool } = require("./tool-handlers");
const telemetry = require("./telemetry");

const app = express();
const PORT = process.env.PORT || 3000;

// Claude API client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));

// Chart dosyalarını serve et - artık gerekli değil ama ileride eklenebilir
// app.use("/charts", express.static(...));

// Konuşma geçmişi (memory - basit in-memory)
const conversations = new Map();

// SCADA yazma işlemleri için onay mekanizması
const DANGEROUS_TOOLS = new Set(["inscada_set_value", "inscada_run_script"]);
const pendingActions = new Map(); // actionId → { tool, input }

// ============================================================
// Table Bypass — tool sonuçlarını Claude'dan geçirmeden frontend'de göster
// ============================================================

function influxMetaFormat(title, toolName) {
  return function (result) {
    if (!Array.isArray(result) || !result.length) return null;
    const s = result[0];
    if (s.error) return null;
    if (!s.data || !s.data.length) return null;
    const cols = s.columns || Object.keys(s.data[0]);
    return {
      __table: true,
      title: `${title} (${s.data.length})`,
      columns: cols,
      rows: s.data.map(d => cols.map(c => d[c])),
      display_hint: "table",
      meta: { tool: toolName, row_count: s.data.length },
    };
  };
}

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
  get_script_history: { formatFn: genericListFormat("Script Geçmişi", "get_script_history") },

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

  run_query: {
    formatFn(result) {
      if (!result || result.error || !result.rows || !result.rows.length) return null;
      const cols = Object.keys(result.rows[0]);
      const MAX = 200;
      const trunc = result.rows.length > MAX;
      const display = trunc ? result.rows.slice(0, MAX) : result.rows;
      return {
        __table: true,
        title: `Sorgu Sonucu (${result.rowCount || result.rows.length} satır)`,
        columns: cols,
        rows: display.map(r => cols.map(c => r[c])),
        display_hint: "table",
        meta: { tool: "run_query", row_count: display.length, truncated: trunc, total_rows: result.rowCount || result.rows.length },
      };
    },
  },

  // Tier 2 — InfluxDB Meta & Sorgu
  influx_list_databases: { formatFn: influxMetaFormat("Veritabanları", "influx_list_databases") },
  influx_list_measurements: { formatFn: influxMetaFormat("Measurement Listesi", "influx_list_measurements") },
  influx_show_tag_keys: { formatFn: influxMetaFormat("Tag Anahtarları", "influx_show_tag_keys") },
  influx_show_tag_values: { formatFn: influxMetaFormat("Tag Değerleri", "influx_show_tag_values") },
  influx_show_field_keys: { formatFn: influxMetaFormat("Field Anahtarları", "influx_show_field_keys") },
  influx_show_retention_policies: { formatFn: influxMetaFormat("Retention Policy Listesi", "influx_show_retention_policies") },

  influx_query: {
    formatFn(result) {
      if (!Array.isArray(result) || !result.length) return null;
      const s = result[0];
      if (s.error) return null;
      if (!s.data || !s.data.length) return null;
      const cols = s.columns || Object.keys(s.data[0]);
      const MAX = 200;
      const trunc = s.data.length > MAX;
      const display = trunc ? s.data.slice(0, MAX) : s.data;
      return {
        __table: true,
        title: `InfluxDB Sorgu Sonucu (${s.row_count || s.data.length} satır)`,
        columns: cols,
        rows: display.map(d => cols.map(c => d[c])),
        display_hint: "table",
        meta: { tool: "influx_query", row_count: display.length, truncated: trunc, total_rows: s.row_count || s.data.length, measurement: s.measurement },
      };
    },
  },

  // Tier 3 — REST API Okuma
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

  // Tier 4 — Detay Gösterimi
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

const SYSTEM_PROMPT = `Sen inSCADA AI asistanısın. SCADA projeleri, scriptler ve endüstriyel veri analizi konusunda yardım ediyorsun. Kullanıcının dilinde yanıt ver.

Kurallar:
- Script güncellemede ÖNCE get_script ile oku
- inscada_set_value → kullanıcıdan onay al (gerçek ekipman komutu)
- Canlı değer → inscada_get_live_value/values kullan (InfluxDB değil)
- Kod değişikliklerinde önce/sonra farkını göster

Chart:
- Grafik istenince MUTLAKA ilgili chart tool'unu çağır (chart_line/bar/gauge/multi/forecast). Tool çağırmadan "gösterdim/çizdim" DEME.
- Yeni seri ekleme → chart_multi ile TÜM serileri birlikte çiz
- Gauge → doğrudan chart_gauge çağır (inscada_get_live_value çağırma). Canlı güncelleme: auto_refresh=true + refresh_project_id + refresh_variable_name
- Tahmin → (1) influx_query ile veri çek, (2) analiz et, (3) forecast_values üret, (4) MUTLAKA chart_forecast çağır. chart_line tahmin çizemez.

Excel: Önce veriyi çek, sonra export_excel({file_name, sheets:[{name,headers,rows}]}).

Custom menü:
- CRUD: list_custom_menus, get_custom_menu/get_custom_menu_by_name, create_custom_menu, update_custom_menu, delete_custom_menu
- TEMPLATE KULLAN (gauge/line_chart/gauge_and_chart/multi_chart) — content GÖNDERME. Serbest HTML sadece şablonlar yetersizse.
- Varsayılanlar: target="Home", position="Bottom", menu_order=1. Her zaman gönder.
- Güncelleme: önce get_custom_menu ile oku
- CSP: CDN sadece cdnjs.cloudflare.com, ajax.googleapis.com, cdn.jsdelivr.net. Chart.js için jsdelivr. Gauge'ı canvas/SVG ile çiz. Harici API yasak (connect-src: self).
- REST API çağrısı: fetch("/api/...", {credentials:"include", headers:{"X-Space":"space_adi","Accept":"application/json"}}). projectId zorunlu.
- icon: Font Awesome 5.x Free (fas/far/fab). Varsayılan: "fas fa-industry"

Tool öncelikleri:
- Space→list_spaces, Proje→list_projects, Script→list_scripts/get_script/search_in_scripts
- Tag/değişken→run_query+inscada.variable (name/dsc ILIKE), JOIN etme
- run_query SADECE özel SQL için, DAİMA inscada. şeması. information_schema/pg_tables YASAK
- influx_query SADECE hazır tool'lar yetersizse. Tek tool yeterliyse birden fazla çağırma

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

  // __table → sadece meta (satır verisi Claude'a gitmez)
  if (result.__table) {
    return {
      __table: true,
      title: result.title || "",
      row_count: result.meta?.row_count || 0,
      columns: result.columns,
      display_hint: result.display_hint,
      has_code: !!result.code,
    };
  }

  // pending_confirmation → olduğu gibi (küçük)
  if (result.pending_confirmation) return result;

  const str = JSON.stringify(result);

  // run_query satır sonuçları → ilk 50 satır
  if (Array.isArray(result.rows) && result.rows.length > 50) {
    return {
      columns: result.columns,
      rows: result.rows.slice(0, 50),
      _truncated: true,
      _total_rows: result.rows.length,
    };
  }

  // run_query → array dönen sonuçlar (bazı tool'lar direkt array döner)
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

  // InfluxDB series array → her seride ilk 50 nokta
  if (Array.isArray(result.results)) {
    let modified = false;
    const truncatedResults = result.results.map(r => {
      if (!r.series) return r;
      const truncSeries = r.series.map(s => {
        if (Array.isArray(s.values) && s.values.length > 50) {
          modified = true;
          return { ...s, values: s.values.slice(0, 50), _truncated: true, _total_values: s.values.length };
        }
        return s;
      });
      return { ...r, series: truncSeries };
    });
    if (modified) return { ...result, results: truncatedResults };
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
async function chat(conversationId, userMessage) {
  // Konuşma geçmişini al veya oluştur
  if (!conversations.has(conversationId)) {
    conversations.set(conversationId, []);
  }
  const messages = conversations.get(conversationId);

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

  // Tool use döngüsü - Claude tool çağırdıkça devam et
  while (true) {
    loopCount++;
    const apiStart = Date.now();
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: loopCount === 1 ? 4096 : 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: currentMessages,
    });
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
        let result;
        try {
          // Tehlikeli tool'ları yakala, onay iste
          if (DANGEROUS_TOOLS.has(block.name)) {
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
    conversations.set(conversationId, trimmed);
  }

  const chatDurationMs = Date.now() - chatStart;
  console.log(`[Chat] Toplam ${chatDurationMs}ms, ${loopCount} tur, ${toolResults.length} tool`);

  // Telemetri: chat_message event'i
  telemetry.track("chat_message", {
    conversation_id: conversationId,
    user_message_preview: (userMessage || "").substring(0, 500),
    assistant_response_preview: (text || "").substring(0, 500),
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    total_tokens: totalInputTokens + totalOutputTokens,
    loop_count: loopCount,
    duration_ms: chatDurationMs,
    tool_calls: toolResults.map(t => ({ tool: t.tool, success: t.success })),
    charts_generated: chartDataList.length,
    chart_types: chartDataList.map(c => c.chart_type || "unknown"),
    tables_generated: tableDataList.length,
    downloads_generated: downloadList.length,
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

// Chat endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const { message, conversationId = "default" } = req.body;
    if (!message) return res.status(400).json({ error: "Mesaj gerekli" });

    const result = await chat(conversationId, message);
    res.json(result);
  } catch (err) {
    console.error("Chat hatası:", err);

    // Telemetri: chat_error event'i
    telemetry.track("chat_error", {
      error_message: (err.message || "").substring(0, 500),
      error_status: err.status || null,
      error_type: err.constructor?.name || "Error",
    });

    // API hatalarında kullanıcı dostu mesajlar
    let errorMsg = err.message;
    const rawMsg = err?.error?.error?.message || err.message || "";

    if (err.status === 400 && rawMsg.includes("usage limits")) {
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
  for (const [id, msgs] of conversations) {
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

  // Telemetri: action_confirmed event'i
  telemetry.track("action_confirmed", {
    tool: action.tool,
    approved: !!approved,
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
  res.json({ status: "ok", tools: TOOLS.length, uptime: process.uptime() });
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

app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   inSCADA AI Asistan v1.2             ║`);
  console.log(`  ║   http://127.0.0.1:${PORT}             ║`);
  console.log(`  ║   Tools: ${TOOLS.length} (PG+Influx+Chart+API) ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
