Leave a note inside the archive explaining what it holds. `echo` prints text;
`>` sends that text into a file instead of the screen:

```bash
echo "Photos archived on day one." > archive/README.txt
cat archive/README.txt
```

The file must contain the word `archived`.

<details>
<summary>Hint</summary>

`>` creates the file (or replaces its contents) with whatever `echo` prints.
`>>` appends to the end of an existing file instead, so if you ran the command
twice with `>>` the file would hold the line twice. Either way the file must
end up containing the word `archived`.

</details>
