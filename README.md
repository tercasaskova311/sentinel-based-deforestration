# Šumava NP — Forest Disturbance Detection

This repository contains an end-to-end analytical pipeline to detect and classify forest disturbances—primarily logging and bark beetle outbreaks—in the Šumava National Park, Czech Republic. The project integrates **Harmonic Regression Model** baselines generated via Google Earth Engine with advanced, tuned **Machine Learning Classifiers** implemented in Python (`scikit-learn`, `xgboost`). Leveraging multi-temporal Sentinel-2 imagery, the pipeline aims to accurately map yearly disturbances by evaluating robust spatial and temporal features.

## Interactive map (GitHub Pages)

**Live map:** `https://tercasaskova311.github.io/sentinel-2-based-prediction/` — disturbance polygons per year over the Šumava NP zoning (A–D), with area labels, a year switcher, per-zone statistics and click-for-details popups.

The map uses only the non-ML part of the project (harmonic regression on Sentinel-2 NBR). To regenerate it for all years:

1. **Earth Engine** – open `models/harmonic_regression/model_multiyear.js` in the [Code Editor](https://code.earthengine.google.com), press *Run*, then run every `sumava_disturbance_YYYY` task in the *Tasks* tab. Each task writes a vectorised GeoJSON (one polygon per alert patch, with `z_min`, `z_mean`, `scenes_mean`, `first_day`) to Google Drive → `GEE_Sumava/`.
2. **Copy** the downloaded files to `data/gee_exports/`.
3. **Build the web data**: `python scripts/build_site_data.py` – cleans and smooths polygons, clips to the park, splits area by zone, transfers the 2024 tp/fp validation labels and writes `docs/data/`.
4. **Publish**: commit `docs/` and enable *Settings → Pages → Deploy from branch → `main` / `/docs`*.

Changes compared to `model.js`, so years are comparable: a rolling 3-year archive before each detection year, a year-specific forest mask (WorldCover + NDVI of the previous summer), and pixels already alerted in an earlier year are not reported again.

| File | Content |
|------|---------|
| `docs/index.html`, `docs/app.js` | MapLibre GL web map (no build step) |
| `docs/data/disturbance_YYYY.geojson` | Polygons per year: `id`, `area_ha`, `zone`, `ha_A…ha_D`, `first_alert`, `z_min`, `scenes_mean`, `validation` |
| `docs/data/zones.geojson` | NP zoning A–D (AOPK ČR, 2023), simplified |
| `docs/data/summary.json` | Per-year and per-zone totals shown in the side panel |


## Models

### 1 — Harmonic Regression Model
Built in Google Earth Engine, loosely based on the CCDC framework (Zhu & Woodcock, 2014).

### 2 — Machine Learning Models

Implemented in Python (`scikit-learn`, `xgboost`) for robust classification of forest disturbance. Features are evaluated across temporal and spatial dimensions.

---

## Machine Learning — Configuration

The ML pipeline evaluates spatial and time-series cross-validation strategies, applying hyperparameter tuning to find the optimum model configuration. It is heavily recommended to use the **optimium (tuned)** configuration over the default model options, as tuning adjusts the tree depth, learning rate, and estimator counts for maximum spatial generalizability.

### Optimum Hyperparameter Spaces

Models are optimized via Cross-Validated Grid Search to maximize F1-score across folds:

```python
# XGBoost Tuned Params Space
xgb_config = {
    'n_estimators': [50, 100, 200, 300],
    'max_depth': [3, 6, 10],
    'learning_rate': [0.01, 0.1, 0.2]
}

# Random Forest Tuned Params Space
rf_config = {
    'n_estimators': [50, 100, 200],
    'max_depth': [None, 5, 10, 15],
    'min_samples_leaf': [1, 5, 10]
}
```

### Evaluation Strategy

- **Time-Series CV**: Trains on data from earlier years (e.g., 2016-2020) and validates on subsequent years to test temporal generalizability.
- **Spatial CV**: Uses `GroupKFold` on optimal spatial clusters (e.g., K=37 generated via `KMeans`) to ensure models generalize to completely unseen areas.

---

## Harmonic Regression — Configuration

All tunable parameters live in the `CONFIG` object at the top of the script:

```javascript
var CONFIG = {
  archiveStart:    '2020-01-01',   // Start of harmonic model training period
  archiveEnd:      '2024-01-01',   // End of training period (exclusive)
  detectStart:     '2024-01-01',   // Start of detection window
  detectEnd:       '2024-12-31',   // End of detection window
  seasonStart:     4,              // First month of growing season (April)
  seasonEnd:       11,             // Last month of growing season (November)
  numHarmonics:    2,              // 1 = annual only, 2 = annual + semi-annual
  zThreshResidual: -2.5,           // z-score threshold for flagging a scene
  minScenes:       2,              // Minimum alert scenes for persistence filter
  minPatchPx:      50,             // Minimum patch size in pixels (50 px = 0.5 ha)
  maxCloudPct:     50,             // Maximum cloud cover % for scene inclusion
  exportScale:     10,             // Export resolution in metres
  exportCRS:       'EPSG:32633',   // UTM Zone 33N
  exportFolder:    'GEE_Sumava',   // Google Drive output folder
};
```

---

## Outputs

### GEE Exports (Google Drive → `GEE_Sumava/`)

| File | Content |
|------|---------|
| `sumava_alerts_YYYY.tif` | Final disturbance alerts (all types), patch-filtered |
| `sumava_residual_z_YYYY.tif` | Minimum residual z-score across detection season |
| `sumava_scene_count_YYYY.tif` | Number of alert scenes per pixel |
| `sumava_first_day_YYYY.tif` | Day-of-year of first alert (days since Jan 1) |

All outputs are `Float32` GeoTIFFs in `EPSG:32633` at 10 m resolution.

> **Note:** Exports use `.selfMask()`, so masked pixels are written as `NoData` rather than `0`. Verify that your GIS software interprets `NoData` correctly before performing any area calculations.

### Local Machine Learning Outputs

| Artifact | Content |
|----------|---------|
| `models/lr_model_timeseries.joblib` | Logistic Regression model trained via Time-Series CV |
| `models/rf_model_spatial.joblib` | Random Forest model trained via Spatial CV |
| `results/labeled_alerts_24.geojson` | Pre-labeled disturbance alerts for 2024 analysis |
| `results/sumava_czechglobe/training_samples_map.html` | Interactive web map visualizing the spatial distribution of training class samples |
| `results/sumava_czechglobe/final_disturbance_map.html` | Interactive web map of predicted spatial disturbances |

### Console Stats (GEE)

After running, the Console prints:

```
Core forest area (km²)
Persistent alerts pre-forest-mask (ha)
Clean alerts post-forest-mask (ha)
Final alerts post-patch-filter (ha)
Abrupt alerts — logging (ha)
Mean scene count per final alert pixel
```

---

## Harmonic Regression — Detection Results

Area detection metrics based on Harmonic Regression:

| Metric | 2024 (Actual) |
|--------|---------------|
| Archive images | 644 |
| Detection images (season) | 104 |
| Candidate alerts (pre-filters) | 2,285 ha |
| Final alerts post-patch-filter | 423 ha |
| Mean scene count per final alert pixel | 2.97 |

---

## Machine Learning — 2024 & 2025 Detection Area Summaries

**Threshold:** 0.8
Results for detected total physical area (km²) from deployed spatial models:

| Metric | Area Forecast (km²) |
|--------|--------------------|
| **2024 predicted disturbance** | 32.66 km² |
| **2025 Predicted Disturbance** | 14.52 km² |
| **2025 excl. historical** | 8.86 km² |
| **2025 new only (excl. 2024 & historical)** | 5.16 km² |
| **2025 new only as % of 2024 pred.** | 15.81% |

---

## Machine Learning — Cross-Validation Performance

Model performance on the **held-out test set (2022-2024)** utilizing the best-tuned configurations:

| Approach | Best Model | Evaluation Focus | 
|----------|------------|------------------|
| **Spatial CV** | Random Forest | Excellent for generalizing cross-space to unseen locations within the park. |
| **Time-Series CV**| XGBoost | Better at identifying changes strictly based on chronologically prior events. |

*> Evaluating on 7,200 testing samples comparing Time-Series holdouts vs Spatial block holdouts.*

---

## Known Issues & Limitations

**Slow bark beetle decline** — The abruptness filter (`firstAlertFraction < 0.6`) is intended to separate logging from gradual canopy dieback. Bark beetle outbreaks that begin early in the season may be misclassified as logging events.

---

## Dependencies

- Google Earth Engine account with access to `COPERNICUS/S2_SR_HARMONIZED` and `ESA/WorldCover/v200`
- Python ≥ 3.9 with `gdal`, `geopandas`, `shapely`, `scikit-learn`, `xgboost`, `pandas`, and `notebook`
- QGIS (optional) for visual inspection

---

## References

Zhu, Z., & Woodcock, C. E. (2014). Continuous change detection and classification of land cover using all available Landsat data. *Remote Sensing of Environment*, 144, 152–171.

ESA WorldCover 2021 v2.0 — `ESA/WorldCover/v200` via Google Earth Engine.

Copernicus Sentinel-2 Level-2A Surface Reflectance — `COPERNICUS/S2_SR_HARMONIZED` via Google Earth Engine.

---
