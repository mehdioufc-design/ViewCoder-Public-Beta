const BRIDGE_URL = "http://127.0.0.1:3000";
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const DEFAULT_PROVIDER = "deepseek";
const REQUEST_TIMEOUT_MS = 12_000;
const STATUS_CACHE_MS = 1_500;
const STARTED_SESSION_LIMIT = 300;
const ACTIVE_WORK_KEY = "viewcoderActiveWork";
const ACTIVE_MODE_KEY = "viewcoderActiveMode";
const VIEW_MODES_KEY = "viewcoderModeState";
const ACTIVE_MODE_ALARM = "viewcoder-active-mode-heartbeat";
const ACTIVE_MODE_PERIOD_MINUTES = 0.5;
const WATCHDOG_ALARM_PREFIX = "viewcoder-watchdog:";
const DEFAULT_VIEW_MODES = Object.freeze({
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
});

function normalizedWatchdogToken(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 180);
}

function watchdogAlarmName(tabId, token) {
  return `${WATCHDOG_ALARM_PREFIX}${Number(tabId)}:${normalizedWatchdogToken(token)}`;
}

function parseWatchdogAlarmName(name) {
  const raw = String(name || "");
  if (!raw.startsWith(WATCHDOG_ALARM_PREFIX)) return null;
  const suffix = raw.slice(WATCHDOG_ALARM_PREFIX.length);
  const separator = suffix.indexOf(":");
  if (separator < 1) return null;
  const tabId = Number(suffix.slice(0, separator));
  const token = normalizedWatchdogToken(suffix.slice(separator + 1));
  return Number.isInteger(tabId) && tabId >= 0 && token
    ? { tabId, token }
    : null;
}
let legacyCallSequence = 0;
const LIVE_CATALOG_TOOLS = new Set([
  "viewcoder/get_capabilities",
  "list_commands",
  "list_mcp_servers",
]);
let statusCache = { at: 0, value: null, error: null };
let statusRequest = null;
let statusEpoch = 0;
let startedSessionWrite = Promise.resolve();
let activeWorkWrite = Promise.resolve();

function isStartedSessionKey(value) {
  return (
    typeof value === "string" &&
    /^(deepseek|gemini|kimi|glm|qwen|arena|meta|chatgpt|claude):/.test(value)
  );
}

function rememberStartedSession(key) {
  // Content scripts in multiple AI tabs can start at almost the same moment.
  // Serialize read/merge/write operations in the one MV3 service worker so one
  // tab can never overwrite another provider's remembered session list.
  startedSessionWrite = startedSessionWrite
    .catch(() => undefined)
    .then(async () => {
      if (!isStartedSessionKey(key)) {
        return { ok: false, error: "Invalid ViewCoder session key." };
      }
      const stored = await chrome.storage.local.get("zsStartedSessions");
      const sessions = new Set(
        Array.isArray(stored.zsStartedSessions)
          ? stored.zsStartedSessions.filter(isStartedSessionKey)
          : [],
      );
      // Refresh insertion order when the session is used again so the bounded
      // list behaves like a small LRU instead of discarding an active chat.
      sessions.delete(key);
      sessions.add(key);
      while (sessions.size > STARTED_SESSION_LIMIT) {
        sessions.delete(sessions.values().next().value);
      }
      await chrome.storage.local.set({
        zsStartedSessions: [...sessions],
      });
      return { ok: true };
    });
  return startedSessionWrite;
}

function validWorkKey(value) {
  return isStartedSessionKey(value) && value.length <= 700;
}

async function liveWorkOwner() {
  const stored = await chrome.storage.local.get(ACTIVE_WORK_KEY);
  const owner = stored[ACTIVE_WORK_KEY];
  if (!owner || !Number.isInteger(owner.tabId) || !validWorkKey(owner.key)) {
    if (owner) await chrome.storage.local.remove(ACTIVE_WORK_KEY);
    return null;
  }
  // A content script can disappear on extension reload without closing its tab.
  // The live worker refreshes this lease every 15 seconds. Browser background
  // throttling can delay both that timer and the 30-second MV3 alarm, so use a
  // 90-second grace period instead of falsely abandoning a live long task.
  if (Date.now() - Number(owner.touchedAt || 0) > 90_000) {
    await chrome.storage.local.remove(ACTIVE_WORK_KEY);
    return null;
  }
  try {
    await chrome.tabs.get(owner.tabId);
    return owner;
  } catch {
    await chrome.storage.local.remove(ACTIVE_WORK_KEY);
    return null;
  }
}

async function activeModes() {
  const stored = await chrome.storage.local.get(ACTIVE_MODE_KEY);
  return {
    enabled: stored[ACTIVE_MODE_KEY] !== false,
  };
}

function normalizedViewModes(value = {}) {
  const rig = value?.rig && typeof value.rig === "object" ? value.rig : {};
  return {
    operatingMode: value?.operatingMode === "plan" ? "plan" : "agent",
    animationMode: value?.animationMode === true,
    iconMode: value?.iconMode !== false,
    rig: {
      rigType: "R15",
      bodyShape: "Official",
      preset: "Blocky Character",
      name: typeof rig.name === "string" && rig.name ? rig.name : null,
      importedAt:
        typeof rig.importedAt === "string" && rig.importedAt
          ? rig.importedAt
          : null,
    },
  };
}

async function viewModes() {
  const stored = await chrome.storage.local.get(VIEW_MODES_KEY);
  return normalizedViewModes(stored[VIEW_MODES_KEY]);
}

async function saveViewModes(next) {
  const normalized = normalizedViewModes(next);
  await chrome.storage.local.set({ [VIEW_MODES_KEY]: normalized });
  return normalized;
}

async function syncActiveModeAlarm() {
  const modes = await activeModes();
  if (!modes.enabled) {
    await chrome.alarms.clear(ACTIVE_MODE_ALARM);
    return false;
  }
  const owner = await liveWorkOwner();
  if (!owner) {
    await chrome.alarms.clear(ACTIVE_MODE_ALARM);
    return false;
  }
  chrome.alarms.create(ACTIVE_MODE_ALARM, {
    delayInMinutes: ACTIVE_MODE_PERIOD_MINUTES,
    periodInMinutes: ACTIVE_MODE_PERIOD_MINUTES,
  });
  // Prevent Chrome/Edge from discarding the one tab that owns the live task.
  // This does not activate or focus the tab.
  try {
    await chrome.tabs.update(owner.tabId, { autoDiscardable: false });
  } catch {
    // liveWorkOwner will remove a missing tab on the next heartbeat.
  }
  return true;
}

function claimActiveWork(key, sender) {
  activeWorkWrite = activeWorkWrite
    .catch(() => undefined)
    .then(async () => {
      const tabId = sender?.tab?.id;
      if (!Number.isInteger(tabId) || !validWorkKey(key)) {
        return { ok: false, error: "ViewCoder could not identify this chat." };
      }
      const owner = await liveWorkOwner();
      if (owner && owner.tabId !== tabId) {
        return { ok: false, locked: true, owner };
      }
      const next = { key, tabId, touchedAt: Date.now() };
      await chrome.storage.local.set({ [ACTIVE_WORK_KEY]: next });
      await syncActiveModeAlarm();
      return { ok: true, owner: next, ownedByCaller: true };
    });
  return activeWorkWrite;
}

function releaseActiveWork(key, sender) {
  activeWorkWrite = activeWorkWrite
    .catch(() => undefined)
    .then(async () => {
      const tabId = sender?.tab?.id;
      const owner = await liveWorkOwner();
      if (!owner) return { ok: true, released: false };
      if (owner.tabId !== tabId || (key && owner.key !== key)) {
        return { ok: false, released: false, owner };
      }
      await chrome.storage.local.remove(ACTIVE_WORK_KEY);
      await syncActiveModeAlarm();
      return { ok: true, released: true };
    });
  return activeWorkWrite;
}

function invalidateStatusCache() {
  statusEpoch += 1;
  statusCache = { at: 0, value: null, error: null };
  // Do not let callers that arrive after a mutation wait on the pre-mutation
  // status request. Its response is still delivered to its original callers,
  // but the epoch guard prevents it from repopulating the cache.
  statusRequest = null;
}

async function bridgeStatus(force = false) {
  const fresh =
    !force &&
    Date.now() - statusCache.at < STATUS_CACHE_MS;
  if (fresh) {
    if (statusCache.error) throw statusCache.error;
    return statusCache.value;
  }
  if (statusRequest) return statusRequest;

  const requestEpoch = statusEpoch;
  const request = bridgeRequest("/status")
    .then((value) => {
      if (requestEpoch === statusEpoch) {
        statusCache = { at: Date.now(), value, error: null };
      }
      return value;
    })
    .catch((error) => {
      // Briefly cache offline failures too. Without this, every content script
      // and the popup independently hammered a stopped bridge at the same time.
      if (requestEpoch === statusEpoch) {
        statusCache = { at: Date.now(), value: null, error };
      }
      throw error;
    })
    .finally(() => {
      if (statusRequest === request) statusRequest = null;
    });
  statusRequest = request;
  return request;
}

async function bridgeMutation(path, options, timeoutMs) {
  invalidateStatusCache();
  try {
    return await bridgeRequest(path, options, timeoutMs);
  } finally {
    invalidateStatusCache();
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get([
    "selectedProvider",
    ACTIVE_MODE_KEY,
    VIEW_MODES_KEY,
  ]);
  const updates = {};
  if (!current.selectedProvider) {
    updates.selectedProvider = DEFAULT_PROVIDER;
  }
  if (typeof current[ACTIVE_MODE_KEY] !== "boolean") {
    updates[ACTIVE_MODE_KEY] = true;
  }
  if (!current[VIEW_MODES_KEY]) {
    updates[VIEW_MODES_KEY] = DEFAULT_VIEW_MODES;
  }
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  // Remove data left by the discontinued usage-reporting feature.
  await chrome.storage.local.remove([
    "viewcoderAnonymousAnalytics",
    "viewcoderAnonymousProfile",
    "viewcoderAnonymousSession",
  ]);
  await syncActiveModeAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await syncActiveModeAlarm();
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  const watchdog = parseWatchdogAlarmName(alarm.name);
  if (watchdog) {
    // One-shot alarms run in the MV3 worker even while Chrome throttles the
    // provider tab. They never focus or reload it; they only wake the matching
    // content-script deadline.
    void chrome.tabs.sendMessage(watchdog.tabId, {
      type: "viewcoder-watchdog-tick",
      token: watchdog.token,
      firedAt: Date.now(),
    }).catch(() => undefined);
    return;
  }
  if (alarm.name !== ACTIVE_MODE_ALARM) return;
  activeWorkWrite = activeWorkWrite
    .catch(() => undefined)
    .then(async () => {
      const modes = await activeModes();
      if (!modes.enabled) {
        await chrome.alarms.clear(ACTIVE_MODE_ALARM);
        return;
      }
      const owner = await liveWorkOwner();
      if (!owner) {
        await chrome.alarms.clear(ACTIVE_MODE_ALARM);
        return;
      }
      const refreshed = { ...owner, touchedAt: Date.now() };
      await chrome.storage.local.set({ [ACTIVE_WORK_KEY]: refreshed });
      // Re-assert the non-discardable state on every service-worker heartbeat.
      // Browsers may reset it after navigation or memory-pressure recovery. This
      // never activates, focuses, or reloads the provider tab.
      try {
        await chrome.tabs.update(owner.tabId, { autoDiscardable: false });
      } catch {
        // The next heartbeat releases a missing owner.
      }
      try {
        await chrome.tabs.sendMessage(owner.tabId, {
          type: "viewcoder-active-tick",
          maximum: modes.maximum,
        });
      } catch {
        // The next heartbeat or tab-close event releases an unreachable owner.
      }
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  activeWorkWrite = activeWorkWrite
    .catch(() => undefined)
    .then(async () => {
      const stored = await chrome.storage.local.get(ACTIVE_WORK_KEY);
      if (stored[ACTIVE_WORK_KEY]?.tabId === tabId) {
        await chrome.storage.local.remove(ACTIVE_WORK_KEY);
        await syncActiveModeAlarm();
      }
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        statusCode: Number(error?.statusCode) || 0,
        retryable:
          error?.retryable === true ||
          Number(error?.statusCode) === 408 ||
          Number(error?.statusCode) === 429 ||
          Number(error?.statusCode) >= 500,
      });
    });
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "schedule_watchdog": {
      const tabId = Number(sender?.tab?.id);
      const token = normalizedWatchdogToken(message.token);
      const deadline = Number(message.deadline);
      if (!Number.isInteger(tabId) || tabId < 0 || !token || !Number.isFinite(deadline)) {
        return { ok: false, error: "A valid tab watchdog deadline is required." };
      }
      const name = watchdogAlarmName(tabId, token);
      chrome.alarms.create(name, { when: Math.max(Date.now() + 100, deadline) });
      return { ok: true, name, deadline };
    }

    case "cancel_watchdog": {
      const tabId = Number(sender?.tab?.id);
      const token = normalizedWatchdogToken(message.token);
      if (!Number.isInteger(tabId) || tabId < 0 || !token) return { ok: false };
      return {
        ok: true,
        cleared: await chrome.alarms.clear(watchdogAlarmName(tabId, token)),
      };
    }

    // Compatibility contract used by ViewCoder's provider-specific agent loop.
    // The UI retains ViewCoder's proven execution lifecycle while this
    // adapter keeps ViewCoder's HTTP bridge and optional Blender routing.
    case "status":
      return legacyStatus();

    case "remember_session":
      return rememberStartedSession(String(message.key || ""));

    case "active_work": {
      const owner = await liveWorkOwner();
      return {
        ok: true,
        owner,
        ownedByCaller: !!owner && owner.tabId === sender?.tab?.id,
      };
    }

    case "claim_active_work":
      return claimActiveWork(String(message.key || ""), sender);

    case "release_active_work":
      return releaseActiveWork(String(message.key || ""), sender);

    case "active_mode":
    case "VIEWCODER_ACTIVE_MODE": {
      const modes = await activeModes();
      return { ok: true, enabled: modes.enabled };
    }

    case "set_active_mode":
    case "VIEWCODER_SET_ACTIVE_MODE": {
      const enabled = message.enabled !== false;
      await chrome.storage.local.set({ [ACTIVE_MODE_KEY]: enabled });
      await syncActiveModeAlarm();
      const modes = await activeModes();
      return { ok: true, enabled: modes.enabled };
    }

    case "viewcoder_modes":
    case "VIEWCODER_MODES": {
      return { ok: true, modes: await viewModes() };
    }

    case "set_viewcoder_modes":
    case "VIEWCODER_SET_MODES": {
      const current = await viewModes();
      const requested = message.modes && typeof message.modes === "object"
        ? message.modes
        : {};
      const next = normalizedViewModes({
        ...current,
        ...requested,
        rig: {
          ...current.rig,
          ...(requested.rig && typeof requested.rig === "object"
            ? requested.rig
            : {}),
        },
      });
      if (next.animationMode && !current.animationMode) {
        const status = await bridgeStatus(true).catch(() => null);
        const blender = status?.servers?.find(
          (server) => server?.id === "blender",
        );
        if (!blender?.ready) {
          return {
            ok: false,
            modes: current,
            error:
              "Animation Mode requires Blender. Connect Blender and start its MCP server first.",
          };
        }
      }
      return { ok: true, modes: await saveViewModes(next) };
    }

    case "VIEWCODER_IMPORT_RIG": {
      const rig = message.rig && typeof message.rig === "object"
        ? message.rig
        : {};
      const status = await bridgeStatus(true);
      if (status?.version !== EXTENSION_VERSION) {
        return {
          ok: false,
          error: `ViewCoder v${EXTENSION_VERSION} is loaded, but bridge v${status?.version || "unknown"} is still running. Close the old ViewCoder window, run this package's start.bat, then retry.`,
        };
      }
      let imported;
      try {
        imported = await bridgeMutation(
          "/animation/rig",
          {
            method: "POST",
            body: JSON.stringify(rig),
          },
          65_000,
        );
      } catch (error) {
        if (
          Number(error?.statusCode) === 404 ||
          /unknown viewcoder bridge endpoint/i.test(String(error?.message || error))
        ) {
          return {
            ok: false,
            error: "The running ViewCoder bridge is outdated. Close its original window and restart this package's start.bat before importing a rig.",
          };
        }
        throw error;
      }
      const current = await viewModes();
      const modes = await saveViewModes({
        ...current,
        animationMode: true,
        rig: {
          rigType: "R15",
          bodyShape: "Official",
          preset: "Blocky Character",
          name: imported?.rig?.name || null,
          importedAt: new Date().toISOString(),
        },
      });
      return { ok: true, modes, import: imported };
    }

    case "list_tools": {
      const result = await bridgeToolsRequest();
      return {
        ok: result.ok !== false,
        tools: result.tools ?? [],
        servers: legacyServers(result.servers),
      };
    }

    case "call_tool":
      return callLegacyTool(
        String(message.name || ""),
        message.arguments ?? {},
        Number(message.timeout) || 120_000,
        String(message.requestKey || ""),
      );

    case "relay_image": {
      const data = String(message.data || "");
      if (!data) {
        return { ok: false, error: "The selected image has no readable data." };
      }
      return bridgeMutation(
        "/images",
        {
          method: "POST",
          body: JSON.stringify({
            data,
            mimeType: String(message.mimeType || ""),
            name: String(message.name || "viewcoder-image"),
          }),
        },
        30_000,
      );
    }

    case "relay_remote_image": {
      const url = String(message.url || "").trim();
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, error: "A public HTTP or HTTPS image URL is required." };
      }
      return bridgeMutation(
        "/images/fetch",
        {
          method: "POST",
          body: JSON.stringify({
            url,
            name: String(message.name || "viewcoder-remote-image"),
          }),
        },
        25_000,
      );
    }

    case "cancel_keyboard_input":
      return bridgeMutation(
        "/input/cancel",
        { method: "POST", body: "{}" },
        5_000,
      );

    case "restart_mcp":
      return bridgeMutation(
        "/mcp/reconnect",
        { method: "POST", body: "{}" },
        30_000,
      );

    case "add_server": {
      const serverId = String(message.server_id || "").toLowerCase();
      if (serverId !== "blender") {
        return {
          ok: false,
          error: "ViewCoder supports Blender as its optional MCP server.",
        };
      }
      return bridgeMutation(
        `/servers/${serverId}`,
        {
          method: "POST",
          body: JSON.stringify({ enabled: true }),
        },
        25_000,
      );
    }

    case "remove_server": {
      const serverId = String(message.server_id || "").toLowerCase();
      if (serverId !== "blender") {
        return {
          ok: false,
          error: "Only the optional Blender server can be removed.",
        };
      }
      return bridgeMutation(
        `/servers/${serverId}`,
        {
          method: "POST",
          body: JSON.stringify({ enabled: false }),
        },
        25_000,
      );
    }

    case "VIEWCODER_STATUS": {
      const { selectedProvider = DEFAULT_PROVIDER } =
        await chrome.storage.local.get("selectedProvider");
      try {
        const status = await bridgeStatus();
        return {
          ok: true,
          selectedProvider,
          bridge: status,
        };
      } catch (error) {
        return {
          ok: false,
          selectedProvider,
          bridge: {
            online: false,
            totalToolCount: 0,
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
          },
          error:
            error instanceof Error
              ? error.message
              : "ViewCoder bridge is offline.",
        };
      }
    }

    case "VIEWCODER_TOOLS":
      return bridgeToolsRequest();

    case "VIEWCODER_SERVERS":
      return bridgeRequest("/servers");

    case "VIEWCODER_SET_BLENDER":
      return bridgeMutation(
        "/servers/blender",
        {
          method: "POST",
          body: JSON.stringify({
            enabled: message.enabled === true,
          }),
        },
        25_000,
      );

    case "VIEWCODER_RECONNECT_BLENDER":
      return bridgeMutation(
        "/servers/blender/reconnect",
        {
          method: "POST",
          body: "{}",
        },
        25_000,
      );

    case "VIEWCODER_VERIFY":
      return bridgeMutation(
        "/mcp/verify",
        {
          method: "POST",
          body: "{}",
        },
        25_000,
      );

    case "VIEWCODER_PUSH":
      return bridgeRequest(
        "/push",
        {
          method: "POST",
          body: JSON.stringify(message.payload ?? {}),
        },
        25_000,
      );

    case "VIEWCODER_PULL": {
      const after = Number.isFinite(Number(message.after))
        ? Number(message.after)
        : 0;
      const sessionId = encodeURIComponent(
        String(message.sessionId ?? ""),
      );
      return bridgeRequest(
        `/pull?after=${after}&sessionId=${sessionId}`,
      );
    }

    case "VIEWCODER_RECONNECT":
      return bridgeMutation(
        "/mcp/reconnect",
        {
          method: "POST",
          body: "{}",
        },
        25_000,
      );

    case "VIEWCODER_REMEMBER_PROVIDER": {
      const provider = providerById(message.providerId);
      if (!provider) {
        throw new Error(`Unknown AI provider: ${message.providerId}`);
      }
      await chrome.storage.local.set({
        selectedProvider: provider.id,
      });
      return { ok: true };
    }

    case "VIEWCODER_OPEN_PROVIDER": {
      const provider = providerById(message.providerId);
      if (!provider) {
        throw new Error(`Unknown AI provider: ${message.providerId}`);
      }

      await chrome.storage.local.set({
        selectedProvider: provider.id,
      });
      const tabId = message.tabId ?? sender.tab?.id;
      if (tabId) {
        await chrome.tabs.update(tabId, { url: provider.url });
      } else {
        await chrome.tabs.create({ url: provider.url });
      }
      return { ok: true };
    }

    default:
      return {
        ok: false,
        error: "Unsupported ViewCoder message.",
      };
  }
}

async function legacyStatus() {
  try {
    const status = await bridgeStatus();
    const connected = status.online === true;
    const verified = status.mcp?.verified === true;
    return {
      type: "zs-status",
      connected,
      mcpAlive:
        status.mcp?.state === "ready" ||
        status.mcp?.state === "connected",
      studio: verified,
      studioApp:
        typeof status.mcp?.studio === "boolean"
          ? status.mcp.studio
          : null,
      studioProc:
        typeof status.mcp?.studioProcess === "boolean"
          ? status.mcp.studioProcess
          : typeof status.studioProcess === "boolean"
            ? status.studioProcess
            : null,
      tools: Number(status.totalToolCount) || 0,
      servers: legacyServers(status.servers),
    };
  } catch {
    return {
      type: "zs-status",
      connected: false,
      mcpAlive: false,
      studio: null,
      studioApp: null,
      studioProc: null,
      tools: 0,
      servers: [],
    };
  }
}

function legacyServers(servers) {
  return (Array.isArray(servers) ? servers : []).map(
    (server) => ({
      id: server.id,
      name:
        server.id === "roblox"
          ? "Roblox Studio"
          : server.id === "blender"
            ? "Blender"
            : server.id,
      alive: server.ready === true,
      tools: Number(
        server.toolCount ?? server.tools ?? 0,
      ),
      command: server.command ?? "",
    }),
  );
}

function stableRequestToken(value) {
  const text = String(value || "");
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b
    .toString(16)
    .padStart(8, "0")}`;
}

function legacyToolReceipt(event) {
  if (!event || typeof event !== "object") return null;
  return event.ok
    ? {
        ok: true,
        text: event.text || "",
        images: event.images || [],
        code: event.code,
        generationId: event.generationId,
      }
    : {
        ok: false,
        kind:
          event.code === "JOB_STILL_RUNNING"
            ? "running"
            : event.retryable
              ? "retryable"
              : "tool",
        error: event.error || "The Studio command failed.",
        code: event.code,
      };
}

async function callLegacyTool(
  name,
  argumentsObject,
  timeoutMs,
  requestKey = "",
) {
  if (!name) {
    return {
      ok: false,
      kind: "invalid",
      error: "A ViewCoder tool name is required.",
    };
  }
  legacyCallSequence += 1;
  const requiresFreshCatalog = LIVE_CATALOG_TOOLS.has(
    String(name).trim().toLowerCase(),
  );
  const nonce = requestKey && !requiresFreshCatalog
    ? stableRequestToken(requestKey)
    : globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${legacyCallSequence}`;
  const sessionId = `viewcoder-loop-${nonce}`;
  const requestId = `${sessionId}:${name}`;
  const pushed = await bridgeRequest(
    "/push",
    {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        requestId,
        tool: name,
        arguments:
          argumentsObject &&
          typeof argumentsObject === "object"
            ? argumentsObject
            : {},
        source: {
          provider: "viewcoder-loop",
          promptRevision: nonce,
        },
      }),
    },
    25_000,
  );
  if (!pushed?.ok || !pushed.jobId) {
    return {
      ok: false,
      kind: "rejected",
      error:
        pushed?.error || "The ViewCoder bridge rejected the command.",
    };
  }
  if (pushed.result) {
    return legacyToolReceipt(pushed.result);
  }

  const deadline =
    Date.now() +
    Math.max(20_000, Math.min(timeoutMs + 30_000, 180_000));
  let cursor = 0;
  let supportsJobStatus = true;
  let lastPollingError = "";
  while (Date.now() < deadline) {
    if (supportsJobStatus) {
      try {
        const status = await bridgeRequest(
          `/jobs/${encodeURIComponent(pushed.jobId)}?sessionId=${encodeURIComponent(sessionId)}`,
          {},
          8_000,
        );
        if (status?.result) return legacyToolReceipt(status.result);
      } catch (error) {
        if (error?.statusCode === 404) {
          // Compatibility with a bridge from before job-specific receipts.
          supportsJobStatus = false;
        } else {
          lastPollingError = error instanceof Error ? error.message : String(error);
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
      }
    }

    if (!supportsJobStatus) {
      try {
        const pulled = await bridgeRequest(
          `/pull?after=${cursor}&sessionId=${encodeURIComponent(sessionId)}`,
          {},
          15_000,
        );
        cursor = Math.max(cursor, Number(pulled.cursor) || 0);
        const event = (pulled.events ?? []).find(
          (candidate) =>
            candidate.jobId === pushed.jobId ||
            candidate.requestId === requestId,
        );
        if (event) return legacyToolReceipt(event);
      } catch (error) {
        lastPollingError = error instanceof Error ? error.message : String(error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return {
    ok: false,
    kind: "timeout",
    error:
      lastPollingError ||
      "The ViewCoder bridge is still waiting for the Studio command.",
  };
}

async function bridgeRequest(
  path,
  options = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { ...(options.headers ?? {}) };
    const hasContentType = Object.keys(headers).some(
      (name) => name.toLowerCase() === "content-type",
    );
    if (options.body != null && !hasContentType) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(`${BRIDGE_URL}${path}`, {
      ...options,
      headers,
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        body.error ??
          `ViewCoder bridge returned HTTP ${response.status}.`,
      );
      error.statusCode = response.status;
      error.retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      throw error;
    }
    return body;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(
        "ViewCoder bridge did not respond in time.",
      );
      timeoutError.statusCode = 408;
      timeoutError.retryable = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

let toolsRequestPromise = null;

function bridgeToolsRequest() {
  if (!toolsRequestPromise) {
    toolsRequestPromise = bridgeRequest("/tools", {}, 25_000).finally(() => {
      toolsRequestPromise = null;
    });
  }
  return toolsRequestPromise;
}

function providerById(id) {
  const providers = {
    deepseek: "https://chat.deepseek.com/",
    gemini: "https://gemini.google.com/app",
    kimi: "https://www.kimi.com/",
    glm: "https://chat.z.ai/",
    qwen: "https://chat.qwen.ai/",
    arena: "https://arena.ai/",
    meta: "https://www.meta.ai/",
    chatgpt: "https://chatgpt.com/",
    claude: "https://claude.ai/new",
  };
  return providers[id] ? { id, url: providers[id] } : null;
}
