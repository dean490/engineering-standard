'use strict';
// Loader for `node --test tests/`: tests of the CI check scripts in
// templates/scripts/. Node 24 loads a directory argument to --test as a module
// path (see plugin/tests/index.js), so this file loads every *.test.cjs here.

const fs = require('fs');
const path = require('path');

for (const name of fs.readdirSync(__dirname).sort()) {
  if (name.endsWith('.test.cjs')) require(path.join(__dirname, name));
}
