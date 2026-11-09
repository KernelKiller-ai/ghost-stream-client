/* ============================================================
 * GHOST-STREAM // autoPurge.js
 * Reverse countdown controller + total session destructor.
 *
 * Flow:
 *   1. startSession()      -> arms a 7200s (2h) reverse countdown
 *   2. every 1s            -> emits {remaining, formatted} to UI
 *   3. t = 0 OR trigger()  -> destroySession():
 *        a) stop() every WebRTC media track
 *        b) close data channels + peer connections
 *        c) wipeStore() + nullify references
 *        d) blank the viewport (about:blank) / clean reset
 * ============================================================ */

/** 2-hour session budget, in seconds. */
export const SESSION_TTL_SECONDS = 7200;

/**
 * The store to wipe on purge. Default: the volatileBuffer module.
 * Injected via init() so the purge has no hard import cycle.
 */
let _wipeStore = () => {};
let _teardownHandler = null;

/** Live UI hooks (all optional — the controller degrades gracefully). */
let _hooks = {
  onTick: null, // ({ remainingSeconds, formatted }) => void
  onPurgeStart: null, // () => void
  onPurgeComplete: null, // () => void
};

/** Countdown state. */
let _intervalId = null;
let _deadlineMs = 0; // absolute epoch ms when session dies
let _armed = false;
let _destroyed = false;

/** References to media/peer objects, held weakly-ish for teardown. */
let _tracks = []; // MediaStreamTrack[]
let _peerConnections = []; // RTCPeerConnection[]
let _dataChannels = []; // RTCDataChannel[]

/* ---------- small helpers ---------- */

const pad = (n) => String(n).padStart(2, "0");

/** @param {number} totalSeconds -> "HH:MM:SS" */
export function formatRemaining(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * Configure the controller.
 * @param {{ wipeStore?: () => void, onTick?: Function,
 *           onPurgeStart?: Function, onPurgeComplete?: Function }} [options]
 */
export function init(options = {}) {
  if (typeof options.wipeStore === "function") _wipeStore = options.wipeStore;
  _hooks = {
    onTick: typeof options.onTick === "function" ? options.onTick : null,
    onPurgeStart:
      typeof options.onPurgeStart === "function" ? options.onPurgeStart : null,
    onPurgeComplete:
      typeof options.onPurgeComplete === "function"
        ? options.onPurgeComplete
        : null,
  };
}

/**
 * Register app-specific cleanup to run during each session purge.
 * The handler remains registered across session reinitialization.
 * @param {(() => void | Promise<void>) | null} handler
 */
export function setTeardownHandler(handler) {
  if (handler !== null && typeof handler !== "function") {
    throw new TypeError("teardown handler must be a function or null");
  }
  _teardownHandler = handler;
}

/**
 * Register WebRTC objects for guaranteed teardown.
 * Accepts RTCPeerConnection | RTCDataChannel | MediaStreamTrack |
 * MediaStream — each is classified automatically.
 */
export function registerForTeardown(...resources) {
  for (const res of resources) {
    if (!res) continue;
    if (typeof res.stop === "function" && res.kind !== undefined) {
      _tracks.push(res); // MediaStreamTrack
    } else if (
      typeof res.close === "function" &&
      res.signalingState !== undefined
    ) {
      _peerConnections.push(res); // RTCPeerConnection
    } else if (
      typeof res.close === "function" &&
      res.readyState !== undefined
    ) {
      _dataChannels.push(res); // RTCDataChannel
    } else if (typeof res.getTracks === "function") {
      _tracks.push(...res.getTracks()); // MediaStream
    }
  }
}

/** Forget registered resources without stopping them (used on reset). */
export function resetRegistry() {
  _tracks.length = 0;
  _peerConnections.length = 0;
  _dataChannels.length = 0;
}

/**
 * Arm the 2-hour reverse countdown. Call once the room connection
 * is established.
 * @param {number} [ttlSeconds] override (default 7200)
 * @returns {{ deadlineMs: number }} the absolute purge deadline
 */
export function startSession(ttlSeconds = SESSION_TTL_SECONDS) {
  if (_intervalId !== null) clearInterval(_intervalId);

  _armed = true;
  _destroyed = false;
  _deadlineMs = Date.now() + ttlSeconds * 1000;

  // Drift-proof: recompute remaining from the absolute deadline each tick.
  _intervalId = setInterval(_tick, 1000);
  _tick();

  return { deadlineMs: _deadlineMs };
}

/** Stop the active countdown without destroying session resources. */
export function stopSession() {
  if (_intervalId !== null) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
  _armed = false;
  _deadlineMs = 0;
}

/** Internal per-second tick -> emits countdown to the UI. */
function _tick() {
  const remainingSeconds = Math.max(
    0,
    Math.ceil((_deadlineMs - Date.now()) / 1000),
  );
  if (typeof _hooks.onTick === "function") {
    try {
      _hooks.onTick({
        remainingSeconds,
        formatted: formatRemaining(remainingSeconds),
      });
    } catch {
      /* UI errors must never break the purge path */
    }
  }
  if (remainingSeconds <= 0 && _armed) {
    destroySession();
  }
}

/**
 * EMERGENCY / EXPIRY TRIGGER — total session destruction.
 * Safe to call more than once; idempotent after the first run.
 * @returns {Promise<void>}
 */
export async function destroySession() {
  if (_destroyed) return;
  _destroyed = true;
  _armed = false;

  if (_intervalId !== null) {
    clearInterval(_intervalId);
    _intervalId = null;
  }

  try {
    _hooks.onPurgeStart?.();
  } catch {
    /* ignore */
  }

  /* (a) Terminate all media tracks. */
  const tracks = _tracks.splice(0, _tracks.length);
  for (const track of tracks) {
    try {
      track.stop();
    } catch {
      /* already dead */
    }
  }

  /* (b) Close data channels first, then peer connections. */
  const channels = _dataChannels.splice(0, _dataChannels.length);
  for (const ch of channels) {
    try {
      if (ch.readyState !== "closed") ch.close();
    } catch {
      /* ignore */
    }
  }
  const peers = _peerConnections.splice(0, _peerConnections.length);
  for (const pc of peers) {
    try {
      if (pc.signalingState !== "closed") pc.close();
    } catch {
      /* ignore */
    }
  }

  /* (c) Wipe the message store and nullify references synchronously in RAM. */
  try {
    _wipeStore();
  } catch {
    /* wipe must never be skipped */
  }
  _wipeStore = () => {};
  _hooks.onTick = null;
  _hooks.onPurgeStart = null;
  _deadlineMs = 0;

  try {
    const teardownResult = _teardownHandler?.();
    if (teardownResult && typeof teardownResult.then === "function") {
      await teardownResult;
    }
  } catch (error) {
    console.error("[AutoPurge] Custom teardown handler failed:", error);
  }

  try {
    _hooks.onPurgeComplete?.();
  } catch {
    /* ignore */
  }

  /* (d) Blank the viewport. */
  _blankViewport();
}

/**
 * Viewport destruction — move the browsing context to about:blank
 * when possible; otherwise reset the DOM to a clean tactical state.
 */
function _blankViewport() {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  // Full navigation (preferred): leaves nothing of the app rendered.
  try {
    window.location.replace("about:blank");
    return; // navigation initiated
  } catch {
    // Sandboxed iframe may refuse navigation — fall through to reset.
  }

  // Clean reset fallback: strip the document down to a purge notice.
  document.documentElement.replaceChildren();
  const head = document.createElement("head");
  head.appendChild(
    Object.assign(document.createElement("meta"), {
      name: "viewport",
      content: "width=device-width, initial-scale=1",
    }),
  );
  head.appendChild(
    Object.assign(document.createElement("title"), {
      textContent: "SESSION TERMINATED",
    }),
  );
  const style = document.createElement("style");
  style.textContent = [
    "html,body{height:100%;margin:0;background:#0a0a0c;color:#3dff88;",
    "font:13px/1.6 monospace;display:grid;place-items:center;",
    "letter-spacing:.25em;text-transform:uppercase}",
  ].join("");
  head.appendChild(style);
  document.documentElement.appendChild(head);
  document.documentElement.appendChild(
    Object.assign(document.createElement("body"), {
      textContent: "[ session purged — no trace retained ]",
    }),
  );
}

/**
 * Re-arm a fresh session (used by the purge overlay's
 * "RE-INITIALIZE" path). Resets internal state and registry.
 * @param {number} [ttlSeconds]
 */
export function reinitialize(ttlSeconds = SESSION_TTL_SECONDS) {
  resetRegistry();
  _destroyed = false;
  _armed = false;
  if (_intervalId !== null) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
  return startSession(ttlSeconds);
}

/** @returns {{ armed: boolean, destroyed: boolean, remainingSeconds: number }} */
export function status() {
  return {
    armed: _armed,
    destroyed: _destroyed,
    remainingSeconds:
      _armed || _intervalId !== null
        ? Math.max(0, Math.ceil((_deadlineMs - Date.now()) / 1000))
        : 0,
  };
}

export default {
  SESSION_TTL_SECONDS,
  init,
  startSession,
  stopSession,
  destroySession,
  setTeardownHandler,
  reinitialize,
  registerForTeardown,
  resetRegistry,
  status,
  formatRemaining,
};
