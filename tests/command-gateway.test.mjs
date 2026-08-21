import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const main = readFileSync(
  path.join(root, "ViewCoder Extension", "core", "main.js"),
  "utf8",
);
const config = readFileSync(
  path.join(root, "ViewCoder Extension", "core", "config.js"),
  "utf8",
);

// Every provider must share the clean rendered-code fallback. This is the
// boundary that removes provider toolbar text such as DeepSeek's
// "json / Copy / Download" before parsing and painting the existing card UI.
assert.match(main, /function renderedCommandSourceCandidates\(item\)/);
assert.match(main, /for \(const candidate of renderedCommandSourceCandidates\(item\)\)/);
assert.match(
  main,
  /const hasRenderableCommand = textHasCommandShape \|\| !!renderedProviderCommand;/,
);
assert.match(
  main,
  /P\.isAssistantItem\(item\) && hasRenderableCommand &&\s*\(A\.started \|\| A\.starting\)/,
);

// Late DOM replacement must still promote a complete envelope. The live
// catalog gate below is the safety boundary, so unknown names cannot disappear
// as ordinary prose and cannot reach the bridge.
assert.match(main, /if \(lateCalls\.length > 0\) \{/);
const validationIndex = main.indexOf("if (A.toolNames.size && !A.toolNames.has(call.tool))");
const bridgeDispatchIndex = main.indexOf("const feedback = await runTool(call, res.item);");
assert(validationIndex >= 0, "The live-catalog validation gate is missing.");
assert(
  bridgeDispatchIndex > validationIndex,
  "Unknown-command validation must run before bridge dispatch.",
);
assert.match(main, /const MAX_UNKNOWN_COMMAND_CORRECTIONS = 1;/);
assert.match(main, /Unknown command · correcting automatically/);
assert.match(main, /rememberExecuted\(res\.item\);/);

const context = vm.createContext({});
vm.runInContext(`${config}\nthis.__viewCoderConfig = ZS;`, context);
const unknown = context.__viewCoderConfig.FEEDBACK.unknownTool(
  "blender/not_a_real_tool",
  ["blender/execute_blender_code", "list_commands"],
);
assert.match(unknown, /Unknown command "blender\/not_a_real_tool"/);
assert.match(unknown, /live synchronized command catalog/);
assert.match(unknown, /Rewrite the command once/);
assert.match(unknown, /Do not repeat the unknown command/);
assert.match(unknown, /blender\/execute_blender_code/);

console.log("Cross-provider command gateway regression passed.");
