# Changelog

## v1.0.0 — First Public Beta

- Added one provider-independent command gateway for every supported AI. A complete rendered JSON, VC-CMD, Lua, or legacy command block now immediately uses ViewCoder's existing activity-card lifecycle; before bridge dispatch, its exact command name is checked against the live synchronized catalog. An invented command is shown as `Unknown command`, is never executed, and receives one automatic correction request before the bounded retry guard stops a loop.
- Adopted ZeroScript's proven activity-card lifecycle for DeepSeek, Gemini, Kimi, Z.ai/GLM, Qwen, and LMSYS Arena without changing ViewCoder's card design or placement. Those providers now pre-hide internal turns before paint, fully reclassify each host mutation, and repair cards every 1.5 seconds through scroll, streaming, and virtualized re-renders. Meta AI, ChatGPT, and Claude retain their existing ViewCoder-specific lifecycle.
- Repaired DeepSeek's current response markup: code-block toolbar labels (`json`, `Copy`, and `Download`) can no longer contaminate a valid Roblox or Blender command. Every supported AI now has a clean rendered-`pre` command fallback, and DeepSeek's ViewCoder row fits the composer's rounded top edge without changing the other providers' positioning.
- Repaired both 43-second watchdog paths. Retryable bridge timeout/running replies are removed from the pending race instead of becoming permanent winners, so the same idempotent Studio/Blender request is reclaimed up to eight times. Each deadline now force-releases a stale native Stop state instead of only showing a notice. A provider card that starts but produces no real text or reasoning progress for 43 seconds is stopped, verified idle, and continued with the existing safe system note without repeating the completed command. One-shot MV3 alarms wake both deadlines in hidden tabs, so Active Mode follows the same behavior even when Chrome throttles page timers.
- Synchronized the universal Working cover to each provider's live composer height. Multiline hidden text and attachment rows now grow or shrink the gray replacement and the real prompt card together instead of leaving the cover at its initial one-line height.
- Limited AI Generated UI to one native image per real user message. The first validated transparent PNG is cached for that user turn and reused by upload/tool-result follow-ups; duplicate Enter/click send events and internal continuation prompts can no longer start a second variation.
- Made completed command-result delivery acknowledgement-based across every supported AI. ViewCoder no longer treats an invoked Send click or Enter key as proof that the provider accepted the hidden result; it requires a cleared composer or a newly landed user turn, then retries the same completed result after the bounded delay without rerunning the Studio/Blender command. An off-DOM consumed-command guard prevents long-chat remounts from repeating `inspect_instance` or any other tool.
- Restored the complete gray prompt-bar cover for long hidden results. ViewCoder tracks the real provider composer while covered, so JSON/Luau stays behind the overlay while genuine multiline drafts and attachment previews remain synchronized with it.
- Enforced AI Generated UI output at relay time. Opaque screenshots, scenes, full shop/menu mockups, and files with only an accidental transparent edge pixel are rejected; validation failures can no longer fall back to the original opaque image, so the AI retries a single PNG component with real alpha.
- Reduced native AI Generated UI retries to 3 total attempts and at most 2 background/alpha validation failures. Every generation instruction now says `NO BACKGROUND AT ALL` and requires fully transparent alpha-0 pixels outside the component. Successful captures and exhausted fallbacks pause before the next step and ask the user whether to continue.
- Fixed the empty-chat startup regression introduced by the idle-send lock. ChatGPT's new-chat shell spinner is no longer mistaken for an active assistant turn, so the unchanged ViewCoder startup prompt begins immediately while real in-progress replies remain protected.
- Replaced the four-second automatic-send race with a provider-neutral idle-send transaction. ViewCoder now waits until the current AI has genuinely released its Send/Stop control before writing any tool result, honors a visibly finished native PNG over stale provider busy markers, and never requires the user to press Stop to release a completed image.
- Made automatic follow-ups draft-safe on every supported AI. If the real prompt bar already contains user text, ViewCoder preserves and restores it exactly; if a provider rejects an internal follow-up, the hidden ViewCoder text is cleared instead of being left in the composer or pausing the task on the next send.
- Expanded native-image lifecycle recognition to current creation phases such as `Preparing visual context`, `Sketching it out`, refinement, and almost-finished states for ChatGPT, Gemini, and Meta AI.
- Added separate native-image lifecycle detectors for ChatGPT, Gemini, and Meta AI. ViewCoder now holds all automatic writing through provider-specific creation, polishing, and final-touch phases, then releases as soon as the finished image is capturable.
- Made AI Generated UI intent mode-aware for follow-ups such as “make it AI generated” and added a runtime mutation guard: while native artwork is required, code-native Roblox UI calls cannot bypass the enabled mode.
- Kept an in-flight `execute_luau` activity card attached by the provider's stable assistant-turn identity even while ChatGPT temporarily replaces its CodeMirror body, and made a settled final prose answer immediately clear the Stop button and Working cover despite stale provider loading nodes.
- Kept Agent/Plan in its compact status-bar selector and moved Refresh Connection, verified Blender Link, Active Mode, Animation Mode, AI Generated UI, and the Roblox rig choices into ViewCoder's in-chat AI/settings panel. They remain changeable before or during an active agent session, while the extension popup stays focused on Studio and Blender connection health.
- Added compact provider symbols beside every supported AI in the in-chat chooser and reduced the Agent/Plan menu typography so the selector no longer overwhelms the status bar.
- Replaced the multi-preset rig selector with one Import Rig action that imports only the supplied `BlockyCharacter.fbx`. The importer validates its 51-bone armature and 15 deforming body meshes, removes cage/attachment helpers, centers and grounds the rig, opens Blender's Animation workspace, and frames the complete character.
- Added up to eight safe automatic tool receipt retries exactly 43 seconds apart after a completed command is detected. Every recovery request reuses the original command identity, so lost Roblox, image-upload, Blender, or other MCP results are reclaimed without repeating a mutation. If the receipt card completes but the AI composer rejects its hidden follow-up, ViewCoder also retries result delivery without rerunning the command.
- Added a separate 43-second assistant-start watchdog for results the AI composer already accepted. If the provider fails to begin its next reply, ViewCoder sends a compact continuation nudge up to eight times while preserving the completed result and never re-running the Roblox or Blender command.
- Kept live and settled activity cards mounted through long-chat provider virtualization and assistant-node replacement, including standalone ChatGPT JSON commands rendered without wrapper markers.
- Removed the packaged UI-reference attachment step and its activity card. AI Generated UI now goes directly from the user's request to the selected chat AI's native image generator, avoiding reference-upload and composer-submission overhead.
- Kept the full 51-bone animation armature for keyframes/export while hiding it from the normal viewport after framing the visible body, so the imported Roblox character no longer shows the orange stick figure.
- Fixed Agent/Plan menu text containment and made the settings-panel Discord icon identical to the centered status-bar icon.
- Added a live Agent/Plan selector to the existing in-chat ViewCoder bar. Agent executes and verifies supported changes; Plan asks targeted preference questions, presents a read-only plan, and asks for approval while mutations remain blocked until Agent is selected.
- Fixed false Blender readiness: an MCP launcher or open Blender process is no longer enough. ViewCoder now requires the live add-on `get_addon_status` protocol-4 handshake before it advertises Blender tools, enables Animation Mode, or reports Blender connected.
- Bundled the matching Blender MCP add-on, upstream MIT license and telemetry terms, a local no-download installer, and attributed/hash-verified Roblox reference rig files in the publishable package.
- Created two distinct visual assets: a new sharp black/dark-navy ViewCoder V/code logo for the brand and a separate faceted three-spark white/gray glyph used only by the Agent/Plan selector.
- Replaced Icon Mode with AI Generated UI. The selected image-capable chat AI itself uses its own native image generator, follows the user's requested style or chooses a coherent polished style when none is specified, waits up to 3 minutes 30 seconds for a native render to visibly finish, captures the finished output, relays it as PNG, and—after user approval—uploads and assembles each panel, header, button, tab, badge, icon, or requested state separately. Missing or unusable native output gets at most 3 attempts and at most 2 background/alpha validation failures before ViewCoder automatically switches AI Generated UI off and asks before continuing code-native. In code-native mode, the AI chooses whether a semantically matching Game Icon Library preset is suitable.
- Reworked the universal prompt-bar cover to replace each AI's complete native composer while ViewCoder owns it—including model selectors, attachments, tools, and send controls—using an exact provider-specific rounded-card target and sampled gray surface. The cover now says `ViewCoder Is Connecting...` during the initial link and `ViewCoder Is Working...` afterward, with three smoothly bouncing dots in both states; ViewCoder's own status row stays visible above it.
- Replaced the earlier idle-height clamp with live whole-composer measurement, so genuine text and attachment growth expands both the native prompt card and ViewCoder cover together.
- Lifted Claude's Base UI/CDS model, effort, settings, attachment, tooltip, and submenu portals above every ViewCoder surface, matching the existing popup-layer protection for ChatGPT, Gemini, Kimi, Qwen, GLM, DeepSeek, and Arena.
- Fixed long direct `###LUA###` execution on ChatGPT's current nested CodeMirror renderer by reconstructing `.cm-content > .cm-line` source, while retaining support for older direct line blocks and raw text nodes. Every fenced command source is now parsed independently before the combined Markdown reply, eliminating the renderer race that could expose `###END_LUA###` while dropping the opener. Closing-before-opening DOM reads still receive a four-second settle window, and complete late Lua/JSON commands are retried against both the original response node and the current turn before parse feedback, so they receive the normal execution UI.
- Kept completed ChatGPT `execute_luau` source hidden when scrolling rehydrates its CodeMirror block by carrying a Lua-only mask on the stable assistant turn. A targeted added-node observer now restores that mask before paint—even if ChatGPT replaces the assistant node—and completed Lua cards with injected results cannot briefly return to the working phase. A short bounded grace preserves the card during partial CodeMirror remount reads. Other tool cards and the expandable Lua result body are unchanged.
- Removed ChatGPT attachment suffixes, native image-generation cancellation, and the related warning popup.
- Added capture and local relay for finished native-generated assistant images, including provider-only file IDs and sandbox paths, so they can continue automatically through `viewcoder/generate_ui_image` or `viewcoder/generate_icon`.
- Forced AI-generated relay assets to PNG while preserving transparent alpha. Oversized generated PNGs are downscaled as PNG rather than silently converted to WebP.
- Added explicit component planning and strict one-component generation: whole menus/screens, collages, multiple buttons, backgrounds, and normal/hover/pressed state sheets are not accepted as one image.
- Excluded image-to-image tools with required `imagePaths` from text-to-image generator discovery and repaired guessed image arguments before strict `viewcoder/generate_icon` validation.
- Allowed the bridge to publish locally rasterized `icon_spec` PNGs as well as bundled library icons.
- Fixed `viewcoder/get_capabilities` so `server: "all"` returns the full live catalog, with the last native catalog retained through brief empty refreshes.
- Added project-clearing guidance that preserves Roblox-owned and Parent-locked default containers while removing their editable descendants.
- Fixed the bridge catalog race that could report zero tools while Roblox Studio or Blender was already connected.
- Tool discovery now waits for every live MCP catalog and preserves the last valid catalog during brief reconnects.
- Coalesced duplicate browser catalog requests to reduce synchronization load and prevent inconsistent readiness states.
- Kept the complete safe Studio command surface available, including image upload, script editing, state reads, asset search/insertion, Luau execution, and model, material, and mesh generation.
- Kept Play Test, console capture, character navigation, screenshot/capture, and simulated keyboard or mouse input outside ViewCoder's command surface.

- Added 327 user-supplied game UI icons, already unpacked and organized into seven searchable categories.
- Added `viewcoder/find_game_icons` with semantic-first selection, style/theme ranking, and secure loopback delivery; an unmatched concept now proceeds to exact generation instead of becoming an automatic blank slot.
- Retained the dependency-free `icon_spec` renderer for legacy direct bridge calls, while live text-based provider sessions now use only verified semantic library matches.
- Removed MCP image-generator discovery from the chat workflow. The current ChatGPT, Gemini, or Meta AI must use its own native generator, and ViewCoder tracks the bounded 3-attempt fallback across assistant turns.
- Removed the UI-theme selector and its stored prompt injection; the AI chooses the component palette and layout automatically, with explicit user style requests taking priority.
- Added catalog, PNG/reference integrity, one-component generation, no-random-substitution, provider-mode, live-mode, hidden-armature animation, package-integrity, and local-publishing tests.
- Simplified ViewCoder to two focused targets: Roblox Studio and Blender.
- Consolidated the activity settings into one reliable Active Mode.
- Removed the Penpot process, configuration, routes, UI, prompts, and setup files.
- Refreshed the popup with licensed Studio, Blender, activity, status, and provider icons and the new dedicated ViewCoder logo.
- Kept startup gating based on a fresh live target connection.
- Kept Play Test, screenshot/capture, and simulated keyboard or mouse input outside the command surface.
- Removed local `.viewcoder` project history from the public package and added a release gate that prevents machine-specific runtime state from being shipped.
- Added a short top-level quick-start guide and reserved public version slots through v1.6.9.

## v1.0.2

- Added a native ViewCoder workflow engine for up to 100 ordered Roblox Studio and Blender actions with references, conditions, retries, timeouts, rollback steps, verification, and structured reports.
- Added `viewcoder/batch_read` for parallel read-only MCP calls and `viewcoder/project_context` for persistent per-place notes, search, verified-change history, and dependency graphs.
- Added deterministic asset scoring and capability discovery so every supported AI can choose tools with less repeated inspection.
- Changed startup and long-chat guidance to include the complete safe live catalog from Roblox Studio, Blender, ViewCoder workflows, and connected plugin MCP servers.
- Added exact-schema validation and mutation safeguards; uncertain timed-out writes are not replayed unless a workflow explicitly marks them safe to retry.
- Kept Play Test, simulated keyboard/mouse input, and screenshot/capture tools outside ViewCoder's command surface.
- Added shared workflow guidance for ChatGPT, Claude, DeepSeek, Gemini, Kimi, Z.ai/GLM, Qwen, LMSYS Arena, and Meta AI.
- Added focused workflow tests and release guards for all-server discovery, safety filters, provider coverage, and v1.0.2 packaging.

## v1.0.1

- Added provider-specific Notice cards for ChatGPT, Gemini, and Kimi, plus a Beta notice for Claude, without changing ViewCoder's startup prompt or overlay positioning.
- Removed general beta-mode wording from the extension UI.
- Added persistent per-job result receipts so Studio and Blender results survive Manifest V3 service-worker restarts and transient polling failures.
- Added idempotent result recovery for `execute_luau`, Blender code, and other MCP actions without replaying successful mutations.
- Increased the live task lease grace period to tolerate browser background throttling while preserving single-chat ownership.
- Updated the bridge, extension, startup script, and package metadata to v1.0.1.

## Early development baseline

Initial public release of ViewCoder.

- Roblox Studio MCP bridge and verified command execution
- Chrome and Microsoft Edge Manifest V3 extension
- Support for nine major AI chat providers
- Provider-aware status UI and cross-provider navigation
- Attachment relay and verified Roblox image uploads
- Active Mode and single-owner session protection
- Optional Blender MCP connection and Roblox mesh handoff
- Project memory, duplicate prevention, and long-task recovery
