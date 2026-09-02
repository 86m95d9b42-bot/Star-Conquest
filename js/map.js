// Star Conquest — universe / map generation.
window.SC = window.SC || {};

const GREEK = ['Alpha','Beta','Gamma','Delta','Epsilon','Zeta','Eta','Theta','Iota','Kappa',
  'Lambda','Mu','Nu','Xi','Omicron','Pi','Rho','Sigma','Tau','Upsilon','Phi','Chi','Psi','Omega'];
const STAR_NAMES = ['Cygnus','Vela','Draco','Orion','Lyra','Perseus','Hydra','Corvus','Pavo','Indus',
  'Fornax','Carina','Aquila','Centauri','Serpens','Reticulum','Andromeda','Cassiopeia','Phoenix','Sculptor',
  'Volans','Tucana','Grus','Lupus','Norma','Ara','Crux','Musca','Hydrus','Mensa'];

function seededRng(seed) {
  let s = seed >>> 0 || 1;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}

function pickWeighted(rng, items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rng() * total;
  for (const it of items) { r -= it.weight; if (r <= 0) return it; }
  return items[items.length - 1];
}

function planetName(rng, index) {
  const star = STAR_NAMES[Math.floor(rng() * STAR_NAMES.length) % STAR_NAMES.length];
  const suffix = GREEK[index % GREEK.length];
  return `${star} ${suffix}`;
}

SC.MapGen = {
  generate(opts) {
    const { planetCount, numPlayers, rng, aspect } = opts;
    const rand = rng || seededRng(Date.now());

    // World bounds are shaped to match the actual on-screen map viewport
    // (aspect = width/height) so the generated galaxy fills the canvas
    // edge-to-edge instead of floating in a letterboxed strip. Width
    // scales with sqrt(planetCount) so world AREA — not just width —
    // scales in direct proportion to planet count (see WORLD_REFERENCE_*
    // in engine.js): a 5x-the-planets universe is a 5x-the-area universe,
    // keeping planet density constant across all four size presets.
    const refCount = SC.CONST.WORLD_REFERENCE_PLANET_COUNT;
    const refWidth = SC.CONST.WORLD_REFERENCE_WIDTH;
    const worldW = Math.round(refWidth * Math.sqrt(planetCount / refCount));
    const worldH = Math.round(worldW / (aspect || 0.6));
    const margin = Math.max(46, Math.min(worldW, worldH) * 0.07);

    const planets = [];
    const minDist = Math.max(64, Math.sqrt((worldW * worldH) / planetCount) * 0.58);

    let attempts = 0;
    while (planets.length < planetCount && attempts < planetCount * 400) {
      attempts++;
      const x = margin + rand() * (worldW - margin * 2);
      const y = margin + rand() * (worldH - margin * 2);
      let ok = true;
      for (const p of planets) {
        if (Math.hypot(p.x - x, p.y - y) < minDist) { ok = false; break; }
      }
      if (!ok) continue;

      const cls = pickWeighted(rand, SC.CONST.PLANET_CLASSES);
      planets.push({
        id: planets.length,
        name: planetName(rand, planets.length),
        x, y,
        classId: cls.id,
        className: cls.name,
        slots: cls.slots,
        owner: null,
        isHome: false,
        factories: 0,
        labs: 0,
        stationed: { scout: 0, fighter: 0, cruiser: 0, dreadnought: 0 },
        neutralDefense: Math.round(cls.id * 6 + rand() * cls.id * 5),
      });
    }

    // Farthest-point sampling for well-spread home planets among the
    // higher-class candidates so every empire starts on comparable footing.
    const candidates = planets.filter(p => p.classId >= 3);
    const pool = candidates.length >= numPlayers ? candidates : planets;
    const homeIndicesInPool = [];
    let startIdx = Math.floor(rand() * pool.length);
    homeIndicesInPool.push(startIdx);
    while (homeIndicesInPool.length < numPlayers && homeIndicesInPool.length < pool.length) {
      let best = -1, bestDist = -1;
      for (let i = 0; i < pool.length; i++) {
        if (homeIndicesInPool.includes(i)) continue;
        let minD = Infinity;
        for (const hi of homeIndicesInPool) minD = Math.min(minD, dist2(pool[i], pool[hi]));
        if (minD > bestDist) { bestDist = minD; best = i; }
      }
      homeIndicesInPool.push(best);
    }

    const homeIndices = homeIndicesInPool.map(i => pool[i].id);
    // Boost home planets to class V regardless of what they rolled.
    const homeClass = SC.CONST.PLANET_CLASSES[SC.CONST.PLANET_CLASSES.length - 1];
    for (const idx of homeIndices) {
      const p = planets[idx];
      p.classId = homeClass.id;
      p.className = homeClass.name;
      p.slots = homeClass.slots;
    }

    return { planets, worldW, worldH, homeIndices };
  },

  seededRng,
};

function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
