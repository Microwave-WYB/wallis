"""A contact sheet: the previews side by side, a 1-px gap between them.
usage: sheet.py OUT.png LABEL=PREVIEW.png ..."""
import sys; sys.path.insert(0, '/film/lib')
from img import read_png, write_png
imgs = [read_png(a.split('=', 1)[1]) for a in sys.argv[2:]]; h = max(len(i) for i in imgs)
rows = [sum(([*(i[r] if r < len(i) else [0] * len(i[0])), 0] for i in imgs), []) for r in range(h)]
write_png(sys.argv[1], rows)
print('{}')
