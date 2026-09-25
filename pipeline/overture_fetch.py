"""Fetch Overture Maps features for a bounding box straight from the public S3 bucket.

Uses HTTP range requests + parquet row-group statistics on the bbox struct so that
only the row groups overlapping the area are downloaded.

Usage: python pipeline/overture_fetch.py <theme> <type> [release]
"""
import io
import json
import os
import re
import sys
import concurrent.futures as cf

import pyarrow as pa
import pyarrow.parquet as pq
import requests

BUCKET = "https://overturemaps-us-west-2.s3.amazonaws.com"
DEFAULT_RELEASE = "2026-09-23.0"
# Nevinnomyssk + surroundings (lon/lat)
BBOX = (41.82, 44.54, 42.08, 44.74)
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "raw")

session = requests.Session()


def list_keys(prefix):
    keys, token = [], None
    while True:
        params = {"list-type": "2", "prefix": prefix}
        if token:
            params["continuation-token"] = token
        r = session.get(BUCKET + "/", params=params, timeout=60)
        r.raise_for_status()
        txt = r.text
        keys += [(k, int(s)) for k, s in re.findall(r"<Key>(.*?)</Key>.*?<Size>(\d+)</Size>", txt, re.S)]
        m = re.search(r"<NextContinuationToken>(.*?)</NextContinuationToken>", txt)
        if not m:
            break
        token = m.group(1)
    return [(k, s) for k, s in keys if k.endswith(".parquet") or "part-" in k]


class HttpFile(io.RawIOBase):
    """Minimal seekable file over HTTP range requests with a small block cache."""

    def __init__(self, url, size):
        self.url, self.size, self.pos = url, size, 0
        self.cache = {}

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        if whence == 0:
            self.pos = off
        elif whence == 1:
            self.pos += off
        else:
            self.pos = self.size + off
        return self.pos

    def _get(self, start, end):
        for attempt in range(5):
            try:
                r = session.get(self.url, headers={"Range": f"bytes={start}-{end - 1}"}, timeout=120)
                r.raise_for_status()
                return r.content
            except Exception:
                if attempt == 4:
                    raise

    def read(self, n=-1):
        if n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b""
        key = (self.pos, n)
        if key in self.cache:
            data = self.cache[key]
        else:
            data = self._get(self.pos, self.pos + n)
            if n < 1 << 20:
                self.cache[key] = data
        self.pos += len(data)
        return data

    def readinto(self, b):
        d = self.read(len(b))
        b[: len(d)] = d
        return len(d)


def rg_overlaps(md, rg_idx, names, bbox):
    rg = md.row_group(rg_idx)
    stats = {}
    for ci in range(rg.num_columns):
        col = rg.column(ci)
        p = col.path_in_schema
        if p in names and col.statistics is not None and col.statistics.has_min_max:
            stats[p] = (col.statistics.min, col.statistics.max)
    try:
        xmin = stats["bbox.xmin"][0]
        xmax = stats["bbox.xmax"][1]
        ymin = stats["bbox.ymin"][0]
        ymax = stats["bbox.ymax"][1]
    except KeyError:
        return True
    return not (xmax < bbox[0] or xmin > bbox[2] or ymax < bbox[1] or ymin > bbox[3])


def fetch_file(key, size, bbox):
    url = f"{BUCKET}/{key}"
    f = HttpFile(url, size)
    # prefetch footer
    tail = min(size, 4 << 20)
    f.seek(size - tail)
    blob = f.read(tail)
    f.cache = {}
    buf = io.BytesIO()

    class Tailed(HttpFile):
        def read(self2, n=-1):
            if n < 0:
                n = self2.size - self2.pos
            n = min(n, self2.size - self2.pos)
            if self2.pos >= size - tail:
                off = self2.pos - (size - tail)
                d = blob[off: off + n]
                self2.pos += len(d)
                return d
            return HttpFile.read(self2, n)

    tf = Tailed(url, size)
    pf = pq.ParquetFile(tf)
    md = pf.metadata
    names = {"bbox.xmin", "bbox.xmax", "bbox.ymin", "bbox.ymax"}
    groups = [i for i in range(md.num_row_groups) if rg_overlaps(md, i, names, bbox)]
    if not groups:
        return None
    tables = []
    for g in groups:
        t = pf.read_row_group(g)
        b = t.column("bbox").combine_chunks()
        xmin = b.field("xmin").to_numpy(zero_copy_only=False)
        xmax = b.field("xmax").to_numpy(zero_copy_only=False)
        ymin = b.field("ymin").to_numpy(zero_copy_only=False)
        ymax = b.field("ymax").to_numpy(zero_copy_only=False)
        mask = ~((xmax < bbox[0]) | (xmin > bbox[2]) | (ymax < bbox[1]) | (ymin > bbox[3]))
        if mask.any():
            tables.append(t.filter(pa.array(mask)))
    if not tables:
        return None
    return pa.concat_tables(tables, promote_options="permissive")


def main():
    theme, typ = sys.argv[1], sys.argv[2]
    release = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_RELEASE
    prefix = f"release/{release}/theme={theme}/type={typ}/"
    keys = list_keys(prefix)
    print(f"{len(keys)} files under {prefix}", flush=True)
    tables = []
    with cf.ThreadPoolExecutor(12) as ex:
        futs = {ex.submit(fetch_file, k, s, BBOX): k for k, s in keys}
        for fu in cf.as_completed(futs):
            try:
                t = fu.result()
            except Exception as e:  # noqa
                print("ERR", futs[fu], e, flush=True)
                continue
            if t is not None:
                print(f"  {futs[fu].split('/')[-1][:40]} -> {t.num_rows} rows", flush=True)
                tables.append(t)
    if not tables:
        print("no data")
        return
    t = pa.concat_tables(tables, promote_options="permissive")
    os.makedirs(OUT, exist_ok=True)
    out = os.path.join(OUT, f"{theme}_{typ}.parquet")
    pq.write_table(t, out)
    print(f"wrote {t.num_rows} rows -> {out}")


if __name__ == "__main__":
    main()
