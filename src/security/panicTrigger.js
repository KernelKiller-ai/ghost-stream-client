/* ============================================================
 * GHOST-STREAM // panicTrigger.js
 * Defensive shields + instant zeroization triggers.
 *
 *  1. Page Visibility API — tab hidden/minimized/backgrounded:
 *       - viewport canvas blurred 40px
 *       - video rendering paused
 *  2. ESC pressed twice rapidly (<600ms apart) OR 3-finger tap ->
 *     autoPurge.destroySession() (full zeroization)
 *  3. Right-click context menu suppressed; copy/cut/paste and
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
let _hooks = { onPanic: null, onBlur: null, onUnblur: null };

/* ---------------- small helpers ---------------- */

function addEventListener(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  _cleanups.push(() => target.removeEventListener(type, fn, opts));
}

function isVideoElement(el) {
  return el instanceof HTMLVideoElement;
}

function stopEvent(event) {
  event.preventDefault();
  event.stopPropagation();
}

/* ============================================================
 * 1. Page Visibility shield — blur + pause on hide
 * ============================================================ */

/** Apply the visual blackout. Safe to call directly (e.g. from app.js). */
export function blurViewport() {
  document.body.style.filter = "blur(40px)";
  document.body.style.transition = "filter 120ms ease";
  for (const video of document.querySelectorAll("video")) {
    if (!video.paused) video.pause();
    video.setAttribute("data-ghost-paused", "1");
  }
  _hooks.onBlur?.();
}

/** Lift the blackout and resume videos we paused ourselves. */
export function unblurViewport() {
  document.body.style.filter = "";
  for (const video of document.querySelectorAll(
    'video[data-ghost-paused="1"]',
  )) {
    video.removeAttribute("data-ghost-paused");
    video.play?.().catch(() => {
      /* autoplay guard */
    });
  }
  _hooks.onUnblur?.();
}

function installVisibilityShield() {
  addEventListener(document, "visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      blurViewport(); // minimize / tab switch / background
    } else if (!_destroyed) {
      unblurViewport(); // only we restore it, and only if the session lives
    }
  });

  // Belt-and-braces: window blur (e.g. clicking another app without
  // minimizing) also blurs; focus restores unless purged.
  addEventListener(window, "blur", () => blurViewport());
  addEventListener(window, "focus", () => {
    if (!_destroyed) unblurViewport();
  });
}

/* ============================================================
 * 2. Panic triggers — double-ESC + touch gestures
 * ============================================================ */

/**
 * Arm the panic triggers. `onPanic` is invoked before the purge so
 * the UI can flash a warning; the purge itself runs either way.
 *
 * @param {{ onPanic?: () => void }} [options]
 */
export function armPanicTriggers(options = {}) {
  _hooks.onPanic =
    typeof options.onPanic === "function" ? options.onPanic : _hooks.onPanic;

  // --- Double-ESC (within DOUBLE_ESC_WINDOW_MS) ---
  addEventListener(window, "keydown", (event) => {
    if (event.key !== "Escape") {
      _lastEscAt = 0; // any other key resets the sequence
      return;
    }
    const now = performance.now();
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
      if (event.touches.length >= 3) triggerZeroization();
    },
    { passive: true },
  );

  // --- Touch: 4-finger long-press (>800ms) also triggers ---
  let holdTimer = null;
  addEventListener(
    window,
    "touchstart",
    (event) => {
      if (event.touches.length === 4) {
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

/** Fire the zeroization: hook, purge, shields down. */
export function triggerZeroization() {
  if (_destroyed) return; // idempotent
  _destroyed = true;
  try {
    _hooks.onPanic?.();
  } catch {
    /* UI must not block the purge */
  }
  autoPurge.destroySession();
}

/* ============================================================
 * 3. Input/clipboard hardening
 * ============================================================ */

/**
 * Suppress the context menu, copy/cut/paste, and drag-out of
 * sensitive viewports. `selector` scopes the block; the whole
 * document is covered when omitted (chat input stays usable by
 * explicitly being exempted unless includeChat is set).
 *
 * @param {string} [selector] e.g. ".video-primary, .video-pip"
 * @param {{ includeChat?: boolean }} [options]
 */
export function installClipboardShield(selector = null, options = {}) {
  const sensitive = selector
    ? Array.from(document.querySelectorAll(selector))
    : [document];

  const exempt = (event) => {
    if (options.includeChat) return false;
    // The chat composer must remain typable/selectable.
    return event.target.closest?.("#chatInput");
  };

  for (const scope of sensitive) {
    addEventListener(scope, "contextmenu", (e) => {
      if (!exempt(e)) stopEvent(e);
    });

    for (const type of ["copy", "cut", "paste"]) {
      addEventListener(scope, type, (e) => {
        if (exempt(e)) return;
        stopEvent(e);
        // Scrub the clipboard payload on copy attempts.
        try {
          if (e.clipboardData) e.clipboardData.setData("text/plain", "");
        } catch {
          /* ignore */
        }
      });
    }

    // Block dragging media/images out of the viewport.
    addEventListener(scope, "dragstart", (e) => {
      if (!exempt(e)) stopEvent(e);
    });

    if (scope && typeof scope.addEventListener === "function") {
      addEventListener(scope, "selectstart", (e) => {
        if (!exempt(e)) stopEvent(e);
      });
    }
  }
}

/** Kill keyboard text-selection shortcuts (Ctrl+C/X/A/S/P) globally. */
export function installKeyShield() {
  addEventListener(window, "keydown", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    const key = event.key.toLowerCase();
    if (
      ["c", "x", "a", "s", "p"].includes(key) &&
      !event.target.closest?.("#chatInput")
    ) {
      stopEvent(event);
    }
  });
}

/* ============================================================
 * Lifecycle
 * ============================================================ */

/**
 * Install every shield. Idempotent — a second call is a no-op.
 * @param {{ selector?: string, includeChat?: boolean,
 *           onPanic?: Function, onBlur?: Function, onUnblur?: Function }} [options]
 */
export function install(options = {}) {
  if (_installed || typeof document === "undefined") return;
  _installed = true;

  if (typeof options.onBlur === "function") _hooks.onBlur = options.onBlur;
  if (typeof options.onUnblur === "function")
    _hooks.onUnblur = options.onUnblur;

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
    } catch {
      /* ignore */
    }
  }
  _installed = false;
  _destroyed = false;
  _lastEscAt = 0;
  _hooks = { onPanic: null, onBlur: null, onUnblur: null };
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
  installClipboardShield,
  status,
};
