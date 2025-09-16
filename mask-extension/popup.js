const statusEl = document.getElementById('status');
const form = document.getElementById('maskForm');

// 両対応: 旧ID(maskAt 等) と 新ID(Email 等) のどちらでも動作
function pick(...ids){ for(const id of ids){ const el = document.getElementById(id); if(el) return el; } return null; }

const els = {
  at: pick('maskAt','Email'),
  // 統合: UrlId チェックは org + number (URL/ID/数列) をまとめて ON/OFF
  urlId: pick('maskUrlId','UrlId'),
  name: pick('maskName','Name')
};

// 存在しない要素がある場合は後続で null ガード

function setStatus(msg){ statusEl.textContent = msg; }

function withActiveTab(cb){
	chrome.tabs.query({active:true,currentWindow:true}, tabs => {
		if(tabs && tabs[0]) cb(tabs[0]); else setStatus('タブ取得失敗');
	});
}

function currentSettings(){
  const at = !!(els.at && els.at.checked);
  const urlId = !!(els.urlId && els.urlId.checked);
  const name = !!(els.name && els.name.checked);
  // 後方互換: 背後では org/number 両方に同じ値を渡す
  return { at, org: urlId, number: urlId, name };
}

function labelStatus(){
	const s = currentSettings();
	const merged = s.org || s.number; // 同値のはず
	const active = [s.at && '@', merged && 'URL/ID', s.name && '名前'].filter(Boolean);
	return active.length ? 'ON: ' + active.join(', ') : '全てOFF';
}

function sendSettings(tab){
	const payload = { action:'setMaskSettings', settings: currentSettings() };
	chrome.tabs.sendMessage(tab.id, { action:'ping' }, (res) => {
		const injectAndSend = () => {
			chrome.scripting.executeScript({ target:{ tabId:tab.id }, files:['content.js'] }, () => {
				if(chrome.runtime.lastError){ setStatus('注入失敗: '+chrome.runtime.lastError.message); return; }
				dispatch();
			});
		};
		const dispatch = () => { chrome.tabs.sendMessage(tab.id, payload, resp => { if(resp&&resp.ok) setStatus(labelStatus()); else setStatus('通信失敗'); });};
		if(chrome.runtime.lastError || !res){ injectAndSend(); } else { dispatch(); }
	});
}

function persist(){ chrome.storage.sync.set({ maskSettingsV2: currentSettings() }); }

// 既存要素にだけリスナー追加
Object.values(els).forEach(el => {
	if(!el) return;
	el.addEventListener('change', () => {
		persist();
		setStatus(labelStatus());
		withActiveTab(tab => sendSettings(tab));
	});
});

chrome.storage.sync.get(['maskSettingsV2','maskSettings'], data => {
	// 旧設定からの移行（最初だけ）
	let base = { at:true, org:true, number:true, name:false };
	if(data.maskSettingsV2){
		base = Object.assign(base, data.maskSettingsV2);
	} else if(data.maskSettings){
		const old = data.maskSettings;
		base.at = !!old.email; // 旧 email → at
		base.org = !!old.orgPrefix; // 旧 orgPrefix → org
		// 数字列は旧 phone を流用（address は無視）
		base.number = !!old.phone;
		base.name = !!old.name;
		chrome.storage.sync.set({ maskSettingsV2: base });
	}
		if(els.at) els.at.checked = base.at;
		if(els.urlId) els.urlId.checked = (base.org || base.number);
		if(els.name) els.name.checked = base.name;
	setStatus(labelStatus());
	withActiveTab(tab=> sendSettings(tab));
});