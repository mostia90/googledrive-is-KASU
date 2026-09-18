// ============================================================
//  KASU Sound — メイン
//  画面の組み立てとキーボード操作、各モジュールの接続を行います。
// ============================================================

import { DEFAULT_SETTINGS, GOOGLE_CONFIG } from "./config.js";
import { store } from "./store.js";
import { AudioEngine } from "./audio.js";
import * as drive from "./drive.js";
import * as backup from "./backup.js";

const $ = (id) => document.getElementById(id);
const engine = new AudioEngine();

/** アプリの状態 */
const state = {
  settings: { ...DEFAULT_SETTINGS },
  cues: [],
  selectedId: null,
  nextIndex: 0,
  lastVoiceId: null,
};

// ============================================================
//  1. 起動
// ============================================================
init();

async function init() {
  wireEvents();
  registerServiceWorker();

  const saved = await store.getProject().catch(() => null);
  if (saved) {
    state.settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
    state.cues = (saved.cues || []).map(normalizeCue);
  }
  // config.js に書いてあれば初期値として使う（設定画面の入力が優先）
  if (!state.settings.clientId) state.settings.clientId = GOOGLE_CONFIG.clientId || "";
  if (!state.settings.apiKey) state.settings.apiKey = GOOGLE_CONFIG.apiKey || "";

  applySettingsToUI();
  render();

  if (state.cues.length) {
    await prepareAll();
  }
  updateReadyBadge();

  engine.onChange = () => { renderVoices(); renderList(); };

  // 最初の操作で音声出力を起こす（ブラウザの自動再生制限への対応）
  const unlock = () => { engine.unlock(); window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);

  setInterval(tick, 100);
}

function normalizeCue(c) {
  return {
    id: c.id,
    name: c.name || c.fileName || "無題",
    fileName: c.fileName || "",
    mime: c.mime || "",
    size: c.size || 0,
    duration: c.duration || 0,
    volume: typeof c.volume === "number" ? c.volume : 1,
    fadeIn: typeof c.fadeIn === "number" ? c.fadeIn : 0,
    fadeOut: typeof c.fadeOut === "number" ? c.fadeOut : 2,
    mode: c.mode || "auto",
    driveId: c.driveId || null,
    actualMode: null,
    missing: false,
  };
}

function newId() {
  return "c_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// ============================================================
//  2. 保存
// ============================================================
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const data = {
      settings: state.settings,
      cues: state.cues.map((c) => ({
        id: c.id, name: c.name, fileName: c.fileName, mime: c.mime, size: c.size,
        duration: c.duration, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut,
        mode: c.mode, driveId: c.driveId,
      })),
    };
    try { await store.setProject(data); } catch (e) { toast("保存に失敗しました: " + e.message, true); }
  }, 250);
}

// ============================================================
//  3. 音源の取り込み
// ============================================================
async function addLocalFiles(fileList) {
  const files = [...fileList].filter((f) => /^audio\//.test(f.type) || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f.name));
  if (!files.length) { toast("音声ファイルが見つかりませんでした。", true); return; }

  busy(`取り込み中… 0 / ${files.length}`);
  let added = null;
  try {
    for (let i = 0; i < files.length; i++) {
      busy(`取り込み中… ${i + 1} / ${files.length}`);
      added = await addBlobAsCue(files[i], files[i].name, null);
    }
  } catch (e) {
    toast("取り込みに失敗しました: " + e.message, true);
  } finally {
    idle();
  }
  save(); render(); updateReadyBadge();
  if (added && state.settings.autoPlayOnSelect) playCue(added);
}

async function addFromDrive() {
  let picked;
  try {
    picked = await drive.pickFiles({ clientId: state.settings.clientId, apiKey: state.settings.apiKey });
  } catch (e) {
    toast(e.message, true);
    return;
  }
  if (!picked.length) return;

  busy(`Drive から取得中… 0 / ${picked.length}`);
  let added = null;
  try {
    for (let i = 0; i < picked.length; i++) {
      const f = picked[i];
      const blob = await drive.downloadFile(f.id, state.settings, (p) => {
        busy(`Drive から取得中… ${i + 1} / ${picked.length}（${Math.round(p * 100)}%）`);
      });
      busy(`読み込み中… ${i + 1} / ${picked.length}`);
      added = await addBlobAsCue(blob, f.name, f.id);
    }
    toast(`${picked.length} 件を取り込みました。以後はオフラインで再生できます。`);
  } catch (e) {
    toast("取り込みに失敗しました: " + e.message, true);
  } finally {
    idle();
  }
  save(); render(); updateReadyBadge();
  if (added && state.settings.autoPlayOnSelect) playCue(added);
}

async function addBlobAsCue(blob, fileName, driveId) {
  const cue = normalizeCue({
    id: newId(),
    name: fileName.replace(/\.[^.]+$/, ""),
    fileName,
    mime: blob.type,
    size: blob.size,
    fadeIn: state.settings.defaultFadeIn,
    fadeOut: state.settings.defaultFadeOut,
    driveId,
  });
  await store.putBlob(cue.id, blob);
  const info = await engine.prepare(cue, blob, state.settings.bufferThresholdSec);
  cue.duration = info.duration;
  cue.actualMode = info.mode;
  state.cues.push(cue);
  return cue;
}

/** 起動時：保存済みの音源をすべて再生可能な状態に戻す */
async function prepareAll() {
  busy("音源を準備中…");
  for (let i = 0; i < state.cues.length; i++) {
    const cue = state.cues[i];
    busy(`音源を準備中… ${i + 1} / ${state.cues.length}`);
    try {
      const blob = await store.getBlob(cue.id);
      if (!blob) { cue.missing = true; continue; }
      const info = await engine.prepare(cue, blob, state.settings.bufferThresholdSec);
      cue.duration = info.duration || cue.duration;
      cue.actualMode = info.mode;
      cue.missing = false;
    } catch (e) {
      cue.missing = true;
      console.warn("準備失敗", cue.name, e);
    }
  }
  idle();
  render();
}

async function reprepare(cue) {
  const blob = await store.getBlob(cue.id);
  if (!blob) { cue.missing = true; return; }
  busy("読み込み方式を変更中…");
  try {
    const info = await engine.prepare(cue, blob, state.settings.bufferThresholdSec);
    cue.duration = info.duration || cue.duration;
    cue.actualMode = info.mode;
  } finally { idle(); }
  render(); updateReadyBadge();
}

// ============================================================
//  4. 再生の操作
// ============================================================
function playCue(cue) {
  if (!cue) return;
  if (!engine.isReady(cue.id)) { toast(`「${cue.name}」はまだ準備できていません。`, true); return; }
  const id = engine.play(cue);
  if (id) state.lastVoiceId = id;
  render();
}

/** GO：NEXT のキューを再生して、ポインタを 1 つ進める */
function go() {
  const cue = state.cues[state.nextIndex];
  if (!cue) { toast("再生できるキューがありません。"); return; }
  playCue(cue);
  state.nextIndex = Math.min(state.nextIndex + 1, state.cues.length);
  state.selectedId = state.cues[state.nextIndex]?.id || cue.id;
  render();
}

function stopAll() {
  engine.stopAll(state.settings.stopAllFadeSec);
  render();
}

function currentVoice() {
  const list = engine.activeVoices();
  if (!list.length) return null;
  return list.find((v) => v.id === state.lastVoiceId) || list[list.length - 1];
}

function cueById(id) { return state.cues.find((c) => c.id === id) || null; }
function selectedCue() { return cueById(state.selectedId); }

function selectCue(id, { fromClick = false } = {}) {
  state.selectedId = id;
  const idx = state.cues.findIndex((c) => c.id === id);
  if (idx >= 0) state.nextIndex = idx;
  render();
  if (fromClick && state.settings.autoPlayOnSelect) {
    playCue(cueById(id));
    state.nextIndex = Math.min(idx + 1, state.cues.length);
    render();
  }
}

// ============================================================
//  5. 画面の描画
// ============================================================
function render() { renderList(); renderNowPlaying(); renderVoices(); renderEditor(); renderNext(); }

function renderList() {
  const ul = $("cuelist");
  const playingCueIds = new Set(engine.activeVoices().map((v) => v.cueId));
  ul.innerHTML = "";
  state.cues.forEach((cue, i) => {
    const li = document.createElement("li");
    li.className = "cue";
    li.draggable = true;
    li.dataset.id = cue.id;
    if (cue.id === state.selectedId) li.classList.add("selected");
    if (i === state.nextIndex) li.classList.add("is-next");
    if (playingCueIds.has(cue.id)) li.classList.add("is-playing");

    const flags = [];
    if (playingCueIds.has(cue.id)) flags.push('<span class="flag flag-play">再生中</span>');
    if (i === state.nextIndex) flags.push('<span class="flag">NEXT</span>');
    if (cue.missing) flags.push('<span class="flag flag-ng">音源なし</span>');
    else if (!engine.isReady(cue.id)) flags.push('<span class="flag flag-wait">準備中</span>');

    li.innerHTML = `
      <span class="cue-num">${String(i + 1).padStart(2, "0")}</span>
      <span class="cue-body">
        <span class="cue-name">${escapeHtml(cue.name)}</span>
        <span class="cue-meta">
          <span>${fmtTime(cue.duration)}</span>
          <span>${Math.round((cue.volume ?? 1) * 100)}%</span>
          ${cue.fadeOut ? `<span>FO ${cue.fadeOut}s</span>` : ""}
        </span>
      </span>
      <span class="cue-flags">${flags.join("")}</span>`;

    li.addEventListener("click", () => selectCue(cue.id, { fromClick: true }));
    li.addEventListener("dblclick", () => playCue(cue));
    ul.appendChild(li);
  });

  $("empty-hint").hidden = state.cues.length > 0;
  $("cue-count").textContent = `${state.cues.length} キュー`;
}

function renderNowPlaying() {
  const v = currentVoice();
  if (!v) {
    $("np-name").textContent = "—";
    $("np-time").textContent = "00:00 / 00:00";
    $("np-bar").style.width = "0%";
    return;
  }
  const cue = cueById(v.cueId);
  $("np-name").textContent = cue ? cue.name : "—";
  $("np-time").textContent = `${fmtTime(v.position)} / ${fmtTime(v.duration)}`;
  $("np-bar").style.width = v.duration ? Math.min(100, (v.position / v.duration) * 100) + "%" : "0%";
}

function renderVoices() {
  const ul = $("voices");
  const list = engine.activeVoices();
  ul.innerHTML = "";
  $("voices-empty").hidden = list.length > 0;
  for (const v of list) {
    const cue = cueById(v.cueId);
    const li = document.createElement("li");
    li.className = "voice";
    li.innerHTML = `
      <span class="voice-name">${escapeHtml(cue ? cue.name : "?")}</span>
      <span class="voice-time">${fmtTime(v.position)}</span>
      <button class="btn btn-sm" data-fade="${v.id}">FO</button>
      <button class="btn btn-sm btn-danger" data-stop="${v.id}">停止</button>`;
    ul.appendChild(li);
  }
  ul.querySelectorAll("[data-stop]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); engine.stopVoice(b.dataset.stop, 0.05); render(); }));
  ul.querySelectorAll("[data-fade]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const voice = engine.voices.get(b.dataset.fade);
      const cue = voice ? cueById(voice.cueId) : null;
      engine.stopVoice(b.dataset.fade, cue?.fadeOut ?? state.settings.defaultFadeOut);
      render();
    }));
}

function renderEditor() {
  const cue = selectedCue();
  const box = $("cue-editor");
  if (!cue) { box.hidden = true; return; }
  box.hidden = false;
  $("ce-name").textContent = cue.name;
  const info = engine.info(cue.id);
  const modeLabel = cue.missing ? "音源なし"
    : info?.mode === "buffer" ? "メモリ展開（遅延ほぼゼロ）"
    : info?.mode === "stream" ? "ストリーミング" : "未準備";
  $("ce-file").textContent = `${cue.fileName || "-"} ／ ${fmtBytes(cue.size)} ／ ${fmtTime(cue.duration)} ／ ${modeLabel}`;
  $("ce-vol").value = Math.round((cue.volume ?? 1) * 100);
  $("ce-vol-val").textContent = Math.round((cue.volume ?? 1) * 100) + "%";
  $("ce-fadein").value = cue.fadeIn ?? 0;
  $("ce-fadeout").value = cue.fadeOut ?? 0;
  $("ce-mode").value = cue.mode || "auto";
  $("ce-mode-note").textContent = info?.mode === "buffer"
    ? `メモリ使用量 約 ${fmtBytes(info.bytes)}`
    : "長い曲は自動でストリーミングになります（メモリ節約）。";
}

function renderNext() {
  const cue = state.cues[state.nextIndex];
  $("next-name").textContent = cue ? `${String(state.nextIndex + 1).padStart(2, "0")}  ${cue.name}` : "— （最後まで進みました）";
}

function updateReadyBadge() {
  const badge = $("ready-badge");
  const total = state.cues.length;
  const ready = state.cues.filter((c) => engine.isReady(c.id)).length;
  const lat = engine.outputLatencyMs;
  if (!total) { badge.className = "badge badge-wait"; badge.textContent = "音源なし"; return; }
  if (ready === total) {
    badge.className = "badge badge-ok";
    badge.textContent = `オフライン準備OK ${ready}/${total}${lat != null ? `（出力遅延 約${lat}ms）` : ""}`;
  } else {
    badge.className = "badge badge-ng";
    badge.textContent = `準備できていません ${ready}/${total}`;
  }
}

function tick() {
  const v = currentVoice();
  if (v) renderNowPlaying();
  const times = $("voices").querySelectorAll(".voice-time");
  const list = engine.activeVoices();
  times.forEach((el, i) => { if (list[i]) el.textContent = fmtTime(list[i].position); });
}

// ============================================================
//  6. イベント登録
// ============================================================
function wireEvents() {
  // --- 取り込み ---
  $("btn-local").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", (e) => { addLocalFiles(e.target.files); e.target.value = ""; });
  $("btn-drive").addEventListener("click", addFromDrive);

  const zone = $("drop-zone");
  ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault(); zone.classList.add("dragover");
  }));
  ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault(); if (ev === "dragleave" && zone.contains(e.relatedTarget)) return;
    zone.classList.remove("dragover");
  }));
  zone.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) addLocalFiles(e.dataTransfer.files); });

  // --- リスト操作 ---
  $("btn-up").addEventListener("click", () => moveSelected(-1));
  $("btn-down").addEventListener("click", () => moveSelected(1));
  $("btn-rename").addEventListener("click", renameSelected);
  $("btn-remove").addEventListener("click", removeSelected);
  enableDragReorder();

  // --- トランスポート ---
  $("btn-go").addEventListener("click", () => { go(); blurActive(); });
  $("btn-stopall").addEventListener("click", () => { stopAll(); blurActive(); });
  $("btn-stop-current").addEventListener("click", () => {
    const v = currentVoice(); if (v) engine.stopVoice(v.id, 0.05); render(); blurActive();
  });
  $("btn-fade-current").addEventListener("click", () => {
    const v = currentVoice(); if (!v) return;
    const cue = cueById(v.cueId);
    engine.stopVoice(v.id, cue?.fadeOut ?? state.settings.defaultFadeOut);
    render(); blurActive();
  });

  $("chk-autoplay").addEventListener("change", (e) => {
    state.settings.autoPlayOnSelect = e.target.checked;
    $("set-autoplay").checked = e.target.checked;
    save();
  });
  $("master-vol").addEventListener("input", (e) => {
    const v = Number(e.target.value) / 100;
    state.settings.masterVolume = v;
    engine.setMasterVolume(v);
    $("master-val").textContent = Math.round(v * 100) + "%";
    save();
  });

  // --- キュー設定 ---
  $("ce-vol").addEventListener("input", (e) => {
    const cue = selectedCue(); if (!cue) return;
    cue.volume = Number(e.target.value) / 100;
    $("ce-vol-val").textContent = Math.round(cue.volume * 100) + "%";
    engine.setCueVolume(cue.id, cue.volume);
    renderList(); save();
  });
  $("ce-fadein").addEventListener("change", (e) => {
    const cue = selectedCue(); if (!cue) return;
    cue.fadeIn = Math.max(0, Number(e.target.value) || 0); save();
  });
  $("ce-fadeout").addEventListener("change", (e) => {
    const cue = selectedCue(); if (!cue) return;
    cue.fadeOut = Math.max(0, Number(e.target.value) || 0); renderList(); save();
  });
  $("ce-mode").addEventListener("change", async (e) => {
    const cue = selectedCue(); if (!cue) return;
    cue.mode = e.target.value; save();
    await reprepare(cue);
  });
  $("btn-preview").addEventListener("click", () => { playCue(selectedCue()); blurActive(); });
  $("btn-set-next").addEventListener("click", () => {
    const idx = state.cues.findIndex((c) => c.id === state.selectedId);
    if (idx >= 0) { state.nextIndex = idx; render(); }
    blurActive();
  });

  // --- 設定ダイアログ ---
  $("btn-settings").addEventListener("click", async () => { await refreshStorageInfo(); $("dlg-settings").showModal(); });
  $("set-autoplay").addEventListener("change", (e) => {
    state.settings.autoPlayOnSelect = e.target.checked; $("chk-autoplay").checked = e.target.checked; save();
  });
  $("set-fadein").addEventListener("change", (e) => { state.settings.defaultFadeIn = num(e.target.value, 0); save(); });
  $("set-fadeout").addEventListener("change", (e) => { state.settings.defaultFadeOut = num(e.target.value, 2); save(); });
  $("set-threshold").addEventListener("change", async (e) => {
    state.settings.bufferThresholdSec = num(e.target.value, 60);
    save();
    await prepareAll();   // 方式が変わるので全部読み込み直す
    updateReadyBadge();
  });
  $("set-client-id").addEventListener("change", (e) => { state.settings.clientId = e.target.value.trim(); save(); });
  $("set-api-key").addEventListener("change", (e) => { state.settings.apiKey = e.target.value.trim(); save(); });

  $("btn-export-pack").addEventListener("click", async () => {
    busy("バックアップを作成中…");
    try { await backup.exportPack(state, (p) => busy(`バックアップを作成中… ${Math.round(p * 100)}%`)); }
    catch (e) { toast("書き出しに失敗: " + e.message, true); }
    finally { idle(); }
  });
  $("btn-import-pack").addEventListener("click", () => $("pack-input").click());
  $("pack-input").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    if (!confirm("現在のキューリストを置き換えます。よろしいですか？")) return;
    busy("バックアップを読み込み中…");
    try {
      const p = await backup.importPack(file);
      state.settings = { ...DEFAULT_SETTINGS, ...p.settings };
      state.cues = (p.cues || []).map(normalizeCue);
      state.nextIndex = 0; state.selectedId = state.cues[0]?.id || null;
      applySettingsToUI(); save();
      await prepareAll(); updateReadyBadge();
      toast("バックアップを復元しました。");
    } catch (err) { toast("読み込みに失敗: " + err.message, true); }
    finally { idle(); }
  });
  $("btn-export-json").addEventListener("click", () => backup.exportJson(state));
  $("btn-import-json").addEventListener("click", () => $("json-input").click());
  $("json-input").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    try {
      const p = await backup.importJson(file, state);
      state.settings = { ...DEFAULT_SETTINGS, ...p.settings };
      state.cues = p.cues.map(normalizeCue);
      applySettingsToUI(); save();
      await prepareAll(); updateReadyBadge();
      const missing = state.cues.filter((c) => c.missing).length;
      toast(missing ? `読み込みました（音源が見つからないキューが ${missing} 件あります）` : "設定を読み込みました。");
    } catch (err) { toast("読み込みに失敗: " + err.message, true); }
  });

  $("btn-persist").addEventListener("click", async () => {
    const ok = await store.persist();
    toast(ok ? "保存領域を保護しました（自動削除されにくくなります）。" : "保護を有効にできませんでした。", !ok);
    refreshStorageInfo();
  });
  $("btn-update-app").addEventListener("click", async () => {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
    toast("更新を確認しました。ページを再読み込みします。");
    setTimeout(() => location.reload(), 900);
  });

  // --- キーボード ---
  document.addEventListener("keydown", onKeyDown);

  // --- 再生中の誤操作防止 ---
  window.addEventListener("beforeunload", (e) => {
    if (engine.activeVoices().length) { e.preventDefault(); e.returnValue = ""; }
  });
}

function onKeyDown(e) {
  const t = e.target;
  const typing = t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
  const dialogOpen = $("dlg-settings").open;

  if (e.code === "Escape" && !dialogOpen) { e.preventDefault(); stopAll(); return; }
  if (typing || dialogOpen) return;

  switch (e.code) {
    case "Space":
      e.preventDefault(); go(); break;
    case "ArrowDown":
      e.preventDefault(); moveNext(1); break;
    case "ArrowUp":
      e.preventDefault(); moveNext(-1); break;
    case "Enter":
      e.preventDefault(); playCue(selectedCue()); break;
    case "Home":
      e.preventDefault();
      state.nextIndex = 0;
      state.selectedId = state.cues[0]?.id || null;
      render();
      document.querySelector(".cue.is-next")?.scrollIntoView({ block: "nearest" });
      break;
    case "KeyF": {
      e.preventDefault();
      const v = currentVoice(); if (!v) break;
      const cue = cueById(v.cueId);
      engine.stopVoice(v.id, cue?.fadeOut ?? state.settings.defaultFadeOut);
      render(); break;
    }
  }
}

function moveNext(delta) {
  if (!state.cues.length) return;
  state.nextIndex = Math.min(state.cues.length - 1, Math.max(0, state.nextIndex + delta));
  state.selectedId = state.cues[state.nextIndex].id;
  render();
  document.querySelector(".cue.is-next")?.scrollIntoView({ block: "nearest" });
}

function moveSelected(delta) {
  const i = state.cues.findIndex((c) => c.id === state.selectedId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= state.cues.length) return;
  [state.cues[i], state.cues[j]] = [state.cues[j], state.cues[i]];
  state.nextIndex = j;
  render(); save();
}

function renameSelected() {
  const cue = selectedCue(); if (!cue) return;
  const name = prompt("キュー名", cue.name);
  if (name == null) return;
  cue.name = name.trim() || cue.name;
  render(); save();
}

async function removeSelected() {
  const cue = selectedCue(); if (!cue) return;
  if (!confirm(`「${cue.name}」を削除しますか？`)) return;
  engine.unload(cue.id);
  await store.deleteBlob(cue.id).catch(() => {});
  state.cues = state.cues.filter((c) => c.id !== cue.id);
  state.selectedId = state.cues[0]?.id || null;
  state.nextIndex = Math.min(state.nextIndex, Math.max(0, state.cues.length - 1));
  render(); save(); updateReadyBadge();
}

function enableDragReorder() {
  const ul = $("cuelist");
  let dragId = null;
  ul.addEventListener("dragstart", (e) => {
    const li = e.target.closest(".cue"); if (!li) return;
    dragId = li.dataset.id; li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  ul.addEventListener("dragend", () => {
    dragId = null;
    ul.querySelectorAll(".cue").forEach((el) => el.classList.remove("dragging", "drag-over"));
  });
  ul.addEventListener("dragover", (e) => {
    e.preventDefault();
    const li = e.target.closest(".cue"); if (!li) return;
    ul.querySelectorAll(".cue").forEach((el) => el.classList.remove("drag-over"));
    li.classList.add("drag-over");
  });
  ul.addEventListener("drop", (e) => {
    e.preventDefault();
    const li = e.target.closest(".cue");
    if (!li || !dragId) return;
    const from = state.cues.findIndex((c) => c.id === dragId);
    const to = state.cues.findIndex((c) => c.id === li.dataset.id);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = state.cues.splice(from, 1);
    state.cues.splice(to, 0, moved);
    state.selectedId = moved.id;
    render(); save();
  });
}

// ============================================================
//  7. 設定と画面の同期・小物
// ============================================================
function applySettingsToUI() {
  const s = state.settings;
  $("chk-autoplay").checked = s.autoPlayOnSelect;
  $("set-autoplay").checked = s.autoPlayOnSelect;
  $("master-vol").value = Math.round(s.masterVolume * 100);
  $("master-val").textContent = Math.round(s.masterVolume * 100) + "%";
  $("set-fadein").value = s.defaultFadeIn;
  $("set-fadeout").value = s.defaultFadeOut;
  $("set-threshold").value = s.bufferThresholdSec;
  $("set-client-id").value = s.clientId || "";
  $("set-api-key").value = s.apiKey || "";
  engine.setMasterVolume(s.masterVolume);
}

async function refreshStorageInfo() {
  const est = await store.estimate();
  const persisted = await store.isPersisted();
  const mem = engine.memoryBytes();
  const parts = [];
  if (est) parts.push(`保存容量 ${fmtBytes(est.usage || 0)} / 使用可能 ${fmtBytes(est.quota || 0)}`);
  parts.push(`メモリ展開 ${fmtBytes(mem)}`);
  parts.push(persisted ? "保存領域は保護済み" : "保存領域は未保護");
  $("storage-info").textContent = parts.join(" ／ ");
  $("btn-persist").disabled = persisted;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW 登録失敗", e));
  });
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " err" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3500);
}

function busy(text) { $("busy-text").textContent = text; $("busy").hidden = false; }
function idle() { $("busy").hidden = true; }
function blurActive() { document.activeElement?.blur?.(); }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "00:00";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
