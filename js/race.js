/*
 * race.js — 마블 레이스 엔진 (물리 + 렌더링)
 * 브라우저에서는 window.MarbleRace, Node에서는 module.exports 로 노출된다.
 * 물리는 Matter.js(vendor/matter.min.js) 고정 스텝(120Hz)으로 돌려 기기 성능과 무관하게 같은 결과를 낸다.
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
  var H = 3120;                // 월드 높이 (px)
  var GOAL_Y = 3010;           // 이 선을 넘으면 도착
  var MARBLE_R = 12;           // 구슬 반지름
  var SUBSTEP = 1000 / 120;    // 물리 스텝 (ms)
  var GRAVITY = 0.7;           // 1.0이면 레이스가 너무 빨리 끝난다 (20명 기준 17초) — 0.7이면 약 20~24초
  var MAX_RACE_MS = 120000;    // 안전장치: 이 시간이 지나면 남은 구슬은 진행도 순으로 강제 도착
  var STUCK_MS = 1000;         // 이 시간 동안 거의 안 움직이면 살짝 밀어준다
  var STUCK_SPEED = 0.12;      // px / substep (≈ 14 px/s)

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

  // ---------- 코스 ----------
  function buildCourse(rng) {
    var statics = [];
    var course = { walls: [], slopes: [], pegs: [], bumpers: [], spinners: [], gate: null, goalY: GOAL_Y, W: W, H: H };

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
    function spinner(cx, cy, bars, len, omega) {
      var parts = [Bodies.circle(cx, cy, 14)];
      for (var i = 0; i < bars; i++) {
        parts.push(Bodies.rectangle(cx, cy, len * 2, 12, { angle: Math.PI * i / bars, chamfer: { radius: 5 } }));
      }
      var b = Body.create({ parts: parts, isStatic: true, friction: 0.05, restitution: 0.6, label: 'spinner' });
      Body.setPosition(b, { x: cx, y: cy });
      Body.setAngle(b, rng() * Math.PI * 2);
      b.plugin.omega = omega; // rad/s (부호 = 방향)
      b.plugin.len = len;
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

    // 마지막 깔때기 (출구 160)
    slope(-20, 2780, 240, 2920);
    slope(W + 20, 2780, 400, 2920);

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
  function createRace(opts) {
    var names = opts.names.slice();
    var colors = opts.colors || [];
    var seed = (opts.seed != null) ? opts.seed : Math.floor(Math.random() * 0xffffffff);
    var rng = makeRng(seed);

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
               finished: false, rank: 0, finishTime: 0, stillMs: 0, nudges: 0 };
    });
    Composite.add(engine.world, marbles.map(function (m) { return m.body; }));

    var race = {
      seed: seed, course: course, engine: engine, marbles: marbles,
      names: names, started: false, done: false, time: 0, finished: [],
      stats: { nudges: 0, forced: 0, steps: 0 },
      onFinish: null, onHit: null, onNudge: null,
      effects: []
    };
    var acc = 0;

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

    function finishMarble(m, forced) {
      m.finished = true;
      m.rank = race.finished.length + 1;
      m.finishTime = race.time;
      race.finished.push(m);
      Composite.remove(engine.world, m.body);
      if (forced) race.stats.forced++;
      race.effects.push({ type: 'finish', x: m.body.position.x, y: GOAL_Y - 20, text: m.rank + '등 ' + m.name, color: m.color, t: 0 });
      if (race.finished.length === marbles.length) race.done = true;   // onFinish 안에서 race.done을 볼 수 있도록 먼저 설정
      if (race.onFinish) race.onFinish(m, m.rank, forced);
    }

    function step() {
      // 회전체 돌리기 (정적 몸체를 각도만 바꿔 돌리면 접촉 속도에 회전이 반영된다)
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

      if (!race.done && race.time >= MAX_RACE_MS) {
        // 안전장치: 남은 구슬을 진행도(아래쪽) 순으로 도착 처리
        marbles.filter(function (m) { return !m.finished; })
          .sort(function (a, b) { return b.body.position.y - a.body.position.y; })
          .forEach(function (m) { finishMarble(m, true); });
      }
    }

    // ms 만큼 레이스 시간을 진행 (고정 스텝 누적)
    race.update = function (ms) {
      if (race.done) return;
      acc += ms;
      var n = 0;
      while (acc >= SUBSTEP && n < 64) { step(); acc -= SUBSTEP; n++; if (race.done) break; }
      if (n >= 64) acc = 0;
      // 이펙트 수명
      for (var i = race.effects.length - 1; i >= 0; i--) {
        race.effects[i].t += ms;
        if (race.effects[i].t > 1800) race.effects.splice(i, 1);
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
    var cam = { y: 0 };   // 카메라: 선두 구슬을 따라 내려간다
    var size = { w: 0, h: 0, dpr: 1 };

    function resize() {
      var rect = canvas.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      size.w = Math.max(1, Math.round(rect.width));
      size.h = Math.max(1, Math.round(rect.height));
      size.dpr = dpr;
      canvas.width = Math.round(size.w * dpr);
      canvas.height = Math.round(size.h * dpr);
    }

    // 화면 폭에 맞추되, 세로로 최소 MIN_VIEW_H(월드 px)는 보이도록 배율을 제한하고 가운데 정렬
    var MIN_VIEW_H = 680;
    function view() {
      var scale = Math.min(size.w / W, size.h / MIN_VIEW_H);
      return { scale: scale, x: (size.w - W * scale) / 2, y: -cam.y * scale, viewH: size.h / scale };
    }

    function updateCamera(dt) {
      var v = view();
      var target;
      var leader = race.started ? race.getLeader() : null;
      if (leader) target = leader.body.position.y - v.viewH * 0.38;
      else target = race.done ? (GOAL_Y - v.viewH * 0.6) : 0;
      target = Math.max(0, Math.min(H - v.viewH, target));
      var k = 1 - Math.pow(0.001, dt / 1000);   // 부드러운 추적
      cam.y += (target - cam.y) * k;
    }

    function poly(verts) {
      ctx.beginPath();
      ctx.moveTo(verts[0].x, verts[0].y);
      for (var i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
      ctx.closePath();
    }

    function drawCourse(v) {
      var c = race.course;
      var top = cam.y - 50, bottom = cam.y + v.viewH + 50;
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
      // 경사로 / 깔때기
      ctx.fillStyle = '#94a3b8';
      ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 2;
      for (i = 0; i < c.slopes.length; i++) {
        var s = c.slopes[i];
        if (s.bounds.max.y < top || s.bounds.min.y > bottom) continue;
        poly(s.vertices); ctx.fill(); ctx.stroke();
      }
      // 회전체
      for (i = 0; i < c.spinners.length; i++) {
        var sp = c.spinners[i];
        if (sp.bounds.max.y < top || sp.bounds.min.y > bottom) continue;
        ctx.fillStyle = '#f472b6'; ctx.strokeStyle = '#fbcfe8'; ctx.lineWidth = 2;
        for (var k = 2; k < sp.parts.length; k++) { poly(sp.parts[k].vertices); ctx.fill(); ctx.stroke(); }
        ctx.fillStyle = '#fdf2f8';
        ctx.beginPath(); ctx.arc(sp.position.x, sp.position.y, 14, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#db2777';
        ctx.beginPath(); ctx.arc(sp.position.x, sp.position.y, 5, 0, Math.PI * 2); ctx.fill();
      }
      // 게이트
      if (!race.started) {
        var gt = c.gate;
        ctx.fillStyle = '#fbbf24';
        poly(gt.vertices); ctx.fill();
        ctx.fillStyle = '#78350f';
        for (var x = 0; x < W; x += 40) ctx.fillRect(x + 8, 232, 20, 4);
      }
      // 골 라인 (체크무늬)
      if (GOAL_Y + 40 > top && GOAL_Y - 40 < bottom) {
        var sq = 16;
        for (var gx = 0; gx < W; gx += sq) {
          for (var gy = 0; gy < 2; gy++) {
            ctx.fillStyle = ((gx / sq + gy) % 2 === 0) ? '#f8fafc' : '#0f172a';
            ctx.fillRect(gx, GOAL_Y + gy * sq, sq, sq);
          }
        }
        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 28px "Jua", "Noto Sans KR", sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('GOAL', W / 2, GOAL_Y + 70);
      }
      // 벽
      ctx.fillStyle = '#334155';
      ctx.fillRect(-40, top, 40, bottom - top);
      ctx.fillRect(W, top, 40, bottom - top);
    }

    function drawMarbles(v) {
      var leader = race.started && !race.done ? race.getLeader() : null;
      ctx.font = 'bold 14px "Noto Sans KR", "Jua", sans-serif';
      ctx.textBaseline = 'middle';
      for (var i = 0; i < race.marbles.length; i++) {
        var m = race.marbles[i];
        if (m.finished) continue;
        var p = m.body.position;
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
        if (m === leader) {
          ctx.font = '16px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText('👑', p.x, p.y - MARBLE_R - 10);
          ctx.font = 'bold 14px "Noto Sans KR", "Jua", sans-serif';
        }
      }
    }

    function drawEffects() {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (var i = 0; i < race.effects.length; i++) {
        var e = race.effects[i];
        var k = e.t / 1800;
        var alpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
        var y = e.y - k * 70;
        var x = Math.max(80, Math.min(W - 80, e.x));
        ctx.globalAlpha = alpha;
        ctx.font = 'bold 26px "Jua", "Noto Sans KR", sans-serif';
        ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(2,6,23,0.9)'; ctx.lineJoin = 'round';
        ctx.strokeText(e.text, x, y);
        ctx.fillStyle = e.color;
        ctx.fillText(e.text, x, y);
        ctx.globalAlpha = 1;
      }
    }

    function drawMinimap(v) {
      var mw = 14, mh = size.h - 24, my = 12;
      // 코스 오른쪽 여백이 충분하면 코스 바로 옆에, 아니면 화면 오른쪽 끝에
      var mx = (v.x >= 48 * v.scale + 12) ? Math.round(v.x + (W + 40) * v.scale + 12) : size.w - mw - 10;
      ctx.fillStyle = 'rgba(15,23,42,0.75)';
      roundRect(mx - 3, my - 3, mw + 6, mh + 6, 6); ctx.fill();
      // 현재 화면 영역
      ctx.fillStyle = 'rgba(251,191,36,0.35)';
      ctx.fillRect(mx, my + (cam.y / H) * mh, mw, (v.viewH / H) * mh);
      // 골 라인
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
      // 코스 바깥(좌우 여백)은 살짝 어둡게
      if (v.x > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fillRect(0, 0, v.x, size.h);
        ctx.fillRect(size.w - v.x, 0, v.x, size.h);
      }
      // 월드 변환
      ctx.save();
      ctx.translate(v.x, v.y);
      ctx.scale(v.scale, v.scale);
      // 코스 바닥 (약간 밝은 레인)
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(0, cam.y - 50, W, v.viewH + 100);
      drawCourse(v);
      drawMarbles(v);
      drawEffects();
      ctx.restore();
      drawMinimap(v);
    }

    return { resize: resize, draw: draw, camera: cam, size: size };
  }

  return {
    W: W, H: H, GOAL_Y: GOAL_Y, MARBLE_R: MARBLE_R,
    makeRng: makeRng, buildCourse: buildCourse, createRace: createRace, createRenderer: createRenderer
  };
});
