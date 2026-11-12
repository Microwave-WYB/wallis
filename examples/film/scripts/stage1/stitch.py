"""Stitch two halves side by side (the saved alignment's overlap is cut from the second), then crop the box.
usage: stitch.py A.pgm B.pgm P.pto CROP.json OUT.pgm"""
import sys, json; sys.path.insert(0, '/film/lib')
from img import read_pgm, write_pgm
a, b = read_pgm(sys.argv[1]), read_pgm(sys.argv[2])
overlap = int(open(sys.argv[3]).read().split('overlap')[1].split()[0]) if 'overlap' in open(sys.argv[3]).read() else 0
crop = json.loads(sys.argv[4]); rows = [ra + rb[overlap:] for ra, rb in zip(a, b)]
h, w = len(rows), len(rows[0]); x0, y0, x1, y1 = crop['box']
write_pgm(sys.argv[5], [r[round(x0 * w):round(x1 * w)] for r in rows[round(y0 * h):round(y1 * h)]])
print('{}')
