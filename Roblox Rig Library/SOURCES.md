# Roblox animation rig source

ViewCoder Animation Mode imports only `BlockyCharacter.fbx`, supplied by the
ViewCoder maintainer for this release. The file contains one 51-bone Roblox R15
armature, 15 deforming `_Geo` body meshes, and authoring cage/attachment helpers.
ViewCoder keeps the armature and 15 deforming meshes and removes those helpers
from the animation scene.

Source reference pages:

- https://github.com/Roblox/creator-docs/blob/main/content/en-us/avatar/resources.md
- https://github.com/Roblox/creator-docs/blob/main/content/en-us/art/modeling/rig-a-humanoid-model.md

The Roblox Creator Docs repository license is included as
`ROBLOX-CREATOR-DOCS-LICENSE.txt`. Roblox and the Roblox logo are trademarks of
Roblox Corporation. ViewCoder is not affiliated with or endorsed by Roblox.

## Included release file and SHA-256

- `BlockyCharacter.fbx` — `3BCE4F161BC9B3825D4580E756C0A2DA3B737CFBFF1C2D41F47405AABE32803A`

Before the rig is imported, ViewCoder asks for confirmation because the import
clears the current Blender project. A confirmed import opens Blender's Animation
workspace, centers the body on X=0 and Y=0, grounds it at Z=0, selects the
armature, frames it, and prepares frames 1-240.
