#!/usr/bin/env python3
"""
Generate the UAT image kit for arc [CPP-bulkimport-ipad-screenshot-sizes]
(docs/cpp-management/uat-ipad-screenshot-sizes.md).

Pure standard library (zlib + struct): no Pillow / ImageMagick needed.
Every image is an RGB 8-bit PNG, no alpha, 72 dpi, with its size, its screen
group and the slot it must land in printed on it (5x7 bitmap font).

Usage (from the repo root):
    python3 -I scripts/uat/gen-ipad-screenshot-kit.py [out_dir]
Default out_dir: docs/cpp-management/uat-ipad-screenshot-sizes
"""
import os
import struct
import sys
import zlib

CPP = "UAT iPad Sizes"
LOCALE = "en-US"

# (file name prefix, w, h, group printed, slot it must land in, background RGB)
BLUE, GREEN, ORANGE, PURPLE, RED = (0, 90, 200), (0, 130, 70), (200, 110, 0), (110, 50, 160), (190, 20, 20)
KIT_A = [
    ("01-13in", 2064, 2752, '13"', '13"', BLUE),
    ("02-13in", 2752, 2064, '13"', '13"', BLUE),
    ("03-13in-or-12.9in", 2048, 2732, '13" / 12.9"', '13"', BLUE),
    ("04-13in-or-12.9in", 2732, 2048, '13" / 12.9"', '13"', BLUE),
    ("05-11in", 1488, 2266, '11"', '11"', GREEN),
    ("06-11in", 2266, 1488, '11"', '11"', GREEN),
    ("07-11in", 1512, 2316, '11"', '11"', GREEN),
    ("08-11in", 2316, 1512, '11"', '11"', GREEN),
    ("09-11in", 1668, 2420, '11"', '11"', GREEN),
    ("10-11in", 2420, 1668, '11"', '11"', GREEN),
    ("11-11in", 1668, 2388, '11"', '11"', GREEN),
    ("12-11in", 2388, 1668, '11"', '11"', GREEN),
    ("13-11in", 1640, 2360, '11"', '11"', GREEN),
    ("14-11in", 2360, 1640, '11"', '11"', GREEN),
    ("15-10.5in", 1668, 2224, '10.5"', '10.5"', ORANGE),
    ("16-10.5in", 2224, 1668, '10.5"', '10.5"', ORANGE),
    ("17-9.7in", 1536, 2008, '9.7"', '9.7"', PURPLE),
    ("18-9.7in", 1536, 2048, '9.7"', '9.7"', PURPLE),
    ("19-9.7in", 2048, 1496, '9.7"', '9.7"', PURPLE),
    ("20-9.7in", 2048, 1536, '9.7"', '9.7"', PURPLE),
    ("21-9.7in", 768, 1004, '9.7"', '9.7"', PURPLE),
    ("22-9.7in", 768, 1024, '9.7"', '9.7"', PURPLE),
    ("23-9.7in", 1024, 748, '9.7"', '9.7"', PURPLE),
    ("24-9.7in", 1024, 768, '9.7"', '9.7"', PURPLE),
]
KIT_B = [("99-WRONG", 1600, 2400, "WRONG SIZE", "BLOCKED", RED)]
KIT_C = [("01-11in-only", 1668, 2388, '11"', '11"', GREEN)]

# 5x7 bitmap font: 7 rows of 5 columns, '#' = ink.
FONT = {
    " ": ["     "] * 7,
    "0": [" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "],
    "1": ["  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
    "2": [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
    "3": ["#####", "   # ", "  #  ", "   # ", "    #", "#   #", " ### "],
    "4": ["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "],
    "5": ["#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "],
    "6": ["  ## ", " #   ", "#    ", "#### ", "#   #", "#   #", " ### "],
    "7": ["#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "],
    "8": [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
    "9": [" ### ", "#   #", "#   #", " ####", "    #", "   # ", " ##  "],
    "A": [" ### ", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
    "B": ["#### ", "#   #", "#   #", "#### ", "#   #", "#   #", "#### "],
    "C": [" ### ", "#   #", "#    ", "#    ", "#    ", "#   #", " ### "],
    "D": ["#### ", "#   #", "#   #", "#   #", "#   #", "#   #", "#### "],
    "E": ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#####"],
    "G": [" ### ", "#   #", "#    ", "# ###", "#   #", "#   #", " ####"],
    "I": [" ### ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
    "K": ["#   #", "#  # ", "# #  ", "##   ", "# #  ", "#  # ", "#   #"],
    "L": ["#    ", "#    ", "#    ", "#    ", "#    ", "#    ", "#####"],
    "M": ["#   #", "## ##", "# # #", "# # #", "#   #", "#   #", "#   #"],
    "N": ["#   #", "##  #", "# # #", "#  ##", "#   #", "#   #", "#   #"],
    "O": [" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
    "P": ["#### ", "#   #", "#   #", "#### ", "#    ", "#    ", "#    "],
    "R": ["#### ", "#   #", "#   #", "#### ", "# #  ", "#  # ", "#   #"],
    "S": [" ####", "#    ", "#    ", " ### ", "    #", "    #", "#### "],
    "T": ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "],
    "U": ["#   #", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
    "W": ["#   #", "#   #", "#   #", "# # #", "# # #", "## ##", "#   #"],
    "X": ["#   #", "#   #", " # # ", "  #  ", " # # ", "#   #", "#   #"],
    "Z": ["#####", "    #", "   # ", "  #  ", " #   ", "#    ", "#####"],
    '"': [" # # ", " # # ", " # # ", "     ", "     ", "     ", "     "],
    ".": ["     ", "     ", "     ", "     ", "     ", " ##  ", " ##  "],
    "/": ["    #", "    #", "   # ", "  #  ", " #   ", "#    ", "#    "],
    ":": ["     ", " ##  ", " ##  ", "     ", " ##  ", " ##  ", "     "],
    "-": ["     ", "     ", "     ", "#####", "     ", "     ", "     "],
}


def text_lines(w, h, group, slot):
    if slot == "BLOCKED":
        return [f"{w} X {h}", "WRONG SIZE", "MUST BE BLOCKED"]
    return [f"{w} X {h}", f"IPAD {group}", f"SLOT: {slot}"]


def render(w, h, lines, bg):
    """Return the raw rows (each a bytes of w*3) — background with white text."""
    cols = max(len(line) for line in lines) * 6
    scale = max(1, int(0.8 * w / cols))
    line_h = 9 * scale
    top = (h - line_h * len(lines)) // 2
    bg_row = bytes(bg) * w
    ink = bytes((255, 255, 255))
    rows = [bg_row] * h
    for li, line in enumerate(lines):
        line_w = len(line) * 6 * scale
        left = (w - line_w) // 2
        for gy in range(7):
            row = bytearray(bg_row)
            for ci, ch in enumerate(line):
                glyph = FONT[ch]
                for gx in range(5):
                    if glyph[gy][gx] == "#":
                        x0 = left + (ci * 6 + gx) * scale
                        row[x0 * 3:(x0 + scale) * 3] = ink * scale
            row = bytes(row)
            y0 = top + li * line_h + gy * scale
            for dy in range(scale):
                rows[y0 + dy] = row
    return rows


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path, w, h, rows):
    raw = bytearray()
    prev = None
    for row in rows:
        if prev is not None and row == prev:
            raw += b"\x02" + bytes(len(row))  # filter Up: identical row → zeros
        else:
            raw += b"\x00" + row
        prev = row
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))  # 8-bit RGB, no alpha
    png += chunk(b"pHYs", struct.pack(">IIB", 2835, 2835, 1))  # 72 dpi
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "docs/cpp-management/uat-ipad-screenshot-sizes"
    for kit, items in (("A-import", KIT_A), ("B-wrong-size", KIT_B), ("C-no-13in", KIT_C)):
        folder = os.path.join(out, kit, CPP, LOCALE, "screenshots", "ipad")
        os.makedirs(folder, exist_ok=True)
        for prefix, w, h, group, slot, bg in items:
            path = os.path.join(folder, f"{prefix}-{w}x{h}.png")
            write_png(path, w, h, render(w, h, text_lines(w, h, group, slot), bg))
            print(path)


if __name__ == "__main__":
    main()
