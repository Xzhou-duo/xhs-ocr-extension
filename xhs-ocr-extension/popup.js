// popup.js

const apiKeyInput = document.getElementById("apiKey");
const secretKeyInput = document.getElementById("secretKey");
const saveBtn = document.getElementById("saveBtn");
const toast = document.getElementById("toast");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");

// 加载已保存的设置
chrome.storage.local.get(["baiduApiKey", "baiduSecretKey"], (data) => {
  if (data.baiduApiKey) {
    apiKeyInput.value = data.baiduApiKey;
  }
  if (data.baiduSecretKey) {
    secretKeyInput.value = data.baiduSecretKey;
  }
  updateStatus(!!data.baiduApiKey && !!data.baiduSecretKey);
});

function updateStatus(configured) {
  if (configured) {
    statusDot.classList.add("active");
    statusText.textContent = "已配置 · 可正常使用";
  } else {
    statusDot.classList.remove("active");
    statusText.textContent = "未配置 · 请填写 API Key";
  }
}

saveBtn.addEventListener("click", () => {
  const apiKey = apiKeyInput.value.trim();
  const secretKey = secretKeyInput.value.trim();

  if (!apiKey || !secretKey) {
    apiKeyInput.style.borderColor = !apiKey ? "#ff2442" : "";
    secretKeyInput.style.borderColor = !secretKey ? "#ff2442" : "";
    return;
  }

  apiKeyInput.style.borderColor = "";
  secretKeyInput.style.borderColor = "";

  chrome.storage.local.get(["baiduApiKey", "baiduSecretKey"], (current) => {
    const credentialsChanged =
      current.baiduApiKey !== apiKey || current.baiduSecretKey !== secretKey;
    const changes = { baiduApiKey: apiKey, baiduSecretKey: secretKey };
    if (credentialsChanged) changes.baiduTokenCache = null;

    chrome.storage.local.set(changes, () => {
      updateStatus(true);
      toast.classList.add("show");
      saveBtn.textContent = "已保存 ✓";
      setTimeout(() => {
        toast.classList.remove("show");
        saveBtn.textContent = "保存设置";
      }, 2500);
    });
  });
});

// 输入时清除错误状态
apiKeyInput.addEventListener("input", () => {
  apiKeyInput.style.borderColor = "";
});
secretKeyInput.addEventListener("input", () => {
  secretKeyInput.style.borderColor = "";
});
