"""Draw docs/architecture/arch.svg, the system diagram in docs/architecture.md and the README.

Render arch.png from it at twice the size, e.g. with headless Chrome:
    google-chrome --headless --screenshot=arch.png --window-size=1720,760 --force-device-scale-factor=2 arch.svg
"""

from pathlib import Path

W, H = 1720, 760
TEAL, TEAL_BG = "#2f7d6d", "#eef6f4"
AMBER, AMBER_BG = "#b7801b", "#fff6e5"
IND, IND_BG = "#4f5db3", "#eef0fb"
INK, MUTED, LINE = "#1d2a31", "#5b6b74", "#4a5961"
out = []


def box(x, y, w, h, title, sub, stroke=TEAL, fill=TEAL_BG):
    out.append(
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{fill}" stroke="{stroke}" stroke-width="2"/>'
    )
    cy = y + h / 2
    out.append(f'<text x="{x + w / 2}" y="{cy - 4 if sub else cy + 6}" class="t">{title}</text>')
    if sub:
        out.append(f'<text x="{x + w / 2}" y="{cy + 18}" class="s">{sub}</text>')


def cyl(x, y, w, h, title, sub):
    e = 14
    out.append(
        f'<path d="M{x},{y + e} A{w / 2},{e} 0 0 1 {x + w},{y + e} V{y + h - e} A{w / 2},{e} 0 0 1 {x},{y + h - e} Z" fill="{AMBER_BG}" stroke="{AMBER}" stroke-width="2"/>'
    )
    out.append(
        f'<path d="M{x},{y + e} A{w / 2},{e} 0 0 0 {x + w},{y + e}" fill="none" stroke="{AMBER}" stroke-width="2"/>'
    )
    cy = y + h / 2 + 6
    out.append(f'<text x="{x + w / 2}" y="{cy - 4}" class="t">{title}</text>')
    out.append(f'<text x="{x + w / 2}" y="{cy + 18}" class="s">{sub}</text>')


def arrow(d, both=False):
    start = ' marker-start="url(#a2)"' if both else ""
    out.append(f'<path d="{d}" fill="none" stroke="{LINE}" stroke-width="2.2" marker-end="url(#a)"{start}/>')


def label(x, y, text):
    w = len(text) * 7.6 + 18
    out.append(f'<rect x="{x - w / 2}" y="{y - 14}" width="{w}" height="24" rx="12" fill="#ffffff" stroke="#d5dde1"/>')
    out.append(f'<text x="{x}" y="{y + 3}" class="l">{text}</text>')


box(40, 70, 190, 80, "Ray-Ban Meta", "glasses")
box(350, 70, 210, 80, "Phone app", "iOS · SceneCapture")
box(740, 70, 230, 80, "Upload service", "signs + verifies uploads")
cyl(1150, 58, 230, 104, "SpacetimeDB", "registry + live sync")
cyl(740, 298, 230, 104, "Object storage", "R2 · videos + scenes")
box(1450, 310, 220, 80, "GPU worker", "Runpod · memreplay", IND, IND_BG)
out.append(
    '<rect x="350" y="560" width="1030" height="160" rx="16" fill="#f7fafb" stroke="#c6d2d7" stroke-width="1.6" stroke-dasharray="6 5"/>'
)
out.append('<text x="372" y="588" class="g">Viewers · one web app (apps/web), runs in each device\'s browser</text>')
box(380, 610, 290, 80, "Quest Browser", "WebXR")
box(720, 610, 290, 80, "Phone browser", "touch + walk pad")
box(1060, 610, 290, 80, "Desktop browser", "mouse + keyboard")

arrow("M230,110 H344")
label(290, 92, "I1 · DAT SDK")
arrow("M560,110 H734")
label(647, 92, "I2 · presign, complete")
arrow("M970,110 H1144")
label(1057, 92, "I3 · create_memory")
arrow("M455,150 V350 H734")
label(560, 350, "I2 · PUT video")
arrow("M1560,310 V110 H1386")
label(1560, 220, "I4 · poll, set status")
arrow("M1450,350 H976")
label(1090, 350, "I5 · GET video, PUT scene")
arrow("M855,560 V420")
label(855, 488, "I6 · load scene files")
arrow("M1265,560 V182", both=True)
label(1265, 488, "I7 · party, clock, grabs, poses")

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<defs>
<marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{LINE}"/></marker>
<marker id="a2" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M10,0 L0,5 L10,10 z" fill="{LINE}"/></marker>
<style>
text {{ font-family: Inter, -apple-system, "Helvetica Neue", Arial, sans-serif; text-anchor: middle; fill: {INK}; }}
.t {{ font-size: 18px; font-weight: 600; }}
.s {{ font-size: 13.5px; fill: {MUTED}; }}
.l {{ font-size: 13.5px; font-weight: 500; fill: #2c3a41; }}
.g {{ font-size: 14px; font-weight: 600; fill: {MUTED}; text-anchor: start; }}
</style></defs>
<rect width="100%" height="100%" fill="#ffffff"/>
{chr(10).join(out)}
</svg>'''
here = Path(__file__).parent
(here / "arch.svg").write_text(svg)
