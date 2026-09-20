/* ===========================================================================
 * geo-lang.js — гео/локальная маршрутизация для двуязычных статических сайтов.
 *
 * Схема сайтов: RU — в корне (/, /about...), EN — зеркало под /en/.
 * Правило по умолчанию: посетитель из России -> RU, все остальные -> EN.
 * Явный выбор языка (клик по переключателю) имеет приоритет и запоминается
 * навсегда (localStorage). Результат гео-определения кэшируется на сессию,
 * поэтому сетевой запрос выполняется не чаще одного раза за визит.
 *
 * Требования к странице (уже выполняются на всех сайтах):
 *   <html lang="ru|en"> и парные
 *   <link rel="alternate" hreflang="ru|en|x-default" href="...">
 *   Переключатель языка помечается атрибутом data-lang-switch.
 *
 * Грациозная деградация: при выключенном JS, таймауте или блокировке
 * гео-API поведение остаётся прежним (RU в корне, EN в /en/).
 * ===========================================================================*/
(function () {
  'use strict';

  var CFG = window.__GEOLANG__ || {};
  var TTL = (CFG.ttlHours || 6) * 3600e3;   // срок жизни кэша страны
  var TIMEOUT = CFG.timeoutMs || 2500;      // максимум ожидания гео-API
  var HOST = location.hostname.replace(/^www\./, '');
  var K_CHOICE = 'pgLang:' + HOST;          // явный выбор пользователя: 'ru' | 'en'
  var K_GEO = 'pgGeo:' + HOST;              // кэш страны: 'RU|1699999999999'
  var K_GEO_S = 'pgGeoS:' + HOST;           // страна на текущую вкладку/сессию
  var K_GUARD = 'pgGuard:' + HOST;          // защита от циклов редиректа

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }

  /* ---- определение текущего языка -------------------------------------- */
  var SEG = location.pathname.split('/').filter(Boolean);
  function pathIsEn() { return SEG[0] === 'en'; }   // EN всегда смонтирован в /en/

  /* RU живёт в корне домена, EN — под /en/. Атрибут <html lang> намеренно НЕ
     используем: на части страниц он проставлен неверно (напр. lang=en-us на
     RU-страницах project-ai.site) и дал бы петлю редиректа. */
  function currentLang() {
    return pathIsEn() ? 'en' : 'ru';
  }

  /* ---- ссылки: берём парную страницу из hreflang (авторитетно) ---------- */
  function altHref(lang) {
    var l = document.querySelector('link[rel="alternate"][hreflang="' + lang + '"]');
    var h = l && l.getAttribute('href');
    return h || null;
  }

  /* Цель редиректа приводим к корне-абсолютному пути документа.
     Важно: на части сайтов стоит <base href>, и относительные ссылки
     разрешаются от него, а не от текущего URL, — абсолютный путь от base
     не зависит. Домены здесь обслуживаются из корня (кастомные домены). */
  function absPath(href) {
    var u;
    try { u = new URL(href, location.href); } catch (e) { return href; }
    if (u.origin !== location.origin) return u.href;    // чужой домен — целиком
    return u.pathname + (u.search || '') + (u.hash || '');
  }

  /* Запасной расчёт «дома» языка, если на странице нет hreflang. */
  function belowLang() {
    var s = SEG.slice();
    if (pathIsEn()) s.shift();
    if (s.length && s[s.length - 1].indexOf('.') !== -1) s.pop();
    return s.length;
  }
  function up(n) { return new Array(n + 1).join('../'); }
  function homeHref(lang) {
    var n = belowLang();
    if (lang === 'en') return pathIsEn() ? (up(n) || './') : up(n) + 'en/';
    return pathIsEn() ? up(n + 1) : (up(n) || './');
  }

  /* Куда вести посетителя, которому нужен язык `lang`. */
  function targetFor(lang) {
    var alt = altHref(lang);
    if (alt) {
      if (lang === currentLang()) return null;         // уже на нужном языке
      return absPath(alt);
    }
    if (lang === currentLang()) return null;
    return absPath(homeHref(lang));
  }

  /* ---- сигналы ---------------------------------------------------------- */
  function choice() {
    var c = lsGet(K_CHOICE);
    return c === 'ru' || c === 'en' ? c : null;
  }

  function cachedCountry(ttl) {
    var cc = ssGet(K_GEO_S);
    if (cc) return cc;                                  // на эту сессию — без сети
    var raw = lsGet(K_GEO);
    if (!raw) return null;
    var p = raw.split('|');
    if (ttl && Date.now() - (parseInt(p[1], 10) || 0) > ttl) return null;
    return p[0] || null;
  }
  function storeCountry(cc) {
    ssSet(K_GEO_S, cc);
    lsSet(K_GEO, cc + '|' + Date.now());
  }

  function browserIsRussian() {
    var langs = navigator.languages && navigator.languages.length
      ? navigator.languages : [navigator.language || ''];
    for (var i = 0; i < langs.length; i++) {
      var l = String(langs[i]).toLowerCase();
      if (!l) continue;
      if (l.indexOf('ru') === 0) return true;           // ru, ru-RU, ru-BY, ru-KZ…
      if (l === 'en' || l.indexOf('en-') === 0) return false;
    }
    return null;                                        // непонятно
  }

  function countryCodeFromText(txt) {
    var m = txt.match(/\bloc=([A-Za-z]{2})\b/) ||
            txt.match(/"country_?code"\s*:\s*"([A-Za-z]{2})"/) ||
            txt.match(/"country"\s*:\s*"([A-Za-z]{2})"/);
    return m ? m[1].toUpperCase() : null;
  }

  /* Гео-API в порядке предпочтения: отдающие CORS: * и работающие из РФ. */
  function fetchCountry(cb) {
    var apis = [
      ['https://www.cloudflare.com/cdn-cgi/trace', 'text'],
      ['https://api.country.is/', 'json'],
      ['https://ipwho.is/', 'json']
    ];
    var done = false;
    var t0 = Date.now();
    function finish(cc) {
      if (done) return;
      done = true;
      cb(cc || null);
    }
    setTimeout(function () { finish(null); }, TIMEOUT);  // жёсткий таймаут

    function tryApi(i) {
      if (done) return;
      if (i >= apis.length) return finish(null);
      var ctrl = ('AbortController' in window) ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, Math.max(800, TIMEOUT - (Date.now() - t0))) : null;
      fetch(apis[i][0], { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) { return r.ok ? r.text() : null; })
        .then(function (t) {
          if (timer) clearTimeout(timer);
          var cc = t && countryCodeFromText(t);
          if (cc) return finish(cc);
          tryApi(i + 1);
        })
        .catch(function () { if (timer) clearTimeout(timer); tryApi(i + 1); });
    }
    tryApi(0);
  }

  /* ---- переключение языка ---------------------------------------------- */
  function go(lang) {
    var t = targetFor(lang);
    if (!t) return false;
    var seen = parseInt(ssGet(K_GUARD) || '0', 10);
    if (seen >= 2) return false;                        // страховка от циклов
    ssSet(K_GUARD, String(seen + 1));
    location.replace(new URL(t, location.href).toString());
    return true;
  }

  function apply() {
    var ch = choice();                                  // 1) выбор пользователя
    if (ch) { if (go(ch)) return; return; }

    var cc = cachedCountry(TTL);                        // 2) кэш страны
    if (cc) { if (cc === 'RU') go('ru'); else go('en'); return; }

    fetchCountry(function (code) {                      // 3) гео-запрос
      if (code) {
        storeCountry(code);
        if (go(code === 'RU' ? 'ru' : 'en')) return;
        return;
      }
      if (browserIsRussian() === true) go('ru');         // 4) фоллбэк: язык браузера
    });
  }

  /* Переключатель: href — на парную страницу другого языка (если помечен). */
  function fixSwitch() {
    var nodes = document.querySelectorAll('[data-lang-switch]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var mode = el.getAttribute('data-lang-switch');
      var other = currentLang() === 'en' ? 'ru' : 'en';
      var t = targetFor(other);
      var cur = el.getAttribute('href') || '';
      if (!cur || cur === '#' || mode === 'force') {
        if (t) el.setAttribute('href', t);
      }
    }
  }

  /* Запоминаем явный выбор языка при клике по переключателю. */
  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t.nodeType === 1) {
      var set = t.getAttribute && t.getAttribute('data-lang-set');
      if (set === 'ru' || set === 'en') { lsSet(K_CHOICE, set); ssSet(K_GUARD, '0'); return; }
      if (t.getAttribute && t.getAttribute('data-lang-switch') !== null) {
        var other = currentLang() === 'en' ? 'ru' : 'en';
        lsSet(K_CHOICE, other); ssSet(K_GUARD, '0');
        return;
      }
      t = t.parentNode && t.parentNode.nodeType === 1 ? t.parentNode : null;
    }
  }, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { fixSwitch(); apply(); });
  } else {
    fixSwitch(); apply();
  }
})();
