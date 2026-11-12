"""Exercise saved-account reauthentication in an isolated real Electron client."""
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
PROFILE = Path(tempfile.mkdtemp(prefix='omnidesk-relogin-ui-'))
ARTIFACT = Path(os.environ.get('OMNIDESK_RELOGIN_QA_DIR', str(PROFILE)))
ARTIFACT.mkdir(parents=True, exist_ok=True)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/v1/auth/providers':
            self.reply(200, {'registrationOpen': False, 'gitlab': {'enabled': False}})
        else:
            self.reply(200, {})

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        data = json.loads(body) if body else {}
        if self.path == '/v1/auth/login':
            self.server.logins.append(data.get('username'))
            if data.get('password') != self.server.password:
                self.reply(401, {'error': '测试密码错误'})
                return
            self.reply(200, {
                'user': {'id': self.server.identity, 'username': data['username'], 'role': 'user'},
                'token': 'synthetic-token-' + self.server.identity,
                'syncKey': 'synthetic-key-' + self.server.identity,
                'expiresAt': int(time.time() * 1000) + self.server.lifetime,
            })
        elif self.path == '/v1/logout':
            self.server.logouts += 1
            self.reply(200, {'ok': True})
        else:
            self.reply(404, {'error': 'unexpected fixture route'})


def fixture(identity, password):
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.identity, server.password = identity, password
    server.lifetime, server.logouts, server.logins = 600000, 0, []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, 'http://127.0.0.1:' + str(server.server_port)


def status(page):
    response = page.evaluate('() => window.omnidesk.account.status()')
    assert response['ok'], response
    return response['data']


def main():
    first, first_url = fixture('qa-first-service', 'qa1234')
    second, second_url = fixture('qa-second-service', 'qa5678')
    with socket.socket() as allocation:
        allocation.bind(('127.0.0.1', 0))
        port = allocation.getsockname()[1]
    executable = os.environ.get('OMNIDESK_QA_EXE')
    command = [executable] if executable else [str(ROOT / 'node_modules/electron/dist/electron.exe'), str(ROOT)]
    command += ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + str(port), '--disable-gpu']
    environment = dict(os.environ, OMNIDESK_USER_DATA_DIR=str(PROFILE))
    environment.pop('ELECTRON_RUN_AS_NODE', None)
    process = subprocess.Popen(command, cwd=ROOT, env=environment, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    browser = None
    try:
        endpoint = 'http://127.0.0.1:' + str(port)
        for attempt in range(200):
            try:
                with urlopen(endpoint + '/json/version', timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                if process.poll() is not None:
                    raise RuntimeError('Electron exited before CDP became ready')
                time.sleep(.1)
        else:
            raise RuntimeError('Electron CDP startup timed out')
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(endpoint)
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else context.wait_for_event('page')
            page.set_default_timeout(15000)
            page.wait_for_load_state('networkidle')
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.get_by_role('button', name=re.compile('暂不设置')).click()
            page.evaluate('() => window.omnidesk.updates.setAutoCheck(false)')
            ids = page.evaluate('''async ({first,second}) => {
                const check = result => {if(!result.ok)throw new Error(result.message);return result.data}
                check(await window.omnidesk.account.configure(first))
                const a=check(await window.omnidesk.account.authenticate('login','same_user','qa1234'))
                check(await window.omnidesk.account.logout())
                check(await window.omnidesk.account.configure(second))
                const b=check(await window.omnidesk.account.authenticate('login','same_user','qa5678'))
                return {first:a.activeAccountId,second:b.activeAccountId}
            }''', {'first': first_url, 'second': second_url})
            page.get_by_role('button', name='账号', exact=True).click()
            selector = page.get_by_label('切换云端账号', exact=True)
            option = selector.locator('option[value="' + ids['first'] + '"]')
            expect(option).to_contain_text('需重新登录')
            assert not option.is_disabled(), 'Saved account needing login is still disabled'
            selector.select_option(ids['first'])
            page.get_by_text('该账号需要重新登录，已填好服务地址和账号，请输入密码。', exact=True).wait_for()
            expect(page.get_by_label('官方服务地址', exact=True)).to_have_value(first_url)
            expect(page.get_by_label('官方账号', exact=True)).to_have_value('same_user')
            password = page.get_by_label('官方账号密码', exact=True)
            expect(password).to_have_value('')
            expect(password).to_be_focused()
            page.screenshot(path=str(ARTIFACT / 'expired-account-selected.png'), full_page=True)
            assert status(page)['user'] is None
            assert next(p for p in status(page)['accounts'] if p['id'] == ids['second'])['signedIn']
            password.fill('wrong1')
            page.get_by_role('button', name='登录账号', exact=True).click()
            page.get_by_text('测试密码错误', exact=True).wait_for()
            assert status(page)['serverUrl'] == first_url
            assert status(page)['user'] is None
            assert next(p for p in status(page)['accounts'] if p['id'] == ids['second'])['signedIn']
            password.fill('qa1234')
            page.get_by_role('button', name='登录账号', exact=True).click()
            page.get_by_text('已登录。本机连接不会自动上传。', exact=True).wait_for()
            expect(password).to_be_hidden()
            current = status(page)
            assert current['activeAccountId'] == ids['first']
            assert len(current['accounts']) == 2
            assert all(p['signedIn'] for p in current['accounts'])
            selector.select_option(ids['second'])
            page.get_by_text('已切换账号，本机连接保留。', exact=True).wait_for()
            assert status(page)['serverUrl'] == second_url
            assert status(page)['user']['id'] == second.identity
            # Expire the selected account, reload the UI, and check the initial login form.
            second.lifetime = 1
            page.evaluate("() => window.omnidesk.account.authenticate('login','same_user','qa5678')")
            page.wait_for_timeout(100)
            page.reload(wait_until='networkidle')
            page.get_by_role('button', name='账号', exact=True).click()
            expect(page.get_by_label('官方账号', exact=True)).to_have_value('same_user')
            expect(page.get_by_label('官方账号密码', exact=True)).to_have_value('')
            selector = page.get_by_label('切换云端账号', exact=True)
            expect(selector).to_have_value(ids['second'])
            assert not selector.locator('option[value="' + ids['second'] + '"]').is_disabled()
            selector.select_option(ids['first'])
            page.get_by_text('已切换账号，本机连接保留。', exact=True).wait_for()
            assert status(page)['user']['id'] == first.identity
            assert first.logouts == 1 and second.logouts == 0
            assert first.logins == ['same_user', 'same_user', 'same_user']
            assert errors == [], errors
            page.screenshot(path=str(ARTIFACT / 'account-relogin-complete.png'), full_page=True)
            print('PASS: expired/revoked saved accounts selectable, correct server and username, password focus, wrong-password recovery, reauthentication, other-session preservation, expired active profile after reload')
            print('QA_DIRECTORY=' + str(PROFILE))
            page.evaluate('() => window.close()')
            browser.close()
            browser = None
    finally:
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=10)
        first.shutdown()
        second.shutdown()
        first.server_close()
        second.server_close()


if __name__ == '__main__':
    main()
