// ============================================================
//  プロジェクト（キューリストと設定）の形を決める場所
//  古い保存データを新しい形に直す処理もここにまとめています。
// ============================================================

import { DEFAULT_LISTS, DEFAULT_SETTINGS } from "./config.js";

export function newId() {
  return "c_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

export function normalizeCue(c, listId) {
  return {
    id: c.id,
    listId: listId || c.listId || DEFAULT_LISTS[0].id,
    name: c.name || c.fileName || "無題",
    fileName: c.fileName || "",
    mime: c.mime || "",
    size: c.size || 0,
    duration: c.duration || 0,
    volume: numOr(c.volume, 1),
    fadeIn: numOr(c.fadeIn, 0),
    fadeOut: numOr(c.fadeOut, 2),
    startSec: numOr(c.startSec, 0),
    endSec: Number.isFinite(c.endSec) && c.endSec > 0 ? c.endSec : null,
    mode: c.mode || "auto",
    driveId: c.driveId || null,
    // 以下は実行中だけ使う情報（保存しない）
    actualMode: null,
    missing: false,
  };
}

/**
 * どんな形の保存データでも、必ず
 *   { settings, lists:[{id,name,volume,cues:[...]}] }
 * に整えて返す。バージョン 1（リストが 1 本だけ）からの移行もここで行う。
 */
export function normalizeProject(raw) {
  const settings = { ...DEFAULT_SETTINGS, ...(raw?.settings || {}) };
  const lists = DEFAULT_LISTS.map((d) => {
    const saved = (raw?.lists || []).find((l) => l.id === d.id);
    return {
      id: d.id,
      name: (saved?.name || d.name).slice(0, 20),
      volume: numOr(saved?.volume, 1),
      cues: [],
    };
  });
  const byId = new Map(lists.map((l) => [l.id, l]));

  if (Array.isArray(raw?.lists) && raw.lists.some((l) => Array.isArray(l.cues))) {
    // 新しい形
    for (const src of raw.lists) {
      const target = byId.get(src.id) || lists[0];
      for (const c of src.cues || []) target.cues.push(normalizeCue(c, target.id));
    }
  } else if (Array.isArray(raw?.cues)) {
    // 古い形（リスト 1 本）→ listId があればそこへ、なければ 1 本目へ
    for (const c of raw.cues) {
      const target = byId.get(c.listId) || lists[0];
      target.cues.push(normalizeCue(c, target.id));
    }
  }
  return { settings, lists };
}

/** 保存用（実行時だけの情報を落とす） */
export function serializeProject(project) {
  return {
    version: 2,
    settings: project.settings,
    lists: project.lists.map((l) => ({
      id: l.id,
      name: l.name,
      volume: l.volume,
      cues: l.cues.map((c) => ({
        id: c.id, listId: c.listId, name: c.name, fileName: c.fileName, mime: c.mime,
        size: c.size, duration: c.duration, volume: c.volume,
        fadeIn: c.fadeIn, fadeOut: c.fadeOut, startSec: c.startSec, endSec: c.endSec,
        mode: c.mode, driveId: c.driveId,
      })),
    })),
  };
}

export function allCues(project) {
  return project.lists.flatMap((l) => l.cues);
}

export function findCue(project, cueId) {
  for (const list of project.lists) {
    const index = list.cues.findIndex((c) => c.id === cueId);
    if (index >= 0) return { cue: list.cues[index], list, index };
  }
  return null;
}

function numOr(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
