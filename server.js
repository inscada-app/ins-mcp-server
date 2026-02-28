/**
 * inSCADA Chat Server
 * Express backend - Claude API ile tool_use döngüsü
 */

require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk");
const TOOLS = require("./tools");
const { executeTool } = require("./tool-handlers");

const app = express();
const PORT = process.env.PORT || 3000;

// Claude API client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Chart dosyalarını serve et - artık gerekli değil ama ileride eklenebilir
// app.use("/charts", express.static(...));

// Konuşma geçmişi (memory - basit in-memory)
const conversations = new Map();

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
- Türkçe yanıt ver
- Teknik terimleri açıkla
- Kod değişikliklerinde önce/sonra farkını göster

Chart kuralları:
- Kullanıcı grafik/chart istediğinde MUTLAKA ilgili chart tool'unu (chart_line, chart_bar, chart_gauge, chart_multi) çağır. Sadece açıklama yazma, tool'u çalıştır.
- Kullanıcı mevcut grafiğe yeni seri eklemek isterse chart_multi tool'unu kullanarak TÜM serileri (önceki + yeni) birlikte çiz. Açıklama yapma, direkt çiz.
- Kullanıcı "yeniden çiz", "tekrar çiz", "güncelle" derse tool'u tekrar çağır, önceki sonucu tekrarlama.`;

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

  const toolResults = []; // İşlenen tool'ları takip et
  const chartDataList = []; // Chart verilerini topla
  let response;
  let currentMessages = [...messages];

  // Tool use döngüsü - Claude tool çağırdıkça devam et
  while (true) {
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: currentMessages,
    });

    // Tool use yoksa döngüden çık
    if (response.stop_reason !== "tool_use") break;

    // Tool çağrılarını işle
    const assistantContent = response.content;
    currentMessages.push({ role: "assistant", content: assistantContent });

    const toolResultContents = [];
    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        console.log(`[Tool] ${block.name}(${JSON.stringify(block.input).substring(0, 200)})`);

        let result;
        try {
          result = await executeTool(block.name, block.input);

          // Chart data'yı topla
          if (result && result.__chart) {
            chartDataList.push(result);
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

  return {
    text,
    charts: chartDataList,
    tools_used: toolResults.map(t => ({ tool: t.tool, success: t.success })),
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

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", tools: TOOLS.length, uptime: process.uptime() });
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   inSCADA AI Chat v1.0               ║`);
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log(`  ║   Tools: ${TOOLS.length} (PG+Influx+Chart+API) ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
