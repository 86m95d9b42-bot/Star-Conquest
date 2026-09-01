// Star Conquest — opponent AI. Runs once per player at End Turn.
window.SC = window.SC || {};

const AI_DIFFICULTY = {
  easy:   { facilityFrac: 0.35, shipFrac: 0.25, labWeight: 0.30, reserveFrac: 0.55, marginNeeded: 1.45, attackChance: 0.45 },
  medium: { facilityFrac: 0.50, shipFrac: 0.40, labWeight: 0.42, reserveFrac: 0.35, marginNeeded: 1.20, attackChance: 0.72 },
  hard:   { facilityFrac: 0.58, shipFrac: 0.48, labWeight: 0.48, reserveFrac: 0.22, marginNeeded: 1.05, attackChance: 0.92 },
};

function fleetPower(counts, statKey) {
  const C = SC.CONST;
  let sum = 0;
  for (const id of C.SHIP_ORDER) sum += (counts[id] || 0) * C.SHIP_TYPES[id][statKey];
  return sum;
}

SC.AI = {
  takeTurn(state, player) {
    const C = SC.CONST;
    const cfg = AI_DIFFICULTY[player.difficulty] || AI_DIFFICULTY.medium;
    const owned = SC.Engine.ownedPlanets(state, player.id);
    if (owned.length === 0) return;

    // ---- 1. Facilities: spend a slice of the treasury growing infra ----
    let facilityBudget = player.credits * cfg.facilityFrac;
    for (let guard = 0; guard < 60 && facilityBudget > 1; guard++) {
      let bestPlanet = null, bestKind = null, bestCost = Infinity;
      for (const planet of owned) {
        if (planet.factories + planet.labs >= planet.slots) continue;
        const preferLab = Math.random() < cfg.labWeight;
        const order = preferLab ? ['lab', 'factory'] : ['factory', 'lab'];
        for (const kind of order) {
          const check = SC.Engine.canBuildFacility(state, planet, kind);
          if (check.ok && check.cost <= facilityBudget && check.cost < bestCost) {
            bestCost = check.cost; bestPlanet = planet; bestKind = kind;
          }
        }
      }
      if (!bestPlanet) break;
      SC.Engine.buildFacility(state, bestPlanet.id, bestKind);
      facilityBudget -= bestCost;
    }

    // ---- 2. Ships: spend another slice on the strongest ships it can field ----
    let shipBudget = player.credits * cfg.shipFrac;
    for (let guard = 0; guard < 60 && shipBudget > 1; guard++) {
      let bestPlanet = null, bestShip = null, bestCost = Infinity;
      for (const planet of owned) {
        if (planet.factories < 1) continue;
        for (let i = C.SHIP_ORDER.length - 1; i >= 0; i--) {
          const id = C.SHIP_ORDER[i];
          const check = SC.Engine.canBuildShip(state, planet, id, 1);
          if (check.ok && check.cost <= shipBudget) {
            if (bestShip === null || C.SHIP_TYPES[id].atk >= C.SHIP_TYPES[bestShip].atk) {
              bestPlanet = planet; bestShip = id; bestCost = check.cost;
            }
            break;
          }
        }
      }
      if (!bestPlanet) break;
      SC.Engine.buildShip(state, bestPlanet.id, bestShip, 1);
      shipBudget -= bestCost;
    }

    // ---- 3. Offense: launch fleets at weak, reachable targets ----
    if (Math.random() > cfg.attackChance) return;

    for (const planet of owned) {
      if (fleetPower(planet.stationed, 'atk') <= 0) continue;

      const sendCounts = SC.Engine.emptyCounts();
      let sendAttack = 0;
      for (const id of C.SHIP_ORDER) {
        const n = planet.stationed[id] || 0;
        const reserve = Math.ceil(n * cfg.reserveFrac);
        const send = Math.max(0, n - reserve);
        sendCounts[id] = send;
        sendAttack += send * C.SHIP_TYPES[id].atk;
      }
      if (sendAttack <= 0) continue;

      const attackPower = SC.Engine.estimateAttackPower(sendCounts, player.techLevel);

      let best = null, bestScore = -Infinity;
      for (const target of state.planets) {
        if (target.id === planet.id || target.owner === player.id) continue;
        const defPower = SC.Engine.estimateDefensePower(state, target);
        if (attackPower < defPower * cfg.marginNeeded) continue;
        const d = SC.Engine.distance(planet, target);
        const worthBonus = target.owner ? 40 : 0; // prefer taking enemy planets over neutrals
        const score = worthBonus - d * 0.05 - defPower * 0.3;
        if (score > bestScore) { bestScore = score; best = target; }
      }

      if (best) {
        SC.Engine.sendFleet(state, planet.id, best.id, sendCounts, player.id);
      }
    }
  },
};
