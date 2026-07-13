'use strict';
// Corre toda la suite en orden. Uso: npm test
const { execSync } = require('child_process');
const path = require('path');

const tests = ['board.test.js', 'rules.test.js', 'engine.test.js', 'sim.test.js', 'integration.test.js'];
for (const t of tests) {
  console.log(`\n== ${t} ==`);
  execSync(`node "${path.join(__dirname, t)}"`, { stdio: 'inherit' });
}
console.log('\nSuite completa OK');
