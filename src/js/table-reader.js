/**
 * 表のファイル（CSV・Excelのxlsx）を読み、シートごとの「行の一覧」にする。追加の部品は使わない。
 *
 * 戻り値の形（CSVもxlsxも同じ）:
 *   { sheets: [{ name, rows: [{ line, cells }] }], date1904 }
 *   line は元のファイルの行番号（1始まり）、cells は各列の文字（前後の空白は除く）。空の行は入れない。
 *   date1904 は、xlsxの日付が1904年基準か（Macの古いExcelの設定。CSVでは false）。
 *
 * xlsx はZIPにまとめたXMLなので、ZIPを開いて（圧縮はブラウザの DecompressionStream で戻す）、
 * ブックのシートの並び・共有文字列・各シートのセルを読む。数式は計算済みの値を使う。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});

  // ZIPの目印（リトルエンディアンの4バイト）
  const ZIP_END_SIGNATURE = 0x06054b50;
  const ZIP_DIRECTORY_SIGNATURE = 0x02014b50;
  const ZIP_LOCAL_SIGNATURE = 0x04034b50;
  // ZIPの末尾の情報（22バイト）と、その後ろに付けられるコメントの最大の長さ
  const ZIP_END_SIZE = 22;
  const ZIP_COMMENT_MAX = 65535;
  const ZIP_STORED = 0;
  const ZIP_DEFLATED = 8;
  const XLSX_SIGNATURE_BYTES = [0x50, 0x4b];
  const XML_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

  // ---- CSV -------------------------------------------------------------------

  /** CSVの1行をカンマで分ける（ダブルクォートで囲んだ値にも対応）。 */
  function splitCsvLine(line) {
    const cells = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const character = line[i];
      if (quoted) {
        if (character === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (character === '"') {
          quoted = false;
        } else {
          current += character;
        }
      } else if (character === '"') {
        quoted = true;
      } else if (character === ",") {
        cells.push(current.trim());
        current = "";
      } else {
        current += character;
      }
    }
    cells.push(current.trim());
    return cells;
  }

  /** CSVの文字を表にする（シートは1つ。シートの名前はない）。 */
  function parseCsvText(text) {
    const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
    const rows = [];
    lines.forEach((line, index) => {
      if (line.trim() !== "") {
        rows.push({ line: index + 1, cells: splitCsvLine(line) });
      }
    });
    return { sheets: [{ name: null, rows }], date1904: false };
  }

  /**
   * CSVのバイト列を文字にする。UTF-8（BOMの有無どちらも）で読めなければ、日本語版Excelの既定の
   * Shift_JIS として読む（ExcelでCSV保存したファイルに備える）。
   */
  function decodeCsvBytes(bytes) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      return new TextDecoder("shift_jis").decode(bytes);
    }
  }

  // ---- ZIP -------------------------------------------------------------------

  function readUint16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function readUint32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  /** ZIPの目次（中央ディレクトリ）を読み、名前 → { method, size, localOffset } にする。 */
  function readZipDirectory(bytes) {
    const searchStart = Math.max(0, bytes.length - ZIP_END_SIZE - ZIP_COMMENT_MAX);
    let endOffset = -1;
    for (let offset = bytes.length - ZIP_END_SIZE; offset >= searchStart; offset--) {
      if (readUint32(bytes, offset) === ZIP_END_SIGNATURE) {
        endOffset = offset;
        break;
      }
    }
    if (endOffset < 0) {
      throw new Error("xlsxファイルの中身を読めません（ZIPの形になっていません）。Excelで開いて、xlsxで保存し直してください。");
    }
    const entryCount = readUint16(bytes, endOffset + 10);
    let offset = readUint32(bytes, endOffset + 16);
    const entries = new Map();
    const decoder = new TextDecoder("utf-8");
    for (let index = 0; index < entryCount; index++) {
      if (readUint32(bytes, offset) !== ZIP_DIRECTORY_SIGNATURE) {
        throw new Error("xlsxファイルの目次が壊れています。Excelで開いて、xlsxで保存し直してください。");
      }
      const method = readUint16(bytes, offset + 10);
      const size = readUint32(bytes, offset + 20);
      const nameLength = readUint16(bytes, offset + 28);
      const extraLength = readUint16(bytes, offset + 30);
      const commentLength = readUint16(bytes, offset + 32);
      const localOffset = readUint32(bytes, offset + 42);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      entries.set(name, { method, size, localOffset });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  /** ブラウザの DecompressionStream で、ZIPの圧縮（deflate）を戻す。 */
  async function inflateWithStream(compressed) {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** ZIPの中の1つのファイルを文字（UTF-8）で読む。なければ null。 */
  async function readZipText(bytes, entries, name, inflate) {
    const entry = entries.get(name);
    if (!entry) {
      return null;
    }
    const offset = entry.localOffset;
    if (readUint32(bytes, offset) !== ZIP_LOCAL_SIGNATURE) {
      throw new Error(`xlsxファイルの中の ${name} を読めません。Excelで開いて、xlsxで保存し直してください。`);
    }
    const dataStart = offset + 30 + readUint16(bytes, offset + 26) + readUint16(bytes, offset + 28);
    const stored = bytes.subarray(dataStart, dataStart + entry.size);
    let content;
    if (entry.method === ZIP_STORED) {
      content = stored;
    } else if (entry.method === ZIP_DEFLATED) {
      content = await inflate(stored);
    } else {
      throw new Error(`xlsxファイルの圧縮の形式（${entry.method}）に対応していません。Excelで開いて、xlsxで保存し直してください。`);
    }
    return new TextDecoder("utf-8").decode(content);
  }

  // ---- XML（xlsxの中の決まった形だけを読む） --------------------------------

  /** XMLの文字の参照（&amp; や &#12354; など）を戻す。 */
  function decodeXmlText(text) {
    return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name) => {
      if (name[0] === "#") {
        const code = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return String.fromCodePoint(code);
      }
      return Object.prototype.hasOwnProperty.call(XML_ENTITIES, name) ? XML_ENTITIES[name] : whole;
    });
  }

  /** タグの属性を { 名前: 値 } にする（名前空間の接頭辞は外す。r:id は id になる）。 */
  function attributesOf(text) {
    const attributes = {};
    const pattern = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1].includes(":") ? match[1].split(":").pop() : match[1];
      attributes[name] = decodeXmlText(match[3] !== undefined ? match[3] : match[4]);
    }
    return attributes;
  }

  /** 要素の中の <t> の文字をつなげる。ふりがな（<rPh>）は値ではないので外す。 */
  function textOfRuns(xml) {
    const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    let text = "";
    const pattern = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
    let match;
    while ((match = pattern.exec(withoutPhonetic)) !== null) {
      text += decodeXmlText(match[1] || "");
    }
    return text;
  }

  function sharedStringsOf(xml) {
    if (!xml) {
      return [];
    }
    const strings = [];
    const pattern = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
    let match;
    while ((match = pattern.exec(xml)) !== null) {
      strings.push(textOfRuns(match[1] || ""));
    }
    return strings;
  }

  /** セル番号の列の文字（A, B, …, AA）を0始まりの番号にする。 */
  function columnIndexOf(reference) {
    const letters = /^[A-Z]+/.exec(reference);
    if (!letters) {
      return -1;
    }
    let index = 0;
    for (const letter of letters[0]) {
      index = index * 26 + (letter.charCodeAt(0) - 64);
    }
    return index - 1;
  }

  /** セルの値を文字にする（共有文字列・文字・真偽・数値）。 */
  function cellValue(attributes, inner, sharedStrings) {
    const valueMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
    const raw = valueMatch ? decodeXmlText(valueMatch[1]) : "";
    switch (attributes.t) {
      case "s":
        return raw === "" ? "" : sharedStrings[Number(raw)] ?? "";
      case "inlineStr": {
        const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner);
        return inline ? textOfRuns(inline[1]) : "";
      }
      case "b":
        return raw === "1" ? "TRUE" : "FALSE";
      default:
        return raw;
    }
  }

  /** シートのXMLを行の一覧にする。 */
  function sheetRows(xml, sharedStrings) {
    const rows = [];
    const rowPattern = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
    let rowMatch;
    let previousLine = 0;
    while ((rowMatch = rowPattern.exec(xml)) !== null) {
      const rowAttributes = attributesOf(rowMatch[1]);
      const line = rowAttributes.r ? Number(rowAttributes.r) : previousLine + 1;
      previousLine = line;
      const cells = [];
      const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cellMatch;
      while ((cellMatch = cellPattern.exec(rowMatch[2] || "")) !== null) {
        const attributes = attributesOf(cellMatch[1]);
        const column = attributes.r ? columnIndexOf(attributes.r) : cells.length;
        while (cells.length < column) {
          cells.push("");
        }
        cells[column] = cellValue(attributes, cellMatch[2] || "", sharedStrings).trim();
      }
      if (cells.some((cell) => cell !== "")) {
        rows.push({ line, cells });
      }
    }
    return rows;
  }

  /** "worksheets/sheet1.xml" や "/xl/worksheets/sheet1.xml" を、ZIPの中の名前にする。 */
  function sheetPath(target) {
    if (target.startsWith("/")) {
      return target.slice(1);
    }
    return `xl/${target}`.replace(/\/\.\//g, "/");
  }

  /**
   * xlsxのバイト列（Uint8Array）を表にする。inflate は圧縮を戻す関数（省略するとブラウザの機能を使う）。
   */
  async function readXlsxBytes(bytes, inflate) {
    const inflateRaw = inflate || inflateWithStream;
    if (bytes.length < 4 || bytes[0] !== XLSX_SIGNATURE_BYTES[0] || bytes[1] !== XLSX_SIGNATURE_BYTES[1]) {
      throw new Error("xlsxファイルではありません。Excelで「Excel ブック（*.xlsx）」として保存したファイルを選んでください（古い .xls は読めません）。");
    }
    const entries = readZipDirectory(bytes);
    const workbook = await readZipText(bytes, entries, "xl/workbook.xml", inflateRaw);
    const relations = await readZipText(bytes, entries, "xl/_rels/workbook.xml.rels", inflateRaw);
    if (!workbook || !relations) {
      throw new Error("xlsxファイルにシートの情報がありません。Excelで開いて、xlsxで保存し直してください。");
    }
    const targets = new Map();
    for (const match of relations.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
      const attributes = attributesOf(match[1]);
      targets.set(attributes.Id, attributes.Target);
    }
    const properties = /<workbookPr\b([^>]*?)\/?>/.exec(workbook);
    const date1904Value = properties ? attributesOf(properties[1]).date1904 : undefined;
    const date1904 = date1904Value === "1" || date1904Value === "true";
    const sharedStrings = sharedStringsOf(await readZipText(bytes, entries, "xl/sharedStrings.xml", inflateRaw));

    const sheets = [];
    for (const match of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
      const attributes = attributesOf(match[1]);
      const target = targets.get(attributes.id);
      if (!target) {
        continue;
      }
      const xml = await readZipText(bytes, entries, sheetPath(target), inflateRaw);
      if (xml) {
        sheets.push({ name: attributes.name || `Sheet${sheets.length + 1}`, rows: sheetRows(xml, sharedStrings) });
      }
    }
    if (sheets.length === 0) {
      throw new Error("xlsxファイルにシートがありません。");
    }
    return { sheets, date1904 };
  }

  /** ファイル名の拡張子で、CSVかxlsxかを決める。どちらでもなければ null。 */
  function fileKindOf(fileName) {
    const lower = String(fileName).toLowerCase();
    if (lower.endsWith(".csv")) {
      return "csv";
    }
    if (lower.endsWith(".xlsx")) {
      return "xlsx";
    }
    return null;
  }

  /** ファイルのバイト列を表にする（拡張子で読み方を決める）。 */
  async function readTableBytes(fileName, bytes, inflate) {
    const kind = fileKindOf(fileName);
    if (kind === "csv") {
      return parseCsvText(decodeCsvBytes(bytes));
    }
    if (kind === "xlsx") {
      return readXlsxBytes(bytes, inflate);
    }
    throw new Error("読めるのは .csv と .xlsx のファイルです。Excelのファイルは「Excel ブック（*.xlsx）」で保存してください。");
  }

  ASC.tableReader = { splitCsvLine, parseCsvText, decodeCsvBytes, readXlsxBytes, readTableBytes, fileKindOf };
})(typeof window !== "undefined" ? window : globalThis);
