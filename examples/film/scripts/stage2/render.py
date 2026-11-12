"""Develop a negative with a look: invert, subtract the black point, apply gamma; a PNG.
usage: render.py NEG.pgm PARAMS.json OUT.png  (PARAMS: {look, dmin, ratio, lo, mode: {preview: SIZE} | {final: EXIF}})"""
import sys, json; sys.path.insert(0, '/film/lib')
from img import read_pgm, write_png
rows = read_pgm(sys.argv[1]); p = json.loads(sys.argv[2]); look = p['look']
gamma, black = float(look['NEG_GAMMA']), float(look['BLACK_SHIFT_D'])
dev = lambda v: round(255 * max(0.0, (1 - v / 255) - black) ** (1 / gamma))
out = [[dev(v) for v in r] for r in rows]
if 'preview' in p['mode']:
    step = max(1, len(out[0]) // p['mode']['preview'] + (1 if len(out[0]) % p['mode']['preview'] else 0))
    out = [r[::step] for r in out[::step]]
write_png(sys.argv[3], out)
print('{}')
