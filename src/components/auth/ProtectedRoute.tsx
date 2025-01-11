import React, { JSX } from "react";

import { Navigate } from "react-router-dom";
import { useAuth } from "@/Context/AuthContext";

interface ProtectedRouteProps {
  children: JSX.Element;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { session } = useAuth();

  return session ? children : <Navigate to="/" replace />;
};

export default ProtectedRoute;
