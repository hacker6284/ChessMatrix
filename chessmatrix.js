/**
 * chessmatrix.js — ChessMatrix 8×8 four-color barcode codec, renderer, and scanner
 *
 * Exports:
 *   lettersToBytes(str)            6-letter string → Uint8Array(4)
 *   bytesToLetters(bytes)          Uint8Array(4)   → 6-letter string
 *   buildGrid(bytes)               Uint8Array(4)   → Int8Array(64) row-major grid
 *   renderGrid(grid, canvas, sz)   draw grid on an HTMLCanvasElement
 *   ChessMatrixScanner             semi-guided camera scanner class
 *   CorrectionError                thrown when RS decoding fails
 */

// ── GF(256) arithmetic ────────────────────────────────────────────────────────
// Primitive polynomial: x^8 + x^4 + x^3 + x^2 + 1  (0x11D)
// Matches the Python implementation exactly.

const _PRIM = 0x11D;
const _EXP  = new Uint8Array(512);   // anti-log table, doubled to avoid mod
const _LOG  = new Uint8Array(256);   // log table

(function _buildGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    _EXP[i] = x;
    _LOG[x]  = i;
    x <<= 1;
    if (x & 0x100) x ^= _PRIM;
    x &= 0xFF;
  }
  for (let i = 255; i < 512; i++) _EXP[i] = _EXP[i - 255];
})();

function _gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return _EXP[_LOG[a] + _LOG[b]];
}
function _gfPow(x, n)  { return x === 0 ? 0 : _EXP[(_LOG[x] * n) % 255]; }
function _gfInv(x)     {
  if (x === 0) throw new CorrectionError('Cannot invert zero in GF(256)');
  return _EXP[255 - _LOG[x]];
}

// Polynomial helpers — all use big-endian coefficient arrays (highest degree first),
// EXCEPT within the Berlekamp-Massey algorithm which uses little-endian internally.

function _polyScale(p, k)  { return p.map(c => _gfMul(c, k)); }

function _polyAdd(p, q) {
  const len = Math.max(p.length, q.length);
  const pp  = Array(len - p.length).fill(0).concat(Array.from(p));
  const qq  = Array(len - q.length).fill(0).concat(Array.from(q));
  return pp.map((v, i) => v ^ qq[i]);
}

function _polyMul(p, q) {
  const r = Array(p.length + q.length - 1).fill(0);
  for (let i = 0; i < p.length; i++)
    for (let j = 0; j < q.length; j++)
      r[i + j] ^= _gfMul(p[i], q[j]);
  return r;
}

/** Evaluate polynomial at x using Horner's method. Expects big-endian coefficients. */
function _polyEval(poly, x) {
  let y = 0;
  for (const c of poly) y = _gfMul(y, x) ^ c;
  return y;
}

// ── RS(8,4) codec over GF(256) ────────────────────────────────────────────────
// 4 data bytes + 4 parity bytes; corrects up to 2 symbol errors.
// Generator roots: α^0, α^1, α^2, α^3  (α = 2).

const _NSYM  = 4;
const _NDATA = 4;
const _NRS   = 8;

const _GEN_POLY = (() => {
  let g = [1];
  for (let i = 0; i < _NSYM; i++) g = _polyMul(g, [1, _gfPow(2, i)]);
  return g;
})();

/** Systematic RS encode: Uint8Array(4) → Uint8Array(8) */
function rsEncode(data) {
  if (data.length !== _NDATA)
    throw new Error(`Expected ${_NDATA} data bytes, got ${data.length}`);
  const msg = [...data, 0, 0, 0, 0];
  for (let i = 0; i < _NDATA; i++) {
    const coef = msg[i];
    if (coef !== 0)
      for (let j = 1; j < _GEN_POLY.length; j++)
        msg[i + j] ^= _gfMul(_GEN_POLY[j], coef);
  }
  return new Uint8Array([...data, ...msg.slice(_NDATA)]);
}

/** Compute 4 syndromes. codeword is an Array or Uint8Array. */
function _rsSyndromes(codeword) {
  return Array.from({ length: _NSYM }, (_, i) =>
    _polyEval(Array.from(codeword), _gfPow(2, i))
  );
}

/**
 * Berlekamp-Massey algorithm.
 * Returns error locator polynomial in LITTLE-ENDIAN format:
 *   [1, σ1, σ2, …]  (index 0 = constant term = 1)
 */
function _rsBerlekampMassey(syndromes) {
  let C = [1], B = [1], L = 0, m = 1, b = 1;
  for (let i = 0; i < syndromes.length; i++) {
    // Discrepancy
    let delta = syndromes[i];
    for (let j = 1; j <= L; j++)
      if (j < C.length) delta ^= _gfMul(C[j], syndromes[i - j]);

    const Bsh = Array(m).fill(0).concat(B);   // x^m · B(x)

    if (delta === 0) {
      m++;
    } else if (2 * L <= i) {
      const T = [...C];
      const f = _gfMul(delta, _gfInv(b));
      while (C.length < Bsh.length) C.push(0);
      for (let j = 0; j < Bsh.length; j++) C[j] ^= _gfMul(f, Bsh[j]);
      L = i + 1 - L; B = T; b = delta; m = 1;
    } else {
      const f = _gfMul(delta, _gfInv(b));
      while (C.length < Bsh.length) C.push(0);
      for (let j = 0; j < Bsh.length; j++) C[j] ^= _gfMul(f, Bsh[j]);
      m++;
    }
  }
  return C;  // little-endian
}

/**
 * Chien search: find roots of errLoc (little-endian) in GF(256).
 * Returns error positions (0-based from left) within a codeword of length n.
 */
function _rsChienSearch(errLoc, n) {
  const errs = errLoc.length - 1;
  const pos  = [];
  // Reverse errLoc (little→big endian) before calling _polyEval
  const errLocBE = [...errLoc].reverse();
  for (let i = 0; i < n; i++) {
    if (_polyEval(errLocBE, _gfPow(2, 255 - i)) === 0)
      pos.push(n - 1 - i);
  }
  if (pos.length !== errs)
    throw new CorrectionError(
      `Chien search found ${pos.length} roots, expected ${errs}; too many errors to correct`
    );
  return pos;
}

/**
 * Forney algorithm: compute error magnitudes.
 * syndromes, errLoc are little-endian lists; errPos are positions from _rsChienSearch.
 */
function _rsForney(syndromes, errLoc, errPos) {
  // Error evaluator Ω = S·Λ mod x^nsym  (little-endian product, truncated)
  const omega = _polyMul(syndromes, errLoc).slice(0, _NSYM);

  // Formal derivative Λ' in GF(2): kills even-degree terms
  const lamPrime = Array.from({ length: errLoc.length - 1 }, (_, i) =>
    (i % 2 === 0 && i + 1 < errLoc.length) ? errLoc[i + 1] : 0
  );
  if (lamPrime.length === 0) lamPrime.push(1);

  // Reverse (little→big endian) for _polyEval
  const omegaBE    = [...omega].reverse();
  const lamPrimeBE = [...lamPrime].reverse();

  return errPos.map(p => {
    const coefPos = _NRS - 1 - p;
    const xi      = _gfPow(2, coefPos);
    const xiInv   = _gfInv(xi);

    const omVal  = _polyEval(omegaBE,    xiInv);
    const lamVal = _polyEval(lamPrimeBE, xiInv);

    if (lamVal === 0)
      throw new CorrectionError('Derivative of error locator is zero at error position');

    return _gfMul(xi, _gfMul(omVal, _gfInv(lamVal)));
  });
}

/** RS decode: Uint8Array(8) → Uint8Array(4), or throws CorrectionError. */
function rsDecode(codeword) {
  if (codeword.length !== _NRS)
    throw new Error(`Expected ${_NRS}-byte codeword, got ${codeword.length}`);

  const msg  = Array.from(codeword);
  const synd = _rsSyndromes(msg);
  if (synd.every(s => s === 0)) return new Uint8Array(msg.slice(0, _NDATA));

  const errLoc = _rsBerlekampMassey(synd);
  const nerrs  = errLoc.length - 1;
  if (nerrs > _NSYM / 2)
    throw new CorrectionError(
      `Detected ${nerrs} errors; maximum correctable is ${_NSYM / 2}`
    );

  const errPos = _rsChienSearch(errLoc, _NRS);
  const mags   = _rsForney(synd, errLoc, errPos);
  for (let k = 0; k < errPos.length; k++) msg[errPos[k]] ^= mags[k];

  const check = _rsSyndromes(msg);
  if (check.some(s => s !== 0))
    throw new CorrectionError('Residual syndrome nonzero; data unrecoverable');

  return new Uint8Array(msg.slice(0, _NDATA));
}

export class CorrectionError extends Error {
  constructor(msg) { super(msg); this.name = 'CorrectionError'; }
}

// ── Grid constants ────────────────────────────────────────────────────────────

export const SIZE  = 8;
export const K = 0, R = 1, G = 2, B = 3;
const WHITE = -1;

// Anchor positions → fixed color (interior corners of the 6×6 data zone)
const _ANCHORS = new Map([
  ['1,1', K],  // BLACK
  ['1,6', R],  // RED
  ['6,1', G],  // GREEN
  ['6,6', B],  // BLUE
]);

// Data cells in row-major order, anchors excluded — matches Python DATA_CELLS exactly
export const DATA_CELLS = [];
for (let row = 1; row < 7; row++)
  for (let col = 1; col < 7; col++)
    if (!_ANCHORS.has(`${row},${col}`))
      DATA_CELLS.push([row, col]);
// assert DATA_CELLS.length === 32

// ── Letter codec ──────────────────────────────────────────────────────────────
// Each letter A-Z maps to 0-25, packed as 5-bit values MSB-first.
// 6 × 5 = 30 bits, padded with 2 zero bits → 32 bits = 4 bytes.

/** 6-letter string (A-Z) → Uint8Array(4).  Missing letters are padded with 'A'. */
export function lettersToBytes(str) {
  const s  = str.toUpperCase().padEnd(6, 'A').slice(0, 6);
  const vs = [...s].map(c => c.charCodeAt(0) - 65);  // 0–25 each
  const [v0, v1, v2, v3, v4, v5] = vs;
  return new Uint8Array([
    (v0 << 3)         | (v1 >> 2),
    ((v1 & 3) << 6)   | (v2 << 1)  | (v3 >> 4),
    ((v3 & 0xF) << 4) | (v4 >> 1),
    ((v4 & 1) << 7)   | (v5 << 2),
  ]);
}

/** Uint8Array(4) → 6-letter string. */
export function bytesToLetters(bytes) {
  const [b0, b1, b2, b3] = bytes;
  const vs = [
    (b0 >> 3) & 0x1F,
    ((b0 & 7) << 2)   | (b1 >> 6),
    (b1 >> 1) & 0x1F,
    ((b1 & 1) << 4)   | (b2 >> 4),
    ((b2 & 0xF) << 1) | (b3 >> 7),
    (b3 >> 2) & 0x1F,
  ];
  return vs.map(v => String.fromCharCode(65 + (v % 26))).join('');
}

// ── Grid builder ──────────────────────────────────────────────────────────────

/**
 * Encode 4 bytes into an 8×8 ChessMatrix grid.
 * Returns Int8Array(64) in row-major order.
 * Color values: 0=BLACK 1=RED 2=GREEN 3=BLUE  -1=WHITE (structural cells)
 */
export function buildGrid(bytes) {
  const cw = rsEncode(bytes);

  // 8 bytes → 32 dibits (2-bit color values), MSB first
  const dibits = [];
  for (const byte of cw) {
    dibits.push((byte >> 6) & 3, (byte >> 4) & 3, (byte >> 2) & 3, byte & 3);
  }

  const grid = new Int8Array(64).fill(WHITE);
  const set  = (r, c, v) => { grid[r * SIZE + c] = v; };

  // Left finder bar  (col 0, all rows)
  for (let r = 0; r < SIZE; r++) set(r, 0, K);
  // Bottom finder bar (row 7, all cols)
  for (let c = 0; c < SIZE; c++) set(7, c, K);
  // Top timing strip  (row 0: even=BLACK, odd=WHITE)
  for (let c = 0; c < SIZE; c++) set(0, c, c % 2 === 0 ? K : WHITE);
  // Right timing strip (col 7: even rows=WHITE, odd rows=BLACK)
  for (let r = 0; r < SIZE; r++) set(r, 7, r % 2 === 1 ? K : WHITE);

  // Color calibration anchors
  for (const [key, color] of _ANCHORS) {
    const [row, col] = key.split(',').map(Number);
    set(row, col, color);
  }

  // Data cells (32 cells, row-major)
  for (let i = 0; i < DATA_CELLS.length; i++) {
    const [row, col] = DATA_CELLS[i];
    set(row, col, dibits[i]);
  }

  return grid;
}

// ── Canvas renderer ───────────────────────────────────────────────────────────

const _COLOR_RGB = {
  [K]:     [10,  10,  10],
  [R]:     [220, 40,  40],
  [G]:     [40,  180, 40],
  [B]:     [40,  40,  220],
  [WHITE]: [235, 235, 235],
};

/**
 * Draw an 8×8 ChessMatrix grid onto an HTMLCanvasElement.
 * @param {Int8Array}         grid      - 64-element row-major grid from buildGrid()
 * @param {HTMLCanvasElement} canvas    - target canvas
 * @param {number}            cellSize  - pixels per cell (default 40)
 * @param {boolean}           darkBg   - if true, render the dark quiet zone variant
 */
export function renderGrid(grid, canvas, cellSize = 40, darkBg = false) {
  const quiet = 1;  // 1-cell quiet zone border
  const total = (SIZE + 2 * quiet) * cellSize;
  canvas.width  = total;
  canvas.height = total;
  const ctx = canvas.getContext('2d');

  // Quiet zone background
  ctx.fillStyle = darkBg ? '#0a0a0a' : '#ebebeb';
  ctx.fillRect(0, 0, total, total);

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = grid[r * SIZE + c];
      const isStructural = (r === 0 || r === 7 || c === 0 || c === 7);
      let rgb;
      if (darkBg && isStructural) {
        // Invert structural cells: finder/timing BLACK → white, timing WHITE → black
        rgb = cell === WHITE ? [10, 10, 10] : [235, 235, 235];
      } else {
        rgb = _COLOR_RGB[cell] ?? _COLOR_RGB[WHITE];
      }
      const [rr, gg, bb] = rgb;
      ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
      ctx.fillRect(
        (c + quiet) * cellSize,
        (r + quiet) * cellSize,
        cellSize,
        cellSize
      );
    }
  }
}

// ── Scanner ───────────────────────────────────────────────────────────────────
// Semi-guided mode: a fixed alignment box is drawn on the camera feed.
// The user positions the printed code to fill the box; cell colors are sampled
// at the corresponding video pixel coordinates.

/**
 * @example
 * const scanner = new ChessMatrixScanner({
 *   videoEl:  document.getElementById('video'),
 *   canvasEl: document.getElementById('scan-canvas'),
 *   onDecode: (letters) => console.log(letters),
 *   onStatus: (msg, state) => statusEl.textContent = msg,
 * });
 * await scanner.start();
 */
export class ChessMatrixScanner {
  constructor({ videoEl, canvasEl, onDecode, onStatus }) {
    this._video     = videoEl;
    this._canvas    = canvasEl;
    this._onDecode  = onDecode;
    this._onStatus  = onStatus;
    this._running   = false;
    this._raf       = null;
    this._tick      = 0;
    this._streak    = 0;       // consecutive successful decode frames
    this._lastResult = null;   // last string passed to onDecode
    this._resetTimer = null;   // re-arm after a successful decode
    this._offscreen = document.createElement('canvas');
  }

  /** Start the camera and begin scanning. Returns a promise. */
  async start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' },
                 width:  { ideal: 1280 },
                 height: { ideal: 720  } },
      });
      this._video.srcObject = stream;
      await new Promise((res, rej) => {
        this._video.addEventListener('loadedmetadata', res, { once: true });
        setTimeout(() => rej(new Error('Camera timeout')), 8000);
      });
      await this._video.play();

      // Size display canvas 1:1 with video; CSS scales it down
      this._canvas.width  = this._video.videoWidth;
      this._canvas.height = this._video.videoHeight;
      this._offscreen.width  = this._video.videoWidth;
      this._offscreen.height = this._video.videoHeight;

      this._running = true;
      this._loop();
      this._status('Align barcode with box', 'idle');
    } catch (err) {
      const msg =
        err.name === 'NotAllowedError'  ? 'Camera access denied — please allow camera permission and try again.' :
        err.name === 'NotFoundError'    ? 'No camera found on this device.' :
        err.name === 'NotSupportedError'? 'Camera not supported. This page requires HTTPS.' :
                                          `Camera error: ${err.message}`;
      this._status(msg, 'error');
      throw err;
    }
  }

  /** Stop the camera and scanning loop. */
  stop() {
    this._running = false;
    if (this._raf)         cancelAnimationFrame(this._raf);
    if (this._resetTimer)  clearTimeout(this._resetTimer);
    if (this._video.srcObject) {
      this._video.srcObject.getTracks().forEach(t => t.stop());
      this._video.srcObject = null;
    }
  }

  _status(msg, state) {
    if (this._onStatus) this._onStatus(msg, state);
  }

  _loop() {
    if (!this._running) return;
    this._raf = requestAnimationFrame(() => this._loop());
    this._tick++;
    if (this._tick % 4 !== 0) return;   // ~15 decode attempts/sec at 60fps
    this._processFrame();
  }

  _processFrame() {
    const vw = this._video.videoWidth;
    const vh = this._video.videoHeight;
    if (!vw || !vh) return;

    // Draw current video frame to offscreen canvas for pixel sampling
    const offCtx = this._offscreen.getContext('2d', { willReadFrequently: true });
    offCtx.drawImage(this._video, 0, 0);
    const imageData = offCtx.getImageData(0, 0, vw, vh);

    // Alignment box: centered, 65% of the shorter video dimension
    const boxSize = Math.floor(Math.min(vw, vh) * 0.65);
    const box = {
      x:    Math.floor((vw - boxSize) / 2),
      y:    Math.floor((vh - boxSize) / 2),
      size: boxSize,
    };

    // Sample once, then try standard variant first, dark quiet zone second
    const raw = this._sampleColors(imageData, box, vw);
    let decoded = null;
    for (const darkBg of [false, true]) {
      try {
        const gridCells = this._classifyColors(raw, darkBg);
        const codeword  = this._extractCodeword(gridCells);
        const bytes     = rsDecode(codeword);
        decoded         = bytesToLetters(bytes);
        break;
      } catch (_) {
        /* CorrectionError or transient noise — try next variant */
      }
    }

    // Require 2 consecutive identical decodes before firing onDecode
    if (decoded !== null) {
      this._streak++;
      if (this._streak >= 2 && decoded !== this._lastResult) {
        this._lastResult = decoded;
        if (this._onDecode) this._onDecode(decoded);
        // Auto-reset after 3 s so the same code can be scanned again
        if (this._resetTimer) clearTimeout(this._resetTimer);
        this._resetTimer = setTimeout(() => { this._lastResult = null; }, 3000);
      }
      this._status(`Decoded: ${decoded}`, 'success');
    } else {
      this._streak = 0;
      this._status('Scanning…', 'scanning');
    }

    // Draw composite frame: video + overlay
    const ctx = this._canvas.getContext('2d');
    ctx.drawImage(this._video, 0, 0);
    this._drawOverlay(ctx, box, decoded !== null);
  }

  /**
   * Sample 3×3 averaged RGB at the center of each of the 64 grid cells
   * within the given box (video pixel coordinates).
   */
  _sampleColors(imageData, box, videoWidth) {
    const cellSize = box.size / SIZE;
    const data     = imageData.data;
    const out      = [];

    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        const cx = Math.round(box.x + (col + 0.5) * cellSize);
        const cy = Math.round(box.y + (row + 0.5) * cellSize);

        let sr = 0, sg = 0, sb = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const px = cx + dx, py = cy + dy;
            if (px >= 0 && px < videoWidth && py >= 0) {
              const i = (py * videoWidth + px) * 4;
              sr += data[i]; sg += data[i + 1]; sb += data[i + 2];
              n++;
            }
          }
        }
        out.push({ r: sr / n, g: sg / n, b: sb / n });
      }
    }
    return out;   // 64-element array, row-major [0]=top-left cell
  }

  /**
   * Classify raw color samples into a full grid using anchor calibration.
   * Returns Int8Array(64) with -1 for structural cells, 0-3 for data cells.
   * @param {boolean} darkBg - if true, use dark quiet zone white reference ((0,0) instead of (0,1))
   */
  _classifyColors(raw, darkBg = false) {
    // Anchor samples (known colors at fixed positions — unchanged in both variants)
    const refs = {
      [K]: raw[1 * SIZE + 1],   // (1,1) = BLACK
      [R]: raw[1 * SIZE + 6],   // (1,6) = RED
      [G]: raw[6 * SIZE + 1],   // (6,1) = GREEN
      [B]: raw[6 * SIZE + 6],   // (6,6) = BLUE
    };

    // White reference: (0,1) is WHITE in standard mode; (0,0) is WHITE in dark mode
    const wrCell = darkBg ? raw[0 * SIZE + 0] : raw[0 * SIZE + 1];
    const wr = wrCell.r || 1;
    const wg = wrCell.g || 1;
    const wb = wrCell.b || 1;

    // Normalize references
    const nref = {};
    for (const c of [K, R, G, B]) {
      nref[c] = {
        r: (refs[c].r / wr) * 255,
        g: (refs[c].g / wg) * 255,
        b: (refs[c].b / wb) * 255,
      };
    }

    const classify = ({ r, g, b }) => {
      // Very dark pixel → always black (avoids dark-blue/dark-red confusion)
      if (Math.max(r, g, b) < 55) return K;

      // Normalize against white reference
      const nr = (r / wr) * 255;
      const ng = (g / wg) * 255;
      const nb = (b / wb) * 255;

      let best = K, bestD = Infinity;
      for (const c of [K, R, G, B]) {
        const { r: cr, g: cg, b: cb } = nref[c];
        // Weight green channel slightly less (more susceptible to warm-light confusion)
        const d = (nr - cr) ** 2 + (ng - cg) ** 2 * 0.64 + (nb - cb) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
      return best;
    };

    // Build classified grid; structural cells get their known values
    const grid = new Int8Array(64).fill(WHITE);
    const set  = (r, c, v) => { grid[r * SIZE + c] = v; };

    for (let r = 0; r < SIZE; r++) set(r, 0, K);
    for (let c = 0; c < SIZE; c++) set(7, c, K);
    for (let c = 0; c < SIZE; c++) set(0, c, c % 2 === 0 ? K : WHITE);
    for (let r = 0; r < SIZE; r++) set(r, 7, r % 2 === 1 ? K : WHITE);
    for (const [key, color] of _ANCHORS) {
      const [row, col] = key.split(',').map(Number);
      set(row, col, color);
    }

    // Classify the 32 data cells
    for (const [row, col] of DATA_CELLS)
      set(row, col, classify(raw[row * SIZE + col]));

    return grid;
  }

  /** Pack 32 data cell color values into an 8-byte RS codeword. */
  _extractCodeword(grid) {
    const cw = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      const [r0, c0] = DATA_CELLS[i * 4];
      const [r1, c1] = DATA_CELLS[i * 4 + 1];
      const [r2, c2] = DATA_CELLS[i * 4 + 2];
      const [r3, c3] = DATA_CELLS[i * 4 + 3];
      cw[i] =
        (grid[r0 * SIZE + c0] << 6) |
        (grid[r1 * SIZE + c1] << 4) |
        (grid[r2 * SIZE + c2] << 2) |
        (grid[r3 * SIZE + c3]);
    }
    return cw;
  }

  /** Draw the alignment box overlay onto the display canvas context. */
  _drawOverlay(ctx, box, success) {
    const { x, y, size } = box;
    const cell = size / SIZE;

    ctx.save();

    // Outer box
    ctx.strokeStyle = success ? '#00e87a' : 'rgba(255,255,255,0.8)';
    ctx.lineWidth   = success ? 3 : 2;
    ctx.strokeRect(x, y, size, size);

    // Corner tick marks for alignment aid
    const tick = size * 0.07;
    ctx.strokeStyle = success ? '#00e87a' : 'rgba(255,255,255,0.95)';
    ctx.lineWidth   = 3;
    const corners = [
      [x,          y,          1,  1],
      [x + size,   y,         -1,  1],
      [x,          y + size,   1, -1],
      [x + size,   y + size,  -1, -1],
    ];
    for (const [cx, cy, sx, sy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx + sx * tick, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + sy * tick);
      ctx.stroke();
    }

    // Faint interior grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth   = 0.5;
    for (let i = 1; i < SIZE; i++) {
      ctx.beginPath(); ctx.moveTo(x + i * cell, y); ctx.lineTo(x + i * cell, y + size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y + i * cell); ctx.lineTo(x + size, y + i * cell); ctx.stroke();
    }

    // Anchor color hints (faint tinted cell overlays)
    const anchorHints = [
      { row: 1, col: 1, rgba: 'rgba(10,10,10,0.45)'   },
      { row: 1, col: 6, rgba: 'rgba(220,40,40,0.45)'  },
      { row: 6, col: 1, rgba: 'rgba(40,180,40,0.45)'  },
      { row: 6, col: 6, rgba: 'rgba(40,40,220,0.45)'  },
    ];
    for (const { row, col, rgba } of anchorHints) {
      ctx.fillStyle = rgba;
      ctx.fillRect(x + col * cell, y + row * cell, cell, cell);
    }

    ctx.restore();
  }
}

// ── Self-test (runs once at module load) ─────────────────────────────────────
// Verifies the RS codec against the Python demo test vector 0xDEADBEEF.
// Logs to console only; does not affect page behaviour.
(function _selfTest() {
  try {
    const data = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const cw   = rsEncode(data);
    // Expected codeword from Python: DE AD BE EF + 4 parity bytes
    const decoded = rsDecode(cw);
    const ok = decoded.every((v, i) => v === data[i]);
    if (!ok) {
      console.error('[ChessMatrix] RS self-test FAILED: clean round-trip mismatch');
      return;
    }

    // Test error correction: corrupt 2 bytes
    const cw2 = new Uint8Array(cw);
    cw2[0] = (cw2[0] + 1) & 0xFF;
    cw2[5] = (cw2[5] ^ 0x55) & 0xFF;
    const dec2 = rsDecode(cw2);
    const ok2  = dec2.every((v, i) => v === data[i]);
    if (!ok2) {
      console.error('[ChessMatrix] RS self-test FAILED: 2-error correction mismatch');
      return;
    }

    console.log('[ChessMatrix] RS self-test passed ✓');
  } catch (e) {
    console.error('[ChessMatrix] RS self-test threw:', e);
  }
})();
