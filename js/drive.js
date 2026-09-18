// ============================================================
//  Google Drive 連携
//
//  方式: Google Identity Services（トークン取得）＋ Google Picker
//  スコープ: drive.file
//    → Picker で選んだファイルだけにアクセスできる方式。
//      Google の審査が不要で「このアプリは確認されていません」の
//      警告画面も出ないため、個人利用でも詰まりません。
//
//  ネット接続が必要なのは「取り込み」のときだけです。
//  取り込み後はすべてローカル（IndexedDB）から再生します。
// ============================================================

import { AUDIO_MIME } from "./config.js";

const GIS_SRC = "https://accounts.google.com/gsi/client";
const GAPI_SRC = "https://apis.google.com/js/api.js";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

let accessToken = null;
let tokenExpiresAt = 0;
let tokenClient = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("読み込みに失敗しました: " + src));
    document.head.appendChild(s);
  });
}

/** クライアント ID の先頭がプロジェクト番号（＝Picker の appId） */
export function appIdFromClientId(clientId) {
  return String(clientId || "").split("-")[0] || "";
}

export function hasConfig(cfg) {
  return Boolean(cfg.clientId && cfg.apiKey);
}

async function ensureToken(clientId) {
  if (accessToken && Date.now() < tokenExpiresAt - 60_000) return accessToken;
  await loadScript(GIS_SRC);
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: () => {},
      });
    }
    tokenClient.callback = (res) => {
      if (res.error) return reject(new Error("ログインがキャンセルされました（" + res.error + "）"));
      accessToken = res.access_token;
      tokenExpiresAt = Date.now() + (Number(res.expires_in || 3600) * 1000);
      resolve(accessToken);
    };
    tokenClient.error_callback = (err) => {
      reject(new Error("ログインに失敗しました: " + (err?.type || "unknown")));
    };
    tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
  });
}

async function ensurePicker() {
  await loadScript(GAPI_SRC);
  await new Promise((resolve, reject) => {
    gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("Picker の読み込みに失敗しました")) });
  });
}

/**
 * Drive のファイル選択ダイアログを開く。
 * @returns {Promise<Array<{id:string,name:string,mimeType:string,sizeBytes:number}>>}
 */
export async function pickFiles(cfg) {
  if (!navigator.onLine) throw new Error("オフラインです。Drive からの取り込みにはネット接続が必要です。");
  if (!hasConfig(cfg)) throw new Error("設定画面で「OAuth クライアント ID」と「API キー」を入力してください。");

  const token = await ensureToken(cfg.clientId);
  await ensurePicker();
  const appId = appIdFromClientId(cfg.clientId);

  return new Promise((resolve) => {
    const audioView = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes(AUDIO_MIME)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setLabel("音声ファイル");

    const allView = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setLabel("すべてのファイル");

    const picker = new google.picker.PickerBuilder()
      .setTitle("再生する音源を選ぶ")
      .setDeveloperKey(cfg.apiKey)
      .setOAuthToken(token)
      .setAppId(appId)
      .setOrigin(window.location.protocol + "//" + window.location.host)
      .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
      .addView(audioView)
      .addView(allView)
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) {
          resolve((data.docs || []).map((d) => ({
            id: d.id,
            name: d.name,
            mimeType: d.mimeType,
            sizeBytes: Number(d.sizeBytes || 0),
          })));
        } else if (data.action === google.picker.Action.CANCEL) {
          resolve([]);
        }
      })
      .build();
    picker.setVisible(true);
  });
}

/** 選んだファイルの中身をダウンロードして Blob で返す */
export async function downloadFile(fileId, cfg, onProgress) {
  const token = await ensureToken(cfg.clientId);
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ダウンロード失敗 (${res.status}) ${text.slice(0, 200)}`);
  }
  if (!res.body || !onProgress) return await res.blob();

  const total = Number(res.headers.get("content-length") || 0);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onProgress(received / total);
  }
  return new Blob(chunks, { type: res.headers.get("content-type") || "audio/mpeg" });
}

export function signOut() {
  if (accessToken && window.google?.accounts?.oauth2) {
    try { google.accounts.oauth2.revoke(accessToken); } catch { /* 無視 */ }
  }
  accessToken = null;
  tokenExpiresAt = 0;
}
