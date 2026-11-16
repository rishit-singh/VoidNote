import WorkspaceShell from "./components/workspace/WorkspaceShell";
import { HomeView } from "./components/workspace/HomeView";
import { ThemeProvider } from "./components/theme-provider";

function App() {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <WorkspaceShell>
        <HomeView />
      </WorkspaceShell>
    </ThemeProvider>
  );
}

export default App;
