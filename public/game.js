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

document.getElementById("backBtn").onclick = () => {
  socket.emit("end_game", GAME_ID);
  window.close();
};

let poolGame     = null;
let p1Name       = null;
let p2Name       = null;
let currentTurn  = null;  // "p1" | "p2"
let placingCueBall = false;
let IAmP1 = false;
let IAmP2 = false;

// Rematch state (you can ignore for now if you don't use it)
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

  // onShotEnd — gets { state, pocketed, rules } (rules are built here)
  shotResult => {
    if (placingCueBall) return;

    const state    = shotResult && shotResult.state;
    const pocketed = (shotResult && shotResult.pocketed) || [];

    // Use server's idea of whose turn it was for rules engine
    const currentPlayerNum = currentTurn === "p1" ? 1 : 2;

    const rules = poolGame.processUKRules(
      pocketed,
      currentPlayerNum
    );

    socket.emit("shot_end", {
      id: GAME_ID,
      state,
      pocketed,
      rules
    });

    if (rules && rules.gameOver && !gameOver) {
      gameOver = true;
      const winnerName =
        rules.winner === 1 ? p1Name :
        rules.winner === 2 ? p2Name :
        "Unknown";
      showEndOfGamePopup(winnerName);
    }

    updateScoreboard(rules);
  },

  // onFrame – live state sync
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

  const star = packet.role === "admin" ? "★ " : "";
  const name = packet.role === "system" ? "" : `${star}${packet.user}: `;

  div.innerHTML = `<span class="${cls}">${name}</span>${packet.msg}`;
  elChat.appendChild(div);
  elChat.scrollTop = elChat.scrollHeight;
}

socket.on("game_msg", addChat);

/*******************************************
 * RECEIVE SHOTS FROM OTHER PLAYER
 *******************************************/
// Shot finished (UK rules coming from client)
socket.on("shot_end", msg => {
  const game = db.games[msg.id];
  if (!game || game.finished) return;

  // Save latest state from the player who shot
  game.state = msg.state;
  saveDB();

  const rules    = msg.rules   || {};
  const pocketed = msg.pocketed || [];

  // Broadcast final state + rules to everyone in the room
  io.to(msg.id).emit("shot_end", {
    state: game.state,
    pocketed,
    rules
  });

  // --- GAME OVER ---
  if (rules.gameOver) {
    const winnerName =
      rules.winner === 1 ? game.p1 :
      rules.winner === 2 ? game.p2 :
      null;

    if (winnerName) {
      applyGameResult(game, winnerName, "8-ball result");
    } else {
      game.finished = true;
      saveDB();
      io.to(game.id).emit("game_over", {
        winner: null,
        reason: "terminated"
      });
      delete db.games[game.id];
      sendGameList();
    }
    return;
  }

  // --- SAME PLAYER CONTINUES (legal pot, no foul) ---
  if (rules.turnContinues && !rules.foul) {
    io.to(msg.id).emit("turn", {
      current: game.currentTurn
    });
    return;
  }

  // --- FOUL → SWITCH TURN + BALL IN HAND FOR OPPONENT ---
  if (rules.foul) {
    game.currentTurn = game.currentTurn === "p1" ? "p2" : "p1";
    saveDB();

    io.to(msg.id).emit("ball_in_hand", {
      player: game.currentTurn   // "p1" or "p2"
    });

    io.to(msg.id).emit("turn", {
      current: game.currentTurn
    });
    return;
  }

  // --- NORMAL TURN SWITCH (no foul, no continuation) ---
  game.currentTurn = game.currentTurn === "p1" ? "p2" : "p1";
  saveDB();

  io.to(msg.id).emit("turn", {
    current: game.currentTurn
  });
});


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
  placingCueBall = true;
  poolGame.ballInHand = true;
  poolGame.enterBallInHandMode();
  updateTurnStatus();
});

// Server sends live cue-follow from opponent
socket.on("cue_follow", pos => {
  if (!placingCueBall) return;
  poolGame.updateBallInHandGhost(pos.x, pos.y);
});

// Server rejects placement (illegal)
socket.on("cue_place_rejected", () => {
  if (!placingCueBall) return;
  poolGame.flashIllegalPlacement();
});

// Server confirms final placement
socket.on("cue_placed", state => {
  placingCueBall = false;
  poolGame.ballInHand = false;
  poolGame.exitBallInHandMode();
  if (state) poolGame.importState(state);
  updateTurnStatus();
});

/*******************************************
 * Send live cue follow to server
 *******************************************/
document.addEventListener("mousemove", e => {
  if (!placingCueBall) return;

  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;

  poolGame.updateBallInHandGhost(x, y);

  socket.emit("cue_follow", {
    id: GAME_ID,
    x,
    y
  });
});

/*******************************************
 * Attempt cue-ball placement on click
 *******************************************/
canvas.addEventListener("mousedown", () => {
  if (!placingCueBall) return;

  socket.emit("attempt_place_cueball", {
    id: GAME_ID,
    pos: poolGame.ballInHandGhost
  });
});

/*******************************************
 * SIMPLE END-OF-GAME POPUP (same as before)
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

  win.appendChild(title);
  win.appendChild(winnerLine);
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
