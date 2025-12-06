/***********************************************
 * CLIENT.JS — LOBBY CONTROLLER
 ***********************************************/

const socket = io();

/* WEB AUDIO BEEP (Firefox-friendly) */
let audioCtx = null;
let audioReady = false;

function initAudioContextOnce() {
  if (audioReady) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    audioCtx = new AC();
    audioCtx.resume().then(() => {
      audioReady = true;
      console.log("Chat beep audio ready");
    }).catch(err => {
      console.warn("AudioContext resume failed:", err);
    });
  } catch (e) {
    console.warn("AudioContext init failed:", e);
  }
}

// Unlock audio on first user interaction
window.addEventListener("click", initAudioContextOnce, { once: true });
window.addEventListener("keydown", initAudioContextOnce, { once: true });

function playChatBeep() {
  if (!audioReady || !audioCtx) return;

  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.value = 1200; // pitch of the beep

  const now = audioCtx.currentTime;

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.25, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start(now);
  osc.stop(now + 0.2);
}

/****************************************************
 * ADMIN DISCONNECT (KICK / BAN)
 ****************************************************/
socket.on("admin_disconnect", info => {
  try {
    sessionStorage.setItem("orbit8_kickban", JSON.stringify(info));
  } catch (e) {
    // ignore
  }
  window.location = "/login.html";
});

/* DOM ELEMENTS */
const elPlayers   = document.getElementById("players");
const elGames     = document.getElementById("games");
const elChat      = document.getElementById("chat");
const elChatInput = document.getElementById("chat-input");
const elChatSend  = document.getElementById("chat-send");
const elLogout    = document.getElementById("logout-btn");

/* MODALS */
const infoModal     = document.getElementById("infoModal");
const infoContent   = document.getElementById("infoContent");
const adminModal    = document.getElementById("adminModal");
const inviteModal   = document.getElementById("inviteModal");
const inviteAccept  = document.getElementById("inviteAccept");
const inviteText    = document.getElementById("inviteText");
const profileModal  = document.getElementById("profileModal");
const passwordModal = document.getElementById("passwordModal");

let USER = null;
let ROLE = null;

/****************************************************
 * AUTH CHECK
 ****************************************************/
socket.emit("auth_check", {}, res => {
  if (!res || !res.ok) {
    window.location = "/login.html";
    return;
  }
  USER = res.user;
  ROLE = res.role;

  const uh = document.getElementById("user-header");
  if (uh) {
    uh.innerHTML = `
      <div class="user-menu">
        <span id="user-menu-label" class="user-menu-label">
          ${USER} <span class="user-role">(${ROLE})</span> ▾
        </span>

        <div id="user-menu-dropdown" class="user-menu-dropdown">
          <button type="button" onclick="openProfileModal()">Edit Profile</button>
          <button type="button" onclick="openPasswordModal()">Change Password</button>

          <div class="menu-separator"></div>

          <button type="button" onclick="logoutFromDropdown()" class="logout-btn">
            Logout
          </button>
        </div>
      </div>
    `;

    const label    = document.getElementById("user-menu-label");
    const dropdown = document.getElementById("user-menu-dropdown");

    if (label && dropdown) {
      label.addEventListener("click", e => {
        e.stopPropagation();
        dropdown.classList.toggle("open");
      });

      document.addEventListener("click", () => {
        dropdown.classList.remove("open");
      });
    }
  }
});

/****************************************************
 * LOGOUT (old button – safe if present)
 ****************************************************/
if (elLogout) {
  elLogout.addEventListener("click", () => {
    document.cookie = "user=; Max-Age=0; path=/";

    socket.emit("logout", {}, () => {
      window.location = "/login.html";
    });

    setTimeout(() => {
      window.location = "/login.html";
    }, 500);
  });
}

/****************************************************
 * PLAYER LIST
 ****************************************************/
socket.on("players", list => {
  elPlayers.innerHTML = "";

  list.forEach(p => {
    const roleClass =
      p.role === "admin" ? "p-admin" :
      p.role === "moderator" ? "p-mod" : "p-player";

    const adminIcon =
      p.role === "admin"
        ? `<img src="images/adpip.png" class="admin-icon" alt="admin">`
        : "";

    // NEW: avatar coming from server payload
    const avatarSrc  = p.profilePic || "avatars/default.png";
    const avatarHTML = `<img src="${avatarSrc}" class="player-avatar" alt="">`;

    const div = document.createElement("div");
    div.className = "player-entry";

    div.innerHTML = `
      <div class="player-name ${roleClass}">
        ${avatarHTML}${adminIcon}${p.username}
      </div>
      <div class="player-buttons">
        <button class="small-btn" onclick="openInfo('${p.username}')">Info</button>
        <button class="small-btn" onclick="inviteUser('${p.username}')">Invite</button>
        ${
          ROLE === "admin" || ROLE === "moderator"
            ? `<button class="small-btn" onclick="openAdmin('${p.username}')">Admin</button>`
            : ""
        }
      </div>
    `;

    elPlayers.appendChild(div);
  });
});

/****************************************************
 * ACTIVE GAMES LIST — CARD VIEW
 ****************************************************/
socket.on("games", list => {
  elGames.innerHTML = "";

  // New Game card
  const newGameCard = document.createElement("div");
  newGameCard.className = "game-card new-game-card";
  newGameCard.onclick = () => socket.emit("create_game");
  newGameCard.innerHTML = `
    <div style="display:flex; align-items:center;">
      <div class="game-icon"></div>
      <div class="game-info">
        <div class="game-players" style="color:#00FF00;">+ New Game</div>
        <div class="game-meta">Create a new 8-ball match</div>
      </div>
    </div>
  `;
  elGames.appendChild(newGameCard);

  // Existing games
  list.forEach(g => {
    const div = document.createElement("div");
    div.className = "game-card";

    const p1 = g.p1 || "Waiting";
    const p2 = g.p2 || "Waiting";

    div.innerHTML = `
      <div style="display:flex; align-items:center;">
        <div class="game-icon"></div>
        <div class="game-info">
          <div class="game-players">${p1} vs ${p2}</div>
          <div class="game-meta">8-Ball · Live match</div>
        </div>
      </div>
      <div class="game-actions">
        <button class="small-btn" onclick="spectate('${g.id}')">Spectate</button>
      </div>
    `;

    elGames.appendChild(div);
  });
});

/****************************************************
 * CHAT
 ****************************************************/
elChatSend.onclick = sendChat;
elChatInput.onkeypress = e => { if (e.key === "Enter") sendChat(); };

function sendChat() {
  const msg = elChatInput.value.trim();
  if (!msg) return;
  socket.emit("chat", msg);
  elChatInput.value = "";
}

/****************************************************
 * CHAT CLEARED (UI WIPE)
 ****************************************************/
socket.on("chat_cleared", () => {
  elChat.innerHTML = ""; // wipe chat window completely
});

/****************************************************
 * DELETE USER MESSAGES (FILTER UI)
 ****************************************************/
socket.on("chat_filter", data => {
  const { user } = data;
  const lines = [...document.querySelectorAll(".chat-line")];

  lines.forEach(line => {
    if (line.textContent.startsWith(user + ":"))
      line.remove();

    if (line.textContent.startsWith("★ " + user + ":"))
      line.remove();
  });
});

/****************************************************
 * CHAT RECEIVE + BEEP
 ****************************************************/
socket.on("chat", packet => {
  const div = document.createElement("div");
  div.className = "chat-line";

  let cls;
  if (packet.role === "admin") cls = "chat-admin";
  else if (packet.role === "moderator") cls = "chat-mod";
  else if (packet.role === "system") cls = "chat-system";
  else cls = "chat-player";

  const adminIcon =
    packet.role === "admin"
      ? `<img src="images/adpip.png" class="admin-icon" alt="admin"> `
      : "";

  const name =
    packet.role === "system" ? "" : `${adminIcon}${packet.user}: `;

  div.innerHTML = `<span class="${cls}">${name}</span>${packet.msg}`;

  elChat.appendChild(div);
  elChat.scrollTop = elChat.scrollHeight;

  // Beep for incoming non-system messages from other users
  if (
    packet.role !== "system" &&
    packet.user !== USER
  ) {
    playChatBeep();
  }
});

/****************************************************
 * INFO MODAL
 ****************************************************/
function openInfo(username) {
  socket.emit("get_info", username, data => {
    let html = `
      <div><b>Username:</b> ${data.username}</div>
      <div><b>Role:</b> ${data.role}</div>
    `;

    if (data.realName) {
      html += `<div><b>Name:</b> ${data.realName}</div>`;
    }
    if (data.country) {
      html += `<div><b>Country:</b> ${data.country}</div>`;
    }
    if (data.age) {
      html += `<div><b>Age:</b> ${data.age}</div>`;
    }

    html += `
      <div style="margin-top:6px;"><b>Games Played:</b> ${data.gamesPlayed}</div>
      <div><b>Games Won:</b> ${data.gamesWon}</div>
      <div><b>Win %:</b> ${data.winPercent}%</div>
    `;

    infoContent.innerHTML = html;
    infoModal.style.display = "flex";
  });
}

function closeInfo() {
  infoModal.style.display = "none";
}

/****************************************************
 * PROFILE MODAL
 ****************************************************/
function openProfileModal() {
  if (!USER) return;
  socket.emit("get_info", USER, data => {
    document.getElementById("profileRealName").value = data.realName || "";
    document.getElementById("profileCountry").value = data.country || "";
    document.getElementById("profileAge").value =
      data.age ? String(data.age) : "";

    // NEW: avatar fields
    const avatarInput   = document.getElementById("profileAvatar");
    const avatarPreview = document.getElementById("profileAvatarPreview");

    if (avatarInput && avatarPreview) {
      const chosen = data.profilePic || "avatars/default.png";
      avatarInput.value = chosen;
      avatarPreview.src = chosen;

      const options = document.querySelectorAll(".avatar-option");
      options.forEach(opt => {
        const src = opt.getAttribute("data-avatar");
        opt.classList.toggle("selected", src === chosen);
      });
    }

    profileModal.style.display = "flex";
  });
}

function closeProfileModal() {
  profileModal.style.display = "none";
}

function submitProfile() {
  const realName = document.getElementById("profileRealName").value;
  const country  = document.getElementById("profileCountry").value;
  const age      = document.getElementById("profileAge").value;

  const avatarInput = document.getElementById("profileAvatar");
  const profilePic  = avatarInput ? avatarInput.value : "";

  socket.emit(
    "update_profile",
    { realName, country, age, profilePic },
    res => {
      if (!res || !res.ok) {
        alert(res && res.error ? res.error : "Error saving profile");
      } else {
        closeProfileModal();
      }
    }
  );
}

/****************************************************
 * AVATAR PICKER (EDIT PROFILE)
 ****************************************************/
function setupAvatarPicker() {
  const options       = document.querySelectorAll(".avatar-option");
  const avatarInput   = document.getElementById("profileAvatar");
  const avatarPreview = document.getElementById("profileAvatarPreview");

  if (!options.length || !avatarInput || !avatarPreview) return;

  options.forEach(opt => {
    opt.addEventListener("click", () => {
      const src = opt.getAttribute("data-avatar");
      avatarInput.value = src;
      avatarPreview.src = src;

      options.forEach(o => o.classList.remove("selected"));
      opt.classList.add("selected");
    });
  });
}

document.addEventListener("DOMContentLoaded", setupAvatarPicker);

/****************************************************
 * PASSWORD MODAL
 ****************************************************/
function openPasswordModal() {
  document.getElementById("pwOld").value  = "";
  document.getElementById("pwNew1").value = "";
  document.getElementById("pwNew2").value = "";
  passwordModal.style.display = "flex";
}

function closePasswordModal() {
  passwordModal.style.display = "none";
}

function submitPasswordChange() {
  const oldPass = document.getElementById("pwOld").value;
  const new1    = document.getElementById("pwNew1").value;
  const new2    = document.getElementById("pwNew2").value;

  if (!oldPass || !new1 || !new2) {
    alert("Fill all fields");
    return;
  }
  if (new1 !== new2) {
    alert("New passwords do not match");
    return;
  }

  socket.emit(
    "change_password",
    { oldPassword: oldPass, newPassword: new1 },
    res => {
      if (!res || !res.ok) {
        alert(res && res.error ? res.error : "Error changing password");
      } else {
        alert("Password changed.");
        closePasswordModal();
      }
    }
  );
}

/****************************************************
 * ADMIN MODAL
 ****************************************************/
function openAdmin(username) {
  document.getElementById("adm_user").value = username;
  document.getElementById("adm_time").value = "";
  adminModal.style.display = "flex";
}

function closeAdmin() {
  adminModal.style.display = "none";
}

function admSend(cmd) {
  const user = document.getElementById("adm_user").value.trim();
  const t    = document.getElementById("adm_time").value.trim();

  socket.emit(
    "admin_action",
    { action: cmd, target: user, duration: t },
    res => {
      if (!res.ok) alert(res.error);
      else closeAdmin();
    }
  );
}

/****************************************************
 * INVITES
 ****************************************************/
function inviteUser(target) {
  socket.emit("invite", target);
}

socket.on("invited", data => {
  inviteText.innerHTML = `<b>${data.from}</b> invited you to play.`;
  inviteModal.style.display = "flex";

  inviteAccept.onclick = () => {
    socket.emit("accept_invite", data.id);
    inviteModal.style.display = "none";
  };
});

function closeInvite() {
  inviteModal.style.display = "none";
}

/****************************************************
 * GAME OPEN / SPECTATE — SAME TAB
 ****************************************************/
socket.on("start_game", gameID => {
  const url = `/game.html?game=${encodeURIComponent(gameID)}&user=${encodeURIComponent(
    USER
  )}&role=${encodeURIComponent(ROLE)}`;
  window.location = url; // same window
});

function spectate(gameID) {
  const url = `/game.html?game=${encodeURIComponent(gameID)}&user=${encodeURIComponent(
    USER
  )}&role=${encodeURIComponent(ROLE)}`;
  window.location = url; // same window
}

/****************************************************
 * LOGOUT FROM DROPDOWN
 ****************************************************/
function logoutFromDropdown() {
  document.cookie = "user=; Max-Age=0; path=/";
  socket.emit("logout", {}, () => {
    window.location = "/login.html";
  });
}
window.logoutFromDropdown = logoutFromDropdown;

/* Expose functions for inline onclick */
window.openInfo             = openInfo;
window.closeInfo            = closeInfo;
window.openAdmin            = openAdmin;
window.closeAdmin           = closeAdmin;
window.admSend              = admSend;
window.inviteUser           = inviteUser;
window.closeInvite          = closeInvite;
window.spectate             = spectate;
window.openProfileModal     = openProfileModal;
window.closeProfileModal    = closeProfileModal;
window.submitProfile        = submitProfile;
window.openPasswordModal    = openPasswordModal;
window.closePasswordModal   = closePasswordModal;
window.submitPasswordChange = submitPasswordChange;
