# Correct inclusive range counting

Fix countInRange(values, minimum, maximum) in src/solution.js. Use one Worker owning only src/solution.js. Keep all configuration and public checks unchanged. The fixture has no dependencies. Do not install packages, access a network, or push Git branches.

## Acceptance criteria
- Count values equal to either boundary, including equal lower and upper bounds.
- Preserve duplicate matches and exclude values outside the range.
- Count only finite numbers; ignore strings, NaN, and infinities.
- Return zero for empty input and do not mutate the input array.
