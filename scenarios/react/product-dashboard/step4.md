Each `ProductCard` re-renders when any item is added to the cart. Two things
are needed:

1. Wrap `ProductCard` in `memo`.
2. Make the `onAddToCart` callback stable with `useCallback` in `App`
   (and the `refreshPrices` handler while you are there), so the memoized
   card sees the same function reference between renders.

Then click **NEXT** to run the checks. They verify the exact render counts
after a scripted sequence of interactions.

<details>
<summary>Solution</summary>

All three components are wrapped in `memo`, and both handlers in `App` are
wrapped in `useCallback` with an empty dependency list (they only use state
setters, which are stable).

`src/components/CartButton.jsx`

```jsx
const CartButton = memo(function CartButton({ cartItems }) { … });
```

`src/components/ProductList.jsx`

```jsx
const ProductList = memo(function ProductList({ products, filter, onAddToCart }) {
  …
  const filteredProducts = useMemo(() => { … }, [products, filter]);
  …
});
```

`src/components/ProductCard.jsx`

```jsx
const ProductCard = memo(function ProductCard({ product, onAddToCart }) { … });
```

`src/App.jsx`

```jsx
import { useState, useRef, useCallback } from "react";

const handleAddToCart = useCallback((productId) => {
  setCartItems((prev) => [...prev, productId]);
}, []);

const refreshPrices = useCallback(() => {
  setProducts((prev) =>
    prev.map((product) => ({
      ...product,
      price: product.price + (Math.random() - 0.5) * 10,
    }))
  );
}, []);
```

Expected final counts: `ProductList` 8, visible `ProductCard`s 4,
`CartButton` 4, `App` 10.

</details>
