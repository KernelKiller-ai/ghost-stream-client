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
    if (enabled) continue;
    stream.removeTrack(track);
    track.stop();
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
        ? "You"
        : sender
          ? sender.slice(0, 8)
          : "Peer";

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

/** Update the room's compact participant cards and avatar stack. */
export function renderParticipantPresence(
  elements,
  connected,
  peerId = "",
  encrypted = false,
) {
  const isConnected = Boolean(connected);
  const initials = String(peerId || "P").replace(/[^a-z0-9]/gi, "").slice(0, 1).toUpperCase() || "P";
  const peerName = peerId ? `Peer ${peerId.slice(0, 6)}` : "Peer";
  if (elements.peerAvatar) elements.peerAvatar.textContent = initials;
  if (elements.peerStackAvatar) elements.peerStackAvatar.textContent = isConnected ? initials : "+";
  if (elements.peerCardName) elements.peerCardName.textContent = peerName;
  if (elements.peerCardStatus) {
    elements.peerCardStatus.textContent = isConnected
      ? encrypted
        ? "Connected · encrypted"
        : "Connected · securing link"
      : "Waiting for someone to join";
  }
  if (elements.peerCardTag) {
    elements.peerCardTag.textContent = encrypted
      ? "Encrypted"
      : isConnected
        ? "Securing"
        : "Waiting";
  }
  if (elements.peerCard) elements.peerCard.dataset.connected = String(isConnected);
  if (elements.participantCount) {
    elements.participantCount.textContent = isConnected ? "2 in room" : "Just you";
  }
  if (elements.localCardRole) {
    elements.localCardRole.textContent = isConnected
      ? encrypted
        ? "Secure chat is ready"
        : "Establishing secure chat"
      : "Waiting for a peer";
  }
  if (elements.localRoleTag) {
    elements.localRoleTag.textContent = elements.isHost ? "Host" : "Guest";
  }
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
        "  background: #120924 !important; color: #f7f3ff !important;",
        "  font-family: Inter, 'Plus Jakarta Sans', system-ui, sans-serif !important;",
        "  display: flex !important; align-items: center !important; justify-content: center !important;",
        "  overflow: hidden !important; user-select: none !important;",
        "}",
        ".lockout-box {",
        "  text-align: center; padding: 2.5rem 2rem;",
        "  background: rgba(37, 24, 61, 0.96); border: 1px solid rgba(239, 68, 68, 0.4);",
        "  border-radius: 24px; box-shadow: 0 0 60px rgba(139, 92, 246, 0.2);",
        "  max-width: 440px; margin: 1.5rem;",
        "}",
        ".lockout-icon { font-size: 2.75rem; color: #f87171; margin-bottom: 1rem; }",
        ".lockout-eyebrow {",
        "  display: block; font-size: 0.6875rem; letter-spacing: 0.25em;",
        "  color: #b6a9d2; margin-bottom: 0.5rem; text-transform: uppercase;",
        "}",
        ".lockout-title {",
        "  font-size: 1.25rem; font-weight: 700; letter-spacing: 0.15em;",
        "  text-transform: uppercase; margin-bottom: 0.75rem; color: #fca5a5;",
        "}",
        ".lockout-desc {",
        "  font-size: 0.8125rem; line-height: 1.6; color: #b6a9d2;",
        "  letter-spacing: 0.05em; margin-bottom: 1.5rem;",
        "}",
        ".lockout-badge {",
        "  display: inline-block; font-size: 0.6875rem; letter-spacing: 0.2em;",
        "  padding: 0.4rem 0.8rem; border: 1px dashed rgba(239, 68, 68, 0.5);",
        "  border-radius: 999px; color: #fca5a5; background: rgba(239, 68, 68, 0.16);",
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

/* ============================================================
 * GHOST-STREAM // BLE Radar (offline Bluetooth proximity UI)
 * Glassmorphic scan overlay + top-nav button controller.
 *
 * States: idle → scanning → pairing → connected | failed | cancelled
 * Fully offline: invokes bluetoothManager.scanForPeers() directly;
 * no network calls, no telemetry, nothing persisted.
 * ============================================================ */

import { scanForPeers, connectGatt, checkSupport, disconnect as bleDisconnect } from "../core/bluetoothManager.js";

/** Canonical radar state machine values. */
export const BLE_RADAR_STATES = {
  IDLE: "Idle",
  SCANNING: "Scanning",
  PAIRING: "Pairing",
  CONNECTED: "Connected",
  FAILED: "Scan Failed",
};

/**
 * Owns the radar button, the modal overlay and the state machine.
 * Instantiated once by main.js with the room-header element for the
 * connected peer readout.
 */
export class BleRadarView {
  /**
   * @param {HTMLButtonElement} btnEl top-nav "📡 BLE RADAR" button
   * @param {HTMLElement} overlayEl full-viewport scan modal root
   * @param {HTMLElement} [roomHeaderEl] room heading element that gains
   *        the discovered peer badge once connected
   */
  constructor(btnEl, overlayEl, roomHeaderEl = null) {
    this.btn = btnEl;
    this.overlay = overlayEl;
    this.roomHeader = roomHeaderEl;
    this.state = BLE_RADAR_STATES.IDLE;
    this.peerName = null;
    this._scanAbort = null;
    this._onClick = this._onClick.bind(this);
    this.btn?.addEventListener("click", this._onClick);
  }

  /* ---------------- DOM construction ---------------- */

  /** Build (once) and return the modal inner content. */
  _ensureContent() {
    if (this.panel) return this.panel;
    this.overlay.innerHTML = `
      <div class="radar-modal" role="dialog" aria-modal="true" aria-label="BLE Radar Scan">
        <div class="radar-glass">
          <div class="radar-scope" data-state="${this.state.toLowerCase().replace(/\s+/g, "-")}">
            <div class="radar-ring radar-ring--1"></div>
            <div class="radar-ring radar-ring--2"></div>
            <div class="radar-ring radar-ring--3"></div>
            <div class="radar-core"></div>
            <div class="radar-sweep"></div>
          </div>
          <div class="radar-state-label" data-role="state">${this.state}</div>
          <div class="radar-hint" data-role="hint">Tap a device in the chooser to pair</div>
          <div class="radar-peer" data-role="peer"></div>
          <button class="radar-close" data-role="close" type="button">ABORT SCAN</button>
        </div>
      </div>`;
    this.panel = this.overlay.querySelector(".radar-glass");
    this.scopeEl = this.overlay.querySelector(".radar-scope");
    this.stateEl = this.overlay.querySelector('[data-role="state"]');
    this.hintEl = this.overlay.querySelector('[data-role="hint"]');
    this.peerEl = this.overlay.querySelector('[data-role="peer"]');
    this.closeEl = this.overlay.querySelector('[data-role="close"]');
    this.closeEl.addEventListener("click", () => this._close(true));
    return this.panel;
  }

  /* ---------------- State machine ---------------- */

  setState(next, hint = null) {
    this.state = next;
    if (this.stateEl) {
      this.stateEl.textContent = next;
      const key = next.toLowerCase().replace(/\s+/g, "-");
      this.scopeEl?.setAttribute("data-state", key);
      this.panel?.setAttribute("data-state", key);
    }
    if (hint && this.hintEl) this.hintEl.textContent = hint;
    if (this.btn) {
      this.btn.setAttribute("data-radar-state", next.toLowerCase().replace(/\s+/g, "-"));
      this.btn.disabled = next === BLE_RADAR_STATES.PAIRING;
      this.btn.textContent =
        next === BLE_RADAR_STATES.CONNECTED && this.peerName
          ? `📡 ${this.peerName}`
          : next === BLE_RADAR_STATES.FAILED
            ? "📡 RETRY RADAR"
            : "📡 BLE RADAR";
    }
  }

  /* ---------------- Interactions ---------------- */

  async _onClick() {
    if (this.state === BLE_RADAR_STATES.CONNECTED) {
      // Click while connected tears the link down.
      bleDisconnect();
      this._clearPeerBadge();
      this.setState(BLE_RADAR_STATES.IDLE, "Link released");
      return;
    }
    await this.startScan();
  }

  /** Opens the overlay and runs scanForPeers → connectGatt. */
  async startScan() {
    const support = checkSupport();
    if (!support.ok) {
      this._open(BLE_RADAR_STATES.FAILED, support.hint);
      return;
    }

    this._open(BLE_RADAR_STATES.SCANNING, "Pick a Ghost-Stream peer in the chooser…");
    try {
      const device = await scanForPeers();
      this.setState(BLE_RADAR_STATES.PAIRING, `Handshaking with ${device.name ?? "peer"}…`);
      this._renderPeer(device.name ?? "(unnamed peer)");
      await connectGatt(device, {
        onDisconnect: () => {
          this._clearPeerBadge();
          this.setState(BLE_RADAR_STATES.IDLE, "Link lost");
          this._close();
        },
      });
      this.peerName = device.name ?? "(unnamed peer)";
      this._showPeerBadge(this.peerName);
      this.setState(BLE_RADAR_STATES.CONNECTED, "GATT link established — offline signaling active");
      setTimeout(() => this._close(), 1200);
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (msg === "BLE_SCAN_CANCELLED") {
        this._close();
        this.setState(BLE_RADAR_STATES.IDLE, "Scan dismissed");
        return;
      }
      const friendly = {
        BLE_CONNECT_UNREACHABLE: "Peer unreachable — moved out of range?",
        BLE_PROFILE_MISSING: "Peer lacks the Ghost-Stream GATT profile (FFE0/FFE1)",
        BLE_ACCESS_DENIED: "Pairing denied — approve the bond on the peer device",
        BLE_NO_GATT_SERVER: "Device not bondable — try another peripheral",
        BLE_NO_WRITABLE_CHAR: "Peer exposes no writable characteristic",
      }[msg];
      this._open(BLE_RADAR_STATES.FAILED, friendly ?? msg);
    }
  }

  /* ---------------- Overlay + room badge ---------------- */

  _open(state, hint) {
    this._ensureContent();
    this.overlay.classList.add("radar-overlay--active");
    document.body.classList.add("radar-lock-scroll");
    this.setState(state, hint);
  }

  /** @param {boolean} [cancelledByUser] treat as dismissal, not failure */
  _close(cancelledByUser = false) {
    if (this.state === BLE_RADAR_STATES.SCANNING && !cancelledByUser) {
      this.setState(BLE_RADAR_STATES.FAILED);
    }
    this.overlay.classList.remove("radar-overlay--active");
    document.body.classList.remove("radar-lock-scroll");
  }

  _renderPeer(name) {
    if (this.peerEl) this.peerEl.textContent = name ? `▶ ${name}` : "";
  }

  /** Displays the discovered peer name in the active room header. */
  _showPeerBadge(name) {
    if (!this.roomHeader || !name) return;
    if (!this._badge) {
      this._badge = document.createElement("span");
      this._badge.className = "room-heading-ble-peer";
      this.roomHeader.appendChild(this._badge);
    }
    this._badge.textContent = `📡 ${name}`;
  }

  _clearPeerBadge() {
    this._badge?.remove();
    this._badge = null;
    this.peerName = null;
    if (this.peerEl) this.peerEl.textContent = "";
  }

  /** Full teardown (session purge). */
  destroy() {
    bleDisconnect();
    this.btn?.removeEventListener("click", this._onClick);
    this._clearPeerBadge();
    this._close();
    this.overlay.innerHTML = "";
  }
}

/* ============================================================
 * GHOST-STREAM // QR Answer Scanner UI (offline air-gapped handshake)
 *
 * Camera-backed scanner modal: reads the peer's animated QR frame
 * sequence, reassembles + decompresses the SDP, hands it to
 * webrtcManager.handleAnswer(), and kills the camera the instant
 * the handshake completes (hardware LED off).
 * ============================================================ */

import { QrCameraScanner } from "../core/qrHandshake.js";

/**
 * Presentation wrapper around QrCameraScanner.
 *
 * @param {HTMLVideoElement|null} videoEl where the camera preview renders
 * @param {HTMLElement|null} statusEl progress/status text element
 */
export class QrAnswerScannerView {
  constructor(videoEl = null, statusEl = null) {
    this.videoEl = videoEl;
    this.statusEl = statusEl;
    this.scanner = null;
  }

  _setStatus(text) {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  /**
   * Launch the scanner and route the recovered SDP into WebRTC.
   * @param {import("../core/webrtcManager.js").WebRTCManager} rtc
   * @param {AbortSignal} [signal] external cancel (modal close button)
   * @returns {Promise<string>} the decompressed SDP
   */
  async scanAndApply(rtc, signal = null) {
    if (!rtc || typeof rtc.handleAnswer !== "function") {
      throw new Error("SCANNER_NO_WEBRTC — no WebRTC manager bound.");
    }

    this._setStatus("Starting camera…");
    this.scanner = new QrCameraScanner(this.videoEl, {
      signal,
      timeoutMs: 90_000,
      sampleHz: 10,
      onProgress: ({ got, total }) =>
        this._setStatus(`Reading peer frames… ${got}/${total}`),
    });

    try {
      const sdp = await this.scanner.start("answer");
      this._setStatus("Applying peer answer…");
      // Requirement 3: feed the decompressed SDP directly into WebRTC.
      await rtc.handleAnswer(sdp);
      this._setStatus("Peer answer applied — handshake complete.");
      return sdp;
    } catch (err) {
      const msg = String(err?.message ?? err);
      const friendly = {
        QR_SCANNER_UNSUPPORTED: "This browser can't scan QR codes — try Chrome/Edge, or a jsQR-bundled build.",
        CAMERA_PERMISSION_DENIED: "Camera denied — grant access and retry.",
        CAMERA_NOT_FOUND: "No camera available on this device.",
        QR_SCAN_TIMEOUT: "Timed out waiting for peer frames — re-display the QR sequence and retry.",
        AbortError: "Scan cancelled.",
      }[err?.name === "AbortError" ? "AbortError" : msg.split(" ")[0]] ?? msg;
      this._setStatus(friendly);
      throw err;
    } finally {
      // Requirement 4 (belt-and-braces): the scanner already stopped its
      // own stream on completion/failure, but never trust one path alone.
      this.scanner?.stop();
    }
  }

  /** Cancel any in-flight scan and release the camera. */
  cancel() {
    this.scanner?.stop();
    this.scanner = null;
    this._setStatus("Scanner closed.");
  }

  /** Session purge teardown. */
  destroy() {
    this.cancel();
  }
}
