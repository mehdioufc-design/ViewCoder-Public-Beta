import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "ViewCoder Extension");
const manifest = JSON.parse(read("ViewCoder Extension/manifest.json"));

assert(manifest.version === "1.0.0", "Manifest is not v1.0.0.");
assert(read("bridge.js").includes('const VERSION = "1.0.0"'), "Bridge version is not v1.0.0.");
assert(read("start.bat").includes("ViewCoder Studio Agent v1.0.0"), "Startup script version is not v1.0.0.");
assert(existsSync(path.join(root, "BETA-NOTICE.txt")), "First-release beta notice is missing.");
assert(read("BETA-NOTICE.txt").includes("FIRST PUBLIC BETA"), "The beta notice is not clearly labeled.");
assert(existsSync(path.join(root, "QUICK-START.txt")), "The simple setup guide is missing.");
assert(existsSync(path.join(root, "VERSIONS.md")), "The future version-slot roadmap is missing.");
assert(read("CHANGELOG.md").includes("v1.0.0 — First Public Beta"), "The clean v1.0.0 changelog is missing.");
assert(existsSync(path.join(root, "workflow-engine.mjs")), "Workflow engine is missing.");
assert(existsSync(path.join(root, "THIRD-PARTY-ICONS.txt")), "UI icon attribution is missing.");
const gameIconLibrary = path.join(root, "Game Icon Library");
const gameIconCatalog = JSON.parse(read("Game Icon Library/catalog.json"));
assert(existsSync(path.join(gameIconLibrary, "README.txt")), "Game icon library guide is missing.");
assert(existsSync(path.join(root, "GAME-ICON-LIBRARY-NOTICE.txt")), "Game icon rights notice is missing.");
assert(gameIconCatalog.count === 327, "Game icon catalog count is not 327.");
assert(gameIconCatalog.icons?.length === 327, "Game icon catalog entries are incomplete.");
const gameIconFiles = recursiveFiles(gameIconLibrary).filter((file) => /\.(?:png|jpe?g|gif|webp)$/i.test(file));
assert(gameIconFiles.length === 327, `Expected 327 unpacked game icons, found ${gameIconFiles.length}.`);
for (const icon of gameIconCatalog.icons) {
  const resolved = path.resolve(gameIconLibrary, icon.relativePath || "");
  assert(
    resolved.startsWith(gameIconLibrary + path.sep),
    `Catalog icon escapes the library: ${icon.relativePath}`,
  );
  assert(existsSync(resolved), `Catalog icon is missing: ${icon.relativePath}`);
}
assert(
  !recursiveFiles(gameIconLibrary).some((file) => /(?:__MACOSX|\.DS_Store|[\\/]\._)/i.test(file)),
  "macOS metadata was bundled in the game icon library.",
);
assert(
  existsSync(path.join(extension, "THIRD-PARTY-ICONS.txt")),
  "Extension-only UI icon attribution is missing.",
);
assert(!existsSync(path.join(root, "penpot-runner.cjs")), "Removed Penpot runner is still packaged.");
assert(!existsSync(path.join(root, "PENPOT-SETUP.txt")), "Removed Penpot setup guide is still packaged.");
assert(!existsSync(path.join(root, "tests/penpot-hosted-smoke.mjs")), "Removed Penpot test is still packaged.");
assert(!existsSync(path.join(root, "start-analytics.bat")), "Legacy analytics launcher is still packaged.");
assert(!existsSync(path.join(root, "analytics-server")), "Legacy analytics server is still packaged.");
assert(!read("bridge.js").includes("/analytics/"), "Legacy analytics routes are still enabled.");
assert(!read("ViewCoder Extension/popup/popup.html").includes('id="analyticsCard"'), "Legacy analytics UI is still present.");
assert(!read("ViewCoder Extension/background.js").includes("ANALYTICS_"), "Legacy analytics worker is still present.");
const bridgeSettings = JSON.parse(read("viewcoder.config.json"));
assert(!bridgeSettings.servers?.penpot, "Penpot configuration is still packaged.");

for (const script of manifest.content_scripts || []) {
  for (const relative of [...(script.js || []), ...(script.css || [])]) {
    assert(existsSync(path.join(extension, relative)), `Manifest path is missing: ${relative}`);
  }
}
const agentContentScripts = (manifest.content_scripts || []).filter((script) =>
  (script.js || []).includes("core/main.js")
);
assert(agentContentScripts.length === 9, "Expected nine supported AI site startup entries.");
for (const script of agentContentScripts) {
  const scripts = script.js || [];
  assert(scripts.includes("core/config.js"), `A supported AI is missing the shared icon policy: ${script.matches?.join(", ")}`);
  assert(
    scripts.indexOf("core/config.js") < scripts.indexOf("core/main.js"),
    `The shared prompt must load before the runtime for: ${script.matches?.join(", ")}`,
  );
}
for (const relative of Object.values(manifest.icons || {})) {
  assert(existsSync(path.join(extension, relative)), `Manifest icon is missing: ${relative}`);
}

const bridge = read("bridge.js");
for (const required of [
  "workflow-engine.mjs",
  "advertisedNativeTools",
  "advertisedTools",
  "VIEWCODER_TOOL_DEFINITIONS",
  "synchronizeToolCatalogs",
  "await synchronizeToolCatalogs()",
  "DISABLED_TOOL_NAMES",
  "isScreenshotTool",
  'server === "blender"',
  'leaf.includes("screenshot")',
  'leaf.includes("viewport_capture")',
  "iconLibraryDir",
  "publishImage",
  "game-icon-library",
  "ensureConnectedStudioId",
  "refreshBlenderAddonProbe",
  "get_addon_status",
  "BLENDER_ADDON_PROTOCOL_VERSION = 4",
  "blenderAddonProbe.connected",
]) {
  assert(bridge.includes(required), `Bridge release guard is missing: ${required}`);
}
assert(
  bridge.includes('blenderMcp.tools.filter((tool) => !isDisabledTool(tool?.name, "blender"))'),
  "The live Blender catalog is not dynamically exposed through the screenshot-only filter.",
);
assert(
  bridge.includes('resolveToolRoute(tool)') && bridge.includes('route.server === "blender"'),
  "Dynamically advertised Blender tools do not retain Blender dispatch routing.",
);

const disabledToolBlock = bridge.match(
  /const DISABLED_TOOL_NAMES = new Set\(\[([\s\S]*?)\]\);/,
)?.[1] || "";
for (const excluded of [
  "start_stop_play",
  "start_play",
  "stop_play",
  "play_test",
  "get_console_output",
  "console_output",
  "get_studio_output",
  "character_navigation",
  "navigate_character",
  "user_keyboard_input",
  "keyboard_input",
  "user_mouse_input",
  "mouse_input",
  "screen_capture",
]) {
  assert(disabledToolBlock.includes(`"${excluded}"`), `Unsafe Studio tool is not excluded: ${excluded}`);
}
for (const allowed of [
  "upload_image",
  "multi_edit",
  "script_read",
  "get_studio_state",
  "generate_procedural_model",
  "insert_asset",
  "generate_material",
  "execute_luau",
  "search_asset",
  "generate_mesh",
]) {
  assert(!disabledToolBlock.includes(`"${allowed}"`), `Required Studio tool was excluded: ${allowed}`);
}

const config = read("ViewCoder Extension/core/config.js");
for (const required of [
  "viewcoder/run_workflow",
  "viewcoder/batch_read",
  "viewcoder/project_context",
  "viewcoder/find_game_icons",
  'server: "all"',
  "VERIFY BEFORE CLAIMING SUCCESS",
  "LIVE CONNECTED MCP COMMAND REFERENCE",
]) {
  assert(config.includes(required), `Shared prompt is missing: ${required}`);
}
assert(!config.includes("you are NOT told about them upfront"), "A stale Roblox-only catalog instruction remains.");
for (const required of [
  "CURRENT VIEWCODER MODES",
  "Operating mode is PLAN",
  "Animation Mode (BETA) is ON and requires a verified live Blender MCP add-on connection",
  "AI Generated UI (BETA) is OFF",
  "your own built-in native image generator",
  "ViewCoder allows at most 3 attempts",
  "at most 2 background/alpha validation failures",
  "choose a coherent polished style",
  "3 minutes 30 seconds",
  "Decide yourself whether each UI element would genuinely benefit from an icon",
  "library_only=true",
  "never send icon_spec",
  "one transparent PNG for one panel",
  "Exactly ONE native image generation is allowed per real user message",
  "automatic ViewCoder tool-result follow-ups must never start a second render",
  "NO BACKGROUND AT ALL",
  "fully transparent (alpha 0)",
  "Shall I move on to upload and assemble it?",
  "StarterPlayerScripts",
  "Parent-locked containers",
  "Do you approve this plan?",
  "switches ViewCoder to Agent Mode",
]) {
  assert(config.includes(required), `Live mode policy is missing: ${required}`);
}
assert(!config.includes("The user's selected UI theme"), "The removed UI-theme prompt still exists.");
assert(!config.includes("If it returns no_match, leave the icon slot blank"), "The stale blank-icon policy still exists.");
assert(!config.includes("viewcoder/get_ui_style_reference"), "The removed UI-reference tool remains in the shared prompt.");
assert(!config.includes("AI UI Style References"), "The removed packaged UI-reference folder remains in the shared prompt.");

const generatedUiRelay = read("ViewCoder Extension/core/image-relay.js");
for (const required of [
  'record.source === "assistant-generated"',
  "hasTransparentCanvasEdge",
  "transparentCanvasCoverage",
  "transparentSamples",
  'if (record.source === "assistant-generated") throw error',
  "generated UI asset is not one isolated transparent component",
  "NO BACKGROUND AT ALL",
  "every pixel outside the component must be fully transparent (alpha 0)",
  'outputType = forceTransparentPng',
  'canvasBlob(canvas, "image/png")',
  "generatedImageTurnRoot",
  "hasFinishedGeneratedImage",
  "recoverCurrentTurn",
  '[data-testid^="conversation-turn-"]',
]) {
  assert(generatedUiRelay.includes(required), `Generated UI PNG relay guard is missing: ${required}`);
}

const workflowEngine = read("workflow-engine.mjs");
for (const required of [
  "local_vector_generation",
  "icon_spec.layers",
  "AI_NATIVE_GENERATION_REQUIRED",
  "retryLimit: 3",
  "current_chat_ai_native_image_generator",
  "switch_ai_generated_ui_off",
  "current_ai_decides_if_suitable",
  "nativeRenderGraceMs: 210000",
  "text_only_provider_library_policy",
  "libraryOnly",
  "semantic_library_only",
  "hyper3d",
  "hunyuan",
  "requiresInputImages",
  "one_separate_transparent_png_per_component",
  "THIS CHAT AI must use its own built-in native image generator",
  "one tightly cropped PNG with real transparent alpha",
  "setImageSourceArgument",
  'target.imagePaths = [value]',
]) {
  assert(workflowEngine.includes(required), `Icon workflow guard is missing: ${required}`);
}
assert(workflowEngine.includes("/blender/.test(server)"), "Blender tools are not explicitly excluded from 2D image generation.");
assert(!workflowEngine.includes("viewcoder/get_ui_style_reference"), "The removed UI-reference tool remains in the workflow catalog.");
assert(!workflowEngine.includes("AI UI Style References"), "The workflow still depends on the removed UI-reference folder.");
assert(!workflowEngine.includes("styleReferenceAttachments"), "The workflow can still attach packaged UI references.");

const extensionMain = read("ViewCoder Extension/core/main.js");
for (const required of [
  "const NATIVE_UI_GENERATION_WAIT_MS = 210_000",
  "waitForFinishedAssistantGeneratedImage(",
  "nativeUiImageStillRendering",
  "NATIVE_UI_IMAGE_SETTLE_MS",
  "generatedUiToolNeedsFinishedImage",
  "generatedIconRelay.toolReady",
  "finalAnswerSettled",
  "relay?.hasFinishedGeneratedImage?.(captureScope)",
  "P.isGenerating() && !finishedVisible",
  "lastScopedRecoveryAt",
  "recoverCurrentTurn: true",
  "userExpectsNativeGeneratedUi",
  "callIsCodeNativeUiMutation",
  "AI Generated UI is ON for this request",
  "rememberedLiveRun",
  "const sameTurn = !!A.toolVisual.turnKey",
  "A.suppressProviderGen = true",
  "nativeImageBaselineKey",
  "const nativeImageReply = !!(",
  "nativeImageRoot !== A.sendItem",
  "waitForAutomaticSendSlot",
  "startupHasNoTurn",
  "P.chatIsEmpty?.() === true",
  "const nativeFinished = isNew && state?.finished === true",
  "const providerFinished = providerRootIsNew && providerImageState?.finished === true",
  "writeComposerDraft",
  "restoreComposerDraft",
  "originalDraft || (!messageSent && now.trim() === injected.trim())",
]) {
  assert(extensionMain.includes(required), `Native UI completion grace is missing: ${required}`);
}
assert(!extensionMain.includes("get_ui_style_reference"), "The extension runtime still handles the removed UI-reference activity.");
assert(!extensionMain.includes("packaged UI style references"), "The removed UI-reference activity caption remains.");

const metaProvider = read("ViewCoder Extension/providers/meta.js");
for (const required of [
  "function nativeImageGenerationState",
  "polishing\\s+details",
  "adding\\s+final\\s+touches",
  "sketching\\s+it\\s+out",
  "preparing\\s+visual\\s+context",
  "/generated image/i",
  'data-testid="image-gen-overlay-actions"',
  'data-testid^="conversation-turn-"',
  "root: scope",
]) {
  assert(metaProvider.includes(required), `ChatGPT/Meta native image detector is missing: ${required}`);
}
const geminiProvider = read("ViewCoder Extension/providers/gemini.js");
for (const required of [
  "function nativeImageGenerationState",
  "mat-progress-spinner",
  "loading-shimmer",
  "generated-image",
  "sketching\\s+it\\s+out",
  "preparing\\s+visual\\s+context",
]) {
  assert(geminiProvider.includes(required), `Gemini native image detector is missing: ${required}`);
}

const background = read("ViewCoder Extension/background.js");
assert(!/penpot/i.test(background), "Penpot service-worker code is still present.");
assert(!/maximumActive|MAXIMUM_ACTIVE|max-active/i.test(background), "A second Active Mode is still present.");
assert(background.includes("bridgeToolsRequest"), "Tool discovery requests are not coalesced.");
assert(background.includes('bridgeRequest("/tools", {}, 25_000)'), "Tool discovery timeout is too short.");
assert(background.includes('animationMode: false'), "Animation Mode is not off by default.");
assert(background.includes('iconMode: true'), "AI Generated UI is not on by default.");
assert(background.includes('preset: "Blocky Character"'), "The supplied Blocky Character rig is not the only default.");

const popup = read("ViewCoder Extension/popup/popup.html");
assert(popup.includes("v1.0.0"), "Popup fallback version is not v1.0.0.");
assert(!/penpot/i.test(popup), "Penpot popup UI is still present.");
assert((popup.match(/class="active-mode-toggle"/g) || []).length === 1, "Popup must contain exactly one Active Mode switch.");
assert(popup.includes('class="creative-modes" aria-labelledby="creative-modes-title" hidden'), "Creative controls were not moved out of the target-health popup.");
assert(popup.includes('class="active-mode-card" aria-labelledby="active-mode-title" hidden'), "Active Mode was not moved out of the target-health popup.");
assert(popup.includes('class="bridge-actions" hidden'), "Studio refresh controls were not moved out of the target-health popup.");
for (const required of [
  "Creative Modes",
  "Animation Mode",
  "AI Generated UI",
  "Switch either mode at any time",
  "Import Rig",
  "Blocky Roblox animation rig",
  "each panel, button, header, badge, or icon as its own transparent PNG",
  "off or unavailable",
]) {
  assert(popup.includes(required), `Popup creative mode UI is missing: ${required}`);
}
assert(!popup.includes("My Avatar"), "The excluded My Avatar rig option remains in the popup.");
for (const removedPreset of ["Rthro", "Lola", "Classic R6", "R6 Mannequin", "R15 Mannequin"]) {
  assert(!popup.includes(removedPreset), `Removed rig preset remains in the popup: ${removedPreset}`);
}
for (const icon of ["active.png", "blender.webp", "check.png", "provider.png", "studio.png"]) {
  assert(existsSync(path.join(extension, "icons", "ui", icon)), `Popup UI icon is missing: ${icon}`);
}
for (const asset of ["icons/viewcoder-logo.png", "icons/ui/agent-mode.png"]) {
  const fullPath = path.join(extension, asset);
  assert(existsSync(fullPath), `New ViewCoder visual asset is missing: ${asset}`);
  const png = readFileSync(fullPath);
  assert(png[25] === 6, `${asset} does not use RGBA PNG transparency.`);
}
assert(existsSync(path.join(root, "animation-rig.mjs")), "Roblox animation rig builder is missing.");
assert(read("animation-rig.mjs").includes("rig.show_in_front = False"), "The Blender rig still exposes its stick-figure bone overlay through the body.");
assert(read("animation-rig.mjs").includes("rig.hide_set(True)"), "The Blender armature is still visible after the body is framed.");
assert(read("animation-rig.mjs").includes('rig["viewcoder_armature_hidden"] = True'), "The hidden-armature state is not verified.");

const main = read("ViewCoder Extension/core/main.js");
const zeroLifecycleMatch = main.match(
  /const ZERO_ACTIVITY_LIFECYCLE_PROVIDERS = new Set\(\[([\s\S]*?)\]\);/,
);
assert(zeroLifecycleMatch, "The scoped ZeroScript activity lifecycle provider set is missing.");
const zeroLifecycleProviders = [...zeroLifecycleMatch[1].matchAll(/"([^"]+)"/g)]
  .map((match) => match[1]);
assert(
  JSON.stringify(zeroLifecycleProviders) === JSON.stringify(["deepseek", "gemini", "kimi", "glm", "qwen", "arena"]),
  `Unexpected ZeroScript activity lifecycle scope: ${zeroLifecycleProviders.join(", ")}`,
);
for (const excluded of ["meta", "chatgpt", "claude"]) {
  assert(!zeroLifecycleProviders.includes(excluded), `${excluded} must retain ViewCoder's native activity lifecycle.`);
}
assert(
  /if \(useZeroActivityLifecycle\) \{[\s\S]*?preHideWholeItems\(\);[\s\S]*?scheduleSweep\(true\);[\s\S]*?return;/.test(main),
  "Scoped providers no longer pre-hide and fully reconcile every host mutation.",
);
assert(main.includes("const delay = useZeroActivityLifecycle\n      ? 1_500"), "Scoped providers lost ZeroScript's 1.5-second repair cadence.");
assert(main.includes('{ server: "all" }'), "Startup does not request the complete all-server catalog.");
assert(main.includes("ZS.toolsReminder(A.toolList)"), "Long-chat reminders do not retain the live catalog.");
assert(main.includes("async function parkHiddenLuau()"), "Long Lua is not protected while the provider tab is hidden.");
assert(main.includes("replyHasOpenLuau"), "Hidden-tab parking is not scoped to an open execute_luau block.");
assert(main.includes("response.promotedLateLuau"), "Transient long-Lua DOM reads are not recovered before parse feedback.");
assert(main.includes("response.promotedLateCommand"), "Transient complete JSON commands are not recovered before parse feedback.");
assert(main.includes('res.reason === "luaOpener"'), "Missing Lua opener DOM reads do not receive the bounded live-turn recovery.");
assert(main.includes("luaMarkerMismatchSince"), "Closing-before-opening CodeMirror reads are not given a settle window.");
assert(main.includes("13 : 1"), "Late CodeMirror command recovery is not using the extended bounded retry window.");
assert(main.includes("res.item, P.lastAssistant()"), "Late command recovery does not retain the original response node.");
assert(main.includes("providerCommandCalls"), "Provider-native fenced command sources are not parsed independently.");
assert(main.includes("renderedCommandSourceCandidates"), "Shared rendered <pre> command extraction is missing for provider markup changes.");
assert(main.includes("response.providerCommandSource"), "Direct fenced command source recovery is not observable in diagnostics.");
assert(main.includes('"zs-lua-command-mask"'), "Lua-only scroll-remount decoration is not cleared safely.");
assert(main.includes("settledLua"), "Completed execute_luau cards can still re-enter the working phase.");
assert(main.includes("zLuaUnreadableAt"), "Transient ChatGPT Lua remounts have no bounded decoration grace.");
assert(main.includes("P.clearCommandMask?.(item)"), "Lua remount memory is not cleared on a real decoration reset.");
assert(main.includes("generatedIconRelay.continue"), "Native-generated icon cards are not continued into generate_icon.");
for (const required of [
  "MAX_AI_UI_GENERATION_ATTEMPTS = 3",
  "MAX_AI_UI_BACKGROUND_FAILURES = 2",
  "registerNativeUiGenerationFailure",
  "AI_NATIVE_GENERATION_REQUIRED",
  "automatically switched AI Generated UI off",
  "current chat AI, must use your own built-in native image generator",
  "A.awaitingNativeUiGeneration",
  "nativeUiCapturedForUserTurn",
  "generatedIconRelay.reused",
  "Do NOT start, request, or describe another native image generation during this user turn",
  "nativeUiApprovalRequired",
  "pendingNativeUiApprovalImage",
  "nativeUiApprovalDenied",
  "waiting for the user's approval before the next step",
]) {
  assert(main.includes(required), `Native AI generation retry/fallback policy is missing: ${required}`);
}
for (const required of [
  "providerCanGenerateIcons",
  "VIEWCODER_SET_MODES",
  "Plan Mode",
  "Animation Mode is on",
  "AI Generated UI is off",
  'target.library_only = true',
  "AI Generated UI is unavailable on this AI",
  "expectGeneratedUi",
  'id="zs-agent-mode"',
  'id="zs-menu-refresh"',
  'id="zs-menu-blender"',
  'id="zs-menu-active"',
  'id="zs-menu-animation"',
  'id="zs-menu-icons"',
  'id="zs-menu-rig-import"',
  'class="zs-site-emoji"',
  'icons/ui/agent-mode.png',
  'icons/ui/active.png',
  'icons/ui/blender.webp',
  'icons/viewcoder-logo.png',
  "VIEWCODER_DISCORD_URL",
  "VIEWCODER_ROBUX_SUPPORT_URL",
  "viewcoderCommunityReminderAt",
  "COMMUNITY_REMINDER_INTERVAL_MS",
  "Join Discord",
  "Not now",
]) {
  assert(main.includes(required), `Live mode enforcement is missing: ${required}`);
}
assert(!main.includes('<b>Operating Mode</b>'), "Operating Mode is duplicated inside the settings panel.");
assert(!main.includes('data-menu-mode="agent"'), "The removed duplicate Agent segment remains in the settings panel.");
assert(main.includes('menuBlenderState?.ready === true'), "The in-chat Blender control does not require verified readiness.");
assert(main.includes('const TOOL_RECEIPT_RETRY_MS = 43_000'), "The exact 43-second command receipt deadline is missing.");
assert(main.includes('const TOOL_RECEIPT_MAX_RETRIES = 8'), "The eight-retry command receipt limit is missing.");
assert(main.includes('const TOOL_RESULT_REPLY_START_MS = 43_000'), "The post-result assistant-start deadline is not 43 seconds.");
assert(main.includes('const TOOL_RESULT_REPLY_PROGRESS_MS = 43_000'), "The started-but-stalled assistant deadline is not 43 seconds.");
assert(main.includes('const TOOL_RESULT_REPLY_MAX_NUDGES = 8'), "The post-result continuation recovery is not bounded to eight nudges.");
assert(main.includes('["no_start", "stalled"].includes(res.kind)'), "Delivered results do not recover both missing and started-but-stalled assistant replies.");
assert(main.includes('diag("tool.resultReplyNudge"'), "Post-result continuation attempts are not observable in diagnostics.");
assert(main.includes('Do not repeat or re-run the completed Studio/Blender command.'), "Post-result recovery can accidentally repeat a completed mutation.");
assert(main.includes('progressWatchdog?.arm(Date.now() + PROGRESS_TIMEOUT)'), "Actual assistant progress does not re-arm the 43-second watchdog.");
assert(main.includes('releaseStalledProviderReply'), "A frozen provider reply is not released before its safe continuation nudge.");
assert(main.includes('receiptNeedsRecovery'), "Retryable bridge timeout/running results are not classified for recovery.");
assert(main.includes('pendingReceiptDispatches.delete(outcome.tracked)'), "Settled receipt promises can still poison later retry races.");
assert(main.includes('receiptRetries >= TOOL_RECEIPT_MAX_RETRIES'), "The receipt recovery loop is not bounded at eight retries.");
assert(main.includes('startReceiptDispatch();'), "The 43-second receipt recovery does not retry the command.");
assert(main.includes('waitForWatchdogDeadline('), "Command receipt recovery lacks a durable background-tab deadline.");
assert(background.includes('const WATCHDOG_ALARM_PREFIX = "viewcoder-watchdog:"'), "The service worker watchdog alarm namespace is missing.");
assert(background.includes('case "schedule_watchdog"'), "Content scripts cannot schedule durable watchdog alarms.");
assert(background.includes('type: "viewcoder-watchdog-tick"'), "Watchdog alarms do not wake their owning AI tab.");
assert(main.includes('activeWatchdogs.get(String(msg.token || ""))?.fire("background")'), "The provider tab does not consume background watchdog alarms.");
assert(main.includes('wakeTimedWaits();') && main.includes('msg.type === "viewcoder-active-tick"'), "Active Mode heartbeats do not wake throttled retry waits.");
assert(main.includes('submitToolResultWithRetries(toSend, images)'), "Completed tool results do not use bounded delivery recovery.");
assert(main.includes('diag("tool.resultDeliveryRetry"'), "Result-delivery retries are not observable in diagnostics.");
assert(main.includes("sendOutcome?.dispatched === true"), "Result delivery cannot distinguish pre-dispatch failure from ambiguous acknowledgement.");
assert(!main.includes('diag("send.dispatchUnconfirmed"'), "An unacknowledged Send invocation can still be mistaken for delivery.");
assert(!main.includes("if (!messageSent && providerDispatched)"), "An ignored Send click can still release the result-delivery transaction.");
assert(main.includes('diag("tool.consumedRemountSuppressed"'), "Already-dispatched assistant command remounts can still pause or re-execute the task.");
assert(!main.includes("returned an already completed ViewCoder command turn"), "A consumed provider remount can still stop the running task.");
assert(main.includes('activityVisuals') && main.includes('diag("chip.restore"') && main.includes('diag("chip.reroot"'), "Activity cards do not survive provider-node remounts.");
assert(main.includes('Ask, plan &amp; approve · Beta'), "The compact Plan description was not applied.");
assert(background.includes("VIEWCODER_IMPORT_RIG"), "Background worker cannot import a selected Roblox rig.");
assert(background.includes("viewcoderModeState"), "Live modes are not persisted.");
assert(bridge.includes('requestUrl.pathname === "/animation/rig"'), "Bridge rig import endpoint is missing.");
assert(bridge.includes("buildRobloxRigScript"), "Bridge does not build the Blender Roblox rig.");
assert(Array.isArray(manifest.web_accessible_resources), "In-chat visual assets are not web-accessible.");
assert(
  manifest.web_accessible_resources.some((entry) => entry.resources?.includes("icons/ui/active.png")),
  "The in-chat Active Mode icon is not web-accessible.",
);
assert(
  manifest.web_accessible_resources.some((entry) => entry.resources?.includes("icons/ui/blender.webp")),
  "The supplied Blender icon is not web-accessible.",
);
const overlay = read("ViewCoder Extension/overlay.css");
assert(overlay.includes("#zs-bar.zs-prov-deepseek.zs-bar-inline.zs-bar-inside"), "DeepSeek's ViewCoder header is not fitted to the composer top edge.");
assert(overlay.includes('font: 600 10.5px/1.2'), "Agent/Plan dropdown text was not reduced to compact sizing.");
assert(overlay.includes('.zs-agent-mark { width: 25px; height: 25px; transform: scaleX(1.18);'), "The Agent/Plan sparkle is not large and visually balanced.");
assert(overlay.includes('.zs-brand-mark { width: 22px; height: 22px;'), "The ViewCoder status-bar logo was not enlarged.");
assert(overlay.includes(".zs-menu-creative-grid"), "In-chat Creative Mode controls have no layout styling.");
assert(overlay.includes("#zs-community-reminder"), "The Discord support reminder has no styling.");
assert(overlay.includes("#zs-discord"), "The compact Discord status-bar action has no styling.");
assert(overlay.includes("display: grid; place-items: center; line-height: 0;"), "The Discord status-bar icon is not centered.");
assert(overlay.includes("width: 24px; height: 24px; fill: currentColor"), "The Discord status-bar icon was not enlarged.");
assert(overlay.includes("grid-template-columns: 42px minmax(0, 1fr) 10px"), "Agent/Plan menu text can still overflow its box.");
assert(main.includes('${DISCORD_ICON}</span>'), "The settings panel does not reuse the status-bar Discord icon.");
assert(main.includes('https://discord.gg/VRcg7RBpV'), "The ViewCoder Discord link is incorrect.");
assert(main.includes('https://www.roblox.com/users/8651250465/profile'), "The Donate Robux link is incorrect.");
assert(main.includes("7 * 24 * 60 * 60 * 1000"), "The Discord reminder is not rate-limited to once per seven days.");
assert(main.includes("A.running || A.toolRunning"), "The Discord reminder can interrupt active work.");
for (const removed of [
  "isImageGenerationActive",
  "image_generation",
  "safetyStop",
  "chatgptAttachmentGuard",
  "was redirected to image generation",
  "Treat attached material only as reference",
]) {
  assert(!main.includes(removed), `Image-generation blocker remains in main.js: ${removed}`);
}
assert(main.includes("noteMutations(mutations)"), "Mutation batches are not tracked for dirty-turn sweeps.");
assert(main.includes("this._dirtyNodes"), "Unchanged chat turns are not excluded from repeated classification.");
assert(main.includes('"ViewCoder Is Connecting"'), "The connecting prompt-cover label is missing.");
assert(main.includes('"ViewCoder Is Working"'), "The working prompt-cover label is missing.");
assert(main.includes('ui.inputCover(true, "connecting")'), "Startup does not select the connecting cover state.");
assert(
  main.includes("(P.coverTarget && P.coverTarget()) ||") &&
    main.includes("(P.composerFrame && P.composerFrame()) ||"),
  "Prompt-cover positioning does not resolve the provider's full composer.",
);
assert(main.includes("const coversWholeComposer = covNode !== e"), "Full-composer geometry is not distinguished from the editor fallback.");
assert(main.includes('typeof ResizeObserver === "function"'), "Prompt covers do not observe live composer height changes.");
assert(main.includes("coverResizeObserver.observe(covNode)"), "Prompt covers are not synchronized to the provider's composer node.");
assert(main.includes("coverResizeFrame = requestAnimationFrame(place)"), "Prompt-cover resize updates are not paint-synchronized.");
assert(!main.includes('classList.add("zs-composer-covered")'), "The live composer is still frozen at an earlier prompt height.");
assert(main.includes("cover.style.background = opaqueBg(covNode)"), "Prompt covers do not sample the provider's gray composer surface.");
assert(main.includes('const statusBar = document.getElementById("zs-bar")'), "Prompt-cover geometry does not preserve the ViewCoder status row.");
assert((bridge.match(/\.\.\.studioTarget/g) || []).length === 3, "Internal ViewCoder memory calls do not retain the connected Studio ID.");
for (const removed of ["UI_THEMES", "AVAILABLE_UI_STYLES", "vcUiStyleMode", "getUiStyleInstruction", "<span>UI theme</span>", "zs-style-opt"]) {
  assert(!main.includes(removed), `Removed UI-theme runtime remains: ${removed}`);
}
assert(main.includes("customPrompt: ui.getCustomPrompt()"), "Startup no longer uses the unchanged personal prompt path.");
assert(!main.includes("âš  Issue"), "The old Issue label is still present.");
assert(!main.includes("A quick note from ViewCoder"), "The old notice prefix is still present.");
assert(!/penpot/i.test(main), "Penpot runtime code is still present.");
assert(!/maximumActive|MAXIMUM_ACTIVE|max-active/i.test(main), "A second Active Mode remains in the runtime.");

for (const relative of [
  "bridge.js",
  "viewcoder.config.json",
  "ViewCoder Extension/core/config.js",
  "ViewCoder Extension/providers/claude.js",
  "ViewCoder Extension/providers/meta.js",
  "ViewCoder Extension/popup/popup.js",
]) {
  assert(!/penpot/i.test(read(relative)), `Penpot reference remains in ${relative}.`);
}

const claude = read("ViewCoder Extension/providers/claude.js");
assert(claude.includes('noticeLabel: "Beta"'), "Claude Beta notice is missing.");
assert(claude.includes("viewcoder/run_workflow"), "Claude workflow guidance is missing.");
assert(claude.includes("AI GENERATED UI POLICY:"), "Claude's provider-specific prompt is missing the AI Generated UI policy.");
assert(!claude.includes("viewcoder/get_ui_style_reference"), "Claude still requests the removed packaged UI reference.");
assert(claude.includes("Decide whether an icon is actually suitable"), "Claude's optional preset-icon policy is missing.");
assert(claude.includes("library_only=true"), "Claude is missing its library-only icon path.");
assert(claude.toLowerCase().includes("never send icon_spec"), "Claude can still request local icon generation.");
assert(claude.includes("function coverTarget()"), "Claude has no full-composer cover target.");
assert(claude.includes("borderTopLeftRadius"), "Claude does not resolve its actual rounded prompt card.");
assert(claude.includes("barAnchor, coverTarget"), "Claude does not export its prompt-band positioning contract.");
assert(claude.includes('[data-testid="assistant-message"]'), "Claude has no semantic completed-assistant fallback.");
assert(claude.includes("for (const reply of document.querySelectorAll(S.reply))"), "Claude drops completed replies when data-is-streaming disappears.");
assert(claude.includes("lastAssistantId"), "Claude activity cards do not expose stable assistant identity.");
for (const provider of ["arena", "deepseek", "gemini", "glm", "kimi", "qwen"]) {
  const providerSource = read(`ViewCoder Extension/providers/${provider}.js`);
  assert(providerSource.includes("coverTarget"), `${provider} has no full prompt-bar cover target.`);
  assert(/composerFrame[^\n]*coverTarget|barAnchor[^\n]*coverTarget/.test(providerSource), `${provider} does not export its full prompt-bar target.`);
}
for (const provider of ["gemini", "kimi"]) {
  assert(
    read(`ViewCoder Extension/providers/${provider}.js`).includes('noticeLabel: "Notice"'),
    `${provider} Notice label is missing.`,
  );
}
const chatgpt = read("ViewCoder Extension/providers/meta.js");
assert(chatgpt.includes("borderTopLeftRadius"), "ChatGPT does not resolve its actual rounded prompt card.");
assert(chatgpt.includes('unstableWarning: ""'), "ChatGPT warning was not removed.");
assert(chatgpt.includes('noticeLabel: ""'), "ChatGPT Notice label was not removed.");
assert(!chatgpt.includes("provider-side model behavior"), "The old ChatGPT notice text is still packaged.");
assert(chatgpt.includes("appendBlock(cleanJsonViewer"), "ChatGPT JSON blocks are not separated from surrounding prose.");
assert(chatgpt.includes("chooseRenderedCodeText"), "ChatGPT code extraction does not preserve complete Lua/JSON candidates.");
assert(chatgpt.includes('querySelectorAll(".cm-content")'), "ChatGPT CodeMirror containers are not extracted.");
assert(chatgpt.includes('classList.contains("cm-line")'), "ChatGPT CodeMirror line breaks are not reconstructed.");
assert(chatgpt.includes("commandSourceCandidates"), "ChatGPT fenced command sources are not exposed independently of Markdown text.");
assert(chatgpt.includes('b.querySelectorAll("pre")'), "ChatGPT direct fenced blocks are not enumerated for exact parsing.");
assert(chatgpt.includes("LUA_SHAPE"), "ChatGPT execute_luau masking is not scoped independently from other tools.");
assert(chatgpt.includes('item.classList.add("zs-lua-command-mask")'), "ChatGPT execute_luau turns do not retain a stable scroll-remount mask.");
assert(chatgpt.includes("ensureLuaMaskObserver"), "ChatGPT execute_luau remounts are not masked before paint.");
assert(chatgpt.includes("_knownLuaMessageIds"), "ChatGPT execute_luau masks do not survive assistant-node replacement.");
assert(chatgpt.includes("_knownCommandMessageIds"), "ChatGPT direct-command masks do not survive long-chat assistant-node replacement.");
assert(chatgpt.includes("STANDALONE_JSON_COMMAND_SHAPE") && chatgpt.includes("isPersistentCommandSource"), "ChatGPT standalone JSON commands are not persistently masked during remounts.");
assert(chatgpt.includes("itemKey") && chatgpt.includes("data-message-id"), "ChatGPT activity cards do not use stable message identities.");
assert(chatgpt.includes("attachmentBatchReady"), "ChatGPT multi-image visual context does not wait for the complete attachment batch.");
assert(chatgpt.includes("names.length === images.length"), "ChatGPT can accept a partial visual-context attachment batch.");
assert(chatgpt.includes("attempt <= 2"), "ChatGPT visual-context attachment has no automatic clean retry.");
assert(chatgpt.includes("activeComposerForm") && chatgpt.includes("activeComposerShell"), "ChatGPT attachments are not scoped to the active unified composer.");
assert(chatgpt.includes("data-prompt-textarea-header"), "ChatGPT's out-of-form attachment header is not included in visual-context staging.");
assert(chatgpt.includes("pendingAttachmentCount() >= expectedNames.length"), "ChatGPT can still reject a complete virtualized attachment strip.");
assert(chatgpt.includes("const becameSendReady = await waitFor(sendReady, 60000)"), "ChatGPT does not wait for its native attachment-processing send gate.");
assert(chatgpt.includes("userCount() > userCountBeforeSend"), "ChatGPT visual-context send acceptance is not confirmed by the injected user turn.");
assert(chatgpt.includes("matchingUserTurnLanded()"), "ChatGPT cannot confirm a newly landed hidden result when long-chat turn counts stay flat.");
assert(chatgpt.includes('(editorText().trim() === "" && !hasPendingAttachment())'), "ChatGPT send confirmation does not require the composer and attachments to clear.");
assert(!chatgpt.includes("for (let i = 0; i < 3 && !sent; i++)"), "ChatGPT can still click Send repeatedly for one hidden result.");
assert(chatgpt.includes("return { accepted: sent, dispatched: true }"), "ChatGPT does not report post-click delivery separately from DOM acknowledgement.");
const arenaProvider = read("ViewCoder Extension/providers/arena.js");
assert(!arenaProvider.includes("for (let i = 0; i < 3 && !sent; i++)"), "Arena can still click Send repeatedly for one hidden result.");
assert(arenaProvider.includes('location.pathname === "/"'), "Arena's current root fresh-chat route is unsupported.");
assert(arenaProvider.includes("isFreshRoute() ? \"\" : location.pathname"), "Arena can persist a transient fresh route as a conversation.");
for (const provider of ["claude", "deepseek", "gemini", "glm", "kimi", "qwen"]) {
  const providerSource = read(`ViewCoder Extension/providers/${provider}.js`);
  assert(providerSource.includes("dispatched: true") || providerSource.includes("dispatched }"), `${provider} does not expose an exactly-once dispatch outcome.`);
}
assert(main.includes("error.viewCoderSendFailure = true"), "Provider submission failures cannot release ViewCoder's stale Working state.");
assert(main.includes("existingChips.forEach((duplicate) => duplicate.remove())"), "Visual-context turns can retain duplicate Preparing/Shared cards.");
assert(read("ViewCoder Extension/providers/glm.js").includes("lastAssistantId, itemKey"), "GLM activity cards do not expose their stable message identity.");
assert(chatgpt.includes("rememberDirectCommandMask"), "ChatGPT direct Blender/Roblox commands have no stable remount mask.");
assert(chatgpt.includes("mutation.addedNodes"), "ChatGPT Lua masking does not use the bounded added-node observer path.");
assert(chatgpt.includes("clearCommandMask"), "ChatGPT Lua remount memory cannot be cleared on regenerate/recycle.");
const overlayCss = read("ViewCoder Extension/overlay.css");
assert(overlayCss.includes("#zs-input-cover"), "The universal prompt cover style is missing.");
assert(!overlayCss.includes(".zs-composer-covered"), "The removed fixed-height composer clamp is still packaged.");
assert(overlayCss.includes("border-radius: 14px"), "The prompt cover lost its rounded ZeroScript geometry.");
assert(overlayCss.includes("color: #b9bcc3"), "The prompt cover lost its neutral gray working label.");
assert(overlayCss.includes("@keyframes vc-dot-bounce"), "Connecting/working dots no longer bounce.");
assert(overlayCss.includes("border-radius: 50%"), "The animated cover indicators are not dots.");
assert(overlayCss.includes("html.zs-site-claude [data-base-ui-portal] [data-cds-portal]"), "Claude CDS menus are not lifted above ViewCoder.");
assert(overlayCss.includes("#zs-agent-mode"), "Agent/Plan control styling is missing.");
assert(overlayCss.includes("#zs-agent-menu"), "Agent/Plan menu styling is missing.");
assert(overlayCss.includes(".zs-brand-mark"), "New ViewCoder logo styling is missing.");
assert(overlayCss.includes('--cds-portal-z: 2147483646 !important'), "Claude's portal layer remains below ViewCoder.");
assert(overlayCss.includes('.zs-lua-command-mask .markdown pre'), "ChatGPT rehydrated execute_luau blocks are not hidden from the stable turn mask.");
assert(overlayCss.includes('.zs-lua-command-mask .markdown .zs-chip pre'), "The execute_luau mask also hides the ViewCoder card body.");
assert(overlayCss.includes('.zs-command-mask .markdown pre'), "Long-chat ChatGPT direct commands are not hidden through CodeMirror remounts.");
assert(!overlayCss.includes('.zs-cmd-mask .markdown pre'), "ChatGPT scroll masking was broadened beyond execute_luau.");
for (const removed of [
  "CHATGPT_REFERENCE_GUARD",
  "appendChatGptReferenceGuard",
  "DO NOT CREATE AN IMAGE",
  "Treat attached material only as reference",
  "isImageGenerationActive",
]) {
  assert(!chatgpt.includes(removed), `ChatGPT image-generation restriction remains: ${removed}`);
}

const imageRelay = read("ViewCoder Extension/core/image-relay.js");
for (const required of [
  "assistant-generated",
  "captureGeneratedImageElement",
  "captureFinishedGeneratedImage",
  "Native image cards can expose a low-resolution or incomplete preview",
  "armGeneratedCapture",
  "MutationObserver",
  "minCapturedAt",
  "entry.source === source",
]) {
  assert(imageRelay.includes(required), `Native-generated image relay is missing: ${required}`);
}
assert(bridge.includes('"generated-icons"'), "The bridge cannot publish locally rendered transparent icons.");
assert(!bridge.includes('"AI UI Style References"'), "The bridge still publishes the removed UI reference screenshots.");

assert(!/\.zs-style-(?:count|grid|opt|name|meta)/.test(overlay), "Removed UI-theme selector CSS remains.");
assert(overlay.includes("will-change: transform;"), "Startup spinner is missing its transform hint.");
assert(overlay.includes("#zs-root .zs-spin {"), "Startup spinner reduced-motion exception is missing.");
assert(overlay.includes("animation-iteration-count: infinite !important;"), "Startup spinner can be frozen by reduced-motion rules.");

const blenderSetup = read("BLENDER-SETUP.txt");
const blenderInstaller = read("install-blender-mcp-addon.bat");
const robloxAnimationAddon = path.join(root, "Roblox Animations Add-on");
assert(blenderSetup.includes('Blender MCP Add-on\\blender_mcp.py'), "Blender setup guide does not identify the bundled add-on.");
assert(blenderSetup.includes("add-on protocol handshake succeeds"), "Blender setup does not explain verified readiness.");
assert(
  blenderSetup.includes("Import is intentionally destructive") &&
    blenderSetup.includes("everything in the current"),
  "Blender setup does not warn about destructive rig import.",
);
assert(blenderSetup.includes("Blender-Animations-ultimate-edition"), "Blender setup omits the required Roblox animation plugin.");
assert(blenderSetup.includes('Roblox Animations Add-on\\'), "Blender setup omits the extracted Roblox animation add-on.");
assert(existsSync(path.join(robloxAnimationAddon, "__init__.py")), "Extracted Roblox animation add-on entry point is missing.");
assert(existsSync(path.join(robloxAnimationAddon, "blender_manifest.toml")), "Extracted Roblox animation add-on manifest is missing.");
const robloxAnimationManifest = read("Roblox Animations Add-on/blender_manifest.toml");
for (const required of [
  'id = "roblox_animations_importer_exporter"',
  'version = "2.6.3"',
  'blender_version_min = "4.2.0"',
  '"SPDX:GPL-3.0-or-later"',
]) {
  assert(robloxAnimationManifest.includes(required), `Extracted Roblox animation add-on manifest drifted: ${required}`);
}
const extractedAnimationFiles = recursiveFiles(robloxAnimationAddon);
assert(extractedAnimationFiles.length === 36, `Expected 36 extracted Roblox animation add-on files, found ${extractedAnimationFiles.length}.`);
assert(
  !extractedAnimationFiles.some((file) => /(?:__MACOSX|\.DS_Store|[\\/]\._)/i.test(file)),
  "macOS metadata was bundled in the extracted Roblox animation add-on.",
);
assert(blenderInstaller.includes('Blender MCP Add-on\\blender_mcp.py'), "Blender installer does not install the bundled add-on.");
assert(blenderInstaller.includes('copy /y "%ADDON_SOURCE%"'), "Blender installer does not copy the exact bundled add-on.");
assert(!/install-addon/i.test(blenderInstaller), "Blender installer still downloads a different add-on.");
assert(!existsSync(path.join(root, "update-blender-addon.bat")), "The stale Blender updater filename is still packaged.");
assert(!existsSync(path.join(root, "HANDOFF.md")), "Internal handoff notes are still packaged.");
const runtimeStateDir = path.join(root, ".viewcoder");
assert(
  !existsSync(runtimeStateDir) || recursiveFiles(runtimeStateDir).length === 0,
  "Local ViewCoder project history or runtime state is still packaged.",
);

for (const stale of [
  "Roblox Rig Library/RthroMannequin.fbx",
  "Roblox Rig Library/RthroSlenderMannequin.fbx",
  "Roblox Rig Library/Lola.fbx",
  "Roblox Rig Library/ClassicMannequin.fbx",
  "Roblox Rig Library/Rig_and_Attachments_Template.fbx",
  "Roblox Rig Library/R6.rbxmx",
  "ViewCoder Extension/icons/ui/blender.png",
]) {
  assert(!existsSync(path.join(root, stale)), `Stale release asset is still packaged: ${stale}`);
}

const bundledChecksums = new Map([
  ["Blender MCP Add-on/blender_mcp.py", "60E7C1C086EBC0C3DFCD8318434C72CFB98E93ABFCBD9B8A42427538E3A11046"],
  ["Roblox Rig Library/BlockyCharacter.fbx", "3BCE4F161BC9B3825D4580E756C0A2DA3B737CFBFF1C2D41F47405AABE32803A"],
  ["ViewCoder Extension/icons/ui/blender.webp", "8D60A8524691DE086109A27585632E1ED4165A852C913D55CDBFB7D6E936110A"],
  ["add-on-roblox-animations-importer-exporter-v2.6.3.zip", "218B5E43E414FE3FA5D8A42CC5FD162B70E66F4CB82EFD73AC5006B63895769A"],
  ["Roblox Animations Add-on/blender_manifest.toml", "3923AC57BAE5B63306F5AC95B94D90FBDEFDF90F3C2CDD6B8BA64BAC9211FD48"],
  ["Roblox Animations Add-on/__init__.py", "FA700EAD67F387415741D11EA57C48F2B9CE8747F89175779EBB829F5213B58D"],
  ["ROBLOX-ANIMATIONS-ADDON-GPL-3.0.txt", "3972DC9744F6499F0F9B2DBF76696F2AE7AD8AF9B23DDE66D6AF86C9DFB36986"],
]);
for (const [relative, expected] of bundledChecksums) {
  const full = path.join(root, relative);
  assert(existsSync(full), `Bundled publishable dependency is missing: ${relative}`);
  const data = readFileSync(full);
  const actual = createHash("sha256").update(data).digest("hex").toUpperCase();
  assert(actual === expected, `Bundled dependency hash changed: ${relative}`);
}
assert(!existsSync(path.join(root, "AI UI Style References")), "The removed AI UI Style References folder is still packaged.");
for (const relative of [
  "Blender MCP Add-on/LICENSE",
  "Blender MCP Add-on/TERMS_AND_CONDITIONS.md",
  "Blender MCP Add-on/README.txt",
  "BETA-NOTICE.txt",
  "BLENDER-SETUP.txt",
  "ROBLOX-ANIMATIONS-ADDON-GPL-3.0.txt",
  "Roblox Rig Library/SOURCES.md",
  "Roblox Rig Library/ROBLOX-CREATOR-DOCS-LICENSE.txt",
]) {
  assert(existsSync(path.join(root, relative)), `Bundled attribution is missing: ${relative}`);
}

const jsFiles = recursiveFiles(root).filter((file) => /\.(?:js|mjs)$/.test(file));
for (const file of jsFiles) {
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert(check.status === 0, `JavaScript syntax check failed for ${path.relative(root, file)}:\n${check.stderr}`);
}

const longLuaCheck = spawnSync(
  process.execPath,
  [path.join(root, "tests/parser-long-lua.test.mjs")],
  { encoding: "utf8" },
);
assert(
  longLuaCheck.status === 0,
  `Long-Lua parser regression failed:\n${longLuaCheck.stdout}\n${longLuaCheck.stderr}`,
);

const commandBoundaryCheck = spawnSync(
  process.execPath,
  [path.join(root, "tests/parser-command-boundary.test.mjs")],
  { encoding: "utf8" },
);
assert(
  commandBoundaryCheck.status === 0,
  `Command-boundary parser regression failed:\n${commandBoundaryCheck.stdout}\n${commandBoundaryCheck.stderr}`,
);

const commandGatewayCheck = spawnSync(
  process.execPath,
  [path.join(root, "tests/command-gateway.test.mjs")],
  { encoding: "utf8" },
);
assert(
  commandGatewayCheck.status === 0,
  `Cross-provider command gateway regression failed:\n${commandGatewayCheck.stdout}\n${commandGatewayCheck.stderr}`,
);

const animationRigCheck = spawnSync(
  process.execPath,
  [path.join(root, "tests/animation-rig.test.mjs")],
  { encoding: "utf8" },
);
assert(
  animationRigCheck.status === 0,
  `Animation rig regression failed:\n${animationRigCheck.stdout}\n${animationRigCheck.stderr}`,
);

console.log(`Release checks passed (${jsFiles.length} JavaScript files).`);

function read(relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

function recursiveFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === ".git" ||
      entry.name === "data" ||
      entry.name === ".viewcoder" ||
      entry.name.startsWith(".codex-")
    ) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...recursiveFiles(file));
    else result.push(file);
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
