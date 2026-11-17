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
        panic: 0,
        resistance: 0,      // 0..1 — grows once the outbreak is discovered
        recovered: 0,       // people who fought off the infection
        peakInfected: 0,    // largest simultaneous case count seen
        detectedDay: null,  // the day this country first reported cases
        recoveredToday: 0,  // recovered in the last simulated day (for the UI)
        immunityDeaths: 0   // deaths avoided by resistance (for the inspector)
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
    this.vehicles = [];      // simulated planes & ships
    this.vehicleSeq = 0;
    // Engineered Hybrid inherits one trait from another pathogen
    this.hybridTrait = null;
    if (this.plague.id === 'hybrid') {
      const pool = PLAGUE_TYPES.filter(t => t.id !== 'hybrid' && t.id !== 'bioengineered');
      this.hybridTrait = pool[Math.floor(Math.random() * pool.length)];
    }

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
      severityMult: this.plague.severityMult,
      // third axis + resistance counters
      dnaMult: this.plague.dnaMult || 1,
      travel: this.plague.travelMult || 1,
      curePersist: this.plague.curePersist || 1,
      resistDrift: 1,        // multiplier on resistance growth (lower is better)
      resistPierce: 0,       // 0..0.95 — how much resistance is ignored
      stealth: this.plague.stealthBase || 0, // 0..0.9 — hides severity from researchers
      spread: 1
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
      if (ef.dnaMult) e.dnaMult *= ef.dnaMult;
      if (ef.travel) e.travel *= ef.travel;
      if (ef.curePersist) e.curePersist *= ef.curePersist;
      if (ef.resistDrift) e.resistDrift *= (1 - ef.resistDrift);
      if (ef.resistPierce) e.resistPierce += ef.resistPierce;
      if (ef.stealth) e.stealth += ef.stealth;
      if (ef.spread) e.spread *= ef.spread;
    }
    // the Engineered Hybrid borrows one trait from another pathogen
    if (this.hybridTrait) {
      const t = this.hybridTrait;
      e.infect *= 1 + (t.infectMult - 1) * 0.5;
      e.lethalityMult *= 1 + (t.lethalityMult - 1) * 0.5;
      e.dnaMult *= 1 + (t.dnaBonus - 1) * 0.5;
    }

    // a pathogen that resists drugs also slows human adaptation
    e.resistDrift *= Math.max(0.08, (this.plague.drugResist || 1));
    e.resistPierce = Math.min(0.95, e.resistPierce);
    e.stealth = Math.min(0.9, e.stealth);

    // ---- diminishing returns ----
    // With 60+ upgrades available, multiplying infectivity directly would let a
    // fully evolved pathogen reach absurd multipliers. A single upgrade keeps
    // (almost) its printed value, but stacking many gives sharply less.
    if (e.infect > 1) e.infect = 1 + Math.log2(e.infect) * 0.7;
    e.infect = Math.min(e.infect, 15);
    for (const k of ['hot', 'cold', 'arid', 'humid']) {
      if (e[k] > 0) e[k] = Math.min(0.95, Math.pow(e[k], 0.7));
    }
    // severity and lethality stay linear (they are ratings, not multipliers)
    e.severity *= e.severityMult;
    e.lethality *= e.lethalityMult;
    this.effectCache = e;
    return e;
  }

  findUpgrade(id) {
    return TRANSMISSIONS.find(u => u.id === id)
        || SYMPTOMS.find(u => u.id === id)
        || ABILITIES.find(u => u.id === id);
  }

  allUpgrades() { return [...TRANSMISSIONS, ...SYMPTOMS, ...ABILITIES]; }

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
      // visible symptoms reveal the pathogen and drive research harder
      const visible = (up.effect.severity || 0) + (up.effect.lethality || 0) * 0.4;
      this.researchProgress += visible * 0.035 * this.difficulty.research;
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
    let dead = 0, infected = 0, healthy = 0, discovered = 0, recovered = 0;
    for (const c of this.countries.values()) {
      dead += c.dead;
      infected += c.infected;
      healthy += c.healthy;
      recovered += c.recovered || 0;
      if (c.discovered) discovered++;
    }
    return { dead, infected, healthy, recovered, discovered, total: this.totalPopulation };
  }

  /* ---------------- start ---------------- */
  start(countryName) {
    const c = this.countries.get(countryName);
    if (!c) return false;
    const seed = Math.max(1, Math.round(c.pop * 0.00002));
    c.infected = Math.min(c.pop, seed);
    c.healthy = c.pop - c.infected - (c.recovered || 0);
    c.detectedDay = 0;
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

    for (const c of this.countries.values()) {
      // a chronic reservoir always survives while hosts remain
      if (c.infected < 1 && c.healthy > 1 && c.dead > 0) c.infected = 1;

      if (c.infected <= 0) {
        c.panic = Math.max(0, c.panic - 0.15 * dt);
        continue;
      }

      const susceptible = c.healthy / Math.max(1, c.pop);   // share still catchable

      // ---- human resistance ----
      // Grows once the world notices the outbreak: rich, healthy and highly
      // exposed countries adapt fastest. Rich nations mount a stronger
      // response, poor ones adapt through sheer exposure.
      if (c.discovered) {
        const exposure = Math.min(1, c.infected / Math.max(1, c.pop) * 4);
        const capacity = 0.25 + c.wealth * 0.55 + c.health * 0.35;
        const drift = 0.0015 * capacity * (0.35 + exposure) * (this.difficulty.resist || 1);
        const before = c.resistance;
        c.resistance = Math.min(0.86, c.resistance + drift * eff.resistDrift * dt);
        if (!isFinite(c.resistance) || c.resistance < 0) c.resistance = 0;
        // announce notable adaptation milestones
        for (const mark of [0.25, 0.5, 0.75]) {
          if (before < mark && c.resistance >= mark) {
            const word = mark === 0.25 ? 'partial immunity' : mark === 0.5 ? 'widespread immunity' : 'near-total immunity';
            this.addNews(`${c.name} develops ${word} to the pathogen.`, 'warn');
            this.pushEvent({ type: 'resistance', title: 'Human adaptation', text: `${c.name}: ${word}` });
            break;
          }
        }
      }

      const residual = c.resistance * (1 - eff.resistPierce);
      const bodyResistance = 1 - c.health * 0.35 - c.wealth * 0.2;
      const seasonMult = this.climateBonus(c, eff);
      let rate = 0.055 * eff.infect * seasonMult
        * (this.plague.id === 'fungus' && c.climate === CLIMATE.HUMID ? 1.9 : 1)
        * Math.max(0.15, bodyResistance) * this.difficulty.spread;
      // protozoa ignore healthcare entirely when spreading
      if (this.plague.id === 'protist') rate *= 1 / Math.max(0.15, bodyResistance) * 0.85;
      // prions shrug off adaptive resistance while incubating
      if (!this.plague.prion) rate *= Math.max(0.2, 1 - residual);
      if (c.panic > 0.4) rate *= 0.7;              // people hide, fewer contacts

      if (c.infected > c.peakInfected) c.peakInfected = c.infected;

      // weakly damped by remaining susceptibles, so late-stage outbreaks can finish the job
      const newInfections = Math.min(c.healthy, c.infected * rate * Math.pow(Math.max(susceptible, 1e-9), 0.2) * dt);

      if (newInfections > 0) {
        c.infected += newInfections;
        c.healthy = Math.max(0, c.pop - c.infected - c.dead - (c.recovered || 0));
      }

      // deaths — rate rises steeply with lethality
      const lethRating = Math.max(0, eff.lethality);
      let leth = Math.pow(lethRating / 100, 1.0) * 0.05 * (1 - c.health * 0.24);
      // in a fully saturated country the outbreak resolves within months
      if (c.healthy < c.pop * 0.002) leth *= 2.4;

      // an adapted population survives somewhat better, but immunity is about
      // not catching it in the first place — not surviving it once infected
      leth *= Math.max(0.42, 1 - c.resistance * (1 - eff.resistPierce) * 0.42);
      const newDeaths = Math.min(c.infected, c.infected * leth * dt);
      if (newDeaths > 0) {
        c.infected -= newDeaths;
        c.dead += newDeaths;
        c.healthy = Math.max(0, c.pop - c.infected - c.dead - (c.recovered || 0));
      }

      // ---- recovery ----
      // A fraction of the infected fight the pathogen off. Recovery is fast in
      // healthy, wealthy countries and much faster once a cure exists.
      const eff2 = eff;
      const careQuality = 0.35 + c.health * 0.8 + c.wealth * 0.5;
      let recoveryRate = 0.0011 * careQuality * (1 + c.resistance * 2.2) / Math.max(0.25, eff2.lethalityMult * 0.8);
      // symptoms that destroy the body make recovery far less likely
      recoveryRate /= (1 + Math.max(0, eff2.lethality) * 0.11);
      recoveryRate *= (1 + this.researchProgress / 100 * 2.5);   // treatment improves
      // immunity-evading abilities keep people sick for longer
      recoveryRate *= Math.max(0.15, 1 - eff2.resistPierce * 0.75);
      recoveryRate *= 1 / Math.max(0.4, eff2.curePersist * 0.85);

      // A lethal pathogen always outpaces recovery in the end: recovery can
      // only ever offset a bounded share of the death rate.
      const deathPressure = Math.min(1, Math.max(0, eff2.lethality) * 0.02);
      recoveryRate *= (1 - deathPressure * 0.92);
      const cured = Math.min(c.infected, c.infected * Math.max(0, recoveryRate) * dt);
      if (cured > 0) {
        c.infected -= cured;
        c.recovered += cured;
        c.recoveredToday += cured;
        c.healthy = Math.max(0, c.pop - c.infected - c.dead - c.recovered);
        c.resistance = Math.min(0.9, c.resistance + (cured / Math.max(1, c.pop)) * 0.75);
      }

      if (c.infected > c.pop) c.infected = c.pop;

      // passive DNA trickle scaled by how much of the world is infected
      const frac = c.infected / Math.max(1, c.pop);
      dnaGain += frac * 0.45 * this.difficulty.dna * this.plague.dnaBonus * eff.dnaMult * dt;

      // DNA bubbles: infected countries occasionally yield a DNA point
      const bubbleChance = (0.0016 + frac * 0.02) * this.difficulty.dna * this.plague.dnaBonus * eff.dnaMult;
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
        c.closedDay = Math.floor(this.day);
        this.addNews(`${c.name} closes all borders and airports.`, 'danger');
      }
      // ...and reopens them once the crisis eases or the shutdown is unsustainable
      if (c.closedAir) {
        const shutdownTooLong = this.day - (c.closedDay || 0) > 120;
        if (c.panic < 0.45 || shutdownTooLong) {
          c.closedAir = false; c.closedSea = false; c.closedLand = false;
          this.addNews(`${c.name} reopens its borders.`, 'info');
        }
      }

      // ---- detection ----
      // Surveillance quality decides how quickly a country notices the pathogen.
      // Rich, well-staffed health systems spot a handful of cases within days;
      // poor ones may miss thousands. Stealthy pathogens delay detection.
      if (!c.discovered && c.infected > 0) {
        const surveillance = 0.18 + c.health * 0.75 + c.wealth * 0.45;
        const stealth = eff.stealth || 0;
        const threshold = Math.max(3, c.pop * 0.0000035 * (1 - surveillance * 0.85) * (1 + stealth * 3.2));
        if (c.infected > threshold) {
          c.discovered = true;
          c.detectedDay = Math.floor(this.day);
          newlyDiscovered.push(c.name);
          this.addNews(`${c.name} confirms outbreak (${fmtShort(c.infected)} cases).`, 'danger');
          this.pushEvent({ type: 'detect', title: 'Outbreak confirmed', text: c.name });
        }
      }
    }

    if (dnaGain > 0) {
      this.dna += dnaGain;
      this.totalDnaEarned += dnaGain;
    }

    // ---- global preparedness ----
    // Once the world is on alert, even uninfected countries build up immunity
    // through vaccination, screening and behaviour change.
    if (this.researchStarted) {
      const alert = Math.min(1, 0.25 + this.researchProgress / 100);
      for (const c of this.countries.values()) {
        if (c.infected > 0) continue;
        const capacity = 0.2 + c.wealth * 0.6 + c.health * 0.4;
        const drift = 0.00055 * capacity * alert * (this.difficulty.resist || 1);
        c.resistance = Math.min(0.85, c.resistance + drift * eff.resistDrift * dt);
        if (!isFinite(c.resistance) || c.resistance < 0) c.resistance = 0;
      }
    }

    // ---- travel: physical planes and ships carry the pathogen ----
    this.updateVehicles(dt, eff);

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

    // Victory: society is gone. A few thousand immune survivors hiding in the
    // ruins cannot rebuild a civilisation, so 99.9% dead counts as extinction.
    const deadFracNow = now.dead / now.total;
    if (deadFracNow >= 0.999) {
      this.finish(true, `Total extinction. ${fmtShort(now.dead)} dead — the last scattered survivors cannot rebuild.`);
    } else if (deadFracNow >= 0.995 && now.infected < now.total * 0.0005 && this.day > 200) {
      this.finish(true, 'Humanity has collapsed. The pathogen is all that remains.');
    }
    // stalemate: the outbreak has stalled for a very long time
    if (this.day > 2600 && now.healthy > now.total * 0.002) {
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

  /* ---------------- travel simulation ----------------
     Instead of rolling a probability per country pair, real vehicles depart
     infected countries on schedules, fly/sail for a few days, and carry the
     pathogen to their destination. Watch them move on the map in real time.
  ------------------------------------------------------------------ */
  spawnInterval(eff) {
    // more evolved pathogens travel far more often
    return 0.26 / Math.max(0.25, eff.travel * eff.spread);
  }

  updateVehicles(dt, eff) {
    // ---- move existing vehicles ----
    for (const v of this.vehicles) {
      v.progress += dt / Math.max(0.5, v.duration);
      if (!v.arrived && v.progress >= 1) {
        v.arrived = true;
        this.vehicleArrives(v);
      }
      if (v.progress >= 1.35) v.done = true;
    }
    this.vehicles = this.vehicles.filter(v => !v.done);

    // ---- ground traffic across land borders ----
    // People walk, drive and truck goods across shared borders; this is how
    // the pathogen reaches countries without airports or ports.
    for (const c of this.countries.values()) {
      // countries that already burned out still export the pathogen through
      // travellers, truckers and contaminated goods
      const active = Math.max(c.infected, (c.peakInfected || 0) * 0.1);
      if (active <= 0) continue;
      const frac = active / Math.max(1, c.pop);
      if (frac < 0.0005) continue;
      const pressure = Math.min(1, frac * 14 + 0.06);
      for (const nName of this.landAdj.get(c.name) || []) {
        const n = this.countries.get(nName);
        if (!n || n.infected > 0) continue;
        const borderEffect = c.closedLand ? 0.25 : 1;
        const immunity = Math.max(0.06, 1 - (n.resistance || 0) * (1 - eff.resistPierce));
        const p = 0.0022 * Math.min(3, eff.infect) * pressure * borderEffect * immunity
          * this.difficulty.spread * eff.spread * dt;
        if (Math.random() < p) this.infectCountry(n, c);
      }
    }

    // ---- launch new vehicles ----
    this.spawnTimer = (this.spawnTimer || 0) + dt;
    const interval = this.spawnInterval(eff);
    while (this.spawnTimer >= interval) {
      this.spawnTimer -= interval;
      this.spawnVehicle(eff);
      if (this.vehicles.length > 90) break;
    }
  }

  // weighted pick of a departure country
  pickSourceCountry() {
    const infected = [...this.countries.values()].filter(c => c.infected > 0);
    if (!infected.length) return null;
    let total = 0;
    const weights = infected.map(c => {
      const active = Math.max(c.infected, c.peakInfected * 0.1);
      const w = (active / Math.max(1, c.pop)) * (1 + (FLIGHT_HUBS[c.name] ? FLIGHT_HUBS[c.name].reach / 55 : 0));
      total += w;
      return w;
    });
    if (total <= 0) return null;
    let r = Math.random() * total;
    for (let i = 0; i < infected.length; i++) {
      r -= weights[i];
      if (r <= 0) return infected[i];
    }
    return infected[infected.length - 1];
  }

  spawnVehicle(eff) {
    const src = this.pickSourceCountry();
    if (!src) return;

    const wantsAir = Math.random() < 0.72;
    const type = wantsAir ? 'plane' : 'ship';

    // closed borders throttle departures, but smuggling, freight and
    // essential travel never stop completely
    const closure = type === 'plane' ? (src.closedAir ? 0.14 : 1) : (src.closedSea ? 0.2 : 1);
    if (Math.random() > closure) return;

    // choose a destination
    let pool = [];
    if (type === 'plane') {
      const hubs = this.seaAdj.get(src.name);
      if (hubs) pool = [...hubs];
    } else {
      // ships only sail to countries with a sea connection
      const hubs = this.seaAdj.get(src.name);
      if (hubs) pool = [...hubs].filter(n => this.seaAdj.get(n) && this.seaAdj.get(n).has(src.name));
    }
    if (!pool.length) pool = [...(this.seaAdj.get(src.name) || [])];
    if (!pool.length) return;

    const destName = pool[Math.floor(Math.random() * pool.length)];
    const dest = this.countries.get(destName);
    if (!dest) return;

    // how much pathogen is aboard
    const frac = src.infected / Math.max(1, src.pop);
    const pressure = Math.min(1, frac * 18 + 0.22);
    const reach = FLIGHT_HUBS[src.name];
    const reachFactor = reach ? reach.reach / 55 : 0.5;
    let load = pressure * Math.min(3, eff.infect) * 1.15 * (type === 'plane' ? reachFactor : reachFactor * 0.8);
    load *= eff.resistPierce > 0 ? 1 : (1 - Math.max(0, dest.resistance) * 0.55);
    // destination's own immunity can neutralise the arrival
    load *= Math.max(0.05, 1 - (dest.resistance || 0) * (1 - eff.resistPierce));

    this.vehicles.push({
      id: ++this.vehicleSeq,
      type,
      from: src.name,
      to: destName,
      progress: 0,
      duration: type === 'plane' ? 1.4 + Math.random() * 1.6 : 5 + Math.random() * 6,
      load: Math.max(0, Math.min(1, load)),
      infected: Math.random() < Math.min(0.93, Math.max(0, load * 1.5)),
      arrived: false,
      done: false,
      seed: Math.random() * 100
    });
    this.emit('vehicle', { type, from: src.name, to: destName });
  }

  vehicleArrives(v) {
    const dest = this.countries.get(v.to);
    if (!dest) return;
    if (v.infected && dest.infected <= 0) {
      this.infectCountry(dest, this.countries.get(v.from), v.type);
    } else if (dest.infected > 0 && v.infected) {
      // a returning vehicle adds fresh cases to an ongoing outbreak
      const add = Math.max(1, dest.pop * 0.000008 * v.load);
      dest.infected = Math.min(dest.pop, dest.infected + add);
      dest.healthy = Math.max(0, dest.pop - dest.infected - dest.dead - (dest.recovered || 0));
    }
  }

  infectCountry(c, src, via) {
    const seedCount = Math.max(1, Math.min(c.pop * 0.0004, 4000));
    c.infected = seedCount;
    c.healthy = Math.max(0, c.pop - seedCount - c.dead - (c.recovered || 0));
    c.discovered = c.discovered || false;
    c.panic = Math.max(c.panic, 0.12);
    if (src) {
      const route = via === 'ship' ? 'a ship from' : via === 'plane' ? 'a flight from' : null;
      this.addNews(`${c.name}: first cases imported ${route ? route + ' ' + src.name : 'from ' + src.name}.`, 'danger');
    } else this.addNews(`${c.name} reports its first cases.`, 'danger');
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
    if (!this.researchStarted && (now.discovered >= 2 || now.dead > 25000 || sev > 8)) {
      this.researchStarted = true;
      this.addNews('Global health authorities begin work on a cure.', 'warn');
      this.pushEvent({ type: 'research', title: 'Cure research begins', text: 'WHO activates emergency protocol.' });
    }
    if (!this.researchStarted) return;

    // humanity needs samples: live cases, or a large enough body of data
    if (infectedFrac < 0.0002 && now.dead < 5000) return;

    const eff = this.getEffect();
    const visibleSeverity = sev * (1 - eff.stealth);   // stealth symptoms hide the damage
    const visibility = 0.45 + visibleSeverity * 0.02 + deadFrac * 6 + discoveredFrac * 0.9;
    const effort = (0.05 + infectedFrac * 1.15) * visibility;
    let rate = effort * this.difficulty.research * this.difficulty.cureSpeed * 0.17;
    rate /= Math.max(0.3, eff.curePersist);          // information warfare, prion latency, nanobots
    // as society collapses there is nobody left to staff the labs
    rate *= Math.max(0.08, 1 - deadFrac * 0.92);
    // wealthy, healthy nations contribute more
    rate *= 0.6 + (1 - Math.min(1, now.infected / now.total)) * 0.8;
    if (this.researchStalled) rate *= 0.35;

    if (!isFinite(rate) || rate < 0) rate = 0;
    this.researchProgress = Math.min(100, this.researchProgress + rate * dt);
    if (!isFinite(this.researchProgress)) this.researchProgress = 0;
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
      `WHO: "The situation in ${pick.name} is deteriorating rapidly."`,
      ...(pick.resistance > 0.3 ? [
        `Population immunity in ${pick.name} now estimated at ${Math.round(pick.resistance * 100)}%.`,
        `${pick.name} reports its adapted population is resisting new infections.`
      ] : [])
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
    const res = c.resistance || 0;

    // Uninfected countries drift steel-blue as their population adapts
    if (c.infected <= 0 && c.dead <= 0) {
      if (res > 0.04) {
        return {
          fill: mix('#141f2b', '#2b4d69', Math.min(1, res * 1.5)),
          stroke: `rgba(120,195,240,${0.22 + res * 0.7})`,
          infected: false,
          resistance: res
        };
      }
      return { fill: '#16232f', infected: false };
    }

    const infFrac = c.infected / c.pop;
    const deadFrac = c.dead / c.pop;
    let fill, stroke;

    if (deadFrac > 0.02) {
      fill = mix('#5c1410', '#150607', Math.min(1, deadFrac * 3));
      stroke = 'rgba(255,60,50,0.95)';
    } else if (infFrac > 0.4) {
      fill = '#a52418'; stroke = 'rgba(255,120,90,0.95)';
    } else if (infFrac > 0.15) {
      fill = '#c23a1f'; stroke = 'rgba(255,150,100,0.95)';
    } else if (infFrac > 0.03) {
      fill = '#d9622b'; stroke = 'rgba(255,180,120,0.95)';
    } else if (infFrac > 0.005) {
      fill = '#e08a3c'; stroke = 'rgba(255,200,150,0.9)';
    } else {
      fill = '#b8703a'; stroke = 'rgba(255,210,170,0.85)';
    }

    // Human resistance always shows through: the more a population has
    // adapted, the more the infection colour is pushed toward cold steel.
    if (res > 0.05) {
      const t = Math.min(0.62, res * 0.75);
      fill = mix(fill.startsWith('#') ? fill : '#a52418', '#2f5f80', t);
      if (res > 0.35) stroke = `rgba(150,205,240,${0.5 + res * 0.5})`;
    }

    return { fill, stroke, infected: true, resistance: res };
  }

}

function fmtShort(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return Math.round(n).toString();
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
