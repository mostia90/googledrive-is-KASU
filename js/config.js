// ============================================================
//  Google Drive 連携の設定
//  README の手順で取得した値をここに貼り付けてください。
//  （アプリの「⚙ 設定」画面から入力しても構いません。
//    設定画面で入力した値のほうが優先されます）
// ============================================================

export const GOOGLE_CONFIG = {
  // 例: "123456789012-abcdefg.apps.googleusercontent.com"
  clientId: "",
  // 例: "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXX"
  apiKey: "",
};

// Drive から取り込める音声の MIME タイプ
export const AUDIO_MIME = [
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave",
  "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac",
  "audio/ogg", "audio/flac", "audio/x-flac", "audio/webm",
].join(",");

// アプリ全体の初期設定
export const DEFAULT_SETTINGS = {
  autoPlayOnSelect: false,  // キューを選んだとき自動再生するか
  masterVolume: 1,          // マスター音量 0..1
  defaultFadeIn: 0,         // 既定のフェードイン（秒）
  defaultFadeOut: 2,        // 既定のフェードアウト（秒）
  bufferThresholdSec: 60,   // これ以下の長さはメモリ展開（遅延ほぼゼロ）
  stopAllFadeSec: 0.12,     // 全停止時の短いフェード（プチッというノイズ防止）
  clientId: "",
  apiKey: "",
};
