/* ============================================================
 * GHOST-STREAM // app.js
 * Master orchestrator.
 *
 * Wires: signalingClient <-> webrtcManager <-> mediaStream
 *        volatileBuffer / ephemeral chat UI / autoPurge
 *
 * User actions handled here:
 *   Create Room | Join Room | Send Message | Toggle Media
 *   (+ Audio / Video / Chat dock buttons, Panic, Instant Purge)
 * ============================================================ */

import { SignalingClient } from "./core/signalingClient.js";
import { MediaStreamController } from "./core/mediaStream.js";
import { WebRTCManager } from "./core/webrtcManager.js";
import { volatileBuffer } from "./memory/volatileBuffer.js";
import * as autoPurge from "./memory/autoPurge.js";
import { stopSession } from "./memory/autoPurge.js";
import { sessionCrypto, sealPacket, openPacket } from "./security/cryptoUtils.js";
import * as panicShield from "./security/panicTrigger.js";
import {
  EphemeralChatView,
  renderRoomCode,
  renderCountdown,
  renderMediaToggle,
  renderChatDrawer,
  renderRemoteState,
  estimateDistanceMeters,
  renderRadarPeers,
  SESSION_TTL_MS,
} from "./ui/renderView.js";
import { renderQrCode } from "./ui/qrEncoder.js";

/* ---------------- DOM handles ---------------- */
const $ = (id) => document.getElementById(id);
const els = {
  roomCode: $("roomCodeDisplay"),
  copyRoom: $("copyRoom"),
  btnCreateRoom: $("btnCreateRoom"),
  btnJoinRoom: $("btnJoinRoom"),
  closeChat: $("closeChat"),
  timerDisplay: $("timerDisplay"),
  btnNuke: $("btnNuke"),
  videoRemote: $("videoRemote"),
  videoLocal: $("videoLocal"),
  remoteFallback: $("remoteFallback"),
  remoteTagLabel: $("remoteTagLabel"),
  chatDrawer: $("chatDrawer"),
  chatLog: $("chatLog"),
  chatForm: $("chatForm"),
  chatInput: $("chatInput"),
  chatSendBtn: $("chatSendBtn"),
  radarStatus: $("radarStatus"),
  radarPeers: $("radarPeers"),
  btnAudio: $("btnAudio"),
  btnVideo: $("btnVideo"),
  btnChat: $("btnChat"),
  btnPanic: $("btnPanic"),
  btnQr: $("btnQr"),
  audioState: $("audioState"),
  videoState: $("videoState"),
  chatState: $("chatState"),
  purgeOverlay: $("purgeOverlay"),
  btnRecover: $("btnRecover"),
  inviteModal: $("inviteModal"),
  inviteQr: $("inviteQr"),
  inviteCountdown: $("inviteCountdown"),
  inviteStatus: $("inviteStatus"),
  closeInvite: $("closeInvite"),
  knockModal: $("knockModal"),
  knockPeer: $("knockPeer"),
  knockCountdown: $("knockCountdown"),
  approveKnock: $("approveKnock"),
  rejectKnock: $("rejectKnock"),
  pendingApproval: $("pendingApproval"),
  cancelPendingJoin: $("cancelPendingJoin"),
};

function updateRadar() {
  renderRadarPeers(els.radarPeers, [...radarPeers.values()]);
  if (els.radarStatus) {
    els.radarStatus.textContent = radarPeers.size
      ? `${radarPeers.size} PEER${radarPeers.size === 1 ? "" : "S"}`
      : "AWAITING LINK";
  }
}

function expireNativeRadarPeers() {
  const now = Date.now();
  let changed = false;
  for (const [peerId, peer] of radarPeers) {
    if (peer.carrier !== "WebRTC P2P" && now - peer.lastSeenAt > 15000) {
      radarPeers.delete(peerId);
      changed = true;
    }
  }
  if (changed) updateRadar();
}

function updateWebRtcRadarPeer(rttMs = null) {
  if (!rtc.remotePeerId) return;
  const peerId = rtc.remotePeerId;
  const existing = radarPeers.get(peerId) || {};
  const suffix = peerId.replace(/[^a-z0-9]/gi, "").slice(-4).toUpperCase();
  radarPeers.set(peerId, {
    ...existing,
    nodeId: `NODE-${suffix.padStart(4, "0")}`,
    carrier: "WebRTC P2P",
    rttMs: Number.isFinite(rttMs) ? rttMs : existing.rttMs ?? null,
    distanceMeters: null,
    rssiDbm: null,
  });
  updateRadar();
}

function removeWebRtcRadarPeer() {
  for (const [peerId, peer] of radarPeers) {
    if (peer.carrier === "WebRTC P2P") radarPeers.delete(peerId);
  }
  updateRadar();
}

function clearRadarPeers() {
  radarPeers.clear();
  updateRadar();
  window.GhostProximity?.stopBleScan?.();
}

/** Entry point for an Android host to forward ephemeral native RSSI readings. */
function reportProximitySignal(signal) {
  if (!signal || typeof signal !== "object") return false;
  const carrier = signal.carrier;
  if (!["BLE", "Wi-Fi Direct", "WebRTC P2P"].includes(carrier)) return false;
  const sourceId = signal.peerId ?? signal.token;
  if (sourceId === undefined || sourceId === null) return false;

  const peerId = String(sourceId);
  const suffix = peerId.replace(/[^a-z0-9]/gi, "").slice(-4).toUpperCase();
  const rssiDbm = Number(signal.rssiDbm ?? signal.rssi);
  const txPowerAtOneMeter = Number(
    signal.txPowerAtOneMeterDbm ?? signal.txPowerAt1m,
  );
  const pathLossExponent = Number(signal.pathLossExponent ?? 2);
  const distanceMeters = estimateDistanceMeters(
    rssiDbm,
    txPowerAtOneMeter,
    pathLossExponent,
  );

  radarPeers.set(peerId, {
    nodeId: `NODE-${suffix.padStart(4, "0")}`,
    carrier,
    rttMs: Number.isFinite(signal.rttMs) ? signal.rttMs : null,
    distanceMeters,
    rssiDbm: Number.isFinite(rssiDbm) ? rssiDbm : null,
    lastSeenAt: Date.now(),
  });
  updateRadar();
  return true;
}

function startNativeProximityScan() {
  window.GhostProximity?.startBleScan?.();
}

function reportProximityError(message) {
  chat.system(`proximity: ${message}`);
}

function setChatControlsEnabled(enabled) {
  if (els.chatInput) {
    els.chatInput.disabled = !enabled;
    els.chatInput.placeholder = enabled
      ? "> transmit encrypted packet..."
      : "> waiting for secure peer link...";
  }
  if (els.chatSendBtn) els.chatSendBtn.disabled = !enabled;
}

/* ---------------- module instances ---------------- */
const signaling = new SignalingClient();
const media = new MediaStreamController();
const chat = new EphemeralChatView(els.chatLog);
const radarPeers = new Map();
let radarExpiryTimer = null;
let roomToken = null;
let roomIsHost = false;
let hostJoined = false;
let pendingKnockPeer = null;
let pendingKnockExpiresAt = 0;
let knockCountdownTimer = null;
let inviteRefreshTimer = null;
let inviteCountdownTimer = null;
let inviteExpiresAt = 0;

const rtc = new WebRTCManager({
  signaling,
  remoteVideoEl: els.videoRemote,
  onChatMessage: (entry) =>
    chat.append(entry.sender, entry.text, { kind: entry.kind }),
  onDataChannelOpen: async () => {
    chat.system("ephemeral channel open — serverless relay active");
    setStatus("LINKED", "live");
    setChatControlsEnabled(true);
    // The offerer starts key agreement; the answerer replies to its frame.
    if (rtc.isInitiator) await startCryptoHandshake();
    updateWebRtcRadarPeer();
  },
  onDataChannelClose: () => {
    chat.system("ephemeral channel closed");
    setStatus("AWAITING LINK", "idle");
    setChatControlsEnabled(false);
    removeWebRtcRadarPeer();
  },
  onRoundTripTime: (rttMs) => updateWebRtcRadarPeer(rttMs),
  onConnectionState: (state) => {
    if (state === "connected") {
      setStatus(
        rtc.dataChannel?.readyState === "open" ? "LINKED" : "STREAM ACTIVE",
        "live",
      );
      els.remoteFallback.classList.add("hidden");
      document.querySelector(".video-primary")?.classList.add("has-remote");
    } else if (state === "failed" || state === "disconnected") {
      setStatus("LINK UNSTABLE", "warning");
      setChatControlsEnabled(false);
    }
  },
});

// --- E2E crypto: route all data-channel packets through AES-GCM sealing ---
rtc.sendPacket = async function (packet) {
  const channel = this.dataChannel;
  if (!channel || channel.readyState !== "open") {
    console.warn(
      `[webrtc] data channel not open (readyState: ${channel?.readyState ?? "unavailable"}); packet not sent`,
    );
    return false;
  }
  try {
    const isHandshake =
      packet.type === "crypto-handshake" ||
      packet.type === "crypto-handshake-reply";
    let wire;
    if (isHandshake) {
      wire = JSON.stringify({ p: packet, e: 0 });
    } else {
      if (
        packet.type === "chat" &&
        !sessionCrypto.isReady &&
        packet.encryption !== "plaintext-fallback"
      ) {
        await sessionCrypto.whenReady(2000);
      }

      if (packet.type === "chat" && !sessionCrypto.isReady) {
        packet.encryption = "plaintext-fallback";
        wire = JSON.stringify({ p: packet, e: 0 });
        console.warn(
          "[webrtc] sending chat without end-to-end encryption; marked UNENCRYPTED",
        );
        chat.system(
          "UNENCRYPTED FALLBACK — peer link is open; this message is not end-to-end encrypted",
        );
      } else {
        if (packet.type === "chat") packet.encryption = "encrypted";
        wire = await sealPacket(packet);
      }
    }
    if (channel.readyState !== "open") {
      console.warn(
        `[webrtc] data channel closed during encryption (readyState: ${channel.readyState}); packet not sent`,
      );
      return false;
    }
    channel.send(wire);
    return true;
  } catch (error) {
    console.error(
      `[webrtc] encrypted data channel send failed (readyState: ${channel.readyState}):`,
      error,
    );
    return false;
  }
};
rtc._handlePacket = async function (wire) {
  try {
    const { packet, encrypted } = await openPacket(wire);
    if (packet?.type === "chat" && !encrypted &&
        packet.encryption !== "plaintext-fallback") {
      console.warn("[webrtc] rejected chat packet without an active cipher");
      return;
    }
    if (packet?.type === "chat") {
      packet.encryption = encrypted ? "encrypted" : "plaintext-fallback";
    }
    // Handshake frames are intercepted before the normal renderer
    // (they must not surface as chat lines).
    if (packet.type === "crypto-handshake") {
      return handleCryptoHandshake(packet);
    }
    if (packet.type === "crypto-handshake-reply") {
      return handleCryptoHandshakeReply(packet);
    }
    // Route through the original renderer (chat / presence / media-state).
    WebRTCManager.prototype._handlePacket.call(this, JSON.stringify(packet));
  } catch (error) {
    console.error("[webrtc] incoming encrypted packet rejected:", error);
  }
};

/* ---------------- session state ---------------- */
let roomCode = null;
let chatOpen = false;
let cryptoHandshakePromise = null;

function notifyCryptoReady() {
  if (!sessionCrypto.isReady) return;
  rtc.flushPendingMessages().catch((error) => {
    console.error("[app] queued chat flush failed:", error);
  });
}

const setStatus = (text, state) => {
  if (els.remoteTagLabel) els.remoteTagLabel.textContent = `REMOTE // ${text}`;
  const dot = document.querySelector(".video-tag--remote .status-dot");
  if (dot) dot.dataset.state = state || "idle";
};

function showInviteModal() {
  if (!roomCode || !roomIsHost || !hostJoined) {
    chat.system("create a room and wait for signaling before opening a QR invite");
    return;
  }
  els.inviteModal?.classList.remove("hidden");
  els.inviteModal?.setAttribute("aria-hidden", "false");
  if (els.inviteStatus) els.inviteStatus.textContent = "GENERATING SECURE QR...";

  setTimeout(() => {
    try {
      refreshInviteToken();
    } catch (error) {
      chat.system(`QR invite unavailable: ${error.message}`);
      if (els.inviteStatus) els.inviteStatus.textContent = "INVITE ENCODING FAILED";
      return;
    }
    if (inviteCountdownTimer !== null) clearInterval(inviteCountdownTimer);
    inviteCountdownTimer = setInterval(updateInviteCountdown, 250);
  }, 0);
}

function refreshInviteToken() {
  if (!roomCode || !roomIsHost || !hostJoined) {
    throw new Error("host signaling is not ready");
  }
  const nextToken = generateInviteToken();
  if (!signaling.rotateRoomToken(nextToken)) {
    throw new Error("could not update the server invite token");
  }
  roomToken = nextToken;
  drawInviteQr();
  inviteExpiresAt = Date.now() + 60_000;
  els.inviteStatus.textContent = "SINGLE-USE LINK // AUTO-BURNS";
  scheduleInviteRefresh();
}

function rotateHostCapability() {
  const nextToken = generateInviteToken();
  if (!signaling.rotateRoomToken(nextToken)) {
    chat.system("could not rotate room invite after approval");
    return;
  }
  roomToken = nextToken;
  if (!els.inviteModal?.classList.contains("hidden")) {
    drawInviteQr();
    inviteExpiresAt = Date.now() + 60_000;
    scheduleInviteRefresh();
  }
}

function scheduleInviteRefresh() {
  if (inviteRefreshTimer !== null) clearTimeout(inviteRefreshTimer);
  inviteRefreshTimer = setTimeout(() => {
    try {
      refreshInviteToken();
    } catch (error) {
      chat.system(`QR refresh failed: ${error.message}`);
      els.inviteStatus.textContent = "INVITE REFRESH FAILED";
    }
  }, 60_000);
}

function drawInviteQr() {
  if (!roomToken || !roomCode) return;
  const payload =
    `${window.location.origin}/#join=${encodeURIComponent(roomCode)}` +
    `&token=${encodeURIComponent(roomToken)}`;
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      renderQrCode(els.inviteQr, payload);
    });
  } else {
    renderQrCode(els.inviteQr, payload);
  }
}

function updateInviteCountdown() {
  const seconds = Math.max(0, Math.ceil((inviteExpiresAt - Date.now()) / 1000));
  if (els.inviteCountdown) {
    els.inviteCountdown.textContent = `BURNS IN ${seconds}s`;
  }
}

function hideInviteModal() {
  if (inviteRefreshTimer !== null) clearTimeout(inviteRefreshTimer);
  if (inviteCountdownTimer !== null) clearInterval(inviteCountdownTimer);
  inviteRefreshTimer = null;
  inviteCountdownTimer = null;
  inviteExpiresAt = 0;
  els.inviteQr?.replaceChildren();
  els.inviteModal?.classList.add("hidden");
  els.inviteModal?.setAttribute("aria-hidden", "true");
}

function clearInviteState() {
  hideInviteModal();
  roomToken = null;
  roomIsHost = false;
  hostJoined = false;
  if (els.btnQr) els.btnQr.disabled = true;
}

function showKnockRequest({ peerId, timestamp }) {
  pendingKnockPeer = peerId;
  pendingKnockExpiresAt = timestamp + 30_000;
  els.knockPeer.textContent = short(peerId);
  els.knockModal?.classList.remove("hidden");
  els.knockModal?.setAttribute("aria-hidden", "false");
  updateKnockCountdown();
  if (knockCountdownTimer !== null) clearInterval(knockCountdownTimer);
  knockCountdownTimer = setInterval(updateKnockCountdown, 250);
}

function updateKnockCountdown() {
  const seconds = Math.max(0, Math.ceil((pendingKnockExpiresAt - Date.now()) / 1000));
  if (els.knockCountdown) els.knockCountdown.textContent = `${seconds}s`;
}

function clearKnockRequest() {
  if (knockCountdownTimer !== null) clearInterval(knockCountdownTimer);
  knockCountdownTimer = null;
  pendingKnockPeer = null;
  pendingKnockExpiresAt = 0;
  els.knockModal?.classList.add("hidden");
  els.knockModal?.setAttribute("aria-hidden", "true");
}

function showPendingApproval() {
  els.pendingApproval?.classList.remove("hidden");
  els.pendingApproval?.setAttribute("aria-hidden", "false");
  if (els.remoteTagLabel) {
    els.remoteTagLabel.textContent = "REMOTE // WAITING FOR HOST CLEARANCE...";
  }
  setStatus("WAITING FOR HOST CLEARANCE...", "warning");
}

function hidePendingApproval() {
  els.pendingApproval?.classList.add("hidden");
  els.pendingApproval?.setAttribute("aria-hidden", "true");
}

function authorizePendingKnock() {
  if (!pendingKnockPeer) return;
  const peerId = pendingKnockPeer;
  if (!signaling.approveKnock(peerId)) {
    chat.system("could not authorize link — signaling is unavailable");
    return;
  }
  clearKnockRequest();
}

function rejectPendingKnock() {
  if (!pendingKnockPeer) return;
  const peerId = pendingKnockPeer;
  const replacementToken = generateInviteToken();
  if (!signaling.rejectKnock(peerId, replacementToken)) {
    signaling.roomToken = roomToken;
    chat.system("could not reject link — signaling is unavailable");
    return;
  }
  roomToken = replacementToken;
  clearKnockRequest();
  chat.system("SECURITY: Connection Rejected by Host");
  if (!els.inviteModal?.classList.contains("hidden")) {
    drawInviteQr();
    inviteExpiresAt = Date.now() + 60_000;
    scheduleInviteRefresh();
  }
}

function cancelPendingJoin() {
  if (!roomIsHost && signaling.room) signaling.leaveRoom();
  signaling.disconnect();
  stopSession();
  rtc.closePeerConnection();
  media.teardown();
  roomCode = null;
  roomToken = null;
  hidePendingApproval();
  setStatus("AWAITING LINK", "idle");
  chat.system("join request cancelled");
}

/* ============================================================
 * USER ACTIONS
 * ============================================================ */

/** CREATE ROOM — allocate a code, connect signaling, arm the purge clock. */
async function handleCreateRoom() {
  try {
    roomCode = generateRoomCode();
    roomToken = generateInviteToken();
    roomIsHost = true;
    hostJoined = false;
    renderRoomCode(els.roomCode, roomCode);
    chat.system(`room ${roomCode} created — link valid 2 hours`);
    setStatus("CONNECTING...", "pending");

    await connectAndArm(roomCode, { token: roomToken, isHost: true });

    // As initiator we create the peer connection + data channel now,
    // and fire the offer the moment the peer joins.
    setStatus("ACQUIRING MEDIA...", "pending");
    await setupLocalMedia();
    startNativeProximityScan();
    rtc.createPeerConnection(media.stream, { initiator: true });
    chat.system("awaiting peer — offer queued");
    setStatus("AWAITING LINK", "idle");
  } catch (err) {
    chat.system(`create failed: ${err.message}`);
    setStatus("AWAITING LINK", "idle");
  }
}

/** JOIN ROOM — connect signaling to an existing room, receive the offer. */
async function handleJoinRoom(inputInvite, inputToken) {
  let invite =
    inputToken && inputInvite
      ? { roomId: inputInvite, token: inputToken }
      : parseInvite(inputInvite || window.prompt("Scan or paste the host's current QR invite URL") || "");
  if (!invite) {
    chat.system("join requires a current host QR invite URL; room codes alone are not authorization");
    return;
  }
  const { roomId: code, token } = invite;
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(code) ||
    !/^[A-Za-z0-9_-]{43}$/.test(token)
  ) {
    chat.system("invite is malformed or expired; scan the host's current QR code");
    return;
  }
  try {
    roomCode = code;
    roomToken = token;
    roomIsHost = false;
    hostJoined = false;
    renderRoomCode(els.roomCode, code);
    chat.system(`joining room ${code}…`);

    await connectAndArm(code, { token, isHost: false });
    chat.system("invite accepted — waiting for host clearance; media is not acquired yet");
  } catch (err) {
    chat.system(`join failed: ${err.message}`);
  }
}

/** SEND MESSAGE — over the ephemeral data channel (fallback: none). */
async function handleSendMessage(text) {
  const value = text.trim();
  if (!value) return false;
  if (!rtc.dataChannel) {
    chat.system("Waiting for peer to link...");
    return false;
  }
  try {
    const cryptoReady =
      sessionCrypto.isReady || (await sessionCrypto.whenReady(2000));
    const sent = await rtc.sendMessage(value, {
      sender: signaling.peerId,
      ...(!cryptoReady ? { encryption: "plaintext-fallback" } : {}),
    });
    if (!sent) {
      chat.system(`message not sent — data channel state: ${rtc.status.dc}`);
    }
    return sent;
  } catch (error) {
    console.error("[app] chat send failed:", error);
    chat.system(`message send failed: ${error.message}`);
    return false;
  }
}

/** TOGGLE MEDIA — mic mute / camera disable, reflected on the dock. */
function handleToggleMedia(kind) {
  const enabled = kind === "audio" ? media.toggleMute() : media.toggleCamera();

  const btn = kind === "audio" ? els.btnAudio : els.btnVideo;
  const stateEl = kind === "audio" ? els.audioState : els.videoState;
  renderMediaToggle(btn, stateEl, enabled);

  // Inform the peer over the data channel (it will see the tracks go dark).
  rtc.sendPacket({
    type: "media-state",
    sender: signaling.peerId,
    text:
      kind === "audio"
        ? enabled
          ? "audio-on"
          : "audio-off"
        : enabled
          ? "video-on"
          : "video-off",
  });
  return enabled;
}

/* ============================================================
 * ORCHESTRATION HELPERS
 * ============================================================ */

/** Connect signaling, join the room, arm the 2-hour purge countdown. */
async function connectAndArm(code, { token, isHost }) {
  if (signaling.isConnected && signaling.room) signaling.leaveRoom();
  signaling.room = code;
  signaling.roomToken = token;
  signaling.isHost = Boolean(isHost);

  if (!signaling.isConnected) {
    try {
      await signaling.connect();
    } catch {
      chat.system(
        "signaling backend is waking up from sleep; auto-reconnecting in background...",
      );
    }
  }
  cryptoHandshakePromise = null;
  sessionCrypto.zeroize();
  signaling.joinRoom(code, { token, isHost });

  // autoPurge: 7200s reverse countdown ticking the header clock.
  stopSession();
  autoPurge.init({
    wipeStore: () => volatileBuffer.wipeStore(),
    onTick: ({ remainingSeconds }) => {
      renderCountdown(els.timerDisplay, remainingSeconds * 1000);
    },
    onPurgeStart: () => {
      chat.system("PURGE INITIATED");
      clearInviteState();
      clearKnockRequest();
      hidePendingApproval();
      clearRadarPeers();
      if (radarExpiryTimer !== null) {
        clearInterval(radarExpiryTimer);
        radarExpiryTimer = null;
      }
      setChatControlsEnabled(false);
      signaling.destroyRoom();
      signaling.disconnect();
      rtc.closePeerConnection();
      media.teardown();
    },
    onPurgeComplete: () => showPurgeOverlay(),
  });
  autoPurge.startSession(); // 7200 s
}

/**
 * E2E crypto: initiator derives an ECDH pair and ships its public key
 * over the data channel; both sides derive the same AES-GCM key in RAM.
 * Chat packets are then sealed end-to-end.
 */
async function startCryptoHandshake() {
  if (sessionCrypto.isReady) return;
  if (!cryptoHandshakePromise) {
    cryptoHandshakePromise = (async () => {
      const { publicKey } = await sessionCrypto.beginHandshake();
      const sent = await rtc.sendPacket({
        type: "crypto-handshake",
        sender: signaling.peerId,
        key: toB64(publicKey),
      });
      if (!sent) throw new Error("could not send encryption handshake");
    })().catch((error) => {
      cryptoHandshakePromise = null;
      throw error;
    });
  }
  await cryptoHandshakePromise;
}

function toB64(buf) {
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Receiver side: on the peer's handshake packet, derive the shared key
 * and send our own public key back so the initiator can derive it too.
 */
async function handleCryptoHandshake(packet) {
  if (!sessionCrypto.isReady) {
    const peerKey = fromB64(packet.key);
    const { publicKey } = await sessionCrypto.beginHandshake();
    await sessionCrypto.completeHandshake(peerKey);
    // Reply so the initiator can finish deriving the same key.
    const sent = await rtc.sendPacket({
      type: "crypto-handshake-reply",
      sender: signaling.peerId,
      key: toB64(publicKey),
    });
    if (!sent) throw new Error("could not send encryption handshake reply");
    notifyCryptoReady();
    chat.system("ephemeral cipher locked (receiver)");
  }
}

async function handleCryptoHandshakeReply(packet) {
  if (!sessionCrypto.isReady) {
    await sessionCrypto.completeHandshake(fromB64(packet.key));
    notifyCryptoReady();
    chat.system("ephemeral cipher locked (initiator)");
  }
}

/** Acquire mic/cam, bind to the local PiP element, keep controls live. */
async function setupLocalMedia() {
  const result = await media.acquire();
  els.videoLocal.closest(".video-pip")?.classList.toggle("has-media", Boolean(result.stream));
  if (result.stream) {
    els.videoLocal.srcObject = result.stream;
    els.btnAudio.disabled = els.btnVideo.disabled = false;
  } else {
    chat.system(`media: ${media.describeFailure()} — text relay only`);
    els.btnAudio.disabled = els.btnVideo.disabled = true;
  }
  renderMediaToggle(els.btnAudio, els.audioState, media.audioEnabled);
  renderMediaToggle(els.btnVideo, els.videoState, media.videoEnabled);
  return result;
}

/** Offer fired when the first remote peer appears in the room. */
signaling.onPeerJoined = (peerId) => {
  chat.system(`peer ${short(peerId)} joined`);
  clearKnockRequest();
  rtc.remotePeerId = peerId;
  if (rtc.isInitiator && rtc.pc) {
    rtc
      .createOffer()
      .catch((err) => chat.system(`offer failed: ${err.message}`));
  }
};

signaling.onJoined = (_roomId, _peerId, peers, isHost) => {
  roomIsHost = isHost;
  hostJoined = isHost;
  if (isHost && els.btnQr) els.btnQr.disabled = false;
  if (!isHost) {
    hidePendingApproval();
    setupLocalMedia()
      .then(() => startNativeProximityScan())
      .catch((error) => chat.system(`media setup failed: ${error.message}`));
  }
  chat.system(`signaling joined — ${peers.length} peer(s) already present`);
};

signaling.onKnockRequest = showKnockRequest;
signaling.onJoinPending = () => {
  showPendingApproval();
  chat.system("pending host clearance — connection is not active yet");
};
signaling.onKnockApproved = ({ peerId }) => {
  clearKnockRequest();
  if (roomIsHost) {
    chat.system(`host authorized peer ${short(peerId)}`);
    rotateHostCapability();
  } else {
    chat.system("host cleared the request — establishing peer link");
    if (els.remoteTagLabel) els.remoteTagLabel.textContent = "REMOTE // HOST CLEARED — LINKING";
  }
};
signaling.onKnockExpired = ({ peerId, reason }) => {
  if (peerId === pendingKnockPeer) clearKnockRequest();
  chat.system(
    reason === "rejected"
      ? "SECURITY: Connection Rejected by Host"
      : `connection request expired (${reason || "timeout"})`,
  );
};
signaling.onConnectionRejected = ({ message }) => {
  chat.system(message);
  hidePendingApproval();
  clearKnockRequest();
  stopSession();
  rtc.closePeerConnection();
  media.teardown();
  signaling.disconnect();
  signaling.room = null;
  signaling.roomToken = null;
  signaling.isHost = false;
  roomToken = null;
  roomCode = null;
  setChatControlsEnabled(false);
  setStatus("AWAITING LINK", "idle");
};
signaling.onRoomTokenRotated = () => {
  chat.system("room invite rotated — previous QR invalidated");
};

signaling.onError = (error) => {
  chat.system(`signaling: ${error.message}`);
};

signaling.onPeerLeft = (peerId) => {
  chat.system(`peer ${short(peerId)} left`);
  if (peerId === rtc.remotePeerId) {
    rtc.closePeerConnection();
    setChatControlsEnabled(false);
    removeWebRtcRadarPeer();
    renderRemoteState(els.remoteFallback, null);
    setStatus("AWAITING LINK", "idle");
  }
};

signaling.onOpen = () => {
  chat.system("signaling connected");
};

signaling.onDisconnect = (willRetry, attempts) => {
  chat.system(
    willRetry ? `signaling down — retry #${attempts}` : "signaling lost",
  );
};

signaling.onReconnecting = (attempt, delayMs) => {
  chat.system(
    `reconnecting to signaling in ${Math.round(delayMs / 100) / 10}s (attempt #${attempt})…`,
  );
};

/* ============================================================
 * PURGE / PANIC
 * ============================================================ */

function showPurgeOverlay() {
  els.purgeOverlay?.classList.remove("hidden");
}

function executePanic() {
  if (els.btnPanic) els.btnPanic.dataset.active = "true";
  chat.system("PANIC — destroying session");
  clearInviteState();
  clearKnockRequest();
  hidePendingApproval();
  clearRadarPeers();
  autoPurge.destroySession(); // tracks + channels + store + blank screen
}

function reinitializeSession() {
  els.purgeOverlay?.classList.add("hidden");
  els.btnPanic.dataset.active = "false";
  volatileBuffer.wipeStore();
  chat.flush();
  rtc.closePeerConnection();
  media.teardown();
  renderRoomCode(els.roomCode, "----");
  renderCountdown(els.timerDisplay, SESSION_TTL_MS);
  clearInviteState();
  clearKnockRequest();
  hidePendingApproval();
  els.remoteFallback.classList.remove("hidden");
  document.querySelector(".video-primary")?.classList.remove("has-remote");
  setStatus("AWAITING LINK", "idle");
  autoPurge.reinitialize();
  if (radarExpiryTimer === null) {
    radarExpiryTimer = setInterval(expireNativeRadarPeers, 5000);
  }
}

/* ============================================================
 * UI EVENT WIRING
 * ============================================================ */

// Room controls are keyboard-driven: "C" opens a create prompt,
// "J" joins. A tiny inline command palette keeps the UI minimal.
document.addEventListener("keydown", (event) => {
  if (event.target === els.chatInput) {
    if (event.key === "Escape") {
      els.chatInput.blur();
    }
    return;
  }
  switch (event.key.toLowerCase()) {
    case "c":
      handleCreateRoom();
      break;
    case "j":
      handleJoinRoom();
      break;
    case "m":
      handleToggleMedia("audio");
      break;
    case "v":
      handleToggleMedia("video");
      break;
    case "t":
      toggleChat();
      break;
    case "escape":
      executePanic();
      break;
    default:
      break;
  }
});

function toggleChat() {
  chatOpen = !chatOpen;
  renderChatDrawer(els.chatDrawer, els.btnChat, els.chatState, chatOpen);
  if (chatOpen) els.chatInput?.focus();
}

els.btnCreateRoom.addEventListener("click", () => {
  if (els.btnCreateRoom) els.btnCreateRoom.disabled = true;
  setTimeout(() => {
    handleCreateRoom().finally(() => {
      if (els.btnCreateRoom && !signaling.isConnected) {
        els.btnCreateRoom.disabled = false;
      }
    });
  }, 0);
});

els.btnJoinRoom.addEventListener("click", () => {
  setTimeout(() => handleJoinRoom(), 0);
});

els.btnQr.addEventListener("click", () => {
  setTimeout(showInviteModal, 0);
});

els.closeInvite.addEventListener("click", () => {
  requestAnimationFrame(hideInviteModal);
});

els.approveKnock.addEventListener("click", () => {
  setTimeout(authorizePendingKnock, 0);
});

els.rejectKnock.addEventListener("click", () => {
  setTimeout(rejectPendingKnock, 0);
});

els.cancelPendingJoin.addEventListener("click", () => {
  setTimeout(cancelPendingJoin, 0);
});

els.copyRoom.addEventListener("click", () => {
  if (!roomCode) {
    chat.system("create or join a room before copying its code");
    return;
  }
  navigator.clipboard.writeText(roomCode).then(() => {
    chat.system("room code copied");
  }).catch((error) => {
    chat.system(`could not copy room code: ${error.message}`);
  });
});

els.closeChat.addEventListener("click", () => {
  chatOpen = false;
  requestAnimationFrame(() => {
    renderChatDrawer(els.chatDrawer, els.btnChat, els.chatState, chatOpen);
  });
});

els.chatForm.addEventListener("submit", (event) => {
  event.preventDefault(); // no page reload, no history entry
  const value = els.chatInput.value;
  els.chatInput.value = ""; // input holds nothing after send
  if (value.trim()) {
    setTimeout(() => handleSendMessage(value), 0);
  }
});

els.btnAudio.addEventListener("click", () => {
  requestAnimationFrame(() => handleToggleMedia("audio"));
});

els.btnVideo.addEventListener("click", () => {
  requestAnimationFrame(() => handleToggleMedia("video"));
});

els.btnChat.addEventListener("click", () => {
  requestAnimationFrame(toggleChat);
});

els.btnNuke.addEventListener("click", () => {
  executePanic();
});

els.btnPanic.addEventListener("click", () => {
  executePanic();
});

els.btnRecover.addEventListener("click", () => {
  setTimeout(reinitializeSession, 0);
});
setChatControlsEnabled(false);
radarExpiryTimer = setInterval(expireNativeRadarPeers, 5000);
updateRadar();

/* ============================================================
 * UTILITIES
 * ============================================================ */

/** 6-char unambiguous room code, generated fresh every session. */
function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/1, O/0
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function generateInviteToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function parseInvite(value) {
  try {
    const url = new URL(String(value).trim(), window.location.origin);
    const params = new URLSearchParams(url.hash.replace(/^#/, ""));
    const roomId = params.get("join");
    const token = params.get("token");
    if (
      !roomId ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(roomId) ||
      !token ||
      !/^[A-Za-z0-9_-]{43}$/.test(token)
    ) {
      return null;
    }
    return { roomId, token };
  } catch {
    return null;
  }
}

const short = (id) => (id || "").slice(0, 6) || "??????";

// --- Defensive shields: visibility blur, panic gestures, clipboard lock ---
panicShield.install({
  selector: ".stage, .video-primary, .video-pip", // sensitive viewports only
  onPanic: () => panicShield.blurViewport(),
});
// Crypto zeroization rides along with the session purge.
autoPurge.setTeardownHandler(() => sessionCrypto.zeroize());

// Boot banner — proves the wire is live without persisting anything.
chat.system("ghost-stream online — volatile session, zero retention");
renderCountdown(els.timerDisplay, SESSION_TTL_MS);
els.btnAudio.disabled = els.btnVideo.disabled = true;
renderRemoteState(els.remoteFallback, null);

// Expose for console-level debugging (window only, never storage).
Object.assign(window, {
  __ghost: { signaling, media, rtc, chat, volatileBuffer, autoPurge },
  __ghostProximity: {
    reportSignal: reportProximitySignal,
    reportError: reportProximityError,
    clear: clearRadarPeers,
  },
});

const scannedInvite = parseInvite(window.location.href);
if (scannedInvite) {
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
  void handleJoinRoom(scannedInvite.roomId, scannedInvite.token);
}
