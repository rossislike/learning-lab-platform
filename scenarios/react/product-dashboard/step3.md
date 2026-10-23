`ProductList` filters the products inline, so the expensive operation runs on
every render. Move it into `useMemo` so it only recomputes when `products` or
the active filter change:

```jsx
const filteredProducts = useMemo(
  () => /* expensive filter */,
  [products, filter]
);
```

While you are in `ProductList.jsx`, wrap the component in `memo` too: its
`products`, `filter`, and `onAddToCart` props are what decide whether it needs
to render, and the next step makes the last of those stable.

```jsx
import { useRef, useMemo, memo } from "react";

const ProductList = memo(function ProductList({ products, filter, onAddToCart }) {
  …
});

export default ProductList;
```

In the **Preview**, adding an item to the cart should no longer log
`ProductList: Running expensive filtering operation`.

<details>
<summary>Hint</summary>

Keep the `console.log` inside the memoized function so the log tells you
exactly when the filter actually runs.

</details>
