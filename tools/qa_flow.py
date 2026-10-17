#!/usr/bin/env python3
"""브라우저 플로우 테스트 (Playwright, headless Chromium).
   python3 tools/qa_flow.py [--shots DIR]
   설정 → 1단계 → 2단계 → 결과까지 돌리고, 배정 규칙(순위 → 선생님)과 콘솔 에러 0을 확인한다."""
import json, os, sys, threading, http.server, socketserver, functools, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = None
if '--shots' in sys.argv:
    SHOTS = sys.argv[sys.argv.index('--shots') + 1]
    os.makedirs(SHOTS, exist_ok=True)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

def serve():
    handler = functools.partial(Quiet, directory=ROOT)
    httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True); t.start()
    return httpd, httpd.server_address[1]

def run_stage(page, label, shot_zoom=None):
    """현재 레이스를 물리 직접 구동으로 끝까지 돌린다. shot_zoom 이 있으면 클로즈업(줌 ≥ 0.8) 순간을 찍는다."""
    page.wait_for_function("window.__qa && window.__qa.race && window.__qa.race.started", timeout=10000)
    t0 = time.time(); zoom_seen = 0; slow_seen = 1
    while True:
        done = page.evaluate("window.__qa.step(250)")
        st = page.evaluate("({z: __qa.race.zoom, ts: __qa.race.timeScale, cut: __qa.race.cutActive})")
        zoom_seen = max(zoom_seen, st['z']); slow_seen = min(slow_seen, st['ts'])
        if shot_zoom and st['z'] >= 0.8 and not os.path.exists(shot_zoom):
            page.wait_for_timeout(1500)   # 물리는 멈춘 채 카메라만 목표까지 가게 둔 뒤 찍는다
            page.screenshot(path=shot_zoom)
        if done: break
        if time.time() - t0 > 180: raise SystemExit(f'{label}: race did not finish')
    print(f'  {label}: max zoom intensity {zoom_seen:.2f}, min timeScale {slow_seen:.2f}')
    assert zoom_seen >= 0.8, 'close-up never triggered'
    page.wait_for_function("document.querySelector('#btn-next') && !document.querySelector('#btn-next').hidden", timeout=5000)
    race = page.evaluate("({time: __qa.race.time, nudges: __qa.race.stats.nudges, forced: __qa.race.stats.forced, n: __qa.race.finished.length})")
    print(f'  {label}: {race["n"]} finished in {race["time"]/1000:.1f}s (nudges={race["nudges"]}, forced={race["forced"]})')
    assert race['forced'] == 0, 'forced finish happened'
    return race

def check_result(res, teachers, students, sizes):
    order = res['teacherOrder']; assign = res['assignments']
    assert sorted(order) == sorted(teachers), f'teacher order is not a permutation: {order}'
    assert res['sizes'] == sizes, f'sizes mismatch {res["sizes"]} != {sizes}'
    all_names = [s['name'] for a in assign for s in a]
    assert sorted(all_names) == sorted(students), 'students mismatch'
    rank = 1
    for i, a in enumerate(assign):
        assert len(a) == sizes[i], f'teacher {i} got {len(a)} students, expected {sizes[i]}'
        for s in a:
            assert s['rank'] == rank, f'rank order broken: expected {rank}, got {s["rank"]} in teacher {i}'
            rank += 1
    print(f'  result OK: {len(order)} teachers / {len(students)} students, sizes {sizes}')

def main():
    httpd, port = serve()
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1400, 'height': 900})
        # 오프라인 환경: 웹폰트 요청은 빈 CSS로 대체 (실제 에러와 섞이지 않게)
        page.route('**/fonts.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='text/css', body=''))
        page.route('**/fonts.gstatic.com/**', lambda r: r.fulfill(status=200, content_type='font/woff2', body=''))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        base = f'http://127.0.0.1:{port}/index.html?qa=1'

        # --- 시나리오 1: 선생님 4명 / 학생 20명 자동 (5·5·5·5)
        page.goto(base); page.wait_for_function('window.__qa')
        teachers = ['김선생', '이선생', '박선생', '최선생']
        students = [f'학생{i+1}' for i in range(20)]
        page.evaluate('([t,s]) => __qa.setup(t, s)', [teachers, students])
        assert page.evaluate("document.querySelector('#auto-sizes').textContent") == '5 · 5 · 5 · 5 명'
        if SHOTS: page.screenshot(path=f'{SHOTS}/01_setup.png')
        page.click('#btn-start')
        print('scenario 1: 4 teachers / 20 students')
        page.evaluate("__qa.step(1200)")
        if SHOTS: page.screenshot(path=f'{SHOTS}/02_teacher_race.png')
        run_stage(page, 'teacher stage', shot_zoom=(f'{SHOTS}/02b_closeup_teacher.png' if SHOTS else None))
        if SHOTS: page.screenshot(path=f'{SHOTS}/03_teacher_done.png')
        page.click('#btn-next')
        page.wait_for_function("window.__qa.race && window.__qa.race.started")
        page.evaluate("__qa.step(3000)")
        if SHOTS: page.screenshot(path=f'{SHOTS}/04_student_race.png')
        run_stage(page, 'student stage', shot_zoom=(f'{SHOTS}/04b_closeup.png' if SHOTS else None))
        if SHOTS: page.screenshot(path=f'{SHOTS}/05_student_done.png')
        page.click('#btn-next')
        page.wait_for_selector('#screen-result:not([hidden])')
        if SHOTS: page.screenshot(path=f'{SHOTS}/06_result.png', full_page=True)
        res = page.evaluate('window.__qa.result')
        check_result(res, teachers, students, [5, 5, 5, 5])
        table = page.evaluate("""() => { const b = document.querySelector('#btn-copy-table'); return b ? 'ok' : 'missing'; }""")
        assert table == 'ok'

        # --- 시나리오 2: 학생 22명 자동 (6·6·5·5) + 선생님 3명
        page.goto(base); page.wait_for_function('window.__qa')
        teachers = ['A', 'B', 'C']; students = [f'S{i+1}' for i in range(22)]
        page.evaluate('([t,s]) => __qa.setup(t, s)', [teachers, students])
        assert page.evaluate("document.querySelector('#auto-sizes').textContent") == '8 · 7 · 7 명'
        page.click('#btn-start'); print('scenario 2: 3 teachers / 22 students (auto 8·7·7)')
        run_stage(page, 'teacher stage'); page.click('#btn-next')
        run_stage(page, 'student stage'); page.click('#btn-next')
        page.wait_for_selector('#screen-result:not([hidden])')
        check_result(page.evaluate('window.__qa.result'), teachers, students, [8, 7, 7])

        # --- 시나리오 3: 직접 지정 6,5,5,4 + 중복 이름
        page.goto(base); page.wait_for_function('window.__qa')
        teachers = ['김', '이', '박', '최']; raw = ['민준', '민준', '서연'] + [f'S{i}' for i in range(17)]
        page.evaluate('([t,s,m]) => __qa.setup(t, s, m)', [teachers, raw, '6,5,5,4'])
        err_hidden = page.evaluate("document.querySelector('#setup-error').hidden")
        assert err_hidden, page.evaluate("document.querySelector('#setup-error').textContent")
        page.click('#btn-start'); print('scenario 3: manual 6,5,5,4 with duplicate names')
        run_stage(page, 'teacher stage'); page.click('#btn-next')
        run_stage(page, 'student stage'); page.click('#btn-next')
        page.wait_for_selector('#screen-result:not([hidden])')
        students = ['민준', '민준(2)', '서연'] + [f'S{i}' for i in range(17)]
        check_result(page.evaluate('window.__qa.result'), teachers, students, [6, 5, 5, 4])

        # --- 시나리오 4: 잘못된 직접 지정 → 에러 표시, 시작 안 됨
        page.goto(base); page.wait_for_function('window.__qa')
        page.evaluate('([t,s,m]) => __qa.setup(t, s, m)', [['a', 'b'], ['x', 'y', 'z'], '1,1'])
        assert not page.evaluate("document.querySelector('#setup-error').hidden")
        page.click('#btn-start')
        assert page.evaluate("document.querySelector('#screen-setup').hidden") is False
        print('scenario 4: invalid manual sizes blocked OK')

        # --- 시나리오 G: 학년 그룹 — 5학년 7명을 선생님 4명에게 고르게(최소 1명), 4학년 13명은 블록 배정
        page.goto(base); page.wait_for_function('window.__qa')
        teachers = ['김', '이', '박', '최']
        g4 = [f'사{i+1}' for i in range(13)]; g5 = [f'오{i+1}' for i in range(7)]
        roster = ['[4학년] ' + ', '.join(g4), '[5학년] ' + ', '.join(g5)]
        page.evaluate('([t,s]) => __qa.setup(t, s, "", {})', [teachers, roster])
        plan = page.evaluate('__qa.plan()')
        assert [ (r['label'], r['mode'], r['n']) for r in plan ] == [('5학년', 'roundrobin', 7), ('4학년', 'block', 13)], plan
        assert plan[0]['counts'] == [2, 2, 2, 1] and plan[1]['counts'] == [3, 3, 3, 4], plan
        assert page.evaluate("document.querySelector('#group-options input[data-group=\"5학년\"]').checked")
        if SHOTS: page.screenshot(path=f'{SHOTS}/09_setup_groups.png')
        page.click('#btn-start'); print('scenario G: grouped roster (5학년 spread)')
        run_stage(page, 'teacher stage'); page.click('#btn-next')
        assert '5학년' in page.evaluate("document.querySelector('#stage-badge').textContent")
        run_stage(page, '5학년 race (round-robin)')
        if SHOTS: page.screenshot(path=f'{SHOTS}/10_after_g5.png')
        page.click('#btn-next')
        assert '4학년' in page.evaluate("document.querySelector('#stage-badge').textContent")
        run_stage(page, '4학년 race (block)'); page.click('#btn-next')
        page.wait_for_selector('#screen-result:not([hidden])')
        if SHOTS: page.screenshot(path=f'{SHOTS}/11_result_groups.png', full_page=True)
        res = page.evaluate('window.__qa.result')
        for i, a in enumerate(res['assignments']):
            assert len(a) == 5, a
            fifth = [s for s in a if s['group'] == '5학년']
            assert len(fifth) >= 1, f'teacher {i} has no 5학년: {a}'
            assert len(fifth) == plan[0]['counts'][i], (i, fifth)
            # 5학년 자리 먼저(돌아가며), 그 다음 4학년 블록 — 각 레이스 안에서 등수는 오름차순
            fr = [s['rank'] for s in fifth]; assert fr == sorted(fr)
            four = [s['rank'] for s in a if s['group'] == '4학년']; assert four == sorted(four) and len(four) == plan[1]['counts'][i]
        # 돌아가며 배정: 5학년 k등 → (k-1) % 4 번째 선생님
        for i, a in enumerate(res['assignments']):
            for s in a:
                if s['group'] == '5학년': assert (s['rank'] - 1) % 4 == i, (i, s)
        # 블록 배정: 4학년 1~3등 → 1등 선생님, 4~6 → 2등, 7~9 → 3등, 10~13 → 4등
        bounds = [(1, 3), (4, 6), (7, 9), (10, 13)]
        for i, a in enumerate(res['assignments']):
            for s in a:
                if s['group'] == '4학년': assert bounds[i][0] <= s['rank'] <= bounds[i][1], (i, s)
        all_names = sorted(s['name'] for a in res['assignments'] for s in a)
        assert all_names == sorted(g4 + g5)
        print('  grouped result OK: 5학년 per teacher =', [len([s for s in a if s['group'] == '5학년']) for a in res['assignments']])

        # --- 시나리오 5: 선생님 1명 → 1단계 생략
        page.goto(base); page.wait_for_function('window.__qa')
        page.evaluate('([t,s]) => __qa.setup(t, s)', [['혼자'], ['a', 'b', 'c', 'd', 'e']])
        page.click('#btn-start')
        assert page.evaluate("document.querySelector('#stage-badge').textContent").startswith('2단계')
        run_stage(page, 'student stage (single teacher)'); page.click('#btn-next')
        page.wait_for_selector('#screen-result:not([hidden])')
        check_result(page.evaluate('window.__qa.result'), ['혼자'], ['a', 'b', 'c', 'd', 'e'], [5])

        # --- 모바일 폭에서도 레이아웃 에러 없이 뜨는지
        page.set_viewport_size({'width': 390, 'height': 800})
        page.goto(base); page.wait_for_function('window.__qa')
        page.click('#btn-start'); page.evaluate("__qa.step(1500)")
        if SHOTS: page.screenshot(path=f'{SHOTS}/07_mobile_race.png')

        # --- 교실 프로젝터(1920×1080) 배율 확인
        page.set_viewport_size({'width': 1920, 'height': 1080})
        page.goto(base); page.wait_for_function('window.__qa')
        page.click('#btn-start'); page.evaluate("__qa.step(2500)")
        if SHOTS: page.screenshot(path=f'{SHOTS}/08_fullhd.png')
        browser.close()
    httpd.shutdown()
    if errors:
        print('CONSOLE ERRORS:'); [print('  ', e) for e in errors]; sys.exit(1)
    print('ALL OK, zero console errors')

if __name__ == '__main__':
    main()
