/*
 * app.js — 화면 흐름: 설정 → 1단계(선생님 순위) → 2단계(학생 배정) → 결과
 */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  var QA = /[?&]qa=1/.test(location.search);           // 테스트 훅: 속도 8배, 카운트다운 생략, 무음
  var STORAGE_KEY = 'marble-assign.v1';

  var TEACHER_COLORS = ['#f43f5e', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#14b8a6'];
  var SAMPLE_TEACHERS = ['김선생', '이선생', '박선생', '최선생'];
  var SAMPLE_STUDENTS = ['민준', '서준', '도윤', '예준', '시우', '하준', '주원', '지호', '지후', '준서',
                         '서연', '서윤', '지우', '서현', '하은', '하윤', '민서', '지유', '윤서', '채원'];

  var state = {
    teachers: [], students: [], sizes: [],
    speed: 1, sound: true,
    stage: 'setup',            // setup | teachers | students | result
    teacherOrder: [],          // 1단계 결과: 순위순 선생님 이름
    teacherColorByName: {},
    assignments: [],           // 2단계 결과: assignments[i] = i등 선생님에게 배정된 학생 [{name, rank}]
    race: null, renderer: null, raf: 0, lastT: 0, running: false
  };

  // ---------- 유틸 ----------
  function parseNames(text) {
    var seen = {};
    return text.split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (n) {
      if (seen[n]) { seen[n]++; return n + '(' + seen[n] + ')'; }
      seen[n] = 1; return n;
    });
  }
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    var k = function (n) { return (n + h / 30) % 12; };
    var a = s * Math.min(l, 1 - l);
    var f = function (n) { return l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); };
    var to = function (x) { return Math.round(255 * x).toString(16).padStart(2, '0'); };
    return '#' + to(f(0)) + to(f(8)) + to(f(4));
  }
  function studentColors(n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(hslToHex((i * 137.508) % 360, 80, 60));
    return out;
  }
  function autoSizes(n, t) {
    var base = Math.floor(n / t), extra = n % t, out = [];
    for (var i = 0; i < t; i++) out.push(base + (i < extra ? 1 : 0));
    return out;
  }
  function parseManualSizes(text, t, n) {
    var s = text.trim();
    if (!s) return { sizes: null };
    var nums = s.split(/[\s,·]+/).filter(Boolean).map(Number);
    if (nums.some(function (x) { return !Number.isInteger(x) || x < 0; })) return { error: '인원은 0 이상의 정수로 적어 주세요.' };
    if (nums.length !== t) return { error: '선생님 수(' + t + '명)만큼 인원을 적어 주세요. (지금 ' + nums.length + '개)' };
    var sum = nums.reduce(function (a, b) { return a + b; }, 0);
    if (sum !== n) return { error: '인원 합계(' + sum + ')가 학생 수(' + n + ')와 달라요.' };
    return { sizes: nums };
  }
  function teacherIndexForRank(rank, sizes) {
    var acc = 0;
    for (var i = 0; i < sizes.length; i++) { acc += sizes[i]; if (rank <= acc) return i; }
    return sizes.length - 1;
  }
  function rankLabel(i) { return (i + 1) + '등'; }
  function medal(i) { return i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '등'; }
  function show(id) {
    ['#screen-setup', '#screen-race', '#screen-result'].forEach(function (s) { $(s).hidden = (s !== id); });
    $('#btn-home').hidden = (id === '#screen-setup');
    $('#stage-badge').hidden = (id === '#screen-setup');
  }
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._h); toast._h = setTimeout(function () { t.hidden = true; }, 1800);
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        teachers: $('#teachers').value, students: $('#students').value, manual: $('#manual-sizes').value,
        sound: state.sound, speed: state.speed
      }));
    } catch (e) { /* 사생활 모드 등에서는 저장이 안 될 수 있다 */ }
  }
  function load() {
    try {
      var d = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!d) return;
      $('#teachers').value = d.teachers || '';
      $('#students').value = d.students || '';
      $('#manual-sizes').value = d.manual || '';
      state.sound = d.sound !== false;
      state.speed = [1, 2, 4].indexOf(d.speed) >= 0 ? d.speed : 1;
    } catch (e) { /* ignore */ }
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px';
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  // ---------- 효과음 (WebAudio, 외부 파일 없음) ----------
  var audio = { ctx: null, lastTick: 0 };
  function ensureAudio() {
    if (audio.ctx || !state.sound || QA) return;
    try { audio.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio.ctx = null; }
  }
  function tone(freq, dur, type, gain, when) {
    var c = audio.ctx; if (!c || !state.sound) return;
    if (c.state === 'suspended') c.resume();
    var t0 = c.currentTime + (when || 0);
    var o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain || 0.08, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  var sfx = {
    hit: function (kind, v) {
      if (!audio.ctx || !state.sound) return;
      var now = performance.now();
      if (kind === 'peg' || kind === 'wall' || kind === 'slope' || kind === 'gate') {
        if (now - audio.lastTick < 45 || v < 1.2) return;
        audio.lastTick = now;
        tone(900 + Math.random() * 900, 0.04, 'triangle', Math.min(0.06, 0.015 + v * 0.006));
      } else if (kind === 'bumper') {
        tone(220, 0.12, 'square', 0.06); tone(440, 0.08, 'square', 0.04, 0.03);
      } else if (kind === 'spinner') {
        if (now - audio.lastTick < 60) return;
        audio.lastTick = now; tone(520, 0.06, 'sawtooth', 0.04);
      } else if (kind === 'marble') {
        if (now - audio.lastTick < 45 || v < 1.5) return;
        audio.lastTick = now; tone(1500 + Math.random() * 600, 0.03, 'sine', 0.03);
      }
    },
    finish: function (rank, cut) {
      var base = rank <= 3 ? 660 : 523;
      tone(base, 0.18, 'sine', 0.12); tone(base * 1.5, 0.28, 'sine', 0.12, 0.12);
      if (cut) tone(base * 2, 0.35, 'triangle', 0.1, 0.26);   // 커트라인 확정은 한 음 더
    },
    count: function (last) { tone(last ? 880 : 440, last ? 0.5 : 0.15, 'square', 0.08); },
    fanfare: function () { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.35, 'triangle', 0.1, i * 0.12); }); }
  };

  // ---------- 설정 화면 ----------
  function readSetup() {
    state.teachers = parseNames($('#teachers').value);
    state.students = parseNames($('#students').value);
    $('#teacher-count').textContent = state.teachers.length + '명';
    $('#student-count').textContent = state.students.length + '명';
    var err = $('#setup-error'); err.hidden = true;
    var t = state.teachers.length, n = state.students.length;
    if (t === 0 || n === 0) { $('#auto-sizes').textContent = '—'; $('#rule-preview').textContent = '선생님과 학생 이름을 넣으면 배정 인원이 계산돼요.'; return false; }
    var auto = autoSizes(n, t);
    $('#auto-sizes').textContent = auto.join(' · ') + ' 명';
    var manual = parseManualSizes($('#manual-sizes').value, t, n);
    if (manual.error) { err.textContent = manual.error; err.hidden = false; state.sizes = auto; }
    else state.sizes = manual.sizes || auto;
    var parts = [], acc = 0;
    for (var i = 0; i < t; i++) {
      var from = acc + 1; acc += state.sizes[i];
      parts.push(rankLabel(i) + ' 선생님 ← 학생 ' + (state.sizes[i] === 0 ? '없음' : (from === acc ? from + '등' : from + '~' + acc + '등')));
    }
    $('#rule-preview').textContent = parts.join('  |  ');
    if (n > 40) { err.textContent = '학생은 40명까지가 적당해요. (지금 ' + n + '명)'; err.hidden = false; }
    return !manual.error && n <= 40;
  }

  function fillSample() {
    $('#teachers').value = SAMPLE_TEACHERS.join('\n');
    $('#students').value = SAMPLE_STUDENTS.join('\n');
    readSetup(); save();
  }

  // ---------- 레이스 루프 ----------
  function startLoop() {
    if (state.running) return;
    state.running = true; state.lastT = performance.now();
    var frame = function (now) {
      if (!state.running) return;
      var dt = Math.min(100, now - state.lastT); state.lastT = now;
      if (state.race) state.race.update(dt * (QA ? 8 : state.speed));
      if (state.renderer) state.renderer.draw(dt);
      state.raf = requestAnimationFrame(frame);
    };
    state.raf = requestAnimationFrame(frame);
  }
  function stopLoop() { state.running = false; cancelAnimationFrame(state.raf); }

  var resizeObs = null;
  function setupRenderer() {
    var canvas = $('#race-canvas');
    state.renderer = MarbleRace.createRenderer(canvas, state.race);
    state.renderer.resize();
    if (!resizeObs && window.ResizeObserver) {
      resizeObs = new ResizeObserver(function () { if (state.renderer) state.renderer.resize(); });
      resizeObs.observe($('#stage'));
    }
  }

  function setSpeedChips() {
    $$('.speed-chip').forEach(function (b) { b.classList.toggle('active', Number(b.dataset.speed) === state.speed); });
    $('#btn-sound').textContent = state.sound ? '🔊' : '🔇';
    $('#btn-sound').classList.toggle('active', state.sound);
  }

  // ---------- 1단계: 선생님 ----------
  function beginTeacherStage() {
    state.stage = 'teachers';
    show('#screen-race');
    $('#stage-badge').textContent = '1단계 · 선생님 순위';
    $('#hud-title').textContent = '1단계 · 선생님 순위 정하기';
    $('#panel-title').textContent = '선생님 순위';
    $('#panel-sub').textContent = '먼저 들어오는 순서대로 1등, 2등… 1등 선생님이 학생 1등부터 받아요.';
    state.teacherColorByName = {};
    state.teachers.forEach(function (n, i) { state.teacherColorByName[n] = TEACHER_COLORS[i % TEACHER_COLORS.length]; });

    var board = $('#board'); board.innerHTML = '';
    var entrants = document.createElement('div'); entrants.className = 'entrants';
    state.teachers.forEach(function (n) {
      var e = document.createElement('span'); e.className = 'entrant'; e.dataset.name = n;
      e.innerHTML = '<span class="dot" style="background:' + state.teacherColorByName[n] + '"></span>' + escapeHtml(n);
      entrants.appendChild(e);
    });
    board.appendChild(entrants);
    state.teachers.forEach(function (_, i) {
      var row = document.createElement('div'); row.className = 'rank-row'; row.dataset.rank = i + 1;
      row.innerHTML = '<span class="rank">' + (i + 1) + '등</span><span class="empty">도착 대기 중…</span>';
      board.appendChild(row);
    });
    state.teacherOrder = [];
    // 선생님 레이스는 모든 등수가 커트라인 (마지막 한 명은 자동 확정)
    var cuts = [];
    for (var c = 1; c < state.teachers.length; c++) cuts.push(c);
    launchRace(state.teachers, state.teachers.map(function (n) { return state.teacherColorByName[n]; }), { cutRanks: cuts }, function (m, rank) {
      state.teacherOrder.push(m.name);
      var row = board.querySelector('.rank-row[data-rank="' + rank + '"]');
      row.classList.add('filled');
      row.innerHTML = '<span class="rank">' + medal(rank - 1) + '</span><span class="dot" style="background:' + m.color + '"></span><span class="name">' + escapeHtml(m.name) + '</span>';
      var ent = board.querySelector('.entrant[data-name="' + cssEscape(m.name) + '"]'); if (ent) ent.classList.add('done');
      $('#hud-progress').textContent = rank + ' / ' + state.teachers.length + ' 도착';
    }, function () {
      var next = $('#btn-next');
      next.textContent = '2단계: 학생 배정 레이스 ▶'; next.hidden = false;
      next.onclick = function () { beginStudentStage(); };
      $('#btn-rerun').hidden = false; $('#btn-rerun').onclick = function () { beginTeacherStage(); };
    });
  }

  // ---------- 2단계: 학생 ----------
  function beginStudentStage() {
    state.stage = 'students';
    show('#screen-race');
    $('#stage-badge').textContent = '2단계 · 학생 배정';
    $('#hud-title').textContent = '2단계 · 학생 배정 레이스';
    $('#panel-title').textContent = '배정 현황';
    $('#panel-sub').textContent = '도착 순서대로 1등 선생님부터 차례로 들어가요. 선생님이 바뀌는 등수는 골 앞 필터에서 슬로모션으로!';
    state.assignments = state.teacherOrder.map(function () { return []; });

    var board = $('#board'); board.innerHTML = '';
    var cards = state.teacherOrder.map(function (tname, i) {
      var card = document.createElement('div'); card.className = 'team'; card.dataset.index = i;
      var color = state.teacherColorByName[tname];
      var slots = '';
      for (var s = 0; s < state.sizes[i]; s++) slots += '<span class="slot" data-slot="' + s + '">' + (s + 1) + '</span>';
      card.innerHTML = '<div class="team-head"><span class="medal">' + medal(i) + '</span><span class="dot" style="background:' + color + '"></span>' +
        '<span class="tname">' + escapeHtml(tname) + '</span><span class="cap">0 / ' + state.sizes[i] + '</span></div>' +
        '<div class="slots">' + (slots || '<span class="slot">배정 없음</span>') + '</div>';
      board.appendChild(card);
      return card;
    });
    function highlightNext(rank) {
      cards.forEach(function (c) { c.classList.remove('active'); });
      $$('.slot.next').forEach(function (s) { s.classList.remove('next'); });
      if (rank > state.students.length) return;
      var ti = teacherIndexForRank(rank, state.sizes);
      var card = cards[ti]; card.classList.add('active');
      var slot = card.querySelector('.slot[data-slot="' + state.assignments[ti].length + '"]');
      if (slot) { slot.classList.add('next'); slot.scrollIntoView({ block: 'nearest' }); }
    }
    highlightNext(1);

    var colors = studentColors(state.students.length);
    // 커트라인: 1등 + 선생님이 바뀌는 경계 등수 (예: 5·5·5·5 → 1, 5, 10, 15). 여기서만 슬로모션이 걸린다
    var cuts = [1], acc = 0;
    for (var c = 0; c < state.sizes.length - 1; c++) { acc += state.sizes[c]; if (acc > 0 && acc < state.students.length) cuts.push(acc); }
    launchRace(state.students, colors, {
      cutRanks: cuts,
      rankLabel: function (rank) { return '→ ' + state.teacherOrder[teacherIndexForRank(rank, state.sizes)]; }
    }, function (m, rank) {
      var ti = teacherIndexForRank(rank, state.sizes);
      var list = state.assignments[ti];
      list.push({ name: m.name, rank: rank, color: m.color });
      var card = cards[ti];
      var slot = card.querySelector('.slot[data-slot="' + (list.length - 1) + '"]');
      if (slot) {
        slot.classList.add('filled'); slot.classList.remove('next');
        slot.innerHTML = '<span class="dot" style="background:' + m.color + '"></span>' + escapeHtml(m.name) + '<span class="r">' + rank + '등</span>';
      }
      card.querySelector('.cap').textContent = list.length + ' / ' + state.sizes[ti];
      $('#hud-progress').textContent = rank + ' / ' + state.students.length + ' 도착';
      highlightNext(rank + 1);
    }, function () {
      var next = $('#btn-next');
      next.textContent = '배정 결과 보기 ▶'; next.hidden = false;
      next.onclick = function () { showResult(); };
      $('#btn-rerun').hidden = false; $('#btn-rerun').onclick = function () { beginStudentStage(); };
    });
  }

  // ---------- 공통: 레이스 띄우기 ----------
  function launchRace(names, colors, raceOpts, onFinish, onDone) {
    teardownRace();
    $('#btn-next').hidden = true; $('#btn-rerun').hidden = true;
    $('#hud-progress').textContent = '0 / ' + names.length + ' 도착';
    $('#countdown').hidden = true;
    setSpeedChips();

    var race = MarbleRace.createRace({ names: names, colors: colors, cutRanks: raceOpts.cutRanks, rankLabel: raceOpts.rankLabel });
    state.race = race;
    race.onHit = sfx.hit;
    race.onFinish = function (m, rank) {
      sfx.finish(rank, raceOpts.cutRanks && raceOpts.cutRanks.indexOf(rank) >= 0);
      onFinish(m, rank);
      if (race.done) { sfx.fanfare(); onDone(); if (QA) window.__qa.doneCount++; }
    };
    setupRenderer();
    state.renderer.camera.y = 0;
    var go = $('#btn-go'); go.hidden = false;
    go.onclick = function () {
      ensureAudio();
      go.hidden = true;
      if (QA) { race.start(); return; }
      var cd = $('#countdown'); var n = 3;
      var tick = function () {
        if (n === 0) { cd.hidden = true; race.start(); return; }
        cd.textContent = n; cd.hidden = false; sfx.count(false);
        n--; setTimeout(tick, 900);
      };
      tick();
    };
    startLoop();
    if (QA) { window.__qa.race = race; window.__qa.autoStart && go.onclick(); }
  }

  function teardownRace() {
    if (state.race) { state.race.destroy(); state.race = null; }
    state.renderer = null;
  }

  // ---------- 결과 ----------
  function showResult() {
    state.stage = 'result';
    stopLoop(); teardownRace();
    show('#screen-result');
    $('#stage-badge').textContent = '배정 결과';
    var grid = $('#result-grid'); grid.innerHTML = '';
    state.teacherOrder.forEach(function (tname, i) {
      var card = document.createElement('div'); card.className = 'result-card';
      card.style.setProperty('--tcolor', state.teacherColorByName[tname]);
      var items = state.assignments[i].map(function (s) {
        return '<li><span class="r">' + s.rank + '등</span><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + s.color + '"></span>' + escapeHtml(s.name) + '</li>';
      }).join('');
      card.innerHTML = '<h3>' + medal(i) + ' ' + escapeHtml(tname) + '</h3><div class="sub">' + state.assignments[i].length + '명</div><ol>' + (items || '<li>배정된 학생 없음</li>') + '</ol>';
      grid.appendChild(card);
    });
    if (QA) window.__qa.result = { teacherOrder: state.teacherOrder.slice(), assignments: state.assignments.map(function (a) { return a.slice(); }), sizes: state.sizes.slice() };
  }

  function resultAsTable() {
    var maxLen = Math.max.apply(null, state.assignments.map(function (a) { return a.length; }).concat([0]));
    var rows = [state.teacherOrder.map(function (t, i) { return (i + 1) + '등 ' + t; })];
    for (var r = 0; r < maxLen; r++) {
      rows.push(state.assignments.map(function (a) { return a[r] ? a[r].name : ''; }));
    }
    return rows.map(function (row) { return row.join('\t'); }).join('\n');
  }
  function resultAsText() {
    return state.teacherOrder.map(function (t, i) {
      return (i + 1) + '등 ' + t + ' (' + state.assignments[i].length + '명): ' + state.assignments[i].map(function (s) { return s.name; }).join(', ');
    }).join('\n');
  }

  // ---------- 시작 흐름 ----------
  function startFlow() {
    if (!readSetup()) {
      if (state.teachers.length === 0 || state.students.length === 0) { var e = $('#setup-error'); e.textContent = '선생님과 학생 이름을 모두 넣어 주세요.'; e.hidden = false; }
      return;
    }
    save();
    ensureAudio();
    if (state.teachers.length === 1) {
      // 선생님이 한 명이면 순위 레이스가 필요 없다
      state.teacherColorByName = {}; state.teacherColorByName[state.teachers[0]] = TEACHER_COLORS[0];
      state.teacherOrder = state.teachers.slice();
      beginStudentStage();
    } else {
      beginTeacherStage();
    }
  }
  function goHome() {
    stopLoop(); teardownRace();
    state.stage = 'setup';
    show('#screen-setup');
    readSetup();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

  // ---------- 이벤트 ----------
  function bind() {
    ['#teachers', '#students', '#manual-sizes'].forEach(function (sel) {
      $(sel).addEventListener('input', function () { readSetup(); save(); });
    });
    $('#btn-sample').addEventListener('click', fillSample);
    $('#btn-start').addEventListener('click', startFlow);
    $('#btn-home').addEventListener('click', function () {
      if (state.stage === 'result' || confirm('진행 중인 레이스를 멈추고 처음으로 돌아갈까요?')) goHome();
    });
    $('#opt-sound').addEventListener('change', function (e) { state.sound = e.target.checked; save(); });
    $$('input[name="speed"]').forEach(function (r) {
      r.addEventListener('change', function (e) { state.speed = Number(e.target.value); save(); });
    });
    $$('.speed-chip').forEach(function (b) {
      b.addEventListener('click', function () { state.speed = Number(b.dataset.speed); setSpeedChips(); save(); });
    });
    $('#btn-sound').addEventListener('click', function () {
      state.sound = !state.sound; $('#opt-sound').checked = state.sound; setSpeedChips(); save();
      if (state.sound) ensureAudio();
    });
    $('#btn-copy-table').addEventListener('click', function () {
      copyText(resultAsTable()).then(function (ok) { toast(ok ? '표를 복사했어요. 엑셀/시트에 붙여넣으세요.' : '복사에 실패했어요.'); });
    });
    $('#btn-copy-text').addEventListener('click', function () {
      copyText(resultAsText()).then(function (ok) { toast(ok ? '텍스트를 복사했어요.' : '복사에 실패했어요.'); });
    });
    $('#btn-redo-students').addEventListener('click', function () { beginStudentStage(); });
    $('#btn-restart').addEventListener('click', goHome);
    document.addEventListener('keydown', function (e) {
      var tag = document.activeElement ? document.activeElement.tagName : '';
      if (e.code === 'Space' && state.stage !== 'setup' && !$('#btn-go').hidden && tag !== 'TEXTAREA' && tag !== 'INPUT') {
        e.preventDefault(); $('#btn-go').click();
      }
    });
  }

  function init() {
    load();
    $('#opt-sound').checked = state.sound;
    var sp = $('input[name="speed"][value="' + state.speed + '"]'); if (sp) sp.checked = true;
    if (!$('#teachers').value && !$('#students').value) fillSample();
    readSetup();
    bind();
    if (QA) {
      window.__qa = { state: state, doneCount: 0, autoStart: true, start: startFlow, result: null,
                      step: function (ms) { if (state.race) state.race.update(ms); return state.race ? state.race.done : null; },
                      setup: function (teachers, students, manual) {
                        $('#teachers').value = teachers.join('\n'); $('#students').value = students.join('\n');
                        $('#manual-sizes').value = manual || ''; readSetup();
                      } };
    }
  }

  init();
})();
