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

/** Milliseconds remaining before purge triggers the red state. */
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
 * Flips the badge into warning state near expiry.
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
 * Start an interval-driven countdown tied to an absolute expiry
 * timestamp (drift-proof: computed from Date.now(), not tick count).
 *
 * @param {HTMLElement} clockEl
 * @param {number} expiresAtMs absolute epoch ms when session purges
 * @param {() => void} [onExpire] fired once when the clock hits zero
 * @returns {() => void} stop function clearing the interval
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
 * Reflect an audio or video toggle onto its dock button and tracker.
 * @param {HTMLButtonElement} btnEl dock button carrying data-active
 * @param {HTMLElement|null} stateEl small ON/OFF state label
 * @param {boolean} enabled true = media flowing
 * @returns {boolean} the state applied (normalised)
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
 * Convenience wrapper: enable/disable the audio track(s) of a stream.
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
 * Convenience wrapper: enable/disable the video track(s) of a stream.
 * @param {MediaStream|null} stream
 * @param {boolean} enabled
 */
export function applyVideoState(stream, enabled) {
  if (!stream) return;
  for (const track of stream.getVideoTracks()) {
    track.enabled = Boolean(enabled);
  }
}

/* ---------- Ephemeral chat rendering ---------- */

/** Ring capacity — older lines fall off the face of the DOM. */
const MAX_RENDERED_LINES = 100;

/**
 * Renderer that writes text straight into the live display and keeps
 * at most a small in-memory mirror. No browser storage APIs are
 * touched, and there is no input auto-complete/session persistence.
 */
export class EphemeralChatView {
  /**
   * @param {HTMLElement} logEl scrollable log container
   */
  constructor(logEl) {
    this.logEl = logEl || null;
    /** @type {{sender:string, text:string, at:number, kind:string}[]} */
    this.volatile = []; // in-memory ONLY — dies with the tab
  }

  /**
   * Render one message. Creates a detached node, sanitises it via
   * textContent (never innerHTML), then appends and trims.
   *
   * @param {string} sender display handle
   * @param {string} text message body
   * @param {{kind?: "peer"|"self"|"sys"}} [opts]
   * @returns {{sender: string, text: string, at: number, kind: string}}
   */
  append(sender, text, opts = {}) {
    const kind = opts.kind || "peer";
    const entry = {
      sender: String(sender),
      text: String(text),
      at: Date.now(),
      kind,
    };

    // volatile mirror (RAM ring, capped) — never persisted
    this.volatile.push(entry);
    if (this.volatile.length > MAX_RENDERED_LINES) this.volatile.shift();

    if (this.logEl) {
      const line = document.createElement("div");
      line.className = `chat-line chat-line--${kind}`;
      line.dataset.messageKind = kind;

      if (kind !== "sys") {
        const meta = document.createElement("div");
        meta.className = "chat-meta";
        const who = document.createElement("span");
        who.className = "chat-sender";
        who.textContent = sender; // textContent — XSS-safe by construction
        meta.appendChild(who);

        const timestamp = document.createElement("time");
        timestamp.className = "chat-time";
        timestamp.dateTime = new Date(entry.at).toISOString();
        timestamp.textContent = new Date(entry.at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        meta.appendChild(timestamp);
        line.appendChild(meta);
      }

      const body = document.createElement("span");
      body.className = "chat-body";
      body.textContent = text; // no markup, no storage, no autocomplete feed
      line.appendChild(body);

      if (kind.endsWith("-plaintext")) {
        const securityTag = document.createElement("strong");
        securityTag.className = "chat-security-tag";
        securityTag.textContent = "UNENCRYPTED";
        securityTag.setAttribute("aria-label", "This message was not end-to-end encrypted");
        line.appendChild(securityTag);
      }

      this.logEl.appendChild(line);

      // keep the DOM capped too — history evaporates visually
      while (this.logEl.childElementCount > MAX_RENDERED_LINES) {
        this.logEl.removeChild(this.logEl.firstChild);
      }
      this.logEl.scrollTop = this.logEl.scrollHeight; // follow tail
    }

    return entry;
  }

  /** System notice (joins, drops, warnings). */
  system(text) {
    return this.append("", text, { kind: "sys" });
  }

  /** Wipe the screen AND the ring. Called on purge / panic. */
  flush() {
    this.volatile.length = 0;
    if (this.logEl) this.logEl.replaceChildren();
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
 * Show/hide the remote "NO CARRIER" fallback based on stream presence.
 * @param {HTMLElement} fallbackEl
 * @param {MediaStream|null} stream
 */
export function renderRemoteState(fallbackEl, stream) {
  if (!fallbackEl) return;
  const hasVideo = Boolean(
    stream && stream.getVideoTracks().some((t) => t.readyState === "live"),
  );
  fallbackEl.classList.toggle("hidden", hasVideo);
  fallbackEl.closest(".video-primary")?.classList.toggle("has-remote", hasVideo);
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
 * This is only meaningful for radio measurements such as BLE RSSI;
 * WebRTC RTT does not provide RF distance or signal strength.
 *
 * @param {number} rssiDbm current received signal strength
 * @param {number} txPowerAtOneMeter calibrated RSSI at 1 m
 * @param {number} [pathLossExponent=2]
 * @returns {number|null} estimated meters, or null for invalid inputs
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
 * Render ephemeral peer telemetry without inventing range or RSSI values.
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
      `${peer.nodeId}, ${peer.carrier}, ${Number.isFinite(peer.rttMs) ? `RTT ${Math.round(peer.rttMs)} milliseconds` : "RTT unavailable"}`,
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

    const signal = document.createElement("span");
    signal.className = "radar-peer-signal";
    const distance = Number.isFinite(peer.distanceMeters)
      ? `${peer.distanceMeters} m`
      : "N/A";
    const rssi = Number.isFinite(peer.rssiDbm)
      ? `${peer.rssiDbm} dBm`
      : "N/A";
    signal.textContent = `RANGE: ${distance} / RSSI: ${rssi}`;

    item.append(heading, rtt, signal);
    fragment.appendChild(item);
  }

  listEl.replaceChildren(fragment);
}
