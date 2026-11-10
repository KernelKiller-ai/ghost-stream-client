/* ============================================================
 * GHOST-STREAM // qrHandshake.js
 * 100% offline, air-gapped WebRTC handshake over animated QR codes.
 *
 * Pipeline (TX):
 *   SDP string
 *     -> CompressionStream("deflate-raw")      [Requirement 1]
 *     -> CRC-16/CCITT over the COMPRESSED blob
 *     -> split into N binary segments
 *     -> frame string "GS1|<idx>|<total>|<crc16-hex>|<b64url seg>"
 *     -> one QR code per frame, animated at 5 FPS              [Req 2]
 *
 * Pipeline (RX):
 *   scan frames -> validate header -> dedupe/out-of-order tolerant
 *   -> when all N collected, concat, verify CRC-16
 *   -> DecompressionStream("deflate-raw") -> original SDP string
 *
 * Design notes:
 *  - deflate-raw (no zlib/gzip wrapper) saves ~18 bytes of header/checksum
 *    versus gzip — meaningful when a QR frame holds ~80 bytes of payload.
 *    The scheme field is still honored so gzip can be enabled later.
 *  - Frames are INDEXED (not fountain-coded): deterministic, trivially
 *    reorderable, and each frame independently verifiable so a mis-scanned
 *    page never poisons the assembly. The animation loops continuously so
 *    the receiver simply keeps watching until it has all N indexes — the
 *    practical effect mirrors fountain decoding (any pass fills gaps).
 *  - Camera-side decoding is a presentation concern (BarcodeDetector or a
 *    scanner library); this module is the codec + animator + assembler.
 *  - Zero network usage anywhere: pure bytes + canvas pixels.
 * ============================================================ */

import { renderQrCodeAsync } from "../ui/qrEncoder.js";

/* ---------------- capacity planning ---------------- */

/**
 * The built-in QR encoder tops out at QR version 6, low ECC:
 * 136 data codewords. Byte-mode header eats 2, so the frame STRING
 * must stay <= 134 characters. Frame header "GS1|i|n|cccc|" reserves
 * ~16; base64url inflates bytes by 4/3. Solve conservatively:
 *   (16 + ceil(binLen * 4/3)) <= 134  ->  binLen <= ~88
 * Use 80 to leave slack for 2-digit/3-digit index growth.
 */
const SEGMENT_BYTES = 80;

/** Animation rate for the multipage sequence. */
const FPS = 5;

/** Deflate-raw is the default codec; "gzip" supported for interop. */
const CODEC_DEFAULT = "deflate-raw";

/* ---------------- checksum ---------------- */

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — matches BLE transport. */
export function crc16(bytes) {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/* ---------------- compression (Requirement 1) ---------------- */

/**
 * Compress an SDP string via the native CompressionStream API.
 * @param {string} sdp
 * @param {"deflate-raw"|"gzip"|"deflate"} [format]
 * @returns {Promise<Uint8Array>}
 */
export async function compressSdp(sdp, format = CODEC_DEFAULT) {
  if (typeof CompressionStream !== "function") {
    // Extremely old engines: fall back to raw bytes (still air-gapped,
    // just denser QRs). Log loudly so the degradation is visible.
    console.warn(
      "[qr-handshake] CompressionStream unavailable — sending uncompressed SDP",
    );
    return new TextEncoder().encode(sdp);
  }
  const stream = new Blob([sdp])
    .stream()
    .pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Decompress a compressed SDP blob back into a string.
 * @param {Uint8Array} bytes
 * @param {"deflate-raw"|"gzip"|"deflate"} [format]
 * @returns {Promise<string>}
 */
export async function decompressSdp(bytes, format = CODEC_DEFAULT) {
  if (typeof DecompressionStream !== "function") {
    return new TextDecoder().decode(bytes);
  }
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream(format));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

/* ---------------- framing ---------------- */

const b64url = {
  encode(bytes) {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  },
  decode(str) {
    const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
    const bin = atob(str.replaceAll("-", "+").replaceAll("_", "/") + pad);
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  },
};

/**
 * Builds the indexed frame set for one SDP payload.
 * @param {string} sdp raw offer/answer string
 * @param {object} [opts]
 * @param {"deflate-raw"|"gzip"} [opts.codec]
 * @returns {Promise<{frames:string[], total:number, compressedBytes:number,
 *                     rawBytes:number, crc:number, codec:string}>}
 */
export async function generateOfferQR(sdp, { codec = CODEC_DEFAULT } = {}) {
  const raw = new TextEncoder().encode(String(sdp));
  const compressed = await compressSdp(String(sdp), codec);
  const crc = crc16(compressed);
  const total = Math.max(1, Math.ceil(compressed.length / SEGMENT_BYTES));

  const frames = [];
  for (let i = 0; i < total; i++) {
    const seg = compressed.slice(i * SEGMENT_BYTES, (i + 1) * SEGMENT_BYTES);
    frames.push(
      `GS1|${i}|${total}|${crc.toString(16).padStart(4, "0")}|${b64url.encode(seg)}`,
    );
  }

  return {
    frames,
    total,
    compressedBytes: compressed.length,
    rawBytes: raw.length,
    crc,
    codec,
  };
}

/**
 * Parses one scanned frame string. Tolerant: returns null on anything
 * malformed so a partially-read QR never crashes the receiver.
 * @param {string} text QR payload as scanned
 * @returns {{index:number,total:number,crc:number,segment:Uint8Array}|null}
 */
export function parseFrame(text) {
  if (typeof text !== "string" || !text.startsWith("GS1|")) return null;
  const parts = text.split("|");
  if (parts.length !== 5) return null;
  const [, idx, total, crcHex, b64] = parts;
  const index = Number.parseInt(idx, 10);
  const n = Number.parseInt(total, 10);
  const crc = Number.parseInt(crcHex, 16);
  if (!Number.isInteger(index) || !Number.isInteger(n) || Number.isNaN(crc))
    return null;
  if (n < 1 || index < 0 || index >= n) return null;
  let segment;
  try {
    segment = b64url.decode(b64);
  } catch {
    return null;
  }
  if (segment.length > SEGMENT_BYTES) return null;
  return { index, total: n, crc, segment };
}

/* ---------------- receiving / assembling ---------------- */

/** Live assembler slot: one concurrent transfer at a time. */
const rx = { total: 0, crc: 0, parts: null, codec: CODEC_DEFAULT };

/**
 * Feed a scanned frame into the assembler.
 * @param {string} text scanned QR payload
 * @returns {{complete:boolean, sdp?:string, progress:{got:number,total:number}}}
 * @throws {Error} "QR_CRC_MISMATCH" when the assembled blob fails checksum
 */
export async function ingestFrame(text) {
  const f = parseFrame(text);
  if (!f) return { complete: false, progress: snapshot() };

  // New transfer takes over (single-peer handshake: acceptable).
  if (f.total !== rx.total || f.crc !== rx.crc || !rx.parts) {
    rx.total = f.total;
    rx.crc = f.crc;
    rx.parts = new Array(f.total);
  }
  if (!rx.parts[f.index]) rx.parts[f.index] = f.segment;

  const got = rx.parts.filter(Boolean).length;
  if (got < f.total)
    return { complete: false, progress: { got, total: f.total } };

  const blob = new Uint8Array(rx.parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of rx.parts) {
    blob.set(p, off);
    off += p.length;
  }

  const expected = rx.crc;
  const codec = rx.codec;
  rx.total = 0;
  rx.parts = null;
  rx.crc = 0; // reset for next handshake

  const actual = crc16(blob);
  if (actual !== expected) {
    throw new Error(
      `QR_CRC_MISMATCH (got 0x${actual.toString(16)}, want 0x${expected.toString(16)})`,
    );
  }
  const sdp = await decompressSdp(blob, codec);
  return { complete: true, sdp, progress: { got, total: f.total } };
}

function snapshot() {
  return rx.parts
    ? { got: rx.parts.filter(Boolean).length, total: rx.total }
    : { got: 0, total: 0 };
}

/** Clears any in-progress receive (session purge safety). */
export function resetAssembler() {
  rx.total = 0;
  rx.crc = 0;
  rx.parts = null;
}

/* ================================================================
 * CAMERA SCANNER — BarcodeDetector with lightweight JS fallback
 * ================================================================
 * Usage (see QrCameraScanner below):
 *   const scanner = new QrCameraScanner(videoEl);
 *   const sdp = await scanner.start();   // resolves with the SDP
 *   // camera is stopped + LED off the instant the handshake completes
 * ================================================================ */

/**
 * Feature-detect the native BarcodeDetector; when absent, build a
 * minimal shape-compatible shim backed by jsQR if the bundler injected
 * one (window.jsQR), else null. The shim preserves the two members we
 * use: detect(source) and getSupportedFormats().
 */
function buildDetector(formats) {
  if (typeof BarcodeDetector === "function") {
    try {
      const det = new BarcodeDetector({ formats });
      return Promise.resolve(det);
    } catch (e) {
      return Promise.reject(new Error(`NO_QR_SUPPORT (${e?.message ?? e})`));
    }
  }
  if (typeof window !== "undefined" && typeof window.jsQR === "function") {
    return Promise.resolve({
      async detect(source) {
        const w = source.videoWidth || source.naturalWidth || source.width;
        const h = source.videoHeight || source.naturalHeight || source.height;
        if (!w || !h) return [];
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        ctx.drawImage(source, 0, 0);
        const frame = ctx.getImageData(0, 0, w, h);
        const res = window.jsQR(frame.data, w, h, { inversionAttempts: "attemptBoth" });
        return res ? [{ rawValue: res.data, format: "qr_code" }] : [];
      },
      async getSupportedFormats() {
        return ["qr_code"];
      },
    });
  }
  return Promise.reject(new Error("BarcodeDetector missing and no jsQR fallback"));
}

const log = (...a) => console.log("[qr-handshake]", ...a);

/**
 * Offline camera QR scanner: opens the rear camera, samples frames at
 * ~10 Hz, feeds every decoded QR string into the chunk assembler, and
 * resolves once the full SDP is reassembled + decompressed.
 *
 * Guarantee: the MediaStream is ALWAYS torn down (track.stop()) when
 * the handshake completes, fails, times out, or abort() is called —
 * which is what physically extinguishes the camera LED.
 */
export class QrCameraScanner {
  /**
   * @param {HTMLVideoElement|null} videoEl preview element (optional but
   *        strongly recommended for aiming)
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=90000] give-up window
   * @param {number} [opts.sampleHz=10] decode attempts per second
   * @param {AbortSignal} [opts.signal] external cancellation
   * @param {(progress:{got:number,total:number}) => void} [opts.onProgress]
   */
  constructor(videoEl = null, opts = {}) {
    this.videoEl = videoEl;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.sampleHz = opts.sampleHz ?? 10;
    this.signal = opts.signal ?? null;
    this.onProgress = opts.onProgress ?? null;

    this._stream = null;
    this._detector = null;
    this._loopTimer = null;
    this._timeoutTimer = null;
    this._stopped = false;
    this._lastValue = ""; // skip identical consecutive decodes
  }

  /**
   * Start the camera and resolve with the reassembled SDP string.
   * @param {"answer"|"offer"} [kind] only for logging
   * @returns {Promise<string>}
   */
  async start(kind = "answer") {
    resetAssembler();

    // 1. Detector — fail fast with actionable guidance.
    try {
      this._detector = await buildDetector(["qr_code"]);
    } catch (e) {
      throw new Error(
        `QR_SCANNER_UNSUPPORTED — ${e?.message ?? e}. Use Chrome/Edge (desktop or Android) or bundle the jsQR shim on window.jsQR.`,
      );
    }

    // 2. Camera. getUserMedia on non-HTTPS origins (except localhost)
    // throws NotAllowedError — surface that precisely.
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
        audio: false,
      });
    } catch (err) {
      this.stop();
      if (err?.name === "NotAllowedError" || err?.name === "SecurityError") {
        throw new Error("CAMERA_PERMISSION_DENIED — allow camera access over HTTPS or localhost.");
      }
      if (err?.name === "NotFoundError" || err?.name === "OverconstrainedError") {
        throw new Error("CAMERA_NOT_FOUND — no usable camera on this device.");
      }
      throw err;
    }

    if (this.videoEl) {
      this.videoEl.srcObject = this._stream;
      this.videoEl.setAttribute("playsinline", "true");
      await this.videoEl.play().catch(() => {});
    }

    // 3. Decode loop + give-up timer + external abort wiring.
    return new Promise((resolve, reject) => {
      this._timeoutTimer = setTimeout(() => {
        this.stop();
        reject(new Error("QR_SCAN_TIMEOUT — peer frames never completed."));
      }, this.timeoutMs);

      this.signal?.addEventListener(
        "abort",
        () => {
          this.stop();
          reject(new DOMException("QR scan aborted", "AbortError"));
        },
        { once: true },
      );

      const period = 1000 / this.sampleHz;
      const tick = async () => {
        if (this._stopped) return;
        try {
          const found = await this._detector.detect(this.videoEl ?? this._stream);
          for (const hit of found) {
            const value = hit.rawValue ?? hit.raw_value ?? "";
            if (!value || value === this._lastValue) continue;
            this._lastValue = value;
            const r = await ingestFrame(value);
            this.onProgress?.(r.progress);
            if (r.complete) {
              this.stop(); // camera LED off IMMEDIATELY (Requirement 4)
              log(`${kind} reassembled + decompressed (${r.progress.total} frames)`);
              resolve(r.sdp);
              return;
            }
          }
        } catch (err) {
          // CRC mismatch poisons the transfer — restart assembly cleanly.
          const msg = String(err?.message ?? err);
          if (msg.startsWith("QR_CRC_MISMATCH")) {
            console.warn("[qr-handshake] corrupt transfer — restarting assembly");
            resetAssembler();
            this._lastValue = "";
          } else if (!msg.startsWith("QR_")) {
            console.warn("[qr-handshake] decode tick error:", msg);
          }
        }
        if (!this._stopped) this._loopTimer = setTimeout(tick, period);
      };

      if (this.videoEl) {
        // Wait for real dimensions so canvas sampling isn't 0x0.
        if (this.videoEl.readyState >= 2) tick();
        else this.videoEl.onloadedmetadata = () => tick();
      } else {
        tick();
      }
    });
  }

  /**
   * Hard-stop the camera: stops every track (LED off), detaches the
   * preview, clears timers. Idempotent — safe to call from anywhere.
   */
  stop() {
    if (this._stopped) return;
    this._stopped = true;
    if (this._loopTimer) clearTimeout(this._loopTimer);
    if (this._timeoutTimer) clearTimeout(this._timeoutTimer);
    for (const track of this._stream?.getTracks?.() ?? []) {
      try {
        track.stop();
      } catch {
        /* already dead */
      }
    }
    if (this.videoEl && this.videoEl.srcObject) {
      this.videoEl.srcObject = null;
    }
    this._stream = null;
    this._detector = null;
    log("camera released — hardware LED off");
  }
}

/* ---------------- rendering (Requirement 3) ---------------- */

/**
 * Rasterize one QR payload onto a <canvas>.
 * The underlying encoder emits an SVG; serialize it, rasterize via
 * Image -> drawImage. Everything happens locally — no data: URL
 * fetch of remote resources, no network.
 *
 * @param {HTMLCanvasElement|null} canvasEl
 * @param {string} frameData frame string for this page
 * @returns {Promise<boolean>} true when drawn
 */
export async function renderToCanvas(canvasEl, frameData) {
  if (!canvasEl || !frameData) return false;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const drawn = await renderQrCodeAsync(svg, frameData);
  if (!drawn) return false;

  const xml = new XMLSerializer().serializeToString(svg);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;

  await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const px = canvasEl.width || 320;
      canvasEl.width = px;
      canvasEl.height = px;
      const ctx = canvasEl.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, px, px);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, px, px);
      resolve();
    };
    img.onerror = reject;
    img.src = url;
  });

  canvasEl.dataset.frame = frameData.slice(0, 24);
  return true;
}

/**
 * Animated multipage QR transmitter: cycles the frame set at 5 FPS,
 * looping until stopped. Returns a stop handle (also stops when the
 * canvas leaves the DOM).
 *
 * @param {HTMLCanvasElement} canvasEl
 * @param {string[]} frames frame strings from generateOfferQR()
 * @param {object} [opts]
 * @param {number} [opts.fps=5]
 * @param {(index:number,total:number)=>void} [opts.onFrame]
 * @returns {{stop:()=>void}}
 */
export function animateQrSequence(
  canvasEl,
  frames,
  { fps = FPS, onFrame } = {},
) {
  let stopped = false;
  let timer = null;
  let index = 0;

  const paint = async () => {
    if (stopped || !canvasEl.isConnected) return;
    const i = index % frames.length;
    try {
      await renderToCanvas(canvasEl, frames[i]);
      onFrame?.(i, frames.length);
    } catch (err) {
      console.warn("[qr-handshake] frame paint failed:", err?.message ?? err);
    }
    index++;
    if (!stopped) timer = setTimeout(paint, 1000 / fps);
  };
  paint();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Convenience one-shot: compress + frame + render the FIRST page
 * (or run the whole animation) for an SDP offer.
 * @param {string} sdp
 * @param {object} [opts] { canvas, fps, onFrame, animate }
 */
export async function generateOfferQrHandshake(sdp, opts = {}) {
  const { frames, total, compressedBytes, rawBytes, crc } =
    await generateOfferQR(sdp);
  const ratio = rawBytes ? (1 - compressedBytes / rawBytes) * 100 : 0;
  console.log(
    `[qr-handshake] SDP ${rawBytes}B -> ${compressedBytes}B (${ratio.toFixed(0)}% smaller), ${total} frame(s) @ ${FPS} FPS`,
  );
  if (opts.canvas && opts.animate !== false) {
    animateQrSequence(opts.canvas, frames, {
      fps: opts.fps,
      onFrame: opts.onFrame,
    });
  } else if (opts.canvas) {
    await renderToCanvas(opts.canvas, frames[0]);
  }
  return { frames, total, crc };
}
