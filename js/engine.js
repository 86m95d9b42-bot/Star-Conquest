// Star Conquest — game rules & turn engine.
// Design-accurate ruleset filling documented gaps left by the source
// research (Strategic Commander, ZindaWare, Palm OS ~2001-2003).
window.SC = window.SC || {};

SC.CONST = {
  UNIVERSE_SIZES: { tiny: 12, small: 24, medium: 40, large: 60 },

  // World area scales in direct proportion to planet count (area is
  // width^2 for a fixed aspect ratio, so width scales with the square
  // root of the count) — Large has 5x Tiny's planets and 5x its area,
  // so planet density/spacing stays the same across every universe
  // size instead of packing tighter as the count goes up.
  WORLD_REFERENCE_PLANET_COUNT: 12,
  WORLD_REFERENCE_WIDTH: 1664,

  PLANET_CLASSES: [
    { id: 1, name: 'I',   slots: 2,  weight: 34 },
    { id: 2, name: 'II',  slots: 4,  weight: 27 },
    { id: 3, name: 'III', slots: 6,  weight: 20 },
    { id: 4, name: 'IV',  slots: 8,  weight: 13 },
    { id: 5, name: 'V',   slots: 10, weight: 6  },
  ],

  SHIP_ORDER: ['scout', 'fighter', 'cruiser', 'dreadnought'],
  SHIP_TYPES: {
    scout:       { id: 'scout',       name: 'Scout',       icon: '✈️', cost: 30,  minTech: 0, atk: 1,  def: 1,  speed: 2.4 },
    fighter:     { id: 'fighter',     name: 'Fighter',     icon: '\u{1F680}',    cost: 60,  minTech: 1, atk: 3,  def: 2,  speed: 1.8 },
    cruiser:     { id: 'cruiser',     name: 'Cruiser',     icon: '\u{1F6F8}',    cost: 150, minTech: 3, atk: 7,  def: 6,  speed: 1.3 },
    dreadnought: { id: 'dreadnought', name: 'Dreadnought', icon: '⚔️', cost: 400, minTech: 6, atk: 18, def: 15, speed: 0.9 },
  },

  FACTORY_BASE_COST: 50,
  FACTORY_COST_GROWTH: 1.45,
  LAB_BASE_COST: 60,
  LAB_COST_GROWTH: 1.45,
  FACTORY_OUTPUT: 6,
  LAB_OUTPUT: 4,

  // Cumulative tech points required to reach each tech level (index = level).
  TECH_THRESHOLDS: [0, 240, 600, 1100, 1800, 2700, 3900, 5400, 7300, 9700, 12600],
  TECH_COMBAT_BONUS: 0.12,

  MOVE_UNIT_DISTANCE: 95,
  CLASS_DEFENSE_BONUS: 2.2, // flat defense per planet class, defenders' home turf advantage

  // Combat plays out over rounds instead of one roll: each round's
  // damage is a side's usual power formula divided by ROUND_DIVISOR,
  // so a lopsided fight still ends in round 1 (nothing changes there)
  // while a close fight naturally drags out several rounds of
  // attrition. COMBAT_MAX_ROUNDS is a safety valve for near-perfectly
  // matched fights — see RULES_AND_MATH.txt section 8.
  ROUND_DIVISOR: 4,
  COMBAT_MAX_ROUNDS: 8,

  // Fog of war: vision radius (world units) projected by the human
  // player's own planets and in-transit fleets. AI opponents act on
  // full ground truth (see js/ai.js) — only the human's map view and
  // UI are restricted.
  VISION_PLANET_BASE: 90,
  VISION_PLANET_PER_CLASS: 22,
  VISION_FLEET_BASE: 65,
  VISION_FLEET_SCOUT_BONUS: 40,
  UNKNOWN_PLANET_CLASS: 2, // radius fog planets render/hit-test at, so silhouette size can't leak true class

  START_CREDITS: 150,
  START_FACTORIES: 2,
  START_LABS: 1,
  START_SHIPS: { scout: 3, fighter: 2 },

  PLAYER_COLORS: ['#3ad6b0', '#5b8cff', '#ff8a3d', '#e05bd0', '#f2d94e', '#ff5d6c', '#7ee787', '#c792ea', '#5ec8d8'],
};

const C = SC.CONST;

function techLevelFromPoints(points) {
  let level = 0;
  for (let i = 1; i < C.TECH_THRESHOLDS.length; i++) {
    if (points >= C.TECH_THRESHOLDS[i]) level = i; else break;
  }
  return level;
}

function facilityCost(base, growth, existingCount) {
  return Math.ceil(base * Math.pow(growth, existingCount));
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function fleetPowerSum(counts, statKey) {
  let sum = 0;
  for (const id of C.SHIP_ORDER) sum += (counts[id] || 0) * C.SHIP_TYPES[id][statKey];
  return sum;
}

function fleetShipTotal(counts) {
  let n = 0;
  for (const id of C.SHIP_ORDER) n += counts[id] || 0;
  return n;
}

function fleetMinSpeed(counts) {
  let min = Infinity;
  for (const id of C.SHIP_ORDER) if ((counts[id] || 0) > 0) min = Math.min(min, C.SHIP_TYPES[id].speed);
  return min === Infinity ? 1.5 : min;
}

function emptyCounts() { return { scout: 0, fighter: 0, cruiser: 0, dreadnought: 0 }; }

function fleetPosition(state, fleet) {
  const from = state.planets.find(p => p.id === fleet.from);
  const to = state.planets.find(p => p.id === fleet.to);
  const progress = Math.min(1, Math.max(0, 1 - (fleet.arrivalTurn - state.turn) / Math.max(1, fleet.totalTurns)));
  return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress };
}

SC.Engine = {
  techLevelFromPoints,
  facilityCost,
  fleetPower: fleetPowerSum,
  fleetShipTotal,
  distance: dist,
  emptyCounts,
  fleetPosition,

  estimateAttackPower(counts, techLevel) {
    return fleetPowerSum(counts, 'atk') * (1 + C.TECH_COMBAT_BONUS * techLevel);
  },

  estimateDefensePower(state, planet) {
    if (planet.owner) {
      const player = SC.Engine.playerById(state, planet.owner);
      return (fleetPowerSum(planet.stationed, 'def') + C.CLASS_DEFENSE_BONUS * planet.classId)
        * (1 + C.TECH_COMBAT_BONUS * player.techLevel);
    }
    return planet.neutralDefense;
  },

  newGame(opts) {
    const { universeSize, rivalCount, difficulty, playerColor, rng, aspect } = opts;
    const map = SC.MapGen.generate({
      planetCount: C.UNIVERSE_SIZES[universeSize],
      numPlayers: rivalCount + 1,
      rng,
      aspect,
    });

    const players = [];
    const colors = [playerColor, ...C.PLAYER_COLORS.filter(c => c !== playerColor)];
    for (let i = 0; i <= rivalCount; i++) {
      const isHuman = i === 0;
      players.push({
        id: isHuman ? 'player' : `ai${i}`,
        name: isHuman ? 'Commander' : `Rival ${i}`,
        isHuman,
        difficulty,
        color: colors[i % colors.length],
        credits: C.START_CREDITS,
        techPoints: 0,
        techLevel: 0,
        alive: true,
        homePlanetId: null,
      });
    }

    // Assign home planets (map already picked well-spaced candidate indices).
    map.homeIndices.forEach((planetIdx, i) => {
      const planet = map.planets[planetIdx];
      const player = players[i];
      planet.owner = player.id;
      planet.isHome = true;
      planet.factories = C.START_FACTORIES;
      planet.labs = C.START_LABS;
      planet.stationed = { ...C.START_SHIPS, cruiser: 0, dreadnought: 0 };
      planet.neutralDefense = 0;
      player.homePlanetId = planet.id;
    });

    const stats = {};
    for (const player of players) {
      stats[player.id] = { shipsBuilt: 0, planetsCaptured: 0, planetsLost: 0, battlesWon: 0, battlesLost: 0, peakPlanets: 1 };
    }

    const state = {
      turn: 1,
      status: 'active', // active | won | lost
      universeSize,
      worldW: map.worldW,
      worldH: map.worldH,
      planets: map.planets,
      players,
      fleets: [], // in-transit fleets
      log: [],
      nextFleetId: 1,
      intel: {}, // fog of war: last-known snapshot per planet id, human's POV only
      stats, // per-player running totals for the end-of-game stat screen
    };
    SC.Engine.refreshVision(state);
    return state;
  },

  // Tracks each player's largest simultaneous planet holding, for the
  // end-of-game stat screen ("empire at its peak").
  updatePeakStats(state) {
    for (const player of state.players) {
      const owned = SC.Engine.ownedPlanets(state, player.id).length;
      const s = state.stats[player.id];
      if (s && owned > s.peakPlanets) s.peakPlanets = owned;
    }
  },

  // ---- fog of war ----
  // Vision sources are the human player's own planets and in-transit
  // fleets; AI opponents read state.planets directly and are always
  // omniscient (see js/ai.js) — this only governs the human's map and
  // panel UI. Recomputed at game start and at the end of every turn.
  refreshVision(state) {
    const human = state.players.find(p => p.isHuman);
    if (!human) return;
    const visibleIds = new Set();

    for (const planet of state.planets) {
      if (planet.owner !== human.id) continue;
      const r = C.VISION_PLANET_BASE + planet.classId * C.VISION_PLANET_PER_CLASS;
      for (const target of state.planets) {
        if (dist(planet, target) <= r) visibleIds.add(target.id);
      }
    }

    for (const fleet of state.fleets) {
      if (fleet.owner !== human.id) continue;
      const pos = fleetPosition(state, fleet);
      const r = C.VISION_FLEET_BASE + ((fleet.counts.scout || 0) > 0 ? C.VISION_FLEET_SCOUT_BONUS : 0);
      for (const target of state.planets) {
        if (dist(pos, target) <= r) visibleIds.add(target.id);
      }
    }

    for (const id of Object.keys(state.intel)) state.intel[id].visible = false;
    for (const id of visibleIds) {
      const planet = SC.Engine.planetById(state, id);
      state.intel[id] = {
        visible: true,
        lastSeenTurn: state.turn,
        owner: planet.owner,
        isHome: planet.isHome,
        classId: planet.classId,
        className: planet.className,
        slots: planet.slots,
        factories: planet.factories,
        labs: planet.labs,
        stationed: { ...planet.stationed },
        neutralDefense: planet.neutralDefense,
      };
    }
  },

  // Resolves what the human currently knows about a planet: live data
  // if it's in vision right now, a stale last-known snapshot if it was
  // seen before but isn't currently in vision, or fully unknown.
  planetView(state, planet) {
    const intel = state.intel[planet.id];
    if (intel && intel.visible) {
      return {
        known: true, visible: true, stale: false,
        owner: planet.owner, isHome: planet.isHome, classId: planet.classId, className: planet.className,
        slots: planet.slots, factories: planet.factories, labs: planet.labs,
        stationed: planet.stationed, neutralDefense: planet.neutralDefense, lastSeenTurn: state.turn,
      };
    }
    if (intel) {
      return {
        known: true, visible: false, stale: true,
        owner: intel.owner, isHome: intel.isHome, classId: intel.classId, className: intel.className,
        slots: intel.slots, factories: intel.factories, labs: intel.labs,
        stationed: intel.stationed, neutralDefense: intel.neutralDefense, lastSeenTurn: intel.lastSeenTurn,
      };
    }
    return {
      known: false, visible: false, stale: false,
      owner: null, isHome: false, classId: C.UNKNOWN_PLANET_CLASS, className: '?',
      slots: 0, factories: 0, labs: 0, stationed: null, neutralDefense: null, lastSeenTurn: null,
    };
  },

  planetById(state, id) { return state.planets.find(p => p.id === id); },
  playerById(state, id) { return state.players.find(p => p.id === id); },

  ownedPlanets(state, playerId) { return state.planets.filter(p => p.owner === playerId); },

  addLog(state, text, kind) {
    state.log.unshift({ turn: state.turn, text, kind: kind || 'info' });
    if (state.log.length > 200) state.log.length = 200;
  },

  canBuildFacility(state, planet, kind) {
    const used = planet.factories + planet.labs;
    if (used >= planet.slots) return { ok: false, reason: 'No free building slots.' };
    const player = SC.Engine.playerById(state, planet.owner);
    const count = kind === 'factory' ? planet.factories : planet.labs;
    const base = kind === 'factory' ? C.FACTORY_BASE_COST : C.LAB_BASE_COST;
    const growth = kind === 'factory' ? C.FACTORY_COST_GROWTH : C.LAB_COST_GROWTH;
    const cost = facilityCost(base, growth, count);
    if (player.credits < cost) return { ok: false, reason: `Needs ${cost} credits.` };
    return { ok: true, cost };
  },

  buildFacility(state, planetId, kind) {
    const planet = SC.Engine.planetById(state, planetId);
    const check = SC.Engine.canBuildFacility(state, planet, kind);
    if (!check.ok) return check;
    const player = SC.Engine.playerById(state, planet.owner);
    player.credits -= check.cost;
    if (kind === 'factory') planet.factories++; else planet.labs++;
    return { ok: true };
  },

  shipCost(shipId, qty) { return C.SHIP_TYPES[shipId].cost * qty; },

  canBuildShip(state, planet, shipId, qty) {
    const player = SC.Engine.playerById(state, planet.owner);
    const def = C.SHIP_TYPES[shipId];
    if (planet.factories < 1) return { ok: false, reason: 'Requires a Factory on this planet.' };
    if (player.techLevel < def.minTech) return { ok: false, reason: `Requires Tech Level ${def.minTech}.` };
    const cost = def.cost * qty;
    if (player.credits < cost) return { ok: false, reason: `Needs ${cost} credits.` };
    return { ok: true, cost };
  },

  buildShip(state, planetId, shipId, qty) {
    const planet = SC.Engine.planetById(state, planetId);
    const check = SC.Engine.canBuildShip(state, planet, shipId, qty);
    if (!check.ok) return check;
    const player = SC.Engine.playerById(state, planet.owner);
    player.credits -= check.cost;
    planet.stationed[shipId] = (planet.stationed[shipId] || 0) + qty;
    state.stats[player.id].shipsBuilt += qty;
    return { ok: true };
  },

  travelTurns(state, fromPlanet, toPlanet, shipCounts) {
    const d = dist(fromPlanet, toPlanet);
    const speed = fleetMinSpeed(shipCounts);
    return Math.max(1, Math.round(d / (C.MOVE_UNIT_DISTANCE * speed)));
  },

  canSendFleet(state, fromPlanet, shipCounts) {
    for (const id of C.SHIP_ORDER) {
      if ((shipCounts[id] || 0) > (fromPlanet.stationed[id] || 0)) return { ok: false, reason: 'Not enough ships stationed.' };
    }
    if (fleetShipTotal(shipCounts) === 0) return { ok: false, reason: 'Select at least one ship.' };
    return { ok: true };
  },

  sendFleet(state, fromPlanetId, toPlanetId, shipCounts, ownerId) {
    const fromPlanet = SC.Engine.planetById(state, fromPlanetId);
    const toPlanet = SC.Engine.planetById(state, toPlanetId);
    const check = SC.Engine.canSendFleet(state, fromPlanet, shipCounts);
    if (!check.ok) return check;

    for (const id of C.SHIP_ORDER) fromPlanet.stationed[id] -= (shipCounts[id] || 0);
    const eta = SC.Engine.travelTurns(state, fromPlanet, toPlanet, shipCounts);
    const fleet = {
      id: state.nextFleetId++,
      owner: ownerId,
      from: fromPlanetId,
      to: toPlanetId,
      counts: { ...shipCounts },
      departTurn: state.turn,
      arrivalTurn: state.turn + eta,
      totalTurns: eta,
    };
    state.fleets.push(fleet);
    const player = SC.Engine.playerById(state, ownerId);
    SC.Engine.addLog(state, `${player.name} launches a fleet from ${fromPlanet.name} to ${toPlanet.name} (ETA ${eta} turn${eta > 1 ? 's' : ''}).`, 'move');
    return { ok: true, fleet };
  },

  // ---- combat ----
  // Plays out over rounds instead of one roll: each round both sides
  // deal damage from their CURRENT (already-attritted) strength, so a
  // lopsided fight still ends in round 1 (nothing changes there) while
  // an even fight naturally drags out several rounds. See
  // RULES_AND_MATH.txt section 8 for the full writeup. Returns a
  // structured battle report (or null for a same-owner reinforcement)
  // so the UI can replay it round by round for the human player.
  resolveArrival(state, fleet) {
    const planet = SC.Engine.planetById(state, fleet.to);
    const attacker = SC.Engine.playerById(state, fleet.owner);

    if (planet.owner === fleet.owner) {
      // Reinforcing own territory.
      for (const id of C.SHIP_ORDER) planet.stationed[id] = (planet.stationed[id] || 0) + (fleet.counts[id] || 0);
      SC.Engine.addLog(state, `${attacker.name}'s fleet reinforces ${planet.name}.`, 'move');
      return null;
    }

    const defenderPlayer = planet.owner ? SC.Engine.playerById(state, planet.owner) : null;
    const isNeutral = !defenderPlayer;

    const atk = { ...fleet.counts };
    const def = isNeutral ? emptyCounts() : { ...planet.stationed };
    let neutralHP = isNeutral ? planet.neutralDefense : 0;
    // Snapshot starting strength for the report, before the round loop
    // (below) and the final ownership mutation (further down) both
    // overwrite/reassign these.
    const attackerStart = { ...atk };
    const defenderStart = isNeutral ? { neutral: neutralHP } : { ...def };
    // The planet-class bonus is a fixed installation, not a ship — it
    // boosts the defender's damage output every round same as before,
    // but also soaks up a proportional share of incoming damage as an
    // invisible reserve (tracked here, separate from garrison ship
    // counts) so a garrison of 0 doesn't instantly fall to any attack;
    // it decays alongside the garrison instead of defending forever.
    let defBonusHP = isNeutral ? 0 : C.CLASS_DEFENSE_BONUS * planet.classId;

    const rounds = [];
    let roundsFought = 0;
    while (roundsFought < C.COMBAT_MAX_ROUNDS) {
      const atkAlive = fleetShipTotal(atk) > 0;
      const defAlive = isNeutral ? neutralHP > 0 : (fleetShipTotal(def) > 0 || defBonusHP > 0.05);
      if (!atkAlive || !defAlive) break;
      roundsFought++;

      const atkPowerBase = fleetPowerSum(atk, 'atk') * (1 + C.TECH_COMBAT_BONUS * attacker.techLevel);
      const defPowerBase = isNeutral
        ? neutralHP
        : (fleetPowerSum(def, 'def') + defBonusHP) * (1 + C.TECH_COMBAT_BONUS * defenderPlayer.techLevel);

      const atkDamage = (atkPowerBase / C.ROUND_DIVISOR) * (0.85 + Math.random() * 0.3);
      const defDamage = (defPowerBase / C.ROUND_DIVISOR) * (0.85 + Math.random() * 0.3);

      const defHP = isNeutral ? neutralHP : fleetPowerSum(def, 'def') + defBonusHP;
      const atkHP = fleetPowerSum(atk, 'def');

      const defFrac = defHP > 0 ? Math.min(1, atkDamage / defHP) : 1;
      const atkFrac = atkHP > 0 ? Math.min(1, defDamage / atkHP) : 1;

      const attackerLosses = emptyCounts();
      const defenderLosses = emptyCounts();
      for (const id of C.SHIP_ORDER) {
        const lostAtk = Math.min(atk[id] || 0, Math.round((atk[id] || 0) * atkFrac));
        attackerLosses[id] = lostAtk;
        atk[id] = (atk[id] || 0) - lostAtk;

        if (!isNeutral) {
          const lostDef = Math.min(def[id] || 0, Math.round((def[id] || 0) * defFrac));
          defenderLosses[id] = lostDef;
          def[id] = (def[id] || 0) - lostDef;
        }
      }
      let neutralLoss = 0;
      if (isNeutral) {
        neutralLoss = Math.min(neutralHP, Math.round(neutralHP * defFrac));
        neutralHP -= neutralLoss;
      } else {
        defBonusHP *= (1 - defFrac);
      }

      rounds.push({
        attackerPowerRolled: atkDamage,
        defenderPowerRolled: defDamage,
        attackerLosses,
        defenderLosses: isNeutral ? { neutral: neutralLoss } : defenderLosses,
        attackerRemaining: { ...atk },
        defenderRemaining: isNeutral ? { neutral: neutralHP } : { ...def },
        defenderBonusRemaining: isNeutral ? 0 : Math.round(defBonusHP * 10) / 10,
      });
    }

    const atkLeft = fleetShipTotal(atk);
    const defLeft = isNeutral ? neutralHP : fleetShipTotal(def) + defBonusHP;
    let attackerWins;
    if (atkLeft <= 0 && defLeft <= 0) attackerWins = false; // simultaneous knockout -> defender, matches old tie convention
    else if (atkLeft <= 0) attackerWins = false;
    else if (defLeft <= 0) attackerWins = true;
    else {
      // Round cap hit with both sides still standing -> decide by
      // whoever has more relative power left, same comparison the
      // old single-roll model used for its one and only roll.
      const atkP = fleetPowerSum(atk, 'atk') * (1 + C.TECH_COMBAT_BONUS * attacker.techLevel);
      const defP = isNeutral
        ? neutralHP
        : (fleetPowerSum(def, 'def') + defBonusHP) * (1 + C.TECH_COMBAT_BONUS * defenderPlayer.techLevel);
      attackerWins = atkP > defP;
    }

    const wasHome = planet.isHome && !!defenderPlayer;
    const prevOwnerId = planet.owner;

    if (attackerWins) {
      planet.owner = fleet.owner;
      planet.stationed = { ...atk };
      planet.neutralDefense = 0;

      state.stats[attacker.id].planetsCaptured++;
      state.stats[attacker.id].battlesWon++;
      if (defenderPlayer) {
        state.stats[defenderPlayer.id].planetsLost++;
        state.stats[defenderPlayer.id].battlesLost++;
      }

      SC.Engine.addLog(state, `${attacker.name} conquers ${planet.name}${prevOwnerId ? ` from ${defenderPlayer.name}` : ''}!`, 'combat');

      if (wasHome) {
        defenderPlayer.alive = false;
        SC.Engine.addLog(state, `${defenderPlayer.name}'s home world has fallen — they are eliminated!`, 'combat');
      }
    } else {
      state.stats[attacker.id].battlesLost++;
      if (isNeutral) {
        planet.neutralDefense = neutralHP;
        SC.Engine.addLog(state, `${attacker.name}'s fleet is destroyed attacking neutral ${planet.name}.`, 'combat');
      } else {
        planet.stationed = { ...def };
        state.stats[defenderPlayer.id].battlesWon++;
        SC.Engine.addLog(state, `${defenderPlayer.name} repels ${attacker.name}'s attack on ${planet.name}.`, 'combat');
      }
    }

    return {
      planetId: planet.id,
      planetName: planet.name,
      classId: planet.classId,
      className: planet.className,
      attackerId: attacker.id,
      attackerName: attacker.name,
      attackerColor: attacker.color,
      defenderId: defenderPlayer ? defenderPlayer.id : null,
      defenderName: defenderPlayer ? defenderPlayer.name : 'Neutral Defense',
      defenderColor: defenderPlayer ? defenderPlayer.color : '#5b6285',
      attackerWins,
      wasHome,
      attackerStart,
      defenderStart,
      rounds,
    };
  },

  productionTick(state) {
    for (const planet of state.planets) {
      if (!planet.owner) continue;
      const player = SC.Engine.playerById(state, planet.owner);
      if (!player || !player.alive) continue;
      player.credits += planet.factories * C.FACTORY_OUTPUT;
      player.techPoints += planet.labs * C.LAB_OUTPUT;
    }
    for (const player of state.players) {
      player.techLevel = techLevelFromPoints(player.techPoints);
    }
  },

  checkGameOver(state) {
    const human = state.players.find(p => p.isHuman);
    if (!human.alive) { state.status = 'lost'; return; }
    const rivalsAlive = state.players.filter(p => !p.isHuman && p.alive);
    if (rivalsAlive.length === 0) { state.status = 'won'; return; }
  },

  endTurn(state) {
    if (state.status !== 'active') return { battles: [] };

    for (const player of state.players) {
      if (!player.isHuman && player.alive) SC.AI.takeTurn(state, player);
    }

    state.turn++;

    SC.Engine.productionTick(state);

    const battles = [];
    const arriving = state.fleets.filter(f => f.arrivalTurn <= state.turn);
    state.fleets = state.fleets.filter(f => f.arrivalTurn > state.turn);
    for (const fleet of arriving) {
      const owner = SC.Engine.playerById(state, fleet.owner);
      if (owner && owner.alive) {
        const report = SC.Engine.resolveArrival(state, fleet);
        if (report) battles.push(report);
      }
    }

    SC.Engine.refreshVision(state);
    SC.Engine.updatePeakStats(state);

    SC.Engine.checkGameOver(state);

    return { battles };
  },
};
