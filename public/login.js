const socket = io();

/* ================================================
   COOKIE FROM SERVER
=================================================== */
socket.on("do_set_cookie", data => {
  document.cookie = `user=${encodeURIComponent(data.user)}; path=/;`;
});

/* ================================================
   KICK / BAN POPUP HANDLING
=================================================== */

document.addEventListener("DOMContentLoaded", () => {
  const raw = sessionStorage.getItem("orbit8_kickban");
  if (!raw) return;

  sessionStorage.removeItem("orbit8_kickban");

  let info;
  try {
    info = JSON.parse(raw);
  } catch (e) {
    return;
  }

  const overlay = document.getElementById("kickban-overlay");
  const titleEl = document.getElementById("kickban-title");
  const msgEl = document.getElementById("kickban-message");
  const durEl = document.getElementById("kickban-duration");
  const closeBtn = document.getElementById("kickban-close");
  const soundEl = document.getElementById("kickban-sound");

  if (!overlay || !titleEl || !msgEl || !durEl || !closeBtn) return;

  // Title
  if (info.type === "ban") {
    titleEl.textContent = "You have been banned";
  } else if (info.type === "kick") {
    titleEl.textContent = "You have been kicked";
  } else {
    titleEl.textContent = "Disconnected";
  }

  // Message
  msgEl.textContent = info.reason || "";

  // Duration
  durEl.textContent = info.durationText
    ? "Duration: " + info.durationText
    : "";

  // Show popup
  overlay.style.display = "flex";

  // Play sound
  if (soundEl) {
    soundEl.currentTime = 0;
    soundEl.play().catch(() => {});
  }

  // Close button
  closeBtn.onclick = () => {
    overlay.style.display = "none";
  };
});

/* ================================================
   TAB SWITCHING
=================================================== */

const tabLogin = document.getElementById("tab-login");
const tabRegister = document.getElementById("tab-register");
const formLogin = document.getElementById("form-login");
const formRegister = document.getElementById("form-register");
const errorBox = document.getElementById("error-box");

tabLogin.onclick = () => switchTab(true);
tabRegister.onclick = () => switchTab(false);

function switchTab(isLogin) {
  tabLogin.classList.toggle("active", isLogin);
  tabRegister.classList.toggle("active", !isLogin);
  formLogin.style.display = isLogin ? "block" : "none";
  formRegister.style.display = isLogin ? "none" : "block";
  hideError();
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.style.display = "block";
}

function hideError() {
  errorBox.style.display = "none";
}

/* ================================================
   LOGIN
=================================================== */
document.getElementById("btn-login").onclick = () => {
  const u = document.getElementById("login-user").value.trim();
  const p = document.getElementById("login-pass").value.trim();
  if (!u || !p) return showError("Fill both fields");

  socket.emit("login", { username: u, password: p }, res => {
    if (!res.ok) return showError(res.error);
    window.location = "/";
  });
};

/* ================================================
   REGISTER
=================================================== */

document.getElementById("btn-register").onclick = () => {
  const u = document.getElementById("reg-user").value.trim();
  const p = document.getElementById("reg-pass").value.trim();
  if (!u || !p) return showError("Fill both fields");

  socket.emit("register", { username: u, password: p }, res => {
    if (!res.ok) return showError(res.error);

    socket.emit("login", { username: u, password: p }, lr => {
      if (!lr.ok) return showError(lr.error);
      window.location = "/";
    });
  });
};
