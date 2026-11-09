/* ============================================================
 * GHOST-STREAM // signalingClient.js
 * Native WebSocket manager for the backend signaling relay.
 *
 * Responsibilities:
 *  - Open / reconnect (exponential backoff, jitter, max attempts)
 *  - Room lifecycle: join-room, leave, peer-id allocation
 *  - SDP offer / answer / ICE candidate exchange
 *  - Callback emission to the WebRTC manager
 *
 * Protocol (JSON messages over one socket):
 *   -> { type: "join-room", roomId, peerId, token, isHost }
 *   -> { type: "leave-room", roomId, peerId }
 *   -> { type: "sdp-offer",  to, sdp }
 *   -> { type: "sdp-answer", to, sdp }
 *   -> { type: "ice-candidate", to, candidate }
 *   <- { type: "joined", room, peerId, peers: [peerId...] }
 *   <- { type: "peer-joined", peerId }
 *   <- { type: "knock-request", peerId, timestamp }
 *   <- { type: "pending-approval" | "knock-approved" | "connection-rejected", ... }
 *   <- { type: "peer-left", peerId }
 *   <- { type: "sdp-offer" | "sdp-answer" | "ice-candidate", from, ... }
 *   <- { type: "error", message }
 * ============================================================ */

/**
 * Resolved signaling endpoint strictly prioritizing Vite's environment variable.
 * Fallback connects to local backend or dedicated Render signaling server with root path.
 */
export const SIGNALING_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_SIGNALING_URL) ||
  ((typeof window !== "undefined" ? window.location.hostname : "localhost") === "localhost"
    ? "ws://localhost:10000"
    : "wss://ghost-stream-backend.onrender.com");

export const DEFAULT_URL = SIGNALING_URL;

/** Reconnection policy. */
const RECONNECT = {
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  maxAttempts: Infinity, // keep trying; UI decides when to give up
  jitter: 0.3,
};

const OUT_TYPES = new Set([
  "join-room",
  "leave-room",
  "sdp-offer",
  "sdp-answer",
  "ice-candidate",
  "panic-destroy",
  "ping",
  "knock-approved",
  "knock-rejected",
  "rotate-room-token",
]);

export class SignalingClient {
  /**
   * @param {object} [options]
   * @param {string}   [options.url]        signaling websocket URL
   * @param {string}   [options.room]       room code to join on connect
   * @param {string}   [options.peerId]     local peer identity (auto if omitted)
   * @param {number}   [options.maxAttempts]
   * @param {boolean}  [options.autoReconnect=true]
   */
  constructor(options = {}) {
    this.url = options.url || DEFAULT_URL;
    this.room = options.room || null;
    this.roomToken = options.token || null;
    this.isHost = options.isHost === true;
    this.peerId = options.peerId || this._generatePeerId();
    this.autoReconnect = options.autoReconnect !== false;
    this.maxAttempts = options.maxAttempts ?? RECONNECT.maxAttempts;

    /** @type {WebSocket|null} */
    this._ws = null;
    this._attempts = 0;
    this._reconnectTimer = null;
    this._intentionalClose = false;
    this._pendingQueue = []; // messages queued while socket is down
    this._pingTimer = null;

    // ---- callbacks consumed by the WebRTC manager ----
    this.onOpen = null; // () => void                      (socket ready)
    this.onJoined = null; // (room, peerId, peers[]) => void
    this.onPeerJoined = null; // (peerId) => void
    this.onPeerLeft = null; // (peerId) => void
    this.onKnockRequest = null; // ({ peerId, timestamp }) => void
    this.onJoinPending = null; // ({ peerId }) => void
    this.onKnockApproved = null; // ({ peerId, room }) => void
    this.onKnockExpired = null; // ({ peerId, reason }) => void
    this.onConnectionRejected = null; // ({ message, reason }) => void
    this.onRoomTokenRotated = null; // () => void
    this.onOffer = null; // (fromPeerId, sdp) => void
    this.onAnswer = null; // (fromPeerId, sdp) => void
    this.onIceCandidate = null; // (fromPeerId, candidate) => void
    this.onError = null; // (err) => void
    this.onDisconnect = null; // (willRetry, attempts) => void
    this.onReconnecting = null; // (attempt, delayMs) => void
  }

  /* ---------------- lifecycle ---------------- */

  /** @returns {Promise<void>} resolves once the socket is open. */
  connect() {
    if (this.isConnected) return Promise.resolve();

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    return new Promise((resolve, reject) => {
      this._intentionalClose = false;
      let settled = false;

      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.onError?.(err);
        this._scheduleReconnect();
        return;
      }
      this._ws = ws;

      ws.onopen = () => {
        this._attempts = 0;
        this._startPing();
        settled = true;
        this.onOpen?.();
        // Auto-join the configured room as soon as the wire is live.
        if (this.room) this.joinRoom(this.room);
        this._flushQueue();
        resolve();
      };

      ws.onmessage = (event) => this._handleMessage(event.data);
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("signaling socket error"));
        }
        this.onError?.(new Error("signaling socket error"));
      };

      ws.onclose = (event) => {
        this._stopPing();
        this._ws = null;
        if (!settled) {
          settled = true;
          reject(new Error(`socket closed (${event.code})`));
        }
        this._scheduleReconnect();
      };
    });
  }

  /** Clean shutdown — no reconnect will be attempted. */
  disconnect() {
    this._intentionalClose = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._pendingQueue.length = 0;
    this._stopPing();
    if (this._ws) {
      try {
        this._ws.close(1000, "client disconnect");
      } catch {
        /* ignore */
      }
      this._ws = null;
    }
  }

  get isConnected() {
    return this._ws?.readyState === WebSocket.OPEN;
  }

  /* ---------------- room + media signaling ---------------- */

  joinRoom(room, { token = this.roomToken, isHost = this.isHost } = {}) {
    this.room = room || this.room;
    this.roomToken = token || null;
    this.isHost = Boolean(isHost);
    return this.send({
      type: "join-room",
      roomId: this.room,
      peerId: this.peerId,
      token: this.roomToken,
      isHost: this.isHost,
    });
  }

  leaveRoom() {
    const msg = { type: "leave-room", roomId: this.room, peerId: this.peerId };
    this.room = null;
    this.roomToken = null;
    this.isHost = false;
    return this.send(msg);
  }

  destroyRoom() {
    const roomId = this.room;
    this.room = null;
    this.roomToken = null;
    this.isHost = false;
    this._pendingQueue.length = 0;
    return this.send({ type: "panic-destroy", roomId, peerId: this.peerId });
  }

  approveKnock(peerId) {
    if (!this.isConnected) return false;
    return this.send({ type: "knock-approved", to: peerId });
  }

  rejectKnock(peerId, replacementToken) {
    if (!this.isConnected) return false;
    const sent = this.send({
      type: "knock-rejected",
      to: peerId,
      token: replacementToken,
    });
    if (sent) this.roomToken = replacementToken;
    return sent;
  }

  rotateRoomToken(token) {
    if (!this.isConnected) return false;
    const sent = this.send({ type: "rotate-room-token", token });
    if (sent) this.roomToken = token;
    return sent;
  }

  /** Send our SDP offer to a specific peer. */
  sendOffer(to, sdp) {
    return this.send({ type: "sdp-offer", to, sdp });
  }

  /** Send our SDP answer to a specific peer. */
  sendAnswer(to, sdp) {
    return this.send({ type: "sdp-answer", to, sdp });
  }

  /** Relay a trickle ICE candidate. `candidate` may be null (end-of-candidates). */
  sendIceCandidate(to, candidate) {
    return this.send({
      type: "ice-candidate",
      to,
      candidate: candidate
        ? {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
          }
        : null,
    });
  }

  /**
   * Low-level send. If the socket is down, the message is queued and
   * flushed on reconnect so no offer/answer/ICE is lost mid-negotiation.
   * @param {object} message
   * @returns {boolean} true if sent immediately
   */
  send(message) {
    if (this.isConnected) {
      this._ws.send(JSON.stringify(message));
      return true;
    }
    if (OUT_TYPES.has(message.type)) this._pendingQueue.push(message);
    return false;
  }

  /* ---------------- internals ---------------- */

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // non-JSON frame — ignore
    }
    if (msg.type === "pong") return;

    switch (msg.type) {
      case "joined":
        this.onJoined?.(
          msg.room ?? this.room,
          msg.peerId ?? this.peerId,
          msg.peers ?? [],
          msg.isHost === true,
        );
        break;
      case "peer-joined":
        this.onPeerJoined?.(msg.peerId);
        break;
      case "peer-left":
        this.onPeerLeft?.(msg.peerId);
        break;
      case "knock-request":
        this.onKnockRequest?.({
          peerId: msg.peerId,
          timestamp: msg.timestamp,
        });
        break;
      case "pending-approval":
        this.onJoinPending?.({ peerId: msg.peerId });
        break;
      case "knock-approved":
        this.onKnockApproved?.({ peerId: msg.peerId, room: msg.room });
        break;
      case "knock-expired":
        this.onKnockExpired?.({ peerId: msg.peerId, reason: msg.reason });
        break;
      case "connection-rejected":
        this.onConnectionRejected?.({
          message: msg.message || "Connection rejected.",
          reason: msg.reason,
        });
        break;
      case "room-token-rotated":
        this.onRoomTokenRotated?.();
        break;
      case "sdp-offer":
        this.onOffer?.(msg.from, msg.sdp);
        break;
      case "sdp-answer":
        this.onAnswer?.(msg.from, msg.sdp);
        break;
      case "ice-candidate":
        this.onIceCandidate?.(msg.from, msg.candidate);
        break;
      case "error":
        this.onError?.(new Error(msg.message || "signaling error"));
        break;
      default:
        break; // unknown frame types are tolerated (forward compat)
    }
  }

  _scheduleReconnect() {
    if (this._intentionalClose || !this.autoReconnect) {
      this.onDisconnect?.(false, this._attempts);
      return;
    }
    if (this._attempts >= this.maxAttempts) {
      this.onDisconnect?.(false, this._attempts);
      return;
    }
    this._attempts += 1;
    const expo = Math.min(
      RECONNECT.maxDelayMs,
      RECONNECT.baseDelayMs * 2 ** (this._attempts - 1),
    );
    const delay = Math.round(expo * (1 + Math.random() * RECONNECT.jitter));
    this.onDisconnect?.(true, this._attempts);
    this.onReconnecting?.(this._attempts, delay);
    this._reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        /* onclose already scheduled the next retry */
      });
    }, delay);
  }

  _flushQueue() {
    const queue = this._pendingQueue.splice(0);
    for (const msg of queue) this.send(msg);
  }

  _startPing() {
    this._stopPing();
    // Keep intermediaries from dropping an idle socket.
    this._pingTimer = setInterval(() => this.send({ type: "ping" }), 25_000);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _generatePeerId() {
    // Random, non-persistent peer identity — regenerated every session.
    const bytes =
      typeof crypto !== "undefined" && crypto.getRandomValues
        ? crypto.getRandomValues(new Uint8Array(8))
        : new Uint8Array(8).map(() => Math.floor(Math.random() * 256));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
}

export default SignalingClient;
