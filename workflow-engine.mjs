import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const MAX_WORKFLOW_STEPS = 100;
const MAX_BATCH_CALLS = 50;
const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;
const MAX_CONTEXT_ENTRIES = 2_000;
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const AI_UI_STYLE_REFERENCE_FILES = Object.freeze([
  "01-shop.png",
  "02-daily-rewards.png",
  "03-index.png",
  "04-season-pass.png",
  "05-rebirth.png",
  "06-stock-shop.png",
  "07-ui-pack.png",
]);
const GENERIC_ICON_TERMS = new Set([
  "a", "an", "and", "asset", "button", "for", "game", "graphic", "icon",
  "image", "in", "of", "or", "the", "to", "ui",
]);
const STYLE_ONLY_ICON_TERMS = new Set([
  "black", "blue", "bright", "cartoon", "clean", "colorful", "colourful",
  "cute", "dark", "flat", "gameui", "gold", "green", "minimal", "orange",
  "pastel", "polished", "purple", "red", "realistic", "silver", "spooky",
  "stylized", "white", "yellow",
]);
// Every catalog entry is searched through the same concept graph. These are
// broad object families, not per-icon exceptions: a request can use a natural
// role ("shop"), a container ("basket"), a material ("timber"), or a related
// game concept and still reach the closest bundled asset.
const ICON_CONCEPT_GROUPS = Object.freeze([
  ["shop", "store", "market", "merchant", "storefront", "basket", "cart", "trolley", "checkout", "buy", "purchase", "sell", "trade", "bag"],
  ["basket", "bag", "tote", "pouch", "satchel", "backpack", "inventory", "storage", "suitcase", "case"],
  ["money", "cash", "currency", "coin", "wallet", "bank", "safe", "vault", "piggybank"],
  ["loot", "reward", "treasure", "prize", "gift", "present", "chest", "crate", "box", "block", "lucky"],
  ["food", "meal", "produce", "fruit", "vegetable", "bread", "burger", "apple", "banana", "corn", "carrot"],
  ["dessert", "sweet", "sweets", "candy", "cake", "cookie", "donut", "cupcake", "chocolate", "pastry", "bakery"],
  ["drink", "beverage", "water", "juice", "coffee", "tea", "bottle", "cup"],
  ["meat", "protein", "chicken", "fish", "egg", "steak"],
  ["material", "resource", "ore", "mineral", "stone", "rock", "metal", "iron", "gold"],
  ["wood", "timber", "lumber", "log", "stump", "tree"],
  ["fabric", "textile", "cloth", "cotton", "wool"],
  ["premium", "gem", "jewel", "crystal", "sapphire", "topaz", "diamond"],
  ["book", "knowledge", "scroll", "paper"],
  ["magic", "fantasy", "wand", "potion", "mushroom", "crystal"],
  ["energy", "power", "battery", "lightning", "flame", "fire"],
  ["animal", "pet", "creature", "cow", "pig", "chicken", "fish"],
  ["halloween", "spooky", "pumpkin", "ghost", "skull", "witch", "bat", "candy"],
  ["christmas", "holiday", "festive", "gift", "present", "snow", "tree"],
  ["farm", "farming", "agriculture", "crop", "harvest", "fruit", "vegetable", "animal"],
  ["decoration", "decor", "ornament", "ribbon", "bow", "star"],
]);

// Keep commerce controls distinct from currency indicators. A Shop or Cart
// request should choose a storefront/basket/cart icon when one exists, never
// a coin or wallet merely because both belong to an economy-related UI.
const COMMERCE_ICON_TERMS = new Set([
  "shop", "store", "market", "merchant", "storefront", "basket", "cart",
  "trolley", "checkout", "buy", "purchase", "sell", "trade",
]);
const CURRENCY_ICON_TERMS = new Set([
  "money", "cash", "currency", "coin", "wallet", "bank", "safe", "vault",
  "piggybank", "gem", "gems", "jewel", "jewels", "crystal", "crystals",
]);

const READ_ONLY_NAME = /(?:^|\/)(?:get|list|search|inspect|read|find|query|check|status|poll|wait|grep|preview|capture|analy[sz]e|diagnose|validate|verify)(?:_|$)/i;
const MUTATION_NAME = /(?:^|\/)(?:set|create|insert|upload|delete|remove|destroy|edit|write|execute|generate|import|start|stop|move|rename|update|apply|run)(?:_|$)/i;
const PATH_KEY = /(?:^|_)(?:path|script_path|instance_path|parent_path|target_path)$/i;

const ICON_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function iconPngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const output = Buffer.alloc(12 + body.length);
  output.writeUInt32BE(body.length, 0);
  typeBuffer.copy(output, 4);
  body.copy(output, 8);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([typeBuffer, body])) {
    crc = ICON_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + body.length);
  return output;
}

function encodeIconPng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    rows[rowOffset] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(rows, rowOffset + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    iconPngChunk("IHDR", header),
    iconPngChunk("IDAT", deflateSync(rows, { level: 9 })),
    iconPngChunk("IEND"),
  ]);
}

function iconSpecNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function iconSpecColor(value, fallback = "#5ea7ff") {
  let text = String(value || fallback).trim().toLowerCase();
  if (/^#[0-9a-f]{3,4}$/.test(text)) {
    text = "#" + [...text.slice(1)].map((digit) => digit + digit).join("");
  }
  if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(text)) {
    text = String(fallback).trim().toLowerCase();
  }
  const hex = text.slice(1);
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
    hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255,
  ];
}

function normalizeIconSpecLayer(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw errorWithCode("INVALID_ICON_SPEC", "Every icon_spec layer must be an object.");
  }
  const shape = String(raw.shape || raw.type || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!["ellipse", "rounded_rect", "polygon", "capsule"].includes(shape)) {
    throw errorWithCode("INVALID_ICON_SPEC", "Layer " + (index + 1) + " uses an unsupported shape. Use ellipse, rounded_rect, polygon, or capsule.");
  }
  const fill = iconSpecColor(raw.fill || raw.color, "#5ea7ff");
  const common = {
    shape,
    fill,
    outline: raw.outline === false || raw.outline === "none" ? null : iconSpecColor(raw.outline, "#15243a"),
    outlineWidth: iconSpecNumber(raw.outline_width, 0.9, 0, 6),
    rotation: iconSpecNumber(raw.rotation, 0, -360, 360),
    opacity: iconSpecNumber(raw.opacity, 1, 0, 1) * (fill[3] / 255),
    shadow: iconSpecNumber(raw.shadow, 0.22, 0, 0.8),
    depth: iconSpecNumber(raw.depth, 0.18, 0, 0.6),
    highlight: iconSpecNumber(raw.highlight, 0.22, 0, 0.8),
    texture: iconSpecNumber(raw.texture, 0.045, 0, 0.3),
    operation: String(raw.operation || "paint").toLowerCase() === "cutout" ? "cutout" : "paint",
  };
  if (shape === "ellipse" || shape === "rounded_rect") {
    const width = iconSpecNumber(raw.width ?? raw.w, 40, 1, 160);
    const height = iconSpecNumber(raw.height ?? raw.h, 40, 1, 160);
    return {
      ...common,
      cx: iconSpecNumber(raw.cx ?? raw.x, 50, -50, 150),
      cy: iconSpecNumber(raw.cy ?? raw.y, 50, -50, 150),
      width,
      height,
      radius: iconSpecNumber(raw.radius, Math.min(width, height) * 0.22, 0, Math.min(width, height) / 2),
    };
  }
  if (shape === "capsule") {
    return {
      ...common,
      x1: iconSpecNumber(raw.x1, 25, -50, 150),
      y1: iconSpecNumber(raw.y1, 75, -50, 150),
      x2: iconSpecNumber(raw.x2, 75, -50, 150),
      y2: iconSpecNumber(raw.y2, 25, -50, 150),
      width: iconSpecNumber(raw.width ?? raw.w, 14, 1, 100),
    };
  }
  if (!Array.isArray(raw.points) || raw.points.length < 3 || raw.points.length > 20) {
    throw errorWithCode("INVALID_ICON_SPEC", "Polygon layer " + (index + 1) + " requires 3 to 20 [x,y] points.");
  }
  const points = raw.points.map((point) => {
    if (!Array.isArray(point) || point.length < 2) {
      throw errorWithCode("INVALID_ICON_SPEC", "Every polygon point must be an [x,y] pair.");
    }
    return [
      iconSpecNumber(point[0], 50, -50, 150),
      iconSpecNumber(point[1], 50, -50, 150),
    ];
  });
  return { ...common, points };
}

function rotateIconPoint(x, y, cx, cy, degrees) {
  if (!degrees) return [x, y];
  const radians = -degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * cosine - dy * sine, cy + dx * sine + dy * cosine];
}

function iconSpecContains(layer, x, y) {
  if (layer.shape === "ellipse" || layer.shape === "rounded_rect") {
    [x, y] = rotateIconPoint(x, y, layer.cx, layer.cy, layer.rotation);
    const dx = x - layer.cx;
    const dy = y - layer.cy;
    if (layer.shape === "ellipse") {
      return (dx * dx) / ((layer.width / 2) ** 2) + (dy * dy) / ((layer.height / 2) ** 2) <= 1;
    }
    const radius = layer.radius;
    const qx = Math.abs(dx) - (layer.width / 2 - radius);
    const qy = Math.abs(dy) - (layer.height / 2 - radius);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= radius;
  }
  if (layer.shape === "capsule") {
    const dx = layer.x2 - layer.x1;
    const dy = layer.y2 - layer.y1;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared
      ? Math.max(0, Math.min(1, ((x - layer.x1) * dx + (y - layer.y1) * dy) / lengthSquared))
      : 0;
    const px = layer.x1 + t * dx;
    const py = layer.y1 + t * dy;
    return Math.hypot(x - px, y - py) <= layer.width / 2;
  }
  const center = layer.points.reduce((total, point) => [total[0] + point[0], total[1] + point[1]], [0, 0])
    .map((value) => value / layer.points.length);
  [x, y] = rotateIconPoint(x, y, center[0], center[1], layer.rotation);
  let inside = false;
  for (let current = 0, previous = layer.points.length - 1; current < layer.points.length; previous = current++) {
    const a = layer.points[current];
    const b = layer.points[previous];
    const crosses = (a[1] > y) !== (b[1] > y) &&
      x < ((b[0] - a[0]) * (y - a[1])) / ((b[1] - a[1]) || Number.EPSILON) + a[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

function blendIconPixel(rgba, offset, red, green, blue, alpha) {
  const sourceAlpha = Math.max(0, Math.min(1, alpha));
  if (sourceAlpha <= 0) return;
  const destinationAlpha = rgba[offset + 3] / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) return;
  rgba[offset] = Math.round((red * sourceAlpha + rgba[offset] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  rgba[offset + 1] = Math.round((green * sourceAlpha + rgba[offset + 1] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  rgba[offset + 2] = Math.round((blue * sourceAlpha + rgba[offset + 2] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  rgba[offset + 3] = Math.round(outputAlpha * 255);
}

function iconTextureNoise(x, y, seed) {
  let value = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  value = (value ^ (value >>> 13)) * 1274126177;
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function renderVectorIconPng(spec, requestedSize) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw errorWithCode("INVALID_ICON_SPEC", "icon_spec must be an object with a layers array.");
  }
  if (!Array.isArray(spec.layers) || spec.layers.length < 1 || spec.layers.length > 32) {
    throw errorWithCode("INVALID_ICON_SPEC", "icon_spec.layers must contain 1 to 32 simple vector layers.");
  }
  const size = Math.round(iconSpecNumber(requestedSize, 512, 128, 768));
  const layers = spec.layers.map(normalizeIconSpecLayer);
  const rgba = new Uint8Array(size * size * 4);
  const samples = [[0.22, 0.22], [0.78, 0.22], [0.22, 0.78], [0.78, 0.78]];

  for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
    const layer = layers[layerIndex];
    const mask = new Uint8Array(size * size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let covered = 0;
        for (const [sampleX, sampleY] of samples) {
          if (iconSpecContains(layer, (x + sampleX) * 100 / size, (y + sampleY) * 100 / size)) covered += 1;
        }
        mask[y * size + x] = Math.round(covered * 255 / samples.length);
      }
    }

    if (layer.operation === "cutout") {
      for (let pixel = 0; pixel < mask.length; pixel += 1) {
        if (!mask[pixel]) continue;
        const offset = pixel * 4;
        rgba[offset + 3] = Math.round(rgba[offset + 3] * (1 - (mask[pixel] / 255) * layer.opacity));
        if (!rgba[offset + 3]) rgba.fill(0, offset, offset + 4);
      }
      continue;
    }

    const shadowOffsetX = Math.max(1, Math.round(size * 0.022));
    const shadowOffsetY = Math.max(1, Math.round(size * 0.032));
    const blur = Math.max(1, Math.round(size * 0.009));
    if (layer.shadow > 0) {
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          let total = 0;
          let count = 0;
          for (const by of [-blur, 0, blur]) {
            for (const bx of [-blur, 0, blur]) {
              const sx = x - shadowOffsetX + bx;
              const sy = y - shadowOffsetY + by;
              if (sx >= 0 && sx < size && sy >= 0 && sy < size) total += mask[sy * size + sx];
              count += 1;
            }
          }
          const alpha = (total / (count * 255)) * layer.shadow * layer.opacity;
          blendIconPixel(rgba, (y * size + x) * 4, 13, 22, 36, alpha);
        }
      }
    }

    const outlinePixels = Math.max(0, Math.round(layer.outlineWidth * size / 100));
    if (layer.outline && outlinePixels > 0) {
      const [red, green, blue, colorAlpha] = layer.outline;
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const pixel = y * size + x;
          let expanded = mask[pixel];
          for (const [dx, dy] of [[outlinePixels, 0], [-outlinePixels, 0], [0, outlinePixels], [0, -outlinePixels], [outlinePixels, outlinePixels], [-outlinePixels, outlinePixels], [outlinePixels, -outlinePixels], [-outlinePixels, -outlinePixels]]) {
            const sx = x + dx;
            const sy = y + dy;
            if (sx >= 0 && sx < size && sy >= 0 && sy < size) expanded = Math.max(expanded, mask[sy * size + sx]);
          }
          if (expanded <= mask[pixel]) continue;
          blendIconPixel(rgba, pixel * 4, red, green, blue, ((expanded - mask[pixel]) / 255) * layer.opacity * (colorAlpha / 255));
        }
      }
    }

    const [baseRed, baseGreen, baseBlue] = layer.fill;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const pixel = y * size + x;
        const coverage = mask[pixel] / 255;
        if (!coverage) continue;
        const lightDirection = ((1 - x / size) * 0.42 + (1 - y / size) * 0.58) - 0.5;
        const depthDirection = (x / size) * 0.34 + (y / size) * 0.66;
        const noise = (iconTextureNoise(x, y, layerIndex + 1) - 0.5) * 2 * layer.texture;
        const shade = Math.max(0.55, Math.min(1.35, 1 + lightDirection * layer.highlight - depthDirection * layer.depth + noise));
        blendIconPixel(
          rgba,
          pixel * 4,
          Math.max(0, Math.min(255, Math.round(baseRed * shade))),
          Math.max(0, Math.min(255, Math.round(baseGreen * shade))),
          Math.max(0, Math.min(255, Math.round(baseBlue * shade))),
          coverage * layer.opacity,
        );
        const highlightX = Math.max(0, x - Math.max(1, outlinePixels));
        const highlightY = Math.max(0, y - Math.max(1, outlinePixels));
        const edge = Math.max(0, mask[pixel] - mask[highlightY * size + highlightX]) / 255;
        if (edge) blendIconPixel(rgba, pixel * 4, 255, 255, 255, edge * layer.highlight * 0.55 * layer.opacity);
      }
    }
  }

  return { buffer: encodeIconPng(size, size, rgba), width: size, height: size };
}

export const VIEWCODER_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "viewcoder/get_capabilities",
    server: "viewcoder",
    serverLabel: "ViewCoder",
    description:
      "Return the complete live MCP command catalog and ViewCoder orchestration limits. Use this when choosing between Roblox Studio, Blender, or another connected command.",
    inputSchema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Optional server id to filter. Omit for every connected server.",
        },
        include_schemas: {
          type: "boolean",
          description: "Include full JSON input schemas. Defaults to true.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "viewcoder/run_workflow",
    server: "viewcoder",
    serverLabel: "ViewCoder",
    description:
      "Run up to 100 MCP actions as one observable workflow with variables, conditions, bounded retries, explicit rollback actions, verification, timeouts, and a structured final report. Native MCP schemas remain authoritative.",
    inputSchema: {
      type: "object",
      required: ["steps"],
      properties: {
        name: { type: "string", maxLength: 120 },
        project_id: {
          type: "string",
          description: "Optional stable project id. Normally ViewCoder derives it from the connected project.",
        },
        variables: { type: "object", additionalProperties: true },
        stop_on_error: { type: "boolean", default: true },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: MAX_WORKFLOW_STEPS,
          items: {
            type: "object",
            required: ["id", "tool"],
            properties: {
              id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
              tool: { type: "string" },
              arguments: { type: "object", additionalProperties: true },
              save_as: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,95}$" },
              when: { description: "Boolean or a condition object using ref/equals/not_equals/exists/truthy." },
              retries: { type: "integer", minimum: 0, maximum: MAX_RETRIES },
              timeout_ms: { type: "integer", minimum: 1_000, maximum: MAX_TIMEOUT_MS },
              safe_to_retry: {
                type: "boolean",
                description: "Required to retry a mutation after an uncertain timeout.",
              },
              on_error: { type: "string", enum: ["stop", "continue", "rollback"] },
              rollback: {
                type: "object",
                required: ["tool"],
                properties: {
                  tool: { type: "string" },
                  arguments: { type: "object", additionalProperties: true },
                },
              },
              verify: {
                type: "object",
                required: ["tool"],
                properties: {
                  tool: { type: "string" },
                  arguments: { type: "object", additionalProperties: true },
                  expect: { description: "Condition evaluated against verification.value." },
                  timeout_ms: { type: "integer", minimum: 1_000, maximum: MAX_TIMEOUT_MS },
                },
              },
            },
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "viewcoder/batch_read",
    server: "viewcoder",
    serverLabel: "ViewCoder",
    description:
      "Run up to 50 independently read-only MCP calls concurrently and return every result in input order. Mutating or ambiguous commands are rejected; use run_workflow for changes.",
    inputSchema: {
      type: "object",
      required: ["calls"],
      properties: {
        concurrency: { type: "integer", minimum: 1, maximum: 10, default: 4 },
        calls: {
          type: "array",
          minItems: 1,
          maxItems: MAX_BATCH_CALLS,
          items: {
            type: "object",
            required: ["id", "tool"],
            properties: {
              id: { type: "string" },
              tool: { type: "string" },
              arguments: { type: "object", additionalProperties: true },
              timeout_ms: { type: "integer", minimum: 1_000, maximum: MAX_TIMEOUT_MS },
            },
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "viewcoder/project_context",
    server: "viewcoder",
    serverLabel: "ViewCoder",
    description:
      "Read or update ViewCoder's local, machine-readable project index. It stores only supplied or workflow-verified facts and supports lexical search plus dependency graphs without replacing the live project as source of truth.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["status", "get", "remember", "search", "graph", "clear"] },
        project_id: { type: "string" },
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        confirm: { type: "boolean" },
        entries: {
          type: "array",
          maxItems: 200,
          items: {
            type: "object",
            required: ["summary"],
            properties: {
              id: { type: "string" },
              kind: { type: "string" },
              path: { type: "string" },
              summary: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              dependencies: { type: "array", items: { type: "string" } },
              verified: { type: "boolean" },
              source: { type: "string" },
            },
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "viewcoder/score_assets",
    server: "viewcoder",
    serverLabel: "ViewCoder",
    description:
      "Deterministically rank supplied asset candidates using explicit quality, safety, compatibility, complexity, and recency metadata. This does not download or execute assets.",
    inputSchema: {
      type: "object",
      required: ["assets"],
      properties: {
        max_parts: { type: "integer", minimum: 1 },
        require_animated: { type: "boolean" },
        require_r15: { type: "boolean" },
        reject_scripts: { type: "boolean", default: true },
        assets: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: {
            type: "object",
            required: ["id"],
            additionalProperties: true,
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "viewcoder/find_game_icons",
    server: "viewcoder",
    serverLabel: "ViewCoder",
    description:
      "Deep-search ViewCoder's complete unpacked icon library for a game UI concept. The search recursively checks every pack, expands synonyms and singular/plural forms, tolerates one-character spelling mistakes, and ranks only meaningfully related icons. On no_match, image-capable AIs may generate the exact concept; text-only AIs continue without an icon. Never substitute an unrelated library object.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 160,
          description: "The actual object or concept needed, such as apple, money bag, pumpkin, or candy cane.",
        },
        style: {
          type: "string",
          maxLength: 120,
          description: "Optional visual style. An exact value returned in availableStyles strictly filters semantic matches; other values remain user-directed generation style rather than invented library metadata.",
        },
        game_theme: {
          type: "string",
          maxLength: 120,
          description: "Optional game theme. Used only to rank semantically valid matches.",
        },
        category: {
          type: "string",
          maxLength: 80,
          description: "Optional exact library category id to restrict the search.",
        },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        publish: {
          type: "boolean",
          default: true,
          description: "Publish each selected local icon through the bridge so upload_image can read it.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "viewcoder/generate_icon",
    description: "Relay and upload one standalone object icon for Roblox UI. With AI Generated UI on, THIS CHAT AI must first create the real transparent PNG using its own native image generator, then pass the captured generated_image_url here. With AI Generated UI off or unavailable, set library_only=true only when an icon is suitable and use a semantically matching bundled preset.",
    inputSchema: {
      type: "object",
      required: ["concept"],
      properties: {
        concept: { type: "string" },
        description: { type: "string" },
        style: { type: "string" },
        game_theme: { type: "string" },
        size: { type: "integer", minimum: 16, maximum: 2048 },
        generated_image_url: {
          type: "string",
          description: "A finished PNG already produced by THIS CHAT AI's own native image generator and captured by ViewCoder. It must contain one isolated component with real transparent alpha and NO BACKGROUND AT ALL; every pixel outside the component must be fully transparent (alpha 0).",
        },
        library_only: {
          type: "boolean",
          default: false,
          description: "Use only a genuine semantic match from the bundled icon library. ViewCoder sets this when AI Generated UI is off or unavailable; no image generator or local vector renderer is attempted.",
        },
        icon_spec: {
          type: "object",
          description: "Legacy local vector input for direct bridge clients only. Chat AIs must never send this; image-capable chat AIs generate the PNG themselves and library-only chat AIs choose a suitable preset or omit the icon.",
          required: ["layers"],
          properties: {
            layers: {
              type: "array",
              minItems: 1,
              maxItems: 32,
              items: {
                type: "object",
                description: "A simple ellipse, rounded_rect, polygon, or capsule. For ellipse/rounded_rect use cx, cy, width, height and optional radius/rotation. For polygon use points [[x,y],...]. For capsule use x1,y1,x2,y2,width. fill is a hex color; optional outline, outline_width, shadow, depth, highlight, texture, opacity, and operation=paint|cutout refine the result.",
                additionalProperties: true,
              },
            },
          },
          additionalProperties: false,
        },
        required: { type: "boolean", default: true },
        upload_to_roblox: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "viewcoder/generate_ui_image",
    description: "Relay and upload exactly one separate Roblox UI component after THIS CHAT AI has created it with its own native image generator. Pass the captured generated_image_url; ViewCoder itself does not generate the image. Never flatten a complete menu, shop, screen, collage, multiple buttons, or multiple interaction states into one image.",
    inputSchema: {
      type: "object",
      required: ["description"],
      properties: {
        description: { type: "string" },
        component_name: { type: "string", description: "Stable name for this one component." },
        component_type: { type: "string", description: "One component type, for example panel, header, button, tab, badge, or icon." },
        dimensions: { type: "string", description: "Explicit target dimensions or aspect ratio for this component." },
        interaction_state: { type: "string", description: "At most one state for this asset, such as normal, hover, or pressed. Generate other states in separate calls." },
        component_family: { type: "string", description: "Shared family/style identifier used to keep separately generated components visually cohesive." },
        style: { type: "string" },
        game_theme: { type: "string" },
        required_icons: { type: "array", items: { type: "string" }, description: "Deprecated compatibility field. Do not combine multiple icons into this component." },
        generated_image_url: { type: "string", description: "The finished transparent PNG created by THIS CHAT AI's own native image generator and captured by ViewCoder." },
        allow_iconless: { type: "boolean", default: false },
        upload_to_roblox: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "viewcoder/slice_ui_sheet",
    description: "Legacy utility for a user-supplied existing sheet only. Never generate a new AI Generated UI sheet; new panels, buttons, icons, and states must be generated separately.",
    inputSchema: {
      type: "object",
      required: ["sheet_url", "regions"],
      properties: {
        sheet_url: { type: "string" },
        regions: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["name", "x", "y", "width", "height"],
            properties: {
              name: { type: "string" },
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
            },
          },
        },
      },
    },
  },
  {
    name: "viewcoder/build_roblox_ui",
    description: "Build Roblox UI only after required visuals resolve, then verify the connected Studio tool result before reporting success.",
    inputSchema: {
      type: "object",
      required: ["description"],
      properties: {
        description: { type: "string" },
        style: { type: "string" },
        required_icons: { type: "array", items: { type: "string" } },
        resolved_icons: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
        library_only: {
          type: "boolean",
          default: false,
          description: "Resolve any still-missing icons from semantically matching bundled presets only. ViewCoder sets this when AI Generated UI is off or unavailable.",
        },
        luau: { type: "string" },
        verify: { type: "boolean", default: true },
      },
    },
  },
]);

function toolServerId(tool) {
  const explicit = String(tool?.server || "").trim();
  if (explicit) return explicit;
  return String(tool?.name || "").startsWith("viewcoder/") ? "viewcoder" : "unknown";
}

function publicTool(tool, includeSchemas = true) {
  const server = toolServerId(tool);
  return {
    name: String(tool?.name || ""),
    server,
    serverLabel: String(tool?.serverLabel || (server === "viewcoder" ? "ViewCoder" : tool?.server) || "Unknown"),
    description: String(tool?.description || ""),
    ...(includeSchemas ? { inputSchema: tool?.inputSchema || { type: "object" } } : {}),
  };
}

function errorWithCode(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function iconTerms(value, { semantic = false } = {}) {
  const words = String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !GENERIC_ICON_TERMS.has(word));
  return [...new Set(semantic ? words.filter((word) => !STYLE_ONLY_ICON_TERMS.has(word)) : words)];
}

function iconPhrase(value) {
  return iconTerms(value).join(" ");
}

function iconWordForms(value) {
  const term = String(value || "").toLowerCase();
  if (!term) return [];
  const forms = new Set([term]);
  if (term.endsWith("ies") && term.length > 4) forms.add(term.slice(0, -3) + "y");
  else if (/(?:ches|shes|sses|xes|zes)$/.test(term) && term.length > 4) forms.add(term.slice(0, -2));
  else if (term.endsWith("s") && !term.endsWith("ss") && term.length > 3) forms.add(term.slice(0, -1));
  if (/[^aeiou]y$/.test(term)) forms.add(term.slice(0, -1) + "ies");
  else if (/(?:s|x|z|ch|sh)$/.test(term)) forms.add(term + "es");
  else forms.add(term + "s");
  return [...forms];
}

let iconRelationsCache = null;
function iconRelations() {
  if (iconRelationsCache) return iconRelationsCache;
  const relations = new Map();
  const connect = (left, right) => {
    if (!relations.has(left)) relations.set(left, new Set());
    relations.get(left).add(right);
  };
  for (const family of ICON_CONCEPT_GROUPS) {
    const group = [...new Set(family.flatMap(iconWordForms))];
    for (const left of group) {
      for (const right of group) {
        if (left !== right) connect(left, right);
      }
    }
  }
  iconRelationsCache = relations;
  return relations;
}

function relatedIconTerms(value) {
  const relations = iconRelations();
  const found = new Set(iconWordForms(value));
  for (const term of [...found]) {
    for (const related of relations.get(term) || []) {
      found.add(related);
    }
  }
  return found;
}

function iconEditDistance(left, right, maxDistance) {
  const a = String(left || "");
  const b = String(right || "");
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row++) {
    const current = [row];
    let rowMinimum = row;
    for (let column = 1; column <= b.length; column++) {
      const value = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
      current[column] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[b.length];
}

function nearIconTerm(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return false;
  const maxDistance = Math.max(a.length, b.length) >= 8 ? 2 : 1;
  return iconEditDistance(a, b, maxDistance) <= maxDistance;
}

async function discoverIconFiles(root, current = root, output = []) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await discoverIconFiles(root, fullPath, output);
    } else if (entry.isFile() && /\.(?:gif|jpe?g|png|webp)$/i.test(entry.name)) {
      output.push(path.relative(root, fullPath).split(path.sep).join("/"));
    }
  }
  return output;
}

function containedFile(root, relativePath) {
  const candidate = path.resolve(root, String(relativePath || ""));
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return candidate;
}

function safeProjectKey(projectId) {
  const raw = String(projectId || "local-project").trim() || "local-project";
  const slug = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "project";
  const digest = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `${slug}-${digest}`;
}

function normalizeResult(result) {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const text = typeof result.text === "string" ? result.text : JSON.stringify(result);
    return { ...result, text, images: Array.isArray(result.images) ? result.images : [] };
  }
  return { text: typeof result === "string" ? result : JSON.stringify(result ?? null), images: [] };
}

function resultValue(result) {
  const normalized = normalizeResult(result);
  const trimmed = normalized.text.trim();
  if (trimmed) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Tool text is often intentionally human-readable.
    }
  }
  return normalized.text;
}

function getReference(root, reference) {
  const parts = String(reference || "").split(".").filter(Boolean);
  let value = root;
  for (const part of parts) {
    if (value == null || (typeof value !== "object" && !Array.isArray(value))) return undefined;
    value = value[part];
  }
  return value;
}

function resolveValue(value, scope) {
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, scope));
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && typeof value.$ref === "string") {
      const resolved = getReference(scope, value.$ref);
      if (resolved === undefined) {
        throw errorWithCode("UNRESOLVED_REFERENCE", `Workflow reference "${value.$ref}" does not exist.`);
      }
      return resolved;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, scope)]));
  }
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_match, reference) => {
      const resolved = getReference(scope, reference.trim());
      if (resolved === undefined) {
        throw errorWithCode("UNRESOLVED_REFERENCE", `Workflow reference "${reference.trim()}" does not exist.`);
      }
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    });
  }
  return value;
}

function conditionMatches(condition, scope) {
  if (condition == null) return true;
  if (typeof condition === "boolean") return condition;
  if (typeof condition !== "object" || Array.isArray(condition)) {
    throw errorWithCode("INVALID_CONDITION", "A workflow condition must be a boolean or condition object.");
  }
  const value = condition.ref ? getReference(scope, condition.ref) : condition.value;
  if (Object.hasOwn(condition, "exists")) return condition.exists ? value !== undefined : value === undefined;
  if (Object.hasOwn(condition, "equals")) return JSON.stringify(value) === JSON.stringify(resolveValue(condition.equals, scope));
  if (Object.hasOwn(condition, "not_equals")) return JSON.stringify(value) !== JSON.stringify(resolveValue(condition.not_equals, scope));
  if (Object.hasOwn(condition, "truthy")) return condition.truthy ? Boolean(value) : !value;
  return Boolean(value);
}

function validatePathValues(value, key = "arguments") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validatePathValues(item, `${key}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    if (PATH_KEY.test(childKey) && typeof childValue === "string") {
      if (!childValue.trim() || /[\u0000-\u001f\u007f]/.test(childValue)) {
        throw errorWithCode("INVALID_PATH", `${key}.${childKey} must be one non-empty path without control characters.`);
      }
    }
    validatePathValues(childValue, `${key}.${childKey}`);
  }
}

function isReadOnlyTool(tool) {
  if (tool?.annotations?.readOnlyHint === true) return true;
  const name = String(tool?.name || "");
  if (MUTATION_NAME.test(name)) return false;
  return READ_ONLY_NAME.test(name);
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(errorWithCode("UNCERTAIN_TIMEOUT", `${label} did not return within ${timeoutMs} ms; its final external state is unknown.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function createWorkflowEngine(options = {}) {
  if (typeof options.listTools !== "function" || typeof options.callTool !== "function") {
    throw new TypeError("ViewCoder workflow engine requires listTools and callTool callbacks.");
  }
  const storageRoot = path.resolve(options.storageDir || path.join(process.cwd(), ".viewcoder", "projects"));
  const iconLibraryRoot = path.resolve(
    options.iconLibraryDir || path.join(MODULE_DIRECTORY, "Game Icon Library"),
  );
  let iconCatalogPromise = null;
  let lastNativeTools = [];

  async function iconCatalog() {
    if (!iconCatalogPromise) {
      iconCatalogPromise = fs.readFile(path.join(iconLibraryRoot, "catalog.json"), "utf8")
        .then((source) => JSON.parse(source))
        .then(async (catalog) => {
          if (!catalog || !Array.isArray(catalog.icons)) {
            throw errorWithCode("ICON_CATALOG_INVALID", "The bundled game icon catalog is invalid.");
          }
          const icons = [...catalog.icons];
          const knownPaths = new Set(
            icons.map((icon) => String(icon.relativePath || "").replace(/\\/g, "/").toLowerCase()),
          );
          for (const relativePath of await discoverIconFiles(iconLibraryRoot)) {
            if (relativePath.toLowerCase() === "catalog.json" || knownPaths.has(relativePath.toLowerCase())) {
              continue;
            }
            const parts = relativePath.split("/");
            const fileName = parts[parts.length - 1] || "";
            const rawName = path.basename(fileName, path.extname(fileName))
              .replace(/[_-]+/g, " ")
              .replace(/\bicon\b/gi, " ")
              .replace(/\s+/g, " ")
              .trim();
            const category = parts[0] || "uncategorized";
            icons.push({
              id: "discovered-" + crypto.createHash("sha256").update(relativePath).digest("hex").slice(0, 16),
              name: rawName.replace(/\b\w/g, (character) => character.toUpperCase()) || "Icon",
              category,
              categoryLabel: category.replace(/[-_]+/g, " "),
              pack: parts.length > 2 ? parts[parts.length - 2] : category,
              relativePath,
              tokens: iconTerms(rawName + " " + parts.slice(0, -1).join(" ")),
              styles: [],
              themes: [],
            });
            knownPaths.add(relativePath.toLowerCase());
          }
          return { ...catalog, icons };
        })
        .catch((error) => {
          iconCatalogPromise = null;
          if (error?.code === "ENOENT") {
            throw errorWithCode(
              "ICON_LIBRARY_UNAVAILABLE",
              "The unpacked Game Icon Library is missing. Restore it from the full ViewCoder setup.",
            );
          }
          throw error;
        });
    }
    return iconCatalogPromise;
  }

  async function currentProjectId(explicit) {
    if (String(explicit || "").trim()) return String(explicit).trim();
    const derived = typeof options.getProjectId === "function" ? await options.getProjectId() : "local-project";
    return String(derived || "local-project").trim() || "local-project";
  }

  async function readStore(projectId) {
    const id = await currentProjectId(projectId);
    const file = path.join(storageRoot, `${safeProjectKey(id)}.json`);
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      return { file, data: { version: 1, projectId: id, entries: [], changes: [], ...parsed, projectId: id } };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return { file, data: { version: 1, projectId: id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), entries: [], changes: [] } };
    }
  }

  async function writeStore(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const output = { ...data, updatedAt: new Date().toISOString() };
    await fs.writeFile(file, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    return output;
  }

  async function appendVerifiedChange(projectId, change) {
    const { file, data } = await readStore(projectId);
    data.changes.push({ id: crypto.randomUUID(), verified: true, at: new Date().toISOString(), ...change });
    if (data.changes.length > 500) data.changes = data.changes.slice(-500);
    await writeStore(file, data);
  }

  async function capabilities(args) {
    const includeSchemas = args.include_schemas !== false;
    const serverFilter = String(args.server || "").trim();
    const requestedServer = /^(?:all|any|\*)$/i.test(serverFilter) ? "" : serverFilter;
    const tools = [...(await nativeTools()), ...VIEWCODER_TOOL_DEFINITIONS]
      .filter((tool) => !requestedServer || toolServerId(tool) === requestedServer)
      .map((tool) => publicTool(tool, includeSchemas));
    const servers = [...new Map(tools.map((tool) => [tool.server, tool.serverLabel])).entries()].map(([id, label]) => ({ id, label, tools: tools.filter((tool) => tool.server === id).length }));
    return {
      text: JSON.stringify({
        ok: true,
        live: true,
        capturedAt: new Date().toISOString(),
        toolCount: tools.length,
        servers,
        tools,
        orchestration: {
          maxWorkflowSteps: MAX_WORKFLOW_STEPS,
          maxBatchReads: MAX_BATCH_CALLS,
          retries: `0-${MAX_RETRIES}`,
          supports: ["variables", "conditions", "timeouts", "explicit rollback", "verification", "structured reports", "local project context"],
          nativeDependent: ["AST-aware edits", "simulation", "performance analysis", "asset insertion", "audio operations", "viewport capture"],
        },
        visualPipeline: {
          aiGeneratedUi: {
            output: "one_separate_transparent_png_per_component",
            generatorOwner: "current_chat_ai_native_image_generator",
            nativeAttemptLimit: 8,
            nativeRenderGraceMs: 210000,
            afterAttemptLimit: "switch_ai_generated_ui_off",
            flattenWholeInterface: false,
            localLibraryAllowed: false,
          },
          libraryOnlyMode: {
            enabledWhen: "AI Generated UI is off or unavailable",
            iconDecision: "current_ai_decides_if_suitable",
            role: "optional_semantically_matching_preset_icons_only",
          },
          requiredPng: true,
          requiredTransparentAlpha: true,
          verifiedUploads: true,
          tools: [
            "viewcoder/generate_ui_image",
            "viewcoder/generate_icon",
            "viewcoder/slice_ui_sheet",
            "viewcoder/build_roblox_ui",
          ],
        },
      }),
      images: [],
    };
  }

  async function batchRead(args) {
    const calls = Array.isArray(args.calls) ? args.calls : [];
    if (!calls.length || calls.length > MAX_BATCH_CALLS) throw errorWithCode("INVALID_BATCH", `batch_read requires 1-${MAX_BATCH_CALLS} calls.`);
    const tools = await options.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const ids = new Set();
    for (const call of calls) {
      if (!call?.id || ids.has(call.id)) throw errorWithCode("INVALID_BATCH", "Every batch call needs a unique non-empty id.");
      ids.add(call.id);
      const definition = byName.get(call.tool);
      if (!definition) throw errorWithCode("UNKNOWN_TOOL", `Unknown live MCP command "${call.tool}".`);
      if (!isReadOnlyTool(definition)) throw errorWithCode("MUTATION_NOT_ALLOWED", `"${call.tool}" is not confidently read-only. Use viewcoder/run_workflow instead.`);
      validatePathValues(call.arguments || {});
    }
    const results = await runPool(calls, clampInteger(args.concurrency, 4, 1, 10), async (call) => {
      const started = Date.now();
      try {
        const output = await withTimeout(options.callTool(call.tool, call.arguments || {}, { source: "batch_read", readOnly: true }), clampInteger(call.timeout_ms, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS), call.tool);
        const normalized = normalizeResult(output);
        return { id: call.id, tool: call.tool, ok: true, durationMs: Date.now() - started, value: resultValue(normalized), result: normalized };
      } catch (error) {
        return { id: call.id, tool: call.tool, ok: false, durationMs: Date.now() - started, code: error?.code || "TOOL_ERROR", error: error?.message || String(error) };
      }
    });
    return { text: JSON.stringify({ ok: results.every((item) => item.ok), results }), images: [] };
  }

  async function runWorkflow(args) {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    if (!steps.length || steps.length > MAX_WORKFLOW_STEPS) throw errorWithCode("INVALID_WORKFLOW", `run_workflow requires 1-${MAX_WORKFLOW_STEPS} steps.`);
    const tools = await options.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const ids = new Set();
    for (const step of steps) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(String(step?.id || "")) || ids.has(step.id)) throw errorWithCode("INVALID_WORKFLOW", "Every workflow step needs a unique id beginning with a letter.");
      ids.add(step.id);
      if (!byName.has(step.tool) || String(step.tool).startsWith("viewcoder/")) throw errorWithCode("UNKNOWN_TOOL", `Workflow step "${step.id}" references unavailable native command "${step.tool}".`);
      if (step.rollback && (!byName.has(step.rollback.tool) || String(step.rollback.tool).startsWith("viewcoder/"))) throw errorWithCode("UNKNOWN_TOOL", `Rollback for "${step.id}" references unavailable native command "${step.rollback.tool}".`);
      if (step.verify && (!byName.has(step.verify.tool) || String(step.verify.tool).startsWith("viewcoder/"))) throw errorWithCode("UNKNOWN_TOOL", `Verification for "${step.id}" references unavailable native command "${step.verify.tool}".`);
    }

    const workflowId = crypto.randomUUID();
    const projectId = await currentProjectId(args.project_id);
    const scope = { variables: args.variables && typeof args.variables === "object" ? structuredClone(args.variables) : {}, steps: {}, workflow: { id: workflowId, name: String(args.name || "Workflow") } };
    const report = { workflowId, name: scope.workflow.name, projectId, startedAt: new Date().toISOString(), state: "running", completed: 0, skipped: 0, failed: 0, rolledBack: 0, steps: [], rollbacks: [] };
    const rollbackStack = [];
    const stopOnError = args.stop_on_error !== false;

    const runNative = async (tool, rawArguments, timeoutMs, meta) => {
      const resolvedArguments = resolveValue(rawArguments || {}, scope);
      validatePathValues(resolvedArguments);
      return withTimeout(options.callTool(tool, resolvedArguments, { workflowId, ...meta }), timeoutMs, tool);
    };

    let fatalError = null;
    for (const step of steps) {
      if (!conditionMatches(step.when, scope)) {
        report.skipped += 1;
        report.steps.push({ id: step.id, tool: step.tool, state: "skipped", reason: "condition_false" });
        continue;
      }
      const definition = byName.get(step.tool);
      const readOnly = isReadOnlyTool(definition);
      const maxAttempts = clampInteger(step.retries, 0, 0, MAX_RETRIES) + 1;
      const timeoutMs = clampInteger(step.timeout_ms, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS);
      const stepReport = { id: step.id, tool: step.tool, state: "running", attempts: 0, readOnly, startedAt: new Date().toISOString() };
      report.steps.push(stepReport);
      let output;
      let failure;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        stepReport.attempts = attempt;
        try {
          output = normalizeResult(await runNative(step.tool, step.arguments, timeoutMs, { stepId: step.id, attempt, readOnly }));
          failure = null;
          break;
        } catch (error) {
          failure = error;
          const uncertainMutation = !readOnly && error?.code === "UNCERTAIN_TIMEOUT" && step.safe_to_retry !== true;
          if (uncertainMutation || attempt >= maxAttempts) break;
        }
      }

      if (!failure && step.verify) {
        try {
          const verification = normalizeResult(await runNative(step.verify.tool, step.verify.arguments, clampInteger(step.verify.timeout_ms, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS), { stepId: step.id, verification: true, readOnly: true }));
          const verificationValue = resultValue(verification);
          const verificationScope = { ...scope, result: resultValue(output), verification: { value: verificationValue, result: verification } };
          if (step.verify.expect != null && !conditionMatches(step.verify.expect, verificationScope)) throw errorWithCode("VERIFICATION_FAILED", `Verification for workflow step "${step.id}" did not match its expected condition.`);
          stepReport.verification = { ok: true, tool: step.verify.tool, value: verificationValue };
        } catch (error) {
          failure = error;
          stepReport.verification = { ok: false, tool: step.verify.tool, code: error?.code || "VERIFICATION_ERROR", error: error?.message || String(error) };
        }
      }

      if (!failure) {
        const value = resultValue(output);
        stepReport.state = "succeeded";
        stepReport.completedAt = new Date().toISOString();
        stepReport.value = value;
        scope.steps[step.id] = { ok: true, value, result: output };
        if (step.save_as) scope.variables[step.save_as] = value;
        report.completed += 1;
        if (step.rollback) rollbackStack.push({ stepId: step.id, ...step.rollback });
        if (!readOnly) await appendVerifiedChange(projectId, { workflowId, stepId: step.id, tool: step.tool, summary: `Verified workflow mutation completed with ${step.tool}.` });
        continue;
      }

      stepReport.state = "failed";
      stepReport.completedAt = new Date().toISOString();
      stepReport.code = failure?.code || "TOOL_ERROR";
      stepReport.error = failure?.message || String(failure);
      scope.steps[step.id] = { ok: false, code: stepReport.code, error: stepReport.error };
      report.failed += 1;
      const policy = step.on_error || (stopOnError ? "stop" : "continue");
      if (policy === "continue") continue;
      fatalError = failure;
      if (policy === "rollback") {
        for (const rollback of rollbackStack.reverse()) {
          const item = { stepId: rollback.stepId, tool: rollback.tool, state: "running" };
          report.rollbacks.push(item);
          try {
            const rollbackResult = normalizeResult(await runNative(rollback.tool, rollback.arguments, DEFAULT_TIMEOUT_MS, { rollbackFor: rollback.stepId, readOnly: false }));
            item.state = "succeeded";
            item.value = resultValue(rollbackResult);
            report.rolledBack += 1;
          } catch (error) {
            item.state = "failed";
            item.code = error?.code || "ROLLBACK_ERROR";
            item.error = error?.message || String(error);
          }
        }
      }
      break;
    }

    report.state = fatalError ? (report.rollbacks.some((item) => item.state === "failed") ? "rollback_failed" : report.rollbacks.length ? "rolled_back" : "failed") : report.failed ? "completed_with_errors" : "succeeded";
    report.completedAt = new Date().toISOString();
    report.variables = scope.variables;
    report.summary = `${report.completed} succeeded, ${report.skipped} skipped, ${report.failed} failed${report.rollbacks.length ? `, ${report.rolledBack}/${report.rollbacks.length} rollbacks succeeded` : ""}.`;
    return { text: JSON.stringify(report), images: [] };
  }

  async function projectContext(args) {
    const { file, data } = await readStore(args.project_id);
    const action = String(args.action || "status");
    if (action === "status") return { text: JSON.stringify({ ok: true, projectId: data.projectId, entries: data.entries.length, verifiedChanges: data.changes.length, updatedAt: data.updatedAt || data.createdAt }), images: [] };
    if (action === "get") return { text: JSON.stringify({ ok: true, project: data }), images: [] };
    if (action === "remember") {
      const entries = Array.isArray(args.entries) ? args.entries : [];
      if (!entries.length) throw errorWithCode("INVALID_CONTEXT", "remember requires at least one context entry.");
      for (const raw of entries) {
        const summary = String(raw.summary || "").trim();
        if (!summary) throw errorWithCode("INVALID_CONTEXT", "Every context entry requires a summary.");
        if (raw.path) validatePathValues({ path: raw.path });
        const id = String(raw.id || crypto.randomUUID());
        const entry = { id, kind: String(raw.kind || "fact"), path: String(raw.path || ""), summary: summary.slice(0, 2_000), tags: Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 30) : [], dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.map(String).slice(0, 100) : [], verified: raw.verified === true, source: String(raw.source || "AI-provided"), updatedAt: new Date().toISOString() };
        const index = data.entries.findIndex((item) => item.id === id || (entry.path && item.path === entry.path && item.kind === entry.kind));
        if (index >= 0) data.entries[index] = entry;
        else data.entries.push(entry);
      }
      if (data.entries.length > MAX_CONTEXT_ENTRIES) data.entries = data.entries.slice(-MAX_CONTEXT_ENTRIES);
      const output = await writeStore(file, data);
      return { text: JSON.stringify({ ok: true, projectId: output.projectId, entries: output.entries.length }), images: [] };
    }
    if (action === "search") {
      const terms = String(args.query || "").toLowerCase().split(/[^a-z0-9_./-]+/).filter(Boolean);
      if (!terms.length) throw errorWithCode("INVALID_CONTEXT", "search requires a non-empty query.");
      const matches = data.entries.map((entry) => {
        const haystack = `${entry.path} ${entry.kind} ${entry.summary} ${(entry.tags || []).join(" ")}`.toLowerCase();
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return { score, entry };
      }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || String(b.entry.updatedAt).localeCompare(String(a.entry.updatedAt))).slice(0, clampInteger(args.limit, 25, 1, 100));
      return { text: JSON.stringify({ ok: true, projectId: data.projectId, mode: "lexical", query: args.query, matches }), images: [] };
    }
    if (action === "graph") {
      const nodes = data.entries.map((entry) => ({ id: entry.id, path: entry.path, kind: entry.kind, summary: entry.summary, verified: entry.verified }));
      const known = new Set(nodes.flatMap((node) => [node.id, node.path]).filter(Boolean));
      const edges = data.entries.flatMap((entry) => (entry.dependencies || []).map((target) => ({ from: entry.path || entry.id, to: target, resolved: known.has(target) })));
      return { text: JSON.stringify({ ok: true, projectId: data.projectId, nodes, edges }), images: [] };
    }
    if (action === "clear") {
      if (args.confirm !== true) throw errorWithCode("CONFIRMATION_REQUIRED", "Clearing project context requires confirm: true.");
      data.entries = [];
      data.changes = [];
      await writeStore(file, data);
      return { text: JSON.stringify({ ok: true, projectId: data.projectId, cleared: true }), images: [] };
    }
    throw errorWithCode("INVALID_CONTEXT", `Unknown project_context action "${action}".`);
  }

  async function scoreAssets(args) {
    const maxParts = Number.isFinite(Number(args.max_parts)) ? Number(args.max_parts) : Infinity;
    const rejectScripts = args.reject_scripts !== false;
    const ranked = (Array.isArray(args.assets) ? args.assets : []).map((asset) => {
      const reasons = [];
      let score = 50;
      const parts = Number(asset.parts ?? asset.part_count);
      const scripts = Number(asset.scripts ?? asset.script_count ?? 0);
      if (Number.isFinite(parts)) {
        if (parts <= maxParts) { score += 12; reasons.push("within part budget"); }
        else { score -= 35; reasons.push("over part budget"); }
      }
      if (scripts > 0) { score -= rejectScripts ? 100 : 25; reasons.push(`${scripts} embedded script(s)`); }
      if (asset.animated === true) { score += 10; reasons.push("animated"); }
      if (args.require_animated && asset.animated !== true) { score -= 40; reasons.push("animation required but absent"); }
      if (asset.r15 === true || String(asset.rig || "").toUpperCase() === "R15") { score += 8; reasons.push("R15 compatible"); }
      if (args.require_r15 && asset.r15 !== true && String(asset.rig || "").toUpperCase() !== "R15") { score -= 40; reasons.push("R15 required but unconfirmed"); }
      if (asset.verified === true || asset.trusted === true) { score += 12; reasons.push("trusted metadata"); }
      if (asset.textured === true) { score += 5; reasons.push("textured"); }
      if (asset.recent === true) { score += 3; reasons.push("recent"); }
      return { id: asset.id, name: asset.name || "", score: Math.max(0, Math.min(100, score)), rejected: rejectScripts && scripts > 0, reasons, metadata: asset };
    }).sort((a, b) => Number(a.rejected) - Number(b.rejected) || b.score - a.score);
    return { text: JSON.stringify({ ok: true, method: "deterministic-metadata", ranked }), images: [] };
  }

  async function findGameIcons(args) {
    const query = String(args.query || "").trim().slice(0, 160);
    if (!query) throw errorWithCode("INVALID_ICON_QUERY", "find_game_icons requires a non-empty query.");
    const semanticTerms = iconTerms(query, { semantic: true });
    const queryForms = new Set(semanticTerms.flatMap(iconWordForms));
    const wantsCommerce = [...queryForms].some((term) => COMMERCE_ICON_TERMS.has(term));
    const wantsCurrency = [...queryForms].some((term) => CURRENCY_ICON_TERMS.has(term));
    const expandedTerms = new Map(
      semanticTerms.map((term) => [term, relatedIconTerms(term)]),
    );
    const styleTerms = iconTerms(args.style);
    const themeTerms = iconTerms(args.game_theme);
    const queryPhrase = iconPhrase(query);
    const category = String(args.category || "").trim().toLowerCase();
    const limit = clampInteger(args.limit, 5, 1, 20);
    const catalog = await iconCatalog();
    const availableStyles = [...new Set(catalog.icons.flatMap((icon) =>
      Array.isArray(icon.styles) ? icon.styles : []
    ).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))].sort();
    const requestedStyle = String(args.style || "").trim().toLowerCase();
    const strictStyle = availableStyles.includes(requestedStyle) ? requestedStyle : "";

    const ranked = [];
    for (const icon of catalog.icons) {
      if (category && String(icon.category || "").toLowerCase() !== category) continue;
      const searchableMetadata = [
        icon.name,
        Array.isArray(icon.tokens) ? icon.tokens.join(" ") : icon.tokens,
        icon.category,
        icon.categoryLabel,
        icon.pack,
        icon.relativePath,
        Array.isArray(icon.styles) ? icon.styles.join(" ") : icon.styles,
        Array.isArray(icon.themes) ? icon.themes.join(" ") : icon.themes,
      ].filter(Boolean).join(" ");
      const rawTokens = iconTerms(searchableMetadata);
      const tokens = new Set(rawTokens.flatMap(iconWordForms));
      // Packs and categories can list both shop controls and currency. Match
      // the actual glyph name/path so a coin is never chosen for a shop.
      const identityMetadata = [icon.name, icon.relativePath].filter(Boolean).join(" ");
      const identityForms = new Set(iconTerms(identityMetadata).flatMap(iconWordForms));
      const isCommerceIcon = [...identityForms].some((term) => COMMERCE_ICON_TERMS.has(term));
      const isCurrencyIcon = [...tokens].some((term) => CURRENCY_ICON_TERMS.has(term));
      if (wantsCommerce && !wantsCurrency && !isCommerceIcon) continue;
      // Currency-only glyphs are not acceptable substitutes for a requested
      // Shop/Cart/Store control. Keep a combined commerce+currency asset
      // eligible, but prefer an actual commerce control decisively.
      if (wantsCommerce && !wantsCurrency && isCurrencyIcon && !isCommerceIcon) continue;
      const namePhrase = iconPhrase(icon.name);
      const rawIconStyles = new Set(
        (Array.isArray(icon.styles) ? icon.styles : [])
          .map((value) => String(value || "").trim().toLowerCase())
          .filter(Boolean),
      );
      if (strictStyle && !rawIconStyles.has(strictStyle)) continue;
      const direct = [];
      const related = [];
      const fuzzy = [];
      const covered = new Set();
      for (const term of semanticTerms) {
        const ownForms = iconWordForms(term);
        if (ownForms.some((form) => tokens.has(form))) {
          direct.push(term);
          covered.add(term);
          continue;
        }
        const alternatives = expandedTerms.get(term) || new Set();
        const match = [...alternatives].find((candidate) => tokens.has(candidate));
        if (match) {
          related.push(`${term}→${match}`);
          covered.add(term);
        }
      }
      for (const term of semanticTerms) {
        if (covered.has(term)) continue;
        const fuzzyMatch = rawTokens.find((candidate) =>
          iconWordForms(term).some((form) => nearIconTerm(form, candidate))
        );
        if (fuzzyMatch) {
          fuzzy.push(term + "≈" + fuzzyMatch);
          covered.add(term);
        }
      }
      const exactPhrase = Boolean(queryPhrase && namePhrase === queryPhrase);
      const containedPhrase = Boolean(
        queryPhrase && semanticTerms.length > 1 && namePhrase.includes(queryPhrase),
      );
      if (
        (!semanticTerms.length && !exactPhrase) ||
        (semanticTerms.length && !direct.length && !related.length && !fuzzy.length && !exactPhrase && !containedPhrase)
      ) {
        continue;
      }

      const iconStyles = new Set(iconTerms(icon.styles));
      const iconThemes = new Set(iconTerms(icon.themes));
      const styleMatches = strictStyle
        ? [strictStyle]
        : styleTerms.filter((term) => iconStyles.has(term));
      const themeMatches = themeTerms.filter((term) => iconThemes.has(term));
      let score = direct.length * 38 + related.length * 24 + fuzzy.length * 16;
      if (exactPhrase) score += 45;
      else if (containedPhrase) score += 22;
      if (wantsCommerce && isCommerceIcon) score += 60;
      if (semanticTerms.length > 1 && covered.size === semanticTerms.length) score += 18;
      score += Math.min(12, styleMatches.length * 4);
      score += Math.min(9, themeMatches.length * 3);
      if (category) score += 6;
      score = Math.max(0, Math.min(100, score));
      if (score < 20) continue;

      const localPath = containedFile(iconLibraryRoot, icon.relativePath);
      if (!localPath) continue;
      ranked.push({
        icon,
        localPath,
        score,
        exactPhrase,
        coveredTerms: covered.size,
        confidence: score >= 70 ? "high" : "medium",
        reasons: [
          ...(exactPhrase ? ["exact icon name"] : []),
          ...(containedPhrase ? ["icon name contains the requested concept"] : []),
          ...(direct.length ? [`direct meaning: ${direct.join(", ")}`] : []),
          ...(related.length ? [`recognized synonym: ${related.join(", ")}`] : []),
          ...(fuzzy.length ? [`spelling-tolerant match: ${fuzzy.join(", ")}`] : []),
          ...(styleMatches.length ? [`style match: ${styleMatches.join(", ")}`] : []),
          ...(themeMatches.length ? [`theme match: ${themeMatches.join(", ")}`] : []),
        ],
      });
    }

    ranked.sort((left, right) =>
      Number(right.exactPhrase) - Number(left.exactPhrase) ||
      right.coveredTerms - left.coveredTerms ||
      right.score - left.score ||
      left.icon.name.localeCompare(right.icon.name) ||
      left.icon.id.localeCompare(right.icon.id)
    );
    const selected = ranked.slice(0, limit);
    const matches = [];
    for (const item of selected) {
      let published = null;
      if (args.publish !== false && typeof options.publishImage === "function") {
        published = await options.publishImage(item.localPath, {
          name: path.basename(item.localPath),
          source: "game-icon-library",
        });
      }
      matches.push({
        id: item.icon.id,
        name: item.icon.name,
        category: item.icon.category,
        pack: item.icon.pack,
        relativePath: item.icon.relativePath,
        localPath: item.localPath,
        url: published?.url || null,
        expiresAt: published?.expiresAt || null,
        width: item.icon.width,
        height: item.icon.height,
        styles: Array.isArray(item.icon.styles) ? [...item.icon.styles] : [],
        themes: Array.isArray(item.icon.themes) ? [...item.icon.themes] : [],
        score: item.score,
        confidence: item.confidence,
        reasons: item.reasons,
      });
    }

    const decision = matches.length ? "match" : "no_match";
    const payload = {
      ok: true,
      decision,
      query,
      searchedTerms: [...new Set([...semanticTerms, ...[...expandedTerms.values()].flatMap((terms) => [...terms])])],
      style: String(args.style || "").trim(),
      strictSelectedStyle: strictStyle || null,
      gameTheme: String(args.game_theme || "").trim(),
      category: category || null,
      availableStyles,
      policy: {
        semanticMatchRequired: true,
        selectedBundledStyleIsStrict: Boolean(strictStyle),
        unrecognizedStyleIsOnlyATiebreaker: !strictStyle,
        recursivelySearchesEveryPack: true,
        allCatalogEntriesUseSameResolver: true,
        searchesNamesCategoriesPacksStylesAndThemes: true,
        synonymAndSpellingExpansion: true,
        generateWhenNoSemanticMatch: false,
        libraryOnlyWhenAiGeneratedUiOffOrUnavailable: true,
        randomFallback: false,
      },
      matches,
      instruction: matches.length
        ? "First decide whether an icon is actually suitable for this UI element. If so, choose only a result that genuinely represents the requested object and fits the game. Use this preset only when AI Generated UI is off or unavailable."
        : "First decide whether this UI element needs an icon. The complete bundled library was searched by name, category, pack, style, theme, related concept, and spelling variants. When AI Generated UI is off or unavailable, do not substitute an unrelated library object.",
      alert: matches.length
        ? null
        : `No suitable bundled icon matches “${query}”. On the library-only path, continue without an icon rather than substituting an unrelated object.`,
    };
    return { text: JSON.stringify(payload), images: [] };
  }

  async function renderLocalIconSpec(concept, spec, requestedSize) {
    const rendered = renderVectorIconPng(spec, requestedSize);
    const directory = path.join(storageRoot, "generated-icons");
    await fs.mkdir(directory, { recursive: true });
    const safeConcept = concept.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "icon";
    const localPath = path.join(directory, safeConcept + "-" + crypto.randomUUID() + ".png");
    await fs.writeFile(localPath, rendered.buffer);
    let published = null;
    if (typeof options.publishImage === "function") {
      try {
        published = await options.publishImage(localPath, {
          name: path.basename(localPath),
          source: "viewcoder-local-vector-icon",
        });
      } catch {}
    }
    return {
      source: published?.url || localPath,
      localPath,
      url: published?.url || null,
      width: rendered.width,
      height: rendered.height,
    };
  }

  async function nativeTools() {
    const listed = await options.listTools();
    const tools = Array.isArray(listed) ? listed : (Array.isArray(listed?.tools) ? listed.tools : []);
    const native = tools.filter((tool) => tool?.name && !String(tool.name).startsWith("viewcoder/"));
    if (native.length) lastNativeTools = native;
    return native.length ? native : lastNativeTools;
  }

  function toolProperties(tool) {
    return tool?.inputSchema?.properties || tool?.input_schema?.properties || {};
  }

  function findNativeTool(tools, preferredNames, predicate) {
    for (const preferred of preferredNames) {
      const exact = tools.find((tool) => {
        const name = String(tool.name || "").toLowerCase();
        const wanted = preferred.toLowerCase();
        return name === wanted || name.endsWith(`/${wanted}`);
      });
      if (exact) return exact;
    }
    return tools.find((tool) => predicate(String(tool.name || "").toLowerCase(), tool)) || null;
  }

  function setToolArgument(target, properties, aliases, value, fallbackKey = null) {
    if (value === undefined || value === null || value === "") return;
    const key = aliases.find((alias) => Object.prototype.hasOwnProperty.call(properties, alias));
    if (key) target[key] = value;
    else if (!Object.keys(properties).length && fallbackKey) target[fallbackKey] = value;
  }

  function setImageSourceArgument(target, properties, value) {
    if (value === undefined || value === null || value === "") return;
    const aliases = [
      "imagePaths", "image_paths", "images",
      "image", "image_url", "imageUrl", "url",
      "path", "file_path", "filePath", "source",
    ];
    const key = aliases.find((alias) => Object.prototype.hasOwnProperty.call(properties, alias));
    if (key) {
      const schema = properties[key] || {};
      const expectsArray = schema.type === "array" || ["imagePaths", "image_paths", "images"].includes(key);
      target[key] = expectsArray ? [value] : value;
      return;
    }
    // Current Roblox upload_image uses imagePaths. A schema-less legacy bridge
    // cannot advertise another shape, so prefer the live contract instead of
    // sending the old scalar image_url guess that Studio rejects.
    if (!Object.keys(properties).length) target.imagePaths = [value];
  }

  function inspectNativeResult(raw) {
    const normalized = normalizeResult(raw);
    const value = resultValue(normalized);
    const textValue = String(normalized.text || "");
    const failed = normalized.isError === true || value?.ok === false || value?.success === false ||
      /(?:error calling|tool execution failed|could not continue|validation error|failed to)/i.test(textValue);
    return {
      ok: !failed,
      normalized,
      value,
      error: failed ? (value?.error || value?.message || textValue || "Native tool failed.") : null,
    };
  }

  function walkObject(value, visitor, seen = new Set()) {
    if (value === null || value === undefined) return;
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry) => walkObject(entry, visitor, seen));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visitor(key, child);
      walkObject(child, visitor, seen);
    }
  }

  function extractMediaSource(result) {
    const inspected = result?.normalized ? result : inspectNativeResult(result);
    const candidates = [];
    const acceptedKeys = new Set([
      "url", "image_url", "imageurl", "output_url", "outputurl", "path", "file_path", "filepath",
    ]);
    walkObject(inspected.value, (key, value) => {
      if (acceptedKeys.has(String(key).toLowerCase()) && typeof value === "string") candidates.push(value);
    });
    for (const image of inspected.normalized.images || []) {
      if (typeof image === "string") candidates.push(image);
      else if (image?.url) candidates.push(image.url);
      else if (image?.image_url) candidates.push(image.image_url);
      else if (image?.data && image?.mimeType) candidates.push(`data:${image.mimeType};base64,${image.data}`);
    }
    const textValue = String(inspected.normalized.text || "");
    const textMatch = textValue.match(/(?:data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+|https?:\/\/[^\s"'<>]+|[a-z]:\\[^\r\n"']+\.(?:png|jpe?g|webp))/i);
    if (textMatch) candidates.push(textMatch[0]);
    return candidates.find((candidate) => /^(?:data:image\/|https?:\/\/|[a-z]:\\)/i.test(String(candidate))) || null;
  }

  function extractAssetId(result) {
    const inspected = result?.normalized ? result : inspectNativeResult(result);
    let assetId = null;
    const acceptedKeys = new Set(["assetid", "asset_id", "contentid", "content_id", "imageid", "image_id"]);
    walkObject(inspected.value, (key, value) => {
      if (!assetId && acceptedKeys.has(String(key).toLowerCase()) && (typeof value === "string" || typeof value === "number")) {
        assetId = String(value).match(/\d+/)?.[0] || null;
      }
    });
    if (assetId) return assetId;
    const textValue = String(inspected.normalized.text || "");
    return textValue.match(/(?:rbxassetid:\/\/|asset(?:\s|_|-)*id\D{0,12})(\d{4,})/i)?.[1] || null;
  }

  async function callNativeTool(tool, args, source) {
    if (!tool) throw errorWithCode("NATIVE_TOOL_UNAVAILABLE", `${source} is not available in the connected workspace.`);
    return inspectNativeResult(await options.callTool(tool.name, args, { source: `viewcoder:${source}` }));
  }

  function imageGeneratorTool(tools) {
    const eligible = tools.filter((tool) => {
      const name = String(tool?.name || "").toLowerCase();
      const server = String(tool?.server || tool?.serverLabel || "").toLowerCase();
      const leaf = name.split("/").pop() || "";
      const schema = tool?.inputSchema || tool?.input_schema || {};
      const properties = schema?.properties || {};
      const required = Array.isArray(schema?.required)
        ? schema.required.map((key) => String(key || "").toLowerCase())
        : [];
      const looksGenerative = ["generate_image", "generate_images", "imagegen", "image_gen", "create_image", "create_images"]
        .includes(leaf) || (/image/.test(name) && /(?:generate|generation|create|creation|imagegen|image_gen)/.test(name));
      const incompatible = /(?:^|[/_-])(?:3d|model|mesh|procedural|hyper3d|hunyuan|screenshot|capture|upload|store|slice|crop)(?:$|[/_-])/.test(name) ||
        /blender/.test(name) || /blender/.test(server);
      const requiresInputImages = required.some((key) =>
        /^(?:images?|imagepaths?|image_paths?|input_images?|input_image_paths?|reference_images?)$/.test(key)
      );
      const acceptsTextPrompt =
        !Object.keys(properties).length ||
        ["prompt", "description", "text", "user_prompt"].some((key) =>
          Object.prototype.hasOwnProperty.call(properties, key)
        );
      return looksGenerative && !incompatible && !requiresInputImages && acceptsTextPrompt;
    });
    return findNativeTool(eligible, ["generate_image", "imagegen", "image_gen", "create_image"], (name) =>
      /image/.test(name) && /(?:generate|generation|create|creation|imagegen|image_gen)/.test(name));
  }

  function uploadImageTool(tools) {
    return findNativeTool(tools, ["upload_image"], (name) => name.includes("upload") && name.includes("image"));
  }

  function imageSlicerTool(tools) {
    return findNativeTool(tools, ["slice_ui_sheet", "slice_image", "crop_image"], (name) =>
      /(?:slice|crop)/.test(name) && /(?:image|sheet|sprite)/.test(name));
  }

  function robloxUiBuilderTool(tools) {
    return findNativeTool(tools, ["build_roblox_ui"], (name) =>
      name.includes("build") && name.includes("roblox") && name.includes("ui"));
  }

  function executeLuauTool(tools) {
    return findNativeTool(tools, ["execute_luau"], (name) => name.endsWith("execute_luau"));
  }

  function summarizeReference(reference) {
    return reference ? {
      id: reference.id,
      name: reference.name,
      role: reference.role,
      styles: reference.styles,
      url: reference.url,
    } : null;
  }

  async function generateIcon(args) {
    const concept = String(args.concept || "").trim();
    if (!concept) throw errorWithCode("INVALID_ICON_REQUEST", "generate_icon requires a concept.");
    const libraryOnly = args.library_only === true;
    const local = libraryOnly
      ? resultValue(await findGameIcons({
          query: concept,
          style: args.style,
          game_theme: args.game_theme,
          limit: 3,
          publish: true,
        }))
      : null;
    const matchingReference = local?.matches?.[0] || null;
    let source = libraryOnly
      ? null
      : String(args.generated_image_url || "").trim() || null;
    let strategy = source ? "provided_generation" : null;
    let generationAttempts = 0;
    let fallbackReason = null;
    let lastGenerationError = null;
    let vectorResult = null;
    let vectorError = null;
    let vectorTried = false;

    const tryVectorSpec = async () => {
      if (source || vectorTried || !args.icon_spec) return false;
      vectorTried = true;
      try {
        vectorResult = await renderLocalIconSpec(concept, args.icon_spec, args.size);
        source = vectorResult.source;
        strategy = "local_vector_generation";
        return true;
      } catch (error) {
        vectorError = String(error?.message || error || "The local vector icon renderer failed.");
        return false;
      }
    };

    if (libraryOnly && matchingReference) {
      source = matchingReference.url || matchingReference.localPath;
      strategy = "bundled_library";
      fallbackReason = "text_only_provider_library_policy";
    }

    // Direct non-chat bridge clients may still provide icon_spec explicitly.
    // Browser chat AIs are told never to send it: they must use their own native
    // image generator and return a captured generated_image_url instead.
    if (!source && !libraryOnly && args.icon_spec) await tryVectorSpec();

    if (!source) {
      if (!libraryOnly) {
        return {
          text: JSON.stringify({
            ok: false,
            code: "AI_NATIVE_GENERATION_REQUIRED",
            concept,
            generationAttempts: 0,
            retryLimit: 3,
            libraryOnly: false,
            instruction: `THIS CHAT AI must use its own built-in native image generator now to create exactly one transparent PNG icon representing ${JSON.stringify(concept)}. ViewCoder and its MCP tools do not generate the image. Follow the user's requested style when provided; otherwise choose a suitable polished style for this component. NO BACKGROUND AT ALL: every pixel outside the icon must be fully transparent (alpha 0), not black, white, colored, a scene, canvas, checkerboard, card, or mockup. Do not call generate_icon again until the native image has visibly finished and ViewCoder has captured its URL. ViewCoder waits up to 3 minutes 30 seconds for the native render to finish before reporting the attempt as incomplete.`,
            message: "No finished native-generated PNG was supplied. The extension waits up to 3 minutes 30 seconds for each native render, allows up to 3 native generation attempts (and at most 2 background/alpha validation failures), then automatically switches AI Generated UI off and continues through code-native UI with optional suitable preset icons.",
          }),
          images: [],
        };
      }
      return {
        text: JSON.stringify({
          ok: false,
          code: "ICON_UNAVAILABLE",
          concept,
          required: args.required !== false,
          generationAttempts,
          fallbackReason,
          lastGenerationError,
          vectorError,
          matchingReference: null,
          libraryOnly,
          retryable: false,
          nextAction: "No bundled icon semantically matches this concept. Decide whether an icon is suitable; if it is, continue without one rather than substituting an unrelated preset.",
          message: `No bundled icon semantically matches ${concept}; library-only mode will not generate or substitute an unrelated object.`,
        }),
        images: [],
      };
    }

    let upload = null;
    if (args.upload_to_roblox !== false) {
      const tools = await nativeTools();
      const uploader = uploadImageTool(tools);
      if (!uploader) {
        return { text: JSON.stringify({ ok: false, code: "UPLOAD_TOOL_UNAVAILABLE", concept, source, strategy }), images: [] };
      }
      const properties = toolProperties(uploader);
      const nativeArgs = {};
      setImageSourceArgument(nativeArgs, properties, source);
      setToolArgument(nativeArgs, properties, ["name", "asset_name", "filename"], args.name || concept);
      setToolArgument(nativeArgs, properties, ["description", "user_prompt"], `ViewCoder game UI icon: ${concept}`);
      upload = await callNativeTool(uploader, nativeArgs, "upload_image");
      const assetId = upload.ok ? extractAssetId(upload) : null;
      if (!upload.ok || !assetId) {
        return {
          text: JSON.stringify({
            ok: false,
            code: upload.ok ? "UPLOAD_UNVERIFIED" : "UPLOAD_FAILED",
            concept,
            source,
            strategy,
            message: upload.error || "Studio did not return a verifiable asset/content ID.",
          }),
          images: [],
        };
      }
      upload.assetId = assetId;
    }

    return {
      text: JSON.stringify({
        ok: true,
        concept,
        strategy,
        source,
        reference: summarizeReference(matchingReference),
        matchingReference: summarizeReference(matchingReference ? { ...matchingReference, role: "semantic_library_only" } : null),
        generationAttempts,
        libraryOnly,
        fallbackReason: ["bundled_library", "local_vector_generation"].includes(strategy) ? fallbackReason : null,
        lastGenerationError: ["bundled_library", "local_vector_generation"].includes(strategy) ? lastGenerationError : null,
        vectorError: strategy === "bundled_library" ? vectorError : null,
        generatedLocalPath: vectorResult?.localPath || null,
        width: vectorResult?.width || null,
        height: vectorResult?.height || null,
        uploaded: Boolean(upload),
        assetId: upload?.assetId || null,
        verified: Boolean(upload?.assetId) || args.upload_to_roblox === false,
      }),
      images: [],
    };
  }

  async function generateUiImage(args) {
    const description = String(args.description || "").trim();
    if (!description) throw errorWithCode("INVALID_UI_IMAGE_REQUEST", "generate_ui_image requires a description.");
    const componentName = String(args.component_name || "UI Component").trim();
    const componentType = String(args.component_type || "component").trim();
    const dimensions = String(args.dimensions || "fit the single component tightly").trim();
    const interactionState = String(args.interaction_state || "normal").trim();
    const componentFamily = String(args.component_family || "current interface").trim();
    const requiredIcons = [...new Set((Array.isArray(args.required_icons) ? args.required_icons : [])
      .map((value) => String(value || "").trim()).filter(Boolean))];
    if (requiredIcons.length > 1) {
      return {
        text: JSON.stringify({
          ok: false,
          code: "ONE_UI_COMPONENT_REQUIRED",
          message: "AI Generated UI creates one transparent component per image. Generate each icon and control separately instead of combining them into a sheet.",
        }),
        images: [],
      };
    }

    let source = String(args.generated_image_url || "").trim() || null;
    if (!source) {
      return {
        text: JSON.stringify({
          ok: false,
          code: "AI_NATIVE_GENERATION_REQUIRED",
          componentName,
          componentType,
          dimensions,
          interactionState,
          componentFamily,
          retryLimit: 3,
          instruction: `THIS CHAT AI must use its own built-in native image generator now. Create exactly ONE production-ready Roblox UI ${componentType} named ${JSON.stringify(componentName)} for: ${description}. Follow the user's requested style when provided; otherwise choose a coherent polished style that suits the requested game UI. Output one tightly cropped PNG with real transparent alpha. NO BACKGROUND AT ALL: every pixel outside the component must be fully transparent (alpha 0), not black, white, colored, a scene, canvas, checkerboard, card, or mockup. ViewCoder and its MCP tools do not generate the image. Do not call generate_ui_image again until native generation has visibly finished and ViewCoder has captured its URL. ViewCoder waits up to 3 minutes 30 seconds for the native render to finish before reporting the attempt as incomplete.`,
          constraints: [
            `Target dimensions/aspect: ${dimensions}`,
            `Only interaction state: ${interactionState}`,
            `Cohesive component family: ${componentFamily}`,
            "Never generate a complete menu, shop, screen, collage, mockup, sprite sheet, multiple controls, or multiple states in one image.",
            "Do not bake dynamic names, prices, counts, progress values, or player-specific text into the bitmap.",
          ],
          message: "No finished native-generated PNG was supplied. The extension waits up to 3 minutes 30 seconds for each native render, allows up to 3 native generation attempts (and at most 2 background/alpha validation failures), then automatically switches AI Generated UI off and continues through code-native UI with optional suitable preset icons.",
        }),
        images: [],
      };
    }

    let assetId = null;
    if (args.upload_to_roblox === true) {
      const tools = await nativeTools();
      const uploader = uploadImageTool(tools);
      if (!uploader) return { text: JSON.stringify({ ok: false, code: "UPLOAD_TOOL_UNAVAILABLE", source }), images: [] };
      const properties = toolProperties(uploader);
      const nativeArgs = {};
      setImageSourceArgument(nativeArgs, properties, source);
      setToolArgument(nativeArgs, properties, ["name", "asset_name", "filename"], `${componentName}.png`);
      setToolArgument(nativeArgs, properties, ["description", "user_prompt"], `ViewCoder AI Generated UI PNG component: ${componentName} (${componentType}, ${interactionState})`);
      const upload = await callNativeTool(uploader, nativeArgs, "upload_image");
      assetId = upload.ok ? extractAssetId(upload) : null;
      if (!upload.ok || !assetId) {
        return { text: JSON.stringify({ ok: false, code: upload.ok ? "UPLOAD_UNVERIFIED" : "UPLOAD_FAILED", source, message: upload.error }), images: [] };
      }
    }
    return {
      text: JSON.stringify({
        ok: true,
        strategy: "ai_generated_ui_component",
        format: "png",
        transparentBackgroundRequired: true,
        componentName,
        componentType,
        dimensions,
        interactionState,
        componentFamily,
        source,
        assetId,
        verified: args.upload_to_roblox !== true || Boolean(assetId),
      }),
      images: [],
    };
  }

  async function sliceUiSheet(args) {
    const source = String(args.sheet_url || "").trim();
    if (!source) throw errorWithCode("INVALID_UI_SHEET", "slice_ui_sheet requires sheet_url.");
    const regions = Array.isArray(args.regions) ? args.regions : [];
    if (!regions.length) throw errorWithCode("INVALID_UI_REGIONS", "slice_ui_sheet requires at least one region.");
    const tools = await nativeTools();
    const slicer = imageSlicerTool(tools);
    if (!slicer) return { text: JSON.stringify({ ok: false, code: "IMAGE_SLICER_UNAVAILABLE" }), images: [] };
    const properties = toolProperties(slicer);
    const nativeArgs = {};
    setToolArgument(nativeArgs, properties, ["sheet_url", "image_url", "url", "image", "path", "file_path"], source, "image_url");
    setToolArgument(nativeArgs, properties, ["regions", "slices", "boxes"], regions, "regions");
    const sliced = await callNativeTool(slicer, nativeArgs, "slice_ui_sheet");
    return sliced.ok
      ? { text: JSON.stringify({ ok: true, tool: slicer.name, result: sliced.value }), images: sliced.normalized.images || [] }
      : { text: JSON.stringify({ ok: false, code: "SLICE_FAILED", message: sliced.error }), images: [] };
  }

  async function buildRobloxUi(args) {
    const description = String(args.description || "").trim();
    if (!description) throw errorWithCode("INVALID_UI_BUILD", "build_roblox_ui requires a description.");
    const requiredIcons = [...new Set((Array.isArray(args.required_icons) ? args.required_icons : [])
      .map((value) => String(value || "").trim()).filter(Boolean))];
    const supplied = Array.isArray(args.resolved_icons) ? args.resolved_icons : [];
    const resolvedIcons = [...supplied];
    for (const concept of requiredIcons) {
      if (resolvedIcons.some((entry) => String(entry?.concept || entry?.name || "").toLowerCase() === concept.toLowerCase() && (entry?.assetId || entry?.asset_id))) continue;
      const generated = resultValue(await generateIcon({
        concept,
        style: args.style,
        game_theme: args.game_theme,
        library_only: args.library_only === true,
        upload_to_roblox: true,
        required: true,
      }));
      if (!generated?.ok || !generated?.assetId) {
        return { text: JSON.stringify({ ok: false, code: "REQUIRED_ICON_NOT_VERIFIED", concept, result: generated }), images: [] };
      }
      resolvedIcons.push(generated);
    }

    const tools = await nativeTools();
    const nativeBuilder = robloxUiBuilderTool(tools);
    const luauBuilder = executeLuauTool(tools);
    const builder = nativeBuilder || (args.luau ? luauBuilder : null);
    const usesLuau = Boolean(luauBuilder && builder === luauBuilder);
    if (!builder) {
      return { text: JSON.stringify({ ok: false, code: "ROBLOX_UI_BUILDER_UNAVAILABLE", resolvedIcons }), images: [] };
    }
    const properties = toolProperties(builder);
    const nativeArgs = {};
    if (usesLuau) {
      setToolArgument(nativeArgs, properties, ["code", "luau", "script", "source"], args.luau, "code");
    } else {
      setToolArgument(nativeArgs, properties, ["description", "prompt", "user_prompt"], description, "description");
      setToolArgument(nativeArgs, properties, ["style", "theme"], args.style);
      setToolArgument(nativeArgs, properties, ["icons", "resolved_icons", "assets"], resolvedIcons, "resolved_icons");
    }
    const built = await callNativeTool(builder, nativeArgs, "build_roblox_ui");
    if (!built.ok) return { text: JSON.stringify({ ok: false, code: "ROBLOX_UI_BUILD_FAILED", message: built.error, resolvedIcons }), images: [] };
    return {
      text: JSON.stringify({ ok: true, tool: builder.name, verified: true, resolvedIcons, result: built.value }),
      images: built.normalized.images || [],
    };
  }

  return {
    definitions: VIEWCODER_TOOL_DEFINITIONS,
    isReadOnlyTool,
    async execute(name, args = {}) {
      if (name === "viewcoder/get_capabilities") return capabilities(args);
      if (name === "viewcoder/run_workflow") return runWorkflow(args);
      if (name === "viewcoder/batch_read") return batchRead(args);
      if (name === "viewcoder/project_context") return projectContext(args);
      if (name === "viewcoder/score_assets") return scoreAssets(args);
      if (name === "viewcoder/find_game_icons") return findGameIcons(args);
      if (name === "viewcoder/generate_icon") return generateIcon(args);
      if (name === "viewcoder/generate_ui_image") return generateUiImage(args);
      if (name === "viewcoder/slice_ui_sheet") return sliceUiSheet(args);
      if (name === "viewcoder/build_roblox_ui") return buildRobloxUi(args);
      throw errorWithCode("UNKNOWN_VIEWCODER_TOOL", `Unknown ViewCoder command "${name}".`);
    },
  };
}
