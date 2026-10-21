"""
Turn yearly Sentinel-2 composites (GeoTIFF) into one PMTiles file per year/style,
which MapLibre reads straight from GitHub Pages with HTTP range requests.

Inputs  data/imagery/sumava_s2_<style>_<year>.tif   (from models/harmonic_regression/export_imagery.js)
          style = true  (B4,B3,B2)  or  false (B12,B8,B4 — clear-cuts show as bright magenta)
Outputs docs/imagery/<style>_<year>.pmtiles  + docs/imagery/index.json

Usage
  python scripts/make_imagery_tiles.py                 # all GeoTIFFs in data/imagery/
  python scripts/make_imagery_tiles.py --legacy-2024   # also tile data/boundaries/sentinel_2024.tif
"""
from __future__ import annotations

import argparse
import io
import json
import re
from pathlib import Path

import mercantile
import numpy as np
import rasterio
import rasterio.warp
from PIL import Image
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer
from rasterio.enums import Resampling
import rasterio.errors
import rasterio.transform
import rasterio.windows
from rasterio.windows import from_bounds

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "data" / "imagery"
OUT_DIR = ROOT / "docs" / "imagery"
LEGACY = ROOT / "data" / "boundaries" / "sentinel_2024.tif"

MINZOOM, MAXZOOM = 9, 14      # z14 ≈ 9.5 m/px ≈ native 10 m Sentinel-2
QUALITY = 72                  # WebP quality


def to_uint8(arr: np.ndarray, src_dtype: str, stretch: tuple[float, float, float]) -> np.ndarray:
    """uint8 passes through; float reflectance gets a fixed stretch (same for every year)."""
    if src_dtype == "uint8":
        return arr
    lo, hi, gamma = stretch
    x = np.clip((arr - lo) / (hi - lo), 0, 1) ** (1 / gamma)
    return (np.nan_to_num(x) * 255).astype(np.uint8)


def read_tile(src, t) -> np.ndarray:
    """Read the source pixels under one web-mercator tile and warp them to 256×256."""
    b = mercantile.xy_bounds(t)
    dst_tf = rasterio.transform.from_bounds(b.left, b.bottom, b.right, b.top, 256, 256)
    l, bo, r, to = rasterio.warp.transform_bounds("EPSG:3857", src.crs, b.left, b.bottom, b.right, b.top)
    pad = 2 * src.res[0]
    win = from_bounds(l - pad, bo - pad, r + pad, to + pad, src.transform)
    try:
        win = win.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
    except rasterio.errors.WindowError:
        return np.zeros((3, 256, 256), dtype="uint8")
    # decimate on read: no need for more than ~2× the tile resolution
    scale = max(1.0, min(win.width, win.height) / 512)
    shape = (3, max(1, int(win.height / scale)), max(1, int(win.width / scale)))
    arr = src.read([1, 2, 3], window=win, out_shape=shape, resampling=Resampling.average)
    tf = rasterio.windows.transform(win, src.transform) * rasterio.Affine.scale(win.width / shape[2], win.height / shape[1])
    fill = 0 if src.dtypes[0] == "uint8" else np.nan
    out = np.full((3, 256, 256), fill, dtype=arr.dtype)
    rasterio.warp.reproject(arr, out, src_transform=tf, src_crs=src.crs, dst_transform=dst_tf,
                            dst_crs="EPSG:3857", resampling=Resampling.bilinear,
                            src_nodata=fill, dst_nodata=fill)
    return out


def tile_raster(src_path: Path, out_path: Path, stretch=(0.0, 0.10, 1.4)) -> dict:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(src_path) as src:
        dtype = src.dtypes[0]
        west, south, east, north = rasterio.warp.transform_bounds(src.crs, "EPSG:4326", *src.bounds)
        n_tiles = 0
        tiles = sorted(((zxy_to_tileid(t.z, t.x, t.y), t)
                        for z in range(MINZOOM, MAXZOOM + 1)
                        for t in mercantile.tiles(west, south, east, north, z)), key=lambda x: x[0])
        with open(out_path, "wb") as f:
            w = Writer(f)
            for tid, t in tiles:
                data = read_tile(src, t)
                if dtype == "uint8":
                    valid = data.max(axis=0) > 0
                else:
                    valid = np.isfinite(data).all(axis=0) & (np.nan_to_num(data).max(axis=0) > 0)
                if not valid.any():
                    continue
                rgb = to_uint8(data, dtype, stretch).transpose(1, 2, 0)
                rgba = np.dstack([rgb, (valid * 255).astype(np.uint8)])
                buf = io.BytesIO()
                Image.fromarray(rgba, "RGBA").save(buf, "WEBP", quality=QUALITY, method=4)
                w.write_tile(tid, buf.getvalue())
                n_tiles += 1
            w.finalize(
                {"tile_type": TileType.WEBP, "tile_compression": Compression.NONE,
                 "min_zoom": MINZOOM, "max_zoom": MAXZOOM,
                 "min_lon_e7": int(west * 1e7), "min_lat_e7": int(south * 1e7),
                 "max_lon_e7": int(east * 1e7), "max_lat_e7": int(north * 1e7),
                 "center_zoom": 11, "center_lon_e7": int((west + east) / 2 * 1e7),
                 "center_lat_e7": int((south + north) / 2 * 1e7)},
                {"attribution": "Contains modified Copernicus Sentinel-2 data"},
            )
    size = out_path.stat().st_size / 1e6
    print(f"{out_path.name}: {n_tiles} tiles, {size:.1f} MB")
    return {"tiles": n_tiles, "mb": round(size, 1)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--legacy-2024", action="store_true",
                    help="tile data/boundaries/sentinel_2024.tif as true-colour 2024")
    args = ap.parse_args()

    index_path = OUT_DIR / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {}

    jobs = []
    for p in sorted(SRC_DIR.glob("sumava_s2_*_*.tif")):
        m = re.match(r"sumava_s2_(true|false)_(\d{4})", p.stem)
        if m:
            jobs.append((p, m.group(1), int(m.group(2))))
    if args.legacy_2024 and not any(s == "true" and y == 2024 for _, s, y in jobs):
        jobs.append((LEGACY, "true", 2024))

    for path, style, year in jobs:
        info = tile_raster(path, OUT_DIR / f"{style}_{year}.pmtiles")
        index.setdefault(style, {})[str(year)] = {**info, "source": path.name}

    index_path.write_text(json.dumps(index, indent=2))
    print("→", index_path)


if __name__ == "__main__":
    main()
