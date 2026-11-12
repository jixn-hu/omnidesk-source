"""Real Electron batch UI with two local clouds; never execute downloaded installers."""
import importlib.util,json,os,re,subprocess,time
from pathlib import Path
from urllib.error import HTTPError
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('context_fixture',ROOT/'tools/verify-monitor-context-ui.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
ARTIFACT=Path(os.environ.get('OMNIDESK_BATCH_QA_DIR',str(f.QA)));ARTIFACT.mkdir(parents=True,exist_ok=True)
def main():
    first,second=f.cloud('batch-first'),f.cloud('batch-second')
    debug=f.port();exe=os.environ.get('OMNIDESK_QA_EXE')
    command=([exe] if exe else [str(ROOT/'node_modules/electron/dist/electron.exe'),str(ROOT)])+['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+str(debug),'--disable-gpu']
    env=dict(os.environ,OMNIDESK_USER_DATA_DIR=str(f.QA/'batch-profile'));env.pop('ELECTRON_RUN_AS_NODE',None)
    process=f.start(command,env);endpoint='http://127.0.0.1:'+str(debug);f.ready(endpoint+'/json/version',process)
    with sync_playwright() as pw:
        browser=pw.chromium.connect_over_cdp(endpoint);page=browser.contexts[0].pages[0];page.set_default_timeout(18000)
        errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
        try:
            page.wait_for_load_state('networkidle');page.get_by_role('button',name=re.compile('暂不设置')).click()
            seeded=page.evaluate('''async ({first,second})=>{
                const check=r=>{if(!r.ok)throw new Error(r.message);return r.data}
                check(await window.omnidesk.updates.setAutoCheck(false))
                check(await window.omnidesk.account.configure(first))
                const a=check(await window.omnidesk.account.authenticate('register','batch_qa','qa1234'))
                check(await window.omnidesk.account.configure(second))
                const b=check(await window.omnidesk.account.authenticate('register','batch_qa','qa1234'))
                check(await window.omnidesk.account.switchAccount(a.activeAccountId))
                for(const [name,kind,group,port] of [['QA Windows A','rdp','Windows',9],['QA Windows B','rdp','Windows',10],['QA Linux unavailable','ssh','Linux',9]]) {
                    check(await window.omnidesk.connections.save({kind,name,group,host:'127.0.0.1',port,username:'qa',...(kind==='rdp'?{desktopWidth:1280,desktopHeight:800}:{})}))
                }
                check(await window.omnidesk.monitoring.configure({enabled:false}))
                return {first:a.activeAccountId,second:b.activeAccountId}
            }''',{'first':first,'second':second})
            page.reload(wait_until='networkidle');page.get_by_role('button',name=re.compile('服务器管理')).first.click()
            page.evaluate('''()=>{window.qaClipboardWrites=[];window.qaClipboardFail=false;const write=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=async text=>{if(window.qaClipboardFail)throw new Error('Synthetic clipboard failure');await write(text);window.qaClipboardWrites.push(text)}}''')
            for name in ['QA Windows A','QA Windows B','QA Linux unavailable']:page.get_by_role('checkbox',name='选择 '+name,exact=True).check()
            page.locator('.server-bulk').get_by_role('button',name='批量安装采集端',exact=True).click()
            dialog=page.get_by_role('dialog',name='批量安装监控采集端',exact=True)
            expect(dialog.get_by_role('checkbox',checked=True)).to_have_count(3)
            expect(dialog.locator('.monitor-install-account')).to_contain_text(first)
            assert dialog.bounding_box()['width']>=780,'Wide dialog should use the available space'
            page.screenshot(path=str(ARTIFACT/'batch-selection.png'),full_page=True)
            dialog.get_by_role('button',name='开始处理 3 台',exact=True).evaluate('(e)=>{e.click();e.click()}')
            expect(dialog.locator('.monitor-batch-row[data-status="command"]')).to_have_count(2)
            expect(dialog.locator('.monitor-batch-row[data-status="failed"]')).to_have_count(1)
            expect(dialog.get_by_role('button',name='重试未完成 1 台',exact=True)).to_be_enabled()

            assert page.evaluate('window.qaClipboardWrites')==[], 'Batch generation must leave per-machine clipboard selection to the user'
            row_a=dialog.locator('.monitor-batch-row').filter(has=page.get_by_text('QA Windows A',exact=True))
            old_command=row_a.get_by_label('QA Windows A 安装命令',exact=True).input_value()
            row_a.get_by_role('button',name='生成并复制新命令',exact=True).click()
            expect(row_a.get_by_role('button',name='已复制',exact=True)).to_be_visible()
            new_command=row_a.get_by_label('QA Windows A 安装命令',exact=True).input_value()
            assert new_command!=old_command and page.evaluate('window.qaClipboardWrites.at(-1)')==new_command
            try:
                f.script_from_command(old_command,first)
                raise AssertionError('Replaced command unexpectedly downloaded')
            except HTTPError as error:
                assert error.code==410 and json.loads(error.read())['code']=='INSTALL_TICKET_REPLACED'
            row_b=dialog.locator('.monitor-batch-row').filter(has=page.get_by_text('QA Windows B',exact=True))
            page.evaluate('window.qaClipboardFail=true')
            row_b.get_by_role('button',name='生成并复制新命令',exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('新命令已生成，但复制失败')
            expect(row_b.get_by_role('button',name='复制此机命令',exact=True)).to_be_visible()
            page.evaluate('window.qaClipboardFail=false')
            row_b.get_by_role('button',name='复制此机命令',exact=True).click()
            expect(row_b.get_by_role('button',name='已复制',exact=True)).to_be_visible()
            expect(dialog.get_by_role('alert')).to_have_count(0)
            configs=[]
            for name in ['QA Windows A','QA Windows B']:
                row=dialog.locator('.monitor-batch-row').filter(has=page.get_by_text(name,exact=True));row.locator('summary').click()
                configs.append(f.script_from_command(row.get_by_label(name+' 安装命令',exact=True).input_value(),first))
                row.get_by_role('button',name='复制此机命令',exact=True).click();expect(row.get_by_role('button',name='已复制',exact=True)).to_be_visible()
            assert configs[0]['nodeId']!=configs[1]['nodeId']
            f.report(configs[0],1,'old-installation-marker');time.sleep(5.2)
            expect(dialog.locator('.monitor-batch-row[data-status="reported"]')).to_have_count(0)
            for config in configs:f.report(config,2,config['installationId'])
            expect(dialog.locator('.monitor-batch-row[data-status="reported"]')).to_have_count(2)
            expect(dialog.locator('.monitor-batch-row[data-status="command"]')).to_have_count(0)
            assert len(f.unwrap(page.evaluate('()=>window.omnidesk.monitoring.nodes()')))==2
            dialog.get_by_role('button',name='重试未完成 1 台',exact=True).click()
            expect(dialog.locator('.monitor-batch-row[data-status="failed"]')).to_have_count(1)
            expect(dialog.get_by_role('button',name='重试未完成 1 台',exact=True)).to_be_enabled()
            assert len(f.unwrap(page.evaluate('()=>window.omnidesk.monitoring.nodes()')))==2
            page.screenshot(path=str(ARTIFACT/'batch-results.png'),full_page=True)
            page.set_viewport_size({'width':720,'height':760});page.evaluate("document.documentElement.dataset.theme='light'")
            assert dialog.evaluate('(e)=>e.scrollWidth<=e.clientWidth')
            box=dialog.bounding_box();assert box['x']>=0 and box['y']>=0 and box['x']+box['width']<=721 and box['y']+box['height']<=761
            expect(dialog.get_by_role('button',name='完成',exact=True)).to_be_in_viewport()
            page.screenshot(path=str(ARTIFACT/'batch-results-light-narrow.png'),full_page=True)
            dialog.get_by_role('button',name='完成',exact=True).click();page.set_viewport_size({'width':1100,'height':820})
            page.get_by_role('button',name='服务器监控',exact=True).first.click()
            page.locator('.monitor-page-header').get_by_role('button',name='批量安装采集端',exact=True).click()
            expect(dialog.get_by_role('checkbox',checked=True)).to_have_count(0)
            dialog.get_by_label('批量安装分组',exact=True).select_option('Windows');expect(dialog.get_by_role('checkbox')).to_have_count(2)
            dialog.get_by_role('button',name='选择筛选结果',exact=True).click();dialog.get_by_role('button',name='开始处理 2 台',exact=True).click()
            expect(dialog.locator('.monitor-batch-row[data-status="command"]')).to_have_count(2)
            assert len(f.unwrap(page.evaluate('()=>window.omnidesk.monitoring.nodes()')))==2,'Repeat installation must reuse bound nodes'
            repaired=dialog.locator('.monitor-batch-row').filter(has=page.get_by_text('QA Windows A',exact=True))
            repaired.get_by_role('button',name='单独处理',exact=True).click()
            single=page.get_by_role('dialog',name='加入服务器监控',exact=True)
            single.get_by_role('button',name='生成并复制新命令',exact=True).click()
            field=single.get_by_label('Windows 安装命令',exact=True);expect(field).to_be_visible()
            expect(single.get_by_role('button',name='已复制',exact=True)).to_be_visible()
            first_command=field.input_value()
            assert page.evaluate('window.qaClipboardWrites.at(-1)')==first_command
            page.evaluate('window.qaClipboardFail=true')
            single.get_by_role('button',name='生成并复制新命令',exact=True).click()
            expect(single.get_by_role('alert')).to_contain_text('新命令已生成，但复制失败')
            expect(single.get_by_role('button',name='复制安装命令',exact=True)).to_be_visible()
            assert field.input_value()!=first_command
            page.evaluate('window.qaClipboardFail=false')
            single.get_by_role('button',name='复制安装命令',exact=True).click()
            expect(single.get_by_role('button',name='已复制',exact=True)).to_be_visible()
            expect(single.get_by_role('alert')).to_have_count(0)
            assert page.evaluate('window.qaClipboardWrites.at(-1)')==field.input_value()
            page.screenshot(path=str(ARTIFACT/'generate-and-copy.png'),full_page=True)
            config=f.script_from_command(field.input_value(),first)
            assert f.script_from_command(field.input_value(),first)==config, 'Repeated download must preserve the same bundle'
            f.report(config,3,config['installationId'])
            expect(single.get_by_role('status')).to_contain_text('已成功上报')
            single.get_by_role('button',name='完成',exact=True).click()
            expect(repaired).to_have_attribute('data-status','reported')
            expect(repaired.get_by_role('button',name='重试',exact=True)).to_have_count(0)
            expect(dialog.locator('.monitor-batch-row[data-status="command"]')).to_have_count(1)
            page.screenshot(path=str(ARTIFACT/'batch-single-completion.png'),full_page=True)
            f.unwrap(page.evaluate('id=>window.omnidesk.account.switchAccount(id)',seeded['second']))
            expect(dialog).to_have_count(0);assert f.unwrap(page.evaluate('()=>window.omnidesk.monitoring.nodes()'))==[]
            assert errors==[],errors
            (ARTIFACT/'batch-ui-result.json').write_text(json.dumps({'passed':True,'checks':['server selection','monitor entry and group filter','Linux failure does not block Windows','per-machine commands and receipts','old marker ignored','retry excludes successful nodes','node reuse','double start guarded','single installer success updates batch','single and batch generate and copy','clipboard failure and manual copy recovery','repeat download','replaced command reason','light narrow layout','account switch'],'profile':str(f.QA/'batch-profile')},indent=2)+'\n',encoding='utf-8')
            print('PASS: real Electron batch entries, selection, failure/retry, unique Windows commands, first report matching, node reuse, single installer completion, narrow layout and account switch.')
            page.evaluate('()=>window.close()')
        except Exception:
            try:page.screenshot(path=str(ARTIFACT/'batch-failure.png'),full_page=True)
            except Exception:pass
            raise
if __name__=='__main__':
    try:main()
    finally:
        for process in reversed(f.PROCESSES):
            if process.poll() is None:
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill()
