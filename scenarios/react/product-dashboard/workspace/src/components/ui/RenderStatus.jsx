export default function RenderStatus({ componentName, renderCount }) {
  return (
    <div className="render-status">
      <code className="render-status-code">&lt;{componentName}&gt;</code>
      <span className="render-status-count">Renders: {renderCount}</span>
    </div>
  );
}
