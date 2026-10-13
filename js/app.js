// 家計ノート（独立版）— GitHub Pages ＋ Firebase
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot, setDoc, deleteDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { ocrReceipt } from "./ocr.js";

/* ===== 基本 ===== */
const $=(s,r=document)=>r.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const yen=n=>(n<0?"−":"")+"¥"+Math.round(Math.abs(n||0)).toLocaleString("ja-JP");
const pad=n=>String(n).padStart(2,"0");
const today=()=>{const d=new Date();return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`};
const ymOf=d=>String(d||"").slice(0,7);
const addMonth=(ym,k)=>{let[y,m]=ym.split("-").map(Number);m+=k;while(m<1){m+=12;y--}while(m>12){m-=12;y++}return `${y}-${pad(m)}`};
const daysIn=ym=>{const[y,m]=ym.split("-").map(Number);return new Date(y,m,0).getDate()};
const ymLabel=ym=>{const[y,m]=ym.split("-");return `${y}年${Number(m)}月`};
const newId=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,8);
const toNum=v=>{const n=Number(String(v??"").replace(/[,，¥円\s]/g,""));return Number.isFinite(n)?n:0};
function toast(msg){const t=$("#toast");t.textContent=msg;t.hidden=false;clearTimeout(toast._t);toast._t=setTimeout(()=>t.hidden=true,2600)}

const DEF_SETTINGS={
  categories:["食費","外食","日用品","交通","娯楽","衣服","医療","通信","その他"],
  fixed:[], savingsGoal:30000,
  payType:"hourly", hourly:1100, baseSalary:0, allowance:0, transportPerDay:0,
  nightRate:25, otRate:25, closingDay:0, deductRate:0
};

/* ===== 保存先：Firebase（全端末で同期）か、この端末のみ ===== */
const COLS=["receipts","prices","shifts","incomes"];
const S={tab:"home",ym:ymOf(today()),cols:{receipts:[],prices:[],shifts:[],incomes:[]},settings:{...DEF_SETTINGS},mode:"loading",user:null,fromCache:false};
const LKEY="kakei-note-v1";
const configured=firebaseConfig&&firebaseConfig.apiKey&&!/YOUR_/.test(firebaseConfig.apiKey);
let fb=null,unsubs=[];
if(configured){
  const app=initializeApp(firebaseConfig);
  let db;
  try{db=initializeFirestore(app,{localCache:persistentLocalCache({tabManager:persistentMultipleTabManager()})})}
  catch{db=initializeFirestore(app,{})}
  fb={auth:getAuth(app),db};
}
const ucol=c=>collection(fb.db,"users",S.user.uid,c);
const udoc=(c,id)=>doc(fb.db,"users",S.user.uid,c,id);

function lsLoad(){try{return JSON.parse(localStorage.getItem(LKEY)||"null")}catch{return null}}
function lsSave(){try{localStorage.setItem(LKEY,JSON.stringify({cols:S.cols,settings:S.settings}))}catch{toast("端末の保存容量がいっぱいです。古い記録を削除してください")}}

/* 写真（ローカル版）は IndexedDB に保存 */
const idb=(()=>{let p;const open=()=>p||(p=new Promise((res,rej)=>{const r=indexedDB.open("kakei-note-photos",1);r.onupgradeneeded=()=>r.result.createObjectStore("p");r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}));
  const tx=async(mode,fn)=>{const d=await open();return new Promise((res,rej)=>{const t=d.transaction("p",mode);const q=fn(t.objectStore("p"));t.oncomplete=()=>res(q?.result);t.onerror=()=>rej(t.error)})};
  return{get:k=>tx("readonly",s=>s.get(k)),set:(k,v)=>tx("readwrite",s=>s.put(v,k)),del:k=>tx("readwrite",s=>s.delete(k))}})();

function startCloud(user){
  stopCloud();S.user=user;S.mode="cloud";try{localStorage.removeItem(LKEY+"-localmode")}catch{}S.cols={receipts:[],prices:[],shifts:[],incomes:[]};
  for(const c of COLS){
    unsubs.push(onSnapshot(ucol(c),{includeMetadataChanges:true},snap=>{S.cols[c]=snap.docs.map(d=>({id:d.id,...d.data()}));S.fromCache=snap.metadata.fromCache;setSync();rerender()},err=>{console.warn(c,err);toast("データを読み込めませんでした。Firestoreのルールを確認してください")}));
  }
  unsubs.push(onSnapshot(udoc("meta","settings"),snap=>{S.settings={...DEF_SETTINGS,...(snap.exists()?snap.data():{})};rerender()},()=>{}));
  showApp();
}
function stopCloud(){unsubs.forEach(u=>u());unsubs=[]}
function startLocal(){
  stopCloud();S.mode="local";S.user=null;
  const d=lsLoad();if(d){S.cols={...S.cols,...d.cols};S.settings={...DEF_SETTINGS,...d.settings}}
  try{localStorage.setItem(LKEY+"-localmode","1")}catch{}
  showApp();
}
function setSync(){
  const off=!navigator.onLine;$("#offline").hidden=!(S.mode==="cloud"&&off);
  const cls="sync "+(S.mode==="cloud"?(off?"local":"on"):S.mode==="local"?"local":"");
  const txt=S.mode==="cloud"?(off?"オフライン（あとで同期）":"同期中（スマホ・PC共通）"):S.mode==="local"?"この端末のみに保存":"接続中…";
  for(const el of document.querySelectorAll(".sync")){el.className=cls;el.querySelector("span").textContent=txt}
}
addEventListener("online",setSync);addEventListener("offline",setSync);

async function put(col,obj){
  const id=obj.id||newId();const body=JSON.parse(JSON.stringify(obj));delete body.id;
  if(S.mode==="cloud"){
    // オフラインでも端末内にすぐ反映され、つながったときに送信される
    const p=setDoc(udoc(col,id),body);if(navigator.onLine){try{await p}catch(e){handleErr(e);throw e}}else p.catch(handleErr);
  }else{
    const arr=S.cols[col];const i=arr.findIndex(x=>x.id===id);
    if(i>=0)arr[i]={id,...body};else arr.push({id,...body});lsSave();rerender();
  }
  return id;
}
async function del(col,id){
  if(S.mode==="cloud"){const p=deleteDoc(udoc(col,id));if(navigator.onLine){try{await p}catch(e){handleErr(e);throw e}}else p.catch(handleErr)}
  else{S.cols[col]=S.cols[col].filter(x=>x.id!==id);lsSave();rerender()}
}
async function saveSettings(patch){
  S.settings={...S.settings,...patch};
  if(S.mode==="cloud"){const p=setDoc(udoc("meta","settings"),JSON.parse(JSON.stringify(S.settings)));if(navigator.onLine){try{await p}catch(e){handleErr(e)}}}
  else lsSave();
  rerender();
}
function handleErr(e){
  console.warn(e);
  toast(e?.code==="permission-denied"?"保存が拒否されました。Firestoreのルールを確認してください":e?.code==="resource-exhausted"?"無料枠の上限に達しました。時間をおいて試してください":"保存できませんでした。通信状態を確認してください");
}
/* 写真の保存・取得・削除 */
async function savePhoto(dataUrl){
  const id="p"+newId();
  if(S.mode==="cloud")await setDoc(udoc("photos",id),{data:dataUrl,createdAt:Date.now()});
  else await idb.set(id,dataUrl);
  return id;
}
async function loadPhoto(id){
  if(!id)return null;
  try{if(S.mode==="cloud"){const s=await getDoc(udoc("photos",id));return s.exists()?s.data().data:null}return await idb.get(id)}catch{return null}
}
async function delPhoto(id){if(!id)return;try{if(S.mode==="cloud")await deleteDoc(udoc("photos",id));else await idb.del(id)}catch{}}

/* ===== ログイン画面 ===== */
function showGate(msg=""){
  $("#app").hidden=true;$("#bnav").hidden=true;const g=$("#gate");g.hidden=false;
  g.innerHTML=`<div class="card">
    <div class="logo"><i></i>家計ノート</div>
    <p class="small muted" style="margin:0">ログインすると、スマホとPCで同じ記録をリアルタイムに使えます。</p>
    ${configured?`
    <button class="btn pri" id="gGoogle">Googleでログイン</button>
    <div class="or">またはメールアドレス</div>
    <form id="gForm" style="display:flex;flex-direction:column;gap:8px">
      <label class="f">メールアドレス<input id="gMail" type="email" autocomplete="email" required></label>
      <label class="f">パスワード（6文字以上）<input id="gPass" type="password" autocomplete="current-password" minlength="6" required></label>
      <div class="row"><button class="btn pri" type="submit" style="flex:1">ログイン</button><button class="btn" type="button" id="gSignup" style="flex:1">新規登録</button></div>
      <button class="btn sm" type="button" id="gReset" style="border:0">パスワードを忘れた</button>
    </form>`:`<div class="status warn">Firebaseがまだ設定されていません。README の手順で js/firebase-config.js を書き換えると同期が使えます。</div>`}
    <div class="or">または</div>
    <button class="btn" id="gLocal">ログインせずにこの端末だけで使う</button>
    <div class="err" id="gErr">${esc(msg)}</div>
  </div>`;
}
const authMsg=e=>({"auth/invalid-credential":"メールアドレスかパスワードが違います","auth/wrong-password":"パスワードが違います","auth/user-not-found":"このメールアドレスは登録されていません","auth/email-already-in-use":"このメールアドレスは登録済みです。ログインしてください","auth/weak-password":"パスワードは6文字以上にしてください","auth/invalid-email":"メールアドレスの形式が正しくありません","auth/popup-closed-by-user":"ログインが中断されました","auth/unauthorized-domain":"このURLがFirebaseの承認済みドメインに入っていません（README参照）","auth/network-request-failed":"通信できません。ネット接続を確認してください"}[e?.code]||"ログインできませんでした（"+(e?.code||e?.message)+"）");
document.addEventListener("click",async e=>{
  const t=e.target;
  if(t.closest("#gLocal")){startLocal();return}
  if(t.closest("#gGoogle")){
    const pr=new GoogleAuthProvider();
    try{await signInWithPopup(fb.auth,pr)}catch(err){
      if(/popup-blocked|operation-not-supported|cancelled-popup/.test(err?.code||""))await signInWithRedirect(fb.auth,pr);
      else $("#gErr").textContent=authMsg(err)}
  }
  if(t.closest("#gSignup")){const m=$("#gMail").value.trim(),p=$("#gPass").value;if(!m||p.length<6){$("#gErr").textContent="メールアドレスと6文字以上のパスワードを入れてください";return}
    try{await createUserWithEmailAndPassword(fb.auth,m,p)}catch(err){$("#gErr").textContent=authMsg(err)}}
  if(t.closest("#gReset")){const m=$("#gMail").value.trim();if(!m){$("#gErr").textContent="先にメールアドレスを入れてください";return}
    try{await sendPasswordResetEmail(fb.auth,m);$("#gErr").textContent="再設定メールを送りました"}catch(err){$("#gErr").textContent=authMsg(err)}}
});
document.addEventListener("submit",async e=>{if(e.target.id!=="gForm")return;e.preventDefault();
  try{await signInWithEmailAndPassword(fb.auth,$("#gMail").value.trim(),$("#gPass").value)}catch(err){$("#gErr").textContent=authMsg(err)}});

function showApp(){$("#gate").hidden=true;$("#app").hidden=false;$("#bnav").hidden=false;renderAll();setSync()}

/* ===== 計算 ===== */
const recTotal=r=>(r.items||[]).reduce((a,it)=>a+toNum(it.price),0);
const fixedTotal=()=>(S.settings.fixed||[]).reduce((a,f)=>a+toNum(f.amount),0);
function payPeriod(ym){
  const cd=Number(S.settings.closingDay)||0;
  if(!cd)return{from:`${ym}-01`,to:`${ym}-${pad(daysIn(ym))}`};
  const p=addMonth(ym,-1);const s=Math.min(cd+1,daysIn(p));
  const fromDay=cd+1>daysIn(p)?null:s;
  return{from:fromDay?`${p}-${pad(fromDay)}`:`${ym}-01`,to:`${ym}-${pad(Math.min(cd,daysIn(ym)))}`};
}
const tmin=x=>{const[h,m]=String(x||"0:0").split(":").map(Number);return(h||0)*60+(m||0)};
function calcShift(s){
  const st=S.settings;let a=tmin(s.start),b=tmin(s.end);if(b<=a)b+=1440;
  const work=Math.max(0,b-a-toNum(s.breakMin));
  const ov=(x1,x2)=>Math.max(0,Math.min(b,x2)-Math.max(a,x1));
  const night=Math.min(work,ov(0,300)+ov(1320,1740)+ov(2760,2880));
  const ot=Math.max(0,work-480);
  const rate=toNum(st.hourly);
  const basePay=st.payType==="hourly"?work/60*rate:0;
  const nightPay=night/60*rate*toNum(st.nightRate)/100;
  const otPay=ot/60*rate*toNum(st.otRate)/100;
  const tr=s.transport!=null&&s.transport!==""?toNum(s.transport):toNum(st.transportPerDay);
  return{work,night,ot,basePay,nightPay,otPay,transport:tr,total:basePay+nightPay+otPay+tr};
}
function salary(ym){
  const st=S.settings;const{from,to}=payPeriod(ym);
  const shifts=S.cols.shifts.filter(s=>s.date>=from&&s.date<=to).sort((a,b)=>a.date<b.date?-1:1);
  const z={work:0,night:0,ot:0,basePay:0,nightPay:0,otPay:0,transport:0};
  for(const s of shifts){const c=calcShift(s);for(const k in z)z[k]+=c[k]}
  const fixedPay=(st.payType==="monthly"?toNum(st.baseSalary):0)+toNum(st.allowance);
  const gross=Math.round(z.basePay+z.nightPay+z.otPay+fixedPay)+Math.round(z.transport);
  const taxable=gross-Math.round(z.transport);
  const deduct=Math.round(taxable*toNum(st.deductRate)/100);
  return{from,to,shifts,days:new Set(shifts.map(s=>s.date)).size,...z,fixedPay,gross,deduct,net:gross-deduct,hasSetup:shifts.length>0||fixedPay>0};
}
function monthSum(ym){
  const recs=S.cols.receipts.filter(r=>ymOf(r.date)===ym);
  const varExp=recs.reduce((a,r)=>a+recTotal(r),0);
  const fixed=fixedTotal();
  const sal=salary(ym);
  const other=S.cols.incomes.filter(i=>ymOf(i.date)===ym).reduce((a,i)=>a+toNum(i.amount),0);
  const income=sal.net+other;
  const expense=varExp+fixed;
  return{ym,recs,varExp,fixed,sal,other,income,expense,balance:income-expense};
}
function genreBreak(recs){
  const m={};for(const r of recs)for(const it of r.items||[]){const g=it.genre||"その他";m[g]=(m[g]||0)+toNum(it.price)}
  const f=fixedTotal();if(f)m["固定費"]=(m["固定費"]||0)+f;
  return Object.entries(m).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);
}
/* 単位換算：g/kg→100g、ml/L→100ml、個/枚/本/パック→1つ */
function unitInfo(amount,unit){
  const a=toNum(amount);if(!a||!unit)return null;
  if(unit==="g")return{base:a/100,label:"100gあたり",kind:"w"};
  if(unit==="kg")return{base:a*10,label:"100gあたり",kind:"w"};
  if(unit==="ml")return{base:a/100,label:"100mlあたり",kind:"v"};
  if(unit==="L")return{base:a*10,label:"100mlあたり",kind:"v"};
  return{base:a,label:`1${unit}あたり`,kind:"c:"+unit};
}
const unitPrice=(price,amount,unit)=>{const u=unitInfo(amount,unit);return u?{v:toNum(price)/u.base,label:u.label,kind:u.kind}:null};

/* ===== ナビ ===== */
const IC={
  home:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/></svg>',
  rec:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 2h12v20l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 22z"/><path d="M9 7h6M9 11h6M9 15h4"/></svg>',
  pay:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  mkt:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 4h2l2.5 11h11L21 7H6.2"/><circle cx="9" cy="19.5" r="1.4"/><circle cx="17" cy="19.5" r="1.4"/></svg>',
  calc:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20 20 4M6 4v6M3 7h6M14 17h6"/></svg>',
  set:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>'
};
const TABS=[["home","家計簿","home"],["rec","レシート","rec"],["pay","給料","pay"],["mkt","相場","mkt"],["calc","割安計算","calc"],["set","設定","set"]];
function renderNav(){
  const b=TABS.map(([k,l,i])=>`<button data-tab="${k}" ${S.tab===k?'aria-current="page"':""}>${IC[i]}<span>${l}</span></button>`).join("");
  $("#bnav").innerHTML=b;
  $("#side").innerHTML=`<div class="logo"><i></i>家計ノート</div>${b}<span class="sync" id="sync2"><b></b><span></span></span>`;
  setSync();
}
document.addEventListener("click",e=>{const t=e.target.closest("[data-tab]");if(t){S.tab=t.dataset.tab;try{localStorage.setItem(LKEY+"-tab",S.tab)}catch{}renderAll();scrollTo(0,0)}});

/* ===== 画面描画 ===== */
function monthBar(id){return `<div class="monthbar"><button class="ib" data-mon="-1" aria-label="前の月">‹</button><span class="m">${ymLabel(S.ym)}</span><button class="ib" data-mon="1" aria-label="次の月">›</button>${S.ym!==ymOf(today())?`<button class="btn sm" data-mon="0">今月</button>`:""}</div>`}
document.addEventListener("click",e=>{const t=e.target.closest("[data-mon]");if(!t)return;const k=Number(t.dataset.mon);S.ym=k?addMonth(S.ym,k):ymOf(today());renderAll()});

let dirtyTab=null;
function renderAll(){renderNav();const m=$("#main");m.innerHTML=VIEWS[S.tab].shell();VIEWS[S.tab].data&&VIEWS[S.tab].data();dirtyTab=S.tab}
function rerender(){if(dirtyTab!==S.tab){renderAll();return}VIEWS[S.tab].data&&VIEWS[S.tab].data()}

const VIEWS={};

/* ---- 家計簿チェック ---- */
VIEWS.home={
  shell:()=>`
  <div class="head"><h2>家計簿チェック</h2>${monthBar()}</div>
  <div id="h-kpi"></div>
  <div class="grid2">
    <section class="panel"><div class="head"><h3>貯蓄の見込み</h3><span class="small muted" id="h-goal"></span></div><div id="h-proj"></div></section>
    <section class="panel"><h3>ジャンル別の支出</h3><div id="h-genre"></div></section>
  </div>
  <section class="panel"><div class="head"><h3>6か月の推移</h3><span class="small muted"><span class="plus">■</span> 収入　<span class="minus">■</span> 支出　● 収支</span></div><div class="chart" id="h-chart"></div></section>
  <div class="grid2">
    <section class="panel"><div class="head"><h3>この月のレシート</h3><button class="btn sm" data-tab="rec">すべて見る</button></div><div id="h-recent"></div></section>
    <section class="panel"><h3>その他の収入</h3>
      <form id="incForm" class="fields">
        <label class="f">日付<input id="inc-date" type="date" required></label>
        <label class="f">内容<input id="inc-label" placeholder="仕送り・臨時収入など" required></label>
        <label class="f">金額（円）<input id="inc-amt" type="number" inputmode="numeric" required></label>
        <div style="display:flex;align-items:flex-end"><button class="btn pri" type="submit">追加</button></div>
      </form>
      <div id="h-inc"></div>
    </section>
  </div>`,
  data(){
    const M=monthSum(S.ym);const st=S.settings;
    if(!$("#inc-date").value)$("#inc-date").value=S.ym===ymOf(today())?today():`${S.ym}-01`;
    $("#h-kpi").innerHTML=`<div class="kpis">
      <div class="kpi"><span class="l">収入</span><span class="v plus">${yen(M.income)}</span><span class="s">給料手取り ${yen(M.sal.net)}${M.other?` ＋ その他 ${yen(M.other)}`:""}</span></div>
      <div class="kpi"><span class="l">支出</span><span class="v minus">${yen(M.expense)}</span><span class="s">レシート ${yen(M.varExp)} ＋ 固定費 ${yen(M.fixed)}</span></div>
      <div class="kpi"><span class="l">収支</span><span class="v ${M.balance>=0?"plus":"minus"}">${M.balance>=0?"+":""}${yen(M.balance)}</span><span class="s">${M.recs.length}枚のレシート</span></div>
      <div class="kpi"><span class="l">貯蓄目標</span><span class="v">${yen(st.savingsGoal)}</span><span class="s">${toNum(st.savingsGoal)?`達成率 ${Math.max(0,Math.round(M.balance/toNum(st.savingsGoal)*100))}%`:"設定で目標を決められます"}</span></div></div>`;
    // 見込み
    const cur=S.ym===ymOf(today());const dim=daysIn(S.ym);const day=cur?Number(today().slice(8)):dim;
    const isPast=S.ym<ymOf(today());
    const projVar=cur&&day>0?M.varExp/day*dim:M.varExp;
    const projBal=M.income-(projVar+M.fixed);
    const goal=toNum(st.savingsGoal);
    const pct=goal?Math.max(0,Math.min(100,projBal/goal*100)):0;
    const avgDay=day?M.varExp/day:0;
    const remainForGoal=M.income-M.fixed-goal-M.varExp;
    const perDayLeft=cur&&dim-day>0?remainForGoal/(dim-day+1):null;
    $("#h-goal").textContent=cur?`${day}日目 / ${dim}日`:isPast?"確定":"これからの月";
    $("#h-proj").innerHTML=`
      <div class="row" style="justify-content:space-between;align-items:baseline"><span class="muted small">${cur?"今のペースで月末まで使った場合の貯蓄":"この月の貯蓄"}</span><span class="num ${projBal>=0?"plus":"minus"}" style="font-size:1.6rem;font-weight:600">${projBal>=0?"+":""}${yen(projBal)}</span></div>
      ${goal?`<div class="meter" role="img" aria-label="目標達成見込み ${Math.round(pct)}%"><div class="fill" style="width:${pct}%;background:${projBal>=goal?"var(--accent)":"var(--warn)"}"></div></div>
      <div class="small muted">目標 ${yen(goal)} に対して ${Math.round(projBal/goal*100)}%${projBal>=goal?" — このままなら達成できます":` — あと ${yen(goal-projBal)} 足りない見込み`}</div>`:""}
      <table class="tb"><tbody>
        <tr><td>1日あたりの変動費（平均）</td><td class="r num">${yen(avgDay)}</td></tr>
        ${cur?`<tr><td>月末までの変動費（見込み）</td><td class="r num">${yen(projVar)}</td></tr>`:""}
        ${cur&&goal&&perDayLeft!=null?`<tr><td>目標達成に使える1日あたり</td><td class="r num ${perDayLeft<0?"minus":""}">${yen(perDayLeft)}</td></tr>`:""}
        <tr><td>給料の対象期間</td><td class="r num small">${M.sal.from.slice(5).replace("-","/")}〜${M.sal.to.slice(5).replace("-","/")}</td></tr>
      </tbody></table>`;
    // ジャンル
    const gb=genreBreak(M.recs);const mx=gb[0]?.[1]||1;const tot=gb.reduce((a,[,v])=>a+v,0);
    $("#h-genre").innerHTML=gb.length?`<div class="bars">${gb.map(([g,v])=>`<div class="bar"><span>${esc(g)}</span><div class="track"><div class="fill" style="width:${v/mx*100}%;${g==="固定費"?"background:var(--muted)":""}"></div></div><span class="v">${yen(v)} <span class="muted small">${Math.round(v/tot*100)}%</span></span></div>`).join("")}</div>`:`<div class="empty">レシートを登録すると、ジャンルごとの内訳がここに出ます。</div>`;
    // チャート
    const months=[...Array(6)].map((_,i)=>addMonth(S.ym,i-5));const data=months.map(monthSum);
    const W=640,H=230,L=58,R=12,T=14,B=30;const maxV=Math.max(1,...data.map(d=>Math.max(d.income,d.expense)));
    const minB=Math.min(0,...data.map(d=>d.balance));
    const nice=v=>{const p=Math.pow(10,Math.floor(Math.log10(v)));return Math.ceil(v/p)*p};
    const top=nice(maxV);const bot=minB<0?-nice(-minB):0;
    const y=v=>T+(top-v)/(top-bot)*(H-T-B);const cw=(W-L-R)/6;
    const ticks=[bot,0,top/2,top].filter((v,i,a)=>a.indexOf(v)===i);
    let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="6か月の収入と支出">`;
    for(const t of ticks)svg+=`<line x1="${L}" x2="${W-R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" ${t===0?"":'stroke-dasharray="3 4"'}/><text x="${L-6}" y="${y(t)+4}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="IBM Plex Mono,monospace">${t>=10000||t<=-10000?(t/10000).toFixed(t%10000?1:0)+"万":t.toLocaleString()}</text>`;
    data.forEach((d,i)=>{const cx=L+cw*i+cw/2;const bw=Math.min(22,cw/3.2);
      svg+=`<rect x="${cx-bw-2}" y="${y(d.income)}" width="${bw}" height="${Math.max(0,y(0)-y(d.income))}" rx="3" fill="var(--plus)"><title>収入 ${yen(d.income)}</title></rect>`;
      svg+=`<rect x="${cx+2}" y="${y(d.expense)}" width="${bw}" height="${Math.max(0,y(0)-y(d.expense))}" rx="3" fill="var(--minus)"><title>支出 ${yen(d.expense)}</title></rect>`;
      svg+=`<text x="${cx}" y="${H-10}" text-anchor="middle" font-size="11" fill="${d.ym===S.ym?"var(--ink)":"var(--muted)"}" font-weight="${d.ym===S.ym?700:400}">${Number(d.ym.slice(5))}月</text>`});
    svg+=`<polyline fill="none" stroke="var(--ink)" stroke-width="1.6" points="${data.map((d,i)=>`${L+cw*i+cw/2},${y(d.balance)}`).join(" ")}"/>`;
    data.forEach((d,i)=>svg+=`<circle cx="${L+cw*i+cw/2}" cy="${y(d.balance)}" r="${d.ym===S.ym?4.5:3}" fill="var(--surface)" stroke="var(--ink)" stroke-width="1.6"><title>収支 ${yen(d.balance)}</title></circle>`);
    $("#h-chart").innerHTML=svg+"</svg>";
    // 最近
    const recs=[...M.recs].sort((a,b)=>a.date<b.date?1:-1).slice(0,6);
    $("#h-recent").innerHTML=recs.length?`<div class="list">${recs.map(r=>`<div class="li" data-open="${r.id}" style="cursor:pointer"><div class="main"><div class="t">${esc(r.store||"（店名なし）")}</div><div class="small muted num">${esc(r.date)}・${(r.items||[]).length}品目</div></div><span class="amt">${yen(recTotal(r))}</span></div>`).join("")}</div>`:`<div class="empty">まだレシートがありません。<br><button class="btn sm" data-tab="rec" style="margin-top:8px">レシートを登録する</button></div>`;
    const inc=S.cols.incomes.filter(i=>ymOf(i.date)===S.ym).sort((a,b)=>a.date<b.date?1:-1);
    $("#h-inc").innerHTML=inc.length?`<div class="list">${inc.map(i=>`<div class="li"><div class="main"><div class="t">${esc(i.label)}</div><div class="small muted num">${esc(i.date)}</div></div><span class="amt plus">${yen(i.amount)}</span><button class="ib" data-delinc="${i.id}" aria-label="削除">×</button></div>`).join("")}</div>`:`<div class="note">給料以外の収入があれば記録できます。</div>`;
  }
};
document.addEventListener("submit",async e=>{
  if(e.target.id==="incForm"){e.preventDefault();
    await put("incomes",{date:$("#inc-date").value,label:$("#inc-label").value.trim(),amount:toNum($("#inc-amt").value)}).then(()=>{$("#inc-label").value="";$("#inc-amt").value="";toast("収入を追加しました")}).catch(()=>{})}
});
document.addEventListener("click",e=>{const t=e.target.closest("[data-delinc]");if(t)del("incomes",t.dataset.delinc).catch(()=>{})});

/* ---- レシート ---- */
VIEWS.rec={
  shell:()=>`
  <div class="head"><h2>レシート</h2>${monthBar()}</div>
  <label class="drop" id="drop" for="rfile">
    <div style="flex:1;min-width:200px"><div class="big">レシートを撮影・選択</div><div class="small muted">写真から品目・金額を読み取ります（端末内で処理）。読み取り後に手直しして保存します。</div></div>
    <span class="btn pri">写真を選ぶ</span>
    <input id="rfile" type="file" accept="image/*" hidden>
  </label>
  <div class="row"><button class="btn" id="manualRec">写真なしで手入力</button><span class="sp" style="flex:1"></span><input id="rq" placeholder="店名・品目で検索" style="max-width:240px"></div>
  <div id="r-sum" class="small muted"></div>
  <div id="r-list"></div>`,
  data(){
    const q=($("#rq")?.value||"").trim().toLowerCase();
    let recs=S.cols.receipts.filter(r=>ymOf(r.date)===S.ym);
    if(q)recs=recs.filter(r=>(r.store||"").toLowerCase().includes(q)||(r.items||[]).some(it=>(it.name||"").toLowerCase().includes(q)));
    recs.sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:(b.createdAt||0)-(a.createdAt||0));
    $("#r-sum").textContent=recs.length?`${recs.length}枚・合計 ${yen(recs.reduce((a,r)=>a+recTotal(r),0))}`:"";
    $("#r-list").innerHTML=recs.length?`<div class="rgrid">${recs.map(r=>`<button class="rc" data-open="${r.id}">${r.thumb?`<img class="ph" src="${esc(r.thumb)}" alt="" loading="lazy">`:`<span class="ph"></span>`}<span class="info"><span class="store">${esc(r.store||"（店名なし）")}</span><span class="small muted num">${esc(r.date)}</span><span class="small muted">${(r.items||[]).slice(0,3).map(i=>esc(i.name)).join("・")}${(r.items||[]).length>3?" ほか":""}</span><span class="tot">${yen(recTotal(r))}</span></span></button>`).join("")}</div>`
      :`<div class="empty">${q?"条件に合うレシートはありません。":`${ymLabel(S.ym)}のレシートはまだありません。<br>上の「写真を選ぶ」から1枚目を登録しましょう。`}</div>`;
  }
};
document.addEventListener("input",e=>{if(e.target.id==="rq")VIEWS.rec.data()});
document.addEventListener("change",e=>{if(e.target.id==="rfile"&&e.target.files[0]){startReceipt(e.target.files[0]);e.target.value=""}});
document.addEventListener("dragover",e=>{const d=e.target.closest?.("#drop");if(d){e.preventDefault();d.classList.add("over")}});
document.addEventListener("dragleave",e=>{const d=e.target.closest?.("#drop");if(d)d.classList.remove("over")});
document.addEventListener("drop",e=>{const d=e.target.closest?.("#drop");if(d){e.preventDefault();d.classList.remove("over");const f=e.dataTransfer.files[0];if(f&&f.type.startsWith("image/"))startReceipt(f)}});
document.addEventListener("click",e=>{
  if(e.target.closest("#manualRec"))openEditor({date:S.ym===ymOf(today())?today():`${S.ym}-01`,store:"",items:[{name:"",genre:S.settings.categories[0]||"その他",qty:1,price:""}]},{});
  const o=e.target.closest("[data-open]");if(o){const r=S.cols.receipts.find(x=>x.id===o.dataset.open);if(r)openEditor(JSON.parse(JSON.stringify(r)),{})}
});

function loadImg(file){return new Promise((res,rej)=>{const img=new Image();const u=URL.createObjectURL(file);img.onload=()=>{URL.revokeObjectURL(u);res(img)};img.onerror=()=>{URL.revokeObjectURL(u);rej(new Error("画像を読み込めません"))};img.src=u})}
function drawTo(img,max){let w=img.naturalWidth,h=img.naturalHeight;const k=Math.min(1,max/Math.max(w,h));w=Math.round(w*k);h=Math.round(h*k);const c=document.createElement("canvas");c.width=w;c.height=h;c.getContext("2d").drawImage(img,0,0,w,h);return c}
const toBlob=(c,q)=>new Promise(r=>c.toBlob(r,"image/jpeg",q));
async function prepareImages(file){
  const img=await loadImg(file);
  const ocrBlob=await toBlob(drawTo(img,2200),.92);          // 読み取り用（高解像度・保存しない）
  let full=drawTo(img,1400),q=.72,url=full.toDataURL("image/jpeg",q);
  while(url.length>900000&&q>.35){q-=.1;url=full.toDataURL("image/jpeg",q)}  // Firestoreの1件1MB制限に収める
  if(url.length>900000){full=drawTo(img,1000);url=full.toDataURL("image/jpeg",.6)}
  const thumb=drawTo(img,160).toDataURL("image/jpeg",.6);
  return{ocrBlob,full:url,thumb};
}
async function startReceipt(file){
  let im;try{im=await prepareImages(file)}catch{toast("この画像は読み込めませんでした。JPEGかPNGでお試しください");return}
  const rec={date:today(),store:"",items:[],receiptTotal:null,createdAt:Date.now(),thumb:im.thumb};
  const ctx={photo:im.full,newPhoto:im.full,ocrState:"run",prog:0,progLabel:"準備中"};
  openEditor(rec,ctx);
  runOcr(im.ocrBlob,rec,ctx);
}
async function runOcr(blob,rec,ctx){
  const cats=S.settings.categories;
  try{
    const out=await ocrReceipt(blob,cats,(label,p)=>{ctx.progLabel=label;ctx.prog=p;edStatus()});
    if(ED?.rec!==rec)return;
    if(out.store&&!rec.store)rec.store=out.store;
    if(out.date)rec.date=out.date;
    rec.items=out.items;rec.receiptTotal=out.total;ctx.raw=out.raw;
    ctx.ocrState=out.items.length?"done":"empty";
  }catch(err){console.warn(err);if(ED?.rec!==rec)return;ctx.ocrState="err";ctx.ocrErr=navigator.onLine?"読み取りに失敗しました。手入力で登録できます。":"初回の読み取りにはネット接続が必要です（文字データのダウンロード）。手入力で登録できます。"}
  if(!rec.items.length)rec.items.push({name:"",genre:cats[0]||"その他",qty:1,price:""});
  $("#ed-date")&&($("#ed-date").value=rec.date);$("#ed-store")&&($("#ed-store").value=rec.store);$("#ed-rt")&&($("#ed-rt").value=rec.receiptTotal??"");
  drawItems();edStatus();
}

/* レシート編集 */
let ED=null;
function openEditor(rec,ctx){
  if(!rec.items)rec.items=[];ED={rec,ctx,isNew:!rec.id};
  $("#modalRoot").innerHTML=`<div class="ov" id="ov"><div class="modal" id="ed" role="dialog" aria-modal="true" aria-label="レシートの編集">
    <div class="head"><h2>${ED.isNew?"レシートを登録":"レシートを編集"}</h2><button class="ib" id="edClose" aria-label="閉じる">×</button></div>
    <div class="ed">
      <div style="display:flex;flex-direction:column;gap:10px;min-width:0">
        <div class="pv" id="pv">${ctx.photo?`<img src="${esc(ctx.photo)}" alt="レシートの写真">`:rec.photoId?`<span class="small muted">写真を読み込み中…</span>`:`<span class="small muted">写真なし</span>`}</div>
        <div id="edStatus"></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;min-width:0">
        <div class="fields">
          <label class="f">日付<input id="ed-date" type="date" value="${esc(rec.date)}"></label>
          <label class="f">店名<input id="ed-store" value="${esc(rec.store)}" placeholder="スーパー○○ 駅前店"></label>
        </div>
        <div class="tw"><table class="items"><thead><tr><th>品目</th><th>ジャンル</th><th>数量</th><th>金額（円）</th><th></th></tr></thead><tbody id="edItems"></tbody></table></div>
        <div class="row"><button class="btn sm" id="edAdd">＋ 行を追加</button><button class="btn sm" id="edToMkt" title="品目と金額を相場メモに記録">相場に記録</button></div>
        <label class="f">メモ<input id="ed-memo" value="${esc(rec.memo||"")}" placeholder="任意"></label>
        <div class="totline"><div><div class="small muted">品目の合計</div><div class="big" id="edSum"></div></div>
          <label class="f" style="width:11em">レシート記載の合計<input id="ed-rt" type="number" inputmode="numeric" value="${rec.receiptTotal??""}" placeholder="照合用"></label></div>
        <div id="edDiff"></div>
        <div class="row" style="justify-content:space-between">
          ${ED.isNew?"<span></span>":`<button class="btn danger" id="edDel">削除</button>`}
          <div class="row"><button class="btn" id="edCancel">キャンセル</button><button class="btn pri" id="edSave">保存</button></div>
        </div>
      </div>
    </div></div></div>`;
  drawItems();edStatus();
  if(!ctx.photo&&rec.photoId)loadPhoto(rec.photoId).then(u=>{if(ED?.rec!==rec)return;const pv=$("#pv");if(!pv)return;ctx.photo=u;pv.innerHTML=u?`<img src="${esc(u)}" alt="レシートの写真">`:`<span class="small muted">写真が見つかりません</span>`});
}
function drawItems(){
  if(!ED||!$("#edItems"))return;const cats=[...S.settings.categories];
  $("#edItems").innerHTML=ED.rec.items.map((it,i)=>{const cs=cats.includes(it.genre)?cats:[...cats,it.genre||"その他"];
    return `<tr data-i="${i}"><td class="c-name"><input data-k="name" id="it-n-${i}" value="${esc(it.name)}" aria-label="品目"></td>
    <td class="c-g"><select data-k="genre" id="it-g-${i}" aria-label="ジャンル">${cs.map(c=>`<option ${c===it.genre?"selected":""}>${esc(c)}</option>`).join("")}</select></td>
    <td class="c-q"><input data-k="qty" id="it-q-${i}" type="number" inputmode="decimal" value="${esc(it.qty)}" aria-label="数量"></td>
    <td class="c-p"><input data-k="price" id="it-p-${i}" type="number" inputmode="numeric" value="${esc(it.price)}" aria-label="金額"></td>
    <td class="x"><button class="ib" data-rm="${i}" aria-label="行を削除">×</button></td></tr>`}).join("");
  edSum();
}
function edSum(){
  if(!ED||!$("#edSum"))return;const s=recTotal(ED.rec);$("#edSum").textContent=yen(s);
  const rt=$("#ed-rt").value;const d=$("#edDiff");
  if(rt===""){d.innerHTML="";return}
  const diff=toNum(rt)-s;
  d.innerHTML=diff===0?`<div class="status ok">レシートの合計と一致しています</div>`:`<div class="status warn">レシートの合計と ${yen(Math.abs(diff))} ${diff>0?"足りません（読み落とした行がないか確認）":"多くなっています（重複や値引きの符号を確認）"}</div>`;
}
function edStatus(){
  if(!ED||!$("#edStatus"))return;const c=ED.ctx;const out=[];
  if(c.ocrState==="run")out.push(`<div class="status"><span class="spin"></span><span style="flex:none">${esc(c.progLabel)}</span><span class="prog"><i style="width:${Math.round((c.prog||0)*100)}%"></i></span></div>`);
  if(c.ocrState==="done")out.push(`<div class="status ok">読み取りました。品目と金額を写真と見比べて確認してください</div>`);
  if(c.ocrState==="empty")out.push(`<div class="status warn">品目を見つけられませんでした。明るい場所でまっすぐ撮り直すか、手入力してください</div>`);
  if(c.ocrState==="err")out.push(`<div class="status err">${esc(c.ocrErr)}</div>`);
  if(c.raw)out.push(`<details><summary class="small muted" style="cursor:pointer">読み取った文字を見る</summary><pre class="ocrraw">${esc(c.raw)}</pre></details>`);
  if(c.saving)out.push(`<div class="status"><span class="spin"></span>保存しています…</div>`);
  $("#edStatus").innerHTML=out.join("");
  const sv=$("#edSave");if(sv)sv.disabled=c.ocrState==="run"||!!c.saving;
}
function closeEditor(){ED=null;$("#modalRoot").innerHTML=""}
document.addEventListener("input",e=>{
  if(!ED)return;const tr=e.target.closest("#edItems tr");
  if(tr){const i=Number(tr.dataset.i),k=e.target.dataset.k;ED.rec.items[i][k]=k==="qty"||k==="price"?(e.target.value===""?"":Number(e.target.value)):e.target.value;edSum()}
  if(e.target.id==="ed-rt")edSum();
});
document.addEventListener("change",e=>{if(ED&&e.target.closest("#edItems")&&e.target.dataset.k==="genre"){ED.rec.items[Number(e.target.closest("tr").dataset.i)].genre=e.target.value}});
document.addEventListener("click",async e=>{
  if(!ED)return;const t=e.target;
  if(t.id==="ov"||t.closest("#edClose")||t.closest("#edCancel")){closeEditor();return}
  if(t.closest("#pv img")){const pv=$("#pv");pv.classList.toggle("zoom");$("#pv img").style.width=pv.classList.contains("zoom")?"200%":"";pv.style.overflow="auto";return}
  if(t.closest("#edAdd")){ED.rec.items.push({name:"",genre:S.settings.categories[0]||"その他",qty:1,price:""});drawItems();$(`#it-n-${ED.rec.items.length-1}`)?.focus();return}
  const rm=t.closest("[data-rm]");if(rm){ED.rec.items.splice(Number(rm.dataset.rm),1);drawItems();return}
  if(t.closest("#edToMkt")){
    const store=$("#ed-store").value.trim(),date=$("#ed-date").value;let n=0;
    for(const it of ED.rec.items){if(!it.name||toNum(it.price)<=0||/値引|割引|消費税/.test(it.name))continue;
      const q=toNum(it.qty)||1;await put("prices",{item:it.name,price:Math.round(toNum(it.price)/q),amount:"",unit:"",store,sale:"",date,memo:"レシートから"}).catch(()=>{});n++}
    toast(n?`${n}品目を相場に記録しました`:"記録できる品目がありません");return}
  const dl=t.closest("#edDel");
  if(dl){if(!dl.classList.contains("armed")){dl.classList.add("armed");dl.textContent="もう一度押すと削除";setTimeout(()=>{if(dl.isConnected){dl.classList.remove("armed");dl.textContent="削除"}},3000);return}
    const r=ED.rec;await del("receipts",r.id).catch(()=>{});delPhoto(r.photoId);closeEditor();toast("削除しました");return}
  if(t.closest("#edSave")){
    const r=ED.rec,ctx=ED.ctx;r.date=$("#ed-date").value||today();r.store=$("#ed-store").value.trim();r.memo=$("#ed-memo").value.trim();
    r.receiptTotal=$("#ed-rt").value===""?null:toNum($("#ed-rt").value);
    r.items=r.items.filter(it=>it.name||it.price!=="").map(it=>({name:String(it.name).trim(),genre:it.genre||"その他",qty:toNum(it.qty)||1,price:toNum(it.price)}));
    r.total=recTotal(r);r.createdAt=r.createdAt||Date.now();
    if(!r.items.length){toast("品目を1つ以上入力してください");return}
    ctx.saving=true;edStatus();
    try{
      if(ctx.newPhoto){try{r.photoId=await savePhoto(ctx.newPhoto);ctx.newPhoto=null}catch{toast("写真は保存できませんでしたが、内容は保存します")}}
      await put("receipts",r);const ym=ymOf(r.date);closeEditor();if(ym!==S.ym){S.ym=ym;renderAll()}toast("保存しました");
    }catch{ctx.saving=false;edStatus()}
  }
});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&ED)closeEditor()});

/* ---- 給料 ---- */
VIEWS.pay={
  shell:()=>`
  <div class="head"><h2>給料計算</h2>${monthBar()}</div>
  <div id="p-kpi"></div>
  <div class="grid2">
    <section class="panel"><h3>出勤を記録</h3>
      <form id="shiftForm" class="fields">
        <label class="f">出勤日<input id="sh-date" type="date" required></label>
        <label class="f">開始<input id="sh-start" type="time" value="09:00" required></label>
        <label class="f">終了<input id="sh-end" type="time" value="17:00" required></label>
        <label class="f">休憩（分）<input id="sh-break" type="number" inputmode="numeric" value="60"></label>
        <label class="f">交通費（空欄で既定）<input id="sh-tr" type="number" inputmode="numeric" placeholder="既定"></label>
        <label class="f">メモ<input id="sh-memo" placeholder="任意"></label>
        <div style="display:flex;align-items:flex-end;gap:6px"><button class="btn pri" type="submit" id="sh-submit">追加</button><button class="btn" type="button" id="sh-cancel" hidden>取消</button></div>
      </form>
      <div class="note" id="sh-prev"></div>
    </section>
    <section class="panel"><details class="cfg" id="payCfg"><summary>給与の設定</summary>
      <form id="payForm" class="fields" style="margin-top:12px">
        <label class="f">給与形態<select id="pc-type"><option value="hourly">時給</option><option value="monthly">月給（基本給）</option></select></label>
        <label class="f">時給（円）<input id="pc-hourly" type="number" inputmode="numeric"></label>
        <label class="f">基本給（月・円）<input id="pc-base" type="number" inputmode="numeric"></label>
        <label class="f">手当（月・円）<input id="pc-allow" type="number" inputmode="numeric"></label>
        <label class="f">交通費（1日・円）<input id="pc-tr" type="number" inputmode="numeric"></label>
        <label class="f">深夜割増（%）<input id="pc-night" type="number" inputmode="numeric"></label>
        <label class="f">残業割増（%）<input id="pc-ot" type="number" inputmode="numeric"></label>
        <label class="f">締め日（0＝末日）<input id="pc-close" type="number" min="0" max="28" inputmode="numeric"></label>
        <label class="f">控除の目安（%）<input id="pc-ded" type="number" inputmode="decimal" step="0.1"></label>
        <div style="display:flex;align-items:flex-end"><button class="btn pri" type="submit">設定を保存</button></div>
      </form>
      <p class="note">深夜は22時〜翌5時、残業は1日8時間を超えた分で計算します。月給の場合、時給欄は割増計算用の時間単価として使います。控除（所得税・社会保険など）は概算の割合です。</p>
    </details></section>
  </div>
  <section class="panel"><div class="head"><h3>出勤一覧</h3><span class="small muted" id="p-period"></span></div><div class="tw" id="p-list"></div></section>`,
  data(){
    const st=S.settings;const sal=salary(S.ym);
    if(!$("#sh-date").value)$("#sh-date").value=today()>=sal.from&&today()<=sal.to?today():sal.from;
    if(!$("#payCfg").dataset.filled||document.activeElement?.closest?.("#payForm")==null){
      $("#pc-type").value=st.payType;$("#pc-hourly").value=st.hourly;$("#pc-base").value=st.baseSalary;$("#pc-allow").value=st.allowance;$("#pc-tr").value=st.transportPerDay;$("#pc-night").value=st.nightRate;$("#pc-ot").value=st.otRate;$("#pc-close").value=st.closingDay;$("#pc-ded").value=st.deductRate;$("#payCfg").dataset.filled=1}
    const h=m=>`${Math.floor(m/60)}:${pad(Math.round(m%60))}`;
    $("#p-kpi").innerHTML=`<div class="kpis">
      <div class="kpi"><span class="l">出勤日数</span><span class="v">${sal.days}<span class="small"> 日</span></span><span class="s">総労働 ${h(sal.work)}</span></div>
      <div class="kpi"><span class="l">深夜・残業</span><span class="v">${h(sal.night)}<span class="small"> / </span>${h(sal.ot)}</span><span class="s">割増 ${yen(sal.nightPay+sal.otPay)}</span></div>
      <div class="kpi"><span class="l">総支給</span><span class="v plus">${yen(sal.gross)}</span><span class="s">うち交通費 ${yen(sal.transport)}</span></div>
      <div class="kpi"><span class="l">手取り見込み</span><span class="v">${yen(sal.net)}</span><span class="s">控除 ${yen(sal.deduct)}（${toNum(st.deductRate)}%）</span></div></div>`;
    $("#p-period").textContent=`対象期間 ${sal.from} 〜 ${sal.to}`;
    $("#p-list").innerHTML=sal.shifts.length?`<table class="tb"><thead><tr><th>日付</th><th>時間</th><th class="r">休憩</th><th class="r">労働</th><th class="r">深夜</th><th class="r">残業</th><th class="r">支給</th><th>メモ</th><th></th></tr></thead><tbody>${sal.shifts.map(s=>{const c=calcShift(s);const wd="日月火水木金土"[new Date(s.date+"T00:00").getDay()];
      return `<tr><td class="num">${esc(s.date.slice(5).replace("-","/"))}（${wd}）</td><td class="num">${esc(s.start)}–${esc(s.end)}</td><td class="r num">${toNum(s.breakMin)}分</td><td class="r num">${h(c.work)}</td><td class="r num">${c.night?h(c.night):"—"}</td><td class="r num">${c.ot?h(c.ot):"—"}</td><td class="r num">${yen(c.total)}</td><td class="small muted">${esc(s.memo||"")}</td><td><span class="row" style="flex-wrap:nowrap"><button class="btn sm" data-edshift="${s.id}">編集</button><button class="ib" data-delshift="${s.id}" aria-label="削除">×</button></span></td></tr>`}).join("")}</tbody></table>`
      :`<div class="empty">この期間の出勤はまだありません。上のフォームから出勤日と時間を追加すると、給料が自動で計算されます。</div>`;
    shPrev();
  }
};
function shPrev(){const el=$("#sh-prev");if(!el)return;const c=calcShift({start:$("#sh-start").value,end:$("#sh-end").value,breakMin:$("#sh-break").value,transport:$("#sh-tr").value});
  el.textContent=`この内容だと 労働 ${Math.floor(c.work/60)}時間${pad(c.work%60)}分${c.night?`（深夜 ${Math.round(c.night/6)/10}h）`:""}・支給 ${yen(c.total)}`}
let editShiftId=null;
document.addEventListener("input",e=>{if(e.target.closest?.("#shiftForm"))shPrev()});
document.addEventListener("submit",async e=>{
  if(e.target.id==="shiftForm"){e.preventDefault();
    const s={date:$("#sh-date").value,start:$("#sh-start").value,end:$("#sh-end").value,breakMin:toNum($("#sh-break").value),transport:$("#sh-tr").value===""?null:toNum($("#sh-tr").value),memo:$("#sh-memo").value.trim()};
    if(editShiftId)s.id=editShiftId;
    await put("shifts",s).then(()=>{toast(editShiftId?"出勤を更新しました":"出勤を追加しました");editShiftId=null;$("#sh-submit").textContent="追加";$("#sh-cancel").hidden=true;$("#sh-memo").value=""}).catch(()=>{})}
  if(e.target.id==="payForm"){e.preventDefault();
    await saveSettings({payType:$("#pc-type").value,hourly:toNum($("#pc-hourly").value),baseSalary:toNum($("#pc-base").value),allowance:toNum($("#pc-allow").value),transportPerDay:toNum($("#pc-tr").value),nightRate:toNum($("#pc-night").value),otRate:toNum($("#pc-ot").value),closingDay:Math.max(0,Math.min(28,toNum($("#pc-close").value))),deductRate:toNum($("#pc-ded").value)});toast("給与の設定を保存しました")}
});
document.addEventListener("click",e=>{
  const d=e.target.closest("[data-delshift]");if(d){del("shifts",d.dataset.delshift).catch(()=>{});return}
  const ed=e.target.closest("[data-edshift]");if(ed){const s=S.cols.shifts.find(x=>x.id===ed.dataset.edshift);if(!s)return;editShiftId=s.id;
    $("#sh-date").value=s.date;$("#sh-start").value=s.start;$("#sh-end").value=s.end;$("#sh-break").value=s.breakMin;$("#sh-tr").value=s.transport??"";$("#sh-memo").value=s.memo||"";
    $("#sh-submit").textContent="更新";$("#sh-cancel").hidden=false;shPrev();$("#shiftForm").scrollIntoView({behavior:"smooth",block:"center"})}
  if(e.target.closest("#sh-cancel")){editShiftId=null;$("#sh-submit").textContent="追加";$("#sh-cancel").hidden=true}
});

/* ---- 相場 ---- */
const UNITS=["","g","kg","ml","L","個","枚","本","パック","袋"];
VIEWS.mkt={
  shell:()=>`
  <div class="head"><h2>相場メモ</h2><input id="mq" placeholder="品目・店名で検索" style="max-width:240px"></div>
  <section class="panel"><h3 id="mk-title">価格を記録</h3>
    <form id="mktForm" class="fields">
      <label class="f">品目<input id="mk-item" list="mk-items" required placeholder="例: 鶏むね肉"></label>
      <label class="f">価格（円・税込）<input id="mk-price" type="number" inputmode="numeric" required></label>
      <label class="f">内容量<input id="mk-amt" type="number" inputmode="decimal" placeholder="例: 300"></label>
      <label class="f">単位<select id="mk-unit">${UNITS.map(u=>`<option value="${u}">${u||"—"}</option>`).join("")}</select></label>
      <label class="f">店名<input id="mk-store" list="mk-stores" placeholder="例: ○○スーパー"></label>
      <label class="f">セール・特売<input id="mk-sale" placeholder="例: 毎週火曜 / 夕方5時以降"></label>
      <label class="f">日付<input id="mk-date" type="date"></label>
      <label class="f">メモ<input id="mk-memo" placeholder="任意"></label>
      <div style="display:flex;align-items:flex-end;gap:6px"><button class="btn pri" type="submit" id="mk-submit">記録</button><button class="btn" type="button" id="mk-cancel" hidden>取消</button></div>
    </form>
    <datalist id="mk-items"></datalist><datalist id="mk-stores"></datalist>
    <div class="note" id="mk-hint"></div>
  </section>
  <section class="panel"><div class="head"><h3>品目ごとの相場</h3><span class="small muted" id="mk-count"></span></div><div id="mk-list"></div></section>`,
  data(){
    if(!$("#mk-date").value)$("#mk-date").value=today();
    const all=S.cols.prices;
    $("#mk-items").innerHTML=[...new Set(all.map(p=>p.item))].map(v=>`<option value="${esc(v)}">`).join("");
    $("#mk-stores").innerHTML=[...new Set(all.map(p=>p.store).filter(Boolean))].map(v=>`<option value="${esc(v)}">`).join("");
    const q=($("#mq").value||"").trim().toLowerCase();
    const g={};for(const p of all){if(q&&!(`${p.item} ${p.store} ${p.sale}`.toLowerCase().includes(q)))continue;(g[p.item]=g[p.item]||[]).push(p)}
    const keys=Object.keys(g).sort((a,b)=>a.localeCompare(b,"ja"));
    $("#mk-count").textContent=keys.length?`${keys.length}品目・${all.length}件`:"";
    $("#mk-list").innerHTML=keys.length?keys.map(k=>{
      const rows=g[k].map(p=>({...p,up:unitPrice(p.price,p.amount,p.unit)}));
      // 比べる基準：単価が出せるものは単価、出せなければ価格
      const kinds={};rows.forEach(r=>{if(r.up)kinds[r.up.kind]=(kinds[r.up.kind]||0)+1});
      const mainKind=Object.entries(kinds).sort((a,b)=>b[1]-a[1])[0]?.[0];
      const val=r=>mainKind?(r.up&&r.up.kind===mainKind?r.up.v:null):toNum(r.price);
      const vals=rows.map(val).filter(v=>v!=null);const mn=Math.min(...vals),mxv=Math.max(...vals);
      const avg=vals.reduce((a,b)=>a+b,0)/(vals.length||1);
      rows.sort((a,b)=>(val(a)??1e15)-(val(b)??1e15));
      const lbl=mainKind?rows.find(r=>r.up?.kind===mainKind).up.label:"1点あたり";
      return `<div class="grp"><div class="row" style="justify-content:space-between"><h3>${esc(k)}</h3><span class="small muted">${lbl}　最安 <b class="num">${yen(mn)}</b>・平均 <span class="num">${yen(avg)}</span>・最高 <span class="num">${yen(mxv)}</span></span></div>
      <div class="tw"><table class="tb"><thead><tr><th>店</th><th class="r">価格</th><th class="r">内容量</th><th class="r">${lbl}</th><th>セール</th><th>日付</th><th></th></tr></thead><tbody>${rows.map(r=>{const v=val(r);const best=v!=null&&v===mn&&vals.length>1;
        return `<tr class="${best?"best":""}"><td>${esc(r.store||"—")} ${best?'<span class="chip">最安</span>':""}${v!=null&&vals.length>2&&v>avg*1.15?' <span class="chip red">割高</span>':""}</td><td class="r num">${yen(r.price)}</td><td class="r num">${r.amount?esc(r.amount)+esc(r.unit):"—"}</td><td class="r num">${v!=null?yen(v):"—"}</td><td class="small">${r.sale?`<span class="chip warn">${esc(r.sale)}</span>`:""}</td><td class="num small muted">${esc(r.date||"")}</td><td><span class="row" style="flex-wrap:nowrap"><button class="btn sm" data-edp="${r.id}">編集</button><button class="ib" data-delp="${r.id}" aria-label="削除">×</button></span></td></tr>`}).join("")}</tbody></table></div>
      ${rows.some(r=>r.memo)?`<div class="note">${rows.filter(r=>r.memo).map(r=>`${esc(r.store||"")}：${esc(r.memo)}`).join("　")}</div>`:""}</div>`}).join("")
      :`<div class="empty">${q?"条件に合う記録はありません。":"よく買う食材の価格を店ごとに記録すると、最安の店と平均がここに並びます。"}</div>`;
    mkHint();
  }
};
function mkHint(){const el=$("#mk-hint");if(!el)return;const item=$("#mk-item").value.trim();const up=unitPrice($("#mk-price").value,$("#mk-amt").value,$("#mk-unit").value);
  const rec=S.cols.prices.filter(p=>p.item===item&&p.id!==editPriceId);let msg="";
  if(up)msg+=`${up.label} ${yen(up.v)}`;
  if(item&&rec.length&&$("#mk-price").value){
    const cmp=up?rec.map(p=>unitPrice(p.price,p.amount,p.unit)).filter(x=>x&&x.kind===up.kind).map(x=>x.v):rec.map(p=>toNum(p.price));
    const cur=up?up.v:toNum($("#mk-price").value);
    if(cmp.length){const mn=Math.min(...cmp),avg=cmp.reduce((a,b)=>a+b,0)/cmp.length;
      msg+=`${msg?"　":""}これまでの最安 ${yen(mn)}・平均 ${yen(avg)} → ${cur<=mn?"最安値です":cur<avg?`平均より ${Math.round((1-cur/avg)*100)}% 安い`:`平均より ${Math.round((cur/avg-1)*100)}% 高い`}`}}
  el.textContent=msg}
let editPriceId=null;
document.addEventListener("input",e=>{if(e.target.id==="mq")VIEWS.mkt.data();if(e.target.closest?.("#mktForm"))mkHint()});
document.addEventListener("change",e=>{if(e.target.id==="mk-unit")mkHint()});
document.addEventListener("submit",async e=>{
  if(e.target.id!=="mktForm")return;e.preventDefault();
  const p={item:$("#mk-item").value.trim(),price:toNum($("#mk-price").value),amount:$("#mk-amt").value===""?"":toNum($("#mk-amt").value),unit:$("#mk-unit").value,store:$("#mk-store").value.trim(),sale:$("#mk-sale").value.trim(),date:$("#mk-date").value,memo:$("#mk-memo").value.trim()};
  if(editPriceId)p.id=editPriceId;
  await put("prices",p).then(()=>{toast(editPriceId?"更新しました":"記録しました");editPriceId=null;$("#mk-submit").textContent="記録";$("#mk-cancel").hidden=true;$("#mk-title").textContent="価格を記録";["mk-price","mk-amt","mk-sale","mk-memo"].forEach(i=>$("#"+i).value="");$("#mk-hint").textContent=""}).catch(()=>{});
});
document.addEventListener("click",e=>{
  const d=e.target.closest("[data-delp]");if(d){del("prices",d.dataset.delp).catch(()=>{});return}
  const ed=e.target.closest("[data-edp]");if(ed){const p=S.cols.prices.find(x=>x.id===ed.dataset.edp);if(!p)return;editPriceId=p.id;
    $("#mk-item").value=p.item;$("#mk-price").value=p.price;$("#mk-amt").value=p.amount;$("#mk-unit").value=p.unit||"";$("#mk-store").value=p.store||"";$("#mk-sale").value=p.sale||"";$("#mk-date").value=p.date||"";$("#mk-memo").value=p.memo||"";
    $("#mk-submit").textContent="更新";$("#mk-cancel").hidden=false;$("#mk-title").textContent="記録を編集";mkHint();$("#mktForm").scrollIntoView({behavior:"smooth",block:"center"})}
  if(e.target.closest("#mk-cancel")){editPriceId=null;$("#mk-submit").textContent="記録";$("#mk-cancel").hidden=true;$("#mk-title").textContent="価格を記録"}
});

/* ---- 割安計算 ---- */
let CMP=[{name:"A",price:"",amount:"",unit:"g"},{name:"B",price:"",amount:"",unit:"g"}];
try{const c=JSON.parse(localStorage.getItem(LKEY+"-cmp")||"null");if(Array.isArray(c)&&c.length)CMP=c}catch{}
VIEWS.calc={
  shell:()=>`
  <div class="head"><h2>割安計算</h2></div>
  <div class="grid2">
  <section class="panel"><div class="head"><h3>商品を比べる</h3><span class="note">価格と内容量を入れると単価を比べます</span></div>
    <div class="cmp-row small muted"><span>名前</span><span>価格（円）</span><span>内容量</span><span>単位</span><span></span></div>
    <div id="cmpRows" style="display:flex;flex-direction:column;gap:6px"></div>
    <div class="row"><button class="btn sm" id="cmpAdd">＋ 商品を追加</button><button class="btn sm" id="cmpClear">クリア</button></div>
    <div id="cmpOut" class="cmp-out"></div>
  </section>
  <section class="panel"><h3>○○gでいくら？</h3>
    <div class="fields">
      <label class="f">価格（円）<input id="q-price" type="number" inputmode="numeric" value="398"></label>
      <label class="f">内容量<input id="q-amt" type="number" inputmode="decimal" value="300"></label>
      <label class="f">知りたい量<input id="q-want" type="number" inputmode="decimal" value="100"></label>
    </div>
    <div id="q-out"></div>
    <p class="note">単位は内容量と知りたい量で同じものを使ってください（g同士、ml同士など）。</p>
  </section></div>`,
  data(){drawCmp();qCalc()}
};
function drawCmp(){
  $("#cmpRows").innerHTML=CMP.map((c,i)=>`<div class="cmp-row" data-ci="${i}"><input data-k="name" id="c-n-${i}" value="${esc(c.name)}" aria-label="名前"><input data-k="price" id="c-p-${i}" type="number" inputmode="numeric" value="${esc(c.price)}" aria-label="価格"><input data-k="amount" id="c-a-${i}" type="number" inputmode="decimal" value="${esc(c.amount)}" aria-label="内容量"><select data-k="unit" id="c-u-${i}" aria-label="単位">${UNITS.slice(1).map(u=>`<option ${u===c.unit?"selected":""}>${u}</option>`).join("")}</select><button class="ib" data-crm="${i}" aria-label="削除">×</button></div>`).join("");
  cmpOut();
}
function cmpOut(){
  try{localStorage.setItem(LKEY+"-cmp",JSON.stringify(CMP))}catch{}
  const rs=CMP.map(c=>({...c,up:unitPrice(c.price,c.amount,c.unit)})).filter(c=>c.up&&toNum(c.price)>0);
  if(!rs.length){$("#cmpOut").innerHTML=`<div class="note">価格と内容量を入れてください。</div>`;return}
  const kinds=[...new Set(rs.map(r=>r.up.kind))];
  $("#cmpOut").innerHTML=kinds.map(k=>{const g=rs.filter(r=>r.up.kind===k).sort((a,b)=>a.up.v-b.up.v);const mn=g[0].up.v;
    // 相場の最安と比較
    return g.map((r,i)=>{const mk=S.cols.prices.filter(p=>p.item===r.name).map(p=>unitPrice(p.price,p.amount,p.unit)).filter(x=>x&&x.kind===k).map(x=>x.v);const mkMin=mk.length?Math.min(...mk):null;
      return `<div class="cmp-res ${i===0&&g.length>1?"best":""}"><span>${esc(r.name||"（名前なし）")} ${i===0&&g.length>1?"— いちばん割安":i>0?`<span class="small">（${Math.round((r.up.v/mn-1)*100)}% 高い）</span>`:""}</span><span class="num">${r.up.label} ${r.up.v.toFixed(r.up.v<100?1:0)}円${mkMin!=null?` <span class="small muted">相場最安 ${mkMin.toFixed(mkMin<100?1:0)}円</span>`:""}</span></div>`}).join("")}).join("")
    +(kinds.length>1?`<div class="note">単位の種類が違う商品は別々に比べています（重さ・容量・個数）。</div>`:"");
}
function qCalc(){const p=toNum($("#q-price").value),a=toNum($("#q-amt").value),w=toNum($("#q-want").value);
  $("#q-out").innerHTML=p&&a&&w?`<div class="cmp-res best"><span>${w}あたり</span><span class="num" style="font-size:1.2rem">${(p/a*w).toFixed(1)} 円</span></div><div class="note num">1あたり ${(p/a).toFixed(2)} 円</div>`:`<div class="note">3つの欄を入れてください。</div>`}
document.addEventListener("input",e=>{
  const r=e.target.closest?.("#cmpRows [data-ci]");if(r){CMP[Number(r.dataset.ci)][e.target.dataset.k]=e.target.value;cmpOut()}
  if(["q-price","q-amt","q-want"].includes(e.target.id))qCalc();
});
document.addEventListener("change",e=>{const r=e.target.closest?.("#cmpRows [data-ci]");if(r&&e.target.tagName==="SELECT"){CMP[Number(r.dataset.ci)].unit=e.target.value;cmpOut()}});
document.addEventListener("click",e=>{
  if(e.target.closest("#cmpAdd")){CMP.push({name:String.fromCharCode(65+CMP.length%26),price:"",amount:"",unit:CMP.at(-1)?.unit||"g"});drawCmp()}
  if(e.target.closest("#cmpClear")){CMP=[{name:"A",price:"",amount:"",unit:"g"},{name:"B",price:"",amount:"",unit:"g"}];drawCmp()}
  const rm=e.target.closest("[data-crm]");if(rm){CMP.splice(Number(rm.dataset.crm),1);if(!CMP.length)CMP.push({name:"A",price:"",amount:"",unit:"g"});drawCmp()}
});

/* ---- 設定 ---- */
VIEWS.set={
  shell:()=>`
  <div class="head"><h2>設定</h2></div>
  <div class="grid2">
    <section class="panel"><h3>支出のジャンル</h3>
      <label class="f">読点（、）か改行で区切って入力<textarea id="st-cats" rows="4"></textarea></label>
      <div><button class="btn pri" id="st-cats-save">ジャンルを保存</button></div>
      <p class="note">レシート読み取り時のジャンル推定もこの中から選びます。</p>
    </section>
    <section class="panel"><h3>貯蓄目標</h3>
      <label class="f">毎月の目標額（円）<input id="st-goal" type="number" inputmode="numeric"></label>
      <div><button class="btn pri" id="st-goal-save">目標を保存</button></div>
    </section>
  </div>
  <section class="panel"><div class="head"><h3>固定費（毎月の支出に自動で加算）</h3><span class="num" id="st-fixed-tot"></span></div>
    <form id="fixForm" class="fields"><label class="f">項目<input id="fx-name" required placeholder="家賃・スマホ代など"></label><label class="f">金額（円/月）<input id="fx-amt" type="number" inputmode="numeric" required></label><div style="display:flex;align-items:flex-end"><button class="btn pri" type="submit">追加</button></div></form>
    <div id="st-fixed"></div>
  </section>
  <div class="grid2">
    <section class="panel"><h3>バックアップ</h3>
      <p class="note" style="margin:0">記録をファイルに書き出して保管できます。読み込むと同じIDの記録は上書きされ、それ以外は追加されます（写真は含みません）。</p>
      <div class="row"><button class="btn" id="bk-json">JSONで書き出す</button><button class="btn" id="bk-csv">支出をCSVで書き出す</button></div>
      <label class="btn" for="bk-file" style="align-self:flex-start">JSONを読み込む</label><input id="bk-file" type="file" accept="application/json,.json" hidden>
    </section>
    <section class="panel"><h3>アカウントと保存先</h3><div id="st-store" class="small"></div><div class="row" id="st-acct"></div></section>
  </div>`,
  data(){
    const st=S.settings;
    if(document.activeElement?.id!=="st-cats")$("#st-cats").value=st.categories.join("、");
    if(document.activeElement?.id!=="st-goal")$("#st-goal").value=st.savingsGoal;
    $("#st-fixed-tot").textContent=yen(fixedTotal());
    $("#st-fixed").innerHTML=(st.fixed||[]).length?`<div class="list">${st.fixed.map((f,i)=>`<div class="li"><div class="main t">${esc(f.name)}</div><span class="amt">${yen(f.amount)}</span><button class="ib" data-delfx="${i}" aria-label="削除">×</button></div>`).join("")}</div>`:`<div class="note">家賃や通信費など毎月決まった支出を登録すると、家計簿の支出に自動で入ります。</div>`;
    $("#st-store").innerHTML=S.mode==="cloud"
      ?`<span class="chip">同期中</span>　${esc(S.user?.email||"ログイン中")}<br>記録はFirebaseのあなた専用の領域に保存され、スマホとPCで同じ内容が反映されます。オフラインでも記録でき、つながったときに同期されます。`
      :`<span class="chip warn">この端末のみ</span>　このブラウザ内に保存しています。ログインすると端末間で同期できます（今の記録はバックアップ→読み込みで移せます）。`;
    $("#st-acct").innerHTML=S.mode==="cloud"?`<button class="btn" id="st-logout">ログアウト</button>`:`<button class="btn pri" id="st-login">ログイン画面へ</button>`;
  }
};
document.addEventListener("click",async e=>{
  if(e.target.closest("#st-cats-save")){const c=$("#st-cats").value.split(/[、,，\n]/).map(s=>s.trim()).filter(Boolean);if(!c.length){toast("ジャンルを1つ以上入れてください");return}saveSettings({categories:[...new Set(c)]}).then(()=>toast("ジャンルを保存しました"))}
  if(e.target.closest("#st-goal-save"))saveSettings({savingsGoal:toNum($("#st-goal").value)}).then(()=>toast("目標を保存しました"));
  const d=e.target.closest("[data-delfx]");if(d){const f=[...S.settings.fixed];f.splice(Number(d.dataset.delfx),1);saveSettings({fixed:f})}
  if(e.target.closest("#st-logout")){stopCloud();await signOut(fb.auth)}
  if(e.target.closest("#st-login")){try{localStorage.removeItem(LKEY+"-localmode")}catch{}showGate()}
  if(e.target.closest("#bk-json"))download(`kakei-note-${today()}.json`,JSON.stringify({app:"kakei-note",version:1,exportedAt:new Date().toISOString(),settings:S.settings,cols:S.cols},null,1),"application/json");
  if(e.target.closest("#bk-csv")){
    const q=v=>`"${String(v??"").replace(/"/g,'""')}"`;
    const rows=[["日付","店名","品目","ジャンル","数量","金額","メモ"]];
    for(const r of [...S.cols.receipts].sort((a,b)=>a.date<b.date?-1:1))for(const it of r.items||[])rows.push([r.date,r.store,it.name,it.genre,it.qty,it.price,r.memo]);
    download(`kakei-note-支出-${today()}.csv`,"﻿"+rows.map(r=>r.map(q).join(",")).join("\r\n"),"text/csv");
  }
});
document.addEventListener("submit",e=>{if(e.target.id==="fixForm"){e.preventDefault();saveSettings({fixed:[...(S.settings.fixed||[]),{name:$("#fx-name").value.trim(),amount:toNum($("#fx-amt").value)}]}).then(()=>{$("#fx-name").value="";$("#fx-amt").value="";toast("固定費を追加しました")})}});
document.addEventListener("change",async e=>{
  if(e.target.id!=="bk-file"||!e.target.files[0])return;
  try{
    const data=JSON.parse(await e.target.files[0].text());
    if(data.app!=="kakei-note"||!data.cols)throw new Error("形式が違います");
    let n=0;
    if(data.settings)await saveSettings({...DEF_SETTINGS,...data.settings});
    for(const c of COLS)for(const row of data.cols[c]||[]){await put(c,row);n++}
    toast(`${n}件を読み込みました`);
  }catch(err){toast("読み込めませんでした。家計ノートで書き出したJSONを選んでください")}
  e.target.value="";
});
function download(name,text,type){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000)}

/* ===== 起動 ===== */
try{const t=localStorage.getItem(LKEY+"-tab");if(t&&VIEWS[t])S.tab=t}catch{}
if("serviceWorker" in navigator)addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));
if(fb){
  getRedirectResult(fb.auth).catch(err=>showGate(authMsg(err)));
  onAuthStateChanged(fb.auth,user=>{
    if(user)startCloud(user);
    else{stopCloud();S.user=null;let local=false;try{local=localStorage.getItem(LKEY+"-localmode")==="1"}catch{}
      if(local)startLocal();else showGate()}
  });
}else{
  let local=false;try{local=localStorage.getItem(LKEY+"-localmode")==="1"}catch{}
  if(local)startLocal();else showGate();
}
