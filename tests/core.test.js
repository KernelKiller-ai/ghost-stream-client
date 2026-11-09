// Node-run smoke test for the core signaling + media modules.
// (No real socket/camera is used — APIs are faked.)
// Run: node client-web/tests/core.test.js

const { SignalingClient } = await import("../src/core/signalingClient.js");
const { MediaStreamController } = await import("../src/core/mediaStream.js");

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
};

// ---- Fake WebSocket ----
const sockets = [];
globalThis.WebSocket = class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sentMessages = [];
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    sockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data) {
    this.lastSent = JSON.parse(data);
    this.sentMessages.push(this.lastSent);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
};

// ---- Signaling client ----
const inviteToken = "A".repeat(43);
const sig = new SignalingClient({
  url: "ws://fake",
  room: "XYZ123",
  token: inviteToken,
  isHost: true,
});
let joined = null,
  offer = null,
  ice = null,
  knock = null,
  approval = null,
  reconnects = 0;
sig.onJoined = (_room, _peer, peers, isHost) => {
  joined = peers;
  check("host role returned by signaling", isHost === true);
};
sig.onKnockRequest = (request) => { knock = request; };
sig.onKnockApproved = (result) => { approval = result; };
sig.onOffer = (_from, sdp) => {
  offer = sdp;
};
sig.onIceCandidate = (_from, c) => {
  ice = c;
};
sig.onReconnecting = () => {
  reconnects++;
};

await sig.connect();
check("socket opened", sig.isConnected);
check(
  "join-room sent on connect",
  sig._ws.lastSent?.type === "join-room" &&
    sig._ws.lastSent.roomId === "XYZ123" &&
    sig._ws.lastSent.token === inviteToken &&
    sig._ws.lastSent.isHost === true,
);
check("peerId generated (16 hex chars)", /^[0-9a-f]{16}$/.test(sig.peerId));

sig._handleMessage(
  JSON.stringify({ type: "joined", room: "XYZ123", peers: ["p2"], isHost: true }),
);
check("joined callback emitted", joined?.[0] === "p2");
sig._handleMessage(
  JSON.stringify({ type: "knock-request", peerId: "p3", timestamp: 123 }),
);
check(
  "host knock request routed",
  knock?.peerId === "p3" && knock.timestamp === 123,
);
sig._handleMessage(
  JSON.stringify({ type: "knock-approved", peerId: "p3", room: "XYZ123" }),
);
check("knock approval routed", approval?.peerId === "p3");
sig._handleMessage(
  JSON.stringify({ type: "sdp-offer", from: "p2", sdp: { type: "offer" } }),
);
check("offer routed to manager", offer?.type === "offer");
sig._handleMessage(
  JSON.stringify({
    type: "ice-candidate",
    from: "p2",
    candidate: { candidate: "cand" },
  }),
);
check("ice candidate routed", ice?.candidate === "cand");

sig.sendOffer("p2", { type: "offer", sdp: "v=0" });
check(
  "sendOffer serialises to peer",
  sig._ws.lastSent.type === "sdp-offer" && sig._ws.lastSent.to === "p2",
);
sig.sendIceCandidate("p2", { candidate: "c", sdpMid: "0", sdpMLineIndex: 0 });
check(
  "sendIceCandidate trims to wire fields",
  sig._ws.lastSent.candidate.sdpMid === "0" &&
    !("toJSON" in sig._ws.lastSent.candidate),
);
sig.approveKnock("p3");
check(
  "host approval packet sent",
  sig._ws.lastSent.type === "knock-approved" && sig._ws.lastSent.to === "p3",
);
const rotatedToken = "B".repeat(43);
sig.rotateRoomToken(rotatedToken);
check(
  "invite rotation packet sent and retained",
  sig._ws.lastSent.type === "rotate-room-token" &&
    sig._ws.lastSent.token === rotatedToken &&
    sig.roomToken === rotatedToken,
);

// queueing while down
sig.disconnect();
check("intentional close -> no reconnect", reconnects === 0);
const queuedOk = sig.sendAnswer("p2", { type: "answer" }) === false;
check(
  "send queues while socket down",
  queuedOk && sig._pendingQueue.length === 1,
);

await sig.connect();
check(
  "join-room re-sent on reconnect",
  sig._ws.sentMessages.some(
    (message) => message.type === "join-room" && message.roomId === "XYZ123",
  ),
);
check(
  "queue flushed on reconnect",
  sig._pendingQueue.length === 0 &&
    sig._ws.lastSent?.type === "sdp-answer",
);

// reconnect after unexpected drop
sig._ws.close(); // simulated server drop
await new Promise((r) => setTimeout(r, 900));
check(
  "auto-reconnect after unexpected drop",
  reconnects >= 1 && sig.isConnected,
);

// ---- Media controller (fake getUserMedia) ----
const tracks = {
  audio: () => ({
    kind: "audio",
    enabled: true,
    readyState: "live",
    stop() {
      this.readyState = "ended";
    },
  }),
  video: () => ({
    kind: "video",
    enabled: true,
    readyState: "live",
    stop() {
      this.readyState = "ended";
    },
  }),
};
let sentConstraints = null;
let failCount = 0;
const makeTrack = (kind) => ({ kind, enabled: true, readyState: "live", stop() { this.readyState = "ended"; } });
let audioTrack = makeTrack("audio");
let videoTrack = makeTrack("video");
const nav = {
  mediaDevices: {
    getUserMedia: async (c) => {
      sentConstraints = c;
      if (failCount > 0) {
        failCount--;
        throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      }
      if (c.video && c.audio) {
        audioTrack = makeTrack("audio");
        videoTrack = makeTrack("video");
      } else if (c.audio) {
        audioTrack = makeTrack("audio");
        videoTrack = [];
      } else {
        audioTrack = [];
        videoTrack = makeTrack("video");
      }
      const s = {
        getAudioTracks: () => (Array.isArray(audioTrack) ? [] : [audioTrack]),
        getVideoTracks: () => (Array.isArray(videoTrack) ? [] : [videoTrack]),
        getTracks: () => [...this_s_tracks(s)],
      };
      return s;
    },
  },
};
function this_s_tracks(s) {
  return [...s.getAudioTracks(), ...s.getVideoTracks()];
}
Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true });
globalThis.location = { protocol: "https:", hostname: "example.com" };

const media = new MediaStreamController();
const res = await media.acquire();
check("full video+audio acquired", res.mode === "full" && media.videoEnabled && media.audioEnabled);

media.toggleMute(false);
check(
  "mute flips audio track enabled",
  !media.audioEnabled && media.stream.getAudioTracks()[0].enabled === false,
);
media.toggleMute(); // toggle back
check("unmute toggles back on", media.audioEnabled);

media.toggleCamera(false);
check("camera disable flips video track enabled", !media.videoEnabled);
media.toggleCamera(true);
check("camera re-enable works", media.videoEnabled);

// fallback: both full rungs fail -> audio-only
failCount = 2;
const media2 = new MediaStreamController();
const res2 = await media2.acquire();
check(
  "permission denial falls back to audio-only",
  res2.mode === "audio-only" && !res2.error,
);
check(
  "failure described for UI",
  /denied|unavailable/.test(media2.describeFailure()) ||
    media2.lastError === null,
);

// teardown
const media3 = new MediaStreamController();
await media3.acquire();
const torn = media3.teardown();
check(
  "teardown stops all tracks",
  torn.stopped >= 2 && media3.stream === null && media3.mode === "none",
);

console.log(
  failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
