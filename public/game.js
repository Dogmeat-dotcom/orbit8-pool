console.log("GAME.JS LOADED v11");

/*******************************************
 * game.js — UK pub rules + ball-in-hand + scoreboard
 *******************************************/

const socket = io();

// ADMIN DISCONNECT
socket.on("admin_disconnect", info => {
  try {
    sessionStorage.setItem("orbit8_kickban", JSON.stringify(info));
  } catch (e) {}
  window.location = "/login.html";
});

const params = new URLSearchParams(window.location.search);
const GAME_ID = params.get("game");
const USER    = params.get("user");
const ROLE    = params.get("role");

const elChat   = document.getElementById("game-chat");
const elInput  = document.getElementById("chat-input");
const elSend   = document.getElementById("chat-send");
const elStatus = document.getElementById("status");

// Scoreboard DOM
const elP1Panel     = document.getElementById("p1Panel");
const elP2Panel     = document.getElementById("p2Panel");
const elP1NameLabel = document.getElementById("p1NameLabel");
const elP2NameLabel = document.getElementById("p2NameLabel");
const elP1Balls     = document.getElementById("p1Balls");
const elP2Balls     = document.getElementById("p2Balls");

document.getElementById("gameTitle").textContent = `Game #${GAME_ID}`;

socket.emit("identify_game_client", { user: USER, role: ROLE });

// Track whether we've already told the server we ended (forfeit)
let hasSignalledEndGame = false;

// Return to lobby button – same tab
document.getElementById("backBtn").onclick = () => {
  if (!hasSignalledEndGame && !gameOver) {
    socket.emit("end_game", GAME_ID);
    hasSignalledEndGame = true;
  }
  window.location = "/";
};

let poolGame        = null;
let p1Name          = null;
let p2Name          = null;
let currentTurn     = null;  // "p1" | "p2"
let IAmP1           = false;
let IAmP2           = false;

// Ball-in-hand local flags
let placingCueBall  = false;   // "we are currently in placement stage" (all clients)
let ballInHandOwner = null;    // "p1" | "p2"
let ballInHandForMe = false;   // only true for the owner on this client
let foulJustOccurred = false;  // NEW: track when a foul created ball-in-hand

// Rematch / game-over state
let gameOver        = false;
let rematchPopup    = null;
let rematchChoice   = null;
let rematchWaiting  = false;

/*******************************************
 * CREATE TABLE LOCALLY
 *******************************************/
const canvas = document.getElementById("poolCanvas");

poolGame = new PoolGame(
  canvas,

  // onShotEnd — gets { state, pocketed, firstContact } (rules built here)
  shotResult => {
    if (placingCueBall) return;

    const state        = shotResult && shotResult.state;
    const pocketed     = (shotResult && shotResult.pocketed) || [];
    const firstContact = (shotResult && typeof shotResult.firstContact !== "undefined")
      ? shotResult.firstContact
      : null;

    const currentPlayerNum = currentTurn === "p1" ? 1 : 2;

    const rules = poolGame.processUKRules(
      pocketed,
      currentPlayerNum,
      firstContact
    );

    socket.emit("shot_end", {
      id: GAME_ID,
      state,
      pocketed,
      rules
    });

    updateScoreboard(rules);
  },

  // onFrame – live state sync (only from the active shooter)
  state => {
    if (!placingCueBall) {
      socket.emit("shot_frame", { id: GAME_ID, state });
    }
  }
);

/*******************************************
 * SOUND BROADCAST HOOK
 *******************************************/
poolGame.sendSound = soundName => {
  if (!soundName) return;
  socket.emit("game_sound", {
    id: GAME_ID,
    sound: soundName
  });
};

/*******************************************
 * AIM SYNC (visual only)
 *******************************************/
poolGame.sendAimUpdate = (angle, power) => {
  // Only the active player may broadcast aim
  const myTurn =
    (currentTurn === "p1" && IAmP1) ||
    (currentTurn === "p2" && IAmP2);

  if (!myTurn) return;
  if (placingCueBall) return;
  if (gameOver) return;

  socket.emit("game_aim", {
    id: GAME_ID,
    angle,
    power
  });
};

/*******************************************
 * JOIN GAME SESSION
 *******************************************/
socket.emit("join_game", { id: GAME_ID });

/*******************************************
 * INITIAL SYNC
 *******************************************/
socket.on("game_sync", data => {
  p1Name      = data.p1 || null;
  p2Name      = data.p2 || null;
  currentTurn = data.currentTurn || null;

  if (p1Name === USER) IAmP1 = true;
  if (p2Name === USER) IAmP2 = true;

  if (data.statusText) elStatus.textContent = data.statusText;

  if (data.state) {
    poolGame.importState(data.state);
  }

  if (Array.isArray(data.chat)) {
    data.chat.forEach(addChat);
  }

  gameOver       = false;
  rematchChoice  = null;
  rematchWaiting = false;
  closeRematchPopup();

  // OPENING BREAK: treat as ball-in-hand behind baulk for the breaker only.
  // Condition: brand new game (no state yet), both players present.
  if (!data.state && data.p1 && data.p2 && currentTurn) {
    ballInHandOwner = currentTurn; // should be "p1"

    ballInHandForMe =
      (currentTurn === "p1" && IAmP1) ||
      (currentTurn === "p2" && IAmP2);

    // All clients know we are in placement phase so they can render the ghost.
    placingCueBall = true;

    if (poolGame) {
      poolGame.ballInHand = true;
      poolGame.ballInHandInteractive = ballInHandForMe;
      const mode = currentTurn === "p1" ? "baulk" : "any";
      poolGame.enterBallInHandMode(mode);
    }
  }

  updateTurnStatus();
  updateScoreboard();
});

/*******************************************
 * TURN UPDATE
 *******************************************/
socket.on("turn", payload => {
  currentTurn = payload.current;

  if (poolGame && typeof poolGame.clearRemoteAim === "function") {
    poolGame.clearRemoteAim();
  }

  updateTurnStatus();
  updateScoreboard();
});

/*******************************************
 * LIVE STATE + FINAL STATE FROM SERVER
 *******************************************/
socket.on("shot_frame", msg => {
  if (!poolGame) return;
  if (placingCueBall) return;
  if (!msg || !msg.state) return;

  if (typeof poolGame.clearRemoteAim === "function") {
    poolGame.clearRemoteAim();
  }

  poolGame.importState(msg.state);
});

socket.on("shot_end", msg => {
  if (!poolGame) return;

  if (typeof poolGame.clearRemoteAim === "function") {
    poolGame.clearRemoteAim();
  }

  if (msg.state) {
    poolGame.importState(msg.state);
  }

  if (msg.rules) {
    poolGame.rules = { ...poolGame.rules, ...msg.rules };
    updateScoreboard(msg.rules);
  } else {
    updateScoreboard();
  }
});

/*******************************************
 * REMOTE SOUND HANDLER
 *******************************************/
socket.on("game_sound", payload => {
  if (!poolGame || !payload) return;

  const sound = typeof payload === "string" ? payload : payload.sound;
  if (!sound) return;

  try {
    if (sound === "shot" && poolGame.snd_shot) {
      poolGame.snd_shot.currentTime = 0;
      poolGame.snd_shot.play();
    } else if (sound === "hit" && poolGame.snd_hit) {
      poolGame.snd_hit.currentTime = 0;
      poolGame.snd_hit.play();
    } else if (sound === "pocket" && poolGame.snd_pocket) {
      poolGame.snd_pocket.currentTime = 0;
      poolGame.snd_pocket.play();
    } else if (sound === "rack" && poolGame.snd_rack) {
      poolGame.snd_rack.currentTime = 0;
      poolGame.snd_rack.play();
    } else if (sound === "cushion" && poolGame.snd_cushion) {
      poolGame.snd_cushion.currentTime = 0;
      poolGame.snd_cushion.play();
    } else if (sound === "power" && poolGame.snd_power) {
      poolGame.snd_power.currentTime = 0;
      poolGame.snd_power.play();
    }
  } catch (e) {}
});

/*******************************************
 * REMOTE AIM VISUALS
 *******************************************/
socket.on("game_aim", payload => {
  if (!poolGame || !payload) return;

  const { angle, power } = payload;

  // Ignore if it's our turn; this is purely opponent visual
  const myTurn =
    (currentTurn === "p1" && IAmP1) ||
    (currentTurn === "p2" && IAmP2);

  if (myTurn) return;
  if (placingCueBall) return;
  if (gameOver) return;

  if (typeof poolGame.setRemoteAim === "function") {
    poolGame.setRemoteAim(angle, power);
  }
});

/*******************************************
 * GAME OVER (authoritative from server)
 *******************************************/
socket.on("game_over", payload => {
  if (gameOver) return;
  gameOver = true;

  if (poolGame && typeof poolGame.clearRemoteAim === "function") {
    poolGame.clearRemoteAim();
  }

  const winnerName = payload && payload.winner
    ? payload.winner
    : "No winner";

  showEndOfGamePopup(winnerName);
  updateTurnStatus();
});

/*******************************************
 * CHAT LOGIC
 *******************************************/
elSend.onclick = sendChat;
elInput.onkeypress = e => { if (e.key === "Enter") sendChat(); };

function sendChat() {
  const msg = elInput.value.trim();
  if (!msg) return;
  socket.emit("game_msg", { id: GAME_ID, message: msg });
  elInput.value = "";
}

function addChat(packet) {
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

  const name = packet.role === "system" ? "" : `${adminIcon}${packet.user}: `;

  div.innerHTML = `<span class="${cls}">${name}</span>${packet.msg}`;
  elChat.appendChild(div);
  elChat.scrollTop = elChat.scrollHeight;
}

socket.on("game_msg", addChat);

/*******************************************
 * TURN CONTROL
 *******************************************/
function updateTurnStatus() {
  if (!p1Name || !p2Name || !currentTurn || !poolGame) return;

  // Reset status bar to default colours each time
  elStatus.style.background = "#000A00"; // same as CSS
  elStatus.style.color = "#33FF33";      // same as var(--green-light)

  const myTurn =
    (currentTurn === "p1" && USER === p1Name) ||
    (currentTurn === "p2" && USER === p2Name);

  if (placingCueBall) {
    const ownerPlacing =
      (ballInHandOwner === "p1" && IAmP1) ||
      (ballInHandOwner === "p2" && IAmP2);

    const ownerName  = ballInHandOwner === "p1" ? p1Name : p2Name;
    const foulerName = ballInHandOwner === "p1" ? p2Name : p1Name;

    poolGame.setInputEnabled(ownerPlacing);

    if (foulJustOccurred) {
      // Foul highlight
      elStatus.style.background = "#330000";
      elStatus.style.color = "#FF6666";

      if (ownerPlacing) {
        elStatus.textContent = `Foul on ${foulerName || "opponent"} — you have ball in hand. Place the cue ball…`;
      } else {
        elStatus.textContent = `Foul — ${ownerName || "opponent"} has ball in hand. Placing the cue ball…`;
      }
    } else {
      elStatus.textContent = ownerPlacing
        ? "Place the cue ball…"
        : `${ownerName || "Opponent"} is placing the cue ball…`;
    }
    return;
  }

  if (gameOver) {
    poolGame.setInputEnabled(false);
    elStatus.textContent = "Game over";
    return;
  }

  if (poolGame && poolGame.rules) {
    poolGame.rules.currentPlayer = (currentTurn === "p1" ? 1 : 2);
  }

  poolGame.setInputEnabled(myTurn);

  const playerName = currentTurn === "p1" ? p1Name : p2Name;

  elStatus.textContent = myTurn
    ? "Your turn"
    : `Waiting for ${playerName}…`;
}

/*******************************************
 * SCOREBOARD RENDER (names + ball tracking)
 *******************************************/
function updateScoreboard(rulesFromServer) {
  if (!elP1NameLabel || !elP2NameLabel) return;

  elP1NameLabel.textContent = p1Name || "Player 1";
  elP2NameLabel.textContent = p2Name || "Player 2";

  if (!elP1Balls || !elP2Balls || !poolGame) return;

  const r = rulesFromServer || poolGame.rules || null;

  if (elP1Panel && elP2Panel && currentTurn) {
    elP1Panel.classList.toggle("active-turn", currentTurn === "p1");
    elP2Panel.classList.toggle("active-turn", currentTurn === "p2");
  }

  elP1Balls.innerHTML = "";
  elP2Balls.innerHTML = "";

  function renderColour(wrapper, colour) {
    const nums = colour === "red"
      ? [1,2,3,4,5,6,7]
      : [9,10,11,12,13,14,15];

    nums.forEach(n => {
      const ballObj = poolGame.balls.find(b => b.number === n);
      const potted  = !ballObj || ballObj.inPocket;

      const el = document.createElement("div");
      el.className = "score-ball" + (potted ? " potted" : "");
      el.style.background = (colour === "red") ? "#CC0000" : "#FFDD00";
      elP1Balls.style.display = "flex";
      elP2Balls.style.display = "flex";
      wrapper.appendChild(el);
    });
  }

  if (!r || r.openTable) {
    for (let i = 0; i < 7; i++) {
      const d1 = document.createElement("div");
      d1.className = "score-ball";
      d1.style.background = "#555";
      const d2 = d1.cloneNode();
      elP1Balls.appendChild(d1);
      elP2Balls.appendChild(d2);
    }
    return;
  }

  const p1Col = r.playerColours && r.playerColours[1];
  const p2Col = r.playerColours && r.playerColours[2];

  if (p1Col) renderColour(elP1Balls, p1Col);
  if (p2Col) renderColour(elP2Balls, p2Col);
}

/*******************************************
 * ========== BALL-IN-HAND EVENTS ==========
 *******************************************/
socket.on("ball_in_hand", payload => {
  if (!payload || !payload.player) return;

  ballInHandOwner = payload.player; // "p1" | "p2"
  ballInHandForMe =
    (payload.player === "p1" && IAmP1) ||
    (payload.player === "p2" && IAmP2);

  placingCueBall   = true;
  foulJustOccurred = true; // NEW: mark that this ball-in-hand came from a foul

  if (poolGame) {
    poolGame.ballInHand = true;
    poolGame.ballInHandInteractive = ballInHandForMe;
    poolGame.enterBallInHandMode(payload.mode || "any");
  }
  updateTurnStatus();
});

socket.on("cue_follow", pos => {
  if (!placingCueBall || !poolGame) return;
  poolGame.updateBallInHandGhost(pos.x, pos.y);
});

socket.on("cue_place_rejected", () => {
  if (!placingCueBall || !poolGame) return;
  poolGame.flashIllegalPlacement();
});

socket.on("cue_placed", state => {
  placingCueBall  = false;
  ballInHandForMe = false;
  foulJustOccurred = false; // NEW: clear foul highlight once ball is placed

  if (poolGame) {
    // End ball-in-hand mode locally; use the ghost position we already have
    poolGame.ballInHand = false;
    if ("ballInHandInteractive" in poolGame) {
      poolGame.ballInHandInteractive = false;
    }
    poolGame.exitBallInHandMode();
    // IMPORTANT: do NOT import state here – it may be partial and will wipe object balls
    // if (state) poolGame.importState(state);
  }

  updateTurnStatus();
});

/*******************************************
 * Send live cue follow (ONLY owner)
 *******************************************/
document.addEventListener("mousemove", e => {
  if (!placingCueBall || !ballInHandForMe || !poolGame) return;
  if (!poolGame.insideCanvas(e)) return;

  const m = poolGame.mouseToCanvas(e);

  poolGame.updateBallInHandGhost(m.x, m.y);

  socket.emit("cue_follow", {
    id: GAME_ID,
    x: m.x,
    y: m.y
  });
});

/*******************************************
 * Attempt cue-ball placement (ONLY owner)
 *******************************************/
canvas.addEventListener("mousedown", e => {
  if (!placingCueBall || !ballInHandForMe || !poolGame) return;
  if (!poolGame.insideCanvas(e)) return;

  socket.emit("attempt_place_cueball", {
    id: GAME_ID,
    pos: poolGame.ballInHandGhost
  });
});

/*******************************************
 * HANDLE TAB / WINDOW CLOSE → FORFEIT
 *******************************************/
window.addEventListener("beforeunload", () => {
  if (!hasSignalledEndGame && !gameOver) {
    socket.emit("end_game", GAME_ID);
    hasSignalledEndGame = true;
  }
});

/*******************************************
 * SIMPLE END-OF-GAME POPUP
 *******************************************/
function showEndOfGamePopup(winnerName) {
  if (rematchPopup) return;

  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.left = "0";
  overlay.style.top = "0";
  overlay.style.width = "100%";
  overlay.style.height = "100%";
  overlay.style.background = "rgba(0,0,0,0.65)";
  overlay.style.display = "flex";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.zIndex = "9999";

  const win = document.createElement("div");
  win.style.background = "#001300";
  win.style.border = "2px solid #00FF5A";
  win.style.boxShadow = "0 0 12px rgba(0,255,90,0.7)";
  win.style.borderRadius = "10px";
  win.style.padding = "18px 22px";
  win.style.minWidth = "260px";
  win.style.fontFamily = "Arial, sans-serif";
  win.style.color = "#00FF5A";
  win.style.textAlign = "center";

  const title = document.createElement("div");
  title.textContent = "Game Over";
  title.style.fontSize = "20px";
  title.style.marginBottom = "8px";

  const winnerLine = document.createElement("div");
  winnerLine.textContent = `Winner: ${winnerName}`;
  winnerLine.style.marginBottom = "14px";
  winnerLine.style.color = "#00FFAA";

  const btn = document.createElement("button");
  btn.textContent = "Close and return to lobby";
  btn.style.marginTop = "10px";
  btn.style.padding = "6px 14px";
  btn.style.borderRadius = "6px";
  btn.style.border = "1px solid #00FF5A";
  btn.style.background = "#002000";
  btn.style.color = "#00FF5A";
  btn.style.cursor = "pointer";
  btn.onclick = () => {
    closeRematchPopup();
    window.location = "/";
  };

  win.appendChild(title);
  win.appendChild(winnerLine);
  win.appendChild(btn);
  overlay.appendChild(win);
  document.body.appendChild(overlay);

  rematchPopup = overlay;
}

function closeRematchPopup() {
  if (rematchPopup) {
    rematchPopup.remove();
    rematchPopup = null;
  }
}
