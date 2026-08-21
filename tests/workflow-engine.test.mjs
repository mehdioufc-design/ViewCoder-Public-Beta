import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkflowEngine, VIEWCODER_TOOL_DEFINITIONS } from "../workflow-engine.mjs";

const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "viewcoder-workflow-"));
const iconLibraryDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "Game Icon Library",
);
const state = new Map([["Workspace.Item", "old"]]);
const calls = [];
const publishedIcons = [];
let flakyAttempts = 0;
let rollbackCalls = 0;
const definitions = [
  def("get_value", "roblox", true), def("check_value", "roblox", true),
  def("echo_read", "roblox", true), def("flaky_read", "roblox", true),
  def("blender/get_scene_info", "blender", true), def("set_value", "roblox", false),
  def("restore_value", "roblox", false), def("fail_action", "roblox", false),
  def("viewcoder_import_blender_scene", "viewcoder", false),
];
const engine = createWorkflowEngine({
  storageDir,
  iconLibraryDir,
  getProjectId: async () => "place-123",
  listTools: async () => definitions,
  publishImage: async (filePath, metadata) => {
    publishedIcons.push({ filePath, metadata });
    return {
      url: `http://127.0.0.1:3000/images/test/${encodeURIComponent(path.basename(filePath))}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  },
  callTool: async (name, args, meta) => {
    calls.push({ name, args, meta });
    if (name === "get_value" || name === "check_value") return output({ path: args.path, value: state.get(args.path) });
    if (name === "echo_read") return output(args);
    if (name === "blender/get_scene_info") return output({ objects: 4, scene: "Scene" });
    if (name === "set_value") { state.set(args.path, args.value); return output({ path: args.path, value: args.value }); }
    if (name === "restore_value") { rollbackCalls += 1; state.set(args.path, args.value); return output({ restored: true }); }
    if (name === "viewcoder_import_blender_scene") return output({ imported: true, destination: args.destination });
    if (name === "flaky_read") {
      flakyAttempts += 1;
      if (flakyAttempts === 1) throw Object.assign(new Error("temporary failure"), { code: "TRANSIENT" });
      return output({ recovered: true });
    }
    if (name === "fail_action") throw Object.assign(new Error("forced failure"), { code: "FORCED" });
    throw new Error("Unexpected tool " + name);
  },
});

try {
  assert.equal(VIEWCODER_TOOL_DEFINITIONS.length, 10);
  const definitionNames = VIEWCODER_TOOL_DEFINITIONS.map((tool) => tool.name);
  assert.ok(!definitionNames.includes("viewcoder/get_ui_style_reference"));
  assert.ok(definitionNames.includes("viewcoder/generate_ui_image"));
  assert.ok(definitionNames.includes("viewcoder/generate_icon"));
  assert.ok(definitionNames.includes("viewcoder/slice_ui_sheet"));
  assert.ok(definitionNames.includes("viewcoder/build_roblox_ui"));
  const capabilities = parse(await engine.execute("viewcoder/get_capabilities", {}));
  assert.equal(capabilities.orchestration.maxWorkflowSteps, 100);
  assert.equal(capabilities.orchestration.maxBatchReads, 50);
  assert.deepEqual(capabilities.servers.map((item) => item.id).sort(), ["blender", "roblox", "viewcoder"]);
  assert.ok(capabilities.tools.some((tool) => tool.name === "viewcoder/run_workflow"));
  const allCapabilities = parse(await engine.execute("viewcoder/get_capabilities", { server: "all" }));
  assert.equal(allCapabilities.toolCount, capabilities.toolCount);
  assert.deepEqual(allCapabilities.servers, capabilities.servers);
  assert.equal(allCapabilities.visualPipeline.requiredPng, true);
  assert.equal(allCapabilities.visualPipeline.requiredTransparentAlpha, true);
  assert.equal(allCapabilities.visualPipeline.aiGeneratedUi.output, "one_separate_transparent_png_per_component");
  assert.equal(allCapabilities.visualPipeline.aiGeneratedUi.localLibraryAllowed, false);
  assert.equal(allCapabilities.visualPipeline.aiGeneratedUi.generatorOwner, "current_chat_ai_native_image_generator");
  assert.equal(allCapabilities.visualPipeline.aiGeneratedUi.nativeAttemptLimit, 8);
  assert.equal(allCapabilities.visualPipeline.aiGeneratedUi.nativeRenderGraceMs, 210000);
  assert.equal(allCapabilities.visualPipeline.aiGeneratedUi.afterAttemptLimit, "switch_ai_generated_ui_off");
  assert.ok(!("referenceFolder" in allCapabilities.visualPipeline.aiGeneratedUi));
  assert.ok(!("referenceImageCount" in allCapabilities.visualPipeline.aiGeneratedUi));
  assert.ok(!("referencesAttachedTogether" in allCapabilities.visualPipeline.aiGeneratedUi));
  assert.ok(!("referenceFolder" in allCapabilities.visualPipeline.libraryOnlyMode));
  assert.equal(allCapabilities.visualPipeline.libraryOnlyMode.iconDecision, "current_ai_decides_if_suitable");
  assert.equal(allCapabilities.visualPipeline.libraryOnlyMode.role, "optional_semantically_matching_preset_icons_only");

  const workflow = parse(await engine.execute("viewcoder/run_workflow", {
    name: "Build and verify",
    variables: { target: "Alpha" },
    steps: [
      {
        id: "build", tool: "set_value",
        arguments: { path: "Workspace.Item", value: "\${variables.target}" },
        rollback: { tool: "restore_value", arguments: { path: "Workspace.Item", value: "old" } },
        verify: {
          tool: "check_value", arguments: { path: "Workspace.Item" },
          expect: { ref: "verification.value.value", equals: "Alpha" },
        },
      },
      { id: "read", tool: "get_value", arguments: { path: "Workspace.Item" }, save_as: "live" },
      { id: "reuse", tool: "echo_read", arguments: { value: { $ref: "variables.live.value" } } },
      { id: "skip", tool: "echo_read", when: false, arguments: { value: "never" } },
    ],
  }));
  assert.equal(workflow.state, "succeeded");
  assert.equal(workflow.completed, 3);
  assert.equal(workflow.skipped, 1);
  assert.equal(workflow.steps[0].verification.ok, true);
  assert.equal(workflow.steps[2].value.value, "Alpha");

  const retry = parse(await engine.execute("viewcoder/run_workflow", {
    steps: [{ id: "retryRead", tool: "flaky_read", retries: 2 }],
  }));
  assert.equal(retry.steps[0].attempts, 2);

  state.set("Workspace.Item", "old");
  const rollback = parse(await engine.execute("viewcoder/run_workflow", {
    steps: [
      {
        id: "change", tool: "set_value", arguments: { path: "Workspace.Item", value: "temporary" },
        rollback: { tool: "restore_value", arguments: { path: "Workspace.Item", value: "old" } },
      },
      { id: "fail", tool: "fail_action", on_error: "rollback" },
    ],
  }));
  assert.equal(rollback.state, "rolled_back");
  assert.equal(rollbackCalls, 1);
  assert.equal(state.get("Workspace.Item"), "old");

  const batch = parse(await engine.execute("viewcoder/batch_read", {
    concurrency: 2,
    calls: [
      { id: "studio", tool: "get_value", arguments: { path: "Workspace.Item" } },
      { id: "blender", tool: "blender/get_scene_info", arguments: { user_prompt: "Inspect scene" } },
    ],
  }));
  assert.deepEqual(batch.results.map((item) => item.id), ["studio", "blender"]);
  assert.equal(batch.results[1].value.objects, 4);
  const handoff = parse(await engine.execute("viewcoder/run_workflow", {
    steps: [{
      id: "handoff", tool: "viewcoder_import_blender_scene",
      arguments: { destination: "Workspace.Imported" },
    }],
  }));
  assert.equal(handoff.steps[0].value.imported, true);
  await assert.rejects(
    engine.execute("viewcoder/batch_read", { calls: [{ id: "mutation", tool: "set_value", arguments: {} }] }),
    (error) => error.code === "MUTATION_NOT_ALLOWED",
  );
  await assert.rejects(
    engine.execute("viewcoder/batch_read", { calls: [{ id: "bad", tool: "get_value", arguments: { path: "Workspace.\nItem" } }] }),
    (error) => error.code === "INVALID_PATH",
  );

  const remembered = parse(await engine.execute("viewcoder/project_context", {
    action: "remember",
    entries: [
      { id: "server", kind: "script", path: "ServerScriptService.InventoryServer", summary: "Inventory service", tags: ["inventory"], dependencies: ["ReplicatedStorage.InventoryRemote"], verified: true },
      { id: "remote", kind: "remote", path: "ReplicatedStorage.InventoryRemote", summary: "Inventory remote", verified: true },
    ],
  }));
  assert.equal(remembered.entries, 2);
  const search = parse(await engine.execute("viewcoder/project_context", { action: "search", query: "inventory server" }));
  assert.equal(search.matches[0].entry.id, "server");
  const graph = parse(await engine.execute("viewcoder/project_context", { action: "graph" }));
  assert.equal(graph.edges[0].resolved, true);
  const context = parse(await engine.execute("viewcoder/project_context", { action: "get" }));
  assert.ok(context.project.changes.length >= 2);

  const scored = parse(await engine.execute("viewcoder/score_assets", {
    max_parts: 500, require_animated: true, require_r15: true,
    assets: [
      { id: "safe", parts: 120, scripts: 0, animated: true, r15: true, verified: true, textured: true },
      { id: "unsafe", parts: 20, scripts: 2, animated: true, r15: true },
      { id: "heavy", parts: 900, scripts: 0, animated: false, r15: false },
    ],
  }));
  assert.equal(scored.ranked[0].id, "safe");
  assert.equal(scored.ranked.find((item) => item.id === "unsafe").rejected, true);

  const appleIcons = parse(await engine.execute("viewcoder/find_game_icons", {
    query: "apple",
    style: "cozy cartoon",
    game_theme: "farming",
    limit: 3,
  }));
  assert.equal(appleIcons.decision, "match");
  assert.ok(appleIcons.matches.some((icon) => /apple/i.test(icon.name)));
  assert.ok(appleIcons.matches.every((icon) => icon.localPath.startsWith(iconLibraryDir + path.sep)));
  assert.ok(appleIcons.matches.every((icon) => icon.url?.startsWith("http://127.0.0.1:3000/images/")));
  await fs.access(appleIcons.matches[0].localPath);

  const moneyBagIcons = parse(await engine.execute("viewcoder/find_game_icons", {
    query: "money bag",
    style: "colorful game UI",
    limit: 5,
    publish: false,
  }));
  assert.equal(moneyBagIcons.decision, "match");
  assert.ok(moneyBagIcons.matches.some((icon) => /bag/i.test(icon.name) && /money|coin/i.test(icon.name)));
  assert.ok(moneyBagIcons.matches.every((icon) => icon.url === null));

  const exactCozyIcons = parse(await engine.execute("viewcoder/find_game_icons", {
    query: "cupcake",
    style: "cozy",
    limit: 5,
    publish: false,
  }));
  assert.equal(exactCozyIcons.decision, "match");
  assert.equal(exactCozyIcons.strictSelectedStyle, "cozy");
  assert.deepEqual(exactCozyIcons.availableStyles, [
    "bold", "cartoon", "clean", "colorful", "cozy",
    "cute", "fantasy", "game-ui", "polished", "spooky",
  ]);
  assert.ok(exactCozyIcons.matches.every((icon) => icon.styles.includes("cozy")));

  const unavailableStyle = parse(await engine.execute("viewcoder/find_game_icons", {
    query: "cupcake",
    style: "cyberpunk-neon",
    limit: 3,
    publish: false,
  }));
  assert.equal(unavailableStyle.strictSelectedStyle, null);
  assert.ok(!unavailableStyle.availableStyles.includes("cyberpunk-neon"));

  const typoWalletIcons = parse(await engine.execute("viewcoder/find_game_icons", {
    query: "walet currncy",
    limit: 5,
    publish: false,
  }));
  assert.equal(typoWalletIcons.decision, "match");
  assert.ok(typoWalletIcons.matches.some((icon) => /wallet|money|coin/i.test(icon.name)));

  const semanticIconCases = [
    ["lumber timber", /wood|log|stump|tree/i],
    ["bakery pastry", /cake|cookie|donut|cupcake|chocolate|sweet/i],
    ["treasure reward", /box|gift|coin|safe|bag|chest|block/i],
    ["raw textile", /cotton|wool|fabric|cloth/i],
  ];
  for (const [query, expected] of semanticIconCases) {
    const result = parse(await engine.execute("viewcoder/find_game_icons", {
      query,
      limit: 10,
      publish: false,
    }));
    assert.equal(result.decision, "match", query);
    assert.ok(result.matches.some((icon) => expected.test(icon.name)), query);
    assert.equal(result.policy.allCatalogEntriesUseSameResolver, true);
    assert.equal(result.policy.searchesNamesCategoriesPacksStylesAndThemes, true);
  }

  const unavailableShopIcon = parse(await engine.execute("viewcoder/find_game_icons", {
    query: "shop basket",
    limit: 10,
    publish: false,
  }));
  assert.equal(unavailableShopIcon.decision, "no_match");
  assert.deepEqual(unavailableShopIcon.matches, []);
  assert.match(unavailableShopIcon.instruction, /AI Generated UI is off or unavailable/i);
  assert.match(unavailableShopIcon.alert, /library-only path/i);
  assert.match(unavailableShopIcon.alert, /continue without an icon/i);
  assert.equal(unavailableShopIcon.policy.generateWhenNoSemanticMatch, false);
  assert.ok(!("styleReferenceAvailableWhenNoMatch" in unavailableShopIcon.policy));
  assert.ok(!("aiGeneratedUiReferenceFolder" in unavailableShopIcon.policy));

  const iconCatalog = JSON.parse(await fs.readFile(path.join(iconLibraryDir, "catalog.json"), "utf8"));
  assert.equal(iconCatalog.icons.length, 327);
  for (const catalogIcon of iconCatalog.icons) {
    const result = parse(await engine.execute("viewcoder/find_game_icons", {
      query: catalogIcon.name,
      limit: 20,
      publish: false,
    }));
    assert.equal(result.decision, "match", catalogIcon.id);
    assert.ok(
      result.matches.some((match) => match.name === catalogIcon.name),
      catalogIcon.id + ": " + catalogIcon.name,
    );
  }

  for (const query of ["spaceship radar", "blue UI icon"]) {
    const noIcon = parse(await engine.execute("viewcoder/find_game_icons", { query }));
    assert.equal(noIcon.decision, "no_match");
    assert.deepEqual(noIcon.matches, []);
    assert.match(noIcon.instruction, /AI Generated UI is off or unavailable/i);
    assert.match(noIcon.alert, /library-only path/i);
  }

  const incompatibleGeneratorCalls = [];
  const incompatibleGeneratorEngine = createWorkflowEngine({
    storageDir,
    iconLibraryDir,
    listTools: async () => [
      imageDef("blender/generate_hyper3d_model_via_images", "blender"),
      imageDef("blender/generate_hunyuan3d_model", "blender"),
    ],
    publishImage: async (filePath) => ({
      url: `http://127.0.0.1:3000/images/style/${encodeURIComponent(path.basename(filePath))}`,
    }),
    callTool: async (name, args) => {
      incompatibleGeneratorCalls.push({ name, args });
      throw new Error("A Blender 3D generator must never be called for a 2D icon.");
    },
  });
  const noFalseGenerator = parse(await incompatibleGeneratorEngine.execute("viewcoder/generate_icon", {
    concept: "hammer",
    upload_to_roblox: false,
  }));
  assert.equal(noFalseGenerator.ok, false);
  assert.equal(noFalseGenerator.code, "AI_NATIVE_GENERATION_REQUIRED");
  assert.equal(noFalseGenerator.generationAttempts, 0);
  assert.equal(noFalseGenerator.retryLimit, 3);
  assert.ok(!("styleReference" in noFalseGenerator));
  assert.match(noFalseGenerator.instruction, /THIS CHAT AI/i);
  assert.equal(incompatibleGeneratorCalls.length, 0);

  const imageToImageCalls = [];
  const imageToImageEngine = createWorkflowEngine({
    storageDir,
    iconLibraryDir,
    listTools: async () => [{
      ...imageDef("image/generate_image", "image"),
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          imagePaths: { type: "array", items: { type: "string" } },
        },
        required: ["imagePaths"],
      },
    }],
    publishImage: async (filePath) => ({
      url: `http://127.0.0.1:3000/images/vector/${encodeURIComponent(path.basename(filePath))}`,
    }),
    callTool: async (name, args) => {
      imageToImageCalls.push({ name, args });
      throw new Error("An image-to-image tool requiring imagePaths is not a text-to-image generator.");
    },
  });
  const imageToImageFallback = parse(await imageToImageEngine.execute("viewcoder/generate_icon", {
    concept: "shield",
    upload_to_roblox: false,
    icon_spec: {
      layers: [{
        shape: "polygon",
        points: [[50, 12], [82, 28], [75, 70], [50, 90], [25, 70], [18, 28]],
        fill: "#4f8edc",
        outline: "#1c355a",
      }],
    },
  }));
  assert.equal(imageToImageFallback.ok, true);
  assert.equal(imageToImageFallback.strategy, "local_vector_generation");
  assert.equal(imageToImageFallback.generationAttempts, 0);
  assert.equal(imageToImageCalls.length, 0);

  const vectorPublished = [];
  const textOnlyEngine = createWorkflowEngine({
    storageDir,
    iconLibraryDir,
    listTools: async () => [
      imageDef("blender/generate_hyper3d_model_via_images", "blender"),
    ],
    publishImage: async (filePath, metadata) => {
      vectorPublished.push({ filePath, metadata });
      return {
        url: `http://127.0.0.1:3000/images/vector/${encodeURIComponent(path.basename(filePath))}`,
      };
    },
    callTool: async () => {
      throw new Error("Text-only icon rendering must not call a native image tool.");
    },
  });
  const localHammer = parse(await textOnlyEngine.execute("viewcoder/generate_icon", {
    concept: "hammer",
    size: 192,
    upload_to_roblox: false,
    icon_spec: {
      layers: [
        {
          shape: "capsule",
          x1: 34, y1: 82, x2: 58, y2: 37, width: 13,
          fill: "#a96535", outline: "#3f281b", texture: 0.06,
        },
        {
          shape: "rounded_rect",
          cx: 61, cy: 30, width: 53, height: 23, radius: 6, rotation: -12,
          fill: "#aeb8c6", outline: "#293442", depth: 0.22, highlight: 0.28,
        },
      ],
    },
  }));
  assert.equal(localHammer.ok, true);
  assert.equal(localHammer.strategy, "local_vector_generation");
  assert.equal(localHammer.generationAttempts, 0);
  assert.equal(localHammer.fallbackReason, null);
  assert.ok(!("styleReference" in localHammer));
  assert.equal(localHammer.width, 192);
  assert.equal(localHammer.height, 192);
  assert.match(localHammer.source, /^http:\/\/127\.0\.0\.1:3000\/images\/vector\//);
  const pngBytes = await fs.readFile(localHammer.generatedLocalPath);
  assert.deepEqual([...pngBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(pngBytes.length > 1_000);
  assert.ok(vectorPublished.some((entry) => entry.metadata?.source === "viewcoder-local-vector-icon"));

  const chatAiRelayCalls = [];
  const chatAiRelayEngine = createWorkflowEngine({
    storageDir,
    iconLibraryDir,
    listTools: async () => [imageDef("image/generate_image", "image")],
    publishImage: async (filePath) => ({
      url: `http://127.0.0.1:3000/images/reference/${encodeURIComponent(path.basename(filePath))}`,
    }),
    callTool: async (name, args) => {
      chatAiRelayCalls.push({ name, args });
      throw new Error(`The workflow must not call connected image generator ${name}.`);
    },
  });

  const missingNativeHammerResult = await chatAiRelayEngine.execute("viewcoder/generate_icon", {
    concept: "hammer",
    upload_to_roblox: false,
  });
  const missingNativeHammer = parse(missingNativeHammerResult);
  assert.equal(missingNativeHammer.ok, false);
  assert.equal(missingNativeHammer.code, "AI_NATIVE_GENERATION_REQUIRED");
  assert.equal(missingNativeHammer.retryLimit, 3);
  assert.match(missingNativeHammer.instruction, /THIS CHAT AI must use its own built-in native image generator/i);
  assert.match(missingNativeHammer.message, /up to 3 native generation attempts/i);
  assert.match(missingNativeHammer.instruction, /NO BACKGROUND AT ALL/i);
  assert.match(missingNativeHammer.instruction, /fully transparent \(alpha 0\)/i);
  assert.ok(!("styleReference" in missingNativeHammer));
  assert.ok(!("styleReferences" in missingNativeHammer));
  assert.ok(!("attachedReferenceImageCount" in missingNativeHammer));
  assert.equal(missingNativeHammerResult.images.length, 0);
  assert.equal(chatAiRelayCalls.length, 0, "ViewCoder called an MCP image generator instead of the chat AI.");

  const suppliedNativeHammer = parse(await chatAiRelayEngine.execute("viewcoder/generate_icon", {
    concept: "hammer",
    generated_image_url: "https://images.example.invalid/hammer.png",
    upload_to_roblox: false,
  }));
  assert.equal(suppliedNativeHammer.ok, true);
  assert.equal(suppliedNativeHammer.strategy, "provided_generation");
  assert.equal(suppliedNativeHammer.generationAttempts, 0);
  assert.equal(suppliedNativeHammer.matchingReference, null);
  assert.ok(!("styleReference" in suppliedNativeHammer));

  const missingShopButtonResult = await chatAiRelayEngine.execute("viewcoder/generate_ui_image", {
    description: "Green purchase button with a chunky beveled frame and clear hierarchy",
    component_name: "BuyButton",
    component_type: "button",
    dimensions: "360x96",
    interaction_state: "normal",
    component_family: "ShopScreen",
    game_theme: "simulator shop",
    upload_to_roblox: false,
  });
  const missingShopButton = parse(missingShopButtonResult);
  assert.equal(missingShopButton.ok, false);
  assert.equal(missingShopButton.code, "AI_NATIVE_GENERATION_REQUIRED");
  assert.equal(missingShopButton.retryLimit, 3);
  assert.ok(!("styleReference" in missingShopButton));
  assert.ok(!("styleReferences" in missingShopButton));
  assert.ok(!("attachedReferenceImageCount" in missingShopButton));
  assert.match(missingShopButton.instruction, /THIS CHAT AI must use its own built-in native image generator/i);
  assert.match(missingShopButton.instruction, /one tightly cropped PNG with real transparent alpha/i);
  assert.match(missingShopButton.instruction, /3 minutes 30 seconds/i);
  assert.equal(missingShopButtonResult.images.length, 0);

  const separateShopButton = parse(await chatAiRelayEngine.execute("viewcoder/generate_ui_image", {
    description: "Green purchase button with a chunky beveled frame and clear hierarchy",
    component_name: "BuyButton",
    component_type: "button",
    dimensions: "360x96",
    interaction_state: "normal",
    component_family: "ShopScreen",
    game_theme: "simulator shop",
    generated_image_url: "https://images.example.invalid/buy-button.png",
    upload_to_roblox: false,
  }));
  assert.equal(separateShopButton.ok, true);
  assert.equal(separateShopButton.strategy, "ai_generated_ui_component");
  assert.equal(separateShopButton.format, "png");
  assert.equal(separateShopButton.transparentBackgroundRequired, true);
  assert.equal(separateShopButton.componentName, "BuyButton");
  assert.ok(!("styleReference" in separateShopButton));
  assert.equal(separateShopButton.source, "https://images.example.invalid/buy-button.png");

  const imagePathsUploadCalls = [];
  const imagePathsUploadEngine = createWorkflowEngine({
    storageDir,
    iconLibraryDir,
    listTools: async () => [{
      name: "upload_image",
      server: "roblox",
      serverLabel: "Roblox Studio",
      description: "Upload an image",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object",
        properties: {
          imagePaths: { type: "array", items: { type: "string" } },
          name: { type: "string" },
          description: { type: "string" },
        },
        required: ["imagePaths"],
      },
    }],
    publishImage: async (filePath) => ({
      url: `http://127.0.0.1:3000/images/upload-reference/${encodeURIComponent(path.basename(filePath))}`,
    }),
    callTool: async (name, args) => {
      imagePathsUploadCalls.push({ name, args });
      assert.equal(name, "upload_image");
      assert.ok(Array.isArray(args.imagePaths));
      assert.equal(args.imagePaths.length, 1);
      return output({ ok: true, assetId: "2468013579" });
    },
  });
  const uploadedShopButton = parse(await imagePathsUploadEngine.execute("viewcoder/generate_ui_image", {
    description: "Standalone green shop button",
    component_name: "ShopButton",
    component_type: "button",
    generated_image_url: "https://images.example.invalid/shop-button.png",
    upload_to_roblox: true,
  }));
  assert.equal(uploadedShopButton.ok, true);
  assert.equal(uploadedShopButton.assetId, "2468013579");
  assert.deepEqual(imagePathsUploadCalls[0].args.imagePaths, ["https://images.example.invalid/shop-button.png"]);
  const uploadedNativeIcon = parse(await imagePathsUploadEngine.execute("viewcoder/generate_icon", {
    concept: "shop basket",
    generated_image_url: "https://images.example.invalid/shop-basket.png",
  }));
  assert.equal(uploadedNativeIcon.ok, true);
  assert.equal(uploadedNativeIcon.assetId, "2468013579");
  assert.deepEqual(imagePathsUploadCalls[1].args.imagePaths, ["https://images.example.invalid/shop-basket.png"]);

  const userStyledHammerResult = await chatAiRelayEngine.execute("viewcoder/generate_icon", {
    concept: "hammer",
    style: "cyberpunk neon",
    upload_to_roblox: false,
  });
  const userStyledHammer = parse(userStyledHammerResult);
  assert.equal(userStyledHammer.ok, false);
  assert.equal(userStyledHammer.code, "AI_NATIVE_GENERATION_REQUIRED");
  assert.ok(!("styleReference" in userStyledHammer));
  assert.equal(userStyledHammerResult.images.length, 0);

  const libraryOnlyApple = parse(await chatAiRelayEngine.execute("viewcoder/generate_icon", {
    concept: "apple",
    library_only: true,
    upload_to_roblox: false,
  }));
  assert.equal(libraryOnlyApple.ok, true);
  assert.equal(libraryOnlyApple.strategy, "bundled_library");
  assert.equal(libraryOnlyApple.libraryOnly, true);
  assert.equal(libraryOnlyApple.generationAttempts, 0);
  assert.equal(libraryOnlyApple.fallbackReason, "text_only_provider_library_policy");
  assert.equal(chatAiRelayCalls.length, 0, "Library-only mode called an image generator.");

  const libraryOnlyMissing = parse(await chatAiRelayEngine.execute("viewcoder/generate_icon", {
    concept: "quantum jellyfish wrench 98271",
    library_only: true,
    icon_spec: { layers: [{ type: "ellipse", cx: 50, cy: 50, width: 60, height: 60, fill: "#123456" }] },
    upload_to_roblox: false,
  }));
  assert.equal(libraryOnlyMissing.ok, false);
  assert.equal(libraryOnlyMissing.code, "ICON_UNAVAILABLE");
  assert.equal(libraryOnlyMissing.libraryOnly, true);
  assert.equal(libraryOnlyMissing.generationAttempts, 0);
  assert.match(libraryOnlyMissing.message, /library-only mode/i);
  assert.equal(chatAiRelayCalls.length, 0, "Library-only miss generated or rasterized an icon.");

  assert.ok(publishedIcons.length > 0);
  assert.ok(calls.some((item) => item.name === "blender/get_scene_info"));
  console.log("Workflow engine tests passed.");
} finally {
  await fs.rm(storageDir, { recursive: true, force: true });
}

function def(name, server, readOnly) {
  return { name, server, serverLabel: server === "blender" ? "Blender" : "Roblox Studio", description: name, annotations: { readOnlyHint: readOnly }, inputSchema: { type: "object" } };
}
function imageDef(name, server) {
  return {
    name,
    server,
    serverLabel: server,
    description: name,
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        size: { type: ["string", "integer"] },
        reference_image: { type: "string" },
        format: { type: "string" },
        background: { type: "string" },
      },
    },
  };
}
function output(value) { return { text: JSON.stringify(value), images: [] }; }
function parse(value) { return JSON.parse(value.text); }
