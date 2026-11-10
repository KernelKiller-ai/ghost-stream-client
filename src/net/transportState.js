/* ============================================================
 * GHOST-STREAM // transportState.js
 * Tiny shared state holder for the signaling transport selection.
 *
 * app.js (toggle UI) writes the mode; signalingClient reads it to
 * pick the WS URL and webrtcManager reads it to pick ICE servers.
 * Kept separate so neither core module imports the other.
 *
 * Values:
 *   "cloud"   — Render relay (internet), full STUN/TURN ICE list
 *   "offline" — local hotspot signaling on ws://<origin-host>:10000,
 *               iceServers: [] (direct host candidates only)
 * ============================================================ */

let mode = "cloud";

/** @returns {"cloud" | "offline"} current transport mode. */
export function getTransportMode() {
  return mode;
}

/** @returns {boolean} true when Offline Hotspot transport is active. */
export function isOfflineMode() {
  return mode === "offline";
}

/**
 * @param {"cloud" | "offline"} next
 * @returns {"cloud" | "offline"} normalized mode actually applied
 */
export function setTransportMode(next) {
  mode = next === "offline" ? "offline" : "cloud";
  return mode;
}
