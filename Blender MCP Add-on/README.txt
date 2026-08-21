BLENDER MCP ADD-ON BUNDLED WITH VIEWCODER
=========================================

This folder contains the Blender-side add-on used by ViewCoder:

  blender_mcp.py

Upstream project:
  https://github.com/ahujasid/blender-mcp

The add-on is by Siddharth Ahuja / BlenderMCP and is distributed under the MIT
License included in this folder. Read TERMS_AND_CONDITIONS.md for the upstream
telemetry and privacy terms. ViewCoder launches the companion MCP server with
DISABLE_TELEMETRY=true, but you should also review the telemetry preference in
Blender's add-on settings before starting the server.

Install it by running install-blender-mcp-addon.bat from the main ViewCoder
folder.
That installer copies this exact bundled file into the newest Blender user
version on this Windows account. It does not download a different add-on and
does not make a backup copy.

Bundled file verification:
  blender_mcp.py SHA-256
  60E7C1C086EBC0C3DFCD8318434C72CFB98E93ABFCBD9B8A42427538E3A11046

The ViewCoder bridge requires add-on protocol version 4 and does not report
Blender as connected until get_addon_status completes a real live handshake.
