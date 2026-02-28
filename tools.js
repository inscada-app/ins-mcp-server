/**
 * inSCADA Tool Definitions
 * Claude API tool_use formatında tool tanımları
 */

const TOOLS = [
  // ==================== PostgreSQL Tools ====================
  {
    name: "list_spaces",
    description: "inSCADA space'leri listeler. Hiyerarşinin en üst seviyesi.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Space adında arama yapar (opsiyonel)" },
      },
    },
  },
  {
    name: "list_projects",
    description: "Bir space altındaki projeleri listeler.",
    input_schema: {
      type: "object",
      properties: {
        space_id: { type: "number", description: "Space ID" },
        space_name: { type: "string", description: "Space adı (kısmi eşleşme)" },
        search: { type: "string", description: "Proje adında arama (opsiyonel)" },
      },
    },
  },
  {
    name: "list_scripts",
    description: "Bir proje altındaki scriptleri listeler. Kod içeriği gösterilmez.",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "number", description: "Project ID" },
        project_name: { type: "string", description: "Proje adı (kısmi eşleşme)" },
        space_name: { type: "string", description: "Space adı ile filtreleme" },
        search: { type: "string", description: "Script adında arama" },
      },
    },
  },
  {
    name: "get_script",
    description: "Bir scriptin tam kodunu ve detaylarını getirir.",
    input_schema: {
      type: "object",
      properties: {
        script_id: { type: "number", description: "Script ID" },
        script_name: { type: "string", description: "Script adı (kısmi eşleşme)" },
        project_name: { type: "string", description: "Proje adıyla daraltma" },
      },
    },
  },
  {
    name: "update_script",
    description: "Bir scriptin kodunu günceller. Otomatik yedek alınır. Önce get_script ile oku.",
    input_schema: {
      type: "object",
      properties: {
        script_id: { type: "number", description: "Script ID (zorunlu)" },
        code: { type: "string", description: "Yeni script kodu (tam kod)" },
        version_user: { type: "string", description: "Güncelleyen kullanıcı (varsayılan: claude)" },
      },
      required: ["script_id", "code"],
    },
  },
  {
    name: "get_script_history",
    description: "Scriptin yedekleme geçmişini gösterir.",
    input_schema: {
      type: "object",
      properties: {
        script_id: { type: "number", description: "Script ID" },
        limit: { type: "number", description: "Kayıt limiti (varsayılan: 10)" },
      },
      required: ["script_id"],
    },
  },
  {
    name: "restore_script",
    description: "Scripti yedekten geri yükler.",
    input_schema: {
      type: "object",
      properties: {
        history_id: { type: "number", description: "History ID" },
      },
      required: ["history_id"],
    },
  },
  {
    name: "search_in_scripts",
    description: "Tüm scriptlerde kod içi metin araması yapar.",
    input_schema: {
      type: "object",
      properties: {
        search_text: { type: "string", description: "Aranacak metin" },
        space_name: { type: "string", description: "Space filtresi" },
        project_name: { type: "string", description: "Proje filtresi" },
      },
      required: ["search_text"],
    },
  },
  {
    name: "run_query",
    description: "inscada şemasında SELECT sorgusu çalıştırır. Sadece SELECT izinli.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "SELECT sorgusu" },
      },
      required: ["query"],
    },
  },

  // ==================== InfluxDB Tools ====================
  // NOT: inSCADA'da tüm SCADA değişken verileri "variable_value" measurement'ında tutulur.
  // Değişkenler "name" tag'i ile ayrılır (Örn: "name"='AN01_Active_Power').
  // Diğer tag'ler: node_id, project, project_id, space, space_id, variable_id.
  // Field: "value" (float). Retention policy convention: {measurement}_rp (Örn: variable_value_rp).
  {
    name: "influx_list_databases",
    description: "InfluxDB veritabanlarını listeler.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "influx_list_measurements",
    description: "Measurement'ları listeler. inSCADA'da ana measurement 'variable_value' olup tüm SCADA değişkenleri burada \"name\" tag'i ile ayrılır.",
    input_schema: {
      type: "object",
      properties: {
        database: { type: "string", description: "DB adı" },
        filter: { type: "string", description: "Regex filtre. Örn: /temperature/" },
      },
    },
  },
  {
    name: "influx_show_tag_keys",
    description: "Measurement'ın tag key'lerini gösterir.",
    input_schema: {
      type: "object",
      properties: {
        measurement: { type: "string", description: "Measurement adı" },
        database: { type: "string" },
      },
      required: ["measurement"],
    },
  },
  {
    name: "influx_show_tag_values",
    description: "Tag key'in mevcut değerlerini gösterir.",
    input_schema: {
      type: "object",
      properties: {
        measurement: { type: "string", description: "Measurement adı" },
        tag_key: { type: "string", description: "Tag key adı" },
        database: { type: "string" },
      },
      required: ["measurement", "tag_key"],
    },
  },
  {
    name: "influx_show_field_keys",
    description: "Measurement'ın field key'lerini gösterir.",
    input_schema: {
      type: "object",
      properties: {
        measurement: { type: "string", description: "Measurement adı" },
        database: { type: "string" },
      },
      required: ["measurement"],
    },
  },
  {
    name: "influx_show_retention_policies",
    description: "Retention policy'leri gösterir.",
    input_schema: {
      type: "object",
      properties: { database: { type: "string" } },
    },
  },
  {
    name: "influx_query",
    description: "InfluxQL sorgusu çalıştırır. Sadece SELECT/SHOW izinli. Sorgularda retention policy kullan: FROM \"measurement_rp\".\"measurement\". Örn: SELECT last(\"value\") FROM \"variable_value_rp\".\"variable_value\" WHERE \"name\"='AN01_Active_Power'",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "InfluxQL sorgusu" },
        database: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "influx_stats",
    description: "Measurement istatistikleri: count, mean, min, max, stddev, last. Retention policy otomatik uygulanır ({measurement}_rp).",
    input_schema: {
      type: "object",
      properties: {
        measurement: { type: "string", description: "Measurement adı (Örn: variable_value)" },
        field: { type: "string", description: "Field (varsayılan: value)" },
        time_range: { type: "string", description: "Örn: 1h, 24h, 7d" },
        where_clause: { type: "string", description: "Filtre. Örn: \"name\"='AN01_Active_Power'" },
        group_by: { type: "string", description: "Gruplama tag'ı" },
        database: { type: "string" },
      },
      required: ["measurement"],
    },
  },
  {
    name: "influx_explore",
    description: "Measurement keşfi: tag/field'lar, ilk/son kayıt, toplam sayı. Retention policy otomatik uygulanır ({measurement}_rp).",
    input_schema: {
      type: "object",
      properties: {
        measurement: { type: "string", description: "Measurement adı" },
        database: { type: "string" },
      },
      required: ["measurement"],
    },
  },

  // ==================== Chart Tools ====================
  {
    name: "chart_line",
    description: "Zaman serisi line chart üretir. Retention policy otomatik uygulanır ({measurement}_rp). UI otomatik gösterir.",
    input_schema: {
      type: "object",
      properties: {
        measurement: { type: "string", description: "Measurement adı (Örn: variable_value)" },
        field: { type: "string", description: "Field (varsayılan: value)" },
        time_range: { type: "string", description: "Örn: 1h, 6h, 24h, 7d" },
        where_clause: { type: "string", description: "Filtre. Örn: \"name\"='AN01_Active_Power'" },
        group_by_tag: { type: "string", description: "Tag bazlı ayrı seriler" },
        group_by_time: { type: "string", description: "Zaman gruplama. Örn: 5m, 1h" },
        title: { type: "string" },
        y_label: { type: "string", description: "Y ekseni. Örn: °C, bar, kW" },
        width: { type: "number" },
        height: { type: "number" },
        database: { type: "string" },
      },
      required: ["measurement"],
    },
  },
  {
    name: "chart_bar",
    description: "Bar chart üretir. Tag bazlı karşılaştırma için. Retention policy otomatik uygulanır ({measurement}_rp).",
    input_schema: {
      type: "object",
      properties: {
        measurement: { type: "string", description: "Measurement adı (Örn: variable_value)" },
        field: { type: "string", description: "Field (varsayılan: value)" },
        aggregation: { type: "string", description: "mean, max, min, sum, count" },
        time_range: { type: "string" },
        group_by_tag: { type: "string", description: "Gruplama tag'ı (zorunlu). Örn: name" },
        where_clause: { type: "string", description: "Filtre. Örn: \"name\"='AN01_Active_Power'" },
        title: { type: "string" },
        y_label: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
        database: { type: "string" },
      },
      required: ["measurement", "group_by_tag"],
    },
  },
  {
    name: "chart_gauge",
    description: "Anlık değer gauge göstergesi üretir. Retention policy otomatik uygulanır ({measurement}_rp).",
    input_schema: {
      type: "object",
      properties: {
        measurement: { type: "string", description: "Measurement adı (Örn: variable_value)" },
        field: { type: "string", description: "Field (varsayılan: value)" },
        where_clause: { type: "string", description: "Filtre. Örn: \"name\"='AN01_Active_Power'" },
        min: { type: "number", description: "Min değer (varsayılan: 0)" },
        max: { type: "number", description: "Max değer (varsayılan: 100)" },
        title: { type: "string" },
        unit: { type: "string", description: "Birim: °C, bar, %" },
        database: { type: "string" },
      },
      required: ["measurement"],
    },
  },
  {
    name: "chart_multi",
    description: "Birden fazla measurement/field'ı aynı grafikte çizer. Retention policy otomatik uygulanır ({measurement}_rp).",
    input_schema: {
      type: "object",
      properties: {
        series: {
          type: "array",
          description: "Seriler: [{measurement, field, where_clause, label}]",
          items: {
            type: "object",
            properties: {
              measurement: { type: "string" },
              field: { type: "string" },
              where_clause: { type: "string" },
              label: { type: "string" },
            },
            required: ["measurement"],
          },
        },
        time_range: { type: "string" },
        group_by_time: { type: "string" },
        title: { type: "string" },
        y_label: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
        database: { type: "string" },
      },
      required: ["series"],
    },
  },
];

module.exports = TOOLS;
