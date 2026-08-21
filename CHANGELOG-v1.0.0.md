# Changelog

## v1.0.0 — First Public Beta

ViewCoder v1.0.0 is the first public beta. Major beta features may need updates
as supported AI websites, Roblox Studio, Blender, and their MCP interfaces
change.

- Fixed both durable 43-second recovery paths so their deadline performs the
  recovery action instead of only displaying a notice. ViewCoder now presses
  the AI site's native Stop control, verifies a stable released composer, and
  either reclaims the same idempotent command receipt or submits the existing
  safe continuation note without repeating completed Studio or Blender work.

- Added a universal command gateway across every supported AI. Complete
  rendered command blocks now become the existing ViewCoder activity card and
  are validated against the live synchronized catalog before bridge dispatch.
  Unknown commands are not executed: ViewCoder shows an Unknown command card,
  requests one corrected command automatically, and then stops instead of
  looping if the correction is still unknown.
- Synchronized the gray Working cover to the live height of every supported
  provider composer, including multiline drafts and attachment rows, so it
  continues to cover the whole prompt bar as that prompt bar grows or shrinks.
- Limited AI Generated UI to one successful native image per real user
  message. ViewCoder reuses that exact captured PNG for internal tool-result
  follow-ups instead of asking the AI to generate a second variation.
- Added the compact Agent/Plan Beta selector. Plan asks targeted questions,
  presents a read-only plan, and requests approval; Agent performs and verifies
  approved work.
- Added Active Mode Beta so the task-owning AI tab can continue while another
  tab is active without stealing focus.
- Added Animation Mode Beta with one Import Rig action using only the bundled
  Blocky Character FBX and its 51-bone, 15-body-part Roblox armature.
  Import requires explicit confirmation, deletes the current Blender project,
  opens the Animation workspace, centers the mannequin at world origin, and
  verifies the complete imported rig.
- Added AI Generated UI Beta, enabled by default on image-capable AIs. The
  selected chat AI itself uses its own native image generator, while ViewCoder
  handles capture, PNG relay, upload, and assembly. Each panel, header, button, tab,
  badge, icon, or interaction state is a separate PNG with real transparent alpha
  and no background at all for independent
  Roblox hover/click/tween behavior. The AI follows a requested style or chooses
  a coherent polished style when none is supplied. ViewCoder waits up to 3 minutes 30 seconds for a
  native render to visibly finish, retries missing or unusable native output up
  to 3 times (or 2 background/alpha validation failures), then automatically
  switches to code-native UI. After a successful capture or exhausted fallback,
  ViewCoder asks before moving to upload, assembly, or code-native construction.
- Added verified Blender Link Beta readiness through a live protocol-4 add-on
  handshake. Opening Blender alone is not treated as a connection.
- Exposed the complete live Blender MCP catalog dynamically except
  screenshot/screen-capture tools. Roblox Studio retains its separate safe
  Edit-mode catalog.
- Bundled the matching Blender MCP add-on, the original Roblox Animations
  Importer/Exporter v2.6.3 ZIP, required licenses/terms, standard Roblox rig
  sources, and setup instructions for the companion Roblox Studio plugin.
- Fixed long `###LUA### ... ###END_LUA###` extraction across supported AIs,
  including ChatGPT CodeMirror remounts, without replaying completed commands.
- Stabilized execute-Luau result cards so scrolling and virtualized message
  remounts do not make completed commands flicker back to working.
- Added up to eight safe automatic result-receipt retries, 43 seconds apart,
  for every tool. Every retry reuses the original request identity so a lost
  response cannot duplicate a Roblox or Blender mutation. Completed receipts
  also retry provider delivery when the AI composer does not accept the result.
- Added a second 43-second recovery gate after provider delivery. When the
  hidden result turn lands but the AI never starts replying, ViewCoder sends up
  to eight small continuation nudges and never repeats the completed command.
- Kept live Roblox and Blender activity cards attached while long-chat provider
  virtual lists replace the assistant message node.
- Fixed Agent/Plan menu text containment and made the settings-panel Discord
  icon match the centered status-bar action.
- Reworked the working/connecting cover to fit each provider's whole prompt bar
  while preserving model, attachment, and popup access when ViewCoder is idle.
- Removed ChatGPT image-generation cancellation, redirect warnings, and injected
  reference-image suffixes.
- Added native-generated image relay that converts generated assets to PNG and
  preserves transparent alpha. Full menus, screens, collages, several buttons,
  and multi-state sheets are rejected in favor of one component per image.
- Hid the retained Blender armature from the normal viewport after framing the
  visible body, while keeping all 51 bones available for animation/keyframes.
- Added compact Discord and Donate Robux actions. The optional Discord reminder
  is non-blocking, dismissible, limited to once every seven days, and never shown
  while ViewCoder is actively working.
- Fixed Animation Mode falsely rejecting a successful workspace switch when an
  auxiliary Blender window remained on another workspace; standard rig import
  now continues through validation in the active Animation workspace.
- Enlarged and optically centered the compact Discord status-bar icon.
- Added startup/version matching, catalog synchronization, workflow, parser,
  asset integrity, mode-policy, destructive-import, and clean-package checks.
- Removed local `.viewcoder` project history from the public package and added
  a release gate that prevents machine-specific runtime state from being shipped.
- Added a short top-level quick-start guide and reserved public version slots
  through v1.6.9.

See `BETA-NOTICE.txt` for risks and precautions.
