/* ============================================================
 * GHOST-STREAM // mediaStream.js
 * Local media acquisition + live track control.
 *
 *  - getUserMedia({ video: true, audio: true }) with graceful
 *    fallbacks (permission denied -> audio-only -> nothing)
 *  - Dynamic mic mute / camera disable (track.enabled flips,
 *    nothing is renegotiated or stopped)
 *  - Instant teardown: stop every track, drop the reference
 * ============================================================ */

/**
 * @typedef {object} MediaResult
 * @property {MediaStream|null} stream      the acquired stream (null = no media)
 * @property {"full"|"audio-only"|"video-only"|"none"} mode what we ended up with
 * @property {Error|null} error             why the richer fallback was skipped
 */

/** getUserMedia constraint sets, tried in descending richness. */
const FALLBACK_LADDER = [
  {
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: "user",
    },
    audio: { echoCancellation: true, noiseSuppression: true },
  },
  { video: true, audio: true }, // simplest full attempt
  { video: false, audio: true }, // audio-only fallback
  { video: true, audio: false }, // video-only fallback
];

export class MediaStreamController {
  constructor() {
    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {"full"|"audio-only"|"video-only"|"none"} */
    this.mode = "none";
    /** @type {Error|null} */
    this.lastError = null;
    this._muted = false;
    this._cameraOff = false;
  }

  /* ---------------- acquisition ---------------- */

  /**
   * Acquire local media. Tries video+audio first; on failure walks a
   * fallback ladder (audio-only, then video-only). Never throws.
   * @returns {Promise<MediaResult>}
   */
  async acquire() {
    await this._ensureHttpsContext();

    // Yield to the event loop so any pending UI rendering/paints take place
    // before the browser triggers hardware media acquisition.
    await new Promise((resolve) => setTimeout(resolve, 0));

    for (const constraints of FALLBACK_LADDER) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        this.stream = stream;
        this.mode =
          constraints.video && constraints.audio
            ? "full"
            : constraints.audio
              ? "audio-only"
              : "video-only";
        this._muted = false;
        this._cameraOff = false;
        return { stream, mode: this.mode, error: null };
      } catch (err) {
        this.lastError = err;
        // If permission was denied for video+audio, do not repeatedly re-request
        // redundant full constraints that will synchronously block or prompt again.
        if (err.name === "NotAllowedError" || err.name === "SecurityError") {
          if (constraints.video && constraints.audio) {
            // Skip simplest full attempt and jump directly to audio-only
            continue;
          }
          break; // Permission definitively denied by user
        }
        continue;
      }
    }

    // Everything denied/unavailable — operate without local media.
    this.stream = null;
    this.mode = "none";
    return { stream: null, mode: "none", error: this.lastError };
  }

  /**
   * Explain why acquisition failed, for UI messaging.
   * @returns {string}
   */
  describeFailure() {
    const err = this.lastError;
    if (!err) return "media unavailable";
    switch (err.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "camera/microphone permission denied";
      case "NotFoundError":
      case "OverconstrainedError":
        return "no camera or microphone found";
      case "NotReadableError":
        return "camera/microphone already in use by another app";
      default:
        return `media error: ${err.name || "unknown"}`;
    }
  }

  /* ---------------- live track control ---------------- */

  /** @returns {boolean} whether audio is currently flowing */
  get audioEnabled() {
    return this._audioTracks().some(
      (t) => t.enabled && t.readyState === "live",
    );
  }

  /** @returns {boolean} whether video is currently flowing */
  get videoEnabled() {
    return this._videoTracks().some(
      (t) => t.enabled && t.readyState === "live",
    );
  }

  /**
   * Mute / unmute the microphone. Toggles `track.enabled` only —
   * the track stays live and no renegotiation occurs.
   * @param {boolean} [enabled] omit to toggle
   * @returns {boolean} resulting audio state (true = unmuted)
   */
  toggleMute(enabled) {
    const target = typeof enabled === "boolean" ? enabled : !this.audioEnabled;
    for (const track of this._audioTracks()) track.enabled = target;
    this._muted = !target;
    return target;
  }

  /**
   * Enable / disable the camera. Toggles `track.enabled` only.
   * @param {boolean} [enabled] omit to toggle
   * @returns {boolean} resulting video state (true = sending)
   */
  toggleCamera(enabled) {
    const target = typeof enabled === "boolean" ? enabled : !this.videoEnabled;
    for (const track of this._videoTracks()) track.enabled = target;
    this._cameraOff = !target;
    return target;
  }

  /* ---------------- teardown ---------------- */

  /**
   * Instant teardown: stop every track hard, release devices
   * (camera/mic indicator turns off), drop the reference.
   * @returns {{ stopped: number }}
   */
  teardown() {
    let stopped = 0;
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
          stopped++;
        } catch {
          /* already stopped */
        }
      }
      this.stream = null;
    }
    this.mode = "none";
    this.lastError = null;
    this._muted = false;
    this._cameraOff = false;
    return { stopped };
  }

  /* ---------------- internals ---------------- */

  _audioTracks() {
    return this.stream ? this.stream.getAudioTracks() : [];
  }

  _videoTracks() {
    return this.stream ? this.stream.getVideoTracks() : [];
  }

  /**
   * getUserMedia requires a secure context. On http:// (except
   * localhost) we fail fast with a clear error instead of a
   * cryptic undefined navigator.mediaDevices.
   */
  async _ensureHttpsContext() {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      const insecure =
        typeof location !== "undefined" &&
        location.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
      throw new Error(
        insecure
          ? "getUserMedia requires HTTPS (or localhost) — serving over http://"
          : "mediaDevices.getUserMedia unavailable in this browser",
      );
    }
  }
}

export default MediaStreamController;
