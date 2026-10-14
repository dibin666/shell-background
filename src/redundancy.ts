/**
 * The guard that separates *eliding repetition* from *truncating a document*.
 * A faithful port of caveman's keepNonRedundant (JuliusBrussee/caveman,
 * engine/compressors/redundancy.go).
 *
 * The line shrink (shrink.ts) keeps the head, the tail, and every line that
 * names trouble, and collapses the rest. On a build log that is the right
 * call: the dropped lines are repeated chunk/step noise, each represented by
 * a surviving one. On a 50k-line document where every line is distinct — a
 * bibliography, a generated source file — the same transform would silently
 * delete most of the content. This gate runs before the collapse: a line
 * about to be dropped is KEPT when no surviving line already resembles it, so
 * a distinct document retains a representative of every kind of line and only
 * true repetition is elided. Deterministic (prefix cache), bounded (the work
 * is the same on a 200-line and a 20,000-line payload), pure.
 */

const CONTAINMENT = 0.9; // a dropped line's vocabulary a survivor must carry to represent it
const MAX_CLASSES = 64; // kept lines sampled to seed the represented classes
const MAX_PROMOTIONS = 128; // first-of-kind lines kept before the payload is declared a document
const MAX_UNIT_TOKENS = 128; // vocabulary built per line, so one long line cannot make this quadratic
const MIN_WORD_TOKENS = 1; // letter-bearing tokens a line needs before its digits are masked

interface Profile {
  vocab: Set<string>;
  masked: boolean;
}

/**
 * A line reduced to its word/number tokens, every run of digits optionally
 * collapsed to `#`. Masking lets two log lines that differ only in a timestamp
 * recognise each other; a line with no words keeps its digits, because there
 * the numbers ARE the content (`['1973.', 251]` must not match `['1974.', 260]`).
 */
function tokenize(unit: string, maskDigits: boolean): { vocab: Set<string>; words: number } {
  const vocab = new Set<string>();
  let words = 0;
  let token = "";
  let hasLetter = false;
  let inDigits = false;
  const flush = () => {
    if (token.length > 0 && !vocab.has(token)) {
      vocab.add(token);
      if (hasLetter) words++;
    }
    token = "";
    hasLetter = false;
    inDigits = false;
  };
  for (const ch of unit.toLowerCase()) {
    if (ch >= "0" && ch <= "9") {
      if (maskDigits) {
        if (!inDigits) {
          token += "#";
          inDigits = true;
        }
      } else {
        token += ch;
        inDigits = false;
      }
    } else if (/[a-z_]/.test(ch) || (ch.toLowerCase() !== ch.toUpperCase())) {
      token += ch;
      hasLetter = true;
      inDigits = false;
    } else {
      flush();
    }
    if (vocab.size >= MAX_UNIT_TOKENS) return { vocab, words };
  }
  flush();
  return { vocab, words };
}

function unitVocabulary(unit: string): Profile {
  const masked = tokenize(unit, true);
  if (masked.words >= MIN_WORD_TOKENS) return { vocab: masked.vocab, masked: true };
  return { vocab: tokenize(unit, false).vocab, masked: false };
}

function representedBy(dropped: Profile, classes: Profile[]): boolean {
  if (dropped.vocab.size === 0) return true; // punctuation-only line carries nothing to lose
  const need = Math.ceil(CONTAINMENT * dropped.vocab.size - 1e-9);
  for (const cls of classes) {
    if (cls.masked !== dropped.masked) continue;
    let hit = 0;
    for (const token of dropped.vocab) {
      if (cls.vocab.has(token)) {
        hit++;
        if (hit >= need) return true;
      }
    }
  }
  return false;
}

/**
 * Promote back to kept any not-yet-kept line that no surviving line
 * represents. Mutates `keep` in place, in document order.
 */
export function keepNonRedundant(units: readonly string[], keep: boolean[]): void {
  if (units.length !== keep.length) return;
  const kept: number[] = [];
  for (let i = 0; i < keep.length; i++) if (keep[i]) kept.push(i);

  const classes: Profile[] = [];
  const step = kept.length > MAX_CLASSES ? Math.floor(kept.length / MAX_CLASSES) : 1;
  for (let n = 0; n < kept.length && classes.length < MAX_CLASSES; n += step) {
    classes.push(unitVocabulary(units[kept[n]!]!));
  }

  let promotions = 0;
  for (let i = 0; i < units.length; i++) {
    if (keep[i]) continue;
    if (promotions >= MAX_PROMOTIONS) {
      // More distinct kinds of line than any repetitive stream has: a document.
      // Keep the rest; the caller's "did this actually shrink?" check then
      // passes the original through. Prefer the honest zero.
      keep[i] = true;
      continue;
    }
    const vocab = unitVocabulary(units[i]!);
    if (representedBy(vocab, classes)) continue;
    keep[i] = true;
    promotions++;
    classes.push(vocab);
  }
}
