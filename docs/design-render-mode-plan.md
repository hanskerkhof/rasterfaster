# Design / Render mode: plan

Two modes for the 3D view. **Design** (today): every part has its own colour to tell parts apart while editing. **Render**: what the picture will look like: render colours, finishes, the studio's background and ground.

## Decided

- Per part, Render mode can set: a **colour**, a **finish** (Satin PLA = today's look, Metal, Transparent, Mirror for the fun of a mirror Utah teapot) and **hidden in Render mode**.
- A part without its own render colour uses its design colour. Nothing changes until a part is overridden.
- The mode is switched with **Design | Render** in the top toolbar (plus a key).
- Render mode shows the render colours, and the Blender studio's own background and ground (the dark gradient world and dark matte floor).
- Renders (quick and HD) and the Blender file use the render colours and finishes. **3MF, SVG and BOM keep the design colours** (they are for editing and printing).
- **Do not render** stays a global flag as it is today. Hiding in Render mode is a separate, per-mode flag.

## Data

Per part, optional, kept in the document (versions, document file, clipboard, undo):

```
item.render = { color?: number | null, finish?: 'satin' | 'metal' | 'glass' | 'mirror' | null, hidden?: boolean }
```

The mode itself is a view setting (remembered per browser), not part of the document. A saved view also remembers it.

## Phases (each one is a release and usable on its own)

1. **Data and the switch.** `item.render` in the backend model, the store, versions, the document file and paste; `mode` signal; the Design | Render toggle and key; Render mode shows the studio background and ground in the 3D view. Nothing editable yet. Tests for the model and the switch.
2. **Colours in the view.** In Render mode the colour tools (menu flyout, palette, groups) edit the render colour; the 3D view and the part list draw render colours; "Reset render colour" and "Copy design colour". Saved views remember the mode.
3. **Finishes and hiding.** A Finish menu per part (Satin PLA, Metal, Transparent, Mirror) with a believable approximation in the 3D view; "Hide in Render mode".
4. **Render pipeline.** The glTF / Blender export and the renders read render colours, finishes (metallic, transmission, mirror) and the hidden flag; quick render, HD, `.blend`, and the image library note record the mode. Tests on the Blender script. Demo: a mirror teapot.

## Assumptions to confirm

- The mode key: `Tab` (free today; ⌥D, ⌥M and ⌥1 – 6 are taken).
- If you chose a background or ground colour in the Render dialog, Render mode shows that colour; without one, the studio default.
- "Hide in Render mode" removes the part from the view and from the render and the `.blend`; **Do not render** keeps the part in the scene (for focus and the lamp) but undrawn.
