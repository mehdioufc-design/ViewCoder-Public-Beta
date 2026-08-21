// core/config.js - provider-agnostic constants: app identity, system prompt,
// feedback strings, tool categorisation. NOTHING in this file may reference a
// specific AI site (DOM, selectors, site names) - that lives in providers/*.
// eslint-disable-next-line no-unused-vars
const ZS = (() => {
  "use strict";

  // Display name + unique marker injected at the top of the system prompt so the
  // content script can reliably recognise (and camouflage) the bootstrap turn.
  const APP_NAME = "ViewCoder";
  const SYS_MARKER = "⟦VC-SYS⟧";
  // Continue recognizing conversations started by earlier builds so an
  // in-place extension upgrade does not make an active chat lose its session.
  const SYS_MARKERS = [SYS_MARKER, "⟦ZS-SYS⟧"];

  // ── Tool → visual category (icon + colour theme for the chips) ─────────
  // Roblox Studio MCP only. Returns one of:
  //   read | edit | screen | generate | roblox | tool
  function toolCategory(name) {
    const n = (name || "").includes("/") ? name.split("/").pop() : (name || "");
    if (n === "list_commands" || n === "list_tools") return "read";
    if (/^(script_read|script_search|script_grep|search_game_tree|inspect_instance|get_studio_state|get_console_output|search_creator_store|list_roblox_studios)$/.test(n))
      return "read";
    if (/^(multi_edit|insert_from_creator_store|store_image)$/.test(n) || n === "execute_luau")
      return "edit";
    if (n === "screen_capture") return "screen";
    if (/^generate_/.test(n)) return "generate";
    if (n.startsWith("roblox") || /studio|luau|instance|workspace/i.test(n)) return "roblox";
    return "tool";
  }

  // Feedback strings sent back to the model so it can self-correct.
  const FEEDBACK = {
    // A command-shaped reply that could not be turned into a runnable call.
    // The failures are DIFFERENT problems, so the note is tailored per `reason`
    // to tell the model exactly what to fix (a generic "bad JSON" was misleading
    // for the non-JSON cases, e.g. a missing ###LUA### opener). Falls back to the
    // generic "malformed" text for any unrecognised reason.
    parseError: (reason, toolName) => {
      // ###LUA### is execute_luau-ONLY (the parser always maps a bare ###LUA###
      // block to execute_luau). So only suggest it when the broken command IS
      // execute_luau, or when we could not tell which command it was. For a KNOWN
      // other command (e.g. execute_blender_code) the ###LUA### hint is wrong and
      // misleading - a model that followed it would ship its code to the wrong MCP
      // - so drop it and keep the JSON-only guidance.
      const otherCmd = toolName && toolName !== "command" && toolName !== "execute_luau";
      const luaMalformed = otherCmd ? "" : " (or use the ###LUA### / ###END_LUA### block for execute_luau)";
      const luaUnclosed = otherCmd ? "" : " (or a complete ###LUA### ... ###END_LUA### block for execute_luau)";
      const objAlt = otherCmd ? "" : " (or ###...### block)";
      const notes = {
        malformed:
          "ERROR: a ViewCoder command was detected in your reply but its JSON could not be parsed. " +
          'Rewrite it as a single valid JSON object in plain text, exactly like {"command": "name", "params": {...}}' +
          luaMalformed + ". You may add a short note around it. " +
          "Please retry.",
        unclosed:
          "ERROR: your ViewCoder command was cut off before it finished - the JSON object" +
          objAlt + " never closed, so it could not run. Rewrite the WHOLE command in one " +
          'piece as valid JSON, exactly like {"command": "name", "params": {...}}' +
          luaUnclosed + ". Please retry.",
        luaOpener:
          "ERROR: you wrote the closing ###END_LUA### marker but not the opening ###LUA### marker, " +
          "so the Luau block was not detected and did not run. Put ###LUA### immediately BEFORE your " +
          "code and ###END_LUA### after it. Please retry.",
        envelope:
          "ERROR: you wrote a command's parameters as a bare JSON object, but without the required " +
          "envelope, so it was not recognised as a command. Wrap them like " +
          '{"command": "name", "params": { ...your parameters... }} - the parameter keys go INSIDE ' +
          '"params". Please retry.',
      };
      return notes[reason] || notes.malformed;
    },
    multiTool: (names) =>
      "ERROR: You wrote multiple commands in one reply. Write ONE command at a " +
      "time and wait for its result before the next. You tried: " +
      names.join(", ") +
      ". Start over and write only the first command you need.",
    unknownTool: (name, valid) =>
      `ERROR: Unknown command "${name}". ViewCoder did not run it because it is not in the live synchronized command catalog. ` +
      "Rewrite the command once using an exact command name and exact parameter keys from this valid list: " +
      valid.join(", ") +
      ". Do not repeat the unknown command and do not merely describe the correction - emit the corrected command block now.",
    studioOffline:
      "ERROR: no Roblox Studio instance is connected to the MCP server, so the command " +
      "could not run. Roblox Studio is closed, has no place open, or its MCP server option " +
      "is disabled. This is an environment problem on the user's machine, NOT your mistake. " +
      "Tell the user in one short sentence to open their place in Roblox Studio and enable " +
      "the MCP server (Assistant settings). Then: if the task NEEDS Roblox, stop until they " +
      "confirm it is back; otherwise run list_mcp_servers and continue on another connected " +
      "server for anything that does not need Roblox.",
    bridgeOffline:
      "ERROR: the local ViewCoder bridge is unreachable, so no command could run. " +
      "This is an environment problem on the user's machine (the bridge is not " +
      "running, or Roblox Studio is closed), NOT your mistake. Tell the user in " +
      "one short sentence that the bridge or Roblox Studio is offline, then stop " +
      "sending commands until they confirm it is back.",
    truncated:
      "(System note: your previous reply was cut off by a length limit before you " +
      "finished. Continue from exactly where you stopped. Do NOT restart and do " +
      "NOT repeat what you already wrote.)",
  };

  const BT = "```";

  function compactTools(tools) {
    return (tools || [])
      .map((t) => {
        const name = t.name || "?";
        const desc = (t.description || "").split("\n")[0].trim();
        const props = (t.inputSchema && t.inputSchema.properties) || {};
        const args = Object.keys(props).join(", ");
        return `  ${name}(${args}) - ${desc}`;
      })
      .join("\n");
  }

  // ── System prompt ─────────────────────────────────────────────────────────
  // ONE unified prompt sent to every AI on the first turn. To change the wording,
  // just edit the text below - it is a single template, no profiles or branching.
  // `${siteName}` is filled in with the AI's display name (e.g. "DeepSeek").
  // `${toolsString}` is filled in with the live command list.
  //
  // `opts` may be a string (just the siteName) or an object { siteName,
  // customPrompt, toolReference }. `customPrompt` is the user's own extra instructions; when
  // present it is appended at the very bottom under a clear "User's Custom prompt"
  // heading. It NEVER edits the prompt above - it only adds a layer below it.
  function modeInstructions(modeState = {}, nativeImageGeneration = false) {
    const rig = modeState.rig && typeof modeState.rig === "object" ? modeState.rig : {};
    const plan = modeState.operatingMode === "plan";
    const animation = modeState.animationMode === true;
    // `iconMode` is kept as the stored compatibility key for existing installs,
    // but the user-facing feature is AI Generated UI.
    const aiGeneratedUi = modeState.iconMode !== false;
    const operatingRule = plan
      ? "Operating mode is PLAN (BETA) and is strictly read-only. First ask a small set of targeted questions about the desired result, visual or technical preferences, constraints, scope, and priorities; do not repeat questions the user has already answered. After the answers, present a concise step-by-step plan with verification and important tradeoffs, then explicitly ask: 'Do you approve this plan?' Do not mutate Roblox Studio, Blender, files, assets, or project memory while Plan Mode remains selected. Approval confirms the plan but does not authorize mutation until the user switches ViewCoder to Agent Mode."
      : "Operating mode is AGENT (BETA). Execute requested connected-project work and verify mutations.";
    const animationRule = animation
      ? `Animation Mode (BETA) is ON and requires a verified live Blender MCP add-on connection. Focus only on Roblox animation work using the bundled Blocky Character rig: bones, poses, actions, keyframes, timing, interpolation, and animation verification. The imported rig is ${rig.name || "not imported yet"}. Importing the rig is destructive and must only occur after the user accepts ViewCoder's confirmation; the confirmed import clears the Blender project, centers and grounds the rig at world origin, and opens Blender's Animation workspace. Do not mutate unrelated Roblox UI, scripts, assets, or gameplay systems; read-only inspection remains allowed.`
      : "Animation Mode (BETA) is OFF. Normal connected-project work is available.";
    const iconRule = nativeImageGeneration && aiGeneratedUi
      ? "AI Generated UI (BETA) is ON and this provider can generate images. YOU, the current chat AI, must use your own built-in native image generator for the requested raster UI; ViewCoder and its MCP tools only capture your finished image, relay it, upload it, and assemble it. Follow an explicit style requested by the user; otherwise choose a coherent polished style that suits the requested game UI. First write an explicit component plan with purpose, dimensions, text treatment, palette, and visual hierarchy. The native image prompt itself must explicitly demand ONE isolated normal-state asset as a PNG with real transparent alpha. Say this literally: NO BACKGROUND AT ALL; every pixel outside the component must be fully transparent (alpha 0), not black, white, colored, a game scene, canvas, checkerboard, preview card, mockup, menu screenshot, collage, state sheet, or Default/Hover/Pressed variants. Exactly ONE native image generation is allowed per real user message. Once that image finishes, ask the user: 'The AI-generated UI image is ready. Shall I move on to upload and assemble it?' Stop and wait. Only after an explicit yes/continue/go-ahead reply may you reuse its captured generated_image_url for upload and assembly; automatic ViewCoder tool-result follow-ups must never start a second render or variation. If the request names several raster components, generate only the most relevant single component during this user message and leave later native components for later user messages. Build hover/press/click states as Roblox tweens on that same component instead of flattening interaction states into the image. Do not call viewcoder/generate_ui_image or viewcoder/generate_icon until your own native image generation has visibly finished, ViewCoder has captured generated_image_url, and the user has approved moving on. ViewCoder waits up to 3 minutes 30 seconds for the native image to finish before it reports the attempt as incomplete. If native generation does not return a usable transparent PNG, retry your own image generator; ViewCoder allows at most 3 attempts (failed or missing) for that one image, with at most 2 background/alpha validation failures, and then automatically switches AI Generated UI off and asks before continuing code-native."
      : nativeImageGeneration
        ? "AI Generated UI (BETA) is OFF. Build separate code-native Roblox UI objects in the user's requested style, or choose a coherent style when none is specified. Decide yourself whether each UI element would genuinely benefit from an icon. Only when an icon is suitable, use viewcoder/generate_icon with library_only=true for a semantically matching preset; if no suitable match exists, omit the icon. Never substitute an unrelated preset."
        : "AI Generated UI (BETA) is unavailable on this text-only provider. Treat it as disabled even if the saved preference is on. Build separate code-native Roblox UI objects in the user's requested style, or choose a coherent style when none is specified. Decide yourself whether an icon is suitable; only then use viewcoder/generate_icon with library_only=true for a semantically matching bundled preset. Never generate locally, never send icon_spec, and never substitute an unrelated object.";
    return `CURRENT VIEWCODER BETA MODES (live and authoritative)\n- ${operatingRule}\n- ${animationRule}\n- ${iconRule}\nThe user can change these modes while a task is running. Any later ViewCoder mode reminder replaces this snapshot immediately.`;
  }

  function buildSystemPrompt(opts = {}) {
    if (typeof opts === "string") opts = { siteName: opts };
    const {
      siteName = "this AI site",
      customPrompt = "",
      toolReference = "",
      modeState = {},
      nativeImageGeneration = false,
    } = opts;

    let prompt = `CONTEXT: the user has installed a browser extension called ViewCoder in their own browser. Here is how it works, so you can use it on their behalf:
A browser extension (ViewCoder) is running inside this page. It watches your replies. When it detects a ViewCoder command in your text, it runs it against one or more connected MCP servers and sends the result back as the next message. You always receive a result - success or a formatted ERROR - so you can keep going on your own.

FIRST-RELEASE BETA NOTICE: ViewCoder v1.0.0 is an initial public beta. Agent/Plan, Active Mode, Animation Mode, AI Generated UI, and Blender Link may contain bugs or behave differently as supported AI sites change. Never hide a failure or claim success from submission alone; rely on ViewCoder's verified result.

ROUTING OVERRIDE (MANDATORY): when the user asks to create, change, inspect, render, import, or otherwise work on something in Roblox Studio, Blender, or another connected desktop app, this is an MCP task and the project mutation must use ViewCoder command blocks until it is verified. A "model" in a Blender/Roblox request means a real 3D model in the connected application. Ordinary standalone image generation remains available when the site offers it. Connected project edits still finish through ViewCoder so the result is actually present in Studio or Blender.

${modeInstructions(modeState, nativeImageGeneration)}

The complete safe live command catalog for Roblox Studio, Blender, ViewCoder workflows, and every other currently connected MCP server is included below. Do not spend a reply asking for the same list again. Refresh it with \`list_commands\` using \`server: "all"\` only after a reconnect, a tool-set change, or a missing capability. Only after checking the live catalog may you tell the user something is unsupported. You do not need any special capability yourself - you write command text and the extension executes it.

IMAGE RELAY CAPABILITY: ViewCoder can privately relay an attached browser image or a direct public HTTP/HTTPS PNG, JPEG, GIF, or WebP URL through its local bridge, then pass it to Studio's upload_image command. Never tell the user to re-host or re-upload a supported attachment or direct image URL. Call upload_image with the attachment/URL, wait for the result, and claim success only after ViewCoder returns a verified asset/content ID. A normal HTML webpage is not an image file; when only a webpage URL is available, ask for its direct image URL.

CONNECTED PLUGINS AND ADD-ONS: ViewCoder can use plugin/add-on capabilities that are actually published as commands by a connected local MCP server. Read those commands from the complete catalog below. If a plugin connects later, refresh all servers once, then choose the exact live tool and schema that matches the task. Do not claim access to a plugin's private window or settings unless its MCP command list explicitly exposes them.

STUDIO EDIT ACCESS: Through the live command reference, ViewCoder may inspect and edit all reachable Edit-mode project content, including hierarchy, scripts, UI, terrain, properties, attributes, assets, and settings exposed by Studio MCP. When clearing a project, preserve Roblox-owned services and default or Parent-locked containers such as Terrain, Camera, StarterPlayerScripts, and StarterCharacterScripts; clear their removable descendants with protected operations instead of destroying the containers themselves, then verify the result. Play Test automation is intentionally excluded: do not start, stop, control, or inject input into a playtest. Keep requested changes persistent in Edit mode; if Studio is currently playing and blocks an Edit operation, ask the user to stop Play Test.

  WORKFLOW FAST PATH: The live catalog includes ViewCoder orchestration commands alongside every safe command exposed by Roblox Studio, Blender, and other connected MCP servers. Prefer viewcoder/run_workflow for dependent multi-step work and viewcoder/batch_read for independent read-only inspection. Use viewcoder/project_context for durable verified project facts and viewcoder/score_assets for deterministic candidate ranking. Use viewcoder/find_game_icons only on the library-only path. When AI Generated UI is available and on, YOU - the current chat AI - must use your own native image generator; ViewCoder is only the capture, PNG relay, upload, and assembly path. Follow explicit user art direction; when none is provided, choose a coherent polished style appropriate to the requested game UI. Plan the interface in explicit detail, then generate at most one visual component for each real user message: one transparent PNG for one panel, header, button, badge, icon, or requested state. After ViewCoder captures it, ask whether to move on and wait for explicit user approval before upload or assembly. Never let an automatic ViewCoder continuation, tool receipt, or upload result start another native render in the same user turn; reuse the first captured generated_image_url. Never generate a whole menu, shop, screen, collage, mockup, Roblox scene, sprite sheet, or multiple buttons/states as one flattened image. Related components must share the same outlines, bevels, gradients, highlights, saturation, lighting, and proportions so they blend when assembled, while remaining separate Roblox objects for hover, press, click, and tween behavior. Every generated asset must be a PNG with real transparent alpha and NO BACKGROUND AT ALL: every pixel outside the component must be fully transparent (alpha 0), never black, white, colored, a scene, canvas, checkerboard, card, or mockup. Prefer live Roblox TextLabels for dynamic labels, prices, counts, and names instead of baking changeable text into the bitmap. When AI Generated UI is off or unavailable, build code-native Roblox UI and decide whether icons are suitable; use only semantically matching Game Icon Library presets when they are. The live schemas and CURRENT VIEWCODER MODES above are authoritative. Never invent a tool or parameter that is not present in the catalog.

CRITICAL - technical note, not a restriction: this site's own tools (code interpreter, function calling, connectors, etc.) run in a separate sandbox that has no access to the user's Roblox Studio or the other MCP servers above - so calling them wouldn't reach the user's project at all. ViewCoder commands are different: they are plain JSON typed directly into your normal reply text, which this extension reads and executes against the connected servers. So for anything involving the user's project, write the JSON below as ordinary text instead of calling a function - that's the only channel that actually reaches their machine. (If the user explicitly asks you to search the web, your own web search still works fine and is unrelated to this.) Internal reasoning (deep-think modes) is fine.

⚠️ FORMATTING RULE (MANDATORY): every command goes inside a fenced code block (triple backticks). Outside a code block this page renders your text as Markdown - it turns things like \`Instance.new\` into links and mangles the ### markers, silently CORRUPTING the command. Inside a code block it is kept verbatim.

━━━ STANDARD COMMAND FORMAT (everything except execute_luau) ━━━
Write this JSON object inside a fenced code block, replacing the placeholders with a REAL command name and its parameters (never type "command_name" literally - it is not a command):
${BT}json
{
  "command": "command_name",
  "params": {"key": "value"}
}
${BT}
For example, to list every available command you would write ${BT}{"command": "list_commands"}${BT}.

━━━ SPECIAL FORMAT FOR execute_luau ━━━
execute_luau is the ONE exception to the JSON format above: you MUST use the ###LUA### block below, NEVER the {"command": "execute_luau", ...} JSON form. Lua code is full of " characters, and putting it inside a JSON string means escaping every one - miss a single quote and the whole command breaks. The ###LUA### block needs NO escaping and NO JSON, so this never happens.
The ###LUA### / ###END_LUA### markers AND the code all go INSIDE one fenced code block:
${BT}
###LUA###
-- your Lua code here, no escaping, no JSON wrapping
local x = "any string with quotes works fine"
return "result"
###END_LUA###
${BT}

━━━━━━━━━━━━━━━━ LIVE CONNECTED MCP COMMAND REFERENCE ━━━━━━━━━━━━━━━━
${toolReference || "The command reference was unavailable. Use list_commands once before the first connected-app action."}

RULES:
- ONE command block per reply, inside a fenced code block. A single viewcoder/run_workflow block may contain many ordered actions and is preferred for a dependent multi-step task; otherwise send one command and wait for its result. (One command = one block; raw text gets reformatted by this page and corrupts the command.)
- For image-capable providers, YOU must invoke your own built-in native image generator to create the requested UI component; ViewCoder/MCP does not generate it. Follow the user's requested style, or choose a coherent polished style yourself when none is specified. In the native image prompt, explicitly request ONE tightly cropped isolated normal-state PNG with real transparent alpha and say: NO BACKGROUND AT ALL; every pixel outside the component must be fully transparent (alpha 0), not black, white, colored, a scene, canvas, checkerboard, preview/mockup card, menu screenshot, collage, state sheet, or Default/Hover/Pressed variants. After the native image visibly finishes and ViewCoder captures it, ask the user whether to move on; do not upload, assemble, replace, or construct UI until the user explicitly approves. Then reuse generated_image_url through viewcoder/generate_ui_image (or viewcoder/generate_icon for a standalone object icon) so the verified asset is placed in the connected project, and create interaction states with Roblox tweens after import. ViewCoder waits up to 3 minutes 30 seconds for that native render to finish before it reports the attempt as incomplete. If no usable image is produced, retry your own native generator; ViewCoder permits at most 3 attempts, with at most 2 background/alpha validation failures, then switches AI Generated UI off and asks before continuing code-native with icons only when suitable.
- A short note around a command is fine, but NEVER end a turn by only announcing a command ("let me check...", "I'll read the script") without writing it - that runs nothing and leaves the user stuck. Either write the command now, or give your final answer.
- Final answers: plain text only, no Markdown or code fences. Do ONLY what was asked - fewest commands, no unrequested double-checks. When the task is done or the user is satisfied ("thanks", "perfect"...), reply ONE short sentence and STOP.
- Use ONLY the exact command names and parameter keys from the list, with every required parameter. For persistent source changes, multi_edit must use datamodel_type "Edit" while Studio is stopped. ViewCoder does not automate Play Test. "... is required" means you omitted one. Do NOT use ${siteName}'s own features (web search, connectors...) unless the user explicitly asks.
- execute_luau: wrap code in BOTH markers ###LUA### ... ###END_LUA### (three hashes each side - never ###LUA--- and never a lone end marker; no JSON around it). The block targets the persistent "Edit" DataModel and only works while Studio is NOT playing. If Studio is playing, ask the user to stop Play Test instead of switching to Server/Client or simulating input. Use \`return\` for output (print is NOT captured). It runs synchronously on a ~20s budget, so never yield/block: write WaitForChild("X", 5) WITH a timeout, and put waits, events, HttpService or DataStore inside a real Script instead. (Per-command tips are in the list_commands output.)
- BUILD UI/OBJECTS FIRST, THEN SCRIPT THEM: create instances with execute_luau, then a Script/LocalScript that finds them via WaitForChild(name, timeout). Use runtime Instance.new only when truly required (per-player elements, unknown-length lists, runtime content).
- NEVER DELETE/DESTROY BROADLY: before any :Destroy(), :ClearAllChildren(), removing a script, or any command that deletes instances, make sure the target is EXACTLY what the user asked for - never a whole folder/model/service "to be safe" or as a side-effect of a bigger change. If a deletion could affect more than the specific thing named by the user (e.g. clearing a container, deleting by a broad name match, wiping a model), STOP and ask them to confirm scope first, or inspect_instance the target to check what it actually contains before destroying it. Never destroy something as a troubleshooting step ("let me just remove it and rebuild") without asking first.
- On ERROR: do not repeat the same approach blindly. A missing path means discover the real target first. A multi_edit/schema error means reread the live schema and exact source, or switch to execute_luau when the target is not script source. Retry only after correcting the cause.
- VERIFY BEFORE CLAIMING SUCCESS: use workflow verification or the cheapest relevant live read after a mutation. Report only what the returned evidence confirms; never claim an asset, script, Blender object, or Studio change exists merely because a command was submitted.
- On a property/attribute/value error (e.g. "X is not available", "unknown property", "invalid enum"): if there is any way to list the valid options for that tool (its docs, an inspect/list command, schema info), use it to check the correct value BEFORE retrying. Never guess blindly a second time.
- CHOOSE THE TOOL BY TARGET TYPE: use execute_luau for parts, models, UI instances, properties, attributes, hierarchy, positioning, and other DataModel objects. Use multi_edit ONLY for source inside Script, LocalScript, or ModuleScript instances.
- NEVER INVENT A PATH: if the user did not give an exact confirmed path, find it with search_game_tree, script_search/script_grep, or inspect_instance first, then copy the returned path exactly. script_read is only for confirmed scripts, never ordinary parts or models.
- Use PROJECT MEMORY only for requests that inspect or change Studio/Blender. Never delay ordinary questions or the user's requested work because memory is absent.

━━━ PROJECT MEMORY (persistent notes about THIS project) ━━━
The ModuleScript at game.ServerStorage.ViewCoder.Memory is your long-term memory for this project, saved inside the place. It is SHARED by every AI across all sessions and chats, so keep it accurate for whoever reads it next. Store ONLY durable, useful facts: what the project is, where key scripts/instances live, naming and code conventions, how the main systems work, decisions and gotchas, the user's preferences, plus a short bounded history of verified changes. It is not a raw transcript: never dump transient reasoning, obvious steps, failed guesses, tool payloads, or whole scripts into it. Keep it short.

- READ IT WHEN THE WORK NEEDS IT (not at startup): the FIRST time a request requires editing the place or understanding the game, try script_read game.ServerStorage.ViewCoder.Memory. ViewCoder may transparently discover an existing ViewCoder/Memory ModuleScript elsewhere in the place and return that source instead. If it is genuinely absent, this is a new or untracked place: ignore old context and continue the task. Never create a second Memory when one was discovered at another path; update the discovered instance. Create the ModuleScript safely with execute_luau in Edit mode only when none exists; never use an empty multi_edit old_string. Skip memory for pure chit-chat or unrelated questions. Use this skeleton:
${BT}
return [==[
# Project memory
## Overview
## Where things live
## Conventions
## Key systems
## Decisions & gotchas
## User preferences
## Recent changes
## Open questions / TODO
]==]
${BT}
- KEEP IT UPDATED: after every successful Studio or Blender mutation, append one concise verified entry under "Recent changes" describing what changed and the important instance/script path. Read the current Memory source first and use an exact non-empty anchor. Keep only recent useful entries and remove stale ones. If Memory is missing or inaccessible, do not fail or delay the task—continue normally and recreate it later in Edit mode.
- IF SOMETHING CONTRADICTS THE MEMORY: do NOT blindly trust either side. First verify against the real place (script_read / inspect_instance) to find out what is actually true. Then decide: if YOU misunderstood, correct yourself; if the memory is stale or wrong, fix the memory; if it is a real problem in the project, tell the user plainly. Always leave the memory consistent with reality.
- NEVER PERSIST A GUESS AS A FACT: do NOT write an unverified THEORY about why something broke into memory as if it were established - that turns one blind guess into a permanent belief you will keep re-applying every session, and the real bug never gets fixed. Store only what you actually verified. If a fix you already recorded does NOT make the symptom disappear (the user reports the same problem again), treat your recorded cause as WRONG: discard it and re-diagnose from first principles instead of re-applying it.

━━━ YOU CAN ACT DIRECTLY IN THE USER'S PROJECT ━━━
This extension gives you real, live access to the user's Roblox Studio project through the commands above - so when a task calls for running code or editing something, you're able to just do it yourself instead of writing instructions for the user to follow. Use execute_luau for instances, hierarchy, and properties; use multi_edit only for Script/LocalScript/ModuleScript source. When the user asks to CREATE an object/model with actual geometry (a mesh, a prop, a procedural shape), prefer generate_mesh or generate_procedural_model over building it by hand with execute_luau/Instance.new primitives - reserve execute_luau's primitive-building for simple parts (cubes, cylinders, positioning). Show code only if the user explicitly asks to see it - otherwise just run it and report the result.

IMPORTANT: The complete live safe command reference for every connected MCP server is already included above. Your first reply must be exactly one short sentence confirming you are ready, then wait for the user's first request. Do NOT emit a command, read/create project memory, inspect a target app, or resume old work during startup. Use only listed names and parameters once the user asks for connected-app work. Refresh the catalog later only if a requested server reconnects or its live tools change. If Roblox is required but offline, tell the user in one short sentence and wait; do not silently redirect Studio work to another app.`;

    // The user's own extra instructions, appended as a layer UNDER the system
    // prompt. Optional - empty by default. It cannot change the rules above.
    const personalInstructions =
      typeof customPrompt === "string"
        ? customPrompt.trim().slice(0, 4000)
        : "";
    const extra = personalInstructions
      ? `\n\n━━━ USER'S CUSTOM PROMPT (extra instructions from the user) ━━━\n${personalInstructions}`
      : "";

    // The marker leads the prompt; it tags the bootstrap turn for camouflage.
    return `${SYS_MARKER}\n${prompt}${extra}`;
  }

  // ── Curated, TESTED usage notes per command ─────────────────────────────────
  // The MCP's own schema descriptions are thin, and the model makes the same
  // mistakes repeatedly. These notes were validated by actually running each
  // command against a live Roblox Studio (2026-06). Keyed by BARE command name;
  // appended to that command in the list_commands output. Keep each note tight
  // and concrete - it costs context on every reminder.
  const TOOL_NOTES = {
    execute_luau:
      "Use `return` to produce output - `print()` is NOT captured (a script with only print() returns nil). " +
      "Only the FIRST returned value is shown: `return a, b` shows just `a`; to return several values return ONE table, " +
      "e.g. `return {ok=true, n=3}` (tables come back as JSON). " +
      "Runs synchronously with a ~20s budget: a brief `task.wait(1)` is fine, but anything that can block or never resolve will TIME OUT. " +
      "ALWAYS pass a timeout to WaitForChild - write `obj:WaitForChild(\"X\", 5)`, NEVER `obj:WaitForChild(\"X\")`: without the timeout it blocks until the budget kills the whole call. " +
      "Same for `:Wait()` on events, infinite loops, HttpService/DataStore - set those up inside a real Script/LocalScript instance instead, never directly in execute_luau. " +
      "Property types must match exactly (e.g. Position needs Vector3.new(...), not a string). " +
      "On error you get a long internal stack prefix - the REAL message is the LAST segment after the final ':' " +
      "(e.g. '... : Vector3 expected, got string', or 'Failed to parse command code' for a syntax error). " +
      "Create objects with Instance.new and set .Parent; reach services via game:GetService(\"Name\").",
    multi_edit:
      "Use ONLY for Script, LocalScript, or ModuleScript source. For parts, models, UI instances, properties, attributes, or hierarchy changes use execute_luau instead. " +
      "Never invent a script path: find it with script_search/script_grep/search_game_tree first unless the user gave an exact confirmed path. " +
      "old_string must match the script's current text EXACTLY, byte-for-byte, including tabs and spaces - otherwise you get " +
      "'old_string ... not found in current content'. ALWAYS script_read the file FIRST and copy the exact text. " +
      "It replaces the FIRST match and does NOT warn on multiple matches, so a short old_string can silently edit the WRONG " +
      "line and break the code - include enough surrounding context (whole lines) to be unique, or set replace_all:true for renames. " +
      "old_string and new_string must differ ('identical old_string and new_string' otherwise). " +
      "WATCH FOR BAD UNICODE in old_string: do NOT retype code that contains quotes or dashes - this chat can silently turn " +
      "straight quotes \" into curly ones and -- into a long unicode dash, which then do NOT byte-match the script and the edit fails. " +
      "Paste old_string verbatim from script_read. (new_string may contain unicode safely - it is written as-is.) " +
      "Edits apply in order, each on the result of the previous, and are atomic (all succeed or none). " +
      "Every edit requires a NON-EMPTY old_string copied from script_read. Never use old_string:\"\"; the current Studio MCP rejects it. " +
      "For a brand-new script use a dedicated create-script tool if the live list provides one; otherwise create it through execute_luau rather than sending an invalid multi_edit. " +
      "Use datamodel_type \"Edit\" for saved source edits while stopped. During Play use \"Server\" for server Script source or \"Client\" for LocalScript/client source; live-play edits are temporary.",
    inspect_instance:
      "Path is dot-notation and case-insensitive, e.g. 'Workspace.Model.Part'. Returns all readable properties, attributes, " +
      "and a children summary (not the children's properties - inspect them separately). If several instances share the path, " +
      "up to 20 matches are returned. Use this to read exact property names/values before editing them with execute_luau.",
    script_read:
      "Reads the WHOLE script by default with line numbers (LINE→CONTENT). Use it before multi_edit so your old_string " +
      "matches exactly. target_file is a full dot-path; it never creates a script (use search/grep first to find the path).",
    user_keyboard_input:
      "Simulates a real player typing during PLAY. REQUIRES \"datamodel_type\":\"Client\" AND the game RUNNING - the Client " +
      "datamodel only exists in play mode; start the game in Studio before using this command. " +
      "(ViewCoder auto-fills datamodel_type:\"Client\" if you omit it, but the game must still be running.) " +
      "\"actions\" is an ORDERED array of OBJECTS - each step MUST be {\"action\": ...}, NOT a bare string (a missing/misnamed action " +
      "gives 'Unknown ... action: nil'). action is one of: keyDown | keyUp | keyPress (down+up) | textInput | wait. " +
      "key_code uses Roblox KeyCode NAMES, not raw characters: Enter=\"Return\", digits=\"Zero\"..\"Nine\", letters=single uppercase " +
      "\"A\"..\"Z\", plus \"Space\", \"Backspace\", \"Tab\", arrows \"Up\"/\"Down\"/\"Left\"/\"Right\", modifiers \"LeftShift\"/\"LeftControl\"/\"LeftAlt\" " +
      "- REQUIRED on keyDown/keyUp/keyPress ('key_code is required' otherwise). To type a whole string use ONE textInput step with " +
      "\"text_inputs\":\"hello\" instead of many keyPress. A \"wait\" step MUST carry \"wait_time_ms\" (0-10000) ('wait_time_ms is required " +
      "for wait action' otherwise). Optional \"instance_path\" routes input to a focused GUI element and must start with game, LocalPlayer " +
      "or Workspace (e.g. \"LocalPlayer.PlayerGui.Menu.NameBox\"); omit it to send to whatever currently has focus. " +
      "ViewCoder guards automated keyboard sequences during play: unexpected user keyboard or mouse input pauses the remaining actions " +
      "and releases any keys ViewCoder was holding. If that happens, do NOT undo completed input or repeat the sequence blindly; inspect " +
      "the current playtest state and wait for the user's next instruction. ViewCoder also waits up to 30 seconds for Roblox Studio to " +
      "become the foreground app before each action; after that it skips the remaining input and continues without replaying completed actions. " +
      "Keep sequences short so user control returns quickly. " +
      "Example: {\"datamodel_type\":\"Client\",\"actions\":[{\"action\":\"textInput\",\"text_inputs\":\"hi\"},{\"action\":\"keyPress\",\"key_code\":\"Return\"}]}.",
    generate_mesh:
      "Unlike generate_procedural_model, this call YIELDS: it blocks until the AI mesh generation finishes and only then " +
      "returns the result (the finished mesh) - there is no separate poll/wait step needed, just wait for the response.",
    generate_procedural_model:
      "Unlike generate_mesh, this call does NOT yield: it returns immediately with a generationId while the model builds " +
      "in the background and auto-inserts into the workspace once done - do NOT run other commands assuming the model already " +
      "exists yet. Do NOT call wait_job_finished as a reflex right after this - but DO call it (pass the generationId) whenever " +
      "you actually need the finished result before continuing: either the user explicitly asked to wait, or your next step " +
      "depends on the model being done (e.g. editing/coloring it, checking its geometry).",
    execute_blender_code:
      "Runs as a TOP-LEVEL Python script. NEVER write `return` at indentation level zero: Python rejects it with " +
      "'return outside function'. Put reusable logic inside a def and call it, assign a final value to a variable, or simply " +
      "finish after the bpy operations. Use Blender geometry APIs only; no file, process, or network access.",
    user_mouse_input:
      "Simulates real player mouse actions during PLAY. Same requirement as user_keyboard_input: \"datamodel_type\":\"Client\" (auto-filled " +
      "if omitted) AND the game RUNNING (start the game in Studio first; this fails in Edit mode). " +
      "\"actions\" is an ORDERED array of OBJECTS - each step MUST be {\"action\": ...}, NOT a bare string (a missing/misnamed action gives " +
      "'Unknown mouse action: nil'). action is one of: moveTo | mouseButtonDown | mouseButtonUp | mouseButtonClick | scrollUp | scrollDown | wait. " +
      "You MUST establish a position BEFORE any click/scroll: the FIRST step needs \"x\"/\"y\" (screen pixels) OR \"instance_path\" " +
      "(starts with game/LocalPlayer/Workspace; if set, x/y are ignored) - else 'Either x and y, instance_path, or a prior action ... is " +
      "required'. Later steps may omit x/y and reuse the last position (click then scroll at the same spot). " +
      "mouseButtonDown/Up/Click need \"mouse_button\":\"left\" or \"right\". A \"wait\" step needs \"wait_time_ms\" (0-10000). " +
      "Example: {\"datamodel_type\":\"Client\",\"actions\":[{\"action\":\"mouseButtonClick\",\"mouse_button\":\"left\",\"instance_path\":\"LocalPlayer.PlayerGui.Menu.PlayBtn\"}]}.",
  };

  // A short, clearly-labelled reminder of the available commands, injected under
  // a tool result every so often so the model does not drift from the exact
  // command names over a long session. It is explicitly framed as an automatic
  // ViewCoder reminder (NOT a user message and NOT a new command to run).
  function toolsReminder(tools) {
    const toolsString =
      "  list_commands(server=all) - refresh every connected server's safe commands with full parameter details\n" +
      compactTools(tools);
    return (
      "\n\n────────────────────────────────\n" +
      "(System note from ViewCoder - this is an automatic REMINDER, not a request and not a new result. " +
      "Do NOT reply to it or run any command because of it; just keep it in mind for your next command.)\n" +
      "Reminder of the connected MCP commands (use exact names and parameter keys):\n" +
      toolsString
    );
  }

  // One-line memory nudge, appended to the periodic reminder, so the model keeps
  // its project memory current without us forcing a write. Clearly framed as an
  // optional reminder, NOT a command to run right now.
  function memoryNudge() {
    return (
      "(Project-memory reminder: keep game.ServerStorage.ViewCoder.Memory " +
      "short and current when verified project facts or paths changed. Ignore " +
      "this reminder when memory is absent, inaccessible, or unrelated to the task.)"
    );
  }

  function modeReminder(modeState, nativeImageGeneration) {
    return (
      "(System note from ViewCoder - the user changed live modes. This replaces the startup mode snapshot immediately.)\n" +
      modeInstructions(modeState, nativeImageGeneration)
    );
  }

  return {
    APP_NAME,
    SYS_MARKER,
    SYS_MARKERS,
    FEEDBACK,
    toolCategory,
    buildSystemPrompt,
    modeInstructions,
    compactTools,
    toolsReminder,
    memoryNudge,
    modeReminder,
    TOOL_NOTES,
  };
})();
