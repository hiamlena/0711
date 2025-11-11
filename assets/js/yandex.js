// map/assets/js/yandex.js
// Trans-Time / Яндекс.Карты — интеллектуальная карта с умными кнопками и слоями

import { $, $$, toast, fmtDist, fmtTime, escapeHtml } from './core.js';
import { YandexRouter } from './router.js';

const STORAGE_KEY = 'tt-yandex-saved-routes';
let map, multiRoute;
let viaPoints = [];
let multiRouteActiveRouteHandler = null;
let multiRouteRequestSuccessHandler = null;
let viaMarkers = [];
let lastPoints = null;
let lastOptions = null;
let lastMeta = null;
const dom = {
  from: null,
  to: null,
  buildBtn: null,
  clearVia: null,
  saveBtn: null,
  shareBtn: null,
  openNavBtn: null,
  viaInput: null,
  addViaBtn: null,
  viaList: null,
  savedList: null,
  routeList: null,
  routeWarnings: null
};
let updateUI = () => {};

/** Регистр слоёв (ObjectManager'ы) */
const layers = {
  frames: null,          // frames_ready.geojson (весовые рамки)
  hgvAllowed: null,      // hgv_allowed.geojson (разрешено HGV)
  hgvConditional: null,  // hgv_conditional.geojson (условия для HGV)
  federal: null          // federal.geojson (федеральные трассы)
};

const FRAME_BUFFER_M = 100;
let framesRawData = null;
let framesLastRouteCoords = null;
let frameBypassCollection = null;
let frameBypassSummary = [];

let restrictionMarkers = [];
let truckAlternativeCollection = null;
let restrictionSummary = [];

let hgvAllowedRawData = null;
let hgvConditionalRawData = null;

const routeWarningsState = {
  frames: [],
  restrictions: []
};

let isAddingVia = false;

let yaErrorShown = false;

function showYandexError(message, details) {
  if (yaErrorShown) return;
  yaErrorShown = true;
  const text = message || 'Яндекс.Карты недоступны.';
  toast(text);
  if (details) {
    // eslint-disable-next-line no-console
    console.error('[TT] Yandex Maps error:', details);
  }
}

function getFeatureKey(feature) {
  if (!feature) return null;
  const rawId = typeof feature.id !== 'undefined' ? feature.id : feature.properties?.id;
  if (rawId === null || typeof rawId === 'undefined') return null;
  if (typeof rawId === 'number') return String(rawId);
  if (typeof rawId === 'string') return rawId;
  try {
    return JSON.stringify(rawId);
  } catch (err) {
    return null;
  }
}

function describeYandexError(err) {
  const raw = typeof err === 'string' ? err : (err && (err.message || err.errorText)) || '';
  if (/Failed to bundle/i.test(raw)) {
    return 'Yandex Maps API не смог собрать пакет модулей ("Failed to bundle"). Проверьте параметр load=package.full или переключитесь на API v3.0.';
  }
  if (/Content Security Policy/i.test(raw) || /CSP/i.test(raw)) {
    return 'CSP блокирует загрузку скрипта Яндекс.Карт. Добавьте https://api-maps.yandex.ru в директиву script-src/script-src-elem.';
  }
  if (raw) return raw;
  return 'Не удалось загрузить Yandex Maps API.';
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    if (!event?.message) return;
    if (/ymaps/i.test(event.message) || /api-maps\.yandex\.ru/.test(event.filename || '')) {
      showYandexError(describeYandexError(event.message), event);
    }
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason;
    const raw = typeof reason === 'string' ? reason : reason?.message;
    if (raw && /ymaps/i.test(raw)) {
      showYandexError(describeYandexError(raw), reason);
    }
  });
  document.addEventListener('securitypolicyviolation', (event) => {
    if (!event?.blockedURI) return;
    if (event.blockedURI.includes('yandex')) {
      const directive = event.effectiveDirective || event.violatedDirective;
      const msg = `CSP блокирует Яндекс.Карты (${directive}). Добавьте https://api-maps.yandex.ru в разрешённые источники.`;
      showYandexError(msg, event);
    }
  });
}

function hasRouteReady() {
  return Array.isArray(lastPoints) && lastPoints.length >= 2;
}

function refreshActionButtons() {
  const disabled = !hasRouteReady();
  if (dom.saveBtn) dom.saveBtn.disabled = disabled;
  if (dom.shareBtn) dom.shareBtn.disabled = disabled;
  if (dom.openNavBtn) dom.openNavBtn.disabled = disabled;
}

function setLastRoute(points, options = {}, meta = {}) {
  if (Array.isArray(points)) {
    lastPoints = points.map(pt => (Array.isArray(pt) ? [Number(pt[0]), Number(pt[1])] : pt));
  } else {
    lastPoints = null;
  }
  lastOptions = options ? { ...options } : null;
  lastMeta = meta ? { ...meta } : null;
  refreshActionButtons();
}

function patchLastMeta(data = {}) {
  if (!data || typeof data !== 'object') return;
  lastMeta = { ...(lastMeta || {}), ...data };
}

function normalizeViaPoint(entry, idx = 0) {
  if (!entry) return null;
  if (Array.isArray(entry)) {
    return {
      coords: [Number(entry[0]), Number(entry[1])],
      label: null,
      id: `via-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 5)}`
    };
  }
  if (Array.isArray(entry.coords)) {
    return {
      coords: [Number(entry.coords[0]), Number(entry.coords[1])],
      label: entry.label ? String(entry.label) : null,
      id: entry.id || `via-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 5)}`
    };
  }
  return null;
}

function getViaCoordinates(list = viaPoints) {
  return Array.isArray(list) ? list.map(item => item.coords) : [];
}

function describeViaPoint(point, idx) {
  if (!point) return '';
  if (point.label) return point.label;
  const [lat, lon] = point.coords || [];
  if (typeof lat === 'number' && typeof lon === 'number') {
    return `via ${idx + 1}: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  }
  return `via ${idx + 1}`;
}

function renderViaList() {
  if (!dom.viaList) return;
  dom.viaList.innerHTML = '';
  if (!viaPoints.length) {
    const note = document.createElement('p');
    note.className = 'tt-note';
    note.textContent = 'Via-точки не добавлены. Используйте карту или поле выше.';
    dom.viaList.appendChild(note);
    return;
  }

  const frag = document.createDocumentFragment();
  viaPoints.forEach((point, idx) => {
    const item = document.createElement('div');
    item.className = 'tt-via-item';
    item.dataset.index = String(idx);

    const label = document.createElement('span');
    label.className = 'tt-via-item__label';
    label.textContent = describeViaPoint(point, idx);
    item.appendChild(label);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tt-btn tt-btn-icon';
    btn.dataset.action = 'remove';
    btn.dataset.index = String(idx);
    btn.setAttribute('aria-label', `Удалить via-точку ${idx + 1}`);
    btn.textContent = '×';
    item.appendChild(btn);

    frag.appendChild(item);
  });

  dom.viaList.appendChild(frag);
}

function updateRouteWarnings() {
  if (!dom.routeWarnings) return;
  const warnings = [...routeWarningsState.frames, ...routeWarningsState.restrictions];
  if (!warnings.length) {
    dom.routeWarnings.classList.remove('is-visible');
    dom.routeWarnings.innerHTML = '';
    return;
  }
  const list = document.createElement('ul');
  warnings.forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  });
  dom.routeWarnings.classList.add('is-visible');
  dom.routeWarnings.innerHTML = '';
  dom.routeWarnings.appendChild(list);
}

function clearFrameBypasses() {
  frameBypassSummary = [];
  routeWarningsState.frames = [];
  if (frameBypassCollection && map?.geoObjects?.contains?.(frameBypassCollection)) {
    map.geoObjects.remove(frameBypassCollection);
  }
  frameBypassCollection?.removeAll?.();
  updateRouteWarnings();
}

function clearRestrictionArtifacts() {
  restrictionSummary = [];
  routeWarningsState.restrictions = [];
  restrictionMarkers.forEach(marker => {
    try { map.geoObjects.remove(marker); } catch (err) { /* noop */ }
  });
  restrictionMarkers = [];
  if (truckAlternativeCollection && map?.geoObjects?.contains?.(truckAlternativeCollection)) {
    map.geoObjects.remove(truckAlternativeCollection);
  }
  truckAlternativeCollection?.removeAll?.();
  updateRouteWarnings();
}

function ensureFrameBypassCollection() {
  if (!map) return null;
  if (!frameBypassCollection) {
    frameBypassCollection = new ymaps.GeoObjectCollection({}, {
      strokeColor: '#f97316',
      strokeWidth: 4,
      strokeOpacity: 0.85,
      strokeStyle: 'dash'
    });
  }
  if (!map.geoObjects.contains(frameBypassCollection)) {
    map.geoObjects.add(frameBypassCollection);
  }
  return frameBypassCollection;
}

function ensureTruckAlternativeCollection() {
  if (!map) return null;
  if (!truckAlternativeCollection) {
    truckAlternativeCollection = new ymaps.GeoObjectCollection({}, {
      strokeColor: '#8b5cf6',
      strokeWidth: 4,
      strokeOpacity: 0.8,
      strokeStyle: 'dot'
    });
  }
  if (!map.geoObjects.contains(truckAlternativeCollection)) {
    map.geoObjects.add(truckAlternativeCollection);
  }
  return truckAlternativeCollection;
}

function extractFeatureCoordinate(feature) {
  const geom = feature?.geometry;
  if (!geom) return null;
  if (geom.type === 'Point') {
    const coords = geom.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    return [Number(coords[1]), Number(coords[0])];
  }
  if (geom.type === 'LineString' && Array.isArray(geom.coordinates) && geom.coordinates.length) {
    const mid = geom.coordinates[Math.floor(geom.coordinates.length / 2)];
    if (!Array.isArray(mid) || mid.length < 2) return null;
    return [Number(mid[1]), Number(mid[0])];
  }
  if (geom.type === 'Polygon' && Array.isArray(geom.coordinates) && geom.coordinates[0]?.length) {
    const ring = geom.coordinates[0];
    const mid = ring[Math.floor(ring.length / 2)];
    if (!Array.isArray(mid) || mid.length < 2) return null;
    return [Number(mid[1]), Number(mid[0])];
  }
  return null;
}

function findNearestRouteIndex(routeCoords, point) {
  if (!Array.isArray(routeCoords) || routeCoords.length === 0 || !Array.isArray(point)) return -1;
  let nearest = -1;
  let min = Infinity;
  for (let i = 0; i < routeCoords.length; i += 1) {
    const dist = distanceMeters(routeCoords[i], point);
    if (dist < min) {
      min = dist;
      nearest = i;
      if (min <= FRAME_BUFFER_M / 2) break;
    }
  }
  return nearest;
}

function buildBypassMidpoint(before, after, center) {
  if (!Array.isArray(center)) return null;
  const start = Array.isArray(before) ? before : center;
  const end = Array.isArray(after) ? after : center;
  const dLat = end[0] - start[0];
  const dLon = end[1] - start[1];
  const length = Math.hypot(dLat, dLon) || 0.0001;
  const scale = Math.min(0.01, Math.max(0.002, length * 1.5));
  const offsetLat = (dLon / length) * scale;
  const offsetLon = (-dLat / length) * scale;
  return [center[0] + offsetLat, center[1] + offsetLon];
}

async function buildFrameBypassesForRoute(routeCoords, options = {}) {
  if (!Array.isArray(routeCoords) || routeCoords.length < 2) {
    clearFrameBypasses();
    return;
  }
  try {
    await loadFrames();
  } catch (err) {
    console.warn('[TT] buildFrameBypassesForRoute: frames load failed', err); // eslint-disable-line no-console
    clearFrameBypasses();
    return;
  }

  const filtered = filterFramesForRoute(routeCoords);
  if (!filtered.features.length) {
    clearFrameBypasses();
    return;
  }

  const basePoints = Array.isArray(lastPoints) ? lastPoints.map(pt => (Array.isArray(pt) ? [pt[0], pt[1]] : pt)) : [];
  if (basePoints.length < 2) {
    clearFrameBypasses();
    return;
  }

  const collection = ensureFrameBypassCollection();
  if (!collection) return;
  collection.removeAll();
  frameBypassSummary = [];

  const opts = { ...(options || {}), ...(lastOptions || {}), alternatives: 1 };

  for (let i = 0; i < filtered.features.length; i += 1) {
    if (i > 4) break; // ограничим число обходов, чтобы не перегружать API
    const feature = filtered.features[i];
    const center = extractFeatureCoordinate(feature);
    if (!center) continue;
    const nearestIdx = findNearestRouteIndex(routeCoords, center);
    if (nearestIdx < 0) continue;
    const before = routeCoords[Math.max(0, nearestIdx - 5)];
    const after = routeCoords[Math.min(routeCoords.length - 1, nearestIdx + 5)];
    const mid = buildBypassMidpoint(before, after, center);
    const ref = [...basePoints];
    if (!mid) continue;
    ref.splice(ref.length - 1, 0, before, mid, after);

    try {
      const res = await YandexRouter.build(ref, { ...opts, boundsAutoApply: false });
      const altRoute = res.routes?.get ? res.routes.get(0) : res.routes?.[0];
      const coords = altRoute ? extractRouteCoordinates(altRoute) : getActiveRouteCoordinates(res.multiRoute);
      if (Array.isArray(coords) && coords.length > 1) {
        const polyline = new ymaps.Polyline(coords, {
          hintContent: 'Обход рамки'
        }, {
          strokeColor: '#f97316',
          strokeWidth: 4,
          strokeOpacity: 0.85,
          strokeStyle: 'dash'
        });
        collection.add(polyline);
        const distance = altRoute?.properties?.get?.('distance');
        const duration = altRoute?.properties?.get?.('duration');
        const messageParts = ['Построен обход рамки'];
        if (distance?.value) messageParts.push(fmtDist(distance.value));
        if (duration?.value) messageParts.push(fmtTime(duration.value));
        frameBypassSummary.push(messageParts.join(' — '));
      }
      if (res.multiRoute) {
        try { res.multiRoute.destroy?.(); } catch (err) { /* noop */ }
      }
    } catch (err) {
      console.warn('[TT] bypass build failed', err); // eslint-disable-line no-console
    }
  }

  routeWarningsState.frames = frameBypassSummary.slice();
  updateRouteWarnings();
}

function pointInPolygon(point, polygon) {
  if (!Array.isArray(point) || !Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    const intersect = ((yi > point[0]) !== (yj > point[0]))
      && (point[1] < ((xj - xi) * (point[0] - yi)) / (yj - yi + 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointNearFeature(point, feature, tolerance = 120) {
  if (!feature?.geometry) return false;
  const geom = feature.geometry;
  if (geom.type === 'Point') {
    const coords = Array.isArray(geom.coordinates) ? geom.coordinates : [];
    if (coords.length < 2) return false;
    const latLon = [Number(coords[1]), Number(coords[0])];
    return distanceMeters(point, latLon) <= tolerance;
  }
  if (geom.type === 'LineString') {
    const coords = Array.isArray(geom.coordinates) ? geom.coordinates : [];
    if (!coords.length) return false;
    const latLon = coords.map(pair => [Number(pair[1]), Number(pair[0])]);
    return pointToPolylineMinDistanceMeters(point, latLon) <= tolerance;
  }
  if (geom.type === 'Polygon' && Array.isArray(geom.coordinates) && geom.coordinates[0]) {
    const ring = geom.coordinates[0].map(pair => [Number(pair[1]), Number(pair[0])]);
    if (pointInPolygon(point, ring)) return true;
    return pointToPolylineMinDistanceMeters(point, ring) <= tolerance;
  }
  return false;
}

function pointAllowedForVehicle(point, mode) {
  if (!point) return false;
  const tolerance = mode === 'truckHeavy' ? 150 : 120;
  const allowed = hgvAllowedRawData?.features || [];
  const conditional = hgvConditionalRawData?.features || [];
  const allowedMatch = allowed.some(feature => pointNearFeature(point, feature, tolerance));
  if (mode === 'truckHeavy') return allowedMatch;
  const conditionalMatch = conditional.some(feature => pointNearFeature(point, feature, tolerance));
  return allowedMatch || conditionalMatch;
}

function findNearestAllowedPoint(point) {
  if (!point || !hgvAllowedRawData?.features?.length) return null;
  let best = null;
  let min = Infinity;
  hgvAllowedRawData.features.forEach((feature) => {
    const geom = feature.geometry;
    if (!geom) return;
    if (geom.type === 'Point') {
      const coords = Array.isArray(geom.coordinates) ? geom.coordinates : [];
      if (coords.length < 2) return;
      const latLon = [Number(coords[1]), Number(coords[0])];
      const dist = distanceMeters(point, latLon);
      if (dist < min) { min = dist; best = latLon; }
    } else if (geom.type === 'LineString' && Array.isArray(geom.coordinates)) {
      geom.coordinates.forEach((pair) => {
        if (!Array.isArray(pair) || pair.length < 2) return;
        const latLon = [Number(pair[1]), Number(pair[0])];
        const dist = distanceMeters(point, latLon);
        if (dist < min) { min = dist; best = latLon; }
      });
    } else if (geom.type === 'Polygon' && Array.isArray(geom.coordinates) && geom.coordinates[0]) {
      const ring = geom.coordinates[0];
      ring.forEach((pair) => {
        if (!Array.isArray(pair) || pair.length < 2) return;
        const latLon = [Number(pair[1]), Number(pair[0])];
        const dist = distanceMeters(point, latLon);
        if (dist < min) { min = dist; best = latLon; }
      });
    }
  });
  return best;
}

async function ensureHgvDataLoaded() {
  try {
    await Promise.all([loadHgvAllowed(), loadHgvConditional().catch(() => null)]);
  } catch (err) {
    console.warn('[TT] ensureHgvDataLoaded failed', err); // eslint-disable-line no-console
  }
}

async function checkTruckRestrictions(routeCoords, mode) {
  if (!Array.isArray(routeCoords) || routeCoords.length < 2) {
    clearRestrictionArtifacts();
    return;
  }
  if (!mode || mode === 'auto' || mode === 'car') {
    clearRestrictionArtifacts();
    return;
  }
  await ensureHgvDataLoaded();
  if (!hgvAllowedRawData && !hgvConditionalRawData) {
    clearRestrictionArtifacts();
    return;
  }

  const step = Math.max(1, Math.floor(routeCoords.length / 200));
  const violations = [];
  for (let i = 0; i < routeCoords.length; i += step) {
    const point = routeCoords[i];
    if (!pointAllowedForVehicle(point, mode)) {
      violations.push({ point, index: i });
    }
  }

  clearRestrictionArtifacts();
  if (!violations.length) return;

  const collection = ensureTruckAlternativeCollection();
  collection?.removeAll?.();

  violations.forEach(({ point }, idx) => {
    const marker = new ymaps.Placemark(point, {
      hintContent: 'Ограничение для выбранного ТС',
      balloonContent: `Участок ${idx + 1}: ограничение движения`
    }, {
      preset: 'islands#redCircleDotIcon'
    });
    map.geoObjects.add(marker);
    restrictionMarkers.push(marker);
  });

  restrictionSummary = [`Маршрут содержит ${violations.length} участок(а) с ограничениями для выбранного транспорта.`];

  const basePoints = Array.isArray(lastPoints) ? lastPoints.map(pt => (Array.isArray(pt) ? [pt[0], pt[1]] : pt)) : [];
  const targetViolation = violations[0];
  if (basePoints.length >= 2 && targetViolation) {
    const fallbackPoint = findNearestAllowedPoint(targetViolation.point);
    if (fallbackPoint) {
      const altRef = [...basePoints];
      altRef.splice(altRef.length - 1, 0, fallbackPoint);
      try {
        const res = await YandexRouter.build(altRef, { ...(lastOptions || {}), alternatives: 1, boundsAutoApply: false });
        const altRoute = res.routes?.get ? res.routes.get(0) : res.routes?.[0];
        const coords = altRoute ? extractRouteCoordinates(altRoute) : getActiveRouteCoordinates(res.multiRoute);
        if (Array.isArray(coords) && coords.length > 1) {
          const polyline = new ymaps.Polyline(coords, {
            hintContent: 'Альтернативный маршрут для ТС'
          }, {
            strokeColor: '#8b5cf6',
            strokeWidth: 4,
            strokeOpacity: 0.8,
            strokeStyle: 'dot'
          });
          collection?.add(polyline);
          restrictionSummary.push('Построен альтернативный маршрут через разрешённый участок.');
        }
        if (res.multiRoute) {
          try { res.multiRoute.destroy?.(); } catch (err) { /* noop */ }
        }
      } catch (err) {
        console.warn('[TT] alternative truck route failed', err); // eslint-disable-line no-console
      }
    }
  }

  routeWarningsState.restrictions = restrictionSummary.slice();
  updateRouteWarnings();
}
function setViaPoints(points = []) {
  const normalized = Array.isArray(points)
    ? points.map((pt, idx) => normalizeViaPoint(pt, idx)).filter(Boolean)
    : [];
  viaPoints = normalized;
  if (map) {
    viaMarkers.forEach((m) => {
      try { map.geoObjects.remove(m); } catch (err) { /* noop */ }
    });
    viaMarkers = [];
    viaPoints.forEach((point, idx) => {
      const mark = new ymaps.Placemark(
        point.coords,
        { hintContent: describeViaPoint(point, idx) },
        { preset: 'islands#darkGreenCircleDotIcon', draggable: true }
      );
      mark.events.add('dragend', (e) => {
        const target = e.get('target');
        const coords = target?.geometry?.getCoordinates();
        if (!Array.isArray(coords)) return;
        if (viaPoints[idx]) {
          const label = viaPoints[idx].label && !/^Координаты/.test(viaPoints[idx].label)
            ? viaPoints[idx].label
            : `Координаты ${Number(coords[0]).toFixed(5)}, ${Number(coords[1]).toFixed(5)}`;
          viaPoints[idx] = { ...viaPoints[idx], coords: [Number(coords[0]), Number(coords[1])], label };
          renderViaList();
          refreshActionButtons();
        }
      });
      map.geoObjects.add(mark);
      viaMarkers.push(mark);
    });
  }
  renderViaList();
  refreshActionButtons();
  updateUI();
}

function readSavedRoutes() {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => item && item.id);
  } catch (err) {
    console.warn('[TT] readSavedRoutes error', err); // eslint-disable-line no-console
    return [];
  }
}

function writeSavedRoutes(list) {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch (err) {
    console.warn('[TT] writeSavedRoutes error', err); // eslint-disable-line no-console
    toast('Не удалось сохранить маршрут: ' + (err?.message || err));
    return false;
  }
}

function renderSavedRoutes() {
  if (!dom.savedList) return;
  const saved = readSavedRoutes().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  dom.savedList.innerHTML = '';

  if (!saved.length) {
    const empty = document.createElement('p');
    empty.className = 'tt-note';
    empty.textContent = 'Сохранённых маршрутов пока нет.';
    dom.savedList.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  saved.forEach(route => {
    const wrap = document.createElement('div');
    wrap.className = 'tt-saved-route';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tt-btn tt-btn-ghost tt-saved-route__load';
    btn.dataset.action = 'load';
    btn.dataset.routeId = route.id;
    btn.textContent = route.name || `${route.from || 'A'} → ${route.to || 'B'}`;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'tt-btn tt-btn-icon';
    del.dataset.action = 'delete';
    del.dataset.routeId = route.id;
    del.title = 'Удалить маршрут';
    del.setAttribute('aria-label', 'Удалить маршрут');
    del.textContent = '×';

    wrap.appendChild(btn);
    wrap.appendChild(del);
    frag.appendChild(wrap);
  });

  dom.savedList.appendChild(frag);
}

function deleteSavedRoute(id) {
  const saved = readSavedRoutes();
  const next = saved.filter(item => item.id !== id);
  if (next.length === saved.length) return;
  writeSavedRoutes(next);
  renderSavedRoutes();
  toast('Маршрут удалён', 1600);
}

function setRouteListEmpty(message = 'Постройте маршрут, чтобы увидеть альтернативы.') {
  if (!dom.routeList) return;
  dom.routeList.classList.add('is-empty');
  dom.routeList.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'tt-route-empty';
  empty.textContent = message;
  dom.routeList.appendChild(empty);
}

function highlightActiveRoute(activeIndex) {
  if (!dom.routeList) return;
  const items = dom.routeList.querySelectorAll('.tt-route-item');
  items.forEach((btn) => {
    const idx = Number(btn.dataset.index);
    const isActive = Number.isInteger(activeIndex) && idx === activeIndex;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function updateRouteList(routesCollection) {
  if (!dom.routeList) return;
  if (!routesCollection) {
    setRouteListEmpty();
    return;
  }

  let length = 0;
  if (typeof routesCollection.getLength === 'function') {
    length = routesCollection.getLength();
  } else if (Array.isArray(routesCollection)) {
    length = routesCollection.length;
  }

  if (!length) {
    setRouteListEmpty('Маршрут не найден.');
    return;
  }

  const frag = document.createDocumentFragment();

  for (let i = 0; i < length; i += 1) {
    const route = typeof routesCollection.get === 'function'
      ? routesCollection.get(i)
      : routesCollection[i];
    if (!route) continue;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tt-route-item';
    btn.dataset.index = String(i);
    btn.setAttribute('aria-pressed', 'false');

    const title = document.createElement('strong');
    title.textContent = i === 0 ? 'Основной маршрут' : `Альтернатива ${i}`;
    btn.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'tt-route-meta';

    try {
      const distance = route.properties?.get('distance');
      if (distance?.value) {
        const span = document.createElement('span');
        span.textContent = fmtDist(distance.value);
        meta.appendChild(span);
      }
      const duration = route.properties?.get('duration');
      if (duration?.value) {
        const span = document.createElement('span');
        span.textContent = fmtTime(duration.value);
        meta.appendChild(span);
      }
    } catch (err) {
      console.warn('[TT] route meta error', err); // eslint-disable-line no-console
    }

    if (viaPoints.length) {
      const span = document.createElement('span');
      span.textContent = `via: ${viaPoints.length}`;
      meta.appendChild(span);
    }

    if (!meta.children.length) {
      const span = document.createElement('span');
      span.textContent = 'Данные маршрута недоступны';
      meta.appendChild(span);
    }

    btn.appendChild(meta);
    frag.appendChild(btn);
  }

  dom.routeList.innerHTML = '';
  dom.routeList.classList.remove('is-empty');
  dom.routeList.appendChild(frag);
  highlightActiveRoute(0);
}

function loadSavedRoute(id) {
  const saved = readSavedRoutes();
  const route = saved.find(item => item.id === id);
  if (!route) {
    toast('Маршрут не найден', 1600);
    return;
  }

  if (dom.from) dom.from.value = route.from || '';
  if (dom.to) dom.to.value = route.to || '';
  setViaPoints(Array.isArray(route.via) ? route.via : []);
  updateUI();
  window.setTimeout(() => { onBuild().catch?.(() => {}); }, 50);
}

async function handleSaveRoute() {
  if (!hasRouteReady()) {
    toast('Постройте маршрут перед сохранением', 2000);
    return;
  }
  const saved = readSavedRoutes();
  const name = lastMeta?.name || `${lastMeta?.from || 'A'} → ${lastMeta?.to || 'B'}`;
  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    from: lastMeta?.from || dom.from?.value?.trim() || '',
    to: lastMeta?.to || dom.to?.value?.trim() || '',
    via: Array.isArray(lastPoints)
      ? lastPoints.slice(1, -1).map(pt => (Array.isArray(pt) ? [pt[0], pt[1]] : pt))
      : [],
    options: lastOptions || {},
    createdAt: Date.now()
  };

  saved.unshift(entry);
  if (saved.length > 30) saved.length = 30;
  if (writeSavedRoutes(saved)) {
    renderSavedRoutes();
    toast('Маршрут сохранён', 1600);
  }
}

function encodeSharePayload(obj) {
  try {
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    return btoa(binary);
  } catch (err) {
    console.warn('[TT] encodeSharePayload error', err); // eslint-disable-line no-console
    throw err;
  }
}

function decodeSharePayload(str) {
  const binary = atob(str);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json);
}

async function handleShareRoute() {
  if (!hasRouteReady()) {
    toast('Постройте маршрут перед отправкой ссылки', 2000);
    return;
  }

  try {
    const payload = {
      points: lastPoints,
      options: lastOptions,
      meta: lastMeta
    };
    const hash = '#s=' + encodeURIComponent(encodeSharePayload(payload));
    const basePath = `${window.location.pathname}${window.location.search || ''}`;
    const pathWithHash = `${basePath}${hash}`;
    if (history.replaceState) {
      history.replaceState(null, document.title, pathWithHash);
    } else {
      window.location.hash = hash;
    }
    const shareUrl = `${window.location.origin}${pathWithHash}`;
    let copied = false;
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(shareUrl);
        copied = true;
      } catch (err) {
        console.warn('[TT] clipboard error', err); // eslint-disable-line no-console
      }
    }
    if (!copied) {
      window.prompt('Скопируйте ссылку', shareUrl); // eslint-disable-line no-alert
    }
    toast('Ссылка на маршрут готова', 2000);
  } catch (err) {
    toast('Не удалось подготовить ссылку: ' + (err?.message || err));
  }
}

function buildNavigatorLinks(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const start = points[0];
  const end = points[points.length - 1];
  const via = points.slice(1, -1);

  const yaParams = new URLSearchParams({
    lat_from: start[0],
    lon_from: start[1],
    lat_to: end[0],
    lon_to: end[1]
  });
  via.forEach((pt, idx) => {
    yaParams.set(`lat_via_${idx + 1}`, pt[0]);
    yaParams.set(`lon_via_${idx + 1}`, pt[1]);
  });

  const googleParams = new URLSearchParams({
    api: '1',
    origin: `${start[0]},${start[1]}`,
    destination: `${end[0]},${end[1]}`,
    travelmode: 'driving'
  });
  if (via.length) {
    googleParams.set('waypoints', via.map(pt => `${pt[0]},${pt[1]}`).join('|'));
  }

  const osmandParams = new URLSearchParams({
    lat: start[0],
    lon: start[1],
    z: 12,
    navigate: 'yes',
    dest_lat: end[0],
    dest_lon: end[1]
  });
  if (via.length) {
    osmandParams.set('via', via.map(pt => `${pt[0]},${pt[1]}`).join('|'));
  }

  return {
    yandex: `yandexnavi://build_route_on_map?${yaParams.toString()}`,
    google: `https://www.google.com/maps/dir/?${googleParams.toString()}`,
    osmand: `https://osmand.net/go?${osmandParams.toString()}`
  };
}

function handleOpenNavigator() {
  if (!hasRouteReady()) {
    toast('Постройте маршрут, чтобы открыть его в навигаторе', 2200);
    return;
  }
  const links = buildNavigatorLinks(lastPoints);
  if (!links) {
    toast('Не удалось подготовить ссылки для навигатора', 2200);
    return;
  }
  const html = [
    '<div>Откройте маршрут в навигаторе:</div>',
    `<div class="mt6"><a href="${escapeHtml(links.yandex)}" target="_blank" rel="noopener">Яндекс Навигатор</a></div>`,
    `<div class="mt6"><a href="${escapeHtml(links.google)}" target="_blank" rel="noopener">Google Maps</a></div>`,
    `<div class="mt6"><a href="${escapeHtml(links.osmand)}" target="_blank" rel="noopener">OsmAnd</a></div>`
  ].join('');
  toast(html, 12000);
}

function parseShareHash() {
  const hash = window.location.hash || '';
  if (!hash.startsWith('#s=')) return null;
  try {
    const payload = decodeSharePayload(decodeURIComponent(hash.slice(3)));
    return payload;
  } catch (err) {
    console.warn('[TT] parseShareHash error', err); // eslint-disable-line no-console
    toast('Не удалось загрузить маршрут из ссылки', 2200);
    return null;
  }
}

function applySharedRoute(payload) {
  if (!payload) return;
  if (dom.from) dom.from.value = payload.meta?.from || '';
  if (dom.to) dom.to.value = payload.meta?.to || '';
  if (Array.isArray(payload.points)) {
    setViaPoints(payload.points.slice(1, -1));
  }
  updateUI();
  window.setTimeout(() => { onBuild().catch?.(() => {}); }, 80);
}

function restoreFromHash() {
  const payload = parseShareHash();
  if (payload) {
    applySharedRoute(payload);
  }
}

/** Точка входа — загрузка SDK Яндекса и старт */
export function init() {
  const cfg = (window.TRANSTIME_CONFIG && window.TRANSTIME_CONFIG.yandex) || null;
  if (!cfg || !cfg.apiKey) {
    toast('Ошибка конфигурации: нет API-ключа');
    return;
  }
  if (window.__TT_YA_LOADING__) return;
  window.__TT_YA_LOADING__ = true;

  const script = document.createElement('script');
  const loader = cfg.loader || {};
  const params = new URLSearchParams({
    apikey: cfg.apiKey,
    lang: cfg.lang || 'ru_RU',
    load: loader.load || 'package.full',
    mode: loader.mode || 'release'
  });
  const suggestKey = cfg.suggestApiKey || cfg.suggestKey || null;
  if (suggestKey) {
    params.set('suggest_apikey', suggestKey);
  }
  const apiBase = loader.baseUrl || 'https://api-maps.yandex.ru/2.1/';
  script.src = `${apiBase}?${params.toString()}`;
  if (cfg.nonce) script.nonce = cfg.nonce;

  script.onload = () => {
    if (!(window.ymaps && typeof ymaps.ready === 'function')) {
      showYandexError('Yandex API не инициализировался');
      return;
    }
    try {
      const readyPromise = typeof ymaps.ready === 'function' ? ymaps.ready() : null;
      if (readyPromise && typeof readyPromise.then === 'function') {
        let settled = false;
        const timeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          showYandexError('Yandex Maps API долго не отвечает. Возможна ошибка "Failed to bundle" или блокировка CSP.');
        }, cfg.loader?.timeout || 12000);
        readyPromise
          .then(() => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            setup();
          })
          .catch((err) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            showYandexError(describeYandexError(err), err);
          });
      } else {
        ymaps.ready(setup);
      }
    } catch (err) {
      showYandexError(describeYandexError(err), err);
    }
  };

  script.onerror = () => showYandexError('Не удалось загрузить Yandex Maps', new Error('Script load error'));
  document.head.appendChild(script);
}

/** Универсальный загрузчик GeoJSON в ObjectManager с диагностикой */
async function loadGeoJsonLayer(url, options = {}) {
  const { idPrefix = 'obj', ...layerOptions } = options;
  const withBuster = url + (url.includes('?') ? '&' : '?') + 'v=' + Date.now();
  const r = await fetch(withBuster, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  const data = await r.json();

  if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error('Некорректный GeoJSON: ожидался FeatureCollection.features[] — ' + url);
  }

  // Диагностика: пусто/типы геометрий
  if (data.features.length === 0) {
    toast('Слой пуст: ' + url.split('/').pop());
  } else {
    const types = new Map();
    for (const f of data.features) {
      const t = f?.geometry?.type || 'Unknown';
      types.set(t, (types.get(t) || 0) + 1);
    }
    const summary = [...types.entries()].map(([t, c]) => `${t}:${c}`).join(', ');
    toast(`Загружен ${url.split('/').pop()} — ${data.features.length} фич (${summary})`, 2200);
  }

  const om = new ymaps.ObjectManager({ clusterize: false });
  if (layerOptions.preset) om.objects.options.set({ preset: layerOptions.preset });

  // Общие стили (точки/линии/полигоны)
  om.objects.options.set({
    zIndex: layerOptions.zIndex || 200,
    strokeColor: layerOptions.strokeColor || '#60a5fa',
    strokeWidth: layerOptions.strokeWidth || 3,
    strokeOpacity: layerOptions.strokeOpacity || 0.9,
    fillColor: layerOptions.fillColor || 'rgba(96,165,250,.15)',
    fillOpacity: layerOptions.fillOpacity || 0.3
  });

  // Нормализация тултипов
  data.features.forEach((f, idx) => {
    const p = f.properties || {};
    f.properties = {
      hintContent: p.name || p.title || 'Объект',
      balloonContent:
        `<b>${escapeHtml(p.name || p.title || 'Объект')}</b>` +
        (p.comment ? `<div class="mt6">${escapeHtml(p.comment)}</div>` : '') +
        (p.date ? `<div class="small mt6">Дата: ${escapeHtml(p.date)}</div>` : '')
    };

    if (typeof f.id === 'undefined' || f.id === null || f.id === '') {
      const rawId = p.id;
      if (typeof rawId === 'string' && rawId.trim()) {
        f.id = rawId.trim();
      } else if (typeof rawId === 'number' && Number.isFinite(rawId)) {
        f.id = `${idPrefix}-${rawId}`;
      } else {
        f.id = `${idPrefix}-${idx}`;
      }
    } else if (typeof f.id === 'number') {
      f.id = `${idPrefix}-${f.id}`;
    } else {
      f.id = String(f.id);
    }

    if (!f.properties.id) {
      f.properties.id = f.id;
    }
  });

  om.add(data);
  try {
    om.ttSourceData = JSON.parse(JSON.stringify(data));
  } catch (err) {
    om.ttSourceData = data;
  }
  return om;
}

/** Конкретные загрузчики слоёв */
async function loadFrames() {
  if (layers.frames) {
    if (!framesRawData) {
      const rawCached = layers.frames.ttSourceData
        || (typeof layers.frames.objects?.getAll === 'function' ? layers.frames.objects.getAll() : null);
      try {
        framesRawData = rawCached ? JSON.parse(JSON.stringify(rawCached)) : { type: 'FeatureCollection', features: [] };
      } catch (err) {
        console.warn('[TT] frames raw clone failed', err); // eslint-disable-line no-console
        framesRawData = rawCached || { type: 'FeatureCollection', features: [] };
      }
    }
    return layers.frames;
  }

  // Пробуем набор типичных путей (зависит от того, где лежит страница: /, /map/, /pages/map/…)
  const baseFromConfig = window.TRANSTIME_CONFIG?.layersBase || null;
  const candidates = [];
  if (baseFromConfig) candidates.push(baseFromConfig.replace(/\/$/, '') + '/frames_ready.geojson');
  candidates.push('../data/frames_ready.geojson');
  candidates.push('./data/frames_ready.geojson');
  candidates.push('/data/frames_ready.geojson');

  let lastErr = null;
  for (const u of candidates) {
    try {
      const om = await loadGeoJsonLayer(u, {
        preset: 'islands#blueCircleDotIcon',
        zIndex: 220,
        idPrefix: 'frame'
      });
      const raw = om.ttSourceData || (typeof om.objects?.getAll === 'function' ? om.objects.getAll() : null);
      try {
        framesRawData = raw ? JSON.parse(JSON.stringify(raw)) : { type: 'FeatureCollection', features: [] };
      } catch (err) {
        console.warn('[TT] frames raw clone failed', err); // eslint-disable-line no-console
        framesRawData = raw || { type: 'FeatureCollection', features: [] };
      }
      layers.frames = om;
      return om;
    } catch (e) {
      lastErr = e;
    }
  }
  console.error('[TT] frames_ready load failed', lastErr);
  toast('Не удалось загрузить frames_ready.geojson — проверь путь/валидность файла');
}
async function loadHgvAllowed() {
  if (layers.hgvAllowed) return layers.hgvAllowed;
  layers.hgvAllowed = await loadGeoJsonLayer('../data/hgv_allowed.geojson', {
    preset: 'islands#darkGreenCircleDotIcon',
    zIndex: 210
  });
  const raw = layers.hgvAllowed.ttSourceData
    || (typeof layers.hgvAllowed.objects?.getAll === 'function' ? layers.hgvAllowed.objects.getAll() : null);
  try {
    hgvAllowedRawData = raw ? JSON.parse(JSON.stringify(raw)) : null;
  } catch (err) {
    hgvAllowedRawData = raw;
  }
  return layers.hgvAllowed;
}
async function loadHgvConditional() {
  if (layers.hgvConditional) return layers.hgvConditional;
  layers.hgvConditional = await loadGeoJsonLayer('../data/hgv_conditional.geojson', {
    preset: 'islands#yellowCircleDotIcon',
    zIndex: 205
  });
  const raw = layers.hgvConditional.ttSourceData
    || (typeof layers.hgvConditional.objects?.getAll === 'function' ? layers.hgvConditional.objects.getAll() : null);
  try {
    hgvConditionalRawData = raw ? JSON.parse(JSON.stringify(raw)) : null;
  } catch (err) {
    hgvConditionalRawData = raw;
  }
  return layers.hgvConditional;
}
async function loadFederal() {
  if (layers.federal) return layers.federal;
  layers.federal = await loadGeoJsonLayer('../data/federal.geojson', {
    preset: 'islands#grayCircleDotIcon',
    zIndex: 200
  });
  return layers.federal;
}

function toRadians(value) {
  return (Number(value) * Math.PI) / 180;
}

function distanceMeters(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) return Infinity;
  const lat1 = toRadians(a[0]);
  const lat2 = toRadians(b[0]);
  const dLat = toRadians(b[0] - a[0]);
  const dLon = toRadians(b[1] - a[1]);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pointToSegmentDistanceMeters(point, start, end) {
  if (!Array.isArray(point) || !Array.isArray(start) || !Array.isArray(end)) return Infinity;
  if (start.length < 2 || end.length < 2) return Infinity;
  if (start[0] === end[0] && start[1] === end[1]) {
    return distanceMeters(point, start);
  }

  const lat0 = toRadians((start[0] + end[0]) / 2);
  const r = 6378137;
  const toXY = (coords) => {
    const lat = toRadians(coords[0]);
    const lon = toRadians(coords[1]);
    return {
      x: r * lon * Math.cos(lat0),
      y: r * lat
    };
  };

  const p = toXY(point);
  const a = toXY(start);
  const b = toXY(end);
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const denom = abx * abx + aby * aby;
  let t = 0;
  if (denom > 0) {
    t = (apx * abx + apy * aby) / denom;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
  }
  const proj = {
    x: a.x + abx * t,
    y: a.y + aby * t
  };
  return Math.hypot(p.x - proj.x, p.y - proj.y);
}

function pointToPolylineMinDistanceMeters(point, polyline) {
  if (!Array.isArray(polyline) || polyline.length < 2) return Infinity;
  let min = Infinity;
  for (let i = 1; i < polyline.length; i += 1) {
    const dist = pointToSegmentDistanceMeters(point, polyline[i - 1], polyline[i]);
    if (dist < min) {
      min = dist;
      if (min <= FRAME_BUFFER_M) return min;
    }
  }
  return min;
}

function cloneFeature(feature) {
  return JSON.parse(JSON.stringify(feature));
}

function filterFramesForRoute(routeCoords) {
  const empty = { type: 'FeatureCollection', features: [] };
  if (!framesRawData?.features?.length || !Array.isArray(routeCoords) || routeCoords.length < 2) {
    return empty;
  }

  const filtered = [];
  framesRawData.features.forEach((feature) => {
    const geom = feature?.geometry;
    if (!geom) return;
    if (geom.type === 'Point') {
      const coords = geom.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;
      const latLon = [Number(coords[1]), Number(coords[0])];
      if (Number.isNaN(latLon[0]) || Number.isNaN(latLon[1])) return;
      const dist = pointToPolylineMinDistanceMeters(latLon, routeCoords);
      if (dist <= FRAME_BUFFER_M) {
        filtered.push(cloneFeature(feature));
      }
    } else if (geom.type === 'LineString') {
      const coords = Array.isArray(geom.coordinates) ? geom.coordinates : [];
      if (!coords.length) return;
      let min = Infinity;
      coords.forEach((pair) => {
        if (!Array.isArray(pair) || pair.length < 2) return;
        const latLon = [Number(pair[1]), Number(pair[0])];
        if (Number.isNaN(latLon[0]) || Number.isNaN(latLon[1])) return;
        const dist = pointToPolylineMinDistanceMeters(latLon, routeCoords);
        if (dist < min) min = dist;
      });
      if (min <= FRAME_BUFFER_M) {
        filtered.push(cloneFeature(feature));
      }
    }
  });

  const result = { type: 'FeatureCollection', features: filtered };
  if (framesRawData.properties) {
    result.properties = { ...framesRawData.properties };
  }
  return result;
}

function extractRouteCoordinates(route) {
  if (!route || typeof route.getPaths !== 'function') return null;
  const coords = [];
  route.getPaths().each((path) => {
    path.getSegments().each((segment) => {
      const segCoords = segment.getCoordinates();
      if (Array.isArray(segCoords)) {
        segCoords.forEach((pair) => {
          if (Array.isArray(pair) && pair.length >= 2) {
            coords.push([Number(pair[0]), Number(pair[1])]);
          }
        });
      }
    });
  });
  return coords.length ? coords : null;
}

function getActiveRouteCoordinates(mr) {
  if (!mr) return null;
  let active = null;
  if (typeof mr.getActiveRoute === 'function') {
    active = mr.getActiveRoute();
  }
  if (!active && typeof mr.getRoutes === 'function') {
    const routes = mr.getRoutes();
    if (routes) {
      if (typeof routes.getLength === 'function' && routes.getLength() > 0) {
        active = routes.get(0);
      } else if (Array.isArray(routes) && routes.length > 0) {
        active = routes[0];
      }
    }
  }
  if (!active) return null;
  return extractRouteCoordinates(active);
}

function getActiveRouteIndex(mr) {
  if (!mr || typeof mr.getRoutes !== 'function') return -1;
  const routes = mr.getRoutes();
  if (!routes) return -1;
  const active = typeof mr.getActiveRoute === 'function' ? mr.getActiveRoute() : null;
  if (!active) {
    if (typeof routes.getLength === 'function' && routes.getLength() > 0) return 0;
    if (Array.isArray(routes) && routes.length > 0) return 0;
    return -1;
  }

  if (typeof routes.getLength === 'function') {
    const len = routes.getLength();
    for (let i = 0; i < len; i += 1) {
      if (routes.get(i) === active) return i;
    }
  } else if (Array.isArray(routes)) {
    return routes.indexOf(active);
  }
  return -1;
}

function isFramesLayerEnabled() {
  const toggle = document.getElementById('toggle-frames');
  if (toggle) return !!toggle.checked;
  const layer = layers.frames;
  if (!layer || !map?.geoObjects?.contains) return false;
  try {
    return map.geoObjects.contains(layer);
  } catch (err) {
    return false;
  }
}

async function updateFramesForRoute(routeCoords) {
  framesLastRouteCoords = Array.isArray(routeCoords)
    ? routeCoords.map(pt => (Array.isArray(pt) ? [Number(pt[0]), Number(pt[1])] : pt)).filter(pt => Array.isArray(pt) && pt.length >= 2)
    : null;

  if (!isFramesLayerEnabled()) return;

  const vehicleTypeRaw = lastMeta?.vehicle || lastOptions?.vehicle || lastOptions?.mode;
  const vehicleType = typeof vehicleTypeRaw === 'string' ? vehicleTypeRaw.toLowerCase() : vehicleTypeRaw;

  try {
    const layer = await loadFrames();
    if (!layer) return;
    if (!map.geoObjects.contains(layer)) {
      map.geoObjects.add(layer);
    }

    const objects = layer.objects;
    const hasFilter = typeof objects?.setFilter === 'function';
    const resetAll = () => {
      if (hasFilter) {
        objects.setFilter(null);
      } else if (layer.removeAll && framesRawData) {
        layer.removeAll();
        layer.add(framesRawData);
      }
    };
    const hideAll = () => {
      if (hasFilter) {
        objects.setFilter(() => false);
      } else if (layer.removeAll) {
        layer.removeAll();
      }
    };

    if (!framesRawData?.features?.length) {
      hideAll();
      return;
    }

    if (vehicleType === 'car' || vehicleType === 'auto') {
      hideAll();
      return;
    }

    if (!framesLastRouteCoords || framesLastRouteCoords.length < 2) {
      hideAll();
      return;
    }

    const filtered = filterFramesForRoute(framesLastRouteCoords);
    if (!filtered.features.length) {
      hideAll();
      return;
    }

    const allowedIds = new Set();
    filtered.features.forEach((feature) => {
      const key = getFeatureKey(feature);
      if (key) allowedIds.add(key);
    });

    if (!allowedIds.size) {
      hideAll();
      return;
    }

    if (hasFilter) {
      objects.setFilter(obj => allowedIds.has(getFeatureKey(obj)));
    } else {
      layer.removeAll?.();
      layer.add?.(filtered);
    }
  } catch (err) {
    console.warn('[TT] updateFramesForRoute error', err); // eslint-disable-line no-console
    toast('Ошибка обновления весовых рамок: ' + (err?.message || err));
  }
}

/** Включение/выключение слоя по имени */
async function toggleLayer(name, on) {
  if (!map) return;
  const registry = {
    frames: loadFrames,
    hgvAllowed: loadHgvAllowed,
    hgvConditional: loadHgvConditional,
    federal: loadFederal
  };
  const loader = registry[name];
  if (!loader) return;

  if (on) {
    const layer = await loader();
    if (!layer) return;
    if (name === 'frames') {
      const noRoute = !Array.isArray(framesLastRouteCoords) || framesLastRouteCoords.length < 2;
      const objects = layer.objects;
      if (noRoute) {
        if (typeof objects?.setFilter === 'function') {
          objects.setFilter(() => false);
        } else if (typeof layer.removeAll === 'function') {
          layer.removeAll();
        }
      }
      if (!map.geoObjects.contains(layer)) map.geoObjects.add(layer);
      await updateFramesForRoute(framesLastRouteCoords);
      return;
    }
    if (!map.geoObjects.contains(layer)) map.geoObjects.add(layer);
  } else {
    const layer = layers[name];
    if (layer && map.geoObjects.contains(layer)) map.geoObjects.remove(layer);
    if (name === 'frames' && layer?.objects?.setFilter) {
      layer.objects.setFilter(null);
    }
  }
}

/** Инициализация карты и всей UI-логики */
function setup() {
  const cfg = window.TRANSTIME_CONFIG || {};
  const center = (cfg.map && cfg.map.center) || [55.751244, 37.618423];
  const zoom   = (cfg.map && cfg.map.zoom)   || 8;

  // Проверка контейнера
  if (!document.getElementById('map')) {
    toast('Не найден контейнер #map', 2500);
    return;
  }

  // Создаём карту
  map = new ymaps.Map('map', { center, zoom, controls: ['zoomControl', 'typeSelector'] }, { suppressMapOpenBlock: true });
  try {
    const trafficControl = new ymaps.control.TrafficControl({ state: { trafficShown: false } });
    map.controls.add(trafficControl);
  } catch (err) {
    console.warn('[TT] traffic control init failed', err); // eslint-disable-line no-console
  }

  // Ссылки на элементы формы/кнопок (если их нет в верстке — код не упадёт)
  const from = $('#from');
  const to   = $('#to');
  const buildBtn = $('#buildBtn');
  const clearVia = $('#clearVia');
  const saveBtn = $('#saveRouteBtn');
  const shareBtn = $('#shareRouteBtn');
  const openNavBtn = $('#openNavBtn');
  const savedList = $('#savedRoutesList');
  const vehRadios = $$('input[name=veh]');
  const routeList = $('#routeList');
  const viaInput = $('#viaInput');
  const addViaBtn = $('#addViaBtn');
  const viaList = $('#viaList');
  const routeWarnings = $('#routeWarnings');

  dom.from = from;
  dom.to = to;
  dom.buildBtn = buildBtn;
  dom.clearVia = clearVia;
  dom.saveBtn = saveBtn;
  dom.shareBtn = shareBtn;
  dom.openNavBtn = openNavBtn;
  dom.viaInput = viaInput;
  dom.addViaBtn = addViaBtn;
  dom.viaList = viaList;
  dom.savedList = savedList;
  dom.routeList = routeList;
  dom.routeWarnings = routeWarnings;

  if (addViaBtn && !addViaBtn.dataset.defaultText) {
    addViaBtn.dataset.defaultText = addViaBtn.textContent || 'Добавить';
  }

  if (ymaps?.SuggestView) {
    try {
      if (from) new ymaps.SuggestView('from');
      if (to) new ymaps.SuggestView('to');
      if (viaInput) new ymaps.SuggestView('viaInput');
    } catch (err) {
      console.warn('[TT] suggest init failed', err); // eslint-disable-line no-console
    }
  }

  // Чекбоксы слоёв (опционально, если добавлены в HTML)
  const cFrames = $('#toggle-frames');
  const cHgvA   = $('#toggle-hgv-allowed');
  const cHgvC   = $('#toggle-hgv-conditional');
  const cFed    = $('#toggle-federal');

  // === Интеллектуальное обновление UI ===
  function applySmartButtonsRecommendations({ recommendations }) {
    if (!Array.isArray(recommendations)) return;
    recommendations.forEach(({ button, action, reason }) => {
      let el = null;
      if (button === 'btn-route') el = buildBtn;
      if (button === 'btn-clear-via') el = clearVia;
      if (!el) return;

      el.disabled = (action === 'disable');
      el.classList.toggle('highlight', action === 'highlight');
      if (reason) el.title = reason;
    });
  }

  updateUI = function updateUIInner() {
    const hasFrom = !!from?.value.trim();
    const hasTo   = !!to?.value.trim();

    if (buildBtn) {
      buildBtn.disabled = !(hasFrom && hasTo);
      buildBtn.title = buildBtn.disabled ? 'Укажите пункты A и B' : '';
      buildBtn.classList.toggle('highlight', !buildBtn.disabled);
    }
    if (clearVia) {
      clearVia.disabled = viaPoints.length === 0;
      clearVia.title = clearVia.disabled ? 'Нет промежуточных точек для сброса' : '';
    }
    if (dom.addViaBtn) {
      const defaultText = dom.addViaBtn.dataset.defaultText || 'Добавить';
      const hasValue = !!dom.viaInput?.value.trim();
      dom.addViaBtn.disabled = isAddingVia || !hasValue;
      dom.addViaBtn.textContent = isAddingVia ? 'Добавление…' : defaultText;
    }

    // Демонстрационные рекомендации от Smart Buttons (без внешнего API)
    const recs = [];
    recs.push({ button: 'btn-route', action: buildBtn && buildBtn.disabled ? 'disable' : 'enable' });
    recs.push({ button: 'btn-clear-via', action: clearVia && clearVia.disabled ? 'disable' : 'enable' });
    applySmartButtonsRecommendations({ recommendations: recs });
    refreshActionButtons();
  };

  function updateVehGroup() {
    vehRadios.forEach(r => r.parentElement.classList.toggle('active', r.checked));
  }

  // Обработчики ввода
  [from, to, viaInput].forEach(inp => inp?.addEventListener('input', updateUI));
  viaInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleAddViaByAddress();
    }
  });
  vehRadios.forEach(radio => radio.addEventListener('change', updateVehGroup));

  // Переключатели слоёв (если есть в HTML)
  cFrames?.addEventListener('change', e => toggleLayer('frames', e.target.checked));
  cHgvA  ?.addEventListener('change', e => toggleLayer('hgvAllowed', e.target.checked));
  cHgvC  ?.addEventListener('change', e => toggleLayer('hgvConditional', e.target.checked));
  cFed   ?.addEventListener('change', e => toggleLayer('federal', e.target.checked));

  // Авто-включение предустановленных слоёв
  if (cHgvA?.checked) toggleLayer('hgvAllowed', true);
  if (cFrames?.checked) toggleLayer('frames', true);
  if (cHgvC?.checked) toggleLayer('hgvConditional', true);
  if (cFed?.checked) toggleLayer('federal', true);

  async function handleAddViaByAddress() {
    if (!viaInput) return;
    const value = viaInput.value.trim();
    if (!value) return;
    if (isAddingVia) return;
    isAddingVia = true;
    updateUI();
    try {
      const coords = await YandexRouter.geocode(value);
      setViaPoints([...viaPoints, { coords, label: value }]);
      viaInput.value = '';
      toast('Via-точка добавлена по адресу', 1600);
    } catch (err) {
      toast('Не удалось добавить via-точку: ' + (err?.message || err));
    } finally {
      isAddingVia = false;
      updateUI();
    }
  }

  addViaBtn?.addEventListener('click', handleAddViaByAddress);

  // === Добавление via-точек ===
  map.events.add('click', (e) => {
    const coords = e.get('coords');
    if (!Array.isArray(coords)) return;
    const label = `Координаты ${coords[0].toFixed(5)}, ${coords[1].toFixed(5)}`;
    setViaPoints([...viaPoints, { coords, label }]);
    toast(`Добавлена via-точка (${viaPoints.length})`, 1200);
  });

  // === Кнопки управления ===
  buildBtn?.addEventListener('click', onBuild);
  clearVia?.addEventListener('click', () => {
    if (viaInput) viaInput.value = '';
    setViaPoints([]);
    toast('Via-точки очищены', 1200);
  });
  saveBtn?.addEventListener('click', handleSaveRoute);
  shareBtn?.addEventListener('click', handleShareRoute);
  openNavBtn?.addEventListener('click', handleOpenNavigator);

  savedList?.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-action]');
    if (!target) return;
    const id = target.dataset.routeId;
    if (!id) return;
    event.preventDefault();
    if (target.dataset.action === 'load') loadSavedRoute(id);
    if (target.dataset.action === 'delete') deleteSavedRoute(id);
  });

  viaList?.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action="remove"]');
    if (!btn) return;
    const idx = Number(btn.dataset.index);
    if (Number.isNaN(idx)) return;
    const next = viaPoints.filter((_, i) => i !== idx);
    setViaPoints(next);
    toast('Via-точка удалена', 1200);
  });

  routeList?.addEventListener('click', (event) => {
    const btn = event.target.closest('.tt-route-item');
    if (!btn) return;
    const idx = Number(btn.dataset.index);
    if (Number.isNaN(idx)) return;
    if (multiRoute?.setActiveRoute) {
      multiRoute.setActiveRoute(idx);
    }
    highlightActiveRoute(idx);
  });

  // Первичная отрисовка UI
  updateUI();
  renderViaList();
  updateVehGroup();
  renderSavedRoutes();
  setRouteListEmpty();
  refreshActionButtons();
  updateRouteWarnings();
  restoreFromHash();
  window.addEventListener('hashchange', restoreFromHash);

  // Базовая автозагрузка слоя рамок (если нужно всегда показывать при старте)
  // Закомментируйте, если хотите включать вручную чекбоксом:
  // loadFrames().catch(() => toast('Не удалось загрузить весовые рамки'));
}

/** Построение маршрута */
async function onBuild() {
  try {
    const checked = document.querySelector('input[name=veh]:checked');
    const mode = (checked && checked.value) || 'truck40';
    const cfgRouter = window.TRANSTIME_CONFIG?.router || {};
    const opts = { mode: 'truck' };
    if (mode === 'car') {
      opts.mode = 'auto';
    } else if (mode === 'truck40') {
      opts.weight = cfgRouter.weightLight || 40000;
      opts.axleCount = cfgRouter.axleLight || 4;
      opts.dimensions = cfgRouter.dimensionsLight || { height: 4, width: 2.55, length: 16 };
    } else if (mode === 'truckHeavy') {
      opts.weight = cfgRouter.weightHeavy || 60000;
      opts.axleCount = cfgRouter.axleHeavy || 5;
      opts.dimensions = cfgRouter.dimensionsHeavy || { height: 4.5, width: 2.6, length: 20 };
    }
    const altCount = Number(cfgRouter.alternatives);
    opts.alternatives = Number.isFinite(altCount) && altCount > 0 ? altCount : 3;

    const fromVal = $('#from')?.value.trim();
    const toVal   = $('#to')?.value.trim();
    if (!fromVal || !toVal) throw new Error('Укажите адреса Откуда и Куда');

    clearFrameBypasses();
    clearRestrictionArtifacts();

    const A = await YandexRouter.geocode(fromVal);
    const B = await YandexRouter.geocode(toVal);
    const viaCoords = getViaCoordinates();
    const points = [A, ...viaCoords, B];

    const res = await YandexRouter.build(points, opts);
    const mr = res.multiRoute;

    if (multiRoute) {
      if (multiRouteActiveRouteHandler && multiRoute.events?.remove) {
        try {
          multiRoute.events.remove('activeroutechange', multiRouteActiveRouteHandler);
        } catch (err) {
          console.warn('[TT] remove activeroutechange handler failed', err); // eslint-disable-line no-console
        }
      }
      multiRouteActiveRouteHandler = null;
      if (multiRouteRequestSuccessHandler && multiRoute.model?.events?.remove) {
        try {
          multiRoute.model.events.remove('requestsuccess', multiRouteRequestSuccessHandler);
        } catch (err) {
          console.warn('[TT] remove requestsuccess handler failed', err); // eslint-disable-line no-console
        }
      }
      multiRouteRequestSuccessHandler = null;
      map.geoObjects.remove(multiRoute);
    }
    multiRoute = mr;
    map.geoObjects.add(multiRoute);
    if (multiRoute?.editor?.start) {
      try {
        multiRoute.editor.start({ addWayPoints: true });
      } catch (err) {
        console.warn('[TT] route editor start failed', err); // eslint-disable-line no-console
      }
    }

    const handleActiveRouteChange = () => {
      const coords = getActiveRouteCoordinates(multiRoute);
      const maybePromise = updateFramesForRoute(coords);
      if (maybePromise?.catch) {
        maybePromise.catch((err) => console.warn('[TT] frames update failed', err)); // eslint-disable-line no-console
      }

      const vehicleMode = (lastMeta?.vehicle || mode || '').toLowerCase();
      if (Array.isArray(coords) && coords.length > 1) {
        if (vehicleMode === 'car' || vehicleMode === 'auto') {
          clearFrameBypasses();
        } else {
          const bypassPromise = buildFrameBypassesForRoute(coords, { vehicleMode });
          bypassPromise?.catch?.((err) => console.warn('[TT] bypass update failed', err)); // eslint-disable-line no-console
        }
        const restrictionPromise = checkTruckRestrictions(coords, vehicleMode);
        restrictionPromise?.catch?.((err) => console.warn('[TT] restriction check failed', err)); // eslint-disable-line no-console
      } else {
        clearFrameBypasses();
        clearRestrictionArtifacts();
      }

      const activeIndex = getActiveRouteIndex(multiRoute);
      highlightActiveRoute(activeIndex);
      try {
        const activeRoute = typeof multiRoute?.getActiveRoute === 'function' ? multiRoute.getActiveRoute() : null;
        const distance = activeRoute?.properties?.get?.('distance');
        const duration = activeRoute?.properties?.get?.('duration');
        patchLastMeta({
          activeRouteIndex: activeIndex,
          distanceMeters: distance?.value,
          distanceText: distance?.text,
          durationSeconds: duration?.value,
          durationText: duration?.text
        });
      } catch (err) {
        console.warn('[TT] active route meta failed', err); // eslint-disable-line no-console
      }
    };
    multiRouteActiveRouteHandler = handleActiveRouteChange;
    if (multiRoute?.events?.add) {
      multiRoute.events.add('activeroutechange', handleActiveRouteChange);
    }

    const handleRequestSuccess = () => {
      const routesCollection = typeof multiRoute?.getRoutes === 'function' ? multiRoute.getRoutes() : null;
      if (routesCollection) {
        updateRouteList(routesCollection);
        highlightActiveRoute(getActiveRouteIndex(multiRoute));
      }
      handleActiveRouteChange();
    };
    multiRouteRequestSuccessHandler = handleRequestSuccess;
    if (multiRoute?.model?.events?.add) {
      multiRoute.model.events.add('requestsuccess', handleRequestSuccess);
    }

    const meta = {
      from: fromVal,
      to: toVal,
      vehicle: mode,
      name: `${fromVal} → ${toVal}`,
      viaCount: viaPoints.length
    };
    const routeOptions = { ...opts, vehicle: mode };
    setLastRoute(points, routeOptions, meta);

    if (res.routes) {
      updateRouteList(res.routes);
    } else {
      setRouteListEmpty('Маршруты не найдены.');
    }

    handleActiveRouteChange();
    updateUI();

    toast('Маршрут успешно построен', 1800);
  } catch (e) {
    toast(typeof e === 'string' ? e : (e.message || 'Ошибка построения маршрута'));
  }
}

