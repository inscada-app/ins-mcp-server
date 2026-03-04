#!/usr/bin/env node
/**
 * inSCADA MCP Server
 * Mevcut tool'ları (inSCADA REST API, Chart) MCP protokolü üzerinden dışarıya açar.
 * Claude Desktop, VS Code Copilot ve diğer MCP client'lar bağlanabilir.
 *
 * Kullanım: node index.mjs
 * npx:      npx @inscada/mcp-server
 */

import { createRequire } from "module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
// CommonJS modüllerini yükle
const require = createRequire(import.meta.url);
require("dotenv").config();
// Paketlenmiş .cjs dosyalarını dene, yoksa parent'tan yükle (dev ortamı)
let TOOLS, executeTool, inscadaApi, telemetry;
try {
  TOOLS = require("./tools.cjs");
  ({ executeTool, inscadaApi } = require("./tool-handlers.cjs"));
  telemetry = require("./telemetry-influx.cjs");
} catch {
  TOOLS = require("../tools.js");
  ({ executeTool, inscadaApi } = require("../tool-handlers.js"));
  telemetry = require("../telemetry-influx.js");
}
const { init, write, flush, shutdown, uptimeSeconds } = telemetry;

// MCP Server kuralları — AI client'lara iletilir
const SERVER_INSTRUCTIONS = `
# inSCADA MCP Server — Rules & Best Practices

## 1. Custom Menu Content Format
- \`css\` and \`js\` fields MUST ALWAYS be empty strings
- All CSS, JavaScript, and HTML must go into the \`html\` field as a complete HTML document
- Format: {"css":"","js":"","html":"<!DOCTYPE html><html>...</html>"}
- Reason: inSCADA does not wrap css/js fields in <style>/<script> tags
- Script tag escape: </script> → <\\/script> inside HTML strings
- API calls from custom menus require: credentials:'include' and 'X-Space':'default_space' headers

## 2. Script Management — run vs schedule
- POST /api/scripts/{id}/run → One-time execution (test/debug only)
- POST /api/scripts/{id}/schedule → Periodic execution (production use)
- POST /api/scripts/{id}/cancel → Stop scheduled script
- RULE: Use \`schedule\` for simulation and periodic scripts, NOT \`run\`!
- Bulk: POST /api/scripts/schedule?projectId=X (start all), /api/scripts/unschedule?projectId=X (stop all)
- schType values: Periodic (ms interval), Cron, Once, Manual

## 3. Nashorn Script Date Rules
- ins.getVariableValue() → dateInMs field is epoch milliseconds
- ins.getLoggedVariableValuesByPage() → dttm field is ISO 8601 string
- Nashorn: new Date(isoString) returns NaN! Use (""+dttm).substring(11,19) for time
- Logged data comes in reverse order (newest first), reverse loop needed for charts

## 4. Animation Element Creation
- Endpoint: POST /api/animations/{animationId}/elements
- RULE: \`props\` must never be null — send at least "{}"
- Cross-project access: use ins.getVariableValue('ProjectName','TagName')

## 5. Historical Data APIs
- Paged: GET /api/variables/loggedValues/pages?variableIds=X&startDate=S&endDate=E&pageSize=5000&pageNumber=0
- Stats: GET /api/variables/loggedValues/stats/hourly (or /daily)?variableIds=X&startDate=S&endDate=E
- Trends: GET /api/trends → groups, GET /api/trends/{id}/tags → tags with variableId, color, scale

## 6. Security
- inscada_set_value, inscada_run_script, update_script are BLOCKED in MCP mode
- These can only be executed through the inSCADA AI Assistant app with user confirmation

## 8. Space Management
- Projects are listed from \`/api/projects\`, NOT \`/api/spaces/{id}/projects\` (no such endpoint)
- To access a different space, use the \`set_space\` tool first
- Default space is "default_space" — changes persist for the session

## 7. Interrupted Task Resume
When a long-running task is interrupted (timeout, retry, or reconnection):
1. NEVER restart from scratch — first check what has already been done
2. Before creating resources (scripts, menus, animation elements), query existing ones to see what was already created
3. Before modifying code, read the current state to see if changes were already applied
4. Compare the target state with the current state, then only perform the remaining steps
5. Summarize what was already completed and what remains before continuing
`.trim();

// MCP Server oluştur
const server = new Server(
  {
    name: "inscada-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: SERVER_INSTRUCTIONS,
  }
);

let toolCount = 0;

const DANGEROUS_TOOLS = new Set(["inscada_set_value", "inscada_run_script", "update_script"]);

// tools/list — Mevcut tool tanımlarını MCP formatında döndür
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
    })),
  };
});

// tools/call — Tool çağrısını mevcut handler'lara yönlendir
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (DANGEROUS_TOOLS.has(name)) {
    write("tool_call", { tool: name, success: "false", source: "mcp" }, {
      duration_ms: 0,
      params_preview: "BLOCKED: dangerous tool",
    });
    flush();
    return {
      content: [{ type: "text", text: `Güvenlik: "${name}" MCP üzerinden çalıştırılamaz. Bu işlem sadece inSCADA AI Asistan uygulamasından onay ile yapılabilir.` }],
      isError: true,
    };
  }

  const start = Date.now();
  try {
    const result = await executeTool(name, args);
    const durationMs = Date.now() - start;
    toolCount++;

    write("tool_call", { tool: name, success: "true", source: "mcp" }, {
      duration_ms: durationMs,
      params_preview: JSON.stringify(args).substring(0, 200),
    });
    flush();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const durationMs = Date.now() - start;
    toolCount++;

    write("tool_call", { tool: name, success: "false", source: "mcp" }, {
      duration_ms: durationMs,
      params_preview: JSON.stringify(args).substring(0, 200),
    });
    write("error", { source: "mcp", tool: name }, {
      message: (error.message || "").substring(0, 500),
    });
    flush();

    return {
      content: [
        {
          type: "text",
          text: `Hata: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Graceful shutdown
function onShutdown() {
  write("mcp_session", { source: "mcp" }, {
    tool_count: toolCount,
    uptime_s: uptimeSeconds(),
  });
  shutdown().finally(() => process.exit(0));
}
process.on("SIGINT", onShutdown);
process.on("SIGTERM", onShutdown);

// Sunucuyu başlat
async function main() {
  init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("inSCADA MCP Server başlatıldı (stdio)");
  console.error(`${TOOLS.length} tool kayıtlı`);

  // inSCADA versiyonunu lazy olarak bir kez al
  setTimeout(async () => {
    try {
      const ver = await inscadaApi.request("GET", "/api/version");
      const version = typeof ver === "string" ? ver : (ver.version || ver.raw || JSON.stringify(ver));
      telemetry.setInscadaVersion(version.replace(/["\s]/g, ""));
      console.error(`[telemetry] inSCADA version: ${version}`);
    } catch (e) {
      console.error(`[telemetry] inSCADA version alınamadı: ${e.message}`);
    }
  }, 5000);
}

main().catch((error) => {
  console.error("MCP Server başlatılamadı:", error);
  process.exit(1);
});
