# @inscada/mcp-server

inSCADA MCP Server — SCADA operations via [Model Context Protocol](https://modelcontextprotocol.io).

Connect Claude Desktop, VS Code Copilot, Cursor, or any MCP client to your inSCADA system. 36 tools for live values, alarms, scripts, historical data, charts, Excel export, and more.

> **Note:** This MCP server is designed for **inSCADA JDK11** edition.

---

inSCADA MCP Server — [Model Context Protocol](https://modelcontextprotocol.io) üzerinden SCADA operasyonları.

Claude Desktop, VS Code Copilot, Cursor veya herhangi bir MCP istemcisini inSCADA sisteminize bağlayın. Canlı değer, alarm, script, tarihsel veri, grafik, Excel dışa aktarma ve daha fazlası için 36 araç.

> **Not:** Bu MCP sunucusu **inSCADA JDK11** sürümü için tasarlanmıştır.

## What is this? / Bu ne işe yarar?

This MCP server lets AI assistants (like Claude) directly interact with your inSCADA system using natural language.

Bu MCP sunucusu, AI asistanların (Claude gibi) doğal dil kullanarak inSCADA sisteminizle etkileşime girmesini sağlar.

### 🏭 Application Development / Uygulama Geliştirme

Build and maintain SCADA applications through natural language. Write and debug scripts, design animations and faceplates, create custom menus, and explore your project structure — all by describing what you need.

Doğal dil ile SCADA uygulamaları geliştirin. Script yazın ve hata ayıklayın, animasyon ve faceplate tasarlayın, özel menüler oluşturun, proje yapınızı keşfedin — ihtiyacınızı tarif ederek.

- *"Write a script that calculates daily energy consumption"*
- *"Find all scripts that reference AN01_Active_Power"*
- *"Create a navigation menu for the operator dashboard"*

### 📊 Data Analytics / Veri Analitiği

Analyze historical data, generate trend charts, create forecasts, and export reports — without writing queries or configuring dashboards.

Tarihsel verileri analiz edin, trend grafikleri oluşturun, tahminler üretin ve raporları dışa aktarın — sorgu yazmadan veya dashboard yapılandırmadan.

- *"Show me the temperature trend for the last 24 hours"*
- *"Forecast the next 6 hours of active power"*
- *"Export the daily production summary to Excel"*

### 🔍 Operations & Monitoring / Operasyon ve İzleme

Monitor your SCADA system in real time. Check live values, view active alarms, inspect connection status, and track project health — just by asking.

SCADA sisteminizi gerçek zamanlı izleyin. Canlı değerleri kontrol edin, aktif alarmları görüntüleyin, bağlantı durumunu inceleyin ve proje sağlığını takip edin — sadece sorarak.

- *"What is the current value of AN01_Active_Power?"*
- *"Are there any active alarms?"*
- *"What scripts are running?"*

---

The AI understands your intent, calls the right tools, and returns the results — all through a chat interface.

AI niyetinizi anlar, doğru araçları çağırır ve sonuçları döner — hepsi bir sohbet arayüzünden.

## Quick Start / Hızlı Başlangıç

Add to your Claude Desktop config / Claude Desktop yapılandırmanıza ekleyin:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "inscada": {
      "command": "npx",
      "args": ["-y", "@inscada/mcp-server"],
      "env": {
        "INSCADA_API_URL": "http://localhost:8081",
        "INSCADA_USERNAME": "your_username",
        "INSCADA_PASSWORD": "your_password"
      }
    }
  }
}
```

Restart Claude Desktop. That's it! / Claude Desktop'ı yeniden başlatın. Bu kadar!

## Requirements / Gereksinimler

- [Node.js](https://nodejs.org) 18+
- A running inSCADA instance / Çalışan bir inSCADA sunucusu

## Environment Variables / Ortam Değişkenleri

| Variable | Required | Description |
|----------|----------|-------------|
| `INSCADA_API_URL` | No | inSCADA API base URL (default: `http://localhost:8081`) |
| `INSCADA_USERNAME` | Yes | inSCADA login username / Kullanıcı adı |
| `INSCADA_PASSWORD` | Yes | inSCADA login password / Şifre |

## Tools (36) / Araçlar (36)

### Space Management

| Tool | Description |
|------|-------------|
| `set_space` | Switch active space / Aktif space değiştirme |

### Data / Veri

| Tool | Description |
|------|-------------|
| `list_spaces` | List spaces / Space listesi |
| `list_projects` | List projects / Proje listesi |
| `list_variables` | List variables (tags) / Değişken listesi |
| `list_scripts` | List scripts / Script listesi |
| `get_script` | Get script code & details / Script kodu ve detayları |
| `update_script` | Update script code / Script güncelleme |
| `list_connections` | List connections / Bağlantı listesi |
| `search_in_scripts` | Search text in scripts / Scriptlerde metin arama |

### Animation / Animasyon

| Tool | Description |
|------|-------------|
| `list_animations` | List animations / Animasyon listesi |
| `get_animation` | Get animation details / Animasyon detayları |

### SCADA (REST API)

| Tool | Description |
|------|-------------|
| `inscada_get_live_value` | Read live value / Canlı değer okuma |
| `inscada_get_live_values` | Read multiple live values / Çoklu canlı değer |
| `inscada_set_value` | Write value to variable / Değer yazma |
| `inscada_get_fired_alarms` | Get active alarms / Aktif alarmlar |
| `inscada_connection_status` | Connection status / Bağlantı durumu |
| `inscada_project_status` | Project status / Proje durumu |
| `inscada_run_script` | Execute script / Script çalıştırma |
| `inscada_script_status` | Script status / Script durumu |
| `inscada_logged_values` | Historical log data / Tarihsel log verileri |
| `inscada_logged_stats` | Statistics (min, max, avg, sum) / İstatistikler |

### Generic API

| Tool | Description |
|------|-------------|
| `inscada_api_endpoints` | List available API endpoints / API endpoint listesi |
| `inscada_api_schema` | Get endpoint schema / Endpoint şeması |
| `inscada_api` | Call any API endpoint / Herhangi bir API çağrısı |

### Charts / Grafikler

| Tool | Description |
|------|-------------|
| `chart_line` | Time series line chart / Zaman serisi çizgi grafik |
| `chart_bar` | Bar chart / Çubuk grafik |
| `chart_gauge` | Live gauge / Canlı gösterge |
| `chart_multi` | Multi-series chart / Çoklu seri grafik |
| `chart_forecast` | Forecast chart / Tahmin grafiği |

### Custom Menus / Menüler

| Tool | Description |
|------|-------------|
| `list_custom_menus` | List menus / Menü listesi |
| `get_custom_menu` | Get menu details / Menü detayları |
| `get_custom_menu_by_name` | Find menu by name / İsme göre menü arama |
| `create_custom_menu` | Create menu / Menü oluşturma |
| `update_custom_menu` | Update menu / Menü güncelleme |
| `delete_custom_menu` | Delete menu / Menü silme |

### Export / Dışa Aktarma

| Tool | Description |
|------|-------------|
| `export_excel` | Export to Excel (.xlsx) / Excel dışa aktarma |

## Security / Güvenlik

Dangerous tools are blocked in MCP and require confirmation through the inSCADA AI Assistant app:

Tehlikeli araçlar MCP'de engellenmiştir ve sadece inSCADA AI Asistan uygulamasından onay ile çalıştırılabilir:

- `inscada_set_value` — Writes to real equipment / Gerçek ekipmana yazma
- `inscada_run_script` — Executes server-side script / Sunucu tarafında script çalıştırma
- `update_script` — Modifies script code / Script kodunu değiştirme

## License / Lisans

MIT
