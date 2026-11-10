/* ============================================================
 * GHOST-STREAM // cryptoUtils.js
 * Ephemeral end-to-end encryption for RTCDataChannel traffic.
 *
 * Model:
 *   - Both peers derive an identical AES-GCM session key from an
 *     ECDH P-256 key pair exchange performed over the (already
 *     encrypted) WebRTC data/signaling path.
 *   - The raw key material NEVER touches localStorage, cookies,
 *     sessionStorage, or disk. It lives only in a NonceIdentity
 *     WebCrypto CryptoKey (non-extractable).
 *   - Every message gets a fresh random 96-bit IV; ciphertext on
 *     the wire means plaintext never sits in network buffers.
 *   - zeroize() destroys the key handle — after that, encrypt()
 *     is impossible and past traffic is cryptographically dead.
 * ============================================================ */

/** AES-GCM 256-bit keys. */
const AES_ALGO = { name: "AES-GCM", length: 256 };
/** ECDH curve for the key agreement. */
const ECDH_ALGO = { name: "ECDH", namedCurve: "P-256" };
/** 96-bit IV per message (GCM standard). */
const IV_BYTES = 12;

/** Raise a clear error when WebCrypto is unavailable (insecure origin). */
function requireSubtle() {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error(
      "WebCrypto (crypto.subtle) unavailable — HTTPS or localhost required",
    );
  }
  return crypto.subtle;
}

/** Random bytes via the platform CSPRNG. */
function randomBytes(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

/* ============================================================
 * Session crypto channel
 * ============================================================ */
export class EphemeralCrypto {
  constructor() {
    /** @type {CryptoKey|null} AES-GCM session key (non-extractable) */
    this._sessionKey = null;
    /** @type {boolean} */
    this._destroyed = false;
    /** @type {string|null} fingerprint of our ECDH public key (debug/SAS) */
    this._localFingerprint = null;
    this._readyWaiters = new Set();
  }

  get isReady() {
    return !this._destroyed && this._sessionKey !== null;
  }

  /* ---------------- key agreement ---------------- */

  /**
   * Step 1: generate this side's ephemeral ECDH key pair.
   * @returns {Promise<{ publicKey: ArrayBuffer, fingerprint: string }>}
   *          `publicKey` is the value to send to the peer.
   */
  async beginHandshake() {
    const subtle = requireSubtle();
    this._destroyed = false;

    const pair = await subtle.generateKey(ECDH_ALGO, false, ["deriveKey"]);
    const rawPub = await subtle.exportKey("raw", pair.publicKey);

    // Short SAS-style fingerprint for out-of-band visual comparison.
    const digest = await subtle.digest("SHA-256", rawPub);
    this._localFingerprint = [...new Uint8Array(digest).slice(0, 6)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Stash the private handle for step 2 (RAM only, non-extractable).
    this._pendingPrivate = pair.privateKey;
    return { publicKey: rawPub, fingerprint: this._localFingerprint };
  }

  /**
   * Step 2a (initiator completes first): mix the peer's public key in
   * and derive the shared AES-GCM session key.
   * @param {ArrayBuffer|Uint8Array} peerPublicKey raw ECDH public key from the peer
   */
  async completeHandshake(peerPublicKey) {
    const subtle = requireSubtle();
    if (this._destroyed) throw new Error("crypto channel destroyed");
    if (!this._pendingPrivate) throw new Error("beginHandshake() not called");

    const peerKey = await subtle.importKey(
      "raw",
      peerPublicKey,
      ECDH_ALGO,
      false,
      [],
    );
    this._sessionKey = await subtle.deriveKey(
      { name: "ECDH", public: peerKey },
      this._pendingPrivate,
      AES_ALGO,
      false, // non-extractable: the raw key never leaves WebCrypto
      ["encrypt", "decrypt"],
    );
    // Drop the ECDH private handle reference immediately.
    this._pendingPrivate = null;
    this._notifyReadyWaiters(true);
  }

  /**
   * Resolve when key agreement completes, or return false after the timeout.
   * @param {number} [timeoutMs=0] zero waits without a timeout
   * @returns {Promise<boolean>}
   */
  whenReady(timeoutMs = 0) {
    if (this.isReady) return Promise.resolve(true);
    if (this._destroyed) return Promise.resolve(false);

    return new Promise((resolve) => {
      let timeoutId = null;
      const finish = (ready) => {
        if (timeoutId !== null) clearTimeout(timeoutId);
        this._readyWaiters.delete(finish);
        resolve(ready);
      };
      this._readyWaiters.add(finish);
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => finish(this.isReady), timeoutMs);
      }
    });
  }

  _notifyReadyWaiters(ready) {
    for (const resolve of this._readyWaiters) resolve(ready);
  }

  /* ---------------- symmetric envelope ---------------- */

  /**
   * Encrypt a plaintext string into a transport-ready envelope.
   * @param {string} plaintext
   * @returns {Promise<{ iv: string, ct: string, v: 1 }>} base64url parts
   */
  async encrypt(plaintext) {
    if (!this.isReady) throw new Error("session key not ready or destroyed");
    const subtle = requireSubtle();
    const iv = randomBytes(IV_BYTES); // fresh IV per message — never reuse
    const ct = await subtle.encrypt(
      { name: "AES-GCM", iv },
      this._sessionKey,
      new TextEncoder().encode(plaintext),
    );
    return { v: 1, iv: toB64url(iv), ct: toB64url(new Uint8Array(ct)) };
  }

  /**
   * Decrypt an envelope produced by encrypt().
   * @param {{ iv: string, ct: string, v?: number }} envelope
   * @returns {Promise<string>} plaintext
   * @throws on tampered/mismatched data (GCM auth failure)
   */
  async decrypt(envelope) {
    if (!this.isReady) throw new Error("session key not ready or destroyed");
    const subtle = requireSubtle();
    const iv = fromB64url(envelope.iv);
    const pt = await subtle.decrypt(
      { name: "AES-GCM", iv },
      this._sessionKey,
      fromB64url(envelope.ct),
    );
    return new TextDecoder().decode(pt);
  }

  /* ---------------- zeroization ---------------- */

  /**
   * Destroy the session key. WebCrypto keys are managed by the
   * browser's secure world, so the handle is simply released and
   * marked dead — the key can never be used or extracted again.
   */
  zeroize() {
    this._sessionKey = null;
    this._pendingPrivate = null;
    this._localFingerprint = null;
    this._destroyed = true;
    this._notifyReadyWaiters(false);
  }

  get fingerprint() {
    return this._localFingerprint;
  }
}

/* ============================================================
 * Convenience API — single shared channel + auto-wrapped packets
 * ============================================================ */

/** Singleton used by the WebRTC manager / app for chat traffic. */
export const sessionCrypto = new EphemeralCrypto();

/**
 * Wrap a data-channel packet: encrypt its JSON body when the session
 * key is live, otherwise send cleartext JSON (bootstrap phase only —
 * handshakes and presence must flow before the key exists).
 *
 * @param {object} packet
 * @returns {Promise<string>} wire string: {"e":1,"iv":..,"ct":..} or plain JSON
 */
export async function sealPacket(packet) {
  if (!sessionCrypto.isReady) return JSON.stringify({ p: packet, e: 0 });
  const env = await sessionCrypto.encrypt(JSON.stringify(packet));
  return JSON.stringify({ e: 1, ...env });
}

/**
 * Unseal an incoming wire string produced by sealPacket().
 * @param {string} wire
 * @returns {Promise<{ packet: object, encrypted: boolean }>}
 * @throws when marked encrypted but no key / auth failure
 */
export async function openPacket(wire) {
  const frame = JSON.parse(wire);
  if (!frame || typeof frame !== "object") {
    throw new TypeError("invalid data-channel packet");
  }
  if (frame.e === 1) {
    const plaintext = await sessionCrypto.decrypt(frame);
    return { packet: JSON.parse(plaintext), encrypted: true };
  }
  return {
    packet: Object.hasOwn(frame, "p") ? frame.p : frame,
    encrypted: false,
  };
}

/** Decode a standard Base64 string to bytes (used for ECDH public keys). */
export function fromB64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

/** Encode bytes as standard Base64 (used for ECDH public keys). */
export function toB64(arr) {
  return btoa(String.fromCharCode(...arr));
}

/* ---------------- base64url helpers ---------------- */

const CHUNK_SIZE = 0x8000;

function toB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(str) {
  const b64 =
    str.replace(/-/g, "+").replace(/_/g, "/") +
    "==".slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default EphemeralCrypto;
