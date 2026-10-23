`greet.js` now behaves like a real command-line tool: it has a default, reads
its input from `process.argv`, writes errors to stderr, and signals failure
with its exit code.

Next idea: add `#!/usr/bin/env node` as the first line, run
`chmod +x greet.js`, and call it as `./greet.js Ada`.
