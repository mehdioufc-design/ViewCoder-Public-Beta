import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ASSET_ROOT = path.join(MODULE_DIRECTORY, "Roblox Rig Library");
const RIG_SOURCE_FILE = "BlockyCharacter.fbx";

// Animation Mode intentionally has one deterministic rig. Keeping the legacy
// receipt fields lets older extension state migrate without exposing obsolete
// R6/R15 or preset selectors in the UI.
export const ROBLOX_RIG_OPTIONS = Object.freeze({
  singleRig: true,
  rigType: "R15",
  bodyShape: "Official",
  preset: "Blocky Character",
  sourceFile: RIG_SOURCE_FILE,
  destructiveImport: true,
  centersAtOrigin: true,
  opensAnimationWorkspace: true,
  beta: true,
});

export function normalizeRobloxRigOptions() {
  return {
    rigType: "R15",
    bodyShape: "Official",
    preset: "Blocky Character",
  };
}

function py(value) {
  return JSON.stringify(String(value));
}

export function buildRobloxRigScript(_rawOptions = {}, assetRoot = DEFAULT_ASSET_ROOT) {
  const { rigType, bodyShape, preset } = normalizeRobloxRigOptions();

  return `import bpy
import os
from mathutils import Vector

RIG_TYPE = ${py(rigType)}
BODY_SHAPE = ${py(bodyShape)}
PRESET = ${py(preset)}
SOURCE_FILE = ${py(RIG_SOURCE_FILE)}
ASSET_ROOT = ${py(path.resolve(assetRoot))}
RIG_NAME = "ViewCoder_Animation_Rig"
STANDARD_PARTS = (
    "Head", "UpperTorso", "LowerTorso",
    "LeftUpperArm", "LeftLowerArm", "LeftHand",
    "RightUpperArm", "RightLowerArm", "RightHand",
    "LeftUpperLeg", "LeftLowerLeg", "LeftFoot",
    "RightUpperLeg", "RightLowerLeg", "RightFoot",
)

def reset_blender_project():
    active = bpy.context.object
    if active is not None and active.mode != 'OBJECT':
        try:
            bpy.ops.object.mode_set(mode='OBJECT')
        except Exception:
            pass
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    for other in list(bpy.data.scenes):
        if other != scene:
            bpy.data.scenes.remove(other)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)
    for blocks in (
        bpy.data.meshes, bpy.data.armatures, bpy.data.curves,
        bpy.data.cameras, bpy.data.lights, bpy.data.materials, bpy.data.actions,
    ):
        for block in list(blocks):
            if block.users == 0:
                blocks.remove(block)
    scene.cursor.location = (0.0, 0.0, 0.0)
    scene.frame_start = 1
    scene.frame_end = 240
    scene.frame_set(1)
    if len(bpy.data.objects) != 0:
        raise RuntimeError("Blender project reset was incomplete; the rig was not imported.")

def switch_to_animation_workspace():
    workspace = bpy.data.workspaces.get("Animation")
    if workspace is None:
        current = bpy.context.workspace
        if current is None:
            raise RuntimeError("Blender's Animation workspace is unavailable.")
        current.name = "Animation"
        workspace = current
    if bpy.app.background:
        return True
    active_window = bpy.context.window
    windows = list(bpy.context.window_manager.windows)
    if active_window is not None:
        active_window.workspace = workspace
    for window in windows:
        if window == active_window:
            continue
        try:
            window.workspace = workspace
        except Exception:
            pass
    if active_window is not None and active_window.workspace == workspace:
        return True
    if any(window.workspace == workspace for window in windows):
        return True
    raise RuntimeError("Blender did not switch to the Animation workspace.")

def import_fbx(file_path):
    if not os.path.isfile(file_path):
        raise RuntimeError(f"Bundled Roblox animation rig is missing: {file_path}")
    before = set(bpy.data.objects)
    if hasattr(bpy.ops.wm, "fbx_import"):
        bpy.ops.wm.fbx_import(filepath=file_path)
    else:
        bpy.ops.import_scene.fbx(filepath=file_path)
    return [obj for obj in bpy.data.objects if obj not in before]

def remove_object(obj):
    if obj and obj.name in bpy.data.objects:
        bpy.data.objects.remove(obj, do_unlink=True)

def relink(obj, collection):
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    collection.objects.link(obj)

def world_bounds(meshes):
    points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    if not points:
        raise RuntimeError("The imported animation rig has no visible body meshes.")
    return (
        Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points))),
        Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points))),
    )

def center_and_ground(collection, rig, meshes):
    bpy.context.view_layer.update()
    minimum, maximum = world_bounds(meshes)
    offset = Vector((-(minimum.x + maximum.x) / 2.0, -(minimum.y + maximum.y) / 2.0, -minimum.z))
    members = set(collection.objects)
    for obj in collection.objects:
        if obj.parent not in members:
            obj.location += offset
    bpy.context.view_layer.update()
    minimum, maximum = world_bounds(meshes)
    if not (
        abs((minimum.x + maximum.x) / 2.0) <= 0.001 and
        abs((minimum.y + maximum.y) / 2.0) <= 0.001 and
        abs(minimum.z) <= 0.001
    ):
        raise RuntimeError("The animation rig could not be centered and grounded at world origin.")
    bpy.context.scene.cursor.location = (0.0, 0.0, 0.0)
    rig["viewcoder_centered_at_origin"] = True

def frame_rig(collection, rig):
    bpy.ops.object.select_all(action='DESELECT')
    for obj in collection.objects:
        obj.hide_set(False)
        obj.hide_viewport = False
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    framed = bpy.app.background
    window = bpy.context.window
    screen = window.screen if window else bpy.context.screen
    if screen:
        for area in screen.areas:
            if area.type != 'VIEW_3D':
                continue
            region = next((region for region in area.regions if region.type == 'WINDOW'), None)
            if region is None:
                continue
            try:
                with bpy.context.temp_override(window=window, screen=screen, area=area, region=region):
                    bpy.ops.view3d.view_selected(use_all_regions=False)
                framed = True
            except Exception:
                pass
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    if not framed:
        raise RuntimeError("Blender could not frame the imported rig in the Animation workspace.")
    return True

reset_blender_project()
animation_workspace = switch_to_animation_workspace()
source_path = os.path.join(ASSET_ROOT, SOURCE_FILE)
imported = import_fbx(source_path)
armatures = [obj for obj in imported if obj.type == 'ARMATURE']
if not armatures:
    raise RuntimeError("The bundled animation rig contains no armature.")
rig = max(armatures, key=lambda obj: len(obj.data.bones))

body_by_part = {
    obj.name[:-4]: obj
    for obj in imported
    if obj.type == 'MESH' and obj.name.endswith('_Geo')
}
missing_parts = [name for name in STANDARD_PARTS if name not in body_by_part]
if missing_parts:
    raise RuntimeError(f"The bundled animation rig is incomplete: {', '.join(missing_parts)}")
body_meshes = [body_by_part[name] for name in STANDARD_PARTS]
required_bones = set(STANDARD_PARTS) | {"Root", "HumanoidRootNode"}
missing_bones = sorted(required_bones - {bone.name for bone in rig.data.bones})
if missing_bones:
    raise RuntimeError(f"The bundled animation armature is incomplete: {', '.join(missing_bones)}")
if len(rig.data.bones) < 51:
    raise RuntimeError(f"The bundled animation armature has only {len(rig.data.bones)} bones; expected at least 51.")

# Keep the deforming body and its armature only. Cage and attachment helper
# meshes are authoring metadata and would clutter the user's animation scene.
keep = {rig, *body_meshes}
for obj in imported:
    if obj not in keep:
        remove_object(obj)

collection = bpy.data.collections.new(RIG_NAME)
bpy.context.scene.collection.children.link(collection)
rig.name = RIG_NAME
rig.data.name = f"{RIG_NAME}_Armature"
relink(rig, collection)
for mesh in body_meshes:
    relink(mesh, collection)

rig["viewcoder_animation_mode"] = True
rig["viewcoder_roblox_rig"] = True
rig["viewcoder_source_file"] = SOURCE_FILE
rig["viewcoder_rig_type"] = RIG_TYPE
rig["viewcoder_body_shape"] = BODY_SHAPE
rig["viewcoder_rig_preset"] = PRESET
rig["viewcoder_scene_reset"] = True
rig["viewcoder_animation_workspace"] = True
# Keep the complete deforming armature for animation/export, but do not draw its
# octahedral bones through the character mesh. The previous X-ray setting made
# the armature look like an unwanted stick figure inside the Roblox body.
rig.show_in_front = False
rig.data.display_type = 'OCTAHEDRAL'

center_and_ground(collection, rig, body_meshes)
viewport_framed = frame_rig(collection, rig)
# Keep the 51-bone armature available to ViewCoder and Blender's animation data,
# but hide the orange octahedral stick figure from the normal viewport after the
# complete character has been framed. The visible body meshes remain selected.
bpy.ops.object.select_all(action='DESELECT')
for mesh in body_meshes:
    mesh.select_set(True)
bpy.context.view_layer.objects.active = body_meshes[0]
rig.hide_set(True)
rig.hide_render = True
rig["viewcoder_armature_hidden"] = True
if not animation_workspace:
    raise RuntimeError("Blender did not prepare the Animation workspace.")

print(
    f"VIEWCODER_RIG_IMPORTED:{rig.name}:{RIG_TYPE}:{BODY_SHAPE}:{PRESET}:"
    f"{len(body_meshes)}:{len(rig.data.bones)}:{int(viewport_framed)}:bundled:{SOURCE_FILE}"
)
`;
}
