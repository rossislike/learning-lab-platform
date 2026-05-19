import { useRef, useMemo, memo } from "react";
import ProductCard from "./ProductCard";
import RenderStatus from "./ui/RenderStatus";

const ProductList = memo(function ProductList({
  products,
  filter,
  onAddToCart,
}) {
  const renderCount = useRef(0);
  renderCount.current += 1;

  const filteredProducts = useMemo(() => {
    console.log("ProductList: Running expensive filtering operation");
    return products.filter((product) => {
      return filter === "All" || product.category === filter;
    });
  }, [products, filter]);

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
});

export default ProductList;
