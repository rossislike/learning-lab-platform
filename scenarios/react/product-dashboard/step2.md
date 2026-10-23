`CartButton` receives `cartItems` and nothing else, yet it re-renders whenever
its parent does — including on filter changes.

Wrap the component in `memo` so React skips re-rendering when its props are
unchanged:

```jsx
import { memo } from "react";

const CartButton = memo(function CartButton({ cartItems }) {
  …
});
```

Check the **Preview**: changing the filter should no longer increase the
`CartButton` render count.

<details>
<summary>Hint</summary>

`memo` only helps if the props are referentially stable. `cartItems` is state
in `App`, so it only changes when the cart changes — exactly what we want.

</details>
