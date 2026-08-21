import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROBLOX_RIG_OPTIONS,
  buildRobloxRigScript,
  normalizeRobloxRigOptions,
} from "../animation-rig.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const asset = path.join(root, "Roblox Rig Library", "BlockyCharacter.fbx");

assert.equal(ROBLOX_RIG_OPTIONS.singleRig, true);
assert.equal(ROBLOX_RIG_OPTIONS.sourceFile, "BlockyCharacter.fbx");
assert.equal(ROBLOX_RIG_OPTIONS.preset, "Blocky Character");
assert.equal(ROBLOX_RIG_OPTIONS.destructiveImport, true);
assert.equal(ROBLOX_RIG_OPTIONS.centersAtOrigin, true);
assert.equal(ROBLOX_RIG_OPTIONS.opensAnimationWorkspace, true);
assert.equal(ROBLOX_RIG_OPTIONS.beta, true);
assert(fs.existsSync(asset), "The supplied BlockyCharacter.fbx is missing.");
assert.equal(fs.statSync(asset).size, 2_984_140);

const fixed = { rigType: "R15", bodyShape: "Official", preset: "Blocky Character" };
for (const request of [{}, { rigType: "R6" }, { preset: "My Avatar" }, { rigType: "Custom" }]) {
  assert.deepEqual(normalizeRobloxRigOptions(request), fixed);
}

const script = buildRobloxRigScript({ rigType: "R6", preset: "Other" });
for (const required of [
  "BlockyCharacter.fbx",
  "ViewCoder_Animation_Rig",
  "obj.name.endswith('_Geo')",
  "len(rig.data.bones) < 51",
  "reset_blender_project()",
  "switch_to_animation_workspace()",
  "center_and_ground(collection, rig, body_meshes)",
  "frame_rig(collection, rig)",
  "rig.show_in_front = False",
  "rig.hide_set(True)",
  "rig[\"viewcoder_armature_hidden\"] = True",
  "VIEWCODER_RIG_IMPORTED",
  ":bundled:",
]) {
  assert(script.includes(required), `Generated rig script is missing ${required}.`);
}
for (const obsolete of ["ClassicMannequin.fbx", "Rig_and_Attachments_Template.fbx", "R6.rbxmx"] ) {
  assert(!script.includes(obsolete), `Generated rig script still references ${obsolete}.`);
}

console.log("Single supplied animation-rig contract tests passed.");
