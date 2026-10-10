'use strict';
// Command-line option helpers for the eng-standard guard hooks. No dependencies.
//
// git's parse-options accepts any unambiguous prefix of a long option
// (`git commit --no-verif`, `git add --al`; .recon/brief-03/git-option-probes.txt).
// A guard can't know every option of every command, so a token that is a
// prefix of a dangerous long option counts as that option. Where the prefix is
// ambiguous, git refuses the command anyway, so counting it costs nothing.

// True when token ("--name" or "--name=value") is option or an abbreviation of
// it. An abbreviation needs at least one character after "--" (after "--no-"
// for a "--no-" option). Names in exactOnly are complete options of their own
// that happen to be prefixes of a dangerous one, such as git diff's --text
// against --textconv; they match only themselves.
function longMatches(token, option, exactOnly) {
  if (typeof token !== 'string' || !token.startsWith('--')) return false;
  const eq = token.indexOf('=');
  const name = eq < 0 ? token : token.slice(0, eq);
  if (name === option) return true;
  if (exactOnly && exactOnly.has(name)) return false;
  const min = option.startsWith('--no-') ? 6 : 3;
  return name.length >= min && option.startsWith(name);
}

// Walk a command's arguments.
//   spec.shortWithValue:    short options whose value is the rest of the cluster
//                           or, when nothing follows in the cluster, the next word
//   spec.shortAttachedOnly: short options whose value can only be attached
//                           (git commit -S[<keyid>], -u[<mode>])
//   spec.longWithValue:     long options that take the next word when written
//                           without "=" (abbreviations included)
//   spec.exactOnly:         see longMatches
// Returns { flags, positional, has(option) }. has('-x') checks short options;
// has('--name') checks long options, abbreviations included.
function walkOptions(args, spec = {}) {
  const shortWithValue = new Set(spec.shortWithValue || '');
  const shortAttachedOnly = new Set(spec.shortAttachedOnly || '');
  const longWithValue = spec.longWithValue || [];
  const exactOnly = spec.exactOnly || new Set();
  const flags = [];
  const positional = [];
  let k = 0;
  while (k < args.length) {
    const a = args[k];
    if (a === '--') { positional.push(...args.slice(k + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      flags.push({ long: true, raw: a, name: eq < 0 ? a : a.slice(0, eq), value: eq < 0 ? null : a.slice(eq + 1) });
      const takesNext = eq < 0 && longWithValue.some((o) => longMatches(a, o, exactOnly));
      k += takesNext ? 2 : 1;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      let consumedNext = false;
      for (let c = 1; c < a.length; c += 1) {
        const ch = a[c];
        flags.push({ long: false, raw: a, name: `-${ch}`, value: null });
        if (shortAttachedOnly.has(ch)) break;
        if (shortWithValue.has(ch)) {
          if (c === a.length - 1) consumedNext = true;
          break;
        }
      }
      k += consumedNext ? 2 : 1;
      continue;
    }
    positional.push(a);
    k += 1;
  }
  const has = (option) => (option.startsWith('--')
    ? flags.some((f) => f.long && longMatches(f.raw, option, exactOnly))
    : flags.some((f) => !f.long && f.name === option));
  return { flags, positional, has };
}

// True when a short-option cluster such as "-nOcmd" sets option ch before the
// value of an option in valueChars begins.
function clusterHas(word, ch, valueChars = '') {
  if (typeof word !== 'string' || !/^-[^-]/.test(word)) return false;
  const values = new Set(valueChars);
  for (let c = 1; c < word.length; c += 1) {
    if (word[c] === ch) return true;
    if (values.has(word[c])) return false;
  }
  return false;
}

module.exports = { longMatches, walkOptions, clusterHas };
