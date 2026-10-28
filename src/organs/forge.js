/**
 * ORGAN 3 — İzole Üretim ve Self-Healing Hücresi
 *
 * 1) CODER_MODEL, Konsey'in upgraded_spec'inden tek dosyalık (index.html),
 *    koyu temalı, etkileşimli bir mikro-web uygulaması yazar.
 * 2) Çok katmanlı doğrulayıcı kodu denetler:
 *    - Yapısal HTML denetimi (DOCTYPE, kapanmamış/eşleşmeyen etiketler, kesilmiş çıktı)
 *    - Her <script> için node:vm ile sözdizimi derlemesi (modüller için node --check)
 *    - Satır içi olay işleyicilerinin sözdizimi ve tanımsız fonksiyon çağrıları
 *    - Bellek ve süre sınırlı bir worker thread içinde, sahte DOM ile node:vm
 *      çalışma zamanı sondası: tanımsız değişken/fonksiyon (ReferenceError),
 *      DOMContentLoaded/load/olay dinleyicisi/zamanlayıcı yollarındaki hatalar
 * 3) Hata varsa rapor Kodlayıcı Ajan'a geri beslenir ve kod yamalanır
 *    (MAX_SELF_HEAL_RETRIES). Başarılı kod canlı telemetri ajanı enjekte
 *    edilerek ./artifacts/:dna_id/index.html'e yazılır ve deploy-queue'ya aktarılır.
 */
import { promises as fsp } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import { config, CIRCUIT_BREAKERS } from '../config/index.js';
import { store, DNA_STATUS } from '../memory/evolution-store.js';
import { enqueueStage } from '../queues/queue-manager.js';
import { callAgentText, BudgetCircuitBreakerError, isConfigError } from '../utils/openrouter.js';
import { organLogger, emitDebateMessage, emitAgentThinking } from '../utils/logger.js';

const log = organLogger('forge');

const ALLOWED_SCRIPT_HOSTS = new Set(['cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']);
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript', 'application/ecmascript']);
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const OPTIONAL_END = new Set(['html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'caption', 'rb', 'rt', 'rtc', 'rp']);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);
const HANDLER_IGNORE = new Set([
  'if', 'for', 'while', 'switch', 'return', 'function', 'typeof', 'void', 'new', 'catch', 'with', 'await', 'async', 'this',
  'alert', 'confirm', 'prompt', 'parseInt', 'parseFloat', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Math',
  'Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'encodeURIComponent',
  'decodeURIComponent', 'isNaN', 'isFinite', 'open', 'print', 'scrollTo', 'fetch', 'Promise', 'event', 'history', 'location',
  'window', 'document', 'navigator', 'console', 'structuredClone', 'queueMicrotask', 'getComputedStyle', 'matchMedia',
]);

/** Harici kütüphane URL deseni → sağladığı global adlar (sandbox'ta taklit edilir). */
const LIBRARY_GLOBALS = [
  [/cdn\.tailwindcss\.com/i, ['tailwind']],
  [/chart(\.umd)?(\.min)?\.js|\/chart\.js/i, ['Chart']],
  [/\/d3(@|\/|\.)/i, ['d3']],
  [/marked/i, ['marked']],
  [/dompurify|purify(\.min)?\.js/i, ['DOMPurify']],
  [/highlight(\.min)?\.js|highlightjs/i, ['hljs']],
  [/prism/i, ['Prism']],
  [/jszip/i, ['JSZip']],
  [/papaparse/i, ['Papa']],
  [/dayjs/i, ['dayjs']],
  [/moment/i, ['moment']],
  [/lodash/i, ['_']],
  [/luxon/i, ['luxon']],
  [/mermaid/i, ['mermaid']],
  [/katex/i, ['katex', 'renderMathInElement']],
  [/qrcode/i, ['QRCode', 'qrcode']],
  [/js-yaml/i, ['jsyaml']],
  [/\/yaml(@|\/)/i, ['YAML']],
  [/crypto-js/i, ['CryptoJS']],
  [/\/tone(@|\/|\.)/i, ['Tone']],
  [/three/i, ['THREE']],
  [/gsap/i, ['gsap']],
  [/anime/i, ['anime']],
  [/sortable/i, ['Sortable']],
  [/confetti/i, ['confetti']],
  [/html2canvas/i, ['html2canvas']],
  [/jspdf/i, ['jspdf', 'jsPDF']],
  [/pdf(\.min)?\.m?js|pdfjs/i, ['pdfjsLib']],
  [/fuse/i, ['Fuse']],
  [/alpine/i, ['Alpine']],
  [/lucide/i, ['lucide']],
  [/feather/i, ['feather']],
  [/\/diff(@|\/|\.)/i, ['Diff']],
  [/sql-wasm|sql\.js/i, ['initSqlJs']],
  [/tesseract/i, ['Tesseract']],
  [/xlsx/i, ['XLSX']],
  [/mathjs|math(\.min)?\.js/i, ['math']],
  [/prettier/i, ['prettier', 'prettierPlugins']],
  [/codemirror/i, ['CodeMirror']],
  [/sql-formatter/i, ['sqlFormatter']],
  [/beautify/i, ['js_beautify', 'html_beautify', 'css_beautify']],
  [/cronstrue/i, ['cronstrue']],
  [/handlebars/i, ['Handlebars']],
  [/mustache/i, ['Mustache']],
  [/ajv/i, ['Ajv', 'ajv2020']],
  [/fflate/i, ['fflate']],
  [/pako/i, ['pako']],
];
const KNOWN_LIB_GLOBALS = [...new Set(LIBRARY_GLOBALS.flatMap(([, names]) => names))];

// ════════════════════════════════════════════════════════════════════
//  Sandbox prelude — node:vm bağlamı içinde çalışan sahte tarayıcı ortamı
//  (Bu fonksiyon dizeye çevrilip izole bağlamda yürütülür; dış kapsama erişmez.)
// ════════════════════════════════════════════════════════════════════
function sandboxPrelude() {
  'use strict';
  var G = globalThis;
  var noop = function () {};
  var report = { errors: [], listeners: [], timers: [] };
  var lifecycle = { DOMContentLoaded: [], load: [], readystatechange: [], pageshow: [] };
  var stores = [];
  var lifecycleFired = 0;

  function toSet(list) {
    var out = Object.create(null);
    for (var i = 0; i < list.length; i += 1) out[list[i]] = true;
    return out;
  }
  var STR = toSet(['value', 'textContent', 'innerHTML', 'outerHTML', 'innerText', 'outerText', 'id', 'className', 'tagName', 'nodeName',
    'href', 'src', 'name', 'type', 'key', 'code', 'title', 'placeholder', 'alt', 'accept', 'download', 'search', 'hash', 'pathname',
    'origin', 'protocol', 'host', 'hostname', 'port', 'result', 'responseText', 'statusText', 'lang', 'dir', 'text', 'label',
    'nodeValue', 'font', 'fillStyle', 'strokeStyle', 'textAlign', 'textBaseline', 'lineCap', 'lineJoin', 'globalCompositeOperation',
    'cssText', 'mimeType', 'inputType', 'locale', 'charset', 'color', 'background', 'display']);
  var NUM = toSet(['length', 'selectionStart', 'selectionEnd', 'scrollTop', 'scrollLeft', 'scrollHeight', 'scrollWidth', 'clientWidth',
    'clientHeight', 'offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft', 'width', 'height', 'naturalWidth', 'naturalHeight',
    'videoWidth', 'videoHeight', 'size', 'selectedIndex', 'tabIndex', 'status', 'currentTime', 'duration', 'volume', 'lineWidth',
    'globalAlpha', 'byteLength', 'top', 'left', 'right', 'bottom', 'x', 'y', 'clientX', 'clientY', 'pageX', 'pageY', 'offsetX',
    'offsetY', 'screenX', 'screenY', 'movementX', 'movementY', 'deltaX', 'deltaY', 'deltaZ', 'deltaMode', 'button', 'buttons',
    'keyCode', 'which', 'charCode', 'detail', 'timeStamp', 'lastModified', 'loaded', 'total', 'sampleRate', 'numberOfChannels',
    'valueAsNumber', 'min', 'max', 'step', 'rows', 'cols', 'maxLength', 'minLength', 'nodeType', 'childElementCount', 'pressure']);
  var FALSEY = toSet(['checked', 'disabled', 'hidden', 'open', 'isComposing', 'repeat', 'ctrlKey', 'metaKey', 'shiftKey', 'altKey',
    'defaultPrevented', 'paused', 'ended', 'multiple', 'required', 'readOnly', 'isContentEditable', 'indeterminate', 'draggable',
    'spellcheck', 'translate', 'muted', 'loop', 'autoplay', 'controls', 'cancelable', 'bubbles', 'composed', 'persisted']);
  var TRUEY = toSet(['done', 'isConnected', 'complete', 'ok', 'isTrusted', 'isSecureContext']);
  // DOM gezinme işaretçileri null döner: while (el.firstChild) ... gibi döngüler sahte düğümlerde sonsuza gitmesin.
  var NULLISH = toSet(['firstChild', 'lastChild', 'firstElementChild', 'lastElementChild', 'nextSibling', 'previousSibling',
    'nextElementSibling', 'previousElementSibling', 'parentNode', 'parentElement', 'offsetParent', 'shadowRoot', 'assignedSlot',
    'ownerSVGElement', 'relatedTarget', 'error', 'firstPage', 'lastPage']);
  var ARR = toSet(['children', 'childNodes', 'files', 'options', 'selectedOptions', 'elements', 'cells', 'touches',
    'changedTouches', 'targetTouches', 'items', 'types', 'attributes', 'labels', 'styleSheets', 'cssRules', 'forms', 'images', 'links']);
  var FN_FALSE = toSet(['hasChildNodes', 'contains', 'matches', 'hasAttribute', 'hasAttributes', 'isEqualNode', 'isSameNode',
    'hasFocus', 'hasPointerCapture', 'webkitMatchesSelector', 'isPointInPath', 'isPointInStroke']);
  var FN_NULL = toSet(['closest', 'getAttribute', 'getAttributeNode', 'item', 'namedItem', 'getItem', 'getData']);
  var FN_TRUE = toSet(['checkValidity', 'reportValidity', 'dispatchEvent', 'execCommand']);
  var FN_STR = toSet(['getPropertyValue', 'toDataURL', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'toFixed',
    'toPrecision', 'trim', 'toUpperCase', 'toLowerCase', 'getAttributeNS', 'lookupNamespaceURI']);
  var FN_ARRAY = toSet(['querySelectorAll', 'getElementsByClassName', 'getElementsByTagName', 'getElementsByName', 'getClientRects',
    'getAnimations', 'composedPath', 'getEntriesByName', 'getEntriesByType', 'assignedNodes', 'assignedElements', 'getTracks']);
  var FN_PROMISE = toSet(['writeText', 'readText', 'read', 'write', 'json', 'text', 'arrayBuffer', 'blob', 'formData', 'play',
    'requestFullscreen', 'exitFullscreen', 'share', 'getUserMedia', 'getDisplayMedia', 'decode', 'query', 'requestPermission',
    'resume', 'suspend', 'showOpenFilePicker', 'showSaveFilePicker', 'createWritable', 'getFile', 'estimate', 'persist', 'load']);

  function record(phase, e) {
    var name = 'Error';
    var message = '';
    try { name = e && e.name ? String(e.name) : typeof e; } catch (_) { name = 'Error'; }
    try { message = e && e.message !== undefined ? String(e.message) : String(e); } catch (_) { message = '?'; }
    if (report.errors.length < 80) report.errors.push({ phase: phase, name: name, message: message.slice(0, 300) });
  }

  function track(ret, phase) {
    try {
      if (ret && typeof ret === 'object' && typeof ret.then === 'function') ret.then(null, function (e) { record(phase + ':async', e); });
    } catch (_) { /* yok say */ }
  }

  function addListener(label, type, fn) {
    var handler = typeof fn === 'function' ? fn : fn && typeof fn.handleEvent === 'function' ? function (ev) { return fn.handleEvent(ev); } : null;
    if (handler && report.listeners.length < 400) report.listeners.push({ label: label, type: String(type), fn: handler });
  }

  function lifecycleAdd(label, type, fn) {
    var t = String(type);
    if (lifecycle[t]) {
      var handler = typeof fn === 'function' ? fn : fn && typeof fn.handleEvent === 'function' ? function (ev) { return fn.handleEvent(ev); } : null;
      if (handler) lifecycle[t].push(handler);
      return;
    }
    addListener(label, t, fn);
  }

  function makeStub(label, overrides) {
    var store = Object.create(null);
    if (overrides) for (var key in overrides) store[key] = overrides[key];
    if (stores.length < 5000) stores.push({ label: label, store: store });
    var target = function () {};
    return new Proxy(target, {
      get: function (t, p) {
        if (p in store) return store[p];
        if (typeof p === 'symbol') {
          if (p === Symbol.toPrimitive) return function (hint) { return hint === 'number' ? 0 : ''; };
          if (p === Symbol.iterator) return function () { return [][Symbol.iterator](); };
          return undefined;
        }
        if (p === 'then') return undefined;
        if (p === 'prototype') return t.prototype;
        if (p === 'toString' || p === 'valueOf' || p === 'toJSON') return function () { return ''; };
        if (p === 'addEventListener') return function (type, fn) { addListener(label, type, fn); };
        if (p === 'removeEventListener') return noop;
        if (STR[p]) return '';
        if (NUM[p]) return 0;
        if (FALSEY[p]) return false;
        if (TRUEY[p]) return true;
        if (NULLISH[p]) return null;
        if (ARR[p]) { store[p] = []; return store[p]; }
        if (FN_FALSE[p]) return function () { return false; };
        if (FN_NULL[p]) return function () { return null; };
        if (FN_TRUE[p]) return function () { return true; };
        if (FN_STR[p]) return function () { return p === 'toDataURL' ? 'data:,' : ''; };
        if (FN_ARRAY[p]) return function (sel) { return [makeStub(label + '.' + p + '(' + String(sel).slice(0, 40) + ')[0]')]; };
        if (FN_PROMISE[p]) {
          return function () {
            if (p === 'text' || p === 'readText') return Promise.resolve('');
            if (p === 'arrayBuffer') return Promise.resolve(new ArrayBuffer(0));
            return Promise.resolve(makeStub(label + '.' + p + '()'));
          };
        }
        if (p === 'getBoundingClientRect') {
          return function () { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: function () { return {}; } }; };
        }
        var child = makeStub(label + '.' + p);
        store[p] = child;
        return child;
      },
      set: function (t, p, v) { store[p] = v; return true; },
      has: function () { return true; },
      deleteProperty: function (t, p) { delete store[p]; return true; },
      apply: function () { return makeStub(label + '()'); },
      construct: function () { return makeStub('new ' + label); },
    });
  }

  function makeEvent(type, target) {
    return makeStub('event:' + type, {
      type: type, target: target, currentTarget: target, srcElement: target, relatedTarget: null,
      preventDefault: noop, stopPropagation: noop, stopImmediatePropagation: noop,
      key: 'Enter', code: 'Enter', isTrusted: true, defaultPrevented: false,
    });
  }

  function makeStorage() {
    var map = new Map();
    return {
      getItem: function (k) { k = String(k); return map.has(k) ? map.get(k) : null; },
      setItem: function (k, v) { map.set(String(k), String(v)); },
      removeItem: function (k) { map.delete(String(k)); },
      clear: function () { map.clear(); },
      key: function (i) { var keys = Array.from(map.keys()); return i >= 0 && i < keys.length ? keys[i] : null; },
      get length() { return map.size; },
    };
  }

  function makeResponse() {
    return makeStub('response', {
      ok: true, status: 200, statusText: 'OK', redirected: false, type: 'basic', url: '',
      headers: makeStub('headers', { get: function () { return null; }, has: function () { return false; } }),
      json: function () { return Promise.resolve(makeStub('response.json()')); },
      text: function () { return Promise.resolve(''); },
      blob: function () { return Promise.resolve(makeStub('blob')); },
      arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(0)); },
      clone: function () { return makeResponse(); },
    });
  }

  var timerSeq = 0;
  function addTimer(kind, fn) {
    timerSeq += 1;
    if (typeof fn === 'function' && report.timers.length < 200) report.timers.push({ id: timerSeq, kind: kind, fn: fn, cancelled: false });
    return timerSeq;
  }
  function cancelTimer(id) {
    for (var i = 0; i < report.timers.length; i += 1) if (report.timers[i].id === id) report.timers[i].cancelled = true;
  }

  var byId = Object.create(null);
  var bySelector = Object.create(null);
  var body = makeStub('document.body', { tagName: 'BODY', nodeName: 'BODY' });
  var head = makeStub('document.head', { tagName: 'HEAD', nodeName: 'HEAD' });
  var htmlEl = makeStub('document.documentElement', { tagName: 'HTML', nodeName: 'HTML' });
  var doc = makeStub('document', {
    readyState: 'loading', visibilityState: 'visible', hidden: false, title: '', cookie: '', referrer: '',
    URL: 'http://localhost/apps/sandbox/', characterSet: 'UTF-8', contentType: 'text/html', compatMode: 'CSS1Compat',
    body: body, head: head, documentElement: htmlEl, activeElement: body, scrollingElement: htmlEl, defaultView: G,
    fonts: makeStub('document.fonts', { ready: Promise.resolve() }),
    addEventListener: function (type, fn) { lifecycleAdd('document', type, fn); },
    removeEventListener: noop,
    getElementById: function (id) {
      var k = String(id);
      if (!byId[k]) byId[k] = makeStub('#' + k, { id: k });
      return byId[k];
    },
    querySelector: function (sel) {
      var k = String(sel);
      if (!bySelector[k]) bySelector[k] = makeStub(k);
      return bySelector[k];
    },
    createElement: function (tag) {
      var t = String(tag).toUpperCase();
      return makeStub('<' + t.toLowerCase() + '>', { tagName: t, nodeName: t });
    },
    createElementNS: function (ns, tag) { return makeStub('<' + String(tag) + '>', { tagName: String(tag), nodeName: String(tag) }); },
    createTextNode: function (text) { return makeStub('#text', { textContent: String(text), nodeValue: String(text), data: String(text) }); },
    createDocumentFragment: function () { return makeStub('#fragment'); },
    createTreeWalker: function () { return makeStub('treewalker', { nextNode: function () { return null; }, currentNode: null }); },
    createNodeIterator: function () { return makeStub('nodeiterator', { nextNode: function () { return null; } }); },
    execCommand: function () { return true; },
    hasFocus: function () { return true; },
  });

  G.window = G;
  G.self = G;
  G.top = G;
  G.parent = G;
  G.frames = G;
  G.document = doc;
  G.addEventListener = function (type, fn) { lifecycleAdd('window', type, fn); };
  G.removeEventListener = noop;
  G.dispatchEvent = function () { return true; };
  G.console = { log: noop, info: noop, warn: noop, error: noop, debug: noop, table: noop, group: noop, groupCollapsed: noop,
    groupEnd: noop, time: noop, timeEnd: noop, timeLog: noop, trace: noop, assert: noop, count: noop, dir: noop, clear: noop };
  G.alert = noop;
  G.confirm = function () { return true; };
  G.prompt = function () { return ''; };
  G.open = function () { return makeStub('window.open()'); };
  G.close = noop; G.print = noop; G.focus = noop; G.blur = noop; G.stop = noop;
  G.scrollTo = noop; G.scrollBy = noop; G.scroll = noop; G.postMessage = noop; G.moveTo = noop; G.resizeTo = noop;
  G.innerWidth = 1280; G.innerHeight = 800; G.outerWidth = 1280; G.outerHeight = 800; G.devicePixelRatio = 1;
  G.scrollX = 0; G.scrollY = 0; G.pageXOffset = 0; G.pageYOffset = 0; G.isSecureContext = true; G.closed = false;
  G.name = ''; G.origin = 'http://localhost';
  G.location = makeStub('location', {
    href: 'http://localhost/apps/sandbox/', pathname: '/apps/sandbox/', search: '', hash: '', origin: 'http://localhost',
    host: 'localhost', hostname: 'localhost', protocol: 'http:', port: '', reload: noop, assign: noop, replace: noop,
  });
  G.history = makeStub('history', { length: 1, state: null, scrollRestoration: 'auto', pushState: noop, replaceState: noop, back: noop, forward: noop, go: noop });
  G.navigator = makeStub('navigator', {
    userAgent: 'Mozilla/5.0 (GhostForgeSandbox)', language: 'en-US', languages: ['en-US'], platform: 'Linux x86_64',
    hardwareConcurrency: 4, deviceMemory: 4, onLine: true, cookieEnabled: true, maxTouchPoints: 0, vendor: '', webdriver: false,
    sendBeacon: function () { return true; }, vibrate: function () { return true; },
  });
  G.screen = makeStub('screen', { width: 1280, height: 800, availWidth: 1280, availHeight: 800, colorDepth: 24, pixelDepth: 24 });
  G.visualViewport = makeStub('visualViewport', { width: 1280, height: 800, scale: 1 });
  G.localStorage = makeStorage();
  G.sessionStorage = makeStorage();
  G.setTimeout = function (fn) { return addTimer('setTimeout', fn); };
  G.setInterval = function (fn) { return addTimer('setInterval', fn); };
  G.clearTimeout = cancelTimer;
  G.clearInterval = cancelTimer;
  G.requestAnimationFrame = function (fn) { return addTimer('requestAnimationFrame', fn); };
  G.cancelAnimationFrame = cancelTimer;
  G.requestIdleCallback = function (fn) { return addTimer('requestIdleCallback', fn); };
  G.cancelIdleCallback = cancelTimer;
  G.queueMicrotask = function (fn) {
    Promise.resolve().then(function () { try { fn(); } catch (e) { record('queueMicrotask', e); } });
  };
  G.structuredClone = function (value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); };
  G.fetch = function () { return Promise.resolve(makeResponse()); };
  G.getComputedStyle = function () { return makeStub('computedStyle', { getPropertyValue: function () { return ''; } }); };
  G.matchMedia = function (query) {
    return makeStub('matchMedia', { matches: false, media: String(query), addListener: noop, removeListener: noop });
  };
  G.atob = function () { return ''; };
  G.btoa = function () { return ''; };
  G.reportError = function (e) { record('reportError', e); };
  var started = Date.now();
  G.performance = makeStub('performance', {
    now: function () { return Date.now() - started; }, timeOrigin: started, mark: noop, measure: noop, clearMarks: noop, clearMeasures: noop,
  });
  G.crypto = makeStub('crypto', {
    getRandomValues: function (arr) {
      if (arr && typeof arr.length === 'number') for (var i = 0; i < arr.length; i += 1) arr[i] = Math.floor(Math.random() * 256);
      return arr;
    },
    randomUUID: function () { return '00000000-0000-4000-8000-000000000000'; },
    subtle: makeStub('crypto.subtle'),
  });
  G.URL = makeStub('URL', { createObjectURL: function () { return 'blob:ghost-sandbox'; }, revokeObjectURL: noop, canParse: function () { return true; } });
  G.webkitURL = G.URL;

  var CONSTRUCTORS = ['XMLHttpRequest', 'Worker', 'SharedWorker', 'WebSocket', 'EventSource', 'Blob', 'File', 'FileReader', 'FormData',
    'Headers', 'Request', 'Response', 'URLSearchParams', 'Image', 'Audio', 'Option', 'Event', 'CustomEvent', 'KeyboardEvent',
    'MouseEvent', 'PointerEvent', 'InputEvent', 'FocusEvent', 'WheelEvent', 'TouchEvent', 'ClipboardEvent', 'DragEvent',
    'MessageEvent', 'ErrorEvent', 'ProgressEvent', 'MessageChannel', 'BroadcastChannel', 'AbortController', 'AbortSignal',
    'TextEncoder', 'TextDecoder', 'DOMParser', 'XMLSerializer', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
    'PerformanceObserver', 'Notification', 'ClipboardItem', 'OffscreenCanvas', 'ImageData', 'ImageBitmap', 'Path2D', 'DOMRect',
    'DOMPoint', 'DOMMatrix', 'AudioContext', 'webkitAudioContext', 'OfflineAudioContext', 'OscillatorNode', 'GainNode',
    'SpeechSynthesisUtterance', 'MediaRecorder', 'MediaStream', 'EventTarget', 'Node', 'Element', 'HTMLElement',
    'HTMLCanvasElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLAnchorElement',
    'HTMLImageElement', 'HTMLDivElement', 'HTMLTemplateElement', 'SVGElement', 'Document', 'DocumentFragment', 'ShadowRoot',
    'NodeList', 'HTMLCollection', 'CSSStyleSheet', 'FontFace', 'CompressionStream', 'DecompressionStream', 'ReadableStream',
    'WritableStream', 'TransformStream', 'Range', 'Selection', 'Text', 'Comment', 'CanvasRenderingContext2D', 'WebGLRenderingContext',
    'WebGL2RenderingContext', 'Intl', 'BarcodeDetector', 'EyeDropper', 'Highlight', 'StaticRange', 'VideoFrame', 'ImageDecoder'];
  for (var c = 0; c < CONSTRUCTORS.length; c += 1) {
    if (!(CONSTRUCTORS[c] in G)) G[CONSTRUCTORS[c]] = makeStub(CONSTRUCTORS[c]);
  }
  var SERVICES = ['customElements', 'indexedDB', 'caches', 'speechSynthesis', 'CSS', 'trustedTypes', 'cookieStore', 'scheduler',
    'launchQueue', 'documentPictureInPicture', 'clientInformation', 'styleMedia', 'external', 'opener', 'frameElement', 'chrome',
    'getSelection', 'createImageBitmap', 'showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker', 'find',
    'webkitRequestAnimationFrame', 'getScreenDetails', 'queryLocalFonts', 'importScripts'];
  for (var s = 0; s < SERVICES.length; s += 1) {
    if (!(SERVICES[s] in G)) G[SERVICES[s]] = makeStub(SERVICES[s]);
  }

  function fireList(list, phase, target) {
    for (var i = 0; i < list.length; i += 1) {
      lifecycleFired += 1;
      try { track(list[i].call(target, makeEvent(phase, target)), phase); } catch (e) { record(phase, e); }
    }
  }

  var probe = {
    defineGlobals: function (names) {
      for (var i = 0; i < names.length; i += 1) {
        var n = String(names[i]);
        if (!(n in G)) G[n] = makeStub(n);
      }
    },
    fireLifecycle: function () {
      doc.readyState = 'interactive';
      fireList(lifecycle.DOMContentLoaded, 'DOMContentLoaded', doc);
      doc.readyState = 'complete';
      fireList(lifecycle.readystatechange, 'readystatechange', doc);
      if (typeof doc.onreadystatechange === 'function') fireList([doc.onreadystatechange], 'readystatechange', doc);
      if (typeof doc.onDOMContentLoaded === 'function') fireList([doc.onDOMContentLoaded], 'DOMContentLoaded', doc);
      if (typeof G.onload === 'function') fireList([G.onload], 'load', G);
      fireList(lifecycle.load, 'load', G);
      fireList(lifecycle.pageshow, 'pageshow', G);
    },
    collectPropertyHandlers: function () {
      for (var i = 0; i < stores.length; i += 1) {
        var entry = stores[i];
        for (var key in entry.store) {
          if (key.length > 2 && key.slice(0, 2) === 'on' && typeof entry.store[key] === 'function' && report.listeners.length < 400) {
            report.listeners.push({ label: entry.label, type: key.slice(2), fn: entry.store[key] });
          }
        }
      }
      var winHandlers = ['onresize', 'onkeydown', 'onkeyup', 'onkeypress', 'onhashchange', 'onpopstate', 'onbeforeunload', 'onmessage',
        'onscroll', 'onfocus', 'onblur', 'onpaste', 'oncopy', 'ondrop', 'ondragover', 'onstorage', 'onclick', 'onmousemove', 'onpointerdown'];
      for (var w = 0; w < winHandlers.length; w += 1) {
        if (typeof G[winHandlers[w]] === 'function') report.listeners.push({ label: 'window', type: winHandlers[w].slice(2), fn: G[winHandlers[w]] });
      }
    },
    listenerCount: function () { return report.listeners.length; },
    fireListener: function (index) {
      var listener = report.listeners[index];
      if (!listener) return;
      var targetEl = makeStub(listener.label);
      var phase = 'event:' + listener.type + '@' + listener.label;
      try { track(listener.fn.call(targetEl, makeEvent(listener.type, targetEl)), phase); } catch (e) { record(phase, e); }
    },
    timerCount: function () { return report.timers.length; },
    fireTimer: function (index) {
      var timer = report.timers[index];
      if (!timer || timer.cancelled) return;
      try { track(timer.fn.call(G, 16), timer.kind); } catch (e) { record(timer.kind, e); }
    },
    result: function () {
      return JSON.stringify({
        errors: report.errors,
        stats: { listeners: report.listeners.length, timers: report.timers.length, lifecycle_handlers: lifecycleFired },
      });
    },
  };
  Object.defineProperty(G, '__ghostForgeProbe__', { value: probe, writable: false, enumerable: false, configurable: false });
}

// ════════════════════════════════════════════════════════════════════
//  Worker thread — çalışma zamanı sondası (CommonJS olarak eval edilir)
// ════════════════════════════════════════════════════════════════════
function probeWorkerMain() {
  /* global require */
  const { parentPort, workerData } = require('node:worker_threads');
  const vm = require('node:vm');
  const stray = [];
  const IDENT = /^([A-Za-z_$][\w$]*) is not defined$/;

  function describe(e) {
    let name = 'Error';
    let message = '';
    try {
      name = e && e.name ? String(e.name) : typeof e;
    } catch (_) {
      name = 'Error';
    }
    try {
      message = e && e.message !== undefined ? String(e.message) : String(e);
    } catch (_) {
      message = '[okunamayan hata]';
    }
    return { name, message: message.slice(0, 300) };
  }
  function isTimeout(e) {
    try {
      return Boolean(e && (e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /timed out/i.test(String(e.message))));
    } catch (_) {
      return false;
    }
  }
  process.on('unhandledRejection', (reason) => {
    if (stray.length < 10) stray.push(describe(reason));
  });

  function runOnce(extraStubs) {
    const findings = [];
    const step = workerData.stepTimeout;
    const ctx = vm.createContext({}, {
      name: 'ghost-forge-probe',
      codeGeneration: { strings: true, wasm: false },
      microtaskMode: 'afterEvaluate',
    });
    vm.runInContext(workerData.prelude, ctx, { timeout: 3000, filename: 'ghost-sandbox-prelude.js' });
    const call = (expr, phase) => {
      try {
        return vm.runInContext(expr, ctx, { timeout: step });
      } catch (e) {
        findings.push({ phase, timeout: isTimeout(e), ...describe(e) });
        return null;
      }
    };
    const stubs = workerData.libGlobals.concat(extraStubs);
    if (stubs.length) call(`globalThis.__ghostForgeProbe__.defineGlobals(${JSON.stringify(stubs)})`, 'stubs');
    for (const script of workerData.scripts) {
      try {
        new vm.Script(script.code, { filename: `inline-script-${script.index}.js` }).runInContext(ctx, { timeout: step });
      } catch (e) {
        findings.push({ phase: `script#${script.index}`, timeout: isTimeout(e), ...describe(e) });
      }
    }
    call('globalThis.__ghostForgeProbe__.fireLifecycle()', 'lifecycle');
    call('globalThis.__ghostForgeProbe__.collectPropertyHandlers()', 'collect');
    const listenerCount = Math.min(Number(call('globalThis.__ghostForgeProbe__.listenerCount()', 'count')) || 0, 150);
    for (let i = 0; i < listenerCount; i += 1) call(`globalThis.__ghostForgeProbe__.fireListener(${i})`, `listener#${i}`);
    const timerCount = Math.min(Number(call('globalThis.__ghostForgeProbe__.timerCount()', 'count')) || 0, 60);
    for (let i = 0; i < timerCount; i += 1) call(`globalThis.__ghostForgeProbe__.fireTimer(${i})`, `timer#${i}`);

    // Adların bağlamda çağrılabilir olup olmadığını denetler (typeof; TDZ dahil).
    const notCallable = (names, phase) => {
      if (!names.length) return [];
      const checks = names
        .map((n) => `try{if(typeof ${n}!=="function")o.push(${JSON.stringify(n)})}catch(e){o.push(${JSON.stringify(n)})}`)
        .join(';');
      const raw = call(`(function(){var o=[];${checks};return JSON.stringify(o)})()`, phase);
      try {
        return JSON.parse(raw || '[]');
      } catch (_) {
        return [];
      }
    };
    const missingHandlers = notCallable(workerData.handlerNames, 'handlers');
    const undefinedCalls = notCallable(workerData.callNames || [], 'calls');
    let internal = { errors: [], stats: {} };
    try {
      internal = JSON.parse(call('globalThis.__ghostForgeProbe__.result()', 'result') || '{}');
    } catch (_) {
      internal = { errors: [], stats: {} };
    }
    return {
      findings: findings.concat(internal.errors || []),
      missingHandlers,
      undefinedCalls,
      stats: { ...(internal.stats || {}), listeners_exercised: listenerCount, timers_exercised: timerCount },
    };
  }

  (async () => {
    try {
      const known = new Set(workerData.knownLibGlobals);
      const extra = [];
      let outcome = runOnce(extra);
      if (workerData.externalLibs) {
        for (let round = 0; round < 8; round += 1) {
          const ref = outcome.findings.find((f) => f.name === 'ReferenceError' && IDENT.test(f.message));
          if (!ref) break;
          const ident = IDENT.exec(ref.message)[1];
          if (extra.includes(ident) || !(known.has(ident) || /^[A-Z]/.test(ident))) break;
          extra.push(ident);
          outcome = runOnce(extra);
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
      parentPort.postMessage({ ok: true, ...outcome, autoStubbed: extra, stray });
    } catch (err) {
      parentPort.postMessage({ ok: false, error: describe(err) });
    }
  })();
}

const SANDBOX_PRELUDE_SOURCE = `(${sandboxPrelude.toString()})();`;
const PROBE_WORKER_SOURCE = `(${probeWorkerMain.toString()})();`;

function runRuntimeProbe(payload) {
  return new Promise((resolve) => {
    let settled = false;
    let killer = null;
    let worker = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (killer) clearTimeout(killer);
      if (worker) worker.terminate().catch(() => {});
      resolve(value);
    };
    try {
      worker = new Worker(PROBE_WORKER_SOURCE, {
        eval: true,
        workerData: { ...payload, prelude: SANDBOX_PRELUDE_SOURCE, knownLibGlobals: KNOWN_LIB_GLOBALS },
        resourceLimits: { maxOldGenerationSizeMb: CIRCUIT_BREAKERS.SANDBOX_MEMORY_MB, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
        stdout: true,
        stderr: true,
      });
    } catch (err) {
      finish({ ok: false, error: { name: 'ProbeError', message: err.message } });
      return;
    }
    worker.stdout?.resume();
    worker.stderr?.resume();
    killer = setTimeout(
      () => finish({ ok: false, error: { name: 'ProbeTimeout', message: `Çalışma zamanı sondası ${CIRCUIT_BREAKERS.SANDBOX_TOTAL_TIMEOUT_MS}ms içinde bitmedi` } }),
      CIRCUIT_BREAKERS.SANDBOX_TOTAL_TIMEOUT_MS,
    );
    worker.once('message', (message) => finish(message));
    worker.once('error', (err) =>
      finish({ ok: false, error: { name: err?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'OutOfMemory' : 'ProbeCrash', message: err?.message || String(err) } }),
    );
    worker.once('exit', (code) => finish({ ok: false, error: { name: 'ProbeExit', message: `Sonda beklenmedik şekilde kapandı (kod ${code})` } }));
  });
}

// ════════════════════════════════════════════════════════════════════
//  Yapısal HTML analizi
// ════════════════════════════════════════════════════════════════════
function buildLineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function decodeAttr(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAttributes(source) {
  const attrs = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = re.exec(source))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4];
    attrs[name] = value === undefined ? '' : decodeAttr(value);
  }
  return attrs;
}

export function analyzeHtml(html) {
  const errors = [];
  const warnings = [];
  const scripts = [];
  const inlineHandlers = [];
  const ids = new Map();
  const stack = [];
  const lineAt = buildLineIndex(html);
  const len = html.length;
  let i = 0;

  if (!/^\s*<!doctype html>/i.test(html)) errors.push('Belge <!DOCTYPE html> ile başlamıyor.');
  if (!/<html[\s>]/i.test(html)) errors.push('<html> öğesi yok.');
  if (!/<head[\s>]/i.test(html)) errors.push('<head> öğesi yok.');
  if (!/<body[\s>]/i.test(html)) errors.push('<body> öğesi yok.');
  if (!/<\/html>\s*$/i.test(html)) errors.push('Belge </html> ile bitmiyor — çıktı muhtemelen yarıda kesildi.');
  if (!/<meta[^>]+name=["']?viewport/i.test(html)) warnings.push('viewport meta etiketi eksik (mobil uyumluluk).');

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) {
        errors.push(`Satır ${lineAt(lt)}: HTML yorumu (<!--) kapatılmamış.`);
        break;
      }
      i = end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? len : end + 1;
      continue;
    }
    const head = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 80));
    if (!head) {
      i = lt + 1;
      continue;
    }
    const isClose = html[lt + 1] === '/';
    const name = head[1].toLowerCase();
    let j = lt + head[0].length;
    let quote = null;
    for (; j < len; j += 1) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
    }
    if (j >= len) {
      errors.push(`Satır ${lineAt(lt)}: <${isClose ? '/' : ''}${name}> etiketi '>' ile kapanmadan dosya bitti.`);
      break;
    }
    const tagSource = html.slice(lt, j + 1);
    i = j + 1;
    const line = lineAt(lt);

    if (isClose) {
      let idx = -1;
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k].name === name) {
          idx = k;
          break;
        }
      }
      if (idx === -1) {
        if (!OPTIONAL_END.has(name) && !VOID_ELEMENTS.has(name)) errors.push(`Satır ${line}: eşleşmeyen kapanış etiketi </${name}>.`);
      } else {
        for (let k = stack.length - 1; k > idx; k -= 1) {
          const open = stack[k];
          if (!OPTIONAL_END.has(open.name)) errors.push(`Satır ${open.line}: <${open.name}> kapatılmadan </${name}> (satır ${line}) geldi.`);
        }
        stack.length = idx;
      }
      continue;
    }

    const selfClosing = /\/\s*>$/.test(tagSource);
    const attrs = parseAttributes(tagSource.slice(head[0].length, selfClosing ? -2 : -1));
    if (attrs.id) {
      if (ids.has(attrs.id)) warnings.push(`Satır ${line}: id="${attrs.id}" birden fazla kez kullanılmış (ilk: satır ${ids.get(attrs.id)}).`);
      else ids.set(attrs.id, line);
    }
    for (const [attrName, value] of Object.entries(attrs)) {
      if (attrName.startsWith('on') && attrName.length > 2 && value.trim()) inlineHandlers.push({ attr: attrName, code: value, line });
    }

    if (RAW_TEXT_ELEMENTS.has(name) && !selfClosing) {
      const closeRe = new RegExp(`</${name}\\s*>`, 'ig');
      closeRe.lastIndex = i;
      const close = closeRe.exec(html);
      const contentStart = i;
      let content;
      if (!close) {
        errors.push(`Satır ${line}: <${name}> kapatılmamış (</${name}> yok).`);
        content = html.slice(contentStart);
        i = len;
      } else {
        content = html.slice(contentStart, close.index);
        i = close.index + close[0].length;
      }
      if (name === 'script') scripts.push({ attrs, content, line, contentLine: lineAt(contentStart) });
      continue;
    }
    if (VOID_ELEMENTS.has(name) || selfClosing) continue;
    stack.push({ name, line });
  }

  for (const open of stack) {
    if (!OPTIONAL_END.has(open.name)) errors.push(`Satır ${open.line}: <${open.name}> hiç kapatılmamış.`);
  }

  return { errors: errors.slice(0, 20), warnings, scripts, inlineHandlers, ids };
}

// ════════════════════════════════════════════════════════════════════
//  Script sözdizimi
// ════════════════════════════════════════════════════════════════════
function safeHost(src) {
  try {
    const url = new URL(src.startsWith('//') ? `https:${src}` : src);
    return /^https?:$/.test(url.protocol) ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function syntaxLocation(err, filename) {
  const match = new RegExp(`${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(String(err?.stack || ''));
  return match ? Number(match[1]) : null;
}

function checkModuleSyntax(code) {
  return new Promise((resolve) => {
    const file = path.join(os.tmpdir(), `ghost-forge-${randomBytes(6).toString('hex')}.mjs`);
    fsp
      .writeFile(file, code, 'utf8')
      .then(
        () =>
          new Promise((done) => {
            execFile(process.execPath, ['--check', file], { timeout: 10_000 }, (err, _stdout, stderr) => {
              if (!err) return done(null);
              const lines = String(stderr || err.message)
                .split('\n')
                .filter((line) => line.trim() && !line.includes(file));
              done(lines.slice(0, 3).join(' ').slice(0, 300) || 'sözdizimi hatası');
            });
          }),
      )
      .then((result) => resolve(result))
      .catch((err) => resolve(`modül denetlenemedi: ${err.message}`))
      .finally(() => fsp.unlink(file).catch(() => {}));
  });
}

async function checkScripts(scripts) {
  const errors = [];
  const warnings = [];
  const classic = [];
  const externals = [];
  let index = 0;
  for (const script of scripts) {
    index += 1;
    const type = String(script.attrs.type || '').trim().toLowerCase();
    if (script.attrs.src !== undefined) {
      const src = script.attrs.src;
      externals.push(src);
      const host = safeHost(src);
      if (!host) {
        if (!/^(data:|blob:)/i.test(src)) errors.push(`Satır ${script.line}: göreli/yerel script kaynağı "${src}" — tek dosya kuralı gereği harici yerel dosya kullanılamaz.`);
      } else if (!ALLOWED_SCRIPT_HOSTS.has(host)) {
        errors.push(`Satır ${script.line}: izin verilmeyen script kaynağı "${host}" — yalnızca ${[...ALLOWED_SCRIPT_HOSTS].join(', ')}.`);
      }
      continue;
    }
    const code = script.content;
    if (!code.trim()) continue;
    if (type === 'module') {
      const problem = await checkModuleSyntax(code);
      if (problem) errors.push(`Satır ${script.line}: type="module" script sözdizimi hatası — ${problem}`);
      else warnings.push(`Satır ${script.line}: type="module" script çalışma zamanı sondasında yürütülmedi; klasik script tercih edin.`);
      continue;
    }
    if (['application/json', 'application/ld+json', 'importmap', 'speculationrules'].includes(type)) {
      try {
        JSON.parse(code);
      } catch (err) {
        errors.push(`Satır ${script.line}: JSON script bloğu geçersiz — ${err.message}`);
      }
      continue;
    }
    if (!JS_TYPES.has(type)) {
      try {
        new vm.Script(code, { filename: `script-block-${index}.js` });
      } catch (err) {
        warnings.push(`Satır ${script.line}: type="${type}" bloğu JavaScript olarak derlenemedi (${err.message}). Worker kaynağıysa kontrol edin.`);
      }
      continue;
    }
    const filename = `inline-script-${index}.js`;
    try {
      new vm.Script(code, { filename });
      classic.push({ index, code, line: script.line });
    } catch (err) {
      const rel = syntaxLocation(err, filename);
      const absolute = rel ? script.contentLine + rel - 1 : script.line;
      const snippet = rel ? (code.split('\n')[rel - 1] || '').trim().slice(0, 160) : '';
      errors.push(`Satır ${absolute}: script #${index} SÖZDİZİMİ HATASI — ${err.message}${snippet ? `  →  ${snippet}` : ''}`);
    }
  }
  return { errors, warnings, classic, externals };
}

function checkInlineHandlers(handlers) {
  const errors = [];
  const names = new Set();
  for (const handler of handlers.slice(0, 200)) {
    try {
      new vm.Script(`(function(event){\n${handler.code}\n})`, { filename: 'inline-handler.js' });
    } catch (err) {
      errors.push(`Satır ${handler.line}: ${handler.attr}="${handler.code.slice(0, 80)}" sözdizimi hatası — ${err.message}`);
      continue;
    }
    const re = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
    let match;
    while ((match = re.exec(handler.code))) {
      if (!HANDLER_IGNORE.has(match[2])) names.add(match[2]);
    }
  }
  return { errors, names: [...names].slice(0, 100) };
}

const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'void', 'delete', 'new', 'await', 'yield', 'super',
  'import', 'with', 'do', 'else', 'in', 'of', 'instanceof', 'case', 'throw', 'async', 'get', 'set', 'static', 'constructor',
  'class', 'extends', 'let', 'const', 'var', 'this', 'try', 'finally', 'arguments', 'eval',
]);

/** Yorumları, string/template ve regex literallerini sökerek yalnızca kod iskeletini bırakır. */
export function stripJs(code) {
  let out = '';
  let i = 0;
  let lastSignificant = '';
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      i = end === -1 ? n : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code[j] === ch) break;
        if (ch !== '`' && code[j] === '\n') break;
        j += 1;
      }
      i = j + 1;
      out += ' 0 ';
      lastSignificant = '0';
      continue;
    }
    if (ch === '/' && (lastSignificant === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSignificant))) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const c = code[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if ((c === '/' && !inClass) || c === '\n') break;
        j += 1;
      }
      j += 1;
      while (j < n && /[a-z]/i.test(code[j])) j += 1;
      i = j;
      out += ' 0 ';
      lastSignificant = '0';
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) lastSignificant = ch;
    i += 1;
  }
  return out;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Nitelikli olmayan (önünde "." olmayan) çağrıları bulur ve kodun hiçbir yerinde
 * bildirimi görünmeyenleri döndürür. Yanlış pozitiften kaçınmak için muhafazakârdır:
 * herhangi bir bildirim/parametre/atama izi varsa ad "tanımlı" sayılır.
 */
export function findUndeclaredCalls(code) {
  const stripped = stripJs(code);
  const calls = new Set();
  const re = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = re.exec(stripped))) {
    if (!JS_KEYWORDS.has(match[2])) calls.add(match[2]);
  }
  const undeclared = [];
  for (const name of calls) {
    const e = escapeRegExp(name);
    const declared = new RegExp(
      [
        `function\\s*\\*?\\s*${e}\\b`,
        `class\\s+${e}\\b`,
        `(?:const|let|var)\\s+${e}\\b`,
        `\\b${e}\\s*=(?!=)`,
        `\\b${e}\\s*=>`,
        `[(,]\\s*(?:\\.\\.\\.)?${e}\\s*[,)=]`,
        `[{,]\\s*${e}\\s*[,}:=]`,
        `\\b${e}\\s*\\([^()]*\\)\\s*\\{`,
        `(?:const|let|var)\\s*[{[][^;]*?\\b${e}\\b`,
        `catch\\s*\\(\\s*${e}\\b`,
      ].join('|'),
    ).test(stripped);
    if (!declared) undeclared.push(name);
  }
  return undeclared.slice(0, 80);
}

function checkElementReferences(html, classicScripts, ids) {
  const warnings = [];
  const missing = new Set();
  const allCode = classicScripts.map((script) => script.code).join('\n');
  const re = /getElementById\(\s*(['"])([^'"]+)\1\s*\)/g;
  let match;
  while ((match = re.exec(allCode))) {
    const id = match[2];
    if (ids.has(id) || missing.has(id)) continue;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dynamic = new RegExp(`(id\\s*=\\s*\\\\?["'\`]${escaped}\\\\?["'\`]|\\.id\\s*=\\s*["'\`]${escaped}["'\`]|id:\\s*["'\`]${escaped}["'\`])`).test(html);
    if (!dynamic) missing.add(id);
  }
  for (const id of [...missing].slice(0, 8)) {
    warnings.push(`getElementById("${id}") çağrılıyor ama sayfada id="${id}" olan bir öğe bulunamadı (null erişim riski).`);
  }
  return warnings;
}

function phaseLabel(phase) {
  const p = String(phase || '');
  if (p.startsWith('script#')) return `Script ${p.replace('script', '')} yüklenirken`;
  if (p.startsWith('event:')) return `Olay işleyicisi (${p.slice(6)})`;
  if (p.startsWith('listener#')) return 'Olay işleyicisi';
  if (p.startsWith('timer#') || /^(setTimeout|setInterval|requestAnimationFrame|requestIdleCallback)/.test(p)) return `Zamanlayıcı geri çağrısı (${p})`;
  if (p.startsWith('DOMContentLoaded') || p.startsWith('load') || p === 'lifecycle') return `Sayfa açılışı (${p})`;
  return p;
}

function classifyProbe(probe, { classicCount, externalLibs }) {
  const errors = [];
  const warnings = [];
  if (!probe?.ok) {
    const name = probe?.error?.name || 'ProbeError';
    if (name === 'OutOfMemory') {
      errors.push(`Sayfa yüklenirken aşırı bellek tüketiyor (${CIRCUIT_BREAKERS.SANDBOX_MEMORY_MB}MB sandbox limiti aşıldı). Büyük ön hesaplamaları tembel/parçalı yapın.`);
    } else {
      warnings.push(`Çalışma zamanı sondası tamamlanamadı (${name}: ${probe?.error?.message || 'bilinmiyor'}).`);
    }
    return { errors, warnings };
  }
  const seen = new Set();
  for (const finding of probe.findings || []) {
    const where = phaseLabel(finding.phase);
    const key = `${finding.name}:${finding.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (finding.timeout) {
      warnings.push(`${where}: senkron çalışma ${CIRCUIT_BREAKERS.SANDBOX_STEP_TIMEOUT_MS}ms'yi aştı (sonsuz döngü riski).`);
    } else if (finding.name === 'ReferenceError') {
      errors.push(`${where}: TANIMSIZ DEĞİŞKEN/FONKSİYON — ReferenceError: ${finding.message}`);
    } else if (warnings.length < 12) {
      warnings.push(`${where}: ${finding.name}: ${finding.message}`);
    }
  }
  for (const name of probe.missingHandlers || []) {
    errors.push(`Satır içi olay işleyicisi tanımsız fonksiyon çağırıyor: ${name}() — global bir fonksiyon olarak tanımlayın veya addEventListener kullanın.`);
  }
  for (const name of probe.undefinedCalls || []) {
    if (/^[a-z_$]/.test(name) && !externalLibs) {
      errors.push(`TANIMSIZ FONKSİYON: ${name}() çağrılıyor ama hiçbir yerde tanımlanmamış (try/catch içinde yutulsa bile tarayıcıda ReferenceError üretir).`);
    } else {
      warnings.push(`${name}() çağrılıyor ama bildirimi bulunamadı (harici kütüphane veya tarayıcı API'si olabilir).`);
    }
  }
  for (const ident of probe.autoStubbed || []) {
    warnings.push(`"${ident}" harici kütüphane global'i olarak varsayıldı (CDN script'i yüklenmezse sayfa bozulur).`);
  }
  for (const stray of (probe.stray || []).slice(0, 3)) {
    warnings.push(`Yakalanmamış asenkron hata: ${stray.name}: ${stray.message}`);
  }
  if (classicCount > 0 && (probe.stats?.lifecycle_handlers || 0) + (probe.stats?.listeners || 0) === 0) {
    warnings.push('Hiç olay dinleyicisi kaydedilmedi — araç gerçekten etkileşimli mi?');
  }
  return { errors, warnings };
}

const dedupe = (list) => [...new Set(list)];

/**
 * Üretilen HTML'i çok katmanlı doğrular.
 * @returns {Promise<{ok:boolean, errors:string[], warnings:string[], stats:object}>}
 */
export async function validateArtifact(html, { truncated = false } = {}) {
  const errors = [];
  const warnings = [];
  if (typeof html !== 'string' || !html.trim()) {
    return { ok: false, errors: ['Kodlayıcı bir HTML belgesi döndürmedi (boş çıktı).'], warnings, stats: {} };
  }
  const bytes = Buffer.byteLength(html, 'utf8');
  if (truncated) {
    errors.push('Model çıktısı token sınırında KESİLDİ — dosya eksik. Daha kompakt yaz (gereksiz yorum ve tekrar olmadan) ama tüm özellikleri eksiksiz bitir.');
  }
  if (bytes > CIRCUIT_BREAKERS.MAX_HTML_BYTES) {
    errors.push(`Dosya çok büyük (${Math.round(bytes / 1024)} KB > ${Math.round(CIRCUIT_BREAKERS.MAX_HTML_BYTES / 1024)} KB).`);
  }

  const structure = analyzeHtml(html);
  errors.push(...structure.errors);
  warnings.push(...structure.warnings);

  if (/(\/\/|\/\*|<!--)\s*(TODO|FIXME)\b/i.test(html)) errors.push('Kodda TODO/FIXME yorumu var — her işlev eksiksiz uygulanmalı.');
  if (/lorem ipsum/i.test(html)) errors.push('Lorem ipsum yer tutucu metin var — gerçekçi içerik kullanılmalı.');
  if (/\b(mock implementation|placeholder implementation|not implemented( yet)?|coming soon|burayı doldur)\b/i.test(html)) {
    errors.push('Eksik/yer tutucu uygulama ifadesi bulundu ("not implemented", "coming soon" vb.).');
  }
  if (/\/api\/(scout|reaper|state|dna)\b/.test(html)) errors.push('Kod Ghost Core kontrol API\'sine istek atıyor — buna izin verilmez.');
  if (structure.scripts.length === 0) errors.push('Sayfada hiç <script> yok — araç etkileşimli olmalı.');

  const syntax = await checkScripts(structure.scripts);
  errors.push(...syntax.errors);
  warnings.push(...syntax.warnings);

  const handlers = checkInlineHandlers(structure.inlineHandlers);
  errors.push(...handlers.errors);

  let probeStats = null;
  if (syntax.errors.length === 0 && handlers.errors.length === 0 && syntax.classic.length > 0) {
    const libGlobals = new Set();
    for (const src of syntax.externals) {
      for (const [pattern, names] of LIBRARY_GLOBALS) if (pattern.test(src)) names.forEach((n) => libGlobals.add(n));
    }
    const nonTailwind = syntax.externals.filter((src) => !/cdn\.tailwindcss\.com/i.test(src));
    const externalLibs = nonTailwind.length > 0;
    const probe = await runRuntimeProbe({
      scripts: syntax.classic.map(({ index, code }) => ({ index, code })),
      handlerNames: handlers.names,
      callNames: findUndeclaredCalls(syntax.classic.map((script) => script.code).join('\n;\n')),
      libGlobals: [...libGlobals],
      externalLibs,
      stepTimeout: CIRCUIT_BREAKERS.SANDBOX_STEP_TIMEOUT_MS,
    });
    const classified = classifyProbe(probe, { classicCount: syntax.classic.length, externalLibs });
    errors.push(...classified.errors);
    warnings.push(...classified.warnings);
    probeStats = probe?.ok ? probe.stats : { failed: probe?.error?.name };
    warnings.push(...checkElementReferences(html, syntax.classic, structure.ids));
  }

  const finalErrors = dedupe(errors).slice(0, 25);
  return {
    ok: finalErrors.length === 0,
    errors: finalErrors,
    warnings: dedupe(warnings).slice(0, 25),
    stats: {
      bytes,
      scripts: structure.scripts.length,
      inline_handlers: structure.inlineHandlers.length,
      external_scripts: syntax.externals.length,
      probe: probeStats,
    },
  };
}

// ════════════════════════════════════════════════════════════════════
//  Telemetri ajanı
// ════════════════════════════════════════════════════════════════════
export function buildTelemetryScript(dnaId) {
  const id = JSON.stringify(dnaId);
  const base = JSON.stringify(config.publicBaseUrl);
  return `<script data-ghost-telemetry=${id}>
(function () {
  'use strict';
  try {
    var DNA = ${id};
    var BASE = location.pathname.indexOf('/apps/' + DNA) === 0 ? '' : ${base};
    var ENDPOINT = BASE + '/api/telemetry/' + encodeURIComponent(DNA);
    var started = Date.now();
    var last = {};
    var sent = 0;
    var LIMIT = 150;
    function send(event, meta) {
      if (sent >= LIMIT) return;
      sent += 1;
      var payload = JSON.stringify({ event: event, ts: Date.now(), meta: meta || {} });
      try {
        if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'text/plain;charset=UTF-8' }))) return;
      } catch (e) {}
      try {
        fetch(ENDPOINT, { method: 'POST', body: payload, headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, keepalive: true, mode: 'cors', credentials: 'omit' }).catch(function () {});
      } catch (e) {}
    }
    function throttled(key, event, meta, gap) {
      var now = Date.now();
      if (last[key] && now - last[key] < gap) return;
      last[key] = now;
      send(event, meta);
    }
    function describe(el) {
      if (!el || !el.tagName) return 'unknown';
      var label = el.id ? '#' + el.id : (el.getAttribute && el.getAttribute('aria-label')) || (el.textContent || '').trim().slice(0, 32);
      return el.tagName.toLowerCase() + (label ? ':' + label : '');
    }
    window.ghostTelemetry = {
      ping: function (name, meta) { throttled('custom:' + String(name), 'custom', { name: String(name).slice(0, 60), extra: meta || null }, 500); }
    };
    send('open', { referrer: document.referrer ? 'external' : 'direct' });
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('button, a, [role="button"], input[type="checkbox"], input[type="radio"], select, summary, label') : null;
      if (!el) return;
      var d = describe(el);
      throttled('click:' + d, 'click', { target: d }, 1200);
    }, true);
    document.addEventListener('input', function (e) { throttled('input', 'input', { target: describe(e.target) }, 4000); }, true);
    document.addEventListener('change', function (e) { var d = describe(e.target); throttled('change:' + d, 'change', { target: d }, 2000); }, true);
    document.addEventListener('paste', function () { throttled('paste', 'paste', null, 3000); }, true);
    document.addEventListener('copy', function () { throttled('copy', 'copy', null, 3000); }, true);
    document.addEventListener('drop', function () { throttled('drop', 'drop', null, 3000); }, true);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') throttled('end', 'session_end', { dwell_ms: Date.now() - started }, 30000);
    });
  } catch (e) {}
})();
</script>`;
}

export function injectTelemetry(html, dnaId) {
  const snippet = buildTelemetryScript(dnaId);
  const headClose = html.search(/<\/head\s*>/i);
  if (headClose !== -1) return `${html.slice(0, headClose)}${snippet}\n${html.slice(headClose)}`;
  const bodyOpen = /<body[^>]*>/i.exec(html);
  if (bodyOpen) {
    const at = bodyOpen.index + bodyOpen[0].length;
    return `${html.slice(0, at)}\n${snippet}${html.slice(at)}`;
  }
  return `${snippet}\n${html}`;
}

// ════════════════════════════════════════════════════════════════════
//  Kodlayıcı ajan istemleri
// ════════════════════════════════════════════════════════════════════
const list = (items) => (Array.isArray(items) && items.length ? items.map((item) => `- ${item}`).join('\n') : '- (yok)');

function coderSystemPrompt(rules, storagePrefix) {
  return `You are FORGE, an elite front-end engineer inside "The Foundry". You turn an approved specification into ONE production-quality, self-contained HTML file.

HARD REQUIREMENTS (violating any of them means the build is rejected by an automated validator):
1. Output ONLY the raw HTML document, starting with <!DOCTYPE html> and ending with </html>. No markdown fences, no commentary before or after.
2. Single file. Styling with the TailwindCSS Play CDN: <script src="https://cdn.tailwindcss.com"></script> (you may set tailwind.config in an inline script right after it). Extra custom CSS goes in one <style> block.
3. Logic in classic inline <script> tags — NO type="module", NO import/export. Modern vanilla JavaScript (ES2020+). Other CDNs only if truly necessary and only from cdn.jsdelivr.net, unpkg.com or cdnjs.cloudflare.com.
4. Zero backend: no servers, accounts, API keys or analytics. Never call any /api/ endpoint. Everything runs in the browser. Heavy computation → a Web Worker created from a Blob URL. Visuals → Canvas or SVG when they add value.
5. Persistence only through localStorage, always wrapped in try/catch, keys prefixed with "${storagePrefix}:".
6. Must be COMPLETE and WORKING: no TODO/FIXME, no placeholders, no lorem ipsum, no "coming soon", no dead buttons. Every control does something real.
7. Include an empty state and a "Load example" action with realistic sample data so value is visible in one click.
8. Robustness: validate inputs, show friendly inline errors, never let exceptions escape. Initialise inside a DOMContentLoaded listener (or put scripts at the end of <body>). Every element you look up by id must exist in the markup.
9. Prefer addEventListener over inline on* attributes. If you use inline handlers, every function they call must be a global function declaration.
10. Accessibility: semantic HTML, labelled inputs, aria-live region for results, visible focus rings, sensible keyboard shortcuts.
11. Responsive down to 360px width. Dark theme only.
12. Compact but complete: aim for 15–45 KB. Quality over quantity; no giant comment blocks.

DESIGN GENOME (learned UI rules — follow them):
${list(rules.ui_guidelines)}
PREFERRED PATTERNS:
${list(rules.preferred_patterns)}

All user-facing copy must be in ${config.language.toolUi}.`;
}

function coderUserPrompt(dna) {
  const spec = dna.council?.upgraded_spec || dna.council?.proposer_spec;
  return `Build this micro tool now.

ORIGINAL PAIN SIGNAL: ${dna.signal.title}
${dna.signal.pain_point}

APPROVED SPECIFICATION (council score ${dna.council?.final_score ?? '?'}/100):
${JSON.stringify(spec, null, 2)}

Return the complete index.html.`;
}

function healPrompt(report, attempt) {
  return `AUTOMATED VALIDATION FAILED (self-heal attempt ${attempt}/${CIRCUIT_BREAKERS.MAX_SELF_HEAL_RETRIES}).
Fix EVERY error below and return the COMPLETE corrected HTML document (not a diff, no commentary, no markdown fences).

ERRORS (must fix):
${report.errors.map((e) => `- ${e}`).join('\n')}

WARNINGS (fix when cheap):
${report.warnings.length ? report.warnings.map((w) => `- ${w}`).join('\n') : '- (none)'}`;
}

/** Model çıktısından HTML belgesini çıkarır (çitler ve önsöz/sonsöz temizlenir). */
export function extractHtml(text) {
  if (!text) return '';
  let out = String(text).replace(/^\uFEFF/, '');
  const fenced = /```(?:html|HTML)?\s*\n([\s\S]*?)```/.exec(out);
  if (fenced && /<html[\s>]|<!doctype/i.test(fenced[1])) out = fenced[1];
  else out = out.replace(/^\s*```(?:html|HTML)?\s*\n?/, '');
  const start = out.search(/<!doctype html|<html[\s>]/i);
  if (start > 0) out = out.slice(start);
  if (start === -1) return '';
  const end = out.toLowerCase().lastIndexOf('</html>');
  if (end !== -1) out = out.slice(0, end + '</html>'.length);
  return `${out.trim()}\n`;
}

function storagePrefixFor(dna) {
  const spec = dna.council?.upgraded_spec || {};
  const raw = String(spec.storage_key_prefix || spec.tool_name || 'ghost-tool')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return raw || `ghost-${dna.id.slice(0, 8)}`;
}

async function writeArtifact(dnaId, html) {
  const dir = path.join(config.paths.artifacts, dnaId);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'index.html');
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, html, 'utf8');
  await fsp.rename(tmp, file);
  return file;
}

function summarizeReport(report) {
  const lines = [];
  if (report.errors.length) lines.push(`Hatalar:\n${report.errors.slice(0, 8).map((e) => `✕ ${e}`).join('\n')}`);
  if (report.warnings.length) lines.push(`Uyarılar:\n${report.warnings.slice(0, 5).map((w) => `△ ${w}`).join('\n')}`);
  const probe = report.stats?.probe;
  if (probe && !probe.failed) {
    lines.push(`Sonda: ${probe.lifecycle_handlers ?? 0} açılış işleyicisi, ${probe.listeners_exercised ?? 0} olay dinleyicisi, ${probe.timers_exercised ?? 0} zamanlayıcı çalıştırıldı.`);
  }
  return lines.join('\n\n') || 'Temiz.';
}

async function failForge(dnaId, status, cause, message, extra = {}) {
  const dna = await store.setStatus(dnaId, status, message, (draft) => {
    draft.error = { stage: 'forge', message, ...extra };
  });
  await store.bury(dna, cause, { summary: message });
}

/** Onaylanmış DNA'yı kodlar, doğrular, gerekirse kendi kendini onarır ve dağıtıma gönderir. */
export async function runForge(dnaId) {
  const dna = store.getDna(dnaId);
  if (!dna) {
    log.warn(`Forge: DNA bulunamadı (${dnaId}); görev atlandı.`);
    return { skipped: true };
  }
  if (![DNA_STATUS.APPROVED, DNA_STATUS.FORGING, DNA_STATUS.HEALING].includes(dna.status)) {
    log.info(`Forge: DNA ${dna.status} durumunda; atlandı.`, { dna_id: dnaId });
    return { skipped: true };
  }
  if (!dna.council?.upgraded_spec) {
    await failForge(dnaId, DNA_STATUS.FAILED, 'FORGE_ERROR', 'Konsey spesifikasyonu (upgraded_spec) bulunamadı.');
    return { ok: false };
  }

  const rules = store.getRules();
  const toolName = dna.council.upgraded_spec.tool_name;
  const system = coderSystemPrompt(rules, storagePrefixFor(dna));
  const baseMessages = [{ role: 'user', content: coderUserPrompt(dna) }];
  const healLog = [];
  const startedAt = Date.now();

  await store.setStatus(dnaId, DNA_STATUS.FORGING, 'Kodlayıcı derlemeye başladı', (draft) => {
    draft.error = null;
  });
  emitDebateMessage({ dnaId, role: 'forge', title: `Forge ateşlendi: «${toolName}»`, content: `Model: ${config.models.coder} · self-heal limiti: ${CIRCUIT_BREAKERS.MAX_SELF_HEAL_RETRIES}` });

  let html = '';
  let report = null;
  let attempt = 0;
  try {
    emitAgentThinking({ dnaId, role: 'forge', active: true, label: 'Kodlayıcı index.html yazıyor' });
    let response = await callAgentText({
      agent: 'coder',
      model: config.models.coder,
      dnaId,
      system,
      messages: baseMessages,
      maxTokens: config.forge.coderMaxTokens,
      temperature: 0.4,
    });
    html = extractHtml(response.text);
    report = await validateArtifact(html, { truncated: response.finishReason === 'length' });
    healLog.push({ attempt: 0, ok: report.ok, errors: report.errors, warnings: report.warnings, bytes: report.stats.bytes ?? 0, cost_usd: response.usage.cost_usd });
    emitDebateMessage({
      dnaId,
      role: 'forge',
      title: report.ok ? `Derleme #0 doğrulamadan geçti ✓ (${Math.round((report.stats.bytes || 0) / 1024)} KB)` : `Derleme #0: ${report.errors.length} hata, ${report.warnings.length} uyarı → Self-Healing devrede`,
      content: summarizeReport(report),
      meta: { cost_usd: response.usage.cost_usd },
    });

    while (!report.ok && attempt < CIRCUIT_BREAKERS.MAX_SELF_HEAL_RETRIES) {
      attempt += 1;
      await store.setStatus(dnaId, DNA_STATUS.HEALING, `Self-heal turu ${attempt}/${CIRCUIT_BREAKERS.MAX_SELF_HEAL_RETRIES}`);
      emitAgentThinking({ dnaId, role: 'forge', active: true, label: `Yama #${attempt} uygulanıyor` });
      response = await callAgentText({
        agent: `coder:heal-${attempt}`,
        model: config.models.coder,
        dnaId,
        system,
        messages: [
          ...baseMessages,
          { role: 'assistant', content: html || '(empty output)' },
          { role: 'user', content: healPrompt(report, attempt) },
        ],
        maxTokens: config.forge.coderMaxTokens,
        temperature: 0.2,
      });
      html = extractHtml(response.text);
      report = await validateArtifact(html, { truncated: response.finishReason === 'length' });
      healLog.push({ attempt, ok: report.ok, errors: report.errors, warnings: report.warnings, bytes: report.stats.bytes ?? 0, cost_usd: response.usage.cost_usd });
      emitDebateMessage({
        dnaId,
        role: 'forge',
        title: report.ok ? `Yama #${attempt} başarılı ✓ kod kendini onardı` : `Yama #${attempt}: hâlâ ${report.errors.length} hata`,
        content: summarizeReport(report),
        meta: { cost_usd: response.usage.cost_usd },
      });
    }
    emitAgentThinking({ dnaId, role: 'forge', active: false });

    if (!report.ok) {
      await store.updateDna(dnaId, (draft) => {
        draft.forge = { heal_attempts: attempt, heal_log: healLog, completed_at: new Date().toISOString(), duration_ms: Date.now() - startedAt };
      });
      const message = `${attempt} self-heal turundan sonra hâlâ ${report.errors.length} doğrulama hatası var.`;
      emitDebateMessage({ dnaId, role: 'forge', title: '✕ Forge başarısız — DNA mezarlığa gömülüyor', content: `${message}\n${report.errors.slice(0, 5).join('\n')}` });
      await failForge(dnaId, DNA_STATUS.FORGE_FAILED, 'FORGE_FAILED', message, { last_errors: report.errors.slice(0, 10) });
      return { ok: false };
    }

    const finalHtml = injectTelemetry(html, dnaId);
    const file = await writeArtifact(dnaId, finalHtml);
    const sha256 = createHash('sha256').update(finalHtml).digest('hex');
    const bytes = Buffer.byteLength(finalHtml, 'utf8');
    await store.setStatus(dnaId, DNA_STATUS.FORGED, attempt ? `Kod ${attempt} yama turunda kendini onardı` : 'Kod ilk derlemede doğrulandı', (draft) => {
      draft.forge = {
        heal_attempts: attempt,
        heal_log: healLog,
        artifact_path: path.relative(config.paths.root, file),
        bytes,
        sha256,
        validation: { warnings: report.warnings, stats: report.stats },
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
      };
    });
    emitDebateMessage({
      dnaId,
      role: 'forge',
      title: `Artefakt mühürlendi: artifacts/${dnaId.slice(0, 8)}…/index.html (${(bytes / 1024).toFixed(1)} KB)`,
      content: `Telemetri ajanı enjekte edildi · sha256 ${sha256.slice(0, 16)}… · süre ${Math.round((Date.now() - startedAt) / 1000)} sn`,
    });
    await enqueueStage('deploy', dnaId);
    log.info(`Forge tamamlandı: ${toolName} (${bytes} bayt, ${attempt} yama)`, { dna_id: dnaId });
    return { ok: true, healAttempts: attempt };
  } catch (err) {
    emitAgentThinking({ dnaId, role: 'forge', active: false });
    await store
      .updateDna(dnaId, (draft) => {
        draft.forge = { heal_attempts: attempt, heal_log: healLog, completed_at: new Date().toISOString(), duration_ms: Date.now() - startedAt };
      })
      .catch(() => {});
    if (err instanceof BudgetCircuitBreakerError) {
      emitDebateMessage({ dnaId, role: 'system', title: '⚡ Bütçe sigortası attı — Forge durduruldu', content: err.message });
      await failForge(dnaId, DNA_STATUS.BUDGET_EXCEEDED, 'BUDGET_EXCEEDED', err.message);
      log.warn(`Bütçe sigortası (forge): ${err.message}`, { dna_id: dnaId });
      return { ok: false, budgetExceeded: true };
    }
    if (isConfigError(err)) {
      await store.setStatus(dnaId, DNA_STATUS.APPROVED, 'Park edildi — yapılandırma hatası (coder)', (draft) => {
        draft.error = { stage: 'forge', agent: 'coder', message: err.message, parked: true, config: true };
      });
      emitDebateMessage({
        dnaId,
        role: 'forge',
        title: 'Yapılandırma hatası — onaylı DNA park edildi, Konsey kararı korunuyor',
        content: `${err.message}\n\nCODER_MODEL veya API anahtarını düzeltip sunucuyu yeniden başlatın; Forge bu DNA'yı kendiliğinden yeniden ele alır.`,
      });
      log.warn(`Yapılandırma hatası, DNA park edildi (forge): ${err.message}`, { dna_id: dnaId });
      return { ok: false, parked: true };
    }
    emitDebateMessage({ dnaId, role: 'forge', title: '✕ Forge hata ile durdu', content: err.message });
    await failForge(dnaId, DNA_STATUS.FORGE_FAILED, 'FORGE_FAILED', `Forge hatası: ${err.message}`);
    log.error(`Forge hatası: ${err.message}`, { dna_id: dnaId, stack: err.stack });
    return { ok: false, error: err.message };
  }
}
