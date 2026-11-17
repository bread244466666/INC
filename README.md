# Plague.IO

A **Plague Inc. style** strategy game that runs entirely in the browser with plain **HTML, CSS and JavaScript** — no build step, no framework, no backend. It is ready to be served by **Firebase Hosting** as a static site.

You are a pathogen. Evolve, spread across a hand-mapped world of 180 countries, and wipe out humanity before it develops a cure.

![genre](https://img.shields.io/badge/genre-pandemic%20simulation-c0392b) ![stack](https://img.shields.io/badge/stack-HTML%20%C2%B7%20CSS%20%C2%B7%20JS-5fd3c4)

---

## Play locally

The game has zero dependencies. Because everything (including the world map) is bundled as JavaScript, you can either:

**Option A — just open it**

Open `public/index.html` directly in a browser. Double-clicking works.

**Option B — serve it (recommended)**

```bash
cd public &&  python3 -m http.server 8080      # or:  npx http-server public -p 8080
```

Then visit <http://localhost:8080>.

---

## Deploy to Firebase Hosting

The repo already contains `firebase.json` and `.firebaserc`.

1. **Set your project id** in `.firebaserc`:

   ```json
   { "projects": { "default": "my-plague-game" } }
   ```

   …or create it first:

   ```bash
   firebase login
   firebase projects:create my-plague-game     # or pick an existing one
   firebase use my-plague-game
   ```

2. **Deploy:**

   ```bash
   npm i -g firebase-tools      # once
   firebase deploy --only hosting
   ```

   The site is published from the `public/` folder and serves at
   `https://<your-project-id>.web.app` and `https://<your-project-id>.firebaseapp.com`.

3. **Preview / emulate before deploying (optional):**

   ```bash
   firebase emulators:start --only hosting
   ```

`firebase.json` already sets long-cache headers for JS/CSS, no-cache for HTML, clean URLs, and rewrites everything to `index.html`.

---

## How to play

| Step | What to do |
| --- | --- |
| **1. Pick a pathogen** | Bacteria (balanced), Virus (free mutations), Fungus (humid-climate monster), Parasite (extra DNA from deaths). |
| **2. Pick a difficulty** | Casual → Normal → Brutal → Nightmare. Higher difficulty means less DNA and faster researchers. |
| **3. Pick patient zero** | Click any country on the **map picker**, or filter by easy/poor/tropical/island/hard starts. Each pick shows its population, climate, wealth and healthcare, plus an easy→brutal start rating. |
| **4. Evolve** | Spend DNA across three axes: **Spread** (air, water, insects, livestock, rodents, blood, extreme, zoonotic, spores, vertical, contact, climate adaptation), **Symptoms** (4 tiers, from rashes to multi-organ failure), and **Abilities** (genetics, mobility, immune evasion, pharmacology, logistics, information warfare, weaponisation). |
| **5. Beat resistance** | Once noticed, populations build **human resistance** — strongest in rich, healthy countries. It blocks new infections and blunts lethality. Counter it with *Immunosuppression*, *Antigenic Shift*, *Drug Tolerance* and friends. |
| **6. Survive** | Visible, deadly symptoms speed the cure up — **spread first, kill later**. |
| **7. Win** | Kill everyone before cure research reaches 100%. |

### Controls

| Input | Action |
| --- | --- |
| Drag | Pan the map |
| Scroll / double-click | Zoom |
| Click a country | Inspect it (population, infections, panic, closed borders) |
| `Space` | Pause / resume |
| `1` – `4` | Game speed · `0` pause · `5×` fastest |
| `T` / `Y` / `A` / `W` | Spread · Symptoms · Abilities · World feed |

---

## What's in the box

```
public/
├── index.html          # the whole UI shell (menu, HUD, panels, overlays)
├── css/style.css       # dark "outbreak monitor" theme, responsive
└── js/
    ├── world.js        # 180 country outlines (bundled, so file:// works)
    ├── data.js         # countries, borders, flight hubs, 63 upgrades, 10 pathogens
    ├── map.js          # canvas map renderer: pan/zoom, hit-testing, arcs, DNA bubbles
    ├── game.js         # simulation engine (infection, deaths, travel, cure, DNA)
    └── ui.js           # menus, HUD, upgrade tree, country inspector, game loop
firebase.json           # Firebase Hosting config
.firebaserc             # project mapping
```

### Simulation notes

* **Real geography.** Country polygons come from the public-domain
  `world.geo.json` dataset (simplified to 0.1° precision, ~136 KB). Each polygon is drawn to an
  offscreen *hit canvas* painted with a unique colour, so clicking a country is pixel-accurate.
* **A real travel graph.** ~450 land borders plus a reciprocal air/sea network built from
  real aviation hubs. Every island gets a lifeline to its nearest neighbours, so no country is
  mathematically unreachable.
* **Country model.** Population, climate (hot / cold / arid / humid), wealth and healthcare all
  change how fast a country catches, spreads and dies from your pathogen.
* **Panic and lockdowns.** As severity and deaths climb, countries panic and eventually close
  air, sea and land borders.
* **Cure research.** Scales with how much of the world is infected and how visible your symptoms
  are, and collapses as civilization dies — you can genuinely outrun it.
* **DNA economy.** A passive trickle plus clickable bubbles that pop up over infected countries.

### Pathogens (10)

| Pathogen | Identity |
| --- | --- |
| **Bacteria** | Balanced baseline. |
| **Virus** | +15% infectivity, free random upgrade every 45 days, −15% DNA. |
| **Fungus** | ×1.9 in humid countries, +15% DNA, slow elsewhere. |
| **Parasite** | DNA scales with the death toll. |
| **Prion** | 50% stealth — invisible for decades. Resistance cannot slow it. ×1.85 lethality, −45% infectivity, cure research 55% slower. |
| **Nanobot Swarm** | Human immunity is nearly irrelevant (resistance ×0.15). +30% infectivity. |
| **Protozoa** | Ignores healthcare quality when spreading; favours hot + humid. |
| **Helminth** | Water transmission doubled, very low severity, −15% lethality. |
| **Engineered Hybrid** | Rolls one inherited trait from another pathogen at start. |
| **Bio-Weapon** | +60% lethality, +25% severity — but humanity notices instantly. |

### Human resistance

Every country carries a `resistance` value (0–92%) that grows once the outbreak is
discovered:

* **Infected countries** adapt through exposure — rich nations mount a stronger response,
  poor ones adapt through sheer spread.
* **Uninfected countries** build preparedness once cure research begins (vaccination,
  screening, behaviour change).
* Resistance **blocks new infections** (down to 20% of normal rate at max) and blunts
  lethality by up to ~58%.
* It is **visible on the map** — infected countries desaturate toward cold steel-blue as their
  population adapts, and uninfected countries drift blue as they prepare.
* It is **countered** by `resistPierce` abilities (Immunosuppression, Antigenic Shift,
  Multidrug Efflux — up to 95% pierced) and slowed by `resistDrift` evolutions and by
  pathogens with high `drugResist`.

### Difficulty actually matters

Because resistance is wired to `difficulty.resist` and cure research to `cureSpeed`, the four
settings diverge sharply. Measured with two bot players on the same 12 pathogen/country pairs:

| Difficulty | Naive player (ignores resistance) | Smart player |
| --- | --- | --- |
| Casual | 100% | 100% |
| Normal | 100% | 100% |
| Brutal | 50% | 100% |
| Nightmare | 17% | 58% |

Playing the same lone strategy across difficulties (buy only cheap infectivity upgrades):

| Difficulty | Outcome |
| --- | --- |
| Casual | 100% dead, win at day 1002 |
| Normal | cure wins at day 497, only 5% dead |
| Brutal | cure wins at day 535, only 3% dead |
| Nightmare | cure wins at day 459, only 1% dead |

---

## Tips

* Don't buy symptoms early — severity is what makes humanity start researching.
* Air and water transmission matter more than raw infectivity for reaching islands.
* Cold + wealthy countries (Greenland, Canada, Russia, Nordics) need the **cold** bonuses before
  they will accept your plague.
* At the end, once the world is fully infected, pile on lethality. There is no reason to be
  subtle once everyone is a host.
* **Resistance is the real final boss.** Buy immune-evasion abilities before the death toll
  stalls — a population at 80% resistance will barely accept new infections.
* Prion and Bio-Weapon are opposite puzzles: one hides so well the world forgets to research,
  the other is so loud you must outrun the cure.

---

## Licence

MIT. Map geometry from the public-domain `world.geo.json` dataset. This is a fan-made homage
and is not affiliated with Ndemic Creations.
