(() => {
  if (window.__PII_MASK_INITIALIZED__) return; // 多重注入防止
  window.__PII_MASK_INITIALIZED__ = true;

  // 既に拡張コンテキストが失効している場合は中止
  try {
    if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
  } catch(_) { return; }

  // "Extension context invalidated" を抑制（視覚ノイズ削減）
  window.addEventListener('error', ev => {
    if (ev && /Extension context invalidated/i.test(ev.message)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  }, true);

  const baseRegexes = [
    /\b\d{3}-\d{4}\b/g,
    /\b\d{2,4}-\d{2,4}-\d{4}\b/g,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  // GUID/UUID 形式 (hex 8-4-4-4-12)
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g
  ];
  const nameRegexes = [ /\b[a-zA-Z]{2,20}\s+[a-zA-Z]{2,20}\b/g ];

  let maskEnabled = true;
  // 名前マスクは常時有効化（単一トグルに統合）
  const blurred = new Set();
  let observer = null;

  // コンテキスト有効性チェック
  function contextValid(){
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch(_) { return false; }
  }

  // 追加のエラー/Promise抑制
  window.addEventListener('unhandledrejection', ev => {
    const msg = (ev && ev.reason && (ev.reason.message||ev.reason.toString())) || '';
    if (/Extension context invalidated/i.test(msg)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  }, true);

  function activeRegexes(){ return [...baseRegexes, ...nameRegexes]; }
  const EXCLUDE_KEYWORDS = ['power']; // この語を含む場合はマスクしない (case-insensitive)
  const FORCE_KEYWORDS = ['org'];     // この語を含む場合は必ずマスク (case-insensitive)
  // よく使われる日本人の姓（上位例・過剰マスク抑制のため限定）
  const JP_SURNAMES = new Set([
    '佐藤','鈴木','高橋','田中','伊藤','渡辺','山本','中村','小林','加藤','吉田','山田','佐々木','山口','松本','井上','木村','林','斎藤','清水','山崎','阿部','森','池田','橋本','山下','石川','中島','前田','藤田','後藤','小川','岡田','長谷川','村上','近藤','石井','斉藤','坂本','遠藤','青木','藤井','西村','福田','太田','三浦','藤原','岡本','中川','中野','原田','瀬戸','網野','三田','鎌田','大友','河津','竹内','中下','宮崎','原','野口','渋谷','早川','吉永','岡','粟野','柴田','菅原','谷口','川口','松井','大野','小野','杉山','村田','小島','田村','宮本','石田','小松','今井','高木','横山','高田','岩崎','藤本','大塚','松岡','中西','川崎','永井','杉本','大西','平野','大久保','小池','中山','川上','松下','竹田','石原','宮田','福島','秋山','三好','飯田','工藤','西田','菊地','堀内','王'
  ]);
  // 日本人名簡易検出: 姓(上記リスト) + 半角/全角スペース + 名(1-3漢字 or 2-6カナ)
  function containsJapaneseName(text){
    if(!text) return false;
    const STOP_WORDS = ['環境','管理','取引先企業','取引先','企業','設定','情報','登録','利用','確認','発注','受注'];
    for(const w of STOP_WORDS){ if(text.includes(w)) return false; }
    // トークン分解（スペース/改行/全角スペース）
    const rawTokens = text.split(/[\s\u3000]+/).filter(Boolean);
    if(rawTokens.length === 0) return false;
    const cleanse = t => t.replace(/[()（）［］【】:\-‐―・,，、。]/g,'');
    const tokens = rawTokens.map(cleanse).filter(Boolean);
    if(tokens.length === 0) return false;
    const givenRe = /^(?:[\u4E00-\u9FFF]{1,4}|[ァ-ヺー]{1,6}|[ぁ-ゖー]{1,6})$/;
    const katakanaFullRe = /^[ァ-ヺー]{2,5}[\u3000][ァ-ヺー]{2,6}$/; // 単体行での判定用（部分一致は下でペア判定）
    // 1) 連続ペア走査（名 姓 / 姓 名）
    for(let i=0;i<tokens.length-1;i++){
      const a = tokens[i];
      const b = tokens[i+1];
      if(JP_SURNAMES.has(a) && givenRe.test(b)) return true; // 姓 名
      if(JP_SURNAMES.has(b) && givenRe.test(a)) return true; // 名 姓
    }
    // 2) 結合トークン: 姓名 (スペース無し)
    for(const t of tokens){
      if(t.length >= 3 && t.length <= 8){
        for(const sur of JP_SURNAMES){
          if(t.startsWith(sur)){
            const rest = t.slice(sur.length);
            if(givenRe.test(rest)) return true;
          }
        }
      }
    }
    // 3) カタカナ二語（姓リスト外でも）: タナカ タロウ 等（原文全体が2トークンで両方カタカナ）
    if(tokens.length >=2){
      for(let i=0;i<tokens.length-1;i++){
        const a=tokens[i], b=tokens[i+1];
        if(/^[ァ-ヺー]{2,5}$/.test(a) && /^[ァ-ヺー]{2,6}$/.test(b)) return true;
      }
    }
    // 4) 単体がカタカナ二語構造（全体に全角スペースが残っていたケース）
    if(katakanaFullRe.test(text)) return true;
    // 5) 単独ひらがな名 (4-6文字) を許容（汎用語の誤検出を避けるため除外リスト）
    const HIRA_NAME_RE = /^[ぁ-ゖー]{4,6}$/;
    const HIRA_EXCLUDE = ['てすと','てきすと','かいぎ','しょうひ','けいやく','かいしゃ','がいよう','せってい','かんり','じてん','さんしょう'];
    for(const t of tokens){
      if(HIRA_NAME_RE.test(t) && !HIRA_EXCLUDE.includes(t)) return true;
    }
    return false;
  }
  function matchesPII(text){
    if (!text) return false;
    const lower = text.toLowerCase();
    // 除外優先 ("power" が含まれれば即非マスク)
    for (const kw of EXCLUDE_KEYWORDS){ if (lower.includes(kw)) return false; }
    // 日時パターン（全体が典型的な日付/時間フォーマットのみなら除外）
    const DATE_TIME_EXCLUDES = [
      /^\s*\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}\s*$/,                  // 2025-09-10 / 2025/9/1 / 2025.09.10
      /^\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/,                          // 14:05 / 14:05:33
      /^\s*\d{4}年\d{1,2}月\d{1,2}日\s*$/,                        // 2025年9月10日
      /^\s*\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}時\d{1,2}分?(?:\d{1,2}秒)?\s*$/ // 2025年9月10日 14時05分 / 秒付き
    ];
    for(const re of DATE_TIME_EXCLUDES){ if(re.test(text)) return false; }
    // 強制マスクキーワード
    for (const kw of FORCE_KEYWORDS){ if (lower.includes(kw)) return true; }
  // '@' を含む任意のテキストはメール表現とみなし即マスク
  if (text.includes('@')) return true;
    // 日本人名（姓+名）検出
    if (containsJapaneseName(text)) return true;
    // 既存パターン
    for (const r of activeRegexes()){ r.lastIndex = 0; if (r.test(text)) return true; }
    return false;
  }
  function blurElement(el){ if(!el||blurred.has(el)) return; el.dataset._origFilter = el.style.filter||""; el.style.filter='blur(8px)'; blurred.add(el); }
  function maskTree(root){ if(!maskEnabled||!root) return; const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){ const p=n.parentElement; if(!p||blurred.has(p)) continue; if(matchesPII(n.textContent)) blurElement(p);} }
  function unmaskAll(){ blurred.forEach(el=>{ try { if(el&&el.style&&el.style.filter==='blur(8px)') el.style.filter = el.dataset._origFilter||''; if(el&&el.dataset) delete el.dataset._origFilter; } catch(_){} }); blurred.clear(); }
  function applyState(){
    if(!maskEnabled){ unmaskAll(); return; }
    if(!contextValid()) return;
    const b = document.body;
    if(!b){
      if(!window.__PII_MASK_WAITING_BODY){
        window.__PII_MASK_WAITING_BODY = true;
        const waitBody = () => {
          if(!contextValid()) return; // 失効なら諦める
          if(!document.body){ requestAnimationFrame(waitBody); return; }
          window.__PII_MASK_WAITING_BODY = false;
          maskTree(document.body);
        };
        requestAnimationFrame(waitBody);
      }
      return;
    }
    maskTree(b);
  }

  function startObserver(){
    if(observer) observer.disconnect();
    observer = new MutationObserver(muts=>{
      if(!maskEnabled || !contextValid()) { return; }
      try {
        for(const m of muts){
          if(m.type==='childList'){
            m.addedNodes.forEach(node=>{
              if(node.nodeType===Node.TEXT_NODE){ const p=node.parentElement; if(p&&matchesPII(node.textContent)) blurElement(p); }
              else if(node.nodeType===Node.ELEMENT_NODE){ maskTree(node); }
            });
          } else if(m.type==='characterData' && m.target.nodeType===Node.TEXT_NODE){
            const p=m.target.parentElement; if(p&&matchesPII(m.target.textContent)) blurElement(p);
          }
        }
      } catch(e) {
        if(/Extension context invalidated/i.test(e.message||'')) {
          // 即座に監視停止
          try { observer && observer.disconnect(); } catch(_){}
        } else {
          // 他のエラーは再スローせず握りつぶし (安全優先)
        }
      }
    });
    try {
      observer.observe(document.documentElement,{ childList:true, characterData:true, subtree:true });
    } catch(e) {
      // コンテキスト失効直後の observe 呼び出し用
    }
  }

  // rAF で軽量ウォッチし、失効なら静かに停止
  (function watchdog(){
    if(!contextValid()) { try { observer && observer.disconnect(); } catch(_){} return; }
    requestAnimationFrame(watchdog);
  })();

  try {
  chrome.storage.sync.get(['maskEnabled'], data => {
      try {
        if (typeof data.maskEnabled === 'boolean') maskEnabled = data.maskEnabled;
      } catch(_){}
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => applyState());
      } else {
        applyState();
      }
    });
  } catch(_) {
    // storage 未利用環境 (念のため)
    applyState();
  }
  startObserver();

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === 'ping') { sendResponse({ ok:true }); return true; }
  if (msg && msg.action === 'setMaskEnabled') {
      const next = !!msg.enabled;
      if (next !== maskEnabled) {
        maskEnabled = next;
        if (maskEnabled) { applyState(); startObserver(); }
        else { unmaskAll(); if(observer) observer.disconnect(); }
      }
      sendResponse({ ok:true, enabled:maskEnabled });
      return true;
    }
  // setMaskNamesEnabled は廃止（常時有効）
  });
})();