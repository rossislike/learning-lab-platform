Git does not record files automatically. You choose what goes into the next
snapshot by **staging** it with `git add`.

Check what Git sees first:

```bash
git status
```

`day1.md` is listed as *untracked*. Stage it:

```bash
git add day1.md
```

Run `git status` again — the file now appears under *Changes to be committed*.

<details>
<summary>Hint</summary>

`git add .` stages everything in the current directory. It is convenient, but
naming the file is a good habit while you are learning what each command does.

</details>
