/* OfficeSell — one script for both pages.
   index.html  → read-only view, refreshes itself from GitHub.
   admin.html  → same view plus editing; saves data.json back to GitHub. */
(function () {
  'use strict';
  var MODE = document.body.getAttribute('data-mode') === 'admin' ? 'admin' : 'view';
  var REPO = 'JoniCoderx/officesell', FILE = 'data.json', BRANCH = 'gh-pages';
  var API = 'https://api.github.com/repos/' + REPO + '/contents/' + FILE;
  var TOKEN_KEY = 'officesell-token';
  var CATS = ['מחשוב', 'טלוויזיות ומדיה', 'ריהוט', 'מטבח', 'חדר כושר'];
  var POLL_MS = 120000;

  var state = null, sha = null, token = null;
  var dirty = false, saving = false, saveTimer = null, apiBlocked = false, loadErr = null;
  var ui = { filter: 'all', q: '', logAll: false, scenario: null, flash: null, sheet: null };
  var app = document.getElementById('app');

  /* ---------- helpers ---------- */
  var ILS = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
  function money(n) { return ILS.format(Math.round(n || 0)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(v) { if (v === null || v === undefined) return null; v = String(v).replace(/[₪,\s]/g, ''); return (v === '' || isNaN(v)) ? null : Number(v); }
  function r2(n) { return Math.round(n * 100) / 100; }
  function sgn(d) { return '<bdi dir="ltr">' + (d > 0 ? '+' : '−') + Math.abs(d) + '%</bdi>'; }
  function $(id) { return document.getElementById(id); }
  function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function dmy(s) { if (!s) return ''; var p = String(s).split('-'); return p.length === 3 ? (+p[2]) + '/' + (+p[1]) : s; }
  function when(s) {
    if (!s) return '';
    var d = new Date(s); if (isNaN(d)) return String(s);
    var t = d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    var td = new Date(); var y = new Date(); y.setDate(td.getDate() - 1);
    if (d.toDateString() === td.toDateString()) return 'היום ' + t;
    if (d.toDateString() === y.toDateString()) return 'אתמול ' + t;
    return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' }) + ' ' + t;
  }
  function b64dec(s) { var bin = atob(s.replace(/\s/g, '')); var u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new TextDecoder().decode(u); }
  function b64enc(str) { var u = new TextEncoder().encode(str), s = ''; for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); }
  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  /* ---------- math ---------- */
  function item(id) { return state.items.find(function (i) { return i.id === id; }); }
  function sale(id) { return state.sales.find(function (x) { return x.id === id; }); }
  function cats() { return CATS.concat(state.items.map(function (i) { return i.cat; }).filter(function (c, i, a) { return c && CATS.indexOf(c) < 0 && a.indexOf(c) === i; })); }
  function pct() { var p = ui.scenario != null ? ui.scenario : num(state.scenario); return p == null ? 100 : Math.max(0, Math.min(150, p)); }
  function calc(it) {
    var q = num(it.qty), p = num(it.price), s = 0, rev = 0;
    state.sales.forEach(function (x) { if (x.item === it.id) { var qq = num(x.qty) || 0; s += qq; rev += qq * (num(x.price) || 0); } });
    var left = q === null ? null : q - s, missing = q === null || p === null;
    var leftVal = (missing || left <= 0) ? 0 : left * p;
    var status = missing ? 'miss' : (s <= 0 ? 'none' : (left <= 0 ? 'all' : 'part'));
    return { q: q, p: p, s: s, left: left, rev: rev, leftVal: leftVal, missing: missing, status: status, over: q !== null && s > q, avg: s ? rev / s : null };
  }
  function totals(items) {
    var t = { rev: 0, leftVal: 0, units: 0, sold: 0, left: 0, miss: 0, none: 0, part: 0, all: 0 };
    items.forEach(function (it) { var c = calc(it); t.rev += c.rev; t.leftVal += c.leftVal; t.units += c.q || 0; t.sold += c.s; t.left += Math.max(c.left || 0, 0); t[c.status]++; });
    t.full = t.rev + t.leftVal; t.exp = t.rev + t.leftVal * pct() / 100; return t;
  }
  var PILL = { miss: ['p-miss', 'חסר מחיר/מלאי'], none: ['p-none', 'לא נמכר'], part: ['p-part', 'נמכר חלקית'], all: ['p-all', 'נמכר הכל'] };
  var FILTERS = [['all', 'הכל'], ['none', 'לא נמכר'], ['part', 'נמכר חלקית'], ['done', 'נמכר הכל'], ['miss', 'חסר נתונים']];
  function filterCount(f, T) { return f === 'all' ? state.items.length : f === 'done' ? T.all : T[f]; }
  function passes(it) {
    var st = calc(it).status;
    if (ui.filter !== 'all' && (ui.filter === 'done' ? st !== 'all' : st !== ui.filter)) return false;
    if (ui.q && it.name.toLowerCase().indexOf(ui.q.toLowerCase()) < 0 && (it.cat || '').indexOf(ui.q) < 0) return false;
    return true;
  }

  /* ---------- data in / out ---------- */
  function load() {
    if (MODE === 'admin' && token) {
      return fetch(API + '?ref=' + BRANCH + '&t=' + Date.now(), { cache: 'no-store', headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' } })
        .then(function (r) {
          if (r.status === 401 || r.status === 403 || r.status === 404) { var e = new Error('auth'); e.code = 'auth'; e.status = r.status; throw e; }
          if (!r.ok) throw new Error('http ' + r.status);
          return r.json();
        }).then(function (j) { sha = j.sha; return JSON.parse(b64dec(j.content)); });
    }
    var viaPages = function () { return fetch(FILE + '?v=' + Date.now(), { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('pages ' + r.status); return r.json(); }); };
    if (apiBlocked) return viaPages();
    return fetch(API + '?ref=' + BRANCH + '&t=' + Math.floor(Date.now() / 30000), { cache: 'no-store', headers: { Accept: 'application/vnd.github.raw+json' } })
      .then(function (r) { if (r.status === 403 || r.status === 429) apiBlocked = true; if (!r.ok) throw new Error('api ' + r.status); return r.json(); })
      .catch(viaPages);
  }
  function normalize(d) {
    d.items = d.items || []; d.sales = d.sales || [];
    if (d.scenario == null) d.scenario = 100;
    return d;
  }

  function scheduleSave(ms) { if (MODE !== 'admin') return; dirty = true; setLive(); clearTimeout(saveTimer); saveTimer = setTimeout(save, ms == null ? 700 : ms); }
  function save(retried) {
    clearTimeout(saveTimer);
    if (!dirty || !token) return;
    if (saving) { saveTimer = setTimeout(save, 800); return; }
    saving = true; dirty = false; setLive();
    state.updated = new Date().toISOString();
    var body = { message: 'עדכון מלאי ומכירות', branch: BRANCH, content: b64enc(JSON.stringify(state, null, 1) + '\n'), sha: sha };
    fetch(API, { method: 'PUT', headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        if (r.status === 409 || r.status === 422) {
          // Our copy of the file is stale: fetch the current version id and write ours on top.
          return fetch(API + '?ref=' + BRANCH + '&t=' + Date.now(), { cache: 'no-store', headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' } })
            .then(function (x) { return x.json(); }).then(function (j) { sha = j.sha; var e = new Error('stale'); e.code = 'stale'; throw e; });
        }
        if (r.status === 401 || r.status === 403) { var e = new Error('auth'); e.code = 'auth'; throw e; }
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (j) { sha = j.content.sha; saving = false; setLive(); })
      .catch(function (e) {
        saving = false; dirty = true;
        if (e.code === 'stale' && !retried) { save(true); return; }
        if (e.code === 'auth') { setLive('הטוקן לא תקף. התחבר מחדש'); toast('הטוקן לא מאפשר שמירה. בדוק הרשאת Contents: Read and write', 'התחבר', logout); return; }
        setLive('לא נשמר');
        toast('השמירה נכשלה. בדוק חיבור לאינטרנט', 'נסה שוב', function () { save(); });
      });
  }

  /* ---------- status ---------- */
  function setLive(errText) {
    var el = $('live'); if (!el) return;
    var dot = 'dot', txt;
    if (errText) { dot += ' err'; txt = errText; }
    else if (MODE === 'admin' && (saving || dirty)) { dot += ' busy'; txt = 'שומר…'; }
    else txt = 'עודכן ' + when(state && state.updated);
    el.innerHTML = '<span class="' + dot + '"></span><span>' + esc(txt) + '</span>';
  }

  /* ---------- view ---------- */
  function heroHTML(T) {
    var p = T.exp > 0 ? Math.round(T.rev / T.exp * 100) : 0;
    return '<div class="hero"><span class="k">נמכר עד כה</span><span class="v num">' + money(T.rev) + '</span>' +
      '<div class="bar" role="img" aria-label="' + p + '% מהצפוי"><i style="width:' + Math.min(p, 100) + '%"></i></div>' +
      '<div class="meta num"><span><b>' + p + '%</b> מהצפוי</span><span><b>' + state.sales.length + '</b> עסקאות</span><span><b>' + T.sold + '</b> יחידות</span></div></div>';
  }
  function tilesHTML(T) {
    return '<div class="tiles"><div class="tile"><span class="k">עוד במלאי</span><span class="v num">' + money(T.leftVal) + '</span><span class="s num">' + T.left + ' יחידות לפי מחיר דרישה</span></div>' +
      '<div class="tile"><span class="k">צפוי בסוף</span><span class="v num" id="exp">' + money(T.exp) + '</span><span class="s" id="exp-s">' + (pct() === 100 ? 'אם הכל יימכר במחיר הדרישה' : 'אם השאר יימכר ב-' + pct() + '%') + '</span></div></div>';
  }
  function scnHTML(T) {
    return '<section class="scn"><div class="scn-head"><label for="scn">מחשבון: השאר יימכר ב-</label><span class="pct num" id="scn-p">' + pct() + '%</span></div>' +
      '<input type="range" id="scn" min="30" max="120" step="5" value="' + pct() + '" aria-label="אחוז ממחיר הדרישה">' +
      '<div class="out num" id="scn-o">' + scnOut(T) + '</div></section>';
  }
  function scnOut(T) { return '<span>שווי השאר <b>' + money(T.leftVal * pct() / 100) + '</b></span><span>סה״כ בסוף <b>' + money(T.exp) + '</b></span>'; }
  function catsHTML() {
    var h = '<section class="sec"><div class="sec-h"><h2>לפי קטגוריה</h2></div>';
    cats().forEach(function (c) {
      var its = state.items.filter(function (i) { return i.cat === c; }); if (!its.length) return;
      var t = totals(its), p = t.full > 0 ? Math.round(t.rev / t.full * 100) : 0;
      h += '<div class="cat-row"><span class="n">' + esc(c) + '</span><span class="t num">' + money(t.rev) + '</span>' +
        '<div class="mini"><i style="width:' + p + '%"></i></div>' +
        '<div class="m num"><span>' + t.sold + ' נמכרו · ' + t.left + ' נשארו</span><span>' + money(t.leftVal) + ' במלאי</span></div></div>';
    });
    return h + '</section>';
  }
  function soldHTML(T) {
    var rows = state.items.map(function (it) { return { it: it, k: calc(it) }; }).filter(function (r) { return r.k.s > 0; }).sort(function (a, b) { return b.k.rev - a.k.rev; });
    var h = '<section class="sec"><div class="sec-h"><h2>מה נמכר עד כה</h2><span class="note">ממוצע מול מחיר דרישה</span></div>';
    if (!rows.length) return h + '<div class="empty">עוד לא נמכר כלום.</div></section>';
    rows.forEach(function (r) {
      var k = r.k, d = (k.p && k.avg !== null) ? Math.round((k.avg / k.p - 1) * 100) : null;
      var cmp = d === null ? '' : d === 0 ? ' · כמו הדרישה' : ' · <span class="' + (d > 0 ? 'up' : 'down') + '">' + sgn(d) + '</span>';
      h += '<div class="row"><span class="n">' + esc(r.it.name) + '</span><span class="s num">' + k.s + ' יח׳ · ממוצע ' + money(k.avg) + cmp + '</span><span class="v num">' + money(k.rev) + '</span></div>';
    });
    h += '<div class="row total"><span class="n">סה״כ</span><span class="s num">' + T.sold + ' יחידות</span><span class="v num">' + money(T.rev) + '</span></div>';
    return h + '</section>';
  }
  function invHTML(T) {
    var h = '<section class="sec" id="inv"><div class="sec-h"><h2>מלאי</h2><span class="note num">' + state.items.length + ' פריטים</span></div>';
    h += '<div class="tools"><input class="search" id="q" type="search" placeholder="חיפוש פריט…" value="' + esc(ui.q) + '" aria-label="חיפוש פריט" autocomplete="off"><div class="chips">';
    FILTERS.forEach(function (f) { h += '<button class="chip" data-filter="' + f[0] + '" aria-pressed="' + (ui.filter === f[0]) + '">' + f[1] + ' <span class="num">' + filterCount(f[0], T) + '</span></button>'; });
    h += '</div></div><div id="inv-list">' + invList() + '</div></section>';
    return h;
  }
  function invList() {
    var h = '', shown = 0;
    cats().forEach(function (c) {
      var all = state.items.filter(function (i) { return i.cat === c; });
      var its = all.filter(passes);
      if (!its.length && (ui.filter !== 'all' || ui.q || MODE !== 'admin')) return;
      var t = totals(all);
      h += '<div class="grp"><span style="font:inherit;color:inherit">' + esc(c) + '</span><span class="num">' + money(t.rev) + ' נמכר · ' + money(t.leftVal) + ' נשאר</span></div><div class="cards">';
      its.forEach(function (it) { shown++; h += cardHTML(it); });
      h += '</div>';
      if (MODE === 'admin' && ui.filter === 'all' && !ui.q) h += '<button class="addbtn" data-add="' + esc(c) + '">+ פריט ל' + esc(c) + '</button>';
    });
    if (!shown && (ui.filter !== 'all' || ui.q)) h += '<div class="empty">אין פריטים שמתאימים לחיפוש.</div>';
    return h;
  }
  function cardHTML(it) {
    var k = calc(it), pl = PILL[k.status], p = k.q ? Math.min(100, Math.round(k.s / k.q * 100)) : 0, id = esc(it.id);
    var h = '<div class="card' + (ui.flash === it.id ? ' flashrow' : '') + '" id="card-' + id + '">';
    h += '<div class="card-h"><div class="n">' + esc(it.name) + (it.note ? '<div class="nt">' + esc(it.note) + '</div>' : '') + '</div><span class="pill ' + pl[0] + '">' + pl[1] + '</span></div>';
    h += '<div class="prog"><div class="t num"><span>נמכרו <b>' + k.s + '</b>' + (k.q !== null ? ' מתוך ' + k.q : '') + '</span><span>' + (k.left === null ? 'מלאי לא ידוע' : 'נשארו <b>' + Math.max(k.left, 0) + '</b>') + '</span></div>' +
      '<div class="mini"><i style="width:' + p + '%"></i></div>' + (k.over ? '<span class="err">נמכרו יותר מהמלאי שרשום</span>' : '') + '</div>';
    h += '<div class="facts"><div class="fact"><span class="k">מחיר דרישה</span><span class="v num' + (k.p === null ? ' miss' : '') + '">' + (k.p === null ? 'חסר' : money(k.p)) + '</span></div>' +
      '<div class="fact"><span class="k">התקבל</span><span class="v num">' + (k.rev ? money(k.rev) : '—') + '</span></div>' +
      '<div class="fact"><span class="k">שווי שנותר</span><span class="v num">' + (k.missing ? '—' : money(k.leftVal)) + '</span></div></div>';
    if (MODE === 'admin') h += '<div class="acts"><button class="b-sell" data-sell="' + id + '">מכירה</button><button class="b-edit" data-edit="' + id + '">עריכה</button></div>';
    return h + '</div>';
  }
  function logHTML() {
    var h = '<section class="sec" id="log"><div class="sec-h"><h2>יומן מכירות</h2><span class="note num">' + state.sales.length + ' עסקאות</span></div>';
    if (!state.sales.length) return h + '<div class="empty">עדיין לא נרשמו מכירות.</div></section>';
    var list = state.sales.slice().reverse(), lim = ui.logAll ? list.length : 8;
    list.slice(0, lim).forEach(function (x, i) {
      var it = item(x.item), q = num(x.qty) || 0, pr = num(x.price) || 0, n = state.sales.length - i;
      var tag = MODE === 'admin' ? 'button' : 'div';
      h += '<' + tag + ' class="row' + (ui.flash === x.id ? ' flashrow' : '') + '"' + (MODE === 'admin' ? ' data-esale="' + esc(x.id) + '" aria-label="ערוך מכירה ' + n + '"' : '') + '>' +
        '<span class="n">' + esc(it ? it.name : 'פריט שנמחק') + '</span>' +
        '<span class="s num">#' + n + ' · ' + q + ' × ' + money(pr) + (x.date ? ' · ' + dmy(x.date) : '') + '</span>' +
        '<span class="v num">' + money(q * pr) + '</span></' + tag + '>';
    });
    if (list.length > lim) h += '<button class="more" data-logall>הצג את כל ' + list.length + ' העסקאות</button>';
    return h + '</section>';
  }

  function render() {
    if (!state) return;
    var T = totals(state.items);
    var h = '<div class="wrap">';
    h += '<header class="top"><div class="brand"><h1>Office<em>Sell</em></h1><span class="sub">מכירת ציוד המשרד' + (MODE === 'admin' ? ' · ניהול' : '') + '</span></div>' +
      '<div style="display:flex;align-items:center;gap:10px"><span class="live" id="live"></span>' +
      (MODE === 'admin' ? '<button class="iconbtn" id="menu" aria-label="אפשרויות">⋯</button>' : '') + '</div></header>';
    h += '<div class="summary">' + heroHTML(T) + tilesHTML(T) + '</div>';
    h += scnHTML(T) + catsHTML() + soldHTML(T) + invHTML(T) + logHTML();
    h += '<p class="foot">' + (MODE === 'admin' ? 'כל שינוי נשמר אוטומטית ומופיע אצל המנהלים תוך כדקה.' : 'הנתונים מתעדכנים אוטומטית.') + '</p></div>';
    if (MODE === 'admin') h += '<div class="dock"><div class="dock-in"><button class="cta" data-sell="">+ רישום מכירה</button></div></div>';
    var y = window.scrollY, foc = document.activeElement && document.activeElement.id, selS = foc === 'q' ? $('q').selectionStart : null;
    app.innerHTML = h;
    setLive();
    window.scrollTo(0, y);
    if (foc === 'q') { var q = $('q'); q.focus(); try { q.setSelectionRange(selS, selS); } catch (e) {} }
    ui.flash = null;
  }
  function renderInv() { var l = $('inv-list'); if (l) l.innerHTML = invList(); }

  /* ---------- sheets (admin) ---------- */
  function openSheet(html, onMount) {
    closeSheet();
    var s = document.createElement('div'); s.className = 'scrim'; s.id = 'scrim';
    s.innerHTML = '<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>' + html + '</div>';
    document.body.appendChild(s); document.body.style.overflow = 'hidden';
    s.addEventListener('click', function (e) { if (e.target === s || e.target.closest('[data-close]')) closeSheet(); });
    if (onMount) onMount(s);
  }
  function closeSheet() { var s = $('scrim'); if (s) s.remove(); document.body.style.overflow = ''; ui.sheet = null; }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  function itemOptions(sel, withStock) {
    var o = '<option value="">בחרו פריט…</option>';
    cats().forEach(function (c) {
      var its = state.items.filter(function (i) { return i.cat === c; }); if (!its.length) return;
      o += '<optgroup label="' + esc(c) + '">';
      its.forEach(function (it) { var k = calc(it); o += '<option value="' + esc(it.id) + '"' + (sel === it.id ? ' selected' : '') + '>' + esc(it.name) + (withStock && k.left !== null ? ' (' + Math.max(k.left, 0) + ' במלאי)' : '') + '</option>'; });
      o += '</optgroup>';
    });
    return o;
  }

  function saleSheet(saleId, itemId) {
    var x = saleId ? sale(saleId) : null;
    var f = { item: x ? x.item : (itemId || ''), qty: x ? x.qty : 1, total: x ? r2((num(x.qty) || 0) * (num(x.price) || 0)) : '', date: x ? x.date : today(), touched: !!x };
    openSheet('<h3>' + (x ? 'עריכת מכירה' : 'רישום מכירה') + '</h3><form class="form" id="sf" novalidate>' +
      '<div class="f"><label for="s-item">פריט</label><select id="s-item">' + itemOptions(f.item, true) + '</select><span class="hint" id="s-hint"></span></div>' +
      '<div class="two"><div class="f"><span class="l">כמות</span><div class="step"><button type="button" data-st="1" aria-label="הוסף">+</button><input id="s-qty" inputmode="numeric" value="' + esc(f.qty) + '" aria-label="כמות"><button type="button" data-st="-1" aria-label="הפחת">−</button></div></div>' +
      '<div class="f"><label for="s-total">סכום שהתקבל ₪</label><input id="s-total" inputmode="decimal" placeholder="סה״כ" value="' + esc(f.total) + '"></div></div>' +
      '<div class="f"><label for="s-date">תאריך</label><input id="s-date" type="date" value="' + esc(f.date) + '"></div>' +
      '<div class="calc" id="s-calc"></div><div class="err" id="s-err"></div>' +
      '<div class="sheet-acts">' + (x ? '<button type="button" class="danger" id="s-del">מחק</button>' : '') + '<button type="submit" class="cta">' + (x ? 'שמור' : 'רשום מכירה') + '</button></div></form>',
      function (s) {
        var I = $('s-item'), Q = $('s-qty'), TT = $('s-total'), D = $('s-date');
        function upd() {
          var it = item(I.value), q = num(Q.value) || 0;
          if (it) { var k = calc(it); $('s-hint').innerHTML = (k.left !== null ? 'במלאי: <b>' + Math.max(k.left + (x && x.item === it.id ? num(x.qty) || 0 : 0), 0) + '</b>' : 'מלאי לא ידוע') + (k.p !== null ? ' · דרישה ' + money(k.p) + ' ליח׳' : ''); }
          else $('s-hint').textContent = '';
          if (it && !f.touched && it.price != null) TT.value = q * it.price;
          var tot = num(TT.value), unit = (tot !== null && q > 0) ? tot / q : null, d = (it && it.price && unit !== null) ? Math.round((unit / it.price - 1) * 100) : null;
          $('s-calc').innerHTML = '<div><span>מחיר ליחידה</span><b class="num">' + (unit === null ? '—' : money(unit)) + '</b></div>' +
            (d !== null && d !== 0 ? '<div><span>מול מחיר הדרישה</span><b class="num ' + (d > 0 ? 'up' : 'down') + '">' + sgn(d) + '</b></div>' : '');
        }
        I.addEventListener('change', function () { f.touched = !!x; upd(); });
        Q.addEventListener('input', upd);
        TT.addEventListener('input', function () { f.touched = TT.value !== ''; upd(); });
        s.querySelectorAll('[data-st]').forEach(function (b) { b.addEventListener('click', function () { Q.value = Math.max(1, (num(Q.value) || 0) + Number(b.getAttribute('data-st'))); upd(); }); });
        var del = $('s-del');
        if (del) del.addEventListener('click', function () {
          if (!del.classList.contains('arm')) { del.classList.add('arm'); del.textContent = 'בטוח?'; return; }
          var idx = state.sales.indexOf(x); state.sales.splice(idx, 1); closeSheet(); render(); scheduleSave(0);
          toast('המכירה נמחקה', 'בטל', function () { state.sales.splice(idx, 0, x); render(); scheduleSave(0); });
        });
        $('sf').addEventListener('submit', function (e) {
          e.preventDefault();
          var q = num(Q.value), tot = num(TT.value), err = $('s-err');
          if (!I.value) { err.textContent = 'בחרו פריט'; return; }
          if (!q || q <= 0) { err.textContent = 'הזינו כמות'; return; }
          if (tot === null || tot < 0) { err.textContent = 'הזינו את הסכום שהתקבל'; return; }
          var rec = { id: x ? x.id : uid('s'), item: I.value, qty: q, price: r2(tot / q), date: D.value || '' };
          if (x) Object.assign(x, rec); else state.sales.push(rec);
          ui.flash = rec.id; closeSheet(); render(); scheduleSave(0);
          if (!x) toast('נרשמה מכירה: ' + money(tot), 'בטל', function () { state.sales = state.sales.filter(function (y) { return y.id !== rec.id; }); render(); scheduleSave(0); });
        });
        upd();
        if (!f.item) I.focus(); else if (!x) { TT.focus(); TT.select(); }
      });
  }

  function itemSheet(itemId, cat) {
    var it = itemId ? item(itemId) : null;
    var nSales = it ? state.sales.filter(function (x) { return x.item === it.id; }).length : 0;
    var catOpts = cats().map(function (c) { return '<option' + (((it && it.cat) || cat) === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '<option value="__new">+ קטגוריה חדשה…</option>';
    openSheet('<h3>' + (it ? 'עריכת פריט' : 'פריט חדש') + '</h3><form class="form" id="if" novalidate>' +
      '<div class="f"><label for="i-name">שם הפריט</label><input id="i-name" value="' + esc(it ? it.name : '') + '" placeholder="למשל: מסך 24 אינץ׳ דל" autocomplete="off"></div>' +
      '<div class="two"><div class="f"><label for="i-qty">מלאי ראשוני</label><input id="i-qty" inputmode="numeric" value="' + esc(it && it.qty != null ? it.qty : '') + '" placeholder="כמה היו"></div>' +
      '<div class="f"><label for="i-price">מחיר דרישה ₪</label><input id="i-price" inputmode="decimal" value="' + esc(it && it.price != null ? it.price : '') + '" placeholder="ליחידה"></div></div>' +
      '<div class="f"><label for="i-cat">קטגוריה</label><select id="i-cat">' + catOpts + '</select><input id="i-newcat" placeholder="שם הקטגוריה" hidden></div>' +
      '<div class="f"><label for="i-note">הערה</label><input id="i-note" value="' + esc(it ? it.note : '') + '" placeholder="לא חובה"></div>' +
      (it ? '<div class="hint">' + (nSales ? 'נרשמו ' + nSales + ' מכירות לפריט הזה. "נמכרו" מחושב מהן.' : 'עוד לא נרשמו מכירות לפריט הזה.') + '</div>' : '') +
      '<div class="err" id="i-err"></div><div class="sheet-acts">' + (it ? '<button type="button" class="danger" id="i-del">מחק</button>' : '') + '<button type="submit" class="cta">' + (it ? 'שמור' : 'הוסף פריט') + '</button></div></form>',
      function () {
        var C = $('i-cat'), NC = $('i-newcat');
        C.addEventListener('change', function () { NC.hidden = C.value !== '__new'; if (!NC.hidden) NC.focus(); });
        var del = $('i-del');
        if (del) del.addEventListener('click', function () {
          if (!del.classList.contains('arm')) { del.classList.add('arm'); del.textContent = nSales ? 'למחוק גם ' + nSales + ' מכירות?' : 'בטוח?'; return; }
          var snapI = state.items.slice(), snapS = state.sales.slice();
          state.items = state.items.filter(function (i) { return i.id !== it.id; });
          state.sales = state.sales.filter(function (x) { return x.item !== it.id; });
          closeSheet(); render(); scheduleSave(0);
          toast('הפריט נמחק', 'בטל', function () { state.items = snapI; state.sales = snapS; render(); scheduleSave(0); });
        });
        $('if').addEventListener('submit', function (e) {
          e.preventDefault();
          var name = $('i-name').value.trim(), qv = $('i-qty').value.trim(), pv = $('i-price').value.trim(), c = C.value === '__new' ? NC.value.trim() : C.value, err = $('i-err');
          if (!name) { err.textContent = 'הזינו שם פריט'; return; }
          if (qv && num(qv) === null) { err.textContent = 'המלאי צריך להיות מספר'; return; }
          if (pv && num(pv) === null) { err.textContent = 'המחיר צריך להיות מספר'; return; }
          if (!c) { err.textContent = 'בחרו קטגוריה'; return; }
          var rec = { name: name, qty: qv ? num(qv) : null, price: pv ? num(pv) : null, cat: c, note: $('i-note').value.trim() };
          if (it) Object.assign(it, rec); else { rec.id = uid('i'); state.items.push(rec); }
          var newId = it ? it.id : rec.id;
          ui.flash = newId; ui.filter = 'all'; ui.q = ''; closeSheet(); render(); scheduleSave(0);
          if (!it) { var cc = $('card-' + newId); if (cc) cc.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        });
        if (!it) $('i-name').focus();
      });
  }

  function menuSheet() {
    openSheet('<h3>אפשרויות</h3><div class="form">' +
      '<button class="cta2" type="button" id="m-add">+ הוספת פריט חדש</button>' +
      '<a class="cta2" style="text-align:center;text-decoration:none;color:inherit" href="./" target="_blank" rel="noopener">פתח את הדף של המנהלים</a>' +
      '<button class="cta2" type="button" id="m-copy">העתק קישור למנהלים</button>' +
      '<button class="cta2" type="button" id="m-reload">טען מחדש מהשרת</button>' +
      '<button class="danger" type="button" id="m-out">התנתק מהמכשיר הזה</button></div>', function () {
        $('m-add').onclick = function () { itemSheet(null, cats()[0]); };
        $('m-copy').onclick = function () {
          var u = location.href.replace(/admin\.html.*$/, '');
          (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(function () { closeSheet(); toast('הקישור הועתק'); }, function () { closeSheet(); toast(u); });
        };
        $('m-reload').onclick = function () { closeSheet(); boot(); };
        $('m-out').onclick = function () { closeSheet(); logout(); };
      });
  }

  /* ---------- toast ---------- */
  var toastTimer;
  function toast(text, actLabel, act) {
    var old = $('toast'); if (old) old.remove(); clearTimeout(toastTimer);
    var t = document.createElement('div'); t.className = 'toast'; t.id = 'toast'; t.setAttribute('role', 'status');
    t.innerHTML = '<span>' + esc(text) + '</span>' + (actLabel ? '<button type="button">' + esc(actLabel) + '</button>' : '');
    if (actLabel) t.querySelector('button').onclick = function () { t.remove(); act(); };
    document.body.appendChild(t);
    toastTimer = setTimeout(function () { t.remove(); }, actLabel ? 7000 : 3000);
  }

  /* ---------- events ---------- */
  app.addEventListener('input', function (e) {
    var el = e.target;
    if (el.id === 'q') { ui.q = el.value.trim(); renderInv(); return; }
    if (el.id === 'scn') {
      ui.scenario = num(el.value); var T = totals(state.items);
      $('scn-p').textContent = pct() + '%'; $('scn-o').innerHTML = scnOut(T); $('exp').textContent = money(T.exp);
      $('exp-s').textContent = pct() === 100 ? 'אם הכל יימכר במחיר הדרישה' : 'אם השאר יימכר ב-' + pct() + '%';
      var hb = document.querySelector('.hero'); if (hb) hb.outerHTML = heroHTML(T);
    }
  });
  app.addEventListener('change', function (e) { if (e.target.id === 'scn' && MODE === 'admin') { state.scenario = ui.scenario; scheduleSave(1500); } });
  app.addEventListener('click', function (e) {
    var t = e.target, b;
    if ((b = t.closest('[data-filter]'))) { ui.filter = b.getAttribute('data-filter'); document.querySelectorAll('.chip').forEach(function (c) { c.setAttribute('aria-pressed', String(c === b)); }); renderInv(); return; }
    if (t.closest('[data-logall]')) { ui.logAll = true; render(); return; }
    if (MODE !== 'admin') return;
    if ((b = t.closest('[data-sell]'))) { saleSheet(null, b.getAttribute('data-sell')); return; }
    if ((b = t.closest('[data-edit]'))) { itemSheet(b.getAttribute('data-edit')); return; }
    if ((b = t.closest('[data-esale]'))) { saleSheet(b.getAttribute('data-esale')); return; }
    if ((b = t.closest('[data-add]'))) { itemSheet(null, b.getAttribute('data-add')); return; }
    if (t.closest('#menu')) { menuSheet(); return; }
  });
  window.addEventListener('beforeunload', function (e) { if (MODE === 'admin' && (dirty || saving)) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- login (admin) ---------- */
  function loginView(msg) {
    var tokenUrl = 'https://github.com/settings/personal-access-tokens/new?name=OfficeSell&description=' + encodeURIComponent('עריכת דף OfficeSell') + '&target_name=JoniCoderx&expires_in=366&contents=write';
    app.innerHTML = '<div class="wrap"><header class="top"><div class="brand"><h1>Office<em>Sell</em></h1><span class="sub">כניסה לניהול</span></div></header>' +
      '<form class="login" id="lf" novalidate><h2>חיבור חד-פעמי</h2>' +
      '<p class="note" style="font-size:15px;margin:0">כדי שהשינויים יישמרו ב-GitHub, הדף צריך מפתח גישה מהחשבון שלך. עושים את זה פעם אחת בכל מכשיר.</p>' +
      '<ol><li><a href="' + tokenUrl + '" target="_blank" rel="noopener">פתח את דף יצירת המפתח ב-GitHub</a></li>' +
      '<li>תחת <b>Repository access</b> בחר <bdi>Only select repositories</bdi>, ואז את <b>officesell</b></li>' +
      '<li>תחת <b>Permissions</b> ודא ש-<b>Contents</b> מוגדר ל-<b>Read and write</b></li>' +
      '<li>לחץ <b>Generate token</b>, העתק והדבק כאן</li></ol>' +
      '<div class="f"><label for="tk">מפתח גישה</label><input id="tk" type="password" autocomplete="off" placeholder="github_pat_…" dir="ltr"></div>' +
      '<div class="err" id="lerr">' + esc(msg || '') + '</div><button class="cta" type="submit">התחבר</button>' +
      '<p class="note" style="margin:0">המפתח נשמר רק בדפדפן הזה ולא נשלח לשום מקום חוץ מ-GitHub.</p></form></div>';
    $('lf').addEventListener('submit', function (e) {
      e.preventDefault(); var v = $('tk').value.trim();
      if (!v) { $('lerr').textContent = 'הדבק את המפתח'; return; }
      token = v; store(TOKEN_KEY, v); boot();
    });
  }
  function logout() { token = null; store(TOKEN_KEY, null); loginView(); }

  /* ---------- boot ---------- */
  function skeleton() { app.innerHTML = '<div class="wrap"><header class="top"><div class="brand"><h1>Office<em>Sell</em></h1><span class="sub">טוען…</span></div></header><div class="skel"></div><div class="skel" style="height:80px"></div><div class="skel" style="height:220px"></div></div>'; }
  function boot() {
    if (MODE === 'admin') { token = token || read(TOKEN_KEY); if (!token) { loginView(); return; } }
    if (!state) skeleton();
    load().then(function (d) { state = normalize(d); loadErr = null; render(); })
      .catch(function (e) {
        if (e.code === 'auth') { store(TOKEN_KEY, null); token = null; loginView(e.status === 404 ? 'למפתח אין גישה ל-officesell. בחר את ה-repo בהגדרות המפתח.' : 'המפתח לא תקף או שפג תוקפו. צור מפתח חדש.'); return; }
        loadErr = e;
        if (!state) app.innerHTML = '<div class="wrap"><div class="login"><h2>לא הצלחנו לטעון את הנתונים</h2><p class="note" style="margin:0">בדוק את החיבור לאינטרנט ונסה שוב.</p><button class="cta" id="retry">נסה שוב</button></div></div>';
        var r = $('retry'); if (r) r.onclick = boot;
      });
  }
  function poll() {
    if (document.hidden || !state || (MODE === 'admin' && (dirty || saving || $('scrim')))) return;
    load().then(function (d) {
      d = normalize(d);
      if (d.updated !== state.updated) { state = d; render(); var l = $('live'); if (l) l.classList.add('flash'); }
    }).catch(function () {});
  }
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  boot();
})();
