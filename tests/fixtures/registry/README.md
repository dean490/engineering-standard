# Recorded registry responses

`is-number.json` and `@sindresorhus%2fis.json` are the npm registry's responses for those packages (`https://registry.npmjs.org/<name>`, recorded 2026-10-08), trimmed to the `name` and `time` fields that `templates/scripts/check-release-age.mjs` reads. The tests point the script at this directory with `REGISTRY_DATA` and set the current time with `NOW`.
