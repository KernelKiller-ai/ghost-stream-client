/* ============================================================
 * GHOST-STREAM // bluetoothManager.js
 * Dedicated Bluetooth signaling transport (Web Bluetooth API).
 *
 * Responsibilities:
 *  - Capability probing (API presence, secure-context, user gesture)
 *  - Peer discovery via navigator.bluetooth.requestDevice with service filters
 *  - GATT connection lifecycle: connect -> primary service -> characteristics
 *  - Chunked write / notification-based receive for signaling payloads
 *  - Safe, fully-logged error surfaces (no silent failures)
 *
 * Notes:
 *  - Web Bluetooth is available in Chromium-based browsers over HTTPS
 *    (or localhost). Firefox / Safari do not support it.
 *  - requestDevice() MUST be triggered by a user gesture (button click);
 *    it cannot be called programmatically on page load.
 *  - Custom serial-style profiles commonly use the HM-10 / AT-09 style
 *    module profile: service FFE0, characteristic FFE1.
 * ============================================================ */

/* ------------------------------------------------------------------
 * 1. UUIDs (custom GATT profile — 128-bit strings required by spec)
 * ------------------------------------------------------------------ */

/** Custom Ghost-Stream signaling GATT service (HM-10 compatible). */
export const GS_SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";

/** Read / Write / Notify characteristic carrying encoded signaling frames. */
export const GS_CHARACTERISTIC_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";

/** Optional advertised name filter shown in the Chrome chooser. */
const OPTIONAL_NAMES = ["GhostStream", "GS-Peer", "BT05", "AT-09"];

/** MTU-adjacent cap for a single GATT write (conservative default is 20). */
const MAX_WRITE_CHUNK = 20;

/** Framing: size-prefixed payload so notifications reassemble cleanly. */
const FRAME_HEADER_BYTES = 2; // uint16 little-endian length prefix

/* ------------------------------------------------------------------
 * 2. Internal state
 * ------------------------------------------------------------------ */

const state = {
  supported: typeof navigator !== "undefined" && "bluetooth" in navigator,
  device: null,
  gattServer: null,
  service: null,
  writeCharacteristic: null, // RW without response preferred
  notifyCharacteristic: null, // Listen channel for inbound frames
  connected: false,
  rxBuffer: [], // reassembly buffer for size-prefixed frames
  disconnectHandler: null,
};

/* ------------------------------------------------------------------
 * 3. Logging helpers
 * ------------------------------------------------------------------ */

const TAG = "[bt-manager]";
const log = (...args) => console.log(TAG, ...args);
const warn = (...args) => console.warn(TAG, ...args);
const error = (...args) => console.error(TAG, ...args);

/**
 * Human-readable diagnosis of why Web Bluetooth is unavailable or failing.
 * @returns {{ok: boolean, reason?: string, hint?: string}}
 */
export function checkSupport() {
  if (typeof navigator === "undefined" || !("bluetooth" in navigator)) {
    return {
      ok: false,
      reason: "Web Bluetooth API not available",
      hint: "Use a Chromium-based browser (Chrome, Edge, Brave). Firefox and Safari do not implement navigator.bluetooth.",
    };
  }
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return {
      ok: false,
      reason: "Insecure context",
      hint: "Web Bluetooth requires HTTPS (or http://localhost). Serve the client over TLS.",
    };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------
 * 4. scanForPeers() — discovery via requestDevice()
 * ------------------------------------------------------------------ */

/**
 * Opens the native browser device chooser filtered to the Ghost-Stream
 * GATT service. Must be called from a user gesture.
 *
 * @param {Object}  [opts]
 * @param {boolean} [opts.acceptAllDevices=false] Widen the chooser beyond
 *                  the service filter (useful for branded peripherals).
 * @returns {Promise<BluetoothDevice>} the selected device
 * @throws {Error} typed failure: unsupported / cancelled / unavailable
 */
export async function scanForPeers({ acceptAllDevices = false } = {}) {
  const support = checkSupport();
  if (!support.ok) {
    error(`Scan aborted: ${support.reason}. ${support.hint}`);
    throw new Error(`${support.reason}. ${support.hint}`);
  }

  const options = acceptAllDevices
    ? { acceptAllDevices: true, optionalServices: [GS_SERVICE_UUID] }
    : {
        filters: [
          { services: [GS_SERVICE_UUID] },
          { namePrefix: "GS-" },
          ...OPTIONAL_NAMES.map((name) => ({ name })),
        ],
        optionalServices: [GS_SERVICE_UUID],
      };

  log("Opening device chooser…");

  try {
    const device = await navigator.bluetooth.requestDevice(options);
    state.device = device;

    // Surface unexpected disconnections instead of failing silently.
    device.removeEventListener?.("gattserverdisconnected", onDisconnected);
    device.addEventListener?.("gattserverdisconnected", onDisconnected);

    log("Peer selected:", device.name ?? "(unnamed)", device.id);
    return device;
  } catch (err) {
    // Chromium throws NotFoundError with a user-friendly message when the
    // user dismisses the chooser — this is normal UX, not a fault.
    if (err instanceof DOMException && err.name === "NotFoundError") {
      log("Device chooser dismissed by user — scan cancelled gracefully.");
      throw new Error("BLE_SCAN_CANCELLED");
    }

    if (err instanceof DOMException && err.name === "SecurityError") {
      error(
        "requestDevice() blocked: it must run inside a user-gesture event handler (click/tap) on a secure origin.",
      );
      throw new Error("BLE_USER_GESTURE_REQUIRED");
    }

    if (err instanceof TypeError) {
      error(
        "requestDevice() rejected the options object. Filter syntax invalid:",
        options,
      );
      throw new Error("BLE_BAD_FILTERS");
    }

    error("Unexpected error during BLE scan:", err?.message ?? err);
    throw err;
  }
}

/* ------------------------------------------------------------------
 * 5. connectGatt() — connect + service + characteristic discovery
 * ------------------------------------------------------------------ */

/**
 * Establishes a GATT connection to a previously discovered device,
 * resolves the Ghost-Stream primary service, and binds the write +
 * notify characteristics.
 *
 * @param {BluetoothDevice} device Device returned by scanForPeers()
 * @param {Object}   [opts]
 * @param {(frame: Uint8Array) => void} [opts.onFrame] Inbound payload callback
 * @param {() => void} [opts.onDisconnect] Unexpected disconnect callback
 * @returns {Promise<{device: BluetoothDevice, service: BluetoothRemoteGATTService,
 *                     writeCharacteristic: BluetoothRemoteGATTCharacteristic,
 *                     notifyCharacteristic?: BluetoothRemoteGATTCharacteristic}>}
 */
export async function connectGatt(device, { onFrame, onDisconnect } = {}) {
  if (!device) throw new Error("connectGatt: no device supplied");
  if (!device.gatt) {
    error("Device exposes no GATT server (may be pairing-banned or stale).");
    throw new Error("BLE_NO_GATT_SERVER");
  }

  if (onDisconnect) state.disconnectHandler = onDisconnect;
  if (onFrame) frameCallback = onFrame;

  try {
    log("Connecting GATT to", device.name ?? device.id, "…");

    state.gattServer = device.gatt.connected
      ? device.gatt
      : await device.gatt.connect();

    // Try the exact custom UUID first; fall back to short-form lookup for
    // firmware that advertises legacy 16-bit aliases of FFE0.
    let service = null;
    try {
      service = await state.gattServer.getPrimaryService(GS_SERVICE_UUID);
    } catch {
      warn(
        "Primary service not found by full UUID — retrying with short form ffe0.",
      );
      service = await state.gattServer.getPrimaryService("ffe0");
    }
    state.service = service;

    // Resolve characteristics: prefer write-without-response, fall back to RW.
    const writeChar = await resolveWriteCharacteristic(service);
    const notifyChar = await resolveNotifyCharacteristic(service);

    state.writeCharacteristic = writeChar;
    state.notifyCharacteristic = notifyChar ?? null;

    if (notifyChar && onFrame) {
      await subscribeNotifications(notifyChar, onFrame);
    }

    state.connected = true;
    log(
      "GATT link established:",
      device.name ?? device.id,
      "| write:",
      writeChar?.uuid ?? "n/a",
      "| notify:",
      notifyChar?.uuid ?? "none",
      "| value-size cap:",
      `${MAX_WRITE_CHUNK}B per write`,
    );

    return {
      device,
      service,
      writeCharacteristic: writeChar,
      notifyCharacteristic: notifyChar ?? null,
    };
  } catch (err) {
    state.connected = false;
    if (err instanceof DOMException && err.name === "NetworkError") {
      error(
        "GATT connection failed: peripheral unreachable (out of range, sleeping, or already bonded elsewhere).",
      );
      throw new Error("BLE_CONNECT_UNREACHABLE");
    }
    if (err instanceof DOMException && err.name === "NotFoundError") {
      error(
        "Service/characteristic discovery failed: peer firmware does not expose FFE0/FFE1.",
      );
      throw new Error("BLE_PROFILE_MISSING");
    }
    if (err instanceof DOMException && err.name === "SecurityError") {
      error(
        "GATT access denied: pairing/bonding required or service blocked by permissions policy.",
      );
      throw new Error("BLE_ACCESS_DENIED");
    }
    error("Unexpected GATT failure:", err?.message ?? err);
    throw err;
  }
}

/* ------------------------------------------------------------------
 * 6. Characteristic resolution + notifications
 * ------------------------------------------------------------------ */

async function resolveWriteCharacteristic(service) {
  const candidates = [GS_CHARACTERISTIC_UUID, "ffe1"];
  for (const uuid of candidates) {
    try {
      const char = await service.getCharacteristic(uuid);
      const props = char.properties;
      if (props.writeWithoutResponse || props.write) return char;
    } catch {
      /* try next candidate */
    }
  }
  throw new Error("BLE_NO_WRITABLE_CHAR");
}

async function resolveNotifyCharacteristic(service) {
  for (const uuid of [GS_CHARACTERISTIC_UUID, "ffe1"]) {
    try {
      const char = await service.getCharacteristic(uuid);
      if (char.properties.notify || char.properties.indicate) return char;
    } catch {
      /* try next candidate */
    }
  }
  warn(
    "Peer exposes no notifiable characteristic — inbound signaling disabled.",
  );
  return null;
}

async function subscribeNotifications(characteristic, onFrame) {
  characteristic.removeEventListener?.(
    "characteristicvaluechanged",
    onValueChanged,
  );
  characteristic.addEventListener("characteristicvaluechanged", onValueChanged);
  await characteristic.startNotifications();
  log("Subscribed to notifications on", characteristic.uuid);
}

/** Notification listener: reassembles size-prefixed frames and emits. */
function onValueChanged(event) {
  const dv = event.target.value; // DataView
  if (!dv) return;

  for (let i = 0; i < dv.byteLength; i++) state.rxBuffer.push(dv.getUint8(i));

  while (state.rxBuffer.length >= FRAME_HEADER_BYTES) {
    const len = state.rxBuffer[0] | (state.rxBuffer[1] << 8); // little-endian uint16

    if (len === 0 || len > 512) {
      warn("Malformed frame length", len, "— resynchronizing stream.");
      state.rxBuffer.shift();
      continue;
    }
    if (state.rxBuffer.length < FRAME_HEADER_BYTES + len) break; // wait for rest

    const payload = new Uint8Array(
      state.rxBuffer
        .splice(0, FRAME_HEADER_BYTES + len)
        .slice(FRAME_HEADER_BYTES),
    );
    try {
      const decoded = new TextDecoder().decode(payload);
      log("RX frame:", decoded.length, "bytes");
      frameCallback(decoded);
    } catch (e) {
      error("Frame decode failed:", e?.message ?? e);
    }
  }
}

/** Current inbound frame consumer (set via connectGatt opts.onFrame). */
let frameCallback = () => {};

/* ------------------------------------------------------------------
 * 7b. SDP chunking protocol — [index, total, checksumHi, checksumLo, ...data]
 *
 * BLE MTUs are frequently capped at 20 bytes (BLE 4.0 default) and at
 * best ~512. A compressed SDP blob therefore travels as N sequential
 * 128-byte data segments, each prefixed with:
 *   byte0 = chunk index (0-based)
 *   byte1 = total chunk count
 *   byte2 = CRC-16 high byte (of full payload)
 *   byte3 = CRC-16 low byte  (of full payload)
 * Each chunk is written through the existing size-prefixed frame layer,
 * so notifications arrive as discrete frames and are reassembled here.
 * Zero internet dependency: encoding, checksums and reassembly are all
 * local byte operations; no fetch/XHR/WebSocket is ever touched.
 * ------------------------------------------------------------------ */

/** Segment data capacity: 128 bytes per chunk as per protocol spec. */
const SDP_CHUNK_DATA_BYTES = 128;
/** Protocol overhead: index(1) + total(1) + crc16(2). */
const SDP_CHUNK_HEADER_BYTES = 4;
/** Timeout for an incomplete multi-chunk transfer (ms). */
const SDP_RX_TIMEOUT_MS = 15000;

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — fully local table-free. */
function crc16(bytes) {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** Chunk index header byte offsets. */
const CHUNK_IDX_INDEX = 0;
const CHUNK_IDX_TOTAL = 1;
const CHUNK_IDX_CRC_HI = 2;
const CHUNK_IDX_CRC_LO = 3;

/**
 * Splits a (compressed) SDP string into protocol chunks.
 * @param {string} stringData SDP offer/answer payload
 * @returns {Uint8Array[]} array of [index,total,crcHi,crcLo,...data] chunks
 */
export function buildSdpChunks(stringData) {
  const bytes = new TextEncoder().encode(String(stringData));
  const crc = crc16(bytes);
  const total = Math.max(1, Math.ceil(bytes.length / SDP_CHUNK_DATA_BYTES));
  const chunks = [];
  for (let i = 0; i < total; i++) {
    const seg = bytes.slice(i * SDP_CHUNK_DATA_BYTES, (i + 1) * SDP_CHUNK_DATA_BYTES);
    const chunk = new Uint8Array(SDP_CHUNK_HEADER_BYTES + seg.length);
    chunk[CHUNK_IDX_INDEX] = i;
    chunk[CHUNK_IDX_TOTAL] = total;
    chunk[CHUNK_IDX_CRC_HI] = (crc >> 8) & 0xff;
    chunk[CHUNK_IDX_CRC_LO] = crc & 0xff;
    chunk.set(seg, SDP_CHUNK_HEADER_BYTES);
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * Sends an SDP payload over a GATT characteristic using the chunk protocol.
 * Writes each chunk sequentially through the frame layer (size-prefixed),
 * respecting link MTU by slicing at MAX_WRITE_CHUNK bytes.
 *
 * @param {BluetoothRemoteGATTCharacteristic} characteristic target RW char
 * @param {string} stringData compressed SDP offer/answer
 * @returns {Promise<{chunks:number,bytes:number,crc:number}>}
 */
export async function sendBleChunkedPayload(characteristic, stringData) {
  if (!characteristic) throw new Error("BLE_NO_CHARACTERISTIC");
  const chunks = buildSdpChunks(stringData);
  const crc = crc16(new TextEncoder().encode(String(stringData)));
  log(`TX SDP: ${chunks.length} chunk(s), ${String(stringData).length} chars, crc=0x${crc.toString(16)}`);

  try {
    for (const chunk of chunks) {
      // Route through the frame layer when writing via manager state so the
      // peer sees discrete size-prefixed frames; direct char writes slice at MTU.
      for (let off = 0; off < chunk.length; off += MAX_WRITE_CHUNK) {
        const seg = chunk.slice(off, Math.min(off + MAX_WRITE_CHUNK, chunk.length));
        const props = characteristic.properties ?? {};
        if (props.writeWithoutResponse) {
          await characteristic.writeValueWithoutResponse(seg);
        } else {
          await characteristic.writeValue(seg);
        }
      }
    }
    return { chunks: chunks.length, bytes: String(stringData).length, crc };
  } catch (err) {
    error("sendBleChunkedPayload failed:", err?.message ?? err);
    if (err instanceof DOMException && err.name === "NetworkError") {
      markDisconnected("chunked write error — link lost");
    }
    throw err;
  }
}

/** In-flight reassembly buffer keyed by transfer signature (total+crc). */
const rxAssembler = {
  total: 0,
  crc: 0,
  parts: [], // Uint8Array per index
  received: 0,
  timer: null,
  resolve: null,
  reject: null,
};

function resetAssembler() {
  if (rxAssembler.timer) clearTimeout(rxAssembler.timer);
  rxAssembler.total = 0;
  rxAssembler.crc = 0;
  rxAssembler.parts = [];
  rxAssembler.received = 0;
  rxAssembler.resolve = null;
  rxAssembler.reject = null;
  rxAssembler.timer = null;
}

/**
 * Feeds one protocol chunk into the assembler; resolves the full string
 * once all chunks have arrived and the CRC verifies.
 * @param {Uint8Array} chunk full [index,total,crcHi,crcLo,...data] chunk
 */
function feedChunk(chunk) {
  if (chunk.length < SDP_CHUNK_HEADER_BYTES) {
    warn("Chunk shorter than header — dropped.");
    return;
  }
  const index = chunk[CHUNK_IDX_INDEX];
  const total = chunk[CHUNK_IDX_TOTAL];
  const crc = (chunk[CHUNK_IDX_CRC_HI] << 8) | chunk[CHUNK_IDX_CRC_LO];
  const data = chunk.slice(SDP_CHUNK_HEADER_BYTES);

  // New transfer?
  if (rxAssembler.total === 0) {
    rxAssembler.total = total;
    rxAssembler.crc = crc;
    rxAssembler.parts = new Array(total);
    rxAssembler.timer = setTimeout(() => {
      const expected = rxAssembler.total;
      const got = rxAssembler.received;
      resetAssembler();
      rxAssembler.reject?.(new Error(`BLE_TRANSFER_TIMEOUT (${got}/${expected} chunks)`));
    }, SDP_RX_TIMEOUT_MS);
    log(`RX transfer start: expecting ${total} chunk(s), crc=0x${crc.toString(16)}`);
  } else if (total !== rxAssembler.total || crc !== rxAssembler.crc) {
    warn(`Interleaved transfer detected (idx=${index},total=${total}) — ignored.`);
    return;
  }

  if (index >= total || rxAssembler.parts[index]) return; // dup / out-of-range
  rxAssembler.parts[index] = data;
  rxAssembler.received++;
  log(`RX chunk ${index + 1}/${total}`);

  if (rxAssembler.received < total) return;

  // All chunks present — concatenate and verify CRC.
  const full = new Uint8Array(rxAssembler.parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of rxAssembler.parts) {
    full.set(p, off);
    off += p.length;
  }
  const actual = crc16(full);
  const expected = rxAssembler.crc;
  const { resolve, reject } = rxAssembler;
  resetAssembler();

  if (actual !== expected) {
    error(`CRC mismatch: got 0x${actual.toString(16)}, expected 0x${expected.toString(16)} — payload corrupted.`);
    reject?.(new Error("BLE_CRC_MISMATCH"));
    return;
  }
  try {
    const text = new TextDecoder().decode(full);
    log("RX SDP assembled + verified:", text.length, "chars");
    resolve?.(text);
  } catch (e) {
    reject?.(new Error("BLE_DECODE_FAILED"));
  }
}

/**
 * Begins listening on a characteristic and returns a promise that
 * resolves with the fully reassembled, checksum-verified SDP string.
 *
 * @param {BluetoothRemoteGATTCharacteristic} characteristic notify char
 * @returns {Promise<string>} verified payload
 */
export function assembleBleChunks(characteristic) {
  if (!characteristic) return Promise.reject(new Error("BLE_NO_CHARACTERISTIC"));
  resetAssembler();

  const p = new Promise((resolve, reject) => {
    rxAssembler.resolve = resolve;
    rxAssembler.reject = reject;
  });

  const handler = (event) => {
    const dv = event.target.value;
    if (!dv) return;
    feedChunk(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
  };

  characteristic.removeEventListener?.("characteristicvaluechanged", handler);
  characteristic.addEventListener("characteristicvaluechanged", handler);
  characteristic.startNotifications?.().catch((e) => warn("startNotifications:", e?.message));
  log("Listening for chunked SDP on", characteristic.uuid);

  return p.finally(() => {
    characteristic.removeEventListener?.("characteristicvaluechanged", handler);
  });
}

/* ------------------------------------------------------------------
 * 7c. Offline SDP signaling bridge → webrtcManager
 *
 * Fully peer-to-peer: offers/answers traverse the BLE link only.
 * No signaling server, no fetch, no WebSocket — GATT is the only wire.
 * ------------------------------------------------------------------ */

let webrtcBridge = null; // { handleOffer(from, sdp), handleAnswer(sdp) }

/**
 * Registers the WebRTC manager so inbound BLE SDP is applied directly.
 * @param {import("./webrtcManager.js").WebRTCManager} manager
 */
export function bindWebRTCManager(manager) {
  if (!manager || typeof manager.handleOffer !== "function" || typeof manager.handleAnswer !== "function") {
    error("bindWebRTCManager: manager lacks handleOffer/handleAnswer — not binding.");
    return;
  }
  webrtcBridge = manager;
  log("WebRTC manager bound — BLE SDP will be applied locally.");
}

/**
 * Full offline signaling round: send our SDP chunked, then await the
 * peer's chunked reply, feeding it straight into handleOffer/handleAnswer.
 *
 * @param {"offer"|"answer"} role which SDP we are sending
 * @param {string} sdpString our serialized SDP
 * @param {BluetoothRemoteGATTCharacteristic} writeChar TX characteristic
 * @param {BluetoothRemoteGATTCharacteristic} notifyChar RX characteristic
 */
export async function exchangeSdpOverBle(role, sdpString, writeChar, notifyChar) {
  const tx = writeChar ?? state.writeCharacteristic;
  const rx = notifyChar ?? state.notifyCharacteristic;
  if (!tx || !rx) throw new Error("BLE_NOT_CONNECTED");

  const done = assembleBleChunks(rx); // start listening FIRST
  await sendBleChunkedPayload(tx, sdpString);
  log(`SDP ${role} sent over BLE — awaiting peer reply (offline path).`);

  const remoteSdp = await done;
  if (!webrtcBridge) {
    warn("No WebRTC manager bound — returning raw SDP instead.");
    return remoteSdp;
  }
  if (role === "offer") {
    // Peer sent us their offer; apply and answer locally.
    await webrtcBridge.handleOffer("ble-peer", remoteSdp);
  } else {
    await webrtcBridge.handleAnswer(remoteSdp);
  }
  return remoteSdp;
}

/* ------------------------------------------------------------------
 * 7. Data plane — chunked writes
 * ------------------------------------------------------------------ */

/**
 * Encodes a string payload with a uint16 LE length header and writes it
 * in <=20 byte chunks, awaiting each write to avoid queuing overflow.
 *
 * @param {string | Uint8Array} payload
 * @returns {Promise<void>}
 */
export async function sendFrame(payload) {
  if (!state.connected || !state.writeCharacteristic) {
    throw new Error("BLE_NOT_CONNECTED");
  }

  const bytes =
    payload instanceof Uint8Array
      ? payload
      : new TextEncoder().encode(String(payload));

  const frame = new Uint8Array(FRAME_HEADER_BYTES + bytes.length);
  frame[0] = bytes.length & 0xff;
  frame[1] = (bytes.length >> 8) & 0xff;
  frame.set(bytes, FRAME_HEADER_BYTES);

  try {
    for (let off = 0; off < frame.length; off += MAX_WRITE_CHUNK) {
      const chunk = frame.slice(
        off,
        Math.min(off + MAX_WRITE_CHUNK, frame.length),
      );
      const props = state.writeCharacteristic.properties;
      if (props.writeWithoutResponse) {
        await state.writeCharacteristic.writeValueWithoutResponse(chunk);
      } else {
        await state.writeCharacteristic.writeValue(chunk);
      }
    }
    log("TX frame:", bytes.length, "bytes");
  } catch (err) {
    error("Write failed:", err?.message ?? err);
    if (err instanceof DOMException && err.name === "NetworkError") {
      markDisconnected("write error — link lost");
    }
    throw err;
  }
}

/* ------------------------------------------------------------------
 * 8. Teardown
 * ------------------------------------------------------------------ */

/** Disconnect listener wired in scanForPeers(). */
function onDisconnected(event) {
  markDisconnected("gattserverdisconnected");
  try {
    state.disconnectHandler?.(event);
  } catch (cbErr) {
    error("onDisconnect callback threw:", cbErr?.message ?? cbErr);
  }
}

function markDisconnected(reason) {
  if (!state.connected) return;
  state.connected = false;
  state.rxBuffer = [];
  warn("BLE link down:", reason);
}

/**
 * Clean teardown: stops notifications, unsubscribes listeners, disconnects.
 */
export function disconnect() {
  try {
    state.notifyCharacteristic?.stopNotifications?.().catch(() => {});
    state.notifyCharacteristic?.removeEventListener?.(
      "characteristicvaluechanged",
      onValueChanged,
    );
    state.device?.removeEventListener?.(
      "gattserverdisconnected",
      onDisconnected,
    );
    if (state.device?.gatt?.connected) state.device.gatt.disconnect();
  } catch (err) {
    warn("Teardown warning:", err?.message ?? err);
  } finally {
    Object.assign(state, {
      device: null,
      gattServer: null,
      service: null,
      writeCharacteristic: null,
      notifyCharacteristic: null,
      connected: false,
      rxBuffer: [],
      disconnectHandler: null,
    });
    log("Bluetooth transport released.");
  }
}

/** Read-only snapshot for UI status badges. */
export function getStatus() {
  return {
    supported: state.supported,
    connected: state.connected,
    deviceName: state.device?.name ?? null,
    deviceId: state.device?.id ?? null,
    serviceUuid: state.service ? GS_SERVICE_UUID : null,
    hasNotify: !!state.notifyCharacteristic,
  };
}
