const btn = document.getElementById("connectBtn");
const done = document.getElementById("done");
const openApp = document.getElementById("openApp");
const status = document.getElementById("connectStatus");

chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
  if (res && res.connected) {
    btn.style.display = "none";
    done.style.display = "block";
    if (res.selectedCount) openApp.textContent = "Open Catch Up";
  }
});

btn.addEventListener("click", () => {
  if (btn.disabled) return;
  status.textContent = "";
  btn.disabled = true;
  btn.textContent = "Opening Twitch login...";
  chrome.runtime.sendMessage({ type: "LOGIN" }, (res) => {
    if (res && res.ok) {
      btn.style.display = "none";
      done.style.display = "block";
    } else {
      btn.disabled = false;
      btn.textContent = "Connect Twitch";
      status.textContent = "Couldn't connect: " + (res && res.error ? res.error : "unknown error") + ". Please try again.";
    }
  });
});
