// Minimal QR Code generator (byte mode) with no dependencies.
//
// Written for Golive so a room link can be shown as a QR code for
// desktop-to-phone handoff without sending the link to any third party.
// Supports error-correction levels L and M and versions 1..12 (more than
// enough for a URL). Exposes a global `QR` with `matrix(text, opts)` and
// `svg(text, opts)`.
//
// Algorithm follows ISO/IEC 18004. UMD-ish wrapper so it also loads in Node
// for tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.QR = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Total codewords (data + error correction) for versions 1..12.
  const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466];
  // Error-correction blocks and total EC codewords per version (1..12).
  const ECC = {
    L: {
      bit: 1,
      blocks: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4],
      ec: [7, 10, 15, 20, 26, 36, 40, 48, 60, 72, 80, 96],
    },
    M: {
      bit: 0,
      blocks: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8],
      ec: [10, 16, 26, 36, 48, 64, 72, 88, 110, 130, 150, 176],
    },
  };
  const MAX_VERSION = 12;

  // GF(256) arithmetic with the QR primitive polynomial 0x11D.
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
  }

  // Generator polynomial of the given degree (coefficients high -> low).
  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  // Reed-Solomon remainder of `data` (division by `gen`).
  function rsEncode(data, gen) {
    const ecLen = gen.length - 1;
    const res = new Uint8Array(ecLen);
    for (let d = 0; d < data.length; d++) {
      const factor = data[d] ^ res[0];
      res.copyWithin(0, 1);
      res[ecLen - 1] = 0;
      if (factor !== 0) {
        for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
      }
    }
    return res;
  }

  // Number of bits (position of the highest set bit + 1).
  function bchDigit(value) {
    let digit = 0;
    while (value !== 0) {
      digit++;
      value >>>= 1;
    }
    return digit;
  }

  function utf8Bytes(text) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
    // Fallback for very old runtimes.
    const out = [];
    for (let i = 0; i < text.length; i++) {
      let c = text.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return Uint8Array.from(out);
  }

  const EC_LEVEL = 0x537; // 15-bit format BCH generator
  const EC_LEVEL_MASK = 0x5412;
  const VERSION_POLY = 0x1f25; // 18-bit version BCH generator

  function formatBits(eccBit, mask) {
    const data = (eccBit << 3) | mask;
    let d = data << 10;
    while (bchDigit(d) - bchDigit(EC_LEVEL) >= 0) {
      d ^= EC_LEVEL << (bchDigit(d) - bchDigit(EC_LEVEL));
    }
    return ((data << 10) | d) ^ EC_LEVEL_MASK;
  }

  function versionBits(version) {
    let d = version << 12;
    while (bchDigit(d) - bchDigit(VERSION_POLY) >= 0) {
      d ^= VERSION_POLY << (bchDigit(d) - bchDigit(VERSION_POLY));
    }
    return (version << 12) | d;
  }

  function maskAt(pattern, i, j) {
    switch (pattern) {
      case 0: return (i + j) % 2 === 0;
      case 1: return i % 2 === 0;
      case 2: return j % 3 === 0;
      case 3: return (i + j) % 3 === 0;
      case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
      case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
      case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
      default: return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
    }
  }

  // --- penalty scores, used to pick the least "busy" mask ---
  function penalty1(modules, size) {
    let points = 0;
    const addRun = (run) => {
      if (run >= 5) points += 3 + (run - 5);
    };
    for (let i = 0; i < size; i++) {
      for (let axis = 0; axis < 2; axis++) {
        let run = 1;
        for (let j = 1; j < size; j++) {
          const cur = axis === 0 ? modules[i][j] : modules[j][i];
          const prev = axis === 0 ? modules[i][j - 1] : modules[j - 1][i];
          if (cur === prev) run++;
          else {
            addRun(run);
            run = 1;
          }
        }
        addRun(run);
      }
    }
    return points;
  }

  function penalty2(modules, size) {
    let points = 0;
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const a = modules[r][c];
        if (a === modules[r][c + 1] && a === modules[r + 1][c] && a === modules[r + 1][c + 1]) points++;
      }
    }
    return points * 3;
  }

  function penalty3(modules, size) {
    let points = 0;
    for (let r = 0; r < size; r++) {
      let bitsRow = 0;
      let bitsCol = 0;
      for (let c = 0; c < size; c++) {
        bitsRow = ((bitsRow << 1) & 0x7ff) | (modules[r][c] ? 1 : 0);
        if (c >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) points++;
        bitsCol = ((bitsCol << 1) & 0x7ff) | (modules[c][r] ? 1 : 0);
        if (c >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) points++;
      }
    }
    return points * 40;
  }

  function penalty4(modules, size) {
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (modules[r][c]) dark++;
    const k = Math.abs(Math.ceil((dark * 100) / (size * size) / 5) - 10);
    return k * 10;
  }

  function chooseVersion(byteLength, ecc) {
    for (let v = 1; v <= MAX_VERSION; v++) {
      const dataBits = (TOTAL_CODEWORDS[v - 1] - ecc.ec[v - 1]) * 8;
      const countBits = v <= 9 ? 8 : 16;
      if (4 + countBits + byteLength * 8 <= dataBits) return v;
    }
    return 0;
  }

  function build(text, opts) {
    opts = opts || {};
    const ecc = ECC[opts.ecc === "L" ? "L" : "M"];
    const bytes = utf8Bytes(String(text));

    const version = chooseVersion(bytes.length, ecc);
    if (!version) throw new Error("QR: data too long for supported versions");

    const totalCodewords = TOTAL_CODEWORDS[version - 1];
    const ecTotal = ecc.ec[version - 1];
    const dataCapacity = totalCodewords - ecTotal;
    const countBits = version <= 9 ? 8 : 16;

    // --- bit stream: mode + length + payload, terminator, padding ---
    const bits = [];
    const put = (value, length) => {
      for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };
    put(0b0100, 4); // byte mode
    put(bytes.length, countBits);
    for (let i = 0; i < bytes.length; i++) put(bytes[i], 8);
    const capacityBits = dataCapacity * 8;
    for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const dataCodewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      dataCodewords.push(byte);
    }
    let pad = 0;
    while (dataCodewords.length < dataCapacity) dataCodewords.push(pad++ % 2 ? 0x11 : 0xec);

    // --- split into blocks, add error correction, interleave ---
    const numBlocks = ecc.blocks[version - 1];
    const shortCount = numBlocks - (dataCapacity % numBlocks);
    const shortLen = Math.floor(dataCapacity / numBlocks);
    const ecPerBlock = ecTotal / numBlocks;

    const dataBlocks = [];
    const ecBlocks = [];
    const gen = rsGenerator(ecPerBlock);
    let offset = 0;
    for (let b = 0; b < numBlocks; b++) {
      const size = b < shortCount ? shortLen : shortLen + 1;
      const block = dataCodewords.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, gen));
    }

    const codewords = [];
    const maxLen = Math.max(shortLen + 1, shortLen);
    for (let i = 0; i < maxLen; i++) {
      for (let b = 0; b < numBlocks; b++) {
        if (i < dataBlocks[b].length) codewords.push(dataBlocks[b][i]);
      }
    }
    for (let i = 0; i < ecPerBlock; i++) {
      for (let b = 0; b < numBlocks; b++) codewords.push(ecBlocks[b][i]);
    }

    // --- matrix construction ---
    const size = version * 4 + 17;
    const modules = [];
    const reserved = [];
    for (let r = 0; r < size; r++) {
      modules.push(new Array(size).fill(false));
      reserved.push(new Array(size).fill(false));
    }
    const set = (r, c, dark, res) => {
      modules[r][c] = dark;
      if (res) reserved[r][c] = true;
    };

    // Finder patterns + separators.
    const finders = [[0, 0], [0, size - 7], [size - 7, 0]];
    for (let f = 0; f < finders.length; f++) {
      const row = finders[f][0];
      const col = finders[f][1];
      for (let r = -1; r <= 7; r++) {
        if (row + r < 0 || row + r >= size) continue;
        for (let c = -1; c <= 7; c++) {
          if (col + c < 0 || col + c >= size) continue;
          const dark = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
            (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
            (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          set(row + r, col + c, dark, true);
        }
      }
    }

    // Timing patterns.
    for (let r = 8; r < size - 8; r++) {
      set(r, 6, r % 2 === 0, true);
      set(6, r, r % 2 === 0, true);
    }

    // Alignment patterns.
    if (version >= 2) {
      const count = Math.floor(version / 7) + 2;
      const interval = size === 145 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2;
      const coords = [size - 7];
      for (let i = 1; i < count - 1; i++) coords[i] = coords[i - 1] - interval;
      coords.push(6);
      coords.reverse();
      for (let i = 0; i < coords.length; i++) {
        for (let j = 0; j < coords.length; j++) {
          if ((i === 0 && j === 0) || (i === 0 && j === coords.length - 1) ||
            (i === coords.length - 1 && j === 0)) continue;
          for (let r = -2; r <= 2; r++) {
            for (let c = -2; c <= 2; c++) {
              const dark = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
              set(coords[i] + r, coords[j] + c, dark, true);
            }
          }
        }
      }
    }

    // Format info (reserve with a dummy, rewritten after masking).
    function setupFormatInfo(mask) {
      const bits = formatBits(ecc.bit, mask);
      for (let i = 0; i < 15; i++) {
        const dark = ((bits >> i) & 1) === 1;
        if (i < 6) set(i, 8, dark, true);
        else if (i < 8) set(i + 1, 8, dark, true);
        else set(size - 15 + i, 8, dark, true);

        if (i < 8) set(8, size - i - 1, dark, true);
        else if (i < 9) set(8, 15 - i - 1 + 1, dark, true);
        else set(8, 15 - i - 1, dark, true);
      }
      set(size - 8, 8, true, true); // fixed dark module
    }
    setupFormatInfo(0);

    // Version info (versions 7+).
    if (version >= 7) {
      const bits = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >> i) & 1) === 1;
        const row = Math.floor(i / 3);
        const col = (i % 3) + size - 8 - 3;
        set(row, col, dark, true);
        set(col, row, dark, true);
      }
    }

    // Data modules, zigzag from bottom-right.
    (function setupData() {
      let inc = -1;
      let row = size - 1;
      let bitIndex = 7;
      let byteIndex = 0;
      for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col--;
        for (;;) {
          for (let c = 0; c < 2; c++) {
            if (!reserved[row][col - c]) {
              let dark = false;
              if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
              modules[row][col - c] = dark;
              bitIndex--;
              if (bitIndex === -1) {
                byteIndex++;
                bitIndex = 7;
              }
            }
          }
          row += inc;
          if (row < 0 || row >= size) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    })();

    function applyMask(pattern) {
      for (let col = 0; col < size; col++) {
        for (let row = 0; row < size; row++) {
          if (!reserved[row][col] && maskAt(pattern, row, col)) modules[row][col] = !modules[row][col];
        }
      }
    }

    // Pick the mask with the lowest penalty.
    let bestMask = 0;
    let bestPenalty = Infinity;
    for (let p = 0; p < 8; p++) {
      setupFormatInfo(p);
      applyMask(p);
      const penalty = penalty1(modules, size) + penalty2(modules, size) +
        penalty3(modules, size) + penalty4(modules, size);
      applyMask(p); // undo
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestMask = p;
      }
    }
    applyMask(bestMask);
    setupFormatInfo(bestMask);

    return { size, version, mask: bestMask, modules };
  }

  function svg(text, opts) {
    opts = opts || {};
    const margin = opts.margin == null ? 4 : opts.margin;
    const result = build(text, opts);
    const dim = result.size + margin * 2;
    let path = "";
    for (let r = 0; r < result.size; r++) {
      for (let c = 0; c < result.size; c++) {
        if (result.modules[r][c]) path += "M" + (c + margin) + " " + (r + margin) + "h1v1h-1z";
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + " " + dim +
      '" shape-rendering="crispEdges" role="img" aria-label="' + (opts.label || "QR code") + '">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="' + (opts.light || "#ffffff") + '"/>' +
      '<path d="' + path + '" fill="' + (opts.dark || "#0b0d11") + '"/></svg>';
  }

  return { build: build, svg: svg };
});
