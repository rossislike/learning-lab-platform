import { useRef } from "react";
import RenderStatus from "./ui/RenderStatus";

export default function CartButton({ cartItems }) {
  const renderCount = useRef(0);
  renderCount.current += 1;

  return (
    <div className="cart-button-container">
      <div className="cart-display">Cart ({cartItems.length})</div>
      <RenderStatus
        componentName="CartButton"
        renderCount={renderCount.current}
      />
    </div>
  );
}
