// map/assets/js/yandex.js
// Trans-Time / Яндекс.Карты — интеллектуальная карта с умными кнопками и слоями

import { $, $$, toast, fmtDist, fmtTime, escapeHtml } from './core.js';
import { YandexRouter } from './router.js';

const STORAGE_KEY = 'tt-yandex-saved-routes';
let map, multiRoute, viaPoints = [];
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
  savedList: null
};
let updateUI = () => {};

/** Регистр слоёв (ObjectManager'ы) */
const layers = {
  frames: null,          // frames_ready.geojson (весовые рамки)
  hgvAllowed: null,      // hgv_allowed.geojson (разрешено HGV)
  hgvConditional: null,  // hgv_conditional.geojson (условия для HGV)
  federal: null          // federal.geojson (федеральные трассы)
};

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

function setViaPoints(points = []) {
  viaPoints = Array.isArray(points) ? points.map(pt => (Array.isArray(pt) ? [Number(pt[0]), Number(pt[1])] : pt)) : [];
  if (map) {
    viaMarkers.forEach(m => map.geoObjects.remove(m));
    viaMarkers = [];
    viaPoints.forEach((coords, idx) => {
      const mark = new ymaps.Placemark(
        coords,
        { hintContent: 'via ' + (idx + 1) },
        { preset: 'islands#darkGreenCircleDotIcon' }
      );
      map.geoObjects.add(mark);
      viaMarkers.push(mark);
    });
  }
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
    wrap.style.display = 'flex';
    wrap.style.gap = '6px';
    wrap.style.marginBottom = '6px';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tt-btn';
    btn.dataset.action = 'load';
    btn.dataset.routeId = route.id;
    btn.textContent = route.name || `${route.from || 'A'} → ${route.to || 'B'}`;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'tt-btn';
    del.dataset.action = 'delete';
    del.dataset.routeId = route.id;
    del.title = 'Удалить маршрут';
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

/** Универсальный загрузчик GeoJSON в ObjectManager */
async function loadGeoJsonLayer(url, options = {}) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'v=' + Date.now());
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  const data = await r.json();

  const om = new ymaps.ObjectManager({ clusterize: false });
  if (options.preset) om.objects.options.set({ preset: options.preset });
  if (options.zIndex) om.objects.options.set({ zIndex: options.zIndex });

  // Нормализуем подсказки/баллоны, если есть properties
  if (data && Array.isArray(data.features)) {
    data.features.forEach(f => {
      const p = f.properties || {};
      f.properties = {
        hintContent: p.name || p.title || 'Объект',
        balloonContent:
          `<b>${escapeHtml(p.name || p.title || 'Объект')}</b>` +
          (p.comment ? `<div class="mt6">${escapeHtml(p.comment)}</div>` : '') +
          (p.date ? `<div class="small mt6">Дата: ${escapeHtml(p.date)}</div>` : '')
      };
    });
  }

  om.add(data);
  return om;
}

/** Конкретные загрузчики слоёв */
async function loadFrames() {
  if (layers.frames) return layers.frames;
  layers.frames = await loadGeoJsonLayer('../data/frames_ready.geojson', {
    preset: 'islands#blueCircleDotIcon',
    zIndex: 220
  });
  map.geoObjects.add(layers.frames);
  return layers.frames;
}
async function loadHgvAllowed() {
  if (layers.hgvAllowed) return layers.hgvAllowed;
  layers.hgvAllowed = await loadGeoJsonLayer('../data/hgv_allowed.geojson', {
    preset: 'islands#darkGreenCircleDotIcon',
    zIndex: 210
  });
  map.geoObjects.add(layers.hgvAllowed);
  return layers.hgvAllowed;
}
async function loadHgvConditional() {
  if (layers.hgvConditional) return layers.hgvConditional;
  layers.hgvConditional = await loadGeoJsonLayer('../data/hgv_conditional.geojson', {
    preset: 'islands#yellowCircleDotIcon',
    zIndex: 205
  });
  map.geoObjects.add(layers.hgvConditional);
  return layers.hgvConditional;
}
async function loadFederal() {
  if (layers.federal) return layers.federal;
  layers.federal = await loadGeoJsonLayer('../data/federal.geojson', {
    preset: 'islands#grayCircleDotIcon',
    zIndex: 200
  });
  map.geoObjects.add(layers.federal);
  return layers.federal;
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
    if (!map.geoObjects.contains(layer)) map.geoObjects.add(layer);
  } else {
    const layer = layers[name];
    if (layer && map.geoObjects.contains(layer)) map.geoObjects.remove(layer);
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

  dom.from = from;
  dom.to = to;
  dom.buildBtn = buildBtn;
  dom.clearVia = clearVia;
  dom.saveBtn = saveBtn;
  dom.shareBtn = shareBtn;
  dom.openNavBtn = openNavBtn;
  dom.savedList = savedList;

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
  [from, to].forEach(inp => inp?.addEventListener('input', updateUI));
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

  // === Добавление via-точек ===
  map.events.add('click', (e) => {
    const coords = e.get('coords');
    setViaPoints([...viaPoints, coords]);
    toast(`Добавлена via-точка (${viaPoints.length})`, 1200);
  });

  // === Кнопки управления ===
  buildBtn?.addEventListener('click', onBuild);
  clearVia?.addEventListener('click', () => {
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

  // Первичная отрисовка UI
  updateUI();
  updateVehGroup();
  renderSavedRoutes();
  refreshActionButtons();
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
    const opts = { mode: 'truck' };
    if (mode === 'car') opts.mode = 'auto';
    if (mode === 'truck40') opts.weight = 40000;
    if (mode === 'truckHeavy') opts.weight = 55000;

    const fromVal = $('#from')?.value.trim();
    const toVal   = $('#to')?.value.trim();
    if (!fromVal || !toVal) throw new Error('Укажите адреса Откуда и Куда');

    const A = await YandexRouter.geocode(fromVal);
    const B = await YandexRouter.geocode(toVal);
    const points = [A, ...viaPoints, B];

    const res = await YandexRouter.build(points, opts);
    const mr = res.multiRoute;

    if (multiRoute) map.geoObjects.remove(multiRoute);
    multiRoute = mr;
    map.geoObjects.add(multiRoute);

    const meta = {
      from: fromVal,
      to: toVal,
      vehicle: mode,
      name: `${fromVal} → ${toVal}`,
      viaCount: viaPoints.length
    };
    const routeOptions = { ...opts, vehicle: mode };
    setLastRoute(points, routeOptions, meta);
    updateUI();

    toast('Маршрут успешно построен', 1800);
  } catch (e) {
    toast(typeof e === 'string' ? e : (e.message || 'Ошибка построения маршрута'));
  }
}

/** Авто-инициализация */
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { try { init(); } catch (e) { console.error(e); } });
  } else {
    try { init(); } catch (e) { console.error(e); }
  }
}
