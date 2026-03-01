/**
 * inSCADA AI Asistan - Frontend
 */

(function () {
  // Elements
  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("messageInput");
  const sendBtn = document.getElementById("sendBtn");
  const newChatBtn = document.getElementById("newChatBtn");
  const clearChatBtn = document.getElementById("clearChatBtn");
  const chatList = document.getElementById("chatList");
  const chatTitle = document.getElementById("chatTitle");
  const sidebarToggle = document.getElementById("sidebarToggle");
  const sidebar = document.getElementById("sidebar");
  const statusIndicator = document.getElementById("statusIndicator");
  const statusText = document.getElementById("statusText");
  const toolCountEl = document.getElementById("toolCount");

  // State
  let currentConversationId = generateId();
  let conversations = JSON.parse(localStorage.getItem("inscada_chats") || "{}");
  let isLoading = false;
  let sessionTokens = { input: 0, output: 0, contextWindow: 200000 };

  // Gauge auto-refresh state
  const chartInstances = new Map();   // containerId -> Chart instance
  const chartIntervals = new Map();   // containerId -> intervalId
  const chartDataRefs = new Map();    // containerId -> mutable chartData ref

  // Configure marked
  marked.setOptions({
    breaks: true,
    gfm: true,
    highlight: function (code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  });

  // Custom renderer for code blocks with copy button
  const renderer = new marked.Renderer();
  const originalCodeRenderer = renderer.code;
  renderer.code = function (code, language) {
    const lang = language || "plaintext";
    const codeText = typeof code === 'object' ? code.text : code;
    const codeLang = typeof code === 'object' ? (code.lang || 'plaintext') : lang;
    let highlighted;
    try {
      highlighted = codeLang && hljs.getLanguage(codeLang)
        ? hljs.highlight(codeText, { language: codeLang }).value
        : hljs.highlightAuto(codeText).value;
    } catch (e) {
      highlighted = escapeHtml(codeText);
    }
    return `<div class="code-block"><div class="code-header"><span>${codeLang}</span><button class="copy-btn" onclick="copyCode(this)">Kopyala</button></div><pre><code class="hljs language-${codeLang}">${highlighted}</code></pre></div>`;
  };
  marked.setOptions({ renderer });

  // Electron detection & title bar
  const isElectron = !!(window.electronAPI && window.electronAPI.minimizeWindow);
  if (isElectron) {
    document.body.classList.add("electron-app");
    const tbMin = document.getElementById("tbMin");
    const tbMax = document.getElementById("tbMax");
    const tbClose = document.getElementById("tbClose");
    if (tbMin) tbMin.addEventListener("click", () => window.electronAPI.minimizeWindow());
    if (tbMax) tbMax.addEventListener("click", () => window.electronAPI.maximizeWindow());
    if (tbClose) tbClose.addEventListener("click", () => window.electronAPI.closeWindow());
    const tbSettings = document.getElementById("tbSettings");
    const tbAbout = document.getElementById("tbAbout");
    if (tbSettings) tbSettings.addEventListener("click", () => window.electronAPI.openSettings());
    if (tbAbout) tbAbout.addEventListener("click", () => window.electronAPI.openAbout());
  }

  // Init
  init();

  function init() {
    checkHealth();
    renderChatList();
    loadConversation(currentConversationId);
    setupEventListeners();
    autoResizeInput();
  }

  function setupEventListeners() {
    sendBtn.addEventListener("click", sendMessage);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    inputEl.addEventListener("input", autoResizeInput);
    newChatBtn.addEventListener("click", newChat);
    clearChatBtn.addEventListener("click", clearChat);
    sidebarToggle?.addEventListener("click", () => sidebar.classList.toggle("open"));

    // Quick panel toggle
    const quickToggle = document.getElementById("quickToggle");
    const quickPanel = document.getElementById("quickPanel");
    if (quickToggle && quickPanel) {
      quickToggle.addEventListener("click", () => {
        const open = quickPanel.style.display === "none";
        quickPanel.style.display = open ? "block" : "none";
        quickToggle.classList.toggle("active", open);
      });
    }

    // Quick action buttons (works for both welcome screen and quick panel)
    document.addEventListener("click", (e) => {
      if (e.target.classList.contains("quick-btn")) {
        inputEl.value = e.target.dataset.msg;
        // Close quick panel if open
        if (quickPanel) {
          quickPanel.style.display = "none";
          quickToggle?.classList.remove("active");
        }
        sendMessage();
      }
      // Close sidebar on mobile when clicking outside
      if (sidebar.classList.contains("open") && !sidebar.contains(e.target) && e.target !== sidebarToggle) {
        sidebar.classList.remove("open");
      }
    });
  }

  async function checkHealth() {
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      statusIndicator.classList.remove("error");
      statusText.textContent = "Bağlı";
      toolCountEl.textContent = data.tools || 0;
    } catch (e) {
      statusIndicator.classList.add("error");
      statusText.textContent = "Bağlantı yok";
    }
  }

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || isLoading) return;

    isLoading = true;
    sendBtn.disabled = true;
    inputEl.value = "";
    autoResizeInput();

    // Welcome mesajını kaldır
    const welcome = messagesEl.querySelector(".welcome-message");
    if (welcome) welcome.remove();

    // Kullanıcı mesajını göster
    appendMessage("user", text);
    saveMessage("user", text);

    // Typing indicator
    const typingEl = appendTyping();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, conversationId: currentConversationId }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Sunucu hatası");
      }

      const data = await res.json();

      // Typing'i kaldır
      typingEl.remove();

      // Tool göstergeleri
      let toolsHtml = "";
      if (data.tools_used && data.tools_used.length) {
        toolsHtml = data.tools_used
          .map((t) => `<div class="tool-indicator"><span class="tool-dot"></span>${escapeHtml(t.tool)} ${t.success ? "✓" : "✗"}</div>`)
          .join(" ");
      }

      // Yanıtı göster
      appendMessage("assistant", data.text, data.charts, toolsHtml, data.downloads, data.usage, data.confirmations);
      saveMessage("assistant", data.text, data.charts, data.tools_used, data.downloads, data.usage, data.confirmations);

      // Token sayacını güncelle
      if (data.usage && data.usage.total_tokens) {
        sessionTokens.input += data.usage.input_tokens || 0;
        sessionTokens.output += data.usage.output_tokens || 0;
        sessionTokens.contextWindow = data.usage.context_window || 200000;
        updateTokenFooter();
      }

      // Chat başlığını güncelle
      updateChatTitle(text);
    } catch (err) {
      typingEl.remove();
      appendMessage("assistant", `⚠️ Hata: ${err.message}`);
    }

    isLoading = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }

  function appendMessage(role, text, charts = [], toolsHtml = "", downloads = [], usage = null, confirmations = []) {
    const msgEl = document.createElement("div");
    msgEl.className = `message ${role}`;

    const avatar = role === "user" ? "S" : "AI";
    let contentHtml = "";

    if (role === "assistant") {
      // Tool indicators
      if (toolsHtml) contentHtml += toolsHtml;

      // Markdown render (XSS koruması: DOMPurify)
      contentHtml += DOMPurify.sanitize(marked.parse(text || ""));

      // Chart'ları Canvas olarak render et
      if (charts && charts.length) {
        for (let ci = 0; ci < charts.length; ci++) {
          const chart = charts[ci];
          if (chart.__chart) {
            const chartId = `chart_${Date.now()}_${ci}`;
            const h = chart.chart_type === "gauge" ? 250 : 350;
            contentHtml += `
              <div class="chart-container" id="${chartId}" style="padding:12px; background:var(--bg-secondary); height:${h}px;">
                <canvas></canvas>
              </div>`;
            // Chart.js render'ı DOM'a eklendikten sonra çalışmalı
            setTimeout(() => window.renderChart(chartId, chart), 100);
          }
        }
      }

      // Download butonlarını render et
      if (downloads && downloads.length) {
        for (const dl of downloads) {
          if (dl.__download) {
            contentHtml += `
              <div class="download-container">
                <div class="download-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="12" y1="18" x2="12" y2="12"/>
                    <polyline points="9 15 12 18 15 15"/>
                  </svg>
                </div>
                <div class="download-info">
                  <span class="download-name">${escapeHtml(dl.file_name)}</span>
                  <span class="download-meta">${dl.sheet_count} sayfa, ${dl.total_rows} satır</span>
                </div>
                <a class="download-btn" href="${dl.download_url}" download="${escapeHtml(dl.file_name)}">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  İndir
                </a>
              </div>`;
          }
        }
      }
      // Onay kutuları
      if (confirmations && confirmations.length) {
        for (const c of confirmations) {
          if (c.pending_confirmation) {
            const toolName = escapeHtml(c.tool);
            const inputJson = escapeHtml(JSON.stringify(c.input, null, 2));
            contentHtml += `
              <div class="confirm-action" data-action-id="${escapeHtml(c.action_id)}">
                <div class="confirm-header">⚠️ Onay Gerekli: <strong>${toolName}</strong></div>
                <pre class="confirm-params"><code>${inputJson}</code></pre>
                <div class="confirm-message">${escapeHtml(c.message)}</div>
                <div class="confirm-btns">
                  <button class="btn-approve" onclick="confirmAction('${escapeHtml(c.action_id)}', true)">Onayla</button>
                  <button class="btn-deny" onclick="confirmAction('${escapeHtml(c.action_id)}', false)">İptal</button>
                </div>
              </div>`;
          }
        }
      }
    } else {
      contentHtml = escapeHtml(text).replace(/\n/g, "<br>");
    }

    let tokenHtml = "";
    if (role === "assistant" && usage && usage.total_tokens) {
      const ctxWindow = usage.context_window || 200000;
      const remaining = Math.max(0, ctxWindow - (usage.input_tokens || 0));
      tokenHtml = `<div class="token-info">Giriş: ${formatTokens(usage.input_tokens)} · Yanıt: ${formatTokens(usage.output_tokens)} · Kalan: ${formatTokens(remaining)}</div>`;
    }

    msgEl.innerHTML = `
      <div class="message-avatar">${avatar}</div>
      <div class="message-content">${contentHtml}${tokenHtml}</div>
    `;

    messagesEl.appendChild(msgEl);
    scrollToBottom();
    return msgEl;
  }

  function appendTyping() {
    const el = document.createElement("div");
    el.className = "message assistant";
    el.innerHTML = `
      <div class="message-avatar">AI</div>
      <div class="message-content">
        <div class="typing-indicator"><span></span><span></span><span></span></div>
      </div>
    `;
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function autoResizeInput() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + "px";
  }

  // ============ Conversation Management ============

  function newChat() {
    stopAllGaugeRefreshes();
    sessionTokens = { input: 0, output: 0, contextWindow: 200000 };
    updateTokenFooter();
    currentConversationId = generateId();
    messagesEl.innerHTML = `
      <div class="welcome-message">
        <div class="welcome-icon">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <rect width="48" height="48" rx="12" fill="#3b82f6" opacity="0.1"/>
            <path d="M14 24h20M24 14v20M17 17l14 14M31 17L17 31" stroke="#3b82f6" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </div>
        <h2>inSCADA AI Asistanı</h2>
        <p>SCADA projelerinizi yönetin, scriptleri düzenleyin, endüstriyel verileri analiz edin.</p>
        <div class="quick-actions">
          <button class="quick-btn" data-msg="Space'leri listele">📁 Space'leri Göster</button>
          <button class="quick-btn" data-msg="InfluxDB'deki measurement'ları listele">📊 Measurement'lar</button>
          <button class="quick-btn" data-msg="Son 24 saatte güncellenen scriptleri göster">📝 Son Scriptler</button>
          <button class="quick-btn" data-msg="Sistemin genel durumunu özetle">🔍 Sistem Durumu</button>
          <button class="quick-btn" data-msg="Projeleri listele">🏭 Projeler</button>
          <button class="quick-btn" data-msg="Veritabanından tüm projeleri bul ve aktif alarmları göster">🚨 Aktif Alarmlar</button>
          <button class="quick-btn" data-msg="Veritabanından tüm connection'ları çek ve bağlantı durumlarını kontrol et">🔗 Bağlantı Durumları</button>
          <button class="quick-btn" data-msg="Veritabanından projeleri ve değişkenleri listele, sonra ilk değişkenin canlı değerini oku">📡 Canlı Değer</button>
          <button class="quick-btn" data-msg="InfluxDB'den değişken isimlerini bul ve son 24 saatlik veriyi line chart olarak çiz">📈 Line Chart</button>
          <button class="quick-btn" data-msg="InfluxDB'den değişken isimlerini bul ve ortalamalarını bar chart ile karşılaştır">📊 Bar Chart</button>
          <button class="quick-btn" data-msg="InfluxDB'den bir değişken bul ve anlık değerini gauge olarak göster">🎯 Gauge</button>
          <button class="quick-btn" data-msg="InfluxDB'den bir değişken bul, son 24 saatlik veriyi analiz edip tahmin grafiği oluştur">🔮 Tahmin Grafiği</button>
        </div>
      </div>`;
    chatTitle.textContent = "Yeni Sohbet";
    renderChatList();
  }

  async function clearChat() {
    if (!confirm("Bu sohbeti silmek istediğinize emin misiniz?")) return;
    try {
      await fetch(`/api/chat/${currentConversationId}`, { method: "DELETE" });
    } catch (e) { /* ignore */ }
    delete conversations[currentConversationId];
    localStorage.setItem("inscada_chats", JSON.stringify(conversations));
    newChat();
  }

  function loadConversation(id) {
    stopAllGaugeRefreshes();
    currentConversationId = id;
    const conv = conversations[id];
    if (!conv || !conv.messages || !conv.messages.length) return;

    // Welcome'ı kaldır
    messagesEl.innerHTML = "";
    chatTitle.textContent = conv.title || "Sohbet";

    for (const msg of conv.messages) {
      appendMessage(msg.role, msg.text, msg.charts, "", msg.downloads, msg.usage, msg.confirmations);
    }
    renderChatList();
  }

  function saveMessage(role, text, charts = [], tools = [], downloads = [], usage = null, confirmations = []) {
    if (!conversations[currentConversationId]) {
      conversations[currentConversationId] = { title: "Yeni Sohbet", messages: [], created: Date.now() };
    }
    conversations[currentConversationId].messages.push({ role, text, charts, tools, downloads, usage, confirmations, time: Date.now() });
    localStorage.setItem("inscada_chats", JSON.stringify(conversations));
    renderChatList();
  }

  function updateChatTitle(firstMessage) {
    if (!conversations[currentConversationId]) return;
    if (conversations[currentConversationId].title === "Yeni Sohbet") {
      conversations[currentConversationId].title = firstMessage.substring(0, 50) + (firstMessage.length > 50 ? "..." : "");
      chatTitle.textContent = conversations[currentConversationId].title;
      localStorage.setItem("inscada_chats", JSON.stringify(conversations));
      renderChatList();
    }
  }

  function renderChatList() {
    const sorted = Object.entries(conversations).sort((a, b) => (b[1].created || 0) - (a[1].created || 0));
    chatList.innerHTML = sorted
      .map(([id, conv]) => `<div class="chat-item ${id === currentConversationId ? "active" : ""}" data-id="${id}">${conv.title || "Sohbet"}</div>`)
      .join("");

    chatList.querySelectorAll(".chat-item").forEach((el) => {
      el.addEventListener("click", () => {
        const welcome = messagesEl.querySelector(".welcome-message");
        if (welcome) welcome.remove();
        messagesEl.innerHTML = "";
        loadConversation(el.dataset.id);
        sidebar.classList.remove("open");
      });
    });
  }

  // ============ Utils ============

  function formatTokens(n) {
    if (!n) return "0";
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return String(n);
  }

  function updateTokenFooter() {
    const total = sessionTokens.input + sessionTokens.output;
    const ctxWindow = sessionTokens.contextWindow || 200000;
    const remaining = Math.max(0, ctxWindow - sessionTokens.input);
    const el = document.getElementById("sessionTokens");
    if (el) {
      el.textContent = `Oturum: ${formatTokens(total)} · Kalan: ${formatTokens(remaining)}`;
    }
  }

  function generateId() {
    return "chat_" + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Global: SCADA action confirmation
  window.confirmAction = async function (actionId, approved) {
    const container = document.querySelector(`.confirm-action[data-action-id="${actionId}"]`);
    if (!container) return;
    const btns = container.querySelector(".confirm-btns");
    if (btns) btns.innerHTML = `<span style="color:var(--text-muted);font-size:12px;">${approved ? "İşleniyor..." : "İptal ediliyor..."}</span>`;
    try {
      const res = await fetch("/api/confirm-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId, approved }),
      });
      const data = await res.json();
      const resultEl = document.createElement("div");
      resultEl.style.cssText = "margin-top:8px;padding:8px;border-radius:4px;font-size:12px;";
      if (!approved) {
        resultEl.style.background = "rgba(239,68,68,0.1)";
        resultEl.style.color = "#ef4444";
        resultEl.textContent = "İşlem iptal edildi.";
      } else if (data.error) {
        resultEl.style.background = "rgba(239,68,68,0.1)";
        resultEl.style.color = "#ef4444";
        resultEl.textContent = `Hata: ${data.error}`;
      } else {
        resultEl.style.background = "rgba(16,185,129,0.1)";
        resultEl.style.color = "#10b981";
        resultEl.textContent = `İşlem başarılı: ${JSON.stringify(data.result).substring(0, 200)}`;
      }
      if (btns) btns.replaceWith(resultEl);
    } catch (err) {
      if (btns) btns.innerHTML = `<span style="color:#ef4444;font-size:12px;">Bağlantı hatası: ${escapeHtml(err.message)}</span>`;
    }
  };

  // Global: Code copy
  window.copyCode = function (btn) {
    const code = btn.closest(".code-block").querySelector("code").textContent;
    navigator.clipboard.writeText(code).then(() => {
      btn.textContent = "Kopyalandı!";
      setTimeout(() => (btn.textContent = "Kopyala"), 2000);
    });
  };

  // ============ Chart Rendering (Chart.js) ============

  const CHART_COLORS = [
    { border: "rgba(28, 161, 193, 1)", bg: "rgba(28, 161, 193, 0.15)" },
    { border: "rgba(255, 92, 76, 1)", bg: "rgba(255, 92, 76, 0.15)" },
    { border: "rgba(85, 205, 151, 1)", bg: "rgba(85, 205, 151, 0.15)" },
    { border: "rgba(253, 191, 76, 1)", bg: "rgba(253, 191, 76, 0.15)" },
    { border: "rgba(148, 161, 179, 1)", bg: "rgba(148, 161, 179, 0.15)" },
    { border: "rgba(25, 146, 175, 1)", bg: "rgba(25, 146, 175, 0.15)" },
  ];

  window.renderChart = function (containerId, chartData) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const canvas = container.querySelector("canvas");
    const ctx = canvas.getContext("2d");

    if (chartData.chart_type === "line") {
      new Chart(ctx, {
        type: "line",
        data: {
          datasets: (chartData.series || []).map((s, i) => {
            const c = CHART_COLORS[i % CHART_COLORS.length];
            const isForecast = s.is_forecast === true;
            return {
              label: s.label,
              data: s.data.map(d => ({ x: new Date(d.x), y: d.y })),
              borderColor: c.border,
              backgroundColor: isForecast ? "transparent" : c.bg,
              borderWidth: 2,
              pointRadius: isForecast ? 4 : (s.data.length > 100 ? 0 : 3),
              pointStyle: isForecast ? "rectRot" : "circle",
              fill: !isForecast,
              tension: 0.3,
              borderDash: isForecast ? [6, 4] : [],
            };
          }),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: { display: true, text: chartData.title, color: "#475466", font: { size: 14, weight: "bold" } },
            legend: { display: (chartData.series || []).length > 1, labels: { color: "#657584" } },
          },
          scales: {
            x: { type: "time", ticks: { color: "#657584" }, grid: { color: "rgba(0,0,0,0.06)" } },
            y: { title: { display: true, text: chartData.y_label || "", color: "#657584" }, ticks: { color: "#657584" }, grid: { color: "rgba(0,0,0,0.06)" } },
          },
        },
      });
    } else if (chartData.chart_type === "bar") {
      new Chart(ctx, {
        type: "bar",
        data: {
          labels: chartData.labels,
          datasets: [{
            data: chartData.values,
            backgroundColor: CHART_COLORS.map(c => c.bg).slice(0, chartData.labels.length),
            borderColor: CHART_COLORS.map(c => c.border).slice(0, chartData.labels.length),
            borderWidth: 2,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: { display: true, text: chartData.title, color: "#475466", font: { size: 14, weight: "bold" } },
            legend: { display: false },
          },
          scales: {
            x: { ticks: { color: "#657584" }, grid: { color: "rgba(0,0,0,0.06)" } },
            y: { title: { display: true, text: chartData.y_label || "", color: "#657584" }, ticks: { color: "#657584" }, grid: { color: "rgba(0,0,0,0.06)" } },
          },
        },
      });
    } else if (chartData.chart_type === "gauge") {
      // Mutable ref for live updates
      const dataRef = { value: chartData.value, min: chartData.min, max: chartData.max, unit: chartData.unit || "" };
      chartDataRefs.set(containerId, dataRef);

      const pct = Math.min(Math.max((dataRef.value - dataRef.min) / (dataRef.max - dataRef.min), 0), 1);
      let color;
      if (pct < 0.5) color = "rgba(85, 205, 151, 0.8)";
      else if (pct < 0.75) color = "rgba(253, 191, 76, 0.8)";
      else color = "rgba(255, 92, 76, 0.8)";

      const chartInstance = new Chart(ctx, {
        type: "doughnut",
        data: {
          datasets: [{ data: [pct * 100, (1 - pct) * 100], backgroundColor: [color, "rgba(218,222,224,0.3)"], borderWidth: 0 }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          circumference: 180,
          rotation: 270,
          cutout: "75%",
          plugins: {
            title: { display: true, text: chartData.title, color: "#475466", font: { size: 14, weight: "bold" } },
            legend: { display: false },
          },
        },
        plugins: [{
          id: "gaugeText",
          afterDraw(chart) {
            const ref = chartDataRefs.get(containerId) || dataRef;
            const { ctx: c, width, height } = chart;
            c.save();
            c.textAlign = "center";
            c.font = "bold 24px PT Sans, Inter, sans-serif";
            c.fillStyle = "#475466";
            c.fillText(`${ref.value.toFixed(1)}${ref.unit}`, width / 2, height * 0.6);
            c.font = "12px PT Sans, Inter, sans-serif";
            c.fillStyle = "#94A1B3";
            c.fillText(`${ref.min} — ${ref.max}${ref.unit}`, width / 2, height * 0.73);
            c.restore();
          },
        }],
      });

      chartInstances.set(containerId, chartInstance);

      if (chartData.auto_refresh && chartData.refresh_project_id && chartData.refresh_variable_name) {
        startGaugeAutoRefresh(containerId, chartData);
      }
    }
  };

  // ============ Gauge Auto-Refresh ============

  function startGaugeAutoRefresh(containerId, chartData) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Make container position relative for absolute children
    container.style.position = "relative";

    // Add CANLI indicator
    const indicator = document.createElement("div");
    indicator.className = "gauge-live-indicator";
    indicator.innerHTML = '<span class="gauge-live-dot"></span> CANLI';
    container.appendChild(indicator);

    // Add stop button
    const stopBtn = document.createElement("button");
    stopBtn.className = "gauge-stop-btn";
    stopBtn.textContent = "■";
    stopBtn.title = "Canlı güncellemeyi durdur";
    stopBtn.addEventListener("click", () => stopGaugeAutoRefresh(containerId));
    container.appendChild(stopBtn);

    const intervalId = setInterval(async () => {
      try {
        const resp = await fetch(`/api/live-value?project_id=${chartData.refresh_project_id}&variable_name=${encodeURIComponent(chartData.refresh_variable_name)}`);
        if (!resp.ok) return;
        const data = await resp.json();

        // REST API response: {value, date, variableShortInfo} veya nested
        const rawVal = data.value !== undefined ? data.value : (data.data && data.data.value);
        const val = parseFloat(rawVal);
        if (isNaN(val)) return;

        const ref = chartDataRefs.get(containerId);
        if (!ref) return;
        ref.value = val;

        const chart = chartInstances.get(containerId);
        if (!chart) return;

        const pct = Math.min(Math.max((val - ref.min) / (ref.max - ref.min), 0), 1);
        let color;
        if (pct < 0.5) color = "rgba(85, 205, 151, 0.8)";
        else if (pct < 0.75) color = "rgba(253, 191, 76, 0.8)";
        else color = "rgba(255, 92, 76, 0.8)";

        chart.data.datasets[0].data = [pct * 100, (1 - pct) * 100];
        chart.data.datasets[0].backgroundColor = [color, "rgba(218,222,224,0.3)"];
        chart.update("none");
      } catch (e) {
        // silently ignore fetch errors
      }
    }, 2000);

    chartIntervals.set(containerId, intervalId);
  }

  function stopGaugeAutoRefresh(containerId) {
    const intervalId = chartIntervals.get(containerId);
    if (intervalId) {
      clearInterval(intervalId);
      chartIntervals.delete(containerId);
    }
    chartInstances.delete(containerId);
    chartDataRefs.delete(containerId);

    const container = document.getElementById(containerId);
    if (container) {
      const indicator = container.querySelector(".gauge-live-indicator");
      if (indicator) indicator.remove();
      const stopBtn = container.querySelector(".gauge-stop-btn");
      if (stopBtn) stopBtn.remove();
    }
  }

  function stopAllGaugeRefreshes() {
    for (const [containerId, intervalId] of chartIntervals) {
      clearInterval(intervalId);
    }
    chartIntervals.clear();
    chartInstances.clear();
    chartDataRefs.clear();
  }

  // Cleanup on page unload
  window.addEventListener("beforeunload", stopAllGaugeRefreshes);
})();
