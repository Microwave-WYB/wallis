"""Tiny image helpers (stdlib only): ASCII PGM in, PNG out (8-bit grey, filter 0), PNG back in."""
import struct, zlib

def read_pgm(path):
    toks = [t for line in open(path) for t in line.split('#')[0].split()]
    assert toks[0] == 'P2', 'not an ASCII PGM'
    w, h, mx = int(toks[1]), int(toks[2]), int(toks[3])
    px = [int(v) * 255 // mx for v in toks[4:4 + w * h]]
    return [px[r * w:(r + 1) * w] for r in range(h)]

def write_pgm(path, rows):
    with open(path, 'w') as f:
        f.write(f'P2\n{len(rows[0])} {len(rows)}\n255\n')
        for r in rows: f.write(' '.join(map(str, r)) + '\n')

def write_png(path, rows):
    h, w = len(rows), len(rows[0])
    raw = b''.join(b'\x00' + bytes(max(0, min(255, v)) for v in r) for r in rows)
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 0, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))

def read_png(path):
    data = open(path, 'rb').read(); pos = 8; idat = b''; w = h = 0
    while pos < len(data):
        n, t = struct.unpack('>I4s', data[pos:pos + 8]); body = data[pos + 8:pos + 8 + n]; pos += 12 + n
        if t == b'IHDR': w, h = struct.unpack('>II', body[:8])
        if t == b'IDAT': idat += body
    raw = zlib.decompress(idat)
    return [list(raw[r * (w + 1) + 1:(r + 1) * (w + 1)]) for r in range(h)]

def mean(rows):
    vals = [v for r in rows for v in r]
    return sum(vals) / len(vals) / 255
