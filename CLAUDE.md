# inSCADA AI Asistan - Project Reference

## Overview
Express.js + Claude API asistan app with 33 tools for querying PostgreSQL (inscada), InfluxDB, generating Charts (line, bar, gauge, multi, forecast), Excel export, and inSCADA REST API integration for live SCADA operations.

## Key Files
- `server.js` - Express server, routes, Claude API integration
- `tools.js` - Tool definitions (JSON schemas for Claude)
- `tool-handlers.js` - Tool execution logic (SQL, InfluxQL, chart rendering)
- `mcp-server.mjs` - MCP server for external tool access
- `public/` - Frontend (HTML/CSS/JS chat UI)

## InfluxDB Data Model
- **Main measurement**: `variable_value` in retention policy `variable_value_rp`
  - Query pattern: `SELECT ... FROM "variable_value_rp"."variable_value" WHERE ...`
  - **Tags**: name, node_id, project, project_id, space, space_id, variable_id
  - **Field**: value (float)
- **Other measurements**: `auth_attempt`, `event_log`, `fired_alarm` (same RP convention: `{m}_rp.{m}`)
- **Example variable names**: AN01_Active_Power, AN01_Reactive_Power, AN01_Wind_Speed

## PostgreSQL Schema (inscada)
> Convention: most tables have `insert_user, insert_dttm, version_user, version_dttm, space_id`

### Core Hierarchy
```
space(space_id PK, name, insert_user, insert_dttm, version_user, version_dttm)

project(project_id PK, name, dsc, address, latitude, longitude, contract_day, contract_hour,
  active_flag, properties, icon, space_id, insert_user/dttm, version_user/dttm)

script(script_id PK, project_id->project, name, dsc, code TEXT, sch_type, period, delay,
  sch_time, off_set, log_flag, owner_id->users, space_id, insert/version_user/dttm)

script_history(history_id PK, script_id->script, name, code TEXT, changed_by, changed_at, change_reason)

connection(conn_id PK, project_id->project, name, dsc, protocol, ip, port,
  owner_id->users, space_id, insert/version_user/dttm)

device(device_id PK, conn_id->connection, name, dsc, properties TEXT, space_id, insert/version_user/dttm)

frame(frame_id PK, device_id->device, name, dsc, minutes_offset, scan_time_factor,
  readable_flag, writable_flag, space_id, insert/version_user/dttm)

variable(variable_id PK, frame_id->frame, project_id->project, name, dsc, code,
  value_expression TEXT, value_expression_type, value_expression_id->expression,
  fractional_digit_count, raw_zero_scale, raw_full_scale, eng_zero_scale, eng_full_scale,
  unit, log_type, log_period, log_threshold, log_expression, log_expression_id->expression,
  log_min_value, log_max_value, set_min_value, set_max_value,
  active_flag, pulse_on_flag, pulse_off_flag, pulse_on_duration, pulse_off_duration,
  keep_last_values, space_id, insert/version_user/dttm)
```

### Alarms
```
alarm_group(alarm_group_id PK, project_id->project, name, dsc, scan_time, priority,
  on/off/ack_script_id->script, on_no_ack_color, on_ack_color, off_no_ack_color, off_ack_color,
  printer_ip, printer_port, print_when_on/off/ack, hidden_on_monitor, owner_id->users, space_id)

alarm(alarm_id PK, project_id->project, name, dsc, delay, group_id->alarm_group,
  active_flag, part, on_time_variable_id->variable, off_time_variable_id->variable, space_id)

analog_alarm(alarm_id PK/FK->alarm, variable_id->variable, set_point_value, high_high_value,
  high_value, low_value, low_low_value, dead_band, deviation_percentage)

digital_alarm(alarm_id PK/FK->alarm, variable_a_id->variable, variable_b_id->variable,
  variable_a/b_inverted, and_calc, variable_a/b_bit_offset)

custom_alarm(alarm_id PK/FK->alarm, condition)
```

### Visualization
```
animation(animation_id PK, project_id->project, name, dsc, svg_content TEXT, anim_join_id,
  color, duration, play_order, main_flag, pre/post_anim_code, configs, alignment, placeholders, space_id)
animation_element(anim_element_id PK, animation_id->animation, name, dsc, expression TEXT,
  expression_type, type, dom_id, props TEXT, status_flag, space_id)
animation_script(animation_script_id PK, animation_id, type, script_id->script, space_id)

faceplate(faceplate_id PK, project_id->project, name, dsc, svg_content TEXT, color, space_id)
faceplate_element(faceplate_element_id PK, faceplate_id->faceplate, name, expression, expression_type, type, dom_id, props)
faceplate_placeholder(placeholder_id PK, faceplate_id->faceplate, name, type, props, placeholder_group, placeholder_order, dsc)

trend(trend_id PK, project_id->project, name, dsc, period, configs, trend_order, space_id)
trend_tag(trend_tag_id PK, trend_id->trend, name, dsc, variable_id->variable,
  min_scale, max_scale, color, thickness, status_flag, grid_thickness, hide_value_axe, tag_order, space_id)

monitor_table(monitor_table_id PK, project_id->project, name, dsc, x_count, space_id)
monitor_variable(monitor_variable_id PK, monitor_table_id, type, sort_order, variable_id->variable, space_id)

board_group(board_group_id PK, name, color, rank, space_id)
board(board_id PK, board_group_id->board_group, type, x, y, width, height, config TEXT, header, space_id)
symbol(symbol_id PK, name, dsc, content TEXT, space_id)
```

### Reports
```
report(report_id PK, project_id->project, name, dsc, no, period, report_day, report_time,
  print_flag, print_day, print_time, lang, mail_flag, mail_day, mail_time, mail_to,
  logo_flag, minutes, owner_id->users, space_id)
report_group(report_group_id PK, name, report_id->report, group_order, space_id)
report_subgroup(report_subgroup_id PK, name, report_group_id->report_group, subgroup_order, space_id)
report_variable(report_variable_id PK, name, report_subgroup_id->report_subgroup, calc_type,
  variable_order, variable_id->variable, total_variable_id->variable, deviation_variable_id->variable,
  total_calc_type, deviation_calc_report_variable_id->report_variable, pattern, space_id)

jasper_report(jasper_report_id PK, project_id->project, name, dsc, template_file, parameters, datasource, subreports, space_id)
jspdf_report(jspdf_report_id PK, project_id->project, name, dsc, script TEXT, space_id)
```

### Users & Auth
```
users(user_id PK, username, passwd, email, phone, otp_type, require_password_reset, eula_accepted)
roles(role_id PK, name)
permissions(permission_id PK, name)
role_members(role_id->roles, user_id->users)  -- composite PK
role_menus(role_id->roles, menu_id->menus)     -- composite PK
role_permissions(role_id->roles, permission_id->permissions) -- composite PK
menus(menu_id PK, name)
space_users(space_id, user_id)  -- composite PK
```

### Communication Protocols
Each protocol has `{proto}_connection`, `{proto}_device`, `{proto}_frame`, `{proto}_variable` tables extending the base connection/device/frame/variable via shared PK:
- **modbus_** (timeout, pool_size, retries, station_address, scan_time, type, start_address, quantity, byte/word_swap)
- **s7_** (rack, slot, type, db_number, start_address, bit_offset)
- **opc_ua_** (server_name, security_mode/policy, username/password, namespace_index, identifier)
- **opc_da_** (com_prog_id, separator, max_depth, percent_deadband, subscription_mode)
- **opc_xml_** (connect_timeout, request_timeout, path, wait_time, hold_time)
- **iec104_** (cot/ca/ioa_field_length, common_address, read/write_address)
- **iec61850_** (local_ip/port, response_timeout, object_reference, fc)
- **dnp3_** (adapter, pool_size, local/remote_address, point_class, static/event_variation)
- **ethernet_ip_** (timeout, retries, slot, scan_time)
- **fatek_** (timeout, station_address, type, start_address)
- **mqtt_** (identifier, username/password, use_ssl, base_topic, topic, qos, subscribe/publish_expression)
- **local_** (scan_time, scan_type, type)

### Other Tables
```
expression(expression_id PK, name, dsc, code TEXT, space_id)
data_transfer(data_transfer_id PK, project_id, name, dsc, period, owner_id->users, space_id)
data_transfer_detail(data_transfer_detail_id PK, data_transfer_id->data_transfer,
  source_var_id->variable, target_var_id->variable, calc_type, range_type, threshold, space_id)
custom_datasource(custom_datasource_id PK, project_id->project, name, dsc, url, username, password, space_id)
custom_query(custom_query_id PK, project_id->project, name, dsc, query_str TEXT, space_id)
custom_table(custom_table_id PK, name, space_id)
custom_table_field(custom_table_field_id PK, custom_table_id->custom_table, field_name, field_type, field_length, required, default_value, sort_order)
custom_menu(custom_menu_id PK, name, icon, target, position, content_type, content, parent_id->custom_menu, menu_order, space_id)
map_variable(map_variable_id PK, project_id->project, variable_id->variable, var_order, space_id)
trace_table(trace_table_id PK, project_id->project, name, config TEXT, space_id)
keyword(keyword_id PK, type, key, dsc, active, props TEXT, space_id)
language(language_id PK, lang, key, value, dsc, space_id)
project_attachment(project_attachment_id PK, project_id, name, dsc, file_name, file_size, file_type, data BYTEA, space_id)
```

## Key FK Relationship Chains
```
space -> project -> script, variable, connection, alarm_group, alarm, report, animation, faceplate, trend, monitor_table, jasper_report, jspdf_report, custom_datasource, custom_query, trace_table, map_variable
connection -> device -> frame -> variable
alarm_group -> alarm -> analog_alarm | digital_alarm | custom_alarm
report -> report_group -> report_subgroup -> report_variable -> variable
trend -> trend_tag -> variable
script_history -> script
board_group -> board
roles -> role_members -> users
roles -> role_permissions -> permissions
roles -> role_menus -> menus
```

## inSCADA REST API Tools
Base URL: `INSCADA_API_URL` (default: `http://localhost:8081`).

### Auth Mekanizması
- `POST /login` ile multipart form-data gönderilir (`username`, `password`)
- Response `Set-Cookie` header'larında `ins_access_token` ve `ins_refresh_token` döner
- Token'lar 3.5 dk'da bir otomatik yenilenir (4 dk expiry'den önce)
- Her istekte `Cookie` header'ı + `X-Space: default_space` header'ı gönderilir
- İlk istek geldiğinde lazy login yapılır, 401/403'te token sıfırlanır

### Env Değişkenleri
- `INSCADA_API_URL` — API base URL (varsayılan: `http://localhost:8081`)
- `INSCADA_USERNAME` — Login kullanıcı adı
- `INSCADA_PASSWORD` — Login şifresi

### Tool Tablosu

| # | Tool | Method | Endpoint | Açıklama |
|---|------|--------|----------|----------|
| 1 | `inscada_get_live_value` | GET | `/api/variables/value?projectId=X&name=Y` | Tek değişken canlı değer. Response: `{value, date, variableShortInfo: {name, connection, code, project}}` |
| 2 | `inscada_get_live_values` | GET | `/api/variables/values?projectId=X&names=Y1,Y2` | Çoklu canlı değer. Response: `{varName: {value, date, ...}, ...}` |
| 3 | `inscada_set_value` | POST | `/api/variables/value?projectId=X&name=Y` | Değişkene değer yaz. Body: `{value: N}`. **DİKKAT: Gerçek ekipmana komut gönderir** |
| 4 | `inscada_get_fired_alarms` | GET | `/api/alarms/fired-alarms/monitor?projectId=X&count=N` | Aktif alarmlar. Response: `[{name, status, onTime, dsc, firedAlarmType, alarmId, part, ...}]` |
| 5 | `inscada_connection_status` | GET | `/api/connections/status?connectionIds=X` | Bağlantı durumları. Response: `{connId: "Connected"\|"Disconnected"}` |
| 6 | `inscada_project_status` | GET | `/api/projects/{id}/status` | Proje durumu. Response: `{scriptStatuses, connectionStatuses, alarmGroupStatuses, dataTransferStatuses, reportStatuses}` |
| 7 | `inscada_run_script` | POST | `/api/scripts/{id}/run` | Script çalıştır. Script'in dönüş değerini response olarak verir |
| 8 | `inscada_script_status` | GET | `/api/scripts/{id}/status` | Script durumu. Response: `"Not Scheduled"\|"Running"\|...` |
| 9 | `inscada_logged_values` | GET | `/api/variables/loggedValues?variableIds=X&startDate=Y&endDate=Z` | Tarihsel log verisi. Response: `[{value, dttm, name, projectId, ...}]` |

### Önemli Detaylar
- **Tarih formatı**: `inscada_logged_values` için tarihler `yyyy-MM-dd HH:mm:ss` formatında gönderilmeli (Örn: `2026-02-27 00:00:00`). ISO 8601 formatı (`T`, `Z`, `+03:00`) otomatik dönüştürülür.
- **variableIds**: `explode` parametresi — birden fazla ID için `variableIds=1&variableIds=2` formatında gönderilir (virgülle değil).
- **Fired alarms**: `project_id` verilirse `/fired-alarms/monitor` endpoint'i kullanılır (daha güvenilir). Verilmezse `/fired-alarms` ile sayfalı sorgu yapılır.
- **X-Space header**: Tüm isteklerde `X-Space: default_space` gönderilir. Multi-space ortamlarda bu değer değiştirilmeli.
- **set_value güvenliği**: Sunucu tarafında 2 aşamalı onay mekanizması — `inscada_set_value` ve `inscada_run_script` doğrudan çalıştırılmaz, kullanıcıdan UI üzerinden onay alınır (bkz. Security bölümü).

### Live vs Historical Data
- **Canlı (anlık) değerler**: `inscada_get_live_value` / `inscada_get_live_values` (REST API)
- **Tarihsel zaman serisi**: `influx_query` / `influx_stats` (InfluxDB) veya `inscada_logged_values` (REST API)
- **Grafikler**: `chart_line`, `chart_bar`, `chart_gauge`, `chart_multi`, `chart_forecast` (InfluxDB tabanlı)
- **Canlı Gauge**: `chart_gauge` + `auto_refresh=true` ile 2 sn'de bir REST API'den güncellenen gauge

### Swagger UI
Tüm API endpoint'leri: `http://localhost:8081/swagger-ui/`
API dokümanı (JSON): `http://localhost:8081/v3/api-docs`

## Gauge Auto-Refresh (Canlı Güncelleme)
`chart_gauge` tool'u `auto_refresh=true` parametresiyle çağrıldığında gauge 2 saniyede bir canlı değer alarak yerinde güncellenir.

### Ek Parametreler
| Parametre | Tip | Açıklama |
|-----------|-----|----------|
| `auto_refresh` | boolean | Canlı güncelleme açık/kapalı |
| `refresh_project_id` | number | inSCADA REST API project ID |
| `refresh_variable_name` | string | inSCADA REST API variable adı |

### Proxy Endpoint
- `GET /api/live-value?project_id=X&variable_name=Y` — server.js'teki proxy, `executeTool("inscada_get_live_value", ...)` kullanır

### Veri Akışı
```
Claude → chart_gauge(auto_refresh:true, refresh_project_id, refresh_variable_name)
  → InfluxDB'den ilk değer → __chart objesi frontend'e gönderilir
  → Frontend gauge çizer, setInterval(2000) başlatır
  → Her 2 sn: GET /api/live-value → server.js proxy → inSCADA REST API
  → chart.update("none") ile gauge yerinde güncellenir
  → Stop butonu veya sohbet değişince clearInterval
```

### Frontend State (app.js)
- `chartInstances` Map — containerId → Chart instance
- `chartIntervals` Map — containerId → intervalId
- `chartDataRefs` Map — containerId → mutable {value, min, max, unit}
- `stopAllGaugeRefreshes()` — newChat/loadConversation/beforeunload'da çağrılır

## Forecast Chart (Tahmin Grafiği)
`chart_forecast` tool'u tarihsel veri ile Claude'un ürettiği tahmin verilerini tek grafik üzerinde gösterir. Tarihsel kısım düz çizgi, tahmin kısmı kesikli çizgi (dashed) ve elmas noktalarla çizilir.

### Parametreler
| Parametre | Tip | Zorunlu | Açıklama |
|-----------|-----|---------|----------|
| `measurement` | string | Evet | Measurement adı (Örn: variable_value) |
| `field` | string | Hayır | Field (varsayılan: value) |
| `time_range` | string | Hayır | Tarihsel veri aralığı (Örn: 6h, 24h, 7d) |
| `where_clause` | string | Hayır | InfluxDB filtre (Örn: "name"='AN01_Active_Power') |
| `group_by_time` | string | Hayır | Zaman gruplama (Örn: 5m, 1h) |
| `forecast_values` | array | Evet | Tahmin noktaları: `[{x: ISO_timestamp, y: number}, ...]` |
| `forecast_label` | string | Hayır | Tahmin serisi etiketi (varsayılan: "Tahmin") |
| `title` | string | Hayır | Grafik başlığı |
| `y_label` | string | Hayır | Y ekseni birimi (Örn: kW, °C) |
| `database` | string | Hayır | InfluxDB veritabanı |

### Akış
```
Claude → tarihsel veriyi çek (influx_query/chart_line) → analiz et → forecast_values üret
  → chart_forecast(measurement, field, time_range, where_clause, group_by_time, forecast_values)
  → Handler: InfluxDB'den tarihsel seri (is_forecast: false) + tahmin serisi (is_forecast: true)
  → Köprü noktası: tarihsel son nokta → tahmin başına eklenir (boşluksuz birleşim)
  → Frontend: is_forecast=false → düz çizgi/dolgulu, is_forecast=true → kesikli çizgi/elmas/dolgu yok
```

### Frontend Stil Farkları
| Özellik | Tarihsel (is_forecast: false) | Tahmin (is_forecast: true) |
|---------|-------------------------------|----------------------------|
| Çizgi stili | Düz (solid) | Kesikli (`borderDash: [6, 4]`) |
| Dolgu | Var (`fill: true`) | Yok (`fill: false`) |
| Nokta şekli | Daire (`circle`) | Elmas (`rectRot`) |
| Nokta boyutu | 0 veya 3 (veri sayısına göre) | 4 (sabit) |
| Arka plan | Renk dolgusu | Şeffaf (`transparent`) |

## Excel Export (Dosya İndirme)
`export_excel` tool'u sorgu sonuçlarını .xlsx dosyası olarak dışa aktarır. SheetJS (xlsx) kütüphanesi kullanılır. Frontend'de indirme butonu gösterilir.

### Parametreler
| Parametre | Tip | Zorunlu | Açıklama |
|-----------|-----|---------|----------|
| `file_name` | string | Evet | Dosya adı (.xlsx uzantısız, Örn: space_listesi) |
| `sheets` | array | Evet | Sheet dizisi: `[{name, headers, rows}, ...]` |
| `sheets[].name` | string | Evet | Sheet adı (max 31 karakter) |
| `sheets[].headers` | string[] | Evet | Sütun başlıkları |
| `sheets[].rows` | array[] | Evet | Satır verileri (2D dizi, her satır bir array) |

### Akış
```
User: "excel olarak ver"
  → Claude: run_query/influx_query/list_spaces vb. ile veriyi çeker
  → Claude: export_excel({file_name, sheets}) çağırır
  → Handler: XLSX workbook oluşturur → os.tmpdir()/inscada-downloads/ altına yazar
  → Return: {__download: true, file_name, download_url, sheet_count, total_rows}
  → server.js: downloadList'e ekler, response'a downloads[] olarak döner
  → Frontend: download-container render eder (dosya ikonu + ad + meta + İndir butonu)
  → Tıklama → GET /api/downloads/:filename → dosya iner
```

### Dosya Depolama
- Geçici klasör: `path.join(os.tmpdir(), "inscada-downloads")`
- Dosya adı: `{safeName}_{timestamp}.xlsx` (özel karakterler `_` ile değiştirilir)
- Sütun genişlikleri: header ve veri uzunluğuna göre otomatik ayarlanır (max 50 karakter)

### Download Endpoint
- `GET /api/downloads/:filename` — `path.resolve()` containment + regex format kontrolü (bkz. Security bölümü)
- `res.download()` ile dosya serve edilir

### Frontend Render (app.js)
- `appendMessage(role, text, charts, toolsHtml, downloads, usage, confirmations)` — downloads + confirmations parametreleri
- `saveMessage(role, text, charts, tools, downloads, usage, confirmations)` — localStorage'a kaydedilir
- `loadConversation()` — `msg.downloads` ve `msg.confirmations` geçirilir
- Download butonu: `.download-container` içinde SVG dosya ikonu + dosya adı + meta bilgi + "İndir" butonu
- Onay kutusu: `.confirm-action` içinde tool adı + parametreler + Onayla/İptal butonları

### __download Pattern
`__chart` pattern'inin aynısı:
```
tool handler return → {__download: true, ...}
  → server.js chat() içinde result.__download tespiti → downloadList'e eklenir
  → response: {text, charts, downloads, confirmations, tools_used}
  → frontend: downloads + confirmations dizileri render edilir
```

## Tool Öncelik Kuralları (SYSTEM_PROMPT)
Claude'un gereksiz tool çağrıları yapmasını engellemek için SYSTEM_PROMPT'a eklenen kurallar:

| İstek | Kullanılacak Tool | run_query/influx_query DEĞİL |
|-------|-------------------|------------------------------|
| Space listesi | `list_spaces` | - |
| Proje listesi | `list_projects` | - |
| Script listesi | `list_scripts` | - |
| Script içeriği | `get_script` | - |
| Script arama | `search_in_scripts` | - |

- `run_query` sadece hazır tool'ların karşılamadığı özel SQL sorguları için, DAİMA `inscada.` şemasıyla
- `information_schema` / `pg_tables` sorguları yasaklandı (schema zaten SYSTEM_PROMPT'ta)
- `influx_query` sadece hazır tool'lar (`influx_stats`, `chart_*`) yetersiz kaldığında
- Tek tool yeterliyse birden fazla tool çağrılmaz

## Performans Loglama
`server.js` → `chat()` fonksiyonunda üç seviye log:

| Log | Format | Açıklama |
|-----|--------|----------|
| `[API]` | `Claude yanıt {ms}ms (in:{tokens} out:{tokens})` | Her Claude API roundtrip süresi + token |
| `[Tool]` | `{tool_name} {ms}ms ({params})` | Her tool çağrısının süresi + parametreleri |
| `[Chat]` | `Toplam {ms}ms, {n} tur, {n} tool` | İstek başına toplam süre özeti |

### Değişkenler
- `chatStart` — fonksiyon başında `Date.now()`, return öncesi toplam süre hesaplanır
- `loopCount` — while döngüsünde her turda artırılır (1 tur = 1 API çağrısı)
- `apiStart` / `apiMs` — `anthropic.messages.create()` öncesi/sonrası
- `toolStart` / `toolMs` — `executeTool()` öncesi/sonrası

### Örnek Konsol Çıktısı
```
[API] Claude yanıt 1956ms (in:8027 out:36)
[Tool] list_projects 86ms ({})
[API] Claude yanıt 5261ms (in:8110 out:169)
[Chat] Toplam 7305ms, 2 tur, 1 tool
```

## Security (IEC 62443)

### Network Binding
- Express `127.0.0.1`'e bind edilir (`server.js`) — sadece localhost erişimi, ağdan erişim engellenir
- Electron-only kullanım, authentication yok

### SQL Injection Koruması (run_query)
- Sadece `SELECT` / `WITH` ile başlayan sorgular izinli
- Noktalı virgül (`;`) ile çoklu sorgu engeli
- SQL yorumları (`--`, `/*`) engeli
- Tehlikeli keyword'ler regex word-boundary (`\b`) ile tespit: INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, GRANT, REVOKE, EXECUTE, EXEC

### InfluxQL Injection Koruması
Üç sanitizasyon fonksiyonu (`tool-handlers.js`):
- `sanitizeInflux(input)` — where_clause gibi serbest metin alanlarında `;`, `DROP`, `DELETE`, `CREATE`, `ALTER`, `GRANT`, `INTO` engeller
- `sanitizeInfluxIdentifier(name)` — measurement, field, tag adlarında sadece `[a-zA-Z0-9_-]` izinli
- `sanitizeInfluxTimeRange(range)` — zaman aralığında sadece `\d+[smhdw]` formatı izinli

Uygulanan handler'lar: `rpFrom()`, `influx_stats`, `influx_query`, `influx_show_tag_values`, `chart_line`, `chart_bar`, `chart_gauge`, `chart_multi`, `chart_forecast`

### SCADA Yazma Onay Mekanizması
Tehlikeli tool'lar (`inscada_set_value`, `inscada_run_script`) sunucu tarafında engellenir:
```
Claude tool çağrısı → DANGEROUS_TOOLS kontrolü → hemen çalıştırılmaz
  → pendingActions Map'e kaydedilir (actionId → {tool, input})
  → Frontend'e pending_confirmation objesi döner
  → Kullanıcı onay kutusunda Onayla/İptal seçer
  → POST /api/confirm-action → onaylanırsa executeTool çalışır
```
- `DANGEROUS_TOOLS`: `Set(["inscada_set_value", "inscada_run_script"])`
- `pendingActions`: `Map<actionId, {tool, input}>` — in-memory, sunucu restart ile sıfırlanır
- Endpoint: `POST /api/confirm-action` — `{actionId, approved}` body ile çağrılır
- Frontend: `.confirm-action` kutusu (sarı uyarı rengi), Onayla (yeşil) / İptal (kırmızı) butonları

### XSS Koruması
- **DOMPurify** (CDN: `purify.min.js` v3.0.9) — `marked.parse()` çıktısı `DOMPurify.sanitize()` ile temizlenir
- Tool adları `escapeHtml()` ile escape edilir (tool göstergelerinde)

### Path Traversal Koruması (Download Endpoint)
- `path.resolve()` ile containment kontrolü — çözülen yol `downloadsDir` içinde olmalı
- Dosya adı format regex: `/^[a-zA-Z0-9_\-]+_\d+\.xlsx$/`
- URL encoding (`%2e%2e`) bypass'ı engellenir

## Common Query Patterns
- Join variable to project: `variable v JOIN project p ON v.project_id = p.project_id`
- Join variable through frame/device/connection: `variable v JOIN frame f ON v.frame_id=f.frame_id JOIN device d ON f.device_id=d.device_id JOIN connection c ON d.conn_id=c.conn_id`
- Filter by space: `WHERE space_id = ?` (nearly all tables have space_id)
- Get protocol details: `JOIN modbus_variable mv ON v.variable_id=mv.variable_id` (use matching protocol)
