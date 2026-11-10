/* ============================================================
 * GHOST-STREAM // nativeRadar.js
 * Native bridge: background Wi-Fi Direct + BLE peer discovery
 * through Capacitor plugins, with graceful web-mode fallback.
 *
 * Layers:
 *   1. Platform probe    — Capacitor.isNativePlatform()
 *   2. Discovery engines — BLE scan (service-UUID filter) and/or
 *                          Wi-Fi P2P (WPA2-less, no PIN) in one pass
 *   3. Peer model        — { deviceId, name, rssi, transport }
 *   4. 1-tap connect     — Wi-Fi Direct group negotiation without
 *                          user PIN prompts, then a raw TCP socket
 *
 * Native plugin contract (JS side consumes `registerPlugin` proxies):
 *   GhostRadar.startDiscovery({ serviceHash })   -> { sessionId }
 *   GhostRadar.stopDiscovery({ sessionId })
 *   GhostRadar.connect({ deviceId, transport })  -> { socketId, port }
 *   GhostRadar.addListener("peerFound", ({ deviceId, name, rssi, transport }))
 *   GhostRadar.addListener("peerLost",  ({ deviceId }))
 *   GhostRadar.addListener("connectResult", ({ deviceId, socketId, error }))
 *
 * The matching Java/Kotlin plugin (GhostRadarPlugin) lives in the
 * android/ tree; every method above maps 1:1 onto a @CapacitorPlugin
 * annotated method. On web builds this module degrades cleanly:
 * startRadarDiscovery()/stopRadarDiscovery() exist and report
 * { supported:false } instead of throwing, so UI code paths never
 * need a platform branch.
 * ============================================================ */

import { Capacitor, registerPlugin, WebPlugin } from "@capacitor/core";

const TAG = "[native-radar]";
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);

/* ------------------------------------------------------------------
 * 1. Platform detection (Requirement 1)
 * ------------------------------------------------------------------ */

/**
 * True when the client runs inside the Capacitor Android/iOS shell
 * (native WebView build), false in a plain browser tab.
 */
export const IS_NATIVE = Capacitor.isNativePlatform?.() ?? false;

/** Platform name: "android" | "ios" | "web". */
export const PLATFORM = Capacitor.getPlatform?.() ?? "web";

/* ------------------------------------------------------------------
 * 2. Service identity
 * ------------------------------------------------------------------ */

/**
 * 16-bit service hash advertising Ghost-Stream peers over BLE 128-bit
 * short UUIDs and Wi-Fi P2P DNS-SD TXT records. Derived from FNV-1a of
 * the profile string — MUST match the native plugin's constant.
 * 0x1B2A ≙ "ghost-stream-radar-v1"
 */
export const GS_SERVICE_HASH = 0x1b2a;

/** Wi-Fi P2P service discovery type (DNS-SD, hybrid TCP). */
const P2P_SERVICE_TYPE = "_ghost-stream._tcp";

/* ------------------------------------------------------------------
 * 3. Plugin proxy
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} DiscoveredPeer
 * @property {string} deviceId stable native identifier
 * @property {string} name advertised peripheral / P2P device name
 * @property {number|null} rssi dBm (-100..-40), null when radio omits it
 * @property {"ble"|"wifi-p2p"} transport which radio produced the hit
 */

/**
 * @typedef {Object} GhostRadarPlugin
 * @property {(o:{serviceHash:number, serviceType:string}) => Promise<{sessionId:string}>} startDiscovery
 * @property {(o:{sessionId:string}) => Promise<void>} stopDiscovery
 * @property {(o:{deviceId:string, transport:string}) => Promise<{socketId:string, port:number}>} connect
 * @property {() => Promise<void>} removeAllListeners
 */

/** @type {GhostRadarPlugin} */
const GhostRadar = registerPlugin("GhostRadar", {
  web: new (class extends WebPlugin {
    async startDiscovery() {
      throw this.unavailable("GhostRadar is native-only; use the browser BLE radar instead.");
    }
    async stopDiscovery() {}
    async connect() {
      throw this.unavailable("GhostRadar native sockets are unavailable on web.");
    }
  })(),
});



/* ------------------------------------------------------------------
 * 4. Public discovery surface (Requirements 2 + 3)
 * ------------------------------------------------------------------ */

/** @type {Set<(peer: DiscoveredPeer) => void>} */
const listeners = new Set();
/** @type {Set<(deviceId: string) => void>} */
const lostListeners = new Set();

let discoverySessionId = null;
let pluginHandle = null;

/**
 * Starts background discovery on every native transport available.
 * Idempotent: calling twice replaces the active session cleanly.
 *
 * @param {object} [opts]
 * @param {number} [opts.serviceHash=GS_SERVICE_HASH]
 * @returns {Promise<{supported:boolean, sessionId?:string, transports:string[]}>}
 */
export async function startRadarDiscovery({ serviceHash = GS_SERVICE_HASH } = {}) {
  if (!IS_NATIVE) {
    warn("startRadarDiscovery: not a native shell — web fallback stays silent.");
    return { supported: false, transports: [] };
  }

  // Replace any active session first.
  await stopRadarDiscovery();

  pluginHandle = await GhostRadar.addListener("peerFound", (peer) => {
    if (!peer?.deviceId) return;
    log("peerFound:", peer.deviceId, peer.transport ?? "ble", peer.rssi ?? "n/a", "dBm");
    for (const fn of listeners) {
      try {
        fn(normalizePeer(peer));
      } catch (err) {
        warn("peerFound listener threw:", err?.message ?? err);
      }
    }
  });

  await GhostRadar.addListener("peerLost", (evt) => {
    if (!evt?.deviceId) return;
    for (const fn of lostListeners) {
      try {
        fn(evt.deviceId);
      } catch (err) {
        warn("peerLost listener threw:", err?.message ?? err);
      }
    }
  });

  const { sessionId } = await GhostRadar.startDiscovery({
    serviceHash,
    serviceType: P2P_SERVICE_TYPE,
  });
  discoverySessionId = sessionId ?? "default";

  log("discovery started:", discoverySessionId, "hash=0x", serviceHash.toString(16));
  return {
    supported: true,
    sessionId: discoverySessionId,
    transports: ["ble", "wifi-p2p"],
  };
}

/** Stops the active discovery session and tears down listeners. */
export async function stopRadarDiscovery() {
  if (!IS_NATIVE || !discoverySessionId) return { supported: IS_NATIVE, stopped: false };
  try {
    await GhostRadar.stopDiscovery({ sessionId: discoverySessionId });
  } catch (err) {
    warn("stopDiscovery error:", err?.message ?? err);
  } finally {
    await GhostRadar.removeAllListeners().catch(() => {});
    pluginHandle = null;
    discoverySessionId = null;
  }
  return { supported: true, stopped: true };
}

/** Subscribe to peer discoveries. Returns an unsubscribe closure. */
export function onPeerDiscovered(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Subscribe to peer-loss events (left radio range). */
export function onPeerLost(fn) {
  lostListeners.add(fn);
  return () => lostListeners.delete(fn);
}

function normalizePeer(raw) {
  return {
    deviceId: String(raw.deviceId),
    name: String(raw.name ?? raw.deviceId),
    rssi: Number.isFinite(raw.rssi) ? raw.rssi : null,
    transport: raw.transport === "wifi-p2p" ? "wifi-p2p" : "ble",
  };
}

/* ------------------------------------------------------------------
 * 5. 1-tap connect (Requirement 4)
 * ------------------------------------------------------------------ */

/**
 * One-tap peer connect: negotiates a Wi-Fi Direct group ownership
 * (auto-accept — no PIN / no system dialog) with a BLE-discovered
 * peer, opens the TCP socket on the negotiated group interface and
 * resolves once the LAN path is usable.
 *
 * Flow inside the native plugin:
 *   1. WifiP2pManager.connect() with auto-accept group negotiation
 *   2. Listen for WIFI_P2P_CONNECTION_CHANGED_ACTION
 *   3. Read the group owner / client address from WifiP2pInfo
 *   4. Open a ServerSocket (owner) or client socket (joiner)
 *   5. Emit connectResult{socketId, port} back to JS
 *
 * BLE-only peers (no Wi-Fi Direct capability) fall back to GATT and
 * are rejected here — route them through bluetoothManager instead.
 *
 * @param {string} deviceId native device identifier from a peerFound event
 * @returns {Promise<{socketId:string, port:number, deviceId:string}>}
 * @throws typed errors: NRAD_UNAVAILABLE / NRAD_NO_P2P / NRAD_TIMEOUT
 */
export async function connectToPeer(deviceId) {
  if (!IS_NATIVE) {
    throw new Error("NRAD_UNAVAILABLE — native shell required for Wi-Fi Direct sockets.");
  }
  if (!deviceId) throw new Error("NRAD_NO_DEVICE");

  const result = await GhostRadar.connect({ deviceId, transport: "wifi-p2p" });
  log("connect:", deviceId, "-> socket", result.socketId, "port", result.port);
  return { socketId: result.socketId, port: result.port, deviceId };
}

/* ------------------------------------------------------------------
 * 6. Runtime introspection for UI badges
 * ------------------------------------------------------------------ */

export function getRadarCapabilities() {
  return {
    native: IS_NATIVE,
    platform: PLATFORM,
    ble: IS_NATIVE,
    wifiP2p: IS_NATIVE && PLATFORM === "android", // iOS has no Wi-Fi Direct
    pinlessConnect: IS_NATIVE && PLATFORM === "android",
  };
}
