# ViewCoder

ViewCoder connects supported AI chats to Roblox Studio and, optionally,
Blender. Describe what you want in the AI chat and ViewCoder carries supported
commands to the project open on your computer.

> **ViewCoder v1.0.0 is the first public beta.** Save important `.rbxl`,
> `.rbxlx`, and `.blend` projects before using automation. Read
> [BETA-NOTICE.txt](BETA-NOTICE.txt) before testing.

## Download

Download the ready-to-use ZIP from the
[v1.0.0 First Public Beta release](https://github.com/mehdioufc-design/ViewCoder-Public-Beta/releases/tag/v1.0.0).
Extract the whole ZIP before starting it.

## Quick setup

1. Install [Node.js 18 or newer](https://nodejs.org/).
2. Extract the complete ViewCoder ZIP.
3. For Roblox tools, enable **Studio as MCP server** in Roblox Studio.
4. Double-click `start.bat` and leave its terminal window open.
5. Open `chrome://extensions` or `edge://extensions` and enable **Developer mode**.
6. Choose **Load unpacked** and select the `ViewCoder Extension` folder.
7. Open a supported AI chat and click **Start ViewCoder**.

For the shortest offline instructions, open [QUICK-START.txt](QUICK-START.txt).
The same extension folder works in Chrome and Microsoft Edge.

## Supported AI chats

ChatGPT, Claude, DeepSeek, Google Gemini, Kimi, Z.ai/GLM, Qwen, LMSYS Arena,
and Meta AI.

## What is included

- Roblox Studio MCP workflows and long Luau command support
- Optional Blender MCP workflows
- Agent and read-only Plan modes
- Active Mode for work that continues while another browser tab is selected
- Animation Mode with the bundled Blocky Character rig
- AI Generated UI on supported image-capable chats
- A local library of 327 game UI icons for library-only providers
- Required browser extension, bridge, Blender add-ons, tests, and notices

All useful setup files are directly in the repository/package root. You do not
need to search through an installer folder.

## Optional Blender setup

Blender is not required for Roblox-only use. For Blender and Animation Mode,
follow [BLENDER-SETUP.txt](BLENDER-SETUP.txt). The matching Blender MCP add-on,
the Roblox Animations Importer/Exporter v2.6.3 ZIP, its extracted source, and
the supplied animation rig are included.

Animation Mode's **Import Rig** action asks for confirmation because it deletes
the current Blender scene before loading and framing the bundled rig.

## Important beta notes

- The bridge listens on `127.0.0.1` by default.
- Keep `start.bat`, the extension, and bridge files from the same release.
- Reload the unpacked extension and refresh open AI tabs after every update.
- AI and website layouts can change, so verify important work in Studio or Blender.
- AI Generated UI should create one isolated transparent PNG component at a time.
- Review [GAME-ICON-LIBRARY-NOTICE.txt](GAME-ICON-LIBRARY-NOTICE.txt) before
  redistributing or commercially using the supplied icon library.
- Bundled third-party add-ons retain their own licenses, permissions, and terms.

## Versions

Current release: **v1.0.0 — First Public Beta**.

Future empty version slots through v1.6.9 are listed in
[VERSIONS.md](VERSIONS.md). A slot does not promise a date or feature.

## Help and community

- Discord: https://discord.gg/VRcg7RBpV
- Donate Robux: https://www.roblox.com/users/8651250465/profile
- Changes: [CHANGELOG-v1.0.0.md](CHANGELOG-v1.0.0.md)
- Beta precautions: [BETA-NOTICE.txt](BETA-NOTICE.txt)

ViewCoder is provided as beta software without a guarantee that every future
AI website, Roblox Studio version, Blender version, or MCP interface will remain
compatible.
