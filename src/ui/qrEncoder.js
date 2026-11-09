const QR_LOW_ECC_BLOCKS = [
  { data: 19, ecc: 7, blocks: 1 },
  { data: 34, ecc: 10, blocks: 1 },
  { data: 55, ecc: 15, blocks: 1 },
  { data: 80, ecc: 20, blocks: 1 },
  { data: 108, ecc: 26, blocks: 1 },
  { data: 136, ecc: 18, blocks: 2 },
];

function gfMultiply(x, y) {
  let product = 0;
  for (let bit = 7; bit >= 0; bit--) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((y >>> bit) & 1) * x;
  }
  return product;
}

function reedSolomonDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 2);
  }
  return result;
}

function reedSolomonRemainder(data, degree) {
  const divisor = reedSolomonDivisor(degree);
  const result = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[degree - 1] = 0;
    for (let i = 0; i < degree; i++) {
      result[i] ^= gfMultiply(divisor[i], factor);
    }
  }
  return result;
}

function qrCodewords(text) {
  const bytes = new TextEncoder().encode(text);
  const versionIndex = QR_LOW_ECC_BLOCKS.findIndex(
    ({ data }) => 4 + 8 + bytes.length * 8 <= data * 8,
  );
  if (versionIndex < 0) {
    throw new RangeError("Invite URL is too long for the built-in QR encoder");
  }

  const version = versionIndex + 1;
  const spec = QR_LOW_ECC_BLOCKS[versionIndex];
  const bits = [];
  const appendBits = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  appendBits(0b0100, 4);
  appendBits(bytes.length, 8);
  for (const byte of bytes) appendBits(byte, 8);
  for (let i = 0; i < Math.min(4, spec.data * 8 - bits.length); i++) bits.push(0);
  while (bits.length % 8) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j];
    data.push(value);
  }
  for (let pad = 0; data.length < spec.data; pad++) {
    data.push(pad % 2 === 0 ? 0xec : 0x11);
  }

  const blockDataLength = spec.data / spec.blocks;
  const blocks = [];
  for (let i = 0; i < spec.blocks; i++) {
    const block = Uint8Array.from(
      data.slice(i * blockDataLength, (i + 1) * blockDataLength),
    );
    blocks.push({ data: block, ecc: reedSolomonRemainder(block, spec.ecc) });
  }
  const output = [];
  for (let i = 0; i < blockDataLength; i++) {
    for (const block of blocks) output.push(block.data[i]);
  }
  for (let i = 0; i < spec.ecc; i++) {
    for (const block of blocks) output.push(block.ecc[i]);
  }
  return { version, codewords: output };
}

function makeQrMatrix(text) {
  const { version, codewords } = qrCodewords(text);
  const size = 17 + version * 4;
  const matrix = Array.from({ length: size }, () => Array(size).fill(null));
  const set = (x, y, value) => {
    if (x >= 0 && x < size && y >= 0 && y < size) matrix[y][x] = value;
  };

  const drawFinder = (centerX, centerY) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const distance = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        set(centerX + dx, centerY + dy, distance !== 2 && distance <= 3);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(size - 7, 0);
  drawFinder(0, size - 7);

  if (version > 1) {
    const center = size - 7;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        set(center + dx, center + dy, distance === 2 || distance === 0);
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    if (matrix[6][i] === null) set(i, 6, i % 2 === 0);
    if (matrix[i][6] === null) set(6, i, i % 2 === 0);
  }

  const formatData = 0b01000;
  let remainder = formatData;
  for (let i = 0; i < 10; i++) {
    remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
  }
  const formatBits = ((formatData << 10) | remainder) ^ 0x5412;
  const formatBit = (index) => ((formatBits >>> index) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, formatBit(i));
  set(8, 7, formatBit(6));
  set(8, 8, formatBit(7));
  set(7, 8, formatBit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, formatBit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, formatBit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, formatBit(i));
  set(8, size - 8, true);

  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (let vertical = 0; vertical < size; vertical++) {
      const y = upward ? size - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset++) {
        const x = right - offset;
        if (matrix[y][x] !== null) continue;
        const codewordBit =
          bitIndex < codewords.length * 8
            ? (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1
            : 0;
        set(x, y, Boolean(codewordBit ^ Number((x + y) % 2 === 0)));
        bitIndex++;
      }
    }
    upward = !upward;
  }

  return matrix;
}

/**
 * Draw a standalone Model 2 QR code (byte mode, error correction L) into SVG.
 * The built-in encoder supports payloads up to QR version 6.
 * @param {SVGSVGElement|null} svg
 * @param {string} payload
 * @returns {boolean}
 */
export function renderQrCode(svg, payload) {
  if (!svg) return false;
  svg.replaceChildren();
  if (!payload) return false;

  const matrix = makeQrMatrix(payload);
  const quietZone = 4;
  const size = matrix.length + quietZone * 2;
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Single-use room invitation QR code");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("focusable", "false");

  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("width", String(size));
  background.setAttribute("height", String(size));
  background.setAttribute("fill", "#ffffff");
  svg.appendChild(background);

  let pathData = "";
  matrix.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) pathData += `M${x + quietZone},${y + quietZone}h1v1h-1z`;
    });
  });
  const modules = document.createElementNS("http://www.w3.org/2000/svg", "path");
  modules.setAttribute("d", pathData);
  modules.setAttribute("fill", "#06100c");
  svg.appendChild(modules);
  return true;
}
