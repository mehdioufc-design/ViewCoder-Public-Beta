// core/parser.js - ViewCoder command parsing. PURE string logic, zero DOM:
// the provider extracts a turn's text from the site's DOM; everything here
// operates on that text. The command formats (###LUA### blocks, {"command":…}
// JSON) are defined by OUR system prompt, so they are the same on every AI site
// - only the way a site's markdown may mangle them differs (the regexes below
// are whitespace/dash tolerant for that reason).
// eslint-disable-next-line no-unused-vars
const ZSParse = (() => {
  "use strict";

  const START_M = "###MCP_TOOL###";
  const END_M = "###END_MCP_TOOL###";
  const MCP_START_RE = /###\s*mcp(?:[_\- ]+)tool\s*###/i;
  const MCP_END_RE = /###\s*end(?:[_\- ]+)mcp(?:[_\- ]+)tool\s*###/i;
  // Whitespace-tolerant markers: site markdown can insert spaces around the
  // hashes (e.g. "### LUA ###") or render END_LUA with a dash. These regexes
  // match those variants so a marker mangled by markdown still parses.
  // The optional `:Edit|:Server|:Client` suffix selects the Roblox datamodel
  // execute_luau runs against (the MCP REQUIRES datamodel_type; a bare
  // ###LUA### defaults to "Edit" so the model never has to think about it
  // outside play-testing).
  const LUA_START_RE = /###\s*lua(?:\s*[:\-_ ]\s*(edit|client|server))?\s*(?:###|---)/i;
  const LUA_END_RE = /###\s*end[_\- ]?lua\s*###/i;
  const LUA_DEFAULT_DM = "Edit";
  const dmName = (m) => (m ? m[0].toUpperCase() + m.slice(1).toLowerCase() : LUA_DEFAULT_DM);

  // Chat sites render fenced code in several incompatible shapes. Some use
  // real per-line blocks; ChatGPT commonly uses inline syntax-highlight spans
  // plus raw text nodes. Providers collect innerText, textContent and (only
  // when appropriate) line-block candidates, then this helper chooses the
  // most complete command representation without any DOM assumptions.
  function renderedCodeScore(value) {
    const text = String(value || "");
    if (!text.trim()) return -1;
    let score = Math.min(text.length, 100_000) / 100_000;
    const luaStart = LUA_START_RE.test(text);
    const luaEnd = LUA_END_RE.test(text);
    if (luaStart && luaEnd) score += 100;
    else if (luaStart || luaEnd) score += 10;
    const mcpStart = MCP_START_RE.test(text);
    const mcpEnd = MCP_END_RE.test(text);
    if (mcpStart && mcpEnd) score += 90;
    else if (mcpStart || mcpEnd) score += 9;
    if (/"(?:command|tool)"\s*:\s*"/.test(text)) {
      const firstBrace = text.indexOf("{");
      score += firstBrace !== -1 && matchBrace(text, firstBrace) !== -1 ? 80 : 8;
    }
    score += Math.min((text.match(/\r?\n/g) || []).length, 200) / 200;
    return score;
  }

  function chooseRenderedCodeText(candidates) {
    let best = "";
    let bestScore = -1;
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const value = String(candidate || "");
      const score = renderedCodeScore(value);
      if (score > bestScore) {
        best = value;
        bestScore = score;
      }
    }
    return best;
  }

  // Find the first LUA start marker at or after `from`. Returns { pos, len, dm }
  // where len is the marker's own length to skip past it and dm the requested
  // datamodel ("Edit" when unspecified).
  function findLuaStart(text, from = 0) {
    const m = LUA_START_RE.exec(text.slice(from));
    return m ? { pos: from + m.index, len: m[0].length, dm: dmName(m[1]) } : { pos: -1, len: 0, dm: LUA_DEFAULT_DM };
  }

  // Find the first LUA end marker at or after `from`. Returns its start index or -1.
  function findLuaEnd(text, from = 0) {
    const m = LUA_END_RE.exec(text.slice(from));
    return m ? from + m.index : -1;
  }

  function commandBoundaryBefore(text, start) {
    const lineStart = Math.max(
      text.lastIndexOf("\n", start - 1),
      text.lastIndexOf("\r", start - 1),
    ) + 1;
    const prefix = text.slice(lineStart, start).trim();
    // Some provider toolbars are flattened without whitespace into the same
    // text node as the code: DeepSeek currently yields
    // `jsonCopyDownload{"command":...}`. Accept only a complete sequence of
    // known code-chrome tokens, keeping ordinary prose before a JSON example
    // outside the command boundary.
    return !prefix || /^(?:(?:```(?:json|lua|luau)?|json|copy(?:\s*code)?|download)\s*)+$/i.test(prefix);
  }

  function commandBoundaryAfter(text, end) {
    const nl = text.indexOf("\n", end);
    const cr = text.indexOf("\r", end);
    const candidates = [nl, cr].filter((value) => value !== -1);
    const lineEnd = candidates.length ? Math.min(...candidates) : text.length;
    const suffix = text.slice(end, lineEnd).trim();
    return (
      !suffix ||
      /^(?:```|copy)$/i.test(suffix) ||
      MCP_END_RE.test(suffix)
    );
  }

  function findStandaloneLuaStart(text, from = 0) {
    let cursor = from;
    while (cursor < text.length) {
      const found = findLuaStart(text, cursor);
      if (found.pos === -1) return found;
      if (commandBoundaryBefore(text, found.pos)) return found;
      cursor = found.pos + Math.max(found.len, 1);
    }
    return { pos: -1, len: 0, dm: LUA_DEFAULT_DM };
  }

  function findMcpMarker(text, regex, from = 0) {
    const match = regex.exec(text.slice(from));
    return match
      ? { pos: from + match.index, len: match[0].length }
      : { pos: -1, len: 0 };
  }

  function findStandaloneMcpStart(text, from = 0) {
    let cursor = from;
    while (cursor < text.length) {
      const found = findMcpMarker(text, MCP_START_RE, cursor);
      if (found.pos === -1) return found;
      if (commandBoundaryBefore(text, found.pos)) return found;
      cursor = found.pos + Math.max(found.len, 1);
    }
    return { pos: -1, len: 0 };
  }

  function findMcpEnd(text, from = 0) {
    return findMcpMarker(text, MCP_END_RE, from);
  }

  // Strip a code-block UI label (the "Copy" button caption, or a leftover fence
  // language token like "json") that some sites bleed into the block's text
  // right after the opening marker. Seen live on Kimi: its code-block chrome
  // renders as `###lua### Copy <code>`, so the bare-marker slice below would
  // capture `Copy task.wait(...)` as the Lua code - not valid Lua, so StudioMCP
  // rejects it with "Failed to parse command code". The JSON path already does
  // this at line ~206; mirror it for the raw ###LUA### extraction. Requires
  // trailing whitespace (\s+) so it never eats a legitimate identifier like
  // `Copy(x)` that a script might genuinely start with.
  function stripCodeChrome(code) {
    return code.replace(/^(?:json|copy)\s+/i, "");
  }

  // A command is `{"command":"name", ...}` (or "tool"). The params/arguments
  // object is OPTIONAL: paramless commands like list_commands are written as
  // `{"command":"list_commands"}`, so requiring "params" too would MISS them
  // (they'd be shown raw and never executed). We key on the `"command":"…"` /
  // `"tool":"…"` shape instead - a string-valued key, which prose almost never
  // contains - so paramless calls are detected without false-positiving on text.
  const CMD_KEY_RE = /"(?:command|tool)"\s*:\s*"/;

  function hasToolSignature(r) {
    return (
      findStandaloneMcpStart(r).pos !== -1 ||
      findStandaloneLuaStart(r).pos !== -1 ||
      !!findStandaloneToolEnvelope(r, true)
    );
  }

  // True if the reply contains a tool block that has STARTED but not yet CLOSED
  // (a ###LUA### / ###MCP_TOOL### opener with no matching end marker). Used by the
  // response watcher to avoid finalizing a command that is still being streamed.
  function hasOpenToolBlock(r) {
    if (!r) return false;
    const { pos: ls, len } = findStandaloneLuaStart(r);
    if (ls !== -1 && findLuaEnd(r, ls + len) === -1) return true;
    const mcp = findStandaloneMcpStart(r);
    if (mcp.pos !== -1 && findMcpEnd(r, mcp.pos + mcp.len).pos === -1) {
      return true;
    }
    // Only a standalone JSON envelope is a command. A command-shaped example
    // embedded in explanatory prose must remain ordinary assistant text.
    return findStandaloneToolEnvelope(r, true)?.open === true;
  }

  // Normalise a parsed JSON object into { tool, arguments }, accepting both the
  // new ViewCoder schema ("command"/"params") and the legacy/function-calling
  // schema ("tool"/"arguments"/"name"/"args"). Returns null if not a valid call.
  function normalizeCall(o) {
    if (!o || typeof o !== "object") return null;
    const name = o.command != null ? o.command : (o.tool != null ? o.tool : o.name);
    let args = o.params != null ? o.params : (o.arguments != null ? o.arguments : o.args);
    if (typeof name !== "string" || !name) return null;
    if (!args || typeof args !== "object") args = {};
    return { tool: name, arguments: args };
  }

  // String-aware matching-brace finder: index of the "}" that closes the "{" at
  // `start`, SKIPPING braces inside JSON string literals (escaped quotes handled).
  // A naive depth counter miscounts the braces embedded in code passed as a string
  // value (e.g. multi_edit's edits / a Lua snippet), grabs the wrong end, and makes
  // JSON.parse fail - which silently dropped the command, so the tool never ran and
  // the turn was treated as a plain-text answer. Returns -1 if unbalanced.
  function matchBrace(text, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { if (--depth === 0) return i; }
    }
    return -1;
  }

  // JSON.parse with a fallback for RAW control characters inside string
  // literals (tab/newline/CR). Models sometimes emit a literal TAB instead of
  // \t inside a command's string value (seen live on Gemini in a big
  // multi_edit); strict JSON rejects it, the parse failed silently and the
  // command was never executed. The fallback walks the text string-aware and
  // escapes those characters ONLY inside string literals, then re-parses.
  function parseLoose(raw) {
    try {
      return JSON.parse(raw);
    } catch (e0) {
      let out = "", inStr = false, esc = false;
      for (const c of raw) {
        if (inStr) {
          if (esc) { esc = false; out += c; continue; }
          if (c === "\\") { esc = true; out += c; continue; }
          if (c === '"') { inStr = false; out += c; continue; }
          if (c === "\t") { out += "\\t"; continue; }
          if (c === "\n") { out += "\\n"; continue; }
          if (c === "\r") { out += "\\r"; continue; }
          out += c;
          continue;
        }
        if (c === '"') inStr = true;
        out += c;
      }
      return JSON.parse(out); // may still throw - callers catch
    }
  }

  function extractJson(raw) {
    raw = raw.trim().replace(/^(?:json|JSON)\s*/, "");
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const s = raw.indexOf("{");
    if (s === -1) return null;
    const e = matchBrace(raw, s);            // string-aware: not the last "}" in code
    if (e === -1) return null;
    try {
      return parseLoose(raw.slice(s, e + 1));
    } catch {
      return null;
    }
  }

  function findStandaloneToolEnvelope(text, allowOpen = false) {
    for (const key of ['"command"', '"tool"']) {
      let pos = 0;
      while (true) {
        const keyAt = text.indexOf(key, pos);
        if (keyAt === -1) break;
        const start = text.lastIndexOf("{", keyAt);
        if (start === -1 || !commandBoundaryBefore(text, start)) {
          pos = keyAt + 1;
          continue;
        }
        const end = matchBrace(text, start);
        if (end === -1) {
          if (allowOpen) return { start, end: -1, open: true };
          pos = keyAt + 1;
          continue;
        }
        if (!commandBoundaryAfter(text, end + 1)) {
          pos = keyAt + 1;
          continue;
        }
        return { start, end, open: false };
      }
    }
    return null;
  }

  function extractToolAnywhere(text) {
    const envelope = findStandaloneToolEnvelope(text);
    if (!envelope) return null;
    try {
      return normalizeCall(
        parseLoose(text.slice(envelope.start, envelope.end + 1)),
      );
    } catch {
      return null;
    }
  }

  function parseToolCalls(r) {
    const out = [];
    let from = 0;
    while (true) {
      const start = findStandaloneMcpStart(r, from);
      if (start.pos === -1) break;
      const end = findMcpEnd(r, start.pos + start.len);
      if (end.pos === -1) break;
      const body = r.slice(start.pos + start.len, end.pos);
      const { pos: ls, len: luaLen, dm } = findLuaStart(body);
      const le = findLuaEnd(body, ls === -1 ? 0 : ls + luaLen);
      if (ls !== -1 && le !== -1 && le > ls) {
        out.push({ tool: "execute_luau", arguments: { code: stripCodeChrome(body.slice(ls + luaLen, le).trim()), datamodel_type: dm } });
        from = end.pos + end.len;
        continue;
      }
      for (const sub of [body]) {
        const cleaned = sub.trim().replace(/^(?:json|JSON|Copy|copy)\s*/i, "").trim();
        if (!cleaned) continue;
        const p = normalizeCall(extractJson(cleaned));
        if (p) out.push(p);
      }
      from = end.pos + end.len;
    }
    // Prefer a JSON command envelope when one is present: a model may wrap
    // execute_luau as {"command":"execute_luau","params":{"code":"###LUA###…"}},
    // and the bare-marker fallback below would slice the still-ESCAPED JSON
    // source (literal \n, \") instead of the decoded code. extractToolAnywhere
    // JSON-decodes it; cleanLuaCall (applied at the end) then strips the markers.
    if (out.length === 0) {
      const f = extractToolAnywhere(r);
      if (f) out.push(f);
    }
    // Bare ###LUA### … ###END_LUA### block with no JSON envelope at all.
    if (out.length === 0) {
      const { pos: ls, len: luaLen, dm } = findStandaloneLuaStart(r);
      const le = findLuaEnd(r, ls === -1 ? 0 : ls + luaLen);
      if (ls !== -1 && le !== -1 && le > ls) {
        out.push({ tool: "execute_luau", arguments: { code: stripCodeChrome(r.slice(ls + luaLen, le).trim()), datamodel_type: dm } });
      }
    }
    return out.map(cleanLuaCall);
  }

  // Some models (seen live on GLM) wrap execute_luau in the JSON envelope AND
  // keep the ###LUA### / ###END_LUA### markers INSIDE the code string, e.g.
  //   {"command":"execute_luau","params":{"code":"###LUA###\n<lua>\n###END_LUA###"}}
  // Once JSON-decoded the code still starts with the literal markers, which the
  // MCP rejects ("Failed to parse command code"). Strip a leading start marker
  // and a trailing end marker from execute_luau's code, and adopt the marker's
  // datamodel when none was given. No-op for a clean code string.
  function cleanLuaCall(call) {
    if (!call || call.tool !== "execute_luau") return call;
    const code = call.arguments && call.arguments.code;
    if (typeof code !== "string") return call;
    const s = findLuaStart(code);
    if (s.pos === -1) return call;
    const e = findLuaEnd(code, s.pos + s.len);
    call.arguments.code = code.slice(s.pos + s.len, e === -1 ? code.length : e).trim();
    if (!call.arguments.datamodel_type) call.arguments.datamodel_type = s.dm;
    return call;
  }

  // Last-resort salvage of a CUT-OFF JSON command: the model hit its output
  // limit with the whole payload complete but the trailing closers missing
  // (seen live on Qwen: a big multi_edit missing exactly ONE final "}").
  // Strictly conservative - we only auto-close when it is provably just the
  // closing sequence that was lost, never when actual content was amputated:
  //  - the scan must NOT end inside a string literal (a value cut mid-string
  //    means real content is missing → keep the parse_error);
  //  - the last non-whitespace char must terminate a complete JSON value
  //    (`"`, `}`, `]`, digit, or the tail of true/false/null);
  //  - at most MAX_SALVAGE_CLOSERS closers may be appended. 2 covers the
  //    root-brace and params-brace cases; a deeper deficit usually means the
  //    cut fell between items (e.g. mid-edits-array), where running a partial
  //    command would be dangerous - the retry feedback stays the right call.
  // Callers must only invoke this once generation has ENDED (the watcher's
  // parse_error branch), never on a still-streaming reply.
  const MAX_SALVAGE_CLOSERS = 2;
  function salvageCutOff(text) {
    for (const key of ['"command"', '"tool"']) {
      const k = text.indexOf(key);
      if (k === -1) continue;
      const start = text.lastIndexOf("{", k);
      if (start === -1 || !commandBoundaryBefore(text, start)) continue;
      if (matchBrace(text, start) !== -1) continue; // closed → not our case
      // String-aware bracket stack from the opener to the end of the text.
      const stack = [];
      let inStr = false, esc = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === "{") stack.push("}");
        else if (c === "[") stack.push("]");
        else if (c === "}" || c === "]") {
          if (stack.pop() !== c) return null; // mismatched nesting → hopeless
        }
      }
      if (inStr) return null;                       // cut mid-string value
      if (!stack.length || stack.length > MAX_SALVAGE_CLOSERS) return null;
      const body = text.slice(start).trimEnd();
      if (!/["}\]0-9]$|(?:true|false|null)$/.test(body)) return null; // value incomplete
      try {
        const call = normalizeCall(parseLoose(body + stack.reverse().join("")));
        if (call) return cleanLuaCall(call);
      } catch {}
      return null;
    }
    return null;
  }

  function toolNameFromText(txt) {
    // Match the name even BEFORE its closing quote (`[^"]*`), so the chip shows
    // the real command name AS IT IS TYPED instead of a generic "command"
    // placeholder until the JSON closes. A still-empty value falls through.
    // Trim: while the value is still streaming it can be whitespace-only (e.g.
    // Kimi renders `"tool": "    "` for a beat), which would otherwise show a
    // blank chip label until the loop repaints it. A whitespace value falls
    // through to the placeholder below instead.
    const m = txt.match(/"(?:command|tool)"\s*:\s*"([^"]*)/);
    if (m && m[1].trim()) return m[1].trim();
    if (txt.includes("execute_luau") || LUA_START_RE.test(txt)) return "execute_luau";
    return "command";
  }

  // A turn the EXTENSION injected (always sent as a user turn): a tool result, an
  // ERROR, or a "(System note: …)" control message. Matched ONLY by the fixed
  // shapes we emit - never by command-like keywords, since a parse-error note
  // quotes a {"command": …} example that must NOT be read as a real command.
  function isInjectedFeedback(txt) {
    return /^\s*Output of '/.test(txt) ||
           /^\s*ERROR\b/.test(txt) ||
           /^\s*\(System note:/.test(txt);
  }

  // The assistant emitted a ViewCoder command (JSON or a ###LUA### block).
  function hasCommandShape(txt) {
    return findStandaloneMcpStart(txt).pos !== -1 ||
           findStandaloneLuaStart(txt).pos !== -1 ||
           !!findStandaloneToolEnvelope(txt, true);
  }

  return {
    START_M, END_M, MCP_START_RE, MCP_END_RE,
    LUA_START_RE, LUA_END_RE, CMD_KEY_RE,
    findLuaStart, findLuaEnd, matchBrace, extractJson, normalizeCall,
    chooseRenderedCodeText,
    hasToolSignature, hasOpenToolBlock, parseToolCalls, salvageCutOff, toolNameFromText,
    isInjectedFeedback, hasCommandShape,
  };
})();
