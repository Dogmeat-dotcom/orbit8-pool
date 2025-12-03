/*******************************************
 * game.js — Game window logic (8-ball rules + ball-in-hand)
 *******************************************/

const socket = io();

// ADD THIS BLOCK:
socket.on("admin_disconnect", info => {
  try {
    sessionStorage.setItem("orbit8_kickban", JSON.stringify(info));
  } catch (e) {
    // ignore
  }
  window.location = "/login.html";
});

const params = new URLSearchParams(window.location.search);
const GAME_ID = params.get("game");
const USER = params.get("user");
const ROLE = params.get("role");

const elChat = document.getElementById("game-chat");
const elInput = document.getElementById("chat-input");
const elSend = document.getElementById("chat-send");
const elStatus = document.getElementById("status");

document.getElementById("gameTitle").textContent = `Game #${GAME_ID}`;

socket.emit("identify_game_client", { user: USER, role: ROLE });

document.getElementById("backBtn").onclick = () => {
  socket.emit("end_game", GAME_ID);
  window.close();
};

let poolGame = null;
let p1Name = null;
let p2Name = null;
let currentTurn = null;
let placingCueBall = false;        // NEW
let IAmP1 = false;
let IAmP2 = false;

/*******************************************
 * CREATE TABLE LOCALLY
 *******************************************/
const canvas = document.getElementById("poolCanvas");
poolGame = new PoolGame(
  canvas,

  // onShotEnd
  shotState => {
    if (!placingCueBall) {
      socket.emit("shot_end", { id: GAME_ID, state: shotState });
    }
  },

  // onFrame
  shotState => {
    if (!placingCueBall) {
      socket.emit("shot_frame", { id: GAME_ID, state: shotState });
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
  p1Name = data.p1 || null;
  p2Name = data.p2 || null;
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

  updateTurnStatus();
});

/*******************************************
 * TURN UPDATE
 *******************************************/
socket.on("turn", payload => {
  currentTurn = payload.current;
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
socket.on("shot_frame", ({ state }) => {
  if (!poolGame || placingCueBall) return;
  poolGame.importState(state);
});

socket.on("shot_end", ({ state }) => {
  if (!poolGame || placingCueBall) return;
  poolGame.importState(state);
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
    // input allowed ONLY for placement
    poolGame.setInputEnabled(true);
    elStatus.textContent = "Place the cue ball…";
    return;
  }

  poolGame.setInputEnabled(myTurn);

  const playerName = currentTurn === "p1" ? p1Name : p2Name;

  elStatus.textContent = myTurn
    ? "Your turn"
    : `Waiting for ${playerName}…`;
}

/*******************************************
 * ========== BALL-IN-HAND EVENTS ==========
 *******************************************/

/************************************************
 * Server says: This player gets ball in hand
************************************************/
socket.on("ball_in_hand", () => {
  placingCueBall = true;
  poolGame.ballInHand = true;
  poolGame.enterBallInHandMode();
  updateTurnStatus();
});

/************************************************
 * Server sends live cue-follow from opponent
************************************************/
socket.on("cue_follow", pos => {
  if (!placingCueBall) return;
  poolGame.updateBallInHandGhost(pos.x, pos.y);
});

/************************************************
 * Server rejects placement (illegal)
************************************************/
socket.on("cue_place_rejected", () => {
  if (!placingCueBall) return;
  poolGame.flashIllegalPlacement();   // red outline
  showSidebarWarning();               // text warning
});

/************************************************
 * Server confirms final placement
************************************************/
socket.on("cue_placed", state => {
  placingCueBall = false;
  poolGame.ballInHand = false;
  poolGame.exitBallInHandMode();
  poolGame.importState(state);
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
 * Sidebar illegal placement text
 *******************************************/
function showSidebarWarning() {
  const warn = document.createElement("div");
  warn.style.position = "absolute";
  warn.style.left = "10px";
  warn.style.top = "180px";
  warn.style.color = "#FF3333";
  warn.style.fontSize = "14px";
  warn.style.fontFamily = "Arial";
  warn.textContent = "ILLEGAL PLACEMENT";
  document.body.appendChild(warn);

  setTimeout(() => warn.remove(), 700);
}
