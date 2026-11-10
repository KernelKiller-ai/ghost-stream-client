// Node-run integration test: two WebRTCManager peers exchange
// offer/answer/ICE over a fake signaling relay and chat over a fake
// data channel, with everything routed through volatileBuffer.
// Run: node client-web/tests/webrtc.test.js

// Fake WebSocket BEFORE imports — Node 24 ships a real one.
const sockets = [];
globalThis.WebSocket = class FakeWebSocket {
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    sockets.push(this);
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(data) { this.lastSent = JSON.parse(data); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
};

const { SignalingClient } = await import("../src/core/signalingClient.js");
const { WebRTCManager } = await import("../src/core/webrtcManager.js");
const { volatileBuffer } = await import("../src/memory/volatileBuffer.js");
const { EphemeralCrypto, sessionCrypto, sealPacket } =
  await import("../src/security/cryptoUtils.js");

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
};

/* ---------------- fakes ---------------- */
class FakeTrack {
  constructor(kind) {
    this.kind = kind;
    this.readyState = "live";
    this.enabled = true;
  }
  stop() {
    this.readyState = "ended";
  }
}
class FakeStream {
  constructor(tracks = []) {
    this._tracks = tracks;
  }
  getTracks() {
    return this._tracks;
  }
  addTrack(track) {
    if (!this._tracks.includes(track)) this._tracks.push(track);
  }
}
class FakeVideo {
  constructor() {
    this.srcObject = null;
  }
  play() {
    return Promise.resolve();
  }
}

let pcInstances = [];
class FakeRTCPeerConnection {
  constructor(config) {
    this.iceServers = config.iceServers;
    this.localDescription = null;
    this.remoteDescription = null;
    this.signalingState = "stable";
    this.connectionState = "new";
    this.onicecandidate =
      this.ontrack =
      this.ondatachannel =
      this.onconnectionstatechange =
        null;
    this._localTracks = [];
    this._createdChannel = null;
    this._remoteChannel = new FakeDataChannel("ephemeral-chat", { ordered: true });
    pcInstances.push(this);
  }
  addTrack(track, stream) {
    this._localTracks.push(track);
    const sender = {
      track,
      replaceTrack: async (nextTrack) => {
        sender.track = nextTrack;
      },
    };
    (this._senders ||= []).push(sender);
    return sender;
  }
  getSenders() {
    return this._senders || [];
  }
  addTransceiver(kind) {
    const sender = {
      track: null,
      replaceTrack: async (nextTrack) => {
        sender.track = nextTrack;
      },
    };
    (this._senders ||= []).push(sender);
    return { sender, receiver: { track: new FakeTrack(kind) } };
  }
  createDataChannel(label, opts) {
    this._createdChannel = new FakeDataChannel(label, opts);
    return this._createdChannel;
  }
  async createOffer() {
    return { type: "offer", sdp: "offer-sdp" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "answer-sdp" };
  }
  async setLocalDescription(desc) {
    this.localDescription = desc;
    this.signalingState =
      desc.type === "offer" ? "have-local-offer" : "stable";
  }
  async setRemoteDescription(desc) {
    if (desc.type === "answer") {
      this.answerApplications = (this.answerApplications || 0) + 1;
      await Promise.resolve();
    }
    this.remoteDescription = desc;
    this.signalingState =
      desc.type === "offer" ? "have-remote-offer" : "stable";
    // Simulate ondatachannel for remote offers (receiver path).
    if (desc.type === "offer" && this._remoteChannel) {
      const ch = this._remoteChannel;
      queueMicrotask(() => this.ondatachannel?.({ channel: ch }));
    }
    // Simulate track arrival for remote SDPs containing media.
    if (desc.type === "offer" && this._remoteTracks) {
      const ev = {
        streams: [this._remoteTracks],
        track: this._remoteTracks.getTracks()[0],
      };
      queueMicrotask(() => this.ontrack?.(ev));
    }
  }
  async addIceCandidate() {
    this._iceAdded = (this._iceAdded || 0) + 1;
  }
  close() {
    this.signalingState = "closed";
    this.connectionState = "closed";
  }
}
class FakeDataChannel {
  constructor(label, opts) {
    this.label = label;
    this.ordered = opts.ordered;
    this.readyState = "connecting";
    this.sent = [];
    this.onopen = this.onclose = this.onmessage = this.onerror = null;
  }
  open() {
    this.readyState = "open";
    queueMicrotask(() => this.onopen?.());
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
}
const packetBody = (frame) => frame?.p || frame;
class FakeRTCSolution {}
globalThis.RTCPeerConnection = FakeRTCPeerConnection;
globalThis.RTCSessionDescription = class {
  constructor(d) {
    Object.assign(this, d);
  }
};
globalThis.RTCIceCandidate = class {
  constructor(d) {
    Object.assign(this, d);
  }
};
globalThis.MediaStream = FakeStream;

/* ---------------- relay ---------------- */
// Wire two signaling clients to each other like a relay would.
function wireRelay(a, b) {
  const deliver = (from, to, type, payload) =>
    to._handleMessage(JSON.stringify({ type, from, ...payload }));
  a.onOffer = (from, sdp) => {
    deliver(a, b, "sdp-offer", { sdp });
  };
  a.onAnswer = (from, sdp) => {
    deliver(a, b, "sdp-answer", { sdp });
  };
  a.onIceCandidate = (from, cand) => {
    deliver(a, b, "ice-candidate", { candidate: cand });
  };
  // mirror for b
  b.onOffer = (from, sdp) => {
    deliver(b, a, "sdp-offer", { sdp });
  };
  b.onAnswer = (from, sdp) => {
    deliver(b, a, "sdp-answer", { sdp });
  };
  b.onIceCandidate = (from, cand) => {
    deliver(b, a, "ice-candidate", { candidate: cand });
  };
}

/* ---------------- build peers ---------------- */
const sigA = new SignalingClient({ url: "ws://fake", peerId: "AAAA" });
const sigB = new SignalingClient({ url: "ws://fake", peerId: "BBBB" });
await sigA.connect();
await sigB.connect();
wireRelay(sigA, sigB);

const videoA = new FakeVideo();
const videoB = new FakeVideo();
const chatA = [],
  chatB = [];
const roundTripsA = [];

const managerA = new WebRTCManager({
  signaling: sigA,
  remoteVideoEl: videoA,
  onChatMessage: (e) => chatA.push(e),
  onRoundTripTime: (rtt) => roundTripsA.push(rtt),
});
const managerB = new WebRTCManager({
  signaling: sigB,
  remoteVideoEl: videoB,
  onChatMessage: (e) => chatB.push(e),
});

const localA = new FakeStream([new FakeTrack("audio"), new FakeTrack("video")]);
const localB = new FakeStream([new FakeTrack("audio"), new FakeTrack("video")]);

/* ---------------- handshake ---------------- */
// A = initiator
managerA.createPeerConnection(localA, {
  initiator: true,
  remotePeerId: "BBBB",
});
check(
  "A uses STUN and TURN ICE servers",
  managerA.pc.iceServers.length === 6 &&
    managerA.pc.iceServers.some((s) => s.urls.startsWith("stun:")) &&
    managerA.pc.iceServers.some((s) => s.urls.startsWith("turn:")),
);
check(
  "A created ordered data channel",
  managerA.dataChannel.label === "ephemeral-chat" &&
    managerA.dataChannel.ordered === true,
);
managerA.pc.onicecandidate({
  candidate: { candidate: "outgoing-cand", sdpMid: "0", sdpMLineIndex: 0 },
});
check(
  "A relays outgoing ICE over signaling",
  sigA._ws.lastSent?.type === "ice-candidate" &&
    sigA._ws.lastSent.to === "BBBB" &&
    sigA._ws.lastSent.candidate.candidate === "outgoing-cand",
);

// B = receiver, learns PC only via offer
sigA.onOffer = (from, sdp) => {
  sigB._handleMessage(JSON.stringify({ type: "sdp-offer", from, sdp }));
};
sigB.onAnswer = (from, sdp) => {
  sigA._handleMessage(JSON.stringify({ type: "sdp-answer", from, sdp }));
};
sigB._handleMessage(
  JSON.stringify({
    type: "ice-candidate",
    from: "AAAA",
    candidate: { candidate: "early-cand", sdpMid: "0", sdpMLineIndex: 0 },
  }),
);
check(
  "B queues ICE arriving before offer",
  managerB.pc !== null && managerB._pendingCandidates.length === 1,
);
const icePipe = (fromC, toM) => (fromC, cand) => toM.handleIceCandidate(cand);
sigA.onIceCandidate = (from, c) => managerB.handleIceCandidate(c);
sigB.onIceCandidate = (from, c) => managerA.handleIceCandidate(c);

// B's PC must exist when the offer arrives — manager auto-creates it.
sigB._handleMessage(
  JSON.stringify({
    type: "sdp-offer",
    from: "AAAA",
    sdp: { type: "offer", sdp: "offer-sdp" },
  }),
);
check("B auto-created PC on incoming offer", managerB.pc !== null);
await new Promise((r) => setTimeout(r, 30)); // allow async offer handling + ondatachannel to settle
check(
  "B picked up data channel from offer",
  managerB.dataChannel?.label === "ephemeral-chat" && managerB.dataChannel?.ordered === true,
);
const reservedVideoSender = managerB.pc.getSenders().find((sender) => sender.track === null);
managerB.attachLocalStream(localB);
await new Promise((resolve) => setTimeout(resolve, 0));
check(
  "late local camera attaches to reserved sender",
  reservedVideoSender?.track === localB.getTracks().find((track) => track.kind === "video") &&
    managerB.pc.getSenders().filter((sender) => sender.track?.kind === "video").length === 1,
);
check(
  "B drains early ICE after remote description",
  managerB.pc._iceAdded === 1 && managerB._pendingCandidates.length === 0,
);

await managerA.createOffer();
check(
  "A published local offer",
  managerA.pc.localDescription?.type === "offer",
);
await managerA.handleIceCandidate({
  candidate: "queued-cand",
  sdpMid: "0",
  sdpMLineIndex: 0,
});
check("ICE queued before remote description", managerA._pendingCandidates.length === 1);
// simulate B answering back through the pipe
const firstAnswer = managerA.handleAnswer({ type: "answer", sdp: "answer-sdp" });
const duplicateAnswer = managerA.handleAnswer({
  type: "answer",
  sdp: "duplicate-answer",
});
await Promise.all([firstAnswer, duplicateAnswer]);
check(
  "A accepted remote answer",
  managerA.pc.remoteDescription?.type === "answer",
);
const acceptedAnswer = managerA.pc.remoteDescription;
await managerA.handleAnswer({ type: "answer", sdp: "duplicate-answer" });
check(
  "concurrent duplicate answer is skipped",
  managerA.pc.remoteDescription === acceptedAnswer &&
    managerA.pc.signalingState === "stable" &&
    managerA.pc.answerApplications === 1,
);
check(
  "queued ICE drained after remote description",
  managerA.pc._iceAdded === 1 && managerA._pendingCandidates.length === 0,
);

// remote media binding on B: simulate A's tracks arriving via ontrack
managerB.pc._remoteTracks = new FakeStream([
  new FakeTrack("video"),
  new FakeTrack("audio"),
]);
await managerB.pc.setRemoteDescription({ type: "offer", sdp: "renegotiation" });
await new Promise((r) => setTimeout(r, 10));
check(
  "B remote video bound to UI element",
  videoB.srcObject === managerB.remoteStream &&
    managerB.remoteStream.getTracks().length >= 1,
);

const originalVideoTrack = localA.getTracks().find((track) => track.kind === "video");
const videoSender = managerA.pc.getSenders().find((sender) => sender.track?.kind === "video");
await managerA.setLocalVideoTrack(null);
check(
  "camera sender can be detached without renegotiation",
  Boolean(videoSender) && videoSender.track === null,
);
const replacementVideoTrack = new FakeTrack("video");
await managerA.setLocalVideoTrack(replacementVideoTrack);
check(
  "camera sender accepts replacement track without renegotiation",
  videoSender.track === replacementVideoTrack &&
    originalVideoTrack.readyState === "live",
);

/* ---------------- data channel chat ---------------- */
const cryptoPeer = new EphemeralCrypto();
const managerKey = (await sessionCrypto.beginHandshake()).publicKey;
const cryptoPeerKey = (await cryptoPeer.beginHandshake()).publicKey;
await sessionCrypto.completeHandshake(cryptoPeerKey);
await cryptoPeer.completeHandshake(managerKey);

// Queue while connecting, then flush when the data channel opens.
const queuedOk = await managerA.sendMessage("queued text", { sender: "AAAA" });
check(
  "message queued while channel is connecting",
  queuedOk === true && managerA._pendingMessages.length === 1,
);
managerA.dataChannel.open();
await new Promise((r) => setTimeout(r, 10));
check(
  "presence packet on channel open",
  packetBody(managerA.dataChannel.sent[0])?.type === "presence" &&
    managerA.dataChannel.sent[0]?.e === 0,
);
check(
  "queued message flushed on channel open",
  managerA.dataChannel.sent.some(
    (p) => p.e === 1,
  ) && managerA._pendingMessages.length === 0,
);

// A sends a chat message -> must land in A's UI, B's buffer would on receive.
const sentOk = await managerA.sendMessage("ghost text", { sender: "AAAA" });
check(
  "sendMessage over ephemeral channel",
  sentOk === true &&
    managerA.dataChannel.sent.some(
      (p) => p.e === 1,
    ),
);
check(
  "local chat routed into volatileBuffer",
  volatileBuffer
    .getMessages()
    .some((m) => m.text === "ghost text" && m.kind === "self"),
);

// B receives the same packet through its channel
const wirePacket = managerA.dataChannel.sent.filter((p) => p.e === 1).at(-1);
managerB.dataChannel.readyState = "open";
await managerB._handlePacket(JSON.stringify(wirePacket));
check(
  "remote packet routed into volatileBuffer",
  volatileBuffer
    .getMessages()
    .some((m) => m.text === "ghost text" && m.kind === "peer"),
);
check(
  "B fired UI chat hook",
  chatB.some((e) => e.text === "ghost text"),
);

const fallbackSent = await managerA.sendMessage("fallback text", {
  sender: "AAAA",
  encryption: "plaintext-fallback",
});
const fallbackPacket = managerA.dataChannel.sent.find(
  (packet) =>
    packetBody(packet)?.type === "chat" &&
    packetBody(packet)?.text === "fallback text",
);
managerB.dataChannel.onmessage({ data: JSON.stringify(fallbackPacket) });
await new Promise((r) => setTimeout(r, 0));
check(
  "plaintext fallback is marked in local RAM and UI",
  fallbackSent &&
    volatileBuffer
      .getMessages()
      .some((message) => message.text === "fallback text" &&
        message.kind === "self-plaintext") &&
    chatA.some((message) => message.text === "fallback text" &&
      message.kind === "self-plaintext"),
);
check(
  "peer routes plaintext fallback with unencrypted marker",
  volatileBuffer
    .getMessages()
    .some((message) => message.text === "fallback text" &&
      message.kind === "peer-plaintext") &&
    chatB.some((message) => message.text === "fallback text" &&
      message.kind === "peer-plaintext"),
);

// Heartbeats use a data-channel echo; this is RTT, not physical range.
const ping = managerA.dataChannel.sent.find(
  (packet) => packetBody(packet)?.type === "ping",
);
check("heartbeat ping is sent in plaintext envelope", ping?.e === 0);
await managerB._handlePacket(JSON.stringify(ping));
const pong = managerB.dataChannel.sent.find(
  (packet) =>
    packetBody(packet)?.type === "pong" &&
    packetBody(packet)?.pingId === packetBody(ping)?.pingId,
);
check("heartbeat pong is sent in plaintext envelope", pong?.e === 0);
await managerA._handlePacket(JSON.stringify(pong));
check(
  "data-channel ping/pong reports RTT",
  Boolean(ping && pong && roundTripsA.length === 1 && roundTripsA[0] >= 0),
);

// unknown packet types are ignored
await managerB._handlePacket("not json");
await managerB._handlePacket(JSON.stringify({ type: "exploit", text: "<img>" }));
check(
  "malformed/unknown packets ignored",
  !volatileBuffer.getMessages().some((m) => m.text === "<img>"),
);

const senderCrypto = new EphemeralCrypto();
const receiverPublicKey = (await sessionCrypto.beginHandshake()).publicKey;
const senderPublicKey = (await senderCrypto.beginHandshake()).publicKey;
await sessionCrypto.completeHandshake(senderPublicKey);
await senderCrypto.completeHandshake(receiverPublicKey);
const encryptedWire = await sealPacket({
  type: "chat",
  sender: "AAAA",
  text: "decrypted by WebRTCManager",
});
await managerB._handlePacket(encryptedWire);
check(
  "WebRTCManager decrypts before routing incoming packets",
  chatB.some((entry) => entry.text === "decrypted by WebRTCManager") &&
    volatileBuffer
      .getMessages()
      .some((entry) => entry.text === "decrypted by WebRTCManager"),
);
sessionCrypto.zeroize();
senderCrypto.zeroize();
cryptoPeer.zeroize();

// channel closed -> sendPacket returns false
managerA.dataChannel.close();
check(
  "sendPacket fails when channel closed",
  managerA.sendPacket({ type: "chat", text: "x" }) === false,
);

/* ---------------- teardown ---------------- */
volatileBuffer.wipeStore();
managerA.closePeerConnection();
managerB.closePeerConnection();
check(
  "closePeerConnection drops references",
  managerA.pc === null &&
    managerA.dataChannel === null &&
    videoA.srcObject === null,
);

console.log(
  failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
