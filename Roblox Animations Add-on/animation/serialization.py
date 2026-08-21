"""
Animation serialization logic for exporting to Roblox format.
"""

import bpy
import re
import math
from typing import Dict, Set, List, Optional, Any, Tuple
from mathutils import Vector, Matrix
from ..core.constants import (
    get_transform_to_blender,
    identity_cf,
    cf_round,
    cf_round_fac,
)
from ..core.utils import (
    get_scene_fps,
    mat_to_cf,
    get_action_fcurves,
    get_animation_data_action_slot,
    to_matrix,
    iter_scene_objects,
)
from .easing import map_blender_to_roblox_easing
from .face_controls import (
    face_control_property_name,
    is_face_control_bone,
    load_facs_payload_from_armature,
    property_group_control_state,
)


# Interpolation types with direct Roblox EasingStyle mappings.
# Only BEZIER requires dense baking; all others use sparse export.
_ROBLOX_MAPPED_INTERPOLATIONS = {
    "LINEAR",
    "CONSTANT",
    "CUBIC",
    "BOUNCE",
    "ELASTIC",
}

_SCALE_EPSILON = 1e-6

_FACE_CONTROL_FCURVE_RE = re.compile(r'^rbx_face_controls\.([A-Za-z0-9_]+)$')


def _object_scale_components(obj: "bpy.types.Object") -> Optional[Tuple[float, float, float]]:
    if not obj:
        return None

    scale = obj.matrix_world.to_scale()
    values = (abs(float(scale.x)), abs(float(scale.y)), abs(float(scale.z)))
    if any(value <= _SCALE_EPSILON for value in values):
        return None

    return values


def _scale_values_are_uniform(values: Optional[Tuple[float, float, float]]) -> bool:
    if not values:
        return False

    average = sum(values) / 3.0
    tolerance = max(_SCALE_EPSILON, average * 1e-5)
    return not any(abs(value - average) > tolerance for value in values)


def _uniform_object_scale(obj: "bpy.types.Object") -> Optional[float]:
    values = _object_scale_components(obj)
    if not _scale_values_are_uniform(values):
        return None

    return sum(values) / 3.0


def resolve_scene_unit_scale_factor(
    settings: Optional[Any] = None,
    scene: Optional[Any] = None,
) -> float:
    if scene is None:
        scene = getattr(settings, "id_data", None)
    if scene is None:
        scene = getattr(bpy.context, "scene", None)

    unit_settings = getattr(scene, "unit_settings", None)
    scene_unit_scale = getattr(unit_settings, "scale_length", 1.0)
    try:
        scene_unit_scale = float(scene_unit_scale)
    except (TypeError, ValueError):
        scene_unit_scale = 1.0

    if abs(scene_unit_scale) <= _SCALE_EPSILON:
        return 1.0
    return abs(scene_unit_scale)


def resolve_manual_deform_rig_scale_factor(
    settings: Optional[Any] = None,
    scene: Optional[Any] = None,
) -> float:
    configured_scale = getattr(settings, "rbx_deform_rig_scale", None)
    if configured_scale is None:
        return resolve_scene_unit_scale_factor(settings, scene)

    try:
        configured_scale = float(configured_scale)
    except (TypeError, ValueError):
        configured_scale = 0.0

    if abs(configured_scale) <= _SCALE_EPSILON:
        return resolve_scene_unit_scale_factor(settings, scene)
    return abs(configured_scale)


def resolve_deform_rig_scale_factor(
    ao: "bpy.types.Object",
    settings: Optional[Any] = None,
    target_scale_multiplier: Optional[float] = None,
) -> float:
    auto_scale = getattr(settings, "rbx_auto_deform_scale", True)
    if auto_scale:
        target_calibration = 1.0
        if target_scale_multiplier is not None:
            try:
                target_scale_multiplier = float(target_scale_multiplier)
            except (TypeError, ValueError):
                target_scale_multiplier = 1.0
            if target_scale_multiplier > _SCALE_EPSILON:
                target_calibration = target_scale_multiplier
        object_scale = _uniform_object_scale(ao) or 1.0
        return 1.0 / (object_scale * target_calibration)

    return resolve_manual_deform_rig_scale_factor(settings)


def resolve_deform_translation_scale_factor(
    ao: "bpy.types.Object",
    settings: Optional[Any] = None,
    target_scale_multiplier: Optional[float] = None,
    scale_factor: Optional[float] = None,
) -> float:
    """Return the translation normalization factor for deform export.

    Deform serialization works from evaluated/world-space bone matrices, so
    object scale is already baked into translation deltas. Auto scale should
    therefore normalize only by target calibration, not by object scale a second
    time.
    """
    auto_scale = getattr(settings, "rbx_auto_deform_scale", True)
    if scale_factor is None:
        scale_factor = resolve_deform_rig_scale_factor(
            ao,
            settings,
            target_scale_multiplier=target_scale_multiplier,
        )

    try:
        scale_factor = float(scale_factor)
    except (TypeError, ValueError):
        scale_factor = 1.0

    if not auto_scale:
        return scale_factor if abs(scale_factor) > _SCALE_EPSILON else 1.0

    object_scale = _uniform_object_scale(ao) or 1.0
    translation_scale_factor = scale_factor * object_scale
    if abs(translation_scale_factor) <= _SCALE_EPSILON:
        return 1.0
    return translation_scale_factor


def extract_deform_rest_scale_samples(
    ao: "bpy.types.Object",
) -> Dict[str, Dict[str, Any]]:
    samples: Dict[str, Dict[str, Any]] = {}
    if not ao or ao.type != "ARMATURE" or not getattr(ao, "pose", None):
        return samples

    back_trans = get_transform_to_blender().inverted()
    world_transform = back_trans @ ao.matrix_world
    rest_cache: Dict[str, Matrix] = {}
    sorted_bones = sorted(ao.pose.bones, key=lambda bone: len(bone.parent_recursive))

    for pose_bone in sorted_bones:
        if is_face_control_bone(pose_bone):
            continue

        rest_matrix = _orthonormalized_transform(
            world_transform @ pose_bone.bone.matrix_local
        )
        rest_cache[pose_bone.name] = rest_matrix

        parent_name = pose_bone.parent.name if pose_bone.parent else None
        parent_rest = rest_cache.get(parent_name) if parent_name else None
        if parent_rest is not None:
            try:
                local_rest = parent_rest.inverted() @ rest_matrix
            except ValueError:
                local_rest = rest_matrix
        else:
            local_rest = rest_matrix

        distance = float(local_rest.to_translation().length)
        if distance <= _SCALE_EPSILON:
            continue

        samples[pose_bone.name] = {
            "parent": parent_name,
            "distance": distance,
        }

    return samples


def _target_rest_bones_from_payload(
    target_bone_rest: Optional[Dict[str, Any]],
) -> Dict[str, Dict[str, Any]]:
    if not isinstance(target_bone_rest, dict):
        return {}

    payload_bones = target_bone_rest.get("bones", target_bone_rest)
    bones: Dict[str, Dict[str, Any]] = {}

    if isinstance(payload_bones, dict):
        for bone_name, entry in payload_bones.items():
            if not isinstance(bone_name, str):
                continue
            if isinstance(entry, dict):
                bones[bone_name] = entry
            elif isinstance(entry, (int, float)):
                bones[bone_name] = {"distance": entry}
    elif isinstance(payload_bones, list):
        for entry in payload_bones:
            if not isinstance(entry, dict):
                continue
            bone_name = entry.get("name") or entry.get("bone")
            if isinstance(bone_name, str):
                bones[bone_name] = entry

    return bones


def calculate_deform_target_scale_calibration(
    ao: "bpy.types.Object",
    target_bone_rest: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    target_bones = _target_rest_bones_from_payload(target_bone_rest)
    if not target_bones:
        return None

    source_samples = extract_deform_rest_scale_samples(ao)
    if not source_samples:
        return None

    ratios: List[float] = []
    matches: List[Dict[str, Any]] = []

    for bone_name, target_entry in target_bones.items():
        source_entry = source_samples.get(bone_name)
        if not source_entry:
            continue

        try:
            target_distance = float(
                target_entry.get("distance", target_entry.get("localDistance", 0.0))
            )
        except (TypeError, ValueError):
            continue

        source_distance = float(source_entry.get("distance") or 0.0)
        if target_distance <= _SCALE_EPSILON or source_distance <= _SCALE_EPSILON:
            continue

        target_parent = target_entry.get("parent")
        source_parent = source_entry.get("parent")
        if (
            isinstance(target_parent, str)
            and target_parent in source_samples
            and source_parent
            and target_parent != source_parent
        ):
            continue

        ratio = target_distance / source_distance
        if ratio <= _SCALE_EPSILON or not math.isfinite(ratio):
            continue

        ratios.append(ratio)
        matches.append(
            {
                "bone": bone_name,
                "source_distance": source_distance,
                "target_distance": target_distance,
                "ratio": ratio,
            }
        )

    if not ratios:
        return None

    sorted_ratios = sorted(ratios)
    middle = len(sorted_ratios) // 2
    if len(sorted_ratios) % 2:
        multiplier = sorted_ratios[middle]
    else:
        multiplier = (sorted_ratios[middle - 1] + sorted_ratios[middle]) / 2.0

    return {
        "multiplier": float(multiplier),
        "sample_count": len(ratios),
        "source_sample_count": len(source_samples),
        "target_sample_count": len(target_bones),
        "samples": matches[:12],
    }


def _orthonormalized_transform(mat: Matrix) -> Matrix:
    try:
        loc, rot, _scale = mat.decompose()
    except Exception:
        loc = mat.to_translation()
        rot = mat.to_quaternion()
    normalized = rot.to_matrix().to_4x4()
    normalized.translation = loc
    return normalized


def _lookup_interp_for_frame(
    interp_map: Optional[Dict[float, Tuple[Optional[str], Optional[str]]]],
    frame: float,
) -> Tuple[Optional[str], Optional[str]]:
    if not interp_map:
        return None, None
    cached = interp_map.get(frame)
    if cached:
        return cached
    most_recent_frame = None
    for kf_frame in interp_map.keys():
        if kf_frame < frame and (most_recent_frame is None or kf_frame > most_recent_frame):
            most_recent_frame = kf_frame
    if most_recent_frame is not None:
        return interp_map[most_recent_frame]
    return None, None


def _face_control_states_equal(
    prev_state: Optional[Dict[str, float]],
    next_state: Dict[str, float],
    tol: float = 1e-6,
) -> bool:
    if prev_state is None:
        return False
    if prev_state.keys() != next_state.keys():
        return False
    for key, prev_value in prev_state.items():
        if abs(prev_value - next_state.get(key, 0.0)) > tol:
            return False
    return True


def _build_face_control_export_context(
    armature_obj: "bpy.types.Object",
    actions: Optional[Set["bpy.types.Action"]] = None,
    action_slots: Optional[Dict["bpy.types.Action", Any]] = None,
) -> Dict[str, Any]:
    payload = load_facs_payload_from_armature(armature_obj)
    if not payload:
        return {
            "enabled": False,
            "control_names": [],
            "animated_controls": set(),
            "keyed_frames": set(),
            "interpolation": {},
            "face_bone_names": set(),
        }

    control_names = list(payload.get("face_control_names") or [])
    property_to_control = {
        face_control_property_name(control_name): control_name for control_name in control_names
    }
    keyed_frames: Set[float] = set()
    animated_controls: Set[str] = set()
    interpolation: Dict[str, Dict[float, Tuple[Optional[str], Optional[str]]]] = {}

    for action in actions or set():
        try:
            fcurves = get_action_fcurves(action, slot=(action_slots or {}).get(action))
        except Exception:
            continue
        for fcurve in fcurves:
            match = _FACE_CONTROL_FCURVE_RE.match(getattr(fcurve, "data_path", ""))
            if not match:
                continue
            control_name = property_to_control.get(match.group(1))
            if not control_name:
                continue
            animated_controls.add(control_name)
            interp_map = interpolation.setdefault(control_name, {})
            for keyframe_point in getattr(fcurve, "keyframe_points", []):
                frame = float(keyframe_point.co.x)
                keyed_frames.add(frame)
                interp_map[frame] = (
                    getattr(keyframe_point, "interpolation", None),
                    getattr(keyframe_point, "easing", None),
                )

    current_state = property_group_control_state(
        getattr(armature_obj, "rbx_face_controls", None),
        control_names,
    )
    has_nonzero_state = any(abs(value) > 1e-6 for value in current_state.values())

    return {
        "enabled": bool(animated_controls or has_nonzero_state),
        "control_names": control_names,
        "animated_controls": animated_controls,
        "keyed_frames": keyed_frames,
        "interpolation": interpolation,
        "face_bone_names": set(payload.get("face_bone_names") or []),
    }


def _serialize_face_control_state_for_frame(
    armature_obj: "bpy.types.Object",
    export_context: Dict[str, Any],
    frame: float,
    last_state: Optional[Dict[str, float]] = None,
    tol: float = 1e-6,
) -> Tuple[Optional[Dict[str, Dict[str, Any]]], Dict[str, float]]:
    control_names = export_context.get("control_names") or []
    raw_state = property_group_control_state(
        getattr(armature_obj, "rbx_face_controls", None),
        control_names,
    )
    explicit_key = frame in (export_context.get("keyed_frames") or set())
    changed = not _face_control_states_equal(last_state, raw_state, tol)
    any_nonzero = any(abs(value) > tol for value in raw_state.values())
    animated_controls = export_context.get("animated_controls") or set()

    if not explicit_key and not changed and not any_nonzero:
        return None, raw_state

    if animated_controls:
        export_names = [control_name for control_name in control_names if control_name in animated_controls]
    else:
        export_names = [control_name for control_name in control_names if abs(raw_state.get(control_name, 0.0)) > tol]
        if not export_names and any_nonzero:
            export_names = list(control_names)
        if not export_names and changed and last_state is not None:
            export_names = [
                control_name
                for control_name in control_names
                if abs((last_state or {}).get(control_name, 0.0) - raw_state.get(control_name, 0.0)) > tol
            ]

    if not export_names and not explicit_key:
        return None, raw_state

    face_state = {}
    interpolation = export_context.get("interpolation") or {}
    for control_name in export_names:
        interp, easing = _lookup_interp_for_frame(interpolation.get(control_name), frame)
        if interp:
            easing_style, easing_direction = map_blender_to_roblox_easing(interp, easing)
        else:
            easing_style, easing_direction = ("Linear", "Out")
        face_state[control_name] = {
            "value": float(raw_state.get(control_name, 0.0)),
            "easingStyle": easing_style,
            "easingDirection": easing_direction,
        }

    return (face_state or None), raw_state


def is_deform_bone_rig(armature: "bpy.types.Object") -> bool:
    """
    Determines if an armature is a deform bone rig by checking if any mesh
    in the scene uses it in an Armature modifier. This is the standard
    and most reliable way to identify skinned meshes.
    """
    if not armature or armature.type != "ARMATURE":
        return False

    # Iterate through all mesh objects in the scene
    for mesh_obj in iter_scene_objects():
        if mesh_obj.type == "MESH":
            # Check if the mesh has an Armature modifier targeting our armature
            for modifier in mesh_obj.modifiers:
                if modifier.type == "ARMATURE" and modifier.object == armature:
                    return True

    return False


def extract_bone_hierarchy(armature: "bpy.types.Object") -> Dict[str, Optional[str]]:
    """
    Extracts the bone hierarchy from an armature.
    Returns a dictionary with bone names as keys and their parent bone names as values.
    Root bones will have None as their parent.
    """
    hierarchy = {}

    if not armature or armature.type != "ARMATURE":
        return hierarchy

    for bone in armature.data.bones:
        if is_face_control_bone(bone):
            continue
        if bone.parent:
            hierarchy[bone.name] = bone.parent.name
        else:
            hierarchy[bone.name] = None

    return hierarchy


def serialize_animation_state(
    ao: "bpy.types.Object",
    back_trans_cached: Optional[Matrix] = None,
    static_cache: Optional[Dict[str, Dict[str, Any]]] = None,
    state: Optional[Dict[str, List[float]]] = None,
) -> Dict[str, List[float]]:
    """Serialize Motor6D animation state with aggressive static caching

    Caller can provide a state dict to be cleared/updated to reduce allocations.
    """
    state = state if state is not None else {}
    else_clear = state is not None
    if else_clear:
        state.clear()

    # Use cached transform or compute once
    back_trans = (
        back_trans_cached
        if back_trans_cached is not None
        else get_transform_to_blender().inverted()
    )

    # Local bindings for speed
    pose_bones = ao.pose.bones
    cache: Dict[str, Dict[str, Any]] = static_cache or {}

    def ensure_cache(name: str) -> Dict[str, Any]:
        entry = cache.get(name)
        if entry is None:
            entry = {}
            cache[name] = entry
        return entry

    def get_cached_matrix(bone_name: str, key: str, fallback_fn):
        bcache = ensure_cache(bone_name)
        mat = bcache.get(key)
        if mat is None:
            mat = fallback_fn()
            bcache[key] = mat
        return mat
    
    # Build a lookup for world-space bones and their original parents
    worldspace_bones: Dict[str, str] = {}  # bone_name -> original_parent_name
    for bone in pose_bones:
        if is_face_control_bone(bone):
            continue
        if bone.bone.get("worldspace_bone"):
            original_parent = bone.bone.get("worldspace_original_parent", "")
            if original_parent:
                worldspace_bones[bone.name] = original_parent

    for bone in pose_bones:
        if is_face_control_bone(bone):
            continue
        has_motor6d_props = (
            "transform" in bone.bone
            and "transform1" in bone.bone
            and "nicetransform" in bone.bone
        )

        if has_motor6d_props:
            # --- Traditional Motor6D bone logic ---
            try:
                bcache = ensure_cache(bone.name)
                extr_inv = bcache.get("extr_inv")
                orig_base_mat = bcache.get("orig_base_mat")

                if extr_inv is None:
                    nicetransform = get_cached_matrix(
                        bone.name,
                        "nicetransform",
                        lambda: to_matrix(bone.bone.get("nicetransform")),
                    )
                    extr_inv = nicetransform.inverted()
                    bcache["extr_inv"] = extr_inv
                if orig_base_mat is None:
                    orig_mat = to_matrix(bone.bone.get("transform"))
                    orig_mat_tr1 = to_matrix(bone.bone.get("transform1"))
                    orig_base_mat = back_trans @ (orig_mat @ orig_mat_tr1)
                    bcache["orig_base_mat"] = orig_base_mat

                cur_obj_transform = back_trans @ (bone.matrix @ extr_inv)

                # Check if this is a world-space bone that needs parent compensation
                if bone.name in worldspace_bones:
                    original_parent_name = worldspace_bones[bone.name]
                    original_parent_bone = pose_bones.get(original_parent_name)
                    
                    if original_parent_bone:
                        # Get the original parent's transforms
                        parent_has_motor6d = (
                            "transform" in original_parent_bone.bone
                            and "transform1" in original_parent_bone.bone
                            and "nicetransform" in original_parent_bone.bone
                        )
                        
                        if parent_has_motor6d:
                            pcb = ensure_cache(original_parent_name)
                            parent_extr_inv = pcb.get("extr_inv")
                            parent_orig_base_mat = pcb.get("orig_base_mat")
                            
                            if parent_extr_inv is None:
                                parent_nicetransform = get_cached_matrix(
                                    original_parent_name,
                                    "nicetransform",
                                    lambda: to_matrix(original_parent_bone.bone.get("nicetransform")),
                                )
                                parent_extr_inv = parent_nicetransform.inverted()
                                pcb["extr_inv"] = parent_extr_inv
                            if parent_orig_base_mat is None:
                                p_orig_mat = to_matrix(original_parent_bone.bone.get("transform"))
                                p_orig_mat_tr1 = to_matrix(original_parent_bone.bone.get("transform1"))
                                parent_orig_base_mat = back_trans @ (p_orig_mat @ p_orig_mat_tr1)
                                pcb["orig_base_mat"] = parent_orig_base_mat
                            
                            # Current parent world transform
                            parent_cur_transform = back_trans @ (original_parent_bone.matrix @ parent_extr_inv)
                            
                            # The bone's world-space target (where it should stay)
                            world_target = cur_obj_transform
                            
                            # Calculate what the local transform should be relative to current parent
                            local_relative_to_parent = parent_cur_transform.inverted() @ world_target
                            
                            # Original local transform (rest pose relative to parent at rest)
                            orig_local = parent_orig_base_mat.inverted() @ orig_base_mat
                            
                            # The delta we need to apply
                            bone_transform = orig_local.inverted() @ local_relative_to_parent
                        else:
                            # Parent is not motor6d, just use world-space delta
                            bone_transform = orig_base_mat.inverted() @ cur_obj_transform
                    else:
                        # Original parent not found, use world-space delta
                        bone_transform = orig_base_mat.inverted() @ cur_obj_transform

                elif bone.parent:
                    parent_has_motor6d_props = (
                        "transform" in bone.parent.bone
                        and "transform1" in bone.parent.bone
                        and "nicetransform" in bone.parent.bone
                    )
                    if parent_has_motor6d_props:
                        pcb = ensure_cache(bone.parent.name)
                        parent_extr_inv = pcb.get("extr_inv")
                        parent_orig_base_mat = pcb.get("orig_base_mat")
                        if parent_extr_inv is None:
                            parent_nicetransform = get_cached_matrix(
                                bone.parent.name,
                                "nicetransform",
                                lambda: to_matrix(bone.parent.bone.get("nicetransform")),
                            )
                            parent_extr_inv = parent_nicetransform.inverted()
                            pcb["extr_inv"] = parent_extr_inv
                        if parent_orig_base_mat is None:
                            p_orig_mat = to_matrix(bone.parent.bone.get("transform"))
                            p_orig_mat_tr1 = to_matrix(bone.parent.bone.get("transform1"))
                            parent_orig_base_mat = back_trans @ (
                                p_orig_mat @ p_orig_mat_tr1
                            )
                            pcb["orig_base_mat"] = parent_orig_base_mat

                        parent_obj_transform = back_trans @ (
                            bone.parent.matrix @ parent_extr_inv
                        )
                        orig_transform = parent_orig_base_mat.inverted() @ orig_base_mat
                        cur_transform = parent_obj_transform.inverted() @ cur_obj_transform
                        bone_transform = orig_transform.inverted() @ cur_transform
                    else:
                        # Parent is a new bone, which is now handled by the deform serializer.
                        # This bone is treated as a root in the context of Motor6D calculations.
                        bone_transform = orig_base_mat.inverted() @ cur_obj_transform
                else:
                    bone_transform = orig_base_mat.inverted() @ cur_obj_transform

                statel = mat_to_cf(bone_transform)
                if cf_round:
                    statel = [round(x, cf_round_fac) for x in statel]

                if statel != identity_cf:
                    state[bone.name] = statel
            except Exception as e:
                print(f"[Export] Skipping bone '{bone.name}' due to serialization error: {e}")

    return state


def serialize_deform_animation_state(
    ao: "bpy.types.Object",
    is_skinned_rig: bool,
    world_transform_cached: Optional[Matrix] = None,
    scale_factor_cached: Optional[float] = None,
    static_cache: Optional[Dict[str, Dict[str, Any]]] = None,
    state: Optional[Dict[str, List[float]]] = None,
    excluded_bones: Optional[Set[str]] = None,
) -> Dict[str, List[float]]:
    """Serialize Deform Bone animation state with static caching"""
    state = state if state is not None else {}
    if state is not None:
        state.clear()

    # Use cached transforms or compute once
    if world_transform_cached is None:
        back_trans = get_transform_to_blender().inverted()
        world_transform = back_trans @ ao.matrix_world
    else:
        world_transform = world_transform_cached

    if scale_factor_cached is None:
        settings = getattr(bpy.context.scene, "rbx_anim_settings", None)
        scale_factor = resolve_deform_rig_scale_factor(ao, settings)
    else:
        scale_factor = scale_factor_cached
    settings = getattr(bpy.context.scene, "rbx_anim_settings", None)
    translation_scale_factor = resolve_deform_translation_scale_factor(
        ao,
        settings,
        scale_factor=scale_factor,
    )

    state: Dict[str, List[float]] = {}
    bone_cache: Dict[str, Tuple[Matrix, Matrix]] = {}

    deform_chain_bones: Set[str] = set()
    if is_skinned_rig:
        for pose_bone in ao.pose.bones:
            if is_face_control_bone(pose_bone) or not pose_bone.bone.use_deform:
                continue
            current_bone = pose_bone
            while current_bone:
                if not is_face_control_bone(current_bone):
                    deform_chain_bones.add(current_bone.name)
                current_bone = current_bone.parent

    # Pre-populate cache for deform/helper bones to simplify parent lookups
    bones_to_process = []
    for bone in ao.pose.bones:
        if is_face_control_bone(bone):
            continue
        if excluded_bones and bone.name in excluded_bones:
            continue
        # Exclude Motor6D bones from deform serialization (same as v2.4.6)
        if (
            "transform" in bone.bone
            and "transform1" in bone.bone
            and "nicetransform" in bone.bone
        ):
            continue
        bones_to_process.append(bone)

    # Fast bail-out: nothing to serialize on deform path
    if not bones_to_process:
        return state

    # Cache for motor6d parent transforms to avoid repeated to_matrix/inverted work per frame
    motor_parent_cache: Dict[str, Tuple[Matrix, Matrix]] = {}

    worldspace_bones: Dict[str, str] = {}
    for bone in ao.pose.bones:
        if is_face_control_bone(bone):
            continue
        if excluded_bones and bone.name in excluded_bones:
            continue
        if bone.bone.get("worldspace_bone"):
            original_parent = bone.bone.get("worldspace_original_parent", "")
            if original_parent:
                worldspace_bones[bone.name] = original_parent

    def get_bone_space_transforms(space_bone):
        if not space_bone:
            return None, None

        if space_bone.name in bone_cache:
            return bone_cache.get(space_bone.name)

        # Parent is not in cache, check if it's a motor6d bone
        parent_has_motor6d_props = (
            "transform" in space_bone.bone
            and "transform1" in space_bone.bone
            and "nicetransform" in space_bone.bone
        )

        if parent_has_motor6d_props:
            # Convert motor6d parent to roblox space for deform calculation (cached)
            cached = motor_parent_cache.get(space_bone.name)
            if cached:
                return cached

            parent_nicetransform = to_matrix(space_bone.bone.get("nicetransform"))
            parent_extr_inv = parent_nicetransform.inverted()

            parent_current = _orthonormalized_transform(
                world_transform @ (space_bone.matrix @ parent_extr_inv)
            )
            parent_rest = _orthonormalized_transform(
                world_transform @ (
                    space_bone.bone.matrix_local @ parent_extr_inv
                )
            )

            motor_parent_cache[space_bone.name] = (parent_current, parent_rest)
            return (parent_current, parent_rest)

        # Parent is neither deform nor motor6d, treat as root
        return None, None

    def get_parent_transforms(bone):
        if bone.name in worldspace_bones:
            original_parent = ao.pose.bones.get(worldspace_bones[bone.name])
            return get_bone_space_transforms(original_parent)

        return get_bone_space_transforms(bone.parent)

    for bone in bones_to_process:
        # For deform and new bones alike, use Blender-space matrices converted once to Roblox space
        current_matrix = _orthonormalized_transform(world_transform @ bone.matrix)
        rest_matrix = _orthonormalized_transform(
            world_transform @ bone.bone.matrix_local
        )
        bone_cache[bone.name] = (current_matrix, rest_matrix)

    for bone in bones_to_process:
        try:
            current_matrix, rest_matrix = bone_cache[bone.name]

            if bone.parent or bone.name in worldspace_bones:
                parent_transforms = get_parent_transforms(bone)
                if parent_transforms[0] is not None and parent_transforms[1] is not None:
                    parent_current, parent_rest = parent_transforms
                    try:
                        current_local_transform = parent_current.inverted() @ current_matrix
                        rest_local_transform = parent_rest.inverted() @ rest_matrix
                        delta_transform = (
                            rest_local_transform.inverted() @ current_local_transform
                        )
                    except ValueError:
                        delta_transform = rest_matrix.inverted() @ current_matrix
                else:
                    # Parent is not a deform bone, treat as root
                    delta_transform = rest_matrix.inverted() @ current_matrix
            else:
                delta_transform = rest_matrix.inverted() @ current_matrix

            # Branch behavior: skinned deform-chain bones vs new/helper bones.
            if is_skinned_rig and bone.name in deform_chain_bones:
                # Deform-chain bones: apply corrected Roblox space conversion (axis swizzles and scaling)
                loc, rot, _sca = delta_transform.decompose()
                sf = (
                    translation_scale_factor
                    if abs(translation_scale_factor) > _SCALE_EPSILON
                    else 1.0
                )

                # Apply inverse scale to translation and swizzle axes for Roblox
                loc = loc / sf
                loc_roblox = Vector((-loc.x, loc.y, -loc.z))

                # Flip rotation axes for Roblox
                rot.x, rot.z = -rot.x, -rot.z

                # Reconstruct final transform without scale; Roblox Pose CFrames cannot
                # represent scale, and rest-matrix scale leakage distorts normalized playback.
                loc_mat = Matrix.Translation(loc_roblox)
                rot_mat = rot.to_matrix().to_4x4()
                final_transform = loc_mat @ rot_mat
            else:
                # New/helper bones: no scaling; apply position swizzle only (-x, y, -z)
                tr = delta_transform.to_translation()
                tr_swizzled = Vector((-tr.x, tr.y, -tr.z))
                rot_m3 = delta_transform.to_3x3()
                try:
                    rot_m3.normalize()
                except Exception:
                    pass
                loc_mat = Matrix.Translation(tr_swizzled)
                rot_mat = rot_m3.to_4x4()
                final_transform = loc_mat @ rot_mat

            statel = mat_to_cf(final_transform)
            if cf_round:
                statel = [round(x, cf_round_fac) for x in statel]

            if statel != identity_cf:
                state[bone.name] = statel
        except Exception as e:
            print(f"[Export] Skipping deform bone '{bone.name}' due to serialization error: {e}")

    return state


def serialize_combined_animation_state(
    ao: "bpy.types.Object",
    ao_eval: "bpy.types.Object",
    depsgraph: "bpy.types.Depsgraph",
    run_deform_path: bool,
    skinned_rig: bool,
    back_trans_cached: Optional[Matrix] = None,
    world_transform_cached: Optional[Matrix] = None,
    scale_factor_cached: Optional[float] = None,
    static_cache: Optional[Dict[str, Dict[str, Any]]] = None,
    motor_state_reuse: Optional[Dict[str, List[float]]] = None,
    deform_state_reuse: Optional[Dict[str, List[float]]] = None,
    excluded_deform_bones: Optional[Set[str]] = None,
) -> Dict[str, List[float]]:
    """
    Serializes the animation state by running both Motor6D and Deform Bone
    serialization and merging the results. This correctly handles mixed rigs.
    """
    state: Dict[str, List[float]] = {}
    # prepare a lightweight static cache dict shared across both serializers (can be provided by caller)
    static_cache = static_cache if static_cache is not None else {}
    # Always run the standard Motor6D serialization first.
    motor_state = serialize_animation_state(
        ao_eval,
        back_trans_cached,
        static_cache,
        motor_state_reuse,
    )
    state.update(motor_state)

    # Then, if we need deform data (skinned rig or helper bones), run deform serialization
    # and merge the results. Deform data will override Motor6D data for any
    # bone that might be flagged as both.
    if run_deform_path:
        deform_state = serialize_deform_animation_state(
            ao_eval,
            skinned_rig,
            world_transform_cached,
            scale_factor_cached,
            static_cache,
            deform_state_reuse,
            excluded_deform_bones,
        )
        state.update(deform_state)

    return state


def get_ik_affected_bones(armature_obj: "bpy.types.Object") -> Set[str]:
    """
    Scans an armature for IK constraints and returns a set of all bone names
    that are part of an IK chain.
    """
    ik_bones: Set[str] = set()
    if not armature_obj or armature_obj.type != "ARMATURE":
        return ik_bones

    def add_ik_chain(tail_bone, chain_count):
        ik_bones.add(tail_bone.name)
        current_bone = tail_bone
        if chain_count and chain_count > 0:
            remaining = int(chain_count)
            while remaining > 0 and current_bone.parent:
                current_bone = current_bone.parent
                ik_bones.add(current_bone.name)
                remaining -= 1
        else:
            while current_bone.parent:
                current_bone = current_bone.parent
                ik_bones.add(current_bone.name)

    for bone in armature_obj.pose.bones:
        for constraint in bone.constraints:
            if constraint.type == "IK":
                add_ik_chain(bone, getattr(constraint, "chain_count", 0))
    return ik_bones


def get_all_constrained_bones(armature_obj: "bpy.types.Object") -> Set[str]:
    """
    Finds all bones that are directly or indirectly affected by any constraint.
    For IK, it includes the entire chain. For others, it's the bone with the constraint.
    """
    constrained_bones: Set[str] = set()
    if not armature_obj or armature_obj.type != "ARMATURE":
        return constrained_bones

    def add_ik_chain(tail_bone, chain_count):
        constrained_bones.add(tail_bone.name)
        current_bone = tail_bone
        if chain_count and chain_count > 0:
            remaining = int(chain_count)
            while remaining > 0 and current_bone.parent:
                current_bone = current_bone.parent
                constrained_bones.add(current_bone.name)
                remaining -= 1
        else:
            while current_bone.parent:
                current_bone = current_bone.parent
                constrained_bones.add(current_bone.name)

    for bone in armature_obj.pose.bones:
        if bone.constraints:
            constrained_bones.add(bone.name)
            for constraint in bone.constraints:
                if constraint.type == "IK":
                    add_ik_chain(bone, getattr(constraint, "chain_count", 0))
    return constrained_bones


def get_deform_descendant_bones(
    armature_obj: "bpy.types.Object",
    seed_bones: Set[str],
) -> Set[str]:
    """Return seed bones plus transform descendants for skinned/deform baking."""
    affected_bones: Set[str] = set(seed_bones)
    if not armature_obj or armature_obj.type != "ARMATURE" or not seed_bones:
        return affected_bones

    stack = []
    for bone_name in seed_bones:
        pose_bone = armature_obj.pose.bones.get(bone_name)
        if pose_bone:
            stack.extend(pose_bone.children)

    while stack:
        pose_bone = stack.pop()
        if is_face_control_bone(pose_bone):
            continue
        affected_bones.add(pose_bone.name)
        stack.extend(pose_bone.children)

    return affected_bones


def get_all_driven_bones(armature_obj: "bpy.types.Object") -> Set[str]:
    """
    Finds all bones that are affected by animation drivers.
    This includes drivers on bone transforms, constraints, and custom properties.
    """
    driven_bones: Set[str] = set()
    if not armature_obj or armature_obj.type != "ARMATURE":
        return driven_bones

    anim_data = armature_obj.animation_data
    if not anim_data or not getattr(anim_data, "drivers", None):
        return driven_bones

    bone_name_pattern = re.compile(r'pose\.bones\["(.+?)"\]')
    for fcurve in anim_data.drivers:
        data_path = getattr(fcurve, "data_path", "")
        if not data_path or not data_path.startswith("pose.bones"):
            continue
        match = bone_name_pattern.search(data_path)
        if match:
            driven_bones.add(match.group(1))

    return driven_bones


def _frame_range_from_fcurves(fcurves: Any) -> Optional[Tuple[int, int]]:
    frames: List[float] = []
    for fcurve in fcurves or []:
        for keyframe_point in getattr(fcurve, "keyframe_points", []) or []:
            try:
                frames.append(float(keyframe_point.co.x))
            except Exception:
                continue

    if not frames:
        return None

    return math.floor(min(frames)), math.ceil(max(frames))


def _action_keyframe_range(
    animation_data: Any,
    action: Optional["bpy.types.Action"],
) -> Optional[Tuple[int, int]]:
    if action is None:
        return None

    try:
        fcurves = get_action_fcurves(
            action,
            slot=get_animation_data_action_slot(animation_data, action=action),
        )
    except Exception:
        fcurves = getattr(action, "fcurves", None) or []

    return _frame_range_from_fcurves(fcurves)


def _animation_data_frame_range(animation_data: Any) -> Optional[Tuple[int, int]]:
    if animation_data is None:
        return None
    if getattr(animation_data, "use_nla", False):
        strip_ranges: List[Tuple[float, float]] = []
        for track in getattr(animation_data, "nla_tracks", []) or []:
            if getattr(track, "mute", False):
                continue
            for strip in getattr(track, "strips", []) or []:
                if getattr(strip, "action", None) is None:
                    continue
                try:
                    strip_ranges.append((float(strip.frame_start), float(strip.frame_end)))
                except Exception:
                    continue
        if strip_ranges:
            start = min(frame_range[0] for frame_range in strip_ranges)
            end = max(frame_range[1] for frame_range in strip_ranges)
            return math.floor(start), math.ceil(end)

    return _action_keyframe_range(
        animation_data,
        getattr(animation_data, "action", None),
    )


def _constraint_target_frame_ranges(
    ao: "bpy.types.Object",
) -> List[Tuple[int, int]]:
    ranges: List[Tuple[int, int]] = []
    if not ao or getattr(ao, "type", None) != "ARMATURE":
        return ranges

    seen_targets: Set[int] = set()
    for bone in getattr(ao.pose, "bones", []) or []:
        for constraint in getattr(bone, "constraints", []) or []:
            target = getattr(constraint, "target", None)
            if target is None or target == ao:
                continue
            if getattr(target, "type", None) != "ARMATURE":
                continue
            target_id = id(target)
            if target_id in seen_targets:
                continue
            seen_targets.add(target_id)

            frame_range = _animation_data_frame_range(
                getattr(target, "animation_data", None)
            )
            if frame_range is not None:
                ranges.append(frame_range)

    return ranges


def resolve_export_frame_range(ao: "bpy.types.Object") -> Optional[Tuple[int, int]]:
    """Return the frame range for the armature's current export source."""
    ranges: List[Tuple[int, int]] = []

    own_range = _animation_data_frame_range(getattr(ao, "animation_data", None))
    if own_range is not None:
        ranges.append(own_range)

    ranges.extend(_constraint_target_frame_ranges(ao))

    if not ranges:
        return None

    return min(frame_range[0] for frame_range in ranges), max(
        frame_range[1] for frame_range in ranges
    )


def sync_scene_frame_range_to_export_source(
    scene: "bpy.types.Scene",
    ao: "bpy.types.Object",
) -> Optional[Tuple[int, int]]:
    frame_range = resolve_export_frame_range(ao)
    if frame_range is None:
        return None

    frame_start, frame_end = frame_range
    if frame_end < frame_start:
        return None

    scene.frame_start = frame_start
    scene.frame_end = frame_end
    return frame_range


def serialize(
    ao: "bpy.types.Object",
    target_bone_rest: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Main serialization function that handles all animation export logic"""
    ctx = bpy.context
    desired_fps = get_scene_fps()
    animation_data = getattr(ao, "animation_data", None)

    # Store the current frame to restore it later
    original_frame = ctx.scene.frame_current

    # --- OPTIMIZATION: Get the dependency graph once. ---
    depsgraph = ctx.evaluated_depsgraph_get()
    ao_eval = ao.evaluated_get(depsgraph)

    # --- OPTIMIZATION: Cache deform/skinned detection and new-bone presence. ---
    # is_skinned_rig: true deform/skin rig (armature modifier) or forced by user
    # has_new_bones: bones without Motor6D props present (should run deform path, but not mark rig as deform)
    has_new_bones = any(
        not (
            "transform" in bone.bone
            and "transform1" in bone.bone
            and "nicetransform" in bone.bone
        )
        and not is_face_control_bone(bone)
        for bone in ao_eval.pose.bones
    )
    settings = getattr(ctx.scene, "rbx_anim_settings", None)
    force_deform = getattr(settings, "force_deform_bone_serialization", False)
    is_skinned_rig = is_deform_bone_rig(ao) or force_deform
    run_deform_path = is_skinned_rig or has_new_bones

    # Cache static transforms once per serialize call
    back_trans_cached = get_transform_to_blender().inverted()
    world_transform_cached = back_trans_cached @ ao.matrix_world
    settings = getattr(ctx.scene, "rbx_anim_settings", None)
    auto_deform_scale_for_calibration = getattr(settings, "rbx_auto_deform_scale", True)
    target_scale_calibration = None
    if target_bone_rest and auto_deform_scale_for_calibration:
        target_scale_calibration = calculate_deform_target_scale_calibration(
            ao,
            target_bone_rest,
        )
    target_scale_multiplier = (
        target_scale_calibration.get("multiplier")
        if target_scale_calibration
        else None
    )
    scale_factor_cached = resolve_deform_rig_scale_factor(
        ao,
        settings,
        target_scale_multiplier=target_scale_multiplier,
    )

    # Check if we should use a simple bake for NLA tracks.
    use_nla_bake = False
    nla_single_action = None
    if animation_data and animation_data.use_nla:
        active_strips = 0
        single_strip = None
        for track in animation_data.nla_tracks:
            if track.mute:
                continue
            for strip in track.strips:
                active_strips += 1
                if single_strip is None:
                    single_strip = strip
        if active_strips > 0:
            # If there's exactly one active strip, prefer hybrid bake so easing is respected
            # unless the strip uses BEZIER, which requires full bake for correctness.
            if active_strips == 1 and single_strip and single_strip.action:
                strip_action = single_strip.action
                try:
                    strip_fcurves = get_action_fcurves(
                        strip_action,
                        slot=get_animation_data_action_slot(
                            animation_data,
                            action=strip_action,
                        ),
                    )
                    has_bezier = any(
                        kp.interpolation == "BEZIER"
                        for fc in strip_fcurves
                        for kp in fc.keyframe_points
                    )
                except Exception:
                    has_bezier = False

                if has_bezier:
                    use_nla_bake = True
                else:
                    nla_single_action = strip_action
            else:
                use_nla_bake = True

    action = nla_single_action or (animation_data.action if animation_data else None)
    action_slot = get_animation_data_action_slot(animation_data, action=action)
    action_slots = {}
    if action is not None:
        action_slots[action] = action_slot

    face_export_context = _build_face_control_export_context(
        ao,
        {action} if action is not None else set(),
        action_slots,
    )
    export_face_controls = bool(face_export_context.get("enabled"))
    excluded_face_bones = (
        face_export_context.get("face_bone_names", set()) if export_face_controls else set()
    )

    # consider constraints only if they actually affect bones (ik chains, copy, etc.)
    has_constraints = len(get_all_constrained_bones(ao)) > 0
    has_drivers = len(get_all_driven_bones(ao)) > 0
    has_constraint_target_action = any(
        getattr(getattr(constraint, "target", None), "animation_data", None)
        and getattr(constraint.target.animation_data, "action", None)
        for bone in ao.pose.bones
        for constraint in bone.constraints
    )

    # --- Removed force_full_bake for new bones - use sparse baking instead ---

    # If NLA tracks are active OR if there are constraints without any keyed
    # source action, use a simple full bake of the visual result. Constraint
    # target actions can use the hybrid baker so their easing is preserved.
    if (
        use_nla_bake
        or (has_constraints and not action and not has_constraint_target_action)
        or (has_drivers and not action)
    ):
        if use_nla_bake:
            pass
        else:
            pass

        collected = []
        motor_state_reuse: Dict[str, List[float]] = {}
        deform_state_reuse: Dict[str, List[float]] = {}
        constrained_bones = get_all_constrained_bones(ao)
        driven_bones = get_all_driven_bones(ao)
        if driven_bones:
            constrained_bones.update(driven_bones)
        for bone in ao.pose.bones:
            if not bone.bone.use_inherit_rotation:
                constrained_bones.add(bone.name)
        if is_skinned_rig:
            constrained_bones = get_deform_descendant_bones(
                ao,
                constrained_bones,
            )
        frames = ctx.scene.frame_end + 1 - ctx.scene.frame_start

        # cache commonly used values
        frame_start = ctx.scene.frame_start
        frame_end = ctx.scene.frame_end
        frame_step = getattr(ctx.scene, "frame_step", 1) or 1  # Fallback for safety
        fps = desired_fps

        # reuse a shared per-bone cache across frames
        shared_cache = {}
        for i in range(frame_start, frame_end + 1, frame_step):
            ctx.scene.frame_set(i)
            # --- OPTIMIZATION: Pass the existing depsgraph instead of re-evaluating. ---
            ao_eval_for_frame = ao.evaluated_get(depsgraph)
            state = serialize_combined_animation_state(
                ao,
                ao_eval_for_frame,
                depsgraph,
                run_deform_path,
                is_skinned_rig,
                back_trans_cached,
                world_transform_cached,
                scale_factor_cached,
                shared_cache,
                motor_state_reuse,
                deform_state_reuse,
                excluded_face_bones,
            )
            face_state, _ = _serialize_face_control_state_for_frame(
                ao,
                face_export_context,
                float(i),
            )

            # Wrap the raw state in the same format as the hybrid baker for consistency.
            # Since this path has no easing data, we use a default "Linear".
            wrapped_state = {}
            for bone_name in constrained_bones:
                if bone_name not in state:
                    state[bone_name] = list(identity_cf)
            for bone_name, cframe_data in state.items():
                wrapped_state[bone_name] = [list(cframe_data), "Linear", "Out"]

            keyframe_payload: Dict[str, Any] = {
                "t": (i - frame_start) / fps,
                "kf": wrapped_state,
            }
            if face_state:
                keyframe_payload["fc"] = face_state
            collected.append(keyframe_payload)

        result = {"t": (frames - 1) / desired_fps, "kfs": collected}

    # If there's an action, use the intelligent hybrid baker.
    # This also handles proxy rigs whose animation lives on constraint targets.
    elif action or has_constraint_target_action:
        # 1. Identify Bone Groups and all relevant Actions
        constrained_bones = get_all_constrained_bones(ao)
        driven_bones = get_all_driven_bones(ao)
        if driven_bones:
            constrained_bones.update(driven_bones)
        if is_skinned_rig:
            constrained_bones = get_deform_descendant_bones(
                ao,
                constrained_bones,
            )

        # Bones with inherit_rotation disabled must be baked every frame.
        # Roblox Motor6D hierarchy always inherits parent rotation, so the
        # serializer must emit a varying compensation CFrame each frame to
        # keep the bone world-space-stable when its parent moves.
        # These are tracked separately from constrained_bones because the
        # constrained path has easing-thinning logic that would skip them.
        non_inheriting_bones: Set[str] = set()
        worldspace_parent_map: Dict[str, str] = {}
        for bone in ao.pose.bones:
            if not bone.bone.use_inherit_rotation:
                non_inheriting_bones.add(bone.name)
            if bone.bone.get("worldspace_bone"):
                original_parent = bone.bone.get("worldspace_original_parent", "")
                if original_parent:
                    worldspace_parent_map[bone.name] = original_parent
        if is_skinned_rig:
            non_inheriting_bones = get_deform_descendant_bones(
                ao,
                non_inheriting_bones,
            )

        animated_bones = set()
        all_actions = set()

        if action:
            all_actions.add(action)
            fcurves = get_action_fcurves(action, slot=action_slot)
            for fcurve in fcurves:
                if fcurve.data_path.startswith("pose.bones"):
                    match = re.search(r'pose\.bones\["(.+?)"\]', fcurve.data_path)
                    if match:
                        animated_bones.add(match.group(1))

        face_export_context = _build_face_control_export_context(ao, all_actions, action_slots)
        export_face_controls = bool(face_export_context.get("enabled"))
        excluded_face_bones = (
            face_export_context.get("face_bone_names", set()) if export_face_controls else set()
        )

        # Also find bones driven by constrained targets and gather their actions
        for bone in ao.pose.bones:
            for c in bone.constraints:
                if (
                    hasattr(c, "target")
                    and c.target
                    and c.target.animation_data
                    and c.target.animation_data.action
                ):
                    animated_bones.add(bone.name)
                    target_action = c.target.animation_data.action
                    all_actions.add(target_action)
                    action_slots[target_action] = get_animation_data_action_slot(
                        c.target.animation_data,
                        action=target_action,
                    )

        # decide hybrid vs sparse after we know which bones are actually constrained
        has_constraints_local = len(constrained_bones) > 0 or len(non_inheriting_bones) > 0
        if has_constraints_local:
            pass
        else:
            pass

        # debug: report key bone groups
        try:
            pass
        except Exception:
            pass

        # 2. Get all relevant keyframe times from all found actions.
        # For Bezier curves, bake all intermediate frames to capture the curve.
        frame_start = ctx.scene.frame_start
        frame_end = ctx.scene.frame_end
        keyframe_times = {frame_start, frame_end}
        keyframe_times.update(face_export_context.get("keyed_frames") or set())

        all_fcurves = []
        for act in all_actions:
            fcurves = get_action_fcurves(act, slot=action_slots.get(act))
            all_fcurves.extend(fcurves)

        # Track bezier segments per bone to force dense sampling later
        from collections import defaultdict

        bezier_segments: Dict[str, Set[Tuple[int, int]]] = defaultdict(set)

        # Pre-compile regex for performance
        bone_name_pattern = re.compile(r'pose\.bones\["(.+?)"\]')
        FRAME_KEY_PRECISION = 4

        def _norm_frame(v: float) -> float:
            return round(float(v), FRAME_KEY_PRECISION)
        
        # Interpolations with direct Roblox easing style mappings in this exporter.
        # Any interpolation outside this set is treated as unsupported and
        # will be densely baked between keys for fidelity.
        for fcurve in all_fcurves:
            # determine bone name for this fcurve (if any)
            bone_name_for_curve = None
            if fcurve.data_path.startswith("pose.bones"):
                m = bone_name_pattern.search(fcurve.data_path)
                if m:
                    bone_name_for_curve = m.group(1)
            # Use an indexed loop to check interpolation between keyframes
            for i, kp in enumerate(fcurve.keyframe_points):
                frame = _norm_frame(kp.co.x)
                if frame_start <= frame <= frame_end:
                    keyframe_times.add(frame)

                # BEZIER handles produce curves that cannot be represented by
                # Roblox easing styles, so those segments must be densely baked.
                # Other unsupported interpolations (SINE, QUAD, etc.) fall back
                # to Linear easing and do not need dense sampling.
                if (
                    kp.interpolation == "BEZIER"
                    and i + 1 < len(fcurve.keyframe_points)
                ):
                    next_kp = fcurve.keyframe_points[i + 1]
                    start_bezier_frame = int(kp.co.x + 0.5)
                    end_bezier_frame = int(next_kp.co.x + 0.5)

                    # only densify if the segment actually curves
                    if end_bezier_frame - start_bezier_frame > 1:
                        if bone_name_for_curve:
                            bezier_segments[bone_name_for_curve].add(
                                (
                                    min(start_bezier_frame, end_bezier_frame),
                                    max(start_bezier_frame, end_bezier_frame),
                                )
                            )

        # 4. Single Baking Pass
        collected = []
        collected_frames: List[float] = []
        # --- OPTIMIZATION: Avoid redundant set/list conversions. ---
        frame_start = ctx.scene.frame_start
        frame_end = ctx.scene.frame_end
        fps = desired_fps
        full_range = getattr(settings, "rbx_full_range_bake", True)

        # Map of {bone_name: {frame_index: (interpolation, easing)}} built from action fcurves
        per_bone_interpolation: Dict[
            str, Dict[float, Tuple[Optional[str], Optional[str]]]
        ] = {}
        # Map of {bone_name: {frame_index}} for explicit keyframes only
        per_bone_keyframes: Dict[str, Set[float]] = {}
        # Track per-bone interpolation classes by frame so constant fallbacks
        # are local to that bone (not inherited from unrelated controller keys).
        bone_constant_keyframes: Dict[str, Set[float]] = {}
        bone_non_constant_keyframes: Dict[str, Set[float]] = {}
        if action:
            for fcurve in all_fcurves:
                if not fcurve.data_path.startswith("pose.bones"):
                    continue

                match = bone_name_pattern.search(fcurve.data_path)
                if not match:
                    continue

                bone_name_for_curve = match.group(1)
                frame_map = per_bone_interpolation.setdefault(bone_name_for_curve, {})
                keyframe_set = per_bone_keyframes.setdefault(bone_name_for_curve, set())
                const_set = bone_constant_keyframes.setdefault(bone_name_for_curve, set())
                nonconst_set = bone_non_constant_keyframes.setdefault(
                    bone_name_for_curve, set()
                )

                for keyframe_point in fcurve.keyframe_points:
                    frame_idx = _norm_frame(keyframe_point.co.x)
                    
                    # Track keyframes within range for sparse emission
                    if frame_start <= frame_idx <= frame_end:
                        keyframe_set.add(frame_idx)
                        if keyframe_point.interpolation == "CONSTANT":
                            const_set.add(frame_idx)
                        else:
                            nonconst_set.add(frame_idx)

                    # But capture interpolation data even for keys just outside range
                    # so shifted keys still get correct easing
                    if frame_idx < frame_start - 1 or frame_idx > frame_end + 1:
                        continue

                    existing = frame_map.get(frame_idx)
                    if existing is None:
                        frame_map[frame_idx] = (
                            keyframe_point.interpolation,
                            keyframe_point.easing,
                        )
                    else:
                        # Roblox uses one easing style per pose/bone keyframe.
                        # If channels disagree at the same frame, prefer CONSTANT
                        # so intentional hold channels do not get softened.
                        existing_interp, existing_easing = existing
                        new_interp = keyframe_point.interpolation
                        if existing_interp == "CONSTANT" or new_interp == "CONSTANT":
                            if existing_interp != "CONSTANT":
                                frame_map[frame_idx] = (new_interp, keyframe_point.easing)

        # Propagate CONSTANT interpolation across segments so held channels stay
        # constant between keys (important for unparented/world-space/controller rigs).
        for fcurve in all_fcurves:
            if not fcurve.data_path.startswith("pose.bones"):
                continue

            match = bone_name_pattern.search(fcurve.data_path)
            if not match:
                continue

            bone_name_for_curve = match.group(1)
            frame_map = per_bone_interpolation.setdefault(
                bone_name_for_curve, {}
            )

            keypoints = list(fcurve.keyframe_points)
            if len(keypoints) < 2:
                continue

            for i, kp in enumerate(keypoints[:-1]):
                if kp.interpolation != "CONSTANT":
                    continue

                start_frame = int(round(kp.co.x))
                end_frame = int(round(keypoints[i + 1].co.x))
                if end_frame <= start_frame + 1:
                    continue

                seg_start = max(start_frame + 1, frame_start)
                seg_end = min(end_frame, frame_end)
                nonconst_set = bone_non_constant_keyframes.get(bone_name_for_curve, set())
                for frame_idx in range(seg_start, seg_end):
                    existing = frame_map.get(frame_idx)
                    if existing is not None and frame_idx in nonconst_set:
                        continue
                    if existing is None or existing[0] != "CONSTANT":
                        frame_map[frame_idx] = ("CONSTANT", kp.easing)

        # Pre-compute constraint target easing data to avoid nested loops per frame
        constraint_target_easing: Dict[str, Dict[float, Tuple[str, str]]] = {}
        for bone in ao.pose.bones:
            if bone.name in constrained_bones:
                for constraint in bone.constraints:
                    # Handle same-armature COPY constraints by inheriting easing
                    # from the source bone's fcurves in the current action.
                    if (
                        constraint.type in {"COPY_TRANSFORMS", "COPY_LOCATION", "COPY_ROTATION", "COPY_SCALE"}
                        and getattr(constraint, "target", None) == ao
                        and getattr(constraint, "subtarget", None)
                        and action
                    ):
                        source_bone = constraint.subtarget
                        source_interp_map = per_bone_interpolation.get(source_bone)
                        if source_interp_map:
                            frame_map = constraint_target_easing.setdefault(bone.name, {})
                            for frame_idx, interp_pair in source_interp_map.items():
                                if frame_start <= frame_idx <= frame_end and frame_idx not in frame_map:
                                    frame_map[frame_idx] = interp_pair

                    # Handle IK constraints where target is the same armature
                    if constraint.type == "IK" and constraint.chain_count > 0:
                        target_bones = [bone.name]
                        current_bone = bone
                        for _ in range(constraint.chain_count):
                            if current_bone.parent:
                                current_bone = current_bone.parent
                                target_bones.append(current_bone.name)
                            else:
                                break
                        
                        # Look for IK target bone's keyframes in the current action
                        subtarget = getattr(constraint, "subtarget", None)
                        if subtarget and action:
                            found_fcurves = 0
                            for fcurve in all_fcurves:
                                if not fcurve.data_path.startswith("pose.bones"):
                                    continue
                                match = bone_name_pattern.search(fcurve.data_path)
                                if match and match.group(1) == subtarget:
                                    found_fcurves += 1
                                    for kp in fcurve.keyframe_points:
                                        frame_idx = _norm_frame(kp.co.x)
                                        if frame_start <= frame_idx <= frame_end:
                                            for target_bone_name in target_bones:
                                                frame_map = constraint_target_easing.setdefault(
                                                    target_bone_name, {}
                                                )
                                                if frame_idx not in frame_map:
                                                    frame_map[frame_idx] = (
                                                        kp.interpolation,
                                                        kp.easing,
                                                    )
                    
                    # Handle other constraints with external targets
                    elif (
                        hasattr(constraint, "target")
                        and constraint.target
                        and constraint.target != ao
                        and constraint.target.animation_data
                        and constraint.target.animation_data.action
                    ):
                        target_action = constraint.target.animation_data.action
                        target_fcurves = get_action_fcurves(
                            target_action,
                            slot=get_animation_data_action_slot(
                                constraint.target.animation_data,
                                action=target_action,
                            ),
                        )
                        target_bones = [bone.name]
                        for fcurve in target_fcurves:
                            if (
                                fcurve.data_path.startswith("pose.bones")
                                and hasattr(constraint, "subtarget")
                                and constraint.subtarget
                            ):
                                match = bone_name_pattern.search(fcurve.data_path)
                                if match and match.group(1) == constraint.subtarget:
                                    for kp in fcurve.keyframe_points:
                                        frame_idx = _norm_frame(kp.co.x)
                                        if frame_start <= frame_idx <= frame_end:
                                            for target_bone_name in target_bones:
                                                frame_map = constraint_target_easing.setdefault(
                                                    target_bone_name, {}
                                                )
                                                if frame_idx not in frame_map:
                                                    frame_map[frame_idx] = (
                                                        kp.interpolation,
                                                        kp.easing,
                                                    )
        
        # Propagate constraint_target_easing through COPY constraints
        # If bone A copies from bone B, and B has easing info, A should inherit it
        copy_constraint_types = {"COPY_TRANSFORMS", "COPY_LOCATION", "COPY_ROTATION", "COPY_SCALE"}
        
        # Build a map of copy relationships: bone -> source bone
        copy_source_map: Dict[str, str] = {}
        for bone in ao.pose.bones:
            for constraint in bone.constraints:
                if constraint.type in copy_constraint_types:
                    source_bone = getattr(constraint, "subtarget", None)
                    if source_bone:
                        copy_source_map[bone.name] = source_bone
                        break  # take first copy constraint
        
        # Now propagate easing through the chain iteratively
        changed = True
        iterations = 0
        max_iterations = 20  # prevent infinite loops
        while changed and iterations < max_iterations:
            changed = False
            iterations += 1
            for bone_name, source_bone in copy_source_map.items():
                if bone_name in constraint_target_easing:
                    continue  # already has easing info
                if source_bone in constraint_target_easing:
                    # Inherit easing from source bone
                    constraint_target_easing[bone_name] = dict(constraint_target_easing[source_bone])
                    changed = True
        
        def _uses_cyclic(fc):
            try:
                return any(mod.type == "CYCLES" for mod in getattr(fc, "modifiers", []))
            except Exception:
                return False

        def _cyclic_curve_requires_dense(fc):
            """Return True when cyclic curve should not use sparse export.

            Policy:
            - Roblox-supported interpolation styles stay sparse.
            - Unsupported styles fall back to dense baking.
            - Certain cycle modifier modes also force dense baking.
            """
            try:
                for kp in getattr(fc, "keyframe_points", []):
                    if kp.interpolation == "BEZIER":
                        return True

                for mod in getattr(fc, "modifiers", []):
                    if mod.type != "CYCLES":
                        continue
                    mode_before = getattr(mod, "mode_before", "REPEAT")
                    mode_after = getattr(mod, "mode_after", "REPEAT")
                    # Mirror/offset cycle modes are less reliable with sparse-only
                    # replication.
                    risky_modes = {"MIRROR", "REPEAT_OFFSET"}
                    if mode_before in risky_modes or mode_after in risky_modes:
                        return True
            except Exception:
                # If inspection fails, be conservative.
                return True
            return False

        fcurves_with_cycles = [fc for fc in all_fcurves if _uses_cyclic(fc)]
        cyclic_bones: Set[str] = set()
        if fcurves_with_cycles:
            for fc in fcurves_with_cycles:
                if not fc.data_path.startswith("pose.bones"):
                    continue
                match = bone_name_pattern.search(fc.data_path)
                if match:
                    cyclic_bones.add(match.group(1))

        # Prefer sparse replication for cyclic curves, but fall back to dense
        # sampling for risky cyclic setups where sparse evaluation can drift.
        force_cyclic_full_bake = any(
            _cyclic_curve_requires_dense(fc) for fc in fcurves_with_cycles
        )

        if has_constraints_local:
            all_frames_to_bake = list(range(frame_start, frame_end + 1))
        elif force_cyclic_full_bake:
            all_frames_to_bake = range(frame_start, frame_end + 1)
        elif fcurves_with_cycles:
            # For cyclic animations, replicate the base cycle sparsely across the range
            cycle_frames_all: Set[int] = set()
            for fc in fcurves_with_cycles:
                try:
                    for kp in fc.keyframe_points:
                        cycle_frames_all.add(int(round(kp.co.x)))
                except Exception:
                    continue

            extended_frames = set(keyframe_times)

            if cycle_frames_all:
                cycle_sorted = sorted(cycle_frames_all)

                # Determine base cycle interval from the action if available
                base_start = cycle_sorted[0]
                base_end = cycle_sorted[-1]
                if action and action.frame_range:
                    action_start, action_end = action.frame_range
                    base_start = int(math.floor(action_start))
                    base_end = int(math.ceil(action_end - 1e-6))

                frame_step = max(getattr(ctx.scene, "frame_step", 1), 1)
                cycle_len = base_end - base_start
                if cycle_len <= 0:
                    cycle_len = frame_step

                # Collect base cycle frames within one cycle interval
                base_cycle_frames = []
                for fc in fcurves_with_cycles:
                    try:
                        for kp in fc.keyframe_points:
                            frame = int(round(kp.co.x))
                            if base_start - cycle_len <= frame <= base_end:
                                base_cycle_frames.append(frame)
                    except Exception:
                        continue
                base_cycle_frames = sorted(set(base_cycle_frames))

                if not base_cycle_frames:
                    # Fallback: sample densely across the base cycle using frame_step
                    base_cycle_frames = list(
                        range(base_start, base_end + 1, frame_step)
                    )

                if base_end not in base_cycle_frames:
                    base_cycle_frames.append(base_end)
                if base_start not in base_cycle_frames:
                    base_cycle_frames.insert(0, base_start)

                # include previous cycle samples for reference but do not bake them directly
                base_cycle_with_prev = sorted(
                    set(
                        [frame for frame in base_cycle_frames]
                        + [frame - cycle_len for frame in base_cycle_frames]
                    )
                )

                # Replicate backwards to cover frames before the base cycle
                if cycle_len > 0:
                    offset = math.floor((frame_start - base_end) / cycle_len)
                    while base_end + offset * cycle_len >= frame_start:
                        for base_frame in base_cycle_with_prev:
                            new_frame = base_frame + offset * cycle_len
                            if frame_start <= new_frame <= frame_end:
                                extended_frames.add(new_frame)
                        offset -= 1

                # Replicate forward to cover entire range through frame_end
                if cycle_len > 0:
                    offset = math.ceil((frame_start - base_start) / cycle_len)
                    while base_start + offset * cycle_len <= frame_end:
                        for base_frame in base_cycle_with_prev:
                            new_frame = base_frame + offset * cycle_len
                            if frame_start <= new_frame <= frame_end:
                                extended_frames.add(new_frame)
                        offset += 1

            extended_frames.add(frame_end)
            extended_frames.add(frame_start)

            # Expand per_bone_keyframes for each cyclic bone so the sparse emission
            # logic treats replicated frames as explicit keyframes.
            # Also replicate per_bone_interpolation so easing data is available.
            for cbone in cyclic_bones:
                kf_set = per_bone_keyframes.setdefault(cbone, set())
                interp_map = per_bone_interpolation.get(cbone, {})

                # Collect the original base keyframes and their interpolation data
                # for this bone from its cyclic fcurves
                bone_base_keys: Dict[int, Tuple[Optional[str], Optional[str]]] = {}
                for fc in fcurves_with_cycles:
                    if not fc.data_path.startswith("pose.bones"):
                        continue
                    m = bone_name_pattern.search(fc.data_path)
                    if not m or m.group(1) != cbone:
                        continue
                    for kp in fc.keyframe_points:
                        kf = int(round(kp.co.x))
                        if kf not in bone_base_keys:
                            bone_base_keys[kf] = (kp.interpolation, kp.easing)

                # For each extended frame, check if it maps to a base keyframe
                # offset by a multiple of cycle_len.  Boundary frames are
                # included so they receive correct interpolation/easing data
                # (otherwise cyclic bones at frame_start/frame_end fall back
                # to Linear default, causing identity glitches).
                if cycle_len > 0 and bone_base_keys:
                    for ef in extended_frames:
                        for base_kf, base_interp in bone_base_keys.items():
                            diff = ef - base_kf
                            if diff != 0 and diff % cycle_len == 0:
                                kf_set.add(ef)
                                if ef not in interp_map:
                                    interp_map_full = per_bone_interpolation.setdefault(cbone, {})
                                    interp_map_full[ef] = base_interp
                                break

                # Also add the original base keyframes that fall within range
                for base_kf in bone_base_keys:
                    if frame_start <= base_kf <= frame_end:
                        kf_set.add(base_kf)

            all_frames_to_bake = sorted(extended_frames)
            keyframe_times.update(extended_frames)
        elif full_range:
            # Use range object directly to avoid per-frame list allocation
            all_frames_to_bake = range(frame_start, frame_end + 1)
        else:
            all_frames_to_bake = sorted(keyframe_times)

        # Final safety check: ensure all frames are within valid range.
        # Also preserve subframe key times to avoid collapsing tightly spaced keys.
        if isinstance(all_frames_to_bake, range):
            base_frames = [_norm_frame(f) for f in all_frames_to_bake]
        else:
            base_frames = [_norm_frame(f) for f in all_frames_to_bake if frame_start <= f <= frame_end]

        subframe_keys = [
            _norm_frame(f)
            for f in keyframe_times
            if frame_start <= f <= frame_end and abs(float(f) - round(float(f))) > 1e-8
        ]
        # Collect per-bone dense frames from bezier/unsupported-interpolation segments
        # so only bones that need dense sampling are evaluated at those frames.
        bezier_dense_frames = set()
        for bone_segs in bezier_segments.values():
            for seg_start, seg_end in bone_segs:
                bezier_dense_frames.update(
                    frame
                    for frame in range(seg_start + 1, seg_end)
                    if frame_start <= frame <= frame_end
                )
        if subframe_keys or bezier_dense_frames:
            all_frames_to_bake = sorted(
                frame
                for frame in set(base_frames).union(subframe_keys).union(bezier_dense_frames)
                if frame_start <= frame <= frame_end
            )
        else:
            all_frames_to_bake = base_frames

        # debug: frame count chosen
        try:
            pass
        except Exception:
            pass

        len(all_frames_to_bake)
        shared_cache = {}
        motor_state_reuse: Dict[str, List[float]] = {}
        deform_state_reuse: Dict[str, List[float]] = {}
        last_baked_states: Dict[str, List[Any]] = {}
        last_face_state: Optional[Dict[str, float]] = None
        current_full_pose: Dict[str, List[float]] = {}
        final_kf_state: Dict[str, List[Any]] = {}

        def _bone_state_equivalent(
            prev_values: List[Any], new_values: List[Any], tol: float = 1e-6
        ) -> bool:
            if len(prev_values) != len(new_values):
                return False

            prev_components, prev_style, prev_direction = prev_values
            new_components, new_style, new_direction = new_values

            if prev_style != new_style or prev_direction != new_direction:
                return False

            if len(prev_components) != len(new_components):
                return False

            for idx in range(len(prev_components)):
                if abs(prev_components[idx] - new_components[idx]) > tol:
                    return False

            return True

        def _lookup_interp_for_frame(
            interp_map: Optional[Dict[float, Tuple[Optional[str], Optional[str]]]],
            frame: float,
        ) -> Tuple[Optional[str], Optional[str]]:
            if not interp_map:
                return None, None
            cached = interp_map.get(frame)
            if cached:
                return cached
            most_recent_frame = None
            for kf_frame in interp_map.keys():
                if kf_frame < frame and (most_recent_frame is None or kf_frame > most_recent_frame):
                    most_recent_frame = kf_frame
            if most_recent_frame is not None:
                return interp_map[most_recent_frame]
            return None, None

        def _frame_in_set(frames: Optional[Set[float]], frame: float, eps: float = 1e-5) -> bool:
            if not frames:
                return False
            if frame in frames:
                return True
            for f in frames:
                if abs(f - frame) <= eps:
                    return True
            return False

        # Set to first frame to ensure proper initialization
        # frame_set() automatically updates the depsgraph, so no need for explicit update
        ctx.scene.frame_set(frame_start)

        keyframe_times_set = set(keyframe_times)
        for i, frame in enumerate(all_frames_to_bake):
            frame_int = int(math.floor(frame))
            frame_sub = float(frame - frame_int)
            ctx.scene.frame_set(frame_int, subframe=frame_sub)
            # --- OPTIMIZATION: Pass the existing depsgraph instead of re-evaluating. ---
            ao_eval_for_frame = ao.evaluated_get(depsgraph)

            current_full_pose.clear()
            current_full_pose.update(
                serialize_combined_animation_state(
                    ao,
                    ao_eval_for_frame,
                    depsgraph,
                    run_deform_path,
                    is_skinned_rig,
                    back_trans_cached,
                    world_transform_cached,
                    scale_factor_cached,
                    shared_cache,
                    motor_state_reuse,
                    deform_state_reuse,
                    excluded_face_bones,
                )
            )

            if is_skinned_rig and last_baked_states:
                for bone_name in last_baked_states:
                    if bone_name not in current_full_pose:
                        current_full_pose[bone_name] = identity_cf

            final_kf_state.clear()
            is_boundary_frame = frame == frame_start or frame == frame_end
            face_kf_state, last_face_state = _serialize_face_control_state_for_frame(
                ao,
                face_export_context,
                float(frame),
                last_face_state,
            )

            for bone_name in animated_bones:
                bone_keyframes = per_bone_keyframes.get(bone_name)
                constraint_keyframes = constraint_target_easing.get(bone_name)
                has_explicit_easing = (
                    bone_name in per_bone_interpolation
                    or bone_name in constraint_target_easing
                )
                # For cyclic bones, we only care about frames where THIS bone has keyframes
                bone_kfs = per_bone_keyframes.get(bone_name, set())
                is_cyclic_key = bool(cyclic_bones) and bone_name in cyclic_bones and _frame_in_set(bone_kfs, frame)
                # Cyclic bones should also be emitted at boundary frames
                is_cyclic_boundary = bool(cyclic_bones) and bone_name in cyclic_bones and is_boundary_frame
                if (
                    _frame_in_set(bone_keyframes, frame)
                    or _frame_in_set(set(constraint_keyframes.keys()) if constraint_keyframes else None, frame)
                    or is_cyclic_key
                    or is_cyclic_boundary
                ):
                    # If an animated bone is at its rest pose on an explicit keyframe,
                    # it won't be in current_full_pose. We need to add it back with an
                    # identity transform to ensure the keyframe is not dropped.
                    if bone_name not in current_full_pose:
                        current_full_pose[bone_name] = identity_cf

            # Also ensure constrained bones are included even if at identity
            for bone_name in constrained_bones:
                if bone_name not in current_full_pose:
                    current_full_pose[bone_name] = identity_cf

            # Also ensure non-inheriting bones are included
            for bone_name in non_inheriting_bones:
                if bone_name not in current_full_pose:
                    current_full_pose[bone_name] = identity_cf

            roblox_style, roblox_direction = None, None
            for bone_name, cframe_data in current_full_pose.items():
                is_constrained = bone_name in constrained_bones
                is_non_inheriting = bone_name in non_inheriting_bones
                is_animated = bone_name in animated_bones
                is_cyclic_forced = force_cyclic_full_bake and bone_name in cyclic_bones
                bone_keyframes = per_bone_keyframes.get(bone_name)
                constraint_keyframes = constraint_target_easing.get(bone_name)
                # For cyclic bones, only consider frames where THIS bone has keyframes
                is_cyclic_key = bool(cyclic_bones) and bone_name in cyclic_bones and _frame_in_set(bone_keyframes, frame)
                is_sparse_key = (
                    _frame_in_set(bone_keyframes, frame)
                    or _frame_in_set(set(constraint_keyframes.keys()) if constraint_keyframes else None, frame)
                    or is_cyclic_key
                )

                # For cyclic bones, bake boundary frames since the animation
                # must cover the entire scene range.
                is_cyclic_boundary = bool(cyclic_bones) and bone_name in cyclic_bones and is_boundary_frame
                is_boundary_bake = (is_boundary_frame or is_cyclic_boundary) and is_animated

                # Determine whether this bone should be baked on this frame
                should_bake = False

                if is_constrained:
                    should_bake = True
                elif is_non_inheriting:
                    should_bake = True
                elif is_skinned_rig:
                    should_bake = True
                elif is_cyclic_forced:
                    should_bake = True
                elif is_boundary_bake:
                    should_bake = True
                elif is_animated and is_sparse_key:
                    should_bake = True
                elif is_animated:
                    # Check whether this frame falls within any BEZIER segment for this bone
                    for start_frame, end_frame in bezier_segments.get(bone_name, set()):
                        if start_frame <= frame <= end_frame:
                            should_bake = True
                            break

                if not should_bake:
                    continue

                # Look up interpolation from pre-cached fcurve data
                # Check exact frame first, then look for the most recent keyframe before this one
                interpolation, easing = None, None
                if bone_name in per_bone_interpolation:
                    interpolation, easing = _lookup_interp_for_frame(
                        per_bone_interpolation.get(bone_name),
                        frame,
                    )

                # Non-inheriting/world-space bones often have no direct fcurves.
                # In that case, borrow interpolation from their original parent
                # (typically the master/controller bone) so Constant holds are
                # preserved instead of defaulting to Linear smoothing.
                if interpolation is None and is_non_inheriting:
                    source_bone = worldspace_parent_map.get(bone_name)
                    if source_bone:
                        interpolation, easing = _lookup_interp_for_frame(
                            per_bone_interpolation.get(source_bone),
                            frame,
                        )
                        if interpolation is None and source_bone in constraint_target_easing:
                            interpolation, easing = _lookup_interp_for_frame(
                                constraint_target_easing.get(source_bone),
                                frame,
                            )

                # Respect explicit keyframe interpolation when available. Fall back to Linear only when
                # Blender does not provide interpolation data (e.g. constraint-only output).
                previous_state = last_baked_states.get(bone_name)

                # If still no interpolation and this is a constrained bone, use pre-computed constraint target easing
                if not interpolation and is_constrained and bone_name in constraint_target_easing:
                    cached_constraint = constraint_target_easing[bone_name].get(frame)
                    if cached_constraint:
                        interpolation, easing = cached_constraint

                if interpolation:
                    roblox_style, roblox_direction = map_blender_to_roblox_easing(
                        interpolation, easing
                    )
                elif previous_state is not None:
                    roblox_style, roblox_direction = (
                        previous_state[1],
                        previous_state[2],
                    )
                else:
                    roblox_style, roblox_direction = ("Linear", "Out")

                # If constrained bone has no interpolation but frame keys are all constant,
                # treat as constant to avoid blending between rows of constant keys.
                bone_const_frames = bone_constant_keyframes.get(bone_name, set())
                bone_nonconst_frames = bone_non_constant_keyframes.get(
                    bone_name, set()
                )
                if (
                    is_constrained
                    and interpolation is None
                    and frame in bone_const_frames
                    and frame not in bone_nonconst_frames
                ):
                    interpolation = "CONSTANT"
                    roblox_style, roblox_direction = ("Constant", "Out")

                # If we're between constant keys (or at boundary) with no interpolation,
                # clamp the pose to the previous constant to avoid blended samples.
                if (
                    previous_state is not None
                    and previous_state[1] == "Constant"
                    and interpolation is None
                    and not is_sparse_key
                ):
                    cframe_data = previous_state[0]
                    roblox_style, roblox_direction = (
                        previous_state[1],
                        previous_state[2],
                    )

                # For constrained mapped easing styles, only emit on keys/boundaries
                # (excluding BEZIER which needs dense sampling)
                if (
                    nla_single_action is not None
                    and is_constrained
                    and not is_non_inheriting
                    and has_explicit_easing
                    and not is_sparse_key
                    and not is_boundary_frame
                ):
                    if interpolation in {"CONSTANT", "LINEAR", "CUBIC", "BOUNCE", "ELASTIC"}:
                        continue
                    if (
                        interpolation is None
                        and previous_state is not None
                        and previous_state[1] in {"Constant", "Linear", "CubicV2", "Bounce", "Elastic"}
                    ):
                        continue

                # Avoid emitting boundary frames for constrained mapped easing when no key exists
                if (
                    nla_single_action is not None
                    and is_constrained
                    and not is_non_inheriting
                    and has_explicit_easing
                    and is_boundary_frame
                    and not is_sparse_key
                    and previous_state is not None
                    and previous_state[1] in {"Constant", "Linear", "CubicV2", "Bounce", "Elastic"}
                    and interpolation is None
                ):
                    continue

                # For CONSTANT holds, clamp to previous pose to avoid blending.
                # For cyclic boundary frames (e.g. frame_end) that aren't explicit
                # keys, blender's cyclic modifier wraps the evaluation into the
                # NEXT cycle, producing a value jump.  Clamp those too.
                if (
                    previous_state is not None
                    and not is_sparse_key
                    and not is_constrained
                    and (interpolation == "CONSTANT" or roblox_style == "Constant")
                    and (not is_boundary_frame or is_cyclic_boundary)
                ):
                    cframe_data = previous_state[0]

                # Copy cframe data to avoid cross-frame mutation when caches reuse lists
                cframe_copy = list(cframe_data)
                candidate_state = [cframe_copy, roblox_style, roblox_direction]

                is_constant_hold = (
                    interpolation == "CONSTANT"
                    and not is_sparse_key
                    and not is_boundary_frame
                    and not is_constrained
                )

                if is_constant_hold:
                    if previous_state is not None:
                        continue

                # Skip unchanged states for unconstrained bones.
                # We still evaluate cyclic bones every frame for correctness,
                # but only emit frames where the sampled pose actually changes.
                # Constrained bones must be included on every frame for accurate IK playback.
                if not is_sparse_key and not is_boundary_frame and not is_constrained and not is_non_inheriting and not is_cyclic_boundary:
                    if previous_state and _bone_state_equivalent(
                        previous_state, candidate_state
                    ):
                        continue

                final_kf_state[bone_name] = candidate_state

            # Roblox treats a Pose absent from a Keyframe as CFrame.identity,
            # not as "hold previous."  When siblings have staggered keys a
            # constant-hold bone would be missing from keyframes created by
            # its siblings, snapping to identity.  Ensure every bone that is
            # mid-constant-hold appears in every emitted keyframe.
            if final_kf_state:
                for held_bone, held_state in last_baked_states.items():
                    if held_bone in final_kf_state:
                        continue
                    if held_state[1] != "Constant":
                        continue
                    # Constrained/non-inheriting bones should not be force-held
                    # by sparse carry-forward because they are evaluated explicitly.
                    if held_bone in constrained_bones or held_bone in non_inheriting_bones:
                        continue
                    final_kf_state[held_bone] = [
                        list(held_state[0]),
                        held_state[1],
                        held_state[2],
                    ]

            if final_kf_state or face_kf_state:
                time_in_seconds = (frame - frame_start) / fps
                # Store a copy of the frame state to avoid reuse mutation across frames
                keyframe_payload: Dict[str, Any] = {
                    "t": time_in_seconds,
                    "kf": dict(final_kf_state),
                }
                if face_kf_state:
                    keyframe_payload["fc"] = face_kf_state
                collected.append(keyframe_payload)
                collected_frames.append(frame)
                for baked_bone, state in final_kf_state.items():
                    last_baked_states[baked_bone] = state

        # Ensure we end with a hold keyframe at the final frame to prevent early resets
        # Only add bones that don't already have a key at the end frame
        if collected and last_baked_states:
            last_recorded_frame = collected_frames[-1] if collected_frames else None
            if last_recorded_frame is None or last_recorded_frame < frame_end:
                end_time = (frame_end - frame_start) / fps
                hold_state = {}
                for baked_bone, state in last_baked_states.items():
                    # Check if this bone already has a key at the end frame
                    bone_kfs = per_bone_keyframes.get(baked_bone, set())
                    if frame_end not in bone_kfs:
                        # Only add end hold for bones that don't have a key there
                        hold_state[baked_bone] = [list(state[0]), state[1], state[2]]
                if hold_state:
                    collected.append({"t": end_time, "kf": hold_state})
                    collected_frames.append(frame_end)

        # 4.5. Safety sort to ensure keyframes are always ordered correctly
        # This prevents rare floating point precision issues from causing unordered keyframes
        if collected:
            combined = list(zip(collected, collected_frames))
            combined.sort(key=lambda item: item[0]["t"])
            collected = [item[0] for item in combined]
            collected_frames = [item[1] for item in combined]

        # 5. Optimization - remove consecutive duplicate keyframes.
        if len(collected) > 2:

            def _kf_states_equivalent(
                prev_keyframe: Dict[str, Any],
                new_keyframe: Dict[str, Any],
                tol: float = 1e-6,
            ) -> bool:
                prev_state = prev_keyframe.get("kf", {})
                new_state = new_keyframe.get("kf", {})
                if prev_state.keys() != new_state.keys():
                    return False

                for bone_name, prev_values in prev_state.items():
                    new_values = new_state.get(bone_name)
                    if new_values is None:
                        return False

                    if not _bone_state_equivalent(prev_values, new_values, tol):
                        return False

                prev_fc = prev_keyframe.get("fc", {})
                new_fc = new_keyframe.get("fc", {})
                if prev_fc.keys() != new_fc.keys():
                    return False
                for control_name, prev_values in prev_fc.items():
                    new_values = new_fc.get(control_name)
                    if new_values is None:
                        return False
                    if prev_values.get("easingStyle") != new_values.get("easingStyle"):
                        return False
                    if prev_values.get("easingDirection") != new_values.get("easingDirection"):
                        return False
                    if abs(float(prev_values.get("value", 0.0)) - float(new_values.get("value", 0.0))) > tol:
                        return False

                return True

            optimized_entries = [(collected[0], collected_frames[0])]
            for i in range(1, len(collected) - 1):
                kf_data = collected[i]
                frame_idx = collected_frames[i]
                is_explicit_key = _frame_in_set(keyframe_times_set, frame_idx)

                if is_explicit_key:
                    optimized_entries.append((kf_data, frame_idx))
                    continue

                if not _kf_states_equivalent(optimized_entries[-1][0], kf_data):
                    optimized_entries.append((kf_data, frame_idx))

            optimized_entries.append((collected[-1], collected_frames[-1]))
            collected = [entry for entry, _ in optimized_entries]
            collected_frames = [frame for _, frame in optimized_entries]

        final_duration = (
            (frame_end - frame_start) / desired_fps if frame_end >= frame_start else 0
        )
        result = {"t": final_duration, "kfs": collected}

    else:
        # No NLA, no action, and no constraints. Bake a single frame of the current pose.
        # Also grab the evaluated state for the single-frame pose bake
        ao_eval_for_frame = ao.evaluated_get(depsgraph)
        state = serialize_combined_animation_state(
            ao,
            ao_eval_for_frame,
            depsgraph,
            run_deform_path,
            is_skinned_rig,
            back_trans_cached,
            world_transform_cached,
            scale_factor_cached,
            excluded_deform_bones=excluded_face_bones,
        )
        # For consistency with other code paths, wrap with default easing
        wrapped_state = {}
        for bone_name, cframe_data in state.items():
            wrapped_state[bone_name] = [cframe_data, "Linear", "Out"]
        keyframe_payload: Dict[str, Any] = {"t": 0, "kf": wrapped_state}
        face_state, _ = _serialize_face_control_state_for_frame(
            ao,
            face_export_context,
            float(ctx.scene.frame_start),
        )
        if face_state:
            keyframe_payload["fc"] = face_state
        collected = [keyframe_payload]
        result = {"t": 0, "kfs": collected}

    if is_skinned_rig:
        result["is_deform_bone_rig"] = True
        result["bone_hierarchy"] = extract_bone_hierarchy(ao_eval)

    # Export FPS metadata for consumers (e.g., Roblox) that want to preserve timing
    try:
        scene = ctx.scene
        object_scale_components = _object_scale_components(ao)
        object_scale_uniform = _scale_values_are_uniform(object_scale_components)
        object_scale_axes = list(object_scale_components or (1.0, 1.0, 1.0))
        auto_deform_scale = getattr(settings, "rbx_auto_deform_scale", True)
        scene_unit_scale = resolve_scene_unit_scale_factor(settings, scene)
        calibrated_target_multiplier = float(target_scale_multiplier or 1.0)
        deform_scale_mode = (
            "auto_calibrated"
            if auto_deform_scale and target_scale_calibration
            else "auto" if auto_deform_scale else "manual"
        )
        result["export_info"] = {
            "fps": float(desired_fps),
            "fps_base": float(getattr(scene.render, "fps_base", 1.0) or 1.0),
            "frame_start": int(getattr(scene, "frame_start", 0)),
            "frame_end": int(getattr(scene, "frame_end", 0)),
            "frame_step": int(getattr(scene, "frame_step", 1) or 1),
            "deform_scale_mode": deform_scale_mode,
            "deform_scale_factor": float(scale_factor_cached),
            "deform_target_scale_multiplier": float(calibrated_target_multiplier),
            "scene_unit_scale": float(scene_unit_scale),
            "deform_target_scale_sample_count": int(
                target_scale_calibration.get("sample_count", 0)
                if target_scale_calibration
                else 0
            ),
            "armature_object_scale": float(_uniform_object_scale(ao) or 1.0),
            "armature_object_scale_axes": [float(value) for value in object_scale_axes],
            "armature_object_scale_uniform": bool(object_scale_uniform),
            "deform_position_scale_reliable": bool(
                (not auto_deform_scale) or object_scale_uniform
            ),
            "time_unit": "seconds",
        }
        if auto_deform_scale and not object_scale_uniform:
            result["export_info"]["deform_scale_warning"] = (
                "Auto deform scale only supports uniform armature object scale. "
                "Apply scale or use manual scale for nonuniform/scaled-shear rigs."
            )
        if target_scale_calibration:
            result["export_info"]["deform_target_scale_source_sample_count"] = int(
                target_scale_calibration.get("source_sample_count", 0)
            )
            result["export_info"]["deform_target_scale_target_sample_count"] = int(
                target_scale_calibration.get("target_sample_count", 0)
            )
        elif is_skinned_rig and auto_deform_scale and not target_bone_rest:
            result["export_info"]["deform_target_scale_warning"] = (
                "No target rig rest data was provided for this skinned export. "
                "Scale is using armature object scale only; live rig calibration "
                "was skipped."
            )
        elif target_bone_rest and auto_deform_scale:
            result["export_info"]["deform_target_scale_warning"] = (
                "Target rig rest data was provided, but no matching nonzero bone "
                "distances were found for scale calibration."
            )
        if is_skinned_rig:
            print(
                "Blender Addon: Deform export scale "
                f"mode={deform_scale_mode} "
                f"factor={float(scale_factor_cached):.6f} "
                f"object_scale={float(_uniform_object_scale(ao) or 1.0):.6f} "
                f"target_multiplier={float(calibrated_target_multiplier):.6f} "
                f"samples={int(result['export_info']['deform_target_scale_sample_count'])} "
                f"target_rest={'yes' if bool(target_bone_rest) else 'no'}"
            )
            scale_warning = (
                result["export_info"].get("deform_target_scale_warning")
                or result["export_info"].get("deform_scale_warning")
            )
            if scale_warning:
                print(f"Blender Addon: {scale_warning}")
    except Exception:
        pass

    # Restore the original frame
    ctx.scene.frame_set(original_frame)

    # Ensure we always return a valid result, even for empty/static animations
    if not result.get("kfs"):
        # Return a minimal valid animation with the current pose
        ao_eval_for_frame = ao.evaluated_get(depsgraph)
        state = serialize_combined_animation_state(
            ao,
            ao_eval_for_frame,
            depsgraph,
            run_deform_path,
            is_skinned_rig,
            back_trans_cached,
            world_transform_cached,
            scale_factor_cached,
            excluded_deform_bones=excluded_face_bones,
        )
        wrapped_state = {}
        for bone_name, cframe_data in state.items():
            wrapped_state[bone_name] = [cframe_data, "Linear", "Out"]
        keyframe_payload = {"t": 0, "kf": wrapped_state}
        face_state, _ = _serialize_face_control_state_for_frame(
            ao,
            face_export_context,
            float(ctx.scene.frame_start),
        )
        if face_state:
            keyframe_payload["fc"] = face_state
        result["kfs"] = [keyframe_payload]
        result["t"] = 0

    return result
