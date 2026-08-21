import readline from "node:readline";

const STUDIO_ID = "studio-test-1";
const tools = [
  {
    name: "list_roblox_studios",
    description: "List deterministic test Studio connections.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "execute_luau",
    description: "Execute deterministic test Luau.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", minLength: 1 },
        datamodel_type: {
          type: "string",
          enum: ["Edit", "Client", "Server"],
        },
        studio_id: { type: "string", minLength: 1 },
      },
      required: ["code", "datamodel_type", "studio_id"],
      additionalProperties: false,
    },
  },
  {
    name: "search_game_tree",
    description: "Search an empty deterministic test tree.",
    inputSchema: {
      type: "object",
      properties: {
        keywords: { type: "string" },
        max_depth: { type: "number" },
        head_limit: { type: "number" },
        studio_id: { type: "string", minLength: 1 },
      },
      required: ["keywords", "studio_id"],
      additionalProperties: false,
    },
  },
];

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id == null) return;

  if (message.method === "initialize") {
    return reply(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: {
        name: "viewcoder-test-studio",
        version: "1.0.0",
      },
    });
  }
  if (message.method === "tools/list") {
    return reply(message.id, { tools });
  }
  if (message.method === "tools/call") {
    const name = String(message.params?.name || "");
    const args = message.params?.arguments || {};
    if (name === "list_roblox_studios") {
      return toolReply(message.id, {
        studios: [{ id: STUDIO_ID, name: "TestPlace", active: true }],
      });
    }
    if (name === "execute_luau") {
      if (args.studio_id !== STUDIO_ID) {
        return failure(
          message.id,
          -32602,
          "execute_luau: arguments.studio_id is required and must identify the connected Studio.",
        );
      }
      return toolReply(message.id, {
        ok: true,
        executed: true,
        studioId: args.studio_id,
        code: args.code,
      });
    }
    if (name === "search_game_tree") {
      if (args.studio_id !== STUDIO_ID) {
        return failure(
          message.id,
          -32602,
          "search_game_tree: arguments.studio_id is required and must identify the connected Studio.",
        );
      }
      return toolReply(message.id, []);
    }
    return failure(message.id, -32601, `Unknown test tool: ${name}`);
  }
  return failure(
    message.id,
    -32601,
    `Unknown test method: ${message.method}`,
  );
});

function toolReply(id, value) {
  reply(id, {
    content: [{ type: "text", text: JSON.stringify(value) }],
  });
}

function reply(id, result) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`,
  );
}

function failure(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    })}\n`,
  );
}

