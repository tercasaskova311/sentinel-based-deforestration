"""
Build the web-map data for the GitHub Pages site (docs/).

Inputs
  data/gee_exports/sumava_disturbance_YYYY.geojson   ← from models/harmonic_regression/model_multiyear.js
  results/labeled_alerts_24.geojson                  ← legacy 2024 run (model.js) with tp/fp labels
  data/boundaries/sumava_zones.gpkg                  ← NP zoning A–D (AOPK, 2023)

Outputs (docs/data/)
  disturbance_YYYY.geojson   one cleaned polygon layer per year
  zones.geojson              simplified zoning
  summary.json               per-year / per-zone stats for the side panel

Usage
  python scripts/build_site_data.py
"""
from __future__ import annotations

import json
import re
from datetime import date, timedelta
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.validation import make_valid

ROOT = Path(__file__).resolve().parents[1]
GEE_DIR = ROOT / "data" / "gee_exports"
LEGACY_2024 = ROOT / "results" / "labeled_alerts_24.geojson"
ZONES = ROOT / "data" / "boundaries" / "sumava_zones.gpkg"
OUT = ROOT / "docs" / "data"

UTM = "EPSG:32633"
WGS = "EPSG:4326"
MIN_HA = 0.3          # same as minPatchPx = 30 at 10 m
SIMPLIFY_M = 0.5       # drop collinear pixel-edge vertices before smoothing
ZONE_SIMPLIFY_M = 15

ZONE_INFO = {
    "A": {"name": "Natural zone", "cz": "Přírodní zóna",
          "desc": "Non-intervention: natural processes left to run, no logging."},
    "B": {"name": "Near-natural zone", "cz": "Zóna přírodě blízká",
          "desc": "Transition towards non-intervention; limited management."},
    "C": {"name": "Concentrated-care zone", "cz": "Zóna soustředěné péče o přírodu",
          "desc": "Active management: bark-beetle control and salvage logging allowed."},
    "D": {"name": "Cultural landscape zone", "cz": "Zóna kulturní krajiny",
          "desc": "Settlements and their surroundings."},
}
LABEL_TEXT = {"tp": "confirmed", "fp": "false alarm"}


def load_zones() -> gpd.GeoDataFrame:
    z = gpd.read_file(ZONES)[["ZONA", "geometry"]].rename(columns={"ZONA": "zone"})
    z = z.to_crs(UTM)
    z["geometry"] = z.geometry.apply(make_valid)
    return z.dissolve("zone").reset_index()


def clean(gdf: gpd.GeoDataFrame, np_union) -> gpd.GeoDataFrame:
    gdf = gdf.to_crs(UTM).copy()
    gdf["geometry"] = gdf.geometry.apply(make_valid)
    gdf = gdf[~gdf.geometry.isna()]
    gdf = gdf[~gdf.geometry.is_empty]
    gdf = gdf[gdf.geom_type.isin(["Polygon", "MultiPolygon", "GeometryCollection"])]
    gdf["geometry"] = gdf.geometry.intersection(np_union)
    gdf = gdf[~gdf.geometry.is_empty]
    gdf["area_ha"] = gdf.geometry.area / 1e4
    return gdf[gdf.area_ha >= MIN_HA].copy()


def assign_zones(gdf: gpd.GeoDataFrame, zones: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    gdf = gdf.reset_index(drop=True)
    gdf["_i"] = gdf.index
    ov = gpd.overlay(gdf[["_i", "geometry"]], zones, how="intersection", keep_geom_type=True)
    ov["a"] = ov.geometry.area
    share = ov.pivot_table(index="_i", columns="zone", values="a", aggfunc="sum").fillna(0)
    for zc in "ABCD":
        if zc not in share:
            share[zc] = 0.0
    tot = share.sum(axis=1)
    gdf["zone"] = share[list("ABCD")].idxmax(axis=1).reindex(gdf._i).values
    for zc in "ABCD":
        gdf[f"ha_{zc}"] = (share[zc] / 1e4).reindex(gdf._i).fillna(0).round(2).values
    gdf["zone_share"] = (share[list("ABCD")].max(axis=1) / tot).reindex(gdf._i).round(2).values
    return gdf.drop(columns="_i")


def transfer_labels(gdf: gpd.GeoDataFrame, labelled: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Copy tp/fp validation labels from the legacy 2024 run by maximum overlap."""
    lab = labelled[labelled["label"].isin(["tp", "fp"])].to_crs(UTM)[["label", "geometry"]]
    gdf = gdf.reset_index(drop=True)
    gdf["_i"] = gdf.index
    ov = gpd.overlay(gdf[["_i", "geometry"]], lab, how="intersection", keep_geom_type=True)
    if ov.empty:
        return gdf.drop(columns="_i")
    ov["a"] = ov.geometry.area
    best = ov.sort_values("a").groupby("_i").last()
    frac = best["a"] / gdf.loc[best.index].geometry.area
    best = best[frac > 0.3]
    gdf["label"] = gdf["_i"].map(best["label"])
    return gdf.drop(columns="_i")


def _chaikin_ring(coords, iters=2):
    pts = list(coords)[:-1]
    for _ in range(iters):
        new = []
        for i in range(len(pts)):
            (x0, y0), (x1, y1) = pts[i], pts[(i + 1) % len(pts)]
            new += [(0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1),
                    (0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1)]
        pts = new
    return pts + [pts[0]]


def smooth(geom):
    """Round off the 10 m pixel staircase for display (shift < ~3 m)."""
    from shapely.geometry import MultiPolygon, Polygon
    if geom.geom_type == "Polygon":
        g = Polygon(_chaikin_ring(geom.exterior.coords),
                    [_chaikin_ring(r.coords) for r in geom.interiors if Polygon(r).area > 200])
        return make_valid(g.simplify(1.0))
    if geom.geom_type in ("MultiPolygon", "GeometryCollection"):
        parts = [smooth(p) for p in geom.geoms if p.geom_type in ("Polygon", "MultiPolygon")]
        polys = [q for p in parts for q in (p.geoms if hasattr(p, "geoms") else [p]) if q.geom_type == "Polygon"]
        return MultiPolygon(polys)
    return geom


def doy_to_date(year: int, day) -> str | None:
    if day is None or pd.isna(day):
        return None
    return (date(year, 1, 1) + timedelta(days=int(round(day)))).isoformat()


def finalise(gdf: gpd.GeoDataFrame, year: int, source: str) -> gpd.GeoDataFrame:
    gdf = gdf.sort_values("area_ha", ascending=False).reset_index(drop=True)
    gdf["id"] = [f"{year}-{i + 1:04d}" for i in range(len(gdf))]
    gdf["year"] = year
    gdf["source"] = source
    gdf["area_ha"] = gdf.area_ha.round(2)
    gdf["label_text"] = gdf.area_ha.map(lambda a: f"{a:.1f} ha")
    if "first_day" in gdf:
        gdf["first_alert"] = [doy_to_date(year, d) for d in gdf.first_day]
    for col in ("z_min", "z_mean", "scenes_mean"):
        if col in gdf:
            gdf[col] = gdf[col].astype(float).round(2)
    if "label" in gdf:
        gdf["validation"] = gdf["label"].map(LABEL_TEXT)
    gdf["geometry"] = gdf.geometry.simplify(SIMPLIFY_M, preserve_topology=True).apply(smooth)
    # label anchor: inside the largest part of each polygon
    def anchor(g):
        main = max(g.geoms, key=lambda p: p.area) if hasattr(g, "geoms") else g
        return main.representative_point()
    pts = gpd.GeoSeries(gdf.geometry.apply(anchor), crs=UTM).to_crs(WGS)
    gdf["lx"], gdf["ly"] = pts.x.round(6), pts.y.round(6)
    keep = ["id", "year", "area_ha", "label_text", "lx", "ly", "zone", "zone_share",
            "ha_A", "ha_B", "ha_C", "ha_D", "first_alert", "z_min", "z_mean",
            "scenes_mean", "validation", "source", "geometry"]
    return gdf[[c for c in keep if c in gdf.columns]]


def write_geojson(gdf: gpd.GeoDataFrame, path: Path) -> None:
    gj = json.loads(gdf.to_crs(WGS).to_json(drop_id=True, na="drop"))

    def rnd(x):
        if isinstance(x, list):
            return [rnd(v) for v in x]
        return round(x, 6) if isinstance(x, float) else x

    for f in gj["features"]:
        f["geometry"]["coordinates"] = rnd(f["geometry"]["coordinates"])
    path.write_text(json.dumps(gj, separators=(",", ":"), ensure_ascii=False))


def year_summary(gdf: gpd.GeoDataFrame, year: int, source: str) -> dict:
    s = {
        "year": year,
        "source": source,
        "n_polygons": int(len(gdf)),
        "total_ha": round(float(gdf.area_ha.sum()), 1),
        "largest_ha": round(float(gdf.area_ha.max()), 1) if len(gdf) else 0,
        "median_ha": round(float(gdf.area_ha.median()), 2) if len(gdf) else 0,
        "by_zone_ha": {zc: round(float(gdf[f"ha_{zc}"].sum()), 1) for zc in "ABCD"},
        "by_zone_n": {zc: int((gdf.zone == zc).sum()) for zc in "ABCD"},
    }
    if "validation" in gdf:
        v = gdf.validation.value_counts()
        tp, fp = int(v.get("confirmed", 0)), int(v.get("false alarm", 0))
        s["validation"] = {"confirmed": tp, "false_alarm": fp,
                           "unchecked": int(len(gdf) - tp - fp),
                           "precision": round(tp / (tp + fp), 3) if tp + fp else None}
    return s


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    zones = load_zones()
    np_union = zones.geometry.union_all()

    legacy = gpd.read_file(LEGACY_2024) if LEGACY_2024.exists() else None
    if legacy is not None and legacy.crs is None:
        legacy = legacy.set_crs(WGS)

    layers: dict[int, tuple[gpd.GeoDataFrame, str]] = {}
    for p in sorted(GEE_DIR.glob("sumava_disturbance_*.geojson")):
        year = int(re.search(r"(\d{4})", p.stem).group(1))
        layers[year] = (gpd.read_file(p), "harmonic_multiyear")
    if 2024 not in layers and legacy is not None:
        layers[2024] = (legacy.drop(columns=["area_ha"], errors="ignore"), "harmonic_2024_legacy")

    summaries = []
    for year in sorted(layers):
        raw, source = layers[year]
        gdf = assign_zones(clean(raw, np_union), zones)
        if year == 2024 and legacy is not None:
            gdf = transfer_labels(gdf, legacy) if "label" not in gdf else gdf
        gdf = finalise(gdf, year, source)
        write_geojson(gdf, OUT / f"disturbance_{year}.geojson")
        summaries.append(year_summary(gdf, year, source))
        print(f"{year}: {len(gdf):4d} polygons, {gdf.area_ha.sum():8.1f} ha  [{source}]")

    zs = zones.copy()
    zs["geometry"] = zs.geometry.simplify(ZONE_SIMPLIFY_M, preserve_topology=True)
    zs["area_km2"] = (zones.geometry.area / 1e6).round(1)
    for k in ("name", "cz", "desc"):
        zs[k] = zs.zone.map(lambda z: ZONE_INFO[z][k])
    write_geojson(zs, OUT / "zones.geojson")

    # one label point per sizeable zone part (zones are fragmented)
    parts = zones.explode(index_parts=False)
    parts = parts[parts.geometry.area > 5e6].copy()
    parts["geometry"] = parts.geometry.representative_point()
    parts["label"] = parts.zone.map(lambda z: f"Zone {z}")
    write_geojson(parts[["zone", "label", "geometry"]], OUT / "zone_labels.geojson")

    (OUT / "summary.json").write_text(json.dumps({
        "generated": date.today().isoformat(),
        "years": summaries,
        "zones": {r.zone: {**ZONE_INFO[r.zone], "area_km2": float(r.area_km2)}
                  for r in zs.itertuples()},
        "official_harvest_m3": {"2021": 226386, "2022": 270850, "2023": 275724, "2024": 202205},
    }, indent=2, ensure_ascii=False))
    print("→", OUT)


if __name__ == "__main__":
    main()
