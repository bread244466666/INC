/* ============================================================
   PLAGUE.IO — simulation engine
   ============================================================ */

const DAYS_PER_SECOND = [0, 2.5, 5, 10, 20, 40]; // speed index -> days/sec

class Game {
  constructor(opts = {}) {
    this.difficulty = DIFFICULTIES[opts.difficulty || 'normal'];
    this.difficultyId = opts.difficulty || 'normal';
    this.plague = PLAGUE_TYPES.find(p => p.id === (opts.plague || 'bacteria')) || PLAGUE_TYPES[0];

    this.day = 0;
    this.dna = this.difficulty.startDna;
    this.totalDnaEarned = this.difficulty.startDna;
    this.speed = 0;         // 0 = paused
    this.speedIdx = 1;
    this.running = false;
    this.over = false;
    this.won = false;
    this.overReason = '';

    this.unlocked = new Set();
    this.researchProgress = 0;       // 0..100
    this.researchStarted = false;
    this.researchStalled = false;

    this.totalDeaths = 0;
    this.totalInfectedNow = 0;
    this.totalPopulation = 0;
    this.peakInfected = 0;
    this.dnaTimer = 0;

    this.countries = new Map();
    for (const name of Object.keys(COUNTRIES)) {
      const d = COUNTRIES[name];
      const population = Math.round(d.p * 1e6);
      this.totalPopulation += population;
      this.countries.set(name, {
        name,
        pop: population,
        climate: d.c,
        wealth: d.w,
        health: d.h,
        pos: d.pos,
        infected: 0,
        dead: 0,
        healthy: population,
        discovered: false,
        closedAir: false,
        closedSea: false,
        closedLand: false,
        panic: 0
      });
    }

    // adjacency
    this.landAdj = new Map();
    for (const name of this.countries.keys()) this.landAdj.set(name, new Set());
    for (const [a, b] of LAND_BORDERS) {
      if (!this.landAdj.has(a) || !this.landAdj.has(b)) continue;
      this.landAdj.get(a).add(b);
      this.landAdj.get(b).add(a);
    }

    // Air / sea links. Links are reciprocated so the graph is navigable in
    // both directions, then every remaining island gets a lifeline to its
    // nearest neighbours so no country is permanently unreachable.
    this.seaAdj = new Map();
    for (const name of this.countries.keys()) this.seaAdj.set(name, new Set());
    for (const [name, cfg] of Object.entries(FLIGHT_HUBS)) {
      if (!this.countries.has(name)) continue;
      for (const hub of cfg.hubs) {
        if (!this.countries.has(hub) || hub === name) continue;
        this.seaAdj.get(name).add(hub);
        this.seaAdj.get(hub).add(name);
      }
    }
    const withPos = [...this.countries.values()].filter(c => Array.isArray(c.pos));
    for (const c of withPos) {
      const links = this.seaAdj.get(c.name);
      const land = this.landAdj.get(c.name);
      if (links.size + land.size >= 2) continue;
      // nearest countries by approximate geographic distance
      const near = withPos
        .filter(o => o.name !== c.name)
        .map(o => ({ name: o.name, d: Math.hypot(o.pos[0] - c.pos[0], o.pos[1] - c.pos[1]) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      for (const n of near) {
        links.add(n.name);
        if (this.seaAdj.has(n.name)) this.seaAdj.get(n.name).add(c.name);
      }
    }

    this.bubbles = [];
    this.events = [];
    this.newsLog = [];
    this.effectCache = null;
    this.listeners = {};
  }

  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  emit(ev, data) { (this.listeners[ev] || []).forEach(f => f(data)); }

  /* ---------------- evolution ---------------- */
  getEffect() {
    if (this.effectCache) return this.effectCache;
    const e = {
      infect: this.plague.infectMult,
      hot: 0, cold: 0, arid: 0, humid: 0,
      severity: 0, lethality: 0,
      health: 0, wealth: 0,
      lethalityMult: this.plague.lethalityMult,
      severityMult: this.plague.severityMult
    };
    for (const id of this.unlocked) {
      const up = this.findUpgrade(id);
      if (!up || !up.effect) continue;
      const ef = up.effect;
      if (ef.infect) e.infect *= ef.infect;
      if (ef.hot) e.hot += ef.hot;
      if (ef.cold) e.cold += ef.cold;
      if (ef.arid) e.arid += ef.arid;
      if (ef.humid) e.humid += ef.humid;
      if (ef.severity) e.severity += ef.severity;
      if (ef.lethality) e.lethality += ef.lethality;
      if (ef.health) e.health += ef.health;
      if (ef.wealth) e.wealth += ef.wealth;
      if (ef.lethalityMult) e.lethalityMult *= ef.lethalityMult;
      if (ef.severityMult) e.severityMult *= ef.severityMult;
    }
    e.severity *= e.severityMult;
    e.lethality *= e.lethalityMult;
    this.effectCache = e;
    return e;
  }

  findUpgrade(id) {
    return TRANSMISSIONS.find(u => u.id === id) || SYMPTOMS.find(u => u.id === id);
  }

  allUpgrades() { return [...TRANSMISSIONS, ...SYMPTOMS]; }

  canUnlock(up) {
    if (this.over) return false;
    if (this.unlocked.has(up.id)) return false;
    if (up.requires && !this.unlocked.has(up.requires)) return false;
    if (this.dna < Math.round(up.cost * this.costMult())) return false;
    return true;
  }

  costMult() { return this.plague.id === 'virus' ? 0.9 : 1; }

  unlock(id) {
    const up = this.findUpgrade(id);
    if (!up || !this.canUnlock(up)) return false;
    const cost = Math.round(up.cost * this.costMult());
    this.dna -= cost;
    this.unlocked.add(id);
    this.effectCache = null;
    this.pushEvent({ type: 'evolve', title: 'Pathogen evolved', text: `${up.name} activated.` });
    this.addNews(`Pathogen mutation confirmed: ${up.name}.`, 'warn');
    this.emit('evolve', up);
    if (up.effect && (up.effect.severity || up.effect.lethality)) {
      this.researchStalled = false;
      // visible symptoms drive humanity to research harder
      this.researchProgress += up.effect.severity * 0.035 * this.difficulty.research;
    }
    return true;
  }

  /* ---------------- helpers ---------------- */
  travelMult(c) {
    if (c.closedAir || c.closedSea) return 0.02;
    return 1;
  }

  climateBonus(c, eff) {
    let bonus = 0;
    if (c.climate === CLIMATE.HOT) bonus += eff.hot;
    if (c.climate === CLIMATE.COLD) bonus += eff.cold;
    if (c.climate === CLIMATE.ARID) bonus += eff.arid;
    if (c.climate === CLIMATE.HUMID) bonus += eff.humid;
    return 1 + bonus;
  }

  infectedCountries() {
    const out = [];
    for (const c of this.countries.values()) if (c.infected > 0 || c.dead > 0) out.push(c);
    return out;
  }

  stats() {
    let dead = 0, infected = 0, healthy = 0, discovered = 0;
    for (const c of this.countries.values()) {
      dead += c.dead;
      infected += c.infected;
      healthy += c.healthy;
      if (c.discovered) discovered++;
    }
    return { dead, infected, healthy, discovered, total: this.totalPopulation };
  }

  /* ---------------- start ---------------- */
  start(countryName) {
    const c = this.countries.get(countryName);
    if (!c) return false;
    const seed = Math.max(1, Math.round(c.pop * 0.00002));
    c.infected = Math.min(c.pop, seed);
    c.healthy = c.pop - c.infected;
    c.discovered = true;
    this.running = true;
    this.speed = DAYS_PER_SECOND[this.speedIdx];
    this.startCountry = countryName;
    this.addNews(`Patient zero identified in ${countryName}.`, 'danger');
    this.emit('started', countryName);
    return true;
  }

  addNews(text, kind = 'info') {
    this.newsLog.unshift({ day: Math.floor(this.day), text, kind });
    if (this.newsLog.length > 120) this.newsLog.pop();
    this.emit('news', this.newsLog[0]);
  }

  pushEvent(ev) {
    this.events.push({ ...ev, day: Math.floor(this.day) });
    if (this.events.length > 40) this.events.shift();
    this.emit('event', ev);
  }

  /* ---------------- main loop ---------------- */
  tick(dt) {
    if (!this.running || this.over || this.speed === 0) return;
    let days = dt * this.speed;
    // simulate in whole-day steps for stability
    const steps = Math.min(Math.ceil(days), 24);
    const dayStep = days / steps;
    for (let i = 0; i < steps; i++) {
      this.simulateDay(dayStep);
      if (this.over) break;
    }
  }

  simulateDay(dt) {
    this.day += dt;
    const eff = this.getEffect();
    const st = this.stats();

    // ---- infection growth & death ----
    let dnaGain = 0;
    let newlyDiscovered = [];
    const crossEvents = [];

    for (const c of this.countries.values()) {
      // a chronic reservoir always survives while hosts remain
      if (c.infected < 1 && c.healthy > 1 && c.dead > 0) c.infected = 1;

      if (c.infected <= 0) {
        c.panic = Math.max(0, c.panic - 0.15 * dt);
        continue;
      }

      const susceptible = c.healthy / Math.max(1, c.pop);   // share still catchable
      const resistance = 1 - c.health * 0.35 - c.wealth * 0.2;
      const seasonMult = this.climateBonus(c, eff);
      let rate = 0.2 * eff.infect * seasonMult
        * (this.plague.id === 'fungus' && c.climate === CLIMATE.HUMID ? 1.9 : 1)
        * Math.max(0.15, resistance) * this.difficulty.spread;
      if (c.panic > 0.4) rate *= 0.7;              // people hide, fewer contacts

      // weakly damped by remaining susceptibles, so late-stage outbreaks can finish the job
      const newInfections = Math.min(c.healthy, c.infected * rate * Math.pow(Math.max(susceptible, 1e-9), 0.2) * dt);

      if (newInfections > 0) {
        c.infected += newInfections;
        c.healthy = Math.max(0, c.pop - c.infected - c.dead);
      }

      // deaths — rate rises steeply with lethality
      const lethRating = Math.max(0, eff.lethality);
      let leth = Math.pow(lethRating / 100, 1.05) * 0.085 * (1 - c.health * 0.28);
      leth *= 1 / Math.max(0.55, this.difficulty.spread);
      const newDeaths = Math.min(c.infected, c.infected * leth * dt);
      if (newDeaths > 0) {
        c.infected -= newDeaths;
        c.dead += newDeaths;
        c.healthy = Math.max(0, c.pop - c.infected - c.dead);
      }

      if (c.infected > c.pop) c.infected = c.pop;

      // passive DNA trickle scaled by how much of the world is infected
      const frac = c.infected / Math.max(1, c.pop);
      dnaGain += frac * 0.45 * this.difficulty.dna * this.plague.dnaBonus * dt;

      // DNA bubbles: infected countries occasionally yield a DNA point
      const bubbleChance = (0.0016 + frac * 0.02) * this.difficulty.dna * this.plague.dnaBonus;
      const bubbleReady = !c.bubbleAt || this.day - c.bubbleAt > 6;
      if (bubbleReady && Math.random() < bubbleChance * dt) {
        const amount = frac > 0.35 ? 3 : frac > 0.08 ? 2 : 1;
        this.dna += amount; this.totalDnaEarned += amount;
        c.bubbleAt = this.day;
        if (this.bubbles.length < 40) this.bubbles.push({ name: c.name, amount, t: 0 });
        this.emit('bubble', { name: c.name, amount });
      }

      // parasite bonus: extra DNA from death
      if (newDeaths > 0 && this.plague.id === 'parasite') {
        dnaGain += newDeaths / Math.max(1, c.pop) * 0.55 * dt;
      }

      // panic rises with severity + deaths
      const sev = eff.severity;
      if (sev > 0 || newDeaths > 0) {
        c.panic = Math.min(1, c.panic + (sev * 0.0006 + 0.00004) * dt);
      }

      // country closes borders when panicked
      if (!c.closedAir && c.panic > 0.72) {
        c.closedAir = true; c.closedSea = true; c.closedLand = true;
        this.addNews(`${c.name} closes all borders and airports.`, 'danger');
      }

      if (!c.discovered && c.infected > c.pop * 0.002) {
        c.discovered = true;
        newlyDiscovered.push(c.name);
      }
    }

    if (dnaGain > 0) {
      this.dna += dnaGain;
      this.totalDnaEarned += dnaGain;
    }

    // ---- transmission to new countries ----
    const infectedList = this.infectedCountries();
    const travelScale = 1;

    for (const src of infectedList) {
      if (src.infected / Math.max(1, src.pop) < 0.004) continue;
      const pressure = Math.min(1, src.infected / src.pop * 12 + 0.15);

      // land
      if (!src.closedLand) {
        for (const target of this.landAdj.get(src.name) || []) {
          const t = this.countries.get(target);
          if (!t || t.infected > 0) continue;
          const p = 0.021 * eff.infect * pressure * this.difficulty.spread * dt;
          if (Math.random() < p) this.infectCountry(t, src);
        }
      }

      // air / sea
      const hubs = this.seaAdj.get(src.name);
      if (hubs && !src.closedAir) {
        for (const target of hubs) {
          const t = this.countries.get(target);
          if (!t || t.infected > 0) continue;
          const reach = FLIGHT_HUBS[src.name];
          const reachFactor = reach ? reach.reach / 55 : 0.5;
          const p = 0.0062 * eff.infect * reachFactor * pressure * this.difficulty.spread * dt;
          if (Math.random() < p) this.infectCountry(t, src);
        }
      }
    }

    // spontaneous mutation for virus
    if (this.plague.id === 'virus') {
      this.virusTimer = (this.virusTimer || 0) + dt;
      if (this.virusTimer > 45) {
        this.virusTimer = 0;
        const locked = this.allUpgrades().filter(u =>
          !this.unlocked.has(u.id) &&
          (!u.requires || this.unlocked.has(u.requires)));
        if (locked.length && Math.random() < 0.55) {
          const pick = locked[Math.floor(Math.random() * locked.length)];
          this.unlocked.add(pick.id);
          this.effectCache = null;
          this.addNews(`Viral mutation unlocked ${pick.name} for free.`, 'warn');
        }
      }
    }

    // ---- cure research ----
    this.updateResearch(dt, st);

    // ---- global stats / endgame ----
    const now = this.stats();
    this.totalDeaths = now.dead;
    this.totalInfectedNow = now.infected;
    this.peakInfected = Math.max(this.peakInfected, now.infected);

    if (now.infected + now.dead >= now.total * 0.999 && now.healthy < now.total * 0.001) {
      // still need infected to die out for a full wipe
      if (now.infected < now.total * 0.0005) {
        this.finish(true, 'Humanity has been wiped out. The pathogen is all that remains.');
      }
    }
    if (now.dead >= now.total * 0.999) {
      this.finish(true, 'Every last human is dead. Total extinction achieved.');
    }
    // stalemate: the outbreak has stalled for a very long time
    if (this.day > 1500 && now.healthy > now.total * 0.002) {
      this.finish(false, 'The outbreak stalled. Humanity adapts, endures, and rebuilds.');
    }
    if (this.researchProgress >= 100 && !this.won) {
      this.finish(false, 'Humanity developed a cure. The pathogen has been eradicated.');
    }

    // fade out collected DNA bubbles
    for (const b of this.bubbles) b.t += dt;
    this.bubbles = this.bubbles.filter(b => b.t < 2.5);

    // periodic news
    this.newsTimer = (this.newsTimer || 0) + dt;
    if (this.newsTimer > 40) {
      this.newsTimer = 0;
      this.generateFlavourNews(now);
    }

    this.emit('tick', now);
  }

  infectCountry(c, src) {
    const seedCount = Math.max(1, Math.min(c.pop * 0.0004, 4000));
    c.infected = seedCount;
    c.healthy = Math.max(0, c.pop - seedCount - c.dead);
    c.discovered = true;
    c.panic = Math.max(c.panic, 0.12);
    if (src) this.addNews(`${c.name} reports its first cases — traced to ${src.name}.`, 'danger');
    else this.addNews(`${c.name} reports its first cases.`, 'danger');
    this.emit('spread', { country: c.name, from: src ? src.name : null });
    this.pushEvent({ type: 'spread', title: 'New infection', text: `${c.name} infected` });
  }

  updateResearch(dt, st) {
    const now = this.stats();
    const infectedFrac = now.infected / now.total;
    const deadFrac = now.dead / now.total;
    const sev = this.getEffect().severity;
    const discoveredFrac = now.discovered / this.countries.size;

    // humanity only starts researching once the plague is noticed
    if (!this.researchStarted && (discoveredFrac > 0.12 || now.dead > 100000 || sev > 8)) {
      this.researchStarted = true;
      this.addNews('Global health authorities begin work on a cure.', 'warn');
      this.pushEvent({ type: 'research', title: 'Cure research begins', text: 'WHO activates emergency protocol.' });
    }
    if (!this.researchStarted) return;

    // research speed scales with how visible & deadly the plague is
    // humanity needs samples: live cases, or a large enough body of data
    if (infectedFrac < 0.0015 && deadFrac < 0.01) return;

    const visibility = 0.28 + sev * 0.012 + deadFrac * 7 + discoveredFrac * 0.45;
    const effort = (0.012 + infectedFrac * 0.9) * visibility;
    let rate = effort * this.difficulty.research * this.difficulty.cureSpeed * 0.42;
    // as society collapses there is nobody left to staff the labs
    rate *= Math.max(0.08, 1 - deadFrac * 0.92);
    // wealthy, healthy nations contribute more
    rate *= 0.6 + (1 - Math.min(1, now.infected / now.total)) * 0.8;
    if (this.researchStalled) rate *= 0.35;

    this.researchProgress = Math.min(100, this.researchProgress + rate * dt);
    if (this.researchProgress >= 100) this.finish(false, 'A cure has been developed. Humanity survives.');
  }

  generateFlavourNews(now) {
    const inf = this.infectedCountries();
    if (!inf.length) return;
    const pick = inf[Math.floor(Math.random() * inf.length)];
    const deadPct = ((pick.dead / pick.pop) * 100).toFixed(1);
    const options = [
      `${pick.name}: ${(pick.infected / 1e6).toFixed(1)}M currently infected.`,
      `Hospitals in ${pick.name} overwhelmed as cases surge.`,
      `${deadPct}% of ${pick.name}'s population has died.`,
      `Borders under strain as ${pick.name} struggles to contain spread.`,
      `Panic buying reported across ${pick.name}.`,
      `WHO: "The situation in ${pick.name} is deteriorating rapidly."`
    ];
    const msg = options[Math.floor(Math.random() * options.length)];
    this.addNews(msg, 'info');
  }

  finish(won, reason) {
    if (this.over) return;
    this.over = true;
    this.won = won;
    this.overReason = reason;
    this.running = false;
    this.speed = 0;
    this.emit('gameover', { won, reason, stats: this.stats() });
  }

  /* ---------------- map colouring ---------------- */
  getCountryVisual(name) {
    const c = this.countries.get(name);
    if (!c) return { fill: '#16232f', infected: false };
    if (c.infected <= 0 && c.dead <= 0) return { fill: '#16232f', infected: false };
    const infFrac = c.infected / c.pop;
    const deadFrac = c.dead / c.pop;
    if (deadFrac > 0.02) {
      const t = Math.min(1, deadFrac * 3);
      return { fill: mix('#5c1410', '#150607', t), stroke: 'rgba(255,60,50,0.95)', infected: true };
    }
    if (infFrac > 0.4) return { fill: '#a52418', stroke: 'rgba(255,120,90,0.95)', infected: true };
    if (infFrac > 0.15) return { fill: '#c23a1f', stroke: 'rgba(255,150,100,0.95)', infected: true };
    if (infFrac > 0.03) return { fill: '#d9622b', stroke: 'rgba(255,180,120,0.95)', infected: true };
    if (infFrac > 0.005) return { fill: '#e08a3c', stroke: 'rgba(255,200,150,0.9)', infected: true };
    return { fill: '#b8703a', stroke: 'rgba(255,210,170,0.85)', infected: true };
  }
}

function hexToRgb(h) {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const r = Math.round(A[0] + (B[0] - A[0]) * t);
  const g = Math.round(A[1] + (B[1] - A[1]) * t);
  const bl = Math.round(A[2] + (B[2] - A[2]) * t);
  return `rgb(${r},${g},${bl})`;
}
