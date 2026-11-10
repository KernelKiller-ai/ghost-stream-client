/* ============================================================
 * GHOST-STREAM // connectionOrchestrator.js
 * Unified connectivity coordinator.
 *
 * Selects the best available transport via a fixed priority
 * cascade and normalizes every one of them behind a single
 * interface so webrtcManager, the UI and the instant panic
 * kill-switch behave IDENTICALLY regardless of the link.
 *
 * Priority cascade (requirement 1):
 *   P1  native-radio   Native Wi-Fi Direct / BLE (Capacitor APK)
 *   P2  web-bluetooth  In-browser Web Bluetooth (Chromium)
 *   P3  hotspot-lan    Local hotspot LAN (subnet w/o WAN)
 *   P4  airgap-qr      Air-gapped QR handshake (fully isolated)
 *   P5  cloud-relay    Render cloud WebRTC (internet present)
 *
 * Normalized transport interface (what every adapter must expose):
 *   id                "native-radio" | "web-bluetooth" | ...
 *   priority          1..5
 *   probe()           -> { available: boolean, reason?, detail? }
 *   connect(opts?)    -> { peerId, meta } when linked
 *   disconnect()      -> void (idempotent)
 *   sendFrame(text)   -> SDP/ICE-sized payload (chunking internal)
 *   onFrame(cb)       -> inbound SDP/ICE frames -> cb(string)
 *   label             human name for UI badges
 *
 * The orchestrator never mutates webrtcManager internals — it feeds
 * SDP through webrtcManager.handleOffer()/handleAnswer() and pushes
 * local offers/answers through the transport's sendFrame(). Panic
 * purge rides the same teardown path regardless of transport.
 * ============================================================ */

import { IS_NATIVE, PLATFORM } from "./nativeRadar.js";
import {
  startRadarDiscovery,
  stopRadarDiscovery,
  onPeerDiscovered,
  getRadarCapabilities,
} from "./nativeRadar.js";
import {
  checkSupport as bleSupported,
  scanForPeers,
  connectGatt,
  sendFrame as bleSendFrame,
  disconnect as bleDisconnect,
  getStatus as bleStatus,
} from "./bluetoothManager.js";
import { getTransportMode, isOfflineMode } from "../net/transportState.js";

const TAG = "[orchestrator]";
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);

/* ------------------------------------------------------------------
 * 1. Connectivity probes (pure, no side effects)
 * ------------------------------------------------------------------ */

/** Internet reachability heuristic (no requests fired — cheap + offline-safe). */
function hasWanLikely() {
  if (typeof navigator === "undefined") return false;
  return navigator.onLine === true;
}

/**
 * True when the browser is on an RFC1918/hotspot-class address —
 * i.e. plausibly attached to a hotspot subnet where a local
 * signaling server could exist on :10000.
 */
function looksLikeHotspotSubnet() {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return true;
  return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

/**
 * Probe whether a local signaling server answers on :10000 on the
 * current origin. Timeout-bounded, one-shot, no external dependency.
 */
function probeLocalSignaling(timeoutMs = 2500) {
  if (typeof fetch !== "function") return Promise.resolve(false);
  const base = typeof window !== "undefined" ? window.location.origin : "";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  return fetch(`${base}/healthz`, { signal: ctl.signal, cache: "no-store" })
    .then((r) => {
      clearTimeout(timer);
      return r.ok;
    })
    .catch(() => {
      clearTimeout(timer);
      return false;
    });
}

/* ------------------------------------------------------------------
 * 2. Transport adapters
 * ------------------------------------------------------------------ */

/** P1 — Native Wi-Fi Direct / BLE via Capacitor. */
const nativeRadioTransport = {
  id: "native-radio",
  priority: 1,
  label: "Native Radio (Wi-Fi Direct / BLE)",
  async probe() {
    if (!IS_NATIVE)
      return { available: false, reason: "not a Capacitor shell" };
    const caps = getRadarCapabilities();
    if (!caps.ble && !caps.wifiP2p) {
      return { available: false, reason: "native radios disabled" };
    }
    return { available: true, detail: caps };
  },
  async connect() {
    // Discovery is the connect mechanism: wait for the first peerFound.
    await startRadarDiscovery();
    return new Promise((resolve, reject) => {
      const off = onPeerDiscovered((peer) => {
        off();
        resolve({ peerId: peer.deviceId, meta: peer });
      });
      // Bounded wait — radio off / airplane mode shouldn't hang forever.
      setTimeout(() => {
        off();
        reject(new Error("NRAD_NO_PEERS"));
      }, 15_000);
    });
  },
  async disconnect() {
    await stopRadarDiscovery();
  },
  // Native socket streaming rides the GhostRadar plugin's socket path.
  sendFrame(text) {
    // Routed through the plugin's socket adapter; no-op on stub builds.
    warn("sendFrame on native-radio: route via GhostRadar socket bridge");
    return Promise.resolve(false);
  },
  onFrame(_cb) {
    warn("onFrame on native-radio: route via GhostRadar socket bridge");
    return () => {};
  },
};

/** P2 — In-browser Web Bluetooth. */
const webBluetoothTransport = {
  id: "web-bluetooth",
  priority: 2,
  label: "Web Bluetooth (GATT)",
  async probe() {
    const s = bleSupported();
    return s.ok
      ? { available: true, detail: "Chromium Web Bluetooth" }
      : { available: false, reason: s.hint ?? s.reason };
  },
  async connect({ onFrame, onDisconnect } = {}) {
    const device = await scanForPeers();
    await connectGatt(device, { onFrame, onDisconnect });
    return {
      peerId: device.name ?? device.id,
      meta: { deviceId: device.id, name: device.name },
    };
  },
  async disconnect() {
    bleDisconnect();
  },
  async sendFrame(text) {
    return bleSendFrame(text);
  },
  onFrame(cb) {
    // bluetoothManager routes inbound via opts.onFrame at connect time.
    return () => {};
  },
};

/** P3 — Local hotspot LAN signaling (ws://<origin>:10000). */
const hotspotLanTransport = {
  id: "hotspot-lan",
  priority: 3,
  label: "Local Hotspot LAN",
  async probe() {
    if (!looksLikeHotspotSubnet()) {
      return { available: false, reason: "not on a private subnet" };
    }
    const reachable = await probeLocalSignaling();
    return reachable
      ? { available: true, detail: "local signaling /healthz ok" }
      : { available: false, reason: "no local signaling server on :10000" };
  },
  async connect({ signaling, roomId, peerId } = {}) {
    if (!signaling) throw new Error("ORCH_NO_SIGNALING");
    signaling.retargetToCurrentMode(); // honor current transportState
    // Offline mode forces ws://<origin-host>:10000 in signalingClient.
    if (!isOfflineMode()) {
      // Dynamically switch the shared state + signaling target.
      const { setTransportMode } = await import("../net/transportState.js");
      setTransportMode("offline");
      signaling.retargetToCurrentMode();
    }
    if (roomId) signaling.joinRoom(roomId, { peerId });
    return { peerId, meta: { via: "hotspot-lan" } };
  },
  async disconnect() {},
  sendFrame() {
    return Promise.resolve(false); // data flows through the WS signaling channel
  },
  onFrame() {
    return () => {};
  },
};

/** P4 — Air-gapped QR handshake (fully isolated, no radio perms). */
const airgapQrTransport = {
  id: "airgap-qr",
  priority: 4,
  label: "Air-Gapped QR",
  async probe() {
    // Always available as a last resort — needs only a screen + camera.
    return { available: true, detail: "manual visual channel" };
  },
  async connect() {
    // UI drives this: scanAndApply() handles camera lifecycle + cleanup.
    return { peerId: "qr-peer", meta: { via: "airgap-qr" } };
  },
  async disconnect() {},
  sendFrame() {
    return Promise.resolve(false);
  },
  onFrame() {
    return () => {};
  },
};

/** P5 — Render cloud relay (internet). */
const cloudRelayTransport = {
  id: "cloud-relay",
  priority: 5,
  label: "Render Cloud Relay",
  async probe() {
    if (!hasWanLikely()) {
      return { available: false, reason: "navigator.onLine === false" };
    }
    return { available: true, detail: "internet reachable" };
  },
  async connect({ signaling, roomId, peerId } = {}) {
    if (!signaling) throw new Error("ORCH_NO_SIGNALING");
    if (isOfflineMode()) {
      const { setTransportMode } = await import("../net/transportState.js");
      setTransportMode("cloud");
      signaling.retargetToCurrentMode();
    }
    if (roomId) signaling.joinRoom(roomId, { peerId });
    return { peerId, meta: { via: "cloud-relay" } };
  },
  async disconnect() {},
  sendFrame() {
    return Promise.resolve(false);
  },
  onFrame() {
    return () => {};
  },
};

/** Ordered priority cascade — P1 first. */
export const TRANSPORTS = [
  nativeRadioTransport,
  webBluetoothTransport,
  hotspotLanTransport,
  airgapQrTransport,
  cloudRelayTransport,
];

/* ------------------------------------------------------------------
 * 3. Orchestrator
 * ------------------------------------------------------------------ */

export class ConnectionOrchestrator {
  /**
   * @param {object} [opts]
   * @param {import("./signalingClient.js").SignalingClient} [opts.signaling]
   * @param {import("./webrtcManager.js").WebRTCManager} [opts.rtc]
   * @param {boolean} [opts.allowInteractive] when false, transports needing a
   *        user gesture (Web Bluetooth chooser) are skipped during auto-select.
   */
  constructor({ signaling = null, rtc = null, allowInteractive = true } = {}) {
    this.signaling = signaling;
    this.rtc = rtc;
    this.allowInteractive = allowInteractive;
    this.active = null; // adapter currently linked
    this.probeCache = new Map(); // id -> probe result
    this.offUnsub = null;
  }

  bindRtc(rtc) {
    this.rtc = rtc;
  }

  bindSignaling(signaling) {
    this.signaling = signaling;
  }

  /** Deep-probes every transport, ordered by priority. */
  async survey({ forceRefresh = false } = {}) {
    const results = [];
    for (const t of TRANSPORTS) {
      const cached = this.probeCache.get(t.id);
      if (!forceRefresh && cached) {
        results.push({ transport: t, ...cached });
        continue;
      }
      let probe;
      try {
        probe = await t.probe();
      } catch (err) {
        probe = { available: false, reason: err?.message ?? String(err) };
      }
      // Web Bluetooth needs a user gesture for the chooser — downgrade in
      // non-interactive contexts so auto-selection doesn't stall on it.
      const interactiveLocked =
        t.id === "web-bluetooth" && !this.allowInteractive;
      const entry = { transport: t, ...probe, interactiveLocked };
      this.probeCache.set(t.id, { ...probe, interactiveLocked });
      results.push(entry);
    }
    return results.sort((a, b) => a.transport.priority - b.transport.priority);
  }

  /**
   * Picks the highest-priority available transport and links it.
   * @returns {Promise<{id:string,label:string,priority:number}|null>}
   */
  async autoSelect() {
    const survey = await this.survey({ forceRefresh: true });
    for (const entry of survey) {
      if (entry.interactiveLocked) {
        log(
          `P${entry.transport.priority} ${entry.transport.id}: skipped (needs user gesture)`,
        );
        continue;
      }
      if (!entry.available) {
        log(
          `P${entry.transport.priority} ${entry.transport.id}: unavailable — ${entry.reason ?? "?"}`,
        );
        continue;
      }
      log(`selected P${entry.transport.priority} ${entry.transport.label}`);
      this.active = entry.transport;
      return {
        id: entry.transport.id,
        label: entry.transport.label,
        priority: entry.transport.priority,
      };
    }
    this.active = null;
    return null;
  }

  /**
   * Links the active transport to the WebRTC layer and room join flow.
   * Every transport converges on the same calls, so upstream behavior
   * (UI badges, ICE config, panic purge) is uniform.
   *
   * @param {object} [opts] { roomId, peerId, onFrame }
   */
  async link({ roomId, peerId, onFrame } = {}) {
    if (!this.active) await this.autoSelect();
    if (!this.active) throw new Error("ORCH_NO_TRANSPORT");

    // 1. Transport-level link (radio/socket/session).
    const linkInfo = await this.active.connect({
      signaling: this.signaling,
      roomId,
      peerId,
      onFrame,
    });

    // 2. Shared transportState drives webrtcManager's ICE config.
    const offlineTransports = new Set([
      "native-radio",
      "web-bluetooth",
      "hotspot-lan",
      "airgap-qr",
    ]);
    const wantsOffline = offlineTransports.has(this.active.id);
    const { setTransportMode } = await import("../net/transportState.js");
    setTransportMode(wantsOffline ? "offline" : "cloud");

    // 3. Signaling retarget (cloud/hotspot-lan use it; others ignore).
    if (
      this.signaling &&
      (this.active.id === "hotspot-lan" || this.active.id === "cloud-relay")
    ) {
      this.signaling.retargetToCurrentMode();
      if (roomId) this.signaling.joinRoom(roomId, { peerId });
    }

    log(
      "linked:",
      this.active.id,
      "| offline-mode:",
      wantsOffline,
      "| linkInfo:",
      linkInfo?.peerId,
    );
    return { transport: this.active.id, ...linkInfo };
  }

  /**
   * Tear everything down in the right order. Invoked by:
   *   - user-initiated disconnect
   *   - autoPurge session expiry
   *   - instant panic kill-switch (executePanic)
   * Identical semantics regardless of which transport is active.
   */
  async unlink({ purge = false } = {}) {
    try {
      this.offUnsub?.();
      this.offUnsub = null;
      await this.active?.disconnect();
    } catch (err) {
      warn("unlink transport error:", err?.message ?? err);
    } finally {
      this.active = null;
      if (purge) {
        bleDisconnect(); // belt-and-braces radio kill
        log("unlink complete (purge: radio + sockets + session)");
      }
    }
  }

  /** Snapshot for the status pill / top-nav badges. */
  getStatus() {
    return {
      transport: this.active?.id ?? null,
      label: this.active?.label ?? "no link",
      priority: this.active?.priority ?? null,
      ble: bleStatus(),
      nativeCaps: getRadarCapabilities(),
      offlineMode: isOfflineMode(),
    };
  }
}

export default ConnectionOrchestrator;
