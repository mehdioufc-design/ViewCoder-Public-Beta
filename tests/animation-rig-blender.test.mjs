import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildRobloxRigScript } from "../animation-rig.mjs";

const blender = process.env.VIEWCODER_BLENDER_EXE ||
  "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe";
const temporary = mkdtempSync(path.join(os.tmpdir(), "viewcoder-rig-test-"));

try {
  const source = buildRobloxRigScript();
  const verification = `
rig = bpy.data.objects.get("ViewCoder_Animation_Rig")
if rig is None or rig.type != 'ARMATURE':
    raise RuntimeError("ViewCoder test could not find the imported armature.")
meshes = [obj for obj in bpy.data.objects if obj.type == 'MESH']
if len(meshes) != 15:
    raise RuntimeError(f"Expected 15 deforming body meshes, found {len(meshes)}.")
if len(rig.data.bones) != 51:
    raise RuntimeError(f"Expected the supplied 51-bone armature, found {len(rig.data.bones)} bones.")
if rig.show_in_front:
    raise RuntimeError("The animation armature is still drawn through the body as a stick figure.")
if not rig.hide_get() or not rig.hide_render or not rig.get("viewcoder_armature_hidden"):
    raise RuntimeError("The animation armature is still visible in the normal Blender viewport.")
if rig.select_get():
    raise RuntimeError("The hidden armature remained selected after the body was framed.")
pose_bone = rig.pose.bones.get("Head") or next(iter(rig.pose.bones), None)
if pose_bone is None:
    raise RuntimeError("The hidden armature has no pose bones available for animation.")
pose_bone.rotation_mode = 'XYZ'
pose_bone.rotation_euler.x = 0.1
pose_bone.keyframe_insert(data_path="rotation_euler", frame=1)
if rig.animation_data is None or rig.animation_data.action is None:
    raise RuntimeError("The hidden armature could not receive animation keyframes.")
if any(not obj.name.endswith('_Geo') for obj in meshes):
    raise RuntimeError("Cage or attachment helper meshes survived the clean import.")
if any(obj.type in {'CAMERA', 'LIGHT'} for obj in bpy.data.objects):
    raise RuntimeError("The original Blender camera or light survived the destructive reset.")
if bpy.data.workspaces.get("Animation") is None:
    raise RuntimeError("The Animation workspace was not prepared.")
minimum, maximum = world_bounds(meshes)
if abs((minimum.x + maximum.x) / 2.0) > 0.001 or abs((minimum.y + maximum.y) / 2.0) > 0.001 or abs(minimum.z) > 0.001:
    raise RuntimeError(f"Rig is not centered and grounded at world origin: {minimum}, {maximum}")
if not rig.get("viewcoder_scene_reset") or not rig.get("viewcoder_animation_workspace") or not rig.get("viewcoder_centered_at_origin"):
    raise RuntimeError("The imported rig is missing destructive/origin/workspace verification tags.")
if rig.get("viewcoder_source_file") != "BlockyCharacter.fbx":
    raise RuntimeError("The importer did not use the supplied BlockyCharacter.fbx.")
print("VIEWCODER_BLENDER_RIG_TEST:BLOCKY:15:51:OK")
`;
  const scriptPath = path.join(temporary, "blocky-character.py");
  writeFileSync(scriptPath, source + verification, "utf8");
  const result = spawnSync(
    blender,
    ["--background", "--factory-startup", "--python", scriptPath],
    { encoding: "utf8", timeout: 120_000 },
  );
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  assert.equal(result.status, 0, `BlockyCharacter Blender import failed:\n${output}`);
  assert.match(output, /VIEWCODER_RIG_IMPORTED:ViewCoder_Animation_Rig:R15:Official:Blocky Character:15:51:1:bundled:BlockyCharacter\.fbx/);
  assert.match(output, /VIEWCODER_BLENDER_RIG_TEST:BLOCKY:15:51:OK/);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

console.log("Live Blender supplied-rig destructive import test passed.");
