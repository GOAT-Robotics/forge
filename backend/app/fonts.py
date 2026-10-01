"""Drawing fonts shared by the drafting engine (sheet.py) and the scene replayer (drawing_scene.py).

Any process that replays a saved drawing scene (API save/export, worker regeneration) must have these
registered with reportlab, otherwise setFont('ForgeDim') raises KeyError.
"""
from pathlib import Path
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

FONT_DIR = Path(__file__).parent / 'fonts'
DIM_FONT = 'ForgeDim'
try:
    if DIM_FONT not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(DIM_FONT, str(FONT_DIR / 'BarlowSemiCondensed-Regular.ttf')))
except Exception:  # font file missing: fall back to Helvetica metrics
    DIM_FONT = 'Helvetica'
