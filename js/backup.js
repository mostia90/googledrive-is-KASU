// ============================================================
//  保存・読み込み
//   .kasupack : 音源込みの完全バックアップ（別の Chromebook でもそのまま復元）
//   .json     : キューの並び・音量・フェード・開始終了位置だけ（軽量）
//
//  .kasupack の中身
//    [ "KASUPK01" 8byte ][ ヘッダ長 4byte LE ][ ヘッダ JSON ][ 音源1 ][ 音源2 ]...
// ============================================================

import { store } from "./store.js";
import { allCues, serializeProject } from "./project.js";

const MAGIC = "KASUPK01";

function u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 音源込みバックアップを書き出す */
export async function exportPack(project, onProgress) {
  const cues = allCues(project);
  const parts = [];
  const files = [];
  let i = 0;
  for (const cue of cues) {
    const blob = await store.getBlob(cue.id);
    if (blob) {
      files.push({ id: cue.id, bytes: blob.size, type: blob.type || "audio/mpeg" });
      parts.push(blob);
    }
    if (onProgress) onProgress(++i / Math.max(1, cues.length));
  }
  const header = JSON.stringify({
    version: 2,
    createdAt: new Date().toISOString(),
    project: serializeProject(project),
    files,
  });
  const headerBytes = new TextEncoder().encode(header);
  const blob = new Blob([MAGIC, u32le(headerBytes.length), headerBytes, ...parts],
    { type: "application/octet-stream" });
  download(blob, `kasu-backup-${stamp()}.kasupack`);
}

/** 音源込みバックアップを読み込む。生のプロジェクトを返す（呼び出し側で整形） */
export async function importPack(file) {
  const magic = new TextDecoder().decode(await file.slice(0, 8).arrayBuffer());
  if (magic !== MAGIC) throw new Error("このファイルは KASU Sound のバックアップではありません。");
  const lenBuf = await file.slice(8, 12).arrayBuffer();
  const headerLen = new DataView(lenBuf).getUint32(0, true);
  const headerJson = new TextDecoder().decode(await file.slice(12, 12 + headerLen).arrayBuffer());
  const header = JSON.parse(headerJson);

  let offset = 12 + headerLen;
  for (const f of header.files) {
    const blob = file.slice(offset, offset + f.bytes, f.type);
    await store.putBlob(f.id, blob);
    offset += f.bytes;
  }
  return header.project;
}

/** 設定だけ書き出す */
export function exportJson(project) {
  const data = { ...serializeProject(project), createdAt: new Date().toISOString() };
  download(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    `kasu-settings-${stamp()}.json`);
}

/**
 * 設定だけ読み込む。音源は端末に残っているものを ID、無ければファイル名で照合する。
 * 見つからなかったキューには missing 印を付けて返す。
 */
export async function importJson(file, currentProject) {
  const data = JSON.parse(await file.text());
  const hasLists = Array.isArray(data.lists);
  if (!hasLists && !Array.isArray(data.cues)) throw new Error("設定ファイルの形式が正しくありません。");

  const byName = new Map();
  for (const c of allCues(currentProject)) byName.set(c.fileName || c.name, c.id);
  const keys = new Set(await store.allBlobKeys());

  const relink = (c) => {
    if (keys.has(c.id)) return { ...c, missing: false };
    const alt = byName.get(c.fileName || c.name);
    if (alt) return { ...c, id: alt, missing: false };
    return { ...c, missing: true };
  };

  if (hasLists) {
    return {
      settings: data.settings,
      lists: data.lists.map((l) => ({ ...l, cues: (l.cues || []).map(relink) })),
    };
  }
  return { settings: data.settings, cues: data.cues.map(relink) };
}
