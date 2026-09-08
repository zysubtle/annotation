'use strict';
const $ = id => document.getElementById(id);
const state = {config:null,task:null,recordId:null,mode:'blind',plot:null,from:0,to:0,sequence:0,editing:null,dirty:false,busy:false,append:false,selectionActive:false,drag:null,cursorMs:null,spaceDown:false};
const recordsDrawer={open:false,pinned:false,mode:null,touchMode:false,overLauncher:false,overPanel:false,closeTimer:null};
const recordsHover=matchMedia('(min-width: 901px) and (hover: hover) and (pointer: fine)');
// UI grace period for crossing from the entry into the list, not a signal parameter.
const RECORDS_CLOSE_DELAY_MS=250;
const names = {EXERCISE:'运动',NON:'非运动',TRANSITION:'过渡',UNKNOWN:'不确定'};
const record = () => state.task?.records.find(item => item.id === state.recordId);
const el = (tag,text,cls) => {const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
const size = bytes => `${(bytes/1024/1024).toFixed(2)} MiB`;
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
function busy(value){
  if(value&&state.drag)cancelGesture();
  state.busy=value;
  document.querySelectorAll('button,input,select').forEach(control=>{
    if(control.closest('#confirm-dialog'))return;
    if(value){if(control.dataset.beforeBusy===undefined)control.dataset.beforeBusy=String(control.disabled);control.disabled=true;}
    else if(control.dataset.beforeBusy!==undefined){control.disabled=control.dataset.beforeBusy==='true';delete control.dataset.beforeBusy;}
  });
  if(!value){$('download').disabled=!state.task;for(const id of ['completed','algorithm-import'])$(id).disabled=!record()||record().status!=='ready'||!record().has_original;selectionInfo();scheduleRecordsClose();}
}
async function api(path,options={},retrySession=true){
  const headers={'X-Annotation-Token':state.config?.token,...options.headers};
  const {json,...request}=options;
  if(json!==undefined){headers['Content-Type']='application/json';request.body=JSON.stringify(json);}
  const response=await fetch(path,{...request,headers});
  const body=await response.json();
  if(!response.ok){
    // This 403 is returned before any write. Renew only the expired local session once.
    if(response.status===403&&retrySession&&String(body.error).startsWith('会话已失效')){
      const config=await fetch('/api/config');if(config.ok){state.config=await config.json();return api(path,options,false);}
    }
    throw new Error(body.error||`请求失败 ${response.status}`);
  }
  return body;
}
const base = () => `/api/tasks/${state.task.id}`;
const recordBase = () => `${base()}/records/${state.recordId}`;
async function run(action){if(state.busy)return;busy(true);try{await action();}catch(error){message(error.message,true);$('save-status').textContent='操作未确认成功';}finally{busy(false);}}
function confirmAction(title,text,taskName=null){return new Promise(resolve=>{const dialog=$('confirm-dialog');$('confirm-title').textContent=title;$('confirm-text').textContent=text;$('confirm-label').hidden=taskName===null;$('confirm-input').value='';dialog.showModal();const finish=value=>{dialog.close();resolve(value);};$('confirm-cancel').onclick=()=>finish(null);$('confirm-ok').onclick=()=>{if(taskName!==null&&$('confirm-input').value!==taskName){$('confirm-input').setCustomValidity('请准确输入任务名称');$('confirm-input').reportValidity();return;}$('confirm-input').setCustomValidity('');finish(taskName===null?true:$('confirm-input').value);};dialog.oncancel=()=>resolve(null);$('confirm-input').oninput=()=>$('confirm-input').setCustomValidity('');});}
async function canLeave(){return !state.dirty||await confirmAction('放弃尚未确认的区间？','已保存的标注不会受影响，当前输入尚未添加到标注列表。');}
function clock(ms){const r=record();if(!r?.t0)return `${ms} ms`;const [date,time]=r.t0.split(' ');const [h,m,s,part]=time.split(/[:_]/).map(Number);const total=Math.round(h*3600000+m*60000+s*1000+part+ms);const day=Math.floor(total/86400000);return `${day?`+${day}天 `:''}${[Math.floor(total/3600000)%24,Math.floor(total/60000)%60,Math.floor(total/1000)%60].map(v=>String(v).padStart(2,'0')).join(':')}.${String(total%1000).padStart(3,'0')}`;}
function resetDraft(){
  if(state.drag)cancelGesture();
  state.editing=null;state.dirty=false;state.selectionActive=false;state.cursorMs=null;
  $('label-note').value='';$('label-start').value='';$('label-end').value='';selectionInfo();
}
function selectedInterval(){
  if(!state.selectionActive||$('label-start').value===''||$('label-end').value==='')return null;
  const start=Number($('label-start').value),end=Number($('label-end').value);
  return Number.isInteger(start)&&Number.isInteger(end)&&start<end?{start,end}:null;
}
function selectionIssues(){
  const selection=selectedInterval(),r=record();
  if(!selection)return {error:state.selectionActive?'请输入整数毫秒，且开始必须小于结束。':'',warning:''};
  if(!r||selection.start<r.min_ms||selection.end>r.annotation_end_ms)return {error:'选区必须位于本记录的时间范围内。',warning:''};
  // Match the server's half-open intervals: adjacent endpoints are allowed.
  const overlap=r.annotations.some(label=>label.id!==state.editing&&selection.start<label.end_ms&&selection.end>label.start_ms);
  if(overlap)return {error:'与已保存的人工区间重叠，请调整边界，或先取消选区再编辑原标签。',warning:''};
  const gaps=(state.plot?.gaps||[]).filter(gap=>selection.start<gap.end_ms&&selection.end>gap.start_ms);
  return {error:'',warning:gaps.length?`选区覆盖 ${gaps.length} 处 ≥1 秒的记录时间间隔。间隔内缺少观测，请核实后再保存；这不等于已确认丢包。`:''};
}
function setSelection(start,end,dirty=true){
  state.selectionActive=true;$('label-start').value=start;$('label-end').value=end;
  state.dirty=dirty;state.cursorMs=null;selectionInfo();
}
function selectionInfo(){
  const selection=selectedInterval(),issues=selectionIssues();
  $('edit-title').textContent=state.editing?'修改已保存区间':'添加区间';
  $('save-label').textContent=state.editing?'确认修改并保存':'确认区间并保存';
  $('selection-info').textContent=selection?`${clock(selection.start)}–${clock(selection.end)} · ${(selection.end-selection.start)/1000} 秒${state.dirty?' · 尚未确认保存':state.editing?' · 已载入待编辑':''}${selection.start<state.from||selection.end>state.to?' · 部分或全部在视窗外':''}`:state.selectionActive?'请补全有效的起止时间。':`${state.cursorMs!==null?`光标 ${clock(state.cursorMs)}。`:''}在任一波形上按住左键拖选区间。`;
  $('selection-warning').textContent=issues.error||issues.warning;
  $('selection-warning').hidden=!(issues.error||issues.warning);
  $('selection-warning').classList.toggle('error',Boolean(issues.error));
  const ready=record()?.status==='ready'&&record()?.has_original;
  $('save-label').disabled=state.busy||!ready||!selection||Boolean(issues.error);
  $('zoom-selection').disabled=state.busy||!selection||!ready||selection.start<record().min_ms||selection.end>record().annotation_end_ms;
  scheduleRedraw();
}
async function editSavedLabel(label,scroll=true){
  if(!await canLeave())return;
  state.editing=label.id;$('label-type').value=label.label;$('label-note').value=label.note||'';
  setSelection(label.start_ms,label.end_ms,false);
  if(scroll)$('annotation-dock').scrollIntoView({block:'nearest',behavior:'smooth'});
}
function taskHeader(){if(!state.task)return;$('task-name').textContent=state.task.name;const exported=state.task.last_export_revision;$('task-status').textContent=`${state.task.records.length} 个文件 · 版本 ${state.task.revision} · ${exported===null?'尚未导出':exported<state.task.revision?'有尚未导出的修改':`已生成版本 ${exported} 的下载包（请确认自行保存）`}`;}
function renderRecords(){
  const list=$('records');list.replaceChildren();
  for(const r of state.task.records){
    const button=el('button',r.filename,'record-button');button.dataset.recordId=r.id;
    button.setAttribute('aria-pressed',String(r.id===state.recordId));
    button.append(el('small',`${r.status==='invalid'?'检查异常':!r.has_original?'待补传原始数据':r.completed?'已完成':r.annotations.length?'标注中':'待标注'} · ${r.annotations.length} 个区间`));
    button.onclick=()=>run(async()=>{
      // Reopening the active row must not discard its draft or reset the viewport.
      if(r.id!==state.recordId){
        if(!await canLeave()){$('records-panel').focus({preventScroll:true});return;}
        await selectRecord(r.id);
      }
      if(!recordsDrawer.pinned)closeRecordsDrawer($('record-name'));
      else [...$('records').children].find(item=>item.dataset.recordId===state.recordId)?.focus({preventScroll:true});
    });list.append(button);
  }
  renderRecordsDrawer();
}
function renderRecordsDrawer(){
  const drawer=recordsDrawer,panel=$('records-panel'),count=state.task?.records.length||0;
  panel.inert=!drawer.open;panel.setAttribute('aria-hidden',String(!drawer.open));panel.classList.toggle('is-open',drawer.open);
  $('records-toggle').setAttribute('aria-expanded',String(drawer.open));
  $('records-toggle').setAttribute('aria-label',`${drawer.open&&drawer.mode==='click'?'收起':'打开'}本任务记录，共 ${count} 个文件`);
  $('records-count').textContent=String(count);
  $('records-pin').setAttribute('aria-pressed',String(drawer.pinned));$('records-pin').textContent=drawer.pinned?'取消固定':'固定展开';
  $('records-pin').hidden=!recordsHover.matches||drawer.touchMode;
  $('records-help').textContent=drawer.pinned?'已固定，切换记录后保持展开。':recordsHover.matches&&!drawer.touchMode?'移出后自动收起，也可固定展开。':'点击外部或“收起”关闭列表。';
}
function clearRecordsClose(){clearTimeout(recordsDrawer.closeTimer);recordsDrawer.closeTimer=null;}
function openRecordsDrawer(mode='click'){
  if(state.busy||state.drag||!state.task||$('workspace').hidden||document.querySelector('dialog[open]'))return false;
  clearRecordsClose();recordsDrawer.open=true;
  if(mode==='click'||!recordsDrawer.mode)recordsDrawer.mode=mode;
  renderRecordsDrawer();return true;
}
function closeRecordsDrawer(focusTarget=null){
  clearRecordsClose();
  // Move focus out before hiding the panel from keyboard and assistive navigation.
  if(focusTarget||$('records-panel').contains(document.activeElement))(focusTarget||$('records-toggle')).focus({preventScroll:true});
  recordsDrawer.open=false;recordsDrawer.pinned=false;recordsDrawer.mode=null;
  recordsDrawer.overLauncher=false;recordsDrawer.overPanel=false;renderRecordsDrawer();
}
function scheduleRecordsClose(){
  clearRecordsClose();
  if(!recordsDrawer.open||recordsDrawer.pinned||!recordsHover.matches||recordsDrawer.touchMode)return;
  recordsDrawer.closeTimer=setTimeout(()=>{
    recordsDrawer.closeTimer=null;
    if(recordsDrawer.overLauncher||recordsDrawer.overPanel||$('records-panel').contains(document.activeElement)||state.busy||document.querySelector('dialog[open]'))return;
    closeRecordsDrawer();
  },RECORDS_CLOSE_DELAY_MS);
}
function setupRecordsDrawer(){
  for(const[id,flag]of [['records-launcher','overLauncher'],['records-panel','overPanel']]){
    $(id).addEventListener('pointerenter',event=>{
      if(!recordsHover.matches||event.pointerType!=='mouse'||event.buttons||state.drag||state.busy)return;
      recordsDrawer.touchMode=false;
      recordsDrawer[flag]=true;clearRecordsClose();
      if(id==='records-launcher')openRecordsDrawer('hover');
      else renderRecordsDrawer();
    });
    $(id).addEventListener('pointerleave',event=>{if(event.pointerType!=='mouse')return;recordsDrawer[flag]=false;scheduleRecordsClose();});
  }
  $('records-panel').addEventListener('focusin',clearRecordsClose);
  $('records-panel').addEventListener('focusout',scheduleRecordsClose);
  $('records-toggle').onclick=event=>{
    if(state.busy||state.drag)return;
    if(recordsDrawer.open&&(recordsDrawer.mode==='click'||recordsDrawer.pinned))closeRecordsDrawer();
    else if(openRecordsDrawer('click')&&event?.detail===0)$('records-panel').focus({preventScroll:true});
  };
  $('records-toggle').addEventListener('keydown',event=>{
    if(['ArrowRight','ArrowDown'].includes(event.key)&&openRecordsDrawer('click')){event.preventDefault();$('records-panel').focus({preventScroll:true});}
  });
  $('records-pin').onclick=()=>{
    if(state.busy||!recordsDrawer.open||!recordsHover.matches||recordsDrawer.touchMode)return;
    recordsDrawer.pinned=!recordsDrawer.pinned;clearRecordsClose();renderRecordsDrawer();
    if(!recordsDrawer.pinned){$('records-toggle').focus({preventScroll:true});scheduleRecordsClose();}
  };
  $('records-close').onclick=()=>{if(!state.busy)closeRecordsDrawer($('records-toggle'));};
  document.addEventListener('pointerdown',event=>{
    const inside=$('records-panel').contains(event.target)||$('records-launcher').contains(event.target);
    if(inside&&event.pointerType==='touch'){
      // Hybrid devices can report hover support while the user scrolls by touch.
      recordsDrawer.touchMode=true;recordsDrawer.pinned=false;clearRecordsClose();renderRecordsDrawer();
    }
    if(!recordsDrawer.open||recordsDrawer.pinned||state.busy||document.querySelector('dialog[open]'))return;
    if(!inside)closeRecordsDrawer();
  },true);
  recordsHover.addEventListener('change',()=>{
    clearRecordsClose();recordsDrawer.overLauncher=false;recordsDrawer.overPanel=false;
    // A device without hover must always offer the explicit-click dismissal path.
    if(!recordsHover.matches){recordsDrawer.pinned=false;if(recordsDrawer.open)recordsDrawer.mode='click';}
    renderRecordsDrawer();scheduleRecordsClose();
  });
  renderRecordsDrawer();
}
async function openTask(id){state.sequence++;state.task=await api(`/api/tasks/${id}`);$('empty').hidden=true;$('workspace').hidden=false;taskHeader();if(state.task.records.length)await selectRecord(state.task.records[0].id);else{$('record-name').textContent='请追加数据';$('editor').hidden=true;state.recordId=null;renderRecords();}}
async function selectRecord(id){state.recordId=id;state.dirty=false;state.editing=null;state.plot=null;$('signals').replaceChildren();$('ppg-signals').replaceChildren();const r=record();state.from=r.min_ms||0;state.to=Math.min(r.annotation_end_ms||1,state.from+30000);renderRecord();resetDraft();if(r.has_original&&r.min_ms!==undefined)await loadPlot();}
function renderRecord(){const r=record();if(!r)return;taskHeader();renderRecords();$('record-name').textContent=r.filename;$('save-status').textContent='已保存到本机';$('record-info').textContent=`${size(r.bytes)} · ${r.counts?.hw903??0} 条 HW903 · ${r.counts?.rr??0} 条独立 RR（未作为参考真值）${r.t0?` · 起点 ${r.t0}（时区未确认）`:''}`;$('missing-original').hidden=r.has_original;$('editor').hidden=!r.has_original||r.min_ms===undefined;$('completed').checked=r.completed;$('completed').disabled=r.status!=='ready';$('checks-title').textContent=`数据检查：${r.status==='invalid'?'存在阻止标注的问题':!r.has_original?'缺少原始数据':`${r.issues.length} 条提示`}`;const checks=$('check-content');checks.replaceChildren();checks.append(el('p',`内容指纹 SHA-256：${r.sha256}`));if(r.sample_rate_note)checks.append(el('p',r.sample_rate_note));if(r.end_policy)checks.append(el('p',r.end_policy));checks.append(el('p','ACC 已从 µg 除以 1000 转为 mg。HR/累计步数保留原值；零值不自动判为有效或缺失。RR 保留在原文件，不按到包时间当作心搏时间。'));for(const issue of r.issues)checks.append(el('p',`${issue.line?`源行 ${issue.line} · `:''}${issue.severity==='error'?'错误':'提示'}：${issue.message}`));$('checks').open=r.status==='invalid';$('view-start').value=state.from/1000;$('view-end').value=state.to/1000;renderLabels();renderComparison();}
function renderLabels(){
  const r=record(),list=$('labels');list.replaceChildren();
  if(!r.annotations.length){list.append(el('p','还没有人工标注。','muted'));return;}
  for(const label of r.annotations){
    const row=el('div',undefined,'label-row'),info=el('div');
    info.append(el('strong',`${names[label.label]} · ${clock(label.start_ms)}–${clock(label.end_ms)}`));
    info.append(el('p',`${label.start_ms}–${label.end_ms} ms${label.note?' · '+label.note:''}`));
    const actions=el('div',undefined,'label-actions'),edit=el('button','编辑');
    edit.onclick=()=>run(()=>editSavedLabel(label));
    const remove=el('button','删除');remove.onclick=()=>run(async()=>{
      if(!await canLeave())return;
      if(await confirmAction('删除这个标签区间？',`${names[label.label]}，${clock(label.start_ms)}–${clock(label.end_ms)}。原始数据不变，旧标注版本保留在任务目录。`))await saveAnnotations(r.annotations.filter(item=>item.id!==label.id),false);
    });
    actions.append(edit,remove);row.append(info,actions);list.append(row);
  }
}
async function saveAnnotations(annotations,completed){$('save-status').textContent='保存中…';state.task=await api(`${recordBase()}/annotations`,{method:'POST',json:{revision:state.task.revision,annotations,completed}});state.dirty=false;renderRecord();resetDraft();message('已保存到本机。关闭网页后仍可继续；下载可带走当前版本。');}
async function loadPlot(){const r=record();if(!r||!r.has_original||r.min_ms===undefined)return;const sequence=++state.sequence;const slot=$('ppg-slot').value;const fields=['acc-x','acc-y','acc-z','hr','total_step',...[0,1,2,3].map(adc=>`slot${slot}-adc${adc}`)];const data=await api(`${recordBase()}/plot?start=${state.from}&end=${state.to}&fields=${fields.join(',')}`);if(sequence!==state.sequence)return;state.plot=data;viewInfo();makeSignals();selectionInfo();}
function viewInfo(){$('view-start').value=state.from/1000;$('view-end').value=state.to/1000;$('time-info').textContent=`当前视窗 ${clock(state.from)}–${clock(state.to)}；横轴是原始 time，不按行号重建。`;}
function makeSignals(){
  for(const id of ['signals','ppg-signals'])$(id).replaceChildren();
  state.plot.series.forEach(series=>{
    const row=el('div',undefined,'signal-row'),title=el('div',undefined,'signal-title');
    title.append(el('span',series.field));
    const summary=!series.present?'本视窗记录未提供此列，未补零':series.min===null?'此视窗无数值观测':`${series.unit} · ${series.min===0&&series.max===0?'数值观测均为零':`范围 ${series.min.toFixed(2)}–${series.max.toFixed(2)}`}`;
    title.append(el('small',`${summary}${series.empty_count?` · ${series.empty_count} 个空单元格`:''}${series.column_absent_count?` · ${series.column_absent_count} 条记录缺列`:''}`));
    const canvas=el('canvas');canvas.height=116;canvas.setAttribute('tabindex','-1');canvas.setAttribute('aria-label',`${series.field} 原始时间曲线，${series.unit||'该列缺失'}`);canvas.series=series;
    row.append(title,canvas);$(series.field.startsWith('slot')?'ppg-signals':'signals').append(row);attachSelection(canvas);
  });redraw();
}
function resolvedColor(name){const probe=document.createElement('span');probe.style.color=`var(${name})`;document.body.append(probe);const value=getComputedStyle(probe).color;probe.remove();return value;}
function context(canvas,height){const width=canvas.clientWidth;if(!width)return null;const ratio=window.devicePixelRatio||1;canvas.width=width*ratio;canvas.height=height*ratio;canvas.style.height=`${height}px`;const ctx=canvas.getContext('2d');ctx.scale(ratio,ratio);ctx.font='12px -apple-system, sans-serif';return{ctx,width,height,left:72,right:width-16};}
function drawSignal(canvas){
  const chart=context(canvas,116);if(!chart)return;
  const{ctx,width,left,right}=chart,s=canvas.series;
  const x=t=>left+(t-state.from)/Math.max(1,state.to-state.from)*(right-left);
  const span=s.min===null?1:s.max-s.min,padding=span?span*.1:Math.max(1,Math.abs(s.min||0)*.02);
  const lo=(s.min||0)-padding,hi=(s.max||0)+padding,y=v=>82-(v-lo)/(hi-lo)*65;
  const axisNumber=v=>Math.abs(v)>=1e6?v.toExponential(1):v.toFixed(Math.abs(v)<10?2:0);
  ctx.strokeStyle=resolvedColor('--line');ctx.lineWidth=1;ctx.strokeRect(left,12,right-left,74);
  ctx.fillStyle=resolvedColor('--muted');
  if(s.min!==null&&s.present){ctx.fillText(axisNumber(hi),6,20);ctx.fillText(axisNumber(lo),6,82);}
  const ticks=width<480?2:3;
  for(let i=0;i<=ticks;i++){const t=state.from+(state.to-state.from)*i/ticks;ctx.textAlign=i===0?'left':i===ticks?'right':'center';ctx.fillText((t/1000).toFixed(state.to-state.from<1000?3:2)+'s',x(t),106);}
  ctx.textAlign='left';
  drawSelection(ctx,x,left,right);
  for(const label of record()?.annotations||[]){const a=Math.max(label.start_ms,state.from),b=Math.min(label.end_ms,state.to);if(a<b){ctx.fillStyle=resolvedColor(label.label==='EXERCISE'?'--exercise':'--non');ctx.fillRect(x(a),5,x(b)-x(a),5);}}
  if(!s.present||s.min===null){ctx.fillStyle=resolvedColor('--muted');ctx.fillText(!s.present?'未提供该通道':'此视窗无数值观测',left+12,50);return;}
  ctx.save();ctx.beginPath();ctx.rect(left,12,right-left,74);ctx.clip();ctx.beginPath();
  let down=false,segmentLength=0,last=null;const isolated=[];
  for(const[t,v]of s.points){
    if(v===null){if(segmentLength===1)isolated.push(last);down=false;segmentLength=0;continue;}
    if(down)ctx.lineTo(x(t),y(v));else ctx.moveTo(x(t),y(v));
    down=true;segmentLength++;last=[t,v];
  }
  if(segmentLength===1)isolated.push(last);
  ctx.strokeStyle=resolvedColor(s.field==='acc-y'?'--orange':s.field==='acc-z'?'--purple':s.field==='hr'?'--danger':'--blue');ctx.lineWidth=1.25;ctx.stroke();
  ctx.fillStyle=ctx.strokeStyle;
  for(const[t,v]of isolated){ctx.beginPath();ctx.arc(x(t),y(v),2.5,0,Math.PI*2);ctx.fill();}
  ctx.restore();
}
function drawSelection(ctx,x,left,right){
  const selection=selectedInterval();
  if(selection){
    const a=Math.max(state.from,selection.start),b=Math.min(state.to,selection.end);
    ctx.fillStyle=resolvedColor('--blue');ctx.strokeStyle=ctx.fillStyle;
    if(a<b){ctx.globalAlpha=.16;ctx.fillRect(x(a),12,x(b)-x(a),74);ctx.globalAlpha=1;}
    for(const edge of [selection.start,selection.end]){
      if(edge<state.from||edge>state.to)continue;
      ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x(edge),12);ctx.lineTo(x(edge),86);ctx.stroke();
      ctx.fillRect(Math.max(left-4,Math.min(right-4,x(edge)-4)),35,8,28);
    }
  }
  if(state.cursorMs!==null&&state.cursorMs>=state.from&&state.cursorMs<=state.to){
    ctx.strokeStyle=resolvedColor('--muted');ctx.lineWidth=1;ctx.setLineDash([3,3]);
    ctx.beginPath();ctx.moveTo(x(state.cursorMs),12);ctx.lineTo(x(state.cursorMs),86);ctx.stroke();ctx.setLineDash([]);
  }
}
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
// CSS-pixel tolerances are UI defaults, not timing precision or signal thresholds.
const HANDLE_HIT_PX=8,DRAG_START_PX=3;
function selectionHit(t,width){
  const selection=selectedInterval();if(!selection)return 'create';
  const scale=Math.max(1,width-88)/(state.to-state.from);
  const edges=[['left',selection.start],['right',selection.end]]
    .filter(([,edge])=>edge>=state.from&&edge<=state.to)
    .map(([mode,edge])=>({mode,distance:Math.abs(edge-t)*scale})).sort((a,b)=>a.distance-b.distance);
  if(edges[0]?.distance<=HANDLE_HIT_PX)return edges[0].mode;
  return t>selection.start&&t<selection.end?'move':'create';
}
function draftSnapshot(){return {editing:state.editing,dirty:state.dirty,active:state.selectionActive,cursor:state.cursorMs,values:['label-start','label-end','label-type','label-note'].map(id=>$(id).value)};}
function restoreDraft(snapshot){
  state.editing=snapshot.editing;state.dirty=snapshot.dirty;state.selectionActive=snapshot.active;state.cursorMs=snapshot.cursor;
  ['label-start','label-end','label-type','label-note'].forEach((id,i)=>$(id).value=snapshot.values[i]);
}
function finishGesture(){
  const drag=state.drag;state.drag=null;
  document.body.classList.toggle('gesture-active',false);
  if(drag?.canvas.hasPointerCapture(drag.pointerId))drag.canvas.releasePointerCapture(drag.pointerId);
  if(drag)drag.canvas.style.cursor='';
  return drag;
}
function cancelGesture(){
  const drag=finishGesture();if(!drag)return;
  restoreDraft(drag.snapshot);state.from=drag.from;state.to=drag.to;viewInfo();selectionInfo();
}
function updateGesture(event){
  const drag=state.drag;if(!drag||event.pointerId!==drag.pointerId)return;
  if(Math.abs(event.clientX-drag.clientX)>=DRAG_START_PX)drag.moved=true;
  if(!drag.moved)return;
  const r=record(),delta=Math.round((event.clientX-drag.clientX)/drag.pixels*(drag.to-drag.from));
  if(drag.mode==='pan'){
    state.from=clamp(drag.from-delta,r.min_ms,r.annotation_end_ms-(drag.to-drag.from));
    state.to=state.from+drag.to-drag.from;viewInfo();selectionInfo();return;
  }
  const selection=drag.selection;
  if(drag.mode==='create'){
    const end=clamp(drag.anchor+delta,drag.from,drag.to);
    if(end===drag.anchor){restoreDraft(drag.snapshot);selectionInfo();return;}
    setSelection(Math.min(drag.anchor,end),Math.max(drag.anchor,end));
  }else if(drag.mode==='left')setSelection(clamp(selection.start+delta,r.min_ms,selection.end-1),selection.end);
  else if(drag.mode==='right')setSelection(selection.start,clamp(selection.end+delta,selection.start+1,r.annotation_end_ms));
  else if(drag.mode==='move'){
    // Clamp the shared displacement, not each endpoint, so duration is unchanged.
    const shift=clamp(delta,r.min_ms-selection.start,r.annotation_end_ms-selection.end);
    setSelection(selection.start+shift,selection.end+shift);
  }
}
function attachSelection(canvas){
  const at=event=>{
    const bounds=canvas.getBoundingClientRect(),x=event.clientX-bounds.left,y=event.clientY-bounds.top;
    const t=state.from+(x-72)/Math.max(1,bounds.width-88)*(state.to-state.from);
    return {bounds,x,y,t,inside:x>=72&&x<=bounds.width-16&&y>=12&&y<=86};
  };
  canvas.addEventListener('pointerdown',event=>{
    if(event.button!==0||event.isPrimary===false||state.busy||state.drag||record()?.status!=='ready')return;
    const point=at(event);
    if(!state.spaceDown&&point.y>=0&&point.y<12&&point.x>=72&&point.x<=point.bounds.width-16){
      const label=record().annotations.find(item=>item.start_ms<=point.t&&point.t<item.end_ms);
      if(label){event.preventDefault();canvas.focus({preventScroll:true});run(()=>editSavedLabel(label,false));}return;
    }
    if(!point.inside)return;
    const mode=state.spaceDown?'pan':selectionHit(point.t,point.bounds.width);
    // Creating elsewhere must never silently turn an edit into an overwrite.
    if(mode==='create'&&state.editing){message('正在修改已保存区间：请拖动把手或选区内部；如需新建，请先取消编辑。');return;}
    // A previous form field may still own focus; subsequent Space must act on this plot.
    event.preventDefault();canvas.focus({preventScroll:true});
    state.drag={canvas,pointerId:event.pointerId,mode,moved:false,clientX:event.clientX,pixels:Math.max(1,point.bounds.width-88),anchor:clamp(Math.round(point.t),state.from,state.to),from:state.from,to:state.to,selection:selectedInterval(),snapshot:draftSnapshot()};
    canvas.setPointerCapture(event.pointerId);canvas.style.cursor=mode==='pan'?'grabbing':mode==='move'?'move':mode==='create'?'crosshair':'ew-resize';
    document.body.classList.toggle('gesture-active',true);
  });
  canvas.addEventListener('pointermove',event=>{
    if(state.drag){if(state.drag.canvas===canvas)updateGesture(event);return;}
    const point=at(event),mode=selectionHit(point.t,point.bounds.width);
    canvas.style.cursor=state.spaceDown?'grab':!point.inside?'default':mode==='move'?'move':['left','right'].includes(mode)?'ew-resize':'crosshair';
  });
  canvas.addEventListener('pointerup',event=>{
    if(state.drag?.canvas!==canvas||event.pointerId!==state.drag.pointerId)return;
    updateGesture(event);const drag=finishGesture();
    if(!drag.moved){state.cursorMs=drag.anchor;selectionInfo();}
    if(drag.mode==='pan'&&drag.moved)run(loadPlot);
  });
  for(const type of ['pointercancel','lostpointercapture'])canvas.addEventListener(type,event=>{
    if(state.drag?.canvas===canvas&&state.drag.pointerId===event.pointerId)cancelGesture();
  });
}
function textControl(target){return Boolean(target?.isContentEditable||['INPUT','TEXTAREA','SELECT','BUTTON','SUMMARY'].includes(target?.tagName));}
function setSpacePan(value){state.spaceDown=value;document.body.classList.toggle('space-pan',value);document.querySelectorAll('.signals canvas').forEach(canvas=>{canvas.style.cursor=value?'grab':'';});}
window.addEventListener('keydown',event=>{
  if(document.querySelector('dialog[open]'))return;
  if(event.key==='Escape'&&state.drag&&!state.busy){event.preventDefault();cancelGesture();setSpacePan(false);return;}
  // Closing navigation takes priority; the same Escape must never erase a draft.
  if(event.key==='Escape'&&recordsDrawer.open&&!state.busy){event.preventDefault();closeRecordsDrawer($('records-toggle'));setSpacePan(false);return;}
  if(event.key==='Escape'&&!state.busy){event.preventDefault();if(state.drag)cancelGesture();else resetDraft();setSpacePan(false);}
  if(event.code==='Space'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!textControl(event.target)&&!$('editor').hidden&&!state.busy){event.preventDefault();setSpacePan(true);}
});
window.addEventListener('keyup',event=>{if(event.code==='Space')setSpacePan(false);});
window.addEventListener('blur',()=>{cancelGesture();setSpacePan(false);});
function differences(r){const human=r.annotations.filter(x=>['EXERCISE','NON'].includes(x.label)),algo=(r.algorithm?.intervals||[]).filter(x=>['EXERCISE','NON'].includes(x.label));const result=[];let i=0,j=0;while(i<human.length&&j<algo.length){const a=human[i],b=algo[j];const start=Math.max(a.start_ms,b.start_ms),end=Math.min(a.end_ms,b.end_ms);if(start<end&&a.label!==b.label){const last=result[result.length-1];if(last&&last.end_ms===start&&last.human===a.label)last.end_ms=end;else result.push({start_ms:start,end_ms:end,human:a.label,algorithm:b.label});}if(a.end_ms<=b.end_ms)i++;else j++;}return result;}
function renderComparison(){const r=record();$('comparison').hidden=state.mode!=='compare';$('blind-mode').setAttribute('aria-pressed',String(state.mode==='blind'));$('compare-mode').setAttribute('aria-pressed',String(state.mode==='compare'));$('algorithm-info').textContent=r.algorithm?`已导入：${r.algorithm.version} · 留白表示未标注/无输出，不参与差异计算。算法输出不会覆盖人工标签。`:'尚未导入算法结果。可先下载本记录模板，填写版本和区间后导入。';const container=$('differences');container.replaceChildren();if(r.algorithm){const diffs=differences(r);container.append(el('p',`${diffs.length} 处已标注二分类差异，共 ${(diffs.reduce((sum,d)=>sum+d.end_ms-d.start_ms,0)/1000).toFixed(3)} 秒。仅比较双方都有明确标签的交集。`,'muted'));for(const diff of diffs){const button=el('button',`${diff.human==='EXERCISE'?'漏报':'误报'} · ${clock(diff.start_ms)}–${clock(diff.end_ms)}`,'diff-button');button.onclick=()=>run(async()=>{if(!await canLeave())return;state.from=Math.max(r.min_ms,diff.start_ms-30000);state.to=Math.min(r.annotation_end_ms,diff.end_ms+30000);resetDraft();setSelection(diff.start_ms,diff.end_ms);await loadPlot();});container.append(button);}}drawOverview();}
function drawOverview(){
  const r=record();if(!r||state.mode!=='compare')return;
  const chart=context($('overview'),150);if(!chart)return;
  const{ctx,width,left,right}=chart;
  const x=t=>left+(t-r.min_ms)/Math.max(1,r.annotation_end_ms-r.min_ms)*(right-left);
  ctx.fillStyle=resolvedColor('--muted');ctx.fillText('人工',10,36);ctx.fillText('算法',10,77);
  for(const[labels,y]of [[r.annotations,17],[r.algorithm?.intervals||[],58]]){
    ctx.strokeStyle=resolvedColor('--line');ctx.strokeRect(left,y,right-left,28);
    for(const item of labels){
      ctx.fillStyle=resolvedColor(item.label==='EXERCISE'?'--exercise':item.label==='NON'?'--non':'--warning');
      ctx.fillRect(x(item.start_ms),y,x(item.end_ms)-x(item.start_ms),28);
      if(x(item.end_ms)-x(item.start_ms)>48){ctx.fillStyle=resolvedColor('--text');ctx.fillText(names[item.label],x(item.start_ms)+5,y+19);}
    }
  }
  for(const item of differences(r)){ctx.fillStyle=resolvedColor(item.human==='EXERCISE'?'--miss':'--false');ctx.fillRect(x(item.start_ms),98,x(item.end_ms)-x(item.start_ms),8);}
  ctx.fillStyle=resolvedColor('--muted');ctx.fillText('差异',10,108);
  const ticks=width<480?2:3;
  for(let i=0;i<=ticks;i++){const t=r.min_ms+(r.annotation_end_ms-r.min_ms)*i/ticks;ctx.textAlign=i===0?'left':i===ticks?'right':'center';ctx.fillText((t/1000).toFixed(1)+'s',x(t),137);}
  ctx.textAlign='left';
}
function redraw(){document.querySelectorAll('.signals canvas').forEach(drawSignal);drawOverview();}
let redrawPending=false;
function scheduleRedraw(){if(redrawPending)return;redrawPending=true;window.requestAnimationFrame(()=>{redrawPending=false;redraw();});}
const observer=new ResizeObserver(redraw);observer.observe($('working-surface')||document.querySelector('.working-surface'));matchMedia('(prefers-color-scheme: dark)').addEventListener('change',redraw);
async function uploadFiles(files,append){if(!files.length)return;if(!await canLeave())return;const zip=files.filter(file=>/\.zip$/i.test(file.name));if(zip.length){if(files.length!==1)throw new Error('恢复任务包时请一次只选一个 ZIP，不要与 CSV 混选');message('正在上传并校验任务包…');const task=await api('/api/restore',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:files[0]});await openTask(task.id);message('已恢复为独立任务；原任务没有被覆盖。');return;}if(files.some(file=>!/\.csv$/i.test(file.name)))throw new Error('首版只接受 HW903 CSV 或本工具导出的 ZIP');if(!append||!state.task)state.task=await api('/api/tasks',{method:'POST',json:{name:`HW903 · ${new Date().toLocaleString('zh-CN',{hour12:false})}`}});let success=0,duplicates=0;const errors=[];for(let i=0;i<files.length;i++){const file=files[i];message(`正在上传和检查 ${i+1}/${files.length}：${file.name}`);try{if(file.size>state.config.max_file_bytes)throw new Error(`超过单文件 ${size(state.config.max_file_bytes)} 限制`);const response=await api(`${base()}/files?filename=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});state.task=response.task;if(response.duplicate)duplicates++;else success++;}catch(error){errors.push(`${file.name}：${error.message}`);}}await openTask(state.task.id);message(`接收 ${success} 个新文件，跳过 ${duplicates} 个重复内容。${errors.length?'上传问题：'+errors.join('；'):'请查看每个记录的检查状态。'}`,errors.length>0);}
async function showTasks(){const{tasks}=await api('/api/tasks');const list=$('tasks-list');list.replaceChildren();if(!tasks.length)list.append(el('p','还没有本地任务，请上传数据。'));for(const task of tasks){const row=el('div',undefined,'task-row');const info=el('div');info.append(el('strong',task.name),el('p',`${task.record_count} 个文件 · 占用 ${size(task.bytes)}`));const actions=el('div',undefined,'label-actions');const open=el('button','打开');open.disabled=task.error;open.onclick=()=>run(async()=>{if(await canLeave()){$('tasks-dialog').close();await openTask(task.id);}});const remove=el('button','清理','danger');remove.disabled=task.error;remove.onclick=()=>run(async()=>{const answer=await confirmAction('移入本地回收区？',`任务“${task.name}”将从任务列表移除。原始数据、标注和导出包移入本机回收区，不永久删除。请确认已下载需要的版本。`,task.name);if(answer){const response=await api(`/api/tasks/${task.id}/trash`,{method:'POST',json:{revision:task.revision,confirmation:answer}});message(`${response.message}。恢复位置：${response.recovery_path}`);if(state.task?.id===task.id){state.task=null;state.recordId=null;state.dirty=false;$('workspace').hidden=true;$('empty').hidden=false;}$('tasks-dialog').close();}});actions.append(open,remove);row.append(info,actions);list.append(row);}$('tasks-dialog').showModal();}
function downloadBlob(content,name,type){const link=el('a');link.href=URL.createObjectURL(new Blob([content],{type}));link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);}
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$(button.dataset.close).close());
$('upload').onclick=$('empty-upload').onclick=()=>{state.append=false;$('upload-input').click();};$('add-files').onclick=()=>{state.append=true;$('upload-input').click();};$('upload-input').onchange=event=>{const files=[...event.target.files];event.target.value='';run(()=>uploadFiles(files,state.append));};
$('tasks-button').onclick=()=>run(showTasks);
$('download').onclick=()=>{$('include-original').checked=false;$('download-dialog').showModal();};
$('confirm-download').onclick=()=>run(async()=>{if(state.dirty)throw new Error('当前区间输入尚未确认，请先添加/更新区间或取消编辑后下载');const result=await api(`${base()}/export`,{method:'POST',json:{revision:state.task.revision,include_original:$('include-original').checked}});state.task=result.task;taskHeader();const link=el('a');link.href=`${base()}/exports/${result.export_id}`;link.download=result.filename;document.body.append(link);link.click();link.remove();$('download-dialog').close();message(`已发起下载（版本 ${state.task.revision}）。请确认文件已保存；任务仍保留在本机。`);});
$('attach').onclick=()=>$('attach-input').click();$('attach-input').onchange=event=>{const file=event.target.files[0];event.target.value='';if(file)run(async()=>{state.task=await api(`${recordBase()}/attach?revision=${state.task.revision}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});await selectRecord(state.recordId);message('原始文件指纹检查通过，可以继续标注。');});};
$('annotation-form').onsubmit=event=>{event.preventDefault();run(async()=>{const issues=selectionIssues();if(!selectedInterval()||issues.error)throw new Error(issues.error||'请先在波形上拖选区间');const r=record();const label={start_ms:Number($('label-start').value),end_ms:Number($('label-end').value),label:$('label-type').value,note:$('label-note').value};if(state.editing)label.id=state.editing;await saveAnnotations([...r.annotations.filter(item=>item.id!==state.editing),label],false);});};
for(const id of ['label-start','label-end','label-type','label-note'])$(id).addEventListener('input',()=>{if(id==='label-start'||id==='label-end')state.selectionActive=true;state.dirty=true;selectionInfo();});$('cancel-edit').onclick=resetDraft;
$('completed').onchange=()=>run(async()=>{const value=$('completed').checked;try{if(state.dirty)throw new Error('请先确认或取消当前区间输入');await saveAnnotations(record().annotations,value);}catch(error){$('completed').checked=record().completed;throw error;}});
$('blind-mode').onclick=()=>{state.mode='blind';renderComparison();};$('compare-mode').onclick=()=>{state.mode='compare';renderComparison();};
$('apply-view').onclick=()=>run(async()=>{const r=record(),a=Math.round(Number($('view-start').value)*1000),b=Math.round(Number($('view-end').value)*1000);if(!Number.isFinite(a)||!Number.isFinite(b)||!(r.min_ms<=a&&a<b&&b<=r.annotation_end_ms))throw new Error('视窗起止需位于本记录范围，开始小于结束');state.from=a;state.to=b;await loadPlot();});
for(const[id,direction]of [['previous-window',-1],['next-window',1]])$(id).onclick=()=>run(async()=>{const r=record(),width=state.to-state.from;state.from=Math.max(r.min_ms,Math.min(r.annotation_end_ms-width,state.from+direction*width));state.to=Math.min(r.annotation_end_ms,state.from+width);await loadPlot();});$('full-view').onclick=()=>run(async()=>{state.from=record().min_ms;state.to=record().annotation_end_ms;await loadPlot();});$('ppg-slot').onchange=()=>run(loadPlot);
$('zoom-selection').onclick=()=>run(async()=>{const selection=selectedInterval(),r=record();if(!selection||selection.start<r.min_ms||selection.end>r.annotation_end_ms)throw new Error('请先选择有效区间');state.from=selection.start;state.to=selection.end;await loadPlot();});
$('algorithm-import').onclick=()=>$('algorithm-dialog').showModal();$('algorithm-template').onclick=()=>{const r=record();downloadBlob(JSON.stringify({sha256:r.sha256,t0:r.t0,version:'请填写算法版本',intervals:[],instructions:'intervals 填写 {start_ms: 整数毫秒, end_ms: 整数毫秒, label: EXERCISE或NON或TRANSITION或UNKNOWN, note: 可选备注}。相对本文件t0；含开始不含结束；不能重叠；未输出不等于NON。'},null,2),'algorithm-template.json','application/json');};$('choose-algorithm').onclick=()=>$('algorithm-input').click();$('algorithm-input').onchange=event=>{const file=event.target.files[0];event.target.value='';if(file)run(async()=>{if(file.size>4*1024*1024)throw new Error('算法结果 JSON 最多 4 MiB');if(record().algorithm&&!await confirmAction('替换算法对照结果？','只替换当前算法轨道，不改变人工标注。需要保留旧算法结果时请先下载任务包。'))return;const payload=JSON.parse(await file.text());if(payload.version==='请填写算法版本')throw new Error('请先填写实际算法版本/来源');state.task=await api(`${recordBase()}/algorithm`,{method:'POST',json:{...payload,revision:state.task.revision}});state.mode='compare';renderRecord();$('algorithm-dialog').close();message('算法结果已保存；当前展示的是真实导入内容，没有在标注器内运行算法。');});};
window.addEventListener('beforeunload',event=>{if(state.dirty||state.busy){event.preventDefault();event.returnValue='';}});
async function init(){busy(true);try{state.config=await api('/api/config');$('storage-path').textContent=`本地存储：${state.config.storage_path}`;const{tasks}=await api('/api/tasks');const latest=tasks.find(task=>!task.error);if(latest)await openTask(latest.id);else $('empty').hidden=false;message(`本机服务已连接。单个 CSV 最多 ${size(state.config.max_file_bytes)}；每任务原始总量最多 256 MiB。数据不会发送至云端。`);}catch(error){message('无法连接本机服务：'+error.message,true);}finally{busy(false);}}
function registerTools(){
  const context=document.modelContext;if(!context?.registerTool)return;
  const lifecycle=new AbortController();
  const register=tool=>{try{Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch(error){/* Experimental browser capability; normal UI is independent. */}};
  register({name:'list_annotation_tasks',title:'查看本地标注任务',description:'只读列出本机任务与版本，不上传或下载文件。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:async()=>{const result=await api('/api/tasks');return result.tasks;}});
  register({name:'open_annotation_record',title:'打开已有记录',description:'在界面打开已上传的任务记录；有未确认区间时拒绝切换。',inputSchema:{type:'object',properties:{task_id:{type:'string'},record_id:{type:'string'}},required:['task_id','record_id'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},execute:async input=>{
    if(state.busy||state.dirty)throw new Error('请先结束当前操作或保存/取消未确认区间');
    if(!input||!/^([0-9a-f]{32})$/.test(input.task_id)||!/^([0-9a-f]{32})$/.test(input.record_id))throw new Error('任务/记录标识无效');
    const task=await api(`/api/tasks/${input.task_id}`);if(!task.records.some(r=>r.id===input.record_id))throw new Error('记录不属于指定任务');
    busy(true);try{state.task=task;$('empty').hidden=true;$('workspace').hidden=false;await selectRecord(input.record_id);return{task_id:task.id,record_id:state.recordId,revision:task.revision};}finally{busy(false);}
  }});
  window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
setupRecordsDrawer();init().then(registerTools);
