// Star Conquest — canvas map renderer.
window.SC = window.SC || {};

function seededStars(seed, count) {
  const rng = SC.MapGen.seededRng(seed);
  const stars = [];
  for (let i = 0; i < count; i++) {
    stars.push({ x: rng(), y: rng(), r: rng() < 0.15 ? 1.6 : 0.9, tw: rng() * Math.PI * 2 });
  }
  return stars;
}

SC.Render = (function () {
  let canvas, ctx, dpr = 1;
  let camera = { x: 0, y: 0, scale: 1 };
  let fitScale = 1;
  let stars = [];
  let starW = 0, starH = 0;
  let t0 = performance.now();

  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    resize();
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
  }

  function fitCamera(state) {
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / state.worldW;
    const sy = rect.height / state.worldH;
    fitScale = Math.min(sx, sy) * 0.985;
    camera.scale = fitScale;
    camera.x = state.worldW / 2;
    camera.y = state.worldH / 2;
    if (starW !== state.worldW || starH !== state.worldH) {
      stars = seededStars(state.worldW * 31 + state.worldH, 260);
      starW = state.worldW; starH = state.worldH;
    }
  }

  function clampCamera(state) {
    const rect = canvas.getBoundingClientRect();
    const minScale = fitScale * 0.85;
    const maxScale = fitScale * 3.2;
    camera.scale = Math.max(minScale, Math.min(maxScale, camera.scale));
    const halfW = (rect.width / camera.scale) / 2;
    const halfH = (rect.height / camera.scale) / 2;
    const slack = 0.15;
    camera.x = Math.max(-state.worldW * slack + halfW, Math.min(state.worldW * (1 + slack) - halfW, camera.x));
    camera.y = Math.max(-state.worldH * slack + halfH, Math.min(state.worldH * (1 + slack) - halfH, camera.y));
  }

  function worldToScreen(wx, wy) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (wx - camera.x) * camera.scale + rect.width / 2,
      y: (wy - camera.y) * camera.scale + rect.height / 2,
    };
  }

  function screenToWorld(sx, sy) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (sx - rect.width / 2) / camera.scale + camera.x,
      y: (sy - rect.height / 2) / camera.scale + camera.y,
    };
  }

  function planetScreenRadius(planet) {
    const base = 7 + planet.classId * 2.6;
    return Math.max(11, base * (camera.scale / fitScale));
  }

  function planetAtScreen(sx, sy, state) {
    let hit = null, hitD = Infinity;
    for (const p of state.planets) {
      const s = worldToScreen(p.x, p.y);
      const r = planetScreenRadius(p) + 6;
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d <= r && d < hitD) { hit = p; hitD = d; }
    }
    return hit;
  }

  function ownerColor(state, ownerId, playerViewId) {
    if (!ownerId) return '#5b6285';
    const player = SC.Engine.playerById(state, ownerId);
    return player ? player.color : '#5b6285';
  }

  function draw(state, ui) {
    const rect = canvas.getBoundingClientRect();
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    // background
    const grad = ctx.createLinearGradient(0, 0, 0, rect.height);
    grad.addColorStop(0, '#070a1a');
    grad.addColorStop(1, '#0d1230');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, rect.width, rect.height);

    // starfield (parallax-lite: fixed to world space)
    const tSec = (performance.now() - t0) / 1000;
    ctx.save();
    for (const st of stars) {
      const wx = st.x * starW, wy = st.y * starH;
      const s = worldToScreen(wx, wy);
      if (s.x < -10 || s.x > rect.width + 10 || s.y < -10 || s.y > rect.height + 10) continue;
      const tw = 0.55 + 0.45 * Math.sin(tSec * 1.2 + st.tw);
      ctx.globalAlpha = tw;
      ctx.fillStyle = '#cfd6ff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, st.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // fleets in transit
    for (const fleet of state.fleets) {
      const from = SC.Engine.planetById(state, fleet.from);
      const to = SC.Engine.planetById(state, fleet.to);
      if (!from || !to) continue;
      const progress = Math.min(1, Math.max(0, 1 - (fleet.arrivalTurn - state.turn) / Math.max(1, fleet.totalTurns)));
      const s1 = worldToScreen(from.x, from.y);
      const s2 = worldToScreen(to.x, to.y);
      const color = ownerColor(state, fleet.owner);

      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.28;
      ctx.setLineDash([5, 6]);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
      ctx.stroke();
      ctx.restore();

      const fx = s1.x + (s2.x - s1.x) * progress;
      const fy = s1.y + (s2.y - s1.y) * progress;
      const ang = Math.atan2(s2.y - s1.y, s2.x - s1.x);

      ctx.save();
      ctx.translate(fx, fy);
      ctx.rotate(ang);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(7, 0);
      ctx.lineTo(-5, 4.5);
      ctx.lineTo(-5, -4.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // drag line (sending a fleet)
    if (ui.drag && ui.drag.active) {
      const from = SC.Engine.planetById(state, ui.drag.fromId);
      const s1 = worldToScreen(from.x, from.y);
      ctx.save();
      ctx.strokeStyle = '#f2d94e';
      ctx.lineWidth = 2;
      ctx.setLineDash([2, 6]);
      ctx.beginPath();
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(ui.drag.px, ui.drag.py);
      ctx.stroke();
      ctx.restore();
    }

    // planets
    for (const p of state.planets) {
      const s = worldToScreen(p.x, p.y);
      if (s.x < -40 || s.x > rect.width + 40 || s.y < -40 || s.y > rect.height + 40) continue;
      const r = planetScreenRadius(p);
      const color = ownerColor(state, p.owner);
      const isSelected = ui.selectedId === p.id;
      const isDragSource = ui.drag && ui.drag.active && ui.drag.fromId === p.id;

      if (isSelected || isDragSource) {
        ctx.save();
        ctx.strokeStyle = '#f2d94e';
        ctx.globalAlpha = 0.8;
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      const rg = ctx.createRadialGradient(s.x - r * 0.3, s.y - r * 0.3, r * 0.1, s.x, s.y, r);
      rg.addColorStop(0, lighten(color, 0.35));
      rg.addColorStop(1, color);
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();

      if (!p.owner) {
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = '#070a1a';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.arc(s.x, s.y, r * 0.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      if (p.isHome) {
        ctx.save();
        ctx.strokeStyle = '#ffffff';
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      const shipCount = SC.Engine.fleetShipTotal(p.stationed);
      if (shipCount > 0 && camera.scale > fitScale * 0.7) {
        ctx.save();
        ctx.font = `700 ${Math.max(9, r * 0.55)}px -apple-system,sans-serif`;
        ctx.fillStyle = '#04150f';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(4,21,15,.85)';
        ctx.beginPath();
        ctx.arc(s.x + r * 0.7, s.y + r * 0.7, Math.max(8, r * 0.42), 0, Math.PI * 2);
        ctx.fillStyle = '#f2d94e';
        ctx.fill();
        ctx.fillStyle = '#241c00';
        ctx.fillText(shipCount, s.x + r * 0.7, s.y + r * 0.72);
        ctx.restore();
      }

      if (camera.scale > fitScale * 1.05) {
        ctx.save();
        ctx.font = `600 ${Math.max(9, r * 0.4)}px -apple-system,sans-serif`;
        ctx.fillStyle = 'rgba(232,236,255,.85)';
        ctx.textAlign = 'center';
        ctx.fillText(p.name, s.x, s.y + r + 13);
        ctx.restore();
      }
    }

    ctx.restore();
  }

  function lighten(hex, amt) {
    const c = hex.replace('#', '');
    const num = parseInt(c, 16);
    let r = (num >> 16) + Math.round(255 * amt);
    let g = ((num >> 8) & 0xff) + Math.round(255 * amt);
    let b = (num & 0xff) + Math.round(255 * amt);
    r = Math.min(255, r); g = Math.min(255, g); b = Math.min(255, b);
    return `rgb(${r},${g},${b})`;
  }

  function pan(dx, dy) { camera.x -= dx / camera.scale; camera.y -= dy / camera.scale; }
  function zoomAt(sx, sy, factor, state) {
    const before = screenToWorld(sx, sy);
    camera.scale *= factor;
    clampCamera(state);
    const after = screenToWorld(sx, sy);
    camera.x += before.x - after.x;
    camera.y += before.y - after.y;
    clampCamera(state);
  }

  return { init, resize, fitCamera, clampCamera, draw, screenToWorld, worldToScreen, planetAtScreen, pan, zoomAt };
})();
