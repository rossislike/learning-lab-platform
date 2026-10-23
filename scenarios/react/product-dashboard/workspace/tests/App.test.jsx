import { StrictMode } from "react";
import { fireEvent, render, screen, within } from "../test-utils/custom-render.jsx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App.jsx";
import { SAMPLE_PRODUCTS } from "../src/data/products.js";

const FILTER_LOG = "ProductList: Running expensive filtering operation";
const PRICE_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const REFRESHED_PRODUCTS = SAMPLE_PRODUCTS.map((product) => ({
  ...product,
  price: product.price + 5,
}));

function renderApp() {
  return render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

function expectRenderCount(componentName, count) {
  const label = screen.getByText(`<${componentName}>`);
  const status = label.parentElement;
  expect(within(status).getByText(`Renders: ${count}`)).toBeInTheDocument();
}

function getProductCard(productName) {
  return screen.getByRole("heading", { name: productName }).closest(".product-card");
}

function expectProductRenderCount(productName, count) {
  expect(
    within(getProductCard(productName)).getByText(`Renders: ${count}`)
  ).toBeInTheDocument();
}

function expectProductDetails(product) {
  const card = getProductCard(product.name);
  expect(within(card).getByText(product.category)).toBeInTheDocument();
  expect(
    within(card).getByText(PRICE_FORMATTER.format(product.price))
  ).toBeInTheDocument();
}

function clickFilter(name) {
  fireEvent.click(screen.getByRole("button", { name }));
}

function clickRefreshPrices() {
  fireEvent.click(screen.getByRole("button", { name: "Refresh Prices" }));
}

function addProductToCart(productName) {
  fireEvent.click(
    within(getProductCard(productName)).getByRole("button", {
      name: "Add to Cart",
    })
  );
}

function runToRefresh() {
  renderApp();
  clickFilter("Electronics");
  clickFilter("All");
  clickRefreshPrices();
}

function runFullFlow() {
  runToRefresh();
  const logsBeforeCartUpdate = consoleSpy.mock.calls.length;
  addProductToCart("Laptop");
  return { logsBeforeCartUpdate };
}

function expectInitialProductList() {
  expect(screen.getByText("Products (5)")).toBeInTheDocument();
  for (const product of SAMPLE_PRODUCTS) {
    expectProductDetails(product);
  }
}

function expectAllProductCardsRenderCount(count) {
  for (const product of SAMPLE_PRODUCTS) {
    expectProductRenderCount(product.name, count);
  }
}

function expectVisibleProducts(productNames) {
  for (const product of SAMPLE_PRODUCTS) {
    const heading = screen.queryByRole("heading", { name: product.name });
    if (productNames.includes(product.name)) {
      expect(heading).toBeInTheDocument();
    } else {
      expect(heading).not.toBeInTheDocument();
    }
  }
}

let consoleSpy;
let randomSpy;

describe("Product Dashboard checklist", () => {
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    randomSpy.mockRestore();
  });

  it("When the application loads, all components show 'Renders: 2' in their render count displays", () => {
    renderApp();

    expectRenderCount("App", 2);
    expectRenderCount("ProductList", 2);
    expectRenderCount("CartButton", 2);
    expectAllProductCardsRenderCount(2);
  });

  it("Console shows 'ProductList: Running expensive filtering operation'", () => {
    renderApp();

    expect(consoleSpy).toHaveBeenCalledWith(FILTER_LOG);
  });

  it("The product list displays 5 products with their categories and prices: Laptop (Electronics), Book (Books), Phone (Electronics), Headphones (Electronics), Coffee Mug (Home)", () => {
    renderApp();

    expectInitialProductList();
  });

  it("The cart shows 'Cart (0)' initially", () => {
    renderApp();

    expect(screen.getByText("Cart (0)")).toBeInTheDocument();
  });

  it("Clicking the 'Electronics' filter shows only 3 products (Laptop, Phone, Headphones) and increments `ProductList` render count to 'Renders: 4'", () => {
    renderApp();
    clickFilter("Electronics");

    expect(screen.getByText("Products (3)")).toBeInTheDocument();
    expectVisibleProducts(["Laptop", "Phone", "Headphones"]);
    expectRenderCount("ProductList", 4);
  });

  it("Console shows 'ProductList: Running expensive filtering operation'", () => {
    renderApp();
    const logsBeforeFilterChange = consoleSpy.mock.calls.length;

    clickFilter("Electronics");

    expect(consoleSpy.mock.calls.length).toBeGreaterThan(logsBeforeFilterChange);
    expect(consoleSpy.mock.calls.at(-1)?.[0]).toBe(FILTER_LOG);
  });

  it("Clicking back to 'All' filter shows all 5 products and increments `ProductList` render count to 'Renders: 6'", () => {
    renderApp();
    clickFilter("Electronics");
    clickFilter("All");

    expectInitialProductList();
    expectRenderCount("ProductList", 6);
  });

  it("`CartButton` should remain at 'Renders: 2' during filter changes", () => {
    renderApp();
    clickFilter("Electronics");
    clickFilter("All");

    expectRenderCount("CartButton", 2);
  });

  it("Clicking 'Refresh Prices' button changes product prices and increments `ProductList` render count to 'Renders: 8', and all visible `ProductCard` components increment to 'Renders: 4', `CartButton` should remain at 'Renders: 2'", () => {
    runToRefresh();

    for (const product of REFRESHED_PRODUCTS) {
      expectProductDetails(product);
    }
    expectRenderCount("ProductList", 8);
    expectRenderCount("CartButton", 2);
    expectAllProductCardsRenderCount(4);
  });

  it("Adding Laptop to cart updates cart to 'Cart (1)' and increments `CartButton` render count to 'Renders: 4', but `ProductList` should remain at 'Renders: 8' and all `ProductCard` components should remain at 'Renders: 4'", () => {
    runFullFlow();

    expect(screen.getByText("Cart (1)")).toBeInTheDocument();
    expectRenderCount("CartButton", 4);
    expectRenderCount("ProductList", 8);
    expectAllProductCardsRenderCount(4);
  });

  it("Console shows NO 'ProductList: Running expensive filtering operation' logs when adding to cart", () => {
    runToRefresh();
    const logsBeforeCartUpdate = consoleSpy.mock.calls.length;

    addProductToCart("Laptop");

    expect(consoleSpy.mock.calls).toHaveLength(logsBeforeCartUpdate);
  });

  it("Final render counts after all interactions: `ProductList` 'Renders: 8', all visible `ProductCard` components 'Renders: 4', `CartButton` 'Renders: 4', `App` 'Renders: 10'", () => {
    runFullFlow();

    expectRenderCount("App", 10);
    expectRenderCount("ProductList", 8);
    expectRenderCount("CartButton", 4);
    expectAllProductCardsRenderCount(4);
  });
});
