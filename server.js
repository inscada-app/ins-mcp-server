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

const SYSTEM_PROMPT = `Sen inSCADA platformunun AI asistanısın. Kullanıcılara SCADA projeleri, scriptler ve endüstriyel veri analizi konusunda yardım ediyorsun.

Yeteneklerin:
- PostgreSQL'deki inSCADA space/project/script hiyerarşisini gezme ve yönetme
- Nashorn JavaScript scriptlerini okuma, düzenleme ve güncelleme
- InfluxDB'deki zaman serisi verilerini sorgulama ve analiz etme
- Verilerden line chart, bar chart, gauge göstergesi oluşturma
- Script kodlarında arama ve karşılaştırma
- inSCADA REST API üzerinden canlı değişken değerlerini okuma ve yazma
- Aktif alarmları izleme ve bağlantı durumlarını kontrol etme
- Script çalıştırma ve durumunu takip etme
- REST API üzerinden tarihsel log verilerini çekme

Kurallar:
- Script güncellemelerinde MUTLAKA önce get_script ile mevcut kodu oku
- inscada_set_value ile değer yazmadan ÖNCE kullanıcıdan onay al - bu gerçek ekipmana komut gönderir
- Canlı değer sorulduğunda inscada_get_live_value/inscada_get_live_values kullan, InfluxDB değil
- Kullanıcının yazdığı dilde yanıt ver (Türkçe sorulara Türkçe, İngilizce sorulara İngilizce)
- Teknik terimleri açıkla
- Kod değişikliklerinde önce/sonra farkını göster

Chart kuralları:
- Kullanıcı grafik/chart istediğinde MUTLAKA ilgili chart tool'unu (chart_line, chart_bar, chart_gauge, chart_multi) çağır. Sadece açıklama yazma, tool'u çalıştır.
- Kullanıcı mevcut grafiğe yeni seri eklemek isterse chart_multi tool'unu kullanarak TÜM serileri (önceki + yeni) birlikte çiz. Açıklama yapma, direkt çiz.
- Kullanıcı "yeniden çiz", "tekrar çiz", "güncelle" derse tool'u tekrar çağır, önceki sonucu tekrarlama.
- Kullanıcı "canlı gauge", "auto refresh gauge" veya "sürekli güncellenen gauge" isterse chart_gauge tool'unu auto_refresh=true, refresh_project_id ve refresh_variable_name parametreleriyle çağır.
- Kullanıcı bir değişkenin canlı değerini gauge olarak görmek istediğinde, önce inscada_get_live_value çağırma — doğrudan chart_gauge tool'unu çağır. chart_gauge zaten InfluxDB'den son değeri alır ve görsel gauge üretir. Canlı güncelleme isteniyorsa auto_refresh=true ekle.
- ASLA gauge/chart gösterdiğini metin olarak iddia etme — chart tool'unu gerçekten çağırmadan gauge görünmez. Tool çağırmadan "gauge gösterdim" deme.
- Kullanıcı tahmin/forecast grafiği istediğinde şu adımları izle: (1) Önce chart_line veya influx_query ile tarihsel veriyi çek, (2) Veriyi analiz et — trend, ortalama, varyans gibi istatistikleri değerlendir, (3) Analiz sonucuna göre gelecek tahmin noktalarını (forecast_values) üret — her nokta {x: ISO_timestamp, y: number} formatında, (4) chart_forecast tool'unu tarihsel parametreler (measurement, field, time_range, where_clause, group_by_time) ve ürettiğin forecast_values ile çağır, (5) Kullanıcıya hangi yöntemle tahmin yaptığını kısaca açıkla (trend analizi, hareketli ortalama vb.).

Excel kuralları:
- Kullanıcı "excel olarak ver", "excel'e aktar", "xlsx indir", "dosya olarak ver" gibi isteklerde MUTLAKA önce ilgili veriyi çek (run_query, influx_query, list_spaces vb.), sonra export_excel tool'unu çağır.
- Veriyi sheets formatına dönüştür: her sheet için {name, headers, rows}. headers sütun başlıkları (string dizisi), rows ise 2D dizi (her satır bir array).
- file_name açıklayıcı olsun (Örn: "space_listesi", "proje_degiskenleri", "alarm_raporu").
- Birden fazla veri seti varsa her birini ayrı sheet'e koy.

Tool öncelik kuralları:
- Space listesi → list_spaces kullan
- Proje listesi → list_projects kullan
- Script listesi → list_scripts kullan
- Script içeriği → get_script kullan
- Script arama → search_in_scripts kullan
- Tag/değişken listesi → run_query ile inscada.variable tablosundan project_id filtresiyle çek. İlgili tagları bulmak için name ve dsc sütunlarındaki ifadelerle eşleştirme yap (ILIKE/pattern). Tüm detay sütunları getirilebilir ama ilişkiyi name ve dsc üzerinden kur. Diğer tabloları (frame, device, connection vb.) JOIN etme, gereksiz araştırma yapma.
- run_query'yi SADECE yukarıdaki tool'ların karşılamadığı özel SQL sorguları için kullan
- run_query kullanırken tablo adlarında DAİMA inscada şemasını kullan (inscada.project, inscada.script, inscada.variable vb.)
- ASLA information_schema veya pg_tables sorgusu yapma — tablo yapısı zaten sana verildi
- influx_query'yi SADECE hazır tool'ların (influx_stats, chart_line, chart_bar vb.) karşılamadığı sorgular için kullan
- Tek bir tool yeterliyse birden fazla tool çağırma`;

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
      max_tokens: 8192,
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

        toolResultContents.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
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

  // Geçmiş çok uzunsa kırp (son 40 mesaj)
  if (messages.length > 40) {
    const trimmed = messages.slice(-40);
    conversations.set(conversationId, trimmed);
  }

  console.log(`[Chat] Toplam ${Date.now() - chatStart}ms, ${loopCount} tur, ${toolResults.length} tool`);

  return {
    text,
    charts: chartDataList,
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
    res.status(500).json({ error: err.message });
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
  console.log(`  ║   inSCADA AI Asistan v1.1             ║`);
  console.log(`  ║   http://127.0.0.1:${PORT}             ║`);
  console.log(`  ║   Tools: ${TOOLS.length} (PG+Influx+Chart+API) ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
