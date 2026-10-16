/*
 * race.js — 마블 레이스 엔진 (물리 + 렌더링)
 * 브라우저에서는 window.MarbleRace, Node에서는 module.exports 로 노출된다.
 * 물리는 Matter.js(vendor/matter.min.js) 고정 스텝(120Hz)으로 돌려 기기 성능과 무관하게 같은 결과를 낸다.
 *
 * 코스 끝의 "필터"와 클로즈업은 lazygyu 마블 룰렛(Wheel of fortune 맵)의 구조를 따랐다:
 *  - 깔때기가 구슬 1.8개 폭의 통로로 좁아지고, 통로 입구 옆에서 긴 패들이 천천히 돌며 입구를 막았다 열었다 한다
 *  - 다음에 도착할 구슬이 통로 입구 근처에 오면 카메라가 입구를 줌인하고,
 *    커트라인 등수(cutRanks)가 걸린 순간에는 슬로모션이 걸린다
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../vendor/matter.min.js'));
  } else {
    root.MarbleRace = factory(root.Matter);
  }
})(typeof self !== 'undefined' ? self : this, function (Matter) {
  'use strict';

  var Engine = Matter.Engine, Bodies = Matter.Bodies, Body = Matter.Body,
      Composite = Matter.Composite, Events = Matter.Events;

  var W = 640;                 // 월드 너비 (px)
  var H = 3300;                // 월드 높이 (px)
  var FILTER_Y = 3060;         // 필터(통로 입구) 높이 — 줌인/슬로모션 기준선 (원작의 zoomY)
  var CHUTE_HALF = 22;         // 통로 반폭 (폭 44 = 구슬 지름 1.8배, 원작과 같은 비율)
  var GOAL_Y = 3180;           // 이 선을 넘으면 도착 (통로 안, 입구에서 120px 아래)
  var MARBLE_R = 12;           // 구슬 반지름
  var SUBSTEP = 1000 / 120;    // 물리 스텝 (ms)
  var GRAVITY = 0.7;           // 1.0이면 레이스가 너무 빨리 끝난다 (20명 기준 17초) — 0.7이면 약 20~24초
  var MAX_RACE_MS = 150000;    // 안전장치: 이 시간이 지나면 남은 구슬은 진행도 순으로 강제 도착
  var STUCK_MS = 1000;         // 이 시간 동안 거의 안 움직이면 살짝 밀어준다
  var STUCK_SPEED = 0.12;      // px / substep (≈ 14 px/s)
  var FILTER_OMEGA = 1.2;      // 필터 패들 각속도 (rad/s) — 원작과 같다
  var FILTER_DIR = 1;          // +1: 입구 쪽 날개가 위로 올라가며 구슬을 퍼 올린다(원작), -1: 아래로 쓸어 넣는다
  var FILTER_LEN = 80;         // 패들 반길이 (px). 원작 비율(96)이면 20명 레이스가 37초로 늘어져 80으로 줄였다 (시뮬레이션 24초)
  var ZOOM_ZONE = 260;         // 입구에서 이 거리 안에 다음 도착 구슬이 오면 줌인 (원작 5유닛 ≈ 구슬 10개)
  var ZOOM_MAX = 2.1;          // 최대 줌 배율
  var SLOW_ZONE = 200;         // 커트라인 구슬이 입구에서 이 거리 안이면 슬로모션
  var SLOW_MIN = 0.3;          // 슬로모션 최저 배속
  var SLOW_BUDGET_MS = 3500;   // 커트라인 한 번당 슬로모션 최대 실시간 (구슬이 입구에 오래 머물러도 늘어지지 않게)
  var RIVAL_RANGE = 320;       // 경쟁 구슬이 이 거리 안에 있어야 "접전"으로 보고 슬로모션을 건다

  // ---------- 시드 난수 (mulberry32) ----------
  function makeRng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function smoothstep(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }

  // ---------- 코스 ----------
  function buildCourse(rng) {
    var statics = [];
    var course = { walls: [], slopes: [], pegs: [], bumpers: [], spinners: [], filter: null, gate: null,
                   goalY: GOAL_Y, filterY: FILTER_Y, W: W, H: H };

    function addStatic(body, list) { statics.push(body); if (list) list.push(body); return body; }

    function wall(x, y, w, h) {
      return addStatic(Bodies.rectangle(x, y, w, h, { isStatic: true, friction: 0.02, restitution: 0.3, label: 'wall' }), course.walls);
    }
    function slope(x1, y1, x2, y2, thick) {
      thick = thick || 20;
      var cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      var len = Math.hypot(x2 - x1, y2 - y1), ang = Math.atan2(y2 - y1, x2 - x1);
      return addStatic(Bodies.rectangle(cx, cy, len, thick, {
        isStatic: true, angle: ang, friction: 0.02, restitution: 0.3, label: 'slope',
        chamfer: { radius: thick / 2 - 1 }
      }), course.slopes);
    }
    function peg(x, y) {
      return addStatic(Bodies.circle(x, y, 7, { isStatic: true, restitution: 0.5, friction: 0.01, label: 'peg' }), course.pegs);
    }
    function bumper(x, y) {
      return addStatic(Bodies.circle(x, y, 22, { isStatic: true, restitution: 1.0, friction: 0, label: 'bumper' }), course.bumpers);
    }
    // 회전체: 정적 몸체의 각도만 매 스텝 바꾼다 (리졸버가 angle-anglePrev 로 접촉 속도를 계산하므로 제대로 튕겨낸다)
    function spinner(cx, cy, bars, len, omega, opts) {
      opts = opts || {};
      var thick = opts.thick || 12, hub = opts.hub || 14, label = opts.label || 'spinner';
      var parts = [Bodies.circle(cx, cy, hub)];
      for (var i = 0; i < bars; i++) {
        parts.push(Bodies.rectangle(cx, cy, len * 2, thick, { angle: Math.PI * i / bars, chamfer: { radius: thick / 2 - 1 } }));
      }
      var b = Body.create({ parts: parts, isStatic: true, friction: 0.05, restitution: 0.6, label: label });
      Body.setPosition(b, { x: cx, y: cy });
      Body.setAngle(b, opts.angle != null ? opts.angle : rng() * Math.PI * 2);
      b.plugin.omega = omega; // rad/s (부호 = 방향)
      b.plugin.len = len;
      b.plugin.hub = hub;
      return addStatic(b, course.spinners);
    }
    // 핀 밭: 좌우 대칭(양쪽 벽과의 간격 33px > 구슬 지름), 짝수 줄 10개 / 홀수 줄 9개 엇갈림
    function pegRows(y0, rows, skip) {
      var gap = (W - 80) / 9;
      for (var k = 0; k < rows; k++) {
        var y = y0 + k * 56;
        var odd = k % 2 === 1;
        var count = odd ? 9 : 10;
        for (var i = 0; i < count; i++) {
          var x = 40 + (odd ? gap / 2 : 0) + gap * i;
          if (skip && skip(x, y)) continue;
          peg(x, y);
        }
      }
    }

    // 바깥 벽, 천장, 바닥
    wall(-20, H / 2, 40, H + 400);
    wall(W + 20, H / 2, 40, H + 400);
    wall(W / 2, -30, W + 80, 40);
    wall(W / 2, H + 20, W + 80, 40);

    // 출발 게이트 (출발하면 제거)
    course.gate = Bodies.rectangle(W / 2, 240, W + 40, 20, { isStatic: true, friction: 0.05, restitution: 0.2, label: 'gate' });
    statics.push(course.gate);

    // 1구역: 핀 밭
    pegRows(330, 9);

    // 깔때기 1 (출구 140)
    slope(-20, 840, 250, 1000);
    slope(W + 20, 840, 390, 1000);

    // 회전 십자
    spinner(320, 1110, 2, 70, (rng() < 0.5 ? 1 : -1) * 2.2);

    // 2구역: 핀 밭 + 범퍼
    var bumperPos = [[136, 1332], [504, 1332], [320, 1444]];
    pegRows(1220, 7, function (x, y) {
      for (var i = 0; i < bumperPos.length; i++) {
        if (Math.hypot(x - bumperPos[i][0], y - bumperPos[i][1]) < 52) return true;
      }
      return false;
    });
    bumperPos.forEach(function (p) { bumper(p[0], p[1]); });

    // 지붕(∧): 가운데서 양쪽으로 갈라 벽 쪽으로 흘려보낸다 (벽과 60px 띄워 끼임 방지)
    slope(W / 2, 1640, 60, 1735);
    slope(W / 2, 1640, W - 60, 1735);

    // 회전 패들 2개 (양쪽 벽 아래, 서로 반대 방향)
    var dir = rng() < 0.5 ? 1 : -1;
    spinner(120, 1900, 1, 70, dir * 2.6);
    spinner(W - 120, 1900, 1, 70, -dir * 2.6);

    // 깔때기 2 (출구 150) → 회전 십자
    slope(-20, 2000, 245, 2140);
    slope(W + 20, 2000, 395, 2140);
    spinner(320, 2250, 2, 70, (rng() < 0.5 ? 1 : -1) * 2.0);

    // 3구역: 핀 밭 + 범퍼
    var bumperPos2 = [[320, 2420], [136, 2532], [504, 2532]];
    pegRows(2360, 7, function (x, y) {
      for (var i = 0; i < bumperPos2.length; i++) {
        if (Math.hypot(x - bumperPos2[i][0], y - bumperPos2[i][1]) < 52) return true;
      }
      return false;
    });
    bumperPos2.forEach(function (p) { bumper(p[0], p[1]); });

    // 마지막 깔때기 (45°) → 통로 입구(FILTER_Y) → 통로(폭 44) → 골
    var cx = W / 2;
    slope(-20, FILTER_Y - 320, cx - CHUTE_HALF, FILTER_Y);
    slope(W + 20, FILTER_Y - 320, cx + CHUTE_HALF, FILTER_Y);
    wall(cx - CHUTE_HALF - 10, FILTER_Y + 90, 20, 180);
    wall(cx + CHUTE_HALF + 10, FILTER_Y + 90, 20, 180);

    // 필터 패들: 통로 입구 옆(왼쪽/오른쪽 무작위)에 축을 두고 천천히 돌며 입구를 막았다 열었다 한다.
    // 길이·두께·축 위치·속도는 원작(폭 4유닛, 두께 0.2, 축이 입구에서 1.55유닛 옆, -1.2 rad/s)을 구슬 크기 비율로 옮겼다.
    // 축이 왼쪽(side=-1)이면 화면상 반시계(음수) 회전이 입구 쪽 날개를 위로 올린다. 오른쪽이면 반대.
    var side = rng() < 0.5 ? -1 : 1;
    course.filter = spinner(cx + side * 74, FILTER_Y, 1, FILTER_LEN, side * FILTER_DIR * FILTER_OMEGA,
                            { thick: 10, hub: 10, label: 'filter', angle: rng() * Math.PI });
    course.filterSide = side;

    course.statics = statics;
    return course;
  }

  // ---------- 출발 위치 ----------
  function startPositions(n, rng) {
    var cols = Math.min(n, 10);
    var rows = Math.ceil(n / cols);
    var left = 90, right = W - 90;
    var pos = [];
    for (var i = 0; i < n; i++) {
      var r = Math.floor(i / cols), c = i % cols;
      var inRow = Math.min(cols, n - r * cols);
      var x = inRow === 1 ? W / 2 : left + (right - left) * c / (inRow - 1);
      var y = 200 - r * 30;
      pos.push({ x: x + (rng() - 0.5) * 8, y: y });
    }
    return shuffle(pos, rng);
  }

  // ---------- 레이스 ----------
  // opts: { names, colors, seed, cutRanks: [등수…], rankLabel: function(rank) → 부가 문구 }
  function createRace(opts) {
    var names = opts.names.slice();
    var colors = opts.colors || [];
    var seed = (opts.seed != null) ? opts.seed : Math.floor(Math.random() * 0xffffffff);
    var rng = makeRng(seed);
    var cutSet = {};
    (opts.cutRanks || []).forEach(function (r) { cutSet[r] = true; });
    var rankLabel = opts.rankLabel || function () { return ''; };

    var engine = Engine.create({ enableSleeping: false });
    engine.gravity.y = GRAVITY;
    engine.positionIterations = 8;
    engine.velocityIterations = 6;

    var course = buildCourse(rng);
    Composite.add(engine.world, course.statics);

    var pos = startPositions(names.length, rng);
    var marbles = names.map(function (name, i) {
      var body = Bodies.circle(pos[i].x, pos[i].y, MARBLE_R, {
        restitution: 0.5, friction: 0.02, frictionAir: 0.006, density: 0.0012, label: 'marble'
      });
      body.plugin.marble = i;
      return { index: i, name: name, color: colors[i % colors.length] || '#fff', body: body,
               finished: false, rank: 0, finishTime: 0, stillMs: 0, nudges: 0, auto: false };
    });
    Composite.add(engine.world, marbles.map(function (m) { return m.body; }));

    var race = {
      seed: seed, course: course, engine: engine, marbles: marbles,
      names: names, started: false, done: false,
      time: 0,            // 물리 시간 (ms)
      realTime: 0,        // 슬로모션을 포함한 실제 경과 시간 (ms)
      timeScale: 1,       // 현재 슬로모션 배속 (1 = 정상)
      zoom: 0,            // 클로즈업 강도 0~1 (렌더러가 쓴다)
      focus: null,        // 카메라가 주목하는 구슬 (다음에 도착할 구슬)
      cutActive: 0,       // 슬로모션 중인 커트라인 등수 (0이면 없음)
      finished: [],
      stats: { nudges: 0, forced: 0, steps: 0, slowMs: 0 },
      onFinish: null, onHit: null, onNudge: null,
      effects: []
    };
    var acc = 0;
    var slowSpent = {};   // 커트라인 등수별 슬로모션에 쓴 실시간

    // 충돌 소리용 이벤트
    Events.on(engine, 'collisionStart', function (e) {
      if (!race.onHit) return;
      for (var i = 0; i < e.pairs.length; i++) {
        // 복합 몸체(회전체)는 자식 파트가 충돌하므로 부모(root)의 라벨/속도를 본다
        var a = e.pairs[i].bodyA.parent || e.pairs[i].bodyA;
        var b = e.pairs[i].bodyB.parent || e.pairs[i].bodyB;
        var la = a.label, lb = b.label;
        if (la !== 'marble' && lb !== 'marble') continue;
        var other = la === 'marble' ? b : a;
        var kind = other.label === 'marble' ? 'marble' : other.label;
        var v = Math.hypot(a.velocity.x - b.velocity.x, a.velocity.y - b.velocity.y);
        race.onHit(kind, v);
      }
    });

    race.start = function () {
      if (race.started) return;
      race.started = true;
      Composite.remove(engine.world, course.gate);
      // 아주 작은 무작위 흔들림 (같은 배치라도 매번 다르게)
      marbles.forEach(function (m) {
        Body.setVelocity(m.body, { x: (rng() - 0.5) * 1.2, y: 0 });
      });
    };

    function finishMarble(m, forced, auto) {
      m.finished = true;
      m.auto = !!auto;
      m.rank = race.finished.length + 1;
      m.finishTime = race.time;
      race.finished.push(m);
      Composite.remove(engine.world, m.body);
      if (forced) race.stats.forced++;
      var extra = rankLabel(m.rank) || '';
      race.effects.push({ type: 'finish', text: m.rank + '등 ' + m.name + (extra ? ' ' + extra : ''),
                          color: m.color, t: 0, cut: !!cutSet[m.rank] });
      while (race.effects.length > 4) race.effects.shift();   // 한꺼번에 몰려 들어와도 자막은 최근 4줄까지만
      if (race.finished.length === marbles.length) race.done = true;   // onFinish 안에서 race.done을 볼 수 있도록 먼저 설정
      if (race.onFinish) race.onFinish(m, m.rank, forced);
    }

    // 아직 도착하지 않은 구슬을 진행도(아래쪽) 순으로
    function remaining() {
      return marbles.filter(function (m) { return !m.finished; })
        .sort(function (a, b) { return b.body.position.y - a.body.position.y; });
    }

    function step() {
      for (var i = 0; i < course.spinners.length; i++) {
        var s = course.spinners[i];
        Body.setAngle(s, s.angle + s.plugin.omega * SUBSTEP / 1000, true);
      }
      Engine.update(engine, SUBSTEP);
      race.stats.steps++;
      if (!race.started) return;
      race.time += SUBSTEP;

      for (var j = 0; j < marbles.length; j++) {
        var m = marbles[j];
        if (m.finished) continue;
        var b = m.body;
        if (b.position.y > GOAL_Y) { finishMarble(m, false); continue; }
        // 끼임 방지: 1초 동안 거의 안 움직이면 살짝 밀어준다
        var sp = Math.hypot(b.velocity.x, b.velocity.y);
        if (sp < STUCK_SPEED) m.stillMs += SUBSTEP; else m.stillMs = 0;
        if (m.stillMs >= STUCK_MS) {
          m.stillMs = 0; m.nudges++; race.stats.nudges++;
          Body.setVelocity(b, { x: (rng() - 0.5) * 5, y: -2.5 });
          if (race.onNudge) race.onNudge(m);
        }
      }

      // 구슬이 하나만 남으면 그 등수는 정해진 것이므로 바로 도착 처리 (원작과 같다)
      if (!race.done) {
        var left = remaining();
        if (left.length === 1 && race.finished.length > 0) finishMarble(left[0], false, true);
      }

      if (!race.done && race.time >= MAX_RACE_MS) {
        // 안전장치: 남은 구슬을 진행도 순으로 도착 처리
        remaining().forEach(function (m) { finishMarble(m, true); });
      }
    }

    // 연출 상태 갱신: 주목 구슬, 줌 강도, 슬로모션 배속
    function updateDirection(realMs) {
      if (!race.started) { race.focus = null; race.zoom = 0; race.timeScale = 1; race.cutActive = 0; return; }
      if (race.done) { race.focus = null; race.timeScale = 1; race.cutActive = 0; return; }   // 끝나면 마지막 클로즈업을 유지
      var left = remaining();
      var leader = left[0], rival = left[1];
      race.focus = leader;
      var dist = Math.abs(leader.body.position.y - FILTER_Y);
      race.zoom = Math.max(0, 1 - dist / ZOOM_ZONE);

      var nextRank = race.finished.length + 1;
      var ts = 1;
      if (cutSet[nextRank] && rival &&
          leader.body.position.y > FILTER_Y - SLOW_ZONE &&
          leader.body.position.y - rival.body.position.y < RIVAL_RANGE) {
        var spent = slowSpent[nextRank] || 0;
        if (spent < SLOW_BUDGET_MS) {
          ts = Math.max(SLOW_MIN, dist / SLOW_ZONE);
          slowSpent[nextRank] = spent + realMs;
          race.stats.slowMs += realMs;
        }
      }
      race.timeScale = ts;
      race.cutActive = ts < 1 ? nextRank : 0;
    }

    // ms 만큼 실시간을 진행 (슬로모션 배속을 곱해 고정 스텝으로 누적)
    race.update = function (ms) {
      if (race.done) return;
      race.realTime += ms;
      acc += ms * race.timeScale;
      var n = 0;
      while (acc >= SUBSTEP && n < 64) { step(); acc -= SUBSTEP; n++; if (race.done) break; }
      if (n >= 64) acc = 0;
      updateDirection(ms);
      // 이펙트 수명
      for (var i = race.effects.length - 1; i >= 0; i--) {
        race.effects[i].t += ms;
        if (race.effects[i].t > 2200) race.effects.splice(i, 1);
      }
    };

    race.getLeader = function () {
      var best = null;
      for (var i = 0; i < marbles.length; i++) {
        var m = marbles[i];
        if (m.finished) continue;
        if (!best || m.body.position.y > best.body.position.y) best = m;
      }
      return best;
    };

    race.destroy = function () {
      Events.off(engine);
      Composite.clear(engine.world, false);
      Engine.clear(engine);
    };

    return race;
  }

  // ---------- 렌더러 (브라우저 전용) ----------
  function createRenderer(canvas, race) {
    var ctx = canvas.getContext('2d');
    // 카메라: 화면 가운데가 가리키는 월드 좌표(cx, cy)와 줌 배율. 모두 목표값으로 부드럽게 따라간다
    var cam = { cx: W / 2, cy: 0, zoom: 1, y: 0 };
    var size = { w: 0, h: 0, dpr: 1 };
    var MIN_VIEW_H = 680;   // 세로로 최소 이만큼(월드 px)은 보이도록 기본 배율을 제한

    function resize() {
      var rect = canvas.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      size.w = Math.max(1, Math.round(rect.width));
      size.h = Math.max(1, Math.round(rect.height));
      size.dpr = dpr;
      canvas.width = Math.round(size.w * dpr);
      canvas.height = Math.round(size.h * dpr);
    }

    function baseScale() { return Math.min(size.w / W, size.h / MIN_VIEW_H); }

    // 현재 카메라로 본 뷰: scale, 화면 원점의 월드 좌표(left, top), 보이는 월드 크기(viewW, viewH)
    function view() {
      var scale = baseScale() * cam.zoom;
      var viewW = size.w / scale, viewH = size.h / scale;
      return { scale: scale, viewW: viewW, viewH: viewH, left: cam.cx - viewW / 2, top: cam.cy - viewH / 2 };
    }

    function clampCenter(cx, cy, viewW, viewH) {
      cx = viewW >= W ? W / 2 : Math.max(viewW / 2, Math.min(W - viewW / 2, cx));
      cy = viewH >= H ? H / 2 : Math.max(viewH / 2, Math.min(H - viewH / 2, cy));
      return { cx: cx, cy: cy };
    }

    function updateCamera(dt) {
      var s0 = baseScale();
      var viewH0 = size.h / s0;
      // 1) 줌 없는 기본 추적: 선두 구슬이 화면 위에서 38% 지점에 오도록
      var leader = race.started ? race.getLeader() : null;
      var followY;
      if (leader) followY = leader.body.position.y + viewH0 * 0.12;
      else followY = race.done ? (GOAL_Y - viewH0 * 0.1) : viewH0 / 2;
      var target = clampCenter(W / 2, followY, size.w / s0, viewH0);

      // 2) 클로즈업: 다음 도착 구슬이 입구 근처면 입구 구역을 고정 프레이밍으로 줌인
      var k = smoothstep(race.zoom || 0);
      var zoom = 1 + (ZOOM_MAX - 1) * k;
      var scale = s0 * zoom;
      var viewW = size.w / scale, viewH = size.h / scale;
      var gate = { cx: W / 2, cy: FILTER_Y + 10 };
      var cx = target.cx + (gate.cx - target.cx) * k;
      var cy = target.cy + (gate.cy - target.cy) * k;
      var c = clampCenter(cx, cy, viewW, viewH);

      var a = 1 - Math.pow(0.0005, dt / 1000);   // 부드러운 추적
      cam.cx += (c.cx - cam.cx) * a;
      cam.cy += (c.cy - cam.cy) * a;
      cam.zoom += (zoom - cam.zoom) * a;
      cam.y = cam.cy - (size.h / (s0 * cam.zoom)) / 2;
    }

    function poly(verts) {
      ctx.beginPath();
      ctx.moveTo(verts[0].x, verts[0].y);
      for (var i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
      ctx.closePath();
    }

    function drawCourse(v) {
      var c = race.course;
      var top = v.top - 50, bottom = v.top + v.viewH + 50;
      // 핀
      ctx.fillStyle = '#cbd5e1';
      for (var i = 0; i < c.pegs.length; i++) {
        var p = c.pegs[i].position;
        if (p.y < top || p.y > bottom) continue;
        ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = '#ffffff';
      for (i = 0; i < c.pegs.length; i++) {
        p = c.pegs[i].position;
        if (p.y < top || p.y > bottom) continue;
        ctx.beginPath(); ctx.arc(p.x - 2, p.y - 2, 2.5, 0, Math.PI * 2); ctx.fill();
      }
      // 범퍼
      for (i = 0; i < c.bumpers.length; i++) {
        p = c.bumpers[i].position;
        if (p.y < top || p.y > bottom) continue;
        var g = ctx.createRadialGradient(p.x - 6, p.y - 6, 4, p.x, p.y, 22);
        g.addColorStop(0, '#fde68a'); g.addColorStop(1, '#f59e0b');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, 22, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#fff7ed'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, Math.PI * 2); ctx.stroke();
      }
      function drawSpinner(sp, color) {
        ctx.fillStyle = color; ctx.strokeStyle = '#fbcfe8'; ctx.lineWidth = 2;
        for (var k = 2; k < sp.parts.length; k++) { poly(sp.parts[k].vertices); ctx.fill(); ctx.stroke(); }
        ctx.fillStyle = '#fdf2f8';
        ctx.beginPath(); ctx.arc(sp.position.x, sp.position.y, sp.plugin.hub || 14, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#db2777';
        ctx.beginPath(); ctx.arc(sp.position.x, sp.position.y, 5, 0, Math.PI * 2); ctx.fill();
      }
      // 필터 패들은 벽 "뒤"에 그려 벽 틈에서 나왔다 들어가는 것처럼 보이게 한다 (물리적으로는 겹쳐 있다)
      var f = c.filter;
      if (f && f.bounds.max.y > top && f.bounds.min.y < bottom) {
        ctx.fillStyle = 'rgba(244,114,182,0.10)';
        ctx.beginPath(); ctx.arc(f.position.x, f.position.y, f.plugin.len + 6, 0, Math.PI * 2); ctx.fill();
        drawSpinner(f, '#fb7185');
      }
      // 깔때기 바깥(벽 속)은 반투명한 벽체로 덮어 패들이 벽 속으로 드나드는 느낌을 준다
      if (bottom > FILTER_Y - 320) {
        var mx = W / 2, fy = FILTER_Y, hx = CHUTE_HALF + 10;
        ctx.fillStyle = 'rgba(51,65,85,0.82)';
        ctx.beginPath(); ctx.moveTo(-40, fy - 320); ctx.lineTo(mx - hx, fy); ctx.lineTo(mx - hx, H + 40); ctx.lineTo(-40, H + 40); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(W + 40, fy - 320); ctx.lineTo(mx + hx, fy); ctx.lineTo(mx + hx, H + 40); ctx.lineTo(W + 40, H + 40); ctx.closePath(); ctx.fill();
      }
      // 경사로 / 깔때기
      ctx.fillStyle = '#94a3b8';
      ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 2;
      for (i = 0; i < c.slopes.length; i++) {
        var s = c.slopes[i];
        if (s.bounds.max.y < top || s.bounds.min.y > bottom) continue;
        poly(s.vertices); ctx.fill(); ctx.stroke();
      }
      // 통로 벽 (바깥 벽은 따로)
      for (i = 0; i < c.walls.length; i++) {
        var wb = c.walls[i];
        if (wb.bounds.max.y < top || wb.bounds.min.y > bottom) continue;
        if (wb.bounds.min.x < 0 || wb.bounds.max.x > W) continue;
        ctx.fillStyle = '#94a3b8';
        poly(wb.vertices); ctx.fill(); ctx.stroke();
      }
      // 나머지 회전체
      for (i = 0; i < c.spinners.length; i++) {
        var sp = c.spinners[i];
        if (sp === f || sp.bounds.max.y < top || sp.bounds.min.y > bottom) continue;
        drawSpinner(sp, '#f472b6');
      }
      // 게이트
      if (!race.started) {
        var gt = c.gate;
        ctx.fillStyle = '#fbbf24';
        poly(gt.vertices); ctx.fill();
        ctx.fillStyle = '#78350f';
        for (var x = 0; x < W; x += 40) ctx.fillRect(x + 8, 232, 20, 4);
      }
      // 골 라인 (체크무늬) — 통로 안
      if (GOAL_Y + 40 > top && GOAL_Y - 40 < bottom) {
        var sq = 11, gx0 = W / 2 - CHUTE_HALF;
        for (var gx = 0; gx < 4; gx++) {
          for (var gy = 0; gy < 2; gy++) {
            ctx.fillStyle = ((gx + gy) % 2 === 0) ? '#f8fafc' : '#0f172a';
            ctx.fillRect(gx0 + gx * sq, GOAL_Y + gy * sq, sq, sq);
          }
        }
        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 22px "Jua", "Noto Sans KR", sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('GOAL', W / 2, GOAL_Y + 60);
      }
      // 벽
      ctx.fillStyle = '#334155';
      ctx.fillRect(-40, top, 40, bottom - top);
      ctx.fillRect(W, top, 40, bottom - top);
    }

    function drawMarbles(v) {
      var focus = race.started && !race.done ? race.focus : null;
      var fontPx = Math.max(11, Math.round(14 / Math.sqrt(cam.zoom)));   // 줌인하면 이름표를 조금 작게
      ctx.font = 'bold ' + fontPx + 'px "Noto Sans KR", "Jua", sans-serif';
      ctx.textBaseline = 'middle';
      for (var i = 0; i < race.marbles.length; i++) {
        var m = race.marbles[i];
        if (m.finished) continue;
        var p = m.body.position;
        if (p.y < v.top - 40 || p.y > v.top + v.viewH + 40) continue;
        // 그림자
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath(); ctx.arc(p.x + 2, p.y + 3, MARBLE_R, 0, Math.PI * 2); ctx.fill();
        // 본체
        var g = ctx.createRadialGradient(p.x - 4, p.y - 5, 2, p.x, p.y, MARBLE_R);
        g.addColorStop(0, '#ffffff'); g.addColorStop(0.25, m.color); g.addColorStop(1, shade(m.color, -45));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, MARBLE_R, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
        ctx.stroke();
        // 이름표
        var tx = p.x + MARBLE_R + 4, align = 'left';
        if (p.x > W - 110) { tx = p.x - MARBLE_R - 4; align = 'right'; }
        ctx.textAlign = align;
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(2,6,23,0.9)'; ctx.lineJoin = 'round';
        ctx.strokeText(m.name, tx, p.y);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(m.name, tx, p.y);
        if (m === focus) {
          ctx.font = '16px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText('👑', p.x, p.y - MARBLE_R - 10);
          ctx.font = 'bold ' + fontPx + 'px "Noto Sans KR", "Jua", sans-serif';
        }
      }
    }

    // 도착 자막: 통로 안(골 라인 위)에 최신 것이 아래, 먼저 온 것이 위로 쌓인다
    function drawEffects(v) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var px = Math.round(26 / Math.sqrt(cam.zoom));
      var line = px * 1.25;
      var n = race.effects.length;
      for (var i = 0; i < n; i++) {
        var e = race.effects[i];
        var k = e.t / 2200;
        var alpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
        var pop = e.t < 150 ? 1 + 0.4 * (1 - e.t / 150) : 1;
        var y = GOAL_Y - 30 - (n - 1 - i) * line;
        var x = W / 2;
        ctx.globalAlpha = alpha;
        ctx.font = 'bold ' + Math.round((e.cut ? px + 4 : px) * pop) + 'px "Jua", "Noto Sans KR", sans-serif';
        ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(2,6,23,0.9)'; ctx.lineJoin = 'round';
        ctx.strokeText(e.text, x, y);
        ctx.fillStyle = e.cut ? '#fbbf24' : e.color;
        ctx.fillText(e.text, x, y);
        ctx.globalAlpha = 1;
      }
    }

    // 화면 좌표에 그리는 오버레이: 슬로모션 표시
    function drawOverlay() {
      if (race.cutActive) {
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.font = 'bold 22px "Jua", "Noto Sans KR", sans-serif';
        var label = '⚡ 커트라인 ' + race.cutActive + '등  ×' + race.timeScale.toFixed(1);
        var tw = ctx.measureText(label).width + 28;
        ctx.fillStyle = 'rgba(15,23,42,0.8)';
        roundRect((size.w - tw) / 2, 44, tw, 36, 10); ctx.fill();
        ctx.fillStyle = '#fbbf24';
        ctx.fillText(label, size.w / 2, 51);
      }
    }

    function drawMinimap(v) {
      var mw = 14, mh = size.h - 24, my = 12;
      var s0 = baseScale();
      var fullLeft = (size.w - W * s0) / 2;
      // 줌 없는 기본 배율에서 코스 오른쪽 여백이 충분하면 코스 바로 옆에, 아니면 화면 오른쪽 끝에
      var mx = (fullLeft >= 48 * s0 + 12) ? Math.round(fullLeft + (W + 40) * s0 + 12) : size.w - mw - 10;
      ctx.fillStyle = 'rgba(15,23,42,0.75)';
      roundRect(mx - 3, my - 3, mw + 6, mh + 6, 6); ctx.fill();
      // 현재 화면 영역
      ctx.fillStyle = 'rgba(251,191,36,0.35)';
      ctx.fillRect(mx, my + (Math.max(0, v.top) / H) * mh, mw, (Math.min(v.viewH, H) / H) * mh);
      // 필터 / 골 라인
      ctx.fillStyle = '#fb7185';
      ctx.fillRect(mx, my + (FILTER_Y / H) * mh, mw, 2);
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(mx, my + (GOAL_Y / H) * mh, mw, 2);
      for (var i = 0; i < race.marbles.length; i++) {
        var m = race.marbles[i];
        if (m.finished) continue;
        var p = m.body.position;
        ctx.fillStyle = m.color;
        ctx.beginPath(); ctx.arc(mx + (p.x / W) * mw, my + (p.y / H) * mh, 2.5, 0, Math.PI * 2); ctx.fill();
      }
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
    }

    function shade(hex, amt) {
      var n = parseInt(hex.slice(1), 16);
      if (isNaN(n)) return hex;
      var r = Math.max(0, Math.min(255, (n >> 16) + amt));
      var g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
      var b = Math.max(0, Math.min(255, (n & 255) + amt));
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    }

    function draw(dt) {
      if (canvas.width === 0) resize();
      updateCamera(dt);
      var v = view();
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      // 배경
      var bg = ctx.createLinearGradient(0, 0, 0, size.h);
      bg.addColorStop(0, '#1e1b4b'); bg.addColorStop(1, '#0f172a');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, size.w, size.h);
      // 월드 변환 (화면 가운데 = cam.cx, cam.cy)
      ctx.save();
      ctx.translate(size.w / 2 - cam.cx * v.scale, size.h / 2 - cam.cy * v.scale);
      ctx.scale(v.scale, v.scale);
      // 코스 바깥(좌우 여백)은 살짝 어둡게, 코스 바닥은 살짝 밝게
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(v.left - 10, v.top - 50, -v.left + 10 - 40, v.viewH + 100);
      ctx.fillRect(W + 40, v.top - 50, v.left + v.viewW - W, v.viewH + 100);
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(0, v.top - 50, W, v.viewH + 100);
      drawCourse(v);
      drawMarbles(v);
      drawEffects(v);
      ctx.restore();
      drawMinimap(v);
      drawOverlay();
    }

    return { resize: resize, draw: draw, camera: cam, size: size };
  }

  // 튜닝용 (tools/simulate.js 에서 환경변수로 바꿔 가며 비교한다)
  function tune(o) {
    if (o.filterOmega != null) FILTER_OMEGA = o.filterOmega;
    if (o.filterDir != null) FILTER_DIR = o.filterDir;
    if (o.filterLen != null) FILTER_LEN = o.filterLen;
    if (o.chuteHalf != null) CHUTE_HALF = o.chuteHalf;
    if (o.gravity != null) GRAVITY = o.gravity;
  }

  return {
    W: W, H: H, GOAL_Y: GOAL_Y, FILTER_Y: FILTER_Y, MARBLE_R: MARBLE_R,
    get CHUTE_HALF() { return CHUTE_HALF; },
    tune: tune,
    makeRng: makeRng, buildCourse: buildCourse, createRace: createRace, createRenderer: createRenderer
  };
});
