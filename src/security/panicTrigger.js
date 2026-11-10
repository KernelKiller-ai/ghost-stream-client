/* ============================================================
 * GHOST-STREAM // panicTrigger.js
 * Defensive shields + instant zeroization triggers.
 *
 *  1. Page Visibility API — tab hidden/minimized/backgrounded:
 *       - viewport blurred 40px
 *       - video rendering paused
 *  2. ESC pressed twice rapidly (<600ms apart) OR 3-finger tap ->
 *     autoPurge.destroySession() (full zeroization)
 *  3. Bidirectional remote kill-switch:
 *       - broadcast FORCE_REMOTE_PURGE to peer
 *       - obliterate DOM with "SESSION OBLITERATED" lockout screen
 *  4. Right-click context menu suppressed; copy/cut/paste and
 *     text selection blocked over sensitive viewports.
 * ============================================================ */

import * as autoPurge from "../memory/autoPurge.js";

/** Double-ESC window (ms) that arms the panic trigger. */
const DOUBLE_ESC_WINDOW_MS = 600;

/* ============================================================
 * Module state
 * ============================================================ */
let _installed = false;
let _destroyed = false;
let _lastEscAt = 0;
const _cleanups = []; // every listener we install, for uninstall()
let _hooks = {
  onPanic: null,
  onBlur: null,
  onUnblur: null,
  onBroadcastPurge: null,
};

/* ---------------- small helpers ---------------- */

function addEventListener(target, type, fn, opts) {
  if (!target || typeof target.addEventListener !== "function") return;
  target.addEventListener(type, fn, opts);
  _cleanups.push(() => {
    try {
      target.removeEventListener(type, fn, opts);
    } catch {}
  });
}

function stopEvent(event) {
  if (!event) return;
  try {
    event.preventDefault();
    event.stopPropagation();
  } catch {}
}

/* ============================================================
 * 1. Page Visibility shield — blur + pause on hide
 * ============================================================ */

/** Apply the visual blackout. Safe to call directly. */
export function blurViewport() {
  if (typeof document === "undefined" || !document.body) return;
  document.body.style.filter = "blur(40px)";
  document.body.style.transition = "filter 120ms ease";
  const videos = document.querySelectorAll ? document.querySelectorAll("video") : [];
  for (const video of videos) {
    if (!video.paused && typeof video.pause === "function") video.pause();
    if (typeof video.setAttribute === "function") {
      video.setAttribute("data-ghost-paused", "1");
    }
  }
  _hooks.onBlur?.();
}

/** Lift the blackout and resume videos we paused ourselves. */
export function unblurViewport() {
  if (typeof document === "undefined" || !document.body) return;
  document.body.style.filter = "";
  const videos = document.querySelectorAll
    ? document.querySelectorAll('video[data-ghost-paused="1"]')
    : [];
  for (const video of videos) {
    if (typeof video.removeAttribute === "function") {
      video.removeAttribute("data-ghost-paused");
    }
    video.play?.().catch?.(() => {});
  }
  _hooks.onUnblur?.();
}

function installVisibilityShield() {
  if (typeof document === "undefined") return;

  addEventListener(document, "visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      blurViewport(); // minimize / tab switch / background
    } else if (!_destroyed) {
      unblurViewport(); // restore only if session lives
    }
  });

  if (typeof window !== "undefined") {
    addEventListener(window, "blur", () => blurViewport());
    addEventListener(window, "focus", () => {
      if (!_destroyed) unblurViewport();
    });
  }
}

/* ============================================================
 * 2. Panic triggers — double-ESC + touch gestures + kill-switch
 * ============================================================ */

/**
 * Render the minimalist "SESSION OBLITERATED" lockout screen in the DOM.
 */
export function renderObliteratedScreen() {
  if (typeof document === "undefined") return;

  // Unblur viewport first so lockout screen is crisp
  if (document.body && document.body.style) {
    document.body.style.filter = "";
  }

  // If the pre-baked lockout modal exists in DOM, activate it
  const lockoutEl = document.getElementById?.("lockoutScreen");
  if (lockoutEl && typeof lockoutEl.classList?.remove === "function") {
    lockoutEl.classList.remove("hidden");
    const shell = document.getElementById?.("shell");
    if (shell && typeof shell.classList?.add === "function") {
      shell.classList.add("hidden");
    }
  }

  // In standard browser environment, also overwrite document root
  try {
    if (
      document.documentElement &&
      typeof document.documentElement.replaceChildren === "function"
    ) {
      document.documentElement.replaceChildren();

      const style = document.createElement("style");
      style.textContent = [
        "*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }",
        "html, body {",
        "  width: 100%; height: 100dvh; height: 100vh;",
        "  background: #070b0e !important; color: #ff3366 !important;",
        "  font-family: ui-monospace, 'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace !important;",
        "  display: flex !important; align-items: center !important; justify-content: center !important;",
        "  overflow: hidden !important; user-select: none !important;",
        "}",
        ".lockout-box {",
        "  text-align: center; padding: 2.5rem 2rem;",
        "  background: #0d151c; border: 1px solid rgba(255, 51, 102, 0.4);",
        "  border-radius: 8px; box-shadow: 0 0 60px rgba(255, 51, 102, 0.15);",
        "  max-width: 440px; margin: 1.5rem;",
        "}",
        ".lockout-icon { font-size: 2.75rem; color: #ff3366; margin-bottom: 1rem; }",
        ".lockout-eyebrow {",
        "  display: block; font-size: 0.6875rem; letter-spacing: 0.25em;",
        "  color: #627d98; margin-bottom: 0.5rem; text-transform: uppercase;",
        "}",
        ".lockout-title {",
        "  font-size: 1.25rem; font-weight: 700; letter-spacing: 0.15em;",
        "  text-transform: uppercase; margin-bottom: 0.75rem; color: #ff3366;",
        "}",
        ".lockout-desc {",
        "  font-size: 0.8125rem; line-height: 1.6; color: #627d98;",
        "  letter-spacing: 0.05em; margin-bottom: 1.5rem;",
        "}",
        ".lockout-badge {",
        "  display: inline-block; font-size: 0.6875rem; letter-spacing: 0.2em;",
        "  padding: 0.4rem 0.8rem; border: 1px dashed rgba(255, 51, 102, 0.5);",
        "  color: #ff3366; background: rgba(255, 51, 102, 0.05);",
        "}",
      ].join("\n");

      const box = document.createElement("div");
      box.className = "lockout-box";

      const icon = document.createElement("div");
      icon.className = "lockout-icon";
      icon.textContent = "⚠";

      const eyebrow = document.createElement("span");
      eyebrow.className = "lockout-eyebrow";
      eyebrow.textContent = "HARD SECURITY KILL-SWITCH";

      const title = document.createElement("h1");
      title.className = "lockout-title";
      title.textContent = "SESSION OBLITERATED";

      const desc = document.createElement("p");
      desc.className = "lockout-desc";
      desc.textContent =
        "RAM buffers zeroized. WebRTC peer connections severed. Camera & mic hardware released. All volatile state purged.";

      const badge = document.createElement("div");
      badge.className = "lockout-badge";
      badge.textContent = "ZERO TRACES RETAINED // LOCKOUT ACTIVE";

      if (typeof box.append === "function") {
        box.append(icon, eyebrow, title, desc, badge);
      } else if (typeof box.appendChild === "function") {
        box.appendChild(icon);
        box.appendChild(eyebrow);
        box.appendChild(title);
        box.appendChild(desc);
        box.appendChild(badge);
      }

      const body = document.createElement("body");
      if (typeof body.append === "function") {
        body.append(style, box);
      } else if (typeof body.appendChild === "function") {
        body.appendChild(style);
        body.appendChild(box);
      }
      if (typeof document.documentElement.appendChild === "function") {
        document.documentElement.appendChild(body);
      }
    }
  } catch (err) {
    console.error("[panicTrigger] renderObliteratedScreen error:", err);
  }
}

/**
 * Arm the panic triggers: double-ESC and multi-touch gestures.
 * @param {{ onPanic?: () => void, onBroadcastPurge?: () => void }} [options]
 */
export function armPanicTriggers(options = {}) {
  if (typeof options.onPanic === "function") {
    _hooks.onPanic = options.onPanic;
  }
  if (typeof options.onBroadcastPurge === "function") {
    _hooks.onBroadcastPurge = options.onBroadcastPurge;
  }

  if (typeof window === "undefined") return;

  // --- Double-ESC (within DOUBLE_ESC_WINDOW_MS) ---
  addEventListener(window, "keydown", (event) => {
    if (event.key !== "Escape") {
      _lastEscAt = 0; // any other key resets the sequence
      return;
    }
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - _lastEscAt <= DOUBLE_ESC_WINDOW_MS) {
      _lastEscAt = 0;
      triggerZeroization();
    } else {
      _lastEscAt = now;
    }
  });

  // --- Touch: 3-finger tap anywhere triggers the purge ---
  addEventListener(
    window,
    "touchstart",
    (event) => {
      if (event.touches && event.touches.length >= 3) {
        triggerZeroization();
      }
    },
    { passive: true },
  );

  // --- Touch: 4-finger long-press (>800ms) also triggers ---
  let holdTimer = null;
  addEventListener(
    window,
    "touchstart",
    (event) => {
      if (event.touches && event.touches.length === 4) {
        holdTimer = setTimeout(triggerZeroization, 800);
      }
    },
    { passive: true },
  );
  addEventListener(window, "touchend", () => clearTimeout(holdTimer), {
    passive: true,
  });
  addEventListener(window, "touchmove", () => clearTimeout(holdTimer), {
    passive: true,
  });
}

/** Fire the zeroization: broadcast remote purge, wipe RAM, kill media, lockout DOM. */
export function triggerZeroization() {
  if (_destroyed) return; // idempotent
  _destroyed = true;

  try {
    _hooks.onBroadcastPurge?.();
  } catch {}

  try {
    _hooks.onPanic?.();
  } catch {}

  renderObliteratedScreen();
  autoPurge.destroySession();
}

/* ============================================================
 * 3. Input/clipboard hardening
 * ============================================================ */

/**
 * Suppress context menu, copy/cut/paste, and drag-out of sensitive viewports.
 * @param {string} [selector] e.g. ".stage, .video-container"
 * @param {{ includeChat?: boolean }} [options]
 */
export function installClipboardShield(selector = null, options = {}) {
  if (typeof document === "undefined") return;

  const sensitive = selector && document.querySelectorAll
    ? Array.from(document.querySelectorAll(selector))
    : [document];

  const exempt = (event) => {
    if (options.includeChat) return false;
    return event?.target?.closest?.("#chatInput");
  };

  for (const scope of sensitive) {
    if (!scope) continue;

    addEventListener(scope, "contextmenu", (e) => {
      if (!exempt(e)) stopEvent(e);
    });

    for (const type of ["copy", "cut", "paste"]) {
      addEventListener(scope, type, (e) => {
        if (exempt(e)) return;
        stopEvent(e);
        try {
          if (e.clipboardData) e.clipboardData.setData("text/plain", "");
        } catch {}
      });
    }

    addEventListener(scope, "dragstart", (e) => {
      if (!exempt(e)) stopEvent(e);
    });

    if (typeof scope.addEventListener === "function") {
      addEventListener(scope, "selectstart", (e) => {
        if (!exempt(e)) stopEvent(e);
      });
    }
  }
}

/** Kill keyboard text-selection shortcuts (Ctrl+C/X/A/S/P) globally. */
export function installKeyShield() {
  if (typeof window === "undefined") return;

  addEventListener(window, "keydown", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    const key = (event.key || "").toLowerCase();
    if (
      ["c", "x", "a", "s", "p"].includes(key) &&
      !event.target?.closest?.("#chatInput")
    ) {
      stopEvent(event);
    }
  });
}

/* ============================================================
 * Lifecycle
 * ============================================================ */

/**
 * Install every shield. Idempotent.
 * @param {{ selector?: string, includeChat?: boolean,
 *           onPanic?: Function, onBroadcastPurge?: Function,
 *           onBlur?: Function, onUnblur?: Function }} [options]
 */
export function install(options = {}) {
  if (_installed || typeof document === "undefined") return;
  _installed = true;

  if (typeof options.onBlur === "function") _hooks.onBlur = options.onBlur;
  if (typeof options.onUnblur === "function") _hooks.onUnblur = options.onUnblur;
  if (typeof options.onPanic === "function") _hooks.onPanic = options.onPanic;
  if (typeof options.onBroadcastPurge === "function") {
    _hooks.onBroadcastPurge = options.onBroadcastPurge;
  }

  installVisibilityShield();
  armPanicTriggers(options);
  installClipboardShield(options.selector, options);
  installKeyShield();
}

/** Tear every listener down (used by tests / session re-init). */
export function uninstall() {
  for (const fn of _cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
  _installed = false;
  _destroyed = false;
  _lastEscAt = 0;
  _hooks = { onPanic: null, onBlur: null, onUnblur: null, onBroadcastPurge: null };
  unblurViewport();
}

/** @returns {{ installed: boolean, destroyed: boolean }} */
export function status() {
  return { installed: _installed, destroyed: _destroyed };
}

export default {
  install,
  uninstall,
  blurViewport,
  unblurViewport,
  triggerZeroization,
  renderObliteratedScreen,
  installClipboardShield,
  status,
};
