/* Šumava forest disturbance — interactive map (MapLibre GL) */
(async function () {
  const PLANNED_YEARS = [2020, 2021, 2022, 2023, 2024, 2025];
  const ZONE_COLORS = { A: '#2f9e7d', B: '#8cc084', C: '#e3b84f', D: '#a993d6' };
  const YEAR_COLORS = ['#fde68a', '#fdba74', '#fb923c', '#f97316', '#ea580c', '#c2410c', '#9a3412'];
  const ACCENT = '#ff5a1f';
  const fmt = (n, d = 0) => n.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });

  const summary = await fetch('data/summary.json').then(r => r.json());
  const years = summary.years.map(y => y.year).sort();
  const allYears = [...new Set([...PLANNED_YEARS, ...years])].sort();
  const yearColor = y => YEAR_COLORS[Math.max(0, allYears.indexOf(y)) % YEAR_COLORS.length];

  const yearData = await Promise.all(years.map(y => fetch(`data/disturbance_${y}.geojson`).then(r => r.json())));
  const features = yearData.flatMap(fc => fc.features);
  const dist = { type: 'FeatureCollection', features };

  // ---------------- state ----------------
  const hashYear = new URLSearchParams(location.hash.slice(1)).get('year');
  const state = {
    year: hashYear === 'all' ? 'all' : (years.includes(+hashYear) ? +hashYear : years[years.length - 1]),
    zones: new Set(['A', 'B', 'C', 'D']),
    basemap: 'sat', labels: true, zoneFill: true, validated: false
  };

  // ---------------- map ----------------
  const map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/positron',
    center: [13.55, 48.98], zoom: 9.6, maxZoom: 17.5,
    attributionControl: { compact: true }
  });
  window.sumavaMap = map;
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

  map.on('load', () => {
    const firstLabel = map.getStyle().layers.find(l => l.type === 'symbol')?.id;

    map.addSource('esri', {
      type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics'
    });
    map.addLayer({ id: 'esri', type: 'raster', source: 'esri', paint: { 'raster-saturation': -0.25, 'raster-brightness-max': 0.85 } }, firstLabel);

    map.addSource('zones', { type: 'geojson', data: 'data/zones.geojson' });
    map.addSource('zone-labels', { type: 'geojson', data: 'data/zone_labels.geojson' });
    map.addSource('dist', { type: 'geojson', data: dist, promoteId: 'id' });

    const zoneColor = ['match', ['get', 'zone'], 'A', ZONE_COLORS.A, 'B', ZONE_COLORS.B, 'C', ZONE_COLORS.C, ZONE_COLORS.D];
    map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones', paint: { 'fill-color': zoneColor, 'fill-opacity': 0.16 } });
    map.addLayer({ id: 'zones-line', type: 'line', source: 'zones',
      paint: { 'line-color': zoneColor, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 14, 2.2], 'line-opacity': 0.9 } });

    map.addLayer({ id: 'dist-fill', type: 'fill', source: 'dist',
      paint: { 'fill-color': ACCENT, 'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.85, 0.62] } });
    map.addLayer({ id: 'dist-line', type: 'line', source: 'dist',
      paint: { 'line-color': '#fff4ec', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.3, 14, 1.2], 'line-opacity': 0.85 } });
    map.addLayer({ id: 'dist-hover', type: 'line', source: 'dist',
      paint: { 'line-color': '#ffffff', 'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.6, 0] } });

    // Labels live in their own point source: a missing glyph can then never break polygon tiles.
    // Use a font the basemap style really ships (prefer a bold face).
    const styleFonts = map.getStyle().layers.map(l => l.layout && l.layout['text-font'])
      .filter(f => Array.isArray(f) && typeof f[0] === 'string').map(f => f[0]);
    const font = [styleFonts.find(f => /bold/i.test(f)) || styleFonts[0] || 'Noto Sans Bold'];
    map.addSource('dist-labels', { type: 'geojson', data: {
      type: 'FeatureCollection',
      features: features.map(f => ({ type: 'Feature', properties: f.properties,
        geometry: { type: 'Point', coordinates: [f.properties.lx, f.properties.ly] } }))
    } });

    const labelPaint = { 'text-color': '#ffffff', 'text-halo-color': 'rgba(26,13,6,.85)', 'text-halo-width': 1.4 };
    map.addLayer({ id: 'zone-label', type: 'symbol', source: 'zone-labels', maxzoom: 13,
      layout: { 'text-field': ['get', 'label'], 'text-font': font, 'text-size': 13,
        'text-letter-spacing': 0.08, 'text-transform': 'uppercase', 'text-allow-overlap': false },
      paint: { 'text-color': zoneColor, 'text-halo-color': 'rgba(10,18,15,.9)', 'text-halo-width': 1.6 } });
    map.addLayer({ id: 'dist-label-big', type: 'symbol', source: 'dist-labels', minzoom: 11.5, maxzoom: 13.5,
      layout: { 'text-field': ['get', 'label_text'], 'text-font': font, 'text-size': 11,
        'symbol-sort-key': ['-', ['get', 'area_ha']] },
      paint: labelPaint });
    map.addLayer({ id: 'dist-label', type: 'symbol', source: 'dist-labels', minzoom: 13.5,
      layout: { 'text-field': ['format', ['get', 'label_text'], {}, '\n', {}, ['get', 'id'], { 'font-scale': 0.8 }],
        'text-font': font, 'text-size': 12, 'symbol-sort-key': ['-', ['get', 'area_ha']] },
      paint: labelPaint });

    // fit to park
    fetch('data/zones.geojson').then(r => r.json()).then(z => {
      const b = new maplibregl.LngLatBounds();
      z.features.forEach(f => f.geometry.coordinates.flat(2).forEach(c => b.extend(c)));
      if (!hashYear) map.fitBounds(b, { padding: 30, duration: 0 });
    });

    applyState();
    wireInteractions();
  });

  // ---------------- filters / styling ----------------
  function distFilter(extra = []) {
    const f = ['all', ['in', ['get', 'zone'], ['literal', [...state.zones]]]];
    if (state.year !== 'all') f.push(['==', ['get', 'year'], state.year]);
    if (state.validated) f.push(['has', 'validation']);
    return f.concat(extra);
  }

  function applyState() {
    if (!map.isStyleLoaded() || !map.getLayer('dist-fill')) { renderPanel(); return; }
    const df = distFilter();
    ['dist-fill', 'dist-line', 'dist-hover', 'dist-label'].forEach(l => map.setFilter(l, df));
    map.setFilter('dist-label-big', distFilter([['>=', ['get', 'area_ha'], 2]]));

    const yc = ['match', ['get', 'year']];
    allYears.forEach(y => yc.push(y, yearColor(y)));
    yc.push(ACCENT);
    map.setPaintProperty('dist-fill', 'fill-color', state.year === 'all' ? yc : ACCENT);

    const zf = ['in', ['get', 'zone'], ['literal', [...state.zones]]];
    ['zones-fill', 'zones-line', 'zone-label'].forEach(l => map.setFilter(l, zf));
    map.setLayoutProperty('zones-fill', 'visibility', state.zoneFill ? 'visible' : 'none');
    ['dist-label', 'dist-label-big'].forEach(l => map.setLayoutProperty(l, 'visibility', state.labels ? 'visible' : 'none'));

    const sat = state.basemap === 'sat';
    map.setLayoutProperty('esri', 'visibility', sat ? 'visible' : 'none');
    map.setPaintProperty('zones-fill', 'fill-opacity', sat ? 0.16 : 0.22);
    map.setPaintProperty('dist-line', 'line-color', sat ? '#fff4ec' : '#7c2d12');
    renderPanel();
    history.replaceState(null, '', `#year=${state.year}`);
  }

  // ---------------- panel ----------------
  const $ = id => document.getElementById(id);

  function selectedFeatures() {
    return features.filter(f => {
      const p = f.properties;
      if (state.year !== 'all' && p.year !== state.year) return false;
      if (!state.zones.has(p.zone)) return false;
      if (state.validated && !p.validation) return false;
      return true;
    });
  }

  function renderYears() {
    const el = $('years');
    el.innerHTML = '';
    const mk = (label, value, enabled) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('aria-pressed', String(state.year === value));
      if (!enabled) { b.disabled = true; b.style.opacity = .35; b.style.cursor = 'not-allowed'; b.title = 'Not exported yet'; }
      else b.onclick = () => { stopPlay(); state.year = value; applyState(); };
      el.appendChild(b);
    };
    allYears.forEach(y => mk(String(y), y, years.includes(y)));
    if (years.length > 1) {
      mk('All', 'all', true);
      const p = document.createElement('button');
      p.className = 'play'; p.title = 'Play through years'; p.setAttribute('aria-label', 'Play through years');
      p.textContent = playing ? '❚❚' : '▶';
      p.setAttribute('aria-pressed', 'false');
      p.onclick = () => (playing ? stopPlay() : startPlay());
      el.appendChild(p);
    }
  }

  function renderChart() {
    const W = 356, H = 120, padB = 18, padT = 14;
    const bw = W / allYears.length;
    const max = Math.max(1, ...summary.years.map(s => s.total_ha));
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Detected disturbance area per year, stacked by zone">`;
    allYears.forEach((y, i) => {
      const s = summary.years.find(s => s.year === y);
      const x = i * bw + bw * 0.18, w = bw * 0.64;
      const active = state.year === y || state.year === 'all';
      if (!s) {
        svg += `<rect x="${x}" y="${H - padB - 2}" width="${w}" height="2" fill="#2a3a33"/>`;
      } else {
        let yTop = H - padB;
        ['A', 'B', 'C', 'D'].forEach(z => {
          if (!state.zones.has(z)) return;
          const h = (s.by_zone_ha[z] / max) * (H - padB - padT);
          yTop -= h;
          svg += `<rect class="bar" data-y="${y}" x="${x}" y="${yTop}" width="${w}" height="${h}" fill="${ZONE_COLORS[z]}" opacity="${active ? 1 : .35}"><title>${y} · zone ${z}: ${fmt(s.by_zone_ha[z])} ha</title></rect>`;
        });
        svg += `<text x="${x + w / 2}" y="${yTop - 4}" text-anchor="middle">${fmt(s.total_ha)}</text>`;
      }
      svg += `<text x="${x + w / 2}" y="${H - 4}" text-anchor="middle" ${state.year === y ? 'style="fill:#e8efe9;font-weight:600"' : ''}>${y}</text>`;
    });
    svg += '</svg>';
    const legend = state.year === 'all'
      ? `<div class="legend" style="margin-top:8px">${years.map(y => `<span><i style="background:${yearColor(y)}"></i>${y}</span>`).join('')}</div>`
      : '';
    $('chart').innerHTML = svg + '<p class="note">Hectares detected per year, stacked by zone.' +
      (state.year === 'all' ? ' On the map, polygons are coloured by year:' : '') + '</p>' + legend;
    $('chart').querySelectorAll('.bar').forEach(b => b.onclick = () => { stopPlay(); state.year = +b.dataset.y; applyState(); });
  }

  function renderStats(sel) {
    const areas = sel.map(f => f.properties.area_ha).sort((a, b) => a - b);
    const total = areas.reduce((a, b) => a + b, 0);
    const median = areas.length ? areas[Math.floor(areas.length / 2)] : 0;
    const tp = sel.filter(f => f.properties.validation === 'confirmed').length;
    const fp = sel.filter(f => f.properties.validation === 'false alarm').length;
    $('stats-title').textContent = state.year === 'all' ? 'Detected disturbance, all years' : `Detected disturbance, ${state.year}`;
    const tiles = [
      [`${fmt(total, total < 100 ? 1 : 0)} ha`, `${fmt(total / 100, 2)} km² of forest`],
      [fmt(sel.length), 'polygons ≥ 0.3 ha'],
      [`${fmt(areas.at(-1) || 0, 1)} ha`, 'largest patch'],
      [`${fmt(median, 2)} ha`, 'median patch']
    ];
    if (tp + fp) tiles.push([`${Math.round(100 * tp / (tp + fp))} %`, `precision (${tp} of ${tp + fp} checked)`]);
    $('stats').innerHTML = tiles.map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');
    const legacy = sel.some(f => f.properties.source === 'harmonic_2024_legacy');
    $('stats-note').textContent = legacy
      ? '2024 comes from the original single-year run; patches were visually checked against imagery where labelled.'
      : '';
  }

  function renderZones() {
    // ignore the zone toggles here so the numbers stay stable while zones are switched on/off
    const sel = features.filter(f => (state.year === 'all' || f.properties.year === state.year)
      && (!state.validated || f.properties.validation));
    const byZone = { A: 0, B: 0, C: 0, D: 0 };
    sel.forEach(f => ['A', 'B', 'C', 'D'].forEach(z => byZone[z] += f.properties[`ha_${z}`] || 0));
    const max = Math.max(1, ...Object.values(byZone));
    $('zones').innerHTML = ['A', 'B', 'C', 'D'].map(z => {
      const info = summary.zones[z] || {};
      return `<label class="zone-row" style="--c:${ZONE_COLORS[z]};opacity:${state.zones.has(z) ? 1 : .45}" title="${info.desc || ''}">
        <input type="checkbox" data-z="${z}" ${state.zones.has(z) ? 'checked' : ''}>
        <div><div class="zn">Zone ${z} · ${info.name || ''}</div>
          <div class="zd">${info.cz || ''} · ${fmt(info.area_km2 || 0)} km²</div>
          <div class="zbar"><i style="width:${(100 * byZone[z] / max).toFixed(1)}%"></i></div></div>
        <div class="zv">${fmt(byZone[z], 1)} ha</div></label>`;
    }).join('');
    $('zones').querySelectorAll('input').forEach(i => i.onchange = () => {
      i.checked ? state.zones.add(i.dataset.z) : state.zones.delete(i.dataset.z);
      applyState();
    });
  }

  function renderTop(sel) {
    const top = [...sel].sort((a, b) => b.properties.area_ha - a.properties.area_ha).slice(0, 8);
    $('top').innerHTML = top.length ? top.map(f => {
      const p = f.properties;
      return `<li data-id="${p.id}"><span>${p.id}<span class="zchip" style="background:${ZONE_COLORS[p.zone]}">${p.zone}</span></span><span class="ha">${fmt(p.area_ha, 1)} ha</span></li>`;
    }).join('') : '<li class="empty">No polygons for this selection.</li>';
    $('top').querySelectorAll('li[data-id]').forEach(li => li.onclick = () => {
      const f = features.find(f => f.properties.id === li.dataset.id);
      zoomTo(f); openPopup(f, centroid(f));
    });
  }

  function renderPanel() {
    const sel = selectedFeatures();
    renderYears(); renderChart(); renderStats(sel); renderZones(); renderTop(sel);
    document.querySelectorAll('#basemap button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.b === state.basemap)));
  }

  // ---------------- geometry helpers ----------------
  function bbox(f) {
    const b = new maplibregl.LngLatBounds();
    const walk = c => typeof c[0] === 'number' ? b.extend(c) : c.forEach(walk);
    walk(f.geometry.coordinates);
    return b;
  }
  const centroid = f => bbox(f).getCenter();
  function zoomTo(f) { map.fitBounds(bbox(f), { padding: 120, maxZoom: 15.5, duration: 900 }); }

  // ---------------- popup ----------------
  let popup;
  function openPopup(f, lngLat) {
    const p = f.properties;
    const zone = summary.zones[p.zone] || {};
    const badge = p.validation === 'confirmed' ? '<span class="badge ok">confirmed</span>'
      : p.validation === 'false alarm' ? '<span class="badge fa">false alarm</span>'
      : '<span class="badge na">not checked</span>';
    const split = ['A', 'B', 'C', 'D'].filter(z => p[`ha_${z}`] > 0.05)
      .map(z => `${z} ${fmt(p[`ha_${z}`], 1)}`).join(' · ');
    const rows = [
      ['Area', `${fmt(p.area_ha, 2)} ha`],
      ['Zone', `${p.zone} · ${zone.name || ''}`],
      split.includes('·') ? ['Split (ha)', split] : null,
      p.first_alert ? ['First alert', p.first_alert] : null,
      p.scenes_mean != null ? ['Alert scenes', fmt(p.scenes_mean, 1)] : null,
      p.z_min != null ? ['Min residual z', fmt(p.z_min, 2)] : null,
      ['Validation', badge]
    ].filter(Boolean);
    const html = `<div class="pp"><h3>${p.id}</h3><div class="sub">Forest disturbance · ${p.year}</div>
      <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>`;
    popup?.remove();
    popup = new maplibregl.Popup({ maxWidth: '300px', offset: 6 }).setLngLat(lngLat).setHTML(html).addTo(map);
  }

  // ---------------- interactions ----------------
  function wireInteractions() {
    let hovered = null;
    map.on('mousemove', 'dist-fill', e => {
      map.getCanvas().style.cursor = 'pointer';
      const id = e.features[0].id;
      if (hovered !== id) {
        if (hovered) map.setFeatureState({ source: 'dist', id: hovered }, { hover: false });
        hovered = id; map.setFeatureState({ source: 'dist', id }, { hover: true });
      }
    });
    map.on('mouseleave', 'dist-fill', () => {
      map.getCanvas().style.cursor = '';
      if (hovered) map.setFeatureState({ source: 'dist', id: hovered }, { hover: false });
      hovered = null;
    });
    map.on('click', 'dist-fill', e => {
      const f = features.find(x => x.properties.id === e.features[0].properties.id);
      openPopup(f, e.lngLat);
      document.getElementById('hint').style.display = 'none';
    });
  }

  document.querySelectorAll('#basemap button').forEach(b => b.onclick = () => { state.basemap = b.dataset.b; applyState(); });
  $('t-labels').onchange = e => { state.labels = e.target.checked; applyState(); };
  $('t-zonefill').onchange = e => { state.zoneFill = e.target.checked; applyState(); };
  $('t-validated').onchange = e => { state.validated = e.target.checked; applyState(); };
  if (!features.some(f => f.properties.validation)) $('t-validated').closest('label').style.display = 'none';

  // ---------------- play ----------------
  let playing = null;
  function startPlay() {
    let i = state.year === 'all' ? -1 : years.indexOf(state.year);
    const step = () => { i = (i + 1) % years.length; state.year = years[i]; applyState(); };
    step(); playing = setInterval(step, 1600); renderYears();
  }
  function stopPlay() { if (playing) { clearInterval(playing); playing = null; renderYears(); } }

  renderPanel();
})();
