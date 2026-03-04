/* ロト7 相棒ジェネレータ
   - base_draws.json（第1回〜第666回）を読み込む
   - 端末内保存（localStorage）で追加/更新
   - セット球は入力が増えるほど、遷移/頻度/待ち回数で予測
   - 予測セットに応じて、セット別の数字ウェイトも学習
*/

const LS_USER_DRAWS = "loto7_user_draws_v1";
const LS_SETTINGS = "loto7_settings_v1";
const LS_HISTORY = "loto7_history_v1";

// If a previous version registered a Service Worker, it can keep serving stale files.
// This app prefers direct network loads, so we proactively unregister old SWs.
try{
  if(typeof navigator !== "undefined" && "serviceWorker" in navigator){
    navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(()=>{});
  }
}catch{}

const SETS = ["A","B","C","D","E","F","G","H","I","J"];
const NUM_MIN = 1;
const NUM_MAX = 37;

const DEFAULT_SETTINGS = {
  // 1口/週（あなたの運用にチューニング）
  sumMin: 115,
  sumMax: 152,
  oddMode: "34",     // "34"=3〜4, "4"=4固定, "3"=3固定, "2354"=2〜5, "any"=制限なし
  minHigh: 1,        // 32以上を最低1つ（誕生日数字回避＝当たった時の分け前対策）
  overlapMin: 0,
  overlapMax: 2,
  ensureTertile: true,   // 1-12 / 13-24 / 25-37 を最低1つずつ
  preferClose: true,     // 前回の近く（±1/±2）を少し優遇

  // セット球予測ウェイト（学習型）
  wTransition: 0.55,
  wFrequency: 0.25,
  wRecency: 0.20,

  // 学習のなめらかさ
  smoothingSet: 1,       // セット球のラプラス平滑
  smoothingNum: 1,       // 数字のラプラス平滑

  // セット別ウェイトを使う最低サンプル数
  setSpecificMinSamples: 20,
  blendSetWeight: 0.55,  // 0〜1（セット別と全体を混ぜる割合）

  // 重み補正
  boostHigh: 1.08,
  boostClose1: 1.10,
  boostClose2: 1.05,

  // 連番の入れすぎ防止（人気パターン対策）
  maxConsecutivePairs: 2,

  // 生成履歴
  keepHistory: 10,
};

// ===== Utilities =====
function $(id){ return document.getElementById(id); }

function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }
function sum(arr){ return arr.reduce((a,b)=>a+b,0); }
function uniq(arr){ return Array.from(new Set(arr)); }
function isInt(n){ return Number.isInteger(n) && Number.isFinite(n); }
function pad2(n){ return String(n).padStart(2,"0"); }

function safeJsonParse(str, fallback){
  try{ return JSON.parse(str); }catch{ return fallback; }
}

function loadSettings(){
  const s = safeJsonParse(localStorage.getItem(LS_SETTINGS), null);
  return Object.assign({}, DEFAULT_SETTINGS, s || {});
}
function saveSettings(s){
  localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
}

function loadUserDraws(){
  return safeJsonParse(localStorage.getItem(LS_USER_DRAWS), {});
}
function saveUserDraws(map){
  localStorage.setItem(LS_USER_DRAWS, JSON.stringify(map));
}

function loadHistory(){
  return safeJsonParse(localStorage.getItem(LS_HISTORY), []);
}
function saveHistory(items){
  localStorage.setItem(LS_HISTORY, JSON.stringify(items.slice(0, DEFAULT_SETTINGS.keepHistory)));
}

// YYYY-MM-DD to Date
function parseDateISO(s){
  const d = new Date(s + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}

function formatDateJP(iso){
  const d = parseDateISO(iso);
  if(!d) return iso;
  const y = d.getFullYear();
  const m = d.getMonth()+1;
  const day = d.getDate();
  return `${y}/${m}/${day}`;
}

function addDaysISO(iso, days){
  const d = parseDateISO(iso);
  if(!d) return iso;
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = pad2(d.getMonth()+1);
  const day = pad2(d.getDate());
  return `${y}-${m}-${day}`;
}

function normalizeProbs(obj){
  const entries = Object.entries(obj);
  const total = entries.reduce((a,[,v])=>a + (Number(v)||0), 0);
  if(total <= 0){
    const uniform = 1/entries.length;
    const out = {};
    for(const [k] of entries) out[k] = uniform;
    return out;
  }
  const out = {};
  for(const [k,v] of entries) out[k] = (Number(v)||0) / total;
  return out;
}

// Weighted pick single index
function weightedPick(items, weights){
  let total = 0;
  for(let i=0;i<weights.length;i++) total += weights[i];
  if(total <= 0){
    return Math.floor(Math.random() * items.length);
  }
  let r = Math.random() * total;
  for(let i=0;i<weights.length;i++){
    r -= weights[i];
    if(r <= 0) return i;
  }
  return items.length-1;
}

// Weighted sample without replacement
function weightedSample(values, weights, k){
  const vals = values.slice();
  const wts = weights.slice();
  const picked = [];
  for(let i=0;i<k;i++){
    const idx = weightedPick(vals, wts);
    picked.push(vals[idx]);
    vals.splice(idx,1);
    wts.splice(idx,1);
  }
  return picked;
}

// ===== Data loading/merging =====
let BASE_DRAWS = [];
let DRAWS = [];        // merged
let STATS = null;
let SETTINGS = loadSettings();

async function loadBase(){
  // Prefer script-inlined data (works even when opened from local file).
  if (typeof window !== "undefined"){
    // v4+: accept either __BASE_DRAWS__ (preferred) or legacy BASE_DRAWS.
    const fromInline = (Array.isArray(window.__BASE_DRAWS__) && window.__BASE_DRAWS__) ||
                       (Array.isArray(window.BASE_DRAWS) && window.BASE_DRAWS) ||
                       null;
    if(fromInline && fromInline.length){
      BASE_DRAWS = fromInline;
      return;
    }
  }

  // Fallback: load JSON via fetch (works on GitHub Pages / normal hosting).
  const res = await fetch("base_draws.json", { cache: "no-store" });
  if(!res.ok){
    throw new Error(`base_draws.json の読み込みに失敗しました（HTTP ${res.status}）`);
  }
  try{
    BASE_DRAWS = await res.json();
  }catch(e){
    throw new Error(`base_draws.json のJSON解析に失敗しました：${e?.message || e}`);
  }
}

function mergeDraws(){
  const userMap = loadUserDraws();
  const merged = BASE_DRAWS.map(d => {
    const ud = userMap[String(d.no)];
    if(!ud) return d;
    // overlay (ud can contain set only or full)
    return Object.assign({}, d, ud);
  });

  // include future draws (no > base max)
  const baseMax = Math.max(...BASE_DRAWS.map(d=>d.no));
  for(const [k,ud] of Object.entries(userMap)){
    const no = Number(k);
    if(no > baseMax){
      merged.push(ud);
    }
  }

  merged.sort((a,b)=>a.no-b.no);
  DRAWS = merged;
}

// ===== Stats computation =====
function computeStats(draws){
  const total = draws.length;
  const maxNo = draws[draws.length-1]?.no ?? 0;
  const latest = draws[draws.length-1] || null;

  // overall number counts
  const overall = {};
  for(let n=NUM_MIN;n<=NUM_MAX;n++) overall[n] = 0;

  // set counts and set-specific number counts
  const setCounts = {};
  const setNumCounts = {};
  const setLastSeen = {};
  for(const s of SETS){
    setCounts[s] = 0;
    setNumCounts[s] = {};
    for(let n=NUM_MIN;n<=NUM_MAX;n++) setNumCounts[s][n] = 0;
    setLastSeen[s] = null;
  }

  // odd/sum distributions (main)
  const oddDist = {};
  const sumVals = [];

  // transition counts
  const trans = {};
  for(const s of SETS){
    trans[s] = {};
    for(const t of SETS) trans[s][t] = 0;
  }

  let lastSet = null;
  let labeledDraws = 0;
  const labeledSequence = [];

  for(const d of draws){
    if(Array.isArray(d.nums) && d.nums.length === 7){
      for(const n of d.nums){
        if(overall[n] !== undefined) overall[n] += 1;
      }
      // sum & odd
      const s = sum(d.nums);
      sumVals.push(s);
      const odd = d.nums.reduce((a,n)=>a+(n%2?1:0),0);
      oddDist[odd] = (oddDist[odd]||0)+1;
    }

    if(d.set && SETS.includes(d.set)){
      labeledDraws += 1;
      setCounts[d.set] += 1;
      setLastSeen[d.set] = d.no;
      labeledSequence.push({no:d.no, set:d.set});

      if(Array.isArray(d.nums) && d.nums.length === 7){
        for(const n of d.nums){
          setNumCounts[d.set][n] += 1;
        }
      }
    }
  }

  // transitions on labeled sequence
  for(let i=1;i<labeledSequence.length;i++){
    const prev = labeledSequence[i-1].set;
    const next = labeledSequence[i].set;
    if(prev && next) trans[prev][next] += 1;
  }

  // latest known set (from latest draw if labeled, else from last labeled)
  let latestSet = null;
  if(latest?.set && SETS.includes(latest.set)){
    latestSet = latest.set;
  } else {
    latestSet = labeledSequence.length ? labeledSequence[labeledSequence.length-1].set : null;
  }

  // sum stats
  sumVals.sort((a,b)=>a-b);
  const sumMean = sumVals.length ? sum(sumVals)/sumVals.length : null;
  const sumP25 = sumVals.length ? sumVals[Math.floor(sumVals.length*0.25)] : null;
  const sumP75 = sumVals.length ? sumVals[Math.floor(sumVals.length*0.75)] : null;

  // gaps per set (for recency scaling)
  const setGaps = {};
  for(const s of SETS) setGaps[s] = [];
  const perSetNos = {};
  for(const s of SETS) perSetNos[s] = [];
  for(const item of labeledSequence){
    perSetNos[item.set].push(item.no);
  }
  for(const s of SETS){
    const nos = perSetNos[s];
    for(let i=1;i<nos.length;i++){
      setGaps[s].push(nos[i]-nos[i-1]);
    }
  }

  return {
    total, maxNo, latest,
    overall, oddDist, sumMean, sumP25, sumP75,
    setCounts, setNumCounts, setLastSeen, labeledDraws,
    trans, latestSet, setGaps
  };
}

// ===== Set prediction =====
function predictNextSet(stats, settings){
  // If no labeled data -> uniform
  const labeled = stats.labeledDraws || 0;
  const smooth = Number(settings.smoothingSet) || 1;

  const freq = {};
  const total = Object.values(stats.setCounts).reduce((a,b)=>a+b,0);

  for(const s of SETS){
    freq[s] = (stats.setCounts[s] + smooth) / (total + smooth*SETS.length);
  }

  // transition probabilities from latestSet
  const transProb = {};
  if(stats.latestSet){
    const row = stats.trans[stats.latestSet] || {};
    const rowTotal = Object.values(row).reduce((a,b)=>a+b,0);
    for(const s of SETS){
      transProb[s] = ( (row[s]||0) + smooth ) / (rowTotal + smooth*SETS.length);
    }
  }else{
    for(const s of SETS) transProb[s] = 1/SETS.length;
  }

  // recency (waiting) score
  const rec = {};
  const lastNo = stats.latest?.no ?? stats.maxNo ?? 0;
  // avg gap per set (fallback to 10 if unknown)
  const avgGap = {};
  for(const s of SETS){
    const gaps = stats.setGaps[s] || [];
    if(gaps.length){
      avgGap[s] = gaps.reduce((a,b)=>a+b,0)/gaps.length;
    } else {
      avgGap[s] = 10;
    }
  }

  // score: if waiting >= avgGap => >1, else <1 (clamp)
  for(const s of SETS){
    const lastSeen = stats.setLastSeen[s];
    const age = (lastSeen==null) ? (avgGap[s]*1.2) : (lastNo - lastSeen);
    const score = clamp((age + 1) / (avgGap[s] + 1), 0.25, 3.0);
    rec[s] = score;
  }
  const recProb = normalizeProbs(rec);

  // combine
  let wT = Number(settings.wTransition)||0;
  let wF = Number(settings.wFrequency)||0;
  let wR = Number(settings.wRecency)||0;
  const wSum = wT+wF+wR;
  if(wSum<=0){ wT=0.55; wF=0.25; wR=0.20; }
  else { wT/=wSum; wF/=wSum; wR/=wSum; }

  const combined = {};
  for(const s of SETS){
    combined[s] = wT*transProb[s] + wF*freq[s] + wR*recProb[s];
  }
  const probs = normalizeProbs(combined);

  // sort desc
  const ranked = Object.entries(probs).sort((a,b)=>b[1]-a[1]);

  // confidence heuristic (not real probability)
  const confidence = labeled >= 200 ? "高め" : labeled >= 80 ? "中くらい" : labeled >= 20 ? "低め" : "ほぼ無し";

  return {probs, ranked, confidence, labeled};
}

// ===== Number weights & generation =====
function computeOverallWeights(stats, settings){
  const smooth = Number(settings.smoothingNum)||1;
  const totalDraws = stats.total || 1;
  const totalBalls = totalDraws * 7;
  const denom = totalBalls + smooth * (NUM_MAX-NUM_MIN+1);

  const w = {};
  for(let n=NUM_MIN;n<=NUM_MAX;n++){
    w[n] = (stats.overall[n] + smooth) / denom;
  }
  return w;
}

function computeSetWeights(stats, setLetter, settings){
  const smooth = Number(settings.smoothingNum)||1;
  const drawsInSet = stats.setCounts[setLetter] || 0;
  const totalBalls = drawsInSet * 7;
  const denom = totalBalls + smooth * (NUM_MAX-NUM_MIN+1);
  const w = {};
  for(let n=NUM_MIN;n<=NUM_MAX;n++){
    w[n] = ( (stats.setNumCounts[setLetter]?.[n]||0) + smooth ) / denom;
  }
  return w;
}

function blendWeights(wOverall, wSet, blend){
  const out = {};
  for(let n=NUM_MIN;n<=NUM_MAX;n++){
    out[n] = (1-blend)*wOverall[n] + blend*wSet[n];
  }
  return out;
}

function applyHeuristicBoosts(weights, stats, settings){
  const out = Object.assign({}, weights);
  const lastNums = stats.latest?.nums || [];

  for(let n=NUM_MIN;n<=NUM_MAX;n++){
    let mult = 1.0;

    // high numbers (32-37) a little boost
    if(n >= 32) mult *= (Number(settings.boostHigh)||1.0);

    // closeness to last draw numbers
    if(settings.preferClose && lastNums.length){
      const d = Math.min(...lastNums.map(x=>Math.abs(x-n)));
      if(d === 1) mult *= (Number(settings.boostClose1)||1.0);
      else if(d === 2) mult *= (Number(settings.boostClose2)||1.0);
    }

    out[n] = out[n] * mult;
  }

  return out;
}

function oddAllowed(oddCount, settings){
  const mode = settings.oddMode;
  if(mode === "any") return true;
  if(mode === "4") return oddCount === 4;
  if(mode === "3") return oddCount === 3;
  if(mode === "34") return oddCount === 3 || oddCount === 4;
  if(mode === "2354") return oddCount >= 2 && oddCount <= 5;
  return oddCount === 3 || oddCount === 4;
}

function countConsecutivePairs(numsSorted){
  let pairs = 0;
  for(let i=1;i<numsSorted.length;i++){
    if(numsSorted[i]-numsSorted[i-1] === 1) pairs += 1;
  }
  return pairs;
}

function countOverlap(a, bSet){
  let c = 0;
  for(const x of a){
    if(bSet.has(x)) c += 1;
  }
  return c;
}

function tertileOk(nums){
  const has1 = nums.some(n=>n>=1 && n<=12);
  const has2 = nums.some(n=>n>=13 && n<=24);
  const has3 = nums.some(n=>n>=25 && n<=37);
  return has1 && has2 && has3;
}

function countHigh(nums){
  return nums.filter(n=>n>=32).length;
}

function generateOneLine(stats, settings, predictedSet){
  const overallW = computeOverallWeights(stats, settings);

  let w = overallW;
  let usedSetSpecific = false;

  if(predictedSet && SETS.includes(predictedSet) && settings.setSpecificMinSamples){
    const samples = stats.setCounts[predictedSet] || 0;
    if(samples >= Number(settings.setSpecificMinSamples)){
      const wSet = computeSetWeights(stats, predictedSet, settings);
      const blend = clamp(Number(settings.blendSetWeight)||0.0, 0, 1);
      w = blendWeights(overallW, wSet, blend);
      usedSetSpecific = true;
    }
  }

  // apply boosts
  w = applyHeuristicBoosts(w, stats, settings);

  // convert to arrays
  const values = [];
  const weights = [];
  for(let n=NUM_MIN;n<=NUM_MAX;n++){
    values.push(n);
    weights.push(w[n]);
  }

  const lastNums = stats.latest?.nums || [];
  const lastSet = new Set(lastNums);

  const attempts = 6000;
  for(let t=0;t<attempts;t++){
    const pick = weightedSample(values, weights, 7).sort((a,b)=>a-b);

    // constraints
    const s = sum(pick);
    if(s < Number(settings.sumMin) || s > Number(settings.sumMax)) continue;

    const odd = pick.reduce((a,n)=>a+(n%2?1:0),0);
    if(!oddAllowed(odd, settings)) continue;

    if(settings.ensureTertile && !tertileOk(pick)) continue;

    if(Number(settings.minHigh) > 0 && countHigh(pick) < Number(settings.minHigh)) continue;

    const overlap = countOverlap(pick, lastSet);
    if(overlap < Number(settings.overlapMin) || overlap > Number(settings.overlapMax)) continue;

    const consPairs = countConsecutivePairs(pick);
    if(consPairs > Number(settings.maxConsecutivePairs)) continue;

    return {nums: pick, sum:s, odd, overlap, consPairs, usedSetSpecific};
  }

  // fallback: relax a bit
  const pick = weightedSample(values, weights, 7).sort((a,b)=>a-b);
  const s = sum(pick);
  const odd = pick.reduce((a,n)=>a+(n%2?1:0),0);
  const overlap = countOverlap(pick, lastSet);
  const consPairs = countConsecutivePairs(pick);
  return {nums: pick, sum:s, odd, overlap, consPairs, usedSetSpecific, relaxed:true};
}

// ===== UI Rendering =====
function showView(name){
  const views = ["home","add","data","settings"];
  for(const v of views){
    const el = $("view-"+v);
    if(!el) continue;
    el.classList.toggle("view--active", v===name);
  }
  for(const btn of document.querySelectorAll(".nav-btn")){
    btn.classList.toggle("nav-btn--active", btn.dataset.view===name);
  }
}

function renderLatest(stats){
  const d = stats.latest;
  if(!d){
    $("latest-summary").textContent = "データがありません。";
    return;
  }
  const nums = d.nums?.map(pad2).join(" ");
  const bonus = d.bonus?.map(pad2).join(" ");
  const set = d.set ? ` / セット球: ${d.set}` : "";
  const nextNo = d.no + 1;
  const nextDate = addDaysISO(d.date, 7);
  $("latest-summary").innerHTML = `
    <div class="pills">
      <span class="pill">第${d.no}回</span>
      <span class="pill">${formatDateJP(d.date)}</span>
      <span class="pill">次回: 第${nextNo}回（${formatDateJP(nextDate)}）</span>
      ${d.set ? `<span class="pill">セット球: ${d.set}</span>` : `<span class="pill">セット球: 未入力</span>`}
    </div>
    <div style="margin-top:10px">
      <div class="numline">${nums}</div>
      <div class="muted">B: ${bonus}</div>
    </div>
  `;
}

function renderLearningStatus(stats){
  const labeled = stats.labeledDraws || 0;
  const total = stats.total || 0;
  const pct = total ? ((labeled/total)*100).toFixed(1) : "0.0";
  // set counts
  const pills = SETS.map(s=>{
    const c = stats.setCounts[s] || 0;
    return `<span class="pill">${s}: ${c}</span>`;
  }).join("");
  $("learning-status").innerHTML = `
    <div>セット球入力済み: <span class="badge">${labeled} / ${total}回（${pct}%）</span></div>
    <div class="pills" style="margin-top:10px">${pills}</div>
  `;
}

function renderSetPrediction(pred){
  if(!pred || pred.labeled < 1){
    $("set-prediction").textContent = "セット球データが無いので、予測はまだできません（追加/インポートしてください）。";
    return;
  }
  const top = pred.ranked.slice(0,5).map(([s,p],i)=>{
    const pct = (p*100).toFixed(1);
    return `<span class="pill">${i===0 ? "本命" : i===1 ? "対抗" : "候補"} ${s} ${pct}%</span>`;
  }).join("");
  $("set-prediction").innerHTML = `
    <div>学習データ: <span class="badge">${pred.labeled}回</span> / 信頼感: <span class="badge">${pred.confidence}</span></div>
    <div class="pills" style="margin-top:10px">${top}</div>
    <div class="hint">予測は「遷移（前→次）」「頻度」「待ち回数」を合成しています。</div>
  `;
}

function renderRecommendation(rec, predSet){
  const nums = rec.nums.map(pad2).join(" ");
  const oddEven = `${rec.odd}:${7-rec.odd}`;
  const noteRelax = rec.relaxed ? "（条件を満たせず、近い形で生成）" : "";
  const setNote = predSet ? `想定セット球: <b>${predSet}</b>` : "想定セット球: 未定";
  $("recommendation").innerHTML = `
    <div class="numline">${nums}</div>
    <div class="pills">
      <span class="pill">合計: ${rec.sum}</span>
      <span class="pill">奇数:偶数 = ${oddEven}</span>
      <span class="pill">前回一致: ${rec.overlap}</span>
      <span class="pill">連番ペア: ${rec.consPairs}</span>
      ${rec.usedSetSpecific ? `<span class="pill">セット別学習: ON</span>` : `<span class="pill">セット別学習: OFF</span>`}
    </div>
    <div class="hint">${setNote} ${noteRelax}</div>
  `;
}

function renderRecommendationMeta(stats, settings){
  const lines = [
    `合計（本数字）: ${settings.sumMin}〜${settings.sumMax}`,
    `奇数の個数: ${settings.oddMode==="34" ? "3〜4" : settings.oddMode==="any" ? "制限なし" : settings.oddMode}`,
    `前回一致: ${settings.overlapMin}〜${settings.overlapMax}`,
    `32以上: 最低${settings.minHigh}個`,
    `三分割(1-12/13-24/25-37): ${settings.ensureTertile ? "必須" : "任意"}`,
    `近い数字優遇: ${settings.preferClose ? "ON" : "OFF"}`,
  ];
  $("recommendation-meta").textContent = lines.join(" / ");
}

function renderDrawList(draws){
  const list = draws.slice(-20).reverse();
  const rows = list.map(d=>{
    const nums = (d.nums||[]).map(pad2).join(" ");
    const set = d.set ? d.set : "—";
    return `<div class="pills" style="margin:8px 0">
      <span class="pill">第${d.no}回</span>
      <span class="pill">${formatDateJP(d.date)}</span>
      <span class="pill">セット: ${set}</span>
      <span class="pill">${nums}</span>
    </div>`;
  }).join("");
  $("draw-list").innerHTML = rows || "<div class='muted'>まだありません。</div>";
}

// ===== Add/Update =====
function buildNumberInputs(){
  const main = $("main-inputs");
  const bonus = $("bonus-inputs");
  main.innerHTML = "";
  bonus.innerHTML = "";
  for(let i=1;i<=7;i++){
    const input = document.createElement("input");
    input.id = `n${i}`;
    input.placeholder = `第${i}`;
    input.inputMode = "numeric";
    main.appendChild(input);
  }
  for(let i=1;i<=2;i++){
    const input = document.createElement("input");
    input.id = `b${i}`;
    input.placeholder = `B${i}`;
    input.inputMode = "numeric";
    bonus.appendChild(input);
  }
}

function parseNumbersFromPaste(text){
  if(!text) return null;

  // Try to read draw number like "第666回"
  let no = null;
  const mNo = text.match(/第\s*(\d+)\s*回/);
  if(mNo) no = Number(mNo[1]);

  // Try to read set ball letter A-J from token list
  let set = null;
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  for(const tok of tokens){
    const t = tok.trim();
    if(t.length === 1 && t >= "A" && t <= "J"){
      set = t;
      break;
    }
  }

  // Collect numbers in order (we'll take the first 7+2 within 1..37)
  let nums = (text.match(/\d+/g) || []).map(x=>Number(x)).filter(n=>Number.isFinite(n));

  // If draw no is known and the first number equals it, drop it
  if(no != null && nums.length && nums[0] === no){
    nums = nums.slice(1);
  } else if(no == null && nums.length && nums[0] > NUM_MAX){
    // Sometimes the pasted text starts with draw number only (e.g. 666 ...)
    no = nums[0];
    nums = nums.slice(1);
  }

  const picked = [];
  for(const n of nums){
    if(n >= NUM_MIN && n <= NUM_MAX){
      picked.push(n);
      if(picked.length >= 9) break;
    }
  }
  if(picked.length < 7) return null;

  const main = picked.slice(0,7);
  const bonus = picked.slice(7,9);
  return {no, set, main, bonus};
}

function validateLine(main, bonus){
  // allow missing bonus for early save? (but better require)
  if(main.length !== 7) return {ok:false, msg:"本数字は7個必要です。"};
  const allMain = main.slice();
  if(allMain.some(n=>!isInt(n) || n<NUM_MIN || n>NUM_MAX)) return {ok:false, msg:"本数字は1〜37の整数で入力してください。"};
  if(uniq(allMain).length !== 7) return {ok:false, msg:"本数字が重複しています。"};

  if(bonus.length){
    if(bonus.length !== 2) return {ok:false, msg:"ボーナスは2個です（未入力なら空のままでもOK）。"};
    if(bonus.some(n=>!isInt(n) || n<NUM_MIN || n>NUM_MAX)) return {ok:false, msg:"ボーナスは1〜37の整数で入力してください。"};
  }
  return {ok:true};
}

function getAddForm(){
  const no = Number($("in-no").value);
  const date = $("in-date").value;
  const set = $("in-set").value || null;

  const main = [];
  const bonus = [];

  for(let i=1;i<=7;i++){
    const v = $("n"+i).value.trim();
    if(v==="") continue;
    main.push(Number(v));
  }
  for(let i=1;i<=2;i++){
    const v = $("b"+i).value.trim();
    if(v==="") continue;
    bonus.push(Number(v));
  }

  return {no, date, set, main, bonus};
}

function setAddDefaults(stats){
  const latest = stats.latest;
  if(!latest) return;
  $("in-no").value = String(latest.no + 1);
  $("in-date").value = addDaysISO(latest.date, 7);
}

// ===== Import / Export =====
function exportJSON(){
  const map = loadUserDraws();
  const payload = {
    exportedAt: new Date().toISOString(),
    note: "ロト7 相棒ジェネレータ - 端末内データ（追加/更新分）",
    userDraws: map,
    settings: loadSettings(),
    history: loadHistory()
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "loto7_buddy_backup.json";
  a.click();
  URL.revokeObjectURL(url);
}

function parseCSV(text){
  // very small parser: comma-separated, supports header
  const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length);
  if(!lines.length) return [];

  const first = lines[0];
  const hasHeader = /[A-Za-z]|no|date|set|n1|開催回|日付/.test(first);
  let header = null;
  let start = 0;

  if(hasHeader){
    header = first.split(",").map(h=>h.trim());
    start = 1;
  } else {
    header = null;
  }

  const rows = [];
  for(let i=start;i<lines.length;i++){
    const cols = lines[i].split(",").map(c=>c.trim());
    if(!cols.length) continue;
    rows.push({cols, header});
  }
  // map rows to objects
  const out = [];
  for(const r of rows){
    const {cols, header} = r;
    if(header){
      const obj = {};
      for(let i=0;i<header.length;i++){
        obj[header[i]] = cols[i];
      }
      out.push(obj);
    } else {
      // minimal: no,set
      if(cols.length >= 2){
        out.push({no: cols[0], set: cols[1]});
      }
    }
  }
  return out;
}

function normalizeImportedRow(obj){
  // Accept common keys:
  // no / 開催回, date / 日付, set / セット球
  // n1..n7, b1,b2 or 第1数字..第7数字, BONUS数字1/2
  const get = (...keys) => {
    for(const k of keys){
      if(obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") return String(obj[k]).trim();
    }
    return null;
  };

  const noStr = get("no","開催回","回","draw","draw_no");
  const no = noStr ? Number(noStr) : null;

  const dateStr = get("date","日付");
  // accept YYYY/MM/DD
  let date = null;
  if(dateStr){
    if(/\d{4}-\d{2}-\d{2}/.test(dateStr)) date = dateStr;
    else if(/\d{4}\/\d{1,2}\/\d{1,2}/.test(dateStr)){
      const d = new Date(dateStr.replace(/\//g,"-")+"T00:00:00");
      if(!isNaN(d.getTime())){
        date = d.toISOString().slice(0,10);
      }
    }
  }

  const set = get("set","セット","セット球","setBall","set_ball");
  const setNorm = set && SETS.includes(set.toUpperCase()) ? set.toUpperCase() : null;

  const nums = [];
  for(let i=1;i<=7;i++){
    const v = get(`n${i}`, `第${i}数字`);
    if(v!=null) nums.push(Number(v));
  }
  const bonus = [];
  const b1 = get("b1","BONUS数字1","bonus1");
  const b2 = get("b2","BONUS数字2","bonus2");
  if(b1!=null) bonus.push(Number(b1));
  if(b2!=null) bonus.push(Number(b2));

  return {no, date, set: setNorm, nums, bonus};
}

function importPayload(fileText, fileName){
  let msg = "";
  if(fileName.toLowerCase().endsWith(".json")){
    const payload = safeJsonParse(fileText, null);
    if(!payload){
      $("data-msg").textContent = "JSONの解析に失敗しました。";
      return;
    }
    if(payload.userDraws){
      const current = loadUserDraws();
      const merged = Object.assign({}, current, payload.userDraws);
      saveUserDraws(merged);
      msg += `ユーザーデータ: ${Object.keys(payload.userDraws).length}件を取り込みました。 `;
    }
    if(payload.settings){
      saveSettings(Object.assign({}, DEFAULT_SETTINGS, payload.settings));
      SETTINGS = loadSettings();
      msg += "設定も取り込みました。 ";
    }
    if(Array.isArray(payload.history)){
      saveHistory(payload.history);
      msg += "履歴も取り込みました。 ";
    }
    $("data-msg").textContent = msg || "取り込みました。";
    refreshAll(true);
    return;
  }

  // CSV
  const rows = parseCSV(fileText);
  if(!rows.length){
    $("data-msg").textContent = "CSVが空でした。";
    return;
  }
  let count = 0;
  const userMap = loadUserDraws();
  for(const r of rows){
    const norm = normalizeImportedRow(r);
    if(!norm.no) continue;

    const key = String(norm.no);
    const existing = userMap[key] || {};

    // If only set is present, keep existing nums/bonus from base or existing.
    const patch = { no: norm.no };
    if(norm.date) patch.date = norm.date;
    if(norm.set) patch.set = norm.set;

    if(norm.nums && norm.nums.length === 7){
      patch.nums = norm.nums.map(Number);
    }
    if(norm.bonus && norm.bonus.length === 2){
      patch.bonus = norm.bonus.map(Number);
    }

    userMap[key] = Object.assign({}, existing, patch);
    count += 1;
  }
  saveUserDraws(userMap);
  $("data-msg").textContent = `CSVを取り込みました（反映 ${count}件）。`;
  refreshAll(true);
}

// ===== Settings UI =====
function syncSettingsToUI(settings){
  $("st-sum-min").value = String(settings.sumMin);
  $("st-sum-max").value = String(settings.sumMax);
  $("st-odd-mode").value = settings.oddMode;
  $("st-min-high").value = String(settings.minHigh);
  $("st-overlap-min").value = String(settings.overlapMin);
  $("st-overlap-max").value = String(settings.overlapMax);
  $("st-tertile").checked = !!settings.ensureTertile;
  $("st-close").checked = !!settings.preferClose;

  $("st-w-trans").value = String(settings.wTransition);
  $("st-w-freq").value = String(settings.wFrequency);
  $("st-w-rec").value = String(settings.wRecency);
}

function readSettingsFromUI(){
  const s = Object.assign({}, SETTINGS);
  s.sumMin = Number($("st-sum-min").value) || DEFAULT_SETTINGS.sumMin;
  s.sumMax = Number($("st-sum-max").value) || DEFAULT_SETTINGS.sumMax;
  s.oddMode = $("st-odd-mode").value || DEFAULT_SETTINGS.oddMode;
  s.minHigh = Number($("st-min-high").value) || 0;
  s.overlapMin = Number($("st-overlap-min").value) || 0;
  s.overlapMax = Number($("st-overlap-max").value) || 2;
  s.ensureTertile = $("st-tertile").checked;
  s.preferClose = $("st-close").checked;

  s.wTransition = Number($("st-w-trans").value) || DEFAULT_SETTINGS.wTransition;
  s.wFrequency = Number($("st-w-freq").value) || DEFAULT_SETTINGS.wFrequency;
  s.wRecency = Number($("st-w-rec").value) || DEFAULT_SETTINGS.wRecency;

  // basic sanity
  if(s.sumMax < s.sumMin){
    const tmp = s.sumMin; s.sumMin = s.sumMax; s.sumMax = tmp;
  }
  s.overlapMin = clamp(s.overlapMin, 0, 7);
  s.overlapMax = clamp(s.overlapMax, 0, 7);
  if(s.overlapMax < s.overlapMin){
    const tmp = s.overlapMin; s.overlapMin = s.overlapMax; s.overlapMax = tmp;
  }
  s.minHigh = clamp(s.minHigh, 0, 7);

  return s;
}

// ===== Recommendation history =====
function addHistoryItem(item){
  const hist = loadHistory();
  hist.unshift(item);
  saveHistory(hist.slice(0, SETTINGS.keepHistory));
}

function renderHistory(){
  const hist = loadHistory();
  if(!hist.length){
    $("history-list").textContent = "まだありません。";
    return;
  }
  $("history-list").innerHTML = hist.slice(0,10).map(h=>{
    return `<div class="pills" style="margin:8px 0">
      <span class="pill">${new Date(h.at).toLocaleString()}</span>
      <span class="pill">${h.set ? "セット:"+h.set : "セット:—"}</span>
      <span class="pill">${h.nums.map(pad2).join(" ")}</span>
    </div>`;
  }).join("");
}

// ===== Main refresh =====
let CURRENT_REC = null;
let CURRENT_PRED = null;
let CURRENT_PRED_SET = null;

function generateAndRender(){
  CURRENT_PRED = predictNextSet(STATS, SETTINGS);
  CURRENT_PRED_SET = CURRENT_PRED?.ranked?.[0]?.[0] || null;

  renderSetPrediction(CURRENT_PRED);

  const rec = generateOneLine(STATS, SETTINGS, CURRENT_PRED_SET);
  CURRENT_REC = rec;

  renderRecommendation(rec, CURRENT_PRED_SET);
  renderRecommendationMeta(STATS, SETTINGS);

  addHistoryItem({at: new Date().toISOString(), nums: rec.nums, set: CURRENT_PRED_SET});
}

function refreshAll(regen=false){
  mergeDraws();
  STATS = computeStats(DRAWS);
  renderLatest(STATS);
  renderLearningStatus(STATS);
  renderDrawList(DRAWS);

  setAddDefaults(STATS);

  syncSettingsToUI(SETTINGS);

  if(regen) generateAndRender();
  else if(!CURRENT_REC) generateAndRender();
}

// ===== Event wiring =====
function setupNav(){
  for(const btn of document.querySelectorAll(".nav-btn")){
    btn.addEventListener("click", () => showView(btn.dataset.view));
  }
}

function setupAbout(){
  $("btn-about").addEventListener("click", () => $("dlg-about").showModal());
  $("btn-close-about").addEventListener("click", () => $("dlg-about").close());
}

function setupHistory(){
  $("btn-history").addEventListener("click", () => {
    renderHistory();
    $("dlg-history").showModal();
  });
  $("btn-close-history").addEventListener("click", () => $("dlg-history").close());
}

function setupGenerate(){
  $("btn-generate").addEventListener("click", () => {
    generateAndRender();
  });
}

function setupAdd(){
  $("btn-apply-paste").addEventListener("click", () => {
    const t = $("in-paste").value || "";
    const parsed = parseNumbersFromPaste(t);
    if(!parsed){
      $("add-msg").textContent = "貼り付けから数字を読み取れませんでした。";
      return;
    }
    for(let i=1;i<=7;i++) $("n"+i).value = String(parsed.main[i-1] ?? "");
    for(let i=1;i<=2;i++) $("b"+i).value = String(parsed.bonus[i-1] ?? "");
    if(parsed.no != null) $("in-no").value = String(parsed.no);
    if(parsed.set) $("in-set").value = parsed.set;
    $("add-msg").textContent = "貼り付けを反映しました。";
  });

  $("btn-save").addEventListener("click", () => {
    const f = getAddForm();
    if(!Number.isFinite(f.no) || f.no <= 0){
      $("add-msg").textContent = "開催回を入力してください。";
      return;
    }
    if(!f.date){
      $("add-msg").textContent = "日付を入力してください。";
      return;
    }

    // if numbers are blank, allow set-only update
    let patch = { no: f.no, date: f.date };
    if(f.set) patch.set = f.set;

    if(f.main.length){
      const v = validateLine(f.main, f.bonus);
      if(!v.ok){
        $("add-msg").textContent = v.msg;
        return;
      }
      patch.nums = f.main.map(Number);
      if(f.bonus.length === 2) patch.bonus = f.bonus.map(Number);
    }

    const userMap = loadUserDraws();
    const key = String(f.no);
    userMap[key] = Object.assign({}, userMap[key] || {}, patch);
    saveUserDraws(userMap);

    $("add-msg").textContent = `第${f.no}回 を保存しました。`;
    refreshAll(true);
    showView("home");
  });
}

function setupImportExport(){
  $("btn-export").addEventListener("click", exportJSON);
  $("file-import").addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if(!file) return;
    const text = await file.text();
    importPayload(text, file.name);
    ev.target.value = "";
  });
}

function setupSettings(){
  $("btn-save-settings").addEventListener("click", () => {
    SETTINGS = readSettingsFromUI();
    saveSettings(SETTINGS);
    $("data-msg").textContent = "";
    $("add-msg").textContent = "";
    refreshAll(true);
    showView("home");
  });

  $("btn-reset").addEventListener("click", () => {
    if(!confirm("端末内データ（追加分・設定・履歴）を初期化します。よろしいですか？")) return;
    localStorage.removeItem(LS_USER_DRAWS);
    localStorage.removeItem(LS_SETTINGS);
    localStorage.removeItem(LS_HISTORY);
    SETTINGS = loadSettings();
    CURRENT_REC = null;
    refreshAll(true);
    showView("home");
  });
}

function setupServiceWorker(){
  // serviceWorker disabled (cache issues on iOS)

}

// ===== Boot =====
async function boot(){
  buildNumberInputs();
  setupNav();
  setupAbout();
  setupHistory();
  setupGenerate();
  setupAdd();
  setupImportExport();
  setupSettings();
  setupServiceWorker();

  await loadBase();
  mergeDraws();
  STATS = computeStats(DRAWS);

  // If settings are too old/missing, sync to default
  SETTINGS = loadSettings();

  // Improve defaults dynamically (use percentiles if available)
  if(STATS.sumP25 && STATS.sumP75){
    // keep current if user already customized
    const stored = safeJsonParse(localStorage.getItem(LS_SETTINGS), null);
    if(!stored){
      SETTINGS.sumMin = STATS.sumP25;
      SETTINGS.sumMax = STATS.sumP75;
      saveSettings(SETTINGS);
    }
  }

  refreshAll(true);
}

boot().catch((err)=>{
  console.error(err);
  const detail = (err && err.message) ? err.message : String(err);
  const msg = [
    "初期データの読み込みに失敗しました。",
    "原因の多くは次のどれかです：",
    "1）index.html をローカル（ファイル直開き）で見ている",
    "2）base_draws.json / base_draws.js が同じフォルダに置けていない（404）",
    "3）GitHub Pages ではなく github.com の画面を開いている",
    "4）古いキャッシュ/Service Worker が残っている",
    "—",
    `詳細：`
  ].join("\n");

  const html = msg.replace(/\n/g, "<br/>");
  const ids = ["latest-summary","set-prediction","recommendation","learning-status","draw-list"];
  for(const id of ids){
    const el = document.getElementById(id);
    if(el) el.innerHTML = `<span class="badge">エラー</span><div class="hint" style="margin-top:8px"></div>`;
  }
});
