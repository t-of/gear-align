// 広告まわりの判定と、iOS 版（native/native.js）とのつなぎ口（ABILITILE の rewards.js と同じ形）。
// 広告そのもの（AdMob）はここに無い。Web 版では何も出ない。iOS 版の native.js が attach() で広告の出し方を渡す。
//
// 決まり（ABILITILE と同じ。2026-10-31 オーナー）:
//   - 全画面は、自分で揃えたクリア（「自動で解く」を使った盤は数えない）の通算 6 回目から、3 回に 1 回。
//     出すのはクリアの画面を離れるとき（「次の盤面」「同じ盤面をもう一度」「ホーム」のあと）。揃った瞬間には出さない。
//   - ごほうび広告は、鍵つきのコース・ルールの盤を 1 回遊べる権利。貯めない（entitlement.js の ticket）。

const COUNT_KEY = 'gear-align:adClears';   // 自分で揃えた回数（通算）
export const FREE_CLEARS = 5;               // 最初の 5 回は出さない
export const EVERY = 3;                     // それ以降は 3 回に 1 回

// n 回目（1 から数える）のクリアのあとに全画面を出すか。n=6, 9, 12, …
export const interstitialDue = (n) => Number.isInteger(n) && n > FREE_CLEARS && (n - FREE_CLEARS - 1) % EVERY === 0;

const readCount = () => {
  try {
    const n = Number(localStorage.getItem(COUNT_KEY));
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch { return 0; }
};
const writeCount = (n) => { try { localStorage.setItem(COUNT_KEY, String(n)); } catch { /* 数えられなくても遊べる */ } };
const send = (name, detail) => {
  try { if (typeof window !== 'undefined' && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* 通知できなくても遊べる */ }
};

// 自分で揃えたクリアを 1 回数えて、'gearalign:clear' を送る。出す回か（due）を返す
export function recordClear() {
  const count = readCount() + 1;
  writeCount(count);
  const detail = { count, due: interstitialDue(count) };
  send('gearalign:clear', detail);
  return detail;
}

// クリアの画面を離れるときに呼ぶ（main.js が、出す回のクリアのあとにだけ呼ぶ）。
// 出すかどうか（完全版・iOS・読み込み済みか）は受け手（native.js）が決める。遊びは待たせない。
export const requestInterstitial = () => send('gearalign:interstitial');

// ---- ごほうび広告の口 ----
// provider = { show(): Promise<'earned'|'dismissed'|'failed'> }  見終わって報酬が出たときだけ 'earned'
let provider = null;
const listeners = [];
export const attach = (p) => { provider = p; for (const fn of listeners) { try { fn(); } catch { /* 他の受け手を止めない */ } } };
export const onAttach = (fn) => { listeners.push(fn); if (provider) fn(); };
export const available = () => !!provider;
export async function watch() {
  if (!provider) return 'failed';
  try {
    const r = await provider.show();
    return r === 'earned' ? 'earned' : r === 'failed' ? 'failed' : 'dismissed';
  } catch { return 'failed'; }
}
export const _count = readCount;

if (typeof window !== 'undefined') window.Rewards = { attach, onAttach, available, interstitialDue };
