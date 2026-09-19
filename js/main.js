// ============================================================
//  KASU Sound — メイン
//  画面の組み立てとキーボード操作、各モジュールの接続を行います。
// ============================================================

import { DEFAULT_SETTINGS, DEFAULT_LISTS, LIST_KEYS, GOOGLE_CONFIG } from "./config.js";
import { store } from "./store.js";
import { AudioEngine } from "./audio.js";
import * as drive from "./drive.js";
import * as backup from "./backup.js";
import { newId, normalizeCue, normalizeProject, serializeProject, allCues, findCue } from "./project.js";

const $ = (id) => document.getElementById(id);
const engine = new AudioEngine();

/** アプリの状態 */
const state = {
  settings: { ...DEFAULT_SETTINGS },
  lists: [],
  nextIndex: {},                       // listId -> 次に鳴らすキューの位置
  focusedList: DEFAULT_LISTS[0].id,    // Space が作用するリスト
  selectedId: null,                    // 下の設定欄に出ているキュー
  lastVoiceId: null,
  previewId: null,                     // 試聴中の音
  edPos: 0,                            // 試聴バーの現在位置（秒）
};

const project = () => ({ settings: state.settings, lists: state.lists });
const listById = (id) => state.lists.find((l) => l.id === id) || state.lists[0];
const listIndex = (id) => state.lists.findIndex((l) => l.id === id);
const cueById = (id) => findCue(project(), id)?.cue || null;
const selectedCue = () => (state.selectedId ? cueById(state.selectedId) : null);
const paneOf = (listId) => document.querySelector(`.list-pane[data-list="${listId}"]`);

// ============================================================
//  1. 起動
// ============================================================
init();

async function init() {
  wireStaticEvents();
  registerServiceWorker();

  const saved = await store.getProject().catch(() => null);
  const p = normalizeProject(saved);
  state.settings = p.settings;
  state.lists = p.lists;
  for (const l of state.lists) state.nextIndex[l.id] = 0;

  // config.js に書いてあれば初期値として使う（設定画面の入力が優先）
  if (!state.settings.clientId) state.settings.clientId = GOOGLE_CONFIG.clientId || "";
  if (!state.settings.apiKey) state.settings.apiKey = GOOGLE_CONFIG.apiKey || "";

  buildPanes();
  applySettingsToUI();
  render();

  if (allCues(project()).length) await prepareAll();
  updateReadyBadge();

  engine.onChange = () => { renderVoices(); renderLists(); };

  // 最初の操作で音声出力を起こす（ブラウザの自動再生制限への対応）
  const unlock = () => {
    engine.unlock();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);

  setInterval(tick, 100);
}

// ============================================================
//  2. 保存
// ============================================================
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await store.setProject(serializeProject(project())); }
    catch (e) { toast("保存に失敗しました: " + e.message, true); }
  }, 250);
}

// ============================================================
//  3. 音源の取り込み
// ============================================================
async function addLocalFiles(fileList, listId) {
  const target = listId || state.focusedList;
  const files = [...fileList].filter((f) => /^audio\//.test(f.type) || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f.name));
  if (!files.length) { toast("音声ファイルが見つかりませんでした。", true); return; }

  busy(`取り込み中… 0 / ${files.length}`);
  let added = null;
  try {
    for (let i = 0; i < files.length; i++) {
      busy(`取り込み中… ${i + 1} / ${files.length}`);
      added = await addBlobAsCue(files[i], files[i].name, null, target);
    }
    toast(`「${listById(target).name}」に ${files.length} 件を追加しました。`);
  } catch (e) {
    toast("取り込みに失敗しました: " + e.message, true);
  } finally {
    idle();
  }
  save(); render(); updateReadyBadge();
  if (added && state.settings.autoPlayOnSelect) playCue(added);
}

async function addFromDrive() {
  const target = state.focusedList;
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
      const blob = await drive.downloadFile(f.id, state.settings, (pr) => {
        busy(`Drive から取得中… ${i + 1} / ${picked.length}（${Math.round(pr * 100)}%）`);
      });
      busy(`読み込み中… ${i + 1} / ${picked.length}`);
      added = await addBlobAsCue(blob, f.name, f.id, target);
    }
    toast(`「${listById(target).name}」に ${picked.length} 件を取り込みました。以後はオフラインで再生できます。`);
  } catch (e) {
    toast("取り込みに失敗しました: " + e.message, true);
  } finally {
    idle();
  }
  save(); render(); updateReadyBadge();
  if (added && state.settings.autoPlayOnSelect) playCue(added);
}

async function addBlobAsCue(blob, fileName, driveId, listId) {
  const cue = normalizeCue({
    id: newId(),
    name: fileName.replace(/\.[^.]+$/, ""),
    fileName,
    mime: blob.type,
    size: blob.size,
    fadeIn: state.settings.defaultFadeIn,
    fadeOut: state.settings.defaultFadeOut,
    driveId,
  }, listId);
  await store.putBlob(cue.id, blob);
  const info = await engine.prepare(cue, blob, state.settings.bufferThresholdSec);
  cue.duration = info.duration;
  cue.actualMode = info.mode;
  listById(listId).cues.push(cue);
  return cue;
}

/** 起動時：保存済みの音源をすべて再生可能な状態に戻す */
async function prepareAll() {
  const cues = allCues(project());
  busy("音源を準備中…");
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    busy(`音源を準備中… ${i + 1} / ${cues.length}`);
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
  for (const l of state.lists) engine.setGroupVolume(l.id, l.volume);
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
function playCue(cue, opts) {
  if (!cue) return;
  if (!engine.isReady(cue.id)) { toast(`「${cue.name}」はまだ準備できていません。`, true); return; }
  const id = engine.play(cue, opts);
  if (id) state.lastVoiceId = id;
  render();
}

/** GO：そのリストの NEXT を再生して、ポインタを 1 つ進める */
function go(listId) {
  const list = listById(listId);
  const i = state.nextIndex[list.id] ?? 0;
  const cue = list.cues[i];
  if (!cue) { toast(`「${list.name}」は最後まで進んでいます（Home で先頭へ）。`); return; }
  playCue(cue);
  state.nextIndex[list.id] = Math.min(i + 1, list.cues.length);
  state.focusedList = list.id;
  render();
}

function stopAll() {
  engine.stopAll(state.settings.stopAllFadeSec);
  state.previewId = null;
  render();
}

function currentVoice() {
  const list = engine.activeVoices().filter((v) => v.id !== state.previewId);
  if (!list.length) return null;
  return list.find((v) => v.id === state.lastVoiceId) || list[list.length - 1];
}

function selectCue(id, { fromClick = false } = {}) {
  const found = findCue(project(), id);
  if (!found) return;
  state.selectedId = id;
  state.focusedList = found.list.id;
  state.nextIndex[found.list.id] = found.index;
  state.edPos = found.cue.startSec || 0;
  stopPreview();
  render();
  if (fromClick && state.settings.autoPlayOnSelect) {
    playCue(found.cue);
    state.nextIndex[found.list.id] = Math.min(found.index + 1, found.list.cues.length);
    render();
  }
}

// ---------- 試聴（開始／終了位置を決めるため、トリムもフェードも無視して鳴らす） ----------
function startPreview(fromSec) {
  const cue = selectedCue();
  if (!cue) return;
  if (!engine.isReady(cue.id)) { toast("まだ準備できていません。", true); return; }
  stopPreview();
  const from = fromSec != null ? fromSec : state.edPos;
  state.previewId = engine.play(cue, { ignoreTrim: true, noFade: true, offset: from });
  state.edPos = from;
  renderEditor();
}

function stopPreview() {
  if (!state.previewId) return;
  engine.stopVoice(state.previewId, 0.03);
  state.previewId = null;
}

// ============================================================
//  5. 画面の描画
// ============================================================
function buildPanes() {
  const root = $("lists");
  root.innerHTML = "";
  state.lists.forEach((list, i) => {
    const pane = document.createElement("section");
    pane.className = "list-pane";
    pane.dataset.list = list.id;
    pane.style.setProperty("--pane-color", `var(--list-${i + 1})`);
    pane.innerHTML = `
      <div class="list-head">
        <span class="list-num">${"①②③"[i] || ""}</span>
        <input class="list-name" data-name maxlength="20" value="${escapeHtml(list.name)}">
        <button class="list-key" data-act="go" type="button"
          title="クリック、または ${LIST_KEYS[i]?.label || ""} キーでこのリストの NEXT を再生">${LIST_KEYS[i]?.label || ""}</button>
      </div>
      <div class="list-next"><span class="nx">NEXT</span><span class="nm" data-next>—</span></div>
      <ol class="cuelist" data-cuelist></ol>
      <div class="list-tools">
        <button class="btn btn-sm" data-act="up" type="button" title="選択中のキューを上へ">↑</button>
        <button class="btn btn-sm" data-act="down" type="button" title="選択中のキューを下へ">↓</button>
        <button class="btn btn-sm" data-act="rename" type="button">名前</button>
        <button class="btn btn-sm btn-danger" data-act="remove" type="button">削除</button>
      </div>
      <div class="list-foot">
        <span class="gv">音量
          <input type="range" min="0" max="150" step="1" value="${Math.round(list.volume * 100)}" data-gv>
          <b data-gvval>${Math.round(list.volume * 100)}%</b>
        </span>
        <button class="btn btn-sm" data-act="stoplist" type="button">停止</button>
      </div>`;
    root.appendChild(pane);
  });
  wirePanes();
  renderKeyHints();
  renderListSelect();
}

function render() { renderLists(); renderVoices(); renderEditor(); }

function renderLists() {
  const playing = new Set(engine.activeVoices().filter((v) => v.id !== state.previewId).map((v) => v.cueId));
  state.lists.forEach((list) => {
    const pane = paneOf(list.id);
    if (!pane) return;
    pane.classList.toggle("focused", list.id === state.focusedList);

    const ni = state.nextIndex[list.id] ?? 0;
    const nextCue = list.cues[ni];
    setText(pane.querySelector("[data-next]"),
      nextCue ? `${String(ni + 1).padStart(2, "0")}  ${nextCue.name}` : "— 最後まで進みました");

    // 並びが変わったときだけ作り直し、それ以外は中身だけ書き換える。
    // （毎回作り直すと、クリックの押下～離すの間に要素が入れ替わって
    //   クリックが成立しなくなるため）
    const ol = pane.querySelector("[data-cuelist]");
    const ids = list.cues.map((c) => c.id).join(",");
    if (ol.dataset.ids !== ids) {
      ol.dataset.ids = ids;
      ol.innerHTML = "";
      for (const cue of list.cues) ol.appendChild(createCueItem(cue));
    }
    list.cues.forEach((cue, i) => updateCueItem(ol.children[i], cue, i, ni, playing));
  });
  $("empty-hint").hidden = allCues(project()).length > 0;
}

function createCueItem(cue) {
  const li = document.createElement("li");
  li.className = "cue";
  li.draggable = true;
  li.dataset.id = cue.id;
  li.innerHTML = `
    <span class="cue-num"></span>
    <span class="cue-body">
      <span class="cue-name"></span>
      <span class="cue-meta"><span data-len></span><span data-vol></span><span data-trim></span></span>
    </span>
    <span class="cue-flags">
      <span class="flag flag-play" data-fplay hidden>再生中</span>
      <span class="flag" data-fnext hidden>NEXT</span>
      <span class="flag" data-fstat hidden></span>
    </span>`;
  return li;
}

function updateCueItem(li, cue, i, ni, playing) {
  if (!li) return;
  const isPlaying = playing.has(cue.id);
  li.classList.toggle("selected", cue.id === state.selectedId);
  li.classList.toggle("is-next", i === ni);
  li.classList.toggle("is-playing", isPlaying);
  setText(li.querySelector(".cue-num"), String(i + 1).padStart(2, "0"));
  setText(li.querySelector(".cue-name"), cue.name);
  setText(li.querySelector("[data-len]"), fmtLen(playLength(cue)));
  setText(li.querySelector("[data-vol]"), Math.round((cue.volume ?? 1) * 100) + "%");
  setText(li.querySelector("[data-trim]"), (cue.startSec > 0 || cue.endSec) ? "✂" : "");
  li.querySelector("[data-fplay]").hidden = !isPlaying;
  li.querySelector("[data-fnext]").hidden = i !== ni;

  const stat = li.querySelector("[data-fstat]");
  if (cue.missing) { stat.hidden = false; stat.className = "flag flag-ng"; setText(stat, "音源なし"); }
  else if (!engine.isReady(cue.id)) { stat.hidden = false; stat.className = "flag flag-wait"; setText(stat, "準備中"); }
  else stat.hidden = true;
}

function setText(el, t) { if (el && el.textContent !== t) el.textContent = t; }

function renderVoices() {
  const ul = $("voices");
  const list = engine.activeVoices().filter((v) => v.id !== state.previewId);
  ul.innerHTML = "";
  $("voices-empty").hidden = list.length > 0;
  for (const v of list) {
    const cue = cueById(v.cueId);
    const li = document.createElement("li");
    li.className = "voice";
    li.style.setProperty("--vcolor", `var(--list-${listIndex(v.listId) + 1})`);
    li.innerHTML = `
      <span class="voice-name">${escapeHtml(cue ? cue.name : "?")}</span>
      <span class="voice-time" data-vtime>${fmtTime(v.position)} / ${fmtTime(v.end)}</span>
      <button class="btn btn-sm" data-fade="${v.id}" type="button">FO</button>
      <button class="btn btn-sm btn-danger" data-stop="${v.id}" type="button">停止</button>`;
    ul.appendChild(li);
  }
  ul.querySelectorAll("[data-stop]").forEach((b) =>
    b.addEventListener("click", () => { engine.stopVoice(b.dataset.stop, 0.05); render(); blurActive(); }));
  ul.querySelectorAll("[data-fade]").forEach((b) =>
    b.addEventListener("click", () => { fadeVoice(b.dataset.fade); blurActive(); }));
}

function fadeVoice(voiceId) {
  const v = engine.voices.get(voiceId);
  const cue = v ? cueById(v.cueId) : null;
  engine.stopVoice(voiceId, cue?.fadeOut ?? state.settings.defaultFadeOut);
  render();
}

function renderEditor() {
  const cue = selectedCue();
  const ed = $("editor");
  if (!cue) {
    $("ed-name").textContent = "—";
    $("ed-file").textContent = "キューをクリックすると、ここで音量・フェード・開始／終了位置を調整できます";
    ed.classList.add("empty");
    return;
  }
  ed.classList.remove("empty");
  const info = engine.info(cue.id);
  const modeLabel = cue.missing ? "音源なし"
    : info?.mode === "buffer" ? "メモリ展開（遅延ほぼゼロ）"
    : info?.mode === "stream" ? "ストリーミング" : "未準備";
  $("ed-name").textContent = cue.name;
  $("ed-file").textContent = `${cue.fileName || "-"} ／ ${fmtBytes(cue.size)} ／ 全長 ${fmtTime(cue.duration)} ／ ${modeLabel}`;

  $("ed-vol").value = Math.round((cue.volume ?? 1) * 100);
  $("ed-vol-val").textContent = Math.round((cue.volume ?? 1) * 100) + "%";
  $("ed-fadein").value = cue.fadeIn ?? 0;
  $("ed-fadeout").value = cue.fadeOut ?? 0;
  $("ed-mode").value = cue.mode || "auto";
  $("ed-list").value = cue.listId;
  $("ed-mode-note").textContent = info?.mode === "buffer"
    ? `メモリ使用量 約 ${fmtBytes(info.bytes)}`
    : "長い曲は自動でストリーミングになります（メモリ節約）。";

  if (document.activeElement !== $("ed-start")) $("ed-start").value = fmtPrecise(cue.startSec || 0);
  if (document.activeElement !== $("ed-end")) $("ed-end").value = cue.endSec ? fmtPrecise(cue.endSec) : "—";
  $("ed-pos").textContent = fmtPrecise(state.edPos);
  $("btn-preview").textContent = state.previewId ? "▶ 試聴中" : "▶ 試聴";

  const dur = cue.duration || 0;
  const pct = (s) => (dur ? Math.max(0, Math.min(100, (s / dur) * 100)) : 0);
  const s = cue.startSec || 0;
  const e = cue.endSec || dur;
  $("ed-range").style.left = pct(s) + "%";
  $("ed-range").style.width = Math.max(0, pct(e) - pct(s)) + "%";
  $("ed-head").style.left = pct(state.edPos) + "%";
  $("ed-mark-start").style.left = pct(s) + "%";
  $("ed-mark-end").style.left = pct(e) + "%";
  $("ed-mark-end").hidden = !cue.endSec;
}

function renderListSelect() {
  const sel = $("ed-list");
  sel.innerHTML = state.lists.map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join("");
}

function renderKeyHints() {
  $("key-hints").innerHTML = state.lists.map((l, i) =>
    `<span><kbd>${LIST_KEYS[i]?.label || ""}</kbd>${escapeHtml(l.name)}</span>`).join("")
    + '<span><kbd>Space</kbd>選択中のリスト</span><span><kbd>F</kbd>フェードアウト</span>';

  $("help-keys").innerHTML = [
    ...state.lists.map((l, i) => [LIST_KEYS[i]?.label || "", `「${l.name}」の NEXT を再生`]),
    ["Space", "今選んでいるリストの NEXT を再生"],
    ["Esc", "全停止"],
    ["← →", "操作するリストを切り替え"],
    ["↑ ↓", "NEXT を 1 つ上／下へ"],
    ["Home", "NEXT を先頭へ"],
    ["Enter", "選択中のキューを再生"],
    ["F", "鳴っている音をフェードアウト"],
  ].map(([k, d]) => `<li><b>${escapeHtml(k)}</b><span>${escapeHtml(d)}</span></li>`).join("");
}

function updateReadyBadge() {
  const badge = $("ready-badge");
  const cues = allCues(project());
  const total = cues.length;
  const ready = cues.filter((c) => engine.isReady(c.id)).length;
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
  const voices = engine.activeVoices();
  const shown = voices.filter((v) => v.id !== state.previewId);
  const nodes = $("voices").querySelectorAll("[data-vtime]");
  nodes.forEach((el, i) => { if (shown[i]) el.textContent = `${fmtTime(shown[i].position)} / ${fmtTime(shown[i].end)}`; });

  if (state.previewId) {
    const pv = voices.find((v) => v.id === state.previewId);
    if (pv) {
      state.edPos = pv.position;
      const cue = selectedCue();
      const dur = cue?.duration || 0;
      $("ed-head").style.left = (dur ? Math.min(100, (state.edPos / dur) * 100) : 0) + "%";
      $("ed-pos").textContent = fmtPrecise(state.edPos);
    } else {
      state.previewId = null;
      renderEditor();
    }
  }
}

// ============================================================
//  6. イベント登録
// ============================================================
function wireStaticEvents() {
  // --- 取り込み ---
  $("btn-local").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", (e) => { addLocalFiles(e.target.files); e.target.value = ""; });
  $("btn-drive").addEventListener("click", addFromDrive);

  const zone = $("lists");
  ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault(); zone.classList.add("dragover");
  }));
  zone.addEventListener("dragleave", (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove("dragover"); });
  zone.addEventListener("drop", (e) => {
    zone.classList.remove("dragover");
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    const pane = e.target.closest?.(".list-pane");
    addLocalFiles(e.dataTransfer.files, pane?.dataset.list || state.focusedList);
  });

  // --- トランスポート ---
  $("btn-stopall").addEventListener("click", () => { stopAll(); blurActive(); });
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

  // --- キュー設定（下の欄） ---
  $("editor-toggle").addEventListener("click", () => {
    const ed = $("editor");
    ed.classList.toggle("collapsed");
    $("editor-toggle").setAttribute("aria-expanded", String(!ed.classList.contains("collapsed")));
  });

  $("ed-vol").addEventListener("input", (e) => {
    const cue = selectedCue(); if (!cue) return;
    cue.volume = Number(e.target.value) / 100;
    $("ed-vol-val").textContent = Math.round(cue.volume * 100) + "%";
    engine.setCueVolume(cue.id, cue.volume);
    renderLists(); save();
  });
  $("ed-fadein").addEventListener("change", (e) => {
    const cue = selectedCue(); if (!cue) return;
    cue.fadeIn = Math.max(0, Number(e.target.value) || 0); save();
  });
  $("ed-fadeout").addEventListener("change", (e) => {
    const cue = selectedCue(); if (!cue) return;
    cue.fadeOut = Math.max(0, Number(e.target.value) || 0); renderLists(); save();
  });
  $("ed-mode").addEventListener("change", async (e) => {
    const cue = selectedCue(); if (!cue) return;
    cue.mode = e.target.value; save();
    await reprepare(cue);
  });
  $("ed-list").addEventListener("change", (e) => {
    const cue = selectedCue(); if (!cue) return;
    moveCue(cue.id, e.target.value, listById(e.target.value).cues.length);
  });

  // --- 試聴と開始／終了位置 ---
  $("btn-preview").addEventListener("click", () => { startPreview(); blurActive(); });
  $("btn-preview-stop").addEventListener("click", () => { stopPreview(); renderEditor(); blurActive(); });
  $("ed-bar").addEventListener("click", (e) => {
    const cue = selectedCue(); if (!cue || !cue.duration) return;
    const r = $("ed-bar").getBoundingClientRect();
    const sec = ((e.clientX - r.left) / r.width) * cue.duration;
    startPreview(Math.max(0, Math.min(cue.duration - 0.05, sec)));
  });
  $("btn-start-here").addEventListener("click", () => setTrim("start", state.edPos));
  $("btn-end-here").addEventListener("click", () => setTrim("end", state.edPos));
  $("btn-start-clear").addEventListener("click", () => setTrim("start", 0));
  $("btn-end-clear").addEventListener("click", () => setTrim("end", null));
  $("ed-start").addEventListener("change", (e) => setTrim("start", parseTime(e.target.value)));
  $("ed-end").addEventListener("change", (e) => {
    const v = e.target.value.trim();
    setTrim("end", v === "" || v === "—" ? null : parseTime(v));
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
    try { await backup.exportPack(project(), (p) => busy(`バックアップを作成中… ${Math.round(p * 100)}%`)); }
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
      await applyProject(await backup.importPack(file));
      toast("バックアップを復元しました。");
    } catch (err) { toast("読み込みに失敗: " + err.message, true); }
    finally { idle(); }
  });
  $("btn-export-json").addEventListener("click", () => backup.exportJson(project()));
  $("btn-import-json").addEventListener("click", () => $("json-input").click());
  $("json-input").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    try {
      await applyProject(await backup.importJson(file, project()));
      const missing = allCues(project()).filter((c) => c.missing).length;
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

/** 3 本のリスト側のイベント（リストは動的に作るのでまとめて委譲） */
function wirePanes() {
  const root = $("lists");

  root.addEventListener("click", (e) => {
    const pane = e.target.closest(".list-pane");
    if (!pane) return;
    const listId = pane.dataset.list;

    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act) {
      e.stopPropagation();
      handleListAction(listId, act);
      blurActive();
      return;
    }
    const li = e.target.closest(".cue");
    if (li) { selectCue(li.dataset.id, { fromClick: true }); return; }
    state.focusedList = listId;
    renderLists();
  });

  root.addEventListener("dblclick", (e) => {
    const li = e.target.closest(".cue");
    if (li) playCue(cueById(li.dataset.id));
  });

  root.addEventListener("input", (e) => {
    const pane = e.target.closest(".list-pane");
    if (!pane) return;
    const list = listById(pane.dataset.list);
    if (e.target.matches("[data-name]")) {
      list.name = e.target.value.slice(0, 20);
      renderKeyHints(); renderListSelect(); save();
    } else if (e.target.matches("[data-gv]")) {
      list.volume = Number(e.target.value) / 100;
      pane.querySelector("[data-gvval]").textContent = Math.round(list.volume * 100) + "%";
      engine.setGroupVolume(list.id, list.volume);
      save();
    }
  });

  enableDragReorder(root);
}

function handleListAction(listId, act) {
  const list = listById(listId);
  if (act === "go") { go(listId); return; }
  if (act === "stoplist") { engine.stopList(listId, state.settings.stopAllFadeSec); render(); return; }

  const found = state.selectedId ? findCue(project(), state.selectedId) : null;
  if (!found || found.list.id !== listId) {
    toast(`「${list.name}」の中のキューを選んでから押してください。`);
    return;
  }
  if (act === "up" || act === "down") {
    const j = found.index + (act === "up" ? -1 : 1);
    if (j < 0 || j >= list.cues.length) return;
    [list.cues[found.index], list.cues[j]] = [list.cues[j], list.cues[found.index]];
    state.nextIndex[listId] = j;
    render(); save();
  } else if (act === "rename") {
    const name = prompt("キュー名", found.cue.name);
    if (name == null) return;
    found.cue.name = name.trim() || found.cue.name;
    render(); save();
  } else if (act === "remove") {
    removeCue(found.cue.id);
  }
}

async function removeCue(cueId) {
  const found = findCue(project(), cueId);
  if (!found) return;
  if (!confirm(`「${found.cue.name}」を削除しますか？`)) return;
  engine.unload(cueId);
  await store.deleteBlob(cueId).catch(() => {});
  found.list.cues.splice(found.index, 1);
  if (state.selectedId === cueId) state.selectedId = null;
  state.nextIndex[found.list.id] = Math.min(state.nextIndex[found.list.id] ?? 0, Math.max(0, found.list.cues.length - 1));
  render(); save(); updateReadyBadge();
}

function moveCue(cueId, toListId, toIndex) {
  const found = findCue(project(), cueId);
  if (!found) return;
  const to = listById(toListId);
  found.list.cues.splice(found.index, 1);
  const idx = Math.max(0, Math.min(toIndex, to.cues.length));
  to.cues.splice(idx, 0, found.cue);
  found.cue.listId = to.id;
  engine.setCueGroup(cueId, to.id);
  state.focusedList = to.id;
  render(); save();
}

function enableDragReorder(root) {
  let dragId = null;
  root.addEventListener("dragstart", (e) => {
    const li = e.target.closest(".cue");
    if (!li) return;
    dragId = li.dataset.id;
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", dragId); } catch { /* 無視 */ }
  });
  root.addEventListener("dragend", () => {
    dragId = null;
    root.querySelectorAll(".cue").forEach((el) => el.classList.remove("dragging", "drag-over"));
    root.querySelectorAll(".cuelist").forEach((el) => el.classList.remove("drop-target"));
  });
  root.addEventListener("dragover", (e) => {
    if (!dragId) return;
    const ol = e.target.closest(".cuelist");
    if (!ol) return;
    e.preventDefault();
    root.querySelectorAll(".cuelist").forEach((el) => el.classList.toggle("drop-target", el === ol));
    root.querySelectorAll(".cue").forEach((el) => el.classList.remove("drag-over"));
    e.target.closest(".cue")?.classList.add("drag-over");
  });
  root.addEventListener("drop", (e) => {
    if (!dragId) return;
    const ol = e.target.closest(".cuelist");
    if (!ol) return;
    e.preventDefault();
    const toListId = ol.closest(".list-pane").dataset.list;
    const overLi = e.target.closest(".cue");
    const to = listById(toListId);
    let index = overLi ? to.cues.findIndex((c) => c.id === overLi.dataset.id) : to.cues.length;
    if (index < 0) index = to.cues.length;
    moveCue(dragId, toListId, index);
    dragId = null;
  });
}

function onKeyDown(e) {
  const t = e.target;
  const typing = t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
  const dialogOpen = $("dlg-settings").open;

  if (e.code === "Escape" && !dialogOpen) { e.preventDefault(); stopAll(); return; }
  if (typing || dialogOpen) return;

  const keyIdx = LIST_KEYS.findIndex((k) => k.code === e.code);
  if (keyIdx >= 0 && state.lists[keyIdx]) { e.preventDefault(); go(state.lists[keyIdx].id); return; }

  switch (e.code) {
    case "Space":
      e.preventDefault(); go(state.focusedList); break;
    case "ArrowDown":
      e.preventDefault(); moveNext(1); break;
    case "ArrowUp":
      e.preventDefault(); moveNext(-1); break;
    case "ArrowLeft":
      e.preventDefault(); focusShift(-1); break;
    case "ArrowRight":
      e.preventDefault(); focusShift(1); break;
    case "Home": {
      e.preventDefault();
      state.nextIndex[state.focusedList] = 0;
      render();
      break;
    }
    case "Enter":
      e.preventDefault(); playCue(selectedCue()); break;
    case "KeyF": {
      e.preventDefault();
      const v = currentVoice();
      if (v) fadeVoice(v.id);
      break;
    }
  }
}

function focusShift(delta) {
  const i = listIndex(state.focusedList);
  const j = Math.min(state.lists.length - 1, Math.max(0, i + delta));
  state.focusedList = state.lists[j].id;
  renderLists();
}

function moveNext(delta) {
  const list = listById(state.focusedList);
  if (!list.cues.length) return;
  const i = Math.min(list.cues.length - 1, Math.max(0, (state.nextIndex[list.id] ?? 0) + delta));
  state.nextIndex[list.id] = i;
  render();
  paneOf(list.id)?.querySelector(".cue.is-next")?.scrollIntoView({ block: "nearest" });
}

// ============================================================
//  7. 開始／終了位置
// ============================================================
function setTrim(which, sec) {
  const cue = selectedCue();
  if (!cue) return;
  const dur = cue.duration || 0;
  if (which === "start") {
    let s = Math.max(0, Math.min(Number.isFinite(sec) ? sec : 0, dur));
    if (cue.endSec && s >= cue.endSec) s = Math.max(0, cue.endSec - 0.1);
    cue.startSec = round1(s);
  } else {
    if (sec == null || !Number.isFinite(sec)) cue.endSec = null;
    else {
      let e2 = Math.max(0, Math.min(sec, dur || sec));
      if (e2 <= (cue.startSec || 0)) e2 = (cue.startSec || 0) + 0.1;
      cue.endSec = round1(e2);
    }
  }
  render(); save();
}

function playLength(cue) {
  const end = cue.endSec || cue.duration || 0;
  return Math.max(0, end - (cue.startSec || 0));
}

// ============================================================
//  8. 設定と画面の同期・小物
// ============================================================
async function applyProject(raw) {
  const p = normalizeProject(raw);
  state.settings = p.settings;
  state.lists = p.lists;
  state.selectedId = null;
  for (const l of state.lists) state.nextIndex[l.id] = 0;
  state.focusedList = state.lists[0].id;
  buildPanes();
  applySettingsToUI();
  save();
  await prepareAll();
  updateReadyBadge();
}

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
  for (const l of state.lists) engine.setGroupVolume(l.id, l.volume);
}

async function refreshStorageInfo() {
  const est = await store.estimate();
  const persisted = await store.isPersisted();
  const parts = [];
  if (est) parts.push(`保存容量 ${fmtBytes(est.usage || 0)} / 使用可能 ${fmtBytes(est.quota || 0)}`);
  parts.push(`メモリ展開 ${fmtBytes(engine.memoryBytes())}`);
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
function round1(n) { return Math.round(n * 10) / 10; }

/** キューリスト用：10 秒未満は小数第 1 位まで出す（0.5 秒の効果音が 0:00 に見えないように） */
function fmtLen(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00";
  if (sec < 10) return `${sec.toFixed(1)}秒`;
  return fmtTime(sec);
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 0:12.3 のように小数第 1 位まで */
function fmtPrecise(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00.0";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

/** "1:23.4" でも "83.4" でも受け付ける */
function parseTime(str) {
  const t = String(str).trim().replace(/[^\d:.]/g, "");
  if (!t) return NaN;
  if (t.includes(":")) {
    const [m, s] = t.split(":");
    return (Number(m) || 0) * 60 + (Number(s) || 0);
  }
  return Number(t);
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
