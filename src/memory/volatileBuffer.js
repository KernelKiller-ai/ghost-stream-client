/* ============================================================
 * GHOST-STREAM // volatileBuffer.js
 * Zero-retention message store.
 *
 * INVARIANT: message state lives ONLY in a private closure
 * variable (`ephemeralStore`). No persistence layer is used
 * — ever. Any attempt to touch browser storage or cookies
 * from this module is forbidden and actively blocked by a
 * storage-lock installed at import time.
 * ============================================================ */

/** Hard cap on buffered messages — RAM ring, not a history. */
const MAX_BUFFERED = 200;

/** Deep-freeze an entry so callers cannot mutate retained state. */
function freezeEntry(entry) {
  if (entry && typeof entry === "object") {
    Object.freeze(entry);
  }
  return entry;
}

/** Normalise arbitrary payloads into a safe, minimal shape. */
function normalise(payload) {
  const at = typeof payload?.at === "number" ? payload.at : Date.now();
  return freezeEntry({
    sender: payload == null ? "" : String(payload.sender ?? ""),
    text: payload == null ? "" : String(payload.text ?? ""),
    at,
    kind: payload == null ? "peer" : String(payload.kind ?? "peer"),
  });
}

/**
 * Storage lock: tear out every persistence surface the page has,
 * and throw if any code attempts to use one afterwards. This is
 * the runtime enforcement of the "no storage" requirement.
 */
function installStorageLock() {
  const BLOCK = () => {
    throw new Error(
      "[volatileBuffer] BLOCKED: ephemeral session forbids localStorage/sessionStorage/indexedDB/cookies.",
    );
  };

  try {
    // 1. Blind every storage API with throwing proxies.
    for (const name of ["localStorage", "sessionStorage"]) {
      const desc = Object.getOwnPropertyDescriptor(window, name);
      Object.defineProperty(window, name, {
        configurable: true,
        get: BLOCK,
        set: BLOCK,
      });
      // Best-effort clear before blinding (in case anything pre-existed).
      try {
        desc?.value?.clear?.();
      } catch {
        /* ignore */
      }
    }

    // 2. Refuse new Indexed
    if (window.indexedDB) {
      try {
        window.indexedDB.databases?.();
      } catch {
        /* ignore */
      }
      Object.defineProperty(window, "indexedDB", {
        configurable: true,
        get: BLOCK,
        set: BLOCK,
      });
    }

    // 3. Expire cookies and lock writes (document.cookie stub).
    try {
      document.cookie = "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
      document.cookie = document.cookie; // probe what remains
      document.cookie.split(";").forEach((c) => {
        const name = c.split("=")[0].trim();
        if (name) {
          document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
        }
      });
      Object.defineProperty(document, "cookie", {
        configurable: true,
        get: () => "",
        set: BLOCK,
      });
    } catch {
      /* non-fatal in hardened environments */
    }
  } catch {
    // Sandboxed/CSP contexts may deny defineProperty — storage is
    // still forbidden by module policy; this lock is best-effort.
  }
}

// Lock the page down once, on first import.
if (typeof window !== "undefined" && !window.__GHOST_STORAGE_LOCKED__) {
  window.__GHOST_STORAGE_LOCKED__ = true;
  installStorageLock();
}

/* ============================================================
 * Module private state — the ONLY home of message data.
 * Nothing below is exported by reference to this array.
 * ============================================================ */
let ephemeralStore = [];

export const volatileBuffer = {
  /**
   * Append a message payload to the ephemeral ring.
   * @param {{sender?:string, text?:string, at?:number, kind?:string}} payload
   * @returns {{sender:string, text:string, at:number, kind:string}} frozen copy
   */
  pushMessage(payload) {
    const entry = normalise(payload);
    ephemeralStore.push(entry);
    if (ephemeralStore.length > MAX_BUFFERED) {
      ephemeralStore.shift(); // oldest falls out of RAM entirely
    }
    return entry;
  },

  /**
   * Read a snapshot of current messages.
   * @returns {Array<{sender:string, text:string, at:number, kind:string}>}
   */
  getMessages() {
    // Return a shallow copy so callers can never mutate the store.
    return ephemeralStore.slice();
  },

  /**
   * Wipe the store: overwrite every slot with zeroed junk, drop
   * them from the array, then drop the array itself.
   */
  wipeStore() {
    // Overwrite references (defeats naive snapshot forensics in RAM).
    for (let i = 0; i < ephemeralStore.length; i++) {
      ephemeralStore[i] = null;
    }
    ephemeralStore.length = 0;
    ephemeralStore = []; // fresh, unshared array
  },

  /** Diagnostic: number of buffered messages. */
  get size() {
    return ephemeralStore.length;
  },
};

// Freeze the public surface — no one can graft storage onto it.
Object.freeze(volatileBuffer);
