/* ============================================================
 * GHOST-STREAM // renderView.js
 * Presentation-layer helpers. Everything here is ephemeral:
 * text is rendered straight into the DOM display and mirrored
 * in an in-memory ring only — never localStorage, never
 * sessionStorage, never IndexedDB.
 * ============================================================ */

/* ---------- Countdown timer ---------- */

/** Total volatile-session budget: 2 hours, in milliseconds. */
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

/** Milliseconds remaining before purge triggers the red warning state. */
const WARN_THRESHOLD_MS = 10 * 60 * 1000; // last 10 minutes

/**
 * Format a millisecond duration as HH:MM:SS.
 * @param {number} ms remaining duration (clamped at 0)
 * @returns {string} "HH:MM:SS"
 */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/**
 * Push a countdown value into the header clock element.
 * @param {HTMLElement} clockEl <time> element
 * @param {number} msRemaining
 */
export function renderCountdown(clockEl, msRemaining) {
  if (!clockEl) return;
  clockEl.textContent = formatCountdown(msRemaining);
  clockEl.dataset.warning = String(
    msRemaining > 0 && msRemaining <= WARN_THRESHOLD_MS,
  );
}

/**
 * Start an interval-driven countdown tied to an absolute expiry timestamp.
 * @param {HTMLElement} clockEl
 * @param {number} expiresAtMs absolute epoch ms when session purges
 * @param {() => void} [onExpire] fired once when clock hits zero
 * @returns {() => void} stop function
 */
export function startCountdown(clockEl, expiresAtMs, onExpire) {
  let fired = false;
  const tick = () => {
    const remaining = expiresAtMs - Date.now();
    renderCountdown(clockEl, remaining);
    if (remaining <= 0 && !fired) {
      fired = true;
      if (typeof onExpire === "function") onExpire();
    }
  };
  tick();
  const handle = setInterval(tick, 1000);
  return () => clearInterval(handle);
}

/* ---------- Media (mute / camera) state ---------- */

/**
 * Reflect an audio or video toggle onto its button.
 * @param {HTMLButtonElement} btnEl
 * @param {HTMLElement|null} stateEl
 * @param {boolean} enabled
 * @returns {boolean}
 */
export function renderMediaToggle(btnEl, stateEl, enabled) {
  const on = Boolean(enabled);
  if (btnEl) {
    btnEl.dataset.active = String(on);
    btnEl.setAttribute("aria-pressed", String(on));
  }
  if (stateEl) {
    stateEl.textContent = on ? "ON" : "OFF";
  }
  return on;
}

/**
 * Enable/disable audio track(s) of a stream.
 * @param {MediaStream|null} stream
 * @param {boolean} enabled
 */
export function applyAudioState(stream, enabled) {
  if (!stream) return;
  for (const track of stream.getAudioTracks()) {
    track.enabled = Boolean(enabled);
  }
}

/**
 * Enable/disable video track(s) of a stream.
 * @param {MediaStream|null} stream
 * @param {boolean} enabled
 */
export function applyVideoState(stream, enabled) {
  if (!stream) return;
  for (const track of stream.getVideoTracks()) {
    track.enabled = Boolean(enabled);
  }
}

/* ---------- Ephemeral chat & telemetry rendering ---------- */

/** Ring capacity — older lines fall off DOM and memory. */
const MAX_RENDERED_LINES = 100;

/**
 * Ephemeral chat view:
 * Strictly separates peer conversation bubbles from diagnostic telemetry logs.
 */
export class EphemeralChatView {
  /**
   * @param {HTMLElement} logEl scrollable chat log container
   * @param {HTMLElement|null} [telemetryEl] scrollable telemetry log container
   * @param {HTMLElement|null} [telemetryPillEl] telemetry status pill text element
   */
  constructor(logEl, telemetryEl = null, telemetryPillEl = null) {
    this.logEl = logEl || null;
    this.telemetryEl = telemetryEl || null;
    this.telemetryPillEl = telemetryPillEl || null;
    /** @type {{sender:string, text:string, at:number, kind:string}[]} */
    this.volatile = []; // in-memory ONLY
    /** @type {{text:string, at:number, kind:string}[]} */
    this.volatileTelemetry = []; // in-memory ONLY
  }

  /**
   * Render one message.
   * Diagnostic logs ("sys", "telemetry") go exclusively to the telemetry drawer/pill.
   * Real peer/self messages render as Signal/Telegram-style conversational bubbles.
   *
   * @param {string} sender display handle
   * @param {string} text message body
   * @param {{kind?: "peer"|"self"|"sys"|"peer-plaintext"|"self-plaintext"|"telemetry"}} [opts]
   * @returns {{sender: string, text: string, at: number, kind: string}}
   */
  append(sender, text, opts = {}) {
    const kind = opts.kind || "peer";
    const at = Date.now();
    const entry = {
      sender: String(sender || ""),
      text: String(text || ""),
      at,
      kind,
    };

    // ROUTING 1: Diagnostic / Signaling Logs -> Telemetry Drawer & Pill ONLY
    if (kind === "sys" || kind === "telemetry") {
      this.volatileTelemetry.push(entry);
      if (this.volatileTelemetry.length > MAX_RENDERED_LINES) {
        this.volatileTelemetry.shift();
      }

      // Update HUD status pill with current signal state
      if (this.telemetryPillEl) {
        this.telemetryPillEl.textContent = String(text || "").toUpperCase();
      }

      // Append to Telemetry Drawer if mounted
      if (this.telemetryEl) {
        const item = document.createElement("div");
        item.className = "telemetry-entry telemetry-entry--sys";

        const time = document.createElement("time");
        time.dateTime = new Date(at).toISOString();
        time.textContent = new Date(at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });

        const tag = document.createElement("span");
        tag.className = "telemetry-tag";
        tag.textContent =
          text.startsWith("SECURITY") || text.includes("PANIC") || text.includes("PURGE")
            ? "[ALERT]"
            : text.includes("failed") || text.includes("error")
              ? "[WARN]"
              : "[SIGNAL]";

        const body = document.createElement("span");
        body.className = "telemetry-text";
        body.textContent = text;

        item.append(time, tag, body);
        this.telemetryEl.appendChild(item);

        while (this.telemetryEl.childElementCount > MAX_RENDERED_LINES) {
          this.telemetryEl.removeChild(this.telemetryEl.firstChild);
        }
        this.telemetryEl.scrollTop = this.telemetryEl.scrollHeight;
      }
      return entry;
    }

    // ROUTING 2: Pure Peer & Self Chat -> Main Message Canvas (Signal/Telegram Style)
    this.volatile.push(entry);
    if (this.volatile.length > MAX_RENDERED_LINES) this.volatile.shift();

    if (this.logEl) {
      const line = document.createElement("div");
      const isSelf = kind.startsWith("self");
      const isPlaintext = kind.endsWith("-plaintext");

      line.className = `chat-line chat-line--${isSelf ? "self" : "peer"} ${
        isPlaintext ? "chat-line--plaintext" : "chat-line--encrypted"
      }`;
      line.dataset.messageKind = kind;

      const bubble = document.createElement("div");
      bubble.className = "chat-bubble";

      const senderTag = document.createElement("div");
      senderTag.className = "chat-sender-tag";
      senderTag.textContent = isSelf
        ? "YOU"
        : sender
          ? `PEER // ${sender.slice(0, 8)}`
          : "PEER";

      const content = document.createElement("p");
      content.className = "chat-body";
      content.textContent = text; // textContent — XSS-safe

      const footer = document.createElement("div");
      footer.className = "chat-bubble-footer";

      const timestamp = document.createElement("time");
      timestamp.className = "chat-time";
      timestamp.dateTime = new Date(at).toISOString();
      timestamp.textContent = new Date(at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });

      const lockIcon = document.createElement("span");
      lockIcon.className = "chat-lock-indicator";
      lockIcon.innerHTML = isPlaintext
        ? '<span class="lock-warn" title="Unencrypted message">⚠️</span>'
        : '<span class="lock-secure" title="End-to-End Encrypted (AES-256-GCM)">🔒</span>';

      footer.append(timestamp, lockIcon);
      bubble.append(senderTag, content, footer);
      line.appendChild(bubble);

      this.logEl.appendChild(line);

      while (this.logEl.childElementCount > MAX_RENDERED_LINES) {
        this.logEl.removeChild(this.logEl.firstChild);
      }
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }

    return entry;
  }

  /** System notice routed strictly to telemetry. */
  system(text) {
    return this.append("", text, { kind: "sys" });
  }

  /** Wipe telemetry log in DOM and in-memory ring. */
  clearTelemetry() {
    this.volatileTelemetry.length = 0;
    if (this.telemetryEl) this.telemetryEl.replaceChildren();
  }

  /** Wipe screen AND in-memory rings. Called on purge / panic. */
  flush() {
    this.volatile.length = 0;
    this.volatileTelemetry.length = 0;
    if (this.logEl) this.logEl.replaceChildren();
    if (this.telemetryEl) this.telemetryEl.replaceChildren();
    if (this.telemetryPillEl) {
      this.telemetryPillEl.textContent = "PURGED // VOLATILE RAM WIPED";
    }
  }
}

/* ---------- Miscellaneous view bits ---------- */

/**
 * Update the header room code readout.
 * @param {HTMLElement} codeEl
 * @param {string} code
 */
export function renderRoomCode(codeEl, code) {
  if (codeEl) codeEl.textContent = String(code || "----");
}

/**
 * Show/hide the remote "NO CARRIER" fallback based on stream presence and connection state.
 * @param {HTMLElement} fallbackEl
 * @param {MediaStream|null} stream
 * @param {string|null} [connectionState]
 */
export function renderRemoteState(fallbackEl, stream, connectionState = null) {
  if (!fallbackEl) return;
  const hasVideo = Boolean(
    stream && stream.getVideoTracks().some((t) => t.readyState === "live"),
  );
  const isConnected = connectionState === "connected" || connectionState === "live";

  if (hasVideo) {
    fallbackEl.classList.add("hidden");
    fallbackEl.closest(".video-primary")?.classList.add("has-remote");
  } else if (isConnected) {
    fallbackEl.classList.remove("hidden");
    fallbackEl.closest(".video-primary")?.classList.add("has-remote");
    const titleEl = fallbackEl.querySelector(".fallback-title");
    if (titleEl) titleEl.textContent = "PEER LINKED // AUDIO ONLY";
  } else {
    fallbackEl.classList.remove("hidden");
    fallbackEl.closest(".video-primary")?.classList.remove("has-remote");
    const titleEl = fallbackEl.querySelector(".fallback-title");
    if (titleEl) titleEl.textContent = "AWAITING SECURE PEER LINK";
  }
}

/**
 * Bind and render the chat drawer open/closed state.
 * @param {HTMLElement} drawerEl
 * @param {HTMLButtonElement} btnEl
 * @param {HTMLElement|null} stateEl
 * @param {boolean} open
 */
export function renderChatDrawer(drawerEl, btnEl, stateEl, open) {
  const isOpen = Boolean(open);
  if (drawerEl) {
    drawerEl.classList.toggle("collapsed", !isOpen);
    drawerEl.setAttribute("aria-expanded", String(isOpen));
  }
  if (btnEl) {
    btnEl.dataset.active = String(isOpen);
    btnEl.setAttribute("aria-pressed", String(isOpen));
  }
  if (stateEl) stateEl.textContent = isOpen ? "OPEN" : "HIDDEN";
}

/**
 * Estimate distance from a calibrated 1 m RSSI reference.
 * @param {number} rssiDbm
 * @param {number} txPowerAtOneMeter
 * @param {number} [pathLossExponent=2]
 * @returns {number|null}
 */
export function estimateDistanceMeters(
  rssiDbm,
  txPowerAtOneMeter,
  pathLossExponent = 2,
) {
  if (
    !Number.isFinite(rssiDbm) ||
    !Number.isFinite(txPowerAtOneMeter) ||
    !Number.isFinite(pathLossExponent) ||
    pathLossExponent <= 0
  ) {
    return null;
  }
  const distance = 10 ** (
    (txPowerAtOneMeter - rssiDbm) /
    (10 * pathLossExponent)
  );
  return Number.isFinite(distance) ? Math.round(distance * 10) / 10 : null;
}

/**
 * Render ephemeral peer telemetry.
 * @param {HTMLElement|null} listEl
 * @param {Array<{nodeId:string, carrier:string, rttMs?:number|null,
 *   distanceMeters?:number|null, rssiDbm?:number|null}>} peers
 */
export function renderRadarPeers(listEl, peers) {
  if (!listEl) return;
  const fragment = document.createDocumentFragment();

  for (const peer of peers) {
    const item = document.createElement("li");
    item.className = "radar-peer";
    item.setAttribute(
      "aria-label",
      `${peer.nodeId}, ${peer.carrier}, ${Number.isFinite(peer.rttMs) ? `RTT ${Math.round(peer.rttMs)} ms` : "RTT unavailable"}`,
    );

    const heading = document.createElement("div");
    heading.className = "radar-peer-heading";
    const identity = document.createElement("span");
    identity.className = "radar-peer-identity";
    const dot = document.createElement("i");
    dot.className = "radar-peer-dot";
    const node = document.createElement("strong");
    node.textContent = peer.nodeId;
    identity.append(dot, node);
    const carrier = document.createElement("span");
    carrier.className = "radar-peer-carrier";
    carrier.textContent = `[${peer.carrier}]`;
    heading.append(identity, carrier);

    const rtt = document.createElement("span");
    rtt.className = "radar-peer-rtt";
    rtt.textContent = Number.isFinite(peer.rttMs)
      ? `RTT: ${Math.round(peer.rttMs)} ms`
      : "RTT: -- ms";

    item.append(heading, rtt);
    fragment.appendChild(item);
  }

  listEl.replaceChildren(fragment);
}

/**
 * Overwrite the document completely with a minimalist "SESSION OBLITERATED" lockout screen.
 */
export function renderObliteratedScreen() {
  if (typeof document === "undefined") return;

  if (document.body && document.body.style) {
    document.body.style.filter = "";
  }

  const lockoutEl = document.getElementById?.("lockoutScreen");
  if (lockoutEl && typeof lockoutEl.classList?.remove === "function") {
    lockoutEl.classList.remove("hidden");
    const shell = document.getElementById?.("shell");
    if (shell && typeof shell.classList?.add === "function") {
      shell.classList.add("hidden");
    }
  }

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
    console.error("[renderView] renderObliteratedScreen error:", err);
  }
}
