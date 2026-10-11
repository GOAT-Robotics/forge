"""SolidWorks document containers.

SolidWorks 2015 and later write a sequence of raw-DEFLATE blocks. Each block starts with the marker
14 00 06 00 08 00, then (little-endian) a type id, the CRC-32 of the inflated payload, the compressed and inflated
sizes and the length of a name; the name's bytes are nibble-swapped ASCII, the payload follows. Older files are OLE
compound documents (Microsoft CFB) holding the same named streams.

Inside the streams, Parasolid transmit data ("PS\\0\\0...") is zlib-compressed, sometimes behind a short header.
"""
from __future__ import annotations

import re
import struct
import zlib

MARKER = b'\x14\x00\x06\x00\x08\x00'
HEADER = 26
CFB_MAGIC = b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'
MAX_BLOCK = 1 << 30


class ContainerError(ValueError):
    pass


def _name(raw):
    b = bytes(((x << 4) | (x >> 4)) & 0xff for x in raw)
    return b.decode('ascii') if b and all(0x20 <= c < 0x7f for c in b) else None


def _blocks(data):
    """(name, payload) for every block whose payload inflates to its stated size and CRC."""
    i = data.find(MARKER, 8)
    while i != -1:
        nxt = i + 1
        if i + HEADER <= len(data):
            _tid, crc, csz, usz, psz = struct.unpack_from('<5I', data, i + 6)
            start = i + HEADER + psz
            if 0 < csz and psz < 4096 and usz <= MAX_BLOCK and start + csz <= len(data):
                try:
                    out = zlib.decompressobj(-15).decompress(data[start:start + csz], usz + 1)
                except zlib.error:
                    out = None
                if out is not None and len(out) == usz and zlib.crc32(out) == crc:
                    yield _name(data[i + HEADER:start]), out
                    nxt = start + csz
        i = data.find(MARKER, nxt)


def _cfb_streams(path):
    try:
        import olefile
    except ImportError as e:  # pragma: no cover - olefile is in requirements
        raise ContainerError(f'reading SolidWorks files saved before 2015 needs the olefile package ({e})')
    try:
        ole = olefile.OleFileIO(str(path))
    except Exception as e:
        raise ContainerError(f'not a readable SolidWorks document ({e})')
    try:
        return {'/'.join(p): ole.openstream(p).read() for p in ole.listdir(streams=True, storages=False)}
    finally:
        ole.close()


def read(path):
    """{stream name: bytes} of a SolidWorks part, assembly or drawing."""
    with open(path, 'rb') as fh:
        data = fh.read()
    if not data.strip(b'\x00'):
        raise ContainerError('the file holds no data (every byte is zero: a failed copy or sync); save it again from SolidWorks')
    if data[:8] == CFB_MAGIC:
        return _cfb_streams(path)
    out = {}
    for name, payload in _blocks(data):
        key = name or f'@{len(out)}'
        while key in out:
            key += "'"
        out[key] = payload
    if not out:
        raise ContainerError('not a SolidWorks document (no readable blocks)')
    return out


def parasolid_streams(payload):
    """Every Parasolid transmit stream compressed inside a stream payload, in order."""
    if payload.startswith(b'PS\x00\x00'):
        return [payload]
    found, pat, pos = [], re.compile(rb'x[\x01\x5e\x9c\xda]'), 0
    while True:
        m = pat.search(payload, pos)
        if not m:
            return found
        d = zlib.decompressobj()
        try:
            head = d.decompress(payload[m.start():m.start() + 64])
        except zlib.error:
            pos = m.start() + 1
            continue
        if head[:4] != b'PS\x00\x00'[:len(head[:4])]:  # cheap reject: inflate a few bytes first
            pos = m.start() + 1
            continue
        d = zlib.decompressobj()
        try:
            out = d.decompress(payload[m.start():])
        except zlib.error:
            pos = m.start() + 1
            continue
        if out.startswith(b'PS\x00\x00'):
            pos = len(payload) - len(d.unused_data) if d.eof else m.start() + 1
            if d.eof:
                more, pos = _continuation(payload, pos)
                out += more
            found.append(out)
        else:
            pos = m.start() + 1


def _continuation(payload, pos):
    """Large Parasolid data is written in zlib chunks (the first 1 MiB, then 4 KiB each); every chunk after the
    first follows an 8-byte header: inflated size, compressed size (u32 little-endian). Returns the inflated
    continuation and the position after it."""
    parts = []
    while pos + 10 <= len(payload):
        usz, csz = struct.unpack_from('<2I', payload, pos)
        start = pos + 8
        if not (0 < usz <= 1 << 24 and 0 < csz <= len(payload) - start) or payload[start] != 0x78:
            break
        d = zlib.decompressobj()
        try:
            chunk = d.decompress(payload[start:start + csz])
        except zlib.error:
            break
        if len(chunk) != usz or not d.eof:
            break
        parts.append(chunk)
        pos = start + csz
    return b''.join(parts), pos


def kind(stream):
    """'partition', 'deltas' or 'transmit' from a Parasolid stream's title."""
    head = stream[:96]
    return 'deltas' if b'(deltas)' in head else 'partition' if b'(partition)' in head else 'transmit'
