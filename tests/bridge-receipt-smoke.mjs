import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { chmod, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 32_000 + Math.floor(Math.random() * 1_000);
const temp = await mkdtemp(path.join(os.tmpdir(), "viewcoder-receipt-"));
const configPath = path.join(temp, "viewcoder.config.json");
const testProjectId = "viewcoder-receipt-smoke";
const testProjectKey = `${testProjectId}-${crypto
  .createHash("sha256")
  .update(testProjectId)
  .digest("hex")
  .slice(0, 12)}`;
const testProjectState = path.join(
  root,
  ".viewcoder",
  "projects",
  `${testProjectKey}.json`,
);
const generatedIconDirectory = path.join(root, ".viewcoder", "projects", "generated-icons");
const studioServerPath = path.join(root, "tests", "fake-studio-mcp.mjs");
const studioLauncher = path.join(
  temp,
  process.platform === "win32" ? "fake-studio.cmd" : "fake-studio",
);
await writeFile(
  studioLauncher,
  process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${studioServerPath}"\r\n`
    : `#!/usr/bin/env sh\nexec "${process.execPath}" "${studioServerPath}"\n`,
);
if (process.platform !== "win32") await chmod(studioLauncher, 0o755);

await writeFile(
  configPath,
  JSON.stringify({
    servers: {
      blender: {
        enabled: true,
        command: process.execPath,
        args: [path.join(root, "tests", "fake-blender-mcp.mjs")],
      },
    },
  }),
);

const child = spawn(process.execPath, [path.join(root, "bridge.js")], {
  cwd: root,
  env: {
    ...process.env,
    VIEWCODER_PORT: String(port),
    VIEWCODER_CONFIG_PATH: configPath,
    VIEWCODER_STUDIO_MCP_PATH: studioLauncher,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let generatedIconPath = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

try {
  await waitForTools();
  const rigOptions = await jsonFetch("/animation/rig/options");
  assert(rigOptions.robloxOnly === true, "Rig options are not scoped to Roblox.");
  assert(rigOptions.singleRig === true && rigOptions.sourceFile === "BlockyCharacter.fbx", "The single supplied rig is not advertised.");
  assert(!JSON.stringify(rigOptions).includes("My Avatar"), "The excluded My Avatar option was advertised.");
  const rigImport = await jsonFetch("/animation/rig", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rigType: "R6", preset: "Ignored" }),
  });
  assert(rigImport.ok === true && rigImport.blender?.imported === true, "The Roblox rig was not imported through Blender.");
  assert(rigImport.blender?.verified === true, "The Blender rig receipt was not validated.");
  assert(rigImport.blender?.viewportFramed === true, "The imported rig was not framed in Blender's viewport.");
  assert(rigImport.rig?.meshCount === 15 && rigImport.rig?.boneCount === 51, "The supplied animation rig is incomplete.");
  assert(rigImport.rig?.bundledSource === "BlockyCharacter.fbx", "The supplied rig source was not captured.");
  assert(rigImport.rig?.preset === "Blocky Character", "An obsolete preset request was not normalized to the supplied rig.");
  assert(rigImport.rig?.name === "ViewCoder_Animation_Rig", "The imported Blender rig name was not captured.");

  const advertisedTools = await jsonFetch("/tools");
  const advertisedNames = new Set(advertisedTools.tools?.map((tool) => tool.name));
  for (const name of [
    "blender/get_addon_status",
    "blender/get_scene_info",
    "blender/execute_blender_code",
    "blender/list_materials",
    "blender/set_render_engine",
    "blender/get_console_output",
  ]) {
    assert(advertisedNames.has(name), `Bridge omitted live Blender tool ${name}.`);
  }
  assert(!advertisedNames.has("blender/screen_capture"), "Bridge exposed the excluded Blender screen capture tool.");
  assert(!advertisedNames.has("blender/capture_viewport_screenshot"), "Bridge exposed the excluded Blender viewport screenshot tool.");

  const dynamicRequest = {
    sessionId: "receipt-session",
    requestId: "receipt-session:dynamic-1",
    tool: "blender/get_console_output",
    arguments: {},
    source: { provider: "test", promptRevision: "dynamic-1" },
  };
  const dynamicQueued = await jsonFetch("/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dynamicRequest),
  });
  const dynamicCompleted = await waitForReceipt(dynamicQueued.jobId, dynamicRequest.sessionId);
  assert(dynamicCompleted.result?.ok === true, "Dynamically advertised Blender tool did not dispatch.");
  assert(dynamicCompleted.result?.text?.includes('"tool":"get_console_output"'), "Dynamic Blender tool returned the wrong result.");
  const request = {
    sessionId: "receipt-session",
    requestId: "receipt-session:execute-1",
    tool: "blender/execute_blender_code",
    arguments: { code: "value = 42" },
    source: { provider: "test", promptRevision: "receipt-1" },
  };
  const queued = await jsonFetch("/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  assert(queued.jobId > 0, "Bridge did not return a job id.");

  const completed = await waitForReceipt(queued.jobId, request.sessionId);
  assert(
    completed.result?.ok === true,
    `Completed Blender receipt was not successful: ${JSON.stringify(completed)}\n${output}`,
  );
  assert(completed.result?.text?.includes('"value":42'), "Completed receipt lost its tool output.");

  for (let retry = 1; retry <= 8; retry += 1) {
    const duplicate = await jsonFetch("/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    assert(duplicate.duplicate === true, `Idempotent retry ${retry}/8 was not recognized.`);
    assert(duplicate.jobId === queued.jobId, `Idempotent retry ${retry}/8 changed the job id.`);
    assert(
      duplicate.result?.text === completed.result.text,
      `Idempotent retry ${retry}/8 did not reclaim the cached result.`,
    );
  }

  const wrongSession = await fetch(
    `http://127.0.0.1:${port}/jobs/${queued.jobId}?sessionId=another-chat`,
  );
  assert(wrongSession.status === 404, "A receipt leaked across chat sessions.");

  const luauRequest = {
    sessionId: "studio-session",
    requestId: "studio-session:execute-1",
    tool: "execute_luau",
    arguments: {
      code: "return 'direct-success'",
      datamodel_type: "Edit",
    },
    source: { provider: "test", promptRevision: "studio-id-direct" },
  };
  const luauQueued = await jsonFetch("/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(luauRequest),
  });
  const luauCompleted = await waitForReceipt(
    luauQueued.jobId,
    luauRequest.sessionId,
  );
  assert(
    luauCompleted.result?.ok === true,
    `execute_luau without a supplied Studio ID failed: ${JSON.stringify(luauCompleted)}\n${output}`,
  );
  assert(
    luauCompleted.result?.text?.includes('"studioId":"studio-test-1"'),
    "The direct execute_luau call did not inherit the connected Studio ID.",
  );

  const workflowRequest = {
    sessionId: "studio-session",
    requestId: "studio-session:workflow-1",
    tool: "viewcoder/run_workflow",
    arguments: {
      name: "Connected Studio ID regression",
      project_id: testProjectId,
      steps: [{
        id: "execute",
        tool: "execute_luau",
        arguments: {
          code: "return 'workflow-success'",
          datamodel_type: "Edit",
        },
      }],
    },
    source: { provider: "test", promptRevision: "studio-id-workflow" },
  };
  const workflowQueued = await jsonFetch("/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(workflowRequest),
  });
  const workflowCompleted = await waitForReceipt(
    workflowQueued.jobId,
    workflowRequest.sessionId,
  );
  assert(
    workflowCompleted.result?.ok === true,
    `Workflow execute_luau without a supplied Studio ID failed: ${JSON.stringify(workflowCompleted)}\n${output}`,
  );
  assert(
    workflowCompleted.result?.text?.includes('"state":"succeeded"'),
    "The workflow was falsely reported as failed.",
  );
  assert(
    workflowCompleted.result?.text?.includes('"studioId":"studio-test-1"'),
    "The workflow execute_luau step did not inherit the connected Studio ID.",
  );
  assert(
    !output.includes("arguments.studio_id"),
    `The bridge emitted a missing Studio ID error:\n${output}`,
  );

  const iconRequest = {
    sessionId: "icon-session",
    requestId: "icon-session:vector-1",
    tool: "viewcoder/generate_icon",
    arguments: {
      concept: "bridge publish shield",
      upload_to_roblox: false,
      icon_spec: {
        layers: [{
          shape: "polygon",
          points: [[50, 12], [82, 28], [75, 70], [50, 90], [25, 70], [18, 28]],
          fill: "#4f8edc",
          outline: "#1c355a",
        }],
      },
    },
    source: { provider: "test", promptRevision: "local-vector-publish" },
  };
  const iconQueued = await jsonFetch("/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(iconRequest),
  });
  const iconCompleted = await waitForReceipt(iconQueued.jobId, iconRequest.sessionId);
  assert(iconCompleted.result?.ok === true, `Local icon job failed: ${JSON.stringify(iconCompleted)}\n${output}`);
  const iconValue = JSON.parse(iconCompleted.result.text || "{}");
  generatedIconPath = iconValue.generatedLocalPath || "";
  assert(iconValue.strategy === "local_vector_generation", "Local icon did not use the vector renderer.");
  assert(/^http:\/\/127\.0\.0\.1:\d+\/images\//.test(iconValue.source || ""), "The bridge did not publish the local vector icon.");
  const iconResponse = await fetch(iconValue.source);
  const iconBytes = new Uint8Array(await iconResponse.arrayBuffer());
  assert(iconResponse.ok, "The published local vector icon URL was not readable.");
  assert(iconBytes.length > 1_000 && iconBytes[0] === 137 && iconBytes[1] === 80, "The published local icon was not a PNG.");

  console.log("Persistent receipt, connected Studio ID, and local icon publishing smoke test passed.");
} finally {
  if (child.exitCode == null) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    } else {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }
  await rm(testProjectState, { force: true });
  if (generatedIconPath) await rm(generatedIconPath, { force: true });
  try {
    await rmdir(generatedIconDirectory);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error;
  }
  await rm(temp, { recursive: true, force: true });
}

async function waitForTools() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const [tools, status] = await Promise.all([
        jsonFetch("/tools"),
        jsonFetch("/status"),
      ]);
      const names = new Set(tools.tools?.map((tool) => tool.name));
      if (
        names.has("blender/execute_blender_code") &&
        names.has("blender/get_console_output") &&
        names.has("execute_luau") &&
        status.mcp?.studioId === "studio-test-1"
      ) return;
    } catch {
      // Bridge and the fake MCP servers are still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Bridge did not advertise both fake MCP servers.\n${output}`);
}

async function waitForReceipt(jobId, sessionId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(
      `http://127.0.0.1:${port}/jobs/${jobId}?sessionId=${encodeURIComponent(sessionId)}`,
    );
    if (response.status === 200) return response.json();
    if (response.status !== 202) {
      throw new Error(`Receipt lookup failed (${response.status}): ${await response.text()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the cached job receipt.");
}

async function jsonFetch(pathname, options) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
