"""纯 Python 的 PNG 读取器（只用 zlib + struct），用于精确取像素值。
避免依赖 PIL —— 本机不保证装了。支持 8bit RGB/RGBA、非隔行。"""
import struct
import zlib


def read_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not a png'
    pos = 8
    idat = bytearray()
    w = h = bitd = ctype = None
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b'IHDR':
            w, h, bitd, ctype, comp, filt, inter = struct.unpack('>IIBBBBB', chunk)
            assert bitd == 8, 'only 8-bit'
            assert inter == 0, 'no interlace'
            assert ctype in (2, 6), 'only RGB/RGBA'
        elif typ == b'IDAT':
            idat += chunk
        elif typ == b'IEND':
            break
    raw = zlib.decompress(bytes(idat))
    bpp = 3 if ctype == 2 else 4
    stride = w * bpp
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, bpp, bytes(out)


def px(w, bpp, buf, x, y):
    o = (y * w + x) * bpp
    return buf[o], buf[o + 1], buf[o + 2]


def grid(path, nx=6, ny=6):
    w, h, bpp, buf = read_png(path)
    rows = []
    for j in range(ny):
        y = int((j + 0.5) / ny * h)
        rows.append([px(w, bpp, buf, int((i + 0.5) / nx * w), y) for i in range(nx)])
    return w, h, rows


if __name__ == '__main__':
    import sys
    for p in sys.argv[1:]:
        w, h, rows = grid(p)
        print('== %s  %dx%d' % (p.split('\\')[-1], w, h))
        for r in rows:
            print('   ' + ' '.join('%3d,%3d,%3d' % c for c in r))
