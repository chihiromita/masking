const toggle = document.getElementById('maskToggle');
const statusEl = document.getElementById('status');

function setStatus(text) { statusEl.textContent = text; }

function withActiveTab(cb){
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs || !tabs.length) { setStatus('タブ取得不可'); return; }
    cb(tabs[0]);
  });
}
function labelStatus(){ return toggle.checked ? 'マスク:ON (個人情報+名前)' : 'マスク:OFF'; }

function sendState(tab){
  const enabled = toggle.checked;
  chrome.tabs.sendMessage(tab.id, { action: 'ping' }, (res) => {
    const injectAndSend = () => {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }, () => {
        if (chrome.runtime.lastError) { setStatus('注入失敗: ' + chrome.runtime.lastError.message); return; }
        dispatch();
      });
    };
    const dispatch = () => {
      chrome.tabs.sendMessage(tab.id, { action: 'setMaskEnabled', enabled }, handleResponse);
    };
    if (chrome.runtime.lastError || !res) {
      injectAndSend();
    } else {
      dispatch();
    }
  });
}

function handleResponse(resp){
  if (chrome.runtime.lastError) {
    setStatus('送信失敗: ' + chrome.runtime.lastError.message);
    return;
  }
  setStatus(labelStatus());
}

chrome.storage.sync.get(['maskEnabled'], data => {
  toggle.checked = data.maskEnabled !== false; // 未設定なら有効
  setStatus(labelStatus());
  withActiveTab(tab => sendState(tab));
});

toggle.addEventListener('change', () => {
  chrome.storage.sync.set({ maskEnabled: toggle.checked }, () => {
    setStatus(labelStatus());
    withActiveTab(tab => sendState(tab));
  });
});