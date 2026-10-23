import { useRef } from "react";
import ProductCard from "./ProductCard";
import RenderStatus from "./ui/RenderStatus";

export default function ProductList({ products, filter, onAddToCart }) {
  const renderCount = useRef(0);
  renderCount.current += 1;

  console.log("ProductList: Running expensive filtering operation");

  const filteredProducts = products.filter((product) => {
    return filter === "All" || product.category === filter;
  });

  return (
    <div className="product-list-container">
      <div className="product-list-header">
        <h2>Products ({filteredProducts.length})</h2>
        <RenderStatus
          componentName="ProductList"
          renderCount={renderCount.current}
        />
      </div>

      <div className="product-grid">
        {filteredProducts.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            onAddToCart={onAddToCart}
          />
        ))}
      </div>
    </div>
  );
}
