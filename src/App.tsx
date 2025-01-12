import { Route, Routes } from "react-router-dom";

import HomeLandingPage from "./pages/Home/HomeLandingPage";
import NoteViewHomePage from "./pages/Notes/NoteViewHomePage";
import ProtectedRoute from "@/components/auth/ProtectedRoute";
import RedirectRoute from "@/components/auth/RedirectRoute";

function App() {
  return (
    <Routes>
      {/* Public Routes */}
      <Route
        path="/"
        element={
          <RedirectRoute>
            <HomeLandingPage />
          </RedirectRoute>
        }
      />

      {/* Protected Routes */}
      <Route
        path="/notes"
        element={
          <ProtectedRoute>
            <NoteViewHomePage />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

export default App;
