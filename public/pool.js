/************************************************************
 * pool.js — CLEAN STABLE BUILD (UK rules + ball-in-hand)
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

    this.lastCushionSoundTime = 0;
    this.cushionMinSpeed      = 0.4;
    this.cushionCooldownMs    = 80;

    document.body.addEventListener("click", () => {
      this.snd_power.muted   = false;
      this.snd_shot.muted    = false;
      this.snd_hit.muted     = false;
      this.snd_pocket.muted  = false;
      this.snd_cushion.muted = false;
      this.snd_rack.muted    = false;
    }, { once: true });

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
  }

  /***************************************************
   * RESET TABLE — FULL 8-BALL RACK
   ***************************************************/
  resetTable() {
    this.balls = [];

    const cueX = this.sidebarWidth + this.tableInset + 100;
    const cueY = this.height / 2;

    // Cue ball
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

    const startX = this.sidebarWidth +
      (this.width - this.sidebarWidth) -
      this.tableInset - 160;

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

    // If ball-in-hand, shooting is disabled; click is handled in game.js
    if (this.ballInHand) return;

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
    }
  }

  updatePowerDrag(m) {
    const cue = this.balls[0];
    if (!cue) return;

    const dx = m.x - cue.x;
    const dy = m.y - cue.y;

    const dirX = Math.cos(this.aimAngle);
    const dirY = Math.sin(this.aimAngle);

    const vx = cue.x - m.x;
    const vy = cue.y - m.y;

    const dot = vx * dirX + vy * dirY;

    this.power = Math.max(0, Math.min(this.maxPower, dot));

    if (this.power > this.maxPower * 0.6) {
      try { this.snd_power.play(); } catch {}
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

    // Ball-in-hand ghost is managed in game.js via updateBallInHandGhost
    if (this.ballInHand) return;

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
    } else {
      this.lastMouse = m;
      const dx = m.x - cue.x;
      const dy = m.y - cue.y;
      this.aimAngle = Math.atan2(dy, dx);
      this.render();
    }
  }

  /***************************************************
   * MOUSEUP → SHOOT
   ***************************************************/
  onMouseUp(e) {
    this.draggingSpin = false;

    if (!this.aiming) return;
    this.aiming = false;

    if (!this.inputEnabled || this.animating) {
      this.power = 0;
      return;
    }

    if (this.ballInHand) {
      this.power = 0;
      this.render();
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

    const dx = Math.cos(this.aimAngle);
    const dy = Math.sin(this.aimAngle);
    const force = Math.max(3, this.power / 4);

    cue.vx = dx * force;
    cue.vy = dy * force;

    try {
      this.snd_shot.currentTime = 0;
      this.snd_shot.play();
    } catch (err) {}

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
      b => !b.inPocket &&
           (Math.abs(b.vx) > this.minSpeed ||
            Math.abs(b.vy) > this.minSpeed)
    );
  }

  /***************************************************
   * PHYSICS ENGINE
   ***************************************************/
  update(dt) {
    const L = this.sidebarWidth + this.tableInset + this.ballRadius;
    const R = this.sidebarWidth +
              (this.width - this.sidebarWidth) -
              this.tableInset - this.ballRadius;
    const T = this.tableInset + this.ballRadius;
    const B = this.height - this.tableInset - this.ballRadius;

    // MOVE + WALL COLLISION
    for (const b of this.balls) {
      if (b.inPocket) continue;

      b.x += b.vx * dt;
      b.y += b.vy * dt;

      const speedBefore = Math.hypot(b.vx, b.vy);
      let bounced = false;

      if (b.x < L) { b.x = L; b.vx *= -1; bounced = true; }
      if (b.x > R) { b.x = R; b.vx *= -1; bounced = true; }
      if (b.y < T) { b.y = T; b.vy *= -1; bounced = true; }
      if (b.y > B) { b.y = B; b.vy *= -1; bounced = true; }

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
        const d2 = dx*dx + dy*dy;

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

          try {
            this.snd_hit.currentTime = 0;
            this.snd_hit.play();
          } catch {}

          if (a.number === 0 || b.number === 0) {
            this.applyPostImpactSpin();
          }
        }
      }
    }

    // POCKETING
    const pockets = [
      { x: this.sidebarWidth + this.tableInset, y: this.tableInset },
      { x: this.sidebarWidth + (this.width - this.sidebarWidth) / 2, y: this.tableInset },
      { x: this.sidebarWidth + (this.width - this.sidebarWidth) - this.tableInset, y: this.tableInset },
      { x: this.sidebarWidth + this.tableInset, y: this.height - this.tableInset },
      { x: this.sidebarWidth + (this.width - this.sidebarWidth) / 2, y: this.height - this.tableInset },
      { x: this.sidebarWidth + (this.width - this.sidebarWidth) - this.tableInset, y: this.height - this.tableInset }
    ];

    for (const b of this.balls) {
      if (b.inPocket) continue;

      for (const p of pockets) {
        const dx = b.x - p.x;
        const dy = b.y - p.y;
        if (dx*dx + dy*dy < this.pocketRadius * this.pocketRadius) {
          b.inPocket = true;
          b.vx = 0;
          b.vy = 0;

          try {
            this.snd_pocket.currentTime = 0;
            this.snd_pocket.play();
          } catch {}

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

    cue.vx -= dx * (-this.spinY) * 0.3;
    cue.vy -= dy * (-this.spinY) * 0.3;
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
      return {
        type: "none",
        endX: cue.x + ray.dx * 3000,
        endY: cue.y + ray.dy * 3000
      };
    }

    if (first.type === "ball")    return this.buildBallImpactData(ray, first);
    if (first.type === "cushion") return this.buildCushionImpactData(ray, first);
    return null;
  }

  raycastBalls(ray, ignoreNum) {
    let closest = null;
    const R = this.ballRadius;

    for (const b of this.balls) {
      if (b.number === ignoreNum) continue;
      if (b.inPocket) continue;

      const lx = b.x - ray.ox;
      const ly = b.y - ray.oy;

      const tProj = lx * ray.dx + ly * ray.dy;
      if (tProj <= 0) continue;

      const px = ray.ox + ray.dx * tProj;
      const py = ray.oy + ray.dy * tProj;

      const dx = b.x - px;
      const dy = b.y - py;
      const d2 = dx*dx + dy*dy;

      if (d2 <= R*R) {
        const offset = Math.sqrt(R*R - d2);
        const tHit   = tProj - offset;
        if (tHit > 0) {
          if (!closest || tHit < closest.dist) {
            closest = {
              type: "ball",
              ball: b,
              dist: tHit,
              hitX: ray.ox + ray.dx * tHit,
              hitY: ray.oy + ray.dy * tHit
            };
          }
        }
      }
    }
    return closest;
  }

  raycastCushions(ray) {
    const L = this.sidebarWidth + this.tableInset + this.ballRadius;
    const R = this.sidebarWidth + (this.width - this.sidebarWidth) -
              this.tableInset - this.ballRadius;
    const T = this.tableInset + this.ballRadius;
    const B = this.height - this.tableInset - this.ballRadius;

    const hits = [];

    const test = (t, x, y, type) => {
      if (t > 0) hits.push({
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
      x = ray.ox + t * ray.dx;
      if (x >= L && x <= R) test(t, x, B, "horizontal");
    }

    if (hits.length === 0) return null;
    hits.sort((a, b) => a.dist - b.dist);
    return hits[0];
  }

  buildBallImpactData(ray, impact) {
    const b = impact.ball;

    const dx = b.x - impact.hitX;
    const dy = b.y - impact.hitY;
    const d  = Math.hypot(dx, dy) || 1;

    const cx = b.x - (dx / d) * this.ballRadius;
    const cy = b.y - (dy / d) * this.ballRadius;

    const gx = b.x - (dx / d) * (this.ballRadius * 2);
    const gy = b.y - (dy / d) * (this.ballRadius * 2);

    const cont = this.computeContinuation(ray);

    return {
      type: "ball",
      endX: impact.hitX,
      endY: impact.hitY,
      ballX: b.x,
      ballY: b.y,
      contactX: cx,
      contactY: cy,
      ghostX: gx,
      ghostY: gy,
      contDX: cont.dx,
      contDY: cont.dy
    };
  }

  buildCushionImpactData(ray, impact) {
    let nx = 0, ny = 0;
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

  computeContinuation(ray) {
    let dx = ray.dx;
    let dy = ray.dy;

    dx += this.spinX * 0.12;
    dy += -this.spinY * 0.12;

    const len = Math.hypot(dx, dy) || 1;
    return { dx: dx / len, dy: dy / len };
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
      cue && !cue.inPocket &&
      this.inputEnabled &&
      !this.animating &&
      !this.ballInHand
    ) {
      this.drawAimSystem(ctx, cue);
    }

    // Draw ball-in-hand ghost
    if (this.ballInHand) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(this.ballInHandGhost.x, this.ballInHandGhost.y, this.ballRadius, 0, Math.PI * 2);
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

    const cx = 50, cy = 90, r = this.spinBallSize / 2;

    ctx.strokeStyle = "rgba(0,255,100,0.35)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
    ctx.stroke();

    const ballGrad = ctx.createRadialGradient(
      cx - 5, cy - 5, 4,
      cx, cy, r
    );
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

    const barX = 36, barY = 200, barW = 28, barH = 140;

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
      this.canvas.style.transform =
        `translateX(${Math.sin(Date.now() / 40) * 2}px)`;
    } else {
      this.canvas.style.transform = "";
    }

    ctx.restore();
  }

  /***************************************************
   * DRAW TABLE + POCKETS
   ***************************************************/
  drawTable(ctx) {
    const left   = this.sidebarWidth + this.tableInset;
    const top    = this.tableInset;
    const width  = (this.width - this.sidebarWidth) - this.tableInset * 2;
    const height = this.height - this.tableInset * 2;

    ctx.fillStyle = "#003300";
    ctx.fillRect(left, top, width, height);

    ctx.strokeStyle = "#00FF00";
    ctx.lineWidth   = 4;
    ctx.strokeRect(left, top, width, height);

    const pockets = [
      { x: this.sidebarWidth + this.tableInset, y: this.tableInset },
      { x: this.sidebarWidth + (this.width - this.sidebarWidth) / 2, y: this.tableInset },
      { x: this.sidebarWidth + (this.width - this.sidebarWidth) - this.tableInset, y: this.tableInset },
      { x: this.sidebarWidth + this.tableInset, y: this.height - this.tableInset },
      { x: this.sidebarWidth + (this.width - this.sidebarWidth) / 2, y: this.height - this.tableInset },
      { x: this.sidebarWidth + (this.width - this.sidebarWidth) - this.tableInset, y: this.height - this.tableInset }
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
   * AIM SYSTEM RENDER
   ***************************************************/
  drawAimSystem(ctx, cue) {
    const data = this.computeAimData();
    if (!data) return;

    if (data.type === "none") this.drawNoImpactGuide(ctx, cue, data);
    else if (data.type === "ball") this.drawBallImpactGuide(ctx, cue, data);
    else if (data.type === "cushion") this.drawCushionImpactGuide(ctx, cue, data);

    this.drawCue(ctx, cue);
  }

  drawNoImpactGuide(ctx, cue, data) {
    ctx.save();
    ctx.strokeStyle = "rgba(0,255,0,0.9)";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(cue.x, cue.y);
    ctx.lineTo(data.endX, data.endY);
    ctx.stroke();
    ctx.restore();
  }

  drawBallImpactGuide(ctx, cue, data) {
    ctx.save();

    ctx.strokeStyle = "rgba(0,255,0,0.9)";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(cue.x, cue.y);
    ctx.lineTo(data.endX, data.endY);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(data.contactX, data.contactY, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(data.ghostX, data.ghostY, this.ballRadius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fill();

    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.beginPath();
    ctx.arc(data.ghostX, data.ghostY, this.ballRadius, 0, Math.PI * 2);
    ctx.stroke();

    const dx = Math.cos(this.aimAngle);
    const dy = Math.sin(this.aimAngle);
    const ext = 260;

    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = "rgba(0,255,0,0.35)";
    ctx.beginPath();
    ctx.moveTo(data.endX, data.endY);
    ctx.lineTo(data.endX + dx * ext, data.endY + dy * ext);
    ctx.stroke();

    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(0,255,255,0.45)";
    ctx.beginPath();
    ctx.moveTo(data.endX, data.endY);
    ctx.lineTo(
      data.endX + data.contDX * 200,
      data.endY + data.contDY * 200
    );
    ctx.stroke();

    ctx.restore();
  }

  drawCushionImpactGuide(ctx, cue, data) {
    ctx.save();

    ctx.strokeStyle = "rgba(0,255,0,0.9)";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(cue.x, cue.y);
    ctx.lineTo(data.endX, data.endY);
    ctx.stroke();

    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = "rgba(0,255,0,0.35)";
    ctx.beginPath();
    ctx.moveTo(data.endX, data.endY);
    ctx.lineTo(
      data.endX + data.reflDX * 260,
      data.endY + data.reflDY * 260
    );
    ctx.stroke();

    ctx.restore();
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
    if (firstContactNumber !== null && firstContactNumber !== 0 && firstContactNumber !== 8) {
      if (firstContactNumber >= 1 && firstContactNumber <= 7)  firstHitColour = "red";
      else if (firstContactNumber >= 9 && firstContactNumber <= 15) firstHitColour = "yellow";
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
      const allTargetLeft = this.balls.some(b => !b.inPocket && (
        (target === "red"    && b.number >= 1 && b.number <= 7) ||
        (target === "yellow" && b.number >= 9 && b.number <= 15)
      ));

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
  enterBallInHandMode() {
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
    this.ballInHandGhost.x = x;
    this.ballInHandGhost.y = y;
    this.render();
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
    this.render();
  }
}
