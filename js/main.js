// Star Conquest — UI glue: screens, input, panels, persistence.
(function () {
  const C = SC.CONST;
  const SAVE_KEY = 'starconquest_save_v1';

  let state = null;
  let setupOpts = { universeSize: 'medium', difficulty: 'medium', playerColor: '#3ad6b0', rivalCount: 3 };
  let ui = { selectedId: null, drag: null };
  let pointers = new Map();
  let pinchStartDist = 0;
  let pinchStartScaleRef = null;
  let panLast = null;
  let downInfo = null; // {x,y,time,planet}
  let fleetDraft = null; // { fromId, toId, counts }
  let rafRunning = false;

  const $ = (sel) => document.querySelector(sel);
  const el = (id) => document.getElementById(id);

  // ---------------- Screen management ----------------
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    el(id).classList.add('active');
  }

  // ---------------- Setup form ----------------
  function initSetupForm() {
    document.querySelectorAll('.chip-row[data-field]').forEach(row => {
      const field = row.dataset.field;
      row.querySelectorAll('.chip, .swatch').forEach(btn => {
        btn.addEventListener('click', () => {
          row.querySelectorAll('.chip, .swatch').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          setupOpts[field] = btn.dataset.value;
        });
      });
    });

    const rivalRange = el('rivalCount');
    rivalRange.addEventListener('input', () => {
      setupOpts.rivalCount = parseInt(rivalRange.value, 10);
      el('rivalCountLabel').textContent = rivalRange.value;
    });

    el('setup-form').addEventListener('submit', (e) => {
      e.preventDefault();
      startNewGame();
    });

    if (loadSave()) {
      el('continueBtn').hidden = false;
      el('continueBtn').addEventListener('click', () => {
        state = loadSave();
        enterGameScreen(true);
      });
    }
  }

  function startNewGame() {
    // Switch to the game screen first so #map-wrap has real layout to
    // measure — the generated galaxy is shaped to that exact aspect
    // ratio so it fills the canvas instead of floating in a letterboxed
    // strip of it.
    showScreen('screen-game');
    const rect = el('map-wrap').getBoundingClientRect();
    const aspect = rect.width / rect.height;

    const rng = SC.MapGen.seededRng(Date.now() ^ Math.floor(Math.random() * 1e9));
    state = SC.Engine.newGame({
      universeSize: setupOpts.universeSize,
      rivalCount: setupOpts.rivalCount,
      difficulty: setupOpts.difficulty,
      playerColor: setupOpts.playerColor,
      rng,
      aspect,
    });
    SC.Engine.addLog(state, `Campaign begins. ${state.players.length - 1} rival empire(s) contest the galaxy.`, 'info');
    saveGame();
    enterGameScreen(false);
  }

  function enterGameScreen(isContinue) {
    showScreen('screen-game');
    SC.Render.init(el('mapCanvas'));
    SC.Render.fitCamera(state);
    ui.selectedId = null;
    ui.drag = null;
    hidePlanetPanel();
    updateHUD();
    if (!rafRunning) { rafRunning = true; requestAnimationFrame(loop); }
    if (isContinue) toast('Campaign resumed.');
  }

  function loop() {
    if (state && el('screen-game').classList.contains('active')) {
      SC.Render.draw(state, ui);
    }
    requestAnimationFrame(loop);
  }

  // ---------------- Persistence ----------------
  function saveGame() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch (e) { /* ignore quota errors */ }
  }
  function loadSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (s && s.status === 'active') return s;
      return null;
    } catch (e) { return null; }
  }
  function clearSave() {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
  }

  // ---------------- HUD ----------------
  function updateHUD() {
    const human = state.players.find(p => p.isHuman);
    el('statCredits').textContent = Math.floor(human.credits);
    el('statTech').textContent = human.techLevel;
    el('statPlanets').textContent = SC.Engine.ownedPlanets(state, human.id).length;
    el('statTurn').textContent = state.turn;
  }

  let toastTimer = null;
  function toast(msg) {
    const t = el('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  // ---------------- Planet panel ----------------
  function hidePlanetPanel() {
    el('planet-panel').classList.add('hidden');
    el('sheet-backdrop').classList.add('hidden');
    ui.selectedId = null;
  }

  function openPlanetPanel(planet) {
    ui.selectedId = planet.id;
    const human = state.players.find(p => p.isHuman);
    const isMine = planet.owner === human.id;
    const owner = planet.owner ? SC.Engine.playerById(state, planet.owner) : null;

    let html = '';
    html += `<div class="planet-title">
      <h2>${planet.name}</h2>
      <span class="planet-tag">Class ${planet.className}</span>
      ${planet.isHome ? '<span class="planet-tag">🏠 Home</span>' : ''}
    </div>`;
    html += `<div class="planet-sub">${owner ? (isMine ? 'Under your command' : `Held by ${owner.name}`) : 'Unclaimed / neutral world'}</div>`;

    const slotsUsed = planet.factories + planet.labs;
    html += `<div class="stat-grid">
      <div class="stat-box"><div class="v">${slotsUsed}/${planet.slots}</div><div class="l">Slots</div></div>
      <div class="stat-box"><div class="v">${planet.factories}</div><div class="l">Factories</div></div>
      <div class="stat-box"><div class="v">${planet.labs}</div><div class="l">Labs</div></div>
    </div>`;

    if (isMine) {
      html += `<div class="section-title">Build Facilities</div>`;
      html += facilityRowHtml(planet, 'factory', '🏭', 'Factory', `+${C.FACTORY_OUTPUT} credits/turn`);
      html += facilityRowHtml(planet, 'lab', '🔬', 'Lab', `+${C.LAB_OUTPUT} tech pts/turn`);

      html += `<div class="section-title">Build Ships</div>`;
      for (const id of C.SHIP_ORDER) html += shipRowHtml(state, planet, id);

      html += `<div class="section-title">Garrison</div>`;
      html += garrisonHtml(planet.stationed);

      const hasShips = SC.Engine.fleetShipTotal(planet.stationed) > 0;
      html += `<button class="send-btn-full" id="panelSendBtn" ${hasShips ? '' : 'disabled'}>🚀 Send Fleet From ${escapeHtml(planet.name)}</button>`;
    } else {
      html += `<div class="section-title">${owner ? 'Garrison (est.)' : 'Neutral Defense'}</div>`;
      if (owner) {
        html += garrisonHtml(planet.stationed);
      } else {
        html += `<div class="garrison-line"><span>Defense Strength</span><span>${planet.neutralDefense}</span></div>`;
      }
      html += `<p class="hint">Drag from one of your fleets on the map, or use Send Fleet on an owned planet, and choose this world as the destination.</p>`;
    }

    el('planetPanelBody').innerHTML = html;
    el('planet-panel').classList.remove('hidden');
    el('sheet-backdrop').classList.remove('hidden');

    if (isMine) {
      el('planetPanelBody').querySelectorAll('[data-build-facility]').forEach(btn => {
        btn.addEventListener('click', () => {
          const kind = btn.dataset.buildFacility;
          const res = SC.Engine.buildFacility(state, planet.id, kind);
          if (res.ok) { saveGame(); updateHUD(); openPlanetPanel(planet); } else toast(res.reason);
        });
      });
      el('planetPanelBody').querySelectorAll('[data-build-ship]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.buildShip;
          const res = SC.Engine.buildShip(state, planet.id, id, 1);
          if (res.ok) { saveGame(); updateHUD(); openPlanetPanel(planet); } else toast(res.reason);
        });
      });
      const sendBtn = el('panelSendBtn');
      if (sendBtn) sendBtn.addEventListener('click', () => openFleetModal({ fromId: planet.id, toId: null }));
    }
  }

  function facilityRowHtml(planet, kind, icon, name, desc) {
    const check = SC.Engine.canBuildFacility(state, planet, kind);
    return `<div class="facility-row">
      <div class="fi-icon">${icon}</div>
      <div class="fi-body"><div class="fi-name">${name}</div><div class="fi-desc">${desc}</div></div>
      <button data-build-facility="${kind}" ${check.ok ? '' : 'disabled'}>${check.ok ? `Build · ${check.cost}` : (planet.factories + planet.labs >= planet.slots ? 'Full' : 'Build')}</button>
    </div>`;
  }

  function shipRowHtml(state, planet, id) {
    const def = C.SHIP_TYPES[id];
    const check = SC.Engine.canBuildShip(state, planet, id, 1);
    const stationed = planet.stationed[id] || 0;
    return `<div class="ship-row">
      <div class="si-icon">${def.icon}</div>
      <div class="si-body">
        <div class="si-name">${def.name} <span style="color:var(--text-dim);font-weight:400;">×${stationed}</span></div>
        <div class="si-desc">ATK ${def.atk} · DEF ${def.def} · Tech ${def.minTech}+ · ${def.cost}cr</div>
      </div>
      <button data-build-ship="${id}" ${check.ok ? '' : 'disabled'}>Build</button>
    </div>`;
  }

  function garrisonHtml(counts) {
    let rows = '';
    let any = false;
    for (const id of C.SHIP_ORDER) {
      const n = counts[id] || 0;
      if (n <= 0) continue;
      any = true;
      rows += `<div class="garrison-line"><span>${C.SHIP_TYPES[id].icon} ${C.SHIP_TYPES[id].name}</span><span>${n}</span></div>`;
    }
    return any ? rows : `<p class="hint">No ships stationed here.</p>`;
  }

  function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------------- Fleet send modal ----------------
  function openFleetModal(opts) {
    const from = SC.Engine.planetById(state, opts.fromId);
    fleetDraft = { fromId: from.id, toId: opts.toId, counts: SC.Engine.emptyCounts() };

    el('fleetModalTitle').textContent = `Send Fleet · ${from.name}`;
    renderFleetModalBody();
    el('fleet-modal').classList.remove('hidden');
  }

  function renderFleetModalBody() {
    const from = SC.Engine.planetById(state, fleetDraft.fromId);
    let html = '';

    if (fleetDraft.toId == null) {
      const others = state.planets
        .filter(p => p.id !== from.id)
        .map(p => ({ p, d: SC.Engine.distance(from, p) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 40);
      html += `<div class="section-title">Destination</div>
        <select id="destSelect" style="width:100%;padding:10px;border-radius:10px;background:var(--panel2);color:var(--text);border:1px solid var(--line);margin-bottom:10px;">
        <option value="">Choose a target planet…</option>
        ${others.map(({ p, d }) => {
          const owner = p.owner ? SC.Engine.playerById(state, p.owner) : null;
          const tag = owner ? (owner.isHuman ? 'yours' : owner.name) : 'neutral';
          return `<option value="${p.id}">${escapeHtml(p.name)} — ${tag} — ${Math.round(d)}u</option>`;
        }).join('')}
        </select>`;
    } else {
      const to = SC.Engine.planetById(state, fleetDraft.toId);
      html += `<div class="section-title">Destination</div><p style="margin-bottom:10px;">🎯 ${to.name}</p>`;
    }

    html += `<div class="section-title">Ships to Send</div><div id="fleetShipPicker">`;
    for (const id of C.SHIP_ORDER) {
      const max = from.stationed[id] || 0;
      if (max <= 0) continue;
      const def = C.SHIP_TYPES[id];
      html += `<div class="ship-picker-row">
        <div>
          <div class="sp-name">${def.icon} ${def.name}</div>
          <div class="sp-max">max ${max}</div>
        </div>
        <div class="stepper">
          <button type="button" data-step="-1" data-ship="${id}">−</button>
          <span id="qty-${id}">${fleetDraft.counts[id] || 0}</span>
          <button type="button" data-step="1" data-ship="${id}">+</button>
        </div>
      </div>`;
    }
    html += `</div>`;
    if (SC.Engine.fleetShipTotal(from.stationed) === 0) {
      html += `<p class="hint">No ships stationed at ${from.name}.</p>`;
    }

    el('fleetShipList').innerHTML = html;

    const destSelect = el('destSelect');
    if (destSelect) {
      destSelect.addEventListener('change', () => {
        fleetDraft.toId = destSelect.value ? parseInt(destSelect.value, 10) : null;
        updateFleetMeta();
      });
    }
    el('fleetShipList').querySelectorAll('[data-step]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.ship;
        const max = from.stationed[id] || 0;
        const delta = parseInt(btn.dataset.step, 10);
        fleetDraft.counts[id] = Math.max(0, Math.min(max, (fleetDraft.counts[id] || 0) + delta));
        el(`qty-${id}`).textContent = fleetDraft.counts[id];
        updateFleetMeta();
      });
    });

    updateFleetMeta();
  }

  function updateFleetMeta() {
    const from = SC.Engine.planetById(state, fleetDraft.fromId);
    const total = SC.Engine.fleetShipTotal(fleetDraft.counts);
    const power = SC.Engine.fleetPower(fleetDraft.counts, 'atk');
    el('fleetPower').textContent = total > 0 ? `Attack power ≈ ${Math.round(power)}` : '';
    const hasDest = fleetDraft.toId != null;
    if (hasDest) {
      const to = SC.Engine.planetById(state, fleetDraft.toId);
      const eta = total > 0 ? SC.Engine.travelTurns(state, from, to, fleetDraft.counts) : null;
      el('fleetEta').textContent = eta ? `ETA ${eta} turn${eta > 1 ? 's' : ''}` : '';
    } else {
      el('fleetEta').textContent = '';
    }
    el('fleetSendBtn').disabled = !(total > 0 && hasDest);
  }

  function closeFleetModal() {
    el('fleet-modal').classList.add('hidden');
    fleetDraft = null;
  }

  // ---------------- Log modal ----------------
  function renderLog() {
    const list = el('logList');
    if (state.log.length === 0) {
      list.innerHTML = `<p class="hint">No events yet.</p>`;
      return;
    }
    list.innerHTML = state.log.map(entry =>
      `<div class="log-entry ${entry.kind === 'combat' ? 'combat' : ''}">
        <div class="t">Turn ${entry.turn}</div>${escapeHtml(entry.text)}
      </div>`
    ).join('');
  }

  // ---------------- End turn / game over ----------------
  function doEndTurn() {
    const before = state.log.length;
    SC.Engine.endTurn(state);
    const newEvents = state.log.slice(0, Math.max(0, state.log.length - before));
    const combatEvents = newEvents.filter(e => e.kind === 'combat');
    updateHUD();
    hidePlanetPanel();
    if (combatEvents.length > 0) toast(combatEvents[0].text);
    else toast(`Turn ${state.turn} begins.`);
    saveGame();

    if (state.status !== 'active') {
      showEndModal();
    }
  }

  function showEndModal() {
    const won = state.status === 'won';
    el('endTitle').textContent = won ? 'Victory!' : 'Defeat';
    el('endBody').textContent = won
      ? 'Every rival home world has fallen. The galaxy is yours to command.'
      : 'Your home world has been conquered. Your empire falls silent.';
    el('end-modal').classList.remove('hidden');
    clearSave();
  }

  // ---------------- Input: pan / zoom / tap / drag-to-send ----------------
  function initInput() {
    const canvas = el('mapCanvas');

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 1) {
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left, py = e.clientY - rect.top;
        const planet = SC.Render.planetAtScreen(px, py, state);
        downInfo = { x: e.clientX, y: e.clientY, time: performance.now(), planet };
        const human = state.players.find(p => p.isHuman);
        if (planet && planet.owner === human.id && SC.Engine.fleetShipTotal(planet.stationed) > 0) {
          ui.drag = { active: false, fromId: planet.id, px, py };
        } else {
          panLast = { x: e.clientX, y: e.clientY };
        }
      } else if (pointers.size === 2) {
        ui.drag = null;
        const pts = Array.from(pointers.values());
        pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        pinchStartScaleRef = true;
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 2) {
        const pts = Array.from(pointers.values());
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinchStartDist > 10) {
          const rect = canvas.getBoundingClientRect();
          const midX = (pts[0].x + pts[1].x) / 2 - rect.left;
          const midY = (pts[0].y + pts[1].y) / 2 - rect.top;
          SC.Render.zoomAt(midX, midY, d / pinchStartDist, state);
          pinchStartDist = d;
        }
        return;
      }

      if (ui.drag) {
        const rect = canvas.getBoundingClientRect();
        ui.drag.px = e.clientX - rect.left;
        ui.drag.py = e.clientY - rect.top;
        const dx = e.clientX - downInfo.x, dy = e.clientY - downInfo.y;
        if (Math.hypot(dx, dy) > 9) ui.drag.active = true;
      } else if (panLast) {
        const dx = e.clientX - panLast.x, dy = e.clientY - panLast.y;
        SC.Render.pan(dx, dy);
        SC.Render.clampCamera(state);
        panLast = { x: e.clientX, y: e.clientY };
      }
    });

    function endPointer(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStartDist = 0;
      if (pointers.size === 0) {
        if (ui.drag && ui.drag.active) {
          const target = SC.Render.planetAtScreen(ui.drag.px, ui.drag.py, state);
          const from = SC.Engine.planetById(state, ui.drag.fromId);
          if (target && target.id !== from.id) {
            openFleetModal({ fromId: from.id, toId: target.id });
            if (fleetDraft) {
              for (const id of C.SHIP_ORDER) fleetDraft.counts[id] = from.stationed[id] || 0;
              renderFleetModalBody();
            }
          }
        } else if (downInfo) {
          const dx = e.clientX - downInfo.x, dy = e.clientY - downInfo.y;
          if (Math.hypot(dx, dy) < 9) {
            if (downInfo.planet) openPlanetPanel(downInfo.planet);
            else hidePlanetPanel();
          }
        }
        ui.drag = null;
        panLast = null;
        downInfo = null;
      }
    }
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      SC.Render.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.08 : 0.93, state);
    }, { passive: false });

    window.addEventListener('resize', () => {
      if (state) { SC.Render.resize(); SC.Render.clampCamera(state); }
    });
  }

  // ---------------- Static UI wiring ----------------
  function initChrome() {
    el('endTurnBtn').addEventListener('click', doEndTurn);

    el('planet-panel').querySelector('.sheet-handle').addEventListener('click', hidePlanetPanel);
    el('sheet-backdrop').addEventListener('click', hidePlanetPanel);

    el('logBtn').addEventListener('click', () => { renderLog(); el('log-modal').classList.remove('hidden'); });
    el('logCloseBtn').addEventListener('click', () => el('log-modal').classList.add('hidden'));

    el('menuBtn').addEventListener('click', () => el('menu-modal').classList.remove('hidden'));
    el('resumeBtn').addEventListener('click', () => el('menu-modal').classList.add('hidden'));
    el('restartBtn').addEventListener('click', () => {
      el('menu-modal').classList.add('hidden');
      if (confirm('Abandon this campaign and return to the main menu?')) {
        clearSave();
        state = null;
        showScreen('screen-start');
      }
    });

    el('fleetCancelBtn').addEventListener('click', closeFleetModal);
    el('fleetSendBtn').addEventListener('click', () => {
      const res = SC.Engine.sendFleet(state, fleetDraft.fromId, fleetDraft.toId, fleetDraft.counts, 'player');
      if (res.ok) {
        closeFleetModal();
        hidePlanetPanel();
        saveGame();
        toast('Fleet launched.');
      } else {
        toast(res.reason);
      }
    });

    el('endRestartBtn').addEventListener('click', () => {
      el('end-modal').classList.add('hidden');
      state = null;
      showScreen('screen-start');
    });
  }

  // ---------------- PWA: install prompt + service worker ----------------
  function initPWA() {
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      el('installBtn').hidden = false;
    });
    el('installBtn').addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      el('installBtn').hidden = true;
    });

    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => { /* offline support best-effort */ });
      });
    }

    if (screen.orientation && screen.orientation.lock) {
      const tryLock = () => screen.orientation.lock('portrait').catch(() => {});
      document.addEventListener('click', tryLock, { once: true });
    }
  }

  // ---------------- Boot ----------------
  document.addEventListener('DOMContentLoaded', () => {
    initSetupForm();
    initChrome();
    initInput();
    initPWA();
  });
})();
