// =============================================================================
// ŠUMAVA NP — FOREST DISTURBANCE POLYGONS, MULTI-YEAR (no ML)
// Harmonic regression baseline on Sentinel-2 NBR, run once per detection year,
// vectorised in Earth Engine and exported as one GeoJSON per year.
//
// Run in the Earth Engine Code Editor: https://code.earthengine.google.com
//   1. Paste this script, press Run (preview of the PREVIEW_YEAR appears on the map)
//   2. Open the Tasks tab and run every "sumava_disturbance_YYYY" export
//   3. Download the GeoJSONs from Google Drive → GEE_Sumava/ into
//      data/gee_exports/ of the repo, then run:  python scripts/build_site_data.py
//
// Same method as model.js (CCDC-style harmonic fit, Zhu & Woodcock 2014),
// with three changes so years are comparable:
//   • rolling archive: the harmonic model for year Y is fit on the
//     ARCHIVE_YEARS years just before Y (not a fixed 2020 start)
//   • forest mask is year-specific: WorldCover trees AND summer NDVI > 0.5
//     in the year before Y, so a stand cut in 2020 can still be detected in 2020
//   • optional: pixels already alerted in an earlier year are not re-reported
// =============================================================================

var YEARS        = [2020, 2021, 2022, 2023, 2024, 2025];
var PREVIEW_YEAR = 2024;

var CONFIG = {
  archiveYears:     3,       // years of history used to fit the harmonic model
  earliestArchive:  '2018-01-01',  // S2_SR_HARMONIZED is reliable over CZ from 2018
  seasonStart:      4,       // detection season: April …
  seasonEnd:        11,      // … November
  numHarmonics:     2,       // 1 = annual, 2 = annual + semi-annual
  zThreshResidual: -2.5,     // scene flagged if residual z < threshold
  minScenes:        2,       // persistence: flagged in ≥ N scenes
  minPatchPx:       30,      // 30 px × 100 m² = 0.3 ha minimum polygon
  maxCloudPct:      50,
  excludePriorAlerts: true,  // don't re-report pixels alerted in an earlier year
  exportScale:      10,
  exportCRS:        'EPSG:32633',
  exportFolder:     'GEE_Sumava'
};

// -----------------------------------------------------------------------------
// 1. AOI — Šumava NP from WDPA (same as src/data.py)
// -----------------------------------------------------------------------------
var aoi = ee.FeatureCollection('WCMC/WDPA/current/polygons')
  .filter(ee.Filter.eq('NAME', 'Šumava'))
  .filter(ee.Filter.eq('DESIG', 'Národní park (NP)'))
  .geometry().dissolve();

// -----------------------------------------------------------------------------
// 2. Sentinel-2 preprocessing
// -----------------------------------------------------------------------------
function scaleS2(img) {
  return img.select('B.*').multiply(0.0001)
    .addBands(img.select('SCL'))
    .copyProperties(img, img.propertyNames());
}
function maskClouds(img) {
  var scl = img.select('SCL');
  var bad = scl.eq(3).or(scl.eq(8)).or(scl.eq(9)).or(scl.eq(10)).or(scl.eq(11));
  return img.updateMask(bad.not());
}
function addNBR(img) {
  var nbr = img.normalizedDifference(['B8', 'B12']).rename('NBR');
  return nbr.copyProperties(img, ['system:time_start', 'system:index']);
}
function s2(start, end) {
  return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(aoi)
    .filterDate(start, end)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', CONFIG.maxCloudPct))
    .map(scaleS2)
    .map(maskClouds);
}

// -----------------------------------------------------------------------------
// 3. Year-specific forest mask
// -----------------------------------------------------------------------------
function forestMask(year) {
  // WorldCover v100 (2020) for early years, v200 (2021) afterwards
  var wc = year <= 2021
    ? ee.ImageCollection('ESA/WorldCover/v100').first()
    : ee.ImageCollection('ESA/WorldCover/v200').first();
  var prev = year - 1;
  var ndvi = s2(prev + '-06-01', prev + '-09-01')
    .map(function(img) { return img.normalizedDifference(['B8', 'B4']).rename('NDVI'); })
    .median();
  return wc.select('Map').eq(10)
    .and(ndvi.gt(0.5))
    .focalMin({radius: 1, kernelType: 'square', units: 'pixels'})
    .rename('forest').selfMask().clip(aoi);
}

// -----------------------------------------------------------------------------
// 4. Harmonic model helpers
// -----------------------------------------------------------------------------
var omega = 2.0 * Math.PI;
var predictors = CONFIG.numHarmonics >= 2
  ? ['constant', 't', 'sin1', 'cos1', 'sin2', 'cos2']
  : ['constant', 't', 'sin1', 'cos1'];

function harmonicBands(img, refDate) {
  var t = ee.Image(img.date().difference(refDate, 'year')).float().rename('t');
  var bands = ee.Image.constant(1).float().rename('constant')
    .addBands(t)
    .addBands(t.multiply(omega).sin().rename('sin1'))
    .addBands(t.multiply(omega).cos().rename('cos1'))
    .addBands(t.multiply(2 * omega).sin().rename('sin2'))
    .addBands(t.multiply(2 * omega).cos().rename('cos2'));
  return bands.select(predictors);
}

// -----------------------------------------------------------------------------
// 5. Detection for one year → alert image + per-pixel attributes
// -----------------------------------------------------------------------------
function detectYear(year) {
  var archStartYear = Math.max(year - CONFIG.archiveYears, 2018);
  var archiveStart  = archStartYear === 2018 ? CONFIG.earliestArchive : archStartYear + '-01-01';
  var archiveEnd    = year + '-01-01';
  var refDate       = ee.Date(archiveStart);

  var archive = s2(archiveStart, archiveEnd).map(addNBR);
  var detection = s2(year + '-01-01', (year + 1) + '-01-01')
    .filter(ee.Filter.calendarRange(CONFIG.seasonStart, CONFIG.seasonEnd, 'month'))
    .map(addNBR);

  // fit
  var fit = archive.map(function(img) {
      return harmonicBands(img, refDate).addBands(img.select('NBR'))
        .copyProperties(img, ['system:time_start']);
    })
    .reduce(ee.Reducer.linearRegression({numX: predictors.length, numY: 1}));
  var coef = fit.select('coefficients').arrayFlatten([predictors, ['NBR']])
    .select(predictors.map(function(p) { return p + '_NBR'; }), predictors);

  function residual(img) {
    var pred = harmonicBands(img, refDate).multiply(coef).reduce(ee.Reducer.sum());
    return img.select('NBR').subtract(pred).rename('res')
      .copyProperties(img, ['system:time_start']);
  }

  var rmse = archive.map(residual)
    .map(function(img) { return img.pow(2); })
    .mean().sqrt().max(0.005);

  var detectStartMs = ee.Date(year + '-01-01').millis();
  var residZ = detection.map(function(img) {
    var z = residual(img).divide(rmse).rename('z');
    var day = ee.Image.constant(
      img.date().millis().subtract(detectStartMs).divide(86400000)
    ).toFloat().rename('day').updateMask(z.lt(CONFIG.zThreshResidual));
    return z.addBands(day).set('system:time_start', img.get('system:time_start'));
  });

  var z = residZ.select('z');
  var alertCount = z.map(function(img) { return img.lt(CONFIG.zThreshResidual); })
    .sum().rename('scenes');
  var zMin     = z.min().rename('z_min');
  var firstDay = residZ.select('day').min().rename('first_day');

  // filters: persistence → forest → not already degrading (negative trend)
  var degrading = coef.select('t').divide(rmse).lt(-0.5);
  var alert = alertCount.gte(CONFIG.minScenes)
    .updateMask(forestMask(year))
    .updateMask(degrading.not())
    .selfMask();

  return {
    alert: alert.rename('alert'),
    attrs: zMin.addBands(alertCount).addBands(firstDay),
    nImages: detection.size(),
    nArchive: archive.size()
  };
}

// -----------------------------------------------------------------------------
// 6. Loop over years: optional prior-alert exclusion, patch filter, vectorise
// -----------------------------------------------------------------------------
var priorAlerts = ee.Image(0).selfMask(); // empty
var previewAlert = null;

YEARS.forEach(function(year) {
  var res = detectYear(year);
  var alert = res.alert;

  if (CONFIG.excludePriorAlerts) {
    alert = alert.updateMask(priorAlerts.unmask(0).not());
  }

  var patchPx = alert.connectedPixelCount({maxSize: 1024, eightConnected: true});
  alert = alert.updateMask(patchPx.gte(CONFIG.minPatchPx)).clip(aoi);

  priorAlerts = priorAlerts.unmask(0).or(alert.unmask(0)).selfMask();
  if (year === PREVIEW_YEAR) { previewAlert = alert; }

  var reducer = ee.Reducer.mean().forEach(['z_mean'])
    .combine(ee.Reducer.min().forEach(['z_min']), '', false)
    .combine(ee.Reducer.mean().forEach(['scenes_mean']), '', false)
    .combine(ee.Reducer.min().forEach(['first_day']), '', false);

  var attrs = res.attrs; // z_min, scenes, first_day
  var vectors = alert.toInt()
    .addBands(attrs.select('z_min'))   // → z_mean
    .addBands(attrs.select('z_min'))   // → z_min
    .addBands(attrs.select('scenes'))  // → scenes_mean
    .addBands(attrs.select('first_day'))
    .reduceToVectors({
      reducer: reducer,
      geometry: aoi,
      scale: CONFIG.exportScale,
      crs: CONFIG.exportCRS,
      geometryType: 'polygon',
      eightConnected: true,
      labelProperty: 'alert',
      maxPixels: 1e11,
      tileScale: 4
    })
    .map(function(f) {
      return f.set({
        year: year,
        area_ha: f.geometry().area(1).divide(1e4),
        method: 'harmonic_nbr'
      });
    });

  Export.table.toDrive({
    collection: vectors,
    description: 'sumava_disturbance_' + year,
    folder: CONFIG.exportFolder,
    fileNamePrefix: 'sumava_disturbance_' + year,
    fileFormat: 'GeoJSON'
  });

  print(year, 'archive imgs:', res.nArchive, 'season imgs:', res.nImages);
});

// -----------------------------------------------------------------------------
// 7. Preview
// -----------------------------------------------------------------------------
Map.centerObject(aoi, 10);
Map.setOptions('SATELLITE');
Map.addLayer(ee.Image().paint(ee.FeatureCollection([ee.Feature(aoi)]), 0, 2),
  {palette: ['00ffff']}, 'Šumava NP');
if (previewAlert) {
  Map.addLayer(previewAlert, {palette: ['ff5500']}, 'Disturbance ' + PREVIEW_YEAR);
  print('Alert area ' + PREVIEW_YEAR + ' (ha):', ee.Number(
    previewAlert.multiply(ee.Image.pixelArea()).reduceRegion({
      reducer: ee.Reducer.sum(), geometry: aoi, scale: 20,
      maxPixels: 1e10, bestEffort: true
    }).get('alert')).divide(1e4).round());
}
