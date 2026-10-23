import { useRef } from "react";
import RenderStatus from "./ui/RenderStatus";

export default function ProductCard({ product, onAddToCart }) {
  const renderCount = useRef(0);
  renderCount.current += 1;

  const formattedPrice = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(product.price);

  const handleAddToCart = () => {
    onAddToCart(product.id);
  };

  return (
    <div className="product-card">
      <div className="product-info">
        <h3 className="product-name">{product.name}</h3>
        <p className="product-category">{product.category}</p>

        <div className="product-pricing">
          <span className="price">{formattedPrice}</span>
        </div>
      </div>

      <button className="add-to-cart-button" onClick={handleAddToCart}>
        Add to Cart
      </button>
      <RenderStatus
        componentName={`ProductCard-${product.name}`}
        renderCount={renderCount.current}
      />
    </div>
  );
}
