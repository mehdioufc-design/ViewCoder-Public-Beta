import readline from "node:readline";

const tools = [
  {
    name: "get_addon_status",
    description: "Verify the test Blender add-on protocol handshake.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_scene_info",
    description: "Read-only test scene probe.",
    inputSchema: {
      type: "object",
      properties: { user_prompt: { type: "string" } },
      required: ["user_prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "execute_blender_code",
    description: "Deterministic test execution tool.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", minLength: 1 } },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "list_materials",
    description: "Dynamic read-only Blender tool used by the bridge catalog test.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "set_render_engine",
    description: "Dynamic Blender mutation tool used by the bridge catalog test.",
    inputSchema: {
      type: "object",
      properties: { engine: { type: "string" } },
      required: ["engine"],
      additionalProperties: false,
    },
  },
  {
    name: "get_console_output",
    description: "A Blender tool whose name must not inherit Studio-only filtering.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "screen_capture",
    description: "Screenshot tool that ViewCoder must exclude.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "capture_viewport_screenshot",
    description: "Viewport screenshot tool that ViewCoder must exclude.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
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
      serverInfo: { name: "viewcoder-test-blender", version: "1.0.0" },
    });
  }
  if (message.method === "tools/list") {
    return reply(message.id, { tools });
  }
  if (message.method === "tools/call") {
    const name = String(message.params?.name || "");
    if (name === "get_addon_status") {
      return reply(message.id, {
        content: [{ type: "text", text: JSON.stringify({
          up_to_date: true,
          protocol_version: 4,
          expected_protocol_version: 4,
          addon_version: [1, 5],
          capabilities: ["execute_code", "get_addon_info"],
          blender_version: "5.2.0 Test",
          source: "native",
          warning: null,
        }) }],
      });
    }
    if (name === "get_scene_info") {
      return reply(message.id, {
        content: [{ type: "text", text: JSON.stringify({ objects: [], test: true }) }],
      });
    }
    if (name === "execute_blender_code") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (String(message.params?.arguments?.code || "").includes("VIEWCODER_RIG_IMPORTED")) {
        return reply(message.id, {
          content: [{ type: "text", text: "VIEWCODER_RIG_IMPORTED:ViewCoder_Animation_Rig:R15:Official:Blocky Character:15:51:1:bundled:BlockyCharacter.fbx" }],
        });
      }
      return reply(message.id, {
        content: [{ type: "text", text: JSON.stringify({ ok: true, value: 42 }) }],
      });
    }
    if (["list_materials", "set_render_engine", "get_console_output"].includes(name)) {
      return reply(message.id, {
        content: [{ type: "text", text: JSON.stringify({ ok: true, tool: name }) }],
      });
    }
    return failure(message.id, -32601, `Unknown test tool: ${name}`);
  }
  return failure(message.id, -32601, `Unknown test method: ${message.method}`);
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function failure(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
