/* ============================================================
 * GHOST-STREAM // webrtcManager.js
 * Peer-to-peer connection coordinator.
 *
 *  - RTCPeerConnection with public Google STUN servers
 *  - RTCDataChannel "ephemeral-chat" { ordered: true }
 *    for zero-server text exchange
 *  - Remote media tracks bound to the UI <video> element
 *  - Incoming data-channel packets routed into volatileBuffer
 *
 * Signaling (offer/answer/ICE) flows through signalingClient;
 * this module owns the RTCPeerConnection itself.
 * ============================================================ */

import { volatileBuffer } from "../memory/volatileBuffer.js";

/** Public Google STUN servers (no TURN — direct P2P only). */
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
];

/** Valid packet types accepted on the data channel. */
const PACKET_TYPES = new Set([
  "chat",
  "presence",
  "media-state",
  "ping",
  "pong",
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
      for (const track of localStream.getTracks())
        this.pc.addTrack(track, localStream);
    }

    // Remote media in -> UI.
    this.pc.ontrack = (event) => this._handleRemoteTrack(event);

    // Connection diagnostics.
    this.pc.onconnectionstatechange = () => {
      this.onConnectionState?.(this.pc?.connectionState);
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
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    if (this.signaling && this.remotePeerId) {
      this.signaling.sendOffer(this.remotePeerId, this.pc.localDescription);
    }
    return offer;
  }

  /** Receiver: consume a remote offer, answer, publish the answer. */
  async handleOffer(fromPeerId, sdp) {
    this.remotePeerId = this.remotePeerId || fromPeerId;
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    this._remoteDescSet = true;
    await this._drainPendingCandidates();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    if (this.signaling)
      this.signaling.sendAnswer(this.remotePeerId, this.pc.localDescription);
    return answer;
  }

  /** Initiator: consume the remote answer. */
  async handleAnswer(sdp) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    this._remoteDescSet = true;
    await this._drainPendingCandidates();
  }

  /** Trickle ICE in — buffered until the remote description exists. */
  async handleIceCandidate(candidate) {
    if (!candidate) return;
    if (!this._remoteDescSet) {
      this._pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn("[webrtc] ICE candidate rejected:", err?.name);
    }
  }

  async _drainPendingCandidates() {
    const queued = this._pendingCandidates.splice(0);
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        /* stale candidate after renegotiation */
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
    const sender = opts.sender || this.signaling?.peerId || "local";
    const channel = this.dataChannel;
    const packet = {
      type: "chat",
      sender,
      text,
      at: Date.now(),
      ...(opts.encryption ? { encryption: opts.encryption } : {}),
    };

    if (!channel || channel.readyState === "connecting") {
      if (this._pendingMessages.length >= 100) {
        console.warn("[webrtc] pending chat queue is full; message not queued");
        return false;
      }
      if (!this.pc || this.pc.signalingState === "closed") {
        console.warn(
          `[webrtc] message not queued (data channel state: ${channel?.readyState ?? "unavailable"})`,
        );
        return false;
      }
      this._pendingMessages.push(packet);
      this._recordLocalMessage(packet);
      return true;
    }

    if (!channel || channel.readyState !== "open") {
      console.warn(
        `[webrtc] data channel not open (readyState: ${channel?.readyState ?? "unavailable"}); message not sent`,
      );
      return false;
    }

    const sent = await this.sendPacket(packet);
    if (!sent) return false;
    this._recordLocalMessage(packet);
    return true;
  }

  /** @private Record a locally composed message in the RAM store and UI. */
  _recordLocalMessage(packet) {
    const entry = volatileBuffer.pushMessage({
      sender: packet.sender,
      text: packet.text,
      kind:
        packet.encryption === "plaintext-fallback"
          ? "self-plaintext"
          : "self",
    });
    this.onChatMessage?.(entry);
  }

  /** @private Drain messages queued while the channel was connecting. */
  async _flushPendingMessages(channel) {
    if (this._flushingMessages) return;
    this._flushingMessages = true;
    try {
      while (this._pendingMessages.length && channel === this.dataChannel) {
        if (channel.readyState !== "open") return;
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
    }

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
      // Receiver path: ensure a PC exists even if createPeerConnection
      // was not called before the offer arrived.
      if (!this.pc) this.createPeerConnection(null, { remotePeerId: from });
      this.handleOffer(from, sdp).catch((err) =>
        console.warn("[webrtc] offer handling failed:", err?.name),
      );
    };
    this.signaling.onAnswer = (_from, sdp) => {
      this.handleAnswer(sdp).catch((err) =>
        console.warn("[webrtc] answer handling failed:", err?.name),
      );
    };
    this.signaling.onIceCandidate = (from, candidate) => {
      if (!this.pc) this.createPeerConnection(null, { remotePeerId: from });
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
