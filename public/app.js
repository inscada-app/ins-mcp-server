/**
 * inSCADA AI Chat - Frontend
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

    // Quick action buttons
    document.addEventListener("click", (e) => {
      if (e.target.classList.contains("quick-btn")) {
        inputEl.value = e.target.dataset.msg;
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
          .map((t) => `<div class="tool-indicator"><span class="tool-dot"></span>${t.tool} ${t.success ? "✓" : "✗"}</div>`)
          .join(" ");
      }

      // Yanıtı göster
      appendMessage("assistant", data.text, data.charts, toolsHtml);
      saveMessage("assistant", data.text, data.charts, data.tools_used);

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

  function appendMessage(role, text, charts = [], toolsHtml = "") {
    const msgEl = document.createElement("div");
    msgEl.className = `message ${role}`;

    const avatar = role === "user" ? "S" : "AI";
    let contentHtml = "";

    if (role === "assistant") {
      // Tool indicators
      if (toolsHtml) contentHtml += toolsHtml;

      // Markdown render
      contentHtml += marked.parse(text || "");

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
            setTimeout(() => window.renderChart(chartId, chart), 50);
          }
        }
      }
    } else {
      contentHtml = escapeHtml(text).replace(/\n/g, "<br>");
    }

    msgEl.innerHTML = `
      <div class="message-avatar">${avatar}</div>
      <div class="message-content">${contentHtml}</div>
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
    currentConversationId = id;
    const conv = conversations[id];
    if (!conv || !conv.messages || !conv.messages.length) return;

    // Welcome'ı kaldır
    messagesEl.innerHTML = "";
    chatTitle.textContent = conv.title || "Sohbet";

    for (const msg of conv.messages) {
      appendMessage(msg.role, msg.text, msg.charts, "");
    }
    renderChatList();
  }

  function saveMessage(role, text, charts = [], tools = []) {
    if (!conversations[currentConversationId]) {
      conversations[currentConversationId] = { title: "Yeni Sohbet", messages: [], created: Date.now() };
    }
    conversations[currentConversationId].messages.push({ role, text, charts, tools, time: Date.now() });
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

  function generateId() {
    return "chat_" + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

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
            return {
              label: s.label,
              data: s.data.map(d => ({ x: new Date(d.x), y: d.y })),
              borderColor: c.border,
              backgroundColor: c.bg,
              borderWidth: 2,
              pointRadius: s.data.length > 100 ? 0 : 3,
              fill: true,
              tension: 0.3,
            };
          }),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: { display: true, text: chartData.title, color: "#d4dae3", font: { size: 14, weight: "bold" } },
            legend: { display: (chartData.series || []).length > 1, labels: { color: "#94a1b3" } },
          },
          scales: {
            x: { type: "time", ticks: { color: "#657584" }, grid: { color: "rgba(255,255,255,0.05)" } },
            y: { title: { display: true, text: chartData.y_label || "", color: "#94a1b3" }, ticks: { color: "#657584" }, grid: { color: "rgba(255,255,255,0.05)" } },
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
            title: { display: true, text: chartData.title, color: "#d4dae3", font: { size: 14, weight: "bold" } },
            legend: { display: false },
          },
          scales: {
            x: { ticks: { color: "#657584" }, grid: { color: "rgba(255,255,255,0.05)" } },
            y: { title: { display: true, text: chartData.y_label || "", color: "#94a1b3" }, ticks: { color: "#657584" }, grid: { color: "rgba(255,255,255,0.05)" } },
          },
        },
      });
    } else if (chartData.chart_type === "gauge") {
      const pct = Math.min(Math.max((chartData.value - chartData.min) / (chartData.max - chartData.min), 0), 1);
      let color;
      if (pct < 0.5) color = "rgba(75, 192, 192, 0.8)";
      else if (pct < 0.75) color = "rgba(255, 205, 86, 0.8)";
      else color = "rgba(255, 99, 132, 0.8)";

      new Chart(ctx, {
        type: "doughnut",
        data: {
          datasets: [{ data: [pct * 100, (1 - pct) * 100], backgroundColor: [color, "rgba(50,50,60,0.3)"], borderWidth: 0 }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          circumference: 180,
          rotation: 270,
          cutout: "75%",
          plugins: {
            title: { display: true, text: chartData.title, color: "#d4dae3", font: { size: 14, weight: "bold" } },
            legend: { display: false },
          },
        },
        plugins: [{
          id: "gaugeText",
          afterDraw(chart) {
            const { ctx: c, width, height } = chart;
            c.save();
            c.textAlign = "center";
            c.font = "bold 24px Inter, sans-serif";
            c.fillStyle = "#e4e4e7";
            c.fillText(`${chartData.value.toFixed(1)}${chartData.unit || ""}`, width / 2, height * 0.6);
            c.font = "12px Inter, sans-serif";
            c.fillStyle = "#71717a";
            c.fillText(`${chartData.min} — ${chartData.max}${chartData.unit || ""}`, width / 2, height * 0.73);
            c.restore();
          },
        }],
      });
    }
  };
})();
