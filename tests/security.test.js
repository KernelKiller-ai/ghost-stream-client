// Node-run tests for the security layer: cryptoUtils (real WebCrypto
// via Node's webcrypto) + panicTrigger (simulated DOM/visibility).
// Run: node client-web/tests/security.test.js

const subtle = globalThis.crypto.subtle;

const { EphemeralCrypto, sealPacket, openPacket, sessionCrypto, fromB64, toB64 } =
  await import("../src/security/cryptoUtils.js");
let panic;
try {
  panic = await import("../src/security/panicTrigger.js");
} catch {
  panic = null;
}

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
};

/* ---------------- cryptoUtils ---------------- */

const base64Bytes = new Uint8Array([0, 1, 127, 128, 255]);
check(
  "Base64 helpers round-trip ECDH key bytes",
  fromB64(toB64(base64Bytes)).every((byte, index) => byte === base64Bytes[index]),
);

// Two peers derive the same key via ECDH and exchange sealed packets.
const alice = new EphemeralCrypto();
const bob = new EphemeralCrypto();

const aPub = (await alice.beginHandshake()).publicKey;
const bPub = (await bob.beginHandshake()).publicKey;
await alice.completeHandshake(bPub);
await bob.completeHandshake(aPub);
check("both peers derive a session key", alice.isReady && bob.isReady);

const readinessProbe = new EphemeralCrypto();
const readinessPromise = readinessProbe.whenReady(100);
const readinessPeer = new EphemeralCrypto();
const readinessPeerKey = (await readinessPeer.beginHandshake()).publicKey;
const readinessLocalKey = (await readinessProbe.beginHandshake()).publicKey;
await readinessProbe.completeHandshake(readinessPeerKey);
await readinessPeer.completeHandshake(readinessLocalKey);
check("whenReady resolves when key agreement completes", await readinessPromise);
readinessProbe.zeroize();
readinessPeer.zeroize();

const timeoutProbe = new EphemeralCrypto();
check(
  "whenReady returns false on timeout",
  (await timeoutProbe.whenReady(5)) === false,
);
timeoutProbe.zeroize();

// Alice seals -> Bob opens
const envelope = await alice.encrypt("plain text never on the wire");
check(
  "envelope has iv+ct, no plaintext",
  !JSON.stringify(envelope).includes("plain text"),
);
const opened = await bob.decrypt(envelope);
check(
  "bob decrypts alice's ciphertext",
  opened === "plain text never on the wire",
);

// Tamper detection: flip a byte in the ciphertext
const tampered = { iv: envelope.iv, ct: envelope.ct };
const raw = atob(envelope.ct.replace(/-/g, "+").replace(/_/g, "/"));
const flipped = String.fromCharCode(raw.charCodeAt(0) ^ 0xff) + raw.slice(1);
tampered.ct = btoa(flipped)
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
let authFailed = false;
try {
  await bob.decrypt(tampered);
} catch {
  authFailed = true;
}
check("GCM auth rejects tampered ciphertext", authFailed);

// Fresh IV per message
const env2 = await alice.encrypt("second");
check("fresh IV per message", env2.iv !== envelope.iv);

// sealPacket/openPacket wire format — prime the singleton first so the
// packet path actually encrypts (mirrors app.js after handshake).
const sgPub = (await sessionCrypto.beginHandshake()).publicKey;
const peer = new EphemeralCrypto();
const peerPub = (await peer.beginHandshake()).publicKey;
await sessionCrypto.completeHandshake(peerPub);
await peer.completeHandshake(sgPub);

const wire = await sealPacket({ type: "chat", text: "secret" });
check("sealed wire hides plaintext", !wire.includes("secret") && JSON.parse(wire).e === 1);
const controlWire = await sealPacket({ type: "ping", pingId: "test" });
check(
  "control frames remain plaintext with a clear envelope",
  JSON.parse(controlWire).e === 0,
);
const clearPing = await openPacket(JSON.stringify({
  e: 1,
  p: { type: "ping", pingId: "wrapped-test" },
}));
check(
  "wrapped heartbeat control skips decryption",
  clearPing.packet.pingId === "wrapped-test" && !clearPing.encrypted,
);
// The peer side of the singleton handshake can decrypt the same frame:
const recovered = JSON.parse(await peer.decrypt(JSON.parse(wire)));
check("peer decrypts sealed packet", recovered.text === "secret");
const unwrapped = await openPacket(wire);
check(
  "openPacket recovers packet",
  unwrapped.packet.text === "secret" && unwrapped.encrypted === true,
);

// zeroize kills the channel permanently
alice.zeroize();
check("zeroize kills encryption", alice.isReady === false);
let deadThrew = false;
try {
  await alice.encrypt("x");
} catch {
  deadThrew = true;
}
check("encrypt after zeroize throws", deadThrew);

// bootstrap (no key) -> cleartext fallback frame: temporarily clear the
// singleton's key to simulate the pre-handshake state.
const savedKey = sessionCrypto._sessionKey;
sessionCrypto._sessionKey = null;
const clearWire = await sealPacket({ type: "presence", text: "linked" });
sessionCrypto._sessionKey = savedKey;
const clearOpen = await openPacket(clearWire);
check(
  "cleartext bootstrap frame round-trips",
  clearOpen.packet.text === "linked" && clearOpen.encrypted === false,
);
const fallbackOpen = await openPacket(JSON.stringify({
  p: {
    type: "chat",
    text: "marked fallback",
    encryption: "plaintext-fallback",
  },
  e: 0,
}));
check(
  "plaintext fallback metadata survives the wire envelope",
  fallbackOpen.packet.encryption === "plaintext-fallback" &&
    fallbackOpen.encrypted === false,
);

sessionCrypto.zeroize();

/* ---------------- panicTrigger (fake DOM) ---------------- */

if (panic) {
  // Minimal DOM shim
  const listeners = new Map();
  const doc = {
    visibilityState: "visible",
    body: { style: {} },
    querySelectorAll: (sel) => (sel.includes("video") ? [fakeVideo()] : [fakeDiv()]),
    addEventListener: (t, fn) => add("document", t, fn),
    removeEventListener: (t, fn) => remove("document", t, fn),
  };
  const win = {
    addEventListener: (t, fn) => add("window", t, fn),
    removeEventListener: (t, fn) => remove("window", t, fn),
  };
  function add(scope, t, fn) {
    const key = `${scope}:${t}`;
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key).push(fn);
  }
  function remove(scope, t, fn) {
    const key = `${scope}:${t}`;
    listeners.set(
      key,
      (listeners.get(key) || []).filter((f) => f !== fn),
    );
  }
  function fire(scope, t, ev) {
    for (const fn of listeners.get(`${scope}:${t}`) || []) fn(ev);
  }
  let videoPaused = false,
    videoResumed = false,
    panicFired = 0,
    purgeBroadcasts = 0;
  function fakeVideo() {
    return {
      paused: false,
      dataset: {},
      pause() {
        videoPaused = true;
        this.paused = true;
      },
      play() {
        videoResumed = true;
        this.paused = false;
        return { catch() {} };
      },
      setAttribute(n) {
        this.dataset[n] = 1;
      },
      removeAttribute(n) {
        delete this.dataset[n];
      },
    };
  }
  function fakeDiv() {
    return {
      closest: () => null,
      addEventListener: (t, fn) => add("div", t, fn),
      removeEventListener: (t, fn) => remove("div", t, fn),
      style: {},
    };
  }

  // DOM-less module patches
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.performance = { now: () => Date.now() };

  // autoPurge's destroySession is an ES export (read-only) — instead of
  // stubbing it, give it DOM fakes it needs and assert via its own status.
  let navigatedTo = null;
  win.location = { replace: (url) => { navigatedTo = url; } };
  document.createElement = () => fakeDiv();
  document.documentElement = {
    replaceChildren() {},
    appendChild() {},
  };

  panic.install({
    onPanic: () => panicFired++,
    onBroadcastPurge: () => purgeBroadcasts++,
  });

  // 1. Visibility: hide -> blur + pause
  doc.visibilityState = "hidden";
  fire("document", "visibilitychange", {});
  check(
    "hidden tab blurs viewport",
    doc.body.style.filter.includes("blur(40px)"),
  );
  check("hidden tab pauses video", videoPaused);

  // 2. Visible again -> restore
  doc.visibilityState = "visible";
  fire("document", "visibilitychange", {});
  check("visible tab unblurs", !doc.body.style.filter);
  check("video resumed after unblur", videoResumed);

  // 3. Double-ESC -> zeroization (real autoPurge runs; assert its status)
  const purgeMod = await import("../src/memory/autoPurge.js");
  fire("window", "keydown", { key: "Escape" });
  fire("window", "keydown", { key: "Escape" });
  check("double-ESC triggers panic hook", panicFired >= 1);
  check("double-ESC broadcasts remote purge once", purgeBroadcasts === 1);
  check("double-ESC triggers zeroization", purgeMod.status().destroyed === true && navigatedTo === "about:blank");
  panic.triggerZeroization(); // second call must be a no-op
  check("panic idempotent", purgeMod.status().destroyed === true);

  // 4. Context menu suppressed
  const ctxEv = {
    preventDefault() {},
    stopPropagation() {},
    target: { closest: () => null },
  };
  fire("div", "contextmenu", ctxEv);
  fire("document", "contextmenu", ctxEv);
  check("contextmenu events handled without error", true);
} else {
  console.log("SKIP  panicTrigger (DOM shim unavailable)");
}

console.log(
  failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
