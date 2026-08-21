"""
validation operators and viewport overlay for roblox animation validation.

performs comprehensive validation checks including:
- per-frame world displacement of each limb (bone) against max studs/frame threshold
- animation duration limits (max 10 seconds)
- bounds checking (max 5 studs from root)
- rotation validation for proper bone constraints
- draws violation segments and warnings in the 3d viewport
"""

import bpy
from bpy.types import Operator
from mathutils import Vector
from typing import Any, Dict, List, Optional, Set, Tuple

from ..animation.serialization import (
    is_deform_bone_rig,
    resolve_manual_deform_rig_scale_factor,
    resolve_deform_rig_scale_factor,
)
from ..core.utils import get_scene_fps, get_object_by_name
import math


# global state for the draw overlay
_violation_draw_handler = None  # lines
_violation_label_draw_handler = None  # labels
_keyframe_points_draw_handler = None  # keyframe markers
_floor_limit_draw_handler = None  # floor limit plane
_violation_segments: List[
    Tuple[Vector, Vector, int, str, bool, bool, float]
] = []  # (start, end, frame, bone_name, key_prev, key_curr, studs)
_bone_color_cache: Dict[str, Tuple[float, float, float, float]] = {}
_armature_name_for_cache: str = ""
_keyframe_points: List[Tuple[Vector, str, int]] = []  # (location, bone_name, frame)
_below_root_violations: List[Tuple[Vector, Vector, str]] = []  # (bone_pos, floor_pos, bone_name)
_floor_limit_z: Optional[float] = None  # world Z of floor limit

# Roblox animation validation constants (matching Lua script)
ANIM_MAX_DURATION = 10.0  # seconds
ANIM_MAX_BOUNDS = 5.0  # studs from root
ANIM_MAX_BELOW_ROOT = 3.1  # max studs below root Y
ANIM_MAX_DELTA = 1.0  # studs per frame
ANIM_FPS = 30.0  # target fps
_VALIDATION_SCALE_EPSILON = 1e-6

# Rest joint distances sampled from the internal Studio Emote Test Dummy (scale 1).
_INTERNAL_EMOTE_R15_REST: Dict[str, Dict[str, Any]] = {
    "lowertorso": {"parent": "humanoidrootpart", "distance": 1.0},
    "uppertorso": {"parent": "lowertorso", "distance": 0.40054893493652346},
    "head": {"parent": "uppertorso", "distance": 1.6980342864990235},
    "leftupperarm": {"parent": "uppertorso", "distance": 1.7425315380096436},
    "leftlowerarm": {"parent": "leftupperarm", "distance": 0.9213295578956604},
    "lefthand": {"parent": "leftlowerarm", "distance": 0.8069992065429688},
    "rightupperarm": {"parent": "uppertorso", "distance": 1.7425315380096436},
    "rightlowerarm": {"parent": "rightupperarm", "distance": 0.9216863512992859},
    "righthand": {"parent": "rightlowerarm", "distance": 0.8068838119506836},
    "leftupperleg": {"parent": "lowertorso", "distance": 0.49642184376716616},
    "leftlowerleg": {"parent": "leftupperleg", "distance": 0.9207401275634766},
    "leftfoot": {"parent": "leftlowerleg", "distance": 1.0096755027770997},
    "rightupperleg": {"parent": "lowertorso", "distance": 0.49642184376716616},
    "rightlowerleg": {"parent": "rightupperleg", "distance": 0.9205656051635742},
    "rightfoot": {"parent": "rightlowerleg", "distance": 1.0098447799682618},
}

_INTERNAL_EMOTE_R15_FLOOR_BONES = (
    "lowertorso",
    "leftupperleg",
    "leftlowerleg",
    "leftfoot",
    "rightupperleg",
    "rightlowerleg",
    "rightfoot",
)
_MIN_CANONICAL_VALIDATION_BONES = 8


def _normalize_bone_name(name: str) -> str:
    return "".join(ch.lower() for ch in (name or "") if ch.isalnum())


def _median(values: List[float]) -> Optional[float]:
    if not values:
        return None
    sorted_values = sorted(values)
    middle = len(sorted_values) // 2
    if len(sorted_values) % 2 == 1:
        return sorted_values[middle]
    return 0.5 * (sorted_values[middle - 1] + sorted_values[middle])


def _resolve_validation_scale_from_rest_samples(
    source_samples: Dict[str, Dict[str, Any]],
    canonical_samples: Dict[str, Dict[str, Any]],
    preferred_bone_names: Optional[Tuple[str, ...]] = None,
) -> Optional[Tuple[float, int]]:
    ratios: List[float] = []
    if preferred_bone_names:
        canonical_items = [
            (bone_name, canonical_samples[bone_name])
            for bone_name in preferred_bone_names
            if bone_name in canonical_samples
        ]
    else:
        canonical_items = list(canonical_samples.items())

    for bone_name, canonical_entry in canonical_items:
        source_entry = source_samples.get(bone_name)
        if not source_entry:
            continue

        source_parent = source_entry.get("parent")
        canonical_parent = canonical_entry.get("parent")
        if canonical_parent and source_parent and canonical_parent != source_parent:
            continue

        try:
            source_distance = float(source_entry.get("distance") or 0.0)
            canonical_distance = float(canonical_entry.get("distance") or 0.0)
        except (TypeError, ValueError):
            continue

        if (
            source_distance <= _VALIDATION_SCALE_EPSILON
            or canonical_distance <= _VALIDATION_SCALE_EPSILON
        ):
            continue

        ratio = source_distance / canonical_distance
        if not math.isfinite(ratio) or ratio <= _VALIDATION_SCALE_EPSILON:
            continue

        ratios.append(ratio)

    median_ratio = _median(ratios)
    if median_ratio is None:
        return None

    return median_ratio, len(ratios)


def _collect_validation_rest_scale_samples(
    armature_obj: "bpy.types.Object",
) -> Dict[str, Dict[str, Any]]:
    samples: Dict[str, Dict[str, Any]] = {}
    if not armature_obj or armature_obj.type != "ARMATURE":
        return samples

    settings = getattr(bpy.context.scene, "rbx_anim_settings", None)
    force_deform = getattr(settings, "force_deform_bone_serialization", False)
    is_deform = is_deform_bone_rig(armature_obj) or force_deform

    world_mat = armature_obj.matrix_world
    rest_positions: Dict[str, Vector] = {}
    relevant_bones: Dict[str, "bpy.types.Bone"] = {}
    for bone in armature_obj.data.bones:
        if is_deform:
            if not bone.use_deform:
                continue
        elif not bool(bone.get("is_transformable", False)):
            continue

        relevant_bones[bone.name] = bone
        rest_positions[bone.name] = world_mat @ bone.head_local

    for bone_name, bone in relevant_bones.items():
        parent = bone.parent
        if parent is None or parent.name not in rest_positions:
            continue

        distance = float((rest_positions[bone_name] - rest_positions[parent.name]).length)
        if distance <= _VALIDATION_SCALE_EPSILON:
            continue

        samples[_normalize_bone_name(bone_name)] = {
            "parent": _normalize_bone_name(parent.name),
            "distance": distance,
        }

    return samples


def _fallback_validation_units_per_stud(
    armature_obj: "bpy.types.Object",
    settings: Optional[Any],
) -> Tuple[float, str, int]:
    force_deform = getattr(settings, "force_deform_bone_serialization", False)
    is_deform = is_deform_bone_rig(armature_obj) or force_deform
    if is_deform:
        auto_scale = getattr(settings, "rbx_auto_deform_scale", True)
        if auto_scale:
            scale_factor = float(
                resolve_deform_rig_scale_factor(armature_obj, settings) or 1.0
            )
            if abs(scale_factor) > _VALIDATION_SCALE_EPSILON:
                return 1.0 / abs(scale_factor), "deform_export_fallback", 0
        else:
            manual_scale = float(
                resolve_manual_deform_rig_scale_factor(settings) or 1.0
            )
            if abs(manual_scale) > _VALIDATION_SCALE_EPSILON:
                return abs(manual_scale), "manual", 0

    return 1.0, "scene_units", 0


def _resolve_validation_units_per_stud(
    armature_obj: "bpy.types.Object",
    settings: Optional[Any],
    preferred_bone_names: Optional[Tuple[str, ...]] = None,
) -> Tuple[float, str, int]:
    source_samples = _collect_validation_rest_scale_samples(armature_obj)
    resolved = _resolve_validation_scale_from_rest_samples(
        source_samples,
        _INTERNAL_EMOTE_R15_REST,
        preferred_bone_names=preferred_bone_names,
    )
    if resolved is not None:
        units_per_stud, sample_count = resolved
        return units_per_stud, "internal_r15", sample_count

    return _fallback_validation_units_per_stud(armature_obj, settings)


def _accumulate_floor_limit_z(
    current_floor_limit_z: Optional[float],
    candidate_floor_z: Optional[float],
) -> Optional[float]:
    if candidate_floor_z is None:
        return current_floor_limit_z
    if current_floor_limit_z is None:
        return candidate_floor_z
    return min(current_floor_limit_z, candidate_floor_z)


def _resolve_validation_root_bone_name(
    pose_bones: Any,
) -> Optional[str]:
    preferred_names = (
        "HumanoidRootPart",
        "humanoidrootpart",
        "LowerTorso",
        "lowertorso",
        "Torso",
        "torso",
        "UpperTorso",
        "uppertorso",
        "Root",
        "root",
    )

    for name in preferred_names:
        try:
            pbone = pose_bones.get(name)
        except AttributeError:
            pbone = None
        if pbone is not None:
            return pbone.name

    for pbone in pose_bones:
        if getattr(pbone, "parent", None) is None:
            return pbone.name

    return None


def _resolve_validation_body_bone_name_set(
    bone_names: List[str],
) -> Optional[Set[str]]:
    canonical_matches: Dict[str, str] = {}
    for bone_name in bone_names:
        normalized_name = _normalize_bone_name(bone_name)
        if normalized_name not in _INTERNAL_EMOTE_R15_REST:
            continue
        canonical_matches.setdefault(normalized_name, bone_name)

    if len(canonical_matches) < _MIN_CANONICAL_VALIDATION_BONES:
        return None

    return set(canonical_matches.values())


def _get_bone_display_color(
    pbone: "bpy.types.PoseBone",
) -> Tuple[float, float, float, float]:
    group = getattr(pbone, "bone_group", None)
    if group is not None:
        colors = getattr(group, "colors", None)
        if colors is not None and hasattr(colors, "normal"):
            col = colors.normal
            try:
                # some versions return Color, convert to 4-tuple
                return (col[0], col[1], col[2], 1.0)
            except Exception:
                pass
    # fallback deterministic color from name
    import random

    rnd = random.Random(hash(pbone.name) & 0xFFFFFFFF)
    r, g, b = rnd.random(), rnd.random(), rnd.random()
    return (r * 0.8 + 0.2, g * 0.8 + 0.2, b * 0.8 + 0.2, 1.0)


def _draw_motionpath_violations():
    """viewport draw callback to render violation segments as red lines."""
    if not _violation_segments:
        return
    try:
        import gpu
        from gpu_extras.batch import batch_for_shader
    except Exception:
        return

    # shader fallback across blender versions
    shader = None
    for name in ("UNIFORM_COLOR", "3D_UNIFORM_COLOR", "FLAT_COLOR"):
        try:
            shader = gpu.shader.from_builtin(name)
            break
        except Exception:
            continue
    if shader is None:
        return

    gpu.state.blend_set("ALPHA")
    try:
        gpu.state.line_width_set(2.0)
    except Exception:
        pass

    # build or refresh bone color cache for active armature
    settings = getattr(bpy.context.scene, "rbx_anim_settings", None)
    arm_name = settings.rbx_anim_armature if settings else None
    global _armature_name_for_cache
    if arm_name != _armature_name_for_cache or not _bone_color_cache:
        _bone_color_cache.clear()
        arm = get_object_by_name(arm_name)
        if arm and arm.type == "ARMATURE":
            for pb in arm.pose.bones:
                _bone_color_cache[pb.name] = _get_bone_display_color(pb)
        _armature_name_for_cache = arm_name

    # batch by color to reduce shader binds
    by_color: Dict[Tuple[float, float, float, float], List[Vector]] = {}
    for start, end, _frame, bone_name, _kp, _kc, _studs in _violation_segments:
        color = _bone_color_cache.get(bone_name, (1.0, 0.0, 0.0, 1.0))
        coords = by_color.setdefault(color, [])
        coords.append(start)
        coords.append(end)

    for color, coords in by_color.items():
        if not coords:
            continue
        batch = batch_for_shader(shader, "LINES", {"pos": coords})
        shader.bind()
        shader.uniform_float("color", color)
        batch.draw(shader)

    gpu.state.blend_set("NONE")


def _draw_floor_limit():
    """Draw floor limit plane and vertical drop lines for below-root violations."""
    if not _below_root_violations and _floor_limit_z is None:
        return
    try:
        import gpu
        from gpu_extras.batch import batch_for_shader
    except Exception:
        return

    shader = None
    for name in ("UNIFORM_COLOR", "3D_UNIFORM_COLOR", "FLAT_COLOR"):
        try:
            shader = gpu.shader.from_builtin(name)
            break
        except Exception:
            continue
    if shader is None:
        return

    gpu.state.blend_set("ALPHA")
    try:
        gpu.state.line_width_set(2.0)
    except Exception:
        pass

    # Draw floor limit as dashed grid lines (orange/red)
    if _floor_limit_z is not None:
        floor_color = (1.0, 0.3, 0.1, 0.5)
        grid_size = 3.0
        grid_lines = []
        for i in range(-5, 6):
            offset = i * grid_size / 5
            grid_lines.append(Vector((-grid_size, offset, _floor_limit_z)))
            grid_lines.append(Vector((grid_size, offset, _floor_limit_z)))
            grid_lines.append(Vector((offset, -grid_size, _floor_limit_z)))
            grid_lines.append(Vector((offset, grid_size, _floor_limit_z)))
        
        batch = batch_for_shader(shader, "LINES", {"pos": grid_lines})
        shader.bind()
        shader.uniform_float("color", floor_color)
        batch.draw(shader)

    # Draw vertical drop lines from violating bones to floor (red)
    if _below_root_violations:
        drop_color = (1.0, 0.0, 0.0, 0.8)
        drop_lines = []
        for bone_pos, floor_pos, _bone_name in _below_root_violations:
            drop_lines.append(bone_pos)
            drop_lines.append(floor_pos)
        
        batch = batch_for_shader(shader, "LINES", {"pos": drop_lines})
        shader.bind()
        shader.uniform_float("color", drop_color)
        batch.draw(shader)

        # Draw X markers at violation points
        x_color = (1.0, 0.0, 0.0, 1.0)
        x_size = 0.1
        x_lines = []
        for bone_pos, _floor_pos, _bone_name in _below_root_violations:
            x_lines.append(Vector((bone_pos.x - x_size, bone_pos.y - x_size, bone_pos.z)))
            x_lines.append(Vector((bone_pos.x + x_size, bone_pos.y + x_size, bone_pos.z)))
            x_lines.append(Vector((bone_pos.x - x_size, bone_pos.y + x_size, bone_pos.z)))
            x_lines.append(Vector((bone_pos.x + x_size, bone_pos.y - x_size, bone_pos.z)))
        
        batch = batch_for_shader(shader, "LINES", {"pos": x_lines})
        shader.bind()
        shader.uniform_float("color", x_color)
        batch.draw(shader)

    gpu.state.blend_set("NONE")


def _draw_motionpath_keyframes():
    """viewport draw callback to render keyframe markers along the path, similar to blender's motion path dots."""
    if not _keyframe_points:
        return
    try:
        import gpu
        from gpu_extras.batch import batch_for_shader
    except Exception:
        return

    shader = None
    for name in ("UNIFORM_COLOR", "3D_UNIFORM_COLOR", "FLAT_COLOR"):
        try:
            shader = gpu.shader.from_builtin(name)
            break
        except Exception:
            continue
    if shader is None:
        return

    gpu.state.blend_set("ALPHA")
    try:
        gpu.state.point_size_set(5.0)
    except Exception:
        pass

    # group points by bone to minimize color binds
    points_by_bone = {}
    for loc, bone_name, _frame in _keyframe_points:
        points_by_bone.setdefault(bone_name, []).append(loc)

    for bone_name, pts in points_by_bone.items():
        settings = getattr(bpy.context.scene, "rbx_anim_settings", None)
        arm_name = settings.rbx_anim_armature if settings else None
        arm = get_object_by_name(arm_name)
        pbone = arm.pose.bones.get(bone_name) if arm else None
        color = (1.0, 1.0, 1.0, 1.0)
        if pbone is not None:
            bc = _get_bone_display_color(pbone)
            # slightly brighter for visibility
            color = (
                min(1.0, bc[0] + 0.25),
                min(1.0, bc[1] + 0.25),
                min(1.0, bc[2] + 0.25),
                1.0,
            )
        batch = batch_for_shader(shader, "POINTS", {"pos": pts})
        shader.bind()
        shader.uniform_float("color", color)
        batch.draw(shader)

    gpu.state.blend_set("NONE")


def _draw_motionpath_labels():
    """overlay callback to render frame labels near violation segments."""
    if not _violation_segments:
        return
    try:
        import blf
        from bpy_extras import view3d_utils
    except Exception:
        return

    region = bpy.context.region
    rv3d = bpy.context.region_data
    if not region or not rv3d:
        return

    font_id = 0
    dpi = 72
    try:
        blf.size(font_id, 12, dpi)
    except Exception:
        pass

    for start, end, frame, bone_name, _kp, _kc, studs in _violation_segments:
        mid = (start + end) * 0.5
        pos2d = view3d_utils.location_3d_to_region_2d(region, rv3d, mid)
        if not pos2d:
            continue
        text = f"{bone_name}  f:{frame}  {studs:.2f} st"
        # small offset to avoid drawing on top of the line
        x = pos2d.x + 4
        y = pos2d.y + 4
        # match label color to line (bone) color (use cache)
        label_col = _bone_color_cache.get(bone_name, (1.0, 0.0, 0.0, 1.0))
        try:
            blf.position(font_id, x, y, 0)
            blf.color(font_id, *label_col)
            blf.draw(font_id, text)
        except Exception:
            # older versions may not support blf.color
            blf.position(font_id, x, y, 0)
            blf.draw(font_id, text)

        # draw keyframe markers as bullets at endpoints
        # compute endpoints in 2d
        bc = _bone_color_cache.get(bone_name, (1.0, 0.0, 0.0, 1.0))
        bcol = (
            min(1.0, bc[0] + 0.2),
            min(1.0, bc[1] + 0.2),
            min(1.0, bc[2] + 0.2),
            1.0,
        )

        start2d = view3d_utils.location_3d_to_region_2d(region, rv3d, start)
        end2d = view3d_utils.location_3d_to_region_2d(region, rv3d, end)
        try:
            blf.size(font_id, 18, dpi)
        except Exception:
            pass
        # draw dim base markers at endpoints for visibility (skip if too many to keep fps)
        many_segments = len(_violation_segments) > 800
        if start2d and not many_segments:
            try:
                blf.color(font_id, 1.0, 1.0, 1.0, 0.6)
            except Exception:
                pass
            blf.position(font_id, start2d.x - 4, start2d.y - 4, 0)
            blf.draw(font_id, "■")
        if end2d and not many_segments:
            try:
                blf.color(font_id, 1.0, 1.0, 1.0, 0.6)
            except Exception:
                pass
            blf.position(font_id, end2d.x - 4, end2d.y - 4, 0)
            blf.draw(font_id, "■")
        # highlight if keyframe
        if _kp and start2d:
            try:
                blf.color(font_id, *bcol)
            except Exception:
                pass
            blf.position(font_id, start2d.x - 4, start2d.y - 4, 0)
            blf.draw(font_id, "■")
        if _kc and end2d:
            try:
                blf.color(font_id, *bcol)
            except Exception:
                pass
            blf.position(font_id, end2d.x - 4, end2d.y - 4, 0)
            blf.draw(font_id, "■")


def _validate_animation_duration(scene, fps: float) -> List[str]:
    """Validate animation duration against Roblox limits."""
    warnings = []
    duration = (scene.frame_end - scene.frame_start + 1) / fps

    if duration > ANIM_MAX_DURATION:
        warnings.append(
            f"Animation duration {duration:.2f}s exceeds Roblox limit of {ANIM_MAX_DURATION}s"
        )

    return warnings


def _resolve_motion_threshold_for_fps(
    benchmark_studs_per_frame: float,
    fps: float,
) -> float:
    """Convert the 30 fps benchmark threshold into a per-frame limit for the scene fps."""
    try:
        benchmark_studs_per_frame = float(benchmark_studs_per_frame)
    except (TypeError, ValueError):
        benchmark_studs_per_frame = ANIM_MAX_DELTA

    try:
        fps = float(fps)
    except (TypeError, ValueError):
        fps = ANIM_FPS

    if benchmark_studs_per_frame < 0:
        benchmark_studs_per_frame = 0.0
    if fps <= _VALIDATION_SCALE_EPSILON:
        return benchmark_studs_per_frame

    return benchmark_studs_per_frame * (ANIM_FPS / fps)


def _validate_bounds(
    positions: Dict[str, Vector], root_pos: Vector, units_per_stud: float
) -> List[Tuple[str, str]]:
    """Validate bone positions against bounds from root."""
    violations = []
    scale = max(abs(units_per_stud), _VALIDATION_SCALE_EPSILON)

    for bone_name, pos in positions.items():
        offset = root_pos - pos
        distance = offset.length / scale

        if distance > ANIM_MAX_BOUNDS:
            violations.append(
                (
                    bone_name,
                    f"Bone '{bone_name}' is {distance:.2f} studs from root (max: {ANIM_MAX_BOUNDS})",
                )
            )

    return violations


def _validate_below_root(
    positions: Dict[str, Vector], root_pos: Vector, units_per_stud: float
) -> List[Tuple[str, str]]:
    """Validate bones aren't too far below root Y position."""
    violations = []
    root_y = root_pos.z  # blender Z = roblox Y
    scale = max(abs(units_per_stud), _VALIDATION_SCALE_EPSILON)

    for bone_name, pos in positions.items():
        depth = (root_y - pos.z) / scale
        if depth > ANIM_MAX_BELOW_ROOT:
            violations.append((
                bone_name,
                f"Bone '{bone_name}' is {depth:.2f} studs below root (max: {ANIM_MAX_BELOW_ROOT})",
            ))

    return violations


def _validate_rotation_constraints(
    armature_obj: "bpy.types.Object", evaluated_obj: "bpy.types.Object"
) -> List[str]:
    """Validate bone rotations for proper constraints."""
    warnings = []

    for pbone in evaluated_obj.pose.bones:
        # Check for extreme rotations that might cause issues
        rot = pbone.rotation_quaternion

        # Check for NaN or infinite values
        if any(math.isnan(x) or math.isinf(x) for x in rot):
            warnings.append(f"Bone '{pbone.name}' has invalid rotation (NaN/Inf)")
            continue

        # Check for extreme rotation angles (more than 180 degrees in any axis)
        euler = rot.to_euler()
        max_angle = max(abs(euler.x), abs(euler.y), abs(euler.z))

        if max_angle > math.pi:  # 180 degrees
            warnings.append(
                f"Bone '{pbone.name}' has extreme rotation: {math.degrees(max_angle):.1f}°"
            )

    return warnings


def _collect_bone_world_head(
    armature_obj: "bpy.types.Object",
    evaluated_obj: "bpy.types.Object",
    allowed_bone_names: Optional[Set[str]] = None,
) -> Dict[str, Vector]:
    """return world-space head positions for relevant bones on the evaluated armature."""
    positions: Dict[str, Vector] = {}
    # determine which bones to include
    settings = getattr(bpy.context.scene, "rbx_anim_settings", None)
    force_deform = getattr(settings, "force_deform_bone_serialization", False)
    is_deform = is_deform_bone_rig(armature_obj) or force_deform

    world_mat = evaluated_obj.matrix_world
    for pbone in evaluated_obj.pose.bones:
        if allowed_bone_names is not None and pbone.name not in allowed_bone_names:
            continue
        if is_deform:
            if not pbone.bone.use_deform:
                continue
        else:
            if "is_transformable" not in pbone.bone:
                continue
        # pbone.head is in armature space
        head_world = world_mat @ pbone.head
        positions[pbone.name] = head_world
    return positions


def _get_root_world_pos(
    armature_obj: "bpy.types.Object", evaluated_obj: "bpy.types.Object"
) -> Vector:
    """Return world-space root position based on pose bones (per-frame)."""
    world_mat = evaluated_obj.matrix_world

    root_bone_name = _resolve_validation_root_bone_name(evaluated_obj.pose.bones)
    if root_bone_name is not None:
        pbone = evaluated_obj.pose.bones.get(root_bone_name)
        if pbone is not None:
            return world_mat @ pbone.head

    # Fallback: first bone with no parent
    for pbone in evaluated_obj.pose.bones:
        if pbone.parent is None:
            return world_mat @ pbone.head

    # Final fallback: armature object origin (or parent if present)
    if armature_obj.parent:
        return armature_obj.parent.matrix_world.translation.copy()
    return armature_obj.matrix_world.translation.copy()


class OBJECT_OT_ValidateMotionPaths(Operator):
    bl_label = "Validate Motion Paths (Roblox)"
    bl_idname = "object.rbxanims_validate_motionpaths"
    bl_description = "check per-frame world displacement of limbs against the max studs/frame and draw violations"

    @classmethod
    def poll(cls, context):
        settings = getattr(context.scene, "rbx_anim_settings", None)
        arm_name = settings.rbx_anim_armature if settings else None
        obj = get_object_by_name(arm_name)
        return bool(obj and obj.type == "ARMATURE")

    def execute(self, context):
        global \
            _violation_segments, \
            _violation_draw_handler, \
            _violation_label_draw_handler, \
            _keyframe_points, \
            _keyframe_points_draw_handler, \
            _floor_limit_draw_handler, \
            _below_root_violations, \
            _floor_limit_z

        scene = context.scene
        settings = getattr(scene, "rbx_anim_settings", None)
        arm_name = settings.rbx_anim_armature if settings else None
        armature = get_object_by_name(arm_name)
        if not armature or armature.type != "ARMATURE":
            self.report({"ERROR"}, "no valid armature selected")
            return {"CANCELLED"}

        depsgraph = context.evaluated_depsgraph_get()
        fps = get_scene_fps()
        max_studs = (
            getattr(settings, "rbx_max_studs_per_frame", ANIM_MAX_DELTA)
            or ANIM_MAX_DELTA
        )
        effective_max_studs = _resolve_motion_threshold_for_fps(max_studs, fps)

        units_per_stud, scale_source, scale_sample_count = _resolve_validation_units_per_stud(
            armature,
            settings,
        )
        if units_per_stud <= _VALIDATION_SCALE_EPSILON:
            units_per_stud = 1.0
        floor_units_per_stud, floor_scale_source, floor_scale_sample_count = _resolve_validation_units_per_stud(
            armature,
            settings,
            preferred_bone_names=_INTERNAL_EMOTE_R15_FLOOR_BONES,
        )
        if floor_units_per_stud <= _VALIDATION_SCALE_EPSILON:
            floor_units_per_stud = units_per_stud

        frame_start = scene.frame_start
        frame_end = scene.frame_end

        # Comprehensive validation checks
        all_warnings = []
        all_violations = []
        _below_root_violations = []
        _floor_limit_z = None
        validation_body_bone_names = _resolve_validation_body_bone_name_set(
            [bone.name for bone in armature.data.bones]
        )

        # 1. Duration validation
        duration_warnings = _validate_animation_duration(scene, fps)
        all_warnings.extend(duration_warnings)
        if scale_source != "internal_r15":
            fallback_warning = (
                "Validation scale fallback used; internal R15 calibration had no usable "
                f"rest matches ({scale_source})."
            )
            all_warnings.append(fallback_warning)
            self.report({"WARNING"}, fallback_warning)
        if floor_scale_source != "internal_r15":
            floor_fallback_warning = (
                "Floor validation scale fallback used; lower-body internal R15 "
                f"calibration had no usable rest matches ({floor_scale_source})."
            )
            all_warnings.append(floor_fallback_warning)
            self.report({"WARNING"}, floor_fallback_warning)

        last_positions: Dict[str, Vector] = {}
        _violation_segments = []
        total_violations = 0
        _keyframe_points = []

        # collect keyframe frames per bone from active action (if any)
        bone_keyframes: Dict[str, Set[int]] = {}
        action = armature.animation_data.action if armature.animation_data else None
        if action is not None:
            import re
            from ..core.utils import get_action_fcurves

            fcurves = get_action_fcurves(action)
            for fcurve in fcurves:
                if not fcurve.data_path.startswith("pose.bones"):
                    continue
                m = re.search(r'pose\\.bones\["(.+?)"\]', fcurve.data_path)
                if not m:
                    continue
                bname = m.group(1)
                frames = bone_keyframes.setdefault(bname, set())
                for kp in fcurve.keyframe_points:
                    frames.add(int(round(kp.co.x)))

        # iterate frames
        for f in range(frame_start, frame_end + 1):
            scene.frame_set(f)
            arm_eval = armature.evaluated_get(depsgraph)
            root_pos = _get_root_world_pos(armature, arm_eval)
            positions = _collect_bone_world_head(
                armature,
                arm_eval,
                allowed_bone_names=validation_body_bone_names,
            )

            # The overlay is static, so pin it to the lowest allowed floor over the scan.
            if root_pos is not None:
                frame_floor_z = root_pos.z - (ANIM_MAX_BELOW_ROOT * floor_units_per_stud)
                _floor_limit_z = _accumulate_floor_limit_z(_floor_limit_z, frame_floor_z)

            # 3. Bounds validation (check every frame)
            if root_pos is not None:
                bounds_violations = _validate_bounds(positions, root_pos, units_per_stud)
                for bone_name, violation_msg in bounds_violations:
                    all_violations.append((f, bone_name, violation_msg))
                    self.report({"WARNING"}, f"[frame {f}] {violation_msg}")

            # 4. Below-root validation (check every frame)
            if root_pos is not None:
                floor_z = root_pos.z - (ANIM_MAX_BELOW_ROOT * floor_units_per_stud)
                below_violations = _validate_below_root(positions, root_pos, floor_units_per_stud)
                for bone_name, violation_msg in below_violations:
                    all_violations.append((f, bone_name, violation_msg))
                    self.report({"WARNING"}, f"[frame {f}] {violation_msg}")
                    # Add to visual list
                    bone_pos = positions.get(bone_name)
                    if bone_pos:
                        floor_pos = Vector((bone_pos.x, bone_pos.y, floor_z))
                        _below_root_violations.append((bone_pos.copy(), floor_pos, bone_name))

            # 5. Rotation validation (check every frame)
            rotation_warnings = _validate_rotation_constraints(armature, arm_eval)
            for warning in rotation_warnings:
                all_warnings.append(f"[frame {f}] {warning}")
                self.report({"WARNING"}, f"[frame {f}] {warning}")

            for bone_name, pos in positions.items():
                prev = last_positions.get(bone_name)
                if prev is not None:
                    dist_blender = (pos - prev).length
                    studs = dist_blender / units_per_stud
                    if studs > effective_max_studs:
                        frames = bone_keyframes.get(bone_name, set())
                        key_prev = (f - 1) in frames
                        key_curr = f in frames
                        _violation_segments.append(
                            (
                                prev.copy(),
                                pos.copy(),
                                f,
                                bone_name,
                                key_prev,
                                key_curr,
                                studs,
                            )
                        )
                        total_violations += 1
                        self.report(
                            {"WARNING"},
                            f"[frame {f}] bone '{bone_name}' moved {studs:.3f} studs (> {effective_max_studs:.3f} at {fps:.2f} fps; benchmark {max_studs:.3f} @ {ANIM_FPS:.0f} fps)",
                        )
                last_positions[bone_name] = pos

                # record keyframe point if this bone has a key at this frame
                frames = bone_keyframes.get(bone_name, set())
                if f in frames:
                    _keyframe_points.append((pos.copy(), bone_name, f))

        # install draw handlers if not present
        if _violation_draw_handler is None:
            _violation_draw_handler = bpy.types.SpaceView3D.draw_handler_add(
                _draw_motionpath_violations, (), "WINDOW", "POST_VIEW"
            )
        if _violation_label_draw_handler is None:
            _violation_label_draw_handler = bpy.types.SpaceView3D.draw_handler_add(
                _draw_motionpath_labels, (), "WINDOW", "POST_PIXEL"
            )
        if _keyframe_points_draw_handler is None:
            _keyframe_points_draw_handler = bpy.types.SpaceView3D.draw_handler_add(
                _draw_motionpath_keyframes, (), "WINDOW", "POST_VIEW"
            )
        if _floor_limit_draw_handler is None:
            _floor_limit_draw_handler = bpy.types.SpaceView3D.draw_handler_add(
                _draw_floor_limit, (), "WINDOW", "POST_VIEW"
            )

        settings = getattr(scene, "rbx_anim_settings", None)
        if settings:
            setattr(settings, "rbx_show_motionpath_validation", True)

        # Summary report
        total_warnings = len(all_warnings)
        total_bounds_violations = len(all_violations)

        summary_msg = f"Validation complete: {total_violations} motion violations"
        if total_warnings > 0:
            summary_msg += f", {total_warnings} warnings"
        if total_bounds_violations > 0:
            summary_msg += f", {total_bounds_violations} bounds violations"
        summary_msg += (
            f", scale {units_per_stud:.4f} bu/stud"
            f" ({scale_source}, {scale_sample_count} samples)"
        )
        if abs(floor_units_per_stud - units_per_stud) > 1e-4 or floor_scale_source != scale_source:
            summary_msg += (
                f", floor scale {floor_units_per_stud:.4f} bu/stud"
                f" ({floor_scale_source}, {floor_scale_sample_count} samples)"
            )
        if validation_body_bone_names is not None:
            summary_msg += f", validating {len(validation_body_bone_names)} body bones"
        summary_msg += (
            f", motion threshold {effective_max_studs:.4f} studs/frame"
            f" at {fps:.2f} fps"
        )

        self.report({"INFO"}, summary_msg)

        # Log detailed warnings to console
        if all_warnings:
            print("=== ANIMATION VALIDATION WARNINGS ===")
            for warning in all_warnings:
                print(f"WARNING: {warning}")
            print("=====================================")

        return {"FINISHED"}


class OBJECT_OT_ClearMotionPathValidation(Operator):
    bl_label = "Clear Motion Path Validation"
    bl_idname = "object.rbxanims_clear_motionpaths"
    bl_description = "remove validation overlay and clear cached violations"

    def execute(self, context):
        global \
            _violation_segments, \
            _violation_draw_handler, \
            _violation_label_draw_handler, \
            _keyframe_points, \
            _keyframe_points_draw_handler, \
            _floor_limit_draw_handler, \
            _below_root_violations, \
            _floor_limit_z

        _violation_segments = []
        _keyframe_points = []
        _below_root_violations = []
        _floor_limit_z = None
        if _violation_draw_handler is not None:
            try:
                bpy.types.SpaceView3D.draw_handler_remove(
                    _violation_draw_handler, "WINDOW"
                )
            except Exception:
                pass
            _violation_draw_handler = None
        if _violation_label_draw_handler is not None:
            try:
                bpy.types.SpaceView3D.draw_handler_remove(
                    _violation_label_draw_handler, "WINDOW"
                )
            except Exception:
                pass
            _violation_label_draw_handler = None
        if _keyframe_points_draw_handler is not None:
            try:
                bpy.types.SpaceView3D.draw_handler_remove(
                    _keyframe_points_draw_handler, "WINDOW"
                )
            except Exception:
                pass
            _keyframe_points_draw_handler = None
        if _floor_limit_draw_handler is not None:
            try:
                bpy.types.SpaceView3D.draw_handler_remove(
                    _floor_limit_draw_handler, "WINDOW"
                )
            except Exception:
                pass
            _floor_limit_draw_handler = None

        settings = getattr(context.scene, "rbx_anim_settings", None)
        if settings:
            setattr(settings, "rbx_show_motionpath_validation", False)
        self.report({"INFO"}, "validation overlay cleared")
        return {"FINISHED"}


__all__ = [
    "OBJECT_OT_ValidateMotionPaths",
    "OBJECT_OT_ClearMotionPathValidation",
]


def cleanup_validation_draw_handlers():
    """remove any active validation draw handlers and clear cache; safe on reload/unregister."""
    global \
        _violation_segments, \
        _violation_draw_handler, \
        _violation_label_draw_handler, \
        _keyframe_points, \
        _keyframe_points_draw_handler, \
        _floor_limit_draw_handler, \
        _below_root_violations, \
        _floor_limit_z
    _violation_segments = []
    _keyframe_points = []
    _below_root_violations = []
    _floor_limit_z = None
    if _violation_draw_handler is not None:
        try:
            bpy.types.SpaceView3D.draw_handler_remove(_violation_draw_handler, "WINDOW")
        except Exception:
            pass
        _violation_draw_handler = None
    if _violation_label_draw_handler is not None:
        try:
            bpy.types.SpaceView3D.draw_handler_remove(
                _violation_label_draw_handler, "WINDOW"
            )
        except Exception:
            pass
        _violation_label_draw_handler = None
    if _keyframe_points_draw_handler is not None:
        try:
            bpy.types.SpaceView3D.draw_handler_remove(
                _keyframe_points_draw_handler, "WINDOW"
            )
        except Exception:
            pass
        _keyframe_points_draw_handler = None
    if _floor_limit_draw_handler is not None:
        try:
            bpy.types.SpaceView3D.draw_handler_remove(
                _floor_limit_draw_handler, "WINDOW"
            )
        except Exception:
            pass
        _floor_limit_draw_handler = None
