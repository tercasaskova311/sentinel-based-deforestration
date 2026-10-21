// =============================================================================
// ŠUMAVA NP — YEARLY SENTINEL-2 SUMMER COMPOSITES FOR THE WEB MAP
// One true-colour and one false-colour (SWIR2-NIR-Red) image per year,
// same fixed stretch for every year so they can be compared by eye.
//
// Run in the Earth Engine Code Editor, start all tasks, download the GeoTIFFs
// from Drive → GEE_Sumava_imagery/ into data/imagery/, then:
//   python scripts/make_imagery_tiles.py
//
// False colour: healthy forest = green, fresh clear-cut / bare soil = magenta-pink,
// dead standing spruce = dull brown-grey (still has structure, no bare soil).
// =============================================================================

var YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
var WINDOW = {start: '-06-15', end: '-09-15'};   // late summer: cuts of the year are visible
var CS_THRESHOLD = 0.65;                          // Cloud Score+ cs_cdf, higher = clearer

var aoi = ee.FeatureCollection('WCMC/WDPA/current/polygons')
  .filter(ee.Filter.eq('NAME', 'Šumava'))
  .filter(ee.Filter.eq('DESIG', 'Národní park (NP)'))
  .geometry().dissolve().buffer(500);

var VIS = {
  'true':  {bands: ['B4', 'B3', 'B2'],  min: 0, max: [0.10, 0.10, 0.09], gamma: 1.4},
  'false': {bands: ['B12', 'B8', 'B4'], min: 0, max: [0.25, 0.42, 0.12], gamma: 1.2}
};

function composite(year) {
  var cs = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
  return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(aoi)
    .filterDate(year + WINDOW.start, year + WINDOW.end)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 60))
    .linkCollection(cs, ['cs_cdf'])
    .map(function(img) {
      return img.updateMask(img.select('cs_cdf').gte(CS_THRESHOLD))
        .select(['B2', 'B3', 'B4', 'B8', 'B12']).multiply(0.0001);
    })
    .median()
    .clip(aoi);
}

YEARS.forEach(function(year) {
  var img = composite(year);
  ['true', 'false'].forEach(function(style) {
    var rgb = img.visualize(VIS[style]);  // → uint8 RGB
    Export.image.toDrive({
      image: rgb,
      description: 'sumava_s2_' + style + '_' + year,
      folder: 'GEE_Sumava_imagery',
      fileNamePrefix: 'sumava_s2_' + style + '_' + year,
      region: aoi.bounds(),
      scale: 10,
      crs: 'EPSG:32633',
      maxPixels: 1e10,
      formatOptions: {cloudOptimized: true}
    });
  });
});

// preview
var y = 2024;
Map.centerObject(aoi, 11);
Map.addLayer(composite(y - 1), VIS['false'], 'False colour ' + (y - 1), false);
Map.addLayer(composite(y), VIS['false'], 'False colour ' + y);
Map.addLayer(composite(y), VIS['true'], 'True colour ' + y, false);
