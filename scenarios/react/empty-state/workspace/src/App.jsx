function App() {
  const tasks = [];

  return (
    <main className="lab-page">
      <p className="eyebrow">React Fundamentals</p>
      <h1>Task List</h1>
      <ul aria-label="Tasks">
        {tasks.map((task) => (
          <li key={task}>{task}</li>
        ))}
      </ul>
    </main>
  );
}

export default App;
