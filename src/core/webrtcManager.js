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
 *
 * Signaling (offer/answer/ICE) flows through signalingClient;
 * this module owns the RTCPeerConnection itself.
 * ============================================================ */

import { volatileBuffer } from "../memory/volatileBuffer.js";

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

/** Valid packet types accepted on the data channel. */
const PACKET_TYPES = new Set([
  "chat",
  "presence",
  "media-state",
  "ping",
  "pong",
  "crypto-handshake",
  "crypto-handshake-reply",
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
   */
  constructor(options = {}) {
    this.signaling = options.signaling;
    this.remoteVideoEl = options.remoteVideoEl || null;

    /** @type {RTCPeerConnection|null} */
    this.pc = null;
    /** @type {RTCDataChannel|null} */
    this.dataChannel = null;
    /** @type {MediaStream|null} local stream added to the connection */
    this.localStream = null;
    /** @type {MediaStream} aggregate remote stream */
    this.remoteStream = new MediaStream();

    this.onChatMessage = options.onChatMessage || null;
    this.onDataChannelOpen = options.onDataChannelOpen || null;
    this.onDataChannelClose = options.onDataChannelClose || null;
    this.onConnectionState = options.onConnectionState || null;
    this.onIceConnectionState = options.onIceConnectionState || null;
    this.onSignalingState = options.onSignalingState || null;
    this.onRoundTripTime = options.onRoundTripTime || null;

    this._pendingCandidates = []; // ICE arriving before remote description
    this._remoteDescSet = false;
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

    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Local media out.
    this.localStream = localStream;
    if (localStream) {
      for (const track of localStream.getTracks()) {
        try {
          this.pc.addTrack(track, localStream);
        } catch (err) {
          console.warn("[webrtc] failed to add track:", err);
        }
      }
    }

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

    // Data channel: initiator creates it; receiver waits in ondatachannel.
    if (this.isInitiator) {
      this.dataChannel = this.pc.createDataChannel("ephemeral-chat", {
        ordered: true,
      });
      this._setupDataChannelEvents(this.dataChannel);
    } else {
      this.pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this._setupDataChannelEvents(this.dataChannel);
      };
    }

    return this.pc;
  }

  /**
   * Safely attach or update the local stream on an existing RTCPeerConnection.
   * Ensures joiners acquiring media after offer arrival still stream their tracks.
   * @param {MediaStream|null} stream
   */
  attachLocalStream(stream) {
    this.localStream = stream;
    if (!this.pc || !stream) return;
    const senders = typeof this.pc.getSenders === "function" ? this.pc.getSenders() : [];
    for (const track of stream.getTracks()) {
      const alreadyAdded = senders.some((s) => s.track === track);
      if (!alreadyAdded) {
        try {
          this.pc.addTrack(track, stream);
        } catch (err) {
          console.warn("[webrtc] attachLocalStream error:", err);
        }
      }
    }
  }

  /**
   * Full close: data channel then peer connection, references dropped.
   * Idempotent; also used before any re-negotiation.
   */
  closePeerConnection() {
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
    if (this.remoteVideoEl) this.remoteVideoEl.srcObject = null;
    this._remoteDescSet = false;
    this._pendingCandidates = [];
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
    if (!this.pc) throw new Error("RTCPeerConnection not initialized for offer");
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

  /** Initiator: consume the remote answer. */
  async handleAnswer(sdp) {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    this._remoteDescSet = true;
    await this._drainPendingCandidates();
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
    // Aggregate stream keeps audio+video synchronised in one srcObject.
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

  /**
   * Re-bind the remote stream to a (possibly re-rendered) video element.
   * @param {HTMLVideoElement} el
   */
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
    channel.onopen = async () => {
      try {
        await this.onDataChannelOpen?.();
      } catch (error) {
        console.error("[webrtc] data channel open callback failed:", error);
      }
      // First packet announces our presence — no server ever sees this.
      await this.sendPacket({
        type: "presence",
        sender: this.signaling?.peerId,
        text: "linked",
      });
      await this._flushPendingMessages(channel);
      this._startHeartbeat(channel);
    };
    channel.onclose = () => {
      this._stopHeartbeat();
      this.onDataChannelClose?.();
    };
    channel.onerror = (event) => {
      this._stopHeartbeat();
      console.error(
        `[webrtc] data channel error (readyState: ${channel.readyState})`,
        event,
      );
      this.onDataChannelClose?.();
    };
    channel.onmessage = (event) => {
      Promise.resolve(this._handlePacket(event.data)).catch((error) => {
        console.error("[webrtc] incoming data channel message failed:", error);
      });
    };
  }

  /**
   * @private Route an incoming packet: into volatileBuffer, then UI hook.
   */
  async _handlePacket(raw) {
    let packet;
    try {
      packet = JSON.parse(raw);
    } catch {
      return; // non-JSON frame — ignore
    }
    if (!PACKET_TYPES.has(packet.type)) return;

    if (packet.type === "ping") {
      await this.sendPacket({
        type: "pong",
        pingId: packet.pingId,
      });
      return;
    }

    if (packet.type === "pong") {
      const sentAt = this._pendingPings.get(packet.pingId);
      if (sentAt === undefined) return;
      this._pendingPings.delete(packet.pingId);
      this.onRoundTripTime?.(Math.max(0, performance.now() - sentAt));
      return;
    }

    const entry = volatileBuffer.pushMessage({
      sender: packet.sender || "remote",
      text: packet.text ?? "",
      at: typeof packet.at === "number" ? packet.at : Date.now(),
      kind:
        packet.type === "chat"
          ? packet.encryption === "plaintext-fallback"
            ? "peer-plaintext"
            : "peer"
          : "sys",
    });

    if (packet.type === "chat") this.onChatMessage?.(entry);
  }

  /**
   * Send a text message over the ephemeral data channel.
   * @param {string} text
   * @param {{ sender?: string }} [opts]
   * @returns {Promise<boolean>} true if the channel was open and the packet sent
   */
  async sendMessage(text, opts = {}) {
    const packet = {
      type: "chat",
      sender: opts.sender || this.signaling?.peerId,
      text: String(text),
      at: Date.now(),
      ...(opts.encryption ? { encryption: opts.encryption } : {}),
    };

    if (this.dataChannel?.readyState === "open") {
      const sent = await this.sendPacket(packet);
      if (sent) {
        const entry = volatileBuffer.pushMessage({
          sender: packet.sender || "self",
          text: packet.text,
          at: packet.at,
          kind:
            packet.encryption === "plaintext-fallback"
              ? "self-plaintext"
              : "self",
        });
        this.onChatMessage?.(entry);
      }
      return Boolean(sent);
    }

    // Channel still negotiating: queue locally and mirror into volatile buffer.
    this._pendingMessages.push(packet);
    const entry = volatileBuffer.pushMessage({
      sender: packet.sender || "self",
      text: packet.text,
      at: packet.at,
      kind:
        packet.encryption === "plaintext-fallback"
          ? "self-plaintext"
          : "self",
    });
    this.onChatMessage?.(entry);
    return true;
  }

  /**
   * @private Drain queued chat messages through an open channel.
   * Shifts items ONLY after send succeeds so transient failures do not drop text.
   */
  async _flushPendingMessages(channel) {
    if (this._flushingMessages) return;
    this._flushingMessages = true;
    try {
      while (this._pendingMessages.length && channel.readyState === "open") {
        const packet = this._pendingMessages[0];
        const sent = await this.sendPacket(packet);
        if (!sent) {
          console.error(
            `[webrtc] queued chat message remains queued (readyState: ${channel.readyState})`,
          );
          return;
        }
        this._pendingMessages.shift();
      }
    } finally {
      this._flushingMessages = false;
      if (
        channel !== this.dataChannel &&
        this.dataChannel?.readyState === "open" &&
        this._pendingMessages.length
      ) {
        this.flushPendingMessages().catch((error) => {
          console.error("[webrtc] queued chat retry failed:", error);
        });
      }
    }
  }

  /** Retry queued messages when encryption becomes ready after channel open. */
  flushPendingMessages() {
    if (this.dataChannel?.readyState !== "open") return Promise.resolve();
    return this._flushPendingMessages(this.dataChannel);
  }

  /** @private Start the one-second data-channel RTT heartbeat. */
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
        .catch((error) => {
          this._pendingPings.delete(pingId);
          console.error("[webrtc] RTT ping failed:", error);
        });
    };

    sendPing();
    this._heartbeatTimer = setInterval(sendPing, 1000);
  }

  /** @private Stop heartbeat work and discard outstanding samples. */
  _stopHeartbeat() {
    if (this._heartbeatTimer !== null) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    this._pendingPings.clear();
  }

  /**
   * Low-level packet send over the ephemeral channel.
   * @param {{ type: string, sender?: string, text?: string, at?: number }} packet
   * @returns {boolean|Promise<boolean>}
   */
  sendPacket(packet) {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      console.warn(
        `[webrtc] data channel not open (readyState: ${this.dataChannel?.readyState ?? "unavailable"}); packet not sent`,
      );
      return false;
    }
    try {
      this.dataChannel.send(JSON.stringify(packet));
      return true;
    } catch (error) {
      console.error(
        `[webrtc] data channel send failed (readyState: ${this.dataChannel.readyState}):`,
        error,
      );
      return false;
    }
  }

  /* ================= signaling plumbing ================= */

  /** @private Wire signaling events into the SDP/ICE handlers. */
  _bindSignaling() {
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
