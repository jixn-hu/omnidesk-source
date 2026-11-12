# Test context installation with two local backends. Never execute downloaded installers.
import base64, hashlib, json, os, re, socket, subprocess, tempfile, time
from pathlib import Path
from urllib.request import Request, urlopen
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
QA=Path(tempfile.mkdtemp(prefix='omnidesk-context-install-'))
ARTIFACT=Path(os.environ.get('OMNIDESK_CONTEXT_QA_DIR',str(QA)))
ARTIFACT.mkdir(parents=True,exist_ok=True)
PROCESSES=[]
def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0))
        return s.getsockname()[1]
def start(command,environment):
    p=subprocess.Popen(command,cwd=ROOT,env=environment,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
    PROCESSES.append(p)
    return p
def ready(address,p):
    for _ in range(150):
        try:
            with urlopen(address,timeout=1) as r:
                if r.status==200:return
        except OSError:
            if p.poll() is not None:raise RuntimeError('QA process exited before readiness')
            time.sleep(.1)
    raise RuntimeError('QA process startup timed out')
def cloud(name):
    mp,ap=port(),port();token='synthetic-internal-token-only-for-context-qa';directory=QA/name;directory.mkdir()
    p=start([os.environ['OMNIDESK_MONITOR_TEST_BINARY'],'-listen','127.0.0.1:'+str(mp),'-data',str(directory/'monitor.db')],dict(os.environ,OMNIDESK_ADMIN_TOKEN=token,OMNIDESK_ADMIN_TOKEN_FILE=''))
    monitor='http://127.0.0.1:'+str(mp);ready(monitor+'/healthz',p)
    origin='http://127.0.0.1:'+str(ap)
    p=start(['node',str(ROOT.parent/'omnidesk-server/server.mjs')],dict(os.environ,OFFICIAL_HOST='127.0.0.1',OFFICIAL_PORT=str(ap),OFFICIAL_DATA_DIR=str(directory/'account'),OFFICIAL_REGISTRATION='true',OMNIDESK_MONITOR_URL=monitor,OMNIDESK_MONITOR_TOKEN=token,OMNIDESK_WINDOWS_AGENT_DIR=str(ROOT/'out/monitor-agent')))
    ready(origin+'/health',p)
    return origin
def unwrap(r):
    assert r['ok'],r.get('message')
    return r['data']
def script_from_command(command,origin):
    address=re.search(r"-Uri '([^']+)'",command)[1];code=re.search(r"'X-OmniDesk-Install'='([^']+)'",command)[1]
    assert address==origin+'/v1/monitor/install/windows/download'
    with urlopen(Request(address,headers={'X-OmniDesk-Install':code}),timeout=30) as r:script=r.read()
    assert hashlib.sha256(script).hexdigest() in command
    encoded=re.search(rb"FromBase64String\('([A-Za-z0-9+/=]+)'\)",script)[1]
    bundle=json.loads(base64.b64decode(encoded));config=bundle['config'];binary=base64.b64decode(bundle['binary'])
    assert config['serverUrl']==origin+'/v1/monitor' and config['intervalSeconds']==60
    assert binary[:2]==b'MZ' and hashlib.sha256(binary).hexdigest()==bundle['sha256']
    return config
def report(config,seq,marker):
    now=int(time.time()*1000)
    metrics={'timestamp':now,'installationId':marker,'intervalSeconds':60,'system':{'os':'Windows','hostname':'synthetic-context-host'},'cpu':{'usage':4,'cores':2,'loadAvg':[0,0,0],'perCore':[4,4]},'memory':{'usagePercent':10},'network':[],'disks':[]}
    body={'epoch':'synthetic-context-epoch','sequence':seq,'timestamp':now,'upload':0,'download':0,'metrics':metrics}
    request=Request(config['serverUrl']+'/reports',method='POST',data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+config['token']})
    with urlopen(request,timeout=10) as r:assert r.status==200
def main():
    first,second=cloud('first'),cloud('second');dp=port();exe=os.environ.get('OMNIDESK_QA_EXE')
    command=([exe] if exe else [str(ROOT/'node_modules/electron/dist/electron.exe'),str(ROOT)])+['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+str(dp),'--disable-gpu']
    env=dict(os.environ,OMNIDESK_USER_DATA_DIR=str(QA/'profile'));env.pop('ELECTRON_RUN_AS_NODE',None)
    p=start(command,env);endpoint='http://127.0.0.1:'+str(dp);ready(endpoint+'/json/version',p)
    with sync_playwright() as pw:
        browser=pw.chromium.connect_over_cdp(endpoint);page=browser.contexts[0].pages[0];page.set_default_timeout(15000);errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)));page.wait_for_load_state('networkidle')
        page.get_by_role('button',name=re.compile('暂不设置')).click()
        seeded=page.evaluate('''async ({first,second})=>{
            const check=r=>{if(!r.ok)throw new Error(r.message);return r.data}
            check(await window.omnidesk.updates.setAutoCheck(false))
            check(await window.omnidesk.account.configure(first))
            const a=check(await window.omnidesk.account.authenticate('register','context_qa','qa1234'))
            check(await window.omnidesk.account.configure(second))
            const b=check(await window.omnidesk.account.authenticate('register','context_qa','qa1234'))
            check(await window.omnidesk.account.switchAccount(a.activeAccountId))
            const windows=check(await window.omnidesk.connections.save({kind:'rdp',name:'QA Windows Context',host:'127.0.0.1',port:9,username:'qa',desktopWidth:1280,desktopHeight:800}))
            const linux=check(await window.omnidesk.connections.save({kind:'ssh',name:'QA Linux Context',host:'127.0.0.1',port:9,username:'qa'}))
            check(await window.omnidesk.monitoring.configure({enabled:false}))
            return {first:a.activeAccountId,second:b.activeAccountId,windows:windows.id,linux:linux.id}
        }''',{'first':first,'second':second})
        page.reload(wait_until='networkidle');page.get_by_role('button',name='打开连接 QA Windows Context',exact=True).click()
        toolbar=page.locator('.session-toolbar:visible');toolbar.click(button='right',position={'x':140,'y':15})
        page.get_by_role('menuitem',name='安装监控…',exact=True).click()
        dialog=page.get_by_role('dialog',name='加入服务器监控',exact=True)
        expect(dialog.get_by_label('采集端目标服务器')).to_have_value(seeded['windows'])
        expect(dialog.locator('.monitor-install-account')).to_contain_text(first)
        expect(dialog.get_by_role('button',name='导出手动安装脚本',exact=True)).to_be_enabled()
        dialog.get_by_role('button',name='生成并复制新命令',exact=True).click();field=dialog.get_by_label('Windows 安装命令',exact=True);expect(field).to_be_visible()
        command=field.input_value();assert len(unwrap(page.evaluate('()=>window.omnidesk.monitoring.nodes()')))==1
        dialog.get_by_role('button',name='复制安装命令',exact=True).click();expect(dialog.get_by_role('button',name='已复制',exact=True)).to_be_visible()
        page.screenshot(path=str(ARTIFACT/'windows-install-command.png'),full_page=True)
        config=script_from_command(command,first);report(config,1,'old-installation-marker');time.sleep(3)
        expect(dialog.get_by_role('status')).to_contain_text('等待本次安装的首次上报')
        report(config,2,config['installationId']);expect(dialog.get_by_role('status')).to_contain_text('已成功上报')
        expect(dialog.get_by_role('button',name='已接入监控',exact=True)).to_be_disabled();dialog.get_by_role('button',name='完成',exact=True).click()
        page.locator('.desktop-canvas').dispatch_event('contextmenu',{'button':2,'bubbles':True});assert page.get_by_role('menu').count()==0
        page.get_by_role('button',name='打开连接 QA Linux Context',exact=True).click()
        wt=page.get_by_role('tab').filter(has=page.locator('.tab-title',has_text='QA Windows Context'));wt.click(button='right')
        page.get_by_role('menuitem',name='安装监控…',exact=True).click();expect(dialog.get_by_label('采集端目标服务器')).to_have_value(seeded['windows'])
        expect(wt).to_have_attribute('aria-selected','false');dialog.get_by_role('button',name='生成并复制新命令',exact=True).click()
        expect(dialog.get_by_label('Windows 安装命令',exact=True)).to_be_visible();assert len(unwrap(page.evaluate('()=>window.omnidesk.monitoring.nodes()')))==1
        unwrap(page.evaluate('(id)=>window.omnidesk.account.switchAccount(id)',seeded['second']));expect(dialog).not_to_be_visible()
        wt.click(button='right');page.get_by_role('menuitem',name='安装监控…',exact=True).click();expect(dialog.locator('.monitor-install-account')).to_contain_text(second)
        dialog.get_by_role('button',name='生成并复制新命令',exact=True).click();expect(dialog.get_by_label('Windows 安装命令',exact=True)).to_be_visible()
        script_from_command(dialog.get_by_label('Windows 安装命令',exact=True).input_value(),second);assert len(unwrap(page.evaluate('()=>window.omnidesk.monitoring.nodes()')))==1
        dialog.get_by_role('button',name='完成',exact=True).click();toolbar.click(button='right',position={'x':140,'y':15});page.get_by_role('menuitem',name='安装监控…',exact=True).click()
        expect(dialog.get_by_label('采集端目标服务器')).to_have_value(seeded['linux']);assert dialog.get_by_role('button',name='导出手动安装脚本',exact=True).count()==0
        dialog.get_by_role('button',name='完成',exact=True).click();unwrap(page.evaluate('()=>window.omnidesk.account.logout()'))
        wt.click(button='right');page.get_by_role('menuitem',name='安装监控…',exact=True).click();expect(dialog.get_by_role('button',name='生成并复制新命令',exact=True)).to_be_disabled()
        expect(dialog.get_by_role('button',name='前往账号登录',exact=True)).to_be_visible();assert errors==[],errors
        page.screenshot(path=str(ARTIFACT/'context-install-login-required.png'),full_page=True);page.evaluate('()=>window.close()')
        print('PASS: real Electron tab/toolbar menus, selected connection, active tab preserved, copy/download/hash/config, installation receipt, node reuse, account switch, independent URLs, Linux and login requirement')
        print('QA_DIRECTORY='+str(QA))
if __name__=='__main__':
    try:main()
    finally:
        for p in reversed(PROCESSES):
            if p.poll() is None:
                p.terminate()
                try:p.wait(timeout=5)
                except subprocess.TimeoutExpired:p.kill()
