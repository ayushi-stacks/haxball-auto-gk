// ==UserScript==
// @name         HaxBall Experimental Auto GK
// @namespace    experimental-haxball-tools
// @version      0.1.0
// @description  Experimental deterministic-physics goalkeeper controller for consensual/private testing
// @match        *://*.haxball.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * EXPERIMENTAL. Use only in rooms where every participant has agreed to automation.
 *
 * INTEGRATION POINT: the official HaxBall client keeps its state inside minified closures, so this
 * script does NOT invent variable names. All game access goes through `GameState`, which reads from a
 * "provider" object. Supply one with:
 *
 *     window.HBAGK.setProvider({
 *       read() { return {                       // return null when no game is running
 *         running: true, paused: false, controllable: true,
 *         localPlayerId: 3,
 *         ball:    { x, y, vx, vy, radius, damping, bCoef, invMass },
 *         players: [{ id, x, y, vx, vy, radius, team /*0 spec,1 red,2 blue*\/, active, kickCooldown }],
 *         stadium: { bounds:{minX,maxX,minY,maxY}, wallBCoef,
 *                    goals:[{ p0:{x,y}, p1:{x,y}, team:1|2 }],   // team = the team that DEFENDS it
 *                    posts:[{ x, y, radius, bCoef }] },          // optional
 *         constants: { ball:{...}, player:{ radius, damping, acceleration, kickingAcceleration } }, // optional
 *         view: { scale, ox, oy }                                  // optional world->canvas transform
 *       }; },
 *       setInput(state) {}                      // optional: {up,down,left,right,kick}; else key events are used
 *     });
 *
 * A best-effort duck-typing scanner (ScannerProvider) is also included, but it is UNVERIFIED against the
 * real client. If no provider is bound, the panel shows a diagnostic and no input is ever sent.
 */
(function () {
  'use strict';

  if (window.__HBAGK_LOADED__) return;
  window.__HBAGK_LOADED__ = true;

  // ===========================================================================================
  // CONFIG - every tunable lives here. Values are starting points only.
  // ===========================================================================================
  const CONFIG = {
    hotkey: 'KeyG',

    // FALLBACK values, used only when the provider does not supply the matching data.
    // They approximate the Classic stadium / default disc settings and are NOT verified.
    fallback: {
      ball: { radius: 10, damping: 0.99, bCoef: 0.5, invMass: 1 },
      player: { radius: 15, damping: 0.96, acceleration: 0.1, kickingAcceleration: 0.07, bCoef: 0.5, invMass: 0.5, kickRange: 4 },
      stadium: {
        bounds: { minX: -370, maxX: 370, minY: -170, maxY: 170 },
        wallBCoef: 1,
        postRadius: 8,
        postBCoef: 0.5,
        goalHalfHeight: 64
      }
    },

    physics: {
      // Order of operations per frame; edit to match whatever calibration shows.
      // Allowed ops: 'move' (pos += vel), 'collide' (walls/posts), 'damp' (vel *= damping)
      ballOrder: ['move', 'collide', 'damp'],
      // Player step: accelerate from input, then move, then damp.
      playerOrder: ['accelerate', 'move', 'damp'],
      diagonalNormalize: true
    },

    prediction: {
      maxFrames: 120,
      leadFrames: 0,         // latency compensation, tune per connection
      minSpeed: 0.8          // do not simulate for balls slower than this
    },

    threat: {
      dangerRange: 380,          // distance from goal at which distance threat reaches 0
      maxShootingAngle: 1.3,     // radians treated as "fully open"
      possessionDistance: 14,    // gap between disc edges for "attacker has the ball"
      shotMinSpeed: 2.5,
      shotSpeedJump: 1.2,        // sudden speed increase that indicates a kick
      shotReleaseSpeed: 1.0,
      positioningThreshold: 0.08,
      weights: { distance: 0.35, angle: 0.2, exposure: 0.2, heading: 0.15, time: 0.1 }
    },

    controller: {
      positionTolerance: 2,
      velocityTolerance: 0.5,
      brakingMargin: 5,
      deadzone: 2,
      emergencyThreshold: 8,
      targetHysteresis: 4,       // keep previous target if the new one is this close
      minCommandFrames: 2,       // minimum frames an axis command is held
      planFrames: 20,            // frames used to judge reachability of a positioning target
      recoveryFrames: 70,        // GK must be able to reach both posts within this many frames
      defensiveMargin: 12,       // depth used when the threat is low
      defensiveLateralBias: 0.3,
      angleClosure: {
        enabled: true,
        aggression: 0.85,
        goalLineMargin: 10,
        threatThreshold: 0.3,
        shotMargin: 3,
        maxDepth: 140,
        maxDepthFraction: 0.45,  // never advance past this fraction of the attacker distance
        closeRange: 90           // inside this distance the GK stops advancing
      }
    },

    kickAssist: {
      enabled: false,
      cooldown: 250,
      holdMs: 40,
      dangerRange: 160
    },

    input: {
      useKeyEvents: true,
      keys: {
        up: { code: 'ArrowUp', keyCode: 38 },
        down: { code: 'ArrowDown', keyCode: 40 },
        left: { code: 'ArrowLeft', keyCode: 37 },
        right: { code: 'ArrowRight', keyCode: 39 },
        kick: { code: 'KeyX', keyCode: 88 }
      }
    },

    loop: {
      idleIntervalMs: 100,       // observation-only cadence while Auto GK is off
      maxBackoffMs: 2000
    },

    adapter: {
      scanner: { enabled: true, intervalMs: 3000, maxNodes: 20000, maxDepth: 5 }
    },

    debug: {
      enabled: true,
      verbose: false,
      drawTrajectory: false,
      drawOverlay: true,
      panelIntervalMs: 100,
      canvasIntervalMs: 33
    },

    calibration: {
      enabled: true,
      maxAcceptableError: 1.0,
      minSamplesForJudgement: 3,
      maxSamples: 200,
      expireExtraFrames: 40
    }
  };

  // ===========================================================================================
  // Utilities
  // ===========================================================================================
  const U = {
    clamp: (v, a, b) => (v < a ? a : v > b ? b : v),
    isNum: (v) => typeof v === 'number' && isFinite(v),
    dist: (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by),
    normAngle(a) {
      while (a > Math.PI) a -= 2 * Math.PI;
      while (a < -Math.PI) a += 2 * Math.PI;
      return a;
    },
    sign: (v) => (v > 0 ? 1 : v < 0 ? -1 : 0),
    fmt(v, d) {
      return U.isNum(v) ? v.toFixed(d === undefined ? 1 : d) : '-';
    },
    num(v, fallback) {
      return U.isNum(v) ? v : fallback;
    }
  };

  // ===========================================================================================
  // Physics - operates only on copies; never mutates live state.
  // ===========================================================================================
  class Physics {
    static copyBall(src, dst) {
      dst.x = src.x; dst.y = src.y; dst.vx = src.vx; dst.vy = src.vy;
      dst.radius = src.radius; dst.damping = src.damping; dst.bCoef = src.bCoef; dst.invMass = src.invMass;
      return dst;
    }

    static newBall() {
      return { x: 0, y: 0, vx: 0, vy: 0, radius: 10, damping: 0.99, bCoef: 0.5, invMass: 1 };
    }

    // Goal geometry helper shared by physics and GoalGeometry: signed distance of (x,y) from the goal
    // line, positive on the field side; u is the position along p0->p1 (0..1 inside the mouth).
    static goalFrame(goal, stadium) {
      const dx = goal.p1.x - goal.p0.x, dy = goal.p1.y - goal.p0.y;
      const len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len;
      const b = stadium.bounds;
      const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
      const mx = (goal.p0.x + goal.p1.x) / 2, my = (goal.p0.y + goal.p1.y) / 2;
      if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; }
      return { dx, dy, len, nx, ny, mx, my };
    }

    static stepBall(ball, stadium) {
      const order = CONFIG.physics.ballOrder;
      for (let i = 0; i < order.length; i++) {
        const op = order[i];
        if (op === 'move') { ball.x += ball.vx; ball.y += ball.vy; }
        else if (op === 'damp') { ball.vx *= ball.damping; ball.vy *= ball.damping; }
        else if (op === 'collide') Physics.collideBall(ball, stadium);
      }
    }

    static collideBall(ball, st) {
      const r = ball.radius;
      // posts (circles)
      const posts = st.posts;
      for (let i = 0; i < posts.length; i++) {
        const p = posts[i];
        const dx = ball.x - p.x, dy = ball.y - p.y;
        const minD = r + p.radius;
        const d2 = dx * dx + dy * dy;
        if (d2 < minD * minD && d2 > 1e-9) {
          const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
          ball.x = p.x + nx * minD; ball.y = p.y + ny * minD;
          const vn = ball.vx * nx + ball.vy * ny;
          if (vn < 0) {
            const k = (1 + ball.bCoef * p.bCoef) * vn;
            ball.vx -= k * nx; ball.vy -= k * ny;
          }
        }
      }
      // inside a goal mouth the boundary walls do not apply (ball may enter the net)
      for (let i = 0; i < st.goals.length; i++) {
        const g = st.goals[i];
        const f = g.frame;
        const u = ((ball.x - g.p0.x) * f.dx + (ball.y - g.p0.y) * f.dy) / (f.len * f.len);
        if (u > 0 && u < 1) return;
      }
      const b = st.bounds;
      const bc = ball.bCoef * st.wallBCoef;
      if (ball.x - r < b.minX) { ball.x = b.minX + r; if (ball.vx < 0) ball.vx *= -bc; }
      else if (ball.x + r > b.maxX) { ball.x = b.maxX - r; if (ball.vx > 0) ball.vx *= -bc; }
      if (ball.y - r < b.minY) { ball.y = b.minY + r; if (ball.vy < 0) ball.vy *= -bc; }
      else if (ball.y + r > b.maxY) { ball.y = b.maxY - r; if (ball.vy > 0) ball.vy *= -bc; }
    }

    // Returns a NEW ball after `frames` frames.
    static simulateBall(ball, stadium, frames) {
      const b = Physics.copyBall(ball, Physics.newBall());
      for (let i = 0; i < frames; i++) Physics.stepBall(b, stadium);
      return b;
    }

    // Simulates until the ball centre crosses a goal line inside the mouth.
    // options: { goals:[stadium goal objects], maxFrames, xs, ys (optional Float32Array record buffers) }
    static predictGoalIntersection(ball, stadium, options) {
      const scratch = Physics._scratch || (Physics._scratch = Physics.newBall());
      const b = Physics.copyBall(ball, scratch);
      const goals = options.goals || stadium.goals;
      const maxFrames = options.maxFrames;
      const xs = options.xs, ys = options.ys;
      let prevX, prevY;
      if (xs) { xs[0] = b.x; ys[0] = b.y; }
      for (let f = 1; f <= maxFrames; f++) {
        prevX = b.x; prevY = b.y;
        Physics.stepBall(b, stadium);
        if (xs) { xs[f] = b.x; ys[f] = b.y; }
        for (let i = 0; i < goals.length; i++) {
          const g = goals[i], fr = g.frame;
          const sPrev = (prevX - g.p0.x) * fr.nx + (prevY - g.p0.y) * fr.ny;
          const sCur = (b.x - g.p0.x) * fr.nx + (b.y - g.p0.y) * fr.ny;
          if (sPrev > 0 && sCur <= 0) {
            const t = sPrev / (sPrev - sCur);
            const ix = prevX + (b.x - prevX) * t, iy = prevY + (b.y - prevY) * t;
            const u = ((ix - g.p0.x) * fr.dx + (iy - g.p0.y) * fr.dy) / (fr.len * fr.len);
            if (u >= 0 && u <= 1) {
              return {
                hit: true, frame: f - 1 + t, frameCount: f, x: ix, y: iy, vx: b.vx, vy: b.vy,
                impactSpeed: Math.hypot(b.vx, b.vy), goal: g
              };
            }
          }
        }
      }
      return { hit: false, reason: 'NO_GOAL_INTERSECTION', frameCount: maxFrames };
    }

    // Per-axis-free player model helpers (linear, so reach = coast + input response).
    static coastOffset(v, damping, n) {
      return damping === 1 ? v * n : v * (1 - Math.pow(damping, n)) / (1 - damping);
    }

    static inputRadiusTable(accel, damping, maxN, out) {
      const t = out || new Float32Array(maxN + 1);
      let vel = 0, pos = 0;
      t[0] = 0;
      for (let i = 1; i <= maxN; i++) {
        vel += accel; pos += vel; vel *= damping;
        t[i] = pos;
      }
      return t;
    }

    static comparePredictionToObservation(pred, obs) {
      return {
        frameError: obs.frame - pred.frame,
        positionError: Math.hypot((obs.x === undefined ? pred.x : obs.x) - pred.x, obs.y - pred.y)
      };
    }
  }

  // ===========================================================================================
  // GoalGeometry
  // ===========================================================================================
  class GoalGeometry {
    constructor(goal, stadium) {
      this.goal = goal;
      this.stadium = stadium;
      this.frame = goal.frame || Physics.goalFrame(goal, stadium);
      this.inward = { x: this.frame.nx, y: this.frame.ny };
      this.center = { x: this.frame.mx, y: this.frame.my };
      this.team = goal.team;
    }

    getGoalPosts() { return [this.goal.p0, this.goal.p1]; }
    getGoalCenter() { return this.center; }
    getGoalLine() { return { p0: this.goal.p0, p1: this.goal.p1, normal: this.inward, length: this.frame.len }; }
    getGoalMouth() { return { center: this.center, width: this.frame.len, inward: this.inward }; }

    calculateShootingAngle(attacker, goal) {
      const g = goal || this;
      const p0 = g.goal.p0, p1 = g.goal.p1;
      const leftAngle = Math.atan2(p0.y - attacker.y, p0.x - attacker.x);
      const rightAngle = Math.atan2(p1.y - attacker.y, p1.x - attacker.x);
      const diff = U.normAngle(rightAngle - leftAngle);
      return { leftAngle, rightAngle, centerAngle: U.normAngle(leftAngle + diff / 2), totalAngle: Math.abs(diff), signedDiff: diff };
    }

    // Exposed angular intervals of the goal, relative to the shooting-angle centre.
    calculateGoalExposure(attacker, goalkeeper, goal) {
      const sa = this.calculateShootingAngle(attacker, goal);
      const h = sa.totalAngle / 2;                 // goal spans [-h, +h] around centerAngle
      const dx = goalkeeper.x - attacker.x, dy = goalkeeper.y - attacker.y;
      const d = Math.hypot(dx, dy);
      const gkRel = U.normAngle(Math.atan2(dy, dx) - sa.centerAngle);
      const dGoal = Math.hypot(this.center.x - attacker.x, this.center.y - attacker.y);
      const inFront = d < dGoal + 1 && Math.abs(gkRel) < Math.PI / 2;
      const w = inFront && d > 1e-6 ? Math.asin(U.clamp(((goalkeeper.radius || 15) + (attacker.ballRadius || 10)) / d, 0, 1)) : 0;
      const lo = -h, hi = h;
      let left = 0, right = 0;
      if (w > 0) {
        left = Math.max(0, Math.min(hi, gkRel - w) - lo);
        right = Math.max(0, hi - Math.max(lo, gkRel + w));
      } else { left = h; right = h; }
      const total = left + right;
      return {
        leftExposure: left, rightExposure: right, totalExposure: Math.min(total, sa.totalAngle),
        shootingAngle: sa.totalAngle, blockedAngle: Math.max(0, sa.totalAngle - total),
        gkRel, gkHalfWidth: w, centerAngle: sa.centerAngle, half: h
      };
    }

    // Fraction of each half of the goal (as seen from the attacker) that the GK covers.
    calculatePostCoverage(goalkeeper, attacker, goal) {
      const e = this.calculateGoalExposure(attacker, goalkeeper, goal);
      const h = e.half;
      const lo = -h, hi = h;
      const a = e.gkRel - e.gkHalfWidth, b = e.gkRel + e.gkHalfWidth;
      const overlap = (s, t) => Math.max(0, Math.min(t, b) - Math.max(s, a));
      const half = h || 1e-9;
      const leftCoverage = e.gkHalfWidth > 0 ? overlap(lo, 0) / half : 0;
      const rightCoverage = e.gkHalfWidth > 0 ? overlap(0, hi) / half : 0;
      return { leftCoverage, rightCoverage, uncoveredLeft: 1 - leftCoverage, uncoveredRight: 1 - rightCoverage };
    }

    // Ideal 2D GK position: on the line goal-centre -> shot origin, at a depth that grows with threat
    // and distance, limited so the GK can still recover to either post.
    calculateOptimalGKPosition(p) {
      const ac = CONFIG.controller.angleClosure;
      const cc = CONFIG.controller;
      const ref = p.threat && p.threat.origin ? p.threat.origin : p.ball;
      const c = this.center;
      let dx = ref.x - c.x, dy = ref.y - c.y;
      const dRef = Math.hypot(dx, dy);
      if (dRef < 1e-6) { dx = this.inward.x; dy = this.inward.y; } else { dx /= dRef; dy /= dRef; }
      const threat = p.threat ? p.threat.threatLevel : 0;
      const k = p.gameState.getPhysicsConstants().player;

      const maxDepth = Math.max(ac.goalLineMargin, Math.min(ac.maxDepth, dRef * ac.maxDepthFraction));
      const closeness = 1 - U.clamp((dRef - ac.closeRange) / ac.closeRange, 0, 1);
      const scale = ac.aggression * U.clamp(threat * 1.5, 0, 1) * (1 - 0.5 * closeness);
      let depth = ac.goalLineMargin + (maxDepth - ac.goalLineMargin) * scale;
      if (!ac.enabled) depth = ac.goalLineMargin;

      // recovery constraint: both posts reachable within recoveryFrames from the candidate position
      const table = GoalGeometry.reachTable(k, cc.recoveryFrames);
      const R = table[cc.recoveryFrames];
      const posts = this.getGoalPosts();
      const b = this.stadium.bounds;
      let chosen = ac.goalLineMargin, reason = 'ANGLE_CLOSURE_MIN_DEPTH';
      for (let d = depth; d >= ac.goalLineMargin; d -= 2) {
        const x = U.clamp(c.x + dx * d, b.minX + k.radius, b.maxX - k.radius);
        const y = U.clamp(c.y + dy * d, b.minY + k.radius, b.maxY - k.radius);
        if (Math.hypot(x - posts[0].x, y - posts[0].y) <= R + ac.shotMargin &&
            Math.hypot(x - posts[1].x, y - posts[1].y) <= R + ac.shotMargin) {
          chosen = d; reason = d >= depth - 1e-6 ? 'ANGLE_CLOSURE' : 'ANGLE_CLOSURE_RECOVERY_LIMITED';
          break;
        }
      }
      return {
        x: U.clamp(c.x + dx * chosen, b.minX + k.radius, b.maxX - k.radius),
        y: U.clamp(c.y + dy * chosen, b.minY + k.radius, b.maxY - k.radius),
        depth: chosen, reason
      };
    }

    static reachTable(k, frames) {
      const key = k.acceleration + ':' + k.damping + ':' + frames;
      const cache = GoalGeometry._reachCache || (GoalGeometry._reachCache = {});
      return cache[key] || (cache[key] = Physics.inputRadiusTable(k.acceleration, k.damping, frames));
    }
  }

  // ===========================================================================================
  // Calibration - records prediction vs. observed goal-line crossings.
  // ===========================================================================================
  class Calibrator {
    constructor() { this.samples = []; this.pending = null; this.sumY = 0; this.maxY = 0; this.sumF = 0; }

    recordPrediction(ball, pred, now) {
      if (!CONFIG.calibration.enabled || this.pending || !pred.hit) return;
      this.pending = {
        timestamp: now,
        initialBallState: { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy },
        predictedImpactFrame: pred.frame, predictedImpactY: pred.y, predictedImpactX: pred.x,
        goal: pred.goal, lastSide: null
      };
    }

    observe(ball, now) {
      const p = this.pending;
      if (!p) return;
      const elapsedFrames = (now - p.timestamp) * 60 / 1000;
      const fr = p.goal.frame;
      const s = (ball.x - p.goal.p0.x) * fr.nx + (ball.y - p.goal.p0.y) * fr.ny;
      if (s <= 0) {
        const u = ((ball.x - p.goal.p0.x) * fr.dx + (ball.y - p.goal.p0.y) * fr.dy) / (fr.len * fr.len);
        if (u >= 0 && u <= 1) this._finish(p, elapsedFrames, ball);
        this.pending = null;
      } else if (elapsedFrames > p.predictedImpactFrame + CONFIG.calibration.expireExtraFrames) {
        this.pending = null; // saved / deflected / never arrived: no sample
      }
    }

    _finish(p, elapsedFrames, ball) {
      const cmp = Physics.comparePredictionToObservation(
        { frame: p.predictedImpactFrame, x: p.predictedImpactX, y: p.predictedImpactY },
        { frame: elapsedFrames, x: p.predictedImpactX, y: ball.y });
      const rec = Object.assign({}, p, { goal: undefined, actualImpactFrame: elapsedFrames, actualImpactY: ball.y }, cmp);
      this.samples.push(rec);
      if (this.samples.length > CONFIG.calibration.maxSamples) this.samples.shift();
      this._recompute();
    }

    _recompute() {
      let sy = 0, sf = 0, my = 0;
      for (const s of this.samples) { sy += s.positionError; sf += Math.abs(s.frameError); if (s.positionError > my) my = s.positionError; }
      const n = this.samples.length || 1;
      this.sumY = sy / n; this.sumF = sf / n; this.maxY = my;
    }

    isReliable() {
      const c = CONFIG.calibration;
      if (!c.enabled || this.samples.length < c.minSamplesForJudgement) return true; // no evidence yet
      return this.sumY <= c.maxAcceptableError;
    }

    confidence() {
      if (!this.samples.length) return null;
      return U.clamp(1 - this.sumY / (CONFIG.calibration.maxAcceptableError * 2), 0, 1);
    }

    summary() {
      return 'Samples: ' + this.samples.length + ' | Mean Y error: ' + U.fmt(this.sumY, 2) + ' px | Max Y error: ' +
        U.fmt(this.maxY, 2) + ' px | Mean frame error: ' + U.fmt(this.sumF, 1);
    }

    exportJSON() {
      return JSON.stringify({ config: CONFIG.physics, samples: this.samples, summary: { mean: this.sumY, max: this.maxY, meanFrames: this.sumF } }, null, 2);
    }
  }

  // ===========================================================================================
  // BallPredictor
  // ===========================================================================================
  class BallPredictor {
    constructor(calibrator) {
      this.calibrator = calibrator;
      this.xs = new Float32Array(CONFIG.prediction.maxFrames + 2);
      this.ys = new Float32Array(CONFIG.prediction.maxFrames + 2);
      this.result = { hit: false, reason: 'NOT_RUN' };
    }

    // Cheap pre-check so the full simulation only runs when the ball could matter.
    shouldPredict(ball, geom) {
      const sp = Math.hypot(ball.vx, ball.vy);
      if (sp < CONFIG.prediction.minSpeed) return false;
      return ball.vx * geom.inward.x + ball.vy * geom.inward.y < 0.05 * sp;
    }

    predict(ball, stadium, geom) {
      if (this.xs.length < CONFIG.prediction.maxFrames + 2) {
        this.xs = new Float32Array(CONFIG.prediction.maxFrames + 2);
        this.ys = new Float32Array(CONFIG.prediction.maxFrames + 2);
      }
      const maxFrames = CONFIG.prediction.maxFrames;
      const r = Physics.predictGoalIntersection(ball, stadium, {
        goals: geom ? [geom.goal] : stadium.goals, maxFrames, xs: this.xs, ys: this.ys
      });
      const lead = CONFIG.prediction.leadFrames;
      r.xs = this.xs; r.ys = this.ys; r.length = r.frameCount + 1;
      r.leadFrames = lead;
      r.confidence = this.calibrator ? this.calibrator.confidence() : null;
      r.reliable = this.calibrator ? this.calibrator.isReliable() : true;
      if (r.hit) {
        r.framesUntilImpact = Math.max(0, r.frame - lead);
        r.timeMs = r.frame * 1000 / 60;
        r.towardGoal = true;
        r.goalY = r.y;
      } else {
        r.towardGoal = false;
      }
      if (CONFIG.debug.drawTrajectory) {
        const t = [];
        for (let i = 0; i < r.length; i++) t.push({ x: this.xs[i], y: this.ys[i] });
        r.trajectory = t;
      }
      this.result = r;
      return r;
    }
  }

  // ===========================================================================================
  // ThreatAnalyzer
  // ===========================================================================================
  class ThreatAnalyzer {
    constructor() {
      this.prevSpeed = 0;
      this.shotLatched = false;
      this.result = {
        threatLevel: 0, mode: 'SAFE', predictedGoalY: null, framesUntilImpact: null, shootingAngle: 0,
        targetX: null, targetY: null, attackerDistance: null, goalExposure: 0, leftExposure: 0, rightExposure: 0,
        attacker: null, origin: { x: 0, y: 0 }, shotDetected: false, ballApproaching: false, possession: false
      };
    }

    reset() { this.shotLatched = false; this.prevSpeed = 0; }

    identifyAttacker(players, ball, geom, localTeam) {
      let best = null, bestScore = -Infinity;
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (!p.active || p.team === 0 || p.team === localTeam) continue;
        const dBall = Math.hypot(p.x - ball.x, p.y - ball.y);
        const dGoal = Math.hypot(p.x - geom.center.x, p.y - geom.center.y);
        let score = -dBall - 0.25 * dGoal;
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > 0.2) {
          score += 40 * ((p.vx * (ball.x - p.x) + p.vy * (ball.y - p.y)) / (sp * (dBall || 1)));
          score += 25 * (-(p.vx * geom.inward.x + p.vy * geom.inward.y) / sp);
        }
        if (score > bestScore) { bestScore = score; best = p; }
      }
      return best;
    }

    analyze(ctx) {
      const { ball, attacker, goalkeeper, geom, prediction } = ctx;
      const tc = CONFIG.threat;
      const r = this.result;
      const speed = Math.hypot(ball.vx, ball.vy);
      const toward = -(ball.vx * geom.inward.x + ball.vy * geom.inward.y) / (speed || 1); // +1 = straight at goal

      // possession: attacker disc edge close to ball edge
      let possession = false;
      if (attacker) {
        const gap = Math.hypot(attacker.x - ball.x, attacker.y - ball.y) - attacker.radius - ball.radius;
        possession = gap <= tc.possessionDistance;
      }
      // shot origin: the ball once the attacker has it, else the attacker's own position
      const origin = r.origin;
      if (attacker && !possession) { origin.x = attacker.x; origin.y = attacker.y; } else { origin.x = ball.x; origin.y = ball.y; }

      // shot detection
      const speedJump = speed - this.prevSpeed;
      this.prevSpeed = speed;
      const heading = toward > 0.15 && speed >= tc.shotMinSpeed;
      if (!this.shotLatched) {
        if (heading && prediction.hit && (speedJump >= tc.shotSpeedJump || (!possession && speed >= tc.shotMinSpeed * 1.5))) this.shotLatched = true;
      } else if (!prediction.hit || speed < tc.shotReleaseSpeed || toward <= 0) {
        this.shotLatched = false;
      }

      // geometry
      const sa = geom.calculateShootingAngle(origin, geom);
      const exp = geom.calculateGoalExposure({ x: origin.x, y: origin.y, ballRadius: ball.radius }, goalkeeper, geom);
      const dGoal = Math.hypot(origin.x - geom.center.x, origin.y - geom.center.y);

      const wts = tc.weights;
      const fDist = 1 - U.clamp(dGoal / tc.dangerRange, 0, 1);
      const fAngle = U.clamp(sa.totalAngle / tc.maxShootingAngle, 0, 1);
      const fExp = sa.totalAngle > 1e-6 ? U.clamp(exp.totalExposure / sa.totalAngle, 0, 1) : 0;
      const fHead = U.clamp(toward, 0, 1) * U.clamp(speed / (tc.shotMinSpeed * 2), 0, 1);
      const fTime = prediction.hit ? 1 - U.clamp(prediction.frame / CONFIG.prediction.maxFrames, 0, 1) : 0;
      let level = wts.distance * fDist + wts.angle * fAngle + wts.exposure * fExp + wts.heading * fHead + wts.time * fTime;
      if (attacker && !possession && attacker.team) level *= 0.8;
      if (this.shotLatched) level = Math.max(level, 0.9);
      level = U.clamp(level, 0, 1);

      let mode = 'SAFE';
      if (this.shotLatched) mode = 'SHOT';
      else if (level >= CONFIG.controller.angleClosure.threatThreshold) mode = 'ANGLE_CLOSURE';
      else if (level >= tc.positioningThreshold) mode = 'POSITIONING';

      r.threatLevel = level; r.mode = mode;
      r.attacker = attacker; r.possession = possession; r.shotDetected = this.shotLatched;
      r.ballApproaching = heading;
      r.predictedGoalY = prediction.hit ? prediction.y : null;
      r.framesUntilImpact = prediction.hit ? prediction.framesUntilImpact : null;
      r.shootingAngle = sa.totalAngle;
      r.attackerDistance = attacker ? Math.hypot(attacker.x - goalkeeper.x, attacker.y - goalkeeper.y) : null;
      r.goalExposure = exp.totalExposure; r.leftExposure = exp.leftExposure; r.rightExposure = exp.rightExposure;
      r.targetX = prediction.hit ? prediction.x : origin.x; r.targetY = prediction.hit ? prediction.y : origin.y;
      r.exposure = exp;
      return r;
    }
  }

  // ===========================================================================================
  // InputController
  // ===========================================================================================
  class InputController {
    constructor() {
      this.state = { up: false, down: false, left: false, right: false, kick: false };
      this.target = null;     // document receiving key events
      this.sink = null;       // optional provider.setInput
      this.sent = { up: false, down: false, left: false, right: false, kick: false };
    }

    setTarget(doc) { this.target = doc; }
    setSink(fn) { this.sink = fn; }

    setUp(v) { this._set('up', v); if (v) this._set('down', false); }
    setDown(v) { this._set('down', v); if (v) this._set('up', false); }
    setLeft(v) { this._set('left', v); if (v) this._set('right', false); }
    setRight(v) { this._set('right', v); if (v) this._set('left', false); }
    setKick(v) { this._set('kick', v); }

    setMovement(mx, my) {
      this.setLeft(mx < 0); this.setRight(mx > 0);
      this.setUp(my < 0); this.setDown(my > 0);
    }

    _set(name, v) { this.state[name] = !!v; this.flush(); }

    flush() {
      const names = ['up', 'down', 'left', 'right', 'kick'];
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        if (this.state[n] === this.sent[n]) continue;
        this.sent[n] = this.state[n];
        if (!this.sink && CONFIG.input.useKeyEvents) this._dispatch(n, this.state[n]);
      }
      if (this.sink) { try { this.sink(this.state); } catch (e) { /* surfaced by AutoGK on next tick */ } }
    }

    _dispatch(name, down) {
      const doc = this.target || document;
      const k = CONFIG.input.keys[name];
      const ev = new KeyboardEvent(down ? 'keydown' : 'keyup', { key: k.code, code: k.code, bubbles: true, cancelable: true });
      try {
        Object.defineProperty(ev, 'keyCode', { get: () => k.keyCode });
        Object.defineProperty(ev, 'which', { get: () => k.keyCode });
      } catch (e) { /* ignore */ }
      doc.dispatchEvent(ev);
    }

    releaseAll() {
      this.state.up = this.state.down = this.state.left = this.state.right = this.state.kick = false;
      this.flush();
    }
  }

  // ===========================================================================================
  // ScannerProvider - best-effort, UNVERIFIED duck-typing search for an accessible game-state object.
  // ===========================================================================================
  class ScannerProvider {
    constructor() { this.bound = null; this.lastScan = 0; this.scanned = 0; this.status = 'idle'; this.path = null; }

    static disc(o) {
      if (!o || typeof o !== 'object') return null;
      let x, y, vx, vy;
      if (U.isNum(o.x) && U.isNum(o.y)) {
        x = o.x; y = o.y; vx = U.num(o.xspeed, U.num(o.vx, NaN)); vy = U.num(o.yspeed, U.num(o.vy, NaN));
      } else {
        const pos = o.pos || o.position, sp = o.speed || o.velocity || o.vel;
        if (!pos || !sp || !U.isNum(pos.x) || !U.isNum(pos.y) || !U.isNum(sp.x) || !U.isNum(sp.y)) return null;
        x = pos.x; y = pos.y; vx = sp.x; vy = sp.y;
      }
      if (!U.isNum(vx) || !U.isNum(vy)) return null;
      return { x, y, vx, vy, radius: o.radius, damping: o.damping, bCoef: o.bCoef, invMass: o.invMass };
    }

    static team(t) {
      if (U.isNum(t)) return t;
      if (t && U.isNum(t.id)) return t.id;
      return 0;
    }

    static stadium(s) {
      if (!s) return null;
      let bounds = s.bounds;
      if (!bounds && U.isNum(s.width) && U.isNum(s.height)) bounds = { minX: -s.width, maxX: s.width, minY: -s.height, maxY: s.height };
      if (!bounds || !Array.isArray(s.goals)) return null;
      return {
        bounds, wallBCoef: s.wallBCoef, posts: s.posts,
        goals: s.goals.map((g) => ({ p0: g.p0, p1: g.p1, team: g.team === 'red' ? 1 : g.team === 'blue' ? 2 : g.team }))
      };
    }

    _match(o) {
      if (!o || typeof o !== 'object' || !Array.isArray(o.players) || !o.players.length) return false;
      if (!ScannerProvider.disc(o.ball || (o.discs && o.discs[0]))) return false;
      return ScannerProvider.disc(o.players[0].disc || o.players[0]) !== null;
    }

    scan() {
      const now = performance.now();
      const c = CONFIG.adapter.scanner;
      if (!c.enabled || now - this.lastScan < c.intervalMs) return;
      this.lastScan = now;
      this.status = 'scanning';
      const seen = new WeakSet();
      const queue = [{ o: window, d: 0, p: 'window' }];
      let nodes = 0;
      while (queue.length && nodes < c.maxNodes) {
        const { o, d, p } = queue.shift();
        nodes++;
        let keys;
        try { keys = Object.keys(o); } catch (e) { continue; }
        for (let i = 0; i < keys.length; i++) {
          let v;
          try { v = o[keys[i]]; } catch (e) { continue; }
          if (!v || typeof v !== 'object' || seen.has(v)) continue;
          if (v === window || (typeof Node !== 'undefined' && v instanceof Node)) continue;
          seen.add(v);
          if (this._match(v)) {
            this.bound = v; this.path = p + '.' + keys[i]; this.status = 'bound'; this.scanned = nodes;
            return;
          }
          if (d < c.maxDepth) queue.push({ o: v, d: d + 1, p: p + '.' + keys[i] });
        }
      }
      this.scanned = nodes;
      this.status = 'not-found';
    }

    read() {
      if (!this.bound) { this.scan(); if (!this.bound) return null; }
      const s = this.bound;
      try {
        const ball = ScannerProvider.disc(s.ball || s.discs[0]);
        const players = s.players.map((p, i) => {
          const d = ScannerProvider.disc(p.disc || p);
          if (!d) return null;
          d.id = U.isNum(p.id) ? p.id : i; d.team = ScannerProvider.team(p.team); d.active = p.active !== false;
          return d;
        }).filter(Boolean);
        return {
          running: s.running !== false, paused: !!s.paused, controllable: true,
          localPlayerId: U.isNum(s.localPlayerId) ? s.localPlayerId : U.isNum(s.localId) ? s.localId : (s.me && s.me.id),
          ball, players, stadium: ScannerProvider.stadium(s.stadium)
        };
      } catch (e) { this.bound = null; this.status = 'lost'; return null; }
    }
  }

  // ===========================================================================================
  // GameState - the ONLY module that touches game internals (through a provider).
  // ===========================================================================================
  class GameState {
    constructor() {
      this.provider = null;
      this.scanner = new ScannerProvider();
      this.raw = null;
      this.error = null;
      this.reason = 'NO_PROVIDER';
      this.ball = { x: 0, y: 0, vx: 0, vy: 0, radius: 10, damping: 0.99, bCoef: 0.5, invMass: 1 };
      this.players = [];
      this.pool = new Map();
      this.stadium = null;
      this.stadiumSrc = null;
      this.local = null;
      this.constants = null;
      this.stadiumFallback = false;
      this.constantsFallback = { ball: true, player: true };
    }

    setProvider(p) { this.provider = p; this.raw = null; this.stadiumSrc = null; this.stadium = null; }

    _provider() {
      if (this.provider) return this.provider;
      if (window.HBAGK_PROVIDER) return window.HBAGK_PROVIDER;
      return this.scanner;
    }

    refresh() {
      this.local = null;
      this.reason = 'OK';
      let raw = null;
      try { raw = this._provider().read(); this.error = null; } catch (e) { this.error = e; this.reason = 'PROVIDER_ERROR: ' + e.message; this.raw = null; return false; }
      this.raw = raw;
      if (!raw) { this.reason = this.provider || window.HBAGK_PROVIDER ? 'NO_GAME_STATE' : 'NO_PROVIDER (scanner: ' + this.scanner.status + ')'; return false; }
      if (!raw.ball || !U.isNum(raw.ball.x) || !U.isNum(raw.ball.y)) { this.reason = 'NO_BALL'; return false; }
      if (raw.running === false) { this.reason = 'GAME_NOT_RUNNING'; return false; }
      if (raw.paused) { this.reason = 'GAME_PAUSED'; return false; }

      this._normalizeConstants(raw);
      this._normalizeBall(raw.ball);
      this._normalizePlayers(raw.players || []);
      this._normalizeStadium(raw.stadium);

      let lp = null;
      for (let i = 0; i < this.players.length; i++) if (this.players[i].id === raw.localPlayerId) lp = this.players[i];
      if (!lp) { this.reason = 'NO_LOCAL_PLAYER'; return false; }
      if (!lp.active) { this.reason = 'LOCAL_PLAYER_INACTIVE'; return false; }
      if (raw.controllable === false) { this.reason = 'LOCAL_PLAYER_NOT_CONTROLLABLE'; return false; }
      if (lp.team !== 1 && lp.team !== 2) { this.reason = 'LOCAL_PLAYER_NOT_ON_A_TEAM'; return false; }
      let defended = null;
      for (let i = 0; i < this.stadium.goals.length; i++) if (this.stadium.goals[i].team === lp.team) defended = this.stadium.goals[i];
      if (!defended) { this.reason = 'NO_GOAL_FOR_LOCAL_TEAM'; return false; }
      this.local = lp;
      this.goal = defended;
      return true;
    }

    _normalizeConstants(raw) {
      const fb = CONFIG.fallback, rc = raw.constants || {};
      const b = rc.ball || {}, pl = rc.player || {};
      const c = this.constants || (this.constants = { ball: {}, player: {} });
      this.constantsFallback.ball = !U.isNum(b.damping);
      this.constantsFallback.player = !U.isNum(pl.acceleration);
      c.ball.radius = U.num(b.radius, U.num(raw.ball.radius, fb.ball.radius));
      c.ball.damping = U.num(b.damping, U.num(raw.ball.damping, fb.ball.damping));
      c.ball.bCoef = U.num(b.bCoef, U.num(raw.ball.bCoef, fb.ball.bCoef));
      c.ball.invMass = U.num(b.invMass, U.num(raw.ball.invMass, fb.ball.invMass));
      c.player.radius = U.num(pl.radius, fb.player.radius);
      c.player.damping = U.num(pl.damping, fb.player.damping);
      c.player.acceleration = U.num(pl.acceleration, fb.player.acceleration);
      c.player.kickingAcceleration = U.num(pl.kickingAcceleration, fb.player.kickingAcceleration);
      c.player.kickRange = U.num(pl.kickRange, fb.player.kickRange);
      c.player.bCoef = U.num(pl.bCoef, fb.player.bCoef);
      c.player.invMass = U.num(pl.invMass, fb.player.invMass);
    }

    _normalizeBall(rb) {
      const b = this.ball, c = this.constants.ball;
      b.x = rb.x; b.y = rb.y; b.vx = U.num(rb.vx, 0); b.vy = U.num(rb.vy, 0);
      b.radius = U.num(rb.radius, c.radius); b.damping = U.num(rb.damping, c.damping);
      b.bCoef = U.num(rb.bCoef, c.bCoef); b.invMass = U.num(rb.invMass, c.invMass);
    }

    _normalizePlayers(list) {
      this.players.length = 0;
      const c = this.constants.player;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (!r || !U.isNum(r.x) || !U.isNum(r.y)) continue;
        let p = this.pool.get(r.id);
        if (!p) { p = { id: r.id }; this.pool.set(r.id, p); }
        p.x = r.x; p.y = r.y; p.vx = U.num(r.vx, 0); p.vy = U.num(r.vy, 0);
        p.radius = U.num(r.radius, c.radius); p.team = r.team | 0;
        p.hasKickCooldown = !!(r.hasKickCooldown || (U.isNum(r.kickCooldown) && r.kickCooldown > 0));
        p.active = r.active !== false;
        this.players.push(p);
      }
    }

    _normalizeStadium(rs) {
      if (rs === this.stadiumSrc && this.stadium) return;
      this.stadiumSrc = rs;
      const fb = CONFIG.fallback.stadium;
      this.stadiumFallback = !rs || !rs.bounds || !Array.isArray(rs.goals) || !rs.goals.length;
      const bounds = this.stadiumFallback ? fb.bounds : rs.bounds;
      let goals;
      if (this.stadiumFallback) {
        const h = fb.goalHalfHeight;
        goals = [
          { p0: { x: bounds.minX, y: -h }, p1: { x: bounds.minX, y: h }, team: 1 },
          { p0: { x: bounds.maxX, y: -h }, p1: { x: bounds.maxX, y: h }, team: 2 }
        ];
      } else {
        goals = rs.goals.map((g) => ({ p0: g.p0, p1: g.p1, team: g.team === 'red' ? 1 : g.team === 'blue' ? 2 : g.team }));
      }
      const st = { bounds, wallBCoef: U.num(rs && rs.wallBCoef, fb.wallBCoef), goals, posts: [] };
      for (let i = 0; i < goals.length; i++) goals[i].frame = Physics.goalFrame(goals[i], st);
      if (rs && Array.isArray(rs.posts)) {
        for (const p of rs.posts) st.posts.push({ x: p.x, y: p.y, radius: U.num(p.radius, fb.postRadius), bCoef: U.num(p.bCoef, fb.postBCoef) });
      } else {
        for (const g of goals) {
          st.posts.push({ x: g.p0.x, y: g.p0.y, radius: fb.postRadius, bCoef: fb.postBCoef });
          st.posts.push({ x: g.p1.x, y: g.p1.y, radius: fb.postRadius, bCoef: fb.postBCoef });
        }
      }
      this.stadium = st;
    }

    isAvailable() { return !!this.local; }
    getBall() { return this.ball; }
    getPlayers() { return this.players; }
    getLocalPlayer() { return this.local; }
    getStadium() { return this.stadium; }
    getGoal() { return this.goal || null; }
    getPhysicsConstants() { return this.constants || { ball: CONFIG.fallback.ball, player: CONFIG.fallback.player }; }
    getView() { return this.raw && this.raw.view ? this.raw.view : null; }
    getDiagnostics() {
      return {
        available: this.isAvailable(), reason: this.reason, error: this.error ? this.error.message : null,
        provider: this.provider || window.HBAGK_PROVIDER ? 'custom' : 'scanner:' + this.scanner.status + (this.scanner.path ? ' @' + this.scanner.path : ''),
        stadiumFallback: this.stadiumFallback, constantsFallback: this.constantsFallback
      };
    }
  }

  // ===========================================================================================
  // GoalkeeperController
  // ===========================================================================================
  class GoalkeeperController {
    constructor(calibrator) {
      this.calibrator = calibrator;
      this.last = null;
      this.frame = 0;
      this.axis = { x: { cmd: 0, since: -999 }, y: { cmd: 0, since: -999 } };
      this.lastKick = -Infinity;
      this.out = { moveX: 0, moveY: 0, kick: false, targetX: 0, targetY: 0, mode: 'HOLD', reason: '', reachable: true, framesUntilImpact: null, ideal: { x: 0, y: 0 } };
      this.plan = { x: 0, y: 0, mode: 'HOLD', reason: '', reachable: true, urgent: false, ideal: { x: 0, y: 0 } };
    }

    reset() { this.last = null; this.axis.x.cmd = 0; this.axis.y.cmd = 0; this.axis.x.since = this.axis.y.since = -999; }

    // Reachable region after `frames` frames: a disc (coast position, radius from full input).
    calculateReachableGKRegion(gk, frames, k) {
      const table = GoalGeometry.reachTable(k, Math.max(frames, 0));
      const n = Math.min(Math.max(0, Math.floor(frames)), table.length - 1);
      return {
        cx: gk.x + Physics.coastOffset(gk.vx, k.damping, n),
        cy: gk.y + Physics.coastOffset(gk.vy, k.damping, n),
        radius: table[n], frames: n
      };
    }

    estimateReachablePosition(gk, target, frames, k) {
      const reg = this.calculateReachableGKRegion(gk, frames, k);
      const dx = target.x - reg.cx, dy = target.y - reg.cy;
      const d = Math.hypot(dx, dy);
      if (d <= reg.radius) return { x: target.x, y: target.y, reachable: true, region: reg };
      return { x: reg.cx + (dx / d) * reg.radius, y: reg.cy + (dy / d) * reg.radius, reachable: false, region: reg };
    }

    // Distance travelled while braking with full counter-input from speed |v| until stopped.
    calculateBrakingDistance(speed, accel, damping) {
      let v = Math.abs(speed), d = 0, n = 0;
      while (v > 1e-3 && n < 200) { d += v; v = Math.max(0, v * damping - accel); n++; }
      return d;
    }

    // Speed we would like along an axis given remaining distance.
    calculateDesiredVelocity(err, accel, damping) {
      const vmax = accel * damping / (1 - damping);
      const a = Math.abs(err);
      const v = Math.min(vmax, Math.sqrt(2 * accel * a));
      return U.sign(err) * v;
    }

    calculateMovementCommand(gk, tx, ty, k, urgent) {
      const cc = CONFIG.controller;
      const margin = urgent ? 0 : cc.brakingMargin;
      const dz = urgent ? Math.min(cc.deadzone, 0.5) : cc.deadzone;
      const decide = (p, v, t, accel) => {
        const err = t - p, ae = Math.abs(err);
        const s = U.sign(err);
        if (ae <= dz && Math.abs(v) <= cc.velocityTolerance) return 0;
        const toward = v * s > 0;
        if (toward) {
          const bd = this.calculateBrakingDistance(v, accel, k.damping);
          if (bd + margin >= ae) return Math.abs(v) <= cc.velocityTolerance && ae <= dz ? 0 : -s;
        } else if (Math.abs(v) > cc.velocityTolerance) {
          return s;
        }
        return ae <= dz ? 0 : s;
      };
      let ax = k.acceleration, ay = k.acceleration;
      let mx = decide(gk.x, gk.vx, tx, ax), my = decide(gk.y, gk.vy, ty, ay);
      if (CONFIG.physics.diagonalNormalize && mx !== 0 && my !== 0) {
        const a2 = k.acceleration * Math.SQRT1_2;
        mx = decide(gk.x, gk.vx, tx, a2); my = decide(gk.y, gk.vy, ty, a2);
      }
      return { mx, my };
    }

    // Earliest trajectory point the GK can reach; otherwise the point with the smallest shortfall.
    calculateInterception(gk, pred, k, ballRadius) {
      const lead = CONFIG.prediction.leadFrames;
      const contact = (k.radius + ballRadius) * 0.6;
      const last = Math.min(Math.ceil(pred.frame), pred.length - 1);
      const table = GoalGeometry.reachTable(k, Math.max(last, 1));
      let bestShort = Infinity, bi = last;
      for (let f = 1; f <= last; f++) {
        const avail = Math.max(0, f - lead);
        const n = Math.min(avail, table.length - 1);
        const cx = gk.x + Physics.coastOffset(gk.vx, k.damping, n);
        const cy = gk.y + Physics.coastOffset(gk.vy, k.damping, n);
        const bx = pred.xs[f], by = pred.ys[f];
        const short = Math.hypot(bx - cx, by - cy) - table[n];
        if (short <= contact) {
          return this._clip(cx, cy, table[n], bx, by, true, f);
        }
        if (short < bestShort) { bestShort = short; bi = f; }
      }
      const n = Math.min(Math.max(0, bi - lead), table.length - 1);
      const cx = gk.x + Physics.coastOffset(gk.vx, k.damping, n);
      const cy = gk.y + Physics.coastOffset(gk.vy, k.damping, n);
      return this._clip(cx, cy, table[n], pred.xs[bi], pred.ys[bi], false, bi);
    }

    _clip(cx, cy, R, bx, by, reachable, f) {
      const dx = bx - cx, dy = by - cy, d = Math.hypot(dx, dy);
      if (d <= R || d < 1e-9) return { x: bx, y: by, reachable, frame: f };
      return { x: cx + dx / d * R, y: cy + dy / d * R, reachable, frame: f };
    }

    _planTarget(ctx, k) {
      const { goalkeeper: gk, ball, threat, prediction, geom, gameState } = ctx;
      const cc = CONFIG.controller, ac = cc.angleClosure;
      const p = this.plan;
      p.urgent = false; p.reachable = true;

      // 2/3: imminent interception & predicted-shot positioning
      if (threat.mode === 'SHOT' && prediction.hit && prediction.reliable) {
        const ic = this.calculateInterception(gk, prediction, k, ball.radius);
        const emergency = prediction.framesUntilImpact <= cc.emergencyThreshold;
        p.x = ic.x; p.y = ic.y; p.reachable = ic.reachable; p.urgent = true;
        p.ideal.x = prediction.x; p.ideal.y = prediction.y;
        p.mode = emergency ? 'EMERGENCY' : 'INTERCEPT';
        p.reason = (emergency ? 'IMMINENT_SHOT' : 'SHOT_TRAJECTORY') + (ic.reachable ? '_REACHABLE' : '_BEST_EFFORT');
        return p;
      }
      if (prediction.hit && (threat.mode === 'SHOT' || threat.ballApproaching) && prediction.reliable) {
        const n = geom.inward, m = ac.goalLineMargin;
        const half = geom.frame.len / 2;
        const gy = U.clamp(prediction.y, geom.center.y - half, geom.center.y + half);
        const t = this.estimateReachablePosition(gk, { x: prediction.x + n.x * m, y: gy + n.y * m }, cc.planFrames, k);
        p.x = t.x; p.y = t.y; p.reachable = t.reachable; p.mode = 'PREDICTED_POSITION'; p.reason = 'BALL_HEADING_TO_GOAL';
        p.ideal.x = prediction.x; p.ideal.y = prediction.y;
        return p;
      }
      // 4: angle closure (also used when a shot is flagged but the prediction is not trusted)
      if (threat.mode === 'ANGLE_CLOSURE' || threat.mode === 'SHOT') {
        const ideal = geom.calculateOptimalGKPosition({ attacker: threat.attacker, ball, goalkeeper: gk, goal: geom, prediction, threat, gameState });
        const t = this.estimateReachablePosition(gk, ideal, cc.planFrames, k);
        p.x = t.x; p.y = t.y; p.reachable = t.reachable; p.mode = 'ANGLE_CLOSURE';
        p.reason = (threat.mode === 'SHOT' ? 'PREDICTION_UNRELIABLE:' : '') + ideal.reason;
        p.ideal.x = ideal.x; p.ideal.y = ideal.y;
        return p;
      }
      // 5: general defensive positioning
      if (threat.mode === 'POSITIONING') {
        const half = geom.frame.len / 2;
        const o = threat.origin;
        const by = U.clamp((o.y - geom.center.y) * cc.defensiveLateralBias, -half * 0.6, half * 0.6);
        const ideal = { x: geom.center.x + geom.inward.x * cc.defensiveMargin, y: geom.center.y + by };
        const t = this.estimateReachablePosition(gk, ideal, cc.planFrames, k);
        p.x = t.x; p.y = t.y; p.reachable = t.reachable; p.mode = 'DEFENSIVE'; p.reason = 'POSITIONING';
        p.ideal.x = ideal.x; p.ideal.y = ideal.y;
        return p;
      }
      // 6: minimal movement - return to the goal-centre guard spot
      const ideal = { x: geom.center.x + geom.inward.x * cc.defensiveMargin, y: geom.center.y + geom.inward.y * cc.defensiveMargin };
      const t = this.estimateReachablePosition(gk, ideal, cc.planFrames, k);
      p.x = t.x; p.y = t.y; p.reachable = t.reachable; p.mode = 'HOLD'; p.reason = 'SAFE';
      p.ideal.x = ideal.x; p.ideal.y = ideal.y;
      return p;
    }

    update(ctx) {
      this.frame++;
      const k = ctx.gameState.getPhysicsConstants().player;
      const cc = CONFIG.controller;
      const p = this._planTarget(ctx, k);

      // target hysteresis (never for urgent plans)
      if (!p.urgent && this.last && this.last.mode === p.mode && Math.hypot(p.x - this.last.x, p.y - this.last.y) < cc.targetHysteresis) {
        p.x = this.last.x; p.y = this.last.y;
      }
      if (!this.last) this.last = { x: 0, y: 0, mode: '' };
      this.last.x = p.x; this.last.y = p.y; this.last.mode = p.mode;

      const cmd = this.calculateMovementCommand(ctx.goalkeeper, p.x, p.y, k, p.urgent);
      let mx = cmd.mx, my = cmd.my;
      if (!p.urgent) { mx = this._hold(this.axis.x, mx); my = this._hold(this.axis.y, my); }
      else { this.axis.x.cmd = mx; this.axis.x.since = this.frame; this.axis.y.cmd = my; this.axis.y.since = this.frame; }

      const o = this.out;
      o.moveX = mx; o.moveY = my; o.targetX = p.x; o.targetY = p.y; o.mode = p.mode; o.reason = p.reason;
      o.reachable = p.reachable; o.framesUntilImpact = ctx.prediction.hit ? ctx.prediction.framesUntilImpact : null;
      o.ideal.x = p.ideal.x; o.ideal.y = p.ideal.y;
      o.kick = this._kick(ctx, k);
      return o;
    }

    // minimum command duration per axis, with an immediate release allowed
    _hold(a, cmd) {
      if (cmd === a.cmd) return cmd;
      if (this.frame - a.since < CONFIG.controller.minCommandFrames && cmd !== 0 && a.cmd !== 0) return a.cmd;
      a.cmd = cmd; a.since = this.frame;
      return cmd;
    }

    _kick(ctx, k) {
      const ka = CONFIG.kickAssist;
      if (!ka.enabled) return false;
      const { goalkeeper: gk, ball, geom, threat } = ctx;
      const now = performance.now();
      if (now - this.lastKick < ka.cooldown) return now - this.lastKick < ka.holdMs;
      if (gk.hasKickCooldown) return false;
      const reach = gk.radius + ball.radius + k.kickRange;
      if (Math.hypot(ball.x - gk.x, ball.y - gk.y) > reach) return false;
      const dGoal = Math.hypot(ball.x - geom.center.x, ball.y - geom.center.y);
      const dangerous = threat.mode === 'SHOT' || threat.mode === 'ANGLE_CLOSURE' || dGoal < ka.dangerRange;
      const leaving = (ball.vx * geom.inward.x + ball.vy * geom.inward.y) > 2;
      if (!dangerous || leaving) return false;
      this.lastKick = now;
      return true;
    }
  }

  // ===========================================================================================
  // DebugOverlay - draggable panel + non-interactive canvas for geometry/trajectory drawing.
  // ===========================================================================================
  class DebugOverlay {
    constructor() {
      this.panel = null; this.pre = null; this.canvas = null; this.ctx2d = null; this.toastEl = null;
      this.lastPanel = 0; this.lastCanvas = 0; this.toastTimer = 0; this.drag = null; this.listeners = [];
      this.lastText = '';
    }

    mount() {
      if (this.panel) return;
      const p = document.createElement('div');
      p.id = 'hbagk-panel';
      p.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;width:270px;background:rgba(10,12,16,.82);color:#cfe;font:11px/1.35 Consolas,monospace;border:1px solid #345;border-radius:4px;';
      const head = document.createElement('div');
      head.textContent = 'AUTO GK (drag)';
      head.style.cssText = 'cursor:move;padding:3px 6px;background:#123;user-select:none;';
      const pre = document.createElement('pre');
      pre.style.cssText = 'margin:0;padding:4px 6px;white-space:pre-wrap;max-height:70vh;overflow:auto;';
      const btn = document.createElement('button');
      btn.textContent = 'Export calibration JSON';
      btn.style.cssText = 'margin:4px 6px;font:10px monospace;';
      btn.addEventListener('click', () => this.onExport && this.onExport());
      p.appendChild(head); p.appendChild(pre); p.appendChild(btn);
      document.documentElement.appendChild(p);
      this.panel = p; this.pre = pre;

      const down = (e) => { this.drag = { dx: e.clientX - p.offsetLeft, dy: e.clientY - p.offsetTop }; e.preventDefault(); };
      const move = (e) => { if (this.drag) { p.style.left = (e.clientX - this.drag.dx) + 'px'; p.style.top = (e.clientY - this.drag.dy) + 'px'; p.style.right = 'auto'; } };
      const up = () => { this.drag = null; };
      head.addEventListener('mousedown', down);
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      this.listeners.push([window, 'mousemove', move], [window, 'mouseup', up]);

      const c = document.createElement('canvas');
      c.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;';
      document.documentElement.appendChild(c);
      this.canvas = c; this.ctx2d = c.getContext('2d');

      const t = document.createElement('div');
      t.style.cssText = 'position:fixed;top:40%;left:50%;transform:translate(-50%,-50%);z-index:2147483647;padding:8px 16px;background:rgba(0,0,0,.75);color:#fff;font:bold 18px monospace;border-radius:4px;display:none;pointer-events:none;';
      document.documentElement.appendChild(t);
      this.toastEl = t;
      this.setVisible(CONFIG.debug.enabled);
    }

    setVisible(v) { if (this.panel) this.panel.style.display = v ? '' : 'none'; if (!v) this.clearCanvas(); }

    toast(msg) {
      if (!this.toastEl) return;
      this.toastEl.textContent = msg; this.toastEl.style.display = 'block';
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { if (this.toastEl) this.toastEl.style.display = 'none'; }, 1500);
    }

    clearCanvas() {
      if (!this.ctx2d) return;
      this.ctx2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    updatePanel(now, s) {
      if (!CONFIG.debug.enabled || !this.pre || now - this.lastPanel < CONFIG.debug.panelIntervalMs) return;
      this.lastPanel = now;
      const f = U.fmt, L = [];
      L.push('AUTO GK: ' + (s.enabled ? 'ON' : 'OFF'));
      if (s.error) L.push('ERROR: ' + s.error);
      L.push('STATE: ' + s.diag.reason + (s.diag.stadiumFallback ? ' [stadium FALLBACK]' : ''));
      L.push('SRC: ' + s.diag.provider);
      if (!s.ready) { this._set(L.join('\n')); return; }
      const t = s.threat, b = s.ball, a = t.attacker, g = s.gk, pl = s.plan, pr = s.prediction, geom = s.geom;
      L.push('', 'MODE: ' + t.mode + ' -> ' + pl.mode, 'THREAT: ' + f(t.threatLevel, 2));
      L.push('', 'BALL', ' X:' + f(b.x) + ' Y:' + f(b.y), ' VX:' + f(b.vx, 2) + ' VY:' + f(b.vy, 2));
      L.push('', 'ATTACKER' + (t.possession ? ' (possession)' : ''));
      L.push(a ? ' X:' + f(a.x) + ' Y:' + f(a.y) + '\n VX:' + f(a.vx, 2) + ' VY:' + f(a.vy, 2) + '\n DISTANCE:' + f(t.attackerDistance) : ' none (ball-based geometry)');
      const posts = geom.getGoalPosts();
      L.push('', 'GOAL', ' LEFT POST: ' + f(posts[0].x, 0) + ',' + f(posts[0].y, 0), ' RIGHT POST: ' + f(posts[1].x, 0) + ',' + f(posts[1].y, 0));
      L.push('SHOOTING ANGLE: ' + f(t.shootingAngle * 180 / Math.PI) + ' deg', 'GOAL EXPOSURE: ' + f(t.goalExposure * 180 / Math.PI) + ' deg (L ' + f(t.leftExposure * 57.3) + ' / R ' + f(t.rightExposure * 57.3) + ')');
      L.push('', 'GK', ' X:' + f(g.x) + ' Y:' + f(g.y), ' VX:' + f(g.vx, 2) + ' VY:' + f(g.vy, 2));
      L.push('', 'TARGET', ' X:' + f(pl.targetX) + ' Y:' + f(pl.targetY), ' IDEAL: ' + f(pl.ideal.x) + ',' + f(pl.ideal.y));
      L.push('REACHABLE: ' + (pl.reachable ? 'YES' : 'NO'));
      L.push('', 'PREDICTION', ' GOAL Y: ' + (pr.hit ? f(pr.y) : '-'), ' FRAMES: ' + (pr.hit ? f(pr.framesUntilImpact) : '-'), ' IMPACT SPEED: ' + (pr.hit ? f(pr.impactSpeed, 2) : '-'));
      if (!s.reliable) L.push('PHYSICS MODEL ERROR', 'Prediction may be inaccurate.');
      L.push('', 'ACTION: ' + (pl.moveX < 0 ? 'L' : pl.moveX > 0 ? 'R' : '-') + (pl.moveY < 0 ? 'U' : pl.moveY > 0 ? 'D' : '-') + (pl.kick ? ' KICK' : ''), 'REASON: ' + pl.reason);
      if (CONFIG.calibration.enabled) L.push('', s.calib);
      if (CONFIG.debug.verbose) L.push('', 'frame ms: ' + f(s.frameMs, 2));
      this._set(L.join('\n'));
    }

    _set(text) { if (text !== this.lastText) { this.lastText = text; this.pre.textContent = text; } }

    // world -> screen
    _mapper(s) {
      const rect = document.querySelector('canvas:not(#hbagk-overlay)');
      const view = s.view;
      const cv = this.canvas;
      const dpr = window.devicePixelRatio || 1;
      const W = window.innerWidth, H = window.innerHeight;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      let r = { left: 0, top: 0, width: W, height: H };
      if (rect && rect !== cv) { const b = rect.getBoundingClientRect(); if (b.width > 100) r = b; }
      if (view && U.isNum(view.scale)) return (x, y) => [r.left + view.ox + x * view.scale, r.top + view.oy + y * view.scale];
      // approximation: whole stadium fitted into the game canvas
      const bd = s.stadium.bounds, sw = bd.maxX - bd.minX, sh = bd.maxY - bd.minY;
      const sc = Math.min(r.width / sw, r.height / sh);
      const ox = r.left + r.width / 2 - ((bd.minX + bd.maxX) / 2) * sc, oy = r.top + r.height / 2 - ((bd.minY + bd.maxY) / 2) * sc;
      return (x, y) => [ox + x * sc, oy + y * sc];
    }

    draw(now, s) {
      if (!this.ctx2d || now - this.lastCanvas < CONFIG.debug.canvasIntervalMs) return;
      this.lastCanvas = now;
      if (!CONFIG.debug.enabled || !CONFIG.debug.drawOverlay || !s.ready) { this.clearCanvas(); return; }
      const m = this._mapper(s);
      const c = this.ctx2d, dpr = window.devicePixelRatio || 1;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, window.innerWidth, window.innerHeight);
      const dot = (x, y, r, col) => { const p = m(x, y); c.fillStyle = col; c.beginPath(); c.arc(p[0], p[1], r, 0, 6.2832); c.fill(); };
      const line = (x1, y1, x2, y2, col) => { const a = m(x1, y1), b = m(x2, y2); c.strokeStyle = col; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); };
      const posts = s.geom.getGoalPosts();
      const o = s.threat.origin;
      // shooting-angle region + rays
      const A = m(o.x, o.y), P0 = m(posts[0].x, posts[0].y), P1 = m(posts[1].x, posts[1].y);
      c.fillStyle = 'rgba(255,200,0,.12)'; c.beginPath(); c.moveTo(A[0], A[1]); c.lineTo(P0[0], P0[1]); c.lineTo(P1[0], P1[1]); c.closePath(); c.fill();
      line(o.x, o.y, posts[0].x, posts[0].y, 'rgba(255,200,0,.8)');
      line(o.x, o.y, posts[1].x, posts[1].y, 'rgba(255,200,0,.8)');
      dot(posts[0].x, posts[0].y, 4, '#fff'); dot(posts[1].x, posts[1].y, 4, '#fff');
      // reachable region
      const reg = s.region;
      if (reg) { const p = m(reg.cx, reg.cy), q = m(reg.cx + reg.radius, reg.cy); c.strokeStyle = 'rgba(0,255,255,.5)'; c.beginPath(); c.arc(p[0], p[1], Math.abs(q[0] - p[0]), 0, 6.2832); c.stroke(); }
      if (s.threat.attacker) dot(s.threat.attacker.x, s.threat.attacker.y, 5, '#f55');
      dot(s.gk.x, s.gk.y, 5, '#5f5');
      dot(s.plan.ideal.x, s.plan.ideal.y, 4, '#0ff');
      dot(s.plan.targetX, s.plan.targetY, 3, '#fff');
      if (CONFIG.debug.drawTrajectory && s.prediction.trajectory) {
        c.strokeStyle = '#f0f'; c.beginPath();
        const tr = s.prediction.trajectory;
        for (let i = 0; i < tr.length; i++) { const p = m(tr[i].x, tr[i].y); if (i) c.lineTo(p[0], p[1]); else c.moveTo(p[0], p[1]); }
        c.stroke();
        if (s.prediction.hit) dot(s.prediction.x, s.prediction.y, 5, '#f0f');
      }
    }

    destroy() {
      for (const [t, n, f] of this.listeners) t.removeEventListener(n, f);
      this.listeners = [];
      clearTimeout(this.toastTimer);
      for (const el of [this.panel, this.canvas, this.toastEl]) if (el && el.parentNode) el.parentNode.removeChild(el);
      this.panel = this.canvas = this.toastEl = this.pre = this.ctx2d = null;
    }
  }

  // ===========================================================================================
  // HotkeyManager
  // ===========================================================================================
  class HotkeyManager {
    constructor() { this.handler = null; this.cb = null; }

    static isEditable(el) {
      if (!el) return false;
      const tag = (el.tagName || '').toUpperCase();
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
    }

    attach(cb) {
      this.cb = cb;
      this.handler = (e) => {
        if (e.code !== CONFIG.hotkey || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        if (HotkeyManager.isEditable(e.target) || HotkeyManager.isEditable(document.activeElement)) return;
        e.preventDefault();
        this.cb();
      };
      window.addEventListener('keydown', this.handler, true);
    }

    detach() { if (this.handler) window.removeEventListener('keydown', this.handler, true); this.handler = null; }
  }

  // ===========================================================================================
  // AutoGK - orchestrates the modules
  // ===========================================================================================
  class AutoGK {
    constructor() {
      this.gameState = new GameState();
      this.calibrator = new Calibrator();
      this.predictor = new BallPredictor(this.calibrator);
      this.threat = new ThreatAnalyzer();
      this.controller = new GoalkeeperController(this.calibrator);
      this.input = new InputController();
      this.overlay = new DebugOverlay();
      this.hotkeys = new HotkeyManager();
      this.enabled = false;
      this.destroyed = false;
      this.rafId = 0; this.timerId = 0; this.fails = 0; this.lastError = null;
      this.geom = null; this.geomKey = null;
      this.noPrediction = { hit: false, reason: 'NOT_RUN', reliable: true, towardGoal: false };
      this.snapshot = { ready: false, enabled: false, diag: {}, error: null, frameMs: 0 };
      this._onUnload = () => this.destroy();
      this._loopBound = (t) => this._loop(t);
    }

    start() {
      this.overlay.mount();
      this.overlay.onExport = () => this.exportCalibration();
      this.input.setTarget(document);
      this.hotkeys.attach(() => this.toggle());
      window.addEventListener('pagehide', this._onUnload);
      window.addEventListener('beforeunload', this._onUnload);
      this._schedule();
    }

    toggle() { if (this.enabled) this.disable('hotkey'); else this.enable(); }

    enable() {
      this.enabled = true; this.lastError = null; this.fails = 0;
      this.controller.reset(); this.threat.reset();
      this.overlay.toast('AUTO GK: ON');
      this._reschedule();
    }

    disable(why) {
      this.enabled = false;
      this.input.releaseAll();
      this.controller.reset();
      this.overlay.toast('AUTO GK: OFF' + (why && why !== 'hotkey' ? ' (' + why + ')' : ''));
      this._reschedule();
    }

    exportCalibration() {
      const json = this.calibrator.exportJSON();
      try {
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'hbagk-calibration.json';
        document.documentElement.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } catch (e) { console.log(json); }
    }

    _reschedule() { cancelAnimationFrame(this.rafId); clearTimeout(this.timerId); this._schedule(); }

    _schedule() {
      if (this.destroyed) return;
      if (this.enabled && this.fails === 0) this.rafId = requestAnimationFrame(this._loopBound);
      else {
        const ms = Math.min(CONFIG.loop.maxBackoffMs, CONFIG.loop.idleIntervalMs * Math.pow(2, Math.min(this.fails, 6)));
        this.timerId = setTimeout(() => this._loop(performance.now()), ms);
      }
    }

    _loop(now) {
      if (this.destroyed) return;
      const t0 = performance.now();
      try {
        this._tick(now || t0);
        this.fails = 0;
      } catch (e) {
        this.fails++;
        this.lastError = e && e.message ? e.message : String(e);
        this.input.releaseAll();
        if (this.enabled) { this.enabled = false; this.overlay.toast('AUTO GK: OFF (error)'); }
        if (this.fails === 1) console.error('[HBAGK]', e);
        this.snapshot.error = this.lastError; this.snapshot.enabled = false; this.snapshot.ready = false;
        this.snapshot.diag = this.gameState.getDiagnostics();
        try { this.overlay.updatePanel(performance.now() + 1e6, this.snapshot); } catch (e2) { /* ignore */ }
      }
      this.snapshot.frameMs = performance.now() - t0;
      this._schedule();
    }

    _geomFor(stadium, goal) {
      const key = stadium;
      if (this.geomKey !== key || !this.geom || this.geom.goal !== goal) {
        this.geom = new GoalGeometry(goal, stadium); this.geomKey = key;
      }
      return this.geom;
    }

    _tick(now) {
      const gs = this.gameState;
      const ok = gs.refresh();
      const snap = this.snapshot;
      snap.enabled = this.enabled; snap.error = this.lastError; snap.diag = gs.getDiagnostics();
      if (!ok) {
        if (this.enabled) this.input.releaseAll();
        this.controller.reset(); this.threat.reset();
        snap.ready = false;
        this.overlay.updatePanel(now, snap); this.overlay.draw(now, snap);
        return;
      }
      const gk = gs.getLocalPlayer(), ball = gs.getBall(), stadium = gs.getStadium();
      const geom = this._geomFor(stadium, gs.getGoal());

      const attacker = this.threat.identifyAttacker(gs.getPlayers(), ball, geom, gk.team);
      let prediction = this.noPrediction;
      if (this.predictor.shouldPredict(ball, geom)) {
        prediction = this.predictor.predict(ball, stadium, geom);
        if (prediction.hit && this.threat.shotLatched) this.calibrator.recordPrediction(ball, prediction, now);
      }
      this.calibrator.observe(ball, now);

      const ctx = { goalkeeper: gk, attacker, ball, goal: geom, geom, prediction, gameState: gs };
      const threat = this.threat.analyze(ctx);
      ctx.threat = threat;
      const cmd = this.controller.update(ctx);

      if (this.enabled) {
        this.input.setMovement(cmd.moveX, cmd.moveY);
        this.input.setKick(cmd.kick);
      }

      const k = gs.getPhysicsConstants().player;
      snap.ready = true; snap.ball = ball; snap.gk = gk; snap.geom = geom; snap.stadium = stadium;
      snap.threat = threat; snap.prediction = prediction; snap.reliable = this.calibrator.isReliable();
      snap.plan = cmd; snap.view = gs.getView(); snap.calib = this.calibrator.summary();
      snap.region = CONFIG.debug.enabled ? this.controller.calculateReachableGKRegion(gk, CONFIG.controller.planFrames, k) : null;
      this.overlay.updatePanel(now, snap);
      this.overlay.draw(now, snap);
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      cancelAnimationFrame(this.rafId); clearTimeout(this.timerId);
      try { this.input.releaseAll(); } catch (e) { /* ignore */ }
      this.hotkeys.detach();
      window.removeEventListener('pagehide', this._onUnload);
      window.removeEventListener('beforeunload', this._onUnload);
      this.overlay.destroy();
    }
  }

  // ===========================================================================================
  // Bootstrap: only start in the frame that actually hosts the game canvas.
  // ===========================================================================================
  const api = {
    CONFIG, Physics, GoalGeometry, BallPredictor, ThreatAnalyzer, GoalkeeperController, InputController,
    GameState, DebugOverlay, HotkeyManager, AutoGK, Calibrator, ScannerProvider, app: null,
    setProvider(p) {
      if (!api.app) throw new Error('HBAGK not started in this frame yet');
      api.app.gameState.setProvider(p);
      if (p && typeof p.setInput === 'function') api.app.input.setSink((s) => p.setInput(s));
    }
  };
  window.HBAGK = api;

  function boot() {
    if (api.app || typeof document === 'undefined') return;
    if (!document.querySelector('canvas')) return false;
    api.app = new AutoGK();
    api.app.start();
    return true;
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    let tries = 0;
    const poll = () => {
      if (boot() || ++tries > 600) return;
      setTimeout(poll, 500);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', poll, { once: true });
    else poll();
  }
})();
