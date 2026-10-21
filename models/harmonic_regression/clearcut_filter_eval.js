// =============================================================================
// ŠUMAVA NP — DOES THE SENTINEL-1 CLEAR-CUT CHECK WORK?  (evaluation, no ML)
// Scores the radar check on your 199 hand-labelled 2024 polygons (tp / fp).
//
// 1. Upload results/labeled_alerts_24.geojson as a table asset
//    (Assets → NEW → Shape/GeoJSON) and put its path in LABELLED_ASSET.
// 2. Run. The Console prints precision / recall / F1 for a range of ΔVH thresholds.
// 3. Run the export task, download the GeoJSON into results/, then
//      python scripts/eval_clearcut_filter.py
//    for the same table split by NP zone, plus a plot.
// =============================================================================

var LABELLED_ASSET = 'projects/disturbance-detection/assets/labeled_alerts_24';  // ← your path
var YEAR = 2024;
var THRESHOLDS = [-0.5, -0.75, -1.0, -1.25, -1.5, -2.0, -2.5, -3.0];

var aoi = ee.FeatureCollection('WCMC/WDPA/current/polygons')
  .filter(ee.Filter.eq('NAME', 'Šumava'))
  .filter(ee.Filter.eq('DESIG', 'Národní park (NP)'))
  .geometry().dissolve();

// -----------------------------------------------------------------------------
// CLEAR-CUT CHECK — Sentinel-1 VH backscatter (radar sees structure, not colour)
// A clear-cut removes the canopy volume → VH drops by several dB.
// Bark-beetle dieback leaves stems and branches standing → VH changes little.
// For every polygon: ΔVH = median(after) − median(before), same months, compared
// per relative orbit (so the S1-B loss in Dec 2021 doesn't bias the difference),
// then minus the ΔVH of a forest ring around the polygon (cancels moisture/season).
// -----------------------------------------------------------------------------
var S1 = {
  months:      [6, 9],    // compare June–September of the year before vs the year after
  ringM:       100,       // width of the reference ring around each polygon (m)
  vhThreshold: -1.5,      // dvh_rel ≤ threshold (dB) → clearcut = 1  (tune with clearcut_filter_eval.js)
  minScenes:   3          // per orbit and period
};

function s1Collection() {
  return ee.ImageCollection('COPERNICUS/S1_GRD')
    .filterBounds(aoi)
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
    .filter(ee.Filter.calendarRange(S1.months[0], S1.months[1], 'month'))
    .select('VH');                                   // already in dB
}

function deltaVH(year) {
  // after = same months of year+1 when it is complete, otherwise of the detection year itself
  var now = new Date();
  var postYear = (year + 1 < now.getFullYear() ||
                  (year + 1 === now.getFullYear() && now.getMonth() + 1 > S1.months[1])) ? year + 1 : year;
  var col  = s1Collection();
  var pre  = col.filterDate((year - 1) + '-01-01', year + '-01-01');
  var post = col.filterDate(postYear + '-01-01', (postYear + 1) + '-01-01');
  var orbits = pre.aggregate_array('relativeOrbitNumber_start').distinct();
  var diffs = orbits.map(function(o) {
    var a = pre.filter(ee.Filter.eq('relativeOrbitNumber_start', o));
    var b = post.filter(ee.Filter.eq('relativeOrbitNumber_start', o));
    return ee.Algorithms.If(a.size().gte(S1.minScenes).and(b.size().gte(S1.minScenes)),
      b.median().subtract(a.median()).rename('dVH'), null);
  }, true);
  return ee.ImageCollection.fromImages(diffs).mean().rename('dVH').set('post_year', postYear);
}

function addS1(fc, year) {
  var dvh  = deltaVH(year);
  var tree = ee.ImageCollection('ESA/WorldCover/v200').first().eq(10);
  return fc.map(function(f) {
    var g = f.geometry();
    var ring = g.buffer(S1.ringM, 5).difference(g, 5);
    var inPoly = dvh.reduceRegion({reducer: ee.Reducer.mean(), geometry: g, scale: 10, maxPixels: 1e8}).get('dVH');
    var inRing = dvh.updateMask(tree).reduceRegion({reducer: ee.Reducer.mean(), geometry: ring, scale: 10, maxPixels: 1e8}).get('dVH');
    var rel = ee.Algorithms.If(ee.Algorithms.IsEqual(inPoly, null), null,
      ee.Number(inPoly).subtract(ee.Algorithms.If(ee.Algorithms.IsEqual(inRing, null), 0, inRing)));
    return f.set({
      dvh_poly: inPoly,
      dvh_ring: inRing,
      dvh_rel: rel,
      clearcut: ee.Algorithms.If(ee.Algorithms.IsEqual(rel, null), null,
        ee.Number(rel).lte(S1.vhThreshold).int()),
      s1_post_year: dvh.get('post_year')
    });
  });
}

var labelled = ee.FeatureCollection(LABELLED_ASSET)
  .filter(ee.Filter.inList('label', ['tp', 'fp']));
var scored = addS1(labelled, YEAR)
  .filter(ee.Filter.notNull(['dvh_rel']));

print('Labelled polygons with S1 data:', scored.size());
print('Median dvh_rel (dB) — tp:',
  scored.filter(ee.Filter.eq('label', 'tp')).aggregate_array('dvh_rel').reduce(ee.Reducer.median()),
  '— fp:',
  scored.filter(ee.Filter.eq('label', 'fp')).aggregate_array('dvh_rel').reduce(ee.Reducer.median()));

var nTp = scored.filter(ee.Filter.eq('label', 'tp')).size();
var rows = ee.FeatureCollection(THRESHOLDS.map(function(t) {
  var kept = scored.filter(ee.Filter.lte('dvh_rel', t));
  var tp = kept.filter(ee.Filter.eq('label', 'tp')).size();
  var n = kept.size();
  var precision = ee.Number(tp).divide(ee.Number(n).max(1));
  var recall = ee.Number(tp).divide(nTp);
  return ee.Feature(null, {
    threshold_dB: t, kept: n, tp: tp,
    precision: precision, recall: recall,
    f1: precision.multiply(recall).multiply(2).divide(precision.add(recall).max(1e-9))
  });
}));
print('Threshold sweep (precision on clear-cut labels)', rows);
print(ui.Chart.feature.byFeature(rows, 'threshold_dB', ['precision', 'recall', 'f1'])
  .setOptions({title: 'Sentinel-1 ΔVH threshold vs precision / recall', hAxis: {title: 'dvh_rel ≤ (dB)'}}));
print(ui.Chart.feature.histogram(scored.filter(ee.Filter.eq('label', 'tp')), 'dvh_rel', 30)
  .setOptions({title: 'dvh_rel — confirmed clear-cuts (tp)'}));
print(ui.Chart.feature.histogram(scored.filter(ee.Filter.eq('label', 'fp')), 'dvh_rel', 30)
  .setOptions({title: 'dvh_rel — false alarms (fp)'}));

Export.table.toDrive({
  collection: scored,
  description: 'labeled_alerts_24_s1',
  folder: 'GEE_Sumava',
  fileNamePrefix: 'labeled_alerts_24_s1',
  fileFormat: 'GeoJSON'
});

Map.centerObject(aoi, 11);
Map.addLayer(deltaVH(YEAR), {min: -4, max: 2, palette: ['b2182b', 'ef8a62', 'f7f7f7', '67a9cf']}, 'ΔVH (dB)');
Map.addLayer(scored.filter(ee.Filter.eq('label', 'tp')), {color: '00ff00'}, 'tp');
Map.addLayer(scored.filter(ee.Filter.eq('label', 'fp')), {color: 'ff00ff'}, 'fp');
