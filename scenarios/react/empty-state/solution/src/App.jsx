function App() {
  const tasks = [];

  return (
    <main className="lab-page">
      <p className="eyebrow">React Fundamentals</p>
      <h1>Task List</h1>
      {tasks.length === 0 ? (
        <p>No tasks yet. Add your first task to get started.</p>
      ) : (
        <ul aria-label="Tasks">
          {tasks.map((task) => (
            <li key={task}>{task}</li>
          ))}
        </ul>
      )}
    </main>
  );
}

export default App;
