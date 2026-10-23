Move every `.jpg` file into `archive/`. The shell expands `*.jpg` to the list
of matching names before `mv` runs:

```bash
mv *.jpg archive/
```

Afterwards `ls` should show only `notes.txt` and `archive/` here, and
`ls archive` should list the three photos.

<details>
<summary>Hint</summary>

Run `echo *.jpg` to see what the wildcard expands to before you move anything.

</details>
