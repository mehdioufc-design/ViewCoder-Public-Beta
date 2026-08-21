(async () => {
  "use strict";

  const http = await import("node:http");
  const https = await import("node:https");
  const dns = await import("node:dns/promises");
  const net = await import("node:net");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const childProcess = await import("node:child_process");
  const readline = await import("node:readline");
  const crypto = await import("node:crypto");
  const { pathToFileURL } = await import("node:url");

  const VERSION = "1.0.0";
  const HOST = "127.0.0.1";
  const PORT = numberFromEnvironment("VIEWCODER_PORT", 3000);
  const SCRIPT_DIRECTORY = path.dirname(
    path.resolve(process.argv[1] || "."),
  );
  const {
    VIEWCODER_TOOL_DEFINITIONS,
    createWorkflowEngine,
  } = await import(
    pathToFileURL(path.join(SCRIPT_DIRECTORY, "workflow-engine.mjs")).href
  );
  const {
    ROBLOX_RIG_OPTIONS,
    normalizeRobloxRigOptions,
    buildRobloxRigScript,
  } = await import(
    pathToFileURL(path.join(SCRIPT_DIRECTORY, "animation-rig.mjs")).href
  );
  const MAX_BODY_BYTES = 1_000_000;
  const MAX_RELAY_IMAGE_BYTES = 15_000_000;
  const MAX_RELAY_IMAGE_BODY_BYTES =
    Math.ceil((MAX_RELAY_IMAGE_BYTES * 4) / 3) + 100_000;
  const MAX_RELAY_IMAGES = 24;
  const MAX_RELAY_IMAGE_CACHE_BYTES = 64_000_000;
  const RELAY_IMAGE_TTL_MS = 30 * 60 * 1000;
  const REMOTE_IMAGE_TIMEOUT_MS = 20_000;
  const MAX_REMOTE_IMAGE_REDIRECTS = 5;
  const MAX_REMOTE_IMAGE_URL_LENGTH = 2_048;
  const MAX_EVENTS = 250;
  const MAX_SEEN_REQUESTS = 500;
  const MAX_QUEUED_JOBS = 100;
  const TOOL_TIMEOUT_MS = 125_000;
  // End Blender's MCP request just inside the browser's 60-second response
  // window, leaving enough time to deliver the timeout result to the existing
  // alternative-route recovery card.
  const BLENDER_TOOL_TIMEOUT_MS = 58_000;
  const BLENDER_ADDON_PROBE_TIMEOUT_MS = 6_000;
  const BLENDER_ADDON_PROBE_TTL_MS = 4_000;
  const BLENDER_ADDON_PROTOCOL_VERSION = 4;
  const SKIP_MCP = process.env.VIEWCODER_SKIP_MCP === "1";
  const CONFIG_PATH = path.resolve(
    process.env.VIEWCODER_CONFIG_PATH ||
      path.join(SCRIPT_DIRECTORY, "viewcoder.config.json"),
  );
  const BLENDER_TOOL_PREFIX = "blender/";
  const LIVE_CATALOG_TOOLS = new Set([
    "viewcoder/get_capabilities",
    "list_commands",
    "list_mcp_servers",
  ]);
  // Blender's MCP process can advertise tools while its in-app socket is still
  // unavailable. A dedicated get_addon_status protocol handshake below is the
  // only authority for whether Blender is truly connected.
  const ADDON_RUNTIME_PROBES = Object.freeze({});
  const BLENDER_IMPORT_TOOL = "viewcoder_import_blender_scene";
  const BLENDER_IMPORT_SENTINEL = "VIEWCODER_MESH_JSON:";
  const MAX_BLENDER_TRIANGLES = 10_000;
  const STUDIO_INPUT_FOCUS_TIMEOUT_MS = 30_000;
  const DEFAULT_CONFIG = Object.freeze({
    servers: {
      blender: {
        enabled: false,
        command: process.platform === "win32" ? "cmd.exe" : "uvx",
        args:
          process.platform === "win32"
            ? [
                "/d",
                "/s",
                "/c",
                "uvx",
                "--with",
                "mcp[cli]==1.29.0",
                "blender-mcp",
              ]
            : ["--with", "mcp[cli]==1.29.0", "blender-mcp"],
        env: {
          BLENDER_HOST: "127.0.0.1",
          BLENDER_PORT: "9876",
          DISABLE_TELEMETRY: "true",
        },
      },
    },
  });
  const BLENDER_IMPORT_DEFINITION = Object.freeze({
    name: BLENDER_IMPORT_TOOL,
    server: "viewcoder",
    description:
      "Transfer the visible mesh objects currently in Blender into the open Roblox Studio place as EditableMesh MeshParts. Use this after Blender materially helped create or edit custom geometry. Do not use it for scripts, UI, terrain, or simple Roblox primitives.",
    inputSchema: {
      type: "object",
      properties: {
        target_name: {
          type: "string",
          description: "Name of the imported Model in Workspace.",
        },
        max_triangles: {
          type: "integer",
          minimum: 100,
          maximum: MAX_BLENDER_TRIANGLES,
          description:
            "Safety ceiling for total imported triangles. Simplify in Blender if the scene exceeds it.",
        },
        position: {
          type: "object",
          description:
            "Optional Roblox world position for the imported model pivot.",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            z: { type: "number" },
          },
          required: ["x", "y", "z"],
        },
        replace_existing: {
          type: "boolean",
          description:
            "Replace an existing Workspace child with the same target name only after the new import succeeds.",
        },
      },
    },
  });
  const ALLOWED_LOCAL_ORIGINS = new Set([
    `http://${HOST}:${PORT}`,
    `http://localhost:${PORT}`,
  ]);

  const bridgeStartedAt = new Date().toISOString();
  const jobs = [];
  const events = [];
  const seenRequests = new Map();
  const semanticRequests = new Map();
  // Keep completed receipts independently from the rolling event stream. A
  // Manifest V3 service worker can restart while Studio or Blender is still
  // executing; the browser can then reclaim the original receipt by job id
  // instead of either losing the result or running the mutation twice.
  const completedJobs = new Map();
  // Browser chat attachments cannot be read from Roblox Studio's process and
  // blob:/sandbox: URLs are scoped to the AI page. Keep a small, expiring local
  // image cache and expose each item over this loopback server so Studio's
  // upload_image command receives a normal HTTP URL.
  const relayImages = new Map();
  let processingQueue = false;
  let keyboardCancelGeneration = 0;
  let studioProbePromise = null;
  let nextJobId = 1;
  let nextEventId = 1;
  let shutdownStarted = false;
  let studioProbe = {
    connected: false,
    name: null,
    id: null,
    checkedAt: null,
    error: null,
  };
  let blenderAddonProbePromise = null;
  let blenderAddonProbe = {
    connected: false,
    protocolVersion: null,
    expectedProtocolVersion: BLENDER_ADDON_PROTOCOL_VERSION,
    addonVersion: null,
    blenderVersion: null,
    capabilities: [],
    source: null,
    checkedAt: null,
    error: null,
  };
  let lastConnectedAnnouncement = null;
  let studioDisconnectedSince = 0;
  let studioProcessRunning = false;
  let studioProcessCheckedAt = 0;
  let lastStudioReconnectInstructionAt = 0;
  let bridgeConfig = await readBridgeConfig();

  class StudioMcpClient {
    constructor() {
      this.child = null;
      this.state = SKIP_MCP ? "disabled" : "offline";
      this.tools = [];
      this.pending = new Map();
      this.nextRequestId = 1;
      this.connectPromise = null;
      this.serial = Promise.resolve();
      this.lastError = null;
      this.launchDescription = null;
    }

    async connect() {
      if (SKIP_MCP) return false;
      if (this.connectPromise) return this.connectPromise;
      if (this.child && this.child.exitCode == null) return true;

      this.connectPromise = this.connectInternal()
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          if (this.child) {
            this.handleDisconnect(error);
          } else {
            this.state = "offline";
            this.tools = [];
            this.lastError = this.lastError || message;
            this.rejectPending(
              new Error(`Studio MCP connection failed: ${this.lastError}`),
            );
          }
          throw new Error(this.lastError || message);
        })
        .finally(() => {
          this.connectPromise = null;
        });
      return this.connectPromise;
    }

    async connectInternal() {
      this.state = "connecting";
      this.lastError = null;
      const launch = await resolveStudioLaunch();
      this.launchDescription = launch.description;
      log(`Launching Roblox Studio MCP: ${launch.description}`, "info");

      const child = childProcess.spawn(
        launch.command,
        launch.args,
        {
          cwd: SCRIPT_DIRECTORY,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      this.child = child;
      child.stdin.setDefaultEncoding("utf8");

      const output = readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });
      output.on("line", (line) => this.handleLine(line));
      child.stderr.on("data", (chunk) => {
        const message = String(chunk).trim();
        if (message) log(`Studio MCP: ${message}`, "detail");
      });
      child.on("error", (error) => {
        this.handleDisconnect(error);
      });
      child.on("exit", (code, signal) => {
        if (this.child !== child) return;
        const reason = new Error(
          `Studio MCP exited (${code ?? signal ?? "unknown"}).`,
        );
        this.handleDisconnect(reason);
      });

      await this.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "viewcoder-bridge",
            version: VERSION,
          },
        },
        30_000,
      );
      this.notify("notifications/initialized", {});

      for (let attempt = 0; attempt < 12; attempt += 1) {
        await this.refreshTools(4_000).catch(() => []);
        if (this.tools.length) break;
        await delay(900);
      }

      this.state = this.tools.length ? "ready" : "waiting";
      log(
        this.tools.length
          ? `Studio MCP connected (${this.tools.length} tools).`
          : "Studio MCP is running but Studio has not advertised tools yet.",
        this.tools.length ? "success" : "warning",
      );
      return true;
    }

    handleLine(line) {
      const trimmed = String(line || "").trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        log(`Ignored non-JSON Studio MCP output: ${trimmed}`, "detail");
        return;
      }

      if (
        message.method === "notifications/tools/list_changed"
      ) {
        void this.refreshTools().catch(() => {});
        return;
      }

      if (message.id == null) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(
            message.error.message ||
              JSON.stringify(message.error),
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
    }

    handleDisconnect(error) {
      this.lastError =
        error instanceof Error ? error.message : String(error);
      this.state = "offline";
      this.tools = [];
      const child = this.child;
      this.child = null;
      if (child?.stdin && !child.stdin.destroyed) {
        try {
          child.stdin.destroy();
        } catch {
          // The process has already closed.
        }
      }
      this.rejectPending(
        new Error(`Studio MCP disconnected: ${this.lastError}`),
      );
      studioProbe = {
        connected: false,
        name: null,
        id: null,
        checkedAt: new Date().toISOString(),
        error: this.lastError,
      };
      if (!shutdownStarted) {
        log(this.lastError, "warning");
      }
    }

    rejectPending(error) {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    }

    notify(method, params) {
      if (!this.child || this.child.exitCode != null) return;
      this.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method,
          params: params ?? {},
        })}\n`,
      );
    }

    request(method, params, timeoutMs = 30_000) {
      if (!this.child || this.child.exitCode != null) {
        return Promise.reject(
          new Error("Studio MCP is not running."),
        );
      }

      const id = this.nextRequestId;
      this.nextRequestId += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new Error(
              `Studio MCP timed out while handling ${method}.`,
            ),
          );
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        try {
          this.child.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              method,
              params: params ?? {},
            })}\n`,
          );
        } catch (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    }

    async refreshTools(timeoutMs = 15_000) {
      const result = await this.request(
        "tools/list",
        {},
        timeoutMs,
      );
      const nextTools = Array.isArray(result.tools) ? result.tools : [];
      // A reconnect can briefly return an empty catalog while Studio is still
      // restoring its MCP session. Keep the last verified catalog in that gap.
      if (nextTools.length || !this.tools.length) {
        this.tools = nextTools;
      }
      this.state = this.tools.length ? "ready" : "waiting";
      return this.tools;
    }

    callTool(name, argumentsObject, timeoutMs = TOOL_TIMEOUT_MS) {
      const run = async () => {
        await this.connect();
        if (
          !this.tools.some((tool) => tool.name === name)
        ) {
          await this.refreshTools().catch(() => []);
        }
        if (
          !this.tools.some((tool) => tool.name === name)
        ) {
          throw new Error(
            `Studio MCP does not currently advertise "${name}". Open a place and enable Studio as MCP server.`,
          );
        }
        const definition = this.tools.find(
          (tool) => tool.name === name,
        );
        const schemaError = validateSchemaValue(
          argumentsObject ?? {},
          definition?.inputSchema ??
            definition?.input_schema ??
            {},
          "arguments",
          true,
        );
        if (schemaError) {
          throw bridgeError(
            "INVALID_ARGUMENTS",
            `${name}: ${schemaError}`,
          );
        }

        const result = await this.request(
          "tools/call",
          {
            name,
            arguments: argumentsObject ?? {},
          },
          timeoutMs,
        );
        const normalized = normalizeToolResult(result);
        if (result?.isError) {
          throw new Error(
            normalized.text || `Studio tool "${name}" failed.`,
          );
        }
        const normalizedFailure = normalizedToolFailure(
          name,
          normalized.text,
        );
        if (normalizedFailure) {
          throw normalizedFailure;
        }
        const softError = normalized.text.trim();
        if (
          softError.length <= 280 &&
          /\b(?:is required|must be defined|is invalid|not available)\b/i.test(
            softError,
          )
        ) {
          throw bridgeError(
            "INVALID_ARGUMENTS",
            softError,
          );
        }
        return normalized;
      };
      this.serial = this.serial.then(run, run);
      return this.serial;
    }

    async reconnect() {
      const previousConnect = this.connectPromise;
      await this.stop();
      if (previousConnect) {
        await previousConnect.catch(() => false);
      }
      return this.connect();
    }

    async stop() {
      const child = this.child;
      this.child = null;
      this.state = "offline";
      this.tools = [];
      this.rejectPending(
        new Error("Studio MCP stopped before the request completed."),
      );
      if (!child || child.exitCode != null) return;

      if (process.platform === "win32") {
        await new Promise((resolve) => {
          const killer = childProcess.spawn(
            "taskkill",
            ["/PID", String(child.pid), "/T", "/F"],
            {
              stdio: "ignore",
              windowsHide: true,
            },
          );
          killer.on("exit", resolve);
          killer.on("error", resolve);
        });
      } else {
        child.kill("SIGTERM");
      }
    }
  }

  class AddonMcpClient {
    constructor(id, label, configProvider) {
      this.id = id;
      this.label = label;
      this.configProvider = configProvider;
      this.child = null;
      this.state = this.enabled() && !SKIP_MCP ? "offline" : "disabled";
      this.tools = [];
      this.pending = new Map();
      this.nextRequestId = 1;
      this.connectPromise = null;
      this.serial = Promise.resolve();
      this.lastError = null;
      this.launchDescription = null;
      this.stderrTail = "";
      this.failureCount = 0;
      this.nextReconnectAt = 0;
      this.lastWarningAt = 0;
      this.lastWarningText = "";
      this.runtimeVerified = !ADDON_RUNTIME_PROBES[this.id];
      this.nextRuntimeProbeAt = 0;
    }

    config() {
      return this.configProvider?.() ?? {};
    }

    enabled() {
      return this.config()?.enabled === true;
    }

    async connect() {
      if (SKIP_MCP || !this.enabled()) {
        this.state = "disabled";
        return false;
      }
      if (this.connectPromise) return this.connectPromise;
      if (this.child && this.child.exitCode == null) {
        return this.ready();
      }
      this.connectPromise = this.connectInternal()
        .catch((error) => {
          if (this.state === "connecting") {
            this.handleDisconnect(error);
          }
          throw new Error(
            this.lastError ||
              (error instanceof Error ? error.message : String(error)),
          );
        })
        .finally(() => {
          this.connectPromise = null;
        });
      return this.connectPromise;
    }

    async connectInternal() {
      this.state = "connecting";
      this.lastError = null;
      this.stderrTail = "";
      const spec = normalizedAddonLaunch(this.config(), this.id);
      this.launchDescription = [spec.command, ...spec.args].join(" ");
      log(`Connecting ${this.label} MCP: ${this.launchDescription}`, "info");

      const child = childProcess.spawn(spec.command, spec.args, {
        cwd: SCRIPT_DIRECTORY,
        env: {
          ...process.env,
          ...spec.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      child.stdin.setDefaultEncoding("utf8");

      const output = readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });
      output.on("line", (line) => this.handleLine(line));
      child.stderr.on("data", (chunk) => {
        const message = String(chunk).trim();
        if (!message) return;
        this.stderrTail = `${this.stderrTail}\n${message}`.slice(-2_000);
        log(`${this.label} MCP: ${message}`, "detail");
      });
      child.on("error", (error) => this.handleDisconnect(error));
      child.on("exit", (code, signal) => {
        if (this.child !== child) return;
        const detail = this.stderrTail.trim();
        this.handleDisconnect(
          new Error(
            `${this.label} MCP exited (${code ?? signal ?? "unknown"}).${
              detail ? ` ${detail}` : ""
            }`,
          ),
        );
      });

      try {
        await this.request(
          "initialize",
          {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: {
              name: "viewcoder-bridge",
              version: VERSION,
            },
          },
          30_000,
        );
        this.notify("notifications/initialized", {});
        await this.refreshTools(20_000);
        if (this.tools.length && ADDON_RUNTIME_PROBES[this.id]) {
          await this.verifyRuntime(8_000);
        }
        this.state =
          this.tools.length && this.runtimeVerified
            ? "ready"
            : "waiting";
        if (!this.tools.length) {
          this.lastError =
            `${this.label} connected but did not advertise any tools.`;
        } else if (this.runtimeVerified) {
          this.lastError = null;
        }
        if (this.tools.length && this.runtimeVerified) {
          this.resetReconnectBackoff();
        }
        log(
          this.tools.length && this.runtimeVerified
            ? `${this.label} MCP connected (${this.tools.length} tools).`
            : this.lastError ||
                `${this.label} MCP is waiting for its application add-on.`,
          this.tools.length && this.runtimeVerified
            ? "success"
            : "warning",
        );
        return this.tools.length > 0 && this.runtimeVerified;
      } catch (error) {
        if (this.child) {
          this.handleDisconnect(error);
        } else if (!this.lastError) {
          this.lastError = friendlyAddonError(
            this.id,
            error instanceof Error ? error.message : String(error),
          );
        }
        throw new Error(this.lastError);
      }
    }

    handleLine(line) {
      const trimmed = String(line || "").trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        log(
          `Ignored non-JSON ${this.label} MCP output: ${trimmed}`,
          "detail",
        );
        return;
      }
      if (message.method === "notifications/tools/list_changed") {
        void this.refreshTools().catch(() => {});
        return;
      }
      if (message.id == null) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(
            message.error.message || JSON.stringify(message.error),
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
    }

    handleDisconnect(error) {
      const raw = error instanceof Error ? error.message : String(error);
      const stderr = this.stderrTail.trim();
      this.lastError = friendlyAddonError(
        this.id,
        `${raw}${stderr && !raw.includes(stderr) ? ` ${stderr}` : ""}`,
      );
      this.state = this.enabled() && !SKIP_MCP ? "offline" : "disabled";
      this.tools = [];
      this.runtimeVerified = !ADDON_RUNTIME_PROBES[this.id];
      this.nextRuntimeProbeAt = 0;
      this.failureCount += 1;
      this.nextReconnectAt =
        Date.now() +
        Math.min(60_000, 5_000 * 2 ** Math.min(4, this.failureCount - 1));
      const child = this.child;
      this.child = null;
      if (child?.stdin && !child.stdin.destroyed) {
        try {
          child.stdin.destroy();
        } catch {
          // The process has already closed.
        }
      }
      this.rejectPending(
        new Error(`${this.label} MCP disconnected: ${this.lastError}`),
      );
      if (
        !shutdownStarted &&
        this.enabled() &&
        (this.lastWarningText !== this.lastError ||
          Date.now() - this.lastWarningAt >= 30_000)
      ) {
        this.lastWarningText = this.lastError;
        this.lastWarningAt = Date.now();
        log(this.lastError, "warning");
      }
    }

    rejectPending(error) {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    }

    resetReconnectBackoff() {
      this.failureCount = 0;
      this.nextReconnectAt = 0;
      this.lastWarningAt = 0;
      this.lastWarningText = "";
    }

    ready() {
      return (
        this.state === "ready" &&
        this.tools.length > 0 &&
        this.runtimeVerified
      );
    }

    markRuntimeUnavailable(error) {
      const message = friendlyAddonError(
        this.id,
        error instanceof Error ? error.message : String(error),
      );
      this.runtimeVerified = false;
      this.state = "waiting";
      this.lastError = message;
      this.nextRuntimeProbeAt = Date.now() + 5_000;
      if (
        this.lastWarningText !== message ||
        Date.now() - this.lastWarningAt >= 30_000
      ) {
        this.lastWarningText = message;
        this.lastWarningAt = Date.now();
        log(message, "warning");
      }
    }

    async verifyRuntime(timeoutMs = 8_000) {
      const probeName = ADDON_RUNTIME_PROBES[this.id];
      if (!probeName) {
        this.runtimeVerified = true;
        return true;
      }
      const probe = this.tools.find(
        (tool) => tool.name === probeName,
      );
      // Compatible add-on MCP implementations may not expose the preferred
      // harmless probe. A successful real call remains authoritative then.
      if (!probe) {
        this.runtimeVerified = true;
        return true;
      }
      const probeArguments = buildReadOnlyProbeArguments(
        probe,
        this.label,
      );
      // MCP schemas can evolve. Avoid repeatedly sending an invalid health
      // request when a future server adds unsupported required fields.
      if (probeArguments == null) {
        this.runtimeVerified = true;
        return true;
      }
      try {
        const result = await this.request(
          "tools/call",
          {
            name: probe.name,
            arguments: probeArguments,
          },
          timeoutMs,
        );
        const normalized = normalizeToolResult(result, this.label);
        if (
          result?.isError ||
          isAddonConnectionFailure(this.id, normalized.text)
        ) {
          this.markRuntimeUnavailable(
            normalized.text ||
              `${this.label} application add-on is unavailable.`,
          );
          return false;
        }
        this.runtimeVerified = true;
        this.state = "ready";
        this.lastError = null;
        this.nextRuntimeProbeAt = 0;
        return true;
      } catch (error) {
        if (
          isAddonConnectionFailure(
            this.id,
            error instanceof Error ? error.message : String(error),
          )
        ) {
          this.markRuntimeUnavailable(error);
          return false;
        }
        throw error;
      }
    }

    notify(method, params) {
      if (!this.child || this.child.exitCode != null) return;
      this.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method,
          params: params ?? {},
        })}\n`,
      );
    }

    request(method, params, timeoutMs = 30_000) {
      if (!this.child || this.child.exitCode != null) {
        return Promise.reject(
          new Error(`${this.label} MCP is not running.`),
        );
      }
      const id = this.nextRequestId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new Error(
              `${this.label} MCP timed out while handling ${method}.`,
            ),
          );
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        try {
          this.child.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              method,
              params: params ?? {},
            })}\n`,
          );
        } catch (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    }

    async refreshTools(timeoutMs = 15_000) {
      const result = await this.request("tools/list", {}, timeoutMs);
      const nextTools = Array.isArray(result.tools) ? result.tools : [];
      if (nextTools.length || !this.tools.length) {
        this.tools = nextTools;
      }
      this.state =
        this.tools.length && this.runtimeVerified
          ? "ready"
          : "waiting";
      return this.tools;
    }

    callTool(name, argumentsObject, timeoutMs = TOOL_TIMEOUT_MS) {
      const run = async () => {
        await this.connect();
        if (!this.tools.some((tool) => tool.name === name)) {
          await this.refreshTools().catch(() => []);
        }
        const definition = this.tools.find((tool) => tool.name === name);
        if (!definition) {
          throw bridgeError(
            "ADDON_CONNECTION",
            `${this.label} MCP does not currently advertise "${name}".`,
          );
        }
        const schemaError = validateSchemaValue(
          argumentsObject ?? {},
          definition.inputSchema ?? definition.input_schema ?? {},
          "arguments",
          true,
        );
        if (schemaError) {
          throw bridgeError(
            "INVALID_ARGUMENTS",
            `${this.label} ${name}: ${schemaError}`,
          );
        }
        let result;
        try {
          result = await this.request(
            "tools/call",
            {
              name,
              arguments: argumentsObject ?? {},
            },
            timeoutMs,
          );
        } catch (error) {
          if (
            isAddonConnectionFailure(
              this.id,
              error instanceof Error ? error.message : String(error),
            )
          ) {
            this.markRuntimeUnavailable(error);
            throw bridgeError(
              "ADDON_CONNECTION",
              this.lastError,
            );
          }
          throw error;
        }
        const normalized = normalizeToolResult(result, this.label);
        if (
          result?.isError ||
          /^Error executing code:/i.test(normalized.text)
        ) {
          if (isAddonConnectionFailure(this.id, normalized.text)) {
            this.markRuntimeUnavailable(normalized.text);
            throw bridgeError(
              "ADDON_CONNECTION",
              this.lastError,
            );
          }
          throw bridgeError(
            "TOOL_ERROR",
            normalized.text || `${this.label} tool "${name}" failed.`,
          );
        }
        this.runtimeVerified = true;
        this.state = "ready";
        this.lastError = null;
        return normalized;
      };
      this.serial = this.serial.then(run, run);
      return this.serial;
    }

    async reconnect() {
      const previousConnect = this.connectPromise;
      this.resetReconnectBackoff();
      await this.stop();
      if (previousConnect) {
        await previousConnect.catch(() => false);
      }
      return this.connect();
    }

    async stop() {
      const child = this.child;
      this.child = null;
      this.state = this.enabled() && !SKIP_MCP ? "offline" : "disabled";
      this.tools = [];
      this.runtimeVerified = !ADDON_RUNTIME_PROBES[this.id];
      this.nextRuntimeProbeAt = 0;
      this.rejectPending(
        new Error(`${this.label} MCP stopped before the request completed.`),
      );
      if (!child || child.exitCode != null) return;
      if (process.platform === "win32") {
        await new Promise((resolve) => {
          const killer = childProcess.spawn(
            "taskkill",
            ["/PID", String(child.pid), "/T", "/F"],
            {
              stdio: "ignore",
              windowsHide: true,
            },
          );
          killer.on("exit", resolve);
          killer.on("error", resolve);
        });
      } else {
        child.kill("SIGTERM");
      }
    }
  }

  const mcp = new StudioMcpClient();
  const blenderMcp = new AddonMcpClient(
    "blender",
    "Blender",
    () => bridgeConfig.servers.blender,
  );
  const addonClients = Object.freeze({
    blender: blenderMcp,
  });
  let toolCatalogSyncPromise = null;

  async function synchronizeToolCatalogs(timeoutMs = 20_000) {
    if (SKIP_MCP) return false;
    if (toolCatalogSyncPromise) return toolCatalogSyncPromise;

    const synchronization = (async () => {
      const pending = [];
      if (!mcp.tools.length || mcp.state !== "ready") {
        pending.push(
          mcp
            .connect()
            .then(() =>
              mcp.tools.length ? true : mcp.refreshTools(timeoutMs),
            )
            .catch(() => false),
        );
      }
      for (const client of Object.values(addonClients)) {
        if (
          client.enabled() &&
          (!client.tools.length || client.state !== "ready")
        ) {
          pending.push(
            client
              .connect()
              .then(() =>
                client.tools.length ? true : client.refreshTools(timeoutMs),
              )
              .catch(() => false),
          );
        }
      }
      if (pending.length) await Promise.allSettled(pending);
      return true;
    })();

    toolCatalogSyncPromise = synchronization.finally(() => {
      toolCatalogSyncPromise = null;
    });
    return toolCatalogSyncPromise;
  }
  const workflowEngine = createWorkflowEngine({
    storageDir: path.join(SCRIPT_DIRECTORY, ".viewcoder", "projects"),
    iconLibraryDir: path.join(SCRIPT_DIRECTORY, "Game Icon Library"),
    listTools: async () => {
      await refreshBlenderAddonProbe().catch(() => blenderAddonProbe);
      return advertisedNativeTools();
    },
    callTool: async (tool, argumentsObject, metadata) =>
      callAdvertisedNativeTool(tool, argumentsObject, metadata),
    publishImage: async (filePath, metadata = {}) => {
      const resolved = path.resolve(filePath);
      const allowedRoots = [
        {
          root: path.resolve(SCRIPT_DIRECTORY, "Game Icon Library"),
          source: "game-icon-library",
        },
        {
          root: path.resolve(SCRIPT_DIRECTORY, ".viewcoder", "projects", "generated-icons"),
          source: "viewcoder-local-vector-icon",
        },
      ];
      const allowed = allowedRoots.find(({ root }) => {
        const relative = path.relative(root, resolved);
        return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
      });
      if (!allowed) {
        throw httpError(403, "The requested image is outside ViewCoder's verified icon directories.");
      }
      const data = await fs.readFile(resolved);
      const image = storeRelayImageData(data, {
        declaredMime: "image/png",
        name: metadata.name || path.basename(resolved),
        source: metadata.source || allowed.source,
      });
      const safeName = encodeURIComponent(image.name);
      return {
        id: image.id,
        url: `http://${HOST}:${PORT}/images/${image.id}/${safeName}`,
        mimeType: image.mimeType,
        name: image.name,
        size: image.data.length,
        expiresAt: new Date(image.expiresAt).toISOString(),
      };
    },
    getProjectId: async () => {
      await refreshStudioProbe().catch(() => studioProbe);
      return (
        studioProbe.id ||
        studioProbe.name ||
        (blenderAddonProbe.connected ? "blender-local" : "local-project")
      );
    },
  });

  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (!originAllowed(origin)) {
      return sendJson(
        response,
        403,
        {
          ok: false,
          error: "This browser origin is not allowed.",
        },
        origin,
      );
    }
    setCors(response, origin);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const requestUrl = new URL(
      request.url || "/",
      `http://${HOST}:${PORT}`,
    );
    try {
      const relayMatch = requestUrl.pathname.match(
        /^\/images\/([A-Za-z0-9_-]{16,80})(?:\/[^/]*)?$/,
      );
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        relayMatch
      ) {
        pruneRelayImages();
        const image = relayImages.get(relayMatch[1]);
        if (!image) {
          return sendJson(
            response,
            404,
            { ok: false, error: "This relayed image expired or does not exist." },
            origin,
          );
        }
        image.lastAccessedAt = Date.now();
        setCors(response, origin);
        response.writeHead(200, {
          "Content-Type": image.mimeType,
          "Content-Length": image.data.length,
          "Content-Disposition": `inline; filename="${image.name}"`,
          "Cache-Control": "private, max-age=60",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(request.method === "HEAD" ? undefined : image.data);
        return;
      }

      if (
        request.method === "POST" &&
        requestUrl.pathname === "/images/fetch"
      ) {
        const body = await readJsonBody(request, 100_000);
        const image = await fetchRemoteRelayImage(body);
        const safeName = encodeURIComponent(image.name);
        return sendJson(
          response,
          201,
          {
            ok: true,
            id: image.id,
            url: `http://${HOST}:${PORT}/images/${image.id}/${safeName}`,
            mimeType: image.mimeType,
            name: image.name,
            size: image.data.length,
            source: "remote",
            expiresAt: new Date(image.expiresAt).toISOString(),
          },
          origin,
        );
      }

      if (
        request.method === "POST" &&
        requestUrl.pathname === "/images"
      ) {
        const body = await readJsonBody(
          request,
          MAX_RELAY_IMAGE_BODY_BYTES,
        );
        const image = storeRelayImage(body);
        const safeName = encodeURIComponent(image.name);
        return sendJson(
          response,
          201,
          {
            ok: true,
            id: image.id,
            url: `http://${HOST}:${PORT}/images/${image.id}/${safeName}`,
            mimeType: image.mimeType,
            name: image.name,
            size: image.data.length,
            expiresAt: new Date(image.expiresAt).toISOString(),
          },
          origin,
        );
      }

      if (
        request.method === "GET" &&
        requestUrl.pathname === "/status"
      ) {
        await refreshBlenderAddonProbe().catch(() => blenderAddonProbe);
        return sendJson(response, 200, statusPayload(), origin);
      }

      if (
        request.method === "GET" &&
        requestUrl.pathname === "/tools"
      ) {
        // Do not report a false zero-tool state while MCP discovery is still
        // running. Concurrent browser requests share this single sync pass.
        await synchronizeToolCatalogs();
        await refreshBlenderAddonProbe().catch(() => blenderAddonProbe);
        const tools = advertisedTools();
        const nativeTools = advertisedNativeTools();
        const error = nativeTools.length
          ? null
          : [mcp.lastError, blenderMcp.lastError]
              .filter(Boolean)
              .join(" | ") ||
            "No connected target has advertised MCP tools yet.";
        return sendJson(
          response,
          200,
          {
            ok: nativeTools.length > 0,
            tools,
            servers: serverStatuses(),
            error,
          },
          origin,
        );
      }

      if (
        request.method === "GET" &&
        requestUrl.pathname === "/servers"
      ) {
        await refreshBlenderAddonProbe().catch(() => blenderAddonProbe);
        return sendJson(response, 200, serversPayload(), origin);
      }

      if (
        request.method === "GET" &&
        requestUrl.pathname === "/animation/rig/options"
      ) {
        return sendJson(
          response,
          200,
          { ok: true, robloxOnly: true, ...ROBLOX_RIG_OPTIONS },
          origin,
        );
      }

      if (
        request.method === "POST" &&
        requestUrl.pathname === "/animation/rig"
      ) {
        const body = await readJsonBody(request, 50_000);
        let options;
        try {
          options = normalizeRobloxRigOptions(body);
        } catch (error) {
          throw httpError(
            400,
            error instanceof Error ? error.message : String(error),
          );
        }
        if (!blenderMcp.enabled()) {
          throw httpError(
            409,
            "Animation Mode requires Blender. Connect Blender in ViewCoder first.",
          );
        }
        await refreshBlenderAddonProbe(true).catch(() => blenderAddonProbe);
        if (
          !blenderAddonProbe.connected ||
          !blenderMcp.tools.some(
            (tool) => tool?.name === "execute_blender_code",
          )
        ) {
          throw httpError(
            409,
            "Blender is not ready to import a Roblox rig. Start the Blender MCP add-on on port 9876, then try again.",
          );
        }
        const result = await blenderMcp.callTool(
          "execute_blender_code",
          { code: buildRobloxRigScript(options) },
          BLENDER_TOOL_TIMEOUT_MS,
        );
        const rigReceipt = String(result?.text || "").match(
          /VIEWCODER_RIG_IMPORTED:([^:\r\n]+):([^:\r\n]+):([^:\r\n]+):([^:\r\n]+):(\d+):(\d+):([01]):(bundled):([^:\r\n]+)(?:\r?\n|$)/,
        );
        if (!rigReceipt) {
          throw httpError(
            502,
            "Blender did not verify a complete visible Roblox rig. Nothing was reported as ready to animate.",
          );
        }
        const [, rigName, verifiedRigType, verifiedBodyShape, verifiedPreset,
          meshCountText, boneCountText, viewportFramedText, sourceKind,
          sourceFile] = rigReceipt;
        const meshCount = Number(meshCountText);
        const boneCount = Number(boneCountText);
        if (
          verifiedRigType !== options.rigType ||
          verifiedBodyShape !== options.bodyShape ||
          verifiedPreset !== options.preset ||
          sourceKind !== "bundled"
        ) {
          throw httpError(
            502,
            "Blender returned a different rig than the one ViewCoder requested.",
          );
        }
        return sendJson(
          response,
          201,
          {
            ok: true,
            robloxOnly: true,
            rig: {
              ...options,
              name: rigName,
              meshCount,
              boneCount,
              bundledSource: sourceFile,
            },
            blender: {
              imported: true,
              viewportFramed: viewportFramedText === "1",
              verified: true,
              output: String(result?.text || "").slice(0, 2_000),
            },
          },
          origin,
        );
      }

      const serverToggleMatch = requestUrl.pathname.match(
        /^\/servers\/(blender)$/,
      );
      if (request.method === "POST" && serverToggleMatch) {
        const serverId = serverToggleMatch[1];
        const body = await readJsonBody(request);
        if (typeof body.enabled !== "boolean") {
          throw httpError(
            400,
            `The ${serverId} connection requires an enabled boolean.`,
          );
        }
        await setAddonEnabled(serverId, body.enabled);
        if (body.enabled) {
          await refreshBlenderAddonProbe(true).catch(() => blenderAddonProbe);
        }
        return sendJson(response, 202, serversPayload(), origin);
      }

      const serverReconnectMatch = requestUrl.pathname.match(
        /^\/servers\/(blender)\/reconnect$/,
      );
      if (request.method === "POST" && serverReconnectMatch) {
        const serverId = serverReconnectMatch[1];
        const client = addonClients[serverId];
        await readJsonBody(request).catch(() => ({}));
        if (!client.enabled()) {
          throw httpError(
            409,
            `Enable the ${client.label} connection before reconnecting it.`,
          );
        }
        await client.reconnect().catch(() => false);
        await refreshBlenderAddonProbe(true).catch(() => blenderAddonProbe);
        return sendJson(
          response,
          202,
          {
            ...serversPayload(),
            state: "connecting",
          },
          origin,
        );
      }

      if (
        request.method === "POST" &&
        requestUrl.pathname === "/input/cancel"
      ) {
        await readJsonBody(request).catch(() => ({}));
        keyboardCancelGeneration++;
        return sendJson(
          response,
          200,
          { ok: true, keyboardCancelGeneration },
          origin,
        );
      }

      if (
        request.method === "GET" &&
        requestUrl.pathname === "/pull"
      ) {
        const after = Math.max(
          0,
          Number(requestUrl.searchParams.get("after")) || 0,
        );
        const sessionId =
          requestUrl.searchParams.get("sessionId") || "";
        const selected = events
          .filter(
            (event) =>
              event.eventId > after &&
              (!sessionId || event.sessionId === sessionId),
          )
          .slice(0, 40);
        const cursor = selected.length
          ? selected[selected.length - 1].eventId
          : after;
        return sendJson(
          response,
          200,
          {
            ok: true,
            cursor,
            events: selected,
          },
          origin,
        );
      }

      const jobStatusMatch = requestUrl.pathname.match(
        /^\/jobs\/([1-9][0-9]*)$/,
      );
      if (request.method === "GET" && jobStatusMatch) {
        const jobId = Number(jobStatusMatch[1]);
        const sessionId = requestUrl.searchParams.get("sessionId") || "";
        const completed = completedJobs.get(jobId);
        if (completed) {
          if (sessionId && completed.sessionId !== sessionId) {
            throw httpError(404, "That ViewCoder job does not belong to this chat session.");
          }
          return sendJson(
            response,
            200,
            { ok: true, state: "completed", jobId, result: completed },
            origin,
          );
        }
        const pending =
          jobs.some((candidate) => candidate.jobId === jobId) ||
          [...semanticRequests.values()].some(
            (candidate) => candidate?.jobId === jobId,
          );
        if (pending) {
          return sendJson(
            response,
            202,
            { ok: true, state: "pending", jobId },
            origin,
          );
        }
        throw httpError(404, "That ViewCoder job is no longer available.");
      }

      if (
        request.method === "POST" &&
        requestUrl.pathname === "/push"
      ) {
        const body = await readJsonBody(request);
        const job = await createJob(body);
        // Connection-sensitive catalog reads must never reuse an older
        // completed response. A server may connect after an identical request,
        // so replaying the previous job would incorrectly report zero tools.
        const requiresFreshCatalog = LIVE_CATALOG_TOOLS.has(
          String(job.tool || "").trim().toLowerCase(),
        );
        const previous = requiresFreshCatalog
          ? undefined
          : seenRequests.get(job.requestId);
        const semanticPrevious = requiresFreshCatalog
          ? undefined
          : semanticRequests.get(job.semanticKey);
        if (previous || semanticPrevious) {
          const previousJobId = previous || semanticPrevious.jobId;
          const completed = completedJobs.get(previousJobId);
          return sendJson(
            response,
            202,
            {
              ok: true,
              duplicate: true,
              jobId: previousJobId,
              state: completed
                ? "completed"
                : semanticPrevious?.state || "pending",
              ...(completed ? { result: completed } : {}),
              queued: jobs.length,
            },
            origin,
          );
        }
        if (jobs.length >= MAX_QUEUED_JOBS) {
          throw httpError(
            429,
            "ViewCoder already has too many queued commands. Wait for the current Studio work to finish.",
          );
        }

        seenRequests.set(job.requestId, job.jobId);
        trimMap(seenRequests, MAX_SEEN_REQUESTS);
        semanticRequests.set(job.semanticKey, {
          jobId: job.jobId,
          state: "queued",
          updatedAt: Date.now(),
        });
        trimMap(semanticRequests, MAX_SEEN_REQUESTS);
        jobs.push(job);
        log(
          `Queued ${job.tool} from ${job.source.provider || "browser"} (job ${job.jobId}).`,
          "info",
        );
        void processJobs();
        return sendJson(
          response,
          202,
          {
            ok: true,
            jobId: job.jobId,
            queued: jobs.length,
          },
          origin,
        );
      }

      if (
        request.method === "POST" &&
        requestUrl.pathname === "/mcp/verify"
      ) {
        await readJsonBody(request).catch(() => ({}));
        if (!SKIP_MCP && !processingQueue) {
          if (mcp.state !== "ready") {
            await mcp.connect();
          }
          if (!mcp.tools.length) {
            await mcp.refreshTools();
          }
          await refreshStudioProbe();
        }
        await refreshBlenderAddonProbe(true).catch(() => blenderAddonProbe);
        return sendJson(
          response,
          200,
          statusPayload(),
          origin,
        );
      }

      if (
        request.method === "POST" &&
        requestUrl.pathname === "/mcp/reconnect"
      ) {
        await readJsonBody(request).catch(() => ({}));
        void mcp
          .reconnect()
          .then(refreshStudioProbe)
          .catch((error) => {
            log(error.message, "warning");
          });
        return sendJson(
          response,
          202,
          {
            ok: true,
            state: "connecting",
          },
          origin,
        );
      }

      return sendJson(
        response,
        404,
        {
          ok: false,
          error: "Unknown ViewCoder bridge endpoint.",
        },
        origin,
      );
    } catch (error) {
      return sendJson(
        response,
        error?.statusCode || 500,
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
        origin,
      );
    }
  });

  server.on("error", async (error) => {
    if (error.code === "EADDRINUSE") {
      try {
        const existing = await fetch(`http://${HOST}:${PORT}/status`, {
          signal: AbortSignal.timeout(1_500),
        });
        const status = await existing.json();
        if (existing.ok && status?.name === "ViewCoder Bridge") {
          if (status.version !== VERSION) {
            log(
              `A different ViewCoder bridge version (${status.version ?? "unknown"}) is already using port ${PORT}. Close its original window, then run this start.bat again.`,
              "error",
            );
            process.exitCode = 1;
            setTimeout(() => process.exit(1), 1_500);
            return;
          }
          log(
            `CONNECTED — ViewCoder v${status.version ?? VERSION} is already running. Keep its original window open.`,
            "ready",
          );
          process.exitCode = 0;
          setTimeout(() => process.exit(0), 1_500);
          return;
        }
      } catch {
        // A different local program owns the port.
      }
      log(
        `Port ${PORT} is being used by another program. Close that program or set VIEWCODER_PORT to a free port.`,
        "error",
      );
    } else {
      log(error.message, "error");
    }
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 200);
  });

  server.listen(PORT, HOST, () => {
    printBanner();
    if (!SKIP_MCP) {
      void cleanupOrphanStudioMcp()
        .then(() => mcp.connect())
        .then(refreshStudioProbe)
        .catch((error) => {
          mcp.lastError = error.message;
          mcp.state = "offline";
          log(error.message, "warning");
          printStudioHelp();
        });
      for (const client of Object.values(addonClients)) {
        if (!client.enabled()) continue;
        void client.connect().catch(() => {
          if (client.id === "blender") printBlenderHelp();
        });
      }
    }
  });

  const connectionTimer = setInterval(() => {
    if (SKIP_MCP || shutdownStarted) return;
    if (!mcp.child || mcp.child.exitCode != null) {
      void mcp.connect().catch(() => false);
      return;
    }
    if (!mcp.tools.length) {
      void mcp
        .refreshTools(5_000)
        .then(() => refreshStudioProbe())
        .catch(() => {});
    }
  }, 5_000);

  const addonConnectionTimer = setInterval(() => {
    if (SKIP_MCP || shutdownStarted) return;
    for (const client of Object.values(addonClients)) {
      if (!client.enabled()) continue;
      if (!client.child || client.child.exitCode != null) {
        if (Date.now() >= client.nextReconnectAt) {
          void client.connect().catch(() => false);
        }
        continue;
      }
      if (!client.tools.length) {
        void client.refreshTools(5_000).catch(() => {});
        continue;
      }
      if (
        ADDON_RUNTIME_PROBES[client.id] &&
        !client.ready() &&
        Date.now() >= client.nextRuntimeProbeAt
      ) {
        void client.verifyRuntime(5_000).catch(() => {});
      }
    }
  }, 5_000);

  const probeTimer = setInterval(() => {
    if (
      !SKIP_MCP &&
      mcp.state === "ready" &&
      !processingQueue
    ) {
      void refreshStudioProbe();
    }
  }, 3_000);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  async function processJobs() {
    if (processingQueue) return;
    processingQueue = true;
    try {
      while (jobs.length) {
        const job = jobs.shift();
        const started = Date.now();
        let event;
        semanticRequests.set(job.semanticKey, {
          jobId: job.jobId,
          state: "running",
          updatedAt: Date.now(),
        });
        try {
          enforceSafety(job);
          const result = await callJobTool(job);
          const successMetadata = classifySuccessfulToolResult(
            job,
            result,
          );
          event = {
            type: "job_result",
            eventId: nextEventId++,
            jobId: job.jobId,
            sessionId: job.sessionId,
            requestId: job.requestId,
            tool: job.tool,
            realTool: job.realTool,
            server: job.server,
            ok: true,
            text: result.text,
            images: result.images,
            ...successMetadata,
            durationMs: Date.now() - started,
            completedAt: new Date().toISOString(),
          };
          log(
            event.code === "GENERATION_QUEUED"
              ? `Started ${job.tool} (job ${job.jobId}, generation ${event.generationId || "pending"}). Studio will insert it when generation finishes.`
              : `Completed ${job.tool} (job ${job.jobId}, ${event.durationMs} ms).`,
            event.code === "GENERATION_QUEUED"
              ? "view"
              : "success",
          );
          semanticRequests.set(job.semanticKey, {
            jobId: job.jobId,
            state: "succeeded",
            updatedAt: Date.now(),
          });
        } catch (error) {
          const failure = classifyToolFailure(job, error);
          event = {
            type: "job_result",
            eventId: nextEventId++,
            jobId: job.jobId,
            sessionId: job.sessionId,
            requestId: job.requestId,
            tool: job.tool,
            realTool: job.realTool,
            server: job.server,
            ok: false,
            error: failure.message,
            code: failure.code,
            retryable: failure.retryable,
            details: failure.details,
            durationMs: Date.now() - started,
            completedAt: new Date().toISOString(),
          };
          log(
            `Failed ${job.tool} (job ${job.jobId}): ${event.error}`,
            "error",
          );
          semanticRequests.delete(job.semanticKey);
        }
        completedJobs.set(event.jobId, event);
        trimMap(completedJobs, MAX_SEEN_REQUESTS);
        events.push(event);
        if (events.length > MAX_EVENTS) {
          events.splice(0, events.length - MAX_EVENTS);
        }
      }
    } finally {
      processingQueue = false;
    }
  }

  function parseBlenderAddonStatus(text) {
    const raw = String(text || "").trim();
    if (/^(?:error checking addon status|could not determine addon status)/i.test(raw)) {
      throw new Error(raw);
    }
    const candidates = [raw];
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(raw.slice(firstBrace, lastBrace + 1));
    }
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // Try the next safe JSON boundary.
      }
    }
    throw new Error("Blender MCP returned an unreadable add-on handshake.");
  }

  function disconnectedBlenderAddonProbe(error = null, details = {}) {
    return {
      connected: false,
      protocolVersion: details.protocolVersion ?? null,
      expectedProtocolVersion:
        details.expectedProtocolVersion ?? BLENDER_ADDON_PROTOCOL_VERSION,
      addonVersion: details.addonVersion ?? null,
      blenderVersion: details.blenderVersion ?? null,
      capabilities: Array.isArray(details.capabilities)
        ? details.capabilities
        : [],
      source: details.source ?? null,
      checkedAt: new Date().toISOString(),
      error: error ? String(error) : null,
    };
  }

  async function refreshBlenderAddonProbe(force = false) {
    if (!blenderMcp.enabled() || SKIP_MCP) {
      blenderAddonProbe = disconnectedBlenderAddonProbe(null, {
        source: blenderMcp.enabled() ? "disabled-by-runtime" : "disabled",
      });
      return blenderAddonProbe;
    }
    const checkedAt = Date.parse(blenderAddonProbe.checkedAt || "");
    if (
      !force &&
      Number.isFinite(checkedAt) &&
      Date.now() - checkedAt < BLENDER_ADDON_PROBE_TTL_MS
    ) {
      return blenderAddonProbe;
    }
    if (blenderAddonProbePromise) return blenderAddonProbePromise;

    blenderAddonProbePromise = (async () => {
      try {
        if (!blenderMcp.child || blenderMcp.child.exitCode != null) {
          await blenderMcp.connect().catch(() => false);
        }
        if (!blenderMcp.tools.length && blenderMcp.child) {
          await blenderMcp.refreshTools().catch(() => []);
        }
        if (
          !blenderMcp.tools.some((tool) => tool?.name === "get_addon_status")
        ) {
          throw new Error(
            "Blender MCP is running, but its add-on handshake tool is missing. Install the bundled Blender MCP add-on and restart Blender.",
          );
        }
        const result = await blenderMcp.callTool(
          "get_addon_status",
          {},
          BLENDER_ADDON_PROBE_TIMEOUT_MS,
        );
        const status = parseBlenderAddonStatus(result?.text);
        const protocolVersion = Number(status.protocol_version);
        const expectedProtocolVersion = Number(
          status.expected_protocol_version || BLENDER_ADDON_PROTOCOL_VERSION,
        );
        const source = String(status.source || "handshake");
        const connected = Boolean(
          Number.isFinite(protocolVersion) &&
          protocolVersion > 0 &&
          protocolVersion === expectedProtocolVersion &&
          expectedProtocolVersion === BLENDER_ADDON_PROTOCOL_VERSION &&
          source.toLowerCase() !== "error" &&
          status.up_to_date !== false,
        );
        const details = {
          protocolVersion: Number.isFinite(protocolVersion)
            ? protocolVersion
            : null,
          expectedProtocolVersion: Number.isFinite(expectedProtocolVersion)
            ? expectedProtocolVersion
            : BLENDER_ADDON_PROTOCOL_VERSION,
          addonVersion: status.addon_version ?? null,
          blenderVersion: status.blender_version ?? null,
          capabilities: status.capabilities,
          source,
        };
        if (!connected) {
          const warning =
            status.warning ||
            status.error ||
            (protocolVersion
              ? `Blender MCP protocol ${protocolVersion} does not match ViewCoder protocol ${BLENDER_ADDON_PROTOCOL_VERSION}.`
              : "Open Blender, enable Blender MCP, then click Connect to MCP Server on port 9876.");
          blenderAddonProbe = disconnectedBlenderAddonProbe(warning, details);
          blenderMcp.runtimeVerified = false;
          if (blenderMcp.child && blenderMcp.child.exitCode == null) {
            blenderMcp.state = "waiting";
          }
          blenderMcp.lastError = blenderAddonProbe.error;
          return blenderAddonProbe;
        }
        blenderAddonProbe = {
          connected: true,
          ...details,
          checkedAt: new Date().toISOString(),
          error: null,
        };
        blenderMcp.runtimeVerified = true;
        blenderMcp.state = "ready";
        blenderMcp.lastError = null;
        return blenderAddonProbe;
      } catch (error) {
        const message = friendlyAddonError(
          "blender",
          error instanceof Error ? error.message : String(error),
        );
        blenderAddonProbe = disconnectedBlenderAddonProbe(message, {
          source: "error",
        });
        blenderMcp.runtimeVerified = false;
        if (blenderMcp.child && blenderMcp.child.exitCode == null) {
          blenderMcp.state = "waiting";
        }
        blenderMcp.lastError = message;
        return blenderAddonProbe;
      }
    })().finally(() => {
      blenderAddonProbePromise = null;
    });
    return blenderAddonProbePromise;
  }

  function advertisedNativeTools() {
    const studioTools = mcp.tools.filter((tool) => !isDisabledTool(tool?.name, "roblox")).map((tool) => ({
      ...tool,
      server: "roblox",
      serverLabel: "Roblox Studio",
      realName: tool.name,
    }));
    const blenderTools =
      blenderAddonProbe.connected
        ? blenderMcp.tools.filter((tool) => !isDisabledTool(tool?.name, "blender")).map((tool) => ({
            ...tool,
            name: `${BLENDER_TOOL_PREFIX}${tool.name}`,
            server: "blender",
            serverLabel: "Blender",
            realName: tool.name,
            description:
              `[Blender] ${String(tool.description || "").trim()}`.trim(),
          }))
        : [];
    const handoff =
      mcp.state === "ready" &&
      mcp.tools.some((tool) => tool.name === "execute_luau") &&
      blenderAddonProbe.connected &&
      blenderMcp.tools.some(
        (tool) => tool.name === "execute_blender_code",
      )
        ? [BLENDER_IMPORT_DEFINITION]
        : [];
    return [...studioTools, ...blenderTools, ...handoff];
  }

  function advertisedTools() {
    return [
      ...advertisedNativeTools(),
      ...VIEWCODER_TOOL_DEFINITIONS.map((tool) => ({
        ...tool,
        realName: tool.name,
      })),
    ];
  }

  // ViewCoder intentionally keeps capture and Play Test tools out of the
  // command surface. Screenshots can expose private pixels and simulated
  // keyboard/mouse input only targets a running play session. Everything else
  // that Studio MCP advertises remains available for persistent Edit-mode work.
  const DISABLED_TOOL_NAMES = new Set([
    "start_stop_play",
    "start_play",
    "stop_play",
    "play_test",
    "get_console_output",
    "console_output",
    "get_studio_output",
    "character_navigation",
    "navigate_character",
    "user_keyboard_input",
    "keyboard_input",
    "user_mouse_input",
    "mouse_input",
    "screen_capture",
  ]);

  function normalizedToolLeaf(name) {
    const normalized = String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9_/]/g, "");
    return normalized.split("/").pop() || normalized;
  }

  function isScreenshotTool(name) {
    const leaf = normalizedToolLeaf(name);
    return (
      leaf === "screen_capture" ||
      leaf.includes("screenshot") ||
      leaf.includes("viewport_capture") ||
      leaf.includes("screen_capture")
    );
  }

  function isDisabledTool(name, server = "roblox") {
    const leaf = normalizedToolLeaf(name);
    // Blender is catalog-driven: expose every live add-on command except image
    // capture. Studio retains its separate Edit-mode safety restrictions.
    if (server === "blender") return isScreenshotTool(leaf);
    return (
      DISABLED_TOOL_NAMES.has(leaf) ||
      leaf.includes("start_stop_play") ||
      leaf.includes("play_test") ||
      isScreenshotTool(leaf)
    );
  }

  function resolveToolRoute(tool) {
    if (
      VIEWCODER_TOOL_DEFINITIONS.some(
        (definition) => definition.name === tool,
      )
    ) {
      return {
        advertisedTool: tool,
        realTool: tool,
        server: "viewcoder",
      };
    }
    if (tool === BLENDER_IMPORT_TOOL) {
      return {
        advertisedTool: tool,
        realTool: tool,
        server: "viewcoder",
      };
    }
    if (tool.startsWith(BLENDER_TOOL_PREFIX)) {
      const realTool = tool.slice(BLENDER_TOOL_PREFIX.length).trim();
      if (!realTool) {
        throw httpError(400, "A Blender MCP tool name is required.");
      }
      return {
        advertisedTool: tool,
        realTool,
        server: "blender",
      };
    }
    return {
      advertisedTool: tool,
      realTool: tool,
      server: "roblox",
    };
  }

  function definitionForRoute(route) {
    if (route.server === "viewcoder") {
      if (route.realTool === BLENDER_IMPORT_TOOL) {
        return BLENDER_IMPORT_DEFINITION;
      }
      return (
        VIEWCODER_TOOL_DEFINITIONS.find(
          (definition) => definition.name === route.realTool,
        ) || null
      );
    }
    const client = route.server === "blender" ? blenderMcp : mcp;
    return client.tools.find(
      (candidate) => candidate?.name === route.realTool,
    );
  }

  function requiresStudioId(route, definition) {
    if (route.server !== "roblox" || !definition) return false;
    const schema =
      definition.inputSchema ??
      definition.input_schema ??
      {};
    return (
      Array.isArray(schema.required) &&
      schema.required.includes("studio_id")
    );
  }

  function applyConnectedStudioId(route, argumentsObject, definition) {
    if (!requiresStudioId(route, definition)) return argumentsObject;
    if (String(argumentsObject.studio_id || "").trim()) {
      return argumentsObject;
    }
    const connectedStudioId = String(studioProbe.id || "").trim();
    if (connectedStudioId) argumentsObject.studio_id = connectedStudioId;
    return argumentsObject;
  }

  async function ensureConnectedStudioId(
    route,
    argumentsObject,
    definition,
  ) {
    applyConnectedStudioId(route, argumentsObject, definition);
    if (
      requiresStudioId(route, definition) &&
      !String(argumentsObject.studio_id || "").trim()
    ) {
      await refreshStudioProbe().catch(() => studioProbe);
      applyConnectedStudioId(route, argumentsObject, definition);
    }
    return argumentsObject;
  }

  async function callAdvertisedNativeTool(
    tool,
    rawArguments,
    metadata = {},
  ) {
    const route = resolveToolRoute(String(tool || "").trim());
    if (
      route.server === "viewcoder" &&
      route.realTool !== BLENDER_IMPORT_TOOL
    ) {
      throw bridgeError(
        "NESTED_ORCHESTRATION_NOT_ALLOWED",
        "A ViewCoder workflow may call native MCP commands, not another ViewCoder workflow.",
      );
    }
    if (isDisabledTool(route.realTool, route.server)) {
      throw bridgeError(
        "COMMAND_DISABLED",
        "This capture, input, or Play Test command is not available through ViewCoder.",
      );
    }
    const definition = definitionForRoute(route);
    if (!definition) {
      throw bridgeError(
        "UNKNOWN_TOOL",
        `The live MCP command "${tool}" is not available.`,
      );
    }
    const argumentsObject =
      rawArguments &&
      typeof rawArguments === "object" &&
      !Array.isArray(rawArguments)
        ? structuredClone(rawArguments)
        : {};
    await ensureConnectedStudioId(route, argumentsObject, definition);
    const schema =
      definition.inputSchema ??
      definition.input_schema ??
      {};
    const issue = validateSchemaValue(
      argumentsObject,
      schema,
      "arguments",
      true,
    );
    if (issue) {
      throw bridgeError("INVALID_ARGUMENTS", issue);
    }
    const job = {
      jobId: 0,
      requestId: `workflow-${crypto.randomUUID()}`,
      sessionId: String(metadata.workflowId || "workflow"),
      kind: "tool",
      tool: route.advertisedTool,
      realTool: route.realTool,
      server: route.server,
      arguments: argumentsObject,
      source: {
        provider: "viewcoder-workflow",
        ...metadata,
      },
      queuedAt: new Date().toISOString(),
    };
    enforceSafety(job);
    return callNativeJobTool(job);
  }

  async function callJobTool(job) {
    if (
      job.server === "viewcoder" &&
      VIEWCODER_TOOL_DEFINITIONS.some(
        (definition) => definition.name === job.realTool,
      )
    ) {
      return workflowEngine.execute(job.realTool, job.arguments);
    }
    return callNativeJobTool(job);
  }

  async function callNativeJobTool(job) {
    if (
      job.server === "viewcoder" &&
      job.realTool === BLENDER_IMPORT_TOOL
    ) {
      return importBlenderSceneIntoStudio(job.arguments);
    }
    if (job.server === "blender") {
      await refreshBlenderAddonProbe().catch(() => blenderAddonProbe);
      if (!blenderAddonProbe.connected) {
        throw bridgeError(
          "ADDON_CONNECTION",
          blenderAddonProbe.error ||
            "Blender's MCP add-on has not completed its live handshake.",
        );
      }
      return blenderMcp.callTool(
        job.realTool,
        job.arguments,
        BLENDER_TOOL_TIMEOUT_MS,
      );
    }
    if (job.realTool === "user_keyboard_input") {
      return runGuardedKeyboardInput(job.arguments);
    }
    if (job.server === "roblox") {
      const route = {
        server: job.server,
        realTool: job.realTool,
      };
      await ensureConnectedStudioId(
        route,
        job.arguments,
        definitionForRoute(route),
      );
    }
    const playDatamodel =
      job.realTool === "execute_luau"
        ? String(job.arguments.datamodel_type || "Edit")
        : "Edit";
    try {
      return await mcp.callTool(
        job.realTool,
        job.arguments,
        playDatamodel === "Client" || playDatamodel === "Server"
          ? 35_000
          : TOOL_TIMEOUT_MS,
      );
    } catch (error) {
      if (isMissingViewCoderMemoryRead(job, error)) {
        const recoveredMemory = await discoverAndReadViewCoderMemory(
          job,
        ).catch(() => null);
        if (recoveredMemory) {
          return recoveredMemory;
        }
        return {
          text:
            "VIEWCODER_MEMORY_MISSING: This place has no ViewCoder project " +
            "memory yet. That is an expected first-run state. Do not retry " +
            "script_read and do not pause the user's request. Continue the " +
            "requested Studio work, then create a short memory later with " +
            "execute_luau in Edit mode after a real change succeeds.",
          images: [],
        };
      }
      throw error;
    }
  }

  async function runGuardedKeyboardInput(rawArguments) {
    const args = rawArguments && typeof rawArguments === "object"
      ? rawArguments
      : {};
    const actions = Array.isArray(args.actions)
      ? args.actions.filter(
          (action) => action && typeof action === "object",
        )
      : [];
    if (!actions.length) {
      return mcp.callTool(
        "user_keyboard_input",
        { ...args, datamodel_type: "Client" },
        35_000,
      );
    }

    await mcp.callTool(
      "execute_luau",
      {
        datamodel_type: "Client",
        code: `
local Players = game:GetService("Players")
local UIS = game:GetService("UserInputService")
local player = Players.LocalPlayer
local gui = player and player:FindFirstChildOfClass("PlayerGui")
if not gui then return "guard-unavailable" end
local guard = gui:FindFirstChild("ViewCoderInputGuard")
if not guard then
  guard = Instance.new("Folder")
  guard.Name = "ViewCoderInputGuard"
  guard.Parent = gui
end
if not guard:GetAttribute("Installed") then
  guard:SetAttribute("Installed", true)
  UIS.InputBegan:Connect(function(input)
    if not guard.Parent or not guard:GetAttribute("Enabled") then return end
    local expected = guard:GetAttribute("ExpectedKey") or ""
    local observed
    if input.UserInputType == Enum.UserInputType.Keyboard then
      observed = input.KeyCode.Name
      if expected == "*" or observed == expected then return end
    else
      observed = input.UserInputType.Name
    end
    guard:SetAttribute("UnexpectedCount", (guard:GetAttribute("UnexpectedCount") or 0) + 1)
    guard:SetAttribute("LastUnexpected", observed)
  end)
end
guard:SetAttribute("UnexpectedCount", 0)
guard:SetAttribute("LastUnexpected", "")
guard:SetAttribute("ExpectedKey", "")
guard:SetAttribute("Enabled", true)
return "guard-ready"
`,
      },
      20_000,
    );

    const heldKeys = new Set();
    const cancelBaseline = keyboardCancelGeneration;
    let completed = 0;
    let interruption = "";
    try {
      for (const action of actions) {
        if (keyboardCancelGeneration !== cancelBaseline) {
          interruption = "ViewCoder Stop";
          break;
        }
        const focusState = await waitForRobloxStudioForeground(
          STUDIO_INPUT_FOCUS_TIMEOUT_MS,
          cancelBaseline,
        );
        if (focusState === "cancelled") {
          interruption = "ViewCoder Stop";
          break;
        }
        if (focusState === "timeout") {
          interruption = "focus-timeout";
          break;
        }
        const kind = String(action.action || "");
        const key = String(action.key_code || "");
        const expected =
          kind === "textInput"
            ? "*"
            : /^(?:keyDown|keyPress)$/i.test(kind)
              ? key
              : "";
        await mcp.callTool(
          "execute_luau",
          {
            datamodel_type: "Client",
            code: `
local p = game:GetService("Players").LocalPlayer
local g = p and p:FindFirstChildOfClass("PlayerGui")
local v = g and g:FindFirstChild("ViewCoderInputGuard")
if v then v:SetAttribute("ExpectedKey", ${JSON.stringify(expected)}) end
return "armed"
`,
          },
          20_000,
        );
        await mcp.callTool(
          "user_keyboard_input",
          {
            ...args,
            datamodel_type: "Client",
            actions: [action],
          },
          35_000,
        );
        if (kind === "keyDown" && key) heldKeys.add(key);
        if ((kind === "keyUp" || kind === "keyPress") && key)
          heldKeys.delete(key);
        completed++;
        if (keyboardCancelGeneration !== cancelBaseline) {
          interruption = "ViewCoder Stop";
          break;
        }
        const observed = await mcp.callTool(
          "execute_luau",
          {
            datamodel_type: "Client",
            code: `
local p = game:GetService("Players").LocalPlayer
local g = p and p:FindFirstChildOfClass("PlayerGui")
local v = g and g:FindFirstChild("ViewCoderInputGuard")
if not v then return "0|" end
return tostring(v:GetAttribute("UnexpectedCount") or 0) .. "|" .. tostring(v:GetAttribute("LastUnexpected") or "")
`,
          },
          20_000,
        );
        const match = String(observed?.text || "").match(
          /(\d+)\|([A-Za-z0-9_]*)/,
        );
        if (match && Number(match[1]) > 0) {
          interruption = match[2] || "user input";
          break;
        }
      }
    } finally {
      if (heldKeys.size) {
        await mcp.callTool(
          "user_keyboard_input",
          {
            datamodel_type: "Client",
            actions: [...heldKeys].map((key_code) => ({
              action: "keyUp",
              key_code,
            })),
          },
          20_000,
        ).catch(() => {});
      }
      await mcp.callTool(
        "execute_luau",
        {
          datamodel_type: "Client",
          code: `
local p = game:GetService("Players").LocalPlayer
local g = p and p:FindFirstChildOfClass("PlayerGui")
local v = g and g:FindFirstChild("ViewCoderInputGuard")
if v then
  v:SetAttribute("Enabled", false)
  v:SetAttribute("ExpectedKey", "")
end
return "guard-stopped"
`,
        },
        20_000,
      ).catch(() => {});
    }
    if (interruption === "focus-timeout") {
      return {
        text:
          `Keyboard sequence moved on after waiting 30 seconds for Roblox Studio focus. ${completed} of ${actions.length} actions were completed; the remaining actions were skipped and completed actions were not replayed.`,
        images: [],
      };
    }
    if (interruption) {
      return {
        text:
          `ERROR: Automated keyboard input paused after ${completed} of ${actions.length} actions because user interaction was detected (${interruption}). ` +
          "All ViewCoder-held keys were released. Do not undo completed input or repeat the sequence blindly; inspect the current playtest state and wait for the user's next instruction.",
        images: [],
      };
    }
    return {
      text: `Keyboard sequence completed safely (${completed} action${completed === 1 ? "" : "s"}).`,
      images: [],
    };
  }

  async function waitForRobloxStudioForeground(
    timeoutMs,
    cancelBaseline,
  ) {
    if (process.platform !== "win32") return "focused";
    const timeout = Math.max(0, Number(timeoutMs) || 0);
    const script = [
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class VCForeground { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId); }';",
      `$deadline = [DateTime]::UtcNow.AddMilliseconds(${timeout});`,
      "do {",
      "  $handle = [VCForeground]::GetForegroundWindow();",
      "  [uint32]$processId = 0;",
      "  [void][VCForeground]::GetWindowThreadProcessId($handle, [ref]$processId);",
      "  $name = try { (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { '' };",
      "  if ($name -match '^RobloxStudio(?:Beta)?$') { Write-Output 'focused'; exit 0 };",
      "  Start-Sleep -Milliseconds 200;",
      "} while ([DateTime]::UtcNow -lt $deadline);",
      "Write-Output 'timeout'; exit 2;",
    ].join(" ");
    return new Promise((resolve) => {
      const child = childProcess.spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      );
      let output = "";
      let settled = false;
      const finish = (state) => {
        if (settled) return;
        settled = true;
        clearInterval(cancelPoll);
        resolve(state);
      };
      const cancelPoll = setInterval(() => {
        if (keyboardCancelGeneration === cancelBaseline) return;
        try {
          child.kill();
        } catch {
          // The focus probe may already have exited.
        }
        finish("cancelled");
      }, 100);
      child.stdout.on("data", (chunk) => {
        if (output.length < 1_000) output += String(chunk);
      });
      child.on("error", () => finish("focused"));
      child.on("exit", () => {
        finish(/\bfocused\b/i.test(output) ? "focused" : "timeout");
      });
    });
  }

  async function discoverAndReadViewCoderMemory(job) {
    const discovered = [];
    const connectedStudioId = String(
      job.arguments?.studio_id || studioProbe.id || "",
    ).trim();
    const studioTarget = connectedStudioId
      ? { studio_id: connectedStudioId }
      : {};
    if (mcp.tools.some((tool) => tool?.name === "execute_luau")) {
      try {
        const result = await mcp.callTool(
          "execute_luau",
          {
            datamodel_type: "Edit",
            ...studioTarget,
            code: `
local HttpService = game:GetService("HttpService")
local matches = {}
for _, item in ipairs(game:GetDescendants()) do
  if item:IsA("LuaSourceContainer") and string.lower(item.Name) == "memory" then
    local parent = item.Parent
    local belongsToViewCoder = false
    while parent and parent ~= game do
      if string.lower(parent.Name) == "viewcoder" then
        belongsToViewCoder = true
        break
      end
      parent = parent.Parent
    end
    if belongsToViewCoder then
      table.insert(matches, item:GetFullName())
    end
  end
end
table.sort(matches, function(a, b)
  local canonical = "ServerStorage.ViewCoder.Memory"
  if a == canonical then return true end
  if b == canonical then return false end
  return a < b
end)
return "VIEWCODER_MEMORY_PATHS:" .. HttpService:JSONEncode(matches)
`,
          },
          20_000,
        );
        const text = String(result?.text || "");
        const marker = "VIEWCODER_MEMORY_PATHS:";
        const markerAt = text.indexOf(marker);
        if (markerAt >= 0) {
          const jsonStart = text.indexOf("[", markerAt + marker.length);
          const jsonEnd = text.indexOf("]", jsonStart + 1);
          if (jsonStart >= 0 && jsonEnd > jsonStart) {
            const paths = JSON.parse(
              text.slice(jsonStart, jsonEnd + 1),
            );
            if (Array.isArray(paths)) discovered.push(...paths);
          }
        }
      } catch (error) {
        log(
          `Direct ViewCoder memory discovery was unavailable: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    }

    if (
      !discovered.length &&
      mcp.tools.some((tool) => tool?.name === "search_game_tree")
    ) {
      try {
        const tree = await mcp.callTool(
          "search_game_tree",
          {
            ...studioTarget,
            keywords: "Memory",
            max_depth: 12,
            head_limit: 200,
          },
          20_000,
        );
        const raw = String(tree?.text || "").trim();
        const open = raw.indexOf("[");
        const close = raw.lastIndexOf("]");
        if (open >= 0 && close > open) {
          const entries = JSON.parse(raw.slice(open, close + 1));
          for (const entry of Array.isArray(entries) ? entries : []) {
            const className = String(
              entry?.className ?? entry?.class_name ?? entry?.class ?? "",
            );
            const name = String(entry?.name || "");
            const fullPath = String(
              entry?.fullPath ?? entry?.full_path ?? entry?.path ?? "",
            );
            if (
              /^(?:ModuleScript|Script|LocalScript)$/i.test(className) &&
              name.toLowerCase() === "memory" &&
              /(?:^|\.)ViewCoder(?:\.|$)/i.test(fullPath)
            ) {
              discovered.push(fullPath);
            }
          }
        }
      } catch {
        // The direct Studio scan above is authoritative; this is only a
        // compatibility fallback for Studio builds without execute_luau.
      }
    }

    const candidates = [...new Set(
      discovered.map((value) => String(value || "").trim()).filter(Boolean),
    )];
    for (const discoveredPath of candidates) {
      const paths = discoveredPath.startsWith("game.")
        ? [discoveredPath]
        : [discoveredPath, `game.${discoveredPath}`];
      for (const candidatePath of paths) {
        const nextArguments = replaceArgumentString(
          job.arguments,
          "game.ServerStorage.ViewCoder.Memory",
          candidatePath,
        );
        try {
          const result = await mcp.callTool(
            "script_read",
            nextArguments,
            TOOL_TIMEOUT_MS,
          );
          log(
            `Recovered ViewCoder memory at ${candidatePath}.`,
            "success",
          );
          return result;
        } catch {
          // Try the alternate path spelling or another discovered candidate.
        }
      }
    }

    // Some Studio builds can enumerate a source container through Luau but
    // reject its dot-path in script_read. Return the source through the same
    // tool result rather than incorrectly claiming that memory is absent.
    if (
      candidates.length &&
      mcp.tools.some((tool) => tool?.name === "execute_luau")
    ) {
      try {
        const directRead = await mcp.callTool(
          "execute_luau",
          {
            datamodel_type: "Edit",
            ...studioTarget,
            code: `
local wanted = ${JSON.stringify(candidates[0].replace(/^game\./i, ""))}
for _, item in ipairs(game:GetDescendants()) do
  if item:IsA("LuaSourceContainer") and item:GetFullName() == wanted then
    return item.Source
  end
end
error("The discovered ViewCoder memory moved before it could be read.")
`,
          },
          TOOL_TIMEOUT_MS,
        );
        log(
          `Recovered ViewCoder memory source at ${candidates[0]}.`,
          "success",
        );
        return directRead;
      } catch {
        // The instance may have been removed between discovery and reading.
      }
    }
    return null;
  }

  function replaceArgumentString(value, expected, replacement) {
    if (typeof value === "string") {
      return value === expected
        ? replacement
        : value.replace(expected, replacement);
    }
    if (Array.isArray(value)) {
      return value.map((item) =>
        replaceArgumentString(item, expected, replacement),
      );
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          replaceArgumentString(item, expected, replacement),
        ]),
      );
    }
    return value;
  }

  function isMissingViewCoderMemoryRead(job, error) {
    if (job?.realTool !== "script_read") return false;
    let serializedArguments = "";
    try {
      serializedArguments = JSON.stringify(job.arguments ?? {});
    } catch {
      return false;
    }
    if (
      !serializedArguments.includes(
        "game.ServerStorage.ViewCoder.Memory",
      )
    ) {
      return false;
    }
    const message =
      error instanceof Error ? error.message : String(error);
    return /\b(?:script|instance|path)\b.{0,100}\b(?:not found|does not exist|missing)\b|\b(?:not found|does not exist|missing)\b.{0,100}\b(?:script|instance|path)\b/i.test(
      message,
    );
  }

  async function importBlenderSceneIntoStudio(rawArguments) {
    if (!blenderMcp.ready()) {
      throw bridgeError(
        "ADDON_CONNECTION",
        "Blender is not connected. Open Blender, start its Blender MCP add-on on port 9876, then reconnect Blender from ViewCoder.",
      );
    }
    if (
      mcp.state !== "ready" ||
      !mcp.tools.some((tool) => tool.name === "execute_luau")
    ) {
      throw bridgeError(
        "STUDIO_CONNECTION",
        "Roblox Studio is not ready for the Blender import.",
      );
    }

    const options = normalizeBlenderImportOptions(rawArguments);
    const extraction = await blenderMcp.callTool(
      "execute_blender_code",
      {
        code: buildBlenderExtractionCode(options.maxTriangles),
      },
      TOOL_TIMEOUT_MS,
    );
    const rawPayload = parseBlenderMeshPayload(extraction.text);
    const payload = validateBlenderMeshPayload(
      rawPayload,
      options.maxTriangles,
    );
    const luau = buildRobloxEditableMeshImport(payload, options);
    const result = await mcp.callTool(
      "execute_luau",
      {
        code: luau,
        datamodel_type: "Edit",
      },
      TOOL_TIMEOUT_MS,
    );
    return {
      ...result,
      text:
        result.text ||
        JSON.stringify({
          imported: true,
          targetName: options.targetName,
          objects: payload.objects.length,
          triangles: payload.triangleCount,
        }),
    };
  }

  function normalizeBlenderImportOptions(value) {
    const argumentsObject =
      value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    const requestedLimit = Number(argumentsObject.max_triangles);
    const maxTriangles = Number.isInteger(requestedLimit)
      ? Math.min(
          MAX_BLENDER_TRIANGLES,
          Math.max(100, requestedLimit),
        )
      : 6_000;
    const rawName = String(
      argumentsObject.target_name || "BlenderImport",
    );
    const targetName =
      rawName
        .replace(/[^\w .()\-]/g, "")
        .trim()
        .slice(0, 80) || "BlenderImport";
    let position = null;
    if (argumentsObject.position != null) {
      const candidate = argumentsObject.position;
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        !["x", "y", "z"].every(
          (axis) =>
            typeof candidate[axis] === "number" &&
            Number.isFinite(candidate[axis]),
        )
      ) {
        throw bridgeError(
          "INVALID_ARGUMENTS",
          `${BLENDER_IMPORT_TOOL}: position requires finite numeric x, y, and z values.`,
        );
      }
      position = {
        x: candidate.x,
        y: candidate.y,
        z: candidate.z,
      };
    }
    return {
      targetName,
      maxTriangles,
      position,
      replaceExisting: argumentsObject.replace_existing === true,
    };
  }

  function buildBlenderExtractionCode(maxTriangles) {
    const sentinel = JSON.stringify(BLENDER_IMPORT_SENTINEL);
    return `import json
depsgraph = bpy.context.evaluated_depsgraph_get()
payload = {"version": 1, "objects": [], "triangleCount": 0}
limit = ${maxTriangles}
for source in bpy.context.scene.objects:
    if source.type != "MESH" or source.hide_get() or source.hide_render:
        continue
    evaluated = source.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        transform = evaluated.matrix_world
        reverse_winding = transform.to_3x3().determinant() < 0
        vertices = []
        for vertex in mesh.vertices:
            world = transform @ vertex.co
            vertices.append([round(float(world.x), 6), round(float(world.z), 6), round(float(-world.y), 6)])
        triangles = []
        mesh.calc_loop_triangles()
        for triangle in mesh.loop_triangles:
            indices = [int(index) for index in triangle.vertices]
            if reverse_winding:
                indices[1], indices[2] = indices[2], indices[1]
            triangles.append(indices)
        if not triangles:
            continue
        payload["triangleCount"] += len(triangles)
        material = source.active_material
        color = [0.65, 0.68, 0.72]
        if material is not None:
            diffuse = material.diffuse_color
            color = [round(float(diffuse[0]), 5), round(float(diffuse[1]), 5), round(float(diffuse[2]), 5)]
        payload["objects"].append({
            "name": str(source.name),
            "vertices": vertices,
            "triangles": triangles,
            "color": color
        })
    finally:
        evaluated.to_mesh_clear()
if payload["triangleCount"] > limit:
    payload = {
        "error": "The visible Blender scene has %s triangles, above the ViewCoder import limit of %s. Simplify or decimate the meshes, then retry the same import." % (payload["triangleCount"], limit),
        "triangleCount": payload["triangleCount"],
        "limit": limit
    }
elif not payload["objects"]:
    payload = {"error": "Blender has no visible mesh objects to import."}
print(${sentinel} + json.dumps(payload, separators=(",", ":")))`;
  }

  function parseBlenderMeshPayload(text) {
    const value = String(text || "");
    const markerIndex = value.lastIndexOf(BLENDER_IMPORT_SENTINEL);
    if (markerIndex < 0) {
      throw bridgeError(
        "BLENDER_IMPORT_FAILED",
        "Blender did not return transferable mesh data. Keep Blender open and retry the import.",
        value.slice(-500),
      );
    }
    const jsonText = value
      .slice(markerIndex + BLENDER_IMPORT_SENTINEL.length)
      .trim()
      .split(/\r?\n/)[0];
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw bridgeError(
        "BLENDER_IMPORT_FAILED",
        "Blender returned malformed mesh data.",
        jsonText.slice(0, 500),
      );
    }
    if (parsed?.error) {
      throw bridgeError(
        "BLENDER_IMPORT_FAILED",
        String(parsed.error),
        parsed,
      );
    }
    return parsed;
  }

  function validateBlenderMeshPayload(value, maxTriangles) {
    if (
      !value ||
      typeof value !== "object" ||
      !Array.isArray(value.objects)
    ) {
      throw bridgeError(
        "BLENDER_IMPORT_FAILED",
        "Blender returned an invalid scene payload.",
      );
    }
    const objects = [];
    let triangleCount = 0;
    let vertexCount = 0;
    for (const source of value.objects.slice(0, 256)) {
      if (
        !source ||
        !Array.isArray(source.vertices) ||
        !Array.isArray(source.triangles)
      ) {
        continue;
      }
      const vertices = source.vertices.map((vertex) => {
        if (
          !Array.isArray(vertex) ||
          vertex.length < 3 ||
          !vertex.slice(0, 3).every(
            (coordinate) =>
              typeof coordinate === "number" &&
              Number.isFinite(coordinate) &&
              Math.abs(coordinate) <= 1_000_000,
          )
        ) {
          throw bridgeError(
            "BLENDER_IMPORT_FAILED",
            "Blender returned an invalid or excessively large vertex coordinate.",
          );
        }
        return vertex.slice(0, 3);
      });
      const remap = new Map();
      const compactVertices = [];
      const compactTriangles = [];
      for (const triangle of source.triangles) {
        if (
          !Array.isArray(triangle) ||
          triangle.length < 3 ||
          !triangle.slice(0, 3).every(
            (index) =>
              Number.isInteger(index) &&
              index >= 0 &&
              index < vertices.length,
          )
        ) {
          throw bridgeError(
            "BLENDER_IMPORT_FAILED",
            "Blender returned an invalid triangle index.",
          );
        }
        const compact = triangle.slice(0, 3).map((oldIndex) => {
          if (!remap.has(oldIndex)) {
            remap.set(oldIndex, compactVertices.length);
            compactVertices.push(vertices[oldIndex]);
          }
          return remap.get(oldIndex);
        });
        if (new Set(compact).size === 3) {
          compactTriangles.push(compact);
        }
      }
      if (!compactTriangles.length) continue;
      triangleCount += compactTriangles.length;
      vertexCount += compactVertices.length;
      if (triangleCount > maxTriangles) {
        throw bridgeError(
          "BLENDER_IMPORT_FAILED",
          `The Blender scene exceeds the ${maxTriangles}-triangle import limit. Simplify or decimate it in Blender, then retry.`,
        );
      }
      if (vertexCount > maxTriangles * 3 + 1_000) {
        throw bridgeError(
          "BLENDER_IMPORT_FAILED",
          "The Blender scene contains too many unique vertices for a safe browser-to-Studio transfer.",
        );
      }
      const rawColor = Array.isArray(source.color)
        ? source.color.slice(0, 3)
        : [0.65, 0.68, 0.72];
      const color = [0, 1, 2].map((index) => {
        const channel = Number(rawColor[index]);
        return Number.isFinite(channel)
          ? Math.min(1, Math.max(0, channel))
          : 0.68;
      });
      const minimum = [Infinity, Infinity, Infinity];
      const maximum = [-Infinity, -Infinity, -Infinity];
      for (const vertex of compactVertices) {
        for (let axis = 0; axis < 3; axis += 1) {
          minimum[axis] = Math.min(minimum[axis], vertex[axis]);
          maximum[axis] = Math.max(maximum[axis], vertex[axis]);
        }
      }
      const position = [0, 1, 2].map(
        (axis) => (minimum[axis] + maximum[axis]) / 2,
      );
      const centeredVertices = compactVertices.map((vertex) =>
        vertex.map((coordinate, axis) => coordinate - position[axis]),
      );
      objects.push({
        name:
          String(source.name || `Mesh${objects.length + 1}`)
            .replace(/[^\w .()\-]/g, "")
            .trim()
            .slice(0, 80) || `Mesh${objects.length + 1}`,
        vertices: centeredVertices,
        triangles: compactTriangles,
        color,
        position,
      });
    }
    if (!objects.length || !triangleCount) {
      throw bridgeError(
        "BLENDER_IMPORT_FAILED",
        "Blender has no valid visible mesh geometry to import.",
      );
    }
    const sceneMinimum = [Infinity, Infinity, Infinity];
    const sceneMaximum = [-Infinity, -Infinity, -Infinity];
    for (const object of objects) {
      for (const vertex of object.vertices) {
        for (let axis = 0; axis < 3; axis += 1) {
          const coordinate =
            object.position[axis] + vertex[axis];
          sceneMinimum[axis] = Math.min(
            sceneMinimum[axis],
            coordinate,
          );
          sceneMaximum[axis] = Math.max(
            sceneMaximum[axis],
            coordinate,
          );
        }
      }
    }
    const sceneCenter = [0, 1, 2].map(
      (axis) =>
        (sceneMinimum[axis] + sceneMaximum[axis]) / 2,
    );
    const sceneSize = [0, 1, 2].map(
      (axis) => sceneMaximum[axis] - sceneMinimum[axis],
    );
    const largestDimension = Math.max(...sceneSize);
    if (
      !Number.isFinite(largestDimension) ||
      largestDimension <= 0
    ) {
      throw bridgeError(
        "BLENDER_IMPORT_FAILED",
        "Blender returned mesh geometry with no visible size.",
      );
    }
    // Blender scenes are frequently authored in meters, millimeters, or
    // far from the world origin. Preserve normal-sized scenes, but make
    // extreme scenes visible and center their pivot before Studio import.
    const scaleFactor =
      largestDimension < 1
        ? 8 / largestDimension
        : largestDimension > 256
          ? 64 / largestDimension
          : 1;
    for (const object of objects) {
      object.vertices = object.vertices.map((vertex) =>
        vertex.map((coordinate) => coordinate * scaleFactor),
      );
      object.position = object.position.map(
        (coordinate, axis) =>
          (coordinate - sceneCenter[axis]) * scaleFactor,
      );
    }
    return {
      version: 1,
      objects,
      triangleCount,
      vertexCount,
      scaleFactor,
      size: sceneSize.map(
        (dimension) => dimension * scaleFactor,
      ),
    };
  }

  function buildRobloxEditableMeshImport(payload, options) {
    const transfer = {
      objects: payload.objects,
      triangleCount: payload.triangleCount,
      scaleFactor: payload.scaleFactor,
      size: payload.size,
    };
    const jsonLiteral = JSON.stringify(JSON.stringify(transfer));
    const nameLiteral = JSON.stringify(options.targetName);
    const position = options.position
      ? `Vector3.new(${options.position.x}, ${options.position.y}, ${options.position.z})`
      : "nil";
    return `local HttpService = game:GetService("HttpService")
local AssetService = game:GetService("AssetService")
local Workspace = game:GetService("Workspace")
local payload = HttpService:JSONDecode(${jsonLiteral})
local requestedName = ${nameLiteral}
local staged = Instance.new("Model")
staged.Name = requestedName
local firstMeshPart = nil

local function uniqueName(baseName)
    if not Workspace:FindFirstChild(baseName) then
        return baseName
    end
    local number = 2
    while Workspace:FindFirstChild(baseName .. " " .. number) do
        number += 1
    end
    return baseName .. " " .. number
end

local ok, outcome = pcall(function()
    for _, source in ipairs(payload.objects) do
        local editable = AssetService:CreateEditableMesh()
        local ids = {}
        for index, point in ipairs(source.vertices) do
            ids[index] = editable:AddVertex(Vector3.new(point[1], point[2], point[3]))
        end
        for _, triangle in ipairs(source.triangles) do
            editable:AddTriangle(
                ids[triangle[1] + 1],
                ids[triangle[2] + 1],
                ids[triangle[3] + 1]
            )
        end
        local meshPart = AssetService:CreateMeshPartAsync(
            Content.fromObject(editable),
            {
                CollisionFidelity = Enum.CollisionFidelity.Hull,
                RenderFidelity = Enum.RenderFidelity.Precise,
            }
        )
        meshPart.Name = source.name
        meshPart.Anchored = true
        meshPart.Material = Enum.Material.SmoothPlastic
        meshPart.Color = Color3.new(source.color[1], source.color[2], source.color[3])
        meshPart.Position = Vector3.new(source.position[1], source.position[2], source.position[3])
        meshPart.Parent = staged
        firstMeshPart = firstMeshPart or meshPart
        editable:Destroy()
    end
    if #staged:GetChildren() == 0 then
        error("No MeshParts were created.")
    end
    local existing = Workspace:FindFirstChild(requestedName)
    if existing and ${options.replaceExisting ? "true" : "false"} then
        existing:Destroy()
    elseif existing then
        staged.Name = uniqueName(requestedName)
    end
    staged.Parent = Workspace
    staged.PrimaryPart = firstMeshPart
    local targetPosition = ${position}
    if not targetPosition then
        local camera = Workspace.CurrentCamera
        local focusPosition = camera and camera.Focus.Position or nil
        local spawn = Workspace:FindFirstChildWhichIsA("SpawnLocation", true)
        local basePosition = focusPosition or (spawn and spawn.Position) or Vector3.zero
        local _, importedSize = staged:GetBoundingBox()
        targetPosition = basePosition + Vector3.new(0, math.max(importedSize.Y * 0.5, 0.5), 0)
    end
    staged:PivotTo(CFrame.new(targetPosition))
    local importedCFrame, importedSize = staged:GetBoundingBox()
    if importedSize.Magnitude < 0.05 then
        error("Imported mesh has no visible size.")
    end
    return HttpService:JSONEncode({
        imported = true,
        model = staged:GetFullName(),
        meshParts = #staged:GetChildren(),
        triangles = payload.triangleCount,
        position = { importedCFrame.X, importedCFrame.Y, importedCFrame.Z },
        size = { importedSize.X, importedSize.Y, importedSize.Z },
        scaleFactor = payload.scaleFactor,
        source = "Blender",
    })
end)

if not ok then
    staged:Destroy()
    error(outcome)
end
return outcome`;
  }

  async function createJob(body) {
    if (!body || typeof body !== "object") {
      throw httpError(400, "The /push body must be a JSON object.");
    }
    const tool = String(body.tool || "").trim();
    if (!tool) {
      throw httpError(400, "A ViewCoder tool name is required.");
    }
    const route = resolveToolRoute(tool);
    if (isDisabledTool(route.realTool, route.server)) {
      throw httpError(400, "This ViewCoder capture/play-test command is disabled. Continue with the requested edit using the available tools.");
    }
    const argumentsObject =
      body.arguments &&
      typeof body.arguments === "object" &&
      !Array.isArray(body.arguments)
        ? body.arguments
        : {};
    const source =
      body.source && typeof body.source === "object"
        ? body.source
        : {};
    if (route.server === "roblox" && route.realTool === "execute_luau") {
      if (
        typeof argumentsObject.code !== "string" ||
        !argumentsObject.code.trim()
      ) {
        throw httpError(
          400,
          "execute_luau requires a non-empty code string.",
        );
      }
      const datamodel = String(
        argumentsObject.datamodel_type || "Edit",
      );
      argumentsObject.datamodel_type = [
        "Edit",
        "Client",
        "Server",
      ].includes(datamodel)
        ? datamodel
        : "Edit";
    }
    if (route.server === "roblox" && route.realTool === "generate_mesh") {
      const size = argumentsObject.size;
      if (
        !size ||
        typeof size !== "object" ||
        Array.isArray(size)
      ) {
        throw httpError(
          400,
          "generate_mesh requires arguments.size with positive numeric x, y, and z values.",
        );
      }
      for (const axis of ["x", "y", "z"]) {
        if (
          typeof size[axis] !== "number" ||
          !Number.isFinite(size[axis]) ||
          size[axis] <= 0
        ) {
          throw httpError(
            400,
            `generate_mesh requires arguments.size.${axis} to be a positive number.`,
          );
        }
      }
    }
    const definition = definitionForRoute(route);
    if (definition) {
      await ensureConnectedStudioId(route, argumentsObject, definition);
      const schema =
        definition.inputSchema ??
        definition.input_schema ??
        {};
      const issue = validateSchemaValue(
        argumentsObject,
        schema,
        "arguments",
        true,
      );
      if (issue) {
        throw httpError(400, issue);
      }
    }

    const jobId = nextJobId;
    nextJobId += 1;
    const sessionId = String(body.sessionId || "anonymous").slice(
      0,
      180,
    );
    const semanticKey = crypto
      .createHash("sha256")
      .update(
        stableStringify({
          sessionId,
          promptRevision:
            source.promptRevision ?? source.prompt ?? "",
          tool,
          server: route.server,
          arguments: argumentsObject,
        }),
      )
      .digest("hex");
    return {
      jobId,
      requestId: String(
        body.requestId ||
          crypto.randomUUID?.() ||
          `request-${Date.now()}-${jobId}`,
      ).slice(0, 220),
      sessionId,
      semanticKey,
      kind: "tool",
      tool,
      realTool: route.realTool,
      server: route.server,
      arguments: argumentsObject,
      source,
      queuedAt: new Date().toISOString(),
    };
  }

  function bridgeError(code, message, details = null) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  }

  function classifySuccessfulToolResult(job, result) {
    if (job.realTool !== "generate_procedural_model") return {};
    const text = String(result?.text || "");
    const parsed = safeParseJson(text);
    const generationId = String(
      parsed?.generationId ||
        parsed?.generation_id ||
        text.match(
          /["']?generation(?:Id|_id)["']?\s*[:=]\s*["']([^"',}\s]+)["']/i,
        )?.[1] ||
        "",
    ).trim();
    return {
      code: "GENERATION_QUEUED",
      pending: true,
      generationId: generationId || null,
    };
  }

  function classifyToolFailure(jobOrTool, error) {
    const job =
      typeof jobOrTool === "string"
        ? { tool: jobOrTool, arguments: {} }
        : jobOrTool;
    const tool = job.realTool || job.tool;
    const raw =
      error instanceof Error ? error.message : String(error);
    const datamodel = String(
      job.arguments?.datamodel_type || "Edit",
    );
    if (
      tool === "execute_luau" &&
      (datamodel === "Client" || datamodel === "Server") &&
      /\b(?:timed out|timeout|disconnected|not running|no active|not available|datamodel|play(?:test| mode)?|client|server)\b/i.test(
        raw,
      )
    ) {
      return {
        code: "PLAYTEST_ENDED",
        retryable: true,
        message:
          `Roblox Studio left Play mode while the ${datamodel} command was running. The command was not replayed. ` +
          "Use Edit mode for saved place changes, or start Play mode again before retrying temporary Client/Server work.",
        details: raw,
      };
    }
    if (
      tool === "wait_job_finished" &&
      /\b(?:timeout|timed out|polling|code generation)\b/i.test(raw)
    ) {
      let stage = "";
      const parsed = safeParseJson(raw);
      if (parsed && typeof parsed === "object") {
        stage = String(
          parsed.serverStage ||
            parsed.status ||
            parsed.unknownStatus ||
            "",
        ).trim();
      }
      return {
        code: "JOB_STILL_RUNNING",
        retryable: true,
        message:
          `The existing Studio generation is still running${
            stage ? ` (${stage})` : ""
          }. Keep the same generationId; do not start a replacement generation.`,
        details: raw,
      };
    }
    if (
      tool === "generate_procedural_model" &&
      /\b(?:statusCode["']?\s*[:=]\s*5\d\d|service error|failed to submit generation job|failed to create primitive generation|internal server error|temporarily unavailable)\b/i.test(
        raw,
      )
    ) {
      return {
        code: "GENERATION_SERVICE_ERROR",
        retryable: true,
        message:
          "Roblox Studio's procedural generation service rejected the request before returning a generationId. Nothing was created or placed. Retry once, then use another available geometry tool if the service still fails.",
        details: raw,
      };
    }
    if (error?.code === "INVALID_ARGUMENTS") {
      return {
        code: "INVALID_ARGUMENTS",
        retryable: true,
        message: raw,
        details: error?.details ?? null,
      };
    }
    if (
      error?.code === "STUDIO_CONNECTION" ||
      error?.code === "ADDON_CONNECTION"
    ) {
      return {
        code:
          error?.code === "ADDON_CONNECTION"
            ? "ADDON_CONNECTION"
            : "STUDIO_CONNECTION",
        retryable: true,
        message: raw,
        details: error?.details ?? null,
      };
    }
    if (error?.code === "TOOL_ERROR") {
      return {
        code: "TOOL_ERROR",
        retryable: false,
        message: raw,
        details: error?.details ?? null,
      };
    }
    if (
      error?.code === "UNSAFE_BLENDER_CODE" ||
      error?.code === "BLENDER_IMPORT_FAILED"
    ) {
      return {
        code: error.code,
        retryable: error.code === "BLENDER_IMPORT_FAILED",
        message: raw,
        details: error?.details ?? null,
      };
    }
    const retryable =
      /\b(?:disconnected|not running|broken pipe|econnreset|temporarily unavailable)\b/i.test(
        raw,
      );
    return {
      code: retryable
        ? job.server === "blender"
          ? "ADDON_CONNECTION"
          : "STUDIO_CONNECTION"
        : "TOOL_ERROR",
      retryable,
      message: raw,
      details: null,
    };
  }

  function normalizedToolFailure(tool, value) {
    const text = String(value || "").trim();
    if (!text) return null;
    if (
      /Unable to find an active Studio instance|previously active Studio has disconnected/i.test(
        text,
      )
    ) {
      return bridgeError("STUDIO_CONNECTION", text);
    }
    if (
      tool === "execute_luau" &&
      (/\b(?:ExecuteLuauTool|CommandExecution):\d+:/i.test(
        text,
      ) ||
        /^(?:error|failed)\b.{0,80}(?:execut|pars|luau|lua|code)/i.test(
          text,
        ))
    ) {
      return bridgeError("TOOL_ERROR", text);
    }
    if (
      text.length <= 500 &&
      /^(?:error|failed|failure)\s*(?::|-)/i.test(text)
    ) {
      return bridgeError("TOOL_ERROR", text);
    }
    return null;
  }

  function validateSchemaValue(
    value,
    schema,
    path,
    requiredValue = false,
  ) {
    if (!schema || typeof schema !== "object") return "";
    if (Array.isArray(schema.allOf)) {
      for (const entry of schema.allOf) {
        const issue = validateSchemaValue(
          value,
          entry,
          path,
          requiredValue,
        );
        if (issue) return issue;
      }
    }
    const alternatives = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(alternatives) && alternatives.length) {
      const failures = alternatives.map((entry) =>
        validateSchemaValue(
          value,
          entry,
          path,
          requiredValue,
        ),
      );
      if (failures.some((failure) => !failure)) return "";
      return failures.find(Boolean) || `${path} is invalid.`;
    }
    if (
      value == null ||
      (requiredValue &&
        typeof value === "string" &&
        !value.trim())
    ) {
      return `${path} is required and cannot be empty.`;
    }
    if (value == null) return "";
    if (
      Object.prototype.hasOwnProperty.call(schema, "const") &&
      !Object.is(value, schema.const)
    ) {
      return `${path} must equal ${JSON.stringify(schema.const)}.`;
    }

    const allowedTypes = Array.isArray(schema.type)
      ? schema.type
      : schema.type
        ? [schema.type]
        : [];
    if (
      allowedTypes.length &&
      !allowedTypes.some((type) => schemaTypeMatches(value, type))
    ) {
      return `${path} must be ${allowedTypes.join(" or ")}.`;
    }
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      typeof schema.minimum === "number" &&
      value < schema.minimum
    ) {
      return `${path} must be at least ${schema.minimum}.`;
    }
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      typeof schema.maximum === "number" &&
      value > schema.maximum
    ) {
      return `${path} must be at most ${schema.maximum}.`;
    }
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      typeof schema.exclusiveMinimum === "number" &&
      value <= schema.exclusiveMinimum
    ) {
      return `${path} must be greater than ${schema.exclusiveMinimum}.`;
    }
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      typeof schema.exclusiveMaximum === "number" &&
      value >= schema.exclusiveMaximum
    ) {
      return `${path} must be less than ${schema.exclusiveMaximum}.`;
    }
    if (
      Array.isArray(schema.enum) &&
      schema.enum.length &&
      !schema.enum.some((candidate) =>
        Object.is(candidate, value),
      )
    ) {
      return `${path} must be one of: ${schema.enum
        .map((candidate) => JSON.stringify(candidate))
        .join(", ")}.`;
    }
    if (
      typeof value === "string" &&
      Number.isFinite(schema.minLength) &&
      value.length < schema.minLength
    ) {
      return `${path} must contain at least ${schema.minLength} character(s).`;
    }
    if (
      typeof value === "string" &&
      Number.isFinite(schema.maxLength) &&
      value.length > schema.maxLength
    ) {
      return `${path} must contain at most ${schema.maxLength} character(s).`;
    }
    if (typeof value === "string" && typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) {
          return `${path} has an invalid format.`;
        }
      } catch {
        // A malformed schema pattern must not crash the local bridge.
      }
    }

    const properties = schema.properties ?? {};
    if (
      schema.type === "object" ||
      Object.keys(properties).length
    ) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value)
      ) {
        return `${path} must be an object.`;
      }
      const required = new Set(schema.required ?? []);
      for (const name of required) {
        if (!Object.prototype.hasOwnProperty.call(value, name)) {
          return `${path}.${name} is required and cannot be empty.`;
        }
        const issue = validateSchemaValue(
          value[name],
          properties[name] ?? {},
          `${path}.${name}`,
          true,
        );
        if (issue) return issue;
      }
      for (const [name, definition] of Object.entries(
        properties,
      )) {
        if (
          required.has(name) ||
          !Object.prototype.hasOwnProperty.call(value, name)
        ) {
          continue;
        }
        const issue = validateSchemaValue(
          value[name],
          definition,
          `${path}.${name}`,
          false,
        );
        if (issue) return issue;
      }
      const knownNames = new Set(Object.keys(properties));
      for (const [name, childValue] of Object.entries(value)) {
        if (knownNames.has(name)) continue;
        if (schema.additionalProperties === false) {
          return `${path}.${name} is not allowed.`;
        }
        if (
          schema.additionalProperties &&
          typeof schema.additionalProperties === "object"
        ) {
          const issue = validateSchemaValue(
            childValue,
            schema.additionalProperties,
            `${path}.${name}`,
            false,
          );
          if (issue) return issue;
        }
      }
    }
    if (Array.isArray(value)) {
      if (
        Number.isFinite(schema.minItems) &&
        value.length < schema.minItems
      ) {
        return `${path} requires at least ${schema.minItems} item(s).`;
      }
      if (
        Number.isFinite(schema.maxItems) &&
        value.length > schema.maxItems
      ) {
        return `${path} allows at most ${schema.maxItems} item(s).`;
      }
      if (
        schema.uniqueItems === true &&
        new Set(value.map((entry) => JSON.stringify(entry))).size !==
          value.length
      ) {
        return `${path} cannot contain duplicate items.`;
      }
      if (schema.items) {
        for (let index = 0; index < value.length; index += 1) {
          const issue = validateSchemaValue(
            value[index],
            schema.items,
            `${path}[${index}]`,
            true,
          );
          if (issue) return issue;
        }
      }
    }
    return "";
  }

  function buildReadOnlyProbeArguments(tool, targetLabel = "application") {
    const schema = tool?.inputSchema ?? tool?.input_schema ?? {};
    if (!schema || typeof schema !== "object") return {};
    if (schema.type && schema.type !== "object") return null;

    const properties =
      schema.properties && typeof schema.properties === "object"
        ? schema.properties
        : {};
    const required = Array.isArray(schema.required)
      ? schema.required
      : [];
    const argumentsValue = {};

    for (const name of required) {
      const property = properties[name];
      if (!property || typeof property !== "object") return null;
      if (Object.prototype.hasOwnProperty.call(property, "default")) {
        argumentsValue[name] = property.default;
      } else if (
        Array.isArray(property.enum) &&
        property.enum.length
      ) {
        argumentsValue[name] = property.enum[0];
      } else if (property.type === "string") {
        argumentsValue[name] =
          name === "user_prompt"
            ? `Verify ViewCoder's ${targetLabel} connection without changing the project.`
            : "ViewCoder connection check";
      } else if (property.type === "boolean") {
        argumentsValue[name] = false;
      } else if (
        property.type === "integer" ||
        property.type === "number"
      ) {
        argumentsValue[name] = Number.isFinite(property.minimum)
          ? property.minimum
          : 0;
      } else {
        return null;
      }
    }

    return validateSchemaValue(
      argumentsValue,
      schema,
      "arguments",
      true,
    )
      ? null
      : argumentsValue;
  }

  function schemaTypeMatches(value, type) {
    if (type === "null") return value == null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") {
      return (
        value != null &&
        typeof value === "object" &&
        !Array.isArray(value)
      );
    }
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") {
      return typeof value === "number" && Number.isFinite(value);
    }
    return typeof value === type;
  }

  function stableStringify(value) {
    if (Array.isArray(value)) {
      return `[${value.map(stableStringify).join(",")}]`;
    }
    if (value && typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${stableStringify(value[key])}`,
        )
        .join(",")}}`;
    }
    return JSON.stringify(value);
  }

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

  function enforceSafety(job) {
    if (
      job.server === "blender" &&
      job.realTool === "execute_blender_code"
    ) {
      const code = String(job.arguments.code || "");
      if (!code.trim()) {
        throw bridgeError(
          "INVALID_ARGUMENTS",
          "Blender execute_blender_code requires a non-empty code string.",
        );
      }
      if (hasTopLevelPythonReturn(code)) {
        throw bridgeError(
          "INVALID_BLENDER_CODE",
          "Blender code contains a top-level return statement. execute_blender_code runs at Python module scope; remove the top-level return or place it inside a function.",
        );
      }
      const dangerousPython = [
        /\b(?:from|import)\s+(?:os|sys|subprocess|socket|pathlib|shutil|tempfile|urllib|requests|http|ftplib|ctypes|pickle)\b/i,
        /\b(?:__import__|eval|exec|compile|open)\s*\(/i,
        /\b(?:os|subprocess|socket|pathlib|shutil|tempfile|urllib|requests|http|ftplib|ctypes|pickle)\s*\./i,
        /\bbpy\.ops\.wm\.(?:open_mainfile|save_as_mainfile|save_mainfile)\b/i,
        /\bbpy\.data\.libraries\.(?:load|write)\b/i,
      ].some((pattern) => pattern.test(code));
      if (
        dangerousPython &&
        process.env.VIEWCODER_ALLOW_UNSAFE_BLENDER_CODE !== "1"
      ) {
        throw bridgeError(
          "UNSAFE_BLENDER_CODE",
          "ViewCoder blocked Blender code that can access files, processes, or the network. Use Blender geometry APIs only, or explicitly opt in with VIEWCODER_ALLOW_UNSAFE_BLENDER_CODE=1.",
        );
      }
      return;
    }
    if (job.server !== "roblox" || job.realTool !== "execute_luau") {
      return;
    }
    const code = String(job.arguments.code || "");
    const obviouslyBroadDeletion = [
      /\b(?:game|workspace)\s*:\s*ClearAllChildren\s*\(/i,
      /\bgame\s*:\s*Destroy\s*\(/i,
      /GetDescendants\s*\(\s*\)[\s\S]{0,220}:\s*Destroy\s*\(/i,
    ].some((pattern) => pattern.test(code));
    if (
      obviouslyBroadDeletion &&
      process.env.VIEWCODER_ALLOW_BROAD_DELETE !== "1"
    ) {
      throw new Error(
        "ViewCoder blocked a broad deletion command. Ask the user to confirm the exact deletion scope, or set VIEWCODER_ALLOW_BROAD_DELETE=1 before starting the bridge.",
      );
    }
  }

  async function refreshStudioProbe() {
    if (processingQueue) return studioProbe;
    if (studioProbePromise) return studioProbePromise;
    studioProbePromise = refreshStudioProbeNow().finally(() => {
      studioProbePromise = null;
    });
    return studioProbePromise;
  }

  async function refreshStudioProbeNow() {
    studioProcessRunning = await refreshStudioProcessState();
    if (
      !mcp.tools.some(
        (tool) => tool.name === "list_roblox_studios",
      )
    ) {
      studioProbe = {
        connected: mcp.tools.length > 0,
        name: null,
        id: null,
        checkedAt: new Date().toISOString(),
        error: mcp.tools.length
          ? null
          : "Studio has not advertised tools.",
      };
      return studioProbe;
    }

    try {
      const result = await mcp.callTool(
        "list_roblox_studios",
        {},
        12_000,
      );
      const parsed = safeParseJson(result.text);
      const studios = Array.isArray(parsed?.studios)
        ? parsed.studios
        : [];
      const selected =
        studios.find((studio) => studio.active) ??
        studios[0] ??
        null;
      studioProbe = {
        connected: studios.length > 0,
        name: selected?.name ?? null,
        id: selected?.id ?? null,
        checkedAt: new Date().toISOString(),
        error: null,
      };
      if (studioProbe.connected) {
        studioDisconnectedSince = 0;
      } else if (!studioDisconnectedSince) {
        studioDisconnectedSince = Date.now();
      }
      const announcementKey = studioProbe.connected
        ? `${studioProbe.id || studioProbe.name || "studio"}:${mcp.tools.length}`
        : null;
      if (
        announcementKey &&
        announcementKey !== lastConnectedAnnouncement
      ) {
        lastConnectedAnnouncement = announcementKey;
        log(
          `CONNECTED — Roblox Studio ${studioProbe.name || "place"} (${mcp.tools.length} tools).`,
          "success",
        );
      } else if (
        !announcementKey &&
        lastConnectedAnnouncement
      ) {
        lastConnectedAnnouncement = null;
        log(
          "Studio disconnected — Start is locked until it reconnects.",
          "warning",
        );
      }
      if (
        !studioProbe.connected &&
        studioDisconnectedSince &&
        Date.now() - studioDisconnectedSince >= 45_000 &&
        Date.now() - lastStudioReconnectInstructionAt >=
          60_000 &&
        studioProcessRunning
      ) {
        lastStudioReconnectInstructionAt = Date.now();
        log(
          "Studio is open but its MCP place connection is unavailable. In Studio, open Assistant > Manage MCP Servers and toggle Enable Studio as MCP server off and on. ViewCoder will reconnect automatically.",
          "warning",
        );
      }
      return studioProbe;
    } catch (error) {
      if (lastConnectedAnnouncement) {
        log(
          "Studio disconnected — Start is locked until it reconnects.",
          "warning",
        );
      }
      lastConnectedAnnouncement = null;
      studioProbe = {
        connected: false,
        name: null,
        id: null,
        checkedAt: new Date().toISOString(),
        error:
          error instanceof Error
            ? error.message
            : String(error),
      };
      if (!studioDisconnectedSince) {
        studioDisconnectedSince = Date.now();
      }
      return studioProbe;
    }
  }

  function serverStatuses() {
    return [
      {
        id: "roblox",
        label: "Roblox Studio",
        enabled: true,
        required: false,
        state: mcp.state,
        ready:
          mcp.state === "ready" &&
          studioProbe.connected === true,
        verified: studioProbe.connected === true,
        toolCount: mcp.tools.length,
        endpoint: "Studio MCP",
        error: mcp.lastError || studioProbe.error || null,
      },
      {
        id: "blender",
        label: "Blender",
        enabled: blenderMcp.enabled(),
        required: false,
        state:
          blenderMcp.enabled() && !blenderAddonProbe.connected && blenderMcp.child
            ? "waiting"
            : blenderMcp.state,
        ready: blenderAddonProbe.connected,
        verified: blenderAddonProbe.connected,
        toolCount: blenderAddonProbe.connected
          ? blenderMcp.tools.filter(
              (tool) => !isDisabledTool(tool?.name, "blender"),
            ).length
          : 0,
        endpoint: `${String(
          bridgeConfig.servers.blender.env?.BLENDER_HOST ||
            "127.0.0.1",
        )}:${String(
          bridgeConfig.servers.blender.env?.BLENDER_PORT || "9876",
        )}`,
        launch: blenderMcp.launchDescription,
        handshake: { ...blenderAddonProbe },
        error: blenderAddonProbe.error || blenderMcp.lastError,
      },
    ];
  }

  function serversPayload() {
    const servers = serverStatuses();
    const studio = servers.find((item) => item.id === "roblox");
    const blender = servers.find((item) => item.id === "blender");
    const readyServers = servers.filter((item) => item.ready === true);
    const enabledServers = servers.filter((item) => item.enabled === true);
    return {
      ok: true,
      servers,
      totalToolCount: advertisedTools().length,
      anyConnected: readyServers.length > 0,
      connectedCount: readyServers.length,
      allEnabledConnected:
        enabledServers.length > 0 &&
        enabledServers.every((item) => item.ready === true),
      bothConnected:
        studio?.ready === true && blender?.ready === true,
    };
  }

  async function setAddonEnabled(id, enabled) {
    const client = addonClients[id];
    if (!client) throw httpError(404, `Unknown MCP target: ${id}`);
    bridgeConfig = {
      ...bridgeConfig,
      servers: {
        ...bridgeConfig.servers,
        [id]: {
          ...bridgeConfig.servers[id],
          enabled,
        },
      },
    };
    await writeBridgeConfig(bridgeConfig);
    if (!enabled) {
      await client.stop();
      blenderAddonProbe = disconnectedBlenderAddonProbe(null, {
        source: "disabled",
      });
      client.state = "disabled";
      client.lastError = null;
      log(`${client.label} MCP connection disabled.`, "info");
      return;
    }
    client.state = SKIP_MCP ? "disabled" : "offline";
    blenderAddonProbe = disconnectedBlenderAddonProbe(
      "Waiting for Blender MCP add-on handshake.",
      { source: "connecting" },
    );
    if (!SKIP_MCP) {
      client.resetReconnectBackoff();
      void client.connect().catch(() => false);
    }
  }

  async function readBridgeConfig() {
    const fallback = cloneJson(DEFAULT_CONFIG);
    let parsed = null;
    try {
      parsed = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        log?.(
          `Could not read ${CONFIG_PATH}; using safe defaults.`,
          "warning",
        );
      }
    }
    const blender = parsed?.servers?.blender ?? {};
    const configuredCommand =
      typeof blender.command === "string" && blender.command.trim()
        ? blender.command.trim()
        : fallback.servers.blender.command;
    const configuredArgs = Array.isArray(blender.args)
      ? blender.args.map(String).slice(0, 24)
      : fallback.servers.blender.args;
    return {
      servers: {
        blender: {
          enabled: blender.enabled === true,
          command: configuredCommand,
          args: migrateLegacyBlenderArgs(
            configuredCommand,
            configuredArgs,
            fallback.servers.blender.args,
          ),
          env: {
            ...fallback.servers.blender.env,
            ...(blender.env &&
            typeof blender.env === "object" &&
            !Array.isArray(blender.env)
              ? Object.fromEntries(
                  Object.entries(blender.env)
                    .slice(0, 24)
                    .map(([key, value]) => [
                      String(key),
                      String(value),
                    ]),
                )
              : {}),
          },
        },
      },
    };
  }

  async function writeBridgeConfig(config) {
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
    await fs.writeFile(
      temporary,
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );
    if (process.platform === "win32") {
      // Do not delete the only valid config before its replacement exists.
      await fs.copyFile(temporary, CONFIG_PATH);
      await fs.rm(temporary, { force: true });
    } else {
      await fs.rename(temporary, CONFIG_PATH);
    }
  }

  function migrateLegacyBlenderArgs(command, args, fallbackArgs) {
    const normalizedCommand = String(command || "")
      .trim()
      .toLowerCase();
    const normalizedArgs = args.map((value) =>
      String(value).trim().toLowerCase(),
    );
    const signatures = [
      ["/d", "/s", "/c", "uvx", "blender-mcp"],
      [
        "/d",
        "/s",
        "/c",
        "uvx",
        "--with",
        "mcp[cli]<2",
        "blender-mcp",
      ],
      ["blender-mcp"],
      ["--with", "mcp[cli]<2", "blender-mcp"],
    ];
    const knownLauncher =
      normalizedCommand === "cmd.exe" ||
      normalizedCommand === "cmd" ||
      normalizedCommand === "uvx";
    const isLegacy =
      knownLauncher &&
      signatures.some(
        (signature) =>
          signature.length === normalizedArgs.length &&
          signature.every(
            (value, index) => value === normalizedArgs[index],
          ),
      );
    return isLegacy ? [...fallbackArgs] : args;
  }

  function normalizedAddonLaunch(config, id = "blender") {
    const fallback =
      DEFAULT_CONFIG.servers[id] || DEFAULT_CONFIG.servers.blender;
    return {
      command:
        typeof config?.command === "string" && config.command.trim()
          ? config.command.trim()
          : fallback.command,
      args: Array.isArray(config?.args)
        ? config.args.map(String)
        : [...fallback.args],
      env:
        config?.env &&
        typeof config.env === "object" &&
        !Array.isArray(config.env)
          ? Object.fromEntries(
              Object.entries(config.env).map(([key, value]) => [
                String(key),
                String(value),
              ]),
            )
          : { ...fallback.env },
    };
  }

  function friendlyAddonError(id, value) {
    const message = String(value || "").replace(/\s+/g, " ").trim();
    if (
      id === "blender" &&
      /\bmcp\.server\.fastmcp\b|no module named ['"]mcp\.server/i.test(
        message,
      )
    ) {
      return "Blender MCP loaded an incompatible Python MCP package. ViewCoder now pins the compatible MCP runtime; restart start.bat to apply it.";
    }
    if (
      id === "blender" &&
      /\b(?:uvx|uv)\b.{0,120}(?:not recognized|not found|enoent|cannot find)|(?:not recognized|not found|enoent|cannot find).{0,120}\b(?:uvx|uv)\b/i.test(
        message,
      )
    ) {
      return "Blender needs the uv/uvx launcher. Install uv, reopen ViewCoder, then connect Blender again.";
    }
    if (isAddonConnectionFailure(id, message)) {
      return "Open Blender, install and enable Blender MCP, then click Connect to MCP Server on port 9876.";
    }
    return message || `${id} MCP disconnected.`;
  }

  function isAddonConnectionFailure(id, value) {
    const message = String(value || "");
    if (id === "blender") {
      return /\b(?:could not connect to blender|connection to blender lost|connection refused|connect(?:ion)? failed|timed out|server is not running|blender add-?on (?:is )?(?:not running|disconnected|unavailable)|make sure the blender add-?on is running|port 9876|winerror 1005[34])\b/i.test(
        message,
      );
    }
    return false;
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function statusPayload() {
    const checkedAtMs = Date.parse(
      studioProbe.checkedAt || "",
    );
    const probeAgeMs = Number.isFinite(checkedAtMs)
      ? Math.max(0, Date.now() - checkedAtMs)
      : null;
    const allowedProbeAgeMs = processingQueue
      ? TOOL_TIMEOUT_MS + 30_000
      : 6_500;
    const verified = Boolean(
      mcp.state === "ready" &&
        mcp.tools.length > 0 &&
        studioProbe.connected &&
        probeAgeMs != null &&
        probeAgeMs <= allowedProbeAgeMs,
    );
    const servers = serverStatuses();
    const readyServers = servers.filter((item) => item.ready === true);
    const enabledServers = servers.filter((item) => item.enabled === true);
    return {
      ok: true,
      online: true,
      name: "ViewCoder Bridge",
      version: VERSION,
      host: HOST,
      port: PORT,
      startedAt: bridgeStartedAt,
      queue: {
        waiting: jobs.length,
        processing: processingQueue,
      },
      totalToolCount: advertisedTools().length,
      anyConnected: readyServers.length > 0,
      connectedCount: readyServers.length,
      connectedTargets: readyServers.map((item) => item.id),
      allEnabledConnected:
        enabledServers.length > 0 &&
        enabledServers.every((item) => item.ready === true),
      bothConnected:
        verified && blenderAddonProbe.connected,
      servers,
      mcp: {
        state: mcp.state,
        toolCount: mcp.tools.length,
        studio: studioProbe.connected,
        studioProcess: studioProcessRunning,
        studioName: studioProbe.name,
        studioId: studioProbe.id,
        checkedAt: studioProbe.checkedAt,
        probeAgeMs,
        verified,
        launch: mcp.launchDescription,
        error: mcp.lastError || studioProbe.error,
      },
    };
  }

  async function resolveStudioLaunch() {
    const override = process.env.VIEWCODER_STUDIO_MCP_PATH;
    if (override && (await fileExists(override))) {
      if (
        process.platform === "win32" &&
        /\.(?:bat|cmd)$/i.test(override)
      ) {
        return {
          command: "cmd.exe",
          args: ["/d", "/c", "call", override],
          description: override,
        };
      }
      return {
        command: override,
        args: [],
        description: override,
      };
    }

    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData) {
        const versionsDirectory = path.join(
          localAppData,
          "Roblox",
          "Versions",
        );
        const candidates = [];
        try {
          const entries = await fs.readdir(versionsDirectory, {
            withFileTypes: true,
          });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const directory = path.join(
              versionsDirectory,
              entry.name,
            );
            const studioMcp = path.join(
              directory,
              "StudioMCP.exe",
            );
            const studioExecutables = [
              "RobloxStudioBeta.exe",
              "RobloxStudio.exe",
            ];
            if (
              !(await fileExists(studioMcp)) ||
              !(await anyFileExists(
                studioExecutables.map((name) =>
                  path.join(directory, name),
                ),
              ))
            ) {
              continue;
            }
            const stat = await fs.stat(studioMcp);
            candidates.push({
              file: studioMcp,
              modified: stat.mtimeMs,
            });
          }
        } catch {
          // Fall through to Roblox's official mcp.bat launcher.
        }
        candidates.sort(
          (left, right) => right.modified - left.modified,
        );
        if (candidates[0]) {
          return {
            command: candidates[0].file,
            args: [],
            description: candidates[0].file,
          };
        }

        const batch = path.join(
          localAppData,
          "Roblox",
          "mcp.bat",
        );
        if (await fileExists(batch)) {
          return {
            command: "cmd.exe",
            args: ["/d", "/s", "/c", `"${batch}"`],
            description: batch,
          };
        }
      }
    }

    if (process.platform === "darwin") {
      const binary =
        "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP";
      if (await fileExists(binary)) {
        return {
          command: binary,
          args: [],
          description: binary,
        };
      }
    }

    throw new Error(
      "Roblox Studio MCP was not found. Update Roblox Studio, open Assistant > Manage MCP Servers, and enable Studio as MCP server.",
    );
  }

  async function captureWindowsCommand(command, args, timeoutMs = 5_000) {
    if (process.platform !== "win32") return "";
    return new Promise((resolve) => {
      const child = childProcess.spawn(command, args, {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      let output = "";
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // The process may already have exited.
        }
        resolve(output);
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        if (output.length < 100_000) output += String(chunk);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(output);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(output);
      });
    });
  }

  async function isRobloxStudioRunning() {
    if (process.platform !== "win32") return true;
    const output = await captureWindowsCommand(
      "tasklist",
      ["/FO", "CSV", "/NH"],
      8_000,
    );
    if (!output.trim()) return null;
    return /\bRobloxStudio(?:Beta)?\.exe\b/i.test(output);
  }

  async function refreshStudioProcessState() {
    const now = Date.now();
    if (now - studioProcessCheckedAt < 4_000) {
      return studioProcessRunning;
    }
    studioProcessCheckedAt = now;
    const running = await isRobloxStudioRunning();
    // An inconclusive process probe must not overwrite a previously
    // verified live Studio connection.
    if (running == null) return studioProbe.connected;
    return running;
  }

  async function cleanupOrphanStudioMcp() {
    if (process.platform !== "win32") return;
    const studioRunning = await isRobloxStudioRunning();
    if (studioRunning !== false) return;
    const output = await captureWindowsCommand("tasklist", [
      "/FI",
      "IMAGENAME eq StudioMCP.exe",
      "/FO",
      "CSV",
      "/NH",
    ]);
    if (!/\bStudioMCP\.exe\b/i.test(output)) return;
    log(
      "Cleaning up a leftover StudioMCP process from an earlier closed Studio session.",
      "warning",
    );
    await new Promise((resolve) => {
      const killer = childProcess.spawn(
        "taskkill",
        ["/F", "/IM", "StudioMCP.exe"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      killer.on("exit", resolve);
      killer.on("error", resolve);
    });
  }

  function normalizeToolResult(result, sourceLabel = "Studio") {
    const content = Array.isArray(result?.content)
      ? result.content
      : [];
    const text = content
      .filter((item) => item?.type === "text")
      .map((item) => String(item.text || ""))
      .join("\n");
    const images = content
      .filter(
        (item) =>
          item?.type === "image" &&
          typeof item.data === "string",
      )
      .slice(0, 2)
      .map((item) => ({
        data: item.data,
        mimeType: item.mimeType || "image/png",
      }));
    return {
      text:
        text ||
        (content.length
          ? JSON.stringify(content)
          : `(${sourceLabel} returned no text.)`),
      images,
    };
  }

  function originAllowed(origin) {
    if (!origin) return true;
    if (ALLOWED_LOCAL_ORIGINS.has(origin)) return true;
    try {
      const parsed = new URL(origin);
      return (
        parsed.protocol === "chrome-extension:" ||
        parsed.protocol === "edge-extension:"
      );
    } catch {
      return false;
    }
  }

  function setCors(response, origin) {
    if (origin && originAllowed(origin)) {
      response.setHeader(
        "Access-Control-Allow-Origin",
        origin,
      );
      response.setHeader("Vary", "Origin");
    }
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type",
    );
    response.setHeader(
      "Access-Control-Allow-Methods",
      "GET,HEAD,POST,OPTIONS",
    );
    response.setHeader(
      "Access-Control-Max-Age",
      "86400",
    );
  }

  function sendJson(response, status, value, origin) {
    setCors(response, origin);
    const body = JSON.stringify(value);
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  }

  function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      request.on("data", (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          fail(httpError(413, "The request body is too large."));
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (settled) return;
        settled = true;
        if (!chunks.length) {
          resolve({});
          return;
        }
        try {
          resolve(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          );
        } catch {
          reject(httpError(400, "The request body is not valid JSON."));
        }
      });
      request.on("error", fail);
    });
  }

  function httpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }

  function pruneRelayImages() {
    const now = Date.now();
    for (const [id, image] of relayImages) {
      if (image.expiresAt <= now) relayImages.delete(id);
    }
    let totalBytes = [...relayImages.values()].reduce(
      (sum, image) => sum + image.data.length,
      0,
    );
    while (
      relayImages.size > MAX_RELAY_IMAGES ||
      totalBytes > MAX_RELAY_IMAGE_CACHE_BYTES
    ) {
      const first = relayImages.entries().next().value;
      if (!first) break;
      totalBytes -= first[1].data.length;
      relayImages.delete(first[0]);
    }
  }

  function imageMimeFromBytes(data) {
    if (
      data.length >= 8 &&
      data.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    ) return "image/png";
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
      return "image/jpeg";
    if (
      data.length >= 6 &&
      (data.subarray(0, 6).toString("ascii") === "GIF87a" ||
        data.subarray(0, 6).toString("ascii") === "GIF89a")
    ) return "image/gif";
    if (
      data.length >= 12 &&
      data.subarray(0, 4).toString("ascii") === "RIFF" &&
      data.subarray(8, 12).toString("ascii") === "WEBP"
    ) return "image/webp";
    return null;
  }

  function safeRelayImageName(value, mimeType) {
    const extension = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
    }[mimeType];
    let name = String(value || "viewcoder-image")
      .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    if (!name) name = "viewcoder-image";
    if (!/\.(?:png|jpe?g|gif|webp)$/i.test(name)) name += extension;
    return name.replace(/"/g, "-");
  }

  function publicIpv4(address) {
    const parts = String(address || "").split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return false;
    }
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }

  function ipv6Bytes(value) {
    let address = String(value || "").toLowerCase().split("%")[0];
    if (!address) return null;
    const dotted = address.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dotted) {
      const octets = dotted[1].split(".").map(Number);
      if (octets.some((part) => part < 0 || part > 255)) return null;
      const replacement = `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
      address = address.slice(0, address.length - dotted[1].length) + replacement;
    }
    const halves = address.split("::");
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
    if (fill < 0 || (halves.length === 1 && left.length !== 8)) return null;
    const groups = [...left, ...Array(fill).fill("0"), ...right];
    if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    const bytes = [];
    for (const group of groups) {
      const number = parseInt(group, 16);
      bytes.push(number >> 8, number & 0xff);
    }
    return bytes;
  }

  function publicIpv6(address) {
    const bytes = ipv6Bytes(address);
    if (!bytes) return false;
    const allZero = bytes.every((byte) => byte === 0);
    const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
    if (allZero || loopback) return false;
    const mappedIpv4 = bytes.slice(0, 10).every((byte) => byte === 0) &&
      bytes[10] === 0xff && bytes[11] === 0xff;
    if (mappedIpv4) return publicIpv4(bytes.slice(12).join("."));
    if ((bytes[0] & 0xfe) === 0xfc) return false; // unique-local fc00::/7
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false; // link-local
    if (bytes[0] === 0xff) return false; // multicast
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false;
    // Publicly routed IPv6 currently occupies 2000::/3. Reject special-purpose
    // ranges instead of allowing an outbound request to a local interface.
    return (bytes[0] & 0xe0) === 0x20;
  }

  function publicNetworkAddress(address) {
    const family = net.isIP(String(address || ""));
    if (family === 4) return publicIpv4(address);
    if (family === 6) return publicIpv6(address);
    return false;
  }

  async function publicRemoteTarget(input) {
    const raw = String(input || "").trim();
    if (!raw || raw.length > MAX_REMOTE_IMAGE_URL_LENGTH) {
      throw httpError(400, "The remote image URL is empty or too long.");
    }
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw httpError(400, "The remote image URL is invalid.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw httpError(400, "Only public HTTP and HTTPS image URLs can be relayed.");
    }
    if (url.username || url.password) {
      throw httpError(400, "Remote image URLs cannot contain credentials.");
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
      throw httpError(403, "Local and private image URLs are blocked.");
    }
    let addresses;
    if (net.isIP(hostname)) {
      addresses = [{ address: hostname, family: net.isIP(hostname) }];
    } else {
      try {
        addresses = await dns.lookup(hostname, { all: true, verbatim: true });
      } catch {
        throw httpError(502, "The remote image host could not be resolved.");
      }
    }
    if (!addresses.length || addresses.some((entry) => !publicNetworkAddress(entry.address))) {
      throw httpError(403, "Local, private, link-local, and reserved image hosts are blocked.");
    }
    return { url, address: addresses[0].address, family: addresses[0].family };
  }

  function requestRemoteImage(target) {
    return new Promise((resolve, reject) => {
      const { url, address, family } = target;
      const client = url.protocol === "https:" ? https : http;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const request = client.request({
        protocol: url.protocol,
        hostname: address,
        family,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        servername: net.isIP(url.hostname) ? undefined : url.hostname,
        headers: {
          Host: url.host,
          Accept: "image/png,image/jpeg,image/gif,image/webp,image/*;q=0.8,*/*;q=0.1",
          "Accept-Encoding": "identity",
          "User-Agent": "ViewCoder/1.1 image relay",
        },
      }, (incoming) => {
        const status = Number(incoming.statusCode) || 0;
        if ([301, 302, 303, 307, 308].includes(status) && incoming.headers.location) {
          incoming.resume();
          if (settled) return;
          settled = true;
          resolve({ redirect: new URL(incoming.headers.location, url).href });
          return;
        }
        if (status < 200 || status >= 300) {
          incoming.resume();
          fail(httpError(502, `The remote image host returned HTTP ${status || "error"}.`));
          return;
        }
        const declaredLength = Number(incoming.headers["content-length"] || 0);
        if (declaredLength > MAX_RELAY_IMAGE_BYTES) {
          incoming.destroy();
          fail(httpError(413, "The remote image exceeds ViewCoder's 15 MB limit."));
          return;
        }
        const chunks = [];
        let total = 0;
        incoming.on("data", (chunk) => {
          if (settled) return;
          total += chunk.length;
          if (total > MAX_RELAY_IMAGE_BYTES) {
            incoming.destroy();
            fail(httpError(413, "The remote image exceeds ViewCoder's 15 MB limit."));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({
            data: Buffer.concat(chunks),
            declaredMime: String(incoming.headers["content-type"] || "").split(";")[0].trim().toLowerCase(),
            contentDisposition: String(incoming.headers["content-disposition"] || ""),
            finalUrl: url,
          });
        });
        incoming.on("error", fail);
      });
      request.setTimeout(REMOTE_IMAGE_TIMEOUT_MS, () => {
        request.destroy();
        fail(httpError(504, "The remote image download timed out."));
      });
      request.on("error", fail);
      request.end();
    });
  }

  async function fetchRemoteRelayImage(body) {
    let current = String(body?.url || "").trim();
    for (let redirect = 0; redirect <= MAX_REMOTE_IMAGE_REDIRECTS; redirect++) {
      const target = await publicRemoteTarget(current);
      const result = await requestRemoteImage(target);
      if (result.redirect) {
        if (redirect === MAX_REMOTE_IMAGE_REDIRECTS) {
          throw httpError(502, "The remote image redirected too many times.");
        }
        current = result.redirect;
        continue;
      }
      let pathName = result.finalUrl.pathname.split("/").pop() || "";
      try { pathName = decodeURIComponent(pathName); } catch {}
      return storeRelayImageData(result.data, {
        declaredMime: result.declaredMime,
        name: body?.name || pathName || "viewcoder-remote-image",
        source: "remote",
      });
    }
    throw httpError(502, "The remote image could not be downloaded.");
  }

  function storeRelayImageData(data, options = {}) {
    if (!Buffer.isBuffer(data)) data = Buffer.from(data || []);
    if (!data.length) throw httpError(400, "The relayed image is empty.");
    if (data.length > MAX_RELAY_IMAGE_BYTES) {
      throw httpError(
        413,
        `The relayed image exceeds the ${Math.floor(MAX_RELAY_IMAGE_BYTES / 1_000_000)} MB limit.`,
      );
    }
    const mimeType = imageMimeFromBytes(data);
    if (!mimeType) {
      throw httpError(415, "ViewCoder accepts PNG, JPEG, GIF, and WebP image data only.");
    }
    const declaredMime = String(options.declaredMime || "").toLowerCase().trim();
    if (declaredMime && declaredMime.startsWith("image/") && declaredMime !== mimeType && !(
      declaredMime === "image/jpg" && mimeType === "image/jpeg"
    )) {
      throw httpError(415, "The image type does not match its file contents.");
    }
    pruneRelayImages();
    const id = crypto.randomBytes(18).toString("base64url");
    const now = Date.now();
    const image = {
      id,
      data,
      mimeType,
      name: safeRelayImageName(options.name, mimeType),
      source: options.source || "browser",
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: now + RELAY_IMAGE_TTL_MS,
    };
    relayImages.set(id, image);
    pruneRelayImages();
    log(`Relayed ${image.source} image ${image.name} (${image.data.length} bytes).`, "view");
    return image;
  }

  function storeRelayImage(body) {
    let encoded = String(body?.data || body?.dataUrl || "").trim();
    let declaredMime = String(body?.mimeType || "").toLowerCase().trim();
    const dataUrl = encoded.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
    if (dataUrl) {
      declaredMime = declaredMime || dataUrl[1].toLowerCase();
      encoded = dataUrl[2];
    }
    encoded = encoded.replace(/\s+/g, "");
    if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw httpError(400, "The relayed image is not valid base64 data.");
    }
    const data = Buffer.from(encoded, "base64");
    return storeRelayImageData(data, {
      declaredMime,
      name: body?.name,
      source: "browser",
    });
  }

  function safeParseJson(value) {
    try {
      return JSON.parse(String(value || ""));
    } catch {
      return null;
    }
  }

  async function fileExists(file) {
    try {
      const stat = await fs.stat(file);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async function anyFileExists(files) {
    for (const file of files) {
      if (await fileExists(file)) return true;
    }
    return false;
  }

  function trimMap(map, maximum) {
    while (map.size > maximum) {
      map.delete(map.keys().next().value);
    }
  }

  function numberFromEnvironment(name, fallback) {
    const parsed = Number(process.env[name]);
    return Number.isInteger(parsed) &&
      parsed > 0 &&
      parsed < 65_536
      ? parsed
      : fallback;
  }

  function delay(milliseconds) {
    return new Promise((resolve) =>
      setTimeout(resolve, milliseconds),
    );
  }

  function log(message, level = "info") {
    const prefixes = {
      success: "[ready]",
      warning: "[wait] ",
      error: "[error]",
      detail: "[mcp]  ",
      info: "[view] ",
    };
    const timestamp = new Date().toLocaleTimeString();
    const colors = {
      success: 32,
      warning: 33,
      error: 31,
      detail: 90,
      info: 36,
    };
    console.log(
      paint(
        colors[level] || colors.info,
        `${timestamp} ${prefixes[level] || prefixes.info}`,
      ) + ` ${message}`,
    );
  }

  function printBanner() {
    console.log("");
    console.log(paint(36, "[1/3] Node.js ready"));
    if (blenderMcp.enabled()) {
      console.log(
        paint(36, "[optional] Blender MCP connection enabled"),
      );
    }
    console.log(
      paint(36, `[2/3] Browser bridge listening on ${HOST}:${PORT}`),
    );
    console.log(paint(36, "[3/3] Connecting Roblox Studio MCP…"));
    console.log("");
    console.log(
      paint(
        36,
        "########################################################",
      ),
    );
    console.log(
      paint(36, "##") +
        "  KEEP THIS TERMINAL OPEN WHILE USING VIEWCODER  " +
        paint(36, "##"),
    );
    console.log(
      paint(36, "##") +
        "  Minimize this window; closing it stops the bridge. " +
        paint(36, "##"),
    );
    console.log(
      paint(
        36,
        "########################################################",
      ),
    );
    console.log("");
    console.log(
      paint(36, `ViewCoder Bridge v${VERSION}`) +
        " — Roblox Studio — " +
        paint(90, `http://${HOST}:${PORT}`),
    );
    console.log("");
  }

  function paint(code, value) {
    if (!process.stdout.isTTY || process.env.NO_COLOR) {
      return String(value);
    }
    return `\u001b[${code}m${value}\u001b[0m`;
  }

  function printStudioHelp() {
    console.log("");
    console.log("  ACTION NEEDED");
    console.log("  1. Open a place in Roblox Studio.");
    console.log(
      "  2. Assistant > ... > Manage MCP Servers.",
    );
    console.log("  3. Enable Studio as MCP server.");
    console.log("");
  }

  function printBlenderHelp() {
    console.log("");
    console.log("  OPTIONAL BLENDER CONNECTION");
    console.log("  1. Install uv and the Blender MCP add-on.");
    console.log("  2. Open Blender > 3D View > BlenderMCP.");
    console.log("  3. Start the MCP server on port 9876.");
    console.log("");
  }

  async function shutdown() {
    if (shutdownStarted) return;
    shutdownStarted = true;
    clearInterval(connectionTimer);
    clearInterval(addonConnectionTimer);
    clearInterval(probeTimer);
    log("Stopping ViewCoder bridge…", "info");
    await Promise.allSettled([
      mcp.stop(),
      ...Object.values(addonClients).map((client) => client.stop()),
    ]);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  }
})().catch((error) => {
  console.error(
    `[ViewCoder fatal] ${
      error instanceof Error ? error.stack : String(error)
    }`,
  );
  process.exitCode = 1;
});
