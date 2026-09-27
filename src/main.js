import { GearPuzzle, gcd } from './puzzle.js';
import { MODES, getMode, toneOf, sizeWords, liftOptions, MODULE, DRIVER_METAL } from './modes.js';
import { buildLayout } from './layout.js';
import {
  gearPath, altTeethPath, holesPath, webPath, webRadius, circlePath,
  indexMarkPath, indexDot, crankPath, turnArcPath,
} from './gear.js';
import { planFor, solvableDirections } from './solve.js';
import { mulberry32, randomSeed, normalizeSeed, seedNumber } from './rng.js';
import * as sound from './sound.js';

const NS = 'http://www.w3.org/2000/svg';
const PAD = 30;
const SHADOW = { x: 5, y: 9 };   // 地板に落ちる影のずれ（光は左上から）
const ANIM = 400;        // 通常の回転アニメ（ms）
const LIFT_STEP = 380;   // 解答の再生中、歯車を下げる／戻す 1 動作の間（持ち上げのアニメ 360ms に合わせる）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const $ = (id) => document.getElementById(id);
const board = $('board');
const overlay = $('overlay');

const app = {
  mode: MODES[0],
  size: MODES[0].size,
  lifts: 1,
  goal: null,        // null=自由 / 0〜7=↑↗→↘↓↙←↖ のどれかに揃える / 'd'=全部ちがう向き
  seed: '',
  hint: false,
  labels: true,
  puzzle: null,
  layout: null,
  cells: [],
  busy: false,
  anim: ANIM,
  suggestion: null,
  order: '',
  auto: false,      // 解答の再生中（手動の操作を止める）
  replay: null,      // 解答プレーヤーの状態
  assisted: false,   // この盤面で自動の解答を使った（記録に残さない）
  optimal: null,     // 配った直後の盤面を揃えるお手本の手数（シェアの文面に使う）
  startedAt: 0,
  elapsed: 0,
  ticker: 0,
};

function el(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// ---- 盤面の組み立て ----------------------------------------------------

function build() {
  const layout = buildLayout(app.mode, app.size);
  if (!liftOptions(app.mode, layout).includes(app.lifts)) app.lifts = 1;
  const p = new GearPuzzle(layout, app.lifts);
  // 目標を決めてから配る。目標の状態から合法手でかき混ぜるので、必ずそこへ戻せる。
  if (app.goal === 'd') p.goalMode = 'distinct';
  else if (app.goal !== null) {
    const c = (app.goal * 45 * p.G) / 360;
    if (Number.isInteger(c)) { p.goalMode = 'dir'; p.goal = c; } else app.goal = null;
  }
  // かき混ぜた結果がたまたま目標そのままになることがある（小さい盤面）。
  // シードを少しずらして配り直す（同じ URL からは同じ盤面が出る）。それでも駄目なら自由に戻す。
  if (!shuffleFor(p, app.seed) && app.goal !== null) {
    app.goal = null;
    build();
    return;
  }
  app.layout = layout;
  app.puzzle = p;
  const first = planFor(p);
  app.optimal = first ? first.length : null;
  app.cells = [];
  app.suggestion = null;
  app.order = '';
  app.replay = null;
  app.auto = false;
  app.assisted = false;
  app.elapsed = 0;
  app.startedAt = 0;
  stopTicker();

  board.textContent = '';
  board.appendChild(defs(layout));
  // 影は全部の歯車より下の層にまとめる（隣の歯車の上に影が乗らないように）
  const shadows = el('g', { id: 'shadows' });
  board.appendChild(shadows);
  const layer = el('g', { id: 'gears' });
  board.appendChild(layer);
  const clips = board.querySelector('defs');

  layout.cells.forEach((cell, k) => {
    const { x, y, teeth, R, root, outer, phase, driver } = cell;
    // 星などは cos/sin で座標が出るので、SVG には丸めた値を書く
    const at = `translate(${x.toFixed(4)},${y.toFixed(4)})`;
    const g = el('g', { class: driver ? 'gear driver' : 'gear', transform: at });
    g.dataset.index = String(k);
    g.dataset.teeth = String(teeth);
    if (driver) g.dataset.driver = '1';
    if (!driver && !layout.liftable[k]) g.dataset.fixed = '1';

    const shadow = el('g', { class: 'shadow', transform: at });
    shadow.appendChild(el('circle', { class: 'sh', cx: SHADOW.x, cy: SHADOW.y, r: outer * 0.96 }));
    shadows.appendChild(shadow);

    const tone = driver ? 'drv' : teeth;
    const metal = driver ? DRIVER_METAL : toneOf(teeth);
    const body = gearPath(teeth, R, MODULE, phase) + holesPath(teeth, R, MODULE);
    const rw = webRadius(R, MODULE);
    const clip = el('clipPath', { id: `clip-${k}` });
    clip.appendChild(el('path', { d: body, 'clip-rule': 'evenodd' }));
    clips.appendChild(clip);

    const lift = el('g', { class: 'lift' });
    const spin = el('g', { class: 'spin' });
    // 歯と円板（肉抜きの穴は evenodd で抜く）。塗りは中心対称のグラデーションなので回しても崩れない
    spin.appendChild(el('path', { class: 'teeth', fill: `url(#metal-${tone})`, 'fill-rule': 'evenodd', d: body }));
    spin.appendChild(el('path', { class: 'alt', fill: metal.dark, d: altTeethPath(teeth, R, MODULE, phase) }));
    // リムの内側は一段低い面。旋盤の挽き目（同心円）を重ねる
    spin.appendChild(el('path', { class: 'web', fill: metal.mid, 'fill-rule': 'evenodd', d: webPath(teeth, R, MODULE) }));
    spin.appendChild(el('path', { class: 'grain', fill: 'url(#grain)', 'fill-rule': 'evenodd', d: webPath(teeth, R, MODULE) }));
    // 合いマーク（白い塗料）。光の層より下に描くので、塗料も金属と同じ陰影を受ける。原動力には付けない
    const mark = driver ? '' : indexMarkPath(teeth, R, MODULE);
    if (!driver) {
      const dot = indexDot(teeth, R, MODULE);
      spin.appendChild(el('path', { class: 'index', d: mark }));
      spin.appendChild(el('circle', { class: 'index-dot', cy: dot.cy, r: dot.r }));
    }

    // 光は盤面に固定する。歯車と一緒に回る層の中で逆回転させて、ハイライトが回らないようにする
    const shade = el('g', { class: 'shade', 'clip-path': `url(#clip-${k})` });
    const light = el('g', { class: 'counter' });
    light.appendChild(el('circle', { class: 'light', r: outer }));
    light.appendChild(el('circle', { class: 'spec', r: outer }));
    shade.appendChild(light);
    spin.appendChild(shade);

    const fixed = el('g', { class: 'counter' });
    fixed.appendChild(el('circle', { class: 'recess', r: rw }));
    fixed.appendChild(el('circle', { class: 'rim', r: root - 0.4 }));
    const hubR = Math.min(R * 0.24, rw * 0.5);
    fixed.appendChild(el('circle', { class: 'hub', fill: `url(#hub-${tone})`, r: hubR }));
    spin.appendChild(fixed);

    // 原動力は合いマークを持たない。代わりにハンドルを描いて、何が回しているのかを見せる
    if (driver) {
      spin.appendChild(el('path', { class: 'crank', d: crankPath(R) }));
      spin.appendChild(el('circle', { class: 'knob', cy: -R * 0.55, r: R * 0.17 }));
      spin.appendChild(el('circle', { class: 'knob-cap', cy: -R * 0.55, r: R * 0.08 }));
    }
    const jewel = el('g', { class: 'counter pin' });
    jewel.appendChild(el('circle', { class: 'jewel-set', r: R * 0.12 }));
    jewel.appendChild(el('circle', { class: 'jewel', r: R * 0.075 }));
    spin.appendChild(jewel);
    const counters = [...spin.querySelectorAll('.counter')];

    const ghost = driver ? el('path', { class: 'ghost' })
      : el('path', { class: 'ghost', d: mark, 'stroke-width': 1.6 });

    // 中央のラベル（回らない）。歯数と、1 手で回る角度。原動力には出さない。
    const chip = el('g', { class: 'chip' });
    if (!driver) {
      chip.appendChild(el('circle', { class: 'chip-bg', r: R * 0.34 }));
      chip.appendChild(el('circle', { class: 'chip-ring', r: R * 0.34, 'stroke-width': Math.max(1, R * 0.025) }));
      const t1 = el('text', { class: 'chip-teeth', y: R * 0.03, 'font-size': R * 0.31 });
      t1.textContent = String(teeth);
      const t2 = el('text', { class: 'chip-angle', y: R * 0.245, 'font-size': R * 0.17 });
      t2.textContent = `${fmt(p.stepAngleOf(k))}°`;
      chip.appendChild(t1); chip.appendChild(t2);
    }

    lift.appendChild(spin);
    lift.appendChild(ghost);
    lift.appendChild(chip);
    lift.appendChild(el('circle', { class: 'mark', r: cell.outer - MODULE * 0.4 }));
    lift.appendChild(el('circle', { class: 'hit', r: cell.outer }));
    g.appendChild(lift);
    layer.appendChild(g);
    app.cells.push({ root: g, lift, spin, counters, shadow, ghost, chip, teeth, driver });
  });

  // 「回る向き」の矢印を原動力の周りに出す。2 つとも同じ向きに回るので両方に同じ矢印を描く。
  // ほかの歯車に隠れないよう一番上の層に置く。
  for (const hk of layout.drivers) {
    const h = layout.cells[hk];
    const hints = el('g', { class: 'spinhints', transform: `translate(${h.x.toFixed(4)},${h.y.toFixed(4)})` });
    for (const d of [1, -1]) {
      const a = turnArcPath(h.outer + MODULE * 1.2, d * h.sign);
      const wrap = el('g', { class: `spinhint ${d > 0 ? 'cw' : 'ccw'}` });
      wrap.appendChild(el('path', { class: 'spinhint-arc', d: a.arc, 'stroke-width': MODULE * 0.7 }));
      wrap.appendChild(el('path', { class: 'spinhint-head', d: a.head }));
      hints.appendChild(wrap);
    }
    board.appendChild(hints);
  }

  const b = layout.bbox;
  board.setAttribute('viewBox',
    `${b.minX - PAD} ${b.minY - PAD} ${b.maxX - b.minX + 2 * PAD} ${b.maxY - b.minY + 2 * PAD}`);
  // 一列は横に長いので、盤面の幅を広く取る
  $('stage').classList.toggle('wide', layout.kind === 'train');
  document.querySelector('.board-wrap').scrollLeft = 0;
  requestAnimationFrame(scrollHints);
  overlay.classList.remove('show');
  board.classList.remove('solved');
  $('plate-cal').textContent = `${app.mode.name}　${sizeWords(app.mode).option(app.size)}`;
  buildLegend();
  render();
}

// 同じシードから必ず同じ盤面を作りつつ、目標のままになってしまう配りを避ける
function shuffleFor(p, seed) {
  for (let t = 0; t < 8; t++) {
    if (p.shuffle(mulberry32(seedNumber(seed + (t ? String(t) : '')))) !== false) return true;
  }
  return false;
}

function defs(layout) {
  const d = el('defs');
  const kinds = new Set(layout.teeth.filter((x, i) => !layout.isDriver[i]));
  const metals = [['drv', DRIVER_METAL], ...[...kinds].map((t) => [t, toneOf(t)])];
  let html = `
      <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="6"/></filter>
      <radialGradient id="grain" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.6" spreadMethod="repeat">
        <stop offset="0" stop-color="#000" stop-opacity="0.34"/>
        <stop offset="0.5" stop-color="#000" stop-opacity="0.2"/>
        <stop offset="1" stop-color="#000" stop-opacity="0.34"/></radialGradient>
      <linearGradient id="light" x1="0.18" y1="0.08" x2="0.82" y2="0.96">
        <stop offset="0" stop-color="#fff" stop-opacity="0.42"/>
        <stop offset="0.34" stop-color="#fff" stop-opacity="0.06"/>
        <stop offset="0.55" stop-color="#000" stop-opacity="0"/>
        <stop offset="0.82" stop-color="#000" stop-opacity="0.3"/>
        <stop offset="1" stop-color="#000" stop-opacity="0.5"/></linearGradient>
      <radialGradient id="spec" cx="0.3" cy="0.24" r="0.42">
        <stop offset="0" stop-color="#fff" stop-opacity="0.34"/>
        <stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      <linearGradient id="recess" x1="0.2" y1="0.1" x2="0.8" y2="0.9">
        <stop offset="0" stop-color="#000" stop-opacity="0.55"/>
        <stop offset="0.5" stop-color="#000" stop-opacity="0.1"/>
        <stop offset="1" stop-color="#fff" stop-opacity="0.45"/></linearGradient>
      <linearGradient id="rim" x1="0.2" y1="0.1" x2="0.8" y2="0.9">
        <stop offset="0" stop-color="#fff" stop-opacity="0.55"/>
        <stop offset="0.5" stop-color="#fff" stop-opacity="0"/>
        <stop offset="1" stop-color="#000" stop-opacity="0.4"/></linearGradient>
      <radialGradient id="jewel" cx="0.36" cy="0.3" r="0.75">
        <stop offset="0" stop-color="#ffd0d6"/><stop offset="0.3" stop-color="#e0304d"/>
        <stop offset="1" stop-color="#4a0613"/></radialGradient>
      <radialGradient id="knob" cx="0.36" cy="0.3" r="0.8">
        <stop offset="0" stop-color="#fff3c4"/><stop offset="0.35" stop-color="#e2b54c"/>
        <stop offset="1" stop-color="#5a3d0c"/></radialGradient>
      <radialGradient id="enamel" cx="0.4" cy="0.3" r="0.8">
        <stop offset="0" stop-color="#2b3038"/><stop offset="1" stop-color="#0b0d10"/></radialGradient>`;
  for (const [id, m] of metals) {
    // 歯と円板は中心対称のグラデーション（回しても光り方が変わらない）。歯先の面取りを明るく
    html += `
      <radialGradient id="metal-${id}" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="${m.mid}"/><stop offset="0.8" stop-color="${m.mid}"/>
        <stop offset="0.93" stop-color="${m.light}"/><stop offset="1" stop-color="${m.dark}"/></radialGradient>
      <radialGradient id="hub-${id}" cx="0.36" cy="0.3" r="0.8">
        <stop offset="0" stop-color="${m.light}"/><stop offset="0.5" stop-color="${m.mid}"/>
        <stop offset="1" stop-color="${m.dark}"/></radialGradient>`;
  }
  d.innerHTML = html;
  return d;
}

// 歯数 → 色 → 1 手の回転角 の対応表
function buildLegend() {
  const box = $('legend');
  box.textContent = '';
  const counts = [...new Set(app.layout.teeth.filter((x, i) => !app.layout.isDriver[i]))]
    .sort((a, b) => b - a);
  for (const teeth of counts) {
    const t = toneOf(teeth);
    const chip = document.createElement('span');
    chip.className = 'legend-item';
    chip.style.setProperty('--m-light', t.light);
    chip.style.setProperty('--m-mid', t.mid);
    chip.style.setProperty('--m-dark', t.dark);
    chip.innerHTML = `<i class="swatch"></i>`
      + `<span class="metal">${t.name}</span>`
      + `<b>${teeth}</b><span class="u">歯</span><span class="to">→</span>`
      + `<b>${fmt((app.mode.step * 360) / teeth)}°</b>`
      + `<em>${teeth / gcd(app.mode.step, teeth)} 通り</em>`;
    box.appendChild(chip);
  }
}

// ---- 描画 --------------------------------------------------------------

const GOAL_ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
const GOAL_NAMES = ['上', '右上', '右', '右下', '下', '左下', '左', '左上'];

const DIR_ARROW = (deg) => {
  const a = ((deg % 360) + 360) % 360;
  const names = { 0: '↑', 45: '↗', 90: '→', 135: '↘', 180: '↓', 225: '↙', 270: '←', 315: '↖' };
  return names[a] !== undefined ? names[a] : `${Math.round(a * 10) / 10}°`;
};
const fmt = (v) => String(Math.round(v * 10) / 10);
const targetUnit = (p, c) => ((c * p.L) / p.G) % p.L;
const mod = (a, m) => ((a % m) + m) % m;

function render() {
  const p = app.puzzle;
  const targets = solvableDirections(p);
  const layer = $('gears');
  const plan = app.hint ? planFor(p) : null;
  const goal = plan ? plan.c : targets[0];

  // 今の持ち上げ方だと原動力から切り離されて動かない歯車
  const powered = p.lifted.length ? p.poweredSet() : null;
  let stopped = 0;

  app.cells.forEach((cell, k) => {
    cell.spin.style.transform = `rotate(${p.angle(k)}deg)`;
    for (const c of cell.counters) c.style.transform = `rotate(${-p.angle(k)}deg)`;
    cell.root.classList.toggle('lifted', p.lifted.includes(k));
    cell.shadow.classList.toggle('lifted', p.lifted.includes(k));
    const dead = powered !== null && !powered.has(k) && !p.lifted.includes(k);
    cell.root.classList.toggle('unpowered', dead);
    cell.shadow.classList.toggle('unpowered', dead);
    if (dead && !p.isDriver[k]) stopped++;
    cell.root.classList.toggle('suggest',
      app.suggestion !== null && app.suggestion.lift.includes(k));
    if (cell.driver) return;
    cell.ghost.setAttribute('transform', `rotate(${goal === undefined ? 0 : p.dirAngle(goal)})`);
    cell.ghost.classList.toggle('on',
      app.hint && goal !== undefined && p.unit(k) !== targetUnit(p, goal));
  });
  // 持ち上げた歯車は奥に下がるので、描く順も一番後ろ（＝隣の歯車がその上を通る）にする。
  // 並べ替えはアニメーションを途切れさせるので、選択が変わったときだけ行う。
  const order = p.lifted.join(',');
  if (order !== app.order) {
    app.order = order;
    app.cells.forEach((cell, k) => { if (!p.lifted.includes(k)) layer.appendChild(cell.root); });
    for (const k of p.lifted) layer.insertBefore(app.cells[k].root, layer.firstChild);
  }
  board.classList.toggle('labels', app.labels);

  $('moves').textContent = String(p.moves);
  $('clock').textContent = clockText(app.elapsed);
  // 何も持ち上げていないときは「次に何をすればいいか」を出す
  const sel = $('selected');
  sel.textContent = p.lifted.length === 0 ? `歯車を ${p.lifts} つ選ぶ`
    : p.lifted.map((k) => app.layout.cells[k].label).join('・')
      + (p.ready() ? '' : `／あと ${p.lifts - p.lifted.length} つ`)
      + (stopped ? `／動力が届かない歯車 ${stopped} 個` : '');
  sel.classList.toggle('prompt', !p.ready());
  $('selected-label').textContent = p.lifted.length === 0 ? 'つぎに' : '持ち上げ中';
  const named = p.goalMode !== 'free';
  $('target-label').textContent = p.goalMode === 'distinct' ? '目標'
    : p.goalMode === 'dir' ? '目標の向き' : '揃えられる向き';
  $('target').textContent = p.goalMode === 'distinct' ? '全部ちがう向き'
    : p.goalMode === 'dir' ? DIR_ARROW(p.dirAngle(p.goal))
    : targets.length === 0 ? '—'
    : targets.length > 3 ? 'どの向きでも'
    : targets.map((c) => DIR_ARROW(p.dirAngle(c))).join(' / ');
  $('target').classList.toggle('goal', named);
  $('undo').disabled = p.history.length === 0 || app.auto;
  $('cw').disabled = !p.ready() || app.auto;
  $('ccw').disabled = !p.ready() || app.auto;
  $('solve').classList.toggle('running', app.auto);
  $('solve').textContent = app.auto ? '解答を閉じる' : '自動で解く';
  $('solve').disabled = overlay.classList.contains('show');
  $('shuffle').disabled = app.auto;
  $('hint').disabled = app.auto;
  $('best').textContent = bestText();
  $('seed').textContent = app.seed;
  $('mode-note').textContent = app.mode.blurb;
  $('course-name').textContent = `${app.mode.name}　${sizeWords(app.mode).option(app.size)}`;
  $('home-course').textContent = `${app.mode.name}　${sizeWords(app.mode).option(app.size)}`;
  $('home-best').textContent = bestText();

  renderHint(plan);
  renderPlayer();
}

function renderHint(plan) {
  $('hintbox').classList.toggle('show', app.hint);
  if (!app.hint) return;
  $('remain').textContent = plan ? `${plan.length} 手` : '—';
}

function clockText(ms) {
  const s = Math.floor(ms / 1000);
  return `${String((s / 60) | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---- 記録 --------------------------------------------------------------

const bestKey = () => `gear-align:${app.mode.id}:${app.size}`;
const loadBest = () => { try { return JSON.parse(localStorage.getItem(bestKey()) || 'null'); } catch { return null; } };
const saveBest = (rec) => { try { localStorage.setItem(bestKey(), JSON.stringify(rec)); } catch { /* 保存できなくても続行 */ } };
function bestText() {
  const b = loadBest();
  return b ? `${b.moves} 手 / ${clockText(b.ms)}` : '—';
}

// ---- 時計 --------------------------------------------------------------

function startTicker() {
  if (app.ticker) return;
  app.startedAt = Date.now() - app.elapsed;
  app.ticker = setInterval(() => {
    app.elapsed = Date.now() - app.startedAt;
    $('clock').textContent = clockText(app.elapsed);
  }, 250);
}
function stopTicker() {
  if (app.ticker) { clearInterval(app.ticker); app.ticker = 0; }
  if (app.startedAt) app.elapsed = Date.now() - app.startedAt;
}

// ---- 操作 --------------------------------------------------------------

function select(k) {
  if (app.busy || app.auto) return;
  const p = app.puzzle;
  if (p.isDriver[k]) { flash('原動力そのものは持ち上げられません'); return; }
  const before = p.lifted.length;
  if (!p.select(k)) return;
  (p.lifted.length < before ? sound.drop : sound.lift)();
  app.suggestion = null;
  render();
}

let flashTimer = 0;
function flash(text) {
  const el2 = $('notice');
  el2.textContent = text;
  el2.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el2.classList.remove('show'), 2600);
}

function doTurn(d) {
  if (app.busy || overlay.classList.contains('show')) return;
  if (!app.puzzle.ready()) { flash(`歯車を ${app.puzzle.lifts} つ持ち上げてから回します`); return; }
  app.busy = true;
  if (!app.ticker && !app.auto) startTicker();
  app.puzzle.turn(d);
  app.suggestion = null;
  sound.tick(app.mode.step);
  render();
  return new Promise((resolve) => setTimeout(() => {
    app.busy = false;
    settle();
    resolve();
  }, app.anim));
}

// 回し終えたあとの判定（揃ったか、向きだけ違うか）
function settle() {
  const q = app.puzzle;
  if (q.isSolved()) win();
  else if (q.goalMode === 'dir' && q.aligned()) {
    flash(`向きは揃いましたが、目標は ${DIR_ARROW(q.dirAngle(q.goal))} です`);
  }
}

function doUndo() {
  if (app.busy || app.auto || !app.puzzle.history.length) return;
  app.busy = true;
  app.puzzle.undo();
  app.suggestion = null;
  sound.undo();
  overlay.classList.remove('show');
  board.classList.remove('solved');
  render();
  setTimeout(() => { app.busy = false; }, app.anim);
}

function suggest() {
  if (app.busy || app.auto) return;
  const plan = planFor(app.puzzle);
  if (!plan || !plan.moves.length) return;
  const mv = plan.moves[0];
  app.puzzle.lifted = mv.lift.slice();
  app.suggestion = mv;
  render();
  $(mv.d > 0 ? 'cw' : 'ccw').classList.add('urge');
  setTimeout(() => { $('cw').classList.remove('urge'); $('ccw').classList.remove('urge'); }, 2400);
}

// 自動で解く。押したときに確認をはさむ（記録に残らないため）。
function askSolve() {
  if (app.busy || overlay.classList.contains('show')) return;
  if (app.auto) { closeReplay(); return; }             // 再生中なら閉じる
  const plan = planFor(app.puzzle);
  if (!plan || plan.length === 0) { flash('いまの盤面はもう揃っています'); return; }
  $('confirm-count').textContent = `${plan.length} 手`;
  $('confirm').showModal();
}

// ---- 解答の再生 --------------------------------------------------------
// 自動で解くと、操作盤が解答プレーヤーに切り替わる。再生・停止・1 手戻る／進む・
// シークで手順を見直せる。揃っても完了画面は出さず、揃った盤面をそのまま見せる。
// 1 手は「前の手の歯車を戻す → 次の歯車を下げる → 回す」を別々の動作として見せる
// （戻るときは逆に、下げ直してから逆向きに回す）。

const GAP = 220;         // 再生中、手と手の間（ms）
const live = (r) => app.replay === r;

function startReplay() {
  const plan = planFor(app.puzzle);
  if (!plan || app.auto) return;
  stopTicker();
  app.auto = true;
  app.assisted = true;
  app.suggestion = null;
  if (app.hint) $('hint').click();
  app.replay = { moves: plan.moves, pos: 0, playing: false, busy: null };
  $('scrub').max = String(plan.moves.length);
  render();
  play();
}

// 持ち上げ方を next に切り替える。戻す → 下げる を 1 動作ずつ
async function showLift(r, next) {
  const p = app.puzzle;
  const keep = p.lifted.filter((k) => next.includes(k));
  if (keep.length < p.lifted.length) {
    p.lifted = keep;
    sound.drop();
    render();
    await sleep(LIFT_STEP);
    if (!live(r)) return false;
  }
  if (next.some((k) => !p.lifted.includes(k))) {
    p.lifted = next.slice();
    sound.lift();
    render();
    await sleep(LIFT_STEP);
    if (!live(r)) return false;
  }
  return true;
}

async function stepForward(r) {
  if (r.pos >= r.moves.length) return;
  const mv = r.moves[r.pos];
  if (!(await showLift(r, mv.lift))) return;
  r.pos++;
  await doTurn(mv.d);
  // 揃ったら、下げていた歯車も戻して、揃った盤面を全部見せる
  if (live(r) && r.pos === r.moves.length) await showLift(r, []);
}

async function stepBack(r) {
  const p = app.puzzle;
  if (r.pos <= 0) return;
  if (!(await showLift(r, p.history[p.history.length - 1].lifted))) return;
  p.undo();
  r.pos--;
  sound.tick(app.mode.step);
  board.classList.remove('solved');
  render();
  await sleep(app.anim);
}

// 1 つずつしか動かさない（動いている途中の操作は、終わるまで受け付けない）
function run(r, fn) {
  if (!live(r) || r.busy) return r.busy;
  r.busy = fn().finally(() => { r.busy = null; if (live(r)) render(); });
  return r.busy;
}

async function play() {
  const r = app.replay;
  if (!r || r.playing) return;
  if (r.busy) await r.busy;
  if (!live(r)) return;
  if (r.pos >= r.moves.length) seek(0);          // 最後まで見たら頭から
  r.playing = true;
  render();
  while (live(r) && r.playing && r.pos < r.moves.length) {
    await run(r, () => stepForward(r));
    if (live(r) && r.playing && r.pos < r.moves.length) await sleep(GAP);
  }
  r.playing = false;
  if (live(r)) render();
}

function pause() {
  if (!app.replay) return;
  app.replay.playing = false;
  render();
}

// 止めてから 1 手だけ動かす
async function nudge(dir) {
  const r = app.replay;
  if (!r) return;
  pause();
  if (r.busy) await r.busy;
  run(r, () => (dir > 0 ? stepForward(r) : stepBack(r)));
}

// 好きな手の位置へ飛ぶ。途中は見せずに一気に動かす
function seek(target) {
  const r = app.replay;
  if (!r || r.busy) return;
  const p = app.puzzle;
  target = Math.max(0, Math.min(r.moves.length, target | 0));
  if (target === r.pos) return;
  r.playing = false;
  board.classList.add('instant');
  while (r.pos < target) { const mv = r.moves[r.pos++]; p.lifted = mv.lift.slice(); p.turn(mv.d); }
  while (r.pos > target) { p.undo(); r.pos--; }
  if (r.pos === r.moves.length) p.lifted = [];
  board.classList.toggle('solved', p.isSolved());
  render();
  void board.getBoundingClientRect();              // 動きなしの状態を確定させてから戻す
  requestAnimationFrame(() => requestAnimationFrame(() => board.classList.remove('instant')));
}

// 閉じると、いまの盤面のまま手動の操作に戻る
async function closeReplay() {
  const r = app.replay;
  if (!r) return;
  r.playing = false;
  if (r.busy) await r.busy;
  if (!live(r)) return;
  app.replay = null;
  app.auto = false;
  app.anim = ANIM;
  render();
}

function renderPlayer() {
  const r = app.replay;
  $('player').hidden = !r;
  $('console').classList.toggle('replaying', !!r);
  if (!r) return;
  const n = r.moves.length;
  $('scrub').value = String(r.pos);
  $('scrub').style.setProperty('--fill', `${n ? (r.pos / n) * 100 : 0}%`);
  const solved = r.pos === n && app.puzzle.isSolved();
  $('player-status').textContent = solved ? `揃いました（${n} 手）` : `${r.pos} / ${n} 手`;
  $('player-status').classList.toggle('done', solved);
  $('p-play').textContent = r.playing ? '停止' : r.pos >= n ? 'もう一度' : '再生';
  $('p-play').classList.toggle('playing', r.playing);
  $('p-first').disabled = $('p-back').disabled = r.pos === 0;
  $('p-fwd').disabled = $('p-last').disabled = r.pos >= n;
}

function win() {
  stopTicker();
  board.classList.add('solved');
  sound.win();
  // 解答の再生中は完了画面を出さず、揃った盤面をそのまま見せる
  if (app.auto) { render(); return; }
  const p = app.puzzle;
  const rec = { moves: p.moves, ms: app.elapsed };
  const prev = loadBest();
  const better = !prev || rec.moves < prev.moves || (rec.moves === prev.moves && rec.ms < prev.ms);
  if (better && !app.assisted) saveBest(rec);
  $('win-title').textContent = p.goalMode === 'distinct' ? 'できました' : 'そろいました';
  $('result').textContent = p.goalMode === 'distinct'
    ? `${p.moves} 手 / ${clockText(app.elapsed)}　全部ちがう向き`
    : `${p.moves} 手 / ${clockText(app.elapsed)}　向き ${DIR_ARROW(p.solvedDirection())}`
      + (p.goalMode === 'dir' ? '（指定どおり）' : '');
  $('record').textContent = app.assisted ? '自動の解答を見た盤面なので、記録には残しません'
    : better ? '自己ベスト更新' : `自己ベストは ${bestText()}`;
  overlay.classList.add('show');
  render();
}

function newBoard(seed = randomSeed()) {
  app.auto = false;
  app.anim = ANIM;
  app.seed = normalizeSeed(seed);
  build();
  writeHash();
}

// 「揃える向き」の選択肢はステージごとに変わる。
// 斜めは 45° がその盤面で作れる角度のときだけ、全部ちがう向きは組み合わせが取れるときだけ出す。
function fillGoals() {
  const layout = buildLayout(app.mode, app.size);
  const probe = new GearPuzzle(layout, 1);
  const sel = $('goal');
  sel.textContent = '';
  const add = (value, text) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = text;
    sel.appendChild(o);
  };
  add('f', '自由');
  const ok = [];
  for (let i = 0; i < 8; i++) {
    if (!Number.isInteger((i * 45 * probe.G) / 360)) continue;
    add(String(i), `${GOAL_ARROWS[i]} ${GOAL_NAMES[i]}`);
    ok.push(i);
  }
  // かき混ぜても目標のままになる盤面では遊べないので、実際に配ってみて確かめる
  const probeD = new GearPuzzle(layout, 1);
  probeD.goalMode = 'distinct';
  const canDistinct = probeD.distinctGoal() !== null && shuffleFor(probeD, app.seed);
  if (canDistinct) add('d', '全部ちがう向き');
  if (app.goal === 'd' ? !canDistinct : app.goal !== null && !ok.includes(app.goal)) app.goal = null;
  sel.value = app.goal === null ? 'f' : String(app.goal);
}

function fillLifts() {
  const opts = liftOptions(app.mode, buildLayout(app.mode, app.size));
  const ls = $('lifts');
  ls.textContent = '';
  for (const v of opts) {
    const o = document.createElement('option');
    o.value = String(v); o.textContent = `${v} つ`;
    ls.appendChild(o);
  }
  if (!opts.includes(app.lifts)) app.lifts = 1;
  ls.value = String(app.lifts);
  ls.disabled = opts.length < 2;
}

// ---- URL ---------------------------------------------------------------

function writeHash() {
  const g = app.goal === null ? 'f' : String(app.goal);
  const h = `#${app.mode.id}/${app.size}/${app.lifts}/${g}/${app.seed}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}

function readHash() {
  const m = /^#([a-z0-9]+)\/(\d+)\/(\d)\/(f|d|[0-7])\/([0-9A-Z]+)$/i.exec(location.hash || '');
  if (!m) return false;
  const mode = MODES.find((x) => x.id === m[1]);
  const size = Number(m[2]);
  if (!mode || !mode.sizes.includes(size)) return false;
  app.mode = mode; app.size = size; app.lifts = Number(m[3]);
  app.goal = m[4] === 'f' ? null : m[4] === 'd' ? 'd' : Number(m[4]);
  app.seed = normalizeSeed(m[5]);
  return true;
}

// ---- 配線 --------------------------------------------------------------

board.addEventListener('click', (e) => {
  if (dragged) { dragged = false; return; }        // なぞって回したあとの click は持ち上げにしない
  const g = e.target.closest('.gear');
  if (g) select(Number(g.dataset.index));
});

// ---- 歯車をなぞって回す ------------------------------------------------
// 歯車に触れて円を描くようになぞると、その歯車が指についてくる（噛み合った歯車も歯数の比で一緒に回る）。
// その歯車の 1 手ぶん（step·360/T 度）回すごとに 1 手として数える。離したとき半分以上回っていれば
// その手まで進めて噛み合わせ、足りなければ元の位置に戻す。動かさずに離せば、これまでどおり持ち上げ／下ろし。
// なぞった歯車が画面上で時計回り（v = +1）なら、原動力の向きは d = v·sign(k)。

const DRAG_START = 6;     // これだけ指が動いたら、なぞる操作とみなす（px）
let drag = null;
let dragged = false;

function toScreen(x, y) {
  const pt = board.createSVGPoint();
  pt.x = x; pt.y = y;
  return pt.matrixTransform(board.getScreenCTM());
}

board.addEventListener('pointerdown', (e) => {
  dragged = false;
  const g = e.target.closest('.gear');
  if (!g || drag || e.button > 0 || app.busy || app.auto || overlay.classList.contains('show')) return;
  const k = Number(g.dataset.index);
  const c = app.layout.cells[k];
  drag = { k, id: e.pointerId, x0: e.clientX, y0: e.clientY, on: false, center: toScreen(c.x, c.y), last: null, t: 0 };
});

// 動かし始めたところで、回せる歯車かを確かめる
function beginDrag(e) {
  const p = app.puzzle, k = drag.k;
  dragged = true;                                  // 回せなくても、なぞった操作は持ち上げにしない
  if (p.lifted.includes(k)) { flash('持ち上げた歯車は噛み合っていないので回せません'); return false; }
  if (!p.ready()) { flash(`歯車を ${p.lifts} つ持ち上げてから回します`); return false; }
  const moving = p.poweredSet();
  if (!moving.has(k)) { flash('この歯車は原動力から切り離されているので回りません'); return false; }
  const edge = toScreen(app.layout.cells[k].x + app.layout.cells[k].outer, app.layout.cells[k].y);
  // 角度は指を置いたところから数える（動き出しの判定までに動いたぶんも回す）
  const dx0 = drag.x0 - drag.center.x, dy0 = drag.y0 - drag.center.y;
  Object.assign(drag, {
    on: true, moving, stepDeg: p.stepAngleOf(k), last: Math.atan2(dy0, dx0),
    minR: Math.hypot(edge.x - drag.center.x, edge.y - drag.center.y) * 0.12,   // 軸の真上は角度が暴れるので使わない
  });
  try { board.setPointerCapture(e.pointerId); } catch { /* 合成イベントなどでは取れない */ }
  board.classList.add('instant', 'dragging');
  if (!app.ticker) startTicker();
  app.suggestion = null;
  return true;
}

// 1 手ぶん回し切ったので確定する
function commitDrag(v) {
  app.puzzle.turn(v * app.puzzle.sign(drag.k));
  sound.tick(app.mode.step);
  render();
}

// 確定していない端数ぶんを、動く歯車すべてに上乗せして描く
function paintDrag() {
  const p = app.puzzle, sk = p.sign(drag.k);
  for (const j of drag.moving) {
    const deg = p.angle(j) + drag.t * sk * p.sign(j) * p.stepAngleOf(j);
    const cell = app.cells[j];
    cell.spin.style.transform = `rotate(${deg}deg)`;
    for (const c of cell.counters) c.style.transform = `rotate(${-deg}deg)`;
  }
}

board.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.on) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < DRAG_START) return;
    if (!beginDrag(e)) { drag = null; return; }
  }
  e.preventDefault();
  const dx = e.clientX - drag.center.x, dy = e.clientY - drag.center.y;
  if (Math.hypot(dx, dy) < drag.minR) { drag.last = null; return; }
  const a = Math.atan2(dy, dx);
  if (drag.last !== null) {
    let da = a - drag.last;
    if (da > Math.PI) da -= 2 * Math.PI;
    if (da < -Math.PI) da += 2 * Math.PI;
    drag.t += (da * 180) / Math.PI / drag.stepDeg;
  }
  drag.last = a;
  while (drag.t >= 1) { commitDrag(1); drag.t -= 1; }
  while (drag.t <= -1) { commitDrag(-1); drag.t += 1; }
  paintDrag();
});

function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  if (!d.on) { drag = null; return; }              // 動かしていなければ click（持ち上げ）に任せる
  // 動きを戻してから、最後の手を確定（または元に戻）して、噛み合う位置まで滑らかに送る
  board.classList.remove('instant', 'dragging');
  void board.getBoundingClientRect();
  if (Math.abs(d.t) >= 0.5) { app.puzzle.turn(Math.sign(d.t) * app.puzzle.sign(d.k)); sound.tick(app.mode.step); }
  drag = null;
  render();
  settle();
}
board.addEventListener('pointerup', endDrag);
board.addEventListener('pointercancel', endDrag);

$('ccw').addEventListener('click', () => doTurn(-1));
$('cw').addEventListener('click', () => doTurn(1));

// 回すボタンに触れているあいだ、ハンドルの周りにその向きの矢印を出す
for (const [id, cls] of [['cw', 'preview-cw'], ['ccw', 'preview-ccw']]) {
  const on = () => board.classList.add(cls);
  const off = () => board.classList.remove(cls);
  $(id).addEventListener('pointerenter', on);
  $(id).addEventListener('focus', on);
  $(id).addEventListener('pointerleave', off);
  $(id).addEventListener('blur', off);
  $(id).addEventListener('click', off);
}
$('undo').addEventListener('click', doUndo);
$('suggest').addEventListener('click', suggest);
$('solve').addEventListener('click', askSolve);
$('confirm-go').addEventListener('click', () => { $('confirm').close(); startReplay(); });
$('p-play').addEventListener('click', () => (app.replay && app.replay.playing ? pause() : play()));
$('p-back').addEventListener('click', () => nudge(-1));
$('p-fwd').addEventListener('click', () => nudge(1));
$('p-first').addEventListener('click', () => seek(0));
$('p-last').addEventListener('click', () => app.replay && seek(app.replay.moves.length));
$('scrub').addEventListener('input', (e) => seek(Number(e.target.value)));
$('player-close').addEventListener('click', closeReplay);
$('shuffle').addEventListener('click', () => newBoard());
$('again').addEventListener('click', () => newBoard());
// 同じシードから作り直すので、まったく同じ盤面が出る
$('retry').addEventListener('click', () => { app.auto = false; app.anim = ANIM; build(); });

$('hint').addEventListener('click', () => {
  app.hint = !app.hint;
  $('hint').classList.toggle('on', app.hint);
  $('hint').setAttribute('aria-pressed', String(app.hint));
  render();
});

$('labels').addEventListener('click', () => {
  app.labels = !app.labels;
  $('labels').classList.toggle('on', app.labels);
  $('labels').setAttribute('aria-pressed', String(app.labels));
  render();
});

function showSound() {
  const on = sound.isEnabled();
  $('sound').classList.toggle('on', on);
  $('sound').textContent = on ? '音 ON' : '音 OFF';
}
showSound();   // 前回の設定を出す
$('sound').addEventListener('click', () => {
  const on = !sound.isEnabled();
  sound.setEnabled(on);
  showSound();
  if (on) sound.lift();
});

$('lifts').addEventListener('change', (e) => { app.lifts = Number(e.target.value); newBoard(); });
$('goal').addEventListener('change', (e) => {
  const v = e.target.value;
  app.goal = v === 'f' ? null : v === 'd' ? 'd' : Number(v);
  newBoard();
});
$('mesh').addEventListener('change', (e) => {
  const [id, size] = e.target.value.split('/');
  app.mode = getMode(id);
  app.size = Number(size);
  checkStage(app.mode.id, app.size);
  fillLifts();
  fillGoals();
  newBoard();
});

$('share').addEventListener('click', async () => {
  writeHash();
  const label = $('share').textContent;
  try { await navigator.clipboard.writeText(location.href); $('share').textContent = 'コピーしました'; }
  catch { $('share').textContent = location.hash; }
  setTimeout(() => { $('share').textContent = label; }, 1600);
});

// スマホでは盤面の高さの上限を「画面の高さ − 盤面以外のぶん」にする（CSS の --chrome）。
// 凡例の行数や、解答の再生中かどうかで操作盤の高さが変わるので、実際の高さを測って入れる。
function fitBoard() {
  const main = document.querySelector('main');
  const cs = getComputedStyle(main);
  const plate = document.querySelector('.plate');
  const plateExtra = plate.offsetHeight - board.getBoundingClientRect().height;
  const used = document.querySelector('.topbar').offsetHeight + $('console').offsetHeight + plateExtra
    + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.rowGap || cs.gap || 0) + 2;
  document.documentElement.style.setProperty('--chrome', `${Math.ceil(used)}px`);
}
if (window.ResizeObserver) new ResizeObserver(fitBoard).observe($('console'));
window.addEventListener('resize', () => { fitBoard(); scrollHints(); });

// 横にスクロールできる盤面（一列）では、続きがある側の端をぼかして知らせる
function scrollHints() {
  const wrap = document.querySelector('.board-wrap');
  const plate = document.querySelector('.plate');
  const max = wrap.scrollWidth - wrap.clientWidth;
  plate.classList.toggle('can-left', max > 2 && wrap.scrollLeft > 2);
  plate.classList.toggle('can-right', max > 2 && wrap.scrollLeft < max - 2);
}
document.querySelector('.board-wrap').addEventListener('scroll', scrollHints, { passive: true });

// ---- シェア ------------------------------------------------------------
// 送る文面を先に見せてから、共有メニュー（使えるブラウザだけ）・コピー・X・LINE を選んでもらう。
// リンクはいまの盤面の URL（#並べ方/大きさ/持ち上げ数/向き/シード）なので、相手も同じ盤面で遊べる。

const courseText = () => `${app.mode.name} ${sizeWords(app.mode).option(app.size)}`
  + (app.lifts > 1 ? `・${app.lifts} つ持ち上げ` : '');
function goalText() {
  const p = app.puzzle;
  return p.goalMode === 'distinct' ? '（全部ちがう向き）'
    : p.goalMode === 'dir' ? `（向き ${DIR_ARROW(p.dirAngle(p.goal))} 指定）` : '';
}

function shareUrl() {
  writeHash();
  return location.href;
}

// 揃えた結果の文面
function resultText() {
  const p = app.puzzle, opt = app.optimal;
  const head = `歯車パズル GEAR ALIGN の「${courseText()}」${goalText()}を`;
  if (app.assisted) return `${head}揃えました（解答を見ながら）。同じ盤面に挑戦してみて！`;
  const vs = opt === null ? ''
    : p.moves < opt ? `お手本（${opt} 手）より短い！`
    : p.moves === opt ? `お手本と同じ手数！` : `お手本は ${opt} 手。`;
  return `${head} ${p.moves} 手・${clockText(app.elapsed)} で揃えました。${vs}同じ盤面に挑戦してみて！`;
}

// 遊んでいる盤面をすすめる文面
function boardText() {
  const opt = app.optimal;
  return `歯車パズル GEAR ALIGN の「${courseText()}」${goalText()}。この盤面、何手で揃えられる？`
    + (opt === null ? '' : `（お手本は ${opt} 手）`);
}

let sharing = { text: '', url: '' };
function openShare(kind) {
  sharing = { text: kind === 'result' ? resultText() : boardText(), url: shareUrl() };
  $('share-title').textContent = kind === 'result' ? '結果をシェア' : 'この盤面をシェア';
  $('share-text').value = `${sharing.text}\n${sharing.url}`;
  $('share-native').hidden = !navigator.share;
  $('share-x').href = `https://x.com/intent/post?text=${encodeURIComponent(sharing.text)}&url=${encodeURIComponent(sharing.url)}`;
  $('share-line').href = `https://line.me/R/share?text=${encodeURIComponent(`${sharing.text}\n${sharing.url}`)}`;
  $('share-status').textContent = '';
  openSheet('share-sheet');
  // 文面の長さに合わせて欄を伸ばす（URL の最後まで見せる）
  const ta = $('share-text');
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

async function copyText(text) {
  // 権限の確認待ちなどで返事が来ないことがあるので、1.5 秒で見切って下の方法に切り替える
  try {
    const done = await Promise.race([
      navigator.clipboard.writeText(text).then(() => true),
      new Promise((r) => setTimeout(() => r(false), 1500)),
    ]);
    if (done) return true;
  } catch { /* 下の方法で */ }
  // クリップボードの API が使えない（権限が無い）ときは、文面を選んでコピーする
  const ta = $('share-text');
  ta.focus(); ta.select();
  try { return document.execCommand('copy'); } catch { return false; }
}

$('share-result').addEventListener('click', () => openShare('result'));
$('share-board').addEventListener('click', () => openShare('board'));
$('share-native').addEventListener('click', async () => {
  try {
    await navigator.share({ title: 'GEAR ALIGN', text: sharing.text, url: sharing.url });
    $('share-sheet').close();
  } catch (e) {
    if (e && e.name !== 'AbortError') $('share-status').textContent = '共有メニューを開けませんでした。コピーして送ってください。';
  }
});
$('share-copy').addEventListener('click', async () => {
  const ok2 = await copyText(`${sharing.text}\n${sharing.url}`);
  $('share-status').textContent = ok2 ? 'コピーしました。LINE やメッセージに貼り付けて送れます。'
    : 'コピーできませんでした。上の文面を長押し（または選択）してコピーしてください。';
});

// 設定と遊び方はダイアログに入れて、ふだんの画面には出さない
const openSheet = (id) => { const d = $(id); if (!d.open) d.showModal(); };
$('settings-open').addEventListener('click', () => openSheet('settings'));
$('course-open').addEventListener('click', openCourse);
// コース選択を開いたら、いま選んでいるコースが見える位置までスクロールしておく
function openCourse() {
  openSheet('course');
  const on = $('mesh').querySelector('.tile.on');
  if (on) on.scrollIntoView({ block: 'center' });
}
$('help-open').addEventListener('click', () => openSheet('help'));

// ---- ホーム ----
// 開いたらまずここを見せる。「はじめる」で今の（コース選択に出ている）盤面へ進み、
// ヘッダーのロゴでいつでも戻れる。盤面は起動時からずっと組み立ててあるので、
// ここでは表示を切り替えるだけでよい。
const titleEl = $('title');
const playEl = $('play');
function goHome() {
  titleEl.hidden = false;
  playEl.hidden = true;
}
function goPlay() {
  titleEl.hidden = true;
  playEl.hidden = false;
  fitBoard();       // 隠れている間は測れないので、見せてから測り直す
  scrollHints();
}
$('home-btn').addEventListener('click', goHome);
$('home-start').addEventListener('click', goPlay);
$('home-course-open').addEventListener('click', openCourse);
$('home-help-open').addEventListener('click', () => openSheet('help'));

for (const id of ['course', 'settings', 'help', 'confirm', 'share-sheet']) {
  // 外側をクリックしても閉じる
  $(id).addEventListener('click', (e) => { if (e.target === $(id)) $(id).close(); });
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  const k = e.key;
  if (document.querySelector('dialog[open]')) return;   // ダイアログ中は止める
  if (e.target instanceof HTMLButtonElement && (k === ' ' || k === 'Enter')) return;
  // 解答の再生中は、キーもプレーヤーの操作になる
  if (app.replay) {
    const r = app.replay;
    if (k === ' ' || k === 'k' || k === 'K') { (r.playing ? pause : play)(); e.preventDefault(); }
    else if (k === 'ArrowLeft' || k === 'j' || k === 'J') { nudge(-1); e.preventDefault(); }
    else if (k === 'ArrowRight' || k === 'l' || k === 'L') { nudge(1); e.preventDefault(); }
    else if (k === 'Home') seek(0);
    else if (k === 'End') seek(r.moves.length);
    else if (k === 'Escape') closeReplay();
    return;
  }
  if (k === 's' || k === 'S') { openSheet('settings'); return; }
  if (k === 'c' || k === 'C') { openCourse(); return; }
  if (k === '?' || k === '/') { openSheet('help'); return; }
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') { doTurn(-1); e.preventDefault(); }
  else if (k === 'ArrowRight' || k === 'd' || k === 'D') { doTurn(1); e.preventDefault(); }
  else if (k === 'z' || k === 'Z') doUndo();
  else if (k === 'h' || k === 'H') $('hint').click();
  else if (k === 'l' || k === 'L') $('labels').click();
  else if (k === 'n' || k === 'N') newBoard();
  else if (k === 'Escape') { app.puzzle.lifted = []; app.suggestion = null; render(); }
  else if (/^[1-9]$/.test(k)) { const i = Number(k) - 1; if (i < app.puzzle.size) select(i); }
});

// ---- アプリとしてインストール ------------------------------------------
// Chrome / Edge / Android は beforeinstallprompt を受け取っておき、ボタンでその場で入れる。
// Safari（iPhone / iPad / Mac）は自分から出せないので、ボタンを押すと手順を案内する。
// いまアプリとして開いているなら「インストール済み」にする。

let installPrompt = null;
const ua = navigator.userAgent;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches
  || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
const isIOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isSafari = /Safari\//.test(ua) && !/Chrome\/|Chromium|CriOS|FxiOS|EdgiOS|Edg\/|OPR\//.test(ua);
const isAndroid = /Android/.test(ua);
const isFirefox = /Firefox\/|FxiOS/.test(ua);

function installSteps() {
  if (isIOS) {
    return [
      isSafari ? 'Safari の<b>共有ボタン</b>（四角から上向きの矢印）を押す。iPhone は画面の下、iPad は右上'
        : 'ブラウザの<b>共有ボタン</b>を押す（入れられないときは Safari で開き直す）',
      '一覧を下へ送って<b>「ホーム画面に追加」</b>を選ぶ',
      '右上の<b>「追加」</b>を押すと、ホーム画面に GEAR ALIGN が並ぶ',
    ];
  }
  if (isSafari) {
    return ['メニューバーの<b>「ファイル」</b>を開く', '<b>「Dock に追加…」</b>を選んで「追加」を押す'];
  }
  if (isFirefox) {
    return isAndroid
      ? ['右上の<b>メニュー（⋮）</b>を開く', '<b>「インストール」</b>または<b>「ホーム画面に追加」</b>を選ぶ']
      : ['パソコン版の Firefox はアプリとして入れられないので、<b>Chrome か Edge</b> で開き直す'];
  }
  return isAndroid
    ? ['右上の<b>メニュー（⋮）</b>を開く', '<b>「アプリをインストール」</b>または<b>「ホーム画面に追加」</b>を選ぶ']
    : ['アドレスバーの右端にある<b>インストールのアイコン</b>を押す',
      '見当たらなければ<b>メニュー（⋮）</b>の「キャスト、保存、共有」→<b>「アプリをインストール」</b>'];
}

function renderInstall() {
  const btn = $('install'), note = $('install-note');
  if (isStandalone()) {
    btn.disabled = true;
    btn.textContent = 'インストール済み';
    note.textContent = 'いまアプリとして開いています。ネットにつながっていなくても遊べます。';
    $('install-steps').hidden = true;
    return;
  }
  btn.disabled = false;
  btn.textContent = 'アプリとしてインストール';
  note.innerHTML = !window.isSecureContext
    ? 'アプリとして入れるには、<b>https</b> で公開したページ（または localhost）で開く必要があります。'
    : installPrompt ? 'ホーム画面やアプリ一覧から、ブラウザを開かずに遊べます。ネットにつながっていなくても遊べます。'
    : isIOS ? 'ホーム画面に追加すると、アプリのように全画面で遊べます。'
    : isSafari ? 'Dock に追加すると、アプリのように別のウィンドウで遊べます。'
    : 'ホーム画面やアプリ一覧から、ブラウザを開かずに遊べます。';
}

$('install').addEventListener('click', async () => {
  if (installPrompt) {
    const prompt = installPrompt;
    installPrompt = null;
    prompt.prompt();
    // 1 回しか出せない。断られたときは、ブラウザがまた beforeinstallprompt を送ってくる
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') flash('アプリとしてインストールしました');
    renderInstall();
    return;
  }
  // 自分からは出せないブラウザでは、手順を開いて見せる
  const steps = $('install-steps');
  steps.innerHTML = installSteps().map((t) => `<li>${t}</li>`).join('');
  steps.hidden = !steps.hidden;
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();                 // ブラウザの帯は出さず、設定のボタンから入れてもらう
  installPrompt = e;
  $('install-steps').hidden = true;
  renderInstall();
});
window.addEventListener('appinstalled', () => { installPrompt = null; renderInstall(); });
matchMedia('(display-mode: standalone)').addEventListener?.('change', renderInstall);
renderInstall();

// オフラインでも遊べるように、ファイルを手元に保存しておく（sw.js）
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 登録できなくても遊べる */ });
  });
}

// ---- 起動 --------------------------------------------------------------

// 盤面は言葉だけだと想像しづらいので、並べ方 × 大きさを全部ステージとして並べ、
// 実際の盤面を小さく描いたタイルから選べるようにする。
function buildPicker() {
  const box = $('mesh');
  box.textContent = '';
  for (const m of MODES) {
    const group = document.createElement('div');
    group.className = 'stage-group';

    const head = document.createElement('div');
    head.className = 'stage-head';
    // 形が同じ並べ方（そろい歯どうし）は 1 手で回る角度が違うだけなので、それも書く
    const angles = [...new Set(m.teeth)].map((x) => Math.round((m.step * 360) / x * 10) / 10)
      .sort((a, b) => a - b);
    const ang = angles.length === 1 ? `${angles[0]}°`
      : angles.length === 2 ? `${angles[0]}/${angles[1]}°`
      : `${angles[0]}〜${angles[angles.length - 1]}°`;
    head.innerHTML = `<b>${m.name}</b><em>${m.rank}・1 手 ${ang}</em>`;
    group.appendChild(head);

    const row = document.createElement('div');
    row.className = 'stage-row';
    const words = sizeWords(m);
    for (const size of m.sizes) {
      const tile = document.createElement('label');
      tile.className = 'tile';
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'stage'; radio.value = `${m.id}/${size}`;
      const prev = document.createElement('span');
      prev.className = 'prev';
      prev.appendChild(previewSvg(m, size));
      const nm = document.createElement('span');
      nm.className = 'nm'; nm.textContent = words.option(size);
      tile.append(radio, prev, nm);
      row.appendChild(tile);
    }
    group.appendChild(row);
    box.appendChild(group);
  }
}

// 選ぶための小さな絵。合いマークやラベルは省いて、形と歯数の色だけ見せる。
function previewSvg(mode, size) {
  const layout = buildLayout(mode, size);
  const svg = el('svg', { class: 'preview', 'aria-hidden': 'true' });
  const b = layout.bbox, pad = MODULE;
  svg.setAttribute('viewBox',
    `${b.minX - pad} ${b.minY - pad} ${b.maxX - b.minX + 2 * pad} ${b.maxY - b.minY + 2 * pad}`);
  for (const c of layout.cells) {
    const tone = c.driver ? DRIVER_METAL : toneOf(c.teeth);
    const g = el('g', { transform: `translate(${c.x.toFixed(3)},${c.y.toFixed(3)})` });
    g.appendChild(el('path', {
      fill: tone.mid, stroke: tone.dark, 'stroke-width': 2, 'fill-rule': 'evenodd',
      d: gearPath(c.teeth, c.R, MODULE, c.phase) + holesPath(c.teeth, c.R, MODULE),
    }));
    g.appendChild(el('path', { fill: tone.light, opacity: 0.35, d: circlePath(c.R * 0.24) }));
    svg.appendChild(g);
  }
  return svg;
}

function checkStage(id, size) {
  const want = `${id}/${size}`;
  for (const tile of $('mesh').querySelectorAll('.tile')) {
    const r = tile.querySelector('input');
    r.checked = r.value === want;
    tile.classList.toggle('on', r.checked);
  }
}
buildPicker();

if (!readHash()) app.seed = randomSeed();
checkStage(app.mode.id, app.size);
fillLifts();
fillGoals();
build();
writeHash();
