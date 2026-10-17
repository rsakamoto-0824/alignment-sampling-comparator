/**
 * 画面の見た目の調整: 設定欄の幅（取っ手で変える）と、表示の色（OSに合わせる・ライト・ダーク）。
 * どちらもこのブラウザに覚えておく（localStorage。使えないときは覚えないだけで、画面はそのまま動く）。
 * 最初の表示で一瞬ちらつかないよう、覚えた値は index.html の <head> の小さなスクリプトでも先に当てる。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const ui = ASC.ui;

  const STORAGE_KEYS = { theme: "asc-theme", sidebarWidth: "asc-sidebar-width" };
  const THEMES = ["auto", "light", "dark"];
  // 設定欄の幅 [px]: 初期値・最小・最大（最大は画面の幅の割合でも抑える）・キー操作1回の変化
  const SIDEBAR_DEFAULT_PX = 440;
  const SIDEBAR_MIN_PX = 300;
  const SIDEBAR_MAX_PX = 900;
  const SIDEBAR_MAX_FRACTION = 0.6;
  const SIDEBAR_KEY_STEP_PX = 20;

  function readStorage(key) {
    try {
      return root.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      if (value === null) {
        root.localStorage.removeItem(key);
      } else {
        root.localStorage.setItem(key, value);
      }
    } catch (error) {
      // 覚えられなくても画面の操作には差し支えない
    }
  }

  // ---- 表示の色 ----

  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
    } else {
      delete document.documentElement.dataset.theme;
    }
  }

  function setupThemeSwitch() {
    const select = ui.byId("theme-select");
    const saved = readStorage(STORAGE_KEYS.theme);
    select.value = THEMES.includes(saved) ? saved : "auto";
    applyTheme(select.value);
    select.addEventListener("change", () => {
      applyTheme(select.value);
      writeStorage(STORAGE_KEYS.theme, select.value === "auto" ? null : select.value);
    });
  }

  // ---- 設定欄の幅 ----

  function maximumWidth() {
    return Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, Math.floor(root.innerWidth * SIDEBAR_MAX_FRACTION)));
  }

  function clampWidth(width) {
    return Math.round(Math.min(maximumWidth(), Math.max(SIDEBAR_MIN_PX, width)));
  }

  function currentWidth() {
    return ui.byId("settings-panel").getBoundingClientRect().width;
  }

  function applyWidth(width, save) {
    const clamped = clampWidth(width);
    document.documentElement.style.setProperty("--settings-width", `${clamped}px`);
    const handle = ui.byId("sidebar-resizer");
    handle.setAttribute("aria-valuenow", String(clamped));
    handle.setAttribute("aria-valuemax", String(maximumWidth()));
    handle.setAttribute("aria-valuetext", `設定欄の幅 ${clamped}px`);
    if (save) {
      writeStorage(STORAGE_KEYS.sidebarWidth, clamped === SIDEBAR_DEFAULT_PX ? null : String(clamped));
    }
  }

  function setupSidebarResizer() {
    const handle = ui.byId("sidebar-resizer");
    const panel = ui.byId("settings-panel");
    handle.setAttribute("aria-valuemin", String(SIDEBAR_MIN_PX));
    const saved = Number(readStorage(STORAGE_KEYS.sidebarWidth));
    applyWidth(Number.isFinite(saved) && saved > 0 ? saved : SIDEBAR_DEFAULT_PX, false);

    let dragging = false;
    handle.addEventListener("pointerdown", (event) => {
      dragging = true;
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("dragging");
      document.body.classList.add("resizing-sidebar");
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (dragging) {
        applyWidth(event.clientX - panel.getBoundingClientRect().left, false);
      }
    });
    const finish = (event) => {
      if (!dragging) {
        return;
      }
      dragging = false;
      handle.releasePointerCapture(event.pointerId);
      handle.classList.remove("dragging");
      document.body.classList.remove("resizing-sidebar");
      applyWidth(currentWidth(), true);
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("dblclick", () => applyWidth(SIDEBAR_DEFAULT_PX, true));
    handle.addEventListener("keydown", (event) => {
      const width = currentWidth();
      const targets = {
        ArrowLeft: width - SIDEBAR_KEY_STEP_PX,
        ArrowRight: width + SIDEBAR_KEY_STEP_PX,
        Home: SIDEBAR_MIN_PX,
        End: maximumWidth(),
        Enter: SIDEBAR_DEFAULT_PX,
      };
      if (event.key in targets) {
        event.preventDefault();
        applyWidth(targets[event.key], true);
      }
    });
    // 画面を狭くしたときは、設定欄が広すぎないように抑え直す
    root.addEventListener("resize", () => applyWidth(currentWidth(), false));
  }

  ASC.layout = { setupThemeSwitch, setupSidebarResizer, STORAGE_KEYS, SIDEBAR_DEFAULT_PX, SIDEBAR_MIN_PX };
})(typeof window !== "undefined" ? window : globalThis);
