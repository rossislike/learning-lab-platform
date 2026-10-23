Time to optimize a React application. The product dashboard works, but it
re-renders far more than it needs to: every click re-runs an expensive filter
and re-renders components whose inputs did not change.

Each component displays its own render count, so you can see the effect of
every change you make. You will fix three problems:

1. `CartButton` re-renders on filter changes even though it only depends on
   the cart.
2. `ProductList` re-runs its filtering logic on every render.
3. Every `ProductCard` re-renders when any item is added to the cart.

> 💡 In real projects, reach for manual memoization (`memo`, `useMemo`,
> `useCallback`) only when there is a measured problem. This exercise is about
> understanding the mechanics.

Click **START** to install dependencies and open the workspace.
