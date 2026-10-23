Open the **Preview** tab and interact with the dashboard:

- Click the **Electronics** filter, then **All**.
- Click **Refresh Prices**.
- Add a product to the cart.

Watch the `Renders: n` badges on each component. Open your browser's
developer tools console (`console.log` output from the app appears there, not
in the **Terminal**) and note the line
`ProductList: Running expensive filtering operation` — it appears on every
render, including when adding to the cart.

Open the components in the **Editor** under `src/components/`. Click **NEXT**
when you have a picture of what re-renders and why.
