import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parserSource = readFileSync(
  path.join(root, "ViewCoder Extension", "core", "parser.js"),
  "utf8",
);
const context = vm.createContext({});
vm.runInContext(
  `${parserSource}\nthis.__viewCoderParser = ZSParse;`,
  context,
);
const parser = context.__viewCoderParser;

const inlineExample =
  'For example, {"command":"execute_luau","params":{"code":"return 1"}} would run Luau.';
assert.equal(parser.hasToolSignature(inlineExample), false);
assert.equal(parser.hasCommandShape(inlineExample), false);
assert.equal(parser.hasOpenToolBlock(inlineExample), false);
assert.equal(parser.parseToolCalls(inlineExample).length, 0);

const markerExplanation =
  "The strings MCP_TOOL, execute_luau, and ###LUA### are protocol examples, not a command.";
assert.equal(parser.hasToolSignature(markerExplanation), false);
assert.equal(parser.hasCommandShape(markerExplanation), false);
assert.equal(parser.parseToolCalls(markerExplanation).length, 0);

const inlineOpen =
  'An incomplete example {"command":"execute_luau","params":{"code":"return 1"';
assert.equal(parser.hasOpenToolBlock(inlineOpen), false);

const standaloneJson = [
  "I will apply the change now.",
  "",
  '{"command":"execute_luau","params":{"code":"return 2","datamodel_type":"Edit"}}',
  "",
  "I will verify it afterward.",
].join("\n");
const standaloneCalls = parser.parseToolCalls(standaloneJson);
assert.equal(parser.hasToolSignature(standaloneJson), true);
assert.equal(standaloneCalls.length, 1);
assert.equal(standaloneCalls[0].tool, "execute_luau");
assert.equal(standaloneCalls[0].arguments.code, "return 2");

const fencedJson = [
  "Running the read.",
  "",
  "```json",
  '{"command":"script_read","params":{"target_file":"game.ServerScriptService.Main"}}',
  "```",
].join("\n");
assert.equal(parser.parseToolCalls(fencedJson).length, 1);
assert.equal(parser.parseToolCalls(fencedJson)[0].tool, "script_read");

const chatGptStandaloneJson = [
  "JSON",
  '{"command":"inspect_instance","params":{"studio_id":"470c8d80-48c8-476a-be6d-88a54856c493","path":"Workspace.Superman.Superman.Superman"}}',
].join("\n");
const chatGptStandaloneCalls = parser.parseToolCalls(chatGptStandaloneJson);
assert.equal(parser.hasCommandShape(chatGptStandaloneJson), true);
assert.equal(chatGptStandaloneCalls.length, 1);
assert.equal(chatGptStandaloneCalls[0].tool, "inspect_instance");
assert.equal(chatGptStandaloneCalls[0].arguments.path, "Workspace.Superman.Superman.Superman");

// DeepSeek's 2026-08 code-block toolbar is flattened into markdown text ahead
// of the clean <pre>. The shared parser fallback must tolerate those exact UI
// labels while still rejecting ordinary prose containing a JSON example.
const deepSeekToolbarJson =
  'jsonCopyDownload{"command":"blender/execute_blender_code","params":{"code":"print(123)"}}';
const deepSeekToolbarCalls = parser.parseToolCalls(deepSeekToolbarJson);
assert.equal(parser.hasCommandShape(deepSeekToolbarJson), true);
assert.equal(deepSeekToolbarCalls.length, 1);
assert.equal(deepSeekToolbarCalls[0].tool, "blender/execute_blender_code");
assert.equal(deepSeekToolbarCalls[0].arguments.code, "print(123)");

const toolbarLikeProse =
  'Click Download to save this example {"command":"execute_luau","params":{"code":"return 9"}}.';
assert.equal(parser.hasCommandShape(toolbarLikeProse), false);
assert.equal(parser.parseToolCalls(toolbarLikeProse).length, 0);

const openStandalone = [
  "Starting a long command.",
  "",
  '{"command":"execute_luau","params":{"code":"return 3"',
].join("\n");
assert.equal(parser.hasOpenToolBlock(openStandalone), true);

const tolerantMcp = [
  "### mcp-tool ###",
  '{"command":"get_studio_state"}',
  "### end-mcp-tool ###",
].join("\n");
const tolerantCalls = parser.parseToolCalls(tolerantMcp);
assert.equal(tolerantCalls.length, 1);
assert.equal(tolerantCalls[0].tool, "get_studio_state");

console.log("Standalone command-boundary parser regression passed.");
