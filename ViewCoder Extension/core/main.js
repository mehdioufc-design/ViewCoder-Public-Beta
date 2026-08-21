// core/main.js - the provider-agnostic agentic loop, UI and session state.
// Drives any AI chat site through the ZSProvider interface (providers/*.js):
// waits for the model's reply, parses ViewCoder commands (ZSParse), asks the
// background worker to execute them on the Roblox MCP bridge, and feeds the
// result back. Camouflages the system prompt ("Starting Up") and tool JSON
// behind animated chips, masks injected input, and exposes a Stop button.
// The model ALWAYS receives an output.
//
// This file must NEVER touch the host site's DOM directly - everything
// site-specific goes through P (the provider). Our OWN UI (panel, chips,
// banners…) is plain DOM we create ourselves and is allowed here.

(() => {
  "use strict";
  // A defensive document-level singleton. Browser extension reloads and some SPA
  // recovery paths can attempt to inject content scripts again; without a guard
  // that creates duplicate observers, timers, bars and tool dispatches.
  if (globalThis.__viewcoderAgentCoreLoaded) return;
  globalThis.__viewcoderAgentCoreLoaded = true;
  const P = ZSProvider;
  const T = P.timings;
  // These providers share ZeroScript's proven activity-card lifecycle: every
  // host mutation schedules a full, idempotent classification pass, internal
  // turns are pre-hidden in the observer microtask, and a 1.5 s repair sweep
  // restores cards removed by virtualization. Keep ChatGPT, Meta AI and Claude
  // on ViewCoder's newer scoped lifecycle because ZeroScript has no equivalent
  // adapter behavior for those surfaces.
  const ZERO_ACTIVITY_LIFECYCLE_PROVIDERS = new Set([
    "deepseek", "gemini", "kimi", "glm", "qwen", "arena",
  ]);
  const useZeroActivityLifecycle = ZERO_ACTIVITY_LIFECYCLE_PROVIDERS.has(P.id);
  // Hidden provider tabs can have page timers clamped for many seconds. Keep
  // ordinary waits locally cheap, but make them externally wakeable by the MV3
  // service worker so Active Mode can re-check exact watchdog deadlines.
  const timedSleepWaiters = new Set();
  const activeWatchdogs = new Map();
  const sleep = (ms) => new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      timedSleepWaiters.delete(done);
      resolve();
    };
    timedSleepWaiters.add(done);
    timer = setTimeout(done, Math.max(0, Number(ms) || 0));
  });
  const wakeTimedWaits = () => {
    for (const done of [...timedSleepWaiters]) done();
  };
  const watchdogToken = (kind = "wait") => {
    const nonce = globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${kind}-${nonce}`;
  };
  function createDeadlineWatchdog(deadline, token, onExpire) {
    const safeToken = String(token || watchdogToken());
    const state = {
      deadline: Number(deadline) || Date.now(),
      timer: null,
      cancelled: false,
      expired: false,
      lastBackgroundDeadline: 0,
      fire(source = "local") {
        if (state.cancelled) return;
        const now = Date.now();
        // A progress update can move the local deadline slightly beyond the
        // last service-worker alarm. Re-arm instead of treating that early
        // alarm as a stall.
        if (now + 25 < state.deadline) {
          state.arm(state.deadline, true);
          return;
        }
        state.expired = true;
        wakeTimedWaits();
        try { onExpire?.(source); } catch {}
      },
      arm(nextDeadline, forceBackground = false) {
        if (state.cancelled) return;
        state.deadline = Number(nextDeadline) || Date.now();
        state.expired = false;
        clearTimeout(state.timer);
        state.timer = setTimeout(
          () => state.fire("local"),
          Math.max(0, state.deadline - Date.now()),
        );
        // Streaming can produce hundreds of DOM updates. Re-arm the durable
        // alarm only when its target moves materially; an early alarm calls
        // fire(), notices the newer deadline, and re-arms exactly.
        if (
          forceBackground ||
          Math.abs(state.deadline - state.lastBackgroundDeadline) >= 1_500
        ) {
          state.lastBackgroundDeadline = state.deadline;
          void bg({
            type: "schedule_watchdog",
            token: safeToken,
            deadline: state.deadline,
          });
        }
      },
      cancel() {
        if (state.cancelled) return;
        state.cancelled = true;
        clearTimeout(state.timer);
        activeWatchdogs.delete(safeToken);
        void bg({ type: "cancel_watchdog", token: safeToken });
      },
    };
    activeWatchdogs.set(safeToken, state);
    state.arm(state.deadline, true);
    return state;
  }
  function waitForWatchdogDeadline(deadline, token) {
    let resolveDeadline;
    const promise = new Promise((resolve) => { resolveDeadline = resolve; });
    const watchdog = createDeadlineWatchdog(
      deadline,
      token,
      (source) => resolveDeadline({ kind: "receipt-recovery", source }),
    );
    return { promise, cancel: () => watchdog.cancel() };
  }
  const log = (...a) => console.log("[viewcoder]", ...a);
  const hasSystemMarker = (text) =>
    ZS.SYS_MARKERS.some((marker) => String(text || "").includes(marker));

  // ── Anti-bot mitigation (EXPERIMENTAL) ──────────────────────────────────
  // Suspected contributor to Arena's captcha: the agentic loop sends turns
  // back-to-back with near-zero, perfectly regular delay (~200ms settle),
  // which behavioral risk-scoring (reCAPTCHA/Cloudflare) can read as a bot
  // signal alongside the necessarily-synthetic input events. This adds a
  // small randomized human-reaction-time delay before each send.
  // REVERT: flip HUMANIZE_SEND to false - single toggle, no other changes needed.
  const HUMANIZE_SEND = false; // didn't prevent Arena's captcha (fires on turn 1 already) - revert
  const SEND_JITTER_MS = [400, 1400]; // [min, max] ms, randomized per send
  function jitterBeforeSend() {
    if (!HUMANIZE_SEND) return Promise.resolve();
    const [lo, hi] = SEND_JITTER_MS;
    return sleep(lo + Math.random() * (hi - lo));
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────
  // Persistent, lightweight breadcrumb log of the agentic loop's key decisions
  // (sends, response kinds, tool start/end, resumes, stops). Read back from the
  // console (filter "[zs-diag]") or window.__zsDiag (also mirrored onto a hidden
  // DOM node for a main-world inspector). Each entry carries a turn snapshot.
  // Keep production sessions lean. The prior always-on trace serialized the
  // complete history into a hidden DOM node on every breadcrumb, which became
  // increasingly expensive in long chats. It remains available on demand via
  // localStorage.setItem("viewcoderDebug", "1") before reloading the page.
  const DEBUG_DIAGNOSTICS =
    (() => { try { return localStorage.getItem("viewcoderDebug") === "1"; } catch { return false; } })();
  const ZS_DIAG_MAX = 300;
  const _diag = [];
  // Provider init runs before the full agent state is constructed. Keeping a
  // nullable diagnostic reference avoids a temporal-dead-zone crash when debug
  // logging is enabled and a provider emits an init breadcrumb.
  let diagnosticAgentState = null;
  function diag(event, data) {
    if (!DEBUG_DIAGNOSTICS) return;
    const snap = {
      ...P.snapshot(),
      gen: P.isGenerating(),
      run: diagnosticAgentState?.running ?? false,
    };
    const e = { t: Date.now(), iso: new Date().toISOString().slice(11, 23), event,
                data: data || null, snap };
    _diag.push(e);
    if (_diag.length > ZS_DIAG_MAX) _diag.shift();
    try { console.log("[zs-diag]", e.iso, event, JSON.stringify({ ...data, ...snap })); } catch {}
    try {
      let n = document.getElementById("zs-diag-log");
      if (!n) { n = document.createElement("script"); n.type = "application/json"; n.id = "zs-diag-log"; (document.body || document.documentElement).appendChild(n); }
      n.textContent = JSON.stringify(_diag);
    } catch {}
    try { window.__zsDiag = _diag; } catch {}
  }
  P.init({ diag });

  // ── [TRACE] Main-thread stall detector ─────────────────────────────────────
  // The reported bug ("tools spin 15-20s, the chip timer stops rising") can only
  // be a SYNCHRONOUS block of the page's main thread: an async bridge/network wait
  // yields, so the 200ms UI interval (and its chip timer) would keep ticking. This
  // fires every 250ms and, whenever the ACTUAL gap since the last tick is far more
  // than expected, logs the stall. A `stall.detected` with a big `ms` right when
  // the user sees the freeze = the smoking gun; correlate its timestamp with the
  // surrounding diag events (esp. code.snapAll / dom.read.slow) to see WHAT ran.
  if (DEBUG_DIAGNOSTICS) {
    const EXPECT = 250, STALL = 800; // only log gaps beyond this many ms
    let _lastTick = Date.now();
    setInterval(() => {
      const now = Date.now();
      const gap = now - _lastTick;
      _lastTick = now;
      if (gap > STALL) {
        diag("stall.detected", { ms: gap, overBy: gap - EXPECT,
          toolRunning: A.toolRunning, running: A.running, injecting: A.injecting });
      }
    }, EXPECT);
  }

  // Shown in the panel instead of a static "Free" label, so a user's screenshot
  // alone tells us which build they're on for debugging. Pulled from
  // manifest.json (single source of truth) rather than duplicated here.
  const EXT_VERSION = chrome.runtime.getManifest().version;
  // Bounded receipt recovery for every real MCP command. The clock starts when
  // the assistant's finished command has been parsed, not while it is still
  // streaming. All eight retry dispatches carry the same requestKey, so the
  // bridge returns the original job/receipt instead of mutating twice.
  const TOOL_RECEIPT_RETRY_MS = 43_000;
  const TOOL_RECEIPT_MAX_RETRIES = 8;
  // A provider can accept the hidden tool-result user turn yet fail to create
  // the following assistant turn (observed live on ChatGPT after batch_read).
  // Treat that as a separate acknowledgement. The recovery below nudges the AI
  // to continue from the ALREADY-DELIVERED result; it never re-runs the MCP call.
  const TOOL_RESULT_REPLY_START_MS = 43_000;
  const TOOL_RESULT_REPLY_PROGRESS_MS = 43_000;
  const TOOL_RESULT_REPLY_MAX_NUDGES = 8;
  const VIEWCODER_DISCORD_URL = "https://discord.gg/VRcg7RBpV";
  const VIEWCODER_ROBUX_SUPPORT_URL = "https://www.roblox.com/users/8651250465/profile";
  const DISCORD_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.2 6.3A13 13 0 0 1 12 5.7a13 13 0 0 1 3.8.6c1.8 2.7 2.3 5.3 2 7.8-1.4 1.1-2.8 1.8-4.2 2.2l-1-1.4c.6-.2 1.1-.5 1.6-.8-1.5.7-3 .9-4.4.7a9.7 9.7 0 0 1-2-.7c.5.3 1 .6 1.6.8l-1 1.4c-1.4-.4-2.8-1.1-4.2-2.2-.3-2.5.2-5.1 2-7.8.7-.3 1.3-.5 2-.7Zm.7 4.2c-.8 0-1.4.7-1.4 1.6 0 .8.6 1.5 1.4 1.5s1.4-.7 1.4-1.5c0-.9-.6-1.6-1.4-1.6Zm6.2 0c-.8 0-1.4.7-1.4 1.6 0 .8.6 1.5 1.4 1.5s1.4-.7 1.4-1.5c0-.9-.6-1.6-1.4-1.6Z"/></svg>`;
  const COMMUNITY_REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
  const COMMUNITY_REMINDER_DELAY_MS = 2 * 60 * 1000;
  // AI chat sites ViewCoder works on. Keep in sync with manifest.json
  // content_scripts and background.js PROVIDER_URLS when adding a provider.
  const AI_SITES = [
    { name: "DeepSeek", icon: "🐋", url: "https://chat.deepseek.com/" },
    { name: "Gemini", icon: "✦", url: "https://gemini.google.com/app" },
    { name: "Kimi", icon: "🌙", url: "https://www.kimi.com/" },
    { name: "GLM", icon: "◆", url: "https://chat.z.ai/" },
    { name: "Qwen", icon: "✧", url: "https://chat.qwen.ai/" },
    { name: "Arena", icon: "⚔", url: "https://arena.ai/text/direct" },
    { name: "Meta AI", icon: "∞", url: "https://www.meta.ai/" },
    { name: "ChatGPT", icon: "⬡", url: "https://chatgpt.com/" },
    { name: "Claude", icon: "✳", url: "https://claude.ai/new" },
  ];
  const DEFAULT_VIEW_MODES = Object.freeze({
    operatingMode: "agent",
    animationMode: false,
    iconMode: true,
    rig: Object.freeze({
      rigType: "R15",
      bodyShape: "Official",
      preset: "Blocky Character",
      name: null,
      importedAt: null,
    }),
  });
  const NATIVE_ICON_PROVIDERS = new Set(["chatgpt", "gemini", "meta"]);
  const MAX_AI_UI_GENERATION_ATTEMPTS = 3;
  const MAX_AI_UI_BACKGROUND_FAILURES = 2;
  const NATIVE_UI_GENERATION_WAIT_MS = 210_000;
  const NATIVE_UI_IMAGE_SETTLE_MS = 1_500;
  const providerCanGenerateIcons = () => NATIVE_ICON_PROVIDERS.has(P.id);
  const aiGeneratedUiEnabled = () => A.modes.iconMode && providerCanGenerateIcons();
  function normalizedViewModes(value = {}) {
    const rig = value.rig && typeof value.rig === "object" ? value.rig : {};
    return {
      operatingMode: value.operatingMode === "plan" ? "plan" : "agent",
      animationMode: value.animationMode === true,
      iconMode: value.iconMode !== false,
      rig: {
        rigType: "R15",
        bodyShape: "Official",
        preset: "Blocky Character",
        name: rig.name || null,
        importedAt: rig.importedAt || null,
      },
    };
  }
  let modeUiRefresh = () => {};

  const A = {
    running: false,
    stop: false,
    // stopping: the user clicked Stop and we are winding the loop down. Set the
    // instant the button is clicked so the bar can show immediate "Stopping…"
    // feedback and keep the button steady (no flicker) until the loop's finally
    // clears it - the live generation signal toggles off/on as the loop drains,
    // which otherwise made the Stop button vanish then reappear.
    stopping: false,
    // recoveryStopping is the watchdog's non-destructive equivalent of the
    // user's red ViewCoder Stop button. It releases the provider and our own
    // composer cover/lock, but deliberately keeps the agent loop alive so the
    // existing continuation note can be submitted immediately afterwards.
    recoveryStopping: false,
    recoveryStopRequested: false,
    // userStopped: the user deliberately halted generation - via our "■ Stop"
    // button OR the site's native stop. While set, the auto-resume watchdog
    // must NOT relaunch or re-run a tool from the halted turn.
    userStopped: false,
    // lastGenAt: timestamp of the last moment the site was actively generating.
    // The auto-resume watchdog only acts on a tool call from a RECENT live
    // generation - never on a historical turn rendered by opening/scrolling.
    lastGenAt: 0,
    // Timestamped only by a real visible user send in this browser session.
    // This permits recovery after a long provider spinner without reviving a
    // historical command restored by reopening or scrolling a conversation.
    userIntentAt: 0,
    // Conversation identity paired with userIntentAt. A timestamp by itself is
    // unsafe: switching chats shortly after a real send could make the recovery
    // watchdog execute a command rendered in the destination chat. A null value
    // is allowed briefly while a provider changes its fresh-chat URL into a real
    // conversation id; it is pinned as soon as that id becomes available.
    userIntentKey: null,
    started: false,
    starting: false,
    // The conversation a bootstrap belongs to + a generation counter. If the user
    // navigates to another chat mid/post-bootstrap, syncSessionState bumps the
    // counter (invalidating the in-flight startSession) and clears `starting`, so
    // the new chat shows its own state instead of a stale "Starting…".
    startingKey: null,
    startGen: 0,
    // Cross-tab work lease. Only one provider tab may bootstrap or execute a
    // Studio task at a time; other chats keep their Start action disabled.
    workOwner: null,
    workBlocked: false,
    workLeaseKey: "",
    // Active Mode keeps the one task-owning provider tab alive while the user
    // works in another tab. It never focuses the provider or permits a second
    // chat to claim the same Studio session.
    activeMode: true,
    // The conversation a RUNNING loop is bound to. If the user opens a new, empty
    // chat via the site's own button, syncSessionState abandons the loop so the
    // fresh chat shows "Start", not a stale "Agent active".
    loopKey: null,
    // Identity of the assistant turn ALREADY present when the current session
    // started. A page reload can RESTORE an in-progress generation (e.g. an
    // execute_luau that was mid-stream in an A/B turn); that restored turn looks
    // like a fresh live tool finish to the auto-resume watchdog, which then ran it
    // into the NEW conversation the user had just opened (validated live, 2026-06).
    // autoResume never resumes the turn whose id matches this baseline.
    bootBaselineId: null,
    // The final startup reply is informational, never a user task.
    startupReplyId: null,
    startupReplyItem: null,
    injecting: false,
    // True from the moment ViewCoder sends an automatic follow-up until the AI
    // reply is classified. This closes the tool-result -> next-reply gap where
    // provider DOMs briefly look idle and restore the normal prompt bar.
    awaitingReply: false,
    toolRunning: false,
    toolStart: 0,
    toolName: "",
    toolItem: null,
    toolArg: "",
    toolRetrying: false,
    // Off-DOM visual state lets a running card survive virtual-list remounts.
    toolVisual: null,
    // Bounded recovery survives transient provider/DOM failures without turning
    // a permanently broken page into an infinite retry loop.
    loopCrashCount: 0,
    toolList: [],
    toolNames: new Set(),
    // Successful tool calls since the last command-list reminder. DeepSeek (and
    // others) can drift away from the exact command names over a long session,
    // so we re-inject the list every REMIND_TOOLS_EVERY calls (see agentLoop).
    toolCallsSinceReminder: 0,
    bridge: { connected: false, mcpAlive: false, tools: 0 },
    // Images from the most recent tool result, stashed by runTool for the
    // upcoming submitAndGetBase/typeAndSend call to attach as the LAST step
    // before sending (see the comment in runTool's r.images branch).
    pendingImages: null,
    // BARE names of tools observed to return images at least once this session.
    // For the KNOWN Roblox vision tool (screen_capture) toolCategory already
    // gives the "screen" chip optimistically at run time; a custom MCP tool's
    // name tells us nothing, so we can't predict it - but once we've SEEN it
    // return an image we can be optimistic on its NEXT call. Populated in the
    // agent loop's result branch when A.pendingImages lands.
    imageTools: new Set(),
    // Generated assistant images captured from a native provider card are
    // announced back to that provider once, so the same image cannot cause a
    // continuation loop after a DOM remount.
    generatedImageAnnouncements: new Set(),
    // Exactly one successfully captured native UI image belongs to each real
    // user submission. Automatic ViewCoder receipts are follow-ups inside that
    // same turn and must reuse this relay image instead of asking the provider
    // to render a second variant.
    nativeUiUserTurn: 0,
    nativeUiCapturedForUserTurn: null,
    lastNativeUserSendSignature: "",
    lastNativeUserSendAt: 0,
    userIntentText: "",
    nativeImageBaselineRoot: null,
    nativeImageBaselineKey: "",
    expectGeneratedUi: false,
    awaitingNativeUiGeneration: false,
    aiUiGenerationAttempts: 0,
    aiUiBackgroundFailures: 0,
    aiUiFallbackTriggered: false,
    nativeUiApprovalRequired: false,
    pendingNativeUiApprovalImage: null,
    finalAnswerSettled: false,
    modes: normalizedViewModes(DEFAULT_VIEW_MODES),
    modeRevision: 0,
    lastModeRevisionSent: 0,
    stopRetryGen: 0,
    // Provider pages occasionally leave their native loading/stop marker mounted
    // after a completed reply. Keep a shared stream-growth clock so every
    // provider can distinguish a live response from that stale DOM state.
    uiStreamLen: 0,
    uiStreamAt: 0,
    suppressProviderGen: false,
  };
  diagnosticAgentState = A;
  const modesReady = new Promise((resolve) => {
    try {
      chrome.storage.local.get("viewcoderModeState", (result) => {
        A.modes = normalizedViewModes(result?.viewcoderModeState);
        resolve(A.modes);
      });
    } catch {
      resolve(A.modes);
    }
  });
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.viewcoderModeState) return;
      A.modes = normalizedViewModes(changes.viewcoderModeState.newValue);
      A.modeRevision += 1;
      if (!A.modes.iconMode) {
        A.expectGeneratedUi = false;
        A.awaitingNativeUiGeneration = false;
        if (!A.aiUiFallbackTriggered) {
          A.nativeUiApprovalRequired = false;
          A.pendingNativeUiApprovalImage = null;
        }
      }
      if (
        A.modes.iconMode &&
        changes.viewcoderModeState.oldValue?.iconMode === false
      ) {
        A.aiUiGenerationAttempts = 0;
        A.aiUiBackgroundFailures = 0;
        A.aiUiFallbackTriggered = false;
        // Modes are live during an already-started agent. If the current user
        // request is UI work, turning AI Generated UI on must affect the next
        // action immediately rather than waiting for another user message.
        if (userExpectsNativeGeneratedUi(A.userIntentText)) {
          A.expectGeneratedUi = true;
          A.awaitingNativeUiGeneration = true;
        }
      }
      modeUiRefresh();
    });
  } catch {}

  function generationForUi(rawGenerating = P.isGenerating()) {
    const now = Date.now();
    let len = 0;
    try { len = P.streamLen ? P.streamLen() : 0; } catch {}
    if (len !== A.uiStreamLen) {
      A.uiStreamLen = len;
      A.uiStreamAt = now;
    } else if (!A.uiStreamAt) {
      A.uiStreamAt = now;
    }
    // waitForResponse has already stabilized and accepted a genuine final
    // answer. Provider pages sometimes leave a cosmetic stop/loading surface
    // mounted after that point; it must not restore ViewCoder's Working cover.
    if (A.finalAnswerSettled) return false;
    if (A.suppressProviderGen) {
      if (len > (A.stopStreamLen || 0) + 24) A.suppressProviderGen = false;
      else return false;
    }
    // Native image renderers have provider-specific lifecycles which can outlive
    // the normal text stop button. Treat that state as live generation only for
    // a turn in which AI Generated UI is actually expected.
    let nativeFinished = false;
    if (
      aiGeneratedUiEnabled() &&
      (A.expectGeneratedUi || A.awaitingNativeUiGeneration)
    ) {
      const { state, isNew } = currentNativeImageState();
      nativeFinished = isNew && state?.finished === true;
      if (!nativeFinished && nativeUiImageStillRendering()) rawGenerating = true;
    }
    // A visibly finished native image wins over a stale provider Stop/loading
    // marker. Without this override the Working cover and send lock survive the
    // completed image until the user manually presses Stop.
    if (nativeFinished) rawGenerating = false;
    if (!rawGenerating) return false;
    if (
      A.starting || A.injecting || A.awaitingReply || A.running ||
      A.toolRunning || A.stopping
    ) return true;
    // ChatGPT can leave a stale streaming surface attached to the startup
    // reply after it has already settled. Do not revive that completed turn.
    try {
      const startupItem = P.lastAssistant ? P.lastAssistant() : null;
      const startupId = P.lastAssistantId ? P.lastAssistantId() : null;
      if (
        (A.startupReplyItem && startupItem === A.startupReplyItem) ||
        (A.startupReplyId != null && startupId != null &&
          String(startupId) === String(A.startupReplyId))
      ) return false;
    } catch {}
    let reply = "";
    try { reply = String(P.readAssistant?.()?.reply || "").trim(); } catch {}
    const settledMs = Math.max(2500, Number(T.GEN_IDLE_MS || 1200) * 2);
    if (
      reply &&
      now - A.uiStreamAt >= settledMs &&
      !(ZSParse.hasOpenToolBlock && ZSParse.hasOpenToolBlock(reply))
    ) return false;
    return true;
  }

  try {
    chrome.storage.local.get("viewcoderActiveMode", (stored) => {
      A.activeMode = stored?.viewcoderActiveMode !== false;
    });
  } catch {}

  // Provider frameworks can keep writing for a short final-answer phase after
  // the command loop itself has settled. Keep one authoritative lock state
  // shared by bootstrap, the loop and the live generation monitor so a loop's
  // `finally` can never restore the prompt bar while the AI is still working.
  // Providers already re-assert a held lock from enforceComposer() after their
  // framework replaces the editor node, so this only runs when the desired
  // state actually changes.
  let inputLocked = false;
  function setInputLocked(on) {
    const next = on === true;
    if (next === inputLocked) return;
    try {
      P.setInputLock(next);
      inputLocked = next;
    } catch {
      // Leave the cached state unchanged so the next activity tick retries
      // after a provider framework has finished replacing its composer.
    }
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // ZeroScript keeps a half-rendered tool response from being classified while
  // the AI tab has no foreground layout. Scope that behavior to an in-flight
  // execute_luau block so ViewCoder's Active Mode and every other command keep
  // their existing background behavior and UI.
  async function parkHiddenLuau() {
    if (!document.hidden || A.stop) return 0;
    const parkedAt = Date.now();
    await new Promise((resolve) => {
      let stopTimer = 0;
      const done = () => {
        document.removeEventListener("visibilitychange", onVisibility);
        clearInterval(stopTimer);
        resolve();
      };
      const onVisibility = () => {
        if (!document.hidden) done();
      };
      document.addEventListener("visibilitychange", onVisibility);
      stopTimer = setInterval(() => {
        if (A.stop || !document.hidden) done();
      }, 1000);
    });
    const parked = Date.now() - parkedAt;
    diag("luau.park.resumed", { parkedMs: parked });
    // Let ChatGPT repaint its streamed code subtree before the parser reads it.
    if (!A.stop) await sleep(400);
    return parked;
  }

  // Submit `text` as a new turn, masking the input while we type. Returns the
  // assistant-item count BEFORE the reply (waitForResponse waits beyond it).
  // Snapshot the identity of the assistant turn present BEFORE we send. Paired
  // with waitForResponse, this lets "a new reply turn exists" be tested by node
  // identity rather than a raw count - the latter is unreliable on providers that
  // virtualize the message list, where the count stays flat as a new
  // turn appears and old ones detach. Captured at every send site (tool feedback,
  // user message, bootstrap). Providers without lastAssistantId fall back to count.
  function captureSendToken() {
    const previous = P.readAssistant ? P.readAssistant() : null;
    A.sendItem = previous ? previous.item : P.lastAssistant();
    A.sendToken = P.lastAssistantId ? P.lastAssistantId() : undefined;
    A.sendReplySnapshot = String((previous && previous.reply) || "")
      .replace(/\s+/g, " ").trim();
    A.sendThinkingSnapshot = String((previous && previous.thinking) || "")
      .replace(/\s+/g, " ").trim();
  }

  function currentNativeImageState(scopeItem = null) {
    let state = null;
    try {
      state = P.nativeImageGenerationState?.(
        scopeItem || P.lastAssistant?.(),
      ) || null;
    } catch {}
    const root = state?.root || null;
    const key = nativeUiImageRootKey(root);
    const isNew = !!root && (
      A.nativeImageBaselineKey
        ? key !== A.nativeImageBaselineKey
        : root !== A.nativeImageBaselineRoot
    );
    return { state, root, isNew };
  }

  // Automatic ViewCoder follow-ups share the provider's real composer. Native
  // image renderers can temporarily replace Send with Stop for minutes, so a
  // short best-effort wait is unsafe: clicking that control interrupts the
  // image and leaves the agent paused. Acquire a genuinely idle send slot first.
  // A completed, new native image is authoritative even when the provider has
  // left a stale generic generating flag mounted beside it.
  async function waitForAutomaticSendSlot(options = {}) {
    const settledToolResult =
      options.toolResult === true && options.requireProviderIdle !== true;
    const nativeExpected =
      aiGeneratedUiEnabled() &&
      (A.expectGeneratedUi || A.awaitingNativeUiGeneration);
    // Startup on a brand-new chat has no assistant turn to protect. ChatGPT's
    // empty-page shell can expose a generic loading spinner that isGenerating()
    // mistakes for a live reply; applying the follow-up lock here prevents the
    // unchanged ViewCoder startup prompt from ever being sent. Only bypass when
    // the conversation is genuinely empty and no native image turn exists.
    let startupHasNoTurn = false;
    if (A.starting && !nativeExpected) {
      try {
        startupHasNoTurn =
          P.chatIsEmpty?.() === true &&
          !P.readAssistant?.()?.item &&
          !currentNativeImageState().state?.active;
      } catch {}
    }
    if (startupHasNoTurn) return true;
    const timeout = nativeExpected ? NATIVE_UI_GENERATION_WAIT_MS : 45_000;
    const deadline = Date.now() + timeout;
    let quietSince = 0;
    while (Date.now() < deadline) {
      if (A.stop) return false;
      const { state, isNew } = currentNativeImageState();
      // Keep honoring the just-completed image after attachFinishedGeneratedImage
      // has cleared the expectation flags. Tool-result feedback is sent in that
      // exact phase, and the provider's generic busy marker can still be stale.
      const nativeFinished = isNew && state?.finished === true;
      const nativeActive = isNew && state?.active === true;
      let providerBusy = false;
      try { providerBusy = P.isBusyNow?.() === true || P.isGenerating?.() === true; } catch {}
      // A tool result is submitted only after waitForResponse has declared the
      // command turn complete. Some providers leave their cosmetic Stop/loading
      // node mounted after that point. Do not let that stale node strand an
      // already-finished Studio/Blender receipt; native image generation remains
      // authoritative and is never bypassed here.
      const busy = !nativeFinished && (nativeActive || (!settledToolResult && providerBusy));
      if (!busy) {
        if (!quietSince) quietSince = Date.now();
        if (Date.now() - quietSince >= 650) return true;
      } else {
        quietSince = 0;
      }
      await sleep(180);
    }
    const error = new Error(
      `${P.displayName} did not release its composer before ViewCoder's automatic follow-up.`,
    );
    try { error.viewCoderSendFailure = true; } catch {}
    throw error;
  }

  // Preserve a user's unsent draft when ViewCoder briefly needs the shared
  // composer for a tool result. This provider-neutral writer covers textarea,
  // input, Lexical, ProseMirror, Quill and ordinary contenteditable editors.
  // It also clears a leaked ViewCoder message if the provider rejects the send.
  function writeComposerDraft(value) {
    const editor = P.getEditor?.();
    if (!editor) return false;
    const text = String(value || "");
    try {
      if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
        const proto = editor instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(editor, text);
        else editor.value = text;
        editor.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: text,
        }));
        editor.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      editor.focus();
      const selection = window.getSelection?.();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection?.removeAllRanges();
      selection?.addRange(range);
      let inserted = false;
      try { inserted = document.execCommand("insertText", false, text); } catch {}
      if (!inserted) editor.textContent = text;
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: text ? "insertText" : "deleteContentBackward",
        data: text || null,
      }));
      return true;
    } catch {
      return false;
    }
  }

  async function restoreComposerDraft(value) {
    const expected = String(value || "");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (writeComposerDraft(expected)) {
        await sleep(60);
        if (String(P.editorText?.() || "") === expected) return true;
      }
      await sleep(90);
    }
    return false;
  }

  async function submitAndGetBase(text, images, options = {}) {
    const retryableToolResult = options.toolResult === true;
    diag("send", { text: String(text).slice(0, 60), busy: P.isBusyNow() });
    const hasAttachment = !!(images && images.length);
    let messageSent = false;
    let originalDraft = "";
    let draftCaptured = false;
    A.injecting = true;
    ui.inputCover(true, "", { allowGrowth: hasAttachment });
    try {
      // Quick 2-point settle: sample the previous response's stream length before
      // and after a 200ms yield. A one-shot React batch flush (the common case)
      // shows no second growth and costs only 200ms. A genuinely still-generating
      // stream shows growth → fall back to the full idle wait.
      const _settleItem = P.lastAssistant();
      const _settleLen0 = _settleItem ? P.streamLen(_settleItem) : 0;
      await sleep(200);
      if (_settleItem && _settleItem === P.lastAssistant() &&
          P.streamLen(_settleItem) > _settleLen0) {
        await waitFor(() => !P.isGenerating(), 4000);
      }
      // The old four-second settle fallback could expire while ChatGPT/Gemini
      // was still rendering an image, after which typeAndSend clicked the native
      // Stop control. Never touch the composer until its provider has released it.
      await waitForAutomaticSendSlot({
        toolResult: retryableToolResult,
        requireProviderIdle: options.requireProviderIdle === true,
      });
      originalDraft = String(P.editorText?.() || "");
      draftCaptured = true;
      // Snapshot only after the previous turn has settled. Capturing before the
      // settle wait lets the old turn change underneath us; its final
      // "stopped thinking" state can then look like the reply to the message we
      // are about to send and falsely start the recovery loop.
      captureSendToken();
      const base = P.assistantCount();
      const preUser = P.userCount();
      // Arm the optimistic pre-hide for the result turn we're about to inject:
      // the very next NEW user turn is ours, so preHideWholeItems can mask it on
      // creation instead of waiting for its "Output of '…'" caption to render
      // (which lands a tick after the node - especially with an attached image -
      // and would otherwise flash the raw output for the 200/700ms until a sweep
      // nudge catches it). See preHideWholeItems.
      A.injectPreUser = preUser;
      A.injectHideUntil = Date.now() + 2500;
      // "Landed" = a new turn appeared in the DOM. In long chats, list
      // virtualisation can keep counts flat even when our message landed - the
      // textarea-cleared signal below is the primary fast gate.
      const landed = () => P.userCount() > preUser || P.assistantCount() > base;
      // Without Active Mode, wait for the provider tab to become visible before
      // sending. Active Mode deliberately permits this one guarded provider send
      // in the background; typeAndSend still owns acceptance confirmation and is
      // called exactly once, so a throttled DOM cannot duplicate the turn.
      if (document.hidden && !A.activeMode) {
        diag("send.waitVisible");
        const visibleWaitMs = retryableToolResult ? TOOL_RECEIPT_RETRY_MS : 600000;
        if (!(await waitFor(() => !document.hidden || A.stop, visibleWaitMs)) || A.stop) {
          throw new Error("Send cancelled while the AI tab was hidden.");
        }
      } else if (document.hidden) {
        diag("send.activeModeBackground");
      }
      await jitterBeforeSend();
      diag("submit.typeAndSend", { hasImages: hasAttachment });
      let providerAccepted = false;
      let providerDispatched = false;
      try {
        const sendOutcome = await P.typeAndSend(text, images, {
          maxWaitMs: retryableToolResult ? TOOL_RECEIPT_RETRY_MS : undefined,
        });
        // Providers return an acknowledgement object so diagnostics can
        // distinguish "nothing was attempted" from an ignored click/Enter. Only
        // accepted=true, a cleared composer, or a newly landed turn counts as a
        // send. Merely invoking the native Send control is not delivery: ChatGPT
        // can ignore that click in a long chat and leave the hidden result in the
        // composer. Counting the invocation as success re-read and re-executed
        // the same assistant command (notably inspect_instance).
        providerAccepted = sendOutcome === true || sendOutcome?.accepted === true;
        providerDispatched = providerAccepted || sendOutcome?.dispatched === true;
      } catch (error) {
        // A provider-side attachment/composer failure means no model turn is in
        // flight. Mark it explicitly so the loop's final cleanup does not let a
        // just-settled tool card revive the Working cover for another idle
        // window and make the failure look like an infinite generation.
        try { error.viewCoderSendFailure = true; } catch {}
        throw error;
      }
      // Re-arm the pre-hide window NOW that typeAndSend has returned (the send
      // was just accepted, so our result turn is about to render). The initial
      // arm above can expire during an image upload.
      A.injectHideUntil = Date.now() + 2500;
      // Keep a generic confirmation as a compatibility belt for provider DOM
      // updates that land a fraction after the provider's own acknowledgement.
      await waitFor(() => {
        if (P.editorText().trim() === "") messageSent = true;
        return messageSent || landed();
      }, providerAccepted === true ? 1200 : 4500);
      messageSent = messageSent || providerAccepted || landed();
      if (messageSent) diag("send.cleared", { providerAccepted, providerDispatched });
      if (!messageSent && !A.stop) {
        diag("send.failed", { providerAccepted, providerDispatched });
        const message =
          `${P.displayName} did not accept ViewCoder's message. ` +
          `The agent stopped before it could wait for a reply that will never arrive.`;
        if (!retryableToolResult) ui.banner("warn", "Message could not be sent", message);
        throw new Error(message);
      }
      return base;
    } finally {
      // Provider rejection can leave ViewCoder's hidden system note sitting in
      // the real composer. Restore the user's exact prior draft (or clear the
      // leaked note when the composer was originally empty) before releasing UI.
      if (draftCaptured) {
        const now = String(P.editorText?.() || "");
        const injected = String(text || "");
        if (originalDraft || (!messageSent && now.trim() === injected.trim())) {
          await restoreComposerDraft(originalDraft);
        }
      }
      // During Starting Up / the agent loop, the bootstrap or loop owns the cover
      // for the whole phase, so don't lift it here between an injection and the
      // next waitForResponse - it stays up until the loop / bootstrap ends.
      if (!A.starting && !A.running) ui.inputCover(false);
      else ui.inputCover(true, "", { allowGrowth: false });
      setTimeout(() => (A.injecting = false), 400);
      // Camouflage the turn we just injected without waiting on the rAF observer
      // (paused in a background tab). A couple of nudges cover the render.
      setTimeout(scheduleSweep, 200);
      setTimeout(scheduleSweep, 700);
    }
  }

  // A returned tool receipt and delivery of that receipt to the model are two
  // separate acknowledgements. Provider DOM churn can complete the activity
  // card yet reject the hidden follow-up, which previously left the AI waiting
  // forever. Retry only delivery of the already-completed result; the
  // Studio/Blender mutation itself is never repeated. An invoked Send control is
  // not enough: the provider must acknowledge the user turn before this returns.
  // Each retry begins no sooner than 43 seconds after the prior attempt began.
  async function submitToolResultWithRetries(text, images, options = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= TOOL_RECEIPT_MAX_RETRIES && !A.stop; attempt += 1) {
      const attemptStartedAt = Date.now();
      try {
        return await submitAndGetBase(text, images, {
          toolResult: true,
          requireProviderIdle: options.requireProviderIdle === true,
        });
      } catch (error) {
        lastError = error;
        if (attempt >= TOOL_RECEIPT_MAX_RETRIES || A.stop) break;
        const retryNumber = attempt + 1;
        diag("tool.resultDeliveryRetry", {
          attempt: retryNumber,
          maxRetries: TOOL_RECEIPT_MAX_RETRIES,
        });
        ui.toast(`Retrying ViewCoder result delivery (${retryNumber}/${TOOL_RECEIPT_MAX_RETRIES})...`);
        const retryAt = attemptStartedAt + TOOL_RECEIPT_RETRY_MS;
        while (!A.stop && Date.now() < retryAt) {
          await sleep(Math.min(180, retryAt - Date.now()));
        }
      }
    }
    if (lastError) {
      try { lastError.viewCoderSendFailure = true; } catch {}
      throw lastError;
    }
    const error = new Error("ViewCoder stopped before the completed tool result could be delivered.");
    try { error.viewCoderSendFailure = true; } catch {}
    throw error;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RESPONSE WATCHER  (generating-flag driven - robust to DOM churn)
  // ════════════════════════════════════════════════════════════════════════
  function renderedCommandSourceCandidates(item) {
    if (!item || typeof item.querySelectorAll !== "function") return [];
    const candidates = [];
    let blocks = [];
    try { blocks = [...item.querySelectorAll("pre")]; } catch {}
    for (const block of blocks) {
      // Never execute a command merely quoted in a provider's private
      // reasoning panel. Providers which expose that selector already use it
      // elsewhere for the same safety boundary.
      try {
        if (P.thinkingSel && block.closest(P.thinkingSel)) continue;
      } catch {}
      const code = block.querySelector && block.querySelector("code");
      for (const value of [
        code && code.textContent,
        code && code.innerText,
        block.textContent,
        block.innerText,
      ]) {
        const text = String(value || "").trim();
        if (text && !candidates.includes(text)) candidates.push(text);
      }
    }
    return candidates;
  }

  function providerCommandCalls(item) {
    if (!item) return null;
    let candidates = [];
    if (typeof P.commandSourceCandidates === "function") {
      try { candidates = P.commandSourceCandidates(item) || []; } catch {}
    }
    // Every supported AI now gets a provider-independent rendered-code
    // fallback. Site code-block toolbars can prepend labels such as
    // "json / Copy / Download" to the surrounding markdown text while the
    // actual <pre> remains clean (DeepSeek, 2026-08). Reading the rendered code
    // directly keeps that UI chrome out of the command and also protects the
    // other provider adapters from the same class of markup change.
    for (const candidate of renderedCommandSourceCandidates(item)) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
    for (let index = 0; index < candidates.length; index++) {
      const text = String(candidates[index] || "");
      const calls = ZSParse.parseToolCalls(text);
      if (calls.length) return { calls, text, index };
    }
    return null;
  }

  async function waitForResponseCore(base, options = {}) {
    const t0 = Date.now();
    // INACTIVITY timeout (not total-elapsed): the loop only gives up after this
    // long with NO streaming AND no text change. lastActiveAt is refreshed every
    // tick the model is generating or the reply text grows, so an arbitrarily
    // LONG but still-active response never trips it (the old total-elapsed cap
    // wrongly fired "No response" while the model was still writing past 300s).
    const TIMEOUT = Number(options.timeout) > 0
      ? Number(options.timeout)
      : T.RESPONSE_TIMEOUT_MS;
    const PRE_START_TIMEOUT = Number(options.preStartTimeoutMs) > 0
      ? Number(options.preStartTimeoutMs)
      : TIMEOUT;
    const PROGRESS_TIMEOUT = Number(options.progressTimeoutMs) > 0
      ? Number(options.progressTimeoutMs)
      : TIMEOUT;
    const progressWatchdog = options.progressWatchdog || null;
    let lastActiveAt = Date.now();
    const STABLE_MS = Number(options.stableMs) > 0
      ? Number(options.stableMs)
      : T.STABLE_MS; // generating-flag stuck ON but text frozen → done
    let started = false, doneSince = 0, lastLimitScan = 0;
    let stuckGenerationLogged = false;
    let lastText = null, lastChangeAt = Date.now(), genFalseSince = 0;
    // ── DIAG: finalisation-latency instrumentation (multi_edit "slow" probe) ──
    // genOffFirstAt: the FIRST moment gen went false after streaming began (does
    // NOT reset on flicker, unlike genFalseSince). genFlickers: how many times gen
    // flipped back true after having been false - a high count means post-stop DOM
    // churn (or a wedged stop button) is what keeps the watcher alive. waitedBlock/
    // waitedFlicker: iterations spent waiting because effectiveBlock held vs because
    // gen was (re)true. These pinpoint which gate causes any tail latency.
    let genOffFirstAt = 0, genFlickers = 0, prevGen = null;
    let waitedBlock = 0, waitedFlicker = 0;
    const finalizeDiag = (kind) => {
      const now = Date.now();
      diag("stopGoneToResp", {
        kind,
        stopGoneToRespMs: genOffFirstAt ? now - genOffFirstAt : null,
        genStableForMs: genFalseSince ? now - genFalseSince : null,
        lastChangeAgoMs: now - lastChangeAt,
        genFlickers, waitedBlock, waitedFlicker,
        totalMs: now - t0,
      });
    };
    let preStartSilent = 0; // nothing produced AND not generating
    let curItem = null, sawContent = false, warmSince = 0; // per-turn "warming up"
    // Last NON-EMPTY reply read for the CURRENT turn. Sites re-render a turn's
    // subtree (React/Monaco churn) and a read can come back "" for a frame at
    // the exact moment the watcher finalizes - the turn then ended as
    // kind:"empty" even though a (possibly cut-off) command was sitting there a
    // tick earlier, leaving a DEAD turn: no parse_error feedback, and the
    // autoResume dedupe (zResume) blocks any later retry (validated live on a
    // Qwen post-stop regenerate, 2026-07). Classify on this fallback instead of
    // declaring empty. Reset whenever the turn NODE changes so a new turn can
    // never inherit the previous turn's text.
    let lastGoodReply = "";
    let reasonSince = 0; // reasoning written but no answer yet (loading phase)
    let noTurnSince = 0; // finalize attempted before this send's reply turn exists
    let unsettledSince = 0; // command-shaped reply whose read is not yet stable
    let luaMarkerMismatchSince = 0; // closing marker landed before CodeMirror restored the opener
    const WARMUP_MS = T.WARMUP_MS;
    const REASON_NOREPLY_MS = T.REASON_NOREPLY_MS;
    const NO_TURN_GRACE_MS = 30000;
    // Upper bound on holding off a parse verdict while a provider reports its
    // read is unsettled (Qwen A/B dual turn still landing). A genuinely stuck
    // read still resolves after this and is parsed as-is.
    const UNSETTLED_GRACE_MS = 8000;
    // Once the generating flag has been OFF this long, the model has clearly
    // stopped streaming - so an "open tool block" reading is a DOM-churn/parse
    // artifact, not live output, and must not keep the watcher waiting. Provider
    // -neutral: while a model is genuinely streaming, gen stays true and this is
    // never reached.
    const GEN_STOP_GRACE_MS = 2500;

    while (Date.now() - lastActiveAt < TIMEOUT) {
      if (A.stop) return { kind: "stopped" };
      const d = P.readAssistant();
      let nativeImageState = null;
      try { nativeImageState = P.nativeImageGenerationState?.(d.item) || null; } catch {}
      const nativeImageExpected =
        aiGeneratedUiEnabled() &&
        (A.expectGeneratedUi || A.awaitingNativeUiGeneration);
      const nativeImageRoot = nativeImageState?.root || null;
      const nativeImageKey = nativeUiImageRootKey(nativeImageRoot);
      const nativeImageIsNew = !!nativeImageRoot && (
        A.nativeImageBaselineKey
          ? nativeImageKey !== A.nativeImageBaselineKey
          : nativeImageRoot !== A.nativeImageBaselineRoot
      );
      const nativeImageFinished = nativeImageExpected && nativeImageIsNew &&
        nativeImageState?.finished === true;
      const nativeImageActive = nativeImageExpected && nativeImageIsNew && (
        nativeImageState?.active === true || nativeUiImageStillRendering(d.item)
      );
      // The native image's finished state is stronger than ChatGPT/Gemini's
      // generic busy flag, which can remain mounted after the PNG is complete.
      const gen = nativeImageFinished ? false : (P.isGenerating() || nativeImageActive);
      // For an ordinary response, a live generating flag is activity. For the
      // special post-tool-result handoff it is only a hint: ChatGPT can mount an
      // execute_luau card and leave that flag/card frozen forever. That handoff
      // must produce actual text/reasoning progress inside 43 seconds.
      if (gen && !progressWatchdog) lastActiveAt = Date.now();
      if (
        progressWatchdog?.expired &&
        !nativeImageActive &&
        !nativeImageFinished
      ) {
        const kind = started ? "stalled" : "no_start";
        diag("tool.resultReplyWatchdog", {
          kind,
          waitedMs: started ? Date.now() - lastChangeAt : Date.now() - t0,
          progressTimeoutMs: PROGRESS_TIMEOUT,
        });
        return { kind };
      }
      const replyHasOpenLuau =
        ZSParse.LUA_START_RE.test(d.reply || "") &&
        ZSParse.hasOpenToolBlock(d.reply || "");
      if (document.hidden && replyHasOpenLuau && !A.stop) {
        const parked = await parkHiddenLuau();
        if (parked) {
          // Slide every response deadline forward by the hidden duration. This is
          // ZeroScript's important behavior: a long Lua stream resumes from the
          // same state instead of becoming a false "malformed command" verdict.
          lastActiveAt += parked;
          lastChangeAt += parked;
          if (doneSince) doneSince += parked;
          if (genFalseSince) genFalseSince += parked;
          if (preStartSilent) preStartSilent += parked;
          if (warmSince) warmSince += parked;
          if (reasonSince) reasonSince += parked;
          if (noTurnSince) noTurnSince += parked;
          if (unsettledSince) unsettledSince += parked;
          if (luaMarkerMismatchSince) luaMarkerMismatchSince += parked;
          if (genOffFirstAt) genOffFirstAt += parked;
        }
        continue;
      }
      // Sites virtualize their lists, so the absolute assistant count can DROP
      // even as a new reply is added. A count increase still proves a new turn
      // appeared; the generating flag is the reliable "reply has begun" signal.
      // A new reply turn exists. Prefer node IDENTITY (virtualization-proof) when
      // the provider exposes it: the last assistant turn's id differs from the one
      // captured at send time. Fall back to the count test otherwise. Without this,
      // a provider's list virtualisation can keep assistantCount() <= base for a
      // fresh reply, so the reliableCounts gate below waits out the full NO_TURN_GRACE
      // (~30s) before finalising a multi_edit - the "input box stuck until I scroll
      // up" symptom (scrolling re-attached old turns and bumped the count).
      const curTok = P.lastAssistantId ? P.lastAssistantId() : undefined;
      // A NULL token means the provider could not read an identity for the
      // CURRENT last turn (not that the provider lacks ids - that's undefined).
      // Treating null as "no new reply" wedged the watcher on Qwen: a
      // REGENERATED turn is rebuilt WITHOUT the id attribute the normal turns
      // carry, so curTok stayed null, `started` never latched, and the loop
      // sat in the pre-start branch for the full 60s before ending "empty" -
      // the regenerated command (complete in the net tap) was never run and
      // zResume then blocked any retry (validated live via empty.why, 2026-07).
      // Fall back to the count test instead, exactly as for a provider with no
      // lastAssistantId at all.
      const replyNow = String(d.reply || "").replace(/\s+/g, " ").trim();
      const thinkingNow = String(d.thinking || "").replace(/\s+/g, " ").trim();
      const contentChanged =
        replyNow !== String(A.sendReplySnapshot || "") ||
        thinkingNow !== String(A.sendThinkingSnapshot || "");
      const haveStableIds =
        curTok !== undefined && curTok !== null &&
        A.sendToken !== undefined && A.sendToken !== null;
      const countAdvanced = P.assistantCount() > base;
      const identityAdvanced = haveStableIds && curTok !== A.sendToken;
      // Stable ids are preferred but not exclusive: some provider builds reuse
      // or temporarily omit an id while mounting the new visible response.
      // ChatGPT native image generation mounts as a conversation-turn SECTION
      // with no data-message-author-role, so the ordinary assistant identity and
      // count do not advance. Its provider-specific root is nevertheless a real
      // new reply turn and must start/finalize this watcher.
      const nativeImageReply = !!(
        nativeImageExpected &&
        nativeImageIsNew &&
        nativeImageRoot?.isConnected &&
        nativeImageRoot !== A.sendItem &&
        (nativeImageState.active || nativeImageState.finished)
      );
      const newReply = identityAdvanced || countAdvanced || contentChanged || nativeImageReply;

      // Track whether the CURRENT turn has produced anything. Reset when the
      // turn node changes (the PREVIOUS turn's content never counts).
      if (d.item !== curItem) { curItem = d.item; sawContent = false; warmSince = 0; lastGoodReply = ""; }
      if ((d.reply && d.reply.length) || (d.thinking && d.thinking.length)) sawContent = true;
      if (d.reply && d.reply.length) lastGoodReply = d.reply;

      if (!started) {
        // CRITICAL: a bare count increase is NOT enough - the empty turn
        // CONTAINER can appear seconds before the first token. Require actual
        // CONTENT (or the generating flag).
        const hasText = !!((d.reply && d.reply.length) || (d.thinking && d.thinking.length));
        // Never let a stale provider generation flag start this watcher on the
        // preceding assistant turn. A fresh turn must be proven by its stable
        // identity/count or by content changing from the pre-send snapshot.
        if (newReply && (gen || hasText)) {
          started = true;
          progressWatchdog?.arm(Date.now() + PROGRESS_TIMEOUT);
        }
        else {
          // The site can be slow to even CREATE the reply turn. Keep waiting -
          // only give up after a long fully-silent window.
          if (!preStartSilent) preStartSilent = Date.now();
          // diag: WHICH empty-branch fired matters - a dead post-regenerate turn
          // on Qwen kept ending "empty" with a complete command in the net tap,
          // and without the branch name the cause was unfindable from the log.
          if (Date.now() - preStartSilent > PRE_START_TIMEOUT) {
            const kind = PRE_START_TIMEOUT < TIMEOUT ? "no_start" : "empty";
            diag("empty.why", {
              branch: "preStart",
              kind,
              waitedMs: Date.now() - preStartSilent,
              rep: (d.reply || "").length,
            });
            return { kind };
          }
          await sleep(200);
          continue;
        }
      }

      // Track text stability (independent of the generating flag). Compare the
      // NORMALISED reply (collapsed whitespace) so cosmetic re-renders of a large
      // reply - React re-creating the hidden tool <pre>, syntax-highlight passes,
      // copy-bar text churn - don't count as real "changes" and keep resetting
      // lastChangeAt. A churn-poisoned lastChangeAt was stalling finalisation of
      // big multi_edit blocks ~30s (stuckDone never fired); this can only ever
      // reduce false changes, so short replies / other providers are unaffected.
      // Reasoning/tool progress is activity too. Tracking reply text alone made
      // Gemini look frozen while its visible thinking/tool surface was changing.
      const progressNorm = ((d.thinking || "") + "\n" + (d.reply || "")).replace(/\s+/g, " ").trim();
      if (progressNorm !== lastText) {
        lastText = progressNorm;
        lastChangeAt = Date.now();
        lastActiveAt = Date.now();
        progressWatchdog?.arm(Date.now() + PROGRESS_TIMEOUT);
      }
      // How long the generating flag has been OFF. A mid-stream flicker resets
      // this the instant growth resumes and gen flips back on.
      if (gen) genFalseSince = 0; else if (!genFalseSince) genFalseSince = Date.now();
      // DIAG: first gen-off, and count flickers back to true after a gen-off.
      if (started && !gen && !genOffFirstAt) genOffFirstAt = Date.now();
      if (prevGen === false && gen && genOffFirstAt) genFlickers++;
      prevGen = gen;

      if (Date.now() - lastLimitScan > 1000) {
        lastLimitScan = Date.now();
        const ctx = P.scanError();
        if (ctx) return { kind: "context_limit", detail: ctx };
      }

      // Keep waiting while a tool command is still being streamed (opener written
      // but no end marker yet) so we never parse/finalize half a command.
      const blockActive = ZSParse.hasOpenToolBlock(d.reply) && Date.now() - lastChangeAt < 6000;
      // ...but once generation has clearly stopped (stop indicator gone past the
      // grace window), stop honoring an "open block" - it is DOM churn, not live
      // streaming. Lets a finished big block finalise in seconds instead of
      // waiting out ~30s of re-render churn. Safe: real streaming keeps gen true.
      const genStopped = !gen && genFalseSince && Date.now() - genFalseSince > GEN_STOP_GRACE_MS;
      const effectiveBlock = blockActive && !genStopped;

      // Fallback: generating flag stuck ON (e.g. a wedged stop button - seen
      // live on Gemini after a mid-write halt) but the text has been frozen for
      // a while → stop waiting and finalize. This must BYPASS the gen branch
      // below entirely: falling through while gen stays true used to reset
      // doneSince every iteration, so the watcher never finalized at all.
      // ...but NEVER treat a still-OPEN command block as "done" while the site is
      // genuinely still generating. A model writing a big command (a 3799-char
      // execute_luau seen live on GLM) can pause >STABLE_MS between tokens - that
      // is a mid-write gap, NOT a wedged stop button on a COMPLETE reply. Firing
      // here parsed the half-written JSON and stamped a false "bad JSON" error
      // while GLM was still typing. RESPONSE_TIMEOUT still bounds a truly stuck one.
      const providerStillWorking = P.id === "gemini" && gen;
      const stuckDone = started && d.reply && !providerStillWorking && Date.now() - lastChangeAt > STABLE_MS &&
        !(gen && ZSParse.hasOpenToolBlock(d.reply));
      if ((gen || effectiveBlock) && !stuckDone) {
        // DIAG: attribute this wait. genOffFirstAt set ⇒ we are PAST first stop,
        // so any wait here is tail latency: either gen flickered back on, or an
        // (effective) open-block reading is holding us.
        if (genOffFirstAt) { if (gen) waitedFlicker++; else if (effectiveBlock) waitedBlock++; }
        doneSince = 0;
        await sleep(160);
        continue;
      }
      if (stuckDone && gen && !stuckGenerationLogged) {
        stuckGenerationLogged = true;
        log("generating flag stuck - falling back to text stability");
      }

      // On providers whose turn counts are RELIABLE (semantic elements, no
      // list virtualisation - Gemini), never finalize before the reply turn
      // for THIS send exists. The generating flag can flicker off in the gap
      // between the send and the new <model-response> node spawning, and the
      // watcher used to finalize on the PREVIOUS turn's stable text - a
      // premature loop.end rescued only by autoResume 30-45s later (diag
      // showed `response kind:text` ~2.4s after loop.start with rp unchanged).
      // Bounded so a genuinely dead send still ends the turn.
      if (P.reliableCounts && !newReply) {
        if (!noTurnSince) noTurnSince = Date.now();
        // [TRACE] This is the 30s NO_TURN_GRACE gate. If a Qwen tool turn sits here
        // ~30s EVERY turn, newReply is wrongly stuck false: log the identity values
        // that decide it so we can see whether curTok is null (id missing on the new
        // turn -> count fallback) or equal to sendToken (last turn not advancing).
        const _waited = Date.now() - noTurnSince;
        if (_waited > 800 && (!A._noTurnLoggedAt || Date.now() - A._noTurnLoggedAt > 3000)) {
          A._noTurnLoggedAt = Date.now();
          diag("noTurnGrace.wait", {
            waitedMs: _waited,
            curTok: (P.lastAssistantId ? P.lastAssistantId() : undefined),
            sendToken: A.sendToken,
            assistantCount: P.assistantCount ? P.assistantCount() : undefined,
            base, gen, started, replyLen: (d.reply || "").length });
        }
        if (Date.now() - noTurnSince < NO_TURN_GRACE_MS) { await sleep(200); continue; }
      } else {
        noTurnSince = 0;
        A._noTurnLoggedAt = 0;
      }

      if (!doneSince) doneSince = Date.now();
      if (Date.now() - doneSince < 500) {  // 500ms settle – DOM is stable
        await sleep(120);
        continue;
      }

      // A turn that has produced NOTHING yet is still warming up - never
      // finalize it as empty/truncated/text (a premature retry interrupts it).
      if (!sawContent) {
        if (!warmSince) warmSince = Date.now();
        if (Date.now() - warmSince < WARMUP_MS) { await sleep(200); continue; }
        diag("empty.why", { branch: "warmup", rep: (d.reply||"").length, lastGood: lastGoodReply.length });
        return { kind: "empty" };
      }

      // Still REASONING / loading: thinking written but no answer yet. Don't
      // finalize - wait for the reply, bounded. A manually-stopped turn is
      // exempt so a real stop still ends.
      if (d.thinking && d.thinking.length && !(d.reply && d.reply.length) && !P.turnHalted(d.item)) {
        if (!reasonSince) reasonSince = Date.now();
        if (Date.now() - reasonSince < REASON_NOREPLY_MS) { await sleep(200); continue; }
      } else {
        reasonSince = 0;
      }

      // Blank-read guard: if THIS read came back empty but the same turn had
      // real text a tick ago, classify that text - see lastGoodReply above.
      let r = d.reply;
      if (!r && lastGoodReply) { r = lastGoodReply; diag("reply.blankReadFallback", { len: r.length }); }
      // "Conversation too long" / "server busy" notices are always SHORT system
      // messages; gating on a short reply stops the model's own long output
      // (which may quote those phrases) from tripping them.
      if (r.length < 400 && P.isTooLongMsg(r)) return { kind: "too_long" };
      // Hold off on any "unparseable command" verdict while the provider reports
      // this turn's text is not yet a settled read. Qwen's A/B "dual" turn is the
      // case: its network tap flips `done` the instant the SSE ends, but the
      // candidate-1 DOM we parse can still be mid-render, so a real command looks
      // half-written for a beat. Firing parse_error there sends an ERROR
      // mid-generation and nags a model that did nothing wrong. Only guard when
      // the reply already LOOKS like a command (so a plain-text answer is never
      // delayed) and bound it with UNSETTLED_GRACE_MS. No-op on providers that
      // don't implement replyUnsettled (DeepSeek/Gemini/GLM/Kimi/Arena).
      const cmdShaped = P.replyUnsettled && (
        ZSParse.hasToolSignature(r) ||
        (ZSParse.LUA_END_RE.test(r) && !ZSParse.LUA_START_RE.test(r)) ||
        (/"(?:datamodel_type|edits|old_string|new_string|file_path|target_file)"\s*:/.test(r) &&
          !/"command"\s*:/.test(r))
      );
      if (cmdShaped && P.replyUnsettled(d.item)) {
        if (!unsettledSince) unsettledSince = Date.now();
        if (Date.now() - unsettledSince < UNSETTLED_GRACE_MS) { await sleep(250); continue; }
      } else {
        unsettledSince = 0;
      }
      // A/B "carousel" turn (Qwen): while it is unresolved the site REMOVES the
      // composer from the DOM (validated live: getEditor() is null), so we can't
      // send the tool result until a candidate is picked - and the read reply is a
      // partial candidate, so a command there looks "cut off". Per the product rule
      // we use the FIRST candidate: wait for BOTH candidates to finish generating
      // (you can't select mid-stream), then auto-select Response 1. That collapses
      // the carousel to a normal turn - composer returns - and the normal parse/run
      // path below handles it. Never a parse_error here (the model didn't truncate).
      // No-op for every provider except Qwen. RESPONSE_TIMEOUT still bounds a truly
      // stuck carousel, so this cannot hang.
      if (P.isComparisonTurn && P.isComparisonTurn(d.item)) {
        if (P.isGenerating()) { await sleep(250); continue; }   // both still writing
        if (P.resolveComparison && P.resolveComparison()) {
          diag("carousel.resolved");
          await sleep(400); continue;                            // let it collapse, re-read
        }
        await sleep(250); continue;                              // button not ready yet
      }
      // Prefer the fenced block's own reconstructed source over the combined
      // Markdown read. On ChatGPT a nested CodeMirror editor can already contain
      // all 79 Lua lines while its outer turn text still presents only the closing
      // marker. Parsing the exact <pre> first removes that renderer race entirely.
      const providerCommand = providerCommandCalls(d.item);
      if (providerCommand) {
        diag("response.providerCommandSource", {
          candidate: providerCommand.index,
          count: providerCommand.calls.length,
          names: providerCommand.calls.map((call) => call.tool),
        });
        finalizeDiag("tool");
        return { kind: "tool", calls: providerCommand.calls, item: d.item };
      }
      const closingOnlyLuau =
        ZSParse.LUA_END_RE.test(r) && !ZSParse.LUA_START_RE.test(r);
      if (closingOnlyLuau) {
        if (!luaMarkerMismatchSince) luaMarkerMismatchSince = Date.now();
        // ChatGPT's CodeMirror can commit bottom lines before its first line is
        // readable. A visible ###END_LUA### with a temporarily absent opener is
        // therefore an unsettled DOM read, not immediately a model error.
        if (Date.now() - luaMarkerMismatchSince < 4_000) {
          await sleep(250);
          continue;
        }
      } else {
        luaMarkerMismatchSince = 0;
      }
      if (ZSParse.hasToolSignature(r)) {
        const calls = ZSParse.parseToolCalls(r);
        if (calls.length) { finalizeDiag("tool"); return { kind: "tool", calls, item: d.item }; }
        // A half-written command + the site's "Continue" button means the command
        // was truncated mid-stream → resume it rather than reporting bad JSON.
        if (P.findContinueBtn()) return { kind: "truncated", text: r, item: d.item };
        // Only fire parse_error if explicit markers were present.
        if (r.includes(ZSParse.START_M) || ZSParse.LUA_START_RE.test(r)) return { kind: "parse_error", reason: "malformed", raw: r, item: d.item };
        // A command opener with no closer (a JSON object that never closed -
        // the model was halted mid-write and there is no Continue affordance):
        // ask the model to rewrite it instead of silently ending the turn.
        // ...unless ONLY the trailing closers were lost (the model hit its
        // output limit with the payload complete - seen live on Qwen: a big
        // multi_edit missing exactly one final "}"). salvageCutOff auto-closes
        // and runs it instead of burning a whole retry turn; it refuses any
        // cut that amputated real content (mid-string / deep deficit), which
        // still falls through to the parse_error feedback. Safe to run here:
        // generation has ended (the open-block branch above kept waiting
        // while it streamed).
        if (ZSParse.hasOpenToolBlock(r)) {
          const saved = ZSParse.salvageCutOff(r);
          if (saved) {
            diag("tool.salvaged", { name: saved.tool });
            finalizeDiag("tool");
            return { kind: "tool", calls: [saved], item: d.item };
          }
          return { kind: "parse_error", reason: "unclosed", raw: r, item: d.item };
        }
        // A closed-looking JSON command envelope that NAMES A REAL TOOL but failed
        // to parse - typically an unescaped " inside a code/string param broke the
        // JSON (seen live on Kimi's execute_blender_code: `name = "Camera_System"`
        // mid-code). Unlike execute_luau there is NO ###LUA### fallback, so the
        // command silently dropped and the loop finalized the turn as a plain-text
        // answer with no result and no error - a dead turn. Fire a parse_error so
        // the model can fix its JSON. GATED on a known command name so prose that
        // merely quotes {"command":"..."} (a DeepSeek-style explanation, or a
        // placeholder like "command_name") is NOT misread as a broken command and
        // looped on - only a real tool name means a genuine failed call.
        const nm = ZSParse.toolNameFromText(r);
        if (nm && nm !== "command" && (A.toolNames.has(nm) || A.toolNames.has(bareToolName(nm)))) {
          return { kind: "parse_error", reason: "malformed", raw: r, item: d.item };
        }
      }
      // Malformed execute_luau: the model wrote the ###END_LUA### closer but
      // FORGOT the ###LUA### opener, so hasToolSignature missed it and the block
      // never ran (seen on Gemini). Don't silently treat it as a final answer -
      // nudge a rewrite instead of leaving the user stuck on a dead turn.
      if (ZSParse.LUA_END_RE.test(r) && !ZSParse.LUA_START_RE.test(r) && !r.includes(ZSParse.START_M)) {
        return { kind: "parse_error", reason: "luaOpener", raw: r, item: d.item };
      }
      // Malformed command: the model emitted a tool's RAW ARGUMENTS as a bare JSON
      // object (e.g. {"datamodel_type":...,"edits":[...],"file_path":...}) instead of
      // the required {"command":...,"params":...} envelope - it treated the tool as a
      // real callable function (seen on Gemini). Those argument keys never appear in a
      // normal prose answer, so nudge a rewrite rather than ending the turn silently.
      if (/"(?:datamodel_type|edits|old_string|new_string|file_path|target_file)"\s*:/.test(r) &&
          !/"command"\s*:/.test(r)) {
        return { kind: "parse_error", reason: "envelope", raw: r, item: d.item };
      }
      // A provider-owned interruption notice is not a real final answer. Return
      // it to the loop so ViewCoder can pause cleanly without injecting a retry.
      if (P.isBusyMsg && P.isBusyMsg(r)) {
        return { kind: "interrupted", detail: "the AI page interrupted the reply" };
      }
      // The site caps output length and shows a native "Continue" button when it
      // truncates. We try clicking it directly (same turn) in the loop.
      if (P.findContinueBtn()) return { kind: "truncated", text: r, item: d.item };
      if (r === "") { diag("empty.why", { branch: "finalBlank" }); return { kind: "empty" }; }
      return { kind: "text", text: r, item: d.item };
    }
    return { kind: "timeout" };
  }

  // Keep the recovered build's original working cover visible while an
  // automatic message is waiting for the provider's next turn. Tool execution
  // and response waiting are separate phases; treating both as active work
  // prevents ChatGPT (and the other providers) from exposing an idle composer
  // after Blender has finished but before the AI has continued.
  async function waitForResponse(base, options = {}) {
    A.awaitingReply = true;
    setInputLocked(true);
    ui.inputCover(true);
    const progressWatchdog = options.toolResultReply === true
      ? createDeadlineWatchdog(
          Date.now() + (Number(options.preStartTimeoutMs) || TOOL_RESULT_REPLY_START_MS),
          watchdogToken("result-reply"),
          () => {},
        )
      : null;
    try {
      return await waitForResponseCore(base, {
        ...options,
        progressWatchdog,
      });
    } finally {
      progressWatchdog?.cancel();
      A.awaitingReply = false;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  TOOL EXECUTION  (always returns a feedback string for the model)
  // ════════════════════════════════════════════════════════════════════════
  function bg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, kind: "disconnected", error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { ok: false, kind: "disconnected", error: "no response from background" });
          }
        });
      } catch (e) {
        resolve({ ok: false, kind: "disconnected", error: String(e) });
      }
    });
  }

  function safeStorageSet(items) {
    try {
      const pending = chrome.storage.local.set(items);
      // Newer Chromium returns a Promise; older callback-style builds return
      // undefined. Swallow teardown-only rejections when an extension reload
      // invalidates an otherwise healthy content-script context.
      if (pending && typeof pending.catch === "function") {
        pending.catch(() => undefined);
      }
    } catch {}
  }

  // Blender executes the supplied Python as a module. A simple /^return/m
  // check misses the common failure `if condition:\n    return`, because the
  // illegal return is indented but still outside every function. Track function
  // indentation while ignoring comments and quoted strings so valid returns in
  // helpers remain allowed and module-level returns are rejected before a slow
  // MCP round trip.
  function pythonCodeOutsideStrings(line, state) {
    let output = "";
    for (let index = 0; index < line.length; index += 1) {
      if (state.triple) {
        const close = line.indexOf(state.triple, index);
        if (close < 0) return output;
        index = close + 2;
        state.triple = null;
        continue;
      }
      const char = line[index];
      if (char === "#") break;
      if (char === "'" || char === '"') {
        const triple = char.repeat(3);
        if (line.slice(index, index + 3) === triple) {
          state.triple = triple;
          index += 2;
          continue;
        }
        for (index += 1; index < line.length; index += 1) {
          if (line[index] === "\\") {
            index += 1;
          } else if (line[index] === char) {
            break;
          }
        }
        continue;
      }
      output += char;
    }
    return output;
  }
  function hasTopLevelPythonReturn(code) {
    const functionIndents = [];
    const stringState = { triple: null };
    for (const rawLine of String(code || "").split(/\r?\n/)) {
      const line = pythonCodeOutsideStrings(rawLine, stringState);
      if (!line.trim()) continue;
      const whitespace = line.match(/^[ \t]*/)?.[0] || "";
      const indent = [...whitespace].reduce(
        (total, char) => total + (char === "\t" ? 4 : 1),
        0,
      );
      while (
        functionIndents.length &&
        indent <= functionIndents[functionIndents.length - 1]
      ) {
        functionIndents.pop();
      }
      if (/^\s*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/.test(line)) {
        functionIndents.push(indent);
        continue;
      }
      if (
        /^\s*return\b/.test(line) &&
        !functionIndents.some((functionIndent) => indent > functionIndent)
      ) {
        return true;
      }
    }
    return false;
  }

  // Long-running subagents, screenshots, and the old play start/stop probe are
  // never part of ViewCoder's command surface. Keeping this guard here also
  // protects a stale conversation whose cached command list still contains one.
  // Addon servers (Blender, Sketchfab, ...) can ALSO ship an image-returning
  // tool under any name we don't know in advance - rather than guess names,
  // any tool result carrying images is caught generically at the point results
  // are handled (see the `r.images.length` branch) and turned into a plain
  // error on non-vision providers, so nothing needs to be predicted here.
  const ALWAYS_BLOCKED_TOOLS = new Set([
    "subagent",
    "screen_capture",
    "start_stop_play",
    "user_keyboard_input",
    "user_mouse_input",
  ]);
  const PLAYTEST_TOOLS = new Set([
    "start_stop_play",
    "user_keyboard_input",
    "user_mouse_input",
  ]);
  const VISION_TOOLS = new Set();
  const bareToolName = (name) => (name && name.includes("/") ? name.split("/").pop() : name) || "";
  const IMAGE_URL_KEYS = [
    "imagePaths", "image_paths", "images",
    "image_url", "imageUrl", "url", "source_url", "sourceUrl",
    "asset_url", "assetUrl", "file_url", "fileUrl", "uri",
    "path", "file_path", "filePath", "image_path", "imagePath",
  ];
  const isBlockedTool = (name) => {
    const bare = bareToolName(name);
    if (ALWAYS_BLOCKED_TOOLS.has(bare)) return true;
    if (VISION_TOOLS.has(bare) && !P.supportsVision) return true;
    if (/screenshot|viewport[_-]?screenshot/i.test(bare)) return true;
    return false;
  };

  const READ_ONLY_TOOL = /^(?:list_|get_|find_|search_|inspect_|read_|script_read$|script_search$|script_grep$|batch_read$|score_assets$|find_game_icons$|get_capabilities$)/i;
  const ANIMATION_TERMS = /\b(?:animat(?:e|ed|ing|ion|or)|rig|armature|pose|keyframe|keying|timeline|dope\s*sheet|action|bone|motor6d|cframe|humanoid|r6|r15|ik|inverse\s*kinematic)\b/i;
  function nestedWorkflowCalls(call) {
    if (bareToolName(call?.tool) !== "run_workflow") return [];
    const found = [];
    for (const step of call?.arguments?.steps || []) {
      if (step?.tool) found.push({ tool: step.tool, arguments: step.arguments || {} });
      if (step?.verify?.tool) found.push({ tool: step.verify.tool, arguments: step.verify.arguments || {} });
      if (step?.rollback?.tool) found.push({ tool: step.rollback.tool, arguments: step.rollback.arguments || {}, rollback: true });
    }
    return found;
  }
  function callIsReadOnly(call) {
    const bare = bareToolName(call?.tool);
    if (!bare) return false;
    if (bare === "run_workflow") {
      const nested = nestedWorkflowCalls(call);
      return nested.length > 0 && nested.every((entry) => !entry.rollback && callIsReadOnly(entry));
    }
    if (bare === "project_context") {
      const operation = String(call?.arguments?.operation || call?.arguments?.action || "search");
      return !/remember|write|update|delete|clear|link|unlink/i.test(operation);
    }
    return READ_ONLY_TOOL.test(bare) || bare === "list_commands" || bare === "list_tools" || bare === "list_mcp_servers";
  }
  function callIsAnimationFocused(call) {
    if (callIsReadOnly(call)) return true;
    if (bareToolName(call?.tool) === "run_workflow") {
      const nested = nestedWorkflowCalls(call).filter((entry) => !callIsReadOnly(entry));
      return nested.length > 0 && nested.every(callIsAnimationFocused);
    }
    let serialized = "";
    try { serialized = JSON.stringify(call?.arguments || {}); } catch {}
    return ANIMATION_TERMS.test(`${bareToolName(call?.tool)} ${serialized}`);
  }
  const UI_MUTATION_TERMS = /\b(?:startergui|screengui|guiobject|frame|scrollingframe|canvasgroup|textbutton|imagebutton|imagelabel|textlabel|uicorner|uistroke|uigradient|uilistlayout|uigridlayout|shop|menu|hud|interface|panel|header|button|badge)\b/i;
  function callIsCodeNativeUiMutation(call) {
    if (!call || callIsReadOnly(call)) return false;
    const bare = bareToolName(call.tool);
    if (["generate_ui_image", "generate_icon", "upload_image"].includes(bare)) {
      return false;
    }
    if (bare === "run_workflow") {
      return nestedWorkflowCalls(call).some(callIsCodeNativeUiMutation);
    }
    let serialized = "";
    try { serialized = JSON.stringify(call.arguments || {}); } catch {}
    return UI_MUTATION_TERMS.test(`${bare} ${serialized}`);
  }
  function userExpectsNativeGeneratedUi(text) {
    if (!aiGeneratedUiEnabled()) return false;
    const request = String(text || "").replace(/\s+/g, " ").trim();
    if (!request) return false;
    if (/\b(?:do\s+not|don'?t|without|disable|turn\s+off)\b.{0,45}\b(?:ai[-\s]?generated|image\s+generat|native\s+image)\b/i.test(request)) {
      return false;
    }
    // Explicit follow-ups such as "make it AI generated" refer to the UI from
    // the preceding turn and therefore do not contain the word UI themselves.
    if (/\b(?:ai[-\s]?generated|native[-\s]?generated|image[-\s]?generated)\b|\b(?:use|invoke|try)\b.{0,35}\b(?:your\s+)?(?:image\s+generator|image\s+generation)\b/i.test(request)) {
      return true;
    }
    return (
      /\b(?:icons?|ui|interface|menu|shop|hud|panel|header|badge)\b/i.test(request) ||
      /\b(?:add|make|create|generate|design)\b.{0,80}\b(?:button|badge|symbol|logo|emblem|panel|header|menu|interface)\b/i.test(request)
    );
  }
  function iconCalls(call) {
    return [call, ...nestedWorkflowCalls(call)].filter(
      (entry) => ["generate_icon", "build_roblox_ui"].includes(bareToolName(entry?.tool)),
    );
  }
  function generatedUiCalls(call) {
    return [call, ...nestedWorkflowCalls(call)].filter(
      (entry) => bareToolName(entry?.tool) === "generate_ui_image",
    );
  }
  function enforceIconProviderPolicy(call) {
    for (const entry of iconCalls(call)) {
      const target = entry.arguments || (entry.arguments = {});
      if (aiGeneratedUiEnabled()) {
        delete target.library_only;
      } else {
        target.library_only = true;
        delete target.generated_image_url;
        delete target.generatedImageUrl;
        delete target.icon_spec;
      }
    }
  }

  // ── Learned image tools (reload-proof "screen" chip) ──────────────────────
  // The known Roblox vision tool (screen_capture) is themed "screen" by name via
  // ZS.toolCategory. A custom MCP tool's NAME reveals nothing, so we learn which
  // ones return images and persist that across reloads: with it, a revisited or
  // reloaded conversation still shows the image-capture chip (not the generic
  // wrench), and the NEXT call of a known image tool is optimistic from the start.
  // The marker below is the exact tail runTool appends to a feedback that carries
  // an image (see runTool's r.images branch) - the reload-proof signal, readable
  // straight from the injected result turn's text even when no loop is running.
  const IMAGE_FEEDBACK_RE = /image is attached to THIS message/i;
  function rememberImageTool(name) {
    const bare = bareToolName(name);
    if (!bare || A.imageTools.has(bare)) return;
    A.imageTools.add(bare);
    diag("imageTool.remember", { name: bare, total: A.imageTools.size });
    safeStorageSet({ zsImageTools: [...A.imageTools].slice(-200) });
  }
  try {
    chrome.storage.local.get("zsImageTools", (r) => {
      if (r && Array.isArray(r.zsImageTools)) for (const n of r.zsImageTools) A.imageTools.add(n);
      diag("imageTool.loaded", { tools: [...A.imageTools] });
    });
  } catch {}

  async function ensureTools() {
    const r = await bg({ type: "list_tools" });
    if (r && r.tools && r.tools.length) {
      const tools = r.tools
        .filter((t) => !isBlockedTool(t.name))
        .map((tool) => bareToolName(tool.name) === "upload_image"
          ? {
              ...tool,
              description:
                `${tool.description || "Upload images to Roblox Studio."} ` +
                "ViewCoder can privately relay a browser attachment or a safe public image URL through its local bridge, so use this command instead of asking the user to upload the image to a host. Studio success is only valid when the result contains a verified asset/content ID.",
            }
          : tool);
      A.toolList = tools;
      A.toolNames = new Set(tools.map((t) => t.name));
    }
    return A.toolList;
  }

  function uploadImageArgument(toolName, args) {
    const definition = A.toolList.find((tool) => tool.name === toolName) ||
      A.toolList.find((tool) => bareToolName(tool.name) === "upload_image");
    const properties = definition?.inputSchema?.properties || {};
    for (const [key, property] of Object.entries(properties)) {
      if (
        property?.type === "array" &&
        (property?.items?.type === "string" || !property?.items?.type) &&
        /(?:image|file|source|asset).*(?:path|url|uri)|^images?$/i.test(key)
      ) return { key, multiple: true, properties };
    }
    for (const key of IMAGE_URL_KEYS) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        return { key, multiple: properties[key]?.type === "array", properties };
      }
    }
    for (const [key, property] of Object.entries(properties)) {
      const description = String(property?.description || "");
      if (
        (property?.type === "string" || !property?.type) &&
        (/(?:image|file|source|asset).*(?:url|uri)|^(?:url|uri)$/i.test(key) ||
          /https?:|image\s+url|direct\s+url/i.test(description))
      ) return { key, multiple: false, properties };
    }
    for (const key of IMAGE_URL_KEYS) {
      if (Object.prototype.hasOwnProperty.call(args, key)) {
        return { key, multiple: Array.isArray(args[key]), properties };
      }
    }
    // Roblox Studio's current command is batch-shaped. This fallback is only
    // reached before a stale tool list refresh; using its real shape avoids an
    // extra strict-schema failure on the first attachment request.
    return { key: "imagePaths", multiple: true, properties };
  }

  const LOCAL_RELAY_IMAGE_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):3000\/images\/[A-Za-z0-9_-]{16,80}(?:\/|$)/i;

  function remoteImageName(value) {
    try {
      const url = new URL(value);
      return decodeURIComponent(url.pathname.split("/").pop() || "") || "viewcoder-remote-image";
    } catch {
      return "viewcoder-remote-image";
    }
  }

  async function relayPublicImage(value) {
    const response = await bg({
      type: "relay_remote_image",
      url: value,
      name: remoteImageName(value),
    });
    if (!response?.ok || !LOCAL_RELAY_IMAGE_RE.test(response.url || "")) {
      throw new Error(response?.error || "The public image could not be safely relayed.");
    }
    return {
      captureId: "",
      id: response.id || "",
      url: response.url,
      name: response.name || remoteImageName(value),
      mimeType: response.mimeType || "",
      size: Number(response.size) || 0,
      originalUrl: value,
      remote: true,
    };
  }

  async function prepareUploadImage(name, args) {
    const spec = uploadImageArgument(name, args);
    const { key, multiple, properties } = spec;
    const currentValue = args[key];
    const candidates = (multiple
      ? (Array.isArray(currentValue) ? currentValue : [currentValue])
      : [currentValue])
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const urls = [];
    const images = [];

    const relay = globalThis.ViewCoderImageRelay;
    for (const current of candidates) {
      if (LOCAL_RELAY_IMAGE_RE.test(current)) {
        urls.push(current);
        images.push({ url: current, localRetry: true });
        continue;
      }
      if (/^https?:\/\//i.test(current)) {
        const remote = await relayPublicImage(current);
        urls.push(remote.url);
        images.push(remote);
        continue;
      }
      // A provider can occasionally expose its preview as blob:/data: without
      // firing a file-input event. Capture that page-scoped value as a fallback.
      if (/^(?:blob:|data:image\/)/i.test(current) && relay?.captureFiles) {
        try {
          const response = await fetch(current);
          const blob = await response.blob();
          if (/^image\//i.test(blob.type || "")) {
            relay.captureFiles([
              new File([blob], `viewcoder-browser-image-${Date.now()}`, {
                type: blob.type,
              }),
            ], "tool-url");
          }
        } catch {}
      }
    }

    if (!urls.length && relay?.latest) {
      const image = await relay.latest({
        maxAgeMs: 30 * 60 * 1000,
        waitMs: 5_000,
        refresh: true,
      });
      if (image?.url) {
        urls.push(image.url);
        images.push(image);
      }
    }
    if (!urls.length) {
      throw new Error(
        "No readable image was available. Attach a PNG, JPEG, GIF, or WebP file, or provide a public image URL.",
      );
    }
    args[key] = multiple ? urls : urls[0];
    // Some models put the inaccessible browser path under a guessed alias.
    // Remove only URL-like aliases that the live schema does not advertise;
    // otherwise strict MCP validation rejects the repaired call as extra input.
    for (const alias of IMAGE_URL_KEYS) {
      if (alias !== key && Object.prototype.hasOwnProperty.call(args, alias) &&
          !Object.prototype.hasOwnProperty.call(properties, alias)) {
        delete args[alias];
      }
    }
    diag("imageRelay.applied", {
      key,
      count: urls.length,
      names: images.map((image) => image.name || "relayed image").slice(0, 5),
      optimized: images.filter((image) => image.optimized).length,
    });
    return { images, urls, key, multiple };
  }

  const GENERATED_ICON_SOURCE_KEYS = [
    "generated_image_url", "imagePaths", "image_paths", "images",
    "image_url", "imageUrl", "url", "file_id", "fileId", "path",
    "file_path", "filePath", "image_path", "imagePath",
  ];

  async function prepareGeneratedIconImage(args) {
    const values = [];
    for (const key of GENERATED_ICON_SOURCE_KEYS) {
      const value = args[key];
      for (const entry of Array.isArray(value) ? value : [value]) {
        const text = String(entry || "").trim();
        if (text) values.push(text);
      }
    }
    if (!values.length) return null;
    const relay = globalThis.ViewCoderImageRelay;
    let image = null;

    for (const current of values) {
      if (LOCAL_RELAY_IMAGE_RE.test(current)) {
        image = { url: current, localRetry: true, source: "local-relay" };
        break;
      }
      if (/^https?:\/\//i.test(current)) {
        try {
          image = await relayPublicImage(current);
          break;
        } catch (error) {
          diag("generatedIconRelay.remoteFallback", {
            message: String(error?.message || error),
          });
        }
      }
      if (/^(?:blob:|data:image\/)/i.test(current) && relay?.captureFiles) {
        try {
          const response = await fetch(current);
          const blob = await response.blob();
          if (/^image\/(?:png|jpeg|gif|webp)$/i.test(blob.type || "") && blob.size) {
            relay.captureFiles([
              new File([blob], `provider-generated-${Date.now()}`, {
                type: blob.type,
                lastModified: Date.now(),
              }),
            ], "assistant-generated");
          }
        } catch {}
      }
    }

    // ChatGPT file IDs and /mnt/data paths belong to the provider sandbox, not
    // the local bridge. The DOM relay captures the actual finished assistant
    // image and provides the bridge URL needed by generate_icon.
    if (!image && relay?.latest) {
      image = await relay.latest({
        source: "assistant-generated",
        minCapturedAt: Math.max(0, (A.userIntentAt || Date.now()) - 2_000),
        maxAgeMs: 10 * 60 * 1000,
        waitMs: 7_000,
        refresh: true,
      });
    }

    if (image?.url) args.generated_image_url = image.url;
    else delete args.generated_image_url;

    // These are common guesses copied from unrelated native generator schemas.
    // They are not part of viewcoder/generate_icon and strict schema validation
    // must never see them.
    for (const key of GENERATED_ICON_SOURCE_KEYS) {
      if (key !== "generated_image_url") delete args[key];
    }
    diag("generatedIconRelay.prepared", {
      found: Boolean(image?.url),
      source: image?.source || "fallback-pipeline",
      inaccessibleCandidates: values.filter((value) => /^(?:file_|sandbox:|\/mnt\/data\/)/i.test(value)).length,
    });
    return image;
  }

  async function latestAssistantGeneratedImage(waitMs = 0) {
    const relay = globalThis.ViewCoderImageRelay;
    if (!relay?.latest) return null;
    return relay.latest({
      source: "assistant-generated",
      minCapturedAt: Math.max(0, (A.userIntentAt || Date.now()) - 2_000),
      maxAgeMs: 10 * 60 * 1000,
      waitMs,
      refresh: true,
    });
  }

  function capturedNativeUiImageForCurrentUserTurn() {
    const entry = A.nativeUiCapturedForUserTurn;
    if (
      !entry ||
      entry.userTurn !== A.nativeUiUserTurn ||
      !entry.image?.url
    ) return null;
    return entry.image;
  }

  function rememberCapturedNativeUiImageForCurrentUserTurn(image) {
    if (!image?.url) return null;
    const existing = capturedNativeUiImageForCurrentUserTurn();
    if (existing) return existing;
    A.nativeUiCapturedForUserTurn = {
      userTurn: A.nativeUiUserTurn,
      image,
    };
    const key = generatedImageAnnouncementKey(image);
    if (key) A.generatedImageAnnouncements.add(key);
    try { globalThis.ViewCoderImageRelay?.markUsed?.(image.captureId); } catch {}
    A.expectGeneratedUi = false;
    A.awaitingNativeUiGeneration = false;
    A.aiUiGenerationAttempts = 0;
    A.aiUiBackgroundFailures = 0;
    A.aiUiFallbackTriggered = false;
    A.nativeUiApprovalRequired = true;
    A.pendingNativeUiApprovalImage = image;
    return image;
  }

  function nativeUiImageStillRendering(scopeItem = null) {
    const item = scopeItem || P.lastAssistant?.();
    if (!item || item.closest?.("#zs-root")) return false;
    try {
      const providerState = P.nativeImageGenerationState?.(item);
      if (providerState && typeof providerState.active === "boolean") {
        const root = providerState.root || null;
        const key = nativeUiImageRootKey(root);
        const isBaseline = !!root && (
          A.nativeImageBaselineKey
            ? key === A.nativeImageBaselineKey
            : root === A.nativeImageBaselineRoot
        );
        if (isBaseline) return false;
        return providerState.active;
      }
    } catch {}
    const text = String(item.innerText || item.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    return /\b(?:creating|generating|rendering|drawing)\s+(?:an?\s+)?image\b|\b(?:preparing\s+visual\s+context|sketching\s+it\s+out|working\s+on\s+it|refining\s+details|finishing\s+up|one\s+last\s+tweak|polishing\s+details|adding\s+final\s+touches|almost\s+there)\b|\bimage\s+(?:is\s+)?still\s+(?:being\s+)?(?:created|generated|rendered)\b/i.test(text);
  }

  function nativeUiImageRootKey(root) {
    if (!root || !(root instanceof Element)) return "";
    return String(
      root.getAttribute("data-testid") ||
      root.getAttribute("data-message-id") ||
      root.id ||
      "",
    );
  }

  async function waitForFinishedAssistantGeneratedImage(
    waitMs = NATIVE_UI_GENERATION_WAIT_MS,
    scopeItem = null,
  ) {
    // A tool call can arrive in a later automatic receipt after the provider's
    // image card has remounted or disappeared. Reuse the first validated image
    // from this real user turn immediately; never wait for or trigger a second.
    const captured = capturedNativeUiImageForCurrentUserTurn();
    if (captured) return captured;
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
    let candidate = null;
    let candidateStableAt = 0;
    let candidateId = null;
    let lastScopedRecoveryAt = 0;
    do {
      if (A.stop) return null;
      const fallbackScope = scopeItem?.isConnected ? scopeItem : (P.lastAssistant?.() || scopeItem);
      let providerImageState = null;
      try { providerImageState = P.nativeImageGenerationState?.(fallbackScope) || null; } catch {}
      const providerRoot = providerImageState?.root || null;
      const providerRootKey = nativeUiImageRootKey(providerRoot);
      const providerRootIsNew = !!providerRoot && (
        A.nativeImageBaselineKey
          ? providerRootKey !== A.nativeImageBaselineKey
          : providerRoot !== A.nativeImageBaselineRoot
      );
      const captureScope = providerRootIsNew && providerRoot?.isConnected
        ? providerImageState.root
        : fallbackScope;
      const found = await latestAssistantGeneratedImage(0);
      const foundKey = found?.captureId || found?.url || "";
      if (found?.url && !A.generatedImageAnnouncements.has(foundKey)) {
        candidate = found;
        if (candidateId !== foundKey) {
          candidateId = foundKey;
          candidateStableAt = Date.now();
        }
      }
      const relay = globalThis.ViewCoderImageRelay;
      const finishedVisible = relay?.hasFinishedGeneratedImage?.(captureScope) === true;
      const providerFinished = providerRootIsNew && providerImageState?.finished === true;
      const stillRendering = !providerFinished && (
        (providerRootIsNew && providerImageState?.active === true) ||
        nativeUiImageStillRendering(captureScope) ||
        (P.isGenerating() && !finishedVisible)
      );

      // Do not make relay recovery depend on relay.latest() already containing a
      // record. That circular dependency left a visibly completed native image
      // sitting behind the "Waiting" card forever whenever the observer missed
      // it. Re-scan only this command's assistant turn and upload its final pixels.
      if (
        !candidate?.url &&
        !stillRendering &&
        relay?.captureFinishedGeneratedImage &&
        Date.now() - lastScopedRecoveryAt >= 750
      ) {
        lastScopedRecoveryAt = Date.now();
        const recovered = await relay.captureFinishedGeneratedImage({
          anchor: captureScope,
          recoverCurrentTurn: true,
        });
        if (recovered?.url || recovered?.rejected) return recovered;
      }
      if (
        candidate?.url &&
        !stillRendering &&
        Date.now() - candidateStableAt >= NATIVE_UI_IMAGE_SETTLE_MS
      ) {
        if (relay?.captureFinishedGeneratedImage) {
          const refreshed = await relay.captureFinishedGeneratedImage({
            anchor: captureScope,
            recoverCurrentTurn: true,
          });
          if (refreshed?.url || refreshed?.rejected) return refreshed;
        }
        return candidate;
      }
      if (Date.now() >= deadline) return null;
      await sleep(180);
    } while (true);
  }

  function generatedImageAnnouncementKey(image) {
    return image?.captureId || image?.url || "";
  }

  function hasUsableGeneratedImageSource(args = {}) {
    for (const key of GENERATED_ICON_SOURCE_KEYS) {
      const values = Array.isArray(args[key]) ? args[key] : [args[key]];
      if (values.some((value) => {
        const source = String(value || "").trim();
        return LOCAL_RELAY_IMAGE_RE.test(source) || /^https?:\/\//i.test(source);
      })) return true;
    }
    return false;
  }

  function generatedUiToolNeedsFinishedImage(call) {
    if (!aiGeneratedUiEnabled()) return false;
    const bareName = bareToolName(call?.tool);
    if (bareName !== "generate_icon" && bareName !== "generate_ui_image") return false;
    if (call?.arguments?.library_only === true) return false;
    if (capturedNativeUiImageForCurrentUserTurn()?.url) return true;
    return (
      A.awaitingNativeUiGeneration ||
      nativeUiImageStillRendering() ||
      !hasUsableGeneratedImageSource(call?.arguments)
    );
  }

  async function attachFinishedGeneratedImageToCall(call, scopeItem = null) {
    if (!generatedUiToolNeedsFinishedImage(call)) return null;
    const cachedImage = capturedNativeUiImageForCurrentUserTurn();
    if (cachedImage?.url) {
      const args = call.arguments || (call.arguments = {});
      args.generated_image_url = cachedImage.url;
      diag("generatedIconRelay.reused", {
        tool: call.tool,
        captureId: cachedImage.captureId || "",
      });
      return cachedImage;
    }
    A.awaitingNativeUiGeneration = true;
    const image = await waitForFinishedAssistantGeneratedImage(
      NATIVE_UI_GENERATION_WAIT_MS,
      scopeItem,
    );
    if (!image?.url) {
      const rejection = String(image?.error || "").trim();
      if (rejection) call.__viewCoderGeneratedImageError = rejection;
      diag(rejection ? "generatedIconRelay.rejected" : "generatedIconRelay.waitExpired", {
        tool: call?.tool || "",
        waitMs: NATIVE_UI_GENERATION_WAIT_MS,
        reason: rejection,
      });
      return null;
    }
    const rememberedImage = rememberCapturedNativeUiImageForCurrentUserTurn(image);
    const args = call.arguments || (call.arguments = {});
    args.generated_image_url = rememberedImage.url;
    diag("generatedIconRelay.toolReady", {
      tool: call.tool,
      captureId: rememberedImage.captureId || "",
      source: rememberedImage.source || "assistant-generated",
    });
    return rememberedImage;
  }

  function uploadAssetIds(value) {
    const found = new Map();
    const visit = (entry, key = "") => {
      if (entry === null || entry === undefined) return;
      if (Array.isArray(entry)) {
        for (const item of entry) visit(item, key);
        return;
      }
      if (typeof entry === "object") {
        for (const [childKey, child] of Object.entries(entry)) visit(child, childKey);
        return;
      }
      const text = String(entry);
      for (const match of text.matchAll(/rbxassetid:\/\/(\d{4,})/gi)) {
        found.set(match[1], `rbxassetid://${match[1]}`);
      }
      if (/(?:asset|content|image)[_-]?id/i.test(key) && /^\d{4,}$/.test(text.trim())) {
        found.set(text.trim(), `rbxassetid://${text.trim()}`);
      }
    };
    const text = String(value || "").trim();
    try { visit(JSON.parse(text)); } catch { visit(text); }
    return [...found].map(([id, uri]) => ({ id, uri }));
  }

  function updateImageUploadStage(call, item, label, phase = "run", detail = "") {
    const flow = call.__viewCoderImageUpload || (call.__viewCoderImageUpload = {
      stages: [], label: "", phase: "run", detail: "",
    });
    if (!flow.stages.includes(label)) flow.stages.push(label);
    flow.label = label;
    flow.phase = phase;
    flow.detail = detail;
    const liveItem = A.toolItem?.isConnected ? A.toolItem : item;
    if (liveItem && typeof decorate !== "undefined") {
      decorate.imageUpload(liveItem, flow, true);
      rememberActivityVisual(liveItem, {
        name: call?.tool || A.toolName || "upload_image",
        phase,
        detail,
        body: "",
        category: "screen",
        kind: "image-upload",
        imageUpload: {
          stages: [...flow.stages],
          label: flow.label,
          phase: flow.phase,
          detail: flow.detail,
          assets: flow.assets ? [...flow.assets] : [],
          verified: !!flow.verified,
        },
      });
    }
    return flow;
  }

  async function registerNativeUiGenerationFailure(reason = "No usable native-generated PNG was detected.") {
    const normalizedReason = String(reason || "").trim();
    const backgroundFailure =
      /(?:transparent|alpha|background|opaque|canvas|checkerboard|scene|preview|mockup|collage|state sheet)/i
        .test(normalizedReason);
    A.aiUiGenerationAttempts = Math.min(
      MAX_AI_UI_GENERATION_ATTEMPTS,
      Math.max(0, Number(A.aiUiGenerationAttempts) || 0) + 1,
    );
    if (backgroundFailure) {
      A.aiUiBackgroundFailures = Math.min(
        MAX_AI_UI_BACKGROUND_FAILURES,
        Math.max(0, Number(A.aiUiBackgroundFailures) || 0) + 1,
      );
    }
    const attempt = A.aiUiGenerationAttempts;
    const backgroundAttempt = A.aiUiBackgroundFailures;
    const exhausted =
      attempt >= MAX_AI_UI_GENERATION_ATTEMPTS ||
      (backgroundFailure && backgroundAttempt >= MAX_AI_UI_BACKGROUND_FAILURES);
    if (!exhausted) {
      A.awaitingNativeUiGeneration = true;
      return {
        attempt,
        fallback: false,
        instruction:
          `NATIVE IMAGE GENERATION ATTEMPT ${attempt}/${MAX_AI_UI_GENERATION_ATTEMPTS}: ${normalizedReason} ` +
          "YOU, the current chat AI, must use your own built-in native image generator now. " +
          "ViewCoder and MCP do not generate this image. Follow the user's requested style, or choose a coherent polished style when none is specified. " +
          "Generate exactly one tightly cropped PNG component with real transparent alpha. NO BACKGROUND AT ALL: every pixel outside the component must be fully transparent (alpha 0), not black, white, colored, a scene, a canvas, a checkerboard, a card, or a mockup. " +
          "Do not call viewcoder/generate_ui_image or viewcoder/generate_icon again until your native image has visibly finished and ViewCoder has captured it. ViewCoder waits up to 3 minutes 30 seconds for that finish before reporting this attempt as incomplete.",
      };
    }

    const changed = await bg({
      type: "VIEWCODER_SET_MODES",
      modes: { iconMode: false },
    }).catch(() => null);
    if (changed?.ok && changed.modes) A.modes = normalizedViewModes(changed.modes);
    else A.modes = normalizedViewModes({ ...A.modes, iconMode: false });
    A.expectGeneratedUi = false;
    A.awaitingNativeUiGeneration = false;
    A.aiUiFallbackTriggered = true;
    A.nativeUiApprovalRequired = true;
    A.pendingNativeUiApprovalImage = null;
    modeUiRefresh();
    return {
      attempt,
      fallback: true,
      instruction:
        `AI Generated UI did not return a usable transparent PNG after ${attempt} attempt${attempt === 1 ? "" : "s"}${backgroundFailure ? ` (${backgroundAttempt} background/alpha validation failures)` : ""}, so ViewCoder automatically switched AI Generated UI off. ` +
        "Do not continue to code-native construction yet. Ask the user: 'AI Generated UI could not produce a valid transparent PNG, so I switched it off. Shall I move on with code-native UI instead?' " +
        "Only after the user approves, continue with separate code-native Roblox UI objects using the seven attached user-supplied screenshots as visual art direction. Decide whether an icon is actually suitable for each UI element. Only when it is suitable, use viewcoder/generate_icon with library_only=true for a genuine semantic match; otherwise omit the icon. Do not ask the user to switch modes.",
    };
  }

  function parseViewCoderJson(text) {
    try {
      const parsed = JSON.parse(String(text || "").trim());
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  async function runTool(call, item = null) {
    const name = call.tool;
    const args = call.arguments || (call.arguments = {});
    if (!name) return ZS.FEEDBACK.parseError("malformed");
    // Blocked commands: refuse up-front with a clear, tailored error so the
    // model abandons it and continues instead of wasting/hanging a turn.
    const bareName = bareToolName(name);
    const isBlenderCall = /^blender(?:\/|:)/i.test(name) || bareName === "execute_blender_code";
    if (
      A.nativeUiApprovalRequired &&
      (generatedUiCalls(call).length || callIsCodeNativeUiMutation(call))
    ) {
      return (
        "ERROR: AI Generated UI is waiting for the user's approval before the next step. " +
        "Do not upload, assemble, replace, or construct UI yet. Ask whether you should move on, then wait for an explicit yes/continue/go-ahead reply."
      );
    }
    if (A.modes.operatingMode === "plan" && !callIsReadOnly(call)) {
      return "ERROR: ViewCoder is currently in Plan Mode and remains read-only. Ask targeted questions about the user's preferences and constraints, present a step-by-step plan with verification, and explicitly ask whether they approve it. Do not mutate anything until the user switches the live ViewCoder bar to Agent Mode.";
    }
    if (A.modes.animationMode && !callIsAnimationFocused(call)) {
      return "ERROR: Animation Mode is on for the imported Blocky Character rig. Only animation, rig, pose, bone, action, timeline, and keyframe work may mutate the connected project. Read-only inspection is still allowed. Disable Animation Mode before unrelated edits.";
    }
    if (
      aiGeneratedUiEnabled() &&
      (A.expectGeneratedUi || A.awaitingNativeUiGeneration) &&
      callIsCodeNativeUiMutation(call)
    ) {
      return (
        "ERROR: AI Generated UI is ON for this request, so code-native Roblox UI mutation is blocked until the current chat AI finishes its own native image generation. " +
        "Invoke this AI provider's built-in image generator, follow the user's requested style or choose a suitable coherent style, and wait for one separate transparent PNG component to finish. " +
        "Only after ViewCoder captures generated_image_url may you call viewcoder/generate_ui_image and then assemble that component. Do not bypass the live mode with execute_luau, multi_edit, or run_workflow."
      );
    }
    if (generatedUiCalls(call).length && !aiGeneratedUiEnabled()) {
      return providerCanGenerateIcons()
        ? "ERROR: AI Generated UI is off. Use the supplied UI screenshots as visual references and build the interface from separate code-native Roblox UI objects. Decide whether an icon is suitable; only then use viewcoder/generate_icon with library_only=true for a genuine semantic match."
        : "ERROR: AI Generated UI is unavailable on this text-only AI. Use the supplied UI screenshots as visual references and build the interface from separate code-native Roblox UI objects. Decide whether an icon is suitable; only then use viewcoder/generate_icon with library_only=true for a genuine semantic match.";
    }
    enforceIconProviderPolicy(call);
    if (isBlockedTool(name)) {
      if (VISION_TOOLS.has(bareName)) {
        return `ERROR: '${bareName}' is unavailable here - this assistant cannot see images. Do NOT call it again. Inspect the place programmatically instead (e.g. inspect_instance, get_studio_state, search_game_tree, script_read).`;
      }
      if (PLAYTEST_TOOLS.has(bareName)) {
        return `ERROR: '${bareName}' is intentionally unavailable because this ViewCoder setup does not automate Play Test. Continue with persistent Edit-mode project changes, or ask the user to stop Play Test if Studio is currently playing.`;
      }
      return `ERROR: the '${bareName}' command timed out and is unavailable in this environment. Do NOT call it again - complete the task yourself using the other commands (execute_luau, multi_edit, etc.).`;
    }
    // Virtual command: list the MCP server(s) ViewCoder is currently connected
    // to, with each one's REAL per-server health (from the bridge, never the
    // merged tool count - a dead server must not borrow another's numbers).
    if (name === "list_mcp_servers") {
      await ensureTools();
      const servers = [...((A.bridge && A.bridge.servers) || [])];
      const orchestrationTools = A.toolList.filter((tool) => tool.server === "viewcoder");
      if (orchestrationTools.length && !servers.some((server) => server.id === "viewcoder")) {
        servers.push({ id: "viewcoder", alive: true, tools: orchestrationTools.length });
      }
      const lines = servers.length
        ? servers.map((sv) => {
            const label = sv.id === "roblox"
              ? "Roblox Studio (primary)"
              : sv.id === "viewcoder"
                ? "ViewCoder workflow and project-context engine"
                : `${sv.id} (connected plugin/add-on)`;
            const serverTools = A.toolList.filter(
              (tool) => (tool.server || "roblox") === sv.id,
            );
            const examples = serverTools
              .slice(0, 6)
              .map((tool) => bareToolName(tool.name))
              .filter(Boolean);
            const capabilityHint = examples.length
              ? `; example capabilities: ${examples.join(", ")}`
              : "";
            return `- ${sv.id}: ${label} - ${sv.alive ? `${sv.tools || serverTools.length || 0} commands available${capabilityHint}` : "offline (no tools)"}`;
          })
        : ["- roblox: Roblox Studio (primary) - unknown (bridge did not report server health)"];
      return (
        `Output of 'list_mcp_servers':\n` +
        `Connected MCP servers (${lines.length}):\n${lines.join("\n")}\n` +
        `The startup catalog already contains every currently available safe command. Use list_commands with a "server" param to refresh one server, or omit it to refresh all connected servers.`
      );
    }
    // Virtual command: list every safe command with full live schemas by default.
    // A server id may still be supplied to refresh one server in isolation.
    if (name === "list_commands" || name === "list_tools") {
      await ensureTools();
      const requested = String(args.server || "all").trim().toLowerCase();
      // The MCP proxy keeps advertising Roblox's catalogue even with no Studio
      // attached, so list_commands would hand back the full command list and read
      // as "Roblox is fine" - then every command silently fails. When Roblox is
      // actually unusable, short-circuit the DEFAULT (roblox) listing into a plain
      // "Roblox is down" note that points the model at the other server(s), so it
      // can keep working in degraded mode instead of firing dead Roblox commands.
      if (requested === "roblox") {
        const s = A.bridge || {};
        const srv = s.servers || [];
        const rbx = srv.find((x) => x.id === "roblox");
        const rbxAlive = rbx ? !!rbx.alive : (!!s.mcpAlive || srv.some((x) => x.alive));
        const rbxUsable = !!s.connected && rbxAlive && s.studio !== false;
        if (!rbxUsable) {
          const others = srv.filter((x) => x.id !== "roblox" && x.alive && (x.tools || 0) > 0);
          const otherStr = others.length
            ? `Other connected MCP server(s): ${others.map((x) => x.id).join(", ")}. Call list_mcp_servers, then list_commands with a "server" param to use them for anything that does not need Roblox.`
            : `No other MCP server is connected right now.`;
          return `Output of '${name}':\nRoblox Studio is currently OFFLINE (closed, no place open, or its MCP server disabled), so its commands cannot run. This is an environment problem on the user's machine, not your mistake. Tell the user in one short sentence to open their place in Roblox Studio and enable its MCP server. ${otherStr}`;
        }
      }
      const known = new Set(A.toolList.map((t) => t.server || "roblox").filter(Boolean));
      // Tools from a bridge that doesn't tag "server" yet (old version) have no
      // .server field at all - treat those as the primary server rather than
      // hiding everything.
      const scoped = requested === "all"
        ? A.toolList
        : A.toolList.filter((t) => (t.server || "roblox") === requested);
      if (!A.toolList.length) return `Output of '${name}':\nNo commands available - the bridge or Roblox Studio may be offline.`;
      if (!scoped.length) {
        return `Output of '${name}':\nERROR: no server named "${requested}" is connected. Connected servers: ${[...known].join(", ") || "roblox"}. Call list_mcp_servers to check.`;
      }
      const lines = scoped.map((t) => {
        const props = (t.inputSchema && t.inputSchema.properties) || {};
        const req = new Set((t.inputSchema && t.inputSchema.required) || []);
        // Two buckets: simple scalar params get packed onto ONE compact line;
        // params that need real explanation (array-of-object shape, or a long
        // description) keep their own line so nothing structurally important
        // gets flattened away (that per-item shape is what fixed "Unknown …
        // action: nil" bugs on user_keyboard_input/user_mouse_input).
        const compact = [];
        const detailed = [];
        for (const [k, v] of Object.entries(props)) {
          const items = v.items && typeof v.items === "object" ? v.items : null;
          const itemProps = items && items.properties;
          const mark = req.has(k) ? "" : "?";
          if (v.type === "array" && itemProps) {
            const itemReq = new Set(items.required || []);
            const fields = Object.entries(itemProps).map(([ik, iv]) => {
              const en = Array.isArray(iv.enum) && iv.enum.length <= 12 ? `(${iv.enum.join("|")})` : (iv.type || "any");
              return `${ik}${itemReq.has(ik) ? "" : "?"}:${en}`;
            });
            detailed.push(`    ${k}${mark}: array [each item: {${fields.join(", ")}}]${v.description ? " - " + v.description : ""}`);
          } else if (v.description && v.description.length > 45) {
            detailed.push(`    ${k}${mark}: ${v.type || "any"} - ${v.description}`);
          } else {
            const ty = Array.isArray(v.enum) && v.enum.length <= 8 ? `(${v.enum.join("|")})` : (v.type || "any");
            compact.push(`${k}${mark}:${ty}${v.description ? ` "${v.description}"` : ""}`);
          }
        }
        const paramLines = [compact.length ? `    ${compact.join(", ")}` : "", ...detailed].filter(Boolean).join("\n");
        // Tested usage note for the error-prone commands - kept full-length
        // (these are validated fixes for real bugs, not filler).
        const note = ZS.TOOL_NOTES[bareToolName(t.name)];
        const noteStr = note ? `\n    ⚠ ${note}` : "";
        return `${t.name}: ${(t.description || "").split("\n")[0]}${paramLines ? "\n" + paramLines : ""}${noteStr}`;
      });
      const scopeLabel = requested === "all" ? "all connected servers" : requested;
      return `Output of '${name}':\n${scopeLabel} commands (${scoped.length}):\n\n${lines.join("\n\n")}`;
    }
    if (A.toolNames.size && !A.toolNames.has(name)) {
      return ZS.FEEDBACK.unknownTool(name, [...A.toolNames]);
    }
    let relayedUploads = [];
    let submittedImageUrls = [];
    if (bareName === "upload_image") {
      updateImageUploadStage(call, item, "Reading attachment", "run", "Checking image data");
      try {
        const prepared = await prepareUploadImage(name, args);
        relayedUploads = prepared.images || [];
        submittedImageUrls = prepared.urls || [];
        const optimized = relayedUploads.filter((image) => image.optimized).length;
        updateImageUploadStage(
          call,
          item,
          "Preparing for Studio",
          "run",
          optimized ? `${optimized} image optimized` : `${submittedImageUrls.length} image${submittedImageUrls.length === 1 ? "" : "s"} ready`,
        );
      } catch (error) {
        const message = String(error?.message || error || "The image could not be prepared.");
        updateImageUploadStage(call, item, "Image needs attention", "err", message);
        return `ERROR: ViewCoder could not prepare the image for Studio: ${message}`;
      }
    }
    if (bareName === "generate_icon" || bareName === "generate_ui_image") {
      try {
        const generatedImage = await prepareGeneratedIconImage(args);
        if (generatedImage) relayedUploads = [generatedImage];
      } catch (error) {
        diag("generatedIconRelay.error", { message: String(error?.message || error) });
        // The workflow engine can still use a connected text-to-image generator,
        // or the verified semantic library path when AI Generated UI is disabled.
        delete args.generated_image_url;
      }
    }
    // The Roblox MCP REQUIRES datamodel_type on execute_luau (enum Edit/Client/
    // Server). The ###LUA### parser already fills it in, but the model may also
    // write the JSON form without it - default to "Edit" so the call never
    // soft-fails with "datamodel_type is required".
    if (bareName === "execute_luau" && !args.datamodel_type) args.datamodel_type = "Edit";
    if (
      bareName === "execute_luau" &&
      (typeof args.code !== "string" || !args.code.trim())
    ) {
      return (
        "ERROR: execute_luau was not executed because its code is empty. " +
        "Write the complete Luau program between ###LUA### and ###END_LUA###, then retry once."
      );
    }
    // The player-input tools only run against the Client datamodel (play mode) and
    // "Client" is the sole allowed value, so default it when the model omits it -
    // it can only be right. (It still needs the game RUNNING; that's documented.)
    if ((bareName === "user_keyboard_input" || bareName === "user_mouse_input") && !args.datamodel_type)
      args.datamodel_type = "Client";
    if (
      bareName === "execute_blender_code" &&
      typeof args.code === "string" &&
      hasTopLevelPythonReturn(args.code)
    ) {
      return (
        "ERROR: Blender code was not executed because it contains a top-level return statement. " +
        "execute_blender_code runs as a top-level Python script, where return is only legal inside a def. " +
        "Remove the top-level return, keep bpy changes at module scope (or call a helper function), and retry once with corrected code."
      );
    }
    // Current Studio MCP rejects empty old_string entries. Older prompt notes
    // incorrectly recommended that shape for script creation, causing every AI
    // provider to waste a round trip on the same deterministic failure. Reject
    // locally with an actionable route before it reaches Studio.
    if (
      bareName === "multi_edit" &&
      (!Array.isArray(args.edits) || args.edits.length === 0)
    ) {
      return (
        "ERROR: multi_edit was not executed because arguments.edits must contain at least one complete edit. " +
        "Read the confirmed script first, then provide a non-empty exact old_string and its replacement."
      );
    }
    if (bareName === "multi_edit" && Array.isArray(args.edits)) {
      const invalidIndex = args.edits.findIndex(
        (edit) =>
          !edit ||
          typeof edit.old_string !== "string" ||
          edit.old_string.length === 0,
      );
      if (invalidIndex >= 0) {
        const createTool = [...A.toolNames].find((toolName) =>
          /(?:create.*script|script.*create)/i.test(bareToolName(toolName)),
        );
        const nextStep = createTool
          ? `For a new script use the live '${createTool}' command instead.`
          : "For an existing script, call script_read on its confirmed path and copy a non-empty exact source fragment. For a new script, create it with execute_luau; do not retry multi_edit with an empty old_string.";
        return (
          `ERROR: multi_edit was not executed because arguments.edits[${invalidIndex}].old_string is empty or missing. ` +
          `The current Studio MCP requires every old_string to be non-empty. ${nextStep} ` +
          "Choose the route that matches the target and do not repeat this invalid call."
        );
      }
    }
    // Every command gets up to eight receipt-recovery attempts, spaced exactly
    // 43 seconds apart. Every dispatch reuses the same stable request id, so the
    // bridge returns/reclaims the original job instead of mutating twice.
    const timeout = bareName === "execute_luau"
      ? TOOL_RECEIPT_RETRY_MS
      : isBlenderCall
        ? 60000
        : 120000;
    // Chat sites can replace their composer while an MCP request is pending.
    // Re-apply the recovered build's original working cover during the Blender
    // window so the prompt bar never appears idle before the result arrives.
    let blenderWorkingTimer;
    if (isBlenderCall) {
      ui.inputCover(true);
      blenderWorkingTimer = setInterval(() => {
        if (!A.stop && A.toolRunning) ui.inputCover(true);
      }, 1000);
    }
    // Stop watcher: a blocking tool (e.g. wait_job_finished) would otherwise keep
    // the loop awaiting the bridge for up to minutes, leaving the input locked and
    // the Stop button stuck. When the user halts (A.stop), abandon the wait within
    // ~150ms so the loop breaks and its finally unlocks everything. The in-flight
    // bridge call may still finish in the background; its result is just ignored.
    let stopTimer;
    const stopWatch = new Promise((res) => {
      stopTimer = setInterval(() => { if (A.stop) res({ ok: false, kind: "stopped" }); }, 150);
    });
    // Stable per-assistant-turn identity. If a content-script retry, service
    // worker restart, or virtualized DOM replacement dispatches this exact call
    // again, the bridge sees the same request id and returns the original job
    // instead of mutating Studio twice. A later intentional call lives on a
    // different turn and therefore receives a different identity.
    const requestKey = commandRequestKey(item, call);
    if (bareName === "upload_image") {
      updateImageUploadStage(
        call,
        item,
        "Uploading image",
        "run",
        `${submittedImageUrls.length} image${submittedImageUrls.length === 1 ? "" : "s"}`,
      );
    }
    const dispatchTool = async () => {
      let result = null;
      for (let attempt = 0; attempt < 3 && !A.stop; attempt += 1) {
        result = await bg({
          type: "call_tool",
          name,
          arguments: args,
          timeout,
          requestKey,
        });
        if (result?.kind !== "disconnected") return result;
        // Reusing requestKey makes this safe: a restarted MV3 worker asks the
        // bridge for the same job receipt rather than re-running the mutation.
        if (attempt < 2) await sleep(350 * (attempt + 1));
      }
      return result;
    };
    const receiptNeedsRecovery = (result) => {
      if (!result) return true;
      const kind = String(result.kind || "").toLowerCase();
      const status = Number(result.statusCode) || 0;
      return (
        result.retryable === true ||
        ["timeout", "disconnected", "running", "retryable"].includes(kind) ||
        status === 408 ||
        status === 429 ||
        status >= 500
      );
    };
    // Keep only unresolved dispatches in the race. The old array retained a
    // resolved timeout forever, so that timeout instantly won every later race
    // and the advertised 43-second recovery never dispatched. A delayed earlier
    // request may still win; every requestKey is identical and therefore only
    // reclaims the original bridge job.
    const pendingReceiptDispatches = new Set();
    const startReceiptDispatch = () => {
      let tracked;
      tracked = dispatchTool()
        .then((result) => ({ kind: "receipt-dispatch", result, tracked }))
        .catch((error) => ({
          kind: "receipt-dispatch",
          result: {
            ok: false,
            kind: "retryable",
            retryable: true,
            error: error instanceof Error ? error.message : String(error),
          },
          tracked,
        }));
      pendingReceiptDispatches.add(tracked);
      return tracked;
    };
    startReceiptDispatch();
    let receiptRetries = 0;
    let r = null;
    let nextReceiptRetryAt = Math.max(
      Date.now(),
      (A.toolStart || Date.now()) + TOOL_RECEIPT_RETRY_MS,
    );
    while (!A.stop) {
      const recovery = waitForWatchdogDeadline(
        nextReceiptRetryAt,
        watchdogToken(`receipt-${receiptRetries}`),
      );
      const outcome = await Promise.race([
        ...pendingReceiptDispatches,
        recovery.promise,
        stopWatch,
      ]);
      recovery.cancel();
      if (outcome?.kind === "stopped" || A.stop) {
        r = outcome;
        break;
      }
      if (outcome?.kind === "receipt-dispatch") {
        pendingReceiptDispatches.delete(outcome.tracked);
        if (!receiptNeedsRecovery(outcome.result)) {
          r = outcome.result;
          break;
        }
        diag("tool.receiptStillPending", {
          name,
          requestKey,
          kind: outcome.result?.kind || "missing",
          retryAt: nextReceiptRetryAt,
        });
        // A timeout/running/disconnect acknowledgement is not a terminal tool
        // result. Continue to the existing 43-second deadline; if it has already
        // passed, the next loop fires recovery immediately.
        continue;
      }
      // The durable 43-second receipt alarm must do more than paint a notice.
      // Release any stale provider Stop state first, then reclaim the exact same
      // bridge job below. The stable requestKey makes this a receipt retry, not
      // a second Studio/Blender mutation. If all eight receipts fail, the normal
      // error tool-result message is written to the AI once so it can recover.
      const providerReleasedForReceipt = await releaseStalledProviderReply();
      diag("tool.receiptProviderRelease", {
        name,
        requestKey,
        released: providerReleasedForReceipt,
      });
      if (receiptRetries >= TOOL_RECEIPT_MAX_RETRIES) {
        r = {
          ok: false,
          kind: "timeout",
          error: `no response after ${TOOL_RECEIPT_MAX_RETRIES} receipt retries`,
        };
        break;
      }

      receiptRetries += 1;
      A.toolRetrying = true;
      const retryDetail =
        `${A.toolArg ? `${A.toolArg} · ` : ""}` +
        `retrying result ${receiptRetries}/${TOOL_RECEIPT_MAX_RETRIES}`;
      decorate.toolBox(
        A.toolItem?.isConnected ? A.toolItem : item,
        name,
        "run",
        retryDetail,
        true,
        callBody(call),
        ZS.toolCategory(name),
      );
      rememberActivityVisual(A.toolItem?.isConnected ? A.toolItem : item, {
        name,
        phase: "run",
        detail: retryDetail,
        body: A.toolVisual?.body || callBody(call),
        category: A.toolVisual?.category || ZS.toolCategory(name),
        kind: "tool",
      });
      diag("tool.receiptRetry", {
        name,
        requestKey,
        attempt: receiptRetries,
        maxRetries: TOOL_RECEIPT_MAX_RETRIES,
      });
      startReceiptDispatch();
      nextReceiptRetryAt = Date.now() + TOOL_RECEIPT_RETRY_MS;
    }
    clearInterval(stopTimer);
    clearInterval(blenderWorkingTimer);
    A.toolRetrying = false;
    if (r && r.kind === "stopped") return "(stopped by user)";
    if (!r) {
      if (isBlenderCall) {
        return (
          "ERROR: Blender did not return a usable result for this action. " +
          "Retry the step once with a smaller call, or continue by a safer Blender route."
        );
      }
      return ZS.FEEDBACK.bridgeOffline;
    }
    // The MCP server answers SUCCESSFULLY (ok:true) when no Studio is attached
    // (Studio closed / no place / MCP option disabled) - with an explanatory
    // text instead of a result. Surface it as a proper environment ERROR so the
    // model stops and tells the user, instead of treating it as tool output.
    if (r.ok && /Unable to find an active Studio instance|previously active Studio has disconnected/i.test(r.text || "")) {
      ui.banner("warn", "Roblox Studio is not connected",
        "Open your place in Roblox Studio and enable the MCP server (Assistant AI → … → Manage MCP Servers → Enable Studio as MCP Server), then try again.");
      return ZS.FEEDBACK.studioOffline;
    }
    // The Roblox MCP reports missing/invalid required parameters as a SUCCESS
    // whose text is just the complaint (e.g. "datamodel_type is required").
    // Re-shape those into a real ERROR so the model corrects the call instead
    // of misreading it as tool output.
    if (r.ok && r.text && /^[\w .'"-]{0,60}\bis (required|not available|invalid)\b[\w .'"-]{0,80}$/i.test(r.text.trim())) {
      return `ERROR calling '${name}': ${r.text.trim()}.\nA required or invalid parameter - check the command's parameters with list_commands, fix the call and retry.`;
    }
    // The Roblox MCP also reports Luau PARSE/RUNTIME errors as a SUCCESS whose
    // text is the executor's own stack trace ("…ExecuteLuauTool:139: …
    // CommandExecution:54: <real error>" - validated live). Genuine script
    // output never contains those internal paths. Re-shape into a real ERROR so
    // the model gets the fix-it hints below and the chip settles red, not ✓
    // green - and strip the internal frames so only the useful part remains.
    if (r.ok && bareName === "execute_luau" && r.text &&
        /\b(?:ExecuteLuauTool|CommandExecution):\d+:/.test(r.text)) {
      r = { ok: false, error: r.text.replace(/^(?:\S*(?:ExecuteLuauTool|CommandExecution):\d+:\s*)+/, "").trim() || r.text };
    }
    if (r.ok) {
      if (bareName === "upload_image") {
        updateImageUploadStage(call, item, "Verifying asset", "run", "Checking Studio response");
        const studioText = String(r.text || "").trim();
        const assets = uploadAssetIds(studioText);
        const expected = Math.max(1, submittedImageUrls.length);
        if (assets.length < expected) {
          updateImageUploadStage(
            call,
            item,
            "Image needs attention",
            "err",
            assets.length
              ? `Studio verified ${assets.length} of ${expected} images`
              : "Studio returned no asset ID",
          );
          return (
            `ERROR: Studio did not verify every uploaded image with an asset/content ID. ` +
            `Verified ${assets.length} of ${expected}. Do not claim the image is ready. ` +
            `Studio response: ${studioText || "(empty response)"}`
          );
        }
        for (const image of relayedUploads) {
          if (!image?.captureId) continue;
          try { globalThis.ViewCoderImageRelay?.markUsed?.(image.captureId); } catch {}
        }
        const assetDetail = assets.length === 1
          ? assets[0].uri
          : `${assets.length} assets verified`;
        const flow = updateImageUploadStage(call, item, "Image ready", "done", assetDetail);
        flow.assets = assets;
        flow.verified = true;
        const listing = assets.map((asset) => `- ${asset.uri} (asset/content ID ${asset.id})`).join("\n");
        return (
          `Output of '${name}':\n` +
          `Studio verified ${assets.length} uploaded image asset${assets.length === 1 ? "" : "s"}:\n${listing}\n` +
          `(System note: ViewCoder securely relayed the browser attachment or public image URL through the local bridge and verified Studio's returned asset/content ID. Use the verified ID above; do not claim success without it.)`
        );
      }
      if (bareName === "generate_icon" || bareName === "generate_ui_image") {
        for (const image of relayedUploads) {
          if (!image?.captureId) continue;
          try { globalThis.ViewCoderImageRelay?.markUsed?.(image.captureId); } catch {}
        }
      }
      const viewCoderPayload =
        bareName === "generate_icon" || bareName === "generate_ui_image"
          ? parseViewCoderJson(r.text)
          : null;
      if (viewCoderPayload?.code === "AI_NATIVE_GENERATION_REQUIRED") {
        const retry = await registerNativeUiGenerationFailure(
          String(call?.__viewCoderGeneratedImageError || "").trim() ||
            "No finished image from your own native image generator was supplied to ViewCoder.",
        );
        return `Output of '${name}':\n${retry.instruction}`;
      }
      if (viewCoderPayload?.ok === true) {
        A.expectGeneratedUi = false;
        A.awaitingNativeUiGeneration = false;
        A.aiUiGenerationAttempts = 0;
        A.aiUiBackgroundFailures = 0;
        A.aiUiFallbackTriggered = false;
        A.pendingNativeUiApprovalImage = null;
      }
      if (r.images && r.images.length && !P.supportsVision) {
        // Any tool from ANY connected server can turn out to return images -
        // we don't try to predict this from its name in advance. This is the
        // generic catch: whatever just ran, if it handed back images and this
        // provider's model can't see them, refuse cleanly instead of silently
        // attaching a file it will never actually process.
        return `ERROR: '${bareName}' returned an image, but this assistant cannot see images. Do NOT call it again. Use a different command to get the information as text instead.`;
      }
      if (r.images && r.images.length) {
        // Show the capture in a left-hand ViewCoder popup (from the in-memory
        // base64 - simple and reliable on every site; no DOM-embedded preview).
        ui.showImages(r.images, name);
        // Do NOT attach the image here: submitAndGetBase/typeAndSend types the
        // feedback text into the editor LATER, and on providers whose editor is
        // rebuilt via select-all + insertText (e.g. Gemini's setEditorText),
        // that wipe severs the site's internal binding between "pending upload"
        // and "message being composed" - the file then sits in the composer
        // forever while only the text goes out (validated live: Gemini kept
        // the file attached+unsent across the whole turn). Stash the images and
        // let the provider attach them as the LAST step, right before the send
        // click, so nothing mutates the editor afterward.
        A.pendingImages = r.images;
        diag("images.stashed", { count: r.images.length });
        const caption = safeImageCaption(r.text, r.images.length);
        return `Output of '${name}':\n${caption}\n(System note: ViewCoder attachment)\nThe image is attached to this message. Analyse it and continue the requested work.`;
      }
      if (isBlenderCall && !(r.text && r.text.trim())) {
        return (
          "ERROR: Blender did not return a usable result for this action. " +
          "The command may have reached Blender while its response was lost. " +
          "Retry the step once with a smaller call, or continue by a safer Blender route."
        );
      }
      const text = r.text && r.text.length ? r.text : "(tool returned an empty result)";
      return `Output of '${name}':\n${text}`;
    }
    if (r.kind === "disconnected") return ZS.FEEDBACK.bridgeOffline;
    if (r.kind === "running") {
      return (
        `Output of '${name}':\n` +
        `${r.error || "The existing Studio generation is still running."}\n` +
        "This is a progress state, not a failed replacement. Keep the same generationId and poll it again only when the result is needed."
      );
    }
    if (r.code === "ADDON_CONNECTION") {
      // The Blender MCP wrapper can remain alive after Blender itself (or its
      // add-on) disconnects. The bridge withdraws those tools immediately; make
      // the model abandon the dead route instead of retrying the same screenshot
      // or Python call in a loop.
      await ensureTools().catch(() => []);
      return (
        "ERROR: Blender is currently unavailable because its in-app MCP add-on " +
        "is not connected. Do NOT retry a Blender command in this work cycle. " +
        "If the request can be completed directly in Roblox Studio, continue " +
        "with the Roblox commands now. If Blender is genuinely required, tell " +
        "the user to open Blender and start its MCP add-on, then wait for them " +
        `to reconnect it. Details: ${r.error || "Blender add-on offline."}`
      );
    }
    if (r.kind === "timeout") {
      if (isBlenderCall) {
        return (
          "ERROR: Blender did not return a usable result before the response window ended. " +
          "Retry the step once with a smaller call, or continue by a safer Blender route."
        );
      }
      return `ERROR: tool '${name}' timed out after ${bareName === "execute_luau" ? 20 : isBlenderCall ? 60 : 120}s.\n${r.error}\nTry a shorter/simpler call or check that Roblox Studio is open and responsive.`;
    }
    if (bareName === "execute_luau") {
      const err = r.error || "";
      const hint = err.includes("Failed to parse command code")
        ? "Your code block was empty or the marker was wrong. Use exactly ###LUA### (three hashes) - never ###LUA---. The code must be between ###LUA### and ###END_LUA###."
        : err.includes("attempt to") || err.includes("nil value")
          ? "Lua runtime error. Check that the API you are calling exists (use game:GetService() to access services). Make sure you use 'return' to output values, not 'print()'."
          : "Check your Lua syntax, make sure you use 'return' to output values (not 'print()'), and that all APIs you call exist in the current Roblox Studio context.";
      return `ERROR in execute_luau: ${err}\n\n${hint}\n\nFix the code and retry.`;
    }
    if (
      isBlenderCall &&
      /(?:no response|timed? out|timeout|did not return|empty result|connection closed|transport closed|unexpected eof)/i.test(r.error || "")
    ) {
      return (
        "ERROR: Blender did not return a usable result for this action. " +
        "Retry the step once with a smaller call, or continue by a safer Blender route."
      );
    }
    return `ERROR calling '${name}': ${r.error}\nRead the error carefully, fix the call or use another valid method.`;
  }

  function argSummary(call) {
    if (!call) return "";
    if (call.tool === "execute_luau") {
      const code = (call.arguments && call.arguments.code) || "";
      const first = code.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
      return first.slice(0, 46);
    }
    const a = call.arguments || {};
    const k = Object.keys(a)[0];
    if (!k) return "";
    let v = String(a[k]);
    if (v.length > 34) v = v.slice(0, 31) + "…";
    return `${k}: ${v}`;
  }

  // An MCP tool can report its OWN failure as a NORMAL result ("Output of '…':
  // Error executing code: …") instead of our ERROR wrapper - so a
  // startsWith("ERROR") test alone paints a FAILED call ✓ green and shows the
  // error as its summary (seen live on Blender's execute_blender_code, and it
  // will hit EVERY future MCP server the same way). Treat a result whose FIRST
  // line opens with an error lead-in as failed too. Deliberately PHRASE-based,
  // not the bare words "error"/"failed", so a genuine success line like
  // "Failed: 0" / "Error count: 0" is NOT misread as a failure.
  const BODY_ERR_RE =
    /^\s*(tool execution failed|execution failed|error handling task|error executing|error:|erreur|exception|traceback|communication error|failed to|could ?not|cannot |unable to|fatal)\b/i;
  const stripOutputPrefix = (feedback) => feedback.replace(/^Output of '[^']*':\n?/, "");
  function bodyLooksFailed(feedback) {
    if (!feedback || feedback.startsWith("ERROR")) return false; // wrapper already flags it
    const first = stripOutputPrefix(feedback).split("\n").map((s) => s.trim()).find(Boolean) || "";
    return BODY_ERR_RE.test(first);
  }
  // True failure = OUR wrapper prefix OR an MCP tool's in-body error lead-in.
  const feedbackIsError = (feedback) => feedback.startsWith("ERROR") || bodyLooksFailed(feedback);

  // Image tools sometimes duplicate their binary payload into `text` as one
  // enormous base64 line. Never send that line through the chat composer: the
  // image is already attached separately and the duplicate can exceed provider
  // prompt limits by several megabytes.
  function safeImageCaption(text, imageCount) {
    const fallback = `${imageCount || 1} image${imageCount === 1 ? "" : "s"} captured and attached.`;
    if (typeof text !== "string" || !text.trim()) return fallback;
    const lines = text
      .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]{256,}/gi, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => {
        if (!line) return false;
        const compact = line.replace(/\s/g, "");
        const base64Chars = (compact.match(/[A-Za-z0-9+/=]/g) || []).length;
        return !(compact.length > 180 && base64Chars / compact.length > 0.94);
      });
    const cleaned = lines.join(" ").replace(/\s+/g, " ").trim();
    if (!cleaned) return fallback;
    return cleaned.length > 420 ? `${cleaned.slice(0, 417)}…` : cleaned;
  }

  function outSummary(feedback) {
    if (!feedback) return "";
    const isErr = feedbackIsError(feedback);
    const body = stripOutputPrefix(feedback).trim();
    if (!body) return "";
    if (body.startsWith("VIEWCODER_MEMORY_MISSING:")) {
      return "No project memory yet";
    }
    const all = body.split("\n").map((l) => l.trim()).filter(Boolean);
    const lines = all.length;
    // On SUCCESS, skip a leading non-fatal warning/note some MCP tools print
    // before the real status so the chip shows the useful line, not the noise.
    let first = all[0] || "";
    if (!isErr && lines > 1 && /^(warning|warn|note|deprecat|info)\b/i.test(first)) {
      first = all.find((l) => !/^(warning|warn|note|deprecat|info)\b/i.test(l)) || first;
    }
    first = first.slice(0, 44);
    if (isErr) return first;
    return lines > 1 ? `${first} · ${lines} lines` : first;
  }

  // Full args / code, shown in a tool chip's expandable body.
  function callBody(call) {
    const a = call.arguments || {};
    if (call.tool === "execute_luau") return (a.code || "").trim();
    try { return JSON.stringify(a, null, 2); } catch { return String(a); }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  AGENTIC LOOP
  // ════════════════════════════════════════════════════════════════════════
  async function releaseStalledProviderReply() {
    // The progress watchdog owns this recovery decision. Do not short-circuit it
    // from the provider's cosmetic generation flags: ChatGPT can leave its real
    // native Stop control mounted while isGenerating()/isHardGenerating() both
    // read false. That was why the correct continuation note remained queued
    // until the user manually pressed Stop.
    diag("tool.resultReplyStoppingStall", { forced: true });
    // Use ViewCoder's own Stop control path first. A manual click worked because
    // it released both ChatGPT's native response and ViewCoder's composer lock;
    // calling only provider.stopGeneration() left the recovery prompt queued
    // behind our gray Working cover. The recovery flag makes this click soft:
    // it must not cancel the agent or mark the completed command as stopped.
    A.recoveryStopRequested = true;
    const ownStop = document.querySelector("#zs-root #zs-stop");
    if (ownStop && !ownStop.disabled) ownStop.click();
    else stopLoop({ recovery: true });
    let busy = true;
    let editorReady = false;
    let quietSince = 0;
    for (let attempt = 0; attempt < 24 && !A.stop; attempt += 1) {
      // Always make the first three stop attempts. Once provider state becomes
      // trustworthy again, repeat at a bounded cadence only while it is busy.
      // stopGeneration() only targets a native Stop control, so a disappeared
      // control is a harmless no-op and can never submit the continuation text.
      const shouldStop = attempt < 3 || (busy && attempt % 3 === 0);
      if (shouldStop) {
        diag("tool.resultReplyStopAttempt", { attempt: attempt + 1 });
        try { P.stopGeneration?.(); } catch {}
      }
      await sleep(300);
      try {
        busy =
          P.isHardGenerating?.() === true ||
          P.isGenerating?.() === true ||
          P.isBusyNow?.() === true;
      } catch {
        busy = true;
      }
      try { editorReady = !!P.getEditor?.(); } catch { editorReady = false; }
      if (!busy && editorReady) {
        if (!quietSince) quietSince = Date.now();
        // Require a stable idle composer, rather than trusting the first React
        // frame after Stop. The next step writes the existing recovery prompt.
        if (Date.now() - quietSince >= 900) {
          A.recoveryStopping = false;
          A.suppressProviderGen = false;
          ui.showStop(true);
          return true;
        }
      } else {
        quietSince = 0;
      }
    }
    const released = !busy && editorReady;
    A.recoveryStopping = false;
    if (released) A.suppressProviderGen = false;
    ui.showStop(A.running || A.toolRunning);
    return released;
  }

  async function agentLoop(base) {
    if (A.running) return;
    const workLease = await claimWorkLease();
    if (!workLease) {
      ui.toast("ViewCoder is already working in another chat.");
      return;
    }
    A.running = true;
    A.resumeArmed = false; // loop now owns the turn; drop the regenerate grace
    A.stop = false;
    A.stopping = false; // clean slate: never inherit a stale "Stopping…" from a
                        // Stop click that landed before this loop actually started
    A.awaitingReply = false;
    A.finalAnswerSettled = false;
    A.loopKey = null; // pinned by syncSessionState once this chat has an id + content
    let truncCount = 0;
    let toolFailureCount = 0;
    let unknownCommandCorrections = 0;
    let awaitingToolResultReply = false;
    let toolResultReplyNudges = 0;
    let settledFinalAnswer = false;
    const MAX_TRUNC = 6;
    // An unknown tool must never reach the bridge. Give the model one automatic
    // catalog-anchored correction turn, then pause if it invents another name;
    // this preserves the convenient self-repair without creating an unbounded
    // unknown-command loop in a long conversation.
    const MAX_UNKNOWN_COMMAND_CORRECTIONS = 1;
    // Re-send the command list after this many successful tool calls. Kept high
    // so the reminder does not bloat the context too often.
    const REMIND_TOOLS_EVERY = 20;
    ui.showStop(true);
    setInputLocked(true); // prevent user from typing while the agent is active
    ui.inputCover(true);  // keep the "Agent is working" cover up for the WHOLE loop
    diag("loop.start", { base });
    try {
      while (!A.stop) {
        let res = await waitForResponse(
          base,
          awaitingToolResultReply
            ? {
                toolResultReply: true,
                preStartTimeoutMs: TOOL_RESULT_REPLY_START_MS,
                progressTimeoutMs: TOOL_RESULT_REPLY_PROGRESS_MS,
              }
            : {},
        );
        // The completed MCP result already landed as a provider user turn, but
        // the provider either never began its assistant reply or mounted a card
        // that then made no real text/reasoning progress for 43 seconds. Re-run
        // neither the completed mutation nor its read. Release only the wedged
        // provider response and send a compact continuation nudge instead.
        if (
          ["no_start", "stalled"].includes(res.kind) &&
          awaitingToolResultReply
        ) {
          if (toolResultReplyNudges >= TOOL_RESULT_REPLY_MAX_NUDGES) {
            ui.banner(
              "warn",
              `${P.displayName} did not continue`,
              "The completed ViewCoder result was delivered, but this AI did not produce a usable next reply after eight continuation attempts. Send a short follow-up to resume; completed Studio and Blender actions were not repeated.",
            );
            break;
          }
          toolResultReplyNudges += 1;
          const attempt = toolResultReplyNudges;
          diag("tool.resultReplyNudge", {
            attempt,
            maxAttempts: TOOL_RESULT_REPLY_MAX_NUDGES,
            reason: res.kind,
          });
          ui.toast(
            `${P.displayName} ${res.kind === "stalled" ? "stopped making progress" : "did not begin replying"}. ViewCoder is continuing from the completed result (${attempt}/${TOOL_RESULT_REPLY_MAX_NUDGES})...`,
          );
          if (
            res.kind === "stalled" &&
            !(await releaseStalledProviderReply())
          ) {
            diag("tool.resultReplyStopFailed", { attempt });
            ui.banner(
              "warn",
              `${P.displayName} could not be stopped`,
              "ViewCoder detected the stalled reply but the AI did not release its composer. The completed Studio or Blender result was kept and was not repeated.",
            );
            break;
          }
          base = await submitToolResultWithRetries(
            res.kind === "stalled"
              ? "(System note: The immediately preceding ViewCoder tool result was delivered successfully. Your next assistant reply started but made no visible progress for 43 seconds and was stopped. Continue from that exact completed result. Do not repeat or re-run the completed Studio/Blender command. Any unfinished command in the interrupted reply was not dispatched; rewrite it once only if it is still the required next step, or give the final answer if the task is complete.)"
              : "(System note: The immediately preceding ViewCoder tool result was delivered successfully, but no assistant reply began. Continue now from that exact result. Do not repeat or re-run the completed Studio/Blender command. Use the result to perform only the next required step, or give the final answer if the task is complete.)",
            null,
            { requireProviderIdle: true },
          );
          continue;
        }
        if (awaitingToolResultReply) {
          awaitingToolResultReply = false;
          toolResultReplyNudges = 0;
        }
        // ChatGPT can replace the just-finished response subtree between the
        // watcher's final read and the decoration sweep. In that narrow window a
        // real command may be returned as plain text even though the live turn
        // already contains a complete tool envelope (the visible command card
        // then says "finished" but nothing executes). Re-read the live turn and
        // promote complete command envelopes. Catalog validation happens before
        // bridge dispatch below, so an unknown name becomes a red activity card
        // and a bounded correction request rather than silently becoming prose.
        const lateCommandParse =
          res.kind === "parse_error" &&
          ["luaOpener", "malformed", "unclosed", "envelope"].includes(res.reason);
        const lateLuaParse =
          lateCommandParse &&
          (
            res.reason === "luaOpener" ||
            ZSParse.LUA_START_RE.test(res.raw || "") ||
            ZSParse.toolNameFromText(res.raw || "") === "execute_luau"
          );
        if (res.kind === "text" || lateCommandParse) {
          let liveItem = null;
          let lateCalls = [];
          const attempts = lateCommandParse ? 13 : 1;
          // A long ChatGPT code block can finish in React just after the watcher
          // captured a transiently incomplete DOM. Before asking the model to
          // rewrite valid Lua/JSON, give both the original response node and the
          // current last turn a bounded 3s CodeMirror/React repaint window.
          for (let attempt = 0; attempt < attempts; attempt++) {
            if (attempt) await sleep(250);
            const candidateItems = [...new Set([res.item, P.lastAssistant()].filter(Boolean))];
            for (const candidateItem of candidateItems) {
              const providerCommand = providerCommandCalls(candidateItem);
              const liveReply = P.classifyText(candidateItem, ".zs-chip");
              const candidateCalls = providerCommand?.calls || ZSParse.parseToolCalls(liveReply);
              if (candidateCalls.length) {
                liveItem = candidateItem;
                lateCalls = candidateCalls;
                break;
              }
            }
            if (lateCalls.length) break;
          }
          if (lateCalls.length > 0) {
            diag(
              lateLuaParse
                ? "response.promotedLateLuau"
                : lateCommandParse
                  ? "response.promotedLateCommand"
                  : "response.promotedLateTool",
              {
                count: lateCalls.length,
                names: lateCalls.map((lateCall) => lateCall.tool),
              },
            );
            res = { kind: "tool", calls: lateCalls, item: liveItem };
          }
        }
        diag("response", { kind: res.kind });
        if (A.stop) break;
        if (
          (res.kind === "text" || res.kind === "empty") &&
          aiGeneratedUiEnabled() &&
          (A.expectGeneratedUi || A.awaitingNativeUiGeneration)
        ) {
          const generatedImage = A.awaitingNativeUiGeneration
            ? await waitForFinishedAssistantGeneratedImage(NATIVE_UI_GENERATION_WAIT_MS, res.item)
            : await latestAssistantGeneratedImage(1_500);
          if (A.stop) break;
          const generatedImageKey = generatedImageAnnouncementKey(generatedImage);
          if (
            generatedImage?.url &&
            !A.generatedImageAnnouncements.has(generatedImageKey)
          ) {
            const rememberedImage = rememberCapturedNativeUiImageForCurrentUserTurn(generatedImage);
            diag("generatedIconRelay.continue", {
              captureId: rememberedImage.captureId,
              source: rememberedImage.source,
            });
            base = await submitAndGetBase(
              `(System note: ViewCoder captured the one finished native-generated UI asset allowed for this user message at ${rememberedImage.url}. Do NOT upload, assemble, replace, construct, or call another tool yet. Ask the user exactly: 'The AI-generated UI image is ready. Shall I move on to upload and assemble it?' Then stop and wait for their reply. Reuse this exact URL only after the user approves. This image must represent ONE separate component on real transparent alpha with NO BACKGROUND AT ALL: all pixels outside the component must be fully transparent (alpha 0), never black, white, colored, a whole menu/screen, collage, mockup, Roblox scene, canvas, multiple buttons, or multiple interaction states. Do NOT start, request, or describe another native image generation during this user turn.)`,
            );
            continue;
          }
          if (A.awaitingNativeUiGeneration) {
            const retry = await registerNativeUiGenerationFailure(
              "This assistant turn finished without a captured native-generated PNG.",
            );
            base = await submitAndGetBase(`(System note: ${retry.instruction})`);
            continue;
          }
        }
        if (res.kind === "stopped") {
          if (
            !A.userStopped &&
            aiGeneratedUiEnabled() &&
            (A.expectGeneratedUi || A.awaitingNativeUiGeneration)
          ) {
            const generatedImage = await waitForFinishedAssistantGeneratedImage(
              NATIVE_UI_GENERATION_WAIT_MS,
              res.item,
            );
            if (A.stop) break;
            if (generatedImage?.url) {
              const rememberedImage = rememberCapturedNativeUiImageForCurrentUserTurn(generatedImage);
              base = await submitAndGetBase(
                `(System note: ViewCoder captured the one finished native-generated UI asset allowed for this user message at ${rememberedImage.url}. Do NOT upload, assemble, replace, construct, or call another tool yet. Ask the user exactly: 'The AI-generated UI image is ready. Shall I move on to upload and assemble it?' Then stop and wait for their reply. Reuse this exact URL only after the user approves. The PNG must contain only the requested component on real transparent alpha with NO BACKGROUND AT ALL; every pixel outside the component must be fully transparent (alpha 0). Do not start another native image generation during this user turn.)`,
              );
              continue;
            }
            const retry = await registerNativeUiGenerationFailure(
              String(generatedImage?.error || "").trim() ||
                "The native image attempt stopped before ViewCoder captured a usable transparent PNG.",
            );
            base = await submitAndGetBase(`(System note: ${retry.instruction})`);
            continue;
          }
          if (!A.userStopped) {
            ui.banner("warn", `${P.displayName} stopped before finishing`,
              "The agent has paused. Send a follow-up when you want to continue from the current Studio state.");
          }
          break;
        }

        if (res.kind === "context_limit") {
          ui.banner("limit", `${P.displayName} needs a fresh chat`,
            (res.detail || "") + " Open a new conversation before continuing Studio work.");
          break;
        }
        if (res.kind === "too_long") {
          ui.banner("limit", "This chat is full",
            `${P.displayName} needs a shorter conversation for dependable Studio work. Begin again in a new chat.`);
          break;
        }
        if (res.kind === "timeout") {
          ui.banner("warn", `${P.displayName} stopped responding`,
            "The agent has paused without retrying. Your Studio connection remains ready.");
          break;
        }
        if (res.kind === "interrupted") {
          ui.banner("warn", `${P.displayName} stopped responding`,
            "The AI page interrupted this work cycle. Send a follow-up to continue from the current Studio state.");
          break;
        }
        if (res.kind === "empty") {
          ui.banner("warn", `${P.displayName} stopped responding`,
            "This AI chat did not return a usable reply. Send a follow-up to continue.");
          break;
        }

        // The turn stopped with the site's "Continue" affordance.
        if (res.kind === "truncated") {
          // If the turn carries the halted marker (a stop - user OR self-halt),
          // respect it and do NOT auto-resume.
          if (P.turnHalted(res.item)) {
            diag("truncated.halted");
            if (!A.userStopped) {
              ui.banner("warn", `${P.displayName} stopped before finishing`,
                "The agent has paused. Send a follow-up to continue from the current Studio state.");
            }
            break;
          }
          // Otherwise it truncated by length → continue the SAME turn. Prefer
          // the native Continue button; fall back to a continuation message.
          if (truncCount < MAX_TRUNC) {
            truncCount++;
            if (P.clickContinueBtn() && await waitFor(() => P.isGenerating(), 2500)) {
              diag("truncated.continued");
              continue; // same turn resumes (base unchanged)
            }
            diag("truncated.sendFallback");
            ui.toast("ViewCoder is continuing the unfinished reply…");
            base = await submitAndGetBase(ZS.FEEDBACK.truncated);
            continue;
          }
          if (res.text) break; // give up resuming; keep what we have as the answer
          ui.banner("warn", "The AI could not finish this reply",
            "The response reached its length limit several times. Shorten the request or continue it in a fresh chat.");
          break;
        }
        truncCount = 0;

        if (res.kind === "parse_error") {
          // The command turn ended in a parse error - it NEVER ran. Paint its chip
          // as an error (owned, so the sweep won't repaint it the green ✓ "done" it
          // stamps on any command-shaped turn once generation ends - the misleading
          // "chip says OK, result says error" state seen live on GLM's truncated
          // execute_blender_code).
          const failName = ZSParse.toolNameFromText(res.raw || "") || "command";
          if (res.item) {
            const detail = res.reason === "unclosed" ? "reply incomplete"
              : res.reason === "luaOpener" ? "Luau wrapper missing"
              : res.reason === "envelope" ? "command format invalid"
              : "command JSON invalid";
            decorate.toolBox(res.item, failName, "err", detail, true, "", ZS.toolCategory(failName));
          }
          toolFailureCount++;
          if (toolFailureCount > 6) {
            ui.banner("warn", "ViewCoder paused this task",
              "Several command replies were invalid. Send a short follow-up to continue from the current Studio state.");
            break;
          }
          // Pass the detected command name so the feedback only offers the
          // ###LUA### block when it actually applies (execute_luau) - never for a
          // truncated/broken execute_blender_code or other JSON-only command.
          base = await submitAndGetBase(ZS.FEEDBACK.parseError(res.reason, failName));
          continue;
        }
        if (res.kind === "text") {
          // A non-empty settled reply is valid even if the provider leaves its
          // cosmetic "stopped thinking" marker on the turn. Treating that label
          // as a failure caused successful replies to enter a recovery loop.
          A.expectGeneratedUi = false;
          A.awaitingNativeUiGeneration = false;
          A.finalAnswerSettled = true;
          settledFinalAnswer = true;
          break; // genuine final answer
        }

        if (res.kind === "tool") {
          const calls = res.calls;
          if (calls.length > 1) {
            base = await submitAndGetBase(ZS.FEEDBACK.multiTool(calls.map((c) => c.tool || "?")));
            continue;
          }
          const call = calls[0];
          // Providers can temporarily remount an old assistant command while a
          // native image card replaces the active turn. Suppress that consumed
          // command and keep waiting for the new turn/image instead of pausing
          // the whole task. captureSendToken + base advancement prevents a hot
          // loop, while the off-DOM executed memory still blocks re-execution.
          if (isRememberedExecuted(res.item, P.itemText(res.item))) {
            diag("tool.consumedRemountSuppressed", {
              name: call.tool,
              turn: turnKey(res.item),
            });
            captureSendToken();
            base = Math.max(base, P.assistantCount());
            await sleep(250);
            continue;
          }
          // Validate against the CURRENT catalog before painting a running card
          // or touching the bridge. Refresh once because a server may have been
          // connected after this chat's startup prompt was injected.
          if (!A.toolNames.size || !A.toolNames.has(call.tool)) {
            await ensureTools().catch(() => []);
          }
          // An empty catalog means the bridge itself could not supply a list;
          // let runTool report that connection problem accurately instead of
          // mislabelling every otherwise-valid command as unknown.
          if (A.toolNames.size && !A.toolNames.has(call.tool)) {
            const validNames = [...A.toolNames].sort((a, b) => a.localeCompare(b));
            const feedback = ZS.FEEDBACK.unknownTool(call.tool || "command", validNames);
            const exhausted = unknownCommandCorrections >= MAX_UNKNOWN_COMMAND_CORRECTIONS;
            const detail = exhausted
              ? "Unknown command · retry limit reached"
              : "Unknown command · correcting automatically";
            const category = ZS.toolCategory(call.tool || "command");
            decorate.toolBox(
              res.item,
              call.tool || "Unknown command",
              "err",
              detail,
              true,
              feedback,
              category,
            );
            rememberActivityVisual(res.item, {
              name: call.tool || "Unknown command",
              phase: "err",
              detail,
              body: feedback,
              category,
              kind: "tool",
            });
            rememberExecuted(res.item);
            toolFailureCount++;
            diag("tool.unknown", {
              name: call.tool,
              correction: unknownCommandCorrections + 1,
              maxCorrections: MAX_UNKNOWN_COMMAND_CORRECTIONS,
              validCount: validNames.length,
              exhausted,
            });
            if (exhausted) {
              ui.banner(
                "warn",
                "ViewCoder paused this task",
                "This AI repeated an unknown command after ViewCoder supplied the live command catalog. Send a short follow-up to continue; no unknown command was sent to Studio or Blender.",
              );
              break;
            }
            unknownCommandCorrections++;
            base = await submitAndGetBase(feedback);
            continue;
          }
          unknownCommandCorrections = 0;
          // A tool ALREADY seen to return an image this session gets the "screen"
          // chip optimistically at run time (parity with the known screen_capture),
          // even though its name alone wouldn't reveal it. First-ever call of an
          // unknown image tool stays generic here and upgrades at result time below.
          const learnedImg = A.imageTools.has(bareToolName(call.tool));
          const category = learnedImg ? "screen" : ZS.toolCategory(call.tool);
          diag("tool.runCat", { name: call.tool, learnedImg, category });

          // Loading chip with the real args (loop owns this item from here).
          decorate.toolBox(res.item, call.tool, "run", argSummary(call), true, callBody(call), category);
          A.toolSettle = null; // a fresh call: no settled outcome yet
          A.toolRunning = true;
          A.toolStart = Date.now();
          A.toolName = call.tool;
          A.toolItem = res.item;
          A.toolArg = argSummary(call);
          A.toolRetrying = false;
          A.toolVisual = {
            call,
            category,
            body: callBody(call),
            count: P.assistantCount(),
            id: P.lastAssistantId ? P.lastAssistantId() : undefined,
            turnKey: turnKey(res.item),
            commandFingerprint: stableFingerprint(call),
          };
          A.toolVisual.key = rememberActivityVisual(res.item, {
            name: call.tool,
            phase: "run",
            detail: A.toolArg,
            body: A.toolVisual.body,
            category,
            kind: "tool",
          });
          // Record this turn as dispatched OFF the DOM so the auto-resume
          // watchdog never re-fires it after a scroll re-render wipes the node's
          // zloop/zResume markers (see the `executed` map).
          rememberExecuted(res.item);
          diag("tool.start", { name: call.tool });
          if (generatedUiToolNeedsFinishedImage(call)) {
            const waitDetail = "Waiting for native image (up to 3m 30s)";
            A.toolArg = waitDetail;
            A.toolVisual.body = callBody(call);
            decorate.toolBox(res.item, call.tool, "run", waitDetail, true, A.toolVisual.body, category);
            rememberActivityVisual(res.item, {
              name: call.tool,
              phase: "run",
              detail: waitDetail,
              body: A.toolVisual.body,
              category,
              kind: "tool",
            });
            await attachFinishedGeneratedImageToCall(call, res.item);
            if (A.stop) {
              A.toolRunning = false;
              if (res.item) { res.item.dataset.zStopped = "1"; rememberHalted(res.item); }
              decorate.toolBox(res.item, call.tool, "err", "stopped", true, "", category);
              rememberActivityVisual(res.item, {
                name: call.tool, phase: "err", detail: "stopped", body: "",
                category, kind: "tool",
              });
              break;
            }
          }
          const feedback = await runTool(call, res.item);
          A.toolRunning = false;
          // A provider may replace the assistant node while the MCP is running.
          // The meter reattaches A.toolItem to that fresh node; settle whichever
          // node is currently visible so the result never waits for a later sweep.
          if (A.toolItem?.isConnected) res.item = A.toolItem;
          A.toolVisual = null;
          diag("tool.done", { name: call.tool, ok: !feedback.startsWith("ERROR"), out: feedback.slice(0, 50) });
          if (A.stop) {
            // User halted mid-tool: settle the spinning chip so it doesn't look
            // stuck loading forever, and MARK the turn so the sweep classifier
            // never repaints it ✓ done once generation ends (the real cause of a
            // stopped call still going green a moment later).
            if (res.item) { res.item.dataset.zStopped = "1"; rememberHalted(res.item); }
            decorate.toolBox(res.item, call.tool, "err", "stopped", true, "", category);
            rememberActivityVisual(res.item, {
              name: call.tool, phase: "err", detail: "stopped", body: "",
              category, kind: "tool",
            });
            break;
          }
          const isErr = feedbackIsError(feedback);
          if (isErr) {
            toolFailureCount++;
          } else {
            toolFailureCount = 0;
            A.loopCrashCount = 0;
          }
          const outBody = stripOutputPrefix(feedback);
          // Trace the chip's DERIVED phase vs summary. Blender (and any MCP whose
          // output leads with a warning/diagnostic line) resolves ✓ done - the
          // payload starts "Output of…", not "ERROR" - yet outSummary shows its
          // FIRST line, which is the warning. Captures firstLine vs a later
          // success line so we can see the mismatch without guessing.
          {
            const lns = outBody.split("\n").map((l) => l.trim()).filter(Boolean);
            diag("tool.result", { name: call.tool, isErr, phase: isErr ? "err" : "done",
              summary: outSummary(feedback), lineCount: lns.length,
              firstLine: (lns[0] || "").slice(0, 90), lastLine: (lns[lns.length - 1] || "").slice(0, 90) });
          }
          // A tool (Roblox OR any custom MCP server) that actually RETURNED an
          // image becomes a "screen" chip - even if its name never let us guess.
          // Reactive, not predictive: A.pendingImages is set by runTool before it
          // returns. Remember the name so its next call is optimistic (see above).
          const hasImages = !!(A.pendingImages && A.pendingImages.length);
          if (hasImages) rememberImageTool(call.tool);
          const resultCat = hasImages ? "screen" : category;
          const imageUploadFlow = call.__viewCoderImageUpload || null;
          if (imageUploadFlow) {
            if (isErr && imageUploadFlow.phase !== "err") {
              updateImageUploadStage(call, res.item, "Image needs attention", "err", outSummary(feedback));
            } else {
              decorate.imageUpload(res.item, imageUploadFlow, true);
            }
          } else {
            decorate.toolBox(res.item, call.tool, isErr ? "err" : "done", outSummary(feedback),
              true, outBody, resultCat);
          }
          rememberActivityVisual(res.item, {
            name: call.tool,
            phase: isErr ? "err" : "done",
            detail: outSummary(feedback),
            body: outBody,
            category: resultCat,
            kind: imageUploadFlow ? "image-upload" : "tool",
            imageUpload: imageUploadFlow ? {
              stages: [...imageUploadFlow.stages],
              label: imageUploadFlow.label,
              phase: imageUploadFlow.phase,
              detail: imageUploadFlow.detail,
              assets: imageUploadFlow.assets ? [...imageUploadFlow.assets] : [],
              verified: !!imageUploadFlow.verified,
            } : null,
          });
          // Snapshot the settled outcome. If the site swaps this turn's DOM node
          // while we wait for the model's next turn (wiping the chip AND the
          // zloop ownership dataset), the sweep re-owns the fresh node with this
          // outcome instead of letting branch-3 classification re-spin a "run"
          // chip on an already-executed call.
          A.toolSettle = {
            phase: isErr ? "err" : "done", detail: outSummary(feedback),
            body: outBody, category: resultCat, count: P.assistantCount(),
            kind: imageUploadFlow ? "image-upload" : "tool",
            imageUpload: imageUploadFlow ? {
              stages: [...imageUploadFlow.stages],
              label: imageUploadFlow.label,
              phase: imageUploadFlow.phase,
              detail: imageUploadFlow.detail,
              assets: imageUploadFlow.assets ? [...imageUploadFlow.assets] : [],
              verified: !!imageUploadFlow.verified,
            } : null,
            // Node IDENTITY of the settled turn (virtualization-proof), when the
            // provider exposes it. The count guard alone misfires on Qwen: the
            // list virtualizes so assistantCount() doesn't grow for the model's
            // NEXT turn, and back-to-back calls to the SAME tool defeat the name
            // guard too - the sweep then re-owned the STREAMING next turn's chip
            // with the previous done/err outcome (seen live: 5x chip.reown with
            // gen:true, rp tiny).
            id: P.lastAssistantId ? P.lastAssistantId() : undefined,
          };
          if (isErr && toolFailureCount > 6) {
            ui.banner("warn", "ViewCoder paused this task",
              "Several Studio actions failed in succession. Send a short follow-up and ViewCoder will resume from the live place without repeating completed actions.");
            break;
          }

          // Re-inject the command list every REMIND_TOOLS_EVERY successful calls.
          // Appended UNDER the tool result and clearly marked as a reminder, so a
          // model that has drifted from the exact command names gets re-anchored
          // without it looking like a new result to act on. Errors don't count
          // (they already restate what's wrong) and list_commands is redundant.
          let toSend = feedback;
          if (A.lastModeRevisionSent !== A.modeRevision) {
            A.lastModeRevisionSent = A.modeRevision;
            toSend += "\n\n" + ZS.modeReminder(A.modes, providerCanGenerateIcons());
          }
          if (!isErr && call.tool !== "list_commands" && A.toolList.length) {
            A.toolCallsSinceReminder++;
            if (A.toolCallsSinceReminder >= REMIND_TOOLS_EVERY) {
              A.toolCallsSinceReminder = 0;
              // Keep every connected safe tool fresh in long chats so Roblox, Blender,
              // and ViewCoder workflow schemas remain equally available to every provider.
              toSend += ZS.toolsReminder(A.toolList) + "\n" + ZS.memoryNudge();
              diag("tools.reminder", { after: REMIND_TOOLS_EVERY });
            }
          }
          const images = A.pendingImages;
          A.pendingImages = null;
          diag("images.consumed", { count: images ? images.length : 0 });
          base = await submitToolResultWithRetries(toSend, images);
          // Delivery of the hidden result turn is only acknowledgement one. The
          // next loop iteration now requires acknowledgement two: an actual new
          // assistant turn must begin within 43 seconds.
          awaitingToolResultReply = true;
          toolResultReplyNudges = 0;
        }
      }
    } catch (e) {
      diag("loop.error", { msg: String((e && e.message) || e) });
      A.loopCrashCount++;
      if (e?.viewCoderSendFailure) {
        A.suppressProviderGen = true;
        try { A.stopStreamLen = P.streamLen ? P.streamLen() : 0; } catch {}
        ui.inputCover(false);
        ui.showStop(false);
        setInputLocked(false);
      }
      ui.banner("warn", "ViewCoder paused this task",
        "The AI page interrupted this work cycle. Completed Studio actions were kept; send a follow-up to continue.");
    } finally {
      A.running = false;
      A.stop = false;
      if (settledFinalAnswer) {
        // A completed prose answer is authoritative. Provider pages may leave
        // cosmetic stop/loading nodes mounted after it; suppress those stale
        // markers so they cannot resurrect ViewCoder's Working cover.
        A.finalAnswerSettled = true;
        A.suppressProviderGen = true;
        try { A.stopStreamLen = P.streamLen ? P.streamLen() : 0; } catch {}
      }
      // Keep the "Stopping…" state while the site's stream is still draining
      // after a user stop: the loop often ends BEFORE the native stop takes
      // effect (loop.end fires with gen still true - seen live on DeepSeek),
      // and clearing the flag here let the next sweep restore a clickable
      // "■ Stop" for the last beat of the dying stream (the Stopping… → Stop →
      // gone bounce). The sweep's self-heal clears it - and retries the native
      // stop - once the site is actually quiet.
      const draining = !settledFinalAnswer && A.stopping && A.started && generationForUi();
      if (A.stopping && draining) diag("stop.drain", { keptStopping: true });
      A.stopping = draining;
      A.toolRunning = false;
      A.toolRetrying = false;
      A.toolVisual = null;
      A.awaitingReply = false;
      ui.updateStartGate();
      A.toolSettle = null;
      A.loopKey = null;
      ui.showStop(false);
      // A provider can keep streaming after the command loop settles (reasoning,
      // final prose, or a delayed DOM phase). Keep the composer hidden until the
      // provider itself is genuinely idle; the shared meter below owns release.
      const providerStillActive = !settledFinalAnswer && A.started && generationForUi();
      if (!providerStillActive) {
        ui.inputCover(false);
        ui.showStop(false);
      }
      // A provider may still be streaming final prose even though this loop has
      // no more commands to run. The shared activity monitor releases the lock
      // once the provider is genuinely idle.
      setInputLocked(providerStillActive);
      diag("loop.end");
      await releaseWorkLease(workLease);
    }
  }

  // Mark the current assistant turn as user-halted so the sweep classifier shows
  // its command chip as "stopped" instead of repainting it ✓ done when
  // generation ends. Cleared on a deliberate resume (native Continue).
  //
  // The dataset marker alone is NOT enough: sites re-render the whole history
  // when the next user message lands (seen live on DeepSeek), replacing the
  // halted turn's node and wiping dataset.zStopped - and since a fresh user
  // message also clears the A.userStopped latch by design, nothing said
  // "stopped" anymore and the chip went ✓ green. So halted turns are ALSO
  // remembered here, keyed independently of the DOM node (conversation +
  // position among assistant turns + a text prefix), and the sweep re-stamps
  // the marker whenever the node was swapped.
  const TURN_MEMORY_MAX = 500;
  const trimTurnMemory = (map) => {
    while (map.size > TURN_MEMORY_MAX) {
      map.delete(map.keys().next().value);
    }
  };
  const halted = new Map(); // "conv|turnKey" → text prefix at halt time
  // Several classifiers need an assistant turn's position. Rebuilding a filtered
  // copy of the whole conversation for every turn made long chats quadratic and
  // visibly delayed both the chips and the control-bar placement.
  let assistantIndexes = new WeakMap();
  const primeAssistantIndexes = (items) => {
    const next = new WeakMap();
    let index = 0;
    for (const candidate of items || []) {
      if (P.isAssistantItem(candidate)) next.set(candidate, index++);
    }
    assistantIndexes = next;
    return next;
  };
  const assistantIdx = (item) => {
    if (!item) return -1;
    if (assistantIndexes.has(item)) return assistantIndexes.get(item);
    const refreshed = primeAssistantIndexes(P.allItems());
    return refreshed.has(item) ? refreshed.get(item) : -1;
  };
  // Virtualization-stable map key for the off-DOM executed/halted memories.
  // assistantIdx is POSITIONAL within the currently-rendered window, so on a
  // virtualized list (DeepSeek/Qwen/GLM/Arena) scrolling up renders a different
  // set of turns and an OLD command turn takes a low index that COLLIDES with a
  // current turn's key - the dedupe then misses and the watchdog re-fires the
  // scrolled-back tool. Prefer the provider's stable per-turn id when it exposes
  // one (P.itemKey); fall back to the index for non-virtualized providers.
  const turnKey = (item) => {
    if (P.itemKey) {
      const k = P.itemKey(item);
      if (k != null) return `k${k}`;
    }
    return String(assistantIdx(item));
  };
  function canonicalJson(value) {
    if (Array.isArray(value)) return value.map(canonicalJson);
    if (value && typeof value === "object") {
      const out = {};
      for (const key of Object.keys(value).sort()) {
        out[key] = canonicalJson(value[key]);
      }
      return out;
    }
    return value;
  }
  // Two independent 32-bit accumulators are sufficient for a compact, stable
  // browser-side identity without relying on async WebCrypto in the hot path.
  function stableFingerprint(value) {
    let text;
    try {
      text =
        typeof value === "string"
          ? value
          : JSON.stringify(canonicalJson(value));
    } catch {
      text = String(value);
    }
    let a = 0x811c9dc5;
    let b = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      a = Math.imul(a ^ code, 0x01000193) >>> 0;
      b = Math.imul(b ^ (code + i), 0x85ebca6b) >>> 0;
    }
    return `${a.toString(16).padStart(8, "0")}${b
      .toString(16)
      .padStart(8, "0")}`;
  }
  function commandRequestKey(item, call) {
    const conversation = P.conversationKey() || "transient";
    const turn = item ? turnKey(item) : "virtual";
    const turnText = item ? (P.itemText(item) || "") : "";
    return [
      P.id,
      stableFingerprint(conversation),
      stableFingerprint(turn),
      stableFingerprint(turnText),
      stableFingerprint(call),
    ].join(":");
  }

  // Keep the card state outside provider-owned DOM nodes. Chat sites recycle
  // or replace old turns while scrolling, and any chip/dataset attached to the
  // discarded node disappears with it. A provider turn id is preferred; when a
  // provider has none, the complete command text supplies a stable fallback.
  const activityVisuals = new Map();
  function activityVisualKey(item, text = "") {
    if (!item) return "";
    const conversation = P.conversationKey() || "transient";
    if (P.itemKey) {
      try {
        const key = P.itemKey(item);
        if (key != null && String(key)) return `${conversation}|turn:${key}`;
      } catch {}
    }
    let source = text;
    if (!source) {
      try { source = P.itemText(item) || ""; } catch { source = ""; }
    }
    if (source.trim().length < 12 || !ZSParse.hasCommandShape(source)) return "";
    return `${conversation}|command:${stableFingerprint(source)}`;
  }
  function rememberActivityVisual(item, visual, text = "") {
    const key = activityVisualKey(item, text);
    if (!key || !visual) return "";
    activityVisuals.delete(key);
    activityVisuals.set(key, { ...visual, key });
    trimTurnMemory(activityVisuals);
    return key;
  }
  function rememberedActivityVisual(item, text = "") {
    const key = activityVisualKey(item, text);
    return key ? activityVisuals.get(key) || null : null;
  }
  function commandFingerprintForItem(item) {
    if (!item) return "";
    try {
      const providerCommand = providerCommandCalls(item);
      const calls = providerCommand?.calls || ZSParse.parseToolCalls(P.itemText(item) || "");
      return calls.length === 1 ? stableFingerprint(calls[0]) : "";
    } catch {
      return "";
    }
  }
  function rememberHalted(item) {
    try {
      if (!item || assistantIdx(item) < 0) return;
      const pref = (P.itemText(item) || "").slice(0, 60);
      // A stop during the REASONING phase leaves the answer text EMPTY - an
      // empty/short prefix would then startsWith-match ANY later turn at this
      // index (seen live: a fresh streaming command went red "stopped" on the
      // spot). Too little text to identify → rely on the dataset marker only.
      if (pref.trim().length < 12) return;
      halted.set(`${P.conversationKey()}|${turnKey(item)}`, pref);
      trimTurnMemory(halted);
    } catch {}
  }
  function forgetHalted(item) {
    if (!item || !halted.size) return;
    try { halted.delete(`${P.conversationKey()}|${turnKey(item)}`); } catch {}
  }
  // The halt was recorded MID-stream, so the stored text is a PREFIX of the
  // turn's final text - match on startsWith, never equality.
  function isRememberedHalted(item, txt) {
    if (!halted.size) return false;
    try {
      const pref = halted.get(`${P.conversationKey()}|${turnKey(item)}`);
      return pref != null && (txt || "").startsWith(pref);
    } catch { return false; }
  }
  function markStoppedTurn() {
    const it = P.lastAssistant();
    if (!it) return;
    it.dataset.zStopped = "1";
    rememberHalted(it);
  }

  // Off-DOM record of assistant turns whose command has ALREADY been dispatched
  // (by the normal loop OR the auto-resume watchdog). The dataset markers that
  // dedupe re-execution (zResume / zloop) live on the DOM NODE - but sites
  // virtualize long conversations, so scrolling up DESTROYS and RECREATES a
  // turn's node, wiping those markers. The fresh node then looks un-run, and the
  // watchdog can re-fire the turn's tool with no live generation at all (the
  // "tools execute when I scroll back" bug). Mirror the `halted` map exactly
  // (keyed by conversation + assistant index + a text prefix, NOT the node) so
  // the "already ran this" memory survives node recreation. This makes
  // re-execution IDEMPOTENT regardless of any isGenerating/lastGenAt heuristic
  // misfire - the hard part (is this a live turn?) can be wrong without harm.
  const executed = new Map(); // "conv|turnKey" → text prefix at dispatch time
  function rememberExecuted(item) {
    if (!item) return;
    try {
      if (assistantIdx(item) < 0) return;
      const pref = (P.itemText(item) || "").slice(0, 60);
      // Same guard as rememberHalted: too little text to identify the turn (a
      // command still streaming) would startsWith-match any later turn at this
      // index. Fall back to the dataset marker until there is enough text.
      if (pref.trim().length < 12) return;
      executed.set(`${P.conversationKey()}|${turnKey(item)}`, pref);
      trimTurnMemory(executed);
    } catch {}
  }
  function isRememberedExecuted(item, txt) {
    if (!executed.size) return false;
    try {
      const pref = executed.get(`${P.conversationKey()}|${turnKey(item)}`);
      return pref != null && (txt || "").startsWith(pref);
    } catch { return false; }
  }
  function armStopRetries() {
    const generation = ++A.stopRetryGen;
    for (const delay of [180, 500, 1000, 1800, 3000, 4800]) {
      setTimeout(() => {
        if (generation !== A.stopRetryGen || !A.stopping) return;
        let hardGenerating = false;
        try {
          hardGenerating = P.isHardGenerating
            ? !!P.isHardGenerating()
            : !!P.isGenerating();
        } catch {}
        const streamGrew = (P.streamLen ? P.streamLen() : 0) >
          (A.stopStreamLen || 0) + 8;
        if (!hardGenerating && !streamGrew) return;
        A.stopStreamLen = P.streamLen ? P.streamLen() : A.stopStreamLen;
        try { P.stopGeneration(); } catch {}
        diag("stop.retry.timer", { delay, hardGenerating, streamGrew });
      }, delay);
    }
  }

  function stopLoop(options = {}) {
    const recovery = options.recovery === true || A.recoveryStopRequested === true;
    A.recoveryStopRequested = false;
    if (recovery) {
      // Mirror the useful parts of the user's ViewCoder Stop click without
      // setting A.stop/userStopped or cancelling the bridge job. The watchdog
      // still owns the task and will auto-submit its continuation after the
      // provider exposes a stable idle composer.
      diag("stopLoop.recovery");
      A.recoveryStopping = true;
      A.stopAt = Date.now();
      A.stopStreamLen = P.streamLen ? P.streamLen() : 0;
      A.injectHideUntil = 0;
      A.suppressProviderGen = true;
      ui.markStopping();
      ui.inputCover(false);
      setInputLocked(false);
      try { P.stopGeneration(); } catch {}
      return;
    }
    if (A.stopping) {
      try { P.stopGeneration(); } catch {}
      armStopRetries();
      void bg({ type: "cancel_keyboard_input" }).catch(() => {});
      return;
    }
    const hadLocalWork = !!(
      A.running || A.starting || A.injecting || A.awaitingReply || A.toolRunning
    );
    diag("stopLoop", { hadLocalWork });
    A.stop = true;
    A.stopping = true;
    A.stopAt = Date.now(); // grace anchor for the regenerate-as-resume gates
    // Baseline for the stop-retry growth gate (see the self-heal in the meter
    // loop): a retry is only allowed if the reply keeps growing PAST this,
    // proving the first stop click was swallowed. Without it, retries clicked a
    // wedged (already-stopped) stop button and Gemini killed the NEXT turn.
    A.stopStreamLen = P.streamLen ? P.streamLen() : 0;
    A.suppressProviderGen = true;
    A.userStopped = true; // suppress auto-resume until the next user message
    A.resumeArmed = false; // a stop overrides any pending regenerate grace
    // Cancel any remaining guarded keyboard steps in the local bridge. If an
    // action already completed, the bridge preserves it and only releases held
    // keys; it never guesses an inverse action.
    void bg({ type: "cancel_keyboard_input" }).catch(() => {});
    // Disarm any pending optimistic pre-hide (armed in submitAndGetBase for the
    // feedback turn we just sent - see the re-arm note there). The input unlocks
    // right after this function returns, but the window can still be open for a
    // couple more seconds (e.g. mid-image-upload); without this, a message the
    // user types fast right after Stop could be the "next new user turn" the
    // window masks by mistake, instead of the (now abandoned) feedback turn.
    A.injectHideUntil = 0;
    markStoppedTurn();
    // A tool's loading chip is only settled AFTER its `await runTool()` resolves
    // (the if(A.stop) branch in agentLoop). A long-running call (e.g. a big
    // multi_edit) leaves that await pending, so the chip would keep spinning for
    // seconds after the user pressed Stop. Settle it to the stopped state right
    // now; the loop's own settle on resolve is idempotent.
    if (A.toolRunning && A.toolItem) {
      A.toolItem.dataset.zStopped = "1";
      rememberHalted(A.toolItem);
      decorate.toolBox(A.toolItem, A.toolName, "err", "stopped", true, "", ZS.toolCategory(A.toolName));
    }
    ui.markStopping();    // instant feedback: button → "⏳ Stopping…", disabled
    try { P.stopGeneration(); } catch {}
    armStopRetries();
    ui.toast("Stopping…");
    // If only a stale website loading marker kept the bar active, no local loop
    // remains to run a finally block. Forward Stop to the site, then release the
    // ViewCoder UI immediately instead of leaving an unresponsive Stop button.
    if (!hadLocalWork) {
      A.stopping = false;
      ui.inputCover(false);
      setInputLocked(false);
      ui.showStop(false);
      diag("stop.idleReleased");
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SESSION BOOTSTRAP  ("Starting Up" animated chip, shown in the conversation)
  // ════════════════════════════════════════════════════════════════════════
  async function startSession() {
    if (A.running || A.starting) return;
    // "Start session" is allowed ONLY on a blank conversation. Opening an
    // EXISTING conversation must never trigger the bootstrap.
    if (!P.chatIsEmpty() && !A.started) {
      ui.toast("Open a new, empty conversation to start a session.");
      return;
    }
    A.starting = true;
    ui.setStarting(true);
    ui.updateStartGate();
    const workLease = await claimWorkLease();
    if (!workLease) {
      A.starting = false;
      ui.setStarting(false);
      ui.toast("ViewCoder is already working in another chat.");
      return;
    }
    A.userStopped = false;
    A.userIntentAt = 0;
    A.userIntentKey = null;
    A.stop = false;               // clear any halt left by a prior aborted bootstrap
    // Snapshot any turn already on screen at session start (normally none on a
    // clean new chat; on a reload-restored generation it's the stray turn). The
    // auto-resume watchdog refuses to run a tool from this baseline turn so a
    // restored execute_luau can't leak into the freshly started conversation.
    A.bootBaselineId = P.lastAssistantId ? P.lastAssistantId() : null;
    A.starting = true;
    const myGen = ++A.startGen;   // identity of THIS bootstrap
    A.startingKey = null;          // unknown until the conversation gets an id
    const alive = () => A.startGen === myGen; // false once superseded/aborted
    A.toolCallsSinceReminder = 0; // fresh reminder cadence for the new session
    ui.setStarting(true);
    ui.updateStartGate(); // refresh the bar into its "starting" state
    setInputLocked(true); // block user input during bootstrap
    ui.inputCover(true, "connecting"); // whole composer: "ViewCoder Is Connecting..."
    try {
      await modesReady;
      await ensureTools();
      if (!alive()) return;
      if (!A.toolList.length) {
        ui.banner("warn", "Studio connection unavailable",
          "ViewCoder could not load Studio actions. Launch start.bat, open Roblox Studio, and try once more.");
        return;
      }
      // Build the exact live command reference locally and place it directly in
      // the bootstrap prompt. The old flow made every provider spend one whole
      // extra model turn asking `list_commands`, then another turn acknowledging
      // its result. Supplying the same validated reference up front cuts startup
      // latency and removes a common place for providers to stall or duplicate
      // the hidden bootstrap exchange.
      const toolReference = await runTool(
        { tool: "list_commands", arguments: { server: "all" } },
        null,
      );
      if (/Roblox Studio is currently OFFLINE|No commands available/.test(toolReference)) {
        ui.banner(
          "warn",
          "Studio connection unavailable",
          "Open your place, enable Studio as an MCP server, and let ViewCoder reconnect before starting.",
        );
        return;
      }
      const modeState = await P.ensureComposerReady("startup");
      if (!alive()) return;
      if (!modeState.ready) {
        ui.banner("warn", `${P.displayName} mode not ready`,
          `Could not switch ${P.displayName} to the required mode. Start a new chat or reload the page, then try again.`);
        return;
      }
      const promptOptions = {
        siteName: P.displayName,
        customPrompt: ui.getCustomPrompt(),
        toolReference,
        marker: ZS.SYS_MARKER,
        modeState: A.modes,
        nativeImageGeneration: providerCanGenerateIcons(),
      };
      // Most providers accept the shared bootstrap wording. Claude deliberately
      // distinguishes native tools from instructions delivered in an ordinary
      // user message, so its adapter supplies an honest user-workflow handshake
      // instead of pretending the local bridge is part of Claude's own toolset.
      // Keeping the hook provider-owned avoids changing the established prompt
      // or behavior of every other supported site.
      const prompt = typeof P.buildStartupPrompt === "function"
        ? P.buildStartupPrompt(promptOptions)
        : ZS.buildSystemPrompt(promptOptions);
      const base = await submitAndGetBase(prompt);
      if (!alive()) return;
      // (syncSessionState pins A.startingKey to the conversation id once the chat
      // has content, and aborts this bootstrap if the user opens a new empty chat.)
      decorate.sweep(); // show the animated "Starting Up" chip immediately
      // Startup acknowledgements are short. Some providers leave their native
      // generating flag stuck on after the visible reply is already complete;
      // finalize a stable startup reply quickly so Ready and Working cannot
      // remain visible at the same time.
      const startRes = await waitForResponse(base, { stableMs: 1800 });
      if (!alive()) return;
      // The user halted the bootstrap (our Stop or the site's native stop). Do
      // NOT declare the session ready - abort quietly so "Start" stays available.
      if (A.stop || startRes.kind === "stopped") { diag("start.aborted", { kind: startRes.kind }); return; }

      // If the model calls list_commands as instructed, run it and wait for the "ready" reply.
      const firstName = startRes.calls && startRes.calls[0] && startRes.calls[0].tool;
      if (startRes.kind === "tool" && startRes.calls && startRes.calls.length === 1 &&
          (firstName === "list_commands" || firstName === "list_tools")) {
        decorate.toolBox(startRes.item, "Syncing Studio tools", "run", "", true);
        const toolFeedback = await runTool(startRes.calls[0], startRes.item);
        // Roblox down short-circuits list_commands into a plain "offline" note
        // (main.js, list_commands handler) instead of the real catalogue - detect
        // that and show it as such, rather than the STALE cached tool count below
        // (the bridge keeps advertising Roblox's catalogue even with no Studio
        // attached, so A.toolList still has 25+ entries that were never actually
        // usable this boot).
        if (/Roblox Studio is currently OFFLINE/.test(toolFeedback)) {
          decorate.toolBox(startRes.item, "Syncing Studio tools", "err", "Studio connection unavailable", true);
        } else {
          // Count what the model ACTUALLY received: list_commands is scoped to the
          // primary Roblox server (main.js ~629), so showing A.toolList.length (every
          // connected server merged - Roblox + Blender + addons) overstated the boot
          // count and made it look like all servers were loaded at once. Count the
          // Roblox-scoped tools instead, matching the real result.
          const robloxCount = A.toolList.filter((t) => (t.server || "roblox") === "roblox").length;
          decorate.toolBox(startRes.item, "Syncing Studio tools", "done", `${robloxCount} actions available`, true);
        }
        const base2 = await submitAndGetBase(toolFeedback);
        const readyRes = await waitForResponse(base2, { stableMs: 1800 }); // wait for "I'm ready" reply
        if (!alive()) return;
        if (A.stop || readyRes.kind === "stopped") { diag("start.aborted", { kind: readyRes.kind }); return; }
      }
      // Remember the settled readiness turn so provider observers cannot
      // mistake it for a new task after the startup flags are released.
      try {
        A.startupReplyItem = P.lastAssistant ? P.lastAssistant() : null;
        A.startupReplyId = P.lastAssistantId ? P.lastAssistantId() : null;
      } catch {
        A.startupReplyItem = null;
        A.startupReplyId = null;
      }
      A.started = true;
      rememberSession(P.conversationKey()); // survives virtualization AND reloads
      ui.setStarted(true);
      ui.toast(`${P.displayName} can now work with your open Studio place.`);
    } catch (e) {
      if (alive()) ui.banner("warn", "ViewCoder could not begin", String((e && e.message) || e));
    } finally {
      // Only tear down our OWN starting state. If we were superseded (the user
      // opened another chat), the newer flow / syncSessionState owns it now.
      if (alive()) {
        A.starting = false;
        A.startingKey = null;
        ui.setStarting(false);
        ui.inputCover(false); // lift the Starting Up composer cover
        setInputLocked(A.started && generationForUi());
        decorate.sweep();
      }
      await releaseWorkLease(workLease);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SVG ICON SET  (stroke = currentColor, inherits the chip's theme colour)
  // ════════════════════════════════════════════════════════════════════════
  const SVG = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const ICONS = {
    screen:  SVG('<path d="M4 5h16v12H4z"/><path d="m8 21 4-4 4 4"/>'),
    roblox:  SVG('<path d="m7 4 13 3-3 13-13-3z"/><path d="m10 9 5 1-1 5-5-1z"/>'),
    read:    SVG('<path d="M4 6h10a4 4 0 0 1 4 4v8H8a4 4 0 0 1-4-4z"/><path d="M8 10h6M8 14h4"/>'),
    edit:    SVG('<path d="M5 19h4l10-10-4-4L5 15z"/><path d="m13 7 4 4"/>'),
    generate: SVG('<path d="m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4z"/><path d="m19 16 .6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6z"/>'),
    tool:    SVG('<path d="M5 7h14M7 12h10M9 17h6"/><circle cx="8" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="11" cy="17" r="2"/>'),
    result:  SVG('<path d="M5 12h13"/><polyline points="13 7 18 12 13 17"/><path d="M5 5v14"/>'),
    check:   SVG('<path d="m5 12 4 4L19 6"/><path d="M4 4h16v16H4z"/>'),
    error:   SVG('<path d="M5 5h14v14H5z"/><path d="m9 9 6 6m0-6-6 6"/>'),
    system:  SVG('<path d="M5 8h14M5 16h14"/><path d="m8 5-3 3 3 3m8 2 3 3-3 3"/>'),
  };
  const SPIN = '<span class="zs-pulse-mark"><i></i><i></i><i></i></span>';

  function visibleActionLabel(name, phase) {
    const raw = String(name || "Studio action").trim();
    const pretty = raw.includes("_")
      ? raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      : raw;
    if (phase === "run") return `${pretty} is working`;
    if (phase === "done" || phase === "result") return `${pretty} finished`;
    if (phase === "err") return `${pretty} could not continue`;
    if (phase === "idle") return `${pretty} is queued`;
    return pretty;
  }

  function iconFor(category, phase) {
    if (phase === "run") return SPIN;
    if (phase === "err") return "";
    if (phase === "done") return ICONS.check;
    if (phase === "result") return ICONS.result;
    if (phase === "sys") return ICONS.system;
    return ICONS[category] || ICONS.tool;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CAMOUFLAGE / DECORATION  (chips are real "tool cards": header + an
  //  expandable body, themed by tool category and execution state)
  // ════════════════════════════════════════════════════════════════════════

  // Strip every trace of our decoration from a node. Needed because sites
  // virtualize (recycle) turn nodes: a node that was a command/result card can
  // be reused to render unrelated text.
  function resetDecoration(item) {
    try { P.clearCommandMask?.(item); } catch {}
    const chip = item.querySelector(".zs-chip");
    if (chip) chip.remove();
    item.classList.remove("zs-hidden", "zs-plain-command-mask", "zs-lua-command-mask", "zs-command-mask");
    item.querySelectorAll(".zs-tool-hide").forEach((e) => e.classList.remove("zs-tool-hide"));
    item.querySelectorAll(".zs-cmd-mask").forEach((e) => e.classList.remove("zs-cmd-mask"));
    item.querySelectorAll(".zs-plain-command-mask").forEach((e) => e.classList.remove("zs-plain-command-mask"));
    delete item.dataset.zs;
    delete item.dataset.zsig;
    delete item.dataset.zphase;
    delete item.dataset.zStopped;
    delete item.dataset.zRegenLen;
    delete item.dataset.zRegenAt;
    delete item.dataset.zLuaUnreadableAt;
    delete item.__zsChip;
  }

  const decorate = {
    // Core renderer. opts: {label, detail, body, category, phase, cls, whole}
    chip(item, opts) {
      const { label, detail = "", body = "", category = "tool", phase, cls, whole } = opts;
      const existingChips = [...item.querySelectorAll(".zs-chip")];
      let chip = existingChips.shift() || null;
      // Provider subtree reconciliation can briefly clone a whole hidden result
      // card before the next sweep changes "Preparing" to "Shared". Keep the
      // one-card-per-turn invariant instead of leaving both phases visible.
      existingChips.forEach((duplicate) => duplicate.remove());
      const hasBody = !!body;
      // While a command streams, the site re-renders the raw block on every token
      // and we get called on nearly every sweep. If what we'd draw is identical,
      // we must NOT rebuild the chip's innerHTML: doing so re-creates the
      // <span class="zs-spin"> and restarts its CSS animation each time, so the
      // spinner looks frozen / stutters ("retry en rafale"). Rebuild the inner
      // markup ONLY when the rendered content actually changes; otherwise reuse
      // the existing element (and keep its expand/collapse state) so the spinner
      // keeps spinning smoothly. Re-anchoring + masking below still run each pass.
      const sig = `${category}|${phase}|${cls || ""}|${whole ? 1 : 0}|${label}|${detail}|${hasBody ? body.length : 0}`;
      if (!chip) chip = document.createElement("div");
      if (chip.dataset.csig !== sig) {
        chip.dataset.csig = sig;
        chip.className = `zs-chip cat-${category} ${cls || ""}`;
        chip.innerHTML =
          `<div class="zs-chip-head">` +
            `<span class="zs-chip-ic">${iconFor(category, phase)}</span>` +
            `<span class="zs-chip-tx"></span>` +
            `<span class="zs-chip-dt"></span>` +
            (hasBody ? `<span class="zs-chip-cv">${SVG('<polyline points="6 9 12 15 18 9"/>')}</span>` : "") +
          `</div>` +
          (hasBody ? `<div class="zs-chip-body"><pre></pre></div>` : "");
        chip.querySelector(".zs-chip-tx").textContent = label;
        if (detail) chip.querySelector(".zs-chip-dt").textContent = detail;
        if (hasBody) {
          chip.querySelector(".zs-chip-body pre").textContent = body;
          const head = chip.querySelector(".zs-chip-head");
          head.style.cursor = "pointer";
          head.onclick = () => chip.classList.toggle("open");
        }
      }

      if (whole) {
        // Fully injected turn (result / sys) → hide the whole item.
        if (chip.parentElement !== item) item.insertBefore(chip, item.firstChild);
        item.classList.add("zs-hidden");
      } else {
        item.classList.remove("zs-hidden");
        // findToolBlockSpot ALSO applies the .zs-tool-hide classes (its real job);
        // we call it for that even when we don't use its returned position.
        const spot = P.findToolBlockSpot(item, chip);
        if (P.chipAtItemLevel) {
          // Site re-renders the turn's content subtree (Angular/Gemini), which
          // wipes any chip placed INSIDE it. Anchor the chip at the turn-element
          // level instead, where it survives those re-renders; the hide classes
          // (re-applied by the sweep) handle masking the raw block.
          // A provider may supply chipAnchor(item) to redirect the chip into a
          // descendant (e.g. Kimi's turn is a flex ROW [avatar | content];
          // inserting at item.firstChild would make the chip the avatar's flex
          // sibling and shove the layout sideways, so it anchors in the content
          // column instead). Default: the turn root.
          const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
          // Default: pin the chip as the FIRST child - simple and immune to the
          // site re-appending fresh content later. A provider may opt into
          // `chipAppend` to place it LAST instead (reads in the model's actual
          // order: narration, then the tool call it wrote at the end of the
          // turn). `chipTrailRef(item)` lets it name a fixed trailing sibling
          // (e.g. Qwen's action-buttons row) the chip must stay BEFORE even
          // when "last" - see ensureOwnedChip's drift check for why this needs
          // upkeep that firstChild pinning never did.
          const wantLast = !!P.chipAppend;
          const trailRef = wantLast && P.chipTrailRef ? P.chipTrailRef(item) : null;
          const inPlace = chip.parentElement === anchor &&
            (wantLast ? chip.nextElementSibling === trailRef : anchor.firstElementChild === chip);
          if (!inPlace) {
            if (wantLast) anchor.insertBefore(chip, trailRef); // trailRef=null -> append
            else anchor.insertBefore(chip, anchor.firstChild);
          }
        } else if (spot) {
          spot.parent.insertBefore(chip, spot.ref);
        } else if (!chip.parentElement) {
          item.insertBefore(chip, item.firstChild);
        }
      }
      item.dataset.zs = cls || "1";
      // Remember the exact opts so a chip wiped by a site re-render can be
      // rebuilt identically (see ensureOwnedChip / the chipGone guards).
      item.__zsChip = { ...opts };
      return chip;
    },

    // Re-apply a loop-owned chip after a site re-render wiped it (chip removed
    // and/or the .zs-tool-hide classes stripped). The loop owns the label/phase,
    // so we rebuild from the stored opts rather than re-running classification.
    ensureOwnedChip(item) {
      const opts = item.__zsChip;
      if (!opts) return;
      const chipEl = item.querySelector(".zs-chip");
      const chipGone = !chipEl;
      let rawVisible = false;
      if (!opts.whole) {
        // NOTE the thinking exclusion: reasoning models QUOTE the command
        // JSON/###LUA### in their think area, which the camouflage never hides
        // (by design) - counting those as "raw block visible" made this
        // rebuild fire on EVERY sweep forever (60Hz spam, seen live).
        rawVisible = [...item.querySelectorAll("pre, p, [class*='code'], .cm-line")].some(
          (e) => !e.closest(".zs-tool-hide") && !e.closest(".zs-chip") &&
                 !(P.thinkingSel && e.closest(P.thinkingSel)) &&
                 // Some sites (Arena) wrap a code block in a bare outer <pre>
                 // that has no hide class of its own - the real content (and
                 // the .zs-tool-hide class) live on a child wrapper instead.
                 // closest() only checks ancestors, so without this the outer
                 // <pre> reads as "raw command visible" FOREVER (its own
                 // textContent includes the hidden child's text), causing an
                 // infinite rebuild loop (~60/s, seen live on Arena).
                 !e.querySelector(".zs-tool-hide") &&
                 ZSParse.hasCommandShape(e.textContent || ""));
      }
      // A provider opted into `chipAppend` (chip trails the reply text instead
      // of pinning first) has no equivalent of firstChild's immunity to churn:
      // a site re-render can re-append fresh reply content AFTER our chip,
      // silently shoving it back above the text it was meant to trail. Catch
      // that drift too, not just an outright wipe - it's cheap (one property
      // read) and only applies to opted-in providers (Qwen).
      let drifted = false;
      if (!opts.whole && !chipGone && P.chipAtItemLevel && P.chipAppend) {
        const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
        const trailRef = P.chipTrailRef ? P.chipTrailRef(item) : null;
        drifted = chipEl.parentElement === anchor && chipEl.nextElementSibling !== trailRef;
      }
      if (chipGone || rawVisible || drifted) {
        // Tracker: the site wiped a loop-owned chip (re-render/node churn).
        diag("chip.rebuild", { name: opts.label, phase: opts.phase, chipGone, rawVisible, drifted });
        this.chip(item, opts);
      }
    },

    // owned=true → the agentic loop manages this item; the observer backs off.
    toolBox(item, name, phase, detail, owned, body, category) {
      if (!item) return;
      // Tracker: every phase TRANSITION of a command chip, with who drove it.
      // "loop" = the agentic loop (authoritative), "sweep" = DOM classification.
      if (item.dataset.zphase !== phase) {
        diag("chip.phase", {
          name, from: item.dataset.zphase || "(new)", to: phase,
          by: owned ? "loop" : "sweep", detail: detail || "",
        });
      }
      const cls = phase === "run" ? "run" : phase === "err" ? "err" : phase === "idle" ? "idle" : "done";
      this.chip(item, {
        label: visibleActionLabel(name, phase), detail: detail || "", body: body || "",
        category: category || ZS.toolCategory(name), phase, cls,
      });
      item.dataset.zphase = phase;
      if (owned) item.dataset.zloop = "1";
    },

    imageUpload(item, flow, owned) {
      if (!item || !flow) return;
      const stages = Array.isArray(flow.stages) ? flow.stages : [];
      const last = Math.max(0, stages.length - 1);
      const body = stages.map((stage, index) => {
        if (flow.phase === "done" || index < last) return `✓ ${stage}`;
        if (flow.phase === "err" && index === last) return `× ${stage}`;
        return `• ${stage}`;
      }).join("\n");
      const phase = flow.phase === "err" ? "err" : flow.phase === "done" ? "done" : "run";
      this.chip(item, {
        label: flow.label || "Preparing image",
        detail: flow.detail || "",
        body,
        category: "screen",
        phase,
        cls: phase === "err" ? "err" : phase === "done" ? "done" : "run",
      });
      item.dataset.zphase = phase;
      if (owned) item.dataset.zloop = "1";
    },

    classify(item, next, lastAssistant, generating, lastUser) {
      if (item.dataset.zloop) { this.ensureOwnedChip(item); return; } // loop owns it
      const txt = P.classifyText(item, ".zs-chip"); // excludes thinking AND our chip
      const textHasCommandShape = P.isAssistantItem(item) && ZSParse.hasCommandShape(txt);
      let renderedProviderCommand = null;
      // Provider toolbars and syntax highlighters can pollute or omit the combined
      // turn text while leaving a clean rendered command block behind. Probe that
      // block for every provider when there is useful command-like DOM evidence.
      // This is intentionally bounded to assistant turns with code UI so ordinary
      // prose turns keep the sweep cheap even in very long conversations.
      if (
        P.isAssistantItem(item) &&
        !textHasCommandShape &&
        (
          item === lastAssistant ||
          item.dataset.zphase ||
          item.querySelector("pre, [class*='code'], .cm-editor, .cm-content")
        )
      ) {
        renderedProviderCommand = providerCommandCalls(item);
      }
      const hasRenderableCommand = textHasCommandShape || !!renderedProviderCommand;
      const renderedCommandName =
        renderedProviderCommand?.calls?.[0]?.tool ||
        ZSParse.toolNameFromText(txt) ||
        "command";
      const commandEvidenceText = renderedProviderCommand?.text || txt;

      // A virtual list can replace the entire turn node, removing the chip,
      // zloop ownership and every dataset flag together. Restore the exact
      // off-DOM card state before ordinary classification gets a chance to
      // reinterpret a completed command as running (or expose its raw JSON).
      const rememberedVisual = P.isAssistantItem(item)
        ? rememberedActivityVisual(item, commandEvidenceText)
        : null;
      const rememberedLiveRun = !!(
        rememberedVisual?.phase === "run" &&
        A.toolRunning &&
        A.toolVisual &&
        (
          rememberedVisual.key === A.toolVisual.key ||
          (A.toolVisual.turnKey && turnKey(item) === A.toolVisual.turnKey)
        )
      );
      if (rememberedVisual && (hasRenderableCommand || rememberedLiveRun)) {
        if (rememberedVisual.kind === "image-upload" && rememberedVisual.imageUpload) {
          this.imageUpload(item, rememberedVisual.imageUpload, true);
        } else {
          this.toolBox(
            item,
            rememberedVisual.name,
            rememberedVisual.phase,
            rememberedVisual.detail,
            true,
            rememberedVisual.body,
            rememberedVisual.category,
          );
        }
        diag("chip.restore", {
          name: rememberedVisual.name,
          phase: rememberedVisual.phase,
        });
        return;
      }

      // NOTE on the "needs re-apply" guards below: some sites (Gemini/Angular)
      // re-render a turn's CHILDREN on every update - our chip and the
      // .zs-tool-hide classes are wiped while the dataset flags on the turn
      // element itself survive. So "already decorated" must always be
      // double-checked against the chip actually being present in the DOM.
      const chipGone = !item.querySelector(".zs-chip");

      // 1. System-prompt bootstrap turn → animated while starting, gear when done.
      if (hasSystemMarker(txt)) {
        const phase = A.starting ? "run" : "sys";
        if (item.dataset.zs !== "sys" || item.dataset.zphase !== phase || chipGone) {
          this.chip(item, { label: "Getting ViewCoder ready", category: "tool", phase, cls: "sys", whole: true });
          item.dataset.zphase = phase;
        }
        return;
      }

      // 2. Injected result / ERROR / note turns. ALWAYS a user turn we sent,
      //    keyed off our fixed output shapes (never command keywords).
      if (P.isUserItem(item) && ZSParse.isInjectedFeedback(txt)) {
        const isRecovery = /^\s*\(System note:\s*ViewCoder recovery\)/i.test(txt);
        if (isRecovery) {
          // Older chats may still contain hidden recovery prompts from a prior
          // build. Keep those internal messages hidden, but never render a card.
          const oldChip = item.querySelector(".zs-chip");
          if (oldChip) oldChip.remove();
          item.classList.add("zs-hidden");
          item.classList.remove("zs-recovery-duplicate");
          item.dataset.zsig = "recovery|removed";
          return;
        }
        const isAutoAttachment = /\(System note:\s*ViewCoder attachment\)/i.test(txt);
        if (isAutoAttachment) {
          const isCurrent = lastUser === item && (A.injecting || generating);
          const phase = isCurrent ? "run" : "result";
          const sig = `attachment|${phase}`;
          if (item.dataset.zsig !== sig || !item.classList.contains("zs-hidden") || chipGone) {
            this.chip(item, {
              label: isCurrent ? "Preparing visual context" : "Visual context shared",
              category: "screen", phase, cls: "result", whole: true,
            });
            item.dataset.zsig = sig;
          }
          return;
        }
        const m = txt.match(/Output of '([^']+)'/);
        const isErr = /^\s*ERROR\b/.test(txt);
        // Reload-proof image detection: a feedback carrying an image ends with the
        // IMAGE_FEEDBACK_RE marker. Learn the tool (persisted) so its command turn
        // above AND its next call get the "screen" chip even with no loop running.
        const hasImg = !isErr && IMAGE_FEEDBACK_RE.test(txt);
        if (hasImg && m) rememberImageTool(m[1]);
        const sig = (m ? m[1] : "note") + "|" + (isErr ? "err" : hasImg ? "img" : "result");
        if (item.dataset.zsig !== sig || !item.classList.contains("zs-hidden") || chipGone) {
          this.chip(item, {
            label: m ? `${m[1]} · response` : "ViewCoder response",
            category: hasImg ? "screen" : m ? ZS.toolCategory(m[1]) : "tool",
            body: txt, phase: isErr ? "err" : "result",
            cls: isErr ? "err" : "result", whole: true,
          });
          item.dataset.zsig = sig;
        }
        return;
      }

      // 2b. FALLBACK for a command turn whose raw tool-call text is no longer
      // readable (e.g. Qwen disposes/never fully renders an off-screen Monaco
      // code block on a COLD page load - the dataset.zsCode cache only helps
      // WITHIN a session, since it needs to observe the block live to capture
      // it before disposal; reported live: every past tool-call chip vanished
      // after a page reload, leaving only its "· result" box). The turn's own
      // text no longer "looks like" a command, but the VERY NEXT turn being
      // our injected result (`Output of 'name'`) is definitive proof it WAS
      // one - settle it from that evidence instead of leaving the chip gone.
      if (P.isAssistantItem(item) && !hasRenderableCommand &&
          next && P.isUserItem(next)) {
        const nt = P.classifyText(next, ".zs-chip");
        const m = nt.match(/^\s*Output of '([^']+)'/);
        if (m) {
          // A connected MCP server may return a failed operation as an ordinary
          // result body (for example "Tool execution failed: ...") rather
          // than using ViewCoder's ERROR wrapper. Use the same shared classifier as
          // the live loop so re-rendered and restored cards cannot flip green.
          const isErr = feedbackIsError(nt);
          const phase = isErr ? "err" : "done";
          if (item.dataset.zphase !== phase || chipGone) {
            this.toolBox(item, m[1], phase, "", false);
          }
          return;
        }
      }

      // 3. Assistant command turns → live loading while streaming, ✓ when done.
      // ONLY in a real ViewCoder session (started or bootstrapping). Without
      // this gate, a plain never-started chat where the model merely EXPLAINS
      // the command format (a {"command":...} example in its answer) got the
      // example MASKED behind a tool chip - hiding genuine content the user
      // asked for. Same principle as domHasZsSignal: a command shape alone is
      // not proof of a session. (Branches 1/2 above key off OUR OWN injected
      // markers, which only exist in real sessions, so they need no gate.)
      if (P.isAssistantItem(item) && hasRenderableCommand &&
          (A.started || A.starting)) {
        delete item.dataset.zLuaUnreadableAt;
        // Regenerate transition (see zRegenLen capture in regenResume): the site is
        // still showing the OLD command text after a post-stop regenerate, before it
        // wipes and re-streams. Keep the coherent red "stopped" look instead of
        // re-animating the stale old call as a fresh "run" spinner. Clears the moment
        // the content is actually replaced (stream length drops below the captured
        // baseline) or a short safety window elapses, after which normal
        // classification paints the freshly regenerated command.
        if (item.dataset.zRegenLen) {
          const baseLen = Number(item.dataset.zRegenLen);
          const armedAt = Number(item.dataset.zRegenAt || 0);
          const replaced = txt.length < baseLen - 8;      // old content wiped
          const expired = Date.now() - armedAt > 6000;    // safety fallback
          if (!replaced && !expired) {
            this.toolBox(item, renderedCommandName, "err", "stopped", false);
            return;
          }
          delete item.dataset.zRegenLen;
          delete item.dataset.zRegenAt;
        }
        // A turn the user manually halted (Stop / native stop) stays "stopped" -
        // never let this sweep repaint it ✓ done (or worse, re-spin it) just
        // because generation is still settling. The dataset marker is set where we
        // halt, but on Arena the A/B carousel re-renders the turn node on every
        // token, wiping the marker - so the spinner came back even after Stop. Also
        // derive "stopped" from the userStopped latch (which survives node swaps)
        // for the last turn; it's cleared on the next user message / deliberate
        // resume, so a settled turn is never falsely frozen later.
        // A turn that is GENERATING again (or whose tool the loop is actively
        // running), with NO active user-stop latch, has been REGENERATED - it is no
        // longer the halted turn. Clear its stale halt so isRememberedHalted (index
        // + text-prefix based) can't keep repainting the FRESH command red: a Gemini
        // regenerate reuses the same assistant index and a similar opening prefix,
        // so the old halt otherwise matches and the running command shows "stopped"
        // (red) until it settles. Gated on !A.userStopped so a real Stop that is
        // still settling (isGenerating can lag true for a beat) is NEVER cleared.
        const regenerating = !A.userStopped && (
          (item === lastAssistant && generating) ||
          (A.running && A.toolItem === item)
        );
        if (regenerating) { delete item.dataset.zStopped; forgetHalted(item); }
        const stopped = !regenerating && (
          item.dataset.zStopped === "1" ||
          (A.userStopped && item === lastAssistant) ||
          isRememberedHalted(item, commandEvidenceText));
        // Self-heal: a site re-render that swapped this turn's node wiped the
        // dataset marker - re-stamp it so the stop survives the next wipe of
        // the A.userStopped latch (a fresh user message clears it by design).
        if (stopped && item.dataset.zStopped !== "1") {
          item.dataset.zStopped = "1";
          diag("chip.rehalt", { name: renderedCommandName });
        }
        // The loop already SETTLED this very call (tool finished, we're waiting
        // for the model's next turn) but the site swapped the turn's DOM node,
        // wiping the chip, the zloop ownership AND the __zsChip opts. Without
        // this, the fresh node re-classifies as a spinning "run" chip (A.running
        // is still true) on an already-executed call. Re-own it with the settled
        // outcome. The count guard skips this once the model's NEXT turn exists,
        // so a follow-up call to the same tool still classifies live.
        if (!stopped && A.running && !A.toolRunning && A.toolSettle &&
            // Same TURN check. Node identity when available (virtualization-proof:
            // on Qwen the count doesn't grow for a new turn, and a back-to-back
            // call to the same tool defeats the name guard - the old outcome then
            // repainted the STREAMING next turn's chip as done/err). Falls back to
            // the count guard for providers without lastAssistantId.
            (A.toolSettle.id !== undefined && P.lastAssistantId
              ? P.lastAssistantId() === A.toolSettle.id
              : A.toolSettle.count === P.assistantCount()) &&
            item === lastAssistant &&
            renderedCommandName === A.toolName) {
          diag("chip.reown", { name: A.toolName, phase: A.toolSettle.phase });
          if (A.toolSettle.kind === "image-upload" && A.toolSettle.imageUpload) {
            this.imageUpload(item, A.toolSettle.imageUpload, true);
          } else {
            this.toolBox(item, A.toolName, A.toolSettle.phase, A.toolSettle.detail,
              true, A.toolSettle.body, A.toolSettle.category);
          }
          return;
        }
        // Is this command turn the IN-FLIGHT call - the one a running loop or the
        // bootstrap is about to own? The tell: it has NO injected result turn after
        // it yet. Every ALREADY-EXECUTED command turn is followed by its injected
        // result (a user turn matching isInjectedFeedback), so keying off that,
        // rather than item === lastAssistant(), robustly separates the in-flight
        // turn from settled history. This gives us the best of both:
        //  - The Kimi/bootstrap flash fix: while a loop/bootstrap is active, the
        //    in-flight turn stays "run" in the window between generation ending and
        //    the loop painting its own chip, WITHOUT depending on the flickery
        //    lastAssistant() (Kimi's Vue swaps the node) - no premature green flash.
        //  - No re-spin on REVISIT: when a started chat is re-opened and the loop
        //    or bootstrap runs again, every PAST command turn already has its result
        //    below it, so it settles to "done" instead of every old chip re-loading
        //    to a blue spinner (the Arena "all chips restarted loading" report).
        const resultAfter = next && P.isUserItem(next) &&
          ZSParse.isInjectedFeedback(P.classifyText(next, ".zs-chip"));
        const nm = renderedCommandName;
        // ZeroScript's settled-history signal is the injected result immediately
        // below a command. Make it authoritative for execute_luau: scroll/render
        // generation flicker must never turn a completed Lua card back to "run".
        // Other tools retain their existing phase behavior.
        const settledLua = resultAfter && bareToolName(nm) === "execute_luau";
        const inFlight = (A.running || A.starting) && !resultAfter;
        // Regenerate grace: keep the freshly-regenerated command turn "run" in the
        // gap between regenResume clearing the stop latch and the watchdog starting
        // the loop, so it never flashes a premature ✓ "done" (see regenResume). The
        // anchor slides with generation and expires ~2.5s after it truly stops.
        const resumeGrace = A.resumeArmed && item === lastAssistant &&
          Date.now() - (A.resumeArmedAt || 0) < 2500;
        const live = !stopped && !settledLua && (
          inFlight || resumeGrace || (item === lastAssistant && generating)
        );
        // Orphaned command: a COMPLETE command turn that is the last assistant with
        // NO result below it, not live and not loop-owned, whose generation is now
        // stale (typically the page/extension was reloaded while this command sat
        // un-executed). The auto-resume watchdog deliberately refuses to run a
        // reload-restored generation (the "execute_luau leaked into the new chat"
        // leak guard - same lastGenAt staleness test used here), so it will NEVER
        // execute. Painting it a green ✓ "done" falsely implies the tool ran and
        // succeeded; show a neutral, greyed "not run" state instead (cosmetic only -
        // we intentionally do NOT auto-execute it).
        // A command turn we have no evidence ever executed: not loop-owned, no
        // injected result below it, and not in the off-DOM executed memory (the
        // memory keeps this virtualization-safe - a scrolled-back turn whose result
        // detached is still known-executed and never mislabelled).
        const neverRun = !item.dataset.zloop && !resultAfter &&
          !isRememberedExecuted(item, commandEvidenceText);
        // Superseded orphan: abandoned command - a NEWER assistant turn exists below
        // it yet it never ran (e.g. stopped then regenerated into a fresh turn on
        // Qwen). It will never execute, so it must show neither a green ✓ "done" NOR
        // a live spinner. inFlight is not turn-specific: with the loop running the
        // NEW turn, this old no-result turn would otherwise also read as "run" - the
        // "both the old and the new chip spinning at once" seen live.
        const supersededOrphan = neverRun && item !== lastAssistant;
        // Reload orphan: the LAST command turn, not live, whose generation is stale -
        // the page/extension was reloaded while it sat un-executed and the watchdog
        // refuses to run a reload-restored generation (leak guard). Also never a
        // false green ✓; show a neutral, greyed "not run" (we do NOT auto-execute it).
        const staleLastOrphan = neverRun && item === lastAssistant && !live &&
          Date.now() - A.lastGenAt > 8000;
        const orphanPending = !stopped && (supersededOrphan || staleLastOrphan);
        // Handoff window: a JUST-finished last-assistant command with no result yet
        // that the loop has not taken over (A.running not yet true, so `live` is
        // false). Without this it flashes a premature ✓ "done" for the frames
        // between generation ending and the loop starting, THEN re-spins when the
        // loop paints its own chip - most visible on the instant virtual commands
        // (list_mcp_servers/list_commands). Keep it spinning instead; staleLastOrphan
        // takes over after 8s if the loop genuinely never runs it.
        const pendingExec = !stopped && !orphanPending && !live &&
          neverRun && item === lastAssistant && Date.now() - A.lastGenAt <= 8000;
        let phase = stopped ? "err" : (orphanPending ? "idle" : ((live || pendingExec) ? "run" : "done"));
        let detail = stopped ? "stopped" : (orphanPending ? "not run" : "");
        // Error-aware settle: a command whose injected result RIGHT BELOW is an
        // ERROR must never wear a green ✓. The loop paints this correctly while
        // it owns the turn, but a revisited conversation (or a node swap that
        // dropped ownership) re-derives the phase here - from the conversation
        // itself, so it stays correct without any loop state.
        if (phase === "done" && next && P.isUserItem(next)) {
          const nt = P.classifyText(next, ".zs-chip");
          // feedbackIsError also catches an MCP tool's in-body error (the result
          // reads "Output of '…': Error executing code…", which our ERROR prefix
          // test would miss - the Blender case), so a revisited conversation
          // re-settles it red, matching what the loop painted live.
          if (ZSParse.isInjectedFeedback(nt) && feedbackIsError(nt)) {
            phase = "err"; detail = "error";
            if (item.dataset.zphase !== "err") diag("chip.errSettle", { name: renderedCommandName });
          }
        }
        // A command block that is VISIBLE right now (its hide classes live on
        // child nodes that sites like Gemini re-create on every update, and the
        // block may render only AFTER the chip was first placed mid-stream).
        // Excludes the reasoning area (P.thinkingSel) like ensureOwnedChip:
        // thinking-quoted commands otherwise keep this true forever, and the
        // forced repaint recomputes `live` each sweep - the chip then FLAPS
        // done→run→done with the generation flicker (seen live as a settled
        // green chip blinking back to a blue spinner).
        const rawVisible = [...item.querySelectorAll("pre, p, [class*='code'], .cm-line")].some(
          (e) => !e.classList.contains("zs-tool-hide") && !e.closest(".zs-tool-hide") &&
                 !e.closest(".zs-chip") && !(P.thinkingSel && e.closest(P.thinkingSel)) &&
                 // see ensureOwnedChip's matching guard: a bare outer <pre>
                 // wrapping a hidden child wrapper otherwise reads as visible
                 // forever (Arena code-block markup).
                 !e.querySelector(".zs-tool-hide") &&
                 ZSParse.hasCommandShape(e.textContent || ""));
        // A tool learned to return images gets the "screen" chip even though its
        // name alone wouldn't reveal it (parity with Roblox screen_capture). The
        // fact can land AFTER this turn first settled (imageTools loads from
        // storage async, or the result turn below is classified later the same
        // pass), so repaint when the current chip's category is stale too - the
        // phase-only guard would otherwise freeze it on the generic wrench.
        const cat = A.imageTools.has(bareToolName(nm)) ? "screen" : undefined;
        const chipNow = item.querySelector(".zs-chip");
        const catStale = cat === "screen" && chipNow && !chipNow.classList.contains("cat-screen");
        // Chip drift for chipAppend providers (Kimi): the RUN chip is painted by
        // the SWEEP (owned=false, no zloop) until the loop takes over at
        // tool.start ~2s later, so ensureOwnedChip's drift fix (zloop-only) does
        // NOT run during that window. Meanwhile Vue mounts the copy/regenerate
        // toolbar (chipTrailRef) and inserts it ABOVE our chip node, flashing the
        // action buttons over the chip until something repaints it. Detect that
        // drift here too so the sweep re-seats the chip (chip() re-anchors before
        // trailRef) without waiting for the loop. Mirrors ensureOwnedChip.
        let drifted = false;
        if (P.chipAtItemLevel && P.chipAppend && chipNow) {
          const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
          const trailRef = P.chipTrailRef ? P.chipTrailRef(item) : null;
          drifted = chipNow.parentElement === anchor && chipNow.nextElementSibling !== trailRef;
        }
        if (item.dataset.zphase !== phase || chipGone || rawVisible || catStale || drifted) {
          // Tracker: WHY the sweep chose this phase (only when it changes -
          // chipGone/rawVisible repaints of the same phase stay silent).
          if (item.dataset.zphase !== phase) {
            // Extra suspicion flag: a command that settled ✓ done while it is
            // still the LAST assistant with NO injected result below it - the
            // exact shape of the "chip shows done but the model is still writing"
            // report. genDebug() (if the provider exposes it) breaks isGenerating
            // into its sub-signals so we can see WHICH one flickered false.
            const suspectDone = phase === "done" &&
              item === lastAssistant && !resultAfter;
            diag("chip.why", {
              name: nm, to: phase,
              stopped, live, inFlight, resumeGrace, pendingExec, settledLua,
              isLast: item === lastAssistant, resultAfter,
              gen: generating, run: A.running, starting: A.starting,
              zStopped: item.dataset.zStopped === "1",
              remembered: isRememberedHalted(item, commandEvidenceText),
              lastGenAgoMs: Date.now() - A.lastGenAt,
              suspectDone,
              ...(P.genDebug ? { g: P.genDebug() } : {}),
            });
          }
          this.toolBox(item, nm, phase, detail, false, undefined, cat);
        }
        return;
      }

      // A user-halted turn whose CONTENT the site cleared. Arena's native stop
      // (which our Stop button clicks) empties the turn's .prose and shows
      // "Generation stopped" - so the command JSON vanishes, branch 3's command
      // shape no longer matches, and the empty-text guard just below would bail
      // every sweep, freezing a spinning "run" chip forever. Settle any lingering
      // run chip to "stopped" right here, BEFORE that guard. Idempotent: skips
      // once already at the err phase.
      const haltedTurn =
        item.dataset.zStopped === "1" ||
        (A.userStopped && item === lastAssistant);
      if (haltedTurn && P.isAssistantItem(item) && item.dataset.zphase !== "err"
          && item.querySelector(".zs-chip")) {
        const tx = item.querySelector(".zs-chip-tx");
        const name = ZSParse.toolNameFromText(txt) || (tx && tx.textContent) || "tool";
        this.toolBox(item, name, "err", "stopped", false);
        return;
      }

      // Transient empty render (Angular swaps a turn's subtree before refilling
      // it): the text vanishes for a frame. Never strip a decorated turn on
      // that - the next sweep re-evaluates it with real content.
      if (!txt.trim() && (item.dataset.zphase || item.dataset.zs)) return;

      // ChatGPT can briefly expose only a fragment of a virtualized CodeMirror
      // block while scrolling. During that sub-second gap hasCommandShape() loses
      // the opening marker; stripping the command card here causes the visible
      // hide/show flicker. Preserve an already-identified direct/Lua decoration for a
      // short remount window. An intentional regenerate calls resetDecoration()
      // directly and therefore does not wait on this grace.
      if (
        P.id === "chatgpt" &&
        (item.classList.contains("zs-lua-command-mask") ||
          item.classList.contains("zs-command-mask")) &&
        item.querySelector(".zs-chip")
      ) {
        const missingAt = Number(item.dataset.zLuaUnreadableAt || 0);
        if (!missingAt) {
          item.dataset.zLuaUnreadableAt = String(Date.now());
          return;
        }
        if (Date.now() - missingAt < 1_200) return;
      }

      // 4. Plain text turn. If this node still wears decoration (a recycled
      //    virtualized node), strip it so we never hide genuine content.
      if (item.dataset.zs || item.dataset.zphase || item.querySelector(".zs-chip")) {
        // Tracker: a decorated node re-classified as PLAIN TEXT (virtualized
        // node recycled, or the turn's command text vanished) - its decoration
        // (chip + zStopped marker) is stripped here. If a chip "un-settles"
        // mysteriously, this is the smoking gun to look for.
        diag("chip.reset", { was: item.dataset.zphase || item.dataset.zs || "chip-only" });
        resetDecoration(item);
      }
    },

    noteMutations(mutations) {
      if (!this._dirtyNodes) this._dirtyNodes = new Set();
      const add = (rawNode) => {
        const node = rawNode?.nodeType === Node.TEXT_NODE
          ? rawNode.parentElement
          : rawNode;
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
        if (
          node === document.documentElement ||
          node === document.body
        ) {
          this._dirtyAll = true;
          this._dirtyNodes.clear();
          return;
        }
        for (const known of this._dirtyNodes) {
          if (known === node || known.contains(node)) return;
          if (node.contains(known)) this._dirtyNodes.delete(known);
        }
        this._dirtyNodes.add(node);
        if (this._dirtyNodes.size > 48) {
          this._dirtyAll = true;
          this._dirtyNodes.clear();
        }
      };
      for (const mutation of mutations) {
        const added = [...(mutation.addedNodes || [])];
        if (added.length) added.forEach(add);
        else add(mutation.target);
        if (this._dirtyAll) break;
      }
    },

    sweep(forceFull = false) {
      // Pass each turn's FOLLOWING turn too: a command chip needs it to know
      // whether its injected result was an ERROR (error-aware settle above).
      const items = P.allItems();
      primeAssistantIndexes(items);
      // Derive both tail identities from this one provider enumeration. Calling
      // lastAssistant() here performed another full conversation query.
      let lastAssistant = null;
      let lastUser = null;
      for (let i = items.length - 1; i >= 0; i--) {
        if (!lastAssistant && P.isAssistantItem(items[i])) {
          lastAssistant = items[i];
        }
        if (!lastUser && P.isUserItem(items[i])) lastUser = items[i];
        if (lastAssistant && lastUser) break;
      }
      const generating = P.isGenerating();
      const now = Date.now();
      const dirtyAll = this._dirtyAll === true;
      this._dirtyAll = false;
      const dirtyNodes = this._dirtyNodes
        ? [...this._dirtyNodes]
        : [];
      if (this._dirtyNodes) this._dirtyNodes.clear();

      // ZeroScript's smoothness comes from batching DOM work and preserving
      // rendered nodes. Go one step further here: classify only turns touched by
      // the mutation batch, plus the live tail. A bounded full repair pass still
      // handles virtualization and framework node recycling.
      const full = forceFull || dirtyAll ||
        now - Number(this._lastFullAt || 0) >= 10_000;
      if (full) this._lastFullAt = now;
      const indexes = new Set();
      const addIndex = (index) => {
        if (index >= 0 && index < items.length) indexes.add(index);
      };
      if (full) {
        for (let i = 0; i < items.length; i++) addIndex(i);
      } else {
        for (const node of dirtyNodes) {
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (
              item === node ||
              item.contains(node) ||
              node.contains(item)
            ) {
              addIndex(i);
              // A changed injected result also changes the command immediately
              // above it, so reclassify that predecessor in the same frame.
              addIndex(i - 1);
            }
          }
        }
        if (
          generating || A.starting || A.injecting || A.awaitingReply ||
          A.running || A.toolRunning || A.stopping
        ) {
          for (let i = Math.max(0, items.length - 4); i < items.length; i++) {
            addIndex(i);
          }
        }
      }
      for (const i of [...indexes].sort((a, b) => a - b)) {
        this.classify(
          items[i],
          items[i + 1] || null,
          lastAssistant,
          generating,
          lastUser,
        );
      }
      // Safety net for stopped turns whose chip lives OUTSIDE the enumerated
      // message list. On Arena an A/B comparison renders each candidate as a
      // slide in the carousel's OWN nested <ol>, not the main flex-col-reverse
      // list - so allItems()/classify never see that node and a "run" spinner
      // left by a Stop would spin forever. zStopped is only ever set on a
      // deliberate halt, so settling any run-phase chip under such a node is
      // safe wherever it lives. Idempotent: skips once at the err phase.
      if (full || A.running || A.starting || A.stopping || generating) {
        for (const chip of document.querySelectorAll(".zs-chip.run")) {
        let item = chip.parentElement;
        while (item && !(item.dataset && item.dataset.zStopped)) item = item.parentElement;
        if (item && item.dataset.zphase !== "err") {
          const tx = chip.querySelector(".zs-chip-tx");
          this.toolBox(item, (tx && tx.textContent) || "tool", "err", "stopped", false);
        }
        }
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════════
  //  UI  (control panel, onboarding, stop button, banners, toast, input cover)
  // ════════════════════════════════════════════════════════════════════════
  const ui = (() => {
    let root, bar, dot, brandEl, stateEl, actionBtn, stopBtn, modeBtn, modeMenuEl, discordEl, switchBtn, menuEl, unstableEl;
    let cover, coverTimer, coverResizeObserver, coverResizeFrame, coverObservedNode, barTimer;
    let placementFrame = 0;
    let bridgeOk = false, studioOk = false, studioDown = false, placeDown = false, appDown = false, addonOk = false, studioProcUp = false;
    let wasConnected = false, bridgeBannerEl = null;
    let menuActiveMode = A.activeMode;
    let menuRigDraft = { ...A.modes.rig };
    let menuBlenderState = null;
    let communityReminderScheduled = false;

    function build() {
      root = document.createElement("div");
      root.id = "zs-root";
      // One consolidated status bar, anchored just above the site's composer
      // (kept in sync by placeBar). It carries everything: live status,
      // the primary action (Start / Stop) and a "more"
      // menu (other AI sites, custom prompt and MCP servers). No floating panel,
      // no overlay on the input - the composer stays fully usable for plain chat.
      root.innerHTML = `
        <div id="zs-bar">
          <span id="zs-dot" class="off" title=""></span>
          <span id="zs-brand"><img class="zs-brand-mark" src="${chrome.runtime.getURL("icons/viewcoder-logo.png")}" alt=""><span class="zs-brand-name">ViewCoder</span><span class="zs-free">v${EXT_VERSION}</span></span>
          <span id="zs-state"></span>
          <button id="zs-action"></button>
          <button id="zs-stop" hidden>■ Stop</button>
          <a id="zs-discord" href="${VIEWCODER_DISCORD_URL}" target="_blank" rel="noopener noreferrer" aria-label="Join the ViewCoder Discord" title="Join the ViewCoder Discord" style="display:none">${DISCORD_ICON}</a>          <button id="zs-agent-mode" aria-haspopup="menu" aria-expanded="false" title="Switch between Agent and Plan"><img class="zs-agent-mark" src="${chrome.runtime.getURL("icons/ui/agent-mode.png")}" alt=""><span id="zs-agent-mode-label">Agent</span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></button>
          <button id="zs-switch" aria-label="Switch AI and options" title="Switch AI and ViewCoder options"><span id="zs-switch-name"></span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
        </div>
        <div id="zs-agent-menu" role="menu" hidden><button role="menuitem" data-mode="agent"><span>Agent</span><small>Execute and verify · Beta</small></button><button role="menuitem" data-mode="plan"><span>Plan</span><small>Ask, plan &amp; approve · Beta</small></button></div>
        <div id="zs-menu" hidden></div>
        ${P.unstableWarning ? `<button id="zs-unstable" aria-label="Provider information" hidden></button>` : ""}
      `;
      document.documentElement.appendChild(root);
      bar = root.querySelector("#zs-bar");
      dot = root.querySelector("#zs-dot");
      brandEl = root.querySelector("#zs-brand");
      stateEl = root.querySelector("#zs-state");
      actionBtn = root.querySelector("#zs-action");
      stopBtn = root.querySelector("#zs-stop");
      discordEl = root.querySelector("#zs-discord");
      modeBtn = root.querySelector("#zs-agent-mode");
      modeMenuEl = root.querySelector("#zs-agent-menu");
      switchBtn = root.querySelector("#zs-switch");
      const swName = root.querySelector("#zs-switch-name");
      if (swName) swName.textContent = P.displayName || P.id;
      menuEl = root.querySelector("#zs-menu");
      bar.classList.add(`zs-prov-${P.id}`); // lets CSS tune per-site (e.g. font)
      // Provider hook on <html> so overlay.css can tune site-specific CHIP layout
      // (not just the bar). Meta's turn root is full-width with the reply in a
      // nested centered column, so whole-turn chips (result/sys) need re-centering.
      document.documentElement.classList.add(`zs-site-${P.id}`);

      actionBtn.addEventListener("click", onActionClick);
      discordEl?.addEventListener("click", (event) => event.stopPropagation());
      modeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        menuEl.hidden = true;
        modeMenuEl.hidden = !modeMenuEl.hidden;
        modeBtn.setAttribute("aria-expanded", String(!modeMenuEl.hidden));
        requestBarPlacement();
        if (!modeMenuEl.hidden) requestAnimationFrame(placeModeMenu);
      });
      modeMenuEl.querySelectorAll("button[data-mode]").forEach((button) => {
        button.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          const operatingMode = button.dataset.mode === "plan" ? "plan" : "agent";
          const response = await bg({ type: "VIEWCODER_SET_MODES", modes: { operatingMode } });
          if (!response?.ok) {
            toast(response?.error || "ViewCoder could not change mode.");
          } else {
            A.modes = normalizedViewModes(response.modes);
            renderModeControl();
          }
          modeMenuEl.hidden = true;
          modeBtn.setAttribute("aria-expanded", "false");
        });
      });
      // Capture pointerdown so host-site overlays/re-renders cannot swallow
      // ViewCoder's Stop action. Click remains the keyboard-accessible fallback.
      let stopPointerAt = 0;
      stopBtn.addEventListener("pointerdown", (event) => {
        if (stopBtn.disabled) return;
        stopPointerAt = Date.now();
        event.preventDefault();
        event.stopPropagation();
        stopLoop();
      }, true);
      stopBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (Date.now() - stopPointerAt > 600) stopLoop();
      }, true);
      unstableEl = root.querySelector("#zs-unstable");
      if (unstableEl) {
        const noticeLabel = P.noticeLabel === "Beta" ? "Beta" : "Notice";
        unstableEl.textContent = `⚠ ${noticeLabel}`;
        unstableEl.setAttribute(
          "aria-label",
          `${P.displayName || "Provider"} ${noticeLabel.toLowerCase()} information`,
        );
        // Set the native tooltip via PROPERTY, not the HTML template: the warning
        // text may contain double quotes (e.g. GLM's "No response…"), which would
        // terminate a title="..." attribute early and truncate the tooltip.
        unstableEl.title = P.unstableWarning;
        unstableEl.addEventListener("click", (e) => {
          e.stopPropagation();
          toast(P.unstableWarning);
        });
      }
      buildMenu();
      const toggleMenu = () => {
        menuEl.hidden = !menuEl.hidden;
        requestBarPlacement();
        if (!menuEl.hidden) {
          // Rebuild on every open, not just once at page load: the initial
          // buildMenu() call runs before the bridge status (server list/health)
          // has arrived, so the very first render always shows an empty/stale
          // MCP servers section otherwise - nothing ever refreshed it after.
          buildMenu();
          syncMenuPrompt();
          // On a FRESH open, menuEl has no max-height yet - that's only applied by
          // placeBar()'s positioning pass, which runs on the next layout tick (it's a
          // separate loop, not synchronous with this click). Without it the panel
          // has no overflow yet, so scrollHeight === clientHeight and setting
          // scrollTop here is a no-op - the "jump to Support" silently failed on
          // the very first open (reported live on Arena). Deferring one frame lets
          // placeBar's already-queued tick clip the box first, so there's real
          // scroll room by the time we set scrollTop.
          requestAnimationFrame(() => {
            if (!menuEl.hidden) menuEl.scrollTop = 0;
          });
        }
      };
      switchBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
      document.addEventListener("click", (e) => {
        if (!menuEl.hidden && !menuEl.contains(e.target) && !switchBtn.contains(e.target))
          menuEl.hidden = true;
        if (!modeMenuEl.hidden && !modeMenuEl.contains(e.target) && !modeBtn.contains(e.target)) {
          modeMenuEl.hidden = true;
          modeBtn.setAttribute("aria-expanded", "false");
        }
        requestBarPlacement();
      }, true);

      applyTheme();
      setInterval(applyTheme, 2000); // follow the host page toggling its theme
      renderBar();
      modeUiRefresh = () => {
        renderModeControl();
        renderMenuControls();
      };
      renderModeControl();
      scheduleCommunityReminder();
      placeBar(); // start the lightweight self-healing anchoring loop
    }

    function renderModeControl() {
      if (!modeBtn) return;
      const mode = A.modes.operatingMode === "plan" ? "plan" : "agent";
      const label = modeBtn.querySelector("#zs-agent-mode-label");
      if (label) label.textContent = mode === "plan" ? "Plan" : "Agent";
      modeBtn.dataset.mode = mode;
      for (const button of modeMenuEl?.querySelectorAll("button[data-mode]") || []) {
        button.classList.toggle("active", button.dataset.mode === mode);
        button.setAttribute("aria-checked", String(button.dataset.mode === mode));
      }
    }

    // The primary button does different things depending on the current state
    // (set by renderBar via actionBtn.dataset.kind).
    async function onActionClick() {
      const kind = actionBtn.dataset.kind;
      if (kind === "start") {
        await refreshWorkLease();
        if (A.workBlocked) {
          toast("ViewCoder is already working in another chat.");
          return;
        }
        startSession();
      }
    }

    // ── Custom prompt (persisted) ───────────────────────────────────────────
    // The user's extra instructions, persisted in chrome.storage.local and
    // appended UNDER the system prompt at session start. Cached here so
    // startSession can read it synchronously.
    let customPrompt = "";
    try {
      chrome.storage.local.get("zsCustomPrompt", (r) => {
        if (r && typeof r.zsCustomPrompt === "string") {
          customPrompt = r.zsCustomPrompt.slice(0, 4000);
          syncMenuPrompt();
        }
      });
    } catch {}
    function getCustomPrompt() { return customPrompt; }
    // Reflect the saved value back into the menu textarea (unless being edited).
    function syncMenuPrompt() {
      const ta = root && root.querySelector("#zs-set-text");
      if (ta && document.activeElement !== ta) ta.value = customPrompt;
    }

    // ── Custom MCP servers (addons) ─────────────────────────────────────────
    // ── The "more" menu (⋯) ─────────────────────────────────────────────────
    // One popover holding every secondary control: other AI sites, the custom
    // prompt, and support (Ko-fi + Robux). Opens above the bar.
    function buildMenu() {
      const here = (P.displayName || "").toLowerCase();
      const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
      let sites = "";
      for (const s of AI_SITES) {
        const current = s.name.toLowerCase() === here;
        const label = `<span class="zs-site-main"><span class="zs-site-emoji" aria-hidden="true">${s.icon}</span><span class="zs-site-name"><span>${s.name}</span><span class="zs-site-host">${hostOf(s.url)}</span></span></span>`;
        sites += current
          ? `<div class="zs-site-opt zs-site-here">${label}<span class="zs-site-badge">active</span></div>`
           : `<button class="zs-site-opt" data-u="${s.url}">${label}<span class="zs-site-go">&rarr;</span></button>`;
      }
      const activeIcon = chrome.runtime.getURL("icons/ui/active.png");
      const blenderIcon = chrome.runtime.getURL("icons/ui/blender.webp");
      const iconModeDescription = providerCanGenerateIcons()
        ? "This AI creates separate transparent PNGs. Off lets the AI choose suitable preset icons."
        : "Unavailable on this AI · the AI may choose suitable preset icons.";
      menuEl.innerHTML =
        `<div class="zs-menu-head"><span class="zs-menu-logo">ViewCoder</span><span class="zs-menu-tag">v${EXT_VERSION}</span></div>
         <section class="zs-menu-sec">
           <div class="zs-sec-label"><span>Choose another AI</span></div>
           ${sites}
         </section>
         <section class="zs-menu-sec zs-control-section">
           <div class="zs-sec-label"><span>Connection &amp; modes</span></div>
           <button id="zs-menu-refresh" class="zs-menu-action" type="button">
             <span class="zs-menu-action-icon" aria-hidden="true">↻</span>
             <span><b>Refresh connection</b><small>Reconnect and verify Studio</small></span>
           </button>
           <button id="zs-menu-blender" class="zs-menu-action" type="button">
             <img class="zs-menu-control-icon zs-blender-icon" src="${blenderIcon}" alt="">
             <span class="zs-menu-control-copy"><b>Blender Link <em class="zs-beta">Beta</em></b><small id="zs-menu-blender-status">Checking the live MCP add-on…</small></span>
             <span id="zs-menu-blender-verb" class="zs-menu-action-verb">Check</span>
           </button>
           <div class="zs-menu-control">
             <img class="zs-menu-control-icon" src="${activeIcon}" alt="">
             <span class="zs-menu-control-copy"><b>Active Mode <em class="zs-beta">Beta</em></b><small>Keep this task moving in another tab</small></span>
             <button id="zs-menu-active" class="zs-menu-switch" type="button" role="switch" aria-checked="true" aria-label="Toggle Active Mode"><span></span></button>
           </div>
           <div id="zs-connection-control-status" class="zs-menu-control-status" role="status"></div>
         </section>
         <section class="zs-menu-sec zs-control-section">
           <div class="zs-sec-label"><span>Creative Modes <em class="zs-beta">Beta</em></span></div>
           <div class="zs-menu-creative-grid">
             <button id="zs-menu-animation" class="zs-menu-creative" type="button" role="switch" aria-checked="false">
               <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2.2"></circle><path d="M12 7.2v5.1m0 0-4.5 3.2m4.5-3.2 4.5 3.2m-4.5-3.2-3.2-3m3.2 3 3.2-3M7.5 15.5 6 21m10.5-5.5L18 21"></path></svg>
               <span><b>Animation Mode</b><small>Focus on Roblox animation in Blender.</small></span><i aria-hidden="true"></i>
             </button>
             <button id="zs-menu-icons" class="zs-menu-creative" type="button" role="switch" aria-checked="true" aria-label="Toggle AI Generated UI">
               <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6z"></path><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"></path></svg>
               <span><b>AI Generated UI</b><small>${iconModeDescription}</small></span><i aria-hidden="true"></i>
             </button>
           </div>
           <div id="zs-menu-rig" class="zs-menu-rig" hidden>
             <label>Animation rig <span>Blocky Roblox character</span></label>
             <small class="zs-menu-rig-warning">Importing replaces the entire current Blender project and opens the Animation workspace.</small>
             <button id="zs-menu-rig-import" type="button">Import Rig</button>
           </div>
           <div id="zs-mode-control-status" class="zs-menu-control-status" role="status"></div>
         </section>
         <section class="zs-menu-sec zs-community-section">
           <div class="zs-sec-label"><span>Community &amp; support</span></div>
           <button class="zs-community-action" type="button" data-u="${VIEWCODER_DISCORD_URL}">
             <span class="zs-community-icon zs-community-discord" aria-hidden="true">${DISCORD_ICON}</span>
             <span><b>Join the Discord</b><small>Help, feedback, and updates</small></span><i>Open</i>
           </button>
           <button class="zs-community-action" type="button" data-u="${VIEWCODER_ROBUX_SUPPORT_URL}">
             <span class="zs-community-icon" aria-hidden="true">R$</span>
             <span><b>Donate Robux</b><small>Visit the creator's Roblox profile</small></span><i>Open</i>
           </button>
         </section>
         <section class="zs-menu-sec">
           <div class="zs-sec-label"><span>Personal instructions</span></div>
           <div class="zs-menu-note">These preferences are privately added whenever a new ViewCoder session begins.</div>
           <textarea id="zs-set-text" rows="4" maxlength="4000" placeholder="Example: keep scripts modular and explain only important changes."></textarea>
           <div class="zs-set-row"><button id="zs-set-save">Keep changes</button><span id="zs-set-status"></span></div>
         </section>`;
      const open = (url) => {
        menuEl.hidden = true;
        try {
          window.location.assign(url);
        } catch {
          window.location.href = url;
        }
      };
      menuEl.querySelectorAll("button.zs-site-opt").forEach((b) =>
        b.addEventListener("click", () => open(b.dataset.u)));
      menuEl.querySelectorAll("button.zs-community-action").forEach((button) =>
        button.addEventListener("click", () => {
          try { window.open(button.dataset.u, "_blank", "noopener,noreferrer"); } catch {}
          menuEl.hidden = true;
        }));
      bindMenuControls();
      const ta = menuEl.querySelector("#zs-set-text");
      const saveBtn = menuEl.querySelector("#zs-set-save");
      const status = menuEl.querySelector("#zs-set-status");
      ta.value = customPrompt;
      saveBtn.addEventListener("click", () => {
        customPrompt = ta.value.slice(0, 4000);
        safeStorageSet({ zsCustomPrompt: customPrompt });
        status.textContent = "Preferences kept ✓";
        setTimeout(() => { status.textContent = ""; }, 1600);
      });
      void refreshMenuControls();
    }

    function menuControlStatus(text, isError = false, target = "#zs-mode-control-status") {
      const status = menuEl?.querySelector(target);
      if (!status) return;
      status.textContent = text || "";
      status.classList.toggle("is-error", isError);
    }

    function renderMenuControls() {
      if (!menuEl) return;
      const activeToggle = menuEl.querySelector("#zs-menu-active");
      if (activeToggle) {
        activeToggle.setAttribute("aria-checked", String(menuActiveMode));
        activeToggle.classList.toggle("is-enabled", menuActiveMode);
      }
      const blenderButton = menuEl.querySelector("#zs-menu-blender");
      const blenderStatus = menuEl.querySelector("#zs-menu-blender-status");
      const blenderVerb = menuEl.querySelector("#zs-menu-blender-verb");
      if (blenderButton && blenderStatus && blenderVerb) {
        const ready = menuBlenderState?.ready === true && menuBlenderState?.verified === true;
        const enabled = menuBlenderState?.enabled === true;
        blenderButton.classList.toggle("is-connected", ready);
        blenderButton.classList.toggle("is-waiting", enabled && !ready);
        if (ready) {
          blenderStatus.textContent = `Add-on handshake verified · ${Number(menuBlenderState.toolCount || 0)} tools`;
          blenderVerb.textContent = "Disconnect";
        } else if (enabled) {
          blenderStatus.textContent = menuBlenderState?.error || "Start MCP Server in Blender, then retry.";
          blenderVerb.textContent = "Retry";
        } else {
          blenderStatus.textContent = "Enable the bundled Blender MCP connection";
          blenderVerb.textContent = "Connect";
        }
      }
      const animation = menuEl.querySelector("#zs-menu-animation");
      const icons = menuEl.querySelector("#zs-menu-icons");
      if (animation) {
        animation.setAttribute("aria-checked", String(A.modes.animationMode));
        animation.classList.toggle("is-enabled", A.modes.animationMode);
      }
      if (icons) {
        const available = providerCanGenerateIcons();
        const enabled = available && A.modes.iconMode;
        icons.disabled = !available;
        icons.setAttribute("aria-disabled", String(!available));
        icons.setAttribute("aria-checked", String(enabled));
        icons.classList.toggle("is-enabled", enabled);
        icons.classList.toggle("is-unavailable", !available);
        icons.title = available
          ? `AI Generated UI is ${enabled ? "on" : "off"}`
          : "AI Generated UI is unavailable on this AI; suitable matching preset icons are optional.";
      }
      const rigPanel = menuEl.querySelector("#zs-menu-rig");
      if (rigPanel) rigPanel.hidden = !A.modes.animationMode;
      const rigImport = menuEl.querySelector("#zs-menu-rig-import");
      menuRigDraft = {
        ...menuRigDraft,
        rigType: "R15",
        bodyShape: "Official",
        preset: "Blocky Character",
      };
      if (rigImport) rigImport.textContent = "Import Rig";
    }

    async function refreshMenuControls() {
      const [activeResult, modesResult, statusResult] = await Promise.all([
        bg({ type: "VIEWCODER_ACTIVE_MODE" }),
        bg({ type: "VIEWCODER_MODES" }),
        bg({ type: "VIEWCODER_STATUS" }),
      ]);
      if (activeResult?.ok) menuActiveMode = activeResult.enabled !== false;
      if (modesResult?.ok && modesResult.modes) {
        A.modes = normalizedViewModes(modesResult.modes);
        menuRigDraft = { ...A.modes.rig };
      }
      menuBlenderState = statusResult?.bridge?.servers?.find(
        (server) => server?.id === "blender",
      ) || null;
      renderModeControl();
      renderMenuControls();
    }

    async function setMenuModes(patch) {
      const result = await bg({ type: "VIEWCODER_SET_MODES", modes: patch });
      if (!result?.ok) {
        menuControlStatus(result?.error || "ViewCoder could not change modes.", true);
        return null;
      }
      A.modes = normalizedViewModes(result.modes);
      menuRigDraft = { ...A.modes.rig };
      renderModeControl();
      renderMenuControls();
      menuControlStatus("Modes updated ✓");
      return result;
    }

    function bindMenuControls() {
      const refresh = menuEl.querySelector("#zs-menu-refresh");
      refresh?.addEventListener("click", async () => {
        refresh.disabled = true;
        menuControlStatus("Refreshing the Studio connection…", false, "#zs-connection-control-status");
        const reconnect = await bg({ type: "VIEWCODER_RECONNECT" });
        const verification = reconnect?.ok === false
          ? reconnect
          : await bg({ type: "VIEWCODER_VERIFY" });
        if (verification?.ok === false) {
          menuControlStatus(
            verification?.error || "The Studio connection could not be refreshed.",
            true,
            "#zs-connection-control-status",
          );
        } else {
          menuControlStatus("Connection refreshed and verified ✓", false, "#zs-connection-control-status");
          void pollBridgeStatus();
        }
        refresh.disabled = false;
      });

      menuEl.querySelector("#zs-menu-active")?.addEventListener("click", async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        const result = await bg({ type: "VIEWCODER_SET_ACTIVE_MODE", enabled: !menuActiveMode });
        if (!result?.ok) {
          menuControlStatus(result?.error || "Active Mode could not be changed.", true, "#zs-connection-control-status");
        } else {
          menuActiveMode = result.enabled !== false;
          A.activeMode = menuActiveMode;
          menuControlStatus(`Active Mode ${menuActiveMode ? "enabled" : "disabled"} ✓`, false, "#zs-connection-control-status");
        }
        button.disabled = false;
        renderMenuControls();
      });

      menuEl.querySelector("#zs-menu-blender")?.addEventListener("click", async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        menuControlStatus("Checking the live Blender MCP add-on handshake…", false, "#zs-connection-control-status");
        let result;
        if (menuBlenderState?.ready === true) {
          result = await bg({ type: "VIEWCODER_SET_BLENDER", enabled: false });
        } else if (menuBlenderState?.enabled === true) {
          result = await bg({ type: "VIEWCODER_RECONNECT_BLENDER" });
        } else {
          result = await bg({ type: "VIEWCODER_SET_BLENDER", enabled: true });
        }
        const refreshed = await bg({ type: "VIEWCODER_STATUS" });
        menuBlenderState = refreshed?.bridge?.servers?.find(
          (server) => server?.id === "blender",
        ) || null;
        if (result?.ok === false || refreshed?.ok === false) {
          menuControlStatus(
            result?.error || refreshed?.error || "Blender could not be reached.",
            true,
            "#zs-connection-control-status",
          );
        } else if (menuBlenderState?.ready) {
          menuControlStatus("Blender add-on handshake verified ✓", false, "#zs-connection-control-status");
        } else if (menuBlenderState?.enabled) {
          menuControlStatus(
            menuBlenderState?.error || "Start MCP Server in Blender, then click Retry.",
            true,
            "#zs-connection-control-status",
          );
        } else {
          menuControlStatus("Blender connection disabled.", false, "#zs-connection-control-status");
        }
        button.disabled = false;
        renderMenuControls();
        void pollBridgeStatus();
      });
      menuEl.querySelector("#zs-menu-animation")?.addEventListener("click", () =>
        void setMenuModes({ animationMode: !A.modes.animationMode }));
      menuEl.querySelector("#zs-menu-icons")?.addEventListener("click", () => {
        if (!providerCanGenerateIcons()) {
          menuControlStatus("AI Generated UI is unavailable on this AI. This AI may use a matching preset icon when suitable.");
          return;
        }
        void setMenuModes({ iconMode: !A.modes.iconMode });
      });

      menuEl.querySelector("#zs-menu-rig-import")?.addEventListener("click", async (event) => {
        const confirmed = window.confirm(
          "Are you sure you want to switch to Animation Mode? This will permanently delete everything in your current Blender project before importing the animation rig. Save your .blend file first if needed.",
        );
        if (!confirmed) {
          menuControlStatus("Import cancelled. Blender was not changed.");
          return;
        }
        const button = event.currentTarget;
        button.disabled = true;
        menuControlStatus("Clearing Blender and importing the animation rig at world origin…");
        const result = await bg({ type: "VIEWCODER_IMPORT_RIG", rig: {} });
        if (!result?.ok) {
          menuControlStatus(result?.error || "The animation rig was not imported.", true);
        } else {
          A.modes = normalizedViewModes(result.modes);
          menuRigDraft = { ...A.modes.rig };
          renderModeControl();
          renderMenuControls();
          const rigName = A.modes.rig.name || "The animation rig";
          menuControlStatus(`${rigName} is centered at world origin in Blender's Animation workspace ✓`);
        }
        button.disabled = false;
      });
    }

    // ── First-time onboarding card (bridge missing) ─────────────────────────
    let setupCard = null, setupSeen = false;
    try {
      chrome.storage.local.get("zsSetupSeen", (r) => {
        if (r && r.zsSetupSeen) setupSeen = true;
      });
    } catch {}

    function buildSetup() {
      setupCard = document.createElement("div");
      setupCard.id = "zs-setup";
      setupCard.hidden = true;
      setupCard.innerHTML =
        `<div id="zs-setup-head"><span id="zs-setup-logo">ViewCoder</span><span id="zs-setup-tag">Connection guide</span></div>` +
        `<div id="zs-setup-sub">Link the browser workspace before an AI can make changes in Roblox Studio or Blender.</div>` +
        `<ol id="zs-setup-steps">` +
          `<li>Find the local ViewCoder folder</li>` +
          `<li>Run <code>start.bat</code> and keep the connection window available</li>` +
          `<li>Open at least one target app, then choose <b>Start ViewCoder</b></li>` +
        `</ol>` +
        `<button id="zs-setup-dismiss">Continue</button>`;
      document.documentElement.appendChild(setupCard);

      setupCard.querySelector("#zs-setup-dismiss").addEventListener("click", () => {
        setupSeen = true;
        safeStorageSet({ zsSetupSeen: true });
        hideSetup();
      });
    }

    function showSetup() {
      if (!setupCard) buildSetup();
      if (setupCard.hidden) setupCard.hidden = false;
    }

    function hideSetup() {
      if (setupCard) setupCard.hidden = true;
    }

    function refreshSetup(bridgeConnected) {
      if (setupSeen || bridgeConnected) { hideSetup(); return; }
      // Bridge is down, but if the user is just READING an existing
      // conversation with no ViewCoder session (the "No agent here" state),
      // a "bridge down" onboarding popup is pure noise - they may not want an
      // agent here at all (user request). Keep it for the states where the
      // bridge actually matters: a fresh/empty chat (the Start affordance is
      // showing) or a conversation with a live/starting session.
      if (!A.started && !A.starting && !P.chatIsEmpty()) { hideSetup(); return; }
      showSetup();
    }

    // The single source of truth for the bar's content. Decides the dot tone,
    // the state line and the primary action from the live state:
    //  • starting        → spinner, "Starting the Roblox agent…"
    //  • session active   → live dot, "Agent active · N tools" (no action)
    //  • fresh blank chat → "Standby…" (or a bridge/Studio warning), action = Start
    //  • existing chat    → "No agent in this chat" (informs only, no action)
    function renderBar() {
      if (!bar) return;
      // indicator = an optional leading dot/spinner; msg = the wrappable text.
      let toneClass = "standby", indicator = "", msg = "", label = "", kind = "", disabled = false, warn = false;
      // Show "Starting…" for the whole bootstrap. If the user actually leaves for
      // a new (empty) chat, syncSessionState clears A.starting, so this naturally
      // falls back to that chat's own state - no fragile per-key check here (fresh
      // chats share a key, and the conversation id only appears mid-bootstrap).
      if (A.starting) {
        toneClass = "starting";
        indicator = `<span class="zs-spin"></span>`;
        msg = `Linking this AI with your connected workspace…`;
        label = "Connecting…"; kind = "starting"; disabled = true;
      } else if (A.started) {
        // Prefer the ADVERTISED list length (A.toolList - the AGGREGATE catalogue
        // across every connected MCP server, already filtered by the vision/blocked
        // gate so it matches what the model actually has: e.g. screen_capture is
        // absent on non-vision providers like Kimi). After a page reload A.toolList
        // is empty until the next list_tools, so fall back to the sum of every
        // server's per-server health count (Roblox + addons like Blender) - NOT the
        // Roblox-only count, which made the total drop to just 27 after a reload.
        const healthTotal = A.bridge &&
          (A.bridge.servers || []).reduce((n, x) => n + (x.tools || 0), 0);
        const tools = A.toolList.length || healthTotal || (A.bridge && A.bridge.tools) || 0;
        // "N tools" only means StudioMCP itself is up - it advertises its full
        // catalogue even with no Studio/place attached (see probe_studio() in
        // bridge.py), so showing it while Studio/place isn't actually usable
        // reads as "everything's fine" when tool calls will just fail. Surface
        // the real blocker instead in that case.
        if (A.bridge && A.bridge.connected === false) {
          // placeDown/appDown/studioDown are all false in this case (they're
          // only computed when the bridge IS connected - see setStatus), so
          // without this check the bridge dropping fell through to the
          // stale "N tools" text below, reading as if nothing was wrong.
          toneClass = "warn"; warn = true;
          msg = `<b>Studio link engaged</b> · <span class="zs-start-hint">run start.bat to restore the local channel</span>`;
        } else if (!studioOk && addonOk) {
          // DEGRADED session by CHOICE: the user started the agent with Roblox
          // down but other MCP server(s) alive (the "Start agent (Roblox
          // offline)" path) - they may only want the addon tools (e.g. Blender).
          // Keep the YELLOW dot as the honest health signal, but do NOT keep the
          // red imperative "open Roblox Studio" nag on screen for the whole
          // session (warn=false → no zs-state-warn red text). The full nag
          // still shows when NO server is usable (the branches below).
          toneClass = "active";
          msg = `<b>Workspace link engaged</b>${tools ? ` · ${tools} tools synced` : ""}`;
        } else if (placeDown) {
          toneClass = "warn"; warn = true;
          msg = `<b>Studio link engaged</b> · load a place in Roblox Studio`;
        } else if (appDown || studioDown) {
          toneClass = "warn"; warn = true;
          msg = studioProcUp
            ? `<b>Studio link engaged</b> · restore Studio from <b>Assistant Settings &gt; MCP Servers</b>`
            : `<b>Studio link engaged</b> · launch Roblox Studio and turn on Studio MCP`;
        } else {
          toneClass = "active";
          // No inline dot here: the leading status dot already shows green, two
          // dots side by side looked cluttered. The green "Agent active" text
          // carries it.
          msg = `<b>Workspace link engaged</b>${tools ? ` · ${tools} tools synced` : ""}`;
        }
      } else if (A.workBlocked) {
        toneClass = "warn"; warn = true;
        msg = `ViewCoder is working in another chat. Finish or stop that task first.`;
        if (P.isFreshChat() || P.chatIsEmpty()) {
          label = "▶ Start ViewCoder";
          kind = "start";
          disabled = true;
        }
      } else if (P.isFreshChat() || P.chatIsEmpty()) {
        // Treat ANY empty chat (no turns yet) as the standby/start case - not just
        // the strict fresh-chat match. isFreshChat() also requires an exact root
        // path AND the editor already mounted; on a cold load (e.g. arriving from a
        // search-engine link) the SPA can show pathname/editor before they settle,
        // which used to drop into the discouraging "No agent here" branch on a page
        // that is actually empty and startable. "No agent here" is only correct for
        // an EXISTING conversation (one that has turns) we did not start.
        if (bridgeOk) {
          toneClass = "standby";
          msg = `A connected workspace is available whenever you want to begin.`;
          label = "▶ Start ViewCoder"; kind = "start";
        } else {
          toneClass = "warn"; warn = true;
          msg = !A.bridge.connected
            ? `<span class="zs-start-hint">Launch start.bat to connect ViewCoder.</span>`
            : `Connect at least one target: <b>Roblox Studio</b> or <b>Blender</b>.`;
          label = "▶ Start ViewCoder"; kind = "start";
        }
        // Start as soon as any supported target has completed a live MCP round trip.
        disabled = !bridgeOk;
      } else {
        toneClass = "noagent";
        msg = `This chat has no ViewCoder session. Begin from a fresh chat.`;
      }
      // Provider mode guard: some sites (e.g. Arena) only work in one chat mode.
      // When the provider reports the current mode is unsupported, override the
      // bar into a visible warning and disable Start until the user switches back.
      // Skipped once a session is started/starting (the mode is fixed for the
      // conversation by then). Reactive: renderBar runs on every sweep, so the
      // warning appears/clears the instant the user changes the mode dropdown.
      if (!A.started && !A.starting && P.modeWarning) {
        const modeWarn = P.modeWarning();
        if (modeWarn) {
          toneClass = "warn"; warn = true; msg = modeWarn;
          if (kind === "start") disabled = true;
        }
      }
      // Only touch the DOM when something actually changed. renderBar runs on
      // every sweep; rewriting stateEl.innerHTML each time recreated the spinner
      // <span> and RESTARTED its CSS animation, so "Starting…" appeared to stutter.
      const busy = !stopBtn.hidden;
      // Before a session is started, the bar stays minimal. The AI selector
      // appears once the agent is running so startup remains uncluttered.
      // (A.started is ambiguous with `warn`
      // tone - which occurs both started-with-bridge-down and standby-with-bridge-
      // down - so it's tracked explicitly in the signature.)
      const showExtras = !!A.started;
      const sig = [toneClass, indicator, msg, label, kind, disabled, warn, busy, showExtras, A.modes.operatingMode].join("|");
      if (sig === lastBarSig) return;
      lastBarSig = sig;
      // Set the tone WITHOUT clobbering other classes (e.g. zs-bar-inline, which
      // placeBar adds for the in-flow mount - overwriting className broke the
      // layout, making the bar fall back to fixed positioning and overlap).
      bar.classList.remove("tone-standby", "tone-active", "tone-warn", "tone-noagent", "tone-starting");
      bar.classList.add(`tone-${toneClass}`);
      stateEl.innerHTML = indicator + `<span class="zs-state-txt">${msg}</span>`;
      stateEl.classList.toggle("zs-state-warn", warn);
      actionBtn.textContent = label;
      actionBtn.dataset.kind = kind;
      actionBtn.disabled = disabled;
      // The Stop button replaces the action button while the agent is busy.
      // With no kind (e.g. agent active, or an existing chat) there's no primary
      // action to offer, so the button is hidden entirely.
      actionBtn.style.display = (busy || !kind) ? "none" : "";
      // AI selector: only once a session is live.
      if (switchBtn) switchBtn.style.display = showExtras ? "" : "none";
      if (modeBtn) modeBtn.style.display = showExtras ? "" : "none";
      if (discordEl) discordEl.style.display = showExtras ? "" : "none";
      if (!showExtras && modeMenuEl) modeMenuEl.hidden = true;
      renderModeControl();
    }
    let lastBarSig = "";

    // Thin wrappers kept for the core's call sites; the decision lives in renderBar.
    function setStarted() { renderBar(); }
    function setStarting() { renderBar(); }

    function setStatus(s) {
      A.bridge = s;
      if (!dot) return;
      const servers = s.servers || [];
      // Roblox reports extra app/place health. Blender is an independent workspace
      // target, so any server with a verified live catalogue can unlock
      // ViewCoder without pretending that an unavailable target is connected.
      const roblox = servers.find((x) => x.id === "roblox");
      const mcpUp = roblox ? !!roblox.alive : (!!s.mcpAlive || servers.some((x) => x.alive));
      // Roblox-only count drives the connectivity gate (the dot must never look
      // green off an addon while Roblox itself is down)...
      const robloxTools = roblox ? (roblox.tools || 0) : (s.tools || 0);
      const mcpOk = s.connected && (mcpUp || robloxTools > 0);
      // ...but the DISPLAYED count is the aggregate across every server (Roblox +
      // addons like Blender), so it stays consistent with the bar and doesn't
      // under-report when addon servers are loaded.
      const totalTools = servers.reduce((n, x) => n + (x.tools || 0), 0) || s.tools || robloxTools;
      // studio === false means the MCP server answered but the Studio is not USABLE
      // (no place loaded). studioApp tells the two sub-cases apart:
      //   studioApp === false → no Studio connected at all (app closed OR its MCP
      //                         server option is disabled - indistinguishable).
      //   studioApp === true  → Studio open but no place loaded (home screen / place
      //                         closed mid-session). THIS is the case that used to
      //                         wrongly read "Connected".
      // null/undefined = unknown (old bridge / probe busy) → don't degrade.
      const studioOff = mcpOk && s.studio === false;
      const noApp = studioOff && s.studioApp === false;
      const noPlace = studioOff && s.studioApp === true;
      const ok = mcpOk && !studioOff;
      const readyAddons = servers.filter((x) =>
        x.id !== "roblox" && x.alive && (x.tools || 0) > 0
      );
      addonOk = !!s.connected && readyAddons.length > 0;
      const anyTargetOk = ok || addonOk;
      dot.className = s.connected ? (anyTargetOk ? "on" : "warn") : "off";
      // Studio PROCESS running on the machine (bridge-side tasklist check).
      // Splits noApp into its two truly different situations: Studio not
      // launched at all vs Studio OPEN but its MCP plugin never registered
      // with the bridge. The plugin only attempts to register ONCE (at Studio
      // boot or on a panel/toggle interaction) and never retries by itself,
      // so for the second case "open Roblox Studio" is dead-end advice - the
      // action that actually works (validated live 3x, 2026-07-11) is opening
      // Assistant Settings > MCP Servers inside the already-open Studio.
      const procUp = s.studioProc === true;
      let txt;
      if (!s.connected) txt = "Local connection offline - launch start.bat";
      else if (!ok && addonOk) {
        const names = readyAddons.map((x) => x.name || x.id).join(", ");
        txt = `Local link ready - ${names} connected (${totalTools} tools synced)`;
      }
      else if (!mcpOk) txt = "Local connection ready - connect Roblox Studio or Blender";
      else if (noPlace) txt = "Roblox Studio is open without a loaded place";
      else if (noApp) txt = procUp
        ? "Studio is open but not connected - in Studio, open Assistant Settings > MCP Servers (or toggle its MCP server off/on)"
        : "Roblox Studio not connected - open it and enable its MCP server";
      else if (studioOff) txt = "Studio not connected, enable the MCP server in Roblox Studio";
      else txt = `Local link ready · ${totalTools} tools synced`;
      dot.title = txt; // full bridge detail on hover over the status dot
      bridgeOk = anyTargetOk;
      studioOk = ok;
      studioDown = studioOff;
      placeDown = noPlace;
      appDown = noApp;
      studioProcUp = procUp;
      // Bridge-drop alert: a clear, persistent red banner the moment a
      // previously-connected bridge goes offline. Clears on reconnect.
      if (wasConnected && !s.connected) bridgeAlert(true);
      if (s.connected) bridgeAlert(false);
      wasConnected = s.connected;
      // Once the bridge has connected at least once, onboarding is done: never
      // resurface the "download the bridge" setup card again (otherwise, if the
      // bridge later drops, it would reappear on top of the bridge-lost banner).
      if (s.connected && !setupSeen) {
        setupSeen = true;
        safeStorageSet({ zsSetupSeen: true });
      }
      renderBar();
      refreshSetup(s.connected);
    }

    // Show (on=true) / clear (on=false) the bridge-disconnected red banner.
    function bridgeAlert(on) {
      if (!on) {
        if (bridgeBannerEl) { bridgeBannerEl.remove(); bridgeBannerEl = null; }
        return;
      }
      if (bridgeBannerEl) return; // already shown
      const b = document.createElement("div");
      b.className = "zs-banner limit";
      b.innerHTML = `<div class="zs-banner-t">ViewCoder connection paused</div>
        <div class="zs-banner-m">The local connection is no longer responding. Launch <span class="zs-start-hint">start.bat</span> and keep the target app open; this chat will reconnect when it becomes available.</div>
        <div class="zs-banner-acts"><button class="zs-banner-x">Dismiss</button></div>`;
      b.querySelector(".zs-banner-x").addEventListener("click", () => { b.remove(); if (bridgeBannerEl === b) bridgeBannerEl = null; });
      root.appendChild(b);
      bridgeBannerEl = b;
    }

    // Show (v=true) / hide the "■ Stop" button while the agent is busy. The
    // primary action button swaps out for it (handled in renderBar via busy).
    // Forced hidden during bootstrap (A.starting) so the bar stays on "Starting…"
    // (else it flickers Starting → Stop → Starting as generation toggles). The
    // caller decides the rest, including native-stop de-duplication.
    function showStop(v) {
      if (!stopBtn) return;
      // Stay visible while winding down (A.stopping), so the button doesn't blink
      // off when the live generation signal toggles as the loop drains.
      const allow = (v || A.stopping) && !A.starting;
      const was = stopBtn.hidden;
      stopBtn.hidden = !allow;
      // Restore the normal, clickable Stop look whenever we're shown for a fresh
      // active turn (not a stop-in-progress).
      if (allow && !A.stopping && stopBtn.dataset.state === "stopping") {
        stopBtn.disabled = false;
        stopBtn.textContent = "■ Stop";
        delete stopBtn.dataset.state;
      }
      if (was !== stopBtn.hidden) renderBar(); // reflect the action/stop swap
    }

    // Instant feedback the moment the user clicks Stop: lock the button into a
    // disabled "⏳ Stopping…" state so they see it registered, even though the
    // loop takes a beat to actually wind down (finish the in-flight tool/await).
    function markStopping() {
      if (!stopBtn) return;
      stopBtn.hidden = false;
      stopBtn.disabled = true;
      stopBtn.dataset.state = "stopping";
      stopBtn.textContent = "⏳ Stopping…";
      renderBar();
      // If the provider swallowed its first native stop click, let the user
      // explicitly retry while the automatic bounded retry sequence continues.
      setTimeout(() => {
        if (!A.stopping || stopBtn.dataset.state !== "stopping") return;
        stopBtn.disabled = false;
        stopBtn.textContent = "■ Stop again";
      }, 900);
    }

    // A gentle, one-time nudge: the user typed on a fresh chat without starting
    // the agent. We do NOT block the send (plain chat is fine) - we just point at
    // the Start button so they discover how to enable Roblox control.
    let nudged = false;
    function nudgeStart() {
      if (A.started || !P.isFreshChat()) return;
      if (!nudged) {
        nudged = true;
        toast("Choose “Start ViewCoder” when you want this AI to work in a connected app.");
      }
      if (!actionBtn) return;
      actionBtn.classList.add("zs-flash");
      setTimeout(() => actionBtn.classList.remove("zs-flash"), 1200);
    }

    // ── Theme auto-detection (light / dark) ─────────────────────────────────
    // The panel and the in-conversation chips are dark-themed by default. On a
    // LIGHT host page the chips' light text on a near-transparent tint becomes
    // invisible, so we detect the page's effective background luminance and add
    // `.zs-light` to <html>; overlay.css then flips to readable light colours.
    // Most chat sites declare their theme EXPLICITLY (a `dark`/`light` class on
    // <html>/<body>, a data-theme attribute, or CSS color-scheme) - far more
    // reliable than luminance, since many (e.g. z.ai) leave <html>/<body> with a
    // transparent background and paint the theme on a deeper container. Returns
    // "light" | "dark" | null (no explicit signal).
    function pageThemeHint() {
      const de = document.documentElement, b = document.body;
      const cls = (de.className + " " + (b ? b.className : "")).toLowerCase();
      if (/\bdark\b/.test(cls)) return "dark";
      if (/\blight\b/.test(cls)) return "light";
      const attr = (de.getAttribute("data-theme") || de.getAttribute("data-color-mode") ||
                    de.getAttribute("data-color-scheme") || "").toLowerCase();
      if (/dark/.test(attr)) return "dark";
      if (/light/.test(attr)) return "light";
      const cs = (getComputedStyle(de).colorScheme || "").toLowerCase();
      if (/dark/.test(cs) && !/light/.test(cs)) return "dark";
      if (/light/.test(cs) && !/dark/.test(cs)) return "light";
      return null;
    }
    // Fallback only: luminance of the first opaque background up the tree.
    function effectiveBg() {
      let n = document.body;
      while (n && n !== document.documentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && !/(transparent)/.test(c) && !/,\s*0\s*\)$/.test(c)) return c;
        n = n.parentElement;
      }
      return getComputedStyle(document.documentElement).backgroundColor || "rgb(255,255,255)";
    }
    function applyTheme() {
      let light;
      const hint = pageThemeHint();
      if (hint) {
        light = hint === "light";
      } else {
        const m = (effectiveBg().match(/\d+(?:\.\d+)?/g) || []).map(Number);
        if (m.length < 3) return;
        light = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2] > 140;
      }
      document.documentElement.classList.toggle("zs-light", light);
    }

    // Where the bar lives INSIDE the site's composer. We insert it as a real,
    // in-flow DOM node (between the model tabs and the input on DeepSeek), so it
    // takes the full composer width and never overlaps the site's own controls.
    // The mount point is derived from each provider's composerFrame()+getEditor(),
    // or a provider can override it via barMount(). Returns {parent, before}.
    // The provider decides the exact mount (it knows which element is the input
    // box and where a child reflows cleanly). If a provider doesn't supply one,
    // we fall back to the floating bar rather than risk overlapping its layout.
    function computeBarMount() {
      if (!P.barMount) return null;
      const m = P.barMount();
      return (m && m.parent && m.parent.isConnected) ? m : null;
    }

    // Floating fallback geometry (used only when no inline mount is available).
    const BAR_MAX_W = 560, BAR_GAP = 8;

    // Anchored mode bookkeeping: the composer element whose top padding we are
    // borrowing to seat the bar (see the anchored branch below). Cleared when we
    // leave anchored mode so the site's composer returns to its normal layout.
    let anchorPadEl = null;
    let anchorPadValue = "";
    function clearAnchorPad() {
      if (anchorPadEl) {
        try { anchorPadEl.style.paddingTop = anchorPadValue; } catch {}
        anchorPadEl = null;
        anchorPadValue = "";
      }
    }

    // Position ViewCoder's provider notice just above the bar's right edge.
    function placeUnstable() {
      const u = unstableEl;
      if (!u) return;
      if (!bar || bar.style.display === "none") { if (!u.hidden) u.hidden = true; return; }
      const br = bar.getBoundingClientRect();
      if (!br.width) { if (!u.hidden) u.hidden = true; return; }
      if (u.hidden) u.hidden = false;
      const uh = u.offsetHeight || 20;
      const uw = u.offsetWidth || 66;
      u.style.left = Math.round(Math.max(4, br.right - uw)) + "px";
      u.style.top = Math.round(Math.max(4, br.top - uh - 5)) + "px";
    }

    function placeModeMenu() {
      if (!modeMenuEl || modeMenuEl.hidden || !modeBtn) return;
      const rect = modeBtn.getBoundingClientRect();
      if (!rect.width) return;
      const width = modeMenuEl.offsetWidth || 188;
      const height = modeMenuEl.offsetHeight || 82;
      const left = Math.max(6, Math.min(window.innerWidth - width - 6, rect.right - width));
      const above = rect.top - height - 6;
      const top = above >= 6 ? above : Math.min(window.innerHeight - height - 6, rect.bottom + 6);
      modeMenuEl.style.left = Math.round(left) + "px";
      modeMenuEl.style.top = Math.round(top) + "px";
    }

    // Provider-specific modal probes handle unusual frameworks (Kimi's masks,
    // captchas, etc.). Keep a generic accessible-dialog fallback as well: a
    // provider can add a new announcement/login modal without changing its
    // adapter, and our very high z-index would otherwise place the ViewCoder bar
    // on top of that modal and block its controls.
    function pageOverlayBlocking() {
      try {
        if (P.overlayBlocking && P.overlayBlocking()) return true;
      } catch {}
      try {
        for (const el of document.querySelectorAll(
          '[role="dialog"], [aria-modal="true"]',
        )) {
          if (el.closest("#zs-root")) continue;
          const style = getComputedStyle(el);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number.parseFloat(style.opacity || "1") === 0
          ) continue;
          const r = el.getBoundingClientRect();
          if (
            r.width >= 120 &&
            r.height >= 80 &&
            r.bottom > 0 &&
            r.right > 0 &&
            r.top < innerHeight &&
            r.left < innerWidth
          ) return true;
        }
      } catch {}
      return false;
    }

    function requestBarPlacement() {
      if (placementFrame || !bar) return;
      placementFrame = requestAnimationFrame(() => {
        placementFrame = 0;
        placeBar();
      });
    }

    function placeBar() {
      // Geometry reads force layout on every provider. Keep them responsive while
      // a task is moving, but back off sharply while idle (especially in a hidden
      // Active Mode tab). Scheduling first preserves the self-healing guarantee
      // even when a provider swaps its composer during this pass.
      clearTimeout(barTimer);
      const barBusy =
        A.starting || A.injecting || A.awaitingReply || A.running ||
        A.toolRunning || A.stopping;
      const barDelay = document.hidden
        ? (A.activeMode && barBusy
            ? 550
            : 1800)
        : (barBusy ? 180 : 650);
      barTimer = setTimeout(placeBar, barDelay);
      if (!bar) return;

      // Self-heal: a SPA navigation or a full re-render on the host (seen on Arena
      // when the message frame jumps/teleports to the bottom) can detach our whole
      // #zs-root from <html>, taking the bar with it - and nothing re-adds it, so
      // the panel just vanishes. Re-append it whenever it's been detached; this
      // layout loop is resilient (its next pass is scheduled before any body code),
      // so the panel reappears within a tenth of a second.
      if (root && !root.isConnected) {
        try { document.documentElement.appendChild(root); } catch {}
      }

      // The instability warning floats just ABOVE the bar (not inside it), so it
      // never crowds the row on narrow composers like Gemini. Positioned from the
      // bar's current rect every layout pass - works in all bar modes since it only
      // reads where the bar ended up. One frame of lag is imperceptible.
      placeUnstable();
      placeModeMenu();

      // While a bot-check challenge OR a blocking modal (login / consent) is on
      // screen, get fully out of the way: the (often transparent) anchored bar is
      // a real full-width element over the composer's top edge and would silently
      // intercept clicks on the challenge's / modal's buttons (e.g. "Continue with
      // Google" at sign-in). Hide the bar and drop the reserved padding strip; it
      // reappears on the next layout pass once the overlay clears.
      if (
        (P.captchaPresent && P.captchaPresent()) ||
        pageOverlayBlocking()
      ) {
        bar.style.display = "none";
        clearAnchorPad();
        if (unstableEl) unstableEl.hidden = true;
        if (menuEl) menuEl.hidden = true;
        if (modeMenuEl) modeMenuEl.hidden = true;
        return;
      }

      // Preferred: in-flow mount inside the composer (no overlap, full width).
      const mount = computeBarMount();
      if (mount) {
        clearAnchorPad();
        if (bar.parentElement !== mount.parent || bar.nextElementSibling !== mount.before) {
          try { mount.parent.insertBefore(bar, mount.before || null); } catch {}
        }
        if (!bar.classList.contains("zs-bar-inline")) {
          bar.classList.add("zs-bar-inline");
          bar.style.cssText = ""; // drop any leftover float positioning
        }
        // Transparent (blends in) when mounted INSIDE the input box; surface card
        // when mounted ABOVE it. The provider's barMount() signals which via .inside.
        bar.classList.toggle("zs-bar-inside", !!mount.inside);
        bar.style.display = "flex";
        if (menuEl && !menuEl.hidden) {
          const br = bar.getBoundingClientRect();
          menuEl.style.right = Math.round(window.innerWidth - br.right) + "px";
          menuEl.style.bottom = Math.round(window.innerHeight - br.top + 6) + "px";
          menuEl.style.maxHeight = Math.max(140, Math.round(br.top - 16)) + "px";
        }
        return;
      }

      // Anchored mode: the provider wants the integrated, in-composer LOOK but
      // its composer is a framework-reconciled subtree we must NOT insert our
      // node into (e.g. Kimi's Vue tree - inserting #zs-bar there makes Vue's
      // next diff reuse the bar node as a host and nest the editor inside it).
      // So we keep the bar in our own #zs-root, position it (position:fixed) to
      // hug the composer's top edge at full width, and RESERVE that strip with
      // padding-top on the composer so it reads as in-flow without ever becoming
      // a child of the framework's DOM. barAnchor() returns the element to hug.
      const anchorEl = (P.barAnchor && P.barAnchor()) || null;
      if (anchorEl && anchorEl.isConnected) {
        bar.classList.remove("zs-bar-inline", "zs-bar-inside");
        bar.classList.add("zs-bar-anchored");
        if (root && bar.parentElement !== root) root.appendChild(bar);
        const r = anchorEl.getBoundingClientRect();
        if (!r.width) { bar.style.display = "none"; clearAnchorPad(); if (menuEl) menuEl.hidden = true; return; }
        bar.style.display = "flex";
        const bh = bar.offsetHeight || 34;
        if (anchorPadEl && anchorPadEl !== anchorEl) clearAnchorPad();
        if (anchorPadEl !== anchorEl) {
          anchorPadEl = anchorEl;
          anchorPadValue = anchorEl.style.paddingTop;
        }
        anchorEl.style.paddingTop = (bh + 6) + "px"; // reserve the strip the bar sits in (+gap)
        bar.style.left = Math.round(r.left) + "px";
        bar.style.top = Math.round(r.top) + "px";
        bar.style.width = Math.round(r.width) + "px";
        if (menuEl && !menuEl.hidden) {
          bar.classList.remove("zs-bar-inline"); // ensure fixed geometry for menu math
          menuEl.style.right = Math.round(window.innerWidth - (r.left + r.width)) + "px";
          menuEl.style.bottom = Math.round(window.innerHeight - r.top + 6) + "px";
          menuEl.style.maxHeight = Math.max(140, Math.round(r.top - 16)) + "px";
        }
        return;
      }
      bar.classList.remove("zs-bar-anchored");
      clearAnchorPad();

      // Fallback: float just above the editor (fixed positioning), for sites
      // where no clean inline mount could be resolved.
      if (bar.classList.contains("zs-bar-inline")) {
        bar.classList.remove("zs-bar-inline");
        if (root && bar.parentElement !== root) root.appendChild(bar);
      }
      const f = (P.getEditor && P.getEditor()) || (P.composerFrame && P.composerFrame());
      if (!f) { bar.style.display = "none"; if (menuEl) menuEl.hidden = true; return; }
      bar.style.display = "flex";
      const r = f.getBoundingClientRect();
      if (!r.width) { bar.style.display = "none"; return; }
      const w = Math.min(r.width, BAR_MAX_W);
      const left = Math.round(r.left + (r.width - w) / 2);
      const bh = bar.offsetHeight || 40;
      const top = Math.max(4, Math.round(r.top - bh - BAR_GAP));
      bar.style.width = w + "px";
      bar.style.left = left + "px";
      bar.style.top = top + "px";
      // Keep the open "more" menu anchored to the bar, opening upward.
      if (menuEl && !menuEl.hidden) {
        const br = bar.getBoundingClientRect();
        menuEl.style.right = Math.round(window.innerWidth - br.right) + "px";
        menuEl.style.bottom = Math.round(window.innerHeight - br.top + 6) + "px";
        menuEl.style.maxHeight = Math.max(140, Math.round(br.top - 16)) + "px";
      }
    }

    // Called by the core's sweep + after state changes: refresh the bar content.
    // (Positioning runs continuously in placeBar; this only updates what's shown.)
    function updateStartGate() {
      renderBar();
      requestBarPlacement();
    }

    // Masks the input box while the extension types/sends, so the copied text
    // and the submit aren't visible to the user.
    // Returns a FULLY OPAQUE colour that matches what is VISUALLY behind the cover.
    // The cover must hide the typed text, so it can't be translucent - but simply
    // returning the first solid ancestor is wrong when the composer surface itself
    // is translucent: Meta's card is rgba(56,56,56,0.8) over a dark page, so its
    // real on-screen colour is a BLEND (~rgb(50,50,50)), lighter than the bare page
    // (rgb(24,24,25)). Filling the cover with the page colour made it visibly
    // darker than the composer. So collect the background layers from `el` up to
    // the first opaque ancestor and FLATTEN them (alpha compositing) into one solid
    // colour that reproduces the composer's actual appearance.
    function opaqueBg(el) {
      const layers = [];
      let n = el;
      while (n && n !== document.documentElement) {
        const c = parseColor(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) {
          layers.push(c);
          if (c.a >= 0.999) break; // opaque base reached - nothing behind matters
        }
        n = n.parentElement;
      }
      // Guarantee an opaque base at the bottom of the stack.
      if (!layers.length || layers[layers.length - 1].a < 0.999) {
        const base = parseColor(getComputedStyle(document.body).backgroundColor) ||
                     { r: 255, g: 255, b: 255, a: 1 };
        layers.push({ r: base.r, g: base.g, b: base.b, a: 1 });
      }
      // We collected top-most (el) first, so composite from the opaque base (last)
      // upward toward el (first).
      let out = layers[layers.length - 1];
      for (let i = layers.length - 2; i >= 0; i--) out = blendOver(layers[i], out);
      return `rgb(${Math.round(out.r)}, ${Math.round(out.g)}, ${Math.round(out.b)})`;
    }
    // Parse an rgb()/rgba() computed colour into {r,g,b,a}. Returns null for
    // "transparent"/unparseable. getComputedStyle always yields rgb/rgba form.
    function parseColor(c) {
      if (!c || c === "transparent") return null;
      const m = c.match(/rgba?\(([^)]+)\)/i);
      if (!m) return null;
      const p = m[1].split(",").map((x) => parseFloat(x));
      return { r: p[0], g: p[1], b: p[2], a: p.length >= 4 ? p[3] : 1 };
    }
    // Source-over compositing of a (possibly translucent) fg onto an opaque bg.
    function blendOver(fg, bg) {
      const a = fg.a;
      return {
        r: fg.r * a + bg.r * (1 - a),
        g: fg.g * a + bg.g * (1 - a),
        b: fg.b * a + bg.b * (1 - a),
        a: 1,
      };
    }

    function inputCover(on, requestedMode = "", options = {}) {
      const ed = P.getEditor();
      if (!on) {
        if (cover) {
          cover.style.display = "none";
          cover.dataset.on = "";
        }
        if (ed) ed.classList.remove("zs-typing");
        // Providers replace composer nodes during long turns. Release every
        // still-connected node ViewCoder constrained, not just today's editor.
        document.querySelectorAll(".zs-typing").forEach((node) =>
          node.classList.remove("zs-typing"));
        clearTimeout(coverTimer);
        cancelAnimationFrame(coverResizeFrame);
        coverResizeObserver?.disconnect();
        coverResizeObserver = null;
        coverObservedNode = null;
        return;
      }
      if (!ed) return;
      ed.classList.add("zs-typing"); // make the typed text itself invisible
      if (!cover) {
        cover = document.createElement("div");
        cover.id = "zs-input-cover";
        cover.innerHTML =
          `<span class="zs-cover-label"></span>` +
          `<span class="zs-work-dots" aria-hidden="true"><i></i><i></i><i></i></span>`;
        document.documentElement.appendChild(cover);
      }
      const coverMode = requestedMode === "connecting" || (!requestedMode && A.starting)
        ? "connecting"
        : "working";
      if (cover.dataset.mode !== coverMode) {
        const label = coverMode === "connecting"
          ? "ViewCoder Is Connecting"
          : "ViewCoder Is Working";
        const labelEl = cover.querySelector(".zs-cover-label");
        if (labelEl) labelEl.textContent = label;
        cover.dataset.mode = coverMode;
        cover.setAttribute("aria-label", label + "...");
      }
      cover.dataset.on = "1"; // intent flag: keep the place() loop alive while set
      cover.style.display = "flex";
      // sendHidden() can be nested inside the startup/agent phase, both of which
      // already own the cover. Cancel the previous scheduled pass before starting
      // this one so repeated calls never accumulate competing layout loops.
      clearTimeout(coverTimer);
      cancelAnimationFrame(coverResizeFrame);
      coverResizeObserver?.disconnect();
      coverResizeObserver = null;
      coverObservedNode = null;
      const place = () => {
        // Loop runs while the cover is INTENDED on (dataset.on), not while it's
        // visible - so we can hide it for an overlay and still restore it after.
        if (!cover || cover.dataset.on !== "1") return;
        // Schedule first. If a provider's framework replaces the composer midway
        // through this pass and one DOM read throws, the next pass still repairs
        // the cover as soon as the host UI settles.
        clearTimeout(coverTimer);
        // The cover is only alive during a ViewCoder-owned send. Three visible
        // measurements per second track composer movement without continually
        // forcing layout; hidden Active Mode work needs even fewer passes.
        coverTimer = setTimeout(place, document.hidden ? 800 : 300);
        const e = P.getEditor();
        if (!e) return;
        // Re-assert the typing mask on the CURRENT editor node: sites that
        // recreate the editor on each inject/clear (Kimi's Vue) drop the class,
        // which would un-hide the raw text and un-cap its height. Cheap idempotent
        // add on every pass keeps the mask + height cap glued to the live node.
        if (!e.classList.contains("zs-typing")) e.classList.add("zs-typing");
        // Hide the provider's COMPLETE native prompt bar while ViewCoder owns the
        // turn: editor, model picker, attachment controls and send controls. Each
        // provider exposes the exact rounded composer element as coverTarget;
        // composerFrame is the safe fallback for future providers.
        const covNode =
          (P.coverTarget && P.coverTarget()) ||
          (P.composerFrame && P.composerFrame()) ||
          e;
        const coversWholeComposer = covNode !== e;
        // Provider composers grow as their hidden text wraps and shrink again
        // after a send. Observe that exact rounded card so the gray replacement
        // mirrors every native height change in the next animation frame. The
        // periodic pass below remains as a fallback for node replacement and
        // background-tab throttling.
        if (coverObservedNode !== covNode && typeof ResizeObserver === "function") {
          coverResizeObserver?.disconnect();
          coverObservedNode = covNode;
          coverResizeObserver = new ResizeObserver(() => {
            if (!cover || cover.dataset.on !== "1") return;
            cancelAnimationFrame(coverResizeFrame);
            coverResizeFrame = requestAnimationFrame(place);
          });
          coverResizeObserver.observe(covNode);
        }
        // While a blocking modal (login / consent) or bot-check is up, hide the
        // cover so it doesn't sit on top of the modal; it reappears once the
        // overlay clears (the loop keeps running).
        if (
          pageOverlayBlocking() ||
          (P.captchaPresent && P.captchaPresent())
        ) {
          cover.style.display = "none";
          return;
        }
        cover.style.display = "flex";
        let r = covNode.getBoundingClientRect();
        // Anchored providers reserve a strip at the top of their composer for
        // ViewCoder's own status row. That row has a higher z-index and must stay
        // visible; exclude only its overlapping strip so the label centres in the
        // native prompt area rather than in status padding.
        const statusBar = document.getElementById("zs-bar");
        if (statusBar) {
          const br = statusBar.getBoundingClientRect();
          const overlaps =
            br.bottom > r.top && br.top < r.bottom &&
            br.right > r.left && br.left < r.right;
          if (overlaps && br.bottom < r.bottom) {
            const top = Math.max(r.top, br.bottom);
            r = new DOMRect(r.left, top, r.width, r.bottom - top);
          }
        }
        // Clip the cover to the composer's VISIBLE band. Some composers grow the
        // inner editor node past a scrolling ancestor that clips it (Kimi's Vue
        // RECREATES .chat-input-editor on every inject/clear, dropping the
        // .zs-typing height cap, so the editor balloons to ~1500px while its
        // .chat-input-editor-container caps the visible box via overflow:auto).
        // Measuring the raw editor then centres the cover on the giant editor's
        // midpoint - far below the visible input - so it "vanishes" off the box.
        // Intersect with the nearest clipping ancestor to track what's on screen.
        for (let a = covNode.parentElement, i = 0; a && a !== document.body && i < 8; a = a.parentElement, i++) {
          const ov = getComputedStyle(a).overflowY;
          if (ov === "auto" || ov === "scroll" || ov === "hidden") {
            const ar = a.getBoundingClientRect();
            const top = Math.max(r.top, ar.top);
            const bottom = Math.min(r.bottom, ar.bottom);
            if (bottom > top) r = new DOMRect(r.left, top, r.width, bottom - top);
            break;
          }
        }
        // Do not freeze the real prompt card at an earlier idle height. The
        // editor's temporary .zs-typing cap prevents unbounded ballooning while
        // this live rectangle lets the cover grow and shrink in perfect sync
        // with multiline text, attachments, model controls, and provider chrome.
        // Provider padding/nudging is only for the emergency editor fallback.
        // A resolved whole-composer target must use its exact rectangle so the
        // overlay follows the native prompt card without bleeding past its edge.
        const PAD = coversWholeComposer ? 0 : (P.coverPad || 0);
        const OFFY = coversWholeComposer ? 0 : (P.coverOffsetY || 0);
        // Whole prompt cards retain their full native height. The 200px ceiling
        // remains only for an editor fallback whose host unexpectedly balloons.
        const MAXH = coversWholeComposer
          ? Math.max(r.height, P.coverMaxH || 36)
          : (P.coverMaxH || 200);
        const h = Math.min(Math.max(r.height + PAD * 2, 36), MAXH);
        const centerY = r.top + r.height / 2 + OFFY;
        cover.style.left = Math.round(r.left - PAD) + "px";
        cover.style.top = Math.round(centerY - h / 2) + "px";
        cover.style.width = Math.round(r.width + PAD * 2) + "px";
        cover.style.height = Math.round(h) + "px";
        // Sample the target itself, exactly as ZeroScript does. Transparent
        // editors flatten through to their composer's gray surface (Gemini's is
        // rgb(30,31,32)) instead of accidentally inheriting the black page.
        cover.style.background = opaqueBg(covNode);
        const targetRadius = P.coverTarget
          ? getComputedStyle(covNode).borderRadius
          : "";
        cover.style.borderRadius = targetRadius && targetRadius !== "0px"
          ? targetRadius
          : "14px";
      };
      place();
    }

    function scheduleCommunityReminder() {
      if (communityReminderScheduled) return;
      communityReminderScheduled = true;
      const check = () => {
        try {
          chrome.storage.local.get("viewcoderCommunityReminderAt", (stored) => {
            const lastShownAt = Number(stored?.viewcoderCommunityReminderAt || 0);
            if (Date.now() - lastShownAt < COMMUNITY_REMINDER_INTERVAL_MS) return;
            const busy =
              !A.started || A.starting || A.injecting || A.awaitingReply ||
              A.running || A.toolRunning || A.stopping || generationForUi() ||
              document.hidden || pageOverlayBlocking();
            if (busy) {
              setTimeout(check, 60_000);
              return;
            }
            safeStorageSet({ viewcoderCommunityReminderAt: Date.now() });
            showCommunityReminder();
          });
        } catch {}
      };
      setTimeout(check, COMMUNITY_REMINDER_DELAY_MS);
    }

    function showCommunityReminder() {
      if (!root || root.querySelector("#zs-community-reminder")) return;
      const card = document.createElement("aside");
      card.id = "zs-community-reminder";
      card.setAttribute("aria-label", "ViewCoder Discord invitation");
      const discordLogo = discordEl?.querySelector("svg")?.outerHTML || "";
      card.innerHTML = `<span class="zs-community-reminder-logo" aria-hidden="true">${discordLogo}</span>
        <span class="zs-community-reminder-copy"><b>Join the ViewCoder Discord?</b><small>Get help, share feedback, and support the community.</small></span>
        <span class="zs-community-reminder-actions"><button class="zs-community-join" type="button">Join Discord</button><button class="zs-community-later" type="button">Not now</button></span>`;
      card.querySelector(".zs-community-join")?.addEventListener("click", () => {
        try { window.open(VIEWCODER_DISCORD_URL, "_blank", "noopener,noreferrer"); } catch {}
        card.remove();
      });
      card.querySelector(".zs-community-later")?.addEventListener("click", () => card.remove());
      root.appendChild(card);
    }

    function toast(msg) {
      const t = document.createElement("div");
      t.className = "zs-toast";
      t.textContent = msg;
      root.appendChild(t);
      setTimeout(() => t.classList.add("show"), 10);
      setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3500);
    }

    function banner(kind, title, msg) {
      const b = document.createElement("div");
      b.className = `zs-banner ${kind}`;
      b.innerHTML = `<div class="zs-banner-t"></div><div class="zs-banner-m"></div>
        <div class="zs-banner-acts">
          <button class="zs-banner-x">Close</button>
        </div>`;
      b.querySelector(".zs-banner-t").textContent = title;
      b.querySelector(".zs-banner-m").textContent = msg;
      b.querySelector(".zs-banner-x").addEventListener("click", () => b.remove());
      root.appendChild(b);
    }

    // Left-hand ViewCoder popup showing the latest screen_capture. Fed from the
    // in-memory base64 (a data: URL always renders), so it works identically on
    // every provider and never touches the site's DOM. Only the most recent
    // capture is kept - a new one replaces the old.
    // Kept as a compatibility no-op for older callers. ViewCoder no longer
    // renders a screenshot tray for Studio or Blender results.
    function showImages() {
      root.querySelectorAll(".zs-shot").forEach((e) => e.remove());
    }

    build();
    return { setStatus, setStarted, setStarting, showStop, markStopping, inputCover, toast, banner, showImages, nudgeStart, updateStartGate, refreshSetup, getCustomPrompt };
  })();

  // ── Live token + timer, shown ONLY on a tool call's chip detail. The
  //    elapsed-time ANCHOR is stored on the chip's DOM node (dataset) so the
  //    timer survives re-renders / conversation switches. ────────────────────
  const TOKEN_CHARS = 4;

  // 0-999 as-is; 1000+ compacted to 1k/1.1k/99k/1M... (one decimal below 10 of
  // the unit, none at/above it, trailing ".0" dropped) so a live token count
  // doesn't grow into a wide, jumpy number as the reply streams in.
  function formatCount(n) {
    if (n < 1000) return String(n);
    const units = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
    for (const [div, suf] of units) {
      if (n >= div) {
        const v = n / div;
        const rounded = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
        return rounded + suf;
      }
    }
    return String(n);
  }

  function setChipDetail(item, text) {
    const dt = item && item.querySelector(".zs-chip .zs-chip-dt");
    // Avoid generating a MutationObserver event when the rounded timer/token
    // string has not changed. During long tool runs the meter ticks four times a
    // second; redundant writes previously scheduled unnecessary full-chat sweeps.
    if (dt && dt.textContent !== text) dt.textContent = text;
  }

  // Update ONLY the chip's label text (no innerHTML rebuild), so live-correcting
  // the name mid-stream doesn't restart the spinner or wipe the token meter.
  function setChipLabel(item, text) {
    const tx = item && item.querySelector(".zs-chip .zs-chip-tx");
    if (tx && tx.textContent !== text) tx.textContent = text;
  }

  // Elapsed seconds since a per-item anchor (persisted on the node).
  function elapsedOn(item, key, fallbackStart) {
    if (!item) return 0;
    let t0 = Number(item.dataset[key] || 0);
    if (!t0) { t0 = fallbackStart || Date.now(); item.dataset[key] = String(t0); }
    return (Date.now() - t0) / 1000;
  }

  // Timestamp of the user's last REAL click on the site (trusted event, outside
  // ViewCoder's own UI). A genuine "regenerate ↻" is always such a click;
  // DeepSeek's post-stop phantom generations and stop-button re-mount flickers
  // never are - this is what tells them apart (seen live: two false regenResume
  // fired 8s/2s after a Stop with no user action, un-stopping the halted turn).
  let _userClickAt = 0;
  document.addEventListener("click", (e) => {
    if (e.isTrusted && !(e.target && e.target.closest && e.target.closest("#zs-root"))) {
      _userClickAt = Date.now();
    }
  }, true);

  let _prevHardGen = null, _prevSoftGen = null;
  let _activitySampleAt = 0;
  setInterval(() => {
    const now = Date.now();
    const highFrequency =
      A.starting || A.injecting || A.awaitingReply || A.running ||
      A.toolRunning || A.stopping || _prevSoftGen === true;
    const sampleEvery = document.hidden
      ? (A.activeMode && highFrequency
          ? 450
          : 1400)
      : (highFrequency ? 250 : 750);
    if (now - _activitySampleAt < sampleEvery) return;
    _activitySampleAt = now;
    // A normal, never-started chat does not need ViewCoder's generation meter,
    // regenerate watchdog, turn-id tracking or stop-button reconciliation.
    // Avoid four provider DOM traversals every 250ms until the user starts the
    // agent (startup itself remains fully monitored).
    if (!A.started && !A.starting) {
      _prevHardGen = false;
      _prevSoftGen = false;
      ui.showStop(false);
      const staleCover = document.getElementById("zs-input-cover");
      if (staleCover?.dataset.on === "1") ui.inputCover(false);
      return;
    }
    const gen = P.isGenerating(); // raw provider signal for recovery/watchdogs
    const uiGen = generationForUi(gen); // filters stale provider busy markers
    // Watchdog freshness clock. Growth-tolerant (not just the hard stop-button
    // signal): a SHORT command after a long reasoning phase shows its stop
    // square for only a frame or two - too briefly for this 200ms sampler.
    if (gen) A.lastGenAt = Date.now();
    // High-water mark of the newest turn id seen this session (virtualization-
    // safe). The auto-resume watchdog uses it to IGNORE a scrolled-back OLD turn:
    // on a virtualized list lastAssistant() is the last RENDERED turn, which when
    // scrolled up is old, and its injected-result row is off-screen/unrendered so
    // the "result below" guard can't see it. A numeric provider id (DeepSeek's
    // data-virtual-list-item-key) is monotonic per turn, so the max only grows at
    // the live bottom and a scrolled-back turn reads strictly below it.
    if (P.itemKey && P.lastAssistantId) {
      const nk = Number(P.lastAssistantId());
      if (Number.isFinite(nk) && (A.maxTurnId == null || nk > A.maxTurnId)) A.maxTurnId = nk;
    }
    // Slide the regenerate grace anchor while generation is still (intermittently)
    // active, so the chip stays "run" across gen-false blips right up to the moment
    // the watchdog re-owns the tool (see regenResume).
    if (A.resumeArmed && gen) A.resumeArmedAt = Date.now();
    const hardGen = A.started && P.isHardGenerating();

    // Regenerate-as-resume: after a manual stop (A.userStopped) the agent stays
    // dormant until fresh user intent. Typing a message or the native Continue
    // clears the latch, but clicking the site's "regenerate ↻" does not - and on
    // Qwen that control is unlabeled and indistinguishable from copy/like, so we
    // can't hook the button reliably. Detect the EFFECT instead: a brand-new
    // generation (gen false→true) while we are stopped and otherwise idle can only
    // come from a user action (there is no spontaneous generation). Treat it as
    // resume - clear the stop latch and drop the turn's stopped/no-resume markers
    // so the auto-resume watchdog can pick the regenerated reply's tool back up.
    // Providers with NO native "regenerate" control (e.g. ReidChat) can opt out
    // via hasRegenerate:false - for them a gen false→true blip while stopped is
    // only abort/caret churn, never a real regenerate, so honouring it would
    // spuriously clear the manual-stop latch and auto-resume against the user.
    // HARD edge only: the growth-tolerant `gen` blips false→true when the site
    // re-renders the HALTED turn after a stop (adding its "Stopped" marker grows
    // streamText, which counts as growth for 800ms) - that blip falsely cleared
    // the latch, repainted the stopped chip ✓ green and re-armed auto-resume. A
    // real regenerate always raises the site's stop control, so require it; on
    // DeepSeek (no stop control during reasoning) this merely delays the resume
    // to the answer phase, after which the watchdog acts anyway.
    // Tracker: a soft (growth-only) blip in the stopped-idle state - exactly the
    // false trigger the hard-edge gate above filters out. Log it so live tests
    // can SEE the old bug firing and being ignored.
    if (A.started && A.userStopped && !A.running && !A.injecting && !A.stopping &&
        gen && _prevSoftGen === false && !hardGen) {
      diag("regenBlip.ignored");
    }
    if (P.hasRegenerate !== false &&
        A.started && A.userStopped && !A.running && !A.injecting && !A.stopping &&
        hardGen && _prevHardGen === false) {
      // Gate on ACTUAL user intent: a real regenerate is always a trusted click
      // moments before the new generation, and never the Stop click itself.
      // Distinguish the two by ORDER, not a fixed delay: require the latest
      // trusted click to fall clearly AFTER the Stop (clickAfterStop). A native
      // stop click lands ~at A.stopAt, so it fails this and can't self-resume;
      // the extension's own "■ Stop" is inside #zs-root and never updates
      // _userClickAt at all, so only the later regenerate qualifies. This
      // replaces the old absolute `stopAge > 3000` grace, which also blocked a
      // user who regenerated quickly (~1.5s) after Stop - the real bug seen live.
      // DeepSeek's post-stop phantom generations carry no fresh trusted click,
      // so they still fail the gate.
      const clickAge = Date.now() - _userClickAt;
      const stopAge = Date.now() - (A.stopAt || 0);
      const clickAfterStop = _userClickAt - (A.stopAt || 0);
      if (clickAge < 2500 && clickAfterStop > 400) {
        A.userStopped = false;
        const it = P.lastAssistant();
        if (it) {
          delete it.dataset.zStopped; delete it.dataset.zResume;
          delete it.dataset.zResumeLen; delete it.dataset.zloop;
          forgetHalted(it);
          // Strip the OLD command's chip immediately. The regenerate reuses this
          // turn node, and without this the previous execute_luau chip (with its
          // spinner/settled state) lingers for ~200ms until the sweep repaints the
          // node - the visible "it keeps running the old call for a beat before
          // restarting" flash reported on Kimi. resetDecoration clears the chip and
          // every marker so the regenerated reply classifies fresh.
          resetDecoration(it);
          // Kimi (and other node-reusing sites) leave the OLD command text in the
          // reply DOM for ~2s after regenerate starts, before wiping it and
          // streaming the new reply. resetDecoration only removes OUR chip - the
          // sweep then re-derives a fresh "run" chip from that stale old command
          // (old token count and all) until the content is replaced: the "red
          // stopped chip turns into a grey spinner on the OLD call" flash reported
          // live. Capture the old text length so the sweep can tell the DOM still
          // holds the stale command and keep the coherent red "stopped" look until
          // Kimi actually replaces it (see the zRegenLen guard in classify).
          try {
            it.dataset.zRegenLen = String(P.classifyText(it, ".zs-chip").length);
            it.dataset.zRegenAt = String(Date.now());
          } catch {}
        }
        // Bridge the gap until the auto-resume watchdog (1s interval) re-owns the
        // tool: regenResume only CLEARS the stop latch, it does not start the loop
        // (the regenerated command hasn't finished streaming yet, so there's
        // nothing to dispatch). In that ~1s window A.running is still false and
        // Gemini's generation signal blips false between reasoning and command
        // settle, so the sweep painted the chip a premature ✓ "done" before the
        // real execution began. Arm a grace anchor the sweep honours as "live"; it
        // slides while generation blips (refreshed in the meter loop) and expires
        // shortly after generation truly stops, by which point the watchdog has
        // taken over (A.running) or the reply was plain text with no tool.
        A.resumeArmed = true;
        A.resumeArmedAt = Date.now();
        diag("regenResume", { clickAge, stopAge, clickAfterStop });
      } else {
        diag("regenEdge.ignored", { clickAge, stopAge, clickAfterStop });
      }
    }
    _prevHardGen = hardGen;
    _prevSoftGen = gen;
    // Our "■ Stop" button stays visible for the WHOLE active turn (generation,
    // reasoning, or a tool/wait running on the bridge). It is complete on its own
    // - stopLoop both halts our loop AND clicks the site's native stop - and the
    // site's native stop likewise halts our loop via onNativeStop, so either one
    // fully stops everything. Two stop buttons at once is fine.
    // The bare isHardGenerating() term is gated on a live ViewCoder session: on
    // a plain chat with no session, a user's own message makes the site generate,
    // and we must NOT briefly flash our Stop button over that.
    // Self-heal a stuck "Stopping…": if we flagged stopping but nothing is
    // actually busy anymore (the loop's finally never ran because the Stop landed
    // before a loop started, or a pending start was cancelled), release it so the
    // button doesn't freeze on "Stopping…". While the site is STILL streaming,
    // re-click its native stop (throttled) instead of releasing: the first click
    // sometimes gets swallowed by a re-render, and handing back a clickable
    // "■ Stop" the user has to press again is exactly the bounce we're killing.
    if (A.stopping && !A.running && !A.toolRunning) {
      if (A.started && P.isHardGenerating()) {
        // CRITICAL: only re-click the native stop if the reply has ACTUALLY kept
        // growing since the last stop click. On Gemini (and GLM) the stop button
        // WEDGES visible for up to ~10s after a successful stop, so the old
        // unconditional retry clicked a stop with NO live stream behind it -
        // and Gemini queues that stray abort against the conversation, then
        // KILLS THE NEXT reply the instant it starts ("Vous avez interrompu
        // cette réponse" on a message the user never stopped - validated live,
        // 2026-07: two stray stop.retry clicks after a ZS Stop made the next
        // two user turns die instantly; with no stray clicks the same flow
        // worked). A swallowed first click - the case this retry exists for -
        // always shows up as the stream STILL writing, i.e. growth past the
        // baseline captured at stop time (A.stopStreamLen, set in stopLoop /
        // onNativeStop and re-based after each retry so every retry needs
        // fresh growth of its own).
        const grown = (P.streamLen ? P.streamLen() : 0) > (A.stopStreamLen || 0) + 24;
        if (grown && Date.now() - (A.stopRetryAt || 0) > 800) {
          A.stopRetryAt = Date.now();
          A.stopStreamLen = P.streamLen ? P.streamLen() : 0;
          try { P.stopGeneration(); } catch {}
          diag("stop.retry");
        } else if (!grown && Date.now() - (A.stopAt || 0) > 2500) {
          // Wedged stop button on a dead stream (text frozen since the stop):
          // the site is effectively quiet - release "Stopping…" instead of
          // holding it for the whole wedge window.
          A.stopping = false;
          diag("stop.quiet", { wedged: true });
        }
      } else {
        A.stopping = false;
        diag("stop.quiet"); // drain over: site quiet, Stopping… released
      }
    }
    const activeWork = !A.recoveryStopping && (
      A.starting ||
      A.injecting ||
      A.awaitingReply ||
      A.running ||
      A.toolRunning ||
      A.stopping ||
      // Use the provider's growth/wedge-aware generation signal here. Several
      // sites leave a stale native stop button mounted after the reply ends;
      // isHardGenerating() alone kept ViewCoder's cover over the composer and
      // made it look as though the AI was still working. Provider isGenerating()
      // retains genuine long reasoning while filtering known stale controls.
      (A.started && uiGen)
    );
    setInputLocked(activeWork);
    ui.showStop(activeWork);

    // Provider frameworks frequently replace their composer between reasoning,
    // tool execution and final-answer phases. Reconcile the cover from the same
    // authoritative state that drives the Stop button. This prevents the exact
    // split state where Stop says the agent is active but the prompt bar has
    // already returned.
    const liveCover = document.getElementById("zs-input-cover");
    const coverOn = liveCover?.dataset.on === "1";
    if (activeWork && !coverOn) ui.inputCover(true);
    else if (!activeWork && coverOn) ui.inputCover(false);

    // Tool is executing on the MCP. Chat sites virtualize long conversations and
    // may replace the command turn while the request is pending. Re-own the fresh
    // node immediately, keeping the raw command hidden and the activity card live.
    if (A.toolRunning && A.toolVisual) {
      const items = P.allItems ? P.allItems() : [];
      primeAssistantIndexes(items);
      const assistants = items.filter((item) => P.isAssistantItem(item));
      let candidate = null;
      for (let index = assistants.length - 1; index >= 0; index -= 1) {
        const current = assistants[index];
        const currentKey = activityVisualKey(current);
        const sameIdentity = !!A.toolVisual.key && currentKey === A.toolVisual.key;
        // The command body can temporarily become an unreadable CodeMirror
        // shell while ChatGPT keeps the same assistant message UUID. Preserve
        // the card by that stable turn identity even when both text-derived
        // keys are momentarily unavailable.
        const sameTurn = !!A.toolVisual.turnKey && turnKey(current) === A.toolVisual.turnKey;
        const sameCommand = !!A.toolVisual.commandFingerprint &&
          commandFingerprintForItem(current) === A.toolVisual.commandFingerprint;
        if (sameIdentity || sameTurn || sameCommand) {
          candidate = current;
          break;
        }
      }
      if (candidate) {
        if (
          candidate !== A.toolItem || !candidate.querySelector(".zs-chip")
        ) {
          const imageFlow = A.toolVisual.call?.__viewCoderImageUpload;
          if (imageFlow) {
            decorate.imageUpload(candidate, imageFlow, true);
          } else {
            decorate.toolBox(
              candidate,
              A.toolName,
              "run",
              A.toolRetrying ? "retrying result" : A.toolArg,
              true,
              A.toolVisual.body,
              A.toolVisual.category,
            );
          }
          rememberExecuted(candidate);
          A.toolItem = candidate;
          diag("chip.reroot", { name: A.toolName });
        }
      }
    }
    // Tool is executing on the MCP → timer on its chip.
    if (A.toolRunning && A.toolItem) {
      const s = elapsedOn(A.toolItem, "zsToolT0", A.toolStart).toFixed(1);
      const status = A.toolRetrying ? "retrying result" : `${s}s`;
      setChipDetail(A.toolItem, (A.toolArg ? A.toolArg + " · " : "") + status);
      return;
    }
    // The site is streaming a tool call → token count + timer on its chip.
    if (uiGen) {
      const item = P.lastAssistant();
      const reply = item ? P.itemText(item) : ""; // non-thinking only
      const zphase = item && item.dataset.zphase;
      // Skip items already settled (done/err) - don't overwrite the finished chip.
      if (item && zphase !== "done" && zphase !== "err" && ZSParse.hasToolSignature(reply)) {
        // Live-correct the label as soon as the real name streams in.
        const name = ZSParse.toolNameFromText(reply);
        if (name && name !== "command") setChipLabel(item, name);
        const tokens = Math.floor(reply.length / TOKEN_CHARS);
        const s = Math.round(elapsedOn(item, "zsGenT0"));
        setChipDetail(item, `↓ ~${formatCount(tokens)} tokens  ◷ ${s}s`);
        return;
      }
    }
  }, 250);

  // ════════════════════════════════════════════════════════════════════════
  //  WIRING
  // ════════════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "zs-status") {
      ui.setStatus({ connected: msg.connected, mcpAlive: msg.mcpAlive, studio: msg.studio, studioApp: msg.studioApp, studioProc: msg.studioProc, tools: msg.tools, servers: msg.servers });
    } else if (msg && msg.type === "viewcoder-watchdog-tick") {
      // One-shot service-worker deadlines are not throttled with a hidden page.
      // Wake the exact waiter plus any short polling sleep so it can observe the
      // deadline immediately. Unknown/finished tokens are harmless.
      activeWatchdogs.get(String(msg.token || ""))?.fire("background");
      wakeTimedWaits();
    } else if (msg && msg.type === "viewcoder-active-tick" && A.activeMode) {
      // MV3 background heartbeat for the one tab that owns the task. Timers in
      // a hidden page may be heavily clamped; this lightweight nudge refreshes
      // state and the working cover without activating or focusing the tab.
      wakeTimedWaits();
      scheduleSweep(A.running || A.starting);
    }
  });

  let statusPollTimer = null;
  let statusPolling = false;
  async function pollBridgeStatus() {
    if (statusPolling) return;
    statusPolling = true;
    try {
      const status = await bg({ type: "status" });
      if (status) ui.setStatus(status);
    } finally {
      statusPolling = false;
      clearTimeout(statusPollTimer);
      // Background AI tabs only need a slow liveness refresh. Returning to the
      // tab triggers an immediate poll below.
      const activelyWorking =
        A.starting || A.injecting || A.awaitingReply || A.running ||
        A.toolRunning || A.stopping;
      const nextPollMs = document.hidden
        ? (A.activeMode && activelyWorking ? 7500 : 15000)
        : 5000;
      statusPollTimer = setTimeout(pollBridgeStatus, nextPollMs);
    }
  }
  void pollBridgeStatus();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      clearTimeout(statusPollTimer);
      void pollBridgeStatus();
    }
  });

  // Session state is derived from the ACTUAL chat, but sites VIRTUALIZE their
  // message lists: the system-prompt turn is dropped from the DOM once it
  // scrolls out of the window. So we key "started" by conversation
  // (P.conversationKey()): once we have seen the marker for a key, we remember
  // it (persisted so it survives reloads). We never flip while busy.
  const startedSessions = new Set();
  let lastSyncPath = null;
  // Conversation paths are not globally unique: multiple providers use routes
  // such as /c/<id>. Namespace persisted identities so a session started on one
  // AI can never accidentally unlock or resume a chat on another AI.
  const sessionStorageKey = (path) => path ? `${P.id}:${path}` : "";
  const currentWorkKey = () =>
    sessionStorageKey(P.conversationKey()) ||
    `${P.id}:pending:${location.origin}${location.pathname}`;

  async function refreshWorkLease() {
    const state = await bg({ type: "active_work" });
    if (!state || state.ok === false) return false;
    A.workOwner = state.owner || null;
    A.workBlocked = !!state.owner && !state.ownedByCaller;
    ui.updateStartGate();
    return !A.workBlocked;
  }

  async function claimWorkLease() {
    const key = currentWorkKey();
    const state = await bg({ type: "claim_active_work", key });
    A.workOwner = state && state.owner || null;
    A.workBlocked = !!(state && state.locked);
    if (state && state.ok) A.workLeaseKey = key;
    ui.updateStartGate();
    return state && state.ok ? key : "";
  }

  async function releaseWorkLease(leaseKey = A.workLeaseKey) {
    const key = leaseKey;
    if (A.workLeaseKey === key) A.workLeaseKey = "";
    if (key) await bg({ type: "release_active_work", key });
    await refreshWorkLease();
  }
  const STARTED_SESSION_MAX = 300;
  const isStoredSessionKey = (value) =>
    typeof value === "string" &&
    /^(deepseek|gemini|kimi|glm|qwen|arena|meta|chatgpt|claude):/.test(value);
  function trimStartedSessions() {
    while (startedSessions.size > STARTED_SESSION_MAX) {
      startedSessions.delete(startedSessions.values().next().value);
    }
  }
  const hasRememberedSession = (path) =>
    !!path && startedSessions.has(sessionStorageKey(path));
  function rememberSession(path) {
    // A falsy key = a TRANSIENT conversation URL (e.g. Gemini's /app before an
    // id is assigned). Remembering it would mark every future fresh chat as
    // "already started" and kill the Start gate. The real key is remembered by
    // the next sync once the site assigns the conversation its id.
    if (!path) return;
    const key = sessionStorageKey(path);
    if (startedSessions.has(key)) return;
    startedSessions.add(key);
    trimStartedSessions();
    // The service worker serializes cross-tab read/merge/write operations. A
    // direct storage.set here allowed simultaneous Gemini/Qwen starts to race
    // and silently erase one another's remembered readiness state.
    void bg({ type: "remember_session", key });
  }
  // Load the persisted set once, then re-sync.
  try {
    chrome.storage.local.get("zsStartedSessions", (r) => {
      if (r && Array.isArray(r.zsStartedSessions)) {
        for (const p of r.zsStartedSessions) {
          if (isStoredSessionKey(p)) startedSessions.add(p);
        }
        trimStartedSessions();
        syncSessionState();
      }
    });
  } catch {}
  // Keep already-open provider tabs in sync when another tab starts an agent.
  // Merge instead of replacing so a transient stale write can never make a
  // currently active tab forget its own session.
  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (Array.isArray(changes.zsStartedSessions?.newValue)) {
        for (const key of changes.zsStartedSessions.newValue) {
          if (isStoredSessionKey(key)) startedSessions.add(key);
        }
        trimStartedSessions();
        syncSessionState();
      }
      if (changes.viewcoderActiveWork) void refreshWorkLease();
      if (typeof changes.viewcoderActiveMode?.newValue === "boolean") {
        A.activeMode = changes.viewcoderActiveMode.newValue;
        scheduleSweep(true);
        scheduleWorkLeaseHeartbeat(true);
      }
    });
  } catch {}
  void refreshWorkLease();
  let workLeaseHeartbeatTimer = null;
  function scheduleWorkLeaseHeartbeat(immediate = false) {
    clearTimeout(workLeaseHeartbeatTimer);
    const activelyWorking = A.starting || A.running;
    const intervalMs =
      A.activeMode && activelyWorking ? 7_000 : 15_000;
    workLeaseHeartbeatTimer = setTimeout(async () => {
      if (A.workLeaseKey && (A.starting || A.running)) {
        await bg({ type: "claim_active_work", key: A.workLeaseKey });
      }
      scheduleWorkLeaseHeartbeat();
    }, immediate ? 0 : intervalMs);
  }
  scheduleWorkLeaseHeartbeat();
  // A conversation IS a ViewCoder session if any rendered turn carries a
  // telltale artefact: the system-prompt marker, an injected tool-result /
  // system-note turn, or a ViewCoder command an assistant wrote. Works even
  // after a full cold start and regardless of scroll position.
  function domHasZsSignal() {
    for (const it of P.allItems()) {
      const txt = it.textContent || "";
      if (hasSystemMarker(txt)) return true;
      if (/(^|\n)\s*Output of '[^']+':/.test(txt) || txt.includes("(System note:")) return true;
      // Deliberately NO bare command-shape test here. An assistant turn that
      // merely CONTAINS {"command":...} / ###LUA### is NOT proof of a session:
      // in a plain, never-started chat the model can simply EXPLAIN the format
      // (docs, examples, the user pasting our README) - that false positive
      // flipped A.started on, which armed the auto-resume watchdog, EXECUTED
      // the quoted JSON as a real command and injected its result into a chat
      // that had no agent at all (user-reported). A command only counts as a
      // session signal once it was actually RUN - and an executed command is
      // always followed by our injected "Output of '...'" feedback turn, which
      // the test above already catches. Virtualization (the marker turns
      // scrolling out of the DOM) is covered by the persisted per-conversation
      // key set (startedSessions / zsStartedSessions in rememberSession), not
      // by this heuristic.
    }
    return false;
  }
  function syncSessionState() {
    // While a bootstrap runs, track its conversation. The bootstrap chat gets a
    // real id only AFTER the prompt lands (fresh "/app" → "/app/<id>"), so we pin
    // the id the first time the chat has content. A change to a DIFFERENT, EMPTY
    // chat means the user opened a new conversation → abort: bump the generation
    // (the in-flight startSession bails at its next checkpoint) and clear state so
    // the new chat shows its own status instead of a stale "Starting…".
    if (A.starting) {
      const key = P.conversationKey();
      if (A.startingKey == null) {
        if (key && !P.chatIsEmpty()) A.startingKey = key; // pin the stable id
      } else if (key !== A.startingKey) {
        A.startGen++;
        A.starting = false;
        A.startingKey = null;
        A.userIntentAt = 0;
        A.userIntentKey = null;
        setInputLocked(false);
        ui.setStarting(false);
        // CRITICAL: startSession's own finally is gated on `alive()` (this abandon
        // just invalidated it via startGen++), so it will NEVER run and never
        // lift the "Agent is working…" cover. Without this line the cover was
        // stuck forever on the fresh chat whenever the user opened a new,
        // empty conversation WHILE the bootstrap's tool call (list_commands) was
        // still in flight - validated live 2026-07 on Cloudflare AI Playground.
        ui.inputCover(false);
      }
    }
    // Same idea for a RUNNING loop: if the user opens a NEW, empty conversation
    // via the SITE's own new-chat (not ViewCoder's button), the loop is bound to
    // a chat the user left, so abandon it. Otherwise A.running keeps this function
    // early-returning below and the stale "Agent active" / Stop button lingers on
    // the fresh chat instead of "Start Roblox agent". The "/app" → "/app/<id>" id
    // assignment of the SAME chat is not a move (loopKey is pinned only once the
    // chat has both an id and content), so a normal session is never disturbed.
    if (A.running) {
      const key = P.conversationKey();
      if (A.loopKey == null) {
        if (key && !P.chatIsEmpty()) A.loopKey = key; // pin the loop's conversation
      } else if (key !== A.loopKey) {
        diag("loop.abandonedMovedChat", { from: A.loopKey, to: key });
        A.stop = true;       // the loop breaks at its next checkpoint; its finally
        A.loopKey = null;    // resets A.running / cover / lock, then state recomputes
        A.userIntentAt = 0;
        A.userIntentKey = null;
      }
    }
    if (A.starting || A.injecting || A.running) return;
    const path = P.conversationKey();
    // A known session is intentionally sticky for the same real conversation.
    // Avoid re-reading every rendered message just to rediscover the marker on
    // each idle sweep; long ChatGPT/Gemini threads made that scan expensive.
    if (path && path === lastSyncPath && A.started) return;
    const markerInDom = domHasZsSignal();
    if (markerInDom) rememberSession(path);
    let has;
    if (path && path === lastSyncPath) {
      // SAME, REAL conversation: never downgrade a known-started session just
      // because virtualization scrolled the marker out of the DOM. "started" is
      // sticky until the key actually changes (a different conversation).
      // NOTE: a falsy key ("" = a transient/fresh chat with no id yet) is NEVER
      // sticky - every fresh chat shares "", so a brief transient sweep during
      // navigation would otherwise PIN lastSyncPath="" with has=true and then keep
      // "Agent active" forever on the next empty chat (it would never recompute).
      has = A.started || markerInDom || hasRememberedSession(path);
    } else {
      // Different conversation → recompute from scratch.
      if (
        A.userIntentAt &&
        A.userIntentKey == null &&
        path &&
        !P.chatIsEmpty() &&
        !lastSyncPath
      ) {
        // A provider replaced its transient fresh-chat URL with a real id after
        // the visible send. Pin recovery permission to that now-stable chat.
        A.userIntentKey = path;
      } else if (A.userIntentAt && A.userIntentKey !== path) {
        // A genuine navigation must never carry recovery authority into the
        // destination conversation.
        A.userIntentAt = 0;
        A.userIntentKey = null;
      }
      has = markerInDom || hasRememberedSession(path);
      lastSyncPath = path;
    }
    if (has !== A.started) {
      A.started = has;
      ui.setStarted(has);
    }
  }

  // Schedule a debounced sweep. requestAnimationFrame is PAUSED in a background
  // tab, so when hidden we fall back to a timer (throttled, but it runs).
  let sweepScheduled = false;
  let fullSweepRequested = false;
  let lastSweepAt = 0;
  let lastComposerEnforceAt = 0;
  let lastSessionSyncAt = 0;
  function scheduleSweep(forceFull = false) {
    if (forceFull || useZeroActivityLifecycle) fullSweepRequested = true;
    if (sweepScheduled) return;
    sweepScheduled = true;
    const run = () => {
      sweepScheduled = false;
      lastSweepAt = Date.now();
      const runFullSweep = fullSweepRequested;
      fullSweepRequested = false;
      const activelyWorking =
        A.starting || A.injecting || A.awaitingReply || A.running ||
        A.toolRunning || A.stopping;
      if (
        activelyWorking || runFullSweep ||
        lastSweepAt - lastSessionSyncAt >= 2000
      ) {
        syncSessionState();
        lastSessionSyncAt = lastSweepAt;
      }
      const composerEvery = activelyWorking
        ? (A.activeMode ? 650 : 900)
        : 1800;
      if (lastSweepAt - lastComposerEnforceAt >= composerEvery) {
        P.enforceComposer(); // periodic read-only provider/mode reconciliation
        lastComposerEnforceAt = lastSweepAt;
      }
      ui.updateStartGate(); // block the input until a session is started
      decorate.sweep(runFullSweep);
    };
    const activelyWorking =
      A.starting || A.injecting || A.awaitingReply || A.running ||
      A.toolRunning || A.stopping;
    // ZeroScript does not throttle foreground card reconciliation. Running the
    // already-debounced full pass on the next paint is what makes a streamed
    // command become a card promptly and keeps it mounted through host churn.
    if (useZeroActivityLifecycle) {
      if (document.hidden) setTimeout(run, 100);
      else requestAnimationFrame(run);
      return;
    }
    const minSweepMs = document.hidden
      ? (A.activeMode && activelyWorking
          ? 450
          : 1200)
      : (activelyWorking ? 250 : 700);
    const delay = Math.max(0, minSweepMs - (Date.now() - lastSweepAt));
    const queue = () => {
      if (document.hidden) run();
      else requestAnimationFrame(run);
    };
    if (delay) setTimeout(queue, delay);
    else queue();
  }
  // Synchronous pre-hide: MutationObserver callbacks run as a microtask BEFORE
  // the browser paints, but the debounced sweep above waits one extra rAF -
  // long enough for a freshly-sent system-prompt/injected-feedback turn's raw
  // text to paint for a single frame before decorate.sweep() builds its chip
  // and hides it (seen live on DeepSeek: "Starting Up" flashed the raw prompt
  // for an instant). Do the cheap whole-item hide test right here, synchronously,
  // so the class lands before that first paint; the full sweep still runs after
  // to build the actual chip.
  function preHideWholeItems() {
    const items = P.allItems();
    // Optimistic pre-hide of a freshly injected result turn (armed in
    // submitAndGetBase). The text-based match below can only fire once the
    // "Output of '…'" caption has rendered, but the turn's NODE appears first
    // (with its attached image) and the caption fills a tick later - so the raw
    // output would flash until a post-send sweep nudge. We know the newest user
    // turn in this window is ours: hide it on sight (blank, no raw text), and let
    // the normal sweep swap in the real "· result" chip when the caption lands.
    if (A.injectHideUntil && Date.now() < A.injectHideUntil) {
      const users = items.filter((it) => P.isUserItem(it));
      const last = users[users.length - 1];
      if (last && !last.classList.contains("zs-hidden") &&
          users.length > (A.injectPreUser || 0)) {
        last.classList.add("zs-hidden");
        A.injectHideUntil = 0; // one-shot: this turn is now masked
        diag("result.prehide", { users: users.length });
      }
    }
    // ZeroScript scans the provider's complete rendered message set in the
    // observer microtask. The excluded providers retain ViewCoder's bounded
    // tail scan because their long-chat DOMs need the newer scoped lifecycle.
    const visibleItems = useZeroActivityLifecycle
      ? items
      : (items.length > 20 ? items.slice(-20) : items);
    for (const item of visibleItems) {
      if (item.classList.contains("zs-hidden")) continue;
      const txt = P.classifyText(item, ".zs-chip");
      if (hasSystemMarker(txt) ||
          (P.isUserItem(item) && ZSParse.isInjectedFeedback(txt))) {
        item.classList.add("zs-hidden");
      }
    }
  }
  function mutationMayExposeInternal(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes || []) {
        const text =
          node.nodeType === Node.TEXT_NODE
            ? node.nodeValue || ""
            : node.nodeType === Node.ELEMENT_NODE
              ? node.textContent || ""
              : "";
        if (
          hasSystemMarker(text) ||
          text.includes("Output of '") ||
          text.includes("(System note:")
        ) return true;
      }
    }
    return false;
  }
  function mutationIsViewCoderOnly(mutation) {
    const target = mutation.target?.nodeType === Node.ELEMENT_NODE
      ? mutation.target
      : mutation.target?.parentElement;
    // Mutations inside our fixed UI or an existing tool chip are generated by
    // ViewCoder itself (timers, status text, animations) and cannot reveal a new
    // host message. A host removing/replacing a chip has the HOST turn as target,
    // so it still falls through and schedules the self-healing sweep.
    return !!target?.closest?.("#zs-root, #zs-input-cover, .zs-chip");
  }
  const mo = new MutationObserver((mutations) => {
    if (useZeroActivityLifecycle) {
      // Match ZeroScript's lifecycle exactly for the supported adapters: do not
      // depend on a fragile dirty-node association, and pre-hide before paint.
      preHideWholeItems();
      scheduleSweep(true);
      return;
    }
    if (mutations.length && mutations.every(mutationIsViewCoderOnly)) return;
    decorate.noteMutations(mutations);
    // Full item classification on every streaming token was the largest
    // long-chat hot path. Synchronous pre-hiding is only required while
    // ViewCoder itself is inserting a startup/result turn; regular assistant
    // streaming is handled by the throttled sweep below.
    if (
      (A.injectHideUntil && Date.now() < A.injectHideUntil) ||
      (A.starting && mutationMayExposeInternal(mutations))
    ) {
      preHideWholeItems();
    }
    scheduleSweep();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  // Belt-and-braces: a low-frequency sweep regardless of tab visibility or
  // mutation timing, so camouflage always converges. The six ZeroScript-backed
  // providers keep its 1.5 s cadence; excluded providers retain ViewCoder's
  // lower-frequency long-chat repair pass.
  let periodicFullSweepTimer = null;
  function schedulePeriodicFullSweep() {
    clearTimeout(periodicFullSweepTimer);
    const activelyWorking =
      A.starting || A.injecting || A.awaitingReply || A.running ||
      A.toolRunning || A.stopping;
    const delay = useZeroActivityLifecycle
      ? 1_500
      : (A.activeMode && activelyWorking ? 5_500 : 10_000);
    periodicFullSweepTimer = setTimeout(() => {
      scheduleSweep(true);
      schedulePeriodicFullSweep();
    }, delay);
  }
  schedulePeriodicFullSweep();
  // When the user returns to the tab, immediately refresh camouflage/state.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleSweep(true);
  });

  // One full initial pass handles any restored conversation already rendered
  // before document_idle; subsequent streaming updates use the throttled path.
  preHideWholeItems();
  syncSessionState();
  scheduleSweep(true);

  // User-send interception: the provider wires the site's composer events to
  // these callbacks.
  P.installSendHooks({
    isBlocked: () =>
      A.injecting ||
      A.awaitingReply ||
      A.running ||
      A.starting ||
      A.toolRunning ||
      A.stopping ||
      (A.started && generationForUi()),
    isStarted: () => A.started,
    onBlockedAttempt: () => ui.nudgeStart(),
    onUserMessage: (base) => {
      const userIntentText = String(P.editorText?.() || "").trim();
      const now = Date.now();
      const sendSignature = `${P.conversationKey?.() || ""}|${base}|${userIntentText}`;
      // Enter-driven form submission can also emit a trusted Send-button click
      // on some providers. Treat both DOM events as one real user submission so
      // one prompt cannot initialize two image-generation lifecycles.
      if (
        sendSignature === A.lastNativeUserSendSignature &&
        now - A.lastNativeUserSendAt < 1_500
      ) return;
      A.lastNativeUserSendSignature = sendSignature;
      A.lastNativeUserSendAt = now;
      // A fresh user message = fresh intent: clear any previous manual stop so
      // the loop is allowed to run again.
      A.userStopped = false;
      A.suppressProviderGen = false;
      A.finalAnswerSettled = false;
      try {
        const baselineImageState = P.nativeImageGenerationState?.(P.lastAssistant?.()) || null;
        A.nativeImageBaselineRoot = baselineImageState?.root || null;
        A.nativeImageBaselineKey = nativeUiImageRootKey(A.nativeImageBaselineRoot);
      } catch {
        A.nativeImageBaselineRoot = null;
        A.nativeImageBaselineKey = "";
      }
      try { globalThis.ViewCoderImageRelay?.armGeneratedCapture?.(); } catch {}
      A.nativeUiUserTurn += 1;
      A.nativeUiCapturedForUserTurn = null;
      A.userIntentText = userIntentText;
      const nativeUiApprovalReply = A.nativeUiApprovalRequired;
      const nativeUiApprovalDenied =
        nativeUiApprovalReply &&
        /\b(?:no|nope|stop|cancel|do not|don't|not yet|wait)\b/i.test(A.userIntentText);
      const nativeUiApprovalGranted =
        nativeUiApprovalReply &&
        !nativeUiApprovalDenied &&
        /\b(?:yes|yeah|yep|continue|proceed|move on|go ahead|do it|upload|assemble|use it|okay|ok)\b/i
          .test(A.userIntentText);
      const nativeUiRevisionRequested =
        nativeUiApprovalReply &&
        !nativeUiApprovalGranted &&
        userExpectsNativeGeneratedUi(A.userIntentText);
      if (nativeUiApprovalGranted || nativeUiRevisionRequested) {
        A.nativeUiApprovalRequired = false;
      }
      if (nativeUiApprovalGranted && A.pendingNativeUiApprovalImage?.url) {
        A.nativeUiCapturedForUserTurn = {
          userTurn: A.nativeUiUserTurn,
          image: A.pendingNativeUiApprovalImage,
        };
      }
      if (nativeUiRevisionRequested) A.pendingNativeUiApprovalImage = null;
      A.expectGeneratedUi = nativeUiApprovalGranted
        ? false
        : userExpectsNativeGeneratedUi(A.userIntentText);
      A.awaitingNativeUiGeneration = A.expectGeneratedUi;
      A.aiUiGenerationAttempts = 0;
      A.aiUiBackgroundFailures = 0;
      A.aiUiFallbackTriggered = false;
      A.userIntentAt = Date.now();
      A.userIntentKey = P.conversationKey() || null;
      A.bootBaselineId = null;
      // A real user request supersedes the startup-only readiness turn.
      A.startupReplyId = null;
      A.startupReplyItem = null;
      captureSendToken(); // identity of the assistant turn before this reply
      // A Stop clicked during this 300ms window sets A.userStopped → honor it and
      // do NOT start the loop (otherwise the stop is silently ignored and the
      // freshly-started loop strands the "Stopping…" flag).
      setTimeout(() => { if (!A.running && !A.userStopped) agentLoop(base); }, 300);
    },
    onNativeStop: () => {
      // A click on the site's own stop = a deliberate manual stop → suppress
      // auto-resume.
      A.userStopped = true;
      A.stop = true;
      A.resumeArmed = false; // a stop overrides any pending regenerate grace
      A.stopAt = Date.now(); // grace anchor for the regenerate-as-resume gates
      // Same growth baseline as stopLoop: the stop-retry self-heal must only
      // re-click if the stream keeps writing past this point (see stop.retry).
      A.stopStreamLen = P.streamLen ? P.streamLen() : 0;
      // If our loop is live, mirror the same "Stopping…" feedback as our own
      // Stop button so the bar reflects the wind-down instead of flickering.
      if (A.running && !A.stopping) { A.stopping = true; ui.markStopping(); }
      markStoppedTurn();
      diag("nativeStop");
    },
    onNativeContinue: () => {
      // The site's "Continue" button = a clear intent to RESUME after a stop/
      // truncation. Clear the manual-stop latch so auto-resume can pick the
      // (resumed) turn's tool call back up cleanly.
      A.userStopped = false;
      A.stop = false;
      const it = P.lastAssistant();   // a real resume → drop the stopped marker
      if (it) { delete it.dataset.zStopped; forgetHalted(it); }
      diag("nativeContinue");
    },
  });

  // Auto-resume watchdog - the safety net that keeps the agentic loop alive when
  // a tool call finished AFTER the loop finalized early (huge multi_edit, tab
  // returning from background). It must NEVER fire on a tool call merely
  // PRESENT in the DOM without a fresh live generation. Guards:
  //   • A.userStopped - the user halted; never relaunch against their intent.
  //   • lastGenAt recency - only resume a turn from a generation in the last
  //     few seconds; a turn rendered by load/scroll has no recent generation.
  //   • turnHalted - the turn itself carries the site's "stopped" marker.
  // Each turn is still resumed at most once (zResume marker).
  // Some providers legitimately spend several minutes reasoning or waiting on
  // a long Studio job. A longer recovery window is safe now that permission is
  // tied to the exact conversation and still requires a complete, unexecuted
  // command from that turn.
  const RESUME_FRESH_MS = 10 * 60 * 1000;
  setInterval(() => {
    if (!A.started || A.running || A.starting || A.injecting) return;
    if (A.userStopped) return;                          // user halted → never relaunch
    if (P.isGenerating()) return;
    const conversation = P.conversationKey() || null;
    if (A.userIntentKey && conversation !== A.userIntentKey) return;
    if (!A.userIntentKey && conversation && !P.chatIsEmpty()) {
      A.userIntentKey = conversation;
    }
    const liveAnchor = Math.max(A.lastGenAt || 0, A.userIntentAt || 0);
    if (!liveAnchor || Date.now() - liveAnchor > RESUME_FRESH_MS) return;
    const item = P.lastAssistant();
    if (!item || item.dataset.zloop) return;
    // Never resume the turn that already existed when this session started - it is
    // a reload-restored generation, not a reply to one of our sends (see
    // A.bootBaselineId). Guards the "execute_luau leaked into the new chat" bug.
    if (A.bootBaselineId && P.lastAssistantId && P.lastAssistantId() === A.bootBaselineId) return;
    // Ignore observer churn from the already-consumed startup readiness reply.
    try {
      const startupId = P.lastAssistantId ? P.lastAssistantId() : null;
      if (
        (A.startupReplyItem && item === A.startupReplyItem) ||
        (A.startupReplyId != null && startupId != null &&
          String(startupId) === String(A.startupReplyId))
      ) return;
    } catch {}
    if (P.turnHalted(item)) return;                     // this turn was stopped → leave it
    // Scrolled-back OLD turn guard (virtualization). lastAssistant() is the last
    // RENDERED turn; scrolling up makes it an old command whose id is below the
    // session's high-water mark. Its result row may be off-screen (unrendered), so
    // the result-below guard alone can miss it - this catches it directly. Only
    // applies when the provider exposes a numeric monotonic id (DeepSeek).
    const curId = P.itemKey ? Number(P.itemKey(item)) : NaN;
    if (Number.isFinite(curId) && A.maxTurnId != null && curId < A.maxTurnId) {
      // Log once per distinct turn, not every 1s tick while the user stays up.
      if (A._skipOldId !== curId) { A._skipOldId = curId; diag("resume.skipOld", { curId, maxTurnId: A.maxTurnId }); }
      return;
    }
    // Settled-history guard (survives a page reload, unlike the executed map).
    // A genuine resume target is a command whose tool NEVER produced a result;
    // it has NO injected-feedback turn after it. Every ALREADY-EXECUTED command
    // is followed by its injected result. On a virtualized list, scrolling up
    // makes lastAssistant() an OLD command turn AND flickers isGenerating() true
    // (sampleStream resets on the node change), refreshing lastGenAt - so the
    // freshness guard alone doesn't stop it, and after a reload the executed map
    // is empty. Keying off the result-below turn robustly separates the in-flight
    // command from settled history: a scrolled-back tool with its result already
    // present is never re-fired. (Confirmed live: same-conv reload + scroll up
    // re-executed a historical command.)
    const all = P.allItems();
    const after = all[all.indexOf(item) + 1];
    if (after && P.isUserItem(after) &&
        ZSParse.isInjectedFeedback(P.classifyText(after, ".zs-chip"))) return;
    const providerCommand = providerCommandCalls(item);
    const txt = providerCommand?.text || P.itemText(item);
    if (!providerCommand && !ZSParse.hasToolSignature(txt)) return;
    // Node-independent dedupe: this turn's command was already dispatched (by the
    // loop or a prior resume). The dataset guards below are wiped when the site
    // recreates the node on scroll, so without this off-DOM check the watchdog
    // re-runs a historical tool with no live generation. See the `executed` map.
    if (isRememberedExecuted(item, txt)) return;
    // Resume only when a COMPLETE, parseable command is present - and re-attempt
    // if the turn has GROWN since our last try.
    if (!(providerCommand?.calls || ZSParse.parseToolCalls(txt)).length) return;
    const len = txt.length;
    if (item.dataset.zResume && Number(item.dataset.zResumeLen || 0) >= len) return;
    item.dataset.zResume = "1";
    item.dataset.zResumeLen = String(len);
    rememberExecuted(item);
    diag("autoResume", { len });
    // The reply turn is ALREADY present - act on it immediately. Null token makes
    // the identity-based newReply test unconditionally true (any current id != null).
    A.sendToken = null;
    agentLoop(P.assistantCount() - 1);
  }, 1000);

  log(`ViewCoder content script ready (provider: ${P.id})`);
})();
