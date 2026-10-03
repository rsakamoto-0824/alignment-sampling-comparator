/**
 * 画面の共通処理（要素の作成、数値の表示、ファイルの保存、メッセージ）。
 * 文字は必ず textContent で入れる（CSVなどから来た文字をHTMLとして解釈させない）。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});

  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

  function byId(id) {
    return document.getElementById(id);
  }

  /**
   * HTML要素を作る。attributes の text は textContent、className は class、それ以外は属性。
   */
  function create(tag, attributes, children) {
    const element = document.createElement(tag);
    applyAttributes(element, attributes);
    appendChildren(element, children);
    return element;
  }

  /** SVG要素を作る。 */
  function createSvg(tag, attributes, children) {
    const element = document.createElementNS(SVG_NAMESPACE, tag);
    applyAttributes(element, attributes);
    appendChildren(element, children);
    return element;
  }

  function applyAttributes(element, attributes) {
    if (!attributes) {
      return;
    }
    for (const [key, value] of Object.entries(attributes)) {
      if (value === undefined || value === null || value === false) {
        continue;
      }
      if (key === "text") {
        element.textContent = value;
      } else if (key === "className") {
        element.setAttribute("class", value);
      } else if (key.startsWith("on") && typeof value === "function") {
        element.addEventListener(key.slice(2).toLowerCase(), value);
      } else {
        element.setAttribute(key, value === true ? "" : value);
      }
    }
  }

  function appendChildren(element, children) {
    if (!children) {
      return;
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) {
        continue;
      }
      element.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
  }

  /** 数値を決まった桁で表示する。無限大や NaN は「—」。 */
  function formatNumber(value, digits) {
    if (!Number.isFinite(value)) {
      return "—";
    }
    return value.toFixed(digits === undefined ? 3 : digits);
  }

  /** テキストをファイルとして保存する（ブラウザのダウンロード）。 */
  function download(fileName, text, mimeType) {
    // ExcelでCSVの日本語が文字化けしないよう、CSVにはBOMを付ける
    const content = mimeType === "text/csv" ? "﻿" + text : text;
    const blob = new Blob([content], { type: mimeType + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = create("a", { href: url, download: fileName });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** ファイル名に使う日時（例 20261003-1530）。 */
  function timestampForFile() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  }

  /**
   * 画面上部にメッセージを出す。type は error / warning / success。
   * items は箇条書きにする説明の一覧（何が・なぜ・どうすればよいか）。
   */
  function showMessage(type, title, items) {
    const area = byId("message-area");
    area.replaceChildren();
    const icons = { error: "✕", warning: "⚠", success: "✓" };
    const body = create("div", null, [create("strong", { text: title })]);
    if (items && items.length > 0) {
      body.append(create("ul", null, items.map((item) => create("li", { text: item }))));
    }
    area.append(
      create("div", { className: `notice notice-${type}` }, [
        create("span", { className: "notice-icon", "aria-hidden": "true", text: icons[type] || "" }),
        body,
        create("button", {
          type: "button",
          className: "button-secondary button-small",
          text: "閉じる",
          onClick: clearMessage,
        }),
      ])
    );
  }

  function clearMessage() {
    byId("message-area").replaceChildren();
  }

  /** "a.b.c" の形のパスで値を読む。 */
  function getPath(object, path) {
    return path.split(".").reduce((current, key) => (current === undefined ? undefined : current[key]), object);
  }

  /** "a.b.c" の形のパスで値を書く。 */
  function setPath(object, path, value) {
    const keys = path.split(".");
    let current = object;
    for (let i = 0; i < keys.length - 1; i++) {
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
  }

  /** CSVの1セル。カンマや引用符を含む値は引用符で囲む。 */
  function csvCell(value) {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  /** 連続した呼び出しをまとめ、最後の呼び出しから少し待って1回だけ実行する。 */
  function debounce(callback, waitMs) {
    let timer = null;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(callback, waitMs);
    };
  }

  ASC.ui = {
    byId,
    create,
    createSvg,
    formatNumber,
    download,
    timestampForFile,
    showMessage,
    clearMessage,
    getPath,
    setPath,
    csvCell,
    debounce,
  };
})(typeof window !== "undefined" ? window : globalThis);
