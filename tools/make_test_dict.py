#!/usr/bin/env python3
"""Write small .mdx / .mdd files, used to test the parser.

Supports the two layouts the extension reads: engine version 2.0 (8-byte
numbers, compressed key index) and 1.2 (4-byte numbers, plain key index),
with zlib, LZO or no compression.

Usage: python3 tools/make_test_dict.py <output-dir>
"""
import os
import struct
import sys
import zlib

try:
    import lzo
except ImportError:  # only needed for the LZO fixtures
    lzo = None

try:  # only needed for the Encrypted="2" fixture
    from mdict_utils.base.ripemd128 import ripemd128
except ImportError:
    ripemd128 = None


def scramble_key_info(block):
    """Apply the key-index scrambling that Encrypted="2" dictionaries use."""
    key = ripemd128(block[4:8] + struct.pack(b"<L", 0x3695))
    out = bytearray(block[:8])
    previous = 0x36
    for i, plain in enumerate(block[8:]):
        t = plain ^ previous ^ (i & 0xFF) ^ key[i % len(key)]
        cipher = ((t >> 4) | (t << 4)) & 0xFF
        out.append(cipher)
        previous = cipher
    return bytes(out)


def compress_block(data, method):
    if method == "none":
        return b"\x00\x00\x00\x00" + struct.pack(">I", zlib.adler32(data) & 0xFFFFFFFF) + data
    if method == "lzo":
        payload = lzo.compress(data, 9, False)
        return b"\x01\x00\x00\x00" + struct.pack(">I", zlib.adler32(data) & 0xFFFFFFFF) + payload
    payload = zlib.compress(data, 9)
    return b"\x02\x00\x00\x00" + struct.pack(">I", zlib.adler32(data) & 0xFFFFFFFF) + payload


def build(entries, *, version="2.0", encoding="UTF-8", method="zlib",
          entries_per_block=3, records_per_block=4, title="Test", is_mdd=False,
          encrypted=0):
    """entries: list of (key: str, value: bytes | str).

    Values given as str are encoded with the dictionary encoding; .mdd values
    must be given as bytes and are stored verbatim.
    """
    v2 = float(version) >= 2.0
    num_fmt = ">Q" if v2 else ">I"
    num_width = 8 if v2 else 4
    size_fmt = ">H" if v2 else ">B"
    term = b"\x00\x00" if encoding == "UTF-16" else b"\x00"
    text_term = 1 if v2 else 0

    def enc(text):
        if encoding == "UTF-16":
            return text.encode("utf-16-le")
        if encoding == "GBK":
            return text.encode("gbk")
        return text.encode("utf-8")

    def enc_value(value):
        if isinstance(value, bytes):
            return value
        if encoding == "UTF-16":
            return value.encode("utf-16-le") + b"\x00\x00"
        if encoding == "GBK":
            return value.encode("gbk") + b"\x00"
        return value.encode("utf-8") + b"\x00"

    entries = [(k, enc_value(v)) for k, v in entries]
    entries = sorted(entries, key=lambda kv: kv[0])

    # ---- record section ----
    record_offsets = []
    offset = 0
    payloads = []
    for key, value in entries:
        record_offsets.append(offset)
        payloads.append(value)
        offset += len(value)

    record_blocks = []
    idx = 0
    while idx < len(payloads):
        chunk = b"".join(payloads[idx:idx + records_per_block])
        record_blocks.append((compress_block(chunk, method), len(chunk)))
        idx += records_per_block

    # ---- key blocks ----
    key_blocks = []
    idx = 0
    while idx < len(entries):
        group = entries[idx:idx + entries_per_block]
        body = b"".join(
            struct.pack(num_fmt, record_offsets[idx + n]) + enc(key) + term
            for n, (key, _) in enumerate(group)
        )
        key_blocks.append((compress_block(body, method), len(body), group))
        idx += entries_per_block

    info = b""
    for compressed, raw_len, group in key_blocks:
        first, last = group[0][0], group[-1][0]
        info += struct.pack(num_fmt, len(group))
        for word in (first, last):
            info += struct.pack(size_fmt, len(enc(word)) // (2 if encoding == "UTF-16" else 1))
            info += enc(word) + (term if text_term else b"")
        info += struct.pack(num_fmt, len(compressed))
        info += struct.pack(num_fmt, raw_len)

    if v2:
        info_stored = (b"\x02\x00\x00\x00"
                       + struct.pack(">I", zlib.adler32(info) & 0xFFFFFFFF)
                       + zlib.compress(info, 9))
        if encrypted & 2:
            info_stored = scramble_key_info(info_stored)
    else:
        info_stored = info

    key_blocks_bytes = b"".join(c for c, _, _ in key_blocks)

    # ---- header ----
    attrs = (
        f'<Dictionary GeneratedByEngineVersion="{version}" RequiredEngineVersion="{version}" '
        f'Encrypted="{encrypted or "No"}" Encoding="{"" if is_mdd else encoding}" Format="Html" '
        f'Compact="No" Left2Right="Yes" Title="{title}" '
        f'Description="fixture for tests"/>'
    )
    header_bytes = attrs.encode("utf-16-le") + b"\x00\x00"
    out = struct.pack(">I", len(header_bytes)) + header_bytes
    out += struct.pack("<I", zlib.adler32(header_bytes) & 0xFFFFFFFF)

    # ---- key section header ----
    fields = [len(key_blocks), len(entries)]
    if v2:
        fields.append(len(info))
    fields += [len(info_stored), len(key_blocks_bytes)]
    block = b"".join(struct.pack(num_fmt, f) for f in fields)
    out += block
    if v2:
        out += struct.pack(">I", zlib.adler32(block) & 0xFFFFFFFF)
    out += info_stored + key_blocks_bytes

    # ---- record section ----
    record_info = b"".join(
        struct.pack(num_fmt, len(c)) + struct.pack(num_fmt, raw)
        for c, raw in record_blocks
    )
    out += struct.pack(num_fmt, len(record_blocks))
    out += struct.pack(num_fmt, len(entries))
    out += struct.pack(num_fmt, len(record_info))
    out += struct.pack(num_fmt, sum(len(c) for c, _ in record_blocks))
    out += record_info
    out += b"".join(c for c, _ in record_blocks)
    return out


def html(word, gloss, extra=""):
    return (
        f'<link rel="stylesheet" type="text/css" href="test.css"/>'
        f'<div class="entry"><h1>{word}</h1><p>{gloss}</p>{extra}</div>'
    )


def main(outdir):
    os.makedirs(outdir, exist_ok=True)
    words = [
        ("apple", "a round fruit"),
        ("Apple", "the fruit, capitalised"),
        ("apricot", "a small orange fruit"),
        ("banana", "a long yellow fruit"),
        ("cherry", "a small red fruit"),
        ("date", "a sweet dried fruit"),
        ("elderberry", "a dark purple berry"),
        ("fig", "a soft sweet fruit"),
        ("grape", "grows in bunches"),
        ("汉字", "Chinese characters"),
    ]
    extras = {
        "apple": '<img src="pic.png"/>',
        # in-page anchor, written the way MDict dictionaries write them
        "cherry": '<a name="mark"></a><a id="anchor-link" href="entry://#mark">jump</a>',
        "banana": '<a id="cross-link" href="entry://cherry">see cherry</a>',
    }
    entries = [(w, html(w, g, extras.get(w, ""))) for w, g in words]
    entries.append(("apple tree", "@@@LINK=apple"))

    combos = [
        ("v2-zlib", dict(version="2.0", encoding="UTF-8", method="zlib")),
        ("v2-none", dict(version="2.0", encoding="UTF-8", method="none")),
        ("v2-utf16", dict(version="2.0", encoding="UTF-16", method="zlib")),
        ("v1-zlib", dict(version="1.2", encoding="UTF-8", method="zlib")),
        ("v2-gbk", dict(version="2.0", encoding="GBK", method="zlib")),
    ]
    if lzo:
        combos.append(("v2-lzo", dict(version="2.0", encoding="UTF-8", method="lzo")))
        combos.append(("v1-lzo", dict(version="1.2", encoding="UTF-8", method="lzo")))
    if ripemd128:
        combos.append(("v2-scrambled", dict(version="2.0", encoding="UTF-8", method="zlib", encrypted=2)))

    for name, opts in combos:
        path = os.path.join(outdir, f"{name}.mdx")
        with open(path, "wb") as fh:
            fh.write(build(entries, title=f"Test {name}", **opts))
        print("wrote", path)

    resources = [
        ("\\test.css", b".entry h1 { color: teal; } .entry { background: url(bg.png); }"),
        ("\\pic.png", bytes.fromhex(
            "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
            "890000000a49444154789c6360000002000100ffff03000006000557bfabd400"
            "00000049454e44ae426082")),
        ("\\bg.png", b"\x89PNG\r\n\x1a\n-not-a-real-png"),
    ]
    for name, opts in combos:
        path = os.path.join(outdir, f"{name}.mdd")
        with open(path, "wb") as fh:
            fh.write(build(resources, encoding="UTF-16", is_mdd=True,
                           title=f"Test {name}",
                           **{k: v for k, v in opts.items() if k != "encoding"}))
        print("wrote", path)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "test/fixtures")
