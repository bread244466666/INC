/* ============================================================
   PLAGUE.IO — UI controller
   ============================================================ */

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const fmt = n => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K';
  return Math.round(n).toString();
};
const fmtInt = n => Math.round(n).toLocaleString('en-US');

// Inline SVG glyphs — no emoji anywhere in the UI.
const ICONS = {
  air:       '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h6"/>',
  water:     '<path d="M12 3c3.5 4 6 7 6 10a6 6 0 1 1-12 0c0-3 2.5-6 6-10z"/>',
  insect:    '<circle cx="12" cy="13" r="4"/><path d="M12 9V5M8 5l4 4 4-4"/><path d="M8 11 4 9M8 15l-4 2M16 11l4-2M16 15l4 2"/>',
  livestock: '<path d="M4 9h16v5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M7 9V6M17 9V6"/>',
  rodent:    '<circle cx="9" cy="14" r="5"/><path d="M14 10a3 3 0 1 1 3 3"/><path d="M18 16l3 2"/>',
  blood:     '<path d="M12 3c3 3.6 5 6.2 5 8.5A5 5 0 1 1 7 11.5C7 9.2 9 6.6 12 3z"/>',
  extreme:   '<path d="M12 3v18M12 3l-4 4M12 3l4 4"/><circle cx="12" cy="12" r="8"/>',
  symptom:   '<path d="M7 3c4 0 10 4 10 9s-6 9-10 9"/><path d="M17 12H7"/>',
  genetics:  '<path d="M8 3c0 6 8 6 8 12M16 3c0 6-8 6-8 12"/><path d="M9 8h6M9 15h6"/>',
  mobility:  '<path d="M2 12l19-7-7 19-3-8z"/>',
  stealth:   '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',
  pharma:    '<rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)"/><path d="M9 15l6-6"/>',
  logistics: '<path d="M3 8l9-4 9 4-9 4z"/><path d="M3 8v8l9 4 9-4V8"/>',
  info:      '<circle cx="12" cy="12" r="9"/><path d="M12 8v.01M12 11v6"/>',
  weapon:    '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.01"/>',
  immune:    '<path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z"/>'
};

function iconSvg(kind, cls) {
  const body = ICONS[kind] || ICONS.symptom;
  return `<svg class="uicon ${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

const App = {
  game: null,
  map: null,
  world: null,
  selectedPlague: 'bacteria',
  selectedDifficulty: 'normal',
  activeTab: 'transmission',
  selectedCountry: null,
  pickFilter: 'any',
  pickMap: null,
  pickedCountry: null,
  lastFrame: 0,
  tickerTimer: null,

  async init() {
    // world geometry is bundled as a JS constant so the game also runs from file://
    const features = typeof WORLD_GEO !== 'undefined' ? WORLD_GEO : [];

    this.buildMenu();
    this.bindMenu();
    this.loadBest();

    if (features.length) {
      this.map = new WorldMap($('#map'), features);
      this.map.onCountryClick = (name, p) => this.inspectCountry(name);
      this.map.onHover = (name, p) => this.showHover(name, p);

      // second, independent renderer for the patient-zero picker
      this.pickMap = new WorldMap($('#pickMap'), features);
      this.pickMap.onCountryClick = (name) => this.pickCountry(name);
      this.pickMap.onHover = (name) => this.pickerHover(name);
      this.buildFilters();
      this.pickedCountry = $('#startCountry').value;
      this.pickMap.setMarker(this.pickedCountry);
      this.renderPickCard(this.pickedCountry);
    }

    window.addEventListener('resize', () => {
      if (this.map) this.map.resize();
      if (this.pickMap) this.pickMap.resize();
    });
    document.addEventListener('keydown', e => this.onKey(e));

    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  },

  /* ---------------- menu ---------------- */
  buildMenu() {
    const pc = $('#plagueChoices');
    pc.innerHTML = '';
    PLAGUE_TYPES.forEach(p => {
      const b = document.createElement('button');
      b.className = 'choice' + (p.id === this.selectedPlague ? ' selected' : '');
      b.dataset.id = p.id;
      b.innerHTML = `<span class="choice-name">${p.name}</span>
        <span class="choice-desc">${p.desc}</span>
        <span class="choice-special">${p.special}</span>`;
      b.onclick = () => {
        this.selectedPlague = p.id;
        $$('#plagueChoices .choice').forEach(x => x.classList.toggle('selected', x.dataset.id === p.id));
      };
      pc.appendChild(b);
    });

    const dc = $('#difficultyChoices');
    dc.innerHTML = '';
    Object.entries(DIFFICULTIES).forEach(([id, d]) => {
      const b = document.createElement('button');
      b.className = 'choice' + (id === this.selectedDifficulty ? ' selected' : '');
      b.dataset.id = id;
      b.innerHTML = `<span class="choice-name">${d.name}</span><span class="choice-desc">${d.desc}</span>`;
      b.onclick = () => {
        this.selectedDifficulty = id;
        $$('#difficultyChoices .choice').forEach(x => x.classList.toggle('selected', x.dataset.id === id));
      };
      dc.appendChild(b);
    });

    const sel = $('#startCountry');
    sel.innerHTML = '';
    const sorted = Object.keys(COUNTRIES).sort((a, b) => COUNTRIES[b].p - COUNTRIES[a].p);
    sorted.forEach(name => {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = `${name} — ${COUNTRIES[name].p < 1 ? (COUNTRIES[name].p * 1e6 / 1e6).toFixed(2) : COUNTRIES[name].p} M · ${COUNTRIES[name].c}`;
      sel.appendChild(o);
    });
    sel.value = 'China';
    sel.onchange = () => {
      this.pickedCountry = sel.value;
      this.renderPickCard(sel.value);
      if (this.pickMap) {
        this.pickMap.setMarker(sel.value);
        this.pickMap.centerOn(sel.value, Math.max(this.pickMap.camera.zoom, 1.4));
      }
    };
  },

  /* ---------------- patient-zero map picker ---------------- */
  buildFilters() {
    const box = $('#startFilters');
    box.innerHTML = '';
    START_ARCHETYPES.forEach(a => {
      const b = document.createElement('button');
      b.className = 'filter-chip' + (a.id === this.pickFilter ? ' active' : '');
      b.textContent = a.name;
      b.onclick = () => {
        this.pickFilter = a.id;
        [...box.children].forEach(c => c.classList.toggle('active', c.textContent === a.name));
        if (this.pickMap) this.pickMap.setDimmed(this.dimmedSet());
      };
      box.appendChild(b);
    });
    this.pickMap.setDimmed(this.dimmedSet());
  },

  // returns a Set of country names to hide from the picker, or null for none
  dimmedSet() {
    const arch = START_ARCHETYPES.find(a => a.id === this.pickFilter);
    if (!arch || arch.id === 'any') return null;
    const keep = new Set(Object.keys(COUNTRIES).filter(n => arch.test(n)));
    return { keep };
  },

  pickerHover(name) {
    if (!name) return;
    const c = COUNTRIES[name];
    if (!c) return;
    $('#pickHint').textContent = `${name} — ${fmt(c.p * 1e6)} people`;
  },

  pickCountry(name) {
    if (!COUNTRIES[name]) return;
    this.pickedCountry = name;
    $('#startCountry').value = name;
    this.renderPickCard(name);
    if (this.pickMap) {
      this.pickMap.setMarker(name);
      this.pickMap.centerOn(name, Math.max(this.pickMap.camera.zoom, 1.6));
    }
  },

  renderPickCard(name) {
    const c = COUNTRIES[name];
    const card = $('#pickCard');
    if (!c) { card.classList.add('hidden'); return; }
    // score how hard a start this is (higher = harder)
    let score = 0;
    score += c.w * 2.2 + c.h * 2.0;
    score += c.p > 300 ? -1.4 : c.p > 60 ? -0.6 : c.p < 2 ? 0.8 : 0;
    if (c.c === 'cold') score += 0.7;
    if (['Greenland', 'Madagascar', 'New Zealand', 'Iceland', 'Australia', 'Japan'].includes(name)) score += 1.8;
    const tier = score < 1.4 ? ['easy', 'Easy'] : score < 2.6 ? ['moderate', 'Moderate'] : score < 3.6 ? ['hard', 'Hard'] : ['brutal', 'Brutal'];
    card.className = 'pick-card';
    card.innerHTML = `
      <h4>${name} <span class="difficulty-tag ${tier[0]}">${tier[1]} start</span></h4>
      <div class="pc-grid">
        <div class="pc-row"><span>Population</span><b>${fmt(c.p * 1e6)}</b></div>
        <div class="pc-row"><span>Climate</span><b>${c.c}</b></div>
        <div class="pc-row"><span>Wealth</span><b>${Math.round(c.w * 100)}%</b></div>
        <div class="pc-row"><span>Healthcare</span><b>${Math.round(c.h * 100)}%</b></div>
      </div>`;
  },

  bindMenu() {
    $('#playBtn').onclick = () => this.startGame();
    $('#randomStart').onclick = () => {
      const arch = START_ARCHETYPES.find(a => a.id === this.pickFilter);
      let names = Object.keys(COUNTRIES);
      if (arch && arch.id !== 'any') names = names.filter(n => arch.test(n));
      if (!names.length) names = Object.keys(COUNTRIES);
      this.pickCountry(names[Math.floor(Math.random() * names.length)]);
    };
    $('#howBtn').onclick = () => $('#howModal').classList.remove('hidden');
    $('#howClose').onclick = () => $('#howModal').classList.add('hidden');
    $('#menuBtn').onclick = () => this.pause();
    $('#resumeBtn').onclick = () => this.resume();
    $('#quitBtn').onclick = () => this.toMenu();
    $('#againBtn').onclick = () => { $('#overOverlay').classList.add('hidden'); this.startGame(); };
    $('#overMenuBtn').onclick = () => { $('#overOverlay').classList.add('hidden'); this.toMenu(); };
    $('#zoomIn').onclick = () => this.map && this.map.zoomToPoint(this.map.cssW / 2, this.map.cssH / 2, 1.4);
    $('#zoomOut').onclick = () => this.map && this.map.zoomToPoint(this.map.cssW / 2, this.map.cssH / 2, 1 / 1.4);
    $('#zoomReset').onclick = () => {
      if (!this.map) return;
      this.map.camera.zoom = this.map.minZoom;
      this.map.camera.x = 0; this.map.camera.y = 0;
      this.map.clampCamera();
    };

    $$('#speedGroup .spd').forEach(btn => {
      btn.onclick = () => this.setSpeed(parseInt(btn.dataset.speed, 10));
    });

    $$('#tabs .tab').forEach(t => {
      t.onclick = () => this.setTab(t.dataset.tab);
    });
  },

  loadBest() {
    try {
      const raw = localStorage.getItem('plagueio.best');
      if (raw) {
        const b = JSON.parse(raw);
        $('#bestScore').textContent = `Best: ${fmt(b.dead)} dead on ${b.difficulty} · day ${b.day}`;
      }
    } catch (e) { /* ignore */ }
  },

  saveBest(stats) {
    try {
      const prev = JSON.parse(localStorage.getItem('plagueio.best') || 'null');
      if (!prev || stats.dead > prev.dead) {
        localStorage.setItem('plagueio.best', JSON.stringify({
          dead: stats.dead, day: Math.floor(this.game.day), difficulty: this.game.difficulty.name
        }));
      }
    } catch (e) { /* ignore */ }
  },

  /* ---------------- game lifecycle ---------------- */
  startGame() {
    const country = this.pickedCountry || $('#startCountry').value;
    this.game = new Game({ difficulty: this.selectedDifficulty, plague: this.selectedPlague });
    this.game.on('news', n => this.onNews(n));
    this.game.on('spread', d => {
      if (this.map) { this.map.addArc(d.from, d.country); this.map.addPulse(d.country); }
      this.renderTab();
    });
    this.game.on('gameover', d => this.onGameOver(d));
    this.game.on('evolve', () => this.renderTab());

    this.map.state = this.game;
    this.map.camera.zoom = this.map.minZoom;
    this.map.camera.x = 0; this.map.camera.y = 0;
    this.map.clampCamera();

    // show the pathogen's mechanics in the world feed
    if (this.game.plague.notes) this.game.plague.notes.forEach(n => this.game.addNews(`${this.game.plague.name}: ${n}`, 'info'));
    if (this.game.hybridTrait) this.game.addNews(`Hybrid acquired traits from ${this.game.hybridTrait.name}.`, 'warn');

    this.game.start(country);
    this.selectedCountry = null;
    this.setTab('transmission');
    this.setSpeed(1);

    $('#menu').classList.remove('active');
    $('#game').classList.add('active');
    $('#overOverlay').classList.add('hidden');
    $('#pauseOverlay').classList.add('hidden');

    // map needs a resize once visible
    setTimeout(() => { this.map.resize(); this.map.centerOn(country, Math.max(this.map.minZoom * 1.15, 1.3)); }, 60);
    this.updateHud();
    this.renderTab();
  },

  pause() {
    if (!this.game || this.game.over) return;
    this.prevSpeed = this.game.speedIdx || 1;
    this.game.speed = 0;
    this.setSpeedUI(0);
    $('#pauseOverlay').classList.remove('hidden');
  },

  resume() {
    $('#pauseOverlay').classList.add('hidden');
    this.setSpeed(this.prevSpeed || 1);
  },

  toMenu() {
    if (this.game) { this.game.running = false; this.game.speed = 0; }
    $('#pauseOverlay').classList.add('hidden');
    $('#overOverlay').classList.add('hidden');
    $('#game').classList.remove('active');
    $('#menu').classList.add('active');
    if (this.pickMap) this.pickMap.resize();
    this.loadBest();
  },

  setSpeed(idx) {
    if (!this.game || this.game.over) return;
    this.game.speedIdx = idx || (this.game.speedIdx || 1);
    this.game.speed = idx === 0 ? 0 : DAYS_PER_SECOND[idx];
    this.setSpeedUI(idx);
  },

  setSpeedUI(idx) {
    $$('#speedGroup .spd').forEach(b => b.classList.toggle('active', parseInt(b.dataset.speed, 10) === idx));
  },

  setTab(tab) {
    this.activeTab = tab;
    $$('#tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    this.renderTab();
  },

  onKey(e) {
    if (!this.game || !$('#game').classList.contains('active')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (this.game.speed === 0) this.resume(); else this.pause();
    }
    if (['1', '2', '3', '4'].includes(e.key)) this.setSpeed(parseInt(e.key, 10));
    if (e.key === '0') this.setSpeed(0);
    if (e.key.toLowerCase() === 't') this.setTab('transmission');
    if (e.key.toLowerCase() === 'y') this.setTab('symptoms');
    if (e.key.toLowerCase() === 'w') this.setTab('news');
    if (e.key.toLowerCase() === 'a') this.setTab('abilities');
  },

  /* ---------------- news ---------------- */
  onNews(n) {
    const el = $('#tickerText');
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    el.textContent = `Day ${n.day} — ${n.text}`;
  },

  onGameOver({ won, reason, stats }) {
    this.setSpeedUI(0);
    this.saveBest(stats);
    const pct = ((stats.dead / stats.total) * 100).toFixed(2);
    $('#overTitle').textContent = won ? 'TOTAL EXTINCTION' : 'CURE DEVELOPED';
    $('#overTitle').className = won ? 'win' : 'lose';
    $('#overText').textContent = reason;
    $('#overStats').innerHTML = `
      <div class="over-stat"><span>Deaths</span><b>${fmt(stats.dead)}</b></div>
      <div class="over-stat"><span>% of humanity</span><b>${pct}%</b></div>
      <div class="over-stat"><span>Recovered</span><b>${fmt(stats.recovered || 0)}</b></div>
      <div class="over-stat"><span>Days survived</span><b>${Math.floor(this.game.day)}</b></div>
      <div class="over-stat"><span>Countries reached</span><b>${stats.discovered}</b></div>
      <div class="over-stat"><span>DNA earned</span><b>${Math.round(this.game.totalDnaEarned)}</b></div>
      <div class="over-stat"><span>Cure progress</span><b>${Math.round(this.game.researchProgress)}%</b></div>`;
    $('#overOverlay').classList.remove('hidden');
    this.loadBest();
  },

  /* ---------------- map interaction ---------------- */
  showHover(name, p) {
    const card = $('#hoverCard');
    if (!name || !this.game) { card.classList.add('hidden'); return; }
    const c = this.game.countries.get(name);
    if (!c) { card.classList.add('hidden'); return; }
    const infPct = ((c.infected / c.pop) * 100).toFixed(2);
    const deadPct = ((c.dead / c.pop) * 100).toFixed(2);
    card.innerHTML = `
      <h4>${c.name}</h4>
      <div class="hc-row"><span>Population</span><b>${fmt(c.pop)}</b></div>
      <div class="hc-row"><span>Infected</span><b>${fmt(c.infected)} (${infPct}%)</b></div>
      <div class="hc-row"><span>Dead</span><b>${fmt(c.dead)}</b></div>
      <div class="hc-row"><span>Climate</span><b>${c.climate}</b></div>
      <div class="hc-row"><span>Resistance</span><b>${Math.round(c.resistance * 100)}%</b></div>
      <div class="hc-row"><span>Recovered</span><b>${fmt(c.recovered || 0)}</b></div>`;
    card.classList.remove('hidden');
    const stage = $('#stage').getBoundingClientRect();
    const x = Math.min(p.x + 16, stage.width - 190);
    const y = Math.min(p.y + 16, stage.height - 140);
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  },

  inspectCountry(name) {
    this.selectedCountry = name;
    this.setTab('news');
    this.renderTab();
    if (this.map) this.map.centerOn(name, Math.max(this.map.camera.zoom, 1.8));
  },

  /* ---------------- rendering ---------------- */
  renderTab() {
    const body = $('#tabBody');
    if (!this.game) return;
    if (this.activeTab === 'transmission') body.innerHTML = this.transmissionHtml();
    else if (this.activeTab === 'symptoms') body.innerHTML = this.symptomsHtml();
    else if (this.activeTab === 'abilities') body.innerHTML = this.abilitiesHtml();
    else body.innerHTML = this.newsHtml();
    this.bindTabEvents();
  },

  sysMeters() {
    const eff = this.game.getEffect();
    const sev = Math.min(100, eff.severity);
    const let_ = Math.min(100, eff.lethality);
    const inf = Math.min(100, (eff.infect - 1) * 55);
    return `
      <div class="sys-meter">
        <div class="sys-row"><span>Infectivity</span><b>${eff.infect.toFixed(2)}×</b></div>
        <div class="sys-bar sys-inf"><i style="width:${inf}%"></i></div>
      </div>
      <div class="sys-meter">
        <div class="sys-row"><span>Severity</span><b>${Math.round(sev)}</b></div>
        <div class="sys-bar sys-sev"><i style="width:${sev}%"></i></div>
      </div>
      <div class="sys-meter">
        <div class="sys-row"><span>Lethality</span><b>${Math.round(let_)}</b></div>
        <div class="sys-bar sys-let"><i style="width:${let_}%"></i></div>
      </div>`;
  },

  upgradeHtml(up) {
    const g = this.game;
    const owned = g.unlocked.has(up.id);
    const prereqOk = !up.requires || g.unlocked.has(up.requires);
    const cost = Math.round(up.cost * g.costMult());
    const affordable = g.dna >= cost;
    let cls = 'upgrade';
    if (owned) cls += ' owned';
    else if (!prereqOk) cls += ' locked';
    else if (affordable) cls += ' affordable';

    const iconKind = up.branch || (up.tier === 4 ? 'weapon' : 'symptom');
    const icon = iconSvg(iconKind);
    const right = owned ? 'OWNED' : `${cost} DNA`;
    const needs = !prereqOk ? `<span class="upgrade-desc">Requires ${this.game.findUpgrade(up.requires)?.name || up.requires}</span>` : '';
    return `<button class="${cls}" data-upgrade="${up.id}" ${owned || !prereqOk ? 'disabled' : ''}>
      <span class="upgrade-icon">${icon}</span>
      <span class="upgrade-main">
        <span class="upgrade-name">${up.name}</span>
        <span class="upgrade-desc">${up.desc}</span>
        ${needs}
      </span>
      <span class="upgrade-cost">${right}</span>
    </button>`;
  },

  transmissionHtml() {
    let html = this.sysMeters();
    const groups = {};
    TRANSMISSIONS.forEach(u => {
      const key = u.branch;
      (groups[key] = groups[key] || []).push(u);
    });
    const labels = {
      air: 'Airborne', water: 'Waterborne', insect: 'Insect vector',
      livestock: 'Livestock', rodent: 'Rodent', blood: 'Bloodborne', extreme: 'Extreme environments'
    };
    for (const [key, ups] of Object.entries(groups)) {
      html += `<div class="branch-title">${labels[key] || key}</div>`;
      ups.forEach(u => { html += this.upgradeHtml(u); });
    }
    return html;
  },

  symptomsHtml() {
    let html = this.sysMeters();
    const byTier = {};
    SYMPTOMS.forEach(s => { (byTier[s.tier] = byTier[s.tier] || []).push(s); });
    const tierNames = { 1: 'Tier 1 · Initial', 2: 'Tier 2 · Serious', 3: 'Tier 3 · Severe', 4: 'Tier 4 · Terminal' };
    Object.keys(byTier).sort((a, b) => a - b).forEach(tier => {
      html += `<div class="branch-title">${tierNames[tier] || 'Tier ' + tier}</div>`;
      byTier[tier].forEach(s => { html += this.upgradeHtml(s); });
    });
    return html;
  },

  resistanceMeterHtml() {
    const g = this.game;
    let sum = 0, max = 0, n = 0, worst = null;
    for (const c of g.countries.values()) {
      sum += c.resistance; n++;
      if (c.resistance > max) { max = c.resistance; worst = c.name; }
    }
    const avg = sum / Math.max(1, n);
    const eff = g.getEffect();
    return `
      <div class="sys-meter">
        <div class="sys-row"><span>Human resistance (world)</span><b>${Math.round(avg * 100)}%</b></div>
        <div class="sys-bar sys-res"><i style="width:${avg * 100}%"></i></div>
      </div>
      <div class="sys-row" style="font-size:11px;color:var(--muted);margin:-6px 0 12px">
        <span>Highest: ${worst || '—'} ${Math.round(max * 100)}%</span>
        <span>You pierce ${Math.round(eff.resistPierce * 100)}%</span>
      </div>`;
  },

  abilitiesHtml() {
    let html = this.resistanceMeterHtml() + this.sysMeters();
    const labels = {
      genetics: 'Genetics', mobility: 'Mobility', stealth: 'Immune evasion',
      pharma: 'Pharmacology', logistics: 'Logistics', info: 'Information warfare', weapon: 'Weaponisation'
    };
    const groups = {};
    ABILITIES.forEach(u => { (groups[u.branch] = groups[u.branch] || []).push(u); });
    for (const [key, ups] of Object.entries(groups)) {
      html += `<div class="branch-title">${labels[key] || key}</div>`;
      ups.forEach(u => { html += this.upgradeHtml(u); });
    }
    return html;
  },

  newsHtml() {
    let html = '';
    const name = this.selectedCountry;
    if (name) {
      const c = this.game.countries.get(name);
      if (c) {
        const infPct = ((c.infected / c.pop) * 100).toFixed(2);
        const deadPct = ((c.dead / c.pop) * 100).toFixed(2);
        html += `<div class="inspector">
          <h3>${c.name}</h3>
          <div class="sub">${c.climate} climate · wealth ${(c.wealth * 100).toFixed(0)}% · healthcare ${(c.health * 100).toFixed(0)}%</div>
          <div class="insp-row"><span>Population</span><span>${fmtInt(c.pop)}</span></div>
          <div class="insp-row"><span>Infected</span><span>${fmtInt(c.infected)} (${infPct}%)</span></div>
          <div class="insp-row"><span>Dead</span><span>${fmtInt(c.dead)} (${deadPct}%)</span></div>
          <div class="insp-row"><span>Healthy</span><span>${fmtInt(c.healthy)}</span></div>
          <div class="insp-row"><span>Panic</span><span>${Math.round(c.panic * 100)}%</span></div>
          <div class="insp-row"><span>Recovered</span><span>${fmtInt(c.recovered || 0)}</span></div>
          <div class="insp-row"><span>Human resistance</span><span>${Math.round(c.resistance * 100)}%</span></div>
          <div class="insp-row"><span>First detected</span><span>${c.detectedDay === null ? 'not yet' : 'day ' + c.detectedDay}</span></div>
          <div style="margin-top:8px">
            <span class="badge ${c.closedAir ? 'on' : ''}">Air ${c.closedAir ? 'closed' : 'open'}</span>
            <span class="badge ${c.closedSea ? 'on' : ''}">Sea ${c.closedSea ? 'closed' : 'open'}</span>
            <span class="badge ${c.closedLand ? 'on' : ''}">Land ${c.closedLand ? 'closed' : 'open'}</span>
          </div>
        </div>`;
      }
    }
    const v = this.game.vehicles || [];
    if (v.length) {
      const air = v.filter(x => x.type === 'plane').length;
      const sea = v.length - air;
      const infectedFlights = v.filter(x => x.infected).length;
      html += `<div class="inspector">
        <h3>Global traffic</h3>
        <div class="sub">Live movement of aircraft and shipping</div>
        <div class="insp-row"><span>Airborne</span><span>${air} flights</span></div>
        <div class="insp-row"><span>At sea</span><span>${sea} vessels</span></div>
        <div class="insp-row"><span>Carrying pathogen</span><span>${infectedFlights}</span></div>
      </div>`;
    }
    html += `<div class="branch-title">Global feed</div>`;
    if (!this.game.newsLog.length) html += `<div class="news-item">No reports yet. Evolve transmission to get started.</div>`;
    this.game.newsLog.slice(0, 40).forEach(n => {
      html += `<div class="news-item ${n.kind}"><b>Day ${n.day}</b> · ${n.text}</div>`;
    });
    return html;
  },

  bindTabEvents() {
    $$('#tabBody [data-upgrade]').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.upgrade;
        if (this.game.unlock(id)) {
          this.renderTab();
          this.updateHud();
        }
      };
    });
  },

  updateHud() {
    const g = this.game;
    if (!g) return;
    const s = g.stats();
    $('#hudDay').textContent = Math.floor(g.day);
    $('#hudDna').textContent = Math.round(g.dna);
    $('#hudInfected').textContent = fmt(s.infected);
    $('#hudDead').textContent = fmt(s.dead);
    $('#hudHealthy').textContent = fmt(s.healthy);
    $('#hudRecovered').textContent = fmt(s.recovered);
    let rsum = 0, rn = 0;
    for (const c of g.countries.values()) { rsum += c.resistance; rn++; }
    $('#hudResist').textContent = Math.round((rsum / Math.max(1, rn)) * 100) + '%';
    $('#curePct').textContent = Math.round(g.researchProgress) + '%';
    $('#cureBar').style.width = g.researchProgress + '%';
    $('#cureNote').textContent = !g.researchStarted ? 'Not started'
      : g.researchProgress >= 100 ? 'Cure complete'
      : `${s.discovered} countries reporting`;
  },

  loop(ts) {
    requestAnimationFrame(this.loop);
    if (!this.game) return;
    const dt = Math.min((ts - (this.lastFrame || ts)) / 1000, 0.25);
    this.lastFrame = ts;

    if (this.game.running && this.game.speed > 0) {
      this.game.tick(dt);
      this.updateHud();
      if (this.activeTab === 'transmission' || this.activeTab === 'symptoms') {
        this.renderTimer = (this.renderTimer || 0) + dt;
        if (this.renderTimer > 1) { this.renderTimer = 0; this.renderTab(); }
      } else {
        this.renderTimer = (this.renderTimer || 0) + dt;
        if (this.renderTimer > 1.2) { this.renderTimer = 0; this.renderTab(); }
      }
    }
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
