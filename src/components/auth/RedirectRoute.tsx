import React, { JSX } from "react";

import { Navigate } from "react-router-dom";
import { useAuth } from "@/Context/AuthContext";

interface RedirectRouteProps {
  children: JSX.Element;
}

const RedirectRoute: React.FC<RedirectRouteProps> = ({ children }) => {
  const { session } = useAuth(); // Use AuthContext to check session

  return session ? <Navigate to="/notes" replace /> : children;
};

export default RedirectRoute;
