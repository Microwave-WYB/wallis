"""A "linear render" of one scan: its mean, min and max (as RGB triples), and its capture date.
usage: linear.py SCAN.pgm -> JSON on stdout"""
import sys, json; sys.path.insert(0, '/film/lib')
from img import read_pgm, mean
rows = read_pgm(sys.argv[1]); vals = [v / 255 for r in rows for v in r]
dto = next((l.split('dto', 1)[1].strip() for l in open(sys.argv[1]) if l.startswith('# dto')), '2026:01:01 00:00:00')
print(json.dumps(dict(lo=[min(vals)] * 3, hi=[max(vals)] * 3, centre=[mean(rows)] * 3, dto=dto)))
