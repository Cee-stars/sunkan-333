/*!
 * モード切り替え — 上のタブで画面を行き来する所だけを持つ。
 * 素の ES2019 ブラウザ JavaScript。モジュール・外部ライブラリ・ビルド不要。
 *
 * もとは paraphrase.js が「パラフレ帳の中身」と一緒に抱えていた。
 * パラフレ帳とカードを畳んだ（build 69）ので、消えるファイルに
 * 全モードの切り替えを置いたままにはできず、ここへ出した。
 * 以後モードが増えても、触るのは MODES と MODE_PORTS と tabFor の 3 か所だけ。
 *
 * どのモードの中身にも手を出さない。やるのは
 *   ・<html data-mode> を書き換える（見た目の出し分けは CSS の担当）
 *   ・タブの aria-selected / tabindex を揃える
 *   ・入った画面に onShow、出た画面に onHide を配る
 *   ・読み上げを黙らせる（画面をまたいで鳴り続けないように）
 *   ・最後に開いていたモードを localStorage に覚える
 * だけ。
 *
 * DOM の定義は index.html、取り決めは CONTRACT.md を参照。
 */
(function () {
  'use strict';

  var LS_MODE = 'sunkan:mode';   // 'drill' | 'phrase' | 'listen'

  /* 並び順はタブの並びと同じ。← → での行き来もこの順に回る。
     **ここに書いたモードは index.html にタブと画面が在ること。**
     無いものを書くと、← → で画面の無いモードへ行けてしまい真っ白になる。 */
  var MODES = ['drill', 'phrase', 'listen'];

  /* モード名 → そのモードの本体（window に開いている口）の名前。
     増えたらここに 1 行足すだけでよい。瞬間英作文（app.js）は
     data-mode が drill 以外の間はキー操作を受け取らない作りで、
     onShow / onHide を要らないので載せない。 */
  var MODE_PORTS = {
    phrase: 'SUNKAN_PHRASE',
    listen: 'SUNKAN_LISTEN'
  };

  var docEl = document.documentElement;

  function $(id) { return document.getElementById(id); }

  function str(v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'string' ? v : String(v);
  }

  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  function sanitizeMode(raw) {
    return MODES.indexOf(str(raw)) >= 0 ? str(raw) : 'drill';
  }

  function speechPort() {
    return (window.SUNKAN_SPEECH && typeof window.SUNKAN_SPEECH.cancel === 'function')
      ? window.SUNKAN_SPEECH : null;
  }

  var state = { mode: sanitizeMode(lsGet(LS_MODE)) };

  var elTabs = $('mode-tabs');
  var elTabDrill = $('tab-drill');
  var elTabPhrase = $('tab-phrase');
  var elTabListen = $('tab-listen');

  /** モード名 → そのタブ。増えたらここだけ足す */
  function tabFor(mode) {
    if (mode === 'phrase') return elTabPhrase;
    if (mode === 'listen') return elTabListen;
    return elTabDrill;
  }

  function saveMode() { return lsSet(LS_MODE, state.mode); }

  function setMode(mode, opts) {
    opts = opts || {};
    mode = sanitizeMode(mode);
    var moved = state.mode !== mode;
    state.mode = mode;
    docEl.setAttribute('data-mode', mode);

    // 画面が入れ替わったら、鳴っている読み上げは持ち越さない
    if (moved) {
      var port = speechPort();
      if (port) port.cancel();
    }

    for (var i = 0; i < MODES.length; i++) {
      var tab = tabFor(MODES[i]);
      if (!tab) continue;
      var on = MODES[i] === mode;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      // タブの帯は横に滑る。選んだタブが画面の外にいると
      // 「押したのに選ばれていない」ように見えるので、見える所まで寄せる。
      // block: 'nearest' にしないとページごと跳ねる。
      if (on && tab.scrollIntoView) {
        try {
          tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch (e) {
          /* 古い端末では引数なしの形しか無い。寄らなくても困らないので何もしない */
        }
      }
    }

    if (opts.persist !== false) saveMode();
    if (opts.focusTab) {
      var focusTab = tabFor(mode);
      if (focusTab) focusTab.focus();
    }

    // 入った画面に onShow、出た画面に onHide を配る
    if (moved) notifyViews(mode);
  }

  /* 入った画面には onShow、ほかの画面には onHide を配る。
   *
   * モードごとに if を書き分けると、増えたときに **onHide の呼び忘れ**が必ず起きる
   * （シャドーイングが裏で鳴り続けた）。だから表（MODE_PORTS）を回す形にしてある。
   *
   * ・リスニングは離れたら必ず黙らせる
   * ・口がまだ無いファイル（別担当が書いている最中）や、onHide を持たない
   *   ファイルは黙って飛ばす。ここで落ちるとモード切り替えごと死ぬ。 */
  function notifyViews(mode) {
    for (var name in MODE_PORTS) {
      if (!Object.prototype.hasOwnProperty.call(MODE_PORTS, name)) continue;
      var port = window[MODE_PORTS[name]];
      if (!port) continue;
      var fn = (name === mode) ? port.onShow : port.onHide;
      if (typeof fn === 'function') fn.call(port);
    }
  }

  function onTabsKeyDown(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    var at = MODES.indexOf(state.mode);
    if (at < 0) at = 0;
    var step = (e.key === 'ArrowRight') ? 1 : -1;
    var next = (at + step + MODES.length) % MODES.length;   // 端で折り返す
    setMode(MODES[next], { focusTab: true });
  }

  function bindEvents() {
    if (elTabDrill) elTabDrill.addEventListener('click', function () { setMode('drill'); });
    if (elTabPhrase) elTabPhrase.addEventListener('click', function () { setMode('phrase'); });
    if (elTabListen) elTabListen.addEventListener('click', function () { setMode('listen'); });
    if (elTabs) elTabs.addEventListener('keydown', onTabsKeyDown);
  }

  function init() {
    // 覚えていたモードが消えたモード（para / cards）だったときは、
    // sanitizeMode が 'drill' に寄せる。その場合も覚え直しておく
    // （毎回「読めない値」を読みに行かせない）。
    var saved = str(lsGet(LS_MODE));
    setMode(state.mode, { persist: saved !== state.mode });
    bindEvents();
  }

  window.SUNKAN_MODE = {
    /** いま開いているモード */
    current: function () { return state.mode; },
    /** モードを切り替える。opts: { persist, focusTab } */
    set: function (mode, opts) { setMode(mode, opts); },
    /** 並び（タブの並びと同じ） */
    modes: function () { return MODES.slice(); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
