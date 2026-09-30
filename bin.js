// ==UserScript==
// @name         Margonem – Niszczarka wygasłych przedmiotów
// @namespace    majcin.margonem
// @version      1.1.1
// @description  Kosz obok toreb: zbiera wygasłe przedmioty (z toreb i otwartego depozytu) i niszczy je w animowanej niszczarce.
// @author       Majcin
// @match        https://*.margonem.pl/*
// @exclude      https://www.margonem.pl/*
// @exclude      https://forum.margonem.pl/*
// @homepageURL  https://github.com/majcinai/bin
// @supportURL   https://github.com/majcinai/bin/issues
// @updateURL    https://raw.githubusercontent.com/majcinai/bin/main/bin.user.js
// @downloadURL  https://raw.githubusercontent.com/majcinai/bin/main/bin.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ================== KONFIGURACJA ================== */
  const VIEW = 'nszExpired';        // nazwa widoku ikon w menedżerze przedmiotów gry
  const REQ_GAP_MS = 40;            // odstęp między żądaniami wyciągania z depozytu
  const STAGGER_MAX = 110;          // odstęp między kolejnymi przedmiotami w niszczarce (ms)
  const SHRED_TIME = 2500;          // przy dużej liczbie przedmiotów zagęszczamy tempo, by całość trwała ~tyle
  const WAIT_MS = 4000;             // ile czekać na odpowiedź serwera (przeniesienie / zniszczenie)
  const K_UI = 'nsz_ui';

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* */ } };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /* ================== DOSTĘP DO GRY ================== */
  const E = () => window.Engine;
  const itemsMgr = () => E() && E().items;
  const getItem = id => itemsMgr() && itemsMgr().getItemById(id);
  const freeSlots = () => { try { return E().heroEquipment.getFreeSlots(); } catch (e) { return 0; } };
  const send = task => window._g(task);

  function depoOpen() {
    const d = E() && E().depo;
    if (!d || !d.wnd || !d.wnd.$) return false;
    // getVisible() bywa nieaktualne – sprawdzamy faktyczną widoczność okna
    const el = d.wnd.$[0];
    if (!el || !el.isConnected || !d.wnd.$.is(':visible')) return false;
    try {
      const title = d.wnd.$.find('.header-label').first().text();
      if (/klan/i.test(title)) return false;   // depozyt klanowy – pomijamy
    } catch (e) { /* */ }
    return true;
  }

  function isExpired(o) {
    try { return !!o && typeof o.checkExpires === 'function' && o.checkExpires(); } catch (e) { return false; }
  }

  // korzystamy z logiki gry: jeśli menu przedmiotu dostaje opcję "Zniszcz", przedmiot da się zniszczyć
  function canDestroy(o) {
    try { const m = []; o.destroy(m); return m.length > 0; } catch (e) { return false; }
  }

  function expiresTs(o) {
    try { const v = Number(String(o.getItemStat('expires')).split(',')[0]); return v || 0; } catch (e) { return 0; }
  }

  function bagExpired() {
    return (itemsMgr().fetchLocationItems('g') || []).filter(o => isExpired(o) && canDestroy(o));
  }
  function depoExpired() {
    if (!depoOpen()) return [];
    return (itemsMgr().fetchLocationItems('d') || []).filter(isExpired);
  }

  // doczytaj wszystkie zakładki depozytu (gra ładuje je paczkami po 8)
  async function loadAllDepoTabs() {
    const d = E().depo;
    let tabs; try { tabs = d.getDepoOpenTabs(); } catch (e) { return; }
    const n = d.getAmountCards ? d.getAmountCards() : 0;
    for (let i = 0; i < n; i++) {
      if (tabs.getLoadedItemsTab(i) !== false) continue;
      tabs.sendRequestToLoadItem(i);
      const t0 = Date.now();
      while (tabs.getLoadedItemsTab(i) === false && Date.now() - t0 < WAIT_MS) await sleep(100);
      await sleep(REQ_GAP_MS);
    }
  }

  async function waitFor(cond, ms = WAIT_MS) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(50); }
    return cond();
  }

  // wyciąga z depozytu tyle przedmiotów, ile zmieści się w torbach; zwraca id tych, które trafiły do torby
  async function withdrawMany(ids) {
    if (!depoOpen()) return [];
    const list = ids.filter(id => { const o = getItem(id); return o && o.loc === 'd'; }).slice(0, Math.max(0, freeSlots()));
    for (let i = 0; i < list.length; i++) {
      send('depo&get=' + list[i]);
      if (i < list.length - 1) await sleep(REQ_GAP_MS);
    }
    await waitFor(() => list.every(id => { const x = getItem(id); return !x || x.loc === 'g'; }));
    return list.filter(id => { const x = getItem(id); return x && x.loc === 'g'; });
  }

  function sendDestroy(id) {
    send('moveitem&st=-2&id=' + id);
  }

  /* ================== STYLE ================== */
  const css = `
  .nsz-trash{position:absolute;left:-40px;top:2px;width:36px;height:36px;cursor:pointer;z-index:2;box-sizing:border-box}
  .nsz-trash svg{position:absolute;left:4px;top:3px;width:28px;height:30px;filter:drop-shadow(0 1px 1px #000);transition:transform .15s}
  .nsz-trash:hover svg{transform:scale(1.1) rotate(-4deg)}
  .nsz-trash .nsz-cnt{position:absolute;right:-3px;bottom:-3px;min-width:14px;height:14px;padding:0 2px;box-sizing:border-box;border-radius:7px;
    background:#b3261e;color:#fff;font:bold 10px/14px Arial,sans-serif;text-align:center;box-shadow:0 0 0 1px #000;pointer-events:none}
  .nsz-trash .nsz-cnt:empty{display:none}
  .nsz-trash.nsz-has svg .lid{animation:nsz-lid 2.4s ease-in-out infinite;transform-origin:4px 7px}
  @keyframes nsz-lid{0%,80%,100%{transform:rotate(0)}88%{transform:rotate(-14deg)}}

  #nsz-window{width:242px}
  #nsz-window .nsz-body{position:relative;padding:2px 4px 4px;color:rgb(245,245,220);font-size:11px}
  #nsz-window .nsz-info{padding:2px 2px 4px;line-height:14px;min-height:14px}
  #nsz-window .nsz-info .w{color:#e8c25a}#nsz-window .nsz-info .r{color:#ff8f80}#nsz-window .nsz-info .g{color:#8fdc6f}
  #nsz-window .nsz-list{overflow-y:auto;overflow-x:hidden;max-height:min(34vh,260px);scrollbar-width:thin;scrollbar-color:#6b5a33 transparent;
    border:1px solid rgba(245,245,220,.14);background:rgba(0,0,0,.35);border-radius:3px;min-height:44px}
  #nsz-window .nsz-list::-webkit-scrollbar{width:5px}
  #nsz-window .nsz-list::-webkit-scrollbar-thumb{background:#6b5a33;border-radius:3px}
  #nsz-window .nsz-row{display:flex;align-items:center;gap:4px;padding:2px 3px;border-bottom:1px solid rgba(245,245,220,.08);
    transition:opacity .25s,max-height .35s ease,padding .35s,background .2s;max-height:44px;overflow:hidden}
  #nsz-window .nsz-row:hover{background:rgba(255,255,255,.05)}
  #nsz-window .nsz-row.off{opacity:.35}
  #nsz-window .nsz-row.gone{max-height:0;padding-top:0;padding-bottom:0;opacity:0;border-bottom-color:transparent}
  #nsz-window .nsz-row.err{background:rgba(179,38,30,.25)}
  #nsz-window .nsz-slot{position:relative;flex:0 0 32px;width:32px;height:32px;background:rgba(0,0,0,.5);box-shadow:inset 0 0 0 1px rgba(245,245,220,.15);border-radius:2px}
  #nsz-window .nsz-slot .item{position:absolute!important;left:0!important;top:0!important;margin:0!important}
  #nsz-window .nsz-slot.nsz-hidden .item{visibility:hidden}
  #nsz-window .nsz-name{flex:1;min-width:0;line-height:13px}
  #nsz-window .nsz-name .n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#eaeaea}
  #nsz-window .nsz-name .s{color:#9a9a9a;font-size:10px}
  #nsz-window .nsz-where{flex:0 0 auto;font-size:9px;padding:0 3px;border-radius:3px;border:1px solid rgba(245,245,220,.25)}
  #nsz-window .nsz-where.nsz-w-bag{color:#8fdc6f;border-color:rgba(143,220,111,.4)}
  #nsz-window .nsz-where.nsz-w-depo{color:#e8c25a;border-color:rgba(232,194,90,.45)}
  #nsz-window .nsz-chk{flex:0 0 auto;width:12px;height:12px;border:1px solid #8a7a52;border-radius:2px;background:#1b1b1b;cursor:pointer;
    font:bold 10px/11px Arial;text-align:center;color:#ffe28a}
  #nsz-window .nsz-row:not(.off) .nsz-chk::before{content:'✓'}
  #nsz-window .nsz-empty{padding:14px 6px;text-align:center;color:#9a9a9a}
  #nsz-window .nsz-bar{display:flex;gap:3px;justify-content:center;flex-wrap:wrap;padding:5px 0 1px}
  #nsz-window .nsz-bar .button.nsz-hide{display:none}
  #nsz-window .nsz-bar .button{min-width:0}
  #nsz-window .nsz-bar .button.nsz-dis{opacity:.4;pointer-events:none}
  #nsz-window .button.red .label{color:#ffd0c8}

  /* ---------- niszczarka ---------- */
  #nsz-window .nsz-machine{position:relative;height:120px;margin-top:5px;overflow:hidden;border-radius:3px;
    background:radial-gradient(ellipse at 50% 100%,rgba(255,170,60,.12),transparent 70%),rgba(0,0,0,.45)}
  #nsz-window .nsz-head{position:absolute;left:50%;top:18px;width:160px;height:46px;margin-left:-80px;z-index:3;border-radius:8px 8px 4px 4px;
    background:linear-gradient(#5b5f66,#2d3035 55%,#202226);box-shadow:0 0 0 1px #0c0c0c,inset 0 1px 0 rgba(255,255,255,.25),0 4px 8px rgba(0,0,0,.6)}
  #nsz-window .nsz-head::before{content:'';position:absolute;left:14px;right:14px;top:6px;height:8px;border-radius:4px;background:#050505;
    box-shadow:inset 0 2px 3px #000,0 1px 0 rgba(255,255,255,.18)}
  #nsz-window .nsz-teeth{position:absolute;left:18px;right:18px;top:8px;height:4px;border-radius:2px;opacity:.75;
    background:repeating-linear-gradient(90deg,#8d9199 0 3px,#3a3d42 3px 6px)}
  #nsz-window .nsz-machine.on .nsz-teeth{animation:nsz-teeth .18s linear infinite}
  @keyframes nsz-teeth{to{background-position:6px 0}}
  #nsz-window .nsz-plate{position:absolute;left:50%;bottom:7px;transform:translateX(-50%);font:bold 10px/12px Georgia,serif;letter-spacing:2px;
    color:#c9b27a;text-shadow:0 1px 0 #000;white-space:nowrap}
  #nsz-window .nsz-led{position:absolute;right:11px;bottom:9px;width:7px;height:7px;border-radius:50%;background:#3b1111;box-shadow:inset 0 0 2px #000}
  #nsz-window .nsz-machine.on .nsz-led{background:#ff3b2f;box-shadow:0 0 6px 2px rgba(255,59,47,.8)}
  #nsz-window .nsz-machine.done .nsz-led{background:#46d15a;box-shadow:0 0 6px 2px rgba(70,209,90,.7)}
  #nsz-window .nsz-machine.on .nsz-head{animation:nsz-shake .09s linear infinite}
  @keyframes nsz-shake{0%{transform:translate(0,0)}25%{transform:translate(.6px,-.4px)}50%{transform:translate(-.5px,.3px)}75%{transform:translate(.4px,.5px)}100%{transform:translate(0,0)}}
  #nsz-window .nsz-bin{position:absolute;left:50%;top:62px;width:140px;height:56px;margin-left:-70px;z-index:1;border-radius:0 0 10px 10px;
    background:linear-gradient(90deg,rgba(255,255,255,.04),rgba(255,255,255,.1) 30%,rgba(255,255,255,.03));
    border:1px solid rgba(200,210,220,.25);border-top:none;box-shadow:inset 0 -8px 14px rgba(0,0,0,.5)}
  #nsz-window .nsz-pile{position:absolute;left:50%;top:62px;width:138px;height:55px;margin-left:-69px;z-index:2;overflow:hidden;border-radius:0 0 9px 9px;pointer-events:none}
  #nsz-window .nsz-strip{position:absolute;top:-6px;width:5px;height:32px;background-repeat:no-repeat;image-rendering:pixelated;will-change:transform}
  #nsz-window .nsz-fly{position:absolute;z-index:2;width:32px;height:32px;pointer-events:none;will-change:transform}
  #nsz-window .nsz-fly canvas{width:32px;height:32px;image-rendering:pixelated;display:block}
  #nsz-window .nsz-spark{position:absolute;z-index:4;width:3px;height:3px;border-radius:50%;background:#ffd36b;box-shadow:0 0 4px #ffb02e;pointer-events:none}
  #nsz-window .nsz-counter{position:absolute;left:6px;top:2px;font:bold 11px/14px Arial;color:#c9b27a}
  #nsz-window .nsz-counter b{color:#ffe28a}
  `;

  /* ================== IKONA KOSZA ================== */
  const trashSvg = `<svg viewBox="0 0 28 30" aria-hidden="true">
    <defs><linearGradient id="nszg" x1="0" x2="1"><stop offset="0" stop-color="#8d7a4c"/><stop offset=".45" stop-color="#e9d49a"/><stop offset="1" stop-color="#7b6a40"/></linearGradient></defs>
    <g class="lid"><rect x="2" y="5" width="24" height="3.4" rx="1.2" fill="url(#nszg)" stroke="#2a2214" stroke-width=".8"/>
      <path d="M10 5V3.2c0-.9.6-1.5 1.5-1.5h5c.9 0 1.5.6 1.5 1.5V5" fill="none" stroke="#e9d49a" stroke-width="1.6"/></g>
    <path d="M4.2 9.6h19.6l-1.7 17.6c-.1 1.1-1 1.8-2 1.8H7.9c-1 0-1.9-.7-2-1.8z" fill="url(#nszg)" stroke="#2a2214" stroke-width=".8"/>
    <path d="M9.4 12.5l.6 13M14 12.5v13M18.6 12.5l-.6 13" stroke="#4a3c20" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;

  let trash, cntEl;
  function attachTrash() {
    const nav = document.querySelector('.bags-navigation-bg');
    if (!nav || !nav.parentElement) return;
    if (!trash) {
      trash = document.createElement('div');
      trash.className = 'nsz-trash interface-element-one-black-tile';
      trash.innerHTML = trashSvg + '<div class="nsz-cnt"></div>';
      cntEl = trash.querySelector('.nsz-cnt');
      ['mousedown', 'pointerdown', 'mouseup', 'dblclick', 'contextmenu'].forEach(t => trash.addEventListener(t, e => e.stopPropagation()));
      trash.addEventListener('click', e => { e.stopPropagation(); openWindow(); });
      try { window.$(trash).tip('<b>Niszczarka</b><br>Wygasłe przedmioty z toreb<br>(i z depozytu, jeśli jest otwarty)'); } catch (e) { trash.title = 'Niszczarka wygasłych przedmiotów'; }
    }
    // kosz siedzi wewnątrz paska toreb (pozycja w CSS względem niego), więc od pierwszej klatki
    // podąża za torbami – bez liczenia offsetów, które przy wczytywaniu gry są jeszcze nieaktualne
    if (trash.parentElement !== nav) nav.appendChild(trash);
  }

  function updateBadge() {
    if (!cntEl) return;
    let n = 0;
    try { n = bagExpired().length + depoExpired().length; } catch (e) { /* */ }
    cntEl.textContent = n ? String(n) : '';
    trash.classList.toggle('nsz-has', n > 0);
  }

  /* ================== OKNO ================== */
  const ui = Object.assign({ x: 380, y: 90 }, load(K_UI, {}));
  let win, listEl, infoEl, machine, pile, counterEl, btnShred, btnRefresh, btnPull;
  let entries = [];          // { id, row, slot, off, state }
  let busy = false;

  const btn = (label, a, cls = 'green') => `<div class="button small ${cls}" data-a="${a}"><div class="background"></div><div class="label">${label}</div></div>`;

  function gameLayer() {
    const who = document.querySelector('.whoishere-window');
    return (who && who.parentElement) || document.querySelector('.alerts-layer') || document.querySelector('.game-window-positioner') || document.body;
  }

  function buildWindow() {
    win = document.createElement('div');
    win.id = 'nsz-window';
    win.className = 'c-window border-window transparent';
    win.style.cssText = 'position:absolute;z-index:24;display:none;';
    win.innerHTML = `
      <div class="header-label-positioner">
        <div class="draggable-window-element"></div>
        <div class="header-label"><div class="left-decor"></div><div class="right-decor"></div><div class="text">Niszczarka</div></div>
      </div>
      <div class="content"><div class="inner-content"><div class="nsz-body">
        <div class="nsz-info"></div>
        <div class="nsz-list"></div>
        <div class="nsz-machine">
          <div class="nsz-counter"></div>
          <div class="nsz-bin"></div>
          <div class="nsz-pile"></div>
          <div class="nsz-head"><div class="nsz-teeth"></div><div class="nsz-plate">NISZCZARKA</div><div class="nsz-led"></div></div>
        </div>
        <div class="nsz-bar">${btn('Odśwież', 'refresh')}${btn('Do torby', 'pull')}${btn('Niszczarka', 'shred', 'red')}</div>
      </div></div></div>
      <div class="c-window__bottom-bar"><div class="interface-element-bottom-bar-background-stretch"></div></div>
      <div class="close-button-corner-decor"><button type="button" class="close-button" title="Zamknij"><div class="ie-icon ie-icon-close"></div></button></div>
      <div class="border-image"></div>`;
    listEl = win.querySelector('.nsz-list');
    infoEl = win.querySelector('.nsz-info');
    machine = win.querySelector('.nsz-machine');
    pile = win.querySelector('.nsz-pile');
    counterEl = win.querySelector('.nsz-counter');
    btnShred = win.querySelector('[data-a="shred"]');
    btnRefresh = win.querySelector('[data-a="refresh"]');
    btnPull = win.querySelector('[data-a="pull"]');
    try { window.$(btnPull).tip('Przenieś zaznaczone wygasłe przedmioty z depozytu do toreb (tyle, ile się zmieści)'); } catch (e) { /* */ }

    const toggleRow = row => {
      if (!row || busy) return;
      const en = entries.find(x => x.row === row);
      if (en) { en.off = !en.off; row.classList.toggle('off', en.off); updateInfo(); }
    };

    // ikony w liście to klony przedmiotów z podpiętymi akcjami gry (menu, przeciąganie) –
    // w fazie capture przechwytujemy na nich kliknięcia, żeby nie dotarły do klonu (tip dalej działa)
    ['click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'pointerdown', 'touchstart'].forEach(t =>
      win.addEventListener(t, e => {
        const slot = e.target.closest && e.target.closest('.nsz-slot');
        if (!slot) return;
        e.stopPropagation(); e.preventDefault();
        if (t === 'click') toggleRow(slot.closest('.nsz-row'));
      }, true));

    // nie oddawaj kliknięć / klawiszy / kółka grze
    ['click', 'dblclick', 'wheel', 'keydown', 'keyup', 'contextmenu', 'mousedown'].forEach(t => win.addEventListener(t, e => e.stopPropagation()));

    win.addEventListener('pointerdown', bringToFront, true);
    win.addEventListener('click', e => {
      if (e.target.closest('.close-button')) { closeWindow(); return; }
      const a = e.target.closest('[data-a]');
      if (a) { const f = { shred: runShredder, refresh: refresh, pull: pullToBags }[a.dataset.a]; if (f) f(); return; }
      toggleRow(e.target.closest('.nsz-row'));
    });

    // przeciąganie za nagłówek (z uwzględnieniem skali interfejsu)
    const head = win.querySelector('.header-label-positioner');
    head.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      const sx = e.clientX, sy = e.clientY, ox = win.offsetLeft, oy = win.offsetTop;
      const scale = win.getBoundingClientRect().width / win.offsetWidth || 1;
      try { head.setPointerCapture(e.pointerId); } catch (err) { /* */ }
      const mv = m => { m.stopPropagation(); place(ox + (m.clientX - sx) / scale, oy + (m.clientY - sy) / scale); };
      const up = () => {
        ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'].forEach((t, i) => head.removeEventListener(t, i ? up : mv));
        ui.x = win.offsetLeft; ui.y = win.offsetTop; save(K_UI, ui);
      };
      head.addEventListener('pointermove', mv);
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => head.addEventListener(t, up));
    });
  }

  // okna gry mają rosnące z-indexy – ustaw się nad najwyższym
  function bringToFront() {
    const p = win.parentElement; if (!p) return;
    let max = 0;
    for (const c of p.children) {
      if (c === win) continue;
      const z = parseInt(getComputedStyle(c).zIndex, 10);
      if (z > max && z < 1000) max = z;
    }
    const cur = parseInt(win.style.zIndex, 10) || 0;
    if (cur <= max) win.style.zIndex = String(max + 1);
  }

  function place(x, y) {
    const p = win.parentElement;
    const maxX = Math.max(0, (p ? p.clientWidth : innerWidth) - win.offsetWidth);
    const maxY = Math.max(0, (p ? p.clientHeight : innerHeight) - 40);
    win.style.left = Math.round(Math.min(Math.max(0, x), maxX)) + 'px';
    win.style.top = Math.round(Math.min(Math.max(0, y), maxY)) + 'px';
  }

  async function openWindow() {
    if (!win) buildWindow();
    const layer = gameLayer();
    if (win.parentElement !== layer) layer.appendChild(win);
    if (win.style.display !== 'none' && busy) return;
    win.style.display = 'block';
    bringToFront();
    place(ui.x, ui.y);
    await refresh();
  }

  function closeWindow() {
    if (busy) return;           // nie przerywaj pracy niszczarki
    win.style.display = 'none';
    clearList();
  }

  function clearList() {
    try { itemsMgr().deleteAllViewsByViewName(VIEW); } catch (e) { /* */ }
    listEl.innerHTML = '';
    entries = [];
  }

  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  const inDepo = en => { const o = getItem(en.id); return !!o && o.loc === 'd'; };

  function setBusyButtons(b) {
    btnShred.classList.toggle('nsz-dis', b || !entries.some(x => !x.off));
    btnRefresh.classList.toggle('nsz-dis', b);
    const depoSel = entries.some(x => !x.off && inDepo(x));
    btnPull.classList.toggle('nsz-hide', !entries.some(inDepo) || !depoOpen());
    btnPull.classList.toggle('nsz-dis', b || !depoSel || freeSlots() < 1);
  }

  // odświeżenie listy – przy otwartym depozycie doczytuje wszystkie zakładki, ale niczego nie przenosi
  async function refresh() {
    if (busy) return;
    busy = true;
    machine.classList.remove('on', 'done');
    counterEl.innerHTML = '';
    setBusyButtons(true);
    try {
      if (depoOpen()) {
        infoEl.innerHTML = '<span class="w">Przeszukuję depozyt…</span>';
        await loadAllDepoTabs();
      }
    } finally { busy = false; }
    renderList();
    updateInfo();
    updateBadge();
  }

  // przycisk „Do torby": wygasłe z depozytu -> torby
  async function pullToBags() {
    if (busy || !depoOpen()) return;
    const sel = entries.filter(x => !x.off && inDepo(x));
    if (!sel.length) return;
    busy = true;
    setBusyButtons(true);
    infoEl.innerHTML = `<span class="w">Przenoszę do torby…</span>`;
    let moved = [];
    try { moved = await withdrawMany(sel.map(x => x.id)); } finally { busy = false; }
    const off = new Set(entries.filter(x => x.off).map(x => x.id));
    renderList(off);
    const left = sel.length - moved.length;
    let note = ` Przeniesiono: <span class="g">${moved.length}</span>.`;
    if (left) note += ` <span class="r">Brak miejsca w torbach na ${left}.</span>`;
    updateInfo(note);
    updateBadge();
  }

  function renderList(offIds = new Set()) {
    clearList();
    const all = [...bagExpired().map(o => ({ o, where: 'bag' })), ...depoExpired().map(o => ({ o, where: 'depo' }))];
    all.sort((a, b) => (a.where === b.where ? 0 : a.where === 'bag' ? -1 : 1) || String(a.o.name).localeCompare(String(b.o.name), 'pl'));
    if (!all.length) {
      listEl.innerHTML = '<div class="nsz-empty">Brak wygasłych przedmiotów' + (depoOpen() ? '' : ' w torbach.<br>Otwórz depozyt, aby przeszukać także jego zawartość.') + '</div>';
      setBusyButtons(false);
      return;
    }
    for (const { o, where } of all) {
      const row = document.createElement('div');
      row.className = 'nsz-row';
      const amount = (() => { try { return o.getAmount ? o.getAmount() : 1; } catch (e) { return 1; } })();
      row.innerHTML = `<div class="nsz-chk"></div><div class="nsz-slot"></div>
        <div class="nsz-name"><div class="n">${esc(o.name)}${amount > 1 ? ` <span style="color:#9a9a9a">×${amount}</span>` : ''}</div>
        <div class="s">wygasł ${fmtDate(expiresTs(o))}</div></div>
        <div class="nsz-where nsz-w-${where}">${where === 'bag' ? 'torba' : 'depozyt'}</div>`;
      const slot = row.querySelector('.nsz-slot');
      try {
        const v = itemsMgr().createViewIcon(o.id, VIEW);   // klon ikony z grafiką, licznikiem i tipem gry
        if (v && v[0]) slot.appendChild(v[0][0]);
      } catch (e) { /* */ }
      listEl.appendChild(row);
      const off = offIds.has(o.id);
      if (off) row.classList.add('off');
      entries.push({ id: o.id, row, slot, off });
    }
    setBusyButtons(false);
  }

  function updateInfo(extra = '') {
    const sel = entries.filter(x => !x.off).length;
    if (!entries.length) { infoEl.innerHTML = extra ? extra.trim() : ''; }
    else {
      const d = entries.filter(inDepo).length;
      infoEl.innerHTML = `Wygasłe: <span class="w">${entries.length}</span>` + (d ? ` (depozyt: <span class="w">${d}</span>)` : '') +
        `, zaznaczone: <span class="r">${sel}</span>.` + extra;
    }
    if (!busy) setBusyButtons(false);
  }

  /* ================== ANIMACJA ================== */
  function scaleOf() { return win.getBoundingClientRect().width / win.offsetWidth || 1; }
  function relRect(el) {
    const s = scaleOf(), w = machine.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x: (r.left - w.left) / s, y: (r.top - w.top) / s, w: r.width / s, h: r.height / s };
  }

  function iconCanvas(en) {
    const src = en.slot.querySelector('canvas.canvas-icon') || en.slot.querySelector('canvas');
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    try { c.getContext('2d').drawImage(src, 0, 0, 32, 32); } catch (e) { /* */ }
    return c;
  }

  function anim(el, frames, opts) {
    return new Promise(res => {
      const a = el.animate(frames, Object.assign({ fill: 'forwards' }, opts));
      a.onfinish = res; a.oncancel = res;
    });
  }

  // lot ikony z listy do szczeliny niszczarki
  async function flyToShredder(en, canvas) {
    const from = relRect(en.slot);
    const lr = relRect(listEl);                       // przedmioty spoza widoku listy startują z jej krawędzi
    from.y = Math.min(Math.max(from.y, lr.y), lr.y + lr.h - 32);
    const mouth = relRect(win.querySelector('.nsz-head'));
    const tx = mouth.x + mouth.w / 2 - 16, ty = mouth.y - 20;
    const fly = document.createElement('div');
    fly.className = 'nsz-fly';
    fly.appendChild(canvas);
    fly.style.left = '0px'; fly.style.top = '0px';
    machine.appendChild(fly);
    en.slot.classList.add('nsz-hidden');
    const rot = (Math.random() * 40 - 20).toFixed(1);
    const midX = (from.x + tx) / 2, midY = Math.min(from.y, ty) - 30;
    await anim(fly, [
      { transform: `translate(${from.x}px,${from.y}px) scale(1) rotate(0deg)` },
      { transform: `translate(${midX}px,${midY}px) scale(1.25) rotate(${rot}deg)`, offset: .45 },
      { transform: `translate(${tx}px,${ty}px) scale(1) rotate(0deg)` }
    ], { duration: 320, easing: 'cubic-bezier(.3,.6,.4,1)' });
    // wciąganie w szczelinę (głowica ma wyższy z-index, więc przedmiot znika „w środku")
    await anim(fly, [
      { transform: `translate(${tx}px,${ty}px)` },
      { transform: `translate(${tx}px,${ty + 6}px)`, offset: .2 },
      { transform: `translate(${tx}px,${ty + 44}px)` }
    ], { duration: 220, easing: 'ease-in' });
    fly.remove();
  }

  // ścinki z grafiki przedmiotu wypadające do kosza
  function spawnStrips(canvas) {
    let url = '';
    try { url = canvas.toDataURL(); } catch (e) { /* */ }
    const STRIPS = 7, w = 32 / STRIPS;
    const PW = pile.offsetWidth || 138, PH = pile.offsetHeight || 55;
    const baseX = PW / 2 - 16 + (Math.random() * 30 - 15);
    const pileH = Math.min(PH - 18, 6 + pile.childElementCount * 0.1);
    while (pile.childElementCount > 350) pile.firstChild.remove();   // nie zapychaj DOM-u
    for (let i = 0; i < STRIPS; i++) {
      const s = document.createElement('div');
      s.className = 'nsz-strip';
      s.style.left = (baseX + i * w) + 'px';
      s.style.width = Math.ceil(w) + 'px';
      if (url) { s.style.backgroundImage = `url(${url})`; s.style.backgroundPosition = `${-i * w}px 0`; }
      else s.style.background = '#c9b27a';
      pile.appendChild(s);
      const endY = PH - pileH - 20 + Math.random() * 12;
      const dx = (Math.random() * 60 - 30);
      const r = (Math.random() * 160 - 80).toFixed(0);
      s.animate([
        { transform: 'translate(0,-34px) rotate(0deg)' },
        { transform: `translate(${dx * .3}px,-4px) rotate(${r * .2}deg)`, offset: .25 },
        { transform: `translate(${dx}px,${endY}px) rotate(${r}deg) scaleY(.8)` }
      ], { duration: 550 + Math.random() * 300, delay: i * 25, easing: 'cubic-bezier(.35,0,.6,1)', fill: 'forwards' });
    }
    // iskry z głowicy
    const head = relRect(win.querySelector('.nsz-head'));
    for (let i = 0; i < 4; i++) {
      const sp = document.createElement('div');
      sp.className = 'nsz-spark';
      sp.style.left = (head.x + head.w / 2 + Math.random() * 80 - 40) + 'px';
      sp.style.top = (head.y + 6) + 'px';
      machine.appendChild(sp);
      const a = sp.animate([
        { transform: 'translate(0,0)', opacity: 1 },
        { transform: `translate(${Math.random() * 50 - 25}px,${-10 - Math.random() * 22}px)`, opacity: 0 }
      ], { duration: 350 + Math.random() * 250, easing: 'ease-out' });
      a.onfinish = () => sp.remove();
    }
  }

  async function removeRow(en, ok) {
    if (ok) { en.row.classList.add('gone'); await sleep(300); en.row.remove(); try { itemsMgr().deleteViewIconIfExist(en.id, VIEW); } catch (e) { /* */ } }
    else { en.slot.classList.remove('nsz-hidden'); en.row.classList.add('err'); }
  }

  /* ================== NISZCZENIE ================== */
  async function runShredder() {
    if (busy) return;
    const todo = entries.filter(x => !x.off);
    if (!todo.length) return;
    busy = true;
    setBusyButtons(true);
    machine.classList.remove('done');
    machine.classList.add('on');
    let done = 0, failed = 0;
    const total = todo.length;
    const stagger = Math.max(35, Math.min(STAGGER_MAX, SHRED_TIME / total));
    const setCounter = () => { counterEl.innerHTML = `Zniszczono: <b>${done}</b>/${total}` + (failed ? ` <span style="color:#ff8f80">(błąd: ${failed})</span>` : ''); };
    const fail = en => { failed++; en.slot.classList.remove('nsz-hidden'); en.row.classList.add('err'); setCounter(); };
    setCounter();

    // żądania lecą szybko jedno po drugim, animacje nakładają się na siebie
    const shredBatch = list => Promise.all(list.map((en, i) => (async () => {
      await sleep(i * stagger);
      const o = getItem(en.id);
      if (!o || o.loc !== 'g' || !canDestroy(o)) { fail(en); return; }
      const canvas = iconCanvas(en);
      sendDestroy(en.id);
      await flyToShredder(en, canvas);
      const ok = await waitFor(() => { const x = getItem(en.id); return !x || x.loc !== 'g'; }, 3000);
      if (!ok) { fail(en); return; }
      spawnStrips(canvas);
      done++; setCounter();
      await removeRow(en, true);
    })()));

    infoEl.innerHTML = '<span class="w">Niszczenie…</span>';
    await shredBatch(todo.filter(en => { const o = getItem(en.id); return o && o.loc === 'g'; }));

    // przedmioty z depozytu: wyciągamy partiami (ile wolnych miejsc) i od razu niszczymy
    let depoLeft = todo.filter(inDepo);
    while (depoLeft.length && depoOpen() && freeSlots() > 0) {
      const moved = new Set(await withdrawMany(depoLeft.map(x => x.id)));
      if (!moved.size) break;
      const batch = depoLeft.filter(x => moved.has(x.id));
      depoLeft = depoLeft.filter(x => !moved.has(x.id));
      batch.forEach(en => { const w = en.row.querySelector('.nsz-where'); if (w) { w.className = 'nsz-where nsz-w-bag'; w.textContent = 'torba'; } });
      await shredBatch(batch);
    }
    depoLeft.forEach(fail);

    await sleep(700);
    machine.classList.remove('on');
    machine.classList.add('done');
    busy = false;
    entries = entries.filter(x => document.body.contains(x.row));
    infoEl.innerHTML = (done ? `<span class="g">Zniszczono ${done} ${plural(done)}.</span>` : '<span class="r">Nic nie zostało zniszczone.</span>') +
      (depoLeft.length ? ` <span class="r">${depoLeft.length} z depozytu nie weszło do toreb${depoOpen() ? '' : ' (depozyt zamknięty)'}.</span>` :
        failed ? ` <span class="r">Błędy: ${failed}.</span>` : '');
    if (!entries.length) listEl.innerHTML = '<div class="nsz-empty">Pusto – wszystko trafiło do niszczarki.</div>';
    setBusyButtons(false);
    updateBadge();
  }

  function plural(n) {
    if (n === 1) return 'przedmiot';
    const d = n % 10, h = n % 100;
    return (d >= 2 && d <= 4 && (h < 12 || h > 14)) ? 'przedmioty' : 'przedmiotów';
  }

  /* ================== START ================== */
  function ready() {
    return window.Engine && Engine.items && Engine.heroEquipment && typeof window._g === 'function' && document.querySelector('.bags-navigation-bg');
  }

  function init() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    attachTrash();
    updateBadge();
    setInterval(attachTrash, 1000);        // gra potrafi przebudować interfejs (zmiana rozmiaru, skórki)
    setInterval(() => { if (!busy) updateBadge(); }, 5000);
  }

  const boot = setInterval(() => { if (ready()) { clearInterval(boot); init(); } }, 500);
})();