(() => {
  if(window.__PII_MASK_INITIALIZED__) return;
  window.__PII_MASK_INITIALIZED__ = true;
  try { if(!chrome || !chrome.runtime || !chrome.runtime.id) return; } catch(_) { return; }

    // ---- 設定 ----
  let settings = { at:true, org:true, number:true, name:false };
    let observer = null;
  // 以前は親要素 blur を行っていたが、全項目トークン部分マスク方式に統一したため blurred セットは不要

    // ---- パターン（段階1: email/phone/address/orgPrefix） ----
  const AT_TOKEN_RE = /[^\s@]*@[^\s@]*/g; // @ を含む連続トークン
  const ORG_PREFIX_RE = /\borg[a-zA-Z0-9_-]*/g; // org で始まる英数字列
  // ハイフンを含むケース (例: 03-1234-5678) も対象にするため、数字とハイフンの混在シーケンスを一旦拾い
  // 後段で実際の数字の合計桁数が 8 以上か判定してからマスクする。
  const LONG_NUMBER_CANDIDATE_RE = /\b[0-9][0-9-]{6,}[0-9]\b/g; // 両端が数字で内部に数字/ハイフン

    // ---- 名前（段階2: オプション） ----
  // 旧 SIMPLE_* は quickPossible 用に保持せず、より柔軟なスコアリング方式へ移行
  // 名前候補抽出とスコアリング (軽量ヒューリスティクス)
  const JP_SURNAME_LIST = [
    '佐藤','鈴木','高橋','田中','伊藤','渡辺','山本','中村','小林','加藤','吉田','山田','佐々木','山口','松本','井上','木村','林','斎藤','清水','山崎','阿部','森','池田','橋本','山下','石川','中島','前田','藤田','後藤','小川','岡田','長谷川','村上','近藤','石井','斉藤','坂本','遠藤','青木','藤井','西村','福田','太田','三浦','藤原','岡本','中川','中野','原田','瀬戸','網野','三田','鎌田','大友','河津','竹内','中下','宮崎','原','野口','渋谷','早川','吉永','岡','粟野','柴田','菅原','谷口','川口','松井','大野','小野','杉山','村田','小島','田村','宮本','石田','小松','今井','高木','横山','高田','岩崎','藤本','大塚','松岡','中西','川崎','永井','杉本','大西','平野','大久保','小池','中山','川上','松下','竹田','石原','宮田','福島','秋山','三好','飯田','工藤','西田','菊地','堀内','王'
  ];
  const JP_GIVEN_LIST = [
    '太郎','花子','一郎','健太','結衣','翔太','陽子','直樹','彩乃','拓也','真由','玲奈','大輔','誠','悠真','悠衣','美咲','恵','優','陽菜'
  ];
  const EN_SURNAME_LIST = [
    'Smith','Johnson','Brown','Williams','Jones','Miller','Davis','Wilson','Taylor','Clark','Hall','Allen','Young','King','Wright','Scott','Green','Baker'
  ];
  const EN_GIVEN_LIST = [
    'John','Michael','David','James','Robert','Mary','Patricia','Linda','Barbara','Elizabeth','Jennifer','William','Thomas','Daniel','Paul','Mark','Sarah','Emma','Oliver','Emily'
  ];
  const NAME_STOPWORDS = [
    'The','And','For','With','From','Into','About','After','Before','Since','Group','Company','Service','Project','System','Data','User','Login','Name','Value','Status',
    // 製品名・ブランド (除外)
    'Microsoft','Dynamics','Power','Azure','Office','Teams','Excel','Word',
    // カタカナ一般語 (人名ではない頻出用語) – 単独/複合トークンの過剰マスク抑止
    'ライセンス','ユーザー','ユーザ','セキュリティ','サービス','システム','プロジェクト','データ','ログイン','バリュー','ステータス','グループ','カンパニー','ライブラリ','プラットフォーム','プラグイン','ドメイン'
  ];

  const RE_KANJI_NAME = /[\u4E00-\u9FFF]{1,4}\s?[\u4E00-\u9FFF]{1,4}/g; // 1-4 + optional space + 1-4
  const RE_KATA_NAME  = /[ァ-ヴー]{2,}(?:\s+[ァ-ヴー]{2,})?/g; // カタカナ 2+ (1 or 2語)
  const RE_ROMAN_NAME = /\b[A-Z][a-z]{1,15}(?:\s+[A-Z][a-z]{1,15}){1,2}\b/g; // 2~3 語
  const RE_MIXED_KANJI_HIRA = /[\u4E00-\u9FFF][\u3040-\u309F][\u4E00-\u9FFF\u3040-\u309F]{0,6}/g; // 漢字+ひらがな混在 (例: 高橋たかし)
  const RE_HIRA_NAME = /[\u3040-\u309F]{2,}(?:\s+[\u3040-\u309F]{2,})?/g; // ひらがな 2+ (1~2語)
  // 単独姓/名 専用 (既存パターンでは 2語前提で漏れるケース用) – フィルタ併用
  const RE_KANJI_SINGLE = /[\u4E00-\u9FFF]{1,4}/g; // 辞書照合で限定
  const RE_ROMAN_SINGLE = /\b[A-Z][a-z]{1,15}\b/g; // 辞書照合で限定

  function scoreNameCandidate(text){
    let score = 0;
    if(!text) return 0;
    const hasSpace = /\s/.test(text);
    const tokens = text.trim().split(/\s+/);
    // 判定: 種別
  const norm = text.replace(/\s+/g,' ');
  const isKanji = /^[\u4E00-\u9FFF]+(\s[\u4E00-\u9FFF]+)?$/.test(norm);
  const isKana  = /^[ァ-ヴー]+(\s[ァ-ヴー]+)?$/.test(norm);
  const isRoman = /^[A-Z][a-z]{1,15}(\s[A-Z][a-z]{1,15}){1,2}$/.test(text);
  const isRomanSingle = /^[A-Z][a-z]{1,15}$/.test(norm); // 単独英語名
  const isMixedKanjiHira = /[\u4E00-\u9FFF][\u3040-\u309F]/.test(text) || /[\u3040-\u309F][\u4E00-\u9FFF]/.test(text);
  const isHira  = /^[\u3040-\u309F]+(\s[\u3040-\u309F]+)?$/.test(norm);
  if(isKanji) score += 2; else if(isKana) score += 2; else if(isRoman) score += 2; else if(isMixedKanjiHira) score += 2; else if(isHira) score += 2; else if(isRomanSingle) score += 2; else score -= 1;
    if(hasSpace) score += 1; // 姓名っぽさ
    // 各トークン辞書参照
    for(const tk of tokens){
      const inSurname = JP_SURNAME_LIST.includes(tk) || EN_SURNAME_LIST.includes(tk);
      const inGiven = JP_GIVEN_LIST.includes(tk) || EN_GIVEN_LIST.includes(tk);
      if(inSurname) score += 1;
      if(inGiven) score += 1;
      if(NAME_STOPWORDS.includes(tk)) score -= 2; // ビジネス用語抑止
      if(tokens.length===1 && (inSurname||inGiven)) score += 1; // 単独表示救済 (合計で閾値到達しやすく)
      if(tk.length === 1) score -= 1; // 短すぎ
    }
    // 長さバランス (全体)
    const pure = text.replace(/\s/g,'');
    if(pure.length < 2) score -= 2;
    if(pure.length > 25) score -= 2;
    return score;
  }

  function extractNameCandidates(text){
    const out = [];
    if(!text) return out;
    const pushMatches = (re, extraFilter)=>{
      re.lastIndex = 0; let m; while((m = re.exec(text))){
        const seg = m[0];
        if(extraFilter && !extraFilter(seg)) continue;
        out.push({start:m.index,end:m.index+m[0].length,text:seg});
      }
    };
    pushMatches(RE_KANJI_NAME);
    pushMatches(RE_KATA_NAME);
    pushMatches(RE_ROMAN_NAME);
    pushMatches(RE_MIXED_KANJI_HIRA, seg => seg.length >= 2);
    pushMatches(RE_HIRA_NAME);
    // 単独姓/名 (漢字) – 辞書内のみ
    pushMatches(RE_KANJI_SINGLE, seg => (JP_SURNAME_LIST.includes(seg) || JP_GIVEN_LIST.includes(seg)));
    // 単独英語名 – 辞書内のみ
    pushMatches(RE_ROMAN_SINGLE, seg => (EN_SURNAME_LIST.includes(seg) || EN_GIVEN_LIST.includes(seg)));
    return out;
  }

  // 姓名ペア展開: 片側のみスコア閾値を超えても、もう片側が短い/辞書外だが姓名構造に見える場合に両方をマスク
  function expandNamePairs(text, cands, thresh){
    if(cands.length === 0) return cands;
    const added = [];
    // インデックスマップで O(n^2) を軽減する簡易 (候補数は小さい想定)
    for(let i=0;i<cands.length;i++){
      for(let j=i+1;j<cands.length;j++){
        const a = cands[i], b = cands[j];
        // 非オーバーラップかつ近接 (スペース/全角スペース/改行程度)
        if(a.end <= b.start && b.start - a.end <= 2){
          const middle = text.slice(a.end, b.start);
          if(/^[ \u3000]?$/m.test(middle)){ // 0 or 1 空白/全角空白/改行無し
            const segA = a.text, segB = b.text;
            const scA = scoreNameCandidate(segA), scB = scoreNameCandidate(segB);
            const segWhole = text.slice(a.start, b.end);
            // ひらがな or 混在単語 + 漢字姓など片側が低スコアになりがちなケースを救済
            // 条件: (一方>=閾値) AND (もう一方が長さ>=2 かつ 記号含まない)
            const otherOk = (seg)=>seg.replace(/\s/g,'').length>=2 && !/[0-9@]/.test(seg);
            // 追加緩和: 片側が (thresh-1) かつ もう片側 >= thresh で許容
            if( ((scA >= thresh && otherOk(segB)) || (scB >= thresh && otherOk(segA))) ||
                ((scA >= thresh-1 && scB >= thresh) || (scB >= thresh-1 && scA >= thresh)) ){
              if(!cands.some(c=>c.start===a.start && c.end===b.end) && !added.some(c=>c.start===a.start && c.end===b.end)){
                added.push({start:a.start,end:b.end,text:segWhole});
              }
            }
          }
        }
      }
    }
    return cands.concat(added);
  }

  function isNameLike(text){
    // テキスト全体に候補が1つでもしきい値以上であれば true
    const THRESH = 3; // 調整可能
    // 製品名が含まれていたら即 false
    for(const prod of ['Microsoft','Dynamics','Power','Azure','Office','Teams','Excel','Word']){
      if(text.includes(prod)) return false;
    }
    const cands = extractNameCandidates(text);
    for(const c of cands){ if(scoreNameCandidate(c.text) >= THRESH) return true; }
    return false;
  }

    // ---- 高速化用クイックフィルタ ----
    function quickPossible(text){
      // ほぼヒットし得ない短い文字列は棄却
      if(text.length < 4) return false;
      // マスク済み断片を含むノードは無視
      if(text.indexOf('__pii_inline_mask') !== -1) return false;
      const lower = text.toLowerCase();
      if(settings.at && text.indexOf('@') !== -1) return true;
      if(settings.org && lower.indexOf('org') !== -1) return true;
      if(settings.number){
        // 数字カウントを 6 以上見つけたら早期 true (閾値引き下げ)
        let digits=0; for(let i=0;i<text.length;i++){ const c=text.charCodeAt(i); if(c>=48 && c<=57){ if(++digits>=6) return true; } }
        if(digits>=4 && text.indexOf('-')!==-1) return true; // ハイフン混在の緩和条件
      }
      if(settings.name){
        // 簡易: 漢字2つ以上 or 英語名パターン
        if(/[\u4E00-\u9FFF].*[\u4E00-\u9FFF]/.test(text)) return true;
        if(/[A-Z][a-z]{1,15}\s+[A-Z][a-z]{1,15}/.test(text)) return true;
      }
      return false;
    }

    function unmaskAll(){
      document.querySelectorAll('span.__pii_inline_mask').forEach(sp=>{ const t=sp.dataset.origText ? sp.dataset.origText : sp.textContent; const parent=sp.parentNode; if(parent) parent.replaceChild(document.createTextNode(t), sp); });
    }

    // ---- 安全なテキストノード置換ユーティリティ ----
    function safeReplaceTextNode(textNode, frag){
      if(!textNode || !frag) return;
      const parent = textNode.parentNode;
      if(!parent) return;
      if(!textNode.isConnected || (parent.nodeType!==1 && parent.nodeType!==9)) return;
      try {
        parent.insertBefore(frag, textNode);
        parent.removeChild(textNode);
      } catch(e){
        if(!window.__PII_MASK_SAFE_REPLACE_LOGGED__){
          window.__PII_MASK_SAFE_REPLACE_LOGGED__ = true;
          console.debug('[pii-mask] safeReplaceTextNode race (skip once)', e);
        }
      }
    }

    function collectMaskRanges(txt){
      const ranges = [];
      if(!txt) return ranges;
      if(settings.at){ AT_TOKEN_RE.lastIndex=0; let m; while((m=AT_TOKEN_RE.exec(txt))){ ranges.push({start:m.index,end:m.index+m[0].length,cats:new Set(['at'])}); } }
      if(settings.org){ ORG_PREFIX_RE.lastIndex=0; let m; while((m=ORG_PREFIX_RE.exec(txt))){ ranges.push({start:m.index,end:m.index+m[0].length,cats:new Set(['org'])}); } }
      if(settings.number){
        LONG_NUMBER_CANDIDATE_RE.lastIndex=0; let m; while((m=LONG_NUMBER_CANDIDATE_RE.exec(txt))){
          const digits = m[0].replace(/-/g,'');
          if(digits.length >= 6){ ranges.push({start:m.index,end:m.index+m[0].length,cats:new Set(['number'])}); }
        }
      }
      if(settings.name){
        const THRESH = 3;
        let cands = extractNameCandidates(txt);
        cands = expandNamePairs(txt, cands, THRESH);
        for(const c of cands){
          const sc = scoreNameCandidate(c.text);
          if(sc >= THRESH){
            ranges.push({start:c.start,end:c.end,cats:new Set(['name'])});
          }
        }
      }
      return ranges;
    }

    function wrapTokensUnion(textNode, preCollected){
      const txt = textNode.textContent||''; if(!txt) return;
      let ranges = preCollected || collectMaskRanges(txt);
      if(!ranges.length) return; 
      ranges.sort((a,b)=>a.start-b.start||a.end-b.end);
      const merged=[]; 
      for(const r of ranges){
        const last=merged[merged.length-1];
        if(!last||r.start>last.end){ merged.push({start:r.start,end:r.end,cats:new Set(r.cats)}); }
        else {
          if(r.end>last.end) last.end=r.end;
          r.cats.forEach(c=>last.cats.add(c));
        }
      }
      const frag = document.createDocumentFragment(); let cursor=0; 
      for(const r of merged){
        if(r.start>cursor) frag.appendChild(document.createTextNode(txt.slice(cursor,r.start)));
        const span=document.createElement('span');
        span.className='__pii_inline_mask';
        span.style.filter='blur(8px)';
        span.textContent=txt.slice(r.start,r.end);
        span.dataset.piiCats = Array.from(r.cats).join(',');
        applyForcedColorsToSpan(span);
        frag.appendChild(span); cursor=r.end; 
      }
      if(cursor<txt.length) frag.appendChild(document.createTextNode(txt.slice(cursor)));
      // 置換タイミングでフレームワーク (React / MS Dynamics 内部更新) が同一テキストノードを再構築すると
      // NotFoundError: The node to be replaced is not a child of this node が発生する事があるため安全化
      safeReplaceTextNode(textNode, frag);
    }

    function processNodeText(n){
      if(!n || n.nodeType!==Node.TEXT_NODE) return;
  const p = n.parentElement; if(!p) return; if(p.classList && p.classList.contains('__pii_inline_mask')) return;
  // 編集可能領域は除外 (contentEditable, role=textbox, input/textarea 内テキストノード)
  if(p.isContentEditable) return;
  const role = p.getAttribute && p.getAttribute('role'); if(role && role.toLowerCase()==='textbox') return;
  if(p.tagName==='INPUT' || p.tagName==='TEXTAREA') return;
      const txt = n.textContent||''; if(!txt) return;
      if(!quickPossible(txt)) return; // 早期棄却
      const ranges = collectMaskRanges(txt); if(!ranges.length) return;
      wrapTokensUnion(n, ranges);
    }


    // 動的挿入後に取りこぼしを再検査する軽量再スキャン（差分補足）
    let rescanTimer = null;
    function scheduleLightRescan(){
      if(rescanTimer) return;
      // 体感速度向上のため 40ms に短縮
      rescanTimer = setTimeout(()=>{
        rescanTimer = null;
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node; while((node = w.nextNode())){ processNodeText(node); }
      }, 40);
    }

    function scan(root){
  if(!root) return;
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node; while((node = w.nextNode())){ processNodeText(node); }
      // フォーム要素処理は不要化（ユーザー要望により削除）
    }

    let prevSettings = {...settings};

    function removeCategory(cat){
      document.querySelectorAll('span.__pii_inline_mask').forEach(sp=>{
        const catsStr = sp.dataset.piiCats||'';
        if(!catsStr) return; // 旧バージョン互換
        const cats = new Set(catsStr.split(',').filter(Boolean));
        if(!cats.has(cat)) return;
        cats.delete(cat);
        if(cats.size===0){
          // unwrap
            const t=sp.dataset.origText ? sp.dataset.origText : sp.textContent; const parent=sp.parentNode; if(parent) parent.replaceChild(document.createTextNode(t), sp);
        } else {
          sp.dataset.piiCats = Array.from(cats).join(',');
        }
      });
    }

    function applyFull(){
      if(!settings.at && !settings.org && !settings.number && !settings.name){ unmaskAll(); return; }
      startVisualBatch();
      unmaskAll();
      // 既存 scan は上から順に処理するが、非表示中に行うことでユーザーには一括適用に見える
      scan(document.body);
      endVisualBatch();
    }

    function applyIncremental(){
      // 全カテゴリ OFF になった場合のみ全解除
      if(!settings.at && !settings.org && !settings.number && !settings.name){
        unmaskAll(); prevSettings = {...settings}; return;
      }
      const cats = ['at','org','number','name'];
      const removed = cats.filter(c=>prevSettings[c] && !settings[c]);
      const added = cats.filter(c=>!prevSettings[c] && settings[c]);
      if(removed.length && !added.length){
        // 選択的解除
        removed.forEach(removeCategory);
        prevSettings = {...settings};
        return;
      }
      if(!removed.length && added.length){
        // 差分追加のみ: 既存マスク保持しつつ新カテゴリだけ適用
        added.forEach(cat=> addCategory(cat));
        prevSettings = {...settings};
        return;
      }
      if(removed.length && added.length){
        // 両方同時: 先に除去→追加 (単純化)
        removed.forEach(removeCategory);
        added.forEach(cat=> addCategory(cat));
        prevSettings = {...settings};
        return;
      }
      // 変更なし
      prevSettings = {...settings};
    }

    function apply(){ applyIncremental(); }

    function startObserver(){
      if(observer) observer.disconnect();
      observer = new MutationObserver(muts=>{
  if(!settings.at && !settings.org && !settings.number && !settings.name) return;
        for(const m of muts){
          if(m.type==='childList'){
            m.addedNodes.forEach(nd=>{
              if(nd.nodeType===Node.TEXT_NODE) { processNodeText(nd); }
              else if(nd.nodeType===Node.ELEMENT_NODE) { scan(nd); }
            });
            scheduleLightRescan();
          } else if(m.type==='characterData' && m.target.nodeType===Node.TEXT_NODE){ processNodeText(m.target); }
        }
      });
      try { observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true}); } catch(_){ }
    }

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
      if(msg && msg.action==='ping'){ sendResponse({ok:true}); return true; }
      if(msg && msg.action==='setMaskSettings'){
        // 新キー名に合わせてマージ
        settings = Object.assign(settings, msg.settings||{});
        apply();
        startObserver();
        sendResponse({ok:true}); return true;
      }
    });

    chrome.storage.sync.get(['maskSettingsV2','maskSettings'], data => {
      if(data && data.maskSettingsV2){
        settings = Object.assign(settings, data.maskSettingsV2);
      } else if(data && data.maskSettings){
        // 旧設定移行
        const old = data.maskSettings;
        settings.at = !!old.email;
        settings.org = !!old.orgPrefix;
        settings.number = !!old.phone; // phone を数字列へ
        settings.name = !!old.name;
      }
      if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', ()=>{ applyFull(); prevSettings={...settings}; startObserver(); });
      else { applyFull(); prevSettings={...settings}; startObserver(); }
    });

    // ---- 追加カテゴリ差分適用 ----
    function addCategory(cat){
      // 既存 span でテキストが該当するならカテゴリ付与
      document.querySelectorAll('span.__pii_inline_mask').forEach(sp=>{
        const catsStr = sp.dataset.piiCats||'';
        const set = new Set(catsStr.split(',').filter(Boolean));
        if(set.has(cat)) return;
        if(matchCatText(cat, sp.textContent||'')){
          set.add(cat);
          sp.dataset.piiCats = Array.from(set).join(',');
        }
      });
      // 未マスクテキストノードを走査し新カテゴリだけラップ
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node; while((node = w.nextNode())){
        if(!node.parentNode || (node.parentElement && node.parentElement.classList.contains('__pii_inline_mask'))) continue;
        const txt = node.textContent||''; if(!txt) continue;
        const matches = getMatchesForCat(cat, txt); if(!matches.length) continue;
        // wrap (単一カテゴリ用)
        let cursor=0; const frag=document.createDocumentFragment();
        matches.sort((a,b)=>a.start-b.start);
        for(const m of mergeSimple(matches)){
          if(m.start>cursor) frag.appendChild(document.createTextNode(txt.slice(cursor,m.start)));
          const span=document.createElement('span');
          span.className='__pii_inline_mask'; span.style.filter='blur(8px)';
          span.dataset.piiCats = cat; span.textContent = txt.slice(m.start,m.end);
          applyForcedColorsToSpan(span);
          frag.appendChild(span); cursor=m.end;
        }
        if(cursor<txt.length) frag.appendChild(document.createTextNode(txt.slice(cursor)));
        // 同様にフレームワーク側で並行変更される可能性があるため安全化
        safeReplaceTextNode(node, frag);
      }
    }

    function mergeSimple(ranges){
      if(!ranges.length) return []; ranges.sort((a,b)=>a.start-b.start||a.end-b.end);
      const out=[{start:ranges[0].start,end:ranges[0].end}];
      for(let i=1;i<ranges.length;i++){
        const last=out[out.length-1], r=ranges[i];
        if(r.start>last.end) out.push({start:r.start,end:r.end}); else if(r.end>last.end) last.end=r.end;
      }
      return out;
    }

    function getMatchesForCat(cat, text){
      const res=[]; if(!text) return res;
      switch(cat){
        case 'at':
          AT_TOKEN_RE.lastIndex=0; let ma; while((ma=AT_TOKEN_RE.exec(text))){ res.push({start:ma.index,end:ma.index+ma[0].length}); }
          break;
        case 'org':
          ORG_PREFIX_RE.lastIndex=0; let mo; while((mo=ORG_PREFIX_RE.exec(text))){ res.push({start:mo.index,end:mo.index+mo[0].length}); }
          break;
        case 'number':
          LONG_NUMBER_CANDIDATE_RE.lastIndex=0; let mn; while((mn=LONG_NUMBER_CANDIDATE_RE.exec(text))){ const digits=mn[0].replace(/-/g,''); if(digits.length>=6) res.push({start:mn.index,end:mn.index+mn[0].length}); }
          break;
        case 'name':
          const THRESH = 3; let cands = extractNameCandidates(text); cands = expandNamePairs(text, cands, THRESH);
          for(const c of cands){ if(scoreNameCandidate(c.text) >= THRESH) res.push({start:c.start,end:c.end}); }
          break;
      }
      return res;
    }

    function matchCatText(cat, text){
      if(!text) return false;
      switch(cat){
        case 'at': return /@/.test(text); // 既に部分トークン化済みなので簡略
        case 'org': return /^org[a-zA-Z0-9_-]*/.test(text);
  case 'number': return /[0-9].*[0-9]/.test(text) && text.replace(/-/g,'').length>=6; // ざっくり
        case 'name': return isNameLike(text);
      }
      return false;
    }

    // ---- 一括表示用バッチ処理 ----
    let batching = false;
    function ensureBatchStyle(){
      if(document.getElementById('__pii_batch_style')) return;
      const s=document.createElement('style');
      s.id='__pii_batch_style';
      s.textContent='html.__pii-batch-mask,html.__pii-batch-mask body{visibility:hidden !important;}';
      document.documentElement.appendChild(s);
    }
    function startVisualBatch(){
      if(batching) return; batching = true; ensureBatchStyle();
      document.documentElement.classList.add('__pii-batch-mask');
    }
    function endVisualBatch(){
      // 次のフレームで表示（scan による DOM 変更完了後）
      requestAnimationFrame(()=>{
        document.documentElement.classList.remove('__pii-batch-mask');
        batching = false;
      });
    }

      // ---- Forced Colors Mode (High Contrast) 対応 (Option B) ----
      const forcedMql = window.matchMedia ? window.matchMedia('(forced-colors: active)') : null;
      function isForcedColors(){ return !!(forcedMql && forcedMql.matches); }

      function applyForcedColorsToSpan(span){
        if(!span) return;
        if(!isForcedColors()){
          // 復元: blur を戻し伏字解除
          if(span.dataset.origText){
            span.textContent = span.dataset.origText;
            delete span.dataset.origText;
          }
          span.style.filter = 'blur(8px)';
          return;
        }
        // 強制カラー時: 伏字化 (長さに応じて丸め)
        if(!span.dataset.origText){ span.dataset.origText = span.textContent; }
        const orig = span.dataset.origText || '';
        const maskedLen = Math.min(orig.length, 8);
        span.textContent = '■'.repeat(maskedLen);
        span.style.filter = 'none';
      }

      function reapplyForcedColorsAll(){
        document.querySelectorAll('span.__pii_inline_mask').forEach(applyForcedColorsToSpan);
      }
      if(forcedMql){
        try { forcedMql.addEventListener('change', ()=>{ reapplyForcedColorsAll(); }); } catch(_){
          // Safari 古い実装 fallback
          forcedMql.addListener && forcedMql.addListener(()=>{ reapplyForcedColorsAll(); });
        }
        // 初期適用
        reapplyForcedColorsAll();
      }
})();