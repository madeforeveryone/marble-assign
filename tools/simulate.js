#!/usr/bin/env node
/*
 * 코스 시뮬레이션: node tools/simulate.js [구슬 수] [횟수] [커트라인 등수들(쉼표)]
 * 전원 완주 여부, 강제 도착(안전장치) 횟수, 끼임 밀어주기 횟수, 소요 시간 분포(물리 시간 / 슬로모션 포함 실시간),
 * 통로 밖으로 도착한 이상 사례, 출발 위치(가로 칸)별 평균 순위(코스 편향)를 출력한다.
 */
var MarbleRace = require('../js/race.js');

var n = parseInt(process.argv[2] || '20', 10);
var trials = parseInt(process.argv[3] || '100', 10);
var cutRanks = process.argv[4] ? process.argv[4].split(',').map(Number) : [];
var SUB = 1000 / 120;

// 튜닝 비교용 환경변수: FILTER_OMEGA, FILTER_DIR, FILTER_LEN, CHUTE_HALF, GRAVITY
var tuneOpts = {};
if (process.env.FILTER_OMEGA) tuneOpts.filterOmega = Number(process.env.FILTER_OMEGA);
if (process.env.FILTER_DIR) tuneOpts.filterDir = Number(process.env.FILTER_DIR);
if (process.env.FILTER_LEN) tuneOpts.filterLen = Number(process.env.FILTER_LEN);
if (process.env.CHUTE_HALF) tuneOpts.chuteHalf = Number(process.env.CHUTE_HALF);
if (process.env.GRAVITY) tuneOpts.gravity = Number(process.env.GRAVITY);
if (Object.keys(tuneOpts).length) { MarbleRace.tune(tuneOpts); console.log('tune:', JSON.stringify(tuneOpts)); }

var names = [];
for (var i = 0; i < n; i++) names.push('M' + (i + 1));

var firstTimes = [], lastTimes = [], realTimes = [], nudges = 0, forced = 0, anomalies = 0, slowMs = 0, autoLast = 0;
var colRank = {}, colCount = {};
var t0 = Date.now();

for (var t = 0; t < trials; t++) {
  var race = MarbleRace.createRace({ names: names, seed: 1000 + t, cutRanks: cutRanks });
  // 출발 전 0.8초 동안 게이트 위에서 안정
  race.update(800);
  var startX = race.marbles.map(function (m) { return m.body.position.x; });
  race.onFinish = function (m, rank, f) {
    var x = m.body.position.x;
    if (!m.auto && !f && Math.abs(x - MarbleRace.W / 2) > MarbleRace.CHUTE_HALF + 2) anomalies++;
  };
  race.start();
  var guard = 0;
  while (!race.done && guard < 400000) { race.update(SUB * 4); guard++; }
  if (!race.done) { console.log('trial', t, 'did not finish!'); process.exit(1); }
  firstTimes.push(race.finished[0].finishTime / 1000);
  lastTimes.push(race.finished[race.finished.length - 1].finishTime / 1000);
  realTimes.push(race.realTime / 1000);
  nudges += race.stats.nudges; forced += race.stats.forced; slowMs += race.stats.slowMs;
  if (race.finished[race.finished.length - 1].auto) autoLast++;
  race.marbles.forEach(function (m, i) {
    var col = Math.floor(startX[i] / (MarbleRace.W / 5));
    colRank[col] = (colRank[col] || 0) + m.rank; colCount[col] = (colCount[col] || 0) + 1;
  });
  race.destroy();
}

function stats(arr) {
  var s = arr.slice().sort(function (a, b) { return a - b; });
  var mean = s.reduce(function (a, b) { return a + b; }, 0) / s.length;
  return { min: s[0].toFixed(1), p50: s[Math.floor(s.length * 0.5)].toFixed(1), p90: s[Math.floor(s.length * 0.9)].toFixed(1), max: s[s.length - 1].toFixed(1), mean: mean.toFixed(1) };
}

console.log('marbles=' + n + ' trials=' + trials + ' cutRanks=[' + cutRanks.join(',') + '] (' + ((Date.now() - t0) / 1000).toFixed(1) + 's wall)');
console.log('first finish, physics (s):', stats(firstTimes));
console.log('last finish,  physics (s):', stats(lastTimes));
console.log('race real time incl. slow-mo (s):', stats(realTimes), ' slow-mo per race:', (slowMs / trials / 1000).toFixed(1) + 's');
console.log('nudges/trial:', (nudges / trials).toFixed(2), ' forced finishes:', forced, ' off-chute finishes:', anomalies, ' auto-last:', autoLast + '/' + trials);
var cols = Object.keys(colRank).sort();
console.log('mean rank by start column (left→right):', cols.map(function (c) { return (colRank[c] / colCount[c]).toFixed(2); }).join('  '), ' (ideal ' + ((n + 1) / 2).toFixed(1) + ')');
