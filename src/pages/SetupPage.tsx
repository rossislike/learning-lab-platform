export function SetupPage({ problem }: { problem: string }) {
  return (
    <main className="page">
      <section className="notice">
        <h1>Configuration needed</h1>
        <p>{problem}</p>
        <p>See the README “Local setup” section.</p>
      </section>
    </main>
  );
}
