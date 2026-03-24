#!/usr/bin/env python3
"""
chessmatrix.py — ChessMatrix 8×8 four-color 2D barcode codec

Format summary:
  • 8×8 grid; each cell is BLACK(0), RED(1), GREEN(2), or BLUE(3)
  • Border: L-shaped BLACK finder + alternating B/W timing strips
  • Interior: 6×6 = 36 cells
      – 4 corner cells = color calibration anchors (K, R, G, B)
      – 32 cells = encoded data
  • Data: 32 cells × 2 bits = 8 bytes raw
      – RS(8,4): 4 data bytes + 4 Reed-Solomon parity bytes
      – Net payload: 4 bytes (32 bits)
  • Error correction: corrects up to 2 symbol (byte) errors

Usage:
  grid = encode(b"\\xDE\\xAD\\xBE\\xEF")
  render_ascii(grid)
  render_image(grid, "code.png", cell_size=60)
  data = decode(grid)
"""

from __future__ import annotations
from typing import List, Tuple

# ─────────────────────────────────────────────────────────────────────────────
# Color constants
# ─────────────────────────────────────────────────────────────────────────────

K = 0   # BLACK
R = 1   # RED
G = 2   # GREEN
B = 3   # BLUE

COLOR_RGB: dict[int, tuple[int, int, int]] = {
    K: (10,  10,  10),
    R: (220, 40,  40),
    G: (40,  180, 40),
    B: (40,  40,  220),
}

COLOR_NAME  = {K: "K", R: "R", G: "G", B: "B"}
COLOR_ANSI  = {K: "\033[40m", R: "\033[41m", G: "\033[42m", B: "\033[44m"}
RESET_ANSI  = "\033[0m"

# White (timing/quiet) displayed as light gray in ASCII
WHITE_ANSI  = "\033[47m"

# ─────────────────────────────────────────────────────────────────────────────
# Grid constants
# ─────────────────────────────────────────────────────────────────────────────

SIZE = 8

# Calibration anchor positions → their fixed colors
ANCHORS: dict[Tuple[int, int], int] = {
    (1, 1): K,
    (1, 6): R,
    (6, 1): G,
    (6, 6): B,
}

# Data cell positions in read order (row-major, anchors excluded)
DATA_CELLS: List[Tuple[int, int]] = [
    (row, col)
    for row in range(1, 7)
    for col in range(1, 7)
    if (row, col) not in ANCHORS
]
assert len(DATA_CELLS) == 32

# ─────────────────────────────────────────────────────────────────────────────
# GF(256) arithmetic
# Primitive polynomial: x^8 + x^4 + x^3 + x^2 + 1  (0x11D)
# ─────────────────────────────────────────────────────────────────────────────

_PRIM = 0x11D

def _build_gf_tables() -> Tuple[List[int], List[int]]:
    exp = [0] * 512
    log = [0] * 256
    x = 1
    for i in range(255):
        exp[i] = x
        log[x] = i
        x <<= 1
        if x & 0x100:
            x ^= _PRIM
    for i in range(255, 512):
        exp[i] = exp[i - 255]
    return exp, log

_EXP, _LOG = _build_gf_tables()


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def _gf_pow(x: int, n: int) -> int:
    if x == 0:
        return 0
    return _EXP[(_LOG[x] * n) % 255]


def _gf_inv(x: int) -> int:
    if x == 0:
        raise ZeroDivisionError("Cannot invert zero in GF(256)")
    return _EXP[255 - _LOG[x]]


def _poly_scale(p: List[int], k: int) -> List[int]:
    return [_gf_mul(c, k) for c in p]


def _poly_add(p: List[int], q: List[int]) -> List[int]:
    # Pad shorter polynomial with leading zeros
    if len(p) < len(q):
        p = [0] * (len(q) - len(p)) + p
    elif len(q) < len(p):
        q = [0] * (len(p) - len(q)) + q
    return [a ^ b for a, b in zip(p, q)]


def _poly_mul(p: List[int], q: List[int]) -> List[int]:
    r = [0] * (len(p) + len(q) - 1)
    for i, pi in enumerate(p):
        for j, qj in enumerate(q):
            r[i + j] ^= _gf_mul(pi, qj)
    return r


def _poly_eval(poly: List[int], x: int) -> int:
    """Evaluate polynomial at x using Horner's method (big-endian coefficients)."""
    y = 0
    for coef in poly:
        y = _gf_mul(y, x) ^ coef
    return y


# ─────────────────────────────────────────────────────────────────────────────
# Reed-Solomon RS(8, 4) over GF(256)
# 4 data bytes, 4 parity bytes; corrects up to 2 symbol errors
# ─────────────────────────────────────────────────────────────────────────────

_NSYM  = 4   # parity symbols
_NDATA = 4   # data symbols
_NRS   = _NDATA + _NSYM   # = 8


def _rs_generator() -> List[int]:
    """Compute generator polynomial g(x) = prod_{i=0}^{3}(x + α^i)."""
    g = [1]
    for i in range(_NSYM):
        g = _poly_mul(g, [1, _gf_pow(2, i)])
    return g


_GEN_POLY = _rs_generator()


def _rs_encode_codeword(data: bytes) -> bytes:
    """
    Systematic RS encode: returns data (4 bytes) + parity (4 bytes).
    Parity = remainder of (data * x^nsym) / generator.
    """
    if len(data) != _NDATA:
        raise ValueError(f"Expected {_NDATA} data bytes, got {len(data)}")

    # Work with a list; first _NDATA positions are data, rest are 0 (will become parity)
    msg = list(data) + [0] * _NSYM

    for i in range(_NDATA):
        coef = msg[i]
        if coef != 0:
            for j in range(1, len(_GEN_POLY)):
                msg[i + j] ^= _gf_mul(_GEN_POLY[j], coef)

    # Overwrite data portion (long division may have disturbed it; restore)
    parity = msg[_NDATA:]
    return bytes(list(data) + parity)


def _rs_syndromes(codeword: List[int]) -> List[int]:
    """Compute 4 syndromes S_i = codeword(α^i) for i in 0..3."""
    return [_poly_eval(codeword, _gf_pow(2, i)) for i in range(_NSYM)]


def _rs_berlekamp_massey(syndromes: List[int]) -> List[int]:
    """
    Berlekamp-Massey algorithm.
    Returns the error locator polynomial Λ(x) as a big-endian coefficient list,
    e.g. [1, σ1, σ2] for 2 errors.
    """
    n    = len(syndromes)
    C    = [1]   # current error locator polynomial (little-endian internally)
    B    = [1]   # previous C before last update
    L    = 0     # current number of errors
    m    = 1     # number of steps since last update
    b    = 1     # leading coeff of B at last update

    for i in range(n):
        # Compute discrepancy δ
        delta = syndromes[i]
        for j in range(1, L + 1):
            if j < len(C):
                delta ^= _gf_mul(C[j], syndromes[i - j])

        B_shifted = [0] * m + B   # x^m * B(x)

        if delta == 0:
            m += 1
        elif 2 * L <= i:
            # Update: C ← C - (δ/b) * x^m * B
            T = list(C)
            factor = _gf_mul(delta, _gf_inv(b))
            # Ensure C is long enough
            while len(C) < len(B_shifted):
                C.append(0)
            for j in range(len(B_shifted)):
                if j < len(C):
                    C[j] ^= _gf_mul(factor, B_shifted[j])
                else:
                    C.append(_gf_mul(factor, B_shifted[j]))
            L = i + 1 - L
            B = T
            b = delta
            m = 1
        else:
            factor = _gf_mul(delta, _gf_inv(b))
            while len(C) < len(B_shifted):
                C.append(0)
            for j in range(len(B_shifted)):
                if j < len(C):
                    C[j] ^= _gf_mul(factor, B_shifted[j])
                else:
                    C.append(_gf_mul(factor, B_shifted[j]))
            m += 1

    return C  # little-endian: C[0]=1, C[1]=σ1, C[2]=σ2, ...


def _rs_chien_search(err_loc: List[int], n: int) -> List[int]:
    """
    Chien search: find roots of err_loc in GF(256).
    Returns list of error positions (indices into codeword, 0-based from left).
    err_loc is little-endian: err_loc[0]=1, err_loc[1]=σ1, ...
    """
    errs = len(err_loc) - 1
    positions = []
    for i in range(n):
        # Evaluate err_loc at α^(-i) = α^(255-i)
        val = _poly_eval(err_loc[::-1], _gf_pow(2, 255 - i))
        if val == 0:
            positions.append(n - 1 - i)
    if len(positions) != errs:
        raise CorrectionError(
            f"Chien search found {len(positions)} roots, expected {errs}; "
            "too many errors to correct"
        )
    return positions


def _rs_forney(syndromes: List[int], err_loc: List[int], err_pos: List[int]) -> List[int]:
    """
    Forney algorithm: compute error magnitudes at given positions.
    err_loc is little-endian coefficient list.
    Returns list of error values aligned with err_pos.
    """
    # Error evaluator Ω(x) = S(x) * Λ(x) mod x^(2t)
    # S(x) in little-endian: s[0] + s[1]*x + ...
    s_poly = list(syndromes)  # [S0, S1, S2, S3]

    # Compute Ω = S * Λ mod x^nsym  (keep only first nsym terms)
    omega = _poly_mul(s_poly, err_loc)
    omega = omega[:_NSYM]  # truncate to x^(nsym-1)

    # Formal derivative of Λ (in GF(2), d/dx kills even powers)
    # Λ'[i] = Λ[i+1] if i is even (0-indexed), 0 if i is odd
    lam_prime = [err_loc[i + 1] if (i % 2 == 0) and (i + 1 < len(err_loc)) else 0
                 for i in range(len(err_loc) - 1)]
    if not lam_prime:
        lam_prime = [1]

    magnitudes = []
    for pos in err_pos:
        # X_i = α^{coef_pos} where coef_pos = n-1-pos (position from the right end)
        # The error locator roots are at X_i^{-1}, NOT α^pos
        coef_pos = _NRS - 1 - pos
        x_i     = _gf_pow(2, coef_pos)
        x_i_inv = _gf_inv(x_i)   # = α^{-coef_pos} = α^{255-coef_pos}

        # Evaluate Ω and Λ' at X_i^{-1}
        # omega and lam_prime are little-endian; reverse to use big-endian _poly_eval
        omega_val = _poly_eval(omega[::-1],     x_i_inv)
        lam_val   = _poly_eval(lam_prime[::-1], x_i_inv) if lam_prime else 1

        if lam_val == 0:
            raise CorrectionError("Derivative of error locator is zero at error position")

        # Forney formula (FCR=0): e_i = X_i * Ω(X_i^{-1}) / Λ'(X_i^{-1})
        magnitude = _gf_mul(x_i, _gf_mul(omega_val, _gf_inv(lam_val)))
        magnitudes.append(magnitude)

    return magnitudes


def _rs_decode_codeword(codeword: bytes) -> bytes:
    """
    RS decode: correct up to 2 errors, return 4 data bytes.
    Raises CorrectionError if more than 2 errors detected.
    """
    if len(codeword) != _NRS:
        raise ValueError(f"Expected {_NRS}-byte codeword, got {len(codeword)}")

    msg = list(codeword)

    # 1. Syndromes
    synd = _rs_syndromes(msg)
    if all(s == 0 for s in synd):
        return bytes(msg[:_NDATA])   # no errors

    # 2. Error locator polynomial
    err_loc = _rs_berlekamp_massey(synd)
    nerrs = len(err_loc) - 1
    if nerrs > _NSYM // 2:
        raise CorrectionError(
            f"Detected {nerrs} errors; maximum correctable is {_NSYM // 2}"
        )

    # 3. Chien search for error positions
    err_pos = _rs_chien_search(err_loc, _NRS)

    # 4. Forney algorithm for error magnitudes
    magnitudes = _rs_forney(synd, err_loc, err_pos)

    # 5. Correct errors
    for pos, mag in zip(err_pos, magnitudes):
        msg[pos] ^= mag

    # 6. Re-check syndromes
    synd_check = _rs_syndromes(msg)
    if any(s != 0 for s in synd_check):
        raise CorrectionError("Residual syndrome nonzero after correction; data unrecoverable")

    return bytes(msg[:_NDATA])


class CorrectionError(Exception):
    """Raised when RS decoding cannot correct the codeword."""


# ─────────────────────────────────────────────────────────────────────────────
# Grid type and helpers
# ─────────────────────────────────────────────────────────────────────────────

# A Grid is a list of 8 rows, each a list of 8 color values (0–3 or -1 for white)
Grid = List[List[int]]

_WHITE = -1   # sentinel: white (timing/quiet zone cell, not a data color)


def _empty_grid() -> Grid:
    return [[_WHITE] * SIZE for _ in range(SIZE)]


def _build_border(grid: Grid) -> None:
    """Write the fixed finder and timing borders into grid (in-place)."""
    for r in range(SIZE):
        # Left finder bar (column 0)
        grid[r][0] = K

        # Right timing strip (column 7)
        grid[r][7] = K if (r % 2 == 1) else _WHITE

    for c in range(SIZE):
        # Bottom finder bar (row 7)
        grid[7][c] = K

        # Top timing strip (row 0)
        grid[0][c] = K if (c % 2 == 0) else _WHITE


def _write_anchors(grid: Grid) -> None:
    """Write the four color calibration anchors into grid (in-place)."""
    for (row, col), color in ANCHORS.items():
        grid[row][col] = color


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def encode(data: bytes) -> Grid:
    """
    Encode 4 bytes of user data into a ChessMatrix 8×8 color grid.

    Args:
        data: Exactly 4 bytes of payload.

    Returns:
        An 8×8 Grid (list of lists of int).
        Color values: 0=BLACK, 1=RED, 2=GREEN, 3=BLUE, -1=WHITE (timing cells).

    Raises:
        ValueError: if data is not exactly 4 bytes.
    """
    if len(data) != _NDATA:
        raise ValueError(f"ChessMatrix payload must be exactly {_NDATA} bytes; got {len(data)}")

    # 1. RS encode: 4 data bytes → 8-byte codeword
    codeword = _rs_encode_codeword(data)

    # 2. Pack 8 bytes into 32 dibits (2-bit values)
    dibits: List[int] = []
    for byte_val in codeword:
        dibits.append((byte_val >> 6) & 0x03)
        dibits.append((byte_val >> 4) & 0x03)
        dibits.append((byte_val >> 2) & 0x03)
        dibits.append((byte_val >> 0) & 0x03)
    assert len(dibits) == 32

    # 3. Build grid
    grid = _empty_grid()
    _build_border(grid)
    _write_anchors(grid)

    for idx, (row, col) in enumerate(DATA_CELLS):
        grid[row][col] = dibits[idx]

    return grid


def decode(grid: Grid) -> bytes:
    """
    Decode a ChessMatrix 8×8 color grid to 4 bytes of user data.

    Applies Reed-Solomon error correction; can correct up to 2 symbol errors.

    Args:
        grid: An 8×8 Grid as produced by encode() or from a scanner.
              Color calibration should already be applied by the caller
              (i.e., the 32 data cells should contain values 0–3).

    Returns:
        4 bytes of user data.

    Raises:
        CorrectionError: if more than 2 symbol errors are detected.
        ValueError: if the grid is not 8×8.
    """
    if len(grid) != SIZE or any(len(row) != SIZE for row in grid):
        raise ValueError(f"Grid must be {SIZE}×{SIZE}")

    # 1. Extract the 32 data cell color values
    dibits = [grid[row][col] for row, col in DATA_CELLS]

    # 2. Pack dibits back into 8 bytes
    codeword_bytes = bytearray()
    for i in range(0, 32, 4):
        byte_val = (dibits[i]     << 6) | \
                   (dibits[i + 1] << 4) | \
                   (dibits[i + 2] << 2) | \
                   (dibits[i + 3])
        codeword_bytes.append(byte_val)

    # 3. RS decode → 4 data bytes
    return _rs_decode_codeword(bytes(codeword_bytes))


# ─────────────────────────────────────────────────────────────────────────────
# Rendering
# ─────────────────────────────────────────────────────────────────────────────

def render_ascii(grid: Grid, dark_bg: bool = False) -> None:
    """
    Print the ChessMatrix grid to stdout using ANSI color codes.
    Each cell is shown as two spaces (for a roughly square cell in most terminals).
    White timing cells are shown in light gray; color cells use their actual color.

    Args:
        dark_bg: If True, render the dark quiet zone variant (inverted outer border).
    """
    print()
    for r, row in enumerate(grid):
        line = ""
        for c, cell in enumerate(row):
            is_structural = (r == 0 or r == 7 or c == 0 or c == 7)
            if dark_bg and is_structural:
                # Invert: finder/timing BLACK → white, timing WHITE → black
                line += (COLOR_ANSI[K] if cell == _WHITE else WHITE_ANSI) + "  " + RESET_ANSI
            elif cell == _WHITE:
                line += WHITE_ANSI + "  " + RESET_ANSI
            else:
                line += COLOR_ANSI[cell] + "  " + RESET_ANSI
        print(line)
    print()

    # Legend
    print("  Legend:  ", end="")
    for color, name in [(K, "BLACK"), (R, "RED"), (G, "GREEN"), (B, "BLUE")]:
        print(f"{COLOR_ANSI[color]}  {RESET_ANSI} {name}   ", end="")
    print()
    print()


def render_image(grid: Grid, path: str, cell_size: int = 40, quiet_zone: int = 1,
                 dark_bg: bool = False) -> None:
    """
    Save the ChessMatrix grid as a PNG image.

    Args:
        grid:       8×8 color grid from encode().
        path:       Output file path (should end in .png).
        cell_size:  Pixel size of each cell (default 40 → 320×320 px symbol).
        quiet_zone: Width in cells of border around symbol (default 1).
        dark_bg:    If True, render the dark quiet zone variant (inverted outer border).

    Requires: Pillow  (pip install Pillow)
    """
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        raise ImportError("Pillow is required for render_image(). Install with: pip install Pillow")

    bg_rgb = (10, 10, 10) if dark_bg else (255, 255, 255)
    total = (SIZE + 2 * quiet_zone) * cell_size
    img = Image.new("RGB", (total, total), bg_rgb)
    draw = ImageDraw.Draw(img)

    for r, row in enumerate(grid):
        for c, cell in enumerate(row):
            x0 = (c + quiet_zone) * cell_size
            y0 = (r + quiet_zone) * cell_size
            x1 = x0 + cell_size - 1
            y1 = y0 + cell_size - 1

            is_structural = (r == 0 or r == 7 or c == 0 or c == 7)
            if dark_bg and is_structural:
                rgb = COLOR_RGB[K] if cell == _WHITE else (235, 235, 235)
            elif cell == _WHITE:
                rgb = (235, 235, 235)
            else:
                rgb = COLOR_RGB[cell]

            draw.rectangle([x0, y0, x1, y1], fill=rgb)

    img.save(path)
    print(f"Saved ChessMatrix image: {path}  ({total}×{total} px)")


def grid_to_string(grid: Grid) -> str:
    """Return a compact ASCII representation (no ANSI), useful for debugging."""
    rows = []
    for row in grid:
        rows.append("".join("." if c == _WHITE else COLOR_NAME.get(c, "?") for c in row))
    return "\n".join(rows)


def print_codeword_info(data: bytes) -> None:
    """Debug helper: print data bytes, parity bytes, and cell layout."""
    codeword = _rs_encode_codeword(data)
    print(f"Data bytes  : {' '.join(f'{b:02X}' for b in data)}")
    print(f"RS parity   : {' '.join(f'{b:02X}' for b in codeword[_NDATA:])}")
    print(f"Full codeword: {' '.join(f'{b:02X}' for b in codeword)}")
    dibits = []
    for byte_val in codeword:
        dibits += [(byte_val >> 6) & 3, (byte_val >> 4) & 3,
                   (byte_val >> 2) & 3, byte_val & 3]
    print(f"Dibits      : {''.join(str(d) for d in dibits)}")
    print(f"Cell colors : {''.join(COLOR_NAME[d] for d in dibits)}")


# ─────────────────────────────────────────────────────────────────────────────
# CLI / demo
# ─────────────────────────────────────────────────────────────────────────────

def _demo() -> None:
    import sys

    # Pick data from argv or use default
    if len(sys.argv) > 1:
        raw = sys.argv[1]
        data = raw.encode() if len(raw) <= 4 else bytes.fromhex(raw)
        if len(data) != 4:
            print(f"Error: payload must be exactly 4 bytes (got {len(data)})")
            sys.exit(1)
    else:
        data = b"\xDE\xAD\xBE\xEF"

    print(f"\n── ChessMatrix demo ─────────────────────────────────────────")
    print(f"Payload: {data.hex().upper()}  ({data!r})")

    print_codeword_info(data)

    grid = encode(data)

    print(f"\nASCII grid (K=black R=red G=green B=blue .=white):")
    print(grid_to_string(grid))
    print()

    render_ascii(grid)

    # Decode clean
    recovered = decode(grid)
    assert recovered == data, f"Clean decode failed: {recovered!r} != {data!r}"
    print(f"✓ Clean decode:    {recovered.hex().upper()}")

    # Test error correction: corrupt 2 data cells
    import copy
    grid_err = copy.deepcopy(grid)
    # Corrupt first and last data cells
    pos0 = DATA_CELLS[0]
    pos1 = DATA_CELLS[15]
    grid_err[pos0[0]][pos0[1]] = (grid[pos0[0]][pos0[1]] + 1) % 4
    grid_err[pos1[0]][pos1[1]] = (grid[pos1[0]][pos1[1]] + 2) % 4
    recovered_err = decode(grid_err)
    assert recovered_err == data, f"Error correction failed: {recovered_err!r} != {data!r}"
    print(f"✓ 2-error corrected decode: {recovered_err.hex().upper()}")

    # Save image
    try:
        outpath = "chessmatrix_demo.png"
        render_image(grid, outpath, cell_size=60)
    except ImportError:
        print("(Pillow not installed — skipping PNG output)")

    print("\n── Done ────────────────────────────────────────────────────────\n")


if __name__ == "__main__":
    _demo()
