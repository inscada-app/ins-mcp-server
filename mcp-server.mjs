/**
 * inSCADA MCP Server
 * Mevcut tool'ları (PostgreSQL, InfluxDB, Chart) MCP protokolü üzerinden dışarıya açar.
 * Claude Desktop, VS Code Copilot ve diğer MCP client'lar bağlanabilir.
 *
 * Kullanım: node mcp-server.mjs
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
const TOOLS = require("./tools.js");
const { executeTool } = require("./tool-handlers.js");

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
  }
);

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

  try {
    const result = await executeTool(name, args);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
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

// Sunucuyu başlat
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("inSCADA MCP Server başlatıldı (stdio)");
  console.error(`${TOOLS.length} tool kayıtlı`);
}

main().catch((error) => {
  console.error("MCP Server başlatılamadı:", error);
  process.exit(1);
});
