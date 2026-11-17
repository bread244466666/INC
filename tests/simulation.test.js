const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const source = ['public/js/data.js', 'public/js/game.js'].map(f => fs.readFileSync(f, 'utf8')).join('\n');
vm.runInNewContext(source + `
  const g = new Game();
  const c = g.countries.get('China');
  c.healthy = 1000; c.recovered = 1000; c.infected = 0; c.dead = c.pop - 2000;
  g.addCases(c, 175);
  if (Math.abs(c.infected - 175) > 1e-8 || Math.abs(c.reinfected - 75) > 1e-8) throw Error('reinfection allocation');
  if (Math.abs(c.healthy + c.recovered + c.infected + c.dead - c.pop) > 1e-5) throw Error('population conservation');
  c.healthy = 0; c.recovered = 5; c.infected = 0; c.reinfected = 0; c.dead = c.pop - 5;
  g.infectCountry(c, null);
  if (c.infected !== 5 || c.recovered !== 0 || c.reinfected !== 5) throw Error('reinfection import cap');
  const ids = new Set();
  for (const u of g.allUpgrades()) {
    if (ids.has(u.id)) throw Error('duplicate upgrade ' + u.id);
    ids.add(u.id);
    if (u.requires && !g.findUpgrade(u.requires)) throw Error('missing prerequisite ' + u.id);
  }
  const game = new Game({difficulty:'casual'});
  game.start('China');
  for (let day=0; day<800 && !game.over; day++) {
    game.simulateDay(1);
    for (const country of game.countries.values()) {
      const total = country.healthy + country.recovered + country.infected + country.dead;
      if (!Number.isFinite(total) || Math.abs(total - country.pop) > 0.01 || country.reinfected < -0.01 || country.reinfected > country.infected + 0.01) throw Error('invalid population in ' + country.name);
    }
  }
  if (game.vehicleSeq < 100) throw Error('traffic did not spawn');
  if (!Number.isFinite(game.dna) || !Number.isFinite(game.researchProgress)) throw Error('invalid game state');
`, {console, Math, Set, Map});
console.log('Simulation tests passed');
