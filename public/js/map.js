/* ============================================================
   World map renderer: equirectangular projection, canvas paths,
   pan / zoom, pixel-perfect country hit testing.
   ============================================================ */

const MAP_W = 3600;          // virtual world width in px
const MAP_LON_MIN = -180;
const MAP_LON_MAX = 180;
const MAP_LAT_TOP = 80;      // crop the poles: Antarctica and the high arctic
const MAP_LAT_BOTTOM = -56;  // are not part of the game board
const MAP_H = Math.round(MAP_W * (MAP_LAT_TOP - MAP_LAT_BOTTOM) / (MAP_LON_MAX - MAP_LON_MIN));

function project(lon, lat) {
  return [
    ((lon - MAP_LON_MIN) / (MAP_LON_MAX - MAP_LON_MIN)) * MAP_W,
    ((MAP_LAT_TOP - lat) / (MAP_LAT_TOP - MAP_LAT_BOTTOM)) * MAP_H
  ];
}

class WorldMap {
  constructor(canvas, features) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.features = features;
    this.paths = [];       // {name, path: Path2D, bbox}
    this.byName = new Map();
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.minZoom = 1;
    this.pointerDown = false;
    this.dragged = false;
    this.last = { x: 0, y: 0 };
    this.onCountryClick = null;
    this.onHover = null;
    this.hoveredName = null;
    this.state = null;     // set by game for coloring
    this.arcs = [];
    this.pulses = [];
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.buildPaths();
    this.buildHitCanvas();
    this.bindEvents();
    this.resize();
    this.frame = this.frame.bind(this);
    this.raf = requestAnimationFrame(this.frame);
  }

  buildPaths() {
    this.features.forEach((f, idx) => {
      const path = new Path2D();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      f.p.forEach(poly => {
        poly.forEach(ring => {
          ring.forEach((pt, i) => {
            const [x, y] = project(pt[0], pt[1]);
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
          });
          path.closePath();
        });
      });
      const bbox = { minX, minY, maxX, maxY };
      const entry = { name: f.n, path, bbox, idx };
      this.paths.push(entry);
      this.byName.set(f.n, entry);
    });
  }

  buildHitCanvas() {
    // Offscreen canvas where each country is filled with a unique color.
    this.hit = document.createElement('canvas');
    this.hit.width = MAP_W;
    this.hit.height = MAP_H;
    const hc = this.hit.getContext('2d', { willReadFrequently: true });
    hc.fillStyle = '#000';
    hc.fillRect(0, 0, MAP_W, MAP_H);
    this.paths.forEach((p, i) => {
      const id = i + 1;
      hc.fillStyle = `rgb(${id & 255},${(id >> 8) & 255},0)`;
      hc.fill(p.path);
    });
    this.hitCtx = hc;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.cssW = rect.width || 800;
    this.cssH = rect.height || 450;
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.minZoom = Math.max(this.cssW / MAP_W, this.cssH / MAP_H) * 0.95;
    this.camera.zoom = Math.max(this.camera.zoom, this.minZoom);
    this.clampCamera();
  }

  clampCamera() {
    const c = this.camera;
    const viewW = this.cssW / c.zoom;
    const viewH = this.cssH / c.zoom;
    const maxX = Math.max(0, MAP_W - viewW);
    const maxY = Math.max(0, MAP_H - viewH);
    c.x = Math.min(Math.max(c.x, 0), maxX);
    c.y = Math.min(Math.max(c.y, 0), maxY);
  }

  bindEvents() {
    const el = this.canvas;
    const getPos = e => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    el.addEventListener('pointerdown', e => {
      this.pointerDown = true;
      this.dragged = false;
      this.last = getPos(e);
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', e => {
      const p = getPos(e);
      if (this.pointerDown) {
        const dx = p.x - this.last.x;
        const dy = p.y - this.last.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.dragged = true;
        this.camera.x -= dx / this.camera.zoom;
        this.camera.y -= dy / this.camera.zoom;
        this.clampCamera();
        this.last = p;
      } else {
        const name = this.hitTest(p.x, p.y);
        if (name !== this.hoveredName) {
          this.hoveredName = name;
          el.style.cursor = name ? 'pointer' : 'grab';
          if (this.onHover) this.onHover(name, p);
        } else if (name && this.onHover) {
          this.onHover(name, p);
        }
      }
    });

    const endDrag = e => {
      if (!this.pointerDown) return;
      this.pointerDown = false;
      const p = getPos(e);
      if (!this.dragged) {
        const name = this.hitTest(p.x, p.y);
        if (name && this.onCountryClick) this.onCountryClick(name, p);
      }
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', () => { this.pointerDown = false; });

    el.addEventListener('wheel', e => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const c = this.camera;
      const worldX = c.x + mx / c.zoom;
      const worldY = c.y + my / c.zoom;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      c.zoom = Math.min(Math.max(c.zoom * factor, this.minZoom), 8);
      c.x = worldX - mx / c.zoom;
      c.y = worldY - my / c.zoom;
      this.clampCamera();
    }, { passive: false });

    el.addEventListener('dblclick', e => {
      const p = getPos(e);
      this.zoomToPoint(p.x, p.y, 1.6);
    });

    el.addEventListener('pointerleave', () => {
      this.hoveredName = null;
      if (this.onHover) this.onHover(null);
    });
  }

  zoomToPoint(mx, my, factor) {
    const c = this.camera;
    const worldX = c.x + mx / c.zoom;
    const worldY = c.y + my / c.zoom;
    c.zoom = Math.min(Math.max(c.zoom * factor, this.minZoom), 8);
    c.x = worldX - mx / c.zoom;
    c.y = worldY - my / c.zoom;
    this.clampCamera();
  }

  centerOn(name, zoom = 2.2) {
    const e = this.byName.get(name);
    if (!e) return;
    const cx = (e.bbox.minX + e.bbox.maxX) / 2;
    const cy = (e.bbox.minY + e.bbox.maxY) / 2;
    this.camera.zoom = zoom;
    this.camera.x = cx - this.cssW / (2 * zoom);
    this.camera.y = cy - this.cssH / (2 * zoom);
    this.clampCamera();
  }

  screenToWorld(sx, sy) {
    return { x: this.camera.x + sx / this.camera.zoom, y: this.camera.y + sy / this.camera.zoom };
  }

  hitTest(sx, sy) {
    const w = this.screenToWorld(sx, sy);
    if (w.x < 0 || w.y < 0 || w.x >= MAP_W || w.y >= MAP_H) return null;
    const d = this.hitCtx.getImageData(Math.floor(w.x), Math.floor(w.y), 1, 1).data;
    const id = d[0] | (d[1] << 8);
    if (!id) return null;
    const entry = this.paths[id - 1];
    return entry ? entry.name : null;
  }

  // ---------- drawing ----------
  addArc(fromName, toName) {
    const a = this.byName.get(fromName);
    const b = this.byName.get(toName);
    if (!a || !b) return;
    const ax = (a.bbox.minX + a.bbox.maxX) / 2;
    const ay = (a.bbox.minY + a.bbox.maxY) / 2;
    const bx = (b.bbox.minX + b.bbox.maxX) / 2;
    const by = (b.bbox.minY + b.bbox.maxY) / 2;
    this.arcs.push({ ax, ay, bx, by, t: 0 });
    if (this.arcs.length > 40) this.arcs.shift();
  }

  addPulse(name) {
    const e = this.byName.get(name);
    if (!e) return;
    this.pulses.push({
      x: (e.bbox.minX + e.bbox.maxX) / 2,
      y: (e.bbox.minY + e.bbox.maxY) / 2,
      t: 0
    });
    if (this.pulses.length > 60) this.pulses.shift();
  }

  frame(ts) {
    this.draw(ts || 0);
    this.raf = requestAnimationFrame(this.frame);
  }

  draw(ts) {
    const ctx = this.ctx;
    const c = this.camera;
    const dpr = this.dpr;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // ocean
    const g = ctx.createLinearGradient(0, 0, 0, this.canvas.height);
    g.addColorStop(0, '#08131f');
    g.addColorStop(0.5, '#0a1a2a');
    g.addColorStop(1, '#061019');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(-c.x * c.zoom, -c.y * c.zoom);
    ctx.scale(c.zoom, c.zoom);

    // graticule
    ctx.strokeStyle = 'rgba(90,140,180,0.07)';
    ctx.lineWidth = 1 / c.zoom;
    ctx.beginPath();
    for (let lon = -180; lon <= 180; lon += 30) {
      const [x] = project(lon, 0);
      ctx.moveTo(x, 0); ctx.lineTo(x, MAP_H);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const [, y] = project(0, lat);
      ctx.moveTo(0, y); ctx.lineTo(MAP_W, y);
    }
    ctx.stroke();

    const st = this.state;
    const hovered = this.hoveredName;
    const time = ts / 1000;

    for (const p of this.paths) {
      const info = st ? st.getCountryVisual(p.name) : null;
      ctx.beginPath();
      let fill = '#16232f';
      let stroke = 'rgba(120,170,205,0.35)';
      let lw = 0.8 / c.zoom;

      if (info) {
        fill = info.fill;
        if (info.infected) {
          stroke = info.stroke || 'rgba(255,80,60,0.9)';
          lw = 1.4 / c.zoom;
        }
      }
      if (p.name === hovered) {
        stroke = 'rgba(255,255,255,0.95)';
        lw = 2 / c.zoom;
      }

      ctx.fillStyle = fill;
      ctx.fill(p.path);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.stroke(p.path);
    }

    // transmission arcs
    for (const arc of this.arcs) {
      arc.t += 0.02;
      if (arc.t > 1.4) continue;
      const t = Math.min(arc.t, 1);
      const mx = (arc.ax + arc.bx) / 2;
      const my = (arc.ay + arc.by) / 2;
      const dx = arc.bx - arc.ax, dy = arc.by - arc.ay;
      const dist = Math.hypot(dx, dy) || 1;
      const curve = Math.min(dist * 0.32, 420);
      const cx = mx - (dy / dist) * curve;
      const cy = my + (dx / dist) * curve;
      ctx.beginPath();
      ctx.moveTo(arc.ax, arc.ay);
      ctx.quadraticCurveTo(cx, cy, arc.bx, arc.by);
      ctx.strokeStyle = `rgba(255,120,90,${0.55 * (1 - arc.t / 1.4)})`;
      ctx.lineWidth = 2.2 / c.zoom;
      ctx.setLineDash([8 / c.zoom, 8 / c.zoom]);
      ctx.stroke();
      ctx.setLineDash([]);
      // travel dot
      const u = t;
      const px = (1 - u) * (1 - u) * arc.ax + 2 * (1 - u) * u * cx + u * u * arc.bx;
      const py = (1 - u) * (1 - u) * arc.ay + 2 * (1 - u) * u * cy + u * u * arc.by;
      ctx.beginPath();
      ctx.arc(px, py, 4 / c.zoom, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,200,120,0.95)';
      ctx.fill();
    }
    this.arcs = this.arcs.filter(a => a.t <= 1.4);

    // infection pulses
    for (const pu of this.pulses) {
      pu.t += 0.012;
      if (pu.t > 1) continue;
      ctx.beginPath();
      ctx.arc(pu.x, pu.y, (10 + pu.t * 55), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,70,60,${0.5 * (1 - pu.t)})`;
      ctx.lineWidth = 2.5 / c.zoom;
      ctx.stroke();
    }
    this.pulses = this.pulses.filter(p => p.t <= 1);

    // floating DNA bubbles over infected countries
    if (st && st.bubbles && st.bubbles.length) {
      for (const b of st.bubbles) {
        const e = this.byName.get(b.name);
        if (!e) continue;
        const cx = (e.bbox.minX + e.bbox.maxX) / 2;
        const cy = (e.bbox.minY + e.bbox.maxY) / 2;
        if (cx < c.x - 200 || cx > c.x + this.cssW / c.zoom + 200) continue;
        if (cy < c.y - 200 || cy > c.y + this.cssH / c.zoom + 200) continue;
        const life = Math.min(1, b.t / 0.35) * Math.max(0, 1 - (b.t - 1.6) / 0.9);
        const rise = b.t * 26;
        const r = 11 / c.zoom;
        ctx.globalAlpha = life * 0.9;
        ctx.beginPath();
        ctx.arc(cx, cy - rise, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(10,26,30,0.82)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(95,211,196,0.95)';
        ctx.lineWidth = 1.6 / c.zoom;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy - rise, r * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(95,211,196,0.55)';
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // country labels for infected places when zoomed in
    if (c.zoom > 0.55 && st) {
      ctx.font = `${11 / c.zoom}px "Trebuchet MS", sans-serif`;
      ctx.textAlign = 'center';
      for (const p of this.paths) {
        const info = st.getCountryVisual(p.name);
        if (!info || !info.infected) continue;
        const w = p.bbox.maxX - p.bbox.minX;
        if (w * c.zoom < 46) continue;
        const cx = (p.bbox.minX + p.bbox.maxX) / 2;
        const cy = (p.bbox.minY + p.bbox.maxY) / 2;
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillText(p.name, cx + 1 / c.zoom, cy + 1 / c.zoom);
        ctx.fillStyle = '#ffd9d2';
        ctx.fillText(p.name, cx, cy);
      }
    }

    ctx.restore();
  }

  worldCenterOf(name) {
    const e = this.byName.get(name);
    if (!e) return { x: 0, y: 0 };
    return { x: (e.bbox.minX + e.bbox.maxX) / 2, y: (e.bbox.minY + e.bbox.maxY) / 2 };
  }
}
