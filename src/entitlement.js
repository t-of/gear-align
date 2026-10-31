// 無料版と完全版の鍵（ABILITILE の entitlement.js と同じ形）。
// 鍵が効くのは iOS アプリ（Capacitor）の中だけ。Web 版は今までどおり全部遊べる。
// 開発の確かめ用に、localhost だけ ?locks=1（鍵を効かせる）と ?full=1（完全版にする）を受け付ける。
//
// 「買った」かどうかはストアが決める。iOS 版では native.js が attachStore() でストア（StoreKit）をつなぎ、
// 起動時とバックグラウンドから戻ったときに権利を確かめて結果を setFull に入れる。
// ストアの答えが来たあとは、その答えだけを信じる。localStorage は答えが来る前（起動直後）の表示の控え。
//
// 分け方（2026-10-31 オーナー）: 無料は「やさしい」「ふつう」のコースと、揃える向きが「自由」のルールだけ。
// 「むずかしい」「鬼」のコースと、向きの指定・全部ちがう向きは完全版。持ち上げる数はどちらも選べる。

const FULL_KEY = 'gear-align:full';
export const FREE_RANKS = ['やさしい', 'ふつう'];

let override = null;     // テスト用。{ locks, full } を入れると環境の判定より優先する
const listeners = [];
let store = null;        // attachStore で渡されるストア
let storeFull = null;    // ストアが最後に答えた「完全版か」。null は未確認
let ticket = false;      // ごほうび広告で得た「鍵つきの盤を 1 回遊べる」権利。盤を配ったら使い切り（貯めない）

const query = () => { try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(''); } };
const isLocalhost = () => { try { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname); } catch { return false; } };

export function locksActive() {
  if (override && 'locks' in override) return !!override.locks;
  const cap = typeof window !== 'undefined' ? window.Capacitor : undefined;
  if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) return true;
  return isLocalhost() && query().get('locks') === '1';
}

function readFull() {
  if (isLocalhost() && query().get('full') === '1') return true;
  if (storeFull !== null) return storeFull;   // ストアの答えが来たら、控えは見ない
  try { return localStorage.getItem(FULL_KEY) === '1'; } catch { return false; }
}

export function isFull() {
  if (!locksActive()) return true;
  if (override && 'full' in override) return !!override.full;
  return readFull();
}

export const onChange = (fn) => { listeners.push(fn); };
const notify = () => { for (const fn of listeners) { try { fn(isFull()); } catch { /* 他の受け手を止めない */ } } };

// 購入・復元・権利の確認の結果を入れる口。控えに書き、変わったときだけ知らせる
export function setFull(v) {
  const was = isFull();
  try { localStorage.setItem(FULL_KEY, v ? '1' : '0'); } catch { /* 保存できなくても今の画面は変わる */ }
  if (store) storeFull = !!v;
  if (isFull() !== was || !store) notify();
}

// ---- ストア（iOS の StoreKit。native.js から渡す）----
// store = { price(): Promise<string|null>, check(): Promise<boolean>, purchase(): Promise<'purchased'|'cancelled'|'pending'>, restore(): Promise<boolean> }
export function attachStore(s) { store = s; }
export const hasStore = () => !!store;
export const storePrice = () => (store ? store.price().catch(() => null) : Promise.resolve(null));
// 権利の確認。確認できなかったとき（通信・ストアの不調）は今の表示を変えない
export async function refreshFromStore() {
  if (!store) return isFull();
  try { setFull(await store.check()); } catch { /* 確認できないときは控えのまま */ }
  return isFull();
}
export async function purchase() {
  if (!store) throw new Error('no store');
  const r = await store.purchase();
  if (r === 'purchased') setFull(true);
  return r;
}
export async function restore() {
  if (!store) throw new Error('no store');
  const full = await store.restore();
  setFull(full);
  return full;
}

// ---- ごほうび広告の権利（1 回きり）----
export const hasTicket = () => ticket;
export function grantTicket() { if (!isFull()) ticket = true; }
export function useTicket() { ticket = false; }

// 広告が出る人か（iOS 版で、完全版でない）。プライバシーポリシーへのリンクの出し分けもこれで決める
export const adsActive = () => locksActive() && !isFull();
const restricted = () => locksActive() && !isFull() && !ticket;
export const courseFree = (mode) => FREE_RANKS.includes(mode.rank);
export const courseOpen = (mode) => !restricted() || courseFree(mode);
// goal: null=自由 / 0〜7=向きの指定 / 'd'=全部ちがう向き
export const goalOpen = (goal) => !restricted() || goal === null;

export const _override = (o) => { override = o; ticket = false; };
export const _resetStore = () => { store = null; storeFull = null; ticket = false; };

if (typeof window !== 'undefined') {
  window.Entitlement = { locksActive, isFull, adsActive, onChange, setFull, attachStore, hasStore, storePrice, refreshFromStore, purchase, restore };
}
