/* ============================================================
 * GHOST-STREAM // webrtcManager.js
 * Peer-to-peer connection coordinator.
 *
 *  - RTCPeerConnection with public Google STUN & Metered TURN relays
 *  - RTCDataChannel "ephemeral-chat" { ordered: true }
 *    for zero-server text exchange
 *  - Remote media tracks bound to the UI <video> element
 *  - Incoming data-channel packets routed into volatileBuffer
 *  - Buffered ICE candidates flushed strictly after setRemoteDescription
 *  - Automated sealPacket / openPacket E2EE envelope lifecycle
 *
 * Signaling (offer/answer/ICE) flows through signalingClient;
 * this module owns the RTCPeerConnection itself.
 * ============================================================ */

import {
  bindWebRTCManager,
} from "./bluetoothManager.js";
import { isOfflineMode } from "../net/transportState.js";
import { volatileBuffer } from "../memory/volatileBuffer.js";
import {
  openPacket,
  sealPacket,
  sessionCrypto,
} from "../security/cryptoUtils.js";

const CONTROL_PACKET_TYPES = new Set([
  "ping",
  "pong",
  "presence",
  "crypto-handshake",
  "crypto-handshake-reply",
  "FORCE_REMOTE_PURGE",
  "purge",
]);

/**
 * Multi-relay ICE configuration guaranteeing traversal across strict symmetric
 * cellular NATs (Airtel, Jio, Vi) and restricted firewall networks.
 */
export const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

/**
 * Offline Hotspot mode: NO STUN/TURN at all. On a shared hotspot both peers
 * share a subnet so host candidates connect directly; skipping external
 * servers avoids multi-second Google STUN timeouts and keeps the exchange
 * fully offline.
 */
export const ICE_SERVERS_OFFLINE = [];

/**
 * Active ICE configuration selector.
 * @param {boolean} offline true when Offline Hotspot transport is active
 * @returns {RTCIceServer[]}
 */
export function iceServersFor(offline) {
  return offline ? ICE_SERVERS_OFFLINE : ICE_SERVERS;
}

const PACKET_TYPES = new Set([
  "chat",
  "presence",
  "media-state",
  "ping",
  "pong",
  "crypto-handshake",
  "crypto-handshake-reply",
  "FORCE_REMOTE_PURGE",
  "purge",
]);

export class WebRTCManager {
  /**
   * @param {object} [options]
   * @param {import("./signalingClient.js").SignalingClient} options.signaling
   *        connected signaling client (offer/answer/ICE transport)
   * @param {HTMLVideoElement} [options.remoteVideoEl]
   * @param {(entry: object) => void} [options.onChatMessage]
   *        fired alongside volatileBuffer routing (UI render hook)
   * @param {Function} [options.onDataChannelOpen]
   * @param {Function} [options.onDataChannelClose]
   * @param {Function} [options.onConnectionState] (state) => void
   * @param {Function} [options.onIceConnectionState] (state) => void
   * @param {Function} [options.onSignalingState] (state) => void
   * @param {Function} [options.onRoundTripTime] (rttMs) => void
   * @param {Function} [options.onPurge] (packet) => void Host kill switch hook
   */
  constructor(options = {}) {
    this.signaling = options.signaling;
    this.remoteVideoEl = options.remoteVideoEl || null;

    /** @type {RTCPeerConnection|null} */
    this.pc = null;
    /** @type {RTCDataChannel|null} */
    this.dataChannel = null;
    /** @type {boolean} indicates whether data channel is open and ready */
    this.isDataChannelReady = false;
    /** @type {MediaStream|null} local stream added to the connection */
    this.localStream = null;
    this._videoSender = null;
    /** @type {MediaStream} aggregate remote stream */
    this.remoteStream = new MediaStream();

    this.onChatMessage = options.onChatMessage || null;
    this.onDataChannelOpen = options.onDataChannelOpen || null;
    this.onDataChannelClose = options.onDataChannelClose || null;
    this.onConnectionState = options.onConnectionState || null;
    this.onIceConnectionState = options.onIceConnectionState || null;
    this.onSignalingState = options.onSignalingState || null;
    this.onRoundTripTime = options.onRoundTripTime || null;
    this.onPurge = options.onPurge || null;

    this._pendingCandidates = []; // ICE arriving before remote description
    this._remoteDescSet = false;
    this._answerPending = false;
    this._pendingMessages = [];
    this._flushingMessages = false;
    this._pendingPings = new Map();
    this._pingSequence = 0;
    this._heartbeatTimer = null;
    this.isInitiator = false;
    this.remotePeerId = null;

    this._bindSignaling();
  }

  /* ================= lifecycle ================= */

  /**
   * Create the RTCPeerConnection, attach the local stream and open
   * the ephemeral data channel.
   * @param {MediaStream|null} [localStream] mic/cam stream to transmit
   * @param {{ initiator?: boolean, remotePeerId?: string }} [opts]
   */
  createPeerConnection(localStream = null, opts = {}) {
    this.closePeerConnection(); // idempotent re-entry

    this.isInitiator = Boolean(opts.initiator);
    this.remotePeerId = opts.remotePeerId || null;
    this._pendingCandidates = [];
    this._remoteDescSet = false;
    this._answerPending = false;
    this.isDataChannelReady = false;

    this.pc = new RTCPeerConnection({
      iceServers: iceServersFor(isOfflineMode()),
      // Offline LAN links negotiate instantly — don't linger in checking.
      ...(isOfflineMode() ? { iceCandidatePoolSize: 0 } : {}),
    });

    // Remote media in -> UI.
    this.pc.ontrack = (event) => this._handleRemoteTrack(event);

    // Diagnostics & telemetry routing.
    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      console.info(`[webrtc] connectionState: ${state}`);
      this.onConnectionState?.(state);
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc?.iceConnectionState;
      console.info(`[webrtc] iceConnectionState: ${state}`);
      this.onIceConnectionState?.(state);
    };

    this.pc.onsignalingstatechange = () => {
      const state = this.pc?.signalingState;
      console.info(`[webrtc] signalingState: ${state}`);
      this.onSignalingState?.(state);
    };

    this.pc.onicegatheringstatechange = () => {
      const state = this.pc?.iceGatheringState;
      console.info(`[webrtc] iceGatheringState: ${state}`);
    };

    // Trickle ICE out through signaling.
    this.pc.onicecandidate = (event) => {
      if (!this.signaling || !this.remotePeerId) return;
      this.signaling.sendIceCandidate(this.remotePeerId, event.candidate);
    };

    // CRITICAL: Bind ondatachannel BEFORE handling or creating SDP offers/answers.
    this.pc.ondatachannel = (event) => {
      console.info(
        `[webrtc] ondatachannel received (id: ${event.channel?.id}, label: ${event.channel?.label})`,
      );
      this.dataChannel = event.channel;
      this._setupDataChannelEvents(this.dataChannel);
    };

    // Local media out.
    this.localStream = localStream;
    this._videoSender = null;
    if (localStream) {
      for (const track of localStream.getTracks()) {
        try {
          const sender = this.pc.addTrack(track, localStream);
          if (track.kind === "video") this._videoSender = sender;
        } catch (err) {
          console.warn("[webrtc] failed to add track:", err);
        }
      }
    }
    if (!this._videoSender && typeof this.pc.addTransceiver === "function") {
      this._videoSender = this.pc.addTransceiver("video", {
        direction: "sendrecv",
      }).sender;
    }

    // Data channel: initiator creates it; receiver waits in ondatachannel.
    if (this.isInitiator) {
      this.dataChannel = this.pc.createDataChannel("ephemeral-chat", {
        ordered: true,
      });
      this._setupDataChannelEvents(this.dataChannel);
    }

    return this.pc;
  }

  /**
   * Safely attach or update the local stream on an existing RTCPeerConnection.
   * @param {MediaStream|null} stream
   */
  attachLocalStream(stream) {
    this.localStream = stream;
    if (!this.pc || !stream) return;
    const senders = typeof this.pc.getSenders === "function" ? this.pc.getSenders() : [];
    for (const track of stream.getTracks()) {
      const alreadyAdded = senders.some((s) => s.track === track);
      if (
        track.kind === "video" &&
        this._videoSender?.track === null &&
        typeof this._videoSender.replaceTrack === "function"
      ) {
        this._videoSender.replaceTrack(track).catch((err) => {
          console.warn("[webrtc] video sender replacement failed:", err?.name || err?.message);
        });
      } else if (!alreadyAdded) {
        try {
          const sender = this.pc.addTrack(track, stream);
          if (track.kind === "video") this._videoSender = sender;
        } catch (err) {
          console.warn("[webrtc] attachLocalStream error:", err);
        }
      }
    }
  }

  /**
   * Replace the outgoing camera track without renegotiation. Passing null
   * detaches the sender while keeping it available for a later camera toggle.
   * @param {MediaStreamTrack|null} track
   */
  async setLocalVideoTrack(track) {
    if (!this.pc) return;
    const senders = this.pc.getSenders?.() || [];
    const sender =
      this._videoSender ||
      senders.find((candidate) => candidate.track?.kind === "video");
    if (sender) {
      await sender.replaceTrack(track);
      this._videoSender = sender;
    } else if (track) {
      this._videoSender = this.localStream
        ? this.pc.addTrack(track, this.localStream)
        : this.pc.addTrack(track);
    }
  }

  /**
   * Full close: data channel then peer connection, references dropped.
   */
  closePeerConnection() {
    this.isDataChannelReady = false;
    if (this.dataChannel) {
      try {
        if (this.dataChannel.readyState !== "closed") this.dataChannel.close();
      } catch {
        /* ignore */
      }
      this.dataChannel = null;
    }
    if (this.pc) {
      try {
        if (this.pc.signalingState !== "closed") this.pc.close();
      } catch {
        /* ignore */
      }
      this.pc = null;
    }
    this.remoteStream = new MediaStream();
    this._videoSender = null;
    if (this.remoteVideoEl) this.remoteVideoEl.srcObject = null;
    this._remoteDescSet = false;
    this._pendingCandidates = [];
    this._answerPending = false;
    this._pendingMessages = [];
    this._stopHeartbeat();
  }

  /* ================= signaling handshake ================= */

  /** Initiator: create + publish an SDP offer. */
  async createOffer() {
    if (!this.pc) throw new Error("RTCPeerConnection not initialized");
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    if (this.signaling && this.remotePeerId) {
      this.signaling.sendOffer(this.remotePeerId, this.pc.localDescription);
    }
    return offer;
  }

  /** Receiver: consume a remote offer, answer, publish the answer. */
  async handleOffer(fromPeerId, sdp) {
    if (!this.pc) {
      this.createPeerConnection(this.localStream, { remotePeerId: fromPeerId, initiator: false });
    }
    // Guarantee ondatachannel is wired before setRemoteDescription
    if (!this.pc.ondatachannel) {
      this.pc.ondatachannel = (event) => {
        console.info(
          `[webrtc] ondatachannel received in handleOffer (id: ${event.channel?.id}, label: ${event.channel?.label})`,
        );
        this.dataChannel = event.channel;
        this._setupDataChannelEvents(this.dataChannel);
      };
    }
    this.remotePeerId = this.remotePeerId || fromPeerId;
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    this._remoteDescSet = true;
    await this._drainPendingCandidates();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    if (this.signaling) {
      this.signaling.sendAnswer(this.remotePeerId, this.pc.localDescription);
    }
    return answer;
  }

  /** Initiator: consume the remote answer with guard. */
  async handleAnswer(sdp) {
    const pc = this.pc;
    if (!pc) return;
    if (!pc.ondatachannel) {
      pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this._setupDataChannelEvents(this.dataChannel);
      };
    }
    if (pc.signalingState !== "have-local-offer" || this._answerPending) {
      console.warn(
        `[webrtc] Skipping remote description, state is: ${pc.signalingState}`,
      );
      return;
    }
    this._answerPending = true;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      if (this.pc !== pc) return;
      this._remoteDescSet = true;
      await this._drainPendingCandidates();
    } finally {
      if (this.pc === pc) this._answerPending = false;
    }
  }

  /** Trickle ICE in — buffered until the remote description exists. */
  async handleIceCandidate(candidate) {
    if (!candidate) return;
    if (!this._remoteDescSet || !this.pc?.remoteDescription) {
      this._pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn("[webrtc] ICE candidate rejected:", err?.name || err?.message);
    }
  }

  /** Flushes buffered candidates strictly after setRemoteDescription. */
  async _drainPendingCandidates() {
    if (!this.pc || !this.pc.remoteDescription) return;
    const queued = this._pendingCandidates.splice(0);
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn("[webrtc] queued candidate rejected:", err?.name || err?.message);
      }
    }
  }

  /* ================= media / UI binding ================= */

  /** @private Bind remote tracks into the remote <video> element. */
  _handleRemoteTrack(event) {
    for (const track of event.streams[0]?.getTracks() || [event.track]) {
      if (!this.remoteStream.getTracks().includes(track)) {
        this.remoteStream.addTrack(track);
      }
    }
    if (this.remoteVideoEl) {
      this.remoteVideoEl.srcObject = this.remoteStream;
      this.remoteVideoEl.play?.().catch(() => {
        /* autoplay guard */
      });
    }
  }

  /** Re-bind the remote stream to a video element. */
  bindRemoteVideo(el) {
    this.remoteVideoEl = el || null;
    if (el && this.remoteStream.getTracks().length) {
      el.srcObject = this.remoteStream;
      el.play?.().catch(() => {
        /* autoplay guard */
      });
    }
  }

  /* ================= data channel ================= */

  /** @private */
  _setupDataChannelEvents(channel) {
    if (!channel) return;

    channel.onopen = async () => {
      console.info(
        `[webrtc] DataChannel opened (id: ${channel.id}, label: ${channel.label})`,
      );
      this.isDataChannelReady = true;

      try {
        await this.onDataChannelOpen?.();
      } catch (error) {
        console.error("[webrtc] data channel open callback failed:", error);
      }

      try {
        await this.sendPacket({
          type: "presence",
          sender: this.signaling?.peerId,
          text: "linked",
        });
      } catch (error) {
        console.warn("[webrtc] presence packet send failed:", error?.name || error?.message);
      }

      await this._flushPendingMessages(channel);
      this._startHeartbeat(channel);
    };

    channel.onclose = () => {
      console.info(
        `[webrtc] DataChannel closed (id: ${channel.id}, label: ${channel.label})`,
      );
      this.isDataChannelReady = false;
      this._stopHeartbeat();
      this.onDataChannelClose?.();
    };

    channel.onerror = (event) => {
      console.error(
        `[webrtc] data channel error (readyState: ${channel.readyState})`,
        event,
      );
      this.isDataChannelReady = false;
      this._stopHeartbeat();
      this.onDataChannelClose?.();
    };

    channel.onmessage = (event) => {
      Promise.resolve(this._handlePacket(event.data)).catch((error) => {
        console.error("[webrtc] incoming data channel message failed:", error);
      });
    };

    // If channel is already open when listener is registered
    if (channel.readyState === "open" && !this.isDataChannelReady) {
      queueMicrotask(() => {
        if (channel.readyState === "open" && !this.isDataChannelReady) {
          channel.onopen?.();
        }
      });
    }
  }

  /**
   * @private Route an incoming packet: handles remote purge bypass,
   * unseals crypto envelopes, and dispatches to handler.
   */
  async _handlePacket(raw) {
    let packet;
    let encrypted = false;
    try {
      const frame = typeof raw === "string" ? JSON.parse(raw) : raw;
      const clearPacket = frame?.p || frame;
      const isExplicitlyClear = frame?.e === 0;
      const isClearControl = CONTROL_PACKET_TYPES.has(clearPacket?.type);

      // Incoming encrypted packets wait for sessionCrypto.whenReady(3000) so initial message doesn't crash with OperationError
      const isEncrypted =
        !isExplicitlyClear &&
        !isClearControl &&
        (frame?.e === 1 || Boolean(frame?.iv && (frame?.ct || frame?.data)));

      if (isEncrypted && !sessionCrypto.isReady) {
        await sessionCrypto.whenReady(3000);
      }

      const res =
        isExplicitlyClear || isClearControl
          ? { packet: clearPacket, encrypted: false }
          : await openPacket(frame);
      packet = res.packet;
      encrypted = res.encrypted;
    } catch (error) {
      console.warn(
        "[webrtc] incoming data-channel packet rejected:",
        error?.name || error?.message,
      );
      return false;
    }

    return this._handleDecodedPacket(packet, encrypted);
  }

  /** @private Route an authenticated/decoded packet. */
  async _handleDecodedPacket(packet, isEncrypted = false) {
    if (!packet || typeof packet !== "object" || Array.isArray(packet)) return false;
    if (!PACKET_TYPES.has(packet.type)) return false;

    // Remote purge trigger after decryption
    if (packet.type === "FORCE_REMOTE_PURGE" || packet.type === "purge") {
      console.warn("[webrtc] Remote purge trigger unpacked.");
      this.onPurge?.(packet);
      return true;
    }

    if (packet.type === "ping") {
      Promise.resolve(
        this.sendPacket({
          type: "pong",
          pingId: packet.pingId,
        }),
      ).catch((err) => {
        console.warn("[webrtc] heartbeat pong failed:", err?.name || err?.message);
      });
      return true;
    }

    if (packet.type === "pong") {
      const sentAt = this._pendingPings.get(packet.pingId);
      if (sentAt === undefined) return false;
      this._pendingPings.delete(packet.pingId);
      this.onRoundTripTime?.(Math.max(0, performance.now() - sentAt));
      return true;
    }

    const entry = volatileBuffer.pushMessage({
      sender: packet.sender || "remote",
      text: packet.text ?? "",
      at: typeof packet.at === "number" ? packet.at : Date.now(),
      kind:
        packet.type === "chat"
          ? isEncrypted
            ? "peer"
            : "peer-plaintext"
          : "sys",
    });

    if (packet.type === "chat") this.onChatMessage?.(entry);
    return true;
  }

  /**
   * Send a text message over the ephemeral data channel.
   * Drains immediately if open; otherwise buffers safely and auto-flushes on connect.
   * @param {string} text
   * @param {{ sender?: string, encryption?: string }} [opts]
   * @returns {Promise<boolean>}
   */
  async sendMessage(text, opts = {}) {
    if (!text || !text.trim()) return false;

    const trimmed = text.trim();
    const packet = {
      type: "chat",
      sender: opts.sender || this.signaling?.peerId || "anon",
      text: trimmed,
      at: Date.now(),
      ...(opts.encryption ? { encryption: opts.encryption } : {}),
    };

    const kind =
      packet.encryption === "plaintext-fallback"
        ? "self-plaintext"
        : "self";

    // 1. Channel is open and ready to transmit immediately
    if (this.dataChannel && this.dataChannel.readyState === "open") {
      const sent = await this.sendPacket(packet);
      if (sent) {
        const entry = volatileBuffer.pushMessage({
          sender: packet.sender || "self",
          text: packet.text,
          at: packet.at,
          kind,
        });
        this.onChatMessage?.(entry);
        return true;
      }
    }

    // 2. Channel is connecting, closed, or send was deferred: queue for auto-flush
    this._pendingMessages.push(packet);
    console.warn("[webrtc] DataChannel connecting; message queued for auto-flush");

    // Render an optimistic local bubble into volatile buffer and UI
    const entry = volatileBuffer.pushMessage({
      sender: packet.sender || "self",
      text: packet.text,
      at: packet.at,
      kind,
    });
    this.onChatMessage?.(entry);

    return true;
  }

  /** Drain queued chat messages through an open channel. */
  async _flushPendingMessages(channel) {
    const targetChannel = channel || this.dataChannel;
    if (!targetChannel || targetChannel.readyState !== "open") return;
    if (this._flushingMessages) return;
    this._flushingMessages = true;
    try {
      while (this._pendingMessages.length && targetChannel.readyState === "open") {
        const packet = this._pendingMessages[0];
        const sent = await this.sendPacket(packet);
        if (!sent) {
          console.warn("[webrtc] could not send queued packet during flush; pausing drain");
          break;
        }
        this._pendingMessages.shift();
      }
    } catch (err) {
      console.error("[webrtc] error flushing pending messages:", err);
    } finally {
      this._flushingMessages = false;
    }
  }

  flushPendingMessages() {
    if (this.dataChannel?.readyState !== "open") return Promise.resolve();
    return this._flushPendingMessages(this.dataChannel);
  }

  /** Start RTT heartbeat with non-blocking isolation. */
  _startHeartbeat(channel) {
    this._stopHeartbeat();
    const sendPing = () => {
      if (channel !== this.dataChannel || channel.readyState !== "open") return;
      const now = performance.now();
      for (const [pingId, sentAt] of this._pendingPings) {
        if (now - sentAt > 5000) this._pendingPings.delete(pingId);
      }

      const pingId = String(++this._pingSequence);
      this._pendingPings.set(pingId, now);
      Promise.resolve(this.sendPacket({ type: "ping", pingId }))
        .then((sent) => {
          if (!sent) this._pendingPings.delete(pingId);
        })
        .catch((err) => {
          console.warn("[webrtc] heartbeat ping failed:", err?.name || err?.message);
          this._pendingPings.delete(pingId);
        });
    };

    sendPing();
    this._heartbeatTimer = setInterval(sendPing, 1000);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer !== null) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    this._pendingPings.clear();
  }

  /**
   * Low-level packet send: automatically encrypts via sealPacket()
   * Synchronously returns false if channel is closed.
   * @param {object} packet
   * @returns {boolean|Promise<boolean>}
   */
  sendPacket(packet) {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      console.warn(
        `[webrtc] data channel not open (readyState: ${this.dataChannel?.readyState ?? "unavailable"}); packet not sent`,
      );
      return false;
    }
    return (async () => {
      try {
        let wire;
        const isHandshake =
          packet.type === "crypto-handshake" ||
          packet.type === "crypto-handshake-reply";
        const isControl = isHandshake || CONTROL_PACKET_TYPES.has(packet.type);

        if (isHandshake || isControl || packet.type !== "chat") {
          // ALWAYS transmit crypto-handshake and crypto-handshake-reply as cleartext control frames
          wire = JSON.stringify({ p: packet, e: 0 });
        } else if (packet.type === "chat") {
          if (
            !sessionCrypto.isReady &&
            packet.encryption !== "plaintext-fallback"
          ) {
            try {
              await sessionCrypto.whenReady(1500);
            } catch {
              /* timeout */
            }
          }
          if (
            sessionCrypto.isReady &&
            packet.encryption !== "plaintext-fallback"
          ) {
            packet.encryption = "encrypted";
            wire = await sealPacket(packet);
          } else {
            // Fallback to immediate transport with unencrypted tag rather than silently holding
            packet.encryption = "plaintext-fallback";
            wire = JSON.stringify({ p: packet, e: 0 });
            console.warn("[webrtc] sending chat frame with plaintext-fallback tag");
          }
        } else {
          wire = JSON.stringify({ p: packet, e: 0 });
        }
        if (this.dataChannel?.readyState !== "open") return false;
        this.dataChannel.send(wire);
        return true;
      } catch (error) {
        console.warn(
          `[webrtc] data channel send failed (readyState: ${this.dataChannel?.readyState ?? "unavailable"}):`,
          error?.name || error?.message,
        );
        return false;
      }
    })();
  }

  /* ================= signaling plumbing ================= */

  /** @private Wire signaling events into the SDP/ICE handlers. */
  _bindSignaling() {
    // Offline BLE transport: route inbound chunked SDP into handleOffer/handleAnswer
    // via the bluetoothManager bridge — zero internet dependency.
    bindWebRTCManager({
      handleOffer: (from, sdp) =>
        this.handleOffer(from, sdp).catch((err) =>
          console.warn("[webrtc] BLE offer handling failed:", err?.name || err?.message),
        ),
      handleAnswer: (sdp) =>
        this.handleAnswer(sdp).catch((err) =>
          console.warn("[webrtc] BLE answer handling failed:", err?.name || err?.message),
        ),
    });

    if (!this.signaling) return;
    this.signaling.onOffer = (from, sdp) => {
      if (!this.pc) {
        this.createPeerConnection(this.localStream, { remotePeerId: from, initiator: false });
      } else {
        this.remotePeerId = from;
      }
      this.handleOffer(from, sdp).catch((err) =>
        console.warn("[webrtc] offer handling failed:", err?.name || err?.message),
      );
    };
    this.signaling.onAnswer = (from, sdp) => {
      if (from) this.remotePeerId = from;
      this.handleAnswer(sdp).catch((err) =>
        console.warn("[webrtc] answer handling failed:", err?.name || err?.message),
      );
    };
    this.signaling.onIceCandidate = (from, candidate) => {
      if (!this.pc) {
        this.createPeerConnection(this.localStream, { remotePeerId: from, initiator: false });
      } else if (!this.remotePeerId) {
        this.remotePeerId = from;
      }
      this.handleIceCandidate(candidate);
    };
  }

  /** @returns {{ pc: string, dc: string }} readiness snapshot */
  get status() {
    return {
      pc: this.pc?.connectionState || "closed",
      dc: this.dataChannel?.readyState || "closed",
    };
  }
}

export default WebRTCManager;
