/**
 * inSCADA Tool Handlers
 * PostgreSQL + InfluxDB + Chart (frontend-rendered)
 */

const { Pool } = require("pg");
const http = require("http");
const https = require("https");
const { URL } = require("url");

// ============================================================
// inSCADA REST API Client
// Auth: POST /login (form-data) → ins_access_token + ins_refresh_token cookies
// Token auto-refresh: 3.5 dk (4 dk expiry'den önce)
// Her istekte X-Space header gönderilir (default_space)
// Tarih formatı (loggedValues): "yyyy-MM-dd HH:mm:ss"
// variableIds: explode format (variableIds=1&variableIds=2)
// Fired alarms: project_id varsa /monitor endpoint kullanılır
// ============================================================
const INSCADA_API_URL = process.env.INSCADA_API_URL || "http://localhost:8081";
const INSCADA_USERNAME = process.env.INSCADA_USERNAME;
const INSCADA_PASSWORD = process.env.INSCADA_PASSWORD;

class InscadaAPI {
  constructor() {
    this.accessToken = null;
    this.refreshToken = null;
    this.refreshTimer = null;
  }

  async login() {
    const parsed = new URL(INSCADA_API_URL);
    const protocol = parsed.protocol === "https:" ? https : http;
    const boundary = "----FormBoundary" + Date.now().toString(16);
    const formParts = [];
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="username"\r\n\r\n${INSCADA_USERNAME}`);
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="password"\r\n\r\n${INSCADA_PASSWORD}`);
    const body = formParts.join("\r\n") + `\r\n--${boundary}--\r\n`;

    return new Promise((resolve, reject) => {
      const req = protocol.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: "/login",
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": Buffer.byteLength(body),
        },
        rejectUnauthorized: false,
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const cookies = res.headers["set-cookie"] || [];
          for (const c of cookies) {
            const match = c.match(/^([^=]+)=([^;]*)/);
            if (match) {
              if (match[1] === "ins_access_token") this.accessToken = match[2];
              if (match[1] === "ins_refresh_token") this.refreshToken = match[2];
            }
          }
          if (!this.accessToken) {
            reject(new Error(`inSCADA login başarısız (HTTP ${res.statusCode}): ${data.substring(0, 200)}`));
            return;
          }
          // 3.5 dk'da bir token yenile
          if (this.refreshTimer) clearInterval(this.refreshTimer);
          this.refreshTimer = setInterval(() => this.login().catch(console.error), 3.5 * 60 * 1000);
          resolve();
        });
      });
      req.on("error", (err) => reject(new Error(`inSCADA login bağlantı hatası: ${err.message}`)));
      req.setTimeout(10000, () => { req.destroy(); reject(new Error("inSCADA login zaman aşımı")); });
      req.write(body);
      req.end();
    });
  }

  async request(method, pathWithQuery, body) {
    if (!this.accessToken) await this.login();
    const parsed = new URL(INSCADA_API_URL);
    const protocol = parsed.protocol === "https:" ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;

    return new Promise((resolve, reject) => {
      const headers = {
        Accept: "application/json",
        Cookie: `ins_access_token=${this.accessToken}; ins_refresh_token=${this.refreshToken}`,
        "X-Space": "default_space",
      };
      if (bodyStr) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }

      const req = protocol.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: pathWithQuery,
        method,
        headers,
        rejectUnauthorized: false,
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            this.accessToken = null;
            reject(new Error(`inSCADA API yetki hatası (${res.statusCode}). Tekrar deneyin.`));
            return;
          }
          if (res.statusCode >= 400) {
            reject(new Error(`inSCADA API hatası (${res.statusCode}): ${data.substring(0, 500)}`));
            return;
          }
          try {
            resolve(data ? JSON.parse(data) : { success: true, statusCode: res.statusCode });
          } catch {
            resolve({ raw: data, statusCode: res.statusCode });
          }
        });
      });
      req.on("error", (err) => reject(new Error(`inSCADA API bağlantı hatası: ${err.message}`)));
      req.setTimeout(30000, () => { req.destroy(); reject(new Error("inSCADA API zaman aşımı")); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }
}

const inscadaApi = new InscadaAPI();

// ============================================================
// PostgreSQL
// ============================================================
const pool = new Pool({
  host: process.env.INSCADA_DB_HOST || "localhost",
  port: parseInt(process.env.INSCADA_DB_PORT || "5432"),
  database: process.env.INSCADA_DB_NAME || "inscada",
  user: process.env.INSCADA_DB_USER || "inscada",
  password: process.env.INSCADA_DB_PASSWORD || "",
  options: `-c search_path=inscada,public`,
});

// ============================================================
// InfluxDB
// ============================================================
const INFLUX_HOST = process.env.INFLUX_HOST || "localhost";
const INFLUX_PORT = parseInt(process.env.INFLUX_PORT || "8086");
const INFLUX_DB = process.env.INFLUX_DB || "inscada";
const INFLUX_USER = process.env.INFLUX_USER || "";
const INFLUX_PASSWORD = process.env.INFLUX_PASSWORD || "";
const INFLUX_USE_SSL = process.env.INFLUX_USE_SSL === "true";

// Retention policy convention: {measurement}_rp
function rpFrom(measurement) {
  return `"${measurement}_rp"."${measurement}"`;
}

function influxQuery(query, db = INFLUX_DB) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams();
    params.append("q", query);
    if (db) params.append("db", db);
    if (INFLUX_USER) params.append("u", INFLUX_USER);
    if (INFLUX_PASSWORD) params.append("p", INFLUX_PASSWORD);
    params.append("epoch", "ms");

    const protocol = INFLUX_USE_SSL ? https : http;
    const url = `${INFLUX_USE_SSL ? "https" : "http"}://${INFLUX_HOST}:${INFLUX_PORT}/query?${params.toString()}`;
    const parsedUrl = new URL(url);

    const req = protocol.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: "GET",
      headers: { Accept: "application/json" },
      rejectUnauthorized: false,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          json.error ? reject(new Error(json.error)) : resolve(json);
        } catch (e) { reject(new Error(`Parse hatası: ${data.substring(0, 500)}`)); }
      });
    });
    req.on("error", (err) => reject(new Error(`Bağlantı hatası: ${err.message}`)));
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Zaman aşımı")); });
    req.end();
  });
}

function formatInfluxResult(response) {
  if (!response.results || !response.results.length) return [];
  const results = [];
  for (const result of response.results) {
    if (result.error) { results.push({ error: result.error }); continue; }
    if (!result.series) { results.push({ data: [], message: "Veri bulunamadı" }); continue; }
    for (const series of result.series) {
      const rows = (series.values || []).map((row) => {
        const obj = {};
        series.columns.forEach((col, i) => {
          obj[col] = col === "time" ? new Date(row[i]).toISOString() : row[i];
        });
        return obj;
      });
      results.push({ measurement: series.name, tags: series.tags || {}, columns: series.columns, row_count: rows.length, data: rows });
    }
  }
  return results;
}

// ============================================================
// Handlers
// ============================================================
const handlers = {
  // --- PostgreSQL ---
  async list_spaces({ search }) {
    let q = `SELECT space_id, name, insert_user, insert_dttm FROM inscada.space`;
    const p = [];
    if (search) { q += ` WHERE LOWER(name) LIKE LOWER($1)`; p.push(`%${search}%`); }
    return (await pool.query(q + ` ORDER BY name`, p)).rows;
  },

  async list_projects({ space_id, space_name, search }) {
    let q = `SELECT p.project_id, p.name, p.dsc, p.active_flag, s.name as space_name FROM inscada.project p JOIN inscada.space s ON s.space_id = p.space_id WHERE 1=1`;
    const p = []; let i = 1;
    if (space_id) { q += ` AND p.space_id = $${i++}`; p.push(space_id); }
    if (space_name) { q += ` AND LOWER(s.name) LIKE LOWER($${i++})`; p.push(`%${space_name}%`); }
    if (search) { q += ` AND LOWER(p.name) LIKE LOWER($${i++})`; p.push(`%${search}%`); }
    return (await pool.query(q + ` ORDER BY s.name, p.name`, p)).rows;
  },

  async list_scripts({ project_id, project_name, space_name, search }) {
    let q = `SELECT sc.script_id, sc.name, sc.dsc, sc.sch_type, p.name as project_name, s.name as space_name, sc.version_dttm, LENGTH(sc.code) as code_length FROM inscada.script sc JOIN inscada.project p ON p.project_id = sc.project_id JOIN inscada.space s ON s.space_id = sc.space_id WHERE 1=1`;
    const p = []; let i = 1;
    if (project_id) { q += ` AND sc.project_id = $${i++}`; p.push(project_id); }
    if (project_name) { q += ` AND LOWER(p.name) LIKE LOWER($${i++})`; p.push(`%${project_name}%`); }
    if (space_name) { q += ` AND LOWER(s.name) LIKE LOWER($${i++})`; p.push(`%${space_name}%`); }
    if (search) { q += ` AND LOWER(sc.name) LIKE LOWER($${i++})`; p.push(`%${search}%`); }
    return (await pool.query(q + ` ORDER BY s.name, p.name, sc.name`, p)).rows;
  },

  async get_script({ script_id, script_name, project_name }) {
    let q = `SELECT sc.*, p.name as project_name, s.name as space_name FROM inscada.script sc JOIN inscada.project p ON p.project_id = sc.project_id JOIN inscada.space s ON s.space_id = sc.space_id WHERE 1=1`;
    const p = []; let i = 1;
    if (script_id) { q += ` AND sc.script_id = $${i++}`; p.push(script_id); }
    if (script_name) { q += ` AND LOWER(sc.name) LIKE LOWER($${i++})`; p.push(`%${script_name}%`); }
    if (project_name) { q += ` AND LOWER(p.name) LIKE LOWER($${i++})`; p.push(`%${project_name}%`); }
    const result = await pool.query(q, p);
    if (result.rows.length === 0) return { error: "Script bulunamadı." };
    if (result.rows.length > 1) return { warning: `${result.rows.length} script bulundu:`, scripts: result.rows.map(r => ({ script_id: r.script_id, name: r.name, project: r.project_name, space: r.space_name })) };
    return result.rows[0];
  },

  async update_script({ script_id, code, version_user = "claude" }) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query(`SELECT script_id, name, code FROM inscada.script WHERE script_id = $1`, [script_id]);
      if (!cur.rows.length) { await client.query("ROLLBACK"); return { error: "Script bulunamadı." }; }
      const old = cur.rows[0];
      await client.query(`INSERT INTO inscada.script_history (script_id, name, code, changed_by, changed_at, change_reason) VALUES ($1,$2,$3,$4,NOW(),$5)`, [script_id, old.name, old.code, version_user, `Update by ${version_user}`]);
      await client.query(`UPDATE inscada.script SET code=$1, version_user=$2, version_dttm=NOW() WHERE script_id=$3`, [code, version_user, script_id]);
      await client.query("COMMIT");
      return { success: true, script_id, name: old.name, message: `"${old.name}" güncellendi ve yedeklendi.` };
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  },

  async get_script_history({ script_id, limit = 10 }) {
    return (await pool.query(`SELECT history_id, script_id, name, changed_by, changed_at, change_reason, LENGTH(code) as code_length FROM inscada.script_history WHERE script_id=$1 ORDER BY changed_at DESC LIMIT $2`, [script_id, limit])).rows;
  },

  async restore_script({ history_id }) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const h = await client.query(`SELECT * FROM inscada.script_history WHERE history_id=$1`, [history_id]);
      if (!h.rows.length) { await client.query("ROLLBACK"); return { error: "History bulunamadı." }; }
      const rec = h.rows[0];
      const cur = await client.query(`SELECT code FROM inscada.script WHERE script_id=$1`, [rec.script_id]);
      await client.query(`INSERT INTO inscada.script_history (script_id,name,code,changed_by,changed_at,change_reason) VALUES ($1,$2,$3,'claude',NOW(),$4)`, [rec.script_id, rec.name, cur.rows[0].code, `Before restore from ${history_id}`]);
      await client.query(`UPDATE inscada.script SET code=$1, version_user='claude', version_dttm=NOW() WHERE script_id=$2`, [rec.code, rec.script_id]);
      await client.query("COMMIT");
      return { success: true, message: `"${rec.name}" geri yüklendi.` };
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  },

  async search_in_scripts({ search_text, space_name, project_name }) {
    let q = `SELECT sc.script_id, sc.name, p.name as project_name, s.name as space_name, SUBSTRING(sc.code FROM GREATEST(1, POSITION(LOWER($1) IN LOWER(sc.code))-100) FOR 250) as snippet FROM inscada.script sc JOIN inscada.project p ON p.project_id=sc.project_id JOIN inscada.space s ON s.space_id=sc.space_id WHERE LOWER(sc.code) LIKE LOWER($1)`;
    const p = [`%${search_text}%`]; let i = 2;
    if (space_name) { q += ` AND LOWER(s.name) LIKE LOWER($${i++})`; p.push(`%${space_name}%`); }
    if (project_name) { q += ` AND LOWER(p.name) LIKE LOWER($${i++})`; p.push(`%${project_name}%`); }
    const result = await pool.query(q + ` LIMIT 50`, p);
    return { count: result.rows.length, results: result.rows };
  },

  async run_query({ query }) {
    const t = query.trim().toUpperCase();
    if (!t.startsWith("SELECT") && !t.startsWith("WITH")) return { error: "Sadece SELECT izinli." };
    for (const kw of ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "CREATE"]) {
      if (t.includes(kw + " ")) return { error: `'${kw}' kullanılamaz.` };
    }
    const r = await pool.query(query);
    return { rowCount: r.rowCount, rows: r.rows };
  },

  // --- InfluxDB ---
  async influx_list_databases() { return formatInfluxResult(await influxQuery("SHOW DATABASES", "")); },

  async influx_list_measurements({ database, filter }) {
    let q = "SHOW MEASUREMENTS";
    if (filter) q += ` WITH MEASUREMENT =~ ${filter}`;
    return formatInfluxResult(await influxQuery(q, database || INFLUX_DB));
  },

  async influx_show_tag_keys({ measurement, database }) {
    return formatInfluxResult(await influxQuery(`SHOW TAG KEYS FROM ${rpFrom(measurement)}`, database || INFLUX_DB));
  },

  async influx_show_tag_values({ measurement, tag_key, database }) {
    return formatInfluxResult(await influxQuery(`SHOW TAG VALUES FROM ${rpFrom(measurement)} WITH KEY = "${tag_key}"`, database || INFLUX_DB));
  },

  async influx_show_field_keys({ measurement, database }) {
    return formatInfluxResult(await influxQuery(`SHOW FIELD KEYS FROM ${rpFrom(measurement)}`, database || INFLUX_DB));
  },

  async influx_show_retention_policies({ database }) {
    const db = database || INFLUX_DB;
    return formatInfluxResult(await influxQuery(`SHOW RETENTION POLICIES ON "${db}"`, db));
  },

  async influx_query({ query, database }) {
    const t = query.trim().toUpperCase();
    if (!t.startsWith("SELECT") && !t.startsWith("SHOW")) return { error: "Sadece SELECT/SHOW izinli." };
    for (const kw of ["INSERT", "DELETE", "DROP", "ALTER", "CREATE", "INTO"]) {
      if (t.includes(kw + " ")) return { error: `'${kw}' kullanılamaz.` };
    }
    return formatInfluxResult(await influxQuery(query, database || INFLUX_DB));
  },

  async influx_stats({ measurement, field = "value", time_range = "24h", where_clause, group_by, database }) {
    const db = database || INFLUX_DB;
    let q = `SELECT count("${field}") as count, mean("${field}") as mean, min("${field}") as min, max("${field}") as max, stddev("${field}") as stddev, last("${field}") as last_value FROM ${rpFrom(measurement)} WHERE time > now() - ${time_range}`;
    if (where_clause) q += ` AND ${where_clause}`;
    if (group_by) q += ` GROUP BY "${group_by}"`;
    return { measurement, field, time_range, statistics: formatInfluxResult(await influxQuery(q, db)) };
  },

  async influx_explore({ measurement, database }) {
    const db = database || INFLUX_DB;
    const info = { measurement };
    const tagKeys = formatInfluxResult(await influxQuery(`SHOW TAG KEYS FROM ${rpFrom(measurement)}`, db));
    info.tag_keys = tagKeys;
    info.field_keys = formatInfluxResult(await influxQuery(`SHOW FIELD KEYS FROM ${rpFrom(measurement)}`, db));
    if (tagKeys.length > 0 && tagKeys[0].data) {
      info.tag_values = {};
      for (const row of tagKeys[0].data) {
        if (row.tagKey) {
          const v = formatInfluxResult(await influxQuery(`SHOW TAG VALUES FROM ${rpFrom(measurement)} WITH KEY = "${row.tagKey}"`, db));
          if (v.length > 0 && v[0].data) info.tag_values[row.tagKey] = v[0].data.map(x => x.value).slice(0, 50);
        }
      }
    }
    info.first_record = formatInfluxResult(await influxQuery(`SELECT * FROM ${rpFrom(measurement)} LIMIT 1`, db));
    info.last_record = formatInfluxResult(await influxQuery(`SELECT * FROM ${rpFrom(measurement)} ORDER BY time DESC LIMIT 1`, db));
    info.total_count = formatInfluxResult(await influxQuery(`SELECT count(*) FROM ${rpFrom(measurement)}`, db));
    return info;
  },

  // --- Charts (veri döner, frontend çizer) ---
  async chart_line({ measurement, field = "value", time_range = "24h", where_clause, group_by_tag, group_by_time, title, y_label, database }) {
    const db = database || INFLUX_DB;
    let sel = group_by_time ? `mean("${field}") as "${field}"` : `"${field}"`;
    let q = `SELECT ${sel} FROM ${rpFrom(measurement)} WHERE time > now() - ${time_range}`;
    if (where_clause) q += ` AND ${where_clause}`;
    const gp = [];
    if (group_by_time) gp.push(`time(${group_by_time})`);
    if (group_by_tag) gp.push(`"${group_by_tag}"`);
    if (gp.length) q += ` GROUP BY ${gp.join(",")}`;
    if (group_by_time) q += ` fill(none)`;

    const influxResults = formatInfluxResult(await influxQuery(q, db));
    if (!influxResults.length || influxResults.every(r => !r.data || !r.data.length)) {
      return { error: "Veri bulunamadı.", query: q };
    }

    // Frontend'in çizeceği chart data
    return {
      __chart: true,
      chart_type: "line",
      title: title || `${measurement} - ${field} (${time_range})`,
      y_label: y_label || field,
      series: influxResults.filter(r => r.data && r.data.length).map(r => ({
        label: r.tags && Object.keys(r.tags).length ? Object.values(r.tags).join(" / ") : measurement,
        data: r.data.map(d => ({ x: d.time, y: d[field] })).filter(d => d.y !== null),
      })),
      query: q,
    };
  },

  async chart_bar({ measurement, field = "value", aggregation = "mean", time_range = "24h", group_by_tag, where_clause, title, y_label, database }) {
    const db = database || INFLUX_DB;
    let q = `SELECT ${aggregation}("${field}") as "${field}" FROM ${rpFrom(measurement)} WHERE time > now() - ${time_range}`;
    if (where_clause) q += ` AND ${where_clause}`;
    q += ` GROUP BY "${group_by_tag}"`;

    const res = formatInfluxResult(await influxQuery(q, db));
    const labels = [], values = [];
    for (const s of res) {
      if (s.tags && s.data && s.data.length) { labels.push(Object.values(s.tags).join("/")); values.push(s.data[0][field] || 0); }
    }
    if (!labels.length) return { error: "Veri bulunamadı.", query: q };

    return {
      __chart: true,
      chart_type: "bar",
      title: title || `${measurement} - ${aggregation}(${field}) by ${group_by_tag}`,
      y_label: y_label || `${aggregation}(${field})`,
      labels,
      values,
      query: q,
    };
  },

  async chart_gauge({ measurement, field = "value", where_clause, min = 0, max = 100, title, unit = "", database }) {
    const db = database || INFLUX_DB;
    let q = `SELECT last("${field}") as "${field}" FROM ${rpFrom(measurement)}`;
    if (where_clause) q += ` WHERE ${where_clause}`;
    const res = formatInfluxResult(await influxQuery(q, db));
    let val = null;
    for (const s of res) { if (s.data && s.data.length) { val = s.data[0][field]; break; } }
    if (val === null) return { error: "Veri bulunamadı.", query: q };

    return {
      __chart: true,
      chart_type: "gauge",
      title: title || `${measurement} - ${field}`,
      value: parseFloat(val),
      min, max, unit,
      query: q,
    };
  },

  // --- inSCADA REST API ---
  async inscada_get_live_value({ project_id, variable_name }) {
    return inscadaApi.request("GET", `/api/variables/value?projectId=${project_id}&name=${encodeURIComponent(variable_name)}`);
  },

  async inscada_get_live_values({ project_id, variable_names }) {
    const names = Array.isArray(variable_names) ? variable_names.join(",") : variable_names;
    return inscadaApi.request("GET", `/api/variables/values?projectId=${project_id}&names=${encodeURIComponent(names)}`);
  },

  async inscada_set_value({ project_id, variable_name, value }) {
    return inscadaApi.request("POST", `/api/variables/value?projectId=${project_id}&name=${encodeURIComponent(variable_name)}`, { value });
  },

  async inscada_get_fired_alarms({ project_id, count = 100 }) {
    if (project_id) {
      return inscadaApi.request("GET", `/api/alarms/fired-alarms/monitor?projectId=${project_id}&count=${count}`);
    }
    return inscadaApi.request("GET", `/api/alarms/fired-alarms?pageSize=${count}&paged=true`);
  },

  async inscada_connection_status({ connection_ids }) {
    const ids = Array.isArray(connection_ids) ? connection_ids.join(",") : connection_ids;
    return inscadaApi.request("GET", `/api/connections/status?connectionIds=${encodeURIComponent(ids)}`);
  },

  async inscada_project_status({ project_id }) {
    return inscadaApi.request("GET", `/api/projects/${project_id}/status`);
  },

  async inscada_run_script({ script_id }) {
    return inscadaApi.request("POST", `/api/scripts/${script_id}/run`);
  },

  async inscada_script_status({ script_id }) {
    return inscadaApi.request("GET", `/api/scripts/${script_id}/status`);
  },

  async inscada_logged_values({ variable_ids, start_date, end_date }) {
    const ids = Array.isArray(variable_ids) ? variable_ids : String(variable_ids).split(",").map(s => s.trim());
    const idParams = ids.map(id => `variableIds=${id}`).join("&");
    // inSCADA expects "yyyy-MM-dd HH:mm:ss" format
    const fmtDate = (d) => d.replace("T", " ").replace(/\.\d+/, "").replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
    let path = `/api/variables/loggedValues?${idParams}`;
    if (start_date) path += `&startDate=${encodeURIComponent(fmtDate(start_date))}`;
    if (end_date) path += `&endDate=${encodeURIComponent(fmtDate(end_date))}`;
    return inscadaApi.request("GET", path);
  },

  // --- Charts (veri döner, frontend çizer) ---
  async chart_multi({ series, time_range = "24h", group_by_time, title, y_label, database }) {
    const db = database || INFLUX_DB;
    const allSeries = [];

    for (const s of series) {
      const f = s.field || "value";
      let sel = group_by_time ? `mean("${f}") as "${f}"` : `"${f}"`;
      let q = `SELECT ${sel} FROM ${rpFrom(s.measurement)} WHERE time > now() - ${time_range}`;
      if (s.where_clause) q += ` AND ${s.where_clause}`;
      if (group_by_time) q += ` GROUP BY time(${group_by_time}) fill(none)`;

      for (const r of formatInfluxResult(await influxQuery(q, db))) {
        if (r.data && r.data.length) {
          allSeries.push({
            label: s.label || `${s.measurement}.${f}`,
            data: r.data.map(d => ({ x: d.time, y: d[f] })).filter(d => d.y !== null),
          });
        }
      }
    }

    if (!allSeries.length) return { error: "Veri bulunamadı." };

    return {
      __chart: true,
      chart_type: "line",
      title: title || `Multi Chart (${time_range})`,
      y_label: y_label || "Değer",
      series: allSeries,
    };
  },
};

async function executeTool(name, args) {
  const handler = handlers[name];
  if (!handler) throw new Error(`Bilinmeyen tool: ${name}`);
  return await handler(args || {});
}

module.exports = { executeTool };
