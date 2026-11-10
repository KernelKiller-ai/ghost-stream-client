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

import { SignalingClient, setTransportMode, resolveSignalingUrl } from "./core/signalingClient.js";
import { getTransportMode, isOfflineMode, setTransportMode as setNetMode } from "./net/transportState.js";
import { MediaStreamController } from "./core/mediaStream.js";
import { WebRTCManager } from "./core/webrtcManager.js";
import { volatileBuffer } from "./memory/volatileBuffer.js";
import * as autoPurge from "./memory/autoPurge.js";
import { stopSession } from "./memory/autoPurge.js";
import {
  sessionCrypto,
  openPacket,
  fromB64,
  toB64,
} from "./security/cryptoUtils.js";
import * as panicShield from "./security/panicTrigger.js";
import {
  EphemeralChatView,
  renderRoomCode,
  renderParticipantPresence,
  renderCountdown,
  renderMediaToggle,
  renderChatDrawer,
  renderRemoteState,
  estimateDistanceMeters,
  renderRadarPeers,
  renderObliteratedScreen,
  SESSION_TTL_MS,
  BleRadarView,
  QrAnswerScannerView,
} from "./ui/renderView.js";
import { renderQrCode } from "./ui/qrEncoder.js";

/* ---------------- DOM handles ---------------- */
const $ = (id) => document.getElementById(id);
const els = {
  roomCode: $("roomCodeDisplay"),
  peerAvatar: $("peerCardAvatar"),
  peerStackAvatar: $("peerStackAvatar"),
  peerCard: $("videoPrimaryWrapper"),
  peerCardName: $("peerCardName"),
  peerCardStatus: $("peerCardStatus"),
  peerCardTag: $("peerCardTag"),
  participantCount: $("participantCount"),
  localCardRole: $("localCardRole"),
  localRoleTag: $("localRoleTag"),
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
  btnBleRadar: $("btnBleRadar"),
  netModeCloud: $("netModeCloud"),
  netModeOffline: $("netModeOffline"),
  qrScanModal: $("qrScanModal"),
  qrScanPreview: $("qrScanPreview"),
  qrScanStatus: $("qrScanStatus"),
  btnQrScanCancel: $("btnQrScanCancel"),
  radarOverlay: $("radarOverlay"),
  roomHeadingMembers: document.querySelector(".room-heading-members"),
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
  telemetryPill: $("telemetryPill"),
  telemetryPillText: $("telemetryPillText"),
  telemetryDrawer: $("telemetryDrawer"),
  telemetryLog: $("telemetryLog"),
  closeTelemetry: $("closeTelemetry"),
  telemetryClearBtn: $("telemetryClearBtn"),
  btnAutoClear: $("btnAutoClear"),
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
const chat = new EphemeralChatView(
  els.chatLog,
  els.telemetryLog,
  els.telemetryPillText,
);
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
  onPurge: (packet) => {
    console.warn("[app] EMERGENCY remote purge received:", packet);
    executePanic(true);
  },
  onCryptoReady: (role) => {
    notifyCryptoReady();
    chat.system(`ephemeral cipher locked (AES-256-GCM // ${role})`);
  },
  onChatMessage: (entry) =>
    chat.append(entry.sender, entry.text, { kind: entry.kind }),
  onDataChannelOpen: async () => {
    chat.system("ephemeral channel open — serverless relay active");
    setStatus("LINKED", "live");
    updateParticipantPresence(true);
    setChatControlsEnabled(true);
    updateWebRtcRadarPeer();
  },
  onDataChannelClose: () => {
    chat.system("ephemeral channel closed");
    setStatus("AWAITING LINK", "idle");
    updateParticipantPresence(false);
    setChatControlsEnabled(false);
    removeWebRtcRadarPeer();
  },
  onRoundTripTime: (rttMs) => updateWebRtcRadarPeer(rttMs),
  onIceConnectionState: (state) => {
    console.info(`[app] WebRTC iceConnectionState: ${state}`);
    if (state === "checking") {
      chat.system("ICE candidate checking — discovering STUN/TURN relays");
      if (els.telemetryPillText) els.telemetryPillText.textContent = "ICE // CHECKING RELAYS";
    } else if (state === "connected" || state === "completed") {
      chat.system(`ICE path established (${state}) — direct relay active`);
      if (els.telemetryPillText) els.telemetryPillText.textContent = "ICE // CONNECTED (P2P/TURN)";
      renderRemoteState(els.remoteFallback, rtc.remoteStream, "connected");
    } else if (state === "failed") {
      chat.system("ICE negotiation failed across network NATs — checking fallback");
      if (els.telemetryPillText) els.telemetryPillText.textContent = "ICE // NAT TRAVERSAL FAILED";
      setStatus("ICE FAILED", "warning");
    } else if (state === "disconnected") {
      chat.system("ICE disconnected — network switch or temporary packet loss");
      if (els.telemetryPillText) els.telemetryPillText.textContent = "ICE // DISCONNECTED";
    }
  },
  onSignalingState: (state) => {
    console.info(`[app] WebRTC signalingState: ${state}`);
    if (state === "have-remote-offer") {
      chat.system("SDP remote offer received — generating answer");
      if (els.telemetryPillText) els.telemetryPillText.textContent = "WEBRTC // ANSWERING OFFER";
    }
  },
  onConnectionState: (state) => {
    console.info(`[app] WebRTC connectionState: ${state}`);
    if (state === "connected") {
      setStatus(
        rtc.dataChannel?.readyState === "open" ? "LINKED" : "STREAM ACTIVE",
        "live",
      );
      if (els.telemetryPillText) els.telemetryPillText.textContent = "LINK ACTIVE // ENCRYPTED";
      els.remoteFallback.classList.add("hidden");
      document.querySelector(".video-primary")?.classList.add("has-remote");
      renderRemoteState(els.remoteFallback, rtc.remoteStream, "connected");
    } else if (state === "connecting") {
      setStatus("HANDSHAKE...", "pending");
      if (els.telemetryPillText) els.telemetryPillText.textContent = "WEBRTC // HANDSHAKE";
    } else if (state === "failed" || state === "disconnected") {
      setStatus("LINK UNSTABLE", "warning");
      if (els.telemetryPillText) els.telemetryPillText.textContent = `WEBRTC // ${state.toUpperCase()}`;
      setChatControlsEnabled(false);
      renderRemoteState(els.remoteFallback, rtc.remoteStream, state);
      chat.system(`WebRTC peer connection state dropped to '${state}'`);
    }
  },
});



/* ---------------- session state ---------------- */
let roomCode = null;
let chatOpen = false;
let telemetryOpen = false;
let AUTO_CLEAR_PEERS = true;

function toggleAutoClear(value) {
  AUTO_CLEAR_PEERS = typeof value === "boolean" ? value : !AUTO_CLEAR_PEERS;
  if (els.btnAutoClear) {
    els.btnAutoClear.dataset.active = String(AUTO_CLEAR_PEERS);
    els.btnAutoClear.setAttribute("aria-pressed", String(AUTO_CLEAR_PEERS));
    els.btnAutoClear.textContent = AUTO_CLEAR_PEERS ? "AUTO: ON" : "AUTO: OFF";
  }
  window.AUTO_CLEAR_PEERS = AUTO_CLEAR_PEERS;
  chat.system(`tactical setting: AUTO_CLEAR_PEERS is now ${AUTO_CLEAR_PEERS ? "ENABLED" : "DISABLED"}`);
}

function notifyCryptoReady() {
  if (!sessionCrypto.isReady) return;
  updateParticipantPresence(true);
  rtc.flushPendingMessages().catch((error) => {
    console.error("[app] queued chat flush failed:", error);
  });
}

const setStatus = (text, state) => {
  if (els.remoteTagLabel) els.remoteTagLabel.textContent = `REMOTE // ${text}`;
  const dot = document.querySelector(".video-tag--remote .status-dot");
  if (dot) dot.dataset.state = state || "idle";
};

function updateParticipantPresence(connected = false) {
  renderParticipantPresence(
    { ...els, isHost: roomIsHost },
    connected,
    rtc.remotePeerId || "",
    sessionCrypto.isReady,
  );
}

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
  if (els.inviteModal?.contains(document.activeElement)) {
    document.activeElement?.blur();
  }
  els.inviteModal?.classList.add("hidden");
  els.inviteModal?.setAttribute("aria-hidden", "true");
}

function clearInviteState() {
  hideInviteModal();
  roomToken = null;
  roomIsHost = false;
  hostJoined = false;
  updateParticipantPresence(false);
  if (els.btnQr) els.btnQr.disabled = true;
}

function showKnockRequest({ peerId, timestamp, codeOnly = false }) {
  pendingKnockPeer = peerId;
  pendingKnockExpiresAt = (timestamp || Date.now()) + 30_000;
  if (els.knockPeer) {
    els.knockPeer.textContent = `${short(peerId)}${codeOnly ? " [CODE ENTRY]" : " [QR INVITE]"}`;
  }
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
  rtc.remotePeerId = peerId;
  if (rtc.isInitiator && rtc.pc) {
    rtc
      .createOffer()
      .then(() => chat.system("WebRTC SDP offer transmitted to peer"))
      .catch((err) => chat.system(`offer failed: ${err.message}`));
  }
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
  updateParticipantPresence(false);
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
    updateParticipantPresence(false);
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
    setChatControlsEnabled(true);
    chat.system("awaiting peer — offer queued");
    setStatus("AWAITING LINK", "idle");
  } catch (err) {
    chat.system(`create failed: ${err.message}`);
    setStatus("AWAITING LINK", "idle");
  }
}

/** JOIN ROOM — connect signaling to an existing room by code or full invite URL. */
async function handleJoinRoom(inputInvite, inputToken) {
  let raw = inputInvite;
  if (!raw && !inputToken) {
    raw = window.prompt("Enter Room Code (e.g. 123456) or paste Host QR Invite URL:");
  }
  if (!raw && !inputToken) return;

  let invite =
    inputToken && raw
      ? { roomId: String(raw).trim().toUpperCase(), token: inputToken, isCodeOnly: false }
      : parseInvite(raw);

  if (!invite || !invite.roomId) {
    chat.system("invalid room code or invite URL; provide a valid room code or scan host QR");
    return;
  }

  const { roomId: code, token, isCodeOnly } = invite;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
    chat.system("room code contains invalid characters");
    return;
  }
  if (token && !/^[A-Za-z0-9_-]{1,64}$/.test(token)) {
    chat.system("invite token is malformed");
    return;
  }

  try {
    roomCode = code;
    roomToken = token || null;
    roomIsHost = false;
    hostJoined = false;
    renderRoomCode(els.roomCode, code);

    if (isCodeOnly || !token) {
      chat.system(`querying room ${code} via direct code entry…`);
      setStatus("QUERYING ROOM...", "pending");
    } else {
      chat.system(`joining room ${code} via cryptographic invite…`);
      setStatus("JOINING ROOM...", "pending");
    }

    await connectAndArm(code, { token: roomToken, isHost: false });
    showPendingApproval();
    setChatControlsEnabled(true);
    chat.system("awaiting host clearance & WebRTC negotiation…");

    // Pre-acquire camera/mic in background so media is immediately ready when offer arrives
    setupLocalMedia()
      .then((res) => {
        const stream = res?.stream || media.stream;
        if (!rtc.pc) {
          rtc.createPeerConnection(stream, { initiator: false });
        } else if (stream) {
          rtc.attachLocalStream(stream);
        }
      })
      .catch((err) => console.warn("[app] pre-join media warning:", err));
  } catch (err) {
    chat.system(`join failed: ${err.message}`);
    setStatus("AWAITING LINK", "idle");
    hidePendingApproval();
  }
}

/** SEND MESSAGE — over the ephemeral data channel with auto-flush queueing. */
async function handleSendMessage(text) {
  const msgText = text ? text.trim() : "";
  if (!msgText) return false;
  try {
    const cryptoReady =
      sessionCrypto.isReady || (await sessionCrypto.whenReady(500));
    const sent = await rtc.sendMessage(msgText, {
      sender: signaling.peerId,
      ...(!cryptoReady ? { encryption: "plaintext-fallback" } : {}),
    });
    if (els.chatLog) {
      els.chatLog.scrollTop = els.chatLog.scrollHeight;
    }
    return sent;
  } catch (error) {
    console.error("[app] chat send failed:", error);
    chat.system(`message send failed: ${error.message}`);
    return false;
  }
}

/** TOGGLE MEDIA — mic mute / hardware-releasing camera control. */
async function handleToggleMedia(kind) {
  let enabled;
  if (kind === "audio") {
    enabled = media.toggleMute();
  } else {
    enabled = !media.videoEnabled;
    try {
      if (enabled) {
        const cameraStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
        const [track] = cameraStream.getVideoTracks();
        if (!track) throw new Error("camera did not provide a video track");

        if (!media.stream) media.stream = new MediaStream();
        media.stream.addTrack(track);
        media.mode = media.stream.getAudioTracks().length ? "full" : "video-only";
        await rtc.setLocalVideoTrack(track);
        els.videoLocal.srcObject = media.stream;
        els.videoLocal.play?.().catch(() => {});
      } else {
        const tracks = media.stream?.getVideoTracks() || [];
        let detachError = null;
        try {
          await rtc.setLocalVideoTrack(null);
        } catch (error) {
          detachError = error;
        } finally {
          for (const track of tracks) {
            media.stream?.removeTrack(track);
            track.stop();
          }
        }
        if (els.videoLocal) els.videoLocal.srcObject = null;
        if (media.stream?.getAudioTracks().length) {
          media.mode = "audio-only";
        } else {
          media.stream = null;
          media.mode = "none";
        }
        if (detachError) throw detachError;
      }
    } catch (error) {
      console.warn("[app] camera toggle failed:", error?.name || error?.message);
      chat.system(`camera ${enabled ? "could not start" : "could not stop"}: ${error.message}`);
      enabled = media.videoEnabled;
    }
    const localPip = els.videoLocal.closest(".video-pip");
    localPip?.classList.add("has-media");
    localPip?.classList.toggle("has-video", enabled);
    els.btnVideo.disabled = false;
  }
  const btn = kind === "audio" ? els.btnAudio : els.btnVideo;
  const stateEl = kind === "audio" ? els.audioState : els.videoState;
  renderMediaToggle(btn, stateEl, enabled);

  // Inform the peer over the data channel (it will see the tracks go dark).
  void rtc.sendPacket({
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



/** Acquire mic/cam, bind to the local PiP element, keep controls live. */
async function setupLocalMedia() {
  const result = await media.acquire();
  const hasVideo = Boolean(
    result.stream?.getVideoTracks().some((track) => track.readyState === "live"),
  );
  const localPip = els.videoLocal.closest(".video-pip");
  localPip?.classList.add("has-media");
  localPip?.classList.toggle("has-video", hasVideo);
  if (result.stream) {
    els.videoLocal.srcObject = hasVideo ? result.stream : null;
    els.btnAudio.disabled = els.btnVideo.disabled = false;
    // Bind stream into the active RTCPeerConnection
    if (rtc.pc) rtc.attachLocalStream(result.stream);
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
      .then(() => chat.system("WebRTC SDP offer transmitted to peer"))
      .catch((err) => chat.system(`offer failed: ${err.message}`));
  }
};

signaling.onJoined = (_roomId, _peerId, peers, isHost) => {
  roomIsHost = isHost;
  hostJoined = isHost;
  if (isHost && els.btnQr) els.btnQr.disabled = false;
  if (!isHost) {
    hidePendingApproval();
    const hostPeerId = peers[0];
    if (hostPeerId) rtc.remotePeerId = hostPeerId;
    setupLocalMedia()
      .then((res) => {
        const stream = res?.stream || media.stream;
        if (!rtc.pc) {
          rtc.createPeerConnection(stream, {
            remotePeerId: hostPeerId,
            initiator: false,
          });
        } else if (stream) {
          rtc.attachLocalStream(stream);
        }
        startNativeProximityScan();
      })
      .catch((error) => chat.system(`media setup failed: ${error.message}`));
  }
  chat.system(`signaling joined — ${peers.length} peer(s) present`);
};

signaling.onKnockRequest = (request) => {
  if (AUTO_CLEAR_PEERS) {
    chat.system(`AUTO-ACCEPT: cleared peer ${short(request.peerId)} instant handshake`);
    pendingKnockPeer = request.peerId;
    authorizePendingKnock();
    return;
  }
  showKnockRequest(request);
};

signaling.onJoinPending = () => {
  showPendingApproval();
  chat.system("pending host clearance — connection is not active yet");
};

signaling.onKnockApproved = ({ peerId }) => {
  clearKnockRequest();
  if (roomIsHost) {
    chat.system(`host authorized peer ${short(peerId)}`);
    rotateHostCapability();
    rtc.remotePeerId = peerId;
    if (rtc.isInitiator && rtc.pc) {
      rtc
        .createOffer()
        .then(() => chat.system("WebRTC SDP offer transmitted to peer"))
        .catch((err) => chat.system(`offer failed: ${err.message}`));
    }
  } else {
    hidePendingApproval();
    chat.system("host cleared the request — establishing peer link");
    if (els.remoteTagLabel) els.remoteTagLabel.textContent = "REMOTE // HOST CLEARED — LINKING";
    setStatus("NEGOTIATING P2P...", "pending");
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

function executePanic(isRemote = false) {
  if (els.btnPanic) els.btnPanic.dataset.active = "true";
  if (els.btnNuke) els.btnNuke.dataset.active = "true";

  // If local trigger and data channel is open, dispatch high-priority FORCE_REMOTE_PURGE packet to remote peer
  if (!isRemote && rtc.dataChannel && rtc.dataChannel.readyState === "open") {
    try {
      const purgePacket = {
        type: "FORCE_REMOTE_PURGE",
        sender: "HOST_OVERRIDE",
        timestamp: Date.now(),
      };
      // Send raw high-priority unencrypted frame so remote peer processes it instantaneously
      rtc.dataChannel.send(JSON.stringify({ p: purgePacket, e: 0 }));
    } catch (err) {
      console.warn("[app] failed to dispatch remote kill-switch packet:", err);
    }
  }

  chat.system(isRemote ? "REMOTE HOST OVERRIDE — SESSION OBLITERATED" : "PANIC — DESTROYING SESSION");
  toggleTelemetry(false);
  clearInviteState();
  clearKnockRequest();
  hidePendingApproval();
  clearRadarPeers();

  // 1. Immediately wipe volatile RAM in memory
  volatileBuffer.wipeStore();
  chat.flush();

  // 2. Stop all local media tracks (camera & microphone)
  media.teardown();

  // 3. Close RTCPeerConnection and WebSocket signaling instances
  rtc.closePeerConnection();
  signaling.disconnect();

  // 4. Zeroize cryptographic key material
  sessionCrypto.zeroize();

  // 5. Overwrite DOM completely with a minimalist "SESSION OBLITERATED" lockout screen
  renderObliteratedScreen();

  // 6. Guarantee complete autoPurge session destruction
  try {
    autoPurge.destroySession();
  } catch {}
}

function reinitializeSession() {
  els.purgeOverlay?.classList.add("hidden");
  els.btnPanic.dataset.active = "false";
  toggleTelemetry(false);
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
      if (inviteModalOpen) {
        hideInviteModal();
      } else if (chatOpen) {
        toggleChat();
      } else if (telemetryOpen) {
        toggleTelemetry(false);
      } else {
        executePanic();
      }
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

function toggleTelemetry(open) {
  telemetryOpen = typeof open === "boolean" ? open : !telemetryOpen;
  if (els.telemetryDrawer) {
    els.telemetryDrawer.classList.toggle("collapsed", !telemetryOpen);
    els.telemetryDrawer.setAttribute("aria-expanded", String(telemetryOpen));
  }
  if (els.telemetryPill) {
    els.telemetryPill.setAttribute("aria-expanded", String(telemetryOpen));
    els.telemetryPill.dataset.active = String(telemetryOpen);
  }
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
  const inviteUrl = new URL(window.location.href);
  const hostToken = roomIsHost && roomToken ? `&token=${encodeURIComponent(roomToken)}` : "";
  inviteUrl.hash = `join=${encodeURIComponent(roomCode)}${hostToken}`;
  navigator.clipboard.writeText(inviteUrl.toString()).then(() => {
    chat.system("room invite link copied to clipboard");
    const codeEl = els.roomCode;
    if (codeEl) {
      const orig = codeEl.textContent;
      codeEl.textContent = "COPIED!";
      setTimeout(() => {
        if (codeEl && roomCode) codeEl.textContent = roomCode;
        else if (codeEl) codeEl.textContent = orig;
      }, 1500);
    }
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

els.telemetryPill?.addEventListener("click", () => {
  requestAnimationFrame(() => toggleTelemetry());
});

els.closeTelemetry?.addEventListener("click", () => {
  requestAnimationFrame(() => toggleTelemetry(false));
});

els.telemetryClearBtn?.addEventListener("click", () => {
  chat.clearTelemetry();
});

// Offline BLE Radar: top-nav button -> glassmorphic scan modal.
// Invokes bluetoothManager.scanForPeers() from the click gesture (required
// by Web Bluetooth); discovered peer name is surfaced in the room header.
const bleRadar = new BleRadarView(
  els.btnBleRadar,
  els.radarOverlay,
  els.roomHeadingMembers,
);

/* ---------------- transport mode toggle (Cloud / Offline) ---------------- */

/**
 * Cloud Relay      -> wss://ghost-stream-backend.onrender.com + full STUN/TURN
 * Offline Hotspot  -> ws://<origin-host>:10000 + iceServers: [] (host only)
 *
 * The toggle updates three places atomically:
 *   1. shared transportState (read by webrtcManager for ICE servers)
 *   2. signalingClient.mode + retarget (reconnects the live socket if any)
 *   3. aria/data attributes for the two-button radiogroup styling
 */
function applyTransportMode(mode) {
  const normalized = setNetMode(mode);
  setTransportMode(normalized); // signalingClient module-level mode
  const url = resolveSignalingUrl(normalized);
  signaling.retargetToCurrentMode();

  const offline = normalized === "offline";
  els.netModeCloud?.setAttribute("aria-checked", String(!offline));
  els.netModeCloud?.toggleAttribute("data-active", !offline);
  els.netModeOffline?.setAttribute("aria-checked", String(offline));
  els.netModeOffline?.toggleAttribute("data-active", offline);

  chat.system(
    offline
      ? `offline hotspot signaling — ${url} (direct P2P, no STUN/TURN)`
      : `cloud relay signaling — ${url}`,
  );
  console.log("[transport] switched to", normalized, "->", url);
}

els.netModeCloud?.addEventListener("click", () => applyTransportMode("cloud"));
els.netModeOffline?.addEventListener("click", () => applyTransportMode("offline"));

/* ---------------- offline QR answer scanner ---------------- */

const qrScannerView = new QrAnswerScannerView(els.qrScanPreview, els.qrScanStatus);
let qrScanAbort = null;

/**
 * Opens the scanner modal and ingests the peer's animated QR frames.
 * The decompressed SDP answer is handed straight to rtc.handleAnswer();
 * the camera LED turns off the moment the handshake completes.
 * @param {WebRTCManager} rtc active manager instance
 */
async function startQrAnswerScan(rtc) {
  if (!rtc) return;
  els.qrScanModal?.classList.remove("hidden");
  els.qrScanModal?.setAttribute("aria-hidden", "false");
  qrScanAbort = new AbortController();
  try {
    await qrScannerView.scanAndApply(rtc, qrScanAbort.signal);
  } catch {
    /* status surface already updated by the view */
  } finally {
    // Close the modal shortly after so the applied-answer status is legible.
    setTimeout(() => {
      els.qrScanModal?.classList.add("hidden");
      els.qrScanModal?.setAttribute("aria-hidden", "true");
    }, 1200);
    qrScanAbort = null;
  }
}

function closeQrAnswerScan() {
  qrScanAbort?.abort();
  qrScannerView.cancel();
  els.qrScanModal?.classList.add("hidden");
  els.qrScanModal?.setAttribute("aria-hidden", "true");
}

els.btnQrScanCancel?.addEventListener("click", closeQrAnswerScan);

els.btnAutoClear?.addEventListener("click", () => {
  toggleAutoClear();
});

els.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault(); // no page reload, no history entry
  const inputEl = els.chatInput;
  const msgText = inputEl ? inputEl.value : "";
  if (inputEl) {
    inputEl.value = ""; // input holds nothing after send
    inputEl.style.height = ""; // reset height immediately
  }
  if (msgText && msgText.trim()) {
    try {
      await handleSendMessage(msgText.trim());
    } catch (err) {
      console.warn("[app] chat submit error:", err);
    } finally {
      if (els.chatLog) {
        els.chatLog.scrollTop = els.chatLog.scrollHeight;
      }
    }
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
  if (!value) return null;
  const str = String(value).trim();
  if (!str) return null;

  // 1. Try parsing as full URL
  try {
    const url = new URL(str, window.location.origin);
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
    const queryParams = url.searchParams;

    const roomId = hashParams.get("join") || queryParams.get("join") || queryParams.get("room");
    const token = hashParams.get("token") || queryParams.get("token");

    if (roomId && /^[A-Za-z0-9_-]{1,64}$/.test(roomId)) {
      return {
        roomId: roomId.toUpperCase(),
        token: token && /^[A-Za-z0-9_-]{1,64}$/.test(token) ? token : null,
        isCodeOnly: !token,
      };
    }
  } catch {
    /* fallback to regex extraction */
  }

  // 2. Try URL query/hash fragment directly (e.g. "join=ABC123&token=...")
  const hashMatch = str.match(/join=([A-Za-z0-9_-]{1,64})(?:&token=([A-Za-z0-9_-]{1,64}))?/i);
  if (hashMatch) {
    return {
      roomId: hashMatch[1].toUpperCase(),
      token: hashMatch[2] || null,
      isCodeOnly: !hashMatch[2],
    };
  }

  // 3. Raw Room Code (3 to 64 alphanumeric characters, e.g. "XYZ123", "482910")
  const codeMatch = str.match(/^([A-Za-z0-9_-]{3,64})$/);
  if (codeMatch) {
    return {
      roomId: codeMatch[1].toUpperCase(),
      token: null,
      isCodeOnly: true,
    };
  }

  return null;
}

const short = (id) => (id || "").slice(0, 6) || "??????";

// --- Defensive shields: visibility blur, panic gestures, clipboard lock ---
panicShield.install({
  selector: ".stage, .video-container", // sensitive viewports only
  onPanic: () => panicShield.blurViewport(),
  onBroadcastPurge: () => {
    if (rtc.dataChannel && rtc.dataChannel.readyState === "open") {
      try {
        rtc.dataChannel.send(
          JSON.stringify({
            p: {
              type: "FORCE_REMOTE_PURGE",
              sender: "HOST_OVERRIDE",
              timestamp: Date.now(),
            },
            e: 0,
          }),
        );
      } catch {}
    }
  },
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
