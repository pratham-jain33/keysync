#!/usr/bin/env python3
"""Download selected members from the 108GB MAESTRO zip without fetching it
all, using HTTP range requests. The official Google Storage URL supports
ranges; Python's zipfile does seek+read, so a range-backed file object lets
us extract only the folders we want (e.g. just the 2018 split, ~10GB).

Usage:
    python fetch_maestro_subset.py <dest_dir> [year ...]
Default years: 2018
Always fetches maestro-v3.0.0.csv and maestro-v3.0.0.json (split metadata).
"""
import io
import os
import sys
import urllib.request
import zipfile

URL = "https://storage.googleapis.com/magentadata/datasets/maestro/v3.0.0/maestro-v3.0.0.zip"
PREFIX = "maestro-v3.0.0"


class RangeReader(io.RawIOBase):
    def __init__(self, url):
        self.url = url
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req) as r:
            self._size = int(r.headers["Content-Length"])
        self._pos = 0

    def __len__(self):
        return self._size

    def seekable(self):
        return True

    def seek(self, offset, whence=io.SEEK_SET):
        if whence == io.SEEK_SET:
            self._pos = offset
        elif whence == io.SEEK_CUR:
            self._pos += offset
        elif whence == io.SEEK_END:
            self._pos = self._size + offset
        return self._pos

    def tell(self):
        return self._pos

    def readinto(self, b):
        n = len(b)
        if n == 0 or self._pos >= self._size:
            return 0
        end = min(self._pos + n - 1, self._size - 1)
        req = urllib.request.Request(
            self.url, headers={"Range": f"bytes={self._pos}-{end}"}
        )
        with urllib.request.urlopen(req) as r:
            data = r.read()
        b[: len(data)] = data
        self._pos += len(data)
        return len(data)


def main():
    dest = sys.argv[1] if len(sys.argv) > 1 else "maestro-v3.0.0"
    years = sys.argv[2:] or ["2018"]
    os.makedirs(dest, exist_ok=True)

    print("opening remote zip index...", flush=True)
    reader = RangeReader(URL)
    zf = zipfile.ZipFile(reader)
    names = zf.namelist()
    print(f"zip contains {len(names)} members", flush=True)

    wanted = []
    for n in names:
        rel = n[len(PREFIX) + 1 :] if n.startswith(PREFIX + "/") else n
        top = rel.split("/")[0]
        if top in ("maestro-v3.0.0.csv", "maestro-v3.0.0.json", "LICENSE", "README"):
            wanted.append(n)
        elif top in years:
            # wav + midi only; skip flac duplicates and tsv alignment files
            if rel.endswith(".wav") or rel.endswith(".midi"):
                wanted.append(n)
    print(f"extracting {len(wanted)} members (years: {years})...", flush=True)

    total = 0
    for i, n in enumerate(wanted):
        rel = n[len(PREFIX) + 1 :]
        out = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with zf.open(n) as src, open(out, "wb") as f:
            while True:
                chunk = src.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                total += len(chunk)
        if (i + 1) % 25 == 0:
            print(f"  {i + 1}/{len(wanted)} ... {total / 1e9:.1f} GB", flush=True)
    print(f"done: {total / 1e9:.2f} GB in {dest}", flush=True)


if __name__ == "__main__":
    main()
