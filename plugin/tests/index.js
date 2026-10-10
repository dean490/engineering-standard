'use strict';
// Loader for `node --test plugin/tests/`.
//
// On Node 24.21.0, a directory argument to --test is loaded as a module path, not
// searched for test files (without this file: MODULE_NOT_FOUND; see
// .recon/brief-01/node-test-dir-behavior.txt), so this file is what that command
// runs. It loads every *.test.cjs file here. The glob form works without it:
// node --test "plugin/tests/*.test.cjs"

const fs = require('fs');
const path = require('path');

for (const name of fs.readdirSync(__dirname).sort()) {
  if (name.endsWith('.test.cjs')) require(path.join(__dirname, name));
}
