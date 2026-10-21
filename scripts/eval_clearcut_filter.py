"""
Evaluate the Sentinel-1 clear-cut check on the hand-labelled 2024 polygons.

Input   results/labeled_alerts_24_s1.geojson   (export of clearcut_filter_eval.js)
Output  console tables + figures/clearcut_s1_eval.png

Zone A (no logging allowed) works as a free negative control: whatever the filter
still calls "clear-cut" there is almost certainly dieback or noise.
"""
from pathlib import Path

import geopandas as gpd
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "results" / "labeled_alerts_24_s1.geojson"
ZONES = ROOT / "data" / "boundaries" / "sumava_zones.gpkg"
FIG = ROOT / "figures" / "clearcut_s1_eval.png"
THRESHOLDS = np.round(np.arange(-3.0, 0.01, 0.25), 2)


def sweep(df: pd.DataFrame) -> pd.DataFrame:
    n_tp = (df.label == "tp").sum()
    rows = []
    for t in THRESHOLDS:
        kept = df[df.dvh_rel <= t]
        tp = (kept.label == "tp").sum()
        p = tp / len(kept) if len(kept) else np.nan
        r = tp / n_tp if n_tp else np.nan
        rows.append({"threshold_dB": t, "kept": len(kept), "tp": tp, "precision": p, "recall": r,
                     "f1": 2 * p * r / (p + r) if p and r else np.nan})
    return pd.DataFrame(rows)


def main() -> None:
    gdf = gpd.read_file(SRC).to_crs(32633)
    gdf = gdf[gdf.label.isin(["tp", "fp"]) & gdf.dvh_rel.notna()].copy()
    zones = gpd.read_file(ZONES)[["ZONA", "geometry"]].to_crs(32633)
    gdf["zone"] = gpd.sjoin(gdf.assign(geometry=gdf.representative_point()), zones,
                            how="left", predicate="within")["ZONA"]

    base = (gdf.label == "tp").mean()
    print(f"{len(gdf)} labelled polygons, precision without the check: {base:.1%}\n")
    print("median dvh_rel (dB):", gdf.groupby("label").dvh_rel.median().round(2).to_dict(), "\n")

    table = sweep(gdf)
    print(table.round(3).to_string(index=False))
    best = table.loc[table.f1.idxmax()]
    print(f"\nbest F1 at dvh_rel ≤ {best.threshold_dB} dB: precision {best.precision:.1%}, "
          f"recall {best.recall:.1%}, kept {int(best.kept)} of {len(gdf)}")

    print("\nper zone at that threshold:")
    for z, g in gdf.groupby("zone"):
        k = g[g.dvh_rel <= best.threshold_dB]
        print(f"  zone {z}: {len(g):3d} labelled, kept {len(k):3d}, "
              f"precision {((k.label == 'tp').mean() if len(k) else float('nan')):.1%} "
              f"(before {(g.label == 'tp').mean():.1%})")

    fig, ax = plt.subplots(1, 2, figsize=(12, 4.5))
    bins = np.linspace(gdf.dvh_rel.quantile(.01) - .5, gdf.dvh_rel.quantile(.99) + .5, 30)
    for lab, c in [("tp", "#2f9e7d"), ("fp", "#d6604d")]:
        ax[0].hist(gdf[gdf.label == lab].dvh_rel, bins=bins, alpha=.65, color=c,
                   label={"tp": "confirmed clear-cut", "fp": "false alarm"}[lab])
    ax[0].axvline(best.threshold_dB, color="k", ls="--", lw=1)
    ax[0].set(xlabel="ΔVH polygon − ring (dB)", ylabel="polygons", title="Sentinel-1 VH change, 2024 labels")
    ax[0].legend(frameon=False)
    for col, c in [("precision", "#2f9e7d"), ("recall", "#e3b84f"), ("f1", "#333")]:
        ax[1].plot(table.threshold_dB, table[col], marker="o", ms=3, color=c, label=col)
    ax[1].axhline(base, color="#d6604d", ls=":", lw=1, label="precision without check")
    ax[1].set(xlabel="keep polygons with ΔVH ≤ (dB)", ylim=(0, 1.02), title="Threshold sweep")
    ax[1].legend(frameon=False)
    fig.tight_layout()
    FIG.parent.mkdir(exist_ok=True)
    fig.savefig(FIG, dpi=150)
    print("\n→", FIG)


if __name__ == "__main__":
    main()
