Command-line arguments live in `process.argv`. The first two entries are the
`node` binary and the script path, so the first real argument is
`process.argv[2]`.

Change `greet.js` so that:

- `node greet.js Ada` prints `Hello, Ada!`
- `node greet.js` (no argument) still prints `Hello, world!`

<details>
<summary>Hint</summary>

```js
const name = process.argv[2] ?? "world";
```

</details>
