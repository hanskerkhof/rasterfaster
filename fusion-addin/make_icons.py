#!/usr/bin/env python3
"""Draws the three command icons into AddInRasterfasterLocalF3D/resources/<command>/ (16x16, 32x32 and @2x/64x64 PNGs, the names Fusion looks for).
Run it again after changing a drawing: python3 make_icons.py   (needs Pillow)"""
from pathlib import Path

from PIL import Image, ImageDraw

out = Path(__file__).parent / "AddInRasterfasterLocalF3D" / "resources"
size = 512  # drawn big, then scaled down
blue, dark, paper, folderColor, folderDark, green = (47, 111, 237), (60, 66, 80), (250, 250, 252), (240, 180, 60), (205, 140, 30), (52, 168, 83)


def arrow(draw, x, top, bottom, down, color, width=44, head=96):
    draw.line([(x, top), (x, bottom)], fill=color, width=width)
    tip = bottom if down else top
    step = -head if down else head
    draw.polygon([(x - head, tip + step), (x + head, tip + step), (x, tip)], fill=color)


def sheet(draw):
    draw.polygon([(110, 40), (330, 40), (410, 120), (410, 430), (110, 430)], fill=paper, outline=dark)
    draw.line([(110, 40), (330, 40), (410, 120), (410, 430), (110, 430), (110, 40)], fill=dark, width=18, joint="curve")
    draw.polygon([(330, 40), (330, 120), (410, 120)], fill=(210, 214, 222), outline=dark)


def folder(draw, fill):
    draw.rounded_rectangle([40, 120, 470, 440], radius=36, fill=fill, outline=dark, width=18)
    draw.polygon([(40, 150), (40, 110), (80, 80), (210, 80), (250, 120), (250, 150)], fill=fill, outline=dark)


def save(draw):  # a sheet with a blue arrow down onto a tray: a file goes onto the disk
    sheet(draw)
    arrow(draw, 260, 150, 330, True, blue)
    draw.line([(150, 400), (370, 400)], fill=blue, width=40)


def open_(draw):  # an open folder with a green arrow up
    folder(draw, folderColor)
    arrow(draw, 255, 190, 400, False, green, width=48, head=100)


def folder_icon(draw):
    folder(draw, folderColor)
    draw.rounded_rectangle([40, 230, 470, 440], radius=36, fill=folderDark, outline=dark, width=18)


for name, drawing in (("save", save), ("open", open_), ("folder", folder_icon)):
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    drawing(ImageDraw.Draw(image))
    target = out / name
    target.mkdir(parents=True, exist_ok=True)
    for file, pixels in (("16x16.png", 16), ("16x16@2x.png", 32), ("32x32.png", 32), ("32x32@2x.png", 64), ("64x64.png", 64)):
        image.resize((pixels, pixels), Image.LANCZOS).save(target / file)
print("icons written to", out)
