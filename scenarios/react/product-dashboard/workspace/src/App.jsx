import { useState, useRef } from "react";
import ProductList from "./components/ProductList";
import CartButton from "./components/CartButton";
import RenderStatus from "./components/ui/RenderStatus";
import { SAMPLE_PRODUCTS } from "./data/products";

export default function App() {
  const [products, setProducts] = useState(SAMPLE_PRODUCTS);
  const [cartItems, setCartItems] = useState([]);
  const [filter, setFilter] = useState("All");
  const renderCount = useRef(0);
  renderCount.current += 1;

  const handleAddToCart = (productId) => {
    setCartItems((prev) => [...prev, productId]);
  };

  const refreshPrices = () => {
    setProducts((prev) =>
      prev.map((product) => ({
        ...product,
        price: product.price + (Math.random() - 0.5) * 10,
      }))
    );
  };

  return (
    <div className="app-container">
      <div className="app-header">
        <h1 className="app-title">Product Dashboard</h1>
        <RenderStatus componentName="App" renderCount={renderCount.current} />
      </div>
      <div className="dashboard-controls">
        <div className="filter-controls">
          <button
            onClick={() => setFilter("All")}
            className={`filter-button ${filter === "All" ? "active" : ""}`}
          >
            All
          </button>
          <button
            onClick={() => setFilter("Electronics")}
            className={`filter-button ${
              filter === "Electronics" ? "active" : ""
            }`}
          >
            Electronics
          </button>
          <button
            onClick={() => setFilter("Books")}
            className={`filter-button ${filter === "Books" ? "active" : ""}`}
          >
            Books
          </button>
        </div>
        <button onClick={refreshPrices} className="refresh-button">
          Refresh Prices
        </button>
        <CartButton cartItems={cartItems} />
      </div>
      <ProductList
        products={products}
        filter={filter}
        onAddToCart={handleAddToCart}
      />
    </div>
  );
}
