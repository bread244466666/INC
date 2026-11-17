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

const ICONS = {
  air: '🌬️', water: '💧', insect: '🦟', livestock: '🐄', rodent: '🐀', blood: '🩸', extreme: '☣️',
  symptom: '🧬'
};

const App = {
  game: null,
  map: null,
  world: null,
  selectedPlague: 'bacteria',
  selectedDifficulty: 'normal',
  activeTab: 'transmission',
  selectedCountry: null,
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
    }

    window.addEventListener('resize', () => { if (this.map) this.map.resize(); });
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
  },

  bindMenu() {
    $('#playBtn').onclick = () => this.startGame();
    $('#randomStart').onclick = () => {
      const names = Object.keys(COUNTRIES);
      $('#startCountry').value = names[Math.floor(Math.random() * names.length)];
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
    const country = $('#startCountry').value;
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
      <div class="hc-row"><span>Climate</span><b>${c.climate}</b></div>`;
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

    const icon = up.branch ? (ICONS[up.branch] || '☣️') : ICONS.symptom;
    const right = owned ? '✓' : `${cost} DNA`;
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
    const byTier = { 1: [], 2: [], 3: [] };
    SYMPTOMS.forEach(s => byTier[s.tier].push(s));
    for (const tier of [1, 2, 3]) {
      html += `<div class="branch-title">Tier ${tier}</div>`;
      byTier[tier].forEach(s => { html += this.upgradeHtml(s); });
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
          <div style="margin-top:8px">
            <span class="badge ${c.closedAir ? 'on' : ''}">Air ${c.closedAir ? 'closed' : 'open'}</span>
            <span class="badge ${c.closedSea ? 'on' : ''}">Sea ${c.closedSea ? 'closed' : 'open'}</span>
            <span class="badge ${c.closedLand ? 'on' : ''}">Land ${c.closedLand ? 'closed' : 'open'}</span>
          </div>
        </div>`;
      }
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
