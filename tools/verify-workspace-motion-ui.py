"""Exercise workspace motion using real Electron, isolated data and local HTTP fixtures."""
import importlib.util
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('monitor_fixture',ROOT/'tools/verify-monitor-cleanup-ui.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
PROFILE=Path(tempfile.mkdtemp(prefix='omnidesk-motion-ui-'))
ARTIFACT=Path(os.environ.get('OMNIDESK_MOTION_QA_DIR',str(PROFILE)));ARTIFACT.mkdir(parents=True,exist_ok=True)
class Handler(fixture.Handler):
    def do_HEAD(self):
        self.server.started.set()
        if not self.server.release.wait(10):raise RuntimeError('Fixture was not released')
        self.send_response(self.server.dav_status);self.send_header('Content-Length','0');self.end_headers()

def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.failure=False
    server.started=threading.Event();server.release=threading.Event();server.dav_status=404
    threading.Thread(target=server.serve_forever,daemon=True).start()
    origin='http://127.0.0.1:'+str(server.server_port)
    with socket.socket() as allocation:allocation.bind(('127.0.0.1',0));port=allocation.getsockname()[1]
    exe=os.environ.get('OMNIDESK_QA_EXE')
    command=([exe] if exe else [str(ROOT/'node_modules/electron/dist/electron.exe'),str(ROOT)])+['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+str(port),'--disable-gpu']
    environment=dict(os.environ,OMNIDESK_USER_DATA_DIR=str(PROFILE));environment.pop('ELECTRON_RUN_AS_NODE',None)
    process=browser=None;errors=[]
    try:
        process=subprocess.Popen(command,cwd=ROOT,env=environment,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
        endpoint='http://127.0.0.1:'+str(port)
        for _ in range(150):
            try:
                with urlopen(endpoint+'/json/version',timeout=1) as response:
                    if response.status==200:break
            except OSError:
                assert process.poll() is None,'Electron exited before readiness'
                time.sleep(.1)
        else:raise RuntimeError('Electron readiness timed out')
        with sync_playwright() as pw:
            browser=pw.chromium.connect_over_cdp(endpoint);page=browser.contexts[0].pages[0]
            page.set_default_timeout(15000);page.on('pageerror',lambda error:errors.append(str(error)))
            page.wait_for_load_state('networkidle');page.set_viewport_size({'width':1450,'height':1000})
            page.emulate_media(reduced_motion='no-preference')
            page.get_by_role('button',name=re.compile('暂不设置')).click()
            page.evaluate("""async origin=>{
                const check=r=>{if(!r.ok)throw Error(r.message);return r.data}
                check(await window.omnidesk.updates.setAutoCheck(false))
                check(await window.omnidesk.account.configure(origin))
                check(await window.omnidesk.account.authenticate('login','motion_qa','qa1234'))
                check(await window.omnidesk.monitoring.configure({enabled:true,defaultIntervalSeconds:60}))
                window.dispatchEvent(new Event('omnidesk:monitoring-changed'))
            }""",origin)
            page.get_by_role('button',name='服务器监控',exact=True).click()
            card=page.get_by_role('article',name='Snap 正常节点监控卡片',exact=True)
            expect(card).to_be_visible()
            card.evaluate('e=>{window.__motionQaCard=e}')
            fixture.NODES[0]['metrics']['cpu']['usage']=50
            page.get_by_role('button',name='刷新',exact=True).click()
            expect(card).to_contain_text('2 / 4 核')
            bar=card.get_by_role('meter',name='CPU',exact=True).locator('span')
            samples=bar.evaluate("""e=>new Promise(resolve=>{const values=[],start=performance.now();function step(){values.push(parseFloat(getComputedStyle(e).width));if(performance.now()-start<350)requestAnimationFrame(step);else resolve(values)}requestAnimationFrame(step)})""")
            assert len(set(round(v,1) for v in samples))>1,samples
            assert card.evaluate('e=>window.__motionQaCard===e')
            assert card.evaluate("e=>getComputedStyle(e).animationName")=='none'
            assert bar.evaluate("e=>getComputedStyle(e).transitionDuration")=='0.3s'
            page.get_by_role('button',name='设置',exact=True).click()
            page.get_by_role('button',name=re.compile('^公共凭据')).click()
            page.get_by_role('button',name='设置',exact=True).click()
            positions=page.locator('.sidebar-footer .is-active .nav-selection').evaluate("""e=>new Promise(resolve=>{const ys=[],start=performance.now();function step(){ys.push(e.getBoundingClientRect().y);if(performance.now()-start<220)requestAnimationFrame(step);else resolve(ys)}requestAnimationFrame(step)})""")
            assert len(set(round(value,1) for value in positions))>1,positions
            expect(page.locator('.sidebar-footer .nav-selection')).to_have_count(1)
            expect(page.locator('.tabbar .nav-selection')).to_have_count(1)
            page.wait_for_timeout(240)
            highlight=page.locator('.sidebar-footer .is-active .nav-selection')
            assert highlight.evaluate("e=>getComputedStyle(e).pointerEvents")=='none'
            bounds=highlight.evaluate("e=>{const a=e.getBoundingClientRect(),b=e.parentElement.getBoundingClientRect();return [Math.abs(a.width-b.width),Math.abs(a.height-b.height)]}")
            assert max(bounds)<=2,bounds
            print('PASS navigation and meter animation',flush=True)
            page.get_by_role('tab',name=re.compile('^设置')).click(button='right')
            menu=page.get_by_role('menu');expect(menu).to_be_visible()
            assert menu.evaluate("e=>getComputedStyle(e).animationName")=='surface-fade'
            page.keyboard.press('ArrowDown');assert menu.evaluate('e=>e.contains(document.activeElement)')
            page.keyboard.press('Escape');expect(menu).to_have_count(0)
            page.get_by_role('button',name='新建连接',exact=True).click()
            dialog=page.get_by_role('dialog',name='新建连接',exact=True);expect(dialog).to_be_visible()
            assert dialog.evaluate("e=>getComputedStyle(e).animationName")=='dialog-appear'
            dialog.get_by_role('button',name='保存',exact=True).click()
            expect(dialog).to_be_visible();expect(dialog.get_by_role('button',name='保存',exact=True)).to_have_attribute('data-phase','idle')
            page.keyboard.press('Escape');expect(dialog).to_have_count(0)
            page.locator('[data-settings-section="backup"] > summary').click()
            page.get_by_role('tab',name='WebDAV',exact=True).click()
            page.get_by_label('服务器地址',exact=True).fill(origin+'/dav/')
            page.get_by_text('备份位置与高级设置（可选）',exact=True).click()
            page.get_by_label('允许不安全 HTTP',exact=False).check()
            save=page.get_by_role('button',name='保存 WebDAV',exact=True)
            before=save.bounding_box()['width'];save.click();expect(save).to_have_attribute('data-phase','success')
            assert abs(save.bounding_box()['width']-before)<1
            assert save.get_attribute('aria-busy') is None
            test=page.get_by_role('button',name='测试连接',exact=True)
            before=test.bounding_box()['width'];test.click();expect(test).to_have_attribute('data-phase','busy')
            expect(test).to_be_disabled();expect(test).to_have_attribute('aria-busy','true')
            assert server.started.wait(3)
            assert abs(test.bounding_box()['width']-before)<1
            page.screenshot(path=str(ARTIFACT/'button-busy.png'),full_page=True)
            server.release.set();expect(test).to_have_attribute('data-phase','success')
            assert abs(test.bounding_box()['width']-before)<1
            page.screenshot(path=str(ARTIFACT/'button-success.png'),full_page=True)
            server.started.clear();server.release.clear();server.dav_status=500
            test.click();expect(test).to_have_attribute('data-phase','busy');assert server.started.wait(3)
            server.release.set();expect(test).to_have_attribute('data-phase','idle')
            expect(page.get_by_role('alert')).to_be_visible()
            page.emulate_media(reduced_motion='reduce')
            page.get_by_role('button',name='新建连接',exact=True).click();expect(dialog).to_be_visible()
            assert dialog.evaluate("e=>getComputedStyle(e).animationName")=='none'
            page.keyboard.press('Escape');expect(dialog).to_have_count(0)
            page.get_by_role('button',name='服务器监控',exact=True).click()
            expect(card).to_be_visible()
            assert card.get_by_role('meter',name='CPU',exact=True).locator('span').evaluate("e=>getComputedStyle(e).transitionDuration")=='0s'
            page.get_by_role('button',name='收起侧栏',exact=True).click()
            page.get_by_role('button',name=re.compile('^公共凭据')).click()
            expect(page.locator('.sidebar-rail .nav-selection')).to_have_count(1)
            page.get_by_role('button',name='展开侧栏',exact=True).click()
            expect(page.locator('.sidebar-footer .nav-selection')).to_have_count(1)
            page.emulate_media(reduced_motion='no-preference')
            page.get_by_role('button',name='服务器监控',exact=True).click()
            page.evaluate("document.documentElement.dataset.theme='dark'")
            page.set_viewport_size({'width':960,'height':900});page.wait_for_timeout(220)
            assert page.locator('.monitor-dashboard').evaluate('e=>e.scrollWidth<=e.clientWidth+1')
            page.screenshot(path=str(ARTIFACT/'monitor-dark-narrow.png'),full_page=True)
            assert not errors,errors
            page.evaluate('window.close()');browser.close();browser=None;process.wait(timeout=10)
            print('PASS: shared navigation, compact rail, menu keyboard, dialog focus/validation, stable-width busy/success/failure feedback, live meter transition without card replay, reduced motion, dark/narrow layout')
            print('QA_DIRECTORY='+str(PROFILE))
    except Exception:
        if browser:
            try:page.screenshot(path=str(ARTIFACT/'failure.png'),full_page=True)
            except Exception:pass
        raise
    finally:
        server.release.set()
        if browser:
            try:browser.close()
            except Exception:pass
        if process and process.poll() is None:process.terminate();process.wait(timeout=10)
        server.shutdown();server.server_close()
if __name__=='__main__':main()
