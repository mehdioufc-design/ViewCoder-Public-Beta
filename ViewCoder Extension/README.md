# ViewCoder v1.0.0

This is the first public beta. Read `..\BETA-NOTICE.txt` before using Agent/Plan,
Active Mode, Animation Mode, AI Generated UI, or Blender Link on important projects.

ViewCoder separately watches command receipt, result delivery, and the AI's next
reply. If a delivered tool result does not start a provider reply within 43
seconds, it sends a bounded continuation nudge without repeating the completed
Roblox or Blender command.

## Install in Edge or Chrome

1. Open `edge://extensions` or `chrome://extensions`.
2. Remove or reload any older **ViewCoder** entry.
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select this exact folder.

## Connect a workspace

1. Open a place in Roblox Studio.
2. Open **Assistant** → **…** → **Manage MCP Servers**.
3. Turn on **Enable Studio as MCP server**.
4. Double-click `start.bat` in the parent **ViewCoder Setup** folder.
5. Wait until the ViewCoder bar unlocks **Start agent**.

ViewCoder unlocks when the local bridge and at least one target pass a fresh
connection check. Roblox Studio and Blender work independently or together.
Supported providers:

- DeepSeek
- Google Gemini
- Kimi Chat
- Z.ai / GLM
- Qwen
- LMSYS Arena
- Meta AI
- ChatGPT
- Claude

Click the ViewCoder extension icon to see every provider. Selecting one opens
that AI directly in the current tab.

## Active Mode (Beta)

Active Mode is enabled from the extension popup. It keeps only the AI tab that
owns the current Studio task awake while you use another Chrome or Edge tab.
It does not switch tabs, steal focus, or allow a second chat to run against the
same Studio session. Turn it off if you want automatic follow-ups to wait until
you return to the AI tab.

ViewCoder privately hides its setup prompt, raw command JSON, and bridge
feedback. Only your normal request, the AI's normal response, a compact
provider-styled thinking/Studio status, and the finished action result remain
visible. Completed `viewcoder`, Lua, Luau, and Roblox code blocks are routed
through port 3000 to Roblox Studio's official MCP server. Identical successful
commands are not run twice for the same request.

The same Manifest V3 folder works in Microsoft Edge and Google Chrome. A compact
ViewCoder status bar sits just above the chat composer and includes the AI
switcher and Start agent control. Its colors adapt to each provider while
keeping ViewCoder's mint connection state. It automatically moves beneath login
or consent dialogs so it does not block model selectors or composer controls.

## Image attachments

PNG, JPEG, GIF, and WebP files selected, pasted, or dropped into any supported
AI chat are privately relayed through the local bridge. When the AI calls
Studio's `upload_image` command with a browser-only file path, ViewCoder replaces
it with the corresponding short-lived `127.0.0.1` URL automatically. Large
browser attachments are resized and compressed before relay when needed.

Direct public image URLs are supported too, including redirects from GitHub raw
content and Wikimedia. The local bridge downloads the image, validates its file
signature, and exposes only a short-lived loopback copy to Studio. Redirects are
revalidated and local, private, link-local, and reserved network destinations are
blocked. Browser attachments stay in memory, expire after 30 minutes, and are
never uploaded to a public host.

The upload activity card reports reading, preparation, upload, verification, and
ready states. ViewCoder only reports an image as ready after Studio returns a
verified Roblox asset/content ID.

## AI Generated UI (Beta)

On ChatGPT, Gemini, and Meta AI, the current chat AI itself uses its built-in
native image generator. It follows the user's requested style or chooses a
coherent polished style when none is specified. ViewCoder waits up to 3 minutes
30 seconds for the provider's native image card to visibly finish before it can
report that attempt as incomplete, then captures the transparent PNG. It requires
real transparent alpha with NO BACKGROUND AT ALL: pixels outside the component
must be fully transparent (alpha 0). It permits at most 3 unusable or missing
native generations and at most 2 background/alpha validation failures, then
automatically switches AI Generated UI off. After capture or fallback, it asks
before upload, assembly, or code-native construction. In off or unavailable mode, the AI
decides whether each element benefits from a semantically matching preset icon.

## Studio and plugin access

ViewCoder can inspect and change editable Studio project content exposed by the
official MCP server: hierarchy, scripts, UI, terrain, properties, attributes,
assets, and supported settings. This setup intentionally excludes Play Test
control and simulated player input; persistent work stays in Edit mode.

Connected plugins and add-ons are usable when they publish MCP commands. The AI
discovers their server and exact command descriptions before choosing one. A
plugin's private window or settings are not accessible unless that plugin
explicitly exposes them through its MCP tool list.

## Optional Blender connection

ViewCoder can keep Roblox Studio and Blender connected at the same time:

1. Install `uv` and the `ahujasid/blender-mcp` Blender add-on.
2. In Blender, open the BlenderMCP sidebar and start its server on port 9876.
3. Click the ViewCoder extension icon and choose **Connect Blender**.

The AI receives every live Blender MCP tool except screenshot/capture commands
only after that connection is live. It chooses
Blender from capabilities rather than prompt keywords, and uses ViewCoder's
Blender-to-Roblox handoff when custom mesh work belongs in the Studio place.

Animation Mode offers one Import Rig action and imports only the bundled Blocky
Character FBX. The import asks for confirmation because it deletes the current
Blender scene, opens the Animation workspace, and centers the rig at world origin. See
`..\BLENDER-SETUP.txt` for the bundled animation add-on and Roblox plugin.

## Popup icons

The popup uses selected icons from Free Icon Pack v3.1 (Basic), the supplied
Blender WebP, and ViewCoder's dedicated dark-blue brand logo. See
`THIRD-PARTY-ICONS.txt` in the parent setup folder for notices and attribution.
