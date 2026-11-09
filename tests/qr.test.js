// Node-run smoke test for the dependency-free invite QR encoder.
// Run: node client-web/tests/qr.test.js

const { renderQrCode } = await import("../src/ui/qrEncoder.js");
let failures = 0;
const check = (name, condition) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) failures++;
};

globalThis.document = {
  createElementNS: (_namespace, name) => ({
    name,
    attributes: {},
    setAttribute(key, value) {
      this.attributes[key] = value;
    },
  }),
};

const svg = {
  attributes: {},
  children: [],
  replaceChildren() {
    this.children = [];
  },
  setAttribute(key, value) {
    this.attributes[key] = value;
  },
  appendChild(child) {
    this.children.push(child);
  },
};

check("QR payload rendered", renderQrCode(svg, "https://x/#join=ROOM&token=secret"));
check("QR SVG has a quiet-zone viewBox", svg.attributes.viewBox?.startsWith("0 0 "));
check(
  "QR SVG includes a black module path",
  svg.children.some((child) => child.name === "path" && child.attributes.d.length > 0),
);

let capacityError = false;
try {
  renderQrCode(svg, "x".repeat(200));
} catch (error) {
  capacityError = error instanceof RangeError;
}
check("oversized QR payload fails explicitly", capacityError);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
