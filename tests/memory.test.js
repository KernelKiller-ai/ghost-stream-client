// Node-run smoke test for the zero-retention memory modules.
// Run: node client-web/tests/memory.test.js

const { volatileBuffer } = await import("../src/memory/volatileBuffer.js");
const purge = await import("../src/memory/autoPurge.js");

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
};

// --- volatileBuffer ---
const pushed = volatileBuffer.pushMessage({ sender: "a", text: "hello" });
check("pushMessage returns entry", pushed.text === "hello");
check("getMessages snapshot", volatileBuffer.getMessages().length === 1);
let tamperThrew = false;
try { volatileBuffer.getMessages()[0].text = "TAMPERED"; } catch { tamperThrew = true; }
check(
  "entries frozen against tampering",
  tamperThrew && volatileBuffer.getMessages()[0].text === "hello",
);
check("frozen entries", Object.isFrozen(pushed));

volatileBuffer.wipeStore();
check("wipeStore empties", volatileBuffer.size === 0);

// ring cap
for (let i = 0; i < 250; i++) volatileBuffer.pushMessage({ text: `m${i}` });
check("ring capped at 200", volatileBuffer.size === 200);
check("oldest evicted", volatileBuffer.getMessages()[0].text === "m50");
volatileBuffer.wipeStore();

// --- autoPurge: countdown formatting ---
check("7200s -> 02:00:00", purge.formatRemaining(7200) === "02:00:00");
check("0s -> 00:00:00", purge.formatRemaining(0) === "00:00:00");
check("3725s -> 01:02:05", purge.formatRemaining(3725) === "01:02:05");
check("negative clamps to zero", purge.formatRemaining(-5) === "00:00:00");

// --- autoPurge: full destroy cycle (no WebRTC objects in Node; path must not throw) ---
let ticks = 0;
purge.init({
  wipeStore: () => volatileBuffer.wipeStore(),
  onTick: () => ticks++,
  onPurgeComplete: () => {},
});
purge.startSession(2); // 2-second TTL for the test
await new Promise((r) => setTimeout(r, 2500));
check("onTick emitted", ticks >= 2);
check("session auto-destroyed at t=0", purge.status().destroyed === true);

// idempotent
await purge.destroySession();
check("destroySession idempotent", purge.status().destroyed === true);

// stopSession cancels only the active timer and is safe when repeated.
purge.startSession(10);
purge.stopSession();
purge.stopSession();
check(
  "stopSession disarms countdown",
  purge.status().armed === false && purge.status().remainingSeconds === 0,
);

// reinitialize
purge.reinitialize(10);
check(
  "reinitialize re-arms",
  purge.status().armed === true && !purge.status().destroyed,
);
purge.destroySession(); // clean up the interval

console.log(
  failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
