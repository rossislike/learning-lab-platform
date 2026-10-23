A Git repository is just a folder with a hidden `.git` directory inside it.
`git init` creates that directory.

Move into the folder and initialise it:

```bash
cd journal
git init
```

Git prints `Initialized empty Git repository in …`. Nothing else changes — your
file is still there, Git just isn't tracking it yet.

<details>
<summary>Hint</summary>

Run `ls -a` inside `journal/` afterwards. The new `.git` directory is where Git
keeps everything it knows about this project.

</details>
