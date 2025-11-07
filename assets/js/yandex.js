// map/assets/js/yandex.js
// Trans-Time / Яндекс.Карты — интеллектуальная карта с умными кнопками и слоями

import { $, $$, toast, fmtDist, fmtTime, escapeHtml } from './core.js';
import { YandexRouter } from './router.js';

let map, multiRoute, viaPoints = [];
let viaMarkers = [];

/** Регистр слоёв (ObjectManager'ы) */
const layers = {
  frames: null,          // frames_ready.geojson (весовые рамки)
  hgvAllowed: null,      // hgv_allowed.geojson (разрешено HGV)
  hgvConditional: null,  // hgv_conditional.geojson (условия для HGV)
  federal: null          // federal.geojson (федеральные трассы)
};

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
  script.src =
    'https://api-maps.yandex.ru/2.1/?apikey=' + encodeURIComponent(cfg.apiKey) +
    '&lang=' + encodeURIComponent(cfg.lang || 'ru_RU') +
    '&load=package.standard,package.search,multiRouter.MultiRoute,package.geoObjects';

  script.onload = () => (window.ymaps && typeof ymaps.ready === 'function')
    ? ymaps.ready(setup)
    : toast('Yandex API не инициализировался');

  script.onerror = () => toast('Не удалось загрузить Yandex Maps');
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
  const vehRadios = $$('input[name=veh]');

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

  function updateUI() {
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
  }

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
    viaPoints.push(coords);
    const mark = new ymaps.Placemark(
      coords,
      { hintContent: 'via ' + viaPoints.length },
      { preset: 'islands#darkGreenCircleDotIcon' }
    );
    map.geoObjects.add(mark);
    viaMarkers.push(mark);
    toast(`Добавлена via-точка (${viaPoints.length})`, 1200);
    updateUI();
  });

  // === Кнопки управления ===
  buildBtn?.addEventListener('click', onBuild);
  clearVia?.addEventListener('click', () => {
    viaPoints = [];
    viaMarkers.forEach(m => map.geoObjects.remove(m));
    viaMarkers = [];
    toast('Via-точки очищены', 1200);
    updateUI();
  });

  // Первичная отрисовка UI
  updateUI();
  updateVehGroup();

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
