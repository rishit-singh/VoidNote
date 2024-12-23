import './App.css'
import NoteView from './components/NoteView';
import { ThemeProvider } from './components/theme-provider';

function App() {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <div className="flex h-screen bg-background">
        <div className="flex flex-col w-full">
          <header className="h-14 flex items-center px-6 border-b border-border">
            <h1 className="text-2xl font-semibold text-foreground transition-all duration-200 hover:bg-gradient-to-r hover:from-blue-500 hover:to-purple-500 hover:bg-clip-text hover:text-transparent">YapNote</h1>
          </header>
          <main className="flex-1">
            <NoteView />
          </main>
        </div>
      </div>
    </ThemeProvider>
  );
}

export default App; 
