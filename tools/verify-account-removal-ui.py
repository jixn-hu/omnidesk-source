"""Exercise local account removal in an isolated real Electron client."""
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
PROFILE = Path(tempfile.mkdtemp(prefix='omnidesk-removal-ui-'))
ARTIFACT = Path(os.environ.get('OMNIDESK_REMOVAL_QA_DIR', str(PROFILE)))
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
    process, browser = None, None
    first_closed = False
    errors = []
    endpoint = 'http://127.0.0.1:' + str(port)

    def launch(playwright):
        nonlocal process, browser
        process = subprocess.Popen(command, cwd=ROOT, env=environment, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
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
        browser = playwright.chromium.connect_over_cdp(endpoint)
        context = browser.contexts[0]
        page = context.pages[0] if context.pages else context.wait_for_event('page')
        page.set_default_timeout(15000)
        page.wait_for_load_state('networkidle')
        page.on('pageerror', lambda error: errors.append(str(error)))
        return page

    def stop(page):
        nonlocal browser
        page.evaluate('() => window.close()')
        browser.close()
        browser = None
        process.wait(timeout=10)

    try:
        with sync_playwright() as playwright:
            page = launch(playwright)
            page.get_by_role('button', name=re.compile('暂不设置')).click()
            page.evaluate('() => window.omnidesk.updates.setAutoCheck(false)')
            ids = page.evaluate('''async ({first,second}) => {
                const check = result => {if(!result.ok)throw new Error(result.message);return result.data}
                check(await window.omnidesk.account.configure(first))
                const a=check(await window.omnidesk.account.authenticate('login','same_user','qa1234'))
                check(await window.omnidesk.account.logout())
                check(await window.omnidesk.account.configure(second))
                const b=check(await window.omnidesk.account.authenticate('login','same_user','qa5678'))
                const ssh=check(await window.omnidesk.connections.save({kind:'ssh',name:'QA keep SSH',host:'192.0.2.1',port:22,username:'qa',authMethod:'password'},{secret:'synthetic-ssh-password'}))
                const rdp=check(await window.omnidesk.connections.save({kind:'rdp',name:'QA keep RDP',host:'192.0.2.2',port:3389,username:'qa'}))
                return {first:a.activeAccountId,second:b.activeAccountId,ssh:ssh.id,rdp:rdp.id}
            }''', {'first': first_url, 'second': second_url})
            page.get_by_role('button', name='账号', exact=True).click()
            selector = page.get_by_label('切换云端账号', exact=True)
            expect(selector).to_have_value(ids['second'])
            remove = page.get_by_role('button', name='从本机移除', exact=True)
            remove.click()
            dialog = page.get_by_role('alertdialog', name='移除本机账号', exact=True)
            expect(dialog).to_contain_text(second_url)
            expect(dialog.get_by_role('button', name='取消', exact=True)).to_be_focused()
            page.keyboard.press('Shift+Tab')
            expect(dialog.get_by_role('button', name='确认从本机移除', exact=True)).to_be_focused()
            page.keyboard.press('Tab')
            expect(dialog.get_by_role('button', name='取消', exact=True)).to_be_focused()
            page.keyboard.press('Escape')
            expect(dialog).to_be_hidden()
            assert len(status(page)['accounts']) == 2
            expect(remove).to_be_focused()
            selector.select_option(ids['first'])
            page.get_by_text('该账号需要重新登录，已填好服务地址和账号，请输入密码。', exact=True).wait_for()
            expect(selector.locator('option[value="' + ids['first'] + '"]')).to_contain_text('需重新登录')
            first.shutdown()
            first.server_close()
            first_closed = True
            remove.click()
            dialog = page.get_by_role('alertdialog', name='移除本机账号', exact=True)
            expect(dialog).to_contain_text(first_url)
            expect(dialog).to_contain_text('云端账号、同步数据、监控节点及历史保留')
            page.screenshot(path=str(ARTIFACT / 'expired-account-remove-confirm.png'), full_page=True)
            dialog.get_by_role('button', name='取消', exact=True).click()
            assert len(status(page)['accounts']) == 2
            remove.click()
            dialog.get_by_role('button', name='确认从本机移除', exact=True).click()
            expect(dialog).to_be_hidden()
            expect(selector.locator('option[value="' + ids['first'] + '"]')).to_have_count(0)
            current = status(page)
            assert current.get('activeAccountId') is None and current['user'] is None
            assert len(current['accounts']) == 1 and current['accounts'][0]['signedIn']
            expect(selector).to_have_value('')
            expect(remove).to_have_count(0)
            expect(page.get_by_label('官方账号', exact=True)).to_have_value('')
            expect(page.get_by_label('官方账号密码', exact=True)).to_have_value('')
            page.screenshot(path=str(ARTIFACT / 'expired-account-removed.png'), full_page=True)
            selector.select_option(ids['second'])
            page.get_by_text('已切换账号，本机连接保留。', exact=True).wait_for()
            assert status(page)['user']['id'] == second.identity
            # Check narrow-window layout of the actual account view and confirmation.
            page.set_viewport_size({'width': 820, 'height': 900})
            remove.click()
            expect(dialog).to_contain_text(second_url)
            backdrop = page.locator('.account-remove-backdrop').bounding_box()
            assert backdrop == {'x': 0, 'y': 0, 'width': 820, 'height': 900}, backdrop
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            page.screenshot(path=str(ARTIFACT / 'current-account-remove-narrow.png'), full_page=True)
            dialog.get_by_role('button', name='确认从本机移除', exact=True).click()
            expect(dialog).to_be_hidden()
            expect(remove).to_have_count(0)
            assert status(page)['accounts'] == []
            assert first.logouts == 1 and second.logouts == 0
            assert first.logins == ['same_user'] and second.logins == ['same_user']
            stop(page)
            # Reopen the same isolated profile to verify persisted removal and local data.
            page = launch(playwright)
            page.get_by_role('button', name='账号', exact=True).click()
            expect(page.get_by_label('切换云端账号', exact=True)).to_have_value('')
            expect(page.get_by_role('button', name='从本机移除', exact=True)).to_have_count(0)
            assert status(page)['accounts'] == []
            assert status(page)['user'] is None
            local = page.evaluate('() => window.omnidesk.connections.list()')
            assert local['ok']
            assert {item['id'] for item in local['data']} == {ids['ssh'], ids['rdp']}
            assert errors == [], errors
            page.screenshot(path=str(ARTIFACT / 'removed-accounts-after-restart.png'), full_page=True)
            stop(page)
            print('PASS: real Electron current/stale account removal, unreachable backend, explicit confirmation/cancel/Escape/focus, other-account preservation, narrow layout, no cloud logout/delete, persisted restart and local SSH/RDP retention')
            print('QA_DIRECTORY=' + str(PROFILE))
    finally:
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        if process:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=10)
        if not first_closed:
            first.shutdown()
            first.server_close()
        second.shutdown()
        second.server_close()


if __name__ == '__main__':
    main()
