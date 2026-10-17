#!/usr/bin/env python3
"""배포된 Pages 사이트 스모크 테스트: python3 tools/qa_live.py [URL]
   리소스 전부 200, 콘솔 에러 0, 4명/20명 전체 플로우가 결과 화면까지 가는지 확인."""
import sys, time, os
from playwright.sync_api import sync_playwright

URL = (sys.argv[1] if len(sys.argv) > 1 else 'https://madeforeveryone.github.io/marble-assign/').rstrip('/') + '/?qa=1'
SHOT = os.environ.get('SHOT_DIR')

def run_stage(page, label):
    page.wait_for_function("window.__qa && window.__qa.race && window.__qa.race.started", timeout=15000)
    t0 = time.time()
    while not page.evaluate("window.__qa.step(500)"):
        if time.time() - t0 > 120: raise SystemExit(label + ': race did not finish')
    page.wait_for_function("!document.querySelector('#btn-next').hidden", timeout=5000)
    print(f'  {label}: done in {page.evaluate("__qa.race.time")/1000:.1f}s')

errors, bad = [], []
with sync_playwright() as p:
    b = p.chromium.launch(args=['--no-sandbox'])
    page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('response', lambda r: bad.append(f'{r.status} {r.url}') if r.status >= 400 and 'fonts.g' not in r.url else None)
    page.goto(URL, wait_until='networkidle'); page.wait_for_function('window.__qa')
    print('loaded', URL)
    teachers = ['김선생', '이선생', '박선생', '최선생']; students = [f'학생{i+1}' for i in range(20)]
    page.evaluate('([t,s]) => __qa.setup(t, s)', [teachers, students])
    page.click('#btn-start')
    run_stage(page, 'teacher stage'); page.click('#btn-next')
    run_stage(page, 'student stage'); page.click('#btn-next')
    page.wait_for_selector('#screen-result:not([hidden])')
    res = page.evaluate('window.__qa.result')
    assert sorted(res['teacherOrder']) == sorted(teachers)
    rank = 1
    for i, a in enumerate(res['assignments']):
        assert len(a) == 5, a
        for s in a: assert s['rank'] == rank; rank += 1
    print('  assignment rule OK:', ' | '.join(f"{i+1}등 {t}: " + ', '.join(s['name'] for s in res['assignments'][i]) for i, t in enumerate(res['teacherOrder'])))
    if SHOT: page.screenshot(path=os.path.join(SHOT, 'live_result.png'))

    # 학년 그룹: 5학년 7명을 4명 선생님에게 최소 1명씩
    page.goto(URL, wait_until='networkidle'); page.wait_for_function('window.__qa')
    roster = ['[4학년] ' + ', '.join(f'사{i+1}' for i in range(13)), '[5학년] ' + ', '.join(f'오{i+1}' for i in range(7))]
    page.evaluate('([t,s]) => __qa.setup(t, s, "", {})', [teachers, roster])
    page.click('#btn-start')
    run_stage(page, 'teacher stage'); page.click('#btn-next')
    run_stage(page, '5학년 race'); page.click('#btn-next')
    run_stage(page, '4학년 race'); page.click('#btn-next')
    page.wait_for_selector('#screen-result:not([hidden])')
    res = page.evaluate('window.__qa.result')
    per = [len([s for s in a if s['group'] == '5학년']) for a in res['assignments']]
    assert per == [2, 2, 2, 1] and all(len(a) == 5 for a in res['assignments']), (per, res)
    print('  grouped OK: 5학년 per teacher =', per)
    b.close()
if bad: print('BAD RESPONSES:', *bad, sep='\n  ')
if errors: print('CONSOLE ERRORS:', *errors, sep='\n  ')
if bad or errors: sys.exit(1)
print('LIVE OK: all resources 200, zero console errors')
