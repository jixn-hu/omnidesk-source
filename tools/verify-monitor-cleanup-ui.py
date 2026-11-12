"""Verify monitoring cards and filesystem alerts in an isolated real Electron client."""
import copy
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
PROFILE = Path(tempfile.mkdtemp(prefix='omnidesk-monitor-cleanup-ui-'))
ARTIFACT = Path(os.environ.get('OMNIDESK_MONITOR_CLEANUP_QA_DIR', str(PROFILE)))
ARTIFACT.mkdir(parents=True, exist_ok=True)
GIB = 1024 ** 3
ASSET = {'provider':'','region':'','expiresAt':'','price':0,'currency':'USD','billingCycle':'monthly','vendorUrl':'','autoPay':False,'trafficLimit':0,'trafficMode':'sum','resetDay':1,'timezone':'Asia/Shanghai','initialUpload':0,'initialDownload':0,'initialPeriod':''}
def disk(kind, mount, usage=28.4, inode=4.2):
    return {'fsType':kind,'mount':mount,'device':'/dev/vda2','used':18.42*GIB,'total':68.35*GIB,'available':49.93*GIB,'usagePercent':usage,'inodeUsagePercent':inode}
def metrics():
    return {'timestamp':int(time.time()*1000),'intervalSeconds':60,'system':{'hostname':'qa-host','os':'Ubuntu 22.04','arch':'x86_64','kernel':'6.1','uptime':86400},'cpu':{'usage':25,'cores':4,'loadAvg':[9,8,7],'perCore':[25]*4,'model':'QA CPU'},'memory':{'used':2*GIB,'total':4*GIB,'available':2*GIB,'free':GIB,'usagePercent':50,'swapUsed':0,'swapTotal':GIB},'disks':[disk('ext4','/')]+[disk('squashfs','/snap/'+name,100,100) for name in ['core20/2922','snapd/28254','core22/2987','lxd/41283']],'network':[{'name':'eth0','rxRate':923,'txRate':2048,'rxBytes':100000,'txBytes':200000}],'discovered':{'ip':'203.0.113.10','provider':'Fixture Cloud','region':'Test','country':'ZZ','city':'QA','timezone':'UTC','asn':'AS64500','source':'fixture','detectedAt':int(time.time()*1000)},'unavailable':[]}
def node(index, name):
    return {'id':str(index)*24,'name':name,'group':'QA','asset':dict(ASSET),'metrics':metrics(),'lastSeen':int(time.time()*1000),'upload':300*10**9,'download':400*10**9,'periodUpload':10*10**9,'periodDownload':20*10**9,'periodStart':int(time.time()*1000)-86400000,'periodEnd':int(time.time()*1000)+86400000,'coverageStart':int(time.time()*1000)-86400000,'incomplete':False}
NODES = [node(1,'Snap 正常节点'),node(2,'真实磁盘告警'),node(3,'已离线节点'),node(4,'等待接入节点'),node(5,'Windows 不支持项'),node(6,'只有镜像节点'),node(7,'真实 inode 告警')]
NODES[0]['asset']['trafficLimit']=1000*10**9
NODES[1]['metrics']['disks'].append(disk('ext4','/data',95,5))
NODES[1]['asset']['expiresAt']='2099-11-20'
NODES[1]['asset']['price']=9.99
NODES[2]['metrics']['disks'][0]['usagePercent']=99
NODES[3].pop('metrics')
NODES[3]['lastSeen']=0
NODES[4]['metrics']['unavailable']=['cpu.usage','cpu.loadAvg','disk.inodes']
NODES[4]['metrics']['cpu']['usage']=100
NODES[4]['metrics']['disks']=[disk('ntfs','C:',25,100)]
NODES[5]['metrics']['disks']=NODES[5]['metrics']['disks'][1:]
NODES[6]['metrics']['disks']=[disk('ext4','/data',20,95)]
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def reply(self, code, body):
        data=json.dumps(body).encode()
        self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_GET(self):
        if self.path=='/v1/auth/providers':return self.reply(200,{'registrationOpen':False,'gitlab':{'enabled':False}})
        if self.path=='/v1/monitor/alerts':return self.reply(200,[])
        if self.path=='/v1/monitor/nodes':
            if self.server.failure:return self.reply(503,{'error':'测试后台暂时不可用'})
            now=int(time.time()*1000)
            for item in NODES:
                if 'metrics' in item:
                    item['metrics']['timestamp']=now-(3600000 if item['id'].startswith('3') else 0)
                    item['lastSeen']=item['metrics']['timestamp']
            return self.reply(200,NODES)
        if '/history' in self.path:return self.reply(200,[{'timestamp':int(time.time()*1000),'metrics':metrics(),'upload':0,'download':0,'incomplete':False}])
        return self.reply(404,{'error':'unexpected fixture route'})
    def do_POST(self):
        data=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or '{}')
        if self.path=='/v1/auth/login':return self.reply(200,{'user':{'id':'synthetic-qa-user','username':data['username'],'role':'user'},'token':'synthetic-session','syncKey':'synthetic-key','expiresAt':int(time.time()*1000)+600000})
        return self.reply(404,{'error':'unexpected fixture route'})
def status(page):
    result=page.evaluate('() => window.omnidesk.account.status()')
    assert result['ok'],result
    return result['data']
def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    server.failure=False
    threading.Thread(target=server.serve_forever,daemon=True).start()
    origin='http://127.0.0.1:'+str(server.server_port)
    with socket.socket() as allocation:
        allocation.bind(('127.0.0.1',0));port=allocation.getsockname()[1]
    executable=os.environ.get('OMNIDESK_QA_EXE')
    command=[executable] if executable else [str(ROOT/'node_modules/electron/dist/electron.exe'),str(ROOT)]
    command+=['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+str(port),'--disable-gpu']
    environment=dict(os.environ,OMNIDESK_USER_DATA_DIR=str(PROFILE))
    environment.pop('ELECTRON_RUN_AS_NODE',None)
    process,browser=None,None
    errors=[]
    endpoint='http://127.0.0.1:'+str(port)
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
            page=launch(playwright)
            page.set_viewport_size({'width':1500,'height':1050})
            page.get_by_role('button',name=re.compile('暂不设置')).click()
            page.evaluate('''async origin=>{
                const check=r=>{if(!r.ok)throw Error(r.message);return r.data}
                check(await window.omnidesk.updates.setAutoCheck(false))
                check(await window.omnidesk.account.configure(origin))
                check(await window.omnidesk.account.authenticate('login','qa_monitor','qa1234'))
                check(await window.omnidesk.monitoring.configure({enabled:true,defaultIntervalSeconds:60}))
                window.dispatchEvent(new Event('omnidesk:monitoring-changed'))
            }''',origin)
            page.get_by_role('button',name='服务器监控',exact=True).click()
            cards=page.locator('.monitor-node-card')
            expect(cards).to_have_count(7)
            card=page.get_by_role('article',name='Snap 正常节点监控卡片',exact=True)
            expect(card).to_have_attribute('data-status','正常')
            expect(card).to_contain_text('1 / 4 核')
            expect(card).to_contain_text('2 GB / 4 GB')
            expect(card).to_contain_text('18.42 GB / 68.35 GB')
            expect(card).to_contain_text('已用 30 GB / 总量 1000 GB')
            expect(card.get_by_role('meter')).to_have_count(3)
            for text in ['Swap','负载','累计流量','未填写','待完善','未设额度','Ubuntu','Fixture Cloud']:
                assert text not in card.inner_text(),text
            expect(card.get_by_role('button',name='查看详情',exact=True)).to_be_visible()
            for action in ['重新安装','编辑','删除']:
                expect(card.get_by_role('button',name=action,exact=True)).to_have_count(0)
            expect(page.get_by_role('article',name='真实磁盘告警监控卡片',exact=True)).to_have_attribute('data-status','资源告警')
            expect(page.get_by_role('article',name='真实 inode 告警监控卡片',exact=True)).to_have_attribute('data-status','资源告警')
            expect(page.get_by_role('article',name='Windows 不支持项监控卡片',exact=True)).to_have_attribute('data-status','正常')
            expect(page.get_by_role('article',name='Windows 不支持项监控卡片',exact=True)).to_contain_text('— / 4 核')
            expect(page.get_by_role('article',name='只有镜像节点监控卡片',exact=True)).to_have_attribute('data-status','正常')
            offline=page.get_by_role('article',name='已离线节点监控卡片',exact=True)
            expect(offline).to_have_attribute('data-status','失联')
            expect(offline.locator('[aria-valuenow]')).to_have_count(0)
            waiting=page.get_by_role('article',name='等待接入节点监控卡片',exact=True)
            expect(waiting).to_have_attribute('data-status','待接入')
            expect(waiting.get_by_role('button',name='安装采集端',exact=True)).to_be_visible()
            page.screenshot(path=str(ARTIFACT/'cards-light.png'),full_page=True)
            page.get_by_label('监控排序',exact=True).select_option('cpu')
            expect(cards.first).to_contain_text('Snap 正常节点')
            page.get_by_label('监控排序',exact=True).select_option('disk')
            expect(cards.first).to_contain_text('真实磁盘告警')
            card.get_by_role('button',name='查看详情',exact=True).click()
            detail=page.locator('.monitor-detail')
            expect(detail.locator('.monitor-disks > .monitor-table-wrap tbody tr')).to_have_count(1)
            fold=detail.locator('.monitor-excluded-disks')
            expect(fold.locator('summary')).to_contain_text('4 个')
            assert fold.get_attribute('open') is None
            fold.locator('summary').click()
            expect(fold.locator('tbody tr')).to_have_count(4)
            expect(fold).to_contain_text('不参与容量和 inode 告警')
            expect(detail.get_by_role('button',name='重新安装采集端',exact=True)).to_be_visible()
            expect(detail.get_by_role('button',name='编辑资料',exact=True)).to_be_visible()
            page.screenshot(path=str(ARTIFACT/'details-disks.png'),full_page=True)
            detail.get_by_role('button',name='← 返回总览',exact=True).click()
            page.get_by_role('button',name='列表视图',exact=True).click()
            table=page.locator('.monitor-node-table')
            expect(table.locator('tbody tr')).to_have_count(7)
            assert '负载' not in table.locator('thead').inner_text()
            assert 'Swap' not in table.inner_text()
            row=table.locator('tbody tr').filter(has=page.get_by_role('button',name='Snap 正常节点',exact=True))
            expect(row).to_contain_text('1 / 4 核')
            expect(row).to_contain_text('18.42 GB / 68.35 GB')
            page.screenshot(path=str(ARTIFACT/'list-light.png'),full_page=True)
            page.get_by_role('button',name='卡片视图',exact=True).click()
            page.evaluate("document.documentElement.dataset.theme='dark'")
            page.set_viewport_size({'width':960,'height':900})
            assert page.locator('.monitor-dashboard').evaluate('e=>e.scrollWidth<=e.clientWidth+1')
            for element in cards.all():assert element.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
            page.screenshot(path=str(ARTIFACT/'cards-dark-narrow.png'),full_page=True)
            # Current values survive a failed refresh while the state becomes explicit.
            server.failure=True
            page.get_by_role('button',name='刷新',exact=True).click()
            page.get_by_text('测试后台暂时不可用',exact=True).wait_for()
            expect(cards).to_have_count(7)
            expect(card).to_contain_text('203.0.113.10')
            server.failure=False
            page.get_by_role('button',name='刷新',exact=True).click()
            expect(card).to_have_attribute('data-status','正常')
            assert errors==[],errors
            stop(page)
            print('PASS: actual Electron cards/list/details, Snap exclusions and sort, CPU used/total, real disk/inode alarms, unsupported/offline/waiting states, decimal quotas, compact controls, disk fold, refresh recovery, light/dark and narrow layout')
            print('QA_DIRECTORY='+str(PROFILE))
    finally:
        if browser:
            try:browser.close()
            except Exception:pass
        if process:
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate();process.wait(timeout=10)
        server.shutdown();server.server_close()

if __name__=='__main__':main()
