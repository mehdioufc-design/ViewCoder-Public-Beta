import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "ViewCoder Extension");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const manifest = JSON.parse(read("ViewCoder Extension/manifest.json"));

const providers = {
  deepseek: { file: "deepseek.js", host: "chat.deepseek.com", editor: 'editor: "textarea"' },
  gemini: { file: "gemini.js", host: "gemini.google.com", editor: ".ql-editor[contenteditable='true']" },
  kimi: { file: "kimi.js", host: "www.kimi.com", editor: 'editor: ".chat-input-editor"' },
  glm: { file: "glm.js", host: "chat.z.ai", editor: 'editor: "#chat-input"' },
  qwen: { file: "qwen.js", host: "chat.qwen.ai", editor: "textarea.message-input-textarea" },
  arena: { file: "arena.js", host: "arena.ai", editor: 'querySelectorAll("form textarea")' },
  meta: { file: "meta.js", host: "www.meta.ai", editor: '[data-testid="composer-input"]' },
  chatgpt: { file: "meta.js", host: "chatgpt.com", editor: "#prompt-textarea" },
  claude: { file: "claude.js", host: "claude.ai", editor: '[data-testid="chat-input"]' },
};

const startupEntries = (manifest.content_scripts || []).filter((entry) =>
  (entry.js || []).includes("core/main.js"),
);
assert.equal(startupEntries.length, Object.keys(providers).length, "Supported-provider manifest count drifted.");

const requiredContract = [
  "allItems", "isUserItem", "isAssistantItem", "itemText", "classifyText",
  "assistantCount", "userCount", "lastAssistant", "readAssistant", "streamLen",
  "getEditor", "editorText", "chatIsEmpty", "isFreshChat", "composerFrame",
  "setInputLock", "typeAndSend", "stopGeneration", "isGenerating",
  "conversationKey", "installSendHooks", "findToolBlockSpot",
];

for (const [id, expected] of Object.entries(providers)) {
  const entry = startupEntries.find((candidate) =>
    (candidate.matches || []).some((match) => match.includes(expected.host)),
  );
  assert(entry, `${id} has no startup entry for ${expected.host}.`);
  assert((entry.js || []).includes(`providers/${expected.file}`), `${id} loads the wrong adapter.`);
  assert((manifest.host_permissions || []).some((host) => host.includes(expected.host)), `${id} lacks host permission.`);

  const source = read(`ViewCoder Extension/providers/${expected.file}`);
  assert(source.includes(expected.editor), `${id} lost its audited composer selector.`);
  const hasId = expected.file === "meta.js"
    ? source.includes('id: IS_CHATGPT ? "chatgpt" : "meta"')
    : source.includes(`id: "${id}"`);
  assert(hasId, `${id} adapter id is missing.`);
  for (const member of requiredContract) {
    assert(source.includes(member), `${id} adapter contract is missing ${member}.`);
  }
}

const arena = read("ViewCoder Extension/providers/arena.js");
assert(arena.includes('location.pathname === "/"'), "Arena no longer recognizes its current root fresh-chat route.");
assert(arena.includes("isFreshRoute() && !!getEditor()"), "Arena startup is not bound to the shared fresh-route detector.");
assert(arena.includes("isFreshRoute() ? \"\" : location.pathname"), "Arena can persist a transient fresh route as a conversation.");

const claude = read("ViewCoder Extension/providers/claude.js");
assert(claude.includes('[data-testid="assistant-message"]'), "Claude lacks the semantic assistant-turn fallback.");
assert(claude.includes("for (const reply of document.querySelectorAll(S.reply))"), "Claude cannot retain settled replies after streaming ends.");
assert(claude.includes("lastAssistantId"), "Claude lacks stable assistant-turn identity.");

const core = read("ViewCoder Extension/core/main.js");
const lifecycleMatch = core.match(
  /const ZERO_ACTIVITY_LIFECYCLE_PROVIDERS = new Set\(\[([\s\S]*?)\]\);/,
);
assert(lifecycleMatch, "The ZeroScript activity-card lifecycle provider set is missing.");
const lifecycleProviders = [...lifecycleMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(
  lifecycleProviders,
  ["deepseek", "gemini", "kimi", "glm", "qwen", "arena"],
  "ZeroScript activity-card lifecycle scope drifted.",
);
for (const excluded of ["meta", "chatgpt", "claude"]) {
  assert(!lifecycleProviders.includes(excluded), `${excluded} must keep ViewCoder's native activity lifecycle.`);
}
assert(
  /if \(useZeroActivityLifecycle\) \{[\s\S]*?preHideWholeItems\(\);[\s\S]*?scheduleSweep\(true\);[\s\S]*?return;/.test(core),
  "ZeroScript-backed providers no longer pre-hide and fully classify every host mutation.",
);
assert(
  core.includes("const delay = useZeroActivityLifecycle\n      ? 1_500"),
  "ZeroScript-backed providers lost the 1.5-second card repair cadence.",
);

console.log("Nine-provider manifest, selector, and runtime-contract compatibility test passed.");
