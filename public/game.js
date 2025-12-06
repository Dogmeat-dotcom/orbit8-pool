console.log("GAME.JS LOADED v7");

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
  // If game is still live, this is a forfeit → tell server once
  if (!hasSignalledEndGame && !gameOver) {
    socket.emit("end_game", GAME_ID);
    hasSignalledEndGame = true;
  }
  // Always send them back to lobby UI in same tab
  window.location = "/";
};

let poolGame        = null;
let p1Name          = null;
let p2Name          = null;
let currentTurn     = null;  // "p1" | "p2"
let IAmP1           = false;
let IAmP2           = false;

// Ball-in-hand local flags
let placingCueBall  = false;
let ballInHandOwner = null;   // "p1" or "p2"
let ballInHandForMe = false;

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

    // Use server's idea of whose turn it was for rules engine
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

    // Only touch local scoreboard; game over is decided by the server
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

  updateTurnStatus();
  updateScoreboard();
});

/*******************************************
 * TURN UPDATE
 *******************************************/
socket.on("turn", payload => {
  currentTurn = payload.current;
  updateTurnStatus();
  updateScoreboard();
});

/*******************************************
 * LIVE STATE + FINAL STATE FROM SERVER
 *******************************************/
// Live state from current shooter → keep spectators / waiting player in sync
socket.on("shot_frame", msg => {
  if (!poolGame) return;
  if (placingCueBall) return;         // don't stomp ghost placement
  if (!msg || !msg.state) return;
  poolGame.importState(msg.state);
});

// Final state + rules after each shot
socket.on("shot_end", msg => {
  if (!poolGame) return;

  if (msg.state) {
    poolGame.importState(msg.state);
  }

  if (msg.rules) {
    // Sync local rules with server-accepted rules
    poolGame.rules = { ...poolGame.rules, ...msg.rules };
    updateScoreboard(msg.rules);
  } else {
    updateScoreboard();
  }
});

/*******************************************
 * GAME OVER (authoritative from server)
 *******************************************/
socket.on("game_over", payload => {
  if (gameOver) return;
  gameOver = true;

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

  // admin badge icon (same file as lobby)
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
  if (!p1Name || !p2Name || !currentTurn) return;

  const myTurn =
    (currentTurn === "p1" && USER === p1Name) ||
    (currentTurn === "p2" && USER === p2Name);

  if (placingCueBall) {
    poolGame.setInputEnabled(true);
    elStatus.textContent = "Place the cue ball…";
    return;
  }

  if (gameOver) {
    poolGame.setInputEnabled(false);
    elStatus.textContent = "Game over";
    return;
  }

  // Align local rules currentPlayer with server turn
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

  // Highlight active turn
  if (elP1Panel && elP2Panel && currentTurn) {
    elP1Panel.classList.toggle("active-turn", currentTurn === "p1");
    elP2Panel.classList.toggle("active-turn", currentTurn === "p2");
  }

  elP1Balls.innerHTML = "";
  elP2Balls.innerHTML = "";

  // Helper to draw 7 balls, fading potted ones
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

  // Open table → grey placeholders
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

// Server: this player gets ball in hand
socket.on("ball_in_hand", payload => {
  if (!payload || !payload.player) return;

  ballInHandOwner = payload.player; // "p1" | "p2"
  ballInHandForMe =
    (payload.player === "p1" && IAmP1) ||
    (payload.player === "p2" && IAmP2);

  placingCueBall = true;

  if (poolGame) {
    poolGame.ballInHand = true;
    poolGame.enterBallInHandMode();
  }
  updateTurnStatus();
});

// Server sends live cue-follow from owner
socket.on("cue_follow", pos => {
  if (!placingCueBall || !poolGame) return;
  poolGame.updateBallInHandGhost(pos.x, pos.y);
});

// Server rejects placement (illegal) – currently unused if you keep server always accepting
socket.on("cue_place_rejected", () => {
  if (!placingCueBall || !poolGame) return;
  poolGame.flashIllegalPlacement();
});

// Server confirms final placement
socket.on("cue_placed", state => {
  placingCueBall  = false;
  ballInHandForMe = false;

  if (poolGame) {
    poolGame.ballInHand = false;
    poolGame.exitBallInHandMode();
    if (state) poolGame.importState(state);
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
  // If the game is still live and we haven't told the server yet,
  // treat closing the tab as a forfeit.
  if (!hasSignalledEndGame && !gameOver) {
    socket.emit("end_game", GAME_ID);
    hasSignalledEndGame = true;
  }
});

/*******************************************
 * SIMPLE END-OF-GAME POPUP (server-driven)
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
