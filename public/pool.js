/************************************************************
 * pool.js — CLEAN STABLE BUILD (UK rules + ball-in-hand)
 * Miniclip-style aiming: cue line + ghost + object-ball path
 ************************************************************/

class PoolGame {
  constructor(canvas, onShotEnd, onFrame) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext("2d");

    this.onShotEnd = onShotEnd;
    this.onFrame   = onFrame;

    this.width  = canvas.width;
    this.height = canvas.height;

    this.inputEnabled = true;

    /*******************
     * PHYSICS SETTINGS
     *******************/
    this.friction = 0.99;
    this.minSpeed = 0.03;

    /*******************
     * SOUND ENGINE (MP3)
     *******************/
    this.snd_power   = new Audio("sounds/power_drag.mp3");
    this.snd_shot    = new Audio("sounds/shot.mp3");
    this.snd_hit     = new Audio("sounds/ball_hit.mp3");
    this.snd_pocket  = new Audio("sounds/pocket.mp3");
    this.snd_rack    = new Audio("sounds/rack.mp3");
    this.snd_cushion = new Audio("sounds/cushion.mp3");

    this.snd_power.volume   = 0.4;
    this.snd_shot.volume    = 0.5;
    this.snd_hit.volume     = 0.35;
    this.snd_pocket.volume  = 0.45;
    this.snd_rack.volume    = 0.6;
    this.snd_cushion.volume = 0.35;

    // Sound hook — game.js can override this to send over socket
    this.sendSound = (name) => {
      // overridden in game.js (e.g. emit "game_sound" via socket)
    };

    // Aim hook — game.js can override this to send visual-only aim over socket
    this.sendAimUpdate = (angle, power) => {
      // overridden in game.js (emit "game_aim")
    };

    this.lastCushionSoundTime = 0;
    this.cushionMinSpeed      = 0.4;
    this.cushionCooldownMs    = 80;

    document.body.addEventListener(
      "click",
      () => {
        this.snd_power.muted   = false;
        this.snd_shot.muted    = false;
        this.snd_hit.muted     = false;
        this.snd_pocket.muted  = false;
        this.snd_cushion.muted = false;
        this.snd_rack.muted    = false;
      },
      { once: true }
    );

    /*******************
     * TABLE LAYOUT
     *******************/
    this.sidebarWidth  = 100;
    this.tableScale    = 0.90;
    this.tableInset    = 40;
    this.ballRadius    = 10;
    this.pocketRadius  = 22;

    /*******************
     * SPIN WIDGET
     *******************/
    this.spinBallSize = 60;
    this.spinDot = { x: 0, y: 0 };
    this.spinX   = 0;
    this.spinY   = 0;
    this.draggingSpin = false;

    /*******************
     * SHOT STATE
     *******************/
    this.aiming      = false;
    this.aimAngle    = 0;
    this.lastMouse   = null;
    this.animating   = false;
    this.power       = 0;
    this.maxPower    = 90;
    this.pocketedThisShot = [];

    // Track first ball the cue hits this shot
    this.firstContactBallNumber = null;

    // Predicted object-ball path from the guideline
    this.aimPrediction = null;

    // Remote aim (opponent visual only)
    this.remoteAimActive = false;
    this.remoteAimAngle  = 0;
    this.remoteAimPower  = 0;

    /*******************
     * UK POOL RULE STATE
     *******************/
    this.rules = {
      breakDone: false,
      playerColours: { 1: null, 2: null }, // "red" or "yellow"
      currentPlayer: 1,
      openTable: true,
      foul: false,
      turnContinues: false,
      gameOver: false,
      winner: null
    };

    /*******************
     * BALL-IN-HAND STATE
     *******************/
    this.ballInHand      = false;
    this.ballInHandGhost = { x: 0, y: 0 };
    this.ballInHandMode  = "any"; // "any" or "baulk"
    // only the owner of ball-in-hand is allowed to move/place locally
    this.ballInHandInteractive = false;

    /*******************
     * AIM FREEZE VECTORS
     *******************/
    this.storedAimDX = 0;
    this.storedAimDY = 0;

    /*******************
     * BALLS
     *******************/
    this.balls = [];

    this.resetTable();
    this.registerEvents();
    this.render();
  }

  /***************************************************
   * Cushion Sound
   ***************************************************/
  playCushionSound(speedBefore) {
    if (!this.snd_cushion) return;
    if (speedBefore < this.cushionMinSpeed) return;

    const now = performance.now();
    if (now - this.lastCushionSoundTime < this.cushionCooldownMs) return;

    this.lastCushionSoundTime = now;

    try {
      this.snd_cushion.currentTime = 0;
      this.snd_cushion.play();
    } catch (e) {}

    // Broadcast to opponent (via game.js override)
    this.sendSound("cushion");
  }

  /***************************************************
   * RESET TABLE — FULL 8-BALL RACK
   ***************************************************/
  resetTable() {
    this.balls = [];

    // --- table geometry for baulk area ---
    const left   = this.sidebarWidth + this.tableInset;
    const width  = (this.width - this.sidebarWidth) - this.tableInset * 2;
    const baulkOffset = width * 0.20;
    const baulkX = left + baulkOffset;
    const cueX   = left + baulkOffset * 0.5;     // middle of baulk area
    const cueY   = this.height / 2;

    // Cue ball (starts behind the line)
    this.balls.push({
      number: 0,
      x: cueX,
      y: cueY,
      vx: 0,
      vy: 0,
      color: "#FFFFFF",
      inPocket: false
    });

    // UK 8-ball triangular rack (reds/yellows mixed)
    const layout = [
      1,
      10, 2,
      3, 8, 11,
      9, 4, 12, 5,
      6, 13, 7, 14, 15
    ];

    const startX =
      this.sidebarWidth +
      (this.width - this.sidebarWidth) -
      this.tableInset -
      160;

    const startY = this.height / 2;
    const spacing = this.ballRadius * 2 + 2;

    let idx = 0;
    for (let row = 0; row < 5; row++) {
      for (let i = 0; i <= row; i++) {
        const num = layout[idx++];
        this.balls.push({
          number: num,
          x: startX + row * (spacing * 0.9),
          y: startY - (row * spacing) / 2 + i * spacing,
          vx: 0,
          vy: 0,
          color: this.getBallColor(num),
          inPocket: false
        });
      }
    }

    this.aimAngle  = 0;
    this.lastMouse = { x: cueX + 100, y: cueY };

    this.rules.breakDone     = false;
    this.rules.playerColours = { 1: null, 2: null };
    this.rules.currentPlayer = 1;
    this.rules.openTable     = true;
    this.rules.foul          = false;
    this.rules.turnContinues = false;
    this.rules.gameOver      = false;
    this.rules.winner        = null;

    try {
      this.snd_rack.currentTime = 0;
      this.snd_rack.play();
    } catch (e) {}

    // Broadcast rack sound
    this.sendSound("rack");

    // IMPORTANT: do NOT automatically enter ball-in-hand here.
    // game.js will explicitly call enterBallInHandMode("baulk") for the breaker only.
  }

  /***************************************************/
  getBallColor(n) {
    if (n === 0) return "#FFFFFF";
    if (n === 8) return "#000000";
    if (n >= 1 && n <= 7)  return "#CC0000";  // reds
    if (n >= 9 && n <= 15) return "#FFDD00";  // yellows
    return "#FFFFFF";
  }

  /***************************************************
   * INPUT HANDLING
   ***************************************************/
  registerEvents() {
    window.addEventListener("mousedown", e => this.onMouseDown(e));
    window.addEventListener("mousemove", e => this.onMouseMove(e));
    window.addEventListener("mouseup",   e => this.onMouseUp(e));
  }

  insideCanvas(e) {
    const r = this.canvas.getBoundingClientRect();
    const style = getComputedStyle(this.canvas);

    const borderL = parseFloat(style.borderLeftWidth)   || 0;
    const borderR = parseFloat(style.borderRightWidth)  || 0;
    const borderT = parseFloat(style.borderTopWidth)    || 0;
    const borderB = parseFloat(style.borderBottomWidth) || 0;

    const left   = r.left + borderL;
    const right  = r.right - borderR;
    const top    = r.top + borderT;
    const bottom = r.bottom - borderB;

    return (
      e.clientX >= left && e.clientX <= right &&
      e.clientY >= top  && e.clientY <= bottom
    );
  }

  mouseToCanvas(e) {
    const r = this.canvas.getBoundingClientRect();
    const style = getComputedStyle(this.canvas);

    const borderL = parseFloat(style.borderLeftWidth)   || 0;
    const borderR = parseFloat(style.borderRightWidth)  || 0;
    const borderT = parseFloat(style.borderTopWidth)    || 0;
    const borderB = parseFloat(style.borderBottomWidth) || 0;

    const displayWidth  = r.width  - borderL - borderR;
    const displayHeight = r.height - borderT - borderB;

    const scaleX = this.canvas.width  / displayWidth;
    const scaleY = this.canvas.height / displayHeight;

    const x = (e.clientX - (r.left + borderL)) * scaleX;
    const y = (e.clientY - (r.top  + borderT)) * scaleY;

    return { x, y };
  }

  /***************************************************
   * MOUSEDOWN — SIDEBAR OR TABLE?
   ***************************************************/
  onMouseDown(e) {
    if (!this.insideCanvas(e)) return;
    const m = this.mouseToCanvas(e);

    // If ball-in-hand: only the interactive owner can move the ghost
    if (this.ballInHand) {
      if (!this.ballInHandInteractive) return;
      if (m.x >= this.sidebarWidth) {
        this.updateBallInHandGhost(m.x, m.y);
      }
      return;
    }

    if (m.x < this.sidebarWidth) {
      this.sidebarClick(m);
      return;
    }

    if (!this.inputEnabled || this.animating) return;

    const cue = this.balls[0];
    if (!cue || cue.inPocket) return;

    this.aiming  = true;
    this.power   = 0;
    this.pocketedThisShot = [];

    const dx = m.x - cue.x;
    const dy = m.y - cue.y;
    const d  = Math.hypot(dx, dy) || 1;

    this.storedAimDX = dx / d;
    this.storedAimDY = dy / d;

    this.render();
  }

  /***************************************************
   * SIDEBAR CLICK — SPIN + POWER
   ***************************************************/
  sidebarClick(m) {
    if (this.updateSpinFromPoint(m)) {
      this.draggingSpin = true;
      return;
    }

    const barX = 36, barY = 200, barW = 28, barH = 140;
    if (
      m.x >= barX && m.x <= barX + barW &&
      m.y >= barY && m.y <= barY + barH
    ) {
      const t = 1 - (m.y - barY) / barH;
      this.power = Math.max(0, Math.min(this.maxPower, t * this.maxPower));
      this.render();
      // optional: could sendAimUpdate here if you want power-bar sync
      // this.sendAimUpdate(this.aimAngle, this.power);
    }
  }

  updatePowerDrag(m) {
    const cue = this.balls[0];
    if (!cue) return;

    const dirX = Math.cos(this.aimAngle);
    const dirY = Math.sin(this.aimAngle);

    const vx = cue.x - m.x;
    const vy = cue.y - m.y;

    const dot = vx * dirX + vy * dirY;

    this.power = Math.max(0, Math.min(this.maxPower, dot));

    if (this.power > this.maxPower * 0.6) {
      try { this.snd_power.play(); } catch {}
      // Broadcast "power" drag if desired (optional)
      this.sendSound("power");
    }

    this.render();
  }

  /***************************************************
   * SPIN DOT UPDATE
   ***************************************************/
  updateSpinFromPoint(m) {
    const cx = 50;
    const cy = 90;
    const r  = this.spinBallSize / 2;

    const dx = m.x - cx;
    const dy = m.y - cy;

    let nx = dx / r;
    let ny = dy / r;

    const dist = Math.hypot(nx, ny);
    if (dist > 1) {
      nx /= dist;
      ny /= dist;
    }

    this.spinDot.x = nx;
    this.spinDot.y = ny;

    this.spinX = nx;
    this.spinY = -ny;

    this.render();
    return true;
  }

  /***************************************************
   * MOUSEMOVE
   ***************************************************/
  onMouseMove(e) {
    if (!this.insideCanvas(e)) return;
    const m = this.mouseToCanvas(e);

    // Ball-in-hand: move the ghost cue ball inside allowed area
    if (this.ballInHand) {
      if (!this.ballInHandInteractive) return;
      if (m.x >= this.sidebarWidth) {
        this.updateBallInHandGhost(m.x, m.y);
      }
      return;
    }

    if (m.x < this.sidebarWidth) {
      if (this.draggingSpin) {
        this.updateSpinFromPoint(m);
      }
      return;
    }

    if (!this.inputEnabled || this.animating) return;

    const cue = this.balls[0];
    if (!cue || cue.inPocket) return;

    if (this.aiming) {
      this.updatePowerDrag(m);
      this.sendAimUpdate(this.aimAngle, this.power);
    } else {
      this.lastMouse = m;
      const dx = m.x - cue.x;
      const dy = m.y - cue.y;
      this.aimAngle = Math.atan2(dy, dx);
      this.render();
      this.sendAimUpdate(this.aimAngle, this.power);
    }
  }

  /***************************************************
   * MOUSEUP → SHOOT OR (IF BALL-IN-HAND) JUST VALIDATE
   ***************************************************/
  onMouseUp(e) {
    this.draggingSpin = false;

    if (!this.insideCanvas(e)) return;
    const m = this.mouseToCanvas(e);

    // Ball-in-hand: only owner interacts; mouseup does NOT commit,
    // server/game.js will call exitBallInHandMode() via "cue_placed".
    if (this.ballInHand) {
      if (!this.ballInHandInteractive) return;
      if (m.x >= this.sidebarWidth) {
        this.updateBallInHandGhost(m.x, m.y);

        if (!this.isBallInHandPlacementLegal()) {
          this.flashIllegalPlacement();
        }
      } else {
        this.render();
      }
      this.power = 0;
      return;
    }

    if (!this.aiming) return;
    this.aiming = false;

    if (!this.inputEnabled || this.animating) {
      this.power = 0;
      return;
    }

    const cue = this.balls[0];
    if (!cue || cue.inPocket) {
      this.power = 0;
      this.render();
      return;
    }

    if (this.power <= 0.5) {
      this.power = 0;
      this.render();
      return;
    }

    // Capture current guideline prediction for this shot
    const aimData = this.computeAimData();
    if (aimData && aimData.type === "ball") {
      this.aimPrediction = {
        ballNumber: aimData.ballNumber,
        dx: aimData.contDX,
        dy: aimData.contDY
      };
    } else {
      this.aimPrediction = null;
    }

    const dx = Math.cos(this.aimAngle);
    const dy = Math.sin(this.aimAngle);
    const force = Math.max(3, this.power / 4);

    cue.vx = dx * force;
    cue.vy = dy * force;

    try {
      this.snd_shot.currentTime = 0;
      this.snd_shot.play();
    } catch (err) {}

    // Broadcast shot sound
    this.sendSound("shot");

    this.power = 0;
    this.startAnimation();
  }

  /***************************************************
   * ANIMATION LOOP
   ***************************************************/
  startAnimation() {
    if (this.animating) return;
    this.animating = true;

    this.lastTime = performance.now();
    this.pocketedThisShot = [];
    this.firstContactBallNumber = null; // reset first-contact tracking

    // shot is leaving the cue, remote aim overlay is no longer relevant
    this.remoteAimActive = false;
    this.remoteAimPower  = 0;

    requestAnimationFrame(t => this.step(t));
  }

  step(t) {
    const dt = (t - this.lastTime) / 16.67;
    this.lastTime = t;

    this.update(dt);
    this.render();

    if (this.onFrame) this.onFrame(this.exportState());

    if (this.anyBallsMoving()) {
      requestAnimationFrame(tt => this.step(tt));
    } else {
      this.animating = false;
      if (this.onShotEnd) {
        this.onShotEnd({
          state: this.exportState(),
          pocketed: this.pocketedThisShot.slice(),
          firstContact: this.firstContactBallNumber
        });
      }
    }
  }

  anyBallsMoving() {
    return this.balls.some(
      b =>
        !b.inPocket &&
        (Math.abs(b.vx) > this.minSpeed || Math.abs(b.vy) > this.minSpeed)
    );
  }

  /***************************************************
   * PHYSICS ENGINE
   ***************************************************/
  update(dt) {
    const L = this.sidebarWidth + this.tableInset + this.ballRadius;
    const R =
      this.sidebarWidth +
      (this.width - this.sidebarWidth) -
      this.tableInset -
      this.ballRadius;
    const T = this.tableInset + this.ballRadius;
    const B = this.height - this.tableInset - this.ballRadius;

    // MOVE + WALL COLLISION
    for (const b of this.balls) {
      if (b.inPocket) continue;

      b.x += b.vx * dt;
      b.y += b.vy * dt;

      const speedBefore = Math.hypot(b.vx, b.vy);
      let bounced = false;

      if (b.x < L) {
        b.x = L;
        b.vx *= -1;
        bounced = true;
      }
      if (b.x > R) {
        b.x = R;
        b.vx *= -1;
        bounced = true;
      }
      if (b.y < T) {
        b.y = T;
        b.vy *= -1;
        bounced = true;
      }
      if (b.y > B) {
        b.y = B;
        b.vy *= -1;
        bounced = true;
      }

      if (bounced) {
        this.playCushionSound(speedBefore);
      }

      b.vx *= this.friction;
      b.vy *= this.friction;

      if (Math.abs(b.vx) < this.minSpeed) b.vx = 0;
      if (Math.abs(b.vy) < this.minSpeed) b.vy = 0;
    }

    // BALL–BALL COLLISIONS
    const dist  = this.ballRadius * 2;
    const dist2 = dist * dist;

    for (let i = 0; i < this.balls.length; i++) {
      for (let j = i + 1; j < this.balls.length; j++) {
        const a = this.balls[i];
        const b = this.balls[j];

        if (a.inPocket || b.inPocket) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;

        if (d2 < dist2 && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const nx = dx / d;
          const ny = dy / d;

          const overlap = (dist - d) / 2;
          a.x -= nx * overlap;
          a.y -= ny * overlap;
          b.x += nx * overlap;
          b.y += ny * overlap;

          const dvx = b.vx - a.vx;
          const dvy = b.vy - a.vy;
          const dot = dvx * nx + dvy * ny;
          if (dot > 0) continue;

          const imp = -2 * dot / 2;
          const ix = imp * nx;
          const iy = imp * ny;

          a.vx -= ix;
          a.vy -= iy;
          b.vx += ix;
          b.vy += iy;

          // Track FIRST ball hit by the cue this shot
          if (this.firstContactBallNumber === null) {
            if (a.number === 0 && b.number !== 0) {
              this.firstContactBallNumber = b.number;
            } else if (b.number === 0 && a.number !== 0) {
              this.firstContactBallNumber = a.number;
            }
          }

          // Snap the first-hit object ball to match the predicted guideline
          if (this.aimPrediction && this.firstContactBallNumber !== null) {
            let objBall = null;
            if (a.number === this.firstContactBallNumber && b.number === 0) {
              objBall = a;
            } else if (b.number === this.firstContactBallNumber && a.number === 0) {
              objBall = b;
            }

            if (objBall) {
              const speed = Math.hypot(objBall.vx, objBall.vy);
              if (speed > 0) {
                objBall.vx = this.aimPrediction.dx * speed;
                objBall.vy = this.aimPrediction.dy * speed;
              }
              // Only apply once
              this.aimPrediction = null;
            }
          }

          try {
            this.snd_hit.currentTime = 0;
            this.snd_hit.play();
          } catch {}

          // Broadcast hit sound
          this.sendSound("hit");

          if (a.number === 0 || b.number === 0) {
            this.applyPostImpactSpin();
          }
        }
      }
    }

    // POCKETING
    const pockets = [
      { x: this.sidebarWidth + this.tableInset, y: this.tableInset },
      {
        x: this.sidebarWidth + (this.width - this.sidebarWidth) / 2,
        y: this.tableInset
      },
      {
        x:
          this.sidebarWidth +
          (this.width - this.sidebarWidth) -
          this.tableInset,
        y: this.tableInset
      },
      {
        x: this.sidebarWidth + this.tableInset,
        y: this.height - this.tableInset
      },
      {
        x: this.sidebarWidth + (this.width - this.sidebarWidth) / 2,
        y: this.height - this.tableInset
      },
      {
        x:
          this.sidebarWidth +
          (this.width - this.sidebarWidth) -
          this.tableInset,
        y: this.height - this.tableInset
      }
    ];

    for (const b of this.balls) {
      if (b.inPocket) continue;

      for (const p of pockets) {
        const dx = b.x - p.x;
        const dy = b.y - p.y;
        if (dx * dx + dy * dy < this.pocketRadius * this.pocketRadius) {
          b.inPocket = true;
          b.vx = 0;
          b.vy = 0;

          try {
            this.snd_pocket.currentTime = 0;
            this.snd_pocket.play();
          } catch {}

          // Broadcast pocket sound
          this.sendSound("pocket");

          if (!this.pocketedThisShot.includes(b.number)) {
            this.pocketedThisShot.push(b.number);
          }
        }
      }
    }
  }

  /***************************************************
   * SPIN MODEL
   ***************************************************/
  applyPostImpactSpin() {
    const cue = this.balls[0];
    if (!cue) return;

    const dx = Math.cos(this.aimAngle);
    const dy = Math.sin(this.aimAngle);

    cue.vx += dx * this.spinY * 0.5;
    cue.vy += dy * this.spinY * 0.5;

    cue.vx -= dx * -this.spinY * 0.3;
    cue.vy -= dy * -this.spinY * 0.3;
  }

  /***************************************************
   * AIM SYSTEM SUPPORT
   ***************************************************/
  computeAimData() {
    const cue = this.balls[0];
    if (!cue || cue.inPocket) return null;

    const ray = {
      ox: cue.x,
      oy: cue.y,
      dx: Math.cos(this.aimAngle),
      dy: Math.sin(this.aimAngle)
    };

    const hitBall = this.raycastBalls(ray, cue.number);
    const hitCush = this.raycastCushions(ray);

    let first = null;
    if (hitBall && hitCush) {
      first = hitBall.dist < hitCush.dist ? hitBall : hitCush;
    } else first = hitBall || hitCush;

    if (!first) {
      return { type: "none" };
    }

    if (first.type === "ball")    return this.buildBallImpactData(ray, first);
    if (first.type === "cushion") return this.buildCushionImpactData(ray, first);
    return null;
  }

  raycastBalls(ray, ignoreNum) {
    // We want the cue BALL centre to be 2R away from the object centre at impact
    const R = this.ballRadius * 2;  // expanded radius for centre-to-centre collision
    let closest = null;

    for (const b of this.balls) {
      if (b.number === ignoreNum) continue;
      if (b.inPocket) continue;

      // Vector from cue origin → object centre
      const lx = b.x - ray.ox;
      const ly = b.y - ray.oy;

      // Projection of that vector onto the aim direction
      const tProj = lx * ray.dx + ly * ray.dy;
      if (tProj <= 0) continue; // ball is behind or exactly at origin

      // Squared perpendicular distance from line to ball centre
      const distSq = lx * lx + ly * ly - tProj * tProj;
      const R2 = R * R;
      if (distSq > R2) continue; // line misses the expanded circle

      // Distance we have to move back along the ray from closest point
      const offset = Math.sqrt(R2 - distSq);

      // Distance along the ray from origin to impact of cue centre
      const tHit = tProj - offset;
      if (tHit <= 0) continue;

      const hitX = ray.ox + ray.dx * tHit;
      const hitY = ray.oy + ray.dy * tHit;

      if (!closest || tHit < closest.dist) {
        closest = {
          type: "ball",
          ball: b,
          dist: tHit,
          hitX,
          hitY
        };
      }
    }

    return closest;
  }

  raycastCushions(ray) {
    const L = this.sidebarWidth + this.tableInset + this.ballRadius;
    const R =
      this.sidebarWidth +
      (this.width - this.sidebarWidth) -
      this.tableInset -
      this.ballRadius;
    const T = this.tableInset + this.ballRadius;
    const B = this.height - this.tableInset - this.ballRadius;

    const hits = [];

    const test = (t, x, y, type) => {
      if (t > 0)
        hits.push({
          type: "cushion",
          cushion: type,
          dist: t,
          hitX: x,
          hitY: y
        });
    };

    if (ray.dx !== 0) {
      let t = (L - ray.ox) / ray.dx;
      let y = ray.oy + t * ray.dy;
      if (y >= T && y <= B) test(t, L, y, "vertical");

      t = (R - ray.ox) / ray.dx;
      y = ray.oy + t * ray.dy;
      if (y >= T && y <= B) test(t, R, y, "vertical");
    }

    if (ray.dy !== 0) {
      let t = (T - ray.oy) / ray.dy;
      let x = ray.ox + t * ray.dx;
      if (x >= L && x <= R) test(t, x, T, "horizontal");

      t = (B - ray.oy) / ray.dy;
      let x2 = ray.ox + t * ray.dx;
      if (x2 >= L && x2 <= R) test(t, x2, B, "horizontal");
    }

    if (hits.length === 0) return null;
    hits.sort((a, b) => a.dist - b.dist);
    return hits[0];
  }

  getBaulkX() {
    const left  = this.sidebarWidth + this.tableInset;
    const width = (this.width - this.sidebarWidth) - this.tableInset * 2;
    const baulkOffset = width * 0.20;
    return left + baulkOffset;
  }

  // Ray from (ox,oy) with dir (dx,dy) to table inner edge (rails)
  rayToTableEdge(ox, oy, dx, dy) {
    const L = this.sidebarWidth + this.tableInset;
    const R =
      this.sidebarWidth +
      (this.width - this.sidebarWidth) -
      this.tableInset;
    const T = this.tableInset;
    const B = this.height - this.tableInset;

    const hits = [];

    const test = (t, x, y) => {
      if (t > 0) hits.push({ t, x, y });
    };

    if (dx !== 0) {
      let t = (L - ox) / dx;
      let y = oy + t * dy;
      if (y >= T && y <= B) test(t, L, y);

      t = (R - ox) / dx;
      y = oy + t * dy;
      if (y >= T && y <= B) test(t, R, y);
    }

    if (dy !== 0) {
      let t = (T - oy) / dy;
      let x = ox + t * dx;
      if (x >= L && x <= R) test(t, x, T);

      t = (B - oy) / dy;
      let x2 = ox + t * dx;
      if (x2 >= L && x2 <= R) test(t, x2, B);
    }

    if (!hits.length) return null;
    hits.sort((a, b) => a.t - b.t);
    return hits[0];
  }

  /***************************************************
   * BALL IMPACT DATA — Miniclip-style
   ***************************************************/
  buildBallImpactData(ray, impact) {
    const b = impact.ball;
    const R = this.ballRadius;

    // Vector from cue centre at impact → object ball centre
    const vx = b.x - impact.hitX;
    const vy = b.y - impact.hitY;
    const d  = Math.hypot(vx, vy) || 1;

    // Normal along the line of centres at impact
    const nx = vx / d;
    const ny = vy / d;

    // Contact point on object ball surface (where balls touch)
    const contactX = b.x - nx * R;
    const contactY = b.y - ny * R;

    // Ghost cue ball = cue centre at impact
    const ghostX = impact.hitX;
    const ghostY = impact.hitY;

    // Object ball travel direction is along the line of centres
    return {
      type: "ball",
      ballNumber: b.number,
      endX: contactX,
      endY: contactY,
      ballX: b.x,
      ballY: b.y,
      contactX,
      contactY,
      ghostX,
      ghostY,
      contDX: nx,
      contDY: ny
    };
  }

  buildCushionImpactData(ray, impact) {
    let nx = 0,
      ny = 0;
    if (impact.cushion === "vertical") nx = -1;
    else ny = -1;

    const dot = ray.dx * nx + ray.dy * ny;
    const rx  = ray.dx - 2 * dot * nx;
    const ry  = ray.dy - 2 * dot * ny;

    return {
      type: "cushion",
      endX: impact.hitX,
      endY: impact.hitY,
      reflDX: rx,
      reflDY: ry
    };
  }

  /***************************************************
   * RENDER ENGINE
   ***************************************************/
  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    this.renderSidebar(ctx);
    this.drawTable(ctx);
    this.drawBalls(ctx);

    const cue = this.balls[0];
    if (
      cue &&
      !cue.inPocket &&
      !this.animating &&
      !this.ballInHand
    ) {
      if (this.inputEnabled) {
        // Local player aiming
        this.drawAimSystem(ctx, cue);
      } else if (this.remoteAimActive) {
        // Waiting player seeing opponent's aim
        this.drawRemoteAimSystem(ctx, cue);
      }
    }

    // Draw ball-in-hand ghost (placement only)
    if (this.ballInHand) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(
        this.ballInHandGhost.x,
        this.ballInHandGhost.y,
        this.ballRadius,
        0,
        Math.PI * 2
      );
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(0,255,0,0.8)";
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.restore();
    }
  }

  /***************************************************
   * SIDEBAR
   ***************************************************/
  renderSidebar(ctx) {
    ctx.save();

    const bg = ctx.createLinearGradient(0, 0, 0, this.height);
    bg.addColorStop(0, "#001900");
    bg.addColorStop(1, "#000F00");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.sidebarWidth, this.height);

    ctx.fillStyle = "rgba(0,255,100,0.25)";
    ctx.fillRect(this.sidebarWidth - 2, 0, 2, this.height);

    ctx.fillStyle = "#00FF66";
    ctx.font = "16px Arial";
    ctx.textAlign = "center";
    ctx.fillText("SPIN", 50, 28);

    const cx = 50,
      cy = 90,
      r = this.spinBallSize / 2;

    ctx.strokeStyle = "rgba(0,255,100,0.35)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
    ctx.stroke();

    const ballGrad = ctx.createRadialGradient(cx - 5, cy - 5, 4, cx, cy, r);
    ballGrad.addColorStop(0, "#FFFFFF");
    ballGrad.addColorStop(1, "#CCCCCC");
    ctx.fillStyle = ballGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#00FF66";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    const dotX = cx + this.spinDot.x * r;
    const dotY = cy + this.spinDot.y * r;
    ctx.shadowColor = "rgba(255,50,50,0.9)";
    ctx.shadowBlur  = 10;
    ctx.fillStyle   = "#FF3333";
    ctx.beginPath();
    ctx.arc(dotX, dotY, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = "#00FF66";
    ctx.font = "13px Arial";
    ctx.fillText("↑", cx, cy - r - 10);
    ctx.fillText("↓", cx, cy + r + 16);
    ctx.fillText("←", cx - r - 15, cy + 5);
    ctx.fillText("→", cx + r + 16, cy + 5);

    ctx.fillStyle = "#00FF66";
    ctx.font = "16px Arial";
    ctx.fillText("POWER", 50, 180);

    const barX = 36,
      barY = 200,
      barW = 28,
      barH = 140;

    ctx.strokeStyle = "#00FF66";
    ctx.lineWidth   = 2;
    ctx.strokeRect(barX, barY, barW, barH);

    const amt   = (this.power / this.maxPower) * barH;
    const topY  = barY + (barH - amt);

    const grad = ctx.createLinearGradient(0, barY + barH, 0, barY);
    grad.addColorStop(0, "#007700");
    grad.addColorStop(0.5, "#00CC55");
    grad.addColorStop(1, "#00FFAA");

    ctx.fillStyle = grad;
    ctx.fillRect(barX, topY, barW, amt);

    ctx.fillStyle = "rgba(255,255,255,0.15)";
    ctx.fillRect(barX + 3, topY, barW - 6, amt * 0.25);

    const pct = Math.round((this.power / this.maxPower) * 100);
    ctx.fillStyle = "#00FFAA";
    ctx.font = "15px Arial";
    ctx.fillText(pct + "%", 50, barY + barH + 20);

    if (pct === 100) {
      ctx.fillStyle = "rgba(0,255,100,0.25)";
      ctx.fillRect(0, 0, this.sidebarWidth, this.height);
    }

    if (pct > 85) {
      this.canvas.style.transform = `translateX(${
        Math.sin(Date.now() / 40) * 2
      }px)`;
    } else {
      this.canvas.style.transform = "";
    }

    ctx.restore();
  }

  /***************************************************
   * DRAW TABLE + POCKETS + UK LINES
   ***************************************************/
  drawTable(ctx) {
    const left   = this.sidebarWidth + this.tableInset;
    const top    = this.tableInset;
    const width  = (this.width - this.sidebarWidth) - this.tableInset * 2;
    const height = this.height - this.tableInset * 2;

    const right  = left + width;
    const bottom = top + height;
    const midY   = top + height / 2;

    // Cloth
    ctx.fillStyle = "#003300";
    ctx.fillRect(left, top, width, height);

    // Cushion border
    ctx.strokeStyle = "#00FF00";
    ctx.lineWidth   = 4;
    ctx.strokeRect(left, top, width, height);

    // ========= UK TABLE MARKINGS =========

    // Baulk line (break line) – vertical, around 20% in from the left cushion
    const baulkOffset = width * 0.20;
    const baulkX      = left + baulkOffset;

    ctx.save();
    // SOLID baulk line
    ctx.strokeStyle = "rgba(200,255,200,0.70)";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(baulkX, top + 6);
    ctx.lineTo(baulkX, bottom - 6);
    ctx.stroke();

    // "D" semicircle in the baulk area, centred on the baulk line
    const dRadius = height * 0.18;
    ctx.beginPath();
    // Semicircle bulging towards the left cushion
    ctx.arc(baulkX, midY, dRadius, Math.PI / 2, 3 * Math.PI / 2, false);
    ctx.strokeStyle = "rgba(200,255,200,0.55)";
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Spots:
    // 1) Baulk spot (on the baulk line, centre)
    const baulkSpotX = baulkX;
    const baulkSpotY = midY;

    // 2) Black spot (table centre)
    const blackSpotX = left + width / 2;
    const blackSpotY = midY;

    const drawSpot = (x, y) => {
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth   = 1;
      ctx.stroke();
    };

    drawSpot(baulkSpotX, baulkSpotY);
    drawSpot(blackSpotX, blackSpotY);

    ctx.restore();
    // ========= END UK TABLE MARKINGS =========

    // Pockets
    const pockets = [
      { x: this.sidebarWidth + this.tableInset, y: this.tableInset },
      {
        x: this.sidebarWidth + (this.width - this.sidebarWidth) / 2,
        y: this.tableInset
      },
      {
        x:
          this.sidebarWidth +
          (this.width - this.sidebarWidth) -
          this.tableInset,
        y: this.tableInset
      },
      {
        x: this.sidebarWidth + this.tableInset,
        y: this.height - this.tableInset
      },
      {
        x: this.sidebarWidth + (this.width - this.sidebarWidth) / 2,
        y: this.height - this.tableInset
      },
      {
        x:
          this.sidebarWidth +
          (this.width - this.sidebarWidth) -
          this.tableInset,
        y: this.height - this.tableInset
      }
    ];

    ctx.fillStyle = "#000000";
    for (const p of pockets) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, this.pocketRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /***************************************************
   * DRAW BALLS
   ***************************************************/
  drawBalls(ctx) {
    for (const b of this.balls) {
      if (b.inPocket) continue;
      if (this.ballInHand && b.number === 0) continue; // cue is drawn as ghost

      ctx.beginPath();
      ctx.arc(b.x + 2, b.y + 2, this.ballRadius, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(b.x, b.y, this.ballRadius, 0, Math.PI * 2);
      ctx.fillStyle = b.color;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(
        b.x - this.ballRadius / 3,
        b.y - this.ballRadius / 3,
        this.ballRadius / 4,
        0,
        Math.PI * 2
      );
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fill();
    }
  }

  /***************************************************
   * HELPER: DOTTED LINE (Miniclip-style)
   ***************************************************/
  drawDottedLine(ctx, x1, y1, x2, y2, spacing, dotRadius, color, alpha) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;

    const steps = Math.floor(len / spacing);
    const ux = dx / len;
    const uy = dy / len;

    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;

    for (let i = 0; i <= steps; i++) {
      const t = i * spacing;
      const px = x1 + ux * t;
      const py = y1 + uy * t;

      ctx.beginPath();
      ctx.arc(px, py, dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /***************************************************
   * AIM SYSTEM RENDER
   ***************************************************/
  drawAimSystem(ctx, cue) {
    const data = this.computeAimData();

    const dx = Math.cos(this.aimAngle);
    const dy = Math.sin(this.aimAngle);
    const startX = cue.x + dx * this.ballRadius;
    const startY = cue.y + dy * this.ballRadius;

    if (!data || data.type === "none") {
      this.drawNoImpactGuide(ctx, startX, startY, dx, dy);
    } else if (data.type === "ball") {
      this.drawBallImpactGuide(ctx, startX, startY, data);
    } else if (data.type === "cushion") {
      this.drawCushionImpactGuide(ctx, startX, startY, data);
    }

    this.drawCue(ctx, cue);
  }

  // Remote copy of the aim system, driven by opponent's angle/power
  drawRemoteAimSystem(ctx, cue) {
    const prevAngle = this.aimAngle;
    const prevPower = this.power;

    this.aimAngle = this.remoteAimAngle;
    this.power    = this.remoteAimPower;

    this.drawAimSystem(ctx, cue);

    this.aimAngle = prevAngle;
    this.power    = prevPower;
  }

  // No-impact (fallback) — dotted line from cue to table edge
  drawNoImpactGuide(ctx, startX, startY, dx, dy) {
    const hit = this.rayToTableEdge(startX, startY, dx, dy);
    const endX = hit ? hit.x : startX + dx * 2000;
    const endY = hit ? hit.y : startY + dy * 2000;

    ctx.save();
    ctx.strokeStyle = "rgba(0,255,0,0.25)";
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();
    ctx.restore();

    this.drawDottedLine(
      ctx,
      startX,
      startY,
      endX,
      endY,
      9,
      2.5,
      "#00FF66",
      0.95
    );
  }

  // Ball-impact:
  // - Solid line cue → contact
  // - Ghost cue ball at impact
  // - Short solid line for object-ball path
  // - Dotted extension to rail
  drawBallImpactGuide(ctx, startX, startY, data) {
    // Main solid line cue → contact
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth   = 3;
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur  = 3;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(data.contactX, data.contactY);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Ghost cue-ball circle at impact
    ctx.beginPath();
    ctx.arc(data.ghostX, data.ghostY, this.ballRadius, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Small contact dot on object ball
    ctx.beginPath();
    ctx.arc(data.contactX, data.contactY, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();

    // Highlight ring on object ball
    ctx.beginPath();
    ctx.arc(data.ballX, data.ballY, this.ballRadius + 1.5, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,255,255,0.9)";
    ctx.lineWidth   = 1.5;
    ctx.stroke();
    ctx.restore();

    // Short solid segment for object-ball direction
    const shortLen = this.ballRadius * 4;
    const shortEndX = data.ballX + data.contDX * shortLen;
    const shortEndY = data.ballY + data.contDY * shortLen;

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(data.ballX, data.ballY);
    ctx.lineTo(shortEndX, shortEndY);
    ctx.stroke();
    ctx.restore();

    // Dotted extension of object path to rail
    const hitObjPath = this.rayToTableEdge(
      data.ballX,
      data.ballY,
      data.contDX,
      data.contDY
    );

    if (hitObjPath) {
      this.drawDottedLine(
        ctx,
        shortEndX,
        shortEndY,
        hitObjPath.x,
        hitObjPath.y,
        9,
        2.3,
        "#00FFFF",
        0.75
      );
    }
  }

  // Cushion-impact:
  // - Solid line cue → cushion hit
  // - Dotted reflection path to rail
  drawCushionImpactGuide(ctx, startX, startY, data) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth   = 3;
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur  = 3;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(data.endX, data.endY);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();

    const hitRefl = this.rayToTableEdge(
      data.endX,
      data.endY,
      data.reflDX,
      data.reflDY
    );

    if (hitRefl) {
      this.drawDottedLine(
        ctx,
        data.endX,
        data.endY,
        hitRefl.x,
        hitRefl.y,
        9,
        2.5,
        "#00FF66",
        0.9
      );
    }
  }

  /***************************************************
   * CUE DRAWING
   ***************************************************/
  drawCue(ctx, cue) {
    const dx  = Math.cos(this.aimAngle);
    const dy  = Math.sin(this.aimAngle);
    const len = 220;

    const tipX = cue.x - dx * this.ballRadius;
    const tipY = cue.y - dy * this.ballRadius;
    const bx   = tipX - dx * len;
    const by   = tipY - dy * len;

    ctx.save();
    ctx.strokeStyle = "#C89650";
    ctx.lineWidth   = 5;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.restore();
  }

  /***************************************************
   * NETWORK STATE SYNC
   ***************************************************/
  exportState() {
    return {
      balls: this.balls.map(b => ({
        number: b.number,
        x: b.x,
        y: b.y,
        vx: b.vx,
        vy: b.vy,
        color: b.color,
        inPocket: b.inPocket
      }))
    };
  }

  importState(state) {
    if (!state || !state.balls) return;
    this.balls = state.balls.map(b => ({ ...b }));
    this.render();
  }

  setInputEnabled(f) {
    this.inputEnabled = !!f;
  }

  // Opponent aim hooks (used by game.js)
  setRemoteAim(angle, power) {
    this.remoteAimActive = true;
    this.remoteAimAngle  = typeof angle === "number" ? angle : 0;
    this.remoteAimPower  = typeof power === "number" ? power : 0;
    this.render();
  }

  clearRemoteAim() {
    this.remoteAimActive = false;
    this.remoteAimPower  = 0;
    this.render();
  }

  /***************************************************
   * UK RULES — PURE FLAGS (no turn flip here)
   ***************************************************/
  processUKRules(pocketed, currentPlayerNum, firstContactNumber = null) {
    const r = this.rules;

    r.currentPlayer = currentPlayerNum;
    r.foul          = false;
    r.turnContinues = false;
    r.gameOver      = false;
    r.winner        = null;

    const reds    = pocketed.filter(n => n >= 1 && n <= 7);
    const yellows = pocketed.filter(n => n >= 9 && n <= 15);
    const black   = pocketed.includes(8);
    const cueBall = pocketed.includes(0);

    // FIRST LEGAL POT ASSIGNS COLOURS
    if (r.openTable && !black) {
      if (reds.length > 0 && yellows.length === 0) {
        r.playerColours[currentPlayerNum] = "red";
        r.playerColours[currentPlayerNum === 1 ? 2 : 1] = "yellow";
        r.openTable = false;
      }
      if (yellows.length > 0 && reds.length === 0) {
        r.playerColours[currentPlayerNum] = "yellow";
        r.playerColours[currentPlayerNum === 1 ? 2 : 1] = "red";
        r.openTable = false;
      }
    }

    const playerColour = r.playerColours[currentPlayerNum];

    // FIRST CONTACT COLOUR (for foul on wrong ball first)
    let firstHitColour = null;
    if (
      firstContactNumber !== null &&
      firstContactNumber !== 0 &&
      firstContactNumber !== 8
    ) {
      if (firstContactNumber >= 1 && firstContactNumber <= 7)
        firstHitColour = "red";
      else if (firstContactNumber >= 9 && firstContactNumber <= 15)
        firstHitColour = "yellow";
    }

    // If colours are assigned and you hit the opponent's colour first → foul
    if (!r.openTable && playerColour && firstHitColour && firstHitColour !== playerColour) {
      r.foul = true;
    }

    // BLACK BALL
    if (black) {
      if (r.openTable) {
        r.gameOver = true;
        r.winner   = currentPlayerNum === 1 ? 2 : 1;
        return { ...r };
      }

      const target = r.playerColours[currentPlayerNum];
      const allTargetLeft = this.balls.some(
        b =>
          !b.inPocket &&
          ((target === "red" &&
            b.number >= 1 &&
            b.number <= 7) ||
            (target === "yellow" &&
              b.number >= 9 &&
              b.number <= 15))
      );

      if (allTargetLeft) {
        r.gameOver = true;
        r.winner   = currentPlayerNum === 1 ? 2 : 1;
      } else {
        r.gameOver = true;
        r.winner   = currentPlayerNum;
      }

      return { ...r };
    }

    // FOUL CHECKS
    if (cueBall) r.foul = true;

    if (!r.openTable && playerColour) {
      if (playerColour === "red" && yellows.length > 0)  r.foul = true;
      if (playerColour === "yellow" && reds.length > 0)  r.foul = true;
    }

    if (playerColour === "red" && reds.length > 0) {
      r.turnContinues = true;
    } else if (playerColour === "yellow" && yellows.length > 0) {
      r.turnContinues = true;
    } else {
      r.turnContinues = false;
    }

    if (r.openTable) {
      if (reds.length + yellows.length > 0) r.turnContinues = true;
    }

    if (r.foul) {
      r.turnContinues = false;
    }

    return { ...r };
  }

  /***************************************************
   * BALL-IN-HAND HELPERS
   ***************************************************/
  enterBallInHandMode(mode = "any") {
    this.ballInHandMode = mode; // "any" or "baulk"

    const cue = this.balls.find(b => b.number === 0);
    if (!cue) return;

    cue.inPocket = true;
    cue.vx = 0;
    cue.vy = 0;

    this.ballInHand = true;
    this.ballInHandGhost = { x: cue.x, y: cue.y };
    this.render();
  }

  updateBallInHandGhost(x, y) {
    const p = this.clampBallInHandPosition(x, y);
    this.ballInHandGhost.x = p.x;
    this.ballInHandGhost.y = p.y;
    this.render();
  }

  clampBallInHandPosition(x, y) {
    // 1) Clamp to inner table bounds
    const leftInner =
      this.sidebarWidth + this.tableInset + this.ballRadius;
    const rightInner =
      this.sidebarWidth +
      (this.width - this.sidebarWidth) -
      this.tableInset -
      this.ballRadius;
    const topInner    = this.tableInset + this.ballRadius;
    const bottomInner = this.height - this.tableInset - this.ballRadius;

    let cx = Math.min(Math.max(x, leftInner), rightInner);
    let cy = Math.min(Math.max(y, topInner), bottomInner);

    // 2) Baulk restriction (for opening break)
    if (this.ballInHandMode === "baulk") {
      const baulkX = this.getBaulkX();
      const maxX   = baulkX - this.ballRadius;
      cx = Math.min(cx, maxX);
    }

    // 3) Push away from balls and pockets so we can never sit on top
    const minBallDist   = this.ballRadius * 2.6;
    const minPocketDist = this.pocketRadius + this.ballRadius * 0.2;

    for (let iter = 0; iter < 6; iter++) {
      // Away from balls
      for (const b of this.balls) {
        if (b.inPocket) continue;
        if (b.number === 0) continue;

        let dx = cx - b.x;
        let dy = cy - b.y;
        let d  = Math.hypot(dx, dy);

        if (d === 0) {
          dx = 1;
          dy = 0;
          d  = 1;
        }

        if (d < minBallDist) {
          const push = minBallDist - d;
          const nx = dx / d;
          const ny = dy / d;
          cx += nx * push;
          cy += ny * push;
        }
      }

      // Away from pockets
      const pockets = [
        { x: this.sidebarWidth + this.tableInset, y: this.tableInset },
        {
          x: this.sidebarWidth + (this.width - this.sidebarWidth) / 2,
          y: this.tableInset
        },
        {
          x:
            this.sidebarWidth +
            (this.width - this.sidebarWidth) -
            this.tableInset,
          y: this.tableInset
        },
        {
          x: this.sidebarWidth + this.tableInset,
          y: this.height - this.tableInset
        },
        {
          x: this.sidebarWidth + (this.width - this.sidebarWidth) / 2,
          y: this.height - this.tableInset
        },
        {
          x:
            this.sidebarWidth +
            (this.width - this.sidebarWidth) -
            this.tableInset,
          y: this.height - this.tableInset
        }
      ];

      for (const p of pockets) {
        let dx = cx - p.x;
        let dy = cy - p.y;
        let d  = Math.hypot(dx, dy);

        if (d === 0) {
          dx = 1;
          dy = 0;
          d  = 1;
        }

        if (d < minPocketDist) {
          const push = minPocketDist - d;
          const nx = dx / d;
          const ny = dy / d;
          cx += nx * push;
          cy += ny * push;
        }
      }

      // Re-clamp to table/baulk after pushing
      cx = Math.min(Math.max(cx, leftInner), rightInner);
      cy = Math.min(Math.max(cy, topInner), bottomInner);
      if (this.ballInHandMode === "baulk") {
        const baulkX = this.getBaulkX();
        const maxX   = baulkX - this.ballRadius;
        cx = Math.min(cx, maxX);
      }
    }

    return { x: cx, y: cy };
  }

  flashIllegalPlacement() {
    const ctx = this.ctx;
    const { x, y } = this.ballInHandGhost;

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, this.ballRadius + 4, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,0,0,0.9)";
    ctx.lineWidth   = 3;
    ctx.stroke();
    ctx.restore();
  }

  // Final guard that the ghost position is not overlapping any object ball
  // and not sitting inside a pocket mouth.
  isBallInHandPlacementLegal() {
    const gx = this.ballInHandGhost.x;
    const gy = this.ballInHandGhost.y;

    const minBallDist  = this.ballRadius * 2.6;
    const minBallDist2 = minBallDist * minBallDist;

    for (const b of this.balls) {
      if (b.inPocket) continue;
      if (b.number === 0) continue;

      const dx = gx - b.x;
      const dy = gy - b.y;
      const d2 = dx * dx + dy * dy;

      if (d2 < minBallDist2) {
        return false;
      }
    }

    const pockets = [
      { x: this.sidebarWidth + this.tableInset, y: this.tableInset },
      {
        x: this.sidebarWidth + (this.width - this.sidebarWidth) / 2,
        y: this.tableInset
      },
      {
        x:
          this.sidebarWidth +
          (this.width - this.sidebarWidth) -
          this.tableInset,
        y: this.tableInset
      },
      {
        x: this.sidebarWidth + this.tableInset,
        y: this.height - this.tableInset
      },
      {
        x: this.sidebarWidth + (this.width - this.sidebarWidth) / 2,
        y: this.height - this.tableInset
      },
      {
        x:
          this.sidebarWidth +
          (this.width - this.sidebarWidth) -
          this.tableInset,
        y: this.height - this.tableInset
      }
    ];

    const minPocketDist  = this.pocketRadius + this.ballRadius * 0.2;
    const minPocketDist2 = minPocketDist * minPocketDist;

    for (const p of pockets) {
      const dx = gx - p.x;
      const dy = gy - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < minPocketDist2) {
        return false;
      }
    }

    return true;
  }

  exitBallInHandMode() {
    let cue = this.balls.find(b => b.number === 0);
    if (!cue) {
      cue = {
        number: 0,
        x: this.ballInHandGhost.x,
        y: this.ballInHandGhost.y,
        vx: 0,
        vy: 0,
        color: "#FFFFFF",
        inPocket: false
      };
      this.balls.unshift(cue);
    } else {
      cue.x = this.ballInHandGhost.x;
      cue.y = this.ballInHandGhost.y;
      cue.vx = 0;
      cue.vy = 0;
      cue.inPocket = false;
    }

    this.ballInHand = false;
    this.ballInHandMode = "any"; // reset for later fouls
    this.ballInHandInteractive = false;
    this.render();
  }
}
