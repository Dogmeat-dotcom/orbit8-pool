/*******************************************************
 * server.js — 8-ball version with stats + forfeits
 *******************************************************/

const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const cookieParser = require("cookie-parser");

/* ------------ MIDDLEWARE ------------ */
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/* ------------ DATABASE (JSON) ------------ */
const DB_FILE = path.join(__dirname, "database.json");

let db = { users: {}, chat: [], games: {} };

if (fs.existsSync(DB_FILE)) {
  db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));

  // Ensure all existing users have a profilePic field
  if (db.users && typeof db.users === "object") {
    for (const uname of Object.keys(db.users)) {
      const u = db.users[uname];
      if (!u.profilePic) {
        u.profilePic = "avatars/default.png";
      }
    }
  }
} else {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

/* ------------ HELPERS ------------ */

function sendGameList() {
  const list = Object.values(db.games).filter(g => g.p2 && !g.finished);
  io.emit("games", list);
}

/**
 * Apply final result of a game:
 * - winnerName: username of winner
 * - reason: "8-ball win", "8-ball foul", "8-ball early", "forfeit", etc.
 */
function applyGameResult(game, winnerName, reason) {
  if (!game || game.finished) return;
  if (!winnerName) return;

  const loserName = winnerName === game.p1 ? game.p2 : game.p1;
  if (!db.users[winnerName] || !db.users[loserName]) return;

  const w = db.users[winnerName];
  const l = db.users[loserName];

  w.gamesPlayed = (w.gamesPlayed || 0) + 1;
  w.gamesWon = (w.gamesWon || 0) + 1;
  l.gamesPlayed = (l.gamesPlayed || 0) + 1;

  game.finished = true;
  saveDB();

  io.to(game.id).emit("game_over", {
    winner: winnerName,
    reason
  });

  delete db.games[game.id];
  sendGameList();
}

/* ------------ EXPRESS ROUTES ------------ */

app.get("/", (req, res) => {
  const u = req.cookies.user;
  if (!u || !db.users[u]) {
    return res.redirect("/login.html");
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

/* ------------ SOCKET.IO ------------ */

io.on("connection", socket => {
  const getUser = () => socket.user && db.users[socket.user];

  // Game windows identify themselves explicitly
  socket.on("identify_game_client", ({ user, role }) => {
    if (user && db.users[user]) {
      socket.user = user;
      socket.role = db.users[user].role;
    } else {
      socket.user = user || "Player";
      socket.role = role || "player";
    }
  });

  /***********************
   * REGISTER
   ***********************/
  socket.on("register", (data, cb) => {
    const username = (data.username || "").trim();
    const password = (data.password || "").trim();

    if (!username || !password)
      return cb && cb({ ok: false, error: "Missing fields" });

    if (db.users[username])
      return cb && cb({ ok: false, error: "Username already exists" });

    const hash = bcrypt.hashSync(password, 10);

    const role =
      Object.keys(db.users).length === 0 ? "admin" : "player";

    db.users[username] = {
      username,
      password: hash,
      role,
      gamesPlayed: 0,
      gamesWon: 0,
      mutedUntil: 0,
      bannedUntil: 0,   // timed/permanent bans
      realName: "",
      country: "",
      age: null,
      // default profile picture for new users
      profilePic: "avatars/default.png"
    };

    saveDB();
    cb && cb({ ok: true });
  });

  /***********************
   * LOGIN
   ***********************/
  socket.on("login", (data, cb) => {
    const username = (data.username || "").trim();
    const password = (data.password || "").trim();

    const u = db.users[username];
    if (!u) return cb && cb({ ok: false, error: "User not found" });

    // ---- AUTO-EXPIRE TIMED BANS ----
    if (u.bannedUntil && u.bannedUntil > Date.now()) {
      const minsLeft = Math.ceil((u.bannedUntil - Date.now()) / 60000);
      return cb && cb({
        ok: false,
        error: `You are banned. Time left: ${minsLeft} min`
      });
    }

    // Ban expired → clear
    if (u.bannedUntil && u.bannedUntil !== 0 && u.bannedUntil <= Date.now()) {
      u.bannedUntil = 0;
      saveDB();
    }

    const ok = bcrypt.compareSync(password, u.password);
    if (!ok) return cb && cb({ ok: false, error: "Incorrect password" });

    socket.user = username;
    socket.role = u.role;

    socket.emit("do_set_cookie", { user: username });

    cb && cb({ ok: true });
  });

  /***********************
   * AUTH CHECK (LOBBY)
   ***********************/
  socket.on("auth_check", (data, cb) => {
    let cookieHeader = socket.handshake.headers.cookie || "";
    let username = null;

    cookieHeader.split("; ").forEach(c => {
      if (c.startsWith("user=")) {
        username = decodeURIComponent(c.split("=")[1]);
      }
    });

    if (!username || !db.users[username]) {
      return cb && cb({ ok: false });
    }

    socket.user = username;
    socket.role = db.users[username].role;

    cb && cb({ ok: true, user: username, role: socket.role });

    sendPlayerList();
    sendGameList();

    // send lobby chat history
    db.chat.forEach(m => socket.emit("chat", m));
  });

  /***********************
   * LOGOUT
   ***********************/
  socket.on("logout", (data, cb) => {
    socket.user = null;
    socket.role = null;
    cb && cb({ ok: true });
    socket.disconnect(true);
  });

  /***********************
   * LOBBY CHAT
   ***********************/
  socket.on("chat", msg => {
    const u = getUser();
    if (!u) return;
    if (u.mutedUntil && u.mutedUntil > Date.now()) return;

    const packet = {
      user: socket.user,
      msg: String(msg).slice(0, 300),
      role: socket.role
    };

    db.chat.push(packet);
    if (db.chat.length > 500) db.chat.shift();
    saveDB();

    io.emit("chat", packet);
  });

  socket.emit("chat", {
    user: "SYSTEM",
    msg: "Welcome to the lobby.",
    role: "system"
  });

  /***********************
   * PLAYER INFO
   ***********************/
  socket.on("get_info", (username, cb) => {
    const u = db.users[username];
    if (!u) return;

    const winPercent =
      u.gamesPlayed === 0
        ? 0
        : Math.round((u.gamesWon / u.gamesPlayed) * 100);

    cb && cb({
      username,
      role: u.role,
      gamesPlayed: u.gamesPlayed,
      gamesWon: u.gamesWon,
      winPercent,
      realName: u.realName || "",
      country: u.country || "",
      age: u.age || "",
      // expose profilePic to clients
      profilePic: u.profilePic || "avatars/default.png"
    });
  });

  /***********************
   * UPDATE PROFILE
   ***********************/
  socket.on("update_profile", (data, cb) => {
    const self = getUser();
    if (!self) return cb && cb({ ok: false, error: "Not logged in" });

    const u = db.users[socket.user];
    if (!u) return cb && cb({ ok: false, error: "User not found" });

    const realName = (data.realName || "").trim();
    const country  = (data.country  || "").trim();
    let age        = (data.age || "").toString().trim();
    const profilePic = (data.profilePic || "").trim(); // avatar path

    if (age === "") {
      age = null;
    } else {
      const n = Number(age);
      age = Number.isFinite(n) && n > 0 && n < 150 ? n : null;
    }

    u.realName = realName;
    u.country  = country;
    u.age      = age;

    // update profile picture if provided
    if (profilePic) {
      u.profilePic = profilePic.slice(0, 200);
    }

    saveDB();

    // NEW: push updated avatars to everyone immediately
    sendPlayerList();

    cb && cb({ ok: true });
  });

  /***********************
   * CHANGE PASSWORD
   ***********************/
  socket.on("change_password", (data, cb) => {
    const self = getUser();
    if (!self) return cb && cb({ ok: false, error: "Not logged in" });

    const u = db.users[socket.user];
    if (!u) return cb && cb({ ok: false, error: "User not found" });

    const oldPass = (data.oldPassword || "").trim();
    const newPass = (data.newPassword || "").trim();

    if (!oldPass || !newPass) {
      return cb && cb({ ok: false, error: "Fill all fields" });
    }

    const ok = bcrypt.compareSync(oldPass, u.password);
    if (!ok) {
      return cb && cb({ ok: false, error: "Old password incorrect" });
    }

    if (newPass.length < 4) {
      return cb && cb({ ok: false, error: "New password too short" });
    }

    u.password = bcrypt.hashSync(newPass, 10);
    saveDB();
    cb && cb({ ok: true });
  });

  /***********************
   * ADMIN / MOD ACTIONS
   ***********************/
  socket.on("admin_action", (data, cb) => {
    const self = getUser();
    if (!self) return cb ? cb({ ok: false, error: "Not logged in" }) : null;

    if (socket.role !== "admin" && socket.role !== "moderator")
      return cb ? cb({ ok: false, error: "Not allowed" }) : null;

    const { action, target, duration } = data;
    const u = db.users[target];
    if (!u) return cb ? cb({ ok: false, error: "User not found" }) : null;

    const isMod = socket.role === "moderator";
    if (u.role === "admin" && isMod)
      return cb ? cb({ ok: false, error: "Cannot act on admin" }) : null;

    const durationTextBase =
      duration && String(duration).trim() !== ""
        ? `${duration} minute(s)`
        : "";

    switch (action) {
      case "kick": {
        if (isMod)
          return cb ? cb({ ok: false, error: "Mods cannot kick" }) : null;

        const payload = {
          type: "kick",
          reason: "You have been kicked by an administrator.",
          durationText: durationTextBase || "Session only"
        };

        for (const [id, s] of io.sockets.sockets) {
          if (s.user === target) {
            s.emit("admin_disconnect", payload);
            setTimeout(() => s.disconnect(true), 100);
          }
        }
        break;
      }

      case "ban": {
        if (isMod)
          return cb ? cb({ ok: false, error: "Mods cannot ban" }) : null;

        const mins = Number(duration);

        // UNBAN
        if (!isNaN(mins) && mins === 0) {
          u.bannedUntil = 0;
          saveDB();
          return cb && cb({ ok: true });
        }

        // PERMANENT BAN
        if (isNaN(mins) || String(duration).trim() === "") {
          u.bannedUntil = Infinity;
        }
        // TIMED BAN
        else if (mins > 0) {
          u.bannedUntil = Date.now() + mins * 60000;
        }

        saveDB();

        const payload = {
          type: "ban",
          reason: "You have been banned from Orbit 8 Pool.",
          durationText:
            u.bannedUntil === Infinity
              ? "Permanent"
              : `${mins} minute(s)`
        };

        for (const [id, s] of io.sockets.sockets) {
          if (s.user === target) {
            s.emit("admin_disconnect", payload);
            setTimeout(() => s.disconnect(true), 100);
          }
        }
        break;
      }

      case "mute": {
        if (duration === undefined || duration === "") {
          u.mutedUntil = Infinity;
        } else {
          const mins = Number(duration) || 0;
          u.mutedUntil = mins > 0 ? Date.now() + mins * 60000 : 0;
        }
        saveDB();
        break;
      }

      case "clear_chat":
        db.chat = [];
        saveDB();
        io.emit("chat_cleared");
        break;

      case "del_user_msgs":
        db.chat = db.chat.filter(m => m.user !== target);
        saveDB();
        io.emit("chat_filter", { user: target });
        break;

      default:
        return cb ? cb({ ok: false, error: "Unknown action" }) : null;
    }

    cb && cb({ ok: true });
  });

  /***********************
   * GAME MANAGEMENT
   ***********************/
  function newGameObject(id, p1) {
    return {
      id,
      p1,
      p2: null,
      spectators: [],
      state: null,
      chat: [],
      currentTurn: "p1",          // p1 breaks
      groups: { p1: null, p2: null }, // legacy (solids/stripes)
      finished: false,
      ballInHandFor: null        // "p1" | "p2" | null
    };
  }

  socket.on("create_game", () => {
    const u = getUser();
    if (!u) return;

    const id = "g" + Math.random().toString(36).slice(2, 8);
    db.games[id] = newGameObject(id, socket.user);
    saveDB();
    sendGameList();
  });

  // Invite: create game & send ID
  socket.on("invite", target => {
    const u = getUser();
    if (!u) return;
    if (!db.users[target]) return;

    const id = "g" + Math.random().toString(36).slice(2, 8);

    db.games[id] = newGameObject(id, socket.user);
    saveDB();
    sendGameList();

    for (const [sid, s] of io.sockets.sockets) {
      if (s.user === target) {
        s.emit("invited", { from: socket.user, id });
      }
    }
  });

  // Accept invite by game ID
  socket.on("accept_invite", gameId => {
    const u = getUser();
    if (!u) return;

    const game = db.games[gameId];
    if (!game || game.p2) return;

    game.p2 = socket.user;
    game.currentTurn = "p1"; // p1 breaks
    saveDB();
    sendGameList();

    for (const [sid, s] of io.sockets.sockets) {
      if (s.user === game.p1 || s.user === game.p2) {
        s.emit("start_game", game.id);
      }
    }

    io.to(game.id).emit("turn", {
      current: game.currentTurn,
      player: game.p1
    });
  });

  /***********************
   * GAME WINDOW EVENTS
   ***********************/
  socket.on("join_game", ({ id }) => {
    const game = db.games[id];
    if (!game) return;

    socket.join(id);

    socket.emit("game_sync", {
      state: game.state,
      chat: game.chat,
      statusText: `${game.p1 || "?"} vs ${game.p2 || "Waiting..."}`,
      p1: game.p1,
      p2: game.p2,
      currentTurn: game.currentTurn
    });

    socket.emit("turn", {
      current: game.currentTurn,
      player: game.currentTurn === "p1" ? game.p1 : game.p2
    });
  });

  // Game chat
  socket.on("game_msg", ({ id, message }) => {
    const game = db.games[id];
    if (!game) return;

    const packet = {
      user: socket.user || "Player",
      msg: String(message).slice(0, 300),
      role: socket.role || "player"
    };
    game.chat.push(packet);
    saveDB();
    io.to(id).emit("game_msg", packet);
  });

  // Live state streaming
  socket.on("shot_frame", ({ id, state }) => {
    const game = db.games[id];
    if (!game || game.finished) return;

    game.state = state;
    socket.to(id).emit("shot_frame", { state });
  });

  // Shot finished (UK rules coming from client)
  socket.on("shot_end", msg => {
    const game = db.games[msg.id];
    if (!game || game.finished) return;

    // Update server-side state
    game.state = msg.state;
    const rules = msg.rules || {};

    // reset ball-in-hand flag each shot; may be set again below
    game.ballInHandFor = null;

    // Relay latest table state (and rules info) to everyone in the room
    io.to(msg.id).emit("shot_end", {
      state: game.state,
      pocketed: msg.pocketed,
      rules
    });

    // ---------- GAME OVER (rules-based win) ----------
    if (rules.gameOver) {
      let winnerName = null;
      if (rules.winner === 1) winnerName = game.p1;
      else if (rules.winner === 2) winnerName = game.p2;

      if (winnerName) {
        applyGameResult(game, winnerName, "8-ball win");
      } else {
        game.finished = true;
        saveDB();
        io.to(msg.id).emit("game_over", {
          winner: null,
          reason: "game over"
        });
        delete db.games[msg.id];
        sendGameList();
      }
      return;
    }

    // ---------- FOUL → SWITCH TURN + BALL IN HAND ----------
    if (rules.foul) {
      game.currentTurn = game.currentTurn === "p1" ? "p2" : "p1";
      game.ballInHandFor = game.currentTurn;

      io.to(msg.id).emit("ball_in_hand", {
        player: game.ballInHandFor   // "p1" or "p2"
      });

      io.to(msg.id).emit("turn", { current: game.currentTurn });
      saveDB();
      return;
    }

    // ---------- PLAYER KEEPS TURN (legal pot) ----------
    if (rules.turnContinues) {
      io.to(msg.id).emit("turn", { current: game.currentTurn });
      saveDB();
      return;
    }

    // ---------- NORMAL TURN SWITCH ----------
    game.currentTurn = game.currentTurn === "p1" ? "p2" : "p1";
    io.to(msg.id).emit("turn", { current: game.currentTurn });
    saveDB();
  });

  /***********************
   * AIM RELAY FOR GAME (visual-only)
   ***********************/
  socket.on("game_aim", ({ id, angle, power }) => {
    const game = db.games[id];
    if (!game || game.finished) return;
    // Only in-game players may broadcast aim
    if (socket.user !== game.p1 && socket.user !== game.p2) return;

    socket.to(id).emit("game_aim", {
      angle,
      power
    });
  });

  /***********************
   * SOUND RELAY FOR GAME
   ***********************/
  socket.on("game_sound", ({ id, sound }) => {
    const game = db.games[id];
    if (!game || game.finished) return;
    if (!sound) return;

    // Send to all other sockets in the room (opponent + spectators)
    socket.to(id).emit("game_sound", { sound });
  });

  /***********************
   * BALL-IN-HAND SERVER SIDE
   ***********************/

  // Helper: who is allowed to control ball-in-hand (ghost + placement)?
  function canControlBallInHand(game, user) {
    if (!user) return false;
    const isP1 = user === game.p1;
    const isP2 = user === game.p2;

    // Opening break: no state (or empty state) yet → currentTurn player
    const noState =
      !game.state ||
      !Array.isArray(game.state.balls) ||
      game.state.balls.length === 0;

    if (noState) {
      if (game.currentTurn === "p1" && isP1) return true;
      if (game.currentTurn === "p2" && isP2) return true;
    }

    // Foul ball-in-hand: ballInHandFor indicates seat
    if (game.ballInHandFor === "p1" && isP1) return true;
    if (game.ballInHandFor === "p2" && isP2) return true;

    return false;
  }

  // Live ghost tracking – relay to the other clients only
  socket.on("cue_follow", ({ id, x, y }) => {
    const game = db.games[id];
    if (!game || game.finished) return;

    // Only the proper player (break owner or ball-in-hand owner) can move ghost
    if (!canControlBallInHand(game, socket.user)) return;

    socket.to(id).emit("cue_follow", { x, y });
  });

  // Final cue-ball placement – restricted to the correct controller
  socket.on("attempt_place_cueball", ({ id, pos }) => {
    const game = db.games[id];
    if (!game || game.finished) return;

    // Only the break player (pre-state) or ball-in-hand owner may place
    if (!canControlBallInHand(game, socket.user)) return;

    // Ensure state and balls array exist
    if (!game.state || !Array.isArray(game.state.balls)) {
      game.state = game.state || {};
      game.state.balls = game.state.balls || [];
    }

    const balls = game.state.balls;

    // Ensure cue ball exists
    let cue = balls.find(b => b.number === 0);
    if (!cue) {
      cue = {
        number: 0,
        x: pos.x,
        y: pos.y,
        vx: 0,
        vy: 0,
        color: "#FFFFFF",
        inPocket: false
      };
      balls.unshift(cue);
    } else {
      cue.x = pos.x;
      cue.y = pos.y;
      cue.vx = 0;
      cue.vy = 0;
      cue.inPocket = false;
    }

    // Clear ball-in-hand flag now that the ball is placed
    game.ballInHandFor = null;
    saveDB();

    io.to(id).emit("cue_placed", game.state);
  });

  // End game / forfeit
  socket.on("end_game", id => {
    const game = db.games[id];
    if (!game || game.finished) return;

    const forfeiter = socket.user;
    if (!forfeiter) return;

    // ---- SPECTATOR LEAVING ----
    if (forfeiter !== game.p1 && forfeiter !== game.p2) {
      socket.leave(id);
      return;
    }

    // ---- REAL PLAYER FORFEIT ----
    let winnerName = null;
    if (forfeiter === game.p1 && game.p2) winnerName = game.p2;
    else if (forfeiter === game.p2 && game.p1) winnerName = game.p1;

    if (winnerName) {
      applyGameResult(game, winnerName, "forfeit");
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
  });

  /***********************
   * DISCONNECT
   ***********************/
  socket.on("disconnect", () => {
    sendPlayerList();
  });

  /***********************
   * LOBBY PLAYER LIST
   ***********************/
  function sendPlayerList() {
    const list = [];
    for (const [id, s] of io.sockets.sockets) {
      if (!s.user) continue;
      const u = db.users[s.user];
      list.push({
        username: s.user,
        role: s.role,
        profilePic: u && u.profilePic ? u.profilePic : "avatars/default.png"
      });
    }
    io.emit("players", list);
  }
});

/* ------------ START SERVER ------------ */

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
