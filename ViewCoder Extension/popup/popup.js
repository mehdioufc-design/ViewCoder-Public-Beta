const providersElement = document.querySelector(".providers");
const bridgeCard = document.querySelector(".bridge:not(.blender-bridge)");
const bridgeRecheck = document.querySelector(".bridge-recheck");
const studioRestart = document.querySelector(".studio-restart");
const feedback = document.querySelector(".feedback");
const bridgeStateElement = document.querySelector(".bridge-state");
const bridgeDetail = document.querySelector(".bridge-detail");
const connectionDot = document.querySelector(".connection-dot");
const blenderCard = document.querySelector(".blender-bridge");
const blenderStateElement = document.querySelector(".blender-state");
const blenderDetail = document.querySelector(".blender-detail");
const blenderToggle = document.querySelector(".blender-toggle");
const blenderFeedback = document.querySelector(".blender-feedback");
const activeModeCard = document.querySelector(".active-mode-card");
const activeModeToggle = document.querySelector(".active-mode-toggle");
const animationModeCard = document.querySelector(".animation-mode");
const animationModeToggle = document.querySelector(".animation-mode-toggle");
const iconModeCard = document.querySelector(".icon-mode");
const iconModeToggle = document.querySelector(".icon-mode-toggle");
const creativeModeFeedback = document.querySelector(".creative-mode-feedback");
const rigChooser = document.querySelector(".rig-chooser");
const rigImport = document.querySelector(".rig-import");
const rigImportStatus = document.querySelector(".rig-import-status");
const versionElement = document.querySelector(
  "#extension-version",
);
const previewMode = !globalThis.chrome?.runtime?.id;
const extensionVersion = previewMode
  ? "1.0.0"
  : chrome.runtime.getManifest().version;

let activeProvider = null;
let activeTabId = null;
let currentBridge = offlineBridge();
let refreshRequest = null;
let interactionBusy = false;
let activeMode = true;
let viewModes = defaultViewModes();
let rigDraft = { ...viewModes.rig };
const NATIVE_UI_PROVIDERS = new Set(["chatgpt", "gemini", "meta"]);
const activeProviderCanGenerateUi = () => NATIVE_UI_PROVIDERS.has(activeProvider);

versionElement.textContent = `v${extensionVersion}`;

if (previewMode) {
  activeProvider = "deepseek";
  renderProviders();
  renderStatus({
    online: true,
    version: extensionVersion,
    totalToolCount: 27,
    bothConnected: false,
    servers: [
      {
        id: "roblox",
        enabled: true,
        ready: true,
        state: "ready",
        toolCount: 27,
      },
      {
        id: "blender",
        enabled: false,
        ready: false,
        state: "disabled",
        toolCount: 0,
      },
    ],
    mcp: {
      state: "ready",
      studio: true,
      verified: true,
      studioName: "Place1",
      toolCount: 27,
    },
  });
  renderActiveMode();
  renderViewModes();
} else {
  void initialize();
  globalThis.setInterval(() => {
    if (
      document.visibilityState === "visible" &&
      !interactionBusy
    ) {
      void refreshBridgeStatus();
    }
  }, 3_000);
}

async function initialize() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  activeTabId = tab?.id ?? null;
  if (tab?.url) {
    try {
      activeProvider =
        globalThis.ViewCoderProviderForHost(
          new URL(tab.url).hostname,
        )?.id ?? null;
    } catch {
      activeProvider = null;
    }
  }
  renderProviders();
  await Promise.all([
    refreshBridgeStatus(),
    refreshActiveModes(),
    refreshViewModes(),
  ]);
}

function defaultViewModes() {
  return {
    operatingMode: "agent",
    animationMode: false,
    iconMode: true,
    rig: {
      rigType: "R15",
      bodyShape: "Official",
      preset: "Blocky Character",
      name: null,
      importedAt: null,
    },
  };
}

async function refreshActiveModes() {
  try {
    const result = await chrome.runtime.sendMessage({
      type: "VIEWCODER_ACTIVE_MODE",
    });
    activeMode = result?.enabled !== false;
  } catch {
    activeMode = true;
  }
  renderActiveMode();
}

function renderActiveMode() {
  activeModeCard.classList.toggle("is-enabled", activeMode);
  activeModeToggle.setAttribute("aria-checked", String(activeMode));
  activeModeToggle.title = activeMode
    ? "Active Mode is on"
    : "Active Mode is off";
}

async function refreshBridgeStatus(force = false) {
  if (refreshRequest) {
    if (!force) return refreshRequest;
    // A connection mutation must be followed by a genuinely new read. Let any
    // older poll settle first so its stale result cannot win the UI race.
    await refreshRequest.catch(() => undefined);
  }
  refreshRequest = (async () => {
    try {
      const status = await chrome.runtime.sendMessage({
        type: "VIEWCODER_STATUS",
      });
      renderStatus(status?.bridge ?? status);
    } catch {
      renderStatus(offlineBridge());
    }
  })();
  try {
    return await refreshRequest;
  } finally {
    refreshRequest = null;
  }
}

function renderProviders() {
  providersElement.replaceChildren(
    ...globalThis.ViewCoderProviders.map((provider) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "provider";
      button.classList.toggle(
        "is-active",
        provider.id === activeProvider,
      );
      button.style.setProperty(
        "--provider-accent",
        provider.accent,
      );
      button.innerHTML = `
        <span class="provider-accent"></span>
        <img class="provider-icon" src="../icons/ui/provider.png" alt="">
        <span class="provider-copy">
          <span class="provider-name"></span>
          <span class="provider-domain"></span>
        </span>
      `;
      button.querySelector(".provider-name").textContent =
        provider.name;
      button.querySelector(".provider-domain").textContent =
        provider.domain;
      button.addEventListener("click", async () => {
        if (previewMode) {
          activeProvider = provider.id;
          renderProviders();
          return;
        }
        await chrome.runtime.sendMessage({
          type: "VIEWCODER_OPEN_PROVIDER",
          providerId: provider.id,
          tabId: activeTabId,
        });
        window.close();
      });
      return button;
    }),
  );
}

function renderStatus(status) {
  currentBridge = status ?? offlineBridge();
  renderBlenderStatus(currentBridge);
  connectionDot.className = "connection-dot";
  const anyTargetReady = (currentBridge.servers || []).some(
    (server) => server?.ready && (server?.toolCount || server?.tools || 0) > 0,
  );
  const targetSignalClass = anyTargetReady ? "is-ready" : "is-warning";
  bridgeCard.classList.remove("needs-setup");
  feedback.classList.remove("is-error");
  bridgeDetail.classList.remove("is-launch");
  if (!currentBridge.online) {
    bridgeCard.classList.add("needs-setup");
    bridgeStateElement.textContent = "Local connection offline";
    bridgeDetail.textContent = "Launch start.bat to connect";
    bridgeDetail.classList.add("is-launch");
    feedback.textContent =
      "Connected-app actions will wait until the local connection returns.";
    feedback.classList.add("is-error");
    return;
  }

  if (currentBridge.version !== extensionVersion) {
    bridgeCard.classList.add("needs-setup");
    connectionDot.classList.add("is-warning");
    bridgeStateElement.textContent = "Update needed";
    bridgeDetail.textContent =
      `Extension ${extensionVersion} · bridge ${currentBridge.version ?? "old"}`;
    feedback.textContent =
      "Run the latest setup and reload ViewCoder.";
    feedback.classList.add("is-error");
    return;
  }

  if (currentBridge.mcp?.studioProcess === false) {
    bridgeCard.classList.add("needs-setup");
    connectionDot.classList.add(targetSignalClass);
    bridgeStateElement.textContent = "Roblox Studio is not open";
    bridgeDetail.textContent = "The local connection is available";
    feedback.textContent =
      "Open a Studio place and ViewCoder will detect it.";
    return;
  }

  if (currentBridge.mcp?.state !== "ready") {
    bridgeCard.classList.add("needs-setup");
    connectionDot.classList.add(targetSignalClass);
    bridgeStateElement.textContent = "Studio access is disabled";
    bridgeDetail.textContent = "The local connection is available";
    feedback.textContent =
      "In Studio, enable Studio MCP from Assistant settings.";
    return;
  }

  if (
    currentBridge.mcp?.studio !== true ||
    !currentBridge.mcp?.toolCount
  ) {
    bridgeCard.classList.add("needs-setup");
    connectionDot.classList.add(targetSignalClass);
    bridgeStateElement.textContent =
      "Studio is waiting to attach";
    bridgeDetail.textContent =
      `${currentBridge.mcp?.toolCount ?? 0} Studio actions found`;
    feedback.textContent =
      "Toggle Studio MCP off and on from Assistant settings.";
    return;
  }

  if (currentBridge.mcp?.verified !== true) {
    connectionDot.classList.add(targetSignalClass);
    bridgeStateElement.textContent = "Confirming Studio access";
    bridgeDetail.textContent = "Waiting for Studio to answer";
    feedback.textContent =
      "Studio actions remain paused until confirmation arrives.";
    return;
  }

  connectionDot.classList.add("is-ready");
  bridgeStateElement.textContent = "Studio connection ready";
  bridgeDetail.textContent = currentBridge.mcp?.studioName
    ? `${currentBridge.mcp.studioName} · ${currentBridge.mcp.toolCount} actions`
    : `${currentBridge.mcp.toolCount} Studio actions`;
  feedback.textContent =
    "Connected. Use Start ViewCoder from a supported AI chat.";
}

function renderBlenderStatus(status) {
  const blender = status?.servers?.find(
    (server) => server?.id === "blender",
  ) ?? {
    enabled: false,
    ready: false,
    state: status?.online ? "disabled" : "offline",
    toolCount: 0,
  };
  const state = blender.ready
    ? "ready"
    : blender.state === "offline" && blender.enabled
      ? "error"
      : blender.state;
  blenderCard.dataset.state = state;
  blenderToggle.dataset.state = state;
  blenderFeedback.classList.toggle(
    "is-error",
    blender.enabled && blender.state === "offline",
  );

  if (!status?.online) {
    blenderStateElement.textContent = "Local connection offline";
    blenderDetail.textContent = "Launch start.bat first";
    blenderToggle.textContent = "Connect Blender";
    blenderToggle.disabled = true;
    blenderFeedback.textContent =
      "Blender becomes available after the local connection starts.";
    return;
  }

  blenderToggle.disabled = false;
  if (!blender.enabled) {
    blenderStateElement.textContent = "Offline · optional";
    blenderDetail.textContent = "Creative tools are available on demand";
    blenderToggle.textContent = "Connect Blender";
    blenderFeedback.textContent =
      "Roblox Studio continues working when Blender is offline.";
    return;
  }
  if (blender.ready) {
    blenderStateElement.textContent =
      `Online · ${blender.toolCount || 0} actions`;
    blenderDetail.textContent = "Ready for advanced model work";
    blenderToggle.textContent = "Disconnect Blender";
    blenderFeedback.textContent =
      "ViewCoder can now coordinate Blender and Roblox Studio.";
    return;
  }
  if (blender.state === "connecting") {
    blenderStateElement.textContent = "Connecting…";
    blenderDetail.textContent = "Waiting for Blender";
    blenderToggle.textContent = "Connecting…";
    blenderToggle.disabled = true;
    blenderFeedback.textContent =
      "Keep Blender open while ViewCoder checks the connection.";
    return;
  }
  blenderStateElement.textContent = "Connection needs attention";
  blenderDetail.textContent =
    String(blender.error || "Blender did not answer").slice(0, 100);
  blenderToggle.textContent = "Try Blender again";
  blenderFeedback.textContent =
    "Start the Blender MCP add-on, then try the connection again.";
}

async function refreshViewModes() {
  try {
    const result = await chrome.runtime.sendMessage({
      type: "VIEWCODER_MODES",
    });
    if (result?.ok && result.modes) {
      viewModes = result.modes;
      rigDraft = { ...viewModes.rig };
    }
  } catch {
    viewModes = defaultViewModes();
    rigDraft = { ...viewModes.rig };
  }
  renderViewModes();
}

function renderViewModes() {
  animationModeCard.classList.toggle(
    "is-enabled",
    viewModes.animationMode,
  );
  animationModeToggle.setAttribute(
    "aria-checked",
    String(viewModes.animationMode),
  );
  animationModeToggle.title = viewModes.animationMode
    ? "Animation Mode is on"
    : "Animation Mode is off";
  const aiGeneratedUiAvailable = activeProviderCanGenerateUi();
  const aiGeneratedUiEnabled = aiGeneratedUiAvailable && viewModes.iconMode;
  iconModeCard.classList.toggle("is-enabled", aiGeneratedUiEnabled);
  iconModeCard.classList.toggle("is-unavailable", !aiGeneratedUiAvailable);
  iconModeToggle.disabled = !aiGeneratedUiAvailable;
  iconModeToggle.setAttribute("aria-disabled", String(!aiGeneratedUiAvailable));
  iconModeToggle.setAttribute("aria-checked", String(aiGeneratedUiEnabled));
  iconModeToggle.title = aiGeneratedUiAvailable
    ? `AI Generated UI is ${aiGeneratedUiEnabled ? "on" : "off"}`
    : "AI Generated UI is unavailable on this AI; suitable matching preset icons are optional.";
  rigChooser.hidden = !viewModes.animationMode;

  rigDraft = {
    ...rigDraft,
    rigType: "R15",
    bodyShape: "Official",
    preset: "Blocky Character",
  };
  rigImport.textContent = "Import Rig";

  creativeModeFeedback.classList.remove("is-error");
  if (viewModes.animationMode && aiGeneratedUiEnabled) {
    creativeModeFeedback.textContent =
      "Animation focus and AI Generated UI are enabled.";
  } else if (viewModes.animationMode) {
    creativeModeFeedback.textContent =
      "Animation focus is enabled. AI Generated UI is unavailable or off.";
  } else if (!aiGeneratedUiAvailable) {
    creativeModeFeedback.textContent =
      "AI Generated UI is unavailable on this AI. This AI may use a matching preset icon when suitable.";
  } else if (aiGeneratedUiEnabled) {
    creativeModeFeedback.textContent = "AI Generated UI is on.";
  } else {
    creativeModeFeedback.textContent =
      "AI Generated UI is off. This AI may use matching preset icons when suitable.";
  }

  if (viewModes.rig?.importedAt) {
    rigImportStatus.classList.remove("is-error");
    rigImportStatus.textContent = viewModes.rig.name
      ? `${viewModes.rig.name} is selected in Blender.`
      : "The animation rig is imported into Blender.";
  }
}

async function setViewModes(patch) {
  const previous = viewModes;
  const next = {
    ...viewModes,
    ...patch,
    rig: {
      ...viewModes.rig,
      ...(patch.rig || {}),
    },
  };
  viewModes = next;
  renderViewModes();
  if (previewMode) return { ok: true, modes: viewModes };
  animationModeToggle.disabled = true;
  iconModeToggle.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: "VIEWCODER_SET_MODES",
      modes: patch,
    });
    if (!result?.ok) {
      throw new Error(result?.error || "ViewCoder could not save that mode.");
    }
    viewModes = result.modes;
    rigDraft = { ...viewModes.rig };
    renderViewModes();
    return result;
  } catch (error) {
    viewModes = previous;
    renderViewModes();
    creativeModeFeedback.classList.add("is-error");
    creativeModeFeedback.textContent =
      error instanceof Error ? error.message : String(error);
    return { ok: false, error: creativeModeFeedback.textContent };
  } finally {
    animationModeToggle.disabled = false;
    iconModeToggle.disabled = !activeProviderCanGenerateUi();
  }
}

function offlineBridge() {
  return {
    online: false,
    version: null,
    totalToolCount: 0,
    bothConnected: false,
    servers: [
      {
        id: "roblox",
        enabled: true,
        ready: false,
        state: "offline",
        toolCount: 0,
      },
      {
        id: "blender",
        enabled: false,
        ready: false,
        state: "disabled",
        toolCount: 0,
      },
    ],
    mcp: {
      state: "offline",
      studio: false,
      verified: false,
      toolCount: 0,
    },
  };
}

bridgeRecheck.addEventListener("click", async () => {
  setBridgeActionsBusy(true);
  feedback.classList.remove("is-error");
  feedback.textContent = "Reviewing the local connection and Studio…";
  if (previewMode) {
    renderStatus(currentBridge);
    setBridgeActionsBusy(false);
    return;
  }
  try {
    const verification = await chrome.runtime.sendMessage({
      type: "VIEWCODER_VERIFY",
    });
    renderStatus(verification);
  } catch {
    renderStatus(offlineBridge());
  } finally {
    setBridgeActionsBusy(false);
  }
});

studioRestart.addEventListener("click", async () => {
  setBridgeActionsBusy(true);
  feedback.classList.remove("is-error");
  feedback.textContent = "Refreshing the Studio connection…";
  if (previewMode) {
    feedback.textContent = "Studio connection refreshed.";
    setBridgeActionsBusy(false);
    return;
  }
  try {
    await chrome.runtime.sendMessage({
      type: "VIEWCODER_RECONNECT",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const verification = await chrome.runtime.sendMessage({
      type: "VIEWCODER_VERIFY",
    });
    renderStatus(verification);
  } catch (error) {
    feedback.classList.add("is-error");
    feedback.textContent =
      error instanceof Error ? error.message : String(error);
  } finally {
    setBridgeActionsBusy(false);
  }
});

blenderToggle.addEventListener("click", async () => {
  interactionBusy = true;
  const blender = currentBridge?.servers?.find(
    (server) => server?.id === "blender",
  );
  blenderToggle.disabled = true;
  blenderFeedback.classList.remove("is-error");
  blenderFeedback.textContent = blender?.ready
    ? "Disconnecting Blender…"
    : "Connecting Blender…";

  if (previewMode) {
    const enabled = blender?.ready !== true;
    const existing = currentBridge.servers ?? [];
    currentBridge.servers = existing.map((server) =>
      server.id === "blender"
        ? {
            ...server,
            enabled,
            ready: enabled,
            state: enabled ? "ready" : "disabled",
            toolCount: enabled ? 13 : 0,
          }
        : server,
    );
    currentBridge.bothConnected = enabled;
    currentBridge.totalToolCount = enabled ? 40 : 27;
    renderStatus(currentBridge);
    interactionBusy = false;
    return;
  }

  try {
    if (blender?.ready) {
      await chrome.runtime.sendMessage({
        type: "VIEWCODER_SET_BLENDER",
        enabled: false,
      });
    } else if (blender?.enabled) {
      await chrome.runtime.sendMessage({
        type: "VIEWCODER_RECONNECT_BLENDER",
      });
    } else {
      await chrome.runtime.sendMessage({
        type: "VIEWCODER_SET_BLENDER",
        enabled: true,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    await refreshBridgeStatus(true);
  } catch (error) {
    blenderFeedback.classList.add("is-error");
    blenderFeedback.textContent =
      error instanceof Error ? error.message : String(error);
    blenderToggle.disabled = false;
  } finally {
    interactionBusy = false;
  }
});

activeModeToggle.addEventListener("click", async () => {
  const previous = activeMode;
  activeMode = !activeMode;
  renderActiveMode();
  if (previewMode) return;
  activeModeToggle.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: "VIEWCODER_SET_ACTIVE_MODE",
      enabled: activeMode,
    });
    if (!result?.ok) throw new Error(result?.error || "Active Mode was not saved.");
    activeMode = result.enabled !== false;
  } catch {
    activeMode = previous;
  } finally {
    activeModeToggle.disabled = false;
    renderActiveMode();
  }
});

animationModeToggle.addEventListener("click", async () => {
  const enabling = !viewModes.animationMode;
  const result = await setViewModes({ animationMode: enabling });
  if (!result?.ok) return;
  if (enabling) {
    rigChooser.hidden = false;
    creativeModeFeedback.textContent = viewModes.rig?.importedAt
      ? "Animation Mode is on and the imported Roblox rig is ready."
      : "Animation Mode is on. Import the bundled rig below.";
  }
});

iconModeToggle.addEventListener("click", async () => {
  if (!activeProviderCanGenerateUi()) {
    creativeModeFeedback.textContent =
      "AI Generated UI is unavailable on this AI. This AI may use a matching preset icon when suitable.";
    return;
  }
  await setViewModes({ iconMode: !viewModes.iconMode });
});

rigImport.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Are you sure you want to switch to Animation Mode? This will permanently delete everything in your current Blender project before importing the animation rig. Save your .blend file first if needed.",
  );
  if (!confirmed) {
    rigImportStatus.classList.remove("is-error");
    rigImportStatus.textContent = "Import cancelled. Blender was not changed.";
    return;
  }
  rigImport.disabled = true;
  rigImportStatus.classList.remove("is-error");
  rigImportStatus.textContent = "Clearing Blender and importing the animation rig at world origin…";
  if (previewMode) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    viewModes = {
      ...viewModes,
      animationMode: true,
      rig: {
        ...rigDraft,
        name: "ViewCoder_Animation_Rig_Preview",
        importedAt: new Date().toISOString(),
      },
    };
    renderViewModes();
    rigImport.disabled = false;
    return;
  }
  try {
    const result = await chrome.runtime.sendMessage({
      type: "VIEWCODER_IMPORT_RIG",
      rig: {},
    });
    if (!result?.ok) {
      throw new Error(result?.error || "The Roblox rig was not imported.");
    }
    viewModes = result.modes;
    rigDraft = { ...viewModes.rig };
    renderViewModes();
    rigImportStatus.textContent = viewModes.rig.name
      ? `${viewModes.rig.name} is centered at world origin in Blender Animation workspace.`
      : "The animation rig is centered at world origin in Blender Animation workspace.";
  } catch (error) {
    rigImportStatus.classList.add("is-error");
    rigImportStatus.textContent =
      error instanceof Error ? error.message : String(error);
  } finally {
    rigImport.disabled = false;
  }
});

function setBridgeActionsBusy(busy) {
  interactionBusy = busy;
  bridgeRecheck.disabled = busy;
  studioRestart.disabled = busy;
}
