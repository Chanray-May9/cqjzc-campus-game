"""Crop named regions of a reference photo and upscale them for close study.

    blender -b --factory-startup -P crop_ref.py -- <in.jpg> <outdir> <zoom> <name:x0,y0,x1,y1> ...
"""
import os
import sys

import bpy
import numpy as np

argv = sys.argv[sys.argv.index("--") + 1:]
SRC = argv[0]
OUTDIR = argv[1]
ZOOM = float(argv[2])
REGIONS = argv[3:]

os.makedirs(OUTDIR, exist_ok=True)

img = bpy.data.images.load(SRC)
W, H = img.size
buf = np.zeros(W * H * 4, dtype=np.float32)
img.pixels.foreach_get(buf)
arr = buf.reshape(H, W, 4)[::-1]          # top-down

for spec in REGIONS:
    name, box = spec.split(":", 1)
    x0, y0, x1, y1 = (int(v) for v in box.split(","))
    x0, x1 = max(0, x0), min(W, x1)
    y0, y1 = max(0, y0), min(H, y1)
    tile = arr[y0:y1, x0:x1]
    h, w = tile.shape[:2]
    oh, ow = int(h * ZOOM), int(w * ZOOM)
    ys = (np.arange(oh) * h // oh)
    xs = (np.arange(ow) * w // ow)
    big = tile[np.ix_(ys, xs)]
    out = bpy.data.images.new("c_" + name, width=ow, height=oh, alpha=True)
    out.pixels.foreach_set(big[::-1].ravel())
    out.filepath_raw = os.path.join(OUTDIR, name + ".png")
    out.file_format = "PNG"
    out.save()
    print("%-12s src[%d:%d, %d:%d] -> %dx%d" % (name, x0, x1, y0, y1, ow, oh))
print("src %dx%d" % (W, H))
