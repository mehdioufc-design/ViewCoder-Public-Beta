// providers/meta.js - the Meta AI (www.meta.ai) provider.
// Exports the same ZSProvider interface as providers/deepseek.js; the core
// (core/main.js) is provider-agnostic. To DISABLE Meta AI support, remove this
// file from manifest.json (and its URL from background.js PROVIDER_URLS).
//
// Meta AI DOM notes (validated live, 2026-07-13):
//  - React app. The message list is a <div class="flex flex-col"> whose direct
//    children are the turns (each a <div> with `starting:opacity-0` animate-in
//    classes). A leading `pointer-events-none absolute h-px w-px` spacer child
//    is NOT a turn (skipped: no text, no assistant-message).
//  - An ASSISTANT turn contains a <div data-testid="assistant-message">; a USER
//    turn does not (and carries plain text). Reasoning ("Réflexion" mode) renders
//    INSIDE the assistant-message as [data-testid="thinking-status"] +
//    [data-testid="subagent-cot-list"] - both are excluded from the read text so
//    a chain-of-thought never counts as model output or a command.
//  - Composer = real <textarea data-testid="composer-input"> (native value setter
//    + input event, like Arena/DeepSeek). Send = [data-testid="composer-send-button"]
//    (aria "Envoyer"); DURING generation it is replaced by
//    [data-testid="composer-stop-button"] (aria "Arrêter") and the send testid
//    disappears - that stop button present = generation active.
//  - New chat = [data-testid="new-chat-button"] → path "/". A conversation is
//    /prompt/<uuid>.
//  - TWO code-rendering traps (both handled here):
//    (a) a ```json fenced block renders as a custom INTERACTIVE JSON VIEWER
//        (.ur-code-block with a JSON/Tree/Raw toolbar). Its visible text is
//        "JSONTreeRaw▶{...}"; the {...} braces stay intact and the prefix has no
//        braces, so the parser's brace-matched extractToolAnywhere reads a JSON
//        command with NO special handling.
//    (b) a plain ``` fenced block (used for the ###LUA### execute_luau form) is a
//        real <pre><code> whose lines are separate <span class="block …counter…">
//        with NO newline text nodes → textContent COLLAPSES onto one line, which
//        would break multi-line Lua. textWithout() special-cases <pre> and joins
//        its line spans with "\n" to rebuild the source (same fix class as GLM's
//        .cm-line / Qwen's Monaco).
//  - IMPORTANT (viability): Meta AI's guardrail REFUSES to emit command JSON when
//    the framing is thin; the FULL ViewCoder system prompt (with the "commands
//    are NOT function calls, just TYPE the JSON" reassurance) defuses it and it
//    complies. Nothing to do in code - just never bootstrap with a stripped prompt.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const IS_CHATGPT =
    location.hostname === "chatgpt.com" ||
    location.hostname === "chat.openai.com";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()
  // Identity of the last image set STAGED into the composer. One provider send
  // retains the same array reference, so keying on it makes the attachment
  // idempotent; a new capture is a new array.
  let _attachedImages = null;
  let _attachedImageNames = [];
  // Whether the composer is locked (agent working). React re-renders the composer
  // and restores the placeholder/contenteditable, so setInputLock's effects must
  // be RE-ASSERTED every sweep (enforceComposer) while this is true.
  let _locked = false;

  const S = {
    asst: IS_CHATGPT
      ? '[data-message-author-role="assistant"]'
      : '[data-testid="assistant-message"]',
    // The composer SWAPS element when media is attached: text-only it is a
    // <textarea data-testid="composer-input">; once an image is staged Meta hides
    // that textarea and shows a Lexical contenteditable <div data-testid=
    // "composer-input"> with the image inline. So key on the testid (not the tag)
    // and pick the visible one - see getEditor().
    input: IS_CHATGPT
      ? '#prompt-textarea,[contenteditable="true"][data-virtualkeyboard="true"]'
      : '[data-testid="composer-input"],input[aria-label="Ask Meta AI" i],input[placeholder*="Meta AI" i]',
    sendBtn: IS_CHATGPT
      ? 'button[data-testid="send-button"],button[aria-label="Send prompt" i],button[aria-label="Send message" i]'
      : '[data-testid="composer-send-button"],button[aria-label="Send" i]',
    stopBtn: IS_CHATGPT
      ? 'button[data-testid="stop-button"],button[data-testid*="stop" i],button[aria-label*="Stop" i],button[title*="Stop" i]'
      : '[data-testid="composer-stop-button"],button[aria-label*="Stop" i]',
    newChat: IS_CHATGPT
      ? '[data-testid="new-chat-button"]'
      : '[data-testid="new-chat-button"],nav a[href="/"]',
    // Response-mode dropdown: the button shows the current mode ("Instantané" /
    // "Réflexion"); its menu options are think_fast (Instantané) and think_hard
    // (Réflexion). We force think_hard - Instantané gives markedly worse replies.
    reasoning: IS_CHATGPT
      ? '[data-testid*="thinking" i],[class*="reasoning" i]'
      : '[data-testid="thinking-status"],[data-testid="subagent-cot-list"]',
    codeWrap: IS_CHATGPT ? "pre" : ".ur-code-block",
    errorSurfaces:
      '[role="alert"],[class*="toast"],[class*="error"],[class*="alert"]',
  };

  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "please.{0,30}(start|cr\\u00e9er).{0,20}(new|nouveau).{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "maximum.{0,20}context",
        "this conversation has reached",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)/i,
    busy: /something went wrong|une erreur s.est produite|try again later|réessayer plus tard|rate limit|too many requests|trop de requ[êe]tes/i,
  };

  // Meta streams with a hard stop-button signal for the WHOLE generation (incl.
  // the "Réflexion" reasoning phase), so idle windows can be tight (like Gemini).
  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Turn list ──────────────────────────────────────────────────────────────
  // The message list is the <div class="flex flex-col"> that holds an
  // assistant-message and >1 child turn. Climb from any assistant-message to it;
  // fall back to the nearest such container. Returns null on a fresh/empty chat.
  function listEl() {
    if (IS_CHATGPT) {
      const turn = document.querySelector("[data-message-author-role]");
      return turn?.closest("main") || turn?.parentElement || null;
    }
    const any = document.querySelector(S.asst);
    if (!any) return null;
    let n = any.parentElement;
    for (let i = 0; i < 12 && n; i++, n = n.parentElement) {
      if (
        n.classList.contains("flex") &&
        n.classList.contains("flex-col") &&
        n.children.length >= 2 &&
        n.querySelector(S.asst)
      ) {
        return n;
      }
    }
    return null;
  }

  // A real turn child (excludes the tiny `pointer-events-none absolute h-px w-px`
  // scroll spacer, which has no text and no assistant-message).
  // Use textContent, NOT innerText: the core hides a whole injected turn (the
  // bootstrap system prompt and every "Output of '…'" result) with display:none,
  // and innerText returns "" for a display:none node - which dropped those turns
  // from allItems() so classify() never built their sys / "· result" chips (the
  // result box rendered as literally nothing). textContent ignores CSS, so the
  // hidden turns stay enumerated and get decorated.
  function isTurnChild(c) {
    if (!c) return false;
    if (c.classList.contains("pointer-events-none") && c.classList.contains("absolute")) return false;
    return !!c.querySelector(S.asst) || (c.textContent || "").trim().length > 0;
  }
  function domTurns() {
    if (IS_CHATGPT) {
      const turns = [
        ...document.querySelectorAll("[data-message-author-role]"),
      ];
      return turns.filter(
        (turn) =>
          !turn.closest("#zs-root") &&
          (turn.textContent || "").trim().length > 0,
      );
    }
    const list = listEl();
    if (!list) return [];
    return [...list.children].filter(isTurnChild);
  }

  const isAssistantItem = (item) =>
    !!item &&
    (item.matches?.(S.asst) || !!item.querySelector(S.asst));
  const isUserItem = (item) =>
    !!item &&
    (IS_CHATGPT
      ? item.getAttribute("data-message-author-role") === "user"
      : !isAssistantItem(item));

  // The assistant-message body element inside an assistant turn (reasoning still
  // nested; excluded when we read it). For a user turn it is the turn itself.
  function bodyOf(item) {
    if (!item) return null;
    if (IS_CHATGPT) {
      return item.querySelector(".markdown") || item;
    }
    return isAssistantItem(item) ? item.querySelector(S.asst) : item;
  }

  const allItems = () => domTurns();
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  // Stable per-NODE id for the latest assistant turn (the core prefers this over
  // count-based detection). A WeakMap assigns each turn a monotonic id on first
  // sight, so a genuinely new reply node yields a new id immediately.
  const _idMap = new WeakMap();
  let _idSeq = 0;
  function itemKey(item) {
    if (!IS_CHATGPT || !item) return null;
    const messageId = item.getAttribute("data-message-id");
    return messageId ? `message:${messageId}` : null;
  }
  function lastAssistantId() {
    const it = lastAssistant();
    if (!it) return null;
    // ChatGPT exposes a persistent UUID for every assistant message. Use it
    // before the WeakMap fallback: React replaces the DOM node for the previous
    // assistant turn when ViewCoder submits a tool result. A node-identity token
    // therefore changed *before* the next assistant reply existed, which made the
    // response watcher re-read the already-finished command as a new reply and
    // release the loop. The next Blender command then appeared as "finished" /
    // "not run" without ever reaching the bridge. The message UUID survives that
    // replacement and only changes when ChatGPT creates a genuinely new turn.
    const stableKey = itemKey(it);
    if (stableKey) return stableKey;
    let id = _idMap.get(it);
    if (!id) { id = ++_idSeq; _idMap.set(it, id); }
    return `node:${id}`;
  }

  const chatIsEmpty = () => allItems().length === 0;

  // ── Text extraction ─────────────────────────────────────────────────────────
  // Walk the tree skipping the core's chip, the reasoning blocks, and any extra
  // excluded subtree. A <pre> is special-cased: Meta renders each code line as a
  // block <span> with NO newline text node, so plain textContent collapses the
  // block onto one line (breaks multi-line Lua). Rebuild it by joining the code
  // element's line children with "\n".
  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = ".zs-chip, " + S.reasoning + (excludeSel ? ", " + excludeSel : "");
    let t = "";
    const appendBlock = (value) => {
      const text = String(value || "");
      if (t && !t.endsWith("\n")) t += "\n";
      t += text;
      if (!t.endsWith("\n")) t += "\n";
    };
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.matches && n.matches(skip)) return;
      // A ```json fence renders as the INTERACTIVE JSON-VIEWER widget (a
      // .ur-code-block with a JSON/Tree/Raw toolbar and a collapsible tree), NOT
      // a <pre>. In its Tree view it injects a ▶/▼ expander glyph BEFORE every
      // nested object/array key - and those glyphs land INSIDE the braces, e.g.
      // `{"command":"get_studio_state",▶"params":{}}`. That corrupted JSON made
      // JSON.parse fail → a "bad JSON" parse_error every time the model emitted a
      // command with a nested object, then it retried, re-rendered, and failed
      // again (the reported spam). Detect the viewer (a .ur-code-block with no
      // <pre>) and hand the parser the cleaned JSON instead of the raw tree text.
      if (n.matches && n.matches(S.codeWrap) && !n.querySelector("pre")) {
        appendBlock(cleanJsonViewer(n.textContent || ""));
        return;
      }
      if (n.tagName === "PRE") {
        appendBlock(preText(n));
        return;
      }
      for (const c of n.childNodes) walk(c);
    };
    walk(root);
    return t;
  }
  // Strip the JSON-viewer widget's chrome so only the JSON object is left:
  // remove the tree-expander triangles (▶ ▼ ► ◀ ▲ ▾ …) that Meta interleaves
  // between JSON tokens, then drop the leading "JSONTreeRaw" toolbar text that
  // precedes the first "{". Trailing toolbar/Copy chrome after the JSON is
  // harmless - the core's brace-matched extractor stops at the closing brace.
  function cleanJsonViewer(text) {
    const t = text.replace(/[▲▴▶▸►▼▾◀◂]/g, "");
    const i = t.indexOf("{");
    return i > 0 ? t.slice(i) : t;
  }
  // ChatGPT currently mounts fenced code as a nested CodeMirror editor:
  //   <pre> ... <div class="cm-content"><div class="cm-line">...</div>
  // Its textContent collapses every statement together and innerText becomes
  // equally collapsed after ViewCoder hides the raw block. Older ChatGPT builds
  // used direct `span.block` line nodes, while syntax token spans are inline.
  // Rebuild only proven line containers and let the pure parser choose the most
  // complete candidate. This keeps both ###LUA### markers and real line breaks.
  function preText(pre) {
    const code = pre.querySelector("code") || pre;
    const children = [...code.children].filter((child) => child.nodeType === 1);
    const directLineLike = children.length > 0 && children.every((child) =>
      /^(?:DIV|P|LI)$/.test(child.tagName) ||
      child.hasAttribute("data-line") ||
      child.classList.contains("block") ||
      child.classList.contains("cm-line")
    );
    const candidates = [
      code.innerText || "",
      code.textContent || "",
      directLineLike ? children.map((line) => line.textContent || "").join("\n") : "",
    ];
    for (const content of pre.querySelectorAll(".cm-content")) {
      const lines = [...content.children].filter((line) =>
        line.classList.contains("cm-line")
      );
      if (lines.length) {
        candidates.push(lines.map((line) => line.textContent || "").join("\n"));
      }
    }
    return ZSParse.chooseRenderedCodeText(candidates);
  }

  function itemText(item) {
    const b = bodyOf(item);
    return b ? textWithout(b) : "";
  }
  function classifyText(item, excludeSel) {
    const b = bodyOf(item);
    if (!b) return "";
    return textWithout(b, excludeSel);
  }

  // Return each fenced source independently from the combined assistant text.
  // ChatGPT can temporarily expose a complete nested CodeMirror <pre> while the
  // surrounding Markdown tree still yields a stale/collapsed read. The core uses
  // these candidates first, so a valid direct ###LUA### block cannot be rejected
  // merely because the outer response read lost its opening line.
  function commandSourceCandidates(item) {
    const b = bodyOf(item);
    if (!b) return [];
    const seen = new Set();
    const out = [];
    for (const pre of b.querySelectorAll("pre")) {
      const text = preText(pre).trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
    return out;
  }

  // ── Chip anchor ─────────────────────────────────────────────────────────────
  // Anchor the chip inside the assistant-message body so it sits under the reply.
  // React reconciles the turn subtree on stream updates; ensureOwnedChip rebuilds
  // the chip after each wipe (same as the other providers).
  function chipAnchor(item) {
    const body = bodyOf(item);
    if (!body) return item;
    // Anchor into the reply's CENTERED content column (mx-auto max-w-3xl flex-col),
    // not the full-width assistant-message: the latter stretched the chip across
    // the whole turn and dropped it BELOW the like/copy action bar. This column
    // caps the chip to the text width, left-aligns it (with align-self:flex-start
    // in overlay.css), and sits before the actions group so the chip reads right
    // under the reply text.
    const col = [...body.querySelectorAll("div")].find((e) => {
      const c = e.className || "";
      return /mx-auto/.test(c) && /max-w-/.test(c) && /flex-col/.test(c) && !/actions/.test(c);
    });
    return col || body;
  }

  // ── Composer ────────────────────────────────────────────────────────────────
  // Meta's composer is a Lexical contenteditable <div data-testid="composer-input">,
  // MIRRORED by a hidden <textarea data-testid="composer-input"> that acts as the
  // controlled input: writing to that textarea via the native value setter drives
  // the visible editor (text appears, send enables) and clears it cleanly - even
  // with an image staged inline (validated live 2026-07-13). So we treat the
  // textarea as the source of truth for READ/WRITE, and the visible div for
  // geometry (barAnchor) and user-event targeting (installSendHooks).
  const editorEls = () => [...document.querySelectorAll(S.input)].filter((e) => !e.closest("#zs-root"));
  // Meta's July 2026 composer now uses a native <input type=text> on a fresh
  // chat, while older/conversation/media states use textarea or Lexical. Treat
  // both native controls as value-backed editors so locking, reading, and the
  // native setter keep working across all three shapes.
  const isNativeEditor = (e) =>
    !!e && (e.tagName === "TEXTAREA" || e.tagName === "INPUT");
  // getEditor() = the ON-SCREEN editor (the Lexical div). The core anchors the
  // "Agent is working…" cover and the .zs-typing mask to P.getEditor(), so it MUST
  // be the visible node (the hidden mirror textarea has a 0x0 rect and put the
  // cover off-screen). Layout (barAnchor) and event targeting use this too.
  const getEditor = () => {
    const all = editorEls();
    return all.find((e) => !isNativeEditor(e) && e.offsetParent !== null) ||
           all.find((e) => e.offsetParent !== null) || all[0] || null;
  };
  const visibleEditor = getEditor; // alias (kept for call-site clarity)
  // writeEl() = the controlled mirror textarea we WRITE to: setting its value via
  // the native setter drives the visible Lexical editor and clears it cleanly.
  // Falls back to the on-screen editor if Meta ever drops the textarea.
  const writeEl = () => {
    const all = editorEls();
    // Meta's newest fresh-chat composer is a visible native <input>. Prefer it
    // over a stale/hidden mirror textarea left elsewhere in the React tree.
    // When the visible surface is Lexical, no native editor is visible and the
    // hidden textarea remains the correct controlled mirror to drive.
    return all.find((e) => isNativeEditor(e) && e.offsetParent !== null) ||
           all.find(isNativeEditor) ||
           getEditor();
  };
  const editorText = () => {
    const e = writeEl();
    if (!e) return "";
    return isNativeEditor(e) ? (e.value || "") : (e.textContent || "");
  };
  // No <form> around the composer; the rounded card is the closest stable frame.
  const composerFrame = () => barAnchor() || (visibleEditor() && visibleEditor().parentElement) || null;

  // A fresh chat: root path "/" with the composer present and no turns.
  const isFreshChat = () =>
    chatIsEmpty() &&
    (IS_CHATGPT ? !/^\/c\//.test(location.pathname) : location.pathname === "/") &&
    !!getEditor();

  // Meta is a React app that reconciles the composer subtree, so we do NOT insert
  // #zs-bar into it. barAnchor() returns the rounded composer card; the core
  // keeps the bar in #zs-root and hugs the card's top edge.
  function barAnchor() {
    const ed = visibleEditor();
    if (!ed) return null;
    let n = ed;
    for (let i = 0; i < 10 && n; i++, n = n.parentElement) {
      if ([...n.classList].some((c) => c.startsWith("rounded"))) return n;
    }
    if (IS_CHATGPT) return ed.closest("form") || ed.parentElement;
    return (ed && ed.parentElement) || null;
  }

  // ChatGPT/Meta use one rounded card for the editor, model selector,
  // attachments and send controls. ChatGPT's current class list no longer has a
  // token that STARTS with "rounded", so barAnchor can legitimately fall back
  // to the surrounding form (which includes ViewCoder's reserved status strip).
  // Resolve the first genuinely rounded ancestor instead for an exact native-card
  // cover without changing the existing status-bar positioning contract.
  function coverTarget() {
    const ed = getEditor();
    if (!ed) return null;
    let n = ed;
    for (let i = 0; i < 10 && n; i++, n = n.parentElement) {
      const radius = Number.parseFloat(getComputedStyle(n).borderTopLeftRadius || "0");
      if (radius >= 8 && n.querySelector("button")) return n;
    }
    return barAnchor() || ed;
  }

  // ── Input lock ──────────────────────────────────────────────────────────────
  // Block the user from typing while the agent works. We drive the composer via
  // the mirror textarea, so locking the on-screen Lexical div's `contenteditable`
  // stops user edits without affecting our own writes. Also mark the textarea
  // readonly as a belt-and-braces (the native setter ignores readonly).
  function setInputLock(on) {
    _locked = on;
    applyLock();
  }
  // Apply the lock state to the live composer nodes. Called by setInputLock AND
  // re-asserted every sweep (enforceComposer) because Meta's React re-renders the
  // composer and would otherwise restore the placeholder / editability mid-lock.
  function applyLock() {
    const div = getEditor();
    if (div && !isNativeEditor(div)) div.setAttribute("contenteditable", _locked ? "false" : "true");
    const ta = writeEl();
    if (ta && isNativeEditor(ta)) { if (_locked) ta.setAttribute("readonly", ""); else ta.removeAttribute("readonly"); }
    // Hide Meta's own composer placeholder ("Demandez à Meta AI…") while locked:
    // it is an absolute, pointer-events-none sibling overlapping the editor and
    // would otherwise show THROUGH the core's "Agent is working…" cover (double
    // text).
    const ph = placeholderEl();
    if (ph) ph.style.visibility = _locked ? "hidden" : "";
  }
  // Meta's Lexical placeholder = a `div.pointer-events-none.absolute` inside the
  // editor's nearest `.relative` container.
  function placeholderEl() {
    if (IS_CHATGPT) return null;
    const div = getEditor();
    const rel = div && div.closest && div.closest(".relative");
    return rel ? rel.querySelector("div.pointer-events-none.absolute") : null;
  }

  // ── Buttons / generation detection ──────────────────────────────────────────
  function visibleComposerButton(selector) {
    const frame = composerFrame();
    const candidates = [
      ...(frame
        ? frame.querySelectorAll(selector)
        : document.querySelectorAll(selector)),
    ];
    return (
      candidates.find(
        (button, index) =>
          candidates.indexOf(button) === index &&
          !button.closest("#zs-root") &&
          button.offsetParent !== null,
      ) || null
    );
  }
  const sendButton = () => visibleComposerButton(S.sendBtn);
  const stopButton = () => {
    const scoped = visibleComposerButton(S.stopBtn);
    if (scoped) return scoped;
    if (!IS_CHATGPT) return null;
    // ChatGPT has changed the composer stop button's aria/test id several
    // times. Keep a narrow fallback outside ViewCoder's own controls.
    return [...document.querySelectorAll("button")].find((button) => {
      if (button.closest("#zs-root") || button.offsetParent === null) return false;
      const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${button.textContent || ""}`;
      return /stop\s*(generating|responding|message)?|cancel\s*(generation|response)/i.test(label);
    }) || null;
  };

  function chatGPTStreamingSurface() {
    if (!IS_CHATGPT) return null;
    const item = lastAssistant();
    if (!item) return null;
    const selectors = [
      ".result-streaming",
      '[data-testid*="generating" i]',
      '[data-testid*="loading" i]',
      '[data-state="loading"]',
      '[aria-busy="true"]',
    ];
    for (const selector of selectors) {
      const node = item.matches?.(selector)
        ? item
        : item.querySelector?.(selector);
      if (node && node.offsetParent !== null) return node;
    }
    return null;
  }

  function streamText(item) {
    const b = bodyOf(item);
    return b ? textWithout(b, ".zs-chip") : "";
  }
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;

  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now; return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  function genActive() {
    sampleStream();
    // The stop button is Meta's authoritative "still working" signal and stays up
    // through the ENTIRE Réflexion reasoning phase (which can run minutes, sometimes
    // with a stray reply fragment emitted BEFORE the reasoning even starts). Trust it
    // outright: present = generating, no timer cap. When it is gone, fall back to the
    // stream-growth idle window. Previously genActive only trusted the button for a
    // 10s growth window, so a long reasoning phase read as "generation ended" ~40s
    // early, the loop abandoned the turn, lastGenAt went stale, and the eventual
    // command landed orphaned ("not run").
    if (stopButton()) return true;
    const surface = chatGPTStreamingSurface();
    if (surface) {
      const text = streamText(lastAssistant()).trim();
      if (!text || grewWithin(Math.max(5000, timings.GEN_IDLE_MS * 2))) return true;
    }
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = () => {
    sampleStream();
    if (stopButton()) return true;
    const surface = chatGPTStreamingSurface();
    if (!surface) return false;
    const text = streamText(lastAssistant()).trim();
    return !text || grewWithin(Math.max(5000, timings.GEN_IDLE_MS * 2));
  };

  // Meta exposes no per-turn "stopped"/"continue" markers.
  const turnHalted = () => false;
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;

  function snapshot() {
    try {
      const b = bodyOf(lastAssistant());
      return { th: 0, rp: b ? textWithout(b).length : 0 };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const b = bodyOf(item);
    return { present: true, reply: b ? textWithout(b, ".zs-chip").trim() : "", thinking: "", item };
  }

  // Native image generation is a separate provider state from ordinary text
  // streaming. ChatGPT, in particular, can remove its normal stop/streaming
  // markers while the image card is still painting ("Polishing details",
  // "Adding final touches", etc.). Expose that state explicitly so the core
  // never sends feedback into the composer while the native renderer owns the
  // turn. Meta AI uses a different surface, hence the provider-specific branch.
  function nativeImageGenerationState(candidate = lastAssistant()) {
    const item = candidate?.closest?.(S.asst) || candidate;
    if ((!item && !IS_CHATGPT) || item?.closest?.("#zs-root")) {
      return { active: false, finished: false };
    }
    let scope = item || document.body;
    const loaded = (image) => {
      if (!image || image.closest?.("#zs-root")) return false;
      const width = Number(image.naturalWidth || 0);
      const height = Number(image.naturalHeight || 0);
      return image.complete === true && width >= 96 && height >= 96;
    };

    if (IS_CHATGPT) {
      const statusPattern = /\b(?:creating|generating|rendering)\s+(?:an?\s+)?image\b|\b(?:preparing\s+visual\s+context|sketching\s+it\s+out|working\s+on\s+it|refining\s+details|finishing\s+up|one\s+last\s+tweak|polishing\s+details|adding\s+final\s+touches|almost\s+there)\b/i;
      const hasImageSignal = (root) => {
        if (!root || root.closest?.("#zs-root")) return false;
        const rootText = textWithout(root, ".zs-chip, #zs-root").replace(/\s+/g, " ").trim();
        return statusPattern.test(rootText) || !!root.querySelector?.(
          '[class*="imagegen-image"], [data-testid*="image-gen" i], img[alt*="Generated image" i]',
        );
      };
      // Native ChatGPT image turns are SECTION[data-testid=conversation-turn-*]
      // and frequently have no data-message-author-role at all. If the ordinary
      // assistant candidate is not that turn, use the newest image-specific turn.
      const candidateTurn = item?.closest?.('[data-testid^="conversation-turn-"]') || item;
      if (!hasImageSignal(candidateTurn)) {
        const imageTurns = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')]
          .filter(hasImageSignal);
        if (imageTurns.length) scope = imageTurns[imageTurns.length - 1];
      } else {
        scope = candidateTurn;
      }
      const text = textWithout(scope, ".zs-chip, #zs-root").replace(/\s+/g, " ").trim();
      const generatedImages = [...scope.querySelectorAll("img")].filter((image) => {
        const alt = image.getAttribute("alt") || "";
        return /generated image/i.test(alt) || !!image.closest('[class*="imagegen-image"], [data-testid*="image-gen" i]');
      });
      const finishedImage = generatedImages.some(loaded);
      const finalActions = !!scope.querySelector('[data-testid="image-gen-overlay-actions"], [data-testid*="image-gen"][data-state="complete"]');
      const busySurface = !!scope.querySelector(
        '[aria-busy="true"], [role="progressbar"], [data-testid*="image-gen" i][data-state="loading"], [class*="imagegen"][class*="loading" i], [class*="imagegen"][class*="generat" i]',
      );
      const status = statusPattern.test(text);
      const imageSurface = !!scope.querySelector('[class*="imagegen-image"], [data-testid*="image-gen" i]');
      const finished = finishedImage && (finalActions || (!busySurface && !status));
      return {
        active: !finished && (status || busySurface || (imageSurface && !finishedImage)),
        finished,
        root: scope,
      };
    }

    const text = textWithout(scope, ".zs-chip, #zs-root").replace(/\s+/g, " ").trim();
    const metaBusy = !!scope.querySelector(
      '[aria-busy="true"], [role="progressbar"], [data-testid*="image" i][data-state="loading"], [class*="image-generation" i][class*="loading" i], [class*="shimmer" i]',
    );
    const metaStatus = /\b(?:creating|generating|rendering|drawing)\s+(?:an?\s+)?image\b|\b(?:finishing|finalizing)\s+(?:the\s+)?image\b/i.test(text);
    const metaImage = [...scope.querySelectorAll('img')].some((image) =>
      loaded(image) && (
        /generated|imagine/i.test(image.getAttribute("alt") || "") ||
        !!image.closest('[data-testid*="image" i], [class*="image-generation" i], [class*="generated-image" i]')
      ),
    );
    return {
      active: !metaImage && (metaBusy || metaStatus),
      finished: metaImage && !metaBusy && !metaStatus,
      root: scope,
    };
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // ── Image attachment (validated live 2026-07-13) ────────────────────────────
  // Meta's composer holds ONE hidden multi-file input[type=file] (accepts image
  // png/jpeg/webp/gif …). Setting its .files + dispatching `change` stages the
  // image: the composer SWAPS to a Lexical contenteditable and the image mounts
  // inline as <span class="inline-image-node"> … <img alt="<filename>">, with a
  // per-image button[aria-label="Remove image"]. Meta keeps a local blob preview
  // and only uploads on SEND (like Arena), so "attach done" = the preview img is
  // present. NOTE: the end-to-end send-with-image path is wired from the DOM
  // contract but not yet exercised live (the test account's message quota was
  // exhausted) - verify with a real screen_capture round-trip.
  function fileFromImage(img, i, batchId = Date.now()) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : mime.includes("gif") ? "gif" : "jpg";
    return new File([arr], `viewcoder_${batchId}_${i}.${ext}`, { type: mime });
  }
  function activeComposerForm() {
    const editor = visibleEditor();
    const form = editor?.closest?.("form");
    return form && !form.closest("#zs-root") ? form : null;
  }
  function activeComposerShell() {
    const form = activeComposerForm();
    if (!form) return composerFrame() || (visibleEditor() && visibleEditor().parentElement) || null;
    // ChatGPT mounts composer attachments in two shapes. Most builds put them
    // inside the unified form's grid header; other builds put them in the
    // adjacent data-prompt-textarea-header slot owned by the form's wrapper.
    // Search that one wrapper, never the whole page (which would count images
    // from old turns in a long chat).
    const parent = form.parentElement;
    if (parent?.querySelector?.(':scope > [data-prompt-textarea-header]')) return parent;
    return form;
  }
  const fileInputEl = () => {
    const form = activeComposerForm();
    const scoped = form && [
      ...form.querySelectorAll('input[type="file"]'),
    ].find((input) => input.multiple || input.id === "upload-files" || input.dataset.photoUploadEnabled === "true");
    if (scoped) return scoped;
    for (const inp of document.querySelectorAll('input[type="file"]')) {
      if (!inp.closest("#zs-root") && inp.closest("form")?.contains(visibleEditor())) return inp;
    }
    return null;
  };
  function attachmentFrame() {
    return IS_CHATGPT
      ? activeComposerShell()
      : composerFrame() || (visibleEditor() && visibleEditor().parentElement) || null;
  }
  function pendingAttachmentImages() {
    const frame = attachmentFrame();
    if (!frame) return [];
    return [...frame.querySelectorAll("img")].filter((image) => (
      !image.closest("#zs-root") &&
      (/^viewcoder_/i.test(image.alt || "") || /^(?:blob:|data:image\/)/i.test(image.currentSrc || image.src || ""))
    ));
  }
  function pendingAttachmentCount() {
    const frame = attachmentFrame();
    if (!frame) return 0;
    const names = new Set(
      pendingAttachmentImages()
        .map((image) => String(image.alt || "").trim())
        .filter(Boolean),
    );
    const removeButtons = frame.querySelectorAll(
      'button[aria-label^="Remove" i], button[data-testid*="remove" i], [data-testid*="attachment" i] button[aria-label*="remove" i]',
    ).length;
    return Math.max(names.size, removeButtons);
  }
  function attachmentBatchReady(expectedNames) {
    if (!expectedNames?.length) return false;
    const stagedNames = new Set(
      pendingAttachmentImages()
        .map((image) => String(image.alt || "").trim())
        .filter(Boolean),
    );
    // Decoded-pixel checks are incorrect for ChatGPT's virtualized thumbnail
    // strip: off-screen thumbnails can legitimately stay lazy/unpainted while
    // all files are already staged. Require the complete filename set when the
    // build exposes names, or the complete set of removable attachment slots in
    // builds whose previews omit alt text. The send-ready button below remains
    // the authority for ChatGPT's upload/processing completion.
    const exactNamesReady = expectedNames.every((name) => stagedNames.has(name));
    return exactNamesReady || pendingAttachmentCount() >= expectedNames.length;
  }
  const hasPendingAttachment = () => pendingAttachmentCount() > 0;
  let _imgSeq = 0;
  function tagImages(images) {
    if (images && images.__zsId == null) {
      try { Object.defineProperty(images, "__zsId", { value: ++_imgSeq, enumerable: false }); }
      catch { images.__zsId = ++_imgSeq; }
    }
    return images;
  }
  async function attachImages(images) {
    const inp = fileInputEl();
    if (!inp || !images || !images.length) return false;
    tagImages(images);
    const batchId = Date.now();
    const dt = new DataTransfer();
    const names = [];
    images.forEach((img, i) => {
      try {
        const file = fileFromImage(img, i, batchId);
        names.push(file.name);
        dt.items.add(file);
      } catch {}
    });
    if (!dt.items.length) return false;
    try {
      inp.files = dt.files;
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    } catch { return false; }
    // Seeing one preview is not acceptance of a multi-image batch. ChatGPT can
    // mount the first thumbnail while the remaining files are still decoding;
    // clicking Send at that point strands the feedback turn and a later retry
    // appends the same seven files again. Require every expected filename to be
    // present with loaded pixels before allowing the send path to continue.
    const ok = names.length === images.length && await waitFor(
      () => attachmentBatchReady(names),
      30_000,
    );
    diag("meta.attach.preview", {
      ok,
      expected: images.length,
      ready: names.filter((name) => attachmentBatchReady([name])).length,
      pending: pendingAttachmentCount(),
    });
    return ok ? { names } : false;
  }
  function clearAttachments() {
    try {
      const frame = attachmentFrame();
      frame?.querySelectorAll(
        'button[aria-label^="Remove" i], button[data-testid*="remove" i], [data-testid*="attachment" i] button[aria-label*="remove" i]',
      ).forEach((b) => { try { b.click(); } catch {} });
    } catch {}
    _attachedImages = null;
    _attachedImageNames = [];
  }

  // ── Sending ─────────────────────────────────────────────────────────────────
  function setTextareaValue(el, v) {
    if (el && el.isContentEditable) {
      el.focus();
      el.textContent = "";
      try {
        document.execCommand("insertText", false, v);
      } catch {
        el.textContent = v;
      }
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: v,
        }),
      );
      return;
    }
    const proto = el?.tagName === "INPUT"
      ? window.HTMLInputElement?.prototype
      : window.HTMLTextAreaElement?.prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function typeAndSend(text, images) {
    const userCountBeforeSend = userCount();
    const userTurnsBeforeSend = allItems().filter(isUserItem);
    const userNodesBeforeSend = new WeakSet(userTurnsBeforeSend);
    const userKeysBeforeSend = new Set(
      userTurnsBeforeSend.map((item) => itemKey(item)).filter(Boolean),
    );
    const normalizeSendText = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const expectedUserText = normalizeSendText(text);
    const expectedPrefix = expectedUserText.slice(0, Math.min(180, expectedUserText.length));
    const matchingUserTurnLanded = () => allItems().some((item) => {
      if (!isUserItem(item)) return false;
      const key = itemKey(item);
      const isNew = key ? !userKeysBeforeSend.has(key) : !userNodesBeforeSend.has(item);
      if (!isNew) return false;
      const candidate = normalizeSendText(itemText(item));
      if (!candidate) return false;
      return candidate === expectedUserText ||
        (expectedPrefix.length >= 12 && candidate.startsWith(expectedPrefix));
    });
    // Images FIRST: staging swaps in the inline image; the mirror textarea still
    // drives the composed text alongside it. Keep it idempotent via the
    // _attachedImages identity guard.
    if (images && images.length && (
      images !== _attachedImages ||
      !attachmentBatchReady(_attachedImageNames)
    )) {
      let attached = false;
      for (let attempt = 1; attempt <= 2 && !attached; attempt++) {
        if (hasPendingAttachment()) {
          clearAttachments();
          await waitFor(() => !hasPendingAttachment(), 5_000);
        }
        try {
          const result = await attachImages(images);
          attached = Boolean(result);
          if (attached) {
            _attachedImages = images;
            _attachedImageNames = result.names;
          }
          diag("meta.tas.attached", {
            ok: attached,
            attempt,
            expected: images.length,
            pending: pendingAttachmentCount(),
            imgId: images.__zsId,
          });
        } catch (e) {
          diag("meta.tas.attachErr", { attempt, msg: String((e && e.message) || e) });
        }
      }
      if (!attached) {
        clearAttachments();
        throw new Error(
          `${IS_CHATGPT ? "ChatGPT" : "Meta AI"} did not finish staging all ${images.length} ViewCoder images.`,
        );
      }
    }
    // Write via the mirror textarea (the controlled input that drives Lexical).
    const editor = writeEl();
    if (!editor) {
      throw new Error(
        `${IS_CHATGPT ? "ChatGPT" : "Meta AI"} input box not found`,
      );
    }
    if (IS_CHATGPT && !isNativeEditor(editor)) {
      editor.setAttribute("contenteditable", "true");
    }
    editor.focus();
    setTextareaValue(editor, text);
    if (IS_CHATGPT && _locked && !isNativeEditor(editor)) {
      editor.setAttribute("contenteditable", "false");
    }
    const sendReady = () => {
      const b = sendButton();
      return !!b && !b.disabled && b.getAttribute("aria-disabled") !== "true";
    };
    const becameSendReady = await waitFor(sendReady, 60000);
    if (!becameSendReady) {
      throw new Error(
        `${IS_CHATGPT ? "ChatGPT" : "Meta AI"} kept the composed ViewCoder message unavailable for sending.`,
      );
    }
    // Dispatch exactly once. In long ChatGPT chats, virtualised turn counters and
    // the controlled composer can remain stale after an accepted click. Re-clicking
    // on that ambiguous signal duplicated every hidden tool-result turn.
    let dispatched = false;
    if (sendReady()) {
      try { sendButton().click(); dispatched = true; } catch {}
    } else if (!isHardGenerating()) {
      const target = visibleEditor() || editor;
      const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      target.dispatchEvent(new KeyboardEvent("keydown", o));
      target.dispatchEvent(new KeyboardEvent("keyup", o));
      dispatched = true;
    }
    if (!dispatched) return { accepted: false, dispatched: false };
    const sent = await waitFor(
      () => userCount() > userCountBeforeSend ||
        matchingUserTurnLanded() ||
        (editorText().trim() === "" && !hasPendingAttachment()),
      10_000,
    );
    if (sent) {
      _attachedImages = null;
      _attachedImageNames = [];
    }
    diag("meta.tas.sent", { sent, editorLen: editorText().length });
    return { accepted: sent, dispatched: true };
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) { try { b.click(); } catch {} }
  }

  // ── Composer readiness ──────────────────────────────────────────────────────
  function enforceComposer() { if (_locked) applyLock(); return { ready: true }; }
  async function ensureComposerReady(reason) {
    // Force Réflexion before the session runs (Instantané is much weaker). Fire and
    // forget - readiness never blocks on it (the mode flip is best-effort).
    diag("mode_ready", {
      reason,
      provider: IS_CHATGPT ? "chatgpt" : "meta",
      ready: !!getEditor(),
    });
    return { ready: !!getEditor() };
  }
  const modeWarning = () => "";
  const captchaPresent = () => false;
  function overlayBlocking() {
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      if (d.closest("#zs-root")) continue;
      const r = d.getBoundingClientRect();
      if (r.width > 40 && r.height > 40 && r.top < innerHeight && r.bottom > 0) return true;
    }
    return false;
  }

  // ── Error / limit detection (site chrome only, never model output) ───────────
  function scanError() {
    try {
      const list = listEl();
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (list && list.contains(el)) continue; // inside a chat turn ⇒ model content
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  // /  = a fresh chat with no conversation id yet → "" (never persisted as
  // "started"). A real conversation is /prompt/<uuid>.
  const conversationKey = () =>
    IS_CHATGPT
      ? (/^\/c\//.test(location.pathname) ? location.pathname : "")
      : (location.pathname === "/" ? "" : location.pathname);

  // ── User-send interception ──────────────────────────────────────────────────
  function installSendHooks(handlers) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        // The user types in the on-screen Lexical div, so match the event target
        // against THAT (getEditor() is the hidden mirror textarea).
        const editor = visibleEditor();
        if (!editor || !editor.contains(e.target)) return;
        if (editorText().trim() === "" && !hasPendingAttachment()) return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return; // existing conversation → not ours to gate
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );

    document.addEventListener(
      "click",
      (e) => {
        if (!getEditor()) return;
        const btn = e.target && e.target.closest && e.target.closest("button");
        if (!btn) return;
        const frame = composerFrame();
        // ChatGPT has unrelated Send/Stop controls in dialogs, shared canvases,
        // voice UI and feedback surfaces. Only the active composer may start or
        // halt ViewCoder; document-wide fuzzy matching caused phantom state
        // changes in long conversations.
        if (IS_CHATGPT && frame && !frame.contains(btn)) return;
        if (btn.closest(S.stopBtn) || btn.matches(S.stopBtn)) { handlers.onNativeStop(); return; }
        if (!(btn.closest(S.sendBtn) || btn.matches(S.sendBtn))) return;
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
  }

  // ── Tool-block location for camouflage ───────────────────────────────────────
  // Meta renders a command block as a .ur-code-block (the JSON viewer widget OR a
  // plain <pre>). Hide every such wrapper carrying a command shape, plus any bare
  // top-level block holding an inline command. React recreates the rendered
  // subtree on stream settle and on the next send, so also mark the assistant body
  // (its identity survives) with .zs-cmd-mask; the overlay.css rule keeps recreated
  // code wrappers hidden.
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  const LUA_SHAPE = /###\s*(?:lua|end_lua)\s*###/i;
  const DIRECT_COMMAND_SHAPE = /\[VC-CMD\]/i;
  // ChatGPT sometimes renders a ViewCoder request as a normal fenced JSON
  // block without the optional [VC-CMD] wrapper. Match only a block that starts
  // with the real command envelope, so prose/examples elsewhere stay visible.
  const STANDALONE_JSON_COMMAND_SHAPE = /^(?:json\s*)?\{\s*"(?:command|tool)"\s*:/i;
  const isPersistentCommandSource = (source) => {
    const text = String(source || "").trim();
    return DIRECT_COMMAND_SHAPE.test(text) || STANDALONE_JSON_COMMAND_SHAPE.test(text);
  };
  const _knownLuaMessageIds = new Set();
  const _knownCommandMessageIds = new Set();
  let _luaMaskObserver = null;

  function luaMessageId(item) {
    return IS_CHATGPT && item ? item.getAttribute("data-message-id") || "" : "";
  }

  function rememberLuaMask(item) {
    if (!IS_CHATGPT || !item) return false;
    const messageId = luaMessageId(item);
    if (messageId) _knownLuaMessageIds.add(messageId);
    item.classList.add("zs-lua-command-mask");
    const b = bodyOf(item);
    if (b) {
      b.classList.add("zs-cmd-mask");
      for (const pre of b.querySelectorAll("pre")) {
        if (!pre.closest(".zs-chip")) pre.classList.add("zs-tool-hide");
      }
    }
    return true;
  }

  function rememberDirectCommandMask(item) {
    if (!IS_CHATGPT || !item) return false;
    const messageId = luaMessageId(item);
    if (messageId) _knownCommandMessageIds.add(messageId);
    item.classList.add("zs-command-mask");
    const b = bodyOf(item);
    if (b) {
      b.classList.add("zs-cmd-mask");
      for (const pre of b.querySelectorAll("pre")) {
        if (!pre.closest(".zs-chip")) pre.classList.add("zs-tool-hide");
      }
    }
    return true;
  }

  function clearCommandMask(item) {
    if (!IS_CHATGPT || !item) return;
    const messageId = luaMessageId(item);
    if (messageId) _knownLuaMessageIds.delete(messageId);
    if (messageId) _knownCommandMessageIds.delete(messageId);
    item.classList.remove("zs-lua-command-mask", "zs-command-mask");
  }

  // ZeroScript protects virtualized Monaco blocks with a MutationObserver. Use
  // the same lifecycle idea for ChatGPT's CodeMirror, but inspect only assistant
  // turns touched by added nodes instead of rescanning the whole conversation on
  // every mutation. Observer callbacks run before paint, so a recreated Lua <pre>
  // is masked without the one-frame flash seen while scrolling.
  function ensureLuaMaskObserver() {
    if (!IS_CHATGPT || _luaMaskObserver || !document.body) return;
    const inspectItem = (item, changedRoot = null) => {
      if (!item || item.getAttribute("data-message-author-role") !== "assistant") return;
      const messageId = luaMessageId(item);
      const rememberedLua = !!messageId && _knownLuaMessageIds.has(messageId);
      const rememberedCommand = !!messageId && _knownCommandMessageIds.has(messageId);
      if (rememberedLua || item.classList.contains("zs-lua-command-mask")) {
        rememberLuaMask(item);
        return;
      }
      if (rememberedCommand || item.classList.contains("zs-command-mask")) {
        rememberDirectCommandMask(item);
        return;
      }
      // For an unknown turn, inspect only the changed <pre> subtree. Reading the
      // whole growing assistant message on every token would become quadratic on
      // long ordinary replies—the performance trap documented in ZeroScript's
      // older full-conversation observer.
      const pres = new Set();
      const root = changedRoot || item;
      if (root.matches?.("pre")) pres.add(root);
      const parentPre = root.closest?.("pre");
      if (parentPre && item.contains(parentPre)) pres.add(parentPre);
      for (const pre of root.querySelectorAll?.("pre") || []) pres.add(pre);
      if ([...pres].some((pre) => LUA_SHAPE.test(pre.textContent || ""))) {
        rememberLuaMask(item);
      } else if ([...pres].some((pre) => isPersistentCommandSource(pre.textContent || ""))) {
        rememberDirectCommandMask(item);
      } else if (isPersistentCommandSource(root.textContent || "")) {
        rememberDirectCommandMask(item);
      }
    };
    const inspectNode = (node) => {
      const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      if (!el) return;
      const ownItem = el.matches?.('[data-message-author-role="assistant"]')
        ? el
        : el.closest?.('[data-message-author-role="assistant"]');
      if (ownItem) inspectItem(ownItem, el);
      for (const item of el.querySelectorAll?.('[data-message-author-role="assistant"]') || []) {
        inspectItem(item, item);
      }
    };
    _luaMaskObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) inspectNode(node);
      }
    });
    try {
      _luaMaskObserver.observe(document.body, { subtree: true, childList: true });
    } catch {}
    for (const item of document.querySelectorAll('[data-message-author-role="assistant"]')) {
      inspectItem(item, item);
    }
  }

  function findToolBlockSpot(item /*, chip */) {
    const b = bodyOf(item);
    if (!b) return null;
    let hidAny = null;
    // 1. Code wrappers (JSON viewer or <pre>) carrying a command.
    b.querySelectorAll(S.codeWrap).forEach((cw) => {
      if (cw.closest(".zs-chip")) return;
      const source = cw.textContent || "";
      if (CMD_SHAPE.test(source)) {
        cw.classList.add("zs-tool-hide");
        b.classList.add("zs-cmd-mask");
        // ChatGPT rehydrates nested CodeMirror <pre> blocks as they enter the
        // viewport. That replacement loses the per-<pre> zs-tool-hide class.
        // Keep stable masks on direct command turns so CodeMirror rehydration in
        // long chats cannot expose the raw call before the activity card remounts.
        if (IS_CHATGPT && LUA_SHAPE.test(source)) {
          rememberLuaMask(item);
        } else if (IS_CHATGPT && isPersistentCommandSource(source)) {
          rememberDirectCommandMask(item);
        }
        hidAny = hidAny || { parent: cw.parentElement, ref: cw };
      }
    });
    // 2. Bare blocks with an inline command (no code wrapper). In long
    // conversations Meta stops fencing the emitted JSON, so the raw
    // {"command": …} renders as a plain paragraph - seen live 2026-07-16.
    // The command may sit a level or two below the body, so walk p/div
    // descendants and hide the TOPMOST matching block (document order puts
    // parents first; skip anything under an already-hidden ancestor).
    b.querySelectorAll("p, div").forEach((el) => {
      if (el.closest(".zs-chip, .zs-tool-hide, " + S.codeWrap)) return;
      if (el.querySelector(S.codeWrap)) return;
      const t = (el.textContent || "").trim();
      // A block that STARTS with the command JSON / marker is a command no
      // matter its size (execute_luau payloads run thousands of chars); the
      // 600-char cap only guards blocks where the shape appears mid-text.
      const t0 = t.replace(/^json\s*/i, "");
      const startsAsCmd = /^\{\s*"(?:command|tool)"\s*:/.test(t0) || /^###\s*(?:lua|mcp_tool)/i.test(t0);
      if ((startsAsCmd || t.length < 600) && CMD_SHAPE.test(t) && /^[{#]/.test(t0)) {
        el.classList.add("zs-tool-hide");
        if (IS_CHATGPT && isPersistentCommandSource(t)) {
          rememberDirectCommandMask(item);
        }
        hidAny = hidAny || { parent: el.parentElement, ref: el };
      }
    });
    // Long Lua is sometimes rendered as many bare sibling text nodes. Mask the
    // stable turn anchor so the raw script cannot leak around the ViewCoder card.
    const whole = textWithout(b, ".zs-chip").trim();
    if (CMD_SHAPE.test(whole) && /###\s*(?:lua|mcp_tool)/i.test(whole)) {
      const anchor = chipAnchor(item) || item;
      anchor.classList.add("zs-plain-command-mask");
      if (IS_CHATGPT && LUA_SHAPE.test(whole)) {
        rememberLuaMask(item);
      } else if (IS_CHATGPT && isPersistentCommandSource(whole)) {
        rememberDirectCommandMask(item);
      }
      hidAny = hidAny || { parent: anchor, ref: anchor.firstElementChild };
    }
    return hidAny;
  }

  return {
    id: IS_CHATGPT ? "chatgpt" : "meta",
    displayName: IS_CHATGPT ? "ChatGPT" : "Meta AI",
    unstableWarning: "",
    noticeLabel: "",
    // Meta's composer accepts image uploads (hidden multi-file input → inline
    // Lexical preview → uploaded on send; see attachImages). Vision-capable, so
    // screen_capture is exposed (main.js BLOCKED_TOOLS gate). The send-with-image
    // path is wired from the live DOM contract but not yet exercised end-to-end.
    supportsVision: true,
    timings,
    // React reconciles a turn's content subtree on every update, wiping a chip
    // placed inside it. Anchor chips at the turn-element level instead.
    chipAtItemLevel: true,
    chipAnchor,
    chipAppend: true,
    // Turn elements are not virtualized away, so assistantCount() reliably
    // increases for every reply - the core's watcher uses this.
    reliableCounts: true,
    init({ diag: d } = {}) { if (d) diag = d; ensureLuaMaskObserver(); },
    // turns
    allItems, isUserItem, isAssistantItem, itemText, classifyText, commandSourceCandidates,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot, nativeImageGenerationState,
    // composer / state
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
    // Blanket the complete ChatGPT/Meta prompt card, including native model,
    // attachment and send controls. ViewCoder's own status row remains above it.
    coverTarget,
    coverMaxH: 260,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady, modeWarning, captchaPresent, overlayBlocking,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    // actions
    attachImages, clearAttachments, conversationKey, installSendHooks, findToolBlockSpot,
    clearCommandMask,
  };
})();
