// Browser image relay for ViewCoder.
// Captures user-selected files and newly generated assistant images without
// altering chat content, then stores them in the local bridge so Roblox Studio
// and ViewCoder workflows receive an ordinary loopback HTTP URL.
(() => {
  "use strict";
  if (globalThis.ViewCoderImageRelay) return;

  const MAX_IMAGE_BYTES = 15_000_000;
  const MAX_SOURCE_IMAGE_BYTES = 32_000_000;
  const OPTIMIZE_ABOVE_BYTES = 5_000_000;
  const MAX_IMAGE_EDGE = 2_048;
  const MAX_IMAGE_PIXELS = 4_200_000;
  const MAX_RECORDS = 8;
  const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
  const records = [];
  const recentSignatures = new Map();
  const capturedGeneratedSources = new Set();
  const pendingGeneratedSources = new Set();
  const generatedBaselineSources = new Set();
  let generatedCaptureArmedAt = 0;

  function background(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({
              ok: false,
              error: chrome.runtime.lastError.message,
            });
          } else {
            resolve(response || { ok: false, error: "No bridge response." });
          }
        });
      } catch (error) {
        resolve({ ok: false, error: String(error?.message || error) });
      }
    });
  }

  function supportedImage(file) {
    return (
      file instanceof File &&
      /^(?:image\/(?:png|jpeg|gif|webp))$/i.test(file.type || "") &&
      file.size > 0 &&
      file.size <= MAX_SOURCE_IMAGE_BYTES &&
      !/^viewcoder[_-]/i.test(file.name || "")
    );
  }

  function readDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Image read failed."));
      reader.onabort = () => reject(new Error("Image read was cancelled."));
      reader.readAsDataURL(file);
    });
  }

  function canvasBlob(canvas, mimeType, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
  }

  function hasTransparentCanvasEdge(context, width, height) {
    const points = 48;
    let transparentSamples = 0;
    let totalSamples = 0;
    try {
      for (let index = 0; index < points; index += 1) {
        const ratio = points === 1 ? 0 : index / (points - 1);
        const x = Math.min(width - 1, Math.max(0, Math.round((width - 1) * ratio)));
        const y = Math.min(height - 1, Math.max(0, Math.round((height - 1) * ratio)));
        const samples = [[x, 0], [x, height - 1], [0, y], [width - 1, y]];
        for (const [sampleX, sampleY] of samples) {
          totalSamples += 1;
          if (context.getImageData(sampleX, sampleY, 1, 1).data[3] < 250) {
            transparentSamples += 1;
          }
        }
      }
    } catch {
      return false;
    }
    // One accidentally transparent corner pixel is not a transparent UI asset.
    // Require a meaningful alpha band around the canvas so full screenshots,
    // scenes and rectangular shop mockups are rejected and regenerated.
    return transparentSamples >= Math.max(8, Math.floor(totalSamples * 0.05));
  }

  function transparentCanvasCoverage(context, width, height) {
    try {
      const pixels = context.getImageData(0, 0, width, height).data;
      const columns = Math.min(48, Math.max(1, width));
      const rows = Math.min(48, Math.max(1, height));
      let transparentSamples = 0;
      let totalSamples = 0;
      for (let row = 0; row < rows; row += 1) {
        const y = Math.min(height - 1, Math.floor(((row + 0.5) * height) / rows));
        for (let column = 0; column < columns; column += 1) {
          const x = Math.min(width - 1, Math.floor(((column + 0.5) * width) / columns));
          totalSamples += 1;
          if (pixels[((y * width) + x) * 4 + 3] < 250) transparentSamples += 1;
        }
      }
      return totalSamples ? transparentSamples / totalSamples : 0;
    } catch {
      return 0;
    }
  }

  function renamedImageFile(blob, original, mimeType) {
    const extension = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/webp": ".webp",
    }[mimeType] || "";
    const stem = String(original.name || "viewcoder-image")
      .replace(/\.(?:png|jpe?g|gif|webp)$/i, "") || "viewcoder-image";
    return new File([blob], `${stem}${extension}`, {
      type: mimeType,
      lastModified: original.lastModified || Date.now(),
    });
  }

  async function prepareImage(record) {
    if (record.relayFile) return record.relayFile;
    const original = record.file;
    if (original.type === "image/gif" && record.source !== "assistant-generated") {
      if (original.size > MAX_IMAGE_BYTES) {
        throw new Error("Animated GIF attachments must be smaller than 15 MB.");
      }
      record.relayFile = original;
      return original;
    }
    if (typeof createImageBitmap !== "function") {
      if (record.source === "assistant-generated" && original.type !== "image/png") {
        throw new Error("This browser tab cannot convert the generated asset to the required PNG format.");
      }
      if (original.size > MAX_IMAGE_BYTES) {
        throw new Error("This image is too large to optimize in the current browser tab.");
      }
      record.relayFile = original;
      return original;
    }

    let bitmap;
    try {
      bitmap = await createImageBitmap(original);
      const width = Math.max(1, Number(bitmap.width) || 1);
      const height = Math.max(1, Number(bitmap.height) || 1);
      record.width = width;
      record.height = height;
      const scale = Math.min(
        1,
        MAX_IMAGE_EDGE / Math.max(width, height),
        Math.sqrt(MAX_IMAGE_PIXELS / (width * height)),
      );
      const forceTransparentPng = record.source === "assistant-generated";
      const shouldOptimize = forceTransparentPng || scale < 0.999 || original.size > OPTIMIZE_ABOVE_BYTES;
      if (!shouldOptimize) {
        record.relayFile = original;
        return original;
      }

      let canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new Error("Image optimization is unavailable.");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      const transparentCoverage = forceTransparentPng
        ? transparentCanvasCoverage(context, canvas.width, canvas.height)
        : 1;
      if (
        forceTransparentPng &&
        (!hasTransparentCanvasEdge(context, canvas.width, canvas.height) || transparentCoverage < 0.015)
      ) {
        throw new Error(
          "The generated UI asset is not one isolated transparent component. Regenerate exactly one component as a PNG with real transparent alpha. NO BACKGROUND AT ALL: every pixel outside the component must be fully transparent (alpha 0), not black, white, colored, a scene, canvas, checkerboard, preview card, rectangular background, collage, state sheet, or Default/Hover/Pressed variants.",
        );
      }

      let outputType = forceTransparentPng
        ? "image/png"
        : original.type === "image/jpeg"
          ? "image/jpeg"
          : original.type === "image/webp"
            ? "image/webp"
            : "image/png";
      let blob = await canvasBlob(
        canvas,
        outputType,
        outputType === "image/png" ? undefined : 0.88,
      );
      // AI Generated UI is always relayed as a real PNG. If a detailed result is
      // too large, reduce its dimensions while preserving alpha instead of
      // silently changing the format to WebP.
      while (
        forceTransparentPng &&
        blob?.size > MAX_IMAGE_BYTES &&
        Math.max(canvas.width, canvas.height) > 512
      ) {
        const smaller = document.createElement("canvas");
        smaller.width = Math.max(1, Math.floor(canvas.width * 0.82));
        smaller.height = Math.max(1, Math.floor(canvas.height * 0.82));
        const smallerContext = smaller.getContext("2d", { alpha: true });
        if (!smallerContext) break;
        smallerContext.imageSmoothingEnabled = true;
        smallerContext.imageSmoothingQuality = "high";
        smallerContext.drawImage(bitmap, 0, 0, smaller.width, smaller.height);
        canvas = smaller;
        blob = await canvasBlob(canvas, "image/png");
      }
      // Non-generated user attachments keep the existing bounded WebP option.
      if (!forceTransparentPng && blob && blob.size > MAX_IMAGE_BYTES && original.type === "image/png") {
        const webp = await canvasBlob(canvas, "image/webp", 0.9);
        if (webp?.size && webp.size < blob.size) {
          blob = webp;
          outputType = "image/webp";
        }
      }
      if (!blob?.size) throw new Error("The browser could not optimize this image.");
      const candidate = renamedImageFile(blob, original, outputType);
      if (candidate.size > MAX_IMAGE_BYTES) {
        throw new Error("The optimized image is still larger than 15 MB.");
      }
      // A dimension resize is always useful. A same-size image is only replaced
      // when compression materially helps or the source cannot fit the relay.
      if (forceTransparentPng || scale < 0.999 || original.size > MAX_IMAGE_BYTES || candidate.size < original.size * 0.97) {
        record.optimized = true;
        record.optimizedWidth = canvas.width;
        record.optimizedHeight = canvas.height;
        record.relayFile = candidate;
        record.name = candidate.name;
        record.mimeType = candidate.type;
        record.size = candidate.size;
        return candidate;
      }
      record.relayFile = original;
      return original;
    } catch (error) {
      // Generated UI has a strict contract: a real PNG with transparent alpha
      // around one component. Never fall back to the original opaque/full-screen
      // file after validation failed; surface the error so the native generator
      // retry counter can request a corrected image (up to three attempts,
      // with at most two background/alpha validation failures).
      if (record.source === "assistant-generated") throw error;
      if (original.size > MAX_IMAGE_BYTES) throw error;
      record.relayFile = original;
      return original;
    } finally {
      try { bitmap?.close?.(); } catch {}
    }
  }

  async function upload(record) {
    if (record.uploadPromise) return record.uploadPromise;
    record.uploadPromise = (async () => {
      try {
        const file = await prepareImage(record);
        if (!record.dataUrl) record.dataUrl = await readDataUrl(file);
        const response = await background({
          type: "relay_image",
          data: record.dataUrl,
          mimeType: record.mimeType,
          name: record.name,
        });
        if (!response?.ok || !/^https?:\/\//i.test(response.url || "")) {
          throw new Error(response?.error || "The bridge did not return an image URL.");
        }
        record.id = response.id;
        record.url = response.url;
        record.size = Number(response.size) || file.size;
        record.mimeType = String(response.mimeType || file.type || record.mimeType);
        record.expiresAt = Date.parse(response.expiresAt || "") ||
          Date.now() + DEFAULT_MAX_AGE_MS;
        record.error = null;
        return record;
      } catch (error) {
        record.error = String(error?.message || error);
        record.url = "";
        return null;
      } finally {
        // Do not retain a base64 copy for the rest of a long chat. The File/Blob
        // can be read again if the short-lived bridge URL needs refreshing.
        record.dataUrl = "";
        record.uploadPromise = null;
      }
    })();
    return record.uploadPromise;
  }

  function addFile(file, source) {
    if (!supportedImage(file)) return null;
    const now = Date.now();
    const signature = `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
    const previousAt = recentSignatures.get(signature) || 0;
    if (now - previousAt < 2_000) return null;
    recentSignatures.set(signature, now);
    for (const [key, at] of recentSignatures) {
      if (now - at > 10_000) recentSignatures.delete(key);
    }
    const record = {
      captureId: `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      file,
      name: file.name || `viewcoder-image-${now}`,
      mimeType: file.type.toLowerCase(),
      size: file.size,
      originalSize: file.size,
      capturedAt: now,
      source,
      dataUrl: "",
      id: "",
      url: "",
      expiresAt: 0,
      used: false,
      error: null,
      uploadPromise: null,
      relayFile: null,
      optimized: false,
    };
    records.push(record);
    while (records.length > MAX_RECORDS) records.shift();
    void upload(record);
    return record;
  }

  function addFiles(list, source) {
    for (const file of Array.from(list || [])) addFile(file, source);
  }

  function generatedImageCandidate(image) {
    if (!(image instanceof HTMLImageElement) || image.closest("#zs-root")) return false;
    if (image.closest('form, [contenteditable="true"], [data-message-author-role="user"]')) return false;
    const width = Number(image.naturalWidth || image.width) || 0;
    const height = Number(image.naturalHeight || image.height) || 0;
    if (Math.min(width, height) < 160) return false;
    const assistantTurn = image.closest('[data-message-author-role="assistant"]');
    const hints = [
      image.alt,
      image.getAttribute("aria-label"),
      image.getAttribute("data-testid"),
      image.closest('[data-testid*="image" i]')?.getAttribute("data-testid"),
    ].filter(Boolean).join(" ");
    return Boolean(assistantTurn) || /(?:generated|created|imagegen|dall[ -]?e).*image|image.*(?:generated|created)/i.test(hints);
  }

  function generatedImageTurnRoot(anchor) {
    if (!(anchor instanceof Element) || anchor.closest?.("#zs-root")) return null;
    return (
      anchor.closest('[data-testid^="conversation-turn-"]') ||
      anchor.closest('[data-message-author-role="assistant"]') ||
      anchor
    );
  }

  function generatedImagesIn(anchor) {
    const root = generatedImageTurnRoot(anchor);
    if (!root) return [];
    const images = root instanceof HTMLImageElement ? [root] : [];
    if (root.querySelectorAll) images.push(...root.querySelectorAll("img"));
    return images;
  }

  // ChatGPT can leave its generic streaming flag set after the native image card
  // has already committed a full-resolution result. A complete, large generated
  // image in the command's own conversation turn is the authoritative finish
  // signal; it must not be held behind that stale provider flag.
  function hasFinishedGeneratedImage(anchor) {
    return generatedImagesIn(anchor).some((image) => (
      generatedImageCandidate(image) &&
      image.complete !== false &&
      Math.min(Number(image.naturalWidth) || 0, Number(image.naturalHeight) || 0) >= 160
    ));
  }

  function imageExtension(mimeType) {
    if (mimeType === "image/jpeg") return "jpg";
    if (mimeType === "image/webp") return "webp";
    if (mimeType === "image/gif") return "gif";
    return "png";
  }

  async function fileFromGeneratedImage(image, sourceUrl) {
    try {
      const response = await fetch(sourceUrl, { credentials: "include" });
      if (response.ok) {
        const blob = await response.blob();
        if (/^image\/(?:png|jpeg|gif|webp)$/i.test(blob.type || "") && blob.size) {
          return new File(
            [blob],
            `provider-generated-${Date.now()}.${imageExtension(blob.type.toLowerCase())}`,
            { type: blob.type.toLowerCase(), lastModified: Date.now() },
          );
        }
      }
    } catch {}

    // Authenticated and blob-backed image cards can reject fetch even though
    // the browser can display them. Canvas gives same-origin/CORS-enabled cards
    // a second route while preserving transparent pixels.
    try {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Number(image.naturalWidth) || Number(image.width) || 1);
      canvas.height = Math.max(1, Number(image.naturalHeight) || Number(image.height) || 1);
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) return null;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await canvasBlob(canvas, "image/png");
      if (!blob?.size) return null;
      return new File([blob], `provider-generated-${Date.now()}.png`, {
        type: "image/png",
        lastModified: Date.now(),
      });
    } catch {
      return null;
    }
  }

  async function captureGeneratedImageElement(image) {
    if (!generatedCaptureArmedAt) return null;
    if (!generatedImageCandidate(image)) return null;
    const sourceUrl = String(image.currentSrc || image.src || "").trim();
    if (!/^(?:https?:|blob:|data:image\/)/i.test(sourceUrl)) return null;
    if (generatedBaselineSources.has(sourceUrl)) return null;
    if (capturedGeneratedSources.has(sourceUrl) || pendingGeneratedSources.has(sourceUrl)) return null;
    pendingGeneratedSources.add(sourceUrl);
    try {
      const file = await fileFromGeneratedImage(image, sourceUrl);
      if (!file) return null;
      const record = addFile(file, "assistant-generated");
      if (record) capturedGeneratedSources.add(sourceUrl);
      return record;
    } finally {
      pendingGeneratedSources.delete(sourceUrl);
    }
  }

  function recordResult(record) {
    return {
      captureId: record.captureId,
      source: record.source,
      id: record.id,
      url: record.url,
      name: record.name,
      mimeType: record.mimeType,
      size: record.size,
      originalSize: record.originalSize,
      optimized: record.optimized,
      width: record.optimizedWidth || record.width || 0,
      height: record.optimizedHeight || record.height || 0,
      capturedAt: record.capturedAt,
      expiresAt: record.expiresAt,
      error: String(record.error || ""),
      rejected: Boolean(record.error && !record.url),
    };
  }

  // Native image cards can expose a low-resolution or incomplete preview under
  // the same URL while the provider still says "Creating image"/"Finishing up".
  // Once main.js has observed the finished state, fetch the visible pixels again
  // and relay that final file instead of reusing the early observer capture.
  async function captureFinishedGeneratedImage(options = {}) {
    const root = generatedImageTurnRoot(options.anchor);
    // Explicit recovery is restricted to the exact assistant conversation turn
    // that issued generate_ui_image/generate_icon. This safely recovers after an
    // extension reload or a missed MutationObserver event without ever selecting
    // an older image elsewhere in a long chat.
    const recoverCurrentTurn = options.recoverCurrentTurn === true && Boolean(root);
    if (!generatedCaptureArmedAt && !recoverCurrentTurn) return undefined;
    const images = (root ? generatedImagesIn(root) : [...document.querySelectorAll("img")]).reverse();
    let attempted = false;
    for (const image of images) {
      if (!generatedImageCandidate(image)) continue;
      if (image.complete === false) continue;
      const sourceUrl = String(image.currentSrc || image.src || "").trim();
      if (!/^(?:https?:|blob:|data:image\/)/i.test(sourceUrl)) continue;
      if (!recoverCurrentTurn && generatedBaselineSources.has(sourceUrl)) continue;
      attempted = true;
      const file = await fileFromGeneratedImage(image, sourceUrl);
      if (!file) continue;
      const record = addFile(file, "assistant-generated");
      if (!record) continue;
      capturedGeneratedSources.add(sourceUrl);
      await upload(record);
      if (record.url || record.error) return recordResult(record);
    }
    return attempted ? null : undefined;
  }

  function scanGeneratedImages(root) {
    if (root instanceof HTMLImageElement) void captureGeneratedImageElement(root);
    if (root?.querySelectorAll) {
      for (const image of root.querySelectorAll("img")) void captureGeneratedImageElement(image);
    }
  }

  function armGeneratedCapture() {
    generatedCaptureArmedAt = Date.now();
    generatedBaselineSources.clear();
    for (const image of document.querySelectorAll("img")) {
      const sourceUrl = String(image.currentSrc || image.src || "").trim();
      if (sourceUrl) generatedBaselineSources.add(sourceUrl);
    }
  }

  document.addEventListener("change", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.type === "file") {
      addFiles(input.files, "picker");
    }
  }, true);

  document.addEventListener("paste", (event) => {
    addFiles(event.clipboardData?.files, "paste");
  }, true);

  document.addEventListener("drop", (event) => {
    addFiles(event.dataTransfer?.files, "drop");
  }, true);

  document.addEventListener("load", (event) => {
    if (event.target instanceof HTMLImageElement) void captureGeneratedImageElement(event.target);
  }, true);

  const generatedImageObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") scanGeneratedImages(mutation.target);
      for (const node of mutation.addedNodes || []) {
        if (node.nodeType === Node.ELEMENT_NODE) scanGeneratedImages(node);
      }
    }
  });
  generatedImageObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset"],
  });
  setTimeout(() => scanGeneratedImages(document), 750);

  async function latest(options = {}) {
    const maxAgeMs = Math.max(5_000, Number(options.maxAgeMs) || DEFAULT_MAX_AGE_MS);
    const source = String(options.source || "");
    const minCapturedAt = Math.max(0, Number(options.minCapturedAt) || 0);
    const waitMs = Math.max(0, Number(options.waitMs) || 0);
    const deadline = Date.now() + waitMs;
    do {
      const now = Date.now();
      const record = [...records].reverse().find(
        (entry) =>
          !entry.used &&
          (!source || entry.source === source) &&
          entry.capturedAt >= minCapturedAt &&
          now - entry.capturedAt <= maxAgeMs,
      );
      if (record) {
        if (options.refresh === true || !record.url || record.expiresAt <= now + 30_000) {
          await upload(record);
        }
        if (record.url) {
          return recordResult(record);
        }
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 120));
    } while (true);
  }

  function markUsed(captureId) {
    const record = records.find((entry) => entry.captureId === captureId);
    if (record) record.used = true;
  }

  globalThis.ViewCoderImageRelay = Object.freeze({
    latest,
    markUsed,
    captureFiles(files, source = "manual") {
      addFiles(files, source);
    },
    captureGeneratedImageElement,
    captureFinishedGeneratedImage,
    hasFinishedGeneratedImage,
    armGeneratedCapture,
    snapshot() {
      return records.map(({ file, relayFile, dataUrl, uploadPromise, ...record }) => ({ ...record }));
    },
  });
})();
