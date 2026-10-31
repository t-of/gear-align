// 無料版と完全版の分け方（src/entitlement.js）と、全画面広告を出す回（src/rewards.js）を検証する。
import { MODES } from '../src/modes.js';
import * as Ent from '../src/entitlement.js';
import { interstitialDue } from '../src/rewards.js';

let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.error('  NG ' + msg); } };
const stages = (ms) => ms.reduce((n, m) => n + m.sizes.length, 0);

// Web 版（鍵なし）は全部遊べる
Ent._override({ locks: false });
check(MODES.every(Ent.courseOpen), 'Web 版は全コースが開いている');
check(Ent.goalOpen('d') && Ent.goalOpen(3), 'Web 版は追加ルールも開いている');
check(!Ent.adsActive(), 'Web 版は広告なし');

// iOS 版の無料: やさしい・ふつうの 9 コース・37 ステージ、ルールは「自由」だけ
Ent._override({ locks: true, full: false });
const free = MODES.filter(Ent.courseOpen);
check(free.length === 9, `無料のコースは 9（${free.length}）`);
check(stages(free) === 37, `無料のステージは 37（${stages(free)}）`);
check(stages(MODES) - stages(free) === 43, '完全版だけのステージは 43');
check(free.every((m) => Ent.FREE_RANKS.includes(m.rank)), '無料はやさしい・ふつうだけ');
check(new Set(free.map((m) => m.layout)).size >= 3, '無料でも格子・一列・輪に触れられる');
check(Ent.goalOpen(null) && !Ent.goalOpen(0) && !Ent.goalOpen('d'), '無料は「自由」だけ');
check(Ent.adsActive(), '無料版は広告あり');

// ごほうびの権利があいだだけ鍵が開き、使うと戻る
Ent.grantTicket();
check(MODES.every(Ent.courseOpen) && Ent.goalOpen('d'), '権利のあいだは全部開く');
Ent.useTicket();
check(!MODES.every(Ent.courseOpen), '使ったら鍵つきに戻る');

// 完全版
Ent._override({ locks: true, full: true });
check(MODES.every(Ent.courseOpen) && Ent.goalOpen('d'), '完全版は全部開く');
check(!Ent.adsActive(), '完全版は広告なし');
Ent.grantTicket();
check(!Ent.hasTicket(), '完全版には権利を出さない');

// 全画面は 6, 9, 12 … 回目
const due = [];
for (let n = 1; n <= 15; n++) if (interstitialDue(n)) due.push(n);
check(due.join() === '6,9,12,15', `全画面を出す回（${due.join()}）`);

if (fail) { console.error(`entitlement: ${fail} 件 NG`); process.exit(1); }
console.log('entitlement: OK');
