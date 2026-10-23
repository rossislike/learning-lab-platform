A good tool tells you when it was used wrongly. If more than one argument is
given, `greet.js` should:

- print `Usage: node greet.js [name]` to **stderr** (`console.error`), and
- exit with status code `1` (`process.exit(1)`).

Test it:

```bash
node greet.js Ada Lovelace; echo "exit code: $?"
node greet.js Ada; echo "exit code: $?"
```

<details>
<summary>Solution</summary>

```js
const args = process.argv.slice(2);
if (args.length > 1) {
  console.error("Usage: node greet.js [name]");
  process.exit(1);
}
const name = args[0] ?? "world";
console.log(`Hello, ${name}!`);
```

</details>
