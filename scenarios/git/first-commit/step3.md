A **commit** turns the staged files into a permanent snapshot with a message
describing the change.

```bash
git commit -m "Add first journal entry"
```

Then look at the history:

```bash
git log --oneline
```

You should see one line: a short hash followed by your message.

<details>
<summary>Solution</summary>

```bash
git commit -m "Add first journal entry"
git log --oneline
```

If Git complains that it does not know who you are, run
`git config --global user.name "Your Name"` and
`git config --global user.email "you@example.com"` first.

</details>
