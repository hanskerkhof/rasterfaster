"""Orthographic assembly drawing (SVG): top, front and right view of a RASTERFASTER document.

Each part is drawn as feature lines (sharp edges, silhouette and open boundaries) in its document colour on a 20 mm grid.
Lines that belong only to faces turned away from the viewer are dashed. There is no occlusion between parts.
"""
from typing import Callable
from xml.sax.saxutils import escape

import numpy as np

import export3mf

gridMm = 20
margin = 24.0
viewGap = 36.0
sharpAngleDegrees = 25.0
legendWidth = 150.0

# view name -> (viewer direction, horizontal axis, vertical axis, axis labels); +Z up everywhere
views = {
    "Top": (np.array([0.0, 0.0, 1.0]), 0, 1, ("X", "Y")),
    "Front": (np.array([0.0, -1.0, 0.0]), 0, 2, ("X", "Z")),
    "Right": (np.array([1.0, 0.0, 0.0]), 1, 2, ("Y", "Z")),
}


def feature_edges(vertices: np.ndarray, triangles: np.ndarray, toViewer: np.ndarray):
    """Returns (visible, hidden) arrays of vertex index pairs, shape (k, 2)."""
    count = len(triangles)
    corners = vertices[triangles]
    normals = np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0])
    lengths = np.linalg.norm(normals, axis=1)
    normals = normals / np.where(lengths > 1e-12, lengths, 1.0)[:, None]
    facing = normals @ toViewer

    edges = np.stack([triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]], axis=1).reshape(-1, 2)
    face = np.repeat(np.arange(count), 3)
    low, high = edges.min(axis=1), edges.max(axis=1)
    key = low.astype(np.int64) * len(vertices) + high
    order = np.argsort(key, kind="stable")
    sortedKey = key[order]
    starts = np.concatenate([[0], np.flatnonzero(np.diff(sortedKey)) + 1])
    counts = np.diff(np.concatenate([starts, [len(sortedKey)]]))
    first = order[starts]

    keep = np.zeros(len(starts), dtype=bool)
    front = np.zeros(len(starts), dtype=bool)
    firstFace = face[first]

    open_ = counts == 1  # boundary of an open mesh
    keep[open_] = True
    front[open_] = facing[firstFace[open_]] > 1e-9

    pair = counts == 2
    secondFace = face[order[starts[pair] + 1]]
    f1, f2 = firstFace[pair], secondFace
    sharp = (normals[f1] * normals[f2]).sum(axis=1) < np.cos(np.radians(sharpAngleDegrees))
    s1, s2 = facing[f1] > 1e-9, facing[f2] > 1e-9
    silhouette = s1 != s2
    keep[pair] = sharp | silhouette
    front[pair] = s1 | s2

    keep[counts > 2] = True  # non-manifold: show it
    front[counts > 2] = True

    pairs = np.stack([low[first], high[first]], axis=1)
    return pairs[keep & front], pairs[keep & ~front]


def segments(points: np.ndarray, pairs: np.ndarray, toSvg: Callable[[np.ndarray], np.ndarray]) -> np.ndarray:
    """Projected edges as integer 0.1 mm coordinates (x1, y1, x2, y2), endpoints ordered, end-on and duplicate edges removed."""
    if len(pairs) == 0:
        return np.zeros((0, 4), dtype=np.int64)
    a = np.rint(toSvg(points[pairs[:, 0]]) * 10).astype(np.int64)
    b = np.rint(toSvg(points[pairs[:, 1]]) * 10).astype(np.int64)
    swap = (a[:, 0] > b[:, 0]) | ((a[:, 0] == b[:, 0]) & (a[:, 1] > b[:, 1]))
    a[swap], b[swap] = b[swap].copy(), a[swap].copy()
    flat = np.concatenate([a, b], axis=1)
    flat = flat[(a != b).any(axis=1)]  # edges seen end-on collapse to a point
    return np.unique(flat, axis=0)


def without(segs: np.ndarray, other: np.ndarray) -> np.ndarray:
    """Rows of `segs` that are not in `other`."""
    if len(segs) == 0 or len(other) == 0:
        return segs
    void = np.dtype((np.void, segs.dtype.itemsize * 4))
    known = np.isin(np.ascontiguousarray(segs).view(void).ravel(), np.ascontiguousarray(other).view(void).ravel())
    return segs[~known]


def path_data(segs: np.ndarray) -> str:
    return "".join(f"M{x1 / 10:g} {y1 / 10:g}L{x2 / 10:g} {y2 / 10:g}" for x1, y1, x2, y2 in segs.tolist())


def build_svg(document: dict, load_stl: Callable[[str], bytes]) -> str:
    items = document["items"]
    if not items:
        raise ValueError("document has no items")
    meshes = {path: export3mf.read_stl(load_stl(path)) for path in dict.fromkeys(item["path"] for item in items)}
    placements = export3mf.place_assembly(items, meshes, 0.0, centre=False)
    worlds = [meshes[item["path"]].vertices @ p.rotation.T + p.translation for item, p in zip(items, placements)]

    low = np.min([w.min(axis=0) for w in worlds], axis=0)
    high = np.max([w.max(axis=0) for w in worlds], axis=0)
    size = high - low
    # view origin (top-left corner in the drawing) in mm
    origin = {
        "Top": (margin, margin),
        "Front": (margin, margin + size[1] + viewGap),
        "Right": (margin + size[0] + viewGap, margin + size[1] + viewGap),
    }
    viewSize = {"Top": (size[0], size[1]), "Front": (size[0], size[2]), "Right": (size[1], size[2])}
    width = margin * 2 + size[0] + viewGap + max(size[1], legendWidth)
    height = margin * 2 + size[1] + viewGap + size[2]

    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.1f}mm" height="{height:.1f}mm" viewBox="0 0 {width:.1f} {height:.1f}" font-family="Helvetica, Arial, sans-serif">',
        f"<title>{escape(document['name'])}</title>",
        f'<rect width="{width:.1f}" height="{height:.1f}" fill="#ffffff"/>',
        '<style>.grid{stroke:#d9dce2;stroke-width:.5;vector-effect:non-scaling-stroke}.edge{fill:none;stroke-width:1.1;vector-effect:non-scaling-stroke;stroke-linecap:round}'
        ".hidden{stroke-dasharray:3 2;stroke-width:.7;opacity:.55}.frame{fill:none;stroke:#8a8f9b;stroke-width:.8;vector-effect:non-scaling-stroke}"
        ".label{font-size:6px;fill:#222;text-anchor:middle}.cap{font-size:7px;font-weight:700;fill:#333}.dim{font-size:5px;fill:#666}</style>",
    ]
    for name, (_, uAxis, vAxis, (uName, vName)) in views.items():
        ox, oy = origin[name]
        w, h = viewSize[name]
        uLow, vLow = low[uAxis], low[vAxis]

        def to_svg(p: np.ndarray, ox=ox, oy=oy, h=h, uAxis=uAxis, vAxis=vAxis, uLow=uLow, vLow=vLow) -> np.ndarray:
            return np.stack([ox + (p[:, uAxis] - uLow), oy + h - (p[:, vAxis] - vLow)], axis=1)

        out.append(f'<g id="{name.lower()}">')
        grid = []
        firstU = np.ceil(uLow / gridMm) * gridMm
        for u in np.arange(firstU, uLow + w + 1e-6, gridMm):
            grid.append(f"M{ox + u - uLow:.1f} {oy:.1f}V{oy + h:.1f}")
        firstV = np.ceil(vLow / gridMm) * gridMm
        for v in np.arange(firstV, vLow + h + 1e-6, gridMm):
            grid.append(f"M{ox:.1f} {oy + h - (v - vLow):.1f}H{ox + w:.1f}")
        out.append(f'<path class="grid" d="{"".join(grid)}"/>')
        out.append(f'<rect class="frame" x="{ox:.1f}" y="{oy:.1f}" width="{w:.1f}" height="{h:.1f}"/>')
        out.append(f'<text class="cap" x="{ox:.1f}" y="{oy - 6:.1f}">{name}</text>')
        out.append(f'<text class="dim" x="{ox + w:.1f}" y="{oy - 6:.1f}" text-anchor="end">{uName} {w:.0f} mm</text>')
        out.append(f'<text class="dim" x="{ox - 4:.1f}" y="{oy + h / 2:.1f}" text-anchor="middle" transform="rotate(-90 {ox - 4:.1f} {oy + h / 2:.1f})">{vName} {h:.0f} mm</text>')

        for index, (item, world) in enumerate(zip(items, worlds), start=1):
            mesh = meshes[item["path"]]
            visible, hidden = feature_edges(world, mesh.triangles, views[name][0])
            colour = f'#{item["color"]:06x}'
            visibleSegs = segments(world, visible, to_svg)
            hiddenPath, visiblePath = path_data(without(segments(world, hidden, to_svg), visibleSegs)), path_data(visibleSegs)
            out.append(f'<g id="{name.lower()}-{index}" data-part="{escape(item["name"], {chr(34): "&quot;"})}" stroke="{colour}">')
            if hiddenPath:
                out.append(f'<path class="edge hidden" d="{hiddenPath}"/>')
            if visiblePath:
                out.append(f'<path class="edge" d="{visiblePath}"/>')
            centre = to_svg(((world.min(axis=0) + world.max(axis=0)) / 2)[None, :])[0]
            out.append(f'<text class="label" x="{centre[0]:.1f}" y="{centre[1] + 2:.1f}">{index}</text>')
            out.append("</g>")
        out.append("</g>")

    # legend: numbered parts, same numbers as the labels
    lx, ly = margin + size[0] + viewGap, margin
    out.append(f'<g id="legend"><text class="cap" x="{lx:.1f}" y="{ly:.1f}">{escape(document["name"])}</text>')
    for index, item in enumerate(items, start=1):
        y = ly + 12 + (index - 1) * 9
        out.append(f'<rect x="{lx:.1f}" y="{y - 5:.1f}" width="6" height="6" fill="#{item["color"]:06x}"/>')
        out.append(f'<text x="{lx + 10:.1f}" y="{y:.1f}" font-size="5.5" fill="#222">{index}  {escape(item["name"])}</text>')
    out.append(f'<text class="dim" x="{lx:.1f}" y="{ly + 16 + len(items) * 9:.1f}">Overall {size[0]:.0f} × {size[1]:.0f} × {size[2]:.0f} mm · grid {gridMm} mm · dashed = hidden</text></g>')
    out.append("</svg>")
    return "\n".join(out)
