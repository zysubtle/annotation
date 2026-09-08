'use strict';
// Controlled DOM/canvas substitutes: logic/runtime checks, not browser visual QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'annotator/web/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'annotator/web/app.js'), 'utf8');
const registered = [];
let arcCount = 0;
class Element {
  constructor(tag) {this.tagName=tag.toUpperCase();this.children=[];this.parent=null;this.dataset={};this.style={};this.disabled=false;this.hidden=false;this.value='';this.attrs={};this.listeners={};this.textContent='';this.className='';this.clientWidth=600;this.classList={toggle:(name,on)=>{const names=new Set(this.className.split(' ').filter(Boolean));if(on??!names.has(name))names.add(name);else names.delete(name);this.className=[...names].join(' ');}};}
  append(...nodes){for(const node of nodes){this.children.push(node);node.parent=this;}}
  appendChild(node){this.append(node);return node;}
  replaceChildren(...nodes){for(const child of this.children)child.parent=null;this.children=[];this.append(...nodes);}
  setAttribute(name,value){this.attrs[name]=String(value);if(name==='id')this.id=value;if(name==='class')this.className=value;}
  getAttribute(name){return this.attrs[name];}
  addEventListener(name,fn){this.listeners[name]=fn;}
  closest(selector){let node=this;while(node){if(selector.startsWith('#')&&node.id===selector.slice(1))return node;node=node.parent;}return null;}
  contains(target){let node=target;while(node){if(node===this)return true;node=node.parent;}return false;}
  showModal(){this.open=true;}
  close(){this.open=false;}
  click(){return this.onclick?.();}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);this.parent=null;}
  setCustomValidity(value){this.validationMessage=value;}
  reportValidity(){return !this.validationMessage;}
  scrollIntoView(){}
  focus(){document.activeElement=this;}
  setPointerCapture(id){this.captured=id;}
  hasPointerCapture(id){return this.captured===id;}
  releasePointerCapture(id){if(this.captured===id)this.captured=null;}
  getBoundingClientRect(){return {left:0,top:0,width:this.clientWidth,height:116};}
  getContext(){this.draws??=[];return new Proxy({}, {get:(target,name)=>(...args)=>{if(name==='arc')arcCount++;this.draws.push({name,args});},set:()=>true});}
}
const document = {body:new Element('body'),listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},createElement:tag=>new Element(tag),modelContext:{registerTool:tool=>registered.push(tool)}};
const stack=[document.body],ids=new Map();
for(const match of html.matchAll(/<\/?([a-z][a-z0-9-]*)([^>]*)>/gi)){
  const tag=match[1].toLowerCase();if(match[0].startsWith('</')){if(!['html','head','body'].includes(tag)&&stack.length>1)stack.pop();continue;}
  if(['html','head','body','meta','link','script','title'].includes(tag))continue;
  const node=new Element(tag);for(const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)){const[name,value]=[attr[1],attr[2]??''];node.setAttribute(name,value);if(name==='id')ids.set(value,node);if(name==='disabled')node.disabled=true;if(name==='hidden')node.hidden=true;if(name==='value')node.value=value;if(name.startsWith('data-'))node.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;}
  stack.at(-1).append(node);if(!['input','br','hr'].includes(tag))stack.push(node);
}
const all=()=>{const result=[];const walk=node=>{result.push(node);node.children.forEach(walk);};walk(document.body);return result;};
document.getElementById=id=>ids.get(id)||null;
document.querySelectorAll=selector=>all().filter(node=>{
  if(selector==='button,input,select')return ['BUTTON','INPUT','SELECT'].includes(node.tagName);
  if(selector==='[data-close]')return node.dataset.close!==undefined;
  if(selector==='dialog[open]')return node.tagName==='DIALOG'&&node.open;
  if(selector==='.signals canvas')return node.tagName==='CANVAS'&&node.parent?.parent?.className==='signals';
  if(selector.startsWith('.'))return node.className.split(' ').includes(selector.slice(1));
  return false;
});
document.querySelector=selector=>document.querySelectorAll(selector)[0]||null;
// Required literals must resolve, except the documented class fallback.
for(const match of script.matchAll(/\$\('([^']+)'\)/g))assert.ok(ids.has(match[1])||match[1]==='working-surface',`missing DOM id: ${match[1]}`);
ids.get('ppg-slot').value='2';ids.get('label-type').value='EXERCISE';
const tid='a'.repeat(32),rid='b'.repeat(32);
const task={id:tid,name:'测试任务',revision:1,last_export_revision:null,records:[{id:rid,filename:'真实测试.csv',sha256:'c'.repeat(64),bytes:100,status:'ready',has_original:true,t0:'2026/08/19 14:31:08_000',min_ms:0,max_ms:80,annotation_end_ms:81,counts:{hw903:3,rr:0},issues:[],completed:false,algorithm:null,annotations:[{id:'d'.repeat(32),start_ms:0,end_ms:40,label:'NON',note:''}]}]};
let initialized=false;
let expireNext=false;
let failSaveNext=false;
const requests=[];
async function fetchStub(url,options={}){
  requests.push({url,options});let body;
  if(url==='/api/config')body={token:'test',max_file_bytes:67108864,storage_path:'/isolated-test'};
  else if(url==='/api/tasks'){body={tasks:initialized?[{id:tid,name:task.name,record_count:1,bytes:100,revision:task.revision}]:[]};initialized=true;}
  else if(url===`/api/tasks/${tid}`)body=task;
  else if(url.includes('/plot?')){const fields=new URL('http://test'+url).searchParams.get('fields').split(',');body={gaps:[],series:fields.map(field=>({field,present:true,min:0,max:1,unit:'测试单位',points:[[0,0,1],[40,null,2],[80,1,3]],numeric_count:2,empty_count:1,column_absent_count:0}))};}
  else if(url.endsWith('/annotations')){if(failSaveNext){failSaveNext=false;return {ok:false,status:409,json:async()=>({error:'版本冲突，草稿未保存'})};}if(expireNext){expireNext=false;return {ok:false,status:403,json:async()=>({error:'会话已失效，请刷新页面；跨站写入被拒绝'})};}assert.equal(options.headers['Content-Type'],'application/json');const input=JSON.parse(options.body);assert.equal(input.revision,task.revision);task.records[0].annotations=input.annotations.map((label,i)=>({id:String(i+1).repeat(32),...label}));task.records[0].completed=input.completed;task.revision++;body=task;}
  else throw new Error('unexpected API '+url);
  return {ok:true,json:async()=>structuredClone(body)};
}
const window={devicePixelRatio:1,listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},requestAnimationFrame:fn=>setImmediate(fn)};
const mediaQueries=new Map(),timers=new Map();let timerId=0;
const matchMedia=query=>{if(!mediaQueries.has(query))mediaQueries.set(query,{matches:query.includes('hover: hover'),listeners:{},addEventListener(name,fn){this.listeners[name]=fn;}});return mediaQueries.get(query);};
const context=vm.createContext({document,window,fetch:fetchStub,getComputedStyle:()=>({color:'#123456',getPropertyValue:()=>''}),ResizeObserver:class{observe(){}},matchMedia,setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),AbortController,Blob,URL,console});
const evaluate=source=>vm.runInContext(source,context);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const canvas=()=>ids.get('signals').children[0].children[1];
const xFor=t=>72+(t-evaluate('state.from'))/(evaluate('state.to-state.from'))*512;
const pointer=(type,t,extra={})=>canvas().listeners[type]({button:0,isPrimary:true,pointerId:1,clientX:xFor(t),clientY:45,preventDefault(){},...extra});
const selection=()=>JSON.parse(evaluate('JSON.stringify(selectedInterval())'));
const key=(type,extra)=>window.listeners[type]({target:document.activeElement||document.body,preventDefault(){this.prevented=true;},...extra});
(async()=>{
  evaluate(script);await tick();await tick();
  assert.equal(ids.get('empty').hidden,false);
  assert.equal(ids.get('download').disabled,true);
  assert.equal(registered.length,2);
  await evaluate(`openTask('${tid}')`);
  assert.equal(ids.get('ppg-signals').children.length,4);
  assert.equal(ids.get('signals').children.length,5);
  assert.ok(arcCount>=18,'isolated points must be visible in all 9 signals');
  assert.equal(selection(),null,'opening a record must not preselect its whole viewport');
  assert.equal(ids.get('save-label').disabled,true);
  evaluate('busy(true)');
  assert.equal(ids.get('confirm-ok').disabled,false,'confirmation must stay interactive while action awaits it');
  assert.equal(ids.get('upload').disabled,true);
  evaluate('busy(false)');
  const compared=evaluate(`differences({annotations:[{start_ms:0,end_ms:10,label:'NON'},{start_ms:10,end_ms:20,label:'UNKNOWN'},{start_ms:30,end_ms:40,label:'EXERCISE'}],algorithm:{intervals:[{start_ms:0,end_ms:50,label:'EXERCISE'}]}})`);
  assert.equal(compared.length,1);assert.equal(compared[0].end_ms,10,'unknown and unlabelled must not become NON');
  evaluate("state.dirty=true; $('label-note').value='保留草稿'");
  const edit=ids.get('labels').children[0].children[1].children[0];
  const editing=edit.onclick();await tick();
  assert.equal(ids.get('confirm-dialog').open,true,'editing another label must confirm draft discard');
  ids.get('confirm-cancel').onclick();await editing;
  assert.equal(ids.get('label-note').value,'保留草稿');
  // Larger isolated time domain for pointer tests, without writing a real task.
  evaluate('resetDraft(); record().annotation_end_ms=10000; record().max_ms=9999; record().annotations=[]; state.from=0; state.to=10000; makeSignals()');
  const savesBefore=requests.filter(r=>r.url.endsWith('/annotations')).length;
  pointer('pointerdown',4000);pointer('pointerup',4000);
  assert.equal(selection(),null,'single click must not create zero-duration annotation');
  assert.equal(evaluate('state.cursorMs'),4000);
  pointer('pointerdown',6000,{button:2});pointer('pointermove',8000);pointer('pointerup',8000);
  assert.equal(selection(),null,'right button must not create a selection');
  pointer('pointerdown',6000);pointer('pointermove',2000);
  assert.deepEqual(selection(),{start:2000,end:6000},'reverse drag normalizes time before release');
  await tick();
  for(const chart of document.querySelectorAll('.signals canvas'))assert.ok(chart.draws.some(d=>d.name==='fillRect'&&d.args[1]===12&&Math.abs(d.args[2]-204.8)<.01),'all tracks show identical live selection');
  pointer('pointerup',2000);
  assert.equal(evaluate('state.dirty'),true);
  assert.equal(ids.get('save-label').disabled,false);
  assert.equal(requests.filter(r=>r.url.endsWith('/annotations')).length,savesBefore,'mouse release must not save');
  pointer('pointerdown',2000);pointer('pointermove',1000);pointer('pointerup',1000);
  assert.deepEqual(selection(),{start:1000,end:6000},'left boundary resizes');
  pointer('pointerdown',6000);pointer('pointermove',7000);pointer('pointerup',7000);
  assert.deepEqual(selection(),{start:1000,end:7000},'right boundary resizes');
  pointer('pointerdown',4000);pointer('pointermove',12000);pointer('pointerup',12000);
  assert.deepEqual(selection(),{start:4000,end:10000},'whole move clamps with unchanged duration');
  pointer('pointerdown',7000);pointer('pointermove',-4000);pointer('pointerup',-4000);
  assert.deepEqual(selection(),{start:0,end:6000},'whole move clamps at start');
  pointer('pointerdown',0);pointer('pointermove',8000);pointer('pointerup',8000);
  assert.deepEqual(selection(),{start:5999,end:6000},'handle cannot cross the other endpoint');
  evaluate('setSelection(2000,6000)');
  pointer('pointerdown',6000);pointer('pointermove',1000);pointer('pointerup',1000);
  assert.deepEqual(selection(),{start:2000,end:2001},'right handle also clamps without reversing endpoints');
  evaluate("setSelection(2000,6000); $('label-note').value='必须保留'");
  const beforeCancel=evaluate('JSON.stringify(draftSnapshot())');
  for(const endEvent of ['pointercancel','lostpointercapture']){
    pointer('pointerdown',4000);pointer('pointermove',5000);pointer(endEvent,5000);
    assert.equal(evaluate('JSON.stringify(draftSnapshot())'),beforeCancel,endEvent+' restores full draft');
    assert.equal(evaluate('state.drag'),null);assert.equal(canvas().captured,null);
  }
  pointer('pointerdown',4000);pointer('pointermove',5000);key('keydown',{key:'Escape'});
  assert.equal(evaluate('JSON.stringify(draftSnapshot())'),beforeCancel,'Esc during gesture rolls back');
  pointer('pointerdown',4000);pointer('pointermove',5000);window.listeners.blur();
  assert.equal(evaluate('JSON.stringify(draftSnapshot())'),beforeCancel,'blur restores draft');
  evaluate('state.from=1000; state.to=9000');
  key('keydown',{code:'Space',target:ids.get('label-note')});
  assert.equal(evaluate('state.spaceDown'),false,'space in a text field must not pan');
  ids.get('label-note').focus();pointer('pointerdown',4000);pointer('pointerup',4000);
  assert.equal(document.activeElement,canvas(),'plot interaction transfers focus away from old form field');
  // The cursor change from the focus click is intentional; compare pan snapshot after it.
  const focusPanSnapshot=evaluate('JSON.stringify(draftSnapshot())');
  key('keydown',{code:'Space'});pointer('pointerdown',4000);pointer('pointermove',3000);
  assert.equal(evaluate('state.from'),2000);assert.equal(evaluate('state.to'),10000);
  // Event x must use the original mapping, since viewport has moved meanwhile.
  pointer('pointerup',3000,{clientX:200});await tick();await tick();key('keyup',{code:'Space'});
  assert.equal(evaluate('JSON.stringify(draftSnapshot())'),focusPanSnapshot,'pan preserves full draft');
  assert.equal(requests.filter(r=>r.url.endsWith('/annotations')).length,savesBefore);
  evaluate('state.from=1000; state.to=9000');key('keydown',{code:'Space'});
  pointer('pointerdown',4000);pointer('pointermove',3000);pointer('pointercancel',3000);key('keyup',{code:'Space'});
  assert.equal(evaluate('state.from'),1000,'canceled pan restores view');
  ids.get('ppg-slot').value='3';await ids.get('ppg-slot').onchange();
  assert.deepEqual(selection(),{start:2000,end:6000},'PPG slot redraw keeps draft');
  await ids.get('zoom-selection').onclick();
  assert.equal(evaluate('state.from'),2000);assert.equal(evaluate('state.to'),6000);
  assert.deepEqual(selection(),{start:2000,end:6000});
  // Full record gaps are warnings; overlap/out-of-range are blocking errors.
  evaluate('state.plot.gaps=[{start_ms:2500,end_ms:4000}]; selectionInfo()');
  assert.equal(ids.get('selection-warning').hidden,false);assert.equal(ids.get('save-label').disabled,false);
  evaluate("record().annotations=[{id:'saved',start_ms:5000,end_ms:8000,label:'NON',note:'原备注'}]; selectionInfo()");
  assert.equal(ids.get('save-label').disabled,true);
  ids.get('annotation-form').onsubmit({preventDefault(){}});await tick();
  assert.equal(requests.filter(r=>r.url.endsWith('/annotations')).length,savesBefore,'invalid overlap is blocked before request');
  evaluate('setSelection(2000,5000)');assert.equal(ids.get('save-label').disabled,false,'half-open adjacent endpoints do not overlap');
  evaluate('setSelection(-1,5000)');assert.equal(ids.get('save-label').disabled,true);
  evaluate('resetDraft(); state.from=0; state.to=10000');
  pointer('pointerdown',7000,{clientY:7});await tick();await tick();
  assert.equal(evaluate('state.editing'),'saved','top label stripe opens saved label');
  assert.deepEqual(selection(),{start:5000,end:8000});
  assert.equal(ids.get('save-label').disabled,false,'editing own label excludes its overlap');
  pointer('pointerdown',1000);pointer('pointermove',2000);pointer('pointerup',2000);
  assert.deepEqual(selection(),{start:5000,end:8000},'new selection outside edit cannot overwrite saved label');
  pointer('pointerdown',5000);pointer('pointermove',4500);pointer('pointerup',4500);
  failSaveNext=true;ids.get('annotation-form').onsubmit({preventDefault(){}});await tick();await tick();
  assert.deepEqual(selection(),{start:4500,end:8000},'failed save preserves selection');
  assert.equal(evaluate('state.editing'),'saved');assert.equal(evaluate('state.dirty'),true);
  assert.equal(evaluate('record().annotations[0].start_ms'),5000,'failed save preserves stored label');
  key('keydown',{key:'Escape'});assert.equal(selection(),null);
  assert.equal(evaluate('record().annotations[0].start_ms'),5000,'Esc never deletes saved labels');
  // Restore original backend fixture for existing persistence/session checks.
  await evaluate(`openTask('${tid}')`);
  evaluate("setSelection(40,81); $('label-type').value='EXERCISE'; $('label-note').value='确认后保存'");
  ids.get('annotation-form').onsubmit({preventDefault(){}});await tick();await tick();
  assert.equal(task.revision,2,'explicit confirmation submits the draft');
  assert.equal(task.records[0].annotations.length,2);
  assert.equal(task.records[0].annotations[1].note,'确认后保存');
  assert.equal(selection(),null,'successful confirmation clears draft');
  assert.equal(ids.get('save-label').disabled,true);
  evaluate("resetDraft(); $('ppg-slot').value='4'");await evaluate('loadPlot()');
  assert.ok(requests.at(-1).url.includes('slot4-adc0,slot4-adc1,slot4-adc2,slot4-adc3'));
  expireNext=true;
  await evaluate("saveAnnotations([{start_ms:0,end_ms:81,label:'EXERCISE',note:'测试'}],false)");
  assert.equal(task.revision,3);
  assert.equal(ids.get('save-status').textContent,'已保存到本机');
  assert.equal(evaluate('state.dirty'),false);
  const readTool=registered.find(tool=>tool.name==='list_annotation_tasks');
  assert.equal((await readTool.execute({})).length,1);
  const openTool=registered.find(tool=>tool.name==='open_annotation_record');
  await assert.rejects(()=>openTool.execute({task_id:'invalid',record_id:rid}),/无效/);
  const result=await openTool.execute({task_id:tid,record_id:rid});
  assert.equal(result.record_id,rid);
  // Drawer state tests use controlled events/timers, not browser visual assertions.
  const launcher=ids.get('records-launcher'),panel=ids.get('records-panel'),toggle=ids.get('records-toggle');
  const enter=(element,extra={})=>element.listeners.pointerenter({pointerType:'mouse',buttons:0,...extra});
  const leave=(element,extra={})=>element.listeners.pointerleave({pointerType:'mouse',...extra});
  const flushTimers=()=>{const pending=[...timers.values()];timers.clear();for(const timer of pending)timer.fn();};
  const drawerOpen=()=>evaluate('recordsDrawer.open');
  const outside=()=>document.listeners.pointerdown({target:canvas()});
  const hoverMode=matchMedia('(min-width: 901px) and (hover: hover) and (pointer: fine)');
  assert.equal(drawerOpen(),false);assert.equal(panel.inert,true);assert.equal(toggle.getAttribute('aria-expanded'),'false');
  assert.equal(ids.get('records-count').textContent,'1');
  evaluate("setSelection(40,81); $('label-note').value='抽屉不得修改草稿'");
  document.body.focus();
  const drawerDraft=evaluate('JSON.stringify(draftSnapshot())'),drawerView=evaluate('JSON.stringify([state.from,state.to,state.sequence])');
  const postsBeforeDrawer=requests.filter(request=>request.options.method==='POST').length;
  enter(launcher);assert.equal(drawerOpen(),true);assert.equal(panel.inert,false);
  assert.equal(toggle.getAttribute('aria-expanded'),'true');
  leave(launcher);assert.equal(drawerOpen(),true,'close must have a grace period');
  assert.equal([...timers.values()][0].ms,250);
  enter(panel);flushTimers();assert.equal(drawerOpen(),true,'entering panel cancels pending close');
  leave(panel);flushTimers();assert.equal(drawerOpen(),false,'leaving both regions collapses');
  assert.equal(panel.inert,true);assert.equal(panel.getAttribute('aria-hidden'),'true');
  assert.equal(evaluate('JSON.stringify(draftSnapshot())'),drawerDraft);
  assert.equal(evaluate('JSON.stringify([state.from,state.to,state.sequence])'),drawerView,'open/close must not reload or change timeline');
  enter(launcher);leave(launcher);panel.focus();panel.listeners.focusin();flushTimers();
  assert.equal(drawerOpen(),true,'keyboard focus inside keeps the drawer open');
  document.body.focus();panel.listeners.focusout();flushTimers();assert.equal(drawerOpen(),false);
  enter(launcher);ids.get('records-pin').onclick();leave(launcher);flushTimers();outside();
  assert.equal(drawerOpen(),true,'pinned drawer stays open after leaving and outside click');
  assert.equal(ids.get('records-pin').getAttribute('aria-pressed'),'true');
  pointer('pointerdown',40);pointer('pointermove',45);key('keydown',{key:'Escape'});
  assert.equal(evaluate('state.drag'),null,'Esc cancels active waveform gesture even with a fixed drawer');
  assert.equal(evaluate('JSON.stringify(draftSnapshot())'),drawerDraft,'gesture cancellation restores its snapshot');
  assert.equal(drawerOpen(),true,'canceling the gesture does not also collapse the fixed list');
  ids.get('records-pin').onclick();flushTimers();assert.equal(drawerOpen(),false,'unpin restores automatic close');
  enter(launcher);key('keydown',{key:'Escape'});
  assert.equal(drawerOpen(),false);assert.equal(evaluate('JSON.stringify(draftSnapshot())'),drawerDraft,'drawer Escape must not cancel annotation');
  enter(launcher);toggle.onclick({detail:1});assert.equal(drawerOpen(),true,'click after hover latches instead of flickering closed');
  toggle.onclick({detail:1});assert.equal(drawerOpen(),false);
  toggle.listeners.keydown({key:'ArrowRight',preventDefault(){}});
  assert.equal(drawerOpen(),true);assert.equal(document.activeElement,panel,'keyboard opening gives focus to panel');
  ids.get('records-close').onclick();assert.equal(drawerOpen(),false);assert.equal(document.activeElement,toggle);
  enter(launcher);outside();assert.equal(drawerOpen(),false,'outside click closes unpinned panel');
  pointer('pointerdown',60);enter(launcher);
  assert.equal(drawerOpen(),false,'selection drag cannot trigger hover drawer');
  assert.notEqual(evaluate('state.drag'),null,'hover must not cancel the active gesture');
  pointer('pointercancel',60);key('keydown',{code:'Space'});pointer('pointerdown',60);enter(launcher);
  assert.equal(evaluate('state.drag.mode'),'pan');assert.equal(drawerOpen(),false);
  pointer('pointercancel',60);key('keyup',{code:'Space'});
  evaluate('busy(true)');enter(launcher);assert.equal(drawerOpen(),false);evaluate('busy(false)');
  ids.get('confirm-dialog').showModal();enter(launcher);assert.equal(drawerOpen(),false);ids.get('confirm-dialog').close();
  enter(launcher);leave(launcher);evaluate('busy(true)');document.body.focus();flushTimers();
  assert.equal(drawerOpen(),true,'pending work protects panel from timer close');
  evaluate('busy(false)');flushTimers();assert.equal(drawerOpen(),false,'auto close is reconsidered after pending work finishes');
  hoverMode.matches=false;hoverMode.listeners.change();enter(launcher);assert.equal(drawerOpen(),false,'narrow/coarse mode has no hover opening');
  toggle.onclick({detail:1});leave(launcher);flushTimers();assert.equal(drawerOpen(),true,'touch click opening waits for explicit dismissal');
  outside();assert.equal(drawerOpen(),false);
  hoverMode.matches=true;hoverMode.listeners.change();enter(launcher,{pointerType:'touch'});assert.equal(drawerOpen(),false,'touch on hybrid desktop must not synthesize hover');
  document.listeners.pointerdown({target:toggle,pointerType:'touch'});toggle.onclick({detail:1});
  document.listeners.pointerdown({target:panel,pointerType:'touch'});leave(panel,{pointerType:'touch'});
  evaluate('busy(true); busy(false)');document.body.focus();panel.listeners.focusout();flushTimers();
  assert.equal(drawerOpen(),true,'touch scrolling on a hybrid device must not schedule automatic closing');
  assert.equal(ids.get('records-pin').hidden,true);outside();assert.equal(drawerOpen(),false);
  enter(launcher);ids.get('records-pin').onclick();hoverMode.matches=false;hoverMode.listeners.change();
  assert.equal(evaluate('recordsDrawer.pinned'),false,'changing to narrow/touch mode removes inaccessible pin state');
  outside();assert.equal(drawerOpen(),false);hoverMode.matches=true;hoverMode.listeners.change();
  // Switch records via the actual generated button handler, including canLeave.
  evaluate("record().annotations=[]; state.task.records.push({...record(),id:'second',filename:'另一条.csv',annotations:[]}); renderRecords()");
  assert.equal(ids.get('records-count').textContent,'2');
  enter(launcher);const canceledSwitch=ids.get('records').children[1].onclick();await tick();
  assert.equal(ids.get('confirm-dialog').open,true);
  ids.get('confirm-cancel').onclick();await canceledSwitch;
  assert.equal(evaluate('state.recordId'),rid);assert.equal(evaluate('JSON.stringify(draftSnapshot())'),drawerDraft);
  assert.equal(drawerOpen(),true,'cancel switch retains list and draft');
  const savedDraft=evaluate('JSON.stringify(draftSnapshot())');await ids.get('records').children[0].onclick();
  assert.equal(evaluate('JSON.stringify(draftSnapshot())'),savedDraft,'click active record preserves draft without confirmation');
  enter(launcher);const acceptedSwitch=ids.get('records').children[1].onclick();await tick();
  ids.get('confirm-ok').onclick();await acceptedSwitch;
  assert.equal(evaluate('state.recordId'),'second');assert.equal(drawerOpen(),false);
  assert.equal(ids.get('record-name').textContent,'另一条.csv');assert.equal(document.activeElement,ids.get('record-name'));
  enter(launcher);ids.get('records-pin').onclick();await ids.get('records').children[0].onclick();
  assert.equal(evaluate('state.recordId'),rid);assert.equal(drawerOpen(),true,'fixed drawer survives record list rebuild');
  assert.equal(document.activeElement,ids.get('records').children[0],'focus follows the rebuilt active record button');
  assert.equal(requests.filter(request=>request.options.method==='POST').length,postsBeforeDrawer,'drawer navigation never writes task data');
  ids.get('records-close').onclick();
  // Static layout contract only; actual viewport rendering is not simulated here.
  const css=fs.readFileSync(path.join(root,'annotator/web/style.css'),'utf8');
  assert.ok(css.includes('.layout{grid-template-columns:48px minmax(0,1fr)}'));
  assert.ok(css.includes('.records-panel{position:fixed;'));
  assert.ok(css.includes('@media(prefers-reduced-motion:reduce)'));
  console.log('Frontend runtime checks passed: 9-track selection and persistence regressions; drawer hover/grace/focus/pin/Escape/touch, drag protection, dirty-record switching, unchanged timeline and no task writes.');
})().catch(error=>{console.error(error);process.exitCode=1;});
