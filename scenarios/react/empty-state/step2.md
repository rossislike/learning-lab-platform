Edit `src/App.jsx` so that an empty task list shows exactly:

```text
No tasks yet. Add your first task to get started.
```

Keep the list rendering for when there are tasks: the message should replace
the list, not sit beside it. The checks only confirm the empty-state message
is shown for the empty list; the `tasks` array stays empty in this scenario.
Save, check the **Preview**, then click **NEXT** to run the checks.

<details>
<summary>Hint</summary>

Conditional rendering in JSX usually looks like one of:

```jsx
{tasks.length === 0 ? <p>…</p> : <ul>…</ul>}
```

```jsx
{tasks.length === 0 && <p>…</p>}
```

</details>
