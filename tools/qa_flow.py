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

def run_stage(page, label):
    """현재 레이스를 물리 직접 구동으로 끝까지 돌린다."""
    page.wait_for_function("window.__qa && window.__qa.race && window.__qa.race.started", timeout=10000)
    t0 = time.time()
    while True:
        done = page.evaluate("window.__qa.step(500)")
        if done: break
        if time.time() - t0 > 120: raise SystemExit(f'{label}: race did not finish')
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
        run_stage(page, 'teacher stage')
        if SHOTS: page.screenshot(path=f'{SHOTS}/03_teacher_done.png')
        page.click('#btn-next')
        page.wait_for_function("window.__qa.race && window.__qa.race.started")
        page.evaluate("__qa.step(3000)")
        if SHOTS: page.screenshot(path=f'{SHOTS}/04_student_race.png')
        run_stage(page, 'student stage')
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
