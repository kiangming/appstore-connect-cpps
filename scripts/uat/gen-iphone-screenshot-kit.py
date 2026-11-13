#!/usr/bin/env python3
"""
Generate the UAT image kit for arc [CPP-bulkimport-iphone-screenshot-sizes]
(docs/cpp-management/uat-iphone-screenshot-sizes.md).

Pure standard library (zlib + struct): no Pillow / ImageMagick needed.
Every image is an RGB 8-bit PNG, no alpha, 72 dpi, with its size, its Apple
screen group and the API display type it must land in printed on it (5x7
bitmap font). Same image format as scripts/uat/gen-ipad-screenshot-kit.py.

Kit A follows IPHONE_SCREENSHOT_SPECS in lib/cpp/screenshot-specs.ts row by
row (group order, then size order inside the group). If a row of that table
changes, change GROUPS here (KIT_A is derived from it) AND SLOT_BY_GROUP in
lib/cpp/uat-iphone-kit.test.ts (a test ties the two together), then
regenerate.

Usage (from the repo root):
    python3 -I scripts/uat/gen-iphone-screenshot-kit.py [out_dir]
Default out_dir: docs/cpp-management/uat-iphone-screenshot-sizes
"""
import os
import struct
import sys
import zlib

CPP = "UAT iPhone Sizes"
LOCALE = "en-US"
DEVICE = "iphone"

# One background colour per group (white text on top).
BLUE, TEAL, GREEN, OLIVE = (0, 90, 200), (0, 120, 130), (0, 130, 70), (110, 110, 0)
ORANGE, BROWN, PURPLE, MAGENTA = (200, 110, 0), (130, 70, 30), (110, 50, 160), (170, 0, 110)
RED, GREY = (190, 20, 20), (90, 90, 90)

# (slug, group printed, display type printed, background, sizes in spec order)
GROUPS = [
    ("di-large", "DYNAMIC ISLAND (LARGE)", "APP_IPHONE_67", BLUE,
     [(1260, 2736), (2736, 1260), (1290, 2796), (2796, 1290), (1320, 2868), (2868, 1320)]),
    ("faceid-large", "FACE ID (LARGE)", "APP_IPHONE_65", TEAL,
     [(1284, 2778), (2778, 1284), (1242, 2688), (2688, 1242)]),
    ("di-medium", "DYNAMIC ISLAND (MEDIUM)", "APP_IPHONE_61", GREEN,
     [(1179, 2556), (2556, 1179), (1206, 2622), (2622, 1206)]),
    ("faceid-medium", "FACE ID (MEDIUM)", "APP_IPHONE_58", OLIVE,
     [(1170, 2532), (2532, 1170), (1125, 2436), (2436, 1125), (1080, 2340), (2340, 1080)]),
    ("hb-large", "HOME BUTTON (LARGE)", "APP_IPHONE_55", ORANGE,
     [(1242, 2208), (2208, 1242)]),
    ("hb-medium", "HOME BUTTON (MEDIUM)", "APP_IPHONE_47", BROWN,
     [(750, 1334), (1334, 750)]),
    ("hb-4in", 'HOME BUTTON (4")', "APP_IPHONE_40", PURPLE,
     [(640, 1096), (640, 1136), (1136, 600), (1136, 640)]),
    ("hb-3.5in", 'HOME BUTTON (3.5")', "APP_IPHONE_35", MAGENTA,
     [(640, 920), (640, 960), (960, 600), (960, 640)]),
]

# (file name without ".png", w, h, printed lines, background)
KIT_A = []
for _slug, _group, _type, _bg, _sizes in GROUPS:
    for _w, _h in _sizes:
        KIT_A.append((f"{len(KIT_A) + 1:02d}-{_slug}-{_w}x{_h}", _w, _h,
                      [f"{_w} X {_h}", _group, f"API: {_type}"], _bg))

KIT_B = [
    ("97-DUO-1398x2034", 1398, 2034, ["1398 X 2034", "IPHONE DUO", "MUST BE BLOCKED"], RED),
    ("98-IPAD-2064x2752", 2064, 2752, ["2064 X 2752", 'IPAD 13" IN IPHONE/', "MUST BE BLOCKED"], RED),
    ("99-WRONG-1200x2400", 1200, 2400, ["1200 X 2400", "WRONG SIZE", "MUST BE BLOCKED"], GREY),
]

KIT_C = [
    ("01-di-medium-only-1179x2556", 1179, 2556,
     ["1179 X 2556", "DYNAMIC ISLAND (MEDIUM)", "API: APP_IPHONE_61"], GREEN),
    ("02-di-medium-only-1206x2622", 1206, 2622,
     ["1206 X 2622", "DYNAMIC ISLAND (MEDIUM)", "API: APP_IPHONE_61"], GREEN),
]

KITS = (("A-import", KIT_A), ("B-blocked", KIT_B), ("C-warning", KIT_C))

# 5x7 bitmap font: 7 rows of 5 columns, '#' = ink. Copied from the iPad script,
# plus F H J Q V Y ( ) _ (full A-Z).
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
    "F": ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#    "],
    "G": [" ### ", "#   #", "#    ", "# ###", "#   #", "#   #", " ####"],
    "H": ["#   #", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
    "I": [" ### ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
    "J": ["  ###", "   # ", "   # ", "   # ", "   # ", "#  # ", " ##  "],
    "K": ["#   #", "#  # ", "# #  ", "##   ", "# #  ", "#  # ", "#   #"],
    "L": ["#    ", "#    ", "#    ", "#    ", "#    ", "#    ", "#####"],
    "M": ["#   #", "## ##", "# # #", "# # #", "#   #", "#   #", "#   #"],
    "N": ["#   #", "##  #", "# # #", "#  ##", "#   #", "#   #", "#   #"],
    "O": [" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
    "P": ["#### ", "#   #", "#   #", "#### ", "#    ", "#    ", "#    "],
    "Q": [" ### ", "#   #", "#   #", "#   #", "# # #", "#  # ", " ## #"],
    "R": ["#### ", "#   #", "#   #", "#### ", "# #  ", "#  # ", "#   #"],
    "S": [" ####", "#    ", "#    ", " ### ", "    #", "    #", "#### "],
    "T": ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "],
    "U": ["#   #", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
    "V": ["#   #", "#   #", "#   #", "#   #", "#   #", " # # ", "  #  "],
    "W": ["#   #", "#   #", "#   #", "# # #", "# # #", "## ##", "#   #"],
    "X": ["#   #", "#   #", " # # ", "  #  ", " # # ", "#   #", "#   #"],
    "Y": ["#   #", "#   #", " # # ", "  #  ", "  #  ", "  #  ", "  #  "],
    "Z": ["#####", "    #", "   # ", "  #  ", " #   ", "#    ", "#####"],
    '"': [" # # ", " # # ", " # # ", "     ", "     ", "     ", "     "],
    ".": ["     ", "     ", "     ", "     ", "     ", " ##  ", " ##  "],
    "/": ["    #", "    #", "   # ", "  #  ", " #   ", "#    ", "#    "],
    ":": ["     ", " ##  ", " ##  ", "     ", " ##  ", " ##  ", "     "],
    "-": ["     ", "     ", "     ", "#####", "     ", "     ", "     "],
    "(": ["   # ", "  #  ", " #   ", " #   ", " #   ", "  #  ", "   # "],
    ")": [" #   ", "  #  ", "   # ", "   # ", "   # ", "  #  ", " #   "],
    "_": ["     ", "     ", "     ", "     ", "     ", "     ", "#####"],
}


def check_font():
    """Fail BEFORE writing anything if a printed character has no glyph."""
    missing = sorted({ch for _, items in KITS for *_, lines, _bg in items for line in lines for ch in line} - set(FONT))
    if missing:
        sys.exit(f"no glyph for: {missing!r}")
    for ch, glyph in FONT.items():
        assert len(glyph) == 7 and all(len(r) == 5 for r in glyph), f"bad glyph {ch!r}"


def render(w, h, lines, bg):
    """Return the raw rows (each a bytes of w*3) — background with white text."""
    cols = max(len(line) for line in lines) * 6
    scale = max(1, int(0.8 * w / cols))
    line_h = 9 * scale
    top = (h - line_h * len(lines)) // 2
    assert top >= 0, f"text does not fit {w}x{h}"
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
    check_font()
    assert len(KIT_A) == 32, len(KIT_A)
    out = sys.argv[1] if len(sys.argv) > 1 else "docs/cpp-management/uat-iphone-screenshot-sizes"
    for kit, items in KITS:
        folder = os.path.join(out, kit, CPP, LOCALE, "screenshots", DEVICE)
        os.makedirs(folder, exist_ok=True)
        for name, w, h, lines, bg in items:
            path = os.path.join(folder, f"{name}.png")
            write_png(path, w, h, render(w, h, lines, bg))
            print(path)


if __name__ == "__main__":
    main()
